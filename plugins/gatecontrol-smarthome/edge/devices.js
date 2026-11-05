'use strict';

// Shelly and Tasmota devices over HTTP in the home network (gc.lan.http.request, capability http.lan):
//   probe(http, ip)                 → { ip, family, gen, model, name, firmware, id, mac, auth, topic? }
//   setup(http, { ip, family, host, port, user, pass, prefix, password })
//                                   → { ok: true } — writes the MQTT settings into the device and restarts it
//
// family: 'shelly2' (Gen2/3/4: GET /shelly has "gen"), 'shelly1' (GET /shelly has "type"), 'tasmota'
// (cm?cmnd=Status 0). Device passwords: Gen2+ HTTP Digest (SHA-256, user "admin"), Gen1 HTTP Basic (user
// "admin"), Tasmota user=admin&password=… as form fields. The device password and the MQTT password travel in
// request bodies only (never in a URL), are used for this one request and never stored or logged — every error
// thrown here has a fixed text without them.

const crypto = require('node:crypto');

const IP_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const TIMEOUT_MS = 6000;

function fail(code, message) { return Object.assign(new Error(message), { code }); }

function validIp(ip) {
  const m = typeof ip === 'string' ? IP_RE.exec(ip) : null;
  return !!m && m.slice(1).every((x) => Number(x) <= 255);
}

const clip = (v, n) => (typeof v === 'string' ? v.replace(/[\0-\x1f\x7f]/g, ' ').trim().slice(0, n) : null);

/** A request that turns transport failures into unreachable (no URL, no body in the error). */
async function request(http, o) {
  try {
    return await http.request({ timeoutMs: TIMEOUT_MS, ...o });
  } catch (e) {
    const code = e && e.code;
    if (code === 'denied') throw fail('denied', 'the gateway does not allow this address');
    throw fail('unreachable', 'the device did not answer');
  }
}

function header(res, name) {
  const h = res && res.headers ? res.headers : {};
  for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === name) return Array.isArray(v) ? v.join(', ') : String(v);
  return '';
}

function jsonOf(res) {
  try { const v = JSON.parse(res.text()); return v && typeof v === 'object' ? v : null; } catch { return null; }
}

function form(fields) {
  return Object.entries(fields).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
}

// ─── HTTP Digest (RFC 7616, as Shelly Gen2+ uses it: SHA-256, qop=auth) ───

function parseChallenge(h) {
  if (!/^\s*digest\s/i.test(h)) return null;
  const out = {};
  const re = /([a-z0-9_-]+)\s*=\s*(?:"([^"]*)"|([^\s,]+))/gi;
  let m;
  while ((m = re.exec(h))) out[m[1].toLowerCase()] = m[2] != null ? m[2] : m[3];
  return out.nonce && out.realm != null ? out : null;
}

function digestHeader(ch, { method, uri, user, password, nc }) {
  const algo = /sha-?256/i.test(ch.algorithm || '') ? 'sha256' : 'md5';
  const H = (s) => crypto.createHash(algo).update(s).digest('hex');
  const cnonce = crypto.randomBytes(8).toString('hex');
  const ncHex = nc.toString(16).padStart(8, '0');
  const ha1 = H(`${user}:${ch.realm}:${password}`);
  const ha2 = H(`${method}:${uri}`);
  const qop = ch.qop ? 'auth' : null;
  const response = qop ? H(`${ha1}:${ch.nonce}:${ncHex}:${cnonce}:${qop}:${ha2}`) : H(`${ha1}:${ch.nonce}:${ha2}`);
  const parts = [`username="${user}"`, `realm="${ch.realm}"`, `nonce="${ch.nonce}"`, `uri="${uri}"`, `response="${response}"`,
    `algorithm=${algo === 'sha256' ? 'SHA-256' : 'MD5'}`];
  if (qop) parts.push(`qop=${qop}`, `nc=${ncHex}`, `cnonce="${cnonce}"`);
  if (ch.opaque) parts.push(`opaque="${ch.opaque}"`);
  return 'Digest ' + parts.join(', ');
}

/** Gen2+ JSON-RPC over HTTP POST /rpc, with Digest when the device asks for it. */
async function gen2Rpc(http, ip, method, params, password) {
  const body = JSON.stringify({ id: 1, method, params: params || {} });
  const send = (auth) => request(http, { method: 'POST', url: `http://${ip}/rpc`, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) }, body });
  let res = await send(null);
  if (res.status === 401) {
    if (!password) throw fail('auth_required', 'the device has a password');
    const ch = parseChallenge(header(res, 'www-authenticate'));
    if (!ch) throw fail('device_error', 'the device asked for an unknown authentication');
    res = await send(digestHeader(ch, { method: 'POST', uri: '/rpc', user: 'admin', password, nc: 1 }));
    if (res.status === 401) throw fail('auth_failed', 'the device did not accept the password');
  }
  const j = jsonOf(res);
  if (res.status !== 200 || !j || j.error) throw fail('device_error', `the device refused ${method}`);
  return j.result;
}

// ─── Probe ──────────────────────────────────────

async function probe(http, ip) {
  if (!validIp(ip)) throw fail('bad_request', 'invalid address');
  const res = await request(http, { method: 'GET', url: `http://${ip}/shelly` });
  const j = res.status === 200 ? jsonOf(res) : null;
  if (j && Number.isInteger(j.gen) && j.gen >= 2) {
    return {
      ip, family: 'shelly2', gen: j.gen, model: clip(j.app || j.model, 40), name: clip(j.name, 60), firmware: clip(j.ver || j.fw_id, 60),
      id: clip(j.id, 64), mac: clip(j.mac, 20), auth: j.auth_en === true,
    };
  }
  if (j && typeof j.type === 'string') {
    return { ip, family: 'shelly1', gen: 1, model: clip(j.type, 40), name: null, firmware: clip(j.fw, 60), id: null, mac: clip(j.mac, 20), auth: j.auth === true };
  }
  // Tasmota: Status 0 (a web password answers 401 / "Need user=…&password=…")
  const t = await request(http, { method: 'GET', url: `http://${ip}/cm?cmnd=Status%200` });
  const s = jsonOf(t);
  if (t.status === 401 || (s && typeof s.WARNING === 'string' && /password/i.test(s.WARNING))) {
    return { ip, family: 'tasmota', gen: null, model: null, name: null, firmware: null, id: null, mac: null, auth: true };
  }
  if (t.status === 200 && s && s.Status && typeof s.Status === 'object') {
    const st = s.Status;
    const fn = Array.isArray(st.FriendlyName) ? st.FriendlyName[0] : st.FriendlyName;
    return {
      ip, family: 'tasmota', gen: null, model: clip(st.DeviceName, 40) || (st.Module != null ? `Module ${clip(String(st.Module), 20)}` : null), name: clip(fn, 60),
      firmware: clip(s.StatusFWR && s.StatusFWR.Version, 60), id: clip(st.Topic, 64), mac: clip(s.StatusNET && s.StatusNET.Mac, 20), auth: false,
    };
  }
  throw fail('unsupported', 'neither a Shelly nor a Tasmota device');
}

// ─── Setup: MQTT settings into the device, then restart ───

async function setup(http, o) {
  const { ip, family, host, user, pass, prefix } = o;
  const port = o.port || 1883;
  const password = typeof o.password === 'string' && o.password ? o.password : null;
  if (!validIp(ip) || !validIp(host)) throw fail('bad_request', 'invalid address');
  if (typeof user !== 'string' || !user || typeof pass !== 'string' || !pass || typeof prefix !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,23}$/.test(prefix)) {
    throw fail('bad_request', 'invalid MQTT settings');
  }
  if (family === 'shelly2') {
    await gen2Rpc(http, ip, 'MQTT.SetConfig', {
      config: { enable: true, server: `${host}:${port}`, user, pass, topic_prefix: `shellies/${prefix}`, rpc_ntf: true, status_ntf: true },
    }, password);
    await gen2Rpc(http, ip, 'Shelly.Reboot', {}, password);
    return { ok: true };
  }
  if (family === 'shelly1') {
    const auth = password ? { Authorization: 'Basic ' + Buffer.from(`admin:${password}`).toString('base64') } : {};
    const body = form({ mqtt_enable: 'true', mqtt_server: `${host}:${port}`, mqtt_user: user, mqtt_pass: pass, mqtt_id: prefix, mqtt_clean_session: 'true', mqtt_retain: 'false' });
    const res = await request(http, { method: 'POST', url: `http://${ip}/settings`, headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...auth }, body });
    if (res.status === 401) throw fail(password ? 'auth_failed' : 'auth_required', password ? 'the device did not accept the password' : 'the device has a password');
    if (res.status !== 200) throw fail('device_error', 'the device refused the settings');
    await request(http, { method: 'POST', url: `http://${ip}/reboot`, headers: auth, body: '' }).catch(() => null); // it restarts while answering
    return { ok: true };
  }
  if (family === 'tasmota') {
    if (/[;\s]/.test(pass) || /[;\s]/.test(user)) throw fail('bad_request', 'invalid MQTT settings');
    const cmnd = `Backlog SetOption3 1; MqttHost ${host}; MqttPort ${port}; MqttUser ${user}; MqttPassword ${pass}; Topic ${prefix}; FullTopic tasmota/%topic%/%prefix%/`;
    const body = form(password ? { user: 'admin', password, cmnd } : { cmnd });
    const res = await request(http, { method: 'POST', url: `http://${ip}/cm`, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const j = jsonOf(res);
    if (res.status === 401 || (j && typeof j.WARNING === 'string' && /password/i.test(j.WARNING))) {
      throw fail(password ? 'auth_failed' : 'auth_required', password ? 'the device did not accept the password' : 'the device has a password');
    }
    if (res.status !== 200) throw fail('device_error', 'the device refused the settings');
    return { ok: true }; // Tasmota restarts by itself after new MQTT settings
  }
  throw fail('bad_request', 'unknown device family');
}

// ─── The gateway's own address towards a device (the broker listens on the private LAN addresses) ───

const SKIP_IF = /^(lo|wg|docker|br-|veth|virbr|tun|tap|tailscale|zt|gatecontrol)/i;

function toInt(ip) { const m = IP_RE.exec(ip); return m ? m.slice(1).reduce((a, x) => a * 256 + Number(x), 0) : null; }
function isPrivate(ip) {
  const n = toInt(ip);
  if (n == null) return false;
  return (n >>> 24) === 10 || (n >>> 20) === ((172 << 4) | 1) || (n >>> 16) === ((192 << 8) | 168);
}

/** os.networkInterfaces() → [{ address, netmask, iface }] of private IPv4 LAN addresses. */
function lanAddresses(ifaces) {
  const out = [];
  for (const [name, list] of Object.entries(ifaces || {})) {
    if (SKIP_IF.test(name)) continue;
    for (const a of list || []) {
      if (!a || a.internal || (a.family !== 'IPv4' && a.family !== 4) || !isPrivate(a.address)) continue;
      out.push({ address: a.address, netmask: a.netmask || '255.255.255.0', iface: name });
    }
  }
  return out;
}

/** The LAN address in the device's subnet, else the first one, else null. */
function addressFor(deviceIp, addrs) {
  const d = toInt(deviceIp);
  if (d != null) {
    for (const a of addrs) {
      const mask = toInt(a.netmask);
      if (mask != null && ((toInt(a.address) & mask) >>> 0) === ((d & mask) >>> 0)) return a.address;
    }
  }
  return addrs.length ? addrs[0].address : null;
}

module.exports = { probe, setup, lanAddresses, addressFor, parseChallenge, digestHeader, validIp, isPrivate };
