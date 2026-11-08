'use strict';

// Writes of the sync (1.6.2): a known vehicle with the same name and model and the same account status ('ok' after
// every sync) are not written again — on a slow disk every write took ~300 ms.

const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../server/store');
const { createHost } = require('../../../tools/testing/mock-host');
const path = require('node:path');

test('the same vehicle and the same status again: no write; a change is written', async () => {
  const host = await createHost(path.join(__dirname, '..'), {});
  try {
    await host.start();
    await host.gc.db.run("INSERT INTO accounts (email, status) VALUES ('a@b.de', 'ok')");
    const aid = (await host.gc.db.get('SELECT id FROM accounts')).row.id;
    const entry = { vin: 'TMBJJ7NE0L0000001', name: 'Enyaq', specification: { model: 'Enyaq iV 80' } };
    const first = await store.upsertVehicle(host.gc, aid, entry);
    host.resetDbWrites();
    for (let i = 0; i < 10; i++) {
      assert.deepEqual(await store.upsertVehicle(host.gc, aid, entry), first);
      await store.setStatus(host.gc, aid, 'ok', null, { backoffMin: 0, nextRetryAt: null });
    }
    assert.deepEqual(host.dbWrites, [], 'ten syncs, nothing new: no write');
    host.resetDbWrites();
    await store.upsertVehicle(host.gc, aid, { ...entry, name: 'Familienauto' });
    await store.setStatus(host.gc, aid, 'error', 'SKODA_HTTP: 500');
    assert.equal(host.dbWrites.length, 2);
  } finally { await host.close(); }
});
