'use strict';

// WebUntis client over gc.http.fetch (no npm dependency). WebUntis has no
// public API for this: the plugin speaks the protocol of the WebUntis web
// app and its JSON-RPC interface as the MIT-licensed "webuntis" npm library
// documents it (read, not bundled):
//
//   JSON-RPC   POST https://<host>/WebUntis/jsonrpc.do?school=<school>
//              { id, method, params, jsonrpc: '2.0' } → { result } | { error: { code, message } }
//              (some errors come as result.code)
//   password   authenticate { user, password, client } → { sessionId, personType, personId }
//   QR secret  POST /WebUntis/jsonrpc_intern.do?m=getUserData2017&school=<school>&v=i2.2
//              params [{ auth: { clientTime, user, otp } }] — otp = TOTP of the QR key
//              (server/totp.js); the session id comes as Set-Cookie JSESSIONID
//   session    Cookie: JSESSIONID=<id>; schoolname=<encodeURIComponent("_" + base64(school))>
//   persons    GET /WebUntis/api/app/config → data.loginServiceConfig.user { personId, persons:
//              [{ id, type, displayName }] } — type 5 student, 12 legal guardian, 2 teacher
//   data       getTimetable { options: { element: { id, type: 5 }, startDate, endDate, … } },
//              getTimegridUnits, getHolidays; logout at the end of every cycle
//
// Errors become stable codes (UntisError.code): 'auth' (bad credentials,
// invalid one-time password, unknown school), 'no_right' (JSON-RPC -8509:
// the account may not read that), 'network' (no answer, timeout, 5xx) and
// 'failed' (anything else). Secrets, one-time passwords and session ids
// never reach a log line, an error message or the database.

const totp = require('./totp');

const CLIENT = 'GateControl';
const TIMEOUT_MS = 20000;
const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+webuntis\.com$/;

class UntisError extends Error {
  constructor(code, detail) {
    super(code);
    this.code = code;
    if (detail != null) this.detail = detail; // a JSON-RPC error code or HTTP status, never a body
  }
}

const fail = (code, detail) => new UntisError(code, detail);

/** A server address as typed or pasted ("https://xyz.webuntis.com/WebUntis/…") → "xyz.webuntis.com"; null when not *.webuntis.com:443. */
function normalizeHost(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim().toLowerCase();
  if (!s || s.length > 253) return null;
  s = s.replace(/^https:\/\//, '');
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) return null; // another scheme
  s = s.split(/[/?#]/)[0];
  const port = /:(\d+)$/.exec(s);
  if (port) {
    if (port[1] !== '443') return null;
    s = s.slice(0, -port[0].length);
  }
  s = s.replace(/\.$/, '');
  return HOST_RE.test(s) ? s : null;
}

const cleanText = (v, max) => (typeof v === 'string' ? v.replace(/[\0-\x1f\x7f]/g, '').trim() : '').slice(0, max);

/**
 * The link of the WebUntis QR code ("untis://setschool?url=…&school=…&user=…&key=…&schoolNumber=…")
 * → { host, school, username, secret }. Throws UntisError 'QR_INVALID' / 'HOST_INVALID'.
 */
function parseQrLink(link) {
  const s = typeof link === 'string' ? link.trim() : '';
  if (!s || s.length > 2000 || !/^untis:\/\//i.test(s)) throw fail('QR_INVALID');
  let u;
  try { u = new URL(s); } catch { throw fail('QR_INVALID'); }
  const q = u.searchParams;
  const host = normalizeHost(q.get('url') || '');
  if (!host) throw fail(q.get('url') ? 'HOST_INVALID' : 'QR_INVALID');
  const school = cleanText(q.get('school'), 120);
  const username = cleanText(q.get('user'), 120);
  const secret = String(q.get('key') || '').replace(/\s+/g, '').toUpperCase();
  if (!school || !username || !secret || secret.length > 200) throw fail('QR_INVALID');
  try { if (totp.base32Decode(secret).length < 5) throw new Error('short'); } catch { throw fail('QR_INVALID'); }
  return { host, school, username, secret };
}

/** The schoolname cookie value as the web app sends it: "_" + base64(school), URL-encoded. */
function schoolCookie(school) {
  const latin1 = /^[\x00-\xff]*$/.test(school);
  return encodeURIComponent('_' + Buffer.from(school, latin1 ? 'latin1' : 'utf8').toString('base64'));
}

/** The JSESSIONID of a Set-Cookie list (gc.http.fetch keeps set-cookie as a list). */
function sessionFromSetCookie(list) {
  for (const line of [].concat(list || [])) {
    const m = /(?:^|;\s*)JSESSIONID=([^;\s]+)/i.exec(String(line));
    if (m) return m[1];
  }
  return null;
}

const AUTH_CODES = new Set([-8500, -8501, -8502, -8504, -8520, -8998, -8997]);
const AUTH_TEXT = /credential|password|passwort|otp|one.?time|authenticat|not logged|invalid user|invalid school|schoolname/i;
const RIGHT_TEXT = /no right|keine berechtigung|not allowed|no permission/i;

/** A JSON-RPC error { code, message } → UntisError (message is only matched, never kept). */
function rpcError(err) {
  const code = Number(err && err.code);
  const msg = String((err && err.message) || '');
  if (code === -8509 || RIGHT_TEXT.test(msg)) return fail('no_right', code || null);
  if (AUTH_CODES.has(code) || AUTH_TEXT.test(msg)) return fail('auth', code || null);
  return fail('failed', Number.isFinite(code) ? code : null);
}

/** Any error of this module or of gc.http.fetch → one of the stable codes. */
function codeOf(e) {
  if (e instanceof UntisError && ['auth', 'no_right', 'network', 'failed'].includes(e.code)) return e.code;
  return 'failed';
}

const NO_ALLOWED_DATE = -7004; // getTimetable outside the school year

const pad2 = (n) => String(n).padStart(2, '0');
/** "YYYY-MM-DD" → 20261021 */
const untisDate = (d) => Number(String(d).replace(/-/g, ''));

/**
 * A session with one account: login → calls → logout. `account` = { host, school, username, auth };
 * `cred` = { secret } (auth 'secret') or { password } (auth 'password').
 */
function createClient(gc, account, opts = {}) {
  const host = normalizeHost(account.host);
  if (!host) throw fail('failed');
  const base = `https://${host}/WebUntis`;
  const school = String(account.school);
  const timeoutMs = opts.timeoutMs || TIMEOUT_MS;
  let sessionId = null;
  let rid = 0;

  const cookie = () => `JSESSIONID=${sessionId}; schoolname=${schoolCookie(school)}`;

  async function http(url, o) {
    let res;
    try {
      res = await gc.http.fetch(url, { ...o, timeoutMs, headers: { accept: 'application/json', 'cache-control': 'no-cache', ...(o.headers || {}) } });
    } catch (e) {
      throw fail(e && e.code === 'ERR_NET_DENIED' ? 'failed' : 'network', (e && e.code) || null);
    }
    const st = Number(res && res.status);
    if (st === 401 || st === 403) throw fail('auth', st);
    if (st === 429 || st >= 500) throw fail('network', st);
    if (!(st >= 200 && st < 300)) throw fail('failed', st);
    let body;
    try { body = JSON.parse(res.body); } catch { throw fail('failed', 'json'); }
    return { res, body };
  }

  async function rpc(method, params, { url } = {}) {
    rid += 1;
    const { res, body } = await http(url || `${base}/jsonrpc.do?school=${encodeURIComponent(school)}`, {
      method: 'POST',
      headers: sessionId ? { cookie: cookie() } : {},
      json: { id: `gc-${rid}`, method, params, jsonrpc: '2.0' },
    });
    if (!body || typeof body !== 'object') throw fail('failed', 'json');
    if (body.error) throw rpcError(body.error);
    if (body.result && typeof body.result === 'object' && !Array.isArray(body.result) && body.result.code != null) throw rpcError(body.result);
    return { result: body.result, res };
  }

  return {
    get loggedIn() { return !!sessionId; },

    /** → { personId, personType } of the account (null when the login did not say). */
    async login(cred, now = Date.now()) {
      if (account.auth === 'secret') {
        const otp = totp.totp(cred && cred.secret, now);
        const { res } = await rpc('getUserData2017', [{ auth: { clientTime: now, user: account.username, otp } }], {
          url: `${base}/jsonrpc_intern.do?m=getUserData2017&school=${encodeURIComponent(school)}&v=i2.2`,
        });
        sessionId = sessionFromSetCookie(res.headers && res.headers['set-cookie']);
        if (!sessionId) throw fail('failed', 'no_session');
        return { personId: null, personType: null };
      }
      const { result } = await rpc('authenticate', { user: account.username, password: (cred && cred.password) || '', client: CLIENT });
      if (!result || typeof result.sessionId !== 'string' || !result.sessionId) throw fail('auth', 'no_session');
      sessionId = result.sessionId;
      return {
        personId: Number.isInteger(result.personId) ? result.personId : null,
        personType: Number.isInteger(result.personType) ? result.personType : null,
      };
    },

    /** GET api/app/config → { personId, persons: [{ id, type, name }] } (persons of the account: itself, its children). */
    async appConfig() {
      const { body } = await http(`${base}/api/app/config`, { method: 'GET', headers: { cookie: cookie() } });
      const u = body && body.data && body.data.loginServiceConfig && body.data.loginServiceConfig.user;
      if (!u || typeof u !== 'object') throw fail('failed', 'config');
      const persons = Array.isArray(u.persons) ? u.persons : [];
      return {
        personId: Number.isInteger(u.personId) ? u.personId : null,
        persons: persons.filter((p) => p && Number.isInteger(p.id)).map((p) => ({ id: p.id, type: personType(p.type), name: personName(p) })),
      };
    },

    /** getTimetable of a student between two local dates (inclusive) → raw lessons ([] outside the school year). */
    async timetable(personId, from, to) {
      try {
        const { result } = await rpc('getTimetable', {
          options: {
            id: Date.now(), element: { id: personId, type: 5 }, startDate: untisDate(from), endDate: untisDate(to),
            showLsText: true, showStudentgroup: true, showLsNumber: true, showSubstText: true, showInfo: true, showBooking: true,
            klasseFields: ['id', 'name', 'longname', 'externalkey'], roomFields: ['id', 'name', 'longname', 'externalkey'],
            subjectFields: ['id', 'name', 'longname', 'externalkey'], teacherFields: ['id', 'name', 'longname', 'externalkey'],
          },
        });
        return Array.isArray(result) ? result : [];
      } catch (e) {
        if (e instanceof UntisError && e.detail === NO_ALLOWED_DATE) return [];
        throw e;
      }
    },

    async timegrid() {
      const { result } = await rpc('getTimegridUnits', {});
      return Array.isArray(result) ? result : [];
    },

    async holidays() {
      const { result } = await rpc('getHolidays', {});
      return Array.isArray(result) ? result : [];
    },

    /** Ends the session (errors ignored: the session expires on its own). */
    async logout() {
      if (!sessionId) return;
      try { await rpc('logout', {}); } catch { /* expires on the server */ }
      sessionId = null;
    },
  };
}

const TYPE_NAMES = { STUDENT: 5, LEGAL_GUARDIAN: 12, PARENT: 12, TEACHER: 2 };
function personType(t) {
  if (Number.isInteger(t)) return t;
  return TYPE_NAMES[String(t || '').toUpperCase()] || null;
}
function personName(p) {
  const n = cleanText(p.displayName, 80) || cleanText([p.foreName, p.longName].filter(Boolean).join(' '), 80) || cleanText(p.name, 80);
  return n || null;
}

/**
 * The students an account may read: a student account → itself; a parent account → the persons
 * of type 5 it lists (its children). `login` = what the login said, `cfg` = appConfig() or null.
 */
function studentsOf(account, login, cfg) {
  const selfId = (cfg && cfg.personId) || (login && login.personId) || null;
  const persons = (cfg && cfg.persons) || [];
  const self = persons.find((p) => p.id === selfId);
  const selfType = (self && self.type) || (login && login.personType) || null;
  if (selfType === 5 && selfId) return [{ personId: selfId, name: (self && self.name) || account.username }];
  const seen = new Set();
  return persons.filter((p) => p.type === 5 && p.id !== selfId && !seen.has(p.id) && seen.add(p.id))
    .map((p) => ({ personId: p.id, name: p.name || `#${p.id}` }));
}

module.exports = {
  UntisError, normalizeHost, parseQrLink, schoolCookie, sessionFromSetCookie, rpcError, codeOf, createClient, studentsOf,
  untisDate, pad2, CLIENT,
};
