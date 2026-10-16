'use strict';

// Remote commands (ported from GateControl's tests/skoda_control.test.js,
// skoda_client_control.test.js, skoda_command_api.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, asAdmin, asPortal, connected, VIN, ADA } = require('./helpers');

const cmd = (host, id, action, args) => asAdmin(host, 'POST', `/vehicles/${id}/command`, { action, args });
const last = (cloud) => cloud.commands.at(-1);
// the refresh timer is unref'd (never holds the host's process): keep the test's event loop alive while awaiting it
const keepAlive = (p) => { const h = setInterval(() => {}, 1000); return Promise.resolve(p).finally(() => clearInterval(h)); };

test('climate, window heating, charging, charge limit: payloads of python-myskoda', () => withHost({}, async (host, cloud) => {
  const { vehicleId } = await connected(host, cloud);
  assert.equal((await cmd(host, vehicleId, 'ac_start', { temp: 21.3 })).status, 200);
  assert.deepEqual(last(cloud), { method: 'POST', path: `/api/v2/air-conditioning/${VIN}/start`, body: { heaterSource: 'ELECTRIC', targetTemperature: { temperatureValue: 21.5, unitInCar: 'CELSIUS' } } });
  await cmd(host, vehicleId, 'ac_temp', { temp: 19 });
  assert.deepEqual(last(cloud).body, { temperatureValue: 19, unitInCar: 'CELSIUS' });
  for (const [action, p] of [['ac_stop', '/api/v2/air-conditioning/%/stop'], ['window_heat_start', '/api/v2/air-conditioning/%/start-window-heating'],
    ['window_heat_stop', '/api/v2/air-conditioning/%/stop-window-heating'], ['charge_start', '/api/v1/charging/%/start'], ['charge_stop', '/api/v1/charging/%/stop']]) {
    assert.equal((await cmd(host, vehicleId, action, {})).status, 200, action);
    assert.equal(last(cloud).path, p.replace('%', VIN), action);
  }
  await cmd(host, vehicleId, 'charge_limit', { limit: 80 });
  assert.deepEqual(last(cloud), { method: 'PUT', path: `/api/v1/charging/${VIN}/set-charge-limit`, body: { targetSOCInPercent: 80 } });
}));

test('validation: unknown/prototype actions, temperature range, charge steps', () => withHost({}, async (host, cloud) => {
  const { vehicleId } = await connected(host, cloud);
  const n = cloud.commands.length;
  for (const action of ['explode', 'constructor', '__proto__', 'toString', null]) {
    const r = await cmd(host, vehicleId, action, {});
    assert.equal(r.status, 400, String(action));
    assert.equal(r.json.code, 'SKODA_UNKNOWN_COMMAND');
  }
  for (const temp of [15, 30.5, '21', null]) assert.equal((await cmd(host, vehicleId, 'ac_start', { temp })).json.code, 'SKODA_VALIDATION', String(temp));
  for (const limit of [55, '80', 110]) assert.equal((await cmd(host, vehicleId, 'charge_limit', { limit })).json.code, 'SKODA_VALIDATION', String(limit));
  assert.equal(cloud.commands.length, n, 'nothing reached the cloud');
  assert.equal((await cmd(host, 999, 'ac_stop', {})).status, 404);
}));

test('lock/unlock need the S-PIN; 5 attempts per 15 minutes', () => withHost({}, async (host, cloud) => {
  const { accountId, vehicleId } = await connected(host, cloud);
  const r = await cmd(host, vehicleId, 'unlock', {});
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'SKODA_SPIN_REQUIRED');
  await asAdmin(host, 'PUT', `/accounts/${accountId}/spin`, { spin: '4711' });
  assert.equal((await cmd(host, vehicleId, 'lock', {})).status, 200);
  assert.deepEqual(last(cloud), { method: 'POST', path: `/api/v1/vehicle-access/${VIN}/lock`, body: { currentSpin: '4711' } });
  assert.equal((await cmd(host, vehicleId, 'unlock', {})).status, 200);
  assert.equal(last(cloud).path, `/api/v1/vehicle-access/${VIN}/unlock`);
  for (let i = 0; i < 3; i++) await cmd(host, vehicleId, 'lock', {});
  const limited = await cmd(host, vehicleId, 'lock', {});
  assert.equal(limited.status, 429);
  assert.equal(limited.json.code, 'SKODA_COMMAND_RATE_LIMIT');
  assert.ok(!host.logs.some((l) => l.message.includes('4711')), 'the S-PIN is never logged');
}));

// ─── A refused S-PIN is never sent again ─────────
const REFUSED = { status: 403, body: { errorCode: 'SPIN_INVALID', message: 'The S-PIN is not valid.' } };
const spinCalls = (cloud) => cloud.calls.filter((c) => c.url.includes('/vehicle-access/')).length;
const account = async (host) => (await asAdmin(host, 'GET', '/')).json.accounts[0];

test('a lock Škoda refuses marks the stored S-PIN: nothing is sent until a new S-PIN is saved', () => withHost({}, async (host, cloud) => {
  const { accountId, vehicleId } = await connected(host, cloud);
  await asAdmin(host, 'PUT', `/vehicles/${vehicleId}/owners`, { user_ids: [ADA.id] });
  await asAdmin(host, 'PUT', `/accounts/${accountId}/spin`, { spin: '9876' }); // e.g. the bank PIN
  assert.equal((await account(host)).spin_rejected, false);
  const answers = [];
  const keep = (r) => { answers.push(r); return r; };

  // first lock: Škoda refuses (403) → the answer says so, the S-PIN is marked
  cloud.fail['/vehicle-access/'] = REFUSED;
  let r = keep(await cmd(host, vehicleId, 'lock', {}));
  assert.equal(r.status, 502);
  assert.equal(r.json.code, 'SKODA_API_ERROR');
  assert.equal(r.json.error, 'Škoda hat den Befehl abgelehnt (HTTP 403) – bitte die S-PIN im Konto prüfen und neu eingeben.');
  assert.equal(spinCalls(cloud), 1);
  const acc = keep(await account(host));
  assert.equal(acc.has_spin, true);
  assert.equal(acc.spin_rejected, true);
  assert.ok(host.logs.some((l) => l.level === 'warn' && l.message.includes('refused the stored S-PIN') && l.message.includes('HTTP 403')));

  // from now on nothing reaches the cloud: admin, portal and app answer at once
  delete cloud.fail['/vehicle-access/'];
  const MSG = 'Škoda hat die gespeicherte S-PIN abgelehnt – bitte die S-PIN im Konto neu eingeben.';
  for (const action of ['lock', 'unlock']) {
    r = keep(await cmd(host, vehicleId, action, {}));
    assert.deepEqual([r.status, r.json.code, r.json.error], [409, 'SKODA_SPIN_REJECTED', MSG], action);
  }
  r = keep(await asPortal(host, ADA, 'POST', `/portal/vehicles/${vehicleId}/command`, { action: 'lock', args: {} }));
  assert.deepEqual([r.status, r.json.code, r.json.error], [409, 'SKODA_SPIN_REJECTED', MSG]);
  const en = keep(await host.request({ method: 'POST', path: `/vehicles/${vehicleId}/command`, body: { action: 'lock', args: {} }, user: { id: 1, name: 'admin', role: 'admin' }, lang: 'en' }));
  assert.equal(en.json.error, 'Škoda refused the stored S-PIN – please re-enter the S-PIN in the account.');
  // the app's lock stays listed and answers with the message
  const qa = keep(await host.quickActions(ADA));
  assert.ok(qa.some((a) => a.id === `lock:${vehicleId}`), 'the lock stays listed');
  r = keep(await host.runQuickAction(ADA, `lock:${vehicleId}`));
  assert.deepEqual([r.status, r.body.ok, r.body.message], [200, false, MSG]);
  assert.equal(spinCalls(cloud), 1, 'nothing more was sent to Škoda');
  // other commands are not affected
  assert.equal((await cmd(host, vehicleId, 'ac_stop', {})).status, 200);

  // a new S-PIN clears the mark (nothing is sent when saving); the lock goes to the cloud again
  const before = cloud.calls.length;
  r = keep(await asAdmin(host, 'PUT', `/accounts/${accountId}/spin`, { spin: '4711' }));
  assert.equal(r.status, 200);
  assert.equal(cloud.calls.length, before, 'saving the S-PIN talks to nobody');
  assert.equal(keep(await account(host)).spin_rejected, false);
  assert.equal(keep(await cmd(host, vehicleId, 'lock', {})).status, 200);
  assert.deepEqual(last(cloud), { method: 'POST', path: `/api/v1/vehicle-access/${VIN}/lock`, body: { currentSpin: '4711' } });

  // the S-PIN never appears in a log line or an answer
  for (const pin of ['9876', '4711']) {
    assert.ok(!host.logs.some((l) => l.message.includes(pin)), `${pin} not logged`);
    assert.ok(!answers.some((a) => JSON.stringify(a).includes(pin)), `${pin} not answered`);
  }
}));

test('a refused S-PIN command still counts towards the 5 attempts per 15 minutes', () => withHost({}, async (host, cloud) => {
  const { accountId, vehicleId } = await connected(host, cloud);
  await asAdmin(host, 'PUT', `/accounts/${accountId}/spin`, { spin: '9876' });
  cloud.fail['/vehicle-access/'] = REFUSED;
  assert.equal((await cmd(host, vehicleId, 'lock', {})).status, 502); // attempt 1
  delete cloud.fail['/vehicle-access/'];
  // refused locally while marked: no attempt used
  for (let i = 0; i < 3; i++) assert.equal((await cmd(host, vehicleId, 'lock', {})).json.code, 'SKODA_SPIN_REJECTED');
  await asAdmin(host, 'PUT', `/accounts/${accountId}/spin`, { spin: '4711' });
  for (let i = 0; i < 4; i++) assert.equal((await cmd(host, vehicleId, 'lock', {})).status, 200, `attempt ${i + 2}`);
  assert.equal((await cmd(host, vehicleId, 'lock', {})).json.code, 'SKODA_COMMAND_RATE_LIMIT');
}));

test('401, 429 and 5xx on lock/unlock do not mark the S-PIN', () => withHost({}, async (host, cloud) => {
  const { accountId, vehicleId } = await connected(host, cloud);
  await asAdmin(host, 'PUT', `/accounts/${accountId}/spin`, { spin: '4711' });
  for (const [status, code] of [[401, 'SKODA_UNAUTHORIZED'], [429, 'SKODA_RATE_LIMITED'], [500, 'SKODA_API_ERROR'], [503, 'SKODA_API_ERROR']]) {
    cloud.fail['/vehicle-access/'] = { status, body: { errorCode: 'X', message: 'nope' } };
    const r = await cmd(host, vehicleId, status === 503 ? 'unlock' : 'lock', {});
    assert.equal(r.json.code, code, String(status));
    assert.ok(!/S-PIN/.test(r.json.error), `${status}: no S-PIN hint`);
    assert.equal((await account(host)).spin_rejected, false, String(status));
  }
  delete cloud.fail['/vehicle-access/'];
  const n = spinCalls(cloud);
  assert.equal((await cmd(host, vehicleId, 'lock', {})).status, 200, 'still sent to the cloud');
  assert.equal(spinCalls(cloud), n + 1);
}));

test('no session → SKODA_NO_SESSION (typed 409, nothing sent)', () => withHost({}, async (host, cloud) => {
  const { accountId, vehicleId } = await connected(host, cloud);
  await host.gc.settings.setSecret(`acc.${accountId}.access`, null);
  const n = cloud.commands.length;
  const r = await cmd(host, vehicleId, 'ac_stop', {});
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'SKODA_NO_SESSION');
  assert.equal(cloud.commands.length, n);
}));

test('departure timers: fresh read, only RECURRING slots, type never from the request', () => withHost({}, async (host, cloud) => {
  const { vehicleId } = await connected(host, cloud);
  const ok = await cmd(host, vehicleId, 'timer_set', { id: 1, enabled: false, time: '06:45', days: ['FRIDAY', 'MONDAY', 'MONDAY'], type: 'ONE_OFF' });
  assert.equal(ok.status, 200);
  assert.deepEqual(last(cloud), { method: 'POST', path: `/api/v2/air-conditioning/${VIN}/timers`,
    body: { timers: [{ id: 1, enabled: false, time: '06:45', type: 'RECURRING', selectedDays: ['MONDAY', 'FRIDAY'] }] } });
  assert.equal((await cmd(host, vehicleId, 'timer_set', { id: 2, enabled: true, time: '06:45', days: ['MONDAY'] })).json.code, 'SKODA_TIMER_READONLY');
  assert.equal((await cmd(host, vehicleId, 'timer_set', { id: 7, enabled: true, time: '06:45', days: ['MONDAY'] })).json.code, 'SKODA_TIMER_NOT_FOUND');
  for (const bad of [{ id: '1', enabled: true, time: '06:45', days: ['MONDAY'] }, { id: 1, enabled: 'yes', time: '06:45', days: ['MONDAY'] },
    { id: 1, enabled: true, time: '25:00', days: ['MONDAY'] }, { id: 1, enabled: true, time: '06:45', days: [] }, { id: 1, enabled: true, time: '06:45', days: ['__proto__'] }]) {
    assert.equal((await cmd(host, vehicleId, 'timer_set', bad)).json.code, 'SKODA_VALIDATION', JSON.stringify(bad));
  }
}));

test('a command triggers a refresh of the vehicle once it has applied it (delayed, own 30 s window)', () => withHost({}, async (host, cloud) => {
  const { vehicleId } = await connected(host, cloud);
  const control = require('../server/control');
  assert.equal(control.REFRESH_DELAY_MS, 45 * 1000, 'about 45 s after the command by default');
  const garage = () => cloud.calls.filter((c) => /\/api\/v2\/garage\?/.test(c.url)).length;
  control._setRefreshDelayForTest(80);
  try {
    const n = garage();
    const out = await control.runCommand(host.gc, vehicleId, 'ac_stop', {});
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(garage(), n, 'no sync right after the command (the vehicle still reports the old state)');
    // a second command before the refresh postpones it: both share one sync
    const second = await control.runCommand(host.gc, vehicleId, 'window_heat_stop', {});
    assert.equal(second.refresh, out.refresh);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(garage(), n, 'postponed to 80 ms after the last command');
    await keepAlive(out.refresh);
    assert.equal(garage(), n + 1);
    const again = await control.runCommand(host.gc, vehicleId, 'ac_stop', {});
    assert.equal(await keepAlive(again.refresh), undefined, 'skipped (best effort, no rejection)');
    assert.equal(garage(), n + 1, 'second refresh within 30 s is skipped');
  } finally {
    control._setRefreshDelayForTest(null);
  }
}));

test('expected state: a successful command sets what the vehicle should report until it does or 3 minutes pass', (t) => withHost({}, async (host, cloud) => {
  const { accountId, vehicleId } = await connected(host, cloud);
  const control = require('../server/control');
  const shown = (kind, reported) => control.expectedState(vehicleId, kind, reported);
  assert.equal(shown('climate', 'off'), 'off', 'nothing expected yet');
  for (const [action, args, kind, state] of [['ac_start', { temp: 21 }, 'climate', 'on'], ['ac_stop', {}, 'climate', 'off'],
    ['charge_start', {}, 'charging', 'on'], ['charge_stop', {}, 'charging', 'off'],
    ['window_heat_start', {}, 'windowheat', 'on'], ['window_heat_stop', {}, 'windowheat', 'off']]) {
    await control.runCommand(host.gc, vehicleId, action, args);
    const other = state === 'on' ? 'off' : 'on';
    assert.equal(shown(kind, other), state, action);
    assert.equal(shown(kind, null), state, `${action}: unknown reported state`);
  }
  await asAdmin(host, 'PUT', `/accounts/${accountId}/spin`, { spin: '4711' });
  await control.runCommand(host.gc, vehicleId, 'unlock', {});
  assert.equal(shown('lock', 'on'), 'off');
  await control.runCommand(host.gc, vehicleId, 'lock', {});
  assert.equal(shown('lock', 'off'), 'on');
  // the vehicle reports it → the entry goes (a later different report is shown as it is)
  assert.equal(shown('lock', 'on'), 'on');
  assert.equal(shown('lock', 'off'), 'off');
  // expired after 3 minutes
  await control.runCommand(host.gc, vehicleId, 'ac_start', { temp: 21 });
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + control.EXPECT_MS);
  assert.equal(shown('climate', 'off'), 'off');
  t.mock.restoreAll();
  assert.equal(shown('climate', 'off'), 'off', 'dropped, not only hidden');
  // a failing command or one without a toggle sets nothing
  await control.runCommand(host.gc, vehicleId, 'charge_limit', { limit: 80 });
  cloud.fail['/start-window-heating'] = 500;
  await assert.rejects(control.runCommand(host.gc, vehicleId, 'window_heat_start', {}));
  assert.equal(shown('windowheat', 'off'), 'off');
  control.reset();
  assert.equal(shown('lock', 'off'), 'off');
}));
