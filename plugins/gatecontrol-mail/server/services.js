'use strict';

// Services for other plugins (plugin.json services.provides; GateControl's gc.services). Every answer is JSON ≤ 16 KB; a
// refusal is { ok: false, code } (never thrown), `unavailable` with { reason }.
//
//   new_draft      { files: [{ mediaId, name? }], subject? } → { ok, draftId }   (Drive: „Per Mail senden“, compose.js)
//   calendar_list  { userId, lang? } → { ok: true, calendars: [{ id, name, account: { id, label, kind, email }, color,
//                  writable: true }] }   (1.6.0, caller gatecontrol-drive only) — the calendars the person can write to
//                  and sees (own GateControl calendars: account { id: null, label: 'GateControl', kind: 'local',
//                  email: null }; an account's: label the provider, e.g. „Outlook.com“, kind its provider id). A person
//                  who cannot use Mail (not allowed, no licence, no place, calendars off) has none.
//   calendar_add   { userId, calendarId, title (1–80), startsAt: 'YYYY-MM-DD', allDay: true, note? (≤ 500), key? }
//                  → { ok: true, eventId }   (1.6.0, caller gatecontrol-drive only) — an all-day event in that calendar,
//                  written like POST events (events.create: Microsoft Graph, CalDAV or GateControl's own — the provider
//                  takes it before the answer), with the calendar's all-day reminder (allDayReminder). `key`
//                  ([A-Za-z0-9:._-], ≤ 120) makes it idempotent: the same key of the same person and calendar answers
//                  the event made before while it is there (service_keys).
//                  Codes: forbidden (another caller, or userId is not GateControl's `user` of the call), invalid,
//                  not_found (no such calendar of the person, or one they cannot write to), unavailable { reason }
//                  (feature_off, not_allowed, not_licensed, no_seat, auth_failed, consent_required, unreachable, …).
//   1.15.0 — for Notizen & Aufgaben (a task with a time as an event in the person's calendar „Aufgaben“):
//   calendar_tasks { userId, lang? } → { ok: true, calendar: { id, name, color, created } }   (caller gatecontrol-notizen
//                  only) — the person's calendar „Aufgaben“ (calendars.role = 'tasks'), made on the first call: always a
//                  GateControl calendar of Mail, never one of an account (see HANDBUCH „Kalender Aufgaben“).
//   calendar_add   also for gatecontrol-notizen, and with a time: { …, allDay: false, start, end (ms, end ≥ start,
//                  ≤ 7 days), reminder?: false, busy?: 'busy' | 'free' } — `reminder: false` writes the event without
//                  any reminder (the task reminds itself; otherwise the calendar's default as before). For Notizen the
//                  title may have 255 characters.
//   calendar_update { userId, eventId, title?, start?, end?, note?, busy? } → { ok: true, eventId }   (caller
//                  gatecontrol-notizen only) — changes an event the caller made with calendar_add { key } (service_keys);
//                  only what is given, nothing when it is that already. not_found: no such event of the caller and
//                  person (deleted in the calendar meanwhile — the caller adds it anew).
//   calendar_delete { userId, eventId } → { ok: true, removed }   (caller gatecontrol-notizen only) — removes such an
//                  event; one that is gone already: removed false.
//   ms_accounts, ms_tasks_consent, ms_tasks_token (1.12.0, caller gatecontrol-notizen only, maxPerHour 600 each) — the
//                  person's Microsoft accounts for the move from Microsoft To Do; see msAccounts / msTasksConsent /
//                  msTasksToken below.
//   1.18.0 — for Notizen & Aufgaben („Termin“ in its quick entry: a real event in a calendar of the person):
//   calendar_list  also for gatecontrol-notizen, and then EVERY calendar the person sees: { ok: true, calendars: [{ id,
//                  key, name, color, kind: own | shared | family | subscribed | tasks, writable, isDefault, area,
//                  account: { label, kind } }], defaultId, reminders: { timed, allDay }, timeZone } — `key` is the
//                  group of the calendar's events in the hub ('cal:<id>'; the family calendar of Familie:
//                  'overlay:familie' with id null); writable: calendar_add takes it; defaultId: the calendar a new
//                  event goes into (CalPrefs); reminders: the person's defaults in minutes (null: none; allDay: before
//                  midnight of the day, 360 = 18:00 the day before). No addresses. A person who cannot use the
//                  calendars: { ok: true, calendars: [], reason } (feature_off, not_allowed, not_licensed, no_seat).
//   calendar_add   for gatecontrol-notizen also: no calendarId (or null) — the person's default calendar; endsAt
//                  ('YYYY-MM-DD', the last day of an all-day event, ≤ 7 days); location (≤ 255); reminder: false | minutes
//                  before (0 … 40320) — without it the calendar's default; recurrence (as POST events: { freq, interval?,
//                  byDay?, byMonthDay?, until?, count? }); items: true — the answer is { ok, eventId, calendarId, items,
//                  replayed? } with the event as the hub's items (notizen.js) and replayed: true when the key
//                  answered an event made before. A key without calendarId finds that event in whatever calendar it is.
//   calendar_update also: location (null removes it), allDay: true with startsAt / endsAt, reminder, recurrence (null: no
//                  series any more), items: true as calendar_add; with calendar_delete keyKind: 'event' — only an event
//                  made with a key 'event:…' (else not_found / removed: false), never the entry of a task.
//   1.16.0 — for the Messenger („Neuer Chat“: the section „Aus deinem Adressbuch“):
//   contacts_phones { userId, q?, cursor?, limit?, ids? } → { ok: true, items: [{ id, name, phones: [{ key, kind, value,
//                  e164, landline }] }], next }   (caller gatecontrol-messenger only, read only) — the person's OWN
//                  contacts with at least one phone number, as „Kontakte“ lists them (linked ones under their main
//                  contact, visible address books only), sorted like there. `q` searches name, company and number
//                  digits; `ids` (≤ 50) answers just those contacts (the one tapped). kind: mobile | work | home | other
//                  (fax numbers are left out); key: kind, the second of a kind `<kind>-2` …; e164: the number with +
//                  and the country code (a national 0 → +49), null when it cannot be read; landline: true when the
//                  number is a landline by its prefix (+49 not 15x/16x/17x, +43 not 6xx, +41 not 75x–79x), false for a
//                  mobile one, null unknown. A page holds up to `limit` (≤ 100, default 50) and stays within the 16 KB
//                  of an answer; `next` continues. Codes: forbidden, invalid, unavailable { reason } (feature_off —
//                  contacts switched off —, not_allowed, not_licensed, no_seat).
//   tofile_count   { userId } → { ok: true, count, hint }   (1.7.0, caller gatecontrol-drive only) — the attachments of
//                  "Zum Ablegen" (GET filing) of the person: how many, and the folder Drive suggested for the newest one
//                  („Familie › Versicherungen“, null without). Drive's overview shows it under "Zu erledigen".
//                  Codes: forbidden, unavailable { reason } (not_allowed, not_licensed, no_seat).

const store = require('./store');
const config = require('./config');
const seats = require('./seats');
const people = require('./people');
const providers = require('./providers');
const compose = require('./compose');
const calendars = require('./calendars');
const events = require('./events');
const pimstore = require('./pimstore');
const accounts = require('./accounts');
const ms = require('./microsoft');
const { t } = require('./text');
const notizen = require('./notizen');
const tz = require('./tz');
const { posInt, line, isKnown, parse } = require('./util');

const DRIVE = 'gatecontrol-drive';
const NOTIZEN = 'gatecontrol-notizen';
const MESSENGER = 'gatecontrol-messenger';
const TITLE_MAX = 80;
const NOTE_MAX = 500;
const LIST_MAX = 100;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KEY_RE = /^[A-Za-z0-9:._-]{1,120}$/;
const TITLE_MAX_TASK = 255; // Notizen & Aufgaben: a task's title (events take 255)
const SPAN_MAX = 7 * 86400000;
const BUSY = ['busy', 'free'];
const TASKS_ROLE = 'tasks';
const LOCATION_MAX = 255;
const REMINDER_MAX = 40320;

class Refusal extends Error { constructor(code, extra) { super(code); this.code = code; this.extra = extra || null; } }
const no = (code, extra) => new Refusal(code, extra);
const refuse = (code, extra) => ({ ok: false, code, ...(extra || {}) });

/** The person of a calendar call: GateControl's `user`, and payload.userId must be the same. */
function personOf(user, payload) {
  const uid = user && posInt(user.id);
  if (!uid || posInt(payload.userId) !== uid) throw no('forbidden');
  return uid;
}

/** Why person `uid` cannot use Mail's calendars now (null: they can) — nothing is taken from the licence here. */
async function blocked(gc, cfg, uid) {
  if (!cfg.calendar.enabled) return 'feature_off';
  if (!(await config.allowed(gc, cfg, uid))) return 'not_allowed';
  if (!(await people.licence(gc)).valid) return 'not_licensed';
  const s = await seats.get(gc, uid);
  return s && s.kind !== 'none' ? null : 'no_seat';
}

/** An account row → { id, label, kind, email } (label: the provider; any other IMAP account: its domain). */
function accountOf(a, lang) {
  if (!a) return { id: null, label: t(lang, 'p.c.group_gc'), kind: 'local', email: null };
  const p = providers.get(a.provider);
  const label = p && typeof p.label === 'string' ? p.label : String(a.email || '').split('@')[1] || a.email;
  return { id: a.id, label, kind: a.provider, email: a.email };
}

const canWrite = (c) => c.writable === 1 && c.source !== 'ics';

/** calendar_list { userId, lang? } */
async function calendarList(gc, payload, user, caller) {
  const uid = personOf(user, payload);
  const lang = payload.lang === 'en' ? 'en' : 'de';
  const cfg = await config.get(gc);
  const why = await blocked(gc, cfg, uid);
  if (why) return { ok: true, calendars: [], ...(caller === NOTIZEN ? { reason: why } : {}) };
  await pimstore.ensureSetup(gc, uid, lang);
  const { rows, accounts } = await calendars.visibleRows(gc, cfg, uid);
  if (caller === NOTIZEN) return calendarListAll(gc, cfg, uid, lang, rows, accounts);
  return {
    ok: true,
    calendars: rows.filter(canWrite).slice(0, LIST_MAX).map((c) => ({
      id: c.id, name: c.name, account: accountOf(c.account_id ? accounts.get(c.account_id) : null, lang), color: c.color, writable: true,
    })),
  };
}

/** The calendar a new event of the person goes into: their default (CalPrefs) when they see it and can write, else the first such one — never „Aufgaben“. */
async function defaultOf(gc, uid, rows) {
  const ok = rows.filter((c) => canWrite(c) && c.role !== TASKS_ROLE);
  const def = await pimstore.defaultCalendar(gc, uid);
  return (def && ok.find((c) => c.id === def.id)) || ok[0] || null;
}

/** calendar_list for Notizen & Aufgaben (1.18.0): every calendar the person sees, the default and the default reminders. */
async function calendarListAll(gc, cfg, uid, lang, rows, accounts) {
  const { prefs } = await pimstore.calPrefs(gc, uid, cfg);
  const def = await defaultOf(gc, uid, rows);
  const list = rows.slice(0, LIST_MAX).map((c) => {
    const a = accountOf(c.account_id ? accounts.get(c.account_id) : null, lang);
    return {
      id: c.id, key: `cal:${c.id}`, name: c.name, color: c.color, kind: calendars.kindFor(c, accounts), writable: canWrite(c), isDefault: !!def && def.id === c.id,
      area: c.kind === 'business' ? 'work' : 'private', account: { label: a.label, kind: a.kind },
    };
  });
  if (cfg.calendar.sharing) {
    try {
      for (const c of (await require('./shares').shared(gc, { userId: uid, lang })).items) {
        if (!c.visible || c.level === 'freebusy' || list.length >= LIST_MAX) continue;
        list.push({ id: c.id, key: `cal:${c.id}`, name: c.name, color: c.color, kind: 'shared', writable: false, isDefault: false, area: 'private', account: { label: t(lang, 'p.c.group_gc'), kind: 'local' } });
      }
    } catch { /* the shared ones are optional */ }
  }
  try {
    const fam = (await require('./overlays').list(gc, cfg, uid, lang)).find((x) => x.id === 'familie');
    if (fam && list.length < LIST_MAX) list.push({ id: null, key: 'overlay:familie', name: fam.name, color: fam.color, kind: 'family', writable: false, isDefault: false, area: 'private', account: { label: t(lang, 'p.c.group_gc'), kind: 'local' } });
  } catch { /* Familie answers later */ }
  return { ok: true, calendars: list, defaultId: def ? def.id : null, reminders: { timed: prefs.defaultReminder, allDay: prefs.allDayReminder }, timeZone: prefs.timeZone };
}

// one call per key at a time — a second one waits and finds the first one's event
const running = new Map();

async function serial(k, fn) {
  const before = running.get(k) || Promise.resolve();
  const p = before.then(fn, fn);
  const tail = p.catch(() => {});
  running.set(k, tail);
  try { return await p; } finally { if (running.get(k) === tail) running.delete(k); }
}

/** The title of a service call: one line, 1 … max characters (Notizen: 255, anyone else: 80). */
function titleArg(v, caller) {
  const title = line(v);
  if (typeof v !== 'string' || !title || title.length > (caller === NOTIZEN ? TITLE_MAX_TASK : TITLE_MAX)) throw no('invalid');
  return title;
}

/** start / end of an event with a time (ms). */
function spanArg(start, end) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start <= 0 || end < start || end - start > SPAN_MAX) throw no('invalid');
  return { start, end };
}

/** The refusal of the service for an error of events.js. */
function refusalOf(e) {
  const code = isKnown(e) ? e.code : null;
  if (code === 'invalid') return no('invalid');
  if (code === 'not_found' || code === 'read_only') return no('not_found');
  return no('unavailable', { reason: code || 'failed' });
}

/** A date 'YYYY-MM-DD' that exists. */
const dateArg = (v) => { if (typeof v !== 'string' || !DATE_RE.test(v) || !tz.parseDate(v) || !Number.isFinite(Date.parse(v + 'T00:00:00Z'))) throw no('invalid'); return v; };

/** The first and the last day of an all-day event (endsAt: Notizen only, ≤ 7 days). */
function daysArg(payload, caller) {
  const startDate = dateArg(payload.startsAt);
  let endDate = startDate;
  if (payload.endsAt != null) {
    if (caller !== NOTIZEN) throw no('invalid');
    endDate = dateArg(payload.endsAt);
    if (endDate < startDate || tz.diffDays(startDate, endDate) > 7) throw no('invalid');
  }
  return { allDay: true, startDate, endDate };
}

/**
 * What only Notizen & Aufgaben may send with calendar_add / calendar_update (1.18.0): location, reminder (false |
 * minutes), recurrence → the fields of events.create / events.update. `update`: null removes a location or a rule.
 */
function eventArgs(payload, caller, update) {
  const x = {};
  if (payload.reminder !== undefined) {
    if (payload.reminder === false) x.reminders = [];
    else if (caller === NOTIZEN && Number.isInteger(payload.reminder) && payload.reminder >= 0 && payload.reminder <= REMINDER_MAX) x.reminders = [payload.reminder];
    else throw no('invalid');
  }
  if (payload.location !== undefined && !(payload.location === null && !update)) {
    if (caller !== NOTIZEN) throw no('invalid');
    if (payload.location === null) x.location = null;
    else {
      const loc = typeof payload.location === 'string' ? line(payload.location) : '';
      if (!loc || loc.length > LOCATION_MAX) throw no('invalid');
      x.location = loc;
    }
  }
  if (payload.recurrence !== undefined && !(payload.recurrence === null && !update)) {
    if (caller !== NOTIZEN || (payload.recurrence !== null && (typeof payload.recurrence !== 'object' || Array.isArray(payload.recurrence)))) throw no('invalid');
    x.recurrence = payload.recurrence;
  }
  return x;
}

/** What the hub shows of event `eventId` now — for Notizen & Aufgaben only, and never a reason to fail the call. */
async function hubItems(gc, caller, uid, eventId, payload) {
  if (caller !== NOTIZEN) return null;
  notizen.source.soon(gc);
  if (payload.items !== true) return null;
  // a hub that asks for the items takes events (it may not have pulled yet since it was updated)
  await notizen.hubAsked(gc, { accepts: ['calendar'] });
  try { return await notizen.itemsOfEvent(gc, uid, eventId, Date.now()); } catch { return []; }
}

/**
 * calendar_add { userId, calendarId, title, startsAt, allDay: true, note?, key? } | { …, allDay: false, start, end, reminder?, busy? }
 * — for Notizen & Aufgaben also calendarId null (the default calendar), endsAt, location, reminder in minutes, recurrence.
 */
async function calendarAdd(gc, payload, user, caller) {
  const uid = personOf(user, payload);
  const anyCal = caller === NOTIZEN && payload.calendarId == null;
  const calId = anyCal ? null : posInt(payload.calendarId);
  if (!anyCal && !calId) throw no('invalid');
  const title = titleArg(payload.title, caller);
  const timed = payload.allDay === false && payload.start !== undefined;
  let when;
  if (timed) {
    const span = spanArg(payload.start, payload.end);
    when = { allDay: false, start: span.start, end: span.end };
  } else {
    if (payload.allDay !== undefined && payload.allDay !== true) throw no('invalid');
    when = daysArg(payload, caller);
  }
  const more = eventArgs(payload, caller, false);
  if (payload.busy !== undefined && !BUSY.includes(payload.busy)) throw no('invalid');
  if (payload.note != null && (typeof payload.note !== 'string' || payload.note.length > NOTE_MAX)) throw no('invalid');
  if (payload.key != null && (typeof payload.key !== 'string' || !KEY_RE.test(payload.key))) throw no('invalid');
  const cfg = await config.get(gc);
  const why = await blocked(gc, cfg, uid);
  if (why) throw no('unavailable', { reason: why });
  if (anyCal) await pimstore.ensureSetup(gc, uid, payload.lang === 'en' ? 'en' : 'de');
  const { rows, accounts } = await calendars.visibleRows(gc, cfg, uid);
  const cal = anyCal ? await defaultOf(gc, uid, rows) : rows.find((c) => c.id === calId);
  if (!cal || !canWrite(cal)) throw no('not_found');
  if (cal.account_id) {
    const a = accounts.get(cal.account_id);
    if (!a || a.state === 'auth_failed') throw no('unavailable', { reason: 'auth_failed' });
    if (cal.state === 'consent_required') throw no('unavailable', { reason: 'consent_required' });
  }
  const answer = async (eventId, calendarId, replayed) => {
    const items = await hubItems(gc, caller, uid, eventId, payload);
    return { ok: true, eventId, ...(items ? { calendarId, items, ...(replayed ? { replayed: true } : {}) } : {}) };
  };
  const make = async () => {
    if (payload.key) {
      // without a calendar named: the event made with this key before, in whatever calendar it went into then
      const have = anyCal
        ? await store.one(gc, 'SELECT k.event_id, k.calendar_id FROM service_keys k JOIN events e ON e.id = k.event_id AND e.calendar_id = k.calendar_id WHERE k.caller = ? AND k.user_id = ? AND k.key = ? ORDER BY k.at DESC LIMIT 1',
          [caller, uid, payload.key])
        : await store.one(gc, 'SELECT k.event_id, k.calendar_id FROM service_keys k JOIN events e ON e.id = k.event_id AND e.calendar_id = k.calendar_id WHERE k.caller = ? AND k.user_id = ? AND k.calendar_id = ? AND k.key = ?',
          [caller, uid, cal.id, payload.key]);
      if (have) return answer(have.event_id, have.calendar_id, true);
    }
    const lang = payload.lang === 'en' ? 'en' : 'de';
    let r;
    try {
      r = await events.create(gc, { userId: uid, lang, userName: (user && user.name) || '' }, {
        calendarId: cal.id, title, ...when, ...(payload.note ? { description: payload.note } : {}), ...more, ...(payload.busy ? { busy: payload.busy } : {}),
      });
    } catch (e) {
      throw refusalOf(e);
    }
    const eventId = r.event.eventId;
    if (payload.key) {
      await store.run(gc, `INSERT INTO service_keys (caller, user_id, calendar_id, key, event_id, at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(caller, user_id, calendar_id, key) DO UPDATE SET event_id = excluded.event_id, at = excluded.at`, [caller, uid, cal.id, payload.key, eventId, Date.now()]);
    }
    return answer(eventId, cal.id);
  };
  return payload.key ? serial(`${caller}|${uid}|${anyCal ? '*' : cal.id}|${payload.key}`, make) : make();
}

// ─── the calendar „Aufgaben“ for Notizen & Aufgaben (1.15.0) ──

/** calendar_tasks { userId, lang? } → the person's calendar „Aufgaben“ (made on the first call). */
async function calendarTasks(gc, payload, user) {
  const uid = personOf(user, payload);
  const lang = payload.lang === 'en' ? 'en' : 'de';
  const cfg = await config.get(gc);
  const why = await blocked(gc, cfg, uid);
  if (why) throw no('unavailable', { reason: why });
  await pimstore.ensureSetup(gc, uid, lang);
  return serial(`tasks|${uid}`, async () => {
    const have = await store.one(gc, 'SELECT * FROM calendars WHERE user_id = ? AND role = ?', [uid, TASKS_ROLE]);
    if (have) return { ok: true, calendar: { id: have.id, name: have.name, color: have.color, created: false } };
    const now = Date.now();
    const color = await pimstore.nextColor(gc, uid);
    // a GateControl calendar of its own: not the default, after the person's own ones, with no reminders of its own
    const r = await store.run(gc, `INSERT INTO calendars (user_id, account_id, source, name, color, kind, writable, is_default, sort, state, synced_at, created_at, role)
      VALUES (?, NULL, 'local', ?, ?, 'other', 1, 0, 20, 'ok', ?, ?, ?)`, [uid, t(lang, 'cal.tasks'), color, now, now, TASKS_ROLE]);
    await pimstore.live(gc, uid, 'calendar', { kind: 'calendars' });
    return { ok: true, calendar: { id: Number(r.lastInsertRowid), name: t(lang, 'cal.tasks'), color, created: true } };
  });
}

/** The event `eventId` the caller made for the person with a key (service_keys), with its calendar — or null. */
async function keyedEvent(gc, caller, uid, eventId, prefix) {
  const id = posInt(eventId);
  if (!id) throw no('invalid');
  const k = await store.one(gc, `SELECT k.key, k.calendar_id FROM service_keys k JOIN events e ON e.id = k.event_id AND e.calendar_id = k.calendar_id AND e.user_id = k.user_id
    WHERE k.caller = ? AND k.user_id = ? AND k.event_id = ?`, [caller, uid, id]);
  // (1.18.0) prefix: only an event made with a key of that kind — „Termin“ of Notizen ('event:') never reaches the
  // entry of a task in the calendar „Aufgaben“ ('task:'), which the hub keeps in step with the task itself
  if (k && prefix && !String(k.key).startsWith(prefix)) return null;
  return k ? { id, key: k.key, calendarId: k.calendar_id } : null;
}

/** keyKind of calendar_update / calendar_delete (Notizen only, 1.18.0): 'event' — only events made with a key 'event:…'. */
function prefixArg(payload, caller) {
  if (payload.keyKind === undefined) return null;
  if (caller !== NOTIZEN || payload.keyKind !== 'event') throw no('invalid');
  return 'event:';
}

/** calendar_update { userId, eventId, title?, start?, end?, note?, busy? } */
async function calendarUpdate(gc, payload, user, caller) {
  const uid = personOf(user, payload);
  const b = {};
  if (payload.title !== undefined) b.title = titleArg(payload.title, caller);
  if (payload.allDay === true && caller === NOTIZEN) {
    if (payload.start !== undefined || payload.end !== undefined) throw no('invalid');
    Object.assign(b, daysArg(payload, caller));
  } else if (payload.start !== undefined || payload.end !== undefined) Object.assign(b, { allDay: false }, spanArg(payload.start, payload.end));
  Object.assign(b, eventArgs(payload, caller, true));
  if (payload.note !== undefined) {
    if (payload.note !== null && (typeof payload.note !== 'string' || payload.note.length > NOTE_MAX)) throw no('invalid');
    b.description = payload.note || null;
  }
  if (payload.busy !== undefined) { if (!BUSY.includes(payload.busy)) throw no('invalid'); b.busy = payload.busy; }
  const cfg = await config.get(gc);
  const why = await blocked(gc, cfg, uid);
  if (why) throw no('unavailable', { reason: why });
  const ev = await keyedEvent(gc, caller, uid, payload.eventId, prefixArg(payload, caller));
  if (!ev) throw no('not_found');
  const answer = async () => {
    const items = await hubItems(gc, caller, uid, ev.id, payload);
    return { ok: true, eventId: ev.id, ...(items ? { calendarId: ev.calendarId, items } : {}) };
  };
  if (!Object.keys(b).length) return answer();
  return serial(`${caller}|${uid}|${ev.calendarId}|${ev.key}`, async () => {
    try {
      await events.update(gc, { userId: uid, lang: payload.lang === 'en' ? 'en' : 'de', userName: (user && user.name) || '' }, ev.id, { ...b, scope: 'series', sendInvites: false });
    } catch (e) {
      throw refusalOf(e);
    }
    return answer();
  });
}

/** calendar_delete { userId, eventId } */
async function calendarDelete(gc, payload, user, caller) {
  const uid = personOf(user, payload);
  const id = posInt(payload.eventId);
  if (!id) throw no('invalid');
  const prefix = prefixArg(payload, caller);
  // the key goes even when the event went before (deleted in the calendar)
  const k = await store.one(gc, 'SELECT key, calendar_id FROM service_keys WHERE caller = ? AND user_id = ? AND event_id = ?', [caller, uid, id]);
  if (!k || (prefix && !String(k.key).startsWith(prefix))) return { ok: true, removed: false };
  return serial(`${caller}|${uid}|${k.calendar_id}|${k.key}`, async () => {
    const ev = await keyedEvent(gc, caller, uid, id, prefix);
    let removed = false;
    if (ev) {
      try {
        await events.remove(gc, { userId: uid, lang: 'de', userName: (user && user.name) || '' }, ev.id, {});
        removed = true;
      } catch (e) {
        if (!(isKnown(e) && e.code === 'not_found')) throw refusalOf(e);
      }
    }
    await store.run(gc, 'DELETE FROM service_keys WHERE caller = ? AND user_id = ? AND event_id = ?', [caller, uid, id]);
    if (removed && caller === NOTIZEN) notizen.source.soon(gc);
    return { ok: true, removed };
  });
}

/** tofile_count { userId } (since 1.7.0): the attachments to file of the person and the suggestion for the newest. */
async function tofileCount(gc, payload, user) {
  const uid = personOf(user, payload);
  const cfg = await config.get(gc);
  if (!(await config.allowed(gc, cfg, uid))) throw no('unavailable', { reason: 'not_allowed' });
  if (!(await people.licence(gc)).valid) throw no('unavailable', { reason: 'not_licensed' });
  const s = await seats.get(gc, uid);
  if (!s || s.kind === 'none') throw no('unavailable', { reason: 'no_seat' });
  // as GET filing lists them: the newest mail first
  // (1.8.0: without attachments GateControl's virus scan holds back)
  const from = 'FROM filing f JOIN attachments t ON t.id = f.attachment_id JOIN messages m ON m.id = f.message_id WHERE f.user_id = ? AND t.scan_blocked = 0';
  const n = await store.one(gc, `SELECT COUNT(*) AS n ${from}`, [uid]);
  const top = await store.one(gc, `SELECT t.suggestion_json ${from} ORDER BY m.date DESC, f.id DESC LIMIT 1`, [uid]);
  const first = top ? parse(top.suggestion_json, null) : null;
  const hint = first && typeof first.where === 'string' && first.where.trim() ? first.where.trim().slice(0, 200) : null;
  return { ok: true, count: (n && n.n) || 0, hint };
}

// ─── Microsoft To Do for Notizen & Aufgaben (1.12.0) ──────────

/** Why the person cannot use Mail now (null: they can). */
async function mailBlocked(gc, uid) {
  const cfg = await config.get(gc);
  if (!(await config.allowed(gc, cfg, uid))) return 'not_allowed';
  if (!(await people.licence(gc)).valid) return 'not_licensed';
  const s = await seats.get(gc, uid);
  return s && s.kind !== 'none' ? null : 'no_seat';
}

/** The person's own Microsoft account `accountId` (not_found otherwise). */
async function msAccount(gc, uid, accountId) {
  const id = posInt(accountId);
  const a = id ? await store.one(gc, 'SELECT * FROM accounts WHERE id = ? AND user_id = ?', [id, uid]) : null;
  if (!a || !providers.isMicrosoft(a.provider)) throw no('not_found');
  return a;
}

const tasksGranted = (a) => ms.hasScope(ms.grantedScopes(a), config.MS_TASKS_SCOPE);

/** ms_accounts { } (user = the person) → { ok, accounts: [{ id, email, label, kind, tasks }] } — Microsoft accounts only. */
async function msAccounts(gc, payload, user) {
  const uid = user && posInt(user.id);
  if (!uid) throw no('forbidden');
  const why = await mailBlocked(gc, uid);
  if (why) throw no('unavailable', { reason: why });
  const rows = await store.all(gc, 'SELECT * FROM accounts WHERE user_id = ? ORDER BY id', [uid]);
  return {
    ok: true,
    accounts: rows.filter((a) => providers.isMicrosoft(a.provider) && a.state !== 'auth_failed').slice(0, 20)
      .map((a) => ({ id: a.id, email: a.email, label: (providers.get(a.provider) || {}).label || a.email, kind: a.kind === 'business' ? 'business' : 'personal', tasks: tasksGranted(a) })),
  };
}

/**
 * ms_tasks_consent { accountId, deviceId? } — Microsoft's consent to Tasks.ReadWrite for that account (incremental: the
 * account signs in anew by device code with the scope added; its mail goes on meanwhile). Without deviceId → { ok,
 * deviceId, userCode, verificationUri, expiresIn, interval }; with it (one poll, at most every `interval` seconds as Mail's
 * own device sign-in) → { ok, status: 'pending' | 'done' | 'expired' | 'denied', tasks }.
 */
async function msTasksConsent(gc, payload, user) {
  const uid = user && posInt(user.id);
  if (!uid) throw no('forbidden');
  const why = await mailBlocked(gc, uid);
  if (why) throw no('unavailable', { reason: why });
  const a = await msAccount(gc, uid, payload.accountId);
  const ctx = { userId: uid, userName: user.name || '' };
  if (payload.deviceId == null) {
    const d = await accounts.deviceStart(gc, ctx, { accountId: a.id, tasks: true }).catch((e) => { throw no(isKnown(e) ? e.code : 'failed'); });
    return { ok: true, deviceId: d.deviceId, userCode: d.userCode, verificationUri: d.verificationUri, expiresIn: d.expiresIn, interval: d.interval };
  }
  if (typeof payload.deviceId !== 'string') throw no('invalid');
  const r = await accounts.devicePoll(gc, ctx, payload.deviceId).catch((e) => { throw no(isKnown(e) ? e.code : 'failed'); });
  if (r.status === 'done') {
    const now = await store.one(gc, 'SELECT * FROM accounts WHERE id = ?', [r.account ? r.account.id : a.id]);
    const ok = !!now && now.id === a.id && tasksGranted(now);
    return { ok: true, status: ok ? 'done' : 'denied', tasks: ok };
  }
  return { ok: true, status: r.status, tasks: false };
}

/**
 * ms_tasks_token { accountId } → { ok, token, expiresAt (ms), email } — an access token for Microsoft Graph that holds
 * only Tasks.ReadWrite (microsoft.tasksToken). Codes: consent_required (not granted yet: ms_tasks_consent), not_found,
 * unavailable { reason: auth_failed | unreachable | not_allowed | … }.
 */
async function msTasksToken(gc, payload, user) {
  const uid = user && posInt(user.id);
  if (!uid) throw no('forbidden');
  const why = await mailBlocked(gc, uid);
  if (why) throw no('unavailable', { reason: why });
  const a = await msAccount(gc, uid, payload.accountId);
  if (!tasksGranted(a)) throw no('consent_required');
  try {
    const t = await ms.tasksToken(gc, a);
    return { ok: true, token: t.token, expiresAt: t.until, email: a.email };
  } catch (e) {
    const code = isKnown(e) ? e.code : 'failed';
    if (code === 'consent_required') throw no('consent_required');
    throw no('unavailable', { reason: code });
  }
}

// ─── 1.16.0: contacts with phone numbers (Messenger) ─────

const PHONES_PAGE = 50;
const PHONES_PAGE_MAX = 100;
const PHONES_IDS_MAX = 50;
const PHONES_PER_CARD = 8;
const PHONES_ANSWER_MAX = 14000; // the answer of a service stays within 16 KB
const PHONE_KINDS = ['mobile', 'work', 'home', 'other'];
const E164_RE = /^\+[1-9][0-9]{6,14}$/;

/** A number as written in a contact → '+49…' (a national 0 counts as Germany), or null. */
function e164Of(v) {
  let x = String(v || '').replace(/\(0\)/g, '').replace(/[\s\-./()]/g, '');
  if (x.startsWith('00')) x = '+' + x.slice(2);
  else if (/^0[1-9]/.test(x)) x = '+49' + x.slice(1);
  if (!E164_RE.test(x) || x.startsWith('+490')) return null;
  return x;
}
/** Landline by the prefix (true), mobile (false), or not known (null). */
function landlineOf(e164) {
  if (!e164) return null;
  if (e164.startsWith('+49')) return !/^\+491[5-7]/.test(e164);
  if (e164.startsWith('+43')) return !/^\+436/.test(e164);
  if (e164.startsWith('+41')) return !/^\+417[5-9]/.test(e164);
  return null;
}
/** The phones of a card's fields → [{ key, kind, value, e164, landline }]: mobile numbers first, then work, home, other, landlines last. */
function phonesOf(list) {
  const seen = new Map();
  const out = [];
  for (const p of list || []) {
    if (!p || typeof p.value !== 'string' || p.type === 'fax') continue;
    const kind = PHONE_KINDS.includes(p.type) ? p.type : 'other';
    const n = (seen.get(kind) || 0) + 1;
    seen.set(kind, n);
    const value = line(p.value).slice(0, 40);
    if (!value) continue;
    const e164 = e164Of(value);
    out.push({ key: n === 1 ? kind : `${kind}-${n}`, kind, value, e164, landline: kind === 'mobile' && landlineOf(e164) === null ? false : landlineOf(e164) });
  }
  const rank = (p) => (p.landline === true ? 10 : 0) + PHONE_KINDS.indexOf(p.kind);
  return out.map((p, i) => [p, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map((x) => x[0]).slice(0, PHONES_PER_CARD);
}

/** contacts_phones { userId, q?, cursor?, limit?, ids? } */
async function contactsPhones(gc, payload, user) {
  const uid = personOf(user, payload);
  const cards = require('./cards');
  const cardstore = require('./cardstore');
  const cardmerge = require('./cardmerge');
  const vcard = require('./vcard');
  const cfg = await config.get(gc);
  if (!cfg.contacts.enabled) throw no('unavailable', { reason: 'feature_off' });
  const why = await mailBlocked(gc, uid);
  if (why) throw no('unavailable', { reason: why });
  const q = payload.q == null ? '' : payload.q;
  if (typeof q !== 'string' || q.length > 100) throw no('invalid');
  const limit = payload.limit == null ? PHONES_PAGE : posInt(payload.limit);
  if (!limit || limit > PHONES_PAGE_MAX) throw no('invalid');
  let ids = null;
  if (payload.ids != null) {
    if (!Array.isArray(payload.ids) || !payload.ids.length || payload.ids.length > PHONES_IDS_MAX || payload.ids.some((x) => !posInt(x))) throw no('invalid');
    ids = [...new Set(payload.ids.map(posInt))];
  }
  let cur = null;
  if (payload.cursor != null) {
    try { const [k, id] = Buffer.from(String(payload.cursor), 'base64url').toString('utf8').split('\u0000'); cur = Number.isSafeInteger(Number(id)) && Number(id) > 0 ? { key: k, id: Number(id) } : null; } catch { cur = null; }
    if (!cur) throw no('invalid');
  }
  await pimstore.ensureSetup(gc, uid, payload.lang === 'en' ? 'en' : 'de');
  const prefs = await pimstore.cardPrefs(gc, uid);
  const { rows: bookRows } = await cards.books(gc, cfg, uid);
  const bookIds = bookRows.filter((b) => b.visible === 1).map((b) => b.id);
  if (!bookIds.length) return { ok: true, items: [], next: null };
  const where = ['c.user_id = ?', `c.addressbook_id IN (${store.marks(bookIds.length)})`, 'c.link_id IS NULL',
    '(c.id IN (SELECT card_id FROM card_phones WHERE user_id = ?) OR c.id IN (SELECT l.link_id FROM cards l JOIN card_phones p ON p.card_id = l.id WHERE l.user_id = ?))'];
  const args = [uid, ...bookIds, uid, uid];
  if (ids) { where.push(`c.id IN (${store.marks(ids.length)})`); args.push(...ids); }
  const text = q.trim();
  if (text) {
    const like = `%${cardstore.fold(text).replace(/[%_\\]/g, (ch) => '\\' + ch)}%`;
    const raw = `%${text.toLowerCase().replace(/[%_\\]/g, (ch) => '\\' + ch)}%`;
    const digits = text.replace(/\D/g, '');
    where.push(`(c.sort_key LIKE ? ESCAPE '\\' OR LOWER(c.display) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(c.company, '')) LIKE ? ESCAPE '\\'${digits.length >= 3 ? ' OR c.id IN (SELECT card_id FROM card_phones WHERE user_id = ? AND digits LIKE ?)' : ''})`);
    args.push(like, raw, raw);
    if (digits.length >= 3) args.push(uid, `%${vcard.digits(digits) || digits}%`);
  }
  if (cur) { where.push('(c.sort_key > ? OR (c.sort_key = ? AND c.id > ?))'); args.push(cur.key, cur.key, cur.id); }
  const rows = await store.all(gc, `SELECT c.* FROM cards c WHERE ${where.join(' AND ')} ORDER BY c.sort_key, c.id LIMIT ?`, [...args, (ids ? ids.length : limit) + 1]);
  const master = await cardmerge.migrated(gc, uid);
  const books = new Map(bookRows.map((b) => [b.id, b]));
  const items = [];
  let size = 40;
  let last = null;
  let more = rows.length > (ids ? ids.length : limit);
  for (const r of rows.slice(0, ids ? ids.length : limit)) {
    const f = parse(r.fields_json, {});
    let list = f.phones || [];
    // like the card: an account card as the main one (or a person before the move to GC contacts) joins its links in
    const own = books.get(r.addressbook_id);
    if (!(master && own && own.source === 'local')) {
      const links = await store.all(gc, 'SELECT id, fields_json FROM cards WHERE link_id = ? AND user_id = ?', [r.id, uid]);
      if (links.length) {
        const gone = await cards.dismissedOf(gc, r.id);
        for (const l of links) list = list.concat((parse(l.fields_json, {}).phones || []).filter((p) => !gone.has(`${l.id}|phones|${cardstore.valueKey('phones', p)}`)));
        list = cards.uniq(list, (p) => cardstore.valueKey('phones', p));
      }
    }
    const phones = phonesOf(list);
    if (!phones.length) continue;
    const item = { id: r.id, name: cards.nameShown(f, prefs.show) || phones[0].value, phones };
    const n = JSON.stringify(item).length + 1;
    if (size + n > PHONES_ANSWER_MAX && items.length) { more = true; break; }
    size += n;
    items.push(item);
    last = r;
  }
  const next = !ids && more && last ? Buffer.from(`${last.sort_key}\u0000${last.id}`).toString('base64url') : null;
  return { ok: true, items, next };
}

// ─── the hook ───────────────────────────────────

const HANDLERS = {
  calendar_list: (gc, payload, user, caller) => calendarList(gc, payload, user, caller),
  calendar_add: (gc, payload, user, caller) => calendarAdd(gc, payload, user, caller),
  calendar_tasks: (gc, payload, user) => calendarTasks(gc, payload, user),
  calendar_update: (gc, payload, user, caller) => calendarUpdate(gc, payload, user, caller),
  calendar_delete: (gc, payload, user, caller) => calendarDelete(gc, payload, user, caller),
  tofile_count: (gc, payload, user) => tofileCount(gc, payload, user),
  ms_accounts: (gc, payload, user) => msAccounts(gc, payload, user),
  ms_tasks_consent: (gc, payload, user) => msTasksConsent(gc, payload, user),
  ms_tasks_token: (gc, payload, user) => msTasksToken(gc, payload, user),
  contacts_phones: (gc, payload, user) => contactsPhones(gc, payload, user),
};
const CALLERS = { calendar_list: [DRIVE, NOTIZEN], calendar_add: [DRIVE, NOTIZEN], calendar_tasks: [NOTIZEN], calendar_update: [NOTIZEN], calendar_delete: [NOTIZEN], tofile_count: [DRIVE], ms_accounts: [NOTIZEN], ms_tasks_consent: [NOTIZEN], ms_tasks_token: [NOTIZEN], contacts_phones: [MESSENGER] };

/** service({ name, caller, user, payload }) → the answer (see the head of this file). */
async function handle(gc, call) {
  const c = call && typeof call === 'object' ? call : {};
  const payload = c.payload && typeof c.payload === 'object' && !Array.isArray(c.payload) ? c.payload : {};
  if (c.name === 'new_draft') return newDraft(gc, c.user, payload);
  const fn = Object.prototype.hasOwnProperty.call(HANDLERS, c.name) ? HANDLERS[c.name] : null;
  if (!fn) return refuse('not_found');
  if (!CALLERS[c.name].includes(c.caller)) return refuse('forbidden');
  try {
    return await fn(gc, payload, c.user || null, c.caller);
  } catch (e) {
    if (e instanceof Refusal) return refuse(e.code, e.extra);
    gc.log.warn('service failed', c.name, (e && (e.code || e.message)) || 'error');
    return refuse('failed');
  }
}

/** new_draft (since 1.0.0, Drive) — files handed over first. */
async function newDraft(gc, user, payload) {
  const cfg = await config.get(gc);
  if (!user || !(await config.allowed(gc, cfg, user.id))) return refuse('forbidden');
  const { licence, seat } = await seats.access(gc, cfg, user.id, Date.now());
  if (!licence.valid) return refuse('not_licensed');
  if (!seat) return refuse('no_seat');
  return compose.serviceDraft(gc, user, payload);
}

module.exports = { handle, DRIVE, NOTIZEN, MESSENGER, _phonesOf: phonesOf, _e164Of: e164Of };
