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

const store = require('./store');
const nodes = require('./nodes');
const { fail } = require('./util');

const STATES = new Set(['pending', 'clean', 'infected', 'unscannable', 'unchecked']);
const BATCH = 400;
const PENDING_AGAIN_MS = 60000;
const FORGET_MS = 86400000;

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

/** Keep the result for media `mediaId` → the normalised scan or null (nothing kept). */
async function remember(gc, mediaId, scan, now = Date.now()) {
  const s = norm(scan);
  if (!s || typeof mediaId !== 'string' || !mediaId) return null;
  await store.run(gc, `INSERT INTO media_scan (media_id, state, blocked, finding, at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(media_id) DO UPDATE SET state = excluded.state, blocked = excluded.blocked, finding = excluded.finding, at = excluded.at`,
  [mediaId, s.state, s.blocked ? 1 : 0, s.finding, now]);
  return s;
}

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
  for (let i = 0; i < list.length; i += BATCH) {
    const part = list.slice(i, i + BATCH);
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

/**
 * The hook mediaScanned({ mediaId, state, blocked, finding }): the new state ('deleted': the host removed the file —
 * quarantine over or deleted by an administrator: kept as infected and blocked, the node stays until someone deletes
 * it). → { touched: Set of area ids }
 */
async function scanned(gc, arg, now = Date.now()) {
  const ctx = { viewer: null, deviceId: null, now, touched: new Set() };
  const id = arg && typeof arg.mediaId === 'string' && /^[0-9a-f]{32}$/.test(arg.mediaId) ? arg.mediaId : null;
  if (!id) return ctx;
  const known = await store.one(gc, 'SELECT 1 AS x FROM nodes WHERE media_id = ? UNION ALL SELECT 1 FROM versions WHERE media_id = ? LIMIT 1', [id, id]);
  const scan = arg.state === 'deleted' ? { state: 'infected', blocked: true, finding: arg.finding || null } : arg;
  // a file not (yet) in the tree: kept for its commit (the upload may still be on its way)
  const before = await stateOf(gc, id);
  const s = await remember(gc, id, scan, now);
  if (!s || !known) return ctx;
  if (!before || before.state !== s.state || before.blocked !== s.blocked || before.finding !== s.finding) await logChange(gc, id, ctx);
  return ctx;
}

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

module.exports = { norm, codeOf, remember, fromInfo, copy, rowsOf, stateOf, blocked, check, attach, scanned, housekeeping };
