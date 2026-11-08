'use strict';

// Writes of the home cache bookkeeping (1.27.1): the "dirty" mark was written again with every change that touches the
// stock (offline, seats, settings) — a write of the same value. Now only a changed value is written.

const test = require('node:test');
const assert = require('node:assert/strict');
const homecache = require('../server/homecache');
const { withHost } = require('./helpers');

test('the dirty mark again and again: one write', async () => {
  await withHost({}, async (host) => {
    await host.gc.db.run("INSERT INTO meta (key, value) VALUES ('home_cache_dirty', '0') ON CONFLICT(key) DO UPDATE SET value = '0'");
    host.resetDbWrites();
    for (let i = 0; i < 20; i++) await homecache.touch(host.gc);
    assert.equal(host.dbWrites.filter((w) => /INTO meta/.test(w.sql || '')).length, 1);
    assert.equal((await host.gc.db.get("SELECT value FROM meta WHERE key = 'home_cache_dirty'")).row.value, '1');
  });
});
