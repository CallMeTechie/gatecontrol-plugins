'use strict';

// The virus scan of GateControl (the version after 1.222.0, docs/feature-malware-scan-contract.md of GateControl):
// every file sent in a chat (pictures, voice messages, files, their previews, stories, group pictures) is checked
// right after its upload. The Messenger keeps the result per file (media.scan_*) and shows it on a message as
// `media.scan { state, blocked, finding }`. An older GateControl answers no `scan`: nothing is kept, nothing changes.
//   sending        a file in quarantine → 422 infected ("nicht gesendet – Schadsoftware"), not checkable and blocked →
//                  423 scan_blocked; a file still being checked is sent — the recipients see "Wird geprüft …"
//   reading        a blocked file has no URL, no preview and no push picture ("Datei gesperrt")
//   hook mediaScanned  a later result: the message's state, updated_at and the live event message.update
//
// Writes of the hook (since 1.28.1, as Drive 1.28.1): GateControl calls mediaScanned once per file and does not wait for
// the answer — after the scanner was away (retryPending) or in the nightly re-check hundreds come at once. Each used to
// be written on its own, the hooks piled up host calls until GateControl answered ERR_BUSY (at most 32 open at once per
// plugin) and the states were lost ("scan state failed ERR_BUSY", one line per file). Now they are queued and written
// together: one transaction per batch (what came within GATHER_MS, at most BATCH_MAX; what comes while a batch is
// written is the next one), one batch at a time. A result that changes nothing (the same state, blocked and finding)
// writes nothing and tells nobody. A batch the database refuses as busy (ERR_BUSY, SQLITE_BUSY) is tried again after
// BUSY_WAITS_MS; still busy, its files wait DEFER_MS for the next run (at most MAX_DEFERS times). One line per run says
// how many had to wait, never one per file. After the commit the members of each changed message hear message.update.

const store = require('./store');
const live = require('./live');

const STATES = new Set(['pending', 'clean', 'infected', 'unscannable', 'unchecked']);

/** The host's `scan` → { state, blocked, finding } or null (no scan: an older GateControl). */
function norm(s) {
  if (!s || typeof s !== 'object' || !STATES.has(s.state)) return null;
  return { state: s.state, blocked: s.blocked === true, finding: typeof s.finding === 'string' && s.finding ? s.finding.slice(0, 200) : null };
}

/** The scan of a media row → { state, blocked, finding } or null. */
const ofRow = (m) => (m && m.scan_state ? { state: m.scan_state, blocked: m.scan_blocked === 1, finding: m.scan_finding || null } : null);

/** A file to be sent that the scan holds back → infected (422) or scan_blocked (423); still being checked: sent. */
function refusal(s) {
  if (!s || !s.blocked || s.state === 'pending') return null;
  return s.state === 'infected' ? 'infected' : 'scan_blocked';
}

/** A file already sent that the scan holds back → quarantined / scan_pending / scan_blocked (423), else null. */
function held(s) {
  if (!s || !s.blocked) return null;
  if (s.state === 'pending') return 'scan_pending';
  return s.state === 'infected' ? 'quarantined' : 'scan_blocked';
}

const cols = (s) => (s ? [s.state, s.blocked ? 1 : 0, s.finding] : [null, 0, null]);

// the queue of the hook mediaScanned (see the header)
const BATCH_MAX = 200;
const GATHER_MS = 100;
const BUSY_WAITS_MS = [250, 1000, 3000];
const DEFER_MS = 30000;
const MAX_DEFERS = 10;
// parameters a statement (GateControl's database worker takes at most 100)
const CHUNK = 90;

const same = (a, b) => !!a && !!b && a.state === b.state && a.blocked === b.blocked && a.finding === b.finding;
const chunks = (list, n = CHUNK) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };
const isBusy = (e) => !!e && (e.code === 'ERR_BUSY' || e.code === 'SQLITE_BUSY' || /SQLITE_BUSY|database is locked/i.test(String(e.message || '')));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** The hook's argument → { id, scan } or null ('deleted': the host removed the file — kept as infected and blocked). */
function hookItem(arg) {
  const id = arg && typeof arg.mediaId === 'string' && /^[0-9a-f]{32}$/.test(arg.mediaId) ? arg.mediaId : null;
  if (!id) return null;
  const s = norm(arg.state === 'deleted' ? { state: 'infected', blocked: true, finding: arg.finding || null } : arg);
  return s ? { id, scan: s } : null;
}

/** The kept media rows of `ids` → Map media_id → row */
async function rowsOf(gc, ids) {
  const out = new Map();
  for (const part of chunks(ids)) {
    const rows = await store.all(gc, `SELECT media_id, msg_id, role, scan_state, scan_blocked, scan_finding FROM media WHERE media_id IN (${store.marks(part.length)})`, part);
    for (const r of rows) out.set(r.media_id, r);
  }
  return out;
}

/**
 * One batch of results [{ id, scan }] in one transaction: only files the plugin keeps whose state changes are written;
 * their messages (not stories, not deleted) get updated_at = now. → { written, box } (box: the live events to send
 * after the commit, or null)
 */
async function writeBatch(gc, batch, now) {
  const changedOf = async () => {
    const kept = await rowsOf(gc, batch.map((b) => b.id));
    return batch.filter((b) => kept.has(b.id) && !same(ofRow(kept.get(b.id)), b.scan)).map((b) => ({ ...b, row: kept.get(b.id) }));
  };
  // nothing new (the nightly re-check: clean again; a file the plugin does not know): no transaction at all
  if (!(await changedOf()).length) return { written: 0, box: null };
  return store.tx(gc, async () => {
    const changed = await changedOf();
    // one UPDATE per result (state, blocked, finding), the files of a result together
    const byScan = new Map();
    for (const b of changed) {
      const k = JSON.stringify(cols(b.scan));
      if (!byScan.has(k)) byScan.set(k, []);
      byScan.get(k).push(b.id);
    }
    for (const [k, ids] of byScan) {
      for (const part of chunks(ids, CHUNK - 3)) {
        await store.run(gc, `UPDATE media SET scan_state = ?, scan_blocked = ?, scan_finding = ? WHERE media_id IN (${store.marks(part.length)})`, [...JSON.parse(k), ...part]);
      }
    }
    // the messages of the changed files (a story keeps its own view)
    const msgIds = [...new Set(changed.filter((b) => b.row.msg_id != null && b.row.role !== 'story' && b.row.role !== 'story_thumb').map((b) => b.row.msg_id))];
    const msgs = new Map();
    for (const part of chunks(msgIds)) {
      for (const r of await store.all(gc, `SELECT id, conv_id FROM messages WHERE id IN (${store.marks(part.length)}) AND deleted_at IS NULL`, part)) msgs.set(r.id, r);
    }
    const ids = [...msgs.keys()];
    for (const part of chunks(ids, CHUNK - 1)) await store.run(gc, `UPDATE messages SET updated_at = ? WHERE id IN (${store.marks(part.length)})`, [now, ...part]);
    const members = new Map();
    for (const part of chunks([...new Set([...msgs.values()].map((m) => m.conv_id))])) {
      for (const r of await store.all(gc, `SELECT conv_id, user_id FROM members WHERE conv_id IN (${store.marks(part.length)}) AND left_at IS NULL`, part)) {
        if (!members.has(r.conv_id)) members.set(r.conv_id, []);
        members.get(r.conv_id).push(r.user_id);
      }
    }
    const box = live.outbox();
    // editedAt: the time of the change, as clients fetch messages?changedSince= with it (the message's own editedAt stays)
    const editedAt = new Date(now).toISOString();
    for (const b of changed) {
      const msg = msgs.get(b.row.msg_id);
      if (!msg || b.row.role === 'story' || b.row.role === 'story_thumb') continue;
      live.queue(box, members.get(msg.conv_id) || [], 'message.update', { conversationId: msg.conv_id, messageId: msg.id, editedAt, scan: b.scan });
    }
    return { written: changed.length, box };
  });
}

// The queue of the hook (one per plugin process): mediaId → { id, scan, defers, waiters }; `timer` waits GATHER_MS for
// more results ('gather') or DEFER_MS after a busy database ('defer')
const queue = { items: new Map(), draining: null, timer: null, timerKind: null, run: null, gc: null,
  waits: BUSY_WAITS_MS, deferMs: DEFER_MS };

/** Settle the waiters of `items` (the hooks that sent them). */
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
      try { out = await writeBatch(gc, batch, Date.now()); err = null; break; } catch (e) {
        err = e;
        if (!isBusy(e) || i >= queue.waits.length) break;
        await pause(queue.waits[i]);
      }
    }
    if (out) {
      run.written += out.written;
      // the members hear it before the hooks answer (live.flush logs a refusal, never throws)
      if (out.box) {
        try { await live.flush(gc, out.box); } catch (e) { gc.log.warn('scan change not announced', (e && e.code) || 'error'); }
      }
      settle(batch);
      continue;
    }
    if (!isBusy(err)) {
      // not the disk: the batch is lost (the next send / read asks GateControl again) — one line for the batch
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
 * written and its message's members were told (or skipped as unchanged, or deferred). Never throws.
 */
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

module.exports = { norm, ofRow, refusal, held, cols, scanned, flush, writeBatch, BATCH_MAX, MAX_DEFERS, _setWaitsForTest };
