'use strict';

// Calendars and contacts of Microsoft accounts through Microsoft Graph (microsoft.js; the scopes Calendars.ReadWrite and
// Contacts.ReadWrite — a missing one shows as consent_required on the calendar or address book, the mail runs on).
//
// Calendars: GET /me/calendars; the default calendar by /me/calendarView/delta in the window −13 … +24 months (UTC, 100
// a page, a page per step, the deltaLink kept; a new round when the window moves on), the others by calendarView in the
// same window, compared by changeKey (gone = deleted). Graph brings the occurrences expanded: a series is one event row
// (remote_id = seriesMasterId) with an occurrence row per instance (its instance id); exceptions carry their own fields.
// Writing: POST /me/calendars/{id}/events, PATCH /me/events/{id} with If-Match, DELETE, cancel; answers accept /
// tentativelyAccept / decline (proposedNewTime). Exchange sends the invitations itself.
//
// Contacts: the contact folders and the default folder, a delta round each; photos (≤ 256 KB) when the changeKey moved;
// POST / PATCH / DELETE /me/contacts/{id}, the photo with PUT …/photo/$value. Graph has no contact lists: groups live in
// GateControl only.

const store = require('./store');
const config = require('./config');
const ms = require('./microsoft');
const tz = require('./tz');
const pimstore = require('./pimstore');
const vcard = require('./vcard');
const { fail, line, clip, htmlText, parse, COLOR_RE } = require('./util');

const PAGE = 100;
const VIEW_PAGES = 30;
const PHOTO_MAX = 256 * 1024;
const RESPONSE = { organizer: 'organizer', accepted: 'accepted', tentativelyAccepted: 'tentative', declined: 'declined', notResponded: 'needs_action', none: 'needs_action' };
const SHOW_AS = { free: 'free', tentative: 'tentative', busy: 'busy', oof: 'oof', workingElsewhere: 'busy', unknown: 'busy' };
const SHOW_OUT = { free: 'free', tentative: 'tentative', busy: 'busy', oof: 'oof' };
const ROLE = { required: 'required', optional: 'optional', resource: 'resource' };
const PATTERN_DAYS = { MO: 'monday', TU: 'tuesday', WE: 'wednesday', TH: 'thursday', FR: 'friday', SA: 'saturday', SU: 'sunday' };
const DAYS_BACK = Object.fromEntries(Object.entries(PATTERN_DAYS).map(([k, v]) => [v, k]));
const INDEX = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', '-1': 'last' };
const INDEX_BACK = { first: 1, second: 2, third: 3, fourth: 4, last: -1 };

/** A Graph request for calendars / contacts: a 403 comes back (consent), the rest like ms.graph. */
const G = (gc, a, method, path, body, extra = {}) => ms.graph(gc, a, method, path, body, { soft403: true, ...extra });

const iso = (ms0) => new Date(ms0).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Graph's dateTimeTimeZone in UTC (Prefer outlook.timezone="UTC") → ms. */
function utcOf(dt) {
  if (!dt || !dt.dateTime) return null;
  const s = String(dt.dateTime).replace(/(\.\d{3})\d*$/, '$1');
  const zone = String(dt.timeZone || 'UTC');
  if (/^utc$/i.test(zone) || /Z$/.test(s)) return Date.parse(/Z$/.test(s) ? s : s + 'Z');
  const iana = tz.resolveTz(zone) || 'UTC';
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) return Date.parse(s);
  return tz.toUtc({ y: +m[1], m: +m[2], d: +m[3], hh: +m[4], mm: +m[5], ss: +m[6] }, iana);
}

const person = (e) => (e && e.emailAddress && e.emailAddress.address ? { name: clip(line(e.emailAddress.name || ''), 120), email: String(e.emailAddress.address).toLowerCase().slice(0, 254) } : null);

/** A Graph event → the fields of an event (like ics.fieldsOf). */
function fieldsOf(x, ctx) {
  const userTz = ctx.userTz || 'Europe/Berlin';
  const allDay = x.isAllDay === true;
  const s = utcOf(x.start);
  const e = utcOf(x.end);
  let startDate = null;
  let endDate = null;
  let start = s;
  let end = e;
  if (allDay) {
    startDate = String((x.start && x.start.dateTime) || '').slice(0, 10);
    const excl = String((x.end && x.end.dateTime) || '').slice(0, 10) || tz.addDays(startDate, 1);
    endDate = excl > startDate ? tz.addDays(excl, -1) : startDate;
    start = pimstore.midnight(startDate, userTz);
    end = pimstore.midnight(tz.addDays(endDate, 1), userTz);
  }
  const organizer = person(x.organizer);
  const attendees = (x.attendees || []).map((a) => {
    const p = person(a);
    return p ? { ...p, role: ROLE[a.type] || 'required', response: RESPONSE[(a.status && a.status.response) || 'none'] === 'organizer' ? 'accepted' : (RESPONSE[(a.status && a.status.response) || 'none'] || 'needs_action') } : null;
  }).filter(Boolean).slice(0, pimstore.ATTENDEES_MAX);
  let myResponse = null;
  if (x.isOrganizer) myResponse = attendees.length ? 'organizer' : 'organizer';
  else if (x.responseStatus && x.responseStatus.response) myResponse = RESPONSE[x.responseStatus.response] || 'needs_action';
  const joinUrl = (x.onlineMeeting && x.onlineMeeting.joinUrl) || x.onlineMeetingUrl || null;
  const html = x.body && x.body.contentType === 'html' ? String(x.body.content || '') : null;
  const text = html != null ? htmlText(html) : String((x.body && x.body.content) || '');
  return {
    title: clip(line(x.subject || ''), 255), location: x.location && x.location.displayName ? clip(line(x.location.displayName), 500) : null,
    description: text.slice(0, 32 * 1024), descriptionHtml: html, start, end: Math.max(start, end || start), allDay, startDate, endDate,
    tz: allDay ? null : (tz.resolveTz(x.originalStartTimeZone || '') || userTz), rrule: null,
    status: x.isCancelled ? 'cancelled' : 'confirmed', busy: SHOW_AS[x.showAs] || 'busy', private: x.sensitivity === 'private' || x.sensitivity === 'confidential',
    organizer, attendees, reminders: x.isReminderOn && Number.isInteger(x.reminderMinutesBeforeStart) ? [x.reminderMinutesBeforeStart] : [],
    sequence: 0, url: x.webLink || null, categories: Array.isArray(x.categories) ? x.categories.slice(0, 20).map(String) : [],
    online: joinUrl ? { url: String(joinUrl).slice(0, 2000), provider: x.onlineMeetingProvider === 'teamsForBusiness' || /teams\.(microsoft|live)\.com/i.test(joinUrl) ? 'teams' : 'other' } : null,
    myResponse,
  };
}

/** The key of a Graph instance: '' for a single event, else the ms (or date) of its original start. */
function occOf(x, f) {
  if (!x.seriesMasterId) return '';
  if (f.allDay) return String((x.originalStart || (x.start && x.start.dateTime) || '')).slice(0, 10) || f.startDate;
  const o = x.originalStart ? Date.parse(String(x.originalStart).replace(/(\.\d{3})\d*/, '$1')) : NaN;
  return String(Number.isFinite(o) ? o : f.start);
}

// ─── calendars ──────────────────────────────────

/** The calendar of the account's row in `cal_prefs` custom names (renamed in GateControl: the provider's name stays out). */
async function customOf(gc, userId) {
  const r = await store.one(gc, 'SELECT json FROM cal_prefs WHERE user_id = ?', [userId]);
  const j = r ? parse(r.json, {}) : {};
  return new Set(Array.isArray(j.custom) ? j.custom : []);
}

/** GET /me/calendars → the calendar rows of account `a` (new ones made, gone ones removed) → rows | 'consent'. */
async function syncCalendars(gc, a) {
  const cfg = await config.get(gc);
  const r = await G(gc, a, 'GET', '/me/calendars?$select=id,name,hexColor,canEdit,isDefaultCalendar&$top=100');
  if (r.status === 403) return 'consent';
  if (r.status >= 400) throw fail('unreachable', { reason: ms.graphError(r) });
  const list = (r.json && r.json.value) || [];
  const have = await store.all(gc, 'SELECT * FROM calendars WHERE account_id = ? AND source = ?', [a.id, 'graph']);
  const custom = await customOf(gc, a.user_id);
  const now = Date.now();
  const seen = new Set();
  for (const [i, x] of list.entries()) {
    if (!x || !x.id) continue;
    seen.add(x.id);
    const isDefault = x.isDefaultCalendar === true;
    const kind = isDefault ? ((a.kind === 'business' || (cfg.calendar.business === 'exchange' && a.provider === 'm365')) ? 'business' : 'private') : 'other';
    const color = typeof x.hexColor === 'string' && COLOR_RE.test(x.hexColor) ? x.hexColor.toUpperCase() : null;
    const row = have.find((c) => c.remote_id === x.id);
    if (row) {
      const keep = custom.has(row.id);
      await store.run(gc, 'UPDATE calendars SET name = ?, color = ?, writable = ?, is_default = ?, kind = ?, sort = ? WHERE id = ?',
        [keep ? row.name : clip(line(x.name || ''), 80) || row.name, keep ? row.color : (color || row.color), x.canEdit === false ? 0 : 1, isDefault ? 1 : 0, kind, i, row.id]);
    } else {
      await store.run(gc, `INSERT INTO calendars (user_id, account_id, source, remote_id, name, color, kind, writable, is_default, sort, state, created_at)
        VALUES (?, ?, 'graph', ?, ?, ?, ?, ?, ?, ?, 'syncing', ?)`,
      [a.user_id, a.id, x.id, clip(line(x.name || ''), 80) || 'Kalender', color || await pimstore.nextColor(gc, a.user_id), kind, x.canEdit === false ? 0 : 1, isDefault ? 1 : 0, i, now]).catch(() => null);
    }
  }
  for (const c of have) if (!seen.has(c.remote_id)) await pimstore.dropCalendar(gc, c);
  return store.all(gc, "SELECT * FROM calendars WHERE account_id = ? AND source = 'graph' ORDER BY sort, id", [a.id]);
}

/** Store Graph instance `x` in calendar `cal` (its event row: the series or the single event) → { changed }. */
async function storeInstance(gc, cal, x, ctx) {
  const f = fieldsOf(x, ctx);
  if (f.start == null) return { changed: false };
  const key = x.seriesMasterId || x.id;
  const uid = `graph:${key}`;
  const occ = occOf(x, f);
  const now = Date.now();
  const exception = x.type === 'exception';
  let ev = await store.one(gc, 'SELECT * FROM events WHERE calendar_id = ? AND uid = ?', [cal.id, uid]);
  const cols = [f.title, f.location, f.online ? f.online.url : null, f.description || null, f.start, f.end, f.allDay ? 1 : 0, f.tz, f.status, f.busy, f.private ? 1 : 0,
    f.organizer ? JSON.stringify(f.organizer) : null, JSON.stringify(f.attendees), JSON.stringify(f.reminders), f.myResponse];
  if (!ev) {
    const r = await store.run(gc, `INSERT INTO events (user_id, calendar_id, uid, remote_id, etag, change_key, title, location, online_url, description, start, end, all_day, tz, status,
      busy, private, organizer_json, attendees_json, reminders_json, my_response, rrule, bytes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [cal.user_id, cal.id, uid, key, x.seriesMasterId ? null : (x['@odata.etag'] || null), x.seriesMasterId ? null : (x.changeKey || null), ...cols, x.seriesMasterId ? 'graph' : null,
      Buffer.byteLength(JSON.stringify(f)), now, now]);
    ev = await store.one(gc, 'SELECT * FROM events WHERE id = ?', [Number(r.lastInsertRowid)]);
  } else if (!exception) {
    // a single event, or an instance as the series has it: the row's fields
    await store.run(gc, `UPDATE events SET title = ?, location = ?, online_url = ?, description = ?, start = MIN(start, ?), end = MAX(end, ?), all_day = ?, tz = ?, status = ?, busy = ?, private = ?,
      organizer_json = ?, attendees_json = ?, reminders_json = ?, my_response = ?, etag = ?, change_key = ?, updated_at = ? WHERE id = ?`,
    [...cols.slice(0, 4), f.start, f.end, ...cols.slice(6), x.seriesMasterId ? ev.etag : (x['@odata.etag'] || ev.etag), x.seriesMasterId ? ev.change_key : (x.changeKey || ev.change_key), now, ev.id]);
    if (!x.seriesMasterId) await store.run(gc, 'UPDATE events SET start = ?, end = ? WHERE id = ?', [f.start, f.end, ev.id]);
  }
  const ov = exception ? pimstore.overrideOf({ ...f, attendees: f.attendees }) : null;
  const cur = await store.one(gc, 'SELECT * FROM occurrences WHERE event_id = ? AND occ = ?', [ev.id, occ]);
  const changed = !cur || cur.start !== f.start || cur.end !== f.end || (cur.override_json || null) !== (ov || null) || cur.remote_id !== x.id;
  await store.run(gc, 'INSERT OR REPLACE INTO occurrences (event_id, occ, user_id, calendar_id, start, end, all_day, remote_id, override_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [ev.id, occ, cal.user_id, cal.id, f.start, f.end, f.allDay ? 1 : 0, x.id, ov]);
  return { changed: changed || ev.updated_at === now, eventId: ev.id };
}

/** An instance is gone (delta @removed, missing from the view) → its occurrence, and the event when none is left. */
async function removeInstance(gc, cal, remoteId) {
  const o = await store.one(gc, 'SELECT o.event_id, o.occ FROM occurrences o WHERE o.calendar_id = ? AND o.remote_id = ?', [cal.id, remoteId]);
  if (o) {
    await store.run(gc, 'DELETE FROM occurrences WHERE event_id = ? AND occ = ?', [o.event_id, o.occ]);
    const left = await store.one(gc, 'SELECT COUNT(*) AS n FROM occurrences WHERE event_id = ?', [o.event_id]);
    if (!left.n) { const ev = await store.one(gc, 'SELECT * FROM events WHERE id = ?', [o.event_id]); if (ev) await pimstore.dropEvent(gc, ev); }
    return true;
  }
  const ev = await store.one(gc, 'SELECT * FROM events WHERE calendar_id = ? AND remote_id = ?', [cal.id, remoteId]);
  if (ev) { await pimstore.dropEvent(gc, ev); return true; }
  return false;
}

/** Occurrences outside the window go (a new round after the window moved). */
async function trimWindow(gc, cal, w) {
  await store.run(gc, 'DELETE FROM occurrences WHERE calendar_id = ? AND (end < ? OR start > ?)', [cal.id, w.from, w.to]);
  for (const ev of await store.all(gc, 'SELECT e.* FROM events e WHERE e.calendar_id = ? AND NOT EXISTS (SELECT 1 FROM occurrences o WHERE o.event_id = e.id)', [cal.id])) await pimstore.dropEvent(gc, ev);
}

/**
 * One step of the default calendar's delta round → { changed, more, consent }. A new window (monthly) starts a new round.
 */
async function deltaStep(gc, a, cal, ctx) {
  const w = pimstore.windowOf();
  let url = cal.delta;
  if (!url || cal.window_from !== w.from) {
    if (cal.window_from != null && cal.window_from !== w.from) await trimWindow(gc, cal, w);
    url = `/me/calendarView/delta?startDateTime=${encodeURIComponent(iso(w.from))}&endDateTime=${encodeURIComponent(iso(w.to))}`;
    await store.run(gc, 'UPDATE calendars SET window_from = ?, window_to = ?, delta = NULL WHERE id = ?', [w.from, w.to, cal.id]);
  }
  const r = await G(gc, a, 'GET', url, undefined, { headers: { prefer: `outlook.timezone="UTC", odata.maxpagesize=${PAGE}` } });
  if (r.status === 403) return { consent: true };
  if (r.status === 410 || (r.status === 400 && /sync|delta/i.test(ms.graphError(r)))) {
    await store.run(gc, 'UPDATE calendars SET delta = NULL WHERE id = ?', [cal.id]);
    return { changed: false, more: true };
  }
  if (r.status >= 400) throw fail('unreachable', { reason: ms.graphError(r) });
  const j = r.json || {};
  let changed = false;
  for (const x of j.value || []) {
    if (x['@removed']) { if (await removeInstance(gc, cal, x.id)) changed = true; continue; }
    if ((await storeInstance(gc, cal, x, ctx)).changed) changed = true;
  }
  const next = j['@odata.nextLink'] || null;
  const done = j['@odata.deltaLink'] || null;
  await store.run(gc, "UPDATE calendars SET delta = ?, synced_at = CASE WHEN ? THEN ? ELSE synced_at END, state = CASE WHEN ? THEN 'ok' ELSE state END, error_code = NULL WHERE id = ?",
    [next || done, done ? 1 : 0, Date.now(), done ? 1 : 0, cal.id]);
  return { changed, more: !!next };
}

/** A whole calendarView round of another calendar (compared by changeKey; missing = deleted) → { changed, consent, gone }. */
async function viewRound(gc, a, cal, ctx, guard) {
  const w = pimstore.windowOf();
  let url = `/me/calendars/${encodeURIComponent(cal.remote_id)}/calendarView?startDateTime=${encodeURIComponent(iso(w.from))}&endDateTime=${encodeURIComponent(iso(w.to))}&$top=${PAGE}`;
  const seen = new Set();
  let changed = false;
  for (let i = 0; url && i < VIEW_PAGES; i++) {
    const r = await G(gc, a, 'GET', url, undefined, { headers: { prefer: 'outlook.timezone="UTC"' } });
    if (r.status === 403) return { consent: true };
    if (r.status >= 400) throw fail('unreachable', { reason: ms.graphError(r) });
    const j = r.json || {};
    for (const x of j.value || []) {
      seen.add(x.id);
      const known = await store.one(gc, 'SELECT o.event_id FROM occurrences o JOIN events e ON e.id = o.event_id WHERE o.calendar_id = ? AND o.remote_id = ? AND (e.change_key = ? OR e.rrule IS NOT NULL)', [cal.id, x.id, x.changeKey || '']);
      if (known && x.type !== 'exception' && !x.seriesMasterId) continue;
      if ((await storeInstance(gc, cal, x, ctx)).changed) changed = true;
    }
    url = j['@odata.nextLink'] || null;
  }
  const have = await store.all(gc, 'SELECT remote_id FROM occurrences WHERE calendar_id = ? AND remote_id IS NOT NULL', [cal.id]);
  const gone = have.filter((r) => !seen.has(r.remote_id)).map((r) => r.remote_id);
  if (gone.length && guard && !(await guard(cal, gone.length, have.length))) return { changed, held: true };
  for (const id of gone) { await removeInstance(gc, cal, id); changed = true; }
  await store.run(gc, "UPDATE calendars SET synced_at = ?, state = 'ok', error_code = NULL, window_from = ?, window_to = ? WHERE id = ?", [Date.now(), w.from, w.to, cal.id]);
  return { changed };
}

/** The instances of Graph event `id` in the window into calendar `cal` (after a change of a series). */
async function refreshEvent(gc, a, cal, id, ctx) {
  const w = pimstore.windowOf();
  const one = await G(gc, a, 'GET', `/me/events/${encodeURIComponent(id)}`, undefined, { headers: { prefer: 'outlook.timezone="UTC"' } });
  if (one.status === 404) return null;
  if (one.status >= 400) throw fail('unreachable', { reason: ms.graphError(one) });
  const x = one.json || {};
  if (x.type !== 'seriesMaster') { await storeInstance(gc, cal, x, ctx); return store.one(gc, 'SELECT * FROM events WHERE calendar_id = ? AND uid = ?', [cal.id, `graph:${x.id}`]); }
  let url = `/me/events/${encodeURIComponent(id)}/instances?startDateTime=${encodeURIComponent(iso(w.from))}&endDateTime=${encodeURIComponent(iso(w.to))}&$top=${PAGE}`;
  const seen = new Set();
  for (let i = 0; url && i < VIEW_PAGES; i++) {
    const r = await G(gc, a, 'GET', url, undefined, { headers: { prefer: 'outlook.timezone="UTC"' } });
    if (r.status >= 400) throw fail('unreachable', { reason: ms.graphError(r) });
    for (const inst of (r.json && r.json.value) || []) { seen.add(inst.id); await storeInstance(gc, cal, { ...inst, seriesMasterId: inst.seriesMasterId || id }, ctx); }
    url = (r.json && r.json['@odata.nextLink']) || null;
  }
  const ev = await store.one(gc, 'SELECT * FROM events WHERE calendar_id = ? AND uid = ?', [cal.id, `graph:${id}`]);
  if (ev) {
    for (const o of await store.all(gc, 'SELECT occ, remote_id FROM occurrences WHERE event_id = ?', [ev.id])) if (o.remote_id && !seen.has(o.remote_id)) await store.run(gc, 'DELETE FROM occurrences WHERE event_id = ? AND occ = ?', [ev.id, o.occ]);
    await store.run(gc, 'UPDATE events SET etag = ?, change_key = ?, rrule = ? WHERE id = ?', [x['@odata.etag'] || null, x.changeKey || null, recurrenceRule(x.recurrence) || 'graph', ev.id]);
  }
  return ev ? store.one(gc, 'SELECT * FROM events WHERE id = ?', [ev.id]) : null;
}

/** A series master / single event of Graph (for the detail view: recurrence, the HTML body) or null. */
async function master(gc, a, remoteId) {
  const r = await G(gc, a, 'GET', `/me/events/${encodeURIComponent(remoteId)}`, undefined, { headers: { prefer: 'outlook.timezone="UTC", outlook.body-content-type="html"' } });
  if (r.status === 403) throw fail('consent_required', { accountId: a.id, missing: [config.MS_CALENDAR_SCOPE] });
  if (r.status === 404) return null;
  if (r.status >= 400) throw fail('unreachable', { reason: ms.graphError(r) });
  return r.json || null;
}

// ─── recurrence: Graph ↔ RRULE ──────────────────

/** Graph's patternedRecurrence → an RRULE string (null: none). */
function recurrenceRule(rec) {
  if (!rec || !rec.pattern) return null;
  const p = rec.pattern;
  const parts = [];
  const days = (p.daysOfWeek || []).map((d) => DAYS_BACK[d]).filter(Boolean);
  switch (p.type) {
    case 'daily': parts.push('FREQ=DAILY'); break;
    case 'weekly': parts.push('FREQ=WEEKLY'); if (days.length) parts.push(`BYDAY=${days.join(',')}`); break;
    case 'absoluteMonthly': parts.push('FREQ=MONTHLY', `BYMONTHDAY=${p.dayOfMonth}`); break;
    case 'relativeMonthly': parts.push('FREQ=MONTHLY', `BYDAY=${days.join(',')}`, `BYSETPOS=${INDEX_BACK[p.index] || 1}`); break;
    case 'absoluteYearly': parts.push('FREQ=YEARLY', `BYMONTH=${p.month}`, `BYMONTHDAY=${p.dayOfMonth}`); break;
    case 'relativeYearly': parts.push('FREQ=YEARLY', `BYMONTH=${p.month}`, `BYDAY=${days.join(',')}`, `BYSETPOS=${INDEX_BACK[p.index] || 1}`); break;
    default: return null;
  }
  if (p.interval > 1) parts.push(`INTERVAL=${p.interval}`);
  const r = rec.range || {};
  if (r.type === 'endDate' && r.endDate) parts.push(`UNTIL=${String(r.endDate).replace(/-/g, '')}`);
  if (r.type === 'numbered' && r.numberOfOccurrences) parts.push(`COUNT=${r.numberOfOccurrences}`);
  return parts.join(';');
}

/** An RRULE string (ics.ruleOf) and the start date → Graph's patternedRecurrence; not_supported for rules Graph lacks. */
function patternOf(rrule, startDate, zone) {
  if (!rrule) return null;
  const kv = Object.fromEntries(rrule.split(';').map((x) => x.split('=')));
  const interval = Number(kv.INTERVAL) || 1;
  const days = kv.BYDAY ? kv.BYDAY.split(',') : [];
  const bad = () => { throw fail('not_supported', { what: 'recurrence' }); };
  const plain = days.map((d) => /^(MO|TU|WE|TH|FR|SA|SU)$/.test(d) ? d : null);
  const pos = days.length === 1 && /^([+-]?\d)(\w\w)$/.exec(days[0]);
  const setpos = kv.BYSETPOS ? Number(kv.BYSETPOS) : (pos ? Number(pos[1]) : null);
  const dayNames = (pos ? [pos[2]] : plain).map((d) => PATTERN_DAYS[d]);
  if (dayNames.some((d) => !d)) bad();
  const month = Number(startDate.slice(5, 7));
  const dom = Number(startDate.slice(8, 10));
  let pattern;
  switch (kv.FREQ) {
    case 'DAILY': pattern = { type: 'daily', interval }; break;
    case 'WEEKLY': pattern = { type: 'weekly', interval, daysOfWeek: dayNames.length ? dayNames : [PATTERN_DAYS[['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][tz.weekday(startDate)]]], firstDayOfWeek: 'monday' }; break;
    case 'MONTHLY':
      if (setpos != null) { if (!INDEX[setpos]) bad(); pattern = { type: 'relativeMonthly', interval, daysOfWeek: dayNames, index: INDEX[setpos] }; } else pattern = { type: 'absoluteMonthly', interval, dayOfMonth: Number(kv.BYMONTHDAY) || dom };
      break;
    case 'YEARLY':
      if (setpos != null) { if (!INDEX[setpos]) bad(); pattern = { type: 'relativeYearly', interval, daysOfWeek: dayNames, index: INDEX[setpos], month: Number(kv.BYMONTH) || month }; } else pattern = { type: 'absoluteYearly', interval, dayOfMonth: Number(kv.BYMONTHDAY) || dom, month: Number(kv.BYMONTH) || month };
      break;
    default: bad();
  }
  const range = { startDate, recurrenceTimeZone: zone || 'UTC' };
  if (kv.UNTIL) Object.assign(range, { type: 'endDate', endDate: `${kv.UNTIL.slice(0, 4)}-${kv.UNTIL.slice(4, 6)}-${kv.UNTIL.slice(6, 8)}` });
  else if (kv.COUNT) Object.assign(range, { type: 'numbered', numberOfOccurrences: Number(kv.COUNT) });
  else range.type = 'noEnd';
  return { pattern, range };
}

// ─── writing events ─────────────────────────────

/** Graph's dateTimeTimeZone of `ms` in `zone` (wall clock). */
function dtz(ms0, zone) {
  const p = tz.parts(ms0, zone || 'UTC');
  return { dateTime: `${tz.dateStr(p.y, p.m, p.d)}T${tz.pad(p.hh)}:${tz.pad(p.mm)}:${tz.pad(p.ss)}`, timeZone: zone || 'UTC' };
}

/** The checked input of POST / PATCH events → a Graph event body (only the given fields). */
function bodyOf(x, o = {}) {
  const b = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(x, k);
  if (has('title')) b.subject = x.title;
  if (has('location')) b.location = { displayName: x.location || '' };
  if (has('description')) b.body = { contentType: 'text', content: x.description || '' };
  if (has('start') || has('startDate') || has('allDay')) {
    if (x.allDay) {
      b.isAllDay = true;
      b.start = { dateTime: `${x.startDate}T00:00:00`, timeZone: o.zone || 'UTC' };
      b.end = { dateTime: `${tz.addDays(x.endDate || x.startDate, 1)}T00:00:00`, timeZone: o.zone || 'UTC' };
    } else {
      b.isAllDay = false;
      const zone = o.windows ? (tz.windowsOf(x.timeZone) || x.timeZone) : x.timeZone;
      b.start = dtz(x.start, x.timeZone); b.start.timeZone = zone;
      b.end = dtz(x.end, x.timeZone); b.end.timeZone = zone;
    }
  }
  if (has('rrule')) {
    const startDate = x.allDay ? x.startDate : (x.start != null ? tz.localDate(x.start, x.timeZone || 'UTC') : o.startDate);
    b.recurrence = x.rrule ? patternOf(x.rrule, startDate, x.allDay ? (o.zone || 'UTC') : x.timeZone) : null;
  }
  if (has('reminders')) {
    if ((x.reminders || []).length > 1) throw fail('not_supported', { what: 'reminders' });
    b.isReminderOn = (x.reminders || []).length === 1;
    if (b.isReminderOn) b.reminderMinutesBeforeStart = x.reminders[0];
  }
  if (has('busy')) b.showAs = SHOW_OUT[x.busy] || 'busy';
  if (has('private')) b.sensitivity = x.private ? 'private' : 'normal';
  if (has('attendees')) b.attendees = (x.attendees || []).map((p) => ({ emailAddress: { address: p.email, ...(p.name ? { name: p.name } : {}) }, type: p.role === 'optional' ? 'optional' : p.role === 'resource' ? 'resource' : 'required' }));
  if (has('online')) {
    if (x.online && x.online.create === 'teams') { b.isOnlineMeeting = true; b.onlineMeetingProvider = 'teamsForBusiness'; } else if (x.online && x.online.url) {
      b.location = { displayName: [x.location || '', x.online.url].filter(Boolean).join(' · ') };
    }
  }
  return b;
}

/** A write to Graph with the IANA zone, again with the Windows name when Graph refuses the zone. */
async function send(gc, a, method, path, x, extra = {}, o = {}) {
  let r = await G(gc, a, method, path, bodyOf(x, o), extra);
  if (r.status === 400 && /timezone|time zone/i.test(JSON.stringify(r.json || {})) && x.timeZone && tz.windowsOf(x.timeZone)) {
    r = await G(gc, a, method, path, bodyOf(x, { ...o, windows: true }), extra);
  }
  return r;
}

const graphFail = (r, a) => {
  if (r.status === 403) return fail('consent_required', { accountId: a.id, missing: [config.MS_CALENDAR_SCOPE] });
  if (r.status === 404) return fail('not_found');
  if (r.status === 412) return fail('conflict');
  return fail(r.status === 400 ? 'invalid' : 'unreachable', { reason: ms.graphError(r) });
};

/** POST a new event into Graph calendar `cal` → the stored event row. */
async function createEvent(gc, a, cal, x, ctx) {
  const r = await send(gc, a, 'POST', `/me/calendars/${encodeURIComponent(cal.remote_id)}/events`, x, { headers: { prefer: 'outlook.timezone="UTC"' } }, { zone: ctx.userTz });
  if (r.status >= 300) throw graphFail(r, a);
  const ev = r.json || {};
  return (await refreshEvent(gc, a, cal, ev.id, ctx)) || null;
}

/**
 * PATCH an event (a series, a single event or one instance `instanceId`) with If-Match → the stored row. 412: the
 * provider's state is fetched; when it did not touch the fields of this change, the change goes again once, else
 * conflict.
 */
async function updateEvent(gc, a, cal, ev, x, ctx, instanceId) {
  const id = instanceId || ev.remote_id;
  const headers = ev.etag && !instanceId ? { 'if-match': ev.etag } : {};
  let r = await send(gc, a, 'PATCH', `/me/events/${encodeURIComponent(id)}`, x, { headers }, { zone: ctx.userTz, startDate: ev.all_day ? null : tz.localDate(ev.start, ev.tz || ctx.userTz) });
  if (r.status === 412) {
    const cur = await master(gc, a, id);
    if (!cur) throw fail('not_found');
    const now = fieldsOf(cur, ctx);
    const base = { title: ev.title, location: ev.location, description: ev.description || '', start: ev.start, end: ev.end };
    const touched = Object.keys(x).filter((k) => k in base);
    const theyChanged = touched.some((k) => (k === 'description' ? (now.description || '') !== (base.description || '') : now[k] !== base[k]));
    if (theyChanged) throw fail('conflict');
    r = await send(gc, a, 'PATCH', `/me/events/${encodeURIComponent(id)}`, x, { headers: cur['@odata.etag'] ? { 'if-match': cur['@odata.etag'] } : {} }, { zone: ctx.userTz });
  }
  if (r.status >= 300) throw graphFail(r, a);
  return refreshEvent(gc, a, cal, ev.remote_id, ctx);
}

/** Delete an event (or one instance): with attendees and `notify` as the organizer through cancel { comment }. */
async function deleteEvent(gc, a, ev, { instanceId, notify, comment, organizer }) {
  const id = instanceId || ev.remote_id;
  let r;
  if (organizer && notify) r = await G(gc, a, 'POST', `/me/events/${encodeURIComponent(id)}/cancel`, { comment: comment || '' });
  else r = await G(gc, a, 'DELETE', `/me/events/${encodeURIComponent(id)}`);
  if (r.status === 404 || r.status === 410) return;
  if (r.status >= 300) throw graphFail(r, a);
}

/** Answer an invitation: accept / tentativelyAccept / decline { comment, sendResponse, proposedNewTime? }. */
async function respond(gc, a, id, response, { comment, send: sendIt = true, propose, zone }) {
  const action = response === 'accepted' ? 'accept' : response === 'tentative' ? 'tentativelyAccept' : 'decline';
  if (propose && action === 'accept') throw fail('not_supported', { what: 'counter' });
  const body = { comment: comment || '', sendResponse: sendIt !== false };
  if (propose) body.proposedNewTime = { start: dtz(propose.start, zone || 'UTC'), end: dtz(propose.end, zone || 'UTC') };
  const r = await G(gc, a, 'POST', `/me/events/${encodeURIComponent(id)}/${action}`, body);
  if (r.status >= 300) throw graphFail(r, a);
}

// ─── contacts ───────────────────────────────────

const CONTACT_SELECT = 'id,changeKey,displayName,givenName,surname,middleName,title,generation,nickName,emailAddresses,mobilePhone,homePhones,businessPhones,companyName,department,jobTitle,homeAddress,businessAddress,otherAddress,birthday,personalNotes,businessHomePage,parentFolderId';

/** A Graph contact → the Card fields (like vcard.fieldsOf). */
function contactFields(x) {
  const emails = (x.emailAddresses || []).map((e, i) => ({ value: String(e.address || '').toLowerCase(), type: 'other', primary: i === 0 })).filter((e) => /^[^\s@]+@[^\s@]+$/.test(e.value)).slice(0, 20);
  const phones = [];
  if (x.mobilePhone) phones.push({ value: clip(line(x.mobilePhone), 40), type: 'mobile' });
  for (const p of x.homePhones || []) if (p) phones.push({ value: clip(line(p), 40), type: 'home' });
  for (const p of x.businessPhones || []) if (p) phones.push({ value: clip(line(p), 40), type: 'work' });
  const adr = (a, type) => (a && (a.street || a.city || a.postalCode || a.countryOrRegion) ? { type, street: clip(line(a.street || ''), 200), postalCode: clip(line(a.postalCode || ''), 20), city: clip(line(a.city || ''), 100), region: clip(line(a.state || ''), 100), country: clip(line(a.countryOrRegion || ''), 100) } : null);
  const addresses = [adr(x.homeAddress, 'home'), adr(x.businessAddress, 'work'), adr(x.otherAddress, 'other')].filter(Boolean);
  const bday = x.birthday ? String(x.birthday).slice(0, 10) : null;
  const given = clip(line(x.givenName || ''), 120);
  const family = clip(line(x.surname || ''), 120);
  return {
    uid: null, version: null,
    name: { display: clip(line(x.displayName || ''), 200) || [given, family].filter(Boolean).join(' ') || (emails[0] ? emails[0].value : ''), given, family, middle: x.middleName || null,
      prefix: x.title || null, suffix: x.generation || null, nickname: x.nickName || null },
    emails, phones: phones.slice(0, 20), company: x.companyName || null, department: x.department || null, title: x.jobTitle || null, addresses,
    birthday: bday && /^\d{4}-\d{2}-\d{2}$/.test(bday) ? (bday.startsWith('1604') ? `--${bday.slice(5)}` : bday) : null, note: String(x.personalNotes || '').slice(0, vcard.NOTE_MAX),
    urls: x.businessHomePage && /^https?:\/\//.test(x.businessHomePage) ? [x.businessHomePage] : [], categories: [], photo: null,
  };
}

/** The Card fields (vcard.check, merged with the current ones) → a Graph contact body. */
function contactBody(f) {
  const n = f.name || {};
  const phones = f.phones || [];
  const adr = (type) => { const a = (f.addresses || []).find((x) => x.type === type); return a ? { street: a.street, city: a.city, state: a.region, postalCode: a.postalCode, countryOrRegion: a.country } : {}; };
  return {
    givenName: n.given || '', surname: n.family || '', middleName: n.middle || '', title: n.prefix || '', generation: n.suffix || '', nickName: n.nickname || '',
    displayName: n.display || [n.given, n.family].filter(Boolean).join(' '),
    emailAddresses: (f.emails || []).slice(0, 3).map((e) => ({ address: e.value, name: n.display || e.value })),
    mobilePhone: (phones.find((p) => p.type === 'mobile') || {}).value || '', homePhones: phones.filter((p) => p.type === 'home').map((p) => p.value).slice(0, 2),
    businessPhones: phones.filter((p) => p.type === 'work' || p.type === 'other').map((p) => p.value).slice(0, 2),
    companyName: f.company || '', department: f.department || '', jobTitle: f.title || '', homeAddress: adr('home'), businessAddress: adr('work'), otherAddress: adr('other'),
    birthday: f.birthday ? `${f.birthday.startsWith('--') ? '1604' + f.birthday.slice(1) : f.birthday}T11:59:00Z` : null, personalNotes: f.note || '',
    businessHomePage: (f.urls || [])[0] || '',
  };
}

/** The contact folders of account `a` → the address book rows (the default folder first) | 'consent'. */
async function syncBooks(gc, a) {
  const r = await G(gc, a, 'GET', '/me/contactFolders?$top=100&$select=id,displayName');
  if (r.status === 403) return 'consent';
  if (r.status >= 400) throw fail('unreachable', { reason: ms.graphError(r) });
  const folders = ((r.json && r.json.value) || []).filter((x) => x && x.id).map((x) => ({ id: x.id, name: clip(line(x.displayName || ''), 80) || 'Kontakte', isDefault: false }));
  // the default folder is not in contactFolders: its id from a contact in it; empty → the well-known name, else again next run
  let def = null;
  const one = await G(gc, a, 'GET', '/me/contacts?$top=1&$select=parentFolderId');
  if (one.status < 300) { const v = (one.json && one.json.value) || []; if (v[0] && v[0].parentFolderId) def = v[0].parentFolderId; }
  if (!def) {
    const wk = await G(gc, a, 'GET', '/me/contactFolders/contacts?$select=id');
    if (wk.status < 300 && wk.json && wk.json.id) def = wk.json.id;
  }
  if (def && !folders.some((f) => f.id === def)) folders.unshift({ id: def, name: a.email, isDefault: true });
  else if (def) folders.find((f) => f.id === def).isDefault = true;
  const have = await store.all(gc, "SELECT * FROM addressbooks WHERE account_id = ? AND source = 'graph'", [a.id]);
  const now = Date.now();
  for (const f of folders) {
    const row = have.find((b) => b.remote_id === f.id);
    if (row) await store.run(gc, 'UPDATE addressbooks SET is_default = ? WHERE id = ?', [f.isDefault ? 1 : 0, row.id]);
    else {
      await store.run(gc, `INSERT INTO addressbooks (user_id, account_id, source, remote_id, name, writable, is_default, state, created_at) VALUES (?, ?, 'graph', ?, ?, 1, ?, 'syncing', ?)`,
        [a.user_id, a.id, f.id, f.name, f.isDefault ? 1 : 0, now]).catch(() => null);
    }
  }
  // a folder that went (the default one only when another default was found)
  for (const b of have) if (!folders.some((f) => f.id === b.remote_id) && (def || !b.is_default)) await require('./cardstore').dropBook(gc, b);
  return store.all(gc, "SELECT * FROM addressbooks WHERE account_id = ? AND source = 'graph' ORDER BY is_default DESC, id", [a.id]);
}

/** One step of a folder's contact delta → { changed: [cardId], removed, more, consent }. */
async function contactsStep(gc, a, book, put, drop) {
  const url = book.delta || `/me/contactFolders/${encodeURIComponent(book.remote_id)}/contacts/delta?$select=${CONTACT_SELECT}`;
  const r = await G(gc, a, 'GET', url, undefined, { headers: { prefer: `odata.maxpagesize=${PAGE}` } });
  if (r.status === 403) return { consent: true };
  if (r.status === 410 || (r.status === 400 && /sync|delta/i.test(ms.graphError(r)))) { await store.run(gc, 'UPDATE addressbooks SET delta = NULL WHERE id = ?', [book.id]); return { changed: [], more: true }; }
  if (r.status === 404) { await store.run(gc, 'UPDATE addressbooks SET delta = NULL WHERE id = ?', [book.id]); return { changed: [], more: false, gone: true }; }
  if (r.status >= 400) throw fail('unreachable', { reason: ms.graphError(r) });
  const j = r.json || {};
  const changed = [];
  let removed = 0;
  for (const x of j.value || []) {
    if (x['@removed']) { if (await drop(x.id)) removed++; continue; }
    const id = await put(x, contactFields(x));
    if (id) changed.push(id);
  }
  const next = j['@odata.nextLink'] || null;
  const done = j['@odata.deltaLink'] || null;
  await store.run(gc, "UPDATE addressbooks SET delta = ?, synced_at = CASE WHEN ? THEN ? ELSE synced_at END, state = CASE WHEN ? THEN 'ok' ELSE state END, error_code = NULL WHERE id = ?",
    [next || done, done ? 1 : 0, Date.now(), done ? 1 : 0, book.id]);
  return { changed, removed, more: !!next };
}

/** The photo of a Graph contact (≤ 256 KB) → { mime, data } | null. */
async function contactPhoto(gc, a, id) {
  const r = await G(gc, a, 'GET', `/me/contacts/${encodeURIComponent(id)}/photo/$value`, undefined, { binary: true, headers: { accept: 'image/*' } });
  if (r.status !== 200 || !r.bodyBase64) return null;
  if (Buffer.byteLength(r.bodyBase64, 'base64') > PHOTO_MAX) return null;
  const mime = String((r.headers || {})['content-type'] || 'image/jpeg').split(';')[0].toLowerCase();
  return { mime: /^image\/(jpeg|png)$/.test(mime) ? mime : 'image/jpeg', data: r.bodyBase64 };
}

async function createContact(gc, a, book, f) {
  const r = await G(gc, a, 'POST', `/me/contactFolders/${encodeURIComponent(book.remote_id)}/contacts`, contactBody(f));
  if (r.status >= 300) throw graphFail(r, a);
  return r.json || {};
}

async function updateContact(gc, a, remoteId, f) {
  const r = await G(gc, a, 'PATCH', `/me/contacts/${encodeURIComponent(remoteId)}`, contactBody(f));
  if (r.status >= 300) throw graphFail(r, a);
  return r.json || {};
}

async function deleteContact(gc, a, remoteId) {
  const r = await G(gc, a, 'DELETE', `/me/contacts/${encodeURIComponent(remoteId)}`);
  if (r.status === 404 || r.status === 410) return;
  if (r.status >= 300) throw graphFail(r, a);
}

/** The current contact (412-like checks: Graph contacts have no If-Match — the changeKey is compared). */
async function getContact(gc, a, remoteId) {
  const r = await G(gc, a, 'GET', `/me/contacts/${encodeURIComponent(remoteId)}?$select=${CONTACT_SELECT}`);
  if (r.status === 404) return null;
  if (r.status >= 300) throw graphFail(r, a);
  return r.json || null;
}

async function putPhoto(gc, a, remoteId, photo) {
  const r = await G(gc, a, 'PUT', `/me/contacts/${encodeURIComponent(remoteId)}/photo/$value`, undefined, { bodyBase64: photo.data, headers: { 'content-type': photo.mime } });
  if (r.status >= 300) throw graphFail(r, a);
}

module.exports = {
  fieldsOf, occOf, utcOf, syncCalendars, storeInstance, removeInstance, deltaStep, viewRound, refreshEvent, master, recurrenceRule, patternOf, bodyOf,
  createEvent, updateEvent, deleteEvent, respond, contactFields, contactBody, syncBooks, contactsStep, contactPhoto, createContact, updateContact,
  deleteContact, getContact, putPhoto, CONTACT_SELECT,
};
