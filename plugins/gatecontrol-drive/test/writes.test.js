'use strict';

// Writes of the home cache bookkeeping (1.27.1): the "dirty" mark was written again with every change that touches the
// stock (offline, seats, settings) — a write of the same value. Now only a changed value is written.
//
// 1.29.1 — the statements GateControl's protocol named most often as slow writes on a slow disk, each written only when
// something changed (host.dbWrites: what the host's database worker commits; cost.record: the statements sent at all):
//   * meta housekeeping_at: in the database once an hour, not every 5 minutes — the housekeeping runs as before
//   * the home cache: what a run offered and withdrew in one transaction (not a write per file); „more to do“ and
//     „failed, again in a minute“ are remembered by the process (no writes to meta); the time of the run once, in
//     the state; a run that fails like the one before it writes nothing
//   * devices „last seen“: no statement at all within 10 minutes of the write (it waited for the write lock with every
//     request of an app although it changed nothing)

const test = require('node:test');
const assert = require('node:assert/strict');
const homecache = require('../server/homecache');
const jobs = require('../server/jobs');
const { SELDOM_RETRY_MS } = require('../server/util');
const cost = require('../../../tools/testing/sql-cost');
const { withHost, ANNA, MARC, MIN } = require('./helpers');

const metaWrites = (host, key) => host.dbWrites.filter((w) => /INTO meta/.test(w.sql || '') && (!key || new RegExp(key).test(w.sql)));
// the writes of the home cache's bookkeeping (not the housekeeping's own note, once an hour)
const hcWrites = (host) => host.dbWrites.filter((w) => !/housekeeping_at/.test(w.sql || '') && w.kind !== 'kv.set');
const metaOf = async (host, key) => { const r = (await host.gc.db.get('SELECT value FROM meta WHERE key = ?', [key])).row; return r ? r.value : null; };
const HC = { gatecontrol: '1.231.0', homeCache: {} };

test('the dirty mark again and again: one write', async () => {
  await withHost({}, async (host) => {
    await host.gc.db.run("INSERT INTO meta (key, value) VALUES ('home_cache_dirty', '0') ON CONFLICT(key) DO UPDATE SET value = '0'");
    host.resetDbWrites();
    for (let i = 0; i < 20; i++) await homecache.touch(host.gc);
    assert.equal(host.dbWrites.filter((w) => /INTO meta/.test(w.sql || '')).length, 1);
    assert.equal((await host.gc.db.get("SELECT value FROM meta WHERE key = 'home_cache_dirty'")).row.value, '1');
  });
});

test('the housekeeping runs every 5 minutes; its time is written once an hour and read again after a restart', async () => {
  await withHost({}, async (host, c) => {
    await host.tick();
    const t0 = Date.now();
    assert.equal(await metaOf(host, 'housekeeping_at'), String(t0));
    host.resetDbWrites();
    let ran = 0;
    // 59 minutes of background runs, one a minute
    for (let i = 1; i <= 59; i++) {
      c.clock.add(MIN);
      const out = await host.tick();
      if (out.housekeeping !== false) ran++;
      assert.equal(out.housekeeping !== false, i % 5 === 0, `minute ${i}`);
    }
    assert.equal(ran, 11);
    assert.deepEqual(host.dbWrites, [], 'an hour without anything to do: no write at all');
    assert.equal(await metaOf(host, 'housekeeping_at'), String(t0));
    // the hour is over: the next housekeeping notes its time
    c.clock.add(MIN);
    assert.notEqual((await host.tick()).housekeeping, false);
    assert.equal(host.dbWrites.length, 1);
    assert.equal(await metaOf(host, 'housekeeping_at'), String(t0 + jobs.HOUSEKEEPING_NOTE_MS));
    // a restart of the plugin (another handle on the same database) two minutes later: the stored time counts — no
    // housekeeping before its 5 minutes are over, then at once, and no write within the hour
    const restarted = { ...host.gc };
    host.resetDbWrites();
    c.clock.add(2 * MIN);
    assert.equal((await jobs.tick(restarted, Date.now())).housekeeping, false);
    c.clock.add(3 * MIN);
    assert.notEqual((await jobs.tick(restarted, Date.now())).housekeeping, false);
    // a restart 20 minutes after the note (three housekeepings later, none written down): one housekeeping at once
    c.clock.add(15 * MIN);
    assert.notEqual((await jobs.tick({ ...host.gc }, Date.now())).housekeeping, false);
    assert.deepEqual(metaWrites(host, 'housekeeping_at'), []);
    // a clock set back counts as due and is noted (as before)
    c.clock.add(-3 * 3600000);
    assert.notEqual((await host.tick()).housekeeping, false);
    assert.equal(await metaOf(host, 'housekeeping_at'), String(Date.now()));
  });
});

test('the home cache: a run writes its offers in one transaction and its time once; nothing to do: only the time', async () => {
  await withHost(HC, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const nodes = [];
    for (let i = 0; i < 25; i++) {
      const n = (await c.put(ANNA, mine.rootId, `f${i}.txt`, `file ${i}`)).json.node;
      assert.equal((await a('PUT', `nodes/${n.id}/offline`)).status, 200);
      nodes.push(n);
    }
    assert.equal(await metaOf(host, 'home_cache_dirty'), '1');
    c.clock.add(MIN);
    host.resetDbWrites();
    let r = (await host.tick()).homeCache;
    assert.deepEqual([r.offered, r.withdrawn, r.more], [25, 0, false]);
    assert.equal(host.homeCache.offers.size, 25);
    // 1.29.0: 25 writes of home_cache and 3 of meta. Now: the 25 rows in one transaction; dirty off; the state
    assert.deepEqual(host.dbWrites.filter((w) => /home_cache\b/.test(w.sql || '')), [], 'no write of home_cache of its own');
    assert.deepEqual(host.dbWrites.filter((w) => w.kind === 'commit').map((w) => w.changes), [25]);
    assert.equal(metaWrites(host, 'VALUES \\(\\?, \\?\\)').length, 2, JSON.stringify(host.dbWrites));
    assert.equal(hcWrites(host).length, 3);
    assert.equal(await metaOf(host, 'home_cache_dirty'), '0');
    const state = JSON.parse(await metaOf(host, 'home_cache_state'));
    assert.deepEqual([state.at, state.files, state.error], [Date.now(), 25, null]);
    assert.equal((await host.gc.db.get('SELECT COUNT(*) AS n FROM home_cache WHERE offered = 1')).row.n, 25);
    // the minutes until the next run: not due — nothing written, nothing asked of GateControl
    host.resetDbWrites();
    const calls = host.homeCache.calls.length;
    for (let i = 0; i < 14; i++) { c.clock.add(MIN); assert.deepEqual((await host.tick()).homeCache, { skipped: 'not_due' }); }
    assert.deepEqual(host.dbWrites.filter((w) => /home_cache/.test(w.sql || '')), []);
    assert.equal(host.homeCache.calls.length, calls);
    // the run after 15 minutes, nothing changed: its time in the state — one write
    c.clock.add(MIN);
    host.resetDbWrites();
    r = (await host.tick()).homeCache;
    assert.deepEqual([r.offered, r.unchanged], [0, 25]);
    assert.equal(hcWrites(host).length, 1, JSON.stringify(host.dbWrites));
    assert.equal(JSON.parse(await metaOf(host, 'home_cache_state')).at, Date.now());
    assert.equal((await c.admin('GET', 'admin/overview')).json.overview.homeCache.lastRunAt, new Date().toISOString());
    // three files into the trash, one new: withdrawn and offered in one transaction
    for (const n of nodes.slice(0, 3)) assert.equal((await a('DELETE', `nodes/${n.id}`)).status, 200);
    const p = (await c.put(ANNA, mine.rootId, 'neu.txt', 'new file')).json.node;
    await a('PUT', `nodes/${p.id}/offline`);
    c.clock.add(MIN);
    host.resetDbWrites();
    r = (await host.tick()).homeCache;
    assert.deepEqual([r.offered, r.withdrawn], [1, 3]);
    assert.deepEqual(host.dbWrites.filter((w) => w.kind === 'commit').map((w) => w.changes), [4]);
    assert.equal((await host.gc.db.get('SELECT COUNT(*) AS n FROM home_cache')).row.n, 23);
    // a restart of the plugin: the run comes 15 minutes after the stored one, not before
    const restarted = { ...host.gc };
    c.clock.add(10 * MIN);
    assert.deepEqual(await homecache.tick(restarted, Date.now()), { skipped: 'not_due' });
    c.clock.add(6 * MIN);
    assert.equal((await homecache.tick(restarted, Date.now())).unchanged, 23);
  });
});

test('the home cache: „more to do“ and a run that fails come again the next minute without a write to meta for it', async () => {
  let refuse = false;
  await withHost({ ...HC, homeCache: { fail: (op) => (refuse && op === 'offer' ? 'ERR_RATE_LIMIT' : null) } }, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const keep = homecache.LIMITS.calls;
    try {
      for (let i = 0; i < 7; i++) {
        const n = (await c.put(ANNA, mine.rootId, `g${i}.txt`, `g ${i}`)).json.node;
        await a('PUT', `nodes/${n.id}/offline`);
      }
      homecache.LIMITS.calls = 3;
      c.clock.add(MIN);
      let r = (await host.tick()).homeCache;
      assert.deepEqual([r.offered, r.more], [3, true]);
      assert.equal(await metaOf(host, 'home_cache_dirty'), '0');
      // the rest, a minute each: no dirty mark is written for it (1.29.0: off and on again every run)
      host.resetDbWrites();
      c.clock.add(MIN);
      r = (await host.tick()).homeCache;
      assert.deepEqual([r.offered, r.more], [3, true]);
      c.clock.add(MIN);
      r = (await host.tick()).homeCache;
      assert.deepEqual([r.offered, r.more], [1, false]);
      assert.deepEqual(metaWrites(host, 'home_cache_dirty'), []);
      assert.equal(hcWrites(host).filter((w) => /INTO meta/.test(w.sql || '')).length, 2, 'the state of the two runs');
      assert.deepEqual(host.dbWrites.filter((w) => w.kind === 'commit').map((w) => w.changes), [3, 1]);
      c.clock.add(MIN);
      assert.deepEqual((await host.tick()).homeCache, { skipped: 'not_due' });
      // GateControl refuses for ten minutes: tried every minute, said once
      homecache.LIMITS.calls = keep;
      const n = (await c.put(ANNA, mine.rootId, 'h.txt', 'hhh')).json.node;
      await a('PUT', `nodes/${n.id}/offline`);
      refuse = true;
      host.resetDbWrites();
      const offers = () => host.homeCache.calls.filter((x) => x.op === 'offer').length;
      const before = offers();
      for (let i = 0; i < 10; i++) { c.clock.add(MIN); assert.deepEqual((await host.tick()).homeCache, { error: 'ERR_RATE_LIMIT' }); }
      assert.equal(offers() - before, 10, 'asked again every minute');
      // dirty off once (the pin had set it), the state with the error once
      assert.deepEqual(hcWrites(host).map((w) => (/INTO meta/.test(w.sql || '') ? 'meta' : w.kind)), ['meta', 'meta'], JSON.stringify(host.dbWrites));
      const ov = (await c.admin('GET', 'admin/overview')).json.overview.homeCache;
      assert.deepEqual([ov.files, ov.error], [7, 'ERR_RATE_LIMIT']);
      // still failing after 15 minutes: the state once more (its time)
      for (let i = 0; i < 6; i++) { c.clock.add(MIN); await host.tick(); }
      assert.equal(hcWrites(host).length, 3);
      // GateControl takes offers again: the next minute
      refuse = false;
      c.clock.add(MIN);
      r = (await host.tick()).homeCache;
      assert.deepEqual([r.offered, r.unchanged, r.more], [1, 7, false]);
      assert.equal((await c.admin('GET', 'admin/overview')).json.overview.homeCache.error, null);
    } finally { homecache.LIMITS.calls = keep; }
  });
});

test('„last seen“ of a device: one statement and one write in 10 minutes, not one with every request', async () => {
  await withHost({}, async (host, c) => {
    const phone = c.as(ANNA, 'phone-a');
    const seen = async () => (await host.gc.db.get('SELECT last_seen FROM devices WHERE user_id = ? AND device_id = ?', [ANNA.id, 'phone-a'])).row.last_seen;
    const deviceWrites = () => host.dbWrites.filter((w) => /INTO devices|UPDATE user_devices/.test(w.sql || ''));
    assert.equal((await phone('GET', 'me')).status, 200);
    const t0 = Date.now();
    assert.equal(await seen(), t0);
    assert.equal((await phone('PUT', 'devices/pc-1', { name: 'PC', platform: 'windows' })).status, 200);
    host.resetDbWrites();
    // 9 minutes of requests, one every 15 seconds
    const rec = await cost.record(async () => {
      for (let i = 0; i < 36; i++) { c.clock.add(15000); assert.equal((await phone('GET', 'me')).status, 200); }
    });
    assert.deepEqual(deviceWrites(), []);
    assert.equal(rec.count(/^INSERT INTO devices/), 0, 'the table of the devices is not asked again');
    // the registered device (its row was written by PUT devices/pc-1, not by this statement): asked once a minute
    assert.ok(rec.count(/^UPDATE user_devices SET last_seen/) <= Math.ceil((9 * MIN) / SELDOM_RETRY_MS) + 1, `${rec.count(/^UPDATE user_devices SET last_seen/)} statements for the registered device`);
    assert.equal(await seen(), t0);
    // 10 minutes after the write: seen again — both rows, once
    c.clock.add(MIN);
    await phone('GET', 'me');
    assert.equal(await seen(), Date.now());
    c.clock.add(MIN);
    await phone('GET', 'me');
    assert.equal(deviceWrites().length, 2, JSON.stringify(host.dbWrites));
    const pc = (await phone('GET', 'devices')).json.devices.find((x) => x.id === 'pc-1');
    assert.ok(Date.now() - Date.parse(pc.lastSeen) <= MIN + SELDOM_RETRY_MS, `the registered device was seen at ${pc.lastSeen}`);
    // another device and another person have their own rows, at once
    host.resetDbWrites();
    await c.as(ANNA, 'tablet-a')('GET', 'me');
    await c.as(MARC, 'phone-a')('GET', 'me');
    assert.equal(host.dbWrites.filter((w) => /INTO devices/.test(w.sql || '')).length, 2);
    // „delete on all devices“ still counts every device seen
    assert.equal((await host.gc.db.get('SELECT COUNT(*) AS n FROM devices WHERE user_id = ?', [ANNA.id])).row.n, 2);
  });
});
