'use strict';

// Zigbee devices of zigbee2mqtt through a GateControl gateway (GateControl with the radio follow-ups: gc.radio.zigbee
// and gc.radio.command, permissions.radio). On a gateway with "zigbee2mqtt" chosen in GateControl (Gateway › Funk),
// every device paired there comes here — pairing in GateControl is the step that lets a device in, as with deCONZ.
// gc.radio.zigbee() → { gateways: [{ id, name }], devices: [{ id: 'z2m:<ieee hex>', gatewayId, gateway, ieee, name,
// model, vendor, kind, caps, values, battery, online, seenAt }] }. Without gc.radio.zigbee (an older GateControl)
// nothing happens.
//
// Each device is one resource like the Bluetooth sensors: gateway_id 0, deconz_type 'z2m', deconz_id '<id>', uniqueid
// the IEEE address ("00:17:88:…", so "In Smart Home benennen" finds it), kind light | plug | cover | sensor | switch
// (a button), capabilities { source: 'z2m', gateway_id, gateway, model, vendor, bri, ct, color, position, power,
// reading, named }, state as for the other sources ({ reachable, on, bri } / { reachable, pos, moving, on } / the
// sensor reading). A device missing from the complete list of its gateway, or of a gateway switched back to deCONZ,
// is switched off here (enabled 0) — its owners stay, it comes back when it is there again.
// Switching goes through gc.radio.command(id, { on, bri, ct, hue, sat, cover, pos }); the gateway sends it to
// zigbee2mqtt and the next report (≤ 5 s) brings the real state.

const store = require('./store');
const { sensorState } = require('./radio');
const { codeError } = require('./deconz');

const Z2M_TYPE = 'z2m';
const ID_RE = /^z2m:[0-9a-f]{16}$/;
const IEEE_RE = /^([0-9a-f]{2}:){7}[0-9a-f]{2}$/;
const NAME_MAX = 60;
const SYNC_MS = 15 * 1000;
const KINDS = { light: 'light', plug: 'plug', cover: 'cover', sensor: 'sensor', remote: 'switch' };

const mem = { at: 0 };

const available = (gc) => !!(gc.radio && typeof gc.radio.zigbee === 'function' && typeof gc.radio.command === 'function');
const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** The resource view of one device: { kind, capabilities, state }. */
function resourceOf(d, prev) {
  const kind = KINDS[d.kind] || null;
  if (!kind) return null;
  const c = d.caps && typeof d.caps === 'object' ? d.caps : {};
  const v = d.values && typeof d.values === 'object' ? d.values : {};
  const caps = { source: Z2M_TYPE, gateway_id: Number.isInteger(d.gatewayId) ? d.gatewayId : null, gateway: cleanText(d.gateway, 80) || null,
    model: cleanText(d.model, 60) || null, vendor: cleanText(d.vendor, 60) || null, named: !!(prev && prev.capabilities && prev.capabilities.named) };
  const reachable = d.online !== false;
  let state;
  if (kind === 'light' || kind === 'plug') {
    if (c.bri === true && kind === 'light') caps.bri = true;
    if (c.ct === true && kind === 'light') caps.ct = true;
    if (kind === 'light' && (c.color === 'xy' || c.color === 'hs')) caps.color = c.color;
    if (c.power === true) caps.power = true;
    state = { reachable, on: v.on === true };
    if (caps.bri && finite(v.bri) != null) state.bri = Math.round(v.bri);
    if (finite(v.power) != null) state.power = v.power;
  } else if (kind === 'cover') {
    if (c.position === true) caps.position = true;
    caps.cover = 'shutter';
    const pos = finite(v.pos);
    state = { reachable, pos, moving: null, on: pos != null ? pos > 0 : !!(prev && prev.state && prev.state.on) };
  } else if (kind === 'sensor') {
    const s = sensorState({ values: v, online: d.online === true || d.online == null, seenAt: d.seenAt });
    caps.reading = s.reading;
    state = s.state;
  } else {
    state = { reachable };
    if (typeof v.action === 'string') state.action = v.action.slice(0, 32);
  }
  if (finite(v.battery) != null && kind !== 'sensor') state.battery = Math.round(v.battery);
  if (typeof d.seenAt === 'string') state.lastupdated = d.seenAt.slice(0, 40);
  return { kind, caps, state };
}

async function resources(gc) {
  const rows = (await gc.db.query("SELECT * FROM resources WHERE gateway_id = 0 AND deconz_type = 'z2m' ORDER BY name")).rows;
  return rows.map((r) => ({ ...r, capabilities: store.parseJson(r.capabilities_json) || {}, state: store.parseJson(r.state_json) || {}, capabilities_json: undefined, state_json: undefined }));
}

/** Mirror gc.radio.zigbee() into the resources (every 15 s from tick, and on demand). → { devices } */
async function sync(gc, { force = false } = {}) {
  if (!available(gc)) return { available: false, devices: 0 };
  if (!force && Date.now() - mem.at < SYNC_MS) return { available: true, skipped: true };
  mem.at = Date.now();
  let out;
  try { out = await gc.radio.zigbee(); } catch (e) { gc.log.debug('radio zigbee failed', (e && (e.code || e.message)) || e); return { available: true, devices: 0, error: true }; }
  const list = out && Array.isArray(out.devices) ? out.devices : [];
  const seen = new Set();
  const have = new Map((await resources(gc)).map((r) => [r.deconz_id, r]));
  for (const d of list.slice(0, 512)) {
    if (!d || typeof d.id !== 'string' || !ID_RE.test(d.id) || typeof d.ieee !== 'string' || !IEEE_RE.test(d.ieee) || seen.has(d.id)) continue;
    const prev = have.get(d.id);
    const r = resourceOf(d, prev);
    if (!r) continue;
    seen.add(d.id);
    const name = r.caps.named && prev ? prev.name : (cleanText(d.name, NAME_MAX) || d.ieee);
    if (prev) {
      await gc.db.run("UPDATE resources SET kind = ?, name = ?, capabilities_json = ?, state_json = ?, enabled = 1, updated_at = datetime('now') WHERE id = ?",
        [r.kind, name, JSON.stringify(r.caps), JSON.stringify(r.state), prev.id]);
    } else {
      await gc.db.run(`INSERT INTO resources (gateway_id, deconz_id, deconz_type, uniqueid, kind, name, capabilities_json, state_json)
        VALUES (0, ?, ?, ?, ?, ?, ?, ?)`, [d.id, Z2M_TYPE, d.ieee, r.kind, name, JSON.stringify(r.caps), JSON.stringify(r.state)]);
    }
  }
  // gone from its gateway's complete list, or the gateway runs deCONZ again: off here, owners stay
  for (const [id, r] of have) {
    if (seen.has(id) || !r.enabled) continue;
    await gc.db.run("UPDATE resources SET enabled = 0, updated_at = datetime('now') WHERE id = ?", [r.id]);
  }
  return { available: true, devices: seen.size };
}

/** The resources of one GateControl gateway (or all). */
async function list(gc, gatewayId) {
  await sync(gc);
  return (await resources(gc)).filter((r) => gatewayId == null || r.capabilities.gateway_id === Number(gatewayId));
}

/** Switch a device: the patch of the page or the portal → gc.radio.command; the cached state follows. */
async function setState(gc, resource, raw) {
  if (!available(gc)) throw codeError('SMARTHOME_RADIO_UNAVAILABLE');
  const p = raw && typeof raw === 'object' ? raw : {};
  const caps = resource.capabilities || {};
  const set = {};
  if (resource.kind === 'cover') {
    if (['open', 'close', 'stop'].includes(p.cover)) set.cover = p.cover;
    else if (caps.position && finite(p.pos) != null) set.pos = Math.max(0, Math.min(100, Math.round(p.pos)));
  } else if (resource.kind === 'light' || resource.kind === 'plug') {
    if ('on' in p) set.on = Boolean(p.on);
    if (caps.bri && finite(p.bri) != null) set.bri = Math.max(0, Math.min(100, p.bri));
    if (caps.ct && finite(p.ct) != null) set.ct = Math.round(Math.max(153, Math.min(500, p.ct)));
    if (caps.color && (finite(p.hue) != null || finite(p.sat) != null)) {
      if (finite(p.hue) != null) set.hue = Math.round(Math.max(0, Math.min(65535, p.hue)));
      if (finite(p.sat) != null) set.sat = Math.round(Math.max(0, Math.min(254, p.sat)));
      delete set.ct;
    }
  }
  if (!Object.keys(set).length) throw codeError('SMARTHOME_INVALID_PATCH');
  try {
    await gc.radio.command(resource.deconz_id, set);
  } catch (e) {
    const code = (e && e.code) || 'error';
    if (code === 'ERR_NOT_FOUND') throw codeError('SMARTHOME_RESOURCE_NOT_FOUND');
    if (code === 'ERR_INVALID') throw codeError('SMARTHOME_INVALID_PATCH');
    throw codeError('SMARTHOME_RADIO_UNREACHABLE', code);
  }
  const st = { ...(resource.state || {}) };
  if ('on' in set) st.on = set.on;
  if ('bri' in set) { st.bri = Math.round(set.bri); if (set.bri > 0) st.on = true; }
  if (set.cover === 'open' || set.cover === 'close') st.moving = set.cover === 'open' ? 'opening' : 'closing';
  if (set.cover === 'stop') st.moving = null;
  if ('pos' in set) st.moving = set.pos > (st.pos == null ? -1 : st.pos) ? 'opening' : 'closing';
  await gc.db.run("UPDATE resources SET state_json = ?, updated_at = datetime('now') WHERE id = ?", [JSON.stringify(st), resource.id]);
  return { ok: true };
}

/** A name given here stays (zigbee2mqtt's friendly name only until then). */
async function rename(gc, resource, name) {
  const caps = { ...(resource.capabilities || {}), named: true };
  await gc.db.run("UPDATE resources SET name = ?, capabilities_json = ?, updated_at = datetime('now') WHERE id = ?", [name, JSON.stringify(caps), resource.id]);
}

module.exports = { Z2M_TYPE, available, sync, list, setState, rename, resourceOf, _mem: mem };
