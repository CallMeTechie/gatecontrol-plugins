'use strict';

// Wishlists (module wishes, default on): every member's list; the owner (and
// parents for a child) edit; anyone else reserves — and the owner NEVER sees
// a reservation of their own items, in no answer at all.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withFamily, ANNA, MARC, LENA, TIM } = require('./helpers');

/** Every item of `userId`'s own list in every shape an answer can have. */
function ownItems(json, userId) {
  if (json.lists) return json.lists.find((l) => l.ownerId === userId).items;
  return json.item ? [json.item] : [];
}

test('create and edit: the owner, parents also a child\'s list; https links only; the shape', () => withFamily({}, async (host, { as }) => {
  const r = await as(LENA)('POST', '/wishes', { title: 'Kopfhörer (kabellos)', url: 'https://example.com/kopfhoerer', priceCents: 6000, occasion: 'birthday', note: 'blau' });
  assert.equal(r.status, 200);
  const w = r.json.item;
  assert.deepEqual({ ...w, id: 0, createdAt: null }, {
    id: 0, ownerId: LENA.id, title: 'Kopfhörer (kabellos)', url: 'https://example.com/kopfhoerer', priceCents: 6000, note: 'blau', occasion: 'birthday', sort: 0,
    createdAt: null, reservedBy: null, reservedAt: null, reservedByMe: false, gotIt: false,
  });
  assert.equal((await as(LENA)('POST', '/wishes', { title: 'Buch' })).json.item.sort, 1);
  for (const bad of [{ title: '' }, { title: 'x', url: 'http://example.com' }, { title: 'x', url: 'javascript:alert(1)' }, { title: 'x', url: 'https://' + 'a'.repeat(300) + '.de' },
    { title: 'x', priceCents: -1 }, { title: 'x', occasion: 'easter' }, { title: 'x'.repeat(81) }, { title: 'x', note: 'n'.repeat(201) }]) {
    assert.equal((await as(LENA)('POST', '/wishes', bad)).json.code, 'invalid', JSON.stringify(bad));
  }
  // parents for a child, not for another parent; children never for others
  assert.equal((await as(ANNA)('POST', '/wishes', { title: 'Fahrradhelm', ownerId: TIM.id })).json.item.ownerId, TIM.id);
  assert.equal((await as(ANNA)('POST', '/wishes', { title: 'x', ownerId: MARC.id })).json.code, 'forbidden');
  assert.equal((await as(LENA)('POST', '/wishes', { title: 'x', ownerId: TIM.id })).json.code, 'forbidden');
  assert.equal((await as(MARC)('PATCH', `/wishes/${w.id}`, { priceCents: 5500 })).json.item.priceCents, 5500, 'a parent edits a child\'s wish');
  assert.equal((await as(TIM)('PATCH', `/wishes/${w.id}`, { title: 'x' })).json.code, 'forbidden');
  assert.equal((await as(TIM)('DELETE', `/wishes/${w.id}`)).json.code, 'forbidden');
  const g = (await as(TIM)('GET', '/wishes')).json;
  assert.deepEqual(g.lists.map((l) => [l.ownerId, l.items.length]), [[ANNA.id, 0], [MARC.id, 0], [LENA.id, 2], [TIM.id, 1]]);
  assert.equal((await as(LENA)('DELETE', `/wishes/${w.id}`)).status, 200);
  assert.equal((await as(LENA)('DELETE', `/wishes/${w.id}`)).status, 404);
}));

test('reservations: anyone but the owner, one at a time; never visible to the owner', () => withFamily({}, async (host, { as }) => {
  const w = (await as(LENA)('POST', '/wishes', { title: 'Buch: „Die drei ???“ Band 230', priceCents: 1200 })).json.item;
  assert.equal((await as(LENA)('POST', `/wishes/${w.id}/reserve`)).json.code, 'forbidden', 'not the owner');
  const r = (await as(ANNA)('POST', `/wishes/${w.id}/reserve`)).json.item;
  assert.deepEqual([r.reservedBy, r.reservedByMe, typeof r.reservedAt], [ANNA.id, true, 'string']);
  assert.equal((await as(ANNA)('POST', `/wishes/${w.id}/reserve`)).status, 200, 'again: fine');
  assert.deepEqual([(await as(TIM)('POST', `/wishes/${w.id}/reserve`)).status, (await as(TIM)('POST', `/wishes/${w.id}/reserve`)).json.code], [409, 'already_taken']);
  const tim = (await as(TIM)('GET', '/wishes')).json.lists.find((l) => l.ownerId === LENA.id).items[0];
  assert.deepEqual([tim.reservedBy, tim.reservedByMe], [ANNA.id, false], 'the others see who gets it');
  assert.equal((await as(TIM)('POST', `/wishes/${w.id}/unreserve`)).json.code, 'forbidden', 'only who reserved it');
  // the owner: in GET, after PATCH, with ?gotIt=1 — nothing, ever
  const answers = [
    await as(LENA)('GET', '/wishes'), await as(LENA)('GET', '/wishes', null, { gotIt: '1' }),
    await as(LENA)('PATCH', `/wishes/${w.id}`, { note: 'Taschenbuch' }), await as(LENA)('PATCH', `/wishes/${w.id}`, { sort: 3 }),
  ];
  for (const a of answers) {
    for (const it of ownItems(a.json, LENA.id)) {
      assert.deepEqual([it.reservedBy, it.reservedAt, it.reservedByMe], [null, null, false], JSON.stringify(a.json));
      assert.ok(!JSON.stringify(it).includes(String(ANNA.id) + ','), 'no id of the reserver');
    }
  }
  assert.ok(!JSON.stringify((await as(LENA)('GET', '/wishes')).json).includes('"reservedBy":2'), 'nowhere in the answer');
  // a parent editing the child's wish sees it (not the owner)
  assert.equal((await as(MARC)('PATCH', `/wishes/${w.id}`, { note: 'x' })).json.item.reservedBy, ANNA.id);
  // the owner's overview counts its own wishes, not the reservations
  assert.deepEqual((await as(LENA)('GET', '/overview')).json.wishes, { mine: 1, reservedByMe: 0 });
  assert.deepEqual((await as(ANNA)('GET', '/overview')).json.wishes, { mine: 0, reservedByMe: 1 });
  // release
  const u = (await as(ANNA)('POST', `/wishes/${w.id}/unreserve`)).json.item;
  assert.deepEqual([u.reservedBy, u.reservedByMe], [null, false]);
  assert.equal((await as(TIM)('POST', `/wishes/${w.id}/reserve`)).json.item.reservedBy, TIM.id);
}));

test('gotIt after the occasion hides the wish (unless ?gotIt=1); it cannot be reserved any more', () => withFamily({}, async (host, { as }) => {
  const w = (await as(TIM)('POST', '/wishes', { title: 'Lego', occasion: 'christmas' })).json.item;
  assert.equal((await as(TIM)('PATCH', `/wishes/${w.id}`, { gotIt: true })).json.item.gotIt, true);
  assert.equal((await as(ANNA)('GET', '/wishes')).json.lists.find((l) => l.ownerId === TIM.id).items.length, 0);
  assert.equal((await as(ANNA)('GET', '/wishes', null, { gotIt: 'true' })).json.lists.find((l) => l.ownerId === TIM.id).items.length, 1);
  assert.equal((await as(ANNA)('POST', `/wishes/${w.id}/reserve`)).json.code, 'invalid');
  assert.equal((await as(TIM)('PATCH', `/wishes/${w.id}`, { gotIt: 'yes' })).json.code, 'invalid');
}));
