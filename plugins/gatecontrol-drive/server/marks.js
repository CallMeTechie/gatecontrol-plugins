'use strict';

// "Auf dem Gerät gelöscht, wird am … gelöscht" (since 1.5.0): a device that backs up a folder (the Windows app's
// "Ordner sichern") had a file deleted locally — the copy in Drive stays for a while, then goes into the trash.
//
//   DELETE nodes/<id>?after=<seconds>[&device=<id>]   mark: into the trash in <seconds> (1 … 365 days); a node marked
//                                                     already keeps the earlier time (sending it again changes nothing)
//   PATCH  nodes/<id> { deleteAt: <ISO | ms> | null, device? }   set the time exactly, or end the mark (null)
//
// Until then the node is an ordinary node (it is listed, read, synced, shared), with `deleteAt`, `deletedOnDevice`
// (the name of the registered device that asked — devices.js; `device` names one of the person's devices, else the
// device of the asking token) and `deleteMarkedBy`. Each mark and each end of one is a row of the change log (op
// 'mark' | 'unmark'). New content ends a mark (nodes.unmarkUp): a new version, a restored version, a rename or a move,
// anything new in a marked folder. The background run (jobs.js → due) puts what is due into the trash — as the
// person who marked it, from their device; a node of an archived team folder only loses its mark.
//
// Rights: writing in the area (as for DELETE), never the root, never in an archived team folder.

const store = require('./store');
const nodes = require('./nodes');
const links = require('./links');
const { fail, nonNeg, msArg, DEVICE_RE, iso } = require('./util');

const DAY = 86400000;
const MAX_DAYS = 365;
const BATCH = 200;

/** The name of the asking device as the person knows it: `device` (one of their registered ids) or the device token's. */
async function deviceName(ctx, device) {
  if (typeof device === 'string' && DEVICE_RE.test(device)) {
    const r = await store.one(ctx.gc, 'SELECT name FROM user_devices WHERE user_id = ? AND id = ?', [ctx.viewer, device]);
    if (r) return r.name;
  }
  if (ctx.deviceId) {
    const r = await store.one(ctx.gc, 'SELECT name FROM user_devices WHERE user_id = ? AND token_device = ? ORDER BY last_seen DESC LIMIT 1', [ctx.viewer, ctx.deviceId]);
    if (r) return r.name;
  }
  return null;
}

/** A live node the viewer may mark (write, not the root, not archived) → { node, area }. */
async function markable(ctx, id) {
  const { node, area } = await nodes.reach(ctx, Number(id), 'write');
  if (node.parent_id == null) throw fail('invalid');
  if (area.archived_at != null) throw fail('forbidden');
  return { node, area };
}

async function setMark(ctx, node, at, name) {
  await store.run(ctx.gc, 'UPDATE nodes SET delete_at = ?, delete_by = ?, delete_device = ?, delete_device_name = ? WHERE id = ?',
    [at, ctx.viewer || null, ctx.deviceId || null, name, node.id]);
  await nodes.log(ctx.gc, node.area_id, node.id, 'mark', ctx);
}

async function endMark(ctx, node) {
  if (node.delete_at == null) return;
  await store.run(ctx.gc, `UPDATE nodes SET ${nodes.UNMARKED} WHERE id = ?`, [node.id]);
  await nodes.log(ctx.gc, node.area_id, node.id, 'unmark', ctx);
}

/** `after` of DELETE nodes/<id>?after= → seconds (0: delete now), else fail('invalid'). */
function afterArg(v) {
  const s = nonNeg(v);
  if (s == null || s > MAX_DAYS * 86400) throw fail('invalid', { field: 'after' });
  return s;
}

/** DELETE nodes/<id>?after=<s> (s > 0) → { id, marked: true, deleteAt, node }. */
async function after(ctx, id, seconds, device) {
  const name = await deviceName(ctx, device);
  return store.tx(ctx.gc, async () => {
    const { node } = await markable(ctx, id);
    const at = ctx.now + seconds * 1000;
    if (node.delete_at == null || at < node.delete_at) await setMark(ctx, node, at, name);
    const n = await nodes.row(ctx.gc, node.id);
    return { id: n.id, marked: true, deleteAt: iso(n.delete_at), node: nodes.view(n) };
  });
}

/** PATCH nodes/<id> { deleteAt, device? } → the node. A time in the past: the next background run. */
async function set(ctx, id, body) {
  const v = body.deleteAt;
  let at = null;
  if (v !== null) {
    at = msArg(v);
    if (!Number.isFinite(at) || at > ctx.now + MAX_DAYS * DAY) throw fail('invalid', { field: 'deleteAt' });
    at = Math.max(at, ctx.now);
  }
  const name = at == null ? null : await deviceName(ctx, body.device);
  return store.tx(ctx.gc, async () => {
    const { node } = await markable(ctx, id);
    if (at == null) await endMark(ctx, node);
    else if (node.delete_at !== at) await setMark(ctx, node, at, name);
    return nodes.view(await nodes.row(ctx.gc, node.id));
  });
}

/** Background: marked nodes whose time came go into the trash → { trashed, touched: Set of area ids }. */
async function due(gc, now) {
  const touched = new Set();
  const rows = await store.all(gc, 'SELECT id FROM nodes WHERE delete_at IS NOT NULL AND delete_at <= ? AND deleted_at IS NULL ORDER BY delete_at, id LIMIT ?', [now, BATCH]);
  const gone = [];
  let trashed = 0;
  for (const { id } of rows) {
    try {
      const ids = await store.tx(gc, async () => {
        const n = await nodes.row(gc, id);
        if (!n || n.deleted_at != null || n.delete_at == null || n.delete_at > now) return null;
        const ctx = { gc, viewer: n.delete_by, deviceId: n.delete_device, now, touched };
        const area = await store.one(gc, 'SELECT * FROM areas WHERE id = ?', [n.area_id]);
        if (!area || n.parent_id == null || area.archived_at != null) { await endMark(ctx, n); return null; }
        return (await nodes.trashRows(ctx, n, area)).map((r) => r.id);
      });
      if (ids) { trashed++; gone.push(...ids); }
    } catch (e) { gc.log.warn('marked delete failed', (e && e.code) || 'error'); }
  }
  // links of what went into the trash end (as after a DELETE)
  if (gone.length) {
    try { await links.endFor(gc, { folders: [], all: gone }, now); } catch (e) { gc.log.warn('ending links failed', (e && e.code) || 'error'); }
  }
  return { trashed, touched };
}

module.exports = { after, afterArg, set, due, deviceName, MAX_DAYS };
