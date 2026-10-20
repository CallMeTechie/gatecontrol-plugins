'use strict';

// The evening reminder (1.2.0): from `reminder_time` (default 18:00, the school's time zone) until
// midnight, the day before, per student and topic ONE push to the same people as the change pushes
// (the mapped child and the recipients):
//
//   topic 'exams'     („Klassenarbeiten“)  tomorrow's exams — „Lena: morgen Mathe-Arbeit (3. Std.)“,
//                                          several: „Lena: morgen 2 Arbeiten“ with a line each
//   topic 'homework'  („Hausaufgaben“)     homework due tomorrow that is not done —
//                                          „Lena: 2 Hausaufgaben für morgen“ with a line each
//
// Never twice for the same student, day and topic (table notices, also across restarts); nothing
// in the quiet hours (a reminder held by them goes when they end, the same evening only); a full
// push budget tries again in the next tick. Without exams / homework for tomorrow nothing is sent
// (an exam that appears later that evening is still reminded of).

const store = require('./store');
const tz = require('./tz');
const tt = require('./timetable');
const changes = require('./changes');
const notify = require('./notify');
const texts = require('./texts.json');

const MAX_LINES = 6;

const t = (lang, key, params) => notify.fmt(texts, lang, key, params);

/** The subject as the pushes name it: the long name when short, else the short one. */
function subjectName(x, lang) {
  const long = x.subject_long;
  return (long && long.length <= 24 ? long : x.subject) || long || t(lang, 'push.lesson');
}

/** "Mathe-Arbeit" / "Maths exam" */
function examLabel(x, lang) {
  return t(lang, 'remind.exam', { subject: subjectName(x, lang) });
}

/** " (3. Std.)" / " (09:50)" / "" */
function examWhen(x, grid, lang) {
  if (!x.t_start) return '';
  const { period, periodEnd } = tt.periodOf(grid, x.date, x.t_start, x.t_end || '');
  return ` (${changes.periodLabel(period, periodEnd, lang) || x.t_start})`;
}

/** Tomorrow's exams of a student → { title, body } */
function examMessage(name, exams, grid, lang) {
  if (exams.length === 1) {
    const x = exams[0];
    return {
      title: t(lang, 'remind.exam_one', { name, exam: examLabel(x, lang), when: examWhen(x, grid, lang) }),
      body: [x.name, x.text].filter(Boolean).join(' · '),
    };
  }
  const lines = exams.slice(0, MAX_LINES).map((x) => `${examLabel(x, lang)}${examWhen(x, grid, lang)}${x.name ? ` – ${x.name}` : ''}`);
  if (exams.length > MAX_LINES) lines.push(t(lang, 'push.more', { n: exams.length - MAX_LINES }));
  return { title: t(lang, 'remind.exams_n', { name, n: exams.length }), body: lines.join('\n') };
}

/** Homework due tomorrow → { title, body } */
function homeworkMessage(name, list, lang) {
  const lines = list.slice(0, MAX_LINES).map((h) => `${subjectName(h, lang)}: ${h.text || '–'}`);
  if (list.length > MAX_LINES) lines.push(t(lang, 'push.more', { n: list.length - MAX_LINES }));
  return { title: t(lang, list.length === 1 ? 'remind.hw_one' : 'remind.hw_n', { name, n: list.length }), body: lines.join('\n') };
}

const keyOf = (studentId, date, topic) => `remind:${studentId}:${date}:${topic}`;

/**
 * Background (every tick, after the pushes of changes). → { sent } (number of pushes)
 */
async function tick(gc, notifier, cfg, now, quiet) {
  if (!cfg.reminder || quiet) return { sent: 0 };
  const today = tz.localDate(now, cfg.tz);
  if (now < tz.at(today, cfg.reminder, cfg.tz)) return { sent: 0 };
  const tomorrow = tz.addDays(today, 1);
  const students = (await store.listStudents(gc)).filter((s) => s.enabled && !s.missing);
  if (!students.length) return { sent: 0 };
  const ids = students.map((s) => s.id);
  const exams = await store.examsBetween(gc, ids, tomorrow, tomorrow);
  const homework = (await store.homeworkDue(gc, ids, tomorrow, tomorrow)).filter((h) => !h.completed);
  if (!exams.length && !homework.length) return { sent: 0 };
  const todo = [];
  for (const s of students) {
    for (const [topic, list] of [['exams', exams.filter((x) => x.student_id === s.id)], ['homework', homework.filter((x) => x.student_id === s.id)]]) {
      if (list.length && !(await store.noticeSeen(gc, keyOf(s.id, tomorrow, topic)))) todo.push({ s, topic, list });
    }
  }
  if (!todo.length) return { sent: 0 };
  const users = new Set();
  try { for (const u of await gc.users.list()) users.add(u.id); } catch { /* none */ }
  const grids = new Map((await store.listAccounts(gc)).map((a) => [a.id, a.timegrid]));
  let sent = 0;
  for (const { s, topic, list } of todo) {
    const key = keyOf(s.id, tomorrow, topic);
    const to = changes.recipientsOf(s, users);
    if (!to.length) { await store.noticeMark(gc, key, now); continue; }
    const { title, body } = topic === 'exams' ? examMessage(s.display, list, grids.get(s.account_id), cfg.lang) : homeworkMessage(s.display, list, cfg.lang);
    const r = await notifier.send({
      topic, title: title.slice(0, 120), body: body ? body.slice(0, 1000) : undefined, priority: 'normal', users: to,
      collapseKey: `schule:${s.id}:${tomorrow}:${topic}`, ttl: 86400, data: { schule: { studentId: s.id, date: tomorrow, kind: topic } },
    });
    if (r.sent) { await store.noticeMark(gc, key, now); sent += 1; }
    else if (r.error !== 'THROTTLED' && r.error !== 'ERR_RATE_LIMIT') await store.noticeMark(gc, key, now);
  }
  return { sent };
}

module.exports = { tick, examMessage, homeworkMessage, examLabel, examWhen, subjectName, keyOf };
