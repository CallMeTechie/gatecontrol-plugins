'use strict';

// Homework and exams (1.2.0): optional data next to the timetable, fetched in the same cycle and
// with the same session (server/untis.js homework() / exams()) for the same dates.
//
//   homework  once per account and cycle, from 14 days before the timetable's first date (a
//             homework given last week can be due this week) to its last date. A parent account's
//             answer may hold several children's homework: when its `records` name the student
//             (elementIds), only those; otherwise, with several students in one account, only
//             homework of subjects in that student's timetable. Stored per student, replaced by every
//             successful fetch.
//   exams     per student for the timetable's dates. 1.3.0: asked like the "webuntis" library
//             (klasseId of the student's class, no studentId — variant 'class'), then with the
//             studentId ('student'), then for the account's own class ('own') — a parent account is
//             refused the studentId variant by some schools (HTTP 403). The variant that answered is
//             remembered per account (extras.examsVariant) and asked first next time.
//             assignedStudents present → only exams the student is assigned to; otherwise the
//             exam's classes (studentClass) must include the student's class. Grades are never asked
//             for or stored.
//
// Both are optional: an error (any code) never stops or fails the cycle and keeps what was stored.
// 1.3.0: an endpoint WebUntis does not share with the account ('no_right' — 401/403 — or
// 'unsupported' — 404) is asked again after 24 hours, any other error ('failed') after 6 hours,
// 'network' in the next cycle (accounts.extras_json { homework?, exams?: { code, until } }). The
// settings say so in plain words („Klassenarbeiten sind für dieses Konto in WebUntis nicht
// freigegeben“), never with a code. The shapes of these answers are not documented by Untis;
// everything is read defensively.

const store = require('./store');
const untis = require('./untis');
const tt = require('./timetable');
const tz = require('./tz');

const SKIP_MS = 6 * 3600000;
const SKIP_UNSHARED_MS = 24 * 3600000;
/** Not shared with this account (or not there): asked again after a day, not after 6 hours. */
const UNSHARED = new Set(['no_right', 'unsupported', 'auth']);
const skipFor = (code) => (UNSHARED.has(code) ? SKIP_UNSHARED_MS : SKIP_MS);
const HW_BACK_DAYS = 14;
const MAX_ROWS = 200;

const str = tt.str;
const list = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);

/** The subjects of a student's lessons: lower-case short or long name → { subject, subjectLong }. */
function subjectIndex(rows) {
  const m = new Map();
  for (const l of rows || []) {
    const v = { subject: l.subject || '', subjectLong: l.subject_long || '' };
    for (const k of [l.subject, l.subject_long]) if (k && !m.has(k.toLowerCase())) m.set(k.toLowerCase(), v);
  }
  return m;
}

/** A subject name of the REST answers → { subject, subject_long, known } (short and long name from the timetable when it has the subject). */
function subjectOf(name, index) {
  const n = str(typeof name === 'string' ? name : (name && typeof name === 'object' ? (name.name || name.longName || name.longname) : ''), 80);
  const hit = n && index ? index.get(n.toLowerCase()) : null;
  if (hit) {
    const subject = hit.subject || n;
    const long = hit.subjectLong && hit.subjectLong !== subject ? hit.subjectLong : null;
    return { subject, subject_long: long, known: true };
  }
  return { subject: n, subject_long: null, known: false };
}

/** "HHMM" of the REST answers → "HH:MM" (null for 0 / missing / invalid). */
const timeOrNull = (v) => (v == null || v === 0 || v === '' ? null : tt.timeOf(v));

/** The WebUntis class id most of the raw lessons belong to (null when none). */
function klasseIdOf(raw) {
  const c = new Map();
  for (const l of list(raw)) for (const k of list(l.kl)) if (Number.isSafeInteger(Number(k.id)) && Number(k.id) > 0) c.set(Number(k.id), (c.get(Number(k.id)) || 0) + 1);
  let best = null;
  let n = 0;
  for (const [k, v] of c) if (v > n) { best = k; n = v; }
  return best;
}

/** The lower-case class names of normalized rows ("5a, 5b" → 5a, 5b). */
function klassenOf(rows) {
  const s = new Set();
  for (const r of rows || []) for (const k of String(r.klasse || '').split(',')) if (k.trim()) s.add(k.trim().toLowerCase());
  return s;
}

/**
 * The homework answer → rows of one student { hw_id, given_date, due_date, subject, subject_long, text, remark, completed }.
 * o = { personId, index (subjectIndex), siblings: the account has further students }
 */
function homeworkRows(data, o = {}) {
  const d = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const lessons = new Map(list(d.lessons).map((l) => [String(l.id), l]));
  const named = new Set();
  let anyNamed = false;
  for (const r of list(d.records)) {
    const ids = Array.isArray(r.elementIds) ? r.elementIds.map(Number) : [];
    if (o.personId != null && ids.includes(o.personId)) { anyNamed = true; named.add(String(r.homeworkId)); }
  }
  const out = [];
  const seen = new Set();
  for (const h of list(d.homeworks)) {
    const id = h.id != null && String(h.id).trim() ? String(h.id).trim().slice(0, 40) : null;
    const due = tt.dateOf(h.dueDate);
    if (!id || !due || seen.has(id)) continue;
    if (anyNamed && !named.has(id)) continue;
    const l = lessons.get(String(h.lessonId));
    const sub = subjectOf(l ? (l.subject != null ? l.subject : l.name) : '', o.index);
    if (!anyNamed && o.siblings && o.index && o.index.size && !sub.known) continue;
    seen.add(id);
    out.push({
      hw_id: id, given_date: tt.dateOf(h.date), due_date: due, subject: sub.subject, subject_long: sub.subject_long,
      text: str(h.text, 500), remark: str(h.remark, 200) || null, completed: h.completed === true,
    });
    if (out.length >= MAX_ROWS) break;
  }
  return out;
}

/**
 * The exams answer → rows of one student { ex_id, date, t_start, t_end, subject, subject_long, name, type, text }
 * within [from, to]. o = { personId, klassen (Set of lower-case class names), index, from, to }
 */
function examRows(raw, o = {}) {
  const out = [];
  const seen = new Set();
  for (const e of list(raw)) {
    const id = e.id != null && String(e.id).trim() ? String(e.id).trim().slice(0, 40) : null;
    const date = tt.dateOf(e.examDate);
    if (!id || !date || seen.has(id)) continue;
    if ((o.from && date < o.from) || (o.to && date > o.to)) continue;
    const assigned = list(e.assignedStudents);
    if (assigned.length) {
      if (!assigned.some((a) => Number(a.id) === o.personId)) continue;
    } else {
      const cls = (Array.isArray(e.studentClass) ? e.studentClass : []).map((x) => str(typeof x === 'string' ? x : (x && x.name) || '', 60).toLowerCase()).filter(Boolean);
      if (cls.length && o.klassen && o.klassen.size && !cls.some((c) => o.klassen.has(c))) continue;
    }
    seen.add(id);
    const sub = subjectOf(e.subject, o.index);
    out.push({
      ex_id: id, date, t_start: timeOrNull(e.startTime), t_end: timeOrNull(e.endTime), subject: sub.subject, subject_long: sub.subject_long,
      name: str(e.name, 120), type: str(e.examType, 60) || null, text: str(e.text, 300) || null,
    });
    if (out.length >= MAX_ROWS) break;
  }
  return out;
}

/**
 * Homework and exams of one account's cycle; stores them. Never throws.
 * fetched: [{ student, raw, rows }] — the students whose timetable this cycle fetched (raw and normalized lessons).
 * → the account's new extras state ({ homework?: { code, until }, exams?: { code, until } }).
 */
async function fetchAccount(gc, client, acc, fetched, range, now, deadline = Infinity) {
  const state = { ...((acc && acc.extras && typeof acc.extras === 'object') ? acc.extras : {}) };
  if (!fetched.length) return state;
  const skipped = (k) => state[k] && Number(state[k].until) > now;
  const failed = (k, e) => {
    const code = untis.codeOf(e);
    if (code !== 'network') state[k] = { code, until: now + skipFor(code) };
    gc.log.info(`${k} not fetched`, acc.id, code);
  };
  const siblings = fetched.length > 1;
  if (!skipped('homework') && Date.now() <= deadline) {
    try {
      const data = await client.homework(tz.addDays(range.from, -HW_BACK_DAYS), range.to);
      for (const f of fetched) {
        await store.replaceHomework(gc, f.student.id, homeworkRows(data, { personId: f.student.person_id, index: subjectIndex(f.rows), siblings }));
      }
      delete state.homework;
    } catch (e) { failed('homework', e); }
  }
  if (!skipped('exams')) {
    let ok = 0;
    let err = null;
    for (const f of fetched) {
      if (Date.now() > deadline) break;
      const r = await examsOf(client, f, range, state.examsVariant);
      if (r.raw) {
        state.examsVariant = r.variant;
        const rows = examRows(r.raw, { personId: f.student.person_id, klassen: klassenOf(f.rows), index: subjectIndex(f.rows), from: range.from, to: range.to });
        await store.replaceExams(gc, f.student.id, range.from, range.to, rows);
        ok += 1;
      } else {
        err = err || r.error;
        // no variant worked for this student: the next ones would not fare better (same account)
        if (!ok || untis.codeOf(r.error) === 'network') break;
      }
    }
    if (err && !ok) failed('exams', err);
    else if (ok) delete state.exams;
  }
  return state;
}

/**
 * 1.3.0: the exams of one student, asked in the remembered variant first, then the others
 * (untis.EXAM_VARIANTS). → { raw, variant } | { error } ('network' stops at once; the most telling
 * error is kept: 'no_right' over 'unsupported' over 'failed').
 */
async function examsOf(client, f, range, preferred) {
  const order = untis.EXAM_VARIANTS.includes(preferred) ? [preferred, ...untis.EXAM_VARIANTS.filter((v) => v !== preferred)] : untis.EXAM_VARIANTS.slice();
  const rank = { no_right: 3, auth: 3, failed: 2, unsupported: 1 };
  let error = null;
  for (const variant of order) {
    try {
      const raw = await client.exams(range.from, range.to, { klasseId: klasseIdOf(f.raw), studentId: f.student.person_id, variant });
      return { raw, variant };
    } catch (e) {
      const code = untis.codeOf(e);
      if (code === 'network') return { error: e };
      if (!error || (rank[code] || 0) > (rank[untis.codeOf(error)] || 0)) error = e;
    }
  }
  return { error };
}

module.exports = { SKIP_MS, SKIP_UNSHARED_MS, skipFor, HW_BACK_DAYS, examsOf, subjectIndex, subjectOf, klasseIdOf, klassenOf, homeworkRows, examRows, fetchAccount };
