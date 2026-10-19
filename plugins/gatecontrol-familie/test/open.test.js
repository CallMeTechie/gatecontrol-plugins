'use strict';

// Open reminders in the app and the holiday mode (1.11.0): GET rules `open` — one's own for children,
// every member's (with userId) for parents and the admin page; „Erledigt“ / „In 1 Std.“ through
// POST rules/open/<ruleId>/done | snooze (only one's own, at most 3 notifications a day); PUT
// rules/vacation pauses every active house rule and resumes exactly those, by hand or after `until`.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withFamily, ANNA, LENA, MIN, HOUR } = require('./helpers');

const REMIND = (extra = {}) => ({
  title: 'Müll rausbringen', trigger: { type: 'schedule', weekdays: [3], time: '10:30' },
  actions: [{ type: 'notify', to: 'me', text: 'Heute ist Abholung' }], ...extra,
});

test('open reminders: children their own, parents and the admin page everyone\'s; done and snooze only one\'s own', () => withFamily({}, async (host, { as, admin, clock }) => {
  host.settings.children_own_rules = true;
  const lenas = (await as(LENA)('POST', '/rules', REMIND())).json.rule;
  const annas = (await as(ANNA)('POST', '/rules', REMIND({ title: 'Papiertonne' }))).json.rule;
  clock.add(30 * MIN);
  await host.tick();
  assert.equal(host.notifications.length, 2);
  const key = 'sched:2026-10-14';

  const lena = (await as(LENA)('GET', '/rules')).json.open;
  assert.deepEqual(lena, [{ ruleId: lenas.id, title: 'Müll rausbringen', key, state: 'open', since: '2026-10-14T08:30:00Z', snoozeUntil: null, userId: LENA.id, actionIds: [] }]);
  assert.deepEqual((await as(ANNA)('GET', '/rules')).json.open.map((x) => [x.ruleId, x.userId]).sort(), [[annas.id, ANNA.id], [lenas.id, LENA.id]].sort());
  assert.equal((await admin('GET', 'rules')).json.open.length, 2);

  // a parent sees Lena's but cannot tick it off; wrong key, wrong action
  const foreign = await as(ANNA)('POST', `/rules/open/${lenas.id}/done`, { key });
  assert.deepEqual([foreign.status, foreign.json.code], [404, 'not_found']);
  assert.equal((await as(LENA)('POST', `/rules/open/${lenas.id}/done`, {})).json.code, 'invalid');
  assert.equal((await as(LENA)('POST', `/rules/open/${lenas.id}/done`, { key: 'sched:2026-10-13' })).json.code, 'not_found');
  assert.equal((await as(LENA)('POST', `/rules/open/${lenas.id}/later`, { key })).json.code, 'not_found');

  // snooze: again an hour later (at most 3 a day), then done
  const s = await as(LENA)('POST', `/rules/open/${lenas.id}/snooze`, { key });
  assert.deepEqual([s.status, s.json], [200, { ok: true, state: 'snoozed', until: '2026-10-14T09:30:00.000Z' }]);
  assert.deepEqual((await as(LENA)('GET', '/rules')).json.open.map((x) => [x.state, x.snoozeUntil]), [['snoozed', '2026-10-14T09:30:00Z']]);
  clock.add(HOUR);
  await host.tick();
  assert.equal(host.notifications.length, 3);
  assert.equal((await as(LENA)('POST', `/rules/open/${lenas.id}/snooze`, { key })).status, 200);
  clock.add(HOUR);
  await host.tick();
  assert.equal(host.notifications.length, 4);
  const limit = await as(LENA)('POST', `/rules/open/${lenas.id}/snooze`, { key });
  assert.deepEqual([limit.status, limit.json.code], [429, 'daily_limit']);
  assert.deepEqual((await as(LENA)('POST', `/rules/open/${lenas.id}/done`, { key })).json, { ok: true, state: 'done' });
  assert.deepEqual((await as(LENA)('GET', '/rules')).json.open, []);
  assert.deepEqual((await as(ANNA)('GET', '/rules')).json.open.map((x) => x.ruleId), [annas.id]);
  assert.equal((await as(LENA)('POST', `/rules/open/${lenas.id}/done`, { key })).json.code, 'not_found', 'done already');
}));

test('holiday mode: parents only; pauses the active house rules and resumes exactly those, by hand or after the last day', () => withFamily({}, async (host, { as, admin, clock }) => {
  const house = (await as(ANNA)('POST', '/rules', REMIND({ title: 'Haus', scope: 'house', actions: [{ type: 'notify', to: 'all' }] }))).json.rule;
  const paused = (await as(ANNA)('POST', '/rules', REMIND({ title: 'Pausiert', scope: 'house', actions: [{ type: 'notify', to: 'all' }] }))).json.rule;
  await as(ANNA)('PATCH', `/rules/${paused.id}`, { active: false });
  const own = (await as(ANNA)('POST', '/rules', REMIND({ title: 'Eigene', scope: 'personal' }))).json.rule;
  const active = async () => Object.fromEntries((await as(ANNA)('GET', '/rules')).json.rules.map((x) => [x.title, x.active]));

  assert.deepEqual((await as(ANNA)('GET', '/rules')).json.vacation, { on: false, until: null, since: null, paused: 0 });
  assert.equal((await as(LENA)('PUT', '/rules/vacation', { on: true })).json.code, 'parents_only');
  assert.equal((await as(ANNA)('PUT', '/rules/vacation', {})).json.field, 'on');
  assert.equal((await as(ANNA)('PUT', '/rules/vacation', { on: true, until: '2026-10-13' })).json.field, 'until', 'in the past');
  assert.equal((await as(ANNA)('PUT', '/rules/vacation', { on: true, until: '16.10.2026' })).json.field, 'until');

  const on = await as(ANNA)('PUT', '/rules/vacation', { on: true, until: '2026-10-16' });
  assert.deepEqual([on.status, on.json.vacation], [200, { on: true, until: '2026-10-16', since: '2026-10-14T08:00:00.000Z', paused: 1 }]);
  assert.deepEqual(await active(), { Haus: false, Pausiert: false, Eigene: true });
  clock.add(30 * MIN);
  await host.tick();
  assert.deepEqual(host.notifications.map((x) => x.title), ['Eigene'], 'house rules rest');
  // longer: only the end moves
  assert.deepEqual((await as(ANNA)('PUT', '/rules/vacation', { on: true, until: '2026-10-17' })).json.vacation.paused, 1);
  assert.equal((await as(LENA)('GET', '/rules')).json.vacation.until, '2026-10-17', 'children see it');

  clock.set(Date.UTC(2026, 9, 17, 21, 50)); // 23:50 in Berlin, the last day
  await host.tick();
  assert.equal((await as(ANNA)('GET', '/rules')).json.vacation.on, true);
  clock.set(Date.UTC(2026, 9, 17, 22, 10)); // 00:10 the day after
  await host.tick();
  assert.deepEqual((await as(ANNA)('GET', '/rules')).json.vacation, { on: false, until: null, since: null, paused: 0 });
  assert.deepEqual(await active(), { Haus: true, Pausiert: false, Eigene: true }, 'the paused one stays paused');

  // by hand from the admin page, without an end; a rule deleted meanwhile is no trouble
  assert.deepEqual((await admin('PUT', 'rules/vacation', { on: true })).json.vacation.paused, 1);
  await as(ANNA)('DELETE', `/rules/${house.id}`);
  assert.deepEqual((await admin('PUT', 'rules/vacation', { on: false })).json.vacation.on, false);
  assert.deepEqual(await active(), { Pausiert: false, Eigene: true });
  assert.ok(own.id);
}));
