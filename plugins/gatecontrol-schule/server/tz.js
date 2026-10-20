'use strict';

// Time zones without dependencies (the part of gatecontrol-alltag's tz.js this
// plugin needs): Intl does the zone rules, this file converts between a
// wall-clock time in a zone and an instant (ms since the epoch), plus plain
// dates "YYYY-MM-DD". A wall-clock time in the spring gap is moved forward,
// an ambiguous one in the autumn is the first occurrence.

const DAY_MS = 86400000;
const fmtCache = new Map();

function formatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short',
    });
    if (fmtCache.size > 50) fmtCache.clear();
    fmtCache.set(tz, f);
  }
  return f;
}

const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall clock of `ms` in `tz` → { y, m (1–12), d, hh, mm, ss, wd (0 = Sunday) }. */
function parts(ms, tz) {
  const o = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: Number(o.year), m: Number(o.month), d: Number(o.day), hh: Number(o.hour) % 24, mm: Number(o.minute), ss: Number(o.second), wd: WD[o.weekday] };
}

function offset(ms, tz) {
  const p = parts(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - Math.floor(ms / 1000) * 1000;
}

/** Wall clock in `tz` → ms (gap: shifted forward; overlap: first occurrence). */
function toUtc({ y, m, d, hh = 0, mm = 0, ss = 0 }, tz) {
  const local = Date.UTC(y, m - 1, d, hh, mm, ss);
  if (!tz || tz === 'UTC') return local;
  const before = offset(local - DAY_MS, tz);
  const after = offset(local + DAY_MS, tz);
  const tB = local - before;
  const tA = local - after;
  const okB = offset(tB, tz) === before;
  const okA = offset(tA, tz) === after;
  if (okB && okA) return Math.min(tB, tA);
  if (okB) return tB;
  if (okA) return tA;
  return tB;
}

/** Is `tz` a time zone Intl knows? */
function valid(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try { formatter(tz); return true; } catch { return false; }
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
function dateStr(y, m, d) { return `${pad(y, 4)}-${pad(m)}-${pad(d)}`; }

/** "YYYY-MM-DD" → { y, m, d } (null when invalid). */
function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return { y, m: mo, d };
}

function addDays(s, n) {
  const p = parseDate(s);
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
  return dateStr(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

function diffDays(a, b) {
  const pa = parseDate(a); const pb = parseDate(b);
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / DAY_MS);
}

/** Weekday of "YYYY-MM-DD" (0 = Sunday). */
function weekday(s) {
  const p = parseDate(s);
  return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
}

/** Monday of the week of "YYYY-MM-DD". */
function weekStart(s) {
  return addDays(s, -((weekday(s) + 6) % 7));
}

function localDate(ms, tz) {
  const p = parts(ms, tz);
  return dateStr(p.y, p.m, p.d);
}

/** "HH:MM" → { hh, mm } (null when invalid). */
function parseTime(s) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(s == null ? '' : s).trim());
  return m ? { hh: Number(m[1]), mm: Number(m[2]) } : null;
}

/** ms of "YYYY-MM-DD" at "HH:MM" (or { hh, mm }) in `tz`. */
function at(date, time, tz) {
  const p = parseDate(date);
  const t = typeof time === 'string' ? parseTime(time) : time;
  return toUtc({ ...p, hh: t ? t.hh : 0, mm: t ? t.mm : 0, ss: 0 }, tz);
}

module.exports = { DAY_MS, parts, toUtc, valid, pad, dateStr, parseDate, addDays, diffDays, weekday, weekStart, localDate, parseTime, at };
