'use strict';

// Household book (module expenses, parents only, bookkeeping only): totals per
// month and category, the settlement between 2 parents (one transfer) and 3
// parents (the fewest transfers, cents that do not divide), "Erledigt" as a
// record, a change reopening a settled month.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withFamily, ANNA, MARC, LENA, TIM, OMA } = require('./helpers');
const expenses = require('../server/expenses');

const ON = { settings: { mod_expenses: true } };
const e = (paidBy, cents, shared = true) => ({ paidBy, cents, shared });

test('settle (pure): 2 parents → one transfer; 3 parents → the fewest; remainders; not shared and others ignored', () => {
  assert.deepEqual(expenses.settle([2, 3], [e(2, 6340), e(3, 2185), e(2, 4500), e(3, 999, false), e(9, 5000)]).transfers, [{ from: 3, to: 2, cents: 4327 }]);
  // 10877 shared: 5439 / 5438 (the first parent takes the odd cent)
  const two = expenses.settle([2, 3], [e(2, 10877)]);
  assert.deepEqual(two.balances, [{ userId: 2, paidCents: 10877, shareCents: 5439, balanceCents: 5438 }, { userId: 3, paidCents: 0, shareCents: 5438, balanceCents: -5438 }]);
  assert.deepEqual(expenses.settle([2, 3], [e(2, 500), e(3, 500)]).transfers, [], 'even');
  assert.deepEqual(expenses.settle([2], [e(2, 500)]).transfers, [], 'one parent: nothing to settle');
  // 3 parents: 9000 / 3 = 3000 each; A paid 9000 → B and C pay 3000 each
  assert.deepEqual(expenses.settle([2, 3, 6], [e(2, 9000)]).transfers, [{ from: 3, to: 2, cents: 3000 }, { from: 6, to: 2, cents: 3000 }]);
  // equal and opposite amounts settle directly: A +2000, B −2000, C 0
  assert.deepEqual(expenses.settle([2, 3, 6], [e(2, 5000), e(6, 3000), e(3, 1000)]).transfers, [{ from: 3, to: 2, cents: 2000 }]);
  // 100 cents among 3: 34 / 33 / 33; C paid all
  const three = expenses.settle([2, 3, 6], [e(6, 100)]);
  assert.deepEqual(three.balances.map((b) => b.shareCents), [34, 33, 33]);
  assert.deepEqual(three.transfers, [{ from: 2, to: 6, cents: 34 }, { from: 3, to: 6, cents: 33 }]);
  // the transfers always even everything out
  const four = expenses.settle([1, 2, 3, 4], [e(1, 1234), e(2, 9876), e(3, 555), e(4, 1)]);
  const bal = new Map(four.balances.map((b) => [b.userId, b.balanceCents]));
  for (const t of four.transfers) { bal.set(t.from, bal.get(t.from) + t.cents); bal.set(t.to, bal.get(t.to) - t.cents); }
  assert.ok([...bal.values()].every((v) => v === 0));
  assert.ok(four.transfers.length <= 3);
});

test('parents only; validation; month view with totals by category and the settlement of 2 parents', () => withFamily(ON, async (host, { as }) => {
  for (const [m, p, b] of [['GET', '/expenses'], ['POST', '/expenses', { cents: 100, category: 'food' }], ['POST', '/expenses/settle', {}], ['DELETE', '/expenses/1']]) {
    assert.equal((await as(LENA)(m, p, b)).json.code, 'parents_only', `${m} ${p}`);
  }
  for (const bad of [{ cents: 0, category: 'food' }, { cents: 100 }, { cents: 100, category: 'toys' }, { cents: 100, category: 'food', paidBy: TIM.id }, { cents: 100, category: 'food', date: '2026-13-01' },
    { cents: 100, category: 'food', note: 'x'.repeat(81) }, { cents: 100, category: 'food', shared: 'yes' }]) {
    assert.equal((await as(ANNA)('POST', '/expenses', bad)).json.code, 'invalid', JSON.stringify(bad));
  }
  const x = (await as(MARC)('POST', '/expenses', { cents: 6340, category: 'food', note: 'REWE – Wocheneinkauf', listId: 'list-0000-0001' })).json.expense;
  assert.deepEqual({ ...x, id: 0, createdAt: null }, { id: 0, cents: 6340, category: 'food', paidBy: MARC.id, date: '2026-10-14', note: 'REWE – Wocheneinkauf', shared: true, listId: 'list-0000-0001', createdBy: MARC.id, createdAt: null });
  await as(ANNA)('POST', '/expenses', { cents: 4500, category: 'kids', note: 'Schwimmkurs Tim', date: '2026-10-12' });
  await as(ANNA)('POST', '/expenses', { cents: 2185, category: 'household', date: '2026-10-10' });
  await as(ANNA)('POST', '/expenses', { cents: 3000, category: 'leisure', shared: false });
  await as(ANNA)('POST', '/expenses', { cents: 999, category: 'food', date: '2026-09-30' });
  const g = (await as(ANNA)('GET', '/expenses')).json;
  assert.equal(g.month, '2026-10');
  assert.deepEqual(g.expenses.map((y) => y.cents), [3000, 6340, 4500, 2185], 'newest date first');
  assert.deepEqual(g.totals, { all: 16025, shared: 13025, byCategory: { food: 6340, kids: 4500, household: 2185, leisure: 3000, mobility: 0, other: 0 } });
  // shared 13025: Anna 6685 paid, Marc 6340 — shares 6513 / 6512 → Marc pays Anna 172
  assert.deepEqual(g.settlement, { from: MARC.id, to: ANNA.id, cents: 172 });
  assert.deepEqual(g.transfers, [g.settlement]);
  assert.deepEqual([g.settled, g.settledAt, g.settledBy], [false, null, null]);
  assert.equal((await as(ANNA)('GET', '/expenses', null, { month: '2026-09' })).json.totals.all, 999);
  assert.equal((await as(ANNA)('GET', '/expenses', null, { month: '2026-9' })).json.code, 'invalid');
  // settle: a record; a change reopens the month
  const s = (await as(ANNA)('POST', '/expenses/settle', { month: '2026-10' })).json;
  assert.deepEqual([s.settled, s.settledBy, s.settledTransfers], [true, ANNA.id, [{ from: MARC.id, to: ANNA.id, cents: 172 }]]);
  assert.equal((await as(MARC)('POST', '/expenses/settle', { month: '2026-10' })).json.settledBy, ANNA.id, 'idempotent');
  assert.deepEqual((await as(ANNA)('GET', '/overview')).json.expenses, { month: '2026-10', totalCents: 16025, sharedCents: 13025, settlement: { from: MARC.id, to: ANNA.id, cents: 172 }, settled: true });
  await as(MARC)('PATCH', `/expenses/${x.id}`, { cents: 6400 });
  assert.equal((await as(ANNA)('GET', '/expenses')).json.settled, false, 'reopened');
  await as(ANNA)('POST', '/expenses/settle', {});
  assert.equal((await as(ANNA)('POST', '/expenses/unsettle', { month: '2026-10' })).json.settled, false, 'undo (addition)');
  assert.equal((await as(ANNA)('DELETE', `/expenses/${x.id}`)).status, 200);
  assert.equal((await as(ANNA)('DELETE', `/expenses/${x.id}`)).status, 404);
}));

test('3 parents: transfers, no single settlement', () => withFamily(ON, async (host, { as, admin }) => {
  await admin('POST', 'members', { userId: OMA.id, role: 'parent' });
  await as(ANNA)('POST', '/expenses', { cents: 9000, category: 'food' });
  const g = (await as(OMA)('GET', '/expenses')).json;
  assert.deepEqual(g.transfers, [{ from: MARC.id, to: ANNA.id, cents: 3000 }, { from: OMA.id, to: ANNA.id, cents: 3000 }]);
  assert.equal(g.settlement, null);
  assert.deepEqual(g.balances.map((b) => [b.userId, b.balanceCents]), [[ANNA.id, 6000], [MARC.id, -3000], [OMA.id, -3000]]);
  await as(MARC)('POST', '/expenses', { cents: 3000, category: 'food' });
  await as(OMA)('POST', '/expenses', { cents: 3000, category: 'other' });
  // 15000 / 3: Anna +4000, Marc −2000, Oma −2000
  assert.deepEqual((await as(ANNA)('GET', '/expenses')).json.transfers, [{ from: MARC.id, to: ANNA.id, cents: 2000 }, { from: OMA.id, to: ANNA.id, cents: 2000 }]);
}));
