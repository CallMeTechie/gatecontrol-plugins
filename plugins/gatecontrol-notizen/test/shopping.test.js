'use strict';

// 1.4.0 — shopping lists in the hub (server/shopping.js): lists of the kind 'shopping' with items whose ids the device
// makes, POST shopping/ops (in order, idempotent, in any order from two devices), GET shopping with `since` and
// tombstones, the roles (owner, write, read; parents of the family), the family (shopping_bind / _put / _list for
// Familie, shopping_changed back, going / assign handed over). The clock is pinned (helpers: Sunday 2026-11-08 10:00 in
// Berlin) and only ever set.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, fakeSource, ANNA, MARC, LENA, BOB, clock, T0, PLUGINS } = require('./helpers');
const shopping = require('../server/shopping');

const L1 = '6f1c2a90-1111-4c1d-9a00-000000000001';
const L2 = '6f1c2a90-2222-4c1d-9a00-000000000002';
const L3 = '6f1c2a90-3333-4c1d-9a00-000000000003';
const I = (n) => `0a0b0c0d-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FAM = 'gatecontrol-familie';
const MIN = 60000;
const DAY = 86400000;

const ops = (h, user, ...list) => h.ok(user, 'POST', 'shopping/ops', { ops: list });
const add = (id, name, extra = {}) => ({ op: 'list_add', id, name, ...extra });
const item = (n, listId, text, qty) => ({ op: 'item_add', id: I(n), listId, text, ...(qty ? { qty } : {}) });
const check = (n, checked = true) => ({ op: 'item_check', id: I(n), checked });
const shop = (h, user, query) => h.ok(user, 'GET', 'shopping', undefined, query);
const texts = (g, listId) => g.items.filter((i) => i.listId === listId).map((i) => [i.text, i.qty, i.checked]);

/** A stand-in for Familie: the to-do services of the helpers plus shopping_changed / shopping_action. */
function familie(answer) {
  const src = fakeSource(FAM, {
    provides: { shopping_changed: { label: { de: 'x', en: 'x' }, maxPerHour: 3600 }, shopping_action: { label: { de: 'x', en: 'x' }, maxPerHour: 600 } },
    service: async (c) => (c.name === 'shopping_changed' ? { ok: true } : (answer ? answer(c) : { ok: false, code: 'not_found' })),
  });
  return [src, ...PLUGINS.filter((p) => p !== FAM).map((p) => fakeSource(p))];
}
const svc = (h, name, payload) => h.host.callService(name, { caller: FAM, user: null, payload: { v: 1, ...payload } });
const told = (h) => h.src(FAM).state.calls.filter((c) => c.name === 'shopping_changed').length;

async function host(opts) {
  const h = await withHost(opts);
  shopping.state.noTimer = true;
  return h;
}
const done = async (h) => { await h.close(); clock.set(T0); };

test('ops in order with ids of the device; GET shopping; the lists are no task lists', async () => {
  const h = await host();
  try {
    const me = await h.ok(ANNA, 'GET', 'me');
    for (const f of ['shoppingLists', 'taskList', 'familyShopping']) assert.ok(me.features.includes(f), f);
    assert.deepEqual(me.shopping, { family: { available: false, bound: false, parent: false } });
    const r = await ops(h, ANNA, add(L1, 'Einkauf', { icon: 'cart' }), item(1, L1, 'Milch', '2 l'), item(2, L1, 'Brot'), check(2), { op: 'item_edit', id: I(1), qty: '3 l' }, add(L2, 'Drogerie'));
    assert.deepEqual([r.applied, r.rejected, r.serverTime, r.completed], [6, [], '2026-11-08T10:00:00+01:00', []]);
    const g = await shop(h, ANNA);
    assert.deepEqual(g.lists.map((l) => [l.id, l.name, l.icon, l.area, l.role, l.canEdit, l.canManage, l.shared, l.family, l.open, l.total, l.deleted]),
      [[L1, 'Einkauf', 'cart', 'private', 'owner', true, true, false, false, 1, 2, false], [L2, 'Drogerie', null, 'private', 'owner', true, true, false, false, 0, 0, false]]);
    assert.deepEqual(g.lists[0].owner, { id: ANNA.id, name: 'Anna Berg' });
    assert.deepEqual([g.lists[0].members, g.lists[0].assignee, g.lists[0].dueAt, g.lists[0].going, g.lists[0].tasks], [[], null, null, [], []]);
    assert.deepEqual(g.items, [
      { id: I(1), listId: L1, text: 'Milch', qty: '3 l', checked: false, checkedBy: null, updatedAt: '2026-11-08T10:00:00+01:00', deleted: false },
      { id: I(2), listId: L1, text: 'Brot', qty: null, checked: true, checkedBy: ANNA.id, updatedAt: '2026-11-08T10:00:00+01:00', deleted: false },
    ]);
    assert.equal(g.serverTime, '2026-11-08T10:00:00+01:00');
    // not among the task lists (older apps), but in the menu; no task goes into one
    const ls = await h.ok(ANNA, 'GET', 'lists');
    assert.deepEqual(ls.lists.map((l) => [l.name, l.kind]), [['Aufgaben', 'tasks']]);
    const nav = await h.ok(ANNA, 'GET', 'nav');
    assert.deepEqual(nav.lists.map((l) => l.name), ['Aufgaben']);
    assert.deepEqual(nav.shopping, [
      { id: L1, listId: g.lists[0].listId, name: 'Einkauf', icon: 'cart', open: 1, total: 2, family: false, shared: false, role: 'owner' },
      { id: L2, listId: g.lists[1].listId, name: 'Drogerie', icon: null, open: 0, total: 0, family: false, shared: false, role: 'owner' },
    ]);
    const no = await h.call(ANNA, 'POST', 'tasks', { title: 'Brot', listId: g.lists[0].listId });
    assert.deepEqual([no.status, no.json], [400, { ok: false, code: 'invalid', field: 'listId', reason: 'shopping' }]);
    const t = await h.ok(ANNA, 'POST', 'tasks', { title: 'Brot' });
    const mv = await h.call(ANNA, 'PATCH', 'tasks/' + t.task.id, { listId: g.lists[0].listId });
    assert.deepEqual([mv.status, mv.json.code, mv.json.reason], [400, 'invalid', 'shopping']);
    assert.equal((await h.call(ANNA, 'GET', 'views/list:' + g.lists[0].listId)).status, 404);
    // a stranger sees nothing of it
    assert.deepEqual([(await shop(h, BOB)).lists, (await shop(h, BOB)).items], [[], []]);
  } finally { await done(h); }
});

test('ops are idempotent: a replayed outbox never duplicates; rejected ops carry index and code', async () => {
  const h = await host();
  try {
    const batch = [add(L1, 'Einkauf'), item(1, L1, 'Milch'), check(1), { op: 'item_delete', id: I(1) }, item(2, L1, 'Brot')];
    for (let i = 0; i < 3; i++) {
      const r = await ops(h, ANNA, ...batch);
      // the second and third time: the deleted item is not ticked again (not_found), nothing else happens
      assert.deepEqual([r.applied, r.rejected], i === 0 ? [5, []] : [4, [{ index: 2, code: 'not_found' }]], 'run ' + i);
    }
    const g = await shop(h, ANNA);
    assert.deepEqual([g.lists.length, texts(g, L1)], [1, [['Brot', null, false]]]);
    const bad = await ops(h, ANNA,
      { op: 'item_add', id: 'short', listId: L1, text: 'x' }, { op: 'nope' }, 'x', item(3, L2, 'Seife'), { op: 'item_check', id: I(9), checked: true },
      { op: 'item_check', id: I(2), checked: 'yes' }, { op: 'item_edit', id: I(2) }, { op: 'item_add', id: I(4), listId: L1, text: 'x'.repeat(121) },
      add(L3, 'Baumarkt', { icon: 'rocket' }), { op: 'list_rename', id: L2, name: 'X' }, { op: 'list_delete', id: L2 }, { op: 'clear_checked', listId: L2 });
    assert.deepEqual(bad.applied, 0);
    assert.deepEqual(bad.rejected.map((x) => x.code), ['invalid', 'invalid', 'invalid', 'not_found', 'not_found', 'invalid', 'invalid', 'invalid', 'invalid', 'not_found', 'not_found', 'not_found']);
    assert.deepEqual(bad.rejected.map((x) => x.index), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    for (const body of [{}, { ops: 'x' }, { ops: new Array(201).fill(check(2)) }]) {
      const r = await h.call(ANNA, 'POST', 'shopping/ops', body);
      assert.deepEqual([r.status, r.json], [400, { ok: false, code: 'invalid', field: 'ops' }]);
    }
    assert.equal((await ops(h, ANNA, ...new Array(200).fill(check(2)))).applied, 200);
  } finally { await done(h); }
});

test('two devices, any order, twice: what arrives last wins and nothing is there twice', async () => {
  const h = await host();
  try {
    await ops(h, ANNA, add(L1, 'Einkauf'));
    const l = (await shop(h, ANNA)).lists[0];
    await h.ok(ANNA, 'PUT', `lists/${l.listId}/members`, { members: [{ id: MARC.id, role: 'write' }] });
    const phone = [item(1, L1, 'Milch'), item(2, L1, 'Brot'), check(1), { op: 'item_edit', id: I(2), text: 'Vollkornbrot' }];
    const tablet = [item(3, L1, 'Äpfel', '1 kg'), check(3), check(3, false), { op: 'item_delete', id: I(3) }, item(4, L1, 'Butter')];
    // every way to interleave the two outboxes — each device's own order kept —, each batch sent twice
    const orders = [[...phone, ...tablet], [...tablet, ...phone], phone.flatMap((o, i) => [o, tablet[i]]).concat(tablet.slice(phone.length))];
    let before = null;
    for (const order of orders) {
      for (const o of order) {
        const user = phone.includes(o) ? ANNA : MARC;
        await ops(h, user, o);
        await ops(h, user, o);
      }
      const g = await shop(h, MARC);
      const now = g.items.map((i) => [i.id, i.text, i.qty, i.checked, i.checkedBy]);
      assert.deepEqual(now, [[I(1), 'Milch', null, true, ANNA.id], [I(2), 'Vollkornbrot', null, false, null], [I(4), 'Butter', null, false, null]]);
      if (before) assert.deepEqual(now, before);
      before = now;
      assert.deepEqual([g.lists[0].open, g.lists[0].total, g.lists[0].role, g.lists[0].shared], [2, 3, 'write', true]);
    }
    // an item that arrives before its list is refused, not kept for later
    const early = await ops(h, MARC, item(7, L2, 'Seife'), add(L2, 'Drogerie'));
    assert.deepEqual([early.applied, early.rejected], [1, [{ index: 0, code: 'not_found' }]]);
  } finally { await done(h); }
});

test('since: the items changed and tombstones; a deleted list is a tombstone for its members and comes back with „Rückgängig“', async () => {
  const h = await host();
  try {
    await ops(h, ANNA, add(L1, 'Einkauf'), add(L2, 'Drogerie'), item(1, L1, 'Milch'), item(2, L1, 'Brot'), item(3, L2, 'Zahnpasta'));
    const first = await shop(h, ANNA);
    await h.ok(ANNA, 'PUT', `lists/${first.lists[1].listId}/members`, { members: [MARC.id] });
    clock.set(T0 + 5 * MIN + 400);
    const none = await shop(h, ANNA, { since: '2026-11-08T10:04:00+01:00' });
    assert.deepEqual([none.lists.map((l) => l.id), none.items, none.serverTime], [[L1, L2], [], '2026-11-08T10:05:00+01:00']);
    await ops(h, ANNA, check(2), { op: 'clear_checked', listId: L1 }, { op: 'list_delete', id: L2 });
    const d = await shop(h, ANNA, { since: none.serverTime });
    assert.deepEqual(d.lists.map((l) => [l.id, l.deleted]), [[L1, false], [L2, true]]);
    assert.deepEqual(d.items.map((i) => [i.id, i.checked, i.deleted, i.updatedAt]), [[I(2), true, true, '2026-11-08T10:05:00+01:00']]);
    // Marc was a member: the tombstone is his as well; a stranger gets none
    assert.deepEqual((await shop(h, MARC, { since: '2026-11-08T09:05:00Z' })).lists.map((l) => [l.id, l.deleted]), [[L2, true]]);
    assert.deepEqual((await shop(h, BOB, { since: '2026-11-08T09:05:00Z' })).lists, []);
    assert.deepEqual((await shop(h, ANNA)).lists.map((l) => l.id), [L1]);
    for (const bad of ['gestern', '2026-11-08T10:05:00']) assert.equal((await h.call(ANNA, 'GET', 'shopping', undefined, { since: bad })).status, 400);
    // deleting it again does nothing; „Rückgängig“ brings the list back with its items and its member
    assert.deepEqual((await ops(h, ANNA, { op: 'list_delete', id: L2 })).rejected, []);
    await h.ok(ANNA, 'POST', `lists/${first.lists[1].listId}/restore`);
    const back = await shop(h, MARC);
    assert.deepEqual([back.lists.map((l) => [l.id, l.role]), texts(back, L2)], [[[L2, 'write']], [['Zahnpasta', null, false]]]);
    // tombstones of items go after 30 days
    clock.set(T0 + 31 * DAY);
    await h.host.tick();
    assert.deepEqual((await shop(h, ANNA, { since: '2026-11-08T09:00:00Z' })).items.map((i) => i.id), [I(1), I(3)]);
  } finally { await done(h); }
});

test('roles: read only looks, write ticks and writes, the owner renames and deletes; ids of others are not there to take', async () => {
  const h = await host();
  try {
    await ops(h, ANNA, add(L1, 'Einkauf'), item(1, L1, 'Milch'));
    const l = (await shop(h, ANNA)).lists[0];
    await h.ok(ANNA, 'PUT', `lists/${l.listId}/members`, { members: [{ id: MARC.id, role: 'write' }, { id: LENA.id, role: 'read' }] });
    const lena = await ops(h, LENA, check(1), item(2, L1, 'Kekse'), { op: 'item_edit', id: I(1), text: 'Kakao' }, { op: 'item_delete', id: I(1) }, { op: 'clear_checked', listId: L1 }, { op: 'list_rename', id: L1, name: 'Lenas' }, { op: 'list_delete', id: L1 });
    assert.deepEqual([lena.applied, lena.rejected.map((x) => x.code)], [0, ['forbidden', 'forbidden', 'forbidden', 'forbidden', 'forbidden', 'forbidden', 'forbidden']]);
    assert.deepEqual((await shop(h, LENA)).lists.map((x) => [x.role, x.canEdit, x.canManage]), [['read', false, false]]);
    const marc = await ops(h, MARC, check(1), item(2, L1, 'Kekse'), { op: 'list_rename', id: L1, name: 'Marcs' }, { op: 'list_delete', id: L1 });
    assert.deepEqual([marc.applied, marc.rejected], [2, [{ index: 2, code: 'forbidden' }, { index: 3, code: 'forbidden' }]]);
    // a stranger: the list and its items are not found; their ids cannot be taken over
    const bob = await ops(h, BOB, check(1), item(3, L1, 'Bier'), add(L1, 'Meins'), item(1, L1, 'Milch'), { op: 'list_delete', id: L1 });
    assert.deepEqual([bob.applied, bob.rejected.map((x) => x.code)], [0, ['not_found', 'not_found', 'forbidden', 'forbidden', 'not_found']]);
    const own = await ops(h, ANNA, { op: 'list_rename', id: L1, name: 'Wocheneinkauf', icon: 'cart' });
    assert.deepEqual(own.rejected, []);
    assert.deepEqual((await shop(h, MARC)).lists.map((x) => [x.name, x.icon, x.open, x.total]), [['Wocheneinkauf', 'cart', 1, 2]]);
    // a member leaves through the list route; the owner manages it there too
    assert.deepEqual(await h.ok(MARC, 'DELETE', 'lists/' + l.listId), { ok: true, left: true });
    assert.deepEqual((await shop(h, MARC)).lists, []);
    await h.ok(ANNA, 'PATCH', 'lists/' + l.listId, { days: [6], remind: '08:00' });
    assert.deepEqual((await shop(h, ANNA)).lists.map((x) => [x.days, x.remind]), [[[6], '08:00']]);
  } finally { await done(h); }
});

test('the family: Familie binds it, its rows come and go by their ids, Familie is told what changes here — not what it sent', async () => {
  const actions = [];
  const h = await host({ sources: familie((c) => {
    actions.push([c.user.id, c.payload.action, c.payload.listId, c.payload.body]);
    if (c.payload.action === 'going') return { ok: true, notified: 2, chat: null, family: { assignee: null, dueAt: null, going: [{ userId: c.user.id, at: '2026-11-08T09:00:00Z' }] } };
    return c.payload.body.userId === 99 ? { ok: false, code: 'invalid', field: 'userId' } : { ok: true, notified: { via: 'push', ok: true, code: null },
      family: { assignee: { userId: MARC.id, by: ANNA.id, at: '2026-11-08T09:00:00Z', state: 'open', notify: 'push' }, dueAt: '2026-11-08T17:00:00Z', going: [] } };
  }) });
  try {
    // not bound yet: nothing of Familie's is taken
    assert.deepEqual(await svc(h, 'shopping_put', { lists: [{ id: L1, name: 'Einkauf' }], items: [] }), { ok: false, code: 'not_found' });
    assert.deepEqual(await h.host.callService('shopping_bind', { caller: 'gatecontrol-mail', user: null, payload: { members: [1], parents: [1] } }), { ok: false, code: 'forbidden' });
    assert.deepEqual(await svc(h, 'shopping_bind', { members: [ANNA.id, MARC.id, LENA.id], parents: [] }), { ok: false, code: 'invalid', field: 'members' });
    assert.deepEqual(await svc(h, 'shopping_bind', { members: [ANNA.id, MARC.id, LENA.id], parents: [ANNA.id, MARC.id] }), { ok: true, lists: 0 });
    assert.deepEqual((await h.ok(LENA, 'GET', 'me')).shopping, { family: { available: true, bound: true, parent: false } });
    assert.equal((await h.ok(MARC, 'GET', 'me')).shopping.family.parent, true);
    const rows = {
      lists: [{ id: L1, name: 'Einkauf', icon: 'cart', sort: 0, deleted: false, by: MARC.id, assignee: null, dueAt: null, going: [] }, { id: L2, name: 'Drogerie', icon: 'tooth', sort: 1, by: LENA.id }],
      items: [{ id: I(1), listId: L1, text: 'Milch', qty: '2 l', checked: false, createdBy: MARC.id, createdAt: T0 - DAY }, { id: I(2), listId: L1, text: 'Brot', checked: true, checkedBy: LENA.id },
        { id: I(3), listId: L2, text: 'Seife' }, { id: I(4), listId: L3, text: 'Schrauben' }, { id: 'x', listId: L1, text: 'y' }],
    };
    const put = await svc(h, 'shopping_put', rows);
    assert.deepEqual(put, { ok: true, lists: 2, items: 3, rejected: [{ kind: 'item', id: I(4), code: 'not_found' }, { kind: 'item', id: 'x', code: 'invalid' }], completed: [] });
    // sent again (the move pressed twice): nothing is written, nothing is there twice
    assert.deepEqual([(await svc(h, 'shopping_put', rows)).lists, (await svc(h, 'shopping_put', rows)).items], [0, 0]);
    const g = await shop(h, LENA);
    // Marc's list is Marc's; a child's list belongs to the first parent; everybody of the family writes
    assert.deepEqual(g.lists.map((l) => [l.id, l.name, l.icon, l.owner.id, l.role, l.canEdit, l.canManage, l.family, l.open, l.total]),
      [[L1, 'Einkauf', 'cart', MARC.id, 'write', true, false, true, 1, 2], [L2, 'Drogerie', null, ANNA.id, 'write', true, false, true, 1, 1]]);
    assert.deepEqual(texts(g, L1), [['Milch', '2 l', false], ['Brot', null, true]]);
    assert.equal(told(h), 0, 'what Familie sent is not told back');
    // parents manage a family list whoever owns it, children do not
    assert.deepEqual((await ops(h, LENA, { op: 'list_rename', id: L1, name: 'Lenas' }, check(1))).rejected, [{ index: 0, code: 'forbidden' }]);
    assert.deepEqual((await ops(h, ANNA, { op: 'list_rename', id: L1, name: 'Wocheneinkauf' })).rejected, []);
    assert.equal((await shop(h, ANNA)).lists[0].canManage, true);
    await h.host.tick();
    assert.equal(told(h), 1, 'a change made here: Familie is told once');
    await h.host.tick();
    assert.equal(told(h), 1);
    // Familie reads: every family list, the items since
    const all = await svc(h, 'shopping_list', {});
    assert.deepEqual([all.ok, all.cursor, all.now], [true, null, T0]);
    assert.deepEqual(all.lists.map((l) => [l.id, l.name, l.icon, l.ownerId]), [[L1, 'Wocheneinkauf', 'cart', MARC.id], [L2, 'Drogerie', null, ANNA.id]]);
    assert.deepEqual(all.items.map((i) => [i.id, i.listId, i.text, i.qty, i.checked, i.checkedBy, i.deleted]),
      [[I(1), L1, 'Milch', '2 l', true, LENA.id, false], [I(2), L1, 'Brot', null, true, LENA.id, false], [I(3), L2, 'Seife', null, false, null, false]]);
    clock.set(T0 + MIN);
    await ops(h, MARC, { op: 'item_delete', id: I(3) }, add(L3, 'Baumarkt', { family: true }), item(5, L3, 'Dübel'));
    const delta = await svc(h, 'shopping_list', { since: T0 + 1 });
    assert.deepEqual([delta.lists.map((l) => l.id), delta.items.map((i) => [i.id, i.deleted])], [[L1, L2, L3], [[I(3), true], [I(5), false]]]);
    assert.deepEqual((await ops(h, LENA, add(I(77), 'Kinder', { family: true }))).rejected, [{ index: 0, code: 'forbidden' }], 'only parents share with the family');
    // „Ich gehe einkaufen“ / „Kannst du einkaufen gehen?“ go to Familie as the person; what it knows is shown
    const going = await h.ok(LENA, 'POST', `shopping/lists/${L1}/going`);
    assert.deepEqual([going.notified, going.chat, going.list.going], [2, null, [{ userId: LENA.id, at: '2026-11-08T09:00:00Z' }]]);
    const asked = await h.ok(ANNA, 'POST', `shopping/lists/${L1}/assign`, { userId: MARC.id, dueAt: '2026-11-08T17:00:00Z', notify: 'push' });
    assert.deepEqual([asked.notified, asked.list.assignee, asked.list.dueAt, asked.list.going],
      [{ via: 'push', ok: true, code: null }, { userId: MARC.id, by: ANNA.id, at: '2026-11-08T09:00:00Z', state: 'open', notify: 'push' }, '2026-11-08T17:00:00Z', []]);
    assert.deepEqual(actions, [[LENA.id, 'going', L1, {}], [ANNA.id, 'assign', L1, { userId: MARC.id, dueAt: '2026-11-08T17:00:00Z', notify: 'push' }]]);
    const refused = await h.call(ANNA, 'POST', `shopping/lists/${L1}/assign`, { userId: 99 });
    assert.deepEqual([refused.status, refused.json], [400, { ok: false, code: 'invalid', field: 'userId' }]);
    // a list of one's own is no family list until a parent says so
    await ops(h, MARC, add(I(50), 'Marcs Liste'));
    assert.deepEqual((await h.call(MARC, 'POST', `shopping/lists/${I(50)}/going`)).json, { ok: false, code: 'invalid', field: 'family' });
    const fam = await h.ok(MARC, 'PUT', `shopping/lists/${I(50)}/family`, { on: true });
    assert.deepEqual([fam.list.family, fam.list.members.map((m) => [m.id, m.role])], [true, [[ANNA.id, 'write'], [LENA.id, 'write']]]);
    assert.equal((await h.ok(MARC, 'PUT', `shopping/lists/${I(50)}/family`, { on: false })).list.family, false);
    assert.equal((await h.call(BOB, 'PUT', `shopping/lists/${I(50)}/family`, { on: true })).status, 404);
    // Lena leaves the family: she leaves its lists; Marc leaves: his list goes on with the first parent
    assert.deepEqual(await svc(h, 'shopping_bind', { members: [ANNA.id], parents: [ANNA.id] }), { ok: true, lists: 3 });
    assert.deepEqual((await shop(h, LENA)).lists, []);
    assert.deepEqual((await shop(h, MARC)).lists.map((l) => l.id), [I(50)]);
    assert.deepEqual((await shop(h, ANNA)).lists.map((l) => [l.id, l.role, l.owner.id]), [[L1, 'owner', ANNA.id], [L3, 'owner', ANNA.id], [L2, 'owner', ANNA.id]]);
    // Familie deletes a list: in the trash here; it lets go of the rest: ordinary lists
    assert.equal((await svc(h, 'shopping_put', { lists: [{ id: L2, name: 'Drogerie', deleted: true }], items: [] })).lists, 1);
    assert.deepEqual(await svc(h, 'shopping_bind', { release: true }), { ok: true, released: 3 });
    assert.deepEqual((await shop(h, ANNA)).lists.map((l) => [l.id, l.family]), [[L1, false], [L3, false]]);
    assert.deepEqual(await svc(h, 'shopping_list', {}), { ok: false, code: 'not_found' });
  } finally { await done(h); }
});

test('without Familie: going and assign answer unavailable, sharing with the family too', async () => {
  const h = await host();
  try {
    await ops(h, ANNA, add(L1, 'Einkauf'));
    assert.deepEqual((await h.call(ANNA, 'PUT', `shopping/lists/${L1}/family`, { on: true })).json, { ok: false, code: 'unavailable' });
    assert.deepEqual((await h.call(ANNA, 'POST', `shopping/lists/${L1}/going`)).json, { ok: false, code: 'invalid', field: 'family' });
    assert.deepEqual((await ops(h, ANNA, add(L2, 'Familie', { family: true }))).rejected, [{ index: 0, code: 'forbidden' }]);
  } finally { await done(h); }
});

test('the day of a shopping list: the card of „Mein Tag“ counts its open items', async () => {
  const h = await host();
  try {
    await ops(h, ANNA, add(L1, 'Einkauf', { icon: 'cart' }), item(1, L1, 'Milch', '2 l'), item(2, L1, 'Brot'), item(3, L1, 'Äpfel'), item(4, L1, 'Butter'), check(4));
    const l = (await shop(h, ANNA)).lists[0];
    await h.ok(ANNA, 'PATCH', 'lists/' + l.listId, { days: [7], remind: '10:00' });
    const md = await h.ok(ANNA, 'GET', 'views/myday');
    assert.deepEqual(md.listdays.map((d) => [d.title, d.open, d.more, d.shopping, d.points, d.list.kind, d.items]),
      [['Heute ist Einkaufstag', 3, 0, { id: L1 }, [{ id: I(1), text: 'Milch', qty: '2 l' }, { id: I(2), text: 'Brot', qty: null }, { id: I(3), text: 'Äpfel', qty: null }], 'shopping', []]]);
    await h.host.tick();
    const n = h.host.notifications.filter((x) => x.topic === 'listday');
    assert.deepEqual(n.map((x) => [x.title, x.body]), [['Heute ist Einkaufstag', 'Einkauf – 3 Dinge auf der Liste']]);
  } finally { await done(h); }
});
