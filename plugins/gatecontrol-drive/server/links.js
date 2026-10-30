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
//   POST links { nodeIds: [id, …], mode: 'view'|'download', expires, pin?, note?, title? }   one link for several files
//            (since 1.12.0, feature multiLink): files only (a folder among them: 400 invalid { reason: 'mixed' }), at most
//            20 (GateControl's limit of a files link: 400 invalid { reason: 'too_many', max: 20 }), none empty (400
//            invalid { reason: 'empty', ids }) — the link has nodeIds; a file of it in the trash ends it
//   POST zip { ids, name? }  a ZIP of a selection (since 1.12.0, feature zip) → { url, name, expiresAt, files, skipped }:
//            GateControl streams it (stored entries, ZIP64, UTF-8 names) through a link of 15 minutes that is in no list
//            — one folder (with everything in it), or up to 20 files from anywhere (empty files are left out: skipped);
//            anything else 400 invalid { reason: 'mixed' | 'too_many', max }; a vault: 409 encrypted. GateControl ≥ 1.215.0
//            (files links with a path per entry, feature zipMixed): any selection for both — a folder's files under the
//            folder's name (a snapshot), up to GateControl's limit (too_many { max })
//   GET links?nodeId=        the viewer's links (or those of a node the viewer may write to)
//   GET links/<token>/events the log (opened, downloaded, uploaded — addresses shortened by GateControl)
//   DELETE links/<token>     end it (whoever made it, or who manages the area)

const store = require('./store');
const nodes = require('./nodes');
const areas = require('./areas');
const sync = require('./sync');
const address = require('./address');
const { fail, posInt, iso, line, numbered } = require('./util');
const { t } = require('./text');

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

function view(row, link, node, nodeIds) {
  const l = link || {};
  return {
    token: row.token, url: l.url || null, nodeId: row.node_id, areaId: row.area_id, kind: row.kind, mode: row.mode,
    ...(nodeIds && nodeIds.length > 1 ? { nodeIds, count: nodeIds.length } : {}),
    title: l.title || null, name: node ? node.name : null, path: row.path,
    state: row.ended_at != null && (!link || !l.active) ? 'ended' : (l.state || 'gone'), active: !!l.active, endedWhy: row.ended_why || null,
    expiresAt: l.expiresAt == null ? null : iso(l.expiresAt), pin: !!l.pin, opens: l.opens || 0, downloads: l.downloads || 0,
    ...(row.kind === 'upload' ? { upload: l.upload || null } : {}),
    createdAt: iso(row.created_at), createdBy: row.created_by,
  };
}

/**
 * POST links → the link (with its url, shown once and again in the list). opts.expiresAt (ms, since 1.15.0): the end of
 * a link Mail asked for (service share_link, mail.js) instead of `expires`.
 */
async function create(ctx, body, opts = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const pl = api(ctx.gc);
  if (!pl) throw fail('links_disabled');
  if (b.nodeIds != null) {
    const ids = idsOf(b.nodeIds, 'nodeIds');
    if (ids.length > 1) return createMany(ctx, pl, b, ids);
    b.nodeId = ids[0];
  }
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
    expiresAt: Number.isSafeInteger(opts.expiresAt) ? opts.expiresAt : EXPIRES[expires] == null ? null : ctx.now + EXPIRES[expires],
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

const FILES_MAX = 20;
const PATHS_MAX = 5000;
const ZIP_MS = 15 * 60000;

/**
 * GateControl ≥ 1.215.0: files links with a path per entry ({ mediaId, name, path }), up to 5000 entries and 1 TiB — a ZIP
 * and a link of any selection, folders resolved into their files (feature zipMixed). GateControl has no switch of its own
 * for it: it came with gc.media.copy (an older host refuses more than 20 files and ignores `path`). → the most entries
 * a link takes, or 0
 */
function paths(gc) {
  return api(gc) && gc.media && typeof gc.media.copy === 'function' ? PATHS_MAX : 0;
}
const PATHS_BYTES = 1024 ** 4;
const PATH_DEPTH = 64;
// what GateControl refuses in a path besides control characters: bidi controls
const BIDI_RE = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** A path as GateControl takes it: segments without bidi controls, ≤ 255 characters, at most 64 levels. */
function linkPath(p) {
  let segs = String(p || '').split('/').map((x) => x.replace(BIDI_RE, '').slice(0, 255).trim()).filter((x) => x && x !== '.' && x !== '..');
  if (segs.length > PATH_DEPTH) segs = segs.slice(0, PATH_DEPTH - 1).concat([segs.slice(PATH_DEPTH - 1).join('_').slice(0, 255)]);
  return segs.join('/');
}

/** The parent path of "a/b/c.pdf" ("a/b"), '' at the top. */
const dirOf = (p) => (p.lastIndexOf('/') > 0 ? p.slice(0, p.lastIndexOf('/')) : '');

/**
 * The files of a selection with their paths (GateControl ≥ 1.215.0): a file as itself, a folder as every live file below
 * it under the folder's name → { entries: [{ node, path, name }], tops: [{ node, area }], files: [node ids], skipped }.
 * The same file twice (a file and its folder chosen) once; the same name in one path gets "(2)".
 */
async function expand(ctx, ids, need, max) {
  const gc = ctx.gc;
  const entries = [];
  const tops = [];
  const skipped = [];
  const seen = new Set();
  for (const id of ids) {
    const r = await nodes.reach(ctx, id, need);
    if (r.node.vault_id || (r.node.is_dir === 1 && await holdsVault(gc, r.node))) throw fail('encrypted');
    if (need === 'write' && r.area.archived_at != null) throw fail('forbidden');
    if (r.via === 'parent') await ctx.noteChildView(r.area);
    tops.push(r);
    const add = (n, p) => {
      if (seen.has(n.id)) return;
      seen.add(n.id);
      if (!n.media_id) { skipped.push({ id: n.id, reason: 'empty' }); return; }
      entries.push({ node: n, path: linkPath(p) });
      if (entries.length > max) throw fail('invalid', { reason: 'too_many', max });
    };
    if (r.node.is_dir !== 1) { add(r.node, ''); continue; }
    const top = r.node.parent_id == null ? ctx.areaLabel(r.area) : r.node.name;
    const rows = (await nodes.below(gc, r.node.id)).filter((x) => x.deleted_at == null);
    const where = nodes.pathsBelow(r.node.id, top, rows);
    for (const x of rows.filter((y) => y.is_dir === 0).sort((a, b) => String(where.get(a.id)).localeCompare(String(where.get(b.id))))) add(x, dirOf(where.get(x.id)));
  }
  if (entries.reduce((t, e) => t + (e.node.size || 0), 0) > PATHS_BYTES) throw fail('too_large', { maxBytes: PATHS_BYTES });
  // names once per path
  const byPath = new Map();
  for (const e of entries) { if (!byPath.has(e.path)) byPath.set(e.path, []); byPath.get(e.path).push(e); }
  for (const list of byPath.values()) distinct(list.map((e) => e.node.name)).forEach((n, i) => { list[i].name = n; });
  return { entries, tops, skipped };
}

/** The link's nodes: the ones chosen (top) and the files of chosen folders. */
async function linkNodes(gc, token, tops, files) {
  for (const id of tops) await store.run(gc, 'INSERT OR IGNORE INTO link_nodes (token, node_id, top) VALUES (?, ?, 1)', [token, id]);
  const rest = files.filter((id) => !tops.includes(id));
  for (const part of store.chunks(rest, 30)) {
    await store.run(gc, `INSERT OR IGNORE INTO link_nodes (token, node_id, top) VALUES ${part.map(() => '(?, ?, 0)').join(', ')}`, part.flatMap((id) => [token, id]));
  }
}

/** A list of node ids (1 … 10 000, each once). */
function idsOf(v, field) {
  if (!Array.isArray(v) || !v.length || v.length > 10000) throw fail('invalid', { field });
  const out = [];
  for (const x of v) {
    const n = posInt(x);
    if (!n) throw fail('invalid', { field });
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** Names of the files of one link, each once ("Brief.pdf", "Brief (2).pdf"). */
function distinct(names) {
  const seen = new Set();
  return names.map((n) => {
    let c = n;
    for (let i = 2; seen.has(c.toLowerCase()); i++) c = numbered(n, i);
    seen.add(c.toLowerCase());
    return c;
  });
}

/** Does folder `n` hold a node of a vault? */
async function holdsVault(gc, n) {
  return !!(await store.one(gc, 'SELECT 1 AS x FROM nodes WHERE vault_id IS NOT NULL AND id IN (WITH RECURSIVE down(id) AS (SELECT id FROM nodes WHERE parent_id = ? UNION ALL SELECT n.id FROM nodes n JOIN down ON n.parent_id = down.id) SELECT id FROM down) LIMIT 1', [n.id]));
}

/** The files of a link for several (each one the viewer may share). */
async function filesOf(ctx, ids, need) {
  const list = [];
  for (const id of ids) list.push(await nodes.reach(ctx, id, need));
  if (list.some((x) => x.node.vault_id)) throw fail('encrypted');
  if (list.some((x) => x.node.is_dir === 1)) throw fail('invalid', { reason: 'mixed' });
  return list;
}

/** POST links { nodeIds } — one link of kind files for several files (since 1.12.0). */
async function createMany(ctx, pl, b, ids) {
  const mode = b.mode == null ? 'download' : String(b.mode);
  if (mode !== 'view' && mode !== 'download') throw fail('invalid', { field: 'mode' });
  const expires = b.expires == null ? '7d' : String(b.expires);
  if (!Object.prototype.hasOwnProperty.call(EXPIRES, expires)) throw fail('invalid', { field: 'expires' });
  const pin = b.pin == null || b.pin === '' ? null : String(b.pin);
  if (pin != null && !PIN_RE.test(pin)) throw fail('invalid', { field: 'pin' });
  const note = b.note == null ? null : line(b.note);
  if (note != null && note.length > 500) throw fail('invalid', { field: 'note' });
  const given = b.title == null ? null : line(b.title);
  if (given != null && given.length > 120) throw fail('invalid', { field: 'title' });
  const max = paths(ctx.gc);
  if (max) return createMixed(ctx, pl, ids, { mode, expires, pin, note, given, max });
  if (ids.length > FILES_MAX) throw fail('invalid', { reason: 'too_many', max: FILES_MAX });
  const list = await filesOf(ctx, ids, 'write');
  if (list.some((x) => x.area.archived_at != null)) throw fail('forbidden');
  const empty = list.filter((x) => !x.node.media_id).map((x) => x.node.id);
  if (empty.length) throw fail('invalid', { reason: 'empty', ids: empty });
  const names = distinct(list.map((x) => x.node.name));
  const title = given || t(ctx.lang, 'link.files', { n: list.length });
  const args = {
    ownerUserId: ctx.viewer, title, ...(note ? { note } : {}), ...(pin ? { pin } : {}), kind: 'files', mode,
    expiresAt: EXPIRES[expires] == null ? null : ctx.now + EXPIRES[expires],
    files: list.map((x, i) => ({ mediaId: x.node.media_id, name: names[i] })),
  };
  let made;
  try { made = await pl.create(args); } catch (e) { throw linkFail(e, args.expiresAt === null); }
  const first = list[0];
  const row = { token: made.token, node_id: first.node.id, area_id: first.area.id, kind: 'files', mode, path: '', created_by: ctx.viewer, created_at: ctx.now };
  await store.tx(ctx.gc, async () => {
    await store.run(ctx.gc, 'INSERT INTO links (token, node_id, area_id, kind, mode, path, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [row.token, row.node_id, row.area_id, row.kind, row.mode, row.path, row.created_by, row.created_at]);
    for (const x of list) await store.run(ctx.gc, 'INSERT OR IGNORE INTO link_nodes (token, node_id) VALUES (?, ?)', [row.token, x.node.id]);
  });
  let link = null;
  try { link = await pl.get(made.token); } catch { link = null; }
  await address.learn(ctx.gc, made.url);
  return view(row, link || { url: made.url, expiresAt: made.expiresAt, active: true, state: 'active', pin: !!pin, title }, first.node, list.map((x) => x.node.id));
}

/**
 * POST links { nodeIds } with GateControl ≥ 1.215.0 (feature zipMixed): files and folders together — every file of a
 * chosen folder under the folder's name (a snapshot: what comes later is not in it), up to GateControl's limit.
 */
async function createMixed(ctx, pl, ids, o) {
  const x = await expand(ctx, ids, 'write', o.max);
  if (!x.entries.length) throw fail('invalid', { reason: 'empty', ids: x.skipped.map((s) => s.id) });
  const title = o.given || (x.tops.length === 1 && x.tops[0].node.is_dir === 1 ? x.tops[0].node.name : t(ctx.lang, 'link.files', { n: x.entries.length }));
  const args = {
    ownerUserId: ctx.viewer, title: title.slice(0, 120), ...(o.note ? { note: o.note } : {}), ...(o.pin ? { pin: o.pin } : {}), kind: 'files', mode: o.mode,
    expiresAt: EXPIRES[o.expires] == null ? null : ctx.now + EXPIRES[o.expires],
    files: x.entries.map((e) => ({ mediaId: e.node.media_id, name: e.name, ...(e.path ? { path: e.path } : {}) })),
  };
  let made;
  try { made = await pl.create(args); } catch (e) { throw linkFail(e, args.expiresAt === null); }
  const first = x.tops[0];
  const row = { token: made.token, node_id: first.node.id, area_id: first.area.id, kind: 'files', mode: o.mode, path: '', created_by: ctx.viewer, created_at: ctx.now };
  await store.tx(ctx.gc, async () => {
    await store.run(ctx.gc, 'INSERT INTO links (token, node_id, area_id, kind, mode, path, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [row.token, row.node_id, row.area_id, row.kind, row.mode, row.path, row.created_by, row.created_at]);
    await linkNodes(ctx.gc, row.token, x.tops.map((r) => r.node.id), x.entries.map((e) => e.node.id));
  });
  let link = null;
  try { link = await pl.get(made.token); } catch { link = null; }
  await address.learn(ctx.gc, made.url);
  const out = view(row, link || { url: made.url, expiresAt: made.expiresAt, active: true, state: 'active', pin: !!o.pin, title: args.title }, first.node, x.tops.map((r) => r.node.id));
  return { ...out, nodeIds: x.tops.map((r) => r.node.id), count: x.tops.length, files: x.entries.length, ...(x.skipped.length ? { skipped: x.skipped } : {}) };
}

/**
 * POST zip { ids, name? } → { url, name, expiresAt, files, skipped } — a ZIP GateControl streams through a link of 15
 * minutes (a folder link, or a files link of up to 20 files); the person may read each.
 */
async function zip(ctx, body) {
  const b = body && typeof body === 'object' ? body : {};
  const pl = api(ctx.gc);
  if (!pl) throw fail('links_disabled');
  const ids = idsOf(b.ids, 'ids');
  const given = b.name == null ? null : line(b.name);
  if (given != null && (given.length > 120 || !given)) throw fail('invalid', { field: 'name' });
  const expiresAt = ctx.now + ZIP_MS;
  let args;
  let row;
  let count;
  let skipped = [];
  let tops = [];
  let files = [];
  if (ids.length === 1 && (await nodes.reach(ctx, ids[0])).node.is_dir === 1) {
    const { node, area, via } = await nodes.reach(ctx, ids[0]);
    if (node.vault_id || await holdsVault(ctx.gc, node)) throw fail('encrypted');
    if (via === 'parent') await ctx.noteChildView(area);
    const p = await nodes.pathOf(ctx.gc, node);
    const title = (given || (node.parent_id == null ? ctx.areaLabel(area) : node.name)).slice(0, 120);
    count = (await store.one(ctx.gc, `SELECT COUNT(*) AS n FROM nodes WHERE is_dir = 0 AND deleted_at IS NULL AND media_id IS NOT NULL AND id IN (WITH RECURSIVE down(id) AS (
        SELECT id FROM nodes WHERE parent_id = ? UNION ALL SELECT n.id FROM nodes n JOIN down ON n.parent_id = down.id) SELECT id FROM down)`, [node.id])).n;
    if (!count) throw fail('invalid', { reason: 'empty' });
    if (count > 10000) throw fail('too_large', { max: 10000 });
    args = { ownerUserId: ctx.viewer, title, kind: 'folder', mode: 'download', area: area.media_area, path: p, expiresAt };
    row = { node_id: node.id, area_id: area.id, kind: 'folder', path: p };
    tops = [node.id];
  } else if (paths(ctx.gc)) {
    // GateControl ≥ 1.215.0 (feature zipMixed): any selection — folders as their files under the folder's name
    const x = await expand(ctx, ids, 'read', paths(ctx.gc));
    skipped = x.skipped;
    if (!x.entries.length) throw fail('invalid', { reason: 'empty' });
    const one = x.tops.length === 1 ? x.tops[0].node : null;
    const title = (given || (one && one.is_dir !== 1 ? one.name.replace(/\.[^.]{1,16}$/, '') : t(ctx.lang, 'zip.files', { n: x.entries.length }))).slice(0, 120);
    args = { ownerUserId: ctx.viewer, title, kind: 'files', mode: 'download', expiresAt, files: x.entries.map((e) => ({ mediaId: e.node.media_id, name: e.name, ...(e.path ? { path: e.path } : {}) })) };
    row = { node_id: x.tops[0].node.id, area_id: x.tops[0].area.id, kind: 'files', path: '' };
    count = x.entries.length;
    tops = x.tops.map((r) => r.node.id);
    files = x.entries.map((e) => e.node.id);
  } else {
    if (ids.length > FILES_MAX) throw fail('invalid', { reason: 'too_many', max: FILES_MAX });
    const list = await filesOf(ctx, ids, 'read');
    for (const x of list) if (x.via === 'parent') await ctx.noteChildView(x.area);
    skipped = list.filter((x) => !x.node.media_id).map((x) => ({ id: x.node.id, reason: 'empty' }));
    const real = list.filter((x) => x.node.media_id);
    if (!real.length) throw fail('invalid', { reason: 'empty' });
    const names = distinct(real.map((x) => x.node.name));
    const title = (given || (real.length === 1 ? real[0].node.name.replace(/\.[^.]{1,16}$/, '') : t(ctx.lang, 'zip.files', { n: real.length }))).slice(0, 120);
    args = { ownerUserId: ctx.viewer, title, kind: 'files', mode: 'download', expiresAt, files: real.map((x, i) => ({ mediaId: x.node.media_id, name: names[i] })) };
    row = { node_id: real[0].node.id, area_id: real[0].area.id, kind: 'files', path: '' };
    count = real.length;
    tops = real.map((x) => x.node.id);
  }
  let made;
  try { made = await pl.create(args); } catch (e) { throw linkFail(e); }
  await store.tx(ctx.gc, async () => {
    await store.run(ctx.gc, "INSERT INTO links (token, node_id, area_id, kind, mode, path, created_by, created_at, zip) VALUES (?, ?, ?, ?, 'download', ?, ?, ?, 1)",
      [made.token, row.node_id, row.area_id, row.kind, row.path, ctx.viewer, ctx.now]);
    await linkNodes(ctx.gc, made.token, tops, files);
  });
  await address.learn(ctx.gc, made.url);
  return { url: `${made.url}/zip`, name: `${args.title}.zip`, expiresAt: iso(made.expiresAt == null ? expiresAt : made.expiresAt), files: count, skipped };
}

/** Is GateControl's public link service usable (on, switched on by an administrator)? — features zip, multiLink */
async function usable(gc) {
  const pl = api(gc);
  if (!pl || typeof pl.get !== 'function') return false;
  try { await pl.get('drive-probe-0000000000000000'); return true; } catch { return false; }
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
    rows = await store.all(ctx.gc, `SELECT * FROM links WHERE zip = 0 AND (node_id = ? OR token IN (SELECT token FROM link_nodes WHERE node_id = ?))
      ORDER BY created_at DESC LIMIT 200`, [nodeId, nodeId]);
  } else {
    rows = await store.all(ctx.gc, 'SELECT * FROM links WHERE created_by = ? AND zip = 0 ORDER BY created_at DESC LIMIT 500', [ctx.viewer]);
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
    const many = r.kind === 'files' ? (await store.all(ctx.gc, 'SELECT node_id FROM link_nodes WHERE token = ? AND top = 1 ORDER BY rowid', [r.token])).map((x) => x.node_id) : null;
    out.push(view(r, link, await nodes.row(ctx.gc, r.node_id), many));
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
    // (in parts: the host takes at most 100 parameters a statement — each id twice)
    for (const part of store.chunks(ids, 45)) {
      const m = store.marks(part.length);
      // a link for several files (since 1.12.0): any of its files
      const rows = await store.all(gc, `SELECT token FROM links WHERE ended_at IS NULL AND ${cond} AND (node_id IN (${m})
        OR token IN (SELECT token FROM link_nodes WHERE node_id IN (${m})))`, [...part, ...part]);
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
    if (l == null) {
      await store.run(gc, 'DELETE FROM links WHERE token = ?', [r.token]);
      await store.run(gc, 'DELETE FROM link_nodes WHERE token = ?', [r.token]);
      n++;
    }
  }
  return n;
}

module.exports = { create, list, revoke, events, endFor, adoptUpload, catchUp, forget, zip, usable, paths, EXPIRES, MODES, FILES_MAX };
