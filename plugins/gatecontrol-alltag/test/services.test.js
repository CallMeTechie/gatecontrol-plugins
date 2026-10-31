'use strict';

// Services for other plugins (1.3.0, services.provides): calendar_query and
// calendar_list — the calendars a person sees (an administrator: all), range
// and filters checked, answers small enough for the host (≤ 16 KB).

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, asAdmin, ADMIN, ADA, BOB, day, utc, vcal, vevent } = require('./helpers');
const manifest = require('../plugin.json');

const H = 3600000;

function household() {
  const now = Date.now();
  const many = [];
  for (let i = 0; i < 70; i++) many.push(vevent([`UID:m${i}`, `DTSTART:${utc(now + 30 * H + i * 60000)}`, `DTEND:${utc(now + 31 * H + i * 60000)}`, `SUMMARY:Termin ${i}`]));
  const work = vcal(
    vevent(['UID:a', `DTSTART:${utc(now + 26 * H)}`, `DTEND:${utc(now + 27 * H)}`, 'SUMMARY:Arbeit Frühschicht']),
    vevent(['UID:z', `DTSTART:${utc(now + 28 * H)}`, `DTEND:${utc(now + 29 * H)}`, 'SUMMARY:Zahnarzt']),
    vevent(['UID:f', `DTSTART;VALUE=DATE:${day(3).replace(/-/g, '')}`, `DTEND;VALUE=DATE:${day(4).replace(/-/g, '')}`, 'SUMMARY:Ferien']),
  );
  const school = vcal(...many);
  return { web: (url) => ({ status: 200, body: url.includes('/work/') ? work : school }) };
}

async function setup(host) {
  const a = await asAdmin(host, 'POST', '/subscriptions', { name: 'Arbeit', color: '#cc3366', source: 'url', url: 'https://calendar.google.com/calendar/ical/x/work/basic.ics', users: [ADA.id] });
  const b = await asAdmin(host, 'POST', '/subscriptions', { name: 'Schule', color: '#3366cc', source: 'url', url: 'https://calendar.google.com/calendar/ical/x/school/basic.ics', users: [ADA.id, BOB.id] });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  return { work: a.json.subscription ? a.json.subscription.id : a.json.id, school: b.json.subscription ? b.json.subscription.id : b.json.id };
}

const call = (host, name, payload, user) => host.callService(name, { caller: 'gatecontrol-familie', user: user || null, payload });

test('plugin.json: calendar_query and calendar_list in services.provides (1800 an hour); version 1.4.0', () => {
  assert.equal(manifest.version, '1.4.0');
  assert.deepEqual(Object.keys(manifest.services.provides), ['calendar_query', 'calendar_list']);
  for (const s of Object.values(manifest.services.provides)) assert.ok(s.label.de && s.label.en && s.label.de.length <= 60 && s.label.en.length <= 60);
  // 1.4.0: Mail shows the calendars of every person — 1800 calls an hour per service (maxPerHour needs GateControl 1.216.0)
  for (const s of Object.values(manifest.services.provides)) assert.equal(s.maxPerHour, 1800);
  assert.equal(manifest.gatecontrol, '>=1.216.0', 'services.provides maxPerHour: older hosts refuse the key');
});

test('calendar_query: the person\'s calendars only, match and subIds, all-day events, the subscriptions', () => withHost(household(), async (host) => {
  const ids = await setup(host);
  const r = await call(host, 'calendar_query', { from: day(0), to: day(2), match: 'arbeit' }, { id: ADA.id, name: 'Ada', role: 'user' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.events.map((e) => [e.title, e.subName, e.allDay]), [['Arbeit Frühschicht', 'Arbeit', false]]);
  const e = r.events[0];
  assert.equal(e.subId, ids.work);
  assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(e.time, /^\d\d:\d\d$/);
  assert.ok(Number.isSafeInteger(e.startMs));
  assert.deepEqual(r.subscriptions.map((s) => s.name), ['Arbeit', 'Schule']);
  // Bob does not see „Arbeit“
  const b = await call(host, 'calendar_query', { from: day(0), to: day(5), match: 'Arbeit' }, { id: BOB.id, name: 'Bob', role: 'user' });
  assert.deepEqual([b.events, b.subscriptions.map((s) => s.name)], [[], ['Schule']]);
  // an administrator sees every calendar
  const adm = await call(host, 'calendar_query', { from: day(0), to: day(5), match: 'zahn' }, { id: ADMIN.id, name: 'admin', role: 'admin' });
  assert.deepEqual(adm.events.map((x) => x.title), ['Zahnarzt']);
  // all-day: listed on its date, no time
  const f = await call(host, 'calendar_query', { from: day(3), to: day(3), subIds: [ids.work] }, { id: ADA.id, name: 'Ada', role: 'user' });
  assert.deepEqual(f.events.map((x) => [x.title, x.date, x.allDay, x.time]), [['Ferien', day(3), true, null]]);
  // subIds of a calendar the person does not see: nothing
  assert.deepEqual((await call(host, 'calendar_query', { from: day(0), to: day(5), subIds: [ids.work] }, { id: BOB.id, name: 'Bob', role: 'user' })).events, []);
  // at most 50 events, small enough for the host; 1.4.0: the rest with `next` as `cursor`
  const bob = { id: BOB.id, name: 'Bob', role: 'user' };
  const many = await call(host, 'calendar_query', { from: day(0), to: day(3), subIds: [ids.school] }, bob);
  assert.equal(many.events.length, 50);
  assert.ok(Buffer.byteLength(JSON.stringify(many)) < 16 * 1024);
  assert.equal(many.next, '50');
  const rest = await call(host, 'calendar_query', { from: day(0), to: day(3), subIds: [ids.school], cursor: many.next }, bob);
  assert.deepEqual([rest.events.length, rest.next], [20, null]);
  assert.deepEqual([...many.events, ...rest.events].map((x) => x.title), Array.from({ length: 70 }, (_, i) => `Termin ${i}`));
  // 1.4.0: the end, the key and the place of every event
  const z = (await call(host, 'calendar_query', { from: day(0), to: day(2), match: 'zahn' }, { id: ADA.id, name: 'Ada', role: 'user' })).events[0];
  assert.equal(z.endMs - z.startMs, H);
  assert.equal(z.uid, `z|${z.startMs}`, 'the occurrence: UID and start');
  assert.equal(z.location, null);
  assert.equal(r.next, null, 'one page');
  // no user: nothing
  assert.deepEqual(await call(host, 'calendar_query', { from: day(0), to: day(5) }), { ok: true, events: [], subscriptions: [], next: null });
}));

test('calendar_query: refusals; calendar_list; the area switched off', () => withHost(household(), async (host) => {
  await setup(host);
  const ada = { id: ADA.id, name: 'Ada', role: 'user' };
  for (const p of [{}, { from: 'heute' }, { from: day(0), to: day(-1) }, { from: day(0), to: day(63) }, { from: '2026-02-30' }, { from: day(0), subIds: 'x' },
    { from: day(0), subIds: [0] }, { from: day(0), match: 5 }, { from: day(0), match: 'x'.repeat(81) }, { from: day(0), cursor: 5 }, { from: day(0), cursor: 'abc' }]) {
    assert.deepEqual(await call(host, 'calendar_query', p, ada), { ok: false, code: 'invalid' }, JSON.stringify(p));
  }
  assert.equal((await call(host, 'calendar_query', { from: day(0), to: day(62) }, ada)).ok, true, '62 days');
  assert.deepEqual((await call(host, 'calendar_list', {}, ada)).subscriptions.map((s) => s.name), ['Arbeit', 'Schule']);
  assert.deepEqual((await call(host, 'calendar_list', {}, { id: BOB.id, name: 'Bob', role: 'user' })).subscriptions.map((s) => s.name), ['Schule']);
  assert.deepEqual(await call(host, 'calendar_list', {}), { ok: true, subscriptions: [] });
  host.settings.calendar_enabled = false;
  assert.deepEqual(await call(host, 'calendar_query', { from: day(0), to: day(5) }, ada), { ok: true, events: [], subscriptions: [], next: null });
  assert.deepEqual(await call(host, 'calendar_list', {}, ada), { ok: true, subscriptions: [] });
}));
