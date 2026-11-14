'use strict';

// 1.6.0 — whose turn (rotate / first) in any shared list, the words of the quick entry (ui/turnwords.js with its
// vectors), the family list (server/famtasks.js: tasks_bind / tasks_put / tasks_list for Familie, the rules for parents
// and children, stars, what was ticked off written down for Familie, the parents' feedback with „Noch nicht fertig“),
// Task.place.mine / canConsent. The clock is pinned (helpers: Sunday 2026-11-08 10:00 in Berlin) and only ever set.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, fakeSource, ANNA, MARC, LENA, BOB, clock, T0, PLUGINS } = require('./helpers');
const famtasks = require('../server/famtasks');
const Q = require('../ui/quickparse');
const TW = require('../ui/turnwords');
const tv = require('./vectors/turnwords.json');

const FAM = 'gatecontrol-familie';
const MIN = 60000;
const DAY = 86400000;

/** A stand-in for Familie: the to-do services of the helpers plus tasks_changed. */
function familie() {
  const src = fakeSource(FAM, { provides: { tasks_changed: { label: { de: 'x', en: 'x' }, maxPerHour: 3600 } }, service: async () => ({ ok: true }) });
  return [src, ...PLUGINS.filter((p) => p !== FAM).map((p) => fakeSource(p))];
}
const svc = (h, name, payload, caller = FAM) => h.host.callService(name, { caller, user: null, payload: { v: 1, ...payload } });
const told = (h) => h.src(FAM).state.calls.filter((c) => c.name === 'tasks_changed').length;
const bindFam = (h, extra = {}) => svc(h, 'tasks_bind', { members: [ANNA.id, MARC.id, LENA.id], parents: [ANNA.id, MARC.id], stars: true, ...extra });
const task = async (h, user, id) => (await h.ok(user, 'GET', `tasks/${id}`)).task;
const pushes = (h, kind) => h.host.notifications.filter((n) => n.data && n.data.notizen && n.data.notizen.kind === kind);

async function host(opts) {
  const h = await withHost(opts);
  famtasks.state.noTimer = true;
  return h;
}
const done = async (h) => { await h.close(); clock.set(T0); };

async function shared(h, name = 'Haushalt') {
  const l = (await h.ok(ANNA, 'POST', 'lists', { name })).list;
  await h.ok(ANNA, 'PUT', `lists/${l.id}/members`, { members: [{ id: MARC.id, role: 'write' }, { id: LENA.id, role: 'write' }] });
  return l;
}

test('the words of the quick entry: every vector; quickparse itself is untouched', () => {
  assert.ok(tv.cases.length >= 12);
  for (const c of tv.cases) {
    const p = Q.parse(c.input, tv.ctx);
    const got = TW.apply(p, { people: tv.ctx.people, stars: c.stars !== false });
    assert.deepEqual({ title: got.title, people: got.people.map((u) => u.id), turn: got.turn, stars: got.stars }, c.expect, c.input);
  }
  // nothing taken: the title is exactly what quickparse made of the line
  const p = Q.parse('Morgen 9 Uhr Zahnarzt anrufen, wichtig', tv.ctx);
  assert.equal(TW.apply(p, { people: tv.ctx.people, stars: true }).title, p.title);
});

test('in turns: the next task belongs to the next person; who left is passed over', async () => {
  const h = await host();
  try {
    const me = await h.ok(ANNA, 'GET', 'me');
    for (const f of ['taskTurns', 'taskStars', 'familyTasks', 'doneFeedback', 'placeMine']) assert.ok(me.features.includes(f), f);
    assert.deepEqual(me.familyTasks, { available: false, bound: false, listId: null, parent: false, stars: false, starsMax: 10, moved: null });
    const l = await shared(h);
    const made = await h.ok(ANNA, 'POST', 'tasks', { title: 'Spülmaschine', listId: l.id, due: { date: '2026-11-08', time: '18:00' }, repeat: { type: 'daily' }, turn: 'rotate', people: [LENA.id, MARC.id, ANNA.id] });
    assert.deepEqual([made.task.turn, made.task.people.map((u) => u.id), made.task.assignee.id, made.task.stars, made.task.family], ['rotate', [LENA.id, MARC.id, ANNA.id], LENA.id, 0, false]);
    // Lena ticks it off: tomorrow's task is Marc's
    const d1 = await h.ok(LENA, 'POST', `tasks/${made.task.id}/complete`, { done: true });
    assert.deepEqual([d1.task.done, d1.task.doneBy.id, d1.next.assignee.id, d1.next.turn, d1.next.due.date], [true, LENA.id, MARC.id, 'rotate', '2026-11-09']);
    // Marc leaves the list: Anna is next, and a turn of one person is no turn
    await h.ok(ANNA, 'PUT', `lists/${l.id}/members`, { members: [{ id: LENA.id, role: 'write' }] });
    const t2 = await task(h, ANNA, d1.next.id);
    assert.deepEqual([t2.turn, t2.people.map((u) => u.id), t2.assignee.id], ['rotate', [LENA.id, ANNA.id], LENA.id]);
    assert.equal((await h.ok(LENA, 'POST', `tasks/${t2.id}/complete`, { done: true })).next.assignee.id, ANNA.id);
    await h.ok(LENA, 'POST', `tasks/${t2.id}/complete`, { done: false });
    // refusals: an unknown turn, one person, somebody who is no member
    assert.equal((await h.call(ANNA, 'POST', 'tasks', { title: 'x', listId: l.id, turn: 'each', people: [ANNA.id, LENA.id] })).json.field, 'turn');
    assert.equal((await h.call(ANNA, 'POST', 'tasks', { title: 'x', listId: l.id, turn: 'rotate', people: [ANNA.id] })).json.field, 'people');
    assert.deepEqual([(await h.call(ANNA, 'POST', 'tasks', { title: 'x', listId: l.id, turn: 'rotate', people: [ANNA.id, BOB.id] })).json.code], ['not_member']);
    // back to one person; stars are for the family list only
    const one = (await h.ok(ANNA, 'PATCH', `tasks/${t2.id}`, { turn: null })).task;
    assert.deepEqual([one.turn, one.people, one.assignee && one.assignee.id], [null, [], t2.assignee.id]);
    assert.deepEqual((await h.call(ANNA, 'PATCH', `tasks/${t2.id}`, { stars: 2 })).json, { ok: false, code: 'invalid', field: 'stars', reason: 'family' });
  } finally { await done(h); }
});

test('whoever is first: everybody is reminded, the first one ticks it off for all, the others hear of it', async () => {
  const h = await host();
  try {
    const l = await shared(h);
    const made = await h.ok(ANNA, 'POST', 'tasks', { text: '@Marc @Lena Blumen gießen heute 11 Uhr wer zuerst', listId: l.id });
    assert.deepEqual([made.task.title, made.task.turn, made.task.people.map((u) => u.id), made.task.assignee, made.parsed.turn], ['Blumen gießen', 'first', [MARC.id, LENA.id], null, 'first']);
    assert.deepEqual(pushes(h, 'assigned').map((n) => n.users).flat().sort(), [MARC.id, LENA.id]);
    assert.deepEqual([(await task(h, MARC, made.task.id)).reminder.mine, (await task(h, ANNA, made.task.id)).reminder.mine], [true, false]);
    clock.set(T0 + 61 * MIN);
    await h.host.tick();
    const rem = pushes(h, 'reminder');
    assert.deepEqual(rem.map((n) => n.users.slice().sort()), [[MARC.id, LENA.id]]);
    assert.equal((await h.ok(LENA, 'GET', 'reminders')).reminders.length, 0);
    // Lena ticks it off: done for all, Marc's reminder is replaced
    const d = await h.ok(LENA, 'POST', `tasks/${made.task.id}/complete`, { done: true });
    assert.deepEqual([d.task.done, d.task.doneBy.id], [true, LENA.id]);
    const gone = pushes(h, 'reminder_done');
    assert.deepEqual([gone.length, gone[0].users, gone[0].body, gone[0].collapseKey], [1, [MARC.id], 'Erledigt von Lena', 'task:' + made.task.id]);
    assert.equal((await task(h, MARC, made.task.id)).done, true);
  } finally { await done(h); }
});

test('the family list: Familie says who the family is; parents and children; nothing of it without Familie', async () => {
  const h = await host({ sources: familie() });
  try {
    assert.deepEqual(await svc(h, 'tasks_bind', { members: [ANNA.id], parents: [ANNA.id] }, 'gatecontrol-mail'), { ok: false, code: 'forbidden' });
    assert.deepEqual(await svc(h, 'tasks_put', { tasks: [] }), { ok: false, code: 'not_found' });
    const b = await bindFam(h, { moved: { at: T0, by: ANNA.id, tasks: 3, places: 1 } });
    assert.equal(b.ok, true);
    const me = await h.ok(LENA, 'GET', 'me');
    assert.deepEqual(me.familyTasks, { available: true, bound: true, listId: b.listId, parent: false, stars: true, starsMax: 10, moved: { at: '2026-11-08T09:00:00Z', tasks: 3, places: 1, seen: false } });
    await h.ok(LENA, 'POST', 'family/seen', {});
    assert.equal((await h.ok(LENA, 'GET', 'me')).familyTasks.moved.seen, true);
    assert.equal((await h.ok(BOB, 'GET', 'me')).familyTasks.bound, false);
    const lists = (await h.ok(LENA, 'GET', 'lists')).lists;
    const fl = lists.find((x) => x.id === b.listId);
    assert.deepEqual([fl.name, fl.family, fl.owner.id, fl.role, fl.members.map((m) => m.id).sort()], ['Familie', true, ANNA.id, 'write', [MARC.id, LENA.id]]);
    // the family's list is Familie's: not deleted, not shared with others here
    assert.deepEqual((await h.call(ANNA, 'DELETE', `lists/${b.listId}`)).json, { ok: false, code: 'forbidden', reason: 'family' });
    assert.deepEqual((await h.call(ANNA, 'PUT', `lists/${b.listId}/members`, { members: [{ id: BOB.id, role: 'write' }] })).json, { ok: false, code: 'forbidden', reason: 'family' });
    // a parent's task with stars; the child neither changes nor deletes it, gives no stars, but makes tasks of its own
    const t1 = (await h.ok(ANNA, 'POST', 'tasks', { text: '@Lena Zimmer aufräumen 2 Sterne', listId: b.listId })).task;
    assert.deepEqual([t1.title, t1.stars, t1.assignee.id, t1.family, t1.canEdit], ['Zimmer aufräumen', 2, LENA.id, true, true]);
    const seen = await task(h, LENA, t1.id);
    assert.deepEqual([seen.canEdit, seen.canComplete], [false, true]);
    for (const r of [await h.call(LENA, 'PATCH', `tasks/${t1.id}`, { title: 'nix' }), await h.call(LENA, 'DELETE', `tasks/${t1.id}`), await h.call(LENA, 'POST', 'tasks', { title: 'Teil', parentId: t1.id })]) {
      assert.deepEqual(r.json, { ok: false, code: 'forbidden', reason: 'parents_only' });
    }
    await h.ok(LENA, 'PATCH', `tasks/${t1.id}`, { myDay: true });
    const own = (await h.ok(LENA, 'POST', 'tasks', { text: 'Fahrrad putzen 3 Sterne', listId: b.listId })).task;
    assert.deepEqual([own.title, own.stars, own.canEdit], ['Fahrrad putzen 3 Sterne', 0, true]);
    assert.deepEqual((await h.call(LENA, 'PATCH', `tasks/${own.id}`, { stars: 1 })).json, { ok: false, code: 'forbidden', reason: 'parents_only' });
    // a task for Marc is not Lena's to tick off
    const t2 = (await h.ok(ANNA, 'POST', 'tasks', { title: 'Auto waschen', listId: b.listId, assigneeId: MARC.id })).task;
    assert.equal((await task(h, LENA, t2.id)).canComplete, false);
    assert.equal((await h.call(LENA, 'POST', `tasks/${t2.id}/complete`, { done: true })).status, 403);
    // who left the family leaves its list; Familie going lets the list be an ordinary one
    await svc(h, 'tasks_bind', { members: [ANNA.id, LENA.id], parents: [ANNA.id], stars: false });
    assert.equal((await h.call(MARC, 'GET', `tasks/${t2.id}`)).status, 404);
    assert.equal((await task(h, ANNA, t2.id)).assignee, null);
    // (its tasks stay too: Familie never fetched them — what it keeps a copy of would go to the trash, see test/taskmove.test.js of Familie)
    assert.deepEqual(await svc(h, 'tasks_bind', { release: true }), { ok: true, released: true, trashed: 0 });
    assert.equal((await h.ok(ANNA, 'GET', 'lists')).lists.find((x) => x.id === b.listId).family, false);
    assert.equal((await task(h, LENA, t1.id)).canEdit, true);
    // … and coming back takes the same list again
    assert.equal((await bindFam(h)).listId, b.listId);
  } finally { await done(h); }
});

test('ticked off in the family list: written down for Familie (the stars), the parents hear of it, „Noch nicht fertig“ takes it back', async () => {
  const h = await host({ sources: familie() });
  try {
    const b = await bindFam(h);
    const t1 = (await h.ok(ANNA, 'POST', 'tasks', { title: 'Zimmer aufräumen', listId: b.listId, assigneeId: LENA.id, stars: 2, due: { date: '2026-11-08' } })).task;
    await famtasks.tell(h.host.gc);
    const before = told(h);
    clock.set(T0 + 5 * MIN);
    await h.ok(LENA, 'POST', `tasks/${t1.id}/complete`, { done: true });
    await famtasks.tell(h.host.gc);
    assert.equal(told(h), before + 1);
    let l = await svc(h, 'tasks_list', { rev: 0 });
    assert.deepEqual(l.done.map((d) => [d.uid, d.userId, d.by, d.dueDate, d.stars, d.undone]), [['h' + t1.id, LENA.id, LENA.id, '2026-11-08', 2, false]]);
    assert.deepEqual(l.tasks.map((x) => [x.uid, x.title, x.done, x.doneFor, x.stars, x.assignee]), [['h' + t1.id, 'Zimmer aufräumen', true, LENA.id, 2, LENA.id]]);
    // both parents get the feedback (Anna did not tick it off herself)
    const fb = pushes(h, 'done_feedback');
    assert.deepEqual([fb.length, fb[0].users.slice().sort(), fb[0].title, fb[0].body], [1, [ANNA.id, MARC.id], 'Lena hat „Zimmer aufräumen“ erledigt', '2 Sterne gutgeschrieben · Familie']);
    assert.deepEqual(fb[0].data.actions.map((a) => [a.type, a.id]), [['open_app_route', 'open'], ['callback', 'not_done']]);
    // a child cannot take it back with the push; a parent can: open again, the row for Familie says undone, Lena hears of it
    assert.deepEqual(await h.press(LENA, fb[0], 'not_done'), { ok: false, code: 'forbidden' });
    assert.deepEqual(await h.press(MARC, fb[0], 'not_done'), { ok: true, undone: true });
    assert.deepEqual(await h.press(MARC, fb[0], 'not_done'), { ok: true, undone: false });
    assert.equal((await task(h, LENA, t1.id)).done, false);
    l = await svc(h, 'tasks_list', { rev: l.rev });
    assert.deepEqual(l.done.map((d) => [d.uid, d.userId, d.undone]), [['h' + t1.id, LENA.id, true]]);
    const back = h.host.notifications.filter((n) => n.title === 'Marc Berg: noch nicht fertig');
    assert.deepEqual([back.length, back[0].users], [1, [LENA.id]]);
    assert.deepEqual((await svc(h, 'tasks_list', { rev: l.rev })).done, []);
    // a parent ticks it off for the child (the stars are the child's); „only with stars“ and „never“ keep the push back
    await h.ok(MARC, 'PUT', 'prefs', { feedback: 'off' });
    await h.ok(ANNA, 'PUT', 'prefs', { feedback: 'stars' });
    const d = await h.ok(MARC, 'POST', `tasks/${t1.id}/complete`, { done: true });
    assert.deepEqual([d.task.doneBy.id, pushes(h, 'done_feedback').length, pushes(h, 'done_feedback')[1].users], [LENA.id, 2, [ANNA.id]]);
    l = await svc(h, 'tasks_list', { rev: l.rev });
    assert.deepEqual(l.done.map((x) => [x.userId, x.by, x.stars]), [[LENA.id, MARC.id, 2]]);
    const t2 = (await h.ok(ANNA, 'POST', 'tasks', { title: 'Tisch decken', listId: b.listId, assigneeId: LENA.id })).task;
    await h.ok(LENA, 'POST', `tasks/${t2.id}/complete`, { done: true });
    assert.equal(pushes(h, 'done_feedback').length, 2);
    // a child names nobody else; outside the family nobody is credited
    const t3 = (await h.ok(ANNA, 'POST', 'tasks', { title: 'Müll', listId: b.listId })).task;
    assert.deepEqual((await h.call(LENA, 'POST', `tasks/${t3.id}/complete`, { done: true, userId: ANNA.id })).json, { ok: false, code: 'forbidden', reason: 'parents_only' });
    assert.equal((await h.call(ANNA, 'POST', `tasks/${t3.id}/complete`, { done: true, userId: BOB.id })).json.field, 'userId');
  } finally { await done(h); }
});

const FT = (uid, extra = {}) => ({ uid, kind: 'task', title: 'Aufgabe ' + uid, turn: null, people: [LENA.id], assignee: LENA.id, due: { date: '2026-11-08', time: null }, repeat: null, stars: 0, remind: true, done: false, createdBy: ANNA.id, createdAt: T0 - DAY, ...extra });

test('tasks_put: rows of Familie by their uid — nothing twice, written when they differ, ticked off there', async () => {
  const h = await host({ sources: familie() });
  try {
    const b = await bindFam(h);
    const rows = [
      FT('f1', { title: 'Zimmer aufräumen', stars: 2, due: { date: '2026-11-08', time: '17:00' } }),
      FT('f2', { title: 'Spülmaschine', turn: 'rotate', people: [LENA.id, MARC.id], assignee: MARC.id, repeat: { type: 'daily' }, due: { date: '2026-11-08', time: '18:00' } }),
      FT('f3', { title: 'Blumen gießen', turn: 'first', people: [ANNA.id, MARC.id, LENA.id], assignee: null, repeat: { type: 'weekly', days: [7] } }),
      FT('f4', { title: 'Altpapier', done: true, doneBy: LENA.id, doneFor: LENA.id, doneAt: T0 - 3600000 }),
      FT('f5', { title: 'Täglich, heute schon erledigt', repeat: { type: 'daily' }, done: true, doneBy: LENA.id, doneFor: LENA.id }),
      { uid: 'x9', title: 'kaputt' },
    ];
    const r1 = await svc(h, 'tasks_put', { tasks: rows });
    assert.deepEqual([r1.ok, r1.written, r1.rejected], [true, 5, [{ uid: 'x9', code: 'invalid' }]]);
    // again: nothing is written, nothing is there twice; nothing was told back to Familie
    const r2 = await svc(h, 'tasks_put', { tasks: rows.slice(0, 5) });
    assert.deepEqual([r2.written, r2.tasks.map((x) => x.id)], [0, r1.tasks.map((x) => x.id)]);
    await famtasks.tell(h.host.gc);
    assert.equal(told(h), 0);
    const view = (await h.ok(LENA, 'GET', `views/list:${b.listId}`));
    assert.equal(view.sections.flatMap((s) => s.items).filter((x) => !x.done).length, 4);
    const ids = Object.fromEntries(r1.tasks.map((x) => [x.uid, x.id]));
    const t1 = await task(h, LENA, ids.f1);
    assert.deepEqual([t1.title, t1.stars, t1.assignee.id, t1.due, t1.reminder && t1.reminder.at, t1.canEdit, t1.family], ['Zimmer aufräumen', 2, LENA.id, { date: '2026-11-08', time: '17:00' }, '2026-11-08T17:00:00+01:00', false, true]);
    const t2 = await task(h, MARC, ids.f2);
    assert.deepEqual([t2.turn, t2.people.map((u) => u.id), t2.assignee.id, t2.repeat.type], ['rotate', [LENA.id, MARC.id], MARC.id, 'daily']);
    assert.deepEqual([(await task(h, ANNA, ids.f3)).turn, (await task(h, ANNA, ids.f4)).done, (await task(h, ANNA, ids.f4)).doneBy.id], ['first', true, LENA.id]);
    // a repeating task whose occurrence was done already starts with its next one
    assert.deepEqual([(await task(h, ANNA, ids.f5)).done, (await task(h, ANNA, ids.f5)).due.date], [false, '2026-11-09']);
    // changed in Familie: the title, the time; ticked off there (Familie's turn went on to Lena already)
    clock.set(T0 + 10 * MIN);
    const r3 = await svc(h, 'tasks_put', { tasks: [FT('f1', { title: 'Zimmer gründlich aufräumen', stars: 2, due: { date: '2026-11-08', time: '16:00' } }),
      { ...rows[1], assignee: LENA.id, done: true, doneBy: ANNA.id, doneFor: MARC.id, doneAt: T0 + 9 * MIN }] });
    assert.deepEqual([r3.written, r3.rejected], [2, []]);
    const t1b = await task(h, LENA, ids.f1);
    assert.deepEqual([t1b.title, t1b.due.time, t1b.reminder.at], ['Zimmer gründlich aufräumen', '16:00', '2026-11-08T16:00:00+01:00']);
    const old = await task(h, MARC, ids.f2);
    assert.deepEqual([old.done, old.doneBy.id, old.assignee.id], [true, MARC.id, MARC.id]);
    let l = await svc(h, 'tasks_list', { rev: 0 });
    const f2 = l.tasks.find((x) => x.uid === 'f2');
    assert.deepEqual([f2.done, f2.assignee, f2.due, f2.id !== ids.f2], [false, LENA.id, { date: '2026-11-09', time: '18:00' }, true]);
    // what Familie reported is not written down for Familie again, and the parents get no push for it
    assert.deepEqual([l.done, pushes(h, 'done_feedback').length], [[], 0]);
    // the same row once more (Familie's occurrence is still today's): the hub is past it — nothing is ticked off twice
    assert.equal((await svc(h, 'tasks_put', { tasks: [{ ...rows[1], assignee: LENA.id, done: true, doneBy: ANNA.id, doneFor: MARC.id }] })).written, 0);
    assert.equal((await task(h, LENA, f2.id)).done, false);
    // deleted in Familie: in the trash here; every task Familie keeps a copy of is listed, a deleted one is missing
    await svc(h, 'tasks_put', { tasks: [{ uid: 'f3', deleted: true }] });
    assert.equal((await h.call(ANNA, 'GET', `tasks/${ids.f3}`)).status, 404);
    const mine = (await h.ok(ANNA, 'POST', 'tasks', { title: 'Hier angelegt', listId: b.listId })).task;
    l = await svc(h, 'tasks_list', { rev: 0 });
    assert.deepEqual(l.tasks.map((x) => x.uid).sort(), ['f1', 'f2', 'f4', 'f5', 'h' + mine.id].sort());
    // … in pages when there are many
    const many = [];
    for (let i = 0; i < 50; i++) many.push(FT('f' + (100 + i), { title: 'Viele Aufgaben Nummer ' + i + ' mit einem langen Titel, damit die Seite voll wird '.repeat(2) }));
    await svc(h, 'tasks_put', { tasks: many });
    const seenUids = new Set();
    let cursor = null;
    let pages = 0;
    do {
      const page = await svc(h, 'tasks_list', { rev: 0, ...(cursor ? { cursor } : {}) });
      assert.ok(JSON.stringify(page).length < 16000);
      for (const x of page.tasks) seenUids.add(x.uid);
      cursor = page.cursor;
      pages++;
    } while (cursor && pages < 20);
    assert.ok(pages > 1 && seenUids.size === 55, `${pages} pages, ${seenUids.size} tasks`);
    assert.equal((await svc(h, 'tasks_put', { tasks: new Array(51).fill(FT('f1')) })).code, 'invalid');
  } finally { await done(h); }
});

test('tasks_put: a place reminder of Familie — the owner\'s own list or one the two share, consent kept, nobody is asked again', async () => {
  const h = await host({ sources: familie() });
  try {
    const b = await bindFam(h);
    const place = (owner, target, extra = {}) => ({ owner, target, lat: 52.52, lon: 13.405, radius: 200, trigger: 'enter', consent: 'accepted', ...extra });
    const r = await svc(h, 'tasks_put', { tasks: [
      { uid: 'p1', kind: 'place', title: 'Paket abholen', note: 'Abholschein nicht vergessen', createdBy: ANNA.id, place: place(ANNA.id, ANNA.id) },
      { uid: 'p2', kind: 'place', title: 'Milch mitbringen', createdBy: ANNA.id, place: place(ANNA.id, MARC.id, { consent: 'pending', trigger: 'exit' }) },
      { uid: 'p3', kind: 'place', title: 'Angenommen', createdBy: MARC.id, place: place(MARC.id, ANNA.id) },
      { uid: 'p4', kind: 'place', title: 'ohne Ort', createdBy: ANNA.id },
    ] });
    assert.deepEqual([r.written, r.rejected], [3, [{ uid: 'p4', code: 'invalid' }]]);
    const ids = Object.fromEntries(r.tasks.map((x) => [x.uid, x.id]));
    // Anna's own: in her list „Aufgaben“, watched by her phone at once
    const t1 = await task(h, ANNA, ids.p1);
    assert.deepEqual([t1.list.name, t1.family, t1.note, t1.place.mode, t1.place.lat, t1.place.radius, t1.place.trigger, t1.place.consent, t1.place.watch, t1.place.mine, t1.place.canConsent, t1.place.own],
      ['Aufgaben', false, 'Abholschein nicht vergessen', 'place', 52.52, 200, 'enter', 'accepted', true, true, false, false]);
    assert.equal((await h.call(LENA, 'GET', `tasks/${ids.p1}`)).status, 404);
    // for Marc: a list only the two see; his answer is still open — and nobody got a second question
    const t2 = await task(h, MARC, ids.p2);
    assert.deepEqual([t2.list.name, t2.assignee.id, t2.place.trigger, t2.place.consent, t2.place.watch, t2.place.mine, t2.place.canConsent, t2.place.by], ['Erinnerungen Anna & Marc', MARC.id, 'exit', 'pending', false, true, true, ANNA.id]);
    const asAnna = await task(h, ANNA, ids.p2);
    assert.deepEqual([asAnna.place.mine, asAnna.place.canConsent], [false, false]);
    assert.equal((await h.call(LENA, 'GET', `tasks/${ids.p2}`)).status, 404);
    assert.equal(pushes(h, 'place_consent').length, 0);
    assert.equal((await task(h, ANNA, ids.p3)).list.name, 'Erinnerungen Anna & Marc');
    assert.equal((await h.ok(ANNA, 'GET', 'lists')).lists.filter((x) => x.name === 'Erinnerungen Anna & Marc').length, 1);
    // the phones: Anna's watches p1 and p3, Marc's nothing yet; he agrees here — Familie hears of it and of nothing else
    const fences = async (u) => (await h.ok(u, 'POST', 'places/watch', {})).fences.flatMap((f) => f.tasks.map((x) => x.taskId)).sort();
    assert.deepEqual([await fences(ANNA), await fences(MARC)], [[ids.p1, ids.p3].sort(), []]);
    await h.ok(MARC, 'POST', `tasks/${ids.p2}/place/consent`, { accept: true });
    assert.deepEqual(await fences(MARC), [ids.p2]);
    const l = await svc(h, 'tasks_list', { rev: 0 });
    assert.deepEqual(l.tasks.map((x) => [x.uid, x.kind, x.consent, x.done]), [['p1', 'place', 'accepted', false], ['p2', 'place', 'accepted', false], ['p3', 'place', 'accepted', false]]);
    assert.deepEqual(l.done, []);
    // again: nothing changes; done in Familie (it fired once): ticked off here; a new place: the same task, another spot
    assert.equal((await svc(h, 'tasks_put', { tasks: [{ uid: 'p1', kind: 'place', title: 'Paket abholen', note: 'Abholschein nicht vergessen', createdBy: ANNA.id, place: place(ANNA.id, ANNA.id) }] })).written, 0);
    await svc(h, 'tasks_put', { tasks: [{ uid: 'p1', kind: 'place', title: 'Paket abholen', note: 'Abholschein nicht vergessen', createdBy: ANNA.id, place: place(ANNA.id, ANNA.id, { lat: 48.1 }), done: true, doneBy: ANNA.id }] });
    const t1b = await task(h, ANNA, ids.p1);
    assert.deepEqual([t1b.done, t1b.place.lat], [true, 48.1]);
    assert.equal(b.ok, true);
  } finally { await done(h); }
});
