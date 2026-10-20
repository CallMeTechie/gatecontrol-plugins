'use strict';

// The WebUntis client (server/untis.js) against the fake server of test/helpers.js: QR link
// parsing, host check, the password and the QR (TOTP) login with their cookies, the persons
// of parent and student accounts, error codes, logout.

const test = require('node:test');
const assert = require('node:assert/strict');
const untis = require('../server/untis');
const totp = require('../server/totp');
const { fakeUntis, HOST, SCHOOL, SECRET, QR, T0 } = require('./helpers');

/** A minimal gc for the client: http.fetch through a handler, with what the host records. */
function gcWith(handler) {
  const calls = [];
  return {
    calls,
    http: {
      fetch: async (url, o) => {
        calls.push({ url, o });
        const r = await handler(url, o);
        return { status: 200, headers: {}, url, redirects: [], ...r };
      },
    },
  };
}

test('QR link: the fields of untis://setschool', () => {
  const q = untis.parseQrLink(QR);
  assert.deepEqual(q, { host: HOST, school: SCHOOL, username: 'eva.muster', secret: SECRET });
  const spaced = untis.parseQrLink(`  untis://setschool?url=https://Nessa.WebUntis.com/&school=abc&user=x&key=jbsw y3dp ehpk3pxp\n`);
  assert.deepEqual([spaced.host, spaced.secret], ['nessa.webuntis.com', 'JBSWY3DPEHPK3PXP'], 'scheme/trailing slash, case and spaces');
});

test('QR link: wrong host and broken links are rejected', () => {
  const bad = (link, code) => assert.throws(() => untis.parseQrLink(link), (e) => e.code === code, link);
  bad('untis://setschool?url=evil.example.com&school=a&user=b&key=JBSWY3DPEHPK3PXP', 'HOST_INVALID');
  bad('untis://setschool?url=webuntis.com.evil.example&school=a&user=b&key=JBSWY3DPEHPK3PXP', 'HOST_INVALID');
  bad('untis://setschool?url=nessa.webuntis.com:8443&school=a&user=b&key=JBSWY3DPEHPK3PXP', 'HOST_INVALID');
  bad('untis://setschool?url=http://nessa.webuntis.com&school=a&user=b&key=JBSWY3DPEHPK3PXP', 'HOST_INVALID');
  bad('https://nessa.webuntis.com/?school=a&user=b&key=JBSWY3DPEHPK3PXP', 'QR_INVALID');
  bad('untis://setschool?url=nessa.webuntis.com&school=a&user=b', 'QR_INVALID');
  bad('untis://setschool?url=nessa.webuntis.com&school=a&user=b&key=NOT-BASE32!', 'QR_INVALID');
  bad('untis://setschool?school=a&user=b&key=JBSWY3DPEHPK3PXP', 'QR_INVALID');
  bad('', 'QR_INVALID');
  bad(null, 'QR_INVALID');
});

test('host check: only *.webuntis.com on 443', () => {
  assert.equal(untis.normalizeHost('xyz.webuntis.com'), 'xyz.webuntis.com');
  assert.equal(untis.normalizeHost('https://xyz.webuntis.com/WebUntis/?school=a#main'), 'xyz.webuntis.com');
  assert.equal(untis.normalizeHost('XYZ.WEBUNTIS.COM:443'), 'xyz.webuntis.com');
  for (const h of ['webuntis.com', 'xyz.webuntis.com.evil.io', 'evilwebuntis.com', '10.0.0.1', 'xyz.webuntis.com:80', 'ftp://xyz.webuntis.com', 'x_y.webuntis.com', '', null]) {
    assert.equal(untis.normalizeHost(h), null, String(h));
  }
});

test('cookies: schoolname as the web app sends it, JSESSIONID from Set-Cookie', () => {
  // "_" + base64(school), URL-encoded (webuntis lib: serialize('schoolname', '_' + btoa(school)))
  assert.equal(untis.schoolCookie('abc'), '_YWJj');
  assert.equal(untis.schoolCookie('ab'), '_YWI%3D');
  assert.equal(untis.schoolCookie('Gymnasium Musterstadt'), encodeURIComponent('_' + Buffer.from('Gymnasium Musterstadt').toString('base64')));
  assert.equal(untis.sessionFromSetCookie(['traceId=1; Path=/', 'JSESSIONID=ABC123; Path=/WebUntis; HttpOnly']), 'ABC123');
  assert.equal(untis.sessionFromSetCookie('JSESSIONID=XYZ'), 'XYZ');
  assert.equal(untis.sessionFromSetCookie(['other=1']), null);
  assert.equal(untis.sessionFromSetCookie(undefined), null);
});

test('errors: JSON-RPC codes and messages → auth | no_right | failed', () => {
  assert.equal(untis.rpcError({ code: -8504, message: 'bad credentials' }).code, 'auth');
  assert.equal(untis.rpcError({ code: -8520, message: 'not authenticated' }).code, 'auth');
  assert.equal(untis.rpcError({ code: -8500, message: 'invalid schoolname' }).code, 'auth');
  assert.equal(untis.rpcError({ code: -8998, message: 'whatever' }).code, 'auth');
  assert.equal(untis.rpcError({ code: 0, message: 'Invalid OTP' }).code, 'auth');
  assert.equal(untis.rpcError({ code: -8509, message: 'no right for timetable' }).code, 'no_right');
  assert.equal(untis.rpcError({ code: -1, message: 'Keine Berechtigung' }).code, 'no_right');
  assert.equal(untis.rpcError({ code: -7004, message: 'no allowed date' }).code, 'failed');
  assert.equal(untis.codeOf(new Error('boom')), 'failed');
  assert.equal(untis.codeOf(new untis.UntisError('network')), 'network');
});

test('password login: authenticate, cookie on every later call, persons of a parent, logout', async () => {
  const fake = fakeUntis({ account: 'parent', username: 'eva', password: 'pw' });
  const gc = gcWith(fake.handler);
  const c = untis.createClient(gc, { host: HOST, school: SCHOOL, username: 'eva', auth: 'password' });
  const login = await c.login({ password: 'pw' }, T0);
  assert.deepEqual(login, { personId: 900, personType: 12 });
  assert.equal(c.loggedIn, true);
  const cfg = await c.appConfig();
  assert.equal(cfg.personId, 900);
  assert.deepEqual(untis.studentsOf({ username: 'eva' }, login, cfg), [{ personId: 101, name: 'Lena Muster' }, { personId: 102, name: 'Max Muster' }], 'a parent: its children');
  const lessons = await c.timetable(101, '2026-10-20', '2026-10-21');
  assert.ok(lessons.length >= 10 && lessons.every((l) => l.date === 20261020 || l.date === 20261021));
  await c.logout();
  assert.equal(c.loggedIn, false);
  assert.equal(fake.state.logouts, 1);
  assert.deepEqual(fake.state.logins, ['password']);
  // the first call has no cookie, every later one the session and the school
  const auth = gc.calls[0];
  assert.match(auth.url, /^https:\/\/nessa\.webuntis\.com\/WebUntis\/jsonrpc\.do\?school=Gymnasium%20Musterstadt$/);
  assert.equal(auth.o.json.method, 'authenticate');
  assert.deepEqual(auth.o.json.params, { user: 'eva', password: 'pw', client: 'GateControl' });
  assert.equal(auth.o.headers.cookie, undefined);
  for (const call of gc.calls.slice(1)) assert.match(call.o.headers.cookie, /^JSESSIONID=S\d+x[0-9a-f]+; schoolname=_R3ltbmFzaXVtIE11c3RlcnN0YWR0$/);
  const tt = gc.calls.find((x) => x.o.json && x.o.json.method === 'getTimetable').o.json.params.options;
  assert.deepEqual([tt.element, tt.startDate, tt.endDate, tt.showSubstText, tt.showInfo], [{ id: 101, type: 5 }, 20261020, 20261021, true, true]);
  assert.deepEqual(tt.teacherFields, ['id', 'name', 'longname', 'externalkey']);
});

test('QR login: TOTP of the key, session from Set-Cookie, a student account is itself', async () => {
  const fake = fakeUntis({ account: 'student', username: 'lena.muster' });
  const gc = gcWith(fake.handler);
  const c = untis.createClient(gc, { host: HOST, school: SCHOOL, username: 'lena.muster', auth: 'secret' });
  const login = await c.login({ secret: SECRET }, T0);
  assert.deepEqual(login, { personId: null, personType: null }, 'the QR login says nothing about the person');
  const first = gc.calls[0];
  assert.match(first.url, /\/WebUntis\/jsonrpc_intern\.do\?m=getUserData2017&school=Gymnasium%20Musterstadt&v=i2\.2$/);
  assert.deepEqual(first.o.json.params, [{ auth: { clientTime: T0, user: 'lena.muster', otp: totp.totp(SECRET, T0) } }]);
  const cfg = await c.appConfig();
  assert.deepEqual(untis.studentsOf({ username: 'lena.muster' }, login, cfg), [{ personId: 101, name: 'Lena Muster' }]);
  assert.match(gc.calls[1].o.headers.cookie, /^JSESSIONID=S1x/);
  await c.logout();
  assert.deepEqual([fake.state.logins, fake.state.logouts], [['secret'], 1]);
});

test('login errors: wrong password, wrong key, unknown school → auth; no session cookie → failed', async () => {
  const fake = fakeUntis({ account: 'parent', username: 'eva', password: 'pw' });
  const gc = gcWith(fake.handler);
  const pw = untis.createClient(gc, { host: HOST, school: SCHOOL, username: 'eva', auth: 'password' });
  await assert.rejects(pw.login({ password: 'nope' }), { code: 'auth' });
  assert.equal(pw.loggedIn, false);
  const qr = untis.createClient(gc, { host: HOST, school: SCHOOL, username: 'eva', auth: 'secret' });
  await assert.rejects(qr.login({ secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' }, T0), { code: 'auth' });
  const school = untis.createClient(gc, { host: HOST, school: 'Andere Schule', username: 'eva', auth: 'password' });
  await assert.rejects(school.login({ password: 'pw' }), { code: 'auth' });
  const noCookie = untis.createClient(gcWith(async () => ({ status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) })), { host: HOST, school: SCHOOL, username: 'eva', auth: 'secret' });
  await assert.rejects(noCookie.login({ secret: SECRET }, T0), { code: 'failed' });
});

test('transport errors: network, timeout, 5xx → network; 4xx and garbage → failed / auth', async () => {
  const acc = { host: HOST, school: SCHOOL, username: 'eva', auth: 'password' };
  const run = (handler) => untis.createClient(gcWith(handler), acc).login({ password: 'pw' });
  await assert.rejects(run(async () => { throw Object.assign(new Error('timeout'), { code: 'ERR_NET' }); }), { code: 'network' });
  await assert.rejects(run(async () => ({ status: 503, body: 'down' })), { code: 'network' });
  await assert.rejects(run(async () => ({ status: 429, body: '' })), { code: 'network' });
  await assert.rejects(run(async () => ({ status: 403, body: '' })), { code: 'auth' });
  await assert.rejects(run(async () => ({ status: 302, body: '' })), { code: 'failed' });
  await assert.rejects(run(async () => ({ status: 200, body: '<html>' })), { code: 'failed' });
  await assert.rejects(run(async () => { throw Object.assign(new Error('denied'), { code: 'ERR_NET_DENIED' }); }), { code: 'failed' });
  assert.throws(() => untis.createClient(gcWith(async () => ({})), { ...acc, host: 'evil.example.com' }), { code: 'failed' });
});

test('timetable: no right → no_right; outside the school year (-7004) → empty', async () => {
  const fake = fakeUntis({ account: 'parent', username: 'eva', password: 'pw', noRight: [102] });
  const base = fake.handler;
  const c = untis.createClient(gcWith(async (url, o) => {
    if (o.json && o.json.method === 'getTimetable' && o.json.params.options.startDate > 20270000) return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -7004, message: 'no allowed date' } }) };
    return base(url, o);
  }), { host: HOST, school: SCHOOL, username: 'eva', auth: 'password' });
  await c.login({ password: 'pw' });
  await assert.rejects(c.timetable(102, '2026-10-20', '2026-10-21'), { code: 'no_right' });
  assert.deepEqual(await c.timetable(101, '2027-08-01', '2027-08-02'), []);
  // logout never throws
  fake.state.down = true;
  await c.logout();
  assert.equal(c.loggedIn, false);
});

test('persons: type names, a teacher account has no students, fallback to the login', () => {
  assert.deepEqual(untis.studentsOf({ username: 'x' }, { personId: 300, personType: 2 }, { personId: 300, persons: [{ id: 300, type: 2, name: 'T' }] }), []);
  assert.deepEqual(untis.studentsOf({ username: 'lena' }, { personId: 101, personType: 5 }, null), [{ personId: 101, name: 'lena' }], 'no app config: the login says student');
  assert.deepEqual(untis.studentsOf({ username: 'x' }, null, { personId: 5, persons: [{ id: 5, type: 12, name: 'P' }, { id: 6, type: 5, name: 'K' }, { id: 6, type: 5, name: 'K' }] }), [{ personId: 6, name: 'K' }], 'duplicates once');
});
