'use strict';

// The ICS reader (server/ics.js) and the time zone helpers (server/tz.js):
// lines, values, zones (also Windows names), recurrence rules expanded in
// the event's zone across DST changes, exceptions, overrides, caps.

const test = require('node:test');
const assert = require('node:assert/strict');
const ics = require('../server/ics');
const tz = require('../server/tz');
const { vcal, vevent } = require('./helpers');

const B = 'Europe/Berlin';
const W = (from, to) => ({ tz: B, from: Date.parse(from), to: Date.parse(to) });
const iso = (ms) => new Date(ms).toISOString().replace('.000', '');
const starts = (r) => r.instances.map((i) => (i.allDay ? i.date : iso(i.start)));

test('tz: wall clock ↔ instant in Europe/Berlin, DST gap moves forward, overlap takes the first', () => {
  assert.equal(iso(tz.toUtc({ y: 2026, m: 1, d: 15, hh: 9 }, B)), '2026-01-15T08:00:00Z');
  assert.equal(iso(tz.toUtc({ y: 2026, m: 7, d: 15, hh: 9 }, B)), '2026-07-15T07:00:00Z');
  // 2026-03-29 02:30 does not exist → 03:30 CEST
  assert.equal(iso(tz.toUtc({ y: 2026, m: 3, d: 29, hh: 2, mm: 30 }, B)), '2026-03-29T01:30:00Z');
  // 2026-10-25 02:30 exists twice → the first one (CEST)
  assert.equal(iso(tz.toUtc({ y: 2026, m: 10, d: 25, hh: 2, mm: 30 }, B)), '2026-10-25T00:30:00Z');
  assert.deepEqual(tz.parts(Date.parse('2026-10-25T01:30:00Z'), B), { y: 2026, m: 10, d: 25, hh: 2, mm: 30, ss: 0, wd: 0 });
  assert.equal(tz.toUtc({ y: 2026, m: 3, d: 1, hh: 12 }, 'UTC'), Date.UTC(2026, 2, 1, 12));
  assert.equal(tz.localDate(Date.parse('2026-12-31T23:30:00Z'), B), '2027-01-01');
  assert.equal(tz.addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(tz.diffDays('2026-03-28', '2026-03-30'), 2);
  assert.deepEqual(tz.parseTime('6:30'), { hh: 6, mm: 30 });
  assert.equal(tz.parseTime('24:00'), null);
});

test('tz: TZIDs from IANA, Windows/Outlook names and vendor prefixes', () => {
  assert.equal(tz.resolveTz('Europe/Berlin'), 'Europe/Berlin');
  assert.equal(tz.resolveTz('W. Europe Standard Time'), 'Europe/Berlin');
  assert.equal(tz.resolveTz('"W. Europe Standard Time"'), 'Europe/Berlin');
  assert.equal(tz.resolveTz('Romance Standard Time'), 'Europe/Paris');
  assert.equal(tz.resolveTz('GMT Standard Time'), 'Europe/London');
  assert.equal(tz.resolveTz('Central Europe Standard Time'), 'Europe/Budapest');
  assert.equal(tz.resolveTz('Eastern Standard Time'), 'America/New_York');
  assert.equal(tz.resolveTz('Pacific Standard Time'), 'America/Los_Angeles');
  assert.equal(tz.resolveTz('UTC'), 'UTC');
  assert.equal(tz.resolveTz('/mozilla.org/20050126_1/Europe/Berlin'), 'Europe/Berlin');
  assert.equal(tz.resolveTz('(UTC+01:00) Amsterdam, Berlin, Bern, Rom, Stockholm, Wien'), 'Europe/Berlin');
  assert.equal(tz.resolveTz('Mars/Olympus_Mons'), null);
  for (const iana of Object.values(tz.WINDOWS)) assert.ok(tz.valid(iana), iana);
});

test('lines: unfolding, parameters (quoted), text escaping, X-WR-CALNAME', () => {
  const text = vcal('X-WR-CALNAME:Familie', vevent([
    'UID:u1', 'DTSTART;VALUE=DATE:20261012',
    'SUMMARY:Elternabend\\, Klasse 3a\\; Raum 12\\nbitte',
    ' pünktlich',
    'LOCATION;ALTREP="http://x.example/a:b":Schule\\, Aula',
  ]));
  const r = ics.expand(text, W('2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z'));
  assert.equal(r.name, 'Familie');
  assert.equal(r.instances.length, 1);
  assert.equal(r.instances[0].title, 'Elternabend, Klasse 3a; Raum 12 bittepünktlich');
  assert.equal(r.instances[0].location, 'Schule, Aula');
  assert.deepEqual(ics.parseLine('DTSTART;TZID="W. Europe Standard Time":20261012T090000'), { name: 'DTSTART', params: { TZID: 'W. Europe Standard Time' }, value: '20261012T090000' });
  assert.equal(ics.parseLine('no colon here'), null);
  assert.deepEqual(ics.parseDuration('P1DT2H30M'), { ms: (26 * 60 + 30) * 60000, days: 1 });
  assert.deepEqual(ics.parseDuration('PT15M'), { ms: 900000, days: 0 });
  assert.equal(ics.parseDuration('P'), null);
});

test('values: all-day, UTC, TZID, Windows TZID, floating (plugin zone), DTEND / DURATION / none', () => {
  const text = vcal(
    vevent(['UID:a', 'DTSTART;VALUE=DATE:20261012', 'DTEND;VALUE=DATE:20261015', 'SUMMARY:Urlaub']),
    vevent(['UID:b', 'DTSTART:20261012T080000Z', 'DTEND:20261012T090000Z', 'SUMMARY:UTC']),
    vevent(['UID:c', 'DTSTART;TZID=Europe/Berlin:20261012T090000', 'DURATION:PT45M', 'SUMMARY:Berlin']),
    vevent(['UID:d', 'DTSTART;TZID=W. Europe Standard Time:20261012T100000', 'DTEND;TZID=W. Europe Standard Time:20261012T113000', 'SUMMARY:Outlook']),
    vevent(['UID:e', 'DTSTART:20261012T120000', 'SUMMARY:Floating']),
    vevent(['UID:f', 'DTSTART;TZID=America/New_York:20261012T090000', 'SUMMARY:New York']),
  );
  const r = ics.expand(text, W('2026-10-11T00:00:00Z', '2026-10-20T00:00:00Z'));
  const by = Object.fromEntries(r.instances.map((i) => [i.title, i]));
  assert.equal(by.Urlaub.allDay, true);
  assert.equal(by.Urlaub.date, '2026-10-12');
  assert.equal(by.Urlaub.endDate, '2026-10-15');
  assert.equal(iso(by.Urlaub.start), '2026-10-11T22:00:00Z', 'all-day: midnight in the plugin zone');
  assert.equal(iso(by.UTC.start), '2026-10-12T08:00:00Z');
  assert.equal(iso(by.Berlin.start), '2026-10-12T07:00:00Z');
  assert.equal(by.Berlin.end - by.Berlin.start, 45 * 60000);
  assert.equal(iso(by.Outlook.start), '2026-10-12T08:00:00Z');
  assert.equal(by.Outlook.end - by.Outlook.start, 90 * 60000);
  assert.equal(iso(by.Floating.start), '2026-10-12T10:00:00Z', 'floating = plugin zone');
  assert.equal(by.Floating.end, by.Floating.start, 'no DTEND/DURATION: zero length');
  assert.equal(iso(by['New York'].start), '2026-10-12T13:00:00Z');
  // in another plugin zone, floating moves, zoned times do not
  const r2 = ics.expand(text, { tz: 'UTC', from: Date.parse('2026-10-11T00:00:00Z'), to: Date.parse('2026-10-20T00:00:00Z') });
  const by2 = Object.fromEntries(r2.instances.map((i) => [i.title, i]));
  assert.equal(iso(by2.Floating.start), '2026-10-12T12:00:00Z');
  assert.equal(iso(by2.Berlin.start), '2026-10-12T07:00:00Z');
});

test('X-WR-TIMEZONE is the zone of an unknown TZID', () => {
  const text = vcal('X-WR-TIMEZONE:America/Chicago', vevent(['UID:x', 'DTSTART;TZID=Some Custom Zone:20261012T090000', 'SUMMARY:x']));
  const r = ics.expand(text, W('2026-10-11T00:00:00Z', '2026-10-20T00:00:00Z'));
  assert.equal(iso(r.instances[0].start), '2026-10-12T14:00:00Z');
});

test('RRULE weekly across both DST changes keeps 09:00 local time', () => {
  const text = vcal(vevent(['UID:w', 'DTSTART;TZID=Europe/Berlin:20260322T090000', 'DTEND;TZID=Europe/Berlin:20260322T100000', 'RRULE:FREQ=WEEKLY', 'SUMMARY:Sonntag']));
  const spring = ics.expand(text, W('2026-03-20T00:00:00Z', '2026-04-06T00:00:00Z'));
  assert.deepEqual(starts(spring), ['2026-03-22T08:00:00Z', '2026-03-29T07:00:00Z', '2026-04-05T07:00:00Z']);
  const autumn = ics.expand(text, W('2026-10-17T00:00:00Z', '2026-11-02T00:00:00Z'));
  assert.deepEqual(starts(autumn), ['2026-10-18T07:00:00Z', '2026-10-25T08:00:00Z', '2026-11-01T08:00:00Z']);
  for (const i of [...spring.instances, ...autumn.instances]) assert.equal(tz.parts(i.start, B).hh, 9);
  // daily at 02:30 over the spring gap: the missing time moves to 03:30
  const d = vcal(vevent(['UID:g', 'DTSTART;TZID=Europe/Berlin:20260328T023000', 'RRULE:FREQ=DAILY;COUNT=3', 'SUMMARY:Nacht']));
  assert.deepEqual(ics.expand(d, W('2026-03-27T00:00:00Z', '2026-04-01T00:00:00Z')).instances.map((i) => `${i.date} ${tz.parts(i.start, B).hh}:${tz.parts(i.start, B).mm}`),
    ['2026-03-28 2:30', '2026-03-29 3:30', '2026-03-30 2:30']);
  // a UTC series stays fixed in UTC (local time shifts)
  const u = vcal(vevent(['UID:u', 'DTSTART:20261018T080000Z', 'RRULE:FREQ=WEEKLY;COUNT=2', 'SUMMARY:UTC']));
  assert.deepEqual(starts(ics.expand(u, W('2026-10-01T00:00:00Z', '2026-11-30T00:00:00Z'))), ['2026-10-18T08:00:00Z', '2026-10-25T08:00:00Z']);
});

test('RRULE parts: INTERVAL, COUNT, UNTIL, BYDAY (also 2TU / -1FR), BYMONTHDAY (negative), BYMONTH, BYSETPOS, WKST', () => {
  const run = (rule, start, from, to, extra = []) => starts(ics.expand(vcal(vevent(['UID:r', `DTSTART;VALUE=DATE:${start}`, `RRULE:${rule}`, 'SUMMARY:r', ...extra])), W(from, to)));
  const Y = ['2026-01-01T00:00:00Z', '2027-12-31T00:00:00Z'];
  assert.deepEqual(run('FREQ=DAILY;INTERVAL=3;COUNT=4', '20260105', ...Y), ['2026-01-05', '2026-01-08', '2026-01-11', '2026-01-14']);
  assert.deepEqual(run('FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20260114', '20260105', ...Y), ['2026-01-05', '2026-01-07', '2026-01-12', '2026-01-14']);
  assert.deepEqual(run('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;COUNT=3', '20260106', ...Y), ['2026-01-06', '2026-01-20', '2026-02-03']);
  assert.deepEqual(run('FREQ=MONTHLY;BYDAY=2TU;COUNT=3', '20260113', ...Y), ['2026-01-13', '2026-02-10', '2026-03-10']);
  assert.deepEqual(run('FREQ=MONTHLY;BYDAY=-1FR;COUNT=3', '20260130', ...Y), ['2026-01-30', '2026-02-27', '2026-03-27']);
  assert.deepEqual(run('FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3', '20260131', ...Y), ['2026-01-31', '2026-02-28', '2026-03-31']);
  assert.deepEqual(run('FREQ=MONTHLY;COUNT=4', '20260131', ...Y), ['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31'], 'months without a 31st are skipped');
  assert.deepEqual(run('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3', '20260130', ...Y), ['2026-01-30', '2026-02-27', '2026-03-31'], 'last workday');
  assert.deepEqual(run('FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU;COUNT=2', '20260329', ...Y), ['2026-03-29', '2027-03-28'], 'DST Sunday');
  assert.deepEqual(run('FREQ=YEARLY;COUNT=3', '20240229', '2024-01-01T00:00:00Z', '2033-01-01T00:00:00Z'), ['2024-02-29', '2028-02-29', '2032-02-29']);
  assert.deepEqual(run('FREQ=YEARLY;BYMONTH=1,7;BYMONTHDAY=1;COUNT=3', '20260101', ...Y), ['2026-01-01', '2026-07-01', '2027-01-01']);
  assert.deepEqual(run('FREQ=DAILY;BYDAY=SA,SU;COUNT=3', '20260103', ...Y), ['2026-01-03', '2026-01-04', '2026-01-10']);
  // WKST changes which days belong to a week of an INTERVAL=2 rule (RFC 5545 example)
  assert.deepEqual(run('FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=MO', '19970805', '1997-01-01T00:00:00Z', '1998-01-01T00:00:00Z'), ['1997-08-05', '1997-08-10', '1997-08-19', '1997-08-24']);
  assert.deepEqual(run('FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=SU', '19970805', '1997-01-01T00:00:00Z', '1998-01-01T00:00:00Z'), ['1997-08-05', '1997-08-17', '1997-08-19', '1997-08-31']);
  // COUNT counts from DTSTART even when the window starts later
  assert.deepEqual(run('FREQ=WEEKLY;COUNT=5', '20260105', '2026-01-20T00:00:00Z', '2026-12-31T00:00:00Z'), ['2026-01-26', '2026-02-02']);
  // an endless series long before the window only produces the window
  assert.deepEqual(run('FREQ=WEEKLY', '20000103', '2026-10-11T00:00:00Z', '2026-10-27T00:00:00Z'), ['2026-10-12', '2026-10-19', '2026-10-26']);
  assert.equal(ics.parseRrule('FREQ=HOURLY', { tz: B }), null, 'unsupported frequency: only DTSTART');
});

test('EXDATE (also as DATE for a timed series), RDATE, RECURRENCE-ID override and cancelled instances', () => {
  const text = vcal(
    vevent(['UID:s@x', 'DTSTART;TZID=Europe/Berlin:20261005T180000', 'DTEND;TZID=Europe/Berlin:20261005T190000', 'RRULE:FREQ=WEEKLY;COUNT=6', 'SUMMARY:Training',
      'EXDATE;TZID=Europe/Berlin:20261012T180000', 'EXDATE;VALUE=DATE:20261019', 'RDATE;TZID=Europe/Berlin:20261008T180000']),
    // the 26th moved to Tuesday 19:00 with a new title
    vevent(['UID:s@x', 'RECURRENCE-ID;TZID=Europe/Berlin:20261026T180000', 'DTSTART;TZID=Europe/Berlin:20261027T190000', 'DTEND;TZID=Europe/Berlin:20261027T200000', 'SUMMARY:Training (verlegt)']),
    // the 2nd of November cancelled
    vevent(['UID:s@x', 'RECURRENCE-ID;TZID=Europe/Berlin:20261102T180000', 'DTSTART;TZID=Europe/Berlin:20261102T180000', 'STATUS:CANCELLED']),
    vevent(['UID:gone', 'DTSTART;VALUE=DATE:20261010', 'STATUS:CANCELLED', 'SUMMARY:Abgesagt']),
  );
  const r = ics.expand(text, W('2026-10-01T00:00:00Z', '2026-12-01T00:00:00Z'));
  assert.deepEqual(r.instances.map((i) => `${i.date} ${tz.parts(i.start, B).hh}h ${i.title}`), [
    '2026-10-05 18h Training',
    '2026-10-08 18h Training',
    '2026-10-27 19h Training (verlegt)',
    '2026-11-09 18h Training',
  ]);
  const moved = r.instances.find((i) => i.title === 'Training (verlegt)');
  assert.equal(moved.key, 's@x|' + Date.parse('2026-10-26T17:00:00Z'), 'the instance key is the original start');
  // an override moved INTO the window from outside appears; one moved out disappears
  const r2 = ics.expand(text, W('2026-10-27T00:00:00Z', '2026-10-28T00:00:00Z'));
  assert.deepEqual(r2.instances.map((i) => i.title), ['Training (verlegt)']);
  assert.deepEqual(ics.expand(text, W('2026-10-26T00:00:00Z', '2026-10-27T00:00:00Z')).instances, []);
});

test('all-day series and multi-day events touching the window', () => {
  const text = vcal(
    vevent(['UID:m', 'DTSTART;VALUE=DATE:20261010', 'DTEND;VALUE=DATE:20261014', 'SUMMARY:Ferien']),
    vevent(['UID:b', 'DTSTART;VALUE=DATE:19900315', 'RRULE:FREQ=YEARLY', 'SUMMARY:Geburtstag']),
  );
  const r = ics.expand(text, W('2026-10-12T00:00:00Z', '2027-04-01T00:00:00Z'));
  assert.deepEqual(r.instances.map((i) => `${i.date}–${i.endDate} ${i.title}`), ['2026-10-10–2026-10-14 Ferien', '2027-03-15–2027-03-16 Geburtstag']);
});

test('caps: input size, instances per series and in total; garbage is refused or skipped', () => {
  assert.throws(() => ics.expand('BEGIN:VCALENDAR\r\n' + 'X'.repeat(ics.LIMITS.bytes + 1), W('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z')), { code: 'ICS_TOO_LARGE' });
  assert.throws(() => ics.expand('<html>nope</html>', W('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z')), { code: 'ICS_INVALID' });
  assert.throws(() => ics.expand(null, W('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z')), { code: 'ICS_INVALID' });
  // a minutely-ish daily series over decades stays within the per-series cap
  const daily = vcal(vevent(['UID:d', 'DTSTART;VALUE=DATE:20200101', 'RRULE:FREQ=DAILY', 'SUMMARY:d']));
  const r = ics.expand(daily, W('2020-01-01T00:00:00Z', '2030-01-01T00:00:00Z'));
  assert.equal(r.instances.length, ics.LIMITS.perEvent);
  // many events: the total cap
  const many = vcal(...Array.from({ length: 6 }, (_, k) => vevent([`UID:m${k}`, 'DTSTART;VALUE=DATE:20200101', 'RRULE:FREQ=DAILY', `SUMMARY:m${k}`])));
  const r2 = ics.expand(many, W('2020-01-01T00:00:00Z', '2030-01-01T00:00:00Z'));
  assert.equal(r2.instances.length, ics.LIMITS.instances);
  assert.equal(r2.truncated, true);
  // broken events are skipped, the rest is read
  const broken = vcal(vevent(['UID:x', 'DTSTART:nonsense', 'SUMMARY:x']), vevent(['UID:y', 'DTSTART;VALUE=DATE:20260105', 'SUMMARY:ok']), ['BEGIN:VTODO', 'DTSTART:20260105T100000Z', 'END:VTODO']);
  assert.deepEqual(ics.expand(broken, W('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z')).instances.map((i) => i.title), ['ok']);
  // VALARM inside an event does not leak into the event
  const alarm = vcal(vevent(['UID:a', 'DTSTART;VALUE=DATE:20260105', 'SUMMARY:Haupt', 'BEGIN:VALARM', 'TRIGGER:-PT15M', 'DESCRIPTION:Alarm', 'SUMMARY:Alarmtext', 'END:VALARM']));
  assert.equal(ics.expand(alarm, W('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z')).instances[0].title, 'Haupt');
});
