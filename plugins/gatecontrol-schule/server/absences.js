'use strict';

// Absences (1.4.0): what the class register of WebUntis says about a student's absences
// (server/untis.js absences(): api/classreg/absences/students with the student's id, every excuse
// status), read only.
//
//   fetch      per student in its account's cycle (same session), at most hourly per student, for the
//              school year (from 1 August) up to 14 days ahead; optional like homework / exams (401/403 →
//              'no_right', 404 → 'unsupported': asked again after a day; another error after 6 hours;
//              'network' in the next cycle — accounts.extras_json.absences { code, until }). Never stops
//              or fails the cycle.
//   store      table absences (student, WebUntis id): date (and end date), times, reason, text and
//              whether it is excused (true / false / null = open). Every fetch replaces the student's
//              absences within the fetched dates. Kept for the school year, at least 180 days.
//   changes    a student's first good fetch is the baseline (no pushes). Later a new absence ('new') or
//              a changed one (excused / not excused / other dates, times or reason — 'excused',
//              'unexcused', 'changed') is 'pending'.
//   who        an administrator, the student's recipients and the child itself (its mapped user) —
//              no kiosk device, no viewer known by device trust only.
//   push       topic 'absences' („Fehlzeiten“): one push per student and cycle to the recipients — the
//              child only with the setting absence_notify_child (default off); quiet hours hold them; a
//              change not sent within 3 days expires.
//   API        GET app/absences?days=60 (1…180) → { ok, absences: [{ id, studentId, date, start, end,
//              endDate?, reason?, excused, text? }] } newest first, ≤ 200.

const store = require('./store');
const untis = require('./untis');
const tz = require('./tz');
const tt = require('./timetable');
const extras = require('./extras');
const changes = require('./changes');
const notify = require('./notify');
const texts = require('./texts.json');

const HOUR = 3600000;
const DAY = 86400000;
const EXPIRE_MS = 3 * DAY;
const AHEAD_DAYS = 14;
const KEEP_DAYS = 180;
const MAX_LINES = 6;
const TOPIC = 'absences';
const ID_RE = /^[A-Za-z0-9_.-]{1,40}$/;

const t = (lang, key, params) => notify.fmt(texts, lang, key, params);
const list = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
const str = tt.str;

/** The first day of the school year of a date (1 August). */
function schoolYearStart(date) {
  const p = tz.parseDate(date);
  return `${p.m >= 8 ? p.y : p.y - 1}-08-01`;
}

/** The dates a fetch asks for: the school year up to 14 days ahead. */
function windowOf(now, cfg) {
  const today = tz.localDate(now, cfg.tz);
  return { from: schoolYearStart(today), to: tz.addDays(today, AHEAD_DAYS) };
}

/** Absences ending before this date are pruned: the school year, at least the last 180 days. */
function keepFrom(now, cfg) {
  const today = tz.localDate(now, cfg.tz);
  const a = schoolYearStart(today);
  const b = tz.addDays(today, -KEEP_DAYS);
  return a < b ? a : b;
}

/** "HHMM" → "HH:MM"; 0 / missing → null. */
const timeOrNull = (v) => (v == null || v === '' || Number(v) === 0 ? null : tt.timeOf(v));

/**
 * Excused? true | false | null (open, not decided yet). The flag isExcused (of the absence or its
 * excuse) wins; a status saying "open" is open; any other status, or an excuse that is there but does
 * not excuse, is "not excused"; nothing at all is open. Status names are the school's own.
 */
function excusedOf(a) {
  const ex = a.excuse && typeof a.excuse === 'object' && !Array.isArray(a.excuse) ? a.excuse : null;
  if (a.isExcused === true || (ex && ex.isExcused === true)) return true;
  const status = str(typeof a.excuseStatus === 'string' ? a.excuseStatus : (ex && typeof ex.excuseStatus === 'string' ? ex.excuseStatus : ''), 60).toLowerCase();
  if (/offen|open|pending|ausstehend|unbearbeitet|^-$/.test(status)) return null;
  if (status) return false;
  if (ex && Number(ex.id) > 0) return false;
  return null;
}

/** The absences answer → rows { abs_id, date, end_date, t_start, t_end, reason, text, excused } of student `personId`. */
function absenceRows(raw, personId) {
  const out = [];
  const seen = new Set();
  for (const a of list(raw)) {
    const id = a.id == null ? '' : String(a.id).trim();
    const date = tt.dateOf(a.startDate);
    if (!ID_RE.test(id) || !date || seen.has(id)) continue;
    const sid = a.studentId != null ? Number(a.studentId) : (a.student && typeof a.student === 'object' && a.student.id != null ? Number(a.student.id) : null);
    if (sid != null && Number.isFinite(sid) && personId != null && sid !== personId) continue;
    seen.add(id);
    const end = tt.dateOf(a.endDate);
    const reason = typeof a.reason === 'string' ? a.reason : (a.reason && typeof a.reason === 'object' ? a.reason.name || a.reason.longName : '');
    out.push({
      abs_id: id, date, end_date: end && end > date ? end : null,
      t_start: timeOrNull(a.startTime), t_end: timeOrNull(a.endTime),
      reason: str(reason, 80) || null, text: str(a.text, 300) || null, excused: excusedOf(a),
    });
    if (out.length >= 500) break;
  }
  return out;
}

// ─── Fetch ──────────────────────────────────────

/**
 * The absences of the students fetched in one account's cycle (each at most hourly); stores them.
 * Never throws. `state` = the account's extras state (changed in place and returned).
 */
async function fetchAccount(gc, client, acc, fetched, state, cfg, now, deadline = Infinity) {
  try {
    if (!fetched.length) return state;
    if (state.absences && Number(state.absences.until) > now) return state;
    const due = fetched.filter((f) => f.student.absences_at == null || now - f.student.absences_at >= HOUR);
    if (!due.length) return state;
    const { from, to } = windowOf(now, cfg);
    let ok = 0;
    let err = null;
    for (const f of due) {
      if (Date.now() > deadline) break;
      try {
        const raw = await client.absences(from, to, f.student.person_id);
        await store.applyAbsences(gc, f.student.id, absenceRows(raw, f.student.person_id), from, to, now, { baseline: f.student.absences_at == null });
        await store.updateStudent(gc, f.student.id, { absences_at: now });
        ok += 1;
      } catch (e) {
        err = err || e;
        // the next students of the same account would not fare better
        if (!ok || untis.codeOf(e) === 'network') break;
      }
    }
    if (err && !ok) {
      const code = untis.codeOf(err);
      if (code !== 'network') state.absences = { code, until: now + extras.skipFor(code) };
      gc.log.info('absences not fetched', acc.id, code);
    } else if (ok) delete state.absences;
  } catch (e) {
    gc.log.warn('absences failed', acc.id, (e && (e.code || e.message)) || 'error');
  }
  return state;
}

// ─── Who ────────────────────────────────────────

/** May `user` see the absences of `student`? An administrator, the recipients, the child itself. */
function canViewAbsences(student, user) {
  if (!student || !student.enabled || student.missing || !user || !Number.isInteger(user.id)) return false;
  if (user.loggedIn === false || user.kiosk === true) return false;
  if (user.role === 'admin') return true;
  return student.user_id === user.id || student.recipients.includes(user.id);
}

/** Who gets the pushes: the recipients (existing users); the child only with absence_notify_child. */
function recipientsOf(student, users, cfg) {
  const ids = student.recipients.filter((id) => id !== student.user_id);
  if (cfg.absenceNotifyChild && student.user_id != null) ids.unshift(student.user_id);
  return [...new Set(ids.filter((id) => users.has(id)))];
}

// ─── API ────────────────────────────────────────

/** A stored absence → the API shape. */
function absenceView(a) {
  const out = { id: `${a.student_id}-${a.abs_id}`, studentId: a.student_id, date: a.date, start: a.t_start, end: a.t_end };
  if (a.end_date) out.endDate = a.end_date;
  if (a.reason) out.reason = a.reason;
  out.excused = a.excused;
  if (a.text) out.text = a.text;
  return out;
}

/** app/absences: the absences `user` may see of the last `days` days (and ahead), newest first, ≤ `limit`. */
async function listFor(gc, user, days, cfg, now, limit = 200) {
  const students = (await store.listStudents(gc)).filter((s) => canViewAbsences(s, user));
  if (!students.length) return [];
  const since = tz.addDays(tz.localDate(now, cfg.tz), -days);
  return (await store.listAbsences(gc, students.map((s) => s.id), since, limit)).map(absenceView);
}

/** The Schule page / portal: Map studentId → [absenceView] of the school year (≤ 60) for the students `user` may see them of. */
async function forStudents(gc, user, students, cfg, now) {
  const out = new Map();
  const mine = students.filter((s) => canViewAbsences(s, user));
  if (!mine.length) return out;
  const rows = await store.listAbsences(gc, mine.map((s) => s.id), schoolYearStart(tz.localDate(now, cfg.tz)), 500);
  for (const s of mine) out.set(s.id, rows.filter((a) => a.student_id === s.id).slice(0, 60).map(absenceView));
  return out;
}

// ─── Pushes ─────────────────────────────────────

/** "Di 20.10." / "Di 20.10.–Do 22.10." / "Di 20.10. 08:00–09:35" */
function whenOf(a, lang) {
  let s = changes.dayLabel(a.date, lang);
  if (a.end_date) s += `–${changes.dayLabel(a.end_date, lang)}`;
  if (a.t_start) s += ` ${a.t_start}${a.t_end ? `–${a.t_end}` : ''}`;
  return s;
}

const stateWord = (a, lang) => t(lang, a.excused === true ? 'abs.excused' : a.excused === false ? 'abs.unexcused' : 'abs.open');

/** One line of an absence: "Di 20.10. 08:00–09:35 · Krankheit · offen" */
function lineOf(a, lang) {
  return [whenOf(a, lang), a.reason, stateWord(a, lang)].filter(Boolean).join(' · ');
}

/** The push of one student's new / changed absences → { title, body } */
function message(name, list2, lang) {
  if (list2.length === 1) {
    const a = list2[0];
    return { title: `${name}: ${t(lang, `abs.push_${a.change || 'changed'}`)}`, body: [lineOf(a, lang), a.text].filter(Boolean).join(' · ') };
  }
  const lines = list2.slice(0, MAX_LINES).map((a) => `${t(lang, `abs.kind_${a.change || 'changed'}`)}: ${lineOf(a, lang)}`);
  if (list2.length > MAX_LINES) lines.push(t(lang, 'push.more', { n: list2.length - MAX_LINES }));
  return { title: `${name}: ${t(lang, 'abs.push_n', { n: list2.length })}`, body: lines.join('\n') };
}

/** Send (or hold) the new / changed absences: one push per student. → { sent, held, expired } */
async function dispatch(gc, notifier, cfg, now, quiet) {
  const open = await store.absencesWithStatus(gc, quiet ? ['pending'] : ['pending', 'held']);
  if (!open.length) return { sent: 0, held: 0, expired: 0 };
  if (quiet) {
    await store.setAbsenceStatus(gc, open, 'held');
    return { sent: 0, held: open.length, expired: 0 };
  }
  const users = new Set();
  try { for (const u of await gc.users.list()) users.add(u.id); } catch { /* none */ }
  const byStudent = new Map();
  for (const a of open) {
    if (!byStudent.has(a.student_id)) byStudent.set(a.student_id, []);
    byStudent.get(a.student_id).push(a);
  }
  let sent = 0;
  let expired = 0;
  for (const [sid, items] of byStudent) {
    const s = await store.getStudent(gc, sid);
    const stale = items.filter((a) => !s || !s.enabled || s.missing || now - a.changed_at > EXPIRE_MS);
    if (stale.length) { await store.setAbsenceStatus(gc, stale, 'expired'); expired += stale.length; }
    const live = items.filter((a) => !stale.includes(a));
    if (!live.length) continue;
    const to = recipientsOf(s, users, cfg);
    if (!to.length) { await store.setAbsenceStatus(gc, live, 'no_recipients'); continue; }
    // newest first
    live.sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : (a.t_start || '') > (b.t_start || '') ? -1 : 1));
    const { title, body } = message(s.display, live, cfg.lang);
    const r = await notifier.send({
      topic: TOPIC, title: title.slice(0, 120), body: body.slice(0, 1000), priority: 'normal', users: to,
      collapseKey: `schule:abs:${sid}:${live[0].date}`, ttl: 3 * 86400, data: { schule: { studentId: sid, date: live[0].date } },
    });
    if (r.sent) { await store.setAbsenceStatus(gc, live, 'sent', now); sent += 1; } else if (r.error !== 'THROTTLED' && r.error !== 'ERR_RATE_LIMIT') await store.setAbsenceStatus(gc, live, 'failed');
  }
  return { sent, held: 0, expired };
}

module.exports = {
  TOPIC, schoolYearStart, windowOf, keepFrom, excusedOf, absenceRows, fetchAccount, canViewAbsences, recipientsOf, absenceView, listFor, forStudents,
  whenOf, lineOf, message, dispatch,
};
