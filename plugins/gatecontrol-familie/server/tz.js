'use strict';

// Time zones without dependencies: Intl does the zone rules (the plugin
// process has a full ICU — Node's default build), this file only converts
// between a wall-clock time in a zone and an instant (ms since the epoch).
//
//   toUtc({ y, m, d, hh, mm, ss }, 'Europe/Berlin')  wall clock → ms
//   parts(ms, 'Europe/Berlin')                       ms → { y, m, d, hh, mm, ss, wd }
//
// DST rules as RFC 5545 asks for them: a wall-clock time inside the spring
// gap (02:30 on the last Sunday of March in Berlin) is moved forward by the
// gap (→ 03:30 CEST); an ambiguous one in the autumn (02:30 twice) is the
// first occurrence (CEST).
//
// Calendar files also name zones the Windows way ("W. Europe Standard Time",
// Outlook/Exchange) or with a vendor prefix ("/mozilla.org/…/Europe/Berlin");
// resolveTz() maps those to IANA names.

const DAY_MS = 86400000;
const fmtCache = new Map();

function formatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short',
    });
    if (fmtCache.size > 200) fmtCache.clear();
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

/** Offset of `tz` at `ms` in ms (UTC+2 → +7200000). */
function offset(ms, tz) {
  const p = parts(ms, tz);
  const wall = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
  return wall - Math.floor(ms / 1000) * 1000;
}

/** Wall clock in `tz` → ms (gap: shifted forward; overlap: first occurrence). */
function toUtc({ y, m, d, hh = 0, mm = 0, ss = 0 }, tz) {
  const local = Date.UTC(y, m - 1, d, hh, mm, ss);
  if (!tz || tz === 'UTC') return local;
  // within ±1 day there is at most one transition: the offsets before and after it
  const before = offset(local - DAY_MS, tz);
  const after = offset(local + DAY_MS, tz);
  const tB = local - before;
  const tA = local - after;
  const okB = offset(tB, tz) === before;
  const okA = offset(tA, tz) === after;
  if (okB && okA) return Math.min(tB, tA);
  if (okB) return tB;
  if (okA) return tA;
  return tB; // in the gap: the offset before it moves the time forward
}

/** Is `tz` a time zone Intl knows? */
function valid(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try { formatter(tz); return true; } catch { return false; }
}

// Windows (CLDR windowsZones, "001" territory) → IANA, the zones Outlook,
// Exchange and Office 365 write into TZID for German-speaking users and the
// other common ones.
const WINDOWS = {
  'w. europe standard time': 'Europe/Berlin',
  'central europe standard time': 'Europe/Budapest',
  'central european standard time': 'Europe/Warsaw',
  'romance standard time': 'Europe/Paris',
  'gmt standard time': 'Europe/London',
  'greenwich standard time': 'Atlantic/Reykjavik',
  'utc': 'UTC',
  'coordinated universal time': 'UTC',
  'e. europe standard time': 'Europe/Chisinau',
  'fle standard time': 'Europe/Kiev',
  'gtb standard time': 'Europe/Bucharest',
  'russian standard time': 'Europe/Moscow',
  'kaliningrad standard time': 'Europe/Kaliningrad',
  'belarus standard time': 'Europe/Minsk',
  'turkey standard time': 'Europe/Istanbul',
  'israel standard time': 'Asia/Jerusalem',
  'egypt standard time': 'Africa/Cairo',
  'south africa standard time': 'Africa/Johannesburg',
  'morocco standard time': 'Africa/Casablanca',
  'w. central africa standard time': 'Africa/Lagos',
  'arabian standard time': 'Asia/Dubai',
  'arab standard time': 'Asia/Riyadh',
  'india standard time': 'Asia/Kolkata',
  'china standard time': 'Asia/Shanghai',
  'singapore standard time': 'Asia/Singapore',
  'tokyo standard time': 'Asia/Tokyo',
  'korea standard time': 'Asia/Seoul',
  'aus eastern standard time': 'Australia/Sydney',
  'w. australia standard time': 'Australia/Perth',
  'new zealand standard time': 'Pacific/Auckland',
  'eastern standard time': 'America/New_York',
  'central standard time': 'America/Chicago',
  'mountain standard time': 'America/Denver',
  'us mountain standard time': 'America/Phoenix',
  'pacific standard time': 'America/Los_Angeles',
  'alaskan standard time': 'America/Anchorage',
  'hawaiian standard time': 'Pacific/Honolulu',
  'atlantic standard time': 'America/Halifax',
  'canada central standard time': 'America/Regina',
  'e. south america standard time': 'America/Sao_Paulo',
  'sa pacific standard time': 'America/Bogota',
  'argentina standard time': 'America/Buenos_Aires',
};
// Outlook's display names ("(UTC+01:00) Amsterdam, Berlin, Bern, Rom, Stockholm, Wien")
const DISPLAY = [
  [/amsterdam|berlin|bern|stockholm|vienna|wien/, 'Europe/Berlin'],
  [/brussels|br[üu]ssel|copenhagen|kopenhagen|madrid|paris/, 'Europe/Paris'],
  [/belgrade|belgrad|bratislava|budapest|ljubljana|prague|prag/, 'Europe/Budapest'],
  [/sarajevo|skopje|warsaw|warschau|zagreb/, 'Europe/Warsaw'],
  [/dublin|edinburgh|lisbon|lissabon|london/, 'Europe/London'],
  [/athens|athen|bucharest|bukarest/, 'Europe/Bucharest'],
  [/helsinki|kyiv|kiew|riga|sofia|tallinn|vilnius/, 'Europe/Kiev'],
  [/moscow|moskau/, 'Europe/Moscow'],
  [/eastern time/, 'America/New_York'],
  [/central time/, 'America/Chicago'],
  [/mountain time/, 'America/Denver'],
  [/pacific time/, 'America/Los_Angeles'],
];

/**
 * A TZID of a calendar file → IANA zone, or null when unknown.
 * Accepts IANA names, vendor prefixes (/mozilla.org/20050126_1/Europe/Berlin),
 * Windows names and Outlook display names.
 */
function resolveTz(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().replace(/^"+|"+$/g, '');
  if (!s || s.length > 200) return null;
  if (/^(utc|gmt|z|etc\/utc|etc\/gmt)$/i.test(s)) return 'UTC';
  if (/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){1,2}$/.test(s) && valid(s)) return s;
  const tail = /([A-Za-z_]+\/[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)?)$/.exec(s);
  if (tail && valid(tail[1])) return tail[1];
  const lower = s.toLowerCase();
  if (WINDOWS[lower]) return WINDOWS[lower];
  for (const [re, tz] of DISPLAY) if (re.test(lower)) return tz;
  return null;
}

// ─── Plain dates ("YYYY-MM-DD", no zone) ───────────

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

/** "YYYY-MM-DD" + n days. */
function addDays(s, n) {
  const p = parseDate(s);
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
  return dateStr(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Days from a to b (both "YYYY-MM-DD"). */
function diffDays(a, b) {
  const pa = parseDate(a); const pb = parseDate(b);
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / DAY_MS);
}

/** Weekday of "YYYY-MM-DD" (0 = Sunday). */
function weekday(s) {
  const p = parseDate(s);
  return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
}

/** The local date of `ms` in `tz`. */
function localDate(ms, tz) {
  const p = parts(ms, tz);
  return dateStr(p.y, p.m, p.d);
}

/** "HH:MM" → { hh, mm } (null when invalid). */
function parseTime(s) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(s == null ? '' : s).trim());
  return m ? { hh: Number(m[1]), mm: Number(m[2]) } : null;
}

/** ms of "YYYY-MM-DD" at "HH:MM" in `tz`. */
function at(date, time, tz) {
  const p = parseDate(date);
  return toUtc({ ...p, hh: time.hh, mm: time.mm, ss: 0 }, tz);
}

module.exports = { DAY_MS, parts, offset, toUtc, valid, resolveTz, WINDOWS, dateStr, parseDate, addDays, diffDays, weekday, localDate, parseTime, at, pad };
