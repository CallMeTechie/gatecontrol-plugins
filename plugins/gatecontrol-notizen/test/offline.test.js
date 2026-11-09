'use strict';

// 1.1.0 — creates and changes made on a device without a connection, sent later (perhaps twice, perhaps a child before
// its parent): clientId on every create, `base` on PATCH tasks / lists / notebooks, `rev` on PATCH notes, deletes that
// may come twice, and what the pushes carry to open their page.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC, BOB, clock, T0 } = require('./helpers');
const store = require('../server/store');

const CID = (n) => `c0ffee00-0000-4000-8000-${String(n).padStart(12, '0')}`;
const count = async (h, sql, args) => (await store.one(h.host.gc, sql, args || [])).n;

test('me advertises offlineEdits and pushTargets', async () => {
  const h = await withHost();
  try {
    const me = await h.ok(ANNA, 'GET', 'me');
    assert.ok(me.features.includes('offlineEdits'));
    assert.ok(me.features.includes('pushTargets'));
  } finally { await h.close(); }
});

test('a create sent twice with the same clientId makes one object (tasks, sub tasks, lists, groups, notebooks, notes)', async () => {
  const h = await withHost();
  try {
    const l1 = await h.ok(ANNA, 'POST', 'lists', { name: 'Urlaub', area: 'private', clientId: CID(1) });
    const l2 = await h.ok(ANNA, 'POST', 'lists', { name: 'Urlaub', area: 'private', clientId: CID(1) });
    assert.equal(l1.clientId, CID(1));
    assert.equal(l2.list.id, l1.list.id);
    assert.equal(l2.replayed, true);
    assert.equal(await count(h, "SELECT COUNT(*) AS n FROM lists WHERE name = 'Urlaub'"), 1);

    const t1 = await h.ok(ANNA, 'POST', 'tasks', { title: 'Koffer packen', listId: l1.list.id, clientId: CID(2) });
    const t2 = await h.ok(ANNA, 'POST', 'tasks', { title: 'Koffer packen', listId: l1.list.id, clientId: CID(2) });
    assert.equal(t1.clientId, CID(2));
    assert.equal(t2.task.id, t1.task.id);
    const s1 = await h.ok(ANNA, 'POST', 'tasks', { title: 'Pass', parentId: t1.task.id, clientId: CID(3) });
    await h.ok(ANNA, 'POST', 'tasks', { title: 'Pass', parentId: t1.task.id, clientId: CID(3) });
    assert.deepEqual((await h.ok(ANNA, 'GET', 'tasks/' + t1.task.id)).task.subtasks.map((s) => s.id), [s1.task.id]);
    // the quick entry with a new list: the repeat makes neither a second task nor a second list
    await h.ok(ANNA, 'POST', 'tasks', { text: 'Ölwechsel #auto', createList: true, clientId: CID(4) });
    await h.ok(ANNA, 'POST', 'tasks', { text: 'Ölwechsel #auto', createList: true, clientId: CID(4) });
    assert.equal(await count(h, "SELECT COUNT(*) AS n FROM lists WHERE name = 'auto'"), 1);
    assert.equal(await count(h, "SELECT COUNT(*) AS n FROM tasks WHERE title = 'Ölwechsel'"), 1);

    const g1 = await h.ok(ANNA, 'POST', 'groups', { name: 'Reisen', area: 'private', clientId: CID(5) });
    const g2 = await h.ok(ANNA, 'POST', 'groups', { name: 'Reisen', area: 'private', clientId: CID(5) });
    assert.equal(g2.group.id, g1.group.id);

    const nb1 = await h.ok(ANNA, 'POST', 'notebooks', { name: 'Rezepte', area: 'private', clientId: CID(6) });
    const nb2 = await h.ok(ANNA, 'POST', 'notebooks', { name: 'Rezepte', area: 'private', clientId: CID(6) });
    assert.equal(nb2.notebook.id, nb1.notebook.id);
    const n1 = await h.ok(ANNA, 'POST', 'notes', { notebookId: nb1.notebook.id, title: 'Pizza', body: 'Teig #italien', clientId: CID(7) });
    const n2 = await h.ok(ANNA, 'POST', 'notes', { notebookId: nb1.notebook.id, title: 'Pizza', body: 'Teig #italien', clientId: CID(7) });
    assert.equal(n1.clientId, CID(7));
    assert.equal(n2.note.id, n1.note.id);
    assert.equal(n2.replayed, true);
    assert.equal(await count(h, "SELECT COUNT(*) AS n FROM notes WHERE title = 'Pizza'"), 1);
    assert.deepEqual((await h.ok(ANNA, 'GET', 'notebooks', null, { area: 'private' })).tags, [{ tag: 'italien', count: 1 }], 'the tag counted once');

    // the repeat answers with the object as it is now (changed meanwhile)
    await h.ok(ANNA, 'PATCH', 'tasks/' + t1.task.id, { title: 'Koffer packen!' });
    assert.equal((await h.ok(ANNA, 'POST', 'tasks', { title: 'Koffer packen', clientId: CID(2) })).task.title, 'Koffer packen!');
  } finally { await h.close(); }
});

test('two sends of the same create at once (an outbox and a retry) still make one', async () => {
  const h = await withHost();
  try {
    const rs = await Promise.all([1, 2, 3].map(() => h.call(ANNA, 'POST', 'tasks', { title: 'Einmal', clientId: CID(10) })));
    assert.deepEqual(rs.map((r) => r.status), [200, 200, 200]);
    assert.equal(new Set(rs.map((r) => r.json.task.id)).size, 1);
    assert.equal(await count(h, "SELECT COUNT(*) AS n FROM tasks WHERE title = 'Einmal'"), 1);
    const ns = await Promise.all([1, 2].map(() => h.call(ANNA, 'POST', 'notes', { title: 'Einmal', body: 'x', clientId: CID(11) })));
    assert.equal(new Set(ns.map((r) => r.json.note.id)).size, 1);
  } finally { await h.close(); }
});

test('out of order: a sub task or note before its parent is refused cleanly, then made once the parent is there', async () => {
  const h = await withHost();
  try {
    // the sub task of a task made offline arrives first
    const early = await h.call(ANNA, 'POST', 'tasks', { title: 'Pass', parentClientId: CID(21), clientId: CID(22) });
    assert.equal(early.status, 409);
    assert.deepEqual([early.json.code, early.json.field], ['unknown_client_id', 'parentClientId']);
    assert.equal(await count(h, "SELECT COUNT(*) AS n FROM tasks WHERE title = 'Pass'"), 0, 'nothing made');
    assert.equal(await count(h, 'SELECT COUNT(*) AS n FROM client_ids'), 0, 'its clientId not taken');
    const list = await h.ok(ANNA, 'POST', 'lists', { name: 'Reise', clientId: CID(20) });
    const parent = await h.ok(ANNA, 'POST', 'tasks', { title: 'Koffer', listClientId: CID(20), clientId: CID(21) });
    assert.equal(parent.task.listId, list.list.id, 'the list named by its clientId');
    const sub = await h.ok(ANNA, 'POST', 'tasks', { title: 'Pass', parentClientId: CID(21), clientId: CID(22) });
    assert.equal(sub.task.parentId, parent.task.id);
    // a note into a notebook made offline
    assert.equal((await h.call(ANNA, 'POST', 'notes', { title: 'x', notebookClientId: CID(23), clientId: CID(24) })).json.code, 'unknown_client_id');
    const nb = await h.ok(ANNA, 'POST', 'notebooks', { name: 'Neu', clientId: CID(23) });
    assert.equal((await h.ok(ANNA, 'POST', 'notes', { title: 'x', notebookClientId: CID(23), clientId: CID(24) })).note.notebookId, nb.notebook.id);
    // a clientId of a list given as a parent task: refused
    assert.equal((await h.call(ANNA, 'POST', 'tasks', { title: 'y', parentClientId: CID(20) })).json.code, 'unknown_client_id');
  } finally { await h.close(); }
});

test('a clientId is per person: another person never gets someone else’s object through it', async () => {
  const h = await withHost();
  try {
    const anna = await h.ok(ANNA, 'POST', 'tasks', { title: 'Geheim', clientId: CID(30) });
    const marc = await h.ok(MARC, 'POST', 'tasks', { title: 'Meins', clientId: CID(30) });
    assert.notEqual(marc.task.id, anna.task.id);
    assert.equal(marc.task.title, 'Meins');
    assert.notEqual(marc.replayed, true);
    assert.equal((await h.ok(ANNA, 'GET', 'tasks/' + anna.task.id)).task.title, 'Geheim');
    assert.equal((await h.call(MARC, 'GET', 'tasks/' + anna.task.id)).status, 404);
    // nor a list or notebook of someone else as a parent
    await h.ok(ANNA, 'POST', 'lists', { name: 'Annas', clientId: CID(31) });
    const r = await h.call(BOB, 'POST', 'tasks', { title: 'x', listClientId: CID(31) });
    assert.deepEqual([r.status, r.json.code], [409, 'unknown_client_id']);
    await h.ok(ANNA, 'POST', 'notebooks', { name: 'Annas', clientId: CID(32) });
    assert.equal((await h.call(BOB, 'POST', 'notes', { title: 'x', notebookClientId: CID(32) })).status, 409);
    // a clientId of one kind used for another, a bad one
    assert.equal((await h.call(ANNA, 'POST', 'notes', { title: 'x', clientId: CID(30) })).status, 400);
    assert.equal((await h.call(ANNA, 'POST', 'tasks', { title: 'x', clientId: 'kurz' })).status, 400);
    assert.equal((await h.call(ANNA, 'POST', 'tasks', { title: 'x', clientId: 'a/b/../c-0000000' })).status, 400);
  } finally { await h.close(); }
});

test('a repeat whose object went meanwhile: 410 gone (deleted, or the person left the shared list)', async () => {
  const h = await withHost();
  try {
    const t = await h.ok(ANNA, 'POST', 'tasks', { title: 'Weg', clientId: CID(40) });
    await h.ok(ANNA, 'DELETE', 'tasks/' + t.task.id);
    const r = await h.call(ANNA, 'POST', 'tasks', { title: 'Weg', clientId: CID(40) });
    assert.deepEqual([r.status, r.json.code, r.json.id, r.json.clientId], [410, 'gone', t.task.id, CID(40)]);
    assert.equal(await count(h, "SELECT COUNT(*) AS n FROM tasks WHERE title = 'Weg'"), 1, 'not made again');
    const l = await h.ok(ANNA, 'POST', 'lists', { name: 'Haus' });
    await h.ok(ANNA, 'PUT', `lists/${l.list.id}/members`, { members: [MARC.id] });
    const m = await h.ok(MARC, 'POST', 'tasks', { title: 'Hecke', listId: l.list.id, clientId: CID(41) });
    await h.ok(MARC, 'DELETE', 'lists/' + l.list.id);
    assert.equal((await h.call(MARC, 'POST', 'tasks', { title: 'Hecke', listId: l.list.id, clientId: CID(41) })).status, 410);
    assert.equal((await h.ok(ANNA, 'GET', 'tasks/' + m.task.id)).task.title, 'Hecke', 'Anna still has it');
    const n = await h.ok(ANNA, 'POST', 'notes', { title: 'Weg', clientId: CID(42) });
    await h.ok(ANNA, 'DELETE', 'notes/' + n.note.id);
    assert.equal((await h.call(ANNA, 'POST', 'notes', { title: 'Weg', clientId: CID(42) })).status, 410);
  } finally { await h.close(); }
});

test('PATCH tasks with base: a field changed elsewhere is a conflict, another field is not, a change sent twice does nothing', async () => {
  const h = await withHost();
  try {
    const t = await h.ok(ANNA, 'POST', 'tasks', { title: 'Zahnarzt', due: { date: '2026-11-09', time: '09:00' }, remindAt: { date: '2026-11-08', time: '14:00' } });
    const seen = t.task;
    // the phone (offline) renames it; the portal meanwhile moves the date
    await h.ok(ANNA, 'PATCH', 'tasks/' + t.task.id, { due: { date: '2026-11-10', time: '09:00' }, base: { due: seen.due } });
    const mine = await h.ok(ANNA, 'PATCH', 'tasks/' + t.task.id, { title: 'Zahnarzt anrufen', base: { title: seen.title } });
    assert.equal(mine.task.title, 'Zahnarzt anrufen');
    assert.deepEqual(mine.task.due, { date: '2026-11-10', time: '09:00' }, 'the other change stays');
    // the phone also moved the date, from what it saw: a conflict, with what is there now
    const c = await h.call(ANNA, 'PATCH', 'tasks/' + t.task.id, { due: { date: '2026-11-12' }, important: true, base: { due: seen.due, important: false } });
    assert.equal(c.status, 409);
    assert.deepEqual([c.json.code, c.json.fields], ['conflict', ['due']]);
    assert.deepEqual(c.json.task.due, { date: '2026-11-10', time: '09:00' });
    assert.equal((await h.ok(ANNA, 'GET', 'tasks/' + t.task.id)).task.important, false, 'nothing of a refused change is written');
    // the same value from both sides is no conflict; without base the change wins (keep mine)
    await h.ok(ANNA, 'PATCH', 'tasks/' + t.task.id, { due: { date: '2026-11-10', time: '09:00' }, base: { due: seen.due } });
    await h.ok(ANNA, 'PATCH', 'tasks/' + t.task.id, { due: { date: '2026-11-12' } });
    // a reminder sent twice: the second does not arm it again (no second push)
    clock.set(Date.parse('2026-11-08T13:00:30Z'));
    await h.host.tick();
    assert.equal(h.host.notifications.filter((n) => n.topic === 'reminders').length, 1);
    const before = (await store.one(h.host.gc, 'SELECT updated_at, reminded_at FROM tasks WHERE id = ?', [t.task.id]));
    clock.advance(60000);
    await h.ok(ANNA, 'PATCH', 'tasks/' + t.task.id, { remindAt: { date: '2026-11-08', time: '14:00' }, title: 'Zahnarzt anrufen', base: { title: seen.title } });
    await h.ok(ANNA, 'PATCH', 'tasks/' + t.task.id, { remindAt: seen.remindAt });
    await h.host.tick();
    assert.equal(h.host.notifications.filter((n) => n.topic === 'reminders').length, 1, 'no second reminder');
    assert.deepEqual(await store.one(h.host.gc, 'SELECT updated_at, reminded_at FROM tasks WHERE id = ?', [t.task.id]), before, 'not written');
    // an assignment sent twice pushes once
    const l = await h.ok(ANNA, 'POST', 'lists', { name: 'Haus' });
    await h.ok(ANNA, 'PUT', `lists/${l.list.id}/members`, { members: [MARC.id] });
    const x = await h.ok(ANNA, 'POST', 'tasks', { title: 'Rasen', listId: l.list.id });
    await h.ok(ANNA, 'PATCH', 'tasks/' + x.task.id, { assigneeId: MARC.id, base: { assigneeId: null } });
    await h.ok(ANNA, 'PATCH', 'tasks/' + x.task.id, { assigneeId: MARC.id, base: { assigneeId: null } });
    assert.equal(h.host.notifications.filter((n) => n.topic === 'shared' && n.users.includes(MARC.id) && n.body === 'Rasen').length, 1);
    assert.equal((await h.call(ANNA, 'PATCH', 'tasks/' + x.task.id, { title: 'y', base: 'x' })).status, 400);
    // the task of someone else
    assert.equal((await h.call(BOB, 'PATCH', 'tasks/' + x.task.id, { title: 'y', base: { title: 'Rasen' } })).status, 404);
  } finally { await h.close(); clock.set(T0); }
});

test('PATCH notes: a stale rev is a conflict, the same change sent twice is not', async () => {
  const h = await withHost();
  try {
    const n = await h.ok(ANNA, 'POST', 'notes', { title: 'Einkauf', body: '- [ ] Milch' });
    const rev = n.note.rev;
    const a = await h.ok(ANNA, 'PATCH', 'notes/' + n.note.id, { body: '- [ ] Milch\n- [ ] Brot', rev });
    assert.equal(a.note.rev, rev + 1);
    // the answer got lost: the phone sends it again with its old rev
    const again = await h.ok(ANNA, 'PATCH', 'notes/' + n.note.id, { body: '- [ ] Milch\n- [ ] Brot', rev });
    assert.equal(again.note.rev, rev + 1, 'nothing written');
    // something else on the old rev: the conflict
    const c = await h.call(ANNA, 'PATCH', 'notes/' + n.note.id, { body: '- [ ] Eier', rev });
    assert.deepEqual([c.status, c.json.code, c.json.rev], [409, 'conflict', rev + 1]);
    // keep mine: without rev
    assert.equal((await h.ok(ANNA, 'PATCH', 'notes/' + n.note.id, { body: '- [ ] Eier' })).note.body, '- [ ] Eier');
    assert.equal((await h.call(BOB, 'PATCH', 'notes/' + n.note.id, { body: '- [ ] Eier', rev: 1 })).status, 404, 'no one else, not even a no-op');
  } finally { await h.close(); }
});

test('PATCH lists and notebooks with base; deletes sent twice are ok, not for strangers', async () => {
  const h = await withHost();
  try {
    const l = await h.ok(ANNA, 'POST', 'lists', { name: 'Haus' });
    await h.ok(ANNA, 'PATCH', 'lists/' + l.list.id, { name: 'Haus & Garten', base: { name: 'Haus' } });
    await h.ok(ANNA, 'PATCH', 'lists/' + l.list.id, { name: 'Haus & Garten', base: { name: 'Haus' } });
    const c = await h.call(ANNA, 'PATCH', 'lists/' + l.list.id, { name: 'Garten', base: { name: 'Haus' } });
    assert.deepEqual([c.status, c.json.fields, c.json.list.name], [409, ['name'], 'Haus & Garten']);
    const nb = await h.ok(ANNA, 'POST', 'notebooks', { name: 'Ideen' });
    await h.ok(ANNA, 'PATCH', 'notebooks/' + nb.notebook.id, { color: 'green', base: { color: null } });
    assert.equal((await h.call(ANNA, 'PATCH', 'notebooks/' + nb.notebook.id, { color: 'blue', base: { color: null } })).status, 409);

    const t = await h.ok(ANNA, 'POST', 'tasks', { title: 'x', listId: l.list.id });
    const s = await h.ok(ANNA, 'POST', 'tasks', { title: 'sub', parentId: t.task.id });
    await h.ok(ANNA, 'DELETE', 'tasks/' + t.task.id);
    assert.equal((await h.ok(ANNA, 'DELETE', 'tasks/' + t.task.id)).gone, true);
    assert.equal((await h.ok(ANNA, 'DELETE', 'tasks/' + s.task.id)).gone, true, 'its sub task went with it');
    assert.equal((await h.call(BOB, 'DELETE', 'tasks/' + t.task.id)).status, 404, 'a stranger learns nothing');
    const n = await h.ok(ANNA, 'POST', 'notes', { title: 'x' });
    await h.ok(ANNA, 'DELETE', 'notes/' + n.note.id);
    assert.equal((await h.ok(ANNA, 'DELETE', 'notes/' + n.note.id)).gone, true);
    assert.equal((await h.call(BOB, 'DELETE', 'notes/' + n.note.id)).status, 404);
    await h.ok(ANNA, 'DELETE', 'lists/' + l.list.id);
    assert.equal((await h.ok(ANNA, 'DELETE', 'lists/' + l.list.id)).gone, true);
    assert.equal((await h.call(MARC, 'DELETE', 'lists/' + l.list.id)).status, 404);
    await h.ok(ANNA, 'DELETE', 'notebooks/' + nb.notebook.id);
    assert.equal((await h.ok(ANNA, 'DELETE', 'notebooks/' + nb.notebook.id)).gone, true);
    assert.equal((await h.call(ANNA, 'DELETE', 'tasks/999999')).status, 404, 'what never was');
    // a completion sent twice: as in 1.0, the second does nothing
    const r = await h.ok(ANNA, 'POST', 'tasks', { title: 'Rasen', repeat: { type: 'daily', interval: 1 } });
    await h.ok(ANNA, 'POST', `tasks/${r.task.id}/complete`, { done: true });
    await h.ok(ANNA, 'POST', `tasks/${r.task.id}/complete`, { done: true });
    assert.equal(await count(h, "SELECT COUNT(*) AS n FROM tasks WHERE title = 'Rasen'"), 2, 'one next one, not two');
  } finally { await h.close(); }
});

test('the clientIds are kept 180 days', async () => {
  const h = await withHost();
  try {
    await h.ok(ANNA, 'POST', 'tasks', { title: 'x', clientId: CID(50) });
    clock.advance(179 * 86400000);
    await h.host.tick();
    assert.equal(await count(h, 'SELECT COUNT(*) AS n FROM client_ids'), 1);
    clock.advance(2 * 86400000);
    await h.host.tick();
    assert.equal(await count(h, 'SELECT COUNT(*) AS n FROM client_ids'), 0);
  } finally { await h.close(); clock.set(T0); }
});

test('pushes carry kind and the ids to open (and the keys of 1.0)', async () => {
  const h = await withHost();
  try {
    const l = await h.ok(ANNA, 'POST', 'lists', { name: 'Büro', area: 'work' });
    await h.ok(ANNA, 'PUT', `lists/${l.list.id}/members`, { members: [MARC.id] });
    const t = await h.ok(ANNA, 'POST', 'tasks', { title: 'Angebot', listId: l.list.id, assigneeId: MARC.id, remindAt: { date: '2026-11-08', time: '14:00' } });
    const nb = await h.ok(ANNA, 'POST', 'notebooks', { name: 'Team', area: 'work' });
    await h.ok(ANNA, 'PUT', `notebooks/${nb.notebook.id}/members`, { members: [MARC.id] });
    clock.set(Date.parse('2026-11-08T13:00:30Z'));
    await h.host.tick();
    const data = (pred) => h.host.notifications.filter(pred).map((n) => n.data.notizen);
    assert.deepEqual(data((n) => n.topic === 'shared' && n.collapseKey === 'list:' + l.list.id), [{ kind: 'shared_list', listId: l.list.id, area: 'work', list: l.list.id }]);
    assert.deepEqual(data((n) => n.topic === 'shared' && n.collapseKey === 'task:' + t.task.id), [{ kind: 'assigned', taskId: t.task.id, listId: l.list.id, area: 'work', task: t.task.id }]);
    assert.deepEqual(data((n) => n.topic === 'shared' && n.collapseKey === 'notebook:' + nb.notebook.id), [{ kind: 'shared_notebook', notebookId: nb.notebook.id, area: 'work', notebook: nb.notebook.id }]);
    assert.deepEqual(data((n) => n.topic === 'reminders'), [{ kind: 'reminder', taskId: t.task.id, listId: l.list.id, area: 'work', task: t.task.id }]);
  } finally { await h.close(); clock.set(T0); }
});
