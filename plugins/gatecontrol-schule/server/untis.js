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
//   1.2.0      the REST interface of the web app with the same session cookie (optional data — a
//              failure never stops the timetable, see server/extras.js):
//              GET /WebUntis/api/homeworks/lessons?startDate=yyyymmdd&endDate=yyyymmdd
//                → { data: { homeworks: [{ id, lessonId, date, dueDate, text, remark, completed }],
//                            lessons: [{ id, subject, lessonType }], records?, teachers? } }
//              GET /WebUntis/api/exams?startDate&endDate&klasseId[&studentId]&withGrades=false
//                → { data: { exams: [{ id, examType, name, examDate, startTime, endTime, subject,
//                            teachers, rooms, text, studentClass?, assignedStudents?: [{ id, displayName, klasse }] }] } }
//   1.3.0      exams are asked like the "webuntis" library does (klasseId of the student's class,
//              withGrades=false, no studentId — 'class'), then with the studentId ('student'), then for
//              the account's own class (klasseId=-1 — 'own'): a parent account is refused the
//              studentId variant by some schools (HTTP 403). The REST answers of these optional
//              endpoints map 401/403 to 'no_right' (the same session just read the timetable, so the
//              login is fine) and 404 to 'unsupported' — never 'auth'.
//   1.4.0      school messages and absences (optional like homework / exams, read only — nothing is
//              ever marked as read, sent or changed in WebUntis):
//              GET /WebUntis/api/token/new (session cookie) → the JWT of the session as text
//              GET /WebUntis/api/rest/view/v1/messages (cookie + Authorization: Bearer <jwt>)
//                → { incomingMessages: [{ id, subject, contentPreview, hasAttachments, isMessageRead,
//                    sender: { displayName, className }, sentDateTime }] } — the account's inbox (a parent
//                    account: the parents' inbox, a student account: the student's). No detail call: opening
//                    a message in WebUntis may mark it as read.
//                1.4.1: also readConfirmationMessages — a message the sender wants confirmed (school-wide
//                    information to all parents often is) comes in that list, not in incomingMessages;
//                    every list is read (top level or under data), the same id counts once.
//              GET /WebUntis/api/classreg/absences/students?startDate&endDate&studentId&excuseStatusId=-1
//                → { data: { absences: [{ id, startDate, endDate, startTime, endTime, reason, text,
//                    excuseStatus, isExcused, excuse: { id, excuseStatus, isExcused, … }, studentName }] } }
//              The JWT is asked once per session, kept in memory only and never logged.
//   1.5.0      the messages without WebUntis (as the MIT-licensed "webuntis-fetcher" reads them — read, not
//              bundled): every inbox item says which list it came from (`list`);
//              GET  /WebUntis/api/rest/view/v1/messages/<id> (cookie + Bearer) → { content (HTML), storageAttachments:
//                   [{ id, name, size? }], … } — the full text and the attachments, asked once per message (it
//                   may mark the message as read in WebUntis);
//              GET  /WebUntis/api/rest/view/v1/messages/<attachmentId>/attachmentstorageurl → { downloadUrl,
//                   additionalHeaders: [{ key, value }] } — a short-lived link to the file at the storage (S3);
//                   the file itself is fetched by GateControl (gc.media.fetch) with those headers;
//              POST /WebUntis/api/rest/view/v1/messages/<id>/read-confirmation → { confirmationDate } — only when a
//                   person taps "Lesen bestätigen" (the one write to WebUntis).
//
// Errors become stable codes (UntisError.code): 'auth' (bad credentials,
// invalid one-time password, unknown school), 'no_right' (JSON-RPC -8509:
// the account may not read that), 'network' (no answer, timeout, 5xx),
// 'unsupported' (1.3.0: an optional endpoint this WebUntis does not have) and
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
// 1.5.0: ids in the paths of the message calls
const MSG_ID_RE = /^[A-Za-z0-9_.-]{1,40}$/;
const ATT_ID_RE = /^[A-Za-z0-9_.-]{1,80}$/;
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;
const HOP_HEADERS = new Set(['host', 'cookie', 'authorization', 'connection', 'content-length', 'transfer-encoding']);

/**
 * 1.5.0: the answer of …/attachmentstorageurl → { url, headers }: an https link (≤ 4096 characters)
 * and at most 16 extra headers (names plain, values without line breaks; host / cookie / authorization
 * never). Throws 'failed' when unusable.
 */
function storageLink(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? (body.data && typeof body.data === 'object' && body.downloadUrl === undefined ? body.data : body) : null;
  const url = b && typeof b.downloadUrl === 'string' ? b.downloadUrl.trim() : '';
  let u;
  try { u = new URL(url); } catch { throw fail('failed', 'storage'); }
  if (u.protocol !== 'https:' || url.length > 4096 || u.username || u.password) throw fail('failed', 'storage');
  const headers = {};
  const list = Array.isArray(b.additionalHeaders) ? b.additionalHeaders : [];
  for (const h of list.slice(0, 16)) {
    const k = h && typeof h.key === 'string' ? h.key.trim() : '';
    const v = h && h.value != null ? String(h.value) : '';
    if (!HEADER_NAME_RE.test(k) || HOP_HEADERS.has(k.toLowerCase()) || /[\r\n\0]/.test(v) || v.length > 2048) continue;
    headers[k] = v;
  }
  return { url: u.toString(), headers };
}
// 1.4.1: the lists of the inbox answer (api/rest/view/v1/messages)
const INBOX_LISTS = Object.freeze(['incomingMessages', 'readConfirmationMessages', 'messages']);

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
  if (e instanceof UntisError && ['auth', 'no_right', 'network', 'unsupported', 'failed'].includes(e.code)) return e.code;
  return 'failed';
}

const NO_ALLOWED_DATE = -7004; // getTimetable outside the school year

// 1.3.0: the ways of asking api/exams, in the order tried (see the header)
const EXAM_VARIANTS = Object.freeze(['class', 'student', 'own']);

/** The query of api/exams for one variant (null when the variant needs an id that is missing). */
function examsQuery(variant, from, to, klasseId, studentId) {
  const kid = Number.isSafeInteger(klasseId) && klasseId > 0 ? klasseId : null;
  const sid = Number.isSafeInteger(studentId) && studentId > 0 ? studentId : null;
  const base = `startDate=${untisDate(from)}&endDate=${untisDate(to)}`;
  if (variant === 'class') return kid ? `${base}&klasseId=${kid}&withGrades=false` : null;
  if (variant === 'student') return sid ? `${base}&klasseId=${kid || -1}&studentId=${sid}&withGrades=false` : null;
  if (variant === 'own') return `${base}&klasseId=-1&withGrades=false`;
  return null;
}

const pad2 = (n) => String(n).padStart(2, '0');
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

/** 1.4.0: the answer of api/token/new (plain text, a JSON string or { token }) → the JWT, null when none. */
function jwtOf(text) {
  let v = typeof text === 'string' ? text.trim() : '';
  if (v.startsWith('"') || v.startsWith('{')) {
    try {
      const j = JSON.parse(v);
      v = typeof j === 'string' ? j : (j && typeof j === 'object' && (typeof j.token === 'string' ? j.token : (typeof j.jwt === 'string' ? j.jwt : ''))) || '';
    } catch { v = ''; }
  }
  v = v.trim();
  return v.length <= 8192 && JWT_RE.test(v) ? v : null;
}
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
  let jwt = null; // 1.4.0: the session's token for the REST views (memory only)
  let rid = 0;

  const cookie = () => `JSESSIONID=${sessionId}; schoolname=${schoolCookie(school)}`;

  /** opt.optional (1.3.0): an optional REST endpoint — 401/403 → 'no_right', 404 → 'unsupported'. */
  async function http(url, o, opt = {}) {
    let res;
    try {
      res = await gc.http.fetch(url, { ...o, timeoutMs, headers: { accept: 'application/json', 'cache-control': 'no-cache', ...(o.headers || {}) } });
    } catch (e) {
      throw fail(e && e.code === 'ERR_NET_DENIED' ? 'failed' : 'network', (e && e.code) || null);
    }
    const st = Number(res && res.status);
    if (st === 401 || st === 403) throw fail(opt.optional ? 'no_right' : 'auth', st);
    if (st === 404 && opt.optional) throw fail('unsupported', st);
    if (st === 429 || st >= 500) throw fail('network', st);
    if (!(st >= 200 && st < 300)) throw fail('failed', st);
    if (opt.raw) return { res, text: typeof res.body === 'string' ? res.body : '' };
    if (opt.allowEmpty && !(typeof res.body === 'string' && res.body.trim())) return { res, body: null };
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

    /**
     * 1.2.0: the homework of the account between two local dates (the web app's homework list) →
     * the raw `data` { homeworks, lessons, records?, … }. Throws like every call (codes above).
     */
    async homework(from, to) {
      const q = `startDate=${untisDate(from)}&endDate=${untisDate(to)}`;
      const { body } = await http(`${base}/api/homeworks/lessons?${q}`, { method: 'GET', headers: { cookie: cookie() } }, { optional: true });
      const data = body && body.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw fail('failed', 'homework');
      return data;
    },

    /**
     * 1.2.0: the exams between two local dates → the raw exams ([] when there are none). 1.3.0: asked
     * in one of EXAM_VARIANTS (default 'class': the student's class like the "webuntis" library);
     * a variant that needs a missing id throws 'unsupported'. No grades are asked for.
     */
    async exams(from, to, { klasseId, studentId, variant = 'class' } = {}) {
      const q = examsQuery(variant, from, to, klasseId, studentId);
      if (!q) throw fail('unsupported', 'variant');
      const { body } = await http(`${base}/api/exams?${q}`, { method: 'GET', headers: { cookie: cookie() } }, { optional: true });
      const data = body && body.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw fail('failed', 'exams');
      return Array.isArray(data.exams) ? data.exams : [];
    },

    /** 1.4.0: the JWT of this session (api/token/new, asked once per session). Optional endpoint. */
    async token() {
      if (jwt) return jwt;
      const { text } = await http(`${base}/api/token/new`, { method: 'GET', headers: { cookie: cookie(), accept: 'text/plain, application/json' } }, { optional: true, raw: true });
      const v = jwtOf(text);
      if (!v) throw fail('failed', 'token');
      jwt = v;
      return jwt;
    },

    /**
     * 1.4.0: the account's inbox (read only) → the raw incoming messages ([] when empty). Throws like the
     * optional endpoints ('no_right' / 'unsupported' / 'network' / 'failed').
     */
    async inbox() {
      const token = await this.token();
      const { body } = await http(`${base}/api/rest/view/v1/messages`, { method: 'GET', headers: { cookie: cookie(), authorization: `Bearer ${token}` } }, { optional: true });
      const b = body && typeof body === 'object' ? body : null;
      if (!b) throw fail('failed', 'messages');
      if (Array.isArray(b)) return b;
      // 1.4.1: every list of the inbox — incoming, to be confirmed (school-wide information often is), plain;
      // 1.5.0: each item says its list ({ ...item, list })
      const out = [];
      let found = false;
      for (const o of [b, b.data && typeof b.data === 'object' && !Array.isArray(b.data) ? b.data : null]) {
        if (!o) continue;
        for (const k of INBOX_LISTS) {
          if (o[k] == null) continue;
          if (!Array.isArray(o[k])) throw fail('failed', 'messages');
          found = true;
          for (const m of o[k]) out.push(m && typeof m === 'object' && !Array.isArray(m) ? { ...m, list: k } : m);
        }
      }
      if (!found) throw fail('failed', 'messages');
      return out;
    },

    /** 1.5.0: one message in full (the detail call) → the raw answer { content, storageAttachments, … }. */
    async message(id) {
      const mid = String(id);
      if (!MSG_ID_RE.test(mid)) throw fail('failed', 'id');
      const token = await this.token();
      const { body } = await http(`${base}/api/rest/view/v1/messages/${encodeURIComponent(mid)}`, { method: 'GET', headers: { cookie: cookie(), authorization: `Bearer ${token}` } }, { optional: true });
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('failed', 'message');
      return body.data && typeof body.data === 'object' && !Array.isArray(body.data) && body.content === undefined ? body.data : body;
    },

    /**
     * 1.5.0: where an attachment can be fetched → { url, headers } (an https link to the storage, valid for
     * a short time, and the headers it needs). Throws 'failed' on anything else.
     */
    async attachmentUrl(attachmentId) {
      const aid = String(attachmentId);
      if (!ATT_ID_RE.test(aid)) throw fail('failed', 'id');
      const token = await this.token();
      const { body } = await http(`${base}/api/rest/view/v1/messages/${encodeURIComponent(aid)}/attachmentstorageurl`, { method: 'GET', headers: { cookie: cookie(), authorization: `Bearer ${token}` } }, { optional: true });
      return storageLink(body);
    },

    /** 1.5.0: tell the school the message was read (the sender asked for it) → the confirmation time (ms) or null. */
    async confirmRead(id) {
      const mid = String(id);
      if (!MSG_ID_RE.test(mid)) throw fail('failed', 'id');
      const token = await this.token();
      const { body } = await http(`${base}/api/rest/view/v1/messages/${encodeURIComponent(mid)}/read-confirmation`, { method: 'POST', headers: { cookie: cookie(), authorization: `Bearer ${token}` } }, { optional: true, allowEmpty: true });
      const v = body && typeof body === 'object' ? body.confirmationDate : null;
      const ms = typeof v === 'string' ? Date.parse(v) : (typeof v === 'number' ? v : NaN);
      return Number.isFinite(ms) ? ms : null;
    },

    /** 1.4.0: a student's absences between two local dates (excuseStatusId=-1: all) → the raw absences. */
    async absences(from, to, studentId) {
      const sid = Number.isSafeInteger(studentId) && studentId > 0 ? studentId : null;
      if (!sid) throw fail('unsupported', 'student');
      const q = `startDate=${untisDate(from)}&endDate=${untisDate(to)}&studentId=${sid}&excuseStatusId=-1`;
      const { body } = await http(`${base}/api/classreg/absences/students?${q}`, { method: 'GET', headers: { cookie: cookie() } }, { optional: true });
      const data = body && body.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw fail('failed', 'absences');
      return Array.isArray(data.absences) ? data.absences : [];
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
      jwt = null;
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
  untisDate, pad2, CLIENT, EXAM_VARIANTS, examsQuery, jwtOf, storageLink,
};
