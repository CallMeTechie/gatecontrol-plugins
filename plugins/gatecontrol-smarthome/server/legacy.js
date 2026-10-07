'use strict';

// Import of GateControl's built-in Smart Home data (host: src/services/plugins/
// legacy.js). The host hands over one snapshot of its smarthome_* tables —
// gateways (with the decrypted deCONZ API key and the home-target index the
// host assigned for the gateway's former route), resources, owners, rules —
// and the plugin replaces its own data with it. Ids are kept, so owners,
// rule definitions (resourceId) and the "GC:<rule id>:" labels of the deCONZ
// objects on the gateway stay valid. Idempotent: running it again replaces
// the plugin data with the snapshot again.

const store = require('./store');

const SNAPSHOT_SCHEMA = 1;
const CHUNK = 200;

const int = (v) => (Number.isInteger(v) && v > 0 ? v : null);
const str = (v, max = 500) => (typeof v === 'string' ? v.slice(0, max) : (v == null ? null : String(v).slice(0, max)));
const ts = (v) => (typeof v === 'string' && v.length <= 40 ? v : null);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

function invalid(msg) { return Object.assign(new Error(msg), { code: 'SMARTHOME_IMPORT_INVALID' }); }

/** Validate and normalise the host's snapshot (schema 1, dataset smarthome). */
function normalise(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || snapshot.schema !== SNAPSHOT_SCHEMA || snapshot.dataset !== 'smarthome') throw invalid('not a smarthome snapshot');
  const list = (k) => (Array.isArray(snapshot[k]) ? snapshot[k] : []);
  const gateways = list('gateways').filter((g) => g && int(g.id)).map((g) => ({
    id: g.id, name: str(g.name, 200) || `Gateway ${g.id}`, enabled: g.enabled === false ? 0 : 1,
    target_index: g.target && Number.isInteger(g.target.index) && g.target.index >= 0 ? g.target.index : null,
    api_key: typeof g.api_key === 'string' && g.api_key ? g.api_key : null,
    last_seen_at: ts(g.last_seen_at), created_at: ts(g.created_at), updated_at: ts(g.updated_at),
  }));
  const gwIds = new Set(gateways.map((g) => g.id));
  const resources = list('resources').filter((r) => r && int(r.id) && gwIds.has(r.gateway_id) && r.deconz_id != null && typeof r.deconz_type === 'string' && typeof r.kind === 'string').map((r) => ({
    id: r.id, gateway_id: r.gateway_id, deconz_id: str(r.deconz_id, 100), deconz_type: str(r.deconz_type, 20), uniqueid: str(r.uniqueid, 100),
    kind: str(r.kind, 20), name: str(r.name, 200), capabilities_json: JSON.stringify(obj(r.capabilities)), state_json: JSON.stringify(obj(r.state)),
    enabled: r.enabled === false ? 0 : 1, created_at: ts(r.created_at), updated_at: ts(r.updated_at),
  }));
  const resIds = new Set(resources.map((r) => r.id));
  const owners = list('owners').filter((o) => o && resIds.has(o.resource_id) && int(o.user_id))
    .map((o) => ({ resource_id: o.resource_id, user_id: o.user_id, created_at: ts(o.created_at) }));
  const rules = list('rules').filter((r) => r && int(r.id) && gwIds.has(r.gateway_id)).map((r) => ({
    id: r.id, gateway_id: r.gateway_id, name: str(r.name, 100) || `Regel ${r.id}`, enabled: r.enabled === false ? 0 : 1,
    definition_json: JSON.stringify(obj(r.definition)),
    deconz_rule_id: str(r.deconz_rule_id, 40), deconz_schedule_id: str(r.deconz_schedule_id, 40), deconz_clip_sensor_id: str(r.deconz_clip_sensor_id, 40),
    created_at: ts(r.created_at), updated_at: ts(r.updated_at),
  }));
  return { gateways, resources, owners, rules };
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
  const before = await store.listGateways(gc);
  await store.tx(gc, async () => {
    for (const t of ['resource_owners', 'rules', 'resources', 'gateways']) await gc.db.run(`DELETE FROM ${t}`);
    await insertJson(gc, 'gateways', ['id', 'name', 'target_index', 'enabled', 'last_seen_at', 'created_at', 'updated_at'], data.gateways);
    await insertJson(gc, 'resources', ['id', 'gateway_id', 'deconz_id', 'deconz_type', 'uniqueid', 'kind', 'name', 'capabilities_json', 'state_json', 'enabled', 'created_at', 'updated_at'], data.resources);
    await insertJson(gc, 'resource_owners', ['resource_id', 'user_id', 'created_at'], data.owners);
    await insertJson(gc, 'rules', ['id', 'gateway_id', 'name', 'enabled', 'definition_json', 'deconz_rule_id', 'deconz_schedule_id', 'deconz_clip_sensor_id', 'created_at', 'updated_at'], data.rules);
  });
  // API keys: secret settings; keys of gateways that no longer exist are removed
  const keep = new Set(data.gateways.map((g) => g.id));
  for (const g of before) if (!keep.has(g.id)) await store.setApiKey(gc, g.id, null);
  for (const g of data.gateways) await store.setApiKey(gc, g.id, g.api_key);
  const counts = { gateways: data.gateways.length, resources: data.resources.length, owners: data.owners.length, rules: data.rules.length };
  gc.log.info('built-in Smart Home data imported', JSON.stringify(counts));
  return { ok: true, counts };
}

module.exports = { importSnapshot, normalise };
