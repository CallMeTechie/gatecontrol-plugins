'use strict';

// Writes of the background poll (1.1.2). GateControl's protocol of 8. 11.: the snapshot upsert and "UPDATE hosts SET
// status = ?, …, last_attempt_at = ?" every poll (60 s), ~300 ms each on a slow disk. Now the snapshot and the poll
// times are stored every 5 minutes; the newest are read from memory; a status change is written at once.

const test = require('node:test');
const assert = require('node:assert/strict');
const poll = require('../server/poll');
const store = require('../server/store');
const config = require('../server/config');
const { withHost, addHost } = require('./helpers');

const MIN = 60000;

test('an hour of polls every 60 s: snapshot and poll times every 5 minutes, the newest in memory; an error at once', async () => {
  await withHost({}, async (host, fake) => {
    const id = await addHost(host);
    const cfg = config.fromSettings({});
    const t = Date.now() + MIN;
    host.resetDbWrites();
    for (let m = 0; m < 60; m++) {
      const r = await poll.pollHost(host.gc, await store.getHost(host.gc, id), cfg, { now: t + m * MIN });
      assert.equal(r.ok, true);
      const h = await store.getHost(host.gc, id);
      assert.equal(h.last_success_at, t + m * MIN, 'the newest poll time is read');
      assert.equal(h.next_poll_at, t + (m + 1) * MIN);
      assert.equal((await store.snapshotOf(host.gc, id)).at, r.snapshot.at, 'the newest snapshot is read');
    }
    const per = 60 / (store.PERSIST_MS / MIN);
    const snaps = host.dbWrites.filter((w) => /INTO snapshots/.test(w.sql || '')).length;
    const hosts = host.dbWrites.filter((w) => /UPDATE hosts/.test(w.sql || '')).length;
    assert.ok(snaps <= per + 1 && hosts <= per + 1, `snapshots ${snaps}, hosts ${hosts} (before: 60 + 60)`);
    // an error is a change of the status: written at once
    host.resetDbWrites();
    fake.down = true;
    await poll.pollHost(host.gc, await store.getHost(host.gc, id), cfg, { now: t + 60 * MIN + 1000 });
    assert.equal(host.dbWrites.filter((w) => /UPDATE hosts/.test(w.sql || '')).length, 1);
    const row = (await host.gc.db.get('SELECT status, last_attempt_at FROM hosts WHERE id = ?', [id])).row;
    assert.deepEqual([row.status, row.last_attempt_at], ['error', t + 60 * MIN + 1000]);
  });
});
