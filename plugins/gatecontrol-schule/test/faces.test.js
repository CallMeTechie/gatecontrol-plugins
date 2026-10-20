'use strict';

// 1.3.0 — a colour (and picture) per child: distinct automatic colours, the mapped user's favourite
// colour and picture, the administrator's choice; everywhere (overview of the Schule page, portal,
// app/timetable, school_day); the settings status lines.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, asAdmin, asApp, asPortal, setupParent, ADMIN, EVA, LENA, BOB, WALL } = require('./helpers');
const colors = require('../server/colors');
const store = require('../server/store');

const PIC = '/avatars/abcdefghijklmnopqrstuv123.webp';
// Lena with a profile picture and a favourite colour of her own
const USERS = [ADMIN, EVA, { ...LENA, color: 'pink', avatarUrl: PIC }, BOB, WALL];

test('colours: distinct automatic ones; a mapped user\'s colour and picture win; the administrator chooses from the palette', () => withHost({ users: USERS }, async (host) => {
  const { lena, max } = await setupParent(host);
  let st = (await asAdmin(host, 'GET', '/status')).json;
  const kids = st.accounts[0].students;
  const L = kids.find((s) => s.id === lena.id);
  const M = kids.find((s) => s.id === max.id);
  assert.deepEqual(st.palette, colors.PALETTE);
  assert.notEqual(L.own_color, M.own_color, 'distinct automatic colours');
  assert.ok(colors.PALETTE.includes(L.own_color) && colors.PALETTE.includes(M.own_color));
  // Lena is mapped to the user LENA: her favourite colour (pink) and picture
  assert.deepEqual([L.color, L.avatarUrl, L.color_from_user, L.initials], ['#EC4899', PIC, true, 'LE']);
  assert.deepEqual([M.color, M.avatarUrl, M.color_from_user, M.initials], [M.own_color, null, false, 'MM']);
  assert.deepEqual(L.user, { id: LENA.id, name: 'Lena', role: 'user', avatarUrl: PIC, colorHex: '#EC4899', initials: 'LE' });
  // the administrator picks a colour for Max: palette only
  assert.equal((await asAdmin(host, 'PUT', `/students/${max.id}`, { color: '#a855f7' })).json.student.color, '#A855F7');
  assert.equal((await asAdmin(host, 'PUT', `/students/${max.id}`, { color: '#123456' })).status, 400);
  assert.equal((await asAdmin(host, 'PUT', `/students/${max.id}`, { color: 'rot' })).status, 400);
  // back to automatic: a colour nobody else has
  const auto = (await asAdmin(host, 'PUT', `/students/${max.id}`, { color: null })).json.student.color;
  assert.ok(colors.PALETTE.includes(auto) && auto !== L.own_color);
  // a mapping made in the settings is the administrator's
  st = (await asAdmin(host, 'GET', '/status')).json;
  assert.equal(st.accounts[0].students.find((s) => s.id === lena.id).link_source, 'admin');

  // overview (Schule page): faces, the week, changes / exams / homework lists
  const ov = (await asAdmin(host, 'GET', '/overview')).json;
  assert.deepEqual([ov.ok, ov.configured, ov.accountErrors, ov.today, ov.from, ov.to], [true, true, 0, '2026-10-20', '2026-10-19', '2026-10-24']);
  assert.deepEqual(ov.students.map((s) => [s.name, s.color, s.avatarUrl, s.initials]), [['Lena Muster', '#EC4899', PIC, 'LE'], ['Max Muster', auto, undefined, 'MM']]);
  assert.equal(ov.students[0].days.length, 6);
  assert.ok(Array.isArray(ov.students[0].changes) && Array.isArray(ov.students[0].exams) && Array.isArray(ov.students[0].homework));
  assert.equal((await asAdmin(host, 'GET', '/overview', undefined, { week: '1' })).json.from, '2026-10-26');
  // the portal: only what the viewer sees, same shape
  const pv = (await asPortal(host, EVA, '/portal/overview')).json;
  assert.deepEqual(pv.students.map((s) => [s.name, s.color]), [['Lena Muster', '#EC4899']]);
  assert.deepEqual((await asPortal(host, BOB, '/portal/overview')).json.students, []);
  // the apps: color always, avatarUrl when there is a picture
  const app = (await asApp(host, ADMIN, '/app/timetable', { from: '2026-10-20', to: '2026-10-20' })).json.students;
  assert.deepEqual(app.map((s) => [s.name, s.color, s.avatarUrl]), [['Lena Muster', '#EC4899', PIC], ['Max Muster', auto, undefined]]);
  assert.ok(!('avatarUrl' in app[1]), 'no avatarUrl key without a picture');
  // the old portal week too
  assert.equal((await asPortal(host, EVA, '/portal/timetable')).json.students[0].color, '#EC4899');
  // the wall (school_day for Familie): colour and picture
  await asAdmin(host, 'PUT', `/students/${lena.id}`, { show_on_wall: true });
  const day = await host.callService('school_day', { caller: 'gatecontrol-familie', payload: { date: '2026-10-20' } });
  assert.deepEqual([day.students[0].color, day.students[0].avatarUrl], ['#EC4899', PIC]);
}));

test('1.2.0 students without a colour get one at start (distinct); the overview without an account says so', () => withHost({}, async (host) => {
  const ov0 = (await asAdmin(host, 'GET', '/overview')).json;
  assert.deepEqual([ov0.configured, ov0.students], [false, []]);
  const { lena, max } = await setupParent(host);
  await host.gc.db.run('UPDATE students SET color = NULL');
  await host.plugin.start(host.gc);
  const a = await store.getStudent(host.gc, lena.id);
  const b = await store.getStudent(host.gc, max.id);
  assert.ok(a.color && b.color && a.color !== b.color);
  // all students off: configured, but nothing to show
  await asAdmin(host, 'PUT', `/students/${lena.id}`, { enabled: false });
  await asAdmin(host, 'PUT', `/students/${max.id}`, { enabled: false });
  const ov = (await asAdmin(host, 'GET', '/overview')).json;
  assert.deepEqual([ov.configured, ov.students], [true, []]);
}));

test('settings status lines: none yet, a summary, an account in trouble in words', () => withHost({}, async (host, untis) => {
  assert.deepEqual(await host.settingsStatus('de'), [{ group: null, tone: 'info', text: 'Noch kein WebUntis-Konto verbunden – „Konto hinzufügen“ unter „Konten & Kinder“.' }]);
  await setupParent(host);
  assert.deepEqual(await host.settingsStatus('de'), [{ group: null, tone: 'ok', text: '1 WebUntis-Konto/-Konten verbunden · 2 Kind(er) mit Stundenplan' }]);
  untis.state.loginError = { code: -8504, message: 'bad credentials' };
  const acc = (await asAdmin(host, 'GET', '/status')).json.accounts[0];
  await asAdmin(host, 'POST', `/accounts/${acc.id}/refresh`);
  const lines = await host.settingsStatus('en');
  assert.equal(lines[0].tone, 'warn');
  assert.match(lines[1].text, /^Gymnasium Musterstadt · eva\.muster: /);
  assert.ok(lines.every((l) => !/\bauth\b/.test(l.text)), 'no codes');
}));
