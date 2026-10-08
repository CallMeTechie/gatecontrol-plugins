'use strict';

// Data access of the plugin's own database (migrations/001_init.sql) — port
// of GateControl's skodaAccounts.js / skodaVehicles.js / skodaOwners.js.
// The MySkoda password, the S-PIN and the session tokens of an account are
// secret settings of the plugin (gc.settings.setSecret: encrypted with the
// server key by the host, never sent to the browser).

function codeError(code, message) { return Object.assign(new Error(message || code), { code }); }

const secretKey = (accountId, what) => `acc.${Number(accountId)}.${what}`;

// One transaction at a time (BEGIN … COMMIT over the host's single
// connection to the plugin database); serialised in this process.
let txChain = Promise.resolve();
function tx(gc, fn) {
  const run = async () => {
    await gc.db.exec('BEGIN');
    try {
      const out = await fn();
      await gc.db.exec('COMMIT');
      return out;
    } catch (e) {
      await gc.db.exec('ROLLBACK').catch(() => {});
      throw e;
    }
  };
  const p = txChain.then(run, run);
  txChain = p.catch(() => {});
  return p;
}

function parseJson(s) {
  if (typeof s !== 'string' || !s) return null;
  try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : null; } catch { return null; }
}

/** Same rules as GateControl's validateEmail (linear checks, no regex over the input). */
function validEmail(email) {
  if (typeof email !== 'string') return false;
  const s = email.trim();
  if (!s || s.length > 254) return false;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c < 0x21 || c > 0x7e) return false; }
  const at = s.indexOf('@');
  if (at <= 0 || at !== s.lastIndexOf('@') || at === s.length - 1 || at > 64) return false;
  const local = s.slice(0, at);
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  const domain = s.slice(at + 1);
  if (domain.length > 253 || !domain.includes('.') || domain.includes('..')) return false;
  if (domain.startsWith('.') || domain.startsWith('-') || domain.endsWith('.') || domain.endsWith('-')) return false;
  for (let i = 0; i < domain.length; i++) {
    const c = domain.charCodeAt(i);
    if (!((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x2d || c === 0x2e)) return false;
  }
  return true;
}

// ─── Secrets ────────────────────────────────────

async function secret(gc, accountId, what) {
  const v = await gc.settings.get(secretKey(accountId, what));
  return typeof v === 'string' && v ? v : null;
}

async function setSecret(gc, accountId, what, value) {
  await gc.settings.setSecret(secretKey(accountId, what), value == null || value === '' ? null : String(value));
}

async function getSession(gc, accountId) {
  const accessToken = await secret(gc, accountId, 'access');
  const refreshToken = await secret(gc, accountId, 'refresh');
  return accessToken ? { accessToken, refreshToken } : null;
}

/** Save (or with null drop) the session tokens; a token the host cannot store drops the session. */
async function saveSession(gc, accountId, tokens) {
  try {
    await setSecret(gc, accountId, 'access', tokens ? tokens.accessToken : null);
    await setSecret(gc, accountId, 'refresh', tokens ? tokens.refreshToken : null);
  } catch (e) {
    await setSecret(gc, accountId, 'access', null).catch(() => {});
    await setSecret(gc, accountId, 'refresh', null).catch(() => {});
    throw codeError('SKODA_SESSION_STORE', 'the session could not be stored');
  }
}

const getPassword = (gc, accountId) => secret(gc, accountId, 'password');
const getSpin = (gc, accountId) => secret(gc, accountId, 'spin');

async function dropSecrets(gc, accountId) {
  for (const what of ['password', 'spin', 'access', 'refresh']) await setSecret(gc, accountId, what, null);
}

// ─── Accounts ───────────────────────────────────

function rowToAccount(r, values) {
  const has = (what) => typeof values[secretKey(r.id, what)] === 'string' && values[secretKey(r.id, what)] !== '';
  return {
    id: r.id, email: r.email, status: r.status, status_detail: r.status_detail,
    next_retry_at: r.next_retry_at, updated_at: r.updated_at,
    has_credentials: has('password'), has_spin: has('spin'),
  };
}

/** Accounts without secrets (has_credentials / has_spin only). */
async function listAccounts(gc) {
  const rows = (await gc.db.query('SELECT id, email, status, status_detail, next_retry_at, updated_at FROM accounts ORDER BY id')).rows;
  const values = rows.length ? await gc.settings.all() : {};
  return rows.map((r) => rowToAccount(r, values || {}));
}

/** The account row for the sync (backoff included), or null. */
async function getAccount(gc, id) {
  const r = (await gc.db.get('SELECT * FROM accounts WHERE id = ?', [Number(id)])).row;
  return r ? { id: r.id, email: r.email, status: r.status, backoff_min: Number(r.backoff_min) || 0, next_retry_at: r.next_retry_at } : null;
}

async function createAccount(gc, { email, password }) {
  const trimmed = typeof email === 'string' ? email.trim() : '';
  if (!validEmail(trimmed)) throw codeError('SKODA_VALIDATION', 'valid email required');
  if (!password || typeof password !== 'string' || password.length > 256) throw codeError('SKODA_VALIDATION', 'password required');
  if ((await gc.db.get('SELECT id FROM accounts WHERE email = ?', [trimmed])).row) throw codeError('SKODA_ACCOUNT_EXISTS', 'account already exists');
  const r = await gc.db.run('INSERT INTO accounts (email) VALUES (?)', [trimmed]);
  const id = Number(r.lastInsertRowid);
  try {
    await setSecret(gc, id, 'password', password);
  } catch (e) {
    await gc.db.run('DELETE FROM accounts WHERE id = ?', [id]);
    throw e;
  }
  return (await listAccounts(gc)).find((a) => a.id === id);
}

async function updatePassword(gc, id, password) {
  if (!password || typeof password !== 'string' || password.length > 256) throw codeError('SKODA_VALIDATION', 'password required');
  if (!(await getAccount(gc, id))) throw codeError('SKODA_ACCOUNT_NOT_FOUND', 'account not found');
  await setSecret(gc, id, 'password', password);
  await gc.db.run(`UPDATE accounts SET status = 'ok', status_detail = NULL, backoff_min = 0, next_retry_at = NULL,
    updated_at = datetime('now') WHERE id = ?`, [Number(id)]);
}

async function setStatus(gc, id, status, detail = null, { backoffMin = null, nextRetryAt = null } = {}) {
  if (detail != null) detail = String(detail).slice(0, 300); // keep upstream error blobs out of the UI
  await gc.db.run(`UPDATE accounts SET status = ?, status_detail = ?, backoff_min = COALESCE(?, backoff_min), next_retry_at = ?,
    updated_at = datetime('now') WHERE id = ?`, [status, detail, backoffMin, nextRetryAt, Number(id)]);
}

async function setSpin(gc, id, spin) {
  if (!/^[0-9]{4,10}$/.test(String(spin == null ? '' : spin))) throw codeError('SKODA_VALIDATION', 'spin must be 4-10 digits');
  if (!(await getAccount(gc, id))) throw codeError('SKODA_ACCOUNT_NOT_FOUND', 'account not found');
  await setSecret(gc, id, 'spin', String(spin));
  await gc.db.run("UPDATE accounts SET updated_at = datetime('now') WHERE id = ?", [Number(id)]);
}

async function removeAccount(gc, id) {
  const aid = Number(id);
  await tx(gc, async () => {
    await gc.db.run('DELETE FROM vehicle_owners WHERE vehicle_id IN (SELECT id FROM vehicles WHERE account_id = ?)', [aid]);
    await gc.db.run('DELETE FROM vehicles WHERE account_id = ?', [aid]);
    await gc.db.run('DELETE FROM accounts WHERE id = ?', [aid]);
  });
  await dropSecrets(gc, aid);
}

// ─── Vehicles ───────────────────────────────────

async function upsertVehicle(gc, accountId, garageEntry) {
  const vin = String(garageEntry.vin);
  const name = String(garageEntry.name || garageEntry.title || vin).slice(0, 200);
  const model = (garageEntry.specification && garageEntry.specification.model) ? String(garageEntry.specification.model).slice(0, 200) : null;
  // account_id only on insert: with vehicle sharing the same VIN can appear in
  // two account garages — first assignment wins, no flapping between accounts.
  await gc.db.run(`INSERT INTO vehicles (account_id, vin, name, model) VALUES (?, ?, ?, ?)
    ON CONFLICT(vin) DO UPDATE SET name = excluded.name, model = excluded.model`, [Number(accountId), vin, name, model]);
  return (await gc.db.get('SELECT id, image_url, image_b64 IS NOT NULL AS has_image FROM vehicles WHERE vin = ?', [vin])).row;
}

async function saveState(gc, vehicleId, state) {
  await gc.db.run("UPDATE vehicles SET state_json = ?, fetched_at = datetime('now') WHERE id = ?", [JSON.stringify(state), Number(vehicleId)]);
}

async function saveImage(gc, vehicleId, { bytes, type }, url) {
  await gc.db.run('UPDATE vehicles SET image_b64 = ?, image_type = ?, image_url = ? WHERE id = ?',
    [Buffer.from(bytes).toString('base64'), type, url, Number(vehicleId)]);
}

function rowToVehicle(r) {
  return {
    id: r.id, account_id: r.account_id, vin: r.vin, name: r.name, model: r.model,
    state: parseJson(r.state_json), fetched_at: r.fetched_at, has_image: Boolean(r.has_image),
  };
}

/** Vehicles without the image. */
async function listVehicles(gc) {
  return (await gc.db.query('SELECT id, account_id, vin, name, model, state_json, fetched_at, image_b64 IS NOT NULL AS has_image FROM vehicles ORDER BY id')).rows.map(rowToVehicle);
}

async function getVehicle(gc, id) {
  const r = (await gc.db.get('SELECT id, account_id, vin, name, model, state_json, fetched_at, image_b64 IS NOT NULL AS has_image FROM vehicles WHERE id = ?', [Number(id)])).row;
  return r ? rowToVehicle(r) : null;
}

/** The render as a data: URL (the frame's CSP allows only data: images), or null. */
async function imageOf(gc, id) {
  const r = (await gc.db.get('SELECT image_b64, image_type FROM vehicles WHERE id = ?', [Number(id)])).row;
  if (!r || !r.image_b64 || !/^image\/(png|jpeg|webp)$/.test(r.image_type || '')) return null;
  return `data:${r.image_type};base64,${r.image_b64}`;
}

// ─── Owners ─────────────────────────────────────

/** Validate before writing: vehicle exists, every user exists; then replace the set. */
async function setOwners(gc, vehicleId, userIds) {
  const vid = Number(vehicleId);
  if (!(await gc.db.get('SELECT id FROM vehicles WHERE id = ?', [vid])).row) throw codeError('SKODA_VEHICLE_NOT_FOUND', 'vehicle not found');
  const ids = [...new Set((Array.isArray(userIds) ? userIds : []).map(Number))];
  if (ids.length) {
    const known = new Set((await gc.users.list()).map((u) => u.id));
    for (const uid of ids) if (!Number.isInteger(uid) || !known.has(uid)) throw codeError('SKODA_OWNER_UNKNOWN_USER', `unknown user ${uid}`);
  }
  await tx(gc, async () => {
    await gc.db.run('DELETE FROM vehicle_owners WHERE vehicle_id = ?', [vid]);
    for (const uid of ids) await gc.db.run('INSERT OR IGNORE INTO vehicle_owners (vehicle_id, user_id) VALUES (?, ?)', [vid, uid]);
  });
  return ownerIdsOf(gc, vid);
}

async function ownerIdsOf(gc, vehicleId) {
  return (await gc.db.query('SELECT user_id FROM vehicle_owners WHERE vehicle_id = ? ORDER BY user_id', [Number(vehicleId)])).rows.map((r) => r.user_id);
}

/** { vehicle_id: [user_id, …] } of every vehicle (one query). */
async function allOwners(gc) {
  const out = new Map();
  for (const r of (await gc.db.query('SELECT vehicle_id, user_id FROM vehicle_owners ORDER BY user_id')).rows) {
    if (!out.has(r.vehicle_id)) out.set(r.vehicle_id, []);
    out.get(r.vehicle_id).push(r.user_id);
  }
  return out;
}

async function vehiclesOwnedBy(gc, userId) {
  return (await gc.db.query('SELECT vehicle_id FROM vehicle_owners WHERE user_id = ? ORDER BY vehicle_id', [Number(userId)])).rows.map((r) => r.vehicle_id);
}

async function isOwner(gc, vehicleId, userId) {
  return Boolean((await gc.db.get('SELECT 1 AS x FROM vehicle_owners WHERE vehicle_id = ? AND user_id = ?', [Number(vehicleId), Number(userId)])).row);
}

module.exports = {
  codeError, secretKey, tx, parseJson, validEmail,
  getSession, saveSession, getPassword, getSpin, dropSecrets,
  listAccounts, getAccount, createAccount, updatePassword, setStatus, setSpin, removeAccount,
  upsertVehicle, saveState, saveImage, listVehicles, getVehicle, imageOf,
  setOwners, ownerIdsOf, allOwners, vehiclesOwnedBy, isOwner,
};
