'use strict';

// 1.4.0 — a shopping list at a task: Task.attachedList and how it is set (attachedListId, attachedListUid, base), the
// suggestion from the line („bei Lidl einkaufen“ → „Einkauf“: a fixed table of words — the parser ui/quickparse.js and
// its vectors are untouched), „all ticked“ completes the task (with „Rückgängig“, never the other way round), the
// reminder with „Liste öffnen“. The clock is pinned (helpers: Sunday 2026-11-08 10:00 in Berlin) and only ever set.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { withHost, ANNA, MARC, LENA, clock, T0 } = require('./helpers');
const shopping = require('../server/shopping');

const L1 = '6f1c2a90-1111-4c1d-9a00-000000000001';
const L2 = '6f1c2a90-2222-4c1d-9a00-000000000002';
const L3 = '6f1c2a90-3333-4c1d-9a00-000000000003';
const I = (n) => `0a0b0c0d-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (s) => Date.parse(s);

const ops = (h, user, ...list) => h.ok(user, 'POST', 'shopping/ops', { ops: list });
const add = (id, name, extra = {}) => ({ op: 'list_add', id, name, ...extra });
const item = (n, listId, text, qty) => ({ op: 'item_add', id: I(n), listId, text, ...(qty ? { qty } : {}) });
const check = (n, checked = true) => ({ op: 'item_check', id: I(n), checked });
const task = async (h, user, id) => (await h.ok(user, 'GET', 'tasks/' + id)).task;
const listId = async (h, user, uid) => (await h.ok(user, 'GET', 'shopping')).lists.find((l) => l.id === uid).listId;

async function host(opts) {
  const h = await withHost(opts);
  shopping.state.noTimer = true;
  return h;
}
const done = async (h) => { await h.close(); clock.set(T0); };

/** „Einkauf“ with eight items (the mockup), shared with Marc. */
async function einkauf(h) {
  const names = [['Milch', '2 l'], ['Brot'], ['Äpfel', '1 kg'], ['Butter'], ['Nudeln', '2 Pck.'], ['Kaffee'], ['Joghurt', '4'], ['Spülmittel']];
  await ops(h, ANNA, add(L1, 'Einkauf', { icon: 'cart' }), ...names.map(([t, q], i) => item(i + 1, L1, t, q)));
  const id = await listId(h, ANNA, L1);
  await h.ok(ANNA, 'PUT', `lists/${id}/members`, { members: [{ id: MARC.id, role: 'write' }] });
  return id;
}

test('the parser and its vectors are as they were (Android and Windows use the same vectors)', () => {
  const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', f))).digest('hex');
  assert.equal(sha('ui/quickparse.js'), '1fcb5e337f4fd5ea8e42a8e73be614b3e94c75aeddf4f9ef6975b8dbbc8793d7');
  assert.equal(sha('test/vectors/quickparse.json'), '72f79800c231127a286f816230b3822ff6bc28d7cf0cc5a80c110a9cc90e8367');
});

test('a task carries a list: set by its number or the id of the device, shown with its numbers, taken off again', async () => {
  const h = await host();
  try {
    const lid = await einkauf(h);
    const a = await h.ok(ANNA, 'POST', 'tasks', { title: 'Bei Lidl einkaufen', attachedListId: lid });
    const info = { id: lid, uid: L1, name: 'Einkauf', icon: 'cart', open: 8, total: 8, done: 0, family: false };
    assert.deepEqual(a.task.attachedList, info);
    await ops(h, MARC, check(1), check(2), check(3));
    assert.deepEqual((await task(h, ANNA, a.task.id)).attachedList, { ...info, open: 5, done: 3 });
    // in the views too, and the list names its task („gehört zu …“)
    const md = await h.ok(ANNA, 'PATCH', 'tasks/' + a.task.id, { myDay: true });
    assert.equal(md.task.attachedList.done, 3);
    const view = await h.ok(ANNA, 'GET', 'views/myday');
    assert.deepEqual(view.sections.find((s) => s.id === 'today').items.map((x) => [x.title, x.attachedList && x.attachedList.name, x.attachedList && x.attachedList.done]), [['Bei Lidl einkaufen', 'Einkauf', 3]]);
    assert.deepEqual((await h.ok(ANNA, 'GET', 'shopping')).lists[0].tasks, [{ id: a.task.id, title: 'Bei Lidl einkaufen' }]);
    assert.deepEqual((await h.ok(MARC, 'GET', 'shopping')).lists[0].tasks, [], 'Anna\'s task is hers');
    // taken off, set by the device's id, a second task with the same list
    assert.equal((await h.ok(ANNA, 'PATCH', 'tasks/' + a.task.id, { attachedListId: null })).task.attachedList, null);
    assert.equal((await h.ok(ANNA, 'PATCH', 'tasks/' + a.task.id, { attachedListUid: L1 })).task.attachedList.id, lid);
    const b = await h.ok(MARC, 'POST', 'tasks', { title: 'Wocheneinkauf', attachedListUid: L1 });
    assert.equal(b.task.attachedList.uid, L1);
    // base: someone changed it meanwhile to something else
    await ops(h, ANNA, add(L2, 'Drogerie'));
    const l2 = await listId(h, ANNA, L2);
    const late = await h.call(ANNA, 'PATCH', 'tasks/' + a.task.id, { attachedListId: l2, base: { attachedListId: null } });
    assert.deepEqual([late.status, late.json.code, late.json.fields], [409, 'conflict', ['attachedListId']]);
    assert.equal((await h.ok(ANNA, 'PATCH', 'tasks/' + a.task.id, { attachedListId: l2, base: { attachedListId: lid } })).task.attachedList.name, 'Drogerie');
    // refused: a list one is no member of, a task list, nonsense; a sub task carries none
    const marc = await h.call(MARC, 'PATCH', 'tasks/' + b.task.id, { attachedListId: l2 });
    assert.deepEqual([marc.status, marc.json], [404, { ok: false, code: 'not_found', field: 'attachedListId' }]);
    const own = (await h.ok(ANNA, 'GET', 'lists')).lists[0].id;
    const kind = await h.call(ANNA, 'POST', 'tasks', { title: 'x', attachedListId: own });
    assert.deepEqual([kind.status, kind.json], [400, { ok: false, code: 'invalid', field: 'attachedListId', reason: 'kind' }]);
    assert.equal((await h.call(ANNA, 'POST', 'tasks', { title: 'x', attachedListId: 'abc' })).status, 400);
    assert.equal((await h.call(ANNA, 'POST', 'tasks', { title: 'x', attachedListUid: 'nope' })).status, 400);
    const sub = await h.ok(ANNA, 'POST', 'tasks', { title: 'Pfand mitnehmen', parentId: a.task.id, attachedListId: lid });
    assert.equal(sub.task.attachedList, null);
    // a list in the trash is none; back with the list
    await ops(h, ANNA, { op: 'list_delete', id: L2 });
    assert.equal((await task(h, ANNA, a.task.id)).attachedList, null);
    await h.ok(ANNA, 'POST', `lists/${l2}/restore`);
    assert.equal((await task(h, ANNA, a.task.id)).attachedList.name, 'Drogerie');
  } finally { await done(h); }
});

test('the suggestion from the line: a fixed word, the name of a list, „#liste“ — the parser\'s answer stays as it is', async () => {
  const h = await host();
  try {
    assert.deepEqual((await h.ok(ANNA, 'POST', 'parse', { text: 'bei Lidl einkaufen' })).attach, null, 'no shopping list: nothing to suggest');
    const lid = await einkauf(h);
    await ops(h, ANNA, add(L2, 'Drogerie'), add(L3, 'Baumarkt Nord'));
    const info = { id: lid, uid: L1, name: 'Einkauf', icon: 'cart', open: 8, total: 8, done: 0, family: false };
    const p = await h.ok(ANNA, 'POST', 'parse', { text: 'bei Lidl einkaufen' });
    assert.deepEqual(p.attach, { via: 'word', word: 'einkaufen', list: info, lists: [info] });
    assert.deepEqual([p.parsed.title, p.parsed.list, p.parsed.listName], ['bei Lidl einkaufen', null, null]);
    for (const [text, word] of [['Getränke besorgen', 'besorgen'], ['Einkäufe für Samstag', 'einkäufe'], ['EINKAUFEN!', 'einkaufen'], ['buy groceries', 'groceries']]) {
      const r = await h.ok(ANNA, 'POST', 'parse', { text });
      assert.deepEqual([r.attach.via, r.attach.word, r.attach.list.uid], ['word', word, L1], text);
    }
    assert.deepEqual((await h.ok(ANNA, 'POST', 'parse', { text: 'Einkauf für Samstag' })).attach.via, 'name');
    // the name of a list as a word of the line — also of two words; never a part of a word
    assert.deepEqual((await h.ok(ANNA, 'POST', 'parse', { text: 'morgen zur Drogerie' })).attach.lists.map((l) => [l.name, l.open]), [['Drogerie', 0]]);
    assert.deepEqual((await h.ok(ANNA, 'POST', 'parse', { text: 'Schrauben holen, Baumarkt Nord' })).attach.via, 'name');
    for (const text of ['Schrauben kaufen', 'Drogerien vergleichen', 'Baumarkt', 'Verkaufen', '']) assert.equal((await h.ok(ANNA, 'POST', 'parse', { text })).attach, null, text);
    // „#droge“ names the shopping list: it is no task list to be made
    const tag = await h.ok(ANNA, 'POST', 'parse', { text: 'Zahnpasta #droge' });
    assert.deepEqual([tag.attach.via, tag.attach.list.name, tag.parsed.title, tag.parsed.listName], ['tag', 'Drogerie', 'Zahnpasta', 'droge']);
    // several fit: the choice, no single suggestion
    await ops(h, ANNA, add(I(60), 'Einkauf Fest'));
    const two = (await h.ok(ANNA, 'POST', 'parse', { text: 'einkaufen' })).attach;
    assert.deepEqual([two.list, two.lists.map((l) => l.name)], [null, ['Einkauf', 'Einkauf Fest']]);
    // Marc sees only „Einkauf“; Lena has no shopping list
    assert.equal((await h.ok(MARC, 'POST', 'parse', { text: 'einkaufen' })).attach.list.uid, L1);
    assert.equal((await h.ok(LENA, 'POST', 'parse', { text: 'einkaufen' })).attach, null);
    // creating: nothing is attached unless the app says so
    const plain = await h.ok(MARC, 'POST', 'tasks', { text: 'bei Lidl einkaufen' });
    assert.deepEqual([plain.task.attachedList, plain.attach], [null, undefined]);
    const auto = await h.ok(MARC, 'POST', 'tasks', { text: 'bei Lidl einkaufen', attach: 'auto' });
    assert.deepEqual([auto.task.title, auto.task.attachedList.uid, auto.attach.via], ['bei Lidl einkaufen', L1, 'word']);
    const many = await h.ok(ANNA, 'POST', 'tasks', { text: 'einkaufen', attach: 'auto' });
    assert.deepEqual([many.task.attachedList, many.attach.lists.length], [null, 2]);
    const chosen = await h.ok(ANNA, 'POST', 'tasks', { text: 'einkaufen', attach: 'auto', attachedListId: lid });
    assert.equal(chosen.task.attachedList.uid, L1);
    const tagged = await h.ok(ANNA, 'POST', 'tasks', { text: 'Zahnpasta #droge', attach: 'auto', createList: true });
    assert.deepEqual([tagged.task.title, tagged.task.attachedList.name], ['Zahnpasta', 'Drogerie']);
    assert.deepEqual((await h.ok(ANNA, 'GET', 'lists')).lists.map((l) => l.name), ['Aufgaben'], 'no task list „droge“ was made');
  } finally { await done(h); }
});

test('all items ticked: the tasks carrying the list are done — with „Rückgängig“; a task ticked by hand leaves the items', async () => {
  const h = await host();
  try {
    const lid = await einkauf(h);
    const a = await h.ok(ANNA, 'POST', 'tasks', { title: 'Bei Lidl einkaufen', attachedListId: lid });
    const m = await h.ok(MARC, 'POST', 'tasks', { title: 'Wocheneinkauf', attachedListId: lid });
    const seven = await ops(h, ANNA, ...[1, 2, 3, 4, 5, 6, 7].map((n) => check(n)));
    assert.deepEqual(seven.completed, []);
    assert.equal((await task(h, ANNA, a.task.id)).done, false);
    // Marc ticks the last one at home: his task is his to undo; Anna's is done as well, as hers
    clock.set(T0 + 60000);
    const last = await ops(h, MARC, check(8));
    assert.deepEqual(last.completed, [{ taskId: m.task.id, title: 'Wocheneinkauf', listId: L1 }]);
    const ta = await task(h, ANNA, a.task.id);
    assert.deepEqual([ta.done, ta.doneAt, ta.attachedList.open, ta.attachedList.done], [true, '2026-11-08T10:01:00+01:00', 0, 8]);
    assert.equal((await task(h, MARC, m.task.id)).done, true);
    require('../server/events').now();
    assert.ok(h.host.events.some((e) => e.type === 'changed' && e.users.includes(ANNA.id) && e.data.what.includes('shopping') && e.data.what.includes('tasks')));
    // „Rückgängig“: the task is open again, the items stay ticked; nothing completes it again by itself
    const undo = await h.ok(MARC, 'POST', `tasks/${m.task.id}/complete`, { done: false });
    assert.equal(undo.task.done, false);
    assert.deepEqual((await ops(h, MARC, check(8))).completed, [], 'ticked already: no tick happened');
    assert.deepEqual((await h.ok(MARC, 'GET', 'shopping')).lists[0].open, 0);
    // un-ticked and ticked again: complete again
    assert.deepEqual((await ops(h, MARC, check(8, false))).completed, []);
    assert.deepEqual((await ops(h, MARC, check(8))).completed, [{ taskId: m.task.id, title: 'Wocheneinkauf', listId: L1 }]);
    // the list stays; „Abgehakte entfernen“ empties it for the next time
    await ops(h, ANNA, { op: 'clear_checked', listId: L1 });
    assert.deepEqual((await h.ok(ANNA, 'GET', 'shopping')).lists.map((l) => [l.name, l.open, l.total]), [['Einkauf', 0, 0]]);
    // the other way round: a task ticked by hand leaves open items alone
    await ops(h, ANNA, item(20, L1, 'Hefe'), item(21, L1, 'Mehl'));
    const c = await h.ok(ANNA, 'POST', 'tasks', { title: 'Backzutaten', attachedListId: lid });
    await h.ok(ANNA, 'POST', `tasks/${c.task.id}/complete`, { done: true });
    assert.deepEqual((await h.ok(ANNA, 'GET', 'shopping')).items.map((i) => [i.text, i.checked]), [['Hefe', false], ['Mehl', false]]);
    // no tick, no completion: the last open item deleted, a list attached that is ticked off already, an empty list
    const d = await h.ok(ANNA, 'POST', 'tasks', { title: 'Noch mal los', attachedListId: lid });
    assert.deepEqual((await ops(h, ANNA, check(20))).completed, []);
    assert.deepEqual((await ops(h, ANNA, { op: 'item_delete', id: I(21) })).completed, []);
    assert.equal((await task(h, ANNA, d.task.id)).done, false);
    await ops(h, ANNA, add(L2, 'Leer'));
    const e = await h.ok(ANNA, 'POST', 'tasks', { title: 'Leere Liste', attachedListUid: L2 });
    assert.deepEqual([e.task.done, e.task.attachedList.total], [false, 0]);
    // a repeating task: done, and the next one carries the list
    const r = await h.ok(ANNA, 'POST', 'tasks', { title: 'Samstags zu Lidl', attachedListId: lid, due: { date: '2026-11-14' }, repeat: { type: 'weekly', interval: 1, days: [6] } });
    await ops(h, ANNA, item(22, L1, 'Eier'));
    const again = await ops(h, ANNA, check(22));
    assert.deepEqual(again.completed.map((x) => x.title).sort(), ['Noch mal los', 'Samstags zu Lidl']);
    const open = (await h.ok(ANNA, 'GET', 'views/planned')).sections.flatMap((s) => s.items).filter((x) => x.title === 'Samstags zu Lidl');
    assert.deepEqual(open.map((x) => [x.due.date, x.done, x.attachedList.uid, x.id !== r.task.id]), [['2026-11-21', false, L1, true]]);
  } finally { await done(h); }
});

test('all ticked by someone who may not complete the task: it is done as its own person; a read-only member cannot tick at all', async () => {
  const h = await host();
  try {
    const lid = await einkauf(h);
    // Anna's task in a list shared with Lena (read) and assigned to nobody; the shopping list is Marc's to tick
    const house = await h.ok(ANNA, 'POST', 'lists', { name: 'Haus' });
    await h.ok(ANNA, 'PUT', `lists/${house.list.id}/members`, { members: [{ id: LENA.id, role: 'read' }] });
    const a = await h.ok(ANNA, 'POST', 'tasks', { title: 'Einkauf erledigen', listId: house.list.id, attachedListId: lid });
    assert.equal((await task(h, LENA, a.task.id)).attachedList, null, 'Lena does not see the shopping list');
    const r = await ops(h, MARC, ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => check(n)));
    assert.deepEqual(r.completed, [], 'not Marc\'s task to undo');
    assert.equal((await task(h, ANNA, a.task.id)).done, true);
    assert.equal((await task(h, LENA, a.task.id)).done, true);
  } finally { await done(h); }
});

test('the reminder of a task with a list: the first items in the text, „Liste öffnen“ first, the same in GET reminders', async () => {
  const h = await host();
  try {
    const lid = await einkauf(h);
    const a = await h.ok(ANNA, 'POST', 'tasks', { text: 'heute 14 Uhr bei Lidl einkaufen', attachedListId: lid });
    const att = { id: lid, uid: L1, name: 'Einkauf', open: 8, total: 8 };
    const feed = await h.ok(ANNA, 'GET', 'reminders');
    assert.deepEqual(feed.reminders.map((x) => [x.body, x.actions, x.attachedList]), [['Fällig heute 14:00 · Aufgaben\nEinkauf · 8 Punkte: Milch, Brot, Äpfel, Butter …',
      [{ id: 'open_list', label: 'Liste öffnen' }, { id: 'done', label: 'Erledigt' }, { id: 'snooze_1h', label: 'In 1 Std.' }], att]]);
    await ops(h, MARC, ...[1, 2, 3, 4, 5, 6, 7].map((n) => check(n)));
    clock.set(at('2026-11-08T13:00:10Z'));
    await h.host.tick();
    const [n] = h.host.notifications.filter((x) => x.topic === 'reminders');
    assert.deepEqual([n.title, n.body, n.users], ['bei Lidl einkaufen', 'Fällig heute 14:00 · Aufgaben\nEinkauf · 1 Punkt: Spülmittel', [ANNA.id]]);
    assert.deepEqual(n.data.notizen.attachedList, { ...att, open: 1 });
    assert.deepEqual(n.data.actions, [{ type: 'open_app_route', id: 'open_list', label: 'Liste öffnen', target: 'plg-gatecontrol-notizen' },
      { type: 'callback', id: 'done', label: 'Erledigt' }, { type: 'callback', id: 'snooze_1h', label: 'In 1 Std.' }]);
    // the buttons do what they did
    assert.deepEqual(await h.press(ANNA, n, 'snooze_1h'), { ok: true, snoozed: true });
    assert.deepEqual(await h.press(ANNA, n, 'done'), { ok: true, done: true });
    assert.equal((await task(h, ANNA, a.task.id)).done, true);
    // a task without a list keeps the three buttons of 1.3.0
    const b = await h.ok(ANNA, 'POST', 'tasks', { title: 'Wäsche', remindAt: { date: '2026-11-08', time: '15:00' } });
    clock.set(at('2026-11-08T14:00:10Z'));
    await h.host.tick();
    const plain = h.host.notifications.find((x) => x.topic === 'reminders' && x.data.notizen.taskId === b.task.id);
    assert.deepEqual([plain.data.actions.map((x) => x.id), 'attachedList' in plain.data.notizen, plain.body], [['done', 'snooze_1h', 'snooze_eve'], false, 'Aufgaben']);
  } finally { await done(h); }
});
