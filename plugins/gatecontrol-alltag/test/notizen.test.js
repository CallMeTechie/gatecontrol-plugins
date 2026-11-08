'use strict';

// 1.5.0: Alltag as a source of „Notizen & Aufgaben“ (gatecontrol-notizen, contract v1): the waste collections of the
// next days as items (lead 'evening', not completable), pushed only when they change (todo_changed, batched, at most
// every 10 s, kept on ERR_RATE_LIMIT), pulled with todo_items (paged ≤ 16 KB), todo_complete read_only — and nothing at
// all without the hub.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHost } = require('../../../tools/testing/mock-host');
const { fakeHub, checkItem, pullAll, HUB } = require('../../../tools/testing/notizen-hub');
const { DIR, ADMIN, ADA, BOB, USERS, asAdmin, day } = require('./helpers');
const notizen = require('../server/notizen');
const manifest = require('../plugin.json');

async function withHub(o, fn) {
  const hub = o.hub === undefined ? fakeHub() : o.hub;
  const host = await createHost(DIR, { users: USERS, settings: o.settings || {}, gatecontrol: o.gatecontrol || '1.216.0', services: hub ? [hub] : [] });
  await host.start();
  notizen.source.state.noTimer = true;
  try { return await fn(host, hub); } finally { notizen.source.stop(); await host.close(); }
}

const flush = (host) => notizen.source.flush(host.gc, Date.now(), { force: true });

async function plans(host) {
  const a = await asAdmin(host, 'POST', '/plans', { name: 'Zuhause', source: 'rules', rules: [{ name: 'Gelber Sack', start: day(1), weeks: 2 }, { name: 'Papier', start: day(3), weeks: 4 }] });
  const b = await asAdmin(host, 'POST', '/plans', { name: 'Eltern', source: 'rules', users: [BOB.id], rules: [{ name: 'Restmüll', start: day(0), weeks: 1 }] });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  return { home: a.json.plan ? a.json.plan.id : a.json.id, parents: b.json.plan ? b.json.plan.id : b.json.id };
}

test('plugin.json: todo_items and todo_complete (600 an hour), todo_changed of the hub', () => {
  assert.equal(manifest.version, '1.5.0');
  for (const n of ['todo_items', 'todo_complete']) assert.equal(manifest.services.provides[n].maxPerHour, 600);
  assert.ok(manifest.permissions.services.includes('gatecontrol-notizen:todo_changed'));
});

test('items: a collection per plan, day and fraction — lead evening, the plan’s people, not completable', () => withHub({}, async (host) => {
  const p = await plans(host);
  const items = [...(await notizen.source.items(host.gc)).values()];
  const yellow = items.find((x) => x.id.startsWith(`waste:${p.home}:${day(1)}:`));
  assert.ok(yellow);
  assert.equal(checkItem({ ...yellow, updatedAt: 1 }, 'gatecontrol-alltag'), null);
  assert.deepEqual([yellow.kind, yellow.title, yellow.due, yellow.allDay, yellow.lead, yellow.canComplete, yellow.done, yellow.area],
    ['event', 'Gelber Sack rausstellen', day(1), true, 'evening', false, false, 'private']);
  assert.match(yellow.subtitle, /^Zuhause · Abholung /);
  assert.deepEqual(yellow.users, [ADMIN.id, ADA.id, BOB.id], 'a plan for everyone: every account');
  assert.deepEqual(yellow.group, { id: `plan:${p.home}`, label: 'Zuhause' });
  assert.deepEqual(yellow.open, { plugin: 'gatecontrol-alltag', route: `waste/${day(1)}` });
  assert.equal(yellow.meta.type, 'yellow');
  const rest = items.find((x) => x.id.startsWith(`waste:${p.parents}:${day(0)}:`));
  assert.deepEqual(rest.users, [BOB.id], 'a plan of some people: only them');
  // only the next 14 days
  assert.ok(items.every((x) => x.due >= day(0) && x.due <= day(14)));
  // the waste area off: nothing
  host.settings.waste_enabled = false;
  assert.equal((await notizen.source.items(host.gc)).size, 0);
}));

test('push: one call for many changes, only real changes, removals; pull and push agree', () => withHub({}, async (host, hub) => {
  const p = await plans(host);
  const r1 = await flush(host);
  assert.equal(r1.sent, 1, 'every item in one call');
  const first = hub.pushes()[0].payload;
  assert.equal(first.v, 1);
  assert.ok(first.upsert.length >= 4);
  assert.deepEqual(first.remove, []);
  assert.equal(hub.rejected.length, 0, JSON.stringify(hub.rejected[0]));
  // nothing changed: no call
  const r2 = await flush(host);
  assert.equal(r2.sent, 0);
  assert.equal(hub.pushes().length, 1);
  // a fraction renamed: only its items
  const fr = (await asAdmin(host, 'GET', `/plans/${p.home}/dates`)).json;
  const fid = Number(first.upsert.find((x) => x.title === 'Papier rausstellen').id.split(':')[3]);
  assert.ok(fr);
  assert.equal((await asAdmin(host, 'PUT', `/plans/${p.home}/fractions/${fid}`, { name: 'Blaue Tonne' })).status, 200);
  await flush(host);
  const second = hub.pushes()[1].payload;
  assert.ok(second.upsert.length >= 1 && second.upsert.every((x) => x.title === 'Blaue Tonne rausstellen'));
  assert.ok(second.upsert.every((x) => x.updatedAt >= first.upsert[0].updatedAt));
  // the plan goes: its items are removed
  assert.equal((await asAdmin(host, 'DELETE', `/plans/${p.parents}`)).status, 200);
  await flush(host);
  const third = hub.pushes()[2].payload;
  assert.deepEqual(third.upsert, []);
  assert.ok(third.remove.length >= 1 && third.remove.every((id) => id.startsWith(`waste:${p.parents}:`)));
  // the hub's copy is what Alltag has
  const pulled = await pullAll(host, BOB);
  assert.deepEqual(pulled.items.map((x) => x.id).sort(), [...hub.items.keys()].map((k) => k.split('|')[1]).filter((id) => pulled.items.some((x) => x.id === id)).sort());
  for (const x of pulled.items) assert.deepEqual(x, hub.items.get(`gatecontrol-alltag|${x.id}`), 'the same item with the same updatedAt');
}));

test('push: at most every 10 s from the background, kept on ERR_RATE_LIMIT, nothing without the hub', async () => {
  let fail = false;
  const hub = fakeHub({ answer: () => { if (fail) throw Object.assign(new Error('rate'), { code: 'ERR_RATE_LIMIT' }); return undefined; } });
  await withHub({ hub }, async (host) => {
    await plans(host);
    fail = true;
    const r = await flush(host);
    assert.equal(r.upserted, 0);
    assert.equal((await host.gc.db.query('SELECT COUNT(*) AS n FROM todo_sent', [])).rows[0].n, 0, 'nothing marked as sent');
    fail = false;
    const again = await notizen.source.flush(host.gc, Date.now() + 1000);
    assert.equal(again.skipped, 'gap', 'not within 10 s');
    const later = await notizen.source.flush(host.gc, Date.now() + 11000);
    assert.ok(later.upserted >= 4, 'the kept difference goes with the next run');
  });
  // the host's real budget of the hub (3600 an hour) is never reached by a source: one call per run
  await withHub({ hub: null }, async (host) => {
    await plans(host);
    const r = await flush(host);
    assert.equal(r.skipped, 'unavailable');
    assert.equal(host.serviceCalls.length, 0);
    await host.tick();
    assert.equal(host.serviceCalls.length, 0);
  });
  // an older GateControl (no gc.services.available): nothing either
  await withHub({ gatecontrol: '1.177.0' }, async (host, h) => {
    await plans(host);
    assert.equal((await flush(host)).skipped, 'unavailable');
    assert.equal(h.calls.length, 0);
  });
});

test('todo_items paging (≤ 16 KB, cursor), visibility; todo_complete read_only; only the hub may call', () => withHub({}, async (host) => {
  const rules = [];
  for (let i = 0; i < 40; i++) rules.push({ name: `Sonderabfuhr ${'abcdefghijklmnopqrstuvwxyz'[i % 26]}${'abc'[Math.floor(i / 26)]} ${'y'.repeat(80)}`, start: day(i % 10), weeks: 1 });
  assert.equal((await asAdmin(host, 'POST', '/plans', { name: 'Viel '.repeat(10).trim(), source: 'rules', rules })).status, 201);
  const all = await pullAll(host, ADA, { limit: 100 });
  assert.ok(all.pages > 1, 'cut by size, not only by limit');
  assert.ok(all.items.length >= 50, String(all.items.length));
  assert.equal(new Set(all.items.map((x) => x.id)).size, all.items.length, 'no item twice');
  const one = await host.callService('todo_items', { caller: HUB, user: ADA, payload: { v: 1, limit: 3 } });
  assert.equal(one.items.length, 3);
  assert.ok(one.cursor);
  assert.ok(Number.isSafeInteger(one.now));
  const ext = await plans(host);
  assert.ok(ext);
  const ada = await pullAll(host, ADA);
  assert.ok(!ada.items.some((x) => x.users.length === 1 && x.users[0] === BOB.id), 'never what another person sees');
  const id = ada.items[0].id;
  assert.deepEqual(await host.callService('todo_complete', { caller: HUB, user: ADA, payload: { v: 1, id, done: true } }), { ok: false, code: 'read_only' });
  assert.deepEqual(await host.callService('todo_complete', { caller: HUB, user: ADA, payload: { v: 1, id: 'waste:999:2026-01-01:1', done: true } }), { ok: false, code: 'not_found' });
  assert.deepEqual(await host.callService('todo_complete', { caller: HUB, user: ADA, payload: { v: 1, id, done: 'yes' } }), { ok: false, code: 'invalid' });
  assert.deepEqual(await host.callService('todo_items', { caller: 'gatecontrol-familie', user: ADA, payload: { v: 1 } }), { ok: false, code: 'forbidden' });
  assert.deepEqual(await host.callService('todo_complete', { caller: 'gatecontrol-familie', user: ADA, payload: { v: 1, id, done: true } }), { ok: false, code: 'forbidden' });
  assert.deepEqual(await host.callService('todo_items', { caller: HUB, user: null, payload: { v: 1 } }), { ok: false, code: 'invalid' });
  assert.deepEqual(await host.callService('todo_items', { caller: HUB, user: ADA, payload: { v: 1, limit: 0 } }), { ok: false, code: 'invalid' });
  // the old services still answer
  assert.equal((await host.callService('calendar_list', { caller: 'gatecontrol-familie', user: ADA, payload: {} })).ok, true);
}));

test('server/todohub.js (the same in every source): 200 items of long titles — pages ≤ 16 KB, cursor, a push in one call', () => withHub({}, async (host, hub) => {
  const todohub = require('../server/todohub');
  const long = 'Ä'.repeat(200);
  let v = 'a';
  const src = todohub.create({
    plugin: 'gatecontrol-alltag',
    collect: async () => Array.from({ length: 200 }, (_, i) => ({ id: `x:${String(i).padStart(3, '0')}`, kind: 'task', title: `${i} ${v} ${long}`, subtitle: long, users: [ADA.id], meta: { type: 'test', note: long } })),
    complete: async () => ({ ok: true }),
  });
  const all = [];
  let cursor = null;
  let pages = 0;
  do {
    const res = await src.service(host.gc, { name: 'todo_items', caller: HUB, user: ADA, payload: { v: 1, limit: 100, cursor } });
    assert.ok(Buffer.byteLength(JSON.stringify(res)) <= 16 * 1024, 'an answer ≤ 16 KB');
    all.push(...res.items);
    cursor = res.cursor;
    pages++;
  } while (cursor && pages < 100);
  assert.equal(all.length, 200);
  assert.ok(pages > 2);
  assert.deepEqual(all.map((x) => x.id), Array.from({ length: 200 }, (_, i) => `x:${String(i).padStart(3, '0')}`));
  assert.equal(all[0].title.length, 200, 'titles cut to 200');
  // what was pulled is what the hub has: nothing to push
  assert.equal((await src.flush(host.gc, Date.now(), { force: true })).sent, 0);
  assert.equal(hub.pushes().length, 0);
  // all 200 changed: one call
  v = 'b';
  const r = await src.flush(host.gc, Date.now(), { force: true });
  assert.deepEqual([r.sent, r.upserted, hub.pushes().length, hub.rejected.length], [1, 200, 1, 0]);
}));
