'use strict';

// Logic chains for Shelly and Tasmota devices (rules.source 'edge', migrations/003_edge_rules.sql). The definition
// is the one of the deCONZ chains ({ triggers, actions, timeWindow, delay }, kept as the page sent it); it is not
// translated into deCONZ objects but compiled into what the edge part on the devices' gateway runs (edge/rules.js),
// and sent with the device list (gc.edge.configure { devices, rules, tz } — server/edge.js configureGateway).
//
//   triggers  { kind: 'state', resourceId, event: 'on' | 'off' }            a switched output, a light
//             { kind: 'cover', resourceId, event: 'open' | 'closed' }       a shutter, awning or gate with a position
//             { kind: 'power', resourceId, op: 'lt' | 'gt', value }         watts of a metered output
//             { kind: 'temperature' | 'humidity', resourceId, op, value }   a sensor (°C, %)
//   actions   { kind, resourceId, set: { on } | { bri } }                   switch, dim
//             { kind: 'cover', resourceId, set: { cover: 'open' | 'close' | 'stop' } | { pos } }
//
// Every resource must be a channel of a device behind the same GateControl gateway. A rule whose device is gone
// stays (the page shows it read-only, like a deCONZ rule) and is not sent.

const store = require('./store');
const es = require('./edgestore');
const { codeError } = require('./deconz');

const SOURCE = 'edge';
const MAX_RULES = 40;                 // per gateway; the edge part takes 64
const MAX_CONFIG_BYTES = 36 * 1024;   // gc.edge.configure takes 48 KB, the device list comes on top
const CH_RE = /^(switch|light|cover):(\d{1,2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MODES = ['ignore', 'reset', 'cancel'];

function invalid(detail) { return Object.assign(codeError('SMARTHOME_RULE_INVALID', `rule invalid: ${detail}`), { detail }); }

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The edge resources of one GateControl gateway with their device: id → { resource, device, ch }. */
async function resourcesOf(gc, gatewayId) {
  const out = new Map();
  for (const dev of await es.listDevices(gc, gatewayId)) {
    for (const r of await es.deviceResources(gc, dev.id)) {
      out.set(r.id, { resource: r, device: dev, ch: String(r.deconz_id).split('/')[1] || '' });
    }
  }
  return out;
}

function compileTrigger(t, byId) {
  const hit = t && typeof t === 'object' ? byId.get(Number(t.resourceId)) : null;
  if (!hit) throw invalid('foreign_resource');
  const { resource: r, device, ch } = hit;
  const type = ch === 'sensor' ? 'sensor' : ((CH_RE.exec(ch) || [])[1] || null);
  const base = { base: device.base, ch };
  if (t.kind === 'state') {
    if ((type !== 'switch' && type !== 'light') || (t.event !== 'on' && t.event !== 'off')) throw invalid('bad_state_trigger');
    return { ...base, field: 'on', op: 'eq', value: t.event === 'on' };
  }
  if (t.kind === 'cover') {
    if (type !== 'cover' || !(r.capabilities && r.capabilities.position) || (t.event !== 'open' && t.event !== 'closed')) throw invalid('bad_cover_trigger');
    return t.event === 'open' ? { ...base, field: 'pos', op: 'gt', value: 0 } : { ...base, field: 'pos', op: 'lt', value: 1 };
  }
  if (t.op !== 'lt' && t.op !== 'gt') throw invalid('bad_threshold_op');
  const value = finite(typeof t.value === 'string' && t.value.trim() !== '' ? Number(t.value) : t.value);
  if (value == null) throw invalid('bad_threshold_value');
  if (t.kind === 'power') {
    if (!type || type === 'sensor' || !(r.capabilities && r.capabilities.power) || value < 0 || value > 100000) throw invalid('bad_power_trigger');
    return { ...base, field: 'power', op: t.op, value };
  }
  if (t.kind === 'temperature' || t.kind === 'humidity') {
    if (type !== 'sensor' || value < -60 || value > 120) throw invalid('bad_sensor_trigger');
    return { ...base, field: t.kind, op: t.op, value };
  }
  throw invalid('not_edge_trigger');
}

function compileAction(a, byId) {
  const hit = a && typeof a === 'object' ? byId.get(Number(a.resourceId)) : null;
  if (!hit) throw invalid('foreign_resource');
  const { resource: r, device, ch } = hit;
  const m = CH_RE.exec(ch);
  if (!m) throw invalid('not_controllable');
  const set = a.set && typeof a.set === 'object' ? a.set : {};
  const out = { base: device.base, family: device.family, ch };
  if (m[1] === 'cover') {
    if (['open', 'close', 'stop'].includes(set.cover)) return { ...out, op: set.cover };
    const pos = finite(set.pos);
    if (pos == null || pos < 0 || pos > 100 || !(r.capabilities && r.capabilities.position)) throw invalid('bad_cover_action');
    return { ...out, op: 'pos', value: Math.round(pos) };
  }
  if ('bri' in set) {
    const bri = finite(set.bri);
    if (m[1] !== 'light' || bri == null || bri < 1 || bri > 100) throw invalid('no_bri_capability');
    return { ...out, op: 'bri', value: Math.round(bri) };
  }
  if (typeof set.on !== 'boolean') throw invalid('bad_action');
  return { ...out, op: set.on ? 'on' : 'off' };
}

/** A stored definition → the rule the edge part runs (throws SMARTHOME_RULE_INVALID with a detail). */
function compileRule(id, def, byId) {
  const d = def && typeof def === 'object' ? def : {};
  const triggers = (Array.isArray(d.triggers) ? d.triggers : []).map((t) => compileTrigger(t, byId));
  const actions = (Array.isArray(d.actions) ? d.actions : []).map((a) => compileAction(a, byId));
  if (!triggers.length) throw invalid('no_trigger');
  if (!actions.length) throw invalid('no_action');
  let window = null;
  if (d.timeWindow && (d.timeWindow.from || d.timeWindow.to)) {
    if (!TIME_RE.test(d.timeWindow.from) || !TIME_RE.test(d.timeWindow.to)) throw invalid('bad_time_window');
    window = { from: d.timeWindow.from, to: d.timeWindow.to };
  }
  let delay = null;
  if (d.delay && d.delay.minutes) {
    if (!Number.isInteger(d.delay.minutes) || d.delay.minutes < 1 || d.delay.minutes > 1440) throw invalid('bad_delay_minutes');
    delay = { minutes: d.delay.minutes, mode: MODES.includes(d.delay.onRetrigger) ? d.delay.onRetrigger : 'ignore' };
  }
  return { id, triggers, actions, window, delay };
}

/** The server's time zone (the plugin process runs in it): "Nur in Zeitfenster" means the clock of the house. */
function timeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; }
}

async function rows(gc, gatewayId) {
  return (await gc.db.query("SELECT * FROM rules WHERE source = 'edge' AND gateway_id = ? ORDER BY id", [Number(gatewayId)])).rows;
}

/** What configureGateway adds to the device list: the enabled, complete rules of the gateway. */
async function configFor(gc, gatewayId) {
  const list = await rows(gc, gatewayId);
  if (!list.length) return { rules: [], tz: timeZone() };
  const byId = await resourcesOf(gc, gatewayId);
  const out = [];
  for (const row of list) {
    if (!row.enabled) continue;
    try { out.push(compileRule(row.id, store.parseJson(row.definition_json), byId)); } catch { /* a device is gone: the page shows it */ }
  }
  return { rules: out.slice(0, MAX_RULES), tz: timeZone() };
}

/** Would this definition fit? Checks the definition, the number of rules and the size of the list. */
async function check(gc, gatewayId, id, definition) {
  const byId = await resourcesOf(gc, gatewayId);
  const compiled = compileRule(id || 0, definition, byId);
  const others = (await rows(gc, gatewayId)).filter((r) => r.id !== id);
  if (others.length >= MAX_RULES) throw codeError('SMARTHOME_EDGE_RULE_LIMIT', 'too many logic chains on this gateway');
  const rest = (await configFor(gc, gatewayId)).rules.filter((r) => r.id !== id);
  if (Buffer.byteLength(JSON.stringify([...rest, compiled])) > MAX_CONFIG_BYTES) throw codeError('SMARTHOME_EDGE_RULE_LIMIT', 'the logic chains of this gateway are too large');
  return compiled;
}

/** Event `fired` of the edge part: { rules: [{ id, at }] }. */
async function markFired(gc, gatewayId, data, now = Date.now()) {
  const list = data && Array.isArray(data.rules) ? data.rules.slice(0, 64) : [];
  const latest = new Map();
  for (const f of list) {
    if (!f || !Number.isSafeInteger(f.id) || f.id <= 0) continue;
    const at = Date.parse(f.at);
    const ms = Number.isFinite(at) ? Math.min(at, now) : now;
    if (!(latest.get(f.id) >= ms)) latest.set(f.id, ms);
  }
  for (const [id, ms] of latest) {
    await gc.db.run("UPDATE rules SET last_fired_at = ? WHERE id = ? AND source = 'edge' AND gateway_id = ?", [new Date(ms).toISOString(), id, Number(gatewayId)]);
  }
  return latest.size;
}

module.exports = { SOURCE, MAX_RULES, resourcesOf, compileRule, configFor, check, markFired, timeZone };
