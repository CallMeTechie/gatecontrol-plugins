'use strict';

// 1.3.0: the reminder of a task — the push when it is due, with buttons, and what the buttons do.
//
//   The push (topic reminders, every minute by housekeeping.js): title the task, body „Fällig heute 09:00 · Liste“,
//   data.notizen { kind: 'reminder', taskId, listId, area, tag, remindAtMs, dueAt, late, snoozed } and the buttons
//   data.actions (type 'callback' — GateControl hands a press back to the hook notifyAction, once per push and button):
//     done        „Erledigt“     the task is ticked off (a repeating one gets its next)
//     snooze_1h   „In 1 Std.“    the reminder comes again in an hour
//     snooze_eve  „Heute Abend“  … at the person's evening time (prefs.times.evening, 19:00) — while that is more than
//                                an hour away; after that:
//     snooze_tom  „Morgen früh“  … tomorrow at the person's morning time (prefs.times.morning, 09:00)
//   A reminder the server missed (it was off) is sent late, up to LATE_MAX (24 h), and says so („War fällig um 09:00“);
//   older than that it is not sent: the task is marked (tasks.missed_at) and is part of „Gestern offen geblieben“.
//
//   The tag `task:<id>:<remind_at>` names one reminder — the push carries it, GET reminders lists it for the alarm a
//   device sets itself, and „Später“ with a tag only acts while the task still has that very reminder: a button pressed
//   twice (push and alarm, two devices) snoozes once.
//
//   POST tasks/<id>/snooze { until: '1h' | 'evening' | 'tomorrow' | ISO, tag? } → { snoozed, task }
//   GET reminders → what the person will be reminded of in the next 30 days (for a device's own alarms)

const store = require('./store');
const tz = require('./tz');
const config = require('./config');
const prefs = require('./prefs');
const tasks = require('./tasks');
const lists = require('./lists');
const duty = require('./duty');
const events = require('./events');
const push = require('./push');
const pushprefs = require('./pushprefs');
const Q = require('../ui/quickparse');
const { t } = require('./text');
const { fail, posInt } = require('./util');

const HOUR = 3600000;
const LATE_MAX = 24 * HOUR;   // a reminder missed by more than this is not sent any more („Gestern offen geblieben“ has it)
const LATE_HINT = 15 * 60000; // later than this the push says when it was due
const FEED_DAYS = 30;
const FEED_MAX = 200;
const SNOOZE_MAX = 366 * 86400000;

const timeOf = (p, key) => (p && p.times && p.times[key]) || Q.DEFAULT_TIMES[key];
const dayOf = (ms, zone) => { const p = tz.parts(ms, zone); return tz.dateStr(p.y, p.m, p.d); };
const clockOf = (ms, zone) => { const p = tz.parts(ms, zone); return `${tz.pad(p.hh)}:${tz.pad(p.mm)}`; };

/** The moment of „Später“ `until` for a person, seen from `now` (null: not possible any more). */
function snoozeTime(until, now, zone, p) {
  if (until === '1h') return now + HOUR;
  const today = dayOf(now, zone);
  if (until === 'evening') { const at = tz.at(today, tz.parseTime(timeOf(p, 'evening')), zone); return at > now ? at : null; }
  if (until === 'tomorrow') return tz.at(tz.addDays(today, 1), tz.parseTime(timeOf(p, 'morning')), zone);
  return null;
}

/** The buttons of a reminder shown at `at`: [{ id, label }] — done, in an hour, this evening (or tomorrow morning). */
function buttons(lang, at, zone, p) {
  const eve = snoozeTime('evening', at, zone, p);
  return [
    { id: 'done', label: t(lang, 'n.b_done') },
    { id: 'snooze_1h', label: t(lang, 'n.b_1h') },
    eve && eve - at > HOUR ? { id: 'snooze_eve', label: t(lang, 'n.b_eve') } : { id: 'snooze_tom', label: t(lang, 'n.b_tom') },
  ];
}
const UNTIL = { snooze_1h: '1h', snooze_eve: 'evening', snooze_tom: 'tomorrow' };

/** „Fällig heute 09:00 · Liste“ — or, sent late, „War fällig um 09:00 · Liste“ (r with list_name; shown at `at`). */
function bodyOf(lang, r, at, zone, late) {
  const today = dayOf(at, zone);
  const word = (d) => (d === today ? t(lang, 'w.today') : d === tz.addDays(today, -1) ? t(lang, 'w.yesterday') : d === tz.addDays(today, 1) ? t(lang, 'w.tomorrow') : d);
  let first = null;
  if (late) {
    const d = dayOf(r.remind_at, zone);
    first = d === today ? t(lang, 'n.late_today', { time: clockOf(r.remind_at, zone) }) : t(lang, 'n.late', { when: `${word(d)} ${clockOf(r.remind_at, zone)}` });
  } else if (r.due_date) {
    first = t(lang, 'n.due', { when: r.due_time ? `${word(r.due_date)} ${r.due_time}` : word(r.due_date) });
  }
  return [first, r.list_name].filter(Boolean).join(' · ').slice(0, 1000);
}

/** The open reminders that are due (idx_tasks_remind) as pushes → how many went out. */
async function tick(gc, ctx) {
  const cfg = await config.get(gc);
  const rows = await store.all(gc, `SELECT t.*, l.name AS list_name, l.area AS list_area FROM tasks t INDEXED BY idx_tasks_remind JOIN lists l ON l.id = t.list_id AND l.deleted_at IS NULL
    WHERE t.remind_at IS NOT NULL AND t.reminded_at IS NULL AND t.done_at IS NULL AND t.deleted_at IS NULL AND t.remind_at <= ? ORDER BY t.remind_at LIMIT 100`, [ctx.now]);
  if (!rows.length) return 0;
  const who = await duty.of(gc, rows);
  const lang = cfg.notify_lang;
  let sent = 0;
  for (const r of rows) {
    const behind = ctx.now - r.remind_at;
    if (behind > LATE_MAX) {
      // too old to ring: it is not lost — the morning hint and „Mein Tag“ list it until it is decided
      await store.run(gc, 'UPDATE tasks SET reminded_at = ?, missed_at = ? WHERE id = ?', [ctx.now, ctx.now, r.id]);
      const u = who.get(r.id);
      if (u) events.changed(gc, [u], 'tasks');
      continue;
    }
    await store.run(gc, 'UPDATE tasks SET reminded_at = ? WHERE id = ?', [ctx.now, r.id]);
    const user = who.get(r.id);
    if (!user) continue;
    const late = behind > LATE_HINT;
    const p = await prefs.get(gc, user);
    if (await pushprefs.send(gc, [user], 'reminders', {
      topic: 'reminders', title: r.title.slice(0, 120), body: bodyOf(lang, r, ctx.now, ctx.tz, late),
      priority: r.important ? 'high' : 'normal', collapseKey: 'task:' + r.id,
      data: {
        notizen: { ...push.reminder(r, r.list_area), tag: duty.tagOf(r), remindAtMs: r.remind_at, dueAt: r.due_at && r.due_time ? tasks.iso(ctx, r.due_at) : null, late, snoozed: !!r.snoozed_at },
        actions: buttons(lang, ctx.now, ctx.tz, p).map((b) => ({ type: 'callback', id: b.id, label: b.label })),
      },
    })) sent++;
  }
  return sent;
}

/**
 * „Später“: the reminder of row `r` (of tasks.access) moves to `at`. With `tag`: only while the task still has that
 * reminder → whether it moved.
 */
async function snoozeRow(gc, ctx, r, at, tag) {
  if (r.done_at || r.parent_id) return false;
  if (tag != null && duty.tagOf(r) !== tag) return false;
  if (r.remind_at === at && !r.reminded_at) return false;
  const twoWay = await tasks.linkedTwoWay(gc, r.list_id);
  await store.run(gc, 'UPDATE tasks SET remind_at = ?, reminded_at = NULL, snoozed_at = ?, missed_at = NULL, updated_at = ?, ext_dirty = ? WHERE id = ?', [at, ctx.now, ctx.now, twoWay ? 1 : r.ext_dirty, r.id]);
  events.changed(gc, await lists.memberIds(gc, r.list_id), 'tasks');
  return true;
}

/** POST tasks/<id>/snooze { until, tag? } → { snoozed, task } */
async function snooze(gc, ctx, id, b, opts) {
  const r = await tasks.access(gc, ctx, id);
  if (!(await tasks.mayComplete(gc, ctx, r))) throw tasks.readOnly();
  if (b.tag != null && (typeof b.tag !== 'string' || b.tag.length > 60)) throw fail('invalid', { field: 'tag' });
  let at = null;
  if (b.until === '1h' || b.until === 'evening' || b.until === 'tomorrow') at = snoozeTime(b.until, ctx.now, ctx.tz, await prefs.get(gc, ctx.userId));
  else if (typeof b.until === 'string' && /[zZ]$|[+-]\d{2}:?\d{2}$/.test(b.until)) { const ms = Date.parse(b.until); at = Number.isFinite(ms) && ms > ctx.now && ms - ctx.now <= SNOOZE_MAX ? ms : null; }
  if (at == null) throw fail('invalid', { field: 'until' });
  const snoozed = await snoozeRow(gc, ctx, r, at, b.tag == null ? null : b.tag);
  return { snoozed, ...(await tasks.get(gc, ctx, r.id, opts)) };
}

/** A button of a reminder push (hook notifyAction; ctx is the person who pressed it — their rights are checked here). */
async function onAction(gc, ctx, action, d, opts) {
  const id = posInt(d && d.taskId);
  if (!id) return { ok: false, code: 'invalid' };
  let r;
  try { r = await tasks.access(gc, ctx, id); } catch { return { ok: false, code: 'not_found' }; }
  if (!(await tasks.mayComplete(gc, ctx, r))) return { ok: false, code: 'forbidden' };
  if (action === 'done') {
    // the press belongs to one reminder: a repeating task whose next one is due already is not ticked off by an old push
    if (r.done_at) return { ok: true, done: false };
    await tasks.complete(gc, ctx, r.id, { done: true }, opts);
    return { ok: true, done: true };
  }
  if (!Object.prototype.hasOwnProperty.call(UNTIL, action)) return { ok: false, code: 'invalid' };
  const tag = Number.isSafeInteger(d.remindAtMs) ? `task:${r.id}:${d.remindAtMs}` : (typeof d.tag === 'string' ? d.tag : null);
  if (!tag) return { ok: false, code: 'invalid' };
  // „Heute Abend“ pressed after the evening: in an hour instead of never
  const at = snoozeTime(UNTIL[action], ctx.now, ctx.tz, await prefs.get(gc, ctx.userId)) || ctx.now + HOUR;
  return { ok: true, snoozed: await snoozeRow(gc, ctx, r, at, tag) };
}

/** GET reminders → { now, nowMs, enabled, reminders: [...], yesterday: { push, at } } — the person's own, for local alarms. */
async function feed(gc, ctx) {
  const p = await prefs.get(gc, ctx.userId);
  const out = { now: tasks.iso(ctx, ctx.now), nowMs: ctx.now, enabled: p.notify.reminders !== false, reminders: [], yesterday: { push: p.notify.yesterday !== false, at: p.yesterdayAt } };
  if (!out.enabled) return out;
  const until = ctx.now + FEED_DAYS * 86400000;
  // every reminder to come in the person's lists; whose it is decides duty.of (nearly always the person's own)
  const rows = await store.all(gc, `SELECT t.*, l.name AS list_name, l.area AS list_area FROM tasks t INDEXED BY idx_tasks_remind
    JOIN list_members m ON m.list_id = t.list_id AND m.user_id = ? JOIN lists l ON l.id = t.list_id AND l.deleted_at IS NULL
    WHERE t.remind_at IS NOT NULL AND t.reminded_at IS NULL AND t.done_at IS NULL AND t.deleted_at IS NULL AND t.remind_at <= ? ORDER BY t.remind_at LIMIT 1000`, [ctx.userId, until]);
  const who = await duty.of(gc, rows);
  for (const r of rows) {
    if (who.get(r.id) !== ctx.userId) continue;
    const at = Math.max(r.remind_at, 0);
    out.reminders.push({
      tag: duty.tagOf(r), taskId: r.id, listId: r.list_id, area: r.list_area || null, title: r.title.slice(0, 120), body: bodyOf(ctx.lang, r, at, ctx.tz, false),
      at: tasks.iso(ctx, at), atMs: at, important: !!r.important, snoozed: !!r.snoozed_at, collapseKey: 'task:' + r.id, actions: buttons(ctx.lang, at, ctx.tz, p),
    });
    if (out.reminders.length >= FEED_MAX) break;
  }
  return out;
}

module.exports = { LATE_MAX, LATE_HINT, tick, snooze, snoozeRow, snoozeTime, onAction, feed, buttons, bodyOf, UNTIL };
