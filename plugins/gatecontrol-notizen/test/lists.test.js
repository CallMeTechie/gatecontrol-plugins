'use strict';

// 1.2.0: roles read | write for members of lists and notebooks (enforced on the server), deleting a list or notebook
// with its tasks / notes kept (moved to the default one) and „Rückgängig“, list days in „Mein Tag“ (Einkaufstag) with
// the morning push, groups with lists put in, the new prefs. The clock: Sunday 2026-11-08 10:00 in Berlin.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC, LENA, BOB, clock, T0 } = require('./helpers');

const sec = (v, id) => v.sections.find((s) => s.id === id).items;
const reason = (r) => [r.status, r.json && r.json.code, r.json && r.json.reason];

test('roles: a member who may only look reads, completes only what is assigned to them, changes nothing else', async () => {
  const h = await withHost();
  try {
    const me = await h.ok(ANNA, 'GET', 'me');
    for (const f of ['listDays', 'shareRoles', 'groupEdit', 'deleteKeep', 'listIcons']) assert.ok(me.features.includes(f), f);
    assert.deepEqual(me.listIcons, ['list', 'cart', 'home', 'tool', 'gift', 'plane', 'heart', 'work']);
    const l = await h.ok(ANNA, 'POST', 'lists', { name: 'Einkaufsliste', icon: 'cart' });
    assert.equal(l.list.icon, 'cart');
    assert.equal((await h.call(ANNA, 'POST', 'lists', { name: 'x', icon: 'rocket' })).json.field, 'icon');
    const s = await h.ok(ANNA, 'PUT', `lists/${l.list.id}/members`, { members: [{ id: MARC.id, role: 'write' }, { id: LENA.id, role: 'read' }] });
    assert.deepEqual(s.list.members.map((m) => [m.id, m.role, typeof m.since]), [[MARC.id, 'write', 'number'], [LENA.id, 'read', 'number']]);
    assert.equal((await h.call(ANNA, 'PUT', `lists/${l.list.id}/members`, { members: [{ id: MARC.id, role: 'admin' }] })).json.field, 'role');
    const milk = await h.ok(MARC, 'POST', 'tasks', { title: 'Milch', listId: l.list.id });
    const bread = await h.ok(ANNA, 'POST', 'tasks', { title: 'Brot', listId: l.list.id, assigneeId: LENA.id });
    await h.ok(ANNA, 'POST', 'tasks', { title: 'Weizen', parentId: bread.task.id });
    assert.ok(h.host.notifications.some((n) => n.topic === 'shared' && n.users.includes(LENA.id) && n.body === 'Brot'), 'a read member can be assigned');

    // Lena looks only
    const v = await h.ok(LENA, 'GET', 'views/list:' + l.list.id);
    assert.equal(v.list.role, 'read');
    assert.equal(v.list.canEdit, false);
    assert.deepEqual(sec(v, 'open').map((x) => [x.title, x.canEdit, x.canComplete]), [['Brot', false, true], ['Milch', false, false]]);
    assert.deepEqual(reason(await h.call(LENA, 'POST', 'tasks', { title: 'Eier', listId: l.list.id })), [403, 'forbidden', 'read_only']);
    assert.deepEqual(reason(await h.call(LENA, 'POST', 'tasks', { title: 'Eier', parentId: milk.task.id })), [403, 'forbidden', 'read_only']);
    assert.deepEqual(reason(await h.call(LENA, 'PATCH', 'tasks/' + milk.task.id, { title: 'Hafermilch' })), [403, 'forbidden', 'read_only']);
    assert.deepEqual(reason(await h.call(LENA, 'POST', `tasks/${milk.task.id}/complete`, { done: true })), [403, 'forbidden', 'read_only']);
    assert.deepEqual(reason(await h.call(LENA, 'DELETE', 'tasks/' + milk.task.id)), [403, 'forbidden', 'read_only']);
    // her own „Mein Tag“ mark, her own task and its sub task
    assert.equal((await h.ok(LENA, 'PATCH', 'tasks/' + milk.task.id, { myDay: true })).task.myDay, true);
    assert.equal((await h.ok(LENA, 'POST', `tasks/${bread.task.id}/complete`, { done: true })).task.done, true);
    const sub = (await h.ok(LENA, 'GET', 'tasks/' + bread.task.id)).task.subtasks[0];
    await h.ok(LENA, 'POST', `tasks/${sub.id}/complete`, { done: true });
    // moving a task of her own list into the read list
    const own = await h.ok(LENA, 'POST', 'tasks', { title: 'Hausaufgaben' });
    assert.deepEqual(reason(await h.call(LENA, 'PATCH', 'tasks/' + own.task.id, { listId: l.list.id })), [403, 'forbidden', 'read_only']);
    // the quick entry does not offer a read list
    const p = await h.ok(LENA, 'POST', 'parse', { text: 'Butter #einkaufsliste' });
    assert.equal(p.parsed.list, null);
    // the owner only: name, colour, days, sharing
    assert.deepEqual(reason(await h.call(MARC, 'PATCH', 'lists/' + l.list.id, { name: 'Meine' })), [403, 'forbidden', 'owner']);
    assert.deepEqual(reason(await h.call(MARC, 'PATCH', 'lists/' + l.list.id, { days: [6] })), [403, 'forbidden', 'owner']);
    assert.deepEqual(reason(await h.call(MARC, 'PUT', `lists/${l.list.id}/members`, { members: [] })), [403, 'forbidden', 'owner']);
    // 1.1 form: plain ids — the roles stay; a new person writes
    const s2 = await h.ok(ANNA, 'PUT', `lists/${l.list.id}/members`, { members: [MARC.id, LENA.id, BOB.id] });
    assert.deepEqual(s2.list.members.map((m) => [m.id, m.role]), [[MARC.id, 'write'], [LENA.id, 'read'], [BOB.id, 'write']]);
    // Lena gets write
    await h.ok(ANNA, 'PUT', `lists/${l.list.id}/members`, { members: [MARC.id, { id: LENA.id, role: 'write' }] });
    await h.ok(LENA, 'POST', 'tasks', { title: 'Eier', listId: l.list.id });
    assert.equal((await h.call(BOB, 'GET', 'views/list:' + l.list.id)).status, 404, 'Bob was taken out');
  } finally { await h.close(); }
});

test('roles in notebooks: read members read; write members write', async () => {
  const h = await withHost();
  try {
    const nb = await h.ok(ANNA, 'POST', 'notebooks', { name: 'Rezepte' });
    await h.ok(ANNA, 'PUT', `notebooks/${nb.notebook.id}/members`, { members: [{ id: MARC.id, role: 'read' }, LENA.id] });
    const n = await h.ok(ANNA, 'POST', 'notes', { notebookId: nb.notebook.id, title: 'Apfelkuchen', body: '- [ ] Äpfel' });
    const seen = (await h.ok(MARC, 'GET', 'notebooks')).notebooks.find((x) => x.id === nb.notebook.id);
    assert.deepEqual([seen.role, seen.canEdit, seen.members.map((m) => m.role)], ['read', false, ['read', 'write']]);
    assert.equal((await h.ok(MARC, 'GET', 'notes/' + n.note.id)).note.title, 'Apfelkuchen');
    assert.deepEqual(reason(await h.call(MARC, 'POST', 'notes', { notebookId: nb.notebook.id, title: 'x' })), [403, 'forbidden', 'read_only']);
    assert.deepEqual(reason(await h.call(MARC, 'PATCH', 'notes/' + n.note.id, { title: 'y' })), [403, 'forbidden', 'read_only']);
    assert.deepEqual(reason(await h.call(MARC, 'POST', `notes/${n.note.id}/check`, { line: 0, done: true })), [403, 'forbidden', 'read_only']);
    assert.deepEqual(reason(await h.call(MARC, 'DELETE', 'notes/' + n.note.id)), [403, 'forbidden', 'read_only']);
    assert.deepEqual(reason(await h.call(MARC, 'PATCH', 'notebooks/' + nb.notebook.id, { color: 'green' })), [403, 'forbidden', 'owner']);
    await h.ok(LENA, 'PATCH', 'notes/' + n.note.id, { title: 'Omas Apfelkuchen' });
    // a member leaves
    assert.equal((await h.ok(MARC, 'DELETE', 'notebooks/' + nb.notebook.id)).left, true);
  } finally { await h.close(); }
});

test('deleting a list: open tasks moved to „Aufgaben“, done ones in the trash, „Rückgängig“ brings all back', async () => {
  const h = await withHost();
  try {
    const l = await h.ok(ANNA, 'POST', 'lists', { name: 'Einkaufsliste' });
    await h.ok(ANNA, 'PUT', `lists/${l.list.id}/members`, { members: [{ id: MARC.id, role: 'read' }] });
    const milk = await h.ok(ANNA, 'POST', 'tasks', { title: 'Milch', listId: l.list.id, assigneeId: MARC.id });
    const bread = await h.ok(ANNA, 'POST', 'tasks', { title: 'Brot', listId: l.list.id });
    await h.ok(ANNA, 'POST', 'tasks', { title: 'Vollkorn', parentId: bread.task.id });
    const old = await h.ok(ANNA, 'POST', 'tasks', { title: 'Kaffee', listId: l.list.id });
    await h.ok(ANNA, 'POST', `tasks/${old.task.id}/complete`, { done: true });
    const u = await h.ok(ANNA, 'GET', `lists/${l.list.id}/usage`);
    assert.deepEqual([u.open, u.done, u.members.map((m) => [m.name, m.role]), u.canDelete, u.target.name], [2, 1, [['Marc Berg', 'read']], true, 'Aufgaben']);
    assert.equal((await h.ok(MARC, 'GET', `lists/${l.list.id}/usage`)).canDelete, false);
    assert.equal((await h.call(ANNA, 'DELETE', `lists/${l.list.id}`, null, { tasks: 'keep' })).json.field, 'tasks');
    const d = await h.ok(ANNA, 'DELETE', `lists/${l.list.id}`, null, { tasks: 'move' });
    assert.deepEqual([d.deleted, d.moved, d.removed, d.target.name], [true, 2, 1, 'Aufgaben']);
    assert.ok(d.restoreUntil > clock.now());
    const t = (await h.ok(ANNA, 'GET', 'tasks/' + bread.task.id)).task;
    assert.equal(t.listId, d.target.id);
    assert.equal(t.subtasks.length, 1);
    assert.equal((await h.ok(ANNA, 'GET', 'tasks/' + milk.task.id)).task.assignee, null, 'Marc does not see „Aufgaben“');
    assert.equal((await h.call(ANNA, 'GET', 'tasks/' + old.task.id)).status, 404);
    assert.equal((await h.call(MARC, 'GET', 'views/list:' + l.list.id)).status, 404);
    assert.equal((await h.ok(ANNA, 'DELETE', `lists/${l.list.id}`)).gone, true, 'sent twice');
    assert.equal((await h.call(MARC, 'POST', `lists/${l.list.id}/restore`)).status, 404, 'only the owner');
    // Rückgängig
    const r = await h.ok(ANNA, 'POST', `lists/${l.list.id}/restore`);
    assert.deepEqual(r.list.members.map((m) => [m.id, m.role]), [[MARC.id, 'read']]);
    const v = await h.ok(ANNA, 'GET', 'views/list:' + l.list.id);
    assert.deepEqual(sec(v, 'open').map((x) => x.title).sort(), ['Brot', 'Milch']);
    assert.deepEqual(sec(v, 'done').map((x) => x.title), ['Kaffee']);
    assert.equal((await h.ok(ANNA, 'GET', 'tasks/' + milk.task.id)).task.assignee.id, MARC.id);
    assert.equal((await h.ok(ANNA, 'GET', 'tasks/' + bread.task.id)).task.subtasks.length, 1);
    assert.equal((await h.ok(MARC, 'GET', 'views/list:' + l.list.id)).list.role, 'read');
    assert.equal((await h.call(ANNA, 'POST', `lists/${l.list.id}/restore`)).status, 404, 'not in the trash');
    // delete all, and the 1.1 call without a parameter
    const d2 = await h.ok(ANNA, 'DELETE', `lists/${l.list.id}`, null, { tasks: 'delete' });
    assert.deepEqual([d2.moved, d2.removed], [0, 3]);
    await h.ok(ANNA, 'POST', `lists/${l.list.id}/restore`);
    assert.equal(sec(await h.ok(ANNA, 'GET', 'views/list:' + l.list.id), 'open').length, 2);
    const d3 = await h.ok(ANNA, 'DELETE', `lists/${l.list.id}`);
    assert.equal(d3.moved, 0);
    // too late: after 30 days
    clock.advance(31 * 86400000);
    assert.equal((await h.call(ANNA, 'POST', `lists/${l.list.id}/restore`)).status, 404);
    clock.set(T0);
    // the default list: rename yes, delete no
    const def = (await h.ok(ANNA, 'GET', 'lists', null, { area: 'private' })).lists.find((x) => x.isDefault);
    assert.equal((await h.ok(ANNA, 'PATCH', 'lists/' + def.id, { name: 'Alles' })).list.name, 'Alles');
    assert.deepEqual(reason(await h.call(ANNA, 'DELETE', 'lists/' + def.id, null, { tasks: 'move' })), [403, 'forbidden', 'default']);
    assert.equal((await h.ok(ANNA, 'GET', `lists/${def.id}/usage`)).canDelete, false);
  } finally { await h.close(); clock.set(T0); }
});

test('deleting a notebook: notes moved to „Notizen“ (tags with them) or deleted; „Rückgängig“', async () => {
  const h = await withHost();
  try {
    const nb = await h.ok(ANNA, 'POST', 'notebooks', { name: 'Rezepte' });
    await h.ok(ANNA, 'PUT', `notebooks/${nb.notebook.id}/members`, { members: [MARC.id] });
    const a = await h.ok(ANNA, 'POST', 'notes', { notebookId: nb.notebook.id, title: 'Pizzateig', body: '500 g Mehl #backen' });
    await h.ok(ANNA, 'POST', 'notes', { notebookId: nb.notebook.id, title: 'Linsensuppe', body: 'Rote Linsen' });
    const u = await h.ok(ANNA, 'GET', `notebooks/${nb.notebook.id}/usage`);
    assert.deepEqual([u.notes, u.withImages, u.members.map((m) => m.id), u.canDelete, u.vault, u.target.name], [2, 0, [MARC.id], true, false, 'Notizen']);
    const d = await h.ok(ANNA, 'DELETE', `notebooks/${nb.notebook.id}`, null, { notes: 'move' });
    assert.deepEqual([d.moved, d.removed, d.target.name], [2, 0, 'Notizen']);
    const moved = await h.ok(ANNA, 'GET', 'notes/' + a.note.id);
    assert.equal(moved.note.notebookId, d.target.id);
    assert.deepEqual(moved.note.tags, ['backen']);
    assert.ok((await h.ok(ANNA, 'GET', 'notebooks')).tags.some((x) => x.tag === 'backen'));
    assert.equal((await h.call(MARC, 'GET', 'notes/' + a.note.id)).status, 404, 'Marc does not see „Notizen“ of Anna');
    const r = await h.ok(ANNA, 'POST', `notebooks/${nb.notebook.id}/restore`);
    assert.deepEqual(r.notebook.members.map((m) => m.id), [MARC.id]);
    assert.equal((await h.ok(MARC, 'GET', 'notes/' + a.note.id)).note.notebookId, nb.notebook.id);
    assert.equal((await h.ok(ANNA, 'GET', 'search', null, { q: 'mehl' })).notes.length, 1);
    const d2 = await h.ok(ANNA, 'DELETE', `notebooks/${nb.notebook.id}`, null, { notes: 'delete' });
    assert.deepEqual([d2.moved, d2.removed], [0, 2]);
    assert.equal((await h.ok(ANNA, 'GET', 'search', null, { q: 'mehl' })).notes.length, 0);
    await h.ok(ANNA, 'POST', `notebooks/${nb.notebook.id}/restore`);
    assert.equal((await h.ok(ANNA, 'GET', 'search', null, { q: 'mehl' })).notes.length, 1);
    const def = (await h.ok(ANNA, 'GET', 'notebooks')).notebooks.find((x) => x.isDefault);
    assert.equal((await h.ok(ANNA, 'PATCH', 'notebooks/' + def.id, { name: 'Allerlei' })).notebook.name, 'Allerlei');
    assert.deepEqual(reason(await h.call(ANNA, 'DELETE', 'notebooks/' + def.id, null, { notes: 'move' })), [403, 'forbidden', 'default']);
    assert.equal((await h.call(ANNA, 'DELETE', 'notebooks/' + nb.notebook.id, null, { notes: 'x' })).json.field, 'notes');
  } finally { await h.close(); }
});

test('list days: the card at the top of „Mein Tag“ for every member, own switch, the push in the morning', async () => {
  const h = await withHost();
  try {
    const l = await h.ok(ANNA, 'POST', 'lists', { name: 'Einkaufsliste', icon: 'cart' });
    await h.ok(ANNA, 'PUT', `lists/${l.list.id}/members`, { members: [MARC.id, { id: LENA.id, role: 'read' }] });
    for (const x of ['Milch', 'Brot', 'Waschmittel', 'Äpfel']) await h.ok(ANNA, 'POST', 'tasks', { title: x, listId: l.list.id, assigneeId: x === 'Brot' ? MARC.id : undefined });
    assert.equal((await h.call(ANNA, 'PATCH', 'lists/' + l.list.id, { days: [0] })).json.field, 'days');
    assert.equal((await h.call(ANNA, 'PATCH', 'lists/' + l.list.id, { remind: '25:00' })).json.field, 'remind');
    // Sunday (7) is today
    const p = await h.ok(ANNA, 'PATCH', 'lists/' + l.list.id, { days: [7, 6, 6], remind: '10:30' });
    assert.deepEqual([p.list.days, p.list.remind, p.list.dayToday, p.list.mydayOff], [[6, 7], '10:30', true, false]);
    const md = await h.ok(MARC, 'GET', 'views/myday', null, { area: 'private' });
    assert.equal(md.listdays.length, 1);
    const c = md.listdays[0];
    assert.deepEqual([c.title, c.list.name, c.open, c.assignedToMe, c.items.map((x) => x.title), c.more], ['Heute ist Einkaufstag', 'Einkaufsliste', 4, 1, ['Äpfel', 'Waschmittel', 'Brot'], 1]);
    assert.equal((await h.ok(LENA, 'GET', 'views/myday', null, { area: 'private' })).listdays[0].items[0].canComplete, false);
    assert.equal((await h.ok(BOB, 'GET', 'views/myday', null, { area: 'private' })).listdays.length, 0);
    assert.equal((await h.ok(ANNA, 'GET', 'views/myday', null, { area: 'work' })).listdays.length, 0);
    // the tile on GateControl's start page
    const tiles = await h.host.portalTiles({ ...MARC, loggedIn: true });
    assert.deepEqual(tiles.map((x) => x.title), ['Mein Tag', 'Heute ist Einkaufstag']);
    // Lena switches the card off for herself (a member may), Marc switches off the push
    assert.equal((await h.ok(LENA, 'PATCH', 'lists/' + l.list.id, { mydayOff: true })).list.mydayOff, true);
    assert.equal((await h.ok(LENA, 'GET', 'views/myday', null, { area: 'private' })).listdays.length, 0);
    assert.equal((await h.ok(ANNA, 'GET', 'lists/' + l.list.id + '/usage')).open, 4);
    await h.ok(MARC, 'PUT', 'prefs', { notify: { listday: false } });
    // the push: not before 10:30, once
    await h.host.tick();
    assert.equal(h.host.notifications.filter((n) => n.topic === 'listday').length, 0);
    clock.set(Date.parse('2026-11-08T09:31:00Z'));
    await h.host.tick();
    await h.host.tick();
    const pushes = h.host.notifications.filter((n) => n.topic === 'listday');
    assert.equal(pushes.length, 1);
    assert.deepEqual([pushes[0].users, pushes[0].title, pushes[0].body], [[ANNA.id], 'Heute ist Einkaufstag', 'Einkaufsliste – 4 Dinge auf der Liste']);
    assert.deepEqual(pushes[0].data.notizen, { kind: 'listday', listId: l.list.id, area: 'private', day: '2026-11-08', list: l.list.id });
    // Monday: gone; Saturday: there again
    clock.set(Date.parse('2026-11-09T09:00:00Z'));
    assert.equal((await h.ok(ANNA, 'GET', 'views/myday', null, { area: 'private' })).listdays.length, 0);
    clock.set(Date.parse('2026-11-14T09:00:00Z'));
    assert.equal((await h.ok(ANNA, 'GET', 'views/myday', null, { area: 'private' })).listdays.length, 1);
    // the person's own choice: no cards, no done ones
    await h.ok(ANNA, 'POST', 'tasks/' + (await h.ok(ANNA, 'POST', 'tasks', { title: 'Erledigt' })).task.id + '/complete', { done: true });
    const pr = await h.ok(ANNA, 'PUT', 'prefs', { myday: { listdays: false, showDone: false }, startArea: 'work' });
    assert.deepEqual([pr.prefs.myday, pr.prefs.startArea, pr.prefs.notify], [{ listdays: false, showDone: false }, 'work', { reminders: true, shared: true, listday: true }]);
    const md2 = await h.ok(ANNA, 'GET', 'views/myday', null, { area: 'private' });
    assert.deepEqual([md2.listdays.length, sec(md2, 'done').length], [0, 0]);
    // another icon: a list day, not a shopping day
    await h.ok(ANNA, 'PUT', 'prefs', { myday: { listdays: true } });
    await h.ok(ANNA, 'PATCH', 'lists/' + l.list.id, { icon: 'home', base: { icon: 'cart' } });
    assert.equal((await h.ok(ANNA, 'GET', 'views/myday', null, { area: 'private' })).listdays[0].title, 'Heute ist Listen-Tag');
    const late = await h.call(ANNA, 'PATCH', 'lists/' + l.list.id, { icon: 'gift', base: { icon: 'cart' } });
    assert.deepEqual([late.status, late.json.fields], [409, ['icon']]);
  } finally { await h.close(); clock.set(T0); }
});

test('groups: made with lists in them, open counts, rename, dissolve keeps the lists', async () => {
  const h = await withHost();
  try {
    const a = await h.ok(ANNA, 'POST', 'lists', { name: 'Baumarkt' });
    const b = await h.ok(ANNA, 'POST', 'lists', { name: 'Putzplan' });
    const w = await h.ok(ANNA, 'POST', 'lists', { name: 'Büro', area: 'work' });
    await h.ok(ANNA, 'POST', 'tasks', { title: 'Schrauben', listId: a.list.id });
    await h.ok(ANNA, 'POST', 'tasks', { title: 'Bad', listId: b.list.id });
    assert.equal((await h.call(ANNA, 'POST', 'groups', { name: 'Haushalt', area: 'private', lists: [a.list.id, w.list.id] })).json.field, 'lists');
    const other = await h.ok(MARC, 'POST', 'lists', { name: 'Marcs' });
    assert.equal((await h.call(ANNA, 'POST', 'groups', { name: 'Haushalt', lists: [other.list.id] })).json.field, 'lists');
    const g = await h.ok(ANNA, 'POST', 'groups', { name: 'Haushalt', area: 'private', lists: [a.list.id, b.list.id] });
    let nav = await h.ok(ANNA, 'GET', 'nav', null, { area: 'private' });
    assert.deepEqual(nav.groups.map((x) => [x.name, x.open]), [['Haushalt', 2]]);
    assert.deepEqual(nav.lists.filter((x) => x.groupId === g.group.id).map((x) => x.name), ['Baumarkt', 'Putzplan']);
    const n = await h.ok(ANNA, 'POST', 'lists', { name: 'Garten', groupId: g.group.id });
    assert.equal(n.list.groupId, g.group.id);
    assert.equal((await h.ok(ANNA, 'PATCH', 'groups/' + g.group.id, { name: 'Zuhause' })).group.name, 'Zuhause');
    await h.ok(ANNA, 'DELETE', 'groups/' + g.group.id);
    nav = await h.ok(ANNA, 'GET', 'nav', null, { area: 'private' });
    assert.equal(nav.groups.length, 0);
    assert.ok(['Baumarkt', 'Putzplan', 'Garten'].every((x) => nav.lists.some((l) => l.name === x && l.groupId === null)));
    // the group of a shared list is each person's own
    await h.ok(ANNA, 'PUT', `lists/${a.list.id}/members`, { members: [MARC.id] });
    const mg = await h.ok(MARC, 'POST', 'groups', { name: 'Familie', lists: [a.list.id] });
    assert.equal((await h.ok(ANNA, 'GET', 'views/list:' + a.list.id)).list.groupId, null);
    assert.equal((await h.ok(MARC, 'GET', 'views/list:' + a.list.id)).list.groupId, mg.group.id);
  } finally { await h.close(); }
});
