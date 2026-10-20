'use strict';

// WebUntis lessons (getTimetable) → the rows this plugin stores, and the
// timegrid / holidays in a compact form.
//
// A raw lesson: { id, date: 20261021, startTime: 935, endTime: 1020, kl, te, su, ro (each
// [{ id, name, longname, orgid?, orgname? }]), code?: 'cancelled' | 'irregular', info, substText,
// lstext, activityType }. A changed teacher / room / subject carries the original as
// orgid / orgname.
//
// The key of a lesson is date|start|original subject ids — not WebUntis' lesson id, which a
// school's timetable re-import may renumber (that would look like every lesson vanishing and
// coming back). Two lessons with the same key in one answer get "#2", "#3" in the order of
// their WebUntis ids.
//
// state as WebUntis says it: 'cancelled' (code cancelled), 'changed' (code irregular, an
// original teacher/room/subject, or a substitution text), otherwise 'normal'. Whether a lesson
// is an extra one (appeared after the baseline) is decided by the change detection
// (server/changes.js) and stored as `added`.

const tz = require('./tz');

const str = (v, max = 200) => (typeof v === 'string' ? v.replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** 20261021 → "2026-10-21" (null when invalid) */
function dateOf(n) {
  const s = String(n == null ? '' : n);
  if (!/^\d{8}$/.test(s)) return null;
  const d = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return tz.parseDate(d) ? d : null;
}

/** 935 → "09:35" (null when invalid) */
function timeOf(n) {
  const v = Number(n);
  if (!Number.isInteger(v) || v < 0 || v > 2359 || v % 100 > 59) return null;
  return `${tz.pad(Math.floor(v / 100))}:${tz.pad(v % 100)}`;
}

const list = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
const nameOf = (x) => str(x.name, 60) || str(x.longname, 60);
const longOf = (x) => str(x.longname, 80) || str(x.name, 80);
const join = (arr) => [...new Set(arr.filter(Boolean))].join(', ');
const hasOrg = (x) => x.orgid != null || (typeof x.orgname === 'string' && x.orgname.trim() !== '');

/** Current and original names of a te/ro/su list → { now, old } (old null when nothing changed). */
function namesOf(v) {
  const items = list(v);
  const now = join(items.filter((x) => Number(x.id) !== 0 || nameOf(x)).map(nameOf));
  const changed = items.filter(hasOrg);
  if (!changed.length) return { now, old: null, changed: false };
  const old = join(changed.map((x) => str(x.orgname, 60)));
  // an "original" equal to the current one is no change
  if (old && old === now) return { now, old: null, changed: false };
  return { now, old: old || null, changed: true };
}

/**
 * The timegrid (getTimegridUnits) → [{ day (1 = Sunday … 7 = Saturday), units: [{ name, start, end }] }]
 */
function compactTimegrid(raw) {
  return list(raw).filter((d) => Number.isInteger(d.day)).map((d) => ({
    day: d.day,
    units: list(d.timeUnits).map((u) => ({ name: str(u.name, 10), start: timeOf(u.startTime), end: timeOf(u.endTime) })).filter((u) => u.start && u.end),
  }));
}

/** getHolidays → [{ name, from, to }] overlapping [from, to] */
function compactHolidays(raw, from, to) {
  return list(raw).map((h) => ({ name: str(h.longName, 80) || str(h.name, 80), from: dateOf(h.startDate), to: dateOf(h.endDate) }))
    .filter((h) => h.from && h.to && h.to >= from && h.from <= to).slice(0, 40);
}

/** The holiday name of a date, or null. */
function holidayOn(holidays, date) {
  const h = (holidays || []).find((x) => x.from <= date && date <= x.to);
  return h ? (h.name || 'Ferien') : null;
}

/** { period, periodEnd } of a lesson from the timegrid (null when the grid has no such unit). */
function periodOf(grid, date, start, end) {
  const wd = tz.weekday(date) + 1; // WebUntis: 1 = Sunday
  const day = (grid || []).find((d) => d.day === wd);
  if (!day) return { period: null, periodEnd: null };
  const num = (u, i) => (/^\d{1,2}$/.test(u.name) ? Number(u.name) : i + 1);
  const si = day.units.findIndex((u) => u.start === start);
  const ei = day.units.findIndex((u) => u.end === end);
  const period = si >= 0 ? num(day.units[si], si) : null;
  const periodEnd = ei >= 0 ? num(day.units[ei], ei) : null;
  return { period, periodEnd: period != null && periodEnd != null && periodEnd > period ? periodEnd : null };
}

/**
 * Raw lessons → rows { lkey, date, t_start, t_end, period, period_end, subject, subject_long, teacher,
 * teacher_old, room, room_old, klasse, state, info, subst_text, lstext } sorted by date and time.
 * Lessons outside [from, to] or without date/time are dropped.
 */
function normalize(raw, grid, { from, to } = {}) {
  const sorted = list(raw).slice().sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
  const rows = [];
  const seen = new Map();
  for (const l of sorted) {
    const date = dateOf(l.date);
    const start = timeOf(l.startTime);
    const end = timeOf(l.endTime);
    if (!date || !start || !end) continue;
    if ((from && date < from) || (to && date > to)) continue;
    const su = namesOf(l.su);
    const te = namesOf(l.te);
    const ro = namesOf(l.ro);
    const subjIds = list(l.su).map((x) => (x.orgid != null ? x.orgid : x.id)).filter((x) => x != null).map(String).sort().join(',');
    const base = `${date}|${start}|${subjIds || str(l.lstext, 30) || '-'}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    const substText = str(l.substText, 300);
    let state = 'normal';
    if (l.code === 'cancelled') state = 'cancelled';
    else if (l.code === 'irregular' || su.changed || te.changed || ro.changed || substText) state = 'changed';
    const { period, periodEnd } = periodOf(grid, date, start, end);
    rows.push({
      lkey: n > 1 ? `${base}#${n}` : base,
      date, t_start: start, t_end: end, period, period_end: periodEnd,
      subject: su.now || str(l.lstext, 60) || '', subject_long: join(list(l.su).map(longOf)) || su.now || '',
      teacher: te.now, teacher_old: te.old, room: ro.now, room_old: ro.old,
      klasse: join(list(l.kl).map(nameOf)),
      state, info: str(l.info, 300) || null, subst_text: substText || null, lstext: str(l.lstext, 200) || null,
      subject_old: su.old,
    });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.t_start < b.t_start ? -1 : a.t_start > b.t_start ? 1 : 0));
  return rows;
}

/** The most frequent class name of some rows ('' when none). */
function mainKlasse(rows) {
  const c = new Map();
  for (const r of rows) if (r.klasse) c.set(r.klasse, (c.get(r.klasse) || 0) + 1);
  let best = '';
  let n = 0;
  for (const [k, v] of c) if (v > n) { best = k; n = v; }
  return best;
}

/** The state shown to people: cancelled (also removed) | extra | changed | normal. */
function shownState(row) {
  if (row.removed || row.state === 'cancelled') return 'cancelled';
  if (row.added) return 'extra';
  return row.state === 'changed' ? 'changed' : 'normal';
}

module.exports = { dateOf, timeOf, compactTimegrid, compactHolidays, holidayOn, periodOf, normalize, mainKlasse, shownState, str };
