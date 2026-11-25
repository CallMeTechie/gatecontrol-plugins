'use strict';

// The Jellyfin admin client against the answers recorded from real Jellyfin 10.9.11, 10.10.7 and 10.11.11 (spike M0).

const test = require('node:test');
const assert = require('node:assert/strict');
const jf = require('../server/jellyfin');
const { createJellyfin, fixture, KEY } = require('./jellyfin-mock');

/** A gc with only gc.net.fetchTarget over the test Jellyfin. */
function gcOf(jelly) {
  return { net: { fetchTarget: (id, p, o) => { assert.equal(id, 'jellyfin'); return jelly.fetch(p, o); } } };
}

for (const version of ['10.9.11', '10.10.7', '10.11.11']) {
  test(`Jellyfin ${version}: what the spike recorded`, async () => {
    const fx = fixture(version);
    assert.equal(fx.recordedWith, version);
    // the API key confirms a code for another user (200 true), unknown code 404, the same code again 500, off 401
    assert.deepEqual(fx.statuses, { quickConnectDisabledInitiate: 401, authorizeUnknownCode: 404, authorizeOk: 200, authorizeTwice: 500,
      deviceDelete: 204, tokenAfterDelete: 401, devicesWithUserToken: 403 });
    assert.equal(fx.configuration.QuickConnectAvailable, true, 'Quick Connect is on by default');
    assert.equal(fx.device.Name, 'GateControl · Pixel von Mila', 'the device name arrives URL-decoded');
    assert.match(fx.device.Id, /^gc-[A-Za-z0-9]{20}$/);
  });

  test(`Jellyfin ${version}: client calls`, async () => {
    const jelly = createJellyfin(version);
    const gc = gcOf(jelly);
    const info = await jf.publicInfo(gc, 0);
    assert.equal(info.version, version);
    assert.equal(info.versionOk, true);
    assert.equal((await jf.checkKey(gc, 0, KEY)).version, version);
    await assert.rejects(jf.checkKey(gc, 0, 'wrongwrongwrongwrong'), { code: 'key_invalid' });
    const users = await jf.users(gc, 0, KEY);
    assert.equal(users.find((u) => u.name === 'admin').admin, true);
    assert.equal(users.find((u) => u.name === 'mila').admin, false);
    assert.equal(await jf.quickConnectEnabled(gc, 0), true);
    // a device starts Quick Connect, the plugin confirms it for mila
    const code = jelly.initiate('gc-AAAAAAAAAAAAAAAAAAAA', 'GateControl · TV');
    assert.equal(await jf.authorize(gc, 0, KEY, code, jelly.userId('mila')), true);
    await assert.rejects(jf.authorize(gc, 0, KEY, code, jelly.userId('mila')), { code: 'code_invalid' }, 'a code is confirmed once');
    await assert.rejects(jf.authorize(gc, 0, KEY, '000000', jelly.userId('mila')), { code: 'code_invalid' });
    const d = await jf.device(gc, 0, KEY, 'gc-AAAAAAAAAAAAAAAAAAAA');
    assert.equal(d.userId, jelly.userId('mila'));
    assert.equal(d.userName, 'mila');
    assert.equal(await jf.deleteDevice(gc, 0, KEY, 'gc-AAAAAAAAAAAAAAAAAAAA'), true);
    assert.equal(await jf.deleteDevice(gc, 0, KEY, 'gc-AAAAAAAAAAAAAAAAAAAA'), false, '404 for a device that is gone');
    assert.equal(await jf.device(gc, 0, KEY, 'gc-AAAAAAAAAAAAAAAAAAAA'), null);
    // Quick Connect off through the configuration → Authorize 401 → quick_connect_off
    await jf.setQuickConnect(gc, 0, KEY, false);
    assert.equal(await jf.quickConnectEnabled(gc, 0), false);
    const code2 = String(123456);
    jelly.state.requests.set(code2, { deviceId: 'gc-B', deviceName: 'x', authorized: null });
    await assert.rejects(jf.authorize(gc, 0, KEY, code2, jelly.userId('mila')), { code: 'quick_connect_off' });
    await jf.setQuickConnect(gc, 0, KEY, true);
    // a new user, and the same name again
    const u = await jf.createUser(gc, 0, KEY, 'paul');
    assert.equal(u.admin, false);
    await assert.rejects(jf.createUser(gc, 0, KEY, 'paul'), { code: 'name_taken' });
    // no network
    jelly.state.down = true;
    await assert.rejects(jf.publicInfo(gc, 0), { code: 'jellyfin_unreachable' });
  });
}

test('versions and the Authorization header', () => {
  assert.equal(jf.versionOk('10.8.13'), false);
  assert.equal(jf.versionOk('10.9.0'), true);
  assert.equal(jf.versionOk('12.1.0'), true);
  assert.equal(jf.versionOk('kaputt'), false);
  const h = jf.authHeader('abc"def');
  assert.match(h, /^MediaBrowser Client="GateControl", Device="GateControl%20Server", DeviceId="gatecontrol-server", Version="1\.0\.0", Token="abcdef"$/);
});
