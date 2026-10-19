'use strict';

// Import of GateControl's built-in Klimaanlage data (host:
// src/services/plugins/legacy.js, dataset "midea"). The host hands over one
// snapshot — the Midea cloud account (password and session decrypted), the
// devices of midea_devices (LAN token/key of protocol V3 decrypted, the home-
// target index the host assigned for a LAN device's address) and
// midea_device_owners — and the plugin replaces its own data with it. Ids are
// kept, so owners stay valid. Idempotent: running it again replaces the
// plugin data with the snapshot again.

const store = require('./store');

const SNAPSHOT_SCHEMA = 1;
const CHUNK = 200;
const HEX = /^[0-9a-f]{1,256}$/i;

const int = (v) => (Number.isInteger(v) && v > 0 ? v : null);
const str = (v, max = 500) => (typeof v === 'string' ? v.slice(0, max) : (v == null ? null : String(v).slice(0, max)));
const ts = (v) => (typeof v === 'string' && v.length <= 40 ? v : null);
const hex = (v) => (typeof v === 'string' && HEX.test(v) ? v : null);

function invalid(msg) { return Object.assign(new Error(msg), { code: 'MIDEA_IMPORT_INVALID' }); }

/** Validate and normalise the host's snapshot (schema 1, dataset midea). */
function normalise(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || snapshot.schema !== SNAPSHOT_SCHEMA || snapshot.dataset !== 'midea') throw invalid('not a midea snapshot');
  const list = (k) => (Array.isArray(snapshot[k]) ? snapshot[k] : []);
  const acc = list('cloud').find((c) => c && typeof c.email === 'string' && c.email) || null;
  const cloud = acc ? {
    app: store.APPS.has(acc.app) ? acc.app : 'msmarthome',
    email: acc.email.slice(0, 200),
    password: typeof acc.password === 'string' ? acc.password : '',
    session: acc.session && typeof acc.session === 'object' && !Array.isArray(acc.session) ? acc.session : null,
  } : null;
  const seen = new Set();
  const devices = list('devices').filter((d) => d && int(d.id) && typeof d.device_sn === 'string' && d.device_sn).filter((d) => {
    if (seen.has(d.device_sn)) return false; // device_sn is unique
    seen.add(d.device_sn);
    return true;
  }).map((d) => {
    const isCloud = d.transport === 'cloud';
    const pv = Number(d.protocol_version) === 2 ? 2 : 3;
    const token = isCloud ? null : hex(d.token);
    const key = isCloud ? null : hex(d.key);
    return {
      id: d.id, name: str(d.name, 200) || `Midea ${d.id}`, device_sn: str(d.device_sn, 200),
      device_id: str(d.device_id, 40), transport: isCloud ? 'cloud' : 'lan', cloud_appliance_id: str(d.cloud_appliance_id, 40),
      target_index: !isCloud && d.target && Number.isInteger(d.target.index) && d.target.index >= 0 ? d.target.index : null,
      protocol_version: pv, model: str(d.model, 100), enabled: d.enabled === false ? 0 : 1,
      token: token && key ? token : null, key: token && key ? key : null,
      last_seen_at: ts(d.last_seen_at), created_at: ts(d.created_at), updated_at: ts(d.updated_at),
    };
  });
  const ids = new Set(devices.map((d) => d.id));
  const owners = list('owners').filter((o) => o && ids.has(o.device_id) && int(o.user_id))
    .map((o) => ({ device_id: o.device_id, user_id: o.user_id, created_at: ts(o.created_at) }));
  return { cloud, devices, owners };
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
  const before = await store.listDevices(gc);
  await store.tx(gc, async () => {
    for (const t of ['device_owners', 'devices']) await gc.db.run(`DELETE FROM ${t}`);
    await insertJson(gc, 'devices', ['id', 'name', 'device_sn', 'device_id', 'transport', 'cloud_appliance_id', 'target_index', 'protocol_version', 'model', 'enabled',
      'last_seen_at', 'created_at', 'updated_at'], data.devices);
    await insertJson(gc, 'device_owners', ['device_id', 'user_id', 'created_at'], data.owners);
  });
  // LAN keys: secret settings; keys of devices that no longer exist are removed
  const keep = new Set(data.devices.map((d) => d.id));
  for (const d of before) if (!keep.has(d.id)) await store.setCredentials(gc, d.id, null);
  for (const d of data.devices) await store.setCredentials(gc, d.id, d.token ? { token: d.token, key: d.key } : null);
  // the cloud account replaces the plugin's own (none in the snapshot → none here)
  await store.saveConfig(gc, data.cloud || { app: 'msmarthome', email: '', password: '', session: null });
  const counts = { cloud: data.cloud ? 1 : 0, devices: data.devices.length, owners: data.owners.length };
  gc.log.info('built-in Klimaanlage data imported', JSON.stringify(counts));
  return { ok: true, counts };
}

module.exports = { importSnapshot, normalise };
