'use strict';

// Change detection and pushes (server/changes.js): the baseline sends nothing; a new
// cancellation is one push to the mapped child and the recipients; ended lessons and days
// beyond notify_days are only logged; several changes make one summary push; quiet hours hold
// pushes until they end (and drop what is over by then); nothing is pushed twice; vanished,
// extra and restored lessons; a renumbered or replaced timetable is no change.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, asAdmin, asPortal, setupParent, lessonAt, tickAt, at, EVA, LENA, T0 } = require('./helpers');

const MIN = 60000;
const pushes = (host) => host.notifications.filter((n) => n.topic === 'changes');
const log = async (host) => (await asAdmin(host, 'GET', '/changes')).json.changes;

/** Parent account with Lena (alias "Lena") → LENA + recipient EVA. */
async function household(host) {
  const s = await setupParent(host);
  await asAdmin(host, 'PUT', `/students/${s.lena.id}`, { alias: 'Lena' });
  return s;
}

test('baseline: the first fetch sends nothing, also when it has cancellations', () => withHost({}, async (host, untis) => {
  lessonAt(untis, 101, 20261020, 950).code = 'cancelled';
  await household(host);
  await tickAt(host, T0 + 16 * MIN);
  assert.equal(pushes(host).length, 0);
  assert.deepEqual(await log(host), []);
  // the portal shows it all the same
  const p = await asPortal(host, EVA, '/portal/timetable');
  const tue = p.json.students.find((s) => s.name === 'Lena').days.find((d) => d.date === '2026-10-20');
  assert.equal(tue.lessons.find((l) => l.start === '09:50').state, 'cancelled');
}));

test('a new cancellation: one push to the child and the recipients; never twice', () => withHost({}, async (host, untis) => {
  const { lena } = await household(host);
  lessonAt(untis, 101, 20261020, 950).code = 'cancelled';
  await tickAt(host, T0 + 10 * MIN);
  assert.equal(pushes(host).length, 0, 'not due yet (every 15 minutes)');
  await tickAt(host, T0 + 16 * MIN);
  const p = pushes(host);
  assert.equal(p.length, 1);
  assert.deepEqual([...p[0].users].sort(), [EVA.id, LENA.id]);
  assert.equal(p[0].title, 'Lena: Englisch fällt aus');
  assert.equal(p[0].body, 'Di 20.10. · 3. Std. 09:50');
  assert.equal(p[0].collapseKey, `schule:${lena.id}:2026-10-20`);
  assert.equal(p[0].priority, 'normal');
  assert.deepEqual(p[0].data.schule, { studentId: lena.id, date: '2026-10-20' });
  const l = await log(host);
  assert.deepEqual(l.map((c) => [c.kind, c.subject, c.date, c.start, c.status, c.student]), [['cancelled', 'E', '2026-10-20', '09:50', 'sent', 'Lena']]);
  // the next cycles: same state → nothing new
  await tickAt(host, T0 + 32 * MIN);
  await tickAt(host, T0 + 48 * MIN);
  assert.equal(pushes(host).length, 1);
  assert.equal((await log(host)).length, 1);
}));

test('ended lessons, days beyond notify_days and past days are only logged', () => withHost({}, async (host, untis) => {
  await household(host);
  lessonAt(untis, 101, 20261020, 800).code = 'cancelled';   // today 08:00–08:45: over at 09:00
  lessonAt(untis, 101, 20261022, 800).code = 'cancelled';   // Thursday: beyond today + tomorrow
  lessonAt(untis, 101, 20261019, 800).code = 'cancelled';   // Monday: before today
  await tickAt(host, at('2026-10-20T07:00:00Z')); // 09:00
  assert.equal(pushes(host).length, 0);
  const l = await log(host);
  assert.deepEqual(l.map((c) => [c.date, c.status]).sort(), [['2026-10-20', 'logged'], ['2026-10-22', 'logged']]);
}));

test('notify_days 1: tomorrow is only logged; 3: the day after tomorrow is pushed', () => withHost({ settings: { notify_days: 1 } }, async (host, untis) => {
  await household(host);
  lessonAt(untis, 101, 20261021, 800).code = 'cancelled';
  await tickAt(host, T0 + 16 * MIN);
  assert.equal(pushes(host).length, 0);
  host.settings.notify_days = 3;
  lessonAt(untis, 101, 20261022, 850).code = 'cancelled';
  await tickAt(host, T0 + 32 * MIN);
  assert.equal(pushes(host).length, 1);
  assert.equal(pushes(host)[0].title, 'Lena: Geschichte fällt aus');
  assert.equal(pushes(host)[0].body, 'Do 22.10. · 2. Std. 08:50');
}));

test('a substitution: teacher instead of teacher, with the substitution text', () => withHost({}, async (host, untis) => {
  await household(host);
  const ge = lessonAt(untis, 101, 20261020, 1040);
  ge.code = 'irregular';
  ge.te = [{ id: 14, name: 'KLE', longname: 'Klein', orgid: 12, orgname: 'SCH' }];
  ge.substText = 'Vertretung';
  await tickAt(host, T0 + 16 * MIN);
  const p = pushes(host);
  assert.equal(p.length, 1);
  assert.equal(p[0].title, 'Lena: Geschichte – Vertretung');
  assert.equal(p[0].body, 'Di 20.10. · 4. Std. 10:40 · KLE statt SCH · Vertretung');
  // the room changes as well: a new change of the same lesson
  ge.ro = [{ id: 3, name: '104', longname: 'Raum 104', orgid: 1, orgname: '101' }];
  await tickAt(host, T0 + 32 * MIN);
  assert.equal(pushes(host).length, 2);
  assert.equal(pushes(host)[1].body, 'Di 20.10. · 4. Std. 10:40 · KLE statt SCH · Raum 104 statt 101 · Vertretung');
  const pt = await asPortal(host, LENA, '/portal/timetable');
  const l = pt.json.students[0].days[1].lessons.find((x) => x.start === '10:40');
  assert.deepEqual([l.state, l.teacher, l.teacherOld, l.room, l.roomOld, l.substText], ['changed', 'KLE', 'SCH', '104', '101', 'Vertretung']);
}));

test('several changes of one cycle: one summary push per student', () => withHost({}, async (host, untis) => {
  const { lena } = await household(host);
  lessonAt(untis, 101, 20261020, 950).code = 'cancelled';
  const ge = lessonAt(untis, 101, 20261020, 1040);
  ge.code = 'irregular';
  ge.ro = [{ id: 3, name: '104', orgid: 1, orgname: '101' }];
  untis.state.timetable[101].push({ id: 99001, date: 20261021, startTime: 1230, endTime: 1315, kl: [{ id: 501, name: '5a' }], te: [{ id: 11, name: 'MUE' }], su: [{ id: 1, name: 'M', longname: 'Mathematik' }], ro: [{ id: 1, name: '101' }], code: 'irregular' });
  // Max has no recipients: logged, not pushed
  lessonAt(untis, 102, 20261020, 950).code = 'cancelled';
  await tickAt(host, T0 + 16 * MIN);
  const p = pushes(host);
  assert.equal(p.length, 1);
  assert.equal(p[0].title, 'Lena: 3 Änderungen');
  assert.deepEqual(p[0].body.split('\n'), [
    'Di 20.10. 3. Std. 09:50: Englisch fällt aus',
    'Di 20.10. 4. Std. 10:40: Geschichte – Vertretung (Raum 104 statt 101)',
    'Mi 21.10. 6. Std. 12:30: Zusatzstunde Mathematik',
  ]);
  assert.equal(p[0].collapseKey, `schule:${lena.id}:2026-10-20`);
  const l = await log(host);
  assert.equal(l.filter((c) => c.status === 'sent').length, 3);
  assert.deepEqual(l.filter((c) => c.student === 'Max Muster').map((c) => c.status), ['no_recipients']);
  // the extra lesson in the portal
  const pt = await asPortal(host, EVA, '/portal/timetable');
  const wed = pt.json.students.find((s) => s.name === 'Lena').days.find((d) => d.date === '2026-10-21');
  assert.equal(wed.lessons.find((x) => x.start === '12:30').state, 'extra');
}));

test('quiet hours: held, sent when they end — unless the lesson is over by then', () => withHost({ now: at('2026-10-20T19:30:00Z') }, async (host, untis) => {
  // 21:30: the account is added in the quiet hours (21:00–06:00) and outside the polling window
  await household(host);
  const acc = (await asAdmin(host, 'GET', '/status')).json.accounts[0];
  assert.equal(acc.next_fetch_at, at('2026-10-20T20:30:00Z'), 'hourly in the evening');
  lessonAt(untis, 101, 20261021, 800).code = 'cancelled'; // Wed 08:00
  await tickAt(host, at('2026-10-20T20:31:00Z')); // 22:31
  assert.equal(pushes(host).length, 0);
  assert.deepEqual((await log(host)).map((c) => c.status), ['held']);
  await tickAt(host, at('2026-10-21T03:59:00Z')); // 05:59, still quiet
  assert.equal(pushes(host).length, 0);
  await tickAt(host, at('2026-10-21T04:01:00Z')); // 06:01
  assert.equal(pushes(host).length, 1);
  assert.equal(pushes(host)[0].title, 'Lena: Englisch fällt aus');
  assert.equal(pushes(host)[0].body, 'Mi 21.10. · 1. Std. 08:00');
  assert.deepEqual((await log(host)).map((c) => c.status), ['sent']);
  await tickAt(host, at('2026-10-21T04:30:00Z'));
  assert.equal(pushes(host).length, 1, 'once');
}));

test('quiet hours until 09:00: a held change of an 08:00 lesson expires', () => withHost({ now: at('2026-10-20T19:30:00Z'), settings: { quiet_from: '21:00', quiet_to: '09:00' } }, async (host, untis) => {
  await household(host);
  lessonAt(untis, 101, 20261021, 800).code = 'cancelled';
  lessonAt(untis, 101, 20261021, 1040).code = 'cancelled'; // 10:40: still ahead at 09:00
  await tickAt(host, at('2026-10-20T20:31:00Z'));
  assert.deepEqual((await log(host)).map((c) => c.status), ['held', 'held']);
  await tickAt(host, at('2026-10-21T07:01:00Z')); // 09:01
  const p = pushes(host);
  assert.equal(p.length, 1);
  assert.equal(p[0].title, 'Lena: Biologie fällt aus');
  const l = await log(host);
  assert.deepEqual(l.map((c) => [c.start, c.status]).sort(), [['08:00', 'expired'], ['10:40', 'sent']]);
}));

test('no quiet hours when both are empty', () => withHost({ now: at('2026-10-20T21:30:00Z'), settings: { quiet_from: '', quiet_to: '' } }, async (host, untis) => {
  await household(host);
  lessonAt(untis, 101, 20261021, 800).code = 'cancelled';
  await tickAt(host, at('2026-10-20T22:31:00Z')); // 00:31
  assert.equal(pushes(host).length, 1);
}));

test('a held change that is no longer true expires (cancelled, then back to normal)', () => withHost({ now: at('2026-10-20T19:30:00Z') }, async (host, untis) => {
  await household(host);
  const l = lessonAt(untis, 101, 20261021, 800);
  l.code = 'cancelled';
  await tickAt(host, at('2026-10-20T20:31:00Z'));
  delete l.code;
  await tickAt(host, at('2026-10-20T21:32:00Z'));
  await tickAt(host, at('2026-10-21T04:01:00Z'));
  assert.equal(pushes(host).length, 0, 'nothing to say: it takes place');
  const kinds = (await log(host)).map((c) => [c.kind, c.status]).sort();
  assert.deepEqual(kinds, [['cancelled', 'expired'], ['restored', 'expired']]);
}));

test('restored: a cancelled lesson that takes place after all', () => withHost({}, async (host, untis) => {
  await household(host);
  const l = lessonAt(untis, 101, 20261020, 1140);
  l.code = 'cancelled';
  await tickAt(host, T0 + 16 * MIN);
  delete l.code;
  await tickAt(host, T0 + 32 * MIN);
  assert.deepEqual(pushes(host).map((p) => p.title), ['Lena: Musik fällt aus', 'Lena: Musik findet doch statt']);
}));

test('a lesson vanishing from a school day counts as cancelled and stays visible', () => withHost({}, async (host, untis) => {
  await household(host);
  untis.state.timetable[101] = untis.state.timetable[101].filter((l) => !(l.date === 20261020 && l.startTime === 1140));
  await tickAt(host, T0 + 16 * MIN);
  assert.deepEqual(pushes(host).map((p) => p.title), ['Lena: Musik fällt aus']);
  await tickAt(host, T0 + 32 * MIN);
  assert.equal(pushes(host).length, 1, 'once');
  const pt = await asPortal(host, LENA, '/portal/timetable');
  const tue = pt.json.students[0].days.find((d) => d.date === '2026-10-20');
  assert.deepEqual(tue.lessons.map((l) => [l.start, l.state]), [['08:00', 'normal'], ['08:50', 'normal'], ['09:50', 'normal'], ['10:40', 'normal'], ['11:40', 'cancelled']]);
}));

test('re-imports: renumbered lessons are no change; a replaced day or a vanished day is a new baseline', () => withHost({}, async (host, untis) => {
  await household(host);
  for (const l of untis.state.timetable[101]) l.id += 50000;
  await tickAt(host, T0 + 16 * MIN);
  assert.equal(pushes(host).length, 0);
  assert.deepEqual(await log(host), []);
  // Wednesday gets a new timetable: other subjects in every period
  const wed = untis.state.timetable[101].filter((l) => l.date === 20261021);
  wed.forEach((l, i) => { l.su = [{ id: 40 + i, name: `X${i}`, longname: `Fach ${i}` }]; });
  // Thursday vanishes completely (e.g. a school trip entered as an event elsewhere)
  untis.state.timetable[101] = untis.state.timetable[101].filter((l) => l.date !== 20261022);
  await tickAt(host, T0 + 32 * MIN);
  assert.equal(pushes(host).length, 0);
  assert.deepEqual(await log(host), []);
}));

test('a student switched off and on again starts with a new baseline', () => withHost({}, async (host, untis) => {
  const { lena } = await household(host);
  await asAdmin(host, 'PUT', `/students/${lena.id}`, { enabled: false });
  lessonAt(untis, 101, 20261020, 950).code = 'cancelled';
  await tickAt(host, T0 + 16 * MIN);
  await asAdmin(host, 'PUT', `/students/${lena.id}`, { enabled: true });
  await tickAt(host, T0 + 17 * MIN);
  assert.equal(pushes(host).length, 0);
  lessonAt(untis, 101, 20261020, 1040).code = 'cancelled';
  await tickAt(host, T0 + 33 * MIN);
  assert.deepEqual(pushes(host).map((p) => p.title), ['Lena: Geschichte fällt aus']);
}));

test('English pushes', () => withHost({ settings: { notify_lang: 'en' } }, async (host, untis) => {
  await household(host);
  const e = lessonAt(untis, 101, 20261020, 950);
  e.code = 'irregular';
  e.te = [{ id: 12, name: 'SCH', orgid: 13, orgname: 'WEB' }];
  await tickAt(host, T0 + 16 * MIN);
  assert.equal(pushes(host)[0].title, 'Lena: Englisch – substitution');
  assert.equal(pushes(host)[0].body, 'Tue 20/10 · lesson 3 09:50 · SCH instead of WEB');
}));

test('push budget used up: the change stays pending and goes out later', () => withHost({}, async (host, untis) => {
  await household(host);
  const index = require('../server/index');
  const notify = require('../server/notify');
  // a notifier with no budget left
  index._state.notifier = notify.createNotifier(host.gc, { perHour: 0, highReserve: 0 });
  lessonAt(untis, 101, 20261020, 1140).code = 'cancelled';
  await tickAt(host, T0 + 16 * MIN);
  assert.equal(pushes(host).length, 0);
  assert.deepEqual((await log(host)).map((c) => c.status), ['pending']);
  index._state.notifier = notify.createNotifier(host.gc);
  await tickAt(host, T0 + 17 * MIN);
  assert.equal(pushes(host).length, 1);
}));
