'use strict';

// "Für Fotorahmen freigeben" (since 1.31.0): the apps share single photos for the photo frame — on the GateControl TV
// (an app device of the person, GET frame) and on the kiosk devices (frame.js). Shared photos go into the person's own
// frame album: an ordinary album of their own files (albums.js) named "Fotorahmen", `frame: true`, made on the first
// share (albums.frame_owner, migrations/025_frame_share.sql). The portal shows and changes it like every album; deleted,
// it is made again on the next share; switched off there, the next share switches it on again.
//
//   GET    frame/photos[?ids=1,2,3]      → { album | null, ids, count } — the shared photos (newest first); with ?ids
//                                          only those of the asked ids that are shared ("is this one on the frame?")
//   POST   frame/photos { ids }          → { album, added, skipped [{ id, reason }], count } — ≤ 500
//   DELETE frame/photos { ids } | ?ids=  → { album | null, removed, count } — out of the frame album (the photos stay)
//
// Only pictures (no videos, no folders, nothing else) the person reads now, nothing of a vault, nothing the virus scan
// holds back, nothing of a child's folder. A reason of `skipped`: not_found (no such photo, not readable, in the trash),
// not_image, vault, blocked (virus scan), child (a child's folder). A child of a family shares nothing (403
// forbidden { field: 'frame' } — as albums.js mayFrame); nor without the right to write in their own files.
// `ids` and `count` count only photos that would show now (readable, a picture, not in the trash, not blocked).

const store = require('./store');
const nodes = require('./nodes');
const areas = require('./areas');
const photos = require('./photos');
const albums = require('./albums');
const { t } = require('./text');
const { fail, posInt } = require('./util');

const IDS_MAX = albums.IDS_MAX;
// what may be shown: a live picture outside a vault, with its file, not blocked by the virus scan
const PICTURE = `${photos.MEDIA} AND mime LIKE 'image/%' AND media_id IS NOT NULL AND media_id NOT IN (SELECT media_id FROM media_scan WHERE blocked = 1)`;

/** The ids of a body { ids } (or a query ids=1,2,3) → [positive ints], ≤ 500; `need`: none is invalid. */
function idsArg(body, q, need = true) {
  let list = body && Array.isArray(body.ids) ? body.ids : null;
  if (!list && q && typeof q.ids === 'string') list = q.ids.split(',').filter(Boolean);
  if (!need && list == null) return null;
  if (!Array.isArray(list) || !list.length || list.length > IDS_MAX) throw fail('invalid', { field: 'ids' });
  const out = list.map((x) => posInt(x));
  if (out.some((x) => !x)) throw fail('invalid', { field: 'ids' });
  return [...new Set(out)];
}

/** The person's frame album row, else null. */
function albumOf(ctx) {
  return store.one(ctx.gc, 'SELECT * FROM albums WHERE frame_owner = ?', [ctx.viewer]);
}

/** May the person share for the frame at all? (not a child; write in their own files) → the own area entry */
async function mine(ctx) {
  if (await albums.isChild(ctx)) throw fail('forbidden', { field: 'frame' });
  const id = areas.idOf.mine(ctx.viewer);
  const v = (await ctx.visible()).find((x) => x.area.id === id);
  if (!v || !areas.can(v.role, 'write') || v.area.archived_at != null) throw fail('forbidden', { field: 'frame' });
  return v;
}

/** The person's frame album — made (or switched on again) where needed → its row. */
async function ensure(ctx) {
  const v = await mine(ctx);
  const a = await albumOf(ctx);
  if (a) {
    if (a.frame !== 1 || a.frame_by !== ctx.viewer) {
      await store.run(ctx.gc, 'UPDATE albums SET frame = 1, frame_by = ?, updated_at = ?, updated_by = ? WHERE id = ?', [ctx.viewer, ctx.now, ctx.viewer, a.id]);
    }
    return store.one(ctx.gc, 'SELECT * FROM albums WHERE id = ?', [a.id]);
  }
  await store.run(ctx.gc, `INSERT OR IGNORE INTO albums (area_id, name, frame, frame_by, frame_owner, created_at, created_by, updated_at, updated_by)
    VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`, [v.area.id, t(ctx.lang, 'album.frame'), ctx.viewer, ctx.viewer, ctx.now, ctx.viewer, ctx.now, ctx.viewer]);
  return albumOf(ctx);
}

/** The ids of album `a` that would show now (the viewer's areas outside children's folders), newest first. */
async function shownIds(ctx, a) {
  const ids = (await ctx.visible()).filter((x) => x.area.kind !== 'child').map((x) => x.area.id);
  if (!ids.length) return [];
  const rows = await store.all(ctx.gc, `SELECT id FROM nodes WHERE id IN (SELECT node_id FROM album_items WHERE album_id = ?)
    AND area_id IN (${store.marks(ids.length)}) AND ${PICTURE} ORDER BY ${nodes.TAKEN} DESC, id DESC`, [a.id, ...ids]);
  return rows.map((r) => r.id);
}

async function answer(ctx, a, extra) {
  if (!a) return { album: null, ...extra, ids: [], count: 0 };
  const shown = await shownIds(ctx, a);
  const [album] = await albums.viewsOf(ctx, [a]);
  return { album, ...extra, ids: shown, count: shown.length };
}

/** GET frame/photos[?ids=] */
async function get(ctx, q) {
  const asked = idsArg(null, q, false);
  const a = await albumOf(ctx);
  const out = await answer(ctx, a, {});
  if (asked) {
    const set = new Set(asked);
    out.ids = out.ids.filter((x) => set.has(x));
  }
  return out;
}

/** Why node `n` cannot be shared (null: it can). `vis`: area id → visible entry; `blocked`: media ids held back. */
function reasonOf(n, vis, blocked) {
  if (!n || n.deleted_at != null || !vis.has(n.area_id)) return 'not_found';
  if (n.vault_id) return 'vault';
  if (n.is_dir !== 0 || !/^image\//.test(String(n.mime || '')) || !n.media_id) return 'not_image';
  if (vis.get(n.area_id).area.kind === 'child') return 'child';
  if (blocked.has(n.media_id)) return 'blocked';
  return null;
}

/** POST frame/photos { ids } */
async function add(ctx, body) {
  const ids = idsArg(body, null);
  await mine(ctx);
  const vis = new Map((await ctx.visible()).map((x) => [x.area.id, x]));
  const rows = new Map();
  for (const part of store.chunks(ids)) for (const n of await store.all(ctx.gc, `SELECT * FROM nodes WHERE id IN (${store.marks(part.length)})`, part)) rows.set(n.id, n);
  const media = [...rows.values()].map((n) => n.media_id).filter(Boolean);
  const blocked = new Set();
  for (const part of store.chunks(media)) {
    for (const r of await store.all(ctx.gc, `SELECT media_id FROM media_scan WHERE blocked = 1 AND media_id IN (${store.marks(part.length)})`, part)) blocked.add(r.media_id);
  }
  const added = [];
  const skipped = [];
  for (const id of ids) {
    const reason = reasonOf(rows.get(id), vis, blocked);
    if (reason) skipped.push({ id, reason });
    else added.push(id);
  }
  if (!added.length) return answer(ctx, await albumOf(ctx), { added, skipped });
  const a = await ensure(ctx);
  await store.tx(ctx.gc, async () => {
    for (const n of added) await store.run(ctx.gc, 'INSERT OR IGNORE INTO album_items (album_id, node_id, added_at, added_by) VALUES (?, ?, ?, ?)', [a.id, n, ctx.now, ctx.viewer]);
    await store.run(ctx.gc, 'UPDATE albums SET updated_at = ?, updated_by = ? WHERE id = ?', [ctx.now, ctx.viewer, a.id]);
  });
  return answer(ctx, a, { added, skipped });
}

/** DELETE frame/photos { ids } | ?ids= */
async function remove(ctx, body, q) {
  const ids = idsArg(body, q);
  const a = await albumOf(ctx);
  if (!a) return answer(ctx, null, { removed: [] });
  const there = new Set();
  for (const part of store.chunks(ids)) {
    for (const r of await store.all(ctx.gc, `SELECT node_id FROM album_items WHERE album_id = ? AND node_id IN (${store.marks(part.length)})`, [a.id, ...part])) there.add(r.node_id);
  }
  const removed = ids.filter((x) => there.has(x));
  if (removed.length) {
    await store.tx(ctx.gc, async () => {
      for (const part of store.chunks(removed)) await store.run(ctx.gc, `DELETE FROM album_items WHERE album_id = ? AND node_id IN (${store.marks(part.length)})`, [a.id, ...part]);
      if (a.cover_id != null && removed.includes(a.cover_id)) await store.run(ctx.gc, 'UPDATE albums SET cover_id = NULL WHERE id = ?', [a.id]);
      await store.run(ctx.gc, 'UPDATE albums SET updated_at = ?, updated_by = ? WHERE id = ?', [ctx.now, ctx.viewer, a.id]);
    });
  }
  return answer(ctx, a, { removed });
}

module.exports = { get, add, remove };
