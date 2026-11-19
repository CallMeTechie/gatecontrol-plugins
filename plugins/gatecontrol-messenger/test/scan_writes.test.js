'use strict';

// Writes of the virus scan's states (1.28.1, server/scan.js; the pattern of Drive 1.28.1). GateControl calls the hook
// mediaScanned once per file and does not wait — after the scanner was away (retryPending) hundreds come at once.
// Before: each hook wrote on its own, the hooks piled up host calls beyond GateControl's limit (32 open host calls per
// plugin, src/services/plugins/runtime.js MAX_HOST_CALLS) and it answered ERR_BUSY — states lost, "scan state failed
// ERR_BUSY" once per file. Now: queued, one transaction per batch, one batch at a time, unchanged results write nothing,
// a busy database is tried again — one line per run, none per file. The members still hear message.update per message.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC, PNG } = require('./helpers');
const scan = require('../server/scan');
const store = require('../server/store');

const scanLines = (host) => host.logs.filter((l) => /scan state/.test(l.message));
const commits = (host) => host.dbWrites.filter((w) => w.kind === 'commit');

/**
 * n pictures from Anna to Marc while the scan is still checking them → { conv, list: [{ mediaId, messageId }] }. The
 * first is sent; the others are copies of its message row with a file of their own (sending 494 takes long).
 */
async function sent(host, c, n) {
  const d = await c.direct(ANNA, MARC);
  const first = await c.upload(ANNA, PNG, 'image/png');
  const m = await c.send(ANNA, d.id, { kind: 'image', mediaId: first });
  const out = [{ mediaId: first, messageId: m.id }];
  const gc = host.gc;
  const msg = await store.one(gc, 'SELECT * FROM messages WHERE id = ?', [m.id]);
  const med = await store.one(gc, 'SELECT * FROM media WHERE media_id = ?', [first]);
  const insert = (table, row) => {
    const keys = Object.keys(row);
    return store.run(gc, `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${store.marks(keys.length)})`, keys.map((k) => row[k]));
  };
  await store.tx(gc, async () => {
    for (let i = 1; i < n; i++) {
      const mediaId = await c.upload(ANNA, PNG, 'image/png');
      const { id, ...rest } = msg;
      const r = await insert('messages', { ...rest, client_id: `${msg.client_id}-${i}` });
      await insert('media', { ...med, media_id: mediaId, msg_id: Number(r.lastInsertRowid) });
      out.push({ mediaId, messageId: Number(r.lastInsertRowid) });
    }
  });
  return { conv: d, list: out };
}

/**
 * GateControl's limit of open host calls per plugin (MAX_HOST_CALLS = 32) on the plugin's database calls, each held
 * `delayMs` (a slow disk): beyond the limit ERR_BUSY, as the host answers. → { maxOpen, refused, gc }
 */
function hostLimit(t, { max = 32, delayMs = 3 } = {}) {
  const st = { open: 0, maxOpen: 0, refused: 0, gc: null };
  for (const name of ['all', 'one', 'run']) {
    const orig = store[name];
    t.mock.method(store, name, async (gc, sql, params) => {
      st.gc = gc;
      if (st.open >= max) { st.refused++; throw Object.assign(new Error('too many concurrent host calls'), { code: 'ERR_BUSY' }); }
      st.open++;
      st.maxOpen = Math.max(st.maxOpen, st.open);
      try {
        await new Promise((r) => setTimeout(r, delayMs));
        return await orig(gc, sql, params);
      } finally { st.open--; }
    });
  }
  return st;
}

/** store.run answers `err` for the UPDATEs of media the first `times` times. */
function busyUpdates(t, times, err) {
  const orig = store.run;
  let left = times;
  t.mock.method(store, 'run', (gc, sql, params) => {
    if (left > 0 && /^UPDATE media SET scan_state/.test(sql)) { left--; return Promise.reject(err()); }
    return orig(gc, sql, params);
  });
  return { left: () => left };
}

const statesOf = async (gc, ids) => {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    for (const r of await store.all(gc, `SELECT media_id, scan_state, scan_blocked, scan_finding FROM media WHERE media_id IN (${store.marks(part.length)})`, part)) out.set(r.media_id, r);
  }
  return out;
};

test('494 results at once (the scanner back after an outage) with GateControl’s limit of 32 host calls and a slow disk: all written, members told, no line per file', async (t) => {
  const N = 494;
  await withHost({ scan: () => ({ state: 'pending' }) }, async (host, c) => {
    const { conv, list } = await sent(host, c, N);
    // a minute later (GateControl lets 600 events a minute through; the sending had its own)
    c.clock.add(61000);
    host.resetDbWrites();
    c.resetEvents();
    const lim = hostLimit(t, { max: 32, delayMs: 3 });
    // as GateControl sends them after retryPending: all at once, nobody waits
    await Promise.all(list.map((x) => host.mediaScanned(x.mediaId, { state: 'clean' })));
    await scan.flush();
    assert.equal(lim.refused, 0, 'never beyond the limit');
    assert.ok(lim.maxOpen <= 32, `open host calls ${lim.maxOpen}`);
    t.mock.restoreAll();
    const kept = await statesOf(lim.gc, list.map((x) => x.mediaId));
    assert.equal(kept.size, N);
    for (const x of list) assert.deepEqual({ ...kept.get(x.mediaId) }, { media_id: x.mediaId, scan_state: 'clean', scan_blocked: 0, scan_finding: null });
    // one transaction per batch (≤ 200 results), never one per file
    assert.equal(commits(host).length, Math.ceil(N / scan.BATCH_MAX), JSON.stringify(commits(host)));
    assert.deepEqual(host.dbWrites.filter((w) => w.kind !== 'commit'), []);
    // the members of every message hear it, once per message
    const ev = c.events('message.update');
    assert.equal(ev.length, N);
    assert.deepEqual(new Set(ev.map((e) => e.data.messageId)), new Set(list.map((x) => x.messageId)));
    for (const e of ev) assert.deepEqual([e.users.sort(), e.data.conversationId, e.data.scan], [[ANNA.id, MARC.id], conv.id, { state: 'clean', blocked: false, finding: null }]);
    // the recipient sees the pictures now
    const msgs = (await c.as(MARC)('GET', `conversations/${conv.id}/messages`, null, { limit: 50 })).json.messages;
    assert.ok(msgs.length > 0 && msgs.every((m) => m.media.scan.state === 'clean'));
    assert.deepEqual(scanLines(host), [], JSON.stringify(host.logs));
    // the same results again (the nightly re-check): no write, nobody told
    host.resetDbWrites();
    c.resetEvents();
    await Promise.all(list.map((x) => host.mediaScanned(x.mediaId, { state: 'clean' })));
    await scan.flush();
    assert.deepEqual(host.dbWrites, []);
    assert.deepEqual(c.events('message.update'), []);
  });
});

test('ERR_BUSY: the batch is tried again after a short pause — written, members told, no warning', async (t) => {
  scan._setWaitsForTest({ waits: [1, 1, 1], deferMs: 5 });
  t.after(() => scan._setWaitsForTest());
  await withHost({ scan: () => ({ state: 'pending' }) }, async (host, c) => {
    const { list } = await sent(host, c, 5);
    c.resetEvents();
    const busy = busyUpdates(t, 2, () => Object.assign(new Error('too many concurrent host calls'), { code: 'ERR_BUSY' }));
    await Promise.all(list.map((x) => host.mediaScanned(x.mediaId, { state: 'infected', finding: 'Win.Trojan.Agent-1' })));
    assert.equal(busy.left(), 0, 'it was busy');
    assert.equal(c.events('message.update').length, 5);
    assert.ok(c.events('message.update').every((e) => e.data.scan.blocked === true));
    assert.deepEqual(scanLines(host), [], JSON.stringify(host.logs));
  });
});

test('still busy (SQLITE_BUSY): the files wait for the next run — one line for the run, none per file', async (t) => {
  scan._setWaitsForTest({ waits: [1, 1], deferMs: 5 });
  t.after(() => scan._setWaitsForTest());
  await withHost({ scan: () => ({ state: 'pending' }) }, async (host, c) => {
    const { list } = await sent(host, c, 6);
    c.resetEvents();
    // three tries of the first run fail, the next run gets through
    busyUpdates(t, 3, () => Object.assign(new Error('SQLITE_BUSY: database is locked'), { code: 'ERR_DB' }));
    await Promise.all(list.map((x) => host.mediaScanned(x.mediaId, { state: 'clean' })));
    await scan.flush();
    assert.equal(c.events('message.update').length, 6);
    const lines = scanLines(host);
    assert.equal(lines.length, 1, JSON.stringify(host.logs));
    assert.equal(lines[0].level, 'info');
    assert.match(lines[0].message, /^scan states deferred \(database busy\) .*"deferred":6,"dropped":0,"written":6/);
  });
});

test('another error: one warning for the batch, not one per file; the next results are written again', async (t) => {
  await withHost({ scan: () => ({ state: 'pending' }) }, async (host, c) => {
    const { list } = await sent(host, c, 4);
    busyUpdates(t, 1, () => Object.assign(new Error('disk I/O error'), { code: 'ERR_DB' }));
    await Promise.all(list.map((x) => host.mediaScanned(x.mediaId, { state: 'clean' })));
    const lines = scanLines(host);
    assert.equal(lines.length, 1, JSON.stringify(host.logs));
    assert.match(lines[0].message, /^scan state failed ERR_DB \{"files":4\}$/);
    c.resetEvents();
    await host.mediaScanned(list[0].mediaId, { state: 'clean' });
    assert.deepEqual(c.events('message.update').map((e) => e.data.messageId), [list[0].messageId]);
  });
});

test('a database that stays busy: given up after MAX_DEFERS runs — one warning', async (t) => {
  scan._setWaitsForTest({ waits: [], deferMs: 1 });
  t.after(() => scan._setWaitsForTest());
  await withHost({ scan: () => ({ state: 'pending' }) }, async (host, c) => {
    const { list } = await sent(host, c, 3);
    busyUpdates(t, Infinity, () => Object.assign(new Error('too many concurrent host calls'), { code: 'ERR_BUSY' }));
    await Promise.all(list.map((x) => host.mediaScanned(x.mediaId, { state: 'clean' })));
    await scan.flush();
    const lines = scanLines(host);
    assert.equal(lines.length, 1, JSON.stringify(host.logs));
    assert.equal(lines[0].level, 'warn');
    assert.match(lines[0].message, /"deferred":3,"dropped":3/);
  });
});
