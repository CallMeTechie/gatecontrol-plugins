'use strict';

// Moving a whole series (Mail 1.3.0, PATCH events scope 'series' with times): Event.series names the series' own start
// and end; the new times are measured from it and the shift — wall clock, so the hour stays over the change to winter
// time — moves the rule's weekdays, UNTIL, the deleted occurrences and the exceptions along. Earlier occurrences stay.
// Times without that reference (an app sending one occurrence's time back) change nothing when unchanged and are
// refused when they would drop occurrences (400 invalid { reason: 'series_shift' }).

const test = require('node:test');
const assert = require('node:assert/strict');
const { withMail, ANNA } = require('./helpers');
const tz = require('../server/tz');

const BERLIN = 'Europe/Berlin';
const at = (date, hh, mm = 0) => tz.toUtc({ ...tz.parseDate(date), hh, mm }, BERLIN);
const H = 3600000;
const DAY = 86400000;
const wall = (ms) => { const p = tz.parts(ms, BERLIN); return `${tz.dateStr(p.y, p.m, p.d)} ${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`; };

async function range(anna, id) {
  const r = (await anna('GET', 'events', null, { from: at('2026-10-01', 0), to: at('2026-11-30', 0) })).json;
  return r.items.filter((x) => x.eventId === id).map((x) => [wall(x.start), x.title]);
}

test('a weekly series with an exception, a changed title and a deleted occurrence moves an hour, then a day — over the change to winter time, nothing gets lost', () => withMail({ gatecontrol: '1.219.0' }, async (host, c) => {
  const anna = c.as(ANNA);
  const cal = (await anna('GET', 'calendars')).json.calendars[0];
  // Tuesdays 10:00 from 13 Oct 2026 (summer time), six times — 27 Oct on is winter time
  const start = at('2026-10-13', 10);
  const ev = (await anna('POST', 'events', { calendarId: cal.id, title: 'Jour fixe', allDay: false, start, end: start + H, timeZone: BERLIN,
    recurrence: { freq: 'weekly', byDay: ['TU'], count: 6 } })).json.event;
  const occ = (await anna('GET', 'events', null, { from: at('2026-10-01', 0), to: at('2026-11-30', 0) })).json.items.filter((x) => x.eventId === ev.eventId);
  // 20 Oct moved to 12:00 by hand, 27 Oct only renamed, 3 Nov deleted
  await anna('PATCH', `events/${ev.eventId}`, { scope: 'occurrence', occurrence: occ[1].occurrence, start: at('2026-10-20', 12), end: at('2026-10-20', 13) });
  await anna('PATCH', `events/${ev.eventId}`, { scope: 'occurrence', occurrence: occ[2].occurrence, title: 'Jour fixe (Gast)' });
  await anna('DELETE', `events/${ev.eventId}`, null, { scope: 'occurrence', occurrence: occ[3].occurrence });
  assert.deepEqual(await range(anna, ev.eventId), [['2026-10-13 10:00', 'Jour fixe'], ['2026-10-20 12:00', 'Jour fixe'], ['2026-10-27 10:00', 'Jour fixe (Gast)'],
    ['2026-11-10 10:00', 'Jour fixe'], ['2026-11-17 10:00', 'Jour fixe']]);
  // Event.series: the master's start and end, also seen from one occurrence
  const one = (await anna('GET', `events/${ev.eventId}`, null, { occurrence: occ[4].occurrence })).json;
  assert.deepEqual(one.series, { start, end: start + H, allDay: false });
  assert.equal(one.start, occ[4].start, 'the occurrence itself as before');
  // an hour later: from series.start
  const r1 = await anna('PATCH', `events/${ev.eventId}`, { scope: 'series', start: one.series.start + H, end: one.series.end + H, etag: one.etag });
  assert.equal(r1.status, 200, JSON.stringify(r1.json));
  assert.deepEqual(await range(anna, ev.eventId), [['2026-10-13 11:00', 'Jour fixe'], ['2026-10-20 12:00', 'Jour fixe'], ['2026-10-27 11:00', 'Jour fixe (Gast)'],
    ['2026-11-10 11:00', 'Jour fixe'], ['2026-11-17 11:00', 'Jour fixe']], 'the hour stays over the change to winter time; the earlier ones stay');
  let full = (await anna('GET', `events/${ev.eventId}`)).json;
  assert.deepEqual([full.series.start, full.recurrence.byDay, full.recurrence.count, full.recurrence.exceptions.length, full.recurrence.deleted.length],
    [at('2026-10-13', 11), ['TU'], 6, 2, 1]);
  // a day later (Wednesdays): the weekday of the rule, the exceptions and the deleted one move along
  const r2 = await anna('PATCH', `events/${ev.eventId}`, { scope: 'series', start: full.series.start + DAY, end: full.series.end + DAY, etag: full.etag });
  assert.equal(r2.status, 200, JSON.stringify(r2.json));
  assert.deepEqual(await range(anna, ev.eventId), [['2026-10-14 11:00', 'Jour fixe'], ['2026-10-20 12:00', 'Jour fixe'], ['2026-10-28 11:00', 'Jour fixe (Gast)'],
    ['2026-11-11 11:00', 'Jour fixe'], ['2026-11-18 11:00', 'Jour fixe']]);
  full = (await anna('GET', `events/${ev.eventId}`)).json;
  assert.deepEqual([full.recurrence.byDay, full.recurrence.deleted], [['WE'], [String(at('2026-11-04', 11))]]);
  assert.deepEqual(full.recurrence.exceptions.sort(), [String(at('2026-10-21', 11)), String(at('2026-10-28', 11))].sort());
  // an app sending one occurrence's times back unchanged: nothing moves
  const occ5 = (await anna('GET', 'events', null, { from: at('2026-11-15', 0), to: at('2026-11-20', 0) })).json.items[0];
  const same = await anna('PATCH', `events/${ev.eventId}`, { scope: 'series', title: 'Jour fixe neu', start: occ5.start, end: occ5.end });
  assert.equal(same.status, 200, JSON.stringify(same.json));
  assert.deepEqual((await range(anna, ev.eventId)).map((x) => x[0]), ['2026-10-14 11:00', '2026-10-20 12:00', '2026-10-28 11:00', '2026-11-11 11:00', '2026-11-18 11:00']);
  // one occurrence's time changed, sent as the series' time: weeks away from series.start → refused, nothing changed
  const bad = await anna('PATCH', `events/${ev.eventId}`, { scope: 'series', start: occ5.start + H, end: occ5.end + H });
  assert.deepEqual([bad.status, bad.json.error.code, bad.json.error.field, bad.json.error.reason], [400, 'invalid', 'start', 'series_shift']);
  const week = await anna('PATCH', `events/${ev.eventId}`, { scope: 'series', start: full.series.start + 7 * DAY, end: full.series.end + 7 * DAY });
  assert.equal(week.json.error.reason, 'series_shift', 'a whole period or more');
  assert.deepEqual((await range(anna, ev.eventId)).map((x) => x[0]), ['2026-10-14 11:00', '2026-10-20 12:00', '2026-10-28 11:00', '2026-11-11 11:00', '2026-11-18 11:00']);
  // a new rule together with a new start: as before (the rule is replaced)
  const fresh = (await anna('GET', `events/${ev.eventId}`)).json;
  const rule = await anna('PATCH', `events/${ev.eventId}`, { scope: 'series', start: at('2026-11-02', 9), end: at('2026-11-02', 10), recurrence: { freq: 'daily', count: 2 }, etag: fresh.etag });
  assert.equal(rule.status, 200, JSON.stringify(rule.json));
  assert.deepEqual((await range(anna, ev.eventId)).map((x) => x[0]), ['2026-11-02 09:00', '2026-11-03 09:00']);
}));

test('other series: daily over midnight, monthly on a day, yearly all-day; until moves along; a day of the month beyond 28 is refused', () => withMail({ gatecontrol: '1.219.0' }, async (host, c) => {
  const anna = c.as(ANNA);
  const cal = (await anna('GET', 'calendars')).json.calendars[0];
  // daily 23:00 until (the date) 5 Oct — 1 to 4 Oct; two hours later is 01:00 the next day — all of them, the last one too
  const d0 = at('2026-10-01', 23);
  const daily = (await anna('POST', 'events', { calendarId: cal.id, title: 'Nacht', allDay: false, start: d0, end: d0 + H / 2, timeZone: BERLIN, recurrence: { freq: 'daily', until: '2026-10-05' } })).json.event;
  const before = await range(anna, daily.eventId);
  assert.equal(before.length, 4);
  const r = await anna('PATCH', `events/${daily.eventId}`, { scope: 'series', start: d0 + 2 * H, end: d0 + 2.5 * H });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual((await range(anna, daily.eventId)).map((x) => x[0]), ['2026-10-02 01:00', '2026-10-03 01:00', '2026-10-04 01:00', '2026-10-05 01:00']);
  // monthly on the 4th → the 5th; on the 28th one day later would be the 29th: refused
  const m0 = at('2026-10-04', 8);
  const monthly = (await anna('POST', 'events', { calendarId: cal.id, title: 'Miete', allDay: false, start: m0, end: m0 + H, timeZone: BERLIN, recurrence: { freq: 'monthly', byMonthDay: [4], count: 2 } })).json.event;
  assert.equal((await anna('PATCH', `events/${monthly.eventId}`, { scope: 'series', start: m0 + DAY, end: m0 + DAY + H })).status, 200);
  assert.deepEqual((await range(anna, monthly.eventId)).map((x) => x[0]), ['2026-10-05 08:00', '2026-11-05 08:00']);
  const m28 = at('2026-10-28', 8);
  const late = (await anna('POST', 'events', { calendarId: cal.id, title: 'Abrechnung', allDay: false, start: m28, end: m28 + H, timeZone: BERLIN, recurrence: { freq: 'monthly', byMonthDay: [28], count: 2 } })).json.event;
  assert.equal((await anna('PATCH', `events/${late.eventId}`, { scope: 'series', start: m28 + DAY, end: m28 + DAY + H })).json.error.reason, 'series_shift');
  // yearly all-day: a day later; series in dates
  const y = (await anna('POST', 'events', { calendarId: cal.id, title: 'Jahrestag', allDay: true, startDate: '2026-10-10', endDate: '2026-10-10', recurrence: { freq: 'yearly', count: 3 } })).json.event;
  const yf = (await anna('GET', `events/${y.eventId}`)).json;
  assert.deepEqual(yf.series, { start: at('2026-10-10', 0), end: at('2026-10-11', 0), allDay: true, startDate: '2026-10-10', endDate: '2026-10-10' });
  assert.equal((await anna('PATCH', `events/${y.eventId}`, { scope: 'series', allDay: true, startDate: '2026-10-11', endDate: '2026-10-11' })).status, 200);
  const yr = (await anna('GET', `events/${y.eventId}`)).json;
  assert.deepEqual([yr.series.startDate, yr.recurrence.count], ['2026-10-11', 3]);
  // a single event has no series
  const single = (await anna('POST', 'events', { calendarId: cal.id, title: 'Einmal', allDay: false, start: m0, end: m0 + H, timeZone: BERLIN })).json.event;
  assert.equal(single.series, null);
}));
