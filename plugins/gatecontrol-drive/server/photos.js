'use strict';

// Photos (since 1.7.0): the pictures and videos (by their type) of the areas a person reads, newest first by when they
// were taken (takenAt: uploads/commit { takenAt }, else mtime, else when they came — nodes.TAKEN). Photos are files
// like any other (they show in their folders too); this is only a view over every picture and video.
//
//   GET photos?area=&folder=&camera=&before=<ISO>&limit=<≤ 200>  → { items, next } — next: the `before` of the next
//                                                    page, else null
//   GET photos/months?area=&folder=&camera=          → { months: [{ month: '2026-10', count }] } (the server's time zone)
//   GET photos/memories?date=YYYY-MM-DD&area=&folder=&camera=
//                                                  → { groups: [{ yearsAgo, date, items }] } — this calendar day (± 1 day)
//                                                    in earlier years, ≤ 30 a year; without date: today (server's zone)
//   GET photos/camera                              → { folder: { id, path, areaId } | null }  (since 1.10.0)
//   POST photos/camera                             → { folder, created }  the folder made where missing (since 1.10.0)
// An item: { id, name, mime, size, takenAt, areaId, parentId, preview (boolean: there is a preview), mediaId,
// previewUrl, largeUrl } — the URLs as a node's `preview` (the app's endpoint, or the frame's signed URL).
// Without `area`: every area the person reads (never the trash). A page ends after every photo of its last moment
// (photos of the same second never fall between two pages).
//
// Since 1.10.0 (feature `photosFolder`): `folder=<node id>` — only the pictures and videos in that folder and every
// folder below it (a folder one reads; not_found else, 409 encrypted for a vault, invalid { field: 'folder' } for a
// file or a folder outside `area`); `camera=1` — the same for the folder of the phones' photo backup, CAMERA below the
// root of my files (none yet: nothing, no error). Not both (invalid { field: 'camera' }); `camera` with an `area`
// other than my files: invalid { field: 'area' }.
//
// Since 1.13.0 (feature `photoClasses`, work.js): `class=work|private|review` on photos and months — review: the
// marked ones (POST photos/review); work: below the viewer's work folder (GET|PUT photos/settings), not marked; private:
// the rest. GET photos/classes?area=&folder=&camera= → { work, private, review } (the counts). An item carries
// `review` ({ hint } | null) and `work` (below my work folder, not marked). Memories leave the work folder out while
// the setting workInMemories is off (the default), and so does the photo frame (frame.js).
//
// Since 1.14.0 (feature `photoSearch`, labels.js): `q=<words>` on photos and months — the photos with a label the
// phones recognised for every word (German words too); GET photos then adds `search` { terms, labels, total, chips }.
// `unlabeled=1` — only those without labels in areas one writes to (the phones fill them in). Items carry `labeled`.

const store = require('./store');
const nodes = require('./nodes');
const areas = require('./areas');
const previews = require('./previews');
const work = require('./work');
const labels = require('./labels');
const { fail, iso, msArg, posInt } = require('./util');

const LIMIT_MAX = 200;
const LIMIT_DEFAULT = 100;
const MEMORIES_PER_YEAR = 30;
const YEARS_MAX = 100;
const TIES_MAX = 1000;

// a picture or a video, live
// a vault's files never (since 1.9.0: their type is application/octet-stream anyway — the server cannot see them)
const MEDIA = "is_dir = 0 AND deleted_at IS NULL AND vault_id IS NULL AND (mime LIKE 'image/%' OR mime LIKE 'video/%')";
const TAKEN = nodes.TAKEN;
// the folder of the phones' photo backup below the root of my files (since 1.10.0) — the same in every language
const CAMERA = ['Bilder', 'Kamera-Uploads'];
// the live folders of a tree (`?` its top), never into a vault — `parent_id IN (…)` of the photos below a folder
const TREE = `WITH RECURSIVE tree(id) AS (SELECT ?
    UNION ALL SELECT n.id FROM nodes n JOIN tree ON n.parent_id = tree.id WHERE n.is_dir = 1 AND n.deleted_at IS NULL AND n.vault_id IS NULL)
  SELECT id FROM tree`;

/** The areas of `area` (or every one the person reads) → [area ids]; an area not readable: not_found. */
async function areaIds(ctx, area) {
  const vis = await ctx.visible();
  if (area != null && area !== '') {
    const v = vis.find((x) => x.area.id === String(area));
    if (!v) throw fail('not_found', { field: 'area' });
    return [v.area.id];
  }
  return vis.map((x) => x.area.id);
}

/** A query switch: 1, true, yes (on) · empty, 0, false, no (off) · else invalid { field }. */
function switchArg(v, field) {
  const s = String(v == null ? '' : v).toLowerCase();
  if (['1', 'true', 'yes'].includes(s)) return true;
  if (['', '0', 'false', 'no'].includes(s)) return false;
  throw fail('invalid', { field });
}

/** The viewer's own area (my files) of the visible ones → { area, role } or null. */
async function mineOf(ctx) {
  return (await ctx.visible()).find((x) => x.area.id === areas.idOf.mine(ctx.viewer)) || null;
}

/** The folder of the phones' photo backup (CAMERA in my files, names as in every path: case-insensitive) → row or null. */
async function cameraRow(ctx, mine) {
  if (!mine) return null;
  let cur = await nodes.row(ctx.gc, mine.area.root_id);
  for (const s of CAMERA) {
    cur = cur ? await nodes.taken(ctx.gc, mine.area.id, cur.id, s) : null;
    if (!cur || cur.is_dir !== 1 || cur.vault_id) return null;
  }
  return cur;
}

const folderView = async (gc, n) => ({ id: n.id, path: await nodes.pathOf(gc, n), areaId: n.area_id });

/**
 * The photos a query asks for (area, folder, camera) → { where, args } for SQL over `nodes`, or null: none at all.
 * folder / camera (since 1.10.0): the pictures and videos of that folder and every folder below it.
 */
async function scope(ctx, q) {
  const x = q || {};
  const camera = switchArg(x.camera, 'camera');
  const hasFolder = x.folder != null && x.folder !== '';
  if (camera && hasFolder) throw fail('invalid', { field: 'camera' });
  const ids = await areaIds(ctx, x.area);
  const area = x.area != null && x.area !== '' ? String(x.area) : null;
  let top = null;
  if (hasFolder) {
    const id = posInt(x.folder);
    if (!id) throw fail('invalid', { field: 'folder' });
    const { node } = await nodes.reach(ctx, id);
    if (node.vault_id) throw fail('encrypted');
    if (node.is_dir !== 1 || (area && node.area_id !== area)) throw fail('invalid', { field: 'folder' });
    top = node;
  } else if (camera) {
    if (area && area !== areas.idOf.mine(ctx.viewer)) throw fail('invalid', { field: 'area' });
    top = await cameraRow(ctx, await mineOf(ctx));
    if (!top) return null;
  }
  if (top) return { where: `area_id = ? AND parent_id IN (${TREE}) AND ${MEDIA}`, args: [top.area_id, top.id] };
  if (!ids.length) return null;
  return { where: `area_id IN (${store.marks(ids.length)}) AND ${MEDIA}`, args: ids };
}

const CLASSES = ['work', 'private', 'review'];

/** `class=` → 'work' | 'private' | 'review' | null (none); else invalid { field: 'class' }. */
function classArg(v) {
  if (v == null || v === '') return null;
  const c = String(v).toLowerCase();
  if (!CLASSES.includes(c)) throw fail('invalid', { field: 'class' });
  return c;
}

/** Scope `sc` narrowed to class `cls` (since 1.13.0) → { where, args }, or null: none at all. */
async function classed(ctx, sc, cls) {
  if (!sc || !cls) return sc;
  if (cls === 'review') return { where: `${sc.where} AND review_at IS NOT NULL`, args: sc.args };
  const { folder } = await work.of(ctx);
  if (cls === 'work') return folder ? { where: `${sc.where} AND review_at IS NULL AND parent_id IN (${TREE})`, args: [...sc.args, folder.id] } : null;
  return folder ? { where: `${sc.where} AND review_at IS NULL AND parent_id NOT IN (${TREE})`, args: [...sc.args, folder.id] }
    : { where: `${sc.where} AND review_at IS NULL`, args: sc.args };
}

/** Scope `sc` without the work folder (memories while workInMemories is off). */
async function withoutWork(ctx, sc) {
  if (!sc) return sc;
  const { settings, folder } = await work.of(ctx);
  if (!folder || settings.workInMemories) return sc;
  return { where: `${sc.where} AND parent_id NOT IN (${TREE})`, args: [...sc.args, folder.id] };
}

/** A parent who sees photos of a child's folder: the child hears of it as for the folder (once a day). */
async function noteViews(ctx, rows) {
  const ids = new Set(rows.map((r) => r.area_id));
  for (const v of await ctx.visible()) if (v.via === 'parent' && ids.has(v.area.id)) await ctx.noteChildView(v.area);
}

/** Items of node rows with their previews for the viewer. */
async function itemsOf(ctx, rows) {
  const { map } = await previews.urls(ctx, rows.map((r) => r.media_id));
  const tree = rows.length ? await work.tree(ctx) : null;
  return rows.map((r) => {
    const p = r.media_id ? map.get(r.media_id) : null;
    const review = work.reviewOf(r);
    return {
      id: r.id, name: r.name, mime: r.mime || null, size: r.size, takenAt: iso(nodes.takenOf(r)), areaId: r.area_id, parentId: r.parent_id,
      preview: !!p, mediaId: r.media_id || null, previewUrl: p ? p.url : null, largeUrl: p ? p.largeUrl : null,
      // since 1.13.0: the review mark, and below my work folder (not marked)
      review, work: !review && !!tree && tree.has(r.parent_id),
      // since 1.14.0: a phone recognised its labels (also: none found)
      labeled: r.labels_at != null,
    };
  });
}

function limitArg(v) {
  if (v == null || v === '') return LIMIT_DEFAULT;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 1) throw fail('invalid', { field: 'limit' });
  return Math.min(LIMIT_MAX, n);
}

function beforeArg(v) {
  if (v == null || v === '') return null;
  const ms = msArg(String(v));
  if (!Number.isFinite(ms)) throw fail('invalid', { field: 'before' });
  return ms;
}

/**
 * One page of photos below the filter `where` (with `args`) → { rows, next }: newest first, the page extended by the
 * photos of its last moment.
 */
async function page(gc, where, args, before, limit) {
  const cond = before == null ? '' : ` AND ${TAKEN} < ?`;
  const rows = await store.all(gc, `SELECT * FROM nodes WHERE ${where}${cond} ORDER BY ${TAKEN} DESC, id DESC LIMIT ?`,
    [...args, ...(before == null ? [] : [before]), limit + 1]);
  if (rows.length <= limit) return { rows, next: null };
  const out = rows.slice(0, limit);
  const last = out[out.length - 1];
  const t = nodes.takenOf(last);
  out.push(...await store.all(gc, `SELECT * FROM nodes WHERE ${where} AND ${TAKEN} = ? AND id < ? ORDER BY id DESC LIMIT ?`, [...args, t, last.id, TIES_MAX]));
  const more = await store.one(gc, `SELECT 1 AS x FROM nodes WHERE ${where} AND ${TAKEN} < ? LIMIT 1`, [...args, t]);
  return { rows: out, next: more ? iso(t) : null };
}

/**
 * The photos of a list query: scope, class, and since 1.14.0 unlabeled=1 / q= (labels.js) → { sc, search } — sc null:
 * none at all; search: { terms, labels } of q, else null.
 */
async function filtered(ctx, q) {
  const cls = classArg(q && q.class);
  let sc = await classed(ctx, await scope(ctx, q), cls);
  if (sc && switchArg(q && q.unlabeled, 'unlabeled')) {
    const ids = (await ctx.visible()).filter((v) => areas.can(v.role, 'write') && v.area.archived_at == null).map((v) => v.area.id);
    sc = ids.length ? { where: `${sc.where} AND labels_at IS NULL AND area_id IN (${store.marks(ids.length)})`, args: [...sc.args, ...ids] } : null;
  }
  let search = null;
  if (q && q.q != null && q.q !== '') {
    const words = labels.wordsOf(q.q);
    if (!sc) return { sc: null, search: { terms: words, labels: [] } };
    const r = labels.narrow(sc, q.q);
    sc = r.sc;
    search = { terms: r.terms, labels: r.labels };
  }
  return { sc, search };
}

/** GET photos → { items, next, search? } */
async function list(ctx, q) {
  const limit = limitArg(q && q.limit);
  const before = beforeArg(q && q.before);
  const { sc, search } = await filtered(ctx, q);
  const found = search ? { ...search, ...(sc ? await labels.summary(ctx, sc, search.labels) : { total: 0, chips: [] }) } : null;
  if (!sc) return { items: [], next: null, ...(found ? { search: found } : {}) };
  const r = await page(ctx.gc, sc.where, sc.args, before, limit);
  await noteViews(ctx, r.rows);
  return { items: await itemsOf(ctx, r.rows), next: r.next, ...(found ? { search: found } : {}) };
}

/** GET photos/months → { months: [{ month, count }] } newest first. */
async function months(ctx, q) {
  const { sc } = await filtered(ctx, q);
  if (!sc) return { months: [] };
  const rows = await store.all(ctx.gc, `SELECT strftime('%Y-%m', ${TAKEN} / 1000, 'unixepoch', 'localtime') AS month, COUNT(*) AS n FROM nodes
    WHERE ${sc.where} GROUP BY month ORDER BY month DESC`, sc.args);
  return { months: rows.filter((r) => r.month).map((r) => ({ month: r.month, count: r.n })) };
}

const pad = (n) => String(n).padStart(2, '0');
const dayOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** GET photos/memories?date= → { date, groups: [{ yearsAgo, date, items }] } (nearest year first). */
async function memories(ctx, q) {
  let y;
  let m;
  let d;
  if (q && q.date != null && q.date !== '') {
    const hit = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(q.date));
    const probe = hit ? new Date(Number(hit[1]), Number(hit[2]) - 1, Number(hit[3])) : null;
    if (!hit || probe.getMonth() !== Number(hit[2]) - 1 || probe.getDate() !== Number(hit[3])) throw fail('invalid', { field: 'date' });
    [y, m, d] = [Number(hit[1]), Number(hit[2]) - 1, Number(hit[3])];
  } else {
    const now = new Date(ctx.now);
    [y, m, d] = [now.getFullYear(), now.getMonth(), now.getDate()];
  }
  // without the work folder unless the person wants it there (since 1.13.0)
  const sc = await withoutWork(ctx, await scope(ctx, q));
  const groups = [];
  if (sc) {
    const { where, args } = sc;
    const first = await store.one(ctx.gc, `SELECT MIN(${TAKEN}) AS t FROM nodes WHERE ${where}`, args);
    const fromYear = first && first.t != null ? new Date(first.t).getFullYear() : y;
    const all = [];
    for (let k = 1; k <= YEARS_MAX && y - k >= fromYear; k++) {
      // that calendar day in year y - k (a 29 February: the 1 March of a year without one), ± 1 day, the server's zone
      const day = new Date(y - k, m, d);
      const start = new Date(y - k, m, d - 1).getTime();
      const end = new Date(y - k, m, d + 2).getTime();
      const rows = await store.all(ctx.gc, `SELECT * FROM nodes WHERE ${where} AND ${TAKEN} >= ? AND ${TAKEN} < ? ORDER BY ${TAKEN}, id LIMIT ?`,
        [...args, start, end, MEMORIES_PER_YEAR]);
      if (rows.length) { groups.push({ yearsAgo: k, date: dayOf(day), rows }); all.push(...rows); }
    }
    await noteViews(ctx, all);
    for (const g of groups) { g.items = await itemsOf(ctx, g.rows); delete g.rows; }
  }
  return { date: `${y}-${pad(m + 1)}-${pad(d)}`, groups };
}

/** GET photos/classes → { work, private, review } — the counts of the classes (since 1.13.0). */
async function classes(ctx, q) {
  const sc = await scope(ctx, q);
  if (!sc) return { work: 0, private: 0, review: 0 };
  const { folder } = await work.of(ctx);
  const workSql = folder ? `SUM(CASE WHEN review_at IS NULL AND parent_id IN (${TREE}) THEN 1 ELSE 0 END)` : '0';
  const r = await store.one(ctx.gc, `SELECT COUNT(*) AS total, SUM(CASE WHEN review_at IS NOT NULL THEN 1 ELSE 0 END) AS review, ${workSql} AS work
    FROM nodes WHERE ${sc.where}`, [...(folder ? [folder.id] : []), ...sc.args]);
  const total = (r && r.total) || 0;
  const reviews = (r && r.review) || 0;
  const works = (r && r.work) || 0;
  return { work: works, private: total - reviews - works, review: reviews };
}

/** GET photos/camera → { folder: { id, path, areaId } | null } — the folder of the phones' photo backup (1.10.0). */
async function camera(ctx) {
  const n = await cameraRow(ctx, await mineOf(ctx));
  return { folder: n ? await folderView(ctx.gc, n) : null };
}

/**
 * POST photos/camera → { folder, created } — CAMERA in my files, made where missing like POST nodes (write access,
 * not archived, the change log); a file in the way: exists { field: 'path' }.
 */
async function makeCamera(ctx) {
  const mine = await mineOf(ctx);
  if (!mine) throw fail('not_found');
  let created = false;
  const n = await store.tx(ctx.gc, async () => {
    let cur = (await nodes.folderFor(ctx, mine.area.root_id)).node;
    for (const s of CAMERA) {
      let next = await nodes.taken(ctx.gc, mine.area.id, cur.id, s);
      if (next && (next.is_dir !== 1 || next.vault_id)) throw fail('exists', { field: 'path' });
      if (!next) {
        await nodes.unmarkUp(ctx.gc, cur.id, ctx);
        next = await nodes.insertFolder(ctx, mine.area.id, cur.id, s);
        created = true;
      }
      cur = next;
    }
    return cur;
  });
  return { folder: await folderView(ctx.gc, n), created };
}

/** Is node row `n` a live picture or video? */
const isMedia = (n) => !!n && n.is_dir === 0 && n.deleted_at == null && !n.vault_id && /^(image|video)\//.test(String(n.mime || ''));

module.exports = {
  list, months, memories, camera, makeCamera, classes, scope, classed, withoutWork, CAMERA, page, itemsOf, isMedia, areaIds, noteViews, limitArg, beforeArg,
  cameraRow, mineOf, MEDIA, TREE, LIMIT_MAX,
};
