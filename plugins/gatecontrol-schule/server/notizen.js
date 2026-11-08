'use strict';

// Schule as a source of „Notizen & Aufgaben“ (1.8.0, gatecontrol-notizen; contract v1, server/todohub.js): the homework
// and the exams of every child, for the child and its recipients (parents):
//
//   homework  { id: 'hw:<studentId>:<hwId>', kind: 'homework', title: „Mathe: S. 34 Nr. 2“, subtitle: „Lena · Hausaufgabe“,
//               due: the day it is due (allDay), assignee: the child's account, done: WebUntis says completed or someone
//               ticked it off in GateControl (homework_done), canComplete: true, open: homework/<studentId>:<hwId> }
//               — open homework due from HW_BACK_DAYS ago, done homework from today on, up to HW_AHEAD_DAYS ahead
//   exam      { id: 'exam:<studentId>:<exId>', kind: 'exam', title: „Deutsch: Klassenarbeit“, due: the day (with its start
//               time when WebUntis has one), canComplete: false, open: exam/<studentId>:<exId> } — the next EXAM_DAYS days
//
// users: the child's account and the recipients of the student (who see it in Schule); group: the child (child:<id>,
// the hub's „Kinder“ filter); meta.child: the name. Parent evenings are not in Schule's data (WebUntis' timetable has
// none for it), so there are none. Ticking homework off is Schule's own (WebUntis' `completed` cannot be written);
// undoing it works only for a tick made in GateControl (else read_only).

const crypto = require('node:crypto');
const store = require('./store');
const config = require('./config');
const clock = require('./clock');
const tz = require('./tz');
const views = require('./views');
const texts = require('./texts.json');
const todohub = require('./todohub');

const PLUGIN = 'gatecontrol-schule';
const HW_BACK_DAYS = 3;
const HW_AHEAD_DAYS = 30;
const EXAM_DAYS = 60;
const KEY_RE = /^[A-Za-z0-9._-]{1,60}$/;

const say = (lang, key) => (texts[lang === 'en' ? 'en' : 'de'] || {})[key] || texts.de[key] || key;

/** An id of WebUntis as a part of an item id (anything odd as its hash). */
const keyOf = (v) => (KEY_RE.test(String(v)) ? String(v) : crypto.createHash('sha1').update(String(v)).digest('hex').slice(0, 20));

function usersOf(s) {
  return [...new Set([s.user_id, ...s.recipients].filter((u) => Number.isSafeInteger(u) && u > 0))];
}

function title(subject, what) {
  const s = views.clip(subject || '', 60);
  const w = views.clip(what || '', 180);
  return s && w ? `${s}: ${w}` : (w || s);
}

/** Every homework and exam item of the enabled children. */
async function collect(gc, now) {
  const cfg = await config.load(gc);
  const students = (await store.listStudents(gc)).filter((s) => s.enabled && !s.missing && usersOf(s).length);
  if (!students.length) return [];
  const today = tz.localDate(now, cfg.tz);
  const byId = new Map(students.map((s) => [s.id, s]));
  const ids = students.map((s) => s.id);
  const out = [];
  const base = (s) => ({
    area: 'private', users: usersOf(s), assignee: s.user_id || null, assigneeName: s.display, important: false,
    group: { id: `child:${s.id}`, label: s.display }, meta: { child: s.display },
  });
  for (const h of await store.homeworkDue(gc, ids, tz.addDays(today, -HW_BACK_DAYS), tz.addDays(today, HW_AHEAD_DAYS))) {
    const s = byId.get(h.student_id);
    if (!s) continue;
    // done homework of past days is not „zu tun“ any more (a tick of the last 24 h stays for „Erledigt heute“)
    if (h.completed && h.due_date < today && !(h.done_at != null && now - h.done_at < 86400000)) continue;
    const key = `${s.id}:${keyOf(h.hw_id)}`;
    out.push({
      ...base(s), id: `hw:${key}`, kind: 'homework', title: title(h.subject, h.text) || say(cfg.lang, 'notizen.homework'),
      subtitle: `${s.display} · ${say(cfg.lang, 'notizen.homework')}`, due: h.due_date, allDay: true,
      done: h.completed, canComplete: true, meta: { type: 'homework', child: s.display },
      open: { plugin: PLUGIN, route: `homework/${key}` }, updatedAt: h.done_at || 0,
    });
  }
  for (const x of await store.examsBetween(gc, ids, today, tz.addDays(today, EXAM_DAYS))) {
    const s = byId.get(x.student_id);
    if (!s) continue;
    const key = `${s.id}:${keyOf(x.ex_id)}`;
    const due = x.t_start && tz.parseTime(x.t_start) ? todohub.isoIn(tz.at(x.date, x.t_start, cfg.tz), cfg.tz) : x.date;
    out.push({
      ...base(s), id: `exam:${key}`, kind: 'exam', title: title(x.subject, x.name || x.type) || say(cfg.lang, 'notizen.exam'),
      subtitle: `${s.display} · ${say(cfg.lang, 'notizen.exam')}`, due,
      done: false, canComplete: false, meta: { type: 'exam', child: s.display },
      open: { plugin: PLUGIN, route: `exam/${key}` },
    });
  }
  return out;
}

/** Ticking homework off for the child — by the child or a recipient (whoever sees it). */
async function complete(gc, user, item, done, now) {
  const m = /^hw:(\d{1,10}):(.+)$/.exec(item.id);
  if (!m) return { ok: false, code: 'read_only' };
  const s = await store.getStudent(gc, Number(m[1]));
  if (!s || !usersOf(s).includes(user.id)) return { ok: false, code: 'forbidden' };
  const cfg = await config.load(gc);
  const today = tz.localDate(now, cfg.tz);
  const hw = (await store.homeworkDue(gc, [s.id], tz.addDays(today, -HW_BACK_DAYS), tz.addDays(today, HW_AHEAD_DAYS))).find((h) => `${s.id}:${keyOf(h.hw_id)}` === `${m[1]}:${m[2]}`);
  if (!hw) return { ok: false, code: 'not_found' };
  // WebUntis says it is done: GateControl cannot undo that
  if (!done && hw.untis_completed) return { ok: false, code: 'read_only' };
  if (done === hw.completed) return { ok: true };
  await store.setHomeworkDone(gc, s.id, hw.hw_id, user.id, done, now);
  return { ok: true };
}

const source = todohub.create({ plugin: PLUGIN, collect, complete, now: () => clock.now(), tx: (gc, fn) => store.tx(gc, fn), intervalMs: 60000 });

module.exports = { source, collect, complete, HW_BACK_DAYS, HW_AHEAD_DAYS, EXAM_DAYS };
