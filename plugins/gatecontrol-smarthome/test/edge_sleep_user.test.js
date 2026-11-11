'use strict';

// Two follow-ups for Shelly and Tasmota devices through a GateControl gateway (1.10.0):
//   * battery devices (Shelly H&T …) sleep between their reports — the page shows "schläft – letzte Meldung vor …"
//     and a hint for a weak battery, never "nicht erreichbar"; from the simulated MQTT messages of a Gen1 and a
//     Gen2 H&T through edge/normalize.js to the device view and the portal;
//   * the user name of a device's own web access (Shelly Gen1: HTTP Basic, Tasmota: form field) can be another one
//     than "admin", per device — the device password is still used once and never kept.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHost, hostError } = require('../../../tools/testing/mock-host');
const { DIR, ADMIN, ADA, USERS, asPortal } = require('./helpers');
const normalize = require('../edge/normalize');
const devices = require('../edge/devices');
const edge = require('../server/edge');

const GW = { id: 7, name: 'Pi Keller', state: 'running', version: '1.20.0' };
const DEVICE_PW = 'Shelly-Geheim-42';

function fakeEdge(o = {}) {
  const f = { calls: [], user: o.user || 'admin', password: o.password === undefined ? DEVICE_PW : o.password };
  f.call = async (gatewayId, method, params) => {
    f.calls.push({ gatewayId, method, params });
    if (method === 'info') return { version: '1.10.0', startedAt: '2026-11-11T04:00:00.000Z', mqtt: 'ok', lan: ['192.168.1.23'], devices: 1, found: 0 };
    if (method === 'discover') return { devices: [] };
    if (method === 'probe') return { ip: params.ip, family: o.family || 'shelly1', gen: 1, model: 'SHSW-1', name: null, firmware: '1.14.0', id: null, mac: '84CCA8A1B2C3', auth: f.password != null, host: '192.168.1.23' };
    if (method === 'setup') {
      if (f.password != null && (params.password !== f.password || (params.httpUser || 'admin') !== f.user)) throw hostError('edge_error', `${params.password ? 'auth_failed' : 'auth_required'}: the device has a password`);
      return { ok: true, host: '192.168.1.23', port: 1883 };
    }
    throw hostError('edge_error', `unknown_method: unknown method ${method}`);
  };
  return f;
}

async function withEdge(o, fn) {
  const fe = fakeEdge(o);
  const host = await createHost(DIR, { users: USERS, gatecontrol: '1.228.1', settings: o.settings, edge: { gateways: [GW], call: fe.call }, targets: { gateway: [] } });
  try {
    await host.start();
    await fn(host, fe);
  } finally {
    await host.stop();
    await host.close();
  }
}

const admin = (host, method, p, body) => {
  const [pathOnly, qs] = String(p).split('?');
  return host.request({ method, path: pathOnly, query: Object.fromEntries(new URLSearchParams(qs || '')), body: body === undefined ? null : body, user: ADMIN });
};

/** MQTT messages as a device sends them → the snapshot the edge part reports (edge/normalize.js). */
function snapshotOf(base, messages, seenAt) {
  let dev = null;
  for (const [topic, payload] of messages) {
    const r = normalize.parse(`${base}/${topic}`, Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)));
    assert.ok(r, topic);
    dev = dev || normalize.newDevice(r.base, r.family);
    if (r.family) dev.family = r.family;
    normalize.apply(dev, r.patch);
  }
  return { ...normalize.snapshot(dev), seenAt: seenAt || new Date().toISOString() };
}
const HT_GEN1 = (battery) => [['sensor/temperature', '21.4'], ['sensor/humidity', '48.5'], ['sensor/battery', String(battery)]];
const HT_GEN3 = (battery, usb) => [
  ['events/rpc', { src: 'shellyhtg3-84fce63ad204', method: 'NotifyFullStatus', params: { 'temperature:0': { id: 0, tC: 19.6 }, 'humidity:0': { id: 0, rh: 55.2 }, 'devicepower:0': { id: 0, battery: { V: 5.9, percent: battery }, external: { present: usb } } } }],
];

async function addDevice(host, name, family) {
  const r = await admin(host, 'POST', '/edge/devices', { gateway_id: 7, name, family });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.credentials.base;
}
const view = async (host, name) => (await admin(host, 'GET', '/edge/devices?gateway_id=7')).json.devices.find((d) => d.name === name);
const flags = (d) => ({ sleeper: d.sleeper, overdue: d.overdue, reachable: d.reachable, waiting: d.waiting, battery: d.battery, battery_low: d.battery_low });

test('a Shelly H&T sleeps: "schläft" with its last report instead of "nicht erreichbar", overdue only after more than a day', () => withEdge({}, async (host) => {
  const ht = await addDevice(host, 'Klima Keller', 'shelly1');
  const g3 = await addDevice(host, 'Klima Bad', 'shelly2');
  const usb = await addDevice(host, 'Klima Büro', 'shelly2');
  const plug = await addDevice(host, 'Steckdose', 'shelly2');
  assert.deepEqual(flags(await view(host, 'Klima Keller')), { sleeper: false, overdue: false, reachable: false, waiting: true, battery: null, battery_low: false }, 'not reported yet: waiting, not asleep');
  const twoHours = new Date(Date.now() - 2 * 3600000).toISOString();
  await host.edgeEvent(7, 'states', { devices: [
    snapshotOf(ht, HT_GEN1(82), twoHours),
    snapshotOf(g3, HT_GEN3(64, false), twoHours),
    snapshotOf(usb, HT_GEN3(100, true)),
    snapshotOf(plug, [['status/switch:0', { id: 0, output: true, apower: 12 }]]),
  ] });
  assert.deepEqual(flags(await view(host, 'Klima Keller')), { sleeper: true, overdue: false, reachable: true, waiting: false, battery: 82, battery_low: false });
  assert.deepEqual(flags(await view(host, 'Klima Bad')), { sleeper: true, overdue: false, reachable: true, waiting: false, battery: 64, battery_low: false });
  assert.equal((await view(host, 'Klima Keller')).last_seen_at, twoHours);
  assert.equal((await view(host, 'Klima Büro')).sleeper, false, 'on USB power it stays awake');
  assert.equal((await view(host, 'Steckdose')).sleeper, false, 'a device with an output never sleeps');
  const res = (await view(host, 'Klima Bad')).resources[0];
  assert.deepEqual(res.state, { reachable: true, type: 'temperature', value: 19.6, humidity: 55, battery: 64, sleeping: true, lastupdated: twoHours });
  assert.equal((await view(host, 'Klima Büro')).resources[0].state.sleeping, undefined);

  // 30 hours without a report: still "schläft" — but overdue (the battery may be empty); a mains device is unreachable
  const old = new Date(Date.now() - 30 * 3600000).toISOString();
  await host.gc.db.run('UPDATE edge_devices SET last_seen_at = ?', [old]);
  await host.tick();
  assert.deepEqual(flags(await view(host, 'Klima Keller')), { sleeper: true, overdue: true, reachable: false, waiting: false, battery: 82, battery_low: false });
  assert.deepEqual([(await view(host, 'Steckdose')).sleeper, (await view(host, 'Steckdose')).reachable], [false, false]);
  // the portal: the last value stays, with since when — never just "unreachable"
  const sensor = (await view(host, 'Klima Keller')).resources[0];
  await admin(host, 'PUT', `/resources/${sensor.id}/owners`, { userIds: [ADA.id] });
  let p = (await asPortal(host, ADA, 'GET', '/portal')).json.sensors[0];
  assert.deepEqual(p.state, { reachable: false, type: 'temperature', value: 21.4, humidity: 49, battery: 82, sleeping: true, lastupdated: twoHours });
  // it wakes up and reports: awake again for the page
  await host.edgeEvent(7, 'states', { devices: [snapshotOf(ht, HT_GEN1(81))] });
  assert.deepEqual(flags(await view(host, 'Klima Keller')), { sleeper: true, overdue: false, reachable: true, waiting: false, battery: 81, battery_low: false });
  assert.equal(edge.sleeperOf({ last_seen_at: null, state: {} }), false);
}));

test('a weak battery: the hint at the threshold of the "Batterie schwach" notification (setting, default 15 %)', async () => {
  await withEdge({}, async (host) => {
    const ht = await addDevice(host, 'Klima Keller', 'shelly1');
    await host.edgeEvent(7, 'states', { devices: [snapshotOf(ht, HT_GEN1(16))] });
    assert.equal((await view(host, 'Klima Keller')).battery_low, false);
    await host.edgeEvent(7, 'states', { devices: [snapshotOf(ht, HT_GEN1(15))] });
    const d = await view(host, 'Klima Keller');
    assert.deepEqual([d.battery, d.battery_low, d.sleeper], [15, true, true]);
    assert.equal((await admin(host, 'GET', `/edge/devices/${d.id}`)).json.device.battery_low, true);
    await admin(host, 'PUT', `/resources/${d.resources[0].id}/owners`, { userIds: [ADA.id] });
    assert.equal((await asPortal(host, ADA, 'GET', '/portal')).json.sensors[0].state.battery_low, true);
  });
  await withEdge({ settings: { notify_battery_low: 30 } }, async (host) => {
    const ht = await addDevice(host, 'Klima Keller', 'shelly1');
    await host.edgeEvent(7, 'states', { devices: [snapshotOf(ht, HT_GEN1(28))] });
    assert.equal((await view(host, 'Klima Keller')).battery_low, true, 'the setting moves the threshold');
  });
});

// ─── the user name of the device's own web access ───

function fakeHttp(answer) {
  const seen = [];
  return { seen, request: async (o) => { seen.push(o); const a = answer(o) || {}; return { status: a.status || 200, headers: a.headers || {}, text: () => JSON.stringify(a.body || {}) }; } };
}
const MQTT = { host: '192.168.1.23', user: 'gatecontrol-smarthome-pumpe', pass: 'mqttPass_9aZ-xYv3QwErTy12', prefix: 'pumpe' };

test('edge part: Shelly Gen1 (Basic) and Tasmota (form field) with the given user name — "admin" without one; Gen2 keeps admin', async () => {
  const basic = (user, pw) => 'Basic ' + Buffer.from(`${user}:${pw}`).toString('base64');
  let h = fakeHttp(() => ({ body: {} }));
  await devices.setup(h, { ...MQTT, ip: '192.168.1.40', family: 'shelly1', password: 'geheim', httpUser: 'installateur' });
  assert.deepEqual(h.seen.map((r) => [new URL(r.url).pathname, r.headers.Authorization]), [['/settings', basic('installateur', 'geheim')], ['/reboot', basic('installateur', 'geheim')]]);
  h = fakeHttp(() => ({ body: {} }));
  await devices.setup(h, { ...MQTT, ip: '192.168.1.40', family: 'shelly1', password: 'geheim' });
  assert.equal(h.seen[0].headers.Authorization, basic('admin', 'geheim'));
  h = fakeHttp(() => ({ body: {} }));
  await devices.setup(h, { ...MQTT, ip: '192.168.1.40', family: 'shelly1', httpUser: 'installateur' });
  assert.equal(h.seen[0].headers.Authorization, undefined, 'no password, no header');

  h = fakeHttp(() => ({ body: {} }));
  await devices.setup(h, { ...MQTT, ip: '192.168.1.62', family: 'tasmota', password: 'tas&pw=1', httpUser: 'Werkstatt Müller' });
  const form = Object.fromEntries(new URLSearchParams(h.seen[0].body));
  assert.deepEqual([form.user, form.password], ['Werkstatt Müller', 'tas&pw=1']);
  assert.ok(!h.seen[0].url.includes('tas'), 'never in the URL');
  h = fakeHttp(() => ({ body: {} }));
  await devices.setup(h, { ...MQTT, ip: '192.168.1.62', family: 'tasmota', password: 'x' });
  assert.equal(Object.fromEntries(new URLSearchParams(h.seen[0].body)).user, 'admin');

  // Gen2+: Digest, and the firmware only knows "admin"
  let n = 0;
  h = fakeHttp(() => (n++ % 2 === 0 ? { status: 401, headers: { 'WWW-Authenticate': 'Digest qop="auth", realm="shellyplus1", nonce="abc", algorithm=SHA-256' }, body: {} } : { body: { result: {} } }));
  await devices.setup(h, { ...MQTT, ip: '192.168.1.51', family: 'shelly2', password: 'geheim', httpUser: 'installateur' });
  assert.match(h.seen[1].headers.Authorization, /^Digest username="admin", /);

  // a user name that cannot be one
  for (const bad of ['a:b', 'x'.repeat(65), 'a"b', 'a\\b', 'a\nb', 7, {}, '']) {
    h = fakeHttp(() => ({ body: {} }));
    const p = devices.setup(h, { ...MQTT, ip: '192.168.1.40', family: 'shelly1', password: 'geheim', httpUser: bad });
    if (bad === '') { await p; assert.equal(h.seen[0].headers.Authorization, basic('admin', 'geheim'), 'empty: admin'); continue; }
    await assert.rejects(p, (e) => e.code === 'bad_request', JSON.stringify(bad));
    assert.equal(h.seen.length, 0, 'nothing sent');
  }
});

async function pollJob(host, id, want) {
  for (let i = 0; i < 50; i++) {
    const j = (await admin(host, 'GET', `/edge/setup/${id}`)).json.job;
    if (want.includes(j.state)) return j;
    await new Promise((res) => setTimeout(res, 5));
  }
  throw new Error('job stuck');
}
async function everything(host) {
  const parts = [];
  for (const t of ['edge_devices', 'resources', 'resource_owners', 'gateways', 'rules']) parts.push(JSON.stringify((await host.gc.db.query(`SELECT * FROM ${t}`)).rows));
  parts.push(JSON.stringify(host.settings), JSON.stringify([...(host.secrets || [])]), JSON.stringify([...host.kv]), JSON.stringify(host.logs));
  return parts.join('\n');
}

test('automatic set-up with another user name: asked with the password, kept with the device — the password never is', () => withEdge({ user: 'installateur' }, async (host, fe) => {
  const cand = { ip: '192.168.1.40', family: 'shelly1', model: 'SHSW-1', firmware: '1.14.0', mac: '84CCA8A1B2C3', auth: true };
  const jobId = (await admin(host, 'POST', '/edge/setup', { gateway_id: 7, name: 'Pumpe', candidate: cand })).json.job.id;
  let job = await pollJob(host, jobId, ['need_password']);
  assert.equal(job.httpUser, 'admin', 'the page starts with admin');
  // admin (the default) is wrong for this device
  await admin(host, 'POST', `/edge/setup/${jobId}/password`, { password: DEVICE_PW });
  job = await pollJob(host, jobId, ['need_password']);
  assert.equal(job.steps.find((s) => s.id === 'auth').code, 'auth_failed');
  assert.equal(fe.calls.filter((c) => c.method === 'setup').at(-1).params.httpUser, undefined, '"admin" is not sent: the edge part\'s default');
  assert.equal((await admin(host, 'POST', `/edge/setup/${jobId}/password`, { password: DEVICE_PW, user: 'a:b' })).status, 400);
  assert.equal((await admin(host, 'POST', `/edge/setup/${jobId}/password`, { password: DEVICE_PW, user: 'installateur' })).status, 200);
  job = await pollJob(host, jobId, ['waiting', 'done']);
  assert.equal(job.httpUser, 'installateur');
  const call = fe.calls.filter((c) => c.method === 'setup').at(-1).params;
  assert.deepEqual([call.httpUser, call.password, call.family], ['installateur', DEVICE_PW, 'shelly1']);
  const dev = (await admin(host, 'GET', '/edge/devices?gateway_id=7')).json.devices[0];
  assert.deepEqual([dev.http_user, dev.config.httpUser, dev.configured], ['installateur', 'installateur', true]);
  const all = await everything(host);
  assert.ok(!all.includes(DEVICE_PW), 'the device password is nowhere');
  assert.ok(all.includes('installateur'));

  // "Neues MQTT-Passwort": with the device password of this one request and the kept user name it is written into the device
  let r = await admin(host, 'POST', `/edge/devices/${dev.id}/password`);
  assert.deepEqual([r.json.applied, r.json.reason], [false, 'auth_required'], 'without the device password: shown for typing in, as before');
  assert.ok(r.json.credentials.password);
  r = await admin(host, 'POST', `/edge/devices/${dev.id}/password`, { device_password: DEVICE_PW });
  assert.deepEqual(r.json, { ok: true, applied: true });
  const again = fe.calls.filter((c) => c.method === 'setup').at(-1).params;
  assert.deepEqual([again.httpUser, again.password], ['installateur', DEVICE_PW]);
  assert.ok(!(await everything(host)).includes(DEVICE_PW));

  // changed in "Bearbeiten"; "admin" or nothing is the default again; channels and the rest of the configuration stay
  assert.equal((await admin(host, 'PUT', `/edge/devices/${dev.id}`, { http_user: 'werkstatt' })).status, 200);
  assert.equal((await admin(host, 'GET', `/edge/devices/${dev.id}`)).json.device.http_user, 'werkstatt');
  assert.equal((await admin(host, 'PUT', `/edge/devices/${dev.id}`, { name: 'Pumpe', channels: {} })).status, 200);
  assert.equal((await admin(host, 'GET', `/edge/devices/${dev.id}`)).json.device.http_user, 'werkstatt', 'saving the dialog without the field keeps it');
  for (const bad of ['a:b', 'x'.repeat(65), 5]) assert.equal((await admin(host, 'PUT', `/edge/devices/${dev.id}`, { http_user: bad })).status, 400, String(bad));
  assert.equal((await admin(host, 'PUT', `/edge/devices/${dev.id}`, { http_user: '' })).status, 200);
  const reset = (await admin(host, 'GET', `/edge/devices/${dev.id}`)).json.device;
  assert.deepEqual([reset.http_user, 'httpUser' in reset.config], ['admin', false]);
}));

test('Shelly Gen2+: always "admin", whatever was entered', () => withEdge({ family: 'shelly2' }, async (host, fe) => {
  const cand = { ip: '192.168.1.51', family: 'shelly2', model: 'Plus1PM', firmware: '1.4.4', mac: 'A8032AB1C2D4', auth: true };
  const jobId = (await admin(host, 'POST', '/edge/setup', { gateway_id: 7, name: 'Licht', candidate: cand })).json.job.id;
  await pollJob(host, jobId, ['need_password']);
  await admin(host, 'POST', `/edge/setup/${jobId}/password`, { password: DEVICE_PW, user: 'installateur' });
  await pollJob(host, jobId, ['waiting', 'done']);
  assert.equal(fe.calls.filter((c) => c.method === 'setup').at(-1).params.httpUser, undefined);
  const dev = (await admin(host, 'GET', '/edge/devices?gateway_id=7')).json.devices[0];
  assert.deepEqual([dev.http_user, dev.config.httpUser], ['admin', undefined]);
  assert.equal(edge.httpUserOf({ family: 'shelly2', config: { httpUser: 'x' } }), 'admin');
  assert.equal(edge.httpUserOf({ family: 'tasmota', config: { httpUser: 'x' } }), 'x');
}));
