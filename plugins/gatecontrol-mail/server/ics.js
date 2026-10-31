'use strict';

// iCalendar (RFC 5545) with ical.js (vendor/ical.cjs, unchanged): reading a calendar object into the fields of the API,
// its occurrences in a window (RRULE / RDATE / EXDATE / RECURRENCE-ID), writing own events and changing objects of a
// provider round trip (unknown properties stay — two-way sync), iTIP methods for invitations (iMIP, RFC 6047) and the
// field merge after a 412 of a CalDAV server.
//
// Times: wall clocks are converted with Intl (tz.js) — a TZID is resolved to an IANA zone (IANA names, vendor prefixes,
// Windows / Outlook names); an unknown TZID uses the file's own VTIMEZONE, else the person's zone (floating). Own
// events carry a VTIMEZONE block of timezones-ical-library (vendor/tzlib.cjs) for their TZID.
//
//   occ (an occurrence's key): the ms of its original start for timed events, its original date for all-day ones,
//   '' for a single event.

const ICAL = require('./vendor/ical.cjs');
const tzlib = require('./vendor/tzlib.cjs');
const tz = require('./tz');
const { fail, line, clip } = require('./util');

const PRODID = '-//GateControl//Mail//DE';
const DESC_MAX = 32 * 1024;
const MAX_ITER = 50000;
const MAX_OCC = 1500;
const ATTENDEES_MAX = 100;
const FREQS = ['daily', 'weekly', 'monthly', 'yearly'];
const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const PARTSTAT = { ACCEPTED: 'accepted', TENTATIVE: 'tentative', DECLINED: 'declined', 'NEEDS-ACTION': 'needs_action', DELEGATED: 'declined' };
const PARTSTAT_OUT = { accepted: 'ACCEPTED', tentative: 'TENTATIVE', declined: 'DECLINED', needs_action: 'NEEDS-ACTION' };
const ONLINE = [
  [/https:\/\/teams\.(microsoft|live)\.com\/[^\s"<>]+/i, 'teams'],
  [/https:\/\/[a-z0-9-]*\.?zoom\.us\/[^\s"<>]+/i, 'zoom'],
  [/https:\/\/meet\.google\.com\/[^\s"<>]+/i, 'meet'],
  [/https:\/\/[a-z0-9-]+\.webex\.com\/[^\s"<>]+/i, 'webex'],
];

ICAL.design.strict = false;

// ─── reading ────────────────────────────────────

/** Text of a VCALENDAR → its root component; throws invalid_ics. */
function root(text) {
  if (typeof text !== 'string' || !/BEGIN:VCALENDAR/i.test(text)) throw fail('invalid_ics');
  let c;
  try { c = new ICAL.Component(ICAL.parse(text)); } catch { throw fail('invalid_ics'); }
  if (c.name !== 'vcalendar') {
    // a file of several calendars: the first
    const first = c.getFirstSubcomponent && c.getFirstSubcomponent('vcalendar');
    if (!first) throw fail('invalid_ics');
    c = first;
  }
  return c;
}

/**
 * A VCALENDAR → { comp, method, objects: [{ uid, master, overrides: [vevent] }], zones: Map tzid → ICAL.Timezone }.
 * Events without UID get one from their content (read-only sources).
 */
function parse(text) {
  const comp = typeof text === 'string' ? root(text) : text;
  const zones = new Map();
  for (const z of comp.getAllSubcomponents('vtimezone')) {
    const id = z.getFirstPropertyValue('tzid');
    if (id) { try { zones.set(String(id), new ICAL.Timezone(z)); } catch { /* broken block */ } }
  }
  const byUid = new Map();
  for (const v of comp.getAllSubcomponents('vevent')) {
    let uid = v.getFirstPropertyValue('uid');
    if (!uid) uid = 'gc-' + require('node:crypto').createHash('sha1').update(v.toString()).digest('hex').slice(0, 24);
    uid = String(uid).slice(0, 255);
    if (!byUid.has(uid)) byUid.set(uid, { uid, master: null, overrides: [] });
    const o = byUid.get(uid);
    if (v.hasProperty('recurrence-id')) o.overrides.push(v); else if (!o.master) o.master = v;
  }
  const m = comp.getFirstPropertyValue('method');
  return { comp, method: m ? String(m).toUpperCase() : null, objects: [...byUid.values()], zones };
}

const isUtc = (t) => !!(t && t.zone && t.zone.tzid === 'UTC');

/** The IANA zone of a TZID (null: unknown). */
function zoneOf(tzid) {
  return tzid ? tz.resolveTz(String(tzid)) : null;
}

/** ICAL.Time `t` of property `prop` → ms (timed) — UTC, TZID (IANA or the file's VTIMEZONE) or floating in `userTz`. */
function instant(t, tzid, zones, userTz) {
  const wall = { y: t.year, m: t.month, d: t.day, hh: t.hour, mm: t.minute, ss: t.second };
  if (isUtc(t)) return Date.UTC(wall.y, wall.m - 1, wall.d, wall.hh, wall.mm, wall.ss);
  const iana = zoneOf(tzid);
  if (iana) return tz.toUtc(wall, iana);
  const own = tzid && zones ? zones.get(String(tzid)) : null;
  if (own) {
    try {
      const off = own.utcOffset(t);
      return Date.UTC(wall.y, wall.m - 1, wall.d, wall.hh, wall.mm, wall.ss) - off * 1000;
    } catch { /* the user's zone */ }
  }
  return tz.toUtc(wall, userTz || 'Europe/Berlin');
}

const dateOf = (t) => tz.dateStr(t.year, t.month, t.day);

/** A DTSTART/DTEND/RECURRENCE-ID property → { ms, date, allDay, tzid }. */
function timeOf(prop, zones, userTz) {
  if (!prop) return null;
  const t = prop.getFirstValue();
  if (!t || typeof t.year !== 'number') return null;
  const tzid = prop.getParameter('tzid') || null;
  if (t.isDate) {
    const date = dateOf(t);
    return { ms: tz.toUtc({ ...tz.parseDate(date) }, userTz || 'Europe/Berlin'), date, allDay: true, tzid: null };
  }
  return { ms: instant(t, tzid, zones, userTz), date: null, allDay: false, tzid: isUtc(t) ? 'UTC' : tzid };
}

/** The key of an occurrence from its original start. */
const occKey = (x) => (x.allDay ? x.date : String(x.ms));

const mailto = (v) => {
  const s = String(v || '').trim();
  const m = /^mailto:(.+)$/i.exec(s);
  const addr = (m ? m[1] : s).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(addr) ? addr.slice(0, 254) : null;
};

/** ATTENDEE / ORGANIZER property → { name, email, role, response, rsvp }. */
function personOf(p) {
  const email = mailto(p.getFirstValue());
  if (!email) return null;
  const cutype = String(p.getParameter('cutype') || '').toUpperCase();
  const role = String(p.getParameter('role') || '').toUpperCase();
  return {
    name: clip(line(p.getParameter('cn') || ''), 120), email,
    role: cutype === 'RESOURCE' || cutype === 'ROOM' ? 'resource' : role === 'OPT-PARTICIPANT' || role === 'NON-PARTICIPANT' ? 'optional' : 'required',
    response: PARTSTAT[String(p.getParameter('partstat') || 'NEEDS-ACTION').toUpperCase()] || 'needs_action',
  };
}

/** VALARM triggers → minutes before the start (≤ 3, sorted). */
function remindersOf(v) {
  const out = [];
  for (const a of v.getAllSubcomponents('valarm')) {
    const p = a.getFirstProperty('trigger');
    if (!p) continue;
    const val = p.getFirstValue();
    if (!val || typeof val.toSeconds !== 'function') continue;
    if (String(p.getParameter('related') || 'START').toUpperCase() !== 'START') continue;
    const min = Math.round(-val.toSeconds() / 60);
    if (min >= 0 && min <= 40320 && !out.includes(min)) out.push(min);
  }
  return out.sort((x, y) => x - y).slice(0, 3);
}

/** The online meeting of an event: CONFERENCE / X-…-URL properties, else a known meeting link in location or text. */
function onlineOf(v) {
  const props = ['conference', 'x-microsoft-skypeteamsmeetingurl', 'x-microsoft-onlinemeetingconflink', 'x-google-conference'];
  for (const n of props) {
    const val = v.getFirstPropertyValue(n);
    if (val && /^https:\/\//i.test(String(val))) return { url: String(val).slice(0, 2000), provider: providerOf(String(val)) };
  }
  const text = `${v.getFirstPropertyValue('location') || ''}\n${v.getFirstPropertyValue('description') || ''}`;
  for (const [re, provider] of ONLINE) {
    const m = re.exec(text);
    if (m) return { url: m[0].replace(/[).,;>\]]+$/, '').slice(0, 2000), provider };
  }
  return null;
}

function providerOf(url) {
  for (const [re, p] of ONLINE) if (re.test(url)) return p;
  return 'other';
}

/**
 * The fields of a VEVENT for the API and the columns → { title, location, description, start, end, allDay, startDate,
 * endDate, tz, rrule, status, busy, private, organizer, attendees, reminders, sequence, url, categories, online,
 * myResponse, dtstamp }. ctx: { userTz, own: Set of the person's addresses, zones }.
 */
function fieldsOf(v, ctx = {}) {
  const zones = ctx.zones || new Map();
  const userTz = ctx.userTz || 'Europe/Berlin';
  const s = timeOf(v.getFirstProperty('dtstart'), zones, userTz);
  if (!s) throw fail('invalid_ics');
  let e = timeOf(v.getFirstProperty('dtend'), zones, userTz);
  if (!e) {
    const dur = v.getFirstPropertyValue('duration');
    if (dur && typeof dur.toSeconds === 'function') {
      e = s.allDay ? { allDay: true, date: tz.addDays(s.date, Math.max(1, Math.round(dur.toSeconds() / 86400))) } : { ms: s.ms + dur.toSeconds() * 1000, allDay: false };
    } else e = s.allDay ? { allDay: true, date: tz.addDays(s.date, 1) } : { ms: s.ms, allDay: false };
  }
  let start; let end; let startDate = null; let endDate = null;
  if (s.allDay) {
    startDate = s.date;
    const excl = e.allDay && e.date > s.date ? e.date : tz.addDays(s.date, 1);
    endDate = tz.addDays(excl, -1);
    start = s.ms;
    end = tz.toUtc({ ...tz.parseDate(excl) }, userTz);
  } else {
    start = s.ms;
    end = Math.max(s.ms, e.ms != null ? e.ms : s.ms);
  }
  const org = v.getFirstProperty('organizer');
  const organizer = org ? personOf(org) : null;
  const attendees = v.getAllProperties('attendee').map(personOf).filter(Boolean).slice(0, ATTENDEES_MAX);
  const own = ctx.own || new Set();
  let myResponse = null;
  if (organizer && own.has(organizer.email)) myResponse = 'organizer';
  else {
    const me = attendees.find((a) => own.has(a.email));
    if (me) myResponse = me.response;
  }
  const status = String(v.getFirstPropertyValue('status') || 'CONFIRMED').toUpperCase();
  const transp = String(v.getFirstPropertyValue('transp') || 'OPAQUE').toUpperCase();
  const msBusy = String(v.getFirstPropertyValue('x-microsoft-cdo-busystatus') || '').toUpperCase();
  const cls = String(v.getFirstPropertyValue('class') || 'PUBLIC').toUpperCase();
  const rr = v.getFirstPropertyValue('rrule');
  const cats = [];
  for (const p of v.getAllProperties('categories')) for (const c of p.getValues()) if (c && cats.length < 20) cats.push(clip(line(String(c)), 60));
  const stamp = v.getFirstPropertyValue('dtstamp');
  const desc = v.getFirstPropertyValue('description');
  const url = v.getFirstPropertyValue('url');
  return {
    title: clip(line(String(v.getFirstPropertyValue('summary') || '')), 255), location: v.getFirstPropertyValue('location') ? clip(line(String(v.getFirstPropertyValue('location'))), 500) : null,
    description: desc ? String(desc).slice(0, DESC_MAX) : '', start, end, allDay: s.allDay, startDate, endDate,
    tz: s.allDay ? null : (s.tzid === 'UTC' ? 'UTC' : (zoneOf(s.tzid) || userTz)), rrule: rr ? rr.toString() : null,
    status: status === 'CANCELLED' ? 'cancelled' : status === 'TENTATIVE' ? 'tentative' : 'confirmed',
    busy: msBusy === 'OOF' ? 'oof' : msBusy === 'TENTATIVE' ? 'tentative' : (transp === 'TRANSPARENT' || msBusy === 'FREE') ? 'free' : 'busy',
    private: cls === 'PRIVATE' || cls === 'CONFIDENTIAL', organizer, attendees, reminders: remindersOf(v),
    sequence: Number(v.getFirstPropertyValue('sequence')) || 0, url: url ? String(url).slice(0, 2000) : null, categories: cats,
    online: onlineOf(v), myResponse, dtstamp: stamp && typeof stamp.toJSDate === 'function' ? stamp.toJSDate().getTime() : null,
  };
}

/**
 * Occurrences of object `o` ({ master, overrides }) overlapping [from, to) → [{ occ, start, end, allDay, startDate,
 * endDate, override: fields | null }] (at most MAX_OCC).
 */
function expand(o, ctx, from, to) {
  const zones = ctx.zones || new Map();
  const userTz = ctx.userTz || 'Europe/Berlin';
  const out = [];
  const view = (f, occ, ov) => ({ occ, start: f.start, end: f.end, allDay: f.allDay, startDate: f.startDate, endDate: f.endDate, override: ov });
  if (!o.master) {
    // only instances (an invitation to one occurrence): each on its own
    for (const v of o.overrides) {
      const f = fieldsOf(v, ctx);
      const rid = timeOf(v.getFirstProperty('recurrence-id'), zones, userTz);
      if (f.end > from && f.start < to) out.push(view(f, rid ? occKey(rid) : '', f));
    }
    return out;
  }
  const base = fieldsOf(o.master, ctx);
  const recurring = o.master.hasProperty('rrule') || o.master.hasProperty('rdate');
  if (!recurring) {
    if (base.end > from && base.start < to) out.push(view(base, '', null));
    return out;
  }
  let ev;
  let master = o.master;
  const masterTzid0 = master.getFirstProperty('dtstart').getParameter('tzid') || null;
  const rule0 = master.getFirstPropertyValue('rrule');
  const zone0 = zoneOf(masterTzid0);
  if (rule0 && rule0.until && isUtc(rule0.until) && zone0 && zone0 !== 'UTC') {
    // the wall clocks iterate without a zone: an UNTIL in UTC becomes the wall clock of the event's zone
    master = new ICAL.Component(JSON.parse(JSON.stringify(master.toJSON())));
    const r = master.getFirstPropertyValue('rrule');
    const until = Date.UTC(r.until.year, r.until.month - 1, r.until.day, r.until.hour, r.until.minute, r.until.second);
    r.until = wallTime(until, zone0);
    master.getFirstProperty('rrule').setValue(r);
  }
  try {
    ev = new ICAL.Event(master);
    for (const x of o.overrides) { try { ev.relateException(x); } catch { /* a broken override */ } }
  } catch { throw fail('invalid_ics'); }
  const masterTzid = o.master.getFirstProperty('dtstart').getParameter('tzid') || null;
  const dur = base.allDay ? tz.diffDays(base.startDate, base.endDate) : base.end - base.start;
  const it = ev.iterator();
  // RFC 5545: a monthly / yearly rule without BY… parts skips months without that day (31st, 29 February) — ical.js
  // would roll them over into the next month
  const rule = o.master.getFirstPropertyValue('rrule');
  const plain = rule && ['MONTHLY', 'YEARLY'].includes(String(rule.freq)) && !Object.keys(rule.parts || {}).some((k) => /^BY/.test(k) && rule.parts[k] != null);
  const dt0 = o.master.getFirstPropertyValue('dtstart');
  let n;
  for (let i = 0; i < MAX_ITER && (n = it.next()); i++) {
    if (plain && (n.day !== dt0.day || (String(rule.freq) === 'YEARLY' && n.month !== dt0.month))) continue;
    // the original start of this occurrence
    let orig;
    if (n.isDate) orig = { allDay: true, date: dateOf(n), ms: tz.toUtc({ ...tz.parseDate(dateOf(n)) }, userTz) };
    else orig = { allDay: false, ms: instant(n, isUtc(n) ? null : masterTzid, zones, userTz) };
    if (isUtc(n)) orig.ms = Date.UTC(n.year, n.month - 1, n.day, n.hour, n.minute, n.second);
    if (orig.ms >= to + 7 * 86400000 && !base.allDay) break;
    if (base.allDay && orig.ms >= to + 7 * 86400000) break;
    const occ = occKey(orig);
    const exc = ev.exceptions[n.toString()] || null;
    let f;
    let ov = null;
    if (exc) {
      try { ov = fieldsOf(exc.component, ctx); f = ov; } catch { ov = null; }
    }
    if (!f) {
      if (base.allDay) {
        const sd = orig.date;
        const ed = tz.addDays(sd, dur);
        f = { start: orig.ms, end: tz.toUtc({ ...tz.parseDate(tz.addDays(ed, 1)) }, userTz), allDay: true, startDate: sd, endDate: ed };
      } else f = { start: orig.ms, end: orig.ms + dur, allDay: false, startDate: null, endDate: null };
    }
    if (f.end > from && f.start < to) out.push(view(f, occ, ov));
    if (out.length >= MAX_OCC) break;
  }
  return out;
}

/** The EXDATE keys of a master (deleted occurrences). */
function exdates(master, ctx) {
  const out = [];
  for (const p of master.getAllProperties('exdate')) {
    const tzid = p.getParameter('tzid') || null;
    for (const t of p.getValues()) {
      if (!t || typeof t.year !== 'number') continue;
      out.push(t.isDate ? dateOf(t) : String(instant(t, tzid, ctx.zones, ctx.userTz)));
    }
  }
  return out;
}

/** The Recurrence of the API for a master VEVENT (null: not recurring). */
function recurrenceOf(o, ctx) {
  const m = o.master;
  if (!m) return null;
  const r = m.getFirstPropertyValue('rrule');
  if (!r) return null;
  const parts = r.parts || {};
  const keys = Object.keys(parts).filter((k) => parts[k] != null && !(Array.isArray(parts[k]) && !parts[k].length));
  let byDay = null;
  let bySetPos = null;
  let editable = true;
  if (parts.BYDAY) {
    const list = Array.isArray(parts.BYDAY) ? parts.BYDAY : [parts.BYDAY];
    byDay = [];
    for (const d of list) {
      const mm = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(String(d));
      if (!mm) { editable = false; continue; }
      if (mm[1]) {
        if (bySetPos != null || list.length > 1) editable = false;
        bySetPos = Number(mm[1]);
      }
      byDay.push(mm[2]);
    }
  }
  if (parts.BYSETPOS) {
    const sp = Array.isArray(parts.BYSETPOS) ? parts.BYSETPOS : [parts.BYSETPOS];
    if (sp.length !== 1 || bySetPos != null) editable = false;
    bySetPos = Number(sp[0]);
  }
  const byMonthDay = parts.BYMONTHDAY ? (Array.isArray(parts.BYMONTHDAY) ? parts.BYMONTHDAY : [parts.BYMONTHDAY]).map(Number) : null;
  const allowed = new Set(['BYDAY', 'BYMONTHDAY', 'BYSETPOS', 'BYMONTH', 'WKST']);
  for (const k of keys) if (!allowed.has(k)) editable = false;
  if (parts.BYMONTH && String(r.freq) !== 'YEARLY') editable = false;
  if (byMonthDay && byMonthDay.length > 1) editable = false;
  const freq = String(r.freq || '').toLowerCase();
  if (!FREQS.includes(freq)) editable = false;
  const until = r.until ? dateOf(r.until) : null;
  const overrides = o.overrides.map((v) => timeOf(v.getFirstProperty('recurrence-id'), ctx.zones, ctx.userTz)).filter(Boolean).map(occKey);
  return {
    rrule: r.toString(), editable, freq: FREQS.includes(freq) ? freq : 'daily', interval: Number(r.interval) || 1, byDay: byDay && byDay.length ? byDay : null,
    byMonthDay, bySetPos, until, count: r.count != null ? Number(r.count) : null, exceptions: overrides, deleted: exdates(m, ctx),
  };
}

// ─── writing ────────────────────────────────────

const RULE_RE = /^[A-Z0-9=;,:+-]{1,500}$/;

/**
 * The API's recurrence ({ freq, interval, byDay, byMonthDay, bySetPos, until, count } | { rrule } | null) → an RRULE
 * string or null; throws invalid { field: 'recurrence' }.
 */
function ruleOf(r) {
  if (r == null) return null;
  const bad = () => { throw fail('invalid', { field: 'recurrence' }); };
  if (typeof r !== 'object' || Array.isArray(r)) bad();
  if (r.rrule !== undefined) {
    const s = String(r.rrule || '').trim().replace(/^RRULE:/i, '').toUpperCase();
    if (!RULE_RE.test(s)) bad();
    try { const x = ICAL.Recur.fromString(s); if (!x.freq) bad(); return x.toString(); } catch { return bad(); }
  }
  if (!FREQS.includes(r.freq)) bad();
  const parts = [`FREQ=${r.freq.toUpperCase()}`];
  if (r.interval != null) { if (!(Number.isInteger(r.interval) && r.interval >= 1 && r.interval <= 999)) bad(); if (r.interval > 1) parts.push(`INTERVAL=${r.interval}`); }
  if (r.byDay != null) {
    if (!Array.isArray(r.byDay) || !r.byDay.length || r.byDay.length > 7 || !r.byDay.every((d) => DAYS.includes(d))) bad();
    if (r.bySetPos != null) {
      if (!(Number.isInteger(r.bySetPos) && r.bySetPos !== 0 && r.bySetPos >= -5 && r.bySetPos <= 5) || r.byDay.length !== 1) bad();
      parts.push(`BYDAY=${r.bySetPos}${r.byDay[0]}`);
    } else parts.push(`BYDAY=${r.byDay.join(',')}`);
  } else if (r.bySetPos != null) bad();
  if (r.byMonthDay != null) {
    if (!Array.isArray(r.byMonthDay) || !r.byMonthDay.length || r.byMonthDay.length > 31 || !r.byMonthDay.every((d) => Number.isInteger(d) && d !== 0 && d >= -31 && d <= 31)) bad();
    parts.push(`BYMONTHDAY=${r.byMonthDay.join(',')}`);
  }
  if (r.until != null && r.count != null) bad();
  if (r.until != null) { if (!tz.parseDate(r.until)) bad(); parts.push(`UNTIL=${r.until.replace(/-/g, '')}`); }
  if (r.count != null) { if (!(Number.isInteger(r.count) && r.count >= 1 && r.count <= 1000)) bad(); parts.push(`COUNT=${r.count}`); }
  return parts.join(';');
}

const icalDate = (s) => { const p = tz.parseDate(s); return new ICAL.Time({ year: p.y, month: p.m, day: p.d, isDate: true }); };
const utcTime = (ms) => ICAL.Time.fromJSDate(new Date(ms), true);

/** A wall clock time of `ms` in `zone` (IANA; 'UTC' → Z). */
function wallTime(ms, zone) {
  if (!zone || zone === 'UTC') return utcTime(ms);
  const p = tz.parts(ms, zone);
  return new ICAL.Time({ year: p.y, month: p.m, day: p.d, hour: p.hh, minute: p.mm, second: p.ss, isDate: false });
}

/** Set (replace) property `name` of component `c` to `value` (null/'' removes it). */
function setProp(c, name, value, params) {
  c.removeAllProperties(name);
  if (value == null || value === '') return null;
  const p = new ICAL.Property(name, c);
  if (params) for (const [k, v] of Object.entries(params)) if (v != null) p.setParameter(k, v);
  p.setValue(value);
  c.addProperty(p);
  return p;
}

/** Set a DATE / DATE-TIME property: all-day `date` (YYYY-MM-DD), else `ms` in `zone`. */
function setTime(c, name, { date, ms, zone }) {
  c.removeAllProperties(name);
  const p = new ICAL.Property(name, c);
  if (date) p.setValue(icalDate(date));
  else {
    const t = wallTime(ms, zone);
    p.setValue(t);
    if (zone && zone !== 'UTC') p.setParameter('tzid', zone);
  }
  c.addProperty(p);
  return p;
}

/** The VTIMEZONE blocks for every TZID of the calendar that has none yet (IANA zones of timezones-ical-library). */
function ensureZones(cal) {
  const have = new Set(cal.getAllSubcomponents('vtimezone').map((z) => String(z.getFirstPropertyValue('tzid'))));
  const want = new Set();
  const walk = (c) => {
    for (const p of c.getAllProperties()) { const id = p.getParameter && p.getParameter('tzid'); if (id) want.add(String(id)); }
    for (const s of c.getAllSubcomponents()) if (s.name !== 'vtimezone') walk(s);
  };
  walk(cal);
  for (const id of want) {
    if (have.has(id)) continue;
    let block = null;
    try { const r = tzlib.tzlib_get_ical_block(id); if (Array.isArray(r) && typeof r[0] === 'string' && r[0].startsWith('BEGIN:VTIMEZONE')) block = r[0]; } catch { block = null; }
    if (!block) continue;
    try {
      const z = new ICAL.Component(ICAL.parse(`BEGIN:VCALENDAR\r\n${block}\r\nEND:VCALENDAR`)).getFirstSubcomponent('vtimezone');
      // the zones go first (before the events)
      const events = cal.getAllSubcomponents().filter((s) => s.name !== 'vtimezone');
      for (const e of events) cal.removeSubcomponent(e);
      cal.addSubcomponent(z);
      for (const e of events) cal.addSubcomponent(e);
    } catch { /* without the block: the TZID is an IANA name anyway */ }
  }
}

function attendeeProp(c, a, partstat) {
  const p = new ICAL.Property('attendee', c);
  if (a.name) p.setParameter('cn', a.name);
  p.setParameter('cutype', a.role === 'resource' ? 'RESOURCE' : 'INDIVIDUAL');
  p.setParameter('role', a.role === 'optional' ? 'OPT-PARTICIPANT' : 'REQ-PARTICIPANT');
  p.setParameter('partstat', partstat || PARTSTAT_OUT[a.response] || 'NEEDS-ACTION');
  if (!partstat && (!a.response || a.response === 'needs_action')) p.setParameter('rsvp', 'TRUE');
  p.setValue(`mailto:${a.email}`);
  c.addProperty(p);
  return p;
}

function organizerProp(c, o) {
  c.removeAllProperties('organizer');
  if (!o) return;
  const p = new ICAL.Property('organizer', c);
  if (o.name) p.setParameter('cn', o.name);
  p.setValue(`mailto:${o.email}`);
  c.addProperty(p);
}

function setAlarms(v, minutes, title) {
  for (const a of v.getAllSubcomponents('valarm')) v.removeSubcomponent(a);
  for (const m of minutes || []) {
    const a = new ICAL.Component('valarm');
    a.addPropertyWithValue('action', 'DISPLAY');
    a.addPropertyWithValue('description', title || 'Reminder');
    const p = new ICAL.Property('trigger', a);
    p.setValue(ICAL.Duration.fromSeconds(-m * 60));
    a.addProperty(p);
    v.addSubcomponent(a);
  }
}

/**
 * Apply change `x` (fields of the API, already checked: title, allDay, start, end, startDate, endDate, timeZone,
 * location, description, online: { url } | null, reminders, rrule (string | null), attendees, organizer, busy, private,
 * status) to VEVENT `v`. Only the fields present are touched.
 */
function applyFields(v, x) {
  const has = (k) => Object.prototype.hasOwnProperty.call(x, k);
  if (has('title')) setProp(v, 'summary', x.title || '');
  if (has('location')) setProp(v, 'location', x.location || null);
  if (has('description')) setProp(v, 'description', x.description || null);
  if (has('start') || has('startDate') || has('allDay')) {
    if (x.allDay) {
      setTime(v, 'dtstart', { date: x.startDate });
      setTime(v, 'dtend', { date: tz.addDays(x.endDate || x.startDate, 1) });
    } else {
      setTime(v, 'dtstart', { ms: x.start, zone: x.timeZone });
      setTime(v, 'dtend', { ms: x.end, zone: x.timeZone });
    }
    v.removeAllProperties('duration');
  }
  if (has('rrule')) {
    v.removeAllProperties('rrule');
    if (x.rrule) { const p = new ICAL.Property('rrule', v); p.setValue(ICAL.Recur.fromString(x.rrule)); v.addProperty(p); }
  }
  if (has('online')) {
    v.removeAllProperties('conference');
    if (x.online && x.online.url) setProp(v, 'conference', x.online.url, { value: 'URI', feature: 'VIDEO' });
  }
  if (has('reminders')) setAlarms(v, x.reminders, x.title || v.getFirstPropertyValue('summary'));
  if (has('busy')) {
    setProp(v, 'transp', x.busy === 'free' ? 'TRANSPARENT' : 'OPAQUE');
    v.removeAllProperties('x-microsoft-cdo-busystatus');
    if (x.busy === 'oof' || x.busy === 'tentative') setProp(v, 'x-microsoft-cdo-busystatus', x.busy === 'oof' ? 'OOF' : 'TENTATIVE');
  }
  if (has('private')) setProp(v, 'class', x.private ? 'PRIVATE' : 'PUBLIC');
  if (has('status')) setProp(v, 'status', x.status === 'cancelled' ? 'CANCELLED' : x.status === 'tentative' ? 'TENTATIVE' : 'CONFIRMED');
  if (has('organizer')) organizerProp(v, x.organizer);
  if (has('attendees')) {
    const before = new Map(v.getAllProperties('attendee').map((p) => [mailto(p.getFirstValue()), p]));
    v.removeAllProperties('attendee');
    for (const a of x.attendees || []) {
      const old = before.get(a.email);
      if (old && !a.response) {
        // the answer an attendee gave stays
        const keep = old.getParameter('partstat');
        attendeeProp(v, { ...a, response: PARTSTAT[String(keep || '').toUpperCase()] || 'needs_action' });
      } else attendeeProp(v, a);
    }
  }
  const now = utcTime(Date.now());
  setProp(v, 'dtstamp', now);
  setProp(v, 'last-modified', now);
}

/** A new calendar object of an own event (fields like applyFields) → VCALENDAR text. */
function build(uid, x) {
  const cal = new ICAL.Component('vcalendar');
  cal.addPropertyWithValue('version', '2.0');
  cal.addPropertyWithValue('prodid', PRODID);
  cal.addPropertyWithValue('calscale', 'GREGORIAN');
  const v = new ICAL.Component('vevent');
  v.addPropertyWithValue('uid', uid);
  setProp(v, 'created', utcTime(Date.now()));
  v.addPropertyWithValue('sequence', Number(x.sequence) || 0);
  applyFields(v, { title: '', ...x });
  cal.addSubcomponent(v);
  ensureZones(cal);
  return cal.toString();
}

/** The master (or the override of `occ`, created from the master when missing) of object `uid` in `cal`. */
function target(cal, uid, occ, ctx, create) {
  const p = parse(cal);
  const o = p.objects.find((x) => x.uid === uid) || p.objects[0];
  if (!o) throw fail('not_found');
  if (!occ) { if (!o.master) throw fail('not_found'); return { o, v: o.master }; }
  let v = o.overrides.find((x) => occKey(timeOf(x.getFirstProperty('recurrence-id'), ctx.zones || p.zones, ctx.userTz)) === occ);
  if (!v && create) {
    if (!o.master) throw fail('not_found');
    v = new ICAL.Component(JSON.parse(JSON.stringify(o.master.toJSON())));
    v.removeAllProperties('rrule'); v.removeAllProperties('rdate'); v.removeAllProperties('exdate');
    // the occurrence's original start and its own times
    const base = fieldsOf(o.master, { ...ctx, zones: p.zones });
    const tzid = o.master.getFirstProperty('dtstart').getParameter('tzid');
    let rid;
    if (/^\d{4}-\d{2}-\d{2}$/.test(occ)) {
      rid = { date: occ };
      setTime(v, 'dtstart', { date: occ });
      setTime(v, 'dtend', { date: tz.addDays(occ, tz.diffDays(base.startDate, base.endDate) + 1) });
    } else {
      const ms = Number(occ);
      const zone = zoneOf(tzid) || (tzid ? null : 'UTC') || base.tz;
      rid = { ms, zone };
      setTime(v, 'dtstart', { ms, zone });
      setTime(v, 'dtend', { ms: ms + (base.end - base.start), zone });
    }
    setTime(v, 'recurrence-id', rid);
    cal.addSubcomponent(v);
  }
  if (!v) throw fail('not_found');
  return { o, v };
}

/**
 * Change object text `text` (round trip): `x` (applyFields) on the master or, with `occ`, on that occurrence (an
 * override is made). → the new text.
 */
function change(text, uid, x, { occ = null, ctx = {}, bump = false } = {}) {
  const cal = root(text);
  const { o, v } = target(cal, uid, occ, ctx, true);
  applyFields(v, x);
  if (bump) {
    for (const c of [o.master, ...o.overrides].filter(Boolean)) setProp(c, 'sequence', (Number(c.getFirstPropertyValue('sequence')) || 0) + 1);
    if (v !== o.master && !o.overrides.includes(v)) setProp(v, 'sequence', (Number(v.getFirstPropertyValue('sequence')) || 0) + 1);
  }
  if (!occ && Object.prototype.hasOwnProperty.call(x, 'rrule') && !x.rrule) {
    // no longer recurring: the exceptions go
    for (const ov of cal.getAllSubcomponents('vevent').filter((c) => c.hasProperty('recurrence-id'))) cal.removeSubcomponent(ov);
    o.master.removeAllProperties('exdate');
  }
  ensureZones(cal);
  return cal.toString();
}

/** One occurrence deleted (EXDATE on the master, its override removed) → the new text. */
function exclude(text, uid, occ, ctx = {}) {
  const cal = root(text);
  const p = parse(cal);
  const o = p.objects.find((x) => x.uid === uid) || p.objects[0];
  if (!o || !o.master) throw fail('not_found');
  for (const ov of o.overrides) {
    if (occKey(timeOf(ov.getFirstProperty('recurrence-id'), p.zones, ctx.userTz)) === occ) cal.removeSubcomponent(ov);
  }
  const tzid = o.master.getFirstProperty('dtstart').getParameter('tzid');
  const dt = o.master.getFirstPropertyValue('dtstart');
  const prop = new ICAL.Property('exdate', o.master);
  if (/^\d{4}-\d{2}-\d{2}$/.test(occ)) prop.setValue(icalDate(occ));
  else {
    const zone = isUtc(dt) ? 'UTC' : (zoneOf(tzid) || ctx.userTz || 'UTC');
    prop.setValue(wallTime(Number(occ), zone));
    if (zone !== 'UTC') prop.setParameter('tzid', tzid || zone);
  }
  o.master.addProperty(prop);
  setProp(o.master, 'dtstamp', utcTime(Date.now()));
  return cal.toString();
}

/** The PARTSTAT of attendee `email` (on the master and every override, or on `occ` only) → the new text. */
function partstat(text, email, response, { occ = null, ctx = {}, comment = null } = {}) {
  const cal = root(text);
  const p = parse(cal);
  const targets = [];
  for (const o of p.objects) {
    if (occ) { try { targets.push(target(cal, o.uid, occ, ctx, true).v); } catch { /* not this object */ } } else targets.push(...[o.master, ...o.overrides].filter(Boolean));
  }
  for (const v of targets) {
    let found = false;
    for (const a of v.getAllProperties('attendee')) {
      if (mailto(a.getFirstValue()) !== email) continue;
      a.setParameter('partstat', PARTSTAT_OUT[response] || 'NEEDS-ACTION');
      a.removeParameter('rsvp');
      found = true;
    }
    if (!found) attendeeProp(v, { email, name: '', role: 'required' }, PARTSTAT_OUT[response]);
    if (comment != null) setProp(v, 'comment', comment || null);
    setProp(v, 'dtstamp', utcTime(Date.now()));
  }
  return cal.toString();
}

// ─── iTIP (iMIP) ────────────────────────────────

/**
 * An iTIP message of method `method` from object text `text` (RFC 5546): REQUEST / CANCEL (the whole object or one
 * occurrence `occ`), REPLY (only `me` as attendee with `response`, COMMENT), COUNTER (REPLY-like with the proposed times),
 * DECLINECOUNTER (organizer to `me`). → VCALENDAR text with METHOD.
 */
function itip(method, text, o = {}) {
  const src = root(text);
  const cal = new ICAL.Component('vcalendar');
  cal.addPropertyWithValue('version', '2.0');
  cal.addPropertyWithValue('prodid', PRODID);
  cal.addPropertyWithValue('method', method);
  const p = parse(src);
  const obj = (o.uid && p.objects.find((x) => x.uid === o.uid)) || p.objects[0];
  if (!obj) throw fail('invalid_ics');
  let comps = [obj.master, ...obj.overrides].filter(Boolean);
  if (o.occ) {
    const want = comps.find((c) => c.hasProperty('recurrence-id') && occKey(timeOf(c.getFirstProperty('recurrence-id'), p.zones, o.userTz)) === o.occ);
    if (want) comps = [want];
    else if (obj.master) {
      // an occurrence without an override yet: a copy of the master for that instance
      const tmp = root(src.toString());
      comps = [target(tmp, obj.uid, o.occ, { userTz: o.userTz }, true).v];
    }
  }
  const now = utcTime(Date.now());
  for (const c0 of comps) {
    const c = new ICAL.Component(JSON.parse(JSON.stringify(c0.toJSON())));
    setProp(c, 'dtstamp', now);
    if (method === 'CANCEL') setProp(c, 'status', 'CANCELLED');
    if (method === 'REPLY' || method === 'COUNTER') {
      const me = c.getAllProperties('attendee').find((a) => mailto(a.getFirstValue()) === o.me);
      c.removeAllProperties('attendee');
      for (const a of c.getAllSubcomponents('valarm')) c.removeSubcomponent(a);
      attendeeProp(c, { email: o.me, name: o.myName || (me && me.getParameter('cn')) || '', role: 'required' }, PARTSTAT_OUT[o.response] || 'ACCEPTED');
      setProp(c, 'comment', o.comment || null);
      if (method === 'COUNTER' && o.proposed) {
        const zone = o.proposed.timeZone || 'UTC';
        setTime(c, 'dtstart', { ms: o.proposed.start, zone });
        setTime(c, 'dtend', { ms: o.proposed.end, zone });
      }
    }
    if (method === 'DECLINECOUNTER') {
      c.removeAllProperties('attendee');
      attendeeProp(c, { email: o.me, name: o.myName || '', role: 'required' }, 'NEEDS-ACTION');
      setProp(c, 'comment', o.comment || null);
    }
    if (method === 'CANCEL' && Array.isArray(o.only)) {
      // removed attendees only
      c.removeAllProperties('attendee');
      for (const a of o.only) attendeeProp(c, a);
    }
    for (const a of c.getAllSubcomponents('valarm')) if (method !== 'REQUEST') c.removeSubcomponent(a);
    cal.addSubcomponent(c);
  }
  for (const z of src.getAllSubcomponents('vtimezone')) cal.addSubcomponent(new ICAL.Component(JSON.parse(JSON.stringify(z.toJSON()))));
  ensureZones(cal);
  // VTIMEZONE before VEVENT
  const zs = cal.getAllSubcomponents('vtimezone');
  const evs = cal.getAllSubcomponents('vevent');
  for (const c of [...zs, ...evs]) cal.removeSubcomponent(c);
  for (const c of [...zs, ...evs]) cal.addSubcomponent(c);
  return cal.toString();
}

/** Strip the iTIP envelope (METHOD) from an invitation → a calendar object to store. */
function objectOf(text) {
  const cal = root(text);
  cal.removeAllProperties('method');
  for (const v of cal.getAllSubcomponents('vevent')) for (const a of v.getAllProperties('x-ms-olk-forceinspectoropen')) v.removeProperty(a);
  return cal.toString();
}

// ─── the field merge after a 412 ────────────────

const FIELD_PROPS = {
  title: ['summary'], location: ['location'], description: ['description'], time: ['dtstart', 'dtend', 'duration'], rule: ['rrule', 'rdate', 'exdate'],
  attendees: ['attendee', 'organizer'], status: ['status'], busy: ['transp', 'x-microsoft-cdo-busystatus'], private: ['class'], online: ['conference'],
  categories: ['categories'],
};

function snapshot(text, uid) {
  const cal = root(text);
  const p = parse(cal);
  const o = p.objects.find((x) => x.uid === uid) || p.objects[0];
  const out = {};
  if (!o || !o.master) return { cal, o, out };
  for (const [k, names] of Object.entries(FIELD_PROPS)) {
    out[k] = names.map((n) => o.master.getAllProperties(n).map((x) => x.toICALString()).sort().join('\n')).join('\n');
  }
  out.alarms = o.master.getAllSubcomponents('valarm').map((a) => a.toString()).sort().join('\n');
  out.overrides = o.overrides.map((v) => v.toString().replace(/^(DTSTAMP|LAST-MODIFIED):.*$/gm, '')).sort().join('\n---\n');
  return { cal, o, out };
}

/**
 * Three-way field merge: `mine` changed `base`, the provider changed it to `theirs` meanwhile. → the merged text (theirs
 * with my changed fields) or null when both touched the same field.
 */
function merge(base, theirs, mine, uid) {
  const b = snapshot(base, uid);
  const t = snapshot(theirs, uid);
  const m = snapshot(mine, uid);
  if (!b.o || !t.o || !m.o || !t.o.master || !m.o.master) return null;
  const changed = Object.keys(m.out).filter((k) => m.out[k] !== b.out[k]);
  for (const k of changed) if (t.out[k] !== b.out[k] && t.out[k] !== m.out[k]) return null;
  for (const k of changed) {
    if (k === 'alarms') {
      for (const a of t.o.master.getAllSubcomponents('valarm')) t.o.master.removeSubcomponent(a);
      for (const a of m.o.master.getAllSubcomponents('valarm')) t.o.master.addSubcomponent(new ICAL.Component(JSON.parse(JSON.stringify(a.toJSON()))));
      continue;
    }
    if (k === 'overrides') {
      for (const v of t.o.overrides) t.cal.removeSubcomponent(v);
      for (const v of m.o.overrides) t.cal.addSubcomponent(new ICAL.Component(JSON.parse(JSON.stringify(v.toJSON()))));
      continue;
    }
    for (const n of FIELD_PROPS[k]) {
      t.o.master.removeAllProperties(n);
      for (const p of m.o.master.getAllProperties(n)) t.o.master.addProperty(new ICAL.Property(JSON.parse(JSON.stringify(p.toJSON())), t.o.master));
    }
  }
  const seq = Math.max(Number(t.o.master.getFirstPropertyValue('sequence')) || 0, Number(m.o.master.getFirstPropertyValue('sequence')) || 0);
  setProp(t.o.master, 'sequence', seq);
  ensureZones(t.cal);
  return t.cal.toString();
}

/** A calendar file of many events (a subscription) → [{ uid, text }]: one calendar object per UID with its time zones. */
function split(text) {
  const p = parse(text);
  const zones = p.comp.getAllSubcomponents('vtimezone');
  const out = [];
  for (const o of p.objects) {
    const cal = new ICAL.Component('vcalendar');
    cal.addPropertyWithValue('version', '2.0');
    cal.addPropertyWithValue('prodid', String(p.comp.getFirstPropertyValue('prodid') || PRODID));
    const comps = [o.master, ...o.overrides].filter(Boolean);
    const ids = new Set();
    for (const c of comps) for (const prop of c.getAllProperties()) { const id = prop.getParameter && prop.getParameter('tzid'); if (id) ids.add(String(id)); }
    for (const z of zones) if (ids.has(String(z.getFirstPropertyValue('tzid')))) cal.addSubcomponent(new ICAL.Component(JSON.parse(JSON.stringify(z.toJSON()))));
    for (const c of comps) {
      // a subscription's own UID-less events get the one parse() made
      if (!c.getFirstPropertyValue('uid')) c.addPropertyWithValue('uid', o.uid);
      cal.addSubcomponent(new ICAL.Component(JSON.parse(JSON.stringify(c.toJSON()))));
    }
    out.push({ uid: o.uid, text: cal.toString() });
  }
  return out;
}

/** A short summary of a recurrence for invitation cards → { de, en } (null when not recurring). */
function ruleSummary(rrule) {
  if (!rrule) return null;
  let r;
  try { r = ICAL.Recur.fromString(rrule); } catch { return null; }
  const n = Number(r.interval) || 1;
  const de = { DAILY: n > 1 ? `Alle ${n} Tage` : 'Täglich', WEEKLY: n > 1 ? `Alle ${n} Wochen` : 'Wöchentlich', MONTHLY: n > 1 ? `Alle ${n} Monate` : 'Monatlich', YEARLY: n > 1 ? `Alle ${n} Jahre` : 'Jährlich' };
  const en = { DAILY: n > 1 ? `Every ${n} days` : 'Daily', WEEKLY: n > 1 ? `Every ${n} weeks` : 'Weekly', MONTHLY: n > 1 ? `Every ${n} months` : 'Monthly', YEARLY: n > 1 ? `Every ${n} years` : 'Yearly' };
  const f = String(r.freq);
  const days = r.parts && r.parts.BYDAY ? (Array.isArray(r.parts.BYDAY) ? r.parts.BYDAY : [r.parts.BYDAY]) : [];
  const DE = { MO: 'Mo', TU: 'Di', WE: 'Mi', TH: 'Do', FR: 'Fr', SA: 'Sa', SU: 'So' };
  const EN = { MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun' };
  const dd = (map) => days.map((d) => { const m = /^([+-]?\d+)?(\w\w)$/.exec(String(d)); return m ? `${m[1] ? m[1] + '. ' : ''}${map[m[2]] || m[2]}` : String(d); }).join(', ');
  const until = r.until ? ` bis ${dateOf(r.until)}` : r.count ? `, ${r.count}×` : '';
  const untilEn = r.until ? ` until ${dateOf(r.until)}` : r.count ? `, ${r.count} times` : '';
  return { de: `${de[f] || f}${days.length ? ' (' + dd(DE) + ')' : ''}${until}`, en: `${en[f] || f}${days.length ? ' (' + dd(EN) + ')' : ''}${untilEn}` };
}

module.exports = {
  ICAL, root, parse, fieldsOf, expand, recurrenceOf, exdates, timeOf, occKey, ruleOf, build, change, exclude, partstat, itip, objectOf, merge,
  ensureZones, ruleSummary, split, mailto, zoneOf, PARTSTAT_OUT, DESC_MAX,
};
