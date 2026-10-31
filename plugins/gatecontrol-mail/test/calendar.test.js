'use strict';

// Calendars of Mail 1.2.0 (C3): the own GateControl calendars (first use, list, settings), events with repetition,
// exceptions and time zones, conflicts by etag, the rights of a person, the administrator's switch, the overlays of
// Familie, Alltag and the birthdays, reminders (once, bundled), internal invitations between GateControl people.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withMail, settle, ANNA, MARC, BOB, DAY } = require('./helpers');
const { fakeOverlays } = require('./pim-helpers');
const tz = require('../server/tz');

const BERLIN = 'Europe/Berlin';
const at = (date, hh, mm = 0) => tz.toUtc({ ...tz.parseDate(date), hh, mm }, BERLIN);

test('first use: „Privat“ (default) and „Firma“, „Meine Kontakte“; own calendars, colours, the last one stays; settings', () => withMail({ gatecontrol: '1.219.0' }, async (host, c) => {
  const anna = c.as(ANNA);
  const r = (await anna('GET', 'calendars')).json;
  assert.deepEqual(r.calendars.map((x) => [x.name, x.source, x.kind, x.isDefault, x.color, x.writable, x.maxReminders]),
    [['Privat', 'local', 'private', true, '#46E0A0', true, 3], ['Firma', 'local', 'business', false, '#79B8FF', true, 3]]);
  assert.deepEqual(r.prefs, { defaultCalendarId: r.calendars[0].id, view: '3day', weekStart: 1, workWeek: false, timeZone: BERLIN, reminders: true, defaultReminder: 15, allDayReminder: 1080 });
  assert.deepEqual(r.consent, []);
  // again: nothing new
  assert.equal((await anna('GET', 'calendars')).json.calendars.length, 2);
  const books = (await anna('GET', 'addressbooks')).json;
  assert.deepEqual(books.items.map((b) => [b.name, b.source, b.isDefault, b.count]), [['Meine Kontakte', 'local', true, 0]]);
  // own calendars: ≤ 20, a colour, renamed, hidden, not the last one
  const k = (await anna('POST', 'calendars', { name: 'Sport', color: '#ff8080' })).json.calendar;
  assert.deepEqual([k.name, k.color, k.kind, k.source], ['Sport', '#FF8080', 'other', 'local']);
  assert.equal((await anna('POST', 'calendars', { name: '' })).json.error.code, 'invalid');
  const p = (await anna('PATCH', `calendars/${k.id}`, { name: 'Training', visible: false, notify: false })).json.calendar;
  assert.deepEqual([p.name, p.visible, p.notify], ['Training', false, false]);
  for (let i = 0; i < 17; i++) assert.equal((await anna('POST', 'calendars', { name: `K${i}` })).status, 200);
  const full = await anna('POST', 'calendars', { name: 'Zu viel' });
  assert.deepEqual([full.status, full.json.error.code, full.json.error.max], [403, 'limit', 20]);
  const all = (await anna('GET', 'calendars')).json.calendars;
  for (const x of all.slice(1)) assert.equal((await anna('DELETE', `calendars/${x.id}`)).status, 200);
  const last = await anna('DELETE', `calendars/${all[0].id}`);
  assert.deepEqual([last.status, last.json.error.code], [409, 'not_supported']);
  // settings
  const s = (await anna('PUT', 'calendar/settings', { view: 'month', weekStart: 0, timeZone: 'America/New_York', defaultReminder: null, workWeek: true })).json.prefs;
  assert.deepEqual([s.view, s.weekStart, s.timeZone, s.defaultReminder, s.workWeek], ['month', 0, 'America/New_York', null, true]);
  for (const bad of [{ view: 'year' }, { timeZone: 'Mars/Olympus' }, { weekStart: 3 }, { defaultReminder: -1 }]) assert.equal((await anna('PUT', 'calendar/settings', bad)).json.error.code, 'invalid', JSON.stringify(bad));
  // Bob sees none of it; Anna's calendar is not found for him
  assert.equal((await c.as(BOB)('PATCH', `calendars/${all[0].id}`, { name: 'x' })).status, 404);
}));

test('events: create, a weekly series over the change to winter time, one occurrence changed and one deleted, the whole series; etag conflict', () => withMail({ gatecontrol: '1.219.0' }, async (host, c) => {
  const anna = c.as(ANNA);
  const cals = (await anna('GET', 'calendars')).json.calendars;
  const priv = cals[0].id;
  // Tuesdays 10:00 Berlin from 13 Oct 2026 (summer time) for 4 weeks — the clock stays at 10:00 after 25 Oct
  const start = at('2026-10-13', 10);
  const r = await anna('POST', 'events', { calendarId: priv, title: 'Jour fixe', allDay: false, start, end: start + 3600000, timeZone: BERLIN, location: 'Raum 1',
    recurrence: { freq: 'weekly', byDay: ['TU'], count: 4 }, reminders: [10] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const ev = r.json.event;
  assert.deepEqual([ev.title, ev.recurring, ev.recurrence.freq, ev.recurrence.byDay, ev.recurrence.count, ev.recurrence.editable, ev.reminders, ev.canEdit],
    ['Jour fixe', true, 'weekly', ['TU'], 4, true, [10], true]);
  assert.deepEqual(r.json.sent, { mail: 0, internal: 0 });
  const range = (await anna('GET', 'events', null, { from: at('2026-10-01', 0), to: at('2026-11-30', 0) })).json;
  assert.deepEqual(range.pending, []);
  const occ = range.items.filter((x) => x.eventId === ev.eventId);
  assert.deepEqual(occ.map((x) => new Date(x.start).toISOString()), ['2026-10-13T08:00:00.000Z', '2026-10-20T08:00:00.000Z', '2026-10-27T09:00:00.000Z', '2026-11-03T09:00:00.000Z']);
  assert.deepEqual([occ[2].key, occ[2].occurrence, occ[2].location, occ[2].reminder, occ[2].timeZone], [`${ev.eventId}:${occ[2].occurrence}`, String(occ[2].start), 'Raum 1', 10, BERLIN]);
  // one occurrence moved by two hours (an exception), one deleted
  const moved = await anna('PATCH', `events/${ev.eventId}`, { scope: 'occurrence', occurrence: occ[1].occurrence, start: occ[1].start + 7200000, end: occ[1].end + 7200000, title: 'Jour fixe (später)' });
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  assert.deepEqual([moved.json.event.title, moved.json.event.occurrence, moved.json.event.seriesId], ['Jour fixe (später)', occ[1].occurrence, ev.eventId]);
  assert.equal((await anna('DELETE', `events/${ev.eventId}`, null, { scope: 'occurrence', occurrence: occ[2].occurrence })).status, 200);
  const again = (await anna('GET', 'events', null, { from: at('2026-10-01', 0), to: at('2026-11-30', 0) })).json.items.filter((x) => x.eventId === ev.eventId);
  assert.deepEqual(again.map((x) => [new Date(x.start).toISOString(), x.title]), [['2026-10-13T08:00:00.000Z', 'Jour fixe'], ['2026-10-20T10:00:00.000Z', 'Jour fixe (später)'], ['2026-11-03T09:00:00.000Z', 'Jour fixe']]);
  const detail = (await anna('GET', `events/${ev.eventId}`)).json;
  assert.deepEqual([detail.recurrence.exceptions, detail.recurrence.deleted], [[occ[1].occurrence], [occ[2].occurrence]]);
  // the series: an old etag → conflict with the current state
  const stale = await anna('PATCH', `events/${ev.eventId}`, { scope: 'series', title: 'Neu', etag: '"0-0"' });
  assert.deepEqual([stale.status, stale.json.error.code, stale.json.error.current.title], [409, 'conflict', 'Jour fixe']);
  const ok = await anna('PATCH', `events/${ev.eventId}`, { scope: 'series', title: 'Team', etag: detail.etag, recurrence: { freq: 'weekly', byDay: ['TU'], count: 2 } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const two = (await anna('GET', 'events', null, { from: at('2026-10-01', 0), to: at('2026-11-30', 0) })).json.items.filter((x) => x.eventId === ev.eventId);
  assert.equal(two.length, 2);
  // the whole series goes
  assert.equal((await anna('DELETE', `events/${ev.eventId}`, null, { scope: 'series' })).status, 200);
  assert.equal((await anna('GET', `events/${ev.eventId}`)).status, 404);
  // ranges: at most 62 days, numbers
  assert.equal((await anna('GET', 'events', null, { from: at('2026-10-01', 0), to: at('2026-12-15', 0) })).json.error.field, 'to');
  assert.equal((await anna('GET', 'events', null, { from: 'heute', to: '1' })).json.error.code, 'invalid');
}));

test('all-day events: inclusive end date, yearly on 29 February, the time zone of the person; input checks', () => withMail({ gatecontrol: '1.219.0' }, async (host, c) => {
  const anna = c.as(ANNA);
  await anna('GET', 'calendars');
  const r = (await anna('POST', 'events', { title: 'Urlaub', allDay: true, startDate: '2026-11-04', endDate: '2026-11-06' })).json.event;
  assert.deepEqual([r.allDay, r.startDate, r.endDate, r.start, r.reminders], [true, '2026-11-04', '2026-11-06', at('2026-11-04', 0), [1080]], 'the all-day reminder: 18:00 the day before');
  const leap = (await anna('POST', 'events', { title: 'Schaltjahr', allDay: true, startDate: '2028-02-29', recurrence: { freq: 'yearly' } })).json.event;
  const y0 = (await anna('GET', 'events', null, { from: at('2028-02-01', 0), to: at('2028-03-31', 0) })).json.items.filter((x) => x.eventId === leap.eventId);
  assert.deepEqual(y0.map((x) => [x.startDate, x.occurrence]), [['2028-02-29', '2028-02-29']]);
  const y = (await anna('GET', 'events', null, { from: at('2029-02-01', 0), to: at('2029-03-31', 0) })).json.items.filter((x) => x.eventId === leap.eventId);
  assert.deepEqual(y.map((x) => x.startDate), [], 'RFC 5545: no 29 February in 2029');
  // beyond the stored window (−13 … +24 months): expanded when asked
  const y2 = (await anna('GET', 'events', null, { from: at('2032-02-01', 0), to: at('2032-03-31', 0) })).json.items.filter((x) => x.eventId === leap.eventId);
  assert.deepEqual(y2.map((x) => x.startDate), ['2032-02-29']);
  for (const bad of [{ title: '', allDay: false, start: 1, end: 2 }, { title: 'x', allDay: true, startDate: '2026-11-04', endDate: '2026-11-01' }, { title: 'x', allDay: false, start: 10, end: 5 },
    { title: 'x', allDay: false, start: 1, end: 2, timeZone: 'Nowhere/City' }, { title: 'x', allDay: false, start: 1, end: 2, recurrence: { freq: 'hourly' } },
    { title: 'x', allDay: false, start: 1, end: 2, attendees: [{ email: 'kein' }] }, { title: 'x', allDay: false, start: 1, end: 2, reminders: [1, 2, 3, 4] }]) {
    assert.equal((await anna('POST', 'events', bad)).json.error.code, 'invalid', JSON.stringify(bad));
  }
  // Teams only in Microsoft 365 calendars
  assert.equal((await anna('POST', 'events', { title: 'x', allDay: false, start: 1, end: 2, online: { create: 'teams' } })).json.error.code, 'not_supported');
  // another person's event: 404, never more
  assert.equal((await c.as(MARC)('GET', `events/${r.eventId}`)).status, 404);
  assert.equal((await c.as(MARC)('PATCH', `events/${r.eventId}`, { title: 'x' })).status, 404);
  assert.equal((await c.as(MARC)('DELETE', `events/${r.eventId}`)).status, 404);
}));

test('the administrator switches calendars and contacts off: 403 feature_off, features, contacts?q= like Phase 1', () => withMail({ gatecontrol: '1.219.0' }, async (host, c) => {
  await c.addGmx(ANNA);
  await c.admin('PUT', 'admin/settings', { calendar: { enabled: false }, contacts: { enabled: false } });
  const anna = c.as(ANNA);
  for (const [m, p] of [['GET', 'calendars'], ['GET', 'events'], ['POST', 'events'], ['GET', 'invitations'], ['PUT', 'calendar/settings']]) {
    const r = await anna(m, p, {});
    assert.deepEqual([r.status, r.json.error.code, r.json.error.feature], [403, 'feature_off', 'calendar'], p);
  }
  for (const [m, p] of [['GET', 'cards'], ['GET', 'addressbooks'], ['POST', 'groups']]) {
    const r = await anna(m, p, {});
    assert.deepEqual([r.status, r.json.error.code, r.json.error.feature], [403, 'feature_off', 'contacts'], p);
  }
  const me = (await anna('GET', 'me')).json;
  assert.ok(!me.features.includes('calendar') && !me.features.includes('contacts'));
  assert.deepEqual(me.microsoft.scopes.slice(-1), ['Mail.Send'], 'no calendar or contact scopes asked for');
  assert.equal(me.accounts[0].calendar.state, 'off');
  assert.equal((await anna('GET', 'contacts', null, { q: 'x' })).status, 200);
}));

test('overlays: Familie (pages), Alltag, birthdays of the contacts with the age; hidden and coloured per person', () => {
  const ov = fakeOverlays({
    familie: [{ id: '12', title: 'Elternabend', date: '2026-11-04', time: '19:00', endDate: null, endTime: '20:30', allDay: false, place: 'Schule', kind: 'event', memberIds: [2], origin: null },
      { id: 'member:5', title: 'Tim', date: '2026-11-09', time: null, endDate: null, endTime: null, allDay: true, place: null, kind: 'birthday', memberIds: [5], origin: null },
      { id: '13', title: 'Ausflug', date: '2026-11-21', time: null, endDate: '2026-11-22', endTime: null, allDay: true, place: null, kind: 'event', memberIds: [], origin: 'chat' }],
    alltag: [{ title: 'Restmüll', date: '2026-11-05', startMs: at('2026-11-05', 0), endMs: at('2026-11-06', 0), allDay: true, subId: 7, subName: 'Müllabfuhr', time: null, uid: 'r1|1', location: null }],
  });
  return withMail({ gatecontrol: '1.219.0', overlays: ov }, async (host, c) => {
    const anna = c.as(ANNA);
    const me = (await anna('GET', 'me')).json;
    assert.ok(me.features.includes('familyOverlay') && me.features.includes('alltagOverlay'));
    const list = (await anna('GET', 'calendars')).json.overlays;
    assert.deepEqual(list.map((o) => [o.id, o.source, o.name, o.visible]), [['familie', 'familie', 'Familie', true], ['alltag:7', 'alltag', 'Müllabfuhr', true], ['birthdays', 'birthdays', 'Geburtstage', true]]);
    await anna('POST', 'cards', { name: { given: 'Anna', family: 'Lang' }, birthday: '1986-11-12', emails: [{ value: 'anna.lang@example.com' }] });
    await anna('POST', 'cards', { name: { given: 'Ohne', family: 'Jahr' }, birthday: '--11-13' });
    const r = (await anna('GET', 'events', null, { from: at('2026-11-01', 0), to: at('2026-12-01', 0) })).json;
    assert.deepEqual(r.overlays.map((x) => [x.key.split(':')[0], x.title, x.allDay]), [['familie', 'Elternabend', false], ['alltag', 'Restmüll', true], ['familie', 'Tim', true],
      ['bday', 'Anna Lang (40)', true], ['bday', 'Ohne Jahr', true], ['familie', 'Ausflug', true]]);
    const eltern = r.overlays[0];
    assert.deepEqual([eltern.key, eltern.start, eltern.end, eltern.location, eltern.readOnly], ['familie:12:2026-11-04', at('2026-11-04', 19), at('2026-11-04', 20, 30), 'Schule', true]);
    assert.deepEqual([r.overlays[5].startDate, r.overlays[5].endDate], ['2026-11-21', '2026-11-22']);
    assert.ok(ov.familie.calls.filter((x) => x.name === 'calendar_range').length >= 2, 'pages with next/cursor');
    assert.ok(ov.familie.calls.every((x) => x.user === ANNA.id), 'only for the person');
    // cached 10 minutes per person and month
    const before = ov.familie.calls.length;
    await anna('GET', 'events', null, { from: at('2026-11-01', 0), to: at('2026-12-01', 0) });
    assert.equal(ov.familie.calls.length, before);
    // hidden and coloured
    const p = (await anna('PATCH', 'overlays/familie', { visible: false, color: '#123456' })).json.overlay;
    assert.deepEqual([p.visible, p.color], [false, '#123456']);
    const r2 = (await anna('GET', 'events', null, { from: at('2026-11-01', 0), to: at('2026-12-01', 0) })).json;
    assert.ok(!r2.overlays.some((x) => x.overlayId === 'familie'));
    const r3 = (await anna('GET', 'events', null, { from: at('2026-11-01', 0), to: at('2026-12-01', 0), calendars: 'familie' })).json;
    assert.deepEqual(r3.overlays.map((x) => x.overlayId), ['familie', 'familie', 'familie'], 'asked for by its id');
    assert.equal((await anna('PATCH', 'overlays/nope', { visible: true })).status, 404);
    // the administrator switches the birthdays off
    await c.admin('PUT', 'admin/settings', { calendar: { overlays: { birthdays: false } } });
    assert.ok(!(await anna('GET', 'calendars')).json.overlays.some((o) => o.id === 'birthdays'));
  });
});

test('reminders: once, at the right minute, bundled for one person, not for cancelled or declined events or calendars without notify', () => withMail({ gatecontrol: '1.219.0' }, async (host, c) => {
  const anna = c.as(ANNA);
  const cals = (await anna('GET', 'calendars')).json.calendars;
  const now = Date.now();
  const soon = Math.ceil((now + 10 * 60000) / 60000) * 60000;
  const a = (await anna('POST', 'events', { calendarId: cals[0].id, title: 'Zahnarzt', allDay: false, start: soon, end: soon + 1800000, timeZone: BERLIN, location: 'Praxis', reminders: [10] })).json.event;
  await anna('POST', 'events', { calendarId: cals[0].id, title: 'Später', allDay: false, start: soon + 3 * 3600000, end: soon + 4 * 3600000, timeZone: BERLIN, reminders: [10] });
  await anna('PATCH', `calendars/${cals[1].id}`, { notify: false });
  await anna('POST', 'events', { calendarId: cals[1].id, title: 'Stumm', allDay: false, start: soon, end: soon + 1800000, timeZone: BERLIN, reminders: [10] });
  const reminders = require('../server/reminders');
  // at the minute: Zahnarzt only
  await reminders.tick(host.gc, soon - 10 * 60000);
  const pushes = () => host.notifications.filter((x) => x.topic === 'calendar_reminder');
  assert.deepEqual(pushes().map((x) => [x.title, x.data.calendar.eventId]), [['Zahnarzt', a.eventId]]);
  assert.match(pushes()[0].body, /^\d\d:\d\d–\d\d:\d\d · Praxis$/);
  assert.equal(pushes()[0].collapseKey, `cal:${a.eventId}:`);
  // never twice
  await reminders.tick(host.gc, soon - 10 * 60000 + 5000);
  assert.equal(pushes().length, 1);
  // two in the same minute → one push; a cancelled one stays quiet; older than 10 minutes: dropped
  const t2 = soon + 2 * 3600000;
  await anna('POST', 'events', { calendarId: cals[0].id, title: 'A', allDay: false, start: t2, end: t2 + 60000, timeZone: BERLIN, reminders: [0] });
  await anna('POST', 'events', { calendarId: cals[0].id, title: 'B', allDay: false, start: t2, end: t2 + 60000, timeZone: BERLIN, reminders: [0] });
  await reminders.tick(host.gc, t2);
  const many = pushes().slice(1);
  assert.equal(many.length, 1);
  assert.match(many[0].title, /^2 Termine um \d\d:\d\d$/);
  const late = soon + 3 * 3600000;
  await reminders.tick(host.gc, late - 10 * 60000 + 11 * 60000);
  assert.equal(pushes().length, 2, 'a reminder older than 10 minutes is dropped');
  // the person switches reminders off
  await anna('PUT', 'calendar/settings', { reminders: false });
  const t3 = soon + 5 * 3600000;
  await anna('POST', 'events', { calendarId: cals[0].id, title: 'C', allDay: false, start: t3, end: t3 + 60000, timeZone: BERLIN, reminders: [0] });
  await reminders.tick(host.gc, t3);
  assert.equal(pushes().length, 2);
}));

test('internal invitations: a GateControl person with a Mail place gets it without mail, answers directly; the organizer sees the answer', () => withMail({ gatecontrol: '1.219.0' }, async (host, c) => {
  await c.addGmx(ANNA);
  await c.addGmx(MARC);
  await settle(200);
  const anna = c.as(ANNA);
  const marc = c.as(MARC);
  await marc('GET', 'calendars');
  const cals = (await anna('GET', 'calendars')).json.calendars;
  const start = Date.now() + 3 * DAY;
  const r = await anna('POST', 'events', { calendarId: cals[0].id, title: 'Planung', allDay: false, start, end: start + 3600000, timeZone: BERLIN,
    attendees: [{ email: 'marc@gmx.de', name: 'Marc' }, { email: 'extern@example.com', name: 'Extern' }] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.sent, { mail: 1, internal: 1 });
  assert.equal(r.json.event.organizer.email, 'anna@gmx.de');
  assert.equal(r.json.event.myResponse, 'organizer');
  // the mail to the other one carries the invitation (iMIP REQUEST)
  const sent = c.mail.sent.find((x) => x.message.icalEvent);
  assert.deepEqual([sent.message.icalEvent.method, sent.message.to.map((t) => t.address), sent.message.subject], ['REQUEST', ['extern@example.com'], 'Einladung: Planung']);
  assert.match(sent.message.icalEvent.content, /^METHOD:REQUEST\r?$/m);
  // Marc: a push, an open invitation, the event as needs_action in his calendar
  const push = host.notifications.find((x) => x.topic === 'calendar_invite');
  assert.deepEqual([push.users, push.title], [[MARC.id], 'Anna']);
  const open = (await marc('GET', 'invitations')).json.items;
  assert.deepEqual(open.map((x) => [x.kind, x.method, x.state, x.title, x.organizer.email, x.myResponse]), [['internal', 'request', 'open', 'Planung', 'anna@gmx.de', 'needs_action']]);
  const inv = open[0];
  assert.deepEqual(inv.counts, { accepted: 0, tentative: 0, declined: 0, needs_action: 2 });
  const mine = (await marc('GET', 'events', null, { from: start - DAY, to: start + DAY })).json.items;
  assert.deepEqual(mine.map((x) => [x.title, x.myResponse]), [['Planung', 'needs_action']]);
  // Marc accepts with a comment: no mail, Anna's event knows it
  const before = c.mail.sent.length;
  const ans = await marc('POST', `invitations/${inv.id}/respond`, { response: 'accepted', comment: 'Gerne' });
  assert.equal(ans.status, 200, JSON.stringify(ans.json));
  assert.deepEqual([ans.json.invitation.state, ans.json.event.myResponse], ['answered', 'accepted']);
  assert.equal(c.mail.sent.length, before, 'internal: no mail');
  const ev = (await anna('GET', `events/${r.json.event.eventId}`)).json;
  assert.deepEqual(ev.attendees.map((a) => [a.email, a.response]), [['marc@gmx.de', 'accepted'], ['extern@example.com', 'needs_action']]);
  const replies = (await anna('GET', 'invitations', null, { state: 'applied' })).json.items;
  assert.deepEqual(replies.map((x) => [x.method, x.from.email, x.comment]), [['reply', 'marc@gmx.de', 'Gerne']]);
  // the organizer deletes it with notify: a CANCEL (internal and by mail)
  const del = await anna('DELETE', `events/${r.json.event.eventId}`, null, { scope: 'series', notify: '1', comment: 'Fällt aus' });
  assert.deepEqual(del.json.sent, { mail: 1, internal: 1 });
  const cancel = (await marc('GET', 'invitations')).json.items.find((x) => x.method === 'cancel');
  assert.equal(cancel.title, 'Planung');
  const gone = (await marc('GET', 'events', null, { from: start - DAY, to: start + DAY })).json.items;
  assert.deepEqual(gone.map((x) => x.status), ['cancelled']);
  assert.equal((await marc('POST', `invitations/${cancel.id}/apply`)).status, 200);
  assert.deepEqual((await marc('GET', 'events', null, { from: start - DAY, to: start + DAY })).json.items, []);
  // the administrator switches internal invitations off: a mail then
  await c.admin('PUT', 'admin/settings', { calendar: { internalInvites: false } });
  const r2 = await anna('POST', 'events', { calendarId: cals[0].id, title: 'Per Mail', allDay: false, start, end: start + 3600000, timeZone: BERLIN, attendees: [{ email: 'marc@gmx.de' }] });
  assert.deepEqual(r2.json.sent, { mail: 1, internal: 0 });
}));

test('the AI to-do into the own calendar; the account side of GET me; Bob without a seat', () => withMail({ gatecontrol: '1.219.0', license: { tier: 'family', seats: { included: 2, family: 0, business: 0 } } }, async (host, c) => {
  const anna = c.as(ANNA);
  const acc = await c.addGmx(ANNA);
  const me = (await anna('GET', 'me')).json;
  const a = me.accounts.find((x) => x.id === acc.id);
  // GMX without gc.mail.dav answers: no CalDAV server in this test → none / unreachable, never a secret address
  assert.deepEqual(Object.keys(a.calendar).sort(), ['readOnly', 'server', 'state', 'sync']);
  assert.deepEqual(a.missingScopes, []);
  assert.ok(me.features.includes('dav'));
  // a to-do of the AI
  const m = (await c.list(ANNA)).items;
  void m;
  await host.gc.db.run('INSERT INTO ai_results (message_id, summary, todos_json, replies_json, at) VALUES (?, NULL, ?, ?, ?)', [999, JSON.stringify([{ kind: 'event', text: 'Elternabend', date: '2026-11-12', time: '19:00' }]), '[]', Date.now()]);
  await host.gc.db.run("INSERT INTO messages (id, user_id, account_id, folder_id, uid, date, created_at) VALUES (999, ?, ?, 1, 999, ?, ?)", [ANNA.id, acc.id, Date.now(), Date.now()]);
  const r = await anna('POST', 'ai/999/todo/0', { action: 'calendar' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.match(r.json.where, /„Privat“ am 12\.11\.2026 19:00/);
  const ev = (await anna('GET', `events/${r.json.eventId}`)).json;
  assert.deepEqual([ev.title, ev.start], ['Elternabend', at('2026-11-12', 19)]);
  // three people, two places: the third has none
  await c.as(MARC)('GET', 'me');
  const bob = await c.as(BOB)('GET', 'calendars');
  assert.deepEqual([bob.status, bob.json.error.code], [403, 'no_seat']);
}));
