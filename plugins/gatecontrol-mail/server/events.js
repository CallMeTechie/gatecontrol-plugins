'use strict';

// Events a person writes (C3 „Kalender – Termine“): POST events, PATCH events/<id>, DELETE events/<id>, POST
// events/<id>/respond. GateControl calendars: stored at once as iCalendar (version + 1, the live event); CalDAV: PUT in
// the pim line (first in it); Graph: beside it in the account's direct pool. The API answers once the provider took the
// change — nothing is kept half-saved. Own events with attendees: SEQUENCE + 1 and a REQUEST to all when time, place,
// rule or title change (sendInvites), CANCEL to removed attendees and on delete; GateControl people get it internally
// (GateControl calendars), Exchange and auto-scheduling CalDAV servers send it themselves.

const store = require('./store');
const config = require('./config');
const ics = require('./ics');
const tz = require('./tz');
const pimstore = require('./pimstore');
const pimgraph = require('./pimgraph');
const pimdav = require('./pimdav');
const pim = require('./pim');
const invites = require('./invites');
const calendars = require('./calendars');
const { fail, line, clip, parse, posInt, email } = require('./util');

const BUSY = ['busy', 'free', 'tentative', 'oof'];
const ROLES = ['required', 'optional', 'resource'];

/**
 * The checked fields of POST / PATCH events (only those given; `creating`: the required ones and the defaults). → x for
 * ics.applyFields / pimgraph.bodyOf, plus { sendInvites, fromAccountId }.
 */
function check(b, cal, prefs, creating, cur) {
  const x = {};
  const bad = (field) => { throw fail('invalid', { field }); };
  const has = (k) => b[k] !== undefined;
  if (creating || has('title')) {
    const s = clip(line(typeof b.title === 'string' ? b.title : ''), 255);
    if (!s || (typeof b.title === 'string' && b.title.length > 255)) bad('title');
    x.title = s;
  }
  const timeGiven = creating || has('allDay') || has('start') || has('end') || has('startDate') || has('endDate') || has('timeZone');
  if (timeGiven) {
    const allDay = has('allDay') ? b.allDay : (cur ? cur.allDay : false);
    if (typeof allDay !== 'boolean') bad('allDay');
    x.allDay = allDay;
    const zone = has('timeZone') ? b.timeZone : ((cur && cur.timeZone) || prefs.timeZone);
    if (typeof zone !== 'string' || !tz.valid(zone)) bad('timeZone');
    x.timeZone = zone;
    if (allDay) {
      const sd = has('startDate') ? b.startDate : (cur && cur.startDate);
      const ed = has('endDate') ? b.endDate : (has('startDate') ? b.startDate : (cur && cur.endDate));
      if (typeof sd !== 'string' || !tz.parseDate(sd)) bad('startDate');
      if (typeof ed !== 'string' || !tz.parseDate(ed) || ed < sd) bad('endDate');
      if (tz.diffDays(sd, ed) > 366) bad('endDate');
      x.startDate = sd; x.endDate = ed;
    } else {
      const s = has('start') ? b.start : (cur && cur.start);
      const e = has('end') ? b.end : (has('start') && cur ? b.start + (cur.end - cur.start) : (cur && cur.end));
      if (!Number.isSafeInteger(s)) bad('start');
      if (!Number.isSafeInteger(e) || e < s || e - s > 366 * 86400000) bad('end');
      x.start = s; x.end = e;
    }
  }
  if (has('location')) { if (b.location !== null && (typeof b.location !== 'string' || b.location.length > 500)) bad('location'); x.location = b.location ? clip(line(b.location), 500) : null; }
  if (has('description')) { if (b.description !== null && (typeof b.description !== 'string' || Buffer.byteLength(b.description) > ics.DESC_MAX)) bad('description'); x.description = b.description || ''; }
  if (has('online')) {
    const o = b.online;
    if (o === null) x.online = null;
    else if (o && o.create === 'teams') x.online = { create: 'teams' };
    else if (o && typeof o.url === 'string' && /^https:\/\/\S{1,1990}$/i.test(o.url)) x.online = { url: o.url };
    else bad('online');
  }
  if (has('reminders')) {
    if (!Array.isArray(b.reminders) || b.reminders.length > 3 || !b.reminders.every((m) => Number.isInteger(m) && m >= 0 && m <= 40320)) bad('reminders');
    x.reminders = [...new Set(b.reminders)].sort((p, q) => p - q);
  } else if (creating) {
    const d = (x.allDay ? prefs.allDayReminder : prefs.defaultReminder);
    x.reminders = d == null ? [] : [d];
  }
  if (has('recurrence')) x.rrule = ics.ruleOf(b.recurrence);
  if (has('attendees')) {
    if (!Array.isArray(b.attendees) || b.attendees.length > pimstore.ATTENDEES_MAX) bad('attendees');
    const list = [];
    for (const a of b.attendees) {
      const e = email(a && a.email);
      if (!e) bad('attendees');
      if (list.some((p) => p.email === e)) continue;
      list.push({ email: e, name: clip(line((a && a.name) || ''), 120), role: ROLES.includes(a && a.role) ? a.role : 'required' });
    }
    x.attendees = list;
  }
  if (has('busy')) { if (!BUSY.includes(b.busy)) bad('busy'); x.busy = b.busy; }
  if (has('private')) { if (typeof b.private !== 'boolean') bad('private'); x.private = b.private; }
  if (x.reminders && cal.source === 'graph' && x.reminders.length > 1) throw fail('not_supported', { what: 'reminders' });
  return x;
}

/** The account that sends the invitations of an event in calendar `cal` (fromAccountId; else the first of the kind). */
async function senderOf(gc, userId, cal, fromAccountId) {
  if (cal.account_id) return store.one(gc, 'SELECT * FROM accounts WHERE id = ?', [cal.account_id]);
  if (fromAccountId != null) {
    const a = await store.one(gc, 'SELECT * FROM accounts WHERE id = ? AND user_id = ?', [posInt(fromAccountId), userId]);
    if (!a) throw fail('invalid', { field: 'fromAccountId' });
    return a;
  }
  const kind = cal.kind === 'business' ? 'business' : 'personal';
  return (await store.one(gc, 'SELECT * FROM accounts WHERE user_id = ? AND kind = ? ORDER BY id LIMIT 1', [userId, kind]))
    || store.one(gc, 'SELECT * FROM accounts WHERE user_id = ? ORDER BY id LIMIT 1', [userId]);
}

const writable = (cal) => {
  if (cal.source === 'ics' || cal.writable !== 1) throw fail('read_only');
};

const accountOf = (gc, cal) => (cal.account_id ? store.one(gc, 'SELECT * FROM accounts WHERE id = ?', [cal.account_id]) : null);

/** Does an own event send iTIP itself (GateControl calendars, CalDAV without auto-schedule)? */
const sendsItip = (cal) => cal.source === 'local' || (cal.source === 'caldav' && cal.auto_schedule !== 1);

/** Does a change touch what the attendees must hear about (time, place, rule, title)? */
const significant = (x) => ['start', 'end', 'startDate', 'endDate', 'allDay', 'location', 'rrule', 'title', 'timeZone'].some((k) => Object.prototype.hasOwnProperty.call(x, k));

/** POST events → { event, sent: { mail, internal } } */
async function create(gc, ctx, b) {
  const cfg = await config.get(gc);
  await pimstore.ensureSetup(gc, ctx.userId, ctx.lang);
  const { prefs } = await pimstore.calPrefs(gc, ctx.userId, cfg);
  const cal = b.calendarId != null ? await pimstore.ownCalendar(gc, ctx.userId, posInt(b.calendarId)) : await pimstore.defaultCalendar(gc, ctx.userId);
  if (!cal) throw fail('not_found');
  writable(cal);
  const x = check(b, cal, prefs, true, null);
  if (x.online && x.online.create === 'teams' && !calendars.view(cal, await calendars.accountsOf(gc, ctx.userId)).canOnline) throw fail('not_supported', { what: 'teams' });
  const sent = { mail: 0, internal: 0 };
  const zone = prefs.timeZone;
  const own = await pimstore.ownAddresses(gc, ctx.userId);
  let ev;
  if (cal.source === 'graph') {
    const a = await accountOf(gc, cal);
    ev = await pim.forPerson(gc, a, () => pimgraph.createEvent(gc, a, cal, x, { userTz: zone, own }));
    if (!ev) throw fail('unreachable');
    await pimstore.touchCalendar(gc, cal);
    return { event: await calendars.full(gc, ctx.userId, ev, cal, null), sent: { mail: (x.attendees || []).length, internal: 0 } };
  }
  const sender = (x.attendees || []).length ? await senderOf(gc, ctx.userId, cal, b.fromAccountId) : null;
  const uid = pimstore.newUid();
  const fields = { ...x };
  if (fields.online && fields.online.create) delete fields.online;
  if ((x.attendees || []).length) {
    fields.organizer = sender ? { email: sender.email, name: sender.name || ctx.userName || '' } : null;
    fields.attendees = x.attendees.map((p) => ({ ...p, response: 'needs_action' }));
  }
  const text = ics.build(uid, fields);
  ev = await invites.writeObject(gc, ctx.userId, cal, null, text, uid);
  if (!ev) throw fail('unreachable');
  if ((x.attendees || []).length && b.sendInvites !== false && sendsItip(cal)) {
    try {
      const r = await invites.invite(gc, ctx.userId, ctx.lang, ev, cal, sender, 'REQUEST', x.attendees);
      sent.mail += r.mail; sent.internal += r.internal;
    } catch (e) {
      // nothing half-saved: the event goes again (the provider too)
      await removeObject(gc, ctx, ev, cal);
      throw e;
    }
  }
  return { event: await calendars.full(gc, ctx.userId, ev, cal, null), sent };
}

/** The current fields of event row `ev` for a PATCH (times and zone). */
function currentOf(ev, zone) {
  return { allDay: ev.all_day === 1, start: ev.start, end: ev.end, timeZone: ev.tz || zone, startDate: ev.all_day ? tz.localDate(ev.start, zone) : null, endDate: ev.all_day ? tz.localDate(ev.end - 1, zone) : null };
}

/** PATCH events/<id> { …fields, scope: 'occurrence'|'series', occurrence?, etag?, sendInvites? } → { event, sent } */
async function update(gc, ctx, id, b) {
  const { ev, cal } = await calendars.ownEvent(gc, ctx.userId, id);
  writable(cal);
  const cfg = await config.get(gc);
  const { prefs } = await pimstore.calPrefs(gc, ctx.userId, cfg);
  const scope = b.scope === 'occurrence' ? 'occurrence' : 'series';
  const occ = scope === 'occurrence' ? (typeof b.occurrence === 'string' && b.occurrence ? b.occurrence : null) : null;
  if (scope === 'occurrence' && !occ) throw fail('invalid', { field: 'occurrence' });
  if (b.etag !== undefined && b.etag !== calendars.etagOf(ev)) throw fail('conflict', { current: await calendars.full(gc, ctx.userId, ev, cal, occ) });
  const zone = prefs.timeZone;
  let cur = currentOf(ev, zone);
  if (occ) {
    const o = await store.one(gc, 'SELECT * FROM occurrences WHERE event_id = ? AND occ = ?', [ev.id, occ]);
    if (!o) throw fail('not_found');
    cur = { ...cur, start: o.start, end: o.end, startDate: o.all_day ? tz.localDate(o.start, zone) : null, endDate: o.all_day ? tz.localDate(o.end - 1, zone) : null };
  }
  const x = check(b, cal, prefs, false, cur);
  if (occ) delete x.rrule;
  const own = await pimstore.ownAddresses(gc, ctx.userId);
  const sent = { mail: 0, internal: 0 };
  if (x.online && x.online.create === 'teams' && !calendars.view(cal, await calendars.accountsOf(gc, ctx.userId)).canOnline) throw fail('not_supported', { what: 'teams' });
  if (cal.source === 'graph') {
    const a = await accountOf(gc, cal);
    const instanceId = occ ? ((await store.one(gc, 'SELECT remote_id FROM occurrences WHERE event_id = ? AND occ = ?', [ev.id, occ])) || {}).remote_id : null;
    if (occ && !instanceId) throw fail('not_found');
    let stored;
    try {
      stored = await pim.forPerson(gc, a, () => pimgraph.updateEvent(gc, a, cal, ev, x, { userTz: zone, own }, instanceId));
    } catch (e) {
      if (e && e.code === 'conflict') {
        const fresh = await pim.forPerson(gc, a, () => pimgraph.refreshEvent(gc, a, cal, ev.remote_id, { userTz: zone, own })).catch(() => null);
        throw fail('conflict', { current: await calendars.full(gc, ctx.userId, fresh || ev, cal, occ) });
      }
      throw e;
    }
    await pimstore.touchCalendar(gc, cal);
    await pimstore.live(gc, ctx.userId, 'calendar', { kind: 'changed', calendarId: cal.id, accountId: cal.account_id || null });
    return { event: await calendars.full(gc, ctx.userId, stored || ev, cal, occ), sent };
  }
  if (!ev.ics) throw fail('not_supported', { what: 'edit' });
  const before = ics.fieldsOf(ics.parse(ev.ics).objects[0].master || ics.parse(ev.ics).objects[0].overrides[0], { userTz: zone, own });
  const organizerSelf = !before.organizer || own.has(before.organizer.email);
  if (!organizerSelf) throw fail('read_only');
  const fields = { ...x };
  if (fields.online && fields.online.create) delete fields.online;
  const hadAtt = before.attendees.length > 0;
  let removed = [];
  let sender = null;
  if (fields.attendees) {
    removed = before.attendees.filter((p) => !fields.attendees.some((q) => q.email === p.email));
    if (fields.attendees.length && !before.organizer) {
      sender = await senderOf(gc, ctx.userId, cal, b.fromAccountId);
      fields.organizer = sender ? { email: sender.email, name: sender.name || ctx.userName || '' } : null;
    }
  }
  const nowAtt = fields.attendees || before.attendees;
  const bump = nowAtt.length > 0 && significant(x);
  const text = ics.change(ev.ics, ev.uid, fields, { occ, ctx: { userTz: zone, own }, bump });
  let stored;
  try {
    stored = await invites.writeObject(gc, ctx.userId, cal, ev, text, ev.uid);
  } catch (e) {
    if (e && e.code === 'conflict') {
      const fresh = await store.one(gc, 'SELECT * FROM events WHERE id = ?', [ev.id]);
      throw fail('conflict', { current: await calendars.full(gc, ctx.userId, fresh || ev, cal, occ) });
    }
    throw e;
  }
  if (!stored) throw fail('unreachable');
  if (b.sendInvites !== false && sendsItip(cal) && (hadAtt || nowAtt.length)) {
    if (!sender) sender = await senderOf(gc, ctx.userId, cal, b.fromAccountId);
    const added = fields.attendees ? fields.attendees.filter((p) => !before.attendees.some((q) => q.email === p.email)) : [];
    const to = bump ? nowAtt : added;
    try {
      if (to.length) { const r = await invites.invite(gc, ctx.userId, ctx.lang, stored, cal, sender, 'REQUEST', to, { occ, update: bump }); sent.mail += r.mail; sent.internal += r.internal; }
      if (removed.length) { const r = await invites.invite(gc, ctx.userId, ctx.lang, ev, cal, sender, 'CANCEL', removed, { removed: true }); sent.mail += r.mail; sent.internal += r.internal; }
    } catch (e) {
      // the provider has the change; the mail did not go: the change goes back
      await invites.writeObject(gc, ctx.userId, cal, stored, ev.ics, ev.uid).catch(() => null);
      throw e;
    }
  }
  return { event: await calendars.full(gc, ctx.userId, stored, cal, occ), sent };
}

/** Remove the object of event `ev` at its provider and here. */
async function removeObject(gc, ctx, ev, cal) {
  if (cal.source === 'caldav') {
    const a = await accountOf(gc, cal);
    await pim.forPerson(gc, a, () => pimdav.deleteEvent(gc, a, ev));
  }
  await pimstore.dropEvent(gc, ev);
  await pimstore.touchCalendar(gc, cal);
}

/**
 * Delete event `ev` (o: { scope, occ, notify, comment }) → sent. Organizer with attendees and `notify`: CANCEL to all; an
 * attendee with `notify`: declined.
 */
async function removeFor(gc, ctx, ev, cal, o) {
  const sent = { mail: 0, internal: 0 };
  const zone = await pimstore.zoneOf(gc, ctx.userId);
  const own = await pimstore.ownAddresses(gc, ctx.userId);
  const occ = o.scope === 'occurrence' ? o.occ : null;
  if (o.scope === 'occurrence' && !occ) throw fail('invalid', { field: 'occurrence' });
  if (cal.source === 'graph') {
    const a = await accountOf(gc, cal);
    const instanceId = occ ? ((await store.one(gc, 'SELECT remote_id FROM occurrences WHERE event_id = ? AND occ = ?', [ev.id, occ])) || {}).remote_id : null;
    if (occ && !instanceId) throw fail('not_found');
    const organizer = ev.my_response === 'organizer' && parse(ev.attendees_json, []).length > 0;
    if (!organizer && o.notify && ev.my_response && ev.my_response !== 'organizer') {
      await pim.forPerson(gc, a, () => pimgraph.respond(gc, a, instanceId || ev.remote_id, 'declined', { comment: o.comment, send: true, zone }));
    } else await pim.forPerson(gc, a, () => pimgraph.deleteEvent(gc, a, ev, { instanceId, notify: o.notify, comment: o.comment, organizer }));
    if (occ) await store.run(gc, 'DELETE FROM occurrences WHERE event_id = ? AND occ = ?', [ev.id, occ]);
    else await pimstore.dropEvent(gc, ev);
    await pimstore.touchCalendar(gc, cal);
    return sent;
  }
  writable(cal);
  if (!ev.ics) throw fail('not_supported', { what: 'delete' });
  const p = ics.parse(ev.ics);
  const f = ics.fieldsOf(p.objects[0].master || p.objects[0].overrides[0], { userTz: zone, own, zones: p.zones });
  const organizerSelf = !f.organizer || own.has(f.organizer.email);
  if (o.notify && sendsItip(cal) && f.attendees.length) {
    if (organizerSelf) {
      const sender = await senderOf(gc, ctx.userId, cal, null);
      const r = await invites.invite(gc, ctx.userId, ctx.lang, ev, cal, sender, 'CANCEL', f.attendees, { occ, comment: o.comment });
      sent.mail += r.mail; sent.internal += r.internal;
    } else {
      await invites.answer(gc, ctx.userId, ctx.lang, ev, cal, { response: 'declined', comment: o.comment, occ });
      sent.mail++;
      ev = await store.one(gc, 'SELECT * FROM events WHERE id = ?', [ev.id]) || ev;
    }
  }
  if (occ && (f.rrule || p.objects[0].overrides.length)) {
    const text = ics.exclude(ev.ics, ev.uid, occ, { userTz: zone });
    await invites.writeObject(gc, ctx.userId, cal, ev, text, ev.uid);
  } else await removeObject(gc, ctx, ev, cal);
  return sent;
}

/** DELETE events/<id>?scope=occurrence|series&occurrence=<occ>&notify=1&comment=<text> → { ok, sent } */
async function remove(gc, ctx, id, q) {
  const { ev, cal } = await calendars.ownEvent(gc, ctx.userId, id);
  if (cal.source === 'ics' || cal.writable !== 1) throw fail('read_only');
  const sent = await removeFor(gc, ctx, ev, cal, {
    scope: q.scope === 'occurrence' ? 'occurrence' : 'series', occ: typeof q.occurrence === 'string' ? q.occurrence : null,
    notify: q.notify === '1' || q.notify === 'true' || q.notify === true, comment: typeof q.comment === 'string' ? clip(q.comment, 2000) : null,
  });
  await store.run(gc, "UPDATE invitations SET event_id = NULL WHERE event_id = ? AND user_id = ?", [ev.id, ctx.userId]);
  return { ok: true, sent };
}

/** POST events/<id>/respond { response, comment?, occurrence?, proposeStart?, proposeEnd?, send? } → { event } */
async function respond(gc, ctx, id, b) {
  const { ev, cal } = await calendars.ownEvent(gc, ctx.userId, id);
  if (cal.source === 'ics' || cal.writable !== 1) throw fail('read_only');
  if (!invites.RESPONSES.includes(b.response)) throw fail('invalid', { field: 'response' });
  let propose = null;
  if (b.proposeStart != null || b.proposeEnd != null) {
    if (!Number.isSafeInteger(b.proposeStart) || !Number.isSafeInteger(b.proposeEnd) || b.proposeEnd < b.proposeStart) throw fail('invalid', { field: 'proposeStart' });
    propose = { start: b.proposeStart, end: b.proposeEnd };
  }
  const occ = typeof b.occurrence === 'string' && b.occurrence ? b.occurrence : null;
  const stored = await invites.answer(gc, ctx.userId, ctx.lang, ev, cal, { response: b.response, comment: b.comment == null ? null : clip(String(b.comment), 2000), occ, propose, send: b.send });
  await store.run(gc, "UPDATE invitations SET state = 'answered', response = ? WHERE user_id = ? AND uid = ? AND method = 'request' AND state = 'open'", [b.response, ctx.userId, ev.uid]);
  await pimstore.touchCalendar(gc, cal);
  const row = (stored && await store.one(gc, 'SELECT * FROM events WHERE id = ?', [stored.id])) || await store.one(gc, 'SELECT * FROM events WHERE id = ?', [ev.id]) || ev;
  return { event: await calendars.full(gc, ctx.userId, row, cal, occ) };
}

/** A to-do of the AI into the person's calendar (POST ai/<id>/todo/<i> { action: 'calendar', calendarId? }) → { eventId, calendar } */
async function fromTodo(gc, ctx, item, calendarId) {
  const cfg = await config.get(gc);
  await pimstore.ensureSetup(gc, ctx.userId, ctx.lang);
  const { prefs } = await pimstore.calPrefs(gc, ctx.userId, cfg);
  const body = { calendarId: calendarId != null ? calendarId : undefined, title: clip(item.text, 255) || 'Termin' };
  if (item.time) {
    const tm = tz.parseTime(item.time) || { hh: 9, mm: 0 };
    const start = tz.at(item.date, tm, prefs.timeZone);
    Object.assign(body, { allDay: false, start, end: start + 3600000, timeZone: prefs.timeZone });
  } else Object.assign(body, { allDay: true, startDate: item.date, endDate: item.date });
  const r = await create(gc, ctx, body);
  const cal = await store.one(gc, 'SELECT * FROM calendars WHERE id = ?', [r.event.calendarId]);
  return { eventId: r.event.eventId, calendar: cal };
}

module.exports = { check, create, update, remove, removeFor, respond, fromTodo, senderOf, sendsItip };
