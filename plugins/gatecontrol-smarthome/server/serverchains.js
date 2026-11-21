'use strict';

// Logic chains that run on the server (since 1.12.0, rules.source 'server', gateway_id 0): devices of several
// gateways, or of a deCONZ gateway together with others — "läuft am Server". They run in this process with the same
// engine as the edge part on a gateway (edge/rules.js), on the cached states of the resources:
//
//   devices   every resource a chain uses is a "device" res/<resource id> with one channel (switch:0, light:0,
//             cover:0 — an edge channel keeps its own key —, sensor, scene); its state is what the plugin caches
//             (Shelly / Tasmota: the edge part's bundle every 2 s, zigbee2mqtt: GateControl's report, deCONZ: the
//             polling interval). refresh() reads them every 2 s and tells the engine what changed — so such a chain
//             reacts with a delay of 2–3 s (deCONZ: the polling interval), and not at all while the server is away
//             or a gateway is not connected.
//   actions   service.setResourceState — the way the page switches (io.act of the engine).
//   runs      as on a gateway: run records → rule_runs with gateway_id 0 (server/edgerules.js storeRuns), the brake
//             (more than 10 runs a minute) switches a chain off here too.
//   notes     a step "Mitteilung senden" → the plugin's notifier (topic `chains`) — sendNote is also the way of the
//             chains on a gateway (event `notify` of the edge part, server/edge.js).
//
//   start(gc) / stop()      the engine and its timer (index.js start / stop)
//   reload(gc)              the chains changed (server/rules.js)
//   refresh(gc)             the cached states (also after a bundle of an edge part)
//   test(gc, spec, opts)    Testlauf / "Trotzdem ausführen" / a quick action of the apps (opts.by 'app')

const crypto = require('node:crypto');
const engineLib = require('../edge/rules');
const store = require('./store');
const edgerules = require('./edgerules');
const alerts = require('./alerts');
const notify = require('./notify');
const { codeError } = require('./deconz');

const REFRESH_MS = 2000;
const SEEN_MAX = 500;
const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const st = {
  gc: null,
  engine: null,
  timer: null,
  bases: new Map(),     // base → { id, ch }
  cache: new Map(),     // base → JSON of the device as last told
  devices: new Map(),   // base → device record (as edge/normalize.js keeps one)
  epoch: null,
  n: 0,
  seq: 0,
  queue: Promise.resolve(),
  busy: null,
  seenNotes: [],
};

/** A resource as the engine reads a device: { family, ch: { <ch>: { on, bri, pos, moving, power } }, sensor }. */
function deviceOf(r, ch) {
  const s = (r && r.state) || {};
  const dev = { base: `res/${r.id}`, family: 'res', online: s.reachable === false ? false : null, ch: {}, sensor: {} };
  if (ch === 'sensor') {
    if (typeof s.type === 'string' && s.value !== undefined && s.value !== null) dev.sensor[r.kind === 'thermostat' ? 'temperature' : s.type] = s.value;
    if (finite(s.humidity) != null) dev.sensor.humidity = s.humidity;
    if (finite(s.battery) != null) dev.sensor.battery = s.battery;
    return dev;
  }
  if (ch === 'scene') return dev;
  const c = {};
  if (typeof s.on === 'boolean') c.on = s.on;
  if (finite(s.bri) != null) c.bri = s.bri;
  if (s.pos !== undefined) c.pos = finite(s.pos);
  if (s.moving !== undefined) c.moving = s.moving === 'opening' || s.moving === 'closing' ? s.moving : null;
  if (finite(s.power) != null) c.power = s.power;
  dev.ch[ch] = c;
  return dev;
}

/** The resources the compiled chains use: base → { id, ch }. */
function basesOf(rules) {
  const out = new Map();
  const add = (x) => {
    const m = x && typeof x.base === 'string' ? /^res\/(\d+)$/.exec(x.base) : null;
    if (m) out.set(x.base, { id: Number(m[1]), ch: x.ch });
  };
  for (const c of rules) {
    for (const w of c.when || []) { add(w); if (w.k === 'all') w.parts.forEach(add); }
    for (const x of (c.cond && c.cond.list) || []) add(x);
    for (const x of c.steps || []) add(x);
  }
  return out;
}

/** Read the cached states; changed ones go to the engine (quiet: only remember them — before a new list). */
async function readDevices(gc, quiet) {
  if (!st.bases.size) return 0;
  const ids = [...new Set([...st.bases.values()].map((b) => b.id))];
  const rows = (await gc.db.query(`SELECT * FROM resources WHERE id IN (${ids.map(() => '?').join(',')})`, ids)).rows;
  const byId = new Map(rows.map((row) => [row.id, { ...row, state: store.parseJson(row.state_json) || {} }]));
  const changed = [];
  for (const [base, b] of st.bases) {
    const r = byId.get(b.id);
    if (!r) { if (st.devices.delete(base)) changed.push(base); st.cache.delete(base); continue; }
    const dev = deviceOf(r, b.ch);
    const key = JSON.stringify(dev);
    if (st.cache.get(base) === key) continue;
    st.cache.set(base, key);
    st.devices.set(base, dev);
    changed.push(base);
  }
  if (!quiet && st.engine) for (const base of changed) st.engine.onDevice(base);
  return changed.length;
}

function serial(fn) {
  const p = st.queue.then(fn, fn);
  st.queue = p.catch(() => null);
  return p;
}

async function refresh(gc) {
  if (!st.engine || st.gc !== gc || !st.bases.size) return 0;
  return serial(() => readDevices(gc, false));
}

async function reload(gc) {
  if (!st.engine || st.gc !== gc) return 0;
  return serial(async () => {
    const cfg = await edgerules.configFor(gc, 0);
    st.bases = basesOf(cfg.rules);
    for (const base of [...st.devices.keys()]) if (!st.bases.has(base)) { st.devices.delete(base); st.cache.delete(base); }
    await readDevices(gc, true);
    return st.engine.set({ rules: cfg.rules, tz: cfg.tz, sun: cfg.sun });
  });
}

/** The patch of service.setResourceState for one step of a chain. */
function patchOf(s) {
  if (s.op === 'on' || s.op === 'off') return { on: s.op === 'on' };
  if (s.op === 'bri') return { bri: s.value, on: true };
  if (s.op === 'open' || s.op === 'close' || s.op === 'stop') return { cover: s.op };
  if (s.op === 'pos') return { pos: s.value };
  return {}; // a scene
}

function record(gc, run) {
  run.s = ++st.seq;
  serial(async () => {
    if (st.gc !== gc) return;
    if (await edgerules.storeRuns(gc, 0, [run])) await reloadLater(gc);
  }).catch((e) => gc.log.warn('server chain run not kept', (e && (e.code || e.message)) || e));
}

function reloadLater(gc) { setImmediate(() => { reload(gc).catch(() => null); }); }

// ─── Notifications (both places) ────────────────

/** A step "Mitteilung senden" of a chain ran: { r: chain id, i: step, at, u: run } → the notification. */
async function sendNote(gc, gatewayId, note) {
  const n = note && typeof note === 'object' ? note : {};
  if (!Number.isSafeInteger(n.r) || !Number.isInteger(n.i) || n.i < 0) return false;
  const key = `${gatewayId}:${n.u}:${n.i}`;
  if (typeof n.u === 'string' && st.seenNotes.includes(key)) return false; // an event that came twice
  const row = (await gc.db.get('SELECT * FROM rules WHERE id = ?', [n.r])).row;
  const server = edgerules.isServer(gatewayId);
  if (!row || (server ? row.source !== 'server' : (row.source !== 'edge' || row.gateway_id !== Number(gatewayId)))) return false;
  const def = store.parseJson(row.definition_json) || {};
  const step = Array.isArray(def.steps) ? def.steps[n.i] : null;
  if (!step || step.kind !== 'notify' || typeof step.text !== 'string' || !step.text.trim()) return false;
  if (typeof n.u === 'string') { st.seenNotes.push(key); if (st.seenNotes.length > SEEN_MAX) st.seenNotes.splice(0, st.seenNotes.length - SEEN_MAX); }
  let users = null;
  if (Array.isArray(step.users) && step.users.length) {
    const known = new Set((await gc.users.list().catch(() => [])).map((u) => u.id));
    users = step.users.filter((u) => known.has(u));
    if (!users.length) return false; // everybody it was for is gone: nobody else gets it
  }
  const open = notify.openAction(gc, 'de');
  const r = await alerts.notifierFor(gc).send({
    topic: 'chains', title: String(row.name || '').slice(0, 120) || 'Smart Home', body: step.text.replace(/[\0-\x1f\x7f]/g, ' ').trim().slice(0, 200),
    priority: 'normal', users, collapseKey: `chain:${row.id}:${n.i}`, data: { route: open.route },
  });
  return !!r.sent;
}

// ─── Lifecycle ──────────────────────────────────

function start(gc) {
  stop();
  st.gc = gc;
  st.epoch = crypto.randomBytes(6).toString('hex');
  st.n = 0;
  st.seq = 0;
  st.queue = Promise.resolve();
  st.seenNotes = [];
  st.engine = engineLib.create({
    device: (base) => st.devices.get(base) || null,
    publish: async () => { throw codeError('SMARTHOME_NOT_CONTROLLABLE'); },
    act: async (s) => {
      const m = /^res\/(\d+)$/.exec(s.base);
      if (!m) throw codeError('SMARTHOME_RESOURCE_NOT_FOUND');
      await require('./service').setResourceState(gc, Number(m[1]), patchOf(s));
      // the cached state followed what was sent: the next refresh tells the engine
      setImmediate(() => { refresh(gc).catch(() => null); });
    },
    notify: (note) => { sendNote(gc, 0, note).catch((e) => gc.log.warn('chain notification failed', (e && (e.code || e.message)) || e)); return true; },
    fired: (id, at) => { edgerules.markFired(gc, 0, { rules: [{ id, at }] }).catch(() => null); },
    record: (run) => record(gc, run),
    runId: () => `${st.epoch}:${++st.n}`,
    log: gc.log,
  });
  st.timer = setInterval(() => { refresh(gc).catch((e) => gc.log.debug('server chains refresh failed', (e && (e.code || e.message)) || e)); }, REFRESH_MS);
  if (st.timer.unref) st.timer.unref();
  return reload(gc).catch((e) => gc.log.warn('server chains not loaded', (e && (e.code || e.message)) || e));
}

function stop() {
  if (st.timer) clearInterval(st.timer);
  st.timer = null;
  if (st.engine) st.engine.stop();
  st.engine = null;
  st.gc = null;
  st.bases = new Map();
  st.cache = new Map();
  st.devices = new Map();
}

/** Testlauf of a server chain ({ id } or a compiled draft { rule }); run: by hand ('manual') or from the apps ('app'). */
async function test(gc, spec, opts = {}) {
  if (!st.engine || st.gc !== gc) throw codeError('SMARTHOME_EDGE_UNAVAILABLE');
  await st.queue;
  if (spec.rule) {
    // a draft: its devices are read for this one look
    const extra = basesOf([spec.rule]);
    for (const [base, b] of extra) {
      if (st.devices.has(base)) continue;
      const r = await store.getResource(gc, b.id);
      if (r) st.devices.set(base, deviceOf(r, b.ch));
    }
  }
  try {
    return st.engine.test(spec, opts);
  } catch (e) {
    if (e && e.code === 'stopped') throw codeError('SMARTHOME_RULE_STOPPED');
    if (e && e.code === 'not_found') throw codeError('SMARTHOME_EDGE_RULE_PENDING');
    if (e && e.code === 'not_manual') throw codeError('SMARTHOME_RULE_NOT_FOUND');
    throw codeError('SMARTHOME_RULE_INVALID', (e && e.code) || 'invalid');
  }
}

module.exports = { start, stop, reload, refresh, test, sendNote, deviceOf, patchOf, _st: st };
