'use strict';

// Offline devices (1.1.0): a send to an own device that is offline is 'waiting' (the push still goes out, GateControl
// queues it); the app asks GET pending once it is back — the send is listed until the device reports it opened, and
// the call makes the device's 'waiting' deliveries 'delivered'.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC, PDF, PNG, MIN, DAY } = require('./helpers');

const phone = (c) => c.as(ANNA, 'anna-phone');
const pc = (c) => c.as(ANNA, 'anna-pc');
const tab = (c) => c.as(ANNA, 'anna-tab');

test('an offline device: waiting (push still sent), the sender sees it; GET pending lists it and makes it delivered; opened takes it off', async () => {
  await withHost({}, async (host, c) => {
    const m = await c.upload(ANNA, PDF, 'application/pdf');
    const r = await phone(c)('POST', 'sends', { items: [{ mediaId: m, name: 'rechnung.pdf' }], to: { devices: ['anna-tab', 'anna-pc'] } });
    assert.equal(r.status, 200);
    const sent = r.json.deliveries;
    assert.deepEqual(sent.map((d) => [d.target, d.label, d.status, d.via, d.error]), [['anna-tab', 'Tablet', 'waiting', 'server', null], ['anna-pc', 'Büro-PC', 'delivered', 'server', null]]);
    assert.equal(sent[0].at, new Date(c.clock.now()).toISOString());
    // the visible push still goes to the tablet (GateControl queues it)
    assert.deepEqual(c.pushes().map((p) => [p.devices, p.silent, p.data]), [[['anna-tab'], undefined, { route: 'plg-gatecontrol-gatedrop', gatedrop: { send: r.json.id } }], [['anna-pc'], undefined, { route: 'plg-gatecontrol-gatedrop', gatedrop: { send: r.json.id } }]]);
    // the sender: inbox?kind=sent and GET sends/<id> show 'waiting' with label and time; waiting is not failed
    const out = (await phone(c)('GET', 'inbox', null, { kind: 'sent' })).json.items[0];
    assert.deepEqual(out.deliveries.map((d) => [d.label, d.status, d.at]), [['Tablet', 'waiting', sent[0].at], ['Büro-PC', 'delivered', sent[1].at]]);
    assert.equal((await c.portal(ANNA)('GET', `sends/${r.json.id}`)).json.send.deliveries[0].status, 'waiting');
    // the tablet may read the file even before it asks GET pending (from the queued push)
    assert.equal((await tab(c)('GET', `items/${m}`)).status, 200);
    assert.equal((await host.mediaGet({ ...ANNA }, m)).status, 200);
    // the tablet is back: GET pending
    c.clock.add(3 * MIN);
    const back = new Date(c.clock.now()).toISOString();
    const p = (await tab(c)('GET', 'pending')).json;
    assert.equal(p.ok, true);
    assert.deepEqual(Object.keys(p).sort(), ['items', 'ok']);
    assert.equal(p.items.length, 1);
    assert.deepEqual(p.items[0], (await tab(c)('GET', `sends/${r.json.id}`)).json.send, 'the send exactly as GET sends/<id> shows it');
    assert.deepEqual(p.items[0].items.map((i) => [i.mediaId, i.name, i.available]), [[m, 'rechnung.pdf', true]]);
    assert.deepEqual(p.items[0].deliveries.map((d) => [d.target, d.status, d.at]), [['anna-tab', 'delivered', back], ['anna-pc', 'delivered', sent[1].at]]);
    // the sender sees it delivered now
    assert.deepEqual((await phone(c)('GET', `sends/${r.json.id}`)).json.send.deliveries.map((d) => [d.target, d.status]), [['anna-tab', 'delivered'], ['anna-pc', 'delivered']]);
    // still listed until the device reports it received
    assert.equal((await tab(c)('GET', 'pending')).json.items.length, 1);
    const o = (await tab(c)('POST', `sends/${r.json.id}/opened`)).json.send;
    assert.deepEqual(o.deliveries.map((d) => [d.target, d.status]), [['anna-tab', 'opened'], ['anna-pc', 'delivered']], 'only the calling device');
    assert.deepEqual((await tab(c)('GET', 'pending')).json.items, []);
    // the PC got it through the server too: listed for the PC until it opens it
    assert.deepEqual((await pc(c)('GET', 'pending')).json.items.map((s) => s.id), [r.json.id]);
    await pc(c)('POST', `sends/${r.json.id}/opened`);
    assert.deepEqual((await pc(c)('GET', 'pending')).json.items, []);
  });
});

test('GET pending: only the target device — not another device, not another person; apps only (no_device)', async () => {
  await withHost({}, async (host, c) => {
    const m = await c.upload(ANNA, PNG, 'image/png');
    const r = (await phone(c)('POST', 'sends', { items: [{ mediaId: m }], to: { devices: ['anna-tab'] } })).json;
    assert.equal(r.deliveries[0].status, 'waiting');
    assert.deepEqual((await phone(c)('GET', 'pending')).json.items, [], 'the sending device');
    assert.deepEqual((await pc(c)('GET', 'pending')).json.items, [], 'another own device');
    assert.deepEqual((await c.as(MARC, 'marc-phone')('GET', 'pending')).json.items, [], 'another person');
    // a device id that is not one's own: nothing either (and nothing changes)
    assert.deepEqual((await c.as(MARC, 'anna-tab')('GET', 'pending')).json.items, []);
    assert.equal((await phone(c)('GET', `sends/${r.id}`)).json.send.deliveries[0].status, 'waiting', 'nobody else flips it');
    // the portal and an app without user.device
    for (const as of [c.portal(ANNA), c.as(ANNA)]) {
      const x = await as('GET', 'pending');
      assert.deepEqual([x.status, x.json.ok, x.json.code], [409, false, 'no_device']);
    }
    assert.equal((await tab(c)('POST', 'pending')).status, 404);
    // opened from another device of Anna's or from the portal does not touch the tablet's delivery
    await pc(c)('POST', `sends/${r.id}/opened`);
    await c.portal(ANNA)('POST', `sends/${r.id}/opened`);
    assert.equal((await tab(c)('GET', 'pending')).json.items.length, 1);
    assert.equal((await phone(c)('GET', `sends/${r.id}`)).json.send.deliveries[0].status, 'delivered');
  });
});

test('GET pending: texts and links without files are listed too; expired sends and direct deliveries are not; oldest first', async () => {
  await withHost({}, async (host, c) => {
    const old = (await phone(c)('POST', 'sends', { items: [{ mediaId: await c.upload(ANNA, PDF, 'application/pdf'), name: 'alt.pdf' }], to: { devices: ['anna-tab'] } })).json;
    c.clock.add(DAY);
    const a = (await phone(c)('POST', 'sends', { items: [{ mediaId: await c.upload(ANNA, PDF, 'application/pdf'), name: 'a.pdf' }], to: { devices: ['anna-tab'] } })).json;
    c.clock.add(MIN);
    const b = (await phone(c)('POST', 'sends', { items: [{ mediaId: await c.upload(ANNA, PNG, 'image/png'), name: 'b.png' }], to: { devices: ['anna-tab'] } })).json;
    c.clock.add(MIN);
    const text = (await phone(c)('POST', 'sends', { text: 'WLAN-Passwort: geheim', to: { devices: ['anna-tab'] } })).json;
    c.clock.add(MIN);
    const link = (await phone(c)('POST', 'sends', { link: 'https://example.com/rezept', note: 'heute Abend', to: { devices: ['anna-tab'] } })).json;
    assert.deepEqual([text.deliveries[0].status, link.deliveries[0].status], ['waiting', 'waiting']);
    // 6 days later the first send expires (7 days): not listed, even before the background removed its files
    c.clock.add(6 * DAY);
    const p = (await tab(c)('GET', 'pending')).json.items;
    assert.deepEqual(p.map((s) => s.id), [a.id, b.id, text.id, link.id], 'oldest first, no expired send; a text and a link without files too');
    assert.deepEqual([p[2].text, p[2].items, p[3].link, p[3].note], ['WLAN-Passwort: geheim', [], 'https://example.com/rezept', 'heute Abend']);
    assert.deepEqual(p[2], (await tab(c)('GET', `sends/${text.id}`)).json.send);
    // acknowledged with opened like a file send
    await tab(c)('POST', `sends/${text.id}/opened`);
    assert.deepEqual((await tab(c)('GET', 'pending')).json.items.map((s) => s.id), [a.id, b.id, link.id]);
    assert.equal((await phone(c)('GET', `sends/${text.id}`)).json.send.deliveries[0].status, 'opened');
    // the expired send's waiting delivery stays as it is; retention treats 'waiting' like 'delivered'
    await host.tick();
    const gone = (await phone(c)('GET', `sends/${old.id}`)).json.send;
    assert.deepEqual([gone.expired, gone.deliveries[0].status], [true, 'waiting']);
    assert.equal((await phone(c)('GET', `sends/${link.id}`)).json.send.deliveries[0].status, 'delivered');
    c.clock.add(2 * DAY);
    await host.tick();
    assert.deepEqual((await tab(c)('GET', 'pending')).json.items, []);
    assert.equal((await phone(c)('GET', `sends/${a.id}`)).json.send.deliveries[0].status, 'delivered');
  });
  // a direct transfer that worked is not listed
  await withHost({}, async (host, c) => {
    await c.presence(ANNA, 'anna-phone', '192.168.1.31', false);
    await c.presence(ANNA, 'anna-pc', '192.168.1.20', true);
    const r = (await phone(c)('POST', 'sends', { items: [{ mediaId: await c.upload(ANNA, PDF, 'application/pdf'), name: 'x.pdf' }], to: { devices: ['anna-pc'] } })).json;
    assert.deepEqual((await pc(c)('GET', 'pending')).json.items, [], 'direct, still open');
    await pc(c)('POST', `transfers/${r.direct[0].transferId}/result`, { ok: true });
    assert.deepEqual((await pc(c)('GET', 'pending')).json.items, [], 'delivered directly');
  });
});

test('GET pending: at most 50', async () => {
  await withHost({}, async (host, c) => {
    for (let i = 0; i < 52; i++) {
      await phone(c)('POST', 'sends', { items: [{ mediaId: await c.upload(ANNA, PDF, 'application/pdf'), name: `${i}.pdf` }], to: { devices: ['anna-tab'] } });
      c.clock.add(1000);
    }
    const p = (await tab(c)('GET', 'pending')).json.items;
    assert.equal(p.length, 50);
    assert.deepEqual([p[0].items[0].name, p[49].items[0].name], ['0.pdf', '49.pdf']);
  });
});
