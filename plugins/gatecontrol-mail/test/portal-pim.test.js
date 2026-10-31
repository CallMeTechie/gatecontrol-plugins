'use strict';

// The plain logic of the portal's calendar and contacts (ui/pimlogic.js, Mail 1.3.0): the days of a view, events of a
// day in columns, all-day ones, the agenda, the repetition and reminders in words, birthdays, the event form → the API
// (a PATCH sends only what changed), the calendars in the menu's groups, letters, addresses typed in.

process.env.TZ = 'Europe/Berlin';

const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../ui/pimlogic');
const texts = require('../server/texts.json');

const T = (k, p) => {
  let s = texts.de[k] != null ? texts.de[k] : k;
  if (p) for (const x of Object.keys(p)) s = s.split(`{{${x}}}`).join(String(p[x]));
  return s;
};
const at = (d, t) => L.at(d, t);

test('the days of a view: day, week (Monday or Sunday first, the work week), month as six weeks, list', () => {
  const w = L.rangeOf('week', '2026-11-04', { weekStart: 1 });
  assert.deepEqual([w.days[0], w.days[6], w.days.length], ['2026-11-02', '2026-11-08', 7]);
  assert.equal(w.from, new Date(2026, 10, 2).getTime());
  assert.equal(w.to, new Date(2026, 10, 9).getTime());
  assert.deepEqual(L.rangeOf('week', '2026-11-04', { weekStart: 0 }).days.slice(0, 2), ['2026-11-01', '2026-11-02']);
  const ww = L.rangeOf('week', '2026-11-04', { weekStart: 0, workWeek: true });
  assert.deepEqual([ww.days[0], ww.days[4], ww.days.length], ['2026-11-02', '2026-11-06', 5]);
  const m = L.rangeOf('month', '2026-11-18', { weekStart: 1 });
  assert.deepEqual([m.days[0], m.days[41], m.days.length, m.month], ['2026-10-26', '2026-12-06', 42, '2026-11']);
  assert.ok((m.to - m.from) / L.DAY <= 62, 'one request');
  assert.deepEqual(L.rangeOf('day', '2026-10-25', {}).days, ['2026-10-25']);
  // the change to winter time: the day is 25 hours long, midnight to midnight
  const d = L.rangeOf('day', '2026-10-25', {});
  assert.equal(d.to - d.from, 25 * 3600000);
  assert.equal(L.rangeOf('list', '2026-11-04', { listDays: 30 }).days.length, 30);
  assert.equal(L.addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(L.weekStartOf('2026-11-08', 1), '2026-11-02');
});

test('a day in columns: overlapping events side by side, separate clusters, all-day and multi-day events', () => {
  const ev = (id, a, b) => ({ eventId: id, start: at('2026-11-04', a), end: at('2026-11-04', b), allDay: false });
  const items = [ev(1, '09:00', '10:00'), ev(2, '09:30', '11:00'), ev(3, '10:00', '10:30'), ev(4, '12:00', '13:00'), ev(5, '12:00', '12:05')];
  const lay = L.layoutDay(items, '2026-11-04');
  const by = Object.fromEntries(lay.map((x) => [x.item.eventId, x]));
  assert.deepEqual([by[1].col, by[2].col, by[3].col, by[1].cols, by[3].cols], [0, 1, 0, 2, 2]);
  assert.deepEqual([by[4].col, by[5].col, by[4].cols], [0, 1, 2]);
  assert.deepEqual([by[1].top, by[1].height, by[5].height], [540, 60, 15]);
  // an event over midnight shows on both days, cut at midnight
  const night = { eventId: 6, start: at('2026-11-04', '22:00'), end: at('2026-11-05', '02:00'), allDay: false };
  assert.deepEqual(L.layoutDay([night], '2026-11-04').map((x) => [x.top, x.height]), [[1320, 120]]);
  assert.deepEqual(L.layoutDay([night], '2026-11-05').map((x) => [x.top, x.height]), [[0, 120]]);
  // all-day: the inclusive end date
  const holiday = { eventId: 7, allDay: true, startDate: '2026-11-04', endDate: '2026-11-06', start: at('2026-11-04', '00:00'), end: at('2026-11-07', '00:00') };
  assert.deepEqual(['2026-11-03', '2026-11-04', '2026-11-06', '2026-11-07'].map((s) => L.allDayOn([holiday], s).length), [0, 1, 1, 0]);
  assert.equal(L.layoutDay([holiday], '2026-11-04').length, 0, 'not in the hours');
  const ag = L.agenda([...items, holiday], ['2026-11-04', '2026-11-05', '2026-11-08']);
  assert.deepEqual(ag.map((g) => [g.day, g.items.length]), [['2026-11-04', 6], ['2026-11-05', 1]]);
  assert.equal(ag[0].items[0].eventId, 7, 'all-day first');
});

test('texts: repetition, reminders, birthdays with the age, accepted of all', () => {
  assert.equal(L.recurrenceText({ freq: 'weekly', interval: 1, byDay: ['TU', 'TH'] }, T, 'de'), 'Wöchentlich · Di, Do');
  assert.equal(L.recurrenceText({ freq: 'weekly', interval: 2, byDay: ['MO'], count: 5 }, T, 'de'), 'Alle 2 Wochen · Mo · 5-mal');
  assert.equal(L.recurrenceText({ freq: 'monthly', interval: 1, byDay: ['WE'], bySetPos: -1 }, T, 'de'), 'Monatlich · am letzten Mi');
  assert.equal(L.recurrenceText({ freq: 'monthly', interval: 1, byMonthDay: [4], until: '2027-03-31' }, T, 'de'), 'Monatlich · am 4. · bis 31.3.2027');
  assert.equal(L.recurrenceText({ freq: 'yearly', interval: 1 }, T, 'de'), 'Jährlich');
  assert.equal(L.recurrenceText(null, T, 'de'), '');
  assert.deepEqual([0, 15, 60, 120, 1440, 2880, null].map((m) => L.reminderText(m, T)),
    ['Zu Beginn', '15 Minuten vorher', '1 Stunde vorher', '2 Stunden vorher', '1 Tag vorher', '2 Tage vorher', 'Keine Erinnerung']);
  assert.deepEqual(L.birthdayText('1981-03-14', 'de', '2026-10-31'), { text: '14. März 1981', turns: 46 });
  assert.deepEqual(L.birthdayText('1981-11-02', 'de', '2026-10-31'), { text: '2. November 1981', turns: 45 });
  assert.deepEqual(L.birthdayText('--12-24', 'de', '2026-10-31'), { text: '24. Dezember', turns: null });
  assert.equal(L.birthdayText('nonsense', 'de'), null);
  assert.deepEqual(L.countOf({ accepted: 3, tentative: 1, declined: 0, needs_action: 1 }), { yes: 3, all: 5 });
});

test('the event form → POST: everything; → PATCH: only what changed (time and place mean new invitations)', () => {
  const f = {
    title: 'Planung', calendarId: 3, allDay: false, startDate: '2026-11-04', startTime: '10:00', endDate: '2026-11-04', endTime: '11:00', timeZone: 'Europe/Berlin',
    location: 'Raum 1', description: '', reminders: [15], repeat: { kind: 'weekly', interval: 1, byDay: [], end: 'count', count: 4 }, online: { kind: 'none', url: '' },
    attendees: [{ email: 'tim@firma.de', name: 'Tim', role: 'required' }], busy: 'busy', private: false,
  };
  const post = L.eventFields(f, null);
  assert.deepEqual(post, {
    calendarId: 3, title: 'Planung', allDay: false, start: at('2026-11-04', '10:00'), end: at('2026-11-04', '11:00'), timeZone: 'Europe/Berlin', location: 'Raum 1', reminders: [15],
    recurrence: { freq: 'weekly', interval: 1, byDay: ['WE'], byMonthDay: null, bySetPos: null, until: null, count: 4 }, attendees: f.attendees,
  });
  const orig = {
    title: 'Planung', allDay: false, start: post.start, end: post.end, timeZone: 'Europe/Berlin', location: 'Raum 1', description: '', reminders: [15],
    recurrence: { freq: 'weekly', interval: 1, byDay: ['WE'], count: 4, until: null }, online: null, attendees: [{ email: 'tim@firma.de', name: 'Tim', role: 'required', response: 'accepted' }], busy: 'busy', private: false,
  };
  const same = { ...f, repeat: { ...f.repeat, byDay: ['WE'], touched: true } };
  assert.deepEqual(L.eventFields(same, orig), {}, 'nothing changed');
  assert.deepEqual(L.eventFields({ ...same, title: 'Planung neu', description: 'Agenda' }, orig), { title: 'Planung neu', description: 'Agenda' });
  assert.deepEqual(L.eventFields({ ...same, startTime: '12:00', endTime: '13:00' }, orig), { allDay: false, start: at('2026-11-04', '12:00'), end: at('2026-11-04', '13:00') });
  assert.deepEqual(L.eventFields({ ...same, repeat: { ...same.repeat, count: 6 } }, orig).recurrence.count, 6);
  assert.deepEqual(L.eventFields({ ...same, repeat: { ...same.repeat, count: 6 } }, orig, { occurrence: true }), {}, 'one occurrence never changes the rule');
  assert.deepEqual(L.eventFields({ ...same, attendees: [] }, orig), { attendees: [] });
  assert.deepEqual(L.eventFields({ ...same, online: { kind: 'teams' }, busy: 'free', private: true, location: '' }, orig), { location: null, online: { create: 'teams' }, busy: 'free', private: true });
  // all day: dates, an end before the start becomes the start
  const ad = L.eventFields({ ...f, allDay: true, startDate: '2026-11-04', endDate: '2026-11-03', timeZone: null, repeat: null }, null);
  assert.deepEqual([ad.allDay, ad.startDate, ad.endDate, ad.start, ad.timeZone], [true, '2026-11-04', '2026-11-04', undefined, undefined]);
  // the n-th weekday of a month, the last one
  assert.deepEqual(L.nthOf('2026-11-04'), { pos: 1, day: 'WE' });
  assert.deepEqual(L.nthOf('2026-11-25'), { pos: 4, day: 'WE' });
  assert.deepEqual(L.nthOf('2026-12-30'), { pos: -1, day: 'WE' });
  assert.deepEqual(L.recurrenceOf({ kind: 'monthly_nth', interval: 1, end: 'until', until: '2027-06-30' }, '2026-12-30'),
    { freq: 'monthly', interval: 1, byDay: ['WE'], byMonthDay: null, bySetPos: -1, until: '2027-06-30', count: null });
  assert.deepEqual(L.recurrenceOf({ kind: 'monthly_day', interval: 2, end: 'never' }, '2026-11-25').byMonthDay, [25]);
  assert.equal(L.recurrenceOf({ kind: 'none' }, '2026-11-25'), null);
  assert.deepEqual(L.repeatOf({ freq: 'monthly', interval: 1, byDay: ['-1WE'], bySetPos: -1, until: null, count: 3 }, '2026-11-25'),
    { kind: 'monthly_nth', interval: 1, byDay: ['WE'], end: 'count', until: '', count: 3, startDate: '2026-11-25' });
});

test('„Alle Termine der Serie“ from one occurrence: the same shift on the series\' own start (Event.series), wall clock over the change to winter time', () => {
  const series = { start: at('2026-10-13', '10:00'), end: at('2026-10-13', '11:00'), allDay: false };
  const occ = { start: at('2026-10-27', '10:00'), end: at('2026-10-27', '11:00'), allDay: false };
  // an hour later (27 Oct is winter time, 13 Oct summer time: still 11:00 on the wall)
  assert.deepEqual(L.shiftSeries({ allDay: false, start: at('2026-10-27', '11:00'), end: at('2026-10-27', '12:00'), title: 'x' }, occ, series),
    { allDay: false, start: at('2026-10-13', '11:00'), end: at('2026-10-13', '12:00'), title: 'x' });
  // a day later and half an hour longer
  assert.deepEqual(L.shiftSeries({ allDay: false, start: at('2026-10-28', '10:00'), end: at('2026-10-28', '11:30') }, occ, series),
    { allDay: false, start: at('2026-10-14', '10:00'), end: at('2026-10-14', '11:30') });
  // all-day series: dates
  assert.deepEqual(L.shiftSeries({ allDay: true, startDate: '2027-10-11', endDate: '2027-10-12' }, { allDay: true, startDate: '2027-10-10', endDate: '2027-10-10' },
    { allDay: true, startDate: '2026-10-10', endDate: '2026-10-10' }), { allDay: true, startDate: '2026-10-11', endDate: '2026-10-12' });
});

test('the menu groups the calendars: GateControl, each account, Eingeblendet; letters; addresses typed in', () => {
  const g = L.calendarGroups([{ id: 1, accountId: null, name: 'Privat' }, { id: 2, accountId: 7, name: 'Kalender' }, { id: 3, accountId: null, name: 'Feiertage', source: 'ics' }, { id: 4, accountId: 7, name: 'Urlaub' }],
    [{ id: 'familie', name: 'Familie' }], [{ id: 7, email: 'anna@firma.de' }]);
  assert.deepEqual(g.map((x) => [x.key, x.items.map((i) => i.it.name)]), [['gc', ['Privat', 'Feiertage']], ['acc:7', ['Kalender', 'Urlaub']], ['overlays', ['Familie']]]);
  assert.equal(g[1].account.email, 'anna@firma.de');
  assert.deepEqual(L.calendarGroups([], [], []), []);
  assert.deepEqual(L.letters([{ letter: 'A' }, { letter: 'A' }, { letter: 'B' }, { letter: '#' }]), ['A', 'B', '#']);
  assert.deepEqual(L.addressesOf('Tim Brandt <Tim@Firma.de>, anna@gmx.de; kein Name'), [{ email: 'tim@firma.de', name: 'Tim Brandt' }, { email: 'anna@gmx.de', name: '' }]);
});
