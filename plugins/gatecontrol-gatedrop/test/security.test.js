'use strict';

// Review findings: the Messenger's refusals are final (no push around a block), the Messenger's quota (25 MB per file,
// 100 MB per send, 200 hand-overs per sender and day), family sends only for the family at sending, the NAS folder
// GateDrop chose, generic titles of PIN links, key and ticket removed once a transfer ended.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, app, ANNA, MARC, LENA, OMA, PDF, PNG, MIN } = require('./helpers');

const MB = 1024 * 1024;

test('a block in the Messenger: the delivery fails — no push, nothing in the inbox, no access to the file', async () => {
  await withHost({ messenger: true }, async (host, c) => {
    assert.equal((await c.messenger.request({ method: 'POST', path: 'blocks', body: { userId: ANNA.id }, user: app(MARC), query: {} })).status, 200);
    const pdf = await c.upload(ANNA, PDF, 'application/pdf');
    const big = await c.upload(ANNA, Buffer.from('big'), 'video/mp4', { bytes: 500 * MB });
    const r = (await c.as(ANNA)('POST', 'sends', { items: [{ mediaId: pdf, name: 'a.pdf' }, { mediaId: big, name: 'film.mp4' }], to: { people: [MARC.id] } })).json;
    assert.deepEqual(r.deliveries.map((d) => [d.status, d.error, d.via]), [['failed', 'forbidden', null]]);
    assert.equal(c.pushes().length, 0, 'no push around the block — not even for the large file');
    assert.equal((await c.as(MARC)('GET', 'inbox', null, { kind: 'received' })).json.items.length, 0);
    assert.equal((await c.as(MARC)('GET', `sends/${r.id}`)).status, 404);
    assert.equal((await host.mediaGet({ ...MARC }, big)).status, 404);
    // text only: the same
    const t = (await c.as(ANNA)('POST', 'sends', { text: 'hallo', to: { people: [MARC.id] } })).json;
    assert.deepEqual([t.deliveries[0].status, t.deliveries[0].error], ['failed', 'forbidden']);
    assert.equal(c.pushes().length, 0);
  });
});

test('without the Messenger: the push is the way', async () => {
  await withHost({}, async (host, c) => {
    const r = (await c.as(ANNA)('POST', 'sends', { text: 'hallo', to: { people: [MARC.id] } })).json;
    assert.deepEqual([r.deliveries[0].status, r.deliveries[0].via], ['delivered', 'server']);
    assert.deepEqual(c.pushes().map((p) => p.users), [[MARC.id]]);
  });
});

test('Messenger quota: ≤ 25 MB per file and ≤ 100 MB per send go into chats, the rest through GateDrop; 200 hand-overs a day', async () => {
  await withHost({ messenger: true }, async (host, c) => {
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(await c.upload(ANNA, PDF, 'application/pdf', { bytes: 20 * MB }));
    const items = ids.map((m, i) => ({ mediaId: m, name: `teil-${i}.pdf` }));
    const r = (await c.as(ANNA)('POST', 'sends', { items, to: { people: [MARC.id, LENA.id] } })).json;
    // Marc: all three (60 MB); Lena: two more (100 MB in all), the third stays in GateDrop
    assert.equal(host.handOvers.length, 5);
    assert.deepEqual(r.deliveries.map((d) => [d.target, d.status, !!d.conversationId]), [[String(MARC.id), 'delivered', true], [String(LENA.id), 'delivered', true]]);
    const rows = (await host.gc.db.query('SELECT target, handed, gd_items FROM deliveries ORDER BY id')).rows;
    assert.deepEqual(rows.map((x) => [x.target, x.handed, x.gd_items]), [[String(MARC.id), 3, 0], [String(LENA.id), 2, 1]]);
    assert.deepEqual(c.pushes().map((p) => [p.users, p.body]), [[[LENA.id], 'teil-2.pdf']]);
    assert.equal((await c.as(LENA)('GET', 'inbox', null, { kind: 'received' })).json.items.length, 1);
    assert.equal((await c.as(MARC)('GET', 'inbox', null, { kind: 'received' })).json.items.length, 0, 'all in the chat');
    // the daily budget: 200 hand-overs per sender (Messenger and NAS) — then everything stays in GateDrop
    await host.gc.db.run('UPDATE deliveries SET handed = 100');
    const small = await c.upload(ANNA, PNG, 'image/png');
    const r2 = (await c.as(ANNA)('POST', 'sends', { items: [{ mediaId: small, name: 'x.png' }], to: { people: [MARC.id] } })).json;
    assert.equal(host.handOvers.length, 5, 'no new hand-over');
    assert.deepEqual([r2.deliveries[0].status, !!r2.deliveries[0].conversationId], ['delivered', true], 'the chat names the file in GateDrop');
    assert.equal(c.pushes().pop().users[0], MARC.id);
    c.clock.add(25 * 60 * MIN);
    const r3 = (await c.as(ANNA)('POST', 'sends', { items: [{ mediaId: await c.upload(ANNA, PNG, 'image/png'), name: 'y.png' }], to: { people: [MARC.id] } })).json;
    assert.equal(host.handOvers.length, 6, 'a day later the budget is back');
    assert.ok(r3.deliveries[0].conversationId);
  });
});

test('family sends: only the family at sending sees them — a member added later does not', async () => {
  const roles = { parents: [ANNA.id, MARC.id], children: [LENA.id] };
  await withHost({ roles }, async (host, c) => {
    const pdf = await c.upload(ANNA, PDF, 'application/pdf');
    const r = (await c.as(ANNA)('POST', 'sends', { items: [{ mediaId: pdf, name: 'a.pdf' }], to: { people: ['family'] } })).json;
    assert.deepEqual(c.pushes().map((p) => p.users), [[MARC.id, LENA.id]]);
    roles.children.push(OMA.id); // Oma joins the family afterwards
    c.clock.add(11 * MIN);       // Familie's roles are cached 10 minutes
    assert.equal((await c.as(OMA)('GET', 'inbox', null, { kind: 'received' })).json.items.length, 0);
    assert.equal((await c.as(OMA)('GET', `sends/${r.id}`)).status, 404);
    assert.equal((await host.mediaGet({ ...OMA }, pdf)).status, 404);
    assert.equal((await c.as(LENA)('GET', `sends/${r.id}`)).status, 200);
    roles.children.splice(roles.children.indexOf(LENA.id), 1); // Lena leaves: she keeps what she got
    c.clock.add(11 * MIN);
    assert.equal((await host.mediaGet({ ...LENA }, pdf)).status, 200);
  });
});

test('PIN links get a generic title; links without PIN keep the file name', async () => {
  await withHost({}, async (host, c) => {
    const a = (await c.as(ANNA)('POST', 'sends', { items: [{ mediaId: await c.upload(ANNA, PDF, 'application/pdf'), name: 'steuer-2025.pdf' }], to: { link: { expires: '1d', pin: true } } })).json;
    const b = (await c.as(ANNA)('POST', 'sends', { items: [{ mediaId: await c.upload(ANNA, PDF, 'application/pdf'), name: 'flyer.pdf' }], to: { link: { expires: '1d', pin: false } } })).json;
    assert.equal(host.publicLinks.get(a.link.token).title, 'Geteilte Dateien');
    assert.equal(host.publicLinks.get(b.link.token).title, 'flyer.pdf');
    const en = await host.request({ method: 'POST', path: 'sends', user: app(ANNA), lang: 'en', body: { items: [{ mediaId: await c.upload(ANNA, PDF, 'application/pdf'), name: 'x.pdf' }], to: { link: { expires: '1h', pin: true } } } });
    assert.equal(host.publicLinks.get(en.json.link.token).title, 'Shared files');
  });
});

test('transfers: key and ticket are removed from the database once done, failed or expired', async () => {
  await withHost({}, async (host, c) => {
    await c.presence(ANNA, 'anna-phone', '192.168.1.31', true);
    await c.presence(ANNA, 'anna-pc', '192.168.1.20', true);
    const send = async () => (await c.as(ANNA, 'anna-phone')('POST', 'sends', { items: [{ mediaId: await c.upload(ANNA, PDF, 'application/pdf'), name: 'a.pdf' }], to: { devices: ['anna-pc'] } })).json.direct[0].transferId;
    const row = async (id) => (await host.gc.db.get('SELECT status, key, ticket FROM transfers WHERE id = ?', [id])).row;
    const done = await send();
    const failed = await send();
    const expired = await send();
    assert.ok((await row(done)).key);
    await c.as(ANNA, 'anna-pc')('POST', `transfers/${done}/result`, { ok: true });
    await c.as(ANNA, 'anna-pc')('POST', `transfers/${failed}/result`, { ok: false });
    c.clock.add(11 * MIN);
    await host.tick();
    for (const [id, st] of [[done, 'done'], [failed, 'failed'], [expired, 'expired']]) assert.deepEqual(await row(id), { status: st, key: null, ticket: null });
  });
});
