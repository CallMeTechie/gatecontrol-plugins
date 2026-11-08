'use strict';

// Writes of the reminder check (1.5.1). GateControl's protocol of 8. 11.: kv.set of the reminder state on every check
// (a minute), ~300 ms each on a slow disk — the state held the time of the check. Now a check that finds nothing new
// stores the state at most every 10 minutes; what was sent is stored at once.

const test = require('node:test');
const assert = require('node:assert/strict');
const alerts = require('../server/alerts');
const { withHost } = require('./helpers');

test('an hour of checks every minute, nothing due: the state at most every 10 minutes', async () => {
  await withHost({}, async (host) => {
    const t = Date.now();
    await alerts.check(host.gc, { now: t }); // first run
    host.resetDbWrites();
    for (let m = 1; m <= 60; m++) await alerts.check(host.gc, { now: t + m * 60000 });
    const n = host.dbWrites.filter((w) => w.kind === 'kv.set').length;
    assert.ok(n >= 5 && n <= 6, `kv.set in the hour: ${n} (before: 60)`);
  });
});
