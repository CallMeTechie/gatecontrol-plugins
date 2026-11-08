'use strict';

// Writes of the background poll (1.7.1). GateControl's protocol of 8. 11.: COMMIT 190 times an hour and kv.set, ~300 ms
// each on a slow disk — every poll (30 s) wrote the state of every lock, changed or not, and the Ring status every
// minute. Now an unchanged lock only moves its times on in memory (stored every 5 minutes), a change is written at once.

const test = require('node:test');
const assert = require('node:assert/strict');
const locks = require('../server/locks');
const { withDoor, SEC, MIN } = require('./helpers');

const lockWrites = (host) => host.dbWrites.filter((w) => w.kind === 'commit' || /lock_state/.test(w.sql || ''));

test('an hour of polls of two unchanged locks: lock_state every 5 minutes, not every 30 s; the times stay fresh', () => withDoor({}, async (host, { clock, lockId }) => {
  host.resetDbWrites();
  for (let i = 0; i < 120; i++) {
    clock.add(30 * SEC);
    await host.tick();
    const l = await locks.get(host.gc, lockId);
    assert.equal(l.state.checkedAt, clock.now(), 'checkedAt is the last poll');
    assert.equal(l.state.updatedAt, clock.now());
  }
  const n = lockWrites(host).length;
  // two locks, 60 minutes, one write per 5 minutes each (before: 240)
  assert.ok(n <= 2 * (60 / (locks.PERSIST_MS / MIN)) + 2, `lock_state writes in the hour: ${n}`);
  assert.ok(host.dbWrites.length <= n + 2, JSON.stringify(host.dbWrites.filter((w) => !lockWrites(host).includes(w))));
}));

test('a change is written at the next poll', () => withDoor({}, async (host, { clock, bridge, lockId }) => {
  clock.add(30 * SEC);
  await host.tick();
  host.resetDbWrites();
  bridge.devices[1001].state = 3; // unlocked
  clock.add(30 * SEC);
  await host.tick();
  assert.equal(lockWrites(host).length, 1);
  const row = (await host.gc.db.get('SELECT state, checked_at FROM lock_state WHERE lock_id = ?', [lockId])).row;
  assert.deepEqual([row.state, row.checked_at], ['unlocked', clock.now()]);
}));
