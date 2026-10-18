'use strict';

// 1.4.0 — events (message kind 'event', README "Events"). Title, place, description and the checklist
// texts are in the message's encrypted meta; the table events holds times and switches for the background
// run, event_rsvps the answers, event_checks who ticked a checklist item.
//   rsvp       { answer: yes | maybe | no | null, guests? } (when rsvp is on, not cancelled)
//   checklist  POST messages/:id/checklist/:itemId { done }
//   PATCH      messages/:id/event { …fields, cancelled } (the creator or a group admin)
//   reminders  `reminderMin` before the start a push to yes/maybe (everyone when rsvp is off);
//   departure  45 min before (departureHint) a push "Abfahrt? Ankunft teilen" with a deep link to arrival;
//   Familie    familyCalendar: calendar_upsert / calendar_remove { sourceRef: 'messenger:<msgId>' } after the commit.
// Changes → event event.update { conversationId, messageId, updatedAt }.

const store = require('./store');
const seal = require('./seal');
const live = require('./live');
const messages = require('./messages');
const { fail, posInt, text, optText, bool, numIn, intIn, iso, parseIso } = require('./util');

const TITLE_MAX = 120;
const DESC_MAX = 1000;
const CHECK_MAX = 20;
const CHECK_TEXT_MAX = 80;
const GUESTS_MAX = 20;
const REMINDER_MIN = [0, 15, 60, 120, 1440];
const DEPARTURE_MS = 45 * 60000;
const ANSWERS = ['yes', 'maybe', 'no'];

function cleanPlace(v) {
  if (v == null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw fail('invalid');
  const place = { label: text(v.label, TITLE_MAX) };
  if (v.familiePlaceId != null) {
    if (!(typeof v.familiePlaceId === 'string' || Number.isSafeInteger(v.familiePlaceId)) || String(v.familiePlaceId).length > 64) throw fail('invalid');
    place.familiePlaceId = v.familiePlaceId;
  }
  if (v.lat != null || v.lon != null) { place.lat = numIn(v.lat, -90, 90); place.lon = numIn(v.lon, -180, 180); }
  return place;
}

function cleanChecklist(v, old) {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > CHECK_MAX) throw fail('invalid');
  const out = [];
  let next = Math.max(0, ...(old || []).map((c) => Number(String(c.id).slice(1)) || 0)) + 1;
  for (const x of v) {
    const t = text(typeof x === 'object' && x ? x.text : x, CHECK_TEXT_MAX);
    // an item kept from before (same text) keeps its id and its tick
    const same = (old || []).find((c) => c.text === t && !out.some((o) => o.id === c.id));
    out.push(same ? { id: same.id, text: t } : { id: 'c' + (next++), text: t });
  }
  return out;
}

/** Check `event` of a send body → { meta (encrypted part), row (plain part) }. `defMin` the creator's default reminder. */
function clean(ctx, v, defMin) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw fail('invalid');
  const title = text(v.title, TITLE_MAX);
  const startsAt = parseIso(v.startsAt);
  if (startsAt == null) throw fail('invalid');
  let endsAt = null;
  if (v.endsAt != null) { endsAt = parseIso(v.endsAt); if (endsAt == null || endsAt < startsAt) throw fail('invalid'); }
  const description = v.description == null || v.description === '' ? null : messages.cleanText(v.description, false);
  if (description && description.length > DESC_MAX) throw fail('invalid');
  const flag = (k, d) => (v[k] == null ? d : bool(v[k]));
  let reminderMin = defMin;
  if (v.reminderMin != null) { if (!REMINDER_MIN.includes(v.reminderMin)) throw fail('invalid'); reminderMin = v.reminderMin; }
  return {
    meta: { title, place: cleanPlace(v.place), description, checklist: cleanChecklist(v.checklist, []) },
    row: { startsAt, endsAt, allDay: flag('allDay', false), rsvp: flag('rsvp', true), guests: flag('guests', false), reminderMin, familyCalendar: flag('familyCalendar', false), departureHint: flag('departureHint', false) },
  };
}

async function create(ctx, conv, msgId, e) {
  const r = e.row;
  await store.run(ctx.gc, `INSERT INTO events (msg_id, conv_id, creator_id, starts_at, ends_at, all_day, rsvp, guests, reminder_min, family_calendar, departure_hint, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [msgId, conv.id, ctx.viewer, r.startsAt, r.endsAt, r.allDay ? 1 : 0, r.rsvp ? 1 : 0, r.guests ? 1 : 0, r.reminderMin, r.familyCalendar ? 1 : 0, r.departureHint ? 1 : 0, ctx.now]);
  if (r.familyCalendar) queueCalendar(ctx, conv, msgId, e.meta, r, 'upsert');
}

/** After the commit: Familie's calendar (best effort, logged when refused). */
function queueCalendar(ctx, conv, msgId, meta, r, op) {
  const familie = require('./familie');
  const gc = ctx.gc;
  const now = ctx.now;
  const members = async () => (await store.all(gc, 'SELECT user_id FROM members WHERE conv_id = ? AND left_at IS NULL', [conv.id])).map((m) => m.user_id);
  ctx.box.after.push(async () => {
    if (op === 'remove') return familie.calendar(gc, 'calendar_remove', { sourceRef: `messenger:${msgId}` }, now);
    const allDay = !!r.allDay;
    const when = (ms) => (allDay ? familie.day(ms) : iso(ms));
    const payload = { sourceRef: `messenger:${msgId}`, title: String(meta.title || '').slice(0, 80), startsAt: when(r.startsAt), allDay, userIds: await members() };
    if (r.endsAt != null) payload.endsAt = when(r.endsAt);
    if (meta.place && meta.place.label) payload.place = meta.place.label;
    return familie.calendar(gc, 'calendar_upsert', payload, now);
  });
}

/** The event objects of these message rows → Map msgId → event (for the viewer). */
async function decorate(ctx, rows) {
  const out = new Map();
  for (const r of rows) {
    const def = (messages.metaOf(r) || {}).event;
    const row = await store.one(ctx.gc, 'SELECT * FROM events WHERE msg_id = ?', [r.id]);
    if (!def || !row) continue;
    const answers = await store.all(ctx.gc, 'SELECT user_id, answer, guests FROM event_rsvps WHERE msg_id = ? ORDER BY at, user_id', [r.id]);
    const checks = await store.all(ctx.gc, 'SELECT item_id, user_id, at FROM event_checks WHERE msg_id = ?', [r.id]);
    const list = (a) => answers.filter((x) => x.answer === a).map((x) => ({ userId: x.user_id, guests: x.guests }));
    const mine = answers.find((x) => x.user_id === ctx.viewer);
    out.set(r.id, {
      title: def.title, startsAt: iso(row.starts_at), endsAt: iso(row.ends_at), allDay: !!row.all_day, place: def.place || null, description: def.description || null,
      checklist: (def.checklist || []).map((c) => { const k = checks.find((x) => x.item_id === c.id); return { id: c.id, text: c.text, doneBy: k ? k.user_id : null, doneAt: k ? iso(k.at) : null }; }),
      rsvpEnabled: !!row.rsvp, guests: !!row.guests,
      rsvp: { yes: list('yes'), maybe: list('maybe'), no: list('no'), mine: mine ? mine.answer : null, myGuests: mine ? mine.guests : 0 },
      reminderMin: row.reminder_min, familyCalendar: !!row.family_calendar, departureHint: !!row.departure_hint, cancelled: !!row.cancelled, creatorId: row.creator_id,
    });
  }
  return out;
}

async function load(ctx, x, idRaw) {
  const id = posInt(idRaw);
  if (!id) throw fail('not_found');
  const msg = await messages.visibleMessage(ctx, x.me, id);
  if (msg.kind !== 'event' || msg.deleted_at) throw fail(msg.deleted_at ? 'deleted' : 'invalid');
  const row = await store.one(ctx.gc, 'SELECT * FROM events WHERE msg_id = ?', [id]);
  if (!row) throw fail('invalid');
  return { msg, row, meta: messages.metaOf(msg) || {} };
}

async function touched(ctx, conv, members, id) {
  await store.run(ctx.gc, 'UPDATE messages SET updated_at = ? WHERE id = ?', [ctx.now, id]);
  await store.run(ctx.gc, 'UPDATE conversations SET updated_at = ? WHERE id = ?', [ctx.now, conv.id]);
  live.queue(ctx.box, members.map((m) => m.user_id), 'event.update', { conversationId: conv.id, messageId: id, updatedAt: iso(ctx.now) });
}

/** POST messages/:id/rsvp { answer, guests? } */
async function rsvp(ctx, x, idRaw, body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b || !(b.answer === null || ANSWERS.includes(b.answer))) throw fail('invalid');
  const { msg, row } = await load(ctx, x, idRaw);
  if (!row.rsvp) throw fail('not_allowed');
  if (row.cancelled) throw fail('closed');
  let guests = 0;
  if (b.guests != null) { guests = intIn(b.guests, 0, GUESTS_MAX); if (guests && (!row.guests || b.answer !== 'yes')) throw fail('invalid'); }
  if (b.answer === null) await store.run(ctx.gc, 'DELETE FROM event_rsvps WHERE msg_id = ? AND user_id = ?', [msg.id, ctx.viewer]);
  else {
    await store.run(ctx.gc, `INSERT INTO event_rsvps (msg_id, user_id, answer, guests, at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(msg_id, user_id) DO UPDATE SET answer = excluded.answer, guests = excluded.guests, at = excluded.at`, [msg.id, ctx.viewer, b.answer, guests, ctx.now]);
  }
  await touched(ctx, x.conv, x.members, msg.id);
  return msg.id;
}

/** POST messages/:id/checklist/:itemId { done } */
async function check(ctx, x, idRaw, itemId, body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b) throw fail('invalid');
  const done = bool(b.done);
  const { msg, row, meta } = await load(ctx, x, idRaw);
  if (row.cancelled) throw fail('closed');
  const item = ((meta.event || {}).checklist || []).find((c) => c.id === itemId);
  if (!item) throw fail('not_found');
  if (done) await store.run(ctx.gc, 'INSERT INTO event_checks (msg_id, item_id, user_id, at) VALUES (?, ?, ?, ?) ON CONFLICT(msg_id, item_id) DO UPDATE SET user_id = excluded.user_id, at = excluded.at', [msg.id, item.id, ctx.viewer, ctx.now]);
  else await store.run(ctx.gc, 'DELETE FROM event_checks WHERE msg_id = ? AND item_id = ?', [msg.id, item.id]);
  await touched(ctx, x.conv, x.members, msg.id);
  return msg.id;
}

/** PATCH messages/:id/event { title?, startsAt?, endsAt?, allDay?, place?, description?, checklist?, reminderMin?, departureHint?, familyCalendar?, rsvp?, guests?, cancelled? } */
async function patch(ctx, x, idRaw, body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b) throw fail('invalid');
  const { msg, row, meta } = await load(ctx, x, idRaw);
  if (row.creator_id !== ctx.viewer && x.me.role !== 'admin') throw fail('not_allowed');
  if (row.cancelled) throw fail('closed');
  const ev = { ...(meta.event || {}) };
  const r = { startsAt: row.starts_at, endsAt: row.ends_at, allDay: !!row.all_day, rsvp: !!row.rsvp, guests: !!row.guests, reminderMin: row.reminder_min, familyCalendar: !!row.family_calendar, departureHint: !!row.departure_hint };
  if (b.title !== undefined) ev.title = text(b.title, TITLE_MAX);
  if (b.startsAt !== undefined) { r.startsAt = parseIso(b.startsAt); if (r.startsAt == null) throw fail('invalid'); }
  if (b.endsAt !== undefined) { r.endsAt = b.endsAt === null ? null : parseIso(b.endsAt); if (b.endsAt !== null && r.endsAt == null) throw fail('invalid'); }
  if (r.endsAt != null && r.endsAt < r.startsAt) throw fail('invalid');
  if (b.place !== undefined) ev.place = cleanPlace(b.place);
  if (b.description !== undefined) { ev.description = b.description == null || b.description === '' ? null : messages.cleanText(b.description, false); if (ev.description && ev.description.length > DESC_MAX) throw fail('invalid'); }
  if (b.checklist !== undefined) {
    const next = cleanChecklist(b.checklist, ev.checklist || []);
    const gone = (ev.checklist || []).filter((c) => !next.some((n) => n.id === c.id)).map((c) => c.id);
    for (const g of gone) await store.run(ctx.gc, 'DELETE FROM event_checks WHERE msg_id = ? AND item_id = ?', [msg.id, g]);
    ev.checklist = next;
  }
  for (const k of ['allDay', 'rsvp', 'guests', 'familyCalendar', 'departureHint']) if (b[k] !== undefined) r[k] = bool(b[k]);
  if (b.reminderMin !== undefined) { if (!REMINDER_MIN.includes(b.reminderMin)) throw fail('invalid'); r.reminderMin = b.reminderMin; }
  const cancelled = b.cancelled !== undefined ? bool(b.cancelled) : false;
  const timeMoved = r.startsAt !== row.starts_at;
  await store.run(ctx.gc, `UPDATE events SET starts_at = ?, ends_at = ?, all_day = ?, rsvp = ?, guests = ?, reminder_min = ?, family_calendar = ?, departure_hint = ?, cancelled = ?,
    reminded_at = ?, departed_at = ?, updated_at = ? WHERE msg_id = ?`, [r.startsAt, r.endsAt, r.allDay ? 1 : 0, r.rsvp ? 1 : 0, r.guests ? 1 : 0, r.reminderMin, r.familyCalendar ? 1 : 0, r.departureHint ? 1 : 0,
    cancelled ? 1 : 0, timeMoved || b.reminderMin !== undefined ? null : row.reminded_at, timeMoved ? null : row.departed_at, ctx.now, msg.id]);
  await store.run(ctx.gc, 'UPDATE messages SET meta_enc = ?, edited_at = ? WHERE id = ?', [seal.sealJson({ ...meta, event: ev }), ctx.now, msg.id]);
  if (cancelled) await messages.system(ctx, x.conv, 'event_cancelled', { by: ctx.viewer, messageId: msg.id, title: ev.title });
  await touched(ctx, x.conv, x.members, msg.id);
  if (cancelled) live.queue(ctx.box, x.members.map((m) => m.user_id), 'message.new', { conversationId: x.conv.id, messageId: x.conv.last_msg_id, senderId: null, clientId: null, kind: 'system', createdAt: iso(ctx.now) });
  if (row.family_calendar || r.familyCalendar) queueCalendar(ctx, x.conv, msg.id, ev, r, cancelled || !r.familyCalendar ? 'remove' : 'upsert');
  return msg.id;
}

/** The next event of a conversation the member sees → { messageId, title, startsAt, yesCount } | null. */
async function nextEvent(ctx, me) {
  const rows = await store.all(ctx.gc, `SELECT e.*, m.meta_enc FROM events e JOIN messages m ON m.id = e.msg_id
    WHERE e.conv_id = ? AND e.cancelled = 0 AND m.deleted_at IS NULL AND m.id > ? AND (COALESCE(e.ends_at, e.starts_at + 3600000) > ?)
    AND NOT EXISTS (SELECT 1 FROM hidden h WHERE h.msg_id = m.id AND h.user_id = ?) ORDER BY e.starts_at ASC LIMIT 1`, [me.conv_id, me.joined_msg_id, ctx.now, me.user_id]);
  const r = rows[0];
  if (!r) return null;
  const meta = seal.openJson(r.meta_enc) || {};
  const yes = await store.one(ctx.gc, "SELECT COUNT(*) AS n FROM event_rsvps WHERE msg_id = ? AND answer = 'yes'", [r.msg_id]);
  return { messageId: r.msg_id, title: (meta.event && meta.event.title) || null, startsAt: iso(r.starts_at), yesCount: yes ? yes.n : 0 };
}

/** Who gets the reminder of an event: yes/maybe when rsvp is on, else every member. */
async function audience(gc, row) {
  if (row.rsvp) return (await store.all(gc, "SELECT user_id FROM event_rsvps WHERE msg_id = ? AND answer IN ('yes', 'maybe')", [row.msg_id])).map((r) => r.user_id);
  return (await store.all(gc, 'SELECT user_id FROM members WHERE conv_id = ? AND left_at IS NULL', [row.conv_id])).map((r) => r.user_id);
}

/** Background: reminder and departure pushes due now → number of events handled. */
async function due(ctx) {
  let n = 0;
  const rem = await store.all(ctx.gc, 'SELECT * FROM events WHERE cancelled = 0 AND reminder_min > 0 AND reminded_at IS NULL AND starts_at > ? AND starts_at - reminder_min * 60000 <= ? LIMIT 100', [ctx.now, ctx.now]);
  for (const row of rem) {
    await store.run(ctx.gc, 'UPDATE events SET reminded_at = ? WHERE msg_id = ?', [ctx.now, row.msg_id]);
    const job = await pushJob(ctx, row, 'event_reminder');
    if (job) ctx.box.pushes.push(job);
    n++;
  }
  const dep = await store.all(ctx.gc, 'SELECT * FROM events WHERE cancelled = 0 AND departure_hint = 1 AND departed_at IS NULL AND starts_at > ? AND starts_at - ? <= ? LIMIT 100', [ctx.now, DEPARTURE_MS, ctx.now]);
  for (const row of dep) {
    await store.run(ctx.gc, 'UPDATE events SET departed_at = ? WHERE msg_id = ?', [ctx.now, row.msg_id]);
    const job = await pushJob(ctx, row, 'event_departure');
    if (job) ctx.box.pushes.push(job);
    n++;
  }
  return n;
}

async function pushJob(ctx, row, kind) {
  const msg = await store.one(ctx.gc, 'SELECT * FROM messages WHERE id = ?', [row.msg_id]);
  const conv = await store.one(ctx.gc, 'SELECT * FROM conversations WHERE id = ?', [row.conv_id]);
  if (!msg || !conv || msg.deleted_at) return null;
  const members = await store.all(ctx.gc, 'SELECT * FROM members WHERE conv_id = ? AND left_at IS NULL', [conv.id]);
  const want = new Set(await audience(ctx.gc, row));
  const users = members.map((m) => m.user_id).filter((u) => want.has(u) && ctx.users.has(u));
  if (!users.length) return null;
  const meta = messages.metaOf(msg) || {};
  return { custom: { kind, conv, members, users, senderId: null, messageId: msg.id, params: { title: (meta.event && meta.event.title) || '', startsAt: row.starts_at, minutes: Math.round((row.starts_at - ctx.now) / 60000) }, deepLink: kind === 'event_departure' ? 'arrival' : null, respectMute: false } };
}

/** The event rows of deleted messages: calendar entries to remove (familyCalendar) and the rows themselves. */
async function cleanup(ctx, ids) {
  for (const id of ids) {
    const row = await store.one(ctx.gc, 'SELECT * FROM events WHERE msg_id = ?', [id]);
    if (!row) continue;
    if (row.family_calendar && ctx.box) queueCalendar(ctx, { id: row.conv_id }, id, {}, {}, 'remove');
    await store.run(ctx.gc, 'DELETE FROM events WHERE msg_id = ?', [id]);
    await store.run(ctx.gc, 'DELETE FROM event_rsvps WHERE msg_id = ?', [id]);
    await store.run(ctx.gc, 'DELETE FROM event_checks WHERE msg_id = ?', [id]);
  }
}

module.exports = { clean, create, decorate, rsvp, check, patch, nextEvent, due, cleanup, REMINDER_MIN, DEPARTURE_MS, TITLE_MAX, optText };
