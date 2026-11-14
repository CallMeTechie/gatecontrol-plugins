'use strict';

// 1.3.0 — „Gestern offen geblieben“: what counts (due yesterday and the person's, in „Mein Tag“ yesterday, a reminder
// that got lost), the card of „Mein Tag“ (GET yesterday, `yesterday` of GET views/myday), the three decisions per task
// (complete, POST tasks/<id>/move) and for all (POST yesterday), and the one push in the morning with its buttons. The
// clock is pinned and only ever set: the tests start on Wednesday 2026-11-18 and look at Thursday the 19th (the mockup's days).

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC, LENA, BOB, clock, T0 } = require('./helpers');

const WED = Date.parse('2026-11-18T09:00:00Z');       // Wed 10:00 CET
const THU_EARLY = Date.parse('2026-11-19T05:00:00Z'); // Thu 06:00
const THU_0730 = Date.parse('2026-11-19T06:30:20Z');  // Thu 07:30:20
const hints = (h) => h.host.notifications.filter((n) => n.topic === 'reminders' && n.data.notizen.kind === 'yesterday');
const titles = (y) => y.items.map((x) => x.title);

/** Anna's Wednesday: two tasks due, one only planned, one of Marc's, one done, one without a date. */
async function wednesday(h) {
  const l = await h.ok(ANNA, 'POST', 'lists', { name: 'Baumarkt' });
  await h.ok(ANNA, 'PUT', `lists/${l.list.id}/members`, { members: [{ id: MARC.id, role: 'write' }, { id: LENA.id, role: 'read' }] });
  const screws = await h.ok(ANNA, 'POST', 'tasks', { title: 'Schrauben kaufen', listId: l.list.id, due: { date: '2026-11-18' } });
  const recipe = await h.ok(ANNA, 'POST', 'tasks', { title: 'Rezept abholen', due: { date: '2026-11-18', time: '17:00' }, remindAt: { date: '2026-11-18', time: '17:00' } });
  const planned = await h.ok(ANNA, 'POST', 'tasks', { title: 'Keller aufräumen', myDay: true });
  const marcs = await h.ok(ANNA, 'POST', 'tasks', { title: 'Leiter zurückbringen', listId: l.list.id, assigneeId: MARC.id, due: { date: '2026-11-18' } });
  const done = await h.ok(ANNA, 'POST', 'tasks', { title: 'Altglas', due: { date: '2026-11-18' } });
  await h.ok(ANNA, 'POST', `tasks/${done.task.id}/complete`, { done: true });
  await h.ok(ANNA, 'POST', 'tasks', { title: 'Irgendwann' });
  const office = await h.ok(ANNA, 'POST', 'tasks', { title: 'Büro', area: 'work', due: { date: '2026-11-18' } });
  return { l, screws, recipe, planned, marcs, office };
}

test('what counts: due yesterday and mine, planned yesterday, per area; the card of „Mein Tag“ and its move options', async () => {
  const h = await withHost({ now: WED });
  try {
    const w = await wednesday(h);
    assert.equal((await h.ok(ANNA, 'GET', 'yesterday')).count, 0, 'on Wednesday nothing of Tuesday is open');
    clock.set(THU_EARLY);
    const y = await h.ok(ANNA, 'GET', 'yesterday');
    assert.deepEqual([y.day, y.title, y.count], ['2026-11-18', 'Gestern offen geblieben', 4]);
    assert.deepEqual(titles(y), ['Schrauben kaufen', 'Büro', 'Rezept abholen', 'Keller aufräumen']);
    assert.deepEqual(y.moveOptions, [{ to: 'tomorrow', date: '2026-11-20', label: 'Morgen' }, { to: 'weekend', date: '2026-11-21', label: 'Am Wochenende' }]);
    assert.deepEqual(titles(await h.ok(ANNA, 'GET', 'yesterday', null, { area: 'work' })), ['Büro']);
    // Marc: only what is assigned to him; Lena (may only look) and Bob: nothing
    assert.deepEqual(titles(await h.ok(MARC, 'GET', 'yesterday')), ['Leiter zurückbringen']);
    assert.equal((await h.ok(LENA, 'GET', 'yesterday')).count, 0);
    assert.equal((await h.ok(BOB, 'GET', 'yesterday')).count, 0);
    // „Mein Tag“ carries the card of its area; the tasks are in „Überfällig“ as well (older apps)
    const v = await h.ok(ANNA, 'GET', 'views/myday', null, { area: 'private' });
    assert.deepEqual(titles(v.yesterday), ['Schrauben kaufen', 'Rezept abholen', 'Keller aufräumen']);
    assert.deepEqual(v.sections.find((s) => s.id === 'overdue').items.map((x) => x.title), ['Rezept abholen', 'Leiter zurückbringen', 'Schrauben kaufen']);
    // English
    const en = (await h.host.request({ method: 'GET', path: 'yesterday', query: {}, body: null, lang: 'en', user: { ...ANNA, portal: true, loggedIn: true } })).json;
    assert.deepEqual([en.title, en.moveOptions.map((o) => o.label)], ['Left open yesterday', ['Tomorrow', 'At the weekend']]);
    assert.ok(w.planned.task.id);
  } finally { await h.close(); clock.set(T0); }
});

test('decide one task: done, today (the time stays, a reminder over already does not ring again), tomorrow, weekend, a date', async () => {
  const h = await withHost({ now: WED });
  try {
    const w = await wednesday(h);
    clock.set(Date.parse('2026-11-18T16:00:10Z'));
    await h.host.tick();
    clock.set(Date.parse('2026-11-19T17:30:00Z')); // Thu 18:30 — the recipe's 17:00 is over today as well
    // today
    let r = await h.ok(ANNA, 'POST', `tasks/${w.recipe.task.id}/move`, { to: 'today' });
    assert.deepEqual([r.task.due, r.task.remindAt, r.task.reminder, r.task.overdue], [{ date: '2026-11-19', time: '17:00' }, '2026-11-19T17:00:00+01:00', null, true]);
    await h.host.tick();
    assert.equal(h.host.notifications.filter((n) => n.topic === 'reminders' && n.data.notizen.kind === 'reminder' && n.data.notizen.taskId === w.recipe.task.id).length, 1,
      'the reminder of Wednesday went out then — moving to today after its time adds none');
    // the same again changes nothing
    const before = (await h.ok(ANNA, 'GET', 'tasks/' + w.recipe.task.id)).task.updatedAt;
    clock.set(Date.parse('2026-11-19T17:31:00Z'));
    assert.equal((await h.ok(ANNA, 'POST', `tasks/${w.recipe.task.id}/move`, { to: 'today' })).task.updatedAt, before);
    // tomorrow: the reminder moves with the day and is to come again
    r = await h.ok(ANNA, 'POST', `tasks/${w.recipe.task.id}/move`, { to: 'tomorrow' });
    assert.deepEqual([r.task.due, r.task.reminder.at], [{ date: '2026-11-20', time: '17:00' }, '2026-11-20T17:00:00+01:00']);
    // the weekend, a date; a task without a time
    assert.deepEqual((await h.ok(ANNA, 'POST', `tasks/${w.screws.task.id}/move`, { to: 'weekend' })).task.due, { date: '2026-11-21', time: null });
    assert.deepEqual((await h.ok(ANNA, 'POST', `tasks/${w.screws.task.id}/move`, { to: '2026-12-01' })).task.due, { date: '2026-12-01', time: null });
    // only planned yesterday: today → „Mein Tag“ of today, no due date; another day → that day becomes its due date
    r = await h.ok(ANNA, 'POST', `tasks/${w.planned.task.id}/move`, { to: 'today' });
    assert.deepEqual([r.task.due, r.task.myDay], [null, true]);
    r = await h.ok(ANNA, 'POST', `tasks/${w.planned.task.id}/move`, { to: 'tomorrow' });
    assert.deepEqual(r.task.due, { date: '2026-11-20', time: null });
    assert.deepEqual(titles(await h.ok(ANNA, 'GET', 'yesterday', null, { area: 'private' })), []);
    // input and rights
    for (const to of ['yesterday', '2026-11-18', '19.11.2026', null]) assert.deepEqual((await h.call(ANNA, 'POST', `tasks/${w.screws.task.id}/move`, { to })).json, { ok: false, code: 'invalid', field: 'to' }, String(to));
    assert.equal((await h.call(LENA, 'POST', `tasks/${w.marcs.task.id}/move`, { to: 'today' })).status, 403);
    assert.equal((await h.call(BOB, 'POST', `tasks/${w.marcs.task.id}/move`, { to: 'today' })).status, 404);
    // Marc ticks his off: gone from his card
    await h.ok(MARC, 'POST', `tasks/${w.marcs.task.id}/complete`, { done: true });
    assert.equal((await h.ok(MARC, 'GET', 'yesterday')).count, 0);
  } finally { await h.close(); clock.set(T0); }
});

test('the weekend is the coming Saturday — on a Saturday the Sunday', async () => {
  const y = require('../server/yesterday');
  assert.deepEqual(['2026-11-16', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22'].map((d) => y.weekend(d)), ['2026-11-21', '2026-11-21', '2026-11-21', '2026-11-22', '2026-11-28']);
});

test('decide all at once: POST yesterday today / move / done, some by id; what the person may not change is named', async () => {
  const h = await withHost({ now: WED });
  try {
    const w = await wednesday(h);
    clock.set(THU_EARLY);
    // some by id
    let r = await h.ok(ANNA, 'POST', 'yesterday', { action: 'move', to: 'weekend', ids: [w.screws.task.id, 99999] });
    assert.deepEqual([r.changed, r.failed, titles(r.yesterday)], [1, [], ['Büro', 'Rezept abholen', 'Keller aufräumen']]);
    // another person's task by id is no part of my card: untouched
    r = await h.ok(ANNA, 'POST', 'yesterday', { action: 'done', ids: [w.marcs.task.id] });
    assert.equal(r.changed, 0);
    assert.equal((await h.ok(ANNA, 'GET', 'tasks/' + w.marcs.task.id)).task.done, false);
    // „Alle heute“ of one area's card
    r = await h.ok(ANNA, 'POST', 'yesterday', { action: 'today', area: 'private' });
    assert.deepEqual([r.changed, r.failed, r.yesterday.count], [3, [], 0]);
    assert.deepEqual((await h.ok(ANNA, 'GET', 'tasks/' + w.recipe.task.id)).task.due, { date: '2026-11-19', time: '17:00' });
    const md = await h.ok(ANNA, 'GET', 'views/myday', null, { area: 'private' });
    assert.deepEqual(md.sections.find((s) => s.id === 'today').items.map((x) => x.title).sort(), ['Keller aufräumen', 'Rezept abholen']);
    // input
    for (const b of [{}, { action: 'delete' }, { action: 'move' }, { action: 'move', to: '2020-01-01' }, { action: 'done', ids: 'alle' }, { action: 'done', ids: [0] }]) {
      assert.equal((await h.call(ANNA, 'POST', 'yesterday', b)).status, 400, JSON.stringify(b));
    }
    // a member who may only look, with a task assigned: may tick it off, may not move it
    const lena = await h.ok(ANNA, 'POST', 'tasks', { title: 'Zimmer', listId: w.l.list.id, assigneeId: LENA.id, due: { date: '2026-11-18' } });
    r = await h.ok(LENA, 'POST', 'yesterday', { action: 'today' });
    assert.deepEqual([r.changed, r.failed], [0, [{ id: lena.task.id, code: 'forbidden' }]]);
    r = await h.ok(LENA, 'POST', 'yesterday', { action: 'done' });
    assert.deepEqual([r.changed, r.failed, r.yesterday.count], [1, [], 0]);
  } finally { await h.close(); clock.set(T0); }
});

test('the push in the morning: once, at the person\'s time, only with something open; several tasks in one message', async () => {
  const h = await withHost({ now: WED });
  try {
    const w = await wednesday(h);
    await h.ok(MARC, 'PUT', 'prefs', { yesterdayAt: '09:15' });
    clock.set(THU_EARLY);
    await h.host.tick();
    assert.equal(hints(h).length, 0, '06:00: too early');
    clock.set(THU_0730);
    await h.host.tick();
    await h.host.tick();
    let n = hints(h);
    assert.equal(n.length, 1, 'Anna at 07:30, Marc not before 09:15');
    assert.deepEqual([n[0].title, n[0].users, n[0].collapseKey, n[0].priority], ['Gestern offen geblieben: 4', [ANNA.id], 'yesterday', 'normal']);
    assert.equal(n[0].body, 'Schrauben kaufen · Baumarkt\nBüro · Aufgaben\nRezept abholen · Aufgaben\nKeller aufräumen · Aufgaben');
    assert.deepEqual(n[0].data.notizen, { kind: 'yesterday', day: '2026-11-18', count: 4, taskIds: [w.screws.task.id, w.office.task.id, w.recipe.task.id, w.planned.task.id], area: null });
    // several: „Erledigt“ opens the app (it asks once), „Heute“ is a callback, „Verschieben“ opens the app
    assert.deepEqual(n[0].data.actions.map((a) => [a.type, a.id, a.label, a.target || null]), [
      ['open_app_route', 'done_ask', 'Erledigt', 'plg-gatecontrol-notizen'], ['callback', 'today', 'Heute', null], ['open_app_route', 'move', 'Verschieben', 'plg-gatecontrol-notizen']]);
    // Marc at 09:15: one task — „Erledigt“ is a callback
    clock.set(Date.parse('2026-11-19T08:15:30Z'));
    await h.host.tick();
    n = hints(h);
    assert.equal(n.length, 2);
    assert.deepEqual([n[1].title, n[1].body, n[1].users, n[1].data.notizen.count], ['Gestern offen geblieben', 'Leiter zurückbringen · Baumarkt', [MARC.id], 1]);
    assert.deepEqual(n[1].data.actions.map((a) => [a.type, a.id]), [['callback', 'done'], ['callback', 'today'], ['open_app_route', 'move']]);
    // a restart of the plugin the same day: not again
    await h.host.stop();
    await h.host.start();
    clock.set(Date.parse('2026-11-19T10:00:00Z'));
    await h.host.tick();
    assert.equal(hints(h).length, 2);
    // the next day: nothing was due on Thursday, nothing is sent
    clock.set(Date.parse('2026-11-20T06:31:00Z'));
    await h.host.tick();
    assert.equal(hints(h).length, 2);
  } finally { await h.close(); clock.set(T0); }
});

test('the push: more than five tasks are counted, the person\'s switch and a morning that is long over keep it back', async () => {
  const h = await withHost({ now: WED });
  try {
    for (let i = 1; i <= 7; i++) await h.ok(ANNA, 'POST', 'tasks', { title: 'Aufgabe ' + i, due: { date: '2026-11-18' } });
    await h.ok(MARC, 'POST', 'tasks', { title: 'Marcs', due: { date: '2026-11-18' } });
    await h.ok(MARC, 'PUT', 'prefs', { notify: { yesterday: false } });
    await h.ok(LENA, 'POST', 'tasks', { title: 'Lenas', due: { date: '2026-11-18' } });
    await h.ok(LENA, 'PUT', 'prefs', { yesterdayAt: '06:00' });
    // the server comes up at 13:10: Anna's 07:30 is 5 h 40 min ago (still sent), Lena's 06:00 over 7 hours (not any more)
    clock.set(Date.parse('2026-11-19T12:10:00Z'));
    await h.host.tick();
    const n = hints(h);
    assert.deepEqual(n.map((x) => x.users), [[ANNA.id]]);
    assert.equal(n[0].title, 'Gestern offen geblieben: 7');
    assert.deepEqual(n[0].body.split('\n').slice(-2), ['Aufgabe 5 · Aufgaben', '… und 2 weitere']);
    assert.equal(n[0].data.notizen.taskIds.length, 7);
    // the card is there for all three all the same
    for (const u of [MARC, LENA]) assert.equal((await h.ok(u, 'GET', 'yesterday')).count, 1);
    assert.deepEqual((await h.ok(MARC, 'GET', 'me')).yesterday, { push: false, at: '07:30' });
    assert.equal((await h.call(LENA, 'PUT', 'prefs', { yesterdayAt: 'früh' })).status, 200, 'a time that is none keeps the old one');
    assert.equal((await h.ok(LENA, 'GET', 'prefs')).prefs.yesterdayAt, '06:00');
  } finally { await h.close(); clock.set(T0); }
});

test('the buttons of the morning push: „Heute“ moves what is still open, „Erledigt“ only the push of one task, rights checked again', async () => {
  const h = await withHost({ now: WED });
  try {
    const w = await wednesday(h);
    clock.set(THU_0730);
    await h.host.tick();
    const mine = hints(h).find((n) => n.users[0] === ANNA.id);
    // „Erledigt“ as a callback does not exist for several tasks — even when a device sends it
    assert.deepEqual(await h.press(ANNA, mine, 'done'), { ok: false, code: 'invalid' });
    assert.deepEqual(await h.press(ANNA, mine, 'move'), { ok: false, code: 'invalid' });
    // somebody else presses a push that is not theirs: nothing of Anna's moves
    assert.deepEqual(await h.press(BOB, mine, 'today'), { ok: true, changed: 0, failed: [] });
    assert.deepEqual(await h.press(MARC, mine, 'today'), { ok: true, changed: 0, failed: [] });
    assert.equal((await h.ok(ANNA, 'GET', 'yesterday')).count, 4);
    // Anna ticks one off in the app first; „Heute“ takes the three that are left — and a second press nothing
    await h.ok(ANNA, 'POST', `tasks/${w.screws.task.id}/complete`, { done: true });
    assert.deepEqual(await h.press(ANNA, mine, 'today'), { ok: true, changed: 3, failed: [] });
    assert.deepEqual(await h.press(ANNA, mine, 'today'), { ok: true, changed: 0, failed: [] });
    assert.equal((await h.ok(ANNA, 'GET', 'yesterday')).count, 0);
    assert.deepEqual((await h.ok(ANNA, 'GET', 'tasks/' + w.recipe.task.id)).task.due, { date: '2026-11-19', time: '17:00' });
    // Marc's push of one task: „Erledigt“
    clock.set(Date.parse('2026-11-19T06:31:00Z'));
    const marcs = hints(h).find((n) => n.users[0] === MARC.id);
    assert.deepEqual(await h.press(MARC, marcs, 'done'), { ok: true, changed: 1, failed: [] });
    assert.equal((await h.ok(ANNA, 'GET', 'tasks/' + w.marcs.task.id)).task.done, true);
    assert.deepEqual(await h.press(MARC, marcs, 'done'), { ok: true, changed: 0, failed: [] });
    // a push without ids
    assert.deepEqual(await h.host.notifyAction({ userId: ANNA.id, action: 'today', data: { notizen: { kind: 'yesterday', taskIds: [] } } }), { ok: false, code: 'invalid' });
  } finally { await h.close(); clock.set(T0); }
});
