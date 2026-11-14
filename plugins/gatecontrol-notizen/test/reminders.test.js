'use strict';

// 1.3.0 — the reminder of a task: buttons on the push („Erledigt“, „In 1 Std.“, „Heute Abend“ / „Morgen früh“) and what
// they do through the hook notifyAction (rights checked again, a second press does nothing), POST tasks/<id>/snooze with
// the tag of one reminder, reminders the server missed (late up to 24 hours, then „Gestern offen geblieben“), GET
// reminders for a device's own alarms. The clock is pinned (helpers: Sunday 2026-11-08 10:00 in Berlin) and only ever set.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC, LENA, BOB, clock, T0 } = require('./helpers');

const at = (s) => Date.parse(s);
const reminders = (h) => h.host.notifications.filter((n) => n.topic === 'reminders' && n.data.notizen.kind === 'reminder');
const buttons = (n) => n.data.actions.map((a) => [a.type, a.id, a.label]);

test('the reminder push: text, tag and three callback buttons; the third is „Heute Abend“ until the evening is near, then „Morgen früh“', async () => {
  const h = await withHost();
  try {
    const me = await h.ok(ANNA, 'GET', 'me');
    for (const f of ['reminderActions', 'yesterdayOpen', 'taskCalendar']) assert.ok(me.features.includes(f), f);
    assert.deepEqual(me.yesterday, { push: true, at: '07:30' });
    const a = await h.ok(ANNA, 'POST', 'tasks', { text: 'heute 14 Uhr Mülltonne rausstellen' });
    const tag = `task:${a.task.id}:${at('2026-11-08T13:00:00Z')}`;
    assert.deepEqual(a.task.reminder, { tag, at: '2026-11-08T14:00:00+01:00', atMs: at('2026-11-08T13:00:00Z'), mine: true, snoozed: false });
    assert.deepEqual([a.task.snoozed, a.task.missedReminder], [false, false]);
    await h.host.tick();
    assert.equal(reminders(h).length, 0, 'not due yet');
    clock.set(at('2026-11-08T13:00:20Z'));
    await h.host.tick();
    const [n] = reminders(h);
    assert.deepEqual([n.title, n.body, n.users, n.collapseKey], ['Mülltonne rausstellen', 'Fällig heute 14:00 · Aufgaben', [ANNA.id], 'task:' + a.task.id]);
    assert.deepEqual(n.data.notizen, { kind: 'reminder', taskId: a.task.id, listId: a.task.listId, area: 'private', task: a.task.id, tag, remindAtMs: at('2026-11-08T13:00:00Z'),
      dueAt: '2026-11-08T14:00:00+01:00', late: false, snoozed: false });
    assert.deepEqual(buttons(n), [['callback', 'done', 'Erledigt'], ['callback', 'snooze_1h', 'In 1 Std.'], ['callback', 'snooze_eve', 'Heute Abend']]);
    // sent: the task has no reminder to come any more
    assert.equal((await h.ok(ANNA, 'GET', 'tasks/' + a.task.id)).task.reminder, null);
    // 18:30 — the evening (19:00) is less than an hour away
    const b = await h.ok(ANNA, 'POST', 'tasks', { title: 'Wäsche', remindAt: { date: '2026-11-08', time: '18:30' } });
    clock.set(at('2026-11-08T17:30:10Z'));
    await h.host.tick();
    const late = reminders(h).find((x) => x.data.notizen.taskId === b.task.id);
    assert.deepEqual(buttons(late), [['callback', 'done', 'Erledigt'], ['callback', 'snooze_1h', 'In 1 Std.'], ['callback', 'snooze_tom', 'Morgen früh']]);
    assert.equal(late.body, 'Aufgaben', 'no due date: the list only');
  } finally { await h.close(); clock.set(T0); }
});

test('„Erledigt“ on the push ticks the task off — once, and only for a person who may', async () => {
  const h = await withHost();
  try {
    const l = await h.ok(ANNA, 'POST', 'lists', { name: 'Haus' });
    await h.ok(ANNA, 'PUT', `lists/${l.list.id}/members`, { members: [{ id: MARC.id, role: 'write' }, { id: LENA.id, role: 'read' }] });
    const a = await h.ok(ANNA, 'POST', 'tasks', { title: 'Blumen gießen', listId: l.list.id, due: { date: '2026-11-08', time: '12:00' }, remindAt: { date: '2026-11-08', time: '12:00' }, repeat: { type: 'daily', interval: 1 } });
    clock.set(at('2026-11-08T11:00:05Z'));
    await h.host.tick();
    const [n] = reminders(h);
    // a stranger and a member who may only look: nothing happens
    assert.deepEqual(await h.press(BOB, n, 'done'), { ok: false, code: 'not_found' });
    assert.deepEqual(await h.press(LENA, n, 'done'), { ok: false, code: 'forbidden' });
    assert.deepEqual(await h.press(LENA, n, 'snooze_1h'), { ok: false, code: 'forbidden' });
    assert.equal((await h.ok(ANNA, 'GET', 'tasks/' + a.task.id)).task.done, false);
    // the person, and a second press (another device, the alarm): the next of the repeat is made once
    assert.deepEqual(await h.press(ANNA, n, 'done'), { ok: true, done: true });
    assert.deepEqual(await h.press(ANNA, n, 'done'), { ok: true, done: false });
    assert.deepEqual(await h.press(MARC, n, 'done'), { ok: true, done: false });
    const open = (await h.ok(ANNA, 'GET', 'views/list:' + l.list.id)).sections.find((s) => s.id === 'open').items;
    assert.deepEqual(open.map((x) => [x.title, x.due, x.remindAt]), [['Blumen gießen', { date: '2026-11-09', time: '12:00' }, '2026-11-09T12:00:00+01:00']]);
    // a button that is none, a push without a task
    assert.deepEqual(await h.press(ANNA, n, 'delete'), { ok: false, code: 'invalid' });
    assert.deepEqual(await h.host.notifyAction({ userId: ANNA.id, action: 'done', data: { notizen: { kind: 'reminder', taskId: 'x' } } }), { ok: false, code: 'invalid' });
    assert.deepEqual(await h.host.notifyAction({ userId: ANNA.id, action: 'done', data: {} }), { ok: false, code: 'invalid' });
  } finally { await h.close(); clock.set(T0); }
});

test('„Später“: in an hour, this evening, tomorrow morning — the reminder comes again; the same button twice snoozes once', async () => {
  const h = await withHost();
  try {
    const a = await h.ok(ANNA, 'POST', 'tasks', { title: 'Paket abholen', due: { date: '2026-11-08', time: '12:00' }, remindAt: { date: '2026-11-08', time: '12:00' } });
    clock.set(at('2026-11-08T11:00:05Z'));
    await h.host.tick();
    const [n] = reminders(h);
    assert.deepEqual(await h.press(ANNA, n, 'snooze_1h'), { ok: true, snoozed: true });
    let task = (await h.ok(ANNA, 'GET', 'tasks/' + a.task.id)).task;
    assert.deepEqual([task.remindAt, task.snoozed, task.reminder.snoozed, task.due], ['2026-11-08T13:00:05+01:00', true, true, { date: '2026-11-08', time: '12:00' }]);
    // pressed again, also „Heute Abend“ of the same push after the reminder moved: nothing
    clock.set(at('2026-11-08T11:10:00Z'));
    assert.deepEqual(await h.press(ANNA, n, 'snooze_1h'), { ok: true, snoozed: false });
    assert.deepEqual(await h.press(ANNA, n, 'snooze_eve'), { ok: true, snoozed: false });
    assert.equal((await h.ok(ANNA, 'GET', 'tasks/' + a.task.id)).task.remindAt, '2026-11-08T13:00:05+01:00');
    // an hour later the push comes again, marked as snoozed, with a new tag
    clock.set(at('2026-11-08T12:00:30Z'));
    await h.host.tick();
    const again = reminders(h)[1];
    assert.deepEqual([again.data.notizen.snoozed, again.data.notizen.late, again.body], [true, false, 'Fällig heute 12:00 · Aufgaben']);
    assert.notEqual(again.data.notizen.tag, n.data.notizen.tag);
    // this evening: the person's own evening time
    await h.ok(ANNA, 'PUT', 'prefs', { times: { evening: '20:15', morning: '07:45' } });
    assert.deepEqual(await h.press(ANNA, again, 'snooze_eve'), { ok: true, snoozed: true });
    assert.equal((await h.ok(ANNA, 'GET', 'tasks/' + a.task.id)).task.remindAt, '2026-11-08T20:15:00+01:00');
    clock.set(at('2026-11-08T19:15:10Z'));
    await h.host.tick();
    const evening = reminders(h)[2];
    assert.deepEqual(evening.data.actions.map((x) => x.id), ['done', 'snooze_1h', 'snooze_tom']);
    assert.deepEqual(await h.press(ANNA, evening, 'snooze_tom'), { ok: true, snoozed: true });
    task = (await h.ok(ANNA, 'GET', 'tasks/' + a.task.id)).task;
    assert.equal(task.remindAt, '2026-11-09T07:45:00+01:00');
    // a reminder set anew is no snoozed one any more
    task = (await h.ok(ANNA, 'PATCH', 'tasks/' + a.task.id, { remindAt: { date: '2026-11-10', time: '09:00' } })).task;
    assert.deepEqual([task.snoozed, task.reminder.snoozed, task.reminder.at], [false, false, '2026-11-10T09:00:00+01:00']);
  } finally { await h.close(); clock.set(T0); }
});

test('POST tasks/<id>/snooze: the targets, the tag of one reminder, input and rights', async () => {
  const h = await withHost();
  try {
    const l = await h.ok(ANNA, 'POST', 'lists', { name: 'Haus' });
    await h.ok(ANNA, 'PUT', `lists/${l.list.id}/members`, { members: [{ id: LENA.id, role: 'read' }] });
    const a = await h.ok(ANNA, 'POST', 'tasks', { title: 'Paket', listId: l.list.id, remindAt: { date: '2026-11-08', time: '10:30' } });
    const tag = a.task.reminder.tag;
    let r = await h.ok(ANNA, 'POST', `tasks/${a.task.id}/snooze`, { until: '1h', tag });
    assert.deepEqual([r.snoozed, r.task.remindAt, r.task.snoozed], [true, '2026-11-08T11:00:00+01:00', true]);
    // the reminder has a new tag now; to where it is already: nothing to do
    assert.notEqual(r.task.reminder.tag, tag);
    assert.equal((await h.ok(ANNA, 'POST', `tasks/${a.task.id}/snooze`, { until: '1h', tag: r.task.reminder.tag })).snoozed, false);
    r = await h.ok(ANNA, 'POST', `tasks/${a.task.id}/snooze`, { until: 'evening', tag: r.task.reminder.tag });
    assert.deepEqual([r.snoozed, r.task.remindAt], [true, '2026-11-08T19:00:00+01:00']);
    // the old tag: nothing moves
    r = await h.ok(ANNA, 'POST', `tasks/${a.task.id}/snooze`, { until: 'tomorrow', tag });
    assert.deepEqual([r.snoozed, r.task.remindAt], [false, '2026-11-08T19:00:00+01:00']);
    // without a tag it always moves; an ISO time
    r = await h.ok(ANNA, 'POST', `tasks/${a.task.id}/snooze`, { until: 'tomorrow' });
    assert.deepEqual([r.snoozed, r.task.remindAt], [true, '2026-11-09T09:00:00+01:00']);
    r = await h.ok(ANNA, 'POST', `tasks/${a.task.id}/snooze`, { until: '2026-11-12T08:30:00+01:00' });
    assert.equal(r.task.remindAt, '2026-11-12T08:30:00+01:00');
    for (const until of ['2h', '2026-11-12T08:30:00', '2026-11-07T08:30:00+01:00', '2028-01-01T00:00:00Z', null, 5]) {
      const bad = await h.call(ANNA, 'POST', `tasks/${a.task.id}/snooze`, { until });
      assert.deepEqual([bad.status, bad.json.code, bad.json.field], [400, 'invalid', 'until'], String(until));
    }
    // the evening is over: 'evening' is no target any more
    clock.set(at('2026-11-08T19:00:00Z'));
    assert.deepEqual((await h.call(ANNA, 'POST', `tasks/${a.task.id}/snooze`, { until: 'evening' })).json, { ok: false, code: 'invalid', field: 'until' });
    // rights: a member who may only look (not assigned), a stranger
    assert.equal((await h.call(LENA, 'POST', `tasks/${a.task.id}/snooze`, { until: '1h' })).status, 403);
    assert.equal((await h.call(BOB, 'POST', `tasks/${a.task.id}/snooze`, { until: '1h' })).status, 404);
    // a done task is not snoozed
    await h.ok(ANNA, 'POST', `tasks/${a.task.id}/complete`, { done: true });
    assert.equal((await h.ok(ANNA, 'POST', `tasks/${a.task.id}/snooze`, { until: '1h' })).snoozed, false);
  } finally { await h.close(); clock.set(T0); }
});

test('the server was off: a reminder up to 24 hours late still comes and says when it was due; an older one is marked for the morning hint', async () => {
  const h = await withHost();
  try {
    const a = await h.ok(ANNA, 'POST', 'tasks', { title: 'Zahnarzt anrufen', due: { date: '2026-11-08', time: '14:00' }, remindAt: { date: '2026-11-08', time: '14:00' } });
    const b = await h.ok(ANNA, 'POST', 'tasks', { title: 'Reifen wechseln', due: { date: '2026-11-08', time: '16:00' }, remindAt: { date: '2026-11-08', time: '16:00' } });
    const c = await h.ok(ANNA, 'POST', 'tasks', { title: 'Punktgenau', due: { date: '2026-11-09', time: '13:55' }, remindAt: { date: '2026-11-09', time: '13:55' } });
    // the server comes back on Monday 14:05 — a's reminder is 24 h 5 min old, b's 22 h, c's 10 minutes
    clock.set(at('2026-11-09T13:05:00Z'));
    await h.host.tick();
    await h.host.tick();
    const sent = reminders(h);
    assert.deepEqual(sent.map((n) => [n.title, n.body, n.data.notizen.late]), [
      ['Reifen wechseln', 'War fällig gestern 16:00 · Aufgaben', true],
      ['Punktgenau', 'Fällig heute 13:55 · Aufgaben', false],
    ]);
    const va = (await h.ok(ANNA, 'GET', 'tasks/' + a.task.id)).task;
    assert.deepEqual([va.missedReminder, va.reminder], [true, null]);
    assert.equal((await h.ok(ANNA, 'GET', 'tasks/' + b.task.id)).task.missedReminder, false);
    // it is part of „Gestern offen geblieben“ (it was due yesterday anyway) and leaves it when it is decided
    assert.deepEqual((await h.ok(ANNA, 'GET', 'yesterday')).items.map((x) => x.title), ['Zahnarzt anrufen', 'Reifen wechseln']);
    await h.ok(ANNA, 'PATCH', 'tasks/' + a.task.id, { due: { date: '2026-11-12', time: '14:00' }, remindAt: { date: '2026-11-12', time: '14:00' } });
    assert.equal((await h.ok(ANNA, 'GET', 'tasks/' + a.task.id)).task.missedReminder, false);
    assert.deepEqual((await h.ok(ANNA, 'GET', 'yesterday')).items.map((x) => x.title), ['Reifen wechseln']);
    assert.ok(c.task.id);
  } finally { await h.close(); clock.set(T0); }
});

test('a missed reminder of days ago stays in „Gestern offen geblieben“ until it is decided, whatever its due date', async () => {
  const h = await withHost();
  try {
    const a = await h.ok(ANNA, 'POST', 'tasks', { title: 'Vor Tagen', remindAt: { date: '2026-11-08', time: '12:00' } });
    clock.set(at('2026-11-12T08:00:00Z'));
    await h.host.tick();
    assert.equal(reminders(h).length, 0);
    assert.deepEqual((await h.ok(ANNA, 'GET', 'yesterday')).items.map((x) => [x.title, x.missedReminder]), [['Vor Tagen', true]]);
    await h.ok(ANNA, 'POST', `tasks/${a.task.id}/move`, { to: 'today' });
    assert.equal((await h.ok(ANNA, 'GET', 'yesterday')).count, 0);
    assert.equal((await h.ok(ANNA, 'GET', 'tasks/' + a.task.id)).task.myDay, true);
  } finally { await h.close(); clock.set(T0); }
});

test('GET reminders: what the person will be reminded of — with tag, text and buttons as the push will have them', async () => {
  const h = await withHost();
  try {
    const l = await h.ok(ANNA, 'POST', 'lists', { name: 'Haus' });
    await h.ok(ANNA, 'PUT', `lists/${l.list.id}/members`, { members: [MARC.id] });
    const mine = await h.ok(ANNA, 'POST', 'tasks', { text: 'morgen 9 Uhr Mülltonne rausstellen' });
    const marcs = await h.ok(ANNA, 'POST', 'tasks', { title: 'Rasen', listId: l.list.id, assigneeId: MARC.id, due: { date: '2026-11-08', time: '18:30' }, remindAt: { date: '2026-11-08', time: '18:30' } });
    await h.ok(ANNA, 'POST', 'tasks', { title: 'In zwei Monaten', remindAt: { date: '2027-01-10', time: '09:00' } });
    const done = await h.ok(ANNA, 'POST', 'tasks', { title: 'Schon erledigt', remindAt: { date: '2026-11-09', time: '08:00' } });
    await h.ok(ANNA, 'POST', `tasks/${done.task.id}/complete`, { done: true });
    const f = await h.ok(ANNA, 'GET', 'reminders');
    assert.deepEqual([f.now, f.nowMs, f.enabled, f.yesterday], ['2026-11-08T10:00:00+01:00', T0, true, { push: true, at: '07:30' }]);
    assert.deepEqual(f.reminders, [{
      tag: `task:${mine.task.id}:${at('2026-11-09T08:00:00Z')}`, taskId: mine.task.id, listId: mine.task.listId, area: 'private', title: 'Mülltonne rausstellen',
      body: 'Fällig heute 09:00 · Aufgaben', at: '2026-11-09T09:00:00+01:00', atMs: at('2026-11-09T08:00:00Z'), important: false, snoozed: false, collapseKey: 'task:' + mine.task.id,
      actions: [{ id: 'done', label: 'Erledigt' }, { id: 'snooze_1h', label: 'In 1 Std.' }, { id: 'snooze_eve', label: 'Heute Abend' }],
    }]);
    // the task in a list view says whose reminder it is
    const rows = (await h.ok(ANNA, 'GET', 'views/list:' + l.list.id)).sections.find((s) => s.id === 'open').items;
    assert.deepEqual(rows.map((x) => [x.title, x.reminder.mine]), [['Rasen', false]]);
    // Marc's: his own (18:30 — „Morgen früh“ as the third button), in English when he asks so
    const m = (await h.host.request({ method: 'GET', path: 'reminders', query: {}, body: null, lang: 'en', user: { ...MARC, portal: true, loggedIn: true } })).json;
    assert.deepEqual(m.reminders.map((x) => [x.taskId, x.body, x.actions.map((b) => b.label)]), [[marcs.task.id, 'Due today 18:30 · Haus', ['Done', 'In 1 hr', 'Tomorrow morning']]]);
    // Marc leaves the list: the reminder is the owner's again (as the push goes)
    await h.ok(ANNA, 'PUT', `lists/${l.list.id}/members`, { members: [] });
    assert.deepEqual((await h.ok(ANNA, 'GET', 'reminders')).reminders.map((x) => x.taskId), [marcs.task.id, mine.task.id]);
    // switched off by the person: none, and the device sets no alarms
    await h.ok(ANNA, 'PUT', 'prefs', { notify: { reminders: false } });
    const off = await h.ok(ANNA, 'GET', 'reminders');
    assert.deepEqual([off.enabled, off.reminders], [false, []]);
  } finally { await h.close(); clock.set(T0); }
});

test('a repeating task: the next reminder is on the wall clock of its day, also over the change of summer time', async () => {
  const h = await withHost({ now: at('2027-03-27T09:00:00Z') });
  try {
    const a = await h.ok(ANNA, 'POST', 'tasks', { title: 'Tabletten', due: { date: '2027-03-27', time: '08:00' }, remindAt: { date: '2027-03-27', time: '08:00' }, repeat: { type: 'daily', interval: 1 } });
    const r = await h.ok(ANNA, 'POST', `tasks/${a.task.id}/complete`, { done: true });
    assert.deepEqual([r.next.due, r.next.remindAt], [{ date: '2027-03-28', time: '08:00' }, '2027-03-28T08:00:00+02:00']);
  } finally { await h.close(); clock.set(T0); }
});
