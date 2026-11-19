'use strict';

// Writes of the hook mediaScanned (since 1.6.0, the pattern of Drive 1.28.1). GateControl calls the hook once per file it
// checked — the nightly re-check sends hundreds in minutes, nearly all "clean" again. Before: one UPDATE per file, each
// a write of its own; with a stalling disk the hooks piled up host calls until GateControl answered ERR_BUSY (more than
// 32 open at once) and "scan state failed" was logged once per file, the result lost.
// Now: the results are queued and written together — one transaction per batch (what came within GATHER_MS, at most
// BATCH_MAX; what comes while a batch waits for the disk is the next one), one batch at a time. Only items whose state,
// blocked or finding change are written; a batch without a change writes nothing. A batch the database refuses as busy
// (ERR_BUSY, SQLITE_BUSY) is tried again after BUSY_WAITS_MS; still busy, its files wait DEFER_MS for the next run (at
// most MAX_DEFERS times — then the background's retry and GET views ask GateControl again). One line per run, never one
// per file. Once a batch is written (or found unchanged), the deliveries that wait for these results (retry.js, error
// scan_pending) are tried again right away — the delivery never waits for a later run.

const store = require('./store');
const scan = require('./scan');
const retry = require('./retry');

const BATCH_MAX = 200;
const GATHER_MS = 100;
const BUSY_WAITS_MS = [250, 1000, 3000];
const DEFER_MS = 30000;
const MAX_DEFERS = 10;

/** The hook's argument → { id, scan } or null ('deleted': GateControl removed the file — held back as infected). */
function hookItem(arg) {
  const id = arg && typeof arg.mediaId === 'string' && /^[0-9a-f]{32}$/.test(arg.mediaId) ? arg.mediaId : null;
  if (!id) return null;
  const s = scan.norm(arg.state === 'deleted' ? { state: 'infected', blocked: true, finding: arg.finding || null } : arg);
  return s ? { id, scan: s } : null;
}

const isBusy = (e) => !!e && (e.code === 'ERR_BUSY' || e.code === 'SQLITE_BUSY' || /SQLITE_BUSY|database is locked/i.test(String(e.message || '')));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** The items of the batch whose kept scan differs from the result (an item of a media id not in a send: none). */
async function changedOf(gc, batch) {
  const want = new Map(batch.map((b) => [b.id, b.scan]));
  const out = new Set();
  for (const part of store.chunks([...want.keys()])) {
    const rows = await store.all(gc, `SELECT media_id, scan_state, scan_blocked, scan_finding FROM items WHERE media_id IN (${store.marks(part.length)})`, part);
    for (const r of rows) {
      const s = want.get(r.media_id);
      if (r.scan_state !== s.state || (r.scan_blocked === 1) !== s.blocked || (r.scan_finding || null) !== s.finding) out.add(r.media_id);
    }
  }
  return batch.filter((b) => out.has(b.id));
}

/** One batch [{ id, scan }] in one transaction, only what changes. → { written } */
async function writeBatch(gc, batch) {
  if (!(await changedOf(gc, batch)).length) return { written: 0 };
  return store.tx(gc, async () => {
    const changed = await changedOf(gc, batch);
    for (const b of changed) await store.run(gc, 'UPDATE items SET scan_state = ?, scan_blocked = ?, scan_finding = ? WHERE media_id = ?', [...scan.cols(b.scan), b.id]);
    return { written: changed.length };
  });
}

/** The deliveries waiting for these results: tried again (after the answer, bg.js). Never fails the run. */
async function release(gc, batch) {
  const done = batch.filter((b) => b.scan.state !== 'pending').map((b) => b.id);
  if (!done.length) return;
  try { await retry.scanned(gc, done); } catch (e) { gc.log.warn('scan retry failed', (e && e.code) || 'error', { files: done.length }); }
}

// The queue (one per plugin process): mediaId → { id, scan, defers, waiters }; `timer` waits GATHER_MS for more
// results ('gather') or DEFER_MS after a busy database ('defer')
const queue = { items: new Map(), draining: null, timer: null, timerKind: null, run: null, gc: null, waits: BUSY_WAITS_MS, deferMs: DEFER_MS };

function settle(items) { for (const it of items) for (const w of it.waiters) w(); }

/** Write the queue batch by batch until it is empty or the database stays busy (then again in DEFER_MS). */
async function drain() {
  const { gc } = queue;
  const run = queue.run || (queue.run = { written: 0, deferred: new Set(), dropped: 0 });
  while (queue.items.size) {
    const batch = [...queue.items.values()].slice(0, BATCH_MAX);
    for (const b of batch) queue.items.delete(b.id);
    let out = null;
    let err = null;
    for (let i = 0; ; i++) {
      try { out = await writeBatch(gc, batch); err = null; break; } catch (e) {
        err = e;
        if (!isBusy(e) || i >= queue.waits.length) break;
        await pause(queue.waits[i]);
      }
    }
    if (out) {
      run.written += out.written;
      await release(gc, batch);
      settle(batch);
      continue;
    }
    if (!isBusy(err)) {
      // not the disk: the batch is not kept (GET views and the background ask GateControl again) — one line for it; the
      // waiting deliveries are tried all the same (they ask GateControl for the files' state themselves)
      gc.log.warn('scan state failed', (err && err.code) || 'error', { files: batch.length });
      await release(gc, batch);
      settle(batch);
      continue;
    }
    // still busy: the batch waits for the next run (a newer result of a file that came meanwhile is written instead)
    const given = [];
    for (const b of batch) {
      settle([b]);
      if (queue.items.has(b.id)) continue;
      if (b.defers >= MAX_DEFERS) { run.dropped++; given.push(b); continue; }
      queue.items.set(b.id, { ...b, defers: b.defers + 1, waiters: [] });
      run.deferred.add(b.id);
    }
    // given up: the waiting deliveries are tried all the same
    if (given.length) await release(gc, given);
    if (!queue.items.size) continue;
    wait('defer', queue.deferMs);
    return;
  }
  queue.run = null;
  if (run.deferred.size || run.dropped) {
    gc.log[run.dropped ? 'warn' : 'info']('scan states deferred (database busy)', { deferred: run.deferred.size, dropped: run.dropped, written: run.written });
  }
}

function wait(kind, ms) {
  queue.timerKind = kind;
  queue.timer = setTimeout(() => { queue.timer = null; queue.timerKind = null; kick(true); }, ms);
  if (kind === 'defer' && queue.timer.unref) queue.timer.unref();
}

/** Start writing — `now`, or after GATHER_MS (a full batch at once); never while a write runs or waits after a busy database. */
function kick(now = false) {
  if (queue.draining) return queue.draining;
  if (queue.timer) {
    if (!now && !(queue.timerKind === 'gather' && queue.items.size >= BATCH_MAX)) return null;
    clearTimeout(queue.timer);
    queue.timer = null;
    queue.timerKind = null;
  } else if (!now && queue.items.size < BATCH_MAX) {
    wait('gather', GATHER_MS);
    return null;
  }
  queue.draining = drain().catch((e) => { try { queue.gc.log.warn('scan state failed', (e && e.code) || 'error'); } catch { /* none */ } })
    .finally(() => { queue.draining = null; if (queue.items.size && !queue.timer) kick(true); });
  return queue.draining;
}

/** The hook mediaScanned: the result joins the queue; resolves once it was written (or unchanged, or deferred). */
function scanned(gc, arg) {
  const item = hookItem(arg);
  if (!item) return Promise.resolve();
  queue.gc = gc;
  return new Promise((resolve) => {
    const prev = queue.items.get(item.id);
    queue.items.set(item.id, { ...item, defers: prev ? prev.defers : 0, waiters: [...(prev ? prev.waiters : []), resolve] });
    kick();
  });
}

/** Write what is queued now. `once` (the plugin stops): one try; else until the queue is empty (tests). */
async function flush({ once = false } = {}) {
  for (let tried = false; ;) {
    if (queue.draining) { await queue.draining; continue; }
    if (!queue.items.size || (once && tried)) return;
    tried = true;
    await kick(true);
  }
}

/** Tests: the pauses after a busy database and before the next run. */
function _setWaitsForTest({ waits = BUSY_WAITS_MS, deferMs = DEFER_MS } = {}) { queue.waits = waits; queue.deferMs = deferMs; }

module.exports = { scanned, flush, writeBatch, hookItem, _setWaitsForTest, BATCH_MAX, GATHER_MS, BUSY_WAITS_MS, DEFER_MS, MAX_DEFERS };
