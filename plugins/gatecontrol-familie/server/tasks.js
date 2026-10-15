'use strict';

// Tasks and stars.
//
// A task is due on occurrences: a one-off task on its date, a repeating one
// (daily / weekly on weekdays / monthly on the anchor's day, clamped to the
// month's end) on every occurrence from its anchor date on. The *current*
// occurrence of a repeating task is the first one on or after today — a
// missed occurrence is not carried over; a one-off task stays due (overdue)
// until it is done.
//
// Modes: fixed = every assignee does it (each one ticks it off), rotate =
// whose turn it is (advances on done), first = whoever is first (the others'
// reminders are replaced by "erledigt" through the same collapse key).
// Done is idempotent per occurrence (and person for 'fixed'); a child doing a
// task gets its stars (module stars on). Weekly stars = Monday 00:00 local
// until now.
//
// Reminders (tick): once the occurrence is due (date + time, default 08:00,
// local) and not done, one push per occurrence and person — and one more
// after each snooze (15–240 minutes).
//
// The wall tablet (role 'wall', 1.1.0) ticks a task off for the person whose
// task it is: rotate → whose turn it is, fixed → each assignee, first → any
// assignee (POST tasks/<id>/done { userId }).

const store = require('./store');
const tz = require('./tz');
const push = require('./push');
const members = require('./members');
const { fail, posInt, text, bool, intIn, time, date, iso, userIds, parseJson, validDate } = require('./util');

const MODES = ['fixed', 'rotate', 'first'];
const REPEATS = ['none', 'daily', 'weekly', 'monthly'];
const TITLE_MAX = 80;
const DEFAULT_REMIND_TIME = '08:00';
const DONE_KEEP_DAYS = 7;
const DAY = 86400000;

const isoWd = (d) => ((tz.weekday(d) + 6) % 7) + 1; // 1 = Monday … 7 = Sunday

function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

function rowToTask(r) {
  return {
    id: r.id, title: r.title, mode: r.mode, assignees: parseJson(r.assignees_json, []), turnUser: r.turn_user,
    repeat: r.repeat, weekdays: parseJson(r.weekdays_json, null), dueTime: r.due_time || null, anchor: r.due_date,
    stars: r.stars, reminder: !!r.reminder, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/** Is `d` an occurrence of the task? */
function isOccurrence(t, d) {
  if (!validDate(d)) return false;
  if (t.repeat === 'none') return d === t.anchor;
  if (d < t.anchor) return false;
  if (t.repeat === 'daily') return true;
  if (t.repeat === 'weekly') return (t.weekdays || []).includes(isoWd(d));
  if (t.repeat === 'monthly') {
    const a = tz.parseDate(t.anchor);
    const p = tz.parseDate(d);
    return p.d === Math.min(a.d, daysInMonth(p.y, p.m));
  }
  return false;
}

/** First occurrence on or after `from` (repeating tasks; null when none). */
function nextOccurrence(t, from) {
  let d = from < t.anchor ? t.anchor : from;
  if (t.repeat === 'none') return t.anchor >= from ? t.anchor : null;
  if (t.repeat === 'daily') return d;
  if (t.repeat === 'weekly') {
    if (!t.weekdays || !t.weekdays.length) return null;
    for (let i = 0; i < 7; i++) { if (t.weekdays.includes(isoWd(d))) return d; d = tz.addDays(d, 1); }
    return null;
  }
  if (t.repeat === 'monthly') {
    const a = tz.parseDate(t.anchor);
    let { y, m } = tz.parseDate(d);
    for (let i = 0; i < 3; i++) {
      const c = tz.dateStr(y, m, Math.min(a.d, daysInMonth(y, m)));
      if (c >= d) return c;
      m++; if (m > 12) { m = 1; y++; }
    }
  }
  return null;
}

/** The current occurrence: one-off → its date; repeating → first occurrence on/after today. */
function currentOccurrence(t, today) {
  return t.repeat === 'none' ? t.anchor : nextOccurrence(t, today);
}

/** Assignees that are members (in their order). */
function liveAssignees(t, fam) { return t.assignees.filter((id) => fam.byId.has(id)); }

function currentTurn(t, fam) {
  if (t.mode !== 'rotate') return null;
  const a = liveAssignees(t, fam);
  return a.includes(t.turnUser) ? t.turnUser : (a[0] || null);
}

/** Is `userId` the one to do the current occurrence? */
function responsible(t, fam, userId) {
  if (t.mode === 'rotate') return currentTurn(t, fam) === userId;
  return liveAssignees(t, fam).includes(userId);
}

async function doneRows(gc, ids) {
  if (!ids.length) return [];
  return store.all(gc, `SELECT task_id, occurrence, user_id, at FROM task_done WHERE task_id IN (${store.marks(ids.length)}) ORDER BY at`, ids);
}

/** Is the occurrence done (for `viewerId` in mode fixed: the viewer's own tick, a non-assignee: all of them)? */
function isDone(t, fam, rows, occ, viewerId) {
  const by = rows.filter((r) => r.task_id === t.id && r.occurrence === occ).map((r) => r.user_id);
  if (t.mode !== 'fixed') return by.length > 0;
  const a = liveAssignees(t, fam);
  if (a.includes(viewerId)) return by.includes(viewerId);
  return a.length > 0 && a.every((id) => by.includes(id));
}

function view(t, fam, rows, today, viewerId) {
  const occ = currentOccurrence(t, today);
  const mine = rows.filter((r) => r.task_id === t.id);
  const last = mine.length ? mine[mine.length - 1] : null;
  const doneBy = occ ? mine.filter((r) => r.occurrence === occ).map((r) => r.user_id) : [];
  const done = occ ? isDone(t, fam, rows, occ, viewerId) : false;
  return {
    id: t.id, title: t.title, mode: t.mode, assignees: liveAssignees(t, fam), current: currentTurn(t, fam),
    repeat: t.repeat, weekdays: t.repeat === 'weekly' ? t.weekdays : [], dueTime: t.dueTime, dueDate: occ,
    stars: t.stars, reminder: t.reminder,
    doneToday: done,
    lastDone: last ? { by: last.user_id, at: iso(last.at) } : null,
    // additions to the contract: who ticked off the current occurrence, one-off task finished
    doneBy, completed: t.repeat === 'none' && done,
    createdBy: t.createdBy,
  };
}

async function listTasks(gc) {
  return (await store.all(gc, 'SELECT * FROM tasks ORDER BY id')).map(rowToTask);
}

async function getTask(gc, id) {
  const r = await store.one(gc, 'SELECT * FROM tasks WHERE id = ?', [id]);
  return r ? rowToTask(r) : null;
}

/** Monday 00:00 (local) of the week of `today` → ms. */
function weekStart(today, zone) {
  return tz.at(tz.addDays(today, -(isoWd(today) - 1)), { hh: 0, mm: 0 }, zone);
}

/** { week: { userId: n }, goal: { userId: n } } for the children. */
async function starsOf(gc, fam, cfg, today) {
  const from = weekStart(today, cfg.tz);
  const rows = await store.all(gc, 'SELECT user_id, SUM(stars) AS n FROM task_done WHERE at >= ? AND stars > 0 GROUP BY user_id', [from]);
  const sum = new Map(rows.map((r) => [r.user_id, r.n]));
  const week = {};
  const goal = {};
  for (const m of fam.list) {
    if (m.role !== 'child') continue;
    week[m.userId] = sum.get(m.userId) || 0;
    goal[m.userId] = m.starGoal;
  }
  return { week, goal };
}

/** GET tasks */
async function get(gc, r) {
  const tasks = await listTasks(gc);
  const rows = await doneRows(gc, tasks.map((t) => t.id));
  const out = { tasks: tasks.map((t) => view(t, r.fam, rows, r.today, r.me.userId)) };
  if (r.cfg.modules.stars) out.stars = await starsOf(gc, r.fam, r.cfg, r.today);
  return out;
}

/** Overview: my tasks of today (and overdue one-off tasks) → { mine, open } */
async function mine(gc, r) {
  const tasks = await listTasks(gc);
  const rows = await doneRows(gc, tasks.map((t) => t.id));
  const list = [];
  for (const t of tasks) {
    const occ = currentOccurrence(t, r.today);
    if (!occ || occ > r.today || !responsible(t, r.fam, r.me.userId)) continue;
    const v = view(t, r.fam, rows, r.today, r.me.userId);
    // a one-off task finished on an earlier day is gone from "today"
    if (t.repeat === 'none' && v.doneToday) {
      const own = rows.filter((x) => x.task_id === t.id && x.occurrence === occ);
      if (!own.some((x) => tz.localDate(x.at, r.cfg.tz) === r.today)) continue;
    }
    list.push(v);
  }
  list.sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : String(a.dueTime || '99').localeCompare(String(b.dueTime || '99'))));
  return { mine: list, open: list.filter((x) => !x.doneToday).length };
}

/**
 * Wall view: today's tasks (and overdue one-off tasks) with a chip per person
 * who may tick it off — rotate: whose turn it is (or who did it), fixed: every
 * assignee, first: every assignee.
 */
async function forWall(gc, r) {
  const list = await listTasks(gc);
  const rows = await doneRows(gc, list.map((t) => t.id));
  const out = [];
  for (const t of list) {
    const occ = currentOccurrence(t, r.today);
    const a = liveAssignees(t, r.fam);
    if (!occ || occ > r.today || !a.length) continue;
    const own = rows.filter((x) => x.task_id === t.id && x.occurrence === occ);
    const by = own.map((x) => x.user_id);
    const done = t.mode === 'fixed' ? a.every((id) => by.includes(id)) : by.length > 0;
    // a one-off task finished on an earlier day is gone from the wall
    if (t.repeat === 'none' && done && !own.some((x) => tz.localDate(x.at, r.cfg.tz) === r.today)) continue;
    let ids = a;
    if (t.mode === 'rotate') ids = by.length ? [by[0]] : [currentTurn(t, r.fam)].filter(Boolean);
    const chips = ids.filter((id) => r.fam.byId.has(id)).map((id) => {
      const m = r.fam.byId.get(id);
      return { userId: id, name: m.name, ...members.faceOf(m), done: t.mode === 'fixed' || t.mode === 'first' ? by.includes(id) : done };
    });
    out.push({
      id: t.id, title: t.title, mode: t.mode, dueDate: occ, dueTime: t.dueTime, overdue: occ < r.today,
      stars: r.cfg.modules.stars ? t.stars : 0, done, chips,
    });
  }
  out.sort((x, y) => (x.done - y.done) || String(x.dueTime || '99').localeCompare(String(y.dueTime || '99')) || x.id - y.id);
  return out;
}

/** Body → task fields (create: defaults; update: merged with the existing task). */
function fields(body, existing, fam, today) {
  const b = body || {};
  const cur = existing || {};
  const out = {};
  out.title = b.title !== undefined ? text(b.title, TITLE_MAX) : (existing ? cur.title : text(b.title, TITLE_MAX));
  out.mode = b.mode !== undefined ? b.mode : (cur.mode || 'fixed');
  if (!MODES.includes(out.mode)) throw fail('invalid');
  out.assignees = b.assignees !== undefined ? userIds(b.assignees, 20) : (cur.assignees || null);
  if (!out.assignees || !out.assignees.length || out.assignees.some((id) => !fam.byId.has(id))) throw fail('invalid');
  out.repeat = b.repeat !== undefined ? b.repeat : (cur.repeat || 'none');
  if (!REPEATS.includes(out.repeat)) throw fail('invalid');
  out.anchor = b.dueDate !== undefined ? date(b.dueDate) : (cur.anchor || today);
  out.dueTime = b.dueTime !== undefined ? time(b.dueTime) : (existing ? cur.dueTime : null);
  if (out.repeat === 'weekly') {
    const w = b.weekdays !== undefined ? b.weekdays : (cur.weekdays && cur.weekdays.length ? cur.weekdays : [isoWd(out.anchor)]);
    if (!Array.isArray(w) || !w.length || w.length > 7 || w.some((x) => !Number.isInteger(x) || x < 1 || x > 7)) throw fail('invalid');
    out.weekdays = [...new Set(w)].sort();
  } else out.weekdays = null;
  out.stars = b.stars !== undefined ? intIn(b.stars, 0, 10) : (existing ? cur.stars : 0);
  out.reminder = b.reminder !== undefined ? bool(b.reminder) : (existing ? cur.reminder : true);
  let turn = existing ? cur.turnUser : null;
  if (b.current !== undefined && b.current !== null) {
    const c = posInt(b.current);
    if (!c || !out.assignees.includes(c)) throw fail('invalid');
    turn = c;
  }
  out.turnUser = out.mode === 'rotate' ? (out.assignees.includes(turn) ? turn : out.assignees[0]) : null;
  return out;
}

async function create(gc, r) {
  const f = fields(r.body, null, r.fam, r.today);
  const res = await store.run(gc, `INSERT INTO tasks (title, mode, assignees_json, turn_user, repeat, weekdays_json, due_time, due_date, stars, reminder, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [f.title, f.mode, JSON.stringify(f.assignees), f.turnUser, f.repeat, f.weekdays ? JSON.stringify(f.weekdays) : null, f.dueTime, f.anchor, f.stars, f.reminder ? 1 : 0, r.me.userId, r.now, r.now]);
  return one(gc, r, res.lastInsertRowid);
}

async function update(gc, r, id) {
  const t = await getTask(gc, id);
  if (!t) throw fail('not_found');
  const f = fields(r.body, t, r.fam, r.today);
  await store.run(gc, `UPDATE tasks SET title = ?, mode = ?, assignees_json = ?, turn_user = ?, repeat = ?, weekdays_json = ?, due_time = ?, due_date = ?, stars = ?, reminder = ?, updated_at = ? WHERE id = ?`,
    [f.title, f.mode, JSON.stringify(f.assignees), f.turnUser, f.repeat, f.weekdays ? JSON.stringify(f.weekdays) : null, f.dueTime, f.anchor, f.stars, f.reminder ? 1 : 0, r.now, id]);
  return one(gc, r, id);
}

async function remove(gc, id) {
  const res = await store.run(gc, 'DELETE FROM tasks WHERE id = ?', [id]);
  if (!res.changes) throw fail('not_found');
  await store.run(gc, 'DELETE FROM task_reminders WHERE task_id = ?', [id]);
  // done rows stay for the week's stars; they go with the retention
}

async function one(gc, r, id) {
  const t = await getTask(gc, id);
  if (!t) throw fail('not_found');
  return view(t, r.fam, await doneRows(gc, [id]), r.today, r.me.userId);
}

/**
 * POST tasks/<id>/done { occurrence?, userId? } — userId: a parent ticks it
 * off for an assignee (stars go to that child).
 */
async function done(gc, r, id) {
  const t = await getTask(gc, id);
  if (!t) throw fail('not_found');
  const b = r.body || {};
  let doer = r.me.userId;
  if (r.me.role === 'wall') {
    doer = posInt(b.userId);
    if (!doer || !responsible(t, r.fam, doer)) throw fail('invalid');
  } else if (b.userId != null && posInt(b.userId) !== r.me.userId) {
    if (r.me.role !== 'parent') throw fail('parents_only');
    doer = posInt(b.userId);
    if (!doer || !liveAssignees(t, r.fam).includes(doer)) throw fail('invalid');
  }
  const assignees = liveAssignees(t, r.fam);
  if (!assignees.includes(doer) && r.me.role !== 'parent') throw fail('forbidden');
  const current = currentOccurrence(t, r.today);
  let occ = current;
  if (b.occurrence != null) {
    occ = date(b.occurrence);
    if (!isOccurrence(t, occ) || (current && occ > current && occ > r.today)) throw fail('invalid');
  }
  if (!occ) throw fail('invalid');
  const rows = await doneRows(gc, [id]);
  const already = t.mode === 'fixed'
    ? rows.some((x) => x.occurrence === occ && x.user_id === doer)
    : rows.some((x) => x.occurrence === occ);
  let starsBooked = 0;
  if (!already) {
    const m = r.fam.byId.get(doer);
    starsBooked = m && m.role === 'child' && r.cfg.modules.stars ? t.stars : 0;
    await store.run(gc, 'INSERT INTO task_done (task_id, occurrence, user_id, at, stars) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING', [id, occ, doer, r.now, starsBooked]);
    if (t.mode === 'rotate' && assignees.length) {
      const cur = currentTurn(t, r.fam);
      const next = assignees[(assignees.indexOf(cur) + 1) % assignees.length];
      await store.run(gc, 'UPDATE tasks SET turn_user = ?, updated_at = ? WHERE id = ?', [next, r.now, id]);
    }
    if (t.mode === 'first') {
      // the others' reminders of this occurrence are replaced (same collapse key)
      const sent = await store.all(gc, 'SELECT user_id FROM task_reminders WHERE task_id = ? AND occurrence = ? AND sent_at IS NOT NULL', [id, occ]);
      const to = sent.map((x) => x.user_id).filter((u) => u !== doer && r.fam.byId.has(u));
      if (to.length) {
        const name = (r.fam.byId.get(doer) || r.me).name;
        r.pushes.push({
          topic: 'tasks', users: to, priority: 'info', collapseKey: `task:${id}:${occ}`, ttl: 12 * 3600,
          title: push.t(r.cfg.lang, 'task.done_by', { title: t.title }), body: push.t(r.cfg.lang, 'task.done_by_body', { name }),
          data: { familie: { type: 'task_done', taskId: id, occurrence: occ, userId: doer } },
        });
      }
    }
  }
  return { task: await one(gc, r, id), alreadyDone: already, starsBooked };
}

/** POST tasks/<id>/snooze { minutes } — the caller's reminder of the current occurrence comes again. */
async function snooze(gc, r, id) {
  const t = await getTask(gc, id);
  if (!t) throw fail('not_found');
  const minutes = intIn(r.body && r.body.minutes, 15, 240);
  const b = r.body || {};
  let occ = currentOccurrence(t, r.today);
  if (b.occurrence != null) {
    occ = date(b.occurrence);
    if (!isOccurrence(t, occ)) throw fail('invalid');
  }
  if (!occ) throw fail('invalid');
  const until = r.now + minutes * 60000;
  await store.run(gc, `INSERT INTO task_reminders (task_id, occurrence, user_id, sent_at, snooze_until) VALUES (?, ?, ?, NULL, ?)
    ON CONFLICT(task_id, occurrence, user_id) DO UPDATE SET snooze_until = excluded.snooze_until`, [id, occ, r.me.userId, until]);
  return { snoozedUntil: iso(until), occurrence: occ };
}

/** Background: reminders of due occurrences. Collects pushes into `pushes`. */
async function remind(gc, fam, cfg, now, pushes) {
  const today = tz.localDate(now, cfg.tz);
  const tasks = (await listTasks(gc)).filter((t) => t.reminder);
  if (!tasks.length) return;
  const rows = await doneRows(gc, tasks.map((t) => t.id));
  for (const t of tasks) {
    const occ = currentOccurrence(t, today);
    if (occ !== today) continue;
    const dueAt = tz.at(occ, tz.parseTime(t.dueTime || DEFAULT_REMIND_TIME), cfg.tz);
    if (now < dueAt) continue;
    const by = rows.filter((x) => x.task_id === t.id && x.occurrence === occ).map((x) => x.user_id);
    let who;
    if (t.mode === 'fixed') who = liveAssignees(t, fam).filter((u) => !by.includes(u));
    else if (by.length) who = [];
    else if (t.mode === 'rotate') who = [currentTurn(t, fam)].filter(Boolean);
    else who = liveAssignees(t, fam);
    if (!who.length) continue;
    const state = new Map((await store.all(gc, 'SELECT user_id, sent_at, snooze_until FROM task_reminders WHERE task_id = ? AND occurrence = ?', [t.id, occ])).map((x) => [x.user_id, x]));
    const send = who.filter((u) => {
      const s = state.get(u);
      if (!s || s.sent_at == null) return !s || s.snooze_until == null || now >= s.snooze_until;
      return s.snooze_until != null && s.snooze_until > s.sent_at && now >= s.snooze_until;
    });
    if (!send.length) continue;
    for (const u of send) {
      await store.run(gc, `INSERT INTO task_reminders (task_id, occurrence, user_id, sent_at, snooze_until) VALUES (?, ?, ?, ?, NULL)
        ON CONFLICT(task_id, occurrence, user_id) DO UPDATE SET sent_at = excluded.sent_at`, [t.id, occ, u, now]);
    }
    const when = t.dueTime ? push.t(cfg.lang, 'task.today_at', { time: t.dueTime }) : push.t(cfg.lang, 'task.today');
    const stars = cfg.modules.stars && t.stars > 0;
    pushes.push({
      topic: 'tasks', users: send, priority: 'normal', collapseKey: `task:${t.id}:${occ}`, ttl: 12 * 3600,
      title: push.t(cfg.lang, 'task.due', { title: t.title }),
      body: push.t(cfg.lang, stars ? 'task.due_body_stars' : 'task.due_body', { when, stars: t.stars }),
      data: { familie: { type: 'task_due', taskId: t.id, occurrence: occ } },
    });
  }
}

/** Retention: finished one-off tasks after 7 days, old reminder state, done rows after 400 days. */
async function purge(gc, cfg, now) {
  const today = tz.localDate(now, cfg.tz);
  const oneOff = (await store.all(gc, "SELECT * FROM tasks WHERE repeat = 'none'")).map(rowToTask);
  const rows = await doneRows(gc, oneOff.map((t) => t.id));
  for (const t of oneOff) {
    const own = rows.filter((x) => x.task_id === t.id && x.occurrence === t.anchor);
    if (!own.length) continue;
    const finished = t.mode === 'fixed' ? t.assignees.every((u) => own.some((x) => x.user_id === u)) : true;
    if (finished && own[own.length - 1].at < now - DONE_KEEP_DAYS * DAY) {
      await store.run(gc, 'DELETE FROM tasks WHERE id = ?', [t.id]);
      await store.run(gc, 'DELETE FROM task_reminders WHERE task_id = ?', [t.id]);
    }
  }
  await store.run(gc, 'DELETE FROM task_reminders WHERE occurrence < ?', [tz.addDays(today, -14)]);
  // the stars of the rows that go stay convertible (pocket money, server/allowance.js)
  await require('./allowance').carryStars(gc, now - 400 * DAY);
  await store.run(gc, 'DELETE FROM task_done WHERE at < ?', [now - 400 * DAY]);
}

module.exports = {
  MODES, REPEATS, isoWd, isOccurrence, nextOccurrence, currentOccurrence, weekStart, starsOf, get, mine, forWall, create, update, remove, done, snooze, remind, purge, one,
};
