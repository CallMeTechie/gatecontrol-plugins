'use strict';

// GateDrop 1.7.0: the TV app (platform 'android-tv') is a GateDrop device — listed in GET targets (one's own and, opened
// for everyone, someone else's), it receives through the server; a direct offer it answers with 'unsupported' and the
// server delivers by itself.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, devices, ANNA, MARC, PDF } = require('./helpers');
const people = require('../server/people');

const phone = (c) => c.as(ANNA, 'anna-phone');
const tv = (c) => c.as(ANNA, 'anna-tv');
const visible = (c) => c.pushes().filter((p) => !p.silent);
// GateControl lists the TV as an Android device; where it tells it apart, as clientType 'android-tv'
const withTv = () => [...devices(), { id: 'anna-tv', userId: ANNA.id, name: 'Wohnzimmer-TV', platform: 'android', clientType: 'android-tv', online: true }];

test('targets: the TV app is one of one\'s own devices (never direct) and, opened for everyone, someone else\'s', async () => {
  await withHost({ devices: withTv() }, async (host, c) => {
    const t = (await phone(c)('GET', 'targets')).json;
    assert.deepEqual(t.devices.map((d) => [d.id, d.name, d.platform, d.online, d.direct]),
      [['anna-pc', 'Büro-PC', 'windows', true, false], ['anna-tab', 'Tablet', 'android', false, false], ['anna-tv', 'Wohnzimmer-TV', 'android-tv', true, false]]);
    // the TV sees the others as its targets, not itself
    assert.deepEqual((await tv(c)('GET', 'targets')).json.devices.map((d) => d.id), ['anna-phone', 'anna-pc', 'anna-tab']);
    // the TV reports no presence: even with the phone's fresh report no direct way to it
    await c.presence(ANNA, 'anna-phone', '192.168.1.31', true);
    assert.equal((await phone(c)('GET', 'targets')).json.devices.find((d) => d.id === 'anna-tv').direct, false);
    // Anna opens her TV for everyone: Marc lists it with its owner
    assert.equal((await tv(c)('PUT', 'device', { receiveFrom: 'everyone' })).status, 200);
    const m = (await c.as(MARC, 'marc-phone')('GET', 'targets')).json;
    assert.deepEqual(m.peopleDevices.map((d) => [d.id, d.platform, d.owner]), [['anna-tv', 'android-tv', { id: ANNA.id, name: 'Anna' }]]);
  });
});

test('a send to the TV goes through the server: a push to the TV, GET pending, the file, opened', async () => {
  await withHost({ devices: withTv() }, async (host, c) => {
    const m = await c.upload(ANNA, PDF, 'application/pdf');
    const r = (await phone(c)('POST', 'sends', { items: [{ mediaId: m, name: 'rezept.pdf' }], text: 'Für heute Abend', to: { devices: ['anna-tv'] } })).json;
    assert.equal(r.ok, true);
    assert.deepEqual(r.direct, []);
    assert.deepEqual(r.deliveries.map((d) => [d.kind, d.target, d.status, d.via]), [['device', 'anna-tv', 'delivered', 'server']]);
    assert.deepEqual(visible(c).map((p) => [p.devices, p.data.gatedrop]), [[['anna-tv'], { send: r.id }]]);
    assert.deepEqual((await tv(c)('GET', 'pending')).json.items.map((s) => s.id), [r.id]);
    assert.equal((await tv(c)('GET', `items/${m}`)).status, 200);
    const o = (await tv(c)('POST', `sends/${r.id}/opened`)).json.send;
    assert.deepEqual(o.deliveries.map((d) => [d.target, d.status]), [['anna-tv', 'opened']]);
    assert.deepEqual((await tv(c)('GET', 'pending')).json.items, []);
  });
});

test('a direct offer the TV answers with \'unsupported\': the server way — a push when the files are there, else the sender uploads', async () => {
  await withHost({ devices: withTv() }, async (host, c) => {
    // a presence report of the TV (an app that reported one) makes a direct offer possible
    await c.presence(ANNA, 'anna-phone', '192.168.1.31', false);
    await c.presence(ANNA, 'anna-tv', '192.168.1.40', true);
    const m = await c.upload(ANNA, PDF, 'application/pdf');
    const r = (await phone(c)('POST', 'sends', { items: [{ mediaId: m, name: 'a.pdf' }], to: { devices: ['anna-tv'] } })).json;
    assert.equal(r.direct.length, 1);
    const f = (await tv(c)('POST', `transfers/${r.direct[0].transferId}/result`, { ok: false, error: 'unsupported' })).json;
    assert.deepEqual([f.transfer.status, f.fallback, f.delivery.status, f.delivery.via, f.delivery.error], ['failed', 'server', 'delivered', 'server', 'direct_failed']);
    assert.deepEqual(visible(c).map((p) => [p.devices, p.data.gatedrop]), [[['anna-tv'], { send: r.id }]]);
    assert.deepEqual((await tv(c)('GET', 'pending')).json.items.map((s) => s.id), [r.id]);
    // the sender learns why, while it waits for the TV
    assert.deepEqual((await phone(c)('GET', `transfers/${r.direct[0].transferId}`)).json.transfer.peer, { ok: false, error: 'unsupported' });
    // files only on the phone: the sender uploads them, then the push
    const r2 = (await phone(c)('POST', 'sends', { items: [{ name: 'b.pdf', bytes: PDF.length, local: true }], to: { devices: ['anna-tv'] } })).json;
    const f2 = (await tv(c)('POST', `transfers/${r2.direct[0].transferId}/result`, { ok: false, error: 'unsupported' })).json;
    assert.deepEqual([f2.fallback, f2.missing, f2.delivery.status, f2.delivery.error], ['upload', [0], 'pending', 'direct_failed']);
    const m2 = await c.upload(ANNA, PDF, 'application/pdf');
    const u = (await phone(c)('POST', `sends/${r2.id}/items`, { items: [{ index: 0, mediaId: m2 }] })).json.send;
    assert.deepEqual(u.deliveries.map((d) => [d.status, d.via]), [['delivered', 'server']]);
    assert.deepEqual(visible(c).pop().devices, ['anna-tv']);
  });
});

test('platformOf: the TV by platform or clientType \'android-tv\', every other device as GateControl lists it', () => {
  assert.equal(people.platformOf({ platform: 'android-tv' }), 'android-tv');
  assert.equal(people.platformOf({ platform: 'android', clientType: 'android-tv' }), 'android-tv');
  assert.equal(people.platformOf({ platform: 'android', clientType: 'android' }), 'android');
  assert.equal(people.platformOf({ platform: 'windows', clientType: 'pro' }), 'windows');
  assert.equal(people.platformOf({ platform: null, clientType: null }), null);
  assert.equal(people.hasGateDrop({ platform: 'android-tv' }), true);
  assert.equal(people.hasGateDrop({ platform: 'linux' }), false);
});
