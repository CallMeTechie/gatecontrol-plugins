'use strict';

// DSM Web API client (Synology "DSM Login Web API Guide" for DSM 6/7 and
// the APIs the DSM web interface itself uses). Transport: every request goes
// through `send(path, opts)` = gc.net.fetchTarget('nas', path, { index, … })
// — the plugin never sees an address, GateControl resolves the assigned
// target (route, peer or address).
//
//   GET  /webapi/query.cgi?api=SYNO.API.Info&version=1&method=query&query=<api,…>
//        → { success: true, data: { '<api>': { minVersion, maxVersion, path, requestFormat? } } }
//   POST /webapi/<path>   form: api, version, method, <params>, _sid
//        header X-SYNO-TOKEN: <synotoken>
//        → { success: true, data } | { success: false, error: { code } }
//
// Login: SYNO.API.Auth version 6 (DSM 6.0 … 7.2; DSM 7.2 also lists 7,
// which adds nothing needed here), method=login with account, passwd,
// session=webui (the SYNO.Core.* APIs answer 105 to other session names),
// format=sid, enable_syno_token=yes → data { sid, synotoken, did? }.
// Two-factor authentication (DSM "2-step verification"): a login without a
// code answers 403; the one-time code goes in otp_code together with
// enable_device_token=yes + device_name → data.did, the device token. Later
// logins send device_id=<did> + device_name and need no code any more
// (like "Remember this device" in the DSM sign-in). Logout: method=logout.
//
// Passwords travel only in a POST body (never in a URL, never logged).

const DEVICE_NAME = 'GateControl';
const SESSION_NAME = 'webui';
const TIMEOUT_MS = 15000;

// The APIs asked for in SYNO.API.Info (path + versions of each)
const APIS = [
  'SYNO.API.Auth',
  'SYNO.DSM.Info',
  'SYNO.Core.System',
  'SYNO.Core.System.Utilization',
  'SYNO.Storage.CGI.Storage',
  'SYNO.Core.Upgrade.Server',
  'SYNO.Backup.Task',
  'SYNO.Core.ExternalDevice.UPS',
];

// Common error codes of every DSM API (DSM Web API guide, "Common error code")
const COMMON = {
  100: 'DSM_ERROR',         // unknown error
  101: 'API_MISSING',       // no parameter of API, method or version
  102: 'API_MISSING',       // the requested API does not exist
  103: 'API_MISSING',       // the requested method does not exist
  104: 'API_MISSING',       // the requested version does not support the functionality
  105: 'PERMISSION',        // the logged in session does not have permission
  106: 'SESSION_EXPIRED',   // session timeout
  107: 'SESSION_EXPIRED',   // session interrupted by duplicated login
  109: 'DSM_BUSY',          // network connection is unstable or the system is busy
  117: 'DSM_BUSY',
  119: 'SESSION_EXPIRED',   // SID not found (invalid session)
  150: 'IP_MISMATCH',       // request source IP does not match the login IP
};

// Error codes of SYNO.API.Auth login (DSM Login Web API Guide)
const AUTH = {
  400: 'AUTH_FAILED',       // no such account or incorrect password
  401: 'ACCOUNT_DISABLED',  // disabled account
  402: 'AUTH_DENIED',       // denied permission
  403: 'OTP_REQUIRED',      // 2-factor authentication code required
  404: 'OTP_INVALID',       // failed to authenticate 2-factor authentication code
  406: 'OTP_ENFORCED',      // enforced to authenticate with 2FA, not set up for the account yet
  407: 'IP_BLOCKED',        // blocked IP source (DSM auto block)
  408: 'PASSWORD_EXPIRED',  // expired password, cannot change
  409: 'PASSWORD_EXPIRED',  // expired password
  410: 'PASSWORD_EXPIRED',  // password must be changed
};

/** A session gone stale: log in again once (105 only for a session that worked before — DSM 6 answers 105 to an expired session at times). */
const RELOGIN = new Set([106, 107, 119]);

/** Login problems: polling pauses (repeated wrong logins would trip DSM's auto block). */
const AUTH_CODES = new Set(['AUTH_FAILED', 'ACCOUNT_DISABLED', 'AUTH_DENIED', 'OTP_REQUIRED', 'OTP_INVALID', 'OTP_ENFORCED', 'IP_BLOCKED', 'PASSWORD_EXPIRED', 'NO_CREDENTIALS']);
const OTP_CODES = new Set(['OTP_REQUIRED', 'OTP_INVALID']);

/** Problems of the connection itself (the NAS did not answer like a DSM). */
const NET_CODES = new Set(['UNREACHABLE', 'TIMEOUT', 'TLS_CERT', 'HTTPS_REDIRECT', 'HTTP_REDIRECT', 'HTTP_TO_HTTPS_PORT', 'HTTP_ERROR', 'BAD_RESPONSE', 'NOT_DSM', 'TARGET_UNASSIGNED', 'TARGET_DENIED']);

class DsmError extends Error {
  constructor(code, extra) {
    super(code);
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}
const fail = (code, extra) => new DsmError(code, extra);

const TLS_RE = /certificate|self[- ]signed|altnames|\bSSL\b|\bTLS\b|EPROTO|wrong version number|CERT_|UNABLE_TO_VERIFY/i;

/** Error of gc.net.fetchTarget → our code (the host's message never reaches the browser). */
function netFail(e) {
  const msg = String((e && e.message) || '');
  if (e && e.code === 'ERR_NET_DENIED') return fail(/assigned/i.test(msg) ? 'TARGET_UNASSIGNED' : 'TARGET_DENIED');
  if (e && e.code === 'ERR_INVALID') return fail('TARGET_DENIED');
  if (TLS_RE.test(msg)) return fail('TLS_CERT');
  if (/time(d)?\s?out|ETIMEDOUT/i.test(msg)) return fail('TIMEOUT');
  return fail('UNREACHABLE');
}

/** DSM error code → our error (auth = the code of a login). */
function dsmFail(code, { auth = false, api = null } = {}) {
  const c = Number(code);
  const mapped = (auth && AUTH[c]) || COMMON[c] || 'DSM_ERROR';
  return fail(mapped, { dsm: Number.isFinite(c) ? c : null, api });
}

/** The version to call: `preferred`, within the API's [minVersion, maxVersion]. */
function pickVersion(info, preferred) {
  const min = Number(info && info.minVersion) || 1;
  const max = Math.max(min, Number(info && info.maxVersion) || min);
  return Math.max(min, Math.min(max, preferred));
}

/**
 * The API parameters as form values. An API with requestFormat "JSON" (most
 * SYNO.Core.* and package APIs on DSM 7) takes every parameter JSON-encoded
 * (strings quoted); the others take plain strings (arrays still as JSON).
 */
function encodeParams(info, params) {
  const out = {};
  const json = info && String(info.requestFormat || '').toUpperCase() === 'JSON';
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined) continue;
    if (json) out[k] = JSON.stringify(v);
    else out[k] = v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  return out;
}

/**
 * One request → data of a successful answer (throws DsmError).
 * @param {Function} send  (path, opts) → { status, headers, body }
 */
async function request(send, path, { query, form, headers, timeoutMs, auth, api } = {}) {
  const url = query ? `${path}?${new URLSearchParams(query).toString()}` : path;
  let res;
  try {
    res = await send(url, { method: form ? 'POST' : 'GET', form: form || undefined, headers: { accept: 'application/json', ...(headers || {}) }, timeoutMs: timeoutMs || TIMEOUT_MS, redirect: 'manual' });
  } catch (e) { throw netFail(e); }
  const status = Number(res && res.status);
  const body = typeof (res && res.body) === 'string' ? res.body : '';
  if (status >= 300 && status < 400) {
    const loc = String((res.headers && res.headers.location) || '');
    throw fail(/^https:/i.test(loc) ? 'HTTPS_REDIRECT' : 'HTTP_REDIRECT');
  }
  if (status === 400 && /plain HTTP request was sent to HTTPS port/i.test(body)) throw fail('HTTP_TO_HTTPS_PORT');
  if (status !== 200) throw fail('HTTP_ERROR', { http: Number.isFinite(status) ? status : null });
  let j;
  try { j = JSON.parse(body); } catch { throw fail('NOT_DSM'); }
  if (!j || typeof j !== 'object' || typeof j.success !== 'boolean') throw fail('NOT_DSM');
  if (!j.success) throw dsmFail(j.error && j.error.code, { auth, api });
  return j.data && typeof j.data === 'object' ? j.data : {};
}

/** In-memory session of one NAS (never persisted: a restart logs in again). */
function newSession() {
  return { apis: null, sid: null, token: null, loginAt: 0, used: false, device: null };
}

/**
 * @param {object} o
 * @param {Function} o.send                        (path, opts) → response (gc.net.fetchTarget bound to the NAS)
 * @param {() => Promise<{account, password, device}>} o.credentials  read when a login is needed
 * @param {object} [o.session]                     newSession() kept by the caller between polls
 * @param {string} [o.deviceName]
 * @param {() => number} [o.now]
 */
function createClient({ send, credentials, session, deviceName = DEVICE_NAME, now = () => Date.now() }) {
  const s = session || newSession();

  async function apis() {
    if (s.apis) return s.apis;
    const data = await request(send, '/webapi/query.cgi', { query: { api: 'SYNO.API.Info', version: '1', method: 'query', query: APIS.join(',') } });
    if (!data['SYNO.API.Auth']) throw fail('NOT_DSM');
    s.apis = data;
    return data;
  }

  function apiPath(info) {
    const p = String((info && info.path) || 'entry.cgi');
    if (!/^[A-Za-z0-9._/-]{1,100}$/.test(p) || p.includes('..')) throw fail('NOT_DSM');
    return '/webapi/' + p.replace(/^\/+/, '');
  }

  /**
   * SYNO.API.Auth login. `otp`: a one-time code — then DSM also issues a
   * device token (→ { did }) for later logins without a code.
   */
  async function login({ otp } = {}) {
    const info = (await apis())['SYNO.API.Auth'];
    const version = pickVersion(info, 6);
    if (version < 3) throw fail('DSM_TOO_OLD');
    const c = (await credentials()) || {};
    if (!c.account || !c.password) throw fail('NO_CREDENTIALS');
    const form = {
      api: 'SYNO.API.Auth', version: String(version), method: 'login',
      account: c.account, passwd: c.password, session: SESSION_NAME, format: 'sid', enable_syno_token: 'yes',
    };
    if (otp) Object.assign(form, { otp_code: String(otp), enable_device_token: 'yes', device_name: deviceName });
    else if ((c.device || s.device) && version >= 6) Object.assign(form, { device_id: c.device || s.device, device_name: deviceName });
    s.sid = null;
    s.token = null;
    const data = await request(send, apiPath(info), { form, auth: true, api: 'SYNO.API.Auth' });
    if (typeof data.sid !== 'string' || !data.sid) throw fail('NOT_DSM');
    s.sid = data.sid;
    s.token = typeof data.synotoken === 'string' && data.synotoken ? data.synotoken : null;
    s.loginAt = now();
    s.used = false;
    const did = typeof data.did === 'string' && data.did ? data.did : (typeof data.device_id === 'string' && data.device_id ? data.device_id : null);
    if (did) s.device = did; // a relogin of this session needs no code either
    return { did, version };
  }

  /**
   * Call `api`.`method` (version: preferred, clamped to what the NAS offers).
   * Logs in when there is no session; a stale session (106/107/119, or 105
   * on a session that worked before) logs in again once and repeats the call.
   */
  async function call(api, method, params = {}, { version = 1, timeoutMs } = {}) {
    const all = await apis();
    const info = all[api];
    if (!info) throw fail('API_MISSING', { api });
    const v = pickVersion(info, version);
    let fresh = false;
    for (;;) {
      if (!s.sid) { await login(); fresh = true; }
      try {
        const data = await request(send, apiPath(info), {
          form: { api, version: String(v), method, ...encodeParams(info, params), _sid: s.sid },
          headers: s.token ? { 'X-SYNO-TOKEN': s.token } : {}, timeoutMs, api,
        });
        s.used = true;
        return data;
      } catch (e) {
        if (!fresh && (RELOGIN.has(e.dsm) || (e.dsm === 105 && s.used))) {
          const old = s.sid;
          s.sid = null;
          s.token = null;
          fresh = true;
          if (e.dsm === 105) await endSession(old); // may still exist on the NAS
          await login();
          continue;
        }
        throw e;
      }
    }
  }

  /** SYNO.API.Auth logout of one session id (best effort). */
  async function endSession(sid) {
    try {
      const info = (s.apis || {})['SYNO.API.Auth'];
      if (!info || !sid) return;
      await request(send, apiPath(info), { form: { api: 'SYNO.API.Auth', version: String(pickVersion(info, 6)), method: 'logout', session: SESSION_NAME, _sid: sid }, timeoutMs: 5000 });
    } catch { /* best effort */ }
  }

  async function logout() {
    if (!s.sid) return;
    const sid = s.sid;
    s.sid = null;
    s.token = null;
    await endSession(sid);
  }

  return { apis, login, call, logout, session: s, has: (api) => !!(s.apis && s.apis[api]) };
}

module.exports = {
  createClient, newSession, request, pickVersion, encodeParams, netFail, dsmFail, DsmError, fail,
  APIS, COMMON, AUTH, RELOGIN, AUTH_CODES, OTP_CODES, NET_CODES, DEVICE_NAME, SESSION_NAME,
};
