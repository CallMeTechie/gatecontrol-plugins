'use strict';

// Transitional states that do not end (1.0.1, owner's report: "Haustür" shown
// as "Öffnet …" for good). The bridge's /list (cached lastKnownState) and Nuki
// Web's /smartlock can stay on unlocking / locking / unlatching: the bridge
// lock is asked directly (/lockState after 30 s, ≤ 1 per 60 s), the web lock
// is read again (GET /smartlock/{id} after 60 s, ≤ 1 per 2 min); after 3 min
// the last stable state is shown with stale: true — never used as "locked"
// for an automatic unlock (state_unclear). The admin page shows the raw code.

const test = require('node:test');
const assert = require('node:assert/strict');
const nuki = require('../server/nuki');
const { withDoor, app, ANNA, BRIDGE_TOKEN, WEB_TOKEN, SEC, MIN } = require('./helpers');

const FAMILIE = { automation: true, via: 'gatecontrol-familie' };
const lockStates = (bridge) => bridge.requests.filter((r) => r.path === '/lockState').length;
const shown = async (call, lockId) => (await call(app(ANNA), 'GET', '/me')).json.locks.find((l) => l.id === lockId).state;
const diag = async (admin, lockId) => (await admin('GET', 'status')).json.locks.find((l) => l.id === lockId).diag;

/** Advance the clock and run one background tick (a poll every 30 s). */
async function step(host, clock, ms = 30 * SEC) {
  clock.add(ms);
  await host.tick();
}

test('transitional states: smart lock unlocking/locking/unlatching, opener opening/boot_run', () => {
  assert.deepEqual([2, 4, 7, 1, 3, 5, 254].map((c) => nuki.isTransitional(nuki.stateName(4, c))), [true, true, true, false, false, false, false]);
  assert.deepEqual([7, 253, 1, 3, 5].map((c) => nuki.isTransitional(nuki.stateName(2, c))), [true, true, false, false, false]);
});

test('bridge: /list stuck on 7 (unlatching) for ≥ 30 s → /lockState asks the lock; its state is saved and shown', () => withDoor({}, async (host, { call, admin, bridge, clock, lockId }) => {
  assert.equal((await shown(call, lockId)).lock, 'locked');
  // opened at the keypad: the lock is unlocked again, the bridge's cache stays on "unlatching"
  bridge.devices[1001].state = 3;
  bridge.devices[1001].listState = 7;
  await step(host, clock);
  assert.deepEqual([(await shown(call, lockId)).lock, lockStates(bridge)], ['unlatching', 0], 'not before 30 s');
  await step(host, clock);
  assert.equal(lockStates(bridge), 1, '/lockState after 30 s of the same transitional state');
  const q = bridge.requests.filter((r) => r.path === '/lockState')[0].query;
  assert.deepEqual([q.nukiId, q.deviceType], ['1001', '4']);
  assert.deepEqual(await shown(call, lockId), { lock: 'unlocked', stale: false, door: 'closed', batteryCritical: false, batteryPercent: 80, batteryCharging: false, reachable: true, updatedAt: new Date(clock.now()).toISOString().replace(/\.\d{3}Z$/, 'Z') });
  const d = await diag(admin, lockId);
  assert.deepEqual([d.source, d.nukiState, d.via, d.listNukiState, d.stale], ['bridge', 3, 'lockState', 7, false]);
  const msg = host.logs.filter((l) => l.level === 'debug' && /transitional state refreshed/.test(l.message));
  assert.equal(msg.length, 1);
  assert.match(msg[0].message, /bridge 7 -> 3/);
  assert.ok(!JSON.stringify(host.logs).includes(BRIDGE_TOKEN), 'never the token');
  // the cache stays stuck: the lock's answer stands; asked again at most once per 60 s
  await step(host, clock);
  assert.deepEqual([(await shown(call, lockId)).lock, lockStates(bridge)], ['unlocked', 1]);
  await step(host, clock);
  assert.deepEqual([(await shown(call, lockId)).lock, lockStates(bridge)], ['unlocked', 2]);
  // locked at the lock meanwhile → the next re-read shows it
  bridge.devices[1001].state = 1;
  await step(host, clock);
  assert.equal(lockStates(bridge), 2);
  await step(host, clock);
  assert.deepEqual([(await shown(call, lockId)).lock, lockStates(bridge)], ['locked', 3]);
  // the bridge's cache recovers → /list again, no more /lockState
  delete bridge.devices[1001].listState;
  for (let i = 0; i < 4; i++) await step(host, clock);
  assert.deepEqual([(await shown(call, lockId)).lock, lockStates(bridge)], ['locked', 3]);
  assert.equal((await diag(admin, lockId)).via, 'list');
}));

test('bridge: /lockState fails → the /list state for that poll, the next try only after 60 s', () => withDoor({}, async (host, { call, admin, bridge, clock, lockId }) => {
  bridge.devices[1001].state = 3;
  bridge.devices[1001].listState = 7;
  bridge.failLockState = true;
  await step(host, clock);
  await step(host, clock);
  assert.deepEqual([(await shown(call, lockId)).lock, lockStates(bridge)], ['unlatching', 1], 'old behaviour for that poll');
  assert.equal((await shown(call, lockId)).reachable, true);
  assert.ok(host.logs.some((l) => l.level === 'debug' && /re-read failed/.test(l.message)));
  bridge.failLockState = false;
  await step(host, clock);
  assert.deepEqual([(await shown(call, lockId)).lock, lockStates(bridge)], ['unlatching', 1], 'rate limit: once per 60 s per lock');
  await step(host, clock);
  assert.deepEqual([(await shown(call, lockId)).lock, lockStates(bridge)], ['unlocked', 2]);
  // the opener (another lock on the same bridge) was never asked
  assert.ok(bridge.requests.filter((r) => r.path === '/lockState').every((r) => r.query.nukiId === '1001'));
  void admin;
}));

test('still transitional after 3 min → the last stable state with stale: true (app, portal, tiles, quick actions); automation refuses state_unclear', () => withDoor({}, async (host, { call, admin, bridge, clock, lockId }) => {
  assert.equal((await admin('PUT', `rights/${ANNA.id}`, { autoUnlock: true })).status, 200);
  // the lock itself keeps reporting "unlatching" (also to /lockState)
  bridge.devices[1001].state = 7;
  await step(host, clock);
  const since = clock.now();
  assert.deepEqual([(await shown(call, lockId)).lock, (await shown(call, lockId)).stale], ['unlatching', false]);
  // not yet 3 min: the real state counts → not locked
  let r = await host.runQuickAction(ANNA, `${lockId}:unlock`, 'de', FAMILIE);
  assert.equal(r.body.ok, false);
  assert.equal((await call(app(ANNA), 'GET', '/history')).json.items[0].reason, 'not_locked');
  while (clock.now() - since < 3 * MIN - 30 * SEC) await step(host, clock);
  assert.equal((await shown(call, lockId)).lock, 'unlatching', 'still shown before 3 min');
  assert.ok(lockStates(bridge) >= 2, 'the lock was asked meanwhile');
  await step(host, clock);
  const s = await shown(call, lockId);
  assert.deepEqual([s.lock, s.stale, s.reachable], ['locked', true, true], 'the last stable state, flagged');
  // portal tab tile and the apps' quick action subtitle
  const tile = (await host.portalTiles(ANNA)).find((x) => x.title === 'Haustür');
  assert.deepEqual([tile.value, tile.state], ['Zustand unklar – zuletzt: Zugesperrt', 'warn']);
  assert.equal((await host.portalTiles(ANNA, 'en')).find((x) => x.title === 'Haustür').value, 'State unclear – last: Locked');
  const qa = (await host.quickActions(ANNA)).find((x) => x.id === `${lockId}:lock`);
  assert.equal(qa.subtitle, 'Zustand unklar – zuletzt: Zugesperrt');
  // admin diagnostics: the raw code Nuki reports
  const d = await diag(admin, lockId);
  assert.deepEqual([d.source, d.nukiState, d.stale, d.stableState], ['bridge', 7, true, 'locked']);
  assert.ok(d.movingSince && d.updatedAt);
  // an automatic unlock never treats the stale state as "locked"
  const before = bridge.requests.filter((x) => x.path === '/lockAction').length;
  r = await host.runQuickAction(ANNA, `${lockId}:unlock`, 'de', FAMILIE);
  assert.equal(r.body.ok, false);
  const h = (await call(app(ANNA), 'GET', '/history')).json.items[0];
  assert.deepEqual([h.result, h.reason, h.reasonText], ['refused', 'state_unclear', 'Zustand des Schlosses unklar (meldet seit Minuten „in Bewegung“)']);
  const n = host.notifications.filter((x) => x.topic === 'auto').pop();
  assert.equal(n.data.door.reason, 'state_unclear');
  assert.equal(bridge.requests.filter((x) => x.path === '/lockAction').length, before, 'nothing reached the lock');
  // a person in the app may still act (they see the state is unclear)
  assert.equal((await call(app(ANNA), 'POST', `/locks/${lockId}/lock`)).status, 200);
  assert.deepEqual([(await shown(call, lockId)).lock, (await shown(call, lockId)).stale], ['locked', false]);
}));

test('stale state of an opener (boot_run) → the last stable state; a state that ends clears the flag', () => withDoor({}, async (host, { call, bridge, clock, openerId }) => {
  assert.equal((await shown(call, openerId)).lock, 'online');
  bridge.devices[2002].state = 253;
  for (let i = 0; i < 7; i++) await step(host, clock);
  assert.deepEqual([(await shown(call, openerId)).lock, (await shown(call, openerId)).stale], ['online', true]);
  bridge.devices[2002].state = 1;
  await step(host, clock);
  assert.deepEqual([(await shown(call, openerId)).lock, (await shown(call, openerId)).stale], ['online', false]);
}));

test('Nuki Web: /smartlock stuck on 7 for ≥ 60 s → GET /smartlock/{id} (≤ 1 per 2 min); its state is saved', () => withDoor({ setup: false }, async (host, { admin, call, cloud, clock }) => {
  const entry = (state) => ({ smartlockId: 17999, type: 4, name: 'Hinten', serverState: 0, state: { state, batteryCritical: false, batteryCharge: 64, doorState: 2 } });
  cloud.web.locks = [entry(1)];
  await admin('PUT', 'web', { token: WEB_TOKEN });
  const l = (await admin('POST', 'locks', { name: 'Hintertür', source: 'web', nukiId: '17999', deviceType: 4, actions: ['lock', 'unlock'], doorSensor: true })).json.lock;
  await admin('PUT', `rights/${ANNA.id}`, { locks: { [l.id]: 'lock' } });
  await host.tick();
  assert.equal((await shown(call, l.id)).lock, 'locked');
  const single = () => cloud.calls.filter((c) => c.url === 'https://api.nuki.io/smartlock/17999' && c.method === 'GET').length;
  cloud.web.locks = [entry(7)];
  cloud.web.fresh['17999'] = entry(3);
  await step(host, clock);
  await step(host, clock);
  assert.deepEqual([(await shown(call, l.id)).lock, single()], ['unlatching', 0], 'not before 60 s');
  await step(host, clock);
  assert.deepEqual([(await shown(call, l.id)).lock, single()], ['unlocked', 1]);
  const d = await diag(admin, l.id);
  assert.deepEqual([d.source, d.nukiState, d.via, d.listNukiState], ['web', 3, 'smartlock_id', 7]);
  assert.ok(host.logs.some((x) => x.level === 'debug' && /transitional state refreshed .*web 7 -> 3/.test(x.message)));
  for (let i = 0; i < 3; i++) await step(host, clock);
  assert.deepEqual([(await shown(call, l.id)).lock, single()], ['unlocked', 1], 'at most once per 2 min');
  await step(host, clock);
  assert.equal(single(), 2);
  // the cloud catches up → the overview again
  cloud.web.locks = [entry(1)];
  await step(host, clock);
  assert.deepEqual([(await shown(call, l.id)).lock, (await diag(admin, l.id)).via], ['locked', 'smartlock']);
  assert.ok(!JSON.stringify(host.logs).includes(WEB_TOKEN), 'never the token');
}));

test('Nuki Web stays transitional (also read again) → stale after 3 min, last stable state', () => withDoor({ setup: false }, async (host, { admin, call, cloud, clock }) => {
  const entry = (state) => ({ smartlockId: 17999, type: 4, name: 'Hinten', serverState: 0, state: { state, batteryCritical: false, batteryCharge: 64, doorState: 2 } });
  cloud.web.locks = [entry(3)];
  await admin('PUT', 'web', { token: WEB_TOKEN });
  const l = (await admin('POST', 'locks', { name: 'Hintertür', source: 'web', nukiId: '17999', deviceType: 4, actions: ['lock', 'unlock'] })).json.lock;
  await admin('PUT', `rights/${ANNA.id}`, { locks: { [l.id]: 'lock' } });
  await host.tick();
  cloud.web.locks = [entry(2)];
  for (let i = 0; i < 6; i++) await step(host, clock);
  assert.deepEqual([(await shown(call, l.id)).lock, (await shown(call, l.id)).stale], ['unlocking', false]);
  await step(host, clock);
  assert.deepEqual([(await shown(call, l.id)).lock, (await shown(call, l.id)).stale], ['unlocked', true]);
  const d = await diag(admin, l.id);
  assert.deepEqual([d.nukiState, d.stale, d.stableState], [2, true, 'unlocked']);
}));
