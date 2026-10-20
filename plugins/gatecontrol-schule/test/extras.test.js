'use strict';

// 1.2.0 — homework and exams (server/extras.js): parsing (records name the student, a parent account's
// siblings, assignedStudents / class), the fetch in the cycle (once per account / per student, the
// same session), the shapes in app/timetable (an Android app reads them) and the portal, failures that
// never break the timetable (skipped for 6 hours unless 'network'), the evening reminders (topics
// exams / homework, once, quiet hours), the tile / widget for tomorrow's exam and the admin page.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, asAdmin, asApp, asPortal, setupParent, tickAt, at, clock, EVA, LENA, BOB, T0 } = require('./helpers');
const extras = require('../server/extras');

const MIN = 60000;
const HOUR = 60 * MIN;

/** The account's homework and exams as the fake WebUntis answers them. */
function seed(untis) {
  untis.state.homework = {
    homeworks: [
      { id: 501, lessonId: 9001, date: 20261019, dueDate: 20261021, text: 'S. 42 Nr. 3', remark: '', completed: false, attachments: [] },
      { id: 502, lessonId: 9002, date: 20261020, dueDate: 20261021, text: 'Vokabeln Unit 3', remark: 'auch die Beispielsätze', completed: true },
      { id: 503, lessonId: 9003, date: 20261020, dueDate: 20261022, text: 'Gedicht lernen', completed: false },
      { id: 504, lessonId: 9001, date: 20261020, text: 'ohne Fälligkeit' },
    ],
    lessons: [{ id: 9001, subject: 'Mathematik', lessonType: 'Unterricht' }, { id: 9002, subject: 'E', lessonType: 'Unterricht' }, { id: 9003, subject: 'Deutsch', lessonType: 'Unterricht' }],
    records: [{ homeworkId: 501, teacherId: 11, elementIds: [101] }, { homeworkId: 502, teacherId: 12, elementIds: [101] }, { homeworkId: 503, teacherId: 11, elementIds: [102] }],
    teachers: [{ id: 11, name: 'MUE' }],
  };
  untis.state.exams = [
    { id: 7001, examType: 'Klassenarbeit', name: 'KA 2', examDate: 20261021, startTime: 950, endTime: 1035, subject: 'M', teachers: ['MUE'], rooms: ['101'], text: 'Bruchrechnung', grade: '2',
      assignedStudents: [{ id: 101, displayName: 'Lena Muster', klasse: { id: 501, name: '5a' } }] },
    { id: 7002, examType: 'Test', name: 'Vokabeltest', examDate: 20261022, startTime: 800, endTime: 845, subject: 'E', studentClass: ['7b'], assignedStudents: [] },
    { id: 7003, examType: '', name: 'Diktat', examDate: 20261023, startTime: 0, endTime: 0, subject: 'Deutsch', studentClass: ['5a'], text: '' },
  ];
}

test('parsing: records name the student; siblings only with their subjects; exams by assignment or class', () => {
  const index = extras.subjectIndex([{ subject: 'M', subject_long: 'Mathematik' }, { subject: 'E', subject_long: 'Englisch' }]);
  const data = {
    homeworks: [
      { id: 1, lessonId: 1, date: 20261019, dueDate: 20261021, text: '  S. 42\nNr. 3 ', completed: false },
      { id: 2, lessonId: 2, date: 20261019, dueDate: 20261022, text: 'Bild malen' },
      { id: 3, lessonId: 1, dueDate: 'x', text: 'kaputt' },
      { lessonId: 1, dueDate: 20261021, text: 'ohne id' },
      'Unsinn', null,
    ],
    lessons: [{ id: 1, subject: 'Mathematik' }, { id: 2, subject: 'Kunst' }],
  };
  assert.deepEqual(extras.homeworkRows(data, { personId: 101, index }).map((h) => [h.hw_id, h.due_date, h.subject, h.subject_long, h.text, h.given_date]), [
    ['1', '2026-10-21', 'M', 'Mathematik', 'S. 42 Nr. 3', '2026-10-19'], ['2', '2026-10-22', 'Kunst', null, 'Bild malen', '2026-10-19'],
  ]);
  // several students in the account, no records: only subjects of this student's timetable
  assert.deepEqual(extras.homeworkRows(data, { personId: 101, index, siblings: true }).map((h) => h.hw_id), ['1']);
  // records naming the student win
  assert.deepEqual(extras.homeworkRows({ ...data, records: [{ homeworkId: 2, elementIds: [101] }] }, { personId: 101, index, siblings: true }).map((h) => h.hw_id), ['2']);
  assert.deepEqual(extras.homeworkRows(null, {}), []);
  assert.deepEqual(extras.homeworkRows({ homeworks: 'x' }, {}), []);

  const exams = [
    { id: 1, examDate: 20261021, startTime: 950, endTime: 1035, subject: 'M', name: 'KA', assignedStudents: [{ id: 102 }] },
    { id: 2, examDate: 20261021, subject: 'M', name: 'KA', assignedStudents: [{ id: 101 }], examType: 'Klassenarbeit' },
    { id: 3, examDate: 20261022, subject: 'E', name: 'Test', studentClass: ['7b'] },
    { id: 4, examDate: 20261022, subject: 'E', name: 'Test 5a', studentClass: ['5A'], startTime: 800 },
    { id: 5, examDate: 20261023, subject: 'X', name: 'ohne Klasse' },
    { id: 6, examDate: 20261201, subject: 'M', name: 'später' },
    { id: 7, examDate: 'kaputt' },
  ];
  const rows = extras.examRows(exams, { personId: 101, klassen: extras.klassenOf([{ klasse: '5a' }]), index, from: '2026-10-19', to: '2026-11-01' });
  assert.deepEqual(rows.map((x) => [x.ex_id, x.date, x.t_start, x.t_end, x.subject, x.subject_long, x.name, x.type]), [
    ['2', '2026-10-21', null, null, 'M', 'Mathematik', 'KA', 'Klassenarbeit'],
    ['4', '2026-10-22', '08:00', null, 'E', 'Englisch', 'Test 5a', null],
    ['5', '2026-10-23', null, null, 'X', null, 'ohne Klasse', null],
  ]);
  assert.equal(extras.klasseIdOf([{ kl: [{ id: 501 }] }, { kl: [{ id: 501 }, { id: 9 }] }, { kl: 'x' }]), 501);
  assert.equal(extras.klasseIdOf([]), null);
});

test('the cycle: homework once per account, exams per student (class and student), same session; the app API shapes', () => withHost({}, async (host, untis) => {
  seed(untis);
  await setupParent(host);
  const q = untis.state.queries;
  assert.deepEqual(q.map((x) => x.kind), ['homeworks', 'exams', 'exams']);
  assert.deepEqual(q[0].query, { startDate: '20261005', endDate: '20261101' }, 'homework from 14 days before the timetable');
  assert.deepEqual(q[1].query, { startDate: '20261019', endDate: '20261101', klasseId: '501', studentId: '101', withGrades: 'true' });
  assert.deepEqual([q[2].query.klasseId, q[2].query.studentId], ['701', '102']);
  assert.ok(untis.state.cookies.slice(-3).every((c) => /^JSESSIONID=S\d+x/.test(c)), 'with the session cookie');

  const r = await asApp(host, EVA, '/app/timetable', { from: '2026-10-20', to: '2026-10-23' });
  assert.equal(r.status, 200);
  const lena = r.json.students[0];
  const day = (d) => lena.days.find((x) => x.date === d);
  // the existing fields unchanged; the new arrays only when there is something
  assert.deepEqual(Object.keys(day('2026-10-20')), ['date', 'lessons']);
  assert.equal(day('2026-10-20').lessons.length, 5);
  assert.deepEqual(day('2026-10-21').homework, [
    { subject: 'E', subjectLong: 'Englisch', text: 'Vokabeln Unit 3', givenDate: '2026-10-20', completed: true },
    { subject: 'M', subjectLong: 'Mathematik', text: 'S. 42 Nr. 3', givenDate: '2026-10-19' },
  ]);
  assert.deepEqual(day('2026-10-21').exams, [{ subject: 'M', subjectLong: 'Mathematik', name: 'KA 2', start: '09:50', end: '10:35', type: 'Klassenarbeit', text: 'Bruchrechnung' }]);
  assert.deepEqual(Object.keys(day('2026-10-22')), ['date', 'lessons'], 'Max\'s homework and the 7b test are not Lena\'s');
  assert.deepEqual(day('2026-10-23').exams, [{ subject: 'D', subjectLong: 'Deutsch', name: 'Diktat' }]);
  assert.ok(!JSON.stringify(r.json).includes('"grade"'), 'no grades');
  // Max (admin sees him): his homework and the 7b test
  const all = await asApp(host, { id: 1, name: 'admin', role: 'admin' }, '/app/timetable', { from: '2026-10-22', to: '2026-10-22' });
  const max = all.json.students.find((s) => s.name === 'Max Muster');
  assert.deepEqual([max.days[0].homework, max.days[0].exams], [
    [{ subject: 'D', subjectLong: 'Deutsch', text: 'Gedicht lernen', givenDate: '2026-10-20' }],
    [{ subject: 'E', subjectLong: 'Englisch', name: 'Vokabeltest', start: '08:00', end: '08:45', type: 'Test' }],
  ]);
  // the portal week has them as well
  const pw = await asPortal(host, LENA, '/portal/timetable');
  assert.equal(pw.json.students[0].days.find((d) => d.date === '2026-10-21').exams[0].name, 'KA 2');
  // a homework that is gone in WebUntis is gone here after the next fetch; exams are replaced
  untis.state.homework.homeworks = untis.state.homework.homeworks.filter((h) => h.id !== 501);
  untis.state.exams = [];
  await tickAt(host, T0 + 15 * MIN);
  const again = (await asApp(host, EVA, '/app/timetable', { from: '2026-10-21', to: '2026-10-21' })).json.students[0].days[0];
  assert.deepEqual([again.homework.map((h) => h.text), again.exams], [['Vokabeln Unit 3'], undefined]);
}));

test('failures never break the timetable: 403 → left alone for 6 hours, network → tried next cycle, the stored data stays', () => withHost({}, async (host, untis) => {
  seed(untis);
  await setupParent(host);
  untis.state.restStatus = { homeworks: 403, exams: 500 };
  untis.state.timetable[101].find((l) => l.date === 20261020 && l.startTime === 950).code = 'cancelled';
  untis.state.calls.length = 0;
  await tickAt(host, T0 + 15 * MIN);
  assert.deepEqual(untis.state.calls, ['getUserData2017', 'app/config', 'getTimetable', 'getTimetable', 'homeworks', 'exams', 'logout'], 'exams: a 5xx stops after the first student');
  let acc = (await asAdmin(host, 'GET', '/status')).json.accounts[0];
  assert.deepEqual([acc.status, acc.last_error], ['ok', null], 'the account is fine');
  assert.deepEqual(acc.extras, { homework: { code: 'auth', until: T0 + 15 * MIN + 6 * HOUR }, exams: null });
  assert.equal(host.notifications.filter((n) => n.topic === 'changes').length, 1, 'the change is pushed as ever');
  const day = (await asApp(host, EVA, '/app/timetable', { from: '2026-10-21', to: '2026-10-21' })).json.students[0].days[0];
  assert.equal(day.homework.length, 2, 'kept');
  assert.equal(day.exams.length, 1, 'kept');
  // the next cycle: no homework call (skipped), exams again
  untis.state.calls.length = 0;
  await tickAt(host, T0 + 30 * MIN);
  assert.deepEqual(untis.state.calls.filter((c) => c === 'homeworks' || c === 'exams'), ['exams']);
  // 6 hours later it is tried again; fine now → the mark is gone
  untis.state.restStatus = {};
  untis.state.calls.length = 0;
  await tickAt(host, T0 + 15 * MIN + 6 * HOUR + MIN);
  assert.deepEqual(untis.state.calls.filter((c) => c === 'homeworks' || c === 'exams'), ['homeworks', 'exams', 'exams']);
  acc = (await asAdmin(host, 'GET', '/status')).json.accounts[0];
  assert.deepEqual(acc.extras, { homework: null, exams: null });
  // malformed answers: kept as they were, the cycle is fine
  untis.state.homework = { homeworks: 'kaputt' };
  await tickAt(host, T0 + 15 * MIN + 7 * HOUR);
  acc = (await asAdmin(host, 'GET', '/status')).json.accounts[0];
  assert.equal(acc.status, 'ok');
}));

test('reminders the evening before: one push per student and topic, to the change recipients, once, not in quiet hours', () => withHost({}, async (host, untis) => {
  seed(untis);
  const { lena } = await setupParent(host);
  await asAdmin(host, 'PUT', `/students/${lena.id}`, { alias: 'Lena' });
  const sent = (topic) => host.notifications.filter((n) => n.topic === topic);
  await tickAt(host, at('2026-10-20T15:59:00Z')); // 17:59
  assert.equal(sent('exams').length + sent('homework').length, 0);
  await tickAt(host, at('2026-10-20T16:00:00Z')); // 18:00
  assert.deepEqual(sent('exams').map((n) => [n.title, n.body, n.users, n.collapseKey]), [
    ['Lena: morgen Mathematik-Arbeit (3. Std.)', 'KA 2 · Bruchrechnung', [LENA.id, EVA.id], `schule:${lena.id}:2026-10-21:exams`],
  ]);
  assert.deepEqual(sent('homework').map((n) => [n.title, n.body, n.users]), [['Lena: 1 Hausaufgabe für morgen', 'Mathematik: S. 42 Nr. 3', [LENA.id, EVA.id]]], 'done homework left out');
  assert.deepEqual(sent('exams')[0].data.schule, { studentId: lena.id, date: '2026-10-21', kind: 'exams' });
  await tickAt(host, at('2026-10-20T17:00:00Z'));
  host.plugin._state.notifier = null; // a restart: the notices keep it once
  await tickAt(host, at('2026-10-20T18:30:00Z'));
  assert.equal(sent('exams').length + sent('homework').length, 2, 'never twice');
  // Wednesday 18:00: Thursday has Max's things only (no recipients) — nothing
  await tickAt(host, at('2026-10-21T16:00:00Z'));
  assert.equal(sent('exams').length + sent('homework').length, 2);
}));

test('reminders: several exams in one push; quiet hours hold them; no reminder time = none; English', async () => {
  await withHost({ settings: { reminder_time: '20:30', quiet_from: '20:00', quiet_to: '21:00' } }, async (host, untis) => {
    seed(untis);
    untis.state.exams.push({ id: 7004, examType: 'Test', name: 'Lernkontrolle', examDate: 20261021, startTime: 1140, endTime: 1225, subject: 'BIO', assignedStudents: [{ id: 101 }] });
    await setupParent(host);
    await tickAt(host, at('2026-10-20T18:30:00Z')); // 20:30, quiet
    assert.equal(host.notifications.filter((n) => n.topic === 'exams').length, 0);
    await tickAt(host, at('2026-10-20T19:00:00Z')); // 21:00
    const n = host.notifications.filter((x) => x.topic === 'exams');
    assert.deepEqual([n.length, n[0].title, n[0].body], [1, 'Lena Muster: morgen 2 Arbeiten', 'Mathematik-Arbeit (3. Std.) – KA 2\nBiologie-Arbeit (5. Std.) – Lernkontrolle']);
  });
  await withHost({ settings: { reminder_time: '' } }, async (host, untis) => {
    seed(untis);
    await setupParent(host);
    await tickAt(host, at('2026-10-20T16:00:00Z'));
    assert.equal(host.notifications.filter((x) => x.topic === 'exams' || x.topic === 'homework').length, 0);
  });
  await withHost({ settings: { notify_lang: 'en' } }, async (host, untis) => {
    seed(untis);
    await setupParent(host);
    await tickAt(host, at('2026-10-20T16:00:00Z'));
    assert.deepEqual(host.notifications.filter((x) => x.topic === 'exams' || x.topic === 'homework').map((x) => x.title),
      ['Lena Muster: Mathematik exam tomorrow (lesson 3)', 'Lena Muster: 1 homework task for tomorrow']);
  });
});

test('tile and widget: tomorrow\'s exam as an item and a reading (limits kept)', () => withHost({}, async (host, untis) => {
  seed(untis);
  await setupParent(host);
  const tile = (await host.portalTiles({ ...EVA, portal: true, loggedIn: true }))[0];
  assert.deepEqual(tile.items.at(-1), { label: 'Morgen · Arbeit', value: 'Mathematik', icon: tile.items.at(-1).icon, state: 'warn' });
  const qa = (await host.quickActions(EVA))[0];
  assert.deepEqual(qa.widget.readings.map((r) => [r.id, r.label, r.value, r.state]), [['tomorrow', 'Morgen', 0, null], ['exam', 'Arbeit morgen', 'Mathematik', 'warn']]);
  // five changes tomorrow: three items for them, the exam last — at most 4
  for (const l of untis.state.timetable[101].filter((x) => x.date === 20261021)) l.code = 'cancelled';
  await tickAt(host, T0 + 15 * MIN);
  const t2 = (await host.portalTiles({ ...EVA, portal: true, loggedIn: true }))[0];
  assert.equal(t2.items.length, 4);
  assert.equal(t2.items[3].label, 'Morgen · Arbeit');
  // Wednesday: no exam on Thursday for Lena — no reading
  clock.set(at('2026-10-21T06:00:00Z'));
  assert.deepEqual((await host.quickActions(EVA))[0].widget.readings.map((r) => r.id), ['tomorrow']);
}));

test('admin page: the exams and homework of the next 14 days', () => withHost({}, async (host, untis) => {
  seed(untis);
  await setupParent(host);
  const st = (await asAdmin(host, 'GET', '/status')).json;
  assert.equal(st.config.reminder_time, '18:00');
  assert.deepEqual(st.upcoming.exams.map((x) => [x.student, x.date, x.subject, x.name]), [
    ['Lena Muster', '2026-10-21', 'M', 'KA 2'], ['Max Muster', '2026-10-22', 'E', 'Vokabeltest'], ['Lena Muster', '2026-10-23', 'D', 'Diktat'],
  ]);
  assert.deepEqual(st.upcoming.homework.map((h) => [h.student, h.date, h.text]), [
    ['Lena Muster', '2026-10-21', 'Vokabeln Unit 3'], ['Lena Muster', '2026-10-21', 'S. 42 Nr. 3'], ['Max Muster', '2026-10-22', 'Gedicht lernen'],
  ]);
  // not for others
  assert.equal((await host.request({ method: 'GET', path: '/status', user: { ...BOB } })).status, 403);
}));
