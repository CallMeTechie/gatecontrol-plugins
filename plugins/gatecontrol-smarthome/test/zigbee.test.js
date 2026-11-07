'use strict';

// Zigbee devices of zigbee2mqtt through a GateControl gateway (server/zigbee.js, gc.radio.zigbee / gc.radio.command of
// GateControl with the radio follow-ups): resources like the other sources, switching through gc.radio.command, the
// portal, renaming, the deep link "In Smart Home benennen" and a device that is gone (off here, owners stay).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { withHost, asAdmin, asPortal, ADA, ADMIN } = require('./helpers');
const zigbee = require('../server/zigbee');
const radio = require('../server/radio');

const now = () => new Date().toISOString();
const devices = () => [
  { id: 'z2m:001788010b2c3d4e', gatewayId: 7, gateway: 'Pi Keller', ieee: '00:17:88:01:0b:2c:3d:4e', name: 'Wohnzimmer/Decke', model: '9290012573A', vendor: 'Philips',
    kind: 'light', caps: { bri: true, ct: true, color: 'xy' }, values: { on: true, bri: 50, ct: 370 }, battery: null, online: true, seenAt: now() },
  { id: 'z2m:000d6ffffe1a2b3c', gatewayId: 7, gateway: 'Pi Keller', ieee: '00:0d:6f:ff:fe:1a:2b:3c', name: 'Steckdose Kaffee', model: 'E1603', vendor: 'IKEA',
    kind: 'plug', caps: { power: true }, values: { on: false, power: 0 }, online: true, seenAt: now() },
  { id: 'z2m:00158d0001a2b3c4', gatewayId: 7, gateway: 'Pi Keller', ieee: '00:15:8d:00:01:a2:b3:c4', name: 'Bad Klima', model: 'WSDCGQ11LM', vendor: 'Aqara',
    kind: 'sensor', caps: { battery: true }, values: { temperature: 21.37, humidity: 55.1, battery: 100 }, battery: 100, online: true, seenAt: now() },
  { id: 'z2m:00158d0003030303', gatewayId: 7, gateway: 'Pi Keller', ieee: '00:15:8d:00:03:03:03:03', name: 'Rollo', model: 'ZNCLDJ12LM', vendor: 'Aqara',
    kind: 'cover', caps: { position: true }, values: { pos: 40 }, online: true, seenAt: now() },
  { id: 'z2m:00158d0004040404', gatewayId: 7, gateway: 'Pi Keller', ieee: '00:15:8d:00:04:04:04:04', name: 'Taster', kind: 'remote', caps: {}, values: { action: 'single' }, online: true, seenAt: now() },
  { id: 'evil', gatewayId: 7, ieee: 'x', kind: 'light' },
  { id: 'z2m:0000000000000001', gatewayId: 7, ieee: '00:00:00:00:00:00:00:01', kind: 'other' },
];

describe('zigbee2mqtt devices (gc.radio.zigbee)', () => {
  it('without gc.radio.zigbee (older GateControl): nothing; a radio source only with Bluetooth', async () => {
    zigbee._mem.at = 0;
    await withHost({ gateways: [], radio: { sensors: () => [] } }, async (host) => {
      assert.deepEqual(await zigbee.sync(host.gc, { force: true }), { available: false, devices: 0 });
      const r = await asAdmin(host, 'GET', '/ble/gateways');
      assert.deepEqual(r.json.gateways, []);
    });
  });

  it('devices become resources of the gateway\'s radio source; switching goes through gc.radio.command', async () => {
    let list = devices();
    const sent = [];
    zigbee._mem.at = 0;
    radio._mem.at = 0;
    await withHost({ gateways: [], radio: { sensors: () => [], zigbee: () => ({ gateways: [{ id: 7, name: 'Pi Keller' }], devices: list }), command: async (id, set) => { sent.push([id, set]); return { accepted: true }; } } }, async (host) => {
      const g = await asAdmin(host, 'GET', '/ble/gateways');
      assert.deepEqual(g.json.gateways, [{ id: 7, name: 'Pi Keller', sensors: 0, devices: 5 }]);
      const res = (await host.request({ path: '/ble/resources', query: { gateway_id: '7' }, user: ADMIN })).json.resources;
      const by = (n) => res.find((r) => r.name === n);
      assert.deepEqual(res.map((r) => [r.name, r.kind]).sort(), [['Bad Klima', 'sensor'], ['Rollo', 'cover'], ['Steckdose Kaffee', 'plug'], ['Taster', 'switch'], ['Wohnzimmer/Decke', 'light']]);
      const bulb = by('Wohnzimmer/Decke');
      assert.equal(bulb.deconz_type, 'z2m');
      assert.equal(bulb.uniqueid, '00:17:88:01:0b:2c:3d:4e');
      assert.deepEqual({ bri: bulb.capabilities.bri, ct: bulb.capabilities.ct, color: bulb.capabilities.color, source: bulb.capabilities.source }, { bri: true, ct: true, color: 'xy', source: 'z2m' });
      assert.deepEqual({ on: bulb.state.on, bri: bulb.state.bri, reachable: bulb.state.reachable }, { on: true, bri: 50, reachable: true });
      const klima = by('Bad Klima');
      assert.deepEqual({ type: klima.state.type, value: klima.state.value, humidity: klima.state.humidity, battery: klima.state.battery }, { type: 'temperature', value: 21.37, humidity: 55.1, battery: 100 });
      assert.deepEqual({ pos: by('Rollo').state.pos, position: by('Rollo').capabilities.position }, { pos: 40, position: true });

      // switch: on/bri, colour (hue/sat → the gateway converts), a plug, a shutter; a sensor is not controllable
      let r = await asAdmin(host, 'POST', `/resources/${bulb.id}/state`, { on: true, bri: 30, junk: 1 });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      r = await asAdmin(host, 'POST', `/resources/${bulb.id}/state`, { hue: 21845, sat: 254, ct: 300 });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      await asAdmin(host, 'POST', `/resources/${by('Steckdose Kaffee').id}/state`, { on: true, bri: 50 });
      await asAdmin(host, 'POST', `/resources/${by('Rollo').id}/state`, { cover: 'open' });
      assert.deepEqual(sent, [
        ['z2m:001788010b2c3d4e', { on: true, bri: 30 }],
        ['z2m:001788010b2c3d4e', { hue: 21845, sat: 254 }],
        ['z2m:000d6ffffe1a2b3c', { on: true }],
        ['z2m:00158d0003030303', { cover: 'open' }],
      ]);
      assert.equal((await asAdmin(host, 'POST', `/resources/${klima.id}/state`, { on: true })).status, 400);

      // the portal: assigned to Ada → she sees it without gateway internals and can switch it
      await asAdmin(host, 'PUT', `/resources/${bulb.id}/owners`, { userIds: [ADA.id] });
      const p = await asPortal(host, ADA, 'GET', '/portal');
      assert.equal(p.status, 200);
      const text = JSON.stringify(p.json);
      assert.ok(text.includes('Wohnzimmer/Decke'));
      assert.ok(!text.includes('Pi Keller'), 'no gateway name in the portal');
      // a name given here stays
      assert.equal((await asAdmin(host, 'PUT', `/resources/${bulb.id}`, { name: 'Decke' })).status, 200);
      zigbee._mem.at = 0;
      await zigbee.sync(host.gc, { force: true });
      assert.ok((await asAdmin(host, 'GET', '/ble/resources')).json.resources.some((x) => x.name === 'Decke'));
      // "In Smart Home benennen" finds a zigbee2mqtt device by its IEEE address
      const f = await host.request({ path: '/find', query: { focus: 'zigbee:00:17:88:01:0b:2c:3d:4e' }, user: ADMIN });
      assert.deepEqual(f.json.found, { source: 'b:7', resource_id: bulb.id });

      // gone from the gateway (removed from the network) → off here, the owners stay; back → on again
      list = devices().filter((d) => d.name !== 'Wohnzimmer/Decke');
      zigbee._mem.at = 0;
      await zigbee.sync(host.gc, { force: true });
      const rows = (await host.gc.db.query('SELECT enabled FROM resources WHERE id = ?', [bulb.id])).rows;
      assert.equal(rows[0].enabled, 0);
      const owners = (await host.gc.db.query('SELECT * FROM resource_owners WHERE resource_id = ?', [bulb.id])).rows;
      assert.equal(owners.length, 1);
      list = devices();
      zigbee._mem.at = 0;
      await zigbee.sync(host.gc, { force: true });
      assert.equal((await host.gc.db.query('SELECT enabled FROM resources WHERE id = ?', [bulb.id])).rows[0].enabled, 1);
    });
  });

  it('errors of the gateway become Smart Home errors', async () => {
    zigbee._mem.at = 0;
    let fail = 'ERR_RADIO_NOT_RUNNING';
    await withHost({ gateways: [], radio: { sensors: () => [], zigbee: () => ({ gateways: [{ id: 7, name: 'Pi Keller' }], devices: devices() }), command: async () => { throw Object.assign(new Error('x'), { code: fail }); } } }, async (host) => {
      await zigbee.sync(host.gc, { force: true });
      const res = (await asAdmin(host, 'GET', '/ble/resources')).json.resources;
      const plug = res.find((r) => r.kind === 'plug');
      let r = await asAdmin(host, 'POST', `/resources/${plug.id}/state`, { on: true });
      assert.equal(r.status, 502);
      assert.equal(r.json.code, 'SMARTHOME_RADIO_UNREACHABLE');
      fail = 'ERR_NOT_FOUND';
      r = await asAdmin(host, 'POST', `/resources/${plug.id}/state`, { on: true });
      assert.equal(r.status, 404);
      assert.equal((await asAdmin(host, 'POST', `/resources/${plug.id}/state`, {})).status, 400);
    });
  });

  it('resourceOf: kinds and states', () => {
    assert.equal(zigbee.resourceOf({ kind: 'other' }), null);
    const s = zigbee.resourceOf({ kind: 'sensor', values: { opening: true, battery: 80 }, online: true });
    assert.deepEqual({ reading: s.caps.reading, type: s.state.type, value: s.state.value }, { reading: 'open', type: 'open', value: true });
    const l = zigbee.resourceOf({ kind: 'light', caps: { bri: true, color: 'evil' }, values: { on: false }, online: false });
    assert.deepEqual({ bri: l.caps.bri, color: l.caps.color, reachable: l.state.reachable }, { bri: true, color: undefined, reachable: false });
  });
});
