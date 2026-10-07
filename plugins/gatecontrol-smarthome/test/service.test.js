'use strict';

// Gateways and devices: ported from GateControl tests/smarthome_orchestrator.test.js,
// smarthome_deconz_client.test.js and smarthome_devices.test.js (built-in Smart Home),
// now against the mock host with a fake deCONZ gateway as home target.

const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../server/service');
const { createClient, briToDeconz, briFromDeconz, toDeconzBody } = require('../server/deconz');
const { fakeDeconz, withHost, asAdmin, connected, ADMIN } = require('./helpers');

test('capsFromLight derives the colour capability', () => {
  assert.equal(service.capsFromLight({ state: { on: true, bri: 100, ct: 300 } }).color, 'ct');
  assert.equal(service.capsFromLight({ state: { on: true, bri: 100, hue: 1, sat: 2 } }).color, 'hs');
  assert.equal(service.capsFromLight({ state: { on: true, xy: [0.1, 0.2] } }).color, 'xy');
  assert.equal(service.capsFromLight({ state: { on: true } }).color, 'none');
  assert.equal(service.capsFromLight({ state: { on: true, bri: 5 } }).bri, true);
});

test('lightKind classifies plugs/lights and skips the Configuration tool', () => {
  assert.equal(service.lightKind({ type: 'On/Off plug-in unit' }), 'plug');
  assert.equal(service.lightKind({ type: 'Smart plug' }), 'plug');
  assert.equal(service.lightKind({ type: 'Dimmable light' }), 'light');
  assert.equal(service.lightKind({ type: 'Configuration tool' }), null);
});

test('sensorKind classifies switches/sensors and skips virtuals', () => {
  assert.equal(service.sensorKind({ type: 'ZHASwitch' }), 'switch');
  assert.equal(service.sensorKind({ type: 'ZHAPresence' }), 'sensor');
  assert.equal(service.sensorKind({ type: 'CLIPPresence' }), null);
  assert.equal(service.sensorKind({ type: 'Daylight' }), null);
});

test('sensorReading covers open/water/temperature/humidity/lightlevel/button', () => {
  assert.equal(service.sensorReading({ state: { open: true } }).type, 'open');
  assert.equal(service.sensorReading({ state: { water: false } }).type, 'water');
  assert.equal(service.sensorReading({ state: { temperature: 2150 } }).value, 21.5);
  assert.equal(service.sensorReading({ state: { humidity: 4520 } }).value, 45.2);
  const ll = service.sensorReading({ state: { lightlevel: 12000, lux: 25 } });
  assert.deepEqual(ll, { type: 'lightlevel', value: 25 });
  assert.equal(service.sensorReading({ state: { buttonevent: 1002 } }).type, 'button');
  assert.equal(service.sensorReading({ state: {} }).type, 'unknown');
});

test('brightness conversion and request bodies', () => {
  assert.equal(briToDeconz(100), 254);
  assert.equal(briToDeconz(60), 152);
  assert.equal(briToDeconz(-5), 0);
  assert.equal(briFromDeconz(254), 100);
  assert.deepEqual(toDeconzBody({ on: 1, bri: 50, ct: '300', xy: ['0.3', 0.4], other: 1 }), { on: true, bri: 127, ct: 300, xy: [0.3, 0.4] });
});

test('the client refuses keys and ids that would leave the API path', () => {
  const gc = { net: { fetchTarget: async () => ({ status: 200, body: '[]' }) } };
  assert.throws(() => createClient(gc, { index: 0, apiKey: '../../x' }), { code: 'SMARTHOME_NO_API_KEY' });
  assert.throws(() => createClient(gc, { index: null }), { code: 'SMARTHOME_NO_TARGET' });
  const c = createClient(gc, { index: 0, apiKey: 'KEY1234567' });
  assert.throws(() => c.setLightState('1/../../config', { on: true }), { code: 'SMARTHOME_RULE_INVALID' });
});

test('connect acquires an API key when none is given (link button pressed)', () => withHost({ gateways: [fakeDeconz()] }, async (host) => {
  const r = await asAdmin(host, 'POST', '/gateways', { name: 'GW', target_index: 0 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(await host.gc.settings.get(`gw.${r.json.gateway.id}.apikey`), 'NEWKEY99');
  assert.ok(host.secrets.has(`gw.${r.json.gateway.id}.apikey`), 'stored as a secret');
  const call = host.fetches.find((f) => f.path === '/api');
  assert.deepEqual(call.opts.json, { devicetype: 'GateControl' });
  assert.equal(call.index, 0);
}));

test('connect reports the link button not pressed (409) and stores nothing', () => withHost({ gateways: [fakeDeconz({ linkPressed: false })] }, async (host) => {
  const r = await asAdmin(host, 'POST', '/gateways', { name: 'GW', target_index: 0 });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'DECONZ_LINK_BUTTON_NOT_PRESSED');
  assert.match(r.json.error, /Phoscon/);
  assert.deepEqual((await asAdmin(host, 'GET', '/gateways')).json.gateways, []);
}));

test('connect without an assigned target is refused clearly', () => withHost({ gateways: [] }, async (host) => {
  const r = await asAdmin(host, 'POST', '/gateways', { name: 'GW', target_index: 0 });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'SMARTHOME_NO_TARGET');
  const bad = await asAdmin(host, 'POST', '/gateways', { name: 'GW', target_index: 0, apiKey: 'a/b' });
  assert.equal(bad.json.code, 'SMARTHOME_INVALID_KEY');
  assert.equal((await asAdmin(host, 'POST', '/gateways', { name: '', target_index: 0 })).status, 400);
  assert.equal((await asAdmin(host, 'POST', '/gateways', { name: 'x', target_index: '0' })).status, 400);
}));

test('sync classifies plugs/switches, skips virtuals and caches normalised state', () => withHost({ gateways: [fakeDeconz()] }, async (host) => {
  const { id, by, resources } = await connected(host);
  const sync = await asAdmin(host, 'POST', `/gateways/${id}/sync`);
  assert.deepEqual(sync.json.counts, { lights: 2, plugs: 1, groups: 1, scenes: 1, sensors: 3, switches: 1 });
  assert.equal(by('Poolpumpe').kind, 'plug');
  assert.equal(by('Smart Switch').kind, 'switch');
  assert.equal(by('Fensterkontakt').capabilities.reading, 'open');
  assert.ok(!by('Configuration tool 1'));
  assert.ok(!by('Daylight'));
  assert.deepEqual(by('Stehlampe').state, { on: true, reachable: true, bri: 100 });
  assert.deepEqual(by('Temp').state, { type: 'temperature', value: 21.5 });
  assert.equal(by('Wohnzimmer · Abend').deconz_id, '8/2');
  assert.equal(resources.length, 9);
  const gws = (await asAdmin(host, 'GET', '/gateways')).json.gateways;
  assert.equal(gws[0].target_label, 'phoscon-0.example.com');
  assert.equal(gws[0].has_key, true);
  assert.ok(gws[0].last_seen_at);
}));

test('a device that disappears is disabled, a returning one (same uniqueid, new id) re-enabled', () => {
  const gw = fakeDeconz();
  return withHost({ gateways: [gw] }, async (host) => {
    const { id } = await connected(host);
    gw.lights = { 7: { ...gw.lights[3] } }; // Conbee re-numbered the lamp, the plug is gone
    await asAdmin(host, 'POST', `/gateways/${id}/sync`);
    const res = (await host.request({ path: '/resources', query: { gateway_id: String(id) }, user: ADMIN })).json.resources;
    const lamp = res.find((r) => r.name === 'Stehlampe');
    assert.equal(lamp.deconz_id, '7');
    assert.equal(lamp.enabled, 1);
    assert.equal(res.find((r) => r.name === 'Poolpumpe').enabled, 0);
  });
});

test('control: light, group and scene go to the right deCONZ endpoint; sensors are not controllable', () => {
  const gw = fakeDeconz();
  return withHost({ gateways: [gw] }, async (host) => {
    const { by } = await connected(host);
    let r = await asAdmin(host, 'POST', `/resources/${by('Stehlampe').id}/state`, { patch: { on: false, bri: 50, ct: 250, hue: 5 } });
    assert.equal(r.status, 200);
    assert.deepEqual(gw.calls.at(-1), { method: 'PUT', path: '/api/KEY1234567/lights/3/state', body: { on: false, bri: 127, ct: 250 }, index: 0 });
    r = await asAdmin(host, 'POST', `/resources/${by('Wohnzimmer').id}/state`, { on: true });
    assert.equal(gw.calls.at(-1).path, '/api/KEY1234567/groups/8/action');
    r = await asAdmin(host, 'POST', `/resources/${by('Wohnzimmer · Abend').id}/state`, {});
    assert.deepEqual(gw.calls.at(-1), { method: 'PUT', path: '/api/KEY1234567/groups/8/scenes/2/recall', body: {}, index: 0 });
    r = await asAdmin(host, 'POST', `/resources/${by('Temp').id}/state`, { on: true });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'SMARTHOME_NOT_CONTROLLABLE');
    r = await asAdmin(host, 'POST', '/resources/9999/state', { on: true });
    assert.equal(r.status, 404);
    assert.equal(r.json.code, 'SMARTHOME_RESOURCE_NOT_FOUND');
    // the cached state follows the command
    const lamp = (await host.request({ path: '/resources', user: ADMIN })).json.resources.find((x) => x.name === 'Stehlampe');
    assert.equal(lamp.state.on, false);
    assert.equal(lamp.state.bri, 50);
  });
});

test('test: reachable with the gateway config, unreachable as a result (not an error)', () => {
  const gw = fakeDeconz();
  return withHost({ gateways: [gw] }, async (host) => {
    const { id } = await connected(host);
    let r = await asAdmin(host, 'POST', `/gateways/${id}/test`);
    assert.deepEqual(r.json, { ok: true, reachable: true, target: 'phoscon-0.example.com', config: { name: 'Phoscon-GW', swversion: '2.27.4', apiversion: '1.16.0' } });
    gw.down = true;
    r = await asAdmin(host, 'POST', `/gateways/${id}/test`);
    assert.equal(r.status, 200);
    assert.equal(r.json.reachable, false);
    assert.equal(r.json.code, 'DECONZ_UNREACHABLE');
    r = await asAdmin(host, 'POST', '/gateways/999/test');
    assert.equal(r.status, 404);
    assert.equal(r.json.code, 'SMARTHOME_GATEWAY_NOT_FOUND');
  });
});

test('several gateways: each on its own target index', () => {
  const a = fakeDeconz();
  const b = fakeDeconz({ key: 'BKEY000000', lights: { 1: { name: 'Gartenlicht', type: 'Dimmable light', uniqueid: 'g1', state: { on: false, bri: 1 } } }, groups: {}, sensors: {} });
  return withHost({ gateways: [a, b] }, async (host) => {
    const one = await connected(host, { index: 0 });
    const two = await connected(host, { index: 1, key: 'BKEY000000', name: 'Garten' });
    assert.equal(two.resources.length, 1);
    assert.equal(two.by('Gartenlicht').gateway_id, two.id);
    assert.ok(b.calls.every((c) => c.index === 1));
    assert.ok(a.calls.every((c) => c.index === 0));
    const gws = (await asAdmin(host, 'GET', '/gateways')).json.gateways;
    assert.deepEqual(gws.map((g) => [g.name, g.target_index, g.target_label]), [['Wohnung', 0, 'phoscon-0.example.com'], ['Garten', 1, 'phoscon-1.example.com']]);
    assert.notEqual(one.id, two.id);
  });
});

test('gateway edit and removal (devices, owners and rules go with it, the key too)', () => withHost({ gateways: [fakeDeconz(), fakeDeconz()] }, async (host) => {
  const { id, by } = await connected(host);
  await asAdmin(host, 'PUT', `/resources/${by('Stehlampe').id}/owners`, { userIds: [2] });
  let r = await asAdmin(host, 'PUT', `/gateways/${id}`, { name: 'Neu', target_index: 1, enabled: false, apiKey: 'OTHERKEY12' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.gateway.name, r.json.gateway.target_index, r.json.gateway.enabled], ['Neu', 1, 0]);
  assert.equal(await host.gc.settings.get(`gw.${id}.apikey`), 'OTHERKEY12');
  assert.equal((await asAdmin(host, 'PUT', `/gateways/${id}`, { enabled: 'yes' })).status, 400);
  assert.equal((await asAdmin(host, 'PUT', `/gateways/${id}`, { apiKey: 'bad key' })).json.code, 'SMARTHOME_INVALID_KEY');
  r = await asAdmin(host, 'DELETE', `/gateways/${id}`);
  assert.deepEqual(r.json, { ok: true });
  assert.equal(await host.gc.settings.get(`gw.${id}.apikey`), null);
  assert.equal((await host.gc.db.get('SELECT COUNT(*) AS n FROM resources')).row.n, 0);
  assert.equal((await host.gc.db.get('SELECT COUNT(*) AS n FROM resource_owners')).row.n, 0);
  assert.equal((await asAdmin(host, 'DELETE', `/gateways/${id}`)).status, 404);
}));

test('background: syncs enabled gateways no more often than the interval', () => {
  const gw = fakeDeconz();
  return withHost({ gateways: [gw], settings: { interval: 60 } }, async (host) => {
    await connected(host);
    gw.calls.length = 0;
    await host.tick();
    const n = gw.calls.filter((c) => c.path.endsWith('/lights')).length;
    assert.equal(n, 1);
    await host.tick();
    assert.equal(gw.calls.filter((c) => c.path.endsWith('/lights')).length, 1, 'second tick within the interval does nothing');
    host.plugin._state.lastSync = 0;
    await asAdmin(host, 'PUT', '/gateways/1', { enabled: false });
    await host.tick();
    assert.equal(gw.calls.filter((c) => c.path.endsWith('/lights')).length, 1, 'disabled gateways are not polled');
  });
});
