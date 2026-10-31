'use strict';

// The calendars and address books of a person on the server (Phase 2, migration 004): the first use, the person's
// settings (CalPrefs, CardPrefs), the window of occurrences, storing a calendar object with its occurrences, the live
// events and the bytes. Shared by the API (calendars.js, events.js, cards.js) and the sync (pim.js, pimdav.js,
// pimgraph.js).

const crypto = require('node:crypto');
const store = require('./store');
const config = require('./config');
const ics = require('./ics');
const tz = require('./tz');
const { t } = require('./text');
const { fail, parse, bytesOf, COLOR_RE, PALETTE, DAY } = require('./util');

const PRIVATE_COLOR = '#46E0A0';
const BUSINESS_COLOR = '#79B8FF';
const VIEWS = ['day', '3day', 'week', 'month', 'list'];
const LIVE_MS = 5000;
const EVENTS_MAX = 20000;          // per calendar
const CALENDARS_MAX = 20;          // own calendars per person
const ATTENDEES_MAX = 100;

const liveAt = new Map();          // 'cal:<id>' → ms of the last live event during a sync

// ─── settings ───────────────────────────────────

/** The CalPrefs of a person (with the overlays' own settings in `overlays`). */
async function calPrefs(gc, userId, cfg) {
  const c = cfg || await config.get(gc);
  const r = await store.one(gc, 'SELECT json FROM cal_prefs WHERE user_id = ?', [userId]);
  const j = r ? parse(r.json, {}) : {};
  const out = {
    defaultCalendarId: Number.isSafeInteger(j.defaultCalendarId) ? j.defaultCalendarId : null,
    view: VIEWS.includes(j.view) ? j.view : '3day', weekStart: j.weekStart === 0 ? 0 : 1, workWeek: j.workWeek === true,
    timeZone: typeof j.timeZone === 'string' && tz.valid(j.timeZone) ? j.timeZone : 'Europe/Berlin', reminders: j.reminders !== false,
    defaultReminder: j.defaultReminder === undefined ? c.calendar.defaultReminder : (j.defaultReminder === null || (Number.isInteger(j.defaultReminder) && j.defaultReminder >= 0 && j.defaultReminder <= 40320) ? j.defaultReminder : 15),
    allDayReminder: Number.isInteger(j.allDayReminder) && j.allDayReminder >= 0 && j.allDayReminder <= 10080 ? j.allDayReminder : 1080,
  };
  return { prefs: out, overlays: j.overlays && typeof j.overlays === 'object' ? j.overlays : {}, setup: j.setup === true };
}

async function saveCalPrefs(gc, userId, prefs, overlays, setup) {
  // `custom`: calendars of accounts renamed / coloured in GateControl (the provider's name stays out) — kept
  const old = await store.one(gc, 'SELECT json FROM cal_prefs WHERE user_id = ?', [userId]);
  const custom = prefs.custom || (old ? parse(old.json, {}).custom : null) || [];
  const json = JSON.stringify({ ...prefs, custom, overlays: overlays || {}, setup: setup !== false });
  await store.run(gc, `INSERT INTO cal_prefs (user_id, json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`, [userId, json, Date.now()]);
}

/** The person's time zone (CalPrefs.timeZone). */
async function zoneOf(gc, userId) {
  return (await calPrefs(gc, userId)).prefs.timeZone;
}

/** The CardPrefs of a person. */
async function cardPrefs(gc, userId) {
  const r = await store.one(gc, 'SELECT json FROM card_prefs WHERE user_id = ?', [userId]);
  const j = r ? parse(r.json, {}) : {};
  return {
    sort: j.sort === 'given' ? 'given' : 'family', show: j.show === 'family_given' ? 'family_given' : 'given_family',
    defaultAddressbookId: Number.isSafeInteger(j.defaultAddressbookId) ? j.defaultAddressbookId : null, birthdays: j.birthdays !== false,
  };
}

async function saveCardPrefs(gc, userId, p) {
  await store.run(gc, `INSERT INTO card_prefs (user_id, json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`, [userId, JSON.stringify(p), Date.now()]);
}

/** The person's own mail addresses (their accounts). */
async function ownAddresses(gc, userId) {
  return new Set((await store.all(gc, 'SELECT email FROM accounts WHERE user_id = ?', [userId])).map((r) => String(r.email).toLowerCase()));
}

// ─── the first use ──────────────────────────────

/**
 * The first calendar or contacts call of a person: the local calendars „Privat“ (default) and „Firma“ (not with the
 * administrator's business: 'exchange' and a Microsoft 365 account — then that one's default calendar is business) and
 * the address book „Meine Kontakte“ (default).
 */
async function ensureSetup(gc, userId, lang) {
  const cfg = await config.get(gc);
  const have = await calPrefs(gc, userId, cfg);
  if (have.setup) return false;
  return store.tx(gc, async () => {
    const again = await store.one(gc, 'SELECT json FROM cal_prefs WHERE user_id = ?', [userId]);
    if (again && parse(again.json, {}).setup === true) return false;
    const now = Date.now();
    let defaultId = null;
    if (!(await store.one(gc, "SELECT id FROM calendars WHERE user_id = ? AND source = 'local' LIMIT 1", [userId]))) {
      const r = await store.run(gc, `INSERT INTO calendars (user_id, account_id, source, name, color, kind, writable, is_default, sort, state, synced_at, created_at)
        VALUES (?, NULL, 'local', ?, ?, 'private', 1, 1, 0, 'ok', ?, ?)`, [userId, t(lang, 'cal.private'), PRIVATE_COLOR, now, now]);
      defaultId = Number(r.lastInsertRowid);
      const m365 = await store.one(gc, "SELECT id FROM accounts WHERE user_id = ? AND provider = 'm365' LIMIT 1", [userId]);
      if (!(cfg.calendar.business === 'exchange' && m365)) {
        await store.run(gc, `INSERT INTO calendars (user_id, account_id, source, name, color, kind, writable, is_default, sort, state, synced_at, created_at)
          VALUES (?, NULL, 'local', ?, ?, 'business', 1, 0, 1, 'ok', ?, ?)`, [userId, t(lang, 'cal.business'), BUSINESS_COLOR, now, now]);
      }
    }
    if (!(await store.one(gc, "SELECT id FROM addressbooks WHERE user_id = ? AND source = 'local' LIMIT 1", [userId]))) {
      const b = await store.run(gc, `INSERT INTO addressbooks (user_id, account_id, source, name, writable, is_default, state, synced_at, created_at)
        VALUES (?, NULL, 'local', ?, 1, 1, 'ok', ?, ?)`, [userId, t(lang, 'book.default'), now, now]);
      const cp = await cardPrefs(gc, userId);
      if (!cp.defaultAddressbookId) await saveCardPrefs(gc, userId, { ...cp, defaultAddressbookId: Number(b.lastInsertRowid) });
    }
    await saveCalPrefs(gc, userId, { ...have.prefs, defaultCalendarId: have.prefs.defaultCalendarId || defaultId }, have.overlays, true);
    return true;
  });
}

// ─── calendars ──────────────────────────────────

async function calendarsOf(gc, userId) {
  return store.all(gc, 'SELECT * FROM calendars WHERE user_id = ? ORDER BY CASE source WHEN \'local\' THEN 0 ELSE 1 END, account_id, sort, id', [userId]);
}

/** A calendar of the person (404 for anyone else's). */
async function ownCalendar(gc, userId, id) {
  const c = Number.isSafeInteger(id) ? await store.one(gc, 'SELECT * FROM calendars WHERE id = ? AND user_id = ?', [id, userId]) : null;
  if (!c) throw fail('not_found');
  return c;
}

/** The person's default calendar (CalPrefs, else the first writable). */
async function defaultCalendar(gc, userId, kind) {
  const { prefs } = await calPrefs(gc, userId);
  const all = (await calendarsOf(gc, userId)).filter((c) => c.writable === 1);
  if (kind) { const k = all.find((c) => c.kind === kind && c.is_default) || all.find((c) => c.kind === kind && c.source === 'local') || all.find((c) => c.kind === kind); if (k) return k; }
  return all.find((c) => c.id === prefs.defaultCalendarId) || all.find((c) => c.is_default === 1 && c.source === 'local') || all[0] || null;
}

/** The next free colour for a new calendar of the person. */
async function nextColor(gc, userId) {
  const used = (await calendarsOf(gc, userId)).map((c) => c.color);
  return PALETTE.find((c) => !used.includes(c)) || PALETTE[used.length % PALETTE.length];
}

const colorArg = (v) => (typeof v === 'string' && COLOR_RE.test(v) ? v.toUpperCase() : null);

// ─── the window ─────────────────────────────────

/** The window of stored occurrences: −13 … +24 months around `now` (month starts, UTC). */
function windowOf(now = Date.now()) {
  const d = new Date(now);
  return { from: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 13, 1), to: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 24, 1) };
}

// ─── events from calendar objects ───────────────

/** The fields of the row of an event from its parsed object. */
function rowFields(o, f, text) {
  return {
    uid: o.uid, title: f.title, location: f.location, online_url: f.online ? f.online.url : null, description: f.description || null, start: f.start, end: f.end,
    all_day: f.allDay ? 1 : 0, tz: f.tz, rrule: f.rrule, status: f.status, busy: f.busy, private: f.private ? 1 : 0,
    organizer_json: f.organizer ? JSON.stringify(f.organizer) : null, attendees_json: JSON.stringify(f.attendees.slice(0, ATTENDEES_MAX)),
    reminders_json: JSON.stringify(f.reminders), my_response: f.myResponse, sequence: f.sequence, ics: text, bytes: bytesOf(text),
  };
}

/** The overrides that differ from the series in a stored occurrence (override_json). */
function overrideOf(ov) {
  if (!ov) return null;
  return JSON.stringify({ title: ov.title, location: ov.location, status: ov.status, busy: ov.busy, myResponse: ov.myResponse, online: ov.online, reminders: ov.reminders,
    private: ov.private, attendees: ov.attendees.length, timeZone: ov.tz });
}

/** Write the occurrences of event row `ev` (an object `o` of a parsed file) in the window. */
async function writeOccurrences(gc, ev, o, ctx, win) {
  const w = win || windowOf();
  const list = ics.expand(o, ctx, w.from, w.to);
  await store.run(gc, 'DELETE FROM occurrences WHERE event_id = ?', [ev.id]);
  for (const x of list) {
    await store.run(gc, `INSERT OR REPLACE INTO occurrences (event_id, occ, user_id, calendar_id, start, end, all_day, remote_id, override_json) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      [ev.id, x.occ, ev.user_id, ev.calendar_id, x.start, x.end, x.allDay ? 1 : 0, overrideOf(x.override)]);
  }
  return list.length;
}

/**
 * Store calendar object `text` (one UID) in calendar row `cal` → the event row ({ created }). x: { href, etag, remoteId,
 * pending, baseIcs } (CalDAV / ICS). The fields and occurrences follow from the text (ical.js).
 */
async function storeObject(gc, cal, text, x = {}) {
  const userTz = await zoneOf(gc, cal.user_id);
  const own = await ownAddresses(gc, cal.user_id);
  const p = ics.parse(text);
  const o = x.uid ? (p.objects.find((y) => y.uid === x.uid) || p.objects[0]) : p.objects[0];
  if (!o) throw fail('invalid_ics');
  const ctx = { userTz, own, zones: p.zones };
  const f = ics.fieldsOf(o.master || o.overrides[0], ctx);
  const cols = rowFields(o, f, text);
  const now = Date.now();
  const have = await store.one(gc, 'SELECT * FROM events WHERE calendar_id = ? AND uid = ?', [cal.id, o.uid]);
  let id;
  if (have) {
    await store.run(gc, `UPDATE events SET title = ?, location = ?, online_url = ?, description = ?, start = ?, end = ?, all_day = ?, tz = ?, rrule = ?, status = ?, busy = ?,
      private = ?, organizer_json = ?, attendees_json = ?, reminders_json = ?, my_response = ?, sequence = ?, ics = ?, bytes = ?, href = COALESCE(?, href), etag = ?,
      remote_id = COALESCE(?, remote_id), pending = ?, base_ics = ?, updated_at = ? WHERE id = ?`,
    [cols.title, cols.location, cols.online_url, cols.description, cols.start, cols.end, cols.all_day, cols.tz, cols.rrule, cols.status, cols.busy, cols.private,
      cols.organizer_json, cols.attendees_json, cols.reminders_json, cols.my_response, cols.sequence, cols.ics, cols.bytes, x.href || null, x.etag === undefined ? have.etag : x.etag,
      x.remoteId || null, x.pending || null, x.baseIcs || null, now, have.id]);
    id = have.id;
  } else {
    const n = await store.one(gc, 'SELECT COUNT(*) AS n FROM events WHERE calendar_id = ?', [cal.id]);
    if (n.n >= EVENTS_MAX) throw fail('limit', { max: EVENTS_MAX });
    const r = await store.run(gc, `INSERT INTO events (user_id, calendar_id, uid, remote_id, href, etag, ics, title, location, online_url, description, start, end, all_day, tz, rrule,
      status, busy, private, organizer_json, attendees_json, reminders_json, my_response, sequence, pending, base_ics, bytes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [cal.user_id, cal.id, o.uid, x.remoteId || null, x.href || null, x.etag || null, cols.ics, cols.title, cols.location, cols.online_url, cols.description, cols.start, cols.end,
      cols.all_day, cols.tz, cols.rrule, cols.status, cols.busy, cols.private, cols.organizer_json, cols.attendees_json, cols.reminders_json, cols.my_response, cols.sequence,
      x.pending || null, x.baseIcs || null, cols.bytes, now, now]);
    id = Number(r.lastInsertRowid);
  }
  const ev = await store.one(gc, 'SELECT * FROM events WHERE id = ?', [id]);
  await writeOccurrences(gc, ev, o, ctx);
  return { ...ev, created: !have };
}

/** Remove event row `ev` here (its occurrences, reminders; an invitation keeps no link to it). */
async function dropEvent(gc, ev) {
  await store.run(gc, 'DELETE FROM occurrences WHERE event_id = ?', [ev.id]);
  await store.run(gc, 'DELETE FROM reminders_sent WHERE event_id = ?', [ev.id]);
  await store.run(gc, 'UPDATE invitations SET event_id = NULL WHERE event_id = ?', [ev.id]);
  await store.run(gc, 'DELETE FROM events WHERE id = ?', [ev.id]);
}

/** Remove calendar row `cal` with everything in it. */
async function dropCalendar(gc, cal) {
  const ids = (await store.all(gc, 'SELECT id FROM events WHERE calendar_id = ?', [cal.id])).map((r) => r.id);
  for (const part of store.chunks(ids)) {
    const m = store.marks(part.length);
    await store.run(gc, `DELETE FROM occurrences WHERE event_id IN (${m})`, part);
    await store.run(gc, `DELETE FROM reminders_sent WHERE event_id IN (${m})`, part);
    await store.run(gc, `UPDATE invitations SET event_id = NULL WHERE event_id IN (${m})`, part);
  }
  await store.run(gc, 'DELETE FROM events WHERE calendar_id = ?', [cal.id]);
  await store.run(gc, 'DELETE FROM calendars WHERE id = ?', [cal.id]);
  try { await gc.settings.setSecret(`ics.${cal.id}`, null); } catch { /* none */ }
}

/** A new uid for an own event. */
const newUid = () => `${crypto.randomUUID()}@gatecontrol`;

// ─── live events ────────────────────────────────

/** Calendar `cal` changed: version + 1 and the live event `calendar` { kind: 'changed', calendarId, accountId, from?, to? }. */
async function touchCalendar(gc, cal, range, o = {}) {
  await store.run(gc, 'UPDATE calendars SET version = version + 1 WHERE id = ?', [cal.id]);
  if (o.throttle) {
    const k = `cal:${cal.id}`;
    const now = Date.now();
    if (now - (liveAt.get(k) || 0) < LIVE_MS) return;
    liveAt.set(k, now);
  }
  await live(gc, cal.user_id, 'calendar', { kind: 'changed', calendarId: cal.id, accountId: cal.account_id || null, ...(range ? { from: range.from, to: range.to } : {}) });
}

/** A live event to one person (never fails). */
async function live(gc, userId, type, data) {
  try { await gc.events.emit({ users: [userId], type, data }); } catch { /* nobody listening */ }
}

// ─── address books ──────────────────────────────

async function addressbooksOf(gc, userId) {
  return store.all(gc, "SELECT * FROM addressbooks WHERE user_id = ? ORDER BY CASE source WHEN 'local' THEN 0 ELSE 1 END, account_id, id", [userId]);
}

async function ownBook(gc, userId, id) {
  const b = Number.isSafeInteger(id) ? await store.one(gc, 'SELECT * FROM addressbooks WHERE id = ? AND user_id = ?', [id, userId]) : null;
  if (!b) throw fail('not_found');
  return b;
}

/** The person's card counter + 1 (GET cards?since=). */
async function nextCardVersion(gc, userId) {
  await store.run(gc, `INSERT INTO card_versions (user_id, version) VALUES (?, 1) ON CONFLICT(user_id) DO UPDATE SET version = version + 1`, [userId]);
  return (await store.one(gc, 'SELECT version FROM card_versions WHERE user_id = ?', [userId])).version;
}

async function cardVersion(gc, userId) {
  const r = await store.one(gc, 'SELECT version FROM card_versions WHERE user_id = ?', [userId]);
  return r ? r.version : 0;
}

// ─── bytes ──────────────────────────────────────

/** The person's bytes of calendars and contacts (they count to limits.usedBytes). */
async function usage(gc, userId) {
  const e = await store.one(gc, 'SELECT COALESCE(SUM(bytes), 0) AS n FROM events WHERE user_id = ?', [userId]);
  const c = await store.one(gc, 'SELECT COALESCE(SUM(bytes), 0) AS n FROM cards WHERE user_id = ?', [userId]);
  const p = await store.one(gc, 'SELECT COALESCE(SUM(p.bytes), 0) AS n FROM card_photos p JOIN cards c ON c.id = p.card_id WHERE c.user_id = ?', [userId]);
  return Number(e.n) + Number(c.n) + Number(p.n);
}

/** Midnight of `date` in the person's zone. */
const midnight = (date, zone) => tz.toUtc({ ...tz.parseDate(date) }, zone);

module.exports = {
  calPrefs, saveCalPrefs, zoneOf, cardPrefs, saveCardPrefs, ownAddresses, ensureSetup, calendarsOf, ownCalendar, defaultCalendar, nextColor, colorArg,
  windowOf, rowFields, overrideOf, writeOccurrences, storeObject, dropEvent, dropCalendar, newUid, touchCalendar, live, addressbooksOf, ownBook,
  nextCardVersion, cardVersion, usage, midnight, VIEWS, CALENDARS_MAX, EVENTS_MAX, ATTENDEES_MAX, PRIVATE_COLOR, BUSINESS_COLOR, DAY,
};
