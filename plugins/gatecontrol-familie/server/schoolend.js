'use strict';

// Early end of a school day → the pickup (1.13.0). The Schule plugin (gatecontrol-schule ≥ 1.2.0) calls the
// service school_day_end when a child's school day (today or tomorrow) ends earlier than planned:
//
//   { events: [{ userId, date: 'YYYY-MM-DD', plannedEnd: 'HH:MM', newEnd: 'HH:MM', text }] }   1 … 20
//   → { ok: true, notified: <people notified>, matched: <events with a pickup> } | { ok: false, code: 'invalid' }
//
// Only the caller gatecontrol-schule (services.js); nothing happens while the module rides is off. The
// holiday mode does not hold it (it is information). Per event (a child of the family, the date today or
// later; once per child, date and new end — table notices):
//   * the pickup: a ride (module rides, one-off or an occurrence of a series) on that date for that child,
//     not cancelled, whose time is within ± 60 minutes of the planned end — the closest one. Found → a
//     push (topic 'rides', high) to its driver (a member) and the parents: „Früher Schluss: Lena“ /
//     „Schule endet um 11:30 statt 13:05 – Abholung ist für 13:05 eingetragen.“ With GateControl ≥ 1.181.0
//     (callback buttons, reminders.callbacks) the buttons
//       move  „Auf 11:30 verschieben“ — only while the pickup is later than the new end; parents or the
//             driver may: the occurrence's time becomes the new end (series: that occurrence only), the
//             others are told („Anna hat die Abholung auf 11:30 verschoben“), logged (school_end_log)
//       ask   „Wer kann?“ — the rides module's request („Wer kann Lena um 11:30 abholen?“ to the parents,
//             at least 5 minutes apart). On the driver's push always (pressed by the driver: the driver is
//             released first, they cannot); on the parents' push only while nobody drives.
//   * no pickup: with the setting school_early_end_notify (default on) a push to the parents with the text
//     of the Schule plugin („Lena hat am Di 21.10. schon um 11:30 Schluss (statt 13:05)“).
// A press comes back through the hook notifyAction (data.familie.type 'school_end'); the push is no
// permission — everything is checked again (member, parent or driver, ride unchanged).

const store = require('./store');
const tz = require('./tz');
const push = require('./push');
const format = require('./format');
const members = require('./members');
const rides = require('./rides');
const notices = require('./notices');
const reminders = require('./reminders');
const { posInt, line, validDate, TIME_RE, isKnown } = require('./util');

const TYPE = 'school_end';
const EVENTS_MAX = 20;
const TEXT_MAX = 200;
const WINDOW_MIN = 60;
const KEEP_DAYS = 30;
const DAY = 86400000;

const mins = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** The payload → the events, or null when anything is wrong. */
function parseEvents(payload) {
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  if (!p || !Array.isArray(p.events) || p.events.length > EVENTS_MAX) return null;
  const out = [];
  for (const e of p.events) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
    const userId = typeof e.userId === 'number' ? posInt(e.userId) : null;
    if (!userId) return null;
    if (typeof e.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.date) || !validDate(e.date)) return null;
    if (typeof e.plannedEnd !== 'string' || !TIME_RE.test(e.plannedEnd) || typeof e.newEnd !== 'string' || !TIME_RE.test(e.newEnd)) return null;
    if (e.newEnd >= e.plannedEnd) return null;
    const text = line(e.text);
    if (!text || text.length > TEXT_MAX) return null;
    out.push({ userId, date: e.date, plannedEnd: e.plannedEnd, newEnd: e.newEnd, text });
  }
  return out;
}

/** The pickup of the event's child on its date closest to the planned end (± 60 minutes), or null. */
async function findRide(gc, ev) {
  let best = null;
  let bd = Infinity;
  for (const o of await rides.loadRange(gc, ev.date, ev.date)) {
    if (o.cancelled || !o.childIds.includes(ev.userId)) continue;
    const d = Math.abs(mins(o.time) - mins(ev.plannedEnd));
    if (d <= WINDOW_MIN && d < bd) { best = o; bd = d; }
  }
  return best;
}

async function log(gc, row, now) {
  await store.run(gc, `INSERT INTO school_end_log (child_id, date, planned_end, new_end, ride_key, action, by_user, detail_json, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [row.childId, row.date, row.plannedEnd, row.newEnd, row.rideKey || null, row.action, row.by || null, JSON.stringify(row.detail || {}), now]);
}

function ttlUntil(date, hhmm, cfg, now) {
  return Math.max(300, Math.min(2 * 86400, Math.round((tz.at(date, tz.parseTime(hhmm), cfg.tz) - now) / 1000) + 3600));
}

/** The pushes of one event (pickup `o` or null) → [push]. */
function messages(gc, cfg, fam, ev, o, today, now) {
  const lang = cfg.lang;
  const child = fam.byId.get(ev.userId);
  const parents = members.parents(fam).map((m) => m.userId);
  const title = push.t(lang, 'school_end.title', { name: child.name });
  const base = { topic: 'rides', collapseKey: `school_end:${ev.userId}:${ev.date}`, ttl: ttlUntil(ev.date, ev.plannedEnd, cfg, now), title };
  const familie = { type: TYPE, childId: ev.userId, date: ev.date, plannedEnd: ev.plannedEnd, newEnd: ev.newEnd };
  if (!o) {
    if (!cfg.schoolEarlyEndNotify || !parents.length) return [];
    return [{ ...base, users: parents, priority: 'normal', body: ev.text, data: { familie } }];
  }
  const when = ev.date === today ? '' : `${format.cap(format.rel(ev.date, today, lang))}: `;
  const body = push.t(lang, 'school_end.body_ride', { when, newEnd: ev.newEnd, plannedEnd: ev.plannedEnd, time: o.time });
  const data = { familie: { ...familie, rideId: o.key, rideTime: o.time } };
  const drv = rides.liveDriver(o, fam);
  const driver = drv && drv.userId ? drv.userId : null;
  const buttons = reminders.callbacks(gc);
  const move = buttons && mins(o.time) > mins(ev.newEnd) ? [{ type: 'callback', id: 'move', label: push.t(lang, 'school_end.move', { time: ev.newEnd }) }] : [];
  const ask = buttons ? [{ type: 'callback', id: 'ask', label: push.t(lang, 'school_end.ask') }] : [];
  const out = [];
  const withActions = (actions) => (actions.length ? { ...data, actions } : data);
  if (driver) out.push({ ...base, users: [driver], priority: 'high', body, data: withActions([...move, ...ask]) });
  const others = parents.filter((u) => u !== driver);
  // the parents: „Wer kann?“ only while nobody drives (a free-text driver counts as driving)
  if (others.length) out.push({ ...base, users: others, priority: 'high', body, data: withActions([...move, ...(drv ? [] : ask)]) });
  return out;
}

/** The service school_day_end (only from gatecontrol-schule; services.js checks the caller). */
async function handle(gc, cfg, payload, now) {
  const events = parseEvents(payload);
  if (!events) return { ok: false, code: 'invalid' };
  if (!events.length || cfg.modules.rides === false) return { ok: true, notified: 0, matched: 0 };
  const today = tz.localDate(now, cfg.tz);
  const fam = await members.load(gc, today);
  const pushes = [];
  let matched = 0;
  await store.tx(gc, async () => {
    for (const ev of events) {
      const child = fam.byId.get(ev.userId);
      if (!child || child.role !== 'child' || ev.date < today) continue;
      if (!(await notices.once(gc, `school_end:${ev.userId}:${ev.date}:${ev.newEnd}`, now))) continue;
      const o = await findRide(gc, ev);
      if (o) matched += 1;
      const list = messages(gc, cfg, fam, ev, o, today, now);
      pushes.push(...list);
      await log(gc, { childId: ev.userId, date: ev.date, plannedEnd: ev.plannedEnd, newEnd: ev.newEnd, rideKey: o ? o.key : null, action: 'notified',
        detail: { users: list.reduce((n, x) => n + x.users.length, 0) } }, now);
    }
  });
  const res = await push.flush(gc, pushes);
  const notified = pushes.reduce((n, x, i) => n + (res[i] && res[i].sent ? x.users.length : 0), 0);
  return { ok: true, notified, matched };
}

/** „Anna hat die Abholung auf 11:30 verschoben“ to the driver and the parents (not the one who did it). */
function movedPush(r, o, fam, me) {
  const drv = rides.liveDriver(o, fam);
  const to = [...new Set([...(drv && drv.userId ? [drv.userId] : []), ...members.parents(fam).map((m) => m.userId)])].filter((u) => u !== me.userId);
  if (!to.length) return;
  r.pushes.push({
    topic: 'rides', users: to, priority: 'normal', collapseKey: `ride:${o.key}`, ttl: rides.ttlFor(o, r.cfg, r.now),
    title: push.t(r.cfg.lang, 'school_end.moved', { by: me.name, time: o.time }), body: [o.title, o.place].filter(Boolean).join(' · '),
    data: { familie: { type: 'ride_moved', rideId: o.key, date: o.date } },
  });
}

/**
 * A button of an early-end push was pressed (hook notifyAction, data.familie.type 'school_end').
 * → { ok, state?, error? } (GateControl only logs it)
 */
async function onAction(gc, cfg, args, now) {
  const x = args && typeof args === 'object' ? args : {};
  const userId = Number.isSafeInteger(x.userId) ? x.userId : null;
  const d = x.data && typeof x.data === 'object' && x.data.familie && typeof x.data.familie === 'object' ? x.data.familie : null;
  const action = typeof x.action === 'string' ? x.action : '';
  if (!userId || !d || d.type !== TYPE || typeof d.rideId !== 'string' || !['move', 'ask'].includes(action)) return { ok: false, error: 'unknown' };
  if (typeof d.newEnd !== 'string' || !TIME_RE.test(d.newEnd) || typeof d.rideTime !== 'string' || !TIME_RE.test(d.rideTime)) return { ok: false, error: 'unknown' };
  if (cfg.modules.rides === false) return { ok: false, error: 'module_off' };
  const today = tz.localDate(now, cfg.tz);
  const fam = await members.load(gc, today);
  const me = fam.byId.get(userId);
  if (!me) return { ok: false, error: 'not_member' };
  const r = { fam, cfg, now, today, me, pushes: [], trustOnly: false };
  const entry = (o, act, detail) => ({ childId: Number(d.childId) || 0, date: o.date, plannedEnd: String(d.plannedEnd || ''), newEnd: d.newEnd, rideKey: o.key, action: act, by: userId, detail });
  let out;
  try {
    out = await store.tx(gc, async () => {
      const o = await rides.findOcc(gc, d.rideId);
      if (o.date !== d.date) return { ok: false, error: 'changed' };
      if (o.cancelled) return { ok: false, error: 'cancelled' };
      const drv = rides.liveDriver(o, fam);
      const isDriver = !!(drv && drv.userId === userId);
      if (action === 'move') {
        if (me.role !== 'parent' && !isDriver) return { ok: false, error: 'forbidden' };
        if (o.time === d.newEnd) return { ok: true, state: 'moved', already: true };
        if (o.time !== d.rideTime) return { ok: false, error: 'changed' };
        await rides.saveOcc(gc, o, { time: d.newEnd }, now);
        await log(gc, entry(o, 'moved', { from: d.rideTime, to: d.newEnd }), now);
        movedPush(r, o, fam, me);
        gc.log.info('pickup moved for an early end of school', o.key, userId);
        return { ok: true, state: 'moved' };
      }
      // ask: the driver who presses it cannot — released first; anyone else only while nobody drives
      if (isDriver) await rides.release(gc, r, d.rideId);
      const res = await rides.ask(gc, r, d.rideId);
      await log(gc, entry(o, 'asked', { notified: res.notified }), now);
      return { ok: true, state: 'asked', notified: res.notified };
    });
  } catch (e) {
    if (isKnown(e)) return { ok: false, error: e.code };
    throw e;
  }
  if (r.pushes.length) await push.flush(gc, r.pushes);
  return out;
}

async function purge(gc, now) {
  await store.run(gc, 'DELETE FROM school_end_log WHERE at < ?', [now - KEEP_DAYS * DAY]);
}

module.exports = { TYPE, EVENTS_MAX, WINDOW_MIN, parseEvents, findRide, messages, handle, onAction, purge };
