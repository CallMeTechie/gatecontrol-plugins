'use strict';

// Services for the Messenger (1.8.0, plugin.json services.provides; GateControl ≥ 1.177.0
// gc.services). Only gatecontrol-messenger may call them (any other caller → forbidden) —
// except rule_event (1.12.0) and school_day_end (1.13.0), which only gatecontrol-schule may call;
// the host lets only plugins that list a service in permissions.services call it at all.
// Every answer is JSON ≤ 16 KB; a refusal is { ok: false, code } (never thrown):
//
//   list_add        { userId, list: 'shopping' | <listId>, items: [string] (1–50, each 1–120) }
//                   → { ok: true, listId, listName, added, skipped, itemIds }
//                   'shopping' = the first shopping list (created as „Einkaufsliste“ when there
//                   is none); an item already open on the list (same text, ignoring case) is
//                   skipped. userId: a family member (parent or child — no wall tablet), module
//                   shopping on. Codes: invalid, not_member, module_off, not_found.
//   calendar_add    { userId, title (1–80), startsAt, endsAt?, allDay?, place? }  → { ok: true, eventId }
//                   „Termin anlegen“ in a chat: an ordinary date of that person (origin 'chat',
//                   for the whole family). startsAt / endsAt: ISO-8601 with time, or a date
//                   YYYY-MM-DD (all-day); converted to the plugin's time zone. place: a label
//                   (string, or { label }) ≤ 80. Codes: invalid, not_member, module_off.
//   calendar_upsert { sourceRef, title, startsAt, endsAt?, allDay?, place?, userIds? } → { ok: true, eventId, created }
//                   an event message of the family chat kept in step, idempotent by sourceRef
//                   ('<word>:<id>', e.g. 'messenger:123'); read-only in Familie, marked „aus dem
//                   Familien-Chat“. userIds: the date's members (non-members dropped; none = the
//                   whole family). Codes: invalid, module_off.
//   calendar_remove { sourceRef } → { ok: true, removed: true | false }   idempotent
//   places          { userId } → [{ id, name, lat, lon, radiusM }]
//                   the family's places for that member: 'home' („Zuhause“, the settings lat / lon,
//                   150 m) and, with the module presence on, the rule places ('place:<id>').
//                   Not a member (or a wall tablet) → [].
//   family_roles    {} → { ok: true, parents: [userId], children: [userId] }   (1.9.0) who the parents and
//                   the children of the family are (never a wall tablet) — the Messenger's door requests
//                   („Eltern fragen“).
//   rule_event      { type: 'school_change', events: [{ userId, kind, date, start, subject, text }] (≤ 20) }
//                   → { ok: true, fired }   (1.12.0, caller gatecontrol-schule only) — a child's timetable
//                   changed: the matching rules with the trigger 'school_change' run (server/school.js).
//                   Codes: invalid, forbidden.
//   school_day_end  { events: [{ userId, date, plannedEnd, newEnd, text }] (≤ 20) } → { ok: true, notified, matched }
//                   (1.13.0, caller gatecontrol-schule only) — a child's school day ends earlier: the pickup
//                   around the planned end is looked for, its driver and the parents are asked
//                   (server/schoolend.js). Codes: invalid, forbidden.
//
// The other way round (server/messenger.js placeStatus): Familie tells the Messenger the
// place of a member (set_place_status) when presence or a place event changes it.

const crypto = require('node:crypto');
const store = require('./store');
const tz = require('./tz');
const members = require('./members');
const shopping = require('./shopping');
const dates = require('./dates');
const ruleplaces = require('./ruleplaces');
const school = require('./school');
const schoolend = require('./schoolend');
const presence = require('./presence');
const push = require('./push');
const texts = require('./texts.json');
const { line, posInt, validDate, parseIso } = require('./util');

const CALLER = 'gatecontrol-messenger';
const ITEMS_MAX = 50;
const ITEM_MAX = 120;
const NAME_MAX = 40;
const SOURCE_RE = /^[a-z][a-z0-9_-]{0,31}:[A-Za-z0-9:._-]{1,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HOME_RADIUS = 150;

const refuse = (code) => ({ ok: false, code });
const say = (lang, key) => (texts[lang === 'en' ? 'en' : 'de'] || {})[key] || texts.de[key] || key;

class Refusal extends Error { constructor(code) { super(code); this.code = code; } }
const no = (code) => new Refusal(code);

/** The member a service acts for: payload.userId (else the host's user) — a parent or child. */
function memberOf(fam, payload, user) {
  const id = posInt(payload.userId) || (user && posInt(user.id));
  if (!id) throw no('invalid');
  const m = fam.byId.get(id);
  if (!m) throw no('not_member');
  return m;
}

async function family(gc, cfg) {
  return members.load(gc, tz.localDate(Date.now(), cfg.tz));
}

// ─── list_add ───────────────────────────────────

async function listAdd(gc, cfg, payload, user) {
  const fam = await family(gc, cfg);
  const me = memberOf(fam, payload, user);
  if (!cfg.modules.shopping) throw no('module_off');
  const raw = Array.isArray(payload.items) ? payload.items : null;
  if (!raw || !raw.length || raw.length > ITEMS_MAX) throw no('invalid');
  const items = [];
  for (const x of raw) {
    const s = line(x);
    if (!s || s.length > ITEM_MAX) throw no('invalid');
    items.push(s);
  }
  const list = payload.list === undefined || payload.list === null ? 'shopping' : payload.list;
  if (typeof list !== 'string' || (list !== 'shopping' && !shopping.ID_RE.test(list))) throw no('invalid');
  const now = Date.now();
  return store.tx(gc, async () => {
    let l;
    if (list === 'shopping') {
      l = await store.one(gc, 'SELECT id, name FROM shop_lists WHERE deleted = 0 ORDER BY sort, created_at LIMIT 1');
      if (!l) {
        const id = crypto.randomUUID();
        const name = say(cfg.lang, 'services.shopping_list').slice(0, NAME_MAX);
        await shopping.applyOps(gc, { ops: [{ op: 'list_add', id, name }] }, { id: me.userId }, now);
        l = { id, name };
      }
    } else {
      l = await store.one(gc, 'SELECT id, name FROM shop_lists WHERE id = ? AND deleted = 0', [list]);
      if (!l) throw no('not_found');
    }
    const open = await store.all(gc, 'SELECT text FROM shop_items WHERE list_id = ? AND deleted = 0 AND checked = 0', [l.id]);
    const seen = new Set(open.map((x) => x.text.trim().toLowerCase()));
    const ops = [];
    let skipped = 0;
    for (const s of items) {
      const key = s.toLowerCase();
      if (seen.has(key)) { skipped++; continue; }
      seen.add(key);
      ops.push({ op: 'item_add', id: crypto.randomUUID(), listId: l.id, text: s });
    }
    if (ops.length) {
      const res = await shopping.applyOps(gc, { ops }, { id: me.userId }, now);
      if (res.rejected.length) throw no('invalid');
    }
    return { ok: true, listId: l.id, listName: l.name, added: ops.length, skipped, itemIds: ops.map((o) => o.id) };
  });
}

// ─── calendar ───────────────────────────────────

/** A place: a label string or { label } → the label (≤ 80) or null; anything else → invalid. */
function placeLabel(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' && !(typeof v === 'object' && !Array.isArray(v))) throw no('invalid');
  const raw = typeof v === 'string' ? v : v.label;
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') throw no('invalid');
  const s = line(raw);
  if (s == null || s.length > dates.PLACE_MAX) throw no('invalid');
  return s || null;
}

/** One point in time → { date, time } in the plugin's zone (a YYYY-MM-DD → { date, time: null }). */
function pointOf(v, zone) {
  if (typeof v !== 'string') throw no('invalid');
  if (DATE_RE.test(v)) {
    if (!validDate(v)) throw no('invalid');
    return { date: v, time: null, ms: null };
  }
  const ms = parseIso(v);
  if (ms == null) throw no('invalid');
  const p = tz.parts(ms, zone);
  return { date: tz.dateStr(p.y, p.m, p.d), time: `${tz.pad(p.hh)}:${tz.pad(p.mm)}`, ms };
}

/** startsAt / endsAt / allDay / title / place → the fields of an events row. */
function eventFields(payload, cfg) {
  const title = line(payload.title);
  if (!title || title.length > dates.TITLE_MAX) throw no('invalid');
  const start = pointOf(payload.startsAt, cfg.tz);
  if (payload.allDay !== undefined && typeof payload.allDay !== 'boolean') throw no('invalid');
  const allDay = payload.allDay === true || start.time == null;
  let endDate = null;
  let endTime = null;
  if (payload.endsAt !== undefined && payload.endsAt !== null && payload.endsAt !== '') {
    const end = pointOf(payload.endsAt, cfg.tz);
    if (end.date < start.date || (end.ms != null && start.ms != null && end.ms < start.ms)) throw no('invalid');
    if (tz.diffDays(start.date, end.date) > dates.MAX_SPAN_DAYS) throw no('invalid');
    endDate = end.date > start.date ? end.date : null;
    if (!allDay && end.time && (endDate || end.time > start.time)) endTime = end.time;
  }
  return { title, date: start.date, time: allDay ? null : start.time, allDay, endDate, endTime, place: placeLabel(payload.place) };
}

async function calendarAdd(gc, cfg, payload, user) {
  const fam = await family(gc, cfg);
  const me = memberOf(fam, payload, user);
  if (!cfg.modules.dates) throw no('module_off');
  const f = eventFields(payload, cfg);
  const now = Date.now();
  const res = await store.tx(gc, () => store.run(gc, `INSERT INTO events (title, date, time, end_date, all_day, repeat, member_ids_json, kind, remind_days, note,
    place, end_time, source, source_ref, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'none', '[]', 'event', NULL, '', ?, ?, 'chat', NULL, ?, ?, ?)`,
  [f.title, f.date, f.time, f.endDate, f.allDay ? 1 : 0, f.place, f.endTime, me.userId, now, now]));
  return { ok: true, eventId: Number(res.lastInsertRowid) };
}

function sourceRef(v) {
  if (typeof v !== 'string' || !SOURCE_RE.test(v)) throw no('invalid');
  return v;
}

async function calendarUpsert(gc, cfg, payload) {
  const ref = sourceRef(payload.sourceRef);
  if (!cfg.modules.dates) throw no('module_off');
  const f = eventFields(payload, cfg);
  const fam = await family(gc, cfg);
  let ids = [];
  if (payload.userIds !== undefined && payload.userIds !== null) {
    if (!Array.isArray(payload.userIds) || payload.userIds.length > 500) throw no('invalid');
    ids = [...new Set(payload.userIds.map(posInt).filter((id) => id && fam.byId.has(id)))].slice(0, 50);
  }
  const now = Date.now();
  return store.tx(gc, async () => {
    const row = await store.one(gc, 'SELECT id FROM events WHERE source_ref = ?', [ref]);
    const vals = [f.title, f.date, f.time, f.endDate, f.allDay ? 1 : 0, JSON.stringify(ids), f.place, f.endTime];
    if (row) {
      await store.run(gc, `UPDATE events SET title = ?, date = ?, time = ?, end_date = ?, all_day = ?, member_ids_json = ?, place = ?, end_time = ?,
        updated_at = ? WHERE id = ?`, [...vals, now, row.id]);
      return { ok: true, eventId: row.id, created: false };
    }
    const res = await store.run(gc, `INSERT INTO events (title, date, time, end_date, all_day, repeat, member_ids_json, kind, remind_days, note,
      place, end_time, source, source_ref, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'none', ?, 'event', NULL, '', ?, ?, 'chat', ?, NULL, ?, ?)`,
    [...vals, ref, now, now]);
    return { ok: true, eventId: Number(res.lastInsertRowid), created: true };
  });
}

async function calendarRemove(gc, payload) {
  const ref = sourceRef(payload.sourceRef);
  return store.tx(gc, async () => {
    const row = await store.one(gc, 'SELECT id FROM events WHERE source_ref = ?', [ref]);
    if (!row) return { ok: true, removed: false };
    await store.run(gc, 'DELETE FROM events WHERE id = ?', [row.id]);
    await store.run(gc, 'DELETE FROM event_reminders WHERE event_key = ?', [String(row.id)]);
    return { ok: true, removed: true };
  });
}

// ─── places ─────────────────────────────────────

async function places(gc, cfg, payload, user) {
  const fam = await family(gc, cfg);
  try { memberOf(fam, payload, user); } catch { return []; }
  const out = [];
  if (cfg.location) out.push({ id: 'home', name: say(cfg.lang, 'services.home'), lat: cfg.location.lat, lon: cfg.location.lon, radiusM: HOME_RADIUS });
  if (cfg.modules.presence) {
    for (const p of (await ruleplaces.all(gc)).values()) out.push({ id: `place:${p.id}`, name: p.name, lat: p.lat, lon: p.lon, radiusM: p.radius });
  }
  return out;
}

// ─── family_roles (1.9.0) ───────────────────────

async function familyRoles(gc, cfg) {
  const fam = await family(gc, cfg);
  return { ok: true, parents: members.parents(fam).map((m) => m.userId), children: members.children(fam).map((m) => m.userId) };
}

// ─── rule_event (1.12.0) ────────────────────────

/** The Schule plugin's events: the matching rules run (dedupe, conditions, actions), pushes sent → { ok, fired }. */
async function ruleEvent(gc, cfg, payload) {
  const events = school.parseEvents(payload);
  if (!events) throw no('invalid');
  if (!events.length || cfg.modules.rules === false) return { ok: true, fired: 0 };
  const now = Date.now();
  const fam = await family(gc, cfg);
  const runs = [];
  await store.tx(gc, () => school.fire(gc, fam, cfg, now, events, runs));
  if (runs.length) {
    const pushes = [];
    try { await presence.execute(gc, fam, cfg, now, runs, pushes); } catch (e) { gc.log.warn('school rule run failed', (e && (e.code || e.message)) || 'error'); }
    if (pushes.length) await push.flush(gc, pushes);
  }
  return { ok: true, fired: runs.length };
}

// ─── the hook ───────────────────────────────────

const HANDLERS = {
  list_add: listAdd,
  calendar_add: calendarAdd,
  calendar_upsert: (gc, cfg, payload) => calendarUpsert(gc, cfg, payload),
  calendar_remove: (gc, cfg, payload) => calendarRemove(gc, payload),
  places,
  family_roles: (gc, cfg) => familyRoles(gc, cfg),
  rule_event: (gc, cfg, payload) => ruleEvent(gc, cfg, payload),
  school_day_end: (gc, cfg, payload) => schoolend.handle(gc, cfg, payload, Date.now()),
};
/** Who may call a service: the Messenger, except rule_event and school_day_end (the Schule plugin). */
const CALLERS = { rule_event: school.SCHULE, school_day_end: school.SCHULE };
const NAMES = Object.freeze(Object.keys(HANDLERS));

/** service({ name, caller, user, payload }) → the answer (see the head of this file). */
async function handle(gc, cfg, call) {
  const c = call && typeof call === 'object' ? call : {};
  const fn = Object.prototype.hasOwnProperty.call(HANDLERS, c.name) ? HANDLERS[c.name] : null;
  if (!fn) return refuse('not_found');
  if (c.caller !== (CALLERS[c.name] || CALLER)) return c.name === 'places' ? [] : refuse('forbidden');
  const payload = c.payload && typeof c.payload === 'object' && !Array.isArray(c.payload) ? c.payload : {};
  try {
    return await fn(gc, cfg, payload, c.user || null);
  } catch (e) {
    if (e instanceof Refusal) return refuse(e.code);
    gc.log.warn('service failed', c.name, (e && (e.code || e.message)) || 'error');
    return refuse('failed');
  }
}

module.exports = { handle, NAMES, CALLER, HOME_RADIUS, eventFields, placeLabel };
