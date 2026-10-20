'use strict';

// Admin API: adding accounts (QR link, key entered by hand, password), what is stored where
// (credentials only as plugin secrets), errors shown clearly, changing the access, mapping
// students, removing an account with everything it had.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, asAdmin, asPortal, asApp, setupParent, ADMIN, EVA, LENA, BOB, HOST, SCHOOL, SECRET, QR } = require('./helpers');

const dbDump = async (host) => {
  const out = {};
  for (const t of ['accounts', 'students', 'lessons', 'changes']) out[t] = (await host.gc.db.query(`SELECT * FROM ${t}`)).rows;
  return JSON.stringify(out);
};

test('add by QR link: one login, the children found, baseline fetched, logout; the key only as a secret', () => withHost({}, async (host, untis) => {
  const r = await asAdmin(host, 'POST', '/accounts', { mode: 'qr', link: QR });
  assert.equal(r.status, 201);
  assert.deepEqual(r.json.students.map((s) => s.name), ['Lena Muster', 'Max Muster']);
  assert.deepEqual([r.json.result.ok, r.json.result.code, r.json.result.students, r.json.result.changes], [true, null, 2, 0]);
  assert.deepEqual(untis.state.logins, ['secret'], 'one login');
  assert.equal(untis.state.logouts, 1, 'logged out at the end');
  assert.deepEqual(untis.state.calls, ['getUserData2017', 'app/config', 'getTimegridUnits', 'getHolidays', 'getTimetable', 'getTimetable', 'logout']);
  // the key: a plugin secret (encrypted by the host), never in the database, the API or the log
  assert.deepEqual([...host.secrets], ['acct.1.secret']);
  assert.equal(host.settings['acct.1.secret'], SECRET);
  assert.ok(!(await dbDump(host)).includes(SECRET));
  const st = await asAdmin(host, 'GET', '/status');
  assert.ok(!JSON.stringify(st.json).includes(SECRET));
  assert.ok(!JSON.stringify(host.logs).includes(SECRET));
  const a = st.json.accounts[0];
  assert.deepEqual([a.host, a.school, a.username, a.auth, a.status, a.person_type], [HOST, SCHOOL, 'eva.muster', 'secret', 'ok', 12]);
  assert.equal(a.students.length, 2);
  assert.ok(a.students.every((s) => s.enabled && s.baseline_done && s.lesson_count > 30), 'baseline stored');
  assert.deepEqual(a.students.map((s) => s.klasse), ['5a', '7b']);
  assert.ok(a.next_fetch_at > a.last_success_at);
  assert.deepEqual(st.json.changes, [], 'the baseline is no change');
  assert.equal(host.notifications.length, 0);
}));

test('add with the key typed in, and with a password (student account)', () => withHost({ untis: { account: 'student', username: 'lena.muster', password: 'pw' } }, async (host, untis) => {
  const k = await asAdmin(host, 'POST', '/accounts', { mode: 'secret', host: 'https://nessa.webuntis.com/WebUntis', school: SCHOOL, username: 'lena.muster', secret: 'jbsw y3dp ehpk 3pxp' });
  assert.equal(k.status, 201);
  assert.deepEqual(k.json.students.map((s) => s.name), ['Lena Muster'], 'a student account: itself');
  assert.equal(host.settings['acct.1.secret'], SECRET);
  assert.equal((await asAdmin(host, 'DELETE', '/accounts/1')).json.ok, true);
  const p = await asAdmin(host, 'POST', '/accounts', { mode: 'password', host: 'nessa.webuntis.com', school: SCHOOL, username: 'lena.muster', password: 'pw' });
  assert.equal(p.status, 201);
  assert.deepEqual([...host.secrets], ['acct.2.password']);
  assert.ok(!(await dbDump(host)).includes('"pw"'));
  assert.deepEqual(untis.state.logins, ['secret', 'password']);
  assert.equal(untis.state.logouts, 2);
}));

test('add: wrong host, broken link, missing fields, duplicates', () => withHost({}, async (host, untis) => {
  const bad = async (body, status, code) => {
    const r = await asAdmin(host, 'POST', '/accounts', body);
    assert.equal(r.status, status, JSON.stringify(body));
    assert.equal(r.json.code, code);
    assert.ok(r.json.error);
  };
  await bad({ mode: 'qr', link: QR.replace(HOST, 'webuntis.evil.example') }, 400, 'HOST_INVALID');
  await bad({ mode: 'qr', link: 'https://example.com' }, 400, 'QR_INVALID');
  await bad({ mode: 'password', host: 'intranet.local', school: 'a', username: 'b', password: 'c' }, 400, 'HOST_INVALID');
  await bad({ mode: 'password', host: HOST, school: '', username: 'b', password: 'c' }, 400, 'FIELDS_REQUIRED');
  await bad({ mode: 'secret', host: HOST, school: 'a', username: 'b', secret: '!!' }, 400, 'QR_INVALID');
  await bad({ mode: 'magic' }, 400, 'INVALID');
  assert.equal(untis.state.calls.length, 0, 'nothing sent to WebUntis');
  assert.equal((await asAdmin(host, 'POST', '/accounts', { mode: 'qr', link: QR })).status, 201);
  await bad({ mode: 'qr', link: QR.replace('eva.muster', 'EVA.MUSTER') }, 409, 'DUPLICATE');
}));

test('add: a refused login is shown and nothing is kept', () => withHost({}, async (host, untis) => {
  untis.state.secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // WebUntis expects another key
  const r = await asAdmin(host, 'POST', '/accounts', { mode: 'qr', link: QR });
  assert.equal(r.status, 502);
  assert.deepEqual([r.json.code, r.json.untis], ['LOGIN_FAILED', 'auth']);
  assert.match(r.json.error, /Anmeldung.*fehlgeschlagen.*Anmeldung abgelehnt/);
  assert.deepEqual([...host.secrets], [], 'credentials removed');
  assert.equal((await asAdmin(host, 'GET', '/status')).json.accounts.length, 0);
  untis.state.down = true;
  const n = await asAdmin(host, 'POST', '/accounts', { mode: 'qr', link: QR });
  assert.deepEqual([n.status, n.json.untis], [502, 'network']);
  assert.match(n.json.error, /nicht erreichbar/);
  const en = await host.request({ method: 'POST', path: '/accounts', body: { mode: 'qr', link: QR }, user: ADMIN, lang: 'en' });
  assert.match(en.json.error, /cannot be reached/);
}));

test('add: a teacher account has no students', () => withHost({ untis: { account: 'teacher', username: 'eva.muster' } }, async (host) => {
  const r = await asAdmin(host, 'POST', '/accounts', { mode: 'qr', link: QR });
  assert.deepEqual([r.status, r.json.code], [422, 'NO_STUDENTS']);
  assert.deepEqual([...host.secrets], []);
}));

test('add: a child without timetable right is kept, the error is shown on it', () => withHost({ untis: { noRight: [102] } }, async (host) => {
  const r = await asAdmin(host, 'POST', '/accounts', { mode: 'qr', link: QR });
  assert.equal(r.status, 201);
  assert.deepEqual([r.json.result.ok, r.json.result.code, r.json.result.students], [true, 'no_right', 1]);
  const a = (await asAdmin(host, 'GET', '/status')).json.accounts[0];
  const max = a.students.find((s) => s.person_id === 102);
  assert.deepEqual([max.last_error, max.lesson_count], ['no_right', 0]);
  assert.match(max.error_text, /keine Berechtigung/);
  assert.equal(a.last_error, 'no_right');
}));

test('students: map to a user, recipients, alias, wall tablet; unknown users refused', () => withHost({}, async (host) => {
  const { lena } = await setupParent(host);
  let s = (await asAdmin(host, 'GET', '/status')).json.accounts[0].students.find((x) => x.id === lena.id);
  assert.deepEqual([s.user_id, s.user.name, s.recipients.map((u) => u.name)], [LENA.id, 'Lena', ['Eva']]);
  const r = await asAdmin(host, 'PUT', `/students/${lena.id}`, { alias: '  Lena  ', show_on_wall: true });
  assert.equal(r.status, 200);
  s = (await asAdmin(host, 'GET', '/status')).json.accounts[0].students.find((x) => x.id === lena.id);
  assert.deepEqual([s.display, s.alias, s.name, s.show_on_wall], ['Lena', 'Lena', 'Lena Muster', true]);
  assert.equal((await asAdmin(host, 'PUT', `/students/${lena.id}`, { user_id: 999 })).json.code, 'USERS_INVALID');
  assert.equal((await asAdmin(host, 'PUT', `/students/${lena.id}`, { recipients: [EVA.id, 999] })).json.code, 'USERS_INVALID');
  assert.equal((await asAdmin(host, 'PUT', `/students/${lena.id}`, { enabled: 'yes' })).json.code, 'INVALID');
  assert.equal((await asAdmin(host, 'PUT', '/students/999', { enabled: true })).status, 404);
  assert.equal((await asAdmin(host, 'PUT', `/students/${lena.id}`, { user_id: null, recipients: [] })).status, 200);
  s = (await asAdmin(host, 'GET', '/status')).json.accounts[0].students.find((x) => x.id === lena.id);
  assert.deepEqual([s.user, s.recipients], [null, []]);
}));

test('change access: new credentials are checked; refused ones leave the old access', () => withHost({}, async (host, untis) => {
  await setupParent(host);
  const wrong = await asAdmin(host, 'PUT', '/accounts/1', { mode: 'password', host: HOST, school: SCHOOL, username: 'eva.muster', password: 'falsch' });
  assert.deepEqual([wrong.status, wrong.json.code, wrong.json.untis], [502, 'LOGIN_FAILED', 'auth']);
  assert.equal(host.settings['acct.1.secret'], SECRET, 'the key is back');
  assert.equal(host.settings['acct.1.password'], undefined);
  assert.equal((await asAdmin(host, 'GET', '/status')).json.accounts[0].auth, 'secret');
  const ok = await asAdmin(host, 'PUT', '/accounts/1', { mode: 'password', host: HOST, school: SCHOOL, username: 'eva.muster', password: 'geheim' });
  assert.equal(ok.status, 200);
  assert.deepEqual([...host.secrets], ['acct.1.password'], 'the key is gone, the password stored');
  const a = (await asAdmin(host, 'GET', '/status')).json.accounts[0];
  assert.equal(a.auth, 'password');
  assert.equal(a.students.find((s) => s.person_id === 101).user_id, LENA.id, 'the mapping stays');
  assert.equal(untis.state.sessions.size, 0, 'every session logged out');
}));

test('remove: credentials, students, lessons and change log are deleted', () => withHost({}, async (host, untis) => {
  await setupParent(host);
  untis.state.timetable[101].find((l) => l.date === 20261020 && l.startTime === 1040).code = 'cancelled';
  await asAdmin(host, 'POST', '/accounts/1/refresh');
  const before = JSON.parse(await dbDump(host));
  assert.ok(before.lessons.length > 0 && before.changes.length === 1 && before.students.length === 2);
  assert.equal((await asAdmin(host, 'DELETE', '/accounts/1')).json.ok, true);
  const after = JSON.parse(await dbDump(host));
  assert.deepEqual(after, { accounts: [], students: [], lessons: [], changes: [] });
  assert.deepEqual([...host.secrets], []);
  assert.equal(host.settings['acct.1.secret'], undefined);
  assert.equal((await asAdmin(host, 'DELETE', '/accounts/1')).status, 404);
}));

test('admin API: administrators only — never portal, app or ordinary users', () => withHost({}, async (host) => {
  await setupParent(host);
  assert.equal((await host.request({ method: 'GET', path: '/status', user: BOB })).status, 403);
  assert.equal((await asPortal(host, ADMIN, '/status')).status, 403);
  assert.equal((await asApp(host, ADMIN, '/status')).status, 403);
  assert.equal((await host.request({ method: 'DELETE', path: '/accounts/1', user: { ...ADMIN, portal: true, loggedIn: true } })).status, 403);
  assert.equal((await asAdmin(host, 'GET', '/nope')).status, 404);
  const log = await asAdmin(host, 'GET', '/changes', undefined, { limit: '5' });
  assert.deepEqual([log.status, log.json.changes], [200, []]);
}));

test('render: page and portal frame, texts escaped, no external scripts', async () => {
  const ui = require('../server/ui');
  const index = require('../server/index');
  const page = (await index.render({ view: 'page', page: 'main', lang: 'de' })).html;
  const portal = (await index.render({ view: 'portal', lang: 'en', user: { id: 5, kiosk: true } })).html;
  for (const html of [page, portal]) {
    assert.ok(!/<script[^>]+src=/i.test(html), 'inline scripts only');
    assert.ok(!/\{\{t:/.test(html), 'every text filled in');
  }
  assert.match(page, /WebUntis-Konto hinzufügen/);
  assert.match(page, /untis:\/\/setschool\?url=…&amp;school=/);
  assert.match(portal, /This week/);
  assert.match(portal, /"kiosk":true/);
  assert.equal(ui.island({ a: '</script><!--' }), '{"a":"\\u003c/script>\\u003c!--"}');
});
