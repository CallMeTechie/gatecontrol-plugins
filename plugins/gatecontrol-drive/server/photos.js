'use strict';

// Photos (since 1.7.0): the pictures and videos (by their type) of the areas a person reads, newest first by when they
// were taken (takenAt: uploads/commit { takenAt }, else mtime, else when they came — nodes.TAKEN).
//
//   GET photos?area=&before=<ISO>&limit=<≤ 200>   → { items, next } — next: the `before` of the next page, else null
//   GET photos/months?area=                        → { months: [{ month: '2026-10', count }] } (the server's time zone)
//   GET photos/memories?date=YYYY-MM-DD            → { groups: [{ yearsAgo, date, items }] } — this calendar day (± 1 day)
//                                                    in earlier years, ≤ 30 a year; without date: today (server's zone)
// An item: { id, name, mime, size, takenAt, areaId, parentId, preview (boolean: there is a preview), mediaId,
// previewUrl, largeUrl } — the URLs as a node's `preview` (the app's endpoint, or the frame's signed URL).
// Without `area`: every area the person reads (never the trash). A page ends after every photo of its last moment
// (photos of the same second never fall between two pages).

const store = require('./store');
const nodes = require('./nodes');
const previews = require('./previews');
const { fail, iso, msArg } = require('./util');

const LIMIT_MAX = 200;
const LIMIT_DEFAULT = 100;
const MEMORIES_PER_YEAR = 30;
const YEARS_MAX = 100;
const TIES_MAX = 1000;

// a picture or a video, live
// a vault's files never (since 1.9.0: their type is application/octet-stream anyway — the server cannot see them)
const MEDIA = "is_dir = 0 AND deleted_at IS NULL AND vault_id IS NULL AND (mime LIKE 'image/%' OR mime LIKE 'video/%')";
const TAKEN = nodes.TAKEN;

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

/** A parent who sees photos of a child's folder: the child hears of it as for the folder (once a day). */
async function noteViews(ctx, rows) {
  const ids = new Set(rows.map((r) => r.area_id));
  for (const v of await ctx.visible()) if (v.via === 'parent' && ids.has(v.area.id)) await ctx.noteChildView(v.area);
}

/** Items of node rows with their previews for the viewer. */
async function itemsOf(ctx, rows) {
  const { map } = await previews.urls(ctx, rows.map((r) => r.media_id));
  return rows.map((r) => {
    const p = r.media_id ? map.get(r.media_id) : null;
    return {
      id: r.id, name: r.name, mime: r.mime || null, size: r.size, takenAt: iso(nodes.takenOf(r)), areaId: r.area_id, parentId: r.parent_id,
      preview: !!p, mediaId: r.media_id || null, previewUrl: p ? p.url : null, largeUrl: p ? p.largeUrl : null,
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

/** GET photos → { items, next } */
async function list(ctx, q) {
  const ids = await areaIds(ctx, q && q.area);
  const limit = limitArg(q && q.limit);
  const before = beforeArg(q && q.before);
  if (!ids.length) return { items: [], next: null };
  const r = await page(ctx.gc, `area_id IN (${store.marks(ids.length)}) AND ${MEDIA}`, ids, before, limit);
  await noteViews(ctx, r.rows);
  return { items: await itemsOf(ctx, r.rows), next: r.next };
}

/** GET photos/months → { months: [{ month, count }] } newest first. */
async function months(ctx, q) {
  const ids = await areaIds(ctx, q && q.area);
  if (!ids.length) return { months: [] };
  const rows = await store.all(ctx.gc, `SELECT strftime('%Y-%m', ${TAKEN} / 1000, 'unixepoch', 'localtime') AS month, COUNT(*) AS n FROM nodes
    WHERE area_id IN (${store.marks(ids.length)}) AND ${MEDIA} GROUP BY month ORDER BY month DESC`, ids);
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
  const ids = await areaIds(ctx, null);
  const groups = [];
  if (ids.length) {
    const where = `area_id IN (${store.marks(ids.length)}) AND ${MEDIA}`;
    const first = await store.one(ctx.gc, `SELECT MIN(${TAKEN}) AS t FROM nodes WHERE ${where}`, ids);
    const fromYear = first && first.t != null ? new Date(first.t).getFullYear() : y;
    const all = [];
    for (let k = 1; k <= YEARS_MAX && y - k >= fromYear; k++) {
      // that calendar day in year y - k (a 29 February: the 1 March of a year without one), ± 1 day, the server's zone
      const day = new Date(y - k, m, d);
      const start = new Date(y - k, m, d - 1).getTime();
      const end = new Date(y - k, m, d + 2).getTime();
      const rows = await store.all(ctx.gc, `SELECT * FROM nodes WHERE ${where} AND ${TAKEN} >= ? AND ${TAKEN} < ? ORDER BY ${TAKEN}, id LIMIT ?`,
        [...ids, start, end, MEMORIES_PER_YEAR]);
      if (rows.length) { groups.push({ yearsAgo: k, date: dayOf(day), rows }); all.push(...rows); }
    }
    await noteViews(ctx, all);
    for (const g of groups) { g.items = await itemsOf(ctx, g.rows); delete g.rows; }
  }
  return { date: `${y}-${pad(m + 1)}-${pad(d)}`, groups };
}

/** Is node row `n` a live picture or video? */
const isMedia = (n) => !!n && n.is_dir === 0 && n.deleted_at == null && !n.vault_id && /^(image|video)\//.test(String(n.mime || ''));

module.exports = { list, months, memories, page, itemsOf, isMedia, areaIds, noteViews, limitArg, beforeArg, MEDIA, LIMIT_MAX };
