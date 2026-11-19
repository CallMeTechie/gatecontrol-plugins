'use strict';

// Writes of the hook mediaScanned (1.6.0, server/scanq.js — the pattern of Drive 1.28.1). GateControl's nightly re-check
// sends the hook once per file, nearly all "clean" again. Before: one UPDATE per file, a write of its own each; with a
// stalling disk the hooks piled up host calls until GateControl answered ERR_BUSY ("scan state failed" per file, the
// result lost). Now: queued, one transaction per batch, unchanged results write nothing, a busy database is tried again
// after a short pause or the files wait for the next run — one line per run; the deliveries that wait for the check go
// right after their batch is written.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, PDF } = require('./helpers');
const scanq = require('../server/scanq');
const store = require('../server/store');

const itemWrites = (host) => host.dbWrites.filter((w) => w.kind === 'statement' && /UPDATE items SET scan_state/.test(w.sql || ''));
const commits = (host) => host.dbWrites.filter((w) => w.kind === 'commit');
const scanLines = (host) => host.logs.filter((l) => /scan state/.test(l.message));

/** `n` files Anna sent to her PC through the server → media ids */
async function sent(c, n) {
  const ids = [];
  for (let i = 0; i < n; i++) ids.push(await c.upload(ANNA, Buffer.concat([PDF, Buffer.from(`Datei ${i}`)]), 'application/pdf'));
  for (let i = 0; i < n; i += 20) {
    const r = await c.as(ANNA, 'anna-phone')('POST', 'sends', { items: ids.slice(i, i + 20).map((m, k) => ({ mediaId: m, name: `datei-${i + k}.pdf` })), to: { devices: ['anna-pc'] } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }
  return ids;
}

const stateOf = async (host, m) => (await host.gc.db.get('SELECT scan_state, scan_blocked, scan_finding FROM items WHERE media_id = ?', [m])).row;

/** store.run answers `err` for the item updates of the scan the first `times` times. */
function busyUpdates(t, times, err) {
  const orig = store.run;
  let left = times;
  t.mock.method(store, 'run', (gc, sql, params) => {
    if (left > 0 && /^UPDATE items SET scan_state/.test(sql)) { left--; return Promise.reject(err()); }
    return orig(gc, sql, params);
  });
  return { left: () => left };
}

test('the nightly re-check: results that come together are one transaction; the same results again write nothing', async () => {
  await withHost({ scan: () => ({ state: 'clean' }) }, async (host, c) => {
    const list = await sent(c, 30);
    host.resetDbWrites();
    await Promise.all(list.map((m, i) => host.mediaScanned(m, i < 10 ? { state: 'infected', finding: 'Win.Trojan.Agent-1' } : { state: 'clean' })));
    assert.equal(commits(host).length, 1, JSON.stringify(host.dbWrites));
    assert.ok(host.dbWrites.every((w) => w.kind === 'commit'), 'no statement outside the transaction');
    assert.deepEqual(await stateOf(host, list[3]), { scan_state: 'infected', scan_blocked: 1, scan_finding: 'Win.Trojan.Agent-1' });
    assert.equal((await stateOf(host, list[20])).scan_state, 'clean');
    // the next night: the same results — no write at all
    host.resetDbWrites();
    await Promise.all(list.map((m, i) => host.mediaScanned(m, i < 10 ? { state: 'infected', finding: 'Win.Trojan.Agent-1' } : { state: 'clean' })));
    for (const m of list.slice(10, 20)) await host.mediaScanned(m, { state: 'clean' });
    assert.deepEqual(host.dbWrites, []);
    assert.deepEqual(scanLines(host), []);
  });
});

test('ERR_BUSY: the batch is tried again after a short pause — written, no warning per file', async (t) => {
  scanq._setWaitsForTest({ waits: [1, 1, 1], deferMs: 5 });
  t.after(() => scanq._setWaitsForTest());
  await withHost({ scan: () => ({ state: 'clean' }) }, async (host, c) => {
    const list = await sent(c, 5);
    const busy = busyUpdates(t, 2, () => Object.assign(new Error('too many concurrent host calls'), { code: 'ERR_BUSY' }));
    await Promise.all(list.map((m) => host.mediaScanned(m, { state: 'unscannable', blocked: false, finding: 'encrypted' })));
    assert.equal(busy.left(), 0, 'it was busy');
    for (const m of list) assert.equal((await stateOf(host, m)).scan_state, 'unscannable');
    assert.deepEqual(scanLines(host), []);
  });
});

test('still busy (SQLITE_BUSY): the files wait for the next run — one line for the run, none per file', async (t) => {
  scanq._setWaitsForTest({ waits: [1, 1], deferMs: 5 });
  t.after(() => scanq._setWaitsForTest());
  await withHost({ scan: () => ({ state: 'clean' }) }, async (host, c) => {
    const list = await sent(c, 6);
    busyUpdates(t, 3, () => Object.assign(new Error('SQLITE_BUSY: database is locked'), { code: 'ERR_DB' }));
    await Promise.all(list.map((m) => host.mediaScanned(m, { state: 'infected', finding: 'Eicar-Test-Signature' })));
    await scanq.flush();
    for (const m of list) assert.equal((await stateOf(host, m)).scan_state, 'infected');
    const lines = scanLines(host);
    assert.equal(lines.length, 1, JSON.stringify(host.logs));
    assert.equal(lines[0].level, 'info');
    assert.match(lines[0].message, /^scan states deferred \(database busy\) .*"deferred":6,"dropped":0/);
  });
});

test('another error: one warning for the batch, not one per file; the next results are written again', async (t) => {
  await withHost({ scan: () => ({ state: 'clean' }) }, async (host, c) => {
    const list = await sent(c, 4);
    busyUpdates(t, 1, () => Object.assign(new Error('disk I/O error'), { code: 'ERR_DB' }));
    await Promise.all(list.map((m) => host.mediaScanned(m, { state: 'infected', finding: 'X' })));
    const lines = scanLines(host);
    assert.equal(lines.length, 1, JSON.stringify(host.logs));
    assert.match(lines[0].message, /^scan state failed ERR_DB \{"files":4\}$/);
    await host.mediaScanned(list[0], { state: 'infected', finding: 'X' });
    assert.equal((await stateOf(host, list[0])).scan_state, 'infected');
  });
});

test('a delivery that waits for the check goes right after its batch is written — also when the database was busy first', async (t) => {
  scanq._setWaitsForTest({ waits: [1], deferMs: 5 });
  t.after(() => scanq._setWaitsForTest());
  await withHost({ scan: true, drive: true }, async (host, c) => {
    const bg = require('../server/bg');
    const m = await c.upload(ANNA, PDF, 'application/pdf');
    let open = null;
    bg.queue(() => new Promise((r) => { open = r; }), host.gc);
    const r = (await c.as(ANNA, 'anna-phone')('POST', 'sends', { items: [{ mediaId: m, name: 'Zeugnis.pdf' }], to: { drive: true } })).json;
    await host.mediaScanned(m, { state: 'pending' });
    open();
    await host.plugin._idle();
    const before = (await c.as(ANNA)('GET', `sends/${r.id}`)).json.send.deliveries[0];
    assert.deepEqual([before.status, before.error], ['pending', 'scan_pending']);
    // two busy tries: the batch waits for the next run, then the delivery goes
    busyUpdates(t, 2, () => Object.assign(new Error('too many concurrent host calls'), { code: 'ERR_BUSY' }));
    await host.mediaScanned(m, { state: 'clean' });
    await scanq.flush();
    await host.plugin._idle();
    const after = (await c.as(ANNA)('GET', `sends/${r.id}`)).json.send.deliveries[0];
    assert.deepEqual([after.status, after.error], ['delivered', null]);
    assert.equal(c.drive.saved.length, 1);
  });
});

test('more than one batch: BATCH_MAX results a transaction, a statement takes at most 100 parameters', async () => {
  const seen = [];
  const rows = new Map();
  let open = false;
  let commitsSeen = 0;
  const ids = Array.from({ length: scanq.BATCH_MAX + 50 }, (_, i) => i.toString(16).padStart(32, '0'));
  for (const id of ids) rows.set(id, { media_id: id, scan_state: 'pending', scan_blocked: 1, scan_finding: null });
  const gc = {
    log: { warn() {}, info() {} },
    db: {
      exec: async (sql) => { if (/^BEGIN/.test(sql)) open = true; else if (/^COMMIT/.test(sql)) { open = false; commitsSeen++; } },
      query: async (sql, params) => {
        seen.push(params.length);
        return { rows: /FROM items WHERE media_id IN/.test(sql) ? params.filter((id) => rows.has(id)).map((id) => rows.get(id)) : [] };
      },
      get: async () => ({ row: null }),
      run: async (sql, params) => {
        seen.push(params.length);
        assert.ok(open, 'inside the transaction');
        rows.set(params[3], { media_id: params[3], scan_state: params[0], scan_blocked: params[1], scan_finding: params[2] });
        return { changes: 1 };
      },
    },
  };
  await Promise.all(ids.map((mediaId) => scanq.scanned(gc, { mediaId, state: 'clean', blocked: false })));
  await scanq.flush();
  assert.ok([...rows.values()].every((r) => r.scan_state === 'clean'));
  assert.equal(commitsSeen, 2);
  assert.ok(seen.every((n) => n <= 100), JSON.stringify(seen));
});
