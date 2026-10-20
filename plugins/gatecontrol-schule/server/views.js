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

const store = require('./store');
const tz = require('./tz');
const tt = require('./timetable');
const changes = require('./changes');
const texts = require('./texts.json');
const notify = require('./notify');

function t(lang, key, params) { return notify.fmt(texts, lang, key, params); }

const ICON_CAL = 'M4 5h16v15H4zM4 10h16M8 3v4M16 3v4';
const ICON_X = 'M6 6l12 12M18 6L6 18';
const ICON_SWAP = 'M4 8h13l-3-3M20 16H7l3 3';
const ICON_PLUS = 'M12 5v14M5 12h14';
const ICON_CHECK = 'M5 12l5 5 9-10';

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

/**
 * The timetable of some students between two dates:
 * [{ id, name, userId, klasse, updatedAt, days: [{ date, holiday?, lessons: [...] }] }]
 * `days` lists every date of the range (also those without lessons).
 */
async function timetableOf(gc, students, from, to, opts = {}) {
  const accounts = new Map((await store.listAccounts(gc)).map((a) => [a.id, a]));
  const lessons = await store.lessonsBetween(gc, students.map((s) => s.id), from, to);
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
      return day;
    });
    return { id: s.id, name: s.display, userId: s.user_id, klasse: s.klasse || null, updatedAt: s.last_fetch_at, days };
  });
}

/** Today's (and tomorrow's) picture of a student: { today: { lessons, cancelled, changed, holiday }, tomorrow: {…}, next } */
async function summary(gc, student, cfg, now) {
  const today = tz.localDate(now, cfg.tz);
  const tomorrow = tz.addDays(today, 1);
  const acc = await store.getAccount(gc, student.account_id);
  const lessons = await store.lessonsBetween(gc, [student.id], today, tomorrow);
  const part = (date) => {
    const ls = lessons.filter((l) => l.date === date);
    const st = ls.map((l) => ({ l, s: tt.shownState(l) }));
    return {
      date, lessons: ls.length, holiday: acc ? tt.holidayOn(acc.holidays, date) : null,
      cancelled: st.filter((x) => x.s === 'cancelled').length,
      changed: st.filter((x) => x.s === 'changed' || x.s === 'extra').length,
      special: st.filter((x) => x.s !== 'normal'),
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

/** Start tile of a student (value ≤ 24 characters, ≤ 4 items). */
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
  for (const [part, label] of [[sum.today, t(lang, 'tile.today')], [sum.tomorrow, t(lang, 'tile.tomorrow')]]) {
    for (const x of part.special) {
      if (items.length >= 4) break;
      const p = x.l.period != null ? t(lang, 'tile.period', { n: x.l.period }) : x.l.t_start;
      items.push({
        label: clip(`${label} · ${p}`, 20), value: clip((x.l.subject_long && x.l.subject_long.length <= 16 ? x.l.subject_long : x.l.subject) || '–', 16),
        icon: x.s === 'cancelled' ? ICON_X : x.s === 'extra' ? ICON_PLUS : ICON_SWAP,
        state: x.s === 'cancelled' ? 'crit' : 'warn',
      });
    }
  }
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
      readings: [{ id: 'tomorrow', label: clip(t(lang, 'qa.tomorrow'), 20), value: sum.tomorrow.cancelled, icon: sum.tomorrow.cancelled ? ICON_X : ICON_CHECK }],
      power: false,
    },
  };
}

module.exports = { canView, visibleStudents, lessonView, timetableOf, summary, tileOf, quickActionOf, statusOf, clip, ICON_CAL };
