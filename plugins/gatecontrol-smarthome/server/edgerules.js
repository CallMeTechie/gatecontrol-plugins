'use strict';

// Logic chains for Shelly and Tasmota devices (rules.source 'edge', migrations/003_edge_rules.sql). The definition
// is kept as the page sent it; it is not translated into deCONZ objects but compiled into what the edge part on the
// devices' gateway runs (edge/rules.js), and sent with the device list (gc.edge.configure { devices, rules, tz } —
// server/edge.js configureGateway).
//
// Version 1 (1.10.0, the one of the deCONZ chains: { triggers, actions, timeWindow, delay }) — runs unchanged:
//   triggers  { kind: 'state', resourceId, event: 'on' | 'off' }            a switched output, a light
//             { kind: 'cover', resourceId, event: 'open' | 'closed' }       a shutter, awning or gate with a position
//             { kind: 'power', resourceId, op: 'lt' | 'gt', value }         watts of a metered output
//             { kind: 'temperature' | 'humidity', resourceId, op, value }   a sensor (°C, %)
//   actions   { kind, resourceId, set: { on } | { bri } }                   switch, dim
//             { kind: 'cover', resourceId, set: { cover: 'open' | 'close' | 'stop' } | { pos } }
//
// Version 2 (1.11.0, definition.version 2) — WENN · NUR WENN · DANN:
//   { version: 2, triggers: [t], conditions: { mode: 'all' | 'any', list: [c] }, steps: [s], retrigger }
//   t  a version 1 trigger (it BECOMES true) · { kind: 'button', deviceId, input: 0…7, event: single | double |
//      triple | long } · { kind: 'time', at: 'HH:MM' } · { kind: 'all', parts: [version 1 trigger] } ("wird wahr:
//      A und B" — a version 1 chain opened in the new editor)
//   c  { kind: 'state', resourceId, is: 'on' | 'off' } · { kind: 'cover', resourceId, is: 'open' | 'closed' } ·
//      { kind: 'power' | 'temperature' | 'humidity', resourceId, op, value } · { kind: 'time', from, to } ·
//      { kind: 'days', days: [1…7] } (1 = Monday)
//   s  { kind: 'action', resourceId, set } (as a version 1 action) · { kind: 'wait', seconds: 1…86400 }
//   retrigger  restart (default) | ignore | cancel
// toV2(definition) shows a version 1 definition as the new editor edits it; saved, it is version 2 (no migration).
//
// Every resource must be a channel (a button: a device) behind the same GateControl gateway. A rule whose device is
// gone stays (the page shows it read-only, like a deCONZ rule) and is not sent.
//
// Before a chain is saved: analyse() looks at what it switches and what the other chains of the gateway react to —
// a loop that surely swings (A switches X off, B switches it on again, …, without NUR WENN) is refused, one that
// might is a warning, other chains switching the same devices are named.
//
// Runs: the edge part's run records (event `runs`, and gc.edge.call 'runs' for what was missed while the gateway
// was away) → rule_runs, the last 200 per gateway (migrations/004_rule_runs.sql). A run with result 'stopped' (the
// brake: more than 10 runs a minute) switches the chain off here and keeps why.

const store = require('./store');
const es = require('./edgestore');
const { codeError } = require('./deconz');

const SOURCE = 'edge';
const MAX_RULES = 40;                 // per gateway; the edge part takes 64
const MAX_STEPS = 20;
const MAX_PARTS = 20;
const MAX_CONFIG_BYTES = 36 * 1024;   // gc.edge.configure takes 48 KB, the device list comes on top
const MAX_RUNS = 200;                 // per gateway
const CH_RE = /^(switch|light|cover):(\d{1,2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MODES = ['ignore', 'reset', 'cancel'];
const RETRIGGER = ['restart', 'ignore', 'cancel'];
const BUTTON_EVENTS = ['single', 'double', 'triple', 'long'];
const RESULTS = ['running', 'ok', 'skip', 'partial', 'cancel', 'stopped', 'error'];
const EV_CODES = ['trig', 'manual', 'cond', 'act', 'ack', 'noack', 'fail', 'limit', 'wait', 'waited', 'restart', 'cancel', 'stop'];
const UID_RE = /^([A-Za-z0-9]{1,16}):(\d{1,12})$/;
const WHY_RE = /^[a-z0-9_:.-]{1,40}$/;

function invalid(detail) { return Object.assign(codeError('SMARTHOME_RULE_INVALID', `rule invalid: ${detail}`), { detail }); }

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const arr = (v) => (Array.isArray(v) ? v : []);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

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

/** The devices of one GateControl gateway: id → device (buttons are a device's, not a channel's). */
async function devicesOf(gc, gatewayId) {
  return new Map((await es.listDevices(gc, gatewayId)).map((d) => [d.id, d]));
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

function compileV1(id, d, byId) {
  const triggers = arr(d.triggers).map((t) => compileTrigger(t, byId));
  const actions = arr(d.actions).map((a) => compileAction(a, byId));
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

function compileWhen(t, byId, devById) {
  if (!isObj(t)) throw invalid('bad_trigger');
  if (t.kind === 'button') {
    const dev = devById.get(Number(t.deviceId));
    if (!dev) throw invalid('foreign_device');
    if (!Number.isInteger(t.input) || t.input < 0 || t.input > 7 || !BUTTON_EVENTS.includes(t.event)) throw invalid('bad_button_trigger');
    return { k: 'btn', base: dev.base, input: t.input, ev: t.event };
  }
  if (t.kind === 'time') {
    if (!TIME_RE.test(t.at)) throw invalid('bad_time_trigger');
    return { k: 'time', at: t.at };
  }
  if (t.kind === 'all') {
    const parts = arr(t.parts);
    if (!parts.length || parts.length > MAX_PARTS) throw invalid('bad_all_trigger');
    return { k: 'all', parts: parts.map((p) => compileTrigger(p, byId)) };
  }
  return { k: 'dev', ...compileTrigger(t, byId) };
}

function compileCond(c, byId) {
  if (!isObj(c)) throw invalid('bad_condition');
  if (c.kind === 'time') {
    if (!TIME_RE.test(c.from) || !TIME_RE.test(c.to)) throw invalid('bad_time_condition');
    return { k: 'time', from: c.from, to: c.to };
  }
  if (c.kind === 'days') {
    const days = arr(c.days);
    if (!days.length || days.length > 7 || !days.every((x) => Number.isInteger(x) && x >= 1 && x <= 7) || new Set(days).size !== days.length) throw invalid('bad_days_condition');
    return { k: 'days', days: [...days].sort((a, b) => a - b) };
  }
  if (c.kind === 'state' || c.kind === 'cover') return { k: 'dev', ...compileTrigger({ kind: c.kind, resourceId: c.resourceId, event: c.is }, byId) };
  return { k: 'dev', ...compileTrigger(c, byId) };
}

function compileStep(s, byId) {
  if (!isObj(s)) throw invalid('bad_step');
  if (s.kind === 'wait') {
    if (!Number.isInteger(s.seconds) || s.seconds < 1 || s.seconds > 86400) throw invalid('bad_wait');
    return { k: 'wait', s: s.seconds };
  }
  if (s.kind === 'action') return { k: 'act', ...compileAction(s, byId) };
  throw invalid('bad_step');
}

function compileV2(id, d, byId, devById) {
  const tl = arr(d.triggers);
  const cl = isObj(d.conditions) ? arr(d.conditions.list) : [];
  const sl = arr(d.steps);
  if (!tl.length) throw invalid('no_trigger');
  if (tl.length > MAX_PARTS || cl.length > MAX_PARTS) throw invalid('too_many');
  if (sl.length > MAX_STEPS) throw invalid('too_many_steps');
  const when = tl.map((t) => compileWhen(t, byId, devById));
  const list = cl.map((c) => compileCond(c, byId));
  const steps = sl.map((s) => compileStep(s, byId));
  if (!steps.some((s) => s.k === 'act')) throw invalid('no_action');
  const mode = isObj(d.conditions) && d.conditions.mode === 'any' ? 'any' : 'all';
  return { id, v: 2, when, cond: { mode, list }, steps, re: RETRIGGER.includes(d.retrigger) ? d.retrigger : 'restart' };
}

/** A stored definition → the rule the edge part runs (throws SMARTHOME_RULE_INVALID with a detail). */
function compileRule(id, def, byId, devById = new Map()) {
  const d = def && typeof def === 'object' ? def : {};
  if (d.version === 2) return compileV2(id, d, byId, devById);
  if (d.version != null) throw invalid('bad_version');
  return compileV1(id, d, byId);
}

/** A version 1 definition as the new editor shows it (version 2 as it is). */
function toV2(def) {
  const d = isObj(def) ? def : {};
  if (d.version === 2) return d;
  const tl = arr(d.triggers);
  const delay = isObj(d.delay) && d.delay.minutes ? d.delay : null;
  const retrigger = delay ? ({ ignore: 'ignore', reset: 'restart', cancel: 'cancel' }[delay.onRetrigger] || 'ignore') : 'restart';
  const list = [];
  // cancel of version 1: the pending run goes once the triggers no longer hold — they become NUR WENN
  if (retrigger === 'cancel') {
    for (const t of tl) {
      if (t.kind === 'state' || t.kind === 'cover') list.push({ kind: t.kind, resourceId: t.resourceId, is: t.event });
      else list.push({ kind: t.kind, resourceId: t.resourceId, op: t.op, value: t.value });
    }
  }
  if (isObj(d.timeWindow) && d.timeWindow.from && d.timeWindow.to) list.push({ kind: 'time', from: d.timeWindow.from, to: d.timeWindow.to });
  const steps = [];
  if (delay) steps.push({ kind: 'wait', seconds: delay.minutes * 60 });
  for (const a of arr(d.actions)) steps.push({ kind: 'action', resourceId: a.resourceId, set: a.set });
  return { version: 2, triggers: tl.length > 1 ? [{ kind: 'all', parts: tl }] : tl.slice(), conditions: { mode: 'all', list }, steps, retrigger };
}

/** The resources and devices a definition uses (for "Gerät fehlt"). */
function refsOf(def) {
  const d = isObj(def) ? def : {};
  const resources = [];
  const devices = [];
  const trig = (t) => {
    if (!isObj(t)) return;
    if (t.kind === 'button') devices.push(t.deviceId);
    else if (t.kind === 'all') arr(t.parts).forEach(trig);
    else if (t.resourceId != null) resources.push(t.resourceId);
  };
  arr(d.triggers).forEach(trig);
  arr(d.actions).forEach((a) => { if (isObj(a) && a.resourceId != null) resources.push(a.resourceId); });
  if (isObj(d.conditions)) arr(d.conditions.list).forEach((c) => { if (isObj(c) && c.resourceId != null) resources.push(c.resourceId); });
  arr(d.steps).forEach((s) => { if (isObj(s) && s.kind === 'action' && s.resourceId != null) resources.push(s.resourceId); });
  return { resources, devices };
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
  const devById = await devicesOf(gc, gatewayId);
  const out = [];
  for (const row of list) {
    if (!row.enabled) continue;
    try { out.push(compileRule(row.id, store.parseJson(row.definition_json), byId, devById)); } catch { /* a device is gone: the page shows it */ }
  }
  return { rules: out.slice(0, MAX_RULES), tz: timeZone() };
}

// ─── Loops ──────────────────────────────────────

const keyOf = (x) => `${x.base}|${x.ch}`;

/** What a compiled chain reacts to (device states) and what it switches. */
function chainIo(c) {
  const listens = [];
  let effects;
  let uncond;
  if (c.v === 2) {
    for (const w of c.when) {
      if (w.k === 'dev') listens.push({ ...w, single: true });
      if (w.k === 'all') for (const p of w.parts) listens.push({ ...p, single: w.parts.length === 1 });
    }
    effects = c.steps.filter((s) => s.k === 'act');
    uncond = !c.cond.list.length;
  } else {
    for (const t of c.triggers) listens.push({ ...t, single: c.triggers.length === 1 });
    effects = c.actions;
    uncond = !c.window;
  }
  return { id: c.id, listens, effects, uncond };
}

/** Does this command surely make that trigger true? */
function surely(e, l) {
  if (l.field === 'on') {
    if (e.op === 'on' || e.op === 'bri') return l.value === true;
    if (e.op === 'off') return l.value === false;
    return false;
  }
  if (l.field === 'pos') {
    if (e.op === 'open') return l.op === 'gt' && l.value < 100;
    if (e.op === 'close') return l.op === 'lt' && l.value > 0;
    if (e.op === 'pos') return l.op === 'gt' ? e.value > l.value : e.value < l.value;
  }
  return false;
}

const stateOf = (e) => (e.op === 'on' || e.op === 'bri' ? 'on' : e.op === 'off' ? 'off' : e.op === 'open' ? 'open' : e.op === 'close' ? 'close' : e.op === 'pos' ? `pos:${e.value}` : null);

/** A cycle swings for sure when every link is sure and some device is switched both ways in it. */
function swings(cycle, io) {
  const states = new Map();
  for (const id of cycle) {
    for (const e of io.get(id).effects) {
      const s = stateOf(e);
      if (!s) continue;
      if (!states.has(keyOf(e))) states.set(keyOf(e), new Set());
      states.get(keyOf(e)).add(s);
    }
  }
  return [...states.values()].some((set) => set.size > 1);
}

/**
 * The chain `compiled` (id 0 = a new one) among the other enabled chains of the gateway:
 * { loop: 'sure' | 'possible' | null, cycle: [id], shared: [{ key, ids }] }.
 */
function analyseCompiled(compiled, others) {
  const self = { ...compiled, id: compiled.id || 0 };
  const all = [self, ...others.filter((o) => o.id !== self.id)];
  const io = new Map(all.map((c) => [c.id, chainIo(c)]));
  const possible = new Map();
  const sure = new Map();
  for (const a of io.values()) {
    possible.set(a.id, []);
    sure.set(a.id, []);
    for (const b of io.values()) {
      if (a.id === b.id) continue;
      const hit = a.effects.some((e) => b.listens.some((l) => keyOf(e) === keyOf(l)));
      if (!hit) continue;
      possible.get(a.id).push(b.id);
      if (b.uncond && a.effects.some((e) => b.listens.some((l) => l.single && keyOf(e) === keyOf(l) && surely(e, l)))) sure.get(a.id).push(b.id);
    }
  }
  // sure: every simple cycle through this chain (small graphs; bounded)
  let budget = 5000;
  let sureCycle = null;
  const dfs = (node, path, seen) => {
    if (sureCycle || budget-- <= 0) return;
    for (const n of sure.get(node)) {
      if (n === self.id) { if (swings(path, io)) { sureCycle = path.slice(); return; } continue; }
      if (seen.has(n)) continue;
      seen.add(n); path.push(n);
      dfs(n, path, seen);
      path.pop(); seen.delete(n);
    }
  };
  dfs(self.id, [self.id], new Set([self.id]));
  let loop = null;
  let cycle = [];
  if (sureCycle) { loop = 'sure'; cycle = sureCycle; } else {
    // possible: the shortest way back to this chain
    const prev = new Map([[self.id, null]]);
    const queue = [self.id];
    let back = null;
    while (queue.length && back == null) {
      const n = queue.shift();
      for (const m of possible.get(n)) {
        if (m === self.id) { back = n; break; }
        if (!prev.has(m)) { prev.set(m, n); queue.push(m); }
      }
    }
    if (back != null) {
      loop = 'possible';
      for (let n = back; n != null; n = prev.get(n)) cycle.unshift(n);
    }
  }
  const shared = [];
  for (const e of io.get(self.id).effects) {
    const k = keyOf(e);
    if (shared.some((s) => s.key === k)) continue;
    const ids = [...io.values()].filter((o) => o.id !== self.id && o.effects.some((x) => keyOf(x) === k)).map((o) => o.id);
    if (ids.length) shared.push({ key: k, ids });
  }
  return { loop, cycle, shared };
}

/** The loop check of the page and of saving: names instead of ids and keys. */
async function analyse(gc, gatewayId, id, definition) {
  const byId = await resourcesOf(gc, gatewayId);
  const compiled = compileRule(id || 0, definition, byId, await devicesOf(gc, gatewayId));
  const others = (await configFor(gc, gatewayId)).rules.filter((r) => r.id !== id);
  const a = analyseCompiled(compiled, others);
  const names = new Map((await rows(gc, gatewayId)).map((r) => [r.id, r.name]));
  const resName = new Map();
  for (const { resource, device, ch } of byId.values()) resName.set(`${device.base}|${ch}`, resource.name || device.name);
  return {
    compiled,
    loop: a.loop,
    chains: a.cycle.filter((x) => x !== (id || 0)).map((x) => names.get(x) || `#${x}`),
    shared: a.shared.map((s) => ({ device: resName.get(s.key) || s.key.split('|')[0], chains: s.ids.map((x) => names.get(x) || `#${x}`) })),
  };
}

/** Would this definition fit? Checks the definition, the number of rules, the size of the list and loops. */
async function check(gc, gatewayId, id, definition) {
  const a = await analyse(gc, gatewayId, id, definition);
  const others = (await rows(gc, gatewayId)).filter((r) => r.id !== id);
  if (others.length >= MAX_RULES) throw codeError('SMARTHOME_EDGE_RULE_LIMIT', 'too many logic chains on this gateway');
  const rest = (await configFor(gc, gatewayId)).rules.filter((r) => r.id !== id);
  if (Buffer.byteLength(JSON.stringify([...rest, a.compiled])) > MAX_CONFIG_BYTES) throw codeError('SMARTHOME_EDGE_RULE_LIMIT', 'the logic chains of this gateway are too large');
  if (a.loop === 'sure') throw Object.assign(codeError('SMARTHOME_RULE_LOOP', 'the logic chain would switch back and forth'), { chains: a.chains });
  return a.compiled;
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

// ─── Runs ───────────────────────────────────────

function isoOf(v, now) {
  const ms = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? new Date(Math.min(ms, now)).toISOString() : null;
}

/** One run record of the edge part, checked (null: not one). */
function cleanRun(x, now = Date.now()) {
  if (!isObj(x) || typeof x.u !== 'string' || !UID_RE.test(x.u) || !Number.isSafeInteger(x.s) || x.s < 0 || !Number.isSafeInteger(x.r) || x.r <= 0) return null;
  if (!RESULTS.includes(x.res)) return null;
  const at = isoOf(x.at, now);
  if (!at) return null;
  const ev = [];
  for (const e of arr(x.ev).slice(0, 40)) {
    if (!Array.isArray(e) || !Number.isSafeInteger(e[0]) || e[0] < 0 || !EV_CODES.includes(e[1])) continue;
    const v = e[2];
    const arg = v == null ? undefined : (Number.isSafeInteger(v) ? v : (typeof v === 'string' && /^[A-Za-z0-9_:.-]{1,16}$/.test(v) ? v : undefined));
    ev.push(arg === undefined ? [Math.min(e[0], 7 * 86400000), e[1]] : [Math.min(e[0], 7 * 86400000), e[1], arg]);
  }
  return {
    uid: x.u, epoch: UID_RE.exec(x.u)[1], seq: x.s, rule: x.r, at, end: x.end == null ? null : isoOf(x.end, now),
    by: x.by === 'manual' ? 'manual' : 'event', tr: Number.isInteger(x.tr) && x.tr >= 0 && x.tr < 64 ? x.tr : null,
    res: x.res, why: typeof x.why === 'string' && WHY_RE.test(x.why) ? x.why : null, ev,
  };
}

/**
 * Run records of a gateway (live: event `runs`; late: pulled after the gateway was away) → rule_runs.
 * Returns true when a chain was stopped (the caller sends the gateway its new list).
 */
async function storeRuns(gc, gatewayId, list, { live = true, now = Date.now() } = {}) {
  const gw = Number(gatewayId);
  const chains = new Map((await rows(gc, gw)).map((r) => [r.id, r]));
  let stopped = false;
  let changed = false;
  for (const raw of arr(list).slice(0, 64)) {
    const r = cleanRun(raw, now);
    const rule = r && chains.get(r.rule);
    if (!rule) continue;
    const before = (await gc.db.get('SELECT seq, result FROM rule_runs WHERE gateway_id = ? AND uid = ?', [gw, r.uid])).row;
    if (before && before.seq >= r.seq) continue;
    const detail = JSON.stringify({ by: r.by, tr: r.tr, ev: r.ev });
    await gc.db.run(`INSERT INTO rule_runs (gateway_id, rule_id, uid, epoch, seq, started_at, finished_at, result, reason, detail_json, late)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(gateway_id, uid) DO UPDATE SET seq = excluded.seq, finished_at = excluded.finished_at, result = excluded.result,
        reason = excluded.reason, detail_json = excluded.detail_json, late = MAX(rule_runs.late, excluded.late)`,
    [gw, r.rule, r.uid, r.epoch, r.seq, r.at, r.end, r.res, r.why, detail, live ? 0 : 1]);
    changed = true;
    // the brake of the edge part: the chain is switched off here, with why — unless it was started again since
    if (r.res === 'stopped' && (!before || before.result !== 'stopped') && rule.enabled && !(rule.resumed_at && rule.resumed_at >= r.at)) {
      await gc.db.run("UPDATE rules SET enabled = 0, stopped_at = ?, stopped_reason = ? WHERE id = ? AND source = 'edge'", [r.end || r.at, r.why || 'rate', rule.id]);
      rule.enabled = 0;
      stopped = true;
    }
  }
  if (changed) {
    await gc.db.run('DELETE FROM rule_runs WHERE gateway_id = ? AND id NOT IN (SELECT id FROM rule_runs WHERE gateway_id = ? ORDER BY started_at DESC, id DESC LIMIT ?)', [gw, gw, MAX_RUNS]);
  }
  return stopped;
}

/** What the gateway's edge part kept while the server part did not hear it (after $online / $started). */
async function pullRuns(gc, gatewayId, { pages = 10 } = {}) {
  const gw = Number(gatewayId);
  const last = (await gc.db.get('SELECT epoch, MAX(seq) AS seq FROM rule_runs WHERE gateway_id = ? GROUP BY epoch ORDER BY MAX(id) DESC LIMIT 1', [gw])).row;
  let epoch = last ? last.epoch : null;
  let after = last ? Number(last.seq) || 0 : 0;
  let stopped = false;
  for (let i = 0; i < pages; i++) {
    let res;
    try { res = await gc.edge.call(gw, 'runs', { epoch, after }, { timeoutMs: 5000 }); } catch { break; } // an older edge part, or away
    if (!res || typeof res.epoch !== 'string' || !Array.isArray(res.runs)) break;
    if (res.epoch !== epoch) { epoch = res.epoch; after = 0; }
    if (await storeRuns(gc, gw, res.runs, { live: false })) stopped = true;
    for (const x of res.runs) if (x && Number.isSafeInteger(x.s) && x.s > after) after = x.s;
    if (!res.more || !res.runs.length) break;
  }
  return stopped;
}

/** The protocol of the page: newest first. */
async function listRuns(gc, { gatewayId = null, ruleId = null, problems = false } = {}) {
  const where = [];
  const params = [];
  if (gatewayId) { where.push('gateway_id = ?'); params.push(Number(gatewayId)); }
  if (ruleId) { where.push('rule_id = ?'); params.push(Number(ruleId)); }
  if (problems) where.push("result IN ('partial', 'cancel', 'stopped', 'error')");
  const sql = `SELECT * FROM rule_runs${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY started_at DESC, id DESC LIMIT ?`;
  const list = (await gc.db.query(sql, [...params, MAX_RUNS])).rows;
  return list.map((r) => {
    const d = store.parseJson(r.detail_json) || {};
    return {
      uid: r.uid, gateway_id: r.gateway_id, rule_id: r.rule_id, at: r.started_at, end: r.finished_at || null, result: r.result, reason: r.reason || null,
      by: d.by === 'manual' ? 'manual' : 'event', trigger: Number.isInteger(d.tr) ? d.tr : null, ev: Array.isArray(d.ev) ? d.ev : [], late: !!r.late,
    };
  });
}

/** Runs per chain since local midnight (not the skipped ones): "heute 4×". */
async function runsToday(gc, gatewayId, now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const list = (await gc.db.query("SELECT rule_id, COUNT(*) AS n FROM rule_runs WHERE gateway_id = ? AND started_at >= ? AND result != 'skip' GROUP BY rule_id", [Number(gatewayId), d.toISOString()])).rows;
  return new Map(list.map((r) => [r.rule_id, Number(r.n)]));
}

module.exports = {
  SOURCE, MAX_RULES, MAX_STEPS, resourcesOf, devicesOf, compileRule, toV2, refsOf, configFor, check, analyse, analyseCompiled, markFired, timeZone,
  cleanRun, storeRuns, pullRuns, listRuns, runsToday,
};
