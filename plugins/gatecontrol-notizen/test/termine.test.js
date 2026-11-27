'use strict';

// 1.9.0 — „Termin“ (server/termine.js): a real event in a calendar of the person in Mail, stored only there. The
// calendars and why there may be none, POST / PATCH / DELETE events handed to Mail (the default calendar, an hour, all
// day, the place, the reminder of the calendar, a series, the same clientId once), and the overview: today's events under
// „Termine heute“, the coming ones mixed into „Demnächst“ and „Geplant“, never overdue, without a check box, a calendar
// switched on or off in „Quellen“ (subscribed ones and „Aufgaben“ start hidden). First against a stand-in of Mail, then
// against the real Mail plugin in both directions.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { withHost, fakeSource, item, ANNA, MARC, LENA, clock, T0, PLUGINS } = require('./helpers');
const { createHost } = require('../../../tools/testing/mock-host');
const manifest = require('../plugin.json');

const MAIL = 'gatecontrol-mail';
const SCHULE = 'gatecontrol-schule';
const HUB = 'gatecontrol-notizen';
const at = (s) => Date.parse(s);
const { CALS, eventItem, fakeMail } = require('./termine-helpers');

const sourcesWith = (mail) => PLUGINS.map((p) => (p === MAIL && mail ? mail : fakeSource(p)));
const sec = (v, id) => v.sections.find((s) => s.id === id).items;
const titles = (v, id) => sec(v, id).map((x) => x.title);

test('plugin.json: calendar_list of Mail is the one new permission; the feature flag', async () => {
  assert.equal(manifest.version, '1.9.0');
  for (const s of ['calendar_list', 'calendar_add', 'calendar_update', 'calendar_delete', 'todo_items']) assert.ok(manifest.permissions.services.includes(`${MAIL}:${s}`), s);
  const h = await withHost({});
  try { assert.ok((await h.ok(ANNA, 'GET', 'me')).features.includes('calendarEvents')); } finally { await h.close(); }
});

test('me.events and GET events/calendars: no Mail, an older Mail, calendars off for the person, nothing to write into — and the calendars with what the overview shows', async () => {
  // no Mail with the services (the stand-ins of the other tests): no_mail
  let h = await withHost({});
  try {
    assert.deepEqual((await h.ok(ANNA, 'GET', 'me')).events, { available: false, reason: 'no_mail' });
    const c = await h.ok(ANNA, 'GET', 'events/calendars');
    assert.deepEqual([c.state, c.reason, c.calendars, c.defaultId], ['none', 'no_mail', [], null]);
    const r = await h.call(ANNA, 'POST', 'events', { title: 'Zahnarzt', date: '2026-11-09', time: '16:30' });
    assert.deepEqual([r.status, r.json], [503, { ok: false, code: 'unavailable', reason: 'no_mail' }]);
  } finally { await h.close(); }
  const { m, source } = fakeMail();
  h = await withHost({ sources: sourcesWith(source) });
  try {
    // Mail before 1.18.0 refuses the list to the hub
    m.old = true;
    assert.deepEqual((await h.ok(ANNA, 'GET', 'me')).events, { available: false, reason: 'mail_old' });
    assert.equal((await h.ok(ANNA, 'GET', 'events/calendars')).reason, 'mail_old');
    const old = await h.call(MARC, 'POST', 'events', { title: 'Zahnarzt', date: '2026-11-09', time: '16:30' });
    assert.deepEqual([old.status, old.json.reason], [503, 'mail_old']);
    m.old = false;
    // the calendars are off for the person
    for (const reason of ['feature_off', 'not_allowed', 'not_licensed', 'no_seat']) {
      m.reason = reason;
      clock.set(clock.now() + 11 * 60000);
      assert.deepEqual((await h.ok(ANNA, 'GET', 'me')).events, { available: false, reason });
      assert.deepEqual([(await h.ok(ANNA, 'GET', 'events/calendars')).state, (await h.ok(ANNA, 'GET', 'events/calendars')).reason], ['none', reason]);
    }
    m.reason = null;
    clock.set(clock.now() + 11 * 60000);
    assert.deepEqual((await h.ok(ANNA, 'GET', 'me')).events, { available: true, reason: null });
    const c = await h.ok(ANNA, 'GET', 'events/calendars');
    assert.deepEqual([c.state, c.reason, c.defaultId, c.reminders, c.timeZone], ['ok', null, 7, { timed: 15, allDay: 360 }, 'Europe/Berlin']);
    assert.deepEqual(c.calendars.map((x) => [x.id, x.key, x.name, x.kind, x.writable, x.target, x.isDefault, x.area, x.shown]), [
      [7, 'cal:7', 'Privat', 'own', true, true, true, 'private', true], [8, 'cal:8', 'Firma', 'own', true, true, false, 'work', true],
      [9, 'cal:9', 'Feiertage', 'subscribed', false, false, false, 'private', false], [10, 'cal:10', 'Aufgaben', 'tasks', true, false, false, 'private', false],
      [null, 'overlay:familie', 'Familie', 'family', false, false, false, 'private', true]]);
    assert.ok(!('account' in c.calendars[0]), 'only what the picker needs');
    // the person's choices in „Quellen“
    await h.ok(ANNA, 'PUT', 'prefs', { groups: { [`${MAIL}|cal:9`]: 'show', [`${MAIL}|cal:8`]: 'hide' } });
    const c2 = await h.ok(ANNA, 'GET', 'events/calendars');
    assert.deepEqual(c2.calendars.map((x) => x.shown), [true, false, true, false, true]);
    assert.deepEqual((await h.ok(MARC, 'GET', 'events/calendars')).calendars.map((x) => x.shown), [true, true, false, false, true], 'everyone their own');
    // asked at most once a minute per person
    assert.equal(m.calls.filter((x) => x.name === 'calendar_list' && x.user === MARC.id).length, 1);
    await h.ok(MARC, 'GET', 'events/calendars');
    assert.equal(m.calls.filter((x) => x.name === 'calendar_list' && x.user === MARC.id).length, 1);
    // only calendars that cannot take an event: no_calendar
    m.calendars = CALS.filter((x) => x.kind !== 'own');
    clock.set(clock.now() + 11 * 60000);
    assert.deepEqual((await h.ok(ANNA, 'GET', 'me')).events, { available: false, reason: 'no_calendar' });
    // Mail does not answer: the list says so, „me“ does not hide the feature for that
    m.down = true;
    clock.set(clock.now() + 11 * 60000);
    assert.deepEqual((await h.ok(ANNA, 'GET', 'me')).events, { available: true, reason: null });
    assert.equal((await h.ok(ANNA, 'GET', 'events/calendars')).reason, 'unreachable');
  } finally { await h.close(); clock.set(T0); }
});

test('POST events: an hour by default, „bis“, over midnight, all day, the place, the reminder, a series, a chosen calendar; the same clientId once; what Mail refuses', async () => {
  const { m, source } = fakeMail();
  const h = await withHost({ sources: sourcesWith(source) });
  try {
    const add = (b) => h.ok(ANNA, 'POST', 'events', b);
    const last = () => [...m.events.values()].at(-1);
    // a time: an hour, the default calendar and the calendar's own reminder (nothing sent)
    const a = await add({ title: 'Fashion Outlet', date: '2026-12-04', time: '14:00', location: 'Fashion Outlet, Halle 2' });
    let ev = last();
    assert.deepEqual([ev.title, ev.allDay, ev.start, ev.end, ev.location, ev.calendarId, 'reminder' in ev, 'recurrence' in ev],
      ['Fashion Outlet', false, at('2026-12-04T13:00:00Z'), at('2026-12-04T14:00:00Z'), 'Fashion Outlet, Halle 2', 7, false, false]);
    assert.match(ev.key, /^event:[0-9a-f]{24}$/);
    assert.deepEqual([a.event, a.clientId, a.replayed], [{ id: ev.id, calendarId: 7 }, undefined, undefined]);
    // the answer carries the item as the overview shows it — and the overview has it at once
    assert.deepEqual(a.items.map((x) => [x.type, x.kind, x.title, x.due, x.canComplete, x.overdue, x.event.location, x.event.end, x.event.calendar, x.event.eventId, x.source.open]),
      [['source', 'event', 'Fashion Outlet', { date: '2026-12-04', time: '14:00' }, false, false, 'Fashion Outlet, Halle 2', { date: '2026-12-04', time: '15:00' },
        { key: 'cal:7', name: 'Privat', color: '#4F8DF5', kind: 'own' }, ev.id, { plugin: MAIL, route: 'event/' + ev.id }]]);
    assert.deepEqual(titles(await h.ok(ANNA, 'GET', 'views/planned'), 'later'), ['Fashion Outlet']);
    // „14 bis 16 Uhr“, „22 bis 1 Uhr“
    await add({ title: 'Kino', date: '2026-12-04', time: '14:00', endTime: '16:00' });
    assert.equal(last().end - last().start, 2 * 3600000);
    await add({ title: 'Feier', date: '2026-12-04', time: '22:00', endTime: '01:00' });
    assert.deepEqual([last().start, last().end], [at('2026-12-04T21:00:00Z'), at('2026-12-05T00:00:00Z')]);
    // no time: all day; over days
    await add({ title: 'Einkaufen', date: '2026-12-04' });
    ev = last();
    assert.deepEqual([ev.allDay, ev.startsAt, ev.endsAt, ev.start], [true, '2026-12-04', undefined, undefined]);
    await add({ title: 'Urlaub', date: '2026-12-04', endDate: '2026-12-06', allDay: true });
    assert.deepEqual([last().startsAt, last().endsAt], ['2026-12-04', '2026-12-06']);
    // a chosen reminder, none; a chosen calendar
    await add({ title: 'A', date: '2026-12-04', time: '09:00', reminder: 60, calendarId: 8 });
    assert.deepEqual([last().reminder, last().calendarId], [60, 8]);
    await add({ title: 'B', date: '2026-12-04', time: '09:00', reminder: false });
    assert.equal(last().reminder, false);
    // the rules of the quick entry as a series
    await add({ title: 'Chor', date: '2026-12-04', time: '19:00', repeat: { type: 'weekly', interval: 1, days: [5] } });
    assert.deepEqual(last().recurrence, { freq: 'weekly', byDay: ['FR'] });
    await add({ title: 'Miete', date: '2026-12-01', repeat: { type: 'monthly', interval: 3 } });
    assert.deepEqual(last().recurrence, { freq: 'monthly', interval: 3 });
    // a device sends the same create twice (offline): one event
    const c1 = await add({ title: 'Elternabend', date: '2026-11-10', time: '19:00', clientId: 'c0ffee00-aaaa-bbbb' });
    const n = m.events.size;
    const c2 = await add({ title: 'Elternabend', date: '2026-11-10', time: '19:00', clientId: 'c0ffee00-aaaa-bbbb' });
    assert.deepEqual([c1.clientId, c1.replayed, c2.clientId, c2.replayed, c2.event.id, m.events.size], ['c0ffee00-aaaa-bbbb', undefined, 'c0ffee00-aaaa-bbbb', true, c1.event.id, n]);
    assert.equal(last().key, 'event:c0ffee00-aaaa-bbbb');
    assert.equal(c2.items.length, 1);
    // another person's same clientId is another event
    const o = await h.ok(MARC, 'POST', 'events', { title: 'Elternabend', date: '2026-11-10', time: '19:00', clientId: 'c0ffee00-aaaa-bbbb' });
    assert.notEqual(o.event.id, c1.event.id);
    // input
    const bad = async (b, field) => { const r = await h.call(ANNA, 'POST', 'events', { title: 'x', date: '2026-12-04', ...b }); assert.deepEqual([r.status, r.json.code, r.json.field], [400, 'invalid', field], JSON.stringify(b)); };
    await bad({ title: '' }, 'title');
    await bad({ title: 'x'.repeat(256) }, 'title');
    await bad({ date: '4.12.2026' }, 'date');
    await bad({ date: '2026-02-30' }, 'date');
    await bad({ time: '25:00' }, 'time');
    await bad({ time: '10:00', endTime: 'spät' }, 'endTime');
    await bad({ allDay: true, time: '10:00' }, 'allDay');
    await bad({ allDay: false }, 'time');
    await bad({ endDate: '2026-12-03' }, 'endDate');
    await bad({ endDate: '2026-12-20' }, 'endDate');
    await bad({ location: 'x'.repeat(256) }, 'location');
    await bad({ reminder: -5 }, 'reminder');
    await bad({ reminder: 'bald' }, 'reminder');
    await bad({ repeat: { type: 'after', interval: 3 } }, 'repeat');
    await bad({ repeat: { type: 'stündlich' } }, 'repeat');
    await bad({ calendarId: 'Privat' }, 'calendarId');
    await bad({ clientId: 'kurz' }, 'clientId');
    assert.equal(m.events.size, n + 1, 'nothing reached Mail');
    // what Mail says: no such calendar, a refusal for the person, no answer
    let r = await h.call(ANNA, 'POST', 'events', { title: 'x', date: '2026-12-04', calendarId: 9 });
    assert.deepEqual([r.status, r.json], [404, { ok: false, code: 'not_found', field: 'calendarId' }]);
    r = await h.call(ANNA, 'POST', 'events', { title: 'kaputt', date: '2026-12-04' });
    assert.deepEqual([r.status, r.json.code], [400, 'invalid']);
    m.reason = 'no_seat';
    r = await h.call(ANNA, 'POST', 'events', { title: 'x', date: '2026-12-04' });
    assert.deepEqual([r.status, r.json], [503, { ok: false, code: 'unavailable', reason: 'no_seat' }]);
    m.reason = null;
    m.down = true;
    r = await h.call(ANNA, 'POST', 'events', { title: 'x', date: '2026-12-04', clientId: 'retry-me-0001' });
    assert.deepEqual([r.status, r.json], [503, { ok: false, code: 'unavailable', reason: 'unreachable' }]);
    m.down = false;
    clock.set(clock.now() + 61000);
    // … and the device's second try makes it
    assert.equal((await add({ title: 'x', date: '2026-12-04', clientId: 'retry-me-0001' })).replayed, undefined);
    // a person who only looks (the portal without a login) writes nothing
    const guest = await h.host.request({ method: 'POST', path: 'events', body: { title: 'x', date: '2026-12-04' }, query: {}, user: { ...ANNA, portal: true, loggedIn: false } });
    assert.equal(guest.status, 403);
  } finally { await h.close(); clock.set(T0); }
});

test('PATCH and DELETE events: only what is given goes to Mail; the overview follows at once; an event of Mail\'s own is not found', async () => {
  const { m, source } = fakeMail();
  const h = await withHost({ sources: sourcesWith(source) });
  try {
    const a = await h.ok(ANNA, 'POST', 'events', { title: 'Zahnarzt', date: '2026-11-08', time: '16:30', location: 'Praxis am Markt' });
    const id = a.event.id;
    assert.deepEqual(titles(await h.ok(ANNA, 'GET', 'views/myday'), 'events'), ['Zahnarzt']);
    // the title only
    let r = await h.ok(ANNA, 'PATCH', 'events/' + id, { title: 'Zahnärztin' });
    assert.deepEqual(Object.keys(m.calls.at(-1).payload).sort(), ['eventId', 'items', 'lang', 'title', 'userId']);
    assert.deepEqual(r.items.map((x) => x.title), ['Zahnärztin']);
    // moved to tomorrow, the place gone, all day
    r = await h.ok(ANNA, 'PATCH', 'events/' + id, { date: '2026-11-09', time: '10:00', endTime: '10:30', location: null });
    assert.deepEqual([m.events.get(id).start, m.events.get(id).end, m.events.get(id).location], [at('2026-11-09T09:00:00Z'), at('2026-11-09T09:30:00Z'), undefined]);
    let md = await h.ok(ANNA, 'GET', 'views/myday');
    assert.deepEqual([titles(md, 'events'), titles(md, 'upcoming')], [[], ['Zahnärztin']]);
    r = await h.ok(ANNA, 'PATCH', 'events/' + id, { date: '2026-11-09', repeat: { type: 'daily', interval: 2 }, reminder: 30 });
    assert.deepEqual([m.events.get(id).allDay, m.events.get(id).startsAt, m.events.get(id).recurrence, m.events.get(id).reminder], [true, '2026-11-09', { freq: 'daily', interval: 2 }, 30]);
    await h.ok(ANNA, 'PATCH', 'events/' + id, { repeat: null });
    assert.equal(m.events.get(id).recurrence, undefined);
    // a time without its date, a repeat without a date: refused
    for (const b of [{ time: '11:00' }, { repeat: { type: 'daily', interval: 1 } }]) assert.equal((await h.call(ANNA, 'PATCH', 'events/' + id, b)).json.field, 'date', JSON.stringify(b));
    // not the person's, not one the hub made, no number
    assert.equal((await h.call(MARC, 'PATCH', 'events/' + id, { title: 'x' })).status, 404);
    assert.equal((await h.call(ANNA, 'PATCH', 'events/4711', { title: 'x' })).status, 404);
    assert.equal((await h.call(ANNA, 'DELETE', 'events/abc')).status, 404);
    assert.deepEqual(await h.ok(MARC, 'DELETE', 'events/' + id), { ok: true, removed: false });
    assert.ok(m.events.has(id));
    // deleted: gone in Mail and on the overview, at once; again: nothing to remove
    assert.deepEqual(await h.ok(ANNA, 'DELETE', 'events/' + id), { ok: true, removed: true });
    md = await h.ok(ANNA, 'GET', 'views/myday');
    assert.deepEqual([m.events.has(id), titles(md, 'upcoming')], [false, []]);
    assert.deepEqual(await h.ok(ANNA, 'DELETE', 'events/' + id), { ok: true, removed: false });
  } finally { await h.close(); clock.set(T0); }
});

test('the overview: today under „Termine heute“, the next 14 days in „Demnächst“, „Geplant“ by day — no check box, never overdue; calendars switched in „Quellen“', async () => {
  const h = await withHost({});
  try {
    const t1 = await h.ok(ANNA, 'POST', 'tasks', { title: 'Paket abholen', due: { date: '2026-11-08' } });
    await h.ok(ANNA, 'POST', 'tasks', { title: 'Reifen wechseln', due: { date: '2026-11-10' } });
    assert.ok(t1.task.id);
    const res = await h.push(MAIL, { upsert: [
      eventItem('ev:1', { title: 'Zahnarzt', due: '2026-11-08T16:30:00+01:00', end: '2026-11-08T17:15:00+01:00', location: 'Praxis am Markt', eventId: 1 }),
      eventItem('ev:2', { title: 'Frühsport', due: '2026-11-08T07:00:00+01:00', end: '2026-11-08T08:00:00+01:00', eventId: 2 }),      // over since 08:00
      eventItem('ev:3', { title: 'Fashion Outlet', due: '2026-11-13T14:00:00+01:00', end: '2026-11-13T15:00:00+01:00', location: 'Fashion Outlet', eventId: 3 }),
      eventItem('ov:familie:f1:2026-11-15', { title: 'Geburtstag Oma', due: '2026-11-15', cal: 'overlay:familie' }),
      eventItem('ev:5', { title: 'Messe', due: '2026-11-06', endDate: '2026-11-09', eventId: 5, cal: 'cal:8' }),                       // began on Friday, runs till Monday
      eventItem('ev:6', { title: 'In drei Wochen', due: '2026-11-29T10:00:00+01:00', end: '2026-11-29T11:00:00+01:00', eventId: 6 }),
      eventItem('ev:7', { title: 'Buß- und Bettag', due: '2026-11-18', eventId: 7, cal: 'cal:9' }),                                    // subscribed
      eventItem('ev:8', { title: 'Mülltonne rausstellen', due: '2026-11-08T18:00:00+01:00', end: '2026-11-08T18:30:00+01:00', eventId: 8, cal: 'cal:10' }), // „Aufgaben“
      eventItem('ev:9', { title: 'Marcs Termin', due: '2026-11-08T12:00:00+01:00', end: '2026-11-08T13:00:00+01:00', eventId: 9, users: [MARC.id] }),
    ] });
    assert.deepEqual([res.ok, res.accepted, res.rejected], [true, 9, []]);
    await h.push(SCHULE, { upsert: [item(SCHULE, 'event:1', { kind: 'event', title: 'Elternabend', due: '2026-11-08T19:00:00+01:00', allDay: false, canComplete: false }),
      item(SCHULE, 'event:2', { kind: 'event', title: 'Schulfest', due: '2026-11-12', canComplete: false })] });
    let md = await h.ok(ANNA, 'GET', 'views/myday');
    assert.deepEqual(titles(md, 'events'), ['Frühsport', 'Zahnarzt', 'Elternabend']);
    assert.deepEqual(titles(md, 'today'), ['Paket abholen']);
    assert.deepEqual(titles(md, 'overdue'), []);
    assert.deepEqual(titles(md, 'upcoming'), ['Reifen wechseln', 'Fashion Outlet', 'Geburtstag Oma'], 'mixed by date; a school event to come stays out as before');
    const z = sec(md, 'events').find((x) => x.title === 'Zahnarzt');
    assert.deepEqual([z.kind, z.canComplete, z.overdue, z.done, z.subtitle, z.due, z.show, z.allDay, z.source.open, z.group],
      ['event', false, false, false, 'Praxis am Markt', { date: '2026-11-08', time: '16:30' }, { date: '2026-11-08', time: '16:30' }, false, { plugin: MAIL, route: 'event/1' }, { id: 'cal:7', label: 'Privat' }]);
    assert.deepEqual(z.event, { end: { date: '2026-11-08', time: '17:15' }, location: 'Praxis am Markt', calendar: { key: 'cal:7', name: 'Privat', color: '#4F8DF5', kind: 'own' }, eventId: 1, recurring: false, writable: true });
    assert.equal(sec(md, 'events').find((x) => x.title === 'Frühsport').overdue, false, 'over, not overdue');
    assert.equal(sec(md, 'events').find((x) => x.title === 'Elternabend').event, undefined, 'only the events of a calendar carry `event`');
    const oma = sec(md, 'upcoming').find((x) => x.title === 'Geburtstag Oma');
    assert.deepEqual([oma.allDay, oma.event.end, oma.event.eventId, oma.event.calendar.kind, oma.event.writable, oma.source.open.route], [true, null, null, 'family', false, 'calendar/2026-11-15']);
    // the work area: the trip that began on Friday shows today, all day, till Monday
    const work = await h.ok(ANNA, 'GET', 'views/myday', undefined, { area: 'work' });
    assert.deepEqual(sec(work, 'events').map((x) => [x.title, x.show, x.due, x.overdue, x.event.end]), [['Messe', { date: '2026-11-08', time: null }, { date: '2026-11-06', time: null }, false, { date: '2026-11-09', time: null }]]);
    // „Geplant“: by day, the far one under „Später“
    const pl = await h.ok(ANNA, 'GET', 'views/planned');
    assert.deepEqual(Object.fromEntries(pl.sections.map((s) => [s.id, s.items.map((x) => x.title)])),
      { overdue: [], today: ['Frühsport', 'Zahnarzt', 'Elternabend', 'Paket abholen'], tomorrow: [], week: ['Reifen wechseln', 'Schulfest', 'Fashion Outlet', 'Geburtstag Oma'], later: ['In drei Wochen'] });
    // the menu: events count for „Mein Tag“ and „Geplant“, not as to-dos of Mail; the source „Mail“ lists none
    const nav = await h.ok(ANNA, 'GET', 'nav');
    assert.deepEqual([nav.smart.myday, nav.smart.planned, nav.sources.find((s) => s.plugin === MAIL).open], [4, 9, 0]);
    assert.deepEqual((await h.ok(ANNA, 'GET', 'views/source:' + MAIL)).sections, []);
    // an event has no check box: completing it is refused
    assert.equal((await h.call(ANNA, 'POST', `items/${z.id}/complete`, { done: true })).status, 403);
    // „Quellen“: the subscribed calendar and „Aufgaben“ on, the own one off
    await h.ok(ANNA, 'PUT', 'prefs', { groups: { [`${MAIL}|cal:9`]: 'show', [`${MAIL}|cal:10`]: 'show', [`${MAIL}|overlay:familie`]: 'hide' } });
    md = await h.ok(ANNA, 'GET', 'views/myday');
    assert.deepEqual([titles(md, 'events'), titles(md, 'upcoming')], [['Frühsport', 'Zahnarzt', 'Mülltonne rausstellen', 'Elternabend'], ['Reifen wechseln', 'Fashion Outlet', 'Buß- und Bettag']]);
    await h.ok(ANNA, 'PUT', 'prefs', { groups: { [`${MAIL}|cal:7`]: 'hide', [`${MAIL}|cal:9`]: null, [`${MAIL}|cal:10`]: null } });
    md = await h.ok(ANNA, 'GET', 'views/myday');
    assert.deepEqual([titles(md, 'events'), titles(md, 'upcoming')], [['Elternabend'], ['Reifen wechseln']]);
    // Marc sees his own, with his own choices
    assert.deepEqual(titles(await h.ok(MARC, 'GET', 'views/myday'), 'events'), ['Marcs Termin']);
    // „Mail“ switched off as a source: no events on the overview (making one still works — termine.js asks Mail)
    await h.ok(MARC, 'PUT', 'prefs', { sources: { [MAIL]: { on: false } } });
    assert.deepEqual(titles(await h.ok(MARC, 'GET', 'views/myday'), 'events'), []);
    // the next day: nothing of yesterday is overdue
    clock.set(T0 + 86400000);
    await h.ok(ANNA, 'PUT', 'prefs', { groups: { [`${MAIL}|cal:7`]: null } });
    md = await h.ok(ANNA, 'GET', 'views/myday');
    assert.deepEqual([titles(md, 'overdue'), titles(md, 'events')], [['Paket abholen'], []]);
  } finally { await h.close(); clock.set(T0); }
});

test('the hub asks Mail for events (accepts) with every pull, and once more when Mail 1.18.0 shows up for a person', async () => {
  const { m, source } = fakeMail();
  const h = await withHost({ sources: sourcesWith(source) });
  try {
    await h.ok(ANNA, 'GET', 'me');
    await h.host.tick();
    const pulls = () => source.state.calls.filter((c) => c.name === 'todo_items' && c.user === ANNA.id);
    assert.ok(pulls().length >= 1);
    for (const c of source.state.calls.filter((x) => x.name === 'todo_items')) assert.deepEqual(c.payload.accepts, ['calendar']);
    assert.equal(m.calls.filter((c) => c.name === 'calendar_list').length, 1);
  } finally { await h.close(); clock.set(T0); }
});

test('with the real Mail plugin, both ways: the event is in Mail\'s default calendar with its reminder; what changes in Mail reaches the overview', async () => {
  const mailDir = path.join(__dirname, '..', '..', MAIL);
  const users = [ANNA, MARC, LENA];
  let hub = null;
  // Mail sees the hub as a plugin that takes todo_changed
  const hubEntry = { plugin: HUB, provides: { todo_changed: { label: { de: 'x', en: 'x' }, maxPerHour: 3600 } }, service: (c) => hub.host.callService(c.name, { caller: MAIL, user: c.user, payload: c.payload }) };
  const mail = await createHost(mailDir, { users, gatecontrol: '1.219.0', mail: {}, services: [hubEntry], license: { required: true, licensed: true, state: 'valid', expiresAt: null } });
  await mail.start();
  const mailNotizen = require(path.join(mailDir, 'server', 'notizen.js'));
  mailNotizen.source.state.noTimer = true;
  const asMail = (u, method, p, body, query) => mail.request({ method, path: p, body: body === undefined ? null : body, query: query || {}, user: { ...u, portal: true, loggedIn: true, app: true }, lang: 'de' });
  // Mail lives in real time: the hub's clock is today, 10:00 in Berlin
  const tzm = require('../server/tz');
  const today = tzm.localDate(Date.now(), 'Europe/Berlin');
  const now = tzm.at(today, { hh: 10, mm: 0 }, 'Europe/Berlin');
  const h = await withHost({ now, host: { services: [...PLUGINS.filter((p) => p !== MAIL).map((p) => { const s = fakeSource(p); return { plugin: s.plugin, provides: s.provides, service: s.service }; }), { plugin: MAIL, host: mail }] } });
  hub = h;
  try {
    await asMail(ANNA, 'GET', 'me'); // Anna has opened Mail once (her place of the licence)
    assert.deepEqual((await h.ok(ANNA, 'GET', 'me')).events, { available: true, reason: null });
    const cals = await h.ok(ANNA, 'GET', 'events/calendars');
    assert.deepEqual([cals.state, cals.calendars.map((c) => [c.name, c.kind, c.target, c.isDefault, c.shown]), cals.reminders], ['ok', [['Privat', 'own', true, true, true], ['Firma', 'own', true, false, true]], { timed: 15, allDay: 360 }]);
    const day = tzm.addDays(today, 3);
    const a = await h.ok(ANNA, 'POST', 'events', { title: 'Fashion Outlet', date: day, time: '14:00', location: 'Fashion Outlet', clientId: 'offline-0001-abcd' });
    let ev = (await asMail(ANNA, 'GET', 'events/' + a.event.id)).json;
    assert.deepEqual([ev.title, ev.allDay, ev.start, ev.end - ev.start, ev.location, ev.reminders, ev.calendarId],
      ['Fashion Outlet', false, tzm.at(day, { hh: 14, mm: 0 }, 'Europe/Berlin'), 3600000, 'Fashion Outlet', [15], cals.defaultId]);
    assert.deepEqual(a.items.map((x) => [x.title, x.due, x.event.location, x.event.calendar.name, x.event.eventId]), [['Fashion Outlet', { date: day, time: '14:00' }, 'Fashion Outlet', 'Privat', a.event.id]]);
    assert.deepEqual(titles(await h.ok(ANNA, 'GET', 'views/myday'), 'upcoming'), ['Fashion Outlet']);
    // the same create again (the device did not see the answer): the same event, nothing new in Mail
    const again = await h.ok(ANNA, 'POST', 'events', { title: 'Fashion Outlet', date: day, time: '14:00', clientId: 'offline-0001-abcd' });
    assert.deepEqual([again.event.id, again.replayed], [a.event.id, true]);
    // all day today with the calendar's all-day reminder; a series
    const b = await h.ok(ANNA, 'POST', 'events', { title: 'Einkaufen', date: today });
    ev = (await asMail(ANNA, 'GET', 'events/' + b.event.id)).json;
    assert.deepEqual([ev.allDay, ev.startDate, ev.reminders], [true, today, [360]]);
    const s = await h.ok(ANNA, 'POST', 'events', { title: 'Chor', date: day, time: '19:00', endTime: '20:30', repeat: { type: 'weekly', interval: 1, days: [tzm.weekday(day) || 7] } });
    assert.ok(s.items.length >= 4, 'one item per occurrence in the window');
    let md = await h.ok(ANNA, 'GET', 'views/myday');
    assert.deepEqual([titles(md, 'events'), titles(md, 'upcoming').slice(0, 2)], [['Einkaufen'], ['Fashion Outlet', 'Chor']]);
    // Mail's push brings the same items: nothing doubles
    await mailNotizen.source.flush(mail.gc, Date.now(), { force: true });
    md = await h.ok(ANNA, 'GET', 'views/myday');
    assert.deepEqual([titles(md, 'events'), titles(md, 'upcoming').filter((x) => x === 'Fashion Outlet').length], [['Einkaufen'], 1]);
    // changed in Mail (the title, another time): the push brings it to the overview
    const etag = (await asMail(ANNA, 'GET', 'events/' + a.event.id)).json.etag;
    assert.equal((await asMail(ANNA, 'PATCH', 'events/' + a.event.id, { title: 'Outlet mit Jenny', scope: 'series', etag })).status, 200);
    await asMail(ANNA, 'POST', 'events', { title: 'In Mail angelegt', allDay: false, start: tzm.at(today, { hh: 16, mm: 30 }, 'Europe/Berlin'), end: tzm.at(today, { hh: 17, mm: 0 }, 'Europe/Berlin'), location: 'Praxis' });
    await mailNotizen.source.flush(mail.gc, Date.now(), { force: true });
    md = await h.ok(ANNA, 'GET', 'views/myday');
    assert.deepEqual([titles(md, 'events'), titles(md, 'upcoming').slice(0, 1)], [['In Mail angelegt', 'Einkaufen'], ['Outlet mit Jenny']]);
    const made = sec(md, 'events').find((x) => x.title === 'In Mail angelegt');
    assert.deepEqual([made.due.time, made.event.end.time, made.event.location, made.source.open.route.startsWith('event/')], ['16:30', '17:00', 'Praxis', true]);
    // changed and deleted through the hub
    await h.ok(ANNA, 'PATCH', 'events/' + a.event.id, { date: day, time: '15:00', location: 'Halle 2' });
    ev = (await asMail(ANNA, 'GET', 'events/' + a.event.id)).json;
    assert.deepEqual([ev.start, ev.location, ev.title], [tzm.at(day, { hh: 15, mm: 0 }, 'Europe/Berlin'), 'Halle 2', 'Outlet mit Jenny']);
    assert.deepEqual(await h.ok(ANNA, 'DELETE', 'events/' + a.event.id), { ok: true, removed: true });
    assert.equal((await asMail(ANNA, 'GET', 'events/' + a.event.id)).status, 404);
    // the event made in Mail itself is out of the hub's reach
    assert.equal((await h.call(ANNA, 'PATCH', 'events/' + made.event.eventId, { title: 'x' })).status, 404);
    assert.deepEqual(await h.ok(ANNA, 'DELETE', 'events/' + made.event.eventId), { ok: true, removed: false });
    // the background run of the hub pulls (with accepts): still one of each
    await h.host.tick();
    md = await h.ok(ANNA, 'GET', 'views/myday');
    assert.deepEqual(titles(md, 'events'), ['In Mail angelegt', 'Einkaufen']);
    // Marc sees nothing of it
    assert.deepEqual(titles(await h.ok(MARC, 'GET', 'views/myday'), 'events'), []);
  } finally { await h.close(); await mail.close(); clock.set(T0); }
});
