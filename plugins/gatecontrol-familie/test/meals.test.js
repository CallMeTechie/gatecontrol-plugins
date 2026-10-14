'use strict';

// Meal plan (module meals): ISO weeks, planning a meal, ingredients onto a
// shopping list without duplicates (case-insensitive, open items only), the
// overview and the wall ("Essen: Pfannkuchen").

const test = require('node:test');
const assert = require('node:assert/strict');
const { withFamily, ANNA, LENA, TIM, KUECHE, portal } = require('./helpers');
const meals = require('../server/meals');

const ON = { settings: { mod_meals: true } };
const L1 = 'list-0000-0001';

test('ISO weeks', () => {
  assert.equal(meals.weekOf('2026-10-14'), '2026-W42');
  assert.equal(meals.mondayOf('2026-W42'), '2026-10-12');
  assert.equal(meals.weekOf('2027-01-01'), '2026-W53', '1 Jan 2027 (Friday) is in 2026-W53');
  assert.equal(meals.mondayOf('2026-W53'), '2026-12-28');
  assert.equal(meals.weekOf('2024-12-30'), '2025-W01');
  assert.equal(meals.mondayOf('2025-W01'), '2024-12-30');
  for (const bad of ['2025-W53', '2026-W00', '2026-42', 'W42']) assert.throws(() => meals.mondayOf(bad), { code: 'invalid' }, bad);
});

test('plan the week: PUT / GET / DELETE; validation; every member', () => withFamily(ON, async (host, { as }) => {
  const r = await as(LENA)('PUT', '/meals/2026-10-14/dinner', { title: 'Pfannkuchen', cook: ANNA.id, ingredients: ['Mehl', 'Milch', 'Eier'], note: 'mit Apfelmus' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, date: '2026-10-14', slot: 'dinner', meal: { title: 'Pfannkuchen', note: 'mit Apfelmus', cook: ANNA.id, ingredients: ['Mehl', 'Milch', 'Eier'], updatedAt: '2026-10-14T08:00:00Z', updatedBy: LENA.id } });
  await as(TIM)('PUT', '/meals/2026-10-16/lunch', { title: 'Nudeln' });
  for (const [p, b] of [['/meals/2026-10-14/dinner', { title: '' }], ['/meals/2026-10-14/dinner', { title: 'x'.repeat(61) }], ['/meals/2026-10-14/dinner', { title: 'x', cook: 99 }],
    ['/meals/2026-10-14/dinner', { title: 'x', ingredients: ['y'.repeat(61)] }], ['/meals/2026-10-14/dinner', { title: 'x', note: 'n'.repeat(201) }], ['/meals/2026-02-30/dinner', { title: 'x' }]]) {
    assert.equal((await as(ANNA)('PUT', p, b)).json.code, 'invalid', `${p} ${JSON.stringify(b)}`);
  }
  assert.equal((await as(ANNA)('PUT', '/meals/2026-10-14/breakfast', { title: 'x' })).status, 404);
  const g = (await as(TIM)('GET', '/meals')).json;
  assert.equal(g.week, '2026-W42');
  assert.deepEqual(g.days.map((d) => d.date), ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18']);
  assert.deepEqual([g.days[2].dinner.title, g.days[2].lunch, g.days[4].lunch.title, g.days[4].lunch.cook], ['Pfannkuchen', null, 'Nudeln', null]);
  assert.equal((await as(TIM)('GET', '/meals', null, { week: '2026-W43' })).json.days[0].date, '2026-10-19');
  assert.equal((await as(TIM)('GET', '/meals', null, { week: '2026-43' })).json.code, 'invalid');
  assert.deepEqual((await as(ANNA)('GET', '/overview')).json.meals, { date: '2026-10-14', lunch: null, dinner: g.days[2].dinner });
  assert.equal((await as(ANNA)('DELETE', '/meals/2026-10-16/lunch')).status, 200);
  assert.equal((await as(ANNA)('DELETE', '/meals/2026-10-16/lunch')).status, 404);
}));

test('ingredients onto the shopping list: dedup by text (case-insensitive), open items only', () => withFamily(ON, async (host, { as, admin }) => {
  await as(ANNA)('POST', '/shopping/ops', { ops: [
    { op: 'list_add', id: L1, name: 'REWE' },
    { op: 'item_add', id: 'item-0000-0001', listId: L1, text: 'milch' },
    { op: 'item_add', id: 'item-0000-0002', listId: L1, text: 'Eier' },
    { op: 'item_check', id: 'item-0000-0002', checked: true },
  ] });
  await as(ANNA)('PUT', '/meals/2026-10-14/dinner', { title: 'Pfannkuchen', ingredients: ['Mehl', 'Milch', 'Eier', 'mehl', 'Zucker'] });
  const r = (await as(TIM)('POST', '/meals/2026-10-14/dinner/to-shopping', { listId: L1 })).json;
  assert.deepEqual([r.added, r.skipped, r.itemIds.length], [3, 2, 3]);
  const items = (await as(TIM)('GET', '/shopping')).json.items.filter((i) => !i.checked).map((i) => i.text);
  assert.deepEqual(items, ['milch', 'Mehl', 'Eier', 'Zucker'], 'Milch was open already, Eier only checked off, mehl twice');
  assert.equal((await as(TIM)('POST', '/meals/2026-10-14/dinner/to-shopping', { listId: L1 })).json.added, 0, 'again: nothing new');
  assert.equal((await as(TIM)('POST', '/meals/2026-10-14/lunch/to-shopping', { listId: L1 })).status, 404, 'no meal');
  assert.equal((await as(TIM)('POST', '/meals/2026-10-14/dinner/to-shopping', { listId: 'list-0000-9999' })).status, 404);
  assert.equal((await as(TIM)('POST', '/meals/2026-10-14/dinner/to-shopping', {})).json.code, 'invalid');
  await admin('PUT', 'modules', { shopping: false });
  assert.equal((await as(TIM)('POST', '/meals/2026-10-14/dinner/to-shopping', { listId: L1 })).json.code, 'module_off');
}));

test('the wall shows today\'s meals; meals go after 90 days', () => withFamily({ settings: { mod_meals: true, mod_wall: true } }, async (host, { as, admin, call, clock }) => {
  await admin('POST', 'members', { userId: KUECHE.id, role: 'wall' });
  assert.equal((await call(portal(KUECHE), 'GET', '/wall')).json.meals.dinner, null);
  await as(ANNA)('PUT', '/meals/2026-10-14/dinner', { title: 'Pfannkuchen', cook: ANNA.id });
  const w = (await call(portal(KUECHE), 'GET', '/wall')).json;
  assert.deepEqual([w.modules.meals, w.meals.date, w.meals.dinner.title, w.meals.dinner.cook], [true, '2026-10-14', 'Pfannkuchen', ANNA.id]);
  assert.equal((await call(portal(KUECHE), 'PUT', '/meals/2026-10-15/dinner', { title: 'x' })).json.code, 'forbidden', 'the wall reads only');
  await admin('PUT', 'modules', { meals: false });
  assert.equal((await call(portal(KUECHE), 'GET', '/wall')).json.meals, null);
  await admin('PUT', 'modules', { meals: true });
  clock.add(91 * 86400000);
  await host.tick();
  assert.equal((await as(ANNA)('GET', '/meals', null, { week: '2026-W42' })).json.days[2].dinner, null);
}));
