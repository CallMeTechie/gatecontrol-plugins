'use strict';

// Services for other plugins (plugin.json services.provides; the caller lists "gatecontrol-drive:<service>" in its
// permissions.services and calls with userId — the person the file belongs to):
//
//   list_areas  {}  → { ok, areas: [{ id, kind, label, role, writable }] }   where the person may save
//   save_file   { mediaId, area, path, onConflict? }
//               mediaId    a file the caller handed over to Drive first (gc.media.handOver(id, { toPlugin:
//                          'gatecontrol-drive', user: userId }) — unclaimed, owned by that person)
//               area       'mine' | 'family' (the person's family) | an area id ('child:4', 'team:2', …)
//               path       'Schule/2026-10 Elternbrief.pdf' — the folders on the way are made
//               onConflict 'rename' (default: "Elternbrief (2).pdf") | 'version' (a new version of that file)
//               → { ok, nodeId, areaId, path, name, created }
//   Codes: invalid, forbidden, not_found, no_seat, not_licensed, quota, upload_invalid, exists.
// The person needs a Drive seat and write access to the area — a service call can do no more than they can.

const store = require('./store');
const nodes = require('./nodes');
const files = require('./files');
const areas = require('./areas');
const { fail, nodeName, MEDIA_RE } = require('./util');

async function listAreas(ctx) {
  const out = (await ctx.visible()).map((v) => ({
    id: v.area.id, kind: v.area.kind, label: ctx.areaLabel(v.area), role: v.role,
    writable: areas.can(v.role, 'write') && v.area.archived_at == null,
  }));
  return { areas: out };
}

/** 'mine' | 'family' | an area id → the visible area entry the person may write to. */
async function areaFor(ctx, spec) {
  const vis = await ctx.visible();
  let v = null;
  if (spec === 'mine' || spec == null) v = vis.find((x) => x.area.kind === 'mine');
  else if (spec === 'family') v = vis.find((x) => x.area.kind === 'family');
  else if (typeof spec === 'string') v = vis.find((x) => x.area.id === spec);
  if (!v) throw fail('not_found', { field: 'area' });
  if (!areas.can(v.role, 'write') || v.area.archived_at != null) throw fail('forbidden');
  return v.area;
}

/** The folders `segs` below the area's root, made where missing (by the person, from the calling plugin). → node */
async function folders(ctx, area, segs) {
  return store.tx(ctx.gc, async () => {
    let cur = await nodes.row(ctx.gc, area.root_id);
    for (const s of segs) {
      let next = await nodes.taken(ctx.gc, area.id, cur.id, s);
      if (next && next.is_dir !== 1) throw fail('exists', { field: 'path' });
      if (!next) {
        const r = await store.run(ctx.gc, `INSERT INTO nodes (area_id, parent_id, name, is_dir, created_at, created_by, updated_at, updated_by)
          VALUES (?, ?, ?, 1, ?, ?, ?, ?)`, [area.id, cur.id, s, ctx.now, ctx.viewer, ctx.now, ctx.viewer]);
        await nodes.log(ctx.gc, area.id, r.lastInsertRowid, 'create', ctx);
        next = await nodes.row(ctx.gc, r.lastInsertRowid);
      }
      cur = next;
    }
    return cur;
  });
}

async function saveFile(ctx, payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  if (typeof p.mediaId !== 'string' || !MEDIA_RE.test(p.mediaId)) throw fail('invalid', { field: 'mediaId' });
  const raw = typeof p.path === 'string' ? p.path.split('/').filter((s) => s.trim() !== '') : [];
  if (!raw.length || raw.length > 32) throw fail('invalid', { field: 'path' });
  const segs = raw.map((s) => nodeName(s));
  const name = segs.pop();
  const onConflict = p.onConflict == null ? 'rename' : String(p.onConflict);
  if (onConflict !== 'rename' && onConflict !== 'version') throw fail('invalid', { field: 'onConflict' });
  const area = await areaFor(ctx, p.area);
  const parent = await folders(ctx, area, segs);
  const r = await files.commit(ctx, { mediaId: p.mediaId, parentId: parent.id, name, onConflict });
  const node = r.node;
  return { nodeId: node.id, areaId: area.id, path: nodes.join(await nodes.pathOf(ctx.gc, parent), node.name), name: node.name, created: r.created };
}

module.exports = { listAreas, saveFile };
