'use strict';

// Remote commands (ported from GateControl's tests/skoda_control.test.js,
// skoda_client_control.test.js, skoda_command_api.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, asAdmin, connected, VIN } = require('./helpers');

const cmd = (host, id, action, args) => asAdmin(host, 'POST', `/vehicles/${id}/command`, { action, args });
const last = (cloud) => cloud.commands.at(-1);

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

test('a command triggers a refresh of the vehicle (own 30 s window)', () => withHost({}, async (host, cloud) => {
  const { vehicleId } = await connected(host, cloud);
  const control = require('../server/control');
  const garage = () => cloud.calls.filter((c) => /\/api\/v2\/garage\?/.test(c.url)).length;
  const n = garage();
  const out = await control.runCommand(host.gc, vehicleId, 'ac_stop', {});
  await out.refresh;
  assert.equal(garage(), n + 1);
  const again = await control.runCommand(host.gc, vehicleId, 'ac_stop', {});
  await again.refresh;
  assert.equal(garage(), n + 1, 'second refresh within 30 s is skipped');
}));
