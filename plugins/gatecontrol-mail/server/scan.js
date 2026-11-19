'use strict';

// The virus scan of GateControl (the version after 1.222.0, docs/feature-malware-scan-contract.md of GateControl): every
// attachment GateControl stores for Mail (gc.mail's attachments and downloads, gc.media.fetch of Microsoft, the files of
// drafts) is checked right after it is stored. Mail keeps the result per attachment (attachments.scan_*) and per file of
// a draft (draft_atts.scan_*) and shows it as `scan { state, blocked, finding, removed? }`. An older GateControl answers
// no `scan`: nothing is kept, nothing changes.
//   'removed'     GateControl deleted the attachment at once (the administrator's action "Sofort löschen" —
//                 ERR_MEDIA_INFECTED, `mediaError` of a parsed mail): "Anhang entfernt (Schadsoftware)", never loaded again
//   blocked       quarantine, still being checked, not checkable and blocked: no opening, no download, no Drive, no sending
//                 (409 attachment_blocked with its name — remove it from the draft)
//   hook mediaScanned  a later result (re-check, an administrator released or deleted the file)

//
// Writes of the hook (since 1.17.1, the pattern of Drive 1.28.1): GateControl calls mediaScanned once per file — the
// nightly re-check hundreds in minutes, nearly all clean again. Each hook read and wrote on its own; with a stalling
// disk they piled up host calls until GateControl answered ERR_BUSY (32 open calls per plugin) and every file logged
// „scan state failed“. Now the results are queued and written together: one transaction per batch (what came within
// GATHER_MS, at most BATCH_MAX; what comes while a batch is written is the next one), one batch at a time, only rows
// whose state, blocked or finding change (none: no transaction). A batch the database refuses as busy (ERR_BUSY,
// SQLITE_BUSY) is tried again after BUSY_WAITS_MS; still busy, its files wait DEFER_MS for the next run (at most
// MAX_DEFERS times). One line per run says how many had to wait, never one per file.

const store = require('./store');
const push = require('./push');
const { fail } = require('./util');

const STATES = new Set(['pending', 'clean', 'infected', 'unscannable', 'unchecked']);
const BATCH_MAX = 200;
const GATHER_MS = 100;
const BUSY_WAITS_MS = [250, 1000, 3000];
const DEFER_MS = 30000;
const MAX_DEFERS = 10;

/** The host's `scan` → { state, blocked, finding } or null (no scan: an older GateControl). */
function norm(s) {
  if (!s || typeof s !== 'object' || !STATES.has(s.state)) return null;
  return { state: s.state, blocked: s.blocked === true, finding: typeof s.finding === 'string' && s.finding ? s.finding.slice(0, 200) : null };
}

/** The API's `scan` of a row (attachments, draft_atts) — null without a result. */
function ofRow(r) {
  if (!r || !r.scan_state) return null;
  if (r.scan_state === 'removed') return { state: 'infected', blocked: true, finding: r.scan_finding || null, removed: true };
  return { state: r.scan_state, blocked: r.scan_blocked === 1, finding: r.scan_finding || null };
}

/** A held-back file → its code: attachment_removed, quarantined, scan_pending, scan_blocked; else null. */
function held(s) {
  if (!s || !s.blocked) return null;
  if (s.removed) return 'attachment_removed';
  if (s.state === 'pending') return 'scan_pending';
  return s.state === 'infected' ? 'quarantined' : 'scan_blocked';
}

/** Throws the code of a held-back file (with its scan). */
function guard(s) {
  const code = held(s);
  if (code) throw fail(code, { scan: s });
}

const cols = (s) => (s ? [s.state, s.blocked ? 1 : 0, s.finding] : [null, 0, null]);

/** Keep the result of attachment `id` (from gc.media.info's `scan`) → the API's scan or null. */
async function keepAttachment(gc, id, scan) {
  const s = norm(scan);
  if (!s) return null;
  // 1.17.1: the same result writes nothing
  await store.run(gc, `UPDATE attachments SET scan_state = ?, scan_blocked = ?, scan_finding = ? WHERE id = ?
    AND (scan_state IS NOT ? OR scan_blocked IS NOT ? OR scan_finding IS NOT ?)`, [...cols(s), id, ...cols(s)]);
  return s;
}

/** GateControl deleted attachment `id` at once (ERR_MEDIA_INFECTED): kept as removed; never loaded again. */
async function removed(gc, id, finding = null) {
  await store.run(gc, "UPDATE attachments SET scan_state = 'removed', scan_blocked = 1, scan_finding = ?, media_id = NULL WHERE id = ?", [finding, id]);
}

// ─── the hook mediaScanned: queued, written in batches ───

/** The hook's argument → { id, scan, gone } or null ('deleted': GateControl removed the file — the attachment is removed). */
function hookItem(arg) {
  const id = arg && typeof arg.mediaId === 'string' && /^[0-9a-f]{32}$/.test(arg.mediaId) ? arg.mediaId : null;
  if (!id) return null;
  const gone = arg.state === 'deleted';
  const s = norm(gone ? { state: 'infected', blocked: true, finding: arg.finding || null } : arg);
  return s ? { id, scan: s, gone } : null;
}

const isBusy = (e) => !!e && (e.code === 'ERR_BUSY' || e.code === 'SQLITE_BUSY' || /SQLITE_BUSY|database is locked/i.test(String(e.message || '')));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** What a row becomes for item `b`: [state, blocked, finding]. */
const target = (b) => (b.gone ? ['removed', 1, b.scan.finding] : cols(b.scan));
const differs = (r, t) => r.scan_state !== t[0] || (r.scan_blocked || 0) !== t[1] || (r.scan_finding || null) !== t[2];

/** The rows (attachments, files of drafts) of the batch whose state changes → { atts, drafts } with their item. */
async function changesOf(gc, batch) {
  const byId = new Map(batch.map((b) => [b.id, b]));
  const atts = [];
  const drafts = [];
  for (const part of store.chunks([...byId.keys()])) {
    for (const r of await store.all(gc, `SELECT t.id, t.media_id, t.message_id, t.scan_state, t.scan_blocked, t.scan_finding, m.user_id, m.account_id, m.folder_id
      FROM attachments t JOIN messages m ON m.id = t.message_id WHERE t.media_id IN (${store.marks(part.length)})`, part)) {
      const b = byId.get(r.media_id);
      if (b.gone || differs(r, target(b))) atts.push({ r, b });
    }
    for (const r of await store.all(gc, `SELECT x.id, x.media_id, x.draft_id, x.scan_state, x.scan_blocked, x.scan_finding, d.user_id, d.account_id
      FROM draft_atts x JOIN drafts d ON d.id = x.draft_id WHERE x.media_id IN (${store.marks(part.length)})`, part)) {
      if (differs(r, cols(byId.get(r.media_id).scan))) drafts.push({ r, b: byId.get(r.media_id) });
    }
  }
  return { atts, drafts };
}

/** One batch [{ id, scan, gone }] in one transaction — only the rows that change; then the live events. → written */
async function writeBatch(gc, batch) {
  // nothing new (the nightly re-check: clean again): no transaction at all
  const first = await changesOf(gc, batch);
  if (!first.atts.length && !first.drafts.length) return 0;
  const done = await store.tx(gc, async () => {
    const ch = await changesOf(gc, batch);
    // one statement per result (state, blocked, finding), the rows in parts
    const groups = new Map();
    const add = (table, gone, t, id) => {
      const k = JSON.stringify([table, gone, t]);
      if (!groups.has(k)) groups.set(k, { table, gone, t, ids: [] });
      groups.get(k).ids.push(id);
    };
    for (const { r, b } of ch.atts) add('attachments', b.gone, target(b), r.id);
    for (const { r, b } of ch.drafts) add('draft_atts', false, cols(b.scan), r.id);
    for (const g of groups.values()) {
      for (const part of store.chunks(g.ids, store.CHUNK - 3)) {
        await store.run(gc, `UPDATE ${g.table} SET scan_state = ?, scan_blocked = ?, scan_finding = ?${g.gone ? ', media_id = NULL' : ''} WHERE id IN (${store.marks(part.length)})`, [...g.t, ...part]);
      }
    }
    return ch;
  });
  // the live events after the commit, one after the other (not one host call per hook at once)
  for (const { r } of done.atts) await push.changed(gc, r.user_id, r.account_id, r.folder_id, { messageId: r.message_id, attachmentId: r.id });
  const seen = new Set();
  for (const { r } of done.drafts) {
    if (seen.has(r.draft_id)) continue;
    seen.add(r.draft_id);
    await push.changed(gc, r.user_id, r.account_id, null, { draftId: r.draft_id });
  }
  return done.atts.length + done.drafts.length;
}

// mediaId → { id, scan, gone, defers, waiters }; `timer` waits GATHER_MS for more ('gather') or DEFER_MS ('defer')
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
    if (!err) { run.written += out; settle(batch); continue; }
    if (!isBusy(err)) {
      // not the disk: the batch is lost — one line for the batch, not one per file
      gc.log.warn('scan state failed', (err && err.code) || 'error', { files: batch.length });
      settle(batch);
      continue;
    }
    // still busy: the files wait for the next run (their hooks do not wait for it); a newer result that came meanwhile wins
    for (const b of batch) {
      settle([b]);
      if (queue.items.has(b.id)) continue;
      if (b.defers >= MAX_DEFERS) { run.dropped++; continue; }
      queue.items.set(b.id, { ...b, defers: b.defers + 1, waiters: [] });
      run.deferred.add(b.id);
    }
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

/** Start writing — `now`, or after GATHER_MS (a full batch at once); never while a batch is written or waits. */
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

/** The hook mediaScanned({ mediaId, state, blocked, finding }): queued; resolves when written (or unchanged, or deferred). */
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

const isInfected = (e) => !!(e && (e.code === 'ERR_MEDIA_INFECTED' || (e.code === 'ERR_INVALID' && /infected/.test(String(e.message || '')))));

module.exports = { norm, ofRow, held, guard, cols, keepAttachment, removed, isInfected, scanned, flush, _setWaitsForTest, BATCH_MAX };
