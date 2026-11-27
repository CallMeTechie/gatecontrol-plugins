'use strict';

// 1.9.0: „Termin“ — a real event in a calendar of the person in Mail (services calendar_list, calendar_add,
// calendar_update, calendar_delete of gatecontrol-mail ≥ 1.18.0). The event is stored ONLY in the calendar: this module
// keeps no copy and no table. It hands the event over, and shows it through what Mail reports to the hub as a source
// (kind 'event', meta.type 'calendar' — sources.js; docs/notes-sources-contract.md § 6b).
//
//   GET events/calendars          → { state: 'ok' | 'none', reason, calendars: [Calendar], defaultId, reminders: { timed,
//                                   allDay }, timeZone } — the calendars the person sees in Mail. Calendar: { id (null:
//                                   cannot be written), key ('cal:<id>' — the group of its events, for „Quellen“), name,
//                                   color, kind: own | shared | family | subscribed | tasks, writable, target (a new
//                                   event may go into it), isDefault, area, shown (its events are on the overview) }.
//                                   state 'none': no event can be made now — reason no_mail (Mail is not there, or the
//                                   administrator has not confirmed the permission), mail_old (Mail < 1.18.0),
//                                   feature_off | not_allowed | not_licensed | no_seat (Mail's calendars are off for
//                                   the person), no_calendar (nothing to write into), unreachable (try again).
//   POST events { title, date, time?, endDate?, endTime?, allDay?, location?, calendarId?, reminder?, repeat?, clientId? }
//                                 → { event: { id, calendarId }, items: [Item], clientId?, replayed? } — date / time are
//                                   wall-clock in the hub's zone like a task's due. No time: all day (endDate: its last
//                                   day). A time: an hour unless endTime says otherwise (an end not after the start is
//                                   the next day). No calendarId: the person's default calendar in Mail. reminder: minutes
//                                   before, false for none — left out: the default of Mail's calendar. repeat: a rule of
//                                   ui/repeat.js (not 'after'). clientId (made by the device): sent again it answers the
//                                   event made before (replayed: true) — the key goes to Mail, which keeps it.
//   PATCH events/<id> { title?, date?, time?, endDate?, endTime?, allDay?, location?, reminder?, repeat? } → the same;
//   DELETE events/<id> → { removed } — only events made here (Mail keeps the key of each); any other: 404, it is changed
//                                   in Mail's own form.

const tz = require('./tz');
const R = require('../ui/repeat');
const clientIds = require('./clientids');
const { fail, posInt, line, isDate, isTime } = require('./util');

const MAIL = 'gatecontrol-mail';
const SERVICES = ['calendar_list', 'calendar_add', 'calendar_update', 'calendar_delete'];
const AVAIL_MS = 60000;
const LIST_MS = 60000;        // the calendars of a person are asked for at most once a minute …
const LIST_ME_MS = 600000;    // … and for GET me once in ten (Mail allows 600 calls an hour)
const TITLE_MAX = 255;
const LOCATION_MAX = 255;
const REMINDER_MAX = 40320;
const HOUR = 3600000;
const SPAN_DAYS = 7;
const OFF_REASONS = ['feature_off', 'not_allowed', 'not_licensed', 'no_seat'];
const DEFAULT_OFF = ['subscribed', 'tasks'];
const WD = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

let avail = { at: 0, ok: false };
const lists = new Map();   // userId → { at, value }
const asked = new Set();   // people whose events were asked for once since the start (hooks.pull)
const hooks = { pull: null, take: null, drop: null };

function reset() { avail = { at: 0, ok: false }; lists.clear(); asked.clear(); }

/** Does Mail offer the services (asks nobody; at most once a minute)? */
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

/** Is a calendar's group shown on the overview: the person's choice („Quellen“), else by its kind? */
function shownOf(prefs, key, kind) {
  const g = prefs && prefs.groups ? prefs.groups[MAIL + '|' + key] : null;
  if (g === 'hide') return false;
  if (g === 'show' || g === 'private' || g === 'work') return true;
  return !DEFAULT_OFF.includes(kind);
}

const none = (reason) => ({ state: 'none', reason, calendars: [], defaultId: null, reminders: { timed: null, allDay: null }, timeZone: null });

/** One call to Mail as the person → its answer, or { ok: false, code: 'unreachable' } when it does not get through. */
async function mail(gc, ctx, service, payload) {
  try {
    const r = await gc.services.call({ plugin: MAIL, service, userId: ctx.userId, payload: { userId: ctx.userId, lang: ctx.lang, ...payload } });
    return r && typeof r === 'object' ? r : { ok: false, code: 'unreachable' };
  } catch {
    avail = { at: 0, ok: false };
    return { ok: false, code: 'unreachable' };
  }
}

/** The person's calendars in Mail (without their choices) — kept for `maxAge` ms. */
async function load(gc, ctx, maxAge) {
  if (!(await available(gc, ctx.now))) return none('no_mail');
  const have = lists.get(ctx.userId);
  if (have && ctx.now >= have.at && ctx.now - have.at < maxAge) return have.value;
  const r = await mail(gc, ctx, 'calendar_list', {});
  let value;
  if (!r.ok) value = none(r.code === 'forbidden' ? 'mail_old' : 'unreachable');
  // (an older Mail answered Drive's list to nobody else; one without `defaultId` is not 1.18.0 either)
  else if (!Array.isArray(r.calendars) || (r.reason == null && r.defaultId === undefined)) value = none('mail_old');
  else if (r.reason) value = none(OFF_REASONS.includes(r.reason) ? r.reason : 'feature_off');
  else {
    const cals = r.calendars.filter((c) => c && typeof c.key === 'string' && typeof c.name === 'string').slice(0, 100).map((c) => ({
      id: posInt(c.id), key: c.key.slice(0, 80), name: line(c.name, 80), color: typeof c.color === 'string' && /^#[0-9A-Fa-f]{6}$/.test(c.color) ? c.color : null,
      kind: ['own', 'shared', 'family', 'subscribed', 'tasks'].includes(c.kind) ? c.kind : 'own', writable: c.writable === true, isDefault: false, area: c.area === 'work' ? 'work' : 'private',
    }));
    for (const c of cals) c.target = c.writable && c.kind !== 'tasks' && !!c.id;
    const def = cals.find((c) => c.target && c.id === posInt(r.defaultId)) || cals.find((c) => c.target) || null;
    if (def) def.isDefault = true;
    const rem = r.reminders && typeof r.reminders === 'object' ? r.reminders : {};
    const mins = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
    value = { state: def ? 'ok' : 'none', reason: def ? null : 'no_calendar', calendars: cals, defaultId: def ? def.id : null, reminders: { timed: mins(rem.timed), allDay: mins(rem.allDay) },
      timeZone: typeof r.timeZone === 'string' ? r.timeZone : null };
    // Mail of 1.18.0 is there: the person's events are asked for once (a Mail updated after the hub learns that way that
    // the hub takes them — it reports events only to a hub that asks)
    if (!asked.has(ctx.userId) && hooks.pull) { asked.add(ctx.userId); try { await hooks.pull(gc, ctx); } catch { /* the next run */ } }
  }
  if (value.reason !== 'unreachable') lists.set(ctx.userId, { at: ctx.now, value });
  return value;
}

/** GET events/calendars */
async function calendars(gc, ctx, prefs) {
  const v = await load(gc, ctx, LIST_MS);
  return { ...v, calendars: v.calendars.map((c) => ({ ...c, shown: shownOf(prefs, c.key, c.kind) })) };
}

/** me.events: { available, reason } — can the person make an event now? (unreachable counts as yes: the write will say) */
async function meInfo(gc, ctx) {
  const v = await load(gc, ctx, LIST_ME_MS);
  const ok = v.state === 'ok' || v.reason === 'unreachable';
  return { available: ok, reason: ok ? null : v.reason };
}

// ─── writing ──────────────────────────────────────

/** A rule of ui/repeat.js → the recurrence Mail takes (as POST events there). */
function recurrenceOf(rule, date) {
  const r = R.normalize(rule);
  if (!r || r.type === 'after') throw fail('invalid', { field: 'repeat' });
  const out = { freq: r.type, ...(r.interval > 1 ? { interval: r.interval } : {}) };
  if (r.type === 'weekly') out.byDay = (r.days && r.days.length ? r.days : [R.weekday(date)]).map((d) => WD[d - 1]);
  return out;
}

/**
 * The checked fields of POST / PATCH events → the payload of calendar_add / calendar_update. `cur`: null for a new
 * event; for a change the times must come whole (date at least) when any of them is given.
 */
function fields(ctx, b, creating) {
  const p = {};
  const has = (k) => b[k] !== undefined;
  if (creating || has('title')) {
    const title = line(typeof b.title === 'string' ? b.title : '', TITLE_MAX + 1);
    if (!title || title.length > TITLE_MAX) throw fail('invalid', { field: 'title' });
    p.title = title;
  }
  const timeGiven = creating || ['date', 'time', 'endDate', 'endTime', 'allDay'].some(has);
  let date = null;
  if (timeGiven) {
    if (!isDate(b.date)) throw fail('invalid', { field: 'date' });
    date = b.date;
    if (b.time != null && !isTime(b.time)) throw fail('invalid', { field: 'time' });
    if (b.endTime != null && !isTime(b.endTime)) throw fail('invalid', { field: 'endTime' });
    if (b.endDate != null && (!isDate(b.endDate) || b.endDate < date || tz.diffDays(date, b.endDate) > SPAN_DAYS)) throw fail('invalid', { field: 'endDate' });
    if (b.allDay != null && typeof b.allDay !== 'boolean') throw fail('invalid', { field: 'allDay' });
    const allDay = b.allDay === true || (b.allDay == null && b.time == null);
    if (allDay) {
      if (b.time != null || b.endTime != null) throw fail('invalid', { field: 'allDay' });
      Object.assign(p, { allDay: true, startsAt: date, ...(b.endDate && b.endDate !== date ? { endsAt: b.endDate } : {}) });
    } else {
      if (b.time == null) throw fail('invalid', { field: 'time' });
      const start = tz.at(date, tz.parseTime(b.time), ctx.tz);
      let end = start + HOUR;
      if (b.endTime != null) {
        const endDay = b.endDate || date;
        end = tz.at(endDay, tz.parseTime(b.endTime), ctx.tz);
        // „22 bis 1 Uhr“: an end that is not after the start is the next day
        if (end <= start && !b.endDate) end = tz.at(tz.addDays(date, 1), tz.parseTime(b.endTime), ctx.tz);
      } else if (b.endDate && b.endDate !== date) end = tz.at(b.endDate, tz.parseTime(b.time), ctx.tz) + HOUR;
      if (end <= start || end - start > SPAN_DAYS * 86400000) throw fail('invalid', { field: 'endTime' });
      Object.assign(p, { allDay: false, start, end });
    }
  }
  if (has('location')) {
    if (b.location === null || b.location === '') { if (!creating) p.location = null; } else {
      const loc = line(typeof b.location === 'string' ? b.location : '', LOCATION_MAX + 1);
      if (!loc || loc.length > LOCATION_MAX) throw fail('invalid', { field: 'location' });
      p.location = loc;
    }
  }
  if (has('reminder') && b.reminder !== null) {
    if (b.reminder !== false && !(Number.isInteger(b.reminder) && b.reminder >= 0 && b.reminder <= REMINDER_MAX)) throw fail('invalid', { field: 'reminder' });
    p.reminder = b.reminder;
  }
  if (has('repeat')) {
    if (b.repeat === null) { if (!creating) p.recurrence = null; } else {
      if (!date) throw fail('invalid', { field: 'date' });
      p.recurrence = recurrenceOf(b.repeat, date);
    }
  }
  return p;
}

/** Mail's refusal → the API's error. */
function refusal(r) {
  const code = r && r.code;
  if (code === 'invalid') return fail('invalid', { field: 'event' });
  if (code === 'not_found') return fail('not_found');
  if (code === 'forbidden') return fail('unavailable', { reason: 'mail_old' });
  if (code === 'unavailable') return fail('unavailable', { reason: typeof r.reason === 'string' ? r.reason.slice(0, 40) : 'failed' });
  return fail('unavailable', { reason: 'unreachable' });
}

async function need(gc, ctx) {
  if (!(await available(gc, ctx.now))) throw fail('unavailable', { reason: 'no_mail' });
}

/** What Mail answered: its items into the hub's copy (hooks.take) → the answer of the API. */
async function answer(gc, ctx, r, more) {
  const items = hooks.take && Array.isArray(r.items) ? await hooks.take(gc, ctx, r.eventId, r.items) : [];
  return { event: { id: r.eventId, calendarId: posInt(r.calendarId) }, items, ...(more || {}) };
}

/** POST events */
async function create(gc, ctx, b) {
  const clientId = clientIds.arg(b.clientId);
  const p = fields(ctx, b, true);
  let calendarId = null;
  if (b.calendarId != null) {
    calendarId = posInt(b.calendarId);
    if (!calendarId) throw fail('invalid', { field: 'calendarId' });
  }
  await need(gc, ctx);
  // a key always: Mail lets the hub change and remove only the events it made with one
  const key = 'event:' + (clientId || require('node:crypto').randomBytes(12).toString('hex'));
  const r = await mail(gc, ctx, 'calendar_add', { ...p, ...(calendarId ? { calendarId } : {}), key, items: true });
  if (!r.ok) {
    if (r.code === 'not_found') throw fail('not_found', { field: 'calendarId' });
    throw refusal(r);
  }
  // (an older Mail took the call for its narrow calendar_add and knows no `items`)
  if (!Array.isArray(r.items)) throw fail('unavailable', { reason: 'mail_old' });
  return answer(gc, ctx, r, { ...(clientId ? { clientId } : {}), ...(r.replayed === true ? { replayed: true } : {}) });
}

/** PATCH events/<id> */
async function update(gc, ctx, id, b) {
  const eventId = posInt(id);
  if (!eventId) throw fail('not_found');
  const p = fields(ctx, b, false);
  await need(gc, ctx);
  const r = await mail(gc, ctx, 'calendar_update', { ...p, eventId, items: true, keyKind: 'event' });
  if (!r.ok) throw refusal(r);
  return answer(gc, ctx, r);
}

/** DELETE events/<id> */
async function remove(gc, ctx, id) {
  const eventId = posInt(id);
  if (!eventId) throw fail('not_found');
  await need(gc, ctx);
  const r = await mail(gc, ctx, 'calendar_delete', { eventId, keyKind: 'event' });
  if (!r.ok) throw refusal(r);
  // an event Mail did not make for the hub (or one that is gone): nothing was removed
  if (r.removed && hooks.drop) await hooks.drop(gc, ctx, eventId);
  return { removed: r.removed === true };
}

module.exports = { MAIL, DEFAULT_OFF, available, calendars, meInfo, create, update, remove, shownOf, recurrenceOf, hooks, reset, _fields: fields };
