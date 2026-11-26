'use strict';

// Tuya devices in the home network, spoken to locally (since 1.21.0) — no Tuya cloud while they run. The edge part on
// the gateway holds one TCP connection per device (port 6668) and finds the devices by their UDP broadcasts:
//
//   protocol 3.1   55AA frames, CRC32; status in clear JSON, commands AES-128-ECB (the local key) in base64 with an MD5
//                  signature ("3.1" + 16 hex + base64)
//   protocol 3.2/3.3  55AA frames, CRC32; every payload AES-128-ECB with the local key, commands with the version header
//                  ("3.3" + 12 zero bytes) in front of the cipher text
//   protocol 3.4   55AA frames, HMAC-SHA256; a session key first (SESS_KEY_NEG_START / _RESP / _FINISH with two nonces),
//                  then every payload AES-128-ECB with the session key, the version header inside the cipher text;
//                  commands CONTROL_NEW (13) { protocol: 5, t, data: { dps } }, queries DP_QUERY_NEW (16) {}
//   protocol 3.5   6699 frames, AES-128-GCM (the header as additional data, a random 12-byte nonce); the same session
//                  key exchange (the key made with GCM), payloads as 3.4
//
// Discovery: 3.1 devices broadcast clear JSON to UDP 6666, 3.2–3.4 to 6667 (AES-ECB with the public discovery key
// md5("yGAdlopoPVldABfn")), 3.5 to 7000 (6699 frame, GCM with that key) — some 3.5 devices only after a request
// (REQ_DEVINFO 0x25 broadcast to port 7000). The JSON names the device id (gwId), its address and its version.
//
// Everything here is tested with vectors made by the tests themselves (test/tuya_protocol.test.js) — no real key.
//
//   pure:    pack / split / unpack / encodeCommand / decodePayload / decodeUdp / discoveryRequest / toPatch / toDps
//   manager: create({ tcp, now, setTimer, clearTimer, log, onUpdate(id), port }) → { set(list), command(id, dps),
//            query(id), seen(id, ip, ver), view(id), list(), stop() }

const crypto = require('node:crypto');

const PORT = 6668;
const UDP_PORTS = [6666, 6667, 7000];
const PREFIX_55AA = 0x000055aa;
const SUFFIX_55AA = 0x0000aa55;
const PREFIX_6699 = 0x00006699;
const SUFFIX_6699 = 0x00009966;
const CMD = Object.freeze({
  SESS_START: 3, SESS_RESP: 4, SESS_FINISH: 5, CONTROL: 7, STATUS: 8, HEART_BEAT: 9, DP_QUERY: 10, CONTROL_NEW: 13,
  DP_QUERY_NEW: 16, UPDATEDPS: 18, UDP_NEW: 19, BROADCAST_LPV34: 35, REQ_DEVINFO: 37,
});
// commands sent without the version header (tinytuya NO_PROTOCOL_HEADER_CMDS)
const NO_HEADER = new Set([CMD.DP_QUERY, CMD.DP_QUERY_NEW, CMD.UPDATEDPS, CMD.HEART_BEAT, CMD.SESS_START, CMD.SESS_RESP, CMD.SESS_FINISH, 0x40]);
const UDP_KEY = crypto.createHash('md5').update('yGAdlopoPVldABfn').digest();
const VERSIONS = ['3.1', '3.2', '3.3', '3.4', '3.5'];
const ID_RE = /^[A-Za-z0-9]{8,32}$/;
const KEY_RE = /^[\x21-\x7e]{16}$/;
const MAX_FRAME = 64 * 1024;
const MAX_BUFFER = 256 * 1024;

// ─── Crypto ─────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function ecbEncrypt(key, data, pad = true) {
  const c = crypto.createCipheriv('aes-128-ecb', key, null);
  c.setAutoPadding(pad);
  return Buffer.concat([c.update(data), c.final()]);
}

/** AES-128-ECB without trusting the padding: a valid PKCS#7 padding is taken off, else the bytes stay. null: no block multiple. */
function ecbDecrypt(key, data) {
  if (!data.length || data.length % 16) return null;
  const d = crypto.createDecipheriv('aes-128-ecb', key, null);
  d.setAutoPadding(false);
  const out = Buffer.concat([d.update(data), d.final()]);
  const n = out[out.length - 1];
  if (n >= 1 && n <= 16 && out.length >= n && out.subarray(out.length - n).every((b) => b === n)) return out.subarray(0, out.length - n);
  return out;
}

function gcmEncrypt(key, iv, aad, data) {
  const c = crypto.createCipheriv('aes-128-gcm', key, iv);
  if (aad) c.setAAD(aad);
  const ct = Buffer.concat([c.update(data), c.final()]);
  return { ct, tag: c.getAuthTag() };
}

function gcmDecrypt(key, iv, aad, ct, tag) {
  try {
    const d = crypto.createDecipheriv('aes-128-gcm', key, iv);
    if (aad) d.setAAD(aad);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]);
  } catch { return null; }
}

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const md5hex = (data) => crypto.createHash('md5').update(data).digest('hex');
const xor = (a, b) => Buffer.from(a.map((x, i) => x ^ b[i]));
const header = (ver) => Buffer.concat([Buffer.from(ver, 'latin1'), Buffer.alloc(12)]);

// ─── Frames ─────────────────────────────────────

/** A 55AA frame (3.1–3.4): CRC32 at the end, or HMAC-SHA256 with `hmacKey` (3.4). `retcode`: a device's answer (tests). */
function pack55(seq, cmd, payload, hmacKey = null, retcode = null) {
  const body = retcode == null ? payload : Buffer.concat([u32(retcode), payload]);
  const endLen = hmacKey ? 36 : 8;
  const head = Buffer.alloc(16);
  head.writeUInt32BE(PREFIX_55AA, 0);
  head.writeUInt32BE(seq >>> 0, 4);
  head.writeUInt32BE(cmd, 8);
  head.writeUInt32BE(body.length + endLen, 12);
  const data = Buffer.concat([head, body]);
  const check = hmacKey ? hmac(hmacKey, data) : u32(crc32(data));
  return Buffer.concat([data, check, u32(SUFFIX_55AA)]);
}

/** A 6699 frame (3.5): AES-128-GCM with `key`, the header (without the prefix) as additional data. */
function pack66(seq, cmd, payload, key, { iv = crypto.randomBytes(12), retcode = null } = {}) {
  const plain = retcode == null ? payload : Buffer.concat([u32(retcode), payload]);
  const head = Buffer.alloc(18);
  head.writeUInt32BE(PREFIX_6699, 0);
  head.writeUInt16BE(0, 4);
  head.writeUInt32BE(seq >>> 0, 6);
  head.writeUInt32BE(cmd, 10);
  head.writeUInt32BE(12 + plain.length + 16, 14);
  const { ct, tag } = gcmEncrypt(key, iv, head.subarray(4), plain);
  return Buffer.concat([head, iv, ct, tag, u32(SUFFIX_6699)]);
}

function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; }

/**
 * Cut whole frames out of a stream → { frames: [Buffer], rest: Buffer }. Bytes before a prefix are skipped; a frame
 * with a broken length or suffix is dropped (the search goes on after its prefix).
 */
function split(buf) {
  const frames = [];
  let i = 0;
  while (buf.length - i >= 16) {
    const p = buf.readUInt32BE(i);
    if (p !== PREFIX_55AA && p !== PREFIX_6699) { i++; continue; }
    const is66 = p === PREFIX_6699;
    if (is66 && buf.length - i < 18) break;
    const len = is66 ? buf.readUInt32BE(i + 14) : buf.readUInt32BE(i + 12);
    const total = is66 ? 18 + len + 4 : 16 + len;
    if (len < (is66 ? 28 : 8) || total > MAX_FRAME) { i++; continue; }
    if (buf.length - i < total) break;
    const frame = buf.subarray(i, i + total);
    const suffix = frame.readUInt32BE(total - 4);
    if (suffix !== (is66 ? SUFFIX_6699 : SUFFIX_55AA)) { i++; continue; }
    frames.push(Buffer.from(frame));
    i += total;
  }
  return { frames, rest: Buffer.from(buf.subarray(i)) };
}

/** A device's answer starts with a return code (00 00 00 0x) — taken off when it is there. */
function stripRetcode(p) {
  if (p.length >= 4 && p[0] === 0 && p[1] === 0 && p[2] === 0) return { retcode: p.readUInt32BE(0), payload: p.subarray(4) };
  return { retcode: null, payload: p };
}

/**
 * One frame → { seq, cmd, retcode, payload (clear for 6699, as sent for 55AA), ok } — ok false: the CRC / HMAC / GCM tag
 * does not fit (3.4 / 3.5: the key is wrong). `key`: the HMAC key (3.4) or the GCM key (3.5); null for CRC frames.
 */
function unpack(frame, key = null) {
  const p = frame.readUInt32BE(0);
  if (p === PREFIX_6699) {
    const len = frame.readUInt32BE(14);
    const seq = frame.readUInt32BE(6);
    const cmd = frame.readUInt32BE(10);
    if (!key) return { seq, cmd, retcode: null, payload: Buffer.alloc(0), ok: false };
    const iv = frame.subarray(18, 30);
    const ct = frame.subarray(30, 18 + len - 16);
    const tag = frame.subarray(18 + len - 16, 18 + len);
    const plain = gcmDecrypt(key, iv, frame.subarray(4, 18), ct, tag);
    if (!plain) return { seq, cmd, retcode: null, payload: Buffer.alloc(0), ok: false };
    return { seq, cmd, ...stripRetcode(plain), ok: true };
  }
  const seq = frame.readUInt32BE(4);
  const cmd = frame.readUInt32BE(8);
  const len = frame.readUInt32BE(12);
  const endLen = key ? 36 : 8;
  if (len < endLen) return { seq, cmd, retcode: null, payload: Buffer.alloc(0), ok: false };
  const dataEnd = 16 + len - endLen;
  const data = frame.subarray(0, dataEnd);
  const check = frame.subarray(dataEnd, dataEnd + endLen - 4);
  const ok = key ? crypto.timingSafeEqual(hmac(key, data), check) : crc32(data) === check.readUInt32BE(0);
  return { seq, cmd, ...stripRetcode(frame.subarray(16, dataEnd)), ok };
}

// ─── Payloads ───────────────────────────────────

const minor = (ver) => Number(String(ver).split('.')[1]) || 0;

/**
 * What to send for `cmd` with the JSON `body` (an object or a Buffer for the session messages) → the frame.
 *   ver '3.1' | '3.2' | '3.3' | '3.4' | '3.5', key: the local key (3.1–3.3) or the session key (3.4 / 3.5)
 */
function encodeCommand(ver, key, seq, cmd, body, { iv } = {}) {
  let p = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8');
  const v = minor(ver);
  if (v >= 5) {
    if (!NO_HEADER.has(cmd)) p = Buffer.concat([header(ver), p]);
    return pack66(seq, cmd, p, key, iv ? { iv } : {});
  }
  if (v === 4) {
    if (!NO_HEADER.has(cmd)) p = Buffer.concat([header(ver), p]);
    return pack55(seq, cmd, ecbEncrypt(key, p), key);
  }
  if (v >= 2) {
    p = ecbEncrypt(key, p);
    if (!NO_HEADER.has(cmd)) p = Buffer.concat([header(ver), p]);
    return pack55(seq, cmd, p);
  }
  if (cmd === CMD.CONTROL) {
    const b64 = ecbEncrypt(key, p).toString('base64');
    const sig = md5hex(Buffer.concat([Buffer.from(`data=${b64}||lpv=3.1||`, 'latin1'), key])).slice(8, 24);
    p = Buffer.from(`3.1${sig}${b64}`, 'latin1');
  }
  return pack55(seq, cmd, p);
}

const looksVersion = (p) => p.length >= 3 && p[0] === 0x33 && p[1] === 0x2e && p[2] >= 0x31 && p[2] <= 0x35;

/**
 * The payload of an unpacked frame → { text, json, bad } — bad: it could not be decrypted (the key does not fit).
 * Empty payloads (an acknowledgement) → { text: '', json: null, bad: false }.
 */
function decodePayload(ver, key, payload) {
  const v = minor(ver);
  let p = payload;
  if (!p.length) return { text: '', json: null, bad: false };
  if (v >= 5) {
    if (looksVersion(p) && p.length >= 15) p = p.subarray(15);
  } else if (v === 4) {
    const d = ecbDecrypt(key, p);
    if (!d) return { text: '', json: null, bad: true };
    p = looksVersion(d) && d.length >= 15 ? d.subarray(15) : d;
  } else if (v >= 2) {
    if (looksVersion(p)) p = p.subarray(15);
    if (!p.length) return { text: '', json: null, bad: false };
    if (p[0] !== 0x7b) {
      const d = ecbDecrypt(key, p);
      if (!d) return { text: p.toString('latin1'), json: null, bad: !/^[\x20-\x7e]*$/.test(p.toString('latin1')) };
      p = d;
    }
  } else if (looksVersion(p) && p.length > 19) {
    const d = ecbDecrypt(key, Buffer.from(p.subarray(19).toString('latin1'), 'base64'));
    if (!d) return { text: '', json: null, bad: true };
    p = d;
  }
  const text = p.toString('utf8');
  if (text[0] !== '{') return { text, json: null, bad: !/^[\x20-\x7e\s]*$/.test(text) };
  try { return { text, json: JSON.parse(text), bad: false }; } catch { return { text, json: null, bad: true }; }
}

/** The datapoints in a status message: { dps } (3.1–3.3) or { data: { dps } } (3.4 / 3.5) → { '1': true, … } or null. */
function dpsOf(json) {
  if (!json || typeof json !== 'object') return null;
  const d = json.dps && typeof json.dps === 'object' ? json.dps : (json.data && typeof json.data === 'object' && json.data.dps && typeof json.data.dps === 'object' ? json.data.dps : null);
  if (!d || Array.isArray(d)) return null;
  const out = {};
  for (const [k, val] of Object.entries(d).slice(0, 64)) {
    if (!/^\d{1,3}$/.test(k)) continue;
    if (typeof val === 'boolean' || (typeof val === 'number' && Number.isFinite(val)) || (typeof val === 'string' && val.length <= 255)) out[k] = val;
  }
  return out;
}

const tsec = () => Math.floor(Date.now() / 1000);

/** The JSON (cmd, body) of a query, a command, a heartbeat for a device. dev22: 3.3 devices that only answer CONTROL_NEW. */
function message(kind, { id, ver, dps, dev22, known }) {
  const v = minor(ver);
  if (kind === 'heartbeat') return { cmd: CMD.HEART_BEAT, body: { gwId: id, devId: id } };
  if (kind === 'query') {
    if (v >= 4) return { cmd: CMD.DP_QUERY_NEW, body: {} };
    if (dev22) return { cmd: CMD.CONTROL_NEW, body: { devId: id, uid: id, t: String(tsec()), dps: Object.fromEntries((known && known.length ? known : ['1']).map((k) => [k, null])) } };
    return { cmd: CMD.DP_QUERY, body: { gwId: id, devId: id, uid: id, t: String(tsec()) } };
  }
  if (v >= 4) return { cmd: CMD.CONTROL_NEW, body: { protocol: 5, t: tsec(), data: { dps } } };
  return { cmd: CMD.CONTROL, body: { devId: id, uid: id, t: String(tsec()), dps } };
}

// ─── Discovery (UDP 6666 / 6667 / 7000) ─────────

/**
 * A broadcast of a device → { id, ip, ver, productKey } or null. 6666: clear JSON, 6667: AES-ECB with the discovery
 * key, 7000: a 6699 frame with that key.
 */
function decodeUdp(buf, from) {
  if (!Buffer.isBuffer(buf) || buf.length < 20 || buf.length > 4096) return null;
  const { frames } = split(buf);
  const frame = frames[0];
  if (!frame) return null;
  let text = null;
  if (frame.readUInt32BE(0) === PREFIX_6699) {
    const u = unpack(frame, UDP_KEY);
    if (!u.ok) return null;
    text = u.payload.toString('utf8');
  } else {
    const u = unpack(frame, null);
    let p = u.payload;
    if (p[0] === 0x7b) text = p.toString('utf8');
    else {
      const d = ecbDecrypt(UDP_KEY, p);
      if (d) text = d.toString('utf8');
    }
  }
  if (!text || text[0] !== '{') return null;
  let o;
  try { o = JSON.parse(text); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const id = typeof o.gwId === 'string' ? o.gwId : (typeof o.devId === 'string' ? o.devId : null);
  if (!id || !ID_RE.test(id)) return null;
  const ip = typeof o.ip === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(o.ip) ? o.ip : (from && from.address) || null;
  const ver = typeof o.version === 'string' && VERSIONS.includes(o.version) ? o.version : null;
  return { id, ip, ver, productKey: typeof o.productKey === 'string' ? o.productKey.slice(0, 32) : null };
}

/** The request some 3.5 devices answer only to (broadcast to UDP 7000). `ip`: the gateway's address in that network. */
function discoveryRequest(ip) {
  return pack66(0, CMD.REQ_DEVINFO, Buffer.from(JSON.stringify({ from: 'app', ip: ip || '0.0.0.0' }), 'utf8'), UDP_KEY);
}

// ─── Datapoints ↔ channels ──────────────────────
//
// A profile (server/tuya.js profileOf, sent with gc.edge.configure) says which datapoint is what:
//   { k: 'plug' | 'switch' | 'light' | 'auto' | 'other', sw: [dp…] (a channel switch:<i> each), pw: dp, pws: decimals,
//     l: { v: 1 | 2, sw, mode, bri, temp, col, scene, bmin, bmax, tmax } }
// Channel fields: switch { on, power (W) }, light { on, bri (1–100 %), ct (mired), hue (0–65535), sat (0–254), cm
// ('ct' | 'hs' | 'scene') } — as deCONZ and zigbee2mqtt know them, so the pages, the portal and the widgets need nothing
// new. Colour temperature: Tuya's 0 … tmax is warm (2700 K) … cold (6500 K).

const K_WARM = 2700;
const K_COLD = 6500;
const SCENES = Object.freeze({
  // the four static scenes of the Tuya app (v2 lights: scene_data_v2 — number, unit times, static mode, H S V, white
  // brightness and temperature): night, reading, working, leisure
  night: '000e0d0000000000000000c80000',
  read: '010e0d0000000000000003e801f4',
  work: '020e0d0000000000000003e803e8',
  leisure: '030e0d0000000000000001f401f4',
});

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const k = (dp) => String(dp);

/** Colour datapoint → { h (0–360), s (0–1), v (0–1) } — v2 'hhhhssssvvvv' (s, v 0–1000), v1 'rrggbb0hhhssvv' (s, v 0–255). */
function parseColour(str, ver) {
  if (typeof str !== 'string') return null;
  if (str[0] === '{') {
    try {
      const o = JSON.parse(str);
      if (num(o.h) != null && num(o.s) != null && num(o.v) != null) return { h: clamp(o.h, 0, 360), s: clamp(o.s / 1000, 0, 1), v: clamp(o.v / 1000, 0, 1) };
    } catch { return null; }
    return null;
  }
  if (ver === 1 && /^[0-9a-f]{14}$/i.test(str)) {
    return { h: clamp(parseInt(str.slice(7, 10), 16), 0, 360), s: clamp(parseInt(str.slice(10, 12), 16) / 255, 0, 1), v: clamp(parseInt(str.slice(12, 14), 16) / 255, 0, 1) };
  }
  if (/^[0-9a-f]{12}$/i.test(str)) {
    return { h: clamp(parseInt(str.slice(0, 4), 16), 0, 360), s: clamp(parseInt(str.slice(4, 8), 16) / 1000, 0, 1), v: clamp(parseInt(str.slice(8, 12), 16) / 1000, 0, 1) };
  }
  return null;
}

function hsvToRgb(h, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r, g, b].map((n) => Math.round((n + m) * 255));
}

const hex = (n, w) => Math.round(n).toString(16).padStart(w, '0');

function formatColour(h, s, v, ver) {
  if (ver === 1) {
    const [r, g, b] = hsvToRgb(h % 360, s, v);
    return hex(r, 2) + hex(g, 2) + hex(b, 2) + hex(h % 360, 4) + hex(s * 255, 2) + hex(v * 255, 2);
  }
  return hex(h % 360, 4) + hex(s * 1000, 4) + hex(v * 1000, 4);
}

/** The datapoints of a device → a patch of edge/normalize.js { ch: { 'switch:0': {…}, 'light:0': {…} } }. */
function toPatch(prof, dps) {
  const ch = {};
  const p = prof && typeof prof === 'object' ? prof : {};
  const d = dps || {};
  if (p.k === 'light' && p.l) {
    const l = p.l;
    const c = {};
    if (typeof d[k(l.sw)] === 'boolean') c.on = d[k(l.sw)];
    const mode = typeof d[k(l.mode)] === 'string' ? d[k(l.mode)] : null;
    const col = l.col ? parseColour(d[k(l.col)], l.v) : null;
    if (mode === 'colour' && col) {
      c.cm = 'hs';
      c.hue = Math.round((col.h / 360) * 65535);
      c.sat = Math.round(col.s * 254);
      c.bri = clamp(Math.round(col.v * 100), 1, 100);
    } else {
      if (mode === 'scene' || mode === 'music') c.cm = 'scene';
      else if (mode === 'white' || (!mode && l.temp)) c.cm = 'ct';
      const bri = num(d[k(l.bri)]);
      if (bri != null && l.bmax > l.bmin) c.bri = clamp(Math.round(((bri - l.bmin) / (l.bmax - l.bmin)) * 99) + 1, 1, 100);
      const temp = l.temp ? num(d[k(l.temp)]) : null;
      if (temp != null && l.tmax > 0) c.ct = Math.round(1e6 / (K_WARM + (clamp(temp, 0, l.tmax) / l.tmax) * (K_COLD - K_WARM)));
      if (col && !l.temp) { c.hue = Math.round((col.h / 360) * 65535); c.sat = Math.round(col.s * 254); }
    }
    ch['light:0'] = c;
    return { ch };
  }
  const sw = Array.isArray(p.sw) ? p.sw : [];
  sw.forEach((dp, i) => {
    const v = d[k(dp)];
    if (typeof v === 'boolean') ch[`switch:${i}`] = { on: v };
  });
  if (p.pw && num(d[k(p.pw)]) != null && sw.length) {
    const w = num(d[k(p.pw)]) / 10 ** (Number.isInteger(p.pws) ? p.pws : 1);
    ch['switch:0'] = { ...(ch['switch:0'] || {}), power: Math.round(w * 10) / 10 };
  }
  return { ch };
}

function bad(msg) { return Object.assign(new Error(msg), { code: 'bad_command' }); }

/**
 * A command of edge/commands.js for a Tuya device → the datapoints to write. `now`: what the device reports (for the
 * brightness of a colour, the mode). op: on | off (switch:<i>, light:0), bri (1–100), ct (mired 153–500), color
 * ({ hue 0–65535, sat 0–254 }), scene (night | read | work | leisure).
 */
function toDps(prof, cmd, now = {}) {
  const p = prof && typeof prof === 'object' ? prof : {};
  const m = /^(switch|light):(\d{1,2})$/.exec(String(cmd && cmd.ch));
  if (!m) throw bad('invalid channel');
  const idx = Number(m[2]);
  const op = cmd.op;
  if (m[1] === 'switch') {
    const sw = Array.isArray(p.sw) ? p.sw : [];
    if (p.k === 'light' || idx >= sw.length || (op !== 'on' && op !== 'off')) throw bad('invalid operation');
    return { [k(sw[idx])]: op === 'on' };
  }
  const l = p.k === 'light' ? p.l : null;
  if (!l || idx !== 0) throw bad('invalid channel');
  const out = {};
  if (op === 'on' || op === 'off') { out[k(l.sw)] = op === 'on'; return out; }
  out[k(l.sw)] = true;
  const curMode = typeof now[k(l.mode)] === 'string' ? now[k(l.mode)] : null;
  const briRaw = (pct) => Math.round(l.bmin + ((clamp(pct, 1, 100) - 1) / 99) * (l.bmax - l.bmin));
  if (op === 'bri') {
    const v = num(cmd.value);
    if (v == null || v < 1 || v > 100) throw bad('invalid value');
    const col = l.col ? parseColour(now[k(l.col)], l.v) : null;
    if (curMode === 'colour' && col) out[k(l.col)] = formatColour(col.h, col.s, clamp(v / 100, 0.01, 1), l.v);
    else out[k(l.bri)] = briRaw(v);
    return out;
  }
  if (op === 'ct') {
    const v = num(cmd.value);
    if (!l.temp || v == null || v < 153 || v > 500) throw bad('invalid value');
    const kelvin = clamp(1e6 / v, K_WARM, K_COLD);
    if (l.mode) out[k(l.mode)] = 'white';
    out[k(l.temp)] = Math.round(((kelvin - K_WARM) / (K_COLD - K_WARM)) * l.tmax);
    return out;
  }
  if (op === 'color') {
    const c = cmd.value && typeof cmd.value === 'object' ? cmd.value : {};
    const hue = num(c.hue);
    const sat = num(c.sat);
    if (!l.col || hue == null || sat == null || hue < 0 || hue > 65535 || sat < 0 || sat > 254) throw bad('invalid value');
    const bri = num(d2(now, l));
    if (l.mode) out[k(l.mode)] = 'colour';
    out[k(l.col)] = formatColour((hue / 65535) * 360, sat / 254, clamp((bri == null ? 100 : bri) / 100, 0.01, 1), l.v);
    return out;
  }
  if (op === 'scene') {
    if (!l.scene || l.v !== 2 || !SCENES[cmd.value]) throw bad('invalid value');
    if (l.mode) out[k(l.mode)] = 'scene';
    out[k(l.scene)] = SCENES[cmd.value];
    return out;
  }
  throw bad('invalid operation');
}

/** The brightness (%) a light has now, for a new colour. */
function d2(now, l) {
  const col = l.col ? parseColour(now[k(l.col)], l.v) : null;
  if (now[k(l.mode)] === 'colour' && col) return Math.round(col.v * 100);
  const bri = num(now[k(l.bri)]);
  return bri != null && l.bmax > l.bmin ? Math.round(((bri - l.bmin) / (l.bmax - l.bmin)) * 99) + 1 : null;
}

// ─── Connections ────────────────────────────────

const HEARTBEAT_MS = 10 * 1000;
const IDLE_MS = 35 * 1000;
const CONNECT_MS = 6000;
const NEGO_MS = 5000;
const QUERY_MS = 10 * 60 * 1000;
const BACKOFF = [2000, 4000, 8000, 15000, 30000, 60000];
const KEY_RETRY_MS = 10 * 60 * 1000;
const SEEN_MS = 10 * 60 * 1000;
const FAILS = 3;

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * A device as the server part configures it { id, key, ip?, hint?, ver?, p } → { id, key, ip, hint, ver, prof } or null.
 * ip: an address set by hand (kept); hint: the last one known (a broadcast with another one wins); ver: the last version.
 */
function cleanDevice(d) {
  if (!d || typeof d !== 'object' || typeof d.id !== 'string' || !ID_RE.test(d.id)) return null;
  if (typeof d.key !== 'string' || !KEY_RE.test(d.key)) return null;
  const ip = typeof d.ip === 'string' && IPV4_RE.test(d.ip) ? d.ip : null;
  const hint = typeof d.hint === 'string' && IPV4_RE.test(d.hint) ? d.hint : null;
  const ver = VERSIONS.includes(d.ver) ? d.ver : null;
  const prof = d.p && typeof d.p === 'object' ? d.p : { k: 'auto' };
  return { id: d.id, key: d.key, ip, hint, ver, prof };
}

/**
 * The connections. io: { tcp: gc.lan.tcp, now, setTimer, clearTimer, log, onUpdate(id) — the device's state, link or
 * datapoints changed }.
 */
function create(io) {
  const now = io.now || Date.now;
  const setTimer = io.setTimer || ((fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; });
  const clearTimer = io.clearTimer || clearTimeout;
  const port = io.port || PORT;
  const devs = new Map(); // id → runtime
  let stopped = false;

  function rt(id) { return devs.get(id) || null; }
  const changed = (d) => { if (io.onUpdate) io.onUpdate(d.id); };

  function setLink(d, link) {
    if (d.link === link) return;
    d.link = link;
    changed(d);
  }

  function close(d, why) {
    if (d.hb) { clearTimer(d.hb); d.hb = null; }
    if (d.idle) { clearTimer(d.idle); d.idle = null; }
    if (d.wait) { const w = d.wait; d.wait = null; w.reject(Object.assign(new Error(why || 'closed'), { code: 'closed' })); }
    const s = d.sock;
    d.sock = null;
    d.session = null;
    d.buf = Buffer.alloc(0);
    if (s) { try { s.destroy(); } catch { /* gone */ } }
  }

  function schedule(d, ms) {
    if (stopped || d.timer || d.removed) return;
    d.timer = setTimer(() => { d.timer = null; connect(d); }, ms);
  }

  /** A failed attempt: keyish (it answered, but not with our key) or not reachable. */
  function failed(d, keyish, sure) {
    close(d, 'failed');
    d.fails += 1;
    if (keyish) d.keyFails += 1; else d.keyFails = 0;
    const alive = sure || (d.seenAt && now() - d.seenAt < SEEN_MS);
    if (d.keyFails >= FAILS && alive) {
      setLink(d, 'key');
      schedule(d, KEY_RETRY_MS);
      return;
    }
    if (d.fails >= FAILS) setLink(d, d.ip ? 'offline' : 'searching');
    schedule(d, BACKOFF[Math.min(d.fails - 1, BACKOFF.length - 1)]);
  }

  function nextSeq(d) { d.seq = (d.seq % 0x7fffffff) + 1; return d.seq; }

  function frameKey(d) { return d.session || Buffer.from(d.key, 'latin1'); }

  function write(d, cmd, body) {
    if (!d.sock) throw Object.assign(new Error('the device is not connected'), { code: 'tuya_offline' });
    d.sock.write(encodeCommand(d.ver, frameKey(d), nextSeq(d), cmd, body));
  }

  function send(d, kind, extra = {}) {
    const m = message(kind, { id: d.id, ver: d.ver, dev22: d.dev22, known: Object.keys(d.dps), ...extra });
    write(d, m.cmd, m.body);
  }

  function armIdle(d) {
    if (d.idle) clearTimer(d.idle);
    d.idle = setTimer(() => { d.idle = null; if (d.sock) failed(d, false); }, IDLE_MS);
  }

  function onFrame(d, frame) {
    const v = minor(d.ver);
    const u = unpack(frame, v >= 4 ? frameKey(d) : null);
    if (d.wait && d.wait.cmd === u.cmd) { const w = d.wait; d.wait = null; w.resolve(u); return; }
    if (!u.ok) { if (v >= 4) failed(d, true, true); return; }
    d.lastAt = now();
    armIdle(d);
    if (u.cmd === CMD.HEART_BEAT) return;
    const r = decodePayload(d.ver, frameKey(d), u.payload);
    if (r.bad) { failed(d, true); return; }
    if (!r.json && /data unvalid/i.test(r.text) && !d.dev22 && v < 4) {
      // a "device22": answers DP_QUERY only with an error; it is asked with CONTROL_NEW and the known datapoints
      d.dev22 = true;
      try { send(d, 'query'); } catch { /* reconnects */ }
      return;
    }
    const dps = dpsOf(r.json);
    if (dps && Object.keys(dps).length) {
      if (Object.keys(d.dps).length < 64 || Object.keys(dps).every((x) => x in d.dps)) Object.assign(d.dps, dps);
      d.answered = true;
      d.fails = 0;
      d.keyFails = 0;
      if (d.link !== 'ok') d.link = 'ok';
      changed(d);
    }
  }

  async function negotiate(d) {
    const key = Buffer.from(d.key, 'latin1');
    const local = crypto.randomBytes(16);
    const v = minor(d.ver);
    const enc = (cmd, payload) => (v >= 5 ? pack66(nextSeq(d), cmd, payload, key) : pack55(nextSeq(d), cmd, ecbEncrypt(key, payload), key));
    const waitFor = (cmd) => new Promise((resolve, reject) => {
      d.wait = { cmd, resolve, reject };
      const t = setTimer(() => { if (d.wait && d.wait.cmd === cmd) { d.wait = null; reject(Object.assign(new Error('no answer'), { code: 'timeout' })); } }, NEGO_MS);
      d.waitTimer = t;
    });
    const answer = waitFor(CMD.SESS_RESP);
    d.sock.write(enc(CMD.SESS_START, local));
    const u = await answer;
    if (d.waitTimer) { clearTimer(d.waitTimer); d.waitTimer = null; }
    if (!u.ok) throw Object.assign(new Error('the key does not fit'), { code: 'tuya_key' });
    const plain = v >= 5 ? u.payload : ecbDecrypt(key, u.payload);
    if (!plain || plain.length < 48) throw Object.assign(new Error('the key does not fit'), { code: 'tuya_key' });
    const remote = plain.subarray(0, 16);
    if (!crypto.timingSafeEqual(plain.subarray(16, 48), hmac(key, local))) throw Object.assign(new Error('the key does not fit'), { code: 'tuya_key' });
    d.sock.write(enc(CMD.SESS_FINISH, hmac(key, remote)));
    const x = xor(local, remote);
    d.session = v >= 5 ? gcmEncrypt(key, local.subarray(0, 12), null, x).ct : ecbEncrypt(key, x, false);
  }

  async function connect(d) {
    if (stopped || d.removed || d.sock || d.connecting) return;
    if (!d.ip) { setLink(d, 'searching'); return; }
    if (!d.ver) d.ver = '3.3';
    d.connecting = true;
    if (d.link !== 'ok' && d.link !== 'key' && d.link !== 'offline') setLink(d, 'connecting');
    let sock = null;
    let late = false;
    try {
      let to = null;
      const pending = Promise.resolve().then(() => io.tcp.connect(d.ip, port));
      // a connection that comes only after the time ran out is closed again
      pending.then((s) => { if (late && s) { try { s.destroy(); } catch { /* gone */ } } }, () => null);
      sock = await Promise.race([
        pending,
        new Promise((_, reject) => { to = setTimer(() => { late = true; reject(Object.assign(new Error('connect timeout'), { code: 'timeout' })); }, CONNECT_MS); }),
      ]).finally(() => { if (to) clearTimer(to); });
    } catch (e) {
      d.connecting = false;
      if (e && e.code === 'denied') { setLink(d, 'denied'); schedule(d, 60000); return; }
      if (e && e.code === 'busy') { setLink(d, 'busy'); schedule(d, 60000); return; }
      failed(d, false);
      return;
    }
    d.connecting = false;
    if (stopped || d.removed) { try { sock.destroy(); } catch { /* gone */ } return; }
    d.sock = sock;
    d.buf = Buffer.alloc(0);
    d.answered = false;
    const mine = sock;
    sock.on('data', (chunk) => {
      if (d.sock !== mine) return;
      d.buf = Buffer.concat([d.buf, chunk]);
      if (d.buf.length > MAX_BUFFER) { failed(d, false); return; }
      const { frames, rest } = split(d.buf);
      d.buf = rest;
      for (const f of frames) { if (d.sock !== mine) return; onFrame(d, f); }
    });
    const gone = () => {
      if (d.sock !== mine) return;
      // closed right after the query without a word we understood: the key, most likely (3.1–3.3)
      // or closed while the session key was being agreed (3.4 / 3.5)
      failed(d, (!d.answered && d.queried && minor(d.ver) < 4) || d.negotiating);
    };
    sock.on('close', gone);
    sock.on('end', gone);
    sock.on('error', gone);
    d.queried = false;
    try {
      d.negotiating = minor(d.ver) >= 4;
      if (d.negotiating) await negotiate(d);
    } catch (e) {
      d.negotiating = false;
      if (d.sock === mine) failed(d, true, (e && e.code) === 'tuya_key'); // it took the connection but not our key
      return;
    }
    d.negotiating = false;
    if (d.sock !== mine) return;
    armIdle(d);
    d.hb = setTimer(function beat() {
      if (d.sock !== mine) return;
      try { send(d, 'heartbeat'); } catch { /* reconnects */ }
      d.hb = setTimer(beat, HEARTBEAT_MS);
    }, HEARTBEAT_MS);
    d.queried = true;
    try { send(d, 'query'); } catch { failed(d, false); }
  }

  function set(list) {
    const next = new Map();
    for (const raw of (Array.isArray(list) ? list : []).slice(0, 128)) {
      const c = cleanDevice(raw);
      if (c) next.set(c.id, c);
    }
    for (const [id, d] of devs) {
      if (!next.has(id)) {
        d.removed = true;
        if (d.timer) { clearTimer(d.timer); d.timer = null; }
        close(d, 'removed');
        devs.delete(id);
      }
    }
    for (const [id, c] of next) {
      let d = devs.get(id);
      const same = d && d.key === c.key && d.cfgIp === c.ip;
      if (d && same) {
        const profChanged = JSON.stringify(d.prof) !== JSON.stringify(c.prof);
        d.prof = c.prof;
        if (profChanged) changed(d);
        continue;
      }
      if (d) {
        if (d.timer) { clearTimer(d.timer); d.timer = null; }
        close(d, 'reconfigured');
        Object.assign(d, { key: c.key, cfgIp: c.ip, prof: c.prof, fails: 0, keyFails: 0, dev22: false });
        if (c.ip) d.ip = c.ip;
        if (c.ver && !d.ver) d.ver = c.ver;
        d.link = 'connecting';
      } else {
        const ip = c.ip || c.hint;
        d = { id, key: c.key, ip, ver: c.ver, cfgIp: c.ip, cfgVer: null, prof: c.prof, link: ip ? 'connecting' : 'searching', dps: {}, fails: 0, keyFails: 0, seq: 0,
          sock: null, buf: Buffer.alloc(0), timer: null, hb: null, idle: null, wait: null, session: null, seenAt: 0, lastAt: 0, dev22: false, removed: false, connecting: false };
        devs.set(id, d);
      }
      changed(d);
      connect(d);
    }
  }

  /** The scan saw a device (its broadcast): a new address is followed, a device without one connects now. */
  function seen(id, ip, ver) {
    const d = rt(id);
    if (!d) return false;
    d.seenAt = now();
    let moved = false;
    if (ip && ip !== d.ip && !d.cfgIp) { d.ip = ip; moved = true; }
    if (ver && !d.cfgVer && ver !== d.ver) { d.ver = ver; moved = true; }
    if (moved) {
      if (d.timer) { clearTimer(d.timer); d.timer = null; }
      close(d, 'moved');
      d.fails = 0;
      changed(d);
      connect(d);
    } else if (!d.sock && !d.connecting && !d.timer) connect(d);
    return true;
  }

  async function command(id, dps) {
    const d = rt(id);
    if (!d) throw Object.assign(new Error('unknown Tuya device'), { code: 'unknown_device' });
    if (d.link === 'key') throw Object.assign(new Error('the local key of the device does not fit'), { code: 'tuya_key' });
    if (!d.sock || d.link !== 'ok') throw Object.assign(new Error('the device is not connected'), { code: 'tuya_offline' });
    send(d, 'control', { dps });
    return true;
  }

  function query(id) {
    const d = rt(id);
    if (!d || !d.sock) return false;
    try { send(d, 'query'); return true; } catch { return false; }
  }

  function view(id) {
    const d = rt(id);
    return d ? { id: d.id, link: d.link, ip: d.ip, ver: d.ver, dps: { ...d.dps }, prof: d.prof, lastAt: d.lastAt || null } : null;
  }

  function stop() {
    stopped = true;
    for (const d of devs.values()) {
      d.removed = true;
      if (d.timer) clearTimer(d.timer);
      d.timer = null;
      close(d, 'stopped');
    }
    devs.clear();
  }

  return { set, seen, command, query, view, list: () => [...devs.keys()], stop, _devs: devs };
}

module.exports = {
  PORT, UDP_PORTS, CMD, UDP_KEY, VERSIONS, ID_RE, KEY_RE, SCENES, QUERY_MS,
  crc32, ecbEncrypt, ecbDecrypt, gcmEncrypt, gcmDecrypt, hmac, pack55, pack66, split, unpack, encodeCommand, decodePayload, dpsOf, message,
  decodeUdp, discoveryRequest, parseColour, formatColour, toPatch, toDps, cleanDevice, create,
};
