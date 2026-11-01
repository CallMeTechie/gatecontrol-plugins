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
const { t } = require('./text');
const { posInt, line, isKnown, parse } = require('./util');

const DRIVE = 'gatecontrol-drive';
const TITLE_MAX = 80;
const NOTE_MAX = 500;
const LIST_MAX = 100;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KEY_RE = /^[A-Za-z0-9:._-]{1,120}$/;

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
async function calendarList(gc, payload, user) {
  const uid = personOf(user, payload);
  const lang = payload.lang === 'en' ? 'en' : 'de';
  const cfg = await config.get(gc);
  if (await blocked(gc, cfg, uid)) return { ok: true, calendars: [] };
  await pimstore.ensureSetup(gc, uid, lang);
  const { rows, accounts } = await calendars.visibleRows(gc, cfg, uid);
  return {
    ok: true,
    calendars: rows.filter(canWrite).slice(0, LIST_MAX).map((c) => ({
      id: c.id, name: c.name, account: accountOf(c.account_id ? accounts.get(c.account_id) : null, lang), color: c.color, writable: true,
    })),
  };
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

/** calendar_add { userId, calendarId, title, startsAt, allDay: true, note?, key? } */
async function calendarAdd(gc, payload, user, caller) {
  const uid = personOf(user, payload);
  const calId = posInt(payload.calendarId);
  const title = line(payload.title);
  if (!calId || !title || typeof payload.title !== 'string' || title.length > TITLE_MAX) throw no('invalid');
  const date = payload.startsAt;
  if (typeof date !== 'string' || !DATE_RE.test(date) || !Number.isFinite(Date.parse(date + 'T00:00:00Z'))) throw no('invalid');
  if (payload.allDay !== undefined && payload.allDay !== true) throw no('invalid');
  if (payload.note != null && (typeof payload.note !== 'string' || payload.note.length > NOTE_MAX)) throw no('invalid');
  if (payload.key != null && (typeof payload.key !== 'string' || !KEY_RE.test(payload.key))) throw no('invalid');
  const cfg = await config.get(gc);
  const why = await blocked(gc, cfg, uid);
  if (why) throw no('unavailable', { reason: why });
  const { rows, accounts } = await calendars.visibleRows(gc, cfg, uid);
  const cal = rows.find((c) => c.id === calId);
  if (!cal || !canWrite(cal)) throw no('not_found');
  if (cal.account_id) {
    const a = accounts.get(cal.account_id);
    if (!a || a.state === 'auth_failed') throw no('unavailable', { reason: 'auth_failed' });
    if (cal.state === 'consent_required') throw no('unavailable', { reason: 'consent_required' });
  }
  const make = async () => {
    if (payload.key) {
      const have = await store.one(gc, 'SELECT k.event_id FROM service_keys k JOIN events e ON e.id = k.event_id AND e.calendar_id = k.calendar_id WHERE k.caller = ? AND k.user_id = ? AND k.calendar_id = ? AND k.key = ?',
        [caller, uid, cal.id, payload.key]);
      if (have) return { ok: true, eventId: have.event_id };
    }
    const lang = payload.lang === 'en' ? 'en' : 'de';
    let r;
    try {
      r = await events.create(gc, { userId: uid, lang, userName: (user && user.name) || '' }, {
        calendarId: cal.id, title, allDay: true, startDate: date, endDate: date, ...(payload.note ? { description: payload.note } : {}),
      });
    } catch (e) {
      const code = isKnown(e) ? e.code : null;
      if (code === 'invalid') throw no('invalid');
      if (code === 'not_found' || code === 'read_only') throw no('not_found');
      throw no('unavailable', { reason: code || 'failed' });
    }
    const eventId = r.event.eventId;
    if (payload.key) {
      await store.run(gc, `INSERT INTO service_keys (caller, user_id, calendar_id, key, event_id, at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(caller, user_id, calendar_id, key) DO UPDATE SET event_id = excluded.event_id, at = excluded.at`, [caller, uid, cal.id, payload.key, eventId, Date.now()]);
    }
    return { ok: true, eventId };
  };
  return payload.key ? serial(`${caller}|${uid}|${cal.id}|${payload.key}`, make) : make();
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
  const from = 'FROM filing f JOIN attachments t ON t.id = f.attachment_id JOIN messages m ON m.id = f.message_id WHERE f.user_id = ?';
  const n = await store.one(gc, `SELECT COUNT(*) AS n ${from}`, [uid]);
  const top = await store.one(gc, `SELECT t.suggestion_json ${from} ORDER BY m.date DESC, f.id DESC LIMIT 1`, [uid]);
  const first = top ? parse(top.suggestion_json, null) : null;
  const hint = first && typeof first.where === 'string' && first.where.trim() ? first.where.trim().slice(0, 200) : null;
  return { ok: true, count: (n && n.n) || 0, hint };
}

// ─── the hook ───────────────────────────────────

const HANDLERS = {
  calendar_list: (gc, payload, user) => calendarList(gc, payload, user),
  calendar_add: (gc, payload, user, caller) => calendarAdd(gc, payload, user, caller),
  tofile_count: (gc, payload, user) => tofileCount(gc, payload, user),
};
const CALLERS = { calendar_list: [DRIVE], calendar_add: [DRIVE], tofile_count: [DRIVE] };

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

module.exports = { handle, DRIVE };
