'use strict';

// Invitations (C6): received in mail (iMIP: the calendar parts of gc.mail ≥ 1.219.0, Microsoft's event messages) or
// internally from another GateControl person, answered, applied, dismissed; and the iMIP messages the server sends for
// own events (REQUEST / CANCEL / REPLY / COUNTER / DECLINECOUNTER through the account's SMTP — gc.mail.smtp.send with
// icalEvent — or Graph's sendMail with the .ics).
//
// One row per person + UID + occurrence: a newer SEQUENCE (or DTSTAMP) replaces the older one (outdated). Only
// invitations that name an address of the person as ATTENDEE (REPLY / COUNTER: the person as ORGANIZER) get a card.
//   REQUEST  → the card with the answers; the event stands as needs_action in the target calendar until then
//              (Graph: Exchange makes it; CalDAV / local: the server does).
//   CANCEL   → the event is cancelled, „Aus Kalender entfernen“ (apply).
//   REPLY    → the attendee's answer goes into the own event at once (applied).
//   COUNTER  → „Übernehmen“ (apply: the event changes, a REQUEST to all) or „Ablehnen“ (dismiss { decline }: DECLINECOUNTER).

const store = require('./store');
const config = require('./config');
const secrets = require('./secrets');
const engine = require('./engine');
const ms = require('./microsoft');
const ics = require('./ics');
const tz = require('./tz');
const pimstore = require('./pimstore');
const pimdav = require('./pimdav');
const pimgraph = require('./pimgraph');
const pim = require('./pim');
const push = require('./push');
const mailstore = require('./mailstore');
const { t } = require('./text');
const { fail, parse, clip, line, posInt, textHtml } = require('./util');

const METHODS = { REQUEST: 'request', CANCEL: 'cancel', REPLY: 'reply', COUNTER: 'counter' };
const ICS_MAX = 512 * 1024;
const DAY_PAD = 2 * 3600000;

/** Is a calendar part an invitation we handle → its method (lower case) or null. */
function methodOf(part, parsed) {
  const m = String((part && part.method) || parsed.method || '').toUpperCase();
  return METHODS[m] || null;
}

const accountOf = (gc, id) => (id ? store.one(gc, 'SELECT * FROM accounts WHERE id = ?', [id]) : null);

// ─── receiving ──────────────────────────────────

/**
 * The calendar parts of mail row `m` of account `a` (gc.mail's `calendar`: [{ partId, method, text }]) → invitation rows
 * made / changed (messages.invite set). Never fails the mail.
 */
async function fromParts(gc, a, m, parts) {
  if (!Array.isArray(parts) || !parts.length) return 0;
  const cfg = await config.get(gc);
  if (!cfg.calendar.enabled) return 0;
  let n = 0;
  for (const part of parts.slice(0, 3)) {
    if (!part || typeof part.text !== 'string' || part.text.length > ICS_MAX) continue;
    try {
      const r = await receive(gc, m.user_id, { kind: 'mail', text: part.text, method: part.method, accountId: a.id, messageId: m.id });
      if (r) n++;
    } catch (e) {
      gc.log.warn('invitation skipped', (e && e.code) || 'error');
    }
  }
  return n;
}

/**
 * Microsoft: a message of the type eventMessage — the event comes with $expand (Calendars.ReadWrite; without it the card
 * asks to allow the calendar). → the invitation or null.
 */
async function fromGraph(gc, a, m) {
  const cfg = await config.get(gc);
  if (!cfg.calendar.enabled || !m.remote_id) return null;
  const r = await ms.graph(gc, a, 'GET', `/me/messages/${encodeURIComponent(m.remote_id)}/microsoft.graph.eventMessage?$select=meetingMessageType,subject,from&$expand=event`, undefined,
    { soft403: true, headers: { prefer: 'outlook.timezone="UTC"' } });
  if (r.status === 403) {
    // without Calendars.ReadWrite: a card that asks for it (no event)
    await store.run(gc, "UPDATE messages SET invite = 'request' WHERE id = ?", [m.id]);
    return null;
  }
  if (r.status >= 300 || !r.json) return null;
  const x = r.json;
  const kind = String(x.meetingMessageType || '');
  const method = /cancel/i.test(kind) ? 'cancel' : /accepted|declined|tentative|response/i.test(kind) ? 'reply' : /request/i.test(kind) ? 'request' : null;
  if (!method || !x.event) return null;
  const zone = await pimstore.zoneOf(gc, m.user_id);
  const f = pimgraph.fieldsOf(x.event, { userTz: zone });
  // a calendar object of the Graph event (for the card and the counts)
  const uid = x.event.iCalUId || `graph:${x.event.id}`;
  const text = ics.build(uid, {
    title: f.title, allDay: f.allDay, start: f.start, end: f.end, startDate: f.startDate, endDate: f.endDate, timeZone: f.tz || 'UTC', location: f.location,
    description: f.description, organizer: f.organizer, attendees: f.attendees, rrule: pimgraph.recurrenceRule(x.event.recurrence),
  });
  return receive(gc, m.user_id, { kind: 'mail', text: method === 'request' ? withMethod(text, 'REQUEST') : withMethod(text, method.toUpperCase()), method: method.toUpperCase(),
    accountId: a.id, messageId: m.id, graphEventId: x.event.id });
}

const withMethod = (text, method) => text.replace(/^(BEGIN:VCALENDAR\r?\n)/, `$1METHOD:${method}\r\n`);

/**
 * An invitation for person `userId` (o: { kind 'mail'|'internal', text, method?, accountId, messageId, fromUser,
 * graphEventId }) → the row, or null when it is not for the person.
 */
async function receive(gc, userId, o) {
  const parsed = ics.parse(o.text);
  const method = methodOf({ method: o.method }, parsed);
  if (!method) return null;
  const own = await pimstore.ownAddresses(gc, userId);
  const zone = await pimstore.zoneOf(gc, userId);
  const obj = parsed.objects[0];
  if (!obj) return null;
  const v = obj.master || obj.overrides[0];
  const ctx = { userTz: zone, own, zones: parsed.zones };
  const f = ics.fieldsOf(v, ctx);
  const isOrganizer = !!(f.organizer && own.has(f.organizer.email));
  const isAttendee = f.attendees.some((x) => own.has(x.email));
  if ((method === 'reply' || method === 'counter') ? !isOrganizer : !isAttendee) return null;
  const occ = !obj.master && v.getFirstProperty('recurrence-id') ? ics.occKey(ics.timeOf(v.getFirstProperty('recurrence-id'), parsed.zones, zone)) : '';
  const seq = f.sequence;
  const stamp = f.dtstamp || Date.now();
  const now = Date.now();
  return store.tx(gc, async () => {
    const same = await store.all(gc, "SELECT * FROM invitations WHERE user_id = ? AND uid = ? AND occ = ? AND method IN ('request', 'cancel') ORDER BY sequence DESC, dtstamp DESC", [userId, obj.uid, occ]);
    if (o.messageId) {
      const dup = await store.one(gc, 'SELECT * FROM invitations WHERE user_id = ? AND message_id = ? AND uid = ?', [userId, o.messageId, obj.uid]);
      if (dup) return dup;
    }
    let state = 'open';
    if (method === 'request' || method === 'cancel') {
      const newer = same.find((x) => x.sequence > seq || (x.sequence === seq && (x.dtstamp || 0) > stamp));
      if (newer) state = 'outdated';
      else for (const x of same) if (x.state !== 'outdated') await store.run(gc, "UPDATE invitations SET state = 'outdated' WHERE id = ?", [x.id]);
    }
    const r = await store.run(gc, `INSERT INTO invitations (user_id, kind, message_id, account_id, from_user, method, uid, occ, sequence, dtstamp, ics, state, comment, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, o.kind, o.messageId || null, o.accountId || null, o.fromUser || null, method, obj.uid, occ, seq, stamp, o.text, state,
      (v.getFirstPropertyValue('comment') ? clip(String(v.getFirstPropertyValue('comment')), 2000) : null), now]);
    const id = Number(r.lastInsertRowid);
    if (o.messageId) await store.run(gc, 'UPDATE messages SET invite = ? WHERE id = ?', [method, o.messageId]);
    return store.one(gc, 'SELECT * FROM invitations WHERE id = ?', [id]);
  }).then(async (inv) => {
    if (!inv || inv.state === 'outdated') return inv;
    try { await apply0(gc, userId, inv, { graphEventId: o.graphEventId }); } catch (e) { gc.log.warn('invitation not applied', method, (e && e.code) || 'error'); }
    await pimstore.live(gc, userId, 'calendar', { kind: 'invitation', invitationId: inv.id, messageId: inv.message_id || null });
    return store.one(gc, 'SELECT * FROM invitations WHERE id = ?', [inv.id]);
  });
}

/** The event of an invitation in the person's calendars (by UID; Graph: by its event id), or null. */
async function eventOf(gc, userId, inv, graphEventId) {
  if (inv.event_id) { const e = await store.one(gc, 'SELECT * FROM events WHERE id = ? AND user_id = ?', [inv.event_id, userId]); if (e) return e; }
  if (graphEventId) {
    const e = await store.one(gc, 'SELECT * FROM events WHERE user_id = ? AND (remote_id = ? OR uid = ?)', [userId, graphEventId, `graph:${graphEventId}`]);
    if (e) return e;
  }
  return store.one(gc, 'SELECT * FROM events WHERE user_id = ? AND uid = ? ORDER BY id LIMIT 1', [userId, inv.uid]);
}

/** The target calendar of an invitation: the calendar of the account it came to, else the own one of the fitting kind. */
async function targetOf(gc, userId, inv) {
  const a = await accountOf(gc, inv.account_id);
  if (a) {
    const c = await store.one(gc, "SELECT * FROM calendars WHERE account_id = ? AND writable = 1 AND source IN ('graph', 'caldav') ORDER BY is_default DESC, sort, id LIMIT 1", [a.id]);
    if (c) return c;
  }
  await pimstore.ensureSetup(gc, userId, 'de');
  return pimstore.defaultCalendar(gc, userId, a && a.kind === 'business' ? 'business' : 'private');
}

/** What an incoming invitation does at once: REQUEST → the event (needs_action), CANCEL → cancelled, REPLY → applied. */
async function apply0(gc, userId, inv, o = {}) {
  const ev = await eventOf(gc, userId, inv, o.graphEventId);
  if (inv.method === 'request') {
    if (ev) { await store.run(gc, 'UPDATE invitations SET event_id = ? WHERE id = ?', [ev.id, inv.id]); }
    const cal = ev ? await store.one(gc, 'SELECT * FROM calendars WHERE id = ?', [ev.calendar_id]) : await targetOf(gc, userId, inv);
    if (!cal || cal.source === 'graph') return; // Exchange keeps the event itself
    if (cal.source === 'caldav' && cal.auto_schedule) return; // the server schedules itself
    const text = ics.objectOf(inv.ics);
    const stored = await writeObject(gc, userId, cal, ev, text, inv.uid);
    if (stored) await store.run(gc, 'UPDATE invitations SET event_id = ? WHERE id = ?', [stored.id, inv.id]);
    return;
  }
  if (inv.method === 'cancel') {
    if (!ev || !ev.ics) { if (ev) await store.run(gc, 'UPDATE invitations SET event_id = ? WHERE id = ?', [ev.id, inv.id]); return; }
    const cal = await store.one(gc, 'SELECT * FROM calendars WHERE id = ?', [ev.calendar_id]);
    if (cal.source === 'caldav' && cal.auto_schedule) { await store.run(gc, 'UPDATE invitations SET event_id = ? WHERE id = ?', [ev.id, inv.id]); return; }
    const text = ics.change(ev.ics, ev.uid, { status: 'cancelled' }, { occ: inv.occ || null, ctx: { userTz: await pimstore.zoneOf(gc, userId) } });
    const stored = await writeObject(gc, userId, cal, ev, text, ev.uid);
    await store.run(gc, 'UPDATE invitations SET event_id = ? WHERE id = ?', [(stored || ev).id, inv.id]);
    return;
  }
  if (inv.method === 'reply') {
    if (!ev) return;
    await store.run(gc, 'UPDATE invitations SET event_id = ? WHERE id = ?', [ev.id, inv.id]);
    const p = ics.parse(inv.ics);
    const v = p.objects[0] && (p.objects[0].master || p.objects[0].overrides[0]);
    const who = v ? v.getAllProperties('attendee').map((x) => ({ email: ics.mailto(x.getFirstValue()), ps: String(x.getParameter('partstat') || '').toUpperCase() })).find((x) => x.email) : null;
    if (!who) return;
    const resp = { ACCEPTED: 'accepted', TENTATIVE: 'tentative', DECLINED: 'declined' }[who.ps] || 'needs_action';
    if (ev.ics) {
      const cal = await store.one(gc, 'SELECT * FROM calendars WHERE id = ?', [ev.calendar_id]);
      if (!(cal.source === 'caldav' && cal.auto_schedule) && cal.source !== 'graph') {
        const text = ics.partstat(ev.ics, who.email, resp, { occ: inv.occ || null, ctx: { userTz: await pimstore.zoneOf(gc, userId) } });
        await writeObject(gc, userId, cal, ev, text, ev.uid);
      }
    }
    await store.run(gc, "UPDATE invitations SET state = 'applied', response = ? WHERE id = ?", [resp, inv.id]);
  }
}

/**
 * Write a calendar object of person `userId` into calendar `cal` (local: here; CalDAV: PUT in the pim line, a person's
 * change first). → the stored row.
 */
async function writeObject(gc, userId, cal, ev, text, uid) {
  if (cal.source === 'local') {
    const stored = await pimstore.storeObject(gc, cal, text, { uid });
    await pimstore.touchCalendar(gc, cal);
    return stored;
  }
  if (cal.source === 'caldav') {
    const a = await accountOf(gc, cal.account_id);
    if (!a) return null;
    const stored = await pim.forPerson(gc, a, () => pimdav.putEvent(gc, a, cal, ev, text, uid));
    await pimstore.touchCalendar(gc, cal);
    return stored;
  }
  return null;
}

// ─── the view ───────────────────────────────────

/** Invitation row `inv` → the Invitation of the API (C3). */
async function view(gc, userId, inv) {
  const zone = await pimstore.zoneOf(gc, userId);
  const own = await pimstore.ownAddresses(gc, userId);
  const p = ics.parse(inv.ics);
  const obj = p.objects.find((x) => x.uid === inv.uid) || p.objects[0];
  const v = obj.master || obj.overrides[0];
  const f = ics.fieldsOf(v, { userTz: zone, own, zones: p.zones });
  const ev = inv.event_id ? await store.one(gc, 'SELECT * FROM events WHERE id = ?', [inv.event_id]) : null;
  const target = ev ? await store.one(gc, 'SELECT * FROM calendars WHERE id = ?', [ev.calendar_id]) : await targetOf(gc, userId, inv);
  const calendars = (await pimstore.calendarsOf(gc, userId)).filter((c) => c.writable === 1 && c.source !== 'ics');
  const counts = { accepted: 0, tentative: 0, declined: 0, needs_action: 0 };
  const evAtt = ev ? parse(ev.attendees_json, null) : null;
  const atts = (evAtt && evAtt.length && inv.method !== 'reply' ? evAtt : f.attendees);
  for (const a of atts) counts[a.response] = (counts[a.response] || 0) + 1;
  const ids = await require('./calendars').contactIds(gc, userId, [...atts.map((a) => a.email), ...(f.organizer ? [f.organizer.email] : [])]);
  let from = f.organizer ? { name: f.organizer.name, email: f.organizer.email } : { name: '', email: '' };
  if (inv.method === 'reply' || inv.method === 'counter') { const x = f.attendees[0]; if (x) from = { name: x.name, email: x.email }; }
  if (inv.kind === 'internal' && inv.from_user) {
    try { const u = await gc.users.get(inv.from_user); if (u && !from.name) from.name = u.name || ''; } catch { /* the address */ }
  }
  const mine = f.attendees.find((a) => own.has(a.email));
  const myResponse = ev && ev.my_response ? ev.my_response : (inv.response || (mine ? mine.response : null));
  // the day of the invitation ± 2 h for the small grid, and what overlaps
  const visible = calendars.length ? (await pimstore.calendarsOf(gc, userId)).filter((c) => c.visible === 1).map((c) => c.id) : [];
  const dayFrom = f.allDay ? pimstore.midnight(f.startDate, zone) : f.start - DAY_PAD;
  const dayTo = f.allDay ? pimstore.midnight(tz.addDays(f.endDate, 1), zone) : f.end + DAY_PAD;
  const day = (await require('./calendars').occurrences(gc, userId, visible, dayFrom, dayTo, 50)).filter((o) => !ev || o.eventId !== ev.id);
  const conflicts = day.filter((o) => o.start < f.end && o.end > f.start && o.busy !== 'free' && o.status !== 'cancelled' && o.myResponse !== 'declined')
    .map((o) => ({ title: o.title, start: o.start, end: o.end, calendarId: o.calendarId }));
  let proposed = null;
  if (inv.method === 'counter') proposed = { start: f.start, end: f.end };
  return {
    id: inv.id, kind: inv.kind, messageId: inv.message_id || null, accountId: inv.account_id || null, method: inv.method, state: inv.state, uid: inv.uid,
    title: f.title, start: f.start, end: f.end, allDay: f.allDay, ...(f.allDay ? { startDate: f.startDate, endDate: f.endDate } : {}), timeZone: f.tz || zone,
    location: f.location, online: f.online, recurrence: f.rrule ? { summary: ics.ruleSummary(f.rrule) } : null,
    organizer: f.organizer ? { name: f.organizer.name || '', email: f.organizer.email, contactId: ids.get(f.organizer.email) || null } : { name: from.name, email: from.email, contactId: null },
    from, attendees: atts.map((a) => ({ name: a.name || '', email: a.email, role: a.role || 'required', response: a.response || 'needs_action', self: own.has(a.email), contactId: ids.get(a.email) || null })),
    counts, myResponse, comment: inv.comment || null, proposed, eventId: ev ? ev.id : null, calendarId: target ? target.id : null,
    calendarChoices: calendars.map((c) => c.id), day, conflicts,
  };
}

async function own(gc, userId, id) {
  const inv = Number.isSafeInteger(id) ? await store.one(gc, 'SELECT * FROM invitations WHERE id = ? AND user_id = ?', [id, userId]) : null;
  if (!inv) throw fail('not_found');
  return inv;
}

/** GET invitations?state=open → { items } */
async function list(gc, ctx, q) {
  const state = typeof q.state === 'string' && ['open', 'answered', 'applied', 'cancelled', 'outdated'].includes(q.state) ? q.state : 'open';
  const rows = await store.all(gc, 'SELECT * FROM invitations WHERE user_id = ? AND state = ? ORDER BY created_at DESC LIMIT 100', [ctx.userId, state]);
  const items = [];
  for (const r of rows) { try { items.push(await view(gc, ctx.userId, r)); } catch { /* an unreadable one */ } }
  return { items };
}

async function get(gc, ctx, id) {
  return view(gc, ctx.userId, await own(gc, ctx.userId, id));
}

/** The Invitation of a mail (Message.invite) or null. */
async function forMessage(gc, userId, messageId) {
  const inv = await store.one(gc, 'SELECT * FROM invitations WHERE user_id = ? AND message_id = ? ORDER BY id DESC LIMIT 1', [userId, messageId]);
  if (!inv) return null;
  try { return await view(gc, userId, inv); } catch { return null; }
}

// ─── sending (iMIP) ─────────────────────────────

/** The person's account for an address (the one the invitation came to), else their first. */
async function senderFor(gc, userId, email, accountId) {
  if (accountId) { const a = await store.one(gc, 'SELECT * FROM accounts WHERE id = ? AND user_id = ?', [accountId, userId]); if (a) return a; }
  if (email) { const a = await store.one(gc, 'SELECT * FROM accounts WHERE user_id = ? AND email = ?', [userId, email]); if (a) return a; }
  return store.one(gc, 'SELECT * FROM accounts WHERE user_id = ? ORDER BY id LIMIT 1', [userId]);
}

/**
 * Send iTIP message `content` (method) from account `a` to `to` ([{ name, email }]) → the number sent; throws send_failed
 * — nothing is stored by the caller then. The copy goes to „Gesendet“ like any mail (IMAP; Gmail and Microsoft keep it).
 */
async function sendItip(gc, a, method, content, to, { subject, text } = {}) {
  const list = to.filter((p) => p && p.email && p.email !== a.email);
  if (!list.length) return 0;
  const body = text || '';
  try {
    if (engine.isGraph(a)) {
      const message = {
        subject, body: { contentType: 'HTML', content: textHtml(body) }, toRecipients: list.map((p) => ({ emailAddress: { address: p.email, ...(p.name ? { name: p.name } : {}) } })),
        attachments: [{ '@odata.type': '#microsoft.graph.fileAttachment', name: 'invite.ics', contentType: `text/calendar; method=${method}`, contentBytes: Buffer.from(content).toString('base64') }],
      };
      const r = await ms.graph(gc, a, 'POST', '/me/sendMail', { message, saveToSentItems: true });
      if (r.status >= 300) throw fail('send_failed', { reason: ms.graphError(r) });
      return list.length;
    }
    const cred = await secrets.get(gc, a.id);
    if (!cred || !cred.password) throw fail('send_failed', { reason: 'auth' });
    const res = await gc.mail.smtp.send({
      host: a.smtp_host, port: a.smtp_port, security: a.smtp_security, auth: { user: a.username || a.email, pass: cred.password },
      message: { from: { name: a.name || '', address: a.email }, to: list.map((p) => ({ name: p.name || '', address: p.email })), subject, text: body, html: textHtml(body),
        icalEvent: { method, content, filename: 'invite.ics' } },
      appendCopy: a.provider !== 'gmail',
    });
    if (res && res.raw && res.raw.mediaId) {
      try { await engine.appendSent(gc, a, res.raw.mediaId); } catch { /* the copy only */ }
      try { await gc.media.delete(res.raw.mediaId); } catch { /* gone */ }
    }
    for (const p of list) await mailstore.contact(gc, a.user_id, p, 'sent', Date.now());
    return list.length;
  } catch (e) {
    if (e && e.code === 'send_failed') throw e;
    throw fail('send_failed', { reason: (e && e.code) || 'error' });
  }
}

/** A text of the time of an event for subjects and bodies ("Mi 4.11.2026 13:00–14:00"). */
function whenText(lang, f, zone) {
  const loc = lang === 'en' ? 'en-GB' : 'de-DE';
  const d = (ms0) => new Date(ms0).toLocaleDateString(loc, { timeZone: zone, weekday: 'short', day: 'numeric', month: 'numeric', year: 'numeric' });
  const h = (ms0) => new Date(ms0).toLocaleTimeString(loc, { timeZone: zone, hour: '2-digit', minute: '2-digit' });
  if (f.allDay) return f.startDate === f.endDate ? d(f.start) : `${d(f.start)} – ${d(f.end - 1)}`;
  return `${d(f.start)} ${h(f.start)}–${h(f.end)}`;
}

/** The text of an iMIP mail: comment, when, where, organizer. */
function bodyOf(lang, f, zone, comment) {
  const lines = [];
  if (comment) lines.push(comment, '');
  lines.push(t(lang, 'imip.when', { when: whenText(lang, f, zone) }));
  if (f.location) lines.push(t(lang, 'imip.where', { where: f.location }));
  if (f.organizer) lines.push(t(lang, 'imip.organizer', { name: f.organizer.name || f.organizer.email }));
  return lines.join('\n');
}

/**
 * The people of the attendees of an own event that are GateControl people with a Mail place (internal invitations,
 * events of GateControl calendars only) → Map email → userId.
 */
async function internalPeople(gc, userId, emails) {
  const cfg = await config.get(gc);
  const out = new Map();
  if (!cfg.calendar.internalInvites || !emails.length) return out;
  for (const part of store.chunks([...new Set(emails)], 80)) {
    const rows = await store.all(gc, `SELECT a.email, a.user_id FROM accounts a JOIN seats s ON s.user_id = a.user_id AND s.kind IN ('family', 'business')
      WHERE a.email IN (${store.marks(part.length)}) AND a.user_id <> ?`, [...part, userId]);
    for (const r of rows) if (await config.allowed(gc, cfg, r.user_id)) out.set(r.email, r.user_id);
  }
  return out;
}

/**
 * Send the invitations of own event `ev` (organizer): method REQUEST (`only`: these attendees) or CANCEL. Attendees who
 * are GateControl people (GateControl calendars) get it internally; the others by iMIP from account `a`. → { mail, internal }.
 */
async function invite(gc, userId, lang, ev, cal, a, method, people, o = {}) {
  const sent = { mail: 0, internal: 0 };
  if (!people.length || !ev.ics) return sent;
  const zone = await pimstore.zoneOf(gc, userId);
  const f = ics.fieldsOf((ics.parse(ev.ics).objects[0] || {}).master || ics.parse(ev.ics).objects[0].overrides[0], { userTz: zone, own: new Set() });
  const internal = cal.source === 'local' ? await internalPeople(gc, userId, people.map((p) => p.email)) : new Map();
  const content = ics.itip(method, ev.ics, { occ: o.occ || null, userTz: zone, only: method === 'CANCEL' && o.removed ? people : null });
  for (const p of people) {
    const uid2 = internal.get(p.email);
    if (!uid2) continue;
    try {
      const inv = await receive(gc, uid2, { kind: 'internal', text: content, method, fromUser: userId });
      if (inv) {
        sent.internal++;
        await pushInvite(gc, uid2, inv, f, zone, userId);
      }
    } catch (e) { gc.log.warn('internal invitation failed', (e && e.code) || 'error'); }
  }
  const external = people.filter((p) => !internal.has(p.email));
  if (external.length && a) {
    const key = method === 'CANCEL' ? 'imip.cancel' : (o.update ? 'imip.update' : 'imip.request');
    sent.mail += await sendItip(gc, a, method, content, external, { subject: t(lang, key, { title: f.title || '' }), text: bodyOf(lang, f, zone, o.comment) });
  }
  return sent;
}

/** The push of an internal invitation (topic calendar_invite). */
async function pushInvite(gc, userId, inv, f, zone, fromUser) {
  const lang = await push.langOf(gc, userId);
  let name = '';
  try { const u = await gc.users.get(fromUser); name = (u && u.name) || ''; } catch { name = ''; }
  try {
    await gc.notify({
      topic: 'calendar_invite', users: [userId], collapseKey: `inv:${inv.id}`, title: clip(name || (f.organizer && (f.organizer.name || f.organizer.email)) || 'GateControl', 120),
      body: clip(t(lang, 'push.invite', { title: f.title || '', when: whenText(lang, f, zone) }), 300), data: { calendar: { invitationId: inv.id } },
    });
  } catch (e) { gc.log.warn('invitation push failed', (e && e.code) || 'error'); }
}

// ─── answering ──────────────────────────────────

const RESPONSES = ['accepted', 'tentative', 'declined'];

/**
 * Answer the invitation of event `ev` as person `userId` (`response`, comment, occ, propose { start, end }) — the answer
 * goes out first (Graph: the event API; CalDAV with auto-schedule: PUT; else iMIP REPLY / COUNTER to the organizer, or
 * internally), then it is stored. → the stored event row (or null).
 */
async function answer(gc, userId, lang, ev, cal, o) {
  const zone = await pimstore.zoneOf(gc, userId);
  const own = await pimstore.ownAddresses(gc, userId);
  const a = cal.account_id ? await accountOf(gc, cal.account_id) : null;
  if (cal.source === 'graph') {
    const id = o.occ ? ((await store.one(gc, 'SELECT remote_id FROM occurrences WHERE event_id = ? AND occ = ?', [ev.id, o.occ])) || {}).remote_id : ev.remote_id;
    if (!id) throw fail('not_found');
    await pim.forPerson(gc, a, () => pimgraph.respond(gc, a, id, o.response, { comment: o.comment, send: o.send, propose: o.propose, zone }));
    return pim.forPerson(gc, a, () => pimgraph.refreshEvent(gc, a, cal, ev.remote_id, { userTz: zone, own }));
  }
  if (!ev.ics) throw fail('not_supported', { what: 'respond' });
  const p = ics.parse(ev.ics);
  const v = p.objects[0].master || p.objects[0].overrides[0];
  const f = ics.fieldsOf(v, { userTz: zone, own, zones: p.zones });
  const me = f.attendees.find((x) => own.has(x.email));
  if (!me) throw fail('not_supported', { what: 'respond' });
  const text = ics.partstat(ev.ics, me.email, o.response, { occ: o.occ || null, ctx: { userTz: zone } });
  const organizer = f.organizer;
  const autoSchedule = cal.source === 'caldav' && cal.auto_schedule === 1;
  if (o.send !== false && organizer && !autoSchedule) {
    // the organizer: a GateControl person (internal) or by iMIP
    const internal = await store.one(gc, "SELECT user_id FROM invitations WHERE user_id = ? AND uid = ? AND kind = 'internal' ORDER BY id DESC LIMIT 1", [userId, ev.uid]);
    const orgInv = internal ? await store.one(gc, "SELECT from_user FROM invitations WHERE user_id = ? AND uid = ? AND kind = 'internal' AND from_user IS NOT NULL ORDER BY id DESC LIMIT 1", [userId, ev.uid]) : null;
    const method = o.propose ? 'COUNTER' : 'REPLY';
    const content = ics.itip(method, text, { me: me.email, response: o.response, comment: o.comment || null, occ: o.occ || null, userTz: zone, proposed: o.propose ? { ...o.propose, timeZone: f.tz || zone } : null });
    if (orgInv && orgInv.from_user) {
      await receive(gc, orgInv.from_user, { kind: 'internal', text: content, method, fromUser: userId });
    } else {
      const inv = await store.one(gc, 'SELECT account_id FROM invitations WHERE user_id = ? AND uid = ? AND account_id IS NOT NULL ORDER BY id DESC LIMIT 1', [userId, ev.uid]);
      const sender = await senderFor(gc, userId, me.email, (a && a.id) || (inv && inv.account_id));
      if (!sender) throw fail('send_failed', { reason: 'no_account' });
      const key = o.propose ? 'imip.counter' : `imip.${o.response}`;
      await sendItip(gc, sender, method, content, [organizer], { subject: t(lang, key, { title: f.title || '' }), text: o.comment || '' });
    }
  }
  return writeObject(gc, userId, cal, ev, text, ev.uid);
}

/** POST invitations/<id>/respond { response, comment?, calendarId?, proposeStart?, proposeEnd? } → { invitation, event } */
async function respond(gc, ctx, id, b) {
  const inv = await own(gc, ctx.userId, id);
  if (inv.state === 'outdated' || inv.state === 'cancelled') throw fail('invitation_outdated');
  if (inv.method !== 'request') throw fail('invalid', { field: 'method' });
  if (!RESPONSES.includes(b.response)) throw fail('invalid', { field: 'response' });
  const comment = b.comment == null ? null : clip(String(b.comment), 2000);
  const propose = proposeOf(b);
  let ev = await eventOf(gc, ctx.userId, inv);
  if (b.calendarId != null && (!ev || ev.calendar_id !== posInt(b.calendarId))) {
    // into another calendar of the person (local or CalDAV)
    const cal = await pimstore.ownCalendar(gc, ctx.userId, posInt(b.calendarId));
    if (cal.writable !== 1 || cal.source === 'ics' || cal.source === 'graph') throw fail('read_only');
    const stored = await writeObject(gc, ctx.userId, cal, null, ics.objectOf(inv.ics), inv.uid);
    if (ev && ev.calendar_id !== cal.id) {
      const old = await store.one(gc, 'SELECT * FROM calendars WHERE id = ?', [ev.calendar_id]);
      if (old && old.source === 'local') { await pimstore.dropEvent(gc, ev); await pimstore.touchCalendar(gc, old); }
    }
    ev = stored;
  }
  if (!ev) {
    const cal = await targetOf(gc, ctx.userId, inv);
    if (!cal || cal.source === 'graph') throw fail('not_found');
    ev = await writeObject(gc, ctx.userId, cal, null, ics.objectOf(inv.ics), inv.uid);
  }
  const cal = await store.one(gc, 'SELECT * FROM calendars WHERE id = ?', [ev.calendar_id]);
  const stored = await answer(gc, ctx.userId, ctx.lang, ev, cal, { response: b.response, comment, occ: inv.occ || null, propose });
  await store.run(gc, "UPDATE invitations SET state = 'answered', response = ?, event_id = ? WHERE id = ?", [b.response, (stored || ev).id, inv.id]);
  await pimstore.live(gc, ctx.userId, 'calendar', { kind: 'invitation', invitationId: inv.id, messageId: inv.message_id || null });
  if (inv.message_id) await push.changed(gc, ctx.userId, inv.account_id, null, { messageId: inv.message_id });
  const calendars = require('./calendars');
  const evRow = stored ? await store.one(gc, 'SELECT * FROM events WHERE id = ?', [stored.id]) : null;
  return { invitation: await view(gc, ctx.userId, await own(gc, ctx.userId, id)), event: evRow ? await calendars.full(gc, ctx.userId, evRow, cal, inv.occ || null) : null };
}

function proposeOf(b) {
  if (b.proposeStart == null && b.proposeEnd == null) return null;
  const s = Number(b.proposeStart);
  const e = Number(b.proposeEnd);
  if (!Number.isSafeInteger(s) || !Number.isSafeInteger(e) || e < s) throw fail('invalid', { field: 'proposeStart' });
  return { start: s, end: e };
}

/**
 * POST invitations/<id>/apply → { invitation, event } — a COUNTER: the proposal into the own event (SEQUENCE + 1, a
 * REQUEST to all); a CANCEL: the event leaves the calendar.
 */
async function apply(gc, ctx, id) {
  const inv = await own(gc, ctx.userId, id);
  if (inv.state === 'outdated') throw fail('invitation_outdated');
  const ev = await eventOf(gc, ctx.userId, inv);
  if (inv.method === 'cancel') {
    if (ev) {
      const cal = await store.one(gc, 'SELECT * FROM calendars WHERE id = ?', [ev.calendar_id]);
      await require('./events').removeFor(gc, ctx, ev, cal, { scope: inv.occ ? 'occurrence' : 'series', occ: inv.occ || null, notify: false });
    }
    await store.run(gc, "UPDATE invitations SET state = 'applied', event_id = NULL WHERE id = ?", [inv.id]);
    return { invitation: await view(gc, ctx.userId, await own(gc, ctx.userId, id)), event: null };
  }
  if (inv.method !== 'counter') throw fail('invalid', { field: 'method' });
  if (!ev) throw fail('not_found');
  const zone = await pimstore.zoneOf(gc, ctx.userId);
  const p = ics.parse(inv.ics);
  const f = ics.fieldsOf(p.objects[0].master || p.objects[0].overrides[0], { userTz: zone, zones: p.zones });
  const r = await require('./events').update(gc, ctx, ev.id, {
    ...(f.allDay ? { allDay: true, startDate: f.startDate, endDate: f.endDate } : { allDay: false, start: f.start, end: f.end, timeZone: ev.tz || zone }),
    scope: inv.occ ? 'occurrence' : 'series', ...(inv.occ ? { occurrence: inv.occ } : {}), sendInvites: true,
  });
  await store.run(gc, "UPDATE invitations SET state = 'applied' WHERE id = ?", [inv.id]);
  return { invitation: await view(gc, ctx.userId, await own(gc, ctx.userId, id)), event: r.event };
}

/** POST invitations/<id>/dismiss { decline? } → { ok } — a COUNTER declined: DECLINECOUNTER to its sender; else only hidden. */
async function dismiss(gc, ctx, id, b) {
  const inv = await own(gc, ctx.userId, id);
  if (b && b.decline === true && inv.method === 'counter') {
    const ev = await eventOf(gc, ctx.userId, inv);
    const p = ics.parse(inv.ics);
    const v = p.objects[0].master || p.objects[0].overrides[0];
    const who = v.getAllProperties('attendee').map((x) => ({ email: ics.mailto(x.getFirstValue()), name: x.getParameter('cn') || '' })).find((x) => x.email);
    if (who && ev && ev.ics) {
      const zone = await pimstore.zoneOf(gc, ctx.userId);
      const content = ics.itip('DECLINECOUNTER', ev.ics, { me: who.email, myName: who.name, occ: inv.occ || null, userTz: zone });
      if (inv.kind === 'internal' && inv.from_user) await receive(gc, inv.from_user, { kind: 'internal', text: content, method: 'DECLINECOUNTER', fromUser: ctx.userId }).catch(() => null);
      else {
        const sender = await senderFor(gc, ctx.userId, null, inv.account_id);
        if (sender) await sendItip(gc, sender, 'DECLINECOUNTER', content, [who], { subject: t(ctx.lang, 'imip.declinecounter', { title: ev.title || '' }), text: '' });
      }
    }
  }
  await store.run(gc, "UPDATE invitations SET state = CASE WHEN state = 'open' THEN 'answered' ELSE state END, response = COALESCE(response, 'dismissed') WHERE id = ?", [inv.id]);
  await pimstore.live(gc, ctx.userId, 'calendar', { kind: 'invitation', invitationId: inv.id, messageId: inv.message_id || null });
  return { ok: true };
}

module.exports = {
  fromParts, fromGraph, receive, view, list, get, forMessage, respond, apply, dismiss, answer, invite, sendItip, senderFor, internalPeople, whenText, bodyOf,
  eventOf, targetOf, writeObject, RESPONSES,
};
