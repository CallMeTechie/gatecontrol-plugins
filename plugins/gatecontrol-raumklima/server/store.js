'use strict';

// Data access of the plugin's own database (migrations/001_init.sql) — port
// of GateControl's mideaDevices.js / mideaOwners.js storage.
//
// The accounts are settings of the plugin (Settings → Plugins → Raumklima →
// Einstellungen, plugin.json ui.settings): Midea app, e-mail and password,
// Dreo e-mail and password — the passwords as `secret` settings (encrypted
// with the server key by the host). The Dreo password is kept as its MD5
// checksum (what the Dreo login wants): a password entered in the settings is
// replaced by it on save. Before 2.0.0 (gatecontrol-midea) the app and e-mail
// lay in the key/value storage; migrateAccounts() moves them once.
// Secrets never go into the database: the cloud sessions and the LAN
// token/key (protocol V3) of a device are secret settings too.

const CLOUD_KEY = 'cloud';
const DREO_KEY = 'dreo';
const SETTING = {
  app: 'cloud.app',
  email: 'cloud.email',
  dreoEmail: 'dreo.email',
};
const SECRET = {
  password: 'cloud.password',
  session: 'cloud.session',
  dreoPassword: 'dreo.password',   // MD5 of the Dreo password (what the Dreo login wants)
  dreoToken: 'dreo.token',
  token: (id) => `dev.${Number(id)}.token`,
  key: (id) => `dev.${Number(id)}.key`,
};
const APPS = new Set(['msmarthome', 'nethome']);
const MD5_RE = /^[0-9a-f]{32}$/;

function codeError(code, message) {
  return Object.assign(new Error(message || code), { code });
}

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

async function secret(gc, key) {
  const v = await gc.settings.get(key);
  return typeof v === 'string' && v ? v : null;
}

async function text(gc, key) {
  const v = await gc.settings.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * The accounts of gatecontrol-midea < 2.0.0 (app and e-mail in the key/value
 * storage) → settings, once. The passwords already are settings under the
 * same keys.
 */
async function migrateAccounts(gc) {
  const cloud = await gc.storage.get(CLOUD_KEY);
  if (cloud && typeof cloud === 'object' && ('email' in cloud || 'app' in cloud)) {
    if (!(await text(gc, SETTING.email)) && typeof cloud.email === 'string' && cloud.email) {
      await gc.settings.set(SETTING.app, APPS.has(cloud.app) ? cloud.app : 'msmarthome');
      await gc.settings.set(SETTING.email, cloud.email);
    }
    await gc.storage.delete(CLOUD_KEY);
  }
  const d = await gc.storage.get(DREO_KEY);
  if (d && typeof d === 'object' && 'email' in d) {
    if (!(await text(gc, SETTING.dreoEmail)) && typeof d.email === 'string' && d.email) await gc.settings.set(SETTING.dreoEmail, d.email);
    await gc.storage.set(DREO_KEY, { region: d.region === 'NA' ? 'NA' : 'EU' });
  }
}

// ─── Midea account ──────────────────────────────

/** { app, email, password, session } — password '' and session null when unset. */
async function loadConfig(gc) {
  let session = null;
  const s = await secret(gc, SECRET.session);
  if (s) { try { session = JSON.parse(s); } catch { session = null; } } // a broken session only means a new login
  const app = await gc.settings.get(SETTING.app);
  return {
    app: APPS.has(app) ? app : 'msmarthome',
    email: await text(gc, SETTING.email),
    password: (await secret(gc, SECRET.password)) || '',
    session: session && typeof session === 'object' ? session : null,
  };
}

async function saveConfig(gc, cfg) {
  await gc.settings.set(SETTING.app, APPS.has(cfg.app) ? cfg.app : 'msmarthome');
  await gc.settings.set(SETTING.email, cfg.email || null);
  await gc.settings.setSecret(SECRET.password, cfg.password || null);
  await saveSession(gc, cfg.session);
}

async function saveSession(gc, session) {
  const json = session ? JSON.stringify(session) : null;
  // a session that does not fit a secret (4000 characters) is not kept: the next request logs in again
  await gc.settings.setSecret(SECRET.session, json && json.length <= 4000 ? json : null);
}

function redactConfig(cfg) {
  return { app: cfg.app, email: cfg.email, password_set: Boolean(cfg.password), session_active: Boolean(cfg.session) };
}

// ─── Dreo account ───────────────────────────────

/** { email, region, passwordMd5, token } — '' / null when unset. */
async function loadDreo(gc) {
  const raw = (await gc.storage.get(DREO_KEY)) || {};
  const pw = (await secret(gc, SECRET.dreoPassword)) || '';
  return {
    email: await text(gc, SETTING.dreoEmail),
    region: raw.region === 'NA' ? 'NA' : 'EU',
    // a password just entered in the settings is plain until settingsChanged replaces it
    passwordMd5: !pw || MD5_RE.test(pw) ? pw : require('./dreo').md5(pw),
    token: await secret(gc, SECRET.dreoToken),
  };
}

/** A plain Dreo password in the settings → its MD5 (the plain password is not kept). */
async function hashDreoPassword(gc) {
  const pw = await secret(gc, SECRET.dreoPassword);
  if (pw && !MD5_RE.test(pw)) await gc.settings.setSecret(SECRET.dreoPassword, require('./dreo').md5(pw));
}

async function saveDreo(gc, cfg) {
  await gc.settings.set(SETTING.dreoEmail, cfg.email || null);
  await gc.storage.set(DREO_KEY, { region: cfg.region === 'NA' ? 'NA' : 'EU' });
  await gc.settings.setSecret(SECRET.dreoPassword, cfg.passwordMd5 || null);
  await saveDreoToken(gc, cfg.token);
}

async function saveDreoToken(gc, token) {
  await gc.settings.setSecret(SECRET.dreoToken, typeof token === 'string' && token && token.length <= 4000 ? token : null);
}

function redactDreo(cfg) {
  return { email: cfg.email, region: cfg.region, configured: Boolean(cfg.email && cfg.passwordMd5) };
}

// ─── Devices ────────────────────────────────────

function rowToDevice(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    device_sn: row.device_sn,
    device_id: row.device_id == null ? null : String(row.device_id),
    vendor: row.vendor === 'dreo' ? 'dreo' : 'midea',
    kind: row.kind === 'heater' ? 'heater' : 'ac',
    transport: row.transport === 'cloud' ? 'cloud' : 'lan',
    cloud_appliance_id: row.cloud_appliance_id == null ? null : String(row.cloud_appliance_id),
    target_index: row.target_index == null ? null : Number(row.target_index),
    protocol_version: Number(row.protocol_version) || 3,
    model: row.model || null,
    enabled: row.enabled === 1,
    last_seen_at: row.last_seen_at || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

async function listDevices(gc) {
  return (await gc.db.query('SELECT * FROM devices ORDER BY id')).rows.map(rowToDevice);
}

async function getDevice(gc, id) {
  return rowToDevice((await gc.db.get('SELECT * FROM devices WHERE id = ?', [Number(id)])).row);
}

/** token/key of a LAN V3 device (hex), null when none. */
async function credentialsOf(gc, id) {
  const token = await secret(gc, SECRET.token(id));
  const key = await secret(gc, SECRET.key(id));
  return token && key ? { token, key } : null;
}

async function setCredentials(gc, id, creds) {
  await gc.settings.setSecret(SECRET.token(id), creds && creds.token ? creds.token : null);
  await gc.settings.setSecret(SECRET.key(id), creds && creds.key ? creds.key : null);
}

async function createDevice(gc, data) {
  const r = await gc.db.run(`INSERT INTO devices
      (name, device_sn, device_id, transport, cloud_appliance_id, target_index, protocol_version, model, enabled, vendor, kind)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    data.name,
    data.device_sn,
    data.device_id ?? null,
    data.transport === 'cloud' ? 'cloud' : 'lan',
    data.cloud_appliance_id ?? null,
    data.target_index ?? null,
    data.protocol_version ?? 3,
    data.model ?? null,
    data.enabled === false ? 0 : 1,
    data.vendor === 'dreo' ? 'dreo' : 'midea',
    data.kind === 'heater' ? 'heater' : 'ac',
  ]);
  const id = Number(r.lastInsertRowid);
  if (data.token && data.key) await setCredentials(gc, id, { token: data.token, key: data.key });
  return getDevice(gc, id);
}

const FIELDS = { name: 'name', target_index: 'target_index', model: 'model', device_id: 'device_id', last_seen_at: 'last_seen_at' };

async function updateDevice(gc, id, patch) {
  const sets = [];
  const vals = [];
  for (const [k, col] of Object.entries(FIELDS)) {
    if (k in patch) { sets.push(`${col} = ?`); vals.push(patch[k]); }
  }
  if ('enabled' in patch) { sets.push('enabled = ?'); vals.push(patch.enabled ? 1 : 0); }
  if (sets.length) {
    sets.push("updated_at = datetime('now')");
    await gc.db.run(`UPDATE devices SET ${sets.join(', ')} WHERE id = ?`, [...vals, Number(id)]);
  }
  return getDevice(gc, id);
}

async function removeDevice(gc, id) {
  const did = Number(id);
  await tx(gc, async () => {
    await gc.db.run('DELETE FROM device_owners WHERE device_id = ?', [did]); // child first
    await gc.db.run('DELETE FROM devices WHERE id = ?', [did]);
  });
  await setCredentials(gc, did, null);
  return { ok: true };
}

// ─── Owners (port of mideaOwners.js) ────────────

async function ownerIdsOf(gc, deviceId) {
  return (await gc.db.query('SELECT user_id FROM device_owners WHERE device_id = ? ORDER BY user_id', [Number(deviceId)])).rows.map((r) => r.user_id);
}

/** { device_id: [user_id, …] } of every device (one query). */
async function allOwners(gc) {
  const out = new Map();
  for (const r of (await gc.db.query('SELECT device_id, user_id FROM device_owners ORDER BY user_id')).rows) {
    if (!out.has(r.device_id)) out.set(r.device_id, []);
    out.get(r.device_id).push(r.user_id);
  }
  return out;
}

/**
 * Validate before writing: the device exists and every user id is a known
 * user; on a single unknown id nothing is written. Then replace the set.
 */
async function setOwners(gc, deviceId, userIds) {
  const d = (await gc.db.get('SELECT id FROM devices WHERE id = ?', [Number(deviceId)])).row;
  if (!d) throw codeError('MIDEA_DEVICE_NOT_FOUND', `device ${deviceId} not found`);
  // Tolerate a non-array; coerce to positive integers (Number(null)→0 excluded).
  const ids = [...new Set((Array.isArray(userIds) ? userIds : []).map(Number))].filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length) {
    const known = new Set((await gc.users.list()).map((u) => u.id));
    for (const uid of ids) if (!known.has(uid)) throw codeError('MIDEA_OWNER_UNKNOWN_USER', `unknown user ${uid}`);
  }
  await tx(gc, async () => {
    await gc.db.run('DELETE FROM device_owners WHERE device_id = ?', [d.id]);
    for (const uid of ids) await gc.db.run('INSERT OR IGNORE INTO device_owners (device_id, user_id) VALUES (?, ?)', [d.id, uid]);
  });
  return ownerIdsOf(gc, d.id);
}

async function devicesOwnedBy(gc, userId) {
  return (await gc.db.query('SELECT device_id FROM device_owners WHERE user_id = ? ORDER BY device_id', [Number(userId)])).rows.map((r) => r.device_id);
}

async function isOwner(gc, deviceId, userId) {
  return !!(await gc.db.get('SELECT 1 AS x FROM device_owners WHERE device_id = ? AND user_id = ?', [Number(deviceId), Number(userId)])).row;
}

module.exports = {
  APPS, SETTING, SECRET, codeError, tx, migrateAccounts,
  loadConfig, saveConfig, saveSession, redactConfig,
  loadDreo, hashDreoPassword, saveDreo, saveDreoToken, redactDreo,
  listDevices, getDevice, credentialsOf, setCredentials, createDevice, updateDevice, removeDevice,
  ownerIdsOf, allOwners, setOwners, devicesOwnedBy, isOwner,
};
