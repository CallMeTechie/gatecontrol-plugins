'use strict';

// zigbee2mqtt, what 1.10.0 adds (server/zigbee.js): devices with several switched channels (state_l1, state_l2 …) as
// one resource per channel, thermostats (measured / target temperature, mode) and firmware updates over the air —
// against the list a GateControl with these follow-ups hands out (gc.radio.zigbee) and gc.radio.command. An older
// GateControl or gateway reports none of the new fields: then everything stays as it was.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { withHost, asAdmin, asPortal, ADA, BOB, ADMIN } = require('./helpers');
const zigbee = require('../server/zigbee');
const radio = require('../server/radio');

const now = () => new Date().toISOString();
const base = { gatewayId: 7, gateway: 'Pi Keller', online: true };
const SWITCH3 = (o = {}) => ({ ...base, id: 'z2m:a4c1380000112233', ieee: 'a4:c1:38:00:00:11:22:33', name: 'Schalter Flur', model: 'TS0003', vendor: 'Tuya',
  kind: 'plug', caps: { channels: ['l1', 'l2', 'l3'], ota: true }, values: { on: true, ch: { l1: true, l2: false, l3: true }, ota: { state: 'available', installed: 16777220, latest: 16777221 } }, seenAt: now(), ...o });
const TRV = (o = {}) => ({ ...base, id: 'z2m:00158d0005050505', ieee: '00:15:8d:00:05:05:05:05', name: 'Heizung Bad', model: 'SRTS-A01', vendor: 'Aqara',
  kind: 'climate', caps: { setpoint: { min: 5, max: 30, step: 0.5 }, modes: ['off', 'heat', 'auto', 'party'], battery: true, ota: true },
  values: { temperature: 20.4, setpoint: 21.5, mode: 'heat', heating: true, valve: 37, battery: 64, ota: { state: 'updating', progress: 37.6 } }, seenAt: now(), ...o });
const PLUG = (o = {}) => ({ ...base, id: 'z2m:000d6ffffe1a2b3c', ieee: '00:0d:6f:ff:fe:1a:2b:3c', name: 'Steckdose Kaffee', model: 'E1603', vendor: 'IKEA',
  kind: 'plug', caps: { power: true, ota: true }, values: { on: false, power: 0, ota: { state: 'idle', checked: '2026-11-11T10:00:00.000Z', installed: '2.3.089' } }, seenAt: now(), ...o });

async function withRadio(listFn, fn) {
  const sent = [];
  const state = { fail: null };
  zigbee._mem.at = 0;
  radio._mem.at = 0;
  await withHost({ gateways: [], radio: {
    sensors: () => [],
    zigbee: () => ({ gateways: [{ id: 7, name: 'Pi Keller' }], devices: listFn() }),
    command: async (id, set) => { sent.push([id, set]); if (state.fail) throw Object.assign(new Error('x'), { code: state.fail }); return { accepted: true }; },
  } }, async (host) => fn(host, sent, state));
}
const resources = async (host) => { zigbee._mem.at = 0; return (await host.request({ path: '/ble/resources', query: { gateway_id: '7' }, user: ADMIN })).json.resources; };

describe('zigbee2mqtt: several channels, thermostats, firmware updates', () => {
  it('a 3-gang switch: one resource per channel, each switched by itself with its channel', async () => {
    await withRadio(() => [SWITCH3(), PLUG()], async (host, sent) => {
      const res = await resources(host);
      const ch = res.filter((r) => r.uniqueid === 'a4:c1:38:00:00:11:22:33').sort((a, b) => a.capabilities.channel_no - b.capabilities.channel_no);
      assert.deepEqual(ch.map((r) => [r.name, r.kind, r.deconz_id, r.capabilities.channel, r.capabilities.channel_no, r.state.on]), [
        ['Schalter Flur 1', 'plug', 'z2m:a4c1380000112233/l1', 'l1', 1, true],
        ['Schalter Flur 2', 'plug', 'z2m:a4c1380000112233/l2', 'l2', 2, false],
        ['Schalter Flur 3', 'plug', 'z2m:a4c1380000112233/l3', 'l3', 3, true],
      ]);
      assert.equal((await asAdmin(host, 'GET', '/ble/gateways')).json.gateways[0].devices, 4, 'three channels and the plug');
      let r = await asAdmin(host, 'POST', `/resources/${ch[1].id}/state`, { on: true, bri: 50 });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.deepEqual(sent.pop(), ['z2m:a4c1380000112233', { on: true, channel: 'l2' }], 'the device id and the channel; a channel is not dimmed');
      r = await asAdmin(host, 'POST', `/resources/${ch[2].id}/state`, { on: false });
      assert.deepEqual(sent.pop(), ['z2m:a4c1380000112233', { on: false, channel: 'l3' }]);
      const cached = (await host.gc.db.query("SELECT deconz_id, state_json FROM resources WHERE deconz_id LIKE 'z2m:a4c1380000112233/%' ORDER BY deconz_id")).rows.map((x) => JSON.parse(x.state_json).on);
      assert.deepEqual(cached, [true, true, false], 'the cached state follows what was sent, per channel');
      // a device without channels still gets no channel
      const plug = res.find((x) => x.name === 'Steckdose Kaffee');
      await asAdmin(host, 'POST', `/resources/${plug.id}/state`, { on: true });
      assert.deepEqual(sent.pop(), ['z2m:000d6ffffe1a2b3c', { on: true }]);
      // owners, area and a name per channel; the portal switches only the own channel
      assert.equal((await asAdmin(host, 'PUT', `/resources/${ch[0].id}/owners`, { userIds: [ADA.id] })).status, 200);
      assert.equal((await asAdmin(host, 'PUT', `/resources/${ch[0].id}`, { name: 'Flurlicht' })).status, 200);
      assert.equal((await asAdmin(host, 'PUT', `/resources/${ch[0].id}`, { area: 'Flur' })).status, 200);
      const portal = (await asPortal(host, ADA, 'GET', '/portal')).json;
      assert.deepEqual(portal.devices.map((d) => [d.name, d.kind, d.area]), [['Flurlicht', 'plug', 'Flur']]);
      assert.equal((await asPortal(host, ADA, 'POST', `/portal/resources/${ch[0].id}/state`, { patch: { on: false } })).status, 200);
      assert.deepEqual(sent.pop(), ['z2m:a4c1380000112233', { on: false, channel: 'l1' }]);
      assert.equal((await asPortal(host, ADA, 'POST', `/portal/resources/${ch[1].id}/state`, { patch: { on: true } })).status, 403);
      assert.deepEqual((await resources(host)).filter((x) => x.capabilities.channel_no).map((x) => x.name).sort(), ['Flurlicht', 'Schalter Flur 2', 'Schalter Flur 3'], 'a name given here stays');
    });
  });

  it('a device that had one resource (its first channel) becomes channel 1 and keeps name, area and owners — and back', async () => {
    let list = [SWITCH3({ caps: {}, values: { on: true } })]; // an older gateway: the first channel only
    await withRadio(() => list, async (host) => {
      let res = await resources(host);
      assert.deepEqual(res.map((r) => [r.name, r.deconz_id]), [['Schalter Flur', 'z2m:a4c1380000112233']]);
      const id = res[0].id;
      await asAdmin(host, 'PUT', `/resources/${id}/owners`, { userIds: [ADA.id, BOB.id] });
      await asAdmin(host, 'PUT', `/resources/${id}`, { area: 'Flur' });
      list = [SWITCH3()]; // the gateway now reports the channels
      res = await resources(host);
      const first = res.find((r) => r.capabilities.channel_no === 1);
      assert.equal(first.id, id, 'the same row');
      assert.deepEqual([first.deconz_id, first.name, first.area, first.owners.map((o) => o.id)], ['z2m:a4c1380000112233/l1', 'Schalter Flur 1', 'Flur', [ADA.id, BOB.id]]);
      assert.equal(res.filter((r) => r.enabled).length, 3);
      assert.deepEqual(res.filter((r) => r.capabilities.channel_no > 1).map((r) => r.owners.length), [0, 0], 'the new channels belong to nobody yet');
      list = [SWITCH3({ caps: {}, values: { on: false } })]; // back to an older gateway
      res = await resources(host);
      assert.deepEqual(res.map((r) => [r.id, r.deconz_id, r.name, r.owners.length]), [[id, 'z2m:a4c1380000112233', 'Schalter Flur', 2]], 'the other channels are switched off here');
      assert.equal(res[0].capabilities.channel, undefined);
    });
  });

  it('channelsOf: only lights and plugs with at least two clean channel names', () => {
    assert.deepEqual(zigbee.channelsOf(SWITCH3()), ['l1', 'l2', 'l3']);
    assert.equal(zigbee.channelsOf(SWITCH3({ caps: { channels: ['l1'] } })), null, 'one channel is the device itself');
    assert.equal(zigbee.channelsOf(SWITCH3({ caps: {} })), null);
    assert.equal(zigbee.channelsOf(SWITCH3({ kind: 'sensor' })), null);
    assert.deepEqual(zigbee.channelsOf(SWITCH3({ caps: { channels: ['l1', 'l1', '../x', 7, 'left', 'a'.repeat(9)] } })), ['l1', 'left']);
    assert.equal(zigbee.channelsOf(SWITCH3({ caps: { channels: Array.from({ length: 20 }, (_, i) => 'l' + i) } })).length, 8);
  });

  it('a thermostat: measured and target temperature, mode; set from the page and from the portal within its limits', async () => {
    await withRadio(() => [TRV()], async (host, sent, state) => {
      const res = await resources(host);
      const t = res[0];
      assert.deepEqual([t.kind, t.name, t.deconz_type], ['thermostat', 'Heizung Bad', 'z2m']);
      assert.deepEqual({ setpoint: t.capabilities.setpoint, modes: t.capabilities.modes, reading: t.capabilities.reading }, { setpoint: { min: 5, max: 30, step: 0.5 }, modes: ['off', 'heat', 'auto'], reading: 'temperature' });
      assert.deepEqual({ type: t.state.type, value: t.state.value, setpoint: t.state.setpoint, mode: t.state.mode, heating: t.state.heating, valve: t.state.valve, battery: t.state.battery, reachable: t.state.reachable },
        { type: 'temperature', value: 20.4, setpoint: 21.5, mode: 'heat', heating: true, valve: 37, battery: 64, reachable: true });
      let r = await asAdmin(host, 'POST', `/resources/${t.id}/state`, { setpoint: 22.26 });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.deepEqual(sent.pop(), ['z2m:00158d0005050505', { setpoint: 22.5 }], 'in the steps of the device');
      await asAdmin(host, 'POST', `/resources/${t.id}/state`, { setpoint: 99, mode: 'auto' });
      assert.deepEqual(sent.pop(), ['z2m:00158d0005050505', { setpoint: 30, mode: 'auto' }], 'never above its maximum');
      assert.deepEqual(JSON.parse((await host.gc.db.get('SELECT state_json FROM resources WHERE id = ?', [t.id])).row.state_json).mode, 'auto');
      assert.equal((await asAdmin(host, 'POST', `/resources/${t.id}/state`, { mode: 'party' })).json.code, 'SMARTHOME_INVALID_PATCH');
      assert.equal((await asAdmin(host, 'POST', `/resources/${t.id}/state`, { on: true })).json.code, 'SMARTHOME_INVALID_PATCH');
      // the portal: only for its owner, only what a thermostat takes
      assert.equal((await asAdmin(host, 'PUT', `/resources/${t.id}/owners`, { userIds: [ADA.id] })).status, 200);
      const p = (await asPortal(host, ADA, 'GET', '/portal')).json;
      assert.deepEqual(p.devices.map((d) => [d.kind, d.name, d.capabilities, d.state.value, d.state.setpoint, d.state.mode]),
        [['thermostat', 'Heizung Bad', { reading: 'temperature', setpoint: { min: 5, max: 30, step: 0.5 }, modes: ['off', 'heat', 'auto'] }, 20.4, 30, 'auto']]);
      assert.equal((await asPortal(host, ADA, 'POST', `/portal/resources/${t.id}/state`, { patch: { setpoint: 19.5 } })).status, 200);
      assert.deepEqual(sent.pop(), ['z2m:00158d0005050505', { setpoint: 19.5 }]);
      assert.equal((await asPortal(host, ADA, 'POST', `/portal/resources/${t.id}/state`, { patch: { mode: 'off' } })).status, 200);
      assert.deepEqual(sent.pop(), ['z2m:00158d0005050505', { mode: 'off' }]);
      for (const bad of [{ setpoint: 45 }, { setpoint: '21' }, { mode: 'party' }, { on: true }, {}]) {
        assert.equal((await asPortal(host, ADA, 'POST', `/portal/resources/${t.id}/state`, { patch: bad })).status, 400, JSON.stringify(bad));
      }
      assert.equal((await asPortal(host, BOB, 'POST', `/portal/resources/${t.id}/state`, { patch: { setpoint: 20 } })).status, 403);
      // the Start tab shows the temperature; the apps' quick actions leave thermostats out
      const tiles = await host.plugin.portalTiles({ user: ADA, lang: 'de' }, host.gc);
      assert.deepEqual(tiles.map((x) => [x.title, x.value, x.unit]), [['Heizung Bad', '20,4', '°C']]);
      assert.deepEqual(await host.plugin.quickActions({ user: ADA, lang: 'de' }, host.gc), []);
      // the gateway does not answer
      state.fail = 'ERR_RADIO_GATEWAY';
      r = await asAdmin(host, 'POST', `/resources/${t.id}/state`, { setpoint: 20 });
      assert.deepEqual([r.status, r.json.code], [502, 'SMARTHOME_RADIO_UNREACHABLE']);
    });
  });

  it('a thermostat that says little: limits of 5–30 °C in half degrees, no modes, no values', () => {
    const r = zigbee.resourceOf(TRV({ caps: {}, values: {}, online: false }), null);
    assert.deepEqual(r.caps.setpoint, { min: 5, max: 30, step: 0.5 });
    assert.equal(r.caps.modes, undefined);
    assert.deepEqual(r.state, { reachable: false, type: 'temperature', value: null, lastupdated: r.state.lastupdated });
    assert.deepEqual(zigbee.resourceOf(TRV({ caps: { setpoint: { min: 30, max: 10, step: 0 } } }), null).caps.setpoint, { min: 30, max: 31, step: 0.5 });
  });

  it('firmware over the air: what there is to show, searching and starting an update', async () => {
    let list = [SWITCH3(), TRV(), PLUG(), PLUG({ id: 'z2m:000d6ffffe000002', ieee: '00:0d:6f:ff:fe:00:00:02', name: 'Alt', caps: {}, values: { on: false, ota: { state: 'available' } } })];
    await withRadio(() => list, async (host, sent, state) => {
      let res = await resources(host);
      const by = (n) => res.find((r) => r.name === n);
      assert.deepEqual(by('Schalter Flur 1').state.ota, { state: 'available', installed: '16777220', latest: '16777221' });
      assert.equal(by('Schalter Flur 1').capabilities.ota, true);
      assert.deepEqual([by('Schalter Flur 2').capabilities.ota, by('Schalter Flur 2').state.ota], [undefined, undefined], 'one device, one update: the first channel carries it');
      assert.deepEqual(by('Heizung Bad').state.ota, { state: 'updating', progress: 38 });
      assert.deepEqual(by('Steckdose Kaffee').state.ota, { state: 'idle', installed: '2.3.089', checked: '2026-11-11T10:00:00.000Z' });
      assert.deepEqual([by('Alt').capabilities.ota, by('Alt').state.ota], [undefined, undefined], 'a device without OTA shows nothing');

      let r = await asAdmin(host, 'POST', `/resources/${by('Steckdose Kaffee').id}/ota`, { action: 'check' });
      assert.deepEqual([r.status, r.json], [200, { ok: true, action: 'check' }]);
      assert.deepEqual(sent.pop(), ['z2m:000d6ffffe1a2b3c', { ota: 'check' }]);
      r = await asAdmin(host, 'POST', `/resources/${by('Schalter Flur 1').id}/ota`, { action: 'update' });
      assert.equal(r.status, 200);
      assert.deepEqual(sent.pop(), ['z2m:a4c1380000112233', { ota: 'update' }], 'the device, not a channel');
      assert.deepEqual(JSON.parse((await host.gc.db.get('SELECT state_json FROM resources WHERE id = ?', [by('Schalter Flur 1').id])).row.state_json).ota.state, 'updating', 'shown as running at once');
      // refused: no OTA, a channel that does not carry it, another action, an unknown resource, a portal viewer
      assert.equal((await asAdmin(host, 'POST', `/resources/${by('Alt').id}/ota`, { action: 'update' })).json.code, 'SMARTHOME_NOT_CONTROLLABLE');
      assert.equal((await asAdmin(host, 'POST', `/resources/${by('Schalter Flur 2').id}/ota`, { action: 'update' })).json.code, 'SMARTHOME_NOT_CONTROLLABLE');
      assert.equal((await asAdmin(host, 'POST', `/resources/${by('Steckdose Kaffee').id}/ota`, { action: 'erase' })).status, 400);
      assert.equal((await asAdmin(host, 'POST', '/resources/99999/ota', { action: 'check' })).status, 404);
      assert.equal((await asPortal(host, ADA, 'POST', `/resources/${by('Steckdose Kaffee').id}/ota`, { action: 'check' })).status, 403);
      assert.equal(sent.length, 0);
      state.fail = 'ERR_RADIO_GATEWAY';
      assert.equal((await asAdmin(host, 'POST', `/resources/${by('Steckdose Kaffee').id}/ota`, { action: 'check' })).json.code, 'SMARTHOME_RADIO_UNREACHABLE');
      state.fail = null;
      // the next report: failed check, garbage values
      list = [PLUG({ values: { on: false, ota: { state: 'weird', progress: 500, installed: '<b>', latest: 7, error: 'check_failed', checked: 'never' } } })];
      res = await resources(host);
      assert.deepEqual(by('Steckdose Kaffee').state.ota, { state: 'idle', latest: '7', error: 'check_failed' });
      // the portal never sees firmware details
      await asAdmin(host, 'PUT', `/resources/${by('Steckdose Kaffee').id}/owners`, { userIds: [ADA.id] });
      const p = (await asPortal(host, ADA, 'GET', '/portal')).json.devices[0];
      assert.deepEqual([p.state.ota, p.capabilities.ota], [undefined, undefined]);
    });
  });

  it('an older GateControl or gateway (none of the new fields): resources exactly as before', async () => {
    await withRadio(() => [PLUG({ caps: { power: true }, values: { on: true, power: 12 } })], async (host, sent) => {
      const res = await resources(host);
      assert.deepEqual(res.map((r) => [r.kind, r.deconz_id, r.capabilities, { on: r.state.on, power: r.state.power, reachable: r.state.reachable }]),
        [['plug', 'z2m:000d6ffffe1a2b3c', { source: 'z2m', gateway_id: 7, gateway: 'Pi Keller', model: 'E1603', vendor: 'IKEA', named: false, power: true }, { on: true, power: 12, reachable: true }]]);
      await asAdmin(host, 'POST', `/resources/${res[0].id}/state`, { on: false });
      assert.deepEqual(sent.pop(), ['z2m:000d6ffffe1a2b3c', { on: false }]);
    });
  });
});
