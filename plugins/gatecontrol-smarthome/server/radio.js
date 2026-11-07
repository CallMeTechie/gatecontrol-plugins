'use strict';

// Bluetooth sensors through a GateControl gateway (GateControl with phase 3c step 2: gc.radio, permissions.radio).
// The gateways listen passively to Bluetooth thermometers (BTHome, Xiaomi with ATC/pvvx firmware); the administrator
// takes the ones of the house over in GateControl (Gateway › Funk › "Übernehmen"). Only those come here:
// gc.radio.sensors() → [{ id: 'ble:<mac hex>', gatewayId, gateway, mac, name, model, values, battery, online, seenAt }].
// Without gc.radio (an older GateControl) nothing happens. The zigbee2mqtt devices of the same gateways are in
// server/zigbee.js; the page shows both under the gateway's source ("Funk über …").
//
// Each sensor is one resource like the edge ones: gateway_id 0, deconz_type 'ble', deconz_id '<id>', uniqueid the MAC
// (lower case), kind 'sensor', capabilities { source: 'ble', gateway_id, gateway, model, reading, named }, state
// { reachable, type, value, humidity, battery } — the portal, owners and areas work as for every other sensor. A name
// given here (PUT /resources/:id { name }) stays (capabilities.named); otherwise the name from GateControl.

const store = require('./store');

const BLE_TYPE = 'ble';
const ID_RE = /^ble:[0-9a-f]{12}$/;
const MAC_RE = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;
const NAME_MAX = 60;
const SYNC_MS = 60 * 1000;

const mem = { at: 0 };

const available = (gc) => !!(gc.radio && typeof gc.radio.sensors === 'function');
const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** What GateControl reports of a sensor → { reading, state } (temperature first, as the edge sensors). */
function sensorState(s) {
  const v = s.values && typeof s.values === 'object' ? s.values : {};
  let reading = 'unknown';
  let value = null;
  if (finite(v.temperature) != null) { reading = 'temperature'; value = v.temperature; }
  else if (finite(v.humidity) != null) { reading = 'humidity'; value = v.humidity; }
  else if (typeof v.window === 'boolean' || typeof v.door === 'boolean' || typeof v.opening === 'boolean') { reading = 'open'; value = v.window === true || v.door === true || v.opening === true; }
  else if (typeof v.motion === 'boolean' || typeof v.occupancy === 'boolean') { reading = 'presence'; value = v.motion === true || v.occupancy === true; }
  else if (typeof v.moisture_wet === 'boolean') { reading = 'water'; value = v.moisture_wet; }
  else if (finite(v.illuminance) != null) { reading = 'lightlevel'; value = v.illuminance; }
  const state = { reachable: s.online === true, type: reading, value };
  if (finite(v.humidity) != null && reading !== 'humidity') state.humidity = v.humidity;
  if (finite(v.battery) != null) state.battery = Math.round(v.battery);
  if (typeof s.seenAt === 'string') state.lastupdated = s.seenAt.slice(0, 40);
  return { reading, state };
}

async function resources(gc) {
  const rows = (await gc.db.query("SELECT * FROM resources WHERE gateway_id = 0 AND deconz_type = 'ble' ORDER BY name")).rows;
  return rows.map((r) => ({ ...r, capabilities: store.parseJson(r.capabilities_json) || {}, state: store.parseJson(r.state_json) || {}, capabilities_json: undefined, state_json: undefined }));
}

/** Mirror gc.radio.sensors() into the resources (every minute from tick, and on demand). → { sensors } */
async function sync(gc, { force = false } = {}) {
  if (!available(gc)) return { available: false, sensors: 0 };
  if (!force && Date.now() - mem.at < SYNC_MS) return { available: true, skipped: true };
  mem.at = Date.now();
  let list;
  try { list = await gc.radio.sensors(); } catch (e) { gc.log.debug('radio sensors failed', (e && (e.code || e.message)) || e); return { available: true, sensors: 0, error: true }; }
  const seen = new Set();
  const have = new Map((await resources(gc)).map((r) => [r.deconz_id, r]));
  for (const s of Array.isArray(list) ? list.slice(0, 256) : []) {
    if (!s || typeof s.id !== 'string' || !ID_RE.test(s.id) || typeof s.mac !== 'string' || !MAC_RE.test(s.mac) || seen.has(s.id)) continue;
    seen.add(s.id);
    const prev = have.get(s.id);
    const { reading, state } = sensorState(s);
    const named = !!(prev && prev.capabilities && prev.capabilities.named);
    const name = named ? prev.name : (cleanText(s.name, NAME_MAX) || s.mac);
    const caps = JSON.stringify({ source: 'ble', reading, gateway_id: Number.isInteger(s.gatewayId) ? s.gatewayId : null, gateway: cleanText(s.gateway, 80) || null, model: cleanText(s.model, 60) || null, named });
    if (prev) {
      await gc.db.run("UPDATE resources SET name = ?, capabilities_json = ?, state_json = ?, enabled = 1, updated_at = datetime('now') WHERE id = ?", [name, caps, JSON.stringify(state), prev.id]);
    } else {
      await gc.db.run(`INSERT INTO resources (gateway_id, deconz_id, deconz_type, uniqueid, kind, name, capabilities_json, state_json)
        VALUES (0, ?, ?, ?, 'sensor', ?, ?, ?)`, [s.id, BLE_TYPE, s.mac.toLowerCase(), name, caps, JSON.stringify(state)]);
    }
  }
  // given back in GateControl (or Bluetooth switched off there): the resource and its owners go
  for (const [id, r] of have) {
    if (seen.has(id)) continue;
    await store.tx(gc, async () => {
      await gc.db.run('DELETE FROM resource_owners WHERE resource_id = ?', [r.id]);
      await gc.db.run('DELETE FROM resources WHERE id = ?', [r.id]);
    });
  }
  return { available: true, sensors: seen.size };
}

/** The radio resources of GateControl gateways: the Bluetooth sensors and the zigbee2mqtt devices (server/zigbee.js). */
async function radioResources(gc) {
  const z = require('./zigbee');
  const zr = z.available(gc) ? (await z.list(gc)).filter((r) => r.enabled) : [];
  return (await resources(gc)).concat(zr);
}

/** The GateControl gateways with radio resources here: [{ id, name, sensors, devices }] (the page's sources). */
async function gateways(gc) {
  const z = require('./zigbee');
  if (!available(gc) && !z.available(gc)) return { available: false, gateways: [] };
  if (available(gc)) await sync(gc);
  const by = new Map();
  for (const r of await radioResources(gc)) {
    const id = r.capabilities.gateway_id;
    if (!Number.isInteger(id)) continue;
    const g = by.get(id) || { id, name: r.capabilities.gateway || String(id), sensors: 0, devices: 0 };
    if (r.deconz_type === BLE_TYPE) g.sensors++;
    else g.devices++;
    by.set(id, g);
  }
  return { available: true, gateways: [...by.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

/** The Bluetooth sensors and zigbee2mqtt devices of one GateControl gateway (with their owners, as /resources). */
async function list(gc, gatewayId) {
  if (available(gc)) await sync(gc);
  return (await radioResources(gc)).filter((r) => gatewayId == null || r.capabilities.gateway_id === Number(gatewayId));
}

/** A name given here stays (GateControl's name only until then). */
async function rename(gc, resource, name) {
  const caps = { ...(resource.capabilities || {}), named: true };
  await gc.db.run("UPDATE resources SET name = ?, capabilities_json = ?, updated_at = datetime('now') WHERE id = ?", [name, JSON.stringify(caps), resource.id]);
}

module.exports = { BLE_TYPE, available, sync, gateways, list, rename, sensorState, _mem: mem };
