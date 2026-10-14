'use strict';

// Pinboard & packing lists (module board, default on): notes (everyone writes,
// the author and parents delete, expired ones disappear), checklists with
// item ops like shopping, templates from a checklist and checklists from a
// template, the overview card.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withFamily, ANNA, MARC, LENA, TIM, HOUR } = require('./helpers');

test('notes: everyone writes and edits, the author and parents delete; pinned first; validation', () => withFamily({}, async (host, { as }) => {
  const n1 = (await as(TIM)('POST', '/board/notes', { text: 'Fußball fällt aus\nam Dienstag' })).json.note;
  assert.deepEqual({ ...n1, id: 0 }, { id: 0, text: 'Fußball fällt aus\nam Dienstag', color: 'yellow', pinned: false, authorId: TIM.id, createdAt: '2026-10-14T08:00:00Z', updatedAt: '2026-10-14T08:00:00Z', expiresAt: null });
  const n2 = (await as(ANNA)('POST', '/board/notes', { text: 'WLAN: Gast-Netz', color: 'blue', pinned: true })).json.note;
  for (const bad of [{ text: '' }, { text: 'x'.repeat(501) }, { text: 'x', color: 'red' }, { text: 'x', pinned: 1 }, { text: 'x', expiresAt: '2026-10-13T00:00:00Z' }, { text: 'x', expiresAt: 'morgen' }]) {
    assert.equal((await as(LENA)('POST', '/board/notes', bad)).json.code, 'invalid', JSON.stringify(bad));
  }
  assert.deepEqual((await as(LENA)('GET', '/board/notes')).json.notes.map((n) => n.id), [n2.id, n1.id], 'pinned first');
  assert.equal((await as(LENA)('PATCH', `/board/notes/${n1.id}`, { pinned: true, color: 'green' })).json.note.color, 'green', 'anyone edits');
  assert.equal((await as(LENA)('DELETE', `/board/notes/${n1.id}`)).json.code, 'forbidden', 'not the author');
  assert.equal((await as(TIM)('DELETE', `/board/notes/${n2.id}`)).json.code, 'forbidden');
  assert.equal((await as(MARC)('DELETE', `/board/notes/${n1.id}`)).status, 200, 'a parent');
  assert.equal((await as(ANNA)('DELETE', `/board/notes/${n2.id}`)).status, 200, 'the author');
  assert.equal((await as(ANNA)('DELETE', `/board/notes/${n2.id}`)).status, 404);
}));

test('notes expire: hidden at once, deleted by the tick', () => withFamily({}, async (host, { as, clock }) => {
  const n = (await as(ANNA)('POST', '/board/notes', { text: 'Paket beim Nachbarn', expiresAt: '2026-10-14T20:00:00Z' })).json.note;
  assert.equal(n.expiresAt, '2026-10-14T20:00:00Z');
  assert.deepEqual((await as(ANNA)('GET', '/overview')).json.board, { pinned: 0, notes: 1, openChecklists: 0 });
  clock.add(12 * HOUR + 1000);
  assert.equal((await as(ANNA)('GET', '/board')).json.notes.length, 0);
  assert.equal((await as(ANNA)('PATCH', `/board/notes/${n.id}`, { text: 'x' })).status, 404);
  await host.tick();
  assert.equal((await host.gc.db.get('SELECT COUNT(*) AS n FROM board_notes')).row.n, 0, 'deleted');
}));

test('checklists and templates: from a title or a template, item ops, reset, template from a checklist', () => withFamily({}, async (host, { as }) => {
  const c = (await as(ANNA)('POST', '/board/checklists', { title: 'Urlaub', items: ['Pässe', 'Sonnencreme', 'Ladekabel'] })).json.checklist;
  assert.deepEqual([c.title, c.items.map((i) => [i.text, i.done, i.doneBy]), c.fromTemplateId, c.open], ['Urlaub', [['Pässe', false, null], ['Sonnencreme', false, null], ['Ladekabel', false, null]], null, 3]);
  const base = `/board/checklists/${c.id}`;
  const it = (await as(TIM)('POST', `${base}/items`, { text: 'Kuscheltier' })).json;
  assert.equal(it.checklist.items.length, 4);
  const d = (await as(LENA)('PATCH', `${base}/items/${c.items[0].id}`, { done: true })).json;
  assert.deepEqual([d.item.done, d.item.doneBy, d.checklist.open], [true, LENA.id, 3]);
  assert.equal((await as(LENA)('PATCH', `${base}/items/${c.items[0].id}`, { text: 'Reisepässe' })).json.item.doneBy, LENA.id, 'editing the text keeps who did it');
  assert.equal((await as(LENA)('PATCH', `${base}/items/${c.items[0].id}`, {})).json.code, 'invalid');
  assert.equal((await as(LENA)('PATCH', `${base}/items/${c.items[0].id}`, { done: 'yes' })).json.code, 'invalid');
  assert.equal((await as(TIM)('DELETE', `${base}/items/${it.item.id}`)).json.checklist.items.length, 3);
  assert.equal((await as(TIM)('DELETE', `${base}/items/${it.item.id}`)).status, 404);
  assert.equal((await as(TIM)('POST', `${base}/items`, { text: 'x'.repeat(81) })).json.code, 'invalid');
  assert.deepEqual((await as(ANNA)('GET', '/overview')).json.board, { pinned: 0, notes: 0, openChecklists: 1 });
  // template from the checklist, then a new checklist from the template
  const tpl = (await as(MARC)('POST', '/board/templates', { checklistId: c.id })).json.template;
  assert.deepEqual([tpl.title, tpl.items], ['Urlaub', ['Reisepässe', 'Sonnencreme', 'Ladekabel']]);
  const t2 = (await as(LENA)('POST', '/board/templates', { title: 'Schwimmbad', items: ['Handtuch', 'Badehose', 'Duschgel'] })).json.template;
  const c2 = (await as(TIM)('POST', '/board/checklists', { templateId: t2.id })).json.checklist;
  assert.deepEqual([c2.title, c2.fromTemplateId, c2.items.map((i) => i.text), c2.open], ['Schwimmbad', t2.id, ['Handtuch', 'Badehose', 'Duschgel'], 3]);
  assert.equal((await as(TIM)('POST', '/board/checklists', { templateId: 999 })).status, 404);
  assert.equal((await as(TIM)('POST', '/board/checklists', { title: '' })).json.code, 'invalid');
  // reset (addition)
  const reset = (await as(ANNA)('POST', `${base}/reset`)).json.checklist;
  assert.deepEqual(reset.items.map((i) => i.done), [false, false, false]);
  // GET board: everything
  const b = (await as(LENA)('GET', '/board')).json;
  assert.deepEqual([b.notes.length, b.checklists.map((x) => x.title), b.templates.map((x) => x.title)], [0, ['Schwimmbad', 'Urlaub'], ['Schwimmbad', 'Urlaub']]);
  assert.equal((await as(LENA)('GET', `/board/checklists/${c2.id}`)).json.checklist.id, c2.id);
  // delete: creator and parents
  assert.equal((await as(LENA)('DELETE', `/board/checklists/${c2.id}`)).json.code, 'forbidden');
  assert.equal((await as(TIM)('DELETE', `/board/checklists/${c2.id}`)).status, 200);
  assert.equal((await as(TIM)('DELETE', `/board/templates/${tpl.id}`)).json.code, 'forbidden');
  assert.equal((await as(LENA)('PATCH', `/board/templates/${t2.id}`, { items: ['Handtuch'] })).json.template.items.length, 1);
  assert.equal((await as(ANNA)('DELETE', `/board/templates/${t2.id}`)).status, 200);
  assert.equal((await as(ANNA)('GET', '/board/nothing')).status, 404);
}));
