'use strict';

// Shelly and Tasmota devices behind a GateControl gateway (migrations/002_edge.sql): the edge_devices rows and
// their channels as resources (gateway_id 0, deconz_type 'edge', deconz_id '<device id>/<channel>').

const store = require('./store');

const EDGE_TYPE = 'edge';
const FAMILIES = new Set(['shelly1', 'shelly2', 'tasmota']);

function rowToDevice(row) {
  if (!row) return null;
  const { config_json: cfg, state_json: st, ...rest } = row;
  return {
    ...rest,
    gateway_id: Number(rest.gateway_id),
    online: rest.online == null ? null : Number(rest.online) === 1,
    configured: Number(rest.configured) === 1,
    config: store.parseJson(cfg),
    state: store.parseJson(st),
  };
}

async function listDevices(gc, gatewayId) {
  const rows = gatewayId == null
    ? (await gc.db.query('SELECT * FROM edge_devices ORDER BY gateway_id, name')).rows
    : (await gc.db.query('SELECT * FROM edge_devices WHERE gateway_id = ? ORDER BY name', [Number(gatewayId)])).rows;
  return rows.map(rowToDevice);
}

async function getDevice(gc, id) {
  return rowToDevice((await gc.db.get('SELECT * FROM edge_devices WHERE id = ?', [Number(id)])).row);
}

async function getByBase(gc, gatewayId, base) {
  return rowToDevice((await gc.db.get('SELECT * FROM edge_devices WHERE gateway_id = ? AND base = ?', [Number(gatewayId), String(base)])).row);
}

async function createDevice(gc, d) {
  const r = await gc.db.run(`INSERT INTO edge_devices (gateway_id, base, prefix, family, name, area, model, firmware, ip, mac, mqtt_user, config_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [Number(d.gateway_id), d.base, d.prefix, d.family, d.name, d.area || null, d.model || null, d.firmware || null, d.ip || null, d.mac || null, d.mqtt_user || null, JSON.stringify(d.config || {})]);
  return getDevice(gc, r.lastInsertRowid);
}

const COLUMNS = ['base', 'prefix', 'family', 'name', 'area', 'model', 'firmware', 'ip', 'mac', 'mqtt_user', 'last_seen_at'];

async function updateDevice(gc, id, patch) {
  const sets = [];
  const vals = [];
  for (const k of COLUMNS) if (k in patch) { sets.push(`${k} = ?`); vals.push(patch[k] == null ? null : patch[k]); }
  if ('config' in patch) { sets.push('config_json = ?'); vals.push(JSON.stringify(patch.config || {})); }
  if ('state' in patch) { sets.push('state_json = ?'); vals.push(JSON.stringify(patch.state || {})); }
  if ('online' in patch) { sets.push('online = ?'); vals.push(patch.online == null ? null : (patch.online ? 1 : 0)); }
  if ('configured' in patch) { sets.push('configured = ?'); vals.push(patch.configured ? 1 : 0); }
  if (!sets.length) return getDevice(gc, id);
  sets.push("updated_at = datetime('now')");
  await gc.db.run(`UPDATE edge_devices SET ${sets.join(', ')} WHERE id = ?`, [...vals, Number(id)]);
  return getDevice(gc, id);
}

/** The device, its resources and their owners. */
async function removeDevice(gc, id) {
  const did = Number(id);
  await store.tx(gc, async () => {
    await gc.db.run('DELETE FROM resource_owners WHERE resource_id IN (SELECT id FROM resources WHERE edge_device_id = ?)', [did]);
    await gc.db.run('DELETE FROM resources WHERE edge_device_id = ?', [did]);
    await gc.db.run('DELETE FROM edge_devices WHERE id = ?', [did]);
  });
}

async function deviceResources(gc, deviceId) {
  const rows = (await gc.db.query("SELECT * FROM resources WHERE edge_device_id = ? AND deconz_type = 'edge' ORDER BY deconz_id", [Number(deviceId)])).rows;
  return rows.map((r) => ({ ...r, capabilities: store.parseJson(r.capabilities_json), state: store.parseJson(r.state_json), capabilities_json: undefined, state_json: undefined }));
}

/** Every resource of a device on one gateway (for the reachability pass). */
async function allEdgeResources(gc) {
  const rows = (await gc.db.query("SELECT id, edge_device_id, state_json FROM resources WHERE deconz_type = 'edge'")).rows;
  return rows.map((r) => ({ id: r.id, edge_device_id: r.edge_device_id, state: store.parseJson(r.state_json) }));
}

/** Insert or update one channel resource of a device → its id. state undefined: keep the cached one. */
async function upsertChannel(gc, device, key, { kind, name, capabilities, state, area }) {
  const deconzId = `${device.id}/${key}`;
  const existing = (await gc.db.get("SELECT id, kind, name, capabilities_json, state_json, enabled, area FROM resources WHERE gateway_id = 0 AND deconz_type = 'edge' AND deconz_id = ?", [deconzId])).row;
  const caps = JSON.stringify(capabilities || {});
  // a report that changes nothing (the same values again) → no write
  if (existing && existing.kind === kind && existing.name === name && existing.capabilities_json === caps && Number(existing.enabled) === 1
    && (existing.area == null ? null : existing.area) === (area == null ? null : area) && (state === undefined || existing.state_json === JSON.stringify(state || {}))) {
    return existing.id;
  }
  if (existing) {
    const sets = ['kind = ?', 'name = ?', 'capabilities_json = ?', 'enabled = 1', 'area = ?', "updated_at = datetime('now')"];
    const vals = [kind, name, caps, area == null ? null : area];
    if (state !== undefined) { sets.push('state_json = ?'); vals.push(JSON.stringify(state || {})); }
    await gc.db.run(`UPDATE resources SET ${sets.join(', ')} WHERE id = ?`, [...vals, existing.id]);
    return existing.id;
  }
  const r = await gc.db.run(`INSERT INTO resources (gateway_id, deconz_id, deconz_type, uniqueid, kind, name, capabilities_json, state_json, area, edge_device_id)
    VALUES (0, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`, [deconzId, EDGE_TYPE, kind, name, caps, JSON.stringify(state || {}), area == null ? null : area, device.id]);
  return Number(r.lastInsertRowid);
}

async function removeChannel(gc, device, key) {
  const row = (await gc.db.get("SELECT id FROM resources WHERE gateway_id = 0 AND deconz_type = 'edge' AND deconz_id = ?", [`${device.id}/${key}`])).row;
  if (!row) return false;
  await store.tx(gc, async () => {
    await gc.db.run('DELETE FROM resource_owners WHERE resource_id = ?', [row.id]);
    await gc.db.run('DELETE FROM resources WHERE id = ?', [row.id]);
  });
  return true;
}

async function setResourceState(gc, id, state) {
  await gc.db.run("UPDATE resources SET state_json = ?, updated_at = datetime('now') WHERE id = ?", [JSON.stringify(state || {}), Number(id)]);
}

module.exports = {
  EDGE_TYPE, FAMILIES, listDevices, getDevice, getByBase, createDevice, updateDevice, removeDevice, deviceResources, allEdgeResources,
  upsertChannel, removeChannel, setResourceState,
};
