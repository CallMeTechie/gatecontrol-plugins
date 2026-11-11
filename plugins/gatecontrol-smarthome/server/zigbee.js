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
//
// 1.10.0 — with a GateControl and a gateway that report it (older ones: nothing of this appears, all as before):
//   several channels  caps.channels ['l1', 'l2', …] (a 2- or 3-gang switch: state_l1, state_l2 …) → one resource
//                     PER CHANNEL, deconz_id '<id>/<channel>', capabilities.channel / channel_no, each with its own
//                     name, area and owners; values.ch { l1: true, … }; switched with { on, channel }. The resource
//                     the device had before (its first channel only) becomes channel 1 and keeps its owners.
//   thermostats       kind 'climate' → a resource of kind 'thermostat': capabilities.setpoint { min, max, step } and
//                     modes [off | heat | auto …], state { type 'temperature', value (measured), setpoint, mode,
//                     heating, valve }; set with { setpoint } / { mode }
//   OTA updates       caps.ota → capabilities.ota, state.ota { state: idle | available | updating | scheduled,
//                     progress, installed, latest, checked, error }; ota(…, 'check' | 'update') asks zigbee2mqtt
//                     (gc.radio.command(id, { ota })). On a device with channels the first one carries it.

const store = require('./store');
const { sensorState } = require('./radio');
const { codeError } = require('./deconz');

const Z2M_TYPE = 'z2m';
const ID_RE = /^z2m:[0-9a-f]{16}$/;
const IEEE_RE = /^([0-9a-f]{2}:){7}[0-9a-f]{2}$/;
const NAME_MAX = 60;
const SYNC_MS = 15 * 1000;
const KINDS = { light: 'light', plug: 'plug', cover: 'cover', sensor: 'sensor', remote: 'switch', climate: 'thermostat' };
const CH_RE = /^[a-z0-9_]{1,8}$/;
const MAX_CHANNELS = 8;
const MODES = ['off', 'heat', 'auto', 'cool', 'fan_only', 'dry'];
const OTA_STATES = ['idle', 'available', 'updating', 'scheduled'];
const OTA_ERRORS = ['check_failed', 'update_failed'];

const mem = { at: 0 };

const available = (gc) => !!(gc.radio && typeof gc.radio.zigbee === 'function' && typeof gc.radio.command === 'function');
const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** The channels of a device with several switched outputs (a 2-gang switch …): ['l1', 'l2'] — or null. */
function channelsOf(d) {
  const list = d && d.caps && Array.isArray(d.caps.channels) ? d.caps.channels : null;
  if (!list || (d.kind !== 'plug' && d.kind !== 'light')) return null;
  const out = [...new Set(list.filter((x) => typeof x === 'string' && CH_RE.test(x)))].slice(0, MAX_CHANNELS);
  return out.length >= 2 ? out : null;
}

/** values.ota of a device → what the page shows, or null. */
function otaOf(v) {
  const o = v && v.ota && typeof v.ota === 'object' ? v.ota : null;
  if (!o) return null;
  const out = { state: OTA_STATES.includes(o.state) ? o.state : 'idle' };
  if (finite(o.progress) != null && out.state === 'updating') out.progress = Math.max(0, Math.min(100, Math.round(o.progress)));
  for (const k of ['installed', 'latest']) {
    if (finite(o[k]) != null) out[k] = String(o[k]);
    else if (typeof o[k] === 'string' && /^[\w.+-]{1,32}$/.test(o[k])) out[k] = o[k];
  }
  if (typeof o.checked === 'string' && Number.isFinite(Date.parse(o.checked))) out.checked = o.checked.slice(0, 40);
  if (OTA_ERRORS.includes(o.error)) out.error = o.error;
  return out;
}

/** A thermostat's limits from caps.setpoint { min, max, step } (5–30 °C in half degrees when the device says nothing). */
function setpointCaps(c) {
  const s = c && c.setpoint && typeof c.setpoint === 'object' ? c.setpoint : {};
  let min = finite(s.min);
  let max = finite(s.max);
  if (min == null || min < 0 || min > 40) min = 5;
  if (max == null || max <= min || max > 50) max = Math.max(30, min + 1);
  const step = finite(s.step) != null && s.step >= 0.1 && s.step <= 5 ? s.step : 0.5;
  return { min, max, step };
}

/**
 * The resource view of one device: { kind, capabilities, state }. With `channel` { id, no, first } it is the view of
 * one switched output of a device with several (channelsOf).
 */
function resourceOf(d, prev, channel) {
  const kind = KINDS[d.kind] || null;
  if (!kind) return null;
  const c = d.caps && typeof d.caps === 'object' ? d.caps : {};
  const v = d.values && typeof d.values === 'object' ? d.values : {};
  const caps = { source: Z2M_TYPE, gateway_id: Number.isInteger(d.gatewayId) ? d.gatewayId : null, gateway: cleanText(d.gateway, 80) || null,
    model: cleanText(d.model, 60) || null, vendor: cleanText(d.vendor, 60) || null, named: !!(prev && prev.capabilities && prev.capabilities.named) };
  const reachable = d.online !== false;
  let state;
  if (channel) {
    // one output of several: on/off only (brightness and colour are per device in zigbee2mqtt's first channel)
    caps.channel = channel.id;
    caps.channel_no = channel.no;
    const on = v.ch && typeof v.ch === 'object' ? v.ch[channel.id] : undefined;
    state = { reachable, on: on === true };
  } else if (kind === 'thermostat') {
    caps.reading = 'temperature';
    caps.setpoint = setpointCaps(c);
    const modes = Array.isArray(c.modes) ? [...new Set(c.modes.filter((m) => MODES.includes(m)))] : [];
    if (modes.length) caps.modes = modes;
    state = { reachable, type: 'temperature', value: finite(v.temperature) };
    if (finite(v.setpoint) != null) state.setpoint = v.setpoint;
    if (MODES.includes(v.mode)) state.mode = v.mode;
    if (typeof v.heating === 'boolean') state.heating = v.heating;
    if (finite(v.valve) != null) state.valve = Math.max(0, Math.min(100, Math.round(v.valve)));
  } else if (kind === 'light' || kind === 'plug') {
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
  if (c.ota === true && (!channel || channel.first)) {
    caps.ota = true;
    const ota = otaOf(v);
    if (ota) state.ota = ota;
  }
  return { kind, caps, state };
}

/** The resources a device stands for: [{ key (deconz_id), channel | null }] — one, or one per channel. */
function partsOf(d) {
  const channels = channelsOf(d);
  if (!channels) return [{ key: d.id, channel: null }];
  return channels.map((id, i) => ({ key: `${d.id}/${id}`, channel: { id, no: i + 1, first: i === 0 } }));
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
  const devices = new Set();
  const have = new Map((await resources(gc)).map((r) => [r.deconz_id, r]));
  for (const d of list.slice(0, 512)) {
    if (!d || typeof d.id !== 'string' || !ID_RE.test(d.id) || typeof d.ieee !== 'string' || !IEEE_RE.test(d.ieee) || devices.has(d.id)) continue;
    if (!KINDS[d.kind]) continue;
    devices.add(d.id);
    const parts = partsOf(d);
    // the device as it was until now (one resource for its first channel) becomes channel 1 — and the other way
    // round when the channels are gone again (an older gateway): the row, its name, area and owners stay
    const first = parts[0];
    if (!have.has(first.key)) {
      const old = first.channel ? have.get(d.id) : [...have.values()].find((x) => x.deconz_id.startsWith(d.id + '/') && x.capabilities.channel_no === 1);
      if (old) {
        await gc.db.run("UPDATE resources SET deconz_id = ?, updated_at = datetime('now') WHERE id = ?", [first.key, old.id]);
        have.delete(old.deconz_id);
        have.set(first.key, { ...old, deconz_id: first.key });
      }
    }
    for (const part of parts) await upsertPart(gc, d, part, have.get(part.key), seen);
  }
  // gone from its gateway's complete list, or the gateway runs deCONZ again: off here, owners stay
  for (const [id, r] of have) {
    if (seen.has(id) || !r.enabled) continue;
    await gc.db.run("UPDATE resources SET enabled = 0, updated_at = datetime('now') WHERE id = ?", [r.id]);
  }
  return { available: true, devices: devices.size, resources: seen.size };
}

/** One resource of a device (the device itself, or one of its channels): insert, or update when something changed. */
async function upsertPart(gc, d, part, prev, seen) {
  const r = resourceOf(d, prev, part.channel);
  if (!r) return;
  seen.add(part.key);
  const base = cleanText(d.name, NAME_MAX) || d.ieee;
  const name = r.caps.named && prev ? prev.name : (part.channel ? `${base.slice(0, NAME_MAX - 3)} ${part.channel.no}` : base);
  const caps = JSON.stringify(r.caps);
  const state = JSON.stringify(r.state);
  if (prev) {
    // every 15 s the same list: only a device whose values changed is written
    if (prev.kind === r.kind && prev.name === name && JSON.stringify(prev.capabilities) === caps && JSON.stringify(prev.state) === state && prev.enabled) return;
    await gc.db.run("UPDATE resources SET kind = ?, name = ?, capabilities_json = ?, state_json = ?, enabled = 1, updated_at = datetime('now') WHERE id = ?",
      [r.kind, name, caps, state, prev.id]);
    return;
  }
  await gc.db.run(`INSERT INTO resources (gateway_id, deconz_id, deconz_type, uniqueid, kind, name, capabilities_json, state_json)
    VALUES (0, ?, ?, ?, ?, ?, ?, ?)`, [part.key, Z2M_TYPE, d.ieee, r.kind, name, caps, state]);
}

/** The device id of a resource ('z2m:<ieee hex>' — a channel's deconz_id carries '/<channel>' behind it). */
const deviceIdOf = (resource) => String(resource.deconz_id).split('/')[0];

function commandError(e) {
  const code = (e && e.code) || 'error';
  if (code === 'ERR_NOT_FOUND') return codeError('SMARTHOME_RESOURCE_NOT_FOUND');
  if (code === 'ERR_INVALID') return codeError('SMARTHOME_INVALID_PATCH');
  return codeError('SMARTHOME_RADIO_UNREACHABLE', code);
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
  } else if (resource.kind === 'thermostat') {
    const sp = caps.setpoint || setpointCaps(null);
    if (finite(p.setpoint) != null) set.setpoint = Math.round(Math.max(sp.min, Math.min(sp.max, Math.round(p.setpoint / sp.step) * sp.step)) * 10) / 10;
    if (typeof p.mode === 'string' && (caps.modes || []).includes(p.mode)) set.mode = p.mode;
  } else if (caps.channel) {
    // one output of a device with several: on/off, addressed by its channel
    if ('on' in p) { set.on = Boolean(p.on); set.channel = caps.channel; }
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
    await gc.radio.command(deviceIdOf(resource), set);
  } catch (e) {
    throw commandError(e);
  }
  const st = { ...(resource.state || {}) };
  if ('on' in set) st.on = set.on;
  if ('setpoint' in set) st.setpoint = set.setpoint;
  if ('mode' in set) st.mode = set.mode;
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

/**
 * A firmware update over the air: 'check' asks zigbee2mqtt whether there is one, 'update' starts it (it takes
 * 10–60 minutes; the device keeps working, a battery device has to be awake). The answer comes with the reports.
 */
async function ota(gc, resource, action) {
  if (!available(gc)) throw codeError('SMARTHOME_RADIO_UNAVAILABLE');
  if (action !== 'check' && action !== 'update') throw codeError('INVALID');
  if (!resource || resource.deconz_type !== Z2M_TYPE || !(resource.capabilities && resource.capabilities.ota)) throw codeError('SMARTHOME_NOT_CONTROLLABLE');
  try {
    await gc.radio.command(deviceIdOf(resource), { ota: action });
  } catch (e) {
    throw commandError(e);
  }
  if (action === 'update') {
    const st = { ...(resource.state || {}), ota: { ...((resource.state && resource.state.ota) || {}), state: 'updating', progress: 0 } };
    delete st.ota.error;
    await gc.db.run("UPDATE resources SET state_json = ?, updated_at = datetime('now') WHERE id = ?", [JSON.stringify(st), resource.id]);
  }
  return { ok: true, action };
}

module.exports = { Z2M_TYPE, available, sync, list, setState, rename, ota, resourceOf, channelsOf, _mem: mem };
