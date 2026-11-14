'use strict';

// 1.3.0: a task with a time as an event in the calendar „Aufgaben“ of Mail (services calendar_tasks, calendar_add,
// calendar_update, calendar_delete of gatecontrol-mail ≥ 1.15.0) — half an hour from the due time, in the calendar of the
// person whose task it is (duty.js), WITHOUT a reminder of its own (the task reminds itself; two messages otherwise).
//
// The task keeps the link (tasks.cal_event_id, cal_id, cal_user) and what it wrote (cal_sig). Every change that matters
// (title, due, person, list, done, deleted) marks the task (cal_dirty = 1); the write tries the calendar right away and the
// background run does what is left — so nothing is lost while Mail is not there, switched off or installed later:
//   no Mail (or one without the services) → the marks wait; once it is there the next run writes the events
//   Mail refuses for the person (no place, not allowed, calendars off) → parked (cal_dirty = 2), asked again once a day
//   the administrator's switch „Aufgaben mit Uhrzeit in den Kalender eintragen“ or the person's own (prefs.calendar.tasks)
//   off → the events are taken out again
// A task that is done stays in the calendar as „✓ Titel“ with its time free; a deleted one goes. An event the person
// deleted in the calendar comes back with the task's next change.

const store = require('./store');
const tz = require('./tz');
const config = require('./config');
const prefs = require('./prefs');
const duty = require('./duty');
const events = require('./events');
const { t } = require('./text');

const MAIL = 'gatecontrol-mail';
const SERVICES = ['calendar_tasks', 'calendar_add', 'calendar_update', 'calendar_delete'];
const DURATION = 30 * 60000;
const BATCH = 25;          // tasks a background run looks at (≤ 3 calls each; Mail allows 3600 an hour per service)
const PARKED = 2;
const REARM_MS = 24 * 3600000;
const AVAIL_MS = 60000;
const PARK_REASONS = ['feature_off', 'not_allowed', 'not_licensed', 'no_seat'];

let avail = { at: 0, ok: false };
let lastRearm = 0;

function reset() { avail = { at: 0, ok: false }; lastRearm = 0; }

/** Does Mail offer the calendar services now (asked at most once a minute; the host does not run Mail for it)? */
async function available(gc, now) {
  if (now - avail.at < AVAIL_MS && now >= avail.at) return avail.ok;
  let ok = false;
  try {
    if (gc.services && typeof gc.services.available === 'function') {
      ok = true;
      for (const s of SERVICES) if (!(await gc.services.available(MAIL, s))) { ok = false; break; }
    }
  } catch { ok = false; }
  avail = { at: now, ok };
  return ok;
}

/** Are tasks written into the calendar at all (the administrator's switch and Mail there)? */
async function active(gc, now) {
  const cfg = await config.get(gc);
  return cfg.calendar_tasks !== false && await available(gc, now);
}

/** A task changed in a way the calendar shows: mark it (only one that has an event or could get one). */
async function touch(gc, ids) {
  for (const part of store.chunks((Array.isArray(ids) ? ids : [ids]).filter(Boolean))) {
    if (!part.length) continue;
    await store.run(gc, `UPDATE tasks SET cal_dirty = 1 WHERE id IN (${store.marks(part.length)}) AND cal_dirty != 1
      AND (cal_event_id IS NOT NULL OR (due_time IS NOT NULL AND due_date IS NOT NULL AND done_at IS NULL AND deleted_at IS NULL AND parent_id IS NULL))`, part);
  }
}

/** A list was deleted, restored, emptied into another one or its members changed: its tasks are looked at again. */
async function touchList(gc, listIds) {
  for (const id of (Array.isArray(listIds) ? listIds : [listIds]).filter(Boolean)) {
    await store.run(gc, `UPDATE tasks SET cal_dirty = 1 WHERE list_id = ? AND cal_dirty != 1
      AND (cal_event_id IS NOT NULL OR (due_time IS NOT NULL AND due_date IS NOT NULL AND done_at IS NULL AND deleted_at IS NULL AND parent_id IS NULL))`, [id]);
  }
}

/** Everything that has an event, and the open tasks with a time from `today` on — after a switch changed. */
async function touchAll(gc, today, userId) {
  if (userId) {
    await store.run(gc, 'UPDATE tasks SET cal_dirty = 1 WHERE cal_user = ? AND cal_event_id IS NOT NULL', [userId]);
    await store.run(gc, `UPDATE tasks INDEXED BY idx_tasks_dueday SET cal_dirty = 1 WHERE due_date >= ? AND due_time IS NOT NULL AND done_at IS NULL AND deleted_at IS NULL AND parent_id IS NULL
      AND cal_event_id IS NULL AND (assignee_id = ? OR created_by = ?)`, [today, userId, userId]);
    return;
  }
  await store.run(gc, 'UPDATE tasks SET cal_dirty = 1 WHERE cal_event_id IS NOT NULL');
  await store.run(gc, `UPDATE tasks INDEXED BY idx_tasks_dueday SET cal_dirty = 1 WHERE due_date >= ? AND due_time IS NOT NULL AND done_at IS NULL AND deleted_at IS NULL AND parent_id IS NULL
    AND cal_event_id IS NULL`, [today]);
}

class Stop extends Error {}

/** One call to Mail as `userId` → its answer; a call that does not get through stops the run (tried again next time). */
async function mail(gc, service, userId, payload) {
  let r;
  try {
    r = await gc.services.call({ plugin: MAIL, service, userId, payload: { userId, ...payload } });
  } catch (e) {
    avail = { at: 0, ok: false };
    throw new Stop((e && e.code) || 'failed');
  }
  if (!r || typeof r !== 'object') throw new Stop('failed');
  return r;
}

/** The person's calendar „Aufgaben“ (kept in cal_users; `fresh`: ask Mail again — it was deleted there). */
async function calendarOf(gc, userId, lang, now, fresh) {
  if (!fresh) {
    const have = await store.one(gc, 'SELECT calendar_id FROM cal_users WHERE user_id = ?', [userId]);
    if (have) return { id: have.calendar_id };
  }
  const r = await mail(gc, 'calendar_tasks', userId, { lang });
  if (!r.ok) return { refusal: r };
  await store.run(gc, 'INSERT INTO cal_users (user_id, calendar_id, at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET calendar_id = excluded.calendar_id, at = excluded.at', [userId, r.calendar.id, now]);
  return { id: r.calendar.id };
}

const clear = (gc, id, dirty = 0) => store.run(gc, 'UPDATE tasks SET cal_event_id = NULL, cal_id = NULL, cal_user = NULL, cal_sig = NULL, cal_dirty = ? WHERE id = ?', [dirty, id]);

/** What the calendar should show of task row `r` (with list_name, list_gone). */
function wanted(r, lang) {
  const start = tz.at(r.due_date, tz.parseTime(r.due_time), r.zone);
  const done = !!r.done_at;
  return {
    title: ((done ? '✓ ' : '') + r.title).slice(0, 255), start, end: start + DURATION, busy: done ? 'free' : 'busy',
    note: t(lang, 'cal.note', { list: r.list_name || '' }).slice(0, 500),
  };
}

/**
 * Bring the calendar in line with one task row → 'added' | 'updated' | 'removed' | 'parked' | 'none'.
 * Throws Stop when Mail cannot be reached (the mark stays).
 */
async function syncRow(gc, r, o) {
  const { cfg, now, lang } = o;
  const gone = !!r.deleted_at || !!r.list_gone || !!r.parent_id;
  const timed = !!r.due_date && !!r.due_time;
  let person = null;
  let want = cfg.calendar_tasks !== false && !gone && timed && (!r.done_at || !!r.cal_event_id);
  if (want) {
    person = await duty.one(gc, r);
    want = !!person && (await prefs.get(gc, person)).calendar.tasks !== false;
  }
  let had = false;
  // an event that should not be there (any more), or is in the calendar of someone who is no longer the person
  if (r.cal_event_id && (!want || r.cal_user !== person)) {
    const d = await mail(gc, 'calendar_delete', r.cal_user, { eventId: r.cal_event_id });
    if (!d.ok && !(d.code === 'unavailable' && PARK_REASONS.includes(d.reason))) throw new Stop(d.code || 'failed');
    await clear(gc, r.id, want ? 1 : 0);
    r = { ...r, cal_event_id: null, cal_id: null, cal_user: null, cal_sig: null };
    had = true;
  }
  if (!want) {
    if (!had) await store.run(gc, 'UPDATE tasks SET cal_dirty = 0 WHERE id = ?', [r.id]);
    return had ? 'removed' : 'none';
  }
  const w = wanted({ ...r, zone: o.zone }, lang);
  const sig = JSON.stringify([w.title, w.start, w.end, w.busy, w.note]);
  if (r.cal_event_id) {
    if (r.cal_sig === sig) { await store.run(gc, 'UPDATE tasks SET cal_dirty = 0 WHERE id = ?', [r.id]); return 'none'; }
    const u = await mail(gc, 'calendar_update', person, { eventId: r.cal_event_id, ...w, lang });
    if (u.ok) { await store.run(gc, 'UPDATE tasks SET cal_sig = ?, cal_dirty = 0 WHERE id = ?', [sig, r.id]); return 'updated'; }
    if (u.code === 'unavailable' && PARK_REASONS.includes(u.reason)) { await store.run(gc, 'UPDATE tasks SET cal_dirty = ? WHERE id = ?', [PARKED, r.id]); return 'parked'; }
    if (u.code !== 'not_found') throw new Stop(u.code || 'failed');
    // deleted in the calendar meanwhile: written anew below
    await clear(gc, r.id, 1);
  }
  let added = null;
  for (const fresh of [false, true]) {
    const cal = await calendarOf(gc, person, lang, now, fresh);
    if (cal.refusal) { added = cal.refusal; break; }
    added = await mail(gc, 'calendar_add', person, { calendarId: cal.id, title: w.title, allDay: false, start: w.start, end: w.end, reminder: false, busy: w.busy, note: w.note, key: 'task:' + r.id, lang });
    if (added.ok) { added.calendarId = cal.id; break; }
    // the calendar „Aufgaben“ was deleted in Mail: ask for it again, once
    if (added.code !== 'not_found') break;
  }
  if (added.ok) {
    await store.run(gc, 'UPDATE tasks SET cal_event_id = ?, cal_id = ?, cal_user = ?, cal_sig = ?, cal_dirty = 0 WHERE id = ?', [added.eventId, added.calendarId, person, sig, r.id]);
    return 'added';
  }
  if (added.code === 'unavailable' && PARK_REASONS.includes(added.reason)) { await store.run(gc, 'UPDATE tasks SET cal_dirty = ? WHERE id = ?', [PARKED, r.id]); return 'parked'; }
  if (added.code === 'invalid') { gc.log.warn('calendar refused a task', r.id); await store.run(gc, 'UPDATE tasks SET cal_dirty = 0 WHERE id = ?', [r.id]); return 'none'; }
  throw new Stop(added.code || 'failed');
}

const rowsSql = (hint = '') => `SELECT t.*, l.name AS list_name, CASE WHEN l.id IS NOT NULL AND l.deleted_at IS NULL THEN 0 ELSE 1 END AS list_gone FROM tasks t ${hint} LEFT JOIN lists l ON l.id = t.list_id`;

/** Sync these rows; tells the members of the lists whose tasks changed in the calendar → how many did. */
async function run(gc, ctx, rows) {
  const cfg = await config.get(gc);
  const o = { cfg, now: ctx.now, zone: ctx.tz, lang: cfg.notify_lang };
  let n = 0;
  const lists = new Set();
  try {
    for (const r of rows) {
      const what = await syncRow(gc, r, o);
      if (what !== 'none' && what !== 'parked') { n++; lists.add(r.list_id); }
    }
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    if (gc.log && gc.log.debug) gc.log.debug('calendar: Mail not reached', e.message);
  }
  for (const id of lists) {
    const members = (await store.all(gc, 'SELECT user_id FROM list_members WHERE list_id = ?', [id])).map((m) => m.user_id);
    events.changed(gc, members, 'tasks');
  }
  return n;
}

/** Right after a write: these tasks, when Mail is there (never throws — the background run does what fails here). */
async function now(gc, ctx, ids) {
  try {
    const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean).slice(0, 10);
    if (!list.length) return 0;
    await touch(gc, list);
    if (!(await available(gc, ctx.now))) return 0;
    const rows = await store.all(gc, `${rowsSql()} WHERE t.id IN (${store.marks(list.length)}) AND t.cal_dirty = 1`, list);
    return rows.length ? await run(gc, ctx, rows) : 0;
  } catch (e) {
    if (gc.log && gc.log.warn) gc.log.warn('calendar sync failed', (e && (e.code || e.message)) || 'error');
    return 0;
  }
}

/** The background run: the marked tasks, a batch at a time; the parked ones again once a day. */
async function tick(gc, ctx) {
  if (ctx.now - lastRearm > REARM_MS || ctx.now < lastRearm) {
    lastRearm = ctx.now;
    // (the index holds the rows with cal_dirty != 0 — SQLite takes it only when the statement says so too)
    await store.run(gc, 'UPDATE tasks INDEXED BY idx_tasks_cal_dirty SET cal_dirty = 1 WHERE cal_dirty != 0 AND cal_dirty = ?', [PARKED]);
  }
  const rows = await store.all(gc, `${rowsSql('INDEXED BY idx_tasks_cal_dirty')} WHERE t.cal_dirty != 0 AND t.cal_dirty = 1 ORDER BY t.id LIMIT ${BATCH}`);
  if (!rows.length) return 0;
  if (!(await available(gc, ctx.now))) return 0;
  return run(gc, ctx, rows);
}

/** The task's `calendar` of the API (tasks.view): null | { state: 'synced' | 'pending', eventId?, calendarId?, mine }. */
function view(ctx, r) {
  if (r.cal_event_id) {
    return { state: r.cal_dirty === 1 && ctx.calendar ? 'pending' : 'synced', eventId: r.cal_event_id, calendarId: r.cal_id, mine: r.cal_user === ctx.userId };
  }
  if (r.cal_dirty === 1 && ctx.calendar && r.due_date && r.due_time && !r.done_at && !r.parent_id) return { state: 'pending', mine: duty.candidate(r) === ctx.userId };
  return null;
}

module.exports = { MAIL, DURATION, BATCH, available, active, touch, touchAll, touchList, now, tick, view, reset };
