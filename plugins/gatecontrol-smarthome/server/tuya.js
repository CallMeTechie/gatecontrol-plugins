'use strict';

// Tuya devices (since 1.21.0) — the server side. They are spoken to locally by the edge part of the GateControl gateway
// in their home network (edge/tuya.js); the Tuya cloud is asked only to fetch the device list and the local keys, once,
// when an administrator presses "Geräte holen" or "Key neu holen" (or never: devices.json of "tinytuya wizard" or a key
// entered by hand). The devices are edge_devices rows like Shelly and Tasmota (family 'tuya', base 'tuya/<device id>',
// prefix = the device id, no MQTT account), their channels resources (switch:<n>, light:0).
//
//   keys        gc.settings.setSecret('tuya.key.<device id>') — never in a table, a log or an answer to the browser; they
//               reach the gateway with gc.edge.configure (and are kept there in the edge part's gc.store, so the devices
//               go on after a restart without the server)
//   cloud       gc.settings.setSecret('tuya.cloud') { id, secret, region } when "Zugang behalten" is ticked (default) — for
//               "Key neu holen" without typing it again; requests only to the regions' hosts of plugin.json
//   profile     which datapoint is what (edge/tuya.js toPatch): from the mapping of the cloud / devices.json, else from the
//               category's standard codes, else from the device's first status (kind 'auto', classify())
//   import      a session (30 minutes, in memory) with the devices found — the browser gets names, kinds and the last four
//               characters of the ids, never a key; then the gateway listens (tuya.scan) and the chosen ones are added
//   rights      tcp.lan, udp.port:6666/6667/7000 and udp.broadcast are optional capabilities (plugin.json): asked for with
//               gc.edge.requestCapability, an administrator confirms them per gateway (GateControl › Gateways › the gateway
//               › Edge-Plugins › Zusätzliche Rechte)
//   key changed a device that refuses its key (it was paired anew in the Tuya app) shows "Key passt nicht mehr"; the
//               administrators get one notification per device (topic gateway_unreachable)

const crypto = require('node:crypto');
const { codeError } = require('./deconz');

const REGIONS = Object.freeze({
  eu: 'openapi.tuyaeu.com', weu: 'openapi-weaz.tuyaeu.com', us: 'openapi.tuyaus.com', use: 'openapi-ueaz.tuyaus.com', in: 'openapi.tuyain.com', cn: 'openapi.tuyacn.com',
});
const CAPS = Object.freeze(['tcp.lan', 'udp.port:6666', 'udp.port:6667', 'udp.port:7000', 'udp.broadcast']);
const CLOUD_KEY = 'tuya.cloud';
const keyName = (id) => `tuya.key.${id}`;
const ID_RE = /^[A-Za-z0-9]{8,32}$/;
const KEY_RE = /^[\x21-\x7e]{16}$/;
const IP_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const VERSIONS = ['3.1', '3.2', '3.3', '3.4', '3.5'];
const SESSION_MS = 30 * 60 * 1000;
const SESSIONS_MAX = 8;
const IMPORT_MAX = 200;
const SCAN_S = 15;
const CLOUD_MS = 15000;
const PAGES_MAX = 10;
const LIMIT_DEFAULT = 60;
const NAME_MAX = 60;

const LIGHTS = new Set(['dj', 'dd', 'fwd', 'dc', 'xdd']);
const PLUGS = new Set(['cz', 'pc']);
const SWITCHES = new Set(['kg', 'tdq']);
const HUBS = new Set(['wg2', 'wg', 'wfcon']);
const SWITCH_CODES = ['switch', 'switch_1', 'switch_2', 'switch_3', 'switch_4', 'switch_5', 'switch_6', 'switch_7', 'switch_8',
  'switch_usb1', 'switch_usb2', 'switch_usb3', 'switch_usb4', 'switch_usb5', 'switch_usb6'];

const mem = { sessions: new Map(), noted: new Set() };

function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** "bf…a1c2": what the page shows of a device id. */
const shortId = (id) => `${String(id).slice(0, 2)}…${String(id).slice(-4)}`;

// ─── Datapoints → profile ───────────────────────

function parseValues(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  if (typeof v === 'string' && v.length <= 4096) { try { const o = JSON.parse(v); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { return {}; } }
  return {};
}

/**
 * A mapping → [{ dp, code, type, values }]: devices.json { "<dp>": { code, type, values } }, or the cloud's
 * [{ dp_id, code, type, values }]. At most 64, sorted by dp.
 */
function cleanMapping(m) {
  const out = new Map();
  const add = (dp, e) => {
    const n = Number(dp);
    if (!Number.isInteger(n) || n < 1 || n > 255 || !e || typeof e.code !== 'string' || !/^[a-z0-9_]{1,40}$/.test(e.code) || out.has(n) || out.size >= 64) return;
    const values = parseValues(e.values);
    const keep = {};
    for (const k of ['min', 'max', 'scale', 'step']) if (typeof values[k] === 'number' && Number.isFinite(values[k])) keep[k] = values[k];
    out.set(n, { dp: n, code: e.code, type: typeof e.type === 'string' ? e.type.slice(0, 16) : null, values: keep });
  };
  if (Array.isArray(m)) for (const e of m.slice(0, 128)) add(e && (e.dp_id != null ? e.dp_id : e.dp), e);
  else if (m && typeof m === 'object') for (const [dp, e] of Object.entries(m).slice(0, 128)) add(dp, e);
  return [...out.values()].sort((a, b) => a.dp - b.dp);
}

/** Which datapoint is what — from the mapping and the category (null: not a device of stage 1, { k: 'auto' }: from its status). */
function profileOf(category, mapping) {
  const list = Array.isArray(mapping) ? mapping : [];
  const by = new Map(list.map((e) => [e.code, e]));
  const dp = (...codes) => { for (const c of codes) if (by.has(c)) return by.get(c).dp; return null; };
  const val = (code, key, d) => { const e = by.get(code); return e && typeof e.values[key] === 'number' ? e.values[key] : d; };
  const cat = String(category || '');
  if (LIGHTS.has(cat) || by.has('switch_led')) {
    if (!by.has('switch_led')) return { k: 'auto' };
    const v2 = by.has('bright_value_v2') || by.has('temp_value_v2') || by.has('colour_data_v2') || (!by.has('bright_value') && by.has('work_mode'));
    const briCode = v2 ? 'bright_value_v2' : 'bright_value';
    const tempCode = v2 ? 'temp_value_v2' : 'temp_value';
    const l = {
      v: v2 ? 2 : 1, sw: dp('switch_led'), mode: dp('work_mode'), bri: dp(briCode, 'bright_value', 'bright_value_v2'), temp: dp(tempCode, 'temp_value', 'temp_value_v2'),
      col: dp(v2 ? 'colour_data_v2' : 'colour_data', 'colour_data', 'colour_data_v2'), scene: v2 ? dp('scene_data_v2') : null,
      bmin: val(briCode, 'min', v2 ? 10 : 25), bmax: val(briCode, 'max', v2 ? 1000 : 255), tmax: val(tempCode, 'max', v2 ? 1000 : 255),
    };
    if (!(l.bmax > l.bmin)) { l.bmin = v2 ? 10 : 25; l.bmax = v2 ? 1000 : 255; }
    if (!(l.tmax > 0)) l.tmax = v2 ? 1000 : 255;
    return { k: 'light', l };
  }
  const sw = SWITCH_CODES.filter((c) => by.has(c)).map((c) => by.get(c).dp).slice(0, 8);
  if (PLUGS.has(cat) || SWITCHES.has(cat) || (sw.length && !cat)) {
    if (!sw.length) return { k: 'auto' };
    const p = { k: PLUGS.has(cat) ? 'plug' : 'switch', sw };
    const pw = dp('cur_power');
    if (pw) { p.pw = pw; p.pws = Number.isInteger(val('cur_power', 'scale', 1)) ? val('cur_power', 'scale', 1) : 1; }
    return p;
  }
  return null;
}

/**
 * The kind from a device's first status (a key entered by hand, a devices.json without mapping): 20 on/off → light v2;
 * 1 on/off and 3 a number → light v1; else the on/off datapoints 1…6 (7: USB) → switches, 19 → power. null: nothing of it.
 * `want`: the kind chosen by hand (plug | switch | light).
 */
function classify(dps, want, category) {
  const d = dps && typeof dps === 'object' ? dps : {};
  const isB = (k) => typeof d[k] === 'boolean';
  const isN = (k) => typeof d[k] === 'number';
  const isS = (k) => typeof d[k] === 'string';
  const lightWanted = want === 'light' || LIGHTS.has(category);
  const plugWanted = want === 'plug' || want === 'switch' || PLUGS.has(category) || SWITCHES.has(category);
  if (!plugWanted && isB('20') && (isN('22') || isS('21') || lightWanted)) {
    return { k: 'light', l: { v: 2, sw: 20, mode: isS('21') ? 21 : null, bri: isN('22') ? 22 : null, temp: isN('23') ? 23 : null, col: isS('24') ? 24 : null, scene: isS('25') ? 25 : null, bmin: 10, bmax: 1000, tmax: 1000 } };
  }
  if (!plugWanted && isB('1') && isN('3') && (isS('2') || lightWanted)) {
    return { k: 'light', l: { v: 1, sw: 1, mode: isS('2') ? 2 : null, bri: 3, temp: isN('4') ? 4 : null, col: isS('5') ? 5 : null, scene: null, bmin: 25, bmax: 255, tmax: 255 } };
  }
  const sw = ['1', '2', '3', '4', '5', '6', '7'].filter(isB).map(Number);
  if (sw.length && !lightWanted) {
    const p = { k: want === 'switch' || SWITCHES.has(category) ? 'switch' : (want === 'plug' || PLUGS.has(category) ? 'plug' : (sw.length > 1 ? 'switch' : 'plug')), sw };
    if (isN('19')) { p.pw = 19; p.pws = 1; }
    return p;
  }
  return null;
}

/** A profile as the edge part takes it (numbers checked again). */
function cleanProfile(p) {
  if (!p || typeof p !== 'object') return { k: 'auto' };
  const dp = (v) => (Number.isInteger(v) && v >= 1 && v <= 255 ? v : null);
  if (p.k === 'light' && p.l && typeof p.l === 'object') {
    const l = p.l;
    if (!dp(l.sw)) return { k: 'auto' };
    const n = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    return { k: 'light', l: { v: l.v === 1 ? 1 : 2, sw: dp(l.sw), mode: dp(l.mode), bri: dp(l.bri), temp: dp(l.temp), col: dp(l.col), scene: l.v === 1 ? null : dp(l.scene), bmin: n(l.bmin, 10), bmax: n(l.bmax, 1000), tmax: n(l.tmax, 1000) } };
  }
  if ((p.k === 'plug' || p.k === 'switch') && Array.isArray(p.sw)) {
    const sw = p.sw.map(dp).filter(Boolean).slice(0, 8);
    if (!sw.length) return { k: 'auto' };
    const out = { k: p.k, sw };
    if (dp(p.pw)) { out.pw = dp(p.pw); out.pws = Number.isInteger(p.pws) && p.pws >= 0 && p.pws <= 3 ? p.pws : 1; }
    return out;
  }
  return { k: p.k === 'other' ? 'other' : 'auto' };
}

/** The capabilities of a light resource from its profile: bri, ct, color 'hs', scenes. */
function lightCaps(prof) {
  const l = prof && prof.k === 'light' ? prof.l : null;
  if (!l) return {};
  return { bri: !!l.bri, ...(l.temp ? { ct: true } : {}), ...(l.col ? { color: 'hs' } : {}), ...(l.scene && l.v === 2 ? { scenes: ['night', 'read', 'work', 'leisure'] } : {}) };
}

// ─── Tuya cloud (once, on request) ──────────────

const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

function signed(creds, method, path, query, token) {
  const t = String(Date.now());
  const nonce = crypto.randomBytes(16).toString('hex');
  const qs = Object.keys(query || {}).sort().map((k) => `${k}=${query[k]}`).join('&');
  const url = qs ? `${path}?${qs}` : path;
  const toSign = [method, sha256hex(''), '', url].join('\n');
  const sign = crypto.createHmac('sha256', creds.secret).update(creds.id + (token || '') + t + nonce + toSign).digest('hex').toUpperCase();
  const headers = { client_id: creds.id, sign, t, sign_method: 'HMAC-SHA256', nonce };
  if (token) headers.access_token = token;
  return { url, headers };
}

/** Tuya's error codes → ours (the page has a text for each). */
function cloudError(code) {
  const c = Number(code);
  if ([1004, 1005, 1011, 1013, 2009, 2017].includes(c)) return codeError('SMARTHOME_TUYA_CLOUD_AUTH', `tuya ${c}`);
  if ([28841002, 28841101, 28841105, 1106, 1114].includes(c)) return codeError('SMARTHOME_TUYA_CLOUD_DENIED', `tuya ${c}`);
  return codeError('SMARTHOME_TUYA_CLOUD', `tuya ${Number.isFinite(c) ? c : 'error'}`);
}

async function cloudCall(gc, creds, method, path, query, token) {
  const host = REGIONS[creds.region];
  if (!host) throw codeError('INVALID');
  const { url, headers } = signed(creds, method, path, query, token);
  let r;
  try {
    r = await gc.http.fetch(`https://${host}${url}`, { method, headers, timeoutMs: CLOUD_MS });
  } catch (e) {
    throw codeError('SMARTHOME_TUYA_CLOUD', (e && e.code) || 'network');
  }
  let body = null;
  try { body = typeof r.body === 'string' ? JSON.parse(r.body) : r.body; } catch { body = null; }
  if (!body || typeof body !== 'object') throw codeError('SMARTHOME_TUYA_CLOUD', `http ${r.status}`);
  if (body.success !== true) throw cloudError(body.code);
  return body.result;
}

function cleanCreds(o) {
  const id = cleanText(o && o.id, 64);
  const secret = typeof (o && o.secret) === 'string' ? o.secret.trim() : '';
  const region = o && REGIONS[o.region] ? o.region : null;
  if (!/^[A-Za-z0-9]{8,64}$/.test(id) || !/^[A-Za-z0-9]{8,128}$/.test(secret) || !region) throw codeError('INVALID');
  return { id, secret, region };
}

async function token(gc, creds) {
  const r = await cloudCall(gc, creds, 'GET', '/v1.0/token', { grant_type: 1 }, null);
  if (!r || typeof r.access_token !== 'string') throw codeError('SMARTHOME_TUYA_CLOUD', 'no token');
  return r.access_token;
}

/** The datapoints of one device: their numbers (shadow/properties) and ranges (specification) → a mapping. */
async function cloudMapping(gc, creds, tok, id) {
  const spec = await cloudCall(gc, creds, 'GET', `/v1.0/iot-03/devices/${id}/specification`, null, tok).catch(() => null);
  const shadow = await cloudCall(gc, creds, 'GET', `/v2.0/cloud/thing/${id}/shadow/properties`, null, tok).catch(() => null);
  const ranges = new Map();
  const specList = spec && typeof spec === 'object' ? [...(Array.isArray(spec.status) ? spec.status : []), ...(Array.isArray(spec.functions) ? spec.functions : [])] : [];
  for (const e of specList.slice(0, 128)) if (e && typeof e.code === 'string' && !ranges.has(e.code)) ranges.set(e.code, e);
  const props = shadow && Array.isArray(shadow.properties) ? shadow.properties : [];
  const list = [];
  for (const p of props.slice(0, 128)) {
    if (!p || typeof p.code !== 'string') continue;
    const s = ranges.get(p.code) || {};
    list.push({ dp_id: p.dp_id, code: p.code, type: s.type || p.type, values: s.values });
  }
  // older answers: the specification itself names the numbers
  if (!list.length) for (const e of specList) if (e && e.dp_id != null) list.push(e);
  return cleanMapping(list);
}

/** Every device of the linked app accounts (with its local key) and, for the ones stage 1 knows, its datapoints. */
async function cloudDevices(gc, creds) {
  const tok = await token(gc, creds);
  const raw = [];
  const query = { size: 50 };
  for (let i = 0; i < PAGES_MAX; i++) {
    const r = await cloudCall(gc, creds, 'GET', '/v1.0/iot-01/associated-users/devices', query, tok);
    const list = r && Array.isArray(r.devices) ? r.devices : (Array.isArray(r) ? r : []);
    raw.push(...list);
    if (!r || !r.has_more || !r.last_row_key || raw.length >= IMPORT_MAX) break;
    query.last_row_key = r.last_row_key;
  }
  const out = [];
  for (const d of raw.slice(0, IMPORT_MAX)) {
    const e = fromRaw(d);
    if (!e) continue;
    if (e.key && (LIGHTS.has(e.category) || PLUGS.has(e.category) || SWITCHES.has(e.category)) && !e.sub) {
      e.mapping = await cloudMapping(gc, creds, tok, e.id).catch(() => []);
    }
    out.push(e);
  }
  return out;
}

/** The key of one device, anew (it was paired again). */
async function cloudKey(gc, creds, id) {
  const tok = await token(gc, creds);
  const r = await cloudCall(gc, creds, 'GET', `/v1.0/devices/${id}`, null, tok);
  const key = r && typeof r.local_key === 'string' ? r.local_key : null;
  if (!key || !KEY_RE.test(key)) throw codeError('SMARTHOME_TUYA_CLOUD', 'no key');
  return key;
}

/** A device of the cloud list or of devices.json → { id, key, name, category, product, sub, parent, mapping, ip, ver }. */
function fromRaw(d) {
  if (!d || typeof d !== 'object' || typeof d.id !== 'string' || !ID_RE.test(d.id)) return null;
  const key = typeof d.local_key === 'string' ? d.local_key : (typeof d.key === 'string' ? d.key : '');
  const parent = typeof d.parent === 'string' && ID_RE.test(d.parent) ? d.parent : (typeof d.gateway_id === 'string' && ID_RE.test(d.gateway_id) ? d.gateway_id : null);
  return {
    id: d.id, key: KEY_RE.test(key) ? key : null, name: cleanText(d.name, NAME_MAX) || null, category: cleanText(d.category, 16) || null,
    product: cleanText(d.product_name, 40) || cleanText(d.model, 40) || null,
    sub: d.sub === true || !!(typeof d.node_id === 'string' && d.node_id) || !!parent, parent,
    mapping: d.mapping ? cleanMapping(d.mapping) : [],
    ip: typeof d.ip === 'string' && IP_RE.test(d.ip) && isPrivate(d.ip) ? d.ip : null,
    ver: typeof d.version === 'string' && VERSIONS.includes(d.version) ? d.version : (typeof d.ver === 'string' && VERSIONS.includes(d.ver) ? d.ver : null),
  };
}

function isPrivate(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// ─── Import sessions ────────────────────────────

function expire(now = Date.now()) {
  for (const [id, s] of mem.sessions) if (now - s.at > SESSION_MS) mem.sessions.delete(id);
  while (mem.sessions.size > SESSIONS_MAX) mem.sessions.delete(mem.sessions.keys().next().value);
}

/** What stage 1 does with a device: { supported, reason, prof }. */
function judge(e) {
  if (HUBS.has(e.category)) return { supported: false, reason: 'hub', prof: null };
  if (e.sub) return { supported: false, reason: 'sub', prof: null };
  if (!e.key) return { supported: false, reason: 'no_key', prof: null };
  const prof = profileOf(e.category, e.mapping);
  if (!prof) return { supported: false, reason: 'unsupported', prof: null };
  return { supported: true, reason: null, prof };
}

function newSession(gatewayId, list, exists) {
  expire();
  const sid = crypto.randomBytes(12).toString('base64url');
  const devices = [];
  const hubs = new Map();
  for (const e of list) if (e.sub && e.parent) hubs.set(e.parent, (hubs.get(e.parent) || 0) + 1);
  list.slice(0, IMPORT_MAX).forEach((e, i) => {
    const j = judge(e);
    const bools = (e.mapping || []).filter((m) => m.type === 'Boolean').slice(0, 8).map((m) => ({ dp: m.dp, code: m.code }));
    devices.push({ ...e, ref: i + 1, ...j, bools, subs: hubs.get(e.id) || 0, exists: exists.has(`tuya/${e.id}`), found: false });
  });
  mem.sessions.set(sid, { id: sid, gatewayId, at: Date.now(), devices, scanned: false });
  return mem.sessions.get(sid);
}

function getSession(sid) {
  expire();
  const s = typeof sid === 'string' ? mem.sessions.get(sid) : null;
  if (!s) throw codeError('SMARTHOME_TUYA_SESSION');
  return s;
}

/** A device of a session as the page sees it — never the key, the id only shortened. */
function deviceOut(d) {
  return {
    ref: d.ref, short: shortId(d.id), name: d.name, category: d.category, product: d.product, kind: d.prof ? d.prof.k : null,
    channels: d.prof && Array.isArray(d.prof.sw) ? d.prof.sw.length : (d.prof && d.prof.k === 'light' ? 1 : 0), light: d.prof && d.prof.k === 'light' ? lightCaps(d.prof) : null,
    power: !!(d.prof && d.prof.pw), supported: d.supported, reason: d.reason, bools: d.bools, subs: d.subs, exists: d.exists,
    ip: d.ip, ver: d.ver, found: d.found,
  };
}

function sessionOut(s) {
  return { session: s.id, scanned: s.scanned, devices: s.devices.map(deviceOut) };
}

// ─── Notification "Key passt nicht mehr" ────────

const NOTE = {
  de: { title: 'Tuya: Key passt nicht mehr', body: '{{name}} lehnt den gespeicherten Local Key ab – vermutlich in der Tuya-App neu gekoppelt. In Smart Home „Key neu holen“.' },
  en: { title: 'Tuya: key no longer fits', body: '{{name}} refuses the stored local key – probably paired anew in the Tuya app. Use “Fetch key again” in Smart Home.' },
};

async function noteKey(gc, dev) {
  let lang = 'de';
  try { const all = await gc.settings.all(); if (all && all.notify_lang === 'en') lang = 'en'; } catch { /* default */ }
  const tx = NOTE[lang];
  await require('./alerts').notifierFor(gc).send({
    topic: 'gateway_unreachable', title: tx.title, body: tx.body.replace('{{name}}', dev.name || shortId(dev.prefix)), priority: 'normal',
    collapseKey: `tuya-key:${dev.id}`, ttl: 24 * 3600, users: null, data: { ...require('./notify').openAction(gc, lang), gateway_id: dev.gateway_id },
  }).catch((e) => gc.log.warn('tuya key notification failed', (e && e.code) || (e && e.message)));
}

module.exports = {
  REGIONS, CAPS, CLOUD_KEY, keyName, ID_RE, KEY_RE, IP_RE, VERSIONS, SCAN_S, LIMIT_DEFAULT, LIGHTS, PLUGS, SWITCHES, HUBS,
  shortId, cleanMapping, profileOf, classify, cleanProfile, lightCaps, signed, cloudCall, cloudDevices, cloudKey, cleanCreds, fromRaw,
  newSession, getSession, sessionOut, deviceOut, noteKey, judge, _mem: mem,
};
