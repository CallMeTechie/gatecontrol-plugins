'use strict';

// Writes of the background poll (1.2.2). GateControl's protocol of 8. 11.: the snapshot upsert and "UPDATE nas SET
// status = ?, …, last_attempt_at = ?" every poll, ~400 ms each on a slow disk. Now the snapshot and the poll times
// are stored every 5 minutes; the newest are read from memory; a status change is written at once.

const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../server/service');
const store = require('../server/store');
const config = require('../server/config');
const { fakeDsm, withHost, addNas } = require('./helpers');

const MIN = 60000;

test('an hour of polls every 60 s: snapshot and poll times every 5 minutes, the newest in memory; an error at once', async () => {
  const d = fakeDsm('dsm72.json');
  await withHost({ nas: [d], settings: { poll_interval: 60 } }, async (host) => {
    const id = await addNas(host);
    const cfg = await config.load(host.gc);
    const t = Date.now() + MIN;
    host.resetDbWrites();
    for (let m = 0; m < 60; m++) {
      const r = await service.poll(host.gc, await store.getNas(host.gc, id), cfg, { now: t + m * MIN });
      assert.equal(r.ok, true, JSON.stringify(r));
      const n = await store.getNas(host.gc, id);
      assert.equal(n.last_success_at, t + m * MIN, 'the newest poll time is read');
      assert.equal((await store.getSnapshot(host.gc, id)).fetched_at, t + m * MIN, 'the newest snapshot is read');
      assert.equal((await store.allSnapshots(host.gc)).get(id).fetched_at, t + m * MIN);
    }
    const per = 60 / (store.PERSIST_MS / MIN);
    const snaps = host.dbWrites.filter((w) => /INTO snapshots/.test(w.sql || '')).length;
    const nas = host.dbWrites.filter((w) => /UPDATE nas/.test(w.sql || '')).length;
    assert.ok(snaps <= per + 1 && nas <= per + 2, `snapshots ${snaps}, nas ${nas} (before: 60 + 60)`);
    host.resetDbWrites();
    d.state.down = true;
    await service.poll(host.gc, await store.getNas(host.gc, id), cfg, { now: t + 60 * MIN + 1000 });
    assert.equal(host.dbWrites.filter((w) => /UPDATE nas/.test(w.sql || '')).length, 1);
    assert.equal((await host.gc.db.get('SELECT status FROM nas WHERE id = ?', [id])).row.status, 'error');
  });
});
