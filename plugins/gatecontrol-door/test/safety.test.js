'use strict';

// Safety notices (topic door): door open too long, jammed, not reachable
// > 10 min, battery critical (once a day), night check with "Zusperren";
// nothing for a condition already there on the first sighting.

const test = require('node:test');
const assert = require('node:assert/strict');
const safety = require('../server/safety');
const { withDoor, ADMIN, ANNA, MARC, LENA, SEC, MIN, HOUR } = require('./helpers');

const door = (host) => host.notifications.filter((n) => n.topic === 'door');

test('evaluate: first sighting announces nothing (except battery, once a day)', () => {
  const lock = { id: 1, door_sensor: true, open_too_long_min: 5, night_check: null, device_type: 4, state: { reachable: true, state: 'jammed', jammedSince: 1, door: 'open', doorOpenSince: 0, batteryCritical: false } };
  const r = safety.evaluate(null, lock, 10 * MIN, { date: '2026-10-14', minutes: 600 });
  assert.deepEqual(r.notices, []);
  assert.deepEqual(safety.evaluate(r.next, lock, 11 * MIN, { date: '2026-10-14', minutes: 601 }).notices, []);
});

test('door open longer than N minutes → once per opening to people with `lock`', () => withDoor({}, async (host, { bridge, clock }) => {
  bridge.devices[1001].door = 3;
  clock.add(30 * SEC);
  await host.tick();
  clock.add(4 * MIN);
  await host.tick();
  assert.equal(door(host).length, 0);
  clock.add(MIN + SEC);
  await host.tick();
  clock.add(MIN);
  await host.tick();
  assert.deepEqual(door(host).map((n) => [n.title, n.users]), [['Haustür ist seit 5 Minuten offen', [ANNA.id, MARC.id]]]);
  bridge.devices[1001].door = 2;
  clock.add(30 * SEC);
  await host.tick();
  bridge.devices[1001].door = 3;
  clock.add(30 * SEC);
  await host.tick();
  clock.add(6 * MIN);
  await host.tick();
  assert.equal(door(host).length, 2, 'a new opening, a new notice');
}));

test('jammed → admins and `lock` people at once; not reachable > 10 min → once; battery critical → once per day', () => withDoor({}, async (host, { bridge, clock }) => {
  bridge.devices[1001].state = 254;
  clock.add(30 * SEC);
  await host.tick();
  const j = door(host).find((n) => n.title === 'Haustür: Schloss blockiert');
  assert.deepEqual([j.users, j.priority], [[ADMIN.id, ANNA.id, MARC.id], 'high']);
  bridge.devices[1001].state = 1;
  bridge.down = true;
  for (let i = 0; i < 22; i++) { clock.add(30 * SEC); await host.tick(); }
  const u = door(host).filter((n) => n.title === 'Haustür ist nicht erreichbar');
  assert.equal(u.length, 1);
  assert.ok(u[0].users.includes(ADMIN.id) && !u[0].users.includes(LENA.id));
  bridge.down = false;
  bridge.devices[1001].batteryCritical = true;
  for (let i = 0; i < 4; i++) { clock.add(HOUR); await host.tick(); }
  assert.equal(door(host).filter((n) => n.title === 'Haustür: Batterie fast leer').length, 1);
  clock.add(24 * HOUR);
  await host.tick();
  assert.equal(door(host).filter((n) => n.title === 'Haustür: Batterie fast leer').length, 2, 'the next day again');
}));

test('night check: at 22:00 (local) the lock is unlocked → push with the quick action "Zusperren"; once per night; off-able', () => withDoor({}, async (host, { bridge, clock, admin, lockId }) => {
  bridge.devices[1001].state = 3;
  clock.set(Date.UTC(2026, 9, 14, 19, 59, 0)); // 21:59 CEST
  await host.tick();
  assert.equal(door(host).length, 0);
  clock.add(MIN + SEC);
  await host.tick();
  clock.add(MIN);
  await host.tick();
  const n = door(host);
  assert.equal(n.length, 1);
  assert.equal(n[0].title, 'Haustür ist noch aufgesperrt');
  assert.deepEqual(n[0].users, [ANNA.id, MARC.id]);
  assert.deepEqual(n[0].data.actions[0], { type: 'quick_action', label: 'Zusperren', plugin: 'gatecontrol-door', id: `${lockId}:lock` });
  // the button runs the normal quick action (Marc has `lock`)
  assert.equal((await host.runQuickAction(MARC, `${lockId}:lock`, 'de', { via: 'notification' })).body.ok, true);
  assert.equal((await admin('PATCH', `locks/${lockId}`, { nightCheck: null })).json.lock.nightCheck, null);
  bridge.devices[1001].state = 3;
  clock.add(24 * HOUR);
  await host.tick();
  assert.equal(door(host).length, 1, 'off');
}));
