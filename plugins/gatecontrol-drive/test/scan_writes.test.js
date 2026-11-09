'use strict';

// Writes of the virus scan's states (1.28.1, server/scan.js). The nightly scan of GateControl sends the hook
// mediaScanned once per file — hundreds in minutes, nearly all "clean" again. Before: one upsert per file, each a write
// of its own; with a stalling disk up to 8 s each, and the hooks piled up host calls until GateControl answered
// ERR_BUSY ("scan state failed ERR_BUSY", one warning per file). Now: queued, one transaction per batch, unchanged
// results write nothing, a busy database is tried again after a short pause or the files wait for the next run — one
// line per run, none per file.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA } = require('./helpers');
const scan = require('../server/scan');
const store = require('../server/store');

const mediaScanWrites = (host) => host.dbWrites.filter((w) => w.kind === 'statement' && /media_scan/.test(w.sql || ''));
const commits = (host) => host.dbWrites.filter((w) => w.kind === 'commit');

/** 30 clean files in Anna's folder → nodes */
async function files(c, n = 30) {
  const mine = await c.area(ANNA, 'mine');
  const out = [];
  for (let i = 0; i < n; i++) out.push((await c.put(ANNA, mine.rootId, `datei-${i}.txt`, `Inhalt ${i}`)).json.node);
  return out;
}

/** store.run answers `err` for the upserts of media_scan the first `times` times. */
function busyUpserts(t, times, err) {
  const orig = store.run;
  let left = times;
  t.mock.method(store, 'run', (gc, sql, params) => {
    if (left > 0 && /^INSERT INTO media_scan/.test(sql)) { left--; return Promise.reject(err()); }
    return orig(gc, sql, params);
  });
  return { left: () => left };
}

test('the nightly re-check: results that come together are one transaction; the same results again write nothing', async () => {
  await withHost({ scan: () => ({ state: 'clean' }) }, async (host, c) => {
    const list = await files(c);
    const seq = (await c.as(ANNA)('GET', 'me')).json.latest;
    host.resetDbWrites();
    // new signatures: ten of them are malware now, the others clean again (as the host sends them: at once)
    await Promise.all(list.map((n, i) => host.mediaScanned(n.mediaId, i < 10 ? { state: 'infected', finding: 'Win.Trojan.Agent-1' } : { state: 'clean' })));
    assert.deepEqual(mediaScanWrites(host), [], 'no upsert of its own outside a transaction');
    assert.equal(commits(host).length, 1, JSON.stringify(host.dbWrites));
    const node = (await c.as(ANNA)('GET', `nodes/${list[3].id}`)).json.node;
    assert.deepEqual(node.scan, { state: 'infected', blocked: true, finding: 'Win.Trojan.Agent-1' });
    assert.equal((await c.as(ANNA)('GET', `nodes/${list[20].id}`)).json.node.scan.state, 'clean');
    const ch = (await c.as(ANNA)('GET', 'changes', null, { since: seq })).json.changes;
    assert.equal(ch.filter((x) => x.op === 'scan').length, 10, 'only the changed files in the change log');
    // the next night: the same results — no write at all
    host.resetDbWrites();
    await Promise.all(list.map((n, i) => host.mediaScanned(n.mediaId, i < 10 ? { state: 'infected', finding: 'Win.Trojan.Agent-1' } : { state: 'clean' })));
    for (const n of list.slice(10, 20)) await host.mediaScanned(n.mediaId, { state: 'clean' });
    assert.deepEqual(host.dbWrites, []);
    // opening a file asks the host again (check): the same state writes nothing either
    assert.equal((await c.as(ANNA)('GET', `nodes/${list[20].id}/content`)).status, 200);
    assert.deepEqual(mediaScanWrites(host), []);
    assert.ok(!host.logs.some((l) => /scan state/.test(l.message)), JSON.stringify(host.logs));
  });
});

test('ERR_BUSY: the batch is tried again after a short pause — written, no warning per file', async (t) => {
  scan._setWaitsForTest({ waits: [1, 1, 1], deferMs: 5 });
  t.after(() => scan._setWaitsForTest());
  await withHost({ scan: () => ({ state: 'clean' }) }, async (host, c) => {
    const list = await files(c, 5);
    const busy = busyUpserts(t, 2, () => Object.assign(new Error('too many concurrent host calls'), { code: 'ERR_BUSY' }));
    await Promise.all(list.map((n) => host.mediaScanned(n.mediaId, { state: 'unscannable', blocked: false, finding: 'encrypted' })));
    assert.equal(busy.left(), 0, 'it was busy');
    for (const n of list) assert.equal((await c.as(ANNA)('GET', `nodes/${n.id}`)).json.node.scan.state, 'unscannable');
    assert.ok(!host.logs.some((l) => /scan state/.test(l.message)), JSON.stringify(host.logs));
  });
});

test('still busy (SQLITE_BUSY): the files wait for the next run — one line for the run, none per file', async (t) => {
  scan._setWaitsForTest({ waits: [1, 1], deferMs: 5 });
  t.after(() => scan._setWaitsForTest());
  await withHost({ scan: () => ({ state: 'clean' }) }, async (host, c) => {
    const list = await files(c, 6);
    // three tries of the first run fail, the next run gets through
    busyUpserts(t, 3, () => Object.assign(new Error('SQLITE_BUSY: database is locked'), { code: 'ERR_DB' }));
    await Promise.all(list.map((n) => host.mediaScanned(n.mediaId, { state: 'infected', finding: 'Eicar-Test-Signature' })));
    // the hooks did not wait for the next run; it comes by itself
    await scan.flush();
    for (const n of list) assert.equal((await c.as(ANNA)('GET', `nodes/${n.id}`)).json.node.scan.state, 'infected');
    const lines = host.logs.filter((l) => /scan state/.test(l.message));
    assert.equal(lines.length, 1, JSON.stringify(host.logs));
    assert.equal(lines[0].level, 'info');
    assert.match(lines[0].message, /^scan states deferred \(database busy\) .*"deferred":6,"dropped":0/);
  });
});

test('another error: one warning for the batch, not one per file; the next results are written again', async (t) => {
  await withHost({ scan: () => ({ state: 'clean' }) }, async (host, c) => {
    const list = await files(c, 4);
    busyUpserts(t, 1, () => Object.assign(new Error('disk I/O error'), { code: 'ERR_DB' }));
    await Promise.all(list.map((n) => host.mediaScanned(n.mediaId, { state: 'infected', finding: 'X' })));
    const lines = host.logs.filter((l) => /scan state/.test(l.message));
    assert.equal(lines.length, 1, JSON.stringify(host.logs));
    assert.match(lines[0].message, /^scan state failed ERR_DB \{"files":4\}$/);
    await host.mediaScanned(list[0].mediaId, { state: 'infected', finding: 'X' });
    assert.equal((await c.as(ANNA)('GET', `nodes/${list[0].id}`)).json.node.scan.state, 'infected');
  });
});

test('more than one batch: BATCH_MAX results a transaction, a statement takes at most 100 parameters', async () => {
  const seen = [];
  const rows = new Map();
  let open = false;
  let commitsSeen = 0;
  const gc = {
    log: { warn() {}, info() {} },
    db: {
      exec: async (sql) => { if (/^BEGIN/.test(sql)) open = true; else if (/^COMMIT/.test(sql)) { open = false; commitsSeen++; } },
      query: async (sql, params) => { seen.push(params.length); return { rows: /FROM media_scan/.test(sql) ? params.filter((id) => rows.has(id)).map((id) => rows.get(id)) : [] }; },
      get: async () => ({ row: null }),
      run: async (sql, params) => {
        seen.push(params.length);
        assert.ok(open, 'inside the transaction');
        for (let i = 0; i < params.length; i += 5) rows.set(params[i], { media_id: params[i], state: params[i + 1], blocked: params[i + 2], finding: params[i + 3] });
        return { changes: params.length / 5 };
      },
    },
  };
  const ids = Array.from({ length: scan.BATCH_MAX + 50 }, (_, i) => i.toString(16).padStart(32, '0'));
  await Promise.all(ids.map((mediaId) => scan.scanned(gc, { mediaId, state: 'clean', blocked: false })));
  await scan.flush();
  assert.equal(rows.size, ids.length);
  assert.equal(commitsSeen, 2);
  assert.ok(seen.every((n) => n <= 100), JSON.stringify(seen));
});

test('a database that stays busy: given up after MAX_DEFERS runs — one warning, the housekeeping asks again later', async (t) => {
  scan._setWaitsForTest({ waits: [], deferMs: 1 });
  t.after(() => scan._setWaitsForTest());
  await withHost({ scan: () => ({ state: 'clean' }) }, async (host, c) => {
    const list = await files(c, 3);
    busyUpserts(t, Infinity, () => Object.assign(new Error('too many concurrent host calls'), { code: 'ERR_BUSY' }));
    await Promise.all(list.map((n) => host.mediaScanned(n.mediaId, { state: 'infected', finding: 'X' })));
    await scan.flush();
    const lines = host.logs.filter((l) => /scan state/.test(l.message));
    assert.equal(lines.length, 1, JSON.stringify(host.logs));
    assert.equal(lines[0].level, 'warn');
    assert.match(lines[0].message, /"deferred":3,"dropped":3/);
  });
});
