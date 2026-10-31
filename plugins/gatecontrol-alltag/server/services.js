'use strict';

// Services for other plugins (1.3.0, plugin.json services.provides; GateControl ≥ 1.177.0
// gc.services). The host lets only plugins that list a service in their permissions.services
// call it (gatecontrol-familie: the calendar conditions of its rules and reminders). Every
// answer is JSON ≤ 16 KB; a refusal is { ok: false, code } (never thrown).
//
//   calendar_query { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', subIds?: [number], match?: string }
//                  → { ok: true, events: [{ title, date, startMs, allDay, subId, subName, time }],
//                      subscriptions: [{ id, name }] }
//                  The events of the calendars the person (the call's user) sees — like the
//                  portal and the app: the calendars assigned to that person; an administrator
//                  sees every calendar. No user → nothing. from … to: local dates (the plugin's
//                  time zone, inclusive, at most 62 days); subIds narrows to those calendars;
//                  match: the title contains it (ignoring case, ≤ 80). At most 50 events (titles
//                  cut to 80), sorted by start; an all-day event that started earlier is listed
//                  with its own start date. time: 'HH:MM' local, null all day. The calendar area
//                  switched off → no events, no subscriptions. Codes: invalid.
//   calendar_list  {} → { ok: true, subscriptions: [{ id, name }] }   the calendars the person sees
//
// 1.4.0 (Mail's calendar shows the Alltag calendars): both services allow 1800 calls an hour (services.provides
// maxPerHour, GateControl ≥ 1.216.0); calendar_query takes `cursor?` (an opaque string from `next`) and answers
// `next: cursor | null` — the next page of at most 50 events (and at most ~15 KB of them); every event carries
// `endMs | null` (its end, null when it has none), `uid` (the occurrence's key in its calendar — the UID and its start —, stable between refreshes) and
// `location | null` (≤ 80). Callers without a cursor (Familie) get the first page as before.

const store = require('./store');
const calendar = require('./calendar');
const format = require('./format');
const tz = require('./tz');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 62;
const MAX_EVENTS = 50;
const TITLE_MAX = 80;
const MATCH_MAX = 80;
const PAGE_BYTES = 15 * 1024;
const CURSOR_RE = /^\d{1,5}$/;

class Refusal extends Error { constructor(code) { super(code); this.code = code; } }
const no = (code) => new Refusal(code);

/** The subscriptions `user` sees: assigned to the person; an administrator sees all; nobody → none. */
async function visibleSubs(gc, cfg, user) {
  if (!cfg.calendarEnabled || !user || !Number.isSafeInteger(user.id)) return [];
  const all = await store.listSubs(gc);
  if (user.role === 'admin') return all.filter((s) => !!s.enabled);
  return all.filter((s) => calendar.visibleTo(s, user.id));
}

const subsView = (subs) => subs.map((s) => ({ id: s.id, name: s.name }));

function localDate(v) {
  if (typeof v !== 'string' || !DATE_RE.test(v) || !tz.parseDate(v)) throw no('invalid');
  return v;
}

async function calendarQuery(gc, cfg, payload, user) {
  const from = localDate(payload.from);
  const to = payload.to === undefined || payload.to === null ? from : localDate(payload.to);
  if (to < from || tz.diffDays(from, to) > MAX_DAYS) throw no('invalid');
  let ids = null;
  if (payload.subIds !== undefined && payload.subIds !== null) {
    if (!Array.isArray(payload.subIds) || payload.subIds.length > 100 || !payload.subIds.every((x) => Number.isSafeInteger(x) && x > 0)) throw no('invalid');
    ids = new Set(payload.subIds);
  }
  let match = '';
  if (payload.match !== undefined && payload.match !== null) {
    if (typeof payload.match !== 'string' || payload.match.length > MATCH_MAX) throw no('invalid');
    match = payload.match.trim().toLowerCase();
  }
  let skip = 0;
  if (payload.cursor !== undefined && payload.cursor !== null) {
    if (typeof payload.cursor !== 'string' || !CURSOR_RE.test(payload.cursor)) throw no('invalid');
    skip = Number(payload.cursor);
  }
  const subs = await visibleSubs(gc, cfg, user);
  const use = ids ? subs.filter((s) => ids.has(s.id)) : subs;
  const byId = new Map(use.map((s) => [s.id, s]));
  const startMs = tz.toUtc({ ...tz.parseDate(from) }, cfg.tz);
  const endMs = tz.toUtc({ ...tz.parseDate(tz.addDays(to, 1)) }, cfg.tz);
  const events = [];
  let bytes = 0;
  let n = 0;
  let next = null;
  for (const e of await store.eventsBetween(gc, use.map((s) => s.id), startMs, endMs, 2000)) {
    if (match && !String(e.title || '').toLowerCase().includes(match)) continue;
    if (n++ < skip) continue;
    const s = byId.get(e.sub_id);
    const ev = {
      title: String(e.title || '').slice(0, TITLE_MAX), date: e.date, startMs: e.start_ms, allDay: !!e.all_day, subId: s.id, subName: s.name,
      time: e.all_day ? null : format.time(e.start_ms, cfg.tz),
      // 1.4.0: the end, the event's key and its place (Mail's calendar)
      endMs: Number.isSafeInteger(e.end_ms) && e.end_ms > e.start_ms ? e.end_ms : null, uid: String(e.ikey || '').slice(0, 200),
      location: e.location ? String(e.location).slice(0, TITLE_MAX) : null,
    };
    const size = Buffer.byteLength(JSON.stringify(ev)) + 1;
    if (events.length >= MAX_EVENTS || (events.length && bytes + size > PAGE_BYTES)) { next = String(n - 1); break; }
    events.push(ev);
    bytes += size;
  }
  return { ok: true, events, subscriptions: subsView(subs), next };
}

async function calendarList(gc, cfg, payload, user) {
  return { ok: true, subscriptions: subsView(await visibleSubs(gc, cfg, user)) };
}

const HANDLERS = { calendar_query: calendarQuery, calendar_list: calendarList };
const NAMES = Object.freeze(Object.keys(HANDLERS));

/** service({ name, caller, user, payload }) → the answer (see the head of this file). */
async function handle(gc, cfg, call) {
  const c = call && typeof call === 'object' ? call : {};
  const fn = Object.prototype.hasOwnProperty.call(HANDLERS, c.name) ? HANDLERS[c.name] : null;
  if (!fn) return { ok: false, code: 'not_found' };
  const payload = c.payload && typeof c.payload === 'object' && !Array.isArray(c.payload) ? c.payload : {};
  try {
    return await fn(gc, cfg, payload, c.user || null);
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, code: e.code };
    gc.log.warn('service failed', c.name, (e && (e.code || e.message)) || 'error');
    return { ok: false, code: 'failed' };
  }
}

module.exports = { handle, NAMES, MAX_DAYS, MAX_EVENTS };
