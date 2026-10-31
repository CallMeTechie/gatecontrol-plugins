'use strict';

// iCalendar and vCard of Mail 1.2.0 (server/ics.js, server/vcard.js — ical.js vendored): repetition with exceptions and
// deleted occurrences, Europe/Berlin over the change of the clocks, all-day events and 29 February, Windows zone names
// of Outlook, the round trip (unknown properties stay), the field merge after a 412, iTIP messages, vCard 3.0 / 4.0.

const test = require('node:test');
const assert = require('node:assert/strict');
const ics = require('../server/ics');
const vcard = require('../server/vcard');
const tz = require('../server/tz');

const BERLIN = 'Europe/Berlin';
const ctx = (zones) => ({ userTz: BERLIN, own: new Set(['anna@example.com']), zones });
const cal = (lines, more = []) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//T//T//EN', 'BEGIN:VEVENT', 'UID:u1', 'DTSTAMP:20261001T000000Z', ...lines, 'END:VEVENT', ...more, 'END:VCALENDAR', ''].join('\r\n');
const iso = (ms) => new Date(ms).toISOString();

test('a daily series over the end of summer time: 09:00 local stays 09:00 (07:00 → 08:00 UTC), an exception, an EXDATE, UNTIL', () => {
  const text = cal(['DTSTART;TZID=Europe/Berlin:20261023T090000', 'DTEND;TZID=Europe/Berlin:20261023T093000', 'RRULE:FREQ=DAILY;UNTIL=20261028T080000Z', 'SUMMARY:Stand-up',
    'EXDATE;TZID=Europe/Berlin:20261027T090000'], ['BEGIN:VEVENT', 'UID:u1', 'DTSTAMP:20261001T000000Z', 'RECURRENCE-ID;TZID=Europe/Berlin:20261025T090000',
    'DTSTART;TZID=Europe/Berlin:20261025T110000', 'DTEND;TZID=Europe/Berlin:20261025T113000', 'SUMMARY:Stand-up (Sonntag)', 'END:VEVENT']);
  const p = ics.parse(text);
  const o = p.objects[0];
  const list = ics.expand(o, ctx(p.zones), Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 30));
  assert.deepEqual(list.map((x) => [iso(x.start), x.override ? x.override.title : null]), [
    ['2026-10-23T07:00:00.000Z', null], ['2026-10-24T07:00:00.000Z', null], ['2026-10-25T10:00:00.000Z', 'Stand-up (Sonntag)'], ['2026-10-26T08:00:00.000Z', null], ['2026-10-28T08:00:00.000Z', null]]);
  assert.equal(list[2].occ, String(tz.toUtc({ y: 2026, m: 10, d: 25, hh: 9 }, BERLIN)), 'the key: the original start');
  const r = ics.recurrenceOf(o, ctx(p.zones));
  assert.deepEqual([r.freq, r.until, r.editable, r.exceptions.length, r.deleted], ['daily', '2026-10-28', true, 1, [String(tz.toUtc({ y: 2026, m: 10, d: 27, hh: 9 }, BERLIN))]]);
});

test('Outlook: a Windows zone name, a floating time in the person\'s zone, UTC; DURATION instead of DTEND; the rule beyond the form', () => {
  const w = ics.fieldsOf(ics.parse(cal(['DTSTART;TZID=W. Europe Standard Time:20260715T100000', 'DURATION:PT90M', 'SUMMARY:x'])).objects[0].master, ctx());
  assert.deepEqual([iso(w.start), iso(w.end), w.tz], ['2026-07-15T08:00:00.000Z', '2026-07-15T09:30:00.000Z', BERLIN]);
  const f = ics.fieldsOf(ics.parse(cal(['DTSTART:20260115T100000', 'SUMMARY:x'])).objects[0].master, ctx());
  assert.equal(iso(f.start), '2026-01-15T09:00:00.000Z');
  const u = ics.fieldsOf(ics.parse(cal(['DTSTART:20260115T100000Z', 'SUMMARY:x'])).objects[0].master, ctx());
  assert.deepEqual([iso(u.start), u.tz], ['2026-01-15T10:00:00.000Z', 'UTC']);
  const p = ics.parse(cal(['DTSTART:20260115T100000Z', 'RRULE:FREQ=MONTHLY;BYDAY=2TU', 'SUMMARY:x']));
  const r = ics.recurrenceOf(p.objects[0], ctx(p.zones));
  assert.deepEqual([r.freq, r.byDay, r.bySetPos, r.editable], ['monthly', ['TU'], 2, true]);
  const p2 = ics.parse(cal(['DTSTART:20260115T100000Z', 'RRULE:FREQ=DAILY;BYHOUR=9,17', 'SUMMARY:x']));
  assert.equal(ics.recurrenceOf(p2.objects[0], ctx(p2.zones)).editable, false);
  assert.throws(() => ics.parse('kein Kalender'), (e) => e.code === 'invalid_ics');
  assert.equal(ics.ruleOf({ freq: 'monthly', byDay: ['FR'], bySetPos: -1, until: '2027-06-30' }), 'FREQ=MONTHLY;BYDAY=-1FR;UNTIL=20270630');
  assert.throws(() => ics.ruleOf({ freq: 'weekly', until: '2027-01-01', count: 3 }), (e) => e.code === 'invalid');
});

test('all-day: DTEND exclusive → endDate inclusive; a monthly rule on the 31st skips short months; yearly on 29 February', () => {
  const p = ics.parse(cal(['DTSTART;VALUE=DATE:20260131', 'DTEND;VALUE=DATE:20260201', 'RRULE:FREQ=MONTHLY;COUNT=4', 'SUMMARY:Monatsende']));
  const list = ics.expand(p.objects[0], ctx(p.zones), Date.UTC(2026, 0, 1), Date.UTC(2026, 11, 31));
  assert.deepEqual(list.map((x) => [x.startDate, x.endDate]), [['2026-01-31', '2026-01-31'], ['2026-03-31', '2026-03-31'], ['2026-05-31', '2026-05-31'], ['2026-07-31', '2026-07-31']]);
  const leap = ics.parse(cal(['DTSTART;VALUE=DATE:20240229', 'RRULE:FREQ=YEARLY', 'SUMMARY:Schalttag']));
  assert.deepEqual(ics.expand(leap.objects[0], ctx(leap.zones), Date.UTC(2024, 0, 1), Date.UTC(2032, 11, 31)).map((x) => x.startDate), ['2024-02-29', '2028-02-29', '2032-02-29']);
});

test('round trip: a change keeps unknown properties and alarms of other apps; an occurrence changed gets an override; the field merge', () => {
  const text = cal(['DTSTART;TZID=Europe/Berlin:20261110T090000', 'DTEND;TZID=Europe/Berlin:20261110T100000', 'RRULE:FREQ=WEEKLY;COUNT=3', 'SUMMARY:Alt', 'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC',
    'ORGANIZER:mailto:anna@example.com', 'ATTENDEE;PARTSTAT=ACCEPTED:mailto:bob@example.com']);
  const changed = ics.change(text, 'u1', { title: 'Neu', location: 'Raum 2' }, { bump: true });
  assert.match(changed, /X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC/);
  assert.match(changed, /SEQUENCE:1/);
  assert.match(changed, /PARTSTAT=ACCEPTED/, 'the answers of attendees stay');
  const occ = String(tz.toUtc({ y: 2026, m: 11, d: 17, hh: 9 }, BERLIN));
  const one = ics.change(changed, 'u1', { title: 'Nur einmal' }, { occ, ctx: ctx() });
  const p = ics.parse(one);
  assert.equal(p.objects[0].overrides.length, 1);
  assert.deepEqual(ics.expand(p.objects[0], ctx(p.zones), Date.UTC(2026, 10, 1), Date.UTC(2026, 11, 1)).map((x) => (x.override ? x.override.title : 'Neu')), ['Neu', 'Nur einmal', 'Neu']);
  // the merge: different fields → both; the same field → null
  const mine = ics.change(text, 'u1', { title: 'Meins' });
  assert.match(ics.merge(text, ics.change(text, 'u1', { description: 'von dort' }), mine, 'u1'), /SUMMARY:Meins[\s\S]*|DESCRIPTION:von dort/);
  const merged = ics.merge(text, ics.change(text, 'u1', { description: 'von dort' }), mine, 'u1');
  const f = ics.fieldsOf(ics.parse(merged).objects[0].master, ctx());
  assert.deepEqual([f.title, f.description], ['Meins', 'von dort']);
  assert.equal(ics.merge(text, ics.change(text, 'u1', { title: 'Deren' }), mine, 'u1'), null);
});

test('iTIP: REQUEST with the zone block, REPLY with only the answering attendee, COUNTER with the proposal, CANCEL of one occurrence', () => {
  const start = tz.toUtc({ y: 2026, m: 11, d: 18, hh: 13 }, BERLIN);
  const text = ics.build('m1', { title: 'Planung', allDay: false, start, end: start + 3600000, timeZone: BERLIN, organizer: { email: 'anna@example.com', name: 'Anna' },
    attendees: [{ email: 'bob@example.com', name: 'Bob', role: 'required' }, { email: 'cara@example.com', name: '', role: 'optional' }], reminders: [15], rrule: 'FREQ=WEEKLY;COUNT=2' });
  const req = ics.itip('REQUEST', text, {});
  assert.match(req, /^METHOD:REQUEST\r$/m);
  assert.ok(req.indexOf('BEGIN:VTIMEZONE') < req.indexOf('BEGIN:VEVENT'));
  const rep = ics.itip('REPLY', text, { me: 'bob@example.com', response: 'tentative', comment: 'Evtl. später' });
  assert.equal((rep.match(/^ATTENDEE/gm) || []).length, 1);
  assert.match(rep, /PARTSTAT=TENTATIVE/);
  assert.match(rep, /COMMENT:Evtl\. später/);
  assert.ok(!/BEGIN:VALARM/.test(rep));
  const co = ics.itip('COUNTER', text, { me: 'bob@example.com', response: 'tentative', proposed: { start: start + 3600000, end: start + 7200000, timeZone: BERLIN } });
  const cf = ics.fieldsOf(ics.parse(co).objects[0].master, ctx());
  assert.equal(cf.start, start + 3600000);
  const cancel = ics.itip('CANCEL', text, { occ: String(start + 7 * 86400000), userTz: BERLIN });
  const cp = ics.parse(cancel);
  assert.deepEqual([cp.method, cp.objects[0].master, cp.objects[0].overrides.length], ['CANCEL', null, 1]);
  assert.match(cancel, /STATUS:CANCELLED/);
  const ps = ics.fieldsOf(ics.parse(ics.partstat(text, 'bob@example.com', 'declined')).objects[0].master, ctx());
  assert.deepEqual(ps.attendees.map((a) => [a.email, a.response]), [['bob@example.com', 'declined'], ['cara@example.com', 'needs_action']]);
});

test('vCard 3.0 / 4.0: fields, unknown properties stay, a birthday without year, the photo apart, export as 4.0', () => {
  const text = ['BEGIN:VCARD', 'VERSION:3.0', 'UID:c1', 'FN:Dr. Anna Lang', 'N:Lang;Anna;;Dr.;', 'NICKNAME:Anni', 'EMAIL;TYPE=INTERNET,WORK,PREF:anna@firma.example',
    'EMAIL;TYPE=INTERNET,HOME:anna@privat.example', 'TEL;TYPE=CELL:0170 123', 'TEL;TYPE=WORK,FAX:030 999', 'ORG:Firma GmbH;Einkauf', 'TITLE:Leiterin', 'ADR;TYPE=WORK:;;Hauptstr. 1;Berlin;;10115;DE',
    'BDAY;X-APPLE-OMIT-YEAR=1604:1604-04-01', 'NOTE:Zeile 1\\nZeile 2', 'X-SOCIALPROFILE;TYPE=twitter:anna', 'PHOTO;ENCODING=b;TYPE=JPEG:QUJD', 'END:VCARD', ''].join('\r\n');
  const [c] = vcard.parseAll(text);
  const photo = vcard.takePhoto(c);
  const f = vcard.fieldsOf(c);
  assert.deepEqual([f.name.display, f.name.prefix, f.name.nickname, f.emails.map((e) => [e.value, e.type, e.primary]), f.phones.map((p) => p.type), f.company, f.department, f.title, f.birthday, f.note],
    ['Dr. Anna Lang', 'Dr.', 'Anni', [['anna@firma.example', 'work', true], ['anna@privat.example', 'home', false]], ['mobile', 'fax'], 'Firma GmbH', 'Einkauf', 'Leiterin', '--04-01', 'Zeile 1\nZeile 2']);
  assert.deepEqual(photo, { mime: 'image/jpeg', data: 'QUJD' });
  vcard.apply(c, vcard.check({ phones: [{ value: '0170 123', type: 'mobile' }], birthday: '1980-04-01' }));
  const back = vcard.toText(c, photo);
  assert.match(back, /X-SOCIALPROFILE;TYPE=twitter:anna/);
  assert.match(back, /BDAY[^:]*:1980-?04-?01/);
  assert.match(back, /PHOTO;ENCODING=b;TYPE=JPEG:QUJD/);
  const v4 = vcard.asV4(c, photo);
  assert.match(v4, /VERSION:4\.0/);
  assert.match(v4, /PHOTO:data:image\/jpeg;base64,QUJD/);
  assert.equal(vcard.fieldsOf(vcard.parseAll(v4)[0]).emails.length, 2);
  assert.throws(() => vcard.parseAll('nichts'), (e) => e.code === 'invalid_vcard');
  assert.equal(vcard.digits('+49 (170) 123-4567'), vcard.digits('0170/1234567'));
});
