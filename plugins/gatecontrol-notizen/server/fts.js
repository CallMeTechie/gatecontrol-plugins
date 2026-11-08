'use strict';

// Full-text search (SQLite FTS5, tokenizer unicode61 without diacritics: „Zahnärztin“ finds „zahnarzt*“). The hub keeps
// its own copies of the texts in tasks_fts / notes_fts (rowid = the task's / note's id), written with every change.
// Tresor notes are never indexed.

const store = require('./store');

async function setTask(gc, id, title, note) {
  await store.run(gc, 'DELETE FROM tasks_fts WHERE rowid = ?', [id]);
  await store.run(gc, 'INSERT INTO tasks_fts (rowid, title, note) VALUES (?, ?, ?)', [id, title || '', (note || '').slice(0, 20000)]);
}
const dropTask = (gc, id) => store.run(gc, 'DELETE FROM tasks_fts WHERE rowid = ?', [id]);

async function setNote(gc, id, title, body, tags, ocr) {
  await store.run(gc, 'DELETE FROM notes_fts WHERE rowid = ?', [id]);
  await store.run(gc, 'INSERT INTO notes_fts (rowid, title, body, tags, ocr) VALUES (?, ?, ?, ?, ?)',
    [id, title || '', (body || '').slice(0, 200000), (tags || []).join(' '), (ocr || '').slice(0, 200000)]);
}
const dropNote = (gc, id) => store.run(gc, 'DELETE FROM notes_fts WHERE rowid = ?', [id]);

/** What a person typed → an FTS5 query: every word as a prefix, all words needed („zahn arzt“ → "zahn"* "arzt"*). */
function query(q) {
  const words = String(q || '').normalize('NFC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const uniq = [...new Set(words)].filter((w) => w.length >= 1).slice(0, 8);
  if (!uniq.length) return null;
  return uniq.map((w) => `"${w}"*`).join(' ');
}

module.exports = { setTask, dropTask, setNote, dropNote, query };
