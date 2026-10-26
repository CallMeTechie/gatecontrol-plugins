'use strict';

// The change log for devices: GET changes?since=<seq>&limit= → the changes in the areas the viewer reads, each with
// the node as it is now (null once purged). A new device starts with since=0 or with `latest` of GET me.
// After every request that changed something the readers of those areas get the live event 'changed'
// { areas, seq } (gc.events) and fetch at once.

const store = require('./store');
const areas = require('./areas');
const nodes = require('./nodes');

const PAGE_MAX = 1000;

async function latest(gc) {
  const r = await store.one(gc, 'SELECT COALESCE(MAX(seq), 0) AS s FROM changes');
  return r.s;
}

/** → { changes: [{ seq, op, areaId, nodeId, at, by, device, node }], next, more } */
async function since(ctx, q) {
  const from = Math.max(0, Number(q && q.since) || 0);
  const limit = Math.min(PAGE_MAX, Math.max(1, Number(q && q.limit) || 500));
  const ids = (await ctx.visible()).map((x) => x.area.id);
  if (!ids.length) return { changes: [], next: from, more: false };
  const rows = await store.all(ctx.gc, `SELECT * FROM changes WHERE area_id IN (${store.marks(ids.length)}) AND seq > ? ORDER BY seq LIMIT ?`, [...ids, from, limit + 1]);
  const page = rows.slice(0, limit);
  const out = [];
  for (const c of page) {
    const n = await nodes.row(ctx.gc, c.node_id);
    // a node that moved to another area: its old area sees it as deleted
    const node = n && n.area_id === c.area_id ? nodes.view(n) : null;
    out.push({ seq: c.seq, op: c.op, areaId: c.area_id, nodeId: c.node_id, at: new Date(c.at).toISOString(), by: c.by, device: c.device, node });
  }
  return { changes: out, next: page.length ? page[page.length - 1].seq : Math.max(from, rows.length ? from : await latest(ctx.gc)), more: rows.length > limit };
}

/** The live event to the readers of the areas `ids` (best effort; never fails the request). */
async function announce(gc, ids, settings) {
  if (!ids || !ids.size || typeof (gc.events && gc.events.emit) !== 'function') return;
  const seq = await latest(gc);
  const byUser = new Map();
  for (const id of ids) {
    const a = await areas.row(gc, id);
    if (!a) continue;
    for (const u of await areas.readers(gc, a, settings)) {
      if (!byUser.has(u)) byUser.set(u, new Set());
      byUser.get(u).add(id);
    }
  }
  // one event per set of areas (usually one)
  const groups = new Map();
  for (const [u, set] of byUser) {
    const key = [...set].sort().join(',');
    if (!groups.has(key)) groups.set(key, { areas: [...set].sort(), users: [] });
    groups.get(key).users.push(u);
  }
  for (const g of groups.values()) {
    try { await gc.events.emit({ users: g.users, type: 'changed', data: { areas: g.areas, seq } }); } catch (e) { gc.log.warn('event failed', (e && e.code) || 'error'); }
  }
}

module.exports = { since, latest, announce };
