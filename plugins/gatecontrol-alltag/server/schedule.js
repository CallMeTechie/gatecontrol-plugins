'use strict';

// Waste dates from recurring rules the administrator enters ("Restmüll from
// 2026-01-07 every 2 weeks until …") and the single-date exceptions of a
// plan (a pickup that is cancelled or moved, e.g. around public holidays).
// Pure functions over plain dates ("YYYY-MM-DD"); the exceptions apply to
// every source (rules, ICS, provider).

const tz = require('./tz');
const fractions = require('./fractions');

const MAX_RULES = 30;
const MAX_EXCEPTIONS = 200;
const MAX_DATES = 3000;

/** A rule from the API → clean rule or null. */
function cleanRule(r) {
  if (!r || typeof r !== 'object') return null;
  const name = typeof r.name === 'string' ? r.name.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
  const start = tz.parseDate(r.start) ? r.start : null;
  const weeks = Number(r.weeks);
  if (!name || !start || !Number.isInteger(weeks) || weeks < 1 || weeks > 52) return null;
  const until = r.until == null || r.until === '' ? null : (tz.parseDate(r.until) ? r.until : undefined);
  if (until === undefined || (until && until < start)) return null;
  const type = fractions.TYPES.includes(r.type) ? r.type : null;
  return { name, type, start, weeks, until };
}

/** An exception from the API → clean exception or null. `to` null = cancelled. */
function cleanException(x) {
  if (!x || typeof x !== 'object') return null;
  if (!tz.parseDate(x.date)) return null;
  const to = x.to == null || x.to === '' ? null : (tz.parseDate(x.to) ? x.to : undefined);
  if (to === undefined || to === x.date) return null;
  const name = typeof x.name === 'string' && x.name.trim() ? x.name.replace(/\s+/g, ' ').trim().slice(0, 60) : null;
  return { date: x.date, name, to };
}

function cleanList(list, fn, max) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const x of list.slice(0, max)) { const c = fn(x); if (!c) return null; out.push(c); }
  return out;
}

/** Dates of the rules within [from, to] → [{ date, name, type }]. */
function fromRules(rules, from, to) {
  const out = [];
  for (const r of rules || []) {
    const step = r.weeks * 7;
    // first occurrence on or after `from`
    let k = Math.max(0, Math.ceil(tz.diffDays(r.start, from) / step));
    for (; out.length < MAX_DATES; k++) {
      const d = tz.addDays(r.start, k * step);
      if (d > to || (r.until && d > r.until)) break;
      if (d >= from) out.push({ date: d, name: r.name, type: r.type || null });
    }
  }
  return out;
}

/** Apply the exceptions to [{ date, name, … }] (moved entries keep their other fields). */
function applyExceptions(entries, exceptions) {
  if (!exceptions || !exceptions.length) return entries.slice();
  const out = [];
  const moved = [];
  for (const e of entries) {
    const x = exceptions.find((ex) => ex.date === e.date && (!ex.name || fractions.normalize(ex.name) === fractions.normalize(e.name)));
    if (!x) { out.push(e); continue; }
    if (x.to) moved.push({ ...e, date: x.to, moved: e.date });
  }
  for (const m of moved) if (!out.some((e) => e.date === m.date && fractions.normalize(e.name) === fractions.normalize(m.name))) out.push(m);
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

module.exports = { cleanRule, cleanException, cleanList, fromRules, applyExceptions, MAX_RULES, MAX_EXCEPTIONS, MAX_DATES };
