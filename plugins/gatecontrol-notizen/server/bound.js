'use strict';

// Notebooks kept for another plugin (docs/notes-sources-contract.md § 3): Familie's Pinnwand (key 'pinnwand') and
// Packlisten (key 'packlisten') live here and are shown back in Familie through the services notes_bind, notes_list,
// note_save, note_check, note_delete, notes_import. A change made in the hub is told to the owner with
// <owner>:notes_changed (at most once a minute and notebook, from the background run).
//
// A note's checklist is the Markdown check boxes of its text; an item's id is "<line>.<6 hex of SHA-256 of its text>"
// — stable while the line does not change, found again by its text when lines moved.

const crypto = require('node:crypto');
const store = require('./store');
const notes = require('./notes');
const events = require('./events');
const M = require('../ui/notemd');
const { fail, posInt, line, text, color: colorOf, isDate } = require('./util');

const OWNERS = ['gatecontrol-familie'];
const KEY_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const ANSWER_MAX = 14000;
const NOTES_MAX = 500;
const ITEMS_MAX = 200;

const hash6 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 6);
const itemId = (c) => `${c.line}.${hash6(c.text)}`;

async function bookOf(gc, caller, key) {
  if (!OWNERS.includes(caller)) throw fail('forbidden');
  if (typeof key !== 'string' || !KEY_RE.test(key)) throw fail('invalid', { field: 'key' });
  const nb = await store.one(gc, 'SELECT * FROM notebooks WHERE bound_plugin = ? AND bound_key = ? AND deleted_at IS NULL', [caller, key]);
  if (!nb) throw fail('not_found');
  return nb;
}

async function member(gc, nb, user) {
  const uid = user && posInt(user.id);
  if (!uid) throw fail('forbidden');
  const m = await store.one(gc, 'SELECT 1 AS x FROM notebook_members WHERE notebook_id = ? AND user_id = ?', [nb.id, uid]);
  if (!m) throw fail('forbidden');
  return uid;
}

/** The Markdown of a bound note: its text, then its checklist. */
function compose(txt, checklist) {
  const parts = [];
  const tx = text(txt || '', 4000).trim();
  if (tx) parts.push(tx);
  if (checklist && checklist.length) parts.push(checklist.map((c) => `- [${c.done ? 'x' : ' '}] ${line(c.text, 200).replace(/\[([^\]]*)\]\(/g, '$1 (')}`).join('\n'));
  return parts.join('\n\n');
}

function noteOut(r) {
  const checks = M.checks(r.body);
  const checkLines = new Set(checks.map((c) => c.line));
  const rest = String(r.body || '').split('\n').filter((_, i) => !checkLines.has(i)).join('\n');
  return {
    id: r.id, title: r.title, text: M.plain(rest).slice(0, 2000), color: r.color || 'none', pinned: !!r.pinned, expiresAt: r.expires_at || null, due: r.due_date || null,
    checklist: checks.slice(0, ITEMS_MAX).map((c) => ({ id: itemId(c), text: c.text, done: c.done })),
    progress: checks.length ? { done: checks.filter((c) => c.done).length, total: checks.length } : null,
    updatedAt: r.updated_at, updatedBy: r.updated_by || null, createdBy: r.created_by || null, open: { plugin: 'gatecontrol-notizen', route: 'note/' + r.id },
  };
}

function ctxOf(base, uid) { return { ...base, userId: uid }; }

/** notes_bind { key, title, kind, members, area? } (no user) */
async function bind(gc, base, caller, p) {
  if (!OWNERS.includes(caller)) throw fail('forbidden');
  if (typeof p.key !== 'string' || !KEY_RE.test(p.key)) throw fail('invalid', { field: 'key' });
  const title = line(p.title, 60);
  if (!title) throw fail('invalid', { field: 'title' });
  if (p.kind !== 'notes' && p.kind !== 'checklists') throw fail('invalid', { field: 'kind' });
  if (!Array.isArray(p.members) || !p.members.length || p.members.length > 50) throw fail('invalid', { field: 'members' });
  const members = [...new Set(p.members.map(posInt))];
  if (members.includes(null)) throw fail('invalid', { field: 'members' });
  const id = await store.tx(gc, async () => {
    let nb = await store.one(gc, 'SELECT * FROM notebooks WHERE bound_plugin = ? AND bound_key = ?', [caller, p.key]);
    if (!nb) {
      const r = await store.run(gc, 'INSERT INTO notebooks (owner_id, area, name, bound_plugin, bound_key, bound_kind, created_at, updated_at) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?)',
        [p.area === 'work' ? 'work' : 'private', title, caller, p.key, p.kind, base.now, base.now]);
      nb = { id: Number(r.lastInsertRowid) };
    } else {
      await store.run(gc, 'UPDATE notebooks SET name = ?, bound_kind = ?, deleted_at = NULL, updated_at = ? WHERE id = ?', [title, p.kind, base.now, nb.id]);
    }
    const before = (await store.all(gc, 'SELECT user_id FROM notebook_members WHERE notebook_id = ?', [nb.id])).map((r) => r.user_id);
    for (const u of before) if (!members.includes(u)) await store.run(gc, 'DELETE FROM notebook_members WHERE notebook_id = ? AND user_id = ?', [nb.id, u]);
    for (const u of members) if (!before.includes(u)) await store.run(gc, 'INSERT INTO notebook_members (user_id, notebook_id, role, position) VALUES (?, ?, ?, ?)', [u, nb.id, 'write', 500]);
    return nb.id;
  });
  events.changed(gc, members, 'notebooks');
  return { ok: true, notebookId: id };
}

/** notes_list { key, cursor?, since? } */
async function listNotes(gc, base, caller, user, p) {
  const nb = await bookOf(gc, caller, p.key);
  await member(gc, nb, user);
  const cur = /^(\d{1,15}):(\d{1,15})$/.exec(String(p.cursor || ''));
  const since = Number.isSafeInteger(p.since) && p.since > 0 ? p.since : null;
  const args = [nb.id];
  let where = 'n.notebook_id = ? AND n.deleted_at IS NULL';
  if (since) { where += ' AND n.updated_at > ?'; args.push(since); }
  if (cur) { where += ' AND (n.updated_at < ? OR (n.updated_at = ? AND n.id < ?))'; args.push(Number(cur[1]), Number(cur[1]), Number(cur[2])); }
  const rows = await store.all(gc, `SELECT n.* FROM notes n INDEXED BY idx_notes_nb WHERE ${where} ORDER BY n.updated_at DESC, n.id DESC LIMIT 60`, args);
  const out = [];
  let size = 200;
  let next = null;
  for (const r of rows) {
    const o = noteOut(r);
    const s = JSON.stringify(o).length;
    if (out.length && size + s > ANSWER_MAX) { const last = out[out.length - 1]; next = `${last.updatedAt}:${last.id}`; break; }
    size += s;
    out.push(o);
  }
  if (!next && rows.length === 60) { const last = out[out.length - 1]; next = `${last.updatedAt}:${last.id}`; }
  const res = { ok: true, notes: out, cursor: next };
  if (since && !cur) {
    const gone = await store.all(gc, 'SELECT id FROM notes WHERE notebook_id = ? AND deleted_at IS NOT NULL AND deleted_at > ? ORDER BY deleted_at DESC LIMIT 200', [nb.id, since]);
    res.removed = gone.map((g) => g.id);
  }
  return res;
}

function checklistArg(v) {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > ITEMS_MAX) throw fail('invalid', { field: 'checklist' });
  return v.map((c) => {
    if (!c || typeof c.text !== 'string' || !line(c.text, 200)) throw fail('invalid', { field: 'checklist' });
    return { text: c.text, done: c.done === true };
  });
}

/** What the owner plugin changed itself through these services is not told back to it (notes_changed). */
const quiet = (gc, nbId, noteId) => store.run(gc, 'DELETE FROM bound_dirty WHERE notebook_id = ? AND note_id = ?', [nbId, noteId]);

/** note_save { key, id?, title?, text?, color?, pinned?, expiresAt?, due?, checklist? } */
async function save(gc, base, caller, user, p) {
  const nb = await bookOf(gc, caller, p.key);
  const uid = await member(gc, nb, user);
  const ctx = ctxOf(base, uid);
  const c = colorOf(p.color);
  if (p.color !== undefined && c === undefined) throw fail('invalid', { field: 'color' });
  if (p.due != null && !isDate(p.due)) throw fail('invalid', { field: 'due' });
  const checklist = checklistArg(p.checklist);
  if (p.id == null) {
    const n = await store.one(gc, 'SELECT COUNT(*) AS n FROM notes WHERE notebook_id = ? AND deleted_at IS NULL', [nb.id]);
    if (n.n >= NOTES_MAX) throw fail('too_many');
    const made = await notes.create(gc, ctx, { notebookId: nb.id, title: p.title || '', body: compose(p.text, checklist || []), color: p.color, pinned: !!p.pinned, due: p.due || null, expiresAt: p.expiresAt || null });
    await quiet(gc, nb.id, made.id);
    return { ok: true, note: noteOut(await store.one(gc, 'SELECT * FROM notes WHERE id = ?', [made.id])) };
  }
  const r = await store.one(gc, 'SELECT * FROM notes WHERE id = ? AND notebook_id = ? AND deleted_at IS NULL', [posInt(p.id) || 0, nb.id]);
  if (!r) throw fail('not_found');
  const cur = noteOut(r);
  const b = {};
  if (p.title !== undefined) b.title = p.title;
  if (p.text !== undefined || checklist !== undefined) b.body = compose(p.text !== undefined ? p.text : cur.text, checklist !== undefined ? checklist : cur.checklist);
  for (const k of ['color', 'pinned', 'expiresAt', 'due']) if (p[k] !== undefined) b[k] = p[k];
  await notes.update(gc, ctx, r.id, b);
  await quiet(gc, nb.id, r.id);
  return { ok: true, note: noteOut(await store.one(gc, 'SELECT * FROM notes WHERE id = ?', [r.id])) };
}

/** note_check { key, noteId, itemId, done } */
async function checkItem(gc, base, caller, user, p) {
  const nb = await bookOf(gc, caller, p.key);
  const uid = await member(gc, nb, user);
  const r = await store.one(gc, 'SELECT * FROM notes WHERE id = ? AND notebook_id = ? AND deleted_at IS NULL', [posInt(p.noteId) || 0, nb.id]);
  if (!r) throw fail('not_found');
  const m = /^(\d{1,5})\.([0-9a-f]{6})$/.exec(String(p.itemId || ''));
  if (!m) throw fail('invalid', { field: 'itemId' });
  const checks = M.checks(r.body);
  const c = checks.find((x) => x.line === Number(m[1]) && hash6(x.text) === m[2]) || checks.find((x) => hash6(x.text) === m[2]);
  if (!c) throw fail('not_found');
  await notes.update(gc, ctxOf(base, uid), r.id, { body: M.toggle(r.body, c.line, p.done === true) });
  await quiet(gc, nb.id, r.id);
  const after = noteOut(await store.one(gc, 'SELECT * FROM notes WHERE id = ?', [r.id]));
  return { ok: true, note: { id: r.id, progress: after.progress } };
}

/** note_delete { key, id } */
async function del(gc, base, caller, user, p) {
  const nb = await bookOf(gc, caller, p.key);
  const uid = await member(gc, nb, user);
  const r = await store.one(gc, 'SELECT * FROM notes WHERE id = ? AND notebook_id = ? AND deleted_at IS NULL', [posInt(p.id) || 0, nb.id]);
  if (!r) throw fail('not_found');
  await notes.remove(gc, ctxOf(base, uid), r.id, { row: { ...r, nb_bound: nb.bound_plugin } });
  await quiet(gc, nb.id, r.id);
  return { ok: true };
}

/** notes_import { key, notes: [{ ref, title?, text?, color?, pinned?, expiresAt?, due?, authorId?, createdAt?, checklist? }] } (no user) */
async function importNotes(gc, base, caller, p) {
  const nb = await bookOf(gc, caller, p.key);
  if (!Array.isArray(p.notes) || p.notes.length > 100) throw fail('invalid', { field: 'notes' });
  const ids = {};
  let imported = 0;
  let skipped = 0;
  const members = (await store.all(gc, 'SELECT user_id FROM notebook_members WHERE notebook_id = ?', [nb.id])).map((r) => r.user_id);
  for (const n of p.notes) {
    if (!n || typeof n.ref !== 'string' || !/^[A-Za-z0-9:._-]{1,60}$/.test(n.ref)) { skipped++; continue; }
    const have = await store.one(gc, "SELECT id FROM notes INDEXED BY idx_notes_ext WHERE notebook_id = ? AND ext_kind = 'familie' AND ext_id = ?", [nb.id, n.ref]);
    if (have) { ids[n.ref] = have.id; skipped++; continue; }
    let checklist;
    try { checklist = checklistArg(n.checklist) || []; } catch { skipped++; continue; }
    const c = colorOf(n.color);
    const author = posInt(n.authorId) && members.includes(posInt(n.authorId)) ? posInt(n.authorId) : null;
    const at = Number.isSafeInteger(n.createdAt) && n.createdAt > 0 ? n.createdAt : base.now;
    const made = await notes.create(gc, { ...base, userId: author }, {
      notebookId: nb.id, title: n.title || '', body: compose(n.text, checklist), color: c === undefined ? null : c, pinned: !!n.pinned,
      due: isDate(n.due) ? n.due : null, expiresAt: Number.isSafeInteger(n.expiresAt) && n.expiresAt > 0 ? n.expiresAt : null,
    }, { notebook: nb, by: author, createdAt: at, updatedAt: at, extKind: 'familie', extId: n.ref, quiet: true });
    ids[n.ref] = made.id;
    imported++;
  }
  // the owner already has these: no notes_changed for its own import
  await store.run(gc, 'DELETE FROM bound_dirty WHERE notebook_id = ?', [nb.id]);
  events.changed(gc, members, 'notes');
  return { ok: true, imported, skipped, ids };
}

/** Background: tell owners what changed in their notebooks (notes_changed), at most every minute per notebook. */
async function flush(gc, now) {
  const books = await store.all(gc, `SELECT d.notebook_id, b.bound_plugin, b.bound_key, MAX(d.at) AS at FROM bound_dirty d JOIN notebooks b ON b.id = d.notebook_id
    GROUP BY d.notebook_id LIMIT 20`);
  let sent = 0;
  for (const b of books) {
    if (!b.bound_plugin) { await store.run(gc, 'DELETE FROM bound_dirty WHERE notebook_id = ?', [b.notebook_id]); continue; }
    if (now - b.at < 30000) continue;
    const rows = await store.all(gc, 'SELECT note_id, removed FROM bound_dirty WHERE notebook_id = ? AND at <= ? LIMIT 500', [b.notebook_id, b.at]);
    let ok = false;
    try {
      if (await gc.services.available(b.bound_plugin, 'notes_changed')) {
        await gc.services.call({ plugin: b.bound_plugin, service: 'notes_changed', payload: { v: 1, key: b.bound_key, ids: rows.filter((r) => !r.removed).map((r) => r.note_id), removed: rows.filter((r) => r.removed).map((r) => r.note_id), at: b.at } });
        sent++;
      }
      ok = true;
    } catch (e) {
      if (e && e.code === 'ERR_RATE_LIMIT') continue;
      ok = true; // the owner refreshes on its own too (contract): do not pile up
    }
    if (ok) for (const r of rows) await store.run(gc, 'DELETE FROM bound_dirty WHERE notebook_id = ? AND note_id = ? AND at <= ?', [b.notebook_id, r.note_id, b.at]);
  }
  return sent;
}

module.exports = { OWNERS, bind, listNotes, save, checkItem, del, importNotes, flush, itemId, compose };
