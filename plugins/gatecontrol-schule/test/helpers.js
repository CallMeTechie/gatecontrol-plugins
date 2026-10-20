'use strict';

// Test helpers: the mock host (tools/testing/mock-host.js) with a fake WebUntis server behind
// gc.http.fetch, recorded JSON-RPC answers (test/fixtures) and a small household. The clock of
// the plugin (server/clock.js) is pinned: Tuesday 2026-10-20 08:00 in Berlin.
//
// The fake server checks what the real one checks: the JSON-RPC envelope, the school in the
// query, the password or the TOTP of the QR key, the session cookie (JSESSIONID +
// schoolname=_base64(school)) on every later call; it records logins, logouts and calls.

const fs = require('node:fs');
const path = require('node:path');
const { createHost } = require('../../../tools/testing/mock-host');
const clock = require('../server/clock');
const totp = require('../server/totp');

const DIR = path.join(__dirname, '..');
const ADMIN = { id: 1, name: 'admin', role: 'admin' };
const EVA = { id: 2, name: 'Eva', role: 'user' };      // parent
const LENA = { id: 3, name: 'Lena', role: 'user' };    // child
const BOB = { id: 4, name: 'Bob', role: 'user' };      // someone else
const WALL = { id: 5, name: 'Flur', role: 'user' };    // the wall tablet's account
const USERS = [ADMIN, EVA, LENA, BOB, WALL];

const HOST = 'nessa.webuntis.com';
const SCHOOL = 'Gymnasium Musterstadt';
const SECRET = 'JBSWY3DPEHPK3PXP';
const QR = `untis://setschool?url=${HOST}&school=${encodeURIComponent(SCHOOL)}&user=eva.muster&key=${SECRET}&schoolNumber=4711`;
const T0 = Date.parse('2026-10-20T06:00:00Z'); // Tue 08:00 CEST

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));

/**
 * A fake WebUntis. opts: { account: 'parent' | 'student' | 'teacher', username, password, secret, noRight: [personId], down: bool }
 * state.timetable[personId] = raw lessons (a copy of the fixture, tests change it).
 */
function fakeUntis(opts = {}) {
  const tt = fixture('timetable.json');
  const state = {
    account: opts.account || 'parent',
    username: opts.username || (opts.account === 'student' ? 'lena.muster' : 'eva.muster'),
    password: opts.password || 'geheim',
    secret: opts.secret || SECRET,
    timetable: { 101: clone(tt['101']), 102: clone(tt['102']) },
    noRight: new Set(opts.noRight || []),
    down: !!opts.down,
    sessions: new Set(),
    logins: [], logouts: 0, calls: [], cookies: [], otps: [],
    loginError: null, // e.g. { code: -8504, message: 'bad credentials' }
    // 1.2.0: the REST answers — homework (data of api/homeworks/lessons, the whole account) and exams
    // (api/exams answers those within the dates); restStatus { homeworks: 403, exams: 500 } answers that status
    homework: { homeworks: [], lessons: [], teachers: [] },
    exams: [],
    restStatus: {},
    queries: [],
  };
  let n = 0;
  const json = (body, headers = {}) => ({ status: 200, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const rpcErr = (id, code, message) => json({ jsonrpc: '2.0', id, error: { code, message } });
  const schoolCookie = 'schoolname=' + encodeURIComponent('_' + Buffer.from(SCHOOL, 'latin1').toString('base64'));
  const sessionOf = (o) => {
    const c = String((o.headers && (o.headers.cookie || o.headers.Cookie)) || '');
    state.cookies.push(c);
    const m = /JSESSIONID=([^;]+)/.exec(c);
    return m && state.sessions.has(m[1]) && c.includes(schoolCookie) ? m[1] : null;
  };
  const config = () => (state.account === 'teacher'
    ? { data: { loginServiceConfig: { user: { personId: 300, persons: [{ id: 300, type: 2, displayName: 'Herr Lehrer' }] } } } }
    : fixture(state.account === 'student' ? 'appconfig_student.json' : 'appconfig_parent.json'));
  const self = () => ({ student: { personId: 101, personType: 5 }, teacher: { personId: 300, personType: 2 } }[state.account] || { personId: 900, personType: 12 });
  const newSession = () => { const id = `S${++n}x${Math.random().toString(16).slice(2, 10)}`; state.sessions.add(id); return id; };

  async function handler(url, o = {}) {
    if (state.down) throw Object.assign(new Error('timeout'), { code: 'ERR_NET' });
    const u = new URL(url);
    if (u.hostname !== HOST) return { status: 404, body: 'unknown host' };
    const p = u.pathname;
    if (p === '/WebUntis/api/app/config' && (o.method || 'GET') === 'GET') {
      state.calls.push('app/config');
      if (!sessionOf(o)) return { status: 401, body: '' };
      return json(config());
    }
    if ((p === '/WebUntis/api/homeworks/lessons' || p === '/WebUntis/api/exams') && (o.method || 'GET') === 'GET') {
      const kind = p.endsWith('/exams') ? 'exams' : 'homeworks';
      state.calls.push(kind);
      state.queries.push({ kind, query: Object.fromEntries(u.searchParams) });
      if (!sessionOf(o)) return { status: 401, body: '' };
      if (state.restStatus[kind]) return { status: state.restStatus[kind], body: '' };
      const from = Number(u.searchParams.get('startDate'));
      const to = Number(u.searchParams.get('endDate'));
      if (kind === 'exams') return json({ data: { exams: clone(state.exams.filter((e) => e.examDate >= from && e.examDate <= to)) } });
      return json({ data: clone(state.homework) });
    }
    if (o.method !== 'POST' || !o.json || o.json.jsonrpc !== '2.0') return { status: 400, body: 'bad request' };
    const { id, method, params } = o.json;
    state.calls.push(method);
    if (u.searchParams.get('school') !== SCHOOL) return rpcErr(id, -8500, 'invalid schoolname');
    if (p === '/WebUntis/jsonrpc_intern.do') {
      if (u.searchParams.get('m') !== 'getUserData2017' || method !== 'getUserData2017') return rpcErr(id, -32601, 'method not found');
      const auth = params && params[0] && params[0].auth;
      state.otps.push(auth && auth.otp);
      if (state.loginError) return rpcErr(id, state.loginError.code, state.loginError.message);
      if (!auth || auth.user !== state.username || auth.otp !== totp.totp(state.secret, auth.clientTime)) return rpcErr(id, -8504, 'invalid otp');
      state.logins.push('secret');
      const sid = newSession();
      return json({ jsonrpc: '2.0', id, result: { masterData: {}, userData: { elemType: 'STUDENT' } } }, { 'set-cookie': [`traceId=abc; Path=/`, `JSESSIONID=${sid}; Path=/WebUntis; Secure; HttpOnly`] });
    }
    if (p !== '/WebUntis/jsonrpc.do') return { status: 404, body: '' };
    if (method === 'authenticate') {
      if (state.loginError) return rpcErr(id, state.loginError.code, state.loginError.message);
      if (!params || params.user !== state.username || params.password !== state.password) return rpcErr(id, -8504, 'bad credentials');
      state.logins.push('password');
      const sid = newSession();
      return json({ jsonrpc: '2.0', id, result: { sessionId: sid, ...self(), klasseId: 501 } }, { 'set-cookie': [`JSESSIONID=${sid}; Path=/WebUntis`] });
    }
    const sid = sessionOf(o);
    if (!sid) return rpcErr(id, -8520, 'not authenticated');
    if (method === 'logout') { state.sessions.delete(sid); state.logouts += 1; return json({ jsonrpc: '2.0', id, result: null }); }
    if (method === 'getTimegridUnits') return json({ ...fixture('timegrid.json'), id });
    if (method === 'getHolidays') return json({ ...fixture('holidays.json'), id });
    if (method === 'getTimetable') {
      const opt = params.options;
      const pid = opt.element.id;
      if (opt.element.type !== 5) return rpcErr(id, -32602, 'invalid element type');
      if (state.noRight.has(pid)) return rpcErr(id, -8509, 'no right for timetable');
      const list = (state.timetable[pid] || []).filter((l) => l.date >= opt.startDate && l.date <= opt.endDate);
      return json({ jsonrpc: '2.0', id, result: list });
    }
    return rpcErr(id, -32601, 'method not found');
  }
  return { handler, state };
}

/**
 * A host with the household, a fake WebUntis and the pinned clock. fn(host, untis).
 * opts.services: other plugins (the Familie plugin's rule_event); opts.gatecontrol: '1.178.0' for gc.services.available.
 */
async function withHost(opts, fn) {
  const untis = fakeUntis(opts.untis);
  clock.set(opts.now || T0);
  const host = await createHost(DIR, {
    users: USERS,
    settings: opts.settings || {},
    notifyFail: opts.notifyFail,
    fetch: (url, o) => untis.handler(url, o),
    services: opts.services,
    gatecontrol: opts.gatecontrol,
  });
  await host.start();
  try { return await fn(host, untis); } finally { await host.close(); clock.set(null); }
}

const asAdmin = (host, method, p, body, query) => host.request({ method, path: p, body: body === undefined ? null : body, query: query || {}, user: ADMIN });
const asPortal = (host, user, p, query, extra) => host.request({ method: 'GET', path: p, query: query || {}, body: null, user: { ...user, portal: true, loggedIn: true, ...(extra || {}) } });
const asApp = (host, user, p, query) => host.request({ method: 'GET', path: p, query: query || {}, body: null, user: { ...user, portal: true, loggedIn: true, app: true } });

/** Adds the parent account by QR link; Lena (101) → user LENA with EVA as recipient. → { account, lena, max } */
async function setupParent(host, { wall = false } = {}) {
  const r = await asAdmin(host, 'POST', '/accounts', { mode: 'qr', link: QR });
  if (r.status !== 201) throw new Error('setup failed: ' + JSON.stringify(r.json));
  const st = (await asAdmin(host, 'GET', '/status')).json;
  const acc = st.accounts[0];
  const lena = acc.students.find((s) => s.person_id === 101);
  const max = acc.students.find((s) => s.person_id === 102);
  await asAdmin(host, 'PUT', `/students/${lena.id}`, { user_id: LENA.id, recipients: [EVA.id], show_on_wall: wall });
  return { account: acc, lena, max };
}

/** A lesson of the fake timetable: person, "YYYYMMDD" as number, start (hmm). */
function lessonAt(untis, pid, date, start) {
  return untis.state.timetable[pid].find((l) => l.date === date && l.startTime === start);
}

/** Moves the clock and runs one background tick. */
async function tickAt(host, ms) {
  clock.set(ms);
  await host.tick();
}

const at = (iso) => Date.parse(iso);

module.exports = {
  DIR, ADMIN, EVA, LENA, BOB, WALL, USERS, HOST, SCHOOL, SECRET, QR, T0,
  fixture, clone, fakeUntis, withHost, asAdmin, asPortal, asApp, setupParent, lessonAt, tickAt, at, clock,
};
