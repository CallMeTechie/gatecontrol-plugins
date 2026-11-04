'use strict';

// Resources (since 1.9.0, mockups Ressource, AdminRessourcen, Planer, Anfragen): rooms, vehicles, devices and other
// things the administrator keeps on the plugin's page in GateControl (Einstellungen › Plugins › Mail › Ressourcen —
// admin API admin/resources), and people book in their calendars — „Ressource buchen“ or as an attendee of an own
// event in a GateControl calendar (the resource's address resource-<id>@resources.gatecontrol.invalid, role
// 'resource'). Each resource has its own calendar on the server: its bookings (table bookings).
//
//   who may book   bookers { all, principals: [{ type: 'user'|'group', id }] } — anyone else does not see it
//   the answer     approval 'auto' (confirmed when free and within the rules) or 'approval': a request to the approvers
//                  (people and groups) — a push (topic resource_request; GateControl ≥ 1.225.0 mails it too); the first
//                  decision settles it for all (already_decided for the others); the booker gets the answer in their
//                  calendar (the resource's PARTSTAT in the event) and as a push (resource_booking)
//   the rules      maxMinutes, horizonDays, hours { days: [1…7], from, to } in the resource's zone — checked here, on the
//                  server: auto → 409 rule_violation; approval → the request names them, an approver may confirm it
//                  anyway (override, logged in resource_log). A confirmed booking in the way: 409 resource_busy, always.
//
// Live events `resources`: { kind: 'request', bookingId, resourceId, state } to the approvers, { kind: 'booking',
// bookingId, resourceId, state } to the booker, { kind: 'resources' } when the administrator changed the list.

const store = require('./store');
const config = require('./config');
const tz = require('./tz');
const ics = require('./ics');
const pimstore = require('./pimstore');
const push = require('./push');
const { t } = require('./text');
const { fail, line, clip, parse, posInt, COLOR_RE, DAY } = require('./util');

const KINDS = ['room', 'vehicle', 'device', 'other'];
const COLORS = { room: '#B79CFF', vehicle: '#79B8FF', device: '#F5B544', other: '#8C96A5' };
const DOMAIN = 'resources.gatecontrol.invalid';
const ADDRESS_RE = /^resource-(\d{1,12})@resources\.gatecontrol\.invalid$/;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const RESOURCES_MAX = 200;
const RANGE_MAX = 31 * DAY;
const ACTIVE = "('pending', 'confirmed')";

/** The address of resource `id` as an attendee. */
const addressOf = (id) => `resource-${id}@${DOMAIN}`;
/** The resource id of an attendee's address, or null. */
function idOf(email) {
  const m = ADDRESS_RE.exec(String(email || '').toLowerCase());
  return m ? Number(m[1]) : null;
}
const isAddress = (email) => idOf(email) != null;

// ─── rows and checks ────────────────────────────

function rowOf(r) {
  if (!r) return null;
  return {
    ...r, bookers: parse(r.bookers_json, { all: true, principals: [] }), approvers: parse(r.approvers_json, []), hours: parse(r.hours_json, null),
  };
}

async function get(gc, id) {
  return rowOf(Number.isSafeInteger(id) ? await store.one(gc, 'SELECT * FROM resources WHERE id = ?', [id]) : null);
}

async function allRows(gc, onlyActive) {
  return (await store.all(gc, `SELECT * FROM resources${onlyActive ? ' WHERE active = 1' : ''} ORDER BY name COLLATE NOCASE, id`)).map(rowOf);
}

const rulesOf = (r) => ({ maxMinutes: r.max_minutes == null ? null : r.max_minutes, horizonDays: r.horizon_days == null ? null : r.horizon_days, hours: r.hours || null });

/** May person `userId` book resource `r`? */
async function mayBook(gc, r, userId) {
  if (!r || r.active !== 1) return false;
  if (r.bookers.all) return true;
  return config.inPrincipals(gc, r.bookers.principals, userId);
}

/** May person `userId` decide on the requests of resource `r`? */
async function mayDecide(gc, r, userId) {
  if (!r || r.approval !== 'approval') return false;
  return config.inPrincipals(gc, r.approvers, userId);
}

/** The person ids behind principals (groups with their subgroups, enabled members), at most 200. */
async function peopleOf(gc, principals) {
  const out = new Set();
  for (const p of principals || []) {
    if (p.type === 'user') out.add(p.id);
    else if (p.type === 'group' && gc.groups && typeof gc.groups.members === 'function') {
      try { for (const m of await gc.groups.members(p.id, { nested: true })) if (m.enabled !== false) out.add(m.userId); } catch { /* a group that went */ }
    }
    if (out.size >= 200) break;
  }
  return [...out];
}

function hoursArg(v, bad) {
  if (v === null) return null;
  if (!v || typeof v !== 'object' || !Array.isArray(v.days)) bad('rules.hours');
  const days = [...new Set(v.days)];
  if (!days.length || !days.every((d) => Number.isInteger(d) && d >= 1 && d <= 7)) bad('rules.hours');
  const to = v.to === '24:00' ? '24:00' : v.to;
  if (!HHMM_RE.test(v.from) || !(HHMM_RE.test(to) || to === '24:00') || v.from >= to) bad('rules.hours');
  return { days: days.sort((a, b) => a - b), from: v.from, to };
}

/** The checked fields of POST / PUT admin/resources (`cur`: the row on a change). */
function checkInput(b, cur) {
  const bad = (field) => { throw fail('invalid', { field }); };
  const has = (k) => b[k] !== undefined;
  const x = {};
  if (!cur || has('name')) {
    const s = clip(line(typeof b.name === 'string' ? b.name : ''), 80);
    if (!s) bad('name');
    x.name = s;
  }
  if (!cur || has('kind')) { const k = b.kind === undefined ? 'room' : b.kind; if (!KINDS.includes(k)) bad('kind'); x.kind = k; }
  for (const [k, max] of [['location', 120], ['equipment', 300]]) {
    if (!has(k)) continue;
    if (b[k] !== null && typeof b[k] !== 'string') bad(k);
    x[k] = b[k] ? clip(line(b[k]), max) || null : null;
  }
  if (has('seats')) { if (!(b.seats === null || (Number.isInteger(b.seats) && b.seats >= 0 && b.seats <= 10000))) bad('seats'); x.seats = b.seats; }
  if (has('color')) { if (!(b.color === null || (typeof b.color === 'string' && COLOR_RE.test(b.color)))) bad('color'); x.color = b.color ? b.color.toUpperCase() : null; }
  if (has('bookers')) {
    const v = b.bookers;
    if (!v || typeof v !== 'object' || typeof v.all !== 'boolean' || (v.principals != null && !Array.isArray(v.principals))) bad('bookers');
    x.bookers = { all: v.all, principals: config.principalsOf(v.principals) };
  }
  if (has('approval')) { if (b.approval !== 'auto' && b.approval !== 'approval') bad('approval'); x.approval = b.approval; }
  if (has('approvers')) { if (!Array.isArray(b.approvers)) bad('approvers'); x.approvers = config.principalsOf(b.approvers); }
  if (has('rules')) {
    const r = b.rules;
    if (!r || typeof r !== 'object') bad('rules');
    if (r.maxMinutes !== undefined) { if (!(r.maxMinutes === null || (Number.isInteger(r.maxMinutes) && r.maxMinutes >= 15 && r.maxMinutes <= 525600))) bad('rules.maxMinutes'); x.maxMinutes = r.maxMinutes; }
    if (r.horizonDays !== undefined) { if (!(r.horizonDays === null || (Number.isInteger(r.horizonDays) && r.horizonDays >= 1 && r.horizonDays <= 730))) bad('rules.horizonDays'); x.horizonDays = r.horizonDays; }
    if (r.hours !== undefined) x.hours = hoursArg(r.hours, bad);
  }
  if (has('timeZone')) { if (typeof b.timeZone !== 'string' || !tz.valid(b.timeZone) || b.timeZone.length > 64) bad('timeZone'); x.timeZone = b.timeZone; }
  if (has('active')) { if (typeof b.active !== 'boolean') bad('active'); x.active = b.active; }
  const approval = x.approval || (cur && cur.approval) || 'auto';
  const approvers = x.approvers || (cur && cur.approvers) || [];
  if (approval === 'approval' && !approvers.length) bad('approvers');
  return x;
}

// ─── views ──────────────────────────────────────

/** What the administrator sees of resource `r`. */
function adminView(r, counts) {
  return {
    id: r.id, name: r.name, kind: r.kind, location: r.location || null, seats: r.seats == null ? null : r.seats, equipment: r.equipment || null, color: r.color,
    bookers: r.bookers, approval: r.approval, approvers: r.approval === 'approval' ? r.approvers : [], rules: rulesOf(r), timeZone: r.time_zone, active: r.active === 1,
    address: addressOf(r.id), counts: counts || { upcoming: 0, pending: 0 }, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/** What a person who may book it sees of resource `r`. */
function clientView(r) {
  const approvers = r.approval === 'approval' ? r.approvers.map((p) => p.label || '').filter(Boolean) : [];
  return {
    id: r.id, name: r.name, kind: r.kind, location: r.location || null, seats: r.seats == null ? null : r.seats, equipment: r.equipment || null, color: r.color,
    approval: r.approval, approvers, rules: rulesOf(r), timeZone: r.time_zone, address: addressOf(r.id),
  };
}

const nameCache = () => {
  const m = new Map();
  return async (gc, id) => {
    if (id == null) return '';
    if (!m.has(id)) { let n = ''; try { const u = await gc.users.get(id); n = (u && u.name) || ''; } catch { n = ''; } m.set(id, n); }
    return m.get(id);
  };
};

/** The blocks of resource `id` in [from, to): confirmed → busy, pending → pending (without booking `except`). */
async function blocks(gc, id, from, to, except) {
  const rows = await store.all(gc, `SELECT id, start, end, state, user_id FROM bookings WHERE resource_id = ? AND state IN ${ACTIVE} AND start < ? AND end > ? ORDER BY start`, [id, to, from]);
  return rows.filter((b) => b.id !== except).map((b) => ({ start: b.start, end: b.end, status: b.state === 'confirmed' ? 'busy' : 'pending', bookingId: b.id, userId: b.user_id }));
}

/** Confirmed bookings of resource `id` overlapping [start, end) (without booking `except`) → [{ start, end }]. */
async function conflictsOf(gc, id, start, end, except) {
  const rows = await store.all(gc, "SELECT id, start, end FROM bookings WHERE resource_id = ? AND state = 'confirmed' AND start < ? AND end > ?", [id, end, start]);
  return rows.filter((b) => b.id !== except).map((b) => ({ start: b.start, end: b.end }));
}

/** The rules booking [start, end) of resource `r` breaks → [{ rule, … }]. */
function violationsOf(r, start, end, allDay, now = Date.now()) {
  const out = [];
  if (r.max_minutes != null && (end - start) / 60000 > r.max_minutes) out.push({ rule: 'max_duration', limit: r.max_minutes });
  if (r.horizon_days != null && start > now + r.horizon_days * DAY) out.push({ rule: 'horizon', limit: r.horizon_days });
  const h = r.hours;
  if (h) {
    const zone = r.time_zone || 'Europe/Berlin';
    const a = tz.parts(start, zone);
    const day = tz.dateStr(a.y, a.m, a.d);
    const wd = ((tz.weekday(day) + 6) % 7) + 1; // 1 = Monday
    const fromMs = tz.at(day, tz.parseTime(h.from), zone);
    const toMs = h.to === '24:00' ? tz.at(tz.addDays(day, 1), { hh: 0, mm: 0 }, zone) : tz.at(day, tz.parseTime(h.to), zone);
    if (allDay || !h.days.includes(wd) || start < fromMs || end > toMs) out.push({ rule: 'hours', days: h.days, from: h.from, to: h.to });
  }
  return out;
}

/** A booking row → the Booking of the API for person `userId`. */
async function bookingView(gc, b, userId, o = {}) {
  const r = o.resource || await get(gc, b.resource_id);
  const name = o.names || nameCache();
  const zone = (r && r.time_zone) || 'Europe/Berlin';
  const allDay = b.all_day === 1;
  const userZone = o.zone || await pimstore.zoneOf(gc, b.user_id);
  const day = tz.localDate(b.start, zone);
  const dayFrom = tz.at(day, { hh: 0, mm: 0 }, zone);
  const dayTo = Math.max(tz.at(tz.addDays(day, 1), { hh: 0, mm: 0 }, zone), b.end);
  const canDecide = o.canDecide != null ? o.canDecide : (b.state === 'pending' && !!r && await mayDecide(gc, r, userId));
  return {
    id: b.id, resourceId: b.resource_id, resource: r ? { id: r.id, name: r.name, kind: r.kind, color: r.color, location: r.location || null } : null,
    title: b.title, start: b.start, end: b.end, allDay,
    ...(allDay ? { startDate: tz.localDate(b.start, userZone), endDate: tz.localDate(Math.max(b.start, b.end - 1), userZone) } : {}),
    state: b.state, booker: { userId: b.user_id, name: await name(gc, b.user_id) }, eventId: b.user_id === userId ? b.event_id || null : null, note: b.note || null,
    violations: parse(b.violations_json, []), conflicts: b.state === 'pending' ? await conflictsOf(gc, b.resource_id, b.start, b.end, b.id) : [],
    decidedBy: b.decided_by ? { userId: b.decided_by, name: await name(gc, b.decided_by) } : null, decidedAt: b.decided_at || null, override: b.override === 1,
    comment: b.comment || null, createdAt: b.created_at, updatedAt: b.updated_at, canDecide,
    day: (await blocks(gc, b.resource_id, dayFrom, dayTo, b.id)).map((x) => ({ start: x.start, end: x.end, status: x.status })),
  };
}

async function log(gc, resourceId, bookingId, userId, action, detail) {
  await store.run(gc, 'INSERT INTO resource_log (resource_id, booking_id, user_id, action, detail_json, at) VALUES (?, ?, ?, ?, ?, ?)',
    [resourceId, bookingId || null, userId || null, action, detail ? JSON.stringify(detail) : null, Date.now()]);
}

async function live(gc, users, data) {
  const list = [...new Set(users)].filter((u) => Number.isSafeInteger(u) && u > 0);
  for (const part of store.chunks(list, 500)) {
    if (!part.length) continue;
    try { await gc.events.emit({ users: part, type: 'resources', data }); } catch { /* nobody listening */ }
  }
}

// ─── the administrator ──────────────────────────

async function countsOf(gc, id) {
  const now = Date.now();
  const u = await store.one(gc, "SELECT COUNT(*) AS n FROM bookings WHERE resource_id = ? AND state = 'confirmed' AND end > ?", [id, now]);
  const p = await store.one(gc, "SELECT COUNT(*) AS n FROM bookings WHERE resource_id = ? AND state = 'pending' AND end > ?", [id, now]);
  return { upcoming: u.n, pending: p.n };
}

/** Everybody who uses calendars (the live event of a changed list). */
async function calendarPeople(gc) {
  return (await store.all(gc, 'SELECT user_id FROM cal_prefs')).map((r) => r.user_id);
}

/**
 * The admin API: GET admin/resources → { items: [AdminResource], kinds } · POST admin/resources → { resource } · PUT
 * admin/resources/<id> → { resource } · DELETE admin/resources/<id> → { ok, cancelled } · GET admin/resources/<id>/log →
 * { items: [{ at, action, user, bookingId, detail }] }.
 */
async function adminRoute(gc, req, seg) {
  const m = req.method;
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const actor = req.user && req.user.id;
  if (seg.length === 2 && m === 'GET') {
    const items = [];
    for (const r of await allRows(gc, false)) items.push(adminView(r, await countsOf(gc, r.id)));
    return { items, kinds: KINDS };
  }
  if (seg.length === 2 && m === 'POST') {
    const n = await store.one(gc, 'SELECT COUNT(*) AS n FROM resources');
    if (n.n >= RESOURCES_MAX) throw fail('limit', { max: RESOURCES_MAX });
    const x = checkInput(b, null);
    const now = Date.now();
    const kind = x.kind || 'room';
    const r = await store.run(gc, `INSERT INTO resources (name, kind, location, seats, equipment, color, bookers_json, approval, approvers_json, max_minutes, horizon_days, hours_json,
      time_zone, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [x.name, kind, x.location || null, x.seats == null ? null : x.seats, x.equipment || null, x.color || COLORS[kind], JSON.stringify(x.bookers || { all: true, principals: [] }),
      x.approval || 'auto', JSON.stringify(x.approval === 'approval' ? x.approvers || [] : []), x.maxMinutes == null ? null : x.maxMinutes,
      x.horizonDays == null ? null : x.horizonDays, x.hours ? JSON.stringify(x.hours) : null, x.timeZone || 'Europe/Berlin', x.active === false ? 0 : 1, now, now]);
    const id = Number(r.lastInsertRowid);
    await log(gc, id, null, actor, 'created', { name: x.name });
    gc.log.info('resource created', id);
    await live(gc, await calendarPeople(gc), { kind: 'resources' });
    return { resource: adminView(await get(gc, id), await countsOf(gc, id)) };
  }
  const id = posInt(seg[2]);
  const cur = id ? await get(gc, id) : null;
  if (!cur) throw fail('not_found');
  if (seg.length === 3 && m === 'PUT') {
    const x = checkInput(b, cur);
    const sets = [];
    const args = [];
    const set = (col, v) => { sets.push(`${col} = ?`); args.push(v); };
    if (x.name !== undefined) set('name', x.name);
    if (x.kind !== undefined) set('kind', x.kind);
    for (const k of ['location', 'equipment', 'seats']) if (x[k] !== undefined) set(k, x[k]);
    if (x.color !== undefined) set('color', x.color || COLORS[x.kind || cur.kind]);
    if (x.bookers !== undefined) set('bookers_json', JSON.stringify(x.bookers));
    if (x.approval !== undefined) set('approval', x.approval);
    if (x.approvers !== undefined || x.approval !== undefined) set('approvers_json', JSON.stringify((x.approval || cur.approval) === 'approval' ? (x.approvers || cur.approvers) : []));
    if (x.maxMinutes !== undefined) set('max_minutes', x.maxMinutes);
    if (x.horizonDays !== undefined) set('horizon_days', x.horizonDays);
    if (x.hours !== undefined) set('hours_json', x.hours ? JSON.stringify(x.hours) : null);
    if (x.timeZone !== undefined) set('time_zone', x.timeZone);
    if (x.active !== undefined) set('active', x.active ? 1 : 0);
    set('updated_at', Date.now());
    await store.run(gc, `UPDATE resources SET ${sets.join(', ')} WHERE id = ?`, [...args, id]);
    await log(gc, id, null, actor, 'changed', { fields: Object.keys(b).filter((k) => b[k] !== undefined).slice(0, 20) });
    // the approvers changed: who decides now hears of it (their list of requests)
    const after = await get(gc, id);
    if (x.approvers !== undefined || x.approval !== undefined) await live(gc, [...await peopleOf(gc, cur.approvers), ...await peopleOf(gc, after.approvers)], { kind: 'request', bookingId: null, resourceId: id, state: null });
    await live(gc, await calendarPeople(gc), { kind: 'resources' });
    return { resource: adminView(after, await countsOf(gc, id)) };
  }
  if (seg.length === 3 && m === 'DELETE') {
    // the bookings still to come are called off (their bookers hear of it); the log stays
    const open = await store.all(gc, `SELECT * FROM bookings WHERE resource_id = ? AND state IN ${ACTIVE} AND end > ?`, [id, Date.now()]);
    for (const bk of open) await settle(gc, cur, bk, 'cancelled', actor, { reason: 'resource_removed' });
    await store.run(gc, 'DELETE FROM bookings WHERE resource_id = ?', [id]);
    await store.run(gc, 'DELETE FROM resources WHERE id = ?', [id]);
    await log(gc, id, null, actor, 'removed', { name: cur.name, cancelled: open.length });
    gc.log.info('resource removed', id);
    await live(gc, await calendarPeople(gc), { kind: 'resources' });
    return { ok: true, cancelled: open.length };
  }
  if (seg.length === 4 && seg[3] === 'log' && m === 'GET') {
    const rows = await store.all(gc, 'SELECT * FROM resource_log WHERE resource_id = ? ORDER BY at DESC, id DESC LIMIT 100', [id]);
    const name = nameCache();
    const items = [];
    for (const x of rows) items.push({ at: x.at, action: x.action, user: x.user_id ? { userId: x.user_id, name: await name(gc, x.user_id) } : null, bookingId: x.booking_id || null, detail: parse(x.detail_json, null) });
    return { items };
  }
  throw fail('not_found');
}

// ─── booking with an event ──────────────────────

/** The times of an event's fields `x` (or of row `ev`) as ms; all-day dates at midnight in `zone`. */
function timesOf(x, ev, zone) {
  const has = (k) => x && Object.prototype.hasOwnProperty.call(x, k);
  if (has('allDay') || has('start') || has('startDate')) {
    if (x.allDay) return { start: pimstore.midnight(x.startDate, zone), end: pimstore.midnight(tz.addDays(x.endDate || x.startDate, 1), zone), allDay: true };
    return { start: x.start, end: x.end, allDay: false };
  }
  return { start: ev.start, end: ev.end, allDay: ev.all_day === 1 };
}

/**
 * Before an own event is written (events.js create / update): its resource attendees checked — rights, a GateControl
 * calendar, no series, free, the rules (auto: 409 rule_violation; approval: a request). The attendees of `x` get the
 * resource's name and role. → a plan for commit(), or null when the event has no resources (now or before).
 */
async function plan(gc, ctx, cal, x, ev) {
  const cfg = await config.get(gc);
  const before = ev ? parse(ev.attendees_json, []).filter((a) => isAddress(a.email)).map((a) => idOf(a.email)) : [];
  // the newest booking per resource of the event (also a declined or called off one: an unchanged time asks no one again)
  const existing = [];
  for (const b of ev ? await store.all(gc, 'SELECT * FROM bookings WHERE event_id = ? ORDER BY id DESC', [ev.id]) : []) if (!existing.some((x) => x.resource_id === b.resource_id)) existing.push(b);
  const isActive = (b) => b.state === 'pending' || b.state === 'confirmed';
  let ids;
  if (x.attendees) {
    ids = [];
    for (const a of x.attendees) {
      const rid = idOf(a.email);
      if (rid == null) continue;
      const r = await get(gc, rid);
      if (!r || r.active !== 1) {
        // a resource that went: stays as it was on the event, never booked again
        if (before.includes(rid)) continue;
        throw fail('not_found', { resourceId: rid });
      }
      a.role = 'resource';
      a.name = r.name;
      if (!ids.includes(rid)) ids.push(rid);
    }
    x.attendees = x.attendees.filter((a) => !isAddress(a.email) || ids.includes(idOf(a.email)) || before.includes(idOf(a.email)));
  } else ids = before.filter((rid, i) => before.indexOf(rid) === i);
  if (!ids.length && !existing.some(isActive)) return null;
  if (ids.length && !cfg.resources.enabled) throw fail('feature_off', { feature: 'resources' });
  if (ids.length && cal.source !== 'local') throw fail('not_supported', { what: 'resource' });
  const rrule = Object.prototype.hasOwnProperty.call(x, 'rrule') ? x.rrule : (ev ? ev.rrule : null);
  if (ids.length && rrule) throw fail('not_supported', { what: 'resource_series' });
  const zone = await pimstore.zoneOf(gc, ctx.userId);
  const when = timesOf(x, ev, zone);
  const now = Date.now();
  const items = [];
  for (const rid of ids) {
    const r = await get(gc, rid);
    if (!r || r.active !== 1) continue;
    const last = existing.find((b) => b.resource_id === rid) || null;
    const same = !!last && last.start === when.start && last.end === when.end && (last.all_day === 1) === when.allDay;
    if (same && !isActive(last)) continue; // declined or called off: stays so until the time changes
    const have = last && isActive(last) ? last : null;
    const changed = !same;
    if (!changed) { items.push({ r, have, changed: false, ...when, state: have.state, violations: parse(have.violations_json, []) }); continue; }
    if (!(await mayBook(gc, r, ctx.userId))) throw fail('not_bookable', { resourceId: rid });
    if (when.end <= now) throw fail('invalid', { field: 'start', reason: 'past' });
    const conflicts = await conflictsOf(gc, rid, when.start, when.end, have ? have.id : null);
    if (conflicts.length) throw fail('resource_busy', { resourceId: rid, name: r.name, conflicts });
    const violations = violationsOf(r, when.start, when.end, when.allDay, now);
    if (r.approval === 'auto' && violations.length) throw fail('rule_violation', { resourceId: rid, name: r.name, violations });
    items.push({ r, have, changed: true, ...when, state: r.approval === 'auto' ? 'confirmed' : 'pending', violations });
  }
  const cancel = existing.filter((b) => isActive(b) && !ids.includes(b.resource_id));
  return { items, cancel };
}

/** Fill in plan `p` for the written event `ev` (its bookings, the requests, the resources' answers in the event). → [Booking] */
async function commit(gc, ctx, ev, p, o = {}) {
  if (!p) return [];
  const now = Date.now();
  const out = [];
  const names = nameCache();
  for (const it of p.items) {
    let id;
    if (it.have && !it.changed) {
      await store.run(gc, 'UPDATE bookings SET title = ?, updated_at = ? WHERE id = ?', [ev.title || '', now, it.have.id]);
      id = it.have.id;
    } else if (it.have) {
      await store.run(gc, `UPDATE bookings SET title = ?, start = ?, end = ?, all_day = ?, state = ?, violations_json = ?, decided_by = NULL, decided_at = NULL, override = 0, comment = NULL,
        updated_at = ? WHERE id = ?`, [ev.title || '', it.start, it.end, it.allDay ? 1 : 0, it.state, JSON.stringify(it.violations), now, it.have.id]);
      id = it.have.id;
      await log(gc, it.r.id, id, ctx.userId, 'moved', { state: it.state, violations: it.violations });
    } else {
      const r = await store.run(gc, `INSERT INTO bookings (resource_id, user_id, event_id, title, start, end, all_day, state, violations_json, note, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [it.r.id, ev.user_id, ev.id, ev.title || '', it.start, it.end, it.allDay ? 1 : 0, it.state, JSON.stringify(it.violations),
        o.note ? clip(String(o.note), 500) : null, now, now]);
      id = Number(r.lastInsertRowid);
      await log(gc, it.r.id, id, ctx.userId, it.state === 'confirmed' ? 'confirmed' : 'requested', it.violations.length ? { violations: it.violations } : null);
    }
    const row = await store.one(gc, 'SELECT * FROM bookings WHERE id = ?', [id]);
    if (it.changed && it.state === 'pending') await request(gc, ctx, it.r, row);
    if (it.changed) await live(gc, [row.user_id], { kind: 'booking', bookingId: id, resourceId: it.r.id, state: row.state });
    out.push(await bookingView(gc, row, ctx.userId, { resource: it.r, names }));
  }
  for (const b of p.cancel) {
    const r = await get(gc, b.resource_id);
    await settle(gc, r, b, 'cancelled', ctx.userId, { quiet: true });
  }
  if (!o.noSync) await syncAnswers(gc, ev.id);
  return out;
}

/** Event `ev` goes (deleted by its person): its bookings are called off. */
async function cancelForEvent(gc, ctx, ev, o = {}) {
  const rows = await store.all(gc, `SELECT * FROM bookings WHERE event_id = ? AND state IN ${ACTIVE}`, [ev.id]);
  for (const b of rows) await settle(gc, await get(gc, b.resource_id), b, 'cancelled', ctx.userId, { quiet: true, noSync: !!o.noSync });
  return rows.length;
}

/** The resources' answers (PARTSTAT) in the booker's event `eventId`, like their bookings: confirmed → accepted, … */
async function syncAnswers(gc, eventId) {
  const ev = eventId ? await store.one(gc, 'SELECT * FROM events WHERE id = ?', [eventId]) : null;
  if (!ev || !ev.ics) return;
  const cal = await store.one(gc, 'SELECT * FROM calendars WHERE id = ?', [ev.calendar_id]);
  if (!cal || cal.source !== 'local') return;
  const rows = await store.all(gc, 'SELECT resource_id, state FROM bookings WHERE event_id = ? ORDER BY id', [ev.id]);
  const want = new Map();
  for (const b of rows) want.set(addressOf(b.resource_id), b.state === 'confirmed' ? 'accepted' : b.state === 'pending' ? 'needs_action' : 'declined');
  const atts = parse(ev.attendees_json, []);
  let text = ev.ics;
  let changed = false;
  for (const a of atts) {
    if (!want.has(a.email) || (a.response || 'needs_action') === want.get(a.email)) continue;
    text = ics.partstat(text, a.email, want.get(a.email), { ctx: { userTz: await pimstore.zoneOf(gc, ev.user_id) } });
    changed = true;
  }
  if (!changed) return;
  await pimstore.storeObject(gc, cal, text, { uid: ev.uid });
  await pimstore.touchCalendar(gc, cal);
}

// ─── requests and decisions ─────────────────────

function whenOf(b, zone) {
  return b.all_day === 1 ? { allDay: true, start: b.start, end: b.end, startDate: tz.localDate(b.start, zone), endDate: tz.localDate(Math.max(b.start, b.end - 1), zone) } : { allDay: false, start: b.start, end: b.end };
}

const RULE_KEYS = { max_duration: 'res.rule_max', horizon: 'res.rule_horizon', hours: 'res.rule_hours' };
function ruleText(lang, v) {
  if (v.rule === 'max_duration') return t(lang, RULE_KEYS.max_duration, { limit: v.limit >= 1440 && v.limit % 1440 === 0 ? t(lang, v.limit === 1440 ? 'res.day' : 'res.days', { n: v.limit / 1440 }) : v.limit % 60 === 0 ? t(lang, 'res.hours', { n: v.limit / 60 }) : t(lang, 'res.minutes', { n: v.limit }) });
  if (v.rule === 'horizon') return t(lang, RULE_KEYS.horizon, { n: v.limit });
  return t(lang, RULE_KEYS.hours, { from: v.from, to: v.to });
}

/**
 * A new or moved request of booking `b`: a push to everyone who may decide (not the booker; topic resource_request) and
 * the live event. GateControl ≥ 1.225.0 also mails it to them (notifyTopics[].email, its own SMTP server to each
 * person's account address) — the plugin never mails in the booker's name.
 */
async function request(gc, ctx, r, b) {
  const approvers = (await peopleOf(gc, r.approvers)).filter((u) => u !== b.user_id);
  await live(gc, approvers, { kind: 'request', bookingId: b.id, resourceId: r.id, state: 'pending' });
  if (!approvers.length) return { push: 0 };
  let bookerName = '';
  try { const u = await gc.users.get(b.user_id); bookerName = (u && u.name) || ''; } catch { bookerName = ''; }
  const invites = require('./invites');
  const viol = parse(b.violations_json, []);
  let pushed = 0;
  // one push per language
  const byLang = new Map();
  for (const u of approvers) { const l = await push.langOf(gc, u); if (!byLang.has(l)) byLang.set(l, []); byLang.get(l).push(u); }
  for (const [lang, users] of byLang) {
    const when = invites.whenText(lang, whenOf(b, r.time_zone), r.time_zone);
    const text = [t(lang, 'push.res_request', { name: bookerName || '?', title: b.title || '', when }),
      ...(viol.length ? [t(lang, 'push.res_rules', { list: viol.map((v) => ruleText(lang, v)).join(', ') })] : [])].join('\n');
    for (const part of store.chunks(users, 100)) {
      try {
        await gc.notify({
          topic: 'resource_request', users: part, collapseKey: `res:${b.id}`, title: clip(t(lang, 'push.res_request_title', { resource: r.name }), 120),
          body: clip(text, 300), data: { resources: { bookingId: b.id, resourceId: r.id } },
        });
        pushed += part.length;
      } catch (e) { gc.log.warn('booking request push failed', (e && (e.code || e.message)) || 'error'); }
    }
  }
  return { push: pushed };
}

/**
 * Booking `b` of resource `r` becomes `state` (confirmed | declined | cancelled) by `actor`: stored, the answer in the
 * booker's event, a push to the booker (o.quiet: not when they did it themselves), the live events to booker and approvers.
 */
async function settle(gc, r, b, state, actor, o = {}) {
  const now = Date.now();
  const decided = state !== 'cancelled';
  const res = await store.run(gc, `UPDATE bookings SET state = ?, decided_by = ?, decided_at = ?, override = ?, comment = ?, updated_at = ? WHERE id = ? AND state IN ${ACTIVE}`,
    [state, decided ? actor : (b.decided_by || null), decided ? now : (b.decided_at || null), o.override ? 1 : 0, o.comment ? clip(String(o.comment), 1000) : null, now, b.id]);
  if (!res || !res.changes) return false;
  await log(gc, b.resource_id, b.id, actor, o.override ? 'confirmed_override' : state === 'confirmed' ? 'approved' : state, {
    ...(o.override ? { violations: parse(b.violations_json, []) } : {}), ...(o.reason ? { reason: o.reason } : {}), ...(o.comment ? { comment: clip(String(o.comment), 200) } : {}) });
  if (o.override) gc.log.info('booking confirmed despite rules', b.id, actor);
  if (!o.noSync) { try { await syncAnswers(gc, b.event_id); } catch (e) { gc.log.warn('booking answer not written', (e && (e.code || e.message)) || 'error'); } }
  const approvers = r ? await peopleOf(gc, r.approvers) : [];
  await live(gc, [b.user_id], { kind: 'booking', bookingId: b.id, resourceId: b.resource_id, state });
  if (b.state === 'pending' || state !== 'cancelled') await live(gc, approvers, { kind: 'request', bookingId: b.id, resourceId: b.resource_id, state });
  if (!o.quiet && actor !== b.user_id) {
    const lang = await push.langOf(gc, b.user_id);
    const zone = (r && r.time_zone) || 'Europe/Berlin';
    const when = require('./invites').whenText(lang, whenOf(b, zone), zone);
    const key = state === 'confirmed' ? 'push.res_confirmed_title' : state === 'declined' ? 'push.res_declined_title' : 'push.res_cancelled_title';
    try {
      await gc.notify({
        topic: 'resource_booking', users: [b.user_id], collapseKey: `res:${b.id}`, title: clip(t(lang, key, { resource: (r && r.name) || '' }), 120),
        body: clip(t(lang, 'push.res_decided', { title: b.title || '', when }) + (o.comment ? ` – „${clip(String(o.comment), 120)}“` : ''), 300),
        data: { resources: { bookingId: b.id, resourceId: b.resource_id }, ...(b.event_id ? { calendar: { eventId: b.event_id, occurrence: null } } : {}) },
      });
    } catch (e) { gc.log.warn('booking answer push failed', (e && (e.code || e.message)) || 'error'); }
  }
  return true;
}

// ─── the API of the apps and the portal ─────────

const numArg = (v, field) => {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^-?\d{1,15}$/.test(v) ? Number(v) : NaN);
  if (!Number.isSafeInteger(n)) throw fail('invalid', { field });
  return n;
};

/** GET resources?from=&to=&kind= → { items: [Resource + busy?], kinds } — the resources the person may book. */
async function list(gc, ctx, q) {
  let range = null;
  if (q.from != null || q.to != null) {
    const from = numArg(q.from, 'from');
    const to = numArg(q.to, 'to');
    if (to <= from || to - from > RANGE_MAX) throw fail('invalid', { field: 'to' });
    range = { from, to };
  }
  const kind = KINDS.includes(q.kind) ? q.kind : null;
  const items = [];
  for (const r of await allRows(gc, true)) {
    if (kind && r.kind !== kind) continue;
    if (!(await mayBook(gc, r, ctx.userId))) continue;
    const v = clientView(r);
    if (range) v.busy = (await blocks(gc, r.id, range.from, range.to)).map((x) => ({ start: x.start, end: x.end, status: x.status, mine: x.userId === ctx.userId }));
    items.push(v);
  }
  return { items, kinds: KINDS };
}

/**
 * POST resources/<id>/book { title, allDay?, start?, end?, startDate?, endDate?, timeZone?, calendarId?, note? } →
 * { event, sent, bookings } — „Ressource buchen“: an own event in a GateControl calendar with the resource as its attendee.
 */
async function book(gc, ctx, id, b) {
  const r = await get(gc, id);
  if (!r || r.active !== 1 || !(await mayBook(gc, r, ctx.userId))) throw fail('not_found');
  await pimstore.ensureSetup(gc, ctx.userId, ctx.lang);
  let calendarId = b.calendarId != null ? posInt(b.calendarId) : null;
  if (calendarId) {
    const c = await pimstore.ownCalendar(gc, ctx.userId, calendarId);
    if (c.source !== 'local') throw fail('not_supported', { what: 'resource' });
  } else {
    const def = await pimstore.defaultCalendar(gc, ctx.userId);
    const local = def && def.source === 'local' ? def : await store.one(gc, "SELECT * FROM calendars WHERE user_id = ? AND source = 'local' AND writable = 1 ORDER BY is_default DESC, sort, id LIMIT 1", [ctx.userId]);
    if (!local) throw fail('not_found');
    calendarId = local.id;
  }
  const body = {
    calendarId, title: typeof b.title === 'string' && b.title.trim() ? b.title : r.name, allDay: b.allDay === true,
    ...(b.allDay === true ? { startDate: b.startDate, endDate: b.endDate } : { start: b.start, end: b.end }), ...(b.timeZone ? { timeZone: b.timeZone } : {}),
    location: [r.name, r.location].filter(Boolean).join(', ').slice(0, 500), attendees: [{ email: addressOf(r.id), name: r.name, role: 'resource' }],
    ...(typeof b.note === 'string' && b.note.trim() ? { description: b.note.slice(0, 4000) } : {}), reminders: [],
  };
  return require('./events').create(gc, ctx, body, { note: b.note });
}

/** The resources of which person `userId` decides the requests. */
async function decidingOf(gc, userId) {
  const out = [];
  for (const r of await allRows(gc, false)) if (await mayDecide(gc, r, userId)) out.push(r);
  return out;
}

/** Is person `userId` an approver of any resource (GET me: feature bookingRequests)? */
async function isApprover(gc, userId) {
  for (const r of await allRows(gc, true)) if (await mayDecide(gc, r, userId)) return true;
  return false;
}

/**
 * GET bookings?state=open|done|mine → { items: [Booking], counts: { open } } — open: the requests the person decides on;
 * done: those decided or called off in the last 60 days; mine: the person's own bookings (from 7 days ago).
 */
async function bookings(gc, ctx, q) {
  const state = q.state === 'done' || q.state === 'mine' ? q.state : 'open';
  const now = Date.now();
  const names = nameCache();
  const mine = await decidingOf(gc, ctx.userId);
  const ids = mine.map((r) => r.id);
  const byId = new Map(mine.map((r) => [r.id, r]));
  let rows = [];
  if (state === 'mine') rows = await store.all(gc, 'SELECT * FROM bookings WHERE user_id = ? AND end > ? ORDER BY start LIMIT 200', [ctx.userId, now - 7 * DAY]);
  else if (ids.length) {
    for (const part of store.chunks(ids, 80)) {
      rows.push(...(state === 'open'
        ? await store.all(gc, `SELECT * FROM bookings WHERE resource_id IN (${store.marks(part.length)}) AND state = 'pending' AND end > ? ORDER BY start LIMIT 200`, [...part, now])
        : await store.all(gc, `SELECT * FROM bookings WHERE resource_id IN (${store.marks(part.length)}) AND state <> 'pending' AND updated_at > ? ORDER BY updated_at DESC LIMIT 200`, [...part, now - 60 * DAY])));
    }
  }
  const items = [];
  for (const b of rows) items.push(await bookingView(gc, b, ctx.userId, { resource: byId.get(b.resource_id), names, canDecide: state === 'open' ? true : (state === 'mine' ? undefined : false) }));
  let open = 0;
  for (const part of store.chunks(ids, 80)) {
    if (!part.length) continue;
    open += (await store.one(gc, `SELECT COUNT(*) AS n FROM bookings WHERE resource_id IN (${store.marks(part.length)}) AND state = 'pending' AND end > ?`, [...part, now])).n;
  }
  return { items, counts: { open } };
}

/** GET bookings/<id> → Booking (the booker and who decides on it). */
async function getBooking(gc, ctx, id) {
  const b = Number.isSafeInteger(id) ? await store.one(gc, 'SELECT * FROM bookings WHERE id = ?', [id]) : null;
  if (!b) throw fail('not_found');
  const r = await get(gc, b.resource_id);
  if (b.user_id !== ctx.userId && !(r && await mayDecide(gc, r, ctx.userId))) throw fail('not_found');
  return bookingView(gc, b, ctx.userId, { resource: r });
}

/**
 * POST bookings/<id>/decide { decision: 'approve'|'decline', comment?, override? } → { booking } — the first decision
 * settles it (409 already_decided { state, decidedBy, decidedAt } for the later ones); approving with a confirmed booking
 * in the way → 409 resource_busy, with broken rules → 409 rule_violation unless `override` (logged).
 */
async function decide(gc, ctx, id, b) {
  const bk = Number.isSafeInteger(id) ? await store.one(gc, 'SELECT * FROM bookings WHERE id = ?', [id]) : null;
  if (!bk) throw fail('not_found');
  const r = await get(gc, bk.resource_id);
  if (!r || !(await mayDecide(gc, r, ctx.userId))) throw fail(bk.user_id === ctx.userId ? 'forbidden' : 'not_found');
  if (b.decision !== 'approve' && b.decision !== 'decline') throw fail('invalid', { field: 'decision' });
  if (b.override !== undefined && typeof b.override !== 'boolean') throw fail('invalid', { field: 'override' });
  const decided = async (row) => {
    let name = '';
    try { const u = await gc.users.get(row.decided_by); name = (u && u.name) || ''; } catch { name = ''; }
    return fail('already_decided', { state: row.state, decidedBy: row.decided_by ? { userId: row.decided_by, name } : null, decidedAt: row.decided_at || null });
  };
  if (bk.state !== 'pending') throw await decided(bk);
  let override = false;
  if (b.decision === 'approve') {
    const conflicts = await conflictsOf(gc, r.id, bk.start, bk.end, bk.id);
    if (conflicts.length) throw fail('resource_busy', { resourceId: r.id, name: r.name, conflicts });
    const violations = violationsOf(r, bk.start, bk.end, bk.all_day === 1, bk.created_at);
    if (violations.length && b.override !== true) throw fail('rule_violation', { resourceId: r.id, name: r.name, violations });
    override = violations.length > 0;
    if (override) await store.run(gc, 'UPDATE bookings SET violations_json = ? WHERE id = ?', [JSON.stringify(violations), bk.id]);
  }
  const ok = await settle(gc, r, { ...bk, violations_json: override ? JSON.stringify(violationsOf(r, bk.start, bk.end, bk.all_day === 1, bk.created_at)) : bk.violations_json },
    b.decision === 'approve' ? 'confirmed' : 'declined', ctx.userId, { override, comment: typeof b.comment === 'string' && b.comment.trim() ? b.comment.trim() : null });
  if (!ok) throw await decided(await store.one(gc, 'SELECT * FROM bookings WHERE id = ?', [bk.id]));
  return { booking: await bookingView(gc, await store.one(gc, 'SELECT * FROM bookings WHERE id = ?', [bk.id]), ctx.userId, { resource: r }) };
}

/** DELETE bookings/<id> → { ok } — the booker calls their booking off: the resource leaves their event. */
async function cancel(gc, ctx, id) {
  const bk = Number.isSafeInteger(id) ? await store.one(gc, 'SELECT * FROM bookings WHERE id = ? AND user_id = ?', [id, ctx.userId]) : null;
  if (!bk) throw fail('not_found');
  if (bk.state !== 'pending' && bk.state !== 'confirmed') return { ok: true };
  const ev = bk.event_id ? await store.one(gc, 'SELECT * FROM events WHERE id = ? AND user_id = ?', [bk.event_id, ctx.userId]) : null;
  if (ev) {
    const rest = parse(ev.attendees_json, []).filter((a) => a.email !== addressOf(bk.resource_id)).map((a) => ({ email: a.email, name: a.name || '', role: a.role || 'required' }));
    const organizer = parse(ev.organizer_json, null);
    await require('./events').update(gc, ctx, ev.id, { attendees: rest.filter((a) => !organizer || a.email !== organizer.email), scope: 'series', sendInvites: false });
  }
  const again = await store.one(gc, 'SELECT * FROM bookings WHERE id = ?', [bk.id]);
  if (again && (again.state === 'pending' || again.state === 'confirmed')) await settle(gc, await get(gc, bk.resource_id), again, 'cancelled', ctx.userId, { quiet: true });
  return { ok: true };
}

module.exports = {
  KINDS, addressOf, idOf, isAddress, get, allRows, mayBook, mayDecide, isApprover, peopleOf, blocks, conflictsOf, violationsOf, checkInput, adminView, clientView,
  adminRoute, plan, commit, cancelForEvent, syncAnswers, list, book, bookings, getBooking, decide, cancel, bookingView,
};
