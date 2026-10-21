'use strict';

// Dreo heaters and air conditioners through the Dreo cloud — the protocol of
// the Dreo app, as the Home Assistant integration hass-dreo (MIT) speaks it:
//
//   REST  app-api-<us|eu>.dreo-tech.com   login, device list, device state
//   WS    wsb-<us|eu>.dreo-tech.com       one socket per account: commands
//                                         ({ devicesn, method: 'control', params })
//                                         and live reports of every device
//
// The WebSocket goes through gc.http.websocket (GateControl ≥ 1.184.0). The
// account is the e-mail and the MD5 of the password (what the login wants —
// the plain password is never kept); the region (NA/EU) comes from the login.

const crypto = require('node:crypto');
const EventEmitter = require('node:events');

const CLIENT_ID = '7de37c362ee54dcf9c4561812309347a';
const CLIENT_SECRET = '32dfa0764f25451d99f94e1693498791';
const HIMEI = 'faede31549d649f58864093158787ec9';
const REGIONS = { NA: 'us', EU: 'eu' };
const SN_RE = /^[A-Za-z0-9_-]{1,64}$/;

const apiBase = (region) => `https://app-api-${REGIONS[region] || 'us'}.dreo-tech.com`;
const wsBase = (region) => `wss://wsb-${REGIONS[region] || 'us'}.dreo-tech.com/websocket`;

const md5 = (s) => crypto.createHash('md5').update(String(s), 'utf8').digest('hex');

function dreoError(code, message) {
  return Object.assign(new Error(message || code), { code });
}

function headers(token) {
  const h = { ua: 'dreo/2.8.2', lang: 'en', 'content-type': 'application/json; charset=UTF-8', 'user-agent': 'okhttp/4.9.1' };
  if (token) h.authorization = 'Bearer ' + token;
  return h;
}

const text = (v, max = 100) => (typeof v === 'string' ? v.replace(/[\0-\x1f\x7f]/g, ' ').trim().slice(0, max) : '');

/** state answers carry { key: { state, timestamp } } (REST) or plain values (WebSocket reports). */
function flatten(mixed) {
  const out = {};
  if (!mixed || typeof mixed !== 'object' || Array.isArray(mixed)) return out;
  for (const [k, v] of Object.entries(mixed)) {
    if (!/^[a-z][a-z0-9_]{0,40}$/i.test(k)) continue;
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && 'state' in v ? v.state : v;
  }
  return out;
}

/**
 * The devices in a list answer: { list: [device | room-with-devices …] } or a plain array; a room or
 * home nests its devices (devices / deviceList / list / children / rooms), a few levels deep.
 */
function collectDevices(data) {
  const out = [];
  const walk = (v, depth) => {
    if (depth > 8 || out.length >= 200 || v == null) return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (typeof v !== 'object') return;
    const sn = v.sn != null ? v.sn : v.deviceSn;
    if (sn != null && SN_RE.test(String(sn)) && (v.model || v.deviceName || v.productName)) {
      out.push({ sn: String(sn), name: text(v.deviceName || v.name), model: text(v.model, 40), productName: text(v.productName) });
      return;
    }
    for (const k of ['list', 'devices', 'deviceList', 'children', 'rooms', 'roomList']) if (k in v) walk(v[k], depth + 1);
  };
  walk(data, 0);
  return out;
}

// ─── REST ───────────────────────────────────────

class DreoApi {
  /** @param {{fetch: Function, now?: () => number}} o  fetch = gc.http.fetch */
  constructor(o) {
    this.fetch = o.fetch;
    this.now = o.now || Date.now;
  }

  async call(region, token, method, path, params) {
    const ts = String(this.now());
    let url = apiBase(region) + path;
    let body;
    if (method === 'GET') url += '?' + new URLSearchParams({ ...params, timestamp: ts }).toString();
    else { url += '?timestamp=' + ts; body = JSON.stringify(params); }
    let r;
    try {
      r = await this.fetch(url, { method, headers: headers(token), body, timeoutMs: 15000 });
    } catch (e) {
      throw dreoError(e && e.code === 'ERR_NET_DENIED' ? 'ERR_NET_DENIED' : 'DREO_UNREACHABLE', String((e && e.message) || e));
    }
    if (r.status === 401) throw dreoError('DREO_AUTH', 'access token rejected');
    if (r.status === 429) throw dreoError('DREO_RATE_LIMITED', 'too many requests');
    if (r.status !== 200) throw dreoError('DREO_CLOUD', `HTTP ${r.status}`);
    let j;
    try { j = JSON.parse(r.body); } catch { throw dreoError('DREO_CLOUD', 'invalid answer'); }
    if (!j || j.code !== 0) {
      const detail = `${j && j.code} ${text(j && j.msg, 120)}`.trim();
      throw dreoError(path === '/api/oauth/login' ? 'DREO_LOGIN_FAILED' : 'DREO_CLOUD', detail);
    }
    return j.data;
  }

  /** → { token, region }; follows the region the login answers with (one retry) — unless follow is false. */
  async login(email, passwordMd5, region = 'EU', { follow = true } = {}) {
    const body = {
      acceptLanguage: 'en', client_id: CLIENT_ID, client_secret: CLIENT_SECRET, email,
      encrypt: 'ciphertext', grant_type: 'email-password', himei: HIMEI, password: passwordMd5, scope: 'all',
    };
    let reg = REGIONS[region] ? region : 'EU';
    let d = await this.call(reg, null, 'POST', '/api/oauth/login', body);
    if (follow && d && REGIONS[d.region] && d.region !== reg) {
      reg = d.region;
      d = await this.call(reg, null, 'POST', '/api/oauth/login', body);
    }
    const token = d && typeof d.access_token === 'string' ? d.access_token : '';
    if (!token || token.length > 2000) throw dreoError('DREO_LOGIN_FAILED', 'no access token');
    return { token, region: reg };
  }

  /**
   * → [{ sn, name, model, productName }]. Two lists of the Dreo app: the device list (v2, as hass-dreo
   * reads it) and — when that one is empty — the home's rooms (/api/app/index/family/room/devices, as
   * the newer app and homebridge-dreo read it; accounts with homes and rooms can have an empty v2 list).
   * `seen` (optional) collects { path, count } of every list asked, for the diagnosis.
   */
  async devices(region, token, seen = null) {
    const lists = [
      ['/api/v2/user-device/device/list', { acceptLanguage: 'en', method: 'devices', pageNo: '1', pageSize: '100' }],
      ['/api/app/index/family/room/devices', { acceptLanguage: 'en' }],
    ];
    const out = new Map();
    let failure = null;
    for (const [path, params] of lists) {
      let d;
      try {
        d = await this.call(region, token, 'GET', path, params);
      } catch (e) {
        if (e.code === 'DREO_AUTH' || e.code === 'DREO_RATE_LIMITED') throw e;
        failure = failure || e;
        if (seen) seen.push({ path, count: null, error: e.code || 'ERROR' });
        continue;
      }
      const found = collectDevices(d);
      if (seen) seen.push({ path, count: found.length });
      for (const x of found) if (!out.has(x.sn)) out.set(x.sn, x);
      if (out.size) break;
    }
    if (!out.size && failure) throw failure;
    return [...out.values()];
  }

  /** → the device's state as { key: value } */
  async state(region, token, sn) {
    const d = await this.call(region, token, 'GET', '/api/user-device/device/state', { deviceSn: sn });
    return flatten(d && d.mixed);
  }
}

// ─── WebSocket ──────────────────────────────────

const PING_MS = 15000;        // the Dreo socket's keep-alive: the text "2"
const ACK_MS = 3000;          // control-reply / control-report of the device
const RETRIES = 2;
const ACK_METHODS = new Set(['control-reply', 'control-report']);
const STATE_METHODS = new Set(['report', 'control-report', 'device-online']);

/**
 * The account's live connection. Events: 'report' (sn, values) for state the
 * devices report, 'online' (sn, boolean), 'down' when the socket closed.
 */
class DreoLink extends EventEmitter {
  /** @param {{open: (url: string) => Promise<object>, now?: () => number, ackMs?: number}} o  open = gc.http.websocket */
  constructor(o) {
    super();
    this.open = o.open;
    this.now = o.now || Date.now;
    this.ackMs = o.ackMs || ACK_MS;
    this.ws = null;
    this.key = null;
    this.connecting = null;
    this.ping = null;
    this.pending = null;      // { sn, resolve } of the command in flight
    this.chain = Promise.resolve();
  }

  get connected() { return Boolean(this.ws && !this.ws.closed); }

  /** An open socket for this token (reconnects when it changed or the socket is gone). */
  async ensure(region, token) {
    const key = region + ':' + token;
    if (this.connected && this.key === key) return;
    if (this.connecting && this.connectingKey === key) { await this.connecting; return; }
    this.close();
    this.connectingKey = key;
    this.connecting = (async () => {
      const url = `${wsBase(region)}?accessToken=${encodeURIComponent(token)}&timestamp=${this.now()}`;
      let ws;
      try { ws = await this.open(url); } catch (e) { throw dreoError(e && e.code === 'ERR_NET_DENIED' ? 'ERR_NET_DENIED' : 'DREO_UNREACHABLE', String((e && e.message) || e)); }
      if (this.connectingKey !== key) { ws.close(1000, 'bye').catch(() => {}); return; } // a newer token took over
      this.ws = ws;
      this.key = key;
      ws.on('message', (m) => this.onMessage(m));
      ws.on('error', () => { /* a close follows */ });
      ws.on('close', () => {
        if (this.ws !== ws) return;
        this.ws = null;
        this.key = null;
        clearInterval(this.ping);
        this.ping = null;
        this.emit('down');
      });
      this.ping = setInterval(() => { ws.send('2').catch(() => {}); }, PING_MS);
      if (this.ping.unref) this.ping.unref();
    })();
    try { await this.connecting; } finally { this.connecting = null; this.connectingKey = null; }
  }

  close() {
    const ws = this.ws;
    this.ws = null;
    this.key = null;
    clearInterval(this.ping);
    this.ping = null;
    if (ws && !ws.closed) ws.close(1000, 'bye').catch(() => {});
  }

  onMessage(m) {
    if (typeof m !== 'string' || m.length < 2 || m[0] !== '{') return; // "3" = pong, binary = never
    let msg;
    try { msg = JSON.parse(m); } catch { return; }
    const sn = msg && typeof msg.devicesn === 'string' ? msg.devicesn : null;
    if (!sn) return;
    const method = msg.method;
    const reported = msg.reported && typeof msg.reported === 'object' && !Array.isArray(msg.reported) ? msg.reported : null;
    if (this.pending && this.pending.sn === sn && ACK_METHODS.has(method)) {
      const p = this.pending;
      this.pending = null;
      p.resolve(reported && 'error_code' in reported ? { rejected: `${reported.error_code} ${text(String(reported.error_msg || ''), 80)}`.trim() } : { ok: true });
    }
    if (method === 'device-offline') { this.emit('online', sn, false); return; }
    if (method === 'device-online') this.emit('online', sn, true);
    if (reported && (STATE_METHODS.has(method) || method == null)) this.emit('report', sn, flatten(reported));
  }

  /** One command at a time (acks carry only the device); waits for the device's acknowledgement, two retries. */
  command(sn, params) {
    const run = () => this.sendWithAck(sn, params);
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  async sendWithAck(sn, params) {
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      if (!this.connected) throw dreoError('DREO_OFFLINE', 'not connected');
      const ack = new Promise((resolve) => {
        const timer = setTimeout(() => { if (this.pending && this.pending.resolve === done) this.pending = null; resolve(null); }, this.ackMs);
        const done = (v) => { clearTimeout(timer); resolve(v); };
        this.pending = { sn, resolve: done };
      });
      try {
        await this.ws.send(JSON.stringify({ devicesn: sn, method: 'control', params, timestamp: this.now() }));
      } catch (e) {
        this.pending = null;
        throw dreoError('DREO_OFFLINE', String((e && e.message) || e));
      }
      const r = await ack;
      if (r && r.rejected) throw dreoError('DREO_REJECTED', r.rejected);
      if (r) return true;
    }
    throw dreoError('DREO_NO_REPLY', 'the device did not answer');
  }
}

module.exports = {
  collectDevices, DreoApi, DreoLink, md5, flatten, apiBase, wsBase, SN_RE, REGIONS };
