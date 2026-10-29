'use strict';

// Work photos apart (since 1.13.0, feature `photoClasses`): a person's work folder and the review mark of a photo.
//
//   GET photos/settings  → { workFolder, workSubfolders, workInMemories, folder: { id, path, areaId } | null }
//   PUT photos/settings  { workFolder?: id | null, workSubfolders?: bool, workInMemories?: bool } → the same
//   POST photos/review   { ids, review: bool, hint?: 0 … 100 | null } → { changed, items: [{ id, review }] }
//
// The settings are the person's (table photo_settings), the same on every device and in the portal. The work folder is
// a folder they write to (not archived), never in a vault, never the camera uploads or a folder above them (else every
// photo would be a work photo): 400 invalid { field: 'workFolder', reason } else. A stored folder that is in the trash,
// gone or no longer readable counts as none (it stays stored). workSubfolders is only kept here — the devices and the
// portal make <work folder>/<year>/<month>.
//
// The review mark (nodes.review_at, review_hint, review_by) is the node's: "to be checked — work or private?", with the
// device's guess how likely it is work (hint, %). It is set and cleared with POST photos/review (write access to each
// photo, all or nothing) and ends when the person moving it moves a photo into or out of their work folder (nodes.update:
// PATCH nodes/<id>, a move job of ops.js and its undo; a folder: every photo below it). Each change is 'review' in the
// change log. Classes (photos.js): review = marked; work = below the work folder, not marked; private = the rest.

const store = require('./store');
const nodes = require('./nodes');
const areas = require('./areas');
const { fail, posInt } = require('./util');

// photos.js needs this module; loaded when first used
const photos = () => require('./photos');

const HINT_MAX = 100;

// the live folders of a tree (`?` its top), never into a vault (as photos.js TREE)
const TREE = `WITH RECURSIVE tree(id) AS (SELECT ?
    UNION ALL SELECT n.id FROM nodes n JOIN tree ON n.parent_id = tree.id WHERE n.is_dir = 1 AND n.deleted_at IS NULL AND n.vault_id IS NULL)
  SELECT id FROM tree`;

const DEFAULTS = { workFolder: null, workSubfolders: true, workInMemories: false };

/** Person `uid`'s stored settings → { workFolder (the stored id), workSubfolders, workInMemories }. */
async function stored(gc, uid) {
  const r = await store.one(gc, 'SELECT * FROM photo_settings WHERE user_id = ?', [uid]);
  if (!r) return { ...DEFAULTS };
  return { workFolder: r.work_folder == null ? null : r.work_folder, workSubfolders: r.work_subfolders === 1, workInMemories: r.work_in_memories === 1 };
}

/**
 * The viewer's settings with their work folder as it is now (once a request) → { settings, folder: row | null } — the
 * folder only while it is a live folder outside a vault in an area the viewer reads.
 */
function of(ctx) {
  if (!ctx.work) {
    ctx.work = (async () => {
      const settings = await stored(ctx.gc, ctx.viewer);
      let folder = null;
      if (settings.workFolder != null) {
        const n = await nodes.row(ctx.gc, settings.workFolder);
        if (n && n.is_dir === 1 && n.deleted_at == null && !n.vault_id && (await ctx.visible()).some((x) => x.area.id === n.area_id)) folder = n;
      }
      return { settings, folder };
    })();
  }
  return ctx.work;
}

/** The ids of the folders of the viewer's work folder (it and every live folder below it) → Set, or null: none. */
function tree(ctx) {
  if (!ctx.workTree) {
    ctx.workTree = (async () => {
      const { folder } = await of(ctx);
      if (!folder) return null;
      return new Set((await store.all(ctx.gc, TREE, [folder.id])).map((r) => r.id));
    })();
  }
  return ctx.workTree;
}

/** Is node `id` folder `top` or below it? */
async function under(gc, top, id) {
  if (top == null || id == null) return false;
  const r = await store.one(gc, `WITH RECURSIVE up(id, parent_id) AS (
      SELECT id, parent_id FROM nodes WHERE id = ?
      UNION ALL SELECT p.id, p.parent_id FROM nodes p JOIN up ON p.id = up.parent_id)
    SELECT 1 AS x FROM up WHERE id = ? LIMIT 1`, [id, top]);
  return !!r;
}

async function answer(ctx) {
  const { settings, folder } = await of(ctx);
  return {
    workFolder: folder ? folder.id : null, workSubfolders: settings.workSubfolders, workInMemories: settings.workInMemories,
    folder: folder ? { id: folder.id, path: await nodes.pathOf(ctx.gc, folder), areaId: folder.area_id } : null,
  };
}

/** GET photos/settings */
async function get(ctx) {
  return answer(ctx);
}

const bad = (field, reason) => fail('invalid', reason ? { field, reason } : { field });

/** The folder chosen as work folder → its id, else 400 invalid { field: 'workFolder', reason }. */
async function folderArg(ctx, v) {
  const id = posInt(v);
  if (!id) throw bad('workFolder', 'not_found');
  const n = await nodes.row(ctx.gc, id);
  const vis = n && n.deleted_at == null ? (await ctx.visible()).find((x) => x.area.id === n.area_id) : null;
  if (!vis) throw bad('workFolder', 'not_found');
  if (n.vault_id) throw bad('workFolder', 'encrypted');
  if (n.is_dir !== 1) throw bad('workFolder', 'not_folder');
  if (!areas.can(vis.role, 'write')) throw bad('workFolder', 'forbidden');
  if (vis.area.archived_at != null) throw bad('workFolder', 'archived');
  // the camera uploads or a folder above them: every photo would be a work photo
  // (by the path: also before the first backup made them)
  if (n.area_id === areas.idOf.mine(ctx.viewer)) {
    const p = (await nodes.pathOf(ctx.gc, n)).toLowerCase();
    const cam = photos().CAMERA.join('/').toLowerCase();
    if (p === '' || p === cam || cam.startsWith(p + '/')) throw bad('workFolder', 'camera');
  }
  return n.id;
}

function boolArg(v, field) {
  if (typeof v !== 'boolean') throw bad(field);
  return v;
}

/** PUT photos/settings — only the fields sent change. */
async function put(ctx, body) {
  const b = body && typeof body === 'object' ? body : {};
  const now = await stored(ctx.gc, ctx.viewer);
  const next = { ...now };
  if (Object.prototype.hasOwnProperty.call(b, 'workFolder')) next.workFolder = b.workFolder == null ? null : await folderArg(ctx, b.workFolder);
  if (Object.prototype.hasOwnProperty.call(b, 'workSubfolders')) next.workSubfolders = boolArg(b.workSubfolders, 'workSubfolders');
  if (Object.prototype.hasOwnProperty.call(b, 'workInMemories')) next.workInMemories = boolArg(b.workInMemories, 'workInMemories');
  await store.run(ctx.gc, `INSERT INTO photo_settings (user_id, work_folder, work_subfolders, work_in_memories, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET work_folder = excluded.work_folder, work_subfolders = excluded.work_subfolders,
      work_in_memories = excluded.work_in_memories, updated_at = excluded.updated_at`,
  [ctx.viewer, next.workFolder, next.workSubfolders ? 1 : 0, next.workInMemories ? 1 : 0, ctx.now]);
  ctx.work = null;
  ctx.workTree = null;
  return answer(ctx);
}

/** The review mark of node row `n` as the answers carry it → { hint } | null. */
const reviewOf = (n) => (n && n.review_at != null ? { hint: n.review_hint == null ? null : n.review_hint } : null);

function hintArg(v) {
  if (v == null) return null;
  const x = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  if (!Number.isFinite(x) || x < 0 || x > HINT_MAX) throw bad('hint');
  return Math.round(x);
}

/** POST photos/review { ids, review, hint? } → { changed, items: [{ id, review }] } */
async function review(ctx, body) {
  const b = body && typeof body === 'object' ? body : {};
  const list = Array.isArray(b.ids) ? b.ids : null;
  if (!list || !list.length || list.length > IDS_MAX) throw bad('ids');
  const ids = [...new Set(list.map((x) => posInt(x)))];
  if (ids.some((x) => !x)) throw bad('ids');
  if (typeof b.review !== 'boolean') throw bad('review');
  const on = b.review;
  const hasHint = on && Object.prototype.hasOwnProperty.call(b, 'hint');
  const hint = hasHint ? hintArg(b.hint) : null;
  const vis = new Map((await ctx.visible()).map((x) => [x.area.id, x]));
  return store.tx(ctx.gc, async () => {
    const rows = [];
    for (const part of store.chunks(ids)) rows.push(...await store.all(ctx.gc, `SELECT * FROM nodes WHERE id IN (${store.marks(part.length)})`, part));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const missing = ids.filter((id) => { const n = byId.get(id); return !photos().isMedia(n) || !vis.has(n.area_id); });
    if (missing.length) throw fail('invalid', { field: 'ids', ids: missing.slice(0, 50) });
    const closed = ids.filter((id) => { const v = vis.get(byId.get(id).area_id); return !areas.can(v.role, 'write') || v.area.archived_at != null; });
    if (closed.length) throw fail('forbidden', { field: 'ids', ids: closed.slice(0, 50) });
    let changed = 0;
    const items = [];
    for (const id of ids) {
      const n = byId.get(id);
      const nextHint = on ? (hasHint ? hint : n.review_hint) : null;
      const same = on ? n.review_at != null && (n.review_hint == null ? null : n.review_hint) === (nextHint == null ? null : nextHint) : n.review_at == null;
      if (!same) {
        if (on) {
          await store.run(ctx.gc, 'UPDATE nodes SET review_at = COALESCE(review_at, ?), review_hint = ?, review_by = ? WHERE id = ?', [ctx.now, nextHint, ctx.viewer, id]);
        } else {
          await store.run(ctx.gc, 'UPDATE nodes SET review_at = NULL, review_hint = NULL, review_by = NULL WHERE id = ?', [id]);
        }
        await nodes.log(ctx.gc, n.area_id, id, 'review', ctx);
        changed++;
      }
      items.push({ id, review: on ? { hint: nextHint == null ? null : nextHint } : null });
    }
    return { changed, items };
  });
}

const IDS_MAX = 500;

/**
 * Inside the transaction of a move (nodes.update): node `node` went from folder `fromId` to folder `toId`. Moved into or
 * out of the viewer's work folder, the review marks of the node and of everything below it end (each 'review' in the
 * change log but the node's own — its move is logged). The work folder itself or a folder above it: nothing changes.
 */
async function moved(ctx, node, fromId, toId) {
  const s = await stored(ctx.gc, ctx.viewer);
  if (s.workFolder == null) return 0;
  const wf = await nodes.row(ctx.gc, s.workFolder);
  if (!wf || wf.deleted_at != null || wf.is_dir !== 1) return 0;
  if (await under(ctx.gc, node.id, wf.id)) return 0;
  if ((await under(ctx.gc, wf.id, fromId)) === (await under(ctx.gc, wf.id, toId))) return 0;
  const rows = await store.all(ctx.gc, `WITH RECURSIVE down(id) AS (SELECT ?
      UNION ALL SELECT n.id FROM nodes n JOIN down ON n.parent_id = down.id)
    SELECT nodes.id, nodes.area_id FROM nodes JOIN down USING (id) WHERE nodes.review_at IS NOT NULL`, [node.id]);
  if (!rows.length) return 0;
  for (const part of store.chunks(rows.map((r) => r.id))) {
    await store.run(ctx.gc, `UPDATE nodes SET review_at = NULL, review_hint = NULL, review_by = NULL WHERE id IN (${store.marks(part.length)})`, part);
  }
  for (const r of rows) if (r.id !== node.id) await nodes.log(ctx.gc, r.area_id, r.id, 'review', ctx);
  return rows.length;
}

module.exports = { stored, of, tree, under, get, put, review, reviewOf, moved, TREE, IDS_MAX, HINT_MAX };
