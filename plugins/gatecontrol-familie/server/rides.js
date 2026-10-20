'use strict';

// Rides — "Abholen & Fahrten" (module rides). A ride is ONE leg: one trip at
// one time ("Tim vom Training abholen", 16:00, Sporthalle Nord).
//
//   GET    rides?from=&to=            occurrences, sorted (default today … +7 days, at most 62)
//   GET    rides/<id>                 one occurrence (addition)
//   POST   rides                      a ride or a weekly series (parents: anything; children:
//                                     only for themselves, no driver, no series, ask by default)
//   PATCH  rides/<id>[?series=1]      parents: one occurrence, or the whole series
//   DELETE rides/<id>[?series=1]      an occurrence (one-off or of a series) → cancelled (parents,
//                                     or whoever asked for a one-off ride); ?series=1: the series is removed
//   POST   rides/<id>/take            a parent or an adult member drives
//   POST   rides/<id>/release         the driver cannot after all
//   POST   rides/<id>/decline         a parent says "kann nicht"
//   POST   rides/<id>/driver          parents: { userId } | { label } | { clear: true }
//   POST   rides/<id>/ask             any member: "Wer kann Tim um 16:00 abholen?" (≥ 5 min apart)
//
// Ids are strings: "<id>" for a one-off ride, "<seriesId>:<date>" for an
// occurrence of a weekly series. A series is expanded on read; a change to
// one occurrence (take, decline, driver, cancel, time …) is stored as an
// override for (seriesId, date). Status is derived: cancelled, else taken
// (a member or a free-text driver such as "Familie Weber"), else open.
//
// Background (tick): the member driving gets a reminder remindMinutes before
// the start ("Gleich: …"), an open ride 60 minutes before the start goes to
// the parents ("Noch offen: …") — each once per occurrence (table notices).
// Rides are kept 30 days after their date.

const store = require('./store');
const tz = require('./tz');
const push = require('./push');
const format = require('./format');
const members = require('./members');
const notices = require('./notices');
const { fail, posInt, text, optText, multiline, bool, intIn, numIn, time, date, iso, userIds, parseJson } = require('./util');

const TITLE_MAX = 80;
const PLACE_MAX = 80;
const NOTE_MAX = 200;
const LABEL_MAX = 60;
const REMIND_DEFAULT = 20;
const REMIND_MAX = 120;
const DEFAULT_RANGE_DAYS = 7;
const MAX_RANGE_DAYS = 62;
const MAX_AHEAD_DAYS = 400;
const MAX_CHILDREN = 10;
const ASK_GAP_MS = 5 * 60000;
const OPEN_BEFORE_MS = 60 * 60000;
const OPEN_AFTER_ASK_MS = 15 * 60000;
const NEXT_MS = 24 * 3600000;
const NEXT_MAX = 5;
const KEEP_DAYS = 30;
const OCC_FIELDS = ['time', 'title', 'place', 'lat', 'lon', 'childIds', 'driver', 'cancelled', 'declined', 'askedAt', 'remindMinutes', 'note'];
const OCC_RE = /^(\d{1,12}):(\d{4}-\d{2}-\d{2})$/;

const isoWd = (d) => ((tz.weekday(d) + 6) % 7) + 1; // 1 = Monday … 7 = Sunday

function driverOf(userId, label) {
  if (userId) return { userId };
  if (label) return { label };
  return null;
}

function rowToRide(r) {
  return {
    id: r.id, series: !!r.series, date: r.date, endDate: r.end_date || null, weekdays: parseJson(r.weekdays_json, []) || [],
    time: r.time, title: r.title, place: r.place || '', lat: r.lat == null ? null : r.lat, lon: r.lon == null ? null : r.lon,
    childIds: parseJson(r.child_ids_json, []), driver: driverOf(r.driver_user, r.driver_label), cancelled: !!r.cancelled,
    requestedBy: r.requested_by, declined: parseJson(r.declined_json, []), askedAt: r.asked_at == null ? null : r.asked_at,
    remindMinutes: r.remind_minutes, note: r.note || '',
  };
}

async function getRide(gc, id) {
  const r = await store.one(gc, 'SELECT * FROM rides WHERE id = ?', [id]);
  return r ? rowToRide(r) : null;
}

/** Is `d` a date of the series? */
function inSeries(s, d) {
  return d >= s.date && (!s.endDate || d <= s.endDate) && s.weekdays.includes(isoWd(d));
}

/** Dates of a series within [from, to]. */
function seriesDates(s, from, to) {
  const out = [];
  let d = from < s.date ? s.date : from;
  const end = s.endDate && s.endDate < to ? s.endDate : to;
  while (d <= end) {
    if (s.weekdays.includes(isoWd(d))) out.push(d);
    d = tz.addDays(d, 1);
  }
  return out;
}

/** The occurrence of `ride` on `date` with an override (series) applied. */
function occurrence(ride, d, ov) {
  const o = { key: ride.series ? `${ride.id}:${d}` : String(ride.id), ride, date: d, requestedBy: ride.requestedBy };
  for (const k of OCC_FIELDS) o[k] = ov && Object.prototype.hasOwnProperty.call(ov, k) ? ov[k] : ride[k];
  if (!Array.isArray(o.childIds)) o.childIds = [];
  if (!Array.isArray(o.declined)) o.declined = [];
  return o;
}

/** The driver if still valid (a member who left the family no longer drives). */
function liveDriver(o, fam) {
  const d = o.driver;
  if (!d) return null;
  if (d.userId) return fam.byId.has(d.userId) ? d : null;
  return d.label ? d : null;
}

function status(o, fam) {
  if (o.cancelled) return 'cancelled';
  return liveDriver(o, fam) ? 'taken' : 'open';
}

const startAt = (o, cfg) => tz.at(o.date, tz.parseTime(o.time), cfg.tz);

function person(fam, id) {
  const m = fam.byId.get(id);
  if (m) return { userId: id, name: m.name };
  const u = fam.users.get(id);
  return { userId: id, name: u ? u.name : null };
}

function driverView(d, fam) {
  if (!d) return null;
  return d.userId ? { userId: d.userId, name: fam.byId.get(d.userId).name } : { label: d.label };
}

/** The ride as the API returns it; `ctx` = { fam, cfg, trustOnly }. */
function view(o, ctx) {
  const fam = ctx.fam;
  const hidePos = !!ctx.trustOnly;
  return {
    id: o.key, seriesId: o.ride.series ? o.ride.id : null, date: o.date, time: o.time, title: o.title, place: o.place,
    lat: hidePos ? null : o.lat, lon: hidePos ? null : o.lon,
    childIds: o.childIds.filter((id) => fam.byId.has(id)),
    status: status(o, fam),
    driver: driverView(liveDriver(o, fam), fam),
    requestedBy: person(fam, o.requestedBy),
    declined: o.declined.filter((id) => fam.byId.has(id)).map((id) => person(fam, id)),
    askedAt: iso(o.askedAt), remindMinutes: o.remindMinutes, note: o.note,
    // additions: the start as an instant, the rule of a series
    startAt: iso(startAt(o, ctx.cfg)),
    repeat: o.ride.series ? { weekdays: o.ride.weekdays, startDate: o.ride.date, endDate: o.ride.endDate } : null,
  };
}

const sortKey = (o) => `${o.date} ${o.time} ${String(o.ride.id).padStart(12, '0')}`;

/** Every occurrence between from and to (inclusive), sorted by date and time. */
async function loadRange(gc, from, to) {
  const rows = await store.all(gc, `SELECT * FROM rides WHERE (series = 0 AND date >= ? AND date <= ?)
    OR (series = 1 AND date <= ? AND (end_date IS NULL OR end_date >= ?)) ORDER BY id`, [from, to, to, from]);
  const rides = rows.map(rowToRide);
  const sids = rides.filter((x) => x.series).map((x) => x.id);
  const ovs = new Map();
  if (sids.length) {
    const list = await store.all(gc, `SELECT * FROM ride_overrides WHERE ride_id IN (${store.marks(sids.length)}) AND date >= ? AND date <= ?`, [...sids, from, to]);
    for (const x of list) ovs.set(`${x.ride_id}:${x.date}`, parseJson(x.data_json, {}));
  }
  const out = [];
  for (const ride of rides) {
    if (!ride.series) out.push(occurrence(ride, ride.date, null));
    else for (const d of seriesDates(ride, from, to)) out.push(occurrence(ride, d, ovs.get(`${ride.id}:${d}`)));
  }
  out.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
  return out;
}

/** "<id>" or "<seriesId>:<date>" → { ride, date } (date null: the series itself). */
async function resolve(gc, raw) {
  const s = typeof raw === 'string' ? raw : '';
  const m = OCC_RE.exec(s);
  if (m) {
    const ride = await getRide(gc, posInt(m[1]));
    if (!ride || !ride.series || !inSeries(ride, m[2])) throw fail('not_found');
    return { ride, date: m[2] };
  }
  const id = posInt(s);
  const ride = id ? await getRide(gc, id) : null;
  if (!ride) throw fail('not_found');
  return { ride, date: ride.series ? null : ride.date };
}

async function occOf(gc, ride, d) {
  if (!ride.series) return occurrence(ride, ride.date, null);
  const ov = await store.one(gc, 'SELECT data_json FROM ride_overrides WHERE ride_id = ? AND date = ?', [ride.id, d]);
  return occurrence(ride, d, ov ? parseJson(ov.data_json, {}) : null);
}

/** One occurrence by its id (a series id alone is no occurrence). */
async function findOcc(gc, raw) {
  const { ride, date: d } = await resolve(gc, raw);
  if (!d) throw fail('not_found');
  return occOf(gc, ride, d);
}

const ONE_OFF_COLS = {
  date: 'date', time: 'time', title: 'title', place: 'place', lat: 'lat', lon: 'lon', childIds: 'child_ids_json', cancelled: 'cancelled',
  declined: 'declined_json', askedAt: 'asked_at', remindMinutes: 'remind_minutes', note: 'note',
};

function colValue(k, v) {
  if (k === 'childIds' || k === 'declined') return JSON.stringify(v);
  if (k === 'cancelled') return v ? 1 : 0;
  return v;
}

/** Store changes of one occurrence (one-off: the row; series: the override) and apply them to `o`. */
async function saveOcc(gc, o, changes, now) {
  if (!o.ride.series) {
    const sets = [];
    const params = [];
    for (const [k, v] of Object.entries(changes)) {
      if (k === 'driver') {
        sets.push('driver_user = ?', 'driver_label = ?');
        params.push(v && v.userId ? v.userId : null, v && v.label ? v.label : null);
      } else if (ONE_OFF_COLS[k]) {
        sets.push(`${ONE_OFF_COLS[k]} = ?`);
        params.push(colValue(k, v));
      }
    }
    if (sets.length) await store.run(gc, `UPDATE rides SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, [...params, now, o.ride.id]);
  } else {
    const row = await store.one(gc, 'SELECT data_json FROM ride_overrides WHERE ride_id = ? AND date = ?', [o.ride.id, o.date]);
    const data = { ...(row ? parseJson(row.data_json, {}) : {}) };
    for (const [k, v] of Object.entries(changes)) if (OCC_FIELDS.includes(k)) data[k] = v;
    await store.run(gc, `INSERT INTO ride_overrides (ride_id, date, data_json, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(ride_id, date) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at`, [o.ride.id, o.date, JSON.stringify(data), now]);
  }
  Object.assign(o, changes);
}

// ─── input ──────────────────────────────────────

function parseDriver(v, fam) {
  if (v == null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw fail('invalid');
  if (v.userId != null) {
    const id = posInt(v.userId);
    const m = id ? fam.byId.get(id) : null;
    if (!m || !members.canDrive(m)) throw fail('invalid');
    return { userId: id };
  }
  if (v.label != null) return { label: text(v.label, LABEL_MAX) };
  throw fail('invalid');
}

/** lat/lon from the body: both or none; undefined keeps `cur`. */
function parsePosition(b, cur) {
  if (b.lat === undefined && b.lon === undefined) return cur;
  if (b.lat == null && b.lon == null) return { lat: null, lon: null };
  return { lat: numIn(b.lat, -90, 90), lon: numIn(b.lon, -180, 180) };
}

function parseChildren(v, fam) {
  const ids = userIds(v, MAX_CHILDREN);
  if (ids.some((id) => !fam.byId.has(id))) throw fail('invalid');
  return ids;
}

function parseNote(v) {
  if (v == null) return '';
  const n = multiline(v);
  if (n == null || n.length > NOTE_MAX) throw fail('invalid');
  return n;
}

function parseWeekdays(w) {
  if (!Array.isArray(w) || !w.length || w.length > 7 || w.some((x) => !Number.isInteger(x) || x < 1 || x > 7)) throw fail('invalid');
  return [...new Set(w)].sort();
}

function parseRepeat(v, startDate) {
  if (v == null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw fail('invalid');
  const weekdays = parseWeekdays(v.weekdays);
  const endDate = v.endDate == null || v.endDate === '' ? null : date(v.endDate);
  if (endDate && endDate < startDate) throw fail('invalid');
  return { weekdays, endDate };
}

function requiredTime(v) {
  const t = time(v);
  if (!t) throw fail('invalid');
  return t;
}

// ─── pushes ─────────────────────────────────────

/** "Tim", "Tim und Lena", "Tim, Lena und Max" (null without children). */
function names(o, fam, lang) {
  const list = o.childIds.filter((id) => fam.byId.has(id)).map((id) => fam.byId.get(id).name);
  if (!list.length) return null;
  if (list.length === 1) return list[0];
  return list.slice(0, -1).join(', ') + push.t(lang, 'ride.and') + list[list.length - 1];
}

/** "heute 16:00 · Sporthalle Nord" */
function whenWhere(o, today, lang) {
  return [`${format.rel(o.date, today, lang)} ${o.time}`, o.place].filter(Boolean).join(' · ');
}

function ttlFor(o, cfg, now) {
  return Math.max(300, Math.min(2 * 86400, Math.round((startAt(o, cfg) - now) / 1000) + 3600));
}

/** A push about one ride to `users` (members only, never the caller). */
function ridePush(r, o, users, type, title, body, priority) {
  const to = [...new Set(users)].filter((u) => u !== r.me.userId && r.fam.byId.has(u));
  if (!to.length) return 0;
  r.pushes.push({
    topic: 'rides', users: to, priority: priority || 'normal', collapseKey: `ride:${o.key}`, ttl: ttlFor(o, r.cfg, r.now),
    title, body, data: { familie: { type, rideId: o.key, date: o.date } },
  });
  return to.length;
}

function titleFor(r, o, key, params) {
  const n = names(o, r.fam, r.cfg.lang);
  return push.t(r.cfg.lang, n ? key : key + '_title', { ...params, names: n, title: o.title, time: o.time });
}

function takenPush(r, o, driverName, extra) {
  ridePush(r, o, [o.requestedBy, ...o.childIds, ...(extra || [])], 'ride_taken',
    titleFor(r, o, 'ride.taken', { driver: driverName }), whenWhere(o, r.today, r.cfg.lang));
}

function releasedPush(r, o) {
  const to = [...members.parents(r.fam).map((m) => m.userId), o.requestedBy];
  ridePush(r, o, to, 'ride_released', titleFor(r, o, 'ride.released', { driver: r.me.name }), whenWhere(o, r.today, r.cfg.lang));
}

/** The parents who could drive: every parent except the one who asked (if that is a parent). */
function candidates(o, fam) {
  const all = members.parents(fam).map((m) => m.userId);
  const others = all.filter((u) => u !== o.requestedBy);
  return others.length ? others : all;
}

async function askNow(gc, r, o) {
  await saveOcc(gc, o, { askedAt: r.now }, r.now);
  const declined = new Set(o.declined);
  const to = members.parents(r.fam).map((m) => m.userId).filter((u) => !declined.has(u));
  return ridePush(r, o, to, 'ride_ask', titleFor(r, o, 'ride.ask'), o.place || whenWhere(o, r.today, r.cfg.lang), 'high');
}

// ─── API ────────────────────────────────────────

/** GET rides?from=&to= */
async function list(gc, r) {
  const q = r.query || {};
  const from = q.from != null && q.from !== '' ? date(String(q.from)) : r.today;
  const to = q.to != null && q.to !== '' ? date(String(q.to)) : tz.addDays(from, DEFAULT_RANGE_DAYS);
  if (to < from || tz.diffDays(from, to) > MAX_RANGE_DAYS) throw fail('invalid');
  return { from, to, rides: (await loadRange(gc, from, to)).map((o) => view(o, r)) };
}

/** GET rides/<id> */
async function one(gc, r, raw) {
  return { ride: view(await findOcc(gc, raw), r) };
}

/** POST rides */
async function create(gc, r) {
  const b = r.body || {};
  const parent = r.me.role === 'parent';
  if (!parent) {
    // children: "Bitte abholen" — only for themselves, no driver, no series
    if (b.driver != null || b.repeat != null) throw fail('parents_only');
    if (b.childIds !== undefined && !(Array.isArray(b.childIds) && b.childIds.length === 1 && posInt(b.childIds[0]) === r.me.userId)) throw fail('parents_only');
  }
  const d = date(b.date);
  if (d < r.today || tz.diffDays(r.today, d) > MAX_AHEAD_DAYS) throw fail('invalid');
  const t = requiredTime(b.time);
  const title = text(b.title, TITLE_MAX);
  const place = optText(b.place, PLACE_MAX) || '';
  const pos = parsePosition(b, { lat: null, lon: null });
  const childIds = parent ? (b.childIds == null ? [] : parseChildren(b.childIds, r.fam)) : [r.me.userId];
  const driver = parent ? parseDriver(b.driver, r.fam) : null;
  const remindMinutes = b.remindMinutes == null ? REMIND_DEFAULT : intIn(b.remindMinutes, 0, REMIND_MAX);
  const note = parseNote(b.note);
  const repeat = parent ? parseRepeat(b.repeat, d) : null;
  const ask = b.ask == null ? !parent : bool(b.ask);
  let first = d;
  if (repeat) {
    first = seriesDates({ date: d, endDate: repeat.endDate, weekdays: repeat.weekdays }, d, tz.addDays(d, 6))[0];
    if (!first) throw fail('invalid');
  }
  const res = await store.run(gc, `INSERT INTO rides (series, date, end_date, weekdays_json, time, title, place, lat, lon, child_ids_json, driver_user, driver_label,
    cancelled, requested_by, declined_json, asked_at, remind_minutes, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, '[]', NULL, ?, ?, ?, ?)`,
  [repeat ? 1 : 0, d, repeat ? repeat.endDate : null, repeat ? JSON.stringify(repeat.weekdays) : null, t, title, place, pos.lat, pos.lon, JSON.stringify(childIds),
    driver && driver.userId ? driver.userId : null, driver && driver.label ? driver.label : null, r.me.userId, remindMinutes, note, r.now, r.now]);
  const o = await occOf(gc, await getRide(gc, res.lastInsertRowid), first);
  const notified = ask && status(o, r.fam) === 'open' ? await askNow(gc, r, o) : 0;
  return { ride: view(o, r), notified };
}

/** Changes of one occurrence from a PATCH body (only what differs). */
function occChanges(b, o, fam, allowDate) {
  const ch = {};
  const set = (k, v) => { if (JSON.stringify(v) !== JSON.stringify(o[k])) ch[k] = v; };
  if (b.date !== undefined) {
    const d = date(b.date);
    if (d !== o.date) {
      if (!allowDate) throw fail('invalid');
      ch.date = d;
    }
  }
  if (b.time !== undefined) set('time', requiredTime(b.time));
  if (b.title !== undefined) set('title', text(b.title, TITLE_MAX));
  if (b.place !== undefined) set('place', optText(b.place, PLACE_MAX) || '');
  if (b.lat !== undefined || b.lon !== undefined) {
    const p = parsePosition(b, null);
    set('lat', p.lat);
    set('lon', p.lon);
  }
  if (b.childIds !== undefined) set('childIds', parseChildren(b.childIds, fam));
  if (b.driver !== undefined) {
    const d = parseDriver(b.driver, fam);
    set('driver', d);
    if (d && d.userId && o.declined.includes(d.userId)) ch.declined = o.declined.filter((u) => u !== d.userId);
  }
  if (b.remindMinutes !== undefined) set('remindMinutes', intIn(b.remindMinutes, 0, REMIND_MAX));
  if (b.note !== undefined) set('note', parseNote(b.note));
  if (b.status !== undefined) {
    if (b.status !== 'open' && b.status !== 'cancelled') throw fail('invalid');
    set('cancelled', b.status === 'cancelled');
  }
  return ch;
}

/** PATCH of a whole series (the defaults of every occurrence and the rule). */
async function updateSeries(gc, r, ride) {
  const b = r.body || {};
  if (b.status !== undefined) throw fail('invalid');
  const f = {
    date: b.date !== undefined ? date(b.date) : ride.date,
    time: b.time !== undefined ? requiredTime(b.time) : ride.time,
    title: b.title !== undefined ? text(b.title, TITLE_MAX) : ride.title,
    place: b.place !== undefined ? (optText(b.place, PLACE_MAX) || '') : ride.place,
    childIds: b.childIds !== undefined ? parseChildren(b.childIds, r.fam) : ride.childIds,
    driver: b.driver !== undefined ? parseDriver(b.driver, r.fam) : ride.driver,
    remindMinutes: b.remindMinutes !== undefined ? intIn(b.remindMinutes, 0, REMIND_MAX) : ride.remindMinutes,
    note: b.note !== undefined ? parseNote(b.note) : ride.note,
  };
  const pos = parsePosition(b, { lat: ride.lat, lon: ride.lon });
  let weekdays = ride.weekdays;
  let endDate = ride.endDate;
  if (b.repeat !== undefined) {
    const rep = parseRepeat(b.repeat, f.date);
    if (!rep) throw fail('invalid');
    weekdays = rep.weekdays;
    endDate = rep.endDate;
  }
  if (endDate && endDate < f.date) throw fail('invalid');
  await store.run(gc, `UPDATE rides SET date = ?, end_date = ?, weekdays_json = ?, time = ?, title = ?, place = ?, lat = ?, lon = ?, child_ids_json = ?,
    driver_user = ?, driver_label = ?, remind_minutes = ?, note = ?, updated_at = ? WHERE id = ?`,
  [f.date, endDate, JSON.stringify(weekdays), f.time, f.title, f.place, pos.lat, pos.lon, JSON.stringify(f.childIds),
    f.driver && f.driver.userId ? f.driver.userId : null, f.driver && f.driver.label ? f.driver.label : null, f.remindMinutes, f.note, r.now, ride.id]);
  return getRide(gc, ride.id);
}

/** The next occurrence of a series from `from` (or its first one), null when there is none. */
function nextDate(ride, from) {
  const start = from < ride.date ? ride.date : from;
  return seriesDates(ride, start, tz.addDays(start, 6))[0] || seriesDates(ride, ride.date, tz.addDays(ride.date, 6))[0] || null;
}

const wholeSeries = (r) => ['1', 'true'].includes(String((r.query || {}).series || ''));

/** PATCH rides/<id> (parents) */
async function update(gc, r, raw) {
  const { ride, date: d } = await resolve(gc, raw);
  if (ride.series && (wholeSeries(r) || !d)) {
    const fresh = await updateSeries(gc, r, ride);
    const at = d && inSeries(fresh, d) ? d : nextDate(fresh, r.today);
    return { ride: at ? view(await occOf(gc, fresh, at), r) : null };
  }
  const o = await occOf(gc, ride, d);
  const ch = occChanges(r.body || {}, o, r.fam, !ride.series);
  if (Object.keys(ch).length) await saveOcc(gc, o, ch, r.now);
  return { ride: view(await occOf(gc, await getRide(gc, ride.id), ch.date || d), r) };
}

/** DELETE rides/<id>: an occurrence is cancelled (kept until the retention), ?series=1 removes the series. */
async function remove(gc, r, raw) {
  const { ride, date: d } = await resolve(gc, raw);
  const parent = r.me.role === 'parent';
  if (ride.series && (wholeSeries(r) || !d)) {
    if (!parent) throw fail('parents_only');
    await store.run(gc, 'DELETE FROM rides WHERE id = ?', [ride.id]);
    await store.run(gc, 'DELETE FROM ride_overrides WHERE ride_id = ?', [ride.id]);
    return { ride: null, removed: 'series' };
  }
  // parents; a child only its own one-off request ("Bitte abholen")
  if (!parent && (ride.series || ride.requestedBy !== r.me.userId)) throw fail('parents_only');
  const o = await occOf(gc, ride, d);
  if (!o.cancelled) await saveOcc(gc, o, { cancelled: true }, r.now);
  return { ride: view(o, r) };
}

/** POST rides/<id>/take — a parent or an adult member drives. */
async function take(gc, r, raw) {
  if (!members.canDrive(r.me)) throw fail('parents_only');
  const o = await findOcc(gc, raw);
  if (o.cancelled) throw fail('cancelled');
  const d = liveDriver(o, r.fam);
  if (d && d.userId === r.me.userId) return { ride: view(o, r), already: true };
  if (d) throw fail('already_taken', { driver: driverView(d, r.fam) });
  await saveOcc(gc, o, { driver: { userId: r.me.userId }, declined: o.declined.filter((u) => u !== r.me.userId) }, r.now);
  takenPush(r, o, r.me.name);
  return { ride: view(o, r), already: false };
}

/** POST rides/<id>/release — the driver cannot after all. */
async function release(gc, r, raw) {
  const o = await findOcc(gc, raw);
  const d = liveDriver(o, r.fam);
  if (!d || d.userId !== r.me.userId) throw fail('forbidden');
  await saveOcc(gc, o, { driver: null }, r.now);
  releasedPush(r, o);
  return { ride: view(o, r) };
}

/** POST rides/<id>/decline — a parent cannot; when every parent declined, the one who asked hears it. */
async function decline(gc, r, raw) {
  if (r.me.role !== 'parent') throw fail('parents_only');
  const o = await findOcc(gc, raw);
  if (o.cancelled) throw fail('cancelled');
  const d = liveDriver(o, r.fam);
  const wasDriver = !!(d && d.userId === r.me.userId);
  const ch = {};
  if (!o.declined.includes(r.me.userId)) ch.declined = [...o.declined, r.me.userId];
  if (wasDriver) ch.driver = null;
  if (Object.keys(ch).length) await saveOcc(gc, o, ch, r.now);
  if (wasDriver) releasedPush(r, o);
  let unassigned = false;
  if (ch.declined && status(o, r.fam) === 'open') {
    const c = candidates(o, r.fam);
    if (c.length && c.every((u) => o.declined.includes(u))) {
      unassigned = true;
      ridePush(r, o, [o.requestedBy], 'ride_unassigned', titleFor(r, o, 'ride.unassigned'), whenWhere(o, r.today, r.cfg.lang), 'high');
    }
  }
  return { ride: view(o, r), unassigned };
}

/** POST rides/<id>/driver { userId } | { label } | { clear: true } (parents) */
async function setDriver(gc, r, raw) {
  const b = r.body || {};
  const o = await findOcc(gc, raw);
  if (o.cancelled) throw fail('cancelled');
  const driver = b.clear === true ? null : parseDriver(b, r.fam);
  if (b.clear !== true && !driver) throw fail('invalid');
  const ch = { driver };
  if (driver && driver.userId) ch.declined = o.declined.filter((u) => u !== driver.userId);
  await saveOcc(gc, o, ch, r.now);
  if (driver) takenPush(r, o, driver.userId ? r.fam.byId.get(driver.userId).name : driver.label, driver.userId ? [driver.userId] : []);
  return { ride: view(o, r) };
}

/** POST rides/<id>/ask — any member; at least 5 minutes apart per ride. */
async function ask(gc, r, raw) {
  const o = await findOcc(gc, raw);
  const st = status(o, r.fam);
  if (st === 'cancelled') throw fail('cancelled');
  if (st === 'taken') throw fail('already_taken', { driver: driverView(liveDriver(o, r.fam), r.fam) });
  if (o.askedAt != null && r.now - o.askedAt < ASK_GAP_MS) throw fail('too_soon', { retryAfter: Math.ceil((ASK_GAP_MS - (r.now - o.askedAt)) / 1000) });
  const notified = await askNow(gc, r, o);
  return { ride: view(o, r), notified };
}

/** Overview: the next 24 hours (at most 5) and the open rides of the next 7 days. */
async function overview(gc, r) {
  const occs = (await loadRange(gc, r.today, tz.addDays(r.today, DEFAULT_RANGE_DAYS))).filter((o) => !o.cancelled && startAt(o, r.cfg) >= r.now);
  return {
    next: occs.filter((o) => startAt(o, r.cfg) < r.now + NEXT_MS).slice(0, NEXT_MAX).map((o) => view(o, r)),
    open: occs.filter((o) => status(o, r.fam) === 'open').length,
  };
}

/** Today's rides that are not cancelled (wall view). */
async function today(gc, r) {
  return (await loadRange(gc, r.today, r.today)).filter((o) => !o.cancelled).map((o) => view(o, r));
}

/** Background: reminder to the driver, open rides to the parents — once per occurrence. Collects pushes. */
async function remind(gc, fam, cfg, now, pushes) {
  const day = tz.localDate(now, cfg.tz);
  const occs = await loadRange(gc, day, tz.addDays(day, 1));
  const lang = cfg.lang;
  const parents = members.parents(fam).map((m) => m.userId);
  for (const o of occs) {
    if (o.cancelled) continue;
    const start = startAt(o, cfg);
    if (now >= start) continue;
    const d = liveDriver(o, fam);
    const body = [o.time, o.place].filter(Boolean).join(' · ');
    const msg = (users, type, key, priority) => pushes.push({
      topic: 'rides', users, priority, collapseKey: `ride:${o.key}`, ttl: Math.max(300, Math.round((start - now) / 1000) + 3600),
      title: push.t(lang, key, { title: o.title, time: o.time }), body, data: { familie: { type, rideId: o.key, date: o.date } },
    });
    if (d && d.userId && now >= start - o.remindMinutes * 60000) {
      if (await notices.once(gc, `ride:${o.key}:reminder:${o.time}:${d.userId}`, now)) msg([d.userId], 'ride_reminder', 'ride.reminder', 'high');
    }
    if (!d && now >= start - OPEN_BEFORE_MS && !(o.askedAt != null && now - o.askedAt < OPEN_AFTER_ASK_MS)) {
      if (await notices.once(gc, `ride:${o.key}:open:${o.time}`, now) && parents.length) msg(parents, 'ride_open', 'ride.open', 'normal');
    }
  }
}

/** Retention: rides and overrides 30 days after their date, finished series. */
async function purge(gc, cfg, now) {
  const before = tz.addDays(tz.localDate(now, cfg.tz), -KEEP_DAYS);
  await store.run(gc, 'DELETE FROM rides WHERE series = 0 AND date < ?', [before]);
  await store.run(gc, 'DELETE FROM rides WHERE series = 1 AND end_date IS NOT NULL AND end_date < ?', [before]);
  await store.run(gc, 'DELETE FROM ride_overrides WHERE date < ? OR ride_id NOT IN (SELECT id FROM rides)', [before]);
}

module.exports = {
  ASK_GAP_MS, OPEN_BEFORE_MS, MAX_RANGE_DAYS, isoWd, seriesDates, inSeries, loadRange, list, one, create, update, remove, take, release, decline, setDriver, ask,
  overview, today, remind, purge,
  // 1.13.0: for an early end of school (server/schoolend.js)
  findOcc, saveOcc, liveDriver, status, names, ttlFor,
};
