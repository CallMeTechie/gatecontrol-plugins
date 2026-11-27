'use strict';

// Mail as a source of „Notizen & Aufgaben“ (1.11.0, gatecontrol-notizen; contract v1, server/todohub.js):
//
//   „Zu tun“ of the AI   { id: 'todo:<messageId>:<key>', kind: 'task', title: the to-do („Rechnung bis 28.11. bezahlen“),
//                          subtitle: „Zu tun aus „<subject>““, due: its date (and time, in the person's time zone),
//                          meta: { type: question | deadline | event | amount | task, amount?: „84,20 €“ },
//                          done: ticked off (table todo_done), open: message/<messageId> }
//                          — of mails the AI read within the last TODO_DAYS days (not in the trash or junk); key: a short
//                          hash of the to-do's kind and text, so a new AI run that finds the same keeps the tick
//   a flagged mail       { id: 'flag:<messageId>', kind: 'task', title: the subject, subtitle: the sender, important: true,
//                          meta: { type: 'flagged', flagged: true } } — the newest FLAGGED_MAX per person; ticked off =
//                          the flag cleared (on the server too, like „Markierung entfernen“), kept a day as done so the
//                          hub can undo it (flags it again)
//
//   an event (1.18.0)   { id: 'ev:<eventId>[:<occurrence>]', kind: 'event', title, subtitle: the place, due: its start
//                          (a date for an all-day one, else a date-time with the offset of the person's zone),
//                          canComplete: false, group: the calendar ('cal:<id>', its name), area: 'work' for a business
//                          calendar, meta: { type: 'calendar', cal: own | shared | family | subscribed | tasks, color,
//                          end (date-time) | endDate (the last day of an all-day one over several days), location,
//                          eventId, recurring, writable }, open: event/<eventId>[/<occurrence>] }
//                          — every calendar the person sees, from today (their zone) EVENT_DAYS days on: the own ones,
//                          the GateControl calendars shared with them that they show („Mit mir geteilt“, never a private
//                          event or one they only see as „Gebucht“), the family calendar of Familie ('overlay:familie',
//                          id 'ov:…', cal 'family'), iCal subscriptions and the calendar „Aufgaben“ (the hub hides those
//                          two until the person switches them on). Not: cancelled events, declined invitations and the
//                          ones not answered yet. Only for a hub that asks for them (its todo_items carries
//                          accepts: ['calendar'] — an older hub would show every event as „Termine heute“ unasked);
//                          the answer then names provides: ['calendar'].
//
// users: the account's owner (only while that person may use Mail: allowed, a licence, a seat); area: 'work' for an
// account of kind business, else 'private'; group: the account (account:<id>, its name or address).

const crypto = require('node:crypto');
const store = require('./store');
const config = require('./config');
const seats = require('./seats');
const people = require('./people');
const pimstore = require('./pimstore');
const messages = require('./messages');
const tz = require('./tz');
const todohub = require('./todohub');
const { t } = require('./text');
const calendars = require('./calendars');
const overlays = require('./overlays');
const { parse } = require('./util');

const PLUGIN = 'gatecontrol-mail';
const TODO_DAYS = 30;
const TODO_MAX = 2000;
const FLAGGED_MAX = 200;
const DAY = 86400000;
const KINDS = ['question', 'deadline', 'event', 'amount', 'task'];
const OUT_ROLES = ['trash', 'junk'];
const EVENT_DAYS = 30;      // „Demnächst“ shows 14 days, „Geplant“ the weeks after
const EVENTS_MAX = 400;     // per person
const HUB_KEY = 'hub';

// ─── 1.18.0: does the hub take events? ──────────────

let hubCalendar = null; // null: not read yet

async function takesEvents(gc) {
  if (hubCalendar == null) {
    let v = null;
    try { v = await gc.storage.get(HUB_KEY); } catch { v = null; }
    hubCalendar = !!(v && v.calendar === true);
  }
  return hubCalendar;
}

/** A pull of the hub (todo_items): it says what it takes beside the items of contract v1 (accepts: ['calendar']). */
async function hubAsked(gc, payload) {
  const on = !!(payload && Array.isArray(payload.accepts) && payload.accepts.includes('calendar'));
  if (on === await takesEvents(gc)) return;
  hubCalendar = on;
  try { await gc.storage.set(HUB_KEY, { calendar: on }); } catch { /* asked again with the next pull */ }
  source.state.cache = null;
}

function resetHub() { hubCalendar = null; }

/** The key of a to-do of the AI: stable while its kind and text stay. */
const keyOf = (td) => crypto.createHash('sha1').update(`${td.kind}|${td.text}`).digest('hex').slice(0, 10);

function money(amount, currency, lang) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
  if (!currency) return String(amount);
  try { return new Intl.NumberFormat(lang === 'en' ? 'en-GB' : 'de-DE', { style: 'currency', currency }).format(amount); } catch { return `${amount} ${currency}`; }
}

/** The people who may use Mail now (allowed, licence, a seat) → Map id → { lang, zone }. */
async function persons(gc, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const cfg = await config.get(gc);
  const lic = await people.licence(gc);
  if (!lic.valid) return out;
  const us = await people.users(gc);
  for (const id of ids) {
    const u = us.get(id);
    if (!u || u.disabled) continue;
    const seat = await seats.get(gc, id);
    if (!seat || seat.kind === 'none' || !(await config.allowed(gc, cfg, id))) continue;
    let zone = 'Europe/Berlin';
    try { zone = (await pimstore.zoneOf(gc, id)) || zone; } catch { /* the default */ }
    out.set(id, { lang: u.lang === 'en' ? 'en' : 'de', zone });
  }
  return out;
}

const accountGroup = (a) => ({ id: `account:${a.id}`, label: a.name || a.email });

/** Every item of every person. */
async function collect(gc, now) {
  const accounts = new Map((await store.all(gc, 'SELECT id, user_id, email, name, kind FROM accounts')).map((a) => [a.id, a]));
  // 1.18.0: events — of everybody who has a calendar (a person needs no account for GateControl's own calendars)
  const events = await takesEvents(gc);
  const calOwners = events ? (await store.all(gc, 'SELECT DISTINCT user_id FROM calendars')).map((r) => r.user_id) : [];
  if (!accounts.size && !calOwners.length) return [];
  const who = await persons(gc, [...new Set([...[...accounts.values()].map((a) => a.user_id), ...calOwners])]);
  if (!who.size) return [];
  const out = [];
  if (events) {
    const cfg = await config.get(gc);
    for (const [uid, p] of who) {
      try { out.push(...await eventItems(gc, cfg, uid, p, now)); } catch (e) { gc.log.warn('notizen: events failed', (e && (e.code || e.message)) || 'error'); }
    }
  }
  const base = (a) => ({ area: a.kind === 'business' ? 'work' : 'private', users: [a.user_id], group: accountGroup(a) });

  // „Zu tun“ of the AI
  const rows = await store.all(gc, `SELECT r.message_id, r.todos_json, r.at, m.user_id, m.account_id, m.subject, f.role FROM ai_results r
    JOIN messages m ON m.id = r.message_id JOIN folders f ON f.id = m.folder_id
    WHERE r.at >= ? AND r.todos_json <> '[]' ORDER BY r.at DESC LIMIT ?`, [now - TODO_DAYS * DAY, TODO_MAX]);
  const done = new Map();
  for (const part of store.chunks(rows.map((r) => r.message_id))) {
    for (const d of await store.all(gc, `SELECT id, at FROM todo_done WHERE message_id IN (${store.marks(part.length)})`, part)) done.set(d.id, d.at);
  }
  for (const r of rows) {
    const a = accounts.get(r.account_id);
    const p = a && who.get(r.user_id);
    if (!p || OUT_ROLES.includes(r.role)) continue;
    const seen = new Set();
    for (const td of parse(r.todos_json, [])) {
      if (!td || !KINDS.includes(td.kind) || typeof td.text !== 'string' || !td.text.trim()) continue;
      const key = keyOf(td);
      if (seen.has(key)) continue;
      seen.add(key);
      const id = `todo:${r.message_id}:${key}`;
      const at = done.get(id);
      // ticked off more than a day ago: not „zu tun“ any more
      if (at != null && now - at >= DAY) continue;
      let due = null;
      if (typeof td.date === 'string') {
        due = td.date;
        if (typeof td.time === 'string' && tz.parseTime(td.time)) {
          try { due = todohub.isoIn(tz.at(td.date, tz.parseTime(td.time), p.zone), p.zone); } catch { due = td.date; }
        }
      }
      const amount = td.kind === 'amount' ? money(td.amount, td.currency, p.lang) : null;
      out.push({
        ...base(a), id, kind: 'task', title: td.text, subtitle: t(p.lang, 'notizen.todo_from', { subject: todohub.plain(r.subject, 150) || t(p.lang, 'notizen.no_subject') }),
        due, important: false, done: at != null, canComplete: true, meta: { type: td.kind, ...(amount ? { amount } : {}) },
        open: { plugin: PLUGIN, route: `message/${r.message_id}` }, updatedAt: Math.max(r.at, at || 0),
      });
    }
  }

  // flagged mails, and the ones the hub unflagged within the last day (done)
  const flagged = [];
  for (const uid of who.keys()) {
    flagged.push(...await store.all(gc, `SELECT m.id, m.user_id, m.account_id, m.subject, m.from_name, m.from_email, m.date, f.role FROM messages m
      JOIN folders f ON f.id = m.folder_id WHERE m.user_id = ? AND m.flagged = 1 ORDER BY m.date DESC LIMIT ?`, [uid, FLAGGED_MAX]));
  }
  const unflagged = await store.all(gc, `SELECT d.at AS done_at, m.id, m.user_id, m.account_id, m.subject, m.from_name, m.from_email, m.date, f.role
    FROM todo_done d JOIN messages m ON m.id = d.message_id JOIN folders f ON f.id = m.folder_id
    WHERE d.id LIKE 'flag:%' AND d.at > ? AND m.flagged = 0`, [now - DAY]);
  for (const m of [...flagged, ...unflagged]) {
    const a = accounts.get(m.account_id);
    const p = a && who.get(m.user_id);
    if (!p || OUT_ROLES.includes(m.role)) continue;
    out.push({
      ...base(a), id: `flag:${m.id}`, kind: 'task', title: todohub.plain(m.subject, 200) || t(p.lang, 'notizen.no_subject'),
      subtitle: m.from_name || m.from_email || null, due: null, important: true, done: m.done_at != null, canComplete: true,
      meta: { type: 'flagged', flagged: true }, open: { plugin: PLUGIN, route: `message/${m.id}` }, updatedAt: m.done_at || 0,
    });
  }
  return out;
}

// ─── 1.18.0: events ─────────────────────────────

const safe = (v) => String(v).replace(/[^A-Za-z0-9:._-]/g, '_');

/** One occurrence (calendars.occurrenceView, an item of shares.items or of overlays.items) → the item. */
function eventItem(uid, zone, o, cal) {
  const allDay = !!o.allDay;
  const meta = { type: 'calendar', cal: cal.kind, color: cal.color || null, location: o.location || null, recurring: !!o.recurring, writable: !!cal.writable };
  if (o.eventId) meta.eventId = o.eventId;
  if (allDay) { if (o.endDate && o.endDate !== o.startDate) meta.endDate = o.endDate; } else meta.end = todohub.isoIn(o.end, zone);
  const occ = o.occurrence ? safe(o.occurrence) : null;
  return {
    id: (o.eventId ? `ev:${o.eventId}${occ ? ':' + occ : ''}` : `ov:${safe(o.key)}`).slice(0, 120), kind: 'event', title: todohub.plain(o.title, 200) || '–',
    subtitle: o.location ? todohub.plain(o.location, 200) : null, due: allDay ? o.startDate : todohub.isoIn(o.start, zone), area: cal.area, users: [uid],
    important: false, done: false, canComplete: false, group: { id: cal.key, label: cal.name }, meta,
    open: { plugin: PLUGIN, route: o.eventId ? `event/${o.eventId}${occ ? '/' + occ : ''}` : `calendar/${allDay ? o.startDate : tz.localDate(o.start, zone)}` }, updatedAt: 0,
  };
}

/** May the person see this occurrence on the overview (not cancelled, not declined, an invitation answered)? */
const eventShown = (o) => o.status !== 'cancelled' && o.myResponse !== 'declined' && o.myResponse !== 'needs_action';

/**
 * The events of person `uid` (p: { lang, zone }) from the start of today for EVENT_DAYS days → items. `only`: the
 * occurrences of that one event (what a service call just wrote).
 */
async function eventItems(gc, cfg, uid, p, now, only) {
  if (!cfg.calendar.enabled) return [];
  const today = tz.localDate(now, p.zone);
  const from = tz.at(today, { hh: 0, mm: 0 }, p.zone);
  const to = tz.at(tz.addDays(today, EVENT_DAYS + 1), { hh: 0, mm: 0 }, p.zone);
  const { rows, accounts } = await calendars.visibleRows(gc, cfg, uid);
  const cals = new Map(rows.map((c) => [c.id, { key: `cal:${c.id}`, name: c.name, color: c.color, kind: calendars.kindFor(c, accounts), area: c.kind === 'business' ? 'work' : 'private', writable: c.writable === 1 && c.source !== 'ics' }]));
  const out = [];
  for (const o of await calendars.occurrences(gc, uid, [...cals.keys()], from, to, only ? 5000 : EVENTS_MAX * 2)) {
    if (only && o.eventId !== only) continue;
    if (eventShown(o)) out.push(eventItem(uid, p.zone, o, cals.get(o.calendarId)));
  }
  if (only) return out.slice(0, 40);
  // the GateControl calendars shared with the person that they show — what they may read of them
  if (cfg.calendar.sharing) {
    try {
      const ctx = { userId: uid, lang: p.lang };
      const shares = require('./shares');
      const shared = new Map((await shares.shared(gc, ctx)).items.map((c) => [c.id, c]));
      for (const o of await shares.items(gc, ctx, from, to, null, { owner: true })) {
        const c = shared.get(o.calendarId);
        if (!c || !o.eventId || o.shared === 'freebusy' || !eventShown({ ...o, myResponse: o.ownerResponse })) continue;
        out.push(eventItem(uid, p.zone, o, { key: `cal:${c.id}`, name: c.name, color: c.color, kind: 'shared', area: 'private', writable: false }));
      }
    } catch (e) { gc.log.warn('notizen: shared calendars failed', (e && (e.code || e.message)) || 'error'); }
  }
  // the family calendar of Familie (read through Mail's overlay; Alltag reports its own to the hub)
  try {
    const fam = (await overlays.list(gc, cfg, uid, p.lang)).find((x) => x.id === 'familie');
    if (fam) {
      for (const o of await overlays.items(gc, cfg, uid, ['familie'], from, to, p.lang)) {
        if (o.overlayId === 'familie') out.push(eventItem(uid, p.zone, o, { key: 'overlay:familie', name: fam.name, color: fam.color, kind: 'family', area: 'private', writable: false }));
      }
    }
  } catch { /* Familie answers later */ }
  return out.slice(0, EVENTS_MAX);
}

/** The items of one event of the person as the hub gets them (services.js: the answer of calendar_add / calendar_update). */
async function itemsOfEvent(gc, uid, eventId, now) {
  if (!(await takesEvents(gc))) return [];
  const who = await persons(gc, [uid]);
  const p = who.get(uid);
  if (!p) return [];
  const list = await eventItems(gc, await config.get(gc), uid, p, now, eventId);
  return list.map((x) => source.clean({ ...x, updatedAt: now })).filter(Boolean);
}

/** A to-do of the AI ticked off (or not) in Mail: by message, key and person. */
async function setTodo(gc, userId, messageId, key, done, now) {
  const id = `todo:${messageId}:${key}`;
  if (done) {
    await store.run(gc, `INSERT INTO todo_done (id, user_id, message_id, at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`, [id, userId, messageId, now]);
  } else await store.run(gc, 'DELETE FROM todo_done WHERE id = ?', [id]);
}

/** The keys of a message's to-dos that are ticked off → Set. */
async function doneKeys(gc, messageId) {
  const rows = await store.all(gc, "SELECT id FROM todo_done WHERE message_id = ? AND id LIKE 'todo:%'", [messageId]);
  return new Set(rows.map((r) => r.id.split(':')[2]));
}

async function complete(gc, user, item, done, now) {
  const [kind, raw, key] = item.id.split(':');
  if (kind !== 'todo' && kind !== 'flag') return { ok: false, code: 'read_only' };
  const messageId = Number(raw);
  const m = await store.one(gc, 'SELECT id, user_id FROM messages WHERE id = ?', [messageId]);
  if (!m || m.user_id !== user.id) return { ok: false, code: 'not_found' };
  if (kind === 'todo') {
    await setTodo(gc, user.id, messageId, key, done, now);
    return { ok: true };
  }
  // a flagged mail: the flag cleared (or set again) like in Mail — on the server, then here
  await messages.flags(gc, user.id, { ids: [messageId], flagged: !done });
  if (done) await store.run(gc, 'INSERT INTO todo_done (id, user_id, message_id, at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET at = excluded.at', [`flag:${messageId}`, user.id, messageId, now]);
  else await store.run(gc, 'DELETE FROM todo_done WHERE id = ?', [`flag:${messageId}`]);
  return { ok: true };
}

/** Retention: ticks of mails that are gone, flags cleared more than a day ago. */
async function purge(gc, now) {
  await store.run(gc, 'DELETE FROM todo_done WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = todo_done.message_id)');
  await store.run(gc, "DELETE FROM todo_done WHERE id LIKE 'flag:%' AND at < ?", [now - DAY]);
}

const source = todohub.create({ plugin: PLUGIN, collect, complete, tx: (gc, fn) => store.tx(gc, fn), intervalMs: 60000 });

module.exports = { source, collect, complete, purge, keyOf, setTodo, doneKeys, TODO_DAYS, FLAGGED_MAX, EVENT_DAYS, takesEvents, hubAsked, resetHub, itemsOfEvent };
