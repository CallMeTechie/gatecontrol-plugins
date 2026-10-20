'use strict';

// Change detection and the pushes about it.
//
// apply(): a student's freshly fetched lessons are compared with the stored ones of the same
// dates (days before today are stored, never reported). Changes are only looked for on dates the previous fetch covered as well (the first
// fetch after a student was added or enabled only sets the baseline):
//   cancelled  a lesson that is cancelled now and was not before; or a lesson that vanished from
//              WebUntis while its day still has lessons (some schools hide cancelled lessons) —
//              kept as "removed" so the portal still shows it struck through
//   changed    a substitution: another teacher / room / subject (WebUntis orgname), code
//              irregular or a substitution text — new, or different from the stored one
//   extra      a lesson that was not there before on a day that had lessons
//   restored   a cancelled lesson that takes place again (pushed only when its cancellation was)
// A day whose lessons were mostly replaced at once (a timetable re-import, a new timetable
// version) is taken as a new baseline for that day: no extra / removed changes from it.
//
// Every change is written to the change log. It is *pending* (to be pushed) when the lesson lies
// within the next `notify_days` days and has not ended; otherwise only *logged*.
//
// dispatch() (every tick, after the fetches): outside the quiet hours all pending and held
// changes are sent — one push per student, to the student's mapped user and recipients, on the
// topic 'changes', collapse key per student and day; a change whose lesson has ended by then or
// that is no longer true (the lesson is back to normal) expires. Within the quiet hours pending
// changes are held. Nothing is pushed twice: the log row's status says what happened.
//
// 1.1.0: the changes dispatch() releases (pushed now, or held back by the push budget) of a student
// mapped to a GateControl user are also handed to the Familie plugin's rules (server/ruleevents.js) —
// dispatch() answers them as `events`, each change once (changes.rule_at).
//
// 1.2.0: the end of a school day. Its planned end is the end of the day's last lesson of the plan
// (cancelled ones included, extra ones not); its end the end of the last lesson that takes place.
// When a fetch after the baseline changes a lesson of today or tomorrow (a covered, not rebased
// day) and the day's end moves EARLIER than before, the early end is recorded once per student,
// date and new end (table day_ends, only students mapped to a GateControl user, only while the
// planned end lies ahead) — server/dayend.js hands it to the Familie plugin.

const store = require('./store');
const tz = require('./tz');
const tt = require('./timetable');
const notify = require('./notify');
const texts = require('./texts.json');

const TOPIC = 'changes';
const MAX_LINES = 8;

/** The fields a substitution consists of (a change in one of them is a new change). */
function subSig(r) {
  return [r.state, r.subject, r.subject_old, r.teacher, r.teacher_old, r.room, r.room_old, r.subst_text].map((x) => (x == null ? '' : String(x))).join('|');
}

function detailOf(r) {
  const d = {};
  for (const [k, col] of [['subjectLong', 'subject_long'], ['subjectOld', 'subject_old'], ['teacher', 'teacher'], ['teacherOld', 'teacher_old'],
    ['room', 'room'], ['roomOld', 'room_old'], ['substText', 'subst_text'], ['info', 'info']]) if (r[col]) d[k] = r[col];
  return d;
}

/** Lesson end (ms) in the plugin's zone. */
const endMs = (r, cfg) => tz.at(r.date, r.t_end, cfg.tz);

/**
 * Compare `prev` (stored rows within the range) with `next` (normalized fetch) →
 * { rows: what to store, changes: [{ kind, row }] }. `covered(date)` = the previous fetch covered it.
 */
function diff(prev, next, covered) {
  const prevByKey = new Map(prev.map((r) => [r.lkey, r]));
  const nextKeys = new Set(next.map((r) => r.lkey));
  const dates = new Set([...prev.map((r) => r.date), ...next.map((r) => r.date)]);
  const rebased = new Set();
  const nextCount = new Map();
  for (const r of next) nextCount.set(r.date, (nextCount.get(r.date) || 0) + 1);
  for (const d of dates) {
    const p = prev.filter((r) => r.date === d && !r.removed);
    const n = next.filter((r) => r.date === d);
    const added = n.filter((r) => !prevByKey.has(r.lkey)).length;
    const gone = p.filter((r) => !nextKeys.has(r.lkey)).length;
    if (!covered(d) || !p.length || !n.length || added + gone > Math.max(4, p.length)) rebased.add(d);
  }
  const rows = [];
  const changes = [];
  for (const r of next) {
    const p = prevByKey.get(r.lkey);
    const row = { ...r, added: false, removed: false };
    if (p && !covered(r.date)) {
      row.added = false; // a new baseline for this day
    } else if (p) {
      row.added = !!p.added;
      const wasCancelled = p.state === 'cancelled' || p.removed;
      if (r.state === 'cancelled' && !wasCancelled) changes.push({ kind: 'cancelled', row });
      else if (r.state !== 'cancelled' && wasCancelled) changes.push({ kind: 'restored', row });
      else if (r.state === 'changed' && subSig(r) !== subSig(p)) changes.push({ kind: 'changed', row });
    } else if (!rebased.has(r.date)) {
      row.added = r.state !== 'cancelled';
      changes.push({ kind: r.state === 'cancelled' ? 'cancelled' : 'extra', row });
    }
    rows.push(row);
  }
  for (const p of prev) {
    if (nextKeys.has(p.lkey) || rebased.has(p.date) || !nextCount.get(p.date)) continue;
    // vanished on a day that still has lessons: kept as cancelled ("entfällt")
    const row = { ...p, removed: true };
    rows.push(row);
    if (!p.removed && p.state !== 'cancelled') changes.push({ kind: 'cancelled', row });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.t_start < b.t_start ? -1 : a.t_start > b.t_start ? 1 : 0));
  return { rows, changes, rebased };
}

/** The end of a date: the end of its last lesson that takes place (null: none takes place). */
function endOf(rows, date) {
  let e = null;
  for (const r of rows) if (r.date === date && tt.shownState(r) !== 'cancelled' && (!e || r.t_end > e)) e = r.t_end;
  return e;
}

/** The planned end of a date: the end of its last lesson of the plan — cancelled ones too, extra ones not. */
function plannedEndOf(rows, date) {
  let e = null;
  for (const r of rows) if (r.date === date && !r.added && (!e || r.t_end > e)) e = r.t_end;
  return e;
}

/**
 * Early ends found by one fetch → [{ date, plannedEnd, newEnd }]: on `dates` (today, tomorrow) the
 * previous fetch covered, not rebased, with a change found now, whose end moved earlier and whose
 * planned end has not passed.
 */
function earlyEnds(prev, rows, found, { dates, covered, rebased, now, cfg }) {
  const out = [];
  for (const date of dates) {
    if (!covered(date) || rebased.has(date) || !found.some((c) => c.row.date === date)) continue;
    const before = endOf(prev, date);
    const after = endOf(rows, date);
    const planned = plannedEndOf(rows, date);
    if (!before || !after || !planned || after >= before || after >= planned) continue;
    if (tz.at(date, planned, cfg.tz) <= now) continue;
    out.push({ date, plannedEnd: planned, newEnd: after });
  }
  return out;
}

/**
 * Store a student's fetch (`rows` normalized, covering [from, to]) and log what changed.
 * → { changes: number, pending: number, baseline: boolean, dayEnds: number (1.2.0: early ends recorded) }
 */
async function apply(gc, student, rows, range, cfg, now) {
  const prev = await store.lessonsBetween(gc, [student.id], range.from, range.to);
  const baseline = !student.baseline_done;
  const covered = (d) => !baseline && student.range_from != null && d >= student.range_from && d <= student.range_to;
  const { rows: keep, changes, rebased } = diff(prev, rows, covered);
  await store.replaceLessons(gc, student.id, range.from, range.to, keep);
  const today = tz.localDate(now, cfg.tz);
  // 1.2.0: the school day ends earlier (today, tomorrow) — for the Familie plugin's rides
  let dayEnds = 0;
  if (!baseline && student.user_id != null) {
    for (const e of earlyEnds(prev, keep, changes, { dates: [today, tz.addDays(today, 1)], covered, rebased, now, cfg })) {
      if (await store.addDayEnd(gc, student.id, e, now)) dayEnds += 1;
    }
  }
  const lastDay = tz.addDays(today, cfg.notifyDays - 1);
  // days already past are only stored, not reported
  const log = changes.filter(({ row }) => row.date >= today).map(({ kind, row }) => ({
    lkey: row.lkey, date: row.date, t_start: row.t_start, t_end: row.t_end, period: row.period, kind, subject: row.subject,
    detail: detailOf(row),
    status: row.date >= today && row.date <= lastDay && endMs(row, cfg) > now ? 'pending' : 'logged',
  }));
  await store.addChanges(gc, student.id, log, now);
  const patch = { baseline_done: true, range_from: range.from, range_to: range.to, last_fetch_at: now, last_error: null };
  const klasse = tt.mainKlasse(rows);
  if (klasse) patch.klasse = klasse;
  if (log.length) patch.last_change_at = now;
  await store.updateStudent(gc, student.id, patch);
  return { changes: log.length, pending: log.filter((c) => c.status === 'pending').length, baseline, dayEnds };
}

// ─── Texts ──────────────────────────────────────

function t(lang, key, params) { return notify.fmt(texts, lang, key, params); }

const WD = { de: ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'], en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] };

/** "Di 21.10." / "Tue 21/10" */
function dayLabel(date, lang) {
  const p = tz.parseDate(date);
  const wd = WD[lang === 'en' ? 'en' : 'de'][tz.weekday(date)];
  return lang === 'en' ? `${wd} ${tz.pad(p.d)}/${tz.pad(p.m)}` : `${wd} ${tz.pad(p.d)}.${tz.pad(p.m)}.`;
}

/** "3. Std." / "3.–4. Std." / "3rd lesson" (null without a period) */
function periodLabel(period, periodEnd, lang) {
  if (period == null) return null;
  if (lang === 'en') return periodEnd ? t(lang, 'push.periods', { a: period, b: periodEnd }) : t(lang, 'push.period', { n: period });
  return periodEnd ? `${period}.–${periodEnd}. Std.` : `${period}. Std.`;
}

/** One change as a short phrase: "Mathe fällt aus" / "Mathe: Vertretung SCH statt MUE" … */
function phrase(c, lang) {
  const d = c.detail || {};
  const subject = (d.subjectLong && d.subjectLong.length <= 24 ? d.subjectLong : c.subject) || d.subjectLong || t(lang, 'push.lesson');
  if (c.kind === 'cancelled') return t(lang, 'push.cancelled', { subject });
  if (c.kind === 'restored') return t(lang, 'push.restored', { subject });
  if (c.kind === 'extra') return t(lang, 'push.extra', { subject });
  return t(lang, 'push.changed', { subject });
}

/** What changed in a substitution: "SCH statt MUE · Raum 104 statt 201 · <text>" */
function changeFacts(c, lang) {
  const d = c.detail || {};
  const out = [];
  if (d.subjectOld) out.push(t(lang, 'push.instead', { now: c.subject || '–', old: d.subjectOld }));
  if (d.teacherOld) out.push(t(lang, 'push.teacher_instead', { now: d.teacher || '–', old: d.teacherOld }));
  if (d.roomOld) out.push(t(lang, 'push.room_instead', { now: d.room || '–', old: d.roomOld }));
  if (d.substText) out.push(d.substText);
  else if (d.info && c.kind !== 'restored') out.push(d.info);
  return out;
}

/** "Di 21.10. · 3. Std. 09:35" */
function whenLine(c, lang) {
  return [dayLabel(c.date, lang), [periodLabel(c.period, null, lang), c.t_start].filter(Boolean).join(' ')].join(' · ');
}

/** The push of one student's changes → { title, body } */
function message(name, list, lang) {
  if (list.length === 1) {
    const c = list[0];
    return { title: `${name}: ${phrase(c, lang)}`, body: [whenLine(c, lang), ...changeFacts(c, lang)].join(' · ') };
  }
  const lines = list.slice(0, MAX_LINES).map((c) => {
    const facts = changeFacts(c, lang);
    return `${dayLabel(c.date, lang)} ${[periodLabel(c.period, null, lang), c.t_start].filter(Boolean).join(' ')}: ${phrase(c, lang)}${facts.length ? ` (${facts.join(', ')})` : ''}`;
  });
  if (list.length > MAX_LINES) lines.push(t(lang, 'push.more', { n: list.length - MAX_LINES }));
  return { title: `${name}: ${t(lang, 'push.n_changes', { n: list.length })}`, body: lines.join('\n') };
}

// ─── Dispatch ───────────────────────────────────

/** Who gets a student's pushes: the mapped user and the recipients that exist. */
function recipientsOf(student, users) {
  return [...new Set([student.user_id, ...student.recipients].filter((id) => id != null && users.has(id)))];
}

/** Is the change still true (the stored lesson still looks like it)? */
function stillTrue(c, lesson) {
  if (!lesson) return false;
  const st = tt.shownState(lesson);
  if (c.kind === 'cancelled') return st === 'cancelled';
  if (c.kind === 'restored') return st !== 'cancelled';
  if (c.kind === 'extra') return st === 'extra';
  return st === 'changed' || st === 'extra';
}

/**
 * Send (or hold) the pending changes. → { sent: number of pushes, held, expired, events: [{ change, student }] }
 * events (1.1.0): the released changes of students with a GateControl user, not handed to the rules before.
 */
async function dispatch(gc, notifier, cfg, now, quiet) {
  const open = await store.changesWithStatus(gc, quiet ? ['pending'] : ['pending', 'held']);
  if (!open.length) return { sent: 0, held: 0, expired: 0, events: [] };
  if (quiet) {
    await store.setChangeStatus(gc, open.map((c) => c.id), 'held');
    return { sent: 0, held: open.length, expired: 0, events: [] };
  }
  const events = [];
  const users = new Set();
  try { for (const u of await gc.users.list()) users.add(u.id); } catch { /* none */ }
  const byStudent = new Map();
  for (const c of open) {
    if (!byStudent.has(c.student_id)) byStudent.set(c.student_id, []);
    byStudent.get(c.student_id).push(c);
  }
  let sent = 0;
  let expired = 0;
  for (const [sid, list] of byStudent) {
    const student = await store.getStudent(gc, sid);
    if (!student || !student.enabled) { await store.setChangeStatus(gc, list.map((c) => c.id), 'expired'); expired += list.length; continue; }
    const dates = [...new Set(list.map((c) => c.date))].sort();
    const lessons = await store.lessonsBetween(gc, [sid], dates[0], dates[dates.length - 1]);
    const byKey = new Map(lessons.map((l) => [l.lkey, l]));
    // the newest change per lesson wins; ended or no longer true → expired
    const latest = new Map();
    for (const c of list) latest.set(c.lkey, c);
    const live = [];
    const dead = [];
    for (const c of list) {
      let ok = latest.get(c.lkey) === c && endMs(c, cfg) > now && stillTrue(c, byKey.get(c.lkey));
      // "takes place after all" only for someone who was told it would not
      if (ok && c.kind === 'restored') ok = await store.cancellationSent(gc, sid, c.lkey, c.id);
      (ok ? live : dead).push(c);
    }
    if (dead.length) { await store.setChangeStatus(gc, dead.map((c) => c.id), 'expired'); expired += dead.length; }
    if (!live.length) continue;
    // the same changes as the push, for the rules of the Familie plugin (only a student mapped to a user)
    if (student.user_id != null) for (const c of live) if (c.rule_at == null) events.push({ change: c, student });
    const to = recipientsOf(student, users);
    if (!to.length) { await store.setChangeStatus(gc, live.map((c) => c.id), 'no_recipients'); continue; }
    live.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.t_start < b.t_start ? -1 : a.t_start > b.t_start ? 1 : 0));
    const { title, body } = message(student.display, live, cfg.lang);
    const r = await notifier.send({
      topic: TOPIC, title: title.slice(0, 120), body: body.slice(0, 1000), priority: 'normal', users: to,
      collapseKey: `schule:${sid}:${live[0].date}`, ttl: 2 * 86400,
      data: { schule: { studentId: sid, date: live[0].date } },
    });
    if (r.sent) {
      await store.setChangeStatus(gc, live.map((c) => c.id), 'sent', now);
      sent += 1;
    } else if (r.error === 'THROTTLED' || r.error === 'ERR_RATE_LIMIT') {
      // budget used up: stays pending for the next tick (expires once the lesson is over)
    } else {
      await store.setChangeStatus(gc, live.map((c) => c.id), 'failed');
    }
  }
  return { sent, held: 0, expired, events };
}

module.exports = {
  diff, apply, dispatch, message, phrase, dayLabel, periodLabel, changeFacts, recipientsOf, subSig, endMs, endOf, plannedEndOf, earlyEnds, TOPIC,
};
