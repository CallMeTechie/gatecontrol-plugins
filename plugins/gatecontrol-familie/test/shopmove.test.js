'use strict';

// 1.21.0 — the shopping lists in „Notizen & Aufgaben“ (server/shopsync.js), tested against the real hub
// (plugins/gatecontrol-notizen ≥ 1.4.0 in a mock host of its own, the two wired through their services): only Familie
// → nothing changes; the move by its button with the preview, again without anything twice; both directions afterwards;
// „Ich gehe einkaufen“ / „Kannst du einkaufen gehen?“ pressed in the hub; a task of the hub done when the wall tablet
// ticks the last item; the hub away, back, forgotten; „Zurückholen“; who may. The clock is the helpers' (2026-10-14
// 10:00 in Berlin) and only ever set.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHost } = require('../../../tools/testing/mock-host');
const { withFamily, ADMIN, ANNA, MARC, LENA, TIM, OMA, KUECHE, USERS, T0, MIN, app, kioskViewer, pushes } = require('./helpers');
const shopsync = require('../server/shopsync');

const NZ_DIR = path.join(__dirname, '..', '..', 'gatecontrol-notizen');
const nz = (f) => require(path.join(NZ_DIR, 'server', f));
const HUB = 'gatecontrol-notizen';
const FAM = 'gatecontrol-familie';

const L1 = '6f1c2a90-1111-4c1d-9a00-000000000001';
const L2 = '6f1c2a90-2222-4c1d-9a00-000000000002';
const L3 = '6f1c2a90-3333-4c1d-9a00-000000000003';
const I = (n) => `0a0b0c0d-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SEED = [
  { op: 'list_add', id: L1, name: 'Einkauf', icon: 'cart' }, { op: 'list_add', id: L2, name: 'Drogerie' },
  { op: 'item_add', id: I(1), listId: L1, text: 'Milch', qty: '2 l' }, { op: 'item_add', id: I(2), listId: L1, text: 'Brot' },
  { op: 'item_add', id: I(3), listId: L1, text: 'Äpfel', qty: '1 kg' }, { op: 'item_check', id: I(3), checked: true },
  { op: 'item_add', id: I(4), listId: L2, text: 'Zahnpasta' }, { op: 'item_add', id: I(5), listId: L2, text: 'Seife' }, { op: 'item_delete', id: I(5) },
];

/**
 * Familie (the helpers' family) and the real hub, each in its own mock host. fn(x): x.fam(user) calls Familie, x.hub(user)
 * the hub, x.both() lets both background runs go (the hub tells, Familie pushes and pulls), x.hubOff() / x.hubOn() take
 * the hub away and bring it back, x.freshHub() replaces it by one that knows nothing.
 */
async function linked(o, fn) {
  const entry = { plugin: HUB, provides: require(path.join(NZ_DIR, 'plugin.json')).services.provides, service: null };
  const opts = { gatecontrol: '1.216.0', ...o, services: o.hub === false ? [] : [entry] };
  return withFamily(opts, async (famHost, ctx) => {
    shopsync.state.noTimer = true;
    nz('clock.js').set(null); // the hub's clock is the mocked Date of the helpers
    nz('config.js').reset();
    nz('people.js').reset();
    let hubHost = null;
    const start = async () => {
      hubHost = await createHost(NZ_DIR, {
        gatecontrol: '1.216.0', users: USERS, license: { required: true, licensed: true, state: 'valid', expiresAt: null },
        services: [{ plugin: FAM, provides: require('../plugin.json').services.provides, service: (c) => famHost.callService(c.name, { caller: c.caller, user: c.user, payload: c.payload }) }],
      });
      await hubHost.start();
      nz('shopping.js').state.noTimer = true;
      entry.service = (c) => hubHost.callService(c.name, { caller: c.caller, user: c.user, payload: c.payload });
    };
    if (o.hub !== false) await start();
    const req = (host) => (user) => async (method, p, body, query) => {
      const r = await host.request({ method, path: p, body: body === undefined ? null : body, query: query || {}, user: app(user), lang: 'de' });
      return r;
    };
    const x = {
      famHost, clock: ctx.clock, admin: ctx.admin, fam: req(famHost), hub: (user) => req(hubHost)(user), hubHost: () => hubHost,
      async both() { if (hubHost && entry.service) await hubHost.tick(); await famHost.tick(); if (hubHost && entry.service) await hubHost.tick(); },
      hubOff() { entry.saved = entry.service; entry.service = null; shopsync.state.hub = null; },
      hubOn() { entry.service = entry.saved; shopsync.state.hub = null; },
      async freshHub() { await hubHost.close(); await start(); shopsync.state.hub = null; },
      hubCalls: () => famHost.serviceCalls.filter((c) => c.plugin === HUB && /^shopping_/.test(c.service)),
    };
    try {
      return await fn(x);
    } finally {
      if (hubHost) await hubHost.close();
    }
  });
}

const famLists = async (x, user) => {
  const g = (await x.fam(user)('GET', '/shopping')).json;
  return g.lists.map((l) => [l.id, l.name, g.items.filter((i) => i.listId === l.id).map((i) => [i.text, i.qty, i.checked])]);
};
const hubLists = async (x, user) => {
  const g = (await x.hub(user)('GET', 'shopping')).json;
  return g.lists.map((l) => [l.id, l.name, g.items.filter((i) => i.listId === l.id).map((i) => [i.text, i.qty, i.checked])]);
};
const BOTH = [[L1, 'Einkauf', [['Milch', '2 l', false], ['Brot', null, false], ['Äpfel', '1 kg', true]]], [L2, 'Drogerie', [['Zahnpasta', null, false]]]];

test('only Familie installed: everything as before — no hub, no move, nothing sent', () => linked({ hub: false }, async (x) => {
  const anna = x.fam(ANNA);
  assert.deepEqual((await anna('POST', '/shopping/ops', { ops: SEED })).json.rejected, []);
  assert.deepEqual((await anna('GET', '/me')).json.features, ['shoppingHome']);
  const pv = await anna('GET', '/shopping/move');
  assert.deepEqual(pv.json, { ok: true, lists: 2, items: 4, open: 3, home: { home: 'familie', since: null }, hub: { available: false }, moved: false, canMove: false, canBack: false });
  const mv = await anna('POST', '/shopping/move', {});
  assert.deepEqual([mv.status, mv.json.code, mv.json.reason], [409, 'unavailable', 'hub']);
  await x.famHost.tick();
  assert.deepEqual((await anna('GET', '/overview')).json.shopping.home, { home: 'familie', since: null });
  assert.deepEqual(await famLists(x, TIM), BOTH);
  assert.deepEqual(x.famHost.serviceCalls.filter((c) => c.plugin === HUB), []);
}));

test('the hub installed but no move: Familie owns its lists, the hub only shows them as before', () => linked({}, async (x) => {
  await x.fam(ANNA)('POST', '/shopping/ops', { ops: SEED });
  await x.both();
  x.clock.add(6 * MIN);
  await x.both();
  assert.deepEqual(x.hubCalls(), [], 'no shopping service is called without the button');
  assert.deepEqual((await x.fam(ANNA)('GET', '/shopping')).json.home, { home: 'familie', since: null });
  assert.deepEqual(await hubLists(x, ANNA), []);
  assert.deepEqual((await x.hub(ANNA)('GET', 'me')).json.shopping, { family: { available: true, bound: false, parent: false } });
  // as an item of Familie in „Mein Tag“ of the hub — looking only (1.19.0)
  const src = (await x.hub(ANNA)('GET', 'views/source:gatecontrol-familie')).json;
  assert.deepEqual(src.sections.flatMap((s) => s.items).filter((i) => i.kind === 'list').map((i) => [i.title, i.canComplete]).sort(), [['Drogerie', false], ['Einkauf', false]]);
}));

test('the move: a preview, the button, everything there once — again, and nothing is there twice; who may', () => linked({}, async (x) => {
  await x.fam(MARC)('POST', '/shopping/ops', { ops: SEED });
  // children and people outside the family do not move anything
  for (const u of [LENA, TIM]) for (const m of ['GET', 'POST']) assert.deepEqual([(await x.fam(u)(m, '/shopping/move', {})).status, (await x.fam(u)(m, '/shopping/move', {})).json.code], [403, 'parents_only']);
  assert.equal((await x.fam(OMA)('POST', '/shopping/move', {})).json.code, 'not_member');
  const pv = (await x.fam(ANNA)('GET', '/shopping/move')).json;
  assert.deepEqual([pv.lists, pv.items, pv.open, pv.hub, pv.moved, pv.canMove, pv.canBack], [2, 4, 3, { available: true }, false, true, false]);
  const mv = await x.fam(ANNA)('POST', '/shopping/move', {});
  assert.deepEqual(mv.json, { ok: true, moved: { lists: 2, items: 4 }, home: { home: 'notizen', since: '2026-10-14T08:00:00Z' } });
  // in the hub: the same ids, shared with the whole family, Marc's lists are Marc's
  for (const u of [ANNA, MARC, LENA, TIM]) assert.deepEqual(await hubLists(x, u), BOTH, u.name);
  assert.deepEqual(await hubLists(x, OMA), []);
  const g = (await x.hub(LENA)('GET', 'shopping')).json;
  assert.deepEqual(g.lists.map((l) => [l.family, l.owner.id, l.role, l.canEdit, l.canManage, l.icon, l.open, l.total]), [[true, MARC.id, 'write', true, false, 'cart', 2, 3], [true, MARC.id, 'write', true, false, null, 1, 1]]);
  assert.deepEqual(g.items.find((i) => i.id === I(3)).checkedBy, MARC.id);
  assert.deepEqual((await x.hub(ANNA)('GET', 'me')).json.shopping, { family: { available: true, bound: true, parent: true } });
  assert.equal((await x.hub(TIM)('GET', 'me')).json.shopping.family.parent, false);
  // Familie keeps its copy and says where the lists live
  assert.deepEqual(await famLists(x, TIM), BOTH);
  assert.deepEqual((await x.fam(TIM)('GET', '/overview')).json.shopping.home, { home: 'notizen', since: '2026-10-14T08:00:00Z' });
  assert.deepEqual((await x.fam(TIM)('GET', '/overview')).json.shopping.lists.map((l) => [l.name, l.open]), [['Einkauf', 2], ['Drogerie', 1]]);
  const after = (await x.fam(MARC)('GET', '/shopping/move')).json;
  assert.deepEqual([after.moved, after.canMove, after.canBack, after.home.home], [true, false, true, 'notizen']);
  // again (the button, the administrator's page, the background runs): nothing twice, nothing rewritten
  const puts = () => x.hubCalls().filter((c) => c.service === 'shopping_put').length;
  const n = puts();
  assert.equal((await x.fam(MARC)('POST', '/shopping/move', {})).status, 200);
  const adm = await x.admin('POST', 'shopping/move', {});
  assert.deepEqual([adm.status, adm.json.shopping.moved], [200, true]);
  await x.both();
  x.clock.add(6 * MIN);
  await x.both();
  assert.equal(puts(), n, 'nothing left to send');
  for (const u of [ANNA, TIM]) assert.deepEqual(await hubLists(x, u), BOTH);
  assert.deepEqual(await famLists(x, ANNA), BOTH);
  // the lists are the hub's own now — no longer items of the source Familie
  const src = (await x.hub(ANNA)('GET', 'views/source:gatecontrol-familie')).json;
  assert.deepEqual(src.sections.flatMap((s) => s.items).filter((i) => i.kind === 'list'), []);
}));

test('after the move: a change in Familie is in the hub, a change in the hub is in Familie — the wall tablet and the cards show it', () => linked({ settings: { mod_wall: true } }, async (x) => {
  await x.admin('POST', 'members', { userId: KUECHE.id, role: 'wall' });
  await x.fam(ANNA)('POST', '/shopping/ops', { ops: SEED });
  await x.fam(ANNA)('POST', '/shopping/move', {});
  // Familie → hub (Lena in the family app, the wall tablet in the kitchen)
  x.clock.add(MIN);
  await x.fam(LENA)('POST', '/shopping/ops', { ops: [{ op: 'item_add', id: I(10), listId: L1, text: 'Kakao' }, { op: 'item_check', id: I(1), checked: true }, { op: 'list_rename', id: L2, name: 'dm' }] });
  const wallOps = await x.famHost.request({ method: 'POST', path: '/shopping/ops', body: { ops: [{ op: 'item_add', id: I(11), listId: L1, text: 'Eier' }] }, query: {}, user: kioskViewer(KUECHE), lang: 'de' });
  assert.equal(wallOps.status, 200);
  await x.both();
  assert.deepEqual(await hubLists(x, MARC), [[L1, 'Einkauf', [['Milch', '2 l', true], ['Brot', null, false], ['Äpfel', '1 kg', true], ['Kakao', null, false], ['Eier', null, false]]], [L2, 'dm', [['Zahnpasta', null, false]]]]);
  assert.deepEqual((await x.hub(MARC)('GET', 'shopping')).json.items.find((i) => i.id === I(1)).checkedBy, LENA.id);
  // hub → Familie (Marc in „Aufgaben“): ticks, writes, deletes, a new family list, a rename
  x.clock.add(MIN);
  const r = await x.hub(MARC)('POST', 'shopping/ops', { ops: [
    { op: 'item_check', id: I(2), checked: true }, { op: 'item_add', id: I(12), listId: L1, text: 'Butter', qty: '250 g' }, { op: 'item_delete', id: I(10) },
    { op: 'list_add', id: L3, name: 'Baumarkt', family: true }, { op: 'item_add', id: I(13), listId: L3, text: 'Dübel' }, { op: 'list_rename', id: L1, name: 'Wocheneinkauf' },
  ] });
  assert.deepEqual(r.json.rejected, []);
  await x.both();
  assert.deepEqual(await famLists(x, TIM), [[L1, 'Wocheneinkauf', [['Milch', '2 l', true], ['Brot', null, true], ['Äpfel', '1 kg', true], ['Eier', null, false], ['Butter', '250 g', false]]],
    [L2, 'dm', [['Zahnpasta', null, false]]], [L3, 'Baumarkt', [['Dübel', null, false]]]]);
  // the tombstone of the item deleted in the hub reaches Familie's devices through ?since
  const since = (await x.fam(TIM)('GET', '/shopping', null, { since: '2026-10-14T08:01:30Z' })).json;
  assert.deepEqual(since.items.filter((i) => i.deleted).map((i) => i.id), [I(10)]);
  // the wall tablet shows the list from the hub
  const wall = (await x.famHost.request({ method: 'GET', path: '/wall', body: null, query: {}, user: kioskViewer(KUECHE), lang: 'de' })).json;
  assert.deepEqual([wall.shopping.list.name, wall.shopping.items.map((i) => i.text)], ['Wocheneinkauf', ['Eier', 'Butter']]);
  // a list deleted in the hub is gone in Familie; one deleted in Familie is in the hub's trash
  x.clock.add(MIN);
  await x.hub(MARC)('POST', 'shopping/ops', { ops: [{ op: 'list_delete', id: L3 }] });
  await x.fam(ANNA)('POST', '/shopping/ops', { ops: [{ op: 'list_delete', id: L2 }] });
  await x.both();
  assert.deepEqual((await famLists(x, ANNA)).map((l) => l[0]), [L1]);
  assert.deepEqual((await hubLists(x, ANNA)).map((l) => l[0]), [L1]);
  // changed on both sides before they met: Familie's later change of the same item wins, the others are kept
  x.clock.add(MIN);
  await x.hub(MARC)('POST', 'shopping/ops', { ops: [{ op: 'item_edit', id: I(11), text: 'Eier (10)' }, { op: 'item_check', id: I(12), checked: true }] });
  await x.fam(LENA)('POST', '/shopping/ops', { ops: [{ op: 'item_edit', id: I(11), text: 'Bio-Eier' }] });
  await x.both();
  const want = [[L1, 'Wocheneinkauf', [['Milch', '2 l', true], ['Brot', null, true], ['Äpfel', '1 kg', true], ['Bio-Eier', null, false], ['Butter', '250 g', true]]]];
  assert.deepEqual(await hubLists(x, ANNA), want);
  assert.deepEqual(await famLists(x, ANNA), want);
  // a new member of the family is in the lists, one who left is out
  await x.admin('POST', 'members', { userId: OMA.id, role: 'parent' });
  await x.both();
  assert.deepEqual((await hubLists(x, OMA)).map((l) => l[1]), ['Wocheneinkauf']);
  await x.admin('DELETE', 'members/' + OMA.id);
  await x.both();
  assert.deepEqual(await hubLists(x, OMA), []);
}));

test('„Ich gehe einkaufen“ and „Kannst du einkaufen gehen?“ from the hub: Familie\'s pushes and buttons, the state shown in the hub', () => linked({}, async (x) => {
  await x.fam(ANNA)('POST', '/shopping/ops', { ops: SEED });
  await x.fam(ANNA)('POST', '/shopping/move', {});
  const from = x.famHost.notifications.length;
  const going = await x.hub(MARC)('POST', `shopping/lists/${L1}/going`);
  assert.deepEqual([going.status, going.json.notified, going.json.list.going], [200, 3, [{ userId: MARC.id, at: '2026-10-14T08:00:00Z' }]]);
  const [g] = pushes(x.famHost, 'shopping_going', from);
  assert.deepEqual([g.title, g.body, g.users.slice().sort(), g.data.familie], ['Marc geht einkaufen (Einkauf-Liste) – fehlt noch etwas?', '2 Dinge stehen schon drauf.', [ANNA.id, LENA.id, TIM.id], { type: 'shopping_going', listId: L1, userId: MARC.id }]);
  const soon = await x.hub(MARC)('POST', `shopping/lists/${L1}/going`);
  assert.deepEqual([soon.status, soon.json.code, soon.json.retryAfter], [429, 'too_soon', 900]);
  // a list made in the hub a moment ago: Familie fetches it first
  await x.hub(ANNA)('POST', 'shopping/ops', { ops: [{ op: 'list_add', id: L3, name: 'Baumarkt', family: true }, { op: 'item_add', id: I(20), listId: L3, text: 'Dübel' }] });
  const asked = await x.hub(ANNA)('POST', `shopping/lists/${L3}/assign`, { userId: LENA.id, dueAt: '2026-10-14T16:00:00Z', notify: 'push' });
  assert.deepEqual([asked.status, asked.json.notified, asked.json.list.assignee, asked.json.list.dueAt],
    [200, { via: 'push', ok: true, code: null }, { userId: LENA.id, by: ANNA.id, at: '2026-10-14T08:00:00Z', state: 'open', notify: 'push' }, '2026-10-14T16:00:00Z']);
  const [a] = pushes(x.famHost, 'shopping_assigned', from);
  assert.deepEqual([a.users, a.body, a.data.actions.map((b) => b.id)], [[LENA.id], 'Baumarkt · 1 Artikel · bis heute 18:00', [`shop-take:${L3}`, `shop-decline:${L3}`]]);
  // „Übernehmen“ in Familie: the hub shows it after the next run
  assert.equal((await x.famHost.runQuickAction(LENA, `shop-take:${L3}`)).status, 200);
  await x.both();
  assert.equal((await x.hub(ANNA)('GET', 'shopping')).json.lists.find((l) => l.id === L3).assignee.state, 'taken');
  // refused by Familie: its code comes back
  const bad = await x.hub(ANNA)('POST', `shopping/lists/${L3}/assign`, { userId: OMA.id });
  assert.deepEqual([bad.status, bad.json.code, bad.json.field], [400, 'invalid', 'userId']);
}));

test('the last item ticked in Familie (the wall tablet): the task of the hub that carries the list is done', () => linked({ settings: { mod_wall: true } }, async (x) => {
  await x.admin('POST', 'members', { userId: KUECHE.id, role: 'wall' });
  await x.fam(ANNA)('POST', '/shopping/ops', { ops: SEED });
  await x.fam(ANNA)('POST', '/shopping/move', {});
  const made = await x.hub(ANNA)('POST', 'tasks', { text: 'bei Lidl einkaufen', attach: 'auto' });
  assert.deepEqual([made.json.attach.via, made.json.task.attachedList.uid, made.json.task.attachedList.family, made.json.task.attachedList.done, made.json.task.attachedList.total], ['word', L1, true, 1, 3]);
  await x.fam(TIM)('POST', '/shopping/ops', { ops: [{ op: 'item_check', id: I(1), checked: true }] });
  await x.both();
  assert.equal((await x.hub(ANNA)('GET', 'tasks/' + made.json.task.id)).json.task.done, false);
  x.clock.add(MIN);
  const w = await x.famHost.request({ method: 'POST', path: '/shopping/ops', body: { ops: [{ op: 'item_check', id: I(2), checked: true }] }, query: {}, user: kioskViewer(KUECHE), lang: 'de' });
  assert.deepEqual([w.status, w.json.applied], [200, 1]);
  await x.both();
  const t = (await x.hub(ANNA)('GET', 'tasks/' + made.json.task.id)).json.task;
  assert.deepEqual([t.done, t.doneAt, t.attachedList.open], [true, '2026-10-14T10:01:00+02:00', 0]);
}));

test('the way back: the hub away → Familie works on with its copy; back → what waited goes; a hub that forgot → Familie\'s own again', () => linked({}, async (x) => {
  await x.fam(ANNA)('POST', '/shopping/ops', { ops: SEED });
  await x.fam(ANNA)('POST', '/shopping/move', {});
  // the hub is switched off / removed
  x.hubOff();
  assert.deepEqual((await x.fam(TIM)('GET', '/shopping')).json.home, { home: 'familie', since: null });
  x.clock.add(MIN);
  const r = await x.fam(TIM)('POST', '/shopping/ops', { ops: [{ op: 'item_add', id: I(30), listId: L1, text: 'Hefe' }, { op: 'item_check', id: I(2), checked: true }, { op: 'list_add', id: L3, name: 'Baumarkt' }, { op: 'item_add', id: I(31), listId: L3, text: 'Dübel' }] });
  assert.deepEqual(r.json.rejected, []);
  await x.famHost.tick();
  const local = [[L1, 'Einkauf', [['Milch', '2 l', false], ['Brot', null, true], ['Äpfel', '1 kg', true], ['Hefe', null, false]]], [L2, 'Drogerie', [['Zahnpasta', null, false]]], [L3, 'Baumarkt', [['Dübel', null, false]]]];
  assert.deepEqual(await famLists(x, ANNA), local);
  const pv = (await x.fam(ANNA)('GET', '/shopping/move')).json;
  assert.deepEqual([pv.home.home, pv.hub.available, pv.moved, pv.canMove], ['familie', false, true, false]);
  // it is back: what waited goes there
  x.hubOn();
  x.clock.add(MIN);
  await x.both();
  assert.deepEqual(await hubLists(x, MARC), local);
  assert.equal((await x.fam(ANNA)('GET', '/shopping')).json.home.home, 'notizen');
  // a hub that knows nothing any more (installed anew): the lists are Familie's own again, nothing is lost
  await x.freshHub();
  x.clock.add(MIN);
  await x.fam(LENA)('POST', '/shopping/ops', { ops: [{ op: 'item_check', id: I(30), checked: true }] });
  await x.both();
  local[0][2][3] = ['Hefe', null, true];
  assert.deepEqual(await famLists(x, ANNA), local);
  const back = (await x.fam(ANNA)('GET', '/shopping/move')).json;
  assert.deepEqual([back.home.home, back.moved, back.canMove, back.lists, back.items], ['familie', false, true, 3, 6]);
  assert.deepEqual(await hubLists(x, ANNA), []);
  // … and the button moves them again
  assert.deepEqual((await x.fam(MARC)('POST', '/shopping/move', {})).json.moved, { lists: 3, items: 6 });
  assert.deepEqual(await hubLists(x, TIM), local);
}));

test('„Zurückholen“: Familie owns its lists again, the hub keeps them as ordinary lists; moving again makes nothing twice', () => linked({}, async (x) => {
  await x.fam(ANNA)('POST', '/shopping/ops', { ops: SEED });
  await x.fam(ANNA)('POST', '/shopping/move', {});
  x.clock.add(MIN);
  await x.hub(MARC)('POST', 'shopping/ops', { ops: [{ op: 'item_add', id: I(40), listId: L1, text: 'Kaffee' }] });
  assert.equal((await x.fam(LENA)('POST', '/shopping/move', { back: true })).json.code, 'parents_only');
  const back = await x.fam(ANNA)('POST', '/shopping/move', { back: true });
  assert.deepEqual(back.json, { ok: true, home: { home: 'familie', since: null } });
  // what the hub had comes along; from now on the two are apart
  const fam = [[L1, 'Einkauf', [['Milch', '2 l', false], ['Brot', null, false], ['Äpfel', '1 kg', true], ['Kaffee', null, false]]], [L2, 'Drogerie', [['Zahnpasta', null, false]]]];
  assert.deepEqual(await famLists(x, TIM), fam);
  assert.deepEqual((await x.hub(MARC)('GET', 'shopping')).json.lists.map((l) => [l.id, l.family]), [[L1, false], [L2, false]]);
  assert.deepEqual((await x.hub(MARC)('GET', 'me')).json.shopping.family.bound, false);
  x.clock.add(MIN);
  await x.fam(TIM)('POST', '/shopping/ops', { ops: [{ op: 'item_check', id: I(1), checked: true }] });
  const n = x.hubCalls().length;
  await x.both();
  assert.equal(x.hubCalls().length, n, 'nothing goes to the hub any more');
  assert.equal((await x.hub(MARC)('GET', 'shopping')).json.items.find((i) => i.id === I(1)).checked, false);
  // the administrator moves them again: the same lists, Familie's state, nothing twice
  const again = await x.admin('POST', 'shopping/move', {});
  assert.deepEqual([again.status, again.json.moved, again.json.shopping.home.home], [200, { lists: 2, items: 5 }, 'notizen']);
  fam[0][2][0] = ['Milch', '2 l', true];
  assert.deepEqual(await hubLists(x, LENA), fam);
  assert.deepEqual((await x.hub(LENA)('GET', 'shopping')).json.lists.map((l) => l.family), [true, true]);
  assert.equal((await x.admin('GET', 'shopping')).json.shopping.canBack, true);
  assert.equal((await x.famHost.request({ method: 'GET', path: '/admin/shopping', body: null, query: {}, user: app(ANNA), lang: 'de' })).status, 403);
  assert.equal(ADMIN.role, 'admin');
}));

test('the module shopping off: nothing moves', () => linked({ settings: { mod_shopping: false } }, async (x) => {
  assert.equal((await x.fam(ANNA)('GET', '/shopping/move')).json.code, 'module_off');
  const adm = await x.admin('POST', 'shopping/move', {});
  assert.deepEqual([adm.status, adm.json.code], [403, 'module_off']);
  assert.equal(T0, Date.UTC(2026, 9, 14, 8, 0, 0));
}));
