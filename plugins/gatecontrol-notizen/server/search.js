'use strict';

// GET search?q=&area= — tasks, notes (title, text, tags, recognised text of pictures) and the items of the other
// plugins the person sees. FTS5 with prefixes (fts.query), best first; Tresor notes are never found.

const store = require('./store');
const fts = require('./fts');
const tasks = require('./tasks');
const notes = require('./notes');
const sources = require('./sources');
const prefsMod = require('./prefs');
const { t } = require('./text');
const M = require('../ui/notemd');
const { fail, area: areaOf } = require('./util');

const LIMIT = 30;

/**
 * The rowids of an FTS table matching `match`, best first — ranked (bm25) when there are few matches; when there are
 * many (a common word), the newest 400 without ranking: bm25 over tens of thousands of rows costs ~100 ms.
 */
async function hits(gc, table, match) {
  const recent = await store.all(gc, `SELECT rowid AS id FROM ${table} WHERE ${table} MATCH ? ORDER BY rowid DESC LIMIT 401`, [match]);
  if (recent.length > 400) return recent.slice(0, 400).map((r) => r.id);
  if (recent.length <= 1) return recent.map((r) => r.id);
  return (await store.all(gc, `SELECT rowid AS id FROM ${table} WHERE ${table} MATCH ? ORDER BY rank LIMIT 400`, [match])).map((r) => r.id);
}

/** Rows of `ids` (in that order) the person sees. */
async function visibleRows(gc, sql, args, ids) {
  const pos = new Map(ids.map((id, i) => [id, i]));
  const out = [];
  for (const part of store.chunks(ids, 80)) {
    if (!part.length) continue;
    out.push(...await store.all(gc, sql.replace('%IDS%', store.marks(part.length)), [...args, ...part]));
  }
  return out.sort((a, b) => pos.get(a.id) - pos.get(b.id));
}

/** A piece of `text` around the first word found, the words marked with \u0002 … \u0003 (like FTS5's snippet()). */
function snippetOf(text, words) {
  const plain = String(text || '').replace(/\s+/g, ' ');
  const fold = (x) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const low = fold(plain);
  let at = -1;
  for (const w of words) { const i = low.indexOf(fold(w)); if (i >= 0 && (at < 0 || i < at)) at = i; }
  if (at < 0) return null;
  const start = Math.max(0, at - 60);
  let piece = plain.slice(start, start + 200);
  const lowPiece = fold(piece);
  let out = '';
  let i = 0;
  while (i < piece.length) {
    let hit = null;
    for (const w of words) { const f = fold(w); if (f && lowPiece.startsWith(f, i) && (i === 0 || !/[\p{L}\p{N}]/u.test(lowPiece[i - 1]))) { hit = f.length; break; } }
    if (hit) { out += '\u0002' + piece.slice(i, i + hit) + '\u0003'; i += hit; } else { out += piece[i]; i++; }
  }
  return (start > 0 ? '…' : '') + out + (start + 200 < plain.length ? '…' : '');
}

async function run(gc, ctx, q) {
  const s = String(q.q || '').trim();
  if (s.length < 2 || s.length > 200) throw fail('invalid', { field: 'q' });
  const area = areaOf(q.area);
  const match = fts.query(s);
  const words = (s.normalize('NFC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).slice(0, 8);
  let taskRows = [];
  let noteRows = [];
  if (match) {
    const tids = await hits(gc, 'tasks_fts', match);
    taskRows = await visibleRows(gc, `SELECT t.* FROM tasks t JOIN list_members m ON m.list_id = t.list_id AND m.user_id = ?
      JOIN lists l ON l.id = t.list_id AND l.deleted_at IS NULL AND l.area = ? WHERE t.id IN (%IDS%) AND t.deleted_at IS NULL`, [ctx.userId, area], tids);
    taskRows = taskRows.sort((a, b) => (a.done_at ? 1 : 0) - (b.done_at ? 1 : 0)).slice(0, LIMIT);
    const nids = await hits(gc, 'notes_fts', match);
    noteRows = (await visibleRows(gc, `SELECT n.* FROM notes n JOIN notebook_members m ON m.notebook_id = n.notebook_id AND m.user_id = ?
      JOIN notebooks b ON b.id = n.notebook_id AND b.deleted_at IS NULL AND b.area = ? WHERE n.id IN (%IDS%) AND n.deleted_at IS NULL`, [ctx.userId, area], nids)).slice(0, LIMIT);
  }
  const prefs = await prefsMod.get(gc, ctx.userId);
  const lab = (p) => t(ctx.lang, 'src.' + p);
  const items = (await sources.visible(gc, ctx, prefs, { area, withCarried: true }))
    .filter((x) => { const h = (x.row.title + ' ' + (x.row.subtitle || '')).toLowerCase(); return words.every((w) => h.includes(w)); })
    .slice(0, LIMIT).map((x) => sources.view(ctx, x, prefs, lab));
  return {
    tasks: await tasks.views(gc, ctx, taskRows),
    notes: noteRows.map((r) => ({ ...notes.summary(r), hit: snippetOf(r.title + ' · ' + M.plain(r.body), words) })),
    items,
  };
}

module.exports = { run };
