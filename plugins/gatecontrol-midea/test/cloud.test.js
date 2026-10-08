'use strict';

// The Midea cloud account and cloud devices: login through the host's fetch
// (only the declared Midea hosts), the password/session as secrets, the
// appliance list, adding and controlling a cloud device, the state cache,
// 2FA / rate limit / unreachable devices.

const test = require('node:test');
const assert = require('node:assert/strict');
const { internetAllowed } = require('../../../tools/testing/mock-host');
const manifest = require('../plugin.json');
const { fakeAc, fakeCloud, withHost, asAdmin, asPortal, connectCloud, ADMIN } = require('./helpers');

const APPLIANCE = '153931628798542';

test('plugin.json: internet only to the Midea cloud hosts', () => {
  const list = manifest.permissions.network.internet;
  assert.ok(internetAllowed(list, 'https://mp-prod.appsmb.com/mas/v5/app/proxy?alias=/v1/user/login/id/get'));
  assert.ok(internetAllowed(list, 'https://mapp.appsmb.com/v1/user/login'));
  assert.ok(!internetAllowed(list, 'https://example.com/'));
  assert.ok(!internetAllowed(list, 'http://mp-prod.appsmb.com:8080/'));
});

test('connect: the password and session become secrets, never shown; wrong input is refused', () => {
  const cloud = fakeCloud();
  return withHost({ cloud }, async (host) => {
    assert.equal((await asAdmin(host, 'POST', '/cloud/connect', { email: cloud.email })).json.code, 'MIDEA_EMAIL_PASSWORD_REQUIRED');
    assert.equal((await asAdmin(host, 'POST', '/cloud/connect', { email: cloud.email, password: 'x', app: 'other' })).json.code, 'MIDEA_INVALID');
    const bad = await asAdmin(host, 'POST', '/cloud/connect', { email: 'nobody@example.com', password: 'x' });
    assert.equal(bad.status, 502);
    assert.match(bad.json.detail, /Midea-Code 3101/);
    await connectCloud(host, cloud);
    assert.equal(await host.gc.settings.get('cloud.password'), cloud.password);
    assert.ok(host.secrets.has('cloud.password') && host.secrets.has('cloud.session'));
    const st = (await asAdmin(host, 'GET', '/cloud')).json.cloud;
    assert.deepEqual(st, { app: 'msmarthome', email: cloud.email, password_set: true, session_active: true, configured: true });
    const all = JSON.stringify([(await asAdmin(host, 'GET', '/status')).json, st, host.logs]);
    assert.ok(!all.includes(cloud.password) && !all.includes('BEARER-'), 'no password or session outside the secrets');
    assert.ok(host.fetches.every((f) => f.url.startsWith('https://mp-prod.appsmb.com/')));
  });
});

test('2FA and rate limit are reported like before; the reauth banner flag follows', () => {
  const dev = fakeAc();
  const cloud = fakeCloud({ devices: { [APPLIANCE]: dev } });
  return withHost({ cloud }, async (host) => {
    cloud.require2fa = true;
    const r = await asAdmin(host, 'POST', '/cloud/connect', { email: cloud.email, password: cloud.password });
    assert.deepEqual([r.status, r.json.code], [409, 'MIDEA_CLOUD_2FA_REQUIRED']);
    cloud.require2fa = false;
    await connectCloud(host, cloud);
    const id = (await asAdmin(host, 'POST', '/devices', { transport: 'cloud', cloud_appliance_id: APPLIANCE })).json.device.id;
    // the session expires and the new login needs 2FA → offline + reauth flag
    await host.gc.settings.setSecret('cloud.session', null);
    cloud.require2fa = true;
    assert.deepEqual((await asAdmin(host, 'GET', `/devices/${id}/state`)).json.state, { offline: true });
    assert.equal((await asAdmin(host, 'GET', '/status')).json.cloud_needs_reauth, true);
    cloud.require2fa = false;
    assert.equal((await asAdmin(host, 'GET', `/devices/${id}/state`)).json.state.power, false);
    assert.equal((await asAdmin(host, 'GET', '/status')).json.cloud_needs_reauth, false);
    cloud.rateLimited = true;
    const rl = await asAdmin(host, 'GET', '/cloud/devices');
    assert.deepEqual([rl.status, rl.json.code], [429, 'MIDEA_CLOUD_RATE_LIMITED']);
  });
});

test('cloud devices: list, add, control (read-modify-write), cache, offline', () => {
  const dev = fakeAc({ power: false, targetTemp: 23, mode: 'auto' });
  const cloud = fakeCloud({ devices: { [APPLIANCE]: dev } });
  return withHost({ cloud }, async (host) => {
    assert.equal((await asAdmin(host, 'GET', '/cloud/devices')).json.code, 'MIDEA_CLOUD_NOT_CONFIGURED');
    await connectCloud(host, cloud);
    const list = (await asAdmin(host, 'GET', '/cloud/devices')).json.devices;
    assert.deepEqual(list, [{ sn: 'SN-CLOUD-1', name: 'Wohnzimmer', type: '0xAC', id: APPLIANCE, online: true }]);
    assert.equal((await asAdmin(host, 'POST', '/devices', { transport: 'cloud' })).json.code, 'MIDEA_INVALID');
    const add = await asAdmin(host, 'POST', '/devices', { transport: 'cloud', cloud_appliance_id: APPLIANCE, name: 'Wohnzimmer' });
    assert.equal(add.status, 200);
    assert.deepEqual([add.json.device.device_sn, add.json.device.transport, add.json.device.cloud_appliance_id], ['cloud-' + APPLIANCE, 'cloud', APPLIANCE]);
    assert.equal((await asAdmin(host, 'POST', '/devices', { transport: 'cloud', cloud_appliance_id: APPLIANCE })).json.code, 'MIDEA_DEVICE_EXISTS');
    const id = add.json.device.id;

    const set = await asAdmin(host, 'POST', `/devices/${id}/state`, { patch: { power: true, targetTemp: 21, mode: 'cool', fanSpeed: 102, eco: true } });
    assert.equal(set.status, 200);
    assert.deepEqual([set.json.state.power, set.json.state.targetTemp, set.json.state.mode, set.json.state.fanSpeed, set.json.state.eco], [true, 21, 'cool', 102, true]);
    assert.deepEqual([dev.state.power, dev.state.targetTemp, dev.state.mode], [true, 21, 'cool']);

    // served from the cache: no cloud round trip, no re-login
    const before = cloud.calls.length;
    const st = await asAdmin(host, 'GET', `/devices/${id}/state`);
    assert.equal(st.json.state.targetTemp, 21);
    assert.equal(cloud.calls.length, before);
    assert.equal(cloud.logins, 1, 'the stored session is reused');

    // the device does not answer (3176 three times) → offline, never an error page
    dev.down = true;
    const off = await asAdmin(host, 'POST', `/devices/${id}/state`, { patch: { power: false } });
    assert.deepEqual(off.json.state, { offline: true });
    // the background run never polls cloud devices
    const n = cloud.calls.length;
    await host.tick();
    assert.equal(cloud.calls.length, n);
    // a portal viewer is refused on the admin API
    assert.equal((await asPortal(host, ADMIN, 'GET', '/devices')).status, 403);
  });
});
