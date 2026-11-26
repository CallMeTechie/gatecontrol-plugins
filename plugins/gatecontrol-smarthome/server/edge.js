'use strict';

// Shelly and Tasmota devices through a GateControl gateway — the server side of the edge part (edge/index.js).
// GateControl ≥ 1.228.1: gc.edge (gateways, call, on, configure) and gc.mqtt.accounts (an account of the
// gateway's broker per device). Without them (an older GateControl) the deCONZ part works as before and the pages
// show a hint: available() is false.
//
// Sources: every gateway the plugin's edge part is set up for (gc.edge.gateways()). Devices: edge_devices
// (server/edgestore.js), each with a broker account <plugin id>-<prefix> that may only use its own topics
// (shellies/<prefix>/# or tasmota/<prefix>/#). The account's password is never stored: it is shown once (manual
// set-up) or handed straight to the edge part, which writes it into the device (automatic set-up, kept in this
// process's memory for at most 30 minutes while the set-up runs).
//
// Events of the edge part: `states` { devices: [snapshot] } (bundled every 2 s) → resources and their cached
// state; `found` { devices: [candidate] } → the "new devices" hint. $started / $online → the device list again
// (gc.edge.configure { devices: [{ base, family }], rules, tz }) and the runs the server part missed (gc.edge.call
// 'runs'); `fired` { rules: [{ id, at }] } → a logic chain ran, `runs` { runs: [run] } → its protocol
// (server/edgerules.js); `notify` { notes: [{ r, i, at, u }] } (since 1.12.0) → a step "Mitteilung senden" ran — the
// notification goes out here (server/serverchains.js sendNote). The configuration carries the zigbee2mqtt devices the
// gateway's chains use and where the gateway is (z2m, sun). Since 1.15.0 zigbee2mqtt on a gateway needs the optional
// capability zigbee2mqtt/# (server/edgerules.js): `z2m` { state: 'ok' | 'denied' | 'error' | 'off' } → whether the
// gateway let the edge part subscribe to it; tick() notices when an administrator confirmed (or revoked) it and sends the
// gateway its chains again.
// Since 1.17.0 thermostats: Shelly TRV (Gen1) and Shelly BLU TRV through a BLU Gateway Gen3 report a channel
// thermostat:<n> → a resource of kind thermostat (the heating, server/heating.js); the configuration carries `heat`, the
// plan of the rooms whose thermostats all hang on that gateway (server/heating.js edgeConfig) — it runs there, also
// while the server is away. Since 1.18.0 zigbee2mqtt thermostats of that gateway count for it too, once zigbee2mqtt/#
// is confirmed there.
// Since 1.21.0 Tuya devices (server/tuya.js): edge_devices of family 'tuya' without an MQTT account; the configuration
// carries `tuya` [{ id, key, ip?, hint?, ver?, p }] (the local keys from the plugin's secrets — gc.edge.configure is held
// only in the edge part's memory), their reports the link (info.tuya: ok | connecting | searching | offline | key |
// denied | busy) besides the channels. Routes /edge/tuya/… for the assistant "Tuya-Geräte hinzufügen".

const crypto = require('node:crypto');
const store = require('./store');
const es = require('./edgestore');
const alerts = require('./alerts');
const batteryLevel = require('./battery');
const edgerules = require('./edgerules');
const { codeError } = require('./deconz');
const tuya = require('./tuya');

const MIN_GATEWAY = '1.49.0'; // plugin.json edge.minGateway (1.21.0: the optional capabilities for Tuya)
const CALL_MS = 10000;
const SETUP_CALL_MS = 30000;
const INFO_MS = 4000;
const STALE_MS = 30 * 60 * 1000;            // devices on mains: the edge part asks them every 10 minutes
const SENSOR_STALE_MS = 26 * 3600 * 1000;   // battery sensors sleep and report every few hours
const THERMO_STALE_MS = 2 * 3600 * 1000;    // a radiator thermostat (Shelly TRV, BLU Gateway) reports less often
const JOB_TTL_MS = 30 * 60 * 1000;
const ONLINE_WAIT_MS = 3 * 60 * 1000;
const ORPHAN_RETRY_MS = 5 * 60 * 1000;
const ORPHANS_KEY = 'edge.orphans';
const CH_RE = /^(switch|light|cover|thermostat):(\d{1,2})$/;
const TRV_LIMITS = Object.freeze({ min: 5, max: 30, step: 0.5 });
const CONFIG_MAX = 47 * 1024;            // gc.edge.configure takes 48 KB
const KINDS = new Set(['light', 'plug', 'relay']);
const COVERS = new Set(['shutter', 'awning', 'gate']);
const NAME_MAX = 60;
const AREA_MAX = 40;

const mem = {
  found: new Map(),   // gateway id → Map ip → candidate
  jobs: new Map(),    // job id → set-up job (with the account password while it runs)
  ready: false,
  orphanAt: 0,
  z2mSeen: false,     // recheckZ2m looked at the gateways' chains once since the start
  heatTooBig: new Set(), // gateways whose heating did not fit into the configuration (logged once)
};

const available = (gc) => !!(gc.edge && gc.mqtt && gc.mqtt.accounts);

function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function semverAtLeast(v, min) {
  const a = String(v || '').split(/[.+-]/).map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (!Number.isFinite(a[i])) return false;
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

/** "Licht Flur" → "licht-flur" (MQTT prefix and account name: [a-z0-9-], at most `max`). */
function slugify(name, max) {
  const s = String(name || '').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (s.slice(0, max).replace(/-+$/, '')) || 'geraet';
}

/** Tasmota keeps the MQTT user name short (32): <plugin id>- is 22 characters, the prefix at most 10. */
const prefixMax = (family) => (family === 'tasmota' ? 10 : 20);
const baseOf = (family, prefix) => `${family === 'tasmota' ? 'tasmota' : 'shellies'}/${prefix}`;

function edgeErr(e) {
  const code = (e && e.code) || 'error';
  const m = code === 'edge_error' ? /^([A-Za-z0-9_.-]{1,32}):\s/.exec(String((e && e.message) || '')) : null;
  return m ? m[1] : code;
}

// ─── Gateways (sources) ─────────────────────────

// Why a gateway's edge channel is down (GateControl after 1.231.0: gc.edge.gateways() `reason` with state 'offline';
// older servers send none → the plain "not connected"). The page knows the values it has texts for.
const REASON_RE = /^[a-z_]{1,32}$/;
function reasonOf(g) { return g && g.state === 'offline' && typeof g.reason === 'string' && REASON_RE.test(g.reason) ? g.reason : null; }

/** Why `gatewayId` is offline right now, or null (for a failed set-up step: gateway_offline alone says little). */
async function offlineReason(gc, gatewayId) {
  try { return reasonOf((await gc.edge.gateways()).find((g) => g.id === Number(gatewayId))); } catch { return null; }
}

/** What GateControl knows of the gateways the edge part is set up for, plus the edge part's own info. */
async function gateways(gc, { info = true } = {}) {
  if (!available(gc)) return { available: false, gateways: [] };
  let list = [];
  try { list = await gc.edge.gateways(); } catch (e) { gc.log.warn('edge gateways failed', edgeErr(e)); }
  const out = await Promise.all(list.map(async (g) => {
    const v = {
      id: g.id, name: g.name, state: g.state, online: g.online === true, version: g.version || null, reason: reasonOf(g),
      tooOld: g.state === 'gateway_too_old' || (g.version ? !semverAtLeast(g.version, MIN_GATEWAY) : false), info: null,
    };
    if (info && g.state === 'running') {
      try { v.info = await gc.edge.call(g.id, 'info', {}, { timeoutMs: INFO_MS }); } catch { v.info = null; }
    }
    return v;
  }));
  return { available: true, minGateway: MIN_GATEWAY, gateways: out };
}

async function configureGateway(gc, gatewayId) {
  if (!available(gc)) return false;
  const all = await es.listDevices(gc, gatewayId);
  const devices = all.map((d) => ({ base: d.base, family: d.family }));
  // Tuya (since 1.21.0): with their keys — only for this edge part's memory (and its gc.store on the gateway)
  const tuyaList = await tuyaConfig(gc, all.filter((d) => d.family === 'tuya'));
  // the gateway's logic chains run in its edge part (edge/rules.js); an older edge part ignores them
  const { rules, tz, z2m, sun } = await edgerules.configFor(gc, gatewayId);
  // the heating of the rooms that hang on this gateway (since 1.17.0); when it cannot be worked out now, no `heat`:
  // the gateway keeps the rooms it has (an empty list would stop them)
  const heating = require('./heating');
  const heat = await heating.edgeConfig(gc, Number(gatewayId)).catch((e) => { gc.log.warn('heating config failed', gatewayId, (e && (e.code || e.message)) || e); return null; });
  let data = { devices, rules, tz, z2m, sun, tuya: tuyaList, ...(heat ? { heat: heat.cfg } : {}) };
  if (heat && Buffer.byteLength(JSON.stringify(data)) > CONFIG_MAX) {
    // GateControl takes 48 KB: the devices and chains go first, the gateway keeps the heating it has
    if (!mem.heatTooBig.has(Number(gatewayId))) gc.log.warn(`the heating of gateway ${Number(gatewayId)} does not fit into its configuration (too many rooms, plans or chains) — the gateway keeps the plan it has`);
    mem.heatTooBig.add(Number(gatewayId));
    data = { devices, rules, tz, z2m, sun, tuya: tuyaList };
  }
  try {
    await gc.edge.configure(Number(gatewayId), data);
    if (data.heat) heating.noteSent(Number(gatewayId), heat.key);
    return true;
  } catch (e) {
    gc.log.debug('edge configure failed', gatewayId, edgeErr(e));
    return false;
  }
}

/** The Tuya devices of a gateway as its edge part takes them; a device whose key is gone (secret removed) stays out. */
async function tuyaConfig(gc, list) {
  const out = [];
  for (const d of list) {
    const key = await gc.settings.get(tuya.keyName(d.prefix)).catch(() => null);
    if (typeof key !== 'string' || !tuya.KEY_RE.test(key)) continue;
    const t = (d.config && d.config.tuya) || {};
    const p = tuya.cleanProfile(t.prof);
    if (p.k === 'other') continue; // not supported and no switch chosen: no connection
    out.push({ id: d.prefix, key, ...(t.ip ? { ip: t.ip } : {}), ...(d.ip ? { hint: d.ip } : {}), ...(t.ver ? { ver: t.ver } : {}), p });
  }
  return out;
}

/** The runs of the logic chains the gateway kept while the server part did not hear it. */
async function catchUp(gc, gatewayId) {
  try {
    if (await edgerules.pullRuns(gc, gatewayId)) await configureGateway(gc, gatewayId);
  } catch (e) { gc.log.debug('edge rule runs not fetched', gatewayId, (e && (e.code || e.message)) || e); }
}

/** Testlauf of a logic chain on its gateway (edge/rules.js test). */
async function testRule(gc, gatewayId, params) {
  if (!available(gc)) throw codeError('SMARTHOME_EDGE_UNAVAILABLE');
  try {
    return await gc.edge.call(Number(gatewayId), 'test', params, { timeoutMs: CALL_MS });
  } catch (e) {
    const code = edgeErr(e);
    if (code === 'stopped') throw codeError('SMARTHOME_RULE_STOPPED');
    if (code === 'not_found') throw codeError('SMARTHOME_EDGE_RULE_PENDING');
    throw codeError('SMARTHOME_EDGE_UNREACHABLE', code);
  }
}

// ─── Resources from a device's report ───────────

function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function sensorOnly(dev) {
  const ch = dev.state && dev.state.ch;
  return !ch || !Object.keys(ch).length;
}

/**
 * A battery device (Shelly H&T and the like): it sleeps, wakes for a report every few hours and is gone again —
 * no output, no "online" that would mean anything. Not one: a sensor on USB power (Gen2+ reports it), a device
 * that has not reported yet.
 */
function sleeperOf(dev) {
  if (dev.family === 'tuya' || !dev.last_seen_at || !sensorOnly(dev)) return false;
  const s = (dev.state && dev.state.sensor) || {};
  return s.external !== true;
}

/** "Batterie schwach" below the plugin setting (5–50 %, default 15) — the threshold of the notification. */
const BATTERY_LOW_DEFAULT = alerts.configOf(null).batteryLow;
async function batteryLowAt(gc) {
  try { return alerts.configOf(await gc.settings.all()).batteryLow; } catch { return BATTERY_LOW_DEFAULT; }
}

/** Only thermostats (a Shelly TRV, a BLU Gateway with its TRVs): they report less often than a switch. */
function thermoOnly(dev) {
  const keys = Object.keys((dev.state && dev.state.ch) || {});
  return keys.length > 0 && keys.every((k) => k.startsWith('thermostat:'));
}

/** Reachable: reported within the window and — on mains — not announced offline (LWT / "online"). */
function reachableOf(dev, now = Date.now()) {
  const seen = dev.last_seen_at ? Date.parse(dev.last_seen_at) : NaN;
  if (!Number.isFinite(seen)) return false;
  // a Tuya device: its connection is up (the edge part asks it every 10 minutes)
  if (dev.family === 'tuya') return dev.online === true && now - seen <= STALE_MS;
  const sleeper = sensorOnly(dev);
  if (!sleeper && dev.online === false) return false;
  return now - seen <= (sleeper ? SENSOR_STALE_MS : (thermoOnly(dev) ? THERMO_STALE_MS : STALE_MS));
}

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function defaultKind(dev, type) {
  if (type === 'light') return 'light';
  if (dev.family === 'tuya') return dev.config && dev.config.tuya && dev.config.tuya.prof && dev.config.tuya.prof.k === 'plug' ? 'plug' : 'relay';
  const m = `${dev.model || ''} ${dev.name || ''}`;
  return /plug|steckdose|SHPLG|SNPL|S2[0-9]/i.test(m) ? 'plug' : 'relay';
}

/** A channel's resource state (cached in resources.state_json); energy "today" from the lifetime counter. */
function channelState(type, c, reachable, prev, now) {
  const st = { reachable };
  if (type === 'cover') {
    st.pos = c.pos == null ? null : finite(c.pos);
    st.moving = c.moving === 'opening' || c.moving === 'closing' ? c.moving : null;
    st.on = st.pos != null ? st.pos > 0 : !!(prev && prev.on);
  } else {
    st.on = c.on === true;
    if (type === 'light' && finite(c.bri) != null) st.bri = Math.round(c.bri);
    // a colour light (Tuya, since 1.21.0): as deCONZ and zigbee2mqtt keep it — ct in mired, hue 0–65535, sat 0–254
    if (type === 'light') {
      for (const f of ['ct', 'hue', 'sat']) if (finite(c[f]) != null) st[f] = Math.round(c[f]);
      if (c.cm === 'ct' || c.cm === 'hs' || c.cm === 'scene') st.colormode = c.cm;
    }
  }
  if (finite(c.power) != null) st.power = c.power;
  if (finite(c.today) != null) st.energy_today = Math.round(c.today * 1000) / 1000;
  else if (finite(c.energy) != null) {
    const day = localDay(now);
    let base = prev && prev.energy_base && prev.energy_base.day === day && finite(prev.energy_base.wh) != null && prev.energy_base.wh <= c.energy ? prev.energy_base : null;
    if (!base) base = { day, wh: c.energy };
    st.energy_base = base;
    st.energy_today = Math.round(((c.energy - base.wh) / 1000) * 1000) / 1000;
  }
  return st;
}

function sensorState(s, reachable, dev) {
  const st = { reachable, type: finite(s.temperature) != null ? 'temperature' : 'humidity' };
  st.value = st.type === 'temperature' ? s.temperature : finite(s.humidity);
  if (finite(s.humidity) != null) st.humidity = s.humidity;
  if (finite(s.battery) != null) st.battery = s.battery;
  // a battery device sleeps between its reports: the portal shows the last value and since when, not "unreachable"
  if (dev && sleeperOf(dev)) { st.sleeping = true; st.lastupdated = dev.last_seen_at; }
  return st;
}

/** A thermostat's resource state (Shelly TRV, BLU TRV): as the heating reads it. */
function thermostatState(c, reachable, dev) {
  const bat = finite(c.bat) != null ? c.bat : finite(((dev.state && dev.state.sensor) || {}).battery);
  const st = { reachable: reachable && c.paired !== false, type: 'temperature', value: finite(c.temp), setpoint: finite(c.target), valve: finite(c.valve), mode: null };
  if (c.paired === false) st.paired = false; // a BLU TRV the gateway lost
  st.heating = st.valve != null && st.valve > 0;
  if (bat != null) st.battery = bat;
  if (typeof c.schedule === 'boolean') st.schedule_on = c.schedule;
  if (typeof c.window === 'boolean') st.window = c.window;
  if (finite(c.boost) != null) st.boost_minutes = c.boost;
  st.lastupdated = dev.last_seen_at || null;
  return st;
}

function channelKeys(state) {
  const order = { cover: 0, light: 1, switch: 2, thermostat: 3 };
  return Object.keys((state && state.ch) || {}).filter((k) => CH_RE.test(k))
    .sort((a, b) => (order[a.split(':')[0]] - order[b.split(':')[0]]) || (Number(a.split(':')[1]) - Number(b.split(':')[1])));
}

/** Create / update the device's resources from its state and its configuration (kinds, names, cover types). */
async function syncResources(gc, dev, { drop = [], now = Date.now() } = {}) {
  const reachable = reachableOf(dev, now);
  const keys = channelKeys(dev.state);
  const prevAll = new Map((await es.deviceResources(gc, dev.id)).map((r) => [String(r.deconz_id).split('/')[1], r]));
  const cfg = dev.config || {};
  const chCfg = cfg.channels && typeof cfg.channels === 'object' ? cfg.channels : {};
  for (const [i, key] of keys.entries()) {
    const type = key.split(':')[0];
    const c = dev.state.ch[key] || {};
    const cc = chCfg[key] || {};
    const prev = prevAll.get(key);
    if (type === 'thermostat') {
      const trv = c.kind === 'blu' ? 'blu' : 'gen1';
      const name = cleanText(cc.name, NAME_MAX) || (keys.length === 1 ? dev.name : `${dev.name} ${i + 1}`);
      await es.upsertChannel(gc, dev, key, {
        kind: 'thermostat', name, area: dev.area, state: thermostatState(c, reachable, dev),
        // boost of the device itself: Shelly TRV (Gen1); a BLU TRV gets 30 °C instead
        capabilities: { source: 'edge', ch: key, trv, reading: 'temperature', gateway_id: dev.gateway_id, setpoint: { ...TRV_LIMITS }, boost: trv === 'gen1', schedule: trv === 'gen1' },
      });
      continue;
    }
    let kind;
    if (type === 'cover') kind = 'cover';
    else if (type === 'light') kind = 'light';
    else kind = KINDS.has(cc.kind) ? cc.kind : defaultKind(dev, type);
    const name = cleanText(cc.name, NAME_MAX) || (keys.length === 1 ? dev.name : `${dev.name} ${i + 1}`);
    const capabilities = {
      source: 'edge', ch: key, bri: type === 'light', power: finite(c.power) != null || !!(prev && prev.capabilities && prev.capabilities.power),
      position: type === 'cover' && (c.pos != null || !!(prev && prev.capabilities && prev.capabilities.position)),
    };
    // a Tuya light: brightness, colour temperature, colour and scenes as its datapoints have them
    if (type === 'light' && dev.family === 'tuya') Object.assign(capabilities, tuya.lightCaps(dev.config && dev.config.tuya && dev.config.tuya.prof));
    if (type === 'cover') capabilities.cover = COVERS.has(cc.cover) ? cc.cover : 'shutter';
    const state = channelState(type, c, reachable, prev && prev.state, now);
    if (dev.family === 'tuya') {
      // why it does not answer: its key no longer fits (the widgets and the page say so); a scene it was set to
      if (dev.state && dev.state.tuya && dev.state.tuya.link === 'key') state.tuya_key = true;
      if (type === 'light' && state.colormode === 'scene' && prev && prev.state && typeof prev.state.scene === 'string') state.scene = prev.state.scene;
    }
    await es.upsertChannel(gc, dev, key, { kind, name, capabilities, area: dev.area, state });
  }
  const s = (dev.state && dev.state.sensor) || {};
  if (finite(s.temperature) != null || finite(s.humidity) != null) {
    await es.upsertChannel(gc, dev, 'sensor', {
      kind: 'sensor', name: cleanText(chCfg.sensor && chCfg.sensor.name, NAME_MAX) || dev.name,
      capabilities: { source: 'edge', ch: 'sensor', reading: finite(s.temperature) != null ? 'temperature' : 'humidity' }, area: dev.area, state: sensorState(s, reachable, dev),
    });
  }
  for (const key of drop) if (CH_RE.test(key)) await es.removeChannel(gc, dev, key);
}

function cleanSnapshot(snap) {
  const ch = {};
  for (const [k, v] of Object.entries((snap && snap.ch) || {})) {
    if (!CH_RE.test(k) || !v || typeof v !== 'object' || Object.keys(ch).length >= 16) continue;
    const c = {};
    if (typeof v.on === 'boolean') c.on = v.on;
    for (const f of ['bri', 'pos', 'power', 'energy', 'today', 'temp', 'target', 'valve', 'boost', 'bat', 'rid', 'ct', 'hue', 'sat']) if (finite(v[f]) != null) c[f] = v[f];
    if (v.cm === 'ct' || v.cm === 'hs' || v.cm === 'scene') c.cm = v.cm;
    if (v.pos === null) c.pos = null;
    if (v.moving === 'opening' || v.moving === 'closing') c.moving = v.moving;
    for (const f of ['schedule', 'window', 'paired']) if (typeof v[f] === 'boolean') c[f] = v[f];
    if (v.kind === 'gen1' || v.kind === 'blu') c.kind = v.kind;
    ch[k] = c;
  }
  const sensor = {};
  const s = (snap && snap.sensor) || {};
  for (const f of ['temperature', 'humidity', 'battery']) if (finite(s[f]) != null) sensor[f] = s[f];
  if (typeof s.external === 'boolean') sensor.external = s.external;
  return { ch, sensor };
}

/** One device's report from the edge part. */
async function applySnapshot(gc, dev, snap, now = Date.now()) {
  const patch = { state: cleanSnapshot(snap) };
  const seen = Date.parse(snap.seenAt);
  const at = Number.isFinite(seen) ? Math.min(seen, now) : now;
  const last = dev.last_seen_at ? Date.parse(dev.last_seen_at) : 0;
  if (!(last >= at)) patch.last_seen_at = new Date(at).toISOString();
  if (typeof snap.online === 'boolean') patch.online = snap.online;
  else if (patch.last_seen_at && dev.online === false && Object.keys(patch.state.ch).length) patch.online = null;
  const info = snap.info && typeof snap.info === 'object' ? snap.info : {};
  if (typeof info.model === 'string' && info.model && !dev.model) patch.model = cleanText(info.model, 40);
  if (typeof info.firmware === 'string' && info.firmware) patch.firmware = cleanText(info.firmware, 60);
  if (typeof info.ip === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(info.ip)) patch.ip = info.ip;
  if (dev.family !== 'tasmota' && dev.family !== 'tuya' && (snap.family === 'shelly1' || snap.family === 'shelly2') && snap.family !== dev.family) patch.family = snap.family;
  if (dev.family === 'tuya') await tuyaReport(gc, dev, info, patch);
  const next = await es.updateDevice(gc, dev.id, patch);
  await syncResources(gc, next, { drop: Array.isArray(snap.drop) ? snap.drop.slice(0, 16) : [], now });
  for (const job of mem.jobs.values()) {
    if (job.deviceId === dev.id && job.steps.online.state !== 'done' && job.steps.configure.state === 'done') {
      job.steps.online = { state: 'done' };
      job.state = 'done';
    }
  }
  return next;
}

const TUYA_LINKS = new Set(['ok', 'connecting', 'searching', 'offline', 'key', 'denied', 'busy']);

/**
 * What a Tuya device's report adds (since 1.21.0): its link and version (state.tuya), a kind found from its first status
 * (kind 'auto' — the gateway gets the profile at once), the datapoints of a device that is not supported, and one
 * notification when its key no longer fits.
 */
async function tuyaReport(gc, dev, info, patch) {
  const link = TUYA_LINKS.has(info.tuya) ? info.tuya : null;
  const ver = tuya.VERSIONS.includes(info.ver) ? info.ver : null;
  patch.state.tuya = { link, ver };
  const cfg = dev.config || {};
  const t = cfg.tuya || {};
  const next = { ...t };
  let reconfigure = false;
  if (ver && ver !== t.ver) next.ver = ver;
  const dps = info.dps && typeof info.dps === 'object' && !Array.isArray(info.dps) ? info.dps : null;
  const prof = tuya.cleanProfile(t.prof);
  if (dps && prof.k === 'auto' && Object.keys(dps).length) {
    const found = tuya.classify(dps, t.want, t.cat);
    next.prof = found ? tuya.cleanProfile(found) : { k: 'other' };
    if (!found) next.dps = Object.entries(dps).slice(0, 32).map(([dp, v]) => ({ dp: Number(dp), code: null, type: typeof v === 'boolean' ? 'Boolean' : (typeof v === 'number' ? 'Integer' : 'String'), value: typeof v === 'string' ? v.slice(0, 32) : v }));
    reconfigure = true;
  }
  if (link === 'key' && !t.keyNoted) { next.keyNoted = true; await tuya.noteKey(gc, dev); }
  if (link === 'ok' && t.keyNoted) next.keyNoted = false;
  if (JSON.stringify(next) !== JSON.stringify(t)) {
    patch.config = { ...cfg, tuya: next };
    dev.config = patch.config;
  }
  if (reconfigure) setImmediate(() => configureGateway(gc, dev.gateway_id).catch(() => null));
}

async function onStates(gc, ev) {
  const list = ev && ev.data && Array.isArray(ev.data.devices) ? ev.data.devices : [];
  for (const snap of list.slice(0, 64)) {
    if (!snap || typeof snap.base !== 'string') continue;
    const dev = await es.getByBase(gc, ev.gatewayId, snap.base);
    if (!dev) continue;
    try { await applySnapshot(gc, dev, snap); } catch (e) { gc.log.warn('edge state failed', dev.id, (e && (e.code || e.message)) || e); }
  }
}

function cleanCandidate(c) {
  if (!c || typeof c !== 'object' || typeof c.ip !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(c.ip) || !es.FAMILIES.has(c.family)) return null;
  return {
    ip: c.ip, family: c.family, gen: Number.isInteger(c.gen) ? c.gen : null, model: cleanText(c.model, 40) || null, name: cleanText(c.name, 60) || null,
    firmware: cleanText(c.firmware, 60) || null, id: cleanText(c.id, 64) || null, mac: cleanText(c.mac, 20) || null, auth: c.auth === true,
    host: cleanText(c.host, 80) || null, seenAt: typeof c.seenAt === 'string' ? c.seenAt.slice(0, 40) : new Date().toISOString(),
  };
}

function rememberFound(gatewayId, list) {
  let m = mem.found.get(gatewayId);
  if (!m) { m = new Map(); mem.found.set(gatewayId, m); }
  for (const raw of (Array.isArray(list) ? list : []).slice(0, 64)) {
    const c = cleanCandidate(raw);
    if (c && (m.has(c.ip) || m.size < 64)) m.set(c.ip, c);
  }
}

/** Found and not yet added (by MAC, device id or address). */
async function newFound(gc, gatewayId, { ask = false } = {}) {
  if (ask && available(gc)) {
    try { rememberFound(gatewayId, (await gc.edge.call(gatewayId, 'discover', {}, { timeoutMs: INFO_MS })).devices); } catch { /* cached list */ }
  }
  const devices = await es.listDevices(gc, gatewayId);
  const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const macs = new Set(devices.map((d) => norm(d.mac)).filter(Boolean));
  const ips = new Set(devices.map((d) => d.ip).filter(Boolean));
  return [...(mem.found.get(gatewayId) || new Map()).values()].filter((c) => !ips.has(c.ip) && !(c.mac && macs.has(norm(c.mac))));
}

/** Called from start(): the edge part's events. false without gc.edge. */
function setup(gc) {
  mem.found.clear();
  mem.jobs.clear();
  mem.orphanAt = 0;
  mem.z2mSeen = false;
  mem.heatTooBig.clear();
  tuya._mem.sessions.clear();
  edgerules._z2mMem.clear();
  require('./heating').resetEdge();
  mem.ready = available(gc);
  if (!gc.edge) return false;
  gc.edge.on('$started', ({ gatewayId }) => {
    // a restarted edge part (an updated gateway, perhaps): whether it refuses zigbee2mqtt/# is asked anew — the
    // heating keeps such a room here only while it does (server/heating.js z2mOn)
    const m = edgerules._z2mMem.get(Number(gatewayId));
    if (m && m.edge === 'denied') m.edge = null;
    return configureGateway(gc, gatewayId).then(() => catchUp(gc, gatewayId));
  });
  gc.edge.on('$online', ({ gatewayId }) => configureGateway(gc, gatewayId).then(() => catchUp(gc, gatewayId)));
  gc.edge.on('runs', ({ gatewayId, data }) => edgerules.storeRuns(gc, gatewayId, data && data.runs)
    .then((stopped) => (stopped ? configureGateway(gc, gatewayId) : null))
    .catch((e) => gc.log.warn('edge rule runs failed', (e && (e.code || e.message)) || e)));
  gc.edge.on('states', (ev) => onStates(gc, ev).then(() => require('./serverchains').refresh(gc)).catch(() => null));
  gc.edge.on('notify', async ({ gatewayId, data }) => {
    for (const n of (data && Array.isArray(data.notes) ? data.notes : []).slice(0, 20)) {
      await require('./serverchains').sendNote(gc, gatewayId, n).catch((e) => gc.log.warn('chain notification failed', (e && (e.code || e.message)) || e));
    }
  });
  gc.edge.on('found', ({ gatewayId, data }) => rememberFound(gatewayId, data && data.devices));
  gc.edge.on('z2m', ({ gatewayId, data }) => edgerules.setZ2mEdge(gc, gatewayId, data && data.state));
  // since 1.20.0: the window contacts the gateway hears itself (its feed runs: the server sends no `win` for such rooms)
  // and what the zigbee2mqtt thermostats it calibrates report
  gc.edge.on('contacts', ({ gatewayId, data }) => {
    // a changed state changes what the rooms of the gateway get (`win`): handed over with the next background run
    require('./heating').setContactsEdge(gatewayId, data && data.state);
  });
  gc.edge.on('cal', ({ gatewayId, data }) => require('./heating').noteCal(gatewayId, data && data.list));
  gc.edge.on('fired', ({ gatewayId, data }) => edgerules.markFired(gc, gatewayId, data).catch((e) => gc.log.warn('edge rule mark failed', (e && (e.code || e.message)) || e)));
  return true;
}

// ─── MQTT accounts ──────────────────────────────

async function createAccount(gc, gatewayId, prefix, base, label) {
  const opts = { name: prefix, label: cleanText(label, 80), topics: [{ topic: `${base}/#`, access: 'readwrite' }] };
  try {
    return await gc.mqtt.accounts.create(gatewayId, opts);
  } catch (e) {
    // an account of a device removed while the gateway was away: ours, unused → replace it
    const mine = (await gc.mqtt.accounts.list(gatewayId).catch(() => [])).find((a) => a.username === `${gc.plugin.id}-${prefix}`);
    if (!mine) throw e;
    await gc.mqtt.accounts.remove(gatewayId, mine.username);
    return gc.mqtt.accounts.create(gatewayId, opts);
  }
}

async function orphans(gc) {
  const v = await gc.settings.get(ORPHANS_KEY);
  return Array.isArray(v) ? v.filter((o) => o && Number.isInteger(o.gatewayId) && typeof o.username === 'string').slice(0, 200) : [];
}

async function removeAccount(gc, gatewayId, username) {
  if (!username) return true;
  try {
    await gc.mqtt.accounts.remove(gatewayId, username);
    return true;
  } catch (e) {
    gc.log.info('MQTT account kept for later removal', gatewayId, edgeErr(e));
    const list = await orphans(gc);
    if (!list.some((o) => o.gatewayId === gatewayId && o.username === username)) list.push({ gatewayId, username });
    await gc.settings.set(ORPHANS_KEY, list);
    return false;
  }
}

async function retryOrphans(gc) {
  const list = await orphans(gc);
  if (!list.length) return;
  const used = new Set((await es.listDevices(gc)).map((d) => `${d.gateway_id}/${d.mqtt_user}`));
  const keep = [];
  for (const o of list) {
    if (used.has(`${o.gatewayId}/${o.username}`)) continue;
    try { await gc.mqtt.accounts.remove(o.gatewayId, o.username); } catch { keep.push(o); }
  }
  await gc.settings.set(ORPHANS_KEY, keep);
}

/** A prefix not used on this gateway yet. */
async function freePrefix(gc, gatewayId, name, family) {
  const max = prefixMax(family);
  const used = new Set((await es.listDevices(gc, gatewayId)).map((d) => d.prefix));
  const root = slugify(name, max);
  if (!used.has(root)) return root;
  for (let i = 2; i < 100; i++) {
    const s = `${root.slice(0, max - String(i).length - 1).replace(/-+$/, '')}-${i}`;
    if (!used.has(s)) return s;
  }
  return `${root.slice(0, max - 7)}-${crypto.randomBytes(3).toString('hex')}`;
}

async function hostOf(gc, gatewayId) {
  try {
    const info = await gc.edge.call(gatewayId, 'info', {}, { timeoutMs: INFO_MS });
    return info && Array.isArray(info.lan) && typeof info.lan[0] === 'string' ? info.lan[0] : null;
  } catch { return null; }
}

function credentials(dev, password, host) {
  return { host: host || null, port: 1883, username: dev.mqtt_user, password: password || null, prefix: dev.prefix, base: dev.base, family: dev.family };
}

// ─── Devices ────────────────────────────────────

async function edgeGatewayOk(gc, gatewayId) {
  const id = Number(gatewayId);
  if (!Number.isSafeInteger(id) || id <= 0) throw codeError('INVALID');
  if (!available(gc)) throw codeError('SMARTHOME_EDGE_UNAVAILABLE');
  const list = await gc.edge.gateways().catch(() => []);
  if (!list.some((g) => g.id === id)) throw codeError('SMARTHOME_GATEWAY_NOT_FOUND');
  return id;
}

/** A new device and its account → { device, password }. */
async function addDevice(gc, { gatewayId, name, area, family, candidate }) {
  const prefix = await freePrefix(gc, gatewayId, name, family);
  const base = baseOf(family, prefix);
  const account = await createAccount(gc, gatewayId, prefix, base, name);
  let device;
  try {
    device = await es.createDevice(gc, {
      gateway_id: gatewayId, base, prefix, family, name, area, mqtt_user: account.username,
      model: candidate && candidate.model, firmware: candidate && candidate.firmware, ip: candidate && candidate.ip, mac: candidate && candidate.mac,
    });
  } catch (e) {
    await removeAccount(gc, gatewayId, account.username);
    throw e;
  }
  await configureGateway(gc, gatewayId);
  return { device, password: account.password };
}

async function removeDevice(gc, dev) {
  for (const job of mem.jobs.values()) if (job.deviceId === dev.id) { job.secret = null; job.state = 'cancelled'; }
  await removeAccount(gc, dev.gateway_id, dev.mqtt_user);
  await es.removeDevice(gc, dev.id);
  // a Tuya device's key goes with it — unless the same device is still set up on another gateway
  if (dev.family === 'tuya' && !(await es.listDevices(gc)).some((d) => d.family === 'tuya' && d.prefix === dev.prefix)) await gc.settings.setSecret(tuya.keyName(dev.prefix), null).catch(() => null);
  await configureGateway(gc, dev.gateway_id);
}

function validFamily(f) { return es.FAMILIES.has(f) ? f : null; }

// The user name of a device's own web access (Shelly Gen1: HTTP Basic, Tasmota: WebPassword with another user is
// rare, but firmware builds and proxies in front of a device have one). Default "admin"; Shelly Gen2+ knows no other.
// Kept per device (config.httpUser) — the password never is: it is asked for the one request that needs it.
const HTTP_USER_RE = /^[^\0-\x1f\x7f:"\\]{1,64}$/;
const HTTP_USER_DEFAULT = 'admin';
function cleanHttpUser(v) {
  if (v == null || v === '') return HTTP_USER_DEFAULT;
  if (typeof v !== 'string' || !HTTP_USER_RE.test(v.trim())) throw codeError('INVALID');
  return v.trim();
}
function httpUserOf(dev) {
  const u = dev && dev.config && dev.config.httpUser;
  return dev && dev.family !== 'shelly2' && typeof u === 'string' && HTTP_USER_RE.test(u) ? u : HTTP_USER_DEFAULT;
}
/** config with the user name set (or dropped again for "admin"). */
function withHttpUser(config, user) {
  const { httpUser: _old, ...rest } = config || {}; // eslint-disable-line no-unused-vars
  return user && user !== HTTP_USER_DEFAULT ? { ...rest, httpUser: user } : rest;
}

/** The admin's view of a device (and its resources with owners). */
async function deviceView(gc, dev, users, owners, lowAt = BATTERY_LOW_DEFAULT) {
  const resources = await es.deviceResources(gc, dev.id);
  const reachable = reachableOf(dev);
  const sleeper = sleeperOf(dev);
  const battery = dev.state && dev.state.sensor ? finite(dev.state.sensor.battery) : null;
  return {
    id: dev.id, gateway_id: dev.gateway_id, name: dev.name, area: dev.area || null, family: dev.family, model: dev.model || null, firmware: dev.firmware || null,
    ip: dev.ip || null, page: dev.ip && dev.family !== 'tuya' ? `http://${dev.ip}/` : null,
    ...(dev.family === 'tuya' ? { tuya: tuyaView(dev) } : {}), username: dev.mqtt_user || null, prefix: dev.prefix, base: dev.base, configured: dev.configured, online: dev.online,
    reachable, waiting: !dev.last_seen_at, last_seen_at: dev.last_seen_at || null, battery,
    // a battery device between two reports: "schläft – letzte Meldung vor …", never "nicht erreichbar"; overdue =
    // silent for longer than such a device sleeps (26 h) — the battery may be empty
    sleeper, overdue: sleeper && !reachable, battery_low: battery != null && battery <= lowAt,
    // since 1.13.0: the level of the battery symbol (good | warn | crit; crit at 5 % or when overdue), null without one
    battery_level: battery == null ? null : batteryLevel.levelOf({ battery, sleeping: sleeper, reachable }, lowAt),
    http_user: httpUserOf(dev),
    config: dev.config || {},
    channels: channelKeys(dev.state).map((k) => ({ key: k, type: k.split(':')[0] })),
    resources: resources.map((r) => ({
      id: r.id, kind: r.kind, name: r.name, area: r.area || null, enabled: r.enabled, capabilities: r.capabilities, state: r.state,
      owners: (owners.get(r.id) || []).filter((uid) => users.has(uid)).map((uid) => users.get(uid)),
    })),
  };
}

/** A Tuya device for the page: its link, version, kind, the short id — never the key. */
function tuyaView(dev) {
  const t = (dev.config && dev.config.tuya) || {};
  const prof = tuya.cleanProfile(t.prof);
  const st = (dev.state && dev.state.tuya) || {};
  return {
    short: tuya.shortId(dev.prefix), link: st.link || null, ver: st.ver || t.ver || null, kind: prof.k, category: t.cat || null, ip_fixed: t.ip || null,
    dps: prof.k === 'other' && Array.isArray(t.dps) ? t.dps.slice(0, 32) : [],
    bools: prof.k === 'other' && Array.isArray(t.dps) ? t.dps.filter((x) => x && x.type === 'Boolean').map((x) => ({ dp: x.dp, code: x.code || null })).slice(0, 8) : [],
  };
}

// ─── Control ────────────────────────────────────

/** Switch / dim / move an edge resource; the cached state follows what was sent. */
async function setState(gc, resource, raw) {
  const dev = await es.getDevice(gc, resource.edge_device_id);
  if (!dev) throw codeError('SMARTHOME_RESOURCE_NOT_FOUND');
  const key = String(resource.deconz_id).split('/')[1] || '';
  const m = CH_RE.exec(key);
  if (!m) throw codeError('SMARTHOME_NOT_CONTROLLABLE');
  const type = m[1];
  const p = raw && typeof raw === 'object' ? raw : {};
  if (type === 'thermostat') return setThermostat(gc, resource, dev, key, p);
  if (dev.family === 'tuya') return setTuya(gc, resource, dev, key, type, p);
  let op = null;
  let value;
  if (type === 'cover') {
    if (['open', 'close', 'stop'].includes(p.cover)) op = p.cover;
    else if (typeof p.pos === 'number' && Number.isFinite(p.pos)) { op = 'pos'; value = Math.max(0, Math.min(100, Math.round(p.pos))); }
  } else if (type === 'light' && typeof p.bri === 'number' && Number.isFinite(p.bri) && p.on !== false) {
    op = 'bri'; value = Math.max(1, Math.min(100, Math.round(p.bri)));
  } else if ('on' in p) op = p.on ? 'on' : 'off';
  if (!op) throw codeError('SMARTHOME_INVALID_PATCH');
  if (!available(gc)) throw codeError('SMARTHOME_EDGE_UNAVAILABLE');
  try {
    await gc.edge.call(dev.gateway_id, 'command', { base: dev.base, family: dev.family, ch: key, op, ...(value !== undefined ? { value } : {}) }, { timeoutMs: CALL_MS });
  } catch (e) {
    const code = edgeErr(e);
    if (code === 'mqtt_off') throw codeError('SMARTHOME_MQTT_OFF');
    throw codeError('SMARTHOME_EDGE_UNREACHABLE', code);
  }
  const st = { ...(resource.state || {}) };
  if (op === 'on' || op === 'off') st.on = op === 'on';
  if (op === 'bri') { st.on = true; st.bri = value; }
  if (op === 'open' || op === 'close') st.moving = op === 'open' ? 'opening' : 'closing';
  if (op === 'stop') st.moving = null;
  if (op === 'pos') st.moving = value > (st.pos == null ? -1 : st.pos) ? 'opening' : 'closing';
  await es.setResourceState(gc, resource.id, st);
  return { ok: true };
}

/**
 * A Tuya channel (since 1.21.0): on / off, and a light also bri, ct (mired), hue + sat, scene — each its own command
 * (the edge part turns it into datapoints). The cached state follows.
 */
async function setTuya(gc, resource, dev, key, type, p) {
  const caps = resource.capabilities || {};
  const ops = [];
  const fin = (v) => typeof v === 'number' && Number.isFinite(v);
  if (type === 'light') {
    if (typeof p.scene === 'string') {
      if (!Array.isArray(caps.scenes) || !caps.scenes.includes(p.scene)) throw codeError('SMARTHOME_INVALID_PATCH');
      ops.push({ op: 'scene', value: p.scene });
    }
    if (fin(p.hue) || fin(p.sat)) {
      if (caps.color !== 'hs') throw codeError('SMARTHOME_INVALID_PATCH');
      const st0 = resource.state || {};
      ops.push({ op: 'color', value: { hue: Math.max(0, Math.min(65535, Math.round(fin(p.hue) ? p.hue : (fin(st0.hue) ? st0.hue : 0)))), sat: Math.max(0, Math.min(254, Math.round(fin(p.sat) ? p.sat : (fin(st0.sat) ? st0.sat : 254)))) } });
    }
    if (fin(p.ct)) {
      if (!caps.ct) throw codeError('SMARTHOME_INVALID_PATCH');
      ops.push({ op: 'ct', value: Math.max(153, Math.min(500, Math.round(p.ct))) });
    }
    if (fin(p.bri) && p.on !== false && caps.bri !== false) ops.push({ op: 'bri', value: Math.max(1, Math.min(100, Math.round(p.bri))) });
  }
  if (!ops.length && 'on' in p) ops.push({ op: p.on ? 'on' : 'off' });
  if (!ops.length) throw codeError('SMARTHOME_INVALID_PATCH');
  if (!available(gc)) throw codeError('SMARTHOME_EDGE_UNAVAILABLE');
  for (const o of ops) {
    try {
      await gc.edge.call(dev.gateway_id, 'command', { base: dev.base, family: 'tuya', ch: key, op: o.op, ...(o.value !== undefined ? { value: o.value } : {}) }, { timeoutMs: CALL_MS });
    } catch (e) {
      const code = edgeErr(e);
      if (code === 'tuya_key') throw codeError('SMARTHOME_TUYA_KEY');
      if (code === 'tuya_offline' || code === 'unknown_device') throw codeError('SMARTHOME_TUYA_OFFLINE');
      throw codeError('SMARTHOME_EDGE_UNREACHABLE', code);
    }
  }
  const st = { ...(resource.state || {}) };
  for (const o of ops) {
    if (o.op === 'on' || o.op === 'off') st.on = o.op === 'on';
    else st.on = true;
    if (o.op === 'bri') st.bri = o.value;
    if (o.op === 'ct') { st.ct = o.value; st.colormode = 'ct'; }
    if (o.op === 'color') { st.hue = o.value.hue; st.sat = o.value.sat; st.colormode = 'hs'; }
    if (o.op === 'scene') { st.scene = o.value; st.colormode = 'scene'; }
  }
  await es.setResourceState(gc, resource.id, st);
  return { ok: true };
}

/**
 * A thermostat (Shelly TRV, BLU TRV): { setpoint?, boost? (true / false), boost_minutes?, schedule_on: false? } — as the
 * heating's commandFor and the page send it. The cached state follows.
 */
async function setThermostat(gc, resource, dev, key, p) {
  const caps = resource.capabilities || {};
  const ops = [];
  if (p.schedule_on === false && caps.schedule) ops.push({ op: 'schedule_off' });
  if (p.boost === false && caps.boost) ops.push({ op: 'boost', value: 0 });
  if (typeof p.setpoint === 'number' && Number.isFinite(p.setpoint)) {
    ops.push({ op: 'setpoint', value: Math.max(TRV_LIMITS.min, Math.min(TRV_LIMITS.max, Math.round(p.setpoint * 2) / 2)) });
  }
  if (p.boost === true && caps.boost) ops.push({ op: 'boost', value: Math.max(1, Math.min(120, Math.round(finite(p.boost_minutes) || 30))) });
  if (!ops.length) throw codeError('SMARTHOME_INVALID_PATCH');
  if (!available(gc)) throw codeError('SMARTHOME_EDGE_UNAVAILABLE');
  for (const o of ops) {
    try {
      await gc.edge.call(dev.gateway_id, 'command', { base: dev.base, family: dev.family, ch: key, op: o.op, ...(o.value !== undefined ? { value: o.value } : {}) }, { timeoutMs: CALL_MS });
    } catch (e) {
      const code = edgeErr(e);
      if (code === 'mqtt_off') throw codeError('SMARTHOME_MQTT_OFF');
      throw codeError('SMARTHOME_EDGE_UNREACHABLE', code);
    }
  }
  const st = { ...(resource.state || {}) };
  for (const o of ops) {
    if (o.op === 'setpoint') st.setpoint = o.value;
    if (o.op === 'schedule_off') st.schedule_on = false;
    if (o.op === 'boost') st.boost_minutes = o.value;
  }
  await es.setResourceState(gc, resource.id, st);
  return { ok: true };
}

// ─── Automatic set-up (a job the page follows step by step) ───

const STEP_IDS = ['account', 'reach', 'auth', 'configure', 'online'];

function jobView(job) {
  const steps = STEP_IDS.map((id) => ({ id, ...job.steps[id] }));
  return { id: job.id, state: job.state, deviceId: job.deviceId, gatewayId: job.gatewayId, name: job.name, ip: job.ip, family: job.family, model: job.model, error: job.error || null, reason: job.reason || null, steps,
    httpUser: job.httpUser || HTTP_USER_DEFAULT };
}

function expireJobs(now = Date.now()) {
  for (const [id, job] of mem.jobs) {
    if (job.state === 'waiting' && now - job.configuredAt > ONLINE_WAIT_MS) { job.state = 'slow'; job.steps.online = { state: 'slow' }; }
    if (now - job.createdAt > JOB_TTL_MS) { job.secret = null; mem.jobs.delete(id); }
  }
}

async function runJob(gc, job, password) {
  const step = (id, v) => { job.steps[id] = v; };
  try {
    if (job.steps.account.state !== 'done') {
      step('account', { state: 'running' });
      const { device, password: secret } = await addDevice(gc, { gatewayId: job.gatewayId, name: job.name, area: job.area, family: job.family, candidate: job.candidate });
      job.deviceId = device.id;
      job.secret = secret;
      step('account', { state: 'done', username: device.mqtt_user, topic: `${device.base}/#` });
    }
    if (job.state === 'cancelled') return;
    if (job.steps.reach.state !== 'done') {
      step('reach', { state: 'running' });
      let info;
      try { info = await gc.edge.call(job.gatewayId, 'probe', { ip: job.ip }, { timeoutMs: SETUP_CALL_MS }); } catch (e) {
        const code = edgeErr(e);
        const reason = code === 'gateway_offline' ? await offlineReason(gc, job.gatewayId) : null;
        step('reach', { state: 'error', code, ...(reason ? { reason } : {}) });
        job.state = 'failed';
        job.error = code;
        job.reason = reason;
        return;
      }
      const dev = await es.getDevice(gc, job.deviceId);
      const patch = { model: cleanText(info.model, 40) || dev.model, firmware: cleanText(info.firmware, 60) || dev.firmware, mac: cleanText(info.mac, 20) || dev.mac, ip: job.ip };
      if (validFamily(info.family) && info.family !== dev.family && (info.family === 'tasmota') === (dev.family === 'tasmota')) patch.family = info.family;
      await es.updateDevice(gc, job.deviceId, patch);
      job.family = patch.family || job.family;
      job.model = patch.model || null;
      job.auth = info.auth === true;
      step('reach', { state: 'done', model: patch.model || null, firmware: patch.firmware || null, ident: cleanText(info.id, 64) || cleanText(info.mac, 20) || null });
      if (validFamily(info.family) && (info.family === 'tasmota') !== (dev.family === 'tasmota')) {
        // Shelly and Tasmota use other topics (shellies/ ↔ tasmota/): the account does not fit — set it up by hand
        step('reach', { state: 'error', code: 'family_mismatch' });
        job.state = 'failed';
        job.error = 'family_mismatch';
        return;
      }
    }
    if (job.state === 'cancelled') return;
    if (job.auth && !password) {
      step('auth', { state: 'need' });
      job.state = 'need_password';
      return;
    }
    if (!job.auth) step('auth', { state: 'skipped' });
    else step('auth', { state: 'done' });
    if (!job.secret) { step('configure', { state: 'error', code: 'password_gone' }); job.state = 'failed'; job.error = 'password_gone'; return; }
    step('configure', { state: 'running' });
    const dev = await es.getDevice(gc, job.deviceId);
    const httpUser = dev.family === 'shelly2' ? HTTP_USER_DEFAULT : (job.httpUser || httpUserOf(dev));
    try {
      // buttons: Tasmota's SetOption73 1 on request (the buttons report presses for the logic chains)
      await gc.edge.call(job.gatewayId, 'setup', { ip: job.ip, family: dev.family, user: dev.mqtt_user, pass: job.secret, prefix: dev.prefix, ...(password ? { password, ...(httpUser !== HTTP_USER_DEFAULT ? { httpUser } : {}) } : {}), ...(job.buttons && dev.family === 'tasmota' ? { buttons: true } : {}) }, { timeoutMs: SETUP_CALL_MS });
    } catch (e) {
      const code = edgeErr(e);
      if (code === 'auth_required' || code === 'auth_failed') {
        job.auth = true;
        step('auth', { state: 'need', code: code === 'auth_failed' ? 'auth_failed' : null });
        step('configure', { state: 'pending' });
        job.state = 'need_password';
        return;
      }
      const reason = code === 'gateway_offline' ? await offlineReason(gc, job.gatewayId) : null;
      step('configure', { state: 'error', code, ...(reason ? { reason } : {}) });
      job.state = 'failed';
      job.error = code;
      job.reason = reason;
      return;
    }
    job.secret = null;
    // the user name that worked stays with the device (for "Neues MQTT-Passwort" later)
    await es.updateDevice(gc, job.deviceId, { configured: true, ...(password && httpUser !== httpUserOf(dev) ? { config: withHttpUser(dev.config, httpUser) } : {}) });
    step('configure', { state: 'done' });
    job.configuredAt = Date.now();
    const now = await es.getDevice(gc, job.deviceId);
    if (now && now.last_seen_at && Date.parse(now.last_seen_at) >= job.createdAt) { step('online', { state: 'done' }); job.state = 'done'; } else { step('online', { state: 'running' }); job.state = 'waiting'; }
  } catch (e) {
    gc.log.warn('edge set-up failed', (e && (e.code || e.message)) || e);
    job.state = 'failed';
    job.error = (e && e.code) || 'error';
    for (const id of STEP_IDS) if (job.steps[id].state === 'running') job.steps[id] = { state: 'error', code: job.error };
  }
}

function newJob(o) {
  const job = {
    id: crypto.randomBytes(9).toString('base64url'), createdAt: Date.now(), configuredAt: 0, state: 'running', error: null, reason: null, secret: null, auth: false, httpUser: null,
    deviceId: o.deviceId || null, gatewayId: o.gatewayId, buttons: o.buttons === true, name: o.name, area: o.area, ip: o.ip, family: o.family, model: o.model || null, candidate: o.candidate || null,
    steps: { account: { state: 'pending' }, reach: { state: 'pending' }, auth: { state: 'pending' }, configure: { state: 'pending' }, online: { state: 'pending' } },
  };
  mem.jobs.set(job.id, job);
  return job;
}

// ─── Admin API: /edge/… ─────────────────────────

function bodyName(body) {
  const name = cleanText(body.name, NAME_MAX);
  if (!name) throw codeError('INVALID');
  return name;
}
const bodyArea = (body) => cleanText(body.area, AREA_MAX) || null;

async function usersAndOwners(gc, usersById) {
  return { users: await usersById(gc), owners: await store.allOwners(gc) };
}

async function getJob(gc, id) {
  expireJobs();
  const job = mem.jobs.get(String(id));
  if (!job) throw codeError('NOT_FOUND');
  if (job.state === 'waiting' && job.deviceId) {
    const dev = await es.getDevice(gc, job.deviceId);
    if (dev && dev.last_seen_at && Date.parse(dev.last_seen_at) >= job.createdAt) { job.steps.online = { state: 'done' }; job.state = 'done'; }
  }
  return job;
}

async function route(req, gc, seg, body, usersById) {
  const m = req.method;
  const [a, b, c] = seg;
  const posInt = (v) => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null; };

  if (a === 'gateways' && seg.length === 1 && m === 'GET') return { json: { ok: true, ...(await gateways(gc)) } };
  if (!available(gc)) throw codeError('SMARTHOME_EDGE_UNAVAILABLE');

  if (a === 'gateways' && seg.length === 3 && c === 'refresh' && m === 'POST') {
    const gw = await edgeGatewayOk(gc, b);
    await configureGateway(gc, gw);
    try { return { json: { ok: true, ...(await gc.edge.call(gw, 'refresh', {}, { timeoutMs: CALL_MS })) } }; } catch (e) { throw codeError('SMARTHOME_EDGE_UNREACHABLE', edgeErr(e)); }
  }

  if (a === 'tuya') return tuyaRoute(req, gc, seg.slice(1), body);

  if (a === 'found' && seg.length === 1 && m === 'GET') {
    const gw = await edgeGatewayOk(gc, req.query && req.query.gateway_id);
    return { json: { ok: true, devices: await newFound(gc, gw, { ask: req.query && req.query.ask === '1' }) } };
  }

  if (a === 'devices' && seg.length === 1 && m === 'GET') {
    const gw = posInt(req.query && req.query.gateway_id);
    const { users, owners } = await usersAndOwners(gc, usersById);
    const list = await es.listDevices(gc, gw || undefined);
    const lowAt = await batteryLowAt(gc);
    const devices = [];
    for (const d of list) devices.push(await deviceView(gc, d, users, owners, lowAt));
    return { json: { ok: true, devices } };
  }

  // manual set-up: device + account, the password once
  if (a === 'devices' && seg.length === 1 && m === 'POST') {
    const gw = await edgeGatewayOk(gc, body.gateway_id);
    const family = validFamily(body.family);
    if (!family) throw codeError('INVALID');
    const { device, password } = await addDevice(gc, { gatewayId: gw, name: bodyName(body), area: bodyArea(body), family, candidate: cleanCandidate(body.candidate) });
    return { json: { ok: true, device: { id: device.id }, credentials: credentials(device, password, await hostOf(gc, gw)) } };
  }

  if (a === 'devices' && b) {
    const id = posInt(b);
    const dev = id ? await es.getDevice(gc, id) : null;
    if (!dev) throw codeError('SMARTHOME_RESOURCE_NOT_FOUND');
    if (seg.length === 2 && m === 'GET') {
      const { users, owners } = await usersAndOwners(gc, usersById);
      return { json: { ok: true, device: await deviceView(gc, dev, users, owners, await batteryLowAt(gc)) } };
    }
    if (seg.length === 2 && m === 'PUT') {
      const patch = {};
      if (body.name !== undefined) patch.name = bodyName(body);
      if (body.area !== undefined) patch.area = bodyArea(body);
      if (body.channels !== undefined) {
        if (!body.channels || typeof body.channels !== 'object' || Array.isArray(body.channels)) throw codeError('INVALID');
        const channels = {};
        for (const [k, v] of Object.entries(body.channels).slice(0, 16)) {
          if ((!CH_RE.test(k) && k !== 'sensor') || !v || typeof v !== 'object') throw codeError('INVALID');
          const e = {};
          if (v.kind !== undefined) { if (!KINDS.has(v.kind) || !k.startsWith('switch:')) throw codeError('INVALID'); e.kind = v.kind; }
          if (v.cover !== undefined) { if (!COVERS.has(v.cover) || !k.startsWith('cover:')) throw codeError('INVALID'); e.cover = v.cover; }
          if (v.name !== undefined) { const n = cleanText(v.name, NAME_MAX); if (n) e.name = n; }
          channels[k] = e;
        }
        patch.config = { ...(dev.config || {}), channels };
      }
      if (body.http_user !== undefined) patch.config = withHttpUser(patch.config || dev.config, cleanHttpUser(body.http_user));
      let reconfigure = false;
      if (body.tuya !== undefined) {
        if (dev.family !== 'tuya' || !body.tuya || typeof body.tuya !== 'object') throw codeError('INVALID');
        const cfg = patch.config || dev.config || {};
        const t = { ...(cfg.tuya || {}) };
        if (body.tuya.ip !== undefined) {
          const ip = body.tuya.ip == null ? '' : String(body.tuya.ip).trim();
          if (ip && !(tuya.IP_RE.test(ip) && isPrivateIp(ip))) throw codeError('INVALID');
          if (ip) { t.ip = ip; patch.ip = ip; } else delete t.ip;
        }
        if (body.tuya.dp !== undefined) {
          // a device that is not supported: one of its on/off datapoints as a switch (or none again)
          const view = tuyaView(dev);
          if (body.tuya.dp === null) { if (tuya.cleanProfile(t.prof).k === 'switch' && t.chosen) { t.prof = { k: 'other' }; delete t.chosen; } } else {
            if (view.kind !== 'other' || !view.bools.some((x) => x.dp === body.tuya.dp)) throw codeError('INVALID');
            t.prof = { k: 'switch', sw: [body.tuya.dp] };
            t.chosen = true;
          }
        }
        patch.config = { ...cfg, tuya: t };
        reconfigure = true;
      }
      const next = await es.updateDevice(gc, dev.id, patch);
      await syncResources(gc, next);
      if (reconfigure) await configureGateway(gc, dev.gateway_id);
      return { json: { ok: true } };
    }
    if (seg.length === 2 && m === 'DELETE') {
      await removeDevice(gc, dev);
      return { json: { ok: true } };
    }
    // a Tuya device's key anew ("Key neu holen"): from the cloud (the access kept), or given (by hand, devices.json)
    if (seg.length === 3 && c === 'tuya_key' && m === 'POST') {
      if (dev.family !== 'tuya') throw codeError('INVALID');
      let key;
      if (body.source === 'cloud') {
        const creds = await savedCloud(gc);
        if (!creds) throw codeError('SMARTHOME_TUYA_NO_CLOUD');
        key = await tuya.cloudKey(gc, creds, dev.prefix);
      } else {
        key = typeof body.key === 'string' ? body.key.trim() : '';
        if (!tuya.KEY_RE.test(key)) throw codeError('INVALID');
      }
      await gc.settings.setSecret(tuya.keyName(dev.prefix), key);
      const cfg = dev.config || {};
      await es.updateDevice(gc, dev.id, { config: { ...cfg, tuya: { ...(cfg.tuya || {}), keyNoted: false } }, state: { ...(dev.state || {}), tuya: { ...((dev.state && dev.state.tuya) || {}), link: 'connecting' } } });
      await configureGateway(gc, dev.gateway_id);
      return { json: { ok: true } };
    }
    if (seg.length === 3 && c === 'owners' && m === 'PUT') {
      if (!Array.isArray(body.userIds) || body.userIds.length > 1000) throw codeError('SMARTHOME_USER_IDS_REQUIRED');
      for (const r of await es.deviceResources(gc, dev.id)) await store.setOwners(gc, r.id, body.userIds);
      return { json: { ok: true } };
    }
    // the device type of a manual set-up changed: same prefix, the account follows (shellies/ ↔ tasmota/)
    if (seg.length === 3 && c === 'family' && m === 'POST') {
      const family = validFamily(body.family);
      if (!family) throw codeError('INVALID');
      if (family === dev.family) return { json: { ok: true, credentials: null } };
      const base = baseOf(family, dev.prefix);
      if (base === dev.base) { await es.updateDevice(gc, dev.id, { family }); await configureGateway(gc, dev.gateway_id); return { json: { ok: true, credentials: null } }; }
      if (family === 'tasmota' && dev.prefix.length > prefixMax('tasmota')) throw codeError('SMARTHOME_PREFIX_TOO_LONG');
      await removeAccount(gc, dev.gateway_id, dev.mqtt_user);
      const account = await createAccount(gc, dev.gateway_id, dev.prefix, base, dev.name);
      const next = await es.updateDevice(gc, dev.id, { family, base, mqtt_user: account.username, state: {}, last_seen_at: null, online: null });
      for (const r of await es.deviceResources(gc, dev.id)) await es.removeChannel(gc, dev, String(r.deconz_id).split('/')[1]);
      await configureGateway(gc, dev.gateway_id);
      return { json: { ok: true, credentials: credentials(next, account.password, await hostOf(gc, dev.gateway_id)) } };
    }
    // a new account password: written into the device by the edge part when it can, else shown
    // body.device_password: the device's own password, for this one request (a device with a password could not
    // take the new account otherwise); never stored
    if (seg.length === 3 && c === 'password' && m === 'POST') {
      const devicePw = typeof body.device_password === 'string' && body.device_password && body.device_password.length <= 128 ? body.device_password : null;
      await removeAccount(gc, dev.gateway_id, dev.mqtt_user);
      const account = await createAccount(gc, dev.gateway_id, dev.prefix, dev.base, dev.name);
      const next = await es.updateDevice(gc, dev.id, { mqtt_user: account.username });
      let reason = 'no_address';
      if (dev.ip) {
        try {
          await gc.edge.call(dev.gateway_id, 'setup', { ip: dev.ip, family: dev.family, user: account.username, pass: account.password, prefix: dev.prefix, ...(devicePw ? { password: devicePw, ...(httpUserOf(dev) !== HTTP_USER_DEFAULT ? { httpUser: httpUserOf(dev) } : {}) } : {}) }, { timeoutMs: SETUP_CALL_MS });
          return { json: { ok: true, applied: true } };
        } catch (e) { reason = edgeErr(e); }
      }
      return { json: { ok: true, applied: false, reason, credentials: credentials(next, account.password, await hostOf(gc, dev.gateway_id)) } };
    }
    throw codeError('NOT_FOUND');
  }

  // automatic set-up
  if (a === 'setup' && seg.length === 1 && m === 'POST') {
    const gw = await edgeGatewayOk(gc, body.gateway_id);
    const cand = cleanCandidate(body.candidate);
    if (!cand) throw codeError('INVALID');
    const job = newJob({ gatewayId: gw, name: bodyName(body), area: bodyArea(body), ip: cand.ip, family: cand.family, model: cand.model, candidate: cand, buttons: cand.family === 'tasmota' && body.buttons === true });
    runJob(gc, job, null);
    return { json: { ok: true, job: jobView(job) } };
  }
  if (a === 'setup' && b) {
    const job = await getJob(gc, b);
    if (seg.length === 2 && m === 'GET') return { json: { ok: true, job: jobView(job) } };
    if (seg.length === 3 && c === 'password' && m === 'POST') {
      const pw = typeof body.password === 'string' ? body.password : '';
      if (!pw || pw.length > 128 || job.state !== 'need_password') throw codeError('INVALID');
      job.httpUser = body.user === undefined ? job.httpUser : cleanHttpUser(body.user);
      job.state = 'running';
      job.steps.auth = { state: 'running' };
      runJob(gc, job, pw);
      return { json: { ok: true, job: jobView(job) } };
    }
    if (seg.length === 3 && c === 'manual' && m === 'POST') {
      const dev = job.deviceId ? await es.getDevice(gc, job.deviceId) : null;
      if (!dev) throw codeError('NOT_FOUND');
      const password = job.secret;
      job.secret = null;
      job.state = 'manual';
      return { json: { ok: true, device: { id: dev.id }, credentials: credentials(dev, password, await hostOf(gc, dev.gateway_id)) } };
    }
    if (seg.length === 2 && m === 'DELETE') {
      job.secret = null;
      const configured = job.steps.configure.state === 'done';
      job.state = 'cancelled';
      mem.jobs.delete(job.id);
      if (!configured && job.deviceId) {
        const dev = await es.getDevice(gc, job.deviceId);
        if (dev && !dev.last_seen_at) await removeDevice(gc, dev);
      }
      return { json: { ok: true } };
    }
  }
  throw codeError('NOT_FOUND');
}

// ─── Tuya: the assistant "Tuya-Geräte hinzufügen" (server/tuya.js) ───

function isPrivateIp(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

async function savedCloud(gc) {
  const raw = await gc.settings.get(tuya.CLOUD_KEY).catch(() => null);
  if (typeof raw !== 'string' || !raw) return null;
  try { return tuya.cleanCreds(JSON.parse(raw)); } catch { return null; }
}

/** The optional capabilities Tuya needs on a gateway: confirmed, missing, asked for; whether the gateway is new enough. */
async function tuyaCaps(gc, gatewayId) {
  const need = tuya.CAPS;
  if (typeof gc.edge.capabilities !== 'function') return { ok: false, host: false, approved: [], missing: need.slice(), requested: [], unsupported: [], gatewaySupported: null, link: `/gateways#gw/${gatewayId}/edge` };
  let c = {};
  try { c = await gc.edge.capabilities(gatewayId); } catch (e) { throw codeError('SMARTHOME_EDGE_UNREACHABLE', edgeErr(e)); }
  const has = (list, k) => Array.isArray(list) && list.includes(k);
  const approved = need.filter((k) => has(c.approved, k));
  const unsupported = need.filter((k) => has(c.unsupported, k));
  return {
    ok: approved.length === need.length, host: true, approved, missing: need.filter((k) => !approved.includes(k)), requested: need.filter((k) => has(c.requested, k)),
    unsupported, gatewaySupported: typeof c.gatewaySupported === 'boolean' ? c.gatewaySupported : null, link: `/gateways#gw/${gatewayId}/edge`,
  };
}

/** How many Tuya devices a gateway takes (its edge part says: TCP connections minus a few), and how many it has. */
async function tuyaLimit(gc, gatewayId) {
  let max = tuya.LIMIT_DEFAULT;
  try {
    const info = await gc.edge.call(gatewayId, 'info', {}, { timeoutMs: INFO_MS });
    if (info && info.tuya && Number.isInteger(info.tuya.max) && info.tuya.max > 0) max = info.tuya.max;
  } catch { /* the default */ }
  const count = (await es.listDevices(gc, gatewayId)).filter((d) => d.family === 'tuya').length;
  return { max, count, warn: Math.max(1, max - 8) };
}

/** The devices of a manual entry, a devices.json or the cloud → the session's list. */
async function tuyaSource(gc, body) {
  if (body.source === 'cloud') {
    let creds;
    if (body.saved === true) {
      creds = await savedCloud(gc);
      if (!creds) throw codeError('SMARTHOME_TUYA_NO_CLOUD');
    } else creds = tuya.cleanCreds(body);
    const list = await tuya.cloudDevices(gc, creds);
    if (body.keep === false) await gc.settings.setSecret(tuya.CLOUD_KEY, null);
    else if (body.saved !== true) await gc.settings.setSecret(tuya.CLOUD_KEY, JSON.stringify(creds));
    return list;
  }
  if (body.source === 'file') {
    if (!Array.isArray(body.devices) || !body.devices.length || body.devices.length > 200) throw codeError('INVALID');
    const list = body.devices.map(tuya.fromRaw).filter(Boolean);
    if (!list.length) throw codeError('SMARTHOME_TUYA_FILE');
    return list;
  }
  if (body.source === 'manual') {
    const e = tuya.fromRaw({ id: typeof body.id === 'string' ? body.id.trim() : '', key: typeof body.key === 'string' ? body.key.trim() : '', name: body.name, ip: body.ip });
    if (!e || !e.key) throw codeError('INVALID');
    const want = ['plug', 'switch', 'light'].includes(body.kind) ? body.kind : null;
    const ip = typeof body.ip === 'string' && body.ip.trim() ? body.ip.trim() : null;
    if (ip && !(tuya.IP_RE.test(ip) && isPrivateIp(ip))) throw codeError('INVALID');
    return [{ ...e, ip, manual: true, want, fixedIp: ip }];
  }
  throw codeError('INVALID');
}

async function tuyaRoute(req, gc, seg, body) {
  const m = req.method;
  const [a] = seg;
  if (a === 'status' && seg.length === 1 && m === 'GET') {
    const gw = await edgeGatewayOk(gc, req.query && req.query.gateway_id);
    const creds = await savedCloud(gc);
    return { json: { ok: true, caps: await tuyaCaps(gc, gw), cloud: { saved: !!creds, region: creds ? creds.region : null }, limit: await tuyaLimit(gc, gw), regions: Object.keys(tuya.REGIONS) } };
  }
  // ask an administrator for the rights that are missing (one note per gateway and right per 24 hours)
  if (a === 'request' && seg.length === 1 && m === 'POST') {
    const gw = await edgeGatewayOk(gc, body.gateway_id);
    if (typeof gc.edge.requestCapability !== 'function') throw codeError('SMARTHOME_EDGE_UNAVAILABLE');
    const caps = await tuyaCaps(gc, gw);
    for (const k of caps.missing) {
      try { await gc.edge.requestCapability(gw, k); } catch (e) { gc.log.warn('tuya capability request failed', k, edgeErr(e)); }
    }
    return { json: { ok: true, caps: await tuyaCaps(gc, gw) } };
  }
  if (a === 'cloud' && seg.length === 1 && m === 'DELETE') {
    await gc.settings.setSecret(tuya.CLOUD_KEY, null);
    return { json: { ok: true } };
  }
  if (a === 'import' && seg.length === 1 && m === 'POST') {
    const gw = await edgeGatewayOk(gc, body.gateway_id);
    const list = await tuyaSource(gc, body);
    const exists = new Set((await es.listDevices(gc, gw)).map((d) => d.base));
    const s = tuya.newSession(gw, list, exists);
    for (const d of s.devices) {
      if (d.manual) { d.supported = true; d.reason = null; d.prof = { k: 'auto' }; }
    }
    return { json: { ok: true, ...tuya.sessionOut(s) } };
  }
  if (a === 'scan' && seg.length === 1 && m === 'POST') {
    const s = tuya.getSession(body.session);
    let r;
    try { r = await gc.edge.call(s.gatewayId, 'tuya.scan', { seconds: tuya.SCAN_S }, { timeoutMs: (tuya.SCAN_S + 10) * 1000 }); } catch (e) { throw codeError('SMARTHOME_EDGE_UNREACHABLE', edgeErr(e)); }
    for (const f of (r && Array.isArray(r.found) ? r.found : []).slice(0, 256)) {
      const d = f && s.devices.find((x) => x.id === f.id);
      if (!d) continue;
      d.found = true;
      if (typeof f.ip === 'string' && tuya.IP_RE.test(f.ip) && isPrivateIp(f.ip) && !d.fixedIp) d.ip = f.ip;
      if (tuya.VERSIONS.includes(f.ver)) d.ver = f.ver;
    }
    s.scanned = true;
    return { json: { ok: true, ...tuya.sessionOut(s), udp: (r && typeof r.udp === 'string' ? r.udp : null), denied: !!(r && r.denied) } };
  }
  if (a === 'add' && seg.length === 1 && m === 'POST') {
    const s = tuya.getSession(body.session);
    if (!Array.isArray(body.devices) || body.devices.length > 200) throw codeError('INVALID');
    const lim = await tuyaLimit(gc, s.gatewayId);
    let count = lim.count;
    const added = [];
    let limited = 0;
    for (const item of body.devices) {
      const d = item && s.devices.find((x) => x.ref === item.ref);
      if (!d || d.exists) continue;
      let prof = d.prof;
      if (!d.supported) {
        if (d.reason !== 'unsupported' || !Number.isInteger(item.dp) || !d.bools.some((b) => b.dp === item.dp)) continue;
        prof = { k: 'switch', sw: [item.dp] };
      }
      if (count >= lim.max) { limited++; continue; }
      const ipIn = typeof item.ip === 'string' && item.ip.trim() ? item.ip.trim() : null;
      if (ipIn && !(tuya.IP_RE.test(ipIn) && isPrivateIp(ipIn))) throw codeError('INVALID');
      const fixed = ipIn || d.fixedIp || null;
      const name = cleanText(item.name, NAME_MAX) || d.name || d.product || `Tuya ${tuya.shortId(d.id)}`;
      const t = { cat: d.category || null, ...(d.ver ? { ver: d.ver } : {}), prof: tuya.cleanProfile(prof), ...(fixed ? { ip: fixed } : {}), ...(d.want ? { want: d.want } : {}), ...(!d.supported ? { chosen: true } : {}) };
      const dev = await es.createDevice(gc, { gateway_id: s.gatewayId, base: `tuya/${d.id}`, prefix: d.id, family: 'tuya', name, area: cleanText(item.area, AREA_MAX) || null, model: d.product, ip: fixed || d.ip, config: { tuya: t } });
      await gc.settings.setSecret(tuya.keyName(d.id), d.key);
      d.exists = true;
      count++;
      added.push(dev.id);
    }
    if (added.length) await configureGateway(gc, s.gatewayId);
    return { json: { ok: true, added: added.length, ids: added, limited, max: lim.max } };
  }
  throw codeError('NOT_FOUND');
}

// ─── Background ─────────────────────────────────

/** Reachability of every edge resource follows the device's last report; jobs expire; orphaned accounts go. */
async function tick(gc, now = Date.now()) {
  expireJobs(now);
  const devices = new Map((await es.listDevices(gc)).map((d) => [d.id, d]));
  for (const r of await es.allEdgeResources(gc)) {
    const dev = devices.get(r.edge_device_id);
    if (!dev) continue;
    const reachable = reachableOf(dev, now) && r.state.paired !== false;
    if (r.state.reachable !== reachable) await es.setResourceState(gc, r.id, { ...r.state, reachable });
  }
  if (available(gc) && now - mem.orphanAt > ORPHAN_RETRY_MS) {
    mem.orphanAt = now;
    await retryOrphans(gc).catch(() => null);
  }
  await recheckZ2m(gc);
}

/**
 * The chains with zigbee2mqtt devices of a gateway wait for zigbee2mqtt/# (server/edgerules.js configFor): once an
 * administrator confirmed it (or took it back) the gateway gets its list again. GateControl tells the plugin nothing
 * about it, so every tick asks for the gateways that have such chains.
 */
async function recheckZ2m(gc) {
  if (!available(gc) || !edgerules.z2mHost(gc)) return;
  if (!mem.z2mSeen) {
    // after a start of the plugin: a gateway with chains not configured since is looked at once (configFor tells
    // which use zigbee2mqtt); one that does gets its list, whatever was confirmed meanwhile
    mem.z2mSeen = true;
    const ids = (await gc.db.query("SELECT DISTINCT gateway_id FROM rules WHERE source = 'edge' AND enabled = 1")).rows.map((r) => Number(r.gateway_id));
    for (const id of ids) {
      if (edgerules._z2mMem.has(id)) continue;
      await edgerules.configFor(gc, id).catch(() => null);
      const m = edgerules._z2mMem.get(id);
      if (m && m.uses) await configureGateway(gc, id);
    }
  }
  for (const [gatewayId, m] of edgerules._z2mMem) {
    if (!m.uses) continue;
    const approved = await edgerules.z2mApproved(gc, gatewayId);
    if (approved !== m.approved) await configureGateway(gc, gatewayId);
  }
}

module.exports = {
  available, setup, gateways, configureGateway, catchUp, testRule, route, tick, recheckZ2m, setState, applySnapshot, syncResources, reachableOf, sleeperOf, httpUserOf, slugify, semverAtLeast,
  jobView, MIN_GATEWAY, STALE_MS, SENSOR_STALE_MS, _mem: mem,
};
