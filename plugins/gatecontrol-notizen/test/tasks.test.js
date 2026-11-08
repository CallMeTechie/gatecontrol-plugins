'use strict';

// Own tasks: lists and groups, the quick entry on the server, sub tasks, „Mein Tag“, the smart lists, repeat rules on
// completion, sharing and assigning (with pushes), reminders as pushes, the trash, the areas Privat / Arbeit.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC, LENA, BOB, clock, T0 } = require('./helpers');

const sec = (v, id) => v.sections.find((s) => s.id === id).items;
const titles = (v, id) => sec(v, id).map((x) => x.title);

test('lists, groups and the quick entry', async () => {
  const h = await withHost();
  try {
    const g = await h.ok(ANNA, 'POST', 'groups', { name: 'Zuhause', area: 'private' });
    const l = await h.ok(ANNA, 'POST', 'lists', { name: 'Haus & Garten', area: 'private', groupId: g.group.id, color: 'green' });
    assert.equal(l.list.groupId, g.group.id);
    await h.ok(ANNA, 'POST', 'lists', { name: 'Büro', area: 'work' });
    const t = await h.ok(ANNA, 'POST', 'tasks', { text: 'Hecke schneiden morgen #haus @marc', area: 'private' });
    assert.equal(t.task.listId, l.list.id);
    assert.equal(t.task.assignee, null, 'Marc is not in the list: no person');
    const t2 = await h.ok(ANNA, 'POST', 'tasks', { text: 'Fr 10 Uhr Angebot nachfassen #büro', area: 'work' });
    assert.deepEqual(t2.task.due, { date: '2026-11-13', time: '10:00' });
    assert.ok(t2.task.remindAt.startsWith('2026-11-13T10:00:00+01:00'));
    const t3 = await h.ok(ANNA, 'POST', 'tasks', { text: 'Ölwechsel #auto', area: 'private', createList: true });
    const nav = await h.ok(ANNA, 'GET', 'nav', null, { area: 'private' });
    assert.ok(nav.lists.some((x) => x.name === 'auto' && x.id === t3.task.listId));
    assert.ok(!nav.lists.some((x) => x.name === 'Büro'), 'work lists are not in the private area');
    const parsed = await h.ok(ANNA, 'POST', 'parse', { text: 'jeden Montag Rasen mähen' });
    assert.deepEqual(parsed.parsed.repeat, { type: 'weekly', interval: 1, days: [1] });
    // the default list cannot be deleted, others can; only the owner
    const def = nav.lists.find((x) => x.isDefault);
    assert.equal((await h.call(ANNA, 'DELETE', 'lists/' + def.id)).status, 403);
    assert.equal((await h.call(MARC, 'DELETE', 'lists/' + l.list.id)).status, 404);
    await h.ok(ANNA, 'DELETE', 'lists/' + l.list.id);
    assert.equal((await h.call(ANNA, 'GET', 'tasks/' + t.task.id)).status, 404);
  } finally { await h.close(); }
});

test('Mein Tag, Wichtig, Geplant, Mir zugewiesen; sub tasks; done today', async () => {
  const h = await withHost();
  try {
    const a = await h.ok(ANNA, 'POST', 'tasks', { title: 'Zahnarzt anrufen', due: { date: '2026-11-08', time: '09:00' }, important: true });
    await h.ok(ANNA, 'POST', 'tasks', { title: 'Rechnung', due: { date: '2026-11-07' } });
    const c = await h.ok(ANNA, 'POST', 'tasks', { title: 'Winterreifen-Termin ausmachen', myDay: true });
    await h.ok(ANNA, 'POST', 'tasks', { title: 'Steuer', due: { date: '2026-11-16' } });
    await h.ok(ANNA, 'POST', 'tasks', { title: 'Irgendwann' });
    for (const s of ['Händler anrufen', 'Termin eintragen', 'Reifen holen']) await h.ok(ANNA, 'POST', 'tasks', { parentId: c.task.id, title: s });
    const subs = (await h.ok(ANNA, 'GET', 'tasks/' + c.task.id)).task.subtasks;
    await h.ok(ANNA, 'POST', `tasks/${subs[0].id}/complete`, { done: true });
    let v = await h.ok(ANNA, 'GET', 'views/myday', null, { area: 'private' });
    // the 9:00 call is overdue at 10:00 already
    assert.deepEqual(titles(v, 'overdue'), ['Rechnung', 'Zahnarzt anrufen']);
    assert.deepEqual(titles(v, 'today'), ['Winterreifen-Termin ausmachen']);
    assert.deepEqual(sec(v, 'today').find((x) => x.id === c.task.id).progress, { done: 1, total: 3 });
    assert.deepEqual(titles(v, 'upcoming'), ['Steuer']);
    assert.deepEqual(titles(await h.ok(ANNA, 'GET', 'views/important'), 'important'), ['Zahnarzt anrufen']);
    const p = await h.ok(ANNA, 'GET', 'views/planned');
    assert.deepEqual(p.sections.map((s) => [s.id, s.items.length]), [['overdue', 2], ['today', 0], ['tomorrow', 0], ['week', 0], ['later', 1]]);
    await h.ok(ANNA, 'POST', `tasks/${a.task.id}/complete`, { done: true });
    v = await h.ok(ANNA, 'GET', 'views/myday', null, { area: 'private' });
    assert.deepEqual(titles(v, 'done'), ['Zahnarzt anrufen']);
    const nav = await h.ok(ANNA, 'GET', 'nav', null, { area: 'private' });
    assert.equal(nav.smart.myday, 2, 'Rechnung, Winterreifen');
    assert.equal(nav.smart.important, 0);
    // taking it out of Mein Tag
    await h.ok(ANNA, 'PATCH', 'tasks/' + c.task.id, { myDay: false });
    v = await h.ok(ANNA, 'GET', 'views/myday', null, { area: 'private' });
    assert.ok(!titles(v, 'today').includes('Winterreifen-Termin ausmachen'));
    // the trash, purged after 30 days
    await h.ok(ANNA, 'DELETE', 'tasks/' + c.task.id);
    clock.advance(31 * 86400000);
    await h.host.tick();
    const n = await require('../server/store').one(h.host.gc, 'SELECT COUNT(*) AS n FROM tasks WHERE id = ? OR parent_id = ?', [c.task.id, c.task.id]);
    assert.equal(n.n, 0);
  } finally { await h.close(); clock.set(T0); }
});

test('repeat: completing gives the next one (sub tasks unticked, reminder moved), after completion counts from that day', async () => {
  const h = await withHost();
  try {
    const t = await h.ok(ANNA, 'POST', 'tasks', { title: 'Rasen mähen', due: { date: '2026-11-09' }, repeat: { type: 'weekly', interval: 1, days: [1] }, remindAt: '2026-11-09T08:00:00+01:00' });
    await h.ok(ANNA, 'POST', 'tasks', { parentId: t.task.id, title: 'Benzin' });
    const done = await h.ok(ANNA, 'POST', `tasks/${t.task.id}/complete`, { done: true });
    assert.deepEqual(done.next.due, { date: '2026-11-16', time: null });
    assert.ok(done.next.remindAt.startsWith('2026-11-16T08:00:00+01:00'));
    assert.deepEqual(done.next.subtasks.map((s) => [s.title, s.done]), [['Benzin', false]]);
    assert.equal(done.task.repeat, null, 'the done one keeps no rule');
    const f = await h.ok(ANNA, 'POST', 'tasks', { title: 'Filter', due: { date: '2026-11-01' }, repeat: { type: 'after', interval: 3 } });
    const n2 = await h.ok(ANNA, 'POST', `tasks/${f.task.id}/complete`, { done: true });
    assert.equal(n2.next.due.date, '2026-11-11');
    assert.equal(n2.next.repeatText, '3 Tage nach Erledigung');
    const m = await h.ok(ANNA, 'POST', 'tasks', { title: 'Miete', due: { date: '2026-01-31' }, repeat: { type: 'monthly', interval: 1 } });
    assert.deepEqual(m.task.repeat, { type: 'monthly', interval: 1, day: 31 });
    assert.equal((await h.call(ANNA, 'POST', 'tasks', { title: 'x', repeat: { type: 'hourly' } })).status, 400);
  } finally { await h.close(); }
});

test('sharing a list: members see and change its tasks, assigning pushes, leaving takes the assignment', async () => {
  const h = await withHost();
  try {
    const l = await h.ok(ANNA, 'POST', 'lists', { name: 'Haus & Garten' });
    await h.ok(ANNA, 'PUT', `lists/${l.list.id}/members`, { members: [MARC.id] });
    assert.ok(h.host.notifications.some((n) => n.topic === 'shared' && n.users.includes(MARC.id)));
    const t = await h.ok(MARC, 'POST', 'tasks', { title: 'Hecke schneiden', listId: l.list.id, assigneeId: ANNA.id });
    assert.ok(h.host.notifications.some((n) => n.topic === 'shared' && n.users.includes(ANNA.id) && n.body === 'Hecke schneiden'));
    assert.deepEqual(titles(await h.ok(ANNA, 'GET', 'views/assigned'), 'assigned'), ['Hecke schneiden']);
    assert.equal((await h.call(BOB, 'GET', 'tasks/' + t.task.id)).status, 404);
    assert.equal((await h.call(ANNA, 'PATCH', 'tasks/' + t.task.id, { assigneeId: BOB.id })).status, 409, 'not a member');
    // the setting „Familie und Team“ / „Niemandem“
    await h.host.saveSettings({ sharing: 'off' });
    assert.equal((await h.call(ANNA, 'PUT', `lists/${l.list.id}/members`, { members: [MARC.id, LENA.id] })).status, 403);
    await h.ok(ANNA, 'PATCH', 'tasks/' + t.task.id, { assigneeId: MARC.id });
    await h.ok(MARC, 'DELETE', 'lists/' + l.list.id);
    assert.equal((await h.ok(ANNA, 'GET', 'tasks/' + t.task.id)).task.assignee, null);
    assert.equal((await h.call(MARC, 'GET', 'tasks/' + t.task.id)).status, 404);
  } finally { await h.close(); }
});

test('reminders: a push at the time to the person (assignee first), once; a late one is dropped', async () => {
  const h = await withHost();
  try {
    await h.ok(ANNA, 'POST', 'tasks', { title: 'Zahnarzt anrufen', due: { date: '2026-11-08', time: '14:00' }, remindAt: { date: '2026-11-08', time: '14:00' }, important: true });
    await h.ok(ANNA, 'POST', 'tasks', { title: 'Uralt', remindAt: '2026-11-08T01:00:00+01:00' });
    await h.host.tick();
    assert.equal(h.host.notifications.filter((n) => n.topic === 'reminders').length, 0, 'too late (9 h) and not yet');
    clock.set(Date.parse('2026-11-08T13:00:30Z'));
    await h.host.tick();
    await h.host.tick();
    const r = h.host.notifications.filter((n) => n.topic === 'reminders');
    assert.equal(r.length, 1);
    assert.deepEqual([r[0].title, r[0].users, r[0].priority], ['Zahnarzt anrufen', [ANNA.id], 'high']);
    assert.match(r[0].body, /fällig heute 14:00/);
  } finally { await h.close(); clock.set(T0); }
});

test('read-only portal viewers, kiosk devices and strangers', async () => {
  const h = await withHost();
  try {
    const r = await h.host.request({ method: 'POST', path: 'tasks', body: { title: 'x' }, user: { ...ANNA, portal: true, loggedIn: false } });
    assert.equal(r.status, 403);
    const g = await h.host.request({ method: 'GET', path: 'me', user: { ...ANNA, portal: true, loggedIn: false } });
    assert.equal(g.json.readOnly, true);
    const k = await h.host.request({ method: 'GET', path: 'me', user: { ...ANNA, portal: true, loggedIn: true, kiosk: true } });
    assert.equal(k.status, 403);
    assert.equal((await h.call(ANNA, 'GET', 'nope')).status, 404);
    assert.equal(await h.host.portalVisible({ ...ANNA, kiosk: true }), false);
    const tiles = await h.host.portalTiles({ ...ANNA, loggedIn: true });
    assert.equal(tiles[0].title, 'Mein Tag');
  } finally { await h.close(); }
});
