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
// (gc.edge.configure { devices: [{ base, family }] }).

const crypto = require('node:crypto');
const store = require('./store');
const es = require('./edgestore');
const { codeError } = require('./deconz');

const MIN_GATEWAY = '1.19.0';
const CALL_MS = 10000;
const SETUP_CALL_MS = 30000;
const INFO_MS = 4000;
const STALE_MS = 30 * 60 * 1000;            // devices on mains: the edge part asks them every 10 minutes
const SENSOR_STALE_MS = 26 * 3600 * 1000;   // battery sensors sleep and report every few hours
const JOB_TTL_MS = 30 * 60 * 1000;
const ONLINE_WAIT_MS = 3 * 60 * 1000;
const ORPHAN_RETRY_MS = 5 * 60 * 1000;
const ORPHANS_KEY = 'edge.orphans';
const CH_RE = /^(switch|light|cover):(\d{1,2})$/;
const KINDS = new Set(['light', 'plug', 'relay']);
const COVERS = new Set(['shutter', 'awning', 'gate']);
const NAME_MAX = 60;
const AREA_MAX = 40;

const mem = {
  found: new Map(),   // gateway id → Map ip → candidate
  jobs: new Map(),    // job id → set-up job (with the account password while it runs)
  ready: false,
  orphanAt: 0,
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

/** What GateControl knows of the gateways the edge part is set up for, plus the edge part's own info. */
async function gateways(gc, { info = true } = {}) {
  if (!available(gc)) return { available: false, gateways: [] };
  let list = [];
  try { list = await gc.edge.gateways(); } catch (e) { gc.log.warn('edge gateways failed', edgeErr(e)); }
  const out = await Promise.all(list.map(async (g) => {
    const v = {
      id: g.id, name: g.name, state: g.state, online: g.online === true, version: g.version || null,
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
  const devices = (await es.listDevices(gc, gatewayId)).map((d) => ({ base: d.base, family: d.family }));
  try {
    await gc.edge.configure(Number(gatewayId), { devices });
    return true;
  } catch (e) {
    gc.log.debug('edge configure failed', gatewayId, edgeErr(e));
    return false;
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

/** Reachable: reported within the window and — on mains — not announced offline (LWT / "online"). */
function reachableOf(dev, now = Date.now()) {
  const seen = dev.last_seen_at ? Date.parse(dev.last_seen_at) : NaN;
  if (!Number.isFinite(seen)) return false;
  const sleeper = sensorOnly(dev);
  if (!sleeper && dev.online === false) return false;
  return now - seen <= (sleeper ? SENSOR_STALE_MS : STALE_MS);
}

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function defaultKind(dev, type) {
  if (type === 'light') return 'light';
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

function sensorState(s, reachable) {
  const st = { reachable, type: finite(s.temperature) != null ? 'temperature' : 'humidity' };
  st.value = st.type === 'temperature' ? s.temperature : finite(s.humidity);
  if (finite(s.humidity) != null) st.humidity = s.humidity;
  if (finite(s.battery) != null) st.battery = s.battery;
  return st;
}

function channelKeys(state) {
  const order = { cover: 0, light: 1, switch: 2 };
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
    let kind;
    if (type === 'cover') kind = 'cover';
    else if (type === 'light') kind = 'light';
    else kind = KINDS.has(cc.kind) ? cc.kind : defaultKind(dev, type);
    const name = cleanText(cc.name, NAME_MAX) || (keys.length === 1 ? dev.name : `${dev.name} ${i + 1}`);
    const capabilities = {
      source: 'edge', ch: key, bri: type === 'light', power: finite(c.power) != null || !!(prev && prev.capabilities && prev.capabilities.power),
      position: type === 'cover' && (c.pos != null || !!(prev && prev.capabilities && prev.capabilities.position)),
    };
    if (type === 'cover') capabilities.cover = COVERS.has(cc.cover) ? cc.cover : 'shutter';
    await es.upsertChannel(gc, dev, key, { kind, name, capabilities, area: dev.area, state: channelState(type, c, reachable, prev && prev.state, now) });
  }
  const s = (dev.state && dev.state.sensor) || {};
  if (finite(s.temperature) != null || finite(s.humidity) != null) {
    await es.upsertChannel(gc, dev, 'sensor', {
      kind: 'sensor', name: cleanText(chCfg.sensor && chCfg.sensor.name, NAME_MAX) || dev.name,
      capabilities: { source: 'edge', ch: 'sensor', reading: finite(s.temperature) != null ? 'temperature' : 'humidity' }, area: dev.area, state: sensorState(s, reachable),
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
    for (const f of ['bri', 'pos', 'power', 'energy', 'today']) if (finite(v[f]) != null) c[f] = v[f];
    if (v.pos === null) c.pos = null;
    if (v.moving === 'opening' || v.moving === 'closing') c.moving = v.moving;
    ch[k] = c;
  }
  const sensor = {};
  const s = (snap && snap.sensor) || {};
  for (const f of ['temperature', 'humidity', 'battery']) if (finite(s[f]) != null) sensor[f] = s[f];
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
  if (dev.family !== 'tasmota' && (snap.family === 'shelly1' || snap.family === 'shelly2') && snap.family !== dev.family) patch.family = snap.family;
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
  mem.ready = available(gc);
  if (!gc.edge) return false;
  gc.edge.on('$started', ({ gatewayId }) => configureGateway(gc, gatewayId));
  gc.edge.on('$online', ({ gatewayId }) => configureGateway(gc, gatewayId));
  gc.edge.on('states', (ev) => onStates(gc, ev));
  gc.edge.on('found', ({ gatewayId, data }) => rememberFound(gatewayId, data && data.devices));
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
  await configureGateway(gc, dev.gateway_id);
}

function validFamily(f) { return es.FAMILIES.has(f) ? f : null; }

/** The admin's view of a device (and its resources with owners). */
async function deviceView(gc, dev, users, owners) {
  const resources = await es.deviceResources(gc, dev.id);
  const reachable = reachableOf(dev);
  return {
    id: dev.id, gateway_id: dev.gateway_id, name: dev.name, area: dev.area || null, family: dev.family, model: dev.model || null, firmware: dev.firmware || null,
    ip: dev.ip || null, page: dev.ip ? `http://${dev.ip}/` : null, username: dev.mqtt_user || null, prefix: dev.prefix, base: dev.base, configured: dev.configured, online: dev.online,
    reachable, waiting: !dev.last_seen_at, last_seen_at: dev.last_seen_at || null, battery: dev.state && dev.state.sensor ? (finite(dev.state.sensor.battery)) : null,
    config: dev.config || {},
    channels: channelKeys(dev.state).map((k) => ({ key: k, type: k.split(':')[0] })),
    resources: resources.map((r) => ({
      id: r.id, kind: r.kind, name: r.name, area: r.area || null, enabled: r.enabled, capabilities: r.capabilities, state: r.state,
      owners: (owners.get(r.id) || []).filter((uid) => users.has(uid)).map((uid) => users.get(uid)),
    })),
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

// ─── Automatic set-up (a job the page follows step by step) ───

const STEP_IDS = ['account', 'reach', 'auth', 'configure', 'online'];

function jobView(job) {
  const steps = STEP_IDS.map((id) => ({ id, ...job.steps[id] }));
  return { id: job.id, state: job.state, deviceId: job.deviceId, gatewayId: job.gatewayId, name: job.name, ip: job.ip, family: job.family, model: job.model, error: job.error || null, steps };
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
        step('reach', { state: 'error', code: edgeErr(e) });
        job.state = 'failed';
        job.error = edgeErr(e);
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
    try {
      await gc.edge.call(job.gatewayId, 'setup', { ip: job.ip, family: dev.family, user: dev.mqtt_user, pass: job.secret, prefix: dev.prefix, ...(password ? { password } : {}) }, { timeoutMs: SETUP_CALL_MS });
    } catch (e) {
      const code = edgeErr(e);
      if (code === 'auth_required' || code === 'auth_failed') {
        job.auth = true;
        step('auth', { state: 'need', code: code === 'auth_failed' ? 'auth_failed' : null });
        step('configure', { state: 'pending' });
        job.state = 'need_password';
        return;
      }
      step('configure', { state: 'error', code });
      job.state = 'failed';
      job.error = code;
      return;
    }
    job.secret = null;
    await es.updateDevice(gc, job.deviceId, { configured: true });
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
    id: crypto.randomBytes(9).toString('base64url'), createdAt: Date.now(), configuredAt: 0, state: 'running', error: null, secret: null, auth: false,
    deviceId: o.deviceId || null, gatewayId: o.gatewayId, name: o.name, area: o.area, ip: o.ip, family: o.family, model: o.model || null, candidate: o.candidate || null,
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

  if (a === 'found' && seg.length === 1 && m === 'GET') {
    const gw = await edgeGatewayOk(gc, req.query && req.query.gateway_id);
    return { json: { ok: true, devices: await newFound(gc, gw, { ask: req.query && req.query.ask === '1' }) } };
  }

  if (a === 'devices' && seg.length === 1 && m === 'GET') {
    const gw = posInt(req.query && req.query.gateway_id);
    const { users, owners } = await usersAndOwners(gc, usersById);
    const list = await es.listDevices(gc, gw || undefined);
    const devices = [];
    for (const d of list) devices.push(await deviceView(gc, d, users, owners));
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
      return { json: { ok: true, device: await deviceView(gc, dev, users, owners) } };
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
      const next = await es.updateDevice(gc, dev.id, patch);
      await syncResources(gc, next);
      return { json: { ok: true } };
    }
    if (seg.length === 2 && m === 'DELETE') {
      await removeDevice(gc, dev);
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
    if (seg.length === 3 && c === 'password' && m === 'POST') {
      await removeAccount(gc, dev.gateway_id, dev.mqtt_user);
      const account = await createAccount(gc, dev.gateway_id, dev.prefix, dev.base, dev.name);
      const next = await es.updateDevice(gc, dev.id, { mqtt_user: account.username });
      let reason = 'no_address';
      if (dev.ip) {
        try {
          await gc.edge.call(dev.gateway_id, 'setup', { ip: dev.ip, family: dev.family, user: account.username, pass: account.password, prefix: dev.prefix }, { timeoutMs: SETUP_CALL_MS });
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
    const job = newJob({ gatewayId: gw, name: bodyName(body), area: bodyArea(body), ip: cand.ip, family: cand.family, model: cand.model, candidate: cand });
    runJob(gc, job, null);
    return { json: { ok: true, job: jobView(job) } };
  }
  if (a === 'setup' && b) {
    const job = await getJob(gc, b);
    if (seg.length === 2 && m === 'GET') return { json: { ok: true, job: jobView(job) } };
    if (seg.length === 3 && c === 'password' && m === 'POST') {
      const pw = typeof body.password === 'string' ? body.password : '';
      if (!pw || pw.length > 128 || job.state !== 'need_password') throw codeError('INVALID');
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

// ─── Background ─────────────────────────────────

/** Reachability of every edge resource follows the device's last report; jobs expire; orphaned accounts go. */
async function tick(gc, now = Date.now()) {
  expireJobs(now);
  const devices = new Map((await es.listDevices(gc)).map((d) => [d.id, d]));
  for (const r of await es.allEdgeResources(gc)) {
    const dev = devices.get(r.edge_device_id);
    if (!dev) continue;
    const reachable = reachableOf(dev, now);
    if (r.state.reachable !== reachable) await es.setResourceState(gc, r.id, { ...r.state, reachable });
  }
  if (available(gc) && now - mem.orphanAt > ORPHAN_RETRY_MS) {
    mem.orphanAt = now;
    await retryOrphans(gc).catch(() => null);
  }
}

module.exports = {
  available, setup, gateways, configureGateway, route, tick, setState, applySnapshot, syncResources, reachableOf, slugify, semverAtLeast,
  jobView, MIN_GATEWAY, STALE_MS, SENSOR_STALE_MS, _mem: mem,
};
