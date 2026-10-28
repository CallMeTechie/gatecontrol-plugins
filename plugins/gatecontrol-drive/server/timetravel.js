'use strict';

// Time travel ("Zeitreise", since 1.7.0): a folder back to how it was at a time.
//
//   GET  nodes/<folderId>/timetravel?at=<ISO>   the preview — changes nothing
//        → { at, historySince, restore, revert, trash, move, sample: [{ op, name, path }], limited, lost, ops, max }
//   POST nodes/<folderId>/timetravel { at }     the run
//        → { at, before, restored, reverted, trashed, moved, failed, lost }
//
// What the folder held at `at` (everything below it, at any depth):
//   restore  in the trash now, there then: it comes out of the trash (its whole batch; what of it was not there then
//            goes back into the trash)
//   revert   a file whose bytes changed since: the version that was its content then (versions: since … at) is current
//            again, the current bytes become a version — held for the undo (hold_until) like a time travel's
//   move     a name or folder that changed since (node_log, written since history_since): the name and folder of then;
//            a node that came into the folder from elsewhere goes back there (when that folder is still there and the
//            person may write in it, else into the trash)
//   trash    new since then (or in the trash then): into the trash — nothing is deleted for good
// The preview and the run compute the same plan; the run applies it with the person's rights (as any request would),
// is not watched by the ransomware protection (guardSkip) and answers `before` — the moment just before the run: a time
// travel to `before` is its undo.
//
// Limits: names and folders are known only from history_since on (the first start of 1.7.0 — `limited` for an older
// time); a content older than the versions kept (versions_days, versions_max) is gone (`lost`, the file stays as it
// is); what was purged from the trash is gone. At most OPS_MAX operations per run (else 400 invalid { field: 'at' }).

const store = require('./store');
const nodes = require('./nodes');
const files = require('./files');
const areas = require('./areas');
const { fail, iso, msArg } = require('./util');

const DAY = 86400000;
const SAMPLE = 20;
const OPS_MAX = 2000;
const CHUNK = store.CHUNK - 2; // the host takes ≤ 100 parameters a statement

/** Since when the history of names and folders is written (ms): set on the first start of 1.7.0. */
async function historySince(gc, now = Date.now()) {
  const r = await store.one(gc, "SELECT value FROM meta WHERE key = 'history_since'");
  if (r && Number.isFinite(Number(r.value))) return Number(r.value);
  await store.run(gc, "INSERT OR IGNORE INTO meta (key, value) VALUES ('history_since', ?)", [String(now)]);
  const again = await store.one(gc, "SELECT value FROM meta WHERE key = 'history_since'");
  return Number(again.value);
}

/** `at` of a query or body → ms before now, else 400 invalid { field: 'at' }. */
function atArg(v, now) {
  const ms = msArg(v);
  if (ms == null || !Number.isFinite(ms) || ms >= now) throw fail('invalid', { field: 'at' });
  return ms;
}

/** Rows of `sql` (… IN (%s) …) for every chunk of `ids`. */
async function inChunks(gc, sql, ids, before = [], after = []) {
  const out = [];
  for (const part of store.chunks(ids, CHUNK)) {
    out.push(...await store.all(gc, sql.replace('%s', store.marks(part.length)), [...before, ...part, ...after]));
  }
  return out;
}

/**
 * The plan for folder `folderId` and time `at` → { top, area, all (Map id → row), then (Map id → { existed, trashed,
 * parent, name, area } — the node at `at`), depth, present(id), inside, restoreTops, restore, unreachable, moves, back,
 * trashSet, reverts, lost, historySince }.
 */
async function plan(ctx, folderId, at) {
  const gc = ctx.gc;
  const { node: top, area } = await nodes.reach(ctx, Number(folderId), 'write');
  if (top.is_dir !== 1) throw fail('invalid');
  if (area.archived_at != null) throw fail('forbidden');
  const since = await historySince(gc, ctx.now);
  // 1. the nodes: below the folder now (live and in the trash), and those that were below it then and left since
  const all = new Map((await nodes.below(gc, top.id)).map((r) => [r.id, r]));
  const inside = new Set(all.keys());
  let fresh = [top.id, ...all.keys()];
  for (let round = 0; round < 20 && fresh.length; round++) {
    const left = await inChunks(gc, 'SELECT DISTINCT node_id FROM node_log WHERE at > ? AND parent_id IN (%s)', fresh, [at]);
    const ids = left.map((r) => r.node_id).filter((id) => id !== top.id && !all.has(id));
    fresh = [];
    for (const id of ids) {
      const n = await nodes.row(gc, id);
      if (!n || all.has(id)) continue;
      all.set(id, n);
      fresh.push(id);
      for (const r of await nodes.below(gc, id)) if (!all.has(r.id)) { all.set(r.id, r); fresh.push(r.id); }
    }
  }
  const ids = [...all.keys()];
  // 2. their history after `at`: the first row is where they were then; a restore row says they were in the trash
  const logs = new Map();
  for (const r of await inChunks(gc, 'SELECT * FROM node_log WHERE at > ? AND node_id IN (%s) ORDER BY at, id', ids, [at])) {
    if (!logs.has(r.node_id)) logs.set(r.node_id, []);
    logs.get(r.node_id).push(r);
  }
  const then = new Map();
  for (const n of all.values()) {
    const rows = logs.get(n.id) || [];
    const first = rows[0];
    const trashed = rows.some((r) => r.op === 'restore' && r.deleted_since != null && r.deleted_since <= at) || (n.deleted_at != null && n.deleted_at <= at);
    then.set(n.id, {
      existed: n.created_at <= at, trashed,
      parent: first ? first.parent_id : n.parent_id, name: first ? first.name : n.name, area: first ? first.area_id : n.area_id,
      // a vault's node (since 1.9.0): its encrypted name of then (the opaque name never changes)
      cipher: first ? first.name_cipher || null : n.name_cipher || null,
    });
  }
  // there then: it existed, was not in the trash, and its folders lead up to the top
  const depth = new Map();
  const depthOf = (id) => {
    if (depth.has(id)) return depth.get(id);
    depth.set(id, -1); // a loop guard
    const s = then.get(id);
    let d = -1;
    if (s && s.existed && !s.trashed) {
      if (s.parent === top.id) d = 1;
      else if (then.has(s.parent)) { const p = depthOf(s.parent); d = p > 0 ? p + 1 : -1; }
    }
    depth.set(id, d);
    return d;
  };
  for (const id of ids) depthOf(id);
  const present = (id) => depth.get(id) > 0;
  // 3. restore: the batches in the trash that hold something that was there then
  const restoreTops = new Map(); // top id → its row
  const unreachable = new Set();
  for (const n of all.values()) {
    if (n.deleted_at == null || !present(n.id)) continue;
    const t = all.get(n.trash_id);
    // a batch whose top is in the folder, or was there then (it left, then went into the trash)
    if (t && t.trash_id === t.id && (inside.has(t.id) || present(t.id))) restoreTops.set(t.id, t);
    else unreachable.add(n.id);
  }
  const liveAfter = (n) => n.deleted_at == null || (n.trash_id != null && restoreTops.has(n.trash_id));
  const restore = [...all.values()].filter((n) => n.deleted_at != null && present(n.id) && !unreachable.has(n.id));
  // 4. move: there then, its name or folder changed since
  const moves = [];
  for (const n of all.values()) {
    if (!present(n.id) || !liveAfter(n)) continue;
    const s = then.get(n.id);
    if (s.parent !== n.parent_id || s.name !== n.name || (n.vault_id && s.cipher && s.cipher !== n.name_cipher)) moves.push(n);
  }
  moves.sort((a, b) => depth.get(a.id) - depth.get(b.id));
  // nodes that came in from elsewhere: back to their folder of then (when it is there and writable), else the trash
  const back = [];
  const trashSet = new Set();
  const visible = new Map((await ctx.visible()).map((x) => [x.area.id, x]));
  for (const n of all.values()) {
    if (!inside.has(n.id) || present(n.id) || !liveAfter(n)) continue;
    const s = then.get(n.id);
    if (s.existed && !s.trashed && s.parent != null && !inside.has(s.parent) && s.parent !== top.id && !trashSet.has(n.id)) {
      const p = await nodes.row(gc, s.parent);
      const v = p ? visible.get(p.area_id) : null;
      if (p && p.deleted_at == null && p.is_dir === 1 && v && areas.can(v.role, 'write') && v.area.archived_at == null) {
        back.push({ node: n, parent: p.id, name: s.name });
        continue;
      }
    }
    trashSet.add(n.id);
  }
  // what goes back out takes what is below it along: none of it is trashed
  const goesBack = new Set(back.map((b) => b.node.id));
  const underBack = (n) => { for (let p = n.parent_id; p != null && all.has(p); p = all.get(p).parent_id) if (goesBack.has(p)) return true; return false; };
  for (const id of [...trashSet]) if (underBack(all.get(id))) trashSet.delete(id);
  // 5. revert: files there then whose bytes changed since — the version of then (since ≤ at < its end)
  const reverts = [];
  const lost = [];
  const filesThen = [...all.values()].filter((n) => n.is_dir === 0 && present(n.id) && liveAfter(n));
  const firstAfter = new Map();
  for (const v of await inChunks(gc, 'SELECT * FROM versions WHERE at > ? AND node_id IN (%s) ORDER BY node_id, at, id', filesThen.map((n) => n.id), [at])) {
    if (!firstAfter.has(v.node_id)) firstAfter.set(v.node_id, v);
  }
  for (const n of filesThen) {
    const v = firstAfter.get(n.id);
    if (!v) {
      // the bytes came after `at`, but no version of then is left (versions_max, versions_days)
      if (n.content_at != null && n.content_at > at) lost.push(n);
      continue;
    }
    if (v.since != null && v.since > at) { lost.push(n); continue; }
    if (v.sha256 && v.sha256 === n.sha256 && v.size === n.size) continue; // the same bytes
    reverts.push({ node: n, version: v });
  }
  return { top, area, all, then, depth, present, inside, restoreTops, restore, unreachable, moves, back, trashSet, reverts, lost, historySince: since };
}

/** The path below the top of node `id` as it was then (names of then), or now (`now`). */
function pathOf(p, id, now) {
  const names = [];
  for (let cur = id, i = 0; cur != null && cur !== p.top.id && i < 256; i++) {
    const n = p.all.get(cur);
    if (!n) break;
    if (now) { names.unshift(n.name); cur = n.parent_id; } else { const s = p.then.get(cur); names.unshift(s.name); cur = s.parent; }
  }
  return names.join('/');
}

function sampleOf(p) {
  const out = [];
  const push = (op, n, now) => { if (out.length < SAMPLE) out.push({ op, name: now ? n.name : p.then.get(n.id).name, path: pathOf(p, n.id, now) }); };
  for (const n of p.restore) push('restore', n, false);
  for (const r of p.reverts) push('revert', r.node, false);
  for (const n of p.moves) push('move', n, false);
  for (const b of p.back) push('move', b.node, true);
  for (const id of p.trashSet) push('trash', p.all.get(id), true);
  return out;
}

/** The operations a run makes (OPS_MAX). */
const opsOf = (p) => p.restoreTops.size + p.moves.length + p.back.length + topsOf(p).length + p.reverts.length;

/** The nodes of the trash set whose folder is not in it (one trash each). */
function topsOf(p) {
  return [...p.trashSet].filter((id) => !p.trashSet.has(p.all.get(id).parent_id));
}

/** GET nodes/<id>/timetravel?at= → the preview. */
async function preview(ctx, id, q) {
  const at = atArg(q && q.at, ctx.now);
  const p = await plan(ctx, id, at);
  return {
    at: iso(at), historySince: iso(p.historySince),
    restore: p.restore.length, revert: p.reverts.length, trash: p.trashSet.size, move: p.moves.length + p.back.length,
    sample: sampleOf(p), limited: at < p.historySince, lost: p.lost.length, ops: opsOf(p), max: OPS_MAX,
  };
}

/** Tolerate an API error of one operation (counted as failed); anything else ends the run. */
const tolerate = (e) => { if (!e || !e.code) throw e; };

/** POST nodes/<id>/timetravel { at } → the run. */
async function run(ctx, id, body) {
  const at = atArg(body && body.at, ctx.now);
  ctx.guardSkip = true;
  const gc = ctx.gc;
  const p = await plan(ctx, id, at);
  const ops = opsOf(p);
  if (ops > OPS_MAX) throw fail('invalid', { field: 'at', ops, max: OPS_MAX });
  const hold = ctx.now + Math.max(ctx.settings.trashDays, ctx.settings.versionsDays) * DAY;
  let restored = 0;
  let reverted = 0;
  let trashed = 0;
  let moved = 0;
  // in the trash, but its batch is out of reach (its top is outside the folder and was not there then)
  let failed = p.unreachable.size;
  // 1. out of the trash, the outer batches first
  const tops = [...p.restoreTops.values()].sort((a, b) => (p.depth.get(a.id) || 999) - (p.depth.get(b.id) || 999));
  for (const t of tops) {
    const count = p.restore.filter((n) => n.trash_id === t.id).length;
    try { await nodes.restore(ctx, t.id); restored += count; } catch (e) { tolerate(e); failed += count; }
  }
  // 2. names and folders of then (a name taken by what goes into the trash: a free one now, the right one after)
  const later = [];
  const place = async (nodeId, parentId, name, exact, cipher = null) => {
    const n = await nodes.row(gc, nodeId);
    if (!n || n.deleted_at != null) return false;
    if (n.vault_id) {
      // a vault's node: its folder and its encrypted name of then (an older key's name is fine — the devices keep every key);
      // the vault's own folder stays in the top folder of its area (since 1.11.0)
      const v = await store.one(gc, 'SELECT node_id FROM vaults WHERE id = ?', [n.vault_id]);
      if (v && v.node_id === n.id) parentId = n.parent_id;
      const want = cipher && cipher !== n.name_cipher ? cipher : null;
      if (n.parent_id === parentId && !want) return true;
      await nodes.update(ctx, nodeId, { ...(want ? { nameCipher: want } : {}), ...(n.parent_id !== parentId ? { parentId } : {}) }, { anyKey: true });
      return true;
    }
    if (n.parent_id === parentId && n.name === name) return true;
    const parent = await nodes.row(gc, parentId);
    if (!parent || parent.deleted_at != null) return false;
    const busy = await nodes.taken(gc, parent.area_id, parentId, name, n.id);
    if (busy && exact) return false;
    const to = busy ? await nodes.freeName(gc, parent.area_id, parentId, name, n.id) : name;
    if (n.parent_id === parentId && to === n.name) { later.push({ nodeId, parentId, name }); return true; }
    await nodes.update(ctx, nodeId, { name: to, ...(n.parent_id !== parentId ? { parentId } : {}) });
    if (busy) later.push({ nodeId, parentId, name });
    return true;
  };
  for (const n of p.moves) {
    const s = p.then.get(n.id);
    try { if (await place(n.id, s.parent, s.name, false, s.cipher)) moved++; else failed++; } catch (e) { tolerate(e); failed++; }
  }
  for (const b of p.back) {
    try { if (await place(b.node.id, b.parent, b.name, false)) moved++; else failed++; } catch (e) { tolerate(e); failed++; }
  }
  // what came back from the trash under another name (its name was taken) or elsewhere (its folder was in the trash)
  const movedIds = new Set(p.moves.map((n) => n.id));
  for (const n of p.restore) {
    if (movedIds.has(n.id)) continue;
    const s = p.then.get(n.id);
    try { await place(n.id, s.parent, s.name, false, s.cipher); } catch (e) { tolerate(e); }
  }
  // 3. into the trash: what is new since then
  for (const tid of topsOf(p)) {
    const count = [...p.trashSet].filter((x) => x === tid || isBelow(p, x, tid)).length;
    try {
      const n = await nodes.row(gc, tid);
      if (!n || n.deleted_at != null) { failed += count; continue; }
      await nodes.trash(ctx, tid);
      trashed += count;
    } catch (e) { tolerate(e); failed += count; }
  }
  // 4. the right names now that what was in the way is in the trash
  for (const l of later) { try { await place(l.nodeId, l.parentId, l.name, true); } catch (e) { tolerate(e); } }
  // 5. the bytes of then
  for (const r of p.reverts) {
    try { await files.restoreVersion(ctx, r.node.id, r.version.id, hold); reverted++; } catch (e) { tolerate(e); failed++; }
  }
  return { at: iso(at), before: iso(ctx.now - 1), restored, reverted, trashed, moved, failed: Math.max(0, failed), lost: p.lost.length };
}

/** Is node `id` below `top` (by the rows of the plan)? */
function isBelow(p, id, topId) {
  for (let cur = p.all.get(id).parent_id, i = 0; cur != null && i < 256; i++) {
    if (cur === topId) return true;
    const n = p.all.get(cur);
    if (!n) return false;
    cur = n.parent_id;
  }
  return false;
}

module.exports = { preview, run, plan, historySince, OPS_MAX };
