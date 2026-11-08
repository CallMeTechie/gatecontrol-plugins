'use strict';

// 1.19.0 — Familie and „Notizen & Aufgaben“ (gatecontrol-notizen, contract v1) against a stand-in hub
// (tools/testing/notizen-hub.js):
//   the to-dos (server/notizen.js): tasks (one item per assignee in mode fixed, stars, the child as assignee), shopping
//   lists, open reminders; ticking a task off round trip (stars for the child, a parent for a child); the push only of
//   real changes in one call, kept on ERR_RATE_LIMIT; nothing without the hub; only the hub may call.
//   Pinnwand and Packlisten (server/boardsync.js): the move (bind, import, mapping), changes both ways (after the commit,
//   notes_changed → notes_list since), the hub away for a while, the rollback when the hub's notebook is gone (and the
//   move again), Familie's board without the hub exactly as before.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withFamily, ANNA, MARC, LENA, TIM, OMA, MIN } = require('./helpers');
const { fakeHub, checkItem, pullAll, HUB } = require('../../../tools/testing/notizen-hub');
const notizen = require('../server/notizen');
const boardsync = require('../server/boardsync');

const FAM = 'gatecontrol-familie';
const run = (o, fn) => withFamily({ gatecontrol: '1.216.0', ...o, services: o.hub === null ? [] : [o.hub || (o.hub = fakeHub({ notes: true }))] }, async (host, ctx) => {
  notizen.source.state.noTimer = true;
  boardsync.state.noTimer = true;
  try { return await fn(host, ctx, o.hub); } finally { notizen.source.stop(); boardsync.stop(); }
});
const flush = (host) => notizen.source.flush(host.gc, Date.now(), { force: true });
const complete = (host, user, id, done, caller = HUB) => host.callService('todo_complete', { caller, user, payload: { v: 1, id, done } });
const rows = async (host, sql, params) => (await host.gc.db.query(sql, params || [])).rows;
/** One run of the board's sync as the background run does it. */
async function syncBoard(host, opts) {
  const config = require('../server/config');
  const members = require('../server/members');
  const tz = require('../server/tz');
  const cfg = await config.load(host.gc);
  return boardsync.sync(host.gc, await members.load(host.gc, tz.localDate(Date.now(), cfg.tz)), cfg, Date.now(), opts);
}

// ─── the to-dos ─────────────────────────────────

test('items: tasks (fixed: one per assignee, stars, the child), shopping lists, reminders — for the right people', () => run({}, async (host, { as }) => {
  const dishes = (await as(ANNA)('POST', '/tasks', { title: 'Spülmaschine ausräumen', mode: 'fixed', assignees: [LENA.id, TIM.id], repeat: 'daily', dueTime: '17:00', stars: 2 })).json.task;
  const trash = (await as(ANNA)('POST', '/tasks', { title: 'Müll raus', mode: 'rotate', assignees: [TIM.id, LENA.id], repeat: 'weekly', weekdays: [3] })).json.task;
  await as(MARC)('POST', '/shopping/ops', { ops: [{ op: 'list_add', id: 'rewe-0001', name: 'Rewe' }, { op: 'item_add', id: 'milch-001', listId: 'rewe-0001', text: 'Milch' },
    { op: 'item_add', id: 'brot-0001', listId: 'rewe-0001', text: 'Brot' }, { op: 'item_check', id: 'brot-0001', checked: true }] });
  const items = [...(await notizen.source.items(host.gc)).values()];
  for (const x of items) assert.equal(checkItem({ ...x, updatedAt: x.updatedAt || 1 }, FAM), null, x.id);
  const lena = items.find((x) => x.id === `task:${dishes.id}:${LENA.id}`);
  assert.deepEqual([lena.kind, lena.title, lena.due, lena.allDay, lena.assignee, lena.assigneeName, lena.done, lena.canComplete, lena.meta],
    ['task', 'Spülmaschine ausräumen', '2026-10-14T17:00:00+02:00', false, LENA.id, 'Lena', false, true, { stars: 2 }]);
  assert.deepEqual(lena.users, [LENA.id, ANNA.id, MARC.id], 'the child and the parents');
  assert.ok(items.some((x) => x.id === `task:${dishes.id}:${TIM.id}`), 'one item per assignee');
  const rot = items.find((x) => x.id === `task:${trash.id}`);
  assert.deepEqual([rot.assignee, rot.due, rot.users], [TIM.id, '2026-10-14', [TIM.id, LENA.id, ANNA.id, MARC.id]]);
  assert.deepEqual(rot.open, { plugin: FAM, route: `task/${trash.id}` });
  const list = items.find((x) => x.kind === 'list');
  assert.deepEqual([list.id, list.title, list.progress, list.meta.type, list.canComplete, list.users.length], ['list:rewe-0001', 'Rewe', { done: 1, total: 2 }, 'shopping', false, 4]);
  // what Oma (no member) and the children see
  assert.deepEqual((await pullAll(host, OMA)).items, []);
  const tim = (await pullAll(host, TIM)).items.map((x) => x.id).sort();
  assert.ok(tim.includes(`task:${dishes.id}:${TIM.id}`) && !tim.includes(`task:${dishes.id}:${LENA.id}`), 'a child: its own tasks');
  // a module off: its items go
  await (async () => { const r = await host.request({ method: 'PUT', path: '/admin/modules', body: { shopping: false }, query: {}, user: { id: 1, name: 'admin', role: 'admin' } }); assert.equal(r.status, 200); })();
  assert.ok(![...(await notizen.source.items(host.gc)).values()].some((x) => x.kind === 'list'));
}));

test('todo_complete: the child ticks its task off (stars), a parent for a child, a child not for another; no undo', () => run({}, async (host, { as }) => {
  const dishes = (await as(ANNA)('POST', '/tasks', { title: 'Spülmaschine', mode: 'fixed', assignees: [LENA.id, TIM.id], repeat: 'daily', stars: 3 })).json.task;
  const r = await complete(host, LENA, `task:${dishes.id}:${LENA.id}`, true);
  assert.deepEqual([r.ok, r.item.done], [true, true]);
  assert.equal((await as(LENA)('GET', '/overview')).json.stars.week, 3, 'stars as in Familie');
  assert.deepEqual(await complete(host, LENA, `task:${dishes.id}:${TIM.id}`, true), { ok: false, code: 'not_found' }, 'not hers');
  const m = await complete(host, MARC, `task:${dishes.id}:${TIM.id}`, true);
  assert.deepEqual([m.ok, m.item.done], [true, true]);
  assert.equal((await rows(host, 'SELECT stars FROM task_done WHERE user_id = ?', [TIM.id]))[0].stars, 3, 'the stars go to Tim');
  assert.deepEqual(await complete(host, LENA, `task:${dishes.id}:${LENA.id}`, false), { ok: false, code: 'read_only' }, 'Familie has no undo');
  assert.deepEqual(await complete(host, LENA, `task:${dishes.id}:${LENA.id}`, true, 'gatecontrol-mail'), { ok: false, code: 'forbidden' });
  assert.deepEqual(await host.callService('todo_items', { caller: 'gatecontrol-mail', user: LENA, payload: { v: 1 } }), { ok: false, code: 'forbidden' });
  assert.deepEqual(await complete(host, LENA, 'list:rewe-0001', true), { ok: false, code: 'not_found' });
  // the old services still answer (the Messenger's)
  assert.equal((await host.callService('family_roles', { caller: 'gatecontrol-messenger', payload: {} })).ok, true);
}));

test('push: one call, only real changes, kept on ERR_RATE_LIMIT, a new day; nothing without the hub', async () => {
  let fail = false;
  const hub = fakeHub({ notes: true, answer: (c) => { if (fail && c.name === 'todo_changed') throw Object.assign(new Error('rate'), { code: 'ERR_RATE_LIMIT' }); return undefined; } });
  await run({ hub }, async (host, { as, clock }) => {
    const t1 = (await as(ANNA)('POST', '/tasks', { title: 'Zimmer', mode: 'fixed', assignees: [LENA.id], repeat: 'daily' })).json.task;
    await as(ANNA)('POST', '/tasks', { title: 'Hausaufgaben', mode: 'fixed', assignees: [TIM.id], repeat: 'daily' });
    const a = await flush(host);
    assert.deepEqual([a.sent, a.upserted, hub.rejected.length], [1, 2, 0]);
    assert.equal((await flush(host)).sent, 0, 'nothing changed');
    await as(LENA)('POST', `/tasks/${t1.id}/done`, {});
    fail = true;
    assert.equal((await flush(host)).upserted, 0);
    fail = false;
    const b = await flush(host);
    assert.deepEqual([b.sent, b.upserted], [1, 1]);
    assert.equal(hub.items.get(`${FAM}|task:${t1.id}:${LENA.id}`).done, true);
    // the next day: a new occurrence, open again (the source's own day, no change in Familie)
    clock.add(24 * 60 * MIN);
    await flush(host);
    const it = hub.items.get(`${FAM}|task:${t1.id}:${LENA.id}`);
    assert.deepEqual([it.done, it.due], [false, '2026-10-15']);
    // deleted: removed
    await as(ANNA)('DELETE', `/tasks/${t1.id}`);
    await flush(host);
    assert.deepEqual(hub.pushes().at(-1).payload.remove, [`task:${t1.id}:${LENA.id}`]);
  });
  await run({ hub: null }, async (host, { as }) => {
    await as(ANNA)('POST', '/tasks', { title: 'Zimmer', mode: 'fixed', assignees: [LENA.id], repeat: 'daily' });
    assert.equal((await flush(host)).skipped, 'unavailable');
    await host.tick();
    assert.equal(host.serviceCalls.filter((c) => c.plugin === HUB).length, 0);
  });
});

// ─── Pinnwand and Packlisten ────────────────────

async function board(as) {
  const n1 = (await as(ANNA)('POST', '/board/notes', { text: 'WLAN Gäste: Haus-5G', color: 'green', pinned: true })).json.note;
  const n2 = (await as(TIM)('POST', '/board/notes', { text: 'Fußball fällt aus' })).json.note;
  const c = (await as(MARC)('POST', '/board/checklists', { title: 'Urlaub', items: ['Pässe', 'Sonnencreme', 'Ladekabel'] })).json.checklist;
  return { n1, n2, c };
}

test('without the hub: Pinnwand and Packlisten as before, nothing moves', () => run({ hub: null }, async (host, { as }) => {
  const { n1, c } = await board(as);
  await host.tick();
  const g = (await as(LENA)('GET', '/board')).json;
  assert.deepEqual(g.home, { home: 'familie', since: null });
  assert.deepEqual(g.notes.map((x) => x.id).sort(), [n1.id, g.notes.find((x) => x.id !== n1.id).id].sort());
  assert.equal((await as(LENA)('PATCH', `/board/checklists/${c.id}/items/${c.items[0].id}`, { done: true })).status, 200);
  assert.deepEqual((await rows(host, 'SELECT COUNT(*) AS n FROM hub_notes'))[0].n, 0);
  assert.equal(host.serviceCalls.length, 0);
  assert.deepEqual(await syncBoard(host), { skipped: 'unavailable' });
}));

test('the move: bound notebooks for the family, every note and checklist imported once, Familie keeps showing them', () => run({}, async (host, { as }, hub) => {
  const { n1, n2, c } = await board(as);
  await as(LENA)('PATCH', `/board/checklists/${c.id}/items/${c.items[1].id}`, { done: true });
  await host.tick();
  const pin = hub.notebook(FAM, 'pinnwand');
  const pack = hub.notebook(FAM, 'packlisten');
  assert.deepEqual([pin.kind, pin.members.sort(), pack.kind, pack.title], ['notes', [ANNA.id, MARC.id, LENA.id, TIM.id].sort(), 'checklists', 'Packlisten']);
  assert.deepEqual([...pin.notes.values()].map((x) => x.text).sort(), ['Fußball fällt aus', 'WLAN Gäste: Haus-5G']);
  const hc = [...pack.notes.values()][0];
  assert.deepEqual([hc.title, hc.checklist.map((x) => [x.text, x.done])], ['Urlaub', [['Pässe', false], ['Sonnencreme', true], ['Ladekabel', false]]]);
  const imports = hub.calls.filter((x) => x.name === 'notes_import');
  assert.equal(imports.length, 2, 'one import per notebook');
  assert.deepEqual(imports[0].payload.notes.map((x) => x.ref).sort(), [`board:${n1.id}`, `board:${n2.id}`].sort());
  assert.equal(imports[0].user, null, 'notes_import without a person');
  // Familie: the same notes, ids and texts; home is the hub
  const g = (await as(LENA)('GET', '/board')).json;
  assert.equal(g.home.home, 'notizen');
  assert.ok(g.home.since);
  assert.deepEqual(g.notes.map((x) => [x.id, x.text]).sort(), [[n1.id, n1.text], [n2.id, n2.text]].sort());
  assert.deepEqual(g.checklists[0].items.map((x) => [x.text, x.done]), [['Pässe', false], ['Sonnencreme', true], ['Ladekabel', false]]);
  // the next runs do not import again
  await host.tick();
  await syncBoard(host, { pull: true });
  assert.equal(hub.calls.filter((x) => x.name === 'notes_import').length, 2);
  assert.equal(pin.notes.size, 2);
}));

test('both ways: a change in Familie goes after its commit, one in the hub comes with notes_changed', () => run({}, async (host, { as, clock }, hub) => {
  const { n1, c } = await board(as);
  await host.tick();
  const pin = hub.notebook(FAM, 'pinnwand');
  const pack = hub.notebook(FAM, 'packlisten');
  const hubOf = async (kind, id) => (await rows(host, 'SELECT hub_id FROM hub_notes WHERE kind = ? AND local_id = ?', [kind, id]))[0].hub_id;
  // Familie → hub (as the person who changed it)
  assert.equal((await as(MARC)('PATCH', `/board/notes/${n1.id}`, { text: 'WLAN Gäste: Haus-5G (neu)' })).status, 200);
  assert.equal(pin.notes.get(await hubOf('note', n1.id)).text, 'WLAN Gäste: Haus-5G (neu)');
  assert.equal(hub.calls.filter((x) => x.name === 'note_save').at(-1).user.id, MARC.id);
  await as(TIM)('PATCH', `/board/checklists/${c.id}/items/${c.items[0].id}`, { done: true });
  assert.deepEqual(pack.notes.get(await hubOf('checklist', c.id)).checklist.map((x) => x.done), [true, false, false]);
  await as(LENA)('POST', `/board/checklists/${c.id}/items`, { text: 'Badesachen' });
  assert.deepEqual(pack.notes.get(await hubOf('checklist', c.id)).checklist.map((x) => x.text), ['Pässe', 'Sonnencreme', 'Ladekabel', 'Badesachen']);
  const n3 = (await as(LENA)('POST', '/board/notes', { text: 'Oma kommt Sonntag' })).json.note;
  const h3 = await hubOf('note', n3.id);
  assert.equal(pin.notes.get(h3).text, 'Oma kommt Sonntag', 'a new note at once');
  assert.equal((await as(ANNA)('DELETE', `/board/notes/${n3.id}`)).status, 200);
  assert.equal(pin.notes.has(h3), false, 'deleted in the hub too');

  // hub → Familie: an edit, a new note, a deleted checklist (a minute later)
  clock.add(MIN);
  const h1 = await hubOf('note', n1.id);
  hub.edit(FAM, 'pinnwand', h1, { title: 'WLAN', text: 'Gäste: Haus-5G, Passwort am Router', color: 'purple' }, ANNA.id);
  pin.notes.set(901, { id: 901, title: '', text: 'Zahnarzt Mi 15 Uhr', color: 'blue', pinned: false, expiresAt: null, due: null, checklist: null, progress: null,
    updatedAt: Date.now() + 1, updatedBy: ANNA.id, createdBy: ANNA.id, createdAt: Date.now() });
  const r = await host.callService('notes_changed', { caller: HUB, payload: { v: 1, key: 'pinnwand', ids: [h1, 901], removed: [], at: Date.now() } });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(await host.callService('notes_changed', { caller: 'gatecontrol-mail', payload: { v: 1, key: 'pinnwand', ids: [] } }), { ok: false, code: 'forbidden' });
  await syncBoard(host);
  const g = (await as(LENA)('GET', '/board')).json;
  assert.equal(g.notes.find((x) => x.id === n1.id).text, 'WLAN\nGäste: Haus-5G, Passwort am Router', 'the title as the first line');
  assert.equal(g.notes.find((x) => x.id === n1.id).color, 'yellow', 'a colour Familie does not know is shown yellow');
  assert.ok(g.notes.some((x) => x.text === 'Zahnarzt Mi 15 Uhr'), 'a note made in the hub');
  // Familie edits that note again: the hub keeps its title
  await as(ANNA)('PATCH', `/board/notes/${n1.id}`, { text: 'WLAN\nGäste: Haus-5G, Passwort steht am Router' });
  assert.deepEqual([pin.notes.get(h1).title, pin.notes.get(h1).text], ['WLAN', 'Gäste: Haus-5G, Passwort steht am Router']);
  // the checklist deleted in the hub
  const hc = await hubOf('checklist', c.id);
  pack.notes.delete(hc);
  pack.removed.push({ id: hc, at: Date.now() + 5 });
  await host.callService('notes_changed', { caller: HUB, payload: { v: 1, key: 'packlisten', ids: [], removed: [hc], at: Date.now() } });
  await syncBoard(host);
  assert.deepEqual((await as(LENA)('GET', '/board')).json.checklists, []);
}));

test('the hub away for a while: Familie works on, the changes go when it is back; the rollback when its notebook is gone', async () => {
  let down = false;
  const hub = fakeHub({ notes: true, answer: (c) => { if (down && c.name !== 'todo_changed') throw Object.assign(new Error('gone'), { code: 'ERR_SERVICE_UNAVAILABLE' }); return undefined; } });
  await run({ hub }, async (host, { as }) => {
    const { n1, c } = await board(as);
    await host.tick();
    const pin = hub.notebook(FAM, 'pinnwand');
    down = true;
    assert.equal((await as(ANNA)('PATCH', `/board/notes/${n1.id}`, { text: 'Offline geändert' })).status, 200, 'Familie works on');
    const n4 = (await as(TIM)('POST', '/board/notes', { text: 'Neu ohne Hub' })).json.note;
    assert.equal((await as(LENA)('GET', '/board')).json.notes.find((x) => x.id === n1.id).text, 'Offline geändert');
    down = false;
    await syncBoard(host);
    assert.ok([...pin.notes.values()].some((x) => x.text === 'Offline geändert'));
    assert.ok([...pin.notes.values()].some((x) => x.text === 'Neu ohne Hub'));
    assert.ok(n4);

    // a fresh hub (its data gone): Familie keeps everything, rolls back and moves again
    hub.notebooks.clear();
    const rb = await syncBoard(host, { pull: true });
    assert.equal(rb.rolledBack, true);
    assert.equal((await as(LENA)('GET', '/board')).json.home.home, 'familie');
    assert.equal((await rows(host, 'SELECT COUNT(*) AS n FROM hub_notes'))[0].n, 0);
    assert.equal((await as(LENA)('GET', '/board')).json.notes.length, 3, 'nothing lost');
    assert.equal((await as(LENA)('GET', '/board')).json.checklists[0].items.length, c.items.length);
    const again = await syncBoard(host);
    assert.equal(again.migrated, true);
    assert.equal(hub.notebook(FAM, 'pinnwand').notes.size, 3);
    assert.equal(hub.notebook(FAM, 'packlisten').notes.size, 1);
  });
});

test('the family changes: the notebooks are bound again with the new members', () => run({}, async (host, { as, admin }, hub) => {
  await board(as);
  await host.tick();
  assert.equal(hub.calls.filter((x) => x.name === 'notes_bind').length, 2);
  assert.equal((await admin('POST', 'members', { userId: OMA.id, role: 'parent' })).status, 200);
  await syncBoard(host);
  assert.equal(hub.calls.filter((x) => x.name === 'notes_bind').length, 4);
  assert.ok(hub.notebook(FAM, 'pinnwand').members.includes(OMA.id));
}));

test('an open reminder of today for its person, ticked off like „Erledigt“ (stays a day as done)', () => run({}, async (host) => {
  const now = Date.now();
  await host.gc.db.run("INSERT INTO presence_rules (id, name, title, trigger_type, owner_id, created_at, updated_at) VALUES (7, 'Fenster', 'Fenster zu?', 'schedule', ?, ?, ?)", [ANNA.id, now, now]);
  await host.gc.db.run("INSERT INTO rule_reminders (rule_id, fire_key, user_id, day, state, sends, created_at, updated_at) VALUES (7, 'sched:2026-10-14', ?, '2026-10-14', 'open', 1, ?, ?)", [LENA.id, now, now]);
  const items = (await pullAll(host, LENA)).items.filter((x) => x.id.startsWith('reminder:'));
  assert.equal(items.length, 1);
  assert.deepEqual([items[0].title, items[0].users, items[0].canComplete, items[0].due], ['Fenster zu?', [LENA.id], true, '2026-10-14']);
  assert.deepEqual((await pullAll(host, TIM)).items.filter((x) => x.id.startsWith('reminder:')), []);
  const r = await complete(host, LENA, items[0].id, true);
  assert.deepEqual([r.ok, r.item.done, r.item.canComplete], [true, true, false]);
  assert.equal((await rows(host, 'SELECT state FROM rule_reminders WHERE rule_id = 7'))[0].state, 'done');
}));
