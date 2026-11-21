'use strict';

// gatecontrol-smarthome — the edge part. It runs on a GateControl gateway in the home network (the gateway's
// container `edge`) once an administrator switched "Smart Home" on for that gateway (GateControl: the gateway ›
// "Edge-Plugins") and the gateway's MQTT broker is on. It brings Shelly and Tasmota devices to the server part:
//
//   find      mDNS _shelly._tcp / _http._tcp (host names shelly…, tasmota…), then GET /shelly or
//             cm?cmnd=Status 0 → event `found` { devices: [candidate] }
//   report    MQTT shellies/# and tasmota/# of the gateway's broker → one normalised state per device
//             (edge/normalize.js), sent bundled every 2 s for the devices the server part configured
//             (gc.edge.configure { devices: [{ base, family }] }) → event `states` { devices: [snapshot] }
//   control   gc.handle('command', { base, family, ch, op, value }) → MQTT (edge/commands.js)
//   set up    gc.handle('probe', { ip }) / gc.handle('setup', { ip, family, user, pass, prefix, password?, httpUser? })
//             write the MQTT settings into a device over HTTP (edge/devices.js) — the device password is used
//             for that one request, never stored, never logged
//   info      gc.handle('info') → { version, startedAt, mqtt, lan, devices, found }
//   refresh   gc.handle('refresh') → every configured device reports its whole state, discovery starts over
//   rules     the logic chains of this gateway's devices (gc.edge.configure { rules, tz }) run here (edge/rules.js):
//             a device's message or a button press → the chains it triggers → MQTT; event `fired` { rules: [{ id, at }] }
//   runs      what the chains did (since 1.11.0): the last 200 runs in a ring (gc.store `runs`, written at most once
//             a minute), event `runs` { runs: [run] } with the next bundle; gc.handle('runs', { epoch, after }) →
//             { epoch, runs, more } — what the server part missed while it was away (seq after `after`, 40 a call)
//   test      gc.handle('test', { id } | { rule }, run?, by?) → what a chain would do now (edge/rules.js test); by
//             'app': its trigger "Von Hand (App)" (a quick action of the apps, NUR WENN checked)
//   zigbee2mqtt (since 1.12.0, logic chains only): MQTT zigbee2mqtt/# of the gateway's own zigbee2mqtt — the devices
//             the server part lists (gc.edge.configure { z2m: [{ ieee, kind, chs, name }] }); their names from
//             zigbee2mqtt/bridge/devices (the server's name until that came), states via normalize.parseZ2m, commands
//             to zigbee2mqtt/<name>/set. Best effort: without the capability (not confirmed yet) Shelly and Tasmota
//             go on as before.
//   notes     a step "Mitteilung senden" (since 1.12.0): event `notify` { notes: [{ r, i, at, u }] } — the server part
//             sends the notification (the gateway keeps events up to an hour while the server is away)
//   sun       gc.edge.configure { sun: { lat, lon } } — sunrise and sunset of the chains, computed here (edge/sun.js)
//
// Capabilities (plugin.json edge.capabilities): mdns _shelly._tcp and _http._tcp, http.lan, mqtt shellies/#,
// tasmota/# and (since 1.12.0) zigbee2mqtt/#. On disk (gc.store) only the last list of logic chains, so they run after a restart of the gateway
// while the server is away, and the last runs of the chains — no device password, no MQTT password.

const os = require('node:os');
const crypto = require('node:crypto');
const normalize = require('./normalize');
const commands = require('./commands');
const devices = require('./devices');
const rules = require('./rules');

const FLUSH_MS = 2000;
const REFRESH_MS = 10 * 60 * 1000;
const RETRY_MQTT_MS = 60 * 1000;
const PROBE_GAP_MS = 1000;
const REPROBE_MS = 30 * 60 * 1000;
const MAX_DEVICES = 256;
const MAX_FOUND = 64;
const PER_EVENT = 20;
const TOPICS = ['shellies/#', 'tasmota/#'];
const Z2M_TOPIC = 'zigbee2mqtt/#';
const Z2M_MAX = 128;
const Z2M_LIST_BYTES = 2 * 1024 * 1024;
const Z2M_IEEE_RE = /^0x[0-9a-f]{16}$/;
const Z2M_KINDS = ['light', 'plug', 'cover', 'sensor', 'switch'];
const SERVICES = ['_shelly._tcp', '_http._tcp'];
const RULES_KEY = 'rules';
const RUNS_KEY = 'runs';
const MAX_RUNS = 200;
const RUNS_PAGE = 40;
const RUNS_PER_EVENT = 10;
const RUNS_SAVE_MS = 60 * 1000;
const UID_RE = /^[A-Za-z0-9]{1,16}:\d{1,12}$/;

const st = {
  gc: null,
  startedAt: null,
  mqtt: 'starting',          // starting | ok | off (the gateway's broker is off) | error
  subscribing: null,
  subs: [],
  devices: new Map(),        // base → device record (normalize.newDevice)
  configured: null,          // null until the server part sent its list; then Map base → family
  dirty: new Set(),
  found: new Map(),          // ip → candidate
  probedAt: new Map(),       // ip → ms
  queue: [],
  probing: false,
  browses: [],
  timers: [],
  warned: new Set(),
  engine: null,              // edge/rules.js
  rulesKey: null,            // the list the engine runs (JSON)
  rulesFromServer: false,    // the server part sent its list (the stored one is no longer needed)
  stored: null,              // promise chain of the gc.store reads and writes
  storedKey: null,           // what gc.store holds (JSON)
  fired: [],                 // { id, at } for the next flush
  runs: null,                // { epoch, seq, n, list: [run] } — the ring of the last runs (gc.store `runs`)
  runsOut: [],               // runs for the next flush
  runsDirty: false,          // the ring changed since it was last written
  stoppedKey: '[]',          // the chains the brake stopped, as last written
  presses: new Map(),        // base → { input → event_cnt } (Shelly Gen1 repeats a press with the same counter)
  z2m: new Map(),            // ieee → { kind, chs, name } — the zigbee2mqtt devices of the chains (server part's list)
  z2mNames: new Map(),       // friendly name → ieee (zigbee2mqtt/bridge/devices; else the server part's names)
  z2mSub: null,              // the subscription of zigbee2mqtt/#
  notes: [],                 // { r, i, at, u } for the next flush
};

/** For tests: where the gateway's network interfaces come from. */
const hooks = { interfaces: () => os.networkInterfaces() };

function warnOnce(key, ...line) {
  if (st.warned.has(key)) return;
  st.warned.add(key);
  st.gc.log.warn(...line);
}

function lan() {
  try { return devices.lanAddresses(hooks.interfaces()); } catch { return []; }
}

// ─── MQTT ───────────────────────────────────────

// ─── zigbee2mqtt (the logic chains) ─────────────

const z2mBase = (ieee) => `zigbee2mqtt/${ieee}`;

/** The friendly name of a device of the chains (commands go to zigbee2mqtt/<name>/set). */
function z2mTopic(base) {
  const ieee = String(base || '').slice('zigbee2mqtt/'.length);
  for (const [name, id] of st.z2mNames) if (id === ieee) return name;
  const d = st.z2m.get(ieee);
  return d && d.name ? d.name : null;
}

/** zigbee2mqtt/bridge/devices (retained, a list of every device): friendly name ↔ IEEE address. */
function onBridgeDevices(payload) {
  if (!payload || payload.length > Z2M_LIST_BYTES) return;
  let list;
  try { list = JSON.parse(Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload)); } catch { return; }
  if (!Array.isArray(list)) return;
  const names = new Map();
  for (const d of list.slice(0, 512)) {
    if (!d || typeof d.ieee_address !== 'string' || !Z2M_IEEE_RE.test(d.ieee_address) || typeof d.friendly_name !== 'string') continue;
    if (d.friendly_name && d.friendly_name.length <= 128) names.set(d.friendly_name, d.ieee_address);
  }
  st.z2mNames = names;
}

function onZ2m(topic, payload, meta) {
  const rest = topic.slice('zigbee2mqtt/'.length);
  if (rest === 'bridge/devices') { onBridgeDevices(payload); return; }
  if (rest.startsWith('bridge/') || !st.z2m.size) return;
  const name = rest;
  if (/\/(set|get|availability)(\/.*)?$/.test(name) && !st.z2mNames.has(name)) return; // our commands, zigbee2mqtt's extras
  let ieee = st.z2mNames.get(name);
  if (!ieee) { for (const [id, d] of st.z2m) if (d.name === name) { ieee = id; break; } }
  const info = ieee && st.z2m.get(ieee);
  if (!info) return;
  const r = normalize.parseZ2m(z2mBase(ieee), payload, info);
  if (!r) return;
  let dev = st.devices.get(r.base);
  if (!dev) {
    if (st.devices.size >= MAX_DEVICES) return;
    dev = normalize.newDevice(r.base, 'z2m');
    st.devices.set(r.base, dev);
  }
  normalize.apply(dev, r.patch);
  dev.seenAt = new Date().toISOString();
  if (st.engine) st.engine.onDevice(r.base);
  if (r.events && st.engine && !(meta && meta.retain)) st.engine.onEvent(r.base, r.events);
}

/** zigbee2mqtt/# only while the server part lists such devices; a refused topic (not confirmed yet) is no error. */
async function subscribeZ2m() {
  if (st.mqtt !== 'ok') return;
  if (!st.z2m.size) {
    if (st.z2mSub && typeof st.z2mSub === 'object') st.z2mSub.unsubscribe().catch(() => null);
    st.z2mSub = null;
    return;
  }
  if (st.z2mSub) return;
  st.z2mSub = 'pending';
  const gc = st.gc;
  try {
    const sub = await gc.mqtt.subscribe(Z2M_TOPIC, onMessage);
    if (st.gc !== gc || st.z2mSub !== 'pending') { sub.unsubscribe().catch(() => null); return; }
    st.z2mSub = sub;
  } catch (e) {
    if (st.gc !== gc) return;
    st.z2mSub = null;
    warnOnce('z2m:' + ((e && e.code) || 'error'), `zigbee2mqtt for the logic chains not available (${(e && e.code) || 'error'}) — confirm the new capability zigbee2mqtt/# for this gateway in GateControl`);
  }
}

function onZ2mConfig(list) {
  const next = new Map();
  for (const d of (Array.isArray(list) ? list : []).slice(0, Z2M_MAX)) {
    if (!d || typeof d.ieee !== 'string' || !Z2M_IEEE_RE.test(d.ieee) || !Z2M_KINDS.includes(d.kind)) continue;
    const chs = Array.isArray(d.chs) ? d.chs.filter((c) => typeof c === 'string' && /^[a-z0-9_]{1,8}$/.test(c)).slice(0, 8) : null;
    next.set(d.ieee, { kind: d.kind === 'switch' ? 'sensor' : d.kind, chs: chs && chs.length >= 2 ? chs : null, name: typeof d.name === 'string' && d.name.length <= 128 ? d.name : null });
  }
  st.z2m = next;
  subscribeZ2m();
}

function onMessage(topic, payload, meta) {
  if (typeof topic === 'string' && topic.startsWith('zigbee2mqtt/')) { onZ2m(topic, payload, meta); return; }
  const r = normalize.parse(topic, payload);
  if (!r) return;
  let dev = st.devices.get(r.base);
  if (!dev) {
    if (st.devices.size >= MAX_DEVICES) return;
    dev = normalize.newDevice(r.base, r.family);
    st.devices.set(r.base, dev);
  }
  if (r.family && dev.family !== r.family) dev.family = r.family;
  normalize.apply(dev, r.patch);
  dev.seenAt = new Date().toISOString();
  if (st.configured && st.configured.has(r.base)) st.dirty.add(r.base);
  if (st.engine) st.engine.onDevice(r.base);
  // a button press is an event for the chains, never a state; a retained one is an old press
  if (r.events && st.engine && !(meta && meta.retain)) {
    const seen = st.presses.get(r.base) || {};
    const fresh = r.events.filter((e) => {
      if (e.cnt == null) return true;
      const dup = seen[e.input] === e.cnt;
      seen[e.input] = e.cnt;
      return !dup;
    });
    if (st.presses.size < MAX_DEVICES) st.presses.set(r.base, seen);
    if (fresh.length) st.engine.onEvent(r.base, fresh);
  }
}

function subscribe() {
  if (st.mqtt === 'ok') return Promise.resolve();
  if (!st.subscribing) st.subscribing = doSubscribe().finally(() => { st.subscribing = null; });
  return st.subscribing;
}

async function doSubscribe() {
  for (const s of st.subs.splice(0)) s.unsubscribe().catch(() => null);
  try {
    for (const t of TOPICS) st.subs.push(await st.gc.mqtt.subscribe(t, onMessage));
    st.mqtt = 'ok';
    st.warned.delete('mqtt:off');
    st.warned.delete('mqtt:error');
    st.gc.log.info('subscribed to', TOPICS.join(', '));
    if (st.z2mSub && typeof st.z2mSub === 'object') st.z2mSub.unsubscribe().catch(() => null);
    st.z2mSub = null;
    subscribeZ2m();
    refreshAll();
  } catch (e) {
    for (const s of st.subs.splice(0)) s.unsubscribe().catch(() => null);
    st.mqtt = e && e.code === 'not_enabled' ? 'off' : 'error';
    warnOnce('mqtt:' + st.mqtt, st.mqtt === 'off' ? 'MQTT is not switched on for this gateway yet — switch on the MQTT broker in GateControl (Gateways › this gateway › MQTT); Smart Home then connects by itself within a minute' : `MQTT subscribe failed (${(e && e.code) || 'error'}) — retrying every minute`);
  }
}

async function publishAll(list) {
  let n = 0;
  for (const m of list) {
    await st.gc.mqtt.publish(m.topic, m.payload, { qos: 0, retain: false });
    n++;
  }
  return n;
}

function refreshDevice(base, family) {
  if (st.mqtt !== 'ok') return;
  publishAll(commands.refresh({ base, family })).catch(() => null);
}

function refreshAll() {
  if (!st.configured) return;
  for (const [base, family] of st.configured) refreshDevice(base, family);
}

function flush() {
  if (st.fired.length) st.gc.emit('fired', { rules: st.fired.splice(0, PER_EVENT) });
  if (st.notes.length) st.gc.emit('notify', { notes: st.notes.splice(0, PER_EVENT) });
  if (st.runsOut.length) st.gc.emit('runs', { runs: st.runsOut.splice(0, RUNS_PER_EVENT) });
  if (!st.dirty.size || !st.configured) return;
  const out = [];
  for (const base of st.dirty) {
    const dev = st.devices.get(base);
    if (!dev || !st.configured.has(base)) continue;
    out.push({ ...normalize.snapshot(dev), seenAt: dev.seenAt || null });
    dev.drop = [];
  }
  st.dirty.clear();
  for (let i = 0; i < out.length; i += PER_EVENT) st.gc.emit('states', { devices: out.slice(i, i + PER_EVENT) });
}

function onConfig(cfg) {
  const list = cfg && Array.isArray(cfg.devices) ? cfg.devices : [];
  const next = new Map();
  for (const d of list.slice(0, MAX_DEVICES)) {
    if (d && typeof d.base === 'string' && commands.BASE_RE.test(d.base) && ['shelly1', 'shelly2', 'tasmota'].includes(d.family)) next.set(d.base, d.family);
  }
  const before = st.configured || new Map();
  st.configured = next;
  for (const [base, family] of next) {
    if (st.devices.has(base)) st.dirty.add(base);          // what we already know goes out with the next flush
    if (!before.has(base) || before.get(base) !== family) refreshDevice(base, family);
  }
  // forget what is no longer configured and has not reported for a while
  for (const base of [...st.devices.keys()]) if (!next.has(base) && st.devices.size > MAX_DEVICES / 2) st.devices.delete(base);
  onZ2mConfig(cfg && cfg.z2m);
  // the server part's list is the truth (an older server part sends none: no chains)
  setRules({ rules: cfg && cfg.rules, tz: cfg && cfg.tz, sun: cfg && cfg.sun }, true);
}

// ─── Logic chains ───────────────────────────────

const EMPTY_RULES = JSON.stringify({ rules: [], tz: null });

function cleanSun(v) {
  return v && typeof v === 'object' && Number.isFinite(v.lat) && Number.isFinite(v.lon) ? { lat: v.lat, lon: v.lon } : null;
}

/** Hand a list to the engine; the server part's list is kept in gc.store (written only when it differs from what is there). */
function setRules(cfg, fromServer) {
  if (!st.engine) return;
  const rl = Array.isArray(cfg.rules) ? cfg.rules.slice(0, rules.MAX_RULES) : [];
  const sunAt = rl.length ? cleanSun(cfg.sun) : null;
  const list = { rules: rl, tz: rl.length && typeof cfg.tz === 'string' ? cfg.tz : null, ...(sunAt ? { sun: sunAt } : {}) };
  const key = JSON.stringify(list);
  if (fromServer) st.rulesFromServer = true;
  if (key !== st.rulesKey) {
    st.rulesKey = key;
    st.engine.set(list);
  }
  if (!fromServer || !st.gc.store) return;
  const gc = st.gc;
  st.stored = (st.stored || Promise.resolve()).then(async () => {
    if (st.gc !== gc || key === st.storedKey) return;
    await gc.store.set(RULES_KEY, list);
    st.storedKey = key;
  }).catch(() => warnOnce('store', 'the logic chains could not be kept for a restart of the gateway'));
}

/** After a restart: the last list, until the server part sends its own; the ring of runs and what was stopped. */
function restoreRules() {
  if (!st.gc.store) return;
  const gc = st.gc;
  st.stored = Promise.resolve().then(async () => {
    const runs = await gc.store.get(RUNS_KEY).catch(() => null);
    if (st.gc !== gc) return;
    restoreRuns(runs);
    const v = await gc.store.get(RULES_KEY);
    if (st.gc !== gc) return;
    const ok = v && typeof v === 'object' && Array.isArray(v.rules);
    st.storedKey = ok ? JSON.stringify({ rules: v.rules, tz: typeof v.tz === 'string' ? v.tz : null, ...(cleanSun(v.sun) ? { sun: cleanSun(v.sun) } : {}) }) : EMPTY_RULES;
    if (ok && !st.rulesFromServer) setRules(v, false);
    if (runs && Array.isArray(runs.stopped) && st.engine) st.engine.restoreStopped(runs.stopped);
    st.stoppedKey = JSON.stringify(st.engine ? st.engine.stoppedList() : []);
  }).catch(() => null);
}

// ─── Runs (the protocol of the chains) ──────────

function newEpoch() { return crypto.randomBytes(6).toString('hex'); }

function restoreRuns(v) {
  const ok = v && typeof v === 'object' && typeof v.epoch === 'string' && /^[A-Za-z0-9]{1,16}$/.test(v.epoch) && Array.isArray(v.list);
  if (!ok) return;
  // a run of the store that had not finished before the restart did not finish: it was cut off
  const list = v.list.filter((r) => r && typeof r === 'object' && UID_RE.test(r.u)).slice(-MAX_RUNS);
  let seq = Number.isSafeInteger(v.seq) ? v.seq : 0;
  for (const r of list) {
    if (r.res === 'running') { r.res = 'cancel'; r.why = 'restart'; r.end = r.end || new Date().toISOString(); r.s = ++seq; st.runsDirty = true; }
  }
  st.runs = { epoch: v.epoch, seq, n: Number.isSafeInteger(v.n) ? v.n : list.length, list };
}

function ring() {
  if (!st.runs) st.runs = { epoch: newEpoch(), seq: 0, n: 0, list: [] };
  return st.runs;
}

/** A run of edge/rules.js (new or finished): into the ring with the next sequence number, to the server with the next bundle. */
function record(run) {
  const r = ring();
  run.s = ++r.seq;
  const i = r.list.findIndex((x) => x.u === run.u);
  if (i >= 0) r.list[i] = run;
  else {
    r.list.push(run);
    if (r.list.length > MAX_RUNS) r.list.splice(0, r.list.length - MAX_RUNS);
  }
  const j = st.runsOut.findIndex((x) => x.u === run.u);
  if (j >= 0) st.runsOut[j] = run;
  else if (st.runsOut.length < MAX_RUNS) st.runsOut.push(run);
  st.runsDirty = true;
}

/** At most once a minute: the ring (and the stopped chains) into gc.store — the gateway's card is spared. */
function saveRuns() {
  if (!st.gc || !st.gc.store) return Promise.resolve();
  const stopped = st.engine ? st.engine.stoppedList() : [];
  const sk = JSON.stringify(stopped);
  if (!st.runsDirty && sk === st.stoppedKey) return Promise.resolve();
  const r = ring();
  st.runsDirty = false;
  st.stoppedKey = sk;
  const gc = st.gc;
  return gc.store.set(RUNS_KEY, { epoch: r.epoch, seq: r.seq, n: r.n, list: r.list, stopped }).catch(() => warnOnce('store-runs', 'the protocol of the logic chains could not be kept for a restart of the gateway'));
}

// ─── Discovery ──────────────────────────────────

function candidateHost(host) {
  return String(host || '').replace(/\.local\.?$/i, '').toLowerCase();
}

function onFound(s) {
  if (!s || !devices.validIp(s.ip) || !devices.isPrivate(s.ip)) return;
  const host = candidateHost(s.host);
  if (s.service !== '_shelly._tcp' && !/^(shelly|tasmota)/.test(host)) return;
  const last = st.probedAt.get(s.ip) || 0;
  if (Date.now() - last < REPROBE_MS || st.queue.some((q) => q.ip === s.ip)) return;
  st.queue.push({ ip: s.ip, host });
  drain();
}

async function drain() {
  if (st.probing) return;
  st.probing = true;
  try {
    while (st.queue.length && st.gc) {
      const { ip, host } = st.queue.shift();
      st.probedAt.set(ip, Date.now());
      try {
        const info = await devices.probe(st.gc.lan.http, ip);
        const c = { ...info, host: host || null, seenAt: new Date().toISOString() };
        const before = st.found.get(ip);
        if (!before && st.found.size >= MAX_FOUND) continue;
        st.found.set(ip, c);
        const same = before && JSON.stringify({ ...before, seenAt: null }) === JSON.stringify({ ...c, seenAt: null });
        if (!same) st.gc.emit('found', { devices: [c] });
      } catch { /* not a Shelly/Tasmota, or not answering — tried again later */ }
      await new Promise((r) => { const t = setTimeout(r, PROBE_GAP_MS); if (t.unref) t.unref(); });
    }
  } finally { st.probing = false; }
}

async function browse() {
  for (const b of st.browses.splice(0)) b.stop();
  for (const service of SERVICES) {
    try { st.browses.push(await st.gc.lan.mdns.browse(service, onFound)); } catch (e) {
      warnOnce('mdns:' + service, `mDNS ${service} not available (${(e && e.code) || 'error'})`);
    }
  }
}

// ─── Handlers ───────────────────────────────────

function str(v, max) { return typeof v === 'string' && v.length <= max ? v : null; }

function badRequest(msg) { return Object.assign(new Error(msg), { code: 'bad_request' }); }

module.exports = {
  start(gc) {
    st.gc = gc;
    st.startedAt = new Date().toISOString();
    st.mqtt = 'starting';
    st.rulesKey = null;
    st.rulesFromServer = false;
    st.stored = null;
    st.storedKey = null;
    st.fired = [];
    st.runs = null;
    st.runsOut = [];
    st.runsDirty = false;
    st.stoppedKey = '[]';
    st.presses.clear();
    st.z2m = new Map();
    st.z2mNames = new Map();
    st.z2mSub = null;
    st.notes = [];
    st.engine = rules.create({
      device: (base) => st.devices.get(base) || null,
      publish: async (list) => {
        if (st.mqtt !== 'ok') throw Object.assign(new Error('the MQTT broker of this gateway is not available'), { code: 'mqtt_off' });
        await publishAll(list);
      },
      fired: (id, at) => { if (st.fired.length < 200) st.fired.push({ id, at }); },
      notify: (n) => { if (st.notes.length >= 50) return false; st.notes.push(n); return true; },
      z2mTopic,
      record,
      runId: () => { const r = ring(); r.n += 1; return `${r.epoch}:${r.n}`; },
      log: gc.log,
    });

    gc.handle('info', () => ({
      version: gc.version || null, startedAt: st.startedAt, mqtt: st.mqtt, lan: lan().map((a) => a.address).slice(0, 8),
      devices: st.configured ? st.configured.size : 0, found: st.found.size, rules: st.engine ? st.engine.count() : 0,
    }));

    gc.handle('discover', async () => {
      st.probedAt.clear();
      await browse();
      return { devices: [...st.found.values()] };
    });

    gc.handle('refresh', async () => {
      if (st.mqtt !== 'ok') await subscribe();
      refreshAll();
      st.probedAt.clear();
      await browse();
      return { mqtt: st.mqtt, devices: st.configured ? st.configured.size : 0 };
    });

    gc.handle('probe', async (p) => {
      const ip = p && str(p.ip, 15);
      if (!ip || !devices.validIp(ip)) throw badRequest('ip: an IPv4 address');
      const info = await devices.probe(gc.lan.http, ip);
      return { ...info, host: devices.addressFor(ip, lan()) };
    });

    gc.handle('setup', async (p) => {
      const o = p && typeof p === 'object' ? p : {};
      const host = devices.addressFor(o.ip, lan());
      if (!host) throw Object.assign(new Error('the gateway has no private LAN address'), { code: 'no_lan_address' });
      await devices.setup(gc.lan.http, { ip: str(o.ip, 15), family: o.family, host, port: 1883, user: str(o.user, 64), pass: str(o.pass, 128), prefix: str(o.prefix, 24), password: str(o.password, 128), httpUser: o.httpUser == null ? null : o.httpUser, buttons: o.buttons === true });
      if (st.mqtt !== 'ok') subscribe();
      return { ok: true, host, port: 1883 };
    });

    gc.handle('command', async (p) => {
      if (st.mqtt !== 'ok') throw Object.assign(new Error('the MQTT broker of this gateway is not available'), { code: 'mqtt_off' });
      const n = await publishAll(commands.messages(p));
      return { sent: n };
    });

    // the runs the server part missed: everything after `after` of this ring (all of it for another epoch)
    gc.handle('runs', (p) => {
      const r = ring();
      const o = p && typeof p === 'object' ? p : {};
      const after = o.epoch === r.epoch && Number.isSafeInteger(o.after) ? o.after : 0;
      const list = r.list.filter((x) => x.s > after).sort((a, b) => a.s - b.s);
      return { epoch: r.epoch, runs: list.slice(0, RUNS_PAGE), more: list.length > RUNS_PAGE };
    });

    // Testlauf: what a chain would do now ({ id } or a draft { rule }), or { id, run: true } — run it by hand
    gc.handle('test', (p) => {
      const o = p && typeof p === 'object' ? p : {};
      if (o.id !== undefined && !Number.isSafeInteger(o.id)) throw badRequest('id: a logic chain');
      return st.engine.test(o.id !== undefined ? { id: o.id } : { rule: o.rule }, { run: o.run === true, by: o.by === 'app' ? 'app' : 'manual' });
    });

    restoreRules();
    gc.onConfig((cfg) => onConfig(cfg));
    if (gc.config()) onConfig(gc.config());

    const every = (fn, ms) => { const t = setInterval(fn, ms); if (t.unref) t.unref(); st.timers.push(t); };
    every(flush, FLUSH_MS);
    every(refreshAll, REFRESH_MS);
    every(() => { if (st.mqtt !== 'ok') subscribe(); }, RETRY_MQTT_MS);
    every(() => { saveRuns(); }, RUNS_SAVE_MS);

    subscribe();
    browse();
  },

  stop() {
    for (const t of st.timers.splice(0)) clearInterval(t);
    for (const b of st.browses.splice(0)) b.stop();
    for (const s of st.subs.splice(0)) s.unsubscribe().catch(() => null);
    if (st.z2mSub && typeof st.z2mSub === 'object') st.z2mSub.unsubscribe().catch(() => null);
    st.z2mSub = null;
    st.z2m = new Map();
    st.z2mNames = new Map();
    st.notes = [];
    if (st.gc) saveRuns();
    if (st.engine) st.engine.stop();
    st.engine = null;
    st.rulesKey = null;
    st.rulesFromServer = false;
    st.stored = null;
    st.storedKey = null;
    st.fired = [];
    st.runs = null;
    st.runsOut = [];
    st.presses.clear();
    st.devices.clear();
    st.dirty.clear();
    st.found.clear();
    st.probedAt.clear();
    st.queue = [];
    st.configured = null;
    st.subscribing = null;
    st.warned.clear();
    st.gc = null;
  },

  _test: { st, hooks, flush, saveRuns },
};
