'use strict';

// Nuki: hashed token auth (never the plain token in a URL), action and state
// mapping (smart lock 0/3/4/5, opener 2), one request at a time per bridge,
// the Web API (bearer token, action body, log import), errors as codes.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const nuki = require('../server/nuki');
const { withDoor, app, ANNA, ADMIN, BRIDGE_TOKEN, WEB_TOKEN, MIN, fakeBridge } = require('./helpers');

test('hash auth: ts "YYYY-MM-DDTHH:MM:SSZ", rnr, hash = sha256("ts,rnr,token")', () => {
  const at = Date.UTC(2019, 2, 5, 1, 6, 53, 789);
  const a = nuki.hashAuth('abc123', at, 4711);
  assert.equal(a.ts, '2019-03-05T01:06:53Z');
  assert.equal(a.rnr, 4711);
  assert.equal(a.hash, crypto.createHash('sha256').update('2019-03-05T01:06:53Z,4711,abc123').digest('hex'));
  assert.match(a.hash, /^[0-9a-f]{64}$/);
  const b = nuki.hashAuth('abc123', at);
  assert.ok(Number.isInteger(b.rnr) && b.rnr >= 0 && b.rnr <= 65535);
});

test('action mapping: smart lock 1 unlock / 2 lock / 3 unlatch, opener 3 electric strike; nothing else', () => {
  for (const t of [0, 3, 4, 5]) {
    assert.deepEqual([nuki.actionCode(t, 'unlock'), nuki.actionCode(t, 'lock'), nuki.actionCode(t, 'open')], [1, 2, 3]);
    assert.deepEqual(nuki.supportedActions(t), ['lock', 'unlock', 'open']);
  }
  assert.deepEqual([nuki.actionCode(2, 'open'), nuki.actionCode(2, 'lock'), nuki.actionCode(2, 'unlock')], [3, null, null]);
  assert.deepEqual(nuki.supportedActions(2), ['open']);
  assert.equal(nuki.actionCode(0, 'toString'), null);
  assert.equal(nuki.knownType(1), false, 'a Nuki Box is no lock');
  assert.deepEqual([1, 2, 3, 4, 5, 7, 254, 255, 99].map((s) => nuki.stateName(4, s)), ['locked', 'unlocking', 'unlocked', 'locking', 'unlatched', 'unlatching', 'jammed', 'unknown', 'unknown']);
  assert.deepEqual([1, 3, 5, 7].map((s) => nuki.stateName(2, s)), ['online', 'rto_active', 'open', 'opening']);
  assert.deepEqual([1, 2, 3, 4, 240, null].map(nuki.doorName), ['deactivated', 'closed', 'open', 'unknown', 'removed', null]);
});

test('the bridge gets hashed auth only, every request fresh rnr; actions map to the Nuki numbers', () => withDoor({}, async (host, { call, bridge, lockId, openerId }) => {
  assert.equal((await call(app(ANNA), 'POST', `/locks/${lockId}/unlock`)).status, 200);
  assert.equal((await call(app(ANNA), 'POST', `/locks/${lockId}/open`)).status, 200);
  assert.equal((await call(app(ANNA), 'POST', `/locks/${openerId}/open`)).status, 200);
  const acts = bridge.requests.filter((r) => r.path === '/lockAction').map((r) => [r.query.nukiId, r.query.deviceType, r.query.action]);
  assert.deepEqual(acts, [['1001', '4', '1'], ['1001', '4', '3'], ['2002', '2', '3']]);
  assert.equal(bridge.plainTokenSeen, false, 'the plain token never travels in a URL');
  for (const r of bridge.requests) {
    assert.deepEqual(Object.keys(r.query).filter((k) => ['ts', 'rnr', 'hash'].includes(k)).sort(), ['hash', 'rnr', 'ts']);
    assert.equal(r.opts.index, 0);
    assert.ok(r.opts.timeoutMs > 0 && r.opts.timeoutMs <= 30000);
  }
  assert.ok(!JSON.stringify(host.logs).includes(BRIDGE_TOKEN), 'never logged');
}));

test('one request at a time per bridge (the bridge cannot handle parallel requests)', async () => {
  const bridge = fakeBridge({ 1: { deviceType: 0, state: 1 } });
  const gc = { net: { fetchTarget: (id, p, o) => bridge.fetch(p, o) } };
  const b = { id: 1, target_index: 0 };
  const lock = { nuki_id: '1', device_type: 0 };
  await Promise.all([nuki.bridgeList(gc, b, BRIDGE_TOKEN), nuki.bridgeAction(gc, b, BRIDGE_TOKEN, lock, 'unlock'), nuki.bridgeLockState(gc, b, BRIDGE_TOKEN, lock), nuki.bridgeList(gc, b, BRIDGE_TOKEN)]);
  assert.equal(bridge.maxBusy, 1);
  assert.equal(bridge.requests.length, 4);
  await assert.rejects(nuki.bridgeList(gc, b, 'wrong'), { code: 'nuki_auth' });
  await assert.rejects(nuki.bridgeAction(gc, b, BRIDGE_TOKEN, { nuki_id: '1', device_type: 2 }, 'lock'), { code: 'unsupported' });
  bridge.down = true;
  await assert.rejects(nuki.bridgeList(gc, b, BRIDGE_TOKEN), { code: 'lock_unreachable' });
  const denied = { net: { fetchTarget: async () => { throw Object.assign(new Error('target nuki-bridge is not assigned'), { code: 'ERR_NET_DENIED' }); } } };
  await assert.rejects(nuki.bridgeList(denied, b, BRIDGE_TOKEN), { code: 'no_target' });
});

test('a failing lock: history "failed", 502 lock_failed; unreachable bridge → lock_unreachable', () => withDoor({}, async (host, { call, bridge, lockId }) => {
  bridge.failAction = true;
  const r = await call(app(ANNA), 'POST', `/locks/${lockId}/unlock`);
  assert.deepEqual([r.status, r.json.code], [502, 'lock_failed']);
  bridge.failAction = false;
  bridge.down = true;
  const u = await call(app(ANNA), 'POST', `/locks/${lockId}/lock`);
  assert.deepEqual([u.status, u.json.code], [502, 'lock_unreachable']);
  const h = (await call(app(ANNA), 'GET', '/history')).json.items;
  assert.deepEqual(h.slice(0, 2).map((x) => [x.action, x.result, x.reason]), [['lock', 'failed', 'lock_unreachable'], ['unlock', 'failed', 'lock_failed']]);
}));

test('Nuki Web: bearer token, GET /smartlock, POST action, log import of keypad/manual operations; the token is never shown', () => withDoor({ setup: false }, async (host, { admin, call, cloud, clock }) => {
  cloud.web.locks = [{ smartlockId: 17999, type: 4, name: 'Hinten', serverState: 0, state: { state: 1, batteryCritical: false, batteryCharge: 64, doorState: 2 } }];
  assert.equal((await admin('PUT', 'web', { token: 'kurz' })).json.code, 'invalid');
  assert.deepEqual((await admin('PUT', 'web', { token: WEB_TOKEN })).json, { ok: true, web: { hasToken: true } });
  const st = await admin('GET', 'status');
  assert.ok(!JSON.stringify(st.json).includes(WEB_TOKEN));
  assert.deepEqual(st.json.web, { hasToken: true });
  assert.deepEqual((await admin('GET', 'web/devices')).json.devices, [{ nukiId: '17999', deviceType: 4, type: 'smartlock', name: 'Hinten', supported: ['lock', 'unlock', 'open'] }]);
  const l = (await admin('POST', 'locks', { name: 'Hintertür', source: 'web', nukiId: '17999', deviceType: 4, actions: ['lock', 'unlock'], doorSensor: true })).json.lock;
  await admin('PUT', `rights/${ANNA.id}`, { locks: { [l.id]: 'lock' } });
  await host.tick();
  const me = (await call(app(ANNA), 'GET', '/me')).json.locks[0];
  assert.deepEqual([me.state.lock, me.state.door, me.state.batteryPercent], ['locked', 'closed', 64]);
  assert.equal((await call(app(ANNA), 'POST', `/locks/${l.id}/unlock`)).status, 200);
  assert.deepEqual(cloud.web.actions, [{ id: '17999', action: 1 }]);
  assert.ok(cloud.calls.filter((c) => c.url.startsWith('https://api.nuki.io')).every((c) => c.headers.authorization === `Bearer ${WEB_TOKEN}`));
  assert.equal((await call(app(ANNA), 'POST', `/locks/${l.id}/open`)).json.code, 'unsupported', 'open is not configured');
  // log import: keypad (255) and manual (1) — not web/app (4/5, GateControl's own)
  cloud.web.log = [
    { id: 'a1', smartlockId: 17999, action: 1, trigger: 255, name: 'Keypad', date: new Date(Date.now() + MIN).toISOString() },
    { id: 'a2', smartlockId: 17999, action: 2, trigger: 1, name: 'Tür', date: new Date(Date.now() + MIN).toISOString() },
    { id: 'a3', smartlockId: 17999, action: 1, trigger: 4, name: 'Web', date: new Date(Date.now() + MIN).toISOString() },
    { id: 'a0', smartlockId: 17999, action: 1, trigger: 255, name: 'Keypad', date: new Date(Date.now() - 3600000).toISOString() },
  ];
  clock.add(3 * MIN);
  await host.tick();
  await host.tick();
  const hist = (await admin('GET', 'history', null, { kind: 'nuki' })).json.items;
  assert.deepEqual(hist.map((x) => [x.via, x.action]).sort(), [['keypad', 'unlock'], ['nuki', 'lock']], 'once each, nothing before the lock was added');
  assert.ok(!JSON.stringify(host.logs).includes(WEB_TOKEN));
  assert.equal((await admin('GET', 'status')).json.locks[0].state.reachable, true);
  void ADMIN;
}));
