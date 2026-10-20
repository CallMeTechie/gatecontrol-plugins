'use strict';

// Who sees which student — in the portal tab, the Start tiles, the quick actions / widgets and
// the app API: the mapped child, the recipients and administrators; nobody else; a kiosk
// device (wall tablet) only students with "Am Wand-Tablet zeigen"; a device-trust viewer
// nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, asAdmin, asPortal, asApp, setupParent, lessonAt, tickAt, at, clock, ADMIN, EVA, LENA, BOB, WALL, T0 } = require('./helpers');

const MIN = 60000;
const viewer = (u, extra) => ({ ...u, portal: true, loggedIn: true, ...(extra || {}) });
const names = (list) => list.map((s) => s.name).sort();

test('portal tab: visible to the child, the recipients and admins; not to others', () => withHost({}, async (host) => {
  await setupParent(host);
  assert.equal(await host.portalVisible(viewer(LENA)), true);
  assert.equal(await host.portalVisible(viewer(EVA)), true);
  assert.equal(await host.portalVisible(viewer(ADMIN)), true);
  assert.equal(await host.portalVisible(viewer(BOB)), false);
  assert.equal(await host.portalVisible(viewer(WALL, { kiosk: true })), false, 'kiosk without a wall student');
  assert.equal(await host.portalVisible(viewer(EVA, { loggedIn: false })), false, 'device trust only');
  assert.equal(await host.portalVisible(viewer(EVA), 'some-section'), false, 'no sections');

  assert.deepEqual(names((await asPortal(host, LENA, '/portal/timetable')).json.students), ['Lena Muster']);
  assert.deepEqual(names((await asPortal(host, EVA, '/portal/timetable')).json.students), ['Lena Muster']);
  assert.deepEqual(names((await asPortal(host, ADMIN, '/portal/timetable')).json.students), ['Lena Muster', 'Max Muster']);
  assert.deepEqual((await asPortal(host, BOB, '/portal/timetable')).json.students, []);
  assert.deepEqual((await asPortal(host, EVA, '/portal/timetable', {}, { loggedIn: false })).json.students, []);
  assert.equal((await host.request({ method: 'GET', path: '/portal/timetable', user: LENA })).status, 403, 'portal API only for portal viewers');
}));

test('kiosk (wall tablet): only students with "Am Wand-Tablet zeigen", whoever the account is', () => withHost({}, async (host) => {
  const { max } = await setupParent(host, { wall: true });
  const kiosk = viewer(WALL, { kiosk: true });
  assert.equal(await host.portalVisible(kiosk), true);
  assert.deepEqual(names((await asPortal(host, WALL, '/portal/timetable', {}, { kiosk: true })).json.students), ['Lena Muster']);
  assert.deepEqual((await host.portalTiles(kiosk)).map((t) => t.title), ['Schule · Lena Muster']);
  // a kiosk device of the mapped child sees only wall students too
  await asAdmin(host, 'PUT', `/students/${max.id}`, { user_id: WALL.id });
  assert.deepEqual(names((await asPortal(host, WALL, '/portal/timetable', {}, { kiosk: true })).json.students), ['Lena Muster']);
  assert.deepEqual(names((await asPortal(host, WALL, '/portal/timetable')).json.students), ['Max Muster'], 'the same account in a normal portal');
  // switched off for the wall
  await asAdmin(host, 'PUT', '/students/1', { show_on_wall: false });
  assert.deepEqual((await asPortal(host, WALL, '/portal/timetable', {}, { kiosk: true })).json.students, []);
}));

test('portal week: Mon–Sat of this and next week, holidays, today', () => withHost({}, async (host) => {
  await setupParent(host);
  const r = (await asPortal(host, EVA, '/portal/timetable')).json;
  assert.deepEqual([r.today, r.week, r.from, r.to], ['2026-10-20', 0, '2026-10-19', '2026-10-24']);
  const s = r.students[0];
  assert.deepEqual([s.name, s.userId, s.klasse], ['Lena Muster', LENA.id, '5a']);
  assert.deepEqual(s.days.map((d) => d.date), ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24']);
  assert.deepEqual(s.days.map((d) => d.lessons.length), [5, 5, 5, 5, 4, 0], 'Monday fetched too');
  const first = s.days[1].lessons[0];
  assert.deepEqual(first, { start: '08:00', end: '08:45', subject: 'D', subjectLong: 'Deutsch', teacher: 'SCH', room: '101', state: 'normal', period: 1 });
  const next = (await asPortal(host, EVA, '/portal/timetable', { week: '1' })).json;
  assert.deepEqual([next.from, next.to], ['2026-10-26', '2026-10-31']);
  const fri = next.students[0].days.find((d) => d.date === '2026-10-30');
  assert.deepEqual([fri.holiday, fri.lessons], ['Brückentag', []]);
}));

test('Start tiles: one per visible student, stable title, short value, ≤ 4 items', () => withHost({}, async (host, untis) => {
  await setupParent(host);
  await asAdmin(host, 'PUT', '/students/1', { alias: 'Lena' });
  const t0 = await host.clientTiles(viewer(EVA));
  assert.deepEqual(t0, [{ section: null, title: 'Schule · Lena', value: 'Planmäßig', unit: null, state: 'good', icon: 'M4 5h16v15H4zM4 10h16M8 3v4M16 3v4', items: [] }]);
  lessonAt(untis, 101, 20261020, 950).code = 'cancelled';
  lessonAt(untis, 101, 20261020, 1140).code = 'cancelled';
  const ge = lessonAt(untis, 101, 20261020, 1040);
  ge.code = 'irregular'; ge.te = [{ id: 14, name: 'KLE', orgid: 12, orgname: 'SCH' }];
  lessonAt(untis, 101, 20261021, 800).code = 'cancelled';
  lessonAt(untis, 101, 20261021, 850).code = 'cancelled';
  await tickAt(host, T0 + 16 * MIN);
  const [tile] = await host.clientTiles(viewer(LENA));
  assert.equal(tile.title, 'Schule · Lena', 'the title stays');
  assert.equal(tile.value, '2 Ausfälle · 1 Vertr.');
  assert.ok(tile.value.length <= 24);
  assert.equal(tile.state, 'warn');
  assert.deepEqual(tile.items.map((i) => [i.label, i.value, i.state]), [
    ['Heute · 3. Std.', 'Englisch', 'crit'], ['Heute · 4. Std.', 'Geschichte', 'warn'], ['Heute · 5. Std.', 'Musik', 'crit'], ['Morgen · 1. Std.', 'Englisch', 'crit'],
  ], 'at most 4');
  assert.deepEqual(await host.portalTiles(viewer(BOB)), []);
  assert.equal((await host.portalTiles(viewer(ADMIN))).length, 2);
  // a day without lessons: "Frei"; a holiday: "Ferien"
  clock.set(at('2026-10-25T08:00:00Z'));
  assert.equal((await host.portalTiles(viewer(EVA)))[0].value, 'Frei');
  clock.set(at('2026-10-30T08:00:00Z'));
  assert.equal((await host.portalTiles(viewer(EVA)))[0].value, 'Ferien');
  assert.equal((await host.portalTiles(viewer(EVA), 'en'))[0].title, 'School · Lena');
}));

test('quick actions: a display widget per student — value today, reading tomorrow', () => withHost({}, async (host, untis) => {
  await setupParent(host);
  await asAdmin(host, 'PUT', '/students/1', { alias: 'Lena' });
  lessonAt(untis, 101, 20261020, 950).code = 'cancelled';
  lessonAt(untis, 101, 20261021, 800).code = 'cancelled';
  lessonAt(untis, 101, 20261021, 850).code = 'cancelled';
  await tickAt(host, T0 + 16 * MIN);
  const qa = await host.quickActions(EVA);
  assert.equal(qa.length, 1);
  const a = qa[0];
  assert.deepEqual([a.id, a.title, a.kind, a.subtitle, a.device.id], ['student:1', 'Lena', 'button', 'Stundenplan', 'student:1']);
  assert.deepEqual({ label: a.widget.label, value: a.widget.value, status: a.widget.status, state: a.widget.state, power: a.widget.power }, {
    label: 'Lena', value: 1, status: 'Heute 3. Std.: Englisch fällt aus', state: 'warn', power: false,
  });
  assert.deepEqual(a.widget.readings.map((r) => [r.id, r.label, r.value]), [['tomorrow', 'Morgen', 2]]);
  assert.deepEqual(await host.quickActions(BOB), []);
  assert.deepEqual((await host.quickActions(ADMIN)).map((x) => x.id), ['student:1', 'student:2']);
  assert.deepEqual((await host.quickActions({ ...WALL, kiosk: true })).map((x) => x.id), []);
  // after the lesson: the next change is tomorrow's
  clock.set(at('2026-10-20T09:00:00Z'));
  assert.equal((await host.quickActions(LENA))[0].widget.status, 'Morgen 1. Std.: Englisch fällt aus');
  // nothing special: "Planmäßig"
  clock.set(at('2026-10-22T06:00:00Z'));
  const plain = (await host.quickActions(LENA))[0].widget;
  assert.deepEqual([plain.value, plain.status, plain.state, plain.readings[0].value], [0, 'Planmäßig', 'good', 0]);
}));

test('running a quick action: shows the state, asks for a fetch (person only, ≤ every 5 min)', () => withHost({}, async (host) => {
  await setupParent(host);
  clock.set(T0 + 10 * MIN);
  const r = await host.runQuickAction(LENA, 'student:1');
  assert.deepEqual([r.status, r.body.ok, r.body.message], [200, true, 'Wird gleich neu abgerufen.']);
  assert.equal(r.body.widget.value, 0);
  const acc = (await asAdmin(host, 'GET', '/status')).json.accounts[0];
  assert.equal(acc.next_fetch_at, T0 + 10 * MIN, 'due at once');
  const again = await host.runQuickAction(LENA, 'student:1');
  assert.equal(again.body.message, 'Planmäßig', 'asked already');
  assert.equal((await host.runQuickAction(BOB, 'student:1')).status, 404, 'not listed for Bob');
  assert.equal((await host.runQuickAction(LENA, 'student:2')).status, 404);
  const auto = await host.runQuickAction(LENA, 'student:1', 'de', { automation: true, via: 'gatecontrol-familie' });
  assert.equal(auto.body.ok, true);
}));

test('app API: timetable and change log of the visible students; ranges checked', () => withHost({}, async (host, untis) => {
  await setupParent(host);
  lessonAt(untis, 101, 20261020, 950).code = 'cancelled';
  const ge = lessonAt(untis, 101, 20261021, 1040);
  ge.code = 'irregular'; ge.ro = [{ id: 3, name: '104', orgid: 2, orgname: '201' }]; ge.substText = 'Raumtausch';
  await tickAt(host, T0 + 16 * MIN);
  const r = await asApp(host, EVA, '/app/timetable', { from: '2026-10-20', to: '2026-10-21' });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.updatedAt, T0 + 16 * MIN);
  assert.equal(r.json.students.length, 1);
  const s = r.json.students[0];
  // 1.3.0: + color (the mapped user's favourite colour; avatarUrl only when there is a picture)
  assert.deepEqual(Object.keys(s).sort(), ['color', 'days', 'id', 'klasse', 'name', 'userId']);
  assert.equal(s.color, '#84CC16');
  assert.deepEqual([s.name, s.userId, s.klasse, s.days.map((d) => d.date)], ['Lena Muster', LENA.id, '5a', ['2026-10-20', '2026-10-21']]);
  assert.deepEqual(s.days[0].lessons[2], { start: '09:50', end: '10:35', subject: 'E', subjectLong: 'Englisch', teacher: 'WEB', room: '201', state: 'cancelled', period: 3 });
  assert.deepEqual(s.days[1].lessons[3], { start: '10:40', end: '11:25', subject: 'BIO', subjectLong: 'Biologie', teacher: 'KLE', room: '104', state: 'changed', period: 4, roomOld: '201', substText: 'Raumtausch' });
  // defaults: today + 6
  const def = await asApp(host, EVA, '/app/timetable');
  assert.deepEqual([def.json.students[0].days[0].date, def.json.students[0].days.length], ['2026-10-20', 7]);
  assert.equal((await asApp(host, EVA, '/app/timetable', { from: '2026-10-20', to: '2026-11-02' })).status, 200, '14 days');
  assert.equal((await asApp(host, EVA, '/app/timetable', { from: '2026-10-20', to: '2026-11-03' })).status, 400, '15 days');
  assert.equal((await asApp(host, EVA, '/app/timetable', { from: '2026-10-21', to: '2026-10-20' })).status, 400);
  assert.equal((await asApp(host, EVA, '/app/timetable', { from: '2026-02-30' })).status, 400);
  assert.deepEqual((await asApp(host, BOB, '/app/timetable')).json, { ok: true, updatedAt: null, students: [] });
  assert.equal((await asApp(host, ADMIN, '/app/timetable')).json.students.length, 2);
  // change log
  const c = await asApp(host, LENA, '/app/changes', { days: '7' });
  assert.equal(c.status, 200);
  assert.deepEqual(c.json.changes.map((x) => [x.kind, x.date, x.start, x.subject, x.pushed]).sort(), [
    ['cancelled', '2026-10-20', '09:50', 'E', true], ['changed', '2026-10-21', '10:40', 'BIO', true],
  ]);
  const ch = c.json.changes.find((x) => x.kind === 'changed');
  assert.deepEqual([ch.studentId, ch.student, ch.room, ch.roomOld, ch.substText, ch.period, ch.status], [1, 'Lena Muster', '104', '201', 'Raumtausch', 4, undefined]);
  assert.deepEqual((await asApp(host, BOB, '/app/changes')).json.changes, []);
  assert.equal((await asApp(host, LENA, '/app/changes', { days: '31' })).status, 400);
  // app callers only
  assert.equal((await asPortal(host, EVA, '/app/timetable')).status, 403);
  assert.equal((await host.request({ method: 'GET', path: '/app/timetable', user: ADMIN })).status, 403);
  assert.equal((await host.request({ method: 'POST', path: '/app/timetable', user: { ...EVA, portal: true, loggedIn: true, app: true } })).status, 404);
}));

test('switched-off and missing students are invisible everywhere', () => withHost({}, async (host, untis) => {
  await setupParent(host);
  await asAdmin(host, 'PUT', '/students/1', { enabled: false });
  assert.equal(await host.portalVisible(viewer(EVA)), false);
  assert.deepEqual(await host.quickActions(ADMIN).then((l) => l.map((x) => x.id)), ['student:2']);
  await asAdmin(host, 'PUT', '/students/1', { enabled: true });
  // Max leaves the parent account
  untis.state.account = 'student';
  untis.state.username = 'eva.muster';
  await asAdmin(host, 'POST', '/accounts/1/refresh');
  const st = (await asAdmin(host, 'GET', '/status')).json.accounts[0].students;
  assert.deepEqual(st.map((s) => [s.person_id, s.missing]), [[101, false], [102, true]]);
  assert.deepEqual((await host.quickActions(ADMIN)).map((x) => x.id), ['student:1']);
}));
