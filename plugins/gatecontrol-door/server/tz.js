'use strict';

// Wall clock in a time zone without dependencies (Intl does the zone rules;
// the plugin process has Node's full ICU). Used for the per-user time windows
// and the night check.

const fmtCache = new Map();

function formatter(tz) {
  const key = tz || '';
  let f = fmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      ...(tz ? { timeZone: tz } : {}), hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', weekday: 'short',
    });
    if (fmtCache.size > 50) fmtCache.clear();
    fmtCache.set(key, f);
  }
  return f;
}

const WD = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** Wall clock of `ms` in `tz` ('' = the server's zone) → { date: 'YYYY-MM-DD', minutes (0–1439), wd (1 = Monday … 7 = Sunday) }. */
function local(ms, tz) {
  const o = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) o[p.type] = p.value;
  const pad = (n) => String(n).padStart(2, '0');
  return { date: `${o.year}-${pad(o.month)}-${pad(o.day)}`, minutes: (Number(o.hour) % 24) * 60 + Number(o.minute), wd: WD[o.weekday] };
}

/** Is `tz` a time zone Intl knows ('' = the server's zone)? */
function valid(tz) {
  if (tz === '') return true;
  if (typeof tz !== 'string' || tz.length > 64) return false;
  try { formatter(tz); return true; } catch { return false; }
}

/** 'HH:MM' → minutes after midnight (null when invalid). */
function minutesOf(hhmm) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

module.exports = { local, valid, minutesOf };
