'use strict';

// Questions to the documents (since 1.14.0, feature `docAsk`): a person asks in words („Bis wann kann ich die
// Kfz-Versicherung kündigen?“) and gets an answer from their own files only, with the sources and a quote.
//
//   POST ask { q (3…300 characters), area? } → { status: 'answered' | 'not_found', answer, sources: [{ nodeId, name, path,
//            areaId, page, quote }], terms, areas: [label], deadline }
//
// 1. GateControl's AI turns the question into search terms and filters (kind of document, sender, year) — the question
//    alone goes, nothing of the files.
// 2. Drive searches without AI: the recognised text (doc_text) and what AI for documents read (title, sender, kind) of the
//    files the person reads — the areas with AI for documents on (insights.js; a child's folder is off by default),
//    never a vault, never the trash; `area` narrows it to one area.
// 3. The best ≤ 8 files go as excerpts (≤ 2 000 characters around the hits) to the AI, which answers only from them with
//    the source and a quote — or says it found nothing (status not_found, answer null, sources []).
// `terms`: what was searched for, `areas`: the labels of the areas searched („Gesucht nach: … · in Meine Dateien und
// Familie“). `page`: null (the recognised text has no pages). `deadline`: a deadline of a source whose date the answer
// names (the button „Frist in den Familienkalender“, deadlines.js) — else null.
// At most 30 questions an hour per person (429 rate_limited); 403 feature_off while AI for documents is off.

const store = require('./store');
const nodes = require('./nodes');
const insights = require('./insights');
const deadlines = require('./deadlines');
const ai = require('./ai');
const { fail, day } = require('./util');

const PER_HOUR = 30;
const HOUR = 3600000;
const Q_MIN = 3;
const Q_MAX = 300;
const TERMS_MAX = 8;
const CANDIDATES = 300;
const SOURCES_MAX = 8;
const EXCERPT = 2000;
const QUOTE_MAX = 300;
// per provider call (twice that at most each): both calls stay below the apps' 60 s
const TIMEOUT_MS = 14000;

const TERMS_INSTRUCTIONS = [
  'A person asks a question about the documents in their own file storage (letters, invoices, contracts, insurance',
  'policies, notices, certificates). Give the search terms that find the documents with the answer: nouns and names',
  'from the question, in the language of the question, also their usual synonyms and word forms (e.g. "Kfz" and',
  '"Auto", "Versicherung"), at most 8, no stop words, no dates. kind: the kind of document when the question names one',
  '(invoice, contract, notice, medical, certificate, statement, insurance, warranty, other), else null. sender: a company',
  'or office the question names, else null. year: a year the question names, else null.',
].join('\n');

const TERMS_SCHEMA = {
  type: 'object',
  required: ['terms', 'kind', 'sender', 'year'],
  properties: {
    terms: { type: 'array', maxItems: TERMS_MAX, items: { type: 'string', maxLength: 40 } },
    kind: { type: 'string', enum: insights.KINDS, nullable: true },
    sender: { type: 'string', maxLength: 80, nullable: true },
    year: { type: 'integer', minimum: 1900, maximum: 2200, nullable: true },
  },
};

const ANSWER_INSTRUCTIONS = [
  'Answer the question only from the numbered excerpts of the person\'s documents. Never use other knowledge, never',
  'guess. Answer briefly (one to three sentences) in the language of the question; write dates as in the excerpts.',
  'sources: for each excerpt the answer rests on, its number and a short quote copied word for word from it (≤ 200',
  'characters). found: false and answer null when the excerpts do not answer the question.',
].join('\n');

const ANSWER_SCHEMA = {
  type: 'object',
  required: ['found', 'answer', 'sources'],
  properties: {
    found: { type: 'boolean' },
    answer: { type: 'string', maxLength: 1200, nullable: true },
    sources: {
      type: 'array', maxItems: 4,
      items: { type: 'object', required: ['doc', 'quote'], properties: { doc: { type: 'integer', minimum: 1, maximum: SOURCES_MAX }, quote: { type: 'string', maxLength: QUOTE_MAX } } },
    },
  },
};

const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const lower = (s) => flat(s).toLowerCase();

/** Words of the question as terms when the AI gave none (≥ 4 letters). */
function fallbackTerms(q) {
  return [...new Set(q.split(/[^\p{L}\p{N}-]+/u).filter((w) => w.length >= 4))].slice(0, TERMS_MAX);
}

/** At most PER_HOUR questions an hour: counted here (old rows go). */
async function count(ctx) {
  await store.run(ctx.gc, 'DELETE FROM ai_asks WHERE at < ?', [ctx.now - 24 * HOUR]);
  const r = await store.one(ctx.gc, 'SELECT COUNT(*) AS n FROM ai_asks WHERE user_id = ? AND at > ?', [ctx.viewer, ctx.now - HOUR]);
  if (r && r.n >= PER_HOUR) throw fail('rate_limited', { reason: 'questions', perHour: PER_HOUR });
  await store.run(ctx.gc, 'INSERT INTO ai_asks (user_id, at) VALUES (?, ?)', [ctx.viewer, ctx.now]);
}

/** The areas to search: those the viewer reads with AI for documents on (one of them with `area`). */
async function areasOf(ctx, area) {
  const vis = await ctx.visible();
  let list = vis;
  if (area != null && area !== '') {
    list = vis.filter((v) => v.area.id === String(area));
    if (!list.length) throw fail('not_found', { field: 'area' });
  }
  const on = await insights.prefsOf(ctx.gc, list.map((v) => v.area));
  return list.filter((v) => on.get(v.area.id) === true);
}

/**
 * The best window of `size` characters of `text` (lower case) from `from` on: the hits of rare terms count more, and
 * more still those of terms not yet in `seen` (the head) → its start, or -1 without a hit.
 */
function bestWindow(text, terms, from, size, seen) {
  const hits = [];
  const weight = new Map();
  for (const t of terms) {
    let n = 0;
    for (let i = text.indexOf(t); i >= 0; i = text.indexOf(t, i + t.length)) {
      n++;
      if (i >= from && hits.length < 600) hits.push({ at: i, t });
    }
    weight.set(t, (n ? 1 / n : 0) * (seen.includes(t) ? 1 : 3));
  }
  if (!hits.length) return -1;
  let best = { start: -1, score: -1 };
  for (const h of hits) {
    const start = Math.max(from, h.at - 200);
    const inside = new Set(hits.filter((x) => x.at >= start && x.at + x.t.length <= start + size).map((x) => x.t));
    const score = [...inside].reduce((sum, t) => sum + weight.get(t), 0);
    if (score > best.score) best = { start, score };
  }
  return best.start;
}

const HEAD = 400;

/**
 * A file's excerpt for the AI (≤ EXCERPT characters of its text): what AI for documents read, the start of the text
 * (who, what) and the part with the most and rarest hits.
 */
function excerptOf(r, terms) {
  const facts = [r.title && `Titel: ${r.title}`, r.sender && `Absender: ${r.sender}`, r.doc_date && `Datum: ${r.doc_date}`].filter(Boolean).join(' · ');
  const text = String(r.text || '');
  if (!text) return { text: facts || r.name };
  const pre = facts ? facts + '\n' : '';
  if (text.length <= EXCERPT) return { text: pre + text };
  const low = text.toLowerCase();
  const head = text.slice(0, HEAD);
  const seen = terms.filter((t) => head.toLowerCase().includes(t));
  const start = bestWindow(low, terms, HEAD, EXCERPT - HEAD, seen);
  if (start < 0) return { text: pre + text.slice(0, EXCERPT) + '…' };
  // from the start of a word
  let from = start;
  while (from > HEAD && from > start - 30 && !/\s/.test(text[from - 1])) from--;
  const part = text.slice(from, from + EXCERPT - HEAD);
  return { text: pre + head + (from > HEAD ? ' … ' : '') + part + (from + EXCERPT - HEAD < text.length ? '…' : '') };
}

/** Score of candidate row `r` for terms and filters (0: not a hit). */
function scoreOf(r, terms, f) {
  const text = lower(r.text);
  const head = lower([r.name, r.title, r.sender].filter(Boolean).join(' '));
  let found = 0;
  let s = 0;
  for (const t of terms) {
    let n = 0;
    for (let i = text.indexOf(t); i >= 0 && n < 5; i = text.indexOf(t, i + t.length)) n++;
    const inHead = head.includes(t);
    if (n || inHead) found++;
    s += (n ? 1 + 0.2 * n : 0) + (inHead ? 1.5 : 0);
  }
  if (!found) return 0;
  if (f.kind && r.kind === f.kind) s += 1.5;
  if (f.sender && lower(r.sender).includes(lower(f.sender))) s += 2;
  if (f.year && ((r.doc_date && r.doc_date.startsWith(String(f.year))) || lower(r.text).includes(String(f.year)))) s += 1;
  return s;
}

/** A quote of the AI that is really in the excerpt (spaces and case aside), else null. */
function realQuote(quote, excerpt) {
  const q = flat(quote).replace(/^[„“"']+|[“”"']+$/g, '').trim();
  if (q.length < 3) return null;
  return lower(excerpt).includes(q.toLowerCase()) ? q.slice(0, QUOTE_MAX) : null;
}

/** "2026-11-30" → the forms an answer may write it in. */
function dateForms(date) {
  const [y, m, d] = date.split('-');
  return [date, `${d}.${m}.${y}`, `${Number(d)}.${Number(m)}.${y}`, `${d}.${m}.${y.slice(2)}`];
}

/** POST ask { q, area? } */
async function ask(ctx, body) {
  await ai.need(ctx);
  const b = body && typeof body === 'object' ? body : {};
  const q = typeof b.q === 'string' ? flat(b.q.replace(/[\0-\x1f\x7f]/g, ' ')) : '';
  if (q.length < Q_MIN || q.length > Q_MAX) throw fail('invalid', { field: 'q' });
  const list = await areasOf(ctx, b.area);
  const areaLabels = list.map((v) => ctx.areaLabel(v.area));
  if (!list.length) return { status: 'not_found', answer: null, sources: [], terms: [], areas: [], deadline: null };
  await count(ctx);

  // 1. terms and filters
  const t = await ai.extract(ctx, {
    task: 'drive_ask_terms', instructions: TERMS_INSTRUCTIONS, schema: TERMS_SCHEMA, maxOutputTokens: 300, timeoutMs: TIMEOUT_MS,
    input: [{ type: 'text', label: 'Question', text: q }, { type: 'text', label: 'Today', text: day(ctx.now) }],
  });
  const d = t.data;
  let terms = [...new Set((Array.isArray(d.terms) ? d.terms : []).map((x) => lower(x)).filter((x) => x.length >= 2 && x.length <= 40))].slice(0, TERMS_MAX);
  if (!terms.length) terms = fallbackTerms(q).map(lower);
  const f = { kind: insights.KINDS.includes(d.kind) ? d.kind : null, sender: typeof d.sender === 'string' && d.sender.trim() ? d.sender.trim() : null, year: Number.isInteger(d.year) ? d.year : null };
  if (!terms.length) return { status: 'not_found', answer: null, sources: [], terms: [], areas: areaLabels, deadline: null };

  // 2. the search, without AI
  const ids = list.map((v) => v.area.id);
  const likes = terms.map((x) => '%' + x.replace(/[\\%_]/g, (c) => '\\' + c) + '%');
  const cond = likes.map(() => "(t.text LIKE ? ESCAPE '\\' OR n.name LIKE ? ESCAPE '\\' OR i.title LIKE ? ESCAPE '\\' OR i.sender LIKE ? ESCAPE '\\')").join(' OR ');
  // (the areas in parts: the host takes at most 100 parameters a statement)
  const rows = [];
  for (const part of store.chunks(ids, 50)) {
    rows.push(...await store.all(ctx.gc, `SELECT n.id, n.name, n.area_id, n.parent_id, n.rev, n.updated_at, t.text, i.kind, i.title, i.sender, i.doc_date FROM nodes n
      LEFT JOIN doc_text t ON t.node_id = n.id
      LEFT JOIN doc_insights i ON i.node_id = n.id AND i.status = 'ready' AND i.rev = n.rev
      WHERE n.area_id IN (${store.marks(part.length)}) AND n.is_dir = 0 AND n.deleted_at IS NULL AND n.vault_id IS NULL
        AND (t.node_id IS NOT NULL OR i.node_id IS NOT NULL) AND (${cond})
      ORDER BY n.updated_at DESC LIMIT ?`, [...part, ...likes.flatMap((l) => [l, l, l, l]), CANDIDATES]));
  }
  const best = rows.map((r) => ({ r, s: scoreOf(r, terms, f) })).filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || b.r.updated_at - a.r.updated_at).slice(0, SOURCES_MAX).map((x) => x.r);
  if (!best.length) return { status: 'not_found', answer: null, sources: [], terms, areas: areaLabels, deadline: null };

  // 3. the answer from the excerpts
  const excerpts = best.map((r) => excerptOf(r, terms));
  const a = await ai.extract(ctx, {
    task: 'drive_ask_answer', instructions: ANSWER_INSTRUCTIONS, schema: ANSWER_SCHEMA, maxOutputTokens: 700, timeoutMs: TIMEOUT_MS,
    input: [
      { type: 'text', label: 'Question', text: q },
      { type: 'text', label: 'Today', text: day(ctx.now) },
      ...excerpts.map((e, i) => ({ type: 'text', label: `Excerpt ${i + 1}: ${best[i].name}`.slice(0, 100), text: e.text })),
    ],
  });
  const ad = a.data;
  const answer = typeof ad.answer === 'string' ? ad.answer.trim() : '';
  const sources = [];
  for (const s of Array.isArray(ad.sources) ? ad.sources : []) {
    const i = Number.isInteger(s && s.doc) ? s.doc - 1 : -1;
    const r = best[i];
    if (!r || sources.some((x) => x.nodeId === r.id)) continue;
    const quote = realQuote(s.quote, excerpts[i].text);
    if (!quote) continue;
    const n = await nodes.row(ctx.gc, r.id);
    sources.push({ nodeId: r.id, name: r.name, path: await nodes.pathOf(ctx.gc, n), areaId: r.area_id, page: null, quote });
  }
  if (ad.found !== true || !answer || !sources.length) return { status: 'not_found', answer: null, sources: [], terms, areas: areaLabels, deadline: null };

  // a deadline of a source the answer names (from today on)
  let deadline = null;
  for (const s of sources) {
    const dls = await store.all(ctx.gc, 'SELECT * FROM doc_deadlines WHERE node_id = ? AND date >= ? ORDER BY date, id', [s.nodeId, day(ctx.now)]);
    const hit = dls.find((x) => dateForms(x.date).some((form) => answer.includes(form)));
    if (hit) { deadline = { ...(await deadlines.viewOne(ctx, hit)), nodeId: s.nodeId }; break; }
  }
  return { status: 'answered', answer, sources, terms, areas: areaLabels, deadline };
}

module.exports = { ask, PER_HOUR, realQuote, bestWindow };
