'use strict';

// Reminders (1.9.0): device values (GateControl 1.181.0, emulated by test/gc181.js — the mock host knows
// 1.180.0) and calendar conditions (Familie's dates, the Alltag calendars through its service), facts and
// buttons on the notification, what the buttons do (hook notifyAction: snooze for an hour with a fresh
// check, done, another plugin's quick action as the person who presses it), and an older GateControl:
// no buttons, device values unknown = not met, with the reason in the log.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withFamily, ADMIN, ANNA, MARC, LENA, MIN, HOUR } = require('./helpers');
const { gc181 } = require('./gc181');

const SK = 'gatecontrol-skoda';
function skoda(log) {
  return [{
    plugin: SK, pluginName: 'Fahrzeuge',
    quickActions: (viewer) => ([ANNA.id, MARC.id, ADMIN.id].includes(viewer.id) ? [
      { id: 'car1:climate', title: 'Elroq', device: { id: 'car1', title: 'Elroq' } },
      { id: 'car1:charge', title: 'Laden starten', device: { id: 'car1', title: 'Elroq' } },
    ] : []),
    runQuickAction: (viewer, id) => { log.push({ viewer: viewer.id, id }); return { ok: true, message: 'Laden gestartet' }; },
  }];
}
const CAR = `${SK}/car1:climate`;
const CHARGE = `${SK}/car1:charge`;

/** Alltag as a provider of calendar_query (one event tomorrow 07:30 „Arbeit“ for Anna). */
function alltag(calls) {
  return [{
    plugin: 'gatecontrol-alltag', provides: ['calendar_query', 'calendar_list'],
    service: async (c) => {
      calls.push(c);
      if (c.name === 'calendar_list') return { ok: true, subscriptions: [{ id: 3, name: 'Arbeit (Outlook)' }] };
      const ev = c.user && c.user.id === ANNA.id && c.payload.from === '2026-10-15' ? [{ title: 'Arbeit Frühdienst', date: '2026-10-15', startMs: 0, allDay: false, subId: 3, subName: 'Arbeit (Outlook)', time: '07:30' }] : [];
      return { ok: true, events: ev.filter((e) => !c.payload.match || e.title.toLowerCase().includes(c.payload.match.toLowerCase())), subscriptions: [{ id: 3, name: 'Arbeit (Outlook)' }] };
    },
  }];
}

const AUTO = {
  title: 'Auto laden', scope: 'personal', trigger: { type: 'schedule', weekdays: [3], time: '18:00' },
  conditions: { device: [{ actionId: CAR, field: 'value', op: '<', value: 50, label: 'Ladestand', unit: '%' }], calendar: { dayOffset: 1, sources: ['alltag:3'], match: 'Arbeit' } },
  actions: [{ type: 'notify', to: 'me', text: 'Akku {value}, morgen {event}', facts: true, buttons: [`quick_action:${CHARGE}`, 'snooze_1h', 'done'] }],
};

test('device value and calendar met: the reminder with facts and three buttons; „Laden starten“ runs as the person; done', () => {
  const runs = [];
  const calls = [];
  return withFamily({ actions: skoda(runs), services: alltag(calls) }, async (host, { clock }) => {
    const g = gc181(host, { [CAR]: { value: '32 %', unit: null, label: 'Ladestand', readings: [{ id: 'range', label: 'Reichweite', value: 125, unit: 'km' }] } });
    const made = await g.request({ ...ANNA, portal: true, loggedIn: true, app: true }, 'POST', '/rules', AUTO);
    assert.equal(made.status, 200, JSON.stringify(made.json));
    const id = made.json.rule.id;
    // options on 1.181: the device with its fields, the Alltag calendars
    const o = (await g.request({ ...ANNA, portal: true, loggedIn: true, app: true }, 'GET', '/rules/options')).json;
    assert.deepEqual(o.devices.find((d) => d.actionId === CAR), {
      actionId: CAR, label: 'Elroq', icon: null,
      fields: [{ id: 'value', label: 'Ladestand', unit: null, current: '32 %' }, { id: 'reading:range', label: 'Reichweite', unit: 'km', current: '125 km' }],
    });
    assert.deepEqual(o.calendars.map((c) => c.source), ['familie', 'alltag', 'alltag:3']);
    assert.deepEqual(o.features, { deviceValues: true, buttons: true, alltag: true });
    // the dry run says why it would fire
    const t = (await g.request({ ...ANNA, portal: true, loggedIn: true, app: true }, 'POST', `/rules/${id}/test`)).json;
    assert.equal(t.wouldFire, true);
    assert.deepEqual(t.details.map((d) => [d.kind, d.ok, d.text]), [
      ['trigger', true, 'Heute um 18:00'], ['device', true, 'Elroq: jetzt 32 % (< 50 %) – erfüllt'], ['calendar', true, 'Termin morgen 07:30: Arbeit Frühdienst'],
      ['action', true, 'Mitteilung an Anna'],
    ]);
    clock.set(Date.UTC(2026, 9, 14, 16, 0));
    await g.tick();
    assert.equal(g.sent.length, 1);
    const n = g.sent[0];
    assert.deepEqual([n.topic, n.users, n.title, n.body], ['reminders', [ANNA.id], 'Auto laden', 'Akku 32 %, morgen morgen 07:30 Arbeit Frühdienst']);
    assert.deepEqual(n.data.facts, [{ label: 'Ladestand', value: '32 %' }, { label: 'Termin', value: 'morgen 07:30 · Arbeit Frühdienst' }]);
    assert.deepEqual(n.data.actions, [{ type: 'callback', id: 'qa0', label: 'Laden starten' }, { type: 'callback', id: 'snooze_1h', label: 'In 1 Std.' }, { type: 'callback', id: 'done', label: 'Erledigt' }]);
    assert.deepEqual(n.data.familie, { type: 'rule_reminder', ruleId: id, trigger: 'schedule', userId: null, key: 'sched:2026-10-14', qa: [CHARGE] });
    assert.ok(calls.some((c) => c.name === 'calendar_query' && c.user.id === ANNA.id && c.payload.from === '2026-10-15' && c.payload.subIds[0] === 3), 'as the owner');
    // the mock host got it without the callback buttons
    assert.equal(host.notifications.length, 1);
    assert.ok(!host.notifications[0].data.actions);
    // „Laden starten“: the quick action as Anna, logged, the reminder done
    const r = await g.notifyAction({ userId: ANNA.id, notificationId: 'n1', action: 'qa0', data: n.data });
    assert.deepEqual(r, { ok: true, state: 'done' });
    assert.deepEqual(runs, [{ viewer: ANNA.id, id: 'car1:charge' }]);
    const list = (await g.request({ ...ANNA, portal: true, loggedIn: true, app: true }, 'GET', '/rules')).json;
    assert.deepEqual(list.log.map((x) => [x.trigger, x.ok, x.userId]), [['button', true, ANNA.id], ['schedule', true, null]]);
    assert.deepEqual(list.open, [], 'done');
    // a stranger's press, a wrong action, a lost reminder
    assert.equal((await g.notifyAction({ userId: LENA.id, notificationId: 'n1', action: 'done', data: n.data })).ok, false);
    assert.equal((await g.notifyAction({ userId: ANNA.id, notificationId: 'n1', action: 'qa5', data: n.data })).error, 'unknown');
    assert.equal((await g.notifyAction({ userId: ANNA.id, notificationId: 'n1', action: 'done', data: { familie: { type: 'other' } } })).error, 'unknown');
  });
});

test('snooze: an hour later checked again — still met → again (at most 3 a day), no longer met → resolved', () => withFamily({ actions: skoda([]) }, async (host, { clock }) => {
  const g = gc181(host, { [CAR]: { value: 32, unit: '%' } });
  const anna = { ...ANNA, portal: true, loggedIn: true, app: true };
  const made = (await g.request(anna, 'POST', '/rules', { ...AUTO, conditions: { device: AUTO.conditions.device }, actions: [{ type: 'notify', to: 'me', buttons: ['snooze_1h', 'done'] }] })).json.rule;
  clock.set(Date.UTC(2026, 9, 14, 16, 0));
  await g.tick();
  assert.equal(g.sent.length, 1);
  assert.equal(g.sent[0].body, 'Ladestand: 32 %', 'no text, no facts asked for: the value in the body');
  const data = g.sent[0].data;
  assert.deepEqual(await g.notifyAction({ userId: ANNA.id, notificationId: 'a', action: 'snooze_1h', data }), { ok: true, state: 'snoozed', until: Date.UTC(2026, 9, 14, 17, 0) });
  assert.deepEqual((await g.request(anna, 'GET', '/rules')).json.open.map((x) => x.state), ['snoozed']);
  clock.add(59 * MIN);
  await g.tick();
  assert.equal(g.sent.length, 1);
  clock.add(MIN);
  await g.tick();
  assert.equal(g.sent.length, 2, 'still below 50 %');
  assert.equal(g.sent[1].collapseKey, g.sent[0].collapseKey);
  assert.deepEqual(g.sent[1].users, [ANNA.id]);
  assert.equal((await g.notifyAction({ userId: ANNA.id, notificationId: 'b', action: 'snooze_1h', data })).ok, true);
  clock.add(HOUR);
  await g.tick();
  assert.equal(g.sent.length, 3);
  assert.deepEqual(await g.notifyAction({ userId: ANNA.id, notificationId: 'c', action: 'snooze_1h', data }), { ok: false, error: 'limit' }, 'three a day');
  // the next week: snoozed, then charged meanwhile → resolved, nothing more
  clock.set(Date.UTC(2026, 9, 21, 16, 0));
  await g.tick();
  assert.equal(g.sent.length, 4);
  await g.notifyAction({ userId: ANNA.id, notificationId: 'd', action: 'snooze_1h', data: g.sent[3].data });
  g.widgets[CAR] = { value: 80, unit: '%' };
  clock.add(HOUR);
  await g.tick();
  assert.equal(g.sent.length, 4);
  assert.deepEqual((await g.request(anna, 'GET', '/rules')).json.open, []);
  assert.deepEqual(await g.notifyAction({ userId: ANNA.id, notificationId: 'd', action: 'done', data: g.sent[3].data }), { ok: true, state: 'done' });
  assert.ok(made.id);
}));

test('not met or unknown: nothing is sent, the log says why; GateControl 1.180: no buttons, device values unknown', () => withFamily({ actions: skoda([]) }, async (host, { as, clock }) => {
  const g = gc181(host, { [CAR]: { value: 71, unit: '%' } });
  const anna = { ...ANNA, portal: true, loggedIn: true, app: true };
  const r1 = (await g.request(anna, 'POST', '/rules', { ...AUTO, conditions: { device: AUTO.conditions.device } })).json.rule;
  clock.set(Date.UTC(2026, 9, 14, 16, 0));
  await g.tick();
  assert.equal(g.sent.length, 0);
  let log = (await as(ANNA)('GET', '/rules')).json.log;
  assert.deepEqual(log.map((x) => [x.ruleId, x.ok, x.skipped, x.results.map((y) => [y.type, y.kind, y.error, y.text])]), [
    [r1.id, false, true, [['condition', 'device', 'not_met', 'Elroq: jetzt 71 % (< 50 %) – nicht erfüllt']]],
  ]);
  assert.deepEqual((await as(ANNA)('GET', '/rules')).json.rules[0].lastResult, { at: '2026-10-14T16:00:00Z', ok: false, skipped: true });
  // the same on an older GateControl (the mock host's gc): unknown, no buttons
  await as(ANNA)('POST', '/rules', { title: 'Ohne Werte', scope: 'personal', trigger: { type: 'schedule', weekdays: [3], time: '18:30' }, actions: [{ type: 'notify', to: 'me', buttons: ['snooze_1h', 'done'] }] });
  await as(ANNA)('POST', '/rules', { ...AUTO, title: 'Alt', trigger: { type: 'schedule', weekdays: [3], time: '18:30' }, conditions: { device: AUTO.conditions.device } });
  clock.set(Date.UTC(2026, 9, 14, 16, 30));
  await host.tick();
  assert.deepEqual(host.notifications.map((n) => [n.title, !!(n.data && n.data.actions)]), [['Ohne Werte', false]], 'a rule without device values runs on 1.180, without buttons');
  log = (await as(ANNA)('GET', '/rules')).json.log;
  assert.equal(log[0].results[0].text, 'Elroq: Wert unbekannt – Gerätewerte brauchen GateControl 1.181.0 (< 50 %)');
  assert.equal(log[0].results[0].error, 'unknown');
  // the calendar without Alltag: unknown
  const t = (await as(ANNA)('POST', '/rules/test', { ...AUTO, conditions: { calendar: { dayOffset: 0, sources: ['alltag'] } } })).json;
  assert.deepEqual(t.details.find((d) => d.kind === 'calendar'), { kind: 'calendar', ok: false, text: 'Termine heute nicht lesbar (irgendein Termin)' });
  // Familie's dates: only for the people asked
  await as(ANNA)('POST', '/dates', { title: 'Elternabend', date: '2026-10-14', time: '19:30', memberIds: [MARC.id] });
  const f = (await as(ANNA)('POST', '/rules/test', { ...AUTO, conditions: { calendar: { dayOffset: 0, sources: ['familie'], match: 'eltern', memberIds: [MARC.id] } } })).json;
  assert.deepEqual(f.details.find((d) => d.kind === 'calendar'), { kind: 'calendar', ok: true, text: 'Termin heute 19:30: Elternabend' });
  const f2 = (await as(ANNA)('POST', '/rules/test', { ...AUTO, conditions: { calendar: { dayOffset: 0, sources: ['familie'], memberIds: [LENA.id] } } })).json;
  assert.deepEqual(f2.details.find((d) => d.kind === 'calendar'), { kind: 'calendar', ok: false, text: 'Kein Termin heute (irgendein Termin)' });
}));

test('presence rule with a device condition: checked after the event; buttons on a house rule only for people who have the action', () => withFamily({ actions: skoda([]), settings: { mod_presence: true } }, async (host, { as }) => {
  const g = gc181(host, { [CAR]: { value: 20, unit: '%' } });
  const anna = { ...ANNA, portal: true, loggedIn: true, app: true };
  const lena = { ...LENA, portal: true, loggedIn: true, app: true };
  const rule = (await g.request(anna, 'POST', '/rules', {
    title: 'Lena heim', trigger: { type: 'person_home', userId: LENA.id }, conditions: { device: AUTO.conditions.device },
    actions: [{ type: 'notify', to: 'all', facts: true, buttons: [`quick_action:${CHARGE}`, 'done'] }],
  })).json.rule;
  assert.equal(rule.kind, 'presence');
  await g.request(lena, 'PUT', '/presence/consent', { share: true });
  await g.request(lena, 'POST', '/presence', { home: true });
  // one push per person: Anna and Marc have the car (its button), Tim not; Lena herself gets nothing
  assert.deepEqual(g.sent.map((n) => [n.users[0], n.data.actions.map((a) => a.label)]), [[ANNA.id, ['Laden starten', 'Erledigt']], [MARC.id, ['Laden starten', 'Erledigt']], [5, ['Erledigt']]]);
  assert.deepEqual([g.sent[0].topic, g.sent[0].title, g.sent[0].body], ['presence', 'Lena ist zuhause', 'Lena heim']);
  assert.equal(g.sent[2].data.familie.qa, undefined);
  assert.match(g.sent[0].data.familie.key, /^run:\d+$/);
}));
