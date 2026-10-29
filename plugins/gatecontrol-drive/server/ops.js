'use strict';

// Several files and folders at once (since 1.12.0, feature `bulk`): move, copy, trash, restore and purge as one job
// with progress, cancel and undo — the selection of the apps and the portal.
//
//   POST   ops/check  { op: 'move'|'copy'|'trash'|'restore'|'purge', ids, target? }
//                     → { files, folders, bytes, items, conflicts: [{ id, name, path, isDir, existing: { id, size, mtime,
//                       isDir }, same }], conflictsMore, merges, blocked: [{ id, name, reason }], quota: { needed, free }
//                       | null, limit }
//   POST   ops        { op, ids, target?, onConflict?: 'version'|'rename'|'skip' } → { op }
//   GET    ops        ?state=running|done|failed|cancelled → { ops } (mine, newest first; without state: the running ones
//                     and those that ended in the last hour)
//   GET    ops/<id>   → { op } · DELETE ops/<id> → { op } (cancelled: what is done stays) · POST ops/<id>/undo → { op }
//   POST   ops/<id>/transfers { limit?, maxSize? } → { transfers, left }
//   POST   ops/<id>/transfers/<n> { mediaId } | { failed: true } → { op, node? } — the bytes of a copy (below)
//
// A job runs as its person (their rights, their device — the change log, the live event 'changed', the ransomware
// protection and the sync of every device see each node it moves, makes or trashes like a single request's). A small
// one is done within its request; the rest goes on in the plugin process right after the answer and, after a restart,
// in the background run — the live event 'op' { op } (at most one a second, and the last) tells the person.
//
// Rules per id (`blocked`): not_found, forbidden (no right — a parent in a child's folder, a reader, an archived team
// folder; copying needs the right to read only), root (the top folder of an area), into_itself (a folder into itself
// or below it), same_folder (a move to where it is), encrypted (a vault: nothing goes into or out of one, its folder
// never moves nor is copied; inside the same vault move, copy and trash work — names and contents stay ciphertext),
// locked (a document someone edits in the browser right now — move and trash). A node inside another selected folder
// goes with that folder.
//
// The same name at the target (onConflict, default 'version'): a file onto a file — the same content (SHA-256 and
// size) counts as done and nothing is stored twice (a move puts the moved one into the trash); 'version': it becomes
// the new content of the file there (its own older versions go with it — a move of this kind cannot be undone);
// 'rename': both stay ("Brief (2).pdf"); 'skip': it stays where it is. A folder onto a folder: they are merged (the
// rule then applies to what is in it). A file onto a folder or the other way round: 'skip' skips, otherwise both stay.
//
// Copying: files with their current content (no older versions, no links, no AI suggestions — AI for documents looks
// at the copies by the area's setting), folders with everything in them. GateControl's media API has no copy of a file
// (≤ 1.214): the bytes are brought by a device — the job's op says transfer 'client' and transfersLeft; a device takes
// up to 20 at a time (POST ops/<id>/transfers { limit, maxSize } → { transfers: [{ id, nodeId, name, size, sha256,
// mime, url, encrypted?, vaultId?, nameCipher? }], left }, leased to it for 15 minutes), downloads each `url` (signed
// for the person, 1 h), uploads it like any file (PUT …/media, resumable) and hands the mediaId over (POST
// ops/<id>/transfers/<id> { mediaId } — the SHA-256 must be the original's; { failed: true } gives one up). GateControl
// ≥ 1.215.0 copies on the server (gc.media.copy, feature copyServer): transfer 'server', no device, the job goes on in
// the plugin process and the background run like any other. Empty files and folders need no bytes. A copy nobody
// brings bytes for in 24 h ends as failed (abandoned). `maxSize`: only files up to that size (the portal: 100 MB).
//
// Undo (POST ops/<id>/undo, until undoUntil — 15 minutes after the end): a move goes back, a trash comes out of the
// trash, the copies go into the trash (a copy that became the new content of a file: the content before comes back).
// What changed since is skipped and reported. The undo is a job of its own (kind 'undo', undoOf).
//
// Limits: 10 000 ids, 10 000 nodes after the folders are counted (413 too_large { max }), 5 running jobs a person (409
// job_limit { max }), the room for a copy or a move into another area (507 quota { needed, free }).

const crypto = require('node:crypto');
const store = require('./store');
const nodes = require('./nodes');
const files = require('./files');
const areas = require('./areas');
const guard = require('./guard');
const { fail, posInt, iso, line } = require('./util');

const vaults = () => require('./vault');

const KINDS = ['move', 'copy', 'trash', 'restore', 'purge'];
const CONFLICTS = ['version', 'rename', 'skip'];
const STATES = ['running', 'done', 'failed', 'cancelled'];
const IDS_MAX = 10000;
const NODES_MAX = 10000;
const RUNNING_MAX = 5;
const UNDO_MS = 15 * 60000;
const INLINE_MS = 5000;
const SLICE_MS = 5000;
const KEEP_MS = 7 * 86400000;
const ABANDON_MS = 86400000;
const LEASE_MS = 15 * 60000;
const TRANSFERS_MAX = 20;
const FAILURES_MAX = 100;
const RESULTS_MAX = 500;
const CONFLICTS_MAX = 500;
const EVENT_MS = 1000;
const LIST_MAX = 50;
const RECENT_MS = 3600000;
const OP_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const UNDOABLE = ['move', 'copy', 'trash'];

const json = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch { return d; } };

// ─── Arguments ──────────────────────────────────

function idsArg(v) {
  if (!Array.isArray(v) || !v.length || v.length > IDS_MAX) throw fail('invalid', { field: 'ids', max: IDS_MAX });
  const out = [];
  const seen = new Set();
  for (const x of v) {
    const n = posInt(x);
    if (!n) throw fail('invalid', { field: 'ids' });
    if (!seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out;
}

function argsOf(body) {
  const b = body && typeof body === 'object' ? body : {};
  const kind = String(b.op == null ? '' : b.op);
  if (!KINDS.includes(kind)) throw fail('invalid', { field: 'op' });
  const ids = idsArg(b.ids);
  let target = null;
  if (kind === 'move' || kind === 'copy') {
    target = posInt(b.target);
    if (!target) throw fail('invalid', { field: 'target' });
  }
  const onConflict = b.onConflict == null ? 'version' : String(b.onConflict);
  if (!CONFLICTS.includes(onConflict)) throw fail('invalid', { field: 'onConflict' });
  return { kind, ids, target, onConflict };
}

/** The folder a move or a copy goes into: one the person may write to. */
async function targetOf(ctx, id) {
  const r = await nodes.reach(ctx, id, 'write');
  if (r.node.is_dir !== 1) throw fail('invalid', { field: 'target' });
  if (r.area.archived_at != null) throw fail('forbidden');
  return r;
}

// ─── Looking at a selection ─────────────────────

const liveChildren = (gc, id) => store.all(gc, 'SELECT * FROM nodes WHERE parent_id = ? AND deleted_at IS NULL ORDER BY is_dir DESC, name COLLATE NOCASE, id', [id]);

async function above(gc, id) {
  const rows = await store.all(gc, `WITH RECURSIVE up(id, parent_id) AS (
      SELECT id, parent_id FROM nodes WHERE id = ?
      UNION ALL SELECT p.id, p.parent_id FROM nodes p JOIN up ON p.id = up.parent_id)
    SELECT id FROM up`, [id]);
  return new Set(rows.map((r) => r.id));
}

/** Live nodes below folder `id` (not `id`). */
async function liveBelow(gc, id) {
  return (await nodes.below(gc, id)).filter((r) => r.deleted_at == null);
}

async function officeLocked(gc, n, now) {
  const r = await store.one(gc, `SELECT 1 AS x FROM office_locks WHERE expires_at > ? AND node_id IN (WITH RECURSIVE down(id) AS (
      SELECT ? UNION ALL SELECT c.id FROM nodes c JOIN down ON c.parent_id = down.id) SELECT id FROM down) LIMIT 1`, [now, n.id]);
  return !!r;
}

const sameContent = (a, b) => a.is_dir === 0 && b.is_dir === 0 && a.size === b.size && !!a.sha256 && a.sha256 === b.sha256;

/**
 * The ids of a job: those it may handle (with their node, area, files and bytes) and those it may not (blocked). A node
 * inside another selected folder goes with that one.
 */
async function examine(ctx, kind, ids, target) {
  const gc = ctx.gc;
  const ok = [];
  const blocked = [];
  const visible = await ctx.visible();
  const up = target ? await above(gc, target.node.id) : null;
  const trashBin = kind === 'restore' || kind === 'purge';
  // documents open in the browser right now (office.js) — looked at only while there are any
  const locks = (kind === 'move' || kind === 'trash') && (await store.one(gc, 'SELECT COUNT(*) AS n FROM office_locks WHERE expires_at > ?', [ctx.now])).n > 0;
  for (const id of ids) {
    const n = await nodes.row(gc, id);
    const no = (reason) => blocked.push({ id, name: n ? n.name : null, reason, ...(n && n.vault_id ? { encrypted: true, nameCipher: n.name_cipher || null } : {}) });
    if (!n || (trashBin ? n.trash_id !== n.id : n.deleted_at != null)) { no('not_found'); continue; }
    const v = visible.find((x) => x.area.id === n.area_id);
    if (!v) { no('not_found'); continue; }
    if (!areas.can(v.role, kind === 'copy' ? 'read' : 'write') || (kind !== 'copy' && v.area.archived_at != null)) { no('forbidden'); continue; }
    if (n.parent_id == null) { no('root'); continue; }
    if (kind === 'move' || kind === 'copy') {
      const vault = n.vault_id ? await vaults().row(gc, n.vault_id) : null;
      if ((vault && vault.node_id === n.id) || (n.vault_id || null) !== (target.node.vault_id || null)) { no('encrypted'); continue; }
      if (up.has(n.id)) { no('into_itself'); continue; }
      if (kind === 'move' && n.parent_id === target.node.id) { no('same_folder'); continue; }
      // a folder that holds a vault (an older one): the vault stays where it is
      if (n.is_dir === 1 && !n.vault_id && (kind === 'copy' || target.area.id !== n.area_id)
        && (await liveBelow(gc, n.id)).some((r) => r.vault_id)) { no('encrypted'); continue; }
    }
    if (locks && await officeLocked(gc, n, ctx.now)) { no('locked'); continue; }
    ok.push({ node: n, area: v.area, role: v.role, via: v.via });
  }
  // a node below another selected folder goes with it
  const folders = new Set(ok.filter((x) => x.node.is_dir === 1).map((x) => x.node.id));
  const out = [];
  for (const x of ok) {
    if (folders.size && [...await above(gc, x.node.parent_id)].some((a) => folders.has(a))) continue;
    out.push(x);
  }
  for (const x of out) {
    if (trashBin) {
      const s = await store.one(gc, 'SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM nodes WHERE trash_id = ? AND is_dir = 0', [x.node.id]);
      const d = await store.one(gc, 'SELECT COUNT(*) AS n FROM nodes WHERE trash_id = ? AND is_dir = 1', [x.node.id]);
      Object.assign(x, { files: s.n, folders: d.n, bytes: s.b, nodes: s.n + d.n });
    } else if (x.node.is_dir === 1) {
      const rows = await liveBelow(gc, x.node.id);
      const f = rows.filter((r) => r.is_dir === 0);
      Object.assign(x, { below: rows, files: f.length, folders: rows.length - f.length + 1, bytes: f.reduce((s, r) => s + (r.size || 0), 0), nodes: rows.length + 1 });
    } else Object.assign(x, { files: 1, folders: 0, bytes: x.node.size || 0, nodes: 1 });
  }
  return { ok: out, blocked };
}

/**
 * The names a move or a copy finds at the target (folders of the same name merge: what is in them is looked at too)
 * → { conflicts, more, merges, same } (same: files whose content is there already).
 */
async function conflictsOf(ctx, list, dest, out = { conflicts: [], more: 0, merges: 0, sameBytes: 0 }, prefix = '') {
  for (const src of list) {
    if (src.vault_id) continue; // opaque names never meet
    const ex = await nodes.taken(ctx.gc, dest.area_id, dest.id, src.name, 0);
    if (!ex) continue;
    // folders of the same name merge — a copy of a folder into the folder it is in gets a name of its own
    if (ex.is_dir === 1 && src.is_dir === 1 && ex.id !== src.id) {
      out.merges++;
      await conflictsOf(ctx, await liveChildren(ctx.gc, src.id), ex, out, `${prefix}${src.name}/`);
      continue;
    }
    const same = sameContent(src, ex);
    if (same) out.sameBytes += src.size || 0;
    if (out.conflicts.length >= CONFLICTS_MAX) { out.more++; continue; }
    out.conflicts.push({
      id: src.id, name: src.name, path: prefix + src.name, isDir: src.is_dir === 1,
      size: src.is_dir === 1 ? null : src.size, mtime: iso(src.mtime == null ? src.updated_at : src.mtime),
      existing: { id: ex.id, size: ex.is_dir === 1 ? null : ex.size, mtime: iso(ex.mtime == null ? ex.updated_at : ex.mtime), isDir: ex.is_dir === 1 },
      same,
    });
  }
  return out;
}

/** Free bytes where new files of area `a` go (its quota, the plugin's, the place's room) — null: no limit known. */
async function room(gc, a) {
  let free = Infinity;
  try {
    const i = await gc.media.areas.info(a.media_area);
    if (i && Number.isFinite(i.quota) && i.quota != null) free = Math.min(free, i.quota - (i.bytes || 0));
    if (i && Number.isFinite(i.free)) free = Math.min(free, i.free);
  } catch { /* unknown */ }
  try {
    const u = await gc.media.usage();
    if (u && Number.isFinite(u.quota) && u.quota != null) free = Math.min(free, u.quota - (u.bytes || 0));
  } catch { /* unknown */ }
  return free === Infinity ? null : Math.max(0, free);
}

/** What a selection means → the answer of ops/check and the plan of a job. */
async function survey(ctx, a) {
  const target = a.target ? await targetOf(ctx, a.target) : null;
  const { ok, blocked } = await examine(ctx, a.kind, a.ids, target);
  const sum = (k) => ok.reduce((s, x) => s + (x[k] || 0), 0);
  const out = { target, ok, blocked, files: sum('files'), folders: sum('folders'), bytes: sum('bytes'), nodes: sum('nodes') };
  out.conflicts = { conflicts: [], more: 0, merges: 0, sameBytes: 0 };
  if (target) out.conflicts = await conflictsOf(ctx, ok.map((x) => x.node), target.node);
  out.quota = null;
  // the room for what a copy stores, or what a move brings into another area
  const needed = a.kind === 'copy' ? Math.max(0, out.bytes - out.conflicts.sameBytes)
    : a.kind === 'move' ? ok.filter((x) => x.area.id !== target.area.id).reduce((s, x) => s + x.bytes, 0) : 0;
  if (needed > 0) {
    const free = await room(ctx.gc, target.area);
    out.quota = { needed, free };
  }
  return out;
}

/** POST ops/check */
async function check(ctx, body) {
  const a = argsOf(body);
  const s = await survey(ctx, a);
  return {
    items: s.ok.length, files: s.files, folders: s.folders, bytes: s.bytes,
    conflicts: s.conflicts.conflicts, conflictsMore: s.conflicts.more, merges: s.conflicts.merges,
    blocked: s.blocked, quota: s.quota, limit: NODES_MAX, tooMany: s.nodes > NODES_MAX,
  };
}

// ─── The job ────────────────────────────────────

async function opRow(gc, id) {
  return typeof id === 'string' && OP_ID_RE.test(id) ? store.one(gc, 'SELECT * FROM ops WHERE id = ?', [id]) : null;
}

async function mine(ctx, id) {
  const op = await opRow(ctx.gc, id);
  if (!op || op.user_id !== ctx.viewer) throw fail('not_found');
  return op;
}

// GateControl's copy of a media file (≥ 1.215.0: gc.media.copy(mediaId, { area }) → { id, size, sha256, mime }, a new
// file of its own, done on the server — a hard link, S3's CopyObject or a stream); `copyHook` stands in for it in the tests
let copyHook = null;
const copier = (gc) => copyHook || (gc.media && typeof gc.media.copy === 'function' ? (id, o) => gc.media.copy(id, o) : null);
const hostCopy = (gc) => !!copier(gc);

/**
 * Media file `mediaId` at `path` of media area `mediaArea`: a fresh upload is claimed there; a file GateControl copied
 * (already in an area) gets its path — and its area — with a move.
 */
async function place(gc, mediaId, mediaArea, path) {
  const info = await gc.media.info(mediaId);
  if (info && info.claimed && info.area) {
    await gc.media.move(mediaId, { path, ...(info.area !== mediaArea ? { area: mediaArea } : {}) });
    return;
  }
  await gc.media.claim(mediaId, { area: mediaArea, path });
}

/** The job as the apps see it. */
async function view(gc, op) {
  const now = Date.now();
  const r = json(op.results, {});
  const left = op.kind === 'copy' && op.state === 'running'
    ? (await store.one(gc, "SELECT COUNT(*) AS n FROM op_items WHERE op_id = ? AND state = 'transfer'", [op.id])).n : 0;
  return {
    id: op.id, kind: op.kind, state: op.state, items: op.items, total: op.total, done: op.done,
    bytesTotal: op.bytes_total, bytesDone: op.bytes_done, label: op.label || null, onConflict: op.on_conflict,
    ...(op.target_id ? { targetId: op.target_id, targetAreaId: op.target_area, targetPath: op.target_path || '', targetName: op.target_name || null } : {}),
    ...(op.kind === 'copy' ? { transfer: hostCopy(gc) ? 'server' : 'client', transfersLeft: left } : {}),
    results: { done: op.n_done, skipped: op.n_skipped, failedCount: op.n_failed, failed: json(op.failures, []), resultIds: r.ids || [] },
    createdAt: iso(op.created_at), updatedAt: iso(op.updated_at), finishedAt: iso(op.finished_at),
    ...(op.undo_until && !op.undone_by && op.undo_until > now && op.state !== 'running' ? { undoUntil: iso(op.undo_until) } : {}),
    ...(op.undo_of ? { undoOf: op.undo_of } : {}), ...(op.undone_by ? { undoneBy: op.undone_by } : {}),
    ...(op.error ? { error: op.error } : {}),
  };
}

const lastEvent = new Map();

/** The live event 'op' to the person (at most one a second per job, the last always). */
async function announce(gc, op, force = false) {
  if (typeof (gc.events && gc.events.emit) !== 'function') return;
  const now = Date.now();
  if (!force && now - (lastEvent.get(op.id) || 0) < EVENT_MS) return;
  lastEvent.set(op.id, now);
  if (force) lastEvent.delete(op.id);
  try { await gc.events.emit({ users: [op.user_id], type: 'op', data: { op: await view(gc, op) } }); } catch (e) { gc.log.warn('op event failed', (e && e.code) || 'error'); }
}

async function insertItems(gc, opId, rows) {
  const cols = ['op_id', 'seq', 'node_id', 'parent_seq', 'is_dir', 'name', 'size', 'files', 'sha256', 'state', 'reason', 'step_seq'];
  const per = Math.floor(store.CHUNK / cols.length);
  for (let i = 0; i < rows.length; i += per) {
    const part = rows.slice(i, i + per);
    await store.run(gc, `INSERT INTO op_items (${cols.join(', ')}) VALUES ${part.map(() => `(${store.marks(cols.length)})`).join(', ')}`,
      part.flatMap((r) => [opId, r.seq, r.node_id, r.parent_seq == null ? null : r.parent_seq, r.is_dir ? 1 : 0, r.name == null ? null : r.name,
        r.size || 0, r.files || 0, r.sha256 || null, r.state || 'pending', r.reason || null, r.step_seq == null ? null : r.step_seq]));
  }
}

/** A copy's rows: every node below each id, a folder before what is in it. */
function copyRows(ok) {
  const rows = [];
  let seq = 0;
  for (const x of ok) {
    const top = ++seq;
    rows.push({ seq: top, node_id: x.node.id, parent_seq: null, is_dir: x.node.is_dir === 1, name: x.node.name, size: x.node.is_dir === 1 ? 0 : x.node.size, files: x.node.is_dir === 1 ? 0 : 1, sha256: x.node.sha256 });
    if (x.node.is_dir !== 1) continue;
    const kids = new Map();
    for (const r of x.below) { if (!kids.has(r.parent_id)) kids.set(r.parent_id, []); kids.get(r.parent_id).push(r); }
    const queue = [[x.node.id, top]];
    while (queue.length) {
      const [pid, pseq] = queue.shift();
      for (const r of (kids.get(pid) || []).sort((p, q) => q.is_dir - p.is_dir || p.id - q.id)) {
        const s = ++seq;
        rows.push({ seq: s, node_id: r.id, parent_seq: pseq, is_dir: r.is_dir === 1, name: r.name, size: r.is_dir === 1 ? 0 : r.size, files: r.is_dir === 1 ? 0 : 1, sha256: r.sha256 });
        if (r.is_dir === 1) queue.push([r.id, s]);
      }
    }
  }
  return rows;
}

const newId = () => crypto.randomBytes(16).toString('base64url');

/** POST ops → { op } (a small job is done; a larger one goes on — hooks: { gc, asPerson, finish }). */
async function create(ctx, body, hooks) {
  const a = argsOf(body);
  const running = await store.one(ctx.gc, "SELECT COUNT(*) AS n FROM ops WHERE user_id = ? AND state = 'running'", [ctx.viewer]);
  if (running.n >= RUNNING_MAX) throw fail('job_limit', { max: RUNNING_MAX });
  const s = await survey(ctx, a);
  if (s.nodes > NODES_MAX) throw fail('too_large', { max: NODES_MAX });
  if (s.quota && s.quota.free != null && s.quota.needed > s.quota.free) throw fail('quota', { needed: s.quota.needed, free: s.quota.free });
  for (const x of s.ok) if (x.via === 'parent') await ctx.noteChildView(x.area);
  const id = newId();
  const now = Date.now();
  const target = s.target;
  const first = s.ok[0] || null;
  const rows = a.kind === 'copy' ? copyRows(s.ok)
    : s.ok.map((x, i) => ({ seq: i + 1, node_id: x.node.id, is_dir: x.node.is_dir === 1, name: x.node.name, size: x.bytes, files: x.files }));
  let seq = rows.length;
  for (const b of s.blocked) rows.push({ seq: ++seq, node_id: b.id, name: b.name, state: 'failed', reason: b.reason });
  const failures = s.blocked.slice(0, FAILURES_MAX).map((b) => ({ id: b.id, name: b.name, reason: b.reason }));
  const label = first ? (first.node.vault_id ? null : first.node.name) : null;
  await store.tx(ctx.gc, async () => {
    await store.run(ctx.gc, `INSERT INTO ops (id, user_id, device, app, kind, state, ids, target_id, target_area, target_path, target_name, on_conflict, label,
        items, total, bytes_total, n_failed, failures, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, ctx.viewer, ctx.deviceId || null, ctx.app ? 1 : 0, a.kind, JSON.stringify(a.ids), target ? target.node.id : null, target ? target.area.id : null,
      target ? await nodes.pathOf(ctx.gc, target.node) : null, target ? (target.node.parent_id == null ? ctx.areaLabel(target.area) : (target.node.vault_id ? null : target.node.name)) : null,
      a.onConflict, label, a.ids.length, s.files, s.bytes, s.blocked.length, JSON.stringify(failures), now, now]);
    await insertItems(ctx.gc, id, rows);
  });
  let op = await opRow(ctx.gc, id);
  op = await work(ctx, op, Date.now() + INLINE_MS);
  if (op.state === 'running') later(hooks);
  return { op: await view(ctx.gc, op) };
}

// ─── Working ────────────────────────────────────

/** Bookkeeping of one row: its end state, the job's counts, a failure, a result id. */
async function settle(gc, op, item, state, o = {}) {
  await store.run(gc, 'UPDATE op_items SET state = ?, reason = ?, result_id = COALESCE(?, result_id), lease_until = NULL WHERE op_id = ? AND seq = ?',
    [state, o.reason || null, o.resultId == null ? null : o.resultId, op.id, item.seq]);
  const counted = op.kind === 'copy' ? item.is_dir !== 1 : true;
  const done = state === 'done';
  const fields = ['done = done + ?', 'bytes_done = bytes_done + ?', 'updated_at = ?'];
  const params = [item.files || 0, item.size || 0, Date.now()];
  if (counted || !done) {
    fields.push(done ? 'n_done = n_done + 1' : state === 'skipped' ? 'n_skipped = n_skipped + 1' : 'n_failed = n_failed + 1');
  }
  await store.run(gc, `UPDATE ops SET ${fields.join(', ')} WHERE id = ?`, [...params, op.id]);
  if (state === 'failed' || (state === 'skipped' && o.reason !== 'parent')) {
    if (state === 'failed') {
      const cur = await store.one(gc, 'SELECT failures FROM ops WHERE id = ?', [op.id]);
      const list = json(cur && cur.failures, []);
      if (list.length < FAILURES_MAX) {
        list.push({ id: item.node_id, name: item.name || null, reason: o.reason || 'error' });
        await store.run(gc, 'UPDATE ops SET failures = ? WHERE id = ?', [JSON.stringify(list), op.id]);
      }
    }
  }
  // the top nodes at the target (the apps mark them "neu hier")
  if (done && o.resultId != null && item.parent_seq == null && op.kind !== 'trash' && op.kind !== 'purge') {
    const cur = await store.one(gc, 'SELECT results FROM ops WHERE id = ?', [op.id]);
    const r = json(cur && cur.results, {});
    r.ids = r.ids || [];
    if (r.ids.length < RESULTS_MAX && !r.ids.includes(o.resultId)) {
      r.ids.push(o.resultId);
      await store.run(gc, 'UPDATE ops SET results = ? WHERE id = ?', [JSON.stringify(r), op.id]);
    }
  }
}

async function step(gc, op, action, nodeId, data) {
  const r = await store.one(gc, 'SELECT COALESCE(MAX(seq), 0) AS s FROM op_steps WHERE op_id = ?', [op.id]);
  await store.run(gc, 'INSERT INTO op_steps (op_id, seq, action, node_id, data) VALUES (?, ?, ?, ?, ?)', [op.id, r.s + 1, action, nodeId, data == null ? null : JSON.stringify(data)]);
}

/** The end of a job: its state, when it may be undone, the last event. */
async function finish(gc, op, state, error = null) {
  const now = Date.now();
  if (state !== 'done') {
    await store.run(gc, "UPDATE op_items SET state = 'cancelled', lease_until = NULL WHERE op_id = ? AND state IN ('pending', 'transfer')", [op.id]);
  }
  const steps = await store.one(gc, 'SELECT COUNT(*) AS n FROM op_steps WHERE op_id = ?', [op.id]);
  const undo = UNDOABLE.includes(op.kind) && steps.n > 0 ? now + UNDO_MS : null;
  await store.run(gc, "UPDATE ops SET state = ?, error = COALESCE(?, error), finished_at = ?, updated_at = ?, undo_until = ? WHERE id = ? AND state = 'running'",
    [state, error, now, now, undo, op.id]);
  if (op.undo_of && state !== 'failed') {
    await store.run(gc, 'UPDATE ops SET undone_by = ?, undo_until = NULL WHERE id = ?', [op.id, op.undo_of]);
  }
  const out = await opRow(gc, op.id);
  await announce(gc, out, true);
  return out;
}

/** The rights may have changed: the item's error codes as they are reported. */
const reasonOf = (e) => {
  const c = e && e.code;
  if (c === 'ERR_MEDIA_QUOTA' || c === 'quota') return 'quota';
  if (c === 'ERR_CONFLICT' || c === 'exists' || c === 'conflict') return 'exists';
  if (c === 'forbidden' || c === 'not_found' || c === 'invalid' || c === 'encrypted' || c === 'device_locked') return c === 'invalid' ? 'invalid' : c;
  return 'error';
};

/**
 * Work on job `op` until `until` (ms) → the job as it is then. `ctx`: its person (a request's or the background run's).
 */
async function work(ctx, op, until) {
  const gc = ctx.gc;
  let cur = op;
  for (;;) {
    cur = await opRow(gc, op.id);
    if (!cur || cur.state !== 'running') return cur;
    if (Date.now() > until) return cur;
    // a device the ransomware protection stopped: its job stops too
    if (cur.app === 1 && ctx.deviceId && await guard.lockOf(ctx)) return finish(gc, cur, 'failed', 'device_locked');
    const item = await store.one(gc, "SELECT * FROM op_items WHERE op_id = ? AND state = 'pending' ORDER BY seq LIMIT 1", [cur.id]);
    if (!item) {
      const waiting = await store.one(gc, "SELECT COUNT(*) AS n FROM op_items WHERE op_id = ? AND state = 'transfer'", [cur.id]);
      if (waiting.n) return cur;
      return finish(gc, cur, 'done');
    }
    ctx.now = Date.now();
    try {
      await handle(ctx, cur, item);
    } catch (e) {
      if (reasonOf(e) === 'error') gc.log.warn('op item failed', cur.kind, (e && (e.code || e.message)) || 'error', e && e.message);
      if (e && e.code === 'quota' && cur.kind === 'copy') {
        await settle(gc, cur, item, 'failed', { reason: 'quota' });
        return finish(gc, await opRow(gc, cur.id), 'failed', 'quota');
      }
      await settle(gc, cur, item, 'failed', { reason: reasonOf(e) });
    }
    // the ransomware protection looks at what this device just did (index.js does so after a request too)
    if (ctx.guardNoted) {
      ctx.guardNoted = false;
      try { const inc = await guard.check(ctx); if (inc) ctx.guardIncident = inc; } catch (e) { gc.log.warn('guard check failed', (e && e.code) || 'error'); }
    }
    await announce(gc, await opRow(gc, cur.id));
  }
}

async function handle(ctx, op, item) {
  if (op.kind === 'move') return moveItem(ctx, op, item);
  if (op.kind === 'copy') return copyItem(ctx, op, item);
  if (op.kind === 'trash') {
    const n = await nodes.row(ctx.gc, item.node_id);
    if (!n || n.deleted_at != null) return settle(ctx.gc, op, item, 'failed', { reason: 'not_found' });
    if (await officeLocked(ctx.gc, n, ctx.now)) return settle(ctx.gc, op, item, 'failed', { reason: 'locked' });
    await nodes.trash(ctx, n.id);
    const t = await nodes.row(ctx.gc, n.id);
    await step(ctx.gc, op, 'trashed', n.id, { at: t.deleted_at });
    return settle(ctx.gc, op, item, 'done');
  }
  if (op.kind === 'restore') {
    const v = await nodes.restore(ctx, item.node_id);
    return settle(ctx.gc, op, item, 'done', { resultId: v.id });
  }
  if (op.kind === 'purge') {
    await nodes.purge(ctx, item.node_id);
    return settle(ctx.gc, op, item, 'done');
  }
  if (op.kind === 'undo') return undoItem(ctx, op, item);
  return settle(ctx.gc, op, item, 'failed', { reason: 'invalid' });
}

// ─── Move ───────────────────────────────────────

async function moveItem(ctx, op, item) {
  const gc = ctx.gc;
  const n = await nodes.row(gc, item.node_id);
  if (!n || n.deleted_at != null) return settle(gc, op, item, 'failed', { reason: 'not_found' });
  const dest = await nodes.row(gc, op.target_id);
  if (!dest || dest.deleted_at != null) return settle(gc, op, item, 'failed', { reason: 'not_found' });
  if (n.parent_id === dest.id) return settle(gc, op, item, 'skipped', { reason: 'same_folder' });
  if (await officeLocked(gc, n, ctx.now)) return settle(gc, op, item, 'failed', { reason: 'locked' });
  const r = await moveNode(ctx, op, n, dest);
  return settle(gc, op, item, r.state, { reason: r.reason, resultId: r.resultId });
}

/** Node `n` into folder `dest` by the job's rule → { state, reason?, resultId? }. */
async function moveNode(ctx, op, n, dest) {
  const gc = ctx.gc;
  const ex = n.vault_id ? null : await nodes.taken(gc, dest.area_id, dest.id, n.name, n.id);
  const from = { parentId: n.parent_id, name: n.name, areaId: n.area_id };
  if (!ex) {
    await nodes.update(ctx, n.id, { parentId: dest.id });
    await step(gc, op, 'moved', n.id, { from, to: { parentId: dest.id, name: n.name } });
    return { state: 'done', resultId: n.id };
  }
  if (ex.is_dir === 1 && n.is_dir === 1) {
    // the same folder there: what is in it goes into that one, the empty folder into the trash
    let skipped = 0;
    for (const c of await liveChildren(gc, n.id)) {
      try {
        const r = await moveNode(ctx, op, c, ex);
        if (r.state !== 'done') skipped++;
      } catch (e) { skipped++; if (!(e && typeof e.code === 'string')) gc.log.warn('op move failed', (e && e.message) || 'error'); }
    }
    if (!skipped && !(await liveChildren(gc, n.id)).length) {
      await nodes.trash(ctx, n.id);
      const t = await nodes.row(gc, n.id);
      await step(gc, op, 'trashed', n.id, { at: t.deleted_at });
    }
    return skipped ? { state: 'skipped', reason: 'partly', resultId: ex.id } : { state: 'done', resultId: ex.id };
  }
  if (sameContent(n, ex)) {
    // the same content is there: nothing is stored twice — this one goes into the trash
    await nodes.trash(ctx, n.id);
    const t = await nodes.row(gc, n.id);
    await step(gc, op, 'trashed', n.id, { at: t.deleted_at });
    return { state: 'done', reason: 'same', resultId: ex.id };
  }
  if (op.on_conflict === 'skip') return { state: 'skipped', reason: 'exists' };
  if (op.on_conflict === 'version' && n.is_dir === 0 && ex.is_dir === 0) {
    await mergeVersion(ctx, n, ex);
    await step(gc, op, 'merged', ex.id, { from: n.id });
    return { state: 'done', reason: 'version', resultId: ex.id };
  }
  const name = await nodes.freeName(gc, dest.area_id, dest.id, n.name, n.id);
  await nodes.update(ctx, n.id, { parentId: dest.id, name });
  await step(gc, op, 'moved', n.id, { from, to: { parentId: dest.id, name } });
  return { state: 'done', reason: 'renamed', resultId: n.id };
}

/**
 * A moved file onto a file of the same name ('version'): its content becomes the new content of that file (the content
 * there a version), its own older versions go along; the moved node is gone (its links end).
 */
async function mergeVersion(ctx, src, ex) {
  const gc = ctx.gc;
  await store.tx(gc, async () => {
    const s = await nodes.reach(ctx, src.id, 'write');
    const e = await nodes.reach(ctx, ex.id, 'write');
    if (e.area.archived_at != null || s.area.archived_at != null) throw fail('forbidden');
    const p = await nodes.pathOf(gc, e.node);
    const versionId = await files.keepVersion(ctx, e.node);
    if (s.node.media_id) {
      try {
        await gc.media.move(s.node.media_id, { path: p, ...(s.area.media_area !== e.area.media_area ? { area: e.area.media_area } : {}) });
      } catch (err) {
        if (e.node.media_id) { try { await gc.media.move(e.node.media_id, { path: p }); } catch { /* best effort */ } }
        if (err && err.code === 'ERR_MEDIA_QUOTA') throw fail('quota');
        throw err;
      }
    }
    // (a media file belongs to one node: the moved node lets go of it first)
    await store.run(gc, 'UPDATE nodes SET media_id = NULL WHERE id = ?', [s.node.id]);
    await store.run(gc, `UPDATE nodes SET media_id = ?, size = ?, sha256 = ?, mime = ?, mtime = ?, rev = rev + 1, updated_at = ?, updated_by = ?, entropy = ?,
      taken_at = COALESCE(?, taken_at), content_at = ? WHERE id = ?`,
    [s.node.media_id || null, s.node.size, s.node.sha256 || null, s.node.mime || null, s.node.mtime, ctx.now, ctx.viewer, s.node.entropy == null ? null : s.node.entropy,
      s.node.taken_at, ctx.now, e.node.id]);
    await store.run(gc, 'UPDATE versions SET node_id = ? WHERE node_id = ?', [e.node.id, s.node.id]);
    const text = await store.one(gc, 'SELECT text FROM doc_text WHERE node_id = ?', [s.node.id]);
    await store.run(gc, 'DELETE FROM doc_text WHERE node_id = ?', [e.node.id]);
    if (text) await store.run(gc, 'UPDATE doc_text SET node_id = ? WHERE node_id = ?', [e.node.id, s.node.id]);
    await nodes.forget(gc, [s.node.id]);
    await store.run(gc, 'DELETE FROM nodes WHERE id = ?', [s.node.id]);
    await nodes.log(gc, s.area.id, s.node.id, 'purge', ctx);
    await nodes.log(gc, e.area.id, e.node.id, 'update', ctx);
    await guard.note(ctx, { op: 'overwrite', node: e.node, name: e.node.name, versionId, entropy: s.node.entropy, entropyBefore: e.node.entropy });
    await nodes.unmarkUp(gc, e.node.id, ctx, e.node.id);
    await files.trimVersions(gc, e.node.id, ctx.settings.versionsMax);
    (ctx.insightIds || (ctx.insightIds = new Set())).add(e.node.id);
  });
  nodes.unlinkLater(ctx, 'all', [src.id]);
}

// ─── Copy ───────────────────────────────────────

async function itemOf(gc, op, seq) {
  return seq == null ? null : store.one(gc, 'SELECT * FROM op_items WHERE op_id = ? AND seq = ?', [op.id, seq]);
}

/** The folder a copy's row goes into → { dest, fresh } (fresh: the job made it), or null when its folder was not made. */
async function destOf(gc, op, item) {
  if (item.parent_seq == null) return { dest: await nodes.row(gc, op.target_id), fresh: false };
  const p = await itemOf(gc, op, item.parent_seq);
  if (!p || p.state !== 'done' || p.result_id == null) return null;
  return { dest: await nodes.row(gc, p.result_id), fresh: p.mode === 'new' };
}

async function copyItem(ctx, op, item) {
  const gc = ctx.gc;
  const d = await destOf(gc, op, item);
  if (!d) return settle(gc, op, item, 'skipped', { reason: 'parent' });
  const dest = d.dest;
  if (!dest || dest.deleted_at != null || dest.is_dir !== 1) return settle(gc, op, item, 'failed', { reason: 'not_found' });
  const src = await nodes.row(gc, item.node_id);
  if (!src || src.deleted_at != null) return settle(gc, op, item, 'failed', { reason: 'not_found' });
  await store.run(gc, 'UPDATE op_items SET dest_id = ? WHERE op_id = ? AND seq = ?', [dest.id, op.id, item.seq]);
  const ex = src.vault_id ? null : await nodes.taken(gc, dest.area_id, dest.id, src.name);
  if (src.is_dir === 1) {
    if (ex && ex.is_dir === 1 && ex.id !== src.id) {
      await store.run(gc, "UPDATE op_items SET mode = 'merge' WHERE op_id = ? AND seq = ?", [op.id, item.seq]);
      return settle(gc, op, item, 'done', { resultId: ex.id });
    }
    if (ex && op.on_conflict === 'skip') return settle(gc, op, item, 'skipped', { reason: 'exists' });
    const made = await store.tx(gc, async () => {
      const r = await nodes.reach(ctx, dest.id, 'write');
      if (r.area.archived_at != null) throw fail('forbidden');
      await nodes.unmarkUp(gc, dest.id, ctx);
      if (src.vault_id) {
        const ins = await store.run(gc, `INSERT INTO nodes (area_id, parent_id, name, is_dir, created_at, created_by, updated_at, updated_by, vault_id, name_cipher, key_version)
          VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`, [dest.area_id, dest.id, vaults().opaqueName(), ctx.now, ctx.viewer, ctx.now, ctx.viewer, src.vault_id, src.name_cipher, src.key_version]);
        await nodes.log(gc, dest.area_id, ins.lastInsertRowid, 'create', ctx);
        return nodes.row(gc, ins.lastInsertRowid);
      }
      const name = ex ? await nodes.freeName(gc, dest.area_id, dest.id, src.name) : src.name;
      return nodes.insertFolder(ctx, dest.area_id, dest.id, name);
    });
    await store.run(gc, "UPDATE op_items SET mode = 'new' WHERE op_id = ? AND seq = ?", [op.id, item.seq]);
    if (!d.fresh) await step(gc, op, 'created', made.id, null);
    return settle(gc, op, item, 'done', { resultId: made.id });
  }
  // a file
  let mode = 'new';
  if (ex) {
    if (ex.is_dir === 0 && sameContent(src, ex)) return settle(gc, op, item, 'done', { reason: 'same', resultId: ex.id });
    if (op.on_conflict === 'skip') return settle(gc, op, item, 'skipped', { reason: 'exists' });
    if (op.on_conflict === 'version' && ex.is_dir === 0) mode = 'version';
  }
  await store.run(gc, 'UPDATE op_items SET mode = ?, existing_id = ?, sha256 = ?, size = ? WHERE op_id = ? AND seq = ?',
    [mode, mode === 'version' ? ex.id : null, src.sha256 || null, src.size || 0, op.id, item.seq]);
  const cur = await itemOf(gc, op, item.seq);
  // an empty file has no bytes; a host that copies files (gc.media.copy) needs no device
  if (!src.media_id) return commitCopy(ctx, op, cur, src, null);
  // GateControl copies on the server (≥ 1.215.0): no device needed, the job goes on without one
  if (hostCopy(gc)) {
    const a = await areas.row(gc, dest.area_id);
    let made;
    try { made = await copier(gc)(src.media_id, { area: a.media_area }); } catch (e) {
      if (e && e.code === 'ERR_MEDIA_QUOTA') throw fail('quota');
      gc.log.warn('media copy failed', (e && e.code) || 'error');
      return settle(gc, op, cur, 'failed', { reason: e && e.code === 'ERR_INVALID' ? 'not_found' : 'copy' });
    }
    const id = made && (typeof made.id === 'string' ? made.id : made.mediaId);
    if (typeof id !== 'string') return settle(gc, op, cur, 'failed', { reason: 'copy' });
    if (made.sha256 && src.sha256 && made.sha256 !== src.sha256) {
      try { await gc.media.delete(id); } catch { /* best effort */ }
      return settle(gc, op, cur, 'failed', { reason: 'changed' });
    }
    try {
      return await commitCopy(ctx, op, cur, src, id);
    } catch (e) {
      try { await gc.media.delete(id); } catch { /* best effort */ }
      throw e;
    }
  }
  await store.run(gc, "UPDATE op_items SET state = 'transfer' WHERE op_id = ? AND seq = ?", [op.id, item.seq]);
  return null;
}

/**
 * A copy's file at its folder with `mediaId` (its bytes; null: an empty file) — a new file, or the new content of the file
 * of the same name ('version'); the name looked at again (something may have come meanwhile). → the node
 */
async function commitCopy(ctx, op, item, src, mediaId) {
  const gc = ctx.gc;
  const out = await store.tx(gc, async () => {
    const { node: dest, area } = await nodes.folderFor(ctx, item.dest_id);
    let ex = null;
    let name = src.vault_id ? vaults().opaqueName() : src.name;
    if (!src.vault_id) {
      ex = item.mode === 'version' && item.existing_id ? await nodes.row(gc, item.existing_id) : null;
      if (ex && (ex.deleted_at != null || ex.parent_id !== dest.id || ex.is_dir === 1)) ex = null;
      if (!ex) {
        const there = await nodes.taken(gc, area.id, dest.id, name);
        if (there) {
          if (there.is_dir === 0 && sameContent(src, there)) return { same: there };
          if (op.on_conflict === 'skip') return { skip: true };
          if (op.on_conflict === 'version' && there.is_dir === 0) ex = there;
          else name = await nodes.freeName(gc, area.id, dest.id, name);
        }
      }
    }
    const text = await store.one(gc, 'SELECT text FROM doc_text WHERE node_id = ?', [src.id]);
    if (ex) {
      const p = await nodes.pathOf(gc, ex);
      const versionId = await files.keepVersion(ctx, ex);
      if (mediaId) {
        try { await place(gc, mediaId, area.media_area, p); } catch (e) {
          if (ex.media_id) { try { await gc.media.move(ex.media_id, { path: p }); } catch { /* best effort */ } }
          if (e && e.code === 'ERR_MEDIA_QUOTA') throw fail('quota');
          throw e;
        }
      }
      await store.run(gc, `UPDATE nodes SET media_id = ?, size = ?, sha256 = ?, mime = ?, mtime = ?, rev = rev + 1, updated_at = ?, updated_by = ?, entropy = NULL,
        taken_at = COALESCE(?, taken_at), content_at = ? WHERE id = ?`,
      [mediaId, src.size, src.sha256 || null, src.mime || null, src.mtime, ctx.now, ctx.viewer, src.taken_at, ctx.now, ex.id]);
      await nodes.log(gc, area.id, ex.id, 'update', ctx);
      await guard.note(ctx, { op: 'overwrite', node: ex, name: ex.name, versionId, entropy: null, entropyBefore: ex.entropy });
      await nodes.unmarkUp(gc, ex.id, ctx, ex.id);
      await files.trimVersions(gc, ex.id, ctx.settings.versionsMax);
      await store.run(gc, 'DELETE FROM doc_text WHERE node_id = ?', [ex.id]);
      if (text) await store.run(gc, 'INSERT INTO doc_text (node_id, text, at) VALUES (?, ?, ?)', [ex.id, text.text, ctx.now]);
      const now = await nodes.row(gc, ex.id);
      return { node: now, versioned: { rev: now.rev, versionId } };
    }
    const p = nodes.join(await nodes.pathOf(gc, dest), name);
    if (mediaId) {
      try { await place(gc, mediaId, area.media_area, p); } catch (e) {
        if (e && e.code === 'ERR_MEDIA_QUOTA') throw fail('quota');
        if (e && e.code === 'ERR_CONFLICT') throw fail('exists');
        throw e;
      }
    }
    await nodes.unmarkUp(gc, dest.id, ctx);
    const r = await store.run(gc, `INSERT INTO nodes (area_id, parent_id, name, is_dir, media_id, size, sha256, mime, mtime, created_at, created_by, updated_at, updated_by, taken_at, content_at,
        vault_id, name_cipher, key_version)
      VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [area.id, dest.id, name, mediaId, src.size, src.sha256 || null, src.mime || null, src.mtime, ctx.now, ctx.viewer,
      ctx.now, ctx.viewer, src.taken_at, ctx.now, src.vault_id || null, src.vault_id ? src.name_cipher : null, src.vault_id ? src.key_version : null]);
    const id = Number(r.lastInsertRowid);
    await nodes.log(gc, area.id, id, 'create', ctx);
    const made = await nodes.row(gc, id);
    await guard.note(ctx, { op: 'create', node: made, name, entropy: null });
    if (text) await store.run(gc, 'INSERT INTO doc_text (node_id, text, at) VALUES (?, ?, ?)', [id, text.text, ctx.now]);
    return { node: made };
  });
  if (out.same || out.skip) {
    if (mediaId) { try { await gc.media.delete(mediaId); } catch { /* removed with the unclaimed ones */ } }
    if (out.same) { await settle(gc, op, item, 'done', { reason: 'same', resultId: out.same.id }); return out.same; }
    await settle(gc, op, item, 'skipped', { reason: 'exists' });
    return null;
  }
  (ctx.insightIds || (ctx.insightIds = new Set())).add(out.node.id);
  const parent = await itemOf(gc, op, item.parent_seq);
  if (out.versioned) await step(gc, op, 'versioned', out.node.id, out.versioned);
  else if (!parent || parent.mode !== 'new') await step(gc, op, 'created', out.node.id, null);
  await settle(gc, op, item, 'done', { resultId: out.node.id });
  return out.node;
}

/** POST ops/<id>/transfers { limit } → files of a copy whose bytes a device brings (leased to it for a while). */
async function transfers(ctx, id, body) {
  const gc = ctx.gc;
  const op = await mine(ctx, id);
  if (op.kind !== 'copy') throw fail('invalid');
  const limit = Math.min(TRANSFERS_MAX, Math.max(1, posInt(body && body.limit) || 5));
  // maxSize: only files up to that size (the portal uploads at most 100 MB a file — the larger ones wait for an app)
  const maxSize = body && body.maxSize != null ? posInt(body.maxSize) : null;
  if (op.state !== 'running') return { transfers: [], left: 0 };
  const now = Date.now();
  const rows = await store.all(gc, `SELECT * FROM op_items WHERE op_id = ? AND state = 'transfer' AND (lease_until IS NULL OR lease_until < ?)${maxSize ? ' AND size <= ?' : ''}
    ORDER BY seq LIMIT ?`, [op.id, now, ...(maxSize ? [maxSize] : []), limit]);
  const out = [];
  for (const it of rows) {
    const src = await nodes.row(gc, it.node_id);
    if (!src || src.deleted_at != null || !src.media_id) { await settle(gc, op, it, 'failed', { reason: 'not_found' }); continue; }
    if (src.sha256 !== it.sha256) { await settle(gc, op, it, 'failed', { reason: 'changed' }); continue; }
    try { await nodes.reach(ctx, src.id, 'read'); } catch { await settle(gc, op, it, 'failed', { reason: 'forbidden' }); continue; }
    let url;
    try { url = await gc.media.url(src.media_id, { user: ctx.viewer, ttlS: files.URL_TTL_S }); } catch { await settle(gc, op, it, 'failed', { reason: 'not_found' }); continue; }
    await store.run(gc, 'UPDATE op_items SET lease_until = ? WHERE op_id = ? AND seq = ?', [now + LEASE_MS, op.id, it.seq]);
    out.push({
      id: it.seq, nodeId: src.id, name: src.name, size: src.size, sha256: src.sha256, mime: src.mime || null, url,
      ...(src.vault_id ? { encrypted: true, vaultId: src.vault_id, nameCipher: src.name_cipher } : {}),
    });
  }
  await store.run(gc, 'UPDATE ops SET transfer_at = ? WHERE id = ?', [now, op.id]);
  const left = await store.one(gc, "SELECT COUNT(*) AS n FROM op_items WHERE op_id = ? AND state = 'transfer'", [op.id]);
  await maybeDone(gc, op);
  return { transfers: out, left: left.n };
}

async function maybeDone(gc, op) {
  const cur = await opRow(gc, op.id);
  if (!cur || cur.state !== 'running') return cur;
  const left = await store.one(gc, "SELECT COUNT(*) AS n FROM op_items WHERE op_id = ? AND state IN ('pending', 'transfer')", [op.id]);
  if (left.n) return cur;
  return finish(gc, cur, 'done');
}

/** POST ops/<id>/transfers/<n> { mediaId } | { failed: true, reason? } → { op, node? } */
async function transferDone(ctx, id, seqArg, body) {
  const gc = ctx.gc;
  const op = await mine(ctx, id);
  const b = body && typeof body === 'object' ? body : {};
  const seq = posInt(seqArg);
  const it = seq ? await itemOf(gc, op, seq) : null;
  if (!it || op.kind !== 'copy') throw fail('not_found');
  const drop = async () => { if (typeof b.mediaId === 'string') { try { await gc.media.delete(b.mediaId); } catch { /* best effort */ } } };
  if (op.state !== 'running' || it.state !== 'transfer') {
    await drop();
    throw fail('conflict', { reason: op.state !== 'running' ? op.state : 'handled', op: await view(gc, op) });
  }
  await store.run(gc, 'UPDATE ops SET transfer_at = ? WHERE id = ?', [Date.now(), op.id]);
  if (b.failed === true || b.failed === 'true') {
    await drop();
    const reason = line(b.reason);
    await settle(gc, op, it, 'failed', { reason: reason && /^[a-z_]{1,32}$/.test(reason) ? reason : 'transfer' });
    return { op: await view(gc, await maybeDone(gc, op)) };
  }
  const info = typeof b.mediaId === 'string' ? await gc.media.info(b.mediaId).catch(() => null) : null;
  if (!info || info.claimed || info.owner !== ctx.viewer || info.area) throw fail('upload_invalid');
  const src = await nodes.row(gc, it.node_id);
  if (info.sha256 !== it.sha256 || !src || src.deleted_at != null) {
    await drop();
    await settle(gc, op, it, 'failed', { reason: !src || src.deleted_at != null ? 'not_found' : 'changed' });
    return { op: await view(gc, await maybeDone(gc, op)) };
  }
  ctx.now = Date.now();
  let node = null;
  try {
    node = await commitCopy(ctx, op, it, src, b.mediaId);
  } catch (e) {
    await drop();
    if (e && e.code === 'quota') {
      await settle(gc, op, it, 'failed', { reason: 'quota' });
      await finish(gc, await opRow(gc, op.id), 'failed', 'quota');
      throw e;
    }
    await settle(gc, op, it, 'failed', { reason: reasonOf(e) });
  }
  const cur = await maybeDone(gc, op);
  await announce(gc, cur);
  return { op: await view(gc, cur), ...(node ? { node: nodes.view(node) } : {}) };
}

// ─── Undo ───────────────────────────────────────

/** POST ops/<id>/undo → { op } the undo (a job of its own). */
async function undo(ctx, id, hooks) {
  const gc = ctx.gc;
  const op = await mine(ctx, id);
  if (!UNDOABLE.includes(op.kind)) throw fail('invalid');
  if (op.undone_by) throw fail('conflict', { reason: 'undone', undoneBy: op.undone_by });
  if (op.state === 'running') throw fail('conflict', { reason: 'running' });
  if (!op.undo_until || op.undo_until < Date.now()) throw fail('conflict', { reason: 'expired' });
  const steps = await store.all(gc, 'SELECT * FROM op_steps WHERE op_id = ? ORDER BY seq DESC', [op.id]);
  if (!steps.length) throw fail('conflict', { reason: 'nothing' });
  const uid = newId();
  const now = Date.now();
  await store.tx(gc, async () => {
    // only once: the job is marked first
    const fresh = await opRow(gc, op.id);
    if (fresh.undone_by) throw fail('conflict', { reason: 'undone', undoneBy: fresh.undone_by });
    await store.run(gc, 'UPDATE ops SET undone_by = ?, undo_until = NULL WHERE id = ?', [uid, op.id]);
    await store.run(gc, `INSERT INTO ops (id, user_id, device, app, kind, state, ids, target_id, target_area, target_path, target_name, on_conflict, label, undo_of,
        items, total, bytes_total, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'undo', 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uid, ctx.viewer, ctx.deviceId || null, ctx.app ? 1 : 0, op.ids, op.target_id, op.target_area, op.target_path, op.target_name, op.on_conflict, op.label, op.id,
      op.items, steps.length, 0, now, now]);
    await insertItems(gc, uid, steps.map((s, i) => ({ seq: i + 1, node_id: s.node_id, files: 1, step_seq: s.seq, name: null })));
  });
  let u = await opRow(gc, uid);
  u = await work(ctx, u, Date.now() + INLINE_MS);
  if (u.state === 'running') later(hooks);
  return { op: await view(gc, u) };
}

/** Did node `id` (and what is below it) stay as job `op` left it? */
async function untouchedSince(gc, n, at) {
  if (n.updated_at > at) return false;
  if (n.is_dir !== 1) return true;
  const r = await store.one(gc, `SELECT 1 AS x FROM nodes WHERE (updated_at > ? OR created_at > ?) AND id IN (WITH RECURSIVE down(id) AS (
      SELECT id FROM nodes WHERE parent_id = ? UNION ALL SELECT c.id FROM nodes c JOIN down ON c.parent_id = down.id) SELECT id FROM down) LIMIT 1`, [at, at, n.id]);
  return !r;
}

async function undoItem(ctx, uop, item) {
  const gc = ctx.gc;
  const orig = await opRow(gc, uop.undo_of);
  const s = orig ? await store.one(gc, 'SELECT * FROM op_steps WHERE op_id = ? AND seq = ?', [orig.id, item.step_seq]) : null;
  if (!s) return settle(gc, uop, item, 'skipped', { reason: 'gone' });
  const data = json(s.data, {});
  const n = await nodes.row(gc, s.node_id);
  const skip = (reason) => settle(gc, uop, { ...item, name: n ? n.name : null }, 'skipped', { reason });
  if (s.action === 'merged') return skip('merged');
  if (!n) return skip('gone');
  if (s.action === 'moved') {
    if (n.deleted_at != null || n.parent_id !== data.to.parentId || n.name !== data.to.name) return skip('changed');
    const back = await nodes.row(gc, data.from.parentId);
    if (!back || back.deleted_at != null) return skip('gone');
    const name = n.vault_id ? null : await nodes.freeName(gc, back.area_id, back.id, data.from.name, n.id);
    await nodes.update(ctx, n.id, { parentId: back.id, ...(name ? { name } : {}) });
    return settle(gc, uop, item, 'done', { resultId: n.id });
  }
  if (s.action === 'trashed') {
    if (n.trash_id !== n.id || n.deleted_at !== data.at) return skip('changed');
    await nodes.restore(ctx, n.id);
    return settle(gc, uop, item, 'done', { resultId: n.id });
  }
  if (s.action === 'created') {
    if (n.deleted_at != null || !(await untouchedSince(gc, n, orig.finished_at || orig.updated_at))) return skip('changed');
    await nodes.trash(ctx, n.id);
    return settle(gc, uop, item, 'done');
  }
  if (s.action === 'versioned') {
    if (n.deleted_at != null || n.rev !== data.rev) return skip('changed');
    const v = await store.one(gc, 'SELECT id FROM versions WHERE id = ? AND node_id = ?', [data.versionId, n.id]);
    if (!v) return skip('gone');
    await files.restoreVersion(ctx, n.id, v.id);
    return settle(gc, uop, item, 'done', { resultId: n.id });
  }
  return skip('invalid');
}

// ─── Reading, cancelling ────────────────────────

async function get(ctx, id) {
  return { op: await view(ctx.gc, await mine(ctx, id)) };
}

/** GET ops?state= → { ops } */
async function list(ctx, q) {
  const state = q && q.state ? String(q.state) : null;
  if (state && !STATES.includes(state)) throw fail('invalid', { field: 'state' });
  const rows = state
    ? await store.all(ctx.gc, 'SELECT * FROM ops WHERE user_id = ? AND state = ? ORDER BY created_at DESC LIMIT ?', [ctx.viewer, state, LIST_MAX])
    : await store.all(ctx.gc, "SELECT * FROM ops WHERE user_id = ? AND (state = 'running' OR finished_at > ?) ORDER BY created_at DESC LIMIT ?", [ctx.viewer, Date.now() - RECENT_MS, LIST_MAX]);
  const out = [];
  for (const r of rows) out.push(await view(ctx.gc, r));
  return { ops: out };
}

/** DELETE ops/<id> → { op } — a running job stops (what is done stays); an ended one stays as it is. */
async function cancel(ctx, id) {
  const op = await mine(ctx, id);
  if (op.state !== 'running') return { op: await view(ctx.gc, op) };
  const out = await finish(ctx.gc, op, 'cancelled');
  return { op: await view(ctx.gc, out) };
}

// ─── Going on after the answer, the background run ─────

const busy = new Set();
let runner = null;

/** Go on with the running jobs in this process right after the answer (`hooks` of index.js). */
function later(hooks) {
  if (!hooks || runner) return;
  setImmediate(() => { drain(hooks).catch(() => {}); });
}

/** Work off every running job that has rows to do (one runner at a time). → its promise */
function drain(hooks, budgetMs = Infinity) {
  if (runner) return runner;
  const started = Date.now();
  runner = (async () => {
    try {
      for (;;) {
        if (Date.now() - started > budgetMs) return;
        const rows = await store.all(hooks.gc, `SELECT * FROM ops o WHERE state = 'running' AND EXISTS (SELECT 1 FROM op_items i WHERE i.op_id = o.id AND i.state = 'pending')
          ORDER BY created_at LIMIT 20`);
        const todo = rows.filter((r) => !busy.has(r.id));
        if (!todo.length) return;
        for (const op of todo) await slice(hooks, op);
      }
    } finally { runner = null; }
  })();
  return runner;
}

async function slice(hooks, op) {
  const gc = hooks.gc;
  busy.add(op.id);
  try {
    const ctx = await hooks.asPerson(op.user_id, Date.now());
    if (!ctx) { await finish(gc, op, 'failed', 'no_seat'); return; }
    ctx.deviceId = op.device || null;
    ctx.app = op.app === 1;
    try {
      await work(ctx, op, Date.now() + SLICE_MS);
    } finally {
      await hooks.finish(ctx);
    }
  } catch (e) {
    gc.log.warn('op failed', (e && (e.code || e.message)) || 'error');
    await finish(gc, op, 'failed', 'internal').catch(() => {});
  } finally { busy.delete(op.id); }
}

/** The background run: jobs a restart interrupted go on, copies nobody brings bytes for end, old jobs go. */
async function tick(gc, now, hooks) {
  const old = await store.all(gc, "SELECT id FROM ops WHERE state <> 'running' AND finished_at < ? LIMIT 200", [now - KEEP_MS]);
  for (const o of old) {
    await store.run(gc, 'DELETE FROM op_items WHERE op_id = ?', [o.id]);
    await store.run(gc, 'DELETE FROM op_steps WHERE op_id = ?', [o.id]);
    await store.run(gc, 'DELETE FROM ops WHERE id = ?', [o.id]);
  }
  const stale = await store.all(gc, `SELECT * FROM ops o WHERE state = 'running' AND kind = 'copy' AND COALESCE(transfer_at, updated_at) < ?
    AND NOT EXISTS (SELECT 1 FROM op_items i WHERE i.op_id = o.id AND i.state = 'pending')`, [now - ABANDON_MS]);
  for (const op of stale) await finish(gc, op, 'failed', 'abandoned');
  // GateControl copies on the server now (an update to ≥ 1.215.0): what still waits for a device goes on here
  if (hostCopy(gc)) {
    await store.run(gc, `UPDATE op_items SET state = 'pending', lease_until = NULL WHERE state = 'transfer' AND (lease_until IS NULL OR lease_until < ?)
      AND op_id IN (SELECT id FROM ops WHERE state = 'running' AND kind = 'copy')`, [now]);
  }
  // (a runner of this process already at work goes on by itself — the background run does not wait for it)
  if (hooks && typeof hooks.asPerson === 'function' && !runner) await drain(hooks, 45000);
  return { removed: old.length, abandoned: stale.length };
}

/** Tests: wait for the runner of this process. */
async function idle() {
  while (runner) await runner;
}

module.exports = {
  check, create, get, list, cancel, undo, transfers, transferDone, tick, drain, idle, view, hostCopy, NODES_MAX, IDS_MAX, RUNNING_MAX, UNDO_MS,
  _setCopy: (fn) => { copyHook = fn; },
};
