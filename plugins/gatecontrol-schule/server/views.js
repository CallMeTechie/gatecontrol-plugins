'use strict';

// Who sees which student, and what the portal, the apps, the Start tiles and the quick actions
// get. Everything here answers only with the students the viewer may see:
//   * a student must be enabled (and still listed by its account);
//   * an administrator sees every student;
//   * a person sees the students mapped to them and those they are a recipient of;
//   * a kiosk device (wall tablet, user.kiosk) sees exactly the students with
//     "Am Wand-Tablet zeigen" — whoever its account is;
//   * a portal viewer only recognised by device trust (loggedIn false) sees nothing: a child's
//     timetable says where the child is.
//
// 1.2.0: each day of the timetable carries the homework due that day and the day's exams (omitted
// when empty); the tile and the widget name tomorrow's exam; school_day (service for the Familie
// plugin's wall tablet) — one line per student shown on the wall.
// 1.3.0: every student carries its face (server/colors.js): `color` '#RRGGBB' and, when the mapped
// GateControl user has a profile picture, `avatarUrl` — in app/timetable, the portal, school_day and
// the overview of the Schule page (overview(): the week, the coming changes, exams and homework).

const store = require('./store');
const tz = require('./tz');
const tt = require('./timetable');
const changes = require('./changes');
const texts = require('./texts.json');
const notify = require('./notify');
const colors = require('./colors');

function t(lang, key, params) { return notify.fmt(texts, lang, key, params); }

const ICON_CAL = 'M4 5h16v15H4zM4 10h16M8 3v4M16 3v4';
const ICON_X = 'M6 6l12 12M18 6L6 18';
const ICON_SWAP = 'M4 8h13l-3-3M20 16H7l3 3';
const ICON_PLUS = 'M12 5v14M5 12h14';
const ICON_CHECK = 'M5 12l5 5 9-10';
const ICON_EXAM = 'M9 4h6v3H9zM6 6h12v15H6zM9 12h6M9 16h4';
const ICON_MAIL = 'M4 6h16v12H4zM4 7l8 6 8-6';

/** May `user` see `student`? */
function canView(student, user) {
  if (!student || !student.enabled || student.missing || !user || !Number.isInteger(user.id)) return false;
  if (user.loggedIn === false) return false;
  if (user.kiosk === true) return student.show_on_wall;
  if (user.role === 'admin') return true;
  return student.user_id === user.id || student.recipients.includes(user.id);
}

async function visibleStudents(gc, user) {
  return (await store.listStudents(gc)).filter((s) => canView(s, user));
}

/** 1.3.0: the GateControl users with their faces (Map id → colors.userFace()); empty without gc.users. */
async function usersMap(gc) {
  const m = new Map();
  try {
    for (const u of await gc.users.list()) {
      const f = colors.userFace(u);
      if (f && Number.isSafeInteger(f.id)) m.set(f.id, f);
    }
  } catch { /* users unavailable */ }
  return m;
}

/** 1.3.0: { color, avatarUrl? } of a student for the APIs (avatarUrl only when there is a picture). */
function faceFields(student, users) {
  const f = colors.faceOf(student, users);
  return f.avatarUrl ? { color: f.color, avatarUrl: f.avatarUrl } : { color: f.color };
}

const clip = (s, n) => {
  const v = String(s == null ? '' : s).replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  return v.length > n ? v.slice(0, Math.max(1, n - 1)).trimEnd() + '…' : v;
};

/** A stored lesson → the shape of the API (app and portal). */
function lessonView(l) {
  const out = {
    start: l.t_start, end: l.t_end, subject: l.subject, subjectLong: l.subject_long, teacher: l.teacher, room: l.room, state: tt.shownState(l),
  };
  if (l.period != null) out.period = l.period;
  if (l.period_end != null) out.periodEnd = l.period_end;
  if (l.subject_old) out.subjectOld = l.subject_old;
  if (l.teacher_old) out.teacherOld = l.teacher_old;
  if (l.room_old) out.roomOld = l.room_old;
  if (l.info) out.info = l.info;
  if (l.subst_text) out.substText = l.subst_text;
  if (l.lstext) out.text = l.lstext;
  return out;
}

/** A stored homework → the API shape { subject, subjectLong?, text, givenDate?, completed?: true }. */
function homeworkView(h) {
  const out = { subject: h.subject, text: h.text };
  if (h.subject_long && h.subject_long !== h.subject) out.subjectLong = h.subject_long;
  if (h.given_date) out.givenDate = h.given_date;
  if (h.completed) out.completed = true;
  return out;
}

/** A stored exam → the API shape { subject, subjectLong?, name, start?, end?, type?, text? }. */
function examView(x) {
  const out = { subject: x.subject, name: x.name };
  if (x.subject_long && x.subject_long !== x.subject) out.subjectLong = x.subject_long;
  if (x.t_start) out.start = x.t_start;
  if (x.t_end) out.end = x.t_end;
  if (x.type) out.type = x.type;
  if (x.text) out.text = x.text;
  return out;
}

/**
 * The timetable of some students between two dates:
 * [{ id, name, userId, klasse, updatedAt, days: [{ date, holiday?, lessons: [...], homework?: [...], exams?: [...] }] }]
 * `days` lists every date of the range (also those without lessons). homework (due that day) and
 * exams (1.2.0) only when there are any.
 */
async function timetableOf(gc, students, from, to, opts = {}) {
  const accounts = new Map((await store.listAccounts(gc)).map((a) => [a.id, a]));
  const users = opts.users || await usersMap(gc);
  const ids = students.map((s) => s.id);
  const lessons = await store.lessonsBetween(gc, ids, from, to);
  const homework = await store.homeworkDue(gc, ids, from, to);
  const exams = await store.examsBetween(gc, ids, from, to);
  const dates = [];
  for (let d = from; d <= to; d = tz.addDays(d, 1)) dates.push(d);
  return students.map((s) => {
    const acc = accounts.get(s.account_id);
    const mine = lessons.filter((l) => l.student_id === s.id);
    const days = dates.filter((d) => !opts.weekdays || tz.weekday(d) !== 0).map((date) => {
      const day = { date };
      const h = acc ? tt.holidayOn(acc.holidays, date) : null;
      if (h) day.holiday = h;
      day.lessons = mine.filter((l) => l.date === date).map(lessonView);
      const hw = homework.filter((h) => h.student_id === s.id && h.due_date === date);
      if (hw.length) day.homework = hw.map(homeworkView);
      const ex = exams.filter((x) => x.student_id === s.id && x.date === date);
      if (ex.length) day.exams = ex.map(examView);
      return day;
    });
    return { id: s.id, name: s.display, userId: s.user_id, klasse: s.klasse || null, ...faceFields(s, users), updatedAt: s.last_fetch_at, days };
  });
}

/** Today's (and tomorrow's) picture of a student: { today: { lessons, cancelled, changed, holiday, exams }, tomorrow: {…}, next } */
async function summary(gc, student, cfg, now) {
  const today = tz.localDate(now, cfg.tz);
  const tomorrow = tz.addDays(today, 1);
  const acc = await store.getAccount(gc, student.account_id);
  const lessons = await store.lessonsBetween(gc, [student.id], today, tomorrow);
  const exams = await store.examsBetween(gc, [student.id], today, tomorrow);
  const part = (date) => {
    const ls = lessons.filter((l) => l.date === date);
    const st = ls.map((l) => ({ l, s: tt.shownState(l) }));
    return {
      date, lessons: ls.length, holiday: acc ? tt.holidayOn(acc.holidays, date) : null,
      cancelled: st.filter((x) => x.s === 'cancelled').length,
      changed: st.filter((x) => x.s === 'changed' || x.s === 'extra').length,
      special: st.filter((x) => x.s !== 'normal'),
      exams: exams.filter((x) => x.date === date),
    };
  };
  const a = part(today);
  const b = part(tomorrow);
  // the next change that has not ended yet
  const next = [...a.special, ...b.special].find((x) => tz.at(x.l.date, x.l.t_end, cfg.tz) > now) || null;
  return { today: a, tomorrow: b, next };
}

const KIND_OF = { cancelled: 'cancelled', changed: 'changed', extra: 'extra' };

/** "Mathe fällt aus" for a shown state. */
function stateText(lang, l, s) {
  const c = { kind: KIND_OF[s] || 'changed', subject: l.subject, detail: { subjectLong: l.subject_long } };
  return changes.phrase(c, lang);
}

/** The subject of an exam within `max` characters: the long name when it fits, else the short one. */
function examSubject(x, max) {
  if (x.subject_long && x.subject_long.length <= max) return x.subject_long;
  return clip(x.subject || x.subject_long || x.name || '–', max);
}

/**
 * Start tile of a student (value ≤ 24 characters, ≤ 4 items; 1.2.0: an item for tomorrow's exam; 1.4.0:
 * „1 neue Nachricht“ when sum.newMessages (new messages of its inbox the viewer may read) has some).
 */
function tileOf(student, sum, lang) {
  const a = sum.today;
  let value;
  let state = null;
  if (a.cancelled) {
    value = a.cancelled === 1 ? t(lang, 'tile.one_cancelled') : t(lang, 'tile.cancelled', { n: a.cancelled });
    if (a.changed) {
      const more = `${value} · ${t(lang, 'tile.plus_changed', { n: a.changed })}`;
      if (more.length <= 24) value = more;
    }
    state = 'warn';
  } else if (a.changed) {
    value = a.changed === 1 ? t(lang, 'tile.one_changed') : t(lang, 'tile.changed', { n: a.changed });
    state = 'warn';
  } else if (a.lessons) {
    value = t(lang, 'tile.normal');
    state = 'good';
  } else value = a.holiday ? t(lang, 'tile.holiday') : t(lang, 'tile.free');
  const items = [];
  const exam = (sum.tomorrow.exams || [])[0];
  const news = Array.isArray(sum.newMessages) ? sum.newMessages : [];
  const room = 4 - (exam ? 1 : 0) - (news.length ? 1 : 0);
  for (const [part, label] of [[sum.today, t(lang, 'tile.today')], [sum.tomorrow, t(lang, 'tile.tomorrow')]]) {
    for (const x of part.special) {
      if (items.length >= room) break;
      const p = x.l.period != null ? t(lang, 'tile.period', { n: x.l.period }) : x.l.t_start;
      items.push({
        label: clip(`${label} · ${p}`, 20), value: clip((x.l.subject_long && x.l.subject_long.length <= 16 ? x.l.subject_long : x.l.subject) || '–', 16),
        icon: x.s === 'cancelled' ? ICON_X : x.s === 'extra' ? ICON_PLUS : ICON_SWAP,
        state: x.s === 'cancelled' ? 'crit' : 'warn',
      });
    }
  }
  // „Morgen · Arbeit: Mathematik“
  // „1 neue Nachricht · Elternabend“
  if (news.length) {
    items.push({
      label: clip(news.length === 1 ? t(lang, 'tile.one_message') : t(lang, 'tile.messages', { n: news.length }), 20),
      value: clip(news[0].subject || news[0].sender || '–', 16), icon: ICON_MAIL,
    });
  }
  if (exam) items.push({ label: clip(t(lang, 'tile.exam_tomorrow'), 20), value: examSubject(exam, 16), icon: ICON_EXAM, state: 'warn' });
  return { title: clip(`${t(lang, 'tile.title')} · ${student.display}`, 60), value: clip(value, 24), state, icon: ICON_CAL, items };
}

/** The status line of the widget: the next change, else "Planmäßig" / "Frei". */
function statusOf(sum, lang, cfg) {
  if (sum.next) {
    const l = sum.next.l;
    const day = l.date === sum.today.date ? t(lang, 'tile.today') : t(lang, 'tile.tomorrow');
    const p = l.period != null ? t(lang, 'tile.period', { n: l.period }) : l.t_start;
    return clip(`${day} ${p}: ${stateText(lang, l, sum.next.s)}`, 60);
  }
  if (sum.today.lessons) return t(lang, 'tile.normal');
  return sum.today.holiday ? t(lang, 'tile.holiday') : t(lang, 'tile.free');
}

/** The widget's readings: 'tomorrow' (cancellations), 1.2.0 'exam' (tomorrow's exam, only when there is one). */
function readingsOf(sum, lang) {
  const out = [{ id: 'tomorrow', label: clip(t(lang, 'qa.tomorrow'), 20), value: sum.tomorrow.cancelled, icon: sum.tomorrow.cancelled ? ICON_X : ICON_CHECK }];
  const exam = (sum.tomorrow.exams || [])[0];
  if (exam) out.push({ id: 'exam', label: clip(t(lang, 'qa.exam_tomorrow'), 20), value: examSubject(exam, 16), icon: ICON_EXAM, state: 'warn' });
  return out;
}

/**
 * The service school_day (1.2.0, caller gatecontrol-familie: its wall tablet): { date } → the day of
 * every student shown on the wall ("Am Wand-Tablet zeigen") that is mapped to a GateControl user:
 * { ok, date, students: [{ userId, name, start?, end?, cancelled, changed, holiday?, exams: [{ subject, name }], free }] }
 * start / end: the first / last lesson that takes place; free: none takes place. A date must lie
 * within today − 1 … today + 13; students whose last fetch did not cover it are left out.
 */
async function schoolDay(gc, cfg, payload, now) {
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const date = typeof p.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.date) && tz.parseDate(p.date) ? p.date : null;
  const today = tz.localDate(now, cfg.tz);
  if (!date || date < tz.addDays(today, -1) || date > tz.addDays(today, 13)) return { ok: false, code: 'invalid' };
  const students = (await store.listStudents(gc)).filter((s) => s.enabled && !s.missing && s.show_on_wall && s.user_id != null
    && s.range_from && s.range_from <= date && s.range_to >= date).slice(0, 20);
  const ids = students.map((s) => s.id);
  const accounts = new Map((await store.listAccounts(gc)).map((a) => [a.id, a]));
  const lessons = await store.lessonsBetween(gc, ids, date, date);
  const exams = await store.examsBetween(gc, ids, date, date);
  const users = await usersMap(gc);
  const out = students.map((s) => {
    const st = lessons.filter((l) => l.student_id === s.id).map((l) => ({ l, s: tt.shownState(l) }));
    const on = st.filter((x) => x.s !== 'cancelled');
    const acc = accounts.get(s.account_id);
    const holiday = acc ? tt.holidayOn(acc.holidays, date) : null;
    // 1.3.0: the child's colour (and picture) for the wall
    const v = { userId: s.user_id, name: clip(s.display, 40), ...faceFields(s, users) };
    if (on.length) {
      v.start = on.reduce((a, x) => (x.l.t_start < a ? x.l.t_start : a), on[0].l.t_start);
      v.end = on.reduce((a, x) => (x.l.t_end > a ? x.l.t_end : a), on[0].l.t_end);
    }
    v.cancelled = st.filter((x) => x.s === 'cancelled').length;
    v.changed = st.filter((x) => x.s === 'changed' || x.s === 'extra').length;
    if (holiday) v.holiday = clip(holiday, 60);
    v.exams = exams.filter((x) => x.student_id === s.id).slice(0, 4).map((x) => ({ subject: clip(x.subject_long && x.subject_long.length <= 24 ? x.subject_long : x.subject, 40), name: clip(x.name, 60) }));
    v.free = !on.length;
    return v;
  });
  return { ok: true, date, students: out };
}

/**
 * Quick action of a student (display only): id 'student:<id>', a widget whose value is today's
 * cancellations and whose reading 'tomorrow' is tomorrow's — so rules of other plugins (Familie)
 * can use 'gatecontrol-schule/student:<id>' with the field 'value' or 'reading:tomorrow'.
 */
function quickActionOf(student, sum, lang, cfg) {
  const name = clip(student.display, 40);
  const special = sum.today.cancelled + sum.today.changed;
  return {
    id: `student:${student.id}`,
    title: name,
    subtitle: clip(t(lang, 'qa.subtitle'), 60),
    icon: ICON_CAL,
    kind: 'button',
    device: { id: `student:${student.id}`, title: name, subtitle: clip(t(lang, 'qa.subtitle'), 60), icon: ICON_CAL },
    widget: {
      label: clip(student.display, 24),
      icon: ICON_CAL,
      value: sum.today.cancelled,
      status: clip(statusOf(sum, lang, cfg), 60),
      state: sum.today.cancelled ? 'warn' : (special ? 'warn' : 'good'),
      readings: readingsOf(sum, lang),
      power: false,
    },
  };
}

/**
 * 1.3.0: what the Schule page and the portal tab show of some students for one week (Mon–Sat):
 * per student its face, the week (timetableOf), the coming changes (lessons from now on that do not
 * take place as planned, ≤ 30), the exams and the homework due of the next 14 days.
 * → { today, week, from, to, students: [{ id, name, klasse, color, avatarUrl?, initials, updatedAt,
 *      days, changes: [lessonView + date], exams: [examView + date], homework: [homeworkView + date] }] }
 */
async function overview(gc, cfg, students, week, now) {
  const today = tz.localDate(now, cfg.tz);
  const from = tz.addDays(tz.weekStart(today), 7 * (week === 1 ? 1 : 0));
  const to = tz.addDays(from, 5);
  const users = await usersMap(gc);
  const list = await timetableOf(gc, students, from, to, { users });
  const ids = students.map((s) => s.id);
  const until = tz.addDays(today, 13);
  const lessons = await store.lessonsBetween(gc, ids, today, until);
  const exams = await store.examsBetween(gc, ids, today, until);
  const homework = await store.homeworkDue(gc, ids, today, until);
  const byId = new Map(students.map((s) => [s.id, s]));
  return {
    today, week: week === 1 ? 1 : 0, from, to,
    students: list.map((x) => {
      const s = byId.get(x.id);
      const changes = lessons.filter((l) => l.student_id === x.id && tt.shownState(l) !== 'normal' && tz.at(l.date, l.t_end, cfg.tz) > now)
        .slice(0, 30).map((l) => ({ date: l.date, ...lessonView(l) }));
      return {
        ...x, initials: colors.faceOf(s, users).initials,
        changes,
        exams: exams.filter((e) => e.student_id === x.id).slice(0, 30).map((e) => ({ date: e.date, ...examView(e) })),
        homework: homework.filter((h) => h.student_id === x.id).sort((a, b) => Number(a.completed) - Number(b.completed) || (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0))
          .slice(0, 40).map((h) => ({ date: h.due_date, ...homeworkView(h) })),
      };
    }),
  };
}

module.exports = {
  usersMap, faceFields, overview,
  canView, visibleStudents, lessonView, homeworkView, examView, timetableOf, summary, tileOf, quickActionOf, statusOf, readingsOf, examSubject, schoolDay, clip, ICON_CAL,
};
