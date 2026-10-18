'use strict';

// Rules and reminders (1.9.0, module rules): the API `rules` (rights by scope, children only with
// children_own_rules, a personal rule tells only its owner), the trigger 'schedule' (once a day in the
// family's time zone, never for a time already passed when saved, up to 2 hours late), the old API
// presence/rules unchanged, the dry run and the editor's options.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withFamily, ADMIN, ANNA, MARC, LENA, TIM, KUECHE, MIN, portal, kioskViewer } = require('./helpers');

const SK = 'gatecontrol-skoda';
/** A car plugin: Anna and Lena (and the administrator) have the car; runs are recorded. */
function skoda(log) {
  return [{
    plugin: SK, pluginName: 'Fahrzeuge',
    quickActions: (viewer) => ([ANNA.id, LENA.id, ADMIN.id].includes(viewer.id) ? [
      { id: 'car1:climate', title: 'Klima', device: { id: 'car1', title: 'Elroq' } },
      { id: 'car1:charge', title: 'Laden', kind: 'toggle', state: 'off', device: { id: 'car1', title: 'Elroq' } },
    ] : []),
    runQuickAction: (viewer, id) => { log.push({ viewer: viewer.id, id }); return { ok: true, message: 'ok' }; },
  }];
}

const REMIND = (extra = {}) => ({
  title: 'Müll rausbringen', trigger: { type: 'schedule', weekdays: [3], time: '10:30' },
  actions: [{ type: 'notify', to: 'me', text: 'Heute ist Abholung' }], ...extra,
});

test('rights: house rules parents only, own rules for parents, children only with children_own_rules; who sees what', () => withFamily({ actions: skoda([]) }, async (host, { as, admin, call }) => {
  assert.deepEqual((await as(ANNA)('GET', '/rules')).json.can, { house: true, personal: true });
  assert.deepEqual((await as(LENA)('GET', '/rules')).json.can, { house: false, personal: false });
  assert.equal((await as(LENA)('POST', '/rules', REMIND())).json.code, 'forbidden', 'a child without the setting');
  assert.equal((await as(LENA)('POST', '/rules', REMIND({ scope: 'house' }))).json.code, 'parents_only');
  host.settings.children_own_rules = true;
  assert.deepEqual((await as(LENA)('GET', '/rules')).json.can, { house: false, personal: true });
  const own = await as(LENA)('POST', '/rules', REMIND());
  assert.equal(own.status, 200, JSON.stringify(own.json));
  const r = own.json.rule;
  assert.deepEqual({ ...r, createdAt: null, updatedAt: null }, {
    id: r.id, title: 'Müll rausbringen', scope: 'personal', active: true, kind: 'reminder', trigger: { type: 'schedule', weekdays: [3], time: '10:30' },
    conditions: { time: null, afterSunset: false, device: [], calendar: null },
    actions: [{ type: 'notify', to: [LENA.id], text: 'Heute ist Abholung', facts: false, buttons: [] }],
    lastRunAt: null, lastResult: null, ownerId: LENA.id, ownerName: 'Lena', editable: true, pausable: true, createdAt: null, updatedAt: null,
  });
  // a personal rule tells only its owner, switches only what its owner has
  const bad = await as(LENA)('POST', '/rules', REMIND({ actions: [{ type: 'notify', to: [ANNA.id] }] }));
  assert.deepEqual([bad.status, bad.json.code, bad.json.field], [403, 'forbidden', 'actions.0.to']);
  assert.equal((await as(LENA)('POST', '/rules', REMIND({ actions: [{ type: 'notify', to: 'parents' }] }))).json.field, 'actions.0.to');
  assert.equal((await as(LENA)('POST', '/rules', REMIND({ actions: [{ type: 'messenger', to: 'family' }] }))).json.field, 'actions.0.to');
  assert.equal((await as(TIM)('POST', '/rules', REMIND({ actions: [{ type: 'quick_action', actionId: `${SK}/car1:climate` }] }))).json.field, 'actions.0', 'Tim has no car');
  const qa = await as(LENA)('POST', '/rules', REMIND({ title: 'Klima', actions: [{ type: 'quick_action', actionId: `${SK}/car1:climate` }] }));
  assert.equal(qa.status, 200);
  assert.deepEqual(qa.json.rule.actions.map((a) => [a.actionId, a.kind, a.available]), [[`${SK}/car1:climate`, 'button', true]]);
  // Anna: a house rule and an own one; Marc an own one
  const house = (await as(ANNA)('POST', '/rules', { ...REMIND({ title: 'Haus' }), scope: 'house', actions: [{ type: 'notify', to: 'all' }] })).json.rule;
  assert.equal(house.scope, 'house');
  const marcs = (await as(MARC)('POST', '/rules', REMIND({ title: 'Marc privat', scope: 'personal' }))).json.rule;
  // children see only their own; parents everything
  assert.deepEqual((await as(LENA)('GET', '/rules')).json.rules.map((x) => x.title), ['Müll rausbringen', 'Klima']);
  assert.deepEqual((await as(TIM)('GET', '/rules')).json.rules, []);
  const annaView = (await as(ANNA)('GET', '/rules')).json.rules;
  assert.deepEqual(annaView.map((x) => [x.title, x.editable, x.pausable]), [['Müll rausbringen', false, true], ['Klima', false, true], ['Haus', true, true], ['Marc privat', false, false]]);
  // parents pause or delete a child's own rule, nothing else of it; another parent's own rules stay theirs
  assert.equal((await as(ANNA)('PATCH', `/rules/${r.id}`, { title: 'X' })).json.code, 'forbidden');
  assert.equal((await as(ANNA)('PATCH', `/rules/${r.id}`, { active: false })).json.rule.active, false);
  assert.equal((await as(ANNA)('PATCH', `/rules/${marcs.id}`, { active: false })).json.code, 'forbidden');
  assert.equal((await as(ANNA)('DELETE', `/rules/${marcs.id}`)).json.code, 'forbidden');
  assert.equal((await as(LENA)('PATCH', `/rules/${house.id}`, { active: false })).json.code, 'not_found', 'a child does not see house rules');
  assert.equal((await as(LENA)('PATCH', `/rules/${r.id}`, { scope: 'house' })).json.field, 'scope', 'the scope stays');
  // the setting switched off again: the child keeps its rules, may pause and delete them, not change them
  host.settings.children_own_rules = false;
  assert.equal((await as(LENA)('PATCH', `/rules/${r.id}`, { title: 'Neu' })).json.code, 'forbidden');
  assert.equal((await as(LENA)('PATCH', `/rules/${r.id}`, { active: true })).status, 200);
  assert.equal((await as(LENA)('DELETE', `/rules/${qa.json.rule.id}`)).status, 200);
  // the admin page: every rule, house rules only for new ones
  const ad = await admin('GET', 'rules');
  assert.deepEqual(ad.json.rules.map((x) => x.title), ['Müll rausbringen', 'Haus', 'Marc privat']);
  assert.deepEqual(ad.json.can, { house: true, personal: false });
  const made = await admin('POST', 'rules', { ...REMIND({ title: 'Admin' }), actions: [{ type: 'notify', to: 'parents' }] });
  assert.deepEqual([made.json.rule.scope, made.json.rule.ownerId], ['house', ADMIN.id]);
  // the old API knows only house rules with a presence or place trigger
  host.settings.mod_presence = true;
  assert.deepEqual((await as(ANNA)('GET', '/presence/rules')).json.rules, []);
  assert.equal((await as(ANNA)('PATCH', `/presence/rules/${house.id}`, { name: 'x' })).json.code, 'not_found');
  // limits of the callers: device trust, a wall tablet, the module off
  assert.equal((await call(portal(ANNA, false), 'GET', '/rules')).json.code, 'login_required');
  await admin('POST', 'members', { userId: KUECHE.id, role: 'wall' });
  await admin('PUT', 'modules', { wall: true });
  assert.equal((await call(kioskViewer(KUECHE), 'GET', '/rules')).json.code, 'forbidden');
  await admin('PUT', 'modules', { rules: false });
  assert.equal((await as(ANNA)('GET', '/rules')).json.code, 'module_off');
}));

test('validation: trigger, schedule, conditions, actions, buttons; presence triggers need the module presence', () => withFamily({ actions: skoda([]) }, async (host, { as }) => {
  const post = (body) => as(ANNA)('POST', '/rules', body);
  const field = async (body) => (await post(body)).json.field;
  assert.equal(await field({ title: 'x', trigger: { type: 'nope' }, actions: [{ type: 'notify', to: 'me' }] }), 'trigger');
  for (const t of [{ type: 'schedule', weekdays: [], time: '10:00' }, { type: 'schedule', weekdays: [8], time: '10:00' }, { type: 'schedule', weekdays: [1], time: '25:00' }, { type: 'schedule', weekdays: [1] }]) {
    assert.equal(await field({ trigger: t, actions: [{ type: 'notify', to: 'me' }] }), 'trigger.schedule', JSON.stringify(t));
  }
  const base = { trigger: { type: 'schedule', weekdays: [1, 3, 3], time: '07:00' } };
  const ok = await post({ ...base, actions: [{ type: 'notify', to: 'me', facts: true, buttons: ['snooze_1h', 'done'] }] });
  assert.deepEqual(ok.json.rule.trigger.weekdays, [1, 3], 'unique, sorted');
  assert.equal(await field({ ...base, actions: [] }), 'actions');
  assert.equal(await field({ ...base, actions: [{ type: 'notify', to: 'me', buttons: ['later'] }] }), 'actions.0.buttons');
  assert.equal(await field({ ...base, actions: [{ type: 'notify', to: 'me', buttons: ['snooze_1h', 'done', 'done', 'snooze_1h', 'quick_action:a/b'] }] }), 'actions.0.buttons');
  assert.equal(await field({ ...base, actions: [{ type: 'notify', to: 'me', buttons: ['quick_action:gatecontrol-familie/x'] }] }), 'actions.0.buttons');
  assert.equal(await field({ ...base, actions: [{ type: 'notify', to: 'me', facts: 'ja' }] }), 'actions.0.facts');
  assert.equal(await field({ ...base, actions: [{ type: 'quick_action', actionId: 'kaputt' }] }), 'actions.0.actionId');
  assert.equal((await post({ ...base, actions: [{ type: 'quick_action', actionId: `${SK}/car1:charge` }] })).json.code, 'state_required', 'a switch needs a target');
  const dev = (d) => field({ ...base, conditions: { device: [d] }, actions: [{ type: 'notify', to: 'me' }] });
  assert.equal(await dev({ actionId: 'x', op: '<', value: 1 }), 'conditions.device.0.actionId');
  assert.equal(await dev({ actionId: `${SK}/car1:climate`, field: 'reading:', op: '<', value: 1 }), 'conditions.device.0.field');
  assert.equal(await dev({ actionId: `${SK}/car1:climate`, op: '!=', value: 1 }), 'conditions.device.0.op');
  assert.equal(await dev({ actionId: `${SK}/car1:climate`, op: '<', value: '50' }), 'conditions.device.0.value');
  const cal = (c) => field({ ...base, conditions: { calendar: c }, actions: [{ type: 'notify', to: 'me' }] });
  assert.equal(await cal({ dayOffset: 2 }), 'conditions.calendar.dayOffset');
  assert.equal(await cal({ sources: ['google'] }), 'conditions.calendar.sources');
  assert.equal(await cal({ match: 'x'.repeat(61) }), 'conditions.calendar.match');
  assert.equal(await cal({ memberIds: [99] }), 'conditions.calendar.memberIds');
  const full = await post({
    ...base, title: 'Auto laden',
    conditions: { time: { from: '06:00', to: '09:00' }, afterSunset: false, device: [{ actionId: `${SK}/car1:climate`, field: 'value', op: '<', value: 50, label: 'Ladestand', unit: '%' }],
      calendar: { dayOffset: 1, sources: ['familie', 'alltag:3'], match: 'Arbeit', memberIds: [MARC.id] } },
    actions: [{ type: 'notify', to: [ANNA.id], facts: true, buttons: [`quick_action:${SK}/car1:climate`, 'snooze_1h', 'done'] }],
  });
  assert.equal(full.status, 200, JSON.stringify(full.json));
  assert.deepEqual(full.json.rule.conditions, {
    time: { from: '06:00', to: '09:00' }, afterSunset: false, device: [{ actionId: `${SK}/car1:climate`, field: 'value', op: '<', value: 50, label: 'Ladestand', unit: '%' }],
    calendar: { dayOffset: 1, sources: ['familie', 'alltag:3'], match: 'Arbeit', memberIds: [MARC.id] },
  });
  assert.equal(full.json.rule.scope, 'house', 'a parent makes house rules by default');
  // presence triggers need the module presence
  const pres = await post({ title: 'Heim', trigger: { type: 'person_home', userId: TIM.id }, actions: [{ type: 'notify', to: 'parents' }] });
  assert.deepEqual([pres.json.code, pres.json.field], ['module_off', 'trigger']);
  host.settings.mod_presence = true;
  const p2 = await post({ title: 'Heim', trigger: { type: 'person_home', userId: TIM.id }, actions: [{ type: 'notify', to: 'parents' }] });
  assert.deepEqual([p2.status, p2.json.rule.kind, p2.json.rule.trigger], [200, 'presence', { type: 'person_home', userId: TIM.id }]);
  assert.equal((await post({ trigger: { type: 'person_home', userId: 99 }, actions: [{ type: 'notify', to: 'parents' }] })).json.field, 'trigger.userId');
  assert.equal((await post({ trigger: { type: 'place_enter', placeId: 5 }, actions: [{ type: 'notify', to: 'parents' }] })).json.field, 'placeId');
  // a presence rule made here is a house rule of the old API as well — device / calendar conditions survive an edit there
  const p3 = (await post({ title: 'Weg', trigger: { type: 'all_away', graceMinutes: 5 }, conditions: { device: [{ actionId: `${SK}/car1:climate`, op: '>', value: 1 }] },
    actions: [{ type: 'notify', to: 'parents', facts: true, buttons: ['done'] }] })).json.rule;
  const old = (await as(ANNA)('GET', '/presence/rules')).json.rules.find((x) => x.id === p3.id);
  assert.deepEqual([old.name, old.trigger, old.graceMinutes, old.conditions], ['Weg', 'all_away', 5, { time: null, afterSunset: false }]);
  await as(ANNA)('PATCH', `/presence/rules/${p3.id}`, { name: 'Alle weg', conditions: { time: null, afterSunset: true }, actions: [{ type: 'notify', to: 'parents', text: 'Tschüss' }] });
  const again = (await as(ANNA)('GET', '/rules')).json.rules.find((x) => x.id === p3.id);
  assert.equal(again.title, 'Alle weg');
  assert.deepEqual(again.conditions.device, [{ actionId: `${SK}/car1:climate`, field: 'value', op: '>', value: 1, label: null, unit: null }]);
  assert.deepEqual(again.actions, [{ type: 'notify', to: 'parents', text: 'Tschüss', facts: true, buttons: ['done'] }]);
  // limits: 20 own rules per person
  for (let i = 0; i < 20; i++) assert.equal((await as(MARC)('POST', '/rules', REMIND({ title: `M${i}`, scope: 'personal' }))).status, 200);
  assert.equal((await as(MARC)('POST', '/rules', REMIND({ scope: 'personal' }))).json.code, 'too_many');
}));

test('schedule: once a day at the time (Berlin), not for a time already passed, up to 2 hours late; topic reminders; the log', () => withFamily({ actions: skoda([]) }, async (host, { as, clock }) => {
  const at1030 = (await as(ANNA)('POST', '/rules', REMIND({ title: 'Müll', trigger: { type: 'schedule', weekdays: [3, 4], time: '10:30' } }))).json.rule;
  const at0900 = (await as(ANNA)('POST', '/rules', REMIND({ title: 'Früh', trigger: { type: 'schedule', weekdays: [3, 4], time: '09:00' } }))).json.rule;
  await host.tick();
  assert.equal(host.notifications.length, 0, '09:00 had passed when it was saved, 10:30 has not come');
  clock.add(29 * MIN);
  await host.tick();
  assert.equal(host.notifications.length, 0);
  clock.add(MIN);
  await host.tick();
  assert.equal(host.notifications.length, 1);
  const n = host.notifications[0];
  assert.deepEqual([n.topic, n.users, n.title, n.body], ['reminders', [ANNA.id], 'Müll', 'Heute ist Abholung']);
  assert.equal(n.collapseKey, `rule:${at1030.id}:sched:2026-10-14`);
  assert.deepEqual(n.data.familie, { type: 'rule_reminder', ruleId: at1030.id, trigger: 'schedule', userId: null, key: 'sched:2026-10-14' });
  assert.ok(!n.data.actions, 'no buttons asked for');
  clock.add(10 * MIN);
  await host.tick();
  assert.equal(host.notifications.length, 1, 'once a day');
  const list = (await as(ANNA)('GET', '/rules')).json;
  assert.deepEqual(list.log.map((x) => [x.ruleId, x.trigger, x.ok, x.skipped]), [[at1030.id, 'schedule', true, false]]);
  assert.equal(list.rules[0].lastRunAt, '2026-10-14T08:30:00Z');
  assert.deepEqual(list.open.map((x) => [x.ruleId, x.title, x.state]), [[at1030.id, 'Müll', 'open']], 'an open reminder of today');
  // Thursday: the server was down until 11:45 — 09:00 is too late (2:45 h), 10:30 still runs
  clock.set(Date.UTC(2026, 9, 15, 9, 45));
  await host.tick();
  assert.deepEqual(host.notifications.slice(1).map((x) => x.title), ['Müll']);
  assert.equal(at0900.lastRunAt, null);
  // paused rules and the module off: nothing
  await as(ANNA)('PATCH', `/rules/${at1030.id}`, { active: false });
  await as(ANNA)('DELETE', `/rules/${at0900.id}`);
  clock.set(Date.UTC(2026, 9, 21, 8, 30));
  await host.tick();
  assert.equal(host.notifications.length, 2);
  await as(ANNA)('PATCH', `/rules/${at1030.id}`, { active: true, trigger: { type: 'schedule', weekdays: [3], time: '10:40' } });
  host.settings.mod_rules = false;
  clock.set(Date.UTC(2026, 9, 21, 8, 41));
  await host.tick();
  assert.equal(host.notifications.length, 2, 'module rules off');
  host.settings.mod_rules = true;
  await host.tick();
  assert.equal(host.notifications.length, 3, 'on again: within the 2 hours');
}));

test('schedule with a time window and a personal messenger action; the dry run; options', () => withFamily({ actions: skoda([]) }, async (host, { as, clock }) => {
  const rule = (await as(ANNA)('POST', '/rules', REMIND({ title: 'Fenster', trigger: { type: 'schedule', weekdays: [3], time: '10:30' }, conditions: { time: { from: '11:00', to: '12:00' } } }))).json.rule;
  const t = await as(ANNA)('POST', `/rules/${rule.id}/test`);
  assert.equal(t.status, 200);
  assert.equal(t.json.wouldFire, false);
  assert.deepEqual(t.json.details.map((d) => [d.kind, d.ok]), [['trigger', true], ['time', false], ['action', true]]);
  assert.equal(t.json.details[0].text, 'Heute um 10:30');
  assert.equal(t.json.details[1].text, 'Zeitfenster 11:00–12:00: außerhalb');
  assert.equal(t.json.details[2].text, 'Mitteilung an Anna');
  clock.add(31 * MIN);
  await host.tick();
  assert.equal(host.notifications.length, 0, 'outside the window: not today');
  // an unsaved rule: Thursday's schedule
  const u = await as(ANNA)('POST', '/rules/test', REMIND({ trigger: { type: 'schedule', weekdays: [4], time: '07:00' } }));
  assert.deepEqual([u.json.wouldFire, u.json.details[0].text], [false, 'Heute nicht – nächstes Mal Do, 15.10. um 07:00']);
  const ok = await as(ANNA)('POST', '/rules/test', REMIND({ trigger: { type: 'schedule', weekdays: [3], time: '18:00' }, actions: [{ type: 'quick_action', actionId: `${SK}/car1:climate` }] }));
  assert.deepEqual([ok.json.wouldFire, ok.json.details.map((d) => d.text)], [true, ['Heute um 18:00', 'Klima: verfügbar']]);
  assert.equal((await as(LENA)('POST', `/rules/${rule.id}/test`)).json.code, 'not_found');
  // options for the editor
  const o = (await as(ANNA)('GET', '/rules/options')).json;
  assert.deepEqual(o.triggers.map((x) => [x.type, x.available]).slice(0, 3), [['schedule', true], ['all_away', false], ['first_home', false]]);
  assert.deepEqual(o.calendars, [{ source: 'familie', label: 'Familie' }], 'without Alltag only the family calendar');
  assert.deepEqual(o.devices, [], 'GateControl 1.180: no widgets');
  assert.deepEqual(o.actions.map((a) => [a.actionId, a.kind]), [[`${SK}/car1:climate`, 'button'], [`${SK}/car1:charge`, 'toggle']]);
  assert.deepEqual(o.people.map((p) => p.userId), [ANNA.id, MARC.id, LENA.id, TIM.id]);
  assert.deepEqual([o.can, o.features, o.location], [{ house: true, personal: true }, { deviceValues: false, buttons: false, alltag: false }, false]);
  assert.deepEqual(o.messenger, { available: false, group: true });
}));
