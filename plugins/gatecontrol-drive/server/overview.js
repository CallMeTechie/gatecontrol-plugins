'use strict';

// The overview (since 1.18.0, feature `overview`): the new start of Drive in the apps and the portal — one request for
// everything that matters now.
//
//   GET overview → { todo, recent, memories, people, places, activity, storage }   (a part is left out when it has
//                  nothing; people / places are null while the feature or the person's switch is off)
//     todo       { deadlines: [≤ 3 like GET deadlines, from today], deadlinesTotal, review? (photos to check, left out at
//                0), toFile (Mail's attachments to file — its service tofile_count — or null without), toFileHint }
//     recent     [≤ 10 files like a folder's items + areaLabel + openedAt | changedAt] — no folders, pictures, videos or
//                files of a vault; what the person opened (recent_opens), filled up with what they changed or uploaded
//     memories   [≤ 4 { yearsAgo, date, count, cover }] — this calendar day (± 1 day) in earlier years like GET
//                photos/memories; cover a photo item
//     people     { people: [≤ 8 named, not hidden, like GET people], unnamed } | null (the person's switch off)
//     places     { top: [≤ 3 { key, name, count }], cluster: { lat, lon, count } | null, total }
//     activity   [≤ 5 { at, user: { id, name }, kind: 'added_photos' | 'added_files' | 'changed', count, area: { id,
//                label }, folder: { id, path } | null, sample }] — what others did in the family's and the teams' areas
//                the person reads, the last 14 days, one entry per person, folder and kind within an hour
//     storage    { used, total, target, areaId } — my files: their bytes, the area's quota (null: none), the label of
//                its storage target (null: this server)
//
// "Zuletzt geöffnet": a file counts as opened on GET nodes/<id>/content (the apps', the PC's and the portal's open,
// preview and download) and POST nodes/<id>/office — recordOpen(). Not counted: pictures and videos, files of a vault,
// and what a PC fetches for a folder it syncs (a folder of mode 'sync' of the device of the asking token —
// PUT devices/<id>/folders): those fetches are the sync, not the person opening a file.

const store = require('./store');
const nodes = require('./nodes');
const photos = require('./photos');
const places = require('./places');
const faces = require('./faces');
const deadlines = require('./deadlines');
const { iso } = require('./util');

const RECENT_MAX = 10;
const OPENS_KEEP = 200;
const MEMORIES_MAX = 4;
const PEOPLE_MAX = 8;
const PLACES_TOP = 3;
const DEADLINES_MAX = 3;
const ACTIVITY_MAX = 5;
const ACTIVITY_DAYS = 14;
const ACTIVITY_ROWS = 5000;
const GROUP_MS = 3600000;
const DAY = 86400000;
const MAIL = 'gatecontrol-mail';
const TOFILE = 'tofile_count';
const TOFILE_TTL_MS = 60000;
const HINT_MAX = 200;

// not a picture or a video (those are in "Fotos")
const NOT_MEDIA = "COALESCE(n.mime, '') NOT LIKE 'image/%' AND COALESCE(n.mime, '') NOT LIKE 'video/%'";
const FILE = `n.is_dir = 0 AND n.deleted_at IS NULL AND n.vault_id IS NULL AND ${NOT_MEDIA}`;
const isMedia = (mime) => /^(image|video)\//.test(String(mime || ''));

// ─── "Zuletzt geöffnet" ─────────────────────────────

/** The folders the asking device syncs (PUT devices/<id>/folders, mode 'sync') → [node id]. */
async function syncedFolders(ctx) {
  if (!ctx.deviceId) return [];
  const rows = await store.all(ctx.gc, 'SELECT folders FROM user_devices WHERE user_id = ? AND token_device = ?', [ctx.viewer, ctx.deviceId]);
  const out = [];
  for (const r of rows) {
    let list = [];
    try { list = JSON.parse(r.folders || '[]'); } catch { list = []; }
    for (const f of Array.isArray(list) ? list : []) if (f && f.mode === 'sync' && Number.isSafeInteger(f.nodeId)) out.push(f.nodeId);
  }
  return out;
}

/** Is node row `n` below (or one of) the folders `ids`? */
async function below(gc, n, ids) {
  if (!ids.length) return false;
  const up = await store.all(gc, `WITH RECURSIVE up(id, parent_id, depth) AS (
      SELECT id, parent_id, 0 FROM nodes WHERE id = ?
      UNION ALL SELECT p.id, p.parent_id, up.depth + 1 FROM nodes p JOIN up ON p.id = up.parent_id WHERE up.depth < 200)
    SELECT id FROM up`, [n.parent_id == null ? n.id : n.parent_id]);
  const set = new Set(ids);
  return up.some((r) => set.has(r.id));
}

/** File row `n` was opened by the viewer now (best effort: never fails the request). */
async function recordOpen(ctx, n) {
  try {
    if (!n || n.is_dir === 1 || n.vault_id || isMedia(n.mime)) return false;
    // a PC's sync fetches every file of its folders this way: not an open
    if (await below(ctx.gc, n, await syncedFolders(ctx))) return false;
    await store.run(ctx.gc, `INSERT INTO recent_opens (user_id, node_id, at) VALUES (?, ?, ?)
      ON CONFLICT(user_id, node_id) DO UPDATE SET at = excluded.at`, [ctx.viewer, n.id, ctx.now]);
    await store.run(ctx.gc, `DELETE FROM recent_opens WHERE user_id = ? AND node_id NOT IN (
      SELECT node_id FROM recent_opens WHERE user_id = ? ORDER BY at DESC LIMIT ?)`, [ctx.viewer, ctx.viewer, OPENS_KEEP]);
    return true;
  } catch (e) {
    ctx.gc.log.warn('recent open failed', (e && e.code) || 'error');
    return false;
  }
}

/** recent: the files opened, filled up with those the person changed or uploaded. */
async function recent(ctx, vis) {
  const ids = vis.map((v) => v.area.id);
  if (!ids.length) return [];
  const label = new Map(vis.map((v) => [v.area.id, ctx.areaLabel(v.area)]));
  const m = store.marks(ids.length);
  const opened = await store.all(ctx.gc, `SELECT n.*, r.at AS opened_at FROM recent_opens r JOIN nodes n ON n.id = r.node_id
    WHERE r.user_id = ? AND n.area_id IN (${m}) AND ${FILE} ORDER BY r.at DESC LIMIT ?`, [ctx.viewer, ...ids, RECENT_MAX]);
  const list = opened.map((r) => ({ row: r, at: r.opened_at, key: 'openedAt' }));
  if (list.length < RECENT_MAX) {
    const have = new Set(opened.map((r) => r.id));
    const mine = await store.all(ctx.gc, `SELECT n.* FROM nodes n WHERE n.area_id IN (${m}) AND ${FILE} AND n.updated_by = ?
      ORDER BY n.updated_at DESC, n.id DESC LIMIT ?`, [...ids, ctx.viewer, RECENT_MAX * 2]);
    for (const r of mine) {
      if (list.length >= RECENT_MAX) break;
      if (!have.has(r.id)) list.push({ row: r, at: r.updated_at, key: 'changedAt' });
    }
  }
  list.sort((a, b) => b.at - a.at || b.row.id - a.row.id);
  return list.map((x) => {
    const { opened_at: _o, ...n } = x.row;
    return nodes.view(n, { areaLabel: label.get(n.area_id) || null, [x.key]: iso(x.at) });
  });
}

// ─── "Zu erledigen" ─────────────────────────────────

const tofileCache = new Map(); // user → { at, value }

/** Mail's attachments to file (its service tofile_count) → { count, hint } | null (no Mail, refused, unreachable). */
async function toFile(ctx) {
  const gc = ctx.gc;
  const c = tofileCache.get(ctx.viewer);
  if (c && ctx.now - c.at >= 0 && ctx.now - c.at < TOFILE_TTL_MS) return c.value;
  let value = null;
  if (gc.services && typeof gc.services.call === 'function' && typeof gc.services.available === 'function') {
    let on = false;
    try { on = (await gc.services.available(MAIL, TOFILE)) === true; } catch { on = false; }
    if (on) {
      try {
        const r = await gc.services.call({ plugin: MAIL, service: TOFILE, userId: ctx.viewer, payload: { userId: ctx.viewer } });
        if (r && r.ok === true && Number.isSafeInteger(r.count) && r.count >= 0) {
          const hint = typeof r.hint === 'string' && r.hint.trim() ? r.hint.trim().slice(0, HINT_MAX) : null;
          value = { count: r.count, hint };
        }
      } catch (e) {
        // too many calls this hour: the last answer while there is one
        if (e && e.code === 'ERR_RATE_LIMIT' && c) value = c.value;
      }
    }
  }
  tofileCache.set(ctx.viewer, { at: ctx.now, value });
  return value;
}

/** The photos to check (the review mark, since 1.13.0) in the areas the person reads. */
async function reviews(ctx) {
  const sc = await photos.scope(ctx, {});
  if (!sc) return 0;
  const r = await store.one(ctx.gc, `SELECT COUNT(*) AS n FROM nodes WHERE ${sc.where} AND review_at IS NOT NULL`, sc.args);
  return (r && r.n) || 0;
}

async function todo(ctx) {
  const [dl, review, mail] = await Promise.all([deadlines.upcoming(ctx, DEADLINES_MAX), reviews(ctx), toFile(ctx)]);
  const out = { deadlines: dl.deadlines, deadlinesTotal: dl.total, ...(review > 0 ? { review } : {}), toFile: mail ? mail.count : null, toFileHint: mail ? mail.hint : null };
  return dl.total > 0 || review > 0 || (mail && mail.count > 0) ? out : null;
}

// ─── "Neu in Familie" ───────────────────────────────

/** The first seq of the change log at or after `at` (the log is in time order: a binary search on seq). */
async function seqFrom(gc, at) {
  const b = await store.one(gc, 'SELECT MIN(seq) AS lo, MAX(seq) AS hi FROM changes');
  if (!b || b.hi == null) return null;
  let lo = b.lo;
  let hi = b.hi + 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const r = await store.one(gc, 'SELECT seq, at FROM changes WHERE seq >= ? ORDER BY seq LIMIT 1', [mid]);
    if (!r) { hi = mid; continue; }
    if (r.at >= at) hi = mid; else lo = r.seq + 1;
  }
  return lo;
}

async function activity(ctx, vis) {
  const shared = vis.filter((v) => v.area.kind === 'family' || v.area.kind === 'team');
  if (!shared.length) return [];
  const from = await seqFrom(ctx.gc, ctx.now - ACTIVITY_DAYS * DAY);
  if (from == null) return [];
  const ids = shared.map((v) => v.area.id);
  const rows = await store.all(ctx.gc, `SELECT c.seq, c.area_id AS c_area, c.node_id, c.op, c.at AS c_at, c.by, n.* FROM changes c JOIN nodes n ON n.id = c.node_id
    WHERE c.area_id IN (${store.marks(ids.length)}) AND c.seq >= ? AND c.op IN ('create', 'update') AND c.by IS NOT NULL AND c.by <> ?
      AND n.area_id = c.area_id AND n.is_dir = 0 AND n.deleted_at IS NULL AND n.vault_id IS NULL
    ORDER BY c.seq DESC LIMIT ?`, [...ids, from, ctx.viewer, ACTIVITY_ROWS]);
  // newest first: an entry per person, folder and kind while each event is within an hour of the entry's newest
  const groups = [];
  const open = new Map();
  for (const r of rows) {
    if (r.c_at < ctx.now - ACTIVITY_DAYS * DAY) continue;
    const kind = r.op === 'update' ? 'changed' : isMedia(r.mime) ? 'added_photos' : 'added_files';
    const key = `${r.by}|${r.c_area}|${r.parent_id}|${kind}`;
    let g = open.get(key);
    if (!g || g.at - r.c_at > GROUP_MS) {
      g = { at: r.c_at, by: r.by, areaId: r.c_area, parentId: r.parent_id, kind, nodes: new Set(), sample: r };
      open.set(key, g);
      groups.push(g);
    }
    g.nodes.add(r.node_id);
  }
  groups.sort((a, b) => b.at - a.at);
  const label = new Map(shared.map((v) => [v.area.id, ctx.areaLabel(v.area)]));
  const roots = new Set(shared.map((v) => v.area.root_id));
  const out = [];
  for (const g of groups.slice(0, ACTIVITY_MAX)) {
    let folder = null;
    if (g.parentId != null && !roots.has(g.parentId)) {
      const f = await nodes.row(ctx.gc, g.parentId);
      if (f && f.deleted_at == null) folder = { id: f.id, path: await nodes.pathOf(ctx.gc, f) };
    }
    const { seq: _s, c_area: _a, node_id: _n, op: _op, c_at: _c, by: _b, ...n } = g.sample;
    out.push({
      at: iso(g.at), user: { id: g.by, name: (ctx.users.get(g.by) || {}).name || null }, kind: g.kind, count: g.nodes.size,
      area: { id: g.areaId, label: label.get(g.areaId) || null }, folder, sample: nodes.view(n),
    });
  }
  return out;
}

// ─── photos: memories, people, places ───────────────

async function memories(ctx) {
  return photos.memoryCovers(ctx, MEMORIES_MAX);
}

async function people(ctx) {
  return faces.overview(ctx, PEOPLE_MAX);
}

async function placesOf(ctx) {
  return places.summary(ctx, await photos.scope(ctx, {}), PLACES_TOP);
}

// ─── storage ────────────────────────────────────────

async function storage(ctx, vis) {
  const mine = vis.find((v) => v.area.kind === 'mine' && v.area.owner_user === ctx.viewer);
  if (!mine) return null;
  let info = null;
  try { info = await ctx.gc.media.areas.info(mine.area.media_area); } catch { info = null; }
  if (!info) return null;
  const target = info.target && typeof info.target.label === 'string' && info.target.label ? info.target.label : null;
  return { used: Number(info.bytes) || 0, total: Number.isFinite(info.quota) && info.quota > 0 ? info.quota : null, target, areaId: mine.area.id };
}

// ─── GET overview ───────────────────────────────────

/** GET overview → the parts that have something (see the head of this file). */
async function get(ctx) {
  const vis = await ctx.visible();
  const settled = (p) => p.then((v) => v, (e) => { ctx.gc.log.warn('overview part failed', (e && e.code) || (e && e.message) || 'error'); return undefined; });
  const [td, rc, mem, pp, pl, act, st] = await Promise.all([
    settled(todo(ctx)), settled(recent(ctx, vis)), settled(memories(ctx)), settled(people(ctx)), settled(placesOf(ctx)),
    settled(activity(ctx, vis)), settled(storage(ctx, vis)),
  ]);
  const out = {};
  if (td) out.todo = td;
  if (rc && rc.length) out.recent = rc;
  if (mem && mem.length) out.memories = mem;
  // people: null while the switch is off; nobody at all: left out
  if (pp === null) out.people = null;
  else if (pp && (pp.people.length || pp.unnamed)) out.people = pp;
  if (pl) out.places = pl;
  if (act && act.length) out.activity = act;
  if (st) out.storage = st;
  return out;
}

function reset() { tofileCache.clear(); }

module.exports = { get, recordOpen, seqFrom, reset, RECENT_MAX };
