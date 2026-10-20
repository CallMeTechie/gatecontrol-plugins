'use strict';

// 1.12.0 — the rule trigger 'school_change' („Stunde fällt aus“): the trigger in the rules API (parsing,
// validation, the view, the scopes), the service rule_event (only the Schule plugin may call it, strict
// payload), matching (child or any child, kinds, today / tomorrow / any in the family's time zone),
// conditions, dedupe, the holiday mode and the module switch, the editor's options (only with the
// Schule plugin, its students cached) and the dry run.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withFamily, ANNA, MARC, LENA, TIM, OMA, MIN, pushes } = require('./helpers');

const SCHULE = 'gatecontrol-schule';
const TODAY = '2026-10-14';
const TOMORROW = '2026-10-15';

/** A stand-in Schule plugin offering school_students; calls are counted. */
function schule(o = {}) {
  const s = {
    plugin: SCHULE, provides: ['school_students'], calls: 0,
    service: async () => {
      s.calls += 1;
      if (o.fail) throw new Error('down');
      return { ok: true, students: o.students || [{ userId: LENA.id, name: 'Lena M.' }, { userId: TIM.id, name: 'Tim M.' }] };
    },
  };
  return s;
}

const ev = (extra = {}) => ({ userId: LENA.id, kind: 'cancelled', date: TODAY, start: '09:50', subject: 'Mathe', text: 'Lena: Mathe 3. Std. (09:50) fällt aus', ...extra });
const send = (host, events, caller = SCHULE, extra = {}) => host.callService('rule_event', { caller, payload: { type: 'school_change', events, ...extra } });
const NOTIFY = (to = 'parents', text = '{event} – {name}') => [{ type: 'notify', to, text }];
const rule = (trigger, extra = {}) => ({ title: 'Schule', trigger: { type: 'school_change', ...trigger }, actions: NOTIFY(), ...extra });

test('the trigger: parsed, validated, shown as given; needs only the module rules; scopes', () => withFamily({}, async (host, { as }) => {
  const post = (body, u = ANNA) => as(u)('POST', '/rules', body);
  const made = await post(rule({ userId: LENA.id, kinds: ['extra', 'cancelled', 'extra'], days: 'today' }));
  assert.equal(made.status, 200, JSON.stringify(made.json));
  assert.deepEqual(made.json.rule.trigger, { type: 'school_change', userId: LENA.id, kinds: ['cancelled', 'extra'], days: 'today' });
  assert.deepEqual([made.json.rule.kind, made.json.rule.scope], ['school', 'house']);
  // defaults: any child, cancellations, any day
  const def = await post(rule({}));
  assert.deepEqual(def.json.rule.trigger, { type: 'school_change', userId: null, kinds: ['cancelled'], days: 'any' });
  // round trip: the view goes back in unchanged
  const again = await as(ANNA)('PATCH', `/rules/${made.json.rule.id}`, { trigger: made.json.rule.trigger });
  assert.deepEqual(again.json.rule.trigger, made.json.rule.trigger);
  const changed = await as(ANNA)('PATCH', `/rules/${made.json.rule.id}`, { trigger: { type: 'school_change', userId: TIM.id, kinds: ['restored', 'changed'], days: 'tomorrow' } });
  assert.deepEqual(changed.json.rule.trigger, { type: 'school_change', userId: TIM.id, kinds: ['changed', 'restored'], days: 'tomorrow' });
  assert.equal((await as(ANNA)('PATCH', `/rules/${made.json.rule.id}`, { title: 'Nur Titel' })).json.rule.trigger.days, 'tomorrow', 'kept without a trigger');
  // validation with the field
  const field = async (t) => { const r = await post(rule(t)); return [r.status, r.json.code, r.json.field]; };
  assert.deepEqual(await field({ userId: ANNA.id }), [400, 'invalid', 'trigger.userId'], 'a parent is no child');
  assert.deepEqual(await field({ userId: OMA.id }), [400, 'invalid', 'trigger.userId'], 'not a member');
  assert.deepEqual(await field({ userId: 'x' }), [400, 'invalid', 'trigger.userId']);
  assert.deepEqual(await field({ kinds: [] }), [400, 'invalid', 'trigger.kinds']);
  assert.deepEqual(await field({ kinds: ['moved'] }), [400, 'invalid', 'trigger.kinds']);
  assert.deepEqual(await field({ kinds: 'cancelled' }), [400, 'invalid', 'trigger.kinds']);
  assert.deepEqual(await field({ days: 'yesterday' }), [400, 'invalid', 'trigger.days']);
  // the module presence (off here) is not needed; the old API presence/rules does not see it
  host.settings.mod_presence = true;
  assert.deepEqual((await as(ANNA)('GET', '/presence/rules')).json.rules, []);
  // a child's own rule: only for itself (null = itself)
  host.settings.children_own_rules = true;
  const notMe = await post(rule({ userId: TIM.id }, { actions: NOTIFY('me') }), LENA);
  assert.deepEqual([notMe.status, notMe.json.code, notMe.json.field], [403, 'forbidden', 'trigger.userId']);
  assert.deepEqual((await post(rule({ userId: LENA.id }, { actions: NOTIFY('me') }), LENA)).json.rule.trigger.userId, LENA.id);
  assert.equal((await post(rule({}, { actions: NOTIFY('me') }), LENA)).json.rule.trigger.userId, null);
  // a parent's own rule may be about any child
  assert.equal((await post(rule({ userId: TIM.id }, { scope: 'personal', actions: NOTIFY('me') }), MARC)).status, 200);
}));

test('rule_event: only the Schule plugin; the payload is checked strictly', () => withFamily({}, async (host) => {
  assert.deepEqual(await send(host, [ev()], 'gatecontrol-messenger'), { ok: false, code: 'forbidden' });
  assert.deepEqual(await send(host, [ev()], 'gatecontrol-other'), { ok: false, code: 'forbidden' });
  // and the Schule plugin may call nothing else
  assert.deepEqual(await host.callService('family_roles', { caller: SCHULE, payload: {} }), { ok: false, code: 'forbidden' });
  assert.deepEqual(await send(host, [ev()]), { ok: true, fired: 0 }, 'no rules yet');
  assert.deepEqual(await send(host, []), { ok: true, fired: 0 });
  const invalid = { ok: false, code: 'invalid' };
  assert.deepEqual(await host.callService('rule_event', { caller: SCHULE, payload: { type: 'other', events: [ev()] } }), invalid);
  assert.deepEqual(await host.callService('rule_event', { caller: SCHULE, payload: { type: 'school_change' } }), invalid);
  assert.deepEqual(await send(host, Array.from({ length: 21 }, (_, i) => ev({ start: `0${i % 10}:00` }))), invalid, 'at most 20');
  for (const bad of [{ userId: String(LENA.id) }, { userId: 0 }, { kind: 'moved' }, { date: '2026-02-30' }, { date: '14.10.2026' }, { start: '9:50' }, { start: '24:00' },
    { text: '' }, { text: 'x'.repeat(201) }, { text: 5 }, { subject: 7 }, { subject: 'x'.repeat(81) }]) {
    assert.deepEqual(await send(host, [ev(bad)]), invalid, JSON.stringify(bad));
  }
  assert.deepEqual(await send(host, [null]), invalid);
  assert.deepEqual(await send(host, Array.from({ length: 20 }, (_, i) => ev({ start: `1${i % 10}:0${Math.floor(i / 10)}` }))), { ok: true, fired: 0 }, '20 are fine');
}));

test('matching: the child or any child, the kinds, today / tomorrow / any; notifications with {event}; once per event', () => withFamily({}, async (host, { as }) => {
  const any = (await as(ANNA)('POST', '/rules', rule({}, { title: 'Ausfall' }))).json.rule;
  const lenaToday = (await as(ANNA)('POST', '/rules', rule({ userId: LENA.id, kinds: ['changed'], days: 'today' }, { title: 'Vertretung Lena' }))).json.rule;
  const timTomorrow = (await as(ANNA)('POST', '/rules', rule({ userId: TIM.id, days: 'tomorrow' }, { title: 'Tim morgen', actions: NOTIFY([TIM.id], '{event}') }))).json.rule;
  const from = host.notifications.length;
  assert.deepEqual(await send(host, [ev()]), { ok: true, fired: 1 }, 'Lena cancelled today: any child');
  const n = pushes(host, null, from);
  assert.equal(n.length, 1);
  assert.equal(n[0].title, 'Lena: Mathe 3. Std. (09:50) fällt aus – Lena');
  assert.equal(n[0].topic, 'reminders');
  assert.deepEqual([...n[0].users].sort(), [ANNA.id, MARC.id]);
  assert.deepEqual(n[0].data.familie, { type: 'presence_rule', ruleId: any.id, trigger: 'school_change', userId: LENA.id, school: { date: TODAY, start: '09:50', kind: 'cancelled' } });
  // the same event again (Schule sent it twice): nothing
  assert.deepEqual(await send(host, [ev()]), { ok: true, fired: 0 });
  assert.equal(pushes(host, null, from).length, 1);
  // a substitution of Lena today: only her rule; tomorrow: none
  assert.deepEqual(await send(host, [ev({ kind: 'changed', text: 'Lena: Mathe 3. Std. (09:50) – Vertretung' })]), { ok: true, fired: 1 });
  assert.deepEqual(await send(host, [ev({ kind: 'changed', date: TOMORROW, text: 'Lena: Mathe morgen – Vertretung' })]), { ok: true, fired: 0 });
  // Tim cancelled tomorrow: any child and his rule, which tells Tim himself
  const before = host.notifications.length;
  assert.deepEqual(await send(host, [ev({ userId: TIM.id, date: TOMORROW, start: '08:00', text: 'Tim: Sport 1. Std. (08:00) fällt aus' })]), { ok: true, fired: 2 });
  const tim = pushes(host, null, before);
  assert.deepEqual(tim.map((x) => [x.data.familie.ruleId, x.title, x.users]).sort((a, b) => a[0] - b[0]), [
    [any.id, 'Tim: Sport 1. Std. (08:00) fällt aus – Tim', [ANNA.id, MARC.id]],
    [timTomorrow.id, 'Tim: Sport 1. Std. (08:00) fällt aus', [TIM.id]],
  ]);
  // two events of one call: each runs the rule, separate notifications (not collapsed)
  const b2 = host.notifications.length;
  assert.deepEqual(await send(host, [ev({ start: '10:40', text: 'Lena: Physik 4. Std. (10:40) fällt aus' }), ev({ start: '11:35', text: 'Lena: Bio 5. Std. (11:35) fällt aus' })]), { ok: true, fired: 2 });
  const two = pushes(host, null, b2);
  assert.equal(new Set(two.map((x) => x.collapseKey)).size, 2);
  // a parent, someone outside the family: ignored
  assert.deepEqual(await send(host, [ev({ userId: ANNA.id }), ev({ userId: OMA.id }), ev({ userId: 999 })]), { ok: true, fired: 0 });
  // the log carries the event's text; the rule its last run
  const list = (await as(ANNA)('GET', '/rules')).json;
  const row = list.log.find((x) => x.ruleId === lenaToday.id);
  assert.deepEqual([row.trigger, row.userId, row.event, row.ok], ['school_change', LENA.id, 'Lena: Mathe 3. Std. (09:50) – Vertretung', true]);
  assert.ok(list.rules.find((x) => x.id === any.id).lastRunAt);
  // a deleted rule takes its handled events along
  await as(ANNA)('DELETE', `/rules/${any.id}`);
  assert.equal((await host.gc.db.query('SELECT COUNT(*) AS n FROM rule_fired WHERE rule_id = ?', [any.id])).rows[0].n, 0);
}));

test('days are counted in the family’s time zone at the time of the event', () => withFamily({}, async (host, { as, clock }) => {
  await as(ANNA)('POST', '/rules', rule({ days: 'today' }));
  await as(ANNA)('POST', '/rules', rule({ days: 'tomorrow' }, { title: 'morgen' }));
  // 00:30 in Berlin on the 15th — still the 14th in UTC
  clock.set(Date.UTC(2026, 9, 14, 22, 30));
  const r = await send(host, [ev({ date: TOMORROW, text: 'Lena: heute' }), ev({ date: '2026-10-16', text: 'Lena: morgen' }), ev({ date: TODAY, text: 'Lena: gestern' })]);
  assert.deepEqual(r, { ok: true, fired: 2 });
  const log = (await as(ANNA)('GET', '/rules')).json.log;
  assert.deepEqual(log.map((x) => [x.ruleTitle, x.event]).sort(), [['Schule', 'Lena: heute'], ['morgen', 'Lena: morgen']]);
}));

test('conditions apply (not met: the event is handled, nothing runs); a child’s own rule tells the child', () => withFamily({ settings: { children_own_rules: true } }, async (host, { as, clock }) => {
  const r = (await as(ANNA)('POST', '/rules', rule({}, { conditions: { time: { from: '06:00', to: '08:00' } } }))).json.rule;
  assert.deepEqual(await send(host, [ev()]), { ok: true, fired: 0 }, '10:00 is outside 06–08');
  clock.set(Date.UTC(2026, 9, 15, 5, 0)); // 07:00 the next day
  assert.deepEqual(await send(host, [ev()]), { ok: true, fired: 0 }, 'already handled');
  assert.deepEqual(await send(host, [ev({ date: TOMORROW })]), { ok: true, fired: 1 }, 'a new event in the window');
  assert.ok((await as(ANNA)('GET', '/rules')).json.rules.find((x) => x.id === r.id).lastRunAt);
  // Lena's own reminder: she gets it herself (she did not cause it)
  await as(LENA)('POST', '/rules', rule({}, { title: 'Meins', actions: NOTIFY('me', 'Frei: {event}') }));
  clock.set(Date.UTC(2026, 9, 15, 6, 30)); // 08:30: the house rule is outside its window
  const from = host.notifications.length;
  assert.deepEqual(await send(host, [ev({ date: TOMORROW, start: '11:35', text: 'Lena: Bio fällt aus' })]), { ok: true, fired: 1 });
  const n = pushes(host, null, from);
  assert.deepEqual(n.map((x) => [x.title, x.users]), [['Frei: Lena: Bio fällt aus', [LENA.id]]]);
  // her own rule never runs for Tim
  assert.deepEqual(await send(host, [ev({ userId: TIM.id, date: TOMORROW, start: '07:30', text: 'Tim: fällt aus' })]), { ok: true, fired: 0 });
  clock.set(Date.UTC(2026, 9, 15, 5, 30)); // 07:30: the house rule only
  assert.deepEqual(await send(host, [ev({ userId: TIM.id, date: TOMORROW, start: '09:50', text: 'Tim: fällt aus' })]), { ok: true, fired: 1 });
}));

test('the holiday mode pauses house rules; nothing runs with the module rules off', () => withFamily({ settings: { children_own_rules: true } }, async (host, { as, admin }) => {
  await as(ANNA)('POST', '/rules', rule({}));
  await as(LENA)('POST', '/rules', rule({}, { title: 'Meins', actions: NOTIFY('me') }));
  assert.equal((await as(ANNA)('PUT', '/rules/vacation', { on: true })).status, 200);
  assert.deepEqual(await send(host, [ev()]), { ok: true, fired: 1 }, 'only Lena’s own rule');
  await as(ANNA)('PUT', '/rules/vacation', { on: false });
  assert.deepEqual(await send(host, [ev({ start: '10:40' })]), { ok: true, fired: 2 });
  await admin('PUT', 'modules', { rules: false });
  assert.deepEqual(await send(host, [ev({ start: '11:35' })]), { ok: true, fired: 0 });
}));

test('options: the trigger and the students only with the Schule plugin (GateControl 1.178.0), cached 5 minutes', async () => {
  // without the Schule plugin
  await withFamily({ gatecontrol: '1.178.0' }, async (host, { as }) => {
    const o = (await as(ANNA)('GET', '/rules/options')).json;
    assert.ok(!o.triggers.some((t) => t.type === 'school_change'));
    assert.equal(o.school, undefined);
  });
  // an older GateControl (no gc.services.available): not offered, no call
  const old = schule();
  await withFamily({ services: [old] }, async (host, { as }) => {
    assert.ok(!(await as(ANNA)('GET', '/rules/options')).json.triggers.some((t) => t.type === 'school_change'));
    assert.equal(old.calls, 0);
  });
  // with it: the trigger in the group „school“ and its students who are children of the family
  const s = schule({ students: [{ userId: LENA.id, name: 'Lena M.' }, { userId: TIM.id, name: 'Tim M.' }, { userId: OMA.id, name: 'Oma' }, { userId: ANNA.id, name: 'Anna' }] });
  await withFamily({ services: [s], gatecontrol: '1.178.0', settings: { children_own_rules: true } }, async (host, { as, admin, clock }) => {
    const o = (await as(ANNA)('GET', '/rules/options')).json;
    assert.deepEqual(o.triggers.find((t) => t.type === 'school_change'), { type: 'school_change', group: 'school', available: true });
    assert.deepEqual(o.school, { students: [{ userId: LENA.id, name: 'Lena M.' }, { userId: TIM.id, name: 'Tim M.' }] });
    // a child sees only itself
    assert.deepEqual((await as(LENA)('GET', '/rules/options')).json.school, { students: [{ userId: LENA.id, name: 'Lena M.' }] });
    assert.deepEqual((await admin('GET', 'rules/options')).json.school.students.map((x) => x.userId), [LENA.id, TIM.id]);
    assert.equal(s.calls, 1, 'cached');
    clock.add(6 * MIN);
    await as(ANNA)('GET', '/rules/options');
    assert.equal(s.calls, 2, 'asked again after 5 minutes');
  });
  // the Schule plugin fails: not offered
  await withFamily({ services: [schule({ fail: true })], gatecontrol: '1.178.0' }, async (host, { as }) => {
    const o = (await as(ANNA)('GET', '/rules/options')).json;
    assert.ok(!o.triggers.some((t) => t.type === 'school_change'));
    assert.equal(o.school, undefined);
  });
});

test('the dry run simulates one event', async () => {
  await withFamily({ services: [schule()], gatecontrol: '1.178.0' }, async (host, { as }) => {
    const t = await as(ANNA)('POST', '/rules/test', rule({ userId: TIM.id, kinds: ['changed'], days: 'tomorrow' }, { conditions: { time: { from: '08:00', to: '12:00' } } }));
    assert.equal(t.status, 200, JSON.stringify(t.json));
    assert.equal(t.json.wouldFire, true);
    assert.equal(t.json.details[0].kind, 'trigger');
    assert.equal(t.json.details[0].ok, null);
    assert.ok(t.json.details[0].text.includes('Tim: Mathe 3. Std. (09:50) – Vertretung – morgen'), t.json.details[0].text);
    assert.ok(t.json.details[0].text.includes('Stundenplan von Tim'), t.json.details[0].text);
    assert.deepEqual(t.json.details.slice(1).map((d) => [d.kind, d.ok]), [['time', true], ['action', true]]);
    // a saved rule, any child
    const r = (await as(ANNA)('POST', '/rules', rule({}))).json.rule;
    const s = await as(ANNA)('POST', `/rules/${r.id}/test`);
    assert.ok(s.json.details[0].text.includes('Lena: Mathe 3. Std. (09:50) fällt aus – heute'), s.json.details[0].text);
  });
  await withFamily({ gatecontrol: '1.178.0' }, async (host, { as }) => {
    const t = await as(ANNA)('POST', '/rules/test', rule({}));
    assert.equal(t.json.wouldFire, false);
    assert.deepEqual([t.json.details[0].ok, t.json.details[0].text], [false, 'Das Plugin „Schule“ ist nicht verfügbar – dieser Auslöser löst nicht aus']);
  });
});
