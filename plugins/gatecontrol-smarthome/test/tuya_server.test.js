'use strict';

// Tuya, the server part (server/tuya.js, server/edge.js — since 1.21.0) against the mock host: the rights (optional
// capabilities) and the request for them, the import from the Tuya cloud (signed requests, a fake cloud), from
// devices.json and by hand, the scan on the gateway, adding devices (keys only as secrets, the gateway's
// configuration with them), the reports (kinds from the first status, "Key passt nicht mehr" with one notification),
// switching and colours, the widgets, "Key neu holen", removing. Every id, key and secret here is made up.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createHost, hostError } = require('../../../tools/testing/mock-host');
const { DIR, ADMIN, ADA, USERS } = require('./helpers');
const tuya = require('../server/tuya');

const GW = { id: 7, name: 'Pi Keller', state: 'running', version: '1.49.0' };
const CAPS = ['tcp.lan', 'udp.port:6666', 'udp.port:6667', 'udp.port:7000', 'udp.broadcast'];
const KEY1 = 'abcdefgh12345678';
const KEY2 = 'ponmlkji87654321';
const KEY3 = 'zyxwvuts11223344';
const ID_PLUG = 'bf00test0000plug01';
const ID_LAMP = 'bf00test0000lamp01';
const ID_HUB = 'bf00test00000hub01';
const ID_SUB = 'bf00test00000sub01';
const ID_AIR = 'bf00test00000air01';
const CLOUD = { id: 'clientid0000test', secret: 'secret000000000000000000test0000', region: 'eu' };

function fakeEdge() {
  const f = { calls: [], found: [], down: false };
  f.call = async (gatewayId, method, params) => {
    f.calls.push({ gatewayId, method, params });
    if (f.down) throw hostError('timeout', 'the gateway did not answer in time');
    if (method === 'info') return { version: '1.21.0', mqtt: 'ok', lan: ['192.168.1.23'], devices: 0, found: 0, tuya: { devices: 0, max: 60, udp: 'ok' } };
    if (method === 'tuya.scan') return { udp: 'ok', denied: false, found: f.found };
    if (method === 'command') return { sent: 1 };
    throw hostError('edge_error', `unknown_method: unknown method ${method}`);
  };
  return f;
}

/** The Tuya cloud as far as the import uses it; every request's signature is checked like Tuya does. */
function fakeCloud() {
  const c = { requests: [], fail: null, devices: [
    { id: ID_PLUG, name: 'Steckdose Waschmaschine', local_key: KEY1, category: 'cz', product_name: 'Smart Plug 16A', sub: false, online: true, ip: '203.0.113.7' },
    { id: ID_LAMP, name: 'Stehlampe Wohnzimmer', local_key: KEY2, category: 'dj', product_name: 'RGBCW Bulb', sub: false, online: true },
    { id: ID_HUB, name: 'Zigbee-Hub', local_key: KEY3, category: 'wg2', product_name: 'Zigbee Gateway', sub: false },
    { id: ID_SUB, name: 'Fensterkontakt Bad', local_key: '', category: 'mcs', sub: true, gateway_id: ID_HUB },
    { id: ID_AIR, name: 'Luftreiniger', local_key: 'qqqqwwwweeeerrrr', category: 'kj', product_name: 'Air Purifier', sub: false },
  ] };
  const props = {
    [ID_PLUG]: [{ code: 'switch_1', dp_id: 1 }, { code: 'countdown_1', dp_id: 9 }, { code: 'cur_power', dp_id: 19 }],
    [ID_LAMP]: [{ code: 'switch_led', dp_id: 20 }, { code: 'work_mode', dp_id: 21 }, { code: 'bright_value_v2', dp_id: 22 }, { code: 'temp_value_v2', dp_id: 23 }, { code: 'colour_data_v2', dp_id: 24 }, { code: 'scene_data_v2', dp_id: 25 }],
  };
  const spec = {
    [ID_PLUG]: { status: [{ code: 'switch_1', type: 'Boolean', values: '{}' }, { code: 'cur_power', type: 'Integer', values: '{"unit":"W","min":0,"max":99999,"scale":1,"step":1}' }] },
    [ID_LAMP]: { status: [{ code: 'bright_value_v2', type: 'Integer', values: '{"min":10,"max":1000,"scale":0,"step":1}' }, { code: 'temp_value_v2', type: 'Integer', values: '{"min":0,"max":1000}' }] },
  };
  c.fetch = async (url, o) => {
    const u = new URL(url);
    c.requests.push({ host: u.host, path: u.pathname + u.search, headers: o.headers });
    const h = o.headers;
    const toSign = ['GET', crypto.createHash('sha256').update('').digest('hex'), '', u.pathname + (u.search ? decodeURIComponent(u.search) : '')].join('\n');
    const want = crypto.createHmac('sha256', CLOUD.secret).update(CLOUD.id + (h.access_token || '') + h.t + h.nonce + toSign).digest('hex').toUpperCase();
    const json = (result) => ({ status: 200, headers: {}, body: JSON.stringify({ success: true, result, t: Date.now() }) });
    if (h.client_id !== CLOUD.id || h.sign !== want || h.sign_method !== 'HMAC-SHA256') return { status: 200, body: JSON.stringify({ success: false, code: 1004, msg: 'sign invalid' }) };
    if (c.fail) return { status: 200, body: JSON.stringify({ success: false, code: c.fail, msg: 'denied' }) };
    if (u.pathname === '/v1.0/token') return json({ access_token: 'tok-test-1', expire_time: 7200, uid: 'project-uid' });
    if (h.access_token !== 'tok-test-1') return { status: 200, body: JSON.stringify({ success: false, code: 1010, msg: 'token invalid' }) };
    if (u.pathname === '/v1.0/iot-01/associated-users/devices') return json({ devices: c.devices, has_more: false, last_row_key: '' });
    let m = /^\/v2\.0\/cloud\/thing\/([^/]+)\/shadow\/properties$/.exec(u.pathname);
    if (m) return json({ properties: props[m[1]] || [] });
    m = /^\/v1\.0\/iot-03\/devices\/([^/]+)\/specification$/.exec(u.pathname);
    if (m) return json(spec[m[1]] || { status: [], functions: [] });
    m = /^\/v1\.0\/devices\/([^/]+)$/.exec(u.pathname);
    if (m) return json({ id: m[1], local_key: c.devices.find((d) => d.id === m[1]).local_key });
    return { status: 404, body: '{}' };
  };
  return c;
}

async function withTuya(o, fn) {
  const edge = fakeEdge();
  const cloud = fakeCloud();
  const optional = o.optional || { 7: CAPS.slice() };
  const host = await createHost(DIR, { users: USERS, gatecontrol: '1.326.0', fetch: cloud.fetch, edge: { gateways: [GW], call: edge.call, optional, tooOld: o.tooOld } });
  try {
    await host.start();
    await fn(host, edge, cloud, optional);
  } finally {
    await host.stop();
    await host.close();
  }
}

const admin = (host, method, p, body) => {
  const [pathOnly, qs] = String(p).split('?');
  return host.request({ method, path: pathOnly, query: Object.fromEntries(new URLSearchParams(qs || '')), body: body === undefined ? null : body, user: ADMIN });
};

async function everything(host) {
  const parts = [];
  for (const t of ['edge_devices', 'resources', 'resource_owners', 'gateways', 'rules']) parts.push(JSON.stringify((await host.gc.db.query(`SELECT * FROM ${t}`)).rows));
  parts.push(JSON.stringify([...host.kv]), JSON.stringify(host.logs));
  return parts.join('\n');
}

async function importCloud(host, edge) {
  const r = await admin(host, 'POST', '/edge/tuya/import', { gateway_id: 7, source: 'cloud', ...CLOUD });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  edge.found = [{ id: ID_PLUG, ip: '192.168.1.41', ver: '3.3' }, { id: ID_LAMP, ip: '192.168.1.55', ver: '3.5' }, { id: ID_HUB, ip: '192.168.1.30', ver: '3.4' }];
  const s = await admin(host, 'POST', '/edge/tuya/scan', { session: r.json.session });
  assert.equal(s.status, 200);
  return s.json;
}

test('the rights: missing ones are asked for once (an administrator confirms them per gateway), a too old gateway is named', () => withTuya({ optional: { 7: [] } }, async (host, edge, cloud, optional) => {
  let r = await admin(host, 'GET', '/edge/tuya/status?gateway_id=7');
  assert.deepEqual([r.json.caps.ok, r.json.caps.missing, r.json.caps.gatewaySupported, r.json.caps.link], [false, CAPS, true, '/gateways#gw/7/edge']);
  assert.deepEqual([r.json.cloud, r.json.limit], [{ saved: false, region: null }, { max: 60, count: 0, warn: 52 }]);
  r = await admin(host, 'POST', '/edge/tuya/request', { gateway_id: 7 });
  assert.deepEqual(r.json.caps.requested, CAPS);
  assert.deepEqual(host.edgeRequests.map((x) => [x.key, x.notified]), CAPS.map((k) => [k, true]));
  await admin(host, 'POST', '/edge/tuya/request', { gateway_id: 7 });
  assert.equal(host.edgeRequests.filter((x) => x.notified).length, CAPS.length, 'at most one note per day and right');
  optional[7] = CAPS.slice();
  r = await admin(host, 'GET', '/edge/tuya/status?gateway_id=7');
  assert.equal(r.json.caps.ok, true);
}));

test('a gateway before 1.49.0 cannot apply the rights: the status says so', () => withTuya({ optional: { 7: [] }, tooOld: { 7: true } }, async (host) => {
  const r = await admin(host, 'GET', '/edge/tuya/status?gateway_id=7');
  assert.deepEqual([r.json.caps.gatewaySupported, r.json.caps.unsupported], [false, CAPS]);
}));

test('import from the Tuya cloud: signed requests to the region, the list without keys, kinds from the datapoints, the scan', () => withTuya({}, async (host, edge, cloud) => {
  const s = await importCloud(host, edge);
  assert.ok(cloud.requests.every((x) => x.host === 'openapi.tuyaeu.com'));
  assert.deepEqual(cloud.requests.map((x) => x.path.split('?')[0]).slice(0, 2), ['/v1.0/token', '/v1.0/iot-01/associated-users/devices']);
  const out = JSON.stringify(s);
  for (const k of [KEY1, KEY2, KEY3, ID_PLUG, CLOUD.secret]) assert.ok(!out.includes(k), 'never to the browser: ' + k);
  const by = Object.fromEntries(s.devices.map((d) => [d.name, d]));
  assert.deepEqual(['short', 'kind', 'channels', 'power', 'supported', 'ip', 'ver', 'found'].map((k) => by['Steckdose Waschmaschine'][k]), ['bf…ug01', 'plug', 1, true, true, '192.168.1.41', '3.3', true]);
  assert.deepEqual(by['Stehlampe Wohnzimmer'].light, { bri: true, ct: true, color: 'hs', scenes: ['night', 'read', 'work', 'leisure'] });
  assert.deepEqual([by['Zigbee-Hub'].supported, by['Zigbee-Hub'].reason, by['Zigbee-Hub'].subs], [false, 'hub', 1]);
  assert.deepEqual([by['Fensterkontakt Bad'].supported, by['Fensterkontakt Bad'].reason], [false, 'sub']);
  assert.deepEqual([by.Luftreiniger.supported, by.Luftreiniger.reason, by.Luftreiniger.found], [false, 'unsupported', false]);
  assert.equal(by['Steckdose Waschmaschine'].ip, '192.168.1.41', 'the public address of the cloud is never taken');
  // the access is kept (encrypted secret), not in a table or a log
  assert.ok(host.secrets.has(tuya.CLOUD_KEY));
  assert.ok(!(await everything(host)).includes(CLOUD.secret));
  assert.deepEqual((await admin(host, 'GET', '/edge/tuya/status?gateway_id=7')).json.cloud, { saved: true, region: 'eu' });
}));

test('adding: devices with their keys as secrets only, the gateway gets them with its configuration; resources and colours', () => withTuya({}, async (host, edge) => {
  const s = await importCloud(host, edge);
  const ref = (name) => s.devices.find((d) => d.name === name).ref;
  const r = await admin(host, 'POST', '/edge/tuya/add', { session: s.session, devices: [{ ref: ref('Steckdose Waschmaschine') }, { ref: ref('Stehlampe Wohnzimmer'), name: 'Stehlampe' }, { ref: ref('Zigbee-Hub') }, { ref: ref('Luftreiniger') }] });
  assert.deepEqual([r.json.added, r.json.limited], [2, 0], 'the hub and the unsupported device stay out');
  const all = await everything(host);
  for (const k of [KEY1, KEY2]) assert.ok(!all.includes(k), 'no key in a table or a log');
  assert.equal(host.settings[tuya.keyName(ID_PLUG)], KEY1);
  const cfg = host.edgeConfigs.get(7);
  assert.deepEqual(cfg.tuya.map((d) => [d.id, d.key, d.hint, d.ver, d.p.k]), [[ID_PLUG, KEY1, '192.168.1.41', '3.3', 'plug'], [ID_LAMP, KEY2, '192.168.1.55', '3.5', 'light']]);
  assert.deepEqual(cfg.tuya.find((d) => d.id === ID_PLUG).p, { k: 'plug', sw: [1], pw: 19, pws: 1 });
  assert.ok(cfg.devices.some((d) => d.base === `tuya/${ID_PLUG}` && d.family === 'tuya'));
  // the gateway reports
  const now = new Date().toISOString();
  await host.edgeEvent(7, 'states', { devices: [
    { base: `tuya/${ID_PLUG}`, family: 'tuya', online: true, seenAt: now, ch: { 'switch:0': { on: true, power: 412.3 } }, sensor: {}, info: { ip: '192.168.1.41', tuya: 'ok', ver: '3.3' }, drop: [] },
    { base: `tuya/${ID_LAMP}`, family: 'tuya', online: true, seenAt: now, ch: { 'light:0': { on: true, bri: 70, ct: 333, cm: 'ct' } }, sensor: {}, info: { ip: '192.168.1.55', tuya: 'ok', ver: '3.5' }, drop: [] },
  ] });
  const devs = (await admin(host, 'GET', '/edge/devices?gateway_id=7')).json.devices;
  const plug = devs.find((d) => d.base === `tuya/${ID_PLUG}`);
  assert.deepEqual([plug.family, plug.reachable, plug.page, plug.tuya.link, plug.tuya.short, plug.resources[0].kind, plug.resources[0].state.power], ['tuya', true, null, 'ok', 'bf…ug01', 'plug', 412.3]);
  assert.ok(!JSON.stringify(devs).includes(KEY1));
  const lamp = devs.find((d) => d.base === `tuya/${ID_LAMP}`);
  const res = lamp.resources[0];
  assert.deepEqual([res.kind, res.capabilities.ct, res.capabilities.color, res.capabilities.scenes, res.state.ct, res.state.colormode], ['light', true, 'hs', ['night', 'read', 'work', 'leisure'], 333, 'ct']);
  // switching: colour, colour temperature, a scene — each one command to the edge part
  edge.calls.length = 0;
  for (const body of [{ hue: 43690, sat: 254 }, { ct: 250 }, { scene: 'read' }, { on: false }]) {
    const x = await admin(host, 'POST', `/resources/${res.id}/state`, body);
    assert.equal(x.status, 200, JSON.stringify(x.json));
  }
  assert.deepEqual(edge.calls.filter((c) => c.method === 'command').map((c) => [c.params.op, c.params.value]), [['color', { hue: 43690, sat: 254 }], ['ct', 250], ['scene', 'read'], ['off', undefined]]);
  assert.equal((await admin(host, 'POST', `/resources/${res.id}/state`, { scene: 'disco' })).status, 400);
  // the widget of the apps: brightness, colour temperature (K), colours, scenes
  await host.request({ method: 'PUT', path: `/edge/devices/${lamp.id}/owners`, body: { userIds: [2] }, user: ADMIN });
  await admin(host, 'POST', `/resources/${res.id}/state`, { on: true });
  const w = (await host.quickActions(ADA)).find((a) => a.title === 'Stehlampe').widget;
  assert.deepEqual(w.controls.map((c) => [c.id, c.kind]), [['bri', 'slider'], ['ct', 'slider'], ['color', 'choice'], ['scene', 'choice']]);
  assert.deepEqual(w.controls[3].options.map((o) => o.label), ['Nacht', 'Lesen', 'Arbeit', 'Freizeit']);
  const qa = await host.runQuickAction(ADA, `light:${res.id}`, 'de', { control: 'color', value: 'green' });
  assert.equal(qa.status, 200);
  assert.deepEqual(edge.calls.at(-1).params.value, { hue: 21845, sat: 254 });
  const q2 = await host.runQuickAction(ADA, `light:${res.id}`, 'de', { control: 'ct', value: 2700 });
  assert.equal(q2.status, 200);
  assert.deepEqual([edge.calls.at(-1).params.op, edge.calls.at(-1).params.value], ['ct', 370]);
  // the portal: the colour and the warmth are there for a Tuya light, too
  const portal = await host.request({ method: 'GET', path: '/portal', user: ADA });
  const p = portal.json.devices.find((d) => d.name === 'Stehlampe');
  assert.deepEqual([p.capabilities.ct, p.capabilities.color], [true, 'hs']);
}));

test('key no longer fits: shown, one notification, widgets greyed; "Key neu holen" from the kept access or by hand', () => withTuya({}, async (host, edge, cloud) => {
  const s = await importCloud(host, edge);
  await admin(host, 'POST', '/edge/tuya/add', { session: s.session, devices: [{ ref: s.devices.find((d) => d.name === 'Stehlampe Wohnzimmer').ref, name: 'Stehlampe' }] });
  const now = new Date().toISOString();
  const snap = (link) => ({ base: `tuya/${ID_LAMP}`, family: 'tuya', online: link === 'ok', seenAt: now, ch: { 'light:0': { on: true, bri: 50 } }, sensor: {}, info: { tuya: link, ver: '3.5' }, drop: [] });
  await host.edgeEvent(7, 'states', { devices: [snap('ok')] });
  await host.edgeEvent(7, 'states', { devices: [snap('key')] });
  await host.edgeEvent(7, 'states', { devices: [snap('key')] });
  const notes = host.notifications.filter((n) => n.topic === 'gateway_unreachable');
  assert.equal(notes.length, 1, 'once per device');
  assert.match(notes[0].title, /Key passt nicht mehr/);
  let dev = (await admin(host, 'GET', '/edge/devices?gateway_id=7')).json.devices[0];
  assert.deepEqual([dev.tuya.link, dev.reachable, dev.resources[0].state.tuya_key], ['key', false, true]);
  await host.request({ method: 'PUT', path: `/edge/devices/${dev.id}/owners`, body: { userIds: [2] }, user: ADMIN });
  const w = (await host.quickActions(ADA)).find((a) => a.title === 'Stehlampe').widget;
  assert.ok(w.controls.every((c) => c.disabled === true));
  assert.match(w.status, /Key passt nicht mehr/);
  // the device was paired anew: a new key in the cloud
  cloud.devices.find((d) => d.id === ID_LAMP).local_key = 'newkey0000000001';
  let r = await admin(host, 'POST', `/edge/devices/${dev.id}/tuya_key`, { source: 'cloud' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(host.settings[tuya.keyName(ID_LAMP)], 'newkey0000000001');
  assert.equal(host.edgeConfigs.get(7).tuya[0].key, 'newkey0000000001');
  dev = (await admin(host, 'GET', '/edge/devices?gateway_id=7')).json.devices[0];
  assert.equal(dev.tuya.link, 'connecting');
  r = await admin(host, 'POST', `/edge/devices/${dev.id}/tuya_key`, { source: 'manual', key: 'short' });
  assert.equal(r.status, 400);
  r = await admin(host, 'POST', `/edge/devices/${dev.id}/tuya_key`, { source: 'manual', key: 'handkey000000002' });
  assert.equal(host.settings[tuya.keyName(ID_LAMP)], 'handkey000000002');
  // the access forgotten: from the cloud no longer
  await admin(host, 'DELETE', '/edge/tuya/cloud');
  r = await admin(host, 'POST', `/edge/devices/${dev.id}/tuya_key`, { source: 'cloud' });
  assert.deepEqual([r.status, r.json.code], [409, 'SMARTHOME_TUYA_NO_CLOUD']);
  // removing the device takes its key with it
  await admin(host, 'DELETE', `/edge/devices/${dev.id}`);
  assert.equal(host.settings[tuya.keyName(ID_LAMP)] == null, true);
  assert.deepEqual(host.edgeConfigs.get(7).tuya, []);
}));

test('cloud errors: a wrong secret, a project without the services; the access is not kept when unticked', () => withTuya({}, async (host, edge, cloud) => {
  let r = await admin(host, 'POST', '/edge/tuya/import', { gateway_id: 7, source: 'cloud', ...CLOUD, secret: 'wrongsecret00000000000000000000' });
  assert.deepEqual([r.status, r.json.code, r.json.detail], [400, 'SMARTHOME_TUYA_CLOUD_AUTH', 'tuya 1004']);
  cloud.fail = 28841002;
  r = await admin(host, 'POST', '/edge/tuya/import', { gateway_id: 7, source: 'cloud', ...CLOUD });
  assert.deepEqual([r.status, r.json.code], [409, 'SMARTHOME_TUYA_CLOUD_DENIED']);
  cloud.fail = null;
  r = await admin(host, 'POST', '/edge/tuya/import', { gateway_id: 7, source: 'cloud', ...CLOUD, keep: false });
  assert.equal(r.status, 200);
  assert.ok(!host.settings[tuya.CLOUD_KEY]);
  assert.equal((await admin(host, 'POST', '/edge/tuya/import', { gateway_id: 7, source: 'cloud', ...CLOUD, region: 'mars' })).status, 400);
}));

test('devices.json and a key by hand: no cloud; a kind from the first status, an unknown device with a switch of its choice', () => withTuya({}, async (host, edge, cloud) => {
  const file = [
    { name: 'Lichtschalter Flur', id: 'bf00test0000swit01', key: 'filekey000000001', category: 'kg', product_name: '2 Gang', mapping: { 1: { code: 'switch_1', type: 'Boolean', values: {} }, 2: { code: 'switch_2', type: 'Boolean', values: {} } }, ip: '192.168.1.60', version: '3.3' },
    { name: 'Gerät ohne Mapping', id: 'bf00test0000nomap1', key: 'filekey000000002', category: 'cz' },
    { name: 'Kaputt', id: 'x', key: 'y' },
  ];
  let r = await admin(host, 'POST', '/edge/tuya/import', { gateway_id: 7, source: 'file', devices: file });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(cloud.requests.length, 0, 'no cloud');
  assert.deepEqual(r.json.devices.map((d) => [d.name, d.kind, d.channels]), [['Lichtschalter Flur', 'switch', 2], ['Gerät ohne Mapping', 'auto', 0]]);
  r = await admin(host, 'POST', '/edge/tuya/add', { session: r.json.session, devices: r.json.devices.map((d) => ({ ref: d.ref })) });
  assert.equal(r.json.added, 2);
  // by hand: the kind comes from the device's first status
  r = await admin(host, 'POST', '/edge/tuya/import', { gateway_id: 7, source: 'manual', id: 'bf00test0000hand01', key: 'handkey000000001', kind: 'auto', ip: '192.168.1.70' });
  assert.deepEqual(r.json.devices.map((d) => [d.kind, d.supported, d.ip]), [['auto', true, '192.168.1.70']]);
  await admin(host, 'POST', '/edge/tuya/add', { session: r.json.session, devices: [{ ref: 1, name: 'Von Hand' }] });
  assert.equal(host.edgeConfigs.get(7).tuya.find((d) => d.id === 'bf00test0000hand01').ip, '192.168.1.70', 'an address by hand is kept');
  const now = new Date().toISOString();
  await host.edgeEvent(7, 'states', { devices: [
    { base: 'tuya/bf00test0000nomap1', family: 'tuya', online: true, seenAt: now, ch: {}, sensor: {}, info: { tuya: 'ok', ver: '3.3', dps: { 1: true, 9: 0, 19: 52 } }, drop: [] },
    { base: 'tuya/bf00test0000hand01', family: 'tuya', online: true, seenAt: now, ch: {}, sensor: {}, info: { tuya: 'ok', ver: '3.3', dps: { 2: 'auto', 3: 'mid', 4: 12, 101: true } }, drop: [] },
  ] });
  await new Promise((x) => setTimeout(x, 30));
  const cfg = host.edgeConfigs.get(7).tuya;
  assert.deepEqual(cfg.find((d) => d.id === 'bf00test0000nomap1').p, { k: 'plug', sw: [1], pw: 19, pws: 1 }, 'a plug from its datapoints');
  assert.equal(cfg.find((d) => d.id === 'bf00test0000hand01'), undefined, 'not a known kind: no connection');
  const devs = (await admin(host, 'GET', '/edge/devices?gateway_id=7')).json.devices;
  const other = devs.find((d) => d.base === 'tuya/bf00test0000hand01');
  assert.deepEqual([other.tuya.kind, other.tuya.bools], ['other', [{ dp: 101, code: null }]]);
  assert.ok(other.tuya.dps.some((x) => x.dp === 3 && x.value === 'mid'));
  // "Ein/Aus als Schalter zeigen"
  assert.equal((await admin(host, 'PUT', `/edge/devices/${other.id}`, { tuya: { dp: 3 } })).status, 400, 'not an on/off datapoint');
  r = await admin(host, 'PUT', `/edge/devices/${other.id}`, { tuya: { dp: 101 } });
  assert.equal(r.status, 200);
  assert.deepEqual(host.edgeConfigs.get(7).tuya.find((d) => d.id === 'bf00test0000hand01').p, { k: 'switch', sw: [101] });
  assert.equal((await admin(host, 'PUT', `/edge/devices/${other.id}`, { tuya: { ip: '8.8.8.8' } })).status, 400);
  // the switch's channels are relays by default (kg), each its own resource
  const sw = devs.find((d) => d.base === 'tuya/bf00test0000swit01');
  assert.deepEqual(sw.tuya.kind, 'switch');
  assert.deepEqual((await admin(host, 'POST', '/edge/tuya/scan', { session: 'gone' })).json.code, 'SMARTHOME_TUYA_SESSION');
}));

test('profiles: from the mapping, from the category, from a first status', () => {
  const m = tuya.cleanMapping({ 20: { code: 'switch_led', type: 'Boolean' }, 22: { code: 'bright_value', type: 'Integer', values: '{"min":25,"max":255}' }, 21: { code: 'work_mode', type: 'Enum' } });
  assert.deepEqual(tuya.profileOf('dj', m), { k: 'light', l: { v: 1, sw: 20, mode: 21, bri: 22, temp: null, col: null, scene: null, bmin: 25, bmax: 255, tmax: 255 } });
  assert.deepEqual(tuya.profileOf('pc', tuya.cleanMapping([{ dp_id: 1, code: 'switch_1' }, { dp_id: 2, code: 'switch_2' }, { dp_id: 7, code: 'switch_usb1' }])), { k: 'plug', sw: [1, 2, 7] });
  assert.deepEqual(tuya.profileOf('kj', []), null);
  assert.deepEqual(tuya.profileOf('dj', []), { k: 'auto' });
  assert.deepEqual(tuya.classify({ 20: true, 21: 'white', 22: 1000, 23: 0, 24: '000003e803e8' }), { k: 'light', l: { v: 2, sw: 20, mode: 21, bri: 22, temp: 23, col: 24, scene: null, bmin: 10, bmax: 1000, tmax: 1000 } });
  assert.deepEqual(tuya.classify({ 1: true, 2: 'white', 3: 200 }), { k: 'light', l: { v: 1, sw: 1, mode: 2, bri: 3, temp: null, col: null, scene: null, bmin: 25, bmax: 255, tmax: 255 } });
  assert.deepEqual(tuya.classify({ 1: true, 2: false, 3: true, 7: false }), { k: 'switch', sw: [1, 2, 3, 7] });
  assert.equal(tuya.classify({ 2: 'auto', 3: 'mid' }), null);
});

test('the cloud signature (Tuya\'s documented scheme: client_id, token, t, nonce, method, body hash, sorted query)', () => {
  const s = tuya.signed({ id: 'ab', secret: 'cd', region: 'eu' }, 'GET', '/v1.0/devices', { size: 50, last_row_key: 'x' }, 'tok');
  assert.equal(s.url, '/v1.0/devices?last_row_key=x&size=50');
  const toSign = ['GET', crypto.createHash('sha256').update('').digest('hex'), '', s.url].join('\n');
  assert.equal(s.headers.sign, crypto.createHmac('sha256', 'cd').update('ab' + 'tok' + s.headers.t + s.headers.nonce + toSign).digest('hex').toUpperCase());
  assert.deepEqual([s.headers.client_id, s.headers.access_token, s.headers.sign_method], ['ab', 'tok', 'HMAC-SHA256']);
});

test('logic chains on the gateway take Tuya devices: power as a trigger, on / brightness as steps — compiled for the edge part', () => withTuya({}, async (host, edge) => {
  const s = await importCloud(host, edge);
  const ref = (name) => s.devices.find((d) => d.name === name).ref;
  await admin(host, 'POST', '/edge/tuya/add', { session: s.session, devices: [{ ref: ref('Steckdose Waschmaschine'), name: 'Waschmaschine' }, { ref: ref('Stehlampe Wohnzimmer'), name: 'Stehlampe' }] });
  const now = new Date().toISOString();
  await host.edgeEvent(7, 'states', { devices: [
    { base: `tuya/${ID_PLUG}`, family: 'tuya', online: true, seenAt: now, ch: { 'switch:0': { on: true, power: 400 } }, sensor: {}, info: { tuya: 'ok', ver: '3.3' }, drop: [] },
    { base: `tuya/${ID_LAMP}`, family: 'tuya', online: true, seenAt: now, ch: { 'light:0': { on: false, bri: 50 } }, sensor: {}, info: { tuya: 'ok', ver: '3.5' }, drop: [] },
  ] });
  const devs = (await admin(host, 'GET', '/edge/devices?gateway_id=7')).json.devices;
  const rid = (name) => devs.find((d) => d.name === name).resources[0].id;
  const def = {
    version: 2,
    triggers: [{ kind: 'power', resourceId: rid('Waschmaschine'), op: 'lt', value: 5 }],
    conditions: { mode: 'all', list: [] },
    steps: [{ kind: 'action', resourceId: rid('Stehlampe'), set: { bri: 40 } }, { kind: 'action', resourceId: rid('Waschmaschine'), set: { on: false } }],
    retrigger: 'ignore',
  };
  const r = await admin(host, 'POST', '/rules', { gateway_id: 7, source: 'edge', name: 'Wäsche fertig', definition: def });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const rule = host.edgeConfigs.get(7).rules.find((x) => x.id === r.json.rule.id);
  assert.deepEqual(rule.when, [{ k: 'dev', base: `tuya/${ID_PLUG}`, ch: 'switch:0', field: 'power', op: 'lt', value: 5 }]);
  assert.deepEqual(rule.steps, [{ k: 'act', base: `tuya/${ID_LAMP}`, family: 'tuya', ch: 'light:0', op: 'bri', value: 40 }, { k: 'act', base: `tuya/${ID_PLUG}`, family: 'tuya', ch: 'switch:0', op: 'off' }]);
  // the edge part checks such a step like any other
  const rules = require('../edge/rules');
  assert.ok(rules.cleanRule(rule), 'the gateway runs it');
}));
