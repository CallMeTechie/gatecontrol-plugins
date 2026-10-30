'use strict';

// Photos found by what is on them (since 1.14.0, feature `photoSearch`) — stage 1: the phones recognise image labels on
// the device (ML Kit image labeling, English) when they back up a photo, and fill them in later for photos backed up
// before (from the previews); Drive keeps them (node_labels) and finds photos by them. Nothing goes to an AI here.
//
//   PUT nodes/<id>/labels   { labels: [string ≤ 40] (≤ 20), source: 'device' } → { id, labels, labeledAt }
//                           a picture or video one writes to (403 forbidden else — a phone skips those), replacing its
//                           labels (lower case, each once); [] marks it as looked at with nothing found
//   GET photos?q=<words>    (photos.js) only the photos with a label for every word — German words through
//                           server/labels.json (ML Kit's ~400 labels → German words and synonyms, prefixes too:
//                           „Hund“, „Hunde“ → dog), else the word as a label. The answer adds `search`
//                           { terms: [word], labels: [label], total, chips: [{ label, text, count }] } — chips: the
//                           most frequent other labels of the hits (≤ 6), `text` in the viewer's language
//   GET photos?unlabeled=1  only the photos without labels in areas one writes to (the phones' backfill)
// Photo items carry `labeled` (the phone looked at it). Labels go with the file (nodes.forget).

const store = require('./store');
const nodes = require('./nodes');
const MAP = require('./labels.json').de;
const { fail, posInt, iso } = require('./util');

const LABELS_MAX = 20;
const LABEL_MAX = 40;
const WORDS_MAX = 5;
const CHIPS_MAX = 6;
const SOURCES = ['device'];

const fold = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').trim();

// folded label → label, folded German word → [label]
const INDEX = (() => {
  const words = [];
  for (const [label, de] of Object.entries(MAP)) {
    words.push({ word: fold(label), label });
    for (const w of de) words.push({ word: fold(w), label });
  }
  return words;
})();

/** The labels a search word means → [label] (lower case English, as the phones send them). */
function labelsFor(word) {
  const w = fold(word);
  if (w.length < 2) return [];
  const out = new Set();
  for (const x of INDEX) {
    // the word itself, the start of a word („Sonnen…“), a plural or another ending („Hunde“ → „hund“)
    if (x.word === w || (w.length >= 3 && x.word.startsWith(w)) || (x.word.length >= 4 && w.startsWith(x.word) && w.length - x.word.length <= 2)) out.add(x.label);
  }
  return [...out];
}

/** A label as a person reads it: the German word, else the label with a capital letter. */
function textOf(label, lang) {
  const de = MAP[label];
  if (lang !== 'en' && de && de.length) return de[0];
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** The words of `q` → [word] (≤ WORDS_MAX), or invalid { field: 'q' }. */
function wordsOf(q) {
  const s = typeof q === 'string' ? q.replace(/[\0-\x1f\x7f]/g, ' ').trim() : '';
  if (s.length < 2 || s.length > 100) throw fail('invalid', { field: 'q' });
  const words = [...new Set(s.split(/[\s,;+]+/).map((w) => w.trim()).filter((w) => w.length >= 2))].slice(0, WORDS_MAX);
  if (!words.length) throw fail('invalid', { field: 'q' });
  return words;
}

/**
 * GET photos?q=: scope `sc` ({ where, args } over nodes) narrowed to photos with a label for every word → { sc, terms,
 * labels } (labels: every label a word meant).
 */
function narrow(sc, q) {
  const words = wordsOf(q);
  let where = sc.where;
  const args = [...sc.args];
  const all = new Set();
  for (const w of words) {
    const ls = labelsFor(w);
    ls.forEach((l) => all.add(l));
    const like = fold(w).replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    where += ` AND id IN (SELECT node_id FROM node_labels WHERE ${ls.length ? `label IN (${store.marks(ls.length)}) OR ` : ''}label LIKE ? ESCAPE '\\')`;
    args.push(...ls, like);
  }
  return { sc: { where, args }, terms: words, labels: [...all] };
}

/** The search's summary for scope `sc` (already narrowed): how many, and the most frequent other labels as chips. */
async function summary(ctx, sc, labels) {
  const total = (await store.one(ctx.gc, `SELECT COUNT(*) AS n FROM nodes WHERE ${sc.where}`, sc.args)).n;
  const rows = await store.all(ctx.gc, `SELECT label, COUNT(*) AS n FROM node_labels WHERE node_id IN (SELECT id FROM nodes WHERE ${sc.where})
    GROUP BY label ORDER BY n DESC, label LIMIT 40`, sc.args);
  const skip = new Set(labels);
  const chips = rows.filter((r) => !skip.has(r.label) && r.n < total).slice(0, CHIPS_MAX).map((r) => ({ label: r.label, text: textOf(r.label, ctx.lang), count: r.n }));
  return { total, chips };
}

/** labels of a body → [label] or invalid { field: 'labels' }. */
function labelsArg(v) {
  if (!Array.isArray(v) || v.length > LABELS_MAX) throw fail('invalid', { field: 'labels' });
  const out = [];
  for (const x of v) {
    if (typeof x !== 'string') throw fail('invalid', { field: 'labels' });
    const s = x.replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!s || s.length > LABEL_MAX) throw fail('invalid', { field: 'labels' });
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

const isMedia = (n) => n.is_dir === 0 && /^(image|video)\//.test(String(n.mime || ''));

/** PUT nodes/<id>/labels { labels, source } → { id, labels, labeledAt } */
async function put(ctx, id, body) {
  const b = body && typeof body === 'object' ? body : {};
  const labels = labelsArg(b.labels);
  const source = b.source == null ? 'device' : String(b.source);
  if (!SOURCES.includes(source)) throw fail('invalid', { field: 'source' });
  const n = posInt(id);
  if (!n) throw fail('not_found');
  return store.tx(ctx.gc, async () => {
    const { node } = await nodes.reach(ctx, n, 'write');
    // a vault's file: the server sees only ciphertext — and keeps nothing about its content
    if (node.vault_id) throw fail('encrypted');
    if (!isMedia(node)) throw fail('invalid', { field: 'id' });
    await store.run(ctx.gc, 'DELETE FROM node_labels WHERE node_id = ?', [node.id]);
    for (const l of labels) await store.run(ctx.gc, 'INSERT INTO node_labels (node_id, label, source, at) VALUES (?, ?, ?, ?)', [node.id, l, source, ctx.now]);
    await store.run(ctx.gc, 'UPDATE nodes SET labels_at = ? WHERE id = ?', [ctx.now, node.id]);
    return { id: node.id, labels, labeledAt: iso(ctx.now) };
  });
}

module.exports = { put, narrow, summary, labelsFor, textOf, wordsOf, fold };
