'use strict';

// The virus scan of GateControl (the version after 1.222.0, docs/feature-malware-scan-contract.md of GateControl):
// every file that comes into Drive's media is checked by the host right after it is stored. Drive keeps the result per
// media id (table media_scan) and gives every file node of an answer
//   scan { state, blocked, finding }   state pending | clean | infected | unscannable | unchecked
// — only while the host told a result (an older GateControl answers no `scan`: no field, nothing changes). `blocked`
// decides, not `state`: a blocked file is not opened, downloaded, previewed, shared or handed over (the host refuses
// it anyway — 423 scan_pending / quarantined / scan_blocked; here the same codes come as clear errors first).
//   in     uploads/commit and every other way into the tree (links, NAS journal, imports, Mail and GateDrop, scans,
//          copies) take `scan` from gc.media.info; the hook mediaScanned (a check that ended after the upload answered,
//          the nightly re-check, an administrator's release or delete) changes it later — each change of a live file
//          is 'scan' in the change log (the apps and the portal reload it)
//   out    attach() (every answer), check() (content, office, links, Mail's share_link …)
// The housekeeping asks again for files still 'pending' (a missed hook) and forgets rows of files that are gone.
//
// Writes (since 1.28.1): a row is only written when state, blocked or finding change — a re-check that finds the same
// (the nightly scan: almost every file clean again) writes nothing. The hook mediaScanned comes once per file, the
// nightly scan sends hundreds in minutes: they are queued and written together — one transaction per batch (what came
// within GATHER_MS, at most BATCH_MAX; what comes while a batch waits for the disk is the next one). One write at a
// time, so the hooks no longer pile up host calls (GateControl answers ERR_BUSY beyond 32 at once). A batch the database refuses as busy (ERR_BUSY,
// SQLITE_BUSY) is tried again after a short pause (BUSY_WAITS_MS); still busy, its files wait DEFER_MS for the next run
// (at most MAX_DEFERS times — then the housekeeping and the next check() ask the host again). One line per run says
// how many had to wait, never one per file.

const store = require('./store');
const nodes = require('./nodes');
const { fail } = require('./util');

const STATES = new Set(['pending', 'clean', 'infected', 'unscannable', 'unchecked']);
const PENDING_AGAIN_MS = 60000;
const FORGET_MS = 86400000;
// the queue of the hook mediaScanned (see the header)
const BATCH_MAX = 200;
const GATHER_MS = 100;
const BUSY_WAITS_MS = [250, 1000, 3000];
const DEFER_MS = 30000;
const MAX_DEFERS = 10;
// 5 parameters a row; GateControl's database worker takes at most 100 a statement (store.CHUNK)
const ROWS_PER_INSERT = Math.floor(store.CHUNK / 5);

/** The host's `scan` → { state, blocked, finding } or null (no scan: an older GateControl). */
function norm(s) {
  if (!s || typeof s !== 'object' || !STATES.has(s.state)) return null;
  return { state: s.state, blocked: s.blocked === true, finding: typeof s.finding === 'string' && s.finding ? s.finding.slice(0, 200) : null };
}

/** The error of a blocked file: scan_pending (still being checked), quarantined (malware), scan_blocked (not checkable). */
function codeOf(s) {
  if (!s || !s.blocked) return null;
  if (s.state === 'pending') return 'scan_pending';
  if (s.state === 'infected') return 'quarantined';
  return 'scan_blocked';
}

const view = (r) => ({ state: r.state, blocked: r.blocked === 1 || r.blocked === true, finding: r.finding || null });

// a kept row is only written again when the result differs (no write for the same state)
const UPSERT = `ON CONFLICT(media_id) DO UPDATE SET state = excluded.state, blocked = excluded.blocked, finding = excluded.finding,
    at = excluded.at WHERE media_scan.state IS NOT excluded.state OR media_scan.blocked IS NOT excluded.blocked
    OR media_scan.finding IS NOT excluded.finding`;

/** Keep the result for media `mediaId` → the normalised scan or null (nothing kept). */
async function remember(gc, mediaId, scan, now = Date.now()) {
  const s = norm(scan);
  if (!s || typeof mediaId !== 'string' || !mediaId) return null;
  await store.run(gc, `INSERT INTO media_scan (media_id, state, blocked, finding, at) VALUES (?, ?, ?, ?, ?) ${UPSERT}`,
    [mediaId, s.state, s.blocked ? 1 : 0, s.finding, now]);
  return s;
}

const same = (a, b) => !!a && !!b && a.state === b.state && a.blocked === b.blocked && a.finding === b.finding;

/** gc.media.info's answer → keep its scan (best effort; never fails the caller). */
async function fromInfo(gc, info) {
  if (!info || !info.scan) return null;
  try { return await remember(gc, info.mediaId, info.scan); } catch (e) { gc.log.warn('scan state not kept', (e && e.code) || 'error'); return null; }
}

/** A copy of `fromId` (gc.media.copy keeps the state of its source) → the same row for `toId`. */
async function copy(gc, fromId, toId) {
  if (!fromId || !toId) return;
  await store.run(gc, `INSERT OR REPLACE INTO media_scan (media_id, state, blocked, finding, at)
    SELECT ?, state, blocked, finding, at FROM media_scan WHERE media_id = ?`, [toId, fromId]);
}

/** The kept rows of `ids` → Map mediaId → { state, blocked, finding }. */
async function rowsOf(gc, ids) {
  const out = new Map();
  const list = [...new Set(ids.filter((x) => typeof x === 'string' && x))];
  // GateControl's database worker takes at most 100 parameters a statement (store.CHUNK)
  for (const part of store.chunks(list)) {
    for (const r of await store.all(gc, `SELECT * FROM media_scan WHERE media_id IN (${store.marks(part.length)})`, part)) out.set(r.media_id, view(r));
  }
  return out;
}

/** The kept state of one media id (null: none known). */
async function stateOf(gc, mediaId) {
  if (!mediaId) return null;
  const r = await store.one(gc, 'SELECT * FROM media_scan WHERE media_id = ?', [mediaId]);
  return r ? view(r) : null;
}

/** Is media `mediaId` blocked as far as Drive knows (its kept row)? */
async function blocked(gc, mediaId) {
  const s = await stateOf(gc, mediaId);
  return !!(s && s.blocked);
}

/**
 * Before a file is opened or leaves Drive: asks GateControl now (the result is kept) and refuses a blocked file —
 * 423 scan_pending / quarantined / scan_blocked { scan }. An older host (no scan) and an empty file pass.
 */
async function check(ctx, mediaId) {
  if (!mediaId) return null;
  let s = null;
  try {
    const info = await ctx.gc.media.info(mediaId);
    s = info && info.scan ? await remember(ctx.gc, mediaId, info.scan, ctx.now) : null;
  } catch { s = await stateOf(ctx.gc, mediaId); }
  const code = codeOf(s);
  if (code) throw fail(code, { scan: s });
  return s;
}

/**
 * Every file node of an answer (previews.nodesOf) gets `scan` when a result is known; a blocked one loses its preview
 * and thumb (the host would refuse them). Never fails the request.
 */
async function attach(ctx, list) {
  const files = list.filter((n) => n && n.mediaId && !n.isDir);
  if (!files.length) return;
  const map = await rowsOf(ctx.gc, files.map((n) => n.mediaId));
  for (const n of files) {
    const s = map.get(n.mediaId);
    if (!s) continue;
    n.scan = s;
    if (s.blocked) {
      if (Object.prototype.hasOwnProperty.call(n, 'preview')) n.preview = null;
      if (Object.prototype.hasOwnProperty.call(n, 'thumb')) n.thumb = null;
    }
  }
}

/** The live nodes whose current bytes are `mediaId` — each change is 'scan' in the change log. */
async function logChange(gc, mediaId, ctx) {
  const rows = await store.all(gc, 'SELECT id, area_id FROM nodes WHERE media_id = ? AND deleted_at IS NULL', [mediaId]);
  for (const r of rows) await nodes.log(gc, r.area_id, r.id, 'scan', ctx);
  return rows.length;
}

/** The hook's argument → { id, scan } or null ('deleted': the host removed the file — kept as infected and blocked). */
function hookItem(arg) {
  const id = arg && typeof arg.mediaId === 'string' && /^[0-9a-f]{32}$/.test(arg.mediaId) ? arg.mediaId : null;
  if (!id) return null;
  const s = norm(arg.state === 'deleted' ? { state: 'infected', blocked: true, finding: arg.finding || null } : arg);
  return s ? { id, scan: s } : null;
}

const isBusy = (e) => !!e && (e.code === 'ERR_BUSY' || e.code === 'SQLITE_BUSY' || /SQLITE_BUSY|database is locked/i.test(String(e.message || '')));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One batch of results [{ id, scan }] in one transaction: only rows that change are written; each change of a live
 * file is 'scan' in its change log. A file not (yet) in the tree is kept for its commit (the upload may still be on its
 * way). → { written, touched: Set of area ids }
 */
async function writeBatch(gc, batch, now) {
  const ctx = { viewer: null, deviceId: null, now, touched: new Set() };
  const changedOf = async () => {
    const kept = await rowsOf(gc, batch.map((b) => b.id));
    return batch.filter((b) => !same(kept.get(b.id), b.scan));
  };
  // nothing new (the nightly re-check: clean again): no transaction at all
  if (!(await changedOf()).length) return { written: 0, touched: ctx.touched };
  return store.tx(gc, async () => {
    const changed = await changedOf();
    for (const part of store.chunks(changed, ROWS_PER_INSERT)) {
      await store.run(gc, `INSERT INTO media_scan (media_id, state, blocked, finding, at) VALUES ${part.map(() => '(?, ?, ?, ?, ?)').join(', ')} ${UPSERT}`,
        part.flatMap((b) => [b.id, b.scan.state, b.scan.blocked ? 1 : 0, b.scan.finding, now]));
    }
    for (const part of store.chunks(changed.map((b) => b.id))) {
      const rows = await store.all(gc, `SELECT id, area_id FROM nodes WHERE media_id IN (${store.marks(part.length)}) AND deleted_at IS NULL`, part);
      for (const r of rows) await nodes.log(gc, r.area_id, r.id, 'scan', ctx);
    }
    return { written: changed.length, touched: ctx.touched };
  });
}

// The queue of the hook (one per plugin process): mediaId → { id, scan, defers, waiters }; `timer` waits GATHER_MS for
// more results ('gather') or DEFER_MS after a busy database ('defer')
const queue = { items: new Map(), draining: null, timer: null, timerKind: null, run: null, gc: null, announce: null,
  waits: BUSY_WAITS_MS, deferMs: DEFER_MS };

/** Settle the waiters of `items` (the hooks that sent them). */
function settle(items) { for (const it of items) for (const w of it.waiters) w(); }

/** Write the queue batch by batch until it is empty or the database stays busy (then again in DEFER_MS). */
async function drain() {
  const { gc } = queue;
  const run = queue.run || (queue.run = { written: 0, deferred: new Set(), dropped: 0, batches: 0 });
  while (queue.items.size) {
    const batch = [...queue.items.values()].slice(0, BATCH_MAX);
    for (const b of batch) queue.items.delete(b.id);
    let out = null;
    let err = null;
    for (let i = 0; ; i++) {
      try { out = await writeBatch(gc, batch, Date.now()); err = null; break; } catch (e) {
        err = e;
        if (!isBusy(e) || i >= queue.waits.length) break;
        await pause(queue.waits[i]);
      }
    }
    if (out) {
      run.written += out.written;
      run.batches++;
      settle(batch);
      if (out.touched.size && queue.announce) {
        try { await queue.announce(out.touched); } catch (e) { gc.log.warn('scan change not announced', (e && e.code) || 'error'); }
      }
      continue;
    }
    if (!isBusy(err)) {
      // not the disk: the batch is lost (the housekeeping and check() ask again) — one line for the batch
      gc.log.warn('scan state failed', (err && err.code) || 'error', { files: batch.length });
      settle(batch);
      continue;
    }
    // still busy: the batch waits for the next run; its hooks do not wait for it (the host does not wait for them
    // either). A newer result of a file that came meanwhile is written instead.
    for (const b of batch) {
      settle([b]);
      if (queue.items.has(b.id)) continue;
      if (b.defers >= MAX_DEFERS) { run.dropped++; continue; }
      queue.items.set(b.id, { ...b, defers: b.defers + 1, waiters: [] });
      run.deferred.add(b.id);
    }
    // all of them given up: the run ends here (its line below)
    if (!queue.items.size) continue;
    wait('defer', queue.deferMs);
    return;
  }
  // the run is over: one line when files had to wait (warn when some were given up)
  queue.run = null;
  if (run.deferred.size || run.dropped) {
    gc.log[run.dropped ? 'warn' : 'info']('scan states deferred (database busy)', { deferred: run.deferred.size, dropped: run.dropped, written: run.written });
  }
}

function wait(kind, ms) {
  queue.timerKind = kind;
  queue.timer = setTimeout(() => { queue.timer = null; queue.timerKind = null; kick(true); }, ms);
  // the long wait after a busy database does not hold a stopping process
  if (kind === 'defer' && queue.timer.unref) queue.timer.unref();
}

/**
 * Something was queued: start writing — `now`, or after GATHER_MS (more results may follow; a full batch goes at
 * once). Never while a write runs (what came meanwhile follows right after it) or waits after a busy database.
 */
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

/**
 * The hook mediaScanned({ mediaId, state, blocked, finding }): the result joins the queue; resolves when it was
 * written (or skipped as unchanged, or deferred). `announce(touched)` tells the apps of the areas a batch changed.
 */
function scanned(gc, arg, { announce } = {}) {
  const item = hookItem(arg);
  if (!item) return Promise.resolve();
  queue.gc = gc;
  if (announce) queue.announce = announce;
  return new Promise((resolve) => {
    const prev = queue.items.get(item.id);
    queue.items.set(item.id, { ...item, defers: prev ? prev.defers : 0, waiters: [...(prev ? prev.waiters : []), resolve] });
    kick();
  });
}

/**
 * Write what is queued now, without waiting for the next run. `once` (the plugin stops): one try; else until the queue
 * is empty (tests) — a database that stays busy ends it after MAX_DEFERS tries.
 */
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

/** The housekeeping: files still 'pending' asked again (a hook may have been missed); rows of files that are gone go. */
async function housekeeping(gc, ctx) {
  const pending = await store.all(gc, "SELECT media_id FROM media_scan WHERE state = 'pending' AND at < ? ORDER BY at LIMIT 50", [ctx.now - PENDING_AGAIN_MS]);
  for (const p of pending) {
    let info;
    try { info = await gc.media.info(p.media_id); } catch { continue; }
    if (!info) { await store.run(gc, 'DELETE FROM media_scan WHERE media_id = ?', [p.media_id]); continue; }
    const s = norm(info.scan);
    if (!s || s.state === 'pending') { await store.run(gc, 'UPDATE media_scan SET at = ? WHERE media_id = ?', [ctx.now, p.media_id]); continue; }
    await remember(gc, p.media_id, s, ctx.now);
    await logChange(gc, p.media_id, ctx);
  }
  await store.run(gc, `DELETE FROM media_scan WHERE at < ? AND media_id NOT IN (SELECT media_id FROM nodes WHERE media_id IS NOT NULL)
    AND media_id NOT IN (SELECT media_id FROM versions)`, [ctx.now - FORGET_MS]);
}

module.exports = { norm, codeOf, remember, fromInfo, copy, rowsOf, stateOf, blocked, check, attach, scanned, flush, housekeeping, writeBatch,
  BATCH_MAX, MAX_DEFERS, _setWaitsForTest };
