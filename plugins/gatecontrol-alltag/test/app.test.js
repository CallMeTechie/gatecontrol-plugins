'use strict';

// App API (1.2.0, permissions.app): GET app/events — the caller's calendar
// events and waste pickups for the GateControl app, same visibility as the
// portal; only for app callers; at most 62 days.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, asAdmin, ADA, BOB, day, utc, vcal, vevent } = require('./helpers');

const H = 3600000;
const SECRET = 'private-feedfacefeedface';

function household() {
  const now = Date.now();
  const text = vcal(
    vevent(['UID:z', `DTSTART:${utc(now + 26 * H)}`, `DTEND:${utc(now + 27 * H)}`, 'SUMMARY:Zahnarzt', 'LOCATION:Praxis Dr. Muster']),
    vevent(['UID:f', `DTSTART;VALUE=DATE:${day(3).replace(/-/g, '')}`, `DTEND;VALUE=DATE:${day(5).replace(/-/g, '')}`, 'SUMMARY:Ferienlager']),
    vevent(['UID:far', `DTSTART:${utc(now + 90 * 24 * H)}`, 'SUMMARY:Zahnreinigung']),
  );
  return { web: () => ({ status: 200, body: text }) };
}

async function setup(host) {
  await asAdmin(host, 'POST', '/plans', { name: 'Zuhause', source: 'rules', rules: [{ name: 'Gelber Sack', start: day(1), weeks: 2 }, { name: 'Papier', start: day(1), weeks: 4 }] });
  await asAdmin(host, 'POST', '/plans', { name: 'Eltern', source: 'rules', users: [BOB.id], rules: [{ name: 'Restmüll', start: day(2), weeks: 1 }] });
  const s = await asAdmin(host, 'POST', '/subscriptions', { name: 'Ada privat', color: '#cc3366', source: 'url', url: `https://calendar.google.com/calendar/ical/ada/${SECRET}/basic.ics`, users: [ADA.id] });
  assert.equal(s.status, 201);
}

const asApp = (host, user, query) => host.request({ method: 'GET', path: '/app/events', query: query || {}, user: { ...user, portal: true, loggedIn: true, app: true } });

test('app/events: the caller\'s calendars and plans, with calendar colour and pickup kinds', () => withHost(household(), async (host) => {
  await setup(host);
  const r = await asApp(host, ADA, { from: day(0), to: day(10) });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.events.map((e) => e.title), ['Zahnarzt', 'Ferienlager'], 'within the range only');
  const z = r.json.events[0];
  assert.match(z.time, /^\d\d:\d\d$/);
  assert.match(z.endTime, /^\d\d:\d\d$/);
  assert.equal(z.allDay, false);
  assert.equal(z.location, 'Praxis Dr. Muster');
  assert.deepEqual(z.calendar, { id: z.calendar.id, name: 'Ada privat', color: '#cc3366' });
  assert.match(z.id, /^\d+:[0-9a-f]{16}$/);
  const f = r.json.events[1];
  assert.deepEqual([f.date, f.allDay, f.time, f.endTime, f.endDate], [day(3), true, null, null, day(4)], 'all-day over two days: inclusive end date');
  // waste: the plan for everyone, not the restricted one
  assert.deepEqual(r.json.waste[0], {
    date: day(1), kinds: ['Gelber Sack', 'Papier'], color: r.json.waste[0].fractions[0].color,
    plan: { id: r.json.waste[0].plan.id, name: 'Zuhause' }, fractions: r.json.waste[0].fractions,
  });
  assert.match(r.json.waste[0].color, /^#[0-9a-f]{6}$/);
  assert.ok(r.json.waste.every((w) => w.plan.name === 'Zuhause'));
  assert.ok(!JSON.stringify(r.json).includes(SECRET), 'never the calendar address');
  // Bob: no calendar, both plans
  const b = await asApp(host, BOB, { from: day(0), to: day(10) });
  assert.deepEqual(b.json.events, []);
  assert.deepEqual([...new Set(b.json.waste.map((w) => w.plan.name))].sort(), ['Eltern', 'Zuhause']);
  assert.deepEqual(b.json.waste.map((w) => w.date), [...b.json.waste.map((w) => w.date)].sort(), 'sorted by date');
}));

test('app/events: app callers only, range checked, switched-off areas empty', () => withHost(household(), async (host) => {
  await setup(host);
  const portal = await host.request({ method: 'GET', path: '/app/events', query: {}, user: { ...ADA, portal: true, loggedIn: true } });
  assert.equal(portal.status, 403, 'portal viewer');
  const admin = await host.request({ method: 'GET', path: '/app/events', query: {}, user: { id: 1, name: 'admin', role: 'admin' } });
  assert.equal(admin.status, 403, 'admin page');
  assert.equal((await asApp(host, ADA, { from: day(0), to: day(63) })).status, 400, 'more than 62 days');
  assert.equal((await asApp(host, ADA, { from: day(0), to: day(62) })).status, 200);
  assert.equal((await asApp(host, ADA, { from: day(5), to: day(1) })).status, 400, 'to before from');
  assert.equal((await asApp(host, ADA, { from: '2026-02-30', to: day(1) })).status, 400, 'no such date');
  const def = await asApp(host, ADA);
  assert.equal(def.status, 200, 'defaults: today + 31 days');
  assert.ok(def.json.events.some((e) => e.title === 'Zahnarzt'));
  assert.equal((await host.request({ method: 'POST', path: '/app/events', user: { ...ADA, portal: true, loggedIn: true, app: true } })).status, 404);
  host.settings.calendar_enabled = false;
  host.settings.waste_enabled = false;
  const off = await asApp(host, ADA, { from: day(0), to: day(10) });
  assert.deepEqual([off.json.events, off.json.waste], [[], []]);
  // the app user never reaches the admin API
  assert.equal((await host.request({ method: 'GET', path: '/status', user: { id: 1, name: 'admin', role: 'admin', portal: true, loggedIn: true, app: true } })).status, 403);
}));
