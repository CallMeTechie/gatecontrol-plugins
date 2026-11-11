'use strict';

// Shelly / Tasmota through a GateControl gateway — the server part (server/edge.js) against the mock host's gc.edge
// and gc.mqtt.accounts: sources, manual and automatic set-up (accounts, passwords once, never stored), the edge
// part's reports as resources, the portal and the apps' quick actions, editing, removing, reachability, and the
// deCONZ part unchanged without gc.edge.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHost, hostError } = require('../../../tools/testing/mock-host');
const { DIR, ADMIN, ADA, BOB, USERS, fakeDeconz, withHost, asAdmin, asPortal, connected } = require('./helpers');

const GW = { id: 7, name: 'Pi Keller', state: 'running', version: '1.20.0' };
const DEVICE_PW = 'Shelly-Geheim-42';

/** A fake edge part on the gateways (what gc.edge.call reaches). */
function fakeEdge(o = {}) {
  const f = {
    calls: [],
    found: o.found || [],
    devicePassword: o.devicePassword === undefined ? DEVICE_PW : o.devicePassword,
    probes: o.probes || {
      '192.168.1.51': { ip: '192.168.1.51', family: 'shelly2', gen: 2, model: 'Plus2PM', name: null, firmware: '1.4.4', id: 'shellyplus2pm-a8032ab1c2d4', mac: 'A8032AB1C2D4', auth: true, host: '192.168.1.23' },
      '192.168.1.62': { ip: '192.168.1.62', family: 'tasmota', gen: null, model: 'Sonoff Basic', name: 'sonoff-flur', firmware: '14.2.0', id: 'tasmota_A1', mac: '24:A1:60:A1:B2:C3', auth: false, host: '192.168.1.23' },
    },
    down: false,
  };
  f.call = async (gatewayId, method, params) => {
    f.calls.push({ gatewayId, method, params });
    if (f.down) throw hostError('timeout', 'the gateway did not answer in time');
    if (method === 'info') return { version: '1.7.0', startedAt: '2026-11-05T04:00:00.000Z', mqtt: 'ok', lan: ['192.168.1.23'], devices: 1, found: f.found.length };
    if (method === 'discover') return { devices: f.found };
    if (method === 'refresh') return { mqtt: 'ok', devices: 1 };
    if (method === 'command') return { sent: 1 };
    if (method === 'probe') {
      const p = f.probes[params.ip];
      if (!p) throw hostError('edge_error', 'unreachable: the device did not answer');
      return p;
    }
    if (method === 'setup') {
      const p = f.probes[params.ip];
      if (!p) throw hostError('edge_error', 'unreachable: the device did not answer');
      if (p.auth && params.password !== f.devicePassword) throw hostError('edge_error', `${params.password ? 'auth_failed' : 'auth_required'}: the device has a password`);
      return { ok: true, host: '192.168.1.23', port: 1883 };
    }
    throw hostError('edge_error', `unknown_method: unknown method ${method}`);
  };
  return f;
}

async function withEdge(o, fn) {
  const edge = fakeEdge(o);
  const gateways = o.gateways || [GW, { id: 8, name: 'NAS Büro', state: 'disabled', version: '1.20.0' }, { id: 9, name: 'NAS Wohnzimmer', state: 'gateway_too_old', version: '1.18.0' }];
  const host = await createHost(DIR, { users: USERS, gatecontrol: '1.228.1', edge: { gateways, call: edge.call }, targets: { gateway: (o.deconz || []).map((g, i) => ({ label: `phoscon-${i}`, fetch: g.fetch })) } });
  try {
    await host.start();
    await fn(host, edge, gateways);
  } finally {
    await host.stop();
    await host.close();
  }
}

/** An administrator's request; a query string in the path becomes req.query like the host does it. */
const admin = (host, method, p, body) => {
  const [pathOnly, qs] = String(p).split('?');
  return host.request({ method, path: pathOnly, query: Object.fromEntries(new URLSearchParams(qs || '')), body: body === undefined ? null : body, user: ADMIN });
};
const SNAP_2PM = (o = {}) => ({
  base: 'shellies/rollladen-terrasse', family: 'shelly2', online: true, seenAt: new Date().toISOString(),
  ch: { 'cover:0': { pos: 60, moving: null, power: 0 } }, sensor: {}, info: { id: 'shellyplus2pm-a8032ab1c2d4' }, drop: [], ...o,
});

/** Every text the plugin keeps: its tables, settings, storage and log. */
async function everything(host) {
  const parts = [];
  for (const t of ['edge_devices', 'resources', 'resource_owners', 'gateways', 'rules']) parts.push(JSON.stringify((await host.gc.db.query(`SELECT * FROM ${t}`)).rows));
  parts.push(JSON.stringify(host.settings), JSON.stringify([...(host.secrets || [])]), JSON.stringify([...host.kv]), JSON.stringify(host.logs));
  return parts.join('\n');
}

test('without gc.edge (GateControl < 1.228.1): the deCONZ part as before, the edge API says unavailable', () => withHost({ gateways: [fakeDeconz()] }, async (host) => {
  assert.equal(host.gc.edge, undefined);
  const r = await admin(host, 'GET', '/edge/gateways');
  assert.deepEqual(r.json, { ok: true, available: false, gateways: [] });
  const d = await admin(host, 'GET', '/edge/devices');
  assert.equal(d.status, 409);
  assert.equal(d.json.code, 'SMARTHOME_EDGE_UNAVAILABLE');
  const { by } = await connected(host);
  assert.ok(by('Stehlampe'), 'deCONZ connects and syncs');
  await host.tick();
}));

test('sources: every gateway of the edge part with its state, the running one with the edge part\'s info', () => withEdge({}, async (host) => {
  const r = await admin(host, 'GET', '/edge/gateways');
  assert.equal(r.json.available, true);
  assert.equal(r.json.minGateway, '1.19.0');
  assert.deepEqual(r.json.gateways.map((g) => [g.id, g.name, g.state, g.tooOld, g.info ? g.info.mqtt : null]), [
    [7, 'Pi Keller', 'running', false, 'ok'], [8, 'NAS Büro', 'disabled', false, null], [9, 'NAS Wohnzimmer', 'gateway_too_old', true, null],
  ]);
  assert.equal((await admin(host, 'GET', '/gateways')).json.gateways.length, 0, 'the deCONZ gateways (rules page) stay deCONZ only');
}));

test('an offline gateway: the reason from GateControl (sources and a failed set-up); without one (older GateControl) none', () => withEdge({ gateways: [
  { ...GW }, { id: 8, name: 'NAS Büro', state: 'disabled', version: '1.20.0' }, { id: 9, name: 'NAS Wohnzimmer', state: 'gateway_too_old', version: '1.18.0' },
] }, async (host, edge, gateways) => {
  gateways[0].state = 'offline';
  gateways[0].reason = 'edge_missing';
  let r = await admin(host, 'GET', '/edge/gateways');
  assert.deepEqual(r.json.gateways.map((g) => [g.id, g.state, g.reason]), [[7, 'offline', 'edge_missing'], [8, 'disabled', null], [9, 'gateway_too_old', null]]);
  assert.equal(r.json.gateways[0].info, null, 'no info call to an offline gateway');

  // the set-up fails at "reach" with gateway_offline — and says why
  const poll = async (id) => {
    for (let i = 0; i < 50; i++) {
      const j = (await admin(host, 'GET', `/edge/setup/${id}`)).json.job;
      if (j.state === 'failed') return j;
      await new Promise((res) => setTimeout(res, 5));
    }
    throw new Error('job stuck');
  };
  r = await admin(host, 'POST', '/edge/setup', { gateway_id: 7, name: 'Licht Flur', candidate: { ip: '192.168.1.62', family: 'tasmota' } });
  let job = await poll(r.json.job.id);
  assert.deepEqual(job.steps[1], { id: 'reach', state: 'error', code: 'gateway_offline', reason: 'edge_missing' });
  assert.equal(job.error, 'gateway_offline');
  assert.equal(job.reason, 'edge_missing');

  // an older GateControl sends no reason: the plain "not connected"
  delete gateways[0].reason;
  r = await admin(host, 'GET', '/edge/gateways');
  assert.equal(r.json.gateways[0].reason, null);
  r = await admin(host, 'POST', '/edge/setup', { gateway_id: 7, name: 'Licht Keller', candidate: { ip: '192.168.1.62', family: 'tasmota' } });
  job = await poll(r.json.job.id);
  assert.deepEqual(job.steps[1], { id: 'reach', state: 'error', code: 'gateway_offline' });
  assert.equal(job.reason, null);
  // a value the plugin does not know is passed on only if it looks like one (the page shows its own text or the plain one)
  gateways[0].reason = '<b>nope</b>';
  assert.equal((await admin(host, 'GET', '/edge/gateways')).json.gateways[0].reason, null);
}));

test('by hand: an account per device (own topics only), the password once, never stored; the device reports → resources', () => withEdge({}, async (host, edge) => {
  const r = await admin(host, 'POST', '/edge/devices', { gateway_id: 7, name: 'Gefriertruhe', area: 'Keller', family: 'tasmota' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const cred = r.json.credentials;
  assert.deepEqual({ ...cred, password: typeof cred.password }, { host: '192.168.1.23', port: 1883, username: 'gatecontrol-smarthome-gefriertru', password: 'string', prefix: 'gefriertru', base: 'tasmota/gefriertru', family: 'tasmota' });
  assert.ok(cred.username.length <= 32, 'Tasmota keeps the MQTT user short');
  const acc = host.mqttAccounts.get(7).get(cred.username);
  assert.deepEqual(acc.acl, [{ access: 'readwrite', topic: 'tasmota/gefriertru/#' }]);
  assert.equal(acc.password, cred.password);
  assert.deepEqual(host.edgeConfigs.get(7).devices, [{ base: 'tasmota/gefriertru', family: 'tasmota' }], 'the edge part learns the device at once');
  assert.deepEqual(host.edgeConfigs.get(7).rules, [], 'no logic chains yet');

  let list = (await admin(host, 'GET', '/edge/devices', undefined)).json.devices;
  assert.deepEqual(list.map((d) => [d.name, d.area, d.waiting, d.reachable, d.resources.length]), [['Gefriertruhe', 'Keller', true, false, 0]]);

  // the device reports: a switched output with power metering
  await host.edgeEvent(7, 'states', { devices: [{ base: 'tasmota/gefriertru', family: 'tasmota', online: true, seenAt: new Date().toISOString(), ch: { 'switch:0': { on: true, power: 85, today: 1.2 } }, sensor: {}, info: { firmware: '14.2.0' }, drop: [] }] });
  list = (await admin(host, 'GET', '/edge/devices?gateway_id=7')).json.devices;
  const dev = list[0];
  assert.deepEqual([dev.waiting, dev.reachable, dev.firmware], [false, true, '14.2.0']);
  assert.deepEqual(dev.resources.map((x) => [x.kind, x.name, x.area, x.state]), [['relay', 'Gefriertruhe', 'Keller', { reachable: true, on: true, power: 85, energy_today: 1.2 }]]);
  // unknown devices and garbage are ignored
  await host.edgeEvent(7, 'states', { devices: [{ base: 'shellies/fremd', ch: { 'switch:0': { on: true } } }, null, { base: 7 }] });
  await host.edgeEvent(7, 'states', null);
  assert.equal((await host.gc.db.query('SELECT * FROM resources')).rows.length, 1);

  assert.ok(!(await everything(host)).includes(cred.password), 'the MQTT password is stored nowhere');
}));

test('the edge part\'s reports: covers, dimmers, sensors; LWT offline and silence make a device unreachable', () => withEdge({}, async (host) => {
  const mk = async (name, family) => (await admin(host, 'POST', '/edge/devices', { gateway_id: 7, name, area: 'Wohnzimmer', family })).json.credentials;
  const rollo = await mk('Rollladen Terrasse', 'shelly2');
  assert.equal(rollo.base, 'shellies/rollladen-terrasse');
  const dimmer = await mk('Deckenlicht', 'shelly1');
  const ht = await mk('Klima Keller', 'shelly2');
  const HT_SEEN = new Date(Date.now() - 9 * 60000).toISOString();
  await host.edgeEvent(7, 'states', { devices: [
    SNAP_2PM(),
    { base: dimmer.base, family: 'shelly1', online: true, seenAt: new Date().toISOString(), ch: { 'light:0': { on: true, bri: 70, power: 38 } }, sensor: {}, info: {}, drop: [] },
    { base: ht.base, family: 'shelly2', online: null, seenAt: HT_SEEN, ch: {}, sensor: { temperature: 14.8, humidity: 63, battery: 82 }, info: {}, drop: [] },
  ] });
  const res = (await host.gc.db.query("SELECT kind, name, area, capabilities_json, state_json FROM resources WHERE deconz_type = 'edge' ORDER BY id")).rows
    .map((r) => [r.kind, r.name, r.area, JSON.parse(r.capabilities_json), JSON.parse(r.state_json)]);
  assert.deepEqual(res, [
    ['cover', 'Rollladen Terrasse', 'Wohnzimmer', { source: 'edge', ch: 'cover:0', bri: false, power: true, position: true, cover: 'shutter' }, { reachable: true, pos: 60, moving: null, on: true, power: 0 }],
    ['light', 'Deckenlicht', 'Wohnzimmer', { source: 'edge', ch: 'light:0', bri: true, power: true, position: false }, { reachable: true, on: true, bri: 70, power: 38 }],
    ['sensor', 'Klima Keller', 'Wohnzimmer', { source: 'edge', ch: 'sensor', reading: 'temperature' }, { reachable: true, type: 'temperature', value: 14.8, humidity: 63, battery: 82, sleeping: true, lastupdated: HT_SEEN }],
  ]);
  // LWT offline → unreachable at once (the sensor sleeps: "offline" says nothing there)
  await host.edgeEvent(7, 'states', { devices: [SNAP_2PM({ online: false })] });
  const dev = (base) => host.gc.db.get('SELECT * FROM edge_devices WHERE base = ?', [base]).then((x) => x.row);
  const stateOf = async (name) => JSON.parse((await host.gc.db.get('SELECT state_json FROM resources WHERE name = ?', [name])).row.state_json);
  assert.equal((await stateOf('Rollladen Terrasse')).reachable, false);
  // silence: 31 minutes without a report on mains, the sensor keeps its 26 hours
  await host.gc.db.run('UPDATE edge_devices SET last_seen_at = ? WHERE base = ?', [new Date(Date.now() - 31 * 60000).toISOString(), dimmer.base]);
  await host.gc.db.run('UPDATE edge_devices SET last_seen_at = ? WHERE base = ?', [new Date(Date.now() - 20 * 3600000).toISOString(), ht.base]);
  await host.tick();
  assert.equal((await stateOf('Deckenlicht')).reachable, false);
  assert.equal((await stateOf('Klima Keller')).reachable, true);
  // back: a fresh report
  await host.edgeEvent(7, 'states', { devices: [{ base: dimmer.base, family: 'shelly1', online: true, seenAt: new Date().toISOString(), ch: { 'light:0': { on: false, bri: 70 } }, sensor: {}, info: {}, drop: [] }] });
  assert.equal((await stateOf('Deckenlicht')).reachable, true);
  assert.equal((await dev(dimmer.base)).online, 1);
  // a channel the edge part drops (Tasmota: shutter relays) goes away
  await host.edgeEvent(7, 'states', { devices: [SNAP_2PM({ ch: { 'cover:0': { pos: 0 }, 'switch:0': { on: false } } })] });
  assert.ok(await host.gc.db.get("SELECT id FROM resources WHERE deconz_id LIKE '%/switch:0'").then((x) => x.row));
  await host.edgeEvent(7, 'states', { devices: [SNAP_2PM({ ch: { 'cover:0': { pos: 0 } }, drop: ['switch:0'] })] });
  assert.ok(!(await host.gc.db.get("SELECT id FROM resources WHERE deconz_id LIKE '%/switch:0'")).row);
}));

test('portal and quick actions: own covers as open/stop/close buttons with a position widget, metered switches with power', () => withEdge({}, async (host, edge) => {
  const rollo = (await admin(host, 'POST', '/edge/devices', { gateway_id: 7, name: 'Rollladen Terrasse', area: 'Wohnzimmer', family: 'shelly2' })).json;
  const plug = (await admin(host, 'POST', '/edge/devices', { gateway_id: 7, name: 'Fernseher', family: 'shelly2' })).json;
  await host.edgeEvent(7, 'states', { devices: [
    SNAP_2PM(),
    { base: plug.credentials.base, family: 'shelly2', online: true, seenAt: new Date().toISOString(), ch: { 'switch:0': { on: true, power: 148.2, energy: 1000 } }, sensor: {}, info: {}, drop: [] },
  ] });
  // plug kind for the TV, owners for Ada
  const put = await admin(host, 'PUT', `/edge/devices/${plug.device.id}`, { channels: { 'switch:0': { kind: 'plug' } } });
  assert.equal(put.status, 200, JSON.stringify(put.json));
  for (const d of [rollo, plug]) assert.equal((await admin(host, 'PUT', `/edge/devices/${d.device.id}/owners`, { userIds: [ADA.id] })).status, 200);

  const portal = (await asPortal(host, ADA, 'GET', '/portal')).json;
  assert.deepEqual(portal.devices.map((d) => [d.kind, d.name, d.area, d.capabilities, d.state]), [
    ['cover', 'Rollladen Terrasse', 'Wohnzimmer', { bri: false, power: true, position: true, cover: 'shutter' }, { reachable: true, pos: 60, moving: null, on: true, power: 0 }],
    ['plug', 'Fernseher', null, { bri: false, power: true, position: false }, { reachable: true, on: true, power: 148.2, energy_today: 0 }],
  ]);
  assert.deepEqual((await asPortal(host, BOB, 'GET', '/portal')).json.devices, []);

  const qa = await host.quickActions(ADA);
  assert.deepEqual(qa.map((a) => [a.id, a.title, a.subtitle, a.kind, a.state, a.device && a.device.title]), [
    [`plug:${portal.devices[1].id}`, 'Fernseher', 'Steckdose · 148 W', 'toggle', 'on', 'Fernseher'],
    [`cover:${portal.devices[0].id}:open`, 'Auf', '60 % offen', 'button', null, 'Rollladen Terrasse'],
    [`cover:${portal.devices[0].id}:stop`, 'Stopp', '60 % offen', 'button', null, 'Rollladen Terrasse'],
    [`cover:${portal.devices[0].id}:close`, 'Zu', '60 % offen', 'button', null, 'Rollladen Terrasse'],
  ]);
  assert.deepEqual(qa[0].widget, {
    label: 'Leistung', value: 148, unit: 'W', status: 'Steckdose · An', state: 'on', power: true, badge: null, controls: [],
    readings: [{ id: 'today', label: 'Heute', value: 0, unit: 'kWh', icon: null, state: null }],
  });
  assert.deepEqual(qa[1].widget.controls, [{ id: 'pos', kind: 'slider', label: 'Position', value: 60, min: 0, max: 100, step: 1, unit: '%' }]);
  assert.equal(qa[1].widget.value, 60);
  assert.equal(qa[1].widget.power, false);
  assert.equal(qa[2].widget, null, 'one widget per device');
  assert.deepEqual(qa[0].verbs, { on: 'Einschalten', off: 'Ausschalten' });

  // running them: MQTT commands through the gateway
  edge.calls.length = 0;
  let r = (await host.runQuickAction(ADA, `cover:${portal.devices[0].id}:close`)).body;
  assert.equal(r.ok, true);
  assert.equal(r.message, 'Rollladen Terrasse fährt zu');
  r = (await host.runQuickAction(ADA, `cover:${portal.devices[0].id}:open`, 'de', { control: 'pos', value: 25 })).body;
  assert.equal(r.ok, true);
  assert.equal(r.widget.status, 'Rollladen · fährt zu', 'the answer carries the widget with the new state');
  assert.equal((await host.runQuickAction(ADA, `cover:${portal.devices[0].id}:open`, 'de', { control: 'pos', value: 101 })).status, 400);
  r = (await host.runQuickAction(ADA, `plug:${portal.devices[1].id}`, 'de', { state: 'off' })).body;
  assert.deepEqual([r.ok, r.state], [true, 'off']);
  r = (await host.runQuickAction(ADA, `plug:${portal.devices[1].id}`, 'de', { state: 'off' })).body;
  assert.deepEqual([r.ok, r.state], [true, 'off'], 'a target is set again, never flipped');
  assert.deepEqual(edge.calls.filter((c) => c.method === 'command').map((c) => c.params), [
    { base: 'shellies/rollladen-terrasse', family: 'shelly2', ch: 'cover:0', op: 'close' },
    { base: 'shellies/rollladen-terrasse', family: 'shelly2', ch: 'cover:0', op: 'pos', value: 25 },
    { base: plug.credentials.base, family: 'shelly2', ch: 'switch:0', op: 'off' },
    { base: plug.credentials.base, family: 'shelly2', ch: 'switch:0', op: 'off' },
  ]);
  // portal control: a cover's button, a bad patch, someone else's device
  assert.equal((await asPortal(host, ADA, 'POST', `/portal/resources/${portal.devices[0].id}/state`, { patch: { cover: 'stop' } })).status, 200);
  assert.equal((await asPortal(host, ADA, 'POST', `/portal/resources/${portal.devices[0].id}/state`, { patch: { cover: 'up' } })).status, 400);
  assert.equal((await asPortal(host, ADA, 'POST', `/portal/resources/${portal.devices[0].id}/state`, { patch: { on: true } })).status, 400);
  assert.equal((await asPortal(host, BOB, 'POST', `/portal/resources/${portal.devices[0].id}/state`, { patch: { cover: 'stop' } })).status, 403);
  // a gateway that does not answer: a message, not an error
  edge.down = true;
  r = (await host.runQuickAction(ADA, `plug:${portal.devices[1].id}`)).body;
  assert.equal(r.ok, false);
  assert.equal(r.message, 'Das Gateway im Heimnetz antwortet gerade nicht.');
  const p = await asPortal(host, ADA, 'POST', `/portal/resources/${portal.devices[1].id}/state`, { patch: { on: true } });
  assert.equal(p.status, 502);
  // tiles: the cover's position
  const tiles = await host.plugin.portalTiles({ user: { ...ADA, portal: true }, lang: 'de' }, host.gc);
  assert.deepEqual(tiles.map((x) => [x.title, x.value]), [['Rollladen Terrasse', '60 % offen'], ['Fernseher', 'Aus']]);
}));

test('edit: name, area, output kind and cover type; areas for deCONZ resources too', () => withEdge({ deconz: [fakeDeconz()] }, async (host) => {
  const d = (await admin(host, 'POST', '/edge/devices', { gateway_id: 7, name: 'Shelly WZ', family: 'shelly2' })).json;
  await host.edgeEvent(7, 'states', { devices: [{ base: d.credentials.base, family: 'shelly2', online: true, seenAt: new Date().toISOString(), ch: { 'switch:0': { on: false }, 'switch:1': { on: true } }, sensor: {}, info: {}, drop: [] }] });
  let dev = (await admin(host, 'GET', `/edge/devices/${d.device.id}`)).json.device;
  assert.deepEqual(dev.resources.map((r) => [r.kind, r.name]), [['relay', 'Shelly WZ 1'], ['relay', 'Shelly WZ 2']]);
  let r = await admin(host, 'PUT', `/edge/devices/${d.device.id}`, { name: 'Wohnzimmer', area: '  Wohn\u0000zimmer ', channels: { 'switch:0': { kind: 'light', name: 'Stehlampe' }, 'switch:1': { kind: 'plug' } } });
  assert.equal(r.status, 200);
  dev = (await admin(host, 'GET', `/edge/devices/${d.device.id}`)).json.device;
  assert.deepEqual([dev.name, dev.area], ['Wohnzimmer', 'Wohn zimmer']);
  assert.deepEqual(dev.resources.map((x) => [x.kind, x.name, x.area]), [['light', 'Stehlampe', 'Wohn zimmer'], ['plug', 'Wohnzimmer 2', 'Wohn zimmer']]);
  for (const bad of [{ channels: { 'switch:0': { kind: 'group' } } }, { channels: { 'cover:0': { kind: 'light' } } }, { channels: { 'switch:0': { cover: 'gate' } } }, { channels: [] }, { name: '' }]) {
    assert.equal((await admin(host, 'PUT', `/edge/devices/${d.device.id}`, bad)).status, 400, JSON.stringify(bad));
  }
  // deCONZ: the area of a resource
  const { by } = await connected(host);
  r = await admin(host, 'PUT', `/resources/${by('Stehlampe').id}`, { area: 'Wohnzimmer' });
  assert.deepEqual(r.json, { ok: true, area: 'Wohnzimmer' });
  const again = (await host.request({ path: '/resources', query: { gateway_id: String(by('Stehlampe').gateway_id) }, user: ADMIN })).json.resources;
  assert.equal(again.find((x) => x.name === 'Stehlampe').area, 'Wohnzimmer');
  await asAdmin(host, 'POST', `/gateways/${by('Stehlampe').gateway_id}/sync`);
  assert.equal((await host.gc.db.get('SELECT area FROM resources WHERE id = ?', [by('Stehlampe').id])).row.area, 'Wohnzimmer', 'a sync keeps the area');
  assert.equal((await admin(host, 'PUT', `/resources/${by('Stehlampe').id}`, { area: 5 })).status, 400);
  assert.equal((await admin(host, 'PUT', '/resources/99999', { area: 'x' })).status, 404);
}));

test('automatic set-up: account, device reached, its password asked once (never stored), MQTT written, device reports', () => withEdge({ found: [] }, async (host, edge) => {
  const cand = { ip: '192.168.1.51', family: 'shelly2', model: 'Plus2PM', firmware: '1.4.4', mac: 'A8032AB1C2D4', auth: true };
  let r = await admin(host, 'POST', '/edge/setup', { gateway_id: 7, name: 'Rollladen Terrasse', area: 'Wohnzimmer', candidate: cand });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const jobId = r.json.job.id;
  const poll = async (want) => {
    for (let i = 0; i < 50; i++) {
      const j = (await admin(host, 'GET', `/edge/setup/${jobId}`)).json.job;
      if (want.includes(j.state)) return j;
      await new Promise((res) => setTimeout(res, 5));
    }
    throw new Error('job stuck');
  };
  let job = await poll(['need_password']);
  assert.deepEqual(job.steps.map((s) => [s.id, s.state]), [['account', 'done'], ['reach', 'done'], ['auth', 'need'], ['configure', 'pending'], ['online', 'pending']]);
  assert.deepEqual(job.steps[0], { id: 'account', state: 'done', username: 'gatecontrol-smarthome-rollladen-terrasse', topic: 'shellies/rollladen-terrasse/#' });
  assert.deepEqual(job.steps[1], { id: 'reach', state: 'done', model: 'Plus2PM', firmware: '1.4.4', ident: 'shellyplus2pm-a8032ab1c2d4' });

  // a wrong password → asked again
  r = await admin(host, 'POST', `/edge/setup/${jobId}/password`, { password: 'falsch-123' });
  assert.equal(r.status, 200);
  job = await poll(['need_password']);
  assert.deepEqual(job.steps[2], { id: 'auth', state: 'need', code: 'auth_failed' });
  r = await admin(host, 'POST', `/edge/setup/${jobId}/password`, { password: DEVICE_PW });
  job = await poll(['waiting', 'done']);
  assert.deepEqual(job.steps.map((s) => [s.id, s.state]), [['account', 'done'], ['reach', 'done'], ['auth', 'done'], ['configure', 'done'], ['online', 'running']]);
  const setups = edge.calls.filter((c) => c.method === 'setup');
  assert.equal(setups.length, 2);
  const acc = [...host.mqttAccounts.get(7).values()][0];
  assert.deepEqual(setups[1].params, { ip: '192.168.1.51', family: 'shelly2', user: acc.username, pass: acc.password, prefix: 'rollladen-terrasse', password: DEVICE_PW });
  assert.equal((await admin(host, 'POST', `/edge/setup/${jobId}/password`, { password: DEVICE_PW })).status, 400, 'no password wanted now');

  // the device reports → done
  await host.edgeEvent(7, 'states', { devices: [SNAP_2PM()] });
  job = await poll(['done']);
  assert.equal(job.steps[4].state, 'done');
  const dev = (await admin(host, 'GET', '/edge/devices?gateway_id=7')).json.devices[0];
  assert.deepEqual([dev.name, dev.area, dev.ip, dev.model, dev.configured, dev.reachable], ['Rollladen Terrasse', 'Wohnzimmer', '192.168.1.51', 'Plus2PM', true, true]);

  const all = await everything(host);
  for (const secret of [DEVICE_PW, 'falsch-123', acc.password]) assert.ok(!all.includes(secret), 'stored nowhere: ' + secret.slice(0, 3));
  assert.equal(host.edgeConfigs.get(7).devices.length, 1);
}));

test('automatic set-up: no device password, by hand after all, cancel removes what was made, unreachable devices fail', () => withEdge({}, async (host, edge) => {
  const poll = async (id, want) => {
    for (let i = 0; i < 50; i++) {
      const j = (await admin(host, 'GET', `/edge/setup/${id}`)).json.job;
      if (want.includes(j.state)) return j;
      await new Promise((res) => setTimeout(res, 5));
    }
    throw new Error('job stuck');
  };
  // Tasmota without a password: straight through
  let r = await admin(host, 'POST', '/edge/setup', { gateway_id: 7, name: 'Licht Flur', candidate: { ip: '192.168.1.62', family: 'tasmota' } });
  let job = await poll(r.json.job.id, ['waiting']);
  assert.deepEqual(job.steps.map((s) => s.state), ['done', 'done', 'skipped', 'done', 'running']);
  assert.equal(edge.calls.find((c) => c.method === 'setup').params.prefix, 'licht-flur');

  // by hand after all: the password once, then the job no longer has it
  r = await admin(host, 'POST', '/edge/setup', { gateway_id: 7, name: 'Rollo', candidate: { ip: '192.168.1.51', family: 'shelly2' } });
  const id2 = r.json.job.id;
  await poll(id2, ['need_password']);
  const m = await admin(host, 'POST', `/edge/setup/${id2}/manual`);
  assert.equal(m.json.credentials.password, [...host.mqttAccounts.get(7).values()].find((a) => a.username.endsWith('-rollo')).password);
  assert.equal((await admin(host, 'POST', `/edge/setup/${id2}/manual`)).json.credentials.password, null, 'shown once');

  // cancel before anything was written into the device → device and account go
  r = await admin(host, 'POST', '/edge/setup', { gateway_id: 7, name: 'Weg damit', candidate: { ip: '192.168.1.51', family: 'shelly2' } });
  await poll(r.json.job.id, ['need_password']);
  assert.ok([...host.mqttAccounts.get(7).keys()].some((u) => u.endsWith('-weg-damit')));
  assert.equal((await admin(host, 'DELETE', `/edge/setup/${r.json.job.id}`)).status, 200);
  assert.ok(![...host.mqttAccounts.get(7).keys()].some((u) => u.endsWith('-weg-damit')));
  assert.ok(!(await host.gc.db.get("SELECT id FROM edge_devices WHERE name = 'Weg damit'")).row);
  assert.equal((await admin(host, 'GET', `/edge/setup/${r.json.job.id}`)).status, 404);

  // unreachable
  r = await admin(host, 'POST', '/edge/setup', { gateway_id: 7, name: 'Fern', candidate: { ip: '192.168.1.99', family: 'shelly2' } });
  job = await poll(r.json.job.id, ['failed']);
  assert.deepEqual(job.steps[1], { id: 'reach', state: 'error', code: 'unreachable' });

  // bad requests
  assert.equal((await admin(host, 'POST', '/edge/setup', { gateway_id: 7, name: 'x', candidate: { ip: 'nas.local', family: 'shelly2' } })).status, 400);
  assert.equal((await admin(host, 'POST', '/edge/setup', { gateway_id: 42, name: 'x', candidate: { ip: '192.168.1.51', family: 'shelly2' } })).status, 404);
  assert.equal((await admin(host, 'POST', '/edge/devices', { gateway_id: 7, name: 'x', family: 'zigbee' })).status, 400);
  assert.equal((await asPortal(host, ADA, 'GET', '/edge/devices')).status, 403, 'administrators only');
}));

test('found devices: the hint lists what is not added yet', () => withEdge({ found: [
  { ip: '192.168.1.51', family: 'shelly2', gen: 2, model: 'Plus1PM', name: null, firmware: '1.4.4', id: 'shellyplus1pm-a8032ab1c2d4', mac: 'A8032AB1C2D4', auth: false, host: 'shellyplus1pm-a8032ab1c2d4' },
  { ip: '192.168.1.62', family: 'tasmota', model: 'Sonoff Basic', name: 'sonoff-flur', mac: '24:A1:60:A1:B2:C3' },
  { ip: 'x', family: 'shelly2' },
] }, async (host) => {
  await host.edgeEvent(7, 'found', { devices: [{ ip: '192.168.1.70', family: 'shelly1', model: 'SHSW-1', mac: '84CCA8A1B2C3' }] });
  let r = await admin(host, 'GET', '/edge/found?gateway_id=7');
  assert.deepEqual(r.json.devices.map((d) => d.ip), ['192.168.1.70']);
  r = await admin(host, 'GET', '/edge/found?gateway_id=7&ask=1');
  assert.deepEqual(r.json.devices.map((d) => d.ip).sort(), ['192.168.1.51', '192.168.1.62', '192.168.1.70']);
  await admin(host, 'POST', '/edge/devices', { gateway_id: 7, name: 'Plus', family: 'shelly2', candidate: { ip: '192.168.1.99', family: 'shelly2', mac: 'a8:03:2a:b1:c2:d4' } });
  r = await admin(host, 'GET', '/edge/found?gateway_id=7');
  assert.deepEqual(r.json.devices.map((d) => d.ip).sort(), ['192.168.1.62', '192.168.1.70'], 'added (by MAC) → no longer new');
}));

test('a new MQTT password: written into the device when it can, else shown; removing a device removes its account', () => withEdge({ devicePassword: null }, async (host, edge) => {
  edge.probes['192.168.1.62'].auth = false;
  const d = (await admin(host, 'POST', '/edge/devices', { gateway_id: 7, name: 'Truhe', family: 'tasmota', candidate: { ip: '192.168.1.62', family: 'tasmota' } })).json;
  const before = host.mqttAccounts.get(7).get(d.credentials.username).password;
  let r = await admin(host, 'POST', `/edge/devices/${d.device.id}/password`);
  assert.deepEqual(r.json, { ok: true, applied: true });
  const after = host.mqttAccounts.get(7).get(d.credentials.username).password;
  assert.notEqual(after, before);
  assert.equal(edge.calls.filter((c) => c.method === 'setup').at(-1).params.pass, after);
  // unreachable → shown instead
  delete edge.probes['192.168.1.62'];
  r = await admin(host, 'POST', `/edge/devices/${d.device.id}/password`);
  assert.equal(r.json.applied, false);
  assert.equal(r.json.reason, 'unreachable');
  assert.equal(r.json.credentials.password, host.mqttAccounts.get(7).get(d.credentials.username).password);
  assert.ok(!(await everything(host)).includes(r.json.credentials.password));

  // type changed in the manual dialog: Tasmota → Shelly moves the account to shellies/
  r = await admin(host, 'POST', `/edge/devices/${d.device.id}/family`, { family: 'shelly1' });
  assert.equal(r.json.credentials.base, 'shellies/truhe');
  assert.deepEqual(host.mqttAccounts.get(7).get(r.json.credentials.username).acl, [{ access: 'readwrite', topic: 'shellies/truhe/#' }]);
  r = await admin(host, 'POST', `/edge/devices/${d.device.id}/family`, { family: 'shelly2' });
  assert.equal(r.json.credentials, null, 'Gen1 ↔ Gen2: the same topics, the same account');

  assert.equal((await admin(host, 'DELETE', `/edge/devices/${d.device.id}`)).status, 200);
  assert.equal(host.mqttAccounts.get(7).size, 0);
  assert.deepEqual(host.edgeConfigs.get(7).devices, []);
  assert.equal((await host.gc.db.query('SELECT * FROM edge_devices')).rows.length, 0);
}));

test('removing a device while its gateway is switched off keeps the account for later and removes it then', () => {
  const gateways = [{ ...GW }];
  return withEdge({ gateways }, async (host) => {
    const d = (await admin(host, 'POST', '/edge/devices', { gateway_id: 7, name: 'Pumpe', family: 'shelly1' })).json;
    gateways[0].state = 'disabled';
    assert.equal((await admin(host, 'DELETE', `/edge/devices/${d.device.id}`)).status, 200);
    assert.deepEqual(await host.gc.settings.get('edge.orphans'), [{ gatewayId: 7, username: d.credentials.username }]);
    gateways[0].state = 'running';
    await host.tick();
    assert.equal(host.mqttAccounts.get(7).size, 0);
    assert.deepEqual(await host.gc.settings.get('edge.orphans'), []);
  });
});

test('$started and $online hand the device list to the edge part again', () => withEdge({}, async (host) => {
  await admin(host, 'POST', '/edge/devices', { gateway_id: 7, name: 'Licht', family: 'shelly2' });
  host.edgeConfigs.clear();
  await host.edgeEvent(7, '$started', null);
  assert.deepEqual(host.edgeConfigs.get(7).devices, [{ base: 'shellies/licht', family: 'shelly2' }]);
  host.edgeConfigs.clear();
  await host.edgeEvent(7, '$online', null);
  assert.ok(host.edgeConfigs.get(7));
  const r = await admin(host, 'POST', '/edge/gateways/7/refresh');
  assert.deepEqual(r.json, { ok: true, mqtt: 'ok', devices: 1 });
}));

test('every text the pages and the server use exists in German and English', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const texts = require('../server/texts.json');
  const used = new Set();
  for (const f of ['ui/admin.js', 'ui/portal.js', 'ui/common.js', 'server/index.js', 'server/edge.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    for (const m of src.matchAll(/\bt?T\((?:lang, )?'([a-z0-9_.-]+)'/g)) used.add(m[1]);
  }
  for (const f of ['ui/admin.html', 'ui/portal.html']) {
    for (const m of fs.readFileSync(path.join(__dirname, '..', f), 'utf8').matchAll(/\{\{t:([a-z0-9_.-]+)\}\}/g)) used.add(m[1]);
  }
  const dynamic = (k) => /[._]$/.test(k); // prefixes like 'cover.' + type, 'cover.done_' + op
  for (const k of used) {
    if (dynamic(k)) continue;
    assert.ok(k in texts.de, 'de: ' + k);
    assert.ok(k in texts.en, 'en: ' + k);
  }
  assert.deepEqual(Object.keys(texts.de).sort(), Object.keys(texts.en).sort());
  for (const c of ['shutter', 'awning', 'gate', 'open', 'stop', 'close', 'opening', 'closing', 'done_open', 'done_stop', 'done_close']) assert.ok(texts.de['cover.' + c] && texts.en['cover.' + c], c);
  for (const s of ['off', 'offline', 'pending', 'crashed', 'update_pending', 'unsigned', 'plugin_off', 'denied', 'stopped', 'too_old']) assert.ok(texts.de['source.state.' + s], s);
  // the reasons of an offline gateway (GateControl's src/services/edge/reason.js REASONS) — the page knows the same list
  const reasons = ['gateway_offline', 'edge_missing', 'edge_not_running', 'edge_fence', 'edge_not_connected'];
  const ui = require('node:fs').readFileSync(require('node:path').join(DIR, 'ui/admin.js'), 'utf8');
  assert.deepEqual(/var REASONS = \[([^\]]*)\];/.exec(ui)[1].match(/'([a-z_]+)'/g).map((x) => x.slice(1, -1)), reasons);
  for (const s of reasons) for (const k of ['source.reason.', 'source.reason_short.']) assert.ok(texts.de[k + s] && texts.en[k + s], k + s);
});
