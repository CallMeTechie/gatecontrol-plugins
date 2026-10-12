'use strict';

// Portal: the sections "Müllabfuhr" and "Termine" in "Zuhause", Start tiles
// and search — only what the viewer may see; calendar details only after a
// real login (device trust: a count); never the calendar's address.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, asAdmin, asPortal, ADA, BOB, day, utc, vcal, vevent } = require('./helpers');

const H = 3600000;
const SECRET = 'private-feedfacefeedface';

function household() {
  const now = Date.now();
  const text = vcal(
    vevent(['UID:z', `DTSTART:${utc(now + 2 * H)}`, `DTEND:${utc(now + 3 * H)}`, 'SUMMARY:Zahnarzt', 'LOCATION:Praxis Dr. Muster']),
    vevent(['UID:e', `DTSTART:${utc(now + 50 * H)}`, 'SUMMARY:Elternabend']),
    vevent(['UID:far', `DTSTART:${utc(now + 20 * 24 * H)}`, 'SUMMARY:Zahnreinigung']),
  );
  return { web: () => ({ status: 200, body: text }) };
}

async function setup(host) {
  await asAdmin(host, 'POST', '/plans', { name: 'Zuhause', source: 'rules', rules: [{ name: 'Gelber Sack', start: day(1), weeks: 2 }, { name: 'Papier', start: day(1), weeks: 4 }] });
  await asAdmin(host, 'POST', '/plans', { name: 'Eltern', source: 'rules', users: [BOB.id], rules: [{ name: 'Restmüll', start: day(0), weeks: 1 }] });
  const s = await asAdmin(host, 'POST', '/subscriptions', { name: 'Ada privat', color: '#cc3366', source: 'url', url: `https://calendar.google.com/calendar/ical/ada/${SECRET}/basic.ics`, users: [ADA.id] });
  assert.equal(s.status, 201);
}

test('waste section: every viewer sees the plans for everyone, a restricted plan only its people; read-only also for device trust', () => withHost(household(), async (host) => {
  await setup(host);
  const ada = await asPortal(host, ADA, 'GET', '/portal/waste', false);
  assert.equal(ada.status, 200);
  assert.deepEqual(ada.json.plans.map((p) => p.name), ['Zuhause']);
  const d = ada.json.plans[0].days[0];
  assert.deepEqual([d.date, d.label, d.rel], [day(1), 'morgen', 'tomorrow']);
  assert.deepEqual(d.fractions.map((f) => [f.name, f.type]), [['Gelber Sack', 'yellow'], ['Papier', 'paper']]);
  assert.match(d.fractions[0].color, /^#[0-9a-f]{6}$/);
  const bob = await asPortal(host, BOB, 'GET', '/portal/waste');
  assert.deepEqual(bob.json.plans.map((p) => p.name), ['Zuhause', 'Eltern']);
  assert.equal(bob.json.plans[1].days[0].label, 'heute');
  const en = await host.request({ method: 'GET', path: '/portal/waste', user: { ...BOB, portal: true, loggedIn: true }, lang: 'en' });
  assert.equal(en.json.plans[1].days[0].label, 'today');
  assert.equal(await host.portalVisible(ADA, 'waste'), true);
  host.settings.waste_enabled = false;
  assert.equal(await host.portalVisible(ADA, 'waste'), false, 'area switched off');
  assert.deepEqual((await asPortal(host, ADA, 'GET', '/portal/waste')).json.plans, []);
}));

test('calendar section: only the assigned person; details after a real login, a count for device trust; no address', () => withHost(household(), async (host) => {
  await setup(host);
  const full = await asPortal(host, ADA, 'GET', '/portal/calendar', true);
  assert.equal(full.json.loggedIn, true);
  const events = full.json.days.flatMap((x) => x.events);
  assert.deepEqual(events.map((e) => e.title), ['Zahnarzt', 'Elternabend'], 'today + 7 days only');
  assert.equal(events[0].calendar, 'Ada privat');
  assert.equal(events[0].color, '#cc3366');
  assert.equal(events[0].location, 'Praxis Dr. Muster');
  assert.match(events[0].time, /^\d\d:\d\d$/);
  const trust = await asPortal(host, ADA, 'GET', '/portal/calendar', false);
  assert.deepEqual(trust.json, { ok: true, enabled: true, loggedIn: false, count: 2 }, 'device trust: a count, no titles');
  const bob = await asPortal(host, BOB, 'GET', '/portal/calendar', true);
  assert.deepEqual(bob.json.days, [], 'not assigned: nothing');
  assert.equal(await host.portalVisible(ADA, 'calendar'), true);
  assert.equal(await host.portalVisible(BOB, 'calendar'), false);
  assert.equal(await host.portalVisible(ADA, null), false, 'no own tab');
  for (const r of [full, trust, bob]) assert.ok(!JSON.stringify(r.json).includes(SECRET));
  // the portal API never reaches the admin routes
  assert.equal((await asPortal(host, ADA, 'GET', '/status')).status, 403);
  assert.equal((await asPortal(host, ADA, 'POST', '/portal/calendar')).status, 404);
}));

test('Start tiles: next pickup per plan; today\'s events with the next title only after a real login', () => withHost(household(), async (host) => {
  await setup(host);
  const login = await host.portalTiles({ ...ADA, loggedIn: true });
  const waste = login.find((x) => x.section === 'waste');
  assert.equal(waste.title, 'Nächste Abfuhr');
  assert.equal(waste.value, 'morgen · Gelber Sack, Papier');
  assert.equal(waste.state, 'on');
  const cal = login.find((x) => x.section === 'calendar');
  assert.equal(cal.title, 'Heute');
  // the Zahnarzt appointment is in two hours — today, unless that crosses midnight
  if (cal.value !== 'Keine Termine') assert.match(cal.value, /^1 Termin · nächster \d\d:\d\d Zahnarzt$/);
  const trust = await host.portalTiles({ ...ADA, loggedIn: false });
  const calTrust = trust.find((x) => x.section === 'calendar');
  assert.ok(!/Zahnarzt/.test(calTrust.value), 'no titles for device trust');
  const bob = await host.portalTiles({ ...BOB, loggedIn: true });
  assert.deepEqual(bob.map((x) => x.title), ['Nächste Abfuhr · Zuhause', 'Nächste Abfuhr · Eltern'], 'one tile per plan, no calendar tile');
  for (const tl of [...login, ...trust, ...bob]) assert.ok(tl.icon && /^[MmLlHhVvCcSsQqTtAaZz0-9 .,-]+$/.test(tl.icon));
}));

test('search: upcoming event titles of the viewer, real login only', () => withHost(household(), async (host) => {
  await setup(host);
  const r = await host.portalSearch({ ...ADA, loggedIn: true }, 'zahn');
  assert.deepEqual(r.map((x) => x.title), ['Zahnarzt', 'Zahnreinigung']);
  assert.equal(r[0].section, 'calendar');
  assert.match(r[0].subtitle, / · Ada privat$/);
  assert.deepEqual(await host.portalSearch({ ...ADA, loggedIn: true }, 'praxis'), [r[0]], 'location matches too');
  assert.deepEqual(await host.portalSearch({ ...ADA, loggedIn: false }, 'zahn'), [], 'device trust: nothing');
  assert.deepEqual(await host.portalSearch({ ...BOB, loggedIn: true }, 'zahn'), [], 'not assigned');
}));

test('portal render: the section frames, texts filled, no unresolved keys; every UI text exists in de and en', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const texts = require('../server/texts.json');
  const ui = require('../server/ui');
  const t = (lang, k) => (texts[lang] && texts[lang][k]) || texts.de[k] || k;
  for (const view of [{ view: 'page', lang: 'de' }, { view: 'page', lang: 'en' }, { view: 'portal', section: 'waste', lang: 'de', loggedIn: false }, { view: 'portal', section: 'calendar', lang: 'en', loggedIn: true }]) {
    const html = ui.render(view, t);
    assert.ok(!/\{\{t:/.test(html), 'all keys filled');
    assert.ok(html.includes('window.AT_CTX='));
    assert.ok(!/<\/script>[^<]*<\/script>/.test(html.split('window.AT_CTX=')[1].split(';</script>')[0]));
  }
  const ctx = JSON.parse(ui.render({ view: 'portal', section: 'calendar', lang: 'de', loggedIn: true }, t).split('window.AT_CTX=')[1].split(';</script>')[0]);
  assert.deepEqual([ctx.section, ctx.loggedIn, ctx.view], ['calendar', true, 'portal']);
  // keys used by the pages exist in both languages
  const dir = path.join(__dirname, '..', 'ui');
  const used = new Set();
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/\{\{t:([a-z0-9_.-]+)\}\}|\bT\('([a-z0-9_.-]+)'/g)) used.add(m[1] || m[2]);
  }
  for (const k of used) if (!k.endsWith('.')) for (const l of ['de', 'en']) assert.ok(texts[l][k], `${l}: ${k}`); // 'type.' + x etc. are checked below
  const dyn = [
    ...require('../server/fractions').TYPES.map((x) => 'type.' + x),
    ...require('../server/calendar').REMINDERS.map((x) => 'reminder.' + x),
    ...['off', 0, 1, 2, 3].map((x) => 'remind.' + x),
    ...['timezone', 'waste_evening_time', 'waste_morning_time', 'calendar_allday_time'].map((x) => 'problem.' + x),
    'status.ok', 'status.new', 'status.error',
    ...['CAL_AUTH', 'CAL_NOT_FOUND', 'CAL_HTTP', 'CAL_UNREACHABLE', 'CAL_DENIED', 'ICS_INVALID', 'ICS_TOO_LARGE', 'URL_MISSING', 'TARGET_MISSING', 'CAL_FAILED'].map((x) => 'calerror.' + x),
  ];
  for (const k of dyn) for (const l of ['de', 'en']) assert.ok(texts[l][k], `${l}: ${k}`);
  assert.deepEqual(Object.keys(texts.de).sort(), Object.keys(texts.en).sort());
});
