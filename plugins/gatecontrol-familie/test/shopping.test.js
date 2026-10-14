'use strict';

// Shopping (offline-first): ops in order, idempotent replays, rejected ops
// with their index and code, since-sync with tombstones (kept 30 days),
// "Ich gehe einkaufen" (once per list, person and 15 minutes).

const test = require('node:test');
const assert = require('node:assert/strict');
const { withFamily, ANNA, MARC, LENA, TIM, MIN, DAY, pushes } = require('./helpers');

const L1 = '6f1c2a90-1111-4c1d-9a00-000000000001';
const L2 = '6f1c2a90-2222-4c1d-9a00-000000000002';
const I = (n) => `0a0b0c0d-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('ops: applied in order, ids from the client, everything not deleted without since', () => withFamily({}, async (host, { as }) => {
  const anna = as(ANNA);
  const r = await anna('POST', '/shopping/ops', { ops: [
    { op: 'list_add', id: L1, name: 'REWE', icon: 'cart' },
    { op: 'item_add', id: I(1), listId: L1, text: 'Milch', qty: '2×' },
    { op: 'item_add', id: I(2), listId: L1, text: 'Bananen' },
    { op: 'item_check', id: I(2), checked: true },
    { op: 'item_edit', id: I(1), qty: '3×' },
    { op: 'list_add', id: L2, name: 'Drogerie' },
  ] });
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.ok, r.json.applied, r.json.rejected, r.json.serverTime], [true, 6, [], '2026-10-14T08:00:00Z']);
  const g = await as(TIM)('GET', '/shopping');
  assert.deepEqual(g.json.lists.map((l) => [l.id, l.name, l.icon, l.sort, l.deleted]), [[L1, 'REWE', 'cart', 0, false], [L2, 'Drogerie', null, 1, false]]);
  assert.equal(g.json.lists[0].updatedAt, '2026-10-14T08:00:00Z');
  const milk = g.json.items.find((i) => i.id === I(1));
  assert.deepEqual(milk, { id: I(1), listId: L1, text: 'Milch', qty: '3×', checked: false, checkedBy: null, updatedAt: '2026-10-14T08:00:00Z', deleted: false });
  assert.deepEqual([g.json.items.find((i) => i.id === I(2)).checked, g.json.items.find((i) => i.id === I(2)).checkedBy], [true, ANNA.id]);
  const ov = await anna('GET', '/overview');
  assert.deepEqual(ov.json.shopping.lists, [{ id: L1, name: 'REWE', icon: 'cart', open: 1 }, { id: L2, name: 'Drogerie', icon: null, open: 0 }]);
}));

test('ops: idempotent — a replayed outbox never duplicates; rejected ops carry index and code', () => withFamily({}, async (host, { as }) => {
  const batch = { ops: [
    { op: 'list_add', id: L1, name: 'REWE' },
    { op: 'item_add', id: I(1), listId: L1, text: 'Milch' },
    { op: 'item_add', id: I(2), listId: L1, text: 'Brot' },
  ] };
  await as(ANNA)('POST', '/shopping/ops', batch);
  const again = await as(ANNA)('POST', '/shopping/ops', batch);
  assert.deepEqual([again.json.applied, again.json.rejected], [3, []], 'replay counts as applied');
  const g = await as(ANNA)('GET', '/shopping');
  assert.equal(g.json.lists.length, 1);
  assert.equal(g.json.items.length, 2);

  const r = await as(MARC)('POST', '/shopping/ops', { ops: [
    { op: 'item_add', id: I(3), listId: 'ffffffff-unknown', text: 'Eier' },           // 0: no such list
    { op: 'item_add', id: I(4), listId: L1, text: 'x'.repeat(121) },                  // 1: too long
    { op: 'item_add', id: I(5), listId: L1, text: 'Käse', qty: 'q'.repeat(41) },     // 2: qty too long
    { op: 'list_add', id: '6f1c2a90-3333-4c1d-9a00-000000000003', name: 'n'.repeat(41) }, // 3: name too long
    { op: 'teleport', id: I(6) },                                                     // 4: unknown op
    { op: 'item_edit', id: I(99), text: 'nope' },                                     // 5: unknown item
    { op: 'item_check', id: I(1), checked: 'yes' },                                   // 6: not a boolean
    { op: 'list_rename', id: L1, name: 'Supermarkt' },                                // 7: ok
    { op: 'item_add', id: 'bad id', listId: L1, text: 'x' },                          // 8: invalid id
    null,                                                                             // 9: garbage
  ] });
  assert.equal(r.json.applied, 1);
  assert.deepEqual(r.json.rejected, [
    { index: 0, code: 'not_found' }, { index: 1, code: 'invalid' }, { index: 2, code: 'invalid' }, { index: 3, code: 'invalid' },
    { index: 4, code: 'invalid' }, { index: 5, code: 'not_found' }, { index: 6, code: 'invalid' }, { index: 8, code: 'invalid' }, { index: 9, code: 'invalid' },
  ]);
  assert.equal((await as(MARC)('POST', '/shopping/ops', { ops: new Array(201).fill({ op: 'list_add', id: L2, name: 'x' }) })).json.code, 'invalid', '≤ 200 ops');
  assert.equal((await as(MARC)('POST', '/shopping/ops', {})).status, 400);
  assert.equal((await as(MARC)('GET', '/shopping')).json.lists[0].name, 'Supermarkt');
}));

test('last write wins by arrival: a later op overwrites, an op on a deleted item is rejected', () => withFamily({}, async (host, { as, clock }) => {
  await as(ANNA)('POST', '/shopping/ops', { ops: [{ op: 'list_add', id: L1, name: 'REWE' }, { op: 'item_add', id: I(1), listId: L1, text: 'Milch' }] });
  clock.add(MIN);
  await as(MARC)('POST', '/shopping/ops', { ops: [{ op: 'item_edit', id: I(1), text: 'Hafermilch' }] });
  clock.add(MIN);
  await as(LENA)('POST', '/shopping/ops', { ops: [{ op: 'item_edit', id: I(1), text: 'Milch 1,5 %' }] });
  assert.equal((await as(ANNA)('GET', '/shopping')).json.items[0].text, 'Milch 1,5 %');
  await as(MARC)('POST', '/shopping/ops', { ops: [{ op: 'item_delete', id: I(1) }] });
  const late = await as(ANNA)('POST', '/shopping/ops', { ops: [{ op: 'item_check', id: I(1), checked: true }, { op: 'item_delete', id: I(1) }] });
  assert.deepEqual(late.json.rejected, [{ index: 0, code: 'not_found' }]);
  assert.equal(late.json.applied, 1, 'deleting twice is fine');
}));

test('since: changes including tombstones; deleted lists take their items; tombstones go after 30 days', () => withFamily({}, async (host, { as, clock }) => {
  await as(ANNA)('POST', '/shopping/ops', { ops: [
    { op: 'list_add', id: L1, name: 'REWE' }, { op: 'list_add', id: L2, name: 'Drogerie' },
    { op: 'item_add', id: I(1), listId: L1, text: 'Milch' }, { op: 'item_add', id: I(2), listId: L1, text: 'Brot' },
    { op: 'item_add', id: I(3), listId: L2, text: 'Zahnpasta' },
  ] });
  const first = await as(TIM)('GET', '/shopping');
  const since = first.json.serverTime;
  clock.add(5 * MIN + 400);
  assert.deepEqual((await as(TIM)('GET', '/shopping', null, { since: '2026-10-14T08:04:00Z' })).json, { ok: true, lists: [], items: [], serverTime: '2026-10-14T08:05:00Z' }, 'nothing changed');
  await as(MARC)('POST', '/shopping/ops', { ops: [{ op: 'item_check', id: I(2), checked: true }, { op: 'clear_checked', listId: L1 }, { op: 'list_delete', id: L2 }] });
  const d = await as(TIM)('GET', '/shopping', null, { since: '2026-10-14T08:05:00Z' });
  assert.deepEqual(d.json.lists.map((l) => [l.id, l.deleted]), [[L2, true]]);
  assert.deepEqual(d.json.items.map((i) => [i.id, i.deleted]).sort(), [[I(2), true], [I(3), true]], 'cleared item and the deleted list\'s item');
  assert.ok(Date.parse(since) <= Date.parse(d.json.serverTime));
  // without since: no tombstones
  const all = await as(TIM)('GET', '/shopping');
  assert.deepEqual([all.json.lists.map((l) => l.id), all.json.items.map((i) => i.id)], [[L1], [I(1)]]);
  assert.equal((await as(TIM)('GET', '/shopping', null, { since: 'yesterday' })).json.code, 'invalid');
  // retention: tombstones are purged after 30 days (background, hourly)
  clock.add(29 * DAY);
  await host.tick();
  assert.equal((await as(TIM)('GET', '/shopping', null, { since: '2026-10-01T00:00:00Z' })).json.items.filter((i) => i.deleted).length, 2);
  clock.add(2 * DAY);
  await host.tick();
  const after = await as(TIM)('GET', '/shopping', null, { since: '2026-10-01T00:00:00Z' });
  assert.deepEqual([after.json.lists.map((l) => l.id), after.json.items.map((i) => i.id)], [[L1], [I(1)]], 'tombstones gone, live rows stay');
}));

test('"Ich gehe einkaufen": push to the other members, once per list and person in 15 minutes', () => withFamily({}, async (host, { as, clock }) => {
  await as(MARC)('POST', '/shopping/ops', { ops: [{ op: 'list_add', id: L1, name: 'REWE' }, { op: 'item_add', id: I(1), listId: L1, text: 'Milch' }, { op: 'item_add', id: I(2), listId: L1, text: 'Brot' }] });
  const r = await as(MARC)('POST', `/shopping/lists/${L1}/going`);
  assert.deepEqual(r.json, { ok: true, notified: 3 });
  const p = pushes(host, 'shopping_going');
  assert.equal(p.length, 1);
  assert.deepEqual(p[0].users.sort(), [ANNA.id, LENA.id, TIM.id]);
  assert.equal(p[0].topic, 'shopping');
  assert.equal(p[0].title, 'Marc geht einkaufen (REWE-Liste) – fehlt noch etwas?');
  assert.equal(p[0].body, '2 Dinge stehen schon drauf.');
  assert.equal(p[0].collapseKey, `going:${L1}`);
  assert.deepEqual(p[0].data.familie, { type: 'shopping_going', listId: L1, userId: MARC.id });
  clock.add(14 * MIN);
  const again = await as(MARC)('POST', `/shopping/lists/${L1}/going`);
  assert.deepEqual([again.status, again.json.code, again.json.retryAfter], [429, 'too_soon', 60]);
  assert.equal((await as(ANNA)('POST', `/shopping/lists/${L1}/going`)).status, 200, 'someone else may');
  clock.add(MIN);
  assert.equal((await as(MARC)('POST', `/shopping/lists/${L1}/going`)).status, 200);
  assert.equal((await as(MARC)('POST', '/shopping/lists/ffffffff-none/going')).status, 404);
  const ov = await as(LENA)('GET', '/overview');
  assert.deepEqual(ov.json.shopping.going.map((g) => g.userId), [MARC.id, ANNA.id]);
}));
