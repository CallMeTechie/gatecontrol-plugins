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
//             a device's message → the chains it triggers → MQTT; event `fired` { rules: [{ id, at }] }
//
// Capabilities (plugin.json edge.capabilities): mdns _shelly._tcp and _http._tcp, http.lan, mqtt shellies/# and
// tasmota/#. On disk (gc.store) only the last list of logic chains, so they run after a restart of the gateway
// while the server is away — no device password, no MQTT password.

const os = require('node:os');
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
const SERVICES = ['_shelly._tcp', '_http._tcp'];
const RULES_KEY = 'rules';

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

function onMessage(topic, payload) {
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
  // the server part's list is the truth (an older server part sends none: no chains)
  setRules({ rules: cfg && cfg.rules, tz: cfg && cfg.tz }, true);
}

// ─── Logic chains ───────────────────────────────

const EMPTY_RULES = JSON.stringify({ rules: [], tz: null });

/** Hand a list to the engine; the server part's list is kept in gc.store (written only when it differs from what is there). */
function setRules(cfg, fromServer) {
  if (!st.engine) return;
  const rl = Array.isArray(cfg.rules) ? cfg.rules.slice(0, rules.MAX_RULES) : [];
  const list = { rules: rl, tz: rl.length && typeof cfg.tz === 'string' ? cfg.tz : null };
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

/** After a restart: the last list, until the server part sends its own. */
function restoreRules() {
  if (!st.gc.store) return;
  const gc = st.gc;
  st.stored = Promise.resolve().then(() => gc.store.get(RULES_KEY)).then((v) => {
    if (st.gc !== gc) return;
    const ok = v && typeof v === 'object' && Array.isArray(v.rules);
    st.storedKey = ok ? JSON.stringify({ rules: v.rules, tz: typeof v.tz === 'string' ? v.tz : null }) : EMPTY_RULES;
    if (ok && !st.rulesFromServer) setRules(v, false);
  }).catch(() => null);
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
    st.engine = rules.create({
      device: (base) => st.devices.get(base) || null,
      publish: async (list) => {
        if (st.mqtt !== 'ok') throw Object.assign(new Error('the MQTT broker of this gateway is not available'), { code: 'mqtt_off' });
        await publishAll(list);
      },
      fired: (id, at) => { if (st.fired.length < 200) st.fired.push({ id, at }); },
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
      await devices.setup(gc.lan.http, { ip: str(o.ip, 15), family: o.family, host, port: 1883, user: str(o.user, 64), pass: str(o.pass, 128), prefix: str(o.prefix, 24), password: str(o.password, 128), httpUser: o.httpUser == null ? null : o.httpUser });
      if (st.mqtt !== 'ok') subscribe();
      return { ok: true, host, port: 1883 };
    });

    gc.handle('command', async (p) => {
      if (st.mqtt !== 'ok') throw Object.assign(new Error('the MQTT broker of this gateway is not available'), { code: 'mqtt_off' });
      const n = await publishAll(commands.messages(p));
      return { sent: n };
    });

    restoreRules();
    gc.onConfig((cfg) => onConfig(cfg));
    if (gc.config()) onConfig(gc.config());

    const every = (fn, ms) => { const t = setInterval(fn, ms); if (t.unref) t.unref(); st.timers.push(t); };
    every(flush, FLUSH_MS);
    every(refreshAll, REFRESH_MS);
    every(() => { if (st.mqtt !== 'ok') subscribe(); }, RETRY_MQTT_MS);

    subscribe();
    browse();
  },

  stop() {
    for (const t of st.timers.splice(0)) clearInterval(t);
    for (const b of st.browses.splice(0)) b.stop();
    for (const s of st.subs.splice(0)) s.unsubscribe().catch(() => null);
    if (st.engine) st.engine.stop();
    st.engine = null;
    st.rulesKey = null;
    st.rulesFromServer = false;
    st.stored = null;
    st.storedKey = null;
    st.fired = [];
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

  _test: { st, hooks, flush },
};
