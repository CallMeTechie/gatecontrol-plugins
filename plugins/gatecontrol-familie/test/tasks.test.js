'use strict';

// Tasks and stars: occurrences (daily / weekly / monthly), modes fixed,
// rotate and first, done idempotent per occurrence, reminders when due
// (one per occurrence and person, again after a snooze), stars for
// children (weekly total from Monday 00:00 local), parents-only editing.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withFamily, ANNA, MARC, LENA, TIM, T0, MIN, HOUR, DAY, pushes } = require('./helpers');
const tasks = require('../server/tasks');

const task = (o) => ({ repeat: 'none', weekdays: null, anchor: '2026-10-14', ...o });

test('occurrences: one-off, daily, weekly on weekdays, monthly clamped to the month\'s end', () => {
  assert.equal(tasks.currentOccurrence(task({ anchor: '2026-10-10' }), '2026-10-14'), '2026-10-10', 'one-off stays (overdue)');
  assert.equal(tasks.currentOccurrence(task({ repeat: 'daily', anchor: '2026-10-01' }), '2026-10-14'), '2026-10-14');
  assert.equal(tasks.currentOccurrence(task({ repeat: 'daily', anchor: '2026-10-20' }), '2026-10-14'), '2026-10-20', 'not before the anchor');
  // 2026-10-14 is a Wednesday (3); Mon + Thu
  const wk = task({ repeat: 'weekly', weekdays: [1, 4], anchor: '2026-10-01' });
  assert.equal(tasks.currentOccurrence(wk, '2026-10-14'), '2026-10-15');
  assert.equal(tasks.nextOccurrence(wk, '2026-10-16'), '2026-10-19');
  assert.equal(tasks.isOccurrence(wk, '2026-10-19'), true);
  assert.equal(tasks.isOccurrence(wk, '2026-10-14'), false);
  const mo = task({ repeat: 'monthly', anchor: '2026-01-31' });
  assert.equal(tasks.nextOccurrence(mo, '2026-02-01'), '2026-02-28');
  assert.equal(tasks.nextOccurrence(mo, '2026-03-01'), '2026-03-31');
  assert.equal(tasks.nextOccurrence(mo, '2026-04-01'), '2026-04-30');
  assert.equal(tasks.isOccurrence(mo, '2026-02-28'), true);
  assert.equal(tasks.isoWd('2026-10-18'), 7, 'Sunday = 7');
  // week start: Monday 2026-10-12 00:00 Berlin = 2026-10-11T22:00Z
  assert.equal(new Date(tasks.weekStart('2026-10-14', 'Europe/Berlin')).toISOString(), '2026-10-11T22:00:00.000Z');
});

test('create / edit / delete: parents only; the task shape of the contract', () => withFamily({}, async (host, { as }) => {
  const kid = await as(LENA)('POST', '/tasks', { title: 'Zimmer', assignees: [LENA.id] });
  assert.deepEqual([kid.status, kid.json.code], [403, 'parents_only']);
  const r = await as(ANNA)('POST', '/tasks', { title: 'Spülmaschine', mode: 'rotate', assignees: [LENA.id, TIM.id], repeat: 'weekly', weekdays: [4], dueTime: '18:00', stars: 2 });
  assert.equal(r.status, 200);
  const t = r.json.task;
  assert.deepEqual(
    { id: t.id, title: t.title, mode: t.mode, assignees: t.assignees, current: t.current, repeat: t.repeat, weekdays: t.weekdays, dueTime: t.dueTime, dueDate: t.dueDate, stars: t.stars, reminder: t.reminder, doneToday: t.doneToday, lastDone: t.lastDone },
    { id: t.id, title: 'Spülmaschine', mode: 'rotate', assignees: [4, 5], current: 4, repeat: 'weekly', weekdays: [4], dueTime: '18:00', dueDate: '2026-10-15', stars: 2, reminder: true, doneToday: false, lastDone: null },
  );
  assert.ok(Number.isInteger(t.id));
  for (const bad of [{ title: '' }, { title: 'x', assignees: [] }, { title: 'x', assignees: [99] }, { title: 'x', assignees: [2], mode: 'chaos' },
    { title: 'x', assignees: [2], repeat: 'weekly', weekdays: [8] }, { title: 'x', assignees: [2], stars: 11 }, { title: 'x', assignees: [2], dueTime: '25:00' }, { title: 'x', assignees: [2], dueDate: '2026-02-30' }]) {
    assert.equal((await as(ANNA)('POST', '/tasks', bad)).json.code, 'invalid', JSON.stringify(bad));
  }
  const p = await as(MARC)('PATCH', `/tasks/${t.id}`, { title: 'Spülmaschine ausräumen', assignees: [TIM.id] });
  assert.deepEqual([p.json.task.title, p.json.task.current, p.json.task.assignees], ['Spülmaschine ausräumen', TIM.id, [TIM.id]]);
  assert.equal((await as(TIM)('PATCH', `/tasks/${t.id}`, { title: 'x' })).json.code, 'parents_only');
  assert.equal((await as(TIM)('DELETE', `/tasks/${t.id}`)).json.code, 'parents_only');
  assert.equal((await as(ANNA)('DELETE', `/tasks/${t.id}`)).status, 200);
  assert.equal((await as(ANNA)('DELETE', `/tasks/${t.id}`)).status, 404);
}));

test('rotate: done advances whose turn it is, idempotent per occurrence, stars to the child', () => withFamily({}, async (host, { as, clock }) => {
  const t = (await as(ANNA)('POST', '/tasks', { title: 'Müll raus', mode: 'rotate', assignees: [LENA.id, TIM.id], repeat: 'daily', stars: 3 })).json.task;
  const d1 = await as(LENA)('POST', `/tasks/${t.id}/done`);
  assert.deepEqual([d1.json.alreadyDone, d1.json.starsBooked, d1.json.task.doneToday, d1.json.task.current], [false, 3, true, TIM.id]);
  assert.deepEqual(d1.json.task.lastDone, { by: LENA.id, at: '2026-10-14T08:00:00Z' });
  const d2 = await as(LENA)('POST', `/tasks/${t.id}/done`);
  assert.deepEqual([d2.json.alreadyDone, d2.json.starsBooked, d2.json.task.current], [true, 0, TIM.id], 'same occurrence: nothing more');
  clock.add(DAY);
  const g = await as(TIM)('GET', '/tasks');
  const gt = g.json.tasks.find((x) => x.id === t.id);
  assert.deepEqual([gt.dueDate, gt.doneToday, gt.current], ['2026-10-15', false, TIM.id]);
  await as(TIM)('POST', `/tasks/${t.id}/done`);
  const s = (await as(ANNA)('GET', '/tasks')).json.stars;
  assert.deepEqual(s, { week: { [LENA.id]: 3, [TIM.id]: 3 }, goal: { [LENA.id]: 25, [TIM.id]: 20 } });
  // a parent ticks off for a child: the stars go to the child
  clock.add(DAY);
  const forLena = await as(MARC)('POST', `/tasks/${t.id}/done`, { userId: LENA.id });
  assert.equal(forLena.json.starsBooked, 3);
  assert.equal((await as(TIM)('POST', `/tasks/${t.id}/done`, { userId: LENA.id })).json.code, 'parents_only');
  assert.equal((await as(ANNA)('POST', `/tasks/${t.id}/done`, { userId: ANNA.id })).status, 200, 'a parent may tick off any task herself');
  const ov = await as(LENA)('GET', '/overview');
  assert.deepEqual(ov.json.stars, { week: 6, goal: 25 });
  assert.equal((await as(ANNA)('GET', '/overview')).json.stars, null, 'no stars for parents');
}));

test('weekly stars start Monday 00:00 local; module stars off: no stars booked or shown', () => withFamily({}, async (host, { as, admin, clock }) => {
  const t = (await as(ANNA)('POST', '/tasks', { title: 'Zimmer', mode: 'fixed', assignees: [TIM.id], repeat: 'daily', stars: 4 })).json.task;
  // Sunday 18 Oct 23:30 Berlin
  clock.set(Date.UTC(2026, 9, 18, 21, 30));
  await as(TIM)('POST', `/tasks/${t.id}/done`);
  assert.equal((await as(TIM)('GET', '/overview')).json.stars.week, 4);
  // Monday 00:30 Berlin: a new week
  clock.set(Date.UTC(2026, 9, 18, 22, 30));
  assert.equal((await as(TIM)('GET', '/overview')).json.stars.week, 0);
  await admin('PUT', 'modules', { stars: false });
  const d = await as(TIM)('POST', `/tasks/${t.id}/done`);
  assert.equal(d.json.starsBooked, 0);
  const g = await as(ANNA)('GET', '/tasks');
  assert.ok(!('stars' in g.json), 'GET tasks without stars');
  assert.equal((await as(TIM)('GET', '/overview')).json.stars, null);
}));

test('first: reminder to every assignee; the first one done replaces the others\' reminder (same collapse key)', () => withFamily({}, async (host, { as, clock }) => {
  const t = (await as(ANNA)('POST', '/tasks', { title: 'Hund füttern', mode: 'first', assignees: [ANNA.id, MARC.id, LENA.id], dueTime: '17:00' })).json.task;
  clock.set(Date.UTC(2026, 9, 14, 14, 59)); // 16:59 Berlin
  await host.tick();
  assert.equal(pushes(host, 'task_due').length, 0, 'not due yet');
  clock.add(MIN);
  await host.tick();
  const due = pushes(host, 'task_due');
  assert.equal(due.length, 1);
  assert.deepEqual(due[0].users.sort(), [ANNA.id, MARC.id, LENA.id]);
  assert.equal(due[0].topic, 'tasks');
  assert.equal(due[0].collapseKey, `task:${t.id}:2026-10-14`);
  assert.deepEqual(due[0].data.familie, { type: 'task_due', taskId: t.id, occurrence: '2026-10-14' });
  assert.equal(due[0].title, 'Hund füttern');
  assert.equal(due[0].body, 'Fällig heute um 17:00');
  await host.tick();
  assert.equal(pushes(host, 'task_due').length, 1, 'one reminder per occurrence');
  const d = await as(LENA)('POST', `/tasks/${t.id}/done`, { occurrence: '2026-10-14' });
  assert.equal(d.json.task.doneToday, true);
  const revoke = pushes(host, 'task_done');
  assert.equal(revoke.length, 1);
  assert.deepEqual(revoke[0].users.sort(), [ANNA.id, MARC.id]);
  assert.equal(revoke[0].collapseKey, `task:${t.id}:2026-10-14`);
  assert.equal(revoke[0].title, 'Hund füttern: erledigt');
  assert.equal(revoke[0].body, 'Lena hat es erledigt.');
  assert.equal((await as(MARC)('POST', `/tasks/${t.id}/done`)).json.alreadyDone, true, 'first wins');
  assert.equal(pushes(host, 'task_done').length, 1);
}));

test('fixed: each assignee ticks off for themselves; reminders only to who has not; snooze brings it back once', () => withFamily({}, async (host, { as, clock }) => {
  const t = (await as(ANNA)('POST', '/tasks', { title: 'Zähne putzen', mode: 'fixed', assignees: [LENA.id, TIM.id], repeat: 'daily', dueTime: '19:30' })).json.task;
  clock.set(Date.UTC(2026, 9, 14, 17, 0)); // 19:00
  await as(TIM)('POST', `/tasks/${t.id}/done`);
  const anna = (await as(ANNA)('GET', '/tasks')).json.tasks[0];
  assert.deepEqual([anna.doneToday, anna.doneBy], [false, [TIM.id]], 'a non-assignee: done when all are');
  assert.equal((await as(TIM)('GET', '/tasks')).json.tasks[0].doneToday, true);
  clock.set(Date.UTC(2026, 9, 14, 17, 30)); // 19:30
  await host.tick();
  let due = pushes(host, 'task_due');
  assert.deepEqual(due.map((p) => p.users), [[LENA.id]]);
  const sn = await as(LENA)('POST', `/tasks/${t.id}/snooze`, { minutes: 60 });
  assert.deepEqual(sn.json, { ok: true, snoozedUntil: '2026-10-14T18:30:00Z', occurrence: '2026-10-14' });
  assert.equal((await as(LENA)('POST', `/tasks/${t.id}/snooze`, { minutes: 5 })).json.code, 'invalid', '15–240 minutes');
  clock.add(59 * MIN);
  await host.tick();
  assert.equal(pushes(host, 'task_due').length, 1);
  clock.add(MIN);
  await host.tick();
  due = pushes(host, 'task_due');
  assert.equal(due.length, 2, 'again after the snooze');
  assert.deepEqual(due[1].users, [LENA.id]);
  await host.tick();
  assert.equal(pushes(host, 'task_due').length, 2, 'once per snooze');
  await as(LENA)('POST', `/tasks/${t.id}/done`);
  assert.equal((await as(ANNA)('GET', '/tasks')).json.tasks[0].doneToday, true, 'everyone done');
  // next day: a new occurrence, reminded again
  clock.set(Date.UTC(2026, 9, 15, 17, 31));
  await host.tick();
  assert.equal(pushes(host, 'task_due').length, 3);
  assert.equal(pushes(host, 'task_due')[2].data.familie.occurrence, '2026-10-15');
}));

test('reminders: rotate goes to whose turn it is; no time = 08:00; reminder off or module off = nothing', () => withFamily({}, async (host, { as, admin, clock }) => {
  await as(ANNA)('POST', '/tasks', { title: 'Blumen gießen', mode: 'rotate', assignees: [TIM.id, LENA.id], repeat: 'daily' });
  await as(ANNA)('POST', '/tasks', { title: 'Leise', mode: 'fixed', assignees: [MARC.id], repeat: 'daily', reminder: false });
  clock.set(Date.UTC(2026, 9, 15, 5, 59)); // 07:59
  await host.tick();
  assert.equal(pushes(host, 'task_due').length, 0);
  clock.add(MIN);
  await host.tick();
  assert.deepEqual(pushes(host, 'task_due').map((p) => [p.title, p.users]), [['Blumen gießen', [TIM.id]]]);
  await admin('PUT', 'modules', { tasks: false });
  clock.add(DAY);
  await host.tick();
  assert.equal(pushes(host, 'task_due').length, 1, 'module off: no reminders');
  assert.equal((await as(ANNA)('GET', '/tasks')).json.code, 'module_off');
}));

test('overview: my tasks of today (and overdue one-off tasks) with the open count', () => withFamily({}, async (host, { as }) => {
  await as(ANNA)('POST', '/tasks', { title: 'Kinderarzt anrufen', assignees: [ANNA.id], dueDate: '2026-10-12' });
  await as(ANNA)('POST', '/tasks', { title: 'Reifenwechsel', assignees: [ANNA.id], dueDate: '2026-10-17' });
  const daily = (await as(ANNA)('POST', '/tasks', { title: 'Kaffee', assignees: [ANNA.id, MARC.id], repeat: 'daily' })).json.task;
  await as(ANNA)('POST', `/tasks/${daily.id}/done`);
  const ov = (await as(ANNA)('GET', '/overview')).json.tasks;
  assert.deepEqual(ov.mine.map((x) => [x.title, x.doneToday]), [['Kinderarzt anrufen', false], ['Kaffee', true]]);
  assert.equal(ov.open, 1);
  assert.deepEqual((await as(MARC)('GET', '/overview')).json.tasks.mine.map((x) => [x.title, x.doneToday]), [['Kaffee', false]]);
  assert.equal(T0, Date.UTC(2026, 9, 14, 8));
  void HOUR;
}));
