'use strict';

// Import of GateControl's built-in Fahrzeuge data (host: src/services/plugins/
// legacy.js). The host hands over one snapshot of its skoda_* tables —
// accounts (with the decrypted MySkoda password, S-PIN and session tokens),
// vehicles (state, render image as base64) and owners — and the plugin
// replaces its own data with it. Ids are kept, so owners stay valid.
// Idempotent: running it again replaces the plugin data with the snapshot
// again. Secrets become secret settings and are never logged.

const store = require('./store');
const { imageType } = require('./client');
const { MAX_IMAGE_BYTES } = require('./service');

const SNAPSHOT_SCHEMA = 1;
const CHUNK = 50;
const STATUSES = new Set(['ok', 'login_failed', 'rate_limited', 'error']);

const int = (v) => (Number.isInteger(v) && v > 0 ? v : null);
const str = (v, max = 500) => (typeof v === 'string' ? v.slice(0, max) : (v == null ? null : String(v).slice(0, max)));
const ts = (v) => (typeof v === 'string' && v.length <= 40 ? v : null);
const secretStr = (v, max) => (typeof v === 'string' && v && v.length <= max ? v : null);

function invalid(msg) { return Object.assign(new Error(msg), { code: 'SKODA_IMPORT_INVALID' }); }

function image(v) {
  if (typeof v !== 'string' || !v || v.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(v)) return null;
  const bytes = Buffer.from(v, 'base64');
  const type = imageType(bytes);
  return type ? { b64: bytes.toString('base64'), type } : null;
}

/** Validate and normalise the host's snapshot (schema 1, dataset skoda). */
function normalise(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || snapshot.schema !== SNAPSHOT_SCHEMA || snapshot.dataset !== 'skoda') throw invalid('not a skoda snapshot');
  const list = (k) => (Array.isArray(snapshot[k]) ? snapshot[k] : []);
  const seenEmail = new Set();
  const accounts = [];
  for (const a of list('accounts')) {
    if (!a || !int(a.id) || !store.validEmail(a.email)) continue;
    const email = a.email.trim();
    if (seenEmail.has(email)) continue; // UNIQUE(email), like the built-in table
    seenEmail.add(email);
    const session = a.session && typeof a.session === 'object' ? a.session : null;
    accounts.push({
      id: a.id, email, status: STATUSES.has(a.status) ? a.status : 'ok', status_detail: str(a.status_detail, 300),
      backoff_min: Number.isInteger(a.backoff_min) && a.backoff_min >= 0 && a.backoff_min <= 10000 ? a.backoff_min : 0,
      next_retry_at: ts(a.next_retry_at), created_at: ts(a.created_at), updated_at: ts(a.updated_at),
      password: secretStr(a.password, 256),
      spin: typeof a.spin === 'string' && /^[0-9]{4,10}$/.test(a.spin) ? a.spin : null,
      access: session ? secretStr(session.accessToken, 4000) : null,
      refresh: session ? secretStr(session.refreshToken, 4000) : null,
    });
  }
  const accIds = new Set(accounts.map((a) => a.id));
  const seenVin = new Set();
  const vehicles = [];
  for (const v of list('vehicles')) {
    if (!v || !int(v.id) || !accIds.has(v.account_id) || typeof v.vin !== 'string' || !/^[A-Za-z0-9]{1,32}$/.test(v.vin) || seenVin.has(v.vin)) continue;
    seenVin.add(v.vin);
    const img = image(v.image);
    vehicles.push({
      id: v.id, account_id: v.account_id, vin: v.vin, name: str(v.name, 200), model: str(v.model, 200),
      state_json: v.state && typeof v.state === 'object' && !Array.isArray(v.state) ? JSON.stringify(v.state) : null,
      image_b64: img ? img.b64 : null, image_type: img ? img.type : null, image_url: img ? str(v.image_url, 2000) : null,
      fetched_at: ts(v.fetched_at), created_at: ts(v.created_at),
    });
  }
  const vehIds = new Set(vehicles.map((v) => v.id));
  const seenOwner = new Set();
  const owners = list('owners').filter((o) => {
    if (!o || !vehIds.has(o.vehicle_id) || !int(o.user_id)) return false;
    const k = o.vehicle_id + ':' + o.user_id;
    if (seenOwner.has(k)) return false;
    seenOwner.add(k);
    return true;
  }).map((o) => ({ vehicle_id: o.vehicle_id, user_id: o.user_id, created_at: ts(o.created_at) }));
  return { accounts, vehicles, owners };
}

/** INSERT … SELECT FROM json_each(?) in chunks: one statement per chunk. */
async function insertJson(gc, table, cols, rows) {
  const now = new Set(['created_at', 'updated_at']);
  const sel = cols.map((c) => (now.has(c) ? `COALESCE(json_extract(value, '$.${c}'), datetime('now'))` : `json_extract(value, '$.${c}')`)).join(', ');
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK).map((r) => Object.fromEntries(cols.map((c) => [c, r[c] === undefined ? null : r[c]])));
    await gc.db.run(`INSERT INTO ${table} (${cols.join(', ')}) SELECT ${sel} FROM json_each(?)`, [JSON.stringify(chunk)]);
  }
}

/**
 * legacyImport hook.
 * @returns {Promise<{ok:true, counts:object}>}
 */
async function importSnapshot(snapshot, gc) {
  const data = normalise(snapshot);
  const before = (await gc.db.query('SELECT id FROM accounts')).rows.map((r) => r.id);
  await store.tx(gc, async () => {
    for (const t of ['vehicle_owners', 'vehicles', 'accounts']) await gc.db.run(`DELETE FROM ${t}`);
    await insertJson(gc, 'accounts', ['id', 'email', 'status', 'status_detail', 'backoff_min', 'next_retry_at', 'created_at', 'updated_at'], data.accounts);
    // one vehicle per statement: a render image may come close to the size of a whole chunk
    for (const v of data.vehicles) {
      await insertJson(gc, 'vehicles', ['id', 'account_id', 'vin', 'name', 'model', 'state_json', 'image_b64', 'image_type', 'image_url', 'fetched_at', 'created_at'], [v]);
    }
    await insertJson(gc, 'vehicle_owners', ['vehicle_id', 'user_id', 'created_at'], data.owners);
  });
  // Secrets: secret settings; those of accounts that no longer exist are removed.
  const keep = new Set(data.accounts.map((a) => a.id));
  for (const id of before) if (!keep.has(id)) await store.dropSecrets(gc, id);
  let sessionsDropped = 0;
  for (const a of data.accounts) {
    await store.dropSecrets(gc, a.id);
    if (a.password) await gc.settings.setSecret(store.secretKey(a.id, 'password'), a.password);
    if (a.spin) await gc.settings.setSecret(store.secretKey(a.id, 'spin'), a.spin);
    if (a.access && a.refresh) {
      try { await store.saveSession(gc, a.id, { accessToken: a.access, refreshToken: a.refresh }); } catch { sessionsDropped++; }
    }
  }
  const counts = { accounts: data.accounts.length, vehicles: data.vehicles.length, owners: data.owners.length };
  gc.log.info('built-in Fahrzeuge data imported', JSON.stringify(counts) + (sessionsDropped ? ` (${sessionsDropped} session(s) not kept, new login on the next sync)` : ''));
  return { ok: true, counts };
}

module.exports = { importSnapshot, normalise };
