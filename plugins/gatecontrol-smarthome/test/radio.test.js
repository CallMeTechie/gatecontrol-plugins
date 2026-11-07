'use strict';

// Bluetooth sensors through a GateControl gateway (server/radio.js, gc.radio of GateControl with phase 3c step 2),
// renaming ("In Smart Home benennen": deCONZ lights/sensors in deCONZ, every part of a device; Bluetooth sensors here)
// and the page's deep link (GET /find?focus=…).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { fakeDeconz, withHost, asAdmin, asPortal, connected, ADA, ADMIN } = require('./helpers');
const find = (host, focus) => host.request({ path: '/find', query: { focus }, user: ADMIN });
const radio = require('../server/radio');

const now = () => new Date().toISOString();
const sensors = () => [
  { id: 'ble:a4c138112233', gatewayId: 7, gateway: 'Pi Keller', mac: 'A4:C1:38:11:22:33', name: 'Gartenhaus', model: 'Xiaomi LYWSD03MMC', format: 'pvvx',
    values: { temperature: 8.9, humidity: 64, battery: 82 }, battery: 82, online: true, seenAt: now() },
  { id: 'ble:7cc6b6001122', gatewayId: 7, gateway: 'Pi Keller', mac: '7C:C6:B6:00:11:22', name: 'Keller', model: 'Shelly BLU H&T', format: 'bthome',
    values: { temperature: 14.2, humidity: 71, battery: 100 }, battery: 100, online: false, seenAt: now() },
  { id: 'evil', gatewayId: 7, mac: 'x' },
];

describe('Bluetooth sensors (gc.radio)', () => {
  it('without gc.radio (older GateControl): nothing, no error', async () => {
    await withHost({ gateways: [] }, async (host) => {
      const r = await asAdmin(host, 'GET', '/ble/gateways');
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, { ok: true, available: false, gateways: [] });
    });
  });

  it('taken-over sensors become sensor resources per GateControl gateway; owners see them in the portal', async () => {
    let list = sensors();
    radio._mem.at = 0;
    await withHost({ gateways: [], radio: { sensors: () => list } }, async (host) => {
      const g = await asAdmin(host, 'GET', '/ble/gateways');
      assert.deepEqual(g.json.gateways, [{ id: 7, name: 'Pi Keller', sensors: 2, devices: 0 }]);
      const res = (await host.request({ path: '/ble/resources', query: { gateway_id: '7' }, user: ADMIN })).json.resources;
      assert.equal(res.length, 2);
      const garden = res.find((r) => r.name === 'Gartenhaus');
      assert.deepEqual(garden.state.type, 'temperature');
      assert.equal(garden.state.value, 8.9);
      assert.equal(garden.state.humidity, 64);
      assert.equal(garden.state.battery, 82);
      assert.equal(garden.state.reachable, true);
      assert.equal(garden.uniqueid, 'a4:c1:38:11:22:33');
      assert.equal(garden.capabilities.source, 'ble');
      assert.equal(res.find((r) => r.name === 'Keller').state.reachable, false);
      // assign to Ada → she sees it in the portal
      await asAdmin(host, 'PUT', `/resources/${garden.id}/owners`, { userIds: [ADA.id] });
      const p = await asPortal(host, ADA, 'GET', '/portal');
      assert.equal(p.status, 200);
      assert.ok(JSON.stringify(p.json).includes('Gartenhaus'));
      // a name given here stays; given back in GateControl → gone
      const rn = await asAdmin(host, 'PUT', `/resources/${garden.id}`, { name: 'Gartenhaus Nord' });
      assert.equal(rn.status, 200, JSON.stringify(rn.json));
      radio._mem.at = 0;
      await radio.sync(host.gc, { force: true });
      let again = (await asAdmin(host, 'GET', '/ble/resources')).json.resources;
      assert.ok(again.some((r) => r.name === 'Gartenhaus Nord'));
      list = sensors().slice(1);
      await radio.sync(host.gc, { force: true });
      again = (await asAdmin(host, 'GET', '/ble/resources')).json.resources;
      assert.deepEqual(again.map((r) => r.name), ['Keller']);
      // the deep link of GateControl
      const f = await find(host, 'ble:7c:c6:b6:00:11:22');
      assert.equal(f.json.found.source, 'b:7');
      assert.equal(f.json.found.resource_id, again[0].id);
    });
  });

  it('sensorState: temperature first, contacts and motion as the deCONZ ones', () => {
    assert.deepEqual(radio.sensorState({ values: { humidity: 55 }, online: true }).state, { reachable: true, type: 'humidity', value: 55 });
    assert.equal(radio.sensorState({ values: { window: true } }).state.type, 'open');
    assert.equal(radio.sensorState({ values: { motion: false } }).reading, 'presence');
  });
});

describe('"In Smart Home benennen" for deCONZ', () => {
  it('a sensor is renamed in deCONZ with every part of its device; groups cannot; the deep link finds it', async () => {
    const gw = fakeDeconz({
      sensors: {
        20: { name: 'TH 9', type: 'ZHATemperature', uniqueid: '00:15:8d:00:0a:0b:0c:0d-01-0402', state: { temperature: 2150 } },
        21: { name: 'TH 9', type: 'ZHAHumidity', uniqueid: '00:15:8d:00:0a:0b:0c:0d-01-0405', state: { humidity: 5500 } },
        22: { name: 'Other', type: 'ZHAOpenClose', uniqueid: '00:15:8d:00:99:99:99:99-01-0006', state: { open: false } },
      },
    });
    await withHost({ gateways: [gw] }, async (host) => {
      const c = await connected(host);
      const temp = c.resources.find((r) => r.deconz_id === '20');
      const f = await find(host, 'zigbee:00:15:8d:00:0a:0b:0c:0d');
      assert.deepEqual(f.json.found, { source: 'd:' + c.id, resource_id: f.json.found.resource_id });
      assert.ok([temp.id, c.resources.find((r) => r.deconz_id === '21').id].includes(f.json.found.resource_id));
      const r = await asAdmin(host, 'PUT', `/resources/${temp.id}`, { name: 'Wohnzimmer' });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.renamed, 2);
      const puts = gw.calls.filter((x) => x.method === 'PUT' && /^\/api\/[^/]+\/sensors\/\d+$/.test(x.path));
      assert.deepEqual(puts.map((x) => [x.path.split('/').pop(), x.body]).sort(), [['20', { name: 'Wohnzimmer' }], ['21', { name: 'Wohnzimmer' }]]);
      const group = c.resources.find((x) => x.kind === 'group');
      assert.equal((await asAdmin(host, 'PUT', `/resources/${group.id}`, { name: 'X' })).status, 400);
      assert.equal((await asAdmin(host, 'PUT', `/resources/${temp.id}`, { name: '   ' })).status, 400);
      assert.equal((await find(host, 'zigbee:00:00:00:00:00:00:00:01')).json.found, null);
      assert.equal((await find(host, '../x')).json.found, null);
    });
  });
});
