'use strict';

// 2.2.4 — the brake on automatic logins (server/loginguard.js): a cloud that
// keeps refusing a call must never mean a login per call. A new login only
// when the session really is gone, one at a time, with a growing wait and a
// limit per hour and day that survives a restart; then "connect again".

const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeAc, fakeCloud, fakeDreo, withHost, asAdmin, connectCloud, connectDreo, lineOf } = require('./helpers');
const service = require('../server/service');
const dreoservice = require('../server/dreoservice');
const { createGuard, clock, DEFAULTS } = require('../server/loginguard');

const APPLIANCE = '153931628798542';
const MIN = 60000;
const HOUR = 60 * MIN;

/** Runs `fn(advance)` with the guard's clock under control; `advance(ms)` moves it. */
async function withClock(fn) {
  const real = clock.now;
  let t = Date.UTC(2026, 0, 1);
  clock.now = () => t;
  try { await fn((ms) => { t += ms; }); } finally { clock.now = real; }
}

/** A connected Midea account with one cloud air conditioner → its id. */
async function cloudDevice(host, cloud) {
  await connectCloud(host, cloud);
  return (await asAdmin(host, 'POST', '/devices', { transport: 'cloud', cloud_appliance_id: APPLIANCE })).json.device.id;
}

const stateOf = async (host, id) => (await asAdmin(host, 'GET', `/devices/${id}/state`)).json.state;

test('the guard: wait 1 → 5 → 15 → 60 min, 3 per hour, 6 per day, then blocked; kept in the storage', () => withClock(async (advance) => {
  const kv = new Map();
  const logs = [];
  const gc = { storage: { get: async (k) => (kv.has(k) ? JSON.parse(kv.get(k)) : null), set: async (k, v) => { kv.set(k, JSON.stringify(v)); } }, log: { debug() {}, info() {}, warn: (...a) => logs.push(a.join(' ')) } };
  const blocks = [];
  const guard = createGuard('g', { onBlock: async (g, reason) => { blocks.push(reason); } });
  let logins = 0;
  const tryLogin = () => guard.login(gc, async () => { logins += 1; throw Object.assign(new Error('refused'), { code: 'X' }); }).then(() => null, (e) => e);
  assert.deepEqual(DEFAULTS.backoffMs, [MIN, 5 * MIN, 15 * MIN, HOUR]);
  assert.equal((await tryLogin()).code, 'X');
  assert.deepEqual([(await tryLogin()).code, (await tryLogin()).reason], ['LOGIN_PAUSED', 'wait']);
  assert.equal(logins, 1);
  advance(MIN); assert.equal((await tryLogin()).code, 'X');           // 2nd, then 5 min
  advance(4 * MIN); assert.equal((await tryLogin()).reason, 'wait');
  advance(MIN); assert.equal((await tryLogin()).code, 'X');           // 3rd, then 15 min
  advance(15 * MIN); assert.equal((await tryLogin()).reason, 'hour', 'three in this hour');
  assert.equal(logins, 3);
  // a restart (nothing in memory) changes nothing
  guard.forget();
  assert.equal((await tryLogin()).reason, 'hour');
  advance(HOUR); assert.equal((await tryLogin()).code, 'X');          // 4th, then 60 min
  advance(HOUR); assert.equal((await tryLogin()).code, 'X');          // 5th
  advance(HOUR); assert.equal((await tryLogin()).code, 'X');          // 6th
  advance(HOUR);
  assert.deepEqual(blocks, []);
  assert.equal((await tryLogin()).reason, 'day');
  assert.deepEqual(blocks, ['limit'], 'told once');
  advance(48 * HOUR);
  assert.equal((await tryLogin()).reason, 'blocked', 'stays blocked until a person connects again');
  guard.forget();
  assert.equal((await tryLogin()).reason, 'blocked');
  assert.deepEqual([logins, blocks.length], [6, 1]);
  await guard.manual(gc);
  assert.equal(await guard.login(gc, async () => 'S'), 'S');
  // parallel callers share one login
  let running = 0;
  const slow = () => guard.login(gc, async () => { running += 1; await new Promise((r) => setImmediate(r)); return 'T' + running; });
  advance(2 * HOUR);
  assert.deepEqual(await Promise.all([slow(), slow(), slow()]), ['T1', 'T1', 'T1']);
}));

// The case of the report: an air conditioner was unplugged. The Midea cloud answers its state query with
// an error code of its own (not 3176) — before 2.2.4 a general cloud error, so every look logged in again.
test('a device that is offline in the cloud: never a login, shown as not reachable, asked less and less often', () => {
  const cloud = fakeCloud({ devices: { [APPLIANCE]: fakeAc({ power: true }) } });
  return withHost({ cloud }, async (host) => withClock(async (advance) => {
    const id = await cloudDevice(host, cloud);
    assert.equal((await stateOf(host, id)).power, true);
    advance(2 * MIN);                                  // the cached state is old
    cloud.sendError = ['3123', 'the appliance is off line'];
    const sends = () => cloud.calls.filter((c) => c === '/v1/appliance/transparent/send').length;
    const lists = () => cloud.calls.filter((c) => c === '/v1/appliance/user/list/get').length;
    const d = (await asAdmin(host, 'GET', '/devices')).json.devices.find((x) => x.id === id);
    const asked = [];                                  // seconds at which the cloud was asked for the device
    let last = sends();
    // 30 minutes, a look every 5 seconds: the device's page, the tiles and the apps' quick actions
    for (let sec = 0; sec < 30 * 60; sec += 5) {
      service.cachedState(host.gc, d);
      await service.recentState(host.gc, d, 20);
      const st = await stateOf(host, id);
      if (sec > 0) assert.deepEqual(st, { offline: true });
      if (sends() !== last) { asked.push(sec); last = sends(); }
      advance(5000);
    }
    assert.equal(cloud.logins, 1, 'only the login of the settings — none for the unreachable device');
    assert.deepEqual(asked.slice(0, 6), [0, 30, 90, 210, 510, 810], 'after 30 s, then 1, 2, 5, 5 … minutes');
    assert.equal(asked.length, 9, 'nine questions in 30 minutes instead of one per look');
    assert.equal(lists(), 3, 'the account is asked whether the session works at most every ten minutes');
    assert.deepEqual((await asAdmin(host, 'GET', '/status')).json.devices.map((x) => [x.online, x.checked]), [[false, true]]);
    assert.equal((await asAdmin(host, 'GET', '/status')).json.cloud_needs_reauth, false);
    assert.deepEqual(host.notifications, []);
    const log = host.logs.map((l) => l.message).join('\n');
    assert.match(log, /Midea-Code 3123 \(state\).*no login/);
    assert.match(log, /getState \(cloud\) failed \(offline\) \d+ MIDEA_CLOUD_ERROR: the appliance is off line \(Midea-Code 3123\)/, 'the device line names Midea\'s code');
    assert.ok(!log.includes(cloud.password) && !log.includes('BEARER-'), 'no password or session in the log');
    // plugged in again: seen when its wait is over, with the same session
    cloud.sendError = null;
    advance(5 * MIN);
    assert.equal((await stateOf(host, id)).power, true);
    assert.equal(cloud.logins, 1);
    // … and the wait starts small again; a command always asks at once
    cloud.sendError = ['3123', 'the appliance is off line'];
    advance(2 * MIN);
    await service.recentState(host.gc, d, 20);
    const n = sends();
    advance(31000);
    assert.deepEqual(await stateOf(host, id), { offline: true });
    assert.equal(sends(), n + 1, 'asked again after 30 seconds');
    cloud.sendError = null;
    assert.equal((await asAdmin(host, 'POST', `/devices/${id}/state`, { patch: { power: false } })).json.state.power, false);
    assert.equal(cloud.logins, 1);
  }));
});

test('a cloud that refuses everything for a day: at most 6 automatic logins, then "connect again" and one notification', () => {
  const cloud = fakeCloud({ devices: { [APPLIANCE]: fakeAc() } });
  return withHost({ cloud }, async (host) => withClock(async (advance) => {
    const id = await cloudDevice(host, cloud);
    cloud.sendError = ['3004', 'value is illegal'];
    cloud.listError = ['3004', 'value is illegal'];
    const perHour = [];
    // 24 hours, a look at the device every 20 seconds (portal, apps, admin page)
    for (let h = 0; h < 24; h += 1) {
      const before = cloud.logins;
      for (let i = 0; i < 180; i += 1) {
        assert.deepEqual(await stateOf(host, id), { offline: true });
        advance(20000);
      }
      perHour.push(cloud.logins - before);
    }
    assert.equal(cloud.logins - 1, 6, 'six automatic logins in 24 hours');
    assert.ok(perHour.every((n) => n <= 3), 'never more than three in an hour: ' + perHour.join(','));
    const st = (await asAdmin(host, 'GET', '/status')).json;
    assert.deepEqual([st.cloud_needs_reauth, st.cloud_reauth_reason], [true, 'limit']);
    assert.match(lineOf(await host.settingsStatus(), 'midea').text, /nicht mehr von selbst/);
    assert.deepEqual(host.notifications.map((n) => [n.topic, n.priority]), [['account_reauth', 'high']]);
    assert.match(host.notifications[0].title, /Midea-Konto neu verbinden/);
    // days later: still no login, no request with the refused session, no second notification
    const calls = cloud.calls.length;
    for (let i = 0; i < 50; i += 1) { advance(HOUR); await stateOf(host, id); }
    assert.deepEqual([cloud.logins - 1, cloud.calls.length - calls, host.notifications.length], [6, 0, 1]);
    // saving the settings connects again and lifts the brake
    cloud.sendError = null;
    cloud.listError = null;
    assert.equal(lineOf(await host.saveSettings({ notify_lang: 'de' }), 'midea').tone, 'ok');
    assert.equal((await stateOf(host, id)).power, false);
    assert.equal((await asAdmin(host, 'GET', '/status')).json.cloud_needs_reauth, false);
  }));
});

test('the brake survives a restart', () => {
  const cloud = fakeCloud({ devices: { [APPLIANCE]: fakeAc() } });
  return withHost({ cloud }, async (host) => withClock(async (advance) => {
    const id = await cloudDevice(host, cloud);
    cloud.sendError = ['3004', 'value is illegal'];
    cloud.listError = ['3004', 'value is illegal'];
    await stateOf(host, id);
    assert.equal(cloud.logins, 2, 'one automatic login, which did not help');
    assert.ok((await host.gc.storage.get('cloud_guard')).retryAt > clock.now(), 'the wait is in the storage');
    for (let i = 0; i < 5; i += 1) {
      service.reset();            // a restart: nothing in memory
      await host.start();
      await stateOf(host, id);
    }
    assert.equal(cloud.logins, 2, 'a restart does not log in again');
    // the day's logins are used up → blocked, also after a restart
    for (let i = 0; i < 30; i += 1) { advance(HOUR / 2); service.reset(); await stateOf(host, id); }
    assert.equal(cloud.logins - 1, 6);
    service.reset();
    assert.equal((await asAdmin(host, 'GET', '/status')).json.cloud_needs_reauth, true);
    assert.equal(host.notifications.length, 1);
  }));
});

for (const code of ['3106', '40001']) {
  test(`the session expired (Midea-Code ${code}): exactly one new login, and the call succeeds`, () => {
    const cloud = fakeCloud({ devices: { [APPLIANCE]: fakeAc({ power: true }) } });
    return withHost({ cloud }, async (host) => {
      const id = await cloudDevice(host, cloud);
      cloud.expiredCode = code;
      cloud.expire();
      assert.equal((await stateOf(host, id)).power, true);
      assert.equal(cloud.logins, 2);
      // the new session is kept and used from now on
      service._cache.clear();
      assert.equal((await stateOf(host, id)).power, true);
      assert.equal(cloud.logins, 2);
      assert.equal((await asAdmin(host, 'GET', '/status')).json.cloud_needs_reauth, false);
      assert.deepEqual(host.notifications, []);
    });
  });
}

test('parallel calls with an expired session share one login', () => {
  const devices = {};
  const appliances = [];
  for (let i = 1; i <= 6; i += 1) { devices['90000' + i] = fakeAc(); appliances.push({ id: '90000' + i, sn: 'SN-' + i, name: 'AC ' + i, type: '0xAC', onlineStatus: '1' }); }
  const cloud = fakeCloud({ devices, appliances });
  return withHost({ cloud }, async (host) => {
    await connectCloud(host, cloud);
    const ids = [];
    for (const a of appliances) ids.push((await asAdmin(host, 'POST', '/devices', { transport: 'cloud', cloud_appliance_id: a.id })).json.device.id);
    cloud.expire();
    const states = await Promise.all(ids.map((id) => stateOf(host, id)));
    assert.ok(states.every((s) => s.power === false), JSON.stringify(states));
    assert.equal(cloud.logins, 2, 'one login for six calls');
    // no session at all (lost): again one
    await host.gc.settings.setSecret('cloud.session', null);
    service._cache.clear();
    await Promise.all(ids.map((id) => stateOf(host, id)));
    assert.equal(cloud.logins, 3);
  });
});

test('device offline, no reply and rate limit never log in; a rate limit pauses the cloud calls', () => {
  const dev = fakeAc();
  const cloud = fakeCloud({ devices: { [APPLIANCE]: dev } });
  return withHost({ cloud }, async (host) => withClock(async (advance) => {
    const id = await cloudDevice(host, cloud);
    dev.down = true;                                  // 3176: the device does not answer
    for (let i = 0; i < 10; i += 1) { assert.deepEqual(await stateOf(host, id), { offline: true }); advance(6 * MIN); }
    assert.equal(cloud.logins, 1);
    assert.equal(cloud.calls.filter((c) => c === '/v1/appliance/transparent/send').length, 30, 'asked each time (three tries)');
    assert.ok(!cloud.calls.slice(3).includes('/v1/appliance/user/list/get'), 'not even the account is asked');
    dev.down = false;
    cloud.rateLimited = true;
    assert.deepEqual(await stateOf(host, id), { offline: true });
    const calls = cloud.calls.length;
    cloud.rateLimited = false;
    for (let i = 0; i < 10; i += 1) { assert.deepEqual(await stateOf(host, id), { offline: true }); advance(29000); }
    service._cache.clear();
    assert.deepEqual(await stateOf(host, id), { offline: true });
    assert.equal(cloud.calls.length, calls, 'paused: no request for five minutes');
    assert.equal((await asAdmin(host, 'GET', '/cloud/devices')).json.code, 'MIDEA_CLOUD_RATE_LIMITED');
    advance(5 * MIN);
    service._cache.clear();
    assert.equal((await stateOf(host, id)).power, false);
    assert.equal(cloud.logins, 1);
    assert.equal((await asAdmin(host, 'GET', '/status')).json.cloud_needs_reauth, false);
  }));
});

test('a wrong password is not tried again: "connect again" at once', () => {
  const cloud = fakeCloud({ devices: { [APPLIANCE]: fakeAc() } });
  return withHost({ cloud }, async (host) => {
    const id = await cloudDevice(host, cloud);
    cloud.email = 'moved@example.com';                // the account's sign-in changed at Midea
    cloud.expire();
    for (let i = 0; i < 5; i += 1) assert.deepEqual(await stateOf(host, id), { offline: true });
    assert.equal(cloud.calls.filter((c) => c === '/mj/user/login').length, 2, 'the login of the settings and one refused login');
    const st = (await asAdmin(host, 'GET', '/status')).json;
    assert.deepEqual([st.cloud_needs_reauth, st.cloud_reauth_reason], [true, 'credentials']);
    assert.equal(host.notifications.length, 1);
  });
});

test('Dreo: a cloud that refuses every token logs in at most 6 times a day, then "connect again"', () => {
  const dreo = fakeDreo();
  return withHost({ dreo }, async (host) => withClock(async (advance) => {
    await connectDreo(host, dreo);
    const mine = (await asAdmin(host, 'GET', '/devices')).json.devices.filter((d) => d.vendor === 'dreo');
    assert.ok(mine.length >= 1);
    const base = dreo.logins;
    dreo.refuseAll = true;
    for (let i = 0; i < 24 * 60; i += 1) {
      await dreoservice.getState(host.gc, mine[0]).catch(() => null);
      await asAdmin(host, 'GET', '/dreo/devices');
      advance(MIN);
    }
    assert.equal(dreo.logins - base, 6);
    assert.equal(await dreoservice.reauthReason(host.gc), 'limit');
    assert.deepEqual(host.notifications.filter((n) => n.topic === 'account_reauth').map((n) => n.title), ['Dreo-Konto neu verbinden']);
    assert.match(lineOf(await host.settingsStatus(), 'dreo').text, /nicht mehr von selbst/);
    // a restart keeps it
    dreoservice.reset();
    for (let i = 0; i < 10; i += 1) { advance(HOUR); await asAdmin(host, 'GET', '/dreo/devices'); }
    assert.equal(dreo.logins - base, 6);
    // saving the settings connects again
    dreo.refuseAll = false;
    assert.equal(lineOf(await host.saveSettings({ notify_lang: 'de' }), 'dreo').tone, 'ok');
    assert.equal(await dreoservice.reauthReason(host.gc), null);
  }));
});

// ── The loop of 2.2.3 (reported: sign-in notices first every few minutes, then every 30 seconds) ──
// One session per account, several cloud devices, looks in parallel: before 2.2.4 every device logged
// in for itself, each login ended the session of the one before, the one stored last was often already
// dead — and every device that had tipped to "offline" asked the cloud (and logged in) with every look.

/** `n` cloud air conditioners of a connected account → their ids. */
async function cloudDevices(host, cloud, n) {
  await connectCloud(host, cloud);
  const ids = [];
  for (const a of cloud.appliances.slice(0, n)) ids.push((await asAdmin(host, 'POST', '/devices', { transport: 'cloud', cloud_appliance_id: a.id })).json.device.id);
  return ids;
}

function manyAcs(n) {
  const devices = {};
  const appliances = [];
  for (let i = 1; i <= n; i += 1) { devices['90000' + i] = fakeAc(); appliances.push({ id: '90000' + i, sn: 'SN-' + i, name: 'AC ' + i, type: '0xAC', onlineStatus: '1' }); }
  return { devices, appliances };
}

test('a restart of the plugin does not log in: the stored session is used, also by parallel looks', () => {
  const cloud = fakeCloud({ ...manyAcs(5), singleSession: true });
  return withHost({ cloud }, async (host) => {
    const ids = await cloudDevices(host, cloud, 5);
    for (let i = 0; i < 3; i += 1) {
      service.reset();
      await host.start();
      const states = await Promise.all(ids.map((id) => stateOf(host, id)));
      assert.ok(states.every((s) => s.power === false));
    }
    assert.equal(cloud.logins, 1);
    assert.ok(!cloud.calls.slice(2).includes('/mj/user/login'));
  });
});

test('one session per account, five devices, parallel looks after the session ended: one login, not one per device and look', () => {
  const cloud = fakeCloud({ ...manyAcs(5), singleSession: true });
  return withHost({ cloud }, async (host) => {
    const ids = await cloudDevices(host, cloud, 5);
    cloud.expire();                                   // e.g. the phone app signed in
    for (let round = 0; round < 20; round += 1) {
      const states = await Promise.all(ids.map((id) => stateOf(host, id)));
      assert.ok(states.every((s) => s.power === false), `round ${round}: ${JSON.stringify(states)}`);
      service._cache.clear();                         // the next look asks the cloud again
    }
    assert.equal(cloud.logins, 2, 'one new login for 100 calls');
    // the session in the storage is the one the cloud takes
    service.reset();
    assert.equal((await stateOf(host, ids[0])).power, false);
    assert.equal(cloud.logins, 2);
  });
});

test('a phone app that keeps ending the session: no ping-pong — at most 3 logins an hour, 6 a day', () => {
  const cloud = fakeCloud({ ...manyAcs(3), singleSession: true });
  return withHost({ cloud }, async (host) => withClock(async (advance) => {
    const ids = await cloudDevices(host, cloud, 3);
    const perHour = [];
    for (let h = 0; h < 24; h += 1) {
      const before = cloud.logins;
      for (let i = 0; i < 120; i += 1) {              // a look every 30 seconds
        if (i % 4 === 0) cloud.expire();              // the app signs in every two minutes
        service._cache.clear();
        await Promise.all(ids.map((id) => stateOf(host, id)));
        advance(30000);
      }
      perHour.push(cloud.logins - before);
    }
    assert.equal(cloud.logins - 1, 6);
    assert.ok(perHour.every((n) => n <= 3), perHour.join(','));
    assert.equal((await asAdmin(host, 'GET', '/status')).json.cloud_reauth_reason, 'limit');
    assert.equal(host.notifications.length, 1);
  }));
});

test('tiles, search and quick actions do not ask an offline cloud device with every look', () => {
  const dev = fakeAc();
  const cloud = fakeCloud({ devices: { [APPLIANCE]: dev } });
  return withHost({ cloud }, async (host) => {
    const id = await cloudDevice(host, cloud);
    dev.down = true;
    assert.deepEqual(await stateOf(host, id), { offline: true });
    const d = (await asAdmin(host, 'GET', '/devices')).json.devices.find((x) => x.id === id);
    const calls = cloud.calls.length;
    for (let i = 0; i < 20; i += 1) {
      assert.deepEqual(service.cachedState(host.gc, d), { offline: true });
      assert.deepEqual(await service.recentState(host.gc, d, 50), { offline: true });
    }
    await new Promise((r) => setImmediate(r));
    assert.equal(cloud.calls.length, calls);
    service._cache.get(id).lastAt -= 31000;
    service.cachedState(host.gc, d);
    await service.recentState(host.gc, d, 500);
    assert.ok(cloud.calls.length > calls, 'asked again after 30 seconds');
  });
});
