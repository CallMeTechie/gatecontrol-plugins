'use strict';

// Pinboard & packing lists — "Pinnwand & Packlisten" (module board, default on).
//
//   GET    board                                   { notes, checklists, templates }
//   GET    board/notes            POST board/notes             PATCH|DELETE board/notes/<id>
//   GET    board/checklists       POST board/checklists        GET|PATCH|DELETE board/checklists/<id>
//   POST   board/checklists/<id>/items                         { text }
//   PATCH  board/checklists/<id>/items/<itemId>                { done?, text? }
//   DELETE board/checklists/<id>/items/<itemId>
//   POST   board/checklists/<id>/reset                         (addition) every item open again
//   GET    board/templates        POST board/templates         PATCH|DELETE board/templates/<id>
//
// Notes { id, text ≤ 500, color, pinned, authorId, createdAt, expiresAt|null }:
// every member reads, writes and edits; the author and parents delete.
// Expired notes are gone (hidden at once, deleted by the tick).
// Checklists { id, title ≤ 60, items: [{ id, text ≤ 80, done, doneBy }],
// fromTemplateId, createdAt } — POST { templateId } copies a template,
// POST { title, items?: [text] } starts one; item ops like shopping (any
// member). Templates { id, title, items: [text] } — POST { checklistId } (from
// a checklist) or { title, items }. Checklists and templates: the creator and
// parents delete.

const store = require('./store');
const { fail, posInt, text, multiline, bool, iso, parseIso, parseJson, line } = require('./util');

const COLORS = ['yellow', 'green', 'blue', 'pink', 'grey'];
const NOTE_MAX = 500;
const TITLE_MAX = 60;
const ITEM_MAX = 80;
const MAX_NOTES = 200;
const MAX_LISTS = 100;
const MAX_ITEMS = 200;
const MAX_TEMPLATES = 50;

const noteView = (n) => ({
  id: n.id, text: n.text, color: COLORS.includes(n.color) ? n.color : 'yellow', pinned: !!n.pinned, authorId: n.author_id,
  createdAt: iso(n.created_at), updatedAt: iso(n.updated_at), expiresAt: iso(n.expires_at),
});
const itemView = (i) => ({ id: i.id, text: i.text, done: !!i.done, doneBy: i.done_by == null ? null : i.done_by });
const templateView = (t) => ({ id: t.id, title: t.title, items: parseJson(t.items_json, []), createdBy: t.created_by == null ? null : t.created_by, createdAt: iso(t.created_at) });

function checklistView(c, items) {
  const own = items.filter((i) => i.checklist_id === c.id).map(itemView);
  return {
    id: c.id, title: c.title, items: own, fromTemplateId: c.from_template_id == null ? null : c.from_template_id, createdAt: iso(c.created_at),
    createdBy: c.created_by == null ? null : c.created_by, open: own.filter((i) => !i.done).length,
  };
}

const mayDelete = (r, authorId) => authorId === r.me.userId || r.me.role === 'parent';

// ─── notes ──────────────────────────────────────

async function notes(gc, r) {
  const rows = await store.all(gc, 'SELECT * FROM board_notes WHERE expires_at IS NULL OR expires_at > ? ORDER BY pinned DESC, created_at DESC, id DESC', [r.now]);
  return rows.map(noteView);
}

function noteText(v) {
  const s = multiline(v);
  if (!s || s.length > NOTE_MAX) throw fail('invalid', { field: 'text' });
  return s;
}

function color(v) {
  if (!COLORS.includes(v)) throw fail('invalid', { field: 'color' });
  return v;
}

/** expiresAt: an ISO time in the future, or null. */
function expires(v, now) {
  if (v == null || v === '') return null;
  const ms = parseIso(v);
  if (ms == null || ms <= now) throw fail('invalid', { field: 'expiresAt' });
  return ms;
}

async function noteRow(gc, r, raw) {
  const id = posInt(raw);
  const n = id ? await store.one(gc, 'SELECT * FROM board_notes WHERE id = ?', [id]) : null;
  if (!n || (n.expires_at != null && n.expires_at <= r.now)) throw fail('not_found');
  return n;
}

async function createNote(gc, r) {
  const b = r.body || {};
  if ((await store.one(gc, 'SELECT COUNT(*) AS n FROM board_notes')).n >= MAX_NOTES) throw fail('too_many');
  const res = await store.run(gc, 'INSERT INTO board_notes (text, color, pinned, author_id, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [noteText(b.text), b.color == null ? 'yellow' : color(b.color), b.pinned == null ? 0 : (bool(b.pinned) ? 1 : 0), r.me.userId, r.now, r.now, expires(b.expiresAt, r.now)]);
  return { note: noteView(await store.one(gc, 'SELECT * FROM board_notes WHERE id = ?', [res.lastInsertRowid])) };
}

async function updateNote(gc, r, raw) {
  const n = await noteRow(gc, r, raw);
  const b = r.body || {};
  await store.run(gc, 'UPDATE board_notes SET text = ?, color = ?, pinned = ?, expires_at = ?, updated_at = ? WHERE id = ?', [
    b.text !== undefined ? noteText(b.text) : n.text, b.color !== undefined ? color(b.color) : n.color,
    b.pinned !== undefined ? (bool(b.pinned) ? 1 : 0) : n.pinned, b.expiresAt !== undefined ? expires(b.expiresAt, r.now) : n.expires_at, r.now, n.id]);
  return { note: noteView(await store.one(gc, 'SELECT * FROM board_notes WHERE id = ?', [n.id])) };
}

async function removeNote(gc, r, raw) {
  const n = await noteRow(gc, r, raw);
  if (!mayDelete(r, n.author_id)) throw fail('forbidden');
  await store.run(gc, 'DELETE FROM board_notes WHERE id = ?', [n.id]);
  return {};
}

// ─── checklists ─────────────────────────────────

async function checklists(gc) {
  const lists = await store.all(gc, 'SELECT * FROM checklists ORDER BY created_at DESC, id DESC');
  const items = await store.all(gc, 'SELECT * FROM checklist_items ORDER BY sort, id');
  return lists.map((c) => checklistView(c, items));
}

async function oneChecklist(gc, id) {
  const c = await store.one(gc, 'SELECT * FROM checklists WHERE id = ?', [id]);
  if (!c) throw fail('not_found');
  return checklistView(c, await store.all(gc, 'SELECT * FROM checklist_items WHERE checklist_id = ? ORDER BY sort, id', [id]));
}

function itemText(v) {
  const s = line(v);
  if (!s || s.length > ITEM_MAX) throw fail('invalid', { field: 'text' });
  return s;
}

/** A list of item texts (templates, a new checklist). */
function itemTexts(v) {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > MAX_ITEMS) throw fail('invalid', { field: 'items' });
  return v.map(itemText);
}

async function addItems(gc, listId, texts, now) {
  const max = (await store.one(gc, 'SELECT COALESCE(MAX(sort), -1) AS s, COUNT(*) AS n FROM checklist_items WHERE checklist_id = ?', [listId]));
  if (max.n + texts.length > MAX_ITEMS) throw fail('too_many');
  let s = max.s;
  const ids = [];
  for (const t of texts) {
    const res = await store.run(gc, 'INSERT INTO checklist_items (checklist_id, text, done, done_by, sort, created_at) VALUES (?, ?, 0, NULL, ?, ?)', [listId, t, ++s, now]);
    ids.push(res.lastInsertRowid);
  }
  return ids;
}

async function createChecklist(gc, r) {
  const b = r.body || {};
  if ((await store.one(gc, 'SELECT COUNT(*) AS n FROM checklists')).n >= MAX_LISTS) throw fail('too_many');
  let title;
  let texts;
  let from = null;
  if (b.templateId != null) {
    const id = posInt(b.templateId);
    const t = id ? await store.one(gc, 'SELECT * FROM checklist_templates WHERE id = ?', [id]) : null;
    if (!t) throw fail('not_found');
    title = b.title != null ? text(b.title, TITLE_MAX) : t.title;
    texts = parseJson(t.items_json, []).filter((x) => typeof x === 'string');
    from = t.id;
  } else {
    title = text(b.title, TITLE_MAX);
    texts = itemTexts(b.items);
  }
  const res = await store.run(gc, 'INSERT INTO checklists (title, from_template_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [title, from, r.me.userId, r.now, r.now]);
  await addItems(gc, res.lastInsertRowid, texts, r.now);
  return { checklist: await oneChecklist(gc, res.lastInsertRowid) };
}

async function checklistRow(gc, raw) {
  const id = posInt(raw);
  const c = id ? await store.one(gc, 'SELECT * FROM checklists WHERE id = ?', [id]) : null;
  if (!c) throw fail('not_found');
  return c;
}

async function updateChecklist(gc, r, raw) {
  const c = await checklistRow(gc, raw);
  const b = r.body || {};
  if (b.title !== undefined) await store.run(gc, 'UPDATE checklists SET title = ?, updated_at = ? WHERE id = ?', [text(b.title, TITLE_MAX), r.now, c.id]);
  return { checklist: await oneChecklist(gc, c.id) };
}

async function removeChecklist(gc, r, raw) {
  const c = await checklistRow(gc, raw);
  if (!mayDelete(r, c.created_by)) throw fail('forbidden');
  await store.run(gc, 'DELETE FROM checklist_items WHERE checklist_id = ?', [c.id]);
  await store.run(gc, 'DELETE FROM checklists WHERE id = ?', [c.id]);
  return {};
}

const touch = (gc, id, now) => store.run(gc, 'UPDATE checklists SET updated_at = ? WHERE id = ?', [now, id]);

async function addItem(gc, r, raw) {
  const c = await checklistRow(gc, raw);
  const [id] = await addItems(gc, c.id, [itemText((r.body || {}).text)], r.now);
  await touch(gc, c.id, r.now);
  return { item: itemView(await store.one(gc, 'SELECT * FROM checklist_items WHERE id = ?', [id])), checklist: await oneChecklist(gc, c.id) };
}

async function itemRow(gc, c, rawItem) {
  const id = posInt(rawItem);
  const i = id ? await store.one(gc, 'SELECT * FROM checklist_items WHERE id = ? AND checklist_id = ?', [id, c.id]) : null;
  if (!i) throw fail('not_found');
  return i;
}

async function updateItem(gc, r, raw, rawItem) {
  const c = await checklistRow(gc, raw);
  const i = await itemRow(gc, c, rawItem);
  const b = r.body || {};
  if (b.done === undefined && b.text === undefined) throw fail('invalid');
  const done = b.done !== undefined ? bool(b.done) : !!i.done;
  await store.run(gc, 'UPDATE checklist_items SET text = ?, done = ?, done_by = ? WHERE id = ?',
    [b.text !== undefined ? itemText(b.text) : i.text, done ? 1 : 0, done ? (b.done !== undefined ? r.me.userId : i.done_by) : null, i.id]);
  await touch(gc, c.id, r.now);
  return { item: itemView(await store.one(gc, 'SELECT * FROM checklist_items WHERE id = ?', [i.id])), checklist: await oneChecklist(gc, c.id) };
}

async function removeItem(gc, r, raw, rawItem) {
  const c = await checklistRow(gc, raw);
  const i = await itemRow(gc, c, rawItem);
  await store.run(gc, 'DELETE FROM checklist_items WHERE id = ?', [i.id]);
  await touch(gc, c.id, r.now);
  return { checklist: await oneChecklist(gc, c.id) };
}

async function reset(gc, r, raw) {
  const c = await checklistRow(gc, raw);
  await store.run(gc, 'UPDATE checklist_items SET done = 0, done_by = NULL WHERE checklist_id = ?', [c.id]);
  await touch(gc, c.id, r.now);
  return { checklist: await oneChecklist(gc, c.id) };
}

// ─── templates ──────────────────────────────────

async function templates(gc) {
  return (await store.all(gc, 'SELECT * FROM checklist_templates ORDER BY title, id')).map(templateView);
}

async function createTemplate(gc, r) {
  const b = r.body || {};
  if ((await store.one(gc, 'SELECT COUNT(*) AS n FROM checklist_templates')).n >= MAX_TEMPLATES) throw fail('too_many');
  let title;
  let texts;
  if (b.checklistId != null) {
    const c = await oneChecklist(gc, posInt(b.checklistId) || 0);
    title = b.title != null ? text(b.title, TITLE_MAX) : c.title;
    texts = c.items.map((i) => i.text);
  } else {
    title = text(b.title, TITLE_MAX);
    texts = itemTexts(b.items);
  }
  const res = await store.run(gc, 'INSERT INTO checklist_templates (title, items_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [title, JSON.stringify(texts), r.me.userId, r.now, r.now]);
  return { template: templateView(await store.one(gc, 'SELECT * FROM checklist_templates WHERE id = ?', [res.lastInsertRowid])) };
}

async function templateRow(gc, raw) {
  const id = posInt(raw);
  const t = id ? await store.one(gc, 'SELECT * FROM checklist_templates WHERE id = ?', [id]) : null;
  if (!t) throw fail('not_found');
  return t;
}

async function updateTemplate(gc, r, raw) {
  const t = await templateRow(gc, raw);
  const b = r.body || {};
  await store.run(gc, 'UPDATE checklist_templates SET title = ?, items_json = ?, updated_at = ? WHERE id = ?',
    [b.title !== undefined ? text(b.title, TITLE_MAX) : t.title, b.items !== undefined ? JSON.stringify(itemTexts(b.items)) : t.items_json, r.now, t.id]);
  return { template: templateView(await store.one(gc, 'SELECT * FROM checklist_templates WHERE id = ?', [t.id])) };
}

async function removeTemplate(gc, r, raw) {
  const t = await templateRow(gc, raw);
  if (!mayDelete(r, t.created_by)) throw fail('forbidden');
  await store.run(gc, 'DELETE FROM checklist_templates WHERE id = ?', [t.id]);
  return {};
}

/** GET board */
async function get(gc, r) {
  return { notes: await notes(gc, r), checklists: await checklists(gc), templates: await templates(gc) };
}

/** Overview: pinned notes, notes, checklists with something open. */
async function overview(gc, r) {
  const n = await notes(gc, r);
  const lists = await checklists(gc);
  return { pinned: n.filter((x) => x.pinned).length, notes: n.length, openChecklists: lists.filter((c) => c.open > 0).length };
}

/** Background: expired notes go. */
async function purge(gc, now) {
  await store.run(gc, 'DELETE FROM board_notes WHERE expires_at IS NOT NULL AND expires_at <= ?', [now]);
}

/** Router for board/… (segments after 'board'). */
function route(gc, r, rest, method) {
  const [a, b, c, d] = rest;
  const n = rest.length;
  const GET = method === 'GET';
  const POST = method === 'POST';
  const PATCH = method === 'PATCH' || method === 'PUT';
  const DELETE = method === 'DELETE';
  if (n === 0 && GET) return () => get(gc, r);
  if (a === 'notes') {
    if (n === 1 && GET) return async () => ({ notes: await notes(gc, r) });
    if (n === 1 && POST) return () => createNote(gc, r);
    if (n === 2 && PATCH) return () => updateNote(gc, r, b);
    if (n === 2 && DELETE) return () => removeNote(gc, r, b);
  }
  if (a === 'checklists') {
    if (n === 1 && GET) return async () => ({ checklists: await checklists(gc) });
    if (n === 1 && POST) return () => createChecklist(gc, r);
    if (n === 2 && GET) return async () => ({ checklist: await oneChecklist(gc, posInt(b) || 0) });
    if (n === 2 && PATCH) return () => updateChecklist(gc, r, b);
    if (n === 2 && DELETE) return () => removeChecklist(gc, r, b);
    if (n === 3 && c === 'reset' && POST) return () => reset(gc, r, b);
    if (n === 3 && c === 'items' && POST) return () => addItem(gc, r, b);
    if (n === 4 && c === 'items' && PATCH) return () => updateItem(gc, r, b, d);
    if (n === 4 && c === 'items' && DELETE) return () => removeItem(gc, r, b, d);
  }
  if (a === 'templates') {
    if (n === 1 && GET) return async () => ({ templates: await templates(gc) });
    if (n === 1 && POST) return () => createTemplate(gc, r);
    if (n === 2 && PATCH) return () => updateTemplate(gc, r, b);
    if (n === 2 && DELETE) return () => removeTemplate(gc, r, b);
  }
  return null;
}

module.exports = { COLORS, route, get, overview, purge, notes, checklists, templates };
