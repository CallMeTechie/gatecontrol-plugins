'use strict';

// Notebooks and notes (mockups Notizen, Notiz): Markdown text (ui/notemd.js) with check boxes, tables, links, pictures
// and files, #tags, pinned, colours, full-text search. A Tresor notebook (vault.js) holds only ciphertext. Notebooks
// kept for another plugin (Familie's Pinnwand and Packlisten, bound.js) work like shared notebooks.

const store = require('./store');
const people = require('./people');
const events = require('./events');
const fts = require('./fts');
const clientIds = require('./clientids');
const push = require('./push');
const pushprefs = require('./pushprefs');
const lists = require('./lists');
const M = require('../ui/notemd');
const { t } = require('./text');
const { fail, posInt, line, text, area: areaOf, color: colorOf, isDate, b64u, same, stale } = require('./util');

const TITLE_MAX = 300;
const BODY_MAX = 200000;
const CIPHER_MAX = 1000000;
const PAGE = 50;
const MAX_NOTEBOOKS = 300;
const TRASH_MS = 30 * 86400000;

/** A member who may only look (role read) cannot change the notebook's notes. */
function writable(row) { if (row.my_role === 'read') throw fail('forbidden', { reason: 'read_only' }); return row; }

/** The notebook `id` as `userId` sees it (not_found otherwise). */
async function notebookAccess(gc, userId, id) {
  const nid = posInt(id);
  if (!nid) throw fail('not_found');
  const r = await store.one(gc, `SELECT b.*, m.role AS my_role, m.position AS my_position FROM notebook_members m JOIN notebooks b ON b.id = m.notebook_id AND b.deleted_at IS NULL
    WHERE m.user_id = ? AND m.notebook_id = ?`, [userId, nid]);
  if (!r) throw fail('not_found');
  return r;
}

async function memberIds(gc, notebookId) {
  return (await store.all(gc, 'SELECT user_id FROM notebook_members WHERE notebook_id = ?', [notebookId])).map((r) => r.user_id);
}

/** The person's notebook „Notizen“ of an area, made when missing. */
async function ensureDefault(gc, ctx, area) {
  const a = areaOf(area);
  const have = await store.one(gc, 'SELECT id FROM notebooks WHERE owner_id = ? AND area = ? AND is_default = 1 AND deleted_at IS NULL', [ctx.userId, a]);
  if (have) return have.id;
  return store.tx(gc, async () => {
    const again = await store.one(gc, 'SELECT id FROM notebooks WHERE owner_id = ? AND area = ? AND is_default = 1 AND deleted_at IS NULL', [ctx.userId, a]);
    if (again) return again.id;
    const r = await store.run(gc, 'INSERT INTO notebooks (owner_id, area, name, is_default, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)', [ctx.userId, a, t(ctx.lang, 's.default_notebook'), ctx.now, ctx.now]);
    const id = Number(r.lastInsertRowid);
    await store.run(gc, 'INSERT INTO notebook_members (user_id, notebook_id, role, position) VALUES (?, ?, ?, ?)', [ctx.userId, id, 'owner', -1]);
    return id;
  });
}

async function notebookView(gc, ctx, b, counts) {
  const ms = await store.all(gc, 'SELECT user_id, role, since FROM notebook_members WHERE notebook_id = ?', [b.id]);
  const others = [];
  for (const m of ms) if (m.user_id !== b.owner_id) others.push({ id: m.user_id, name: await people.name(gc, m.user_id), role: m.role === 'read' ? 'read' : 'write', since: m.since || null });
  return {
    id: b.id, name: b.vault_id ? null : b.name, area: b.area, color: b.color || null, isDefault: !!b.is_default, role: b.my_role || null,
    canEdit: !!b.my_role && b.my_role !== 'read',
    owner: b.owner_id ? { id: b.owner_id, name: await people.name(gc, b.owner_id) } : null, members: others, shared: ms.length > 1,
    vault: b.vault_id ? { id: b.vault_id, nameCipher: b.name_cipher, keyVersion: b.key_version, needsRotation: !!b.needs_rotation } : null,
    bound: b.bound_plugin ? { plugin: b.bound_plugin, key: b.bound_key, kind: b.bound_kind, label: t(ctx.lang, 'src.' + b.bound_plugin) } : null,
    count: counts ? counts.get(b.id) || 0 : undefined, position: b.my_position || 0,
  };
}

async function noteCounts(gc, ids) {
  const m = new Map();
  for (const part of store.chunks(ids)) {
    if (!part.length) continue;
    for (const r of await store.all(gc, `SELECT notebook_id, COUNT(*) AS n FROM notes INDEXED BY idx_notes_nb WHERE notebook_id IN (${store.marks(part.length)}) AND deleted_at IS NULL GROUP BY notebook_id`, part)) m.set(r.notebook_id, r.n);
  }
  return m;
}

async function notebookRows(gc, ctx, area) {
  return store.all(gc, `SELECT b.*, m.role AS my_role, m.position AS my_position FROM notebook_members m JOIN notebooks b ON b.id = m.notebook_id AND b.deleted_at IS NULL
    WHERE m.user_id = ?${area ? ' AND b.area = ?' : ''} ORDER BY b.is_default DESC, m.position, b.id LIMIT ${MAX_NOTEBOOKS}`, area ? [ctx.userId, area] : [ctx.userId]);
}

/** GET notebooks?area= → { notebooks, tags, total } */
async function notebooks(gc, ctx, area) {
  const a = area ? areaOf(area) : null;
  await ensureDefault(gc, ctx, a || 'private');
  const rows = await notebookRows(gc, ctx, a);
  const counts = await noteCounts(gc, rows.map((r) => r.id));
  const out = [];
  for (const r of rows) out.push(await notebookView(gc, ctx, r, counts));
  return { notebooks: out, tags: await tags(gc, rows.map((r) => r.id)), total: [...counts.values()].reduce((s, n) => s + n, 0) };
}

/** The tags of these notebooks with counts (notebook_tags). */
async function tags(gc, ids) {
  const sum = new Map();
  for (const part of store.chunks(ids)) {
    if (!part.length) continue;
    for (const r of await store.all(gc, `SELECT tag, SUM(n) AS n FROM notebook_tags WHERE notebook_id IN (${store.marks(part.length)}) GROUP BY tag`, part)) sum.set(r.tag, (sum.get(r.tag) || 0) + r.n);
  }
  return [...sum.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 200).map(([tag, n]) => ({ tag, count: n }));
}

/** A notebook create sent again with the same clientId: the notebook as it is now, or 410 when it is gone. */
async function replayNotebook(gc, ctx, id, clientId) {
  let nb;
  try { nb = await notebookAccess(gc, ctx.userId, id); } catch (e) { if (e && e.code === 'not_found') throw clientIds.gone(clientId, id); throw e; }
  return { notebook: await notebookView(gc, ctx, nb), clientId, replayed: true };
}

/** POST notebooks { name, area, color?, clientId? } → { notebook, clientId? } */
async function createNotebook(gc, ctx, b, extra = {}) {
  const cid = extra.vault ? null : clientIds.arg(b.clientId);
  if (cid) { const have = await clientIds.find(gc, ctx.userId, cid, 'notebook'); if (have) return replayNotebook(gc, ctx, have, cid); }
  const name = line(b.name, 80);
  if (!name && !extra.vault) throw fail('invalid', { field: 'name' });
  const c = colorOf(b.color);
  if (c === undefined) throw fail('invalid', { field: 'color' });
  const n = await store.one(gc, 'SELECT COUNT(*) AS n FROM notebooks WHERE owner_id = ? AND deleted_at IS NULL', [ctx.userId]);
  if (n.n >= MAX_NOTEBOOKS) throw fail('too_many');
  const made = await store.tx(gc, async () => {
    if (cid) { const again = await clientIds.find(gc, ctx.userId, cid, 'notebook'); if (again) return { dup: again }; }
    const r = await store.run(gc, `INSERT INTO notebooks (owner_id, area, name, color, vault_id, name_cipher, key_version, recovery_pub, recovery_auth, recovery_holder, ext_kind, ext_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [ctx.userId, areaOf(b.area), extra.vault ? '' : name, c, extra.vault ? extra.vault.id : null, extra.vault ? extra.vault.nameCipher : null,
      extra.vault ? 1 : null, extra.vault ? extra.vault.recoveryPub : null, extra.vault ? extra.vault.recoveryAuth : null, extra.vault ? ctx.userId : null,
      extra.extKind || null, extra.extId || null, ctx.now, ctx.now]);
    const nid = Number(r.lastInsertRowid);
    const pos = await store.one(gc, 'SELECT COALESCE(MAX(position), 0) + 1 AS p FROM notebook_members WHERE user_id = ?', [ctx.userId]);
    await store.run(gc, 'INSERT INTO notebook_members (user_id, notebook_id, role, position, since) VALUES (?, ?, ?, ?, ?)', [ctx.userId, nid, 'owner', pos.p, ctx.now]);
    if (extra.inTx) await extra.inTx(nid);
    await clientIds.claim(gc, ctx, cid, 'notebook', nid);
    return { id: nid };
  });
  if (made.dup) return replayNotebook(gc, ctx, made.dup, cid);
  events.changed(gc, [ctx.userId], 'notebooks');
  return { notebook: await notebookView(gc, ctx, await notebookAccess(gc, ctx.userId, made.id)), ...(cid ? { clientId: cid } : {}) };
}

/**
 * PATCH notebooks/<id> { name?, color?, position?, nameCipher? (Tresor), area?, base? } — `base` as in PATCH tasks for
 * name and colour (409 conflict { fields, notebook }); a name or colour as it is already is not written.
 */
async function updateNotebook(gc, ctx, id, b0) {
  const nb = await notebookAccess(gc, ctx.userId, id);
  const owner = nb.my_role === 'owner';
  const norm = (f, v) => {
    if (f === 'name') { const n = line(v, 80); if (!n) throw fail('invalid', { field: 'name' }); return n; }
    const c = colorOf(v); if (c === undefined) throw fail('invalid', { field: 'color' }); return c;
  };
  const now = { name: nb.vault_id ? null : nb.name, color: nb.color || null };
  const next = {};
  for (const f of ['name', 'color']) if (b0[f] !== undefined && !(f === 'name' && nb.vault_id)) next[f] = norm(f, b0[f]);
  const late = stale(b0.base, now, next, norm);
  if (late.length) throw fail('conflict', { fields: late, notebook: await notebookView(gc, ctx, nb) });
  const b = { ...b0 };
  for (const f of Object.keys(next)) if (same(next[f], now[f])) delete b[f];
  const set = [];
  const args = [];
  if (b.name !== undefined) {
    if (nb.vault_id || nb.bound_plugin || !owner) throw fail('forbidden');
    const n = line(b.name, 80); if (!n) throw fail('invalid', { field: 'name' });
    set.push('name = ?'); args.push(n);
  }
  if (b.nameCipher !== undefined) {
    if (!nb.vault_id || !owner) throw fail('forbidden');
    if (!b64u(b.nameCipher, 80, 1500)) throw fail('invalid', { field: 'nameCipher' });
    set.push('name_cipher = ?'); args.push(b.nameCipher);
  }
  if (b.color !== undefined) {
    const c = colorOf(b.color); if (c === undefined) throw fail('invalid', { field: 'color' });
    if (!owner && !nb.bound_plugin) throw fail('forbidden', { reason: 'owner' });
    set.push('color = ?'); args.push(c);
  }
  if (b.area !== undefined && areaOf(b.area) !== nb.area) { if (!owner || nb.is_default || nb.bound_plugin) throw fail('forbidden'); set.push('area = ?'); args.push(areaOf(b.area)); }
  if (set.length) await store.run(gc, `UPDATE notebooks SET ${set.join(', ')}, updated_at = ? WHERE id = ?`, [...args, ctx.now, nb.id]);
  if (typeof b.position === 'number' && Number.isFinite(b.position)) await store.run(gc, 'UPDATE notebook_members SET position = ? WHERE user_id = ? AND notebook_id = ?', [b.position, ctx.userId, nb.id]);
  events.changed(gc, await memberIds(gc, nb.id), 'notebooks');
  return { notebook: await notebookView(gc, ctx, await notebookAccess(gc, ctx.userId, nb.id)) };
}

/** GET notebooks/<id>/usage — what a delete would touch (the question before it). */
async function usage(gc, ctx, id) {
  const nb = await notebookAccess(gc, ctx.userId, id);
  const n = await store.one(gc, `SELECT COUNT(*) AS n, SUM(CASE WHEN images > 0 THEN 1 ELSE 0 END) AS img, SUM(CASE WHEN files > 0 THEN 1 ELSE 0 END) AS fil
    FROM notes INDEXED BY idx_notes_nb WHERE notebook_id = ? AND deleted_at IS NULL`, [nb.id]);
  const members = [];
  for (const m of await store.all(gc, 'SELECT user_id, role FROM notebook_members WHERE notebook_id = ?', [nb.id])) {
    if (m.user_id !== nb.owner_id) members.push({ id: m.user_id, name: await people.name(gc, m.user_id), role: m.role });
  }
  const canDelete = nb.my_role === 'owner' && !nb.is_default && !nb.bound_plugin;
  let target = null;
  if (canDelete && !nb.vault_id) {
    const d = await store.one(gc, 'SELECT id, name FROM notebooks WHERE owner_id = ? AND area = ? AND is_default = 1 AND deleted_at IS NULL', [ctx.userId, nb.area]);
    target = d ? { id: d.id, name: d.name } : { id: null, name: t(ctx.lang, 's.default_notebook') };
  }
  return { notes: (n && n.n) || 0, withImages: (n && n.img) || 0, withFiles: (n && n.fil) || 0, members, isDefault: !!nb.is_default, canDelete, vault: !!nb.vault_id, target };
}

/**
 * DELETE notebooks/<id>?notes=move|delete — the owner deletes it: `move` puts its notes into the default notebook
 * „Notizen“ of the area (not for a Tresor: 409 encrypted), `delete` (and no parameter, as in 1.1) puts them into the
 * trash. A member leaves it. Deleted already by its owner: { ok, gone }. POST notebooks/<id>/restore undoes it.
 */
async function removeNotebook(gc, ctx, id, q = {}) {
  let nb;
  try { nb = await notebookAccess(gc, ctx.userId, id); } catch (e) {
    if (posInt(id) && await store.one(gc, 'SELECT id FROM notebooks WHERE id = ? AND owner_id = ? AND deleted_at IS NOT NULL', [posInt(id), ctx.userId])) return { ok: true, gone: true };
    throw e;
  }
  const members = await memberIds(gc, nb.id);
  if (nb.bound_plugin) throw fail('forbidden', { reason: 'bound' });
  if (nb.my_role !== 'owner') {
    await store.run(gc, 'DELETE FROM notebook_members WHERE user_id = ? AND notebook_id = ?', [ctx.userId, nb.id]);
    if (nb.vault_id) await store.run(gc, "UPDATE vault_devices SET state = 'revoked', revoked_at = ? WHERE notebook_id = ? AND user_id = ? AND state != 'revoked'", [ctx.now, nb.id, ctx.userId]);
    events.changed(gc, members, 'notebooks');
    return { ok: true, left: true };
  }
  if (nb.is_default) throw fail('forbidden', { reason: 'default' });
  const mode = q.notes == null || q.notes === '' ? 'delete' : q.notes;
  if (!['move', 'delete'].includes(mode)) throw fail('invalid', { field: 'notes' });
  if (mode === 'move' && nb.vault_id) throw fail('encrypted');
  const target = mode === 'move' ? await ensureDefault(gc, ctx, nb.area) : null;
  const rows = await store.all(gc, 'SELECT user_id, role, position, since FROM notebook_members WHERE notebook_id = ?', [nb.id]);
  const ids = await store.all(gc, 'SELECT id, title, body FROM notes INDEXED BY idx_notes_nb WHERE notebook_id = ? AND deleted_at IS NULL', [nb.id]);
  await store.tx(gc, async () => {
    if (target) {
      for (const n of ids) {
        await dropDerived(gc, n.id, nb.id);
        await store.run(gc, 'UPDATE notes SET notebook_id = ?, updated_at = ? WHERE id = ?', [target, ctx.now, n.id]);
        await derive(gc, n.id, target, n.title, n.body, []);
      }
    } else {
      await store.run(gc, 'UPDATE notes SET deleted_at = ? WHERE notebook_id = ? AND deleted_at IS NULL', [ctx.now, nb.id]);
      for (const n of ids) await fts.dropNote(gc, n.id);
      await store.run(gc, 'DELETE FROM notebook_tags WHERE notebook_id = ?', [nb.id]);
    }
    const trash = { mode, target, moved: target ? ids.map((n) => n.id) : [], members: rows.map((r) => [r.user_id, r.role, r.position, r.since || null]) };
    await store.run(gc, 'UPDATE notebooks SET deleted_at = ?, trash_json = ? WHERE id = ?', [ctx.now, JSON.stringify(trash), nb.id]);
    await store.run(gc, 'DELETE FROM notebook_members WHERE notebook_id = ?', [nb.id]);
  });
  events.changed(gc, members, 'notebooks');
  if (target) events.changed(gc, await memberIds(gc, target), 'notes');
  const td = target ? await store.one(gc, 'SELECT id, name FROM notebooks WHERE id = ?', [target]) : null;
  return { ok: true, deleted: true, moved: target ? ids.length : 0, removed: target ? 0 : ids.length, target: td ? { id: td.id, name: td.name } : null, restoreUntil: ctx.now + TRASH_MS };
}

/** POST notebooks/<id>/restore — „Rückgängig“: the owner gets a deleted notebook back (members, roles, notes) while it is in the trash. */
async function restoreNotebook(gc, ctx, id) {
  const nid = posInt(id);
  const nb = nid && await store.one(gc, 'SELECT * FROM notebooks WHERE id = ? AND owner_id = ? AND deleted_at IS NOT NULL AND bound_plugin IS NULL', [nid, ctx.userId]);
  if (!nb || ctx.now - nb.deleted_at > TRASH_MS) throw fail('not_found');
  let trash = null;
  try { trash = nb.trash_json ? JSON.parse(nb.trash_json) : null; } catch { trash = null; }
  const members = trash && Array.isArray(trash.members) && trash.members.length ? trash.members : [[ctx.userId, 'owner', 1000, null]];
  if (!members.some((m) => m[0] === ctx.userId)) members.push([ctx.userId, 'owner', 1000, null]);
  const target = trash && posInt(trash.target);
  await store.tx(gc, async () => {
    await store.run(gc, 'UPDATE notebooks SET deleted_at = NULL, trash_json = NULL, updated_at = ? WHERE id = ?', [ctx.now, nb.id]);
    const back = await store.all(gc, 'SELECT id, title, body FROM notes WHERE notebook_id = ? AND deleted_at = ?', [nb.id, nb.deleted_at]);
    await store.run(gc, 'UPDATE notes SET deleted_at = NULL WHERE notebook_id = ? AND deleted_at = ?', [nb.id, nb.deleted_at]);
    if (!nb.vault_id) for (const n of back) await derive(gc, n.id, nb.id, n.title, n.body, []);
    if (target && Array.isArray(trash.moved)) {
      for (const x of trash.moved) {
        const r = posInt(x) && await store.one(gc, 'SELECT id, title, body FROM notes WHERE id = ? AND notebook_id = ? AND deleted_at IS NULL', [x, target]);
        if (!r) continue;
        await dropDerived(gc, r.id, target);
        await store.run(gc, 'UPDATE notes SET notebook_id = ?, updated_at = ? WHERE id = ?', [nb.id, ctx.now, r.id]);
        await derive(gc, r.id, nb.id, r.title, r.body, []);
      }
    }
    for (const [uid, role, position, since] of members) {
      if (!posInt(uid)) continue;
      await store.run(gc, 'INSERT OR IGNORE INTO notebook_members (user_id, notebook_id, role, position, since) VALUES (?, ?, ?, ?, ?)',
        [uid, nb.id, uid === ctx.userId ? 'owner' : role === 'read' ? 'read' : 'write', typeof position === 'number' ? position : 1000, since || null]);
    }
  });
  const ms = await memberIds(gc, nb.id);
  events.changed(gc, ms, 'notebooks');
  events.changed(gc, ms, 'notes');
  return { notebook: await notebookView(gc, ctx, await notebookAccess(gc, ctx.userId, nb.id)) };
}

/** PUT notebooks/<id>/members { members: [userId | { id, role }…] } — roles read | write as for lists. */
async function setMembers(gc, ctx, id, b) {
  const nb = await notebookAccess(gc, ctx.userId, id);
  if (nb.bound_plugin) throw fail('forbidden');
  if (nb.my_role !== 'owner') throw fail('forbidden', { reason: 'owner' });
  const want = lists.wantedMembers(b.members, ctx.userId);
  const before = new Map((await store.all(gc, 'SELECT user_id, role FROM notebook_members WHERE notebook_id = ?', [nb.id])).map((m) => [m.user_id, m.role]));
  for (const u of want.keys()) if (!before.has(u) && !(await people.mayShare(gc, ctx.userId, u))) throw fail('forbidden', { userId: u });
  const added = [...want.keys()].filter((u) => !before.has(u));
  const gone = [...before.keys()].filter((u) => u !== ctx.userId && !want.has(u));
  const changedRole = [...want.entries()].filter(([u, r]) => before.has(u) && r && before.get(u) !== r && before.get(u) !== 'owner');
  await store.tx(gc, async () => {
    for (const u of added) await store.run(gc, 'INSERT OR IGNORE INTO notebook_members (user_id, notebook_id, role, position, since) VALUES (?, ?, ?, ?, ?)', [u, nb.id, want.get(u) || 'write', 1000, ctx.now]);
    for (const [u, r] of changedRole) await store.run(gc, 'UPDATE notebook_members SET role = ? WHERE user_id = ? AND notebook_id = ?', [r, u, nb.id]);
    for (const u of gone) {
      await store.run(gc, 'DELETE FROM notebook_members WHERE user_id = ? AND notebook_id = ?', [u, nb.id]);
      // a Tresor: the person's devices lose their keys, the next writer rotates (vault.js)
      if (nb.vault_id) {
        await store.run(gc, "UPDATE vault_devices SET state = 'revoked', revoked_at = ? WHERE notebook_id = ? AND user_id = ? AND state != 'revoked'", [ctx.now, nb.id, u]);
        await store.run(gc, 'DELETE FROM vault_keys WHERE notebook_id = ? AND device_id IN (SELECT device_id FROM vault_devices WHERE notebook_id = ? AND user_id = ?)', [nb.id, nb.id, u]);
        await store.run(gc, 'UPDATE notebooks SET needs_rotation = 1 WHERE id = ?', [nb.id]);
      }
    }
  });
  if (added.length) {
    await pushprefs.send(gc, added, 'shared', { topic: 'shared', title: t(ctx.notifyLang, 'n.shared_nb_title', { name: ctx.userName || '' }), body: nb.vault_id ? t(ctx.notifyLang, 'n.vault') : nb.name,
      collapseKey: 'notebook:' + nb.id, data: { notizen: push.sharedNotebook(nb) } });
  }
  events.changed(gc, [...new Set([...before.keys(), ...added])], 'notebooks');
  return { notebook: await notebookView(gc, ctx, await notebookAccess(gc, ctx.userId, nb.id)) };
}

// ── notes ───────────────────────────────────────────

/** The note `id` as the person sees it → the row with the notebook's columns nb_* (not_found otherwise). */
async function access(gc, ctx, id) {
  const nid = posInt(id);
  if (!nid) throw fail('not_found');
  const r = await store.one(gc, `SELECT n.*, b.vault_id AS nb_vault, b.key_version AS nb_key_version, b.area AS nb_area, b.bound_plugin AS nb_bound, b.bound_key AS nb_bound_key,
    b.name AS nb_name, m.role AS my_role FROM notes n JOIN notebooks b ON b.id = n.notebook_id AND b.deleted_at IS NULL
    JOIN notebook_members m ON m.notebook_id = n.notebook_id AND m.user_id = ? WHERE n.id = ? AND n.deleted_at IS NULL`, [ctx.userId, nid]);
  if (!r) throw fail('not_found');
  return r;
}

function summary(r, tagMap) {
  return {
    id: r.id, notebookId: r.notebook_id, title: r.title_cipher ? null : r.title, snippet: r.title_cipher ? null : r.snippet,
    titleCipher: r.title_cipher || null, keyVersion: r.key_version || null, encrypted: !!r.title_cipher,
    pinned: !!r.pinned, color: r.color || null, due: r.due_date || null, expiresAt: r.expires_at || null,
    check: r.check_total ? { done: r.check_done, total: r.check_total } : null, images: r.images, files: r.files,
    tags: tagMap ? tagMap.get(r.id) || [] : undefined, ext: r.ext_kind || null,
    createdAt: r.created_at, updatedAt: r.updated_at, updatedBy: r.updated_by || null, rev: r.rev,
  };
}

async function tagsOf(gc, ids) {
  const m = new Map();
  for (const part of store.chunks(ids)) {
    if (!part.length) continue;
    for (const r of await store.all(gc, `SELECT note_id, tag FROM note_tags WHERE note_id IN (${store.marks(part.length)})`, part)) {
      if (!m.has(r.note_id)) m.set(r.note_id, []);
      m.get(r.note_id).push(r.tag);
    }
  }
  return m;
}

/**
 * GET notes?area=&notebook=&tag=&pinned=1&before=<updatedAt>:<id>&limit= → { notes, next } — newest first. Without a
 * notebook: every notebook of the area the person sees (idx_notes_updated; a notebook: idx_notes_nb).
 */
async function list(gc, ctx, q) {
  const limit = Math.min(200, posInt(q.limit) || PAGE);
  const cur = /^(\d{1,15}):(\d{1,15})$/.exec(String(q.before || ''));
  const after = cur ? ` AND (n.updated_at < ${Number(cur[1])} OR (n.updated_at = ${Number(cur[1])} AND n.id < ${Number(cur[2])}))` : '';
  let rows;
  const pinned = q.pinned === '1' || q.pinned === true;
  if (q.notebook) {
    const nb = await notebookAccess(gc, ctx.userId, q.notebook);
    rows = await store.all(gc, `SELECT n.* FROM notes n INDEXED BY ${pinned ? 'idx_notes_pinned' : 'idx_notes_nb'} WHERE n.notebook_id = ? AND n.deleted_at IS NULL${pinned ? ' AND n.pinned = 1' : ''}${after}
      ORDER BY n.updated_at DESC, n.id DESC LIMIT ?`, [nb.id, limit + 1]);
  } else if (q.tag) {
    const tag = String(q.tag).toLowerCase().normalize('NFC').slice(0, 40);
    rows = await store.all(gc, `SELECT n.* FROM note_tags g JOIN notes n ON n.id = g.note_id AND n.deleted_at IS NULL
      JOIN notebook_members m ON m.notebook_id = n.notebook_id AND m.user_id = ? JOIN notebooks b ON b.id = n.notebook_id AND b.deleted_at IS NULL AND b.area = ?
      WHERE g.tag = ?${after} ORDER BY n.updated_at DESC, n.id DESC LIMIT ?`, [ctx.userId, areaOf(q.area), tag, limit + 1]);
  } else {
    const nbs = (await notebookRows(gc, ctx, areaOf(q.area))).map((r) => r.id);
    if (!nbs.length) return { notes: [], next: null };
    if (pinned) {
      rows = [];
      for (const part of store.chunks(nbs)) {
        rows.push(...await store.all(gc, `SELECT n.* FROM notes n INDEXED BY idx_notes_pinned WHERE n.notebook_id IN (${store.marks(part.length)}) AND n.pinned = 1 AND n.deleted_at IS NULL${after}
          ORDER BY n.updated_at DESC, n.id DESC LIMIT ?`, [...part, limit + 1]));
      }
      rows.sort((a, b) => b.updated_at - a.updated_at || b.id - a.id);
    } else if (nbs.length <= store.CHUNK) {
      rows = await store.all(gc, `SELECT n.* FROM notes n INDEXED BY idx_notes_updated WHERE n.deleted_at IS NULL AND n.notebook_id IN (${store.marks(nbs.length)})${after}
        ORDER BY n.updated_at DESC, n.id DESC LIMIT ?`, [...nbs, limit + 1]);
    } else {
      rows = await store.all(gc, `SELECT n.* FROM notes n INDEXED BY idx_notes_updated WHERE n.deleted_at IS NULL AND n.notebook_id IN
        (SELECT m.notebook_id FROM notebook_members m JOIN notebooks b ON b.id = m.notebook_id AND b.deleted_at IS NULL AND b.area = ? WHERE m.user_id = ?)${after}
        ORDER BY n.updated_at DESC, n.id DESC LIMIT ?`, [areaOf(q.area), ctx.userId, limit + 1]);
    }
  }
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  const tm = await tagsOf(gc, page.map((r) => r.id));
  const last = page[page.length - 1];
  return { notes: page.map((r) => summary(r, tm)), next: more && last ? `${last.updated_at}:${last.id}` : null };
}

/** The search index, tags, counts and snippet of a plain note (inside a transaction). */
async function derive(gc, id, notebookId, title, body, oldTags) {
  const plainText = M.plain(body);
  const tg = M.tags(body);
  const checks = M.checks(body);
  const snippet = plainText.replace(/\n/g, ' · ').slice(0, 240);
  await store.run(gc, 'UPDATE notes SET snippet = ?, check_done = ?, check_total = ? WHERE id = ?', [snippet, checks.filter((c) => c.done).length, checks.length, id]);
  const before = new Set(oldTags || []);
  const after = new Set(tg);
  for (const x of before) if (!after.has(x)) {
    await store.run(gc, 'DELETE FROM note_tags WHERE note_id = ? AND tag = ?', [id, x]);
    await store.run(gc, 'UPDATE notebook_tags SET n = n - 1 WHERE notebook_id = ? AND tag = ?', [notebookId, x]);
  }
  for (const x of after) if (!before.has(x)) {
    await store.run(gc, 'INSERT OR IGNORE INTO note_tags (note_id, tag) VALUES (?, ?)', [id, x]);
    await store.run(gc, 'INSERT INTO notebook_tags (notebook_id, tag, n) VALUES (?, ?, 1) ON CONFLICT(notebook_id, tag) DO UPDATE SET n = n + 1', [notebookId, x]);
  }
  await store.run(gc, 'DELETE FROM notebook_tags WHERE notebook_id = ? AND n <= 0', [notebookId]);
  const ocr = (await store.all(gc, "SELECT ocr FROM attachments WHERE kind = 'note' AND ref_id = ? AND ocr IS NOT NULL", [id])).map((r) => r.ocr).join('\n');
  await fts.setNote(gc, id, title, plainText, tg, ocr);
}

async function dropDerived(gc, id, notebookId) {
  for (const r of await store.all(gc, 'SELECT tag FROM note_tags WHERE note_id = ?', [id])) {
    await store.run(gc, 'UPDATE notebook_tags SET n = n - 1 WHERE notebook_id = ? AND tag = ?', [notebookId, r.tag]);
  }
  await store.run(gc, 'DELETE FROM note_tags WHERE note_id = ?', [id]);
  await store.run(gc, 'DELETE FROM notebook_tags WHERE notebook_id = ? AND n <= 0', [notebookId]);
  await fts.dropNote(gc, id);
}

function cipherArgs(nb, b) {
  if (!b64u(b.titleCipher, 80, 1500)) throw fail('invalid', { field: 'titleCipher' });
  if (b.cipher != null && !b64u(b.cipher, 40, CIPHER_MAX)) throw fail('invalid', { field: 'cipher' });
  if (b.keyVersion !== nb.key_version) throw fail('stale_key', { keyVersion: nb.key_version });
  if (b.title != null || b.body != null) throw fail('encrypted');
}

/** Things changed in a notebook another plugin keeps: tell it (bound.js reads bound_dirty). */
async function markBound(gc, nbId, noteId, removed, now) {
  await store.run(gc, `INSERT INTO bound_dirty (notebook_id, note_id, removed, at) VALUES (?, ?, ?, ?)
    ON CONFLICT(notebook_id, note_id) DO UPDATE SET removed = excluded.removed, at = excluded.at`, [nbId, noteId, removed ? 1 : 0, now]);
}

/** A note create sent again with the same clientId → { id } of the note made first; 410 when it is gone. */
async function replayNote(gc, ctx, id, clientId) {
  try { await access(gc, ctx, id); } catch (e) { if (e && e.code === 'not_found') throw clientIds.gone(clientId, id); throw e; }
  return { id, clientId, replayed: true };
}

/**
 * POST notes { notebookId?, area?, title?, body?, pinned?, color?, due?, expiresAt?, clientId?, notebookClientId? } — or
 * in a Tresor { notebookId, titleCipher, cipher, keyVersion, clientId? } → { note } (the API answers with GET notes/<id>)
 */
async function create(gc, ctx, b0, opts = {}) {
  const cid = opts.inTx ? null : clientIds.arg(b0.clientId);
  if (cid) { const have = await clientIds.find(gc, ctx.userId, cid, 'note'); if (have) return replayNote(gc, ctx, have, cid); }
  const b = { ...b0 };
  if (b.notebookId == null && b.notebookClientId != null) b.notebookId = await clientIds.resolve(gc, ctx, b.notebookClientId, 'notebook', 'notebookClientId');
  const nbId = b.notebookId != null ? b.notebookId : await ensureDefault(gc, ctx, b.area);
  const nb = opts.notebook || await notebookAccess(gc, ctx.userId, nbId);
  if (!opts.notebook) writable(nb);
  const c = colorOf(b.color);
  if (c === undefined) throw fail('invalid', { field: 'color' });
  if (b.due != null && !isDate(b.due)) throw fail('invalid', { field: 'due' });
  if (b.expiresAt != null && !(Number.isSafeInteger(b.expiresAt) && b.expiresAt > 0)) throw fail('invalid', { field: 'expiresAt' });
  let title = '';
  let body = '';
  if (nb.vault_id) cipherArgs(nb, b);
  else { title = line(b.title, TITLE_MAX); body = text(b.body, BODY_MAX); }
  const by = opts.by === undefined ? ctx.userId : opts.by;
  const made = await (opts.inTx ? (fn) => fn() : (fn) => store.tx(gc, fn))(async () => {
    if (cid) { const again = await clientIds.find(gc, ctx.userId, cid, 'note'); if (again) return { dup: again }; }
    const r = await store.run(gc, `INSERT INTO notes (notebook_id, title, body, pinned, color, due_date, expires_at, title_cipher, cipher, key_version, ext_kind, ext_id,
      created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [nb.id, title, body, b.pinned ? 1 : 0, c, b.due || null, b.expiresAt || null, nb.vault_id ? b.titleCipher : null, nb.vault_id ? b.cipher || null : null,
      nb.vault_id ? b.keyVersion : null, opts.extKind || null, opts.extId || null, by, by, opts.createdAt || ctx.now, opts.updatedAt || ctx.now]);
    const nid = Number(r.lastInsertRowid);
    if (!nb.vault_id) await derive(gc, nid, nb.id, title, body, []);
    if (nb.bound_plugin) await markBound(gc, nb.id, nid, false, ctx.now);
    await clientIds.claim(gc, ctx, cid, 'note', nid);
    return { id: nid };
  });
  if (made.dup) return replayNote(gc, ctx, made.dup, cid);
  const id = made.id;
  if (!opts.quiet) events.changed(gc, await memberIds(gc, nb.id), 'notes');
  return { note: summary(await store.one(gc, 'SELECT * FROM notes WHERE id = ?', [id]), new Map([[id, nb.vault_id ? [] : M.tags(body)]])), id, ...(cid ? { clientId: cid } : {}) };
}

/** GET notes/<id> → { note: { …summary, body | cipher, attachments, tasks } } */
async function get(gc, ctx, id, opts = {}) {
  const r = await access(gc, ctx, id);
  const tm = await tagsOf(gc, [r.id]);
  const note = summary(r, tm);
  note.body = r.title_cipher ? null : r.body;
  note.cipher = r.cipher || null;
  note.notebook = { id: r.notebook_id, name: r.nb_vault ? null : r.nb_name, area: r.nb_area, vault: !!r.nb_vault, bound: r.nb_bound || null };
  note.attachments = opts.attachments ? await opts.attachments(gc, ctx, 'note', r.id) : [];
  // the tasks its lines became (chips „Aufgabe · Mi.“)
  const ids = r.title_cipher ? [] : M.checks(r.body).map((c) => c.task).filter(Boolean);
  const ts = [];
  for (const part of store.chunks([...new Set(ids)])) {
    if (!part.length) continue;
    ts.push(...await store.all(gc, `SELECT id, title, due_date, due_time, done_at FROM tasks WHERE id IN (${store.marks(part.length)}) AND deleted_at IS NULL`, part));
  }
  note.tasks = ts.map((x) => ({ id: x.id, title: x.title, due: x.due_date ? { date: x.due_date, time: x.due_time || null } : null, done: !!x.done_at }));
  return { note };
}

/** Whether PATCH notes would change nothing: every field given is as it is already (a change sent twice). */
function unchanged(r, b) {
  const eq = (k, v) => b[k] === undefined || same(v, b[k]);
  if (b.title !== undefined && (r.nb_vault || line(b.title, TITLE_MAX) !== r.title)) return false;
  if (b.body !== undefined && (r.nb_vault || text(b.body, BODY_MAX) !== r.body)) return false;
  if (b.titleCipher !== undefined && b.titleCipher !== r.title_cipher) return false;
  if (b.cipher !== undefined && (b.cipher || null) !== (r.cipher || null)) return false;
  if ((b.titleCipher !== undefined || b.cipher !== undefined) && b.keyVersion !== r.key_version) return false;
  if (b.pinned !== undefined && !!b.pinned !== !!r.pinned) return false;
  if (b.color !== undefined && colorOf(b.color) !== (r.color || null)) return false;
  if (b.notebookId !== undefined && posInt(b.notebookId) !== r.notebook_id) return false;
  return eq('due', r.due_date || null) && eq('expiresAt', r.expires_at || null);
}

/**
 * PATCH notes/<id> { title?, body?, pinned?, color?, due?, expiresAt?, notebookId?, rev? } (Tresor: titleCipher, cipher,
 * keyVersion) — `rev` given and stale → 409 conflict { rev }; a change that sets only what the note has already answers
 * 200 whatever its rev (1.1.0: an edit queued offline and sent twice).
 */
async function update(gc, ctx, id, b) {
  const r = await access(gc, ctx, id);
  if (unchanged(r, b)) return get(gc, ctx, r.id);
  writable(r);
  if (b.rev != null && b.rev !== r.rev) throw fail('conflict', { rev: r.rev });
  const set = [];
  const args = [];
  const put = (col, v) => { set.push(col + ' = ?'); args.push(v); };
  let title = r.title;
  let body = r.body;
  if (r.nb_vault) {
    if (b.titleCipher !== undefined || b.cipher !== undefined) {
      cipherArgs({ key_version: r.nb_key_version, vault_id: r.nb_vault }, { ...b, titleCipher: b.titleCipher !== undefined ? b.titleCipher : r.title_cipher });
      if (b.titleCipher !== undefined) put('title_cipher', b.titleCipher);
      if (b.cipher !== undefined) put('cipher', b.cipher);
      put('key_version', b.keyVersion);
    }
    if (b.title !== undefined || b.body !== undefined) throw fail('encrypted');
  } else {
    if (b.title !== undefined) { title = line(b.title, TITLE_MAX); put('title', title); }
    if (b.body !== undefined) { body = text(b.body, BODY_MAX); put('body', body); }
  }
  if (b.pinned !== undefined) put('pinned', b.pinned ? 1 : 0);
  if (b.color !== undefined) { const c = colorOf(b.color); if (c === undefined) throw fail('invalid', { field: 'color' }); put('color', c); }
  if (b.due !== undefined) { if (b.due !== null && !isDate(b.due)) throw fail('invalid', { field: 'due' }); put('due_date', b.due); }
  if (b.expiresAt !== undefined) { if (b.expiresAt !== null && !(Number.isSafeInteger(b.expiresAt) && b.expiresAt > 0)) throw fail('invalid', { field: 'expiresAt' }); put('expires_at', b.expiresAt); }
  let target = null;
  if (b.notebookId !== undefined && posInt(b.notebookId) !== r.notebook_id) {
    target = writable(await notebookAccess(gc, ctx.userId, b.notebookId));
    if (!!target.vault_id !== !!r.nb_vault || (target.vault_id && target.vault_id !== r.nb_vault)) throw fail('encrypted');
    put('notebook_id', target.id);
  }
  if (!set.length) return get(gc, ctx, r.id);
  const oldTags = (await tagsOf(gc, [r.id])).get(r.id) || [];
  await store.tx(gc, async () => {
    await store.run(gc, `UPDATE notes SET ${set.join(', ')}, rev = rev + 1, updated_by = ?, updated_at = ? WHERE id = ?`, [...args, ctx.userId, ctx.now, r.id]);
    if (!r.nb_vault) {
      if (target) { await dropDerived(gc, r.id, r.notebook_id); await derive(gc, r.id, target.id, title, body, []); }
      else if (b.title !== undefined || b.body !== undefined) await derive(gc, r.id, r.notebook_id, title, body, oldTags);
    }
    if (r.nb_bound) await markBound(gc, r.notebook_id, r.id, !!target, ctx.now);
    if (target && target.bound_plugin) await markBound(gc, target.id, r.id, false, ctx.now);
  });
  const ms = new Set(await memberIds(gc, r.notebook_id));
  if (target) for (const u of await memberIds(gc, target.id)) ms.add(u);
  events.changed(gc, [...ms], 'notes');
  return get(gc, ctx, r.id);
}

/** DELETE notes/<id> — into the trash (30 days, then purged with its attachments). In the trash already: { ok, gone } for a member. */
async function remove(gc, ctx, id, opts = {}) {
  let r = opts.row;
  if (!r) {
    try { r = await access(gc, ctx, id); } catch (e) {
      if (posInt(id) && await store.one(gc, `SELECT n.id FROM notes n JOIN notebook_members m ON m.notebook_id = n.notebook_id AND m.user_id = ?
        WHERE n.id = ? AND n.deleted_at IS NOT NULL`, [ctx.userId, posInt(id)])) return { ok: true, gone: true };
      throw e;
    }
    writable(r);
  }
  await (opts.inTx ? (fn) => fn() : (fn) => store.tx(gc, fn))(async () => {
    await store.run(gc, 'UPDATE notes SET deleted_at = ?, updated_at = ? WHERE id = ?', [ctx.now, ctx.now, r.id]);
    await dropDerived(gc, r.id, r.notebook_id);
    if (r.nb_bound || opts.bound) await markBound(gc, r.notebook_id, r.id, true, ctx.now);
  });
  events.changed(gc, await memberIds(gc, r.notebook_id), 'notes');
  return { ok: true };
}

/** POST notes/<id>/check { line, done } — tick a check box of the text. */
async function check(gc, ctx, id, b) {
  const r = writable(await access(gc, ctx, id));
  if (r.nb_vault) throw fail('encrypted');
  const ln = Number.isSafeInteger(b.line) && b.line >= 0 ? b.line : null;
  const body = ln == null ? null : M.toggle(r.body, ln, !!b.done);
  if (body == null) throw fail('invalid', { field: 'line' });
  const out = await update(gc, ctx, r.id, { body });
  // a line that became a task: the task follows
  const c = M.checks(body).find((x) => x.line === ln);
  if (c && c.task && opts.completeTask) await opts.completeTask(gc, ctx, c.task, !!b.done).catch(() => {});
  return out;
}
const opts = {};

/** POST notes/<id>/task { line, listId?, due? } — a line of the note becomes a task (the line gets a link to it). */
async function lineToTask(gc, ctx, id, b, tasksMod) {
  const r = writable(await access(gc, ctx, id));
  if (r.nb_vault) throw fail('encrypted');
  const ln = Number.isSafeInteger(b.line) && b.line >= 0 ? b.line : null;
  const title = ln == null ? null : M.lineText(r.body, ln);
  if (!title) throw fail('invalid', { field: 'line' });
  const made = await tasksMod.create(gc, ctx, { title, listId: b.listId, area: r.nb_area, due: b.due, noteId: r.id, myDay: b.myDay });
  const body = M.linkTask(r.body, ln, made.task.id, t(ctx.lang, 's.task_chip'));
  const note = await update(gc, ctx, r.id, { body });
  return { task: made.task, note: note.note };
}

/** Notes counts for the menu (views.nav). */
async function nav(gc, ctx, area) {
  const n = await notebooks(gc, ctx, area);
  return { total: n.total, notebooks: n.notebooks, tags: n.tags.slice(0, 30) };
}

module.exports = {
  notebookAccess, memberIds, ensureDefault, notebookView, notebooks, createNotebook, updateNotebook, removeNotebook, restoreNotebook, usage, setMembers, writable,
  access, list, get, create, update, remove, check, lineToTask, nav, summary, derive, dropDerived, markBound, opts, TITLE_MAX, BODY_MAX,
};
