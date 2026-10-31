'use strict';

// The calendars of a person (C3 „Kalender – Liste und Einstellungen“, „GET events“): the list with the overlays and the
// settings, own calendars and iCal subscriptions, the occurrences of a range and one event in full.
//
//   GET calendars · POST calendars · PATCH/DELETE calendars/<id> · PATCH overlays/<id> · POST calendars/subscribe
//   PUT calendar/settings · GET events?from&to&calendars · GET events/<id>?occurrence=

const store = require('./store');
const config = require('./config');
const ms = require('./microsoft');
const engine = require('./engine');
const ics = require('./ics');
const tz = require('./tz');
const pimstore = require('./pimstore');
const pimgraph = require('./pimgraph');
const pimdav = require('./pimdav');
const pim = require('./pim');
const overlays = require('./overlays');
const dav = require('./dav');
const { fail, line, clip, parse, posInt } = require('./util');

const RANGE_MAX = 62 * 86400000;
const ITEMS_MAX = 5000;

/** May the person see calendar `c` (account calendars only while the administrator syncs them and the account does)? */
function shown(cfg, c, accounts) {
  if (c.account_id == null) return true;
  if (!cfg.calendar.accounts) return false;
  const a = accounts.get(c.account_id);
  return !!(a && a.calendar_sync !== 0);
}

/** A calendar row → the Calendar of the API. */
function view(c, accounts) {
  const a = c.account_id ? accounts.get(c.account_id) : null;
  const local = c.source === 'local';
  return {
    id: c.id, source: c.source, accountId: c.account_id || null, name: c.name, color: c.color, kind: c.kind, writable: c.writable === 1 && c.source !== 'ics',
    visible: c.visible === 1, notify: c.notify === 1, isDefault: c.is_default === 1, canInvite: c.writable === 1 && c.source !== 'ics',
    canOnline: c.source === 'graph' && !!(a && a.provider === 'm365') && c.writable === 1, maxReminders: c.source === 'graph' ? 1 : 3,
    state: local ? 'ok' : c.state, error: c.error_code ? { code: c.error_code, at: c.error_at } : null, syncedAt: c.synced_at || null, version: c.version,
  };
}

async function accountsOf(gc, userId) {
  return new Map((await store.all(gc, 'SELECT * FROM accounts WHERE user_id = ?', [userId])).map((a) => [a.id, a]));
}

/** The calendars the person sees (rows). */
async function visibleRows(gc, cfg, userId) {
  const accounts = await accountsOf(gc, userId);
  return { rows: (await pimstore.calendarsOf(gc, userId)).filter((c) => shown(cfg, c, accounts)), accounts };
}

/** GET calendars → { calendars, overlays, prefs, consent } */
async function list(gc, ctx) {
  const cfg = await config.get(gc);
  await pimstore.ensureSetup(gc, ctx.userId, ctx.lang);
  pim.opened(gc, ctx.userId, 'calendar');
  const { rows, accounts } = await visibleRows(gc, cfg, ctx.userId);
  const consent = [];
  if (cfg.calendar.accounts) {
    for (const a of accounts.values()) {
      if (!engine.isGraph(a) || a.calendar_sync === 0) continue;
      const missing = ms.missingScopes(a, cfg).filter((s) => s === config.MS_CALENDAR_SCOPE);
      if (missing.length) consent.push({ accountId: a.id, missing });
    }
  }
  return {
    calendars: rows.map((c) => view(c, accounts)), overlays: await overlays.list(gc, cfg, ctx.userId, ctx.lang),
    prefs: (await pimstore.calPrefs(gc, ctx.userId, cfg)).prefs, consent,
  };
}

const nameArg = (v, field = 'name') => {
  const s = clip(line(typeof v === 'string' ? v : ''), 80);
  if (!s) throw fail('invalid', { field });
  return s;
};

/** POST calendars { name, color? } → { calendar } (local, ≤ 20 per person) */
async function create(gc, ctx, b) {
  await pimstore.ensureSetup(gc, ctx.userId, ctx.lang);
  const name = nameArg(b.name);
  const n = await store.one(gc, "SELECT COUNT(*) AS n FROM calendars WHERE user_id = ? AND source IN ('local', 'ics') AND account_id IS NULL", [ctx.userId]);
  if (n.n >= pimstore.CALENDARS_MAX) throw fail('limit', { max: pimstore.CALENDARS_MAX });
  if (b.color !== undefined && !pimstore.colorArg(b.color)) throw fail('invalid', { field: 'color' });
  const color = pimstore.colorArg(b.color) || await pimstore.nextColor(gc, ctx.userId);
  const now = Date.now();
  const r = await store.run(gc, `INSERT INTO calendars (user_id, account_id, source, name, color, kind, writable, is_default, sort, state, synced_at, created_at)
    VALUES (?, NULL, 'local', ?, ?, 'other', 1, 0, 10, 'ok', ?, ?)`, [ctx.userId, name, color, now, now]);
  const c = await store.one(gc, 'SELECT * FROM calendars WHERE id = ?', [Number(r.lastInsertRowid)]);
  await pimstore.live(gc, ctx.userId, 'calendar', { kind: 'calendars' });
  return { calendar: view(c, await accountsOf(gc, ctx.userId)) };
}

/** PATCH calendars/<id> { name?, color?, visible?, notify? } → { calendar } (an account's calendar: name / colour only here) */
async function patch(gc, ctx, id, b) {
  const c = await pimstore.ownCalendar(gc, ctx.userId, id);
  const sets = [];
  const args = [];
  if (b.name !== undefined) { sets.push('name = ?'); args.push(nameArg(b.name)); }
  if (b.color !== undefined) { const col = pimstore.colorArg(b.color); if (!col) throw fail('invalid', { field: 'color' }); sets.push('color = ?'); args.push(col); }
  for (const k of ['visible', 'notify']) {
    if (b[k] === undefined) continue;
    if (typeof b[k] !== 'boolean') throw fail('invalid', { field: k });
    sets.push(`${k} = ?`); args.push(b[k] ? 1 : 0);
  }
  if (sets.length) await store.run(gc, `UPDATE calendars SET ${sets.join(', ')} WHERE id = ?`, [...args, c.id]);
  if (c.account_id && (b.name !== undefined || b.color !== undefined)) {
    // shown this way in GateControl only: the next sync keeps it
    const cur = await pimstore.calPrefs(gc, ctx.userId);
    const row = await store.one(gc, 'SELECT json FROM cal_prefs WHERE user_id = ?', [ctx.userId]);
    const custom = new Set(row ? parse(row.json, {}).custom || [] : []);
    custom.add(c.id);
    await pimstore.saveCalPrefs(gc, ctx.userId, { ...cur.prefs, custom: [...custom] }, cur.overlays, cur.setup);
  }
  await pimstore.live(gc, ctx.userId, 'calendar', { kind: 'calendars' });
  return { calendar: view(await store.one(gc, 'SELECT * FROM calendars WHERE id = ?', [c.id]), await accountsOf(gc, ctx.userId)) };
}

/** DELETE calendars/<id> → { ok } (own calendars but the last one, and subscriptions; their events go) */
async function remove(gc, ctx, id) {
  const c = await pimstore.ownCalendar(gc, ctx.userId, id);
  if (c.source === 'local') {
    const n = await store.one(gc, "SELECT COUNT(*) AS n FROM calendars WHERE user_id = ? AND source = 'local'", [ctx.userId]);
    if (n.n <= 1) throw fail('not_supported', { what: 'last_calendar' });
  } else if (c.source !== 'ics') throw fail('not_supported', { what: 'delete' });
  await pimstore.dropCalendar(gc, c);
  if (c.is_default) {
    const next = await store.one(gc, "SELECT id FROM calendars WHERE user_id = ? AND source = 'local' ORDER BY sort, id LIMIT 1", [ctx.userId]);
    if (next) await store.run(gc, 'UPDATE calendars SET is_default = 1 WHERE id = ?', [next.id]);
  }
  const cur = await pimstore.calPrefs(gc, ctx.userId);
  if (cur.prefs.defaultCalendarId === c.id) await pimstore.saveCalPrefs(gc, ctx.userId, { ...cur.prefs, defaultCalendarId: null }, cur.overlays, cur.setup);
  await pimstore.live(gc, ctx.userId, 'calendar', { kind: 'calendars' });
  return { ok: true };
}

/**
 * POST calendars/subscribe { url, name?, color?, accountId? } → { calendar } — an iCal subscription (read only;
 * webcal: → https:). The address is a secret of the plugin. accountId: an account of the person (Gmail's secret address).
 */
async function subscribe(gc, ctx, b) {
  await pimstore.ensureSetup(gc, ctx.userId, ctx.lang);
  const url = dav.httpsUrl(b.url);
  if (!url) throw fail('invalid', { field: 'url' });
  let accountId = null;
  if (b.accountId != null) {
    const a = await store.one(gc, 'SELECT id FROM accounts WHERE id = ? AND user_id = ?', [posInt(b.accountId), ctx.userId]);
    if (!a) throw fail('not_found');
    accountId = a.id;
  }
  if (b.color !== undefined && !pimstore.colorArg(b.color)) throw fail('invalid', { field: 'color' });
  const n = await store.one(gc, "SELECT COUNT(*) AS n FROM calendars WHERE user_id = ? AND source IN ('local', 'ics')", [ctx.userId]);
  if (n.n >= pimstore.CALENDARS_MAX) throw fail('limit', { max: pimstore.CALENDARS_MAX });
  const got = await pimdav.fetchIcs(gc, url);
  ics.split(got.text); // readable at all?
  return createSubscription(gc, ctx.userId, accountId, url, { name: b.name, color: b.color, text: got.text });
}

/** A subscription row with its secret address, synced once → { calendar }. */
async function createSubscription(gc, userId, accountId, url, o = {}) {
  const now = Date.now();
  const name = o.name ? nameArg(o.name) : pimdav.icsName(o.text, url);
  const color = pimstore.colorArg(o.color) || await pimstore.nextColor(gc, userId);
  const r = await store.run(gc, `INSERT INTO calendars (user_id, account_id, source, remote_id, name, color, kind, writable, is_default, sort, state, created_at)
    VALUES (?, ?, 'ics', NULL, ?, ?, 'other', 0, 0, 20, 'syncing', ?)`, [userId, accountId, name, color, now]);
  const id = Number(r.lastInsertRowid);
  await pimdav.setIcsUrl(gc, id, url);
  let c = await store.one(gc, 'SELECT * FROM calendars WHERE id = ?', [id]);
  try { await pimdav.syncIcs(gc, c); } catch { /* the background tries again */ }
  c = await store.one(gc, 'SELECT * FROM calendars WHERE id = ?', [id]);
  await pimstore.live(gc, userId, 'calendar', { kind: 'calendars' });
  return { calendar: view(c, await accountsOf(gc, userId)) };
}

/** PUT calendar/settings { defaultCalendarId?, view?, weekStart?, workWeek?, timeZone?, reminders?, defaultReminder?, allDayReminder? } → { prefs } */
async function settings(gc, ctx, b) {
  await pimstore.ensureSetup(gc, ctx.userId, ctx.lang);
  const cur = await pimstore.calPrefs(gc, ctx.userId);
  const p = { ...cur.prefs };
  const bad = (field) => { throw fail('invalid', { field }); };
  if (b.defaultCalendarId !== undefined) {
    const c = await pimstore.ownCalendar(gc, ctx.userId, posInt(b.defaultCalendarId));
    if (c.writable !== 1 || c.source === 'ics') bad('defaultCalendarId');
    p.defaultCalendarId = c.id;
  }
  if (b.view !== undefined) { if (!pimstore.VIEWS.includes(b.view)) bad('view'); p.view = b.view; }
  if (b.weekStart !== undefined) { if (b.weekStart !== 0 && b.weekStart !== 1) bad('weekStart'); p.weekStart = b.weekStart; }
  for (const k of ['workWeek', 'reminders']) if (b[k] !== undefined) { if (typeof b[k] !== 'boolean') bad(k); p[k] = b[k]; }
  const zoneChanged = b.timeZone !== undefined && b.timeZone !== p.timeZone;
  if (b.timeZone !== undefined) { if (typeof b.timeZone !== 'string' || !tz.valid(b.timeZone) || b.timeZone.length > 64) bad('timeZone'); p.timeZone = b.timeZone; }
  if (b.defaultReminder !== undefined) { if (!(b.defaultReminder === null || (Number.isInteger(b.defaultReminder) && b.defaultReminder >= 0 && b.defaultReminder <= 40320))) bad('defaultReminder'); p.defaultReminder = b.defaultReminder; }
  if (b.allDayReminder !== undefined) { if (!(Number.isInteger(b.allDayReminder) && b.allDayReminder >= 0 && b.allDayReminder <= 10080)) bad('allDayReminder'); p.allDayReminder = b.allDayReminder; }
  await pimstore.saveCalPrefs(gc, ctx.userId, p, cur.overlays, true);
  if (zoneChanged) rebuildZone(gc, ctx.userId).catch((e) => gc.log.warn('time zone rebuild failed', (e && e.code) || 'error'));
  return { prefs: (await pimstore.calPrefs(gc, ctx.userId)).prefs };
}

/** The person's zone changed: the occurrences of their iCalendar events again (all-day ones are at midnight of the zone). */
async function rebuildZone(gc, userId) {
  const zone = await pimstore.zoneOf(gc, userId);
  const own = await pimstore.ownAddresses(gc, userId);
  for (const ev of await store.all(gc, 'SELECT * FROM events WHERE user_id = ? AND ics IS NOT NULL', [userId])) {
    try {
      const p = ics.parse(ev.ics);
      const o = p.objects.find((x) => x.uid === ev.uid) || p.objects[0];
      if (o) await pimstore.writeOccurrences(gc, ev, o, { userTz: zone, own, zones: p.zones });
    } catch { /* stays */ }
  }
}

// ─── occurrences ────────────────────────────────

const OCC_COLS = `o.event_id, o.occ, o.calendar_id, o.start AS o_start, o.end AS o_end, o.all_day AS o_all_day, o.override_json, o.remote_id AS o_remote,
  e.title, e.location, e.online_url, e.tz, e.status, e.busy, e.my_response, e.rrule, e.attendees_json, e.private, e.reminders_json`;

const providerOf = (url) => (/teams\.(microsoft|live)\.com/i.test(url) ? 'teams' : /zoom\.us/i.test(url) ? 'zoom' : /meet\.google\.com/i.test(url) ? 'meet' : /webex\.com/i.test(url) ? 'webex' : 'other');

/** A joined occurrence row → the Occurrence of the API (`zone`: the person's, for all-day dates). */
function occurrenceView(r, zone) {
  const ov = parse(r.override_json, null) || {};
  const allDay = r.o_all_day === 1;
  const reminders = ov.reminders || parse(r.reminders_json, []);
  const online = ov.online !== undefined ? ov.online : (r.online_url ? { url: r.online_url, provider: providerOf(r.online_url) } : null);
  return {
    key: r.occ ? `${r.event_id}:${r.occ}` : String(r.event_id), eventId: r.event_id, calendarId: r.calendar_id, occurrence: r.occ || null,
    title: ov.title != null ? ov.title : r.title, start: r.o_start, end: r.o_end, allDay,
    ...(allDay ? { startDate: tz.localDate(r.o_start, zone), endDate: tz.localDate(Math.max(r.o_start, r.o_end - 1), zone) } : {}),
    timeZone: ov.timeZone || r.tz || zone, location: ov.location !== undefined ? ov.location : (r.location || null), online,
    status: ov.status || r.status, busy: ov.busy || r.busy, myResponse: ov.myResponse !== undefined ? ov.myResponse : (r.my_response || null),
    recurring: !!r.rrule, attendees: ov.attendees != null ? ov.attendees : parse(r.attendees_json, []).length, private: ov.private != null ? !!ov.private : r.private === 1,
    reminder: reminders.length ? reminders[0] : null,
  };
}

/** The occurrences of the person in [from, to) of calendars `ids` → [Occurrence] (sorted). */
async function occurrences(gc, userId, ids, from, to, limit = ITEMS_MAX) {
  if (!ids.length) return [];
  const zone = await pimstore.zoneOf(gc, userId);
  const out = [];
  for (const part of store.chunks(ids, 80)) {
    const rows = await store.all(gc, `SELECT ${OCC_COLS} FROM occurrences o JOIN events e ON e.id = o.event_id
      WHERE o.user_id = ? AND o.calendar_id IN (${store.marks(part.length)}) AND o.start < ? AND o.end > ? ORDER BY o.start LIMIT ?`, [userId, ...part, to, from, limit]);
    out.push(...rows.map((r) => occurrenceView(r, zone)));
  }
  // beyond the stored window: the iCalendar events expanded when asked (Graph has only its window)
  const w = pimstore.windowOf();
  if (from < w.from || to > w.to) out.push(...await outside(gc, userId, ids, from, to, w, zone));
  return out.sort((a, b) => a.start - b.start || a.eventId - b.eventId).slice(0, limit);
}

/** Occurrences of [from, to) outside the stored window `w`, expanded from the stored calendar objects. */
async function outside(gc, userId, ids, from, to, w, zone) {
  const own = await pimstore.ownAddresses(gc, userId);
  const out = [];
  for (const part of store.chunks(ids, 80)) {
    const evs = await store.all(gc, `SELECT * FROM events WHERE user_id = ? AND calendar_id IN (${store.marks(part.length)}) AND ics IS NOT NULL
      AND (rrule IS NOT NULL OR (start < ? AND end > ?)) LIMIT 2000`, [userId, ...part, to, from]);
    for (const ev of evs) {
      let list;
      try {
        const p = ics.parse(ev.ics);
        const o = p.objects.find((x) => x.uid === ev.uid) || p.objects[0];
        list = ics.expand(o, { userTz: zone, own, zones: p.zones }, from, to);
      } catch { continue; }
      for (const x of list) {
        if (x.start >= w.from && x.start < w.to && x.end > w.from) continue; // stored
        const r = { event_id: ev.id, occ: x.occ, calendar_id: ev.calendar_id, o_start: x.start, o_end: x.end, o_all_day: x.allDay ? 1 : 0, override_json: pimstore.overrideOf(x.override),
          title: ev.title, location: ev.location, online_url: ev.online_url, tz: ev.tz, status: ev.status, busy: ev.busy, my_response: ev.my_response, rrule: ev.rrule,
          attendees_json: ev.attendees_json, private: ev.private, reminders_json: ev.reminders_json };
        out.push(occurrenceView(r, zone));
      }
    }
  }
  return out;
}

const numArg = (v, field) => {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^-?\d{1,15}$/.test(v) ? Number(v) : NaN);
  if (!Number.isSafeInteger(n)) throw fail('invalid', { field });
  return n;
};

/** GET events?from=<ms>&to=<ms>&calendars=<ids,overlay-ids> → { items, overlays, pending } */
async function events(gc, ctx, q) {
  const cfg = await config.get(gc);
  await pimstore.ensureSetup(gc, ctx.userId, ctx.lang);
  const from = numArg(q.from, 'from');
  const to = numArg(q.to, 'to');
  if (to <= from || to - from > RANGE_MAX) throw fail('invalid', { field: 'to' });
  pim.touch(ctx.userId, 'calendar');
  const { rows } = await visibleRows(gc, cfg, ctx.userId);
  let calIds;
  let overlayIds = null;
  if (q.calendars != null && q.calendars !== '') {
    const want = String(q.calendars).split(',').map((s) => s.trim()).filter(Boolean).slice(0, 200);
    calIds = rows.filter((c) => want.includes(String(c.id))).map((c) => c.id);
    overlayIds = want.filter((w) => !/^\d+$/.test(w));
  } else calIds = rows.filter((c) => c.visible === 1).map((c) => c.id);
  const items = await occurrences(gc, ctx.userId, calIds, from, to);
  const pending = rows.filter((c) => calIds.includes(c.id) && c.source !== 'local' && !c.synced_at).map((c) => c.id);
  let ov = [];
  try { ov = await overlays.items(gc, cfg, ctx.userId, overlayIds, from, to, ctx.lang); } catch { ov = []; }
  return { items, overlays: ov, pending };
}

// ─── one event ──────────────────────────────────

/** An event of the person with its calendar (404 for anyone else's). */
async function ownEvent(gc, userId, id) {
  const ev = Number.isSafeInteger(id) ? await store.one(gc, 'SELECT * FROM events WHERE id = ? AND user_id = ?', [id, userId]) : null;
  if (!ev) throw fail('not_found');
  const cal = await store.one(gc, 'SELECT * FROM calendars WHERE id = ?', [ev.calendar_id]);
  if (!cal) throw fail('not_found');
  return { ev, cal };
}

/** The API's etag of an event (its stored state). */
const etagOf = (ev) => `"${ev.updated_at}-${ev.sequence}"`;

/** The contact ids of addresses (attendees → contactId). */
async function contactIds(gc, userId, emails) {
  const out = new Map();
  for (const part of store.chunks([...new Set(emails)], 80)) {
    if (!part.length) continue;
    for (const r of await store.all(gc, `SELECT email, MIN(card_id) AS id FROM card_emails WHERE user_id = ? AND email IN (${store.marks(part.length)}) GROUP BY email`, [userId, ...part])) out.set(r.email, r.id);
  }
  return out;
}

/**
 * The full Event of event row `ev` (occurrence `occ`, '' or null: the series / single event) — Occurrence + description,
 * organizer, attendees, reminders, recurrence, rights, etag.
 */
async function full(gc, userId, ev, cal, occ) {
  const zone = await pimstore.zoneOf(gc, userId);
  const own = await pimstore.ownAddresses(gc, userId);
  let row = occ ? await store.one(gc, `SELECT ${OCC_COLS} FROM occurrences o JOIN events e ON e.id = o.event_id WHERE o.event_id = ? AND o.occ = ?`, [ev.id, occ]) : null;
  if (occ && !row) throw fail('not_found');
  if (!row) row = await store.one(gc, `SELECT ${OCC_COLS} FROM occurrences o JOIN events e ON e.id = o.event_id WHERE o.event_id = ? ORDER BY CASE WHEN o.end > ? THEN 0 ELSE 1 END, o.start LIMIT 1`, [ev.id, Date.now()]);
  const base = row ? occurrenceView(row, zone) : {
    key: String(ev.id), eventId: ev.id, calendarId: cal.id, occurrence: null, title: ev.title, start: ev.start, end: ev.end, allDay: ev.all_day === 1,
    timeZone: ev.tz || zone, location: ev.location, online: ev.online_url ? { url: ev.online_url, provider: providerOf(ev.online_url) } : null, status: ev.status, busy: ev.busy,
    myResponse: ev.my_response, recurring: !!ev.rrule, attendees: parse(ev.attendees_json, []).length, private: ev.private === 1, reminder: null,
  };
  if (!occ) { base.occurrence = null; base.key = String(ev.id); }
  let f = null;
  let recurrence = null;
  let descriptionHtml = null;
  // since 1.3.0: the start and end of the series itself (its master) — what a PATCH scope 'series' moves from
  let series = null;
  if (ev.ics) {
    const p = ics.parse(ev.ics);
    const o = p.objects.find((x) => x.uid === ev.uid) || p.objects[0];
    const ctx = { userTz: zone, own, zones: p.zones };
    let v = o.master || o.overrides[0];
    if (occ) { const ovc = o.overrides.find((x) => ics.occKey(ics.timeOf(x.getFirstProperty('recurrence-id'), p.zones, zone)) === occ); if (ovc) v = ovc; }
    f = ics.fieldsOf(v, ctx);
    recurrence = ics.recurrenceOf(o, ctx);
    series = ics.seriesOf(o, ctx);
  } else {
    f = {
      description: ev.description || '', organizer: parse(ev.organizer_json, null), attendees: parse(ev.attendees_json, []), reminders: parse(ev.reminders_json, []),
      categories: [], url: null,
    };
    if (cal.source === 'graph' && ev.remote_id) {
      const a = await store.one(gc, 'SELECT * FROM accounts WHERE id = ?', [cal.account_id]);
      try {
        const x = await pimgraph.master(gc, a, ev.remote_id);
        if (x) {
          const gf = pimgraph.fieldsOf(x, { userTz: zone });
          f.categories = gf.categories; f.url = gf.url;
          if (gf.descriptionHtml && gc.mail && typeof gc.mail.sanitize === 'function') {
            try { descriptionHtml = (await gc.mail.sanitize(gf.descriptionHtml, { images: 'placeholder' })).html || null; } catch { descriptionHtml = null; }
          }
          if (!occ) f.description = gf.description;
          const rule = pimgraph.recurrenceRule(x.recurrence);
          if (rule) {
            series = { start: gf.start, end: gf.end, allDay: !!gf.allDay, ...(gf.allDay ? { startDate: gf.startDate, endDate: gf.endDate } : {}) };
            const rp = Object.fromEntries(rule.split(';').map((s) => s.split('=')));
            recurrence = {
              rrule: rule, editable: true, freq: String(rp.FREQ).toLowerCase(), interval: Number(rp.INTERVAL) || 1, byDay: rp.BYDAY ? rp.BYDAY.split(',') : null,
              byMonthDay: rp.BYMONTHDAY ? [Number(rp.BYMONTHDAY)] : null, bySetPos: rp.BYSETPOS ? Number(rp.BYSETPOS) : null,
              until: rp.UNTIL ? `${rp.UNTIL.slice(0, 4)}-${rp.UNTIL.slice(4, 6)}-${rp.UNTIL.slice(6, 8)}` : null, count: rp.COUNT ? Number(rp.COUNT) : null,
              exceptions: (await store.all(gc, "SELECT occ FROM occurrences WHERE event_id = ? AND override_json IS NOT NULL AND occ <> ''", [ev.id])).map((r) => r.occ), deleted: [],
            };
          }
        }
      } catch (e) { if (e && e.code === 'consent_required') throw e; /* the stored fields */ }
    }
  }
  const ids = await contactIds(gc, userId, [...(f.attendees || []).map((a) => a.email), ...(f.organizer ? [f.organizer.email] : [])]);
  const mine = base.myResponse;
  const writable = cal.writable === 1 && cal.source !== 'ics';
  const organizerSelf = !!(f.organizer && own.has(f.organizer.email)) || mine === 'organizer';
  const invitation = await store.one(gc, "SELECT id FROM invitations WHERE user_id = ? AND event_id = ? AND state IN ('open', 'answered') ORDER BY id DESC LIMIT 1", [userId, ev.id]);
  const attendeeOf = !organizerSelf && !!mine && mine !== 'organizer';
  return {
    ...base,
    description: String(f.description || '').slice(0, ics.DESC_MAX), descriptionHtml,
    organizer: f.organizer ? { name: f.organizer.name || '', email: f.organizer.email, self: own.has(f.organizer.email) } : null,
    attendees: (f.attendees || []).map((a) => ({ name: a.name || '', email: a.email, role: a.role || 'required', response: a.response || 'needs_action', self: own.has(a.email), contactId: ids.get(a.email) || null })),
    reminders: (f.reminders || []).slice(0, 3), recurrence, series, seriesId: occ ? ev.id : null, readOnly: !writable,
    canRespond: writable && attendeeOf, canEdit: writable && !attendeeOf, canDelete: writable,
    categories: f.categories || [], invitationId: invitation ? invitation.id : null, url: f.url || null, createdAt: ev.created_at, updatedAt: ev.updated_at, etag: etagOf(ev),
  };
}

/** GET events/<id>?occurrence=<occ> → Event */
async function get(gc, ctx, id, q) {
  const { ev, cal } = await ownEvent(gc, ctx.userId, id);
  const occ = typeof q.occurrence === 'string' && q.occurrence ? q.occurrence : null;
  return full(gc, ctx.userId, ev, cal, occ);
}

module.exports = {
  list, create, patch, remove, subscribe, createSubscription, settings, events, get, full, ownEvent, occurrences, occurrenceView, etagOf, view, visibleRows, accountsOf,
  rebuildZone, contactIds, OCC_COLS, RANGE_MAX,
};
