'use strict';

// GateDrop 1.6.0: only devices with GateDrop as targets; a direct delivery is 'delivered' only with the receiving
// device's confirmation; without it, CONFIRM_MS after the sender's ok, the server way — once, never a second delivery.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, devices, ANNA, MARC, PDF, PNG } = require('./helpers');
const transfers = require('../server/transfers');

const phone = (c) => c.as(ANNA, 'anna-phone');
const pc = (c) => c.as(ANNA, 'anna-pc');
const SEC = 1000;

/** Anna's phone and PC in the same Wi-Fi, the PC listens. */
async function lan(c) {
  await c.presence(ANNA, 'anna-phone', '192.168.1.31', false);
  await c.presence(ANNA, 'anna-pc', '192.168.1.20', true);
}

const visible = (c) => c.pushes().filter((p) => !p.silent);
const deliveryOf = async (c, sendId) => (await phone(c)('GET', `sends/${sendId}`)).json.send.deliveries[0];

test('targets: only apps with GateDrop — not the Linux agent, a gateway / script token or iOS, even after they called the app API', async () => {
  const list = [
    ...devices(),
    { id: 'anna-agent', userId: ANNA.id, name: 'NAS-Agent', platform: 'linux', online: true },
    { id: 'anna-gw', userId: ANNA.id, name: 'Gateway', platform: null, online: true },
    { id: 'anna-ipad', userId: ANNA.id, name: 'iPad', platform: 'ios', online: true },
    { id: 'marc-agent', userId: MARC.id, name: 'Marcs Server', platform: 'linux', online: true },
  ];
  await withHost({ devices: list }, async (host, c) => {
    // the helper had every listed device call GET device (devices_seen); Marc opens his phone and his agent for everyone
    for (const d of ['marc-phone', 'marc-agent']) assert.equal((await c.as(MARC, d)('PUT', 'device', { receiveFrom: 'everyone' })).status, 200);
    const t = (await phone(c)('GET', 'targets')).json;
    assert.deepEqual(t.devices.map((d) => [d.id, d.platform]), [['anna-pc', 'windows'], ['anna-tab', 'android']]);
    assert.deepEqual(t.peopleDevices.map((d) => d.id), ['marc-phone']);
    // from the portal as well
    const p = (await c.portal(ANNA)('GET', 'targets')).json;
    assert.deepEqual(p.devices.map((d) => d.id), ['anna-phone', 'anna-pc', 'anna-tab']);
  });
});

test('direct: the sender\'s ok leaves the delivery on its way (\'direct\'); only the receiving device\'s ok delivers it', async () => {
  await withHost({}, async (host, c) => {
    await lan(c);
    const s = (await phone(c)('POST', 'sends', { items: [{ name: 'a.jpg', bytes: 1000, local: true }], to: { devices: ['anna-pc'] } })).json;
    const tr = s.direct[0].transferId;
    const mine = (await phone(c)('POST', `transfers/${tr}/result`, { ok: true, bytes: 1000 })).json;
    assert.deepEqual([mine.delivery.status, mine.delivery.via, mine.delivery.pickedAt, mine.fallback], ['direct', 'direct', null, null]);
    c.clock.add(10 * SEC);
    assert.deepEqual([(await deliveryOf(c, s.id)).status, (await deliveryOf(c, s.id)).pickedAt], ['direct', null], 'within the 20 s: still waiting for the receiver');
    const theirs = (await pc(c)('POST', `transfers/${tr}/result`, { ok: true, bytes: 1000 })).json;
    assert.deepEqual([theirs.delivery.status, theirs.delivery.via, theirs.delivery.pickedAt, theirs.fallback], ['delivered', 'direct', new Date(c.clock.now()).toISOString(), null]);
    // later: nothing falls back any more
    c.clock.add(60 * SEC);
    await host.tick();
    assert.deepEqual([(await deliveryOf(c, s.id)).status, (await deliveryOf(c, s.id)).via], ['delivered', 'direct']);
    assert.equal(visible(c).length, 0);
  });
});

test('no confirmation within 20 s, files on the server: the server way once — the sender learns it, a late ok only records the pick-up', async () => {
  await withHost({}, async (host, c) => {
    await lan(c);
    const m = await c.upload(ANNA, PDF, 'application/pdf');
    const s = (await phone(c)('POST', 'sends', { items: [{ mediaId: m, name: 'rechnung.pdf' }], to: { devices: ['anna-pc'] } })).json;
    const tr = s.direct[0].transferId;
    await phone(c)('POST', `transfers/${tr}/result`, { ok: true, bytes: PDF.length });
    c.clock.add(transfers.CONFIRM_MS - SEC);
    assert.equal((await deliveryOf(c, s.id)).status, 'direct');
    c.clock.add(2 * SEC);
    // the sender asks for the pick-up: the server way now
    const d = await deliveryOf(c, s.id);
    assert.deepEqual([d.status, d.via, d.error, d.pickedAt], ['delivered', 'server', 'direct_failed', null]);
    assert.equal(visible(c).length, 1, 'the PC gets the push of the server way');
    assert.deepEqual([visible(c)[0].devices, visible(c)[0].data.gatedrop], [['anna-pc'], { send: s.id }]);
    assert.equal((await pc(c)('GET', `transfers/${tr}`)).json.transfer.status, 'expired');
    // asked again, the background, a late ok of the sender: no second push
    await deliveryOf(c, s.id);
    await host.tick();
    await phone(c)('POST', `transfers/${tr}/result`, { ok: true, bytes: PDF.length });
    assert.equal(visible(c).length, 1);
    // the PC's app had the file after all: its late ok is the pick-up, the server way's state stays
    const late = (await pc(c)('POST', `transfers/${tr}/result`, { ok: true, bytes: PDF.length })).json;
    assert.deepEqual([late.delivery.status, late.delivery.via, late.delivery.pickedAt, late.fallback], ['delivered', 'server', new Date(c.clock.now()).toISOString(), null]);
    assert.equal(visible(c).length, 1);
    // the PC can still load it through the server (GET pending knows it as fetched only after its receipt)
    assert.equal((await pc(c)('GET', `items/${m}`)).status, 200);
  });
});

test('no confirmation, files only on the sender: the background takes the server way — the sender is asked to upload, once', async () => {
  await withHost({}, async (host, c) => {
    await lan(c);
    const s = (await phone(c)('POST', 'sends', { items: [{ name: 'a.jpg', bytes: 100, local: true }, { name: 'b.jpg', bytes: 200, local: true }], to: { devices: ['anna-pc'] } })).json;
    const tr = s.direct[0].transferId;
    await phone(c)('POST', `transfers/${tr}/result`, { ok: true, bytes: 300 });
    c.clock.add(30 * SEC);
    assert.equal((await host.tick()).unconfirmed, 1);
    assert.equal((await host.tick()).unconfirmed, 0, 'once');
    const d = await deliveryOf(c, s.id);
    assert.deepEqual([d.status, d.via, d.error], ['pending', null, 'direct_failed'], 'what Android\'s sender takes as "upload"');
    assert.equal(visible(c).length, 0, 'no push without the files');
    // the sender uploads: the push of the server way
    const m1 = await c.upload(ANNA, PNG, 'image/png');
    const m2 = await c.upload(ANNA, PDF, 'application/pdf');
    const up = (await phone(c)('POST', `sends/${s.id}/items`, { items: [{ index: 0, mediaId: m1 }, { index: 1, mediaId: m2 }] })).json;
    assert.deepEqual([up.send.deliveries[0].status, up.send.deliveries[0].via], ['delivered', 'server']);
    assert.equal(visible(c).length, 1);
  });
});

test('a late ok of the receiver after the server way asked for the upload: delivered directly, nothing uploaded or pushed', async () => {
  await withHost({}, async (host, c) => {
    await lan(c);
    const s = (await phone(c)('POST', 'sends', { items: [{ name: 'a.jpg', bytes: 100, local: true }], to: { devices: ['anna-pc'] } })).json;
    const tr = s.direct[0].transferId;
    await phone(c)('POST', `transfers/${tr}/result`, { ok: true, bytes: 100 });
    c.clock.add(25 * SEC);
    assert.equal((await deliveryOf(c, s.id)).status, 'pending');
    const late = (await pc(c)('POST', `transfers/${tr}/result`, { ok: true, bytes: 100 })).json;
    assert.deepEqual([late.delivery.status, late.delivery.via, late.delivery.error, late.fallback], ['delivered', 'direct', null, null]);
    assert.ok(late.delivery.pickedAt);
    assert.equal(visible(c).length, 0);
  });
});

test('the receiving device\'s receipt (POST sends/<id>/opened) confirms a direct delivery whose result it did not report', async () => {
  await withHost({}, async (host, c) => {
    await lan(c);
    const s = (await phone(c)('POST', 'sends', { text: 'hallo', to: { devices: ['anna-pc'] } })).json;
    await phone(c)('POST', `transfers/${s.direct[0].transferId}/result`, { ok: true, bytes: 0 });
    // another device or the portal: no confirmation
    await c.as(ANNA, 'anna-tab')('POST', `sends/${s.id}/opened`);
    assert.equal((await deliveryOf(c, s.id)).status, 'direct');
    const o = (await pc(c)('POST', `sends/${s.id}/opened`)).json.send.deliveries[0];
    assert.deepEqual([o.status, o.via, !!o.pickedAt], ['opened', 'direct', true]);
    c.clock.add(60 * SEC);
    assert.equal((await host.tick()).unconfirmed, 0);
    assert.equal(visible(c).length, 0);
  });
});
