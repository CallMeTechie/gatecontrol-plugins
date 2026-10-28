'use strict';

// Links for people without an account (GateControl's public links, v2 since 1.205.0 — permissions.publicLinks and the
// administrator's switch "Öffentliche Links erlauben"):
//   a file      kind 'files' (the file as it is now — a later version is not in the link), view or download
//   a folder    kind 'folder' (its current content, sub folders, gallery, ZIP), view or download
//   a folder    kind 'upload' — people bring files into it; they land in the tree (hook publicLinkEvent 'upload',
//               the background run reads gc.publicLinks.uploads in case a call of the hook was missed)
// Valid 1, 7 or 30 days, or without an end (only while the administrator allows that), optionally with a PIN.
// Who may share: whoever may write in the area. A folder link points at the folder's path: when the folder is
// renamed, moved or goes into the trash, Drive ends its links (a new folder with the old name must never be shared
// by them); a file in the trash ends its links too.
//
//   POST links { nodeId, mode: 'view'|'download'|'upload', expires: '1d'|'7d'|'30d'|'never', pin?, maxFiles?, maxBytes? }
//   GET links?nodeId=        the viewer's links (or those of a node the viewer may write to)
//   GET links/<token>/events the log (opened, downloaded, uploaded — addresses shortened by GateControl)
//   DELETE links/<token>     end it (whoever made it, or who manages the area)

const store = require('./store');
const nodes = require('./nodes');
const areas = require('./areas');
const sync = require('./sync');
const address = require('./address');
const { fail, posInt, iso, line } = require('./util');

const DAY = 86400000;
const EXPIRES = { '1d': DAY, '7d': 7 * DAY, '30d': 30 * DAY, never: null };
const MODES = ['view', 'download', 'upload'];
const PIN_RE = /^\d{4,8}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{22,64}$/;

/** GateControl's refusals → API codes. */
function linkFail(e, noEnd) {
  const code = e && e.code;
  if (code === 'ERR_PUBLIC_LINKS_DISABLED') return fail('links_disabled');
  if (code === 'ERR_NO_PUBLIC_URL') return fail('no_public_url');
  if (code === 'ERR_INVALID' && noEnd) return fail('no_unlimited');
  if (code === 'ERR_INVALID' || code === 'ERR_RATE_LIMIT') return fail('invalid');
  return e;
}

const api = (gc) => (gc.publicLinks && typeof gc.publicLinks.create === 'function' ? gc.publicLinks : null);

function view(row, link, node) {
  const l = link || {};
  return {
    token: row.token, url: l.url || null, nodeId: row.node_id, areaId: row.area_id, kind: row.kind, mode: row.mode,
    title: l.title || null, name: node ? node.name : null, path: row.path,
    state: row.ended_at != null && (!link || !l.active) ? 'ended' : (l.state || 'gone'), active: !!l.active, endedWhy: row.ended_why || null,
    expiresAt: l.expiresAt == null ? null : iso(l.expiresAt), pin: !!l.pin, opens: l.opens || 0, downloads: l.downloads || 0,
    ...(row.kind === 'upload' ? { upload: l.upload || null } : {}),
    createdAt: iso(row.created_at), createdBy: row.created_by,
  };
}

/** POST links → the link (with its url, shown once and again in the list). */
async function create(ctx, body) {
  const b = body && typeof body === 'object' ? body : {};
  const pl = api(ctx.gc);
  if (!pl) throw fail('links_disabled');
  const nodeId = posInt(b.nodeId);
  if (!nodeId) throw fail('invalid', { field: 'nodeId' });
  const mode = b.mode == null ? 'download' : String(b.mode);
  if (!MODES.includes(mode)) throw fail('invalid', { field: 'mode' });
  const expires = b.expires == null ? '7d' : String(b.expires);
  if (!Object.prototype.hasOwnProperty.call(EXPIRES, expires)) throw fail('invalid', { field: 'expires' });
  const pin = b.pin == null || b.pin === '' ? null : String(b.pin);
  if (pin != null && !PIN_RE.test(pin)) throw fail('invalid', { field: 'pin' });
  const note = b.note == null ? null : line(b.note);
  if (note != null && note.length > 500) throw fail('invalid', { field: 'note' });
  const { node, area } = await nodes.reach(ctx, nodeId, 'write');
  if (area.archived_at != null) throw fail('forbidden');
  // a vault (since 1.9.0): nothing in it is ever shared — the server holds only ciphertext, a link would hand that out
  if (node.vault_id || (node.is_dir === 1 && await store.one(ctx.gc, 'SELECT 1 AS x FROM nodes WHERE vault_id IS NOT NULL AND id IN (WITH RECURSIVE down(id) AS (SELECT id FROM nodes WHERE parent_id = ? UNION ALL SELECT n.id FROM nodes n JOIN down ON n.parent_id = down.id) SELECT id FROM down) LIMIT 1', [node.id]))) {
    throw fail('encrypted');
  }
  if (node.is_dir !== 1 && mode === 'upload') throw fail('invalid', { field: 'mode' });
  if (node.is_dir !== 1 && !node.media_id) throw fail('invalid');
  const p = await nodes.pathOf(ctx.gc, node);
  const kind = node.is_dir === 1 ? (mode === 'upload' ? 'upload' : 'folder') : 'files';
  const title = (node.parent_id == null ? ctx.areaLabel(area) : node.name).slice(0, 120);
  const args = {
    ownerUserId: ctx.viewer, title, ...(note ? { note } : {}), ...(pin ? { pin } : {}),
    expiresAt: EXPIRES[expires] == null ? null : ctx.now + EXPIRES[expires],
  };
  if (kind === 'files') Object.assign(args, { kind, mode, files: [{ mediaId: node.media_id, name: node.name }] });
  else if (kind === 'folder') Object.assign(args, { kind, mode, area: area.media_area, path: p });
  else {
    Object.assign(args, { kind, area: area.media_area, path: p });
    if (b.maxFiles != null) args.maxFiles = Number(b.maxFiles);
    if (b.maxBytes != null) args.maxBytes = Number(b.maxBytes);
  }
  let made;
  try { made = await pl.create(args); } catch (e) { throw linkFail(e, args.expiresAt === null); }
  const row = { token: made.token, node_id: node.id, area_id: area.id, kind, mode, path: kind === 'files' ? '' : p, created_by: ctx.viewer, created_at: ctx.now };
  await store.run(ctx.gc, 'INSERT INTO links (token, node_id, area_id, kind, mode, path, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [row.token, row.node_id, row.area_id, row.kind, row.mode, row.path, row.created_by, row.created_at]);
  let link = null;
  try { link = await pl.get(made.token); } catch { link = null; }
  // the public address GateControl builds links on: Drive's direct links use it too (address.js)
  await address.learn(ctx.gc, made.url);
  return view(row, link || { url: made.url, expiresAt: made.expiresAt, active: true, state: 'active', pin: !!pin, title }, node);
}

/** May the viewer see / end the link of `row`? Whoever made it, or who manages its area. */
async function mayHandle(ctx, row) {
  if (row.created_by === ctx.viewer) return true;
  const v = (await ctx.visible()).find((x) => x.area.id === row.area_id);
  return !!(v && areas.can(v.role, 'manage'));
}

async function rowOf(ctx, token) {
  const row = typeof token === 'string' && TOKEN_RE.test(token) ? await store.one(ctx.gc, 'SELECT * FROM links WHERE token = ?', [token]) : null;
  if (!row || !(await mayHandle(ctx, row))) throw fail('not_found');
  return row;
}

/** GET links?nodeId= → { links, enabled } (enabled false: the administrator has not allowed links). */
async function list(ctx, q) {
  const pl = api(ctx.gc);
  let rows;
  const nodeId = q && q.nodeId != null ? posInt(q.nodeId) : null;
  if (q && q.nodeId != null) {
    if (!nodeId) throw fail('not_found');
    await nodes.reach(ctx, nodeId, 'write');
    rows = await store.all(ctx.gc, 'SELECT * FROM links WHERE node_id = ? ORDER BY created_at DESC LIMIT 200', [nodeId]);
  } else {
    rows = await store.all(ctx.gc, 'SELECT * FROM links WHERE created_by = ? ORDER BY created_at DESC LIMIT 500', [ctx.viewer]);
  }
  const out = [];
  let enabled = !!pl;
  for (const r of rows) {
    let link = null;
    if (enabled) {
      try { link = await pl.get(r.token); } catch (e) {
        if (e && e.code === 'ERR_PUBLIC_LINKS_DISABLED') enabled = false; else throw e;
      }
    }
    out.push(view(r, link, await nodes.row(ctx.gc, r.node_id)));
  }
  return { links: out, enabled };
}

/** DELETE links/<token> → { ended } */
async function revoke(ctx, token) {
  const row = await rowOf(ctx, token);
  const pl = api(ctx.gc);
  let ended = false;
  try { ended = pl ? await pl.revoke(row.token) : false; } catch (e) { throw linkFail(e); }
  await store.run(ctx.gc, 'UPDATE links SET ended_at = COALESCE(ended_at, ?), ended_why = COALESCE(ended_why, ?) WHERE token = ?', [ctx.now, 'revoked', row.token]);
  return { ended };
}

/** GET links/<token>/events → { events } (newest first, ≤ 100). */
async function events(ctx, token, q) {
  const row = await rowOf(ctx, token);
  const pl = api(ctx.gc);
  if (!pl || typeof pl.events !== 'function') return { events: [] };
  const before = q && q.before != null ? posInt(q.before) : null;
  let list;
  try { list = await pl.events(row.token, { limit: 100, ...(before ? { before } : {}) }); } catch (e) { throw linkFail(e); }
  return { events: Array.isArray(list) ? list : [] };
}

/**
 * Drive ends links that would point at the wrong thing: `folders` (node ids of folders renamed / moved, with every
 * folder below) end their folder and upload links, `all` (node ids that went into the trash) every link.
 * Best effort, after the change was committed.
 */
async function endFor(gc, unlink, now) {
  if (!unlink) return 0;
  const pl = api(gc);
  // vault (since 1.9.0): a vault folder was made inside a shared folder — its ciphertext would show in the folder link
  const sets = [['moved', unlink.folders, "kind IN ('folder', 'upload')"], ['trashed', unlink.all, '1 = 1'], ['vault', unlink.vault, "kind = 'folder'"]];
  let n = 0;
  for (const [why, ids, cond] of sets) {
    if (!ids || !ids.length) continue;
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      const rows = await store.all(gc, `SELECT token FROM links WHERE ended_at IS NULL AND ${cond} AND node_id IN (${store.marks(part.length)})`, part);
      for (const r of rows) {
        try { if (pl) await pl.revoke(r.token); } catch (e) { gc.log.warn('link end failed', (e && e.code) || 'error'); }
        await store.run(gc, 'UPDATE links SET ended_at = ?, ended_why = ? WHERE token = ?', [now, why, r.token]);
        n++;
      }
    }
  }
  return n;
}

/**
 * A file came in through an upload link (hook publicLinkEvent 'upload', or the background run): it becomes a file of
 * the tree at its path, made by the link's owner from the device 'link'. → { touched: Set of area ids, adopted, row }
 */
async function adoptUpload(gc, token, up, now) {
  const row = await store.one(gc, 'SELECT * FROM links WHERE token = ?', [token]);
  const touched = new Set();
  if (!row || row.kind !== 'upload' || !up || typeof up.mediaId !== 'string') return { touched, adopted: false, row };
  const a = await areas.row(gc, row.area_id);
  if (!a || a.root_id == null) return { touched, adopted: false, row };
  const ctx = { viewer: row.created_by, deviceId: 'link', now, touched };
  const adopted = await store.tx(gc, () => sync.adopt(gc, a, { mediaId: up.mediaId, path: up.path }, ctx));
  return { touched, adopted, row };
}

/** The background run: uploads the hook did not bring (≤ 50 links per run). → Set of area ids */
async function catchUp(gc, now) {
  const touched = new Set();
  const pl = api(gc);
  if (!pl || typeof pl.uploads !== 'function') return touched;
  const rows = await store.all(gc, "SELECT token FROM links WHERE kind = 'upload' AND ended_at IS NULL ORDER BY created_at DESC LIMIT 50");
  for (const r of rows) {
    let ups;
    try { ups = await pl.uploads(r.token); } catch { ups = null; }
    if (!Array.isArray(ups)) continue;
    for (const u of ups) {
      if (await store.one(gc, 'SELECT 1 AS x FROM nodes WHERE media_id = ?', [u.mediaId])) continue;
      const res = await adoptUpload(gc, r.token, u, now);
      for (const id of res.touched) touched.add(id);
    }
  }
  return touched;
}

/** Rows of links GateControl has forgotten (30 days after their end) go. */
async function forget(gc) {
  const pl = api(gc);
  if (!pl) return 0;
  const rows = await store.all(gc, 'SELECT token FROM links WHERE created_at < ? ORDER BY created_at LIMIT 200', [Date.now() - 31 * DAY]);
  let n = 0;
  for (const r of rows) {
    let l;
    try { l = await pl.get(r.token); } catch { return n; }
    if (l == null) { await store.run(gc, 'DELETE FROM links WHERE token = ?', [r.token]); n++; }
  }
  return n;
}

module.exports = { create, list, revoke, events, endFor, adoptUpload, catchUp, forget, EXPIRES, MODES };
