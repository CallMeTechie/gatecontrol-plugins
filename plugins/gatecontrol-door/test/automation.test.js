'use strict';

// Automatic unlock on arrival: another plugin (Familie's rule "Person kommt
// heim") runs <lock>:unlock as the person with automation: true. Accepted only
// when all conditions hold; each refusal reason is written to the history and
// pushed (topic auto). After a success: push with "Wieder zusperren", and the
// safety net locks again after 3 min when the door sensor did not report
// "open" (without a sensor a push asks instead).

const test = require('node:test');
const assert = require('node:assert/strict');
const { withDoor, app, ANNA, MARC, LENA, MIN, SEC } = require('./helpers');

const FAMILIE = { automation: true, via: 'gatecontrol-familie' };
const auto = (host, user, id) => host.runQuickAction(user, id, 'de', FAMILIE);

async function optIn(admin, u, on = true) {
  assert.equal((await admin('PUT', `rights/${u.id}`, { autoUnlock: on })).status, 200);
}

function lastAuto(host) {
  const n = host.notifications.filter((x) => x.topic === 'auto');
  return n[n.length - 1];
}

test('automation listing: unlock and lock for people with `lock` — never open; nothing for `view`', () => withDoor({}, async (host, { lockId }) => {
  const list = async (u) => (await host.runQuickAction(u, 'x', 'de', FAMILIE), host.plugin.quickActions({ user: { ...u, portal: true, loggedIn: true, automation: true, via: 'gatecontrol-familie' }, lang: 'de' }, host.gc));
  assert.deepEqual((await list(ANNA)).map((a) => a.id), [`${lockId}:lock`, `${lockId}:unlock`]);
  assert.deepEqual((await list(MARC)).map((a) => a.id), [`${lockId}:lock`, `${lockId}:unlock`]);
  assert.deepEqual(await list(LENA), []);
  assert.equal((await auto(host, ANNA, `${lockId}:open`)).status, 404, 'open is not even listed for automation');
}));

test('refused: no opt-in, open, time window, 10-min gap, not locked, door open, unreachable — each with history and push', () => withDoor({}, async (host, { admin, call, lockId, bridge, clock }) => {
  const reason = async (expect) => {
    const r = await auto(host, ANNA, `${lockId}:unlock`);
    assert.equal(r.body.ok, false, expect);
    const h = (await call(app(ANNA), 'GET', '/history')).json.items[0];
    assert.deepEqual([h.via, h.caller, h.result, h.reason], ['automation', 'gatecontrol-familie', 'refused', expect]);
    const n = lastAuto(host);
    assert.equal(n.users[0], ANNA.id);
    assert.match(n.title, /^Automatisches Aufsperren abgelehnt: /);
    assert.equal(n.data.door.reason, expect);
    return r;
  };
  // 1. no opt-in
  await reason('auto_off');
  // open/unlatch is never automatic (direct hook call with a forged id)
  await optIn(admin, ANNA);
  const forged = await host.plugin.runQuickAction({ user: { ...ANNA, portal: true, loggedIn: true, automation: true, via: 'gatecontrol-familie' }, lang: 'de', id: `${lockId}:open`, via: 'gatecontrol-familie', automation: true }, host.gc);
  assert.equal(forged.ok, false);
  assert.equal((await call(app(ANNA), 'GET', '/history')).json.items[0].reason, 'auto_open');
  // 2. time window (Wednesday 10:00 local; window from 11:00)
  await admin('PUT', `rights/${ANNA.id}`, { window: { days: [3], from: '11:00', to: '12:00' } });
  await reason('outside_window');
  await admin('PUT', `rights/${ANNA.id}`, { window: null });
  // 3. not locked
  bridge.devices[1001].state = 3;
  clock.add(20 * SEC);
  await reason('not_locked');
  // 4. door open (sensor)
  bridge.devices[1001].state = 1;
  bridge.devices[1001].door = 3;
  clock.add(20 * SEC);
  await reason('door_open');
  // 5. unreachable
  bridge.devices[1001].door = 2;
  bridge.down = true;
  clock.add(20 * SEC);
  await reason('unreachable');
  bridge.down = false;
  clock.add(20 * SEC);
  // success, then 6. at most once per 10 minutes per person and lock
  assert.equal((await auto(host, ANNA, `${lockId}:unlock`)).body.ok, true);
  bridge.devices[1001].state = 1;
  clock.add(5 * MIN);
  await reason('auto_too_soon');
  clock.add(6 * MIN);
  assert.equal((await auto(host, ANNA, `${lockId}:unlock`)).body.ok, true);
  assert.equal(bridge.requests.filter((r) => r.path === '/lockAction').length, 2, 'only the two accepted runs reached the lock');
}));

test('Marc (`lock`, no opt-in) → refused auto_off; Lena (`view`) cannot even list it', () => withDoor({}, async (host, { lockId }) => {
  assert.equal((await auto(host, MARC, `${lockId}:unlock`)).body.ok, false);
  assert.equal(lastAuto(host).data.door.reason, 'auto_off');
  assert.equal((await auto(host, LENA, `${lockId}:unlock`)).status, 404);
}));

test('success: push "automatisch aufgesperrt" with the quick action "Wieder zusperren"; door not opened → locked again after 3 min', () => withDoor({}, async (host, { admin, call, lockId, bridge, clock }) => {
  await optIn(admin, ANNA);
  const r = await auto(host, ANNA, `${lockId}:unlock`);
  assert.deepEqual(r.body, { ok: true, unchanged: false, message: 'Haustür aufgesperrt', state: null, widget: null });
  assert.equal(bridge.devices[1001].state, 3);
  const n = lastAuto(host);
  assert.equal(n.title, 'Haustür automatisch aufgesperrt');
  assert.deepEqual(n.data.actions[0], { type: 'quick_action', label: 'Wieder zusperren', plugin: 'gatecontrol-door', id: `${lockId}:lock` });
  assert.equal(n.data.actions[0].auth, undefined, 'no device auth for locking');
  for (let i = 0; i < 17; i++) { clock.add(10 * SEC); await host.tick(); }
  assert.equal(bridge.devices[1001].state, 3, 'not yet after 2:50');
  clock.add(15 * SEC);
  await host.tick();
  assert.equal(bridge.devices[1001].state, 1, 'locked again');
  assert.equal(lastAuto(host).title, 'Haustür wieder zugesperrt');
  const h = (await call(app(ANNA), 'GET', '/history')).json.items[0];
  assert.deepEqual([h.action, h.via, h.result, h.reason], ['lock', 'system', 'ok', 'auto_relock']);
  const count = host.notifications.length;
  clock.add(5 * MIN);
  await host.tick();
  assert.equal(host.notifications.length, count, 'once');
}));

test('the door opened after the automatic unlock → no re-lock', () => withDoor({}, async (host, { admin, lockId, bridge, clock }) => {
  await optIn(admin, ANNA);
  await auto(host, ANNA, `${lockId}:unlock`);
  clock.add(40 * SEC);
  bridge.devices[1001].door = 3;
  await host.tick();
  bridge.devices[1001].door = 2;
  clock.add(4 * MIN);
  await host.tick();
  await host.tick();
  assert.equal(bridge.devices[1001].state, 3, 'stays unlocked (the person went in)');
  assert.ok(!host.notifications.some((x) => x.title === 'Haustür wieder zugesperrt'));
}));

test('without a door sensor: the door state is not checked, after 3 min a push asks (with "Zusperren")', () => withDoor({ doorSensor: false }, async (host, { admin, lockId, bridge, clock }) => {
  await optIn(admin, ANNA);
  bridge.devices[1001].door = 3; // a sensor value the plugin ignores without the sensor being configured
  assert.equal((await auto(host, ANNA, `${lockId}:unlock`)).body.ok, true);
  assert.equal(lastAuto(host).body, 'Willkommen zuhause.');
  clock.add(3 * MIN + SEC);
  await host.tick();
  const n = lastAuto(host);
  assert.equal(n.title, 'Haustür ist noch aufgesperrt');
  assert.deepEqual(n.data.actions[0], { type: 'quick_action', label: 'Zusperren', plugin: 'gatecontrol-door', id: `${lockId}:lock` });
  assert.equal(bridge.devices[1001].state, 3, 'not locked by itself');
}));
