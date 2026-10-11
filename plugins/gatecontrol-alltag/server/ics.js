'use strict';

// iCalendar (RFC 5545) reader — the subset calendars and waste calendars
// actually use, without dependencies:
//
//   * unfolding, parameters (also quoted), text escaping (\\ \; \, \n);
//   * VEVENT: UID, SUMMARY, LOCATION, DTSTART/DTEND/DURATION, STATUS,
//     all-day (VALUE=DATE), UTC (…Z), TZID (IANA, Windows/Outlook names,
//     vendor prefixes — tz.resolveTz), floating times (the default zone);
//   * RRULE: FREQ DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, COUNT, UNTIL,
//     BYDAY (also 2TU / -1FR), BYMONTHDAY (also negative), BYMONTH,
//     BYSETPOS, WKST — expanded in the event's own zone, so 09:00 stays
//     09:00 across a DST change; other BY… parts (BYHOUR, BYWEEKNO, …) are
//     ignored;
//   * EXDATE, RDATE, RECURRENCE-ID overrides, STATUS:CANCELLED.
//
// Only a window is expanded (from … to) and everything has hard caps: the
// input size, the number of VEVENTs, the instances per event and in total,
// the iterations of one rule. VTIMEZONE blocks are skipped (zones come from
// Intl); VTODO, VJOURNAL and VALARM are ignored.

const tz = require('./tz');

const LIMITS = Object.freeze({
  bytes: 5 * 1024 * 1024,   // input (characters) — the host's fetch limit
  events: 10000,            // VEVENT blocks read
  instances: 5000,          // instances returned in total
  perEvent: 1000,           // instances of one recurring event in the window
  iterations: 20000,        // periods one RRULE may walk through
  text: 200,                // SUMMARY / LOCATION characters kept
});

const DAY_MS = tz.DAY_MS;
const WEEKDAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function icsError(code) { return Object.assign(new Error(code), { code }); }

// ─── Lines ──────────────────────────────────────

/** Unfold (CRLF/LF + space or tab continues a line) and split. */
function lines(text) {
  return String(text).replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

/** "NAME;P=1;Q=\"a:b\":value" → { name, params, value } (null when malformed). */
function parseLine(line) {
  const n = line.length;
  let i = 0;
  while (i < n && line[i] !== ';' && line[i] !== ':') i++;
  const name = line.slice(0, i).toUpperCase();
  if (!name) return null;
  const params = {};
  while (i < n && line[i] === ';') {
    let j = i + 1;
    while (j < n && line[j] !== '=' && line[j] !== ';' && line[j] !== ':') j++;
    const key = line.slice(i + 1, j).toUpperCase();
    let val = '';
    if (line[j] === '=') {
      j++;
      while (j < n && line[j] !== ';' && line[j] !== ':') {
        if (line[j] === '"') {
          const e = line.indexOf('"', j + 1);
          if (e < 0) return null;
          val += line.slice(j + 1, e);
          j = e + 1;
        } else { val += line[j]; j++; }
      }
    }
    if (key && !(key in params)) params[key] = val;
    i = j;
  }
  if (line[i] !== ':') return null;
  return { name, params, value: line.slice(i + 1) };
}

/** TEXT value: \\ \; \, \n. */
function unescapeText(v) {
  return String(v).replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

function clip(s) {
  const t = String(s || '').replace(/[\0-\x08\x0b-\x1f\x7f]/g, '').replace(/\s+/g, ' ').trim();
  return t.length > LIMITS.text ? t.slice(0, LIMITS.text - 1) + '…' : t;
}

// ─── Values ─────────────────────────────────────

/**
 * DATE / DATE-TIME value → { allDay: true, date } |
 * { allDay: false, wall: { y, m, d, hh, mm, ss }, zone } (zone 'UTC' or IANA).
 */
function parseDateValue(value, params, ctx) {
  const v = String(value || '').trim();
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m) {
    const date = `${m[1]}-${m[2]}-${m[3]}`;
    return tz.parseDate(date) ? { allDay: true, date } : null;
  }
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!m) return null;
  const wall = { y: +m[1], m: +m[2], d: +m[3], hh: +m[4], mm: +m[5], ss: Math.min(59, +m[6]) };
  if (!tz.parseDate(tz.dateStr(wall.y, wall.m, wall.d)) || wall.hh > 23 || wall.mm > 59) return null;
  let zone;
  if (m[7]) zone = 'UTC';
  else if (params && params.TZID) zone = tz.resolveTz(params.TZID) || ctx.calTz || ctx.tz;
  else zone = ctx.tz; // floating: the plugin's zone
  return { allDay: false, wall, zone };
}

/** Value object → instant (all-day: midnight in the default zone). */
function instant(v, ctx) {
  if (v.allDay) return tz.toUtc({ ...tz.parseDate(v.date) }, ctx.tz);
  return tz.toUtc(v.wall, v.zone);
}

/** Comparable key of a start ("YYYY-MM-DD" for all-day, the instant otherwise). */
function keyOf(v, ctx) {
  return v.allDay ? v.date : String(instant(v, ctx));
}

/** "P1DT2H" → { ms, days } (days: whole days for all-day events). */
function parseDuration(s) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(s || '').trim());
  if (!m || s.trim() === 'P' || /T$/.test(s.trim())) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const days = (+m[2] || 0) * 7 + (+m[3] || 0);
  const ms = ((days * 24 + (+m[4] || 0)) * 3600 + (+m[5] || 0) * 60 + (+m[6] || 0)) * 1000;
  return { ms: sign * ms, days: sign * days };
}

/** List values (EXDATE/RDATE, comma separated) with their params. */
function dateList(prop, ctx) {
  const out = [];
  for (const part of String(prop.value).split(',')) {
    const raw = part.split('/')[0]; // RDATE;VALUE=PERIOD: the start
    const v = parseDateValue(raw, prop.params, ctx);
    if (v) out.push(v);
  }
  return out;
}

// ─── RRULE ──────────────────────────────────────

function parseRrule(s, ctx) {
  const r = { freq: null, interval: 1, count: null, until: null, byday: [], bymonthday: [], bymonth: [], bysetpos: [], wkst: 1 };
  for (const part of String(s || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim().toUpperCase();
    const v = part.slice(eq + 1).trim().toUpperCase();
    const ints = () => v.split(',').map((x) => Number(x)).filter((x) => Number.isInteger(x) && x !== 0);
    if (k === 'FREQ') r.freq = v;
    else if (k === 'INTERVAL') r.interval = Math.max(1, Math.min(1000, parseInt(v, 10) || 1));
    else if (k === 'COUNT') r.count = Math.max(0, Math.min(100000, parseInt(v, 10) || 0));
    else if (k === 'UNTIL') r.until = parseDateValue(v, null, { ...ctx, tz: ctx.tz });
    else if (k === 'BYDAY') {
      for (const d of v.split(',')) {
        const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(d.trim());
        if (m) r.byday.push({ n: m[1] ? parseInt(m[1], 10) : 0, wd: WEEKDAYS[m[2]] });
      }
    } else if (k === 'BYMONTHDAY') r.bymonthday = ints().filter((x) => x >= -31 && x <= 31);
    else if (k === 'BYMONTH') r.bymonth = ints().filter((x) => x >= 1 && x <= 12);
    else if (k === 'BYSETPOS') r.bysetpos = ints().filter((x) => x >= -366 && x <= 366);
    else if (k === 'WKST' && v in WEEKDAYS) r.wkst = WEEKDAYS[v];
  }
  return ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(r.freq) ? r : null;
}

// day numbers: days since 1970-01-01 (UTC calendar arithmetic, no zones)
const dayNum = (y, m, d) => Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
const wdOf = (n) => (((n + 4) % 7) + 7) % 7;
function ymd(n) { const t = new Date(n * DAY_MS); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }; }
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Days of month (y, m) the rule selects (BYMONTHDAY / BYDAY), sorted. */
function monthDays(y, m, r, start) {
  const len = daysIn(y, m);
  const first = dayNum(y, m, 1);
  let set = null;
  if (r.bymonthday.length) set = new Set(r.bymonthday.map((n) => (n > 0 ? n : len + 1 + n)).filter((n) => n >= 1 && n <= len));
  if (r.byday.length) {
    const ds = new Set();
    for (const { n, wd } of r.byday) {
      const all = [];
      for (let d = 1; d <= len; d++) if (wdOf(first + d - 1) === wd) all.push(d);
      if (!n) all.forEach((d) => ds.add(d));
      else { const pick = n > 0 ? all[n - 1] : all[all.length + n]; if (pick) ds.add(pick); }
    }
    set = set ? new Set([...set].filter((d) => ds.has(d))) : ds;
  }
  if (!set) set = new Set(start.d <= len ? [start.d] : []);
  return [...set].sort((a, b) => a - b).map((d) => first + d - 1);
}

/** Candidate days (sorted day numbers) of period k. */
function candidates(r, k, start, startN) {
  const step = k * r.interval;
  let out = [];
  if (r.freq === 'DAILY') {
    const n = startN + step;
    const { y, m, d } = ymd(n);
    const len = daysIn(y, m);
    if (r.bymonth.length && !r.bymonth.includes(m)) return [];
    if (r.bymonthday.length && !r.bymonthday.some((x) => (x > 0 ? x : len + 1 + x) === d)) return [];
    if (r.byday.length && !r.byday.some((b) => b.wd === wdOf(n))) return [];
    return [n];
  }
  if (r.freq === 'WEEKLY') {
    const weekStart = startN - ((wdOf(startN) - r.wkst + 7) % 7) + 7 * step;
    const wds = r.byday.length ? [...new Set(r.byday.map((b) => b.wd))] : [wdOf(startN)];
    out = wds.map((wd) => weekStart + ((wd - r.wkst + 7) % 7)).sort((a, b) => a - b);
    if (r.bymonth.length) out = out.filter((n) => r.bymonth.includes(ymd(n).m));
  } else if (r.freq === 'MONTHLY') {
    const idx = start.y * 12 + (start.m - 1) + step;
    const y = Math.floor(idx / 12); const m = (idx % 12) + 1;
    if (r.bymonth.length && !r.bymonth.includes(m)) return [];
    out = monthDays(y, m, r, start);
  } else {
    const y = start.y + step;
    if (r.bymonth.length) {
      for (const m of [...r.bymonth].sort((a, b) => a - b)) out.push(...monthDays(y, m, r, start));
    } else if (r.bymonthday.length) {
      for (let m = 1; m <= 12; m++) out.push(...monthDays(y, m, { ...r, byday: [] }, start));
    } else if (r.byday.length) {
      // BYDAY relative to the whole year (e.g. 20MO)
      const first = dayNum(y, 1, 1); const len = dayNum(y + 1, 1, 1) - first;
      const ds = new Set();
      for (const { n, wd } of r.byday) {
        const all = [];
        for (let i = 0; i < len; i++) if (wdOf(first + i) === wd) all.push(first + i);
        if (!n) all.forEach((x) => ds.add(x));
        else { const pick = n > 0 ? all[n - 1] : all[all.length + n]; if (pick != null) ds.add(pick); }
      }
      out = [...ds].sort((a, b) => a - b);
    } else if (start.d <= daysIn(y, start.m)) out = [dayNum(y, start.m, start.d)];
  }
  if (r.bysetpos.length && out.length) {
    const picked = new Set();
    for (const p of r.bysetpos) { const v = p > 0 ? out[p - 1] : out[out.length + p]; if (v != null) picked.add(v); }
    out = [...picked].sort((a, b) => a - b);
  }
  return out;
}

/** Period index to start at so the walk begins shortly before day `fromN` (only without COUNT). */
function skipTo(r, start, startN, fromN) {
  if (fromN <= startN) return 0;
  let periods;
  if (r.freq === 'DAILY') periods = fromN - startN;
  else if (r.freq === 'WEEKLY') periods = Math.floor((fromN - startN) / 7);
  else if (r.freq === 'MONTHLY') { const f = ymd(fromN); periods = (f.y - start.y) * 12 + (f.m - start.m); } else periods = ymd(fromN).y - start.y;
  return Math.max(0, Math.floor(periods / r.interval) - 1);
}

// ─── Events ─────────────────────────────────────

function newEvent() {
  return { uid: null, summary: '', location: '', start: null, end: null, duration: null, rrule: null, exdates: [], rdates: [], recurrenceId: null, status: null };
}

/** All VEVENTs of the text (props only, not expanded). */
function readEvents(text, ctx) {
  if (typeof text !== 'string') throw icsError('ICS_INVALID');
  if (text.length > LIMITS.bytes) throw icsError('ICS_TOO_LARGE');
  const all = lines(text);
  const events = [];
  let sawCalendar = false;
  let name = null;
  let depth = []; // component stack
  let ev = null;
  let truncated = false;
  for (const raw of all) {
    if (!raw) continue;
    const p = parseLine(raw);
    if (!p) continue;
    if (p.name === 'BEGIN') {
      const comp = p.value.trim().toUpperCase();
      depth.push(comp);
      if (comp === 'VCALENDAR') sawCalendar = true;
      if (comp === 'VEVENT' && depth.length <= 2) {
        if (events.length >= LIMITS.events) { truncated = true; ev = null; } else ev = newEvent();
      }
      continue;
    }
    if (p.name === 'END') {
      const comp = p.value.trim().toUpperCase();
      // pop up to the matching BEGIN (tolerates a missing END of a nested block)
      const i = depth.lastIndexOf(comp);
      if (i >= 0) depth = depth.slice(0, i);
      if (comp === 'VEVENT' && ev) { events.push(ev); ev = null; }
      continue;
    }
    const top = depth[depth.length - 1];
    if (top === 'VCALENDAR') {
      if (p.name === 'X-WR-CALNAME' && !name) name = clip(unescapeText(p.value));
      if (p.name === 'X-WR-TIMEZONE' && !ctx.calTz) ctx.calTz = tz.resolveTz(p.value);
      continue;
    }
    if (top !== 'VEVENT' || !ev) continue; // VALARM inside VEVENT, VTIMEZONE, VTODO …
    switch (p.name) {
      case 'UID': ev.uid = String(p.value).trim().slice(0, 500); break;
      case 'SUMMARY': ev.summary = clip(unescapeText(p.value)); break;
      case 'LOCATION': ev.location = clip(unescapeText(p.value)); break;
      case 'STATUS': ev.status = String(p.value).trim().toUpperCase(); break;
      case 'DTSTART': ev.start = p; break;
      case 'DTEND': ev.end = p; break;
      case 'DURATION': ev.duration = parseDuration(p.value); break;
      case 'RRULE': if (!ev.rrule) ev.rrule = p.value; break;
      case 'EXDATE': ev.exdates.push(p); break;
      case 'RDATE': ev.rdates.push(p); break;
      case 'RECURRENCE-ID': ev.recurrenceId = p; break;
      default: break;
    }
  }
  if (!sawCalendar) throw icsError('ICS_INVALID');
  return { name, events, truncated };
}

/** Resolve an event's start/end into value objects and a duration. */
function prepare(e, ctx) {
  const start = e.start && parseDateValue(e.start.value, e.start.params, ctx);
  if (!start) return null;
  const end = e.end && parseDateValue(e.end.value, e.end.params, ctx);
  let durMs = 0; let durDays = start.allDay ? 1 : 0;
  if (end && end.allDay === start.allDay) {
    if (start.allDay) durDays = Math.max(1, tz.diffDays(start.date, end.date));
    else durMs = Math.max(0, instant(end, ctx) - instant(start, ctx));
  } else if (e.duration) {
    if (start.allDay) durDays = Math.max(1, Math.round(e.duration.ms / DAY_MS));
    else durMs = Math.max(0, e.duration.ms);
  }
  return { start, durMs, durDays };
}

/** One instance object (start value → times). */
function instanceOf(e, prep, sv, ctx, origKey) {
  const uid = e.uid || `${e.summary}@${keyOf(prep.start, ctx)}`;
  if (sv.allDay) {
    const endDate = tz.addDays(sv.date, prep.durDays);
    return {
      uid, key: `${uid}|${origKey}`, title: e.summary, location: e.location, allDay: true,
      date: sv.date, endDate, start: instant(sv, ctx), end: tz.toUtc({ ...tz.parseDate(endDate) }, ctx.tz),
    };
  }
  const start = instant(sv, ctx);
  return { uid, key: `${uid}|${origKey}`, title: e.summary, location: e.location, allDay: false, date: tz.localDate(start, ctx.tz), endDate: null, start, end: start + prep.durMs };
}

/** Starts of a (master) event inside the window (value objects with their key). */
function starts(e, prep, ctx, from, to) {
  const out = [];
  const s = prep.start;
  const zone = s.allDay ? null : s.zone;
  const startWall = s.allDay ? tz.parseDate(s.date) : s.wall;
  const startN = dayNum(startWall.y, startWall.m, startWall.d);
  const valueAt = (n) => {
    const { y, m, d } = ymd(n);
    return s.allDay ? { allDay: true, date: tz.dateStr(y, m, d) } : { allDay: false, wall: { y, m, d, hh: s.wall.hh, mm: s.wall.mm, ss: s.wall.ss }, zone };
  };
  const durSpan = s.allDay ? prep.durDays * DAY_MS : prep.durMs;
  const inWindow = (v) => { const t = instant(v, ctx); return t < to && (t + durSpan > from || t >= from); };
  const pastEnd = (v) => instant(v, ctx) >= to;

  // DTSTART is always the first instance
  if (inWindow(s)) out.push(s);
  const rule = e.rrule ? parseRrule(e.rrule, ctx) : null;
  if (rule && rule.count !== 0) {
    const untilOk = (v) => {
      if (!rule.until) return true;
      if (rule.until.allDay || v.allDay) {
        const ud = rule.until.allDay ? rule.until.date : tz.localDate(instant(rule.until, ctx), v.allDay ? ctx.tz : v.zone);
        const vd = v.allDay ? v.date : tz.dateStr(v.wall.y, v.wall.m, v.wall.d);
        return vd <= ud;
      }
      return instant(v, ctx) <= instant(rule.until, ctx);
    };
    // without COUNT the walk may start shortly before the window
    const fromN = Math.floor((from - durSpan) / DAY_MS) - 2;
    let k = rule.count ? 0 : skipTo(rule, startWall, startN, fromN);
    let count = 1;
    let produced = out.length; // DTSTART counts towards the cap
    for (let iter = 0; iter < LIMITS.iterations; iter++, k++) {
      const days = candidates(rule, k, startWall, startN);
      let stop = false;
      for (const n of days) {
        if (n <= startN) continue; // before or = DTSTART (already counted)
        const v = valueAt(n);
        if (!untilOk(v)) { stop = true; break; }
        count++;
        if (rule.count && count > rule.count) { stop = true; break; }
        if (pastEnd(v)) { stop = true; break; }
        if (inWindow(v)) { out.push(v); produced++; if (produced >= LIMITS.perEvent) { stop = true; break; } }
      }
      if (stop) break;
      // a period starting after the window ends the walk (no candidate can be earlier)
      const probe = candidatesStart(rule, k, startWall, startN);
      if (probe != null && probe * DAY_MS > to + DAY_MS) break;
    }
  }
  for (const p of e.rdates) for (const v of dateList(p, ctx)) if (inWindow(v)) out.push(v);
  return out;
}

/** First day of period k (used to end the walk). */
function candidatesStart(r, k, start, startN) {
  const step = k * r.interval;
  if (r.freq === 'DAILY') return startN + step;
  if (r.freq === 'WEEKLY') return startN - ((wdOf(startN) - r.wkst + 7) % 7) + 7 * step;
  if (r.freq === 'MONTHLY') { const idx = start.y * 12 + (start.m - 1) + step; return dayNum(Math.floor(idx / 12), (idx % 12) + 1, 1); }
  return dayNum(start.y + step, 1, 1);
}

/**
 * Parse and expand.
 * @param {string} text
 * @param {{ tz: string, from: number, to: number }} opts  default zone (floating times, all-day), window [from, to)
 * @returns {{ name: string|null, instances: Array, truncated: boolean, events: number }}
 */
function expand(text, { tz: zone = 'Europe/Berlin', from, to } = {}) {
  const ctx = { tz: tz.valid(zone) ? zone : 'UTC', calTz: null };
  const { name, events, truncated: tooMany } = readEvents(text, ctx);
  let truncated = tooMany;
  const masters = new Map();
  const overrides = new Map(); // uid → Map(origKey → event)
  for (const e of events) {
    if (e.recurrenceId) {
      if (!e.uid) continue;
      const rid = parseDateValue(e.recurrenceId.value, e.recurrenceId.params, ctx);
      if (!rid) continue;
      if (!overrides.has(e.uid)) overrides.set(e.uid, new Map());
      overrides.get(e.uid).set(keyOf(rid, ctx), e);
    } else {
      const k = e.uid || `${e.summary}|${e.start && e.start.value}`;
      // a repeated UID without RECURRENCE-ID: the last one wins (as calendar apps do)
      masters.set(k, e);
    }
  }
  const out = [];
  const push = (inst) => {
    if (out.length >= LIMITS.instances) { truncated = true; return false; }
    out.push(inst);
    return true;
  };
  for (const e of masters.values()) {
    if (e.status === 'CANCELLED') continue;
    const prep = prepare(e, ctx);
    if (!prep) continue;
    const ov = (e.uid && overrides.get(e.uid)) || new Map();
    const exKeys = new Set();
    const exDates = new Set();
    for (const p of e.exdates) {
      for (const v of dateList(p, ctx)) {
        if (v.allDay) exDates.add(v.date);
        exKeys.add(keyOf(v, ctx));
      }
    }
    const seen = new Set();
    for (const v of starts(e, prep, ctx, from, to)) {
      const k = keyOf(v, ctx);
      if (seen.has(k)) continue;
      seen.add(k);
      if (exKeys.has(k)) continue;
      if (!v.allDay && exDates.has(tz.dateStr(v.wall.y, v.wall.m, v.wall.d))) continue;
      if (ov.has(k)) continue; // replaced (or cancelled) by an override, emitted below
      if (!push(instanceOf(e, prep, v, ctx, k))) break;
    }
  }
  // overrides: their own times; emitted when they fall into the window
  for (const [uid, map] of overrides) {
    const master = masters.get(uid);
    if (master && master.status === 'CANCELLED') continue;
    for (const [origKey, e] of map) {
      if (e.status === 'CANCELLED') continue;
      const prep = prepare({ ...e, start: e.start || e.recurrenceId }, ctx);
      if (!prep) continue;
      const merged = { ...e, uid, summary: e.summary || (master && master.summary) || '', location: e.location || (master && master.location) || '' };
      const inst = instanceOf(merged, prep, prep.start, ctx, origKey);
      if (inst.start < to && (inst.end > from || inst.start >= from)) if (!push(inst)) break;
    }
  }
  out.sort((a, b) => a.start - b.start || (a.allDay === b.allDay ? 0 : a.allDay ? -1 : 1) || a.title.localeCompare(b.title));
  return { name, instances: out, truncated, events: events.length };
}

module.exports = { expand, readEvents, parseLine, unescapeText, parseDateValue, parseDuration, parseRrule, lines, LIMITS };
