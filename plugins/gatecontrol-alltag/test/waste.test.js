'use strict';

// Müllabfuhr: fraction mapping, rules and exceptions, the ICS and rules
// sources through the admin API, fail-soft refreshes with backoff.

const test = require('node:test');
const assert = require('node:assert/strict');
const fractions = require('../server/fractions');
const schedule = require('../server/schedule');
const waste = require('../server/waste');
const config = require('../server/config');
const { withHost, asAdmin, day, compact, vcal, vevent, fixture, fixtureFetch } = require('./helpers');

test('fractions: provider and ICS names map to known types by keyword', () => {
  const cases = {
    'Restmüll': 'rest', 'Restabfall 2wö': 'rest', 'Graue Tonne gewerblich': 'rest', 'Hausmüll': 'rest',
    'Bio 2wö': 'bio', 'Biotonne': 'bio', 'Braune Tonne': 'bio',
    'Papiertonne': 'paper', 'Altpapier 4wö 1100': 'paper', 'Blaue Tonne': 'paper', 'PPK': 'paper',
    'Gelber Sack': 'yellow', 'Gelbe Tonne': 'yellow', 'Wertstofftonne': 'yellow', 'Leichtverpackungen': 'yellow',
    'Glas': 'glass', 'Altglas': 'glass',
    'Sperrmüll': 'bulky',
    'Schadstoffmobil Altendorf': 'hazardous', 'Problemabfall': 'hazardous', 'Sondermüll': 'hazardous',
    'Grünschnitt': 'green', 'Weihnachtsbäume': 'green', 'Christbaumabholung': 'green', 'Laubsack Nord': 'green', 'Gartenabfälle': 'green',
    'Pinke Tonne': 'other', 'Elektrokleingeräte': 'other', '': 'other',
  };
  for (const [name, type] of Object.entries(cases)) assert.equal(fractions.classify(name), type, name);
  assert.equal(fractions.normalize('  Gelber   Sack '), 'gelber sack');
  assert.equal(fractions.normalize('Grünschnitt'), 'grunschnitt');
  assert.deepEqual(fractions.present({ id: 1, source_name: 'Bio 2wö', type: 'bio', name: null, color: null, hidden: 0 }), { id: 1, name: 'Bio 2wö', type: 'bio', color: fractions.COLORS.bio, hidden: false });
  assert.deepEqual(fractions.present({ id: 1, source_name: 'x', type: 'nonsense', name: 'Tonne', color: '#ABCDEF', hidden: 1 }), { id: 1, name: 'Tonne', type: 'other', color: '#abcdef', hidden: true });
  for (const t of fractions.TYPES) { assert.match(fractions.COLORS[t], /^#[0-9a-f]{6}$/); assert.ok(fractions.ICONS[t]); }
});

test('rules: every N weeks from the first date, until, window', () => {
  const rules = [schedule.cleanRule({ name: 'Restmüll', start: '2026-01-07', weeks: 2 }), schedule.cleanRule({ name: 'Papier', start: '2026-01-05', weeks: 4, until: '2026-03-01', type: 'paper' })];
  const out = schedule.fromRules(rules, '2026-01-01', '2026-03-31');
  assert.deepEqual(out.filter((e) => e.name === 'Papier').map((e) => e.date), ['2026-01-05', '2026-02-02']);
  assert.deepEqual(out.filter((e) => e.name === 'Restmüll').map((e) => e.date).slice(0, 3), ['2026-01-07', '2026-01-21', '2026-02-04']);
  assert.equal(out.filter((e) => e.name === 'Restmüll').length, 6);
  // a window long after the first date starts at the right step
  assert.deepEqual(schedule.fromRules([rules[0]], '2027-01-01', '2027-01-31').map((e) => e.date), ['2027-01-06', '2027-01-20']);
  for (const bad of [{ name: '', start: '2026-01-01', weeks: 1 }, { name: 'x', start: '2026-02-30', weeks: 1 }, { name: 'x', start: '2026-01-01', weeks: 0 }, { name: 'x', start: '2026-01-01', weeks: 53 }, { name: 'x', start: '2026-01-10', weeks: 1, until: '2026-01-01' }]) {
    assert.equal(schedule.cleanRule(bad), null, JSON.stringify(bad));
  }
});

test('exceptions: a date cancelled or moved, for one fraction or all; no duplicates', () => {
  const entries = [{ date: '2026-12-24', name: 'Restmüll' }, { date: '2026-12-24', name: 'Papier' }, { date: '2026-12-28', name: 'Bio' }];
  const ex = schedule.cleanList([{ date: '2026-12-24', name: 'restmüll', to: '2026-12-27' }, { date: '2026-12-28', to: null }], schedule.cleanException, 10);
  assert.deepEqual(schedule.applyExceptions(entries, ex), [{ date: '2026-12-24', name: 'Papier' }, { date: '2026-12-27', name: 'Restmüll', moved: '2026-12-24' }]);
  assert.deepEqual(schedule.applyExceptions(entries, [{ date: '2026-12-24', name: null, to: null }]).map((e) => e.date), ['2026-12-28']);
  assert.equal(schedule.cleanException({ date: '2026-12-24', to: '2026-12-24' }), null);
  assert.equal(schedule.cleanList([{ date: 'x' }], schedule.cleanException, 10), null);
});

test('ICS source: upload through the API, fractions created, dates and next pickups', () => withHost({}, async (host) => {
  const ics = vcal(
    vevent(['UID:r1', `DTSTART;VALUE=DATE:${compact(day(1))}`, 'RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=10', 'SUMMARY:Restmüll']),
    vevent(['UID:g1', `DTSTART;VALUE=DATE:${compact(day(1))}`, 'SUMMARY:Gelber Sack']),
    vevent(['UID:p1', `DTSTART;VALUE=DATE:${compact(day(3))}`, 'SUMMARY:Papiertonne']),
  );
  const pre = await asAdmin(host, 'POST', '/ics/preview', { ics });
  assert.equal(pre.status, 200);
  assert.deepEqual(pre.json.fractions.map((f) => f.type).sort(), ['paper', 'rest', 'yellow']);
  const r = await asAdmin(host, 'POST', '/plans', { name: 'Zuhause', source: 'ics', ics, ics_name: 'abfall.ics' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.result.ok, true);
  const st = await asAdmin(host, 'GET', '/status');
  const plan = st.json.plans[0];
  assert.equal(plan.status, 'ok');
  assert.equal(plan.ics_name, 'abfall.ics');
  assert.deepEqual(plan.fractions.map((f) => [f.name, f.type]).sort(), [['Gelber Sack', 'yellow'], ['Papiertonne', 'paper'], ['Restmüll', 'rest']]);
  assert.equal(plan.upcoming[0].date, day(1));
  assert.equal(plan.upcoming[0].label, 'morgen');
  assert.deepEqual(plan.upcoming[0].fractions.map((f) => f.name).sort(), ['Gelber Sack', 'Restmüll']);
  assert.equal(plan.users, null, 'default: everyone');
  assert.ok(!JSON.stringify(st.json).includes('BEGIN:VCALENDAR'), 'the uploaded file is not sent back');
  // rename + hide a fraction
  const yellow = plan.fractions.find((f) => f.type === 'yellow');
  const f = await asAdmin(host, 'PUT', `/plans/${plan.id}/fractions/${yellow.id}`, { name: 'Wertstoffe', color: '#FFCC00', hidden: true });
  assert.equal(f.status, 200);
  assert.deepEqual([f.json.fraction.name, f.json.fraction.color, f.json.fraction.hidden], ['Wertstoffe', '#ffcc00', true]);
  const st2 = await asAdmin(host, 'GET', '/status');
  assert.deepEqual(st2.json.plans[0].upcoming[0].fractions.map((x) => x.name), ['Restmüll'], 'hidden fractions are left out');
  // invalid uploads
  assert.equal((await asAdmin(host, 'POST', '/plans', { name: 'X', source: 'ics', ics: 'hello' })).json.code, 'ICS_INVALID');
  assert.equal((await asAdmin(host, 'POST', '/plans', { name: 'X', source: 'ics', ics: 'BEGIN:VCALENDAR\r\n' + 'x'.repeat(waste.ICS_MAX_CHARS) })).json.code, 'ICS_TOO_LARGE');
  assert.equal((await asAdmin(host, 'POST', '/plans', { name: 'X', source: 'ics', ics: vcal() })).json.code, 'ICS_EMPTY');
  assert.equal((await asAdmin(host, 'POST', '/plans', { name: 'X', source: 'ics' })).json.code, 'ICS_REQUIRED');
}));

test('rules source with exceptions and selected people; validation', () => withHost({}, async (host) => {
  const r = await asAdmin(host, 'POST', '/plans', {
    name: 'Eltern', source: 'rules', users: [2],
    rules: [{ name: 'Restmüll', start: day(2), weeks: 2 }, { name: 'Bio', start: day(5), weeks: 1, type: 'bio' }],
    exceptions: [{ date: day(5), name: 'Bio', to: day(6) }],
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const dates = (await asAdmin(host, 'GET', `/plans/${r.json.plan.id}/dates`)).json.dates;
  assert.deepEqual(dates.slice(0, 3).map((d) => [d.date, d.name]), [[day(2), 'Restmüll'], [day(6), 'Bio'], [day(12), 'Bio']]);
  const st = await asAdmin(host, 'GET', '/status');
  assert.deepEqual(st.json.plans[0].users.map((u) => u.username), ['Ada']);
  assert.equal((await asAdmin(host, 'POST', '/plans', { name: 'X', source: 'rules', rules: [] })).json.code, 'RULES_REQUIRED');
  assert.equal((await asAdmin(host, 'POST', '/plans', { name: 'X', source: 'rules', rules: [{ name: 'a', start: 'x', weeks: 1 }] })).json.code, 'INVALID');
  assert.equal((await asAdmin(host, 'POST', '/plans', { name: 'X', source: 'rules', rules: [{ name: 'a', start: day(1), weeks: 1 }], users: [99] })).json.code, 'USERS_INVALID');
  assert.equal((await asAdmin(host, 'POST', '/plans', { name: '', source: 'rules' })).json.code, 'NAME_REQUIRED');
  // switching the source to ICS needs a file; to rules again keeps working
  assert.equal((await asAdmin(host, 'PUT', `/plans/${r.json.plan.id}`, { source: 'ics' })).json.code, 'ICS_REQUIRED');
  assert.equal((await asAdmin(host, 'PUT', `/plans/${r.json.plan.id}`, { name: 'Eltern (Köln)' })).status, 200);
  assert.equal((await asAdmin(host, 'DELETE', `/plans/${r.json.plan.id}`)).json.ok, true);
  assert.equal((await asAdmin(host, 'GET', '/status')).json.plans.length, 0);
}));

test('provider plan: fails soft — the last good dates stay, the error shows, retries back off', () => {
  const fx = fixture('provider_regioit.json');
  let online = true;
  const handler = fixtureFetch(fx);
  return withHost({ web: (url, o) => (online ? handler(url, o) : { status: 503, body: 'down' }) }, async (host) => {
    const cfg = config.fromSettings({});
    const r = await asAdmin(host, 'POST', '/plans', { name: 'Aachen', source: 'provider', provider: 'regioit', provider_config: fx.config });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const store = require('../server/store');
    const now = Date.parse(`${fx.window.from}T10:00:00Z`);
    let plan = await store.getPlan(host.gc, r.json.plan.id);
    // the window of the recording: dates within it are stored
    const res = await waste.refreshPlan(host.gc, plan, cfg, now);
    assert.equal(res.ok, true);
    const stored = await store.countDates(host.gc, plan.id, fx.window.from);
    assert.equal(stored, fx.expected.dates);
    plan = await store.getPlan(host.gc, plan.id);
    assert.ok(plan.next_refresh_at >= now + waste.PROVIDER_EVERY, 'at most twice a day');
    online = false;
    const t1 = now + 13 * 3600000;
    const bad = await waste.refreshPlan(host.gc, plan, cfg, t1);
    assert.deepEqual(bad, { ok: false, code: 'PROVIDER_HTTP' });
    plan = await store.getPlan(host.gc, plan.id);
    assert.equal(plan.status, 'error');
    assert.equal(plan.last_error, 'PROVIDER_HTTP');
    assert.equal(plan.next_refresh_at, t1 + waste.BACKOFF[0]);
    assert.equal(await store.countDates(host.gc, plan.id, fx.window.from), stored, 'last good dates kept');
    await waste.refreshPlan(host.gc, plan, cfg, t1 + 1);
    plan = await store.getPlan(host.gc, plan.id);
    assert.equal(plan.next_refresh_at, t1 + 1 + waste.BACKOFF[1], 'the next try waits longer');
    // the background run only picks up what is due, at most PER_TICK plans
    const calls = host.webCalls.length;
    assert.equal(await waste.tick(host.gc, cfg, t1 + 2), 0);
    assert.equal(host.webCalls.length, calls, 'nothing due: no request');
    assert.equal(await waste.tick(host.gc, cfg, t1 + 20 * 3600000, Date.now() - 1), 0, 'due, but past the tick budget: nothing started');
    assert.equal(host.webCalls.length, calls);
    const st = await asAdmin(host, 'GET', '/status');
    assert.equal(st.json.plans[0].error_text, 'Der Anbieter hat mit einem Fehler geantwortet.');
  });
});
