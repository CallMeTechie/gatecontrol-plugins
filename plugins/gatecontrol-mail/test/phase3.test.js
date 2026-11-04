'use strict';

// Mail 1.9.0 (Phase 3): resources (the administrator's list, who may book, the rules, conflicts, the requests with the
// first decision for everybody, overrides in the log), free/busy without titles (private events as busy, the person's
// switch, Microsoft 365 by getSchedule, suggestions in the working hours) and shared GateControl calendars at the three
// levels. Rights are the server's: everything here is checked against the API, never the UI.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withMail, settle, ANNA, MARC, BOB, DAY } = require('./helpers');
const tz = require('../server/tz');

const BERLIN = 'Europe/Berlin';
const at = (date, hh, mm = 0) => tz.toUtc({ ...tz.parseDate(date), hh, mm }, BERLIN);
const HOUR = 3600000;
/** The next `weekday` (1 = Monday … 7) at least two days from now, in Berlin. */
function next(weekday) {
  let d = tz.addDays(tz.localDate(Date.now(), BERLIN), 2);
  while (((tz.weekday(d) + 6) % 7) + 1 !== weekday) d = tz.addDays(d, 1);
  return d;
}
const GROUPS = [{ id: 7, name: 'Fuhrpark', kind: 'team', members: [{ userId: MARC.id, role: 'member' }, { userId: BOB.id, role: 'member' }] },
  { id: 8, name: 'Außendienst', kind: 'team', members: [{ userId: ANNA.id, role: 'member' }] }];
const O = { gatecontrol: '1.219.0', groups: GROUPS };

async function setup(c) {
  for (const u of [ANNA, MARC, BOB]) await c.addGmx(u);
  await settle(150);
  const room = (await c.admin('POST', 'admin/resources', { name: 'Besprechungsraum 1', kind: 'room', location: '2. OG', seats: 8, equipment: 'Bildschirm',
    rules: { hours: { days: [1, 2, 3, 4, 5], from: '07:00', to: '19:00' } } })).json.resource;
  const car = (await c.admin('POST', 'admin/resources', { name: 'Firmenwagen Kombi', kind: 'vehicle', location: 'Parkplatz Hof', seats: 5,
    bookers: { all: false, principals: [{ type: 'group', id: 8, label: 'Außendienst' }, { type: 'group', id: 7, label: 'Fuhrpark' }] },
    approval: 'approval', approvers: [{ type: 'group', id: 7, label: 'Fuhrpark' }], rules: { maxMinutes: 1440, horizonDays: 60 } })).json.resource;
  return { room, car };
}

test('resources: the administrator keeps them (checked, admins only); people see only what they may book; GET me features', () => withMail(O, async (host, c) => {
  const { room, car } = await setup(c);
  assert.deepEqual([room.kind, room.approval, room.color, room.address, room.rules.hours], ['room', 'auto', '#B79CFF', `resource-${room.id}@resources.gatecontrol.invalid`, { days: [1, 2, 3, 4, 5], from: '07:00', to: '19:00' }]);
  assert.deepEqual([car.approval, car.approvers.map((p) => p.label), car.rules.maxMinutes, car.bookers.all], ['approval', ['Fuhrpark'], 1440, false]);
  for (const bad of [{ name: '' }, { name: 'X', kind: 'boat' }, { name: 'X', approval: 'approval', approvers: [] }, { name: 'X', rules: { maxMinutes: 5 } },
    { name: 'X', rules: { hours: { days: [8], from: '07:00', to: '19:00' } } }, { name: 'X', rules: { hours: { days: [1], from: '19:00', to: '07:00' } } }, { name: 'X', seats: -1 }]) {
    const r = await c.admin('POST', 'admin/resources', bad);
    assert.deepEqual([r.status, r.json.error.code], [400, 'invalid'], JSON.stringify(bad));
  }
  // only administrators (the app's person gets 403)
  assert.equal((await c.as(ANNA)('GET', 'admin/resources')).status, 403);
  const list = (await c.admin('GET', 'admin/resources')).json.items;
  assert.deepEqual(list.map((x) => x.name), ['Besprechungsraum 1', 'Firmenwagen Kombi']);
  // who may book: everybody the room, the car only Außendienst and Fuhrpark
  const names = async (u) => (await c.as(u)('GET', 'resources')).json.items.map((x) => x.name);
  assert.deepEqual(await names(ANNA), ['Besprechungsraum 1', 'Firmenwagen Kombi']);
  const pub = (await c.as(ANNA)('GET', 'resources')).json.items[1];
  assert.deepEqual([pub.approval, pub.approvers, pub.rules.horizonDays], ['approval', ['Fuhrpark'], 60]);
  assert.ok(!('bookers' in pub), 'who may book stays with the administrator');
  await c.admin('PUT', `admin/resources/${car.id}`, { bookers: { all: false, principals: [{ type: 'user', id: MARC.id, label: 'Marc' }] } });
  assert.deepEqual(await names(ANNA), ['Besprechungsraum 1']);
  assert.equal((await c.as(ANNA)('POST', `resources/${car.id}/book`, { title: 'Kunde', start: at(next(1), 9), end: at(next(1), 10) })).status, 404);
  // GET me: the features; Marc decides on the car's requests
  const f = async (u) => (await c.as(u)('GET', 'me')).json.features;
  for (const x of ['freeBusy', 'calendarSharing', 'resources']) assert.ok((await f(ANNA)).includes(x), x);
  assert.ok(!(await f(ANNA)).includes('bookingRequests'));
  assert.ok((await f(MARC)).includes('bookingRequests'));
  // the administrator switches resources off: 403 feature_off, no feature
  await c.admin('PUT', 'admin/settings', { resources: { enabled: false } });
  const off = await c.as(ANNA)('GET', 'resources');
  assert.deepEqual([off.status, off.json.error.code, off.json.error.feature], [403, 'feature_off', 'resources']);
  assert.ok(!(await f(MARC)).includes('resources') && !(await f(MARC)).includes('bookingRequests'));
  // deleting a resource calls its bookings off
  await c.admin('PUT', 'admin/settings', { resources: { enabled: true } });
  const b = await c.as(ANNA)('POST', `resources/${room.id}/book`, { title: 'Weg damit', start: at(next(2), 9), end: at(next(2), 10) });
  assert.equal(b.json.bookings[0].state, 'confirmed');
  const del = await c.admin('DELETE', `admin/resources/${room.id}`);
  assert.deepEqual(del.json, { ok: true, cancelled: 1 });
  const ev = (await c.as(ANNA)('GET', `events/${b.json.event.eventId}`)).json;
  assert.equal(ev.attendees.find((a) => a.role === 'resource').response, 'declined');
  assert.ok(host.notifications.some((n) => n.topic === 'resource_booking' && n.users[0] === ANNA.id), 'Anna hears of it');
}));

test('booking with automatic answer: confirmed when free and within the rules — conflicts and broken rules are refused by the server', () => withMail(O, async (host, c) => {
  const { room } = await setup(c);
  const anna = c.as(ANNA);
  const marc = c.as(MARC);
  const day = next(3);
  const r = await anna('POST', `resources/${room.id}/book`, { title: 'Projektbesprechung', start: at(day, 10), end: at(day, 11), timeZone: BERLIN });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const bk = r.json.bookings[0];
  assert.deepEqual([bk.state, bk.resource.name, bk.title, bk.violations, bk.eventId === r.json.event.eventId], ['confirmed', 'Besprechungsraum 1', 'Projektbesprechung', [], true]);
  // in Anna's calendar: her event with the room as an attendee that said yes; no mail went to the room
  const ev = r.json.event;
  const att = ev.attendees.find((a) => a.role === 'resource');
  assert.deepEqual([att.email, att.name, att.response, ev.location], [room.address, 'Besprechungsraum 1', 'accepted', 'Besprechungsraum 1, 2. OG']);
  assert.ok(!c.mail.sent.some((m) => JSON.stringify(m.message.to).includes('resources.gatecontrol.invalid')));
  // Marc at the same time: 409 resource_busy with the time in the way (as an attendee of his own event too)
  const busy = await marc('POST', `resources/${room.id}/book`, { title: 'Auch', start: at(day, 10, 30), end: at(day, 11, 30) });
  assert.deepEqual([busy.status, busy.json.error.code, busy.json.error.conflicts], [409, 'resource_busy', [{ start: at(day, 10), end: at(day, 11) }]]);
  const cals = (await marc('GET', 'calendars')).json.calendars;
  const viaEvent = await marc('POST', 'events', { calendarId: cals[0].id, title: 'Team', allDay: false, start: at(day, 10, 30), end: at(day, 11), attendees: [{ email: room.address }] });
  assert.equal(viaEvent.json.error.code, 'resource_busy');
  assert.equal((await marc('GET', 'events', null, { from: at(day, 0), to: at(day, 23) })).json.items.length, 0, 'nothing half-saved');
  // the rules: bookable times (Mon–Fri 7–19), the past, a series
  const late = await marc('POST', `resources/${room.id}/book`, { title: 'Spät', start: at(day, 18), end: at(day, 20) });
  assert.deepEqual([late.json.error.code, late.json.error.violations], ['rule_violation', [{ rule: 'hours', days: [1, 2, 3, 4, 5], from: '07:00', to: '19:00' }]]);
  const sat = await marc('POST', `resources/${room.id}/book`, { title: 'Samstag', start: at(next(6), 10), end: at(next(6), 11) });
  assert.equal(sat.json.error.code, 'rule_violation');
  const past = await marc('POST', `resources/${room.id}/book`, { title: 'Gestern', start: Date.now() - DAY, end: Date.now() - DAY + HOUR });
  assert.deepEqual([past.json.error.code, past.json.error.reason], ['invalid', 'past']);
  const series = await marc('POST', 'events', { calendarId: cals[0].id, title: 'Jour fixe', allDay: false, start: at(day, 14), end: at(day, 15), recurrence: { freq: 'weekly', count: 3 }, attendees: [{ email: room.address }] });
  assert.deepEqual([series.json.error.code, series.json.error.what], ['not_supported', 'resource_series']);
  // free next to it: fine
  const ok = await marc('POST', `resources/${room.id}/book`, { title: 'Danach', start: at(day, 11), end: at(day, 12) });
  assert.equal(ok.json.bookings[0].state, 'confirmed');
  // Anna moves her event onto Marc's time: refused, her booking stays
  const moved = await anna('PATCH', `events/${ev.eventId}`, { start: at(day, 11), end: at(day, 12), scope: 'series' });
  assert.equal(moved.json.error.code, 'resource_busy');
  // Anna moves it earlier: the booking moves along (confirmed again)
  const early = await anna('PATCH', `events/${ev.eventId}`, { start: at(day, 8), end: at(day, 9), scope: 'series' });
  assert.equal(early.status, 200, JSON.stringify(early.json));
  assert.deepEqual(early.json.bookings.map((x) => [x.state, x.start]), [['confirmed', at(day, 8)]]);
  // her bookings; she deletes the event: the room is free again
  const mine = (await anna('GET', 'bookings', null, { state: 'mine' })).json.items;
  assert.deepEqual(mine.map((x) => [x.title, x.state]), [['Projektbesprechung', 'confirmed']]);
  assert.equal((await anna('DELETE', `events/${ev.eventId}`)).status, 200);
  assert.equal((await anna('GET', 'bookings', null, { state: 'mine' })).json.items[0].state, 'cancelled');
  const free = (await anna('GET', 'resources', null, { from: at(day, 0), to: at(day, 24) })).json.items.find((x) => x.id === room.id).busy;
  assert.deepEqual(free.map((x) => [x.start, x.status, x.mine]), [[at(day, 11), 'busy', false]]);
  // Bob may book the room but not a resource that is not there
  const none = await c.as(BOB)('POST', 'events', { calendarId: (await c.as(BOB)('GET', 'calendars')).json.calendars[0].id, title: 'X', allDay: false, start: at(day, 15), end: at(day, 16), attendees: [{ email: 'resource-999@resources.gatecontrol.invalid' }] });
  assert.equal(none.json.error.code, 'not_found');
}));

test('booking requests: to every approver by push and mail, the first decision settles it for all, the booker hears of it; rules, override in the log, conflicts', () => withMail(O, async (host, c) => {
  const { car } = await setup(c);
  const anna = c.as(ANNA);
  const marc = c.as(MARC);
  const bob = c.as(BOB);
  const day = next(4);
  const cals = (await anna('GET', 'calendars')).json.calendars;
  const n0 = host.notifications.length;
  const ev0 = host.events.length;
  // Anna invites the car to her event (the planner): a request
  const r = await anna('POST', 'events', { calendarId: cals[0].id, title: 'Kunde Müller', allDay: false, start: at(day, 12), end: at(day, 15), timeZone: BERLIN,
    attendees: [{ email: car.address, role: 'resource' }] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const bk = r.json.bookings[0];
  assert.deepEqual([bk.state, bk.violations, r.json.event.attendees.find((a) => a.role === 'resource').response], ['pending', [], 'needs_action']);
  // a push to Marc and Bob (not to Anna), a mail from Anna's account to their addresses, the live event
  const push = host.notifications.slice(n0).filter((n) => n.topic === 'resource_request');
  assert.equal(push.length, 1);
  assert.deepEqual([push[0].users.sort(), push[0].title, push[0].data.resources.bookingId], [[MARC.id, BOB.id], 'Buchungsanfrage: Firmenwagen Kombi', bk.id]);
  assert.match(push[0].body, /^Anna · Kunde Müller, /);
  const mail = c.mail.sent.find((m) => /^Buchungsanfrage: Firmenwagen Kombi/.test(m.message.subject));
  assert.ok(mail, 'the mail');
  assert.deepEqual([mail.message.from.address, mail.message.to.map((x) => x.address).sort()], ['anna@gmx.de', ['bob@gmx.de', 'marc@gmx.de']]);
  assert.ok(!mail.message.icalEvent);
  assert.ok(host.events.slice(ev0).some((e) => e.type === 'resources' && e.data.kind === 'request' && e.data.bookingId === bk.id && e.users.includes(MARC.id)));
  // both see it; Anna may not decide
  const open = (await marc('GET', 'bookings')).json;
  assert.deepEqual([open.counts.open, open.items.map((x) => [x.id, x.canDecide, x.booker.name, x.eventId])], [1, [[bk.id, true, 'Anna', null]]]);
  assert.equal((await bob('GET', 'bookings')).json.items.length, 1);
  assert.equal((await anna('GET', 'bookings')).json.items.length, 0);
  assert.equal((await anna('POST', `bookings/${bk.id}/decide`, { decision: 'approve' })).json.error.code, 'forbidden');
  // Marc first: confirmed; Bob after him: 409 already_decided with who and when
  const n1 = host.notifications.length;
  const yes = await marc('POST', `bookings/${bk.id}/decide`, { decision: 'approve', comment: 'Schlüssel liegt am Empfang' });
  assert.deepEqual([yes.status, yes.json.booking.state, yes.json.booking.decidedBy.name, yes.json.booking.override], [200, 'confirmed', 'Marc', false]);
  const late = await bob('POST', `bookings/${bk.id}/decide`, { decision: 'decline' });
  assert.deepEqual([late.status, late.json.error.code, late.json.error.state, late.json.error.decidedBy.name], [409, 'already_decided', 'confirmed', 'Marc']);
  assert.equal((await bob('GET', 'bookings')).json.items.length, 0, 'done for everybody');
  assert.deepEqual((await bob('GET', 'bookings', null, { state: 'done' })).json.items.map((x) => [x.id, x.state, x.canDecide]), [[bk.id, 'confirmed', false]]);
  // Anna: the answer in her calendar and as a push
  const ev = (await anna('GET', `events/${r.json.event.eventId}`)).json;
  assert.equal(ev.attendees.find((a) => a.role === 'resource').response, 'accepted');
  const answer = host.notifications.slice(n1).filter((n) => n.topic === 'resource_booking');
  assert.deepEqual(answer.map((n) => [n.users, n.title]), [[[ANNA.id], 'Firmenwagen Kombi zugesagt']]);
  assert.match(answer[0].body, /Schlüssel liegt am Empfang/);
  // a request that breaks a rule (more than a day): approvers see it, approving needs the override, which is logged
  const long = await anna('POST', `resources/${car.id}/book`, { title: 'Messe Köln', allDay: true, startDate: next(5), endDate: tz.addDays(next(5), 1) });
  const lb = long.json.bookings[0];
  assert.deepEqual([lb.state, lb.violations], ['pending', [{ rule: 'max_duration', limit: 1440 }]]);
  const refused = await bob('POST', `bookings/${lb.id}/decide`, { decision: 'approve' });
  assert.deepEqual([refused.json.error.code, refused.json.error.violations], ['rule_violation', [{ rule: 'max_duration', limit: 1440 }]]);
  const forced = await bob('POST', `bookings/${lb.id}/decide`, { decision: 'approve', override: true });
  assert.deepEqual([forced.json.booking.state, forced.json.booking.override], ['confirmed', true]);
  const logs = (await c.admin('GET', `admin/resources/${car.id}/log`)).json.items;
  const ov = logs.find((x) => x.action === 'confirmed_override');
  assert.deepEqual([ov.user.name, ov.bookingId, ov.detail.violations], ['Bob', lb.id, [{ rule: 'max_duration', limit: 1440 }]]);
  // at the same moment: one decision wins, the other gets already_decided
  const race = (await anna('POST', `resources/${car.id}/book`, { title: 'Gleichzeitig', start: at(next(3), 8), end: at(next(3), 9) })).json.bookings[0];
  const both = await Promise.all([marc('POST', `bookings/${race.id}/decide`, { decision: 'approve' }), bob('POST', `bookings/${race.id}/decide`, { decision: 'decline' })]);
  assert.deepEqual(both.map((x) => x.status).sort(), [200, 409]);
  assert.equal(both.find((x) => x.status === 409).json.error.code, 'already_decided');
  // two requests for the same time: the second cannot be approved once the first is
  const d2 = next(2);
  const a1 = (await anna('POST', `resources/${car.id}/book`, { title: 'Eins', start: at(d2, 9), end: at(d2, 11) })).json.bookings[0];
  const m1 = (await marc('POST', `resources/${car.id}/book`, { title: 'Zwei', start: at(d2, 10), end: at(d2, 12) })).json.bookings[0];
  assert.deepEqual([a1.state, m1.state], ['pending', 'pending']);
  await bob('POST', `bookings/${a1.id}/decide`, { decision: 'approve' });
  const marcView = (await bob('GET', 'bookings')).json.items.find((x) => x.id === m1.id);
  assert.deepEqual(marcView.conflicts, [{ start: at(d2, 9), end: at(d2, 11) }]);
  assert.equal((await bob('POST', `bookings/${m1.id}/decide`, { decision: 'approve' })).json.error.code, 'resource_busy');
  // declined: Marc's event shows the car's no, he hears of it
  const no = await bob('POST', `bookings/${m1.id}/decide`, { decision: 'decline', comment: 'Schon vergeben' });
  assert.equal(no.json.booking.state, 'declined');
  assert.ok(host.notifications.some((n) => n.topic === 'resource_booking' && n.users[0] === MARC.id && n.title === 'Firmenwagen Kombi abgesagt'));
  const mev = (await marc('GET', 'events', null, { from: at(d2, 0), to: at(d2, 24) })).json.items[0];
  assert.equal((await marc('GET', `events/${mev.eventId}`)).json.attendees.find((a) => a.role === 'resource').response, 'declined');
  // a new title does not ask again; a new time does
  await marc('PATCH', `events/${mev.eventId}`, { title: 'Zwei neu', scope: 'series' });
  assert.equal((await marc('GET', 'bookings', null, { state: 'mine' })).json.items.filter((x) => x.state === 'pending').length, 0);
  const again = await marc('PATCH', `events/${mev.eventId}`, { start: at(d2, 13), end: at(d2, 14), scope: 'series' });
  assert.deepEqual(again.json.bookings.map((x) => x.state), ['pending']);
  // Anna calls her confirmed booking off: the car leaves her event
  assert.equal((await anna('DELETE', `bookings/${a1.id}`)).status, 200);
  const aev = (await anna('GET', 'events', null, { from: at(d2, 0), to: at(d2, 24) })).json.items[0];
  assert.equal((await anna('GET', `events/${aev.eventId}`)).json.attendees.length, 0);
  assert.equal((await bob('GET', `bookings/${a1.id}`)).json.state, 'cancelled');
}));

test('free/busy without titles: busy, tentative, private as busy, the person\'s switch, shared calendars instead, external people unknown; suggestions in the working hours', () => withMail(O, async (host, c) => {
  const { room } = await setup(c);
  const anna = c.as(ANNA);
  const marc = c.as(MARC);
  const day = next(4);
  const mc = (await marc('GET', 'calendars')).json.calendars;
  const mk = (title, h1, h2, extra) => marc('POST', 'events', { calendarId: mc[0].id, title, allDay: false, start: at(day, h1), end: at(day, h2), timeZone: BERLIN, ...(extra || {}) });
  await mk('Geheimes Gespräch', 8, 9);
  await mk('Vielleicht Sport', 10, 11, { busy: 'tentative' });
  await mk('Arzttermin', 12, 13, { private: true, busy: 'tentative' });
  await mk('Nur Notiz', 14, 15, { busy: 'free' });
  await c.as(BOB)('POST', `resources/${room.id}/book`, { title: 'Bobs Runde', start: at(day, 9), end: at(day, 10) });
  const q = { from: at(day, 0), to: at(day, 24), attendees: ['marc@gmx.de', 'kunde@mueller.de', room.address] };
  const r = await anna('POST', 'freebusy', q);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const by = Object.fromEntries(r.json.items.map((x) => [x.kind, x]));
  assert.deepEqual(r.json.items.map((x) => [x.kind, x.name, x.state]), [['self', 'Anna', 'ok'], ['person', 'Marc', 'ok'], ['external', 'kunde@mueller.de', 'unknown'], ['resource', 'Besprechungsraum 1', 'ok']]);
  assert.deepEqual(by.person.blocks, [{ start: at(day, 8), end: at(day, 9), status: 'busy' }, { start: at(day, 10), end: at(day, 11), status: 'tentative' }, { start: at(day, 12), end: at(day, 13), status: 'busy' }]);
  assert.deepEqual(by.resource.blocks, [{ start: at(day, 9), end: at(day, 10), status: 'busy' }]);
  const text = JSON.stringify(r.json);
  for (const s of ['Geheimes', 'Sport', 'Arzt', 'Notiz', 'Bobs Runde']) assert.ok(!text.includes(s), `no title: ${s}`);
  // suggestions: 1 h in Anna's working hours (8–18) where Marc and the room are free — tentative counts as taken
  const s = await anna('POST', 'freebusy/suggest', { ...q, duration: 60, from: at(day, 0), to: at(day, 24), limit: 4 });
  assert.deepEqual(s.json.items.map((x) => (x.start - at(day, 0)) / HOUR), [11, 13, 14, 15]);
  assert.deepEqual([s.json.unknown, s.json.timeZone], [['kunde@mueller.de'], BERLIN]);
  // Anna's working hours 9–12 on that day only: one slot left
  await anna('PUT', 'calendar/settings', { workHours: { days: [((tz.weekday(day) + 6) % 7) + 1], from: '09:00', to: '12:00' } });
  assert.deepEqual((await anna('POST', 'freebusy/suggest', { ...q, duration: 60, from: at(day, 0), to: at(day, 24) })).json.items.map((x) => (x.start - at(day, 0)) / HOUR), [11]);
  assert.equal((await anna('PUT', 'calendar/settings', { workHours: { days: [], from: '09:00', to: '12:00' } })).json.error.field, 'workHours');
  // Marc switches free/busy off: unknown for Anna — until he shares a calendar with her (any level)
  await marc('PUT', 'calendar/settings', { freeBusy: false });
  const off = (await anna('POST', 'freebusy', q)).json.items.find((x) => x.kind === 'person');
  assert.deepEqual([off.state, off.blocks], ['unknown', []]);
  await marc('POST', `calendars/${mc[0].id}/shares`, { type: 'user', id: ANNA.id, level: 'freebusy' });
  const shared = (await anna('POST', 'freebusy', q)).json.items.find((x) => x.kind === 'person');
  assert.deepEqual([shared.state, shared.blocks.length], ['ok', 3]);
  // the administrator switches free/busy off
  await c.admin('PUT', 'admin/settings', { calendar: { freeBusy: false } });
  assert.deepEqual([(await anna('POST', 'freebusy', q)).status, (await anna('POST', 'freebusy', q)).json.error.feature], [403, 'freeBusy']);
  assert.equal((await anna('POST', 'freebusy', { from: 2, to: 1 })).status, 403);
}));

test('free/busy of Microsoft 365 colleagues by getSchedule; without the calendar right „unbekannt“, never an error', async () => {
  const PHASE1 = 'openid profile email offline_access User.Read Mail.ReadWrite Mail.Send';
  const st = { granted: `${PHASE1} https://graph.microsoft.com/Calendars.ReadWrite`, asked: [] };
  const jwt = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
  const json = (status, body) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const day = next(3);
  const fetch = async (url, o) => {
    const u = new URL(url);
    if (u.host === 'login.microsoftonline.com') return json(200, { access_token: 'AT', refresh_token: 'RT', expires_in: 3600, scope: st.granted, id_token: jwt({ email: 'anna@firma.example', tid: 'tenant-firma', name: 'Anna' }) });
    const p = u.pathname.replace('/v1.0', '');
    if (p === '/me/calendar/getSchedule') {
      if (!/Calendars\.ReadWrite/.test(st.granted)) return json(403, { error: { code: 'ErrorAccessDenied' } });
      st.asked.push(o.json);
      const iso = (ms) => new Date(ms).toISOString().replace('Z', '0000');
      return json(200, { value: o.json.schedules.map((e) => (e === 'kollegin@firma.example'
        ? { scheduleId: e, scheduleItems: [{ status: 'busy', subject: 'Vorstand', start: { dateTime: iso(at(day, 9)), timeZone: 'UTC' }, end: { dateTime: iso(at(day, 10)), timeZone: 'UTC' } },
          { status: 'tentative', start: { dateTime: iso(at(day, 14)), timeZone: 'UTC' }, end: { dateTime: iso(at(day, 15)), timeZone: 'UTC' } },
          { status: 'free', start: { dateTime: iso(at(day, 16)), timeZone: 'UTC' }, end: { dateTime: iso(at(day, 17)), timeZone: 'UTC' } }] }
        : { scheduleId: e, error: { message: 'not found', responseCode: 'ErrorMailRecipientNotFound' } })) });
    }
    if (p === '/me/calendars') return json(200, { value: [] });
    return json(404, { error: { code: 'ErrorItemNotFound' } });
  };
  for (const scope of ['with', 'without']) {
    if (scope === 'without') st.granted = PHASE1;
    await withMail({ gatecontrol: '1.219.0', fetch, settings: { microsoft: { registration: 'custom', customClientId: '11111111-2222-3333-4444-555555555555' } } }, async (host, c) => {
      const anna = c.as(ANNA);
      const acc = await anna('POST', 'accounts/microsoft', { code: 'X', codeVerifier: 'v'.repeat(43), redirectUri: 'msauth://com.gatecontrol.client/abc%3D' });
      assert.equal(acc.status, 200, JSON.stringify(acc.json));
      const r = await anna('POST', 'freebusy', { from: at(day, 0), to: at(day, 24), attendees: ['kollegin@firma.example', 'weg@firma.example', 'privat@gmail.com'] });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      const rows = r.json.items.slice(1).map((x) => [x.kind, x.email, x.state, x.blocks.length]);
      if (scope === 'with') {
        assert.deepEqual(rows, [['microsoft', 'kollegin@firma.example', 'ok', 2], ['microsoft', 'weg@firma.example', 'unknown', 0], ['external', 'privat@gmail.com', 'unknown', 0]]);
        assert.deepEqual(r.json.items[1].blocks.map((b) => b.status), ['busy', 'tentative']);
        assert.ok(!JSON.stringify(r.json).includes('Vorstand'));
        assert.deepEqual(st.asked[0].schedules, ['kollegin@firma.example', 'weg@firma.example'], 'only the domain of the account');
      } else {
        assert.deepEqual(rows, [['microsoft', 'kollegin@firma.example', 'unknown', 0], ['microsoft', 'weg@firma.example', 'unknown', 0], ['external', 'privat@gmail.com', 'unknown', 0]]);
      }
    });
  }
});

test('shared calendars: free/busy, read and edit for a person, a group; private events stay „Gebucht“; „Mit mir geteilt“ and „hat angenommen“; only the owner shares', () => withMail(O, async (host, c) => {
  for (const u of [ANNA, MARC, BOB]) await c.addGmx(u);
  const anna = c.as(ANNA);
  const marc = c.as(MARC);
  const bob = c.as(BOB);
  const day = next(2);
  const cal = (await anna('GET', 'calendars')).json.calendars[0];
  const ev = (await anna('POST', 'events', { calendarId: cal.id, title: 'Zahnarzt', location: 'Praxis', description: 'Füllung', allDay: false, start: at(day, 9), end: at(day, 10), timeZone: BERLIN })).json.event;
  const secret = (await anna('POST', 'events', { calendarId: cal.id, title: 'Bewerbung', location: 'Konkurrenz', private: true, allDay: false, start: at(day, 14), end: at(day, 15), timeZone: BERLIN })).json.event;
  const range = { from: at(day, 0), to: at(day, 24) };
  // nothing for Marc yet
  assert.deepEqual((await marc('GET', 'shared')).json.items, []);
  assert.equal((await marc('GET', `events/${ev.eventId}`)).status, 404);
  // free/busy
  const sh = await anna('POST', `calendars/${cal.id}/shares`, { type: 'user', id: MARC.id, level: 'freebusy' });
  assert.deepEqual([sh.json.share.name, sh.json.share.level, sh.json.share.state], ['Marc', 'freebusy', 'pending']);
  assert.ok(host.notifications.some((n) => n.topic === 'calendar_share' && n.users[0] === MARC.id));
  const list = (await marc('GET', 'shared')).json.items;
  assert.deepEqual(list.map((x) => [x.id, x.name, x.owner.name, x.level, x.visible, x.accepted]), [[cal.id, 'Privat', 'Anna', 'freebusy', false, false]]);
  assert.deepEqual((await marc('GET', 'calendars')).json.shared.map((x) => x.id), [cal.id]);
  assert.equal((await marc('GET', 'events', null, range)).json.items.length, 0, 'hidden until shown');
  await marc('PATCH', `shared/${cal.id}`, { visible: true });
  assert.equal((await anna('GET', `calendars/${cal.id}/shares`)).json.items[0].state, 'accepted', 'hat angenommen');
  let items = (await marc('GET', 'events', null, range)).json.items;
  assert.deepEqual(items.map((x) => [x.title, x.eventId, x.location, x.shared]), [['Gebucht', null, null, 'freebusy'], ['Gebucht', null, null, 'freebusy']]);
  assert.ok(!JSON.stringify(items).includes('Zahnarzt') && !JSON.stringify(items).includes('Bewerbung'));
  assert.equal((await marc('GET', `events/${ev.eventId}`)).status, 404);
  // read: title, place and times — the private one stays „Gebucht“ and never opens
  await anna('PATCH', `calendars/${cal.id}/shares/${sh.json.share.id}`, { level: 'read' });
  items = (await marc('GET', 'events', null, range)).json.items;
  assert.deepEqual(items.map((x) => [x.title, x.location, x.shared, x.eventId != null]), [['Zahnarzt', 'Praxis', 'read', true], ['Gebucht', null, 'read', false]]);
  assert.ok(!JSON.stringify(items).includes('Bewerbung') && !JSON.stringify(items).includes('Konkurrenz'));
  const read = (await marc('GET', `events/${ev.eventId}`)).json;
  assert.deepEqual([read.title, read.location, read.description, read.canEdit, read.readOnly, read.shared], ['Zahnarzt', 'Praxis', '', false, true, 'read']);
  assert.equal((await marc('GET', `events/${secret.eventId}`)).status, 404);
  assert.equal((await marc('PATCH', `events/${ev.eventId}`, { title: 'Weg', scope: 'series' })).json.error.code, 'read_only');
  assert.equal((await marc('POST', 'events', { calendarId: cal.id, title: 'Rein', allDay: false, start: at(day, 16), end: at(day, 17) })).json.error.code, 'read_only');
  // write: new events and changes in Anna's calendar (as hers), never attendees, never the private one
  await anna('PATCH', `calendars/${cal.id}/shares/${sh.json.share.id}`, { level: 'write' });
  const made = await marc('POST', 'events', { calendarId: cal.id, title: 'Abholen', allDay: false, start: at(day, 16), end: at(day, 17), timeZone: BERLIN });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  assert.equal((await anna('GET', 'events', null, range)).json.items.filter((x) => x.title === 'Abholen').length, 1, 'in Anna\'s calendar');
  assert.equal((await marc('POST', 'events', { calendarId: cal.id, title: 'Mit', allDay: false, start: at(day, 18), end: at(day, 19), attendees: [{ email: 'x@example.com' }] })).json.error.what, 'shared_attendees');
  assert.equal((await marc('PATCH', `events/${ev.eventId}`, { title: 'Zahnarzt (verschoben)', scope: 'series' })).status, 200);
  assert.equal((await anna('GET', `events/${ev.eventId}`)).json.title, 'Zahnarzt (verschoben)');
  assert.equal((await marc('PATCH', `events/${secret.eventId}`, { title: 'X', scope: 'series' })).status, 404);
  assert.equal((await marc('DELETE', `events/${made.json.event.eventId}`)).status, 200);
  // a group (Bob through „Außendienst“? no — through „Fuhrpark“): the group's members see it
  assert.equal((await bob('GET', 'shared')).json.items.length, 0);
  const g = await anna('POST', `calendars/${cal.id}/shares`, { type: 'group', id: 7, level: 'read' });
  assert.deepEqual([g.json.share.type, g.json.share.name, g.json.share.state, g.json.share.members], ['group', 'Fuhrpark', 'group', 2]);
  assert.deepEqual((await bob('GET', 'shared')).json.items.map((x) => [x.level, x.via, x.group]), [['read', 'group', 'Fuhrpark']]);
  assert.equal((await marc('GET', 'shared')).json.items[0].level, 'write', 'the higher of person and group');
  // only the owner: Marc cannot see or change Anna's shares; not to oneself; a GateControl calendar only
  assert.equal((await marc('GET', `calendars/${cal.id}/shares`)).status, 404);
  assert.equal((await anna('POST', `calendars/${cal.id}/shares`, { type: 'user', id: ANNA.id, level: 'read' })).json.error.code, 'invalid');
  assert.equal((await anna('POST', `calendars/${cal.id}/shares`, { type: 'user', id: MARC.id, level: 'owner' })).json.error.field, 'level');
  // principals to share with: people who may use Mail and groups by name — never addresses
  const p = (await anna('GET', 'principals', null, { q: 'ma' })).json.items;
  assert.deepEqual(p.map((x) => [x.type, x.name]), [['user', 'Marc']]);
  assert.ok(!JSON.stringify(p).includes('@'));
  assert.deepEqual((await anna('GET', 'principals', null, { q: 'fuhr' })).json.items.map((x) => [x.type, x.id]), [['group', 7]]);
  // the share goes: gone for Marc
  await anna('DELETE', `calendars/${cal.id}/shares/${sh.json.share.id}`);
  assert.deepEqual((await marc('GET', 'shared')).json.items.map((x) => x.via), ['group']);
  // a change in the calendar reaches who it is shared with (live)
  const e0 = host.events.length;
  await anna('PATCH', `events/${ev.eventId}`, { title: 'Neu', scope: 'series' });
  assert.ok(host.events.slice(e0).some((e) => e.type === 'calendar' && e.data.kind === 'changed' && e.data.calendarId === cal.id && e.users.includes(BOB.id)));
  // the administrator switches sharing off
  await c.admin('PUT', 'admin/settings', { calendar: { sharing: false } });
  assert.equal((await bob('GET', 'shared')).json.error.feature, 'sharing');
  assert.equal((await bob('GET', 'events', null, range)).json.items.length, 0);
}));

test('rights like the mail: no seat, no licence → no resources, no free/busy, no shares', () => withMail({ ...O, license: { tier: 'family', seats: { included: 1, family: 0, business: 0 } } }, async (host, c) => {
  assert.equal((await c.as(ANNA)('GET', 'me')).status, 200);
  for (const [m, p, b] of [['GET', 'resources'], ['POST', 'freebusy', { from: 1, to: 2 }], ['GET', 'shared'], ['GET', 'bookings']]) {
    const r = await c.as(MARC)(m, p, b);
    assert.deepEqual([r.status, r.json.error.code], [403, 'no_seat'], p);
  }
}));
