'use strict';

// Presence & smart home (module presence): consent only for oneself, reports
// only with consent (≤ 1 per minute), states home / away / unknown / not
// shared; rules (parents, admin page) with triggers, grace time, conditions
// (time window, after sunset), once per transition, at most every 10
// minutes; quick actions of other plugins through gc.actions (mock host) as
// the rule's owner, notifications, the run log, an action that vanished.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withFamily, ADMIN, ANNA, MARC, LENA, TIM, KUECHE, MIN, HOUR, portal, pushes } = require('./helpers');
const presence = require('../server/presence');

const SH = 'gatecontrol-smarthome';
/** A smart home plugin: Anna and the administrator have scenes, Marc only the hall light; runs are recorded. */
function smarthome(log, opts = {}) {
  return [{
    plugin: SH, pluginName: 'Smart Home',
    quickActions: (viewer) => {
      if (viewer.id === MARC.id) return [{ id: 'light:hall', title: 'Flurlicht', kind: 'toggle', state: 'off' }];
      if (viewer.id !== ANNA.id && viewer.id !== ADMIN.id) return [];
      const list = [{ id: 'scene:away', title: 'Heizung 17 °C' }, { id: 'scene:home', title: 'Heizung 21 °C' }];
      return opts.gone ? list.filter((a) => a.id !== 'scene:away') : list;
    },
    runQuickAction: (viewer, id) => { log.push({ viewer, id }); return { ok: true, message: 'Szene gestartet' }; },
  }];
}
const ON = (log, extra = {}) => ({ settings: { mod_presence: true, ...(extra.settings || {}) }, actions: smarthome(log, extra) });
const QA = (id, title) => ({ type: 'quick_action', plugin: SH, id, title });

async function share(as, ...users) {
  for (const u of users) assert.equal((await as(u)('PUT', '/presence/consent', { share: true })).status, 200);
}

test('consent only for oneself; reports only with consent, ≤ 1 per minute; states; device trust sees nothing', () => withFamily(ON([]), async (host, { as, call, clock }) => {
  assert.equal((await as(ANNA)('POST', '/presence', { home: true })).json.code, 'no_consent');
  const c = (await as(ANNA)('PUT', '/presence/consent', { share: true })).json;
  assert.deepEqual(c, { ok: true, consent: { share: true }, state: { userId: ANNA.id, state: 'unknown', home: null, since: null } });
  assert.equal((await as(ANNA)('PUT', '/presence/consent', { share: 'ja' })).json.code, 'invalid');
  await share(as, MARC, TIM);
  const r = (await as(ANNA)('POST', '/presence', { home: true, at: '2026-10-14T07:58:30Z' })).json;
  assert.deepEqual(r, { ok: true, state: { userId: ANNA.id, home: true, since: '2026-10-14T07:58:30Z' }, changed: true });
  const again = await as(ANNA)('POST', '/presence', { home: false });
  assert.deepEqual([again.status, again.json.code, again.json.retryAfter], [429, 'too_soon', 60]);
  assert.equal((await as(MARC)('POST', '/presence', { home: 'no' })).json.code, 'invalid');
  assert.equal((await as(MARC)('POST', '/presence', { home: false, at: 'gestern' })).json.code, 'invalid');
  await as(MARC)('POST', '/presence', { home: false, at: '2030-01-01T00:00:00Z' });
  const g = (await as(LENA)('GET', '/presence')).json;
  assert.deepEqual(g.members.map((m) => [m.userId, m.shared, m.state, m.home, m.since]), [
    [ANNA.id, true, 'home', true, '2026-10-14T07:58:30Z'], [MARC.id, true, 'away', false, '2026-10-14T08:00:00Z'], [LENA.id, false, 'not_shared', null, null], [TIM.id, true, 'unknown', null, null],
  ]);
  assert.deepEqual([g.me, g.home], [{ share: false }, [ANNA.id]]);
  const ovp = (await as(TIM)('GET', '/overview')).json.presence;
  assert.deepEqual({ ...ovp, members: null }, { home: [{ userId: ANNA.id, since: '2026-10-14T07:58:30Z' }], share: true, members: null });
  assert.deepEqual(ovp.members.map((m) => [m.userId, m.state, m.presence]), [[ANNA.id, 'home', 'home'], [MARC.id, 'away', 'away'], [LENA.id, 'not_shared', null], [TIM.id, 'unknown', 'unknown']], '1.3.0: every member like GET presence');
  assert.deepEqual(g.members.map((m) => m.presence), ['home', 'away', null, 'unknown'], 'the ring');
  // the same state again: no change, no new "since"
  clock.add(MIN);
  assert.deepEqual((await as(ANNA)('POST', '/presence', { home: true })).json.changed, false);
  assert.equal((await as(ANNA)('GET', '/presence')).json.members[0].since, '2026-10-14T07:58:30Z');
  // withdrawing deletes the state
  await as(ANNA)('PUT', '/presence/consent', { share: false });
  assert.deepEqual((await as(LENA)('GET', '/presence')).json.members[0].state, 'not_shared');
  await as(ANNA)('PUT', '/presence/consent', { share: true });
  assert.equal((await as(LENA)('GET', '/presence')).json.members[0].state, 'unknown', 'the old state is gone');
  // device trust: nothing at all
  assert.equal((await call(portal(ANNA, false), 'GET', '/presence')).json.code, 'login_required');
  assert.equal((await call(portal(ANNA, false), 'GET', '/overview')).json.presence, null);
}));

test('rules: parents only; validation; shape, owner, the quick actions of the caller', () => withFamily(ON([]), async (host, { as }) => {
  assert.equal((await as(TIM)('GET', '/presence/rules')).json.code, 'parents_only');
  assert.equal((await as(TIM)('POST', '/presence/rules', { trigger: 'all_away', actions: [QA('scene:away')] })).json.code, 'parents_only');
  assert.equal((await as(TIM)('GET', '/presence/log')).json.code, 'parents_only');
  const acts = (await as(ANNA)('GET', '/presence/actions')).json;
  assert.deepEqual(acts, { ok: true, available: true, actions: [
    { plugin: SH, pluginName: 'Smart Home', id: 'scene:away', title: 'Heizung 17 °C', subtitle: null, icon: null, kind: 'button', state: null, verbs: null, targets: false, device: null },
    { plugin: SH, pluginName: 'Smart Home', id: 'scene:home', title: 'Heizung 21 °C', subtitle: null, icon: null, kind: 'button', state: null, verbs: null, targets: false, device: null },
  ] });
  assert.deepEqual((await as(TIM)('GET', '/presence/actions')).json.actions, [], 'everyone may look; Tim has none');
  for (const [bad, field] of [
    [{ trigger: 'someone_sneezes', actions: [QA('x')] }, 'trigger'], [{ trigger: 'person_home', actions: [QA('x')] }, 'userId'], [{ trigger: 'person_home', userId: 99, actions: [QA('x')] }, 'userId'],
    [{ trigger: 'all_away', graceMinutes: 121, actions: [QA('x')] }, null], [{ trigger: 'all_away', actions: [] }, 'actions'],
    [{ trigger: 'all_away', actions: [{ type: 'quick_action', plugin: 'gatecontrol-familie', id: 'x' }] }, 'actions.0.plugin'],
    [{ trigger: 'all_away', actions: [{ type: 'quick_action', plugin: SH, id: 'bad id' }] }, 'actions.0.id'],
    [{ trigger: 'all_away', actions: [{ type: 'notify', to: [99] }] }, 'actions.0.to'], [{ trigger: 'all_away', actions: [{ type: 'notify', to: 'parents', text: 'x'.repeat(121) }] }, 'actions.0.text'],
    [{ trigger: 'all_away', actions: [{ type: 'teleport' }] }, 'actions.0.type'], [{ trigger: 'all_away', conditions: { time: { from: '18:00', to: '18:00' } }, actions: [QA('x')] }, 'conditions.time'],
    [{ trigger: 'all_away', conditions: { afterSunset: 'yes' }, actions: [QA('x')] }, null],
  ]) {
    const r = (await as(ANNA)('POST', '/presence/rules', bad)).json;
    assert.equal(r.code, 'invalid', JSON.stringify(bad));
    if (field) assert.equal(r.field, field, JSON.stringify(bad));
  }
  const rule = (await as(ANNA)('POST', '/presence/rules', { name: 'Sparen', trigger: 'all_away', actions: [QA('scene:away', 'Heizung 17 °C'), { type: 'notify', to: 'parents' }] })).json.rule;
  assert.deepEqual({ ...rule, id: 0 }, {
    id: 0, name: 'Sparen', trigger: 'all_away', userId: null, graceMinutes: 10, conditions: { time: null, afterSunset: false },
    actions: [
      { type: 'quick_action', plugin: SH, id: 'scene:away', title: 'Heizung 17 °C', state: null, kind: 'button', verb: null, available: true, needsTarget: false },
      { type: 'notify', to: 'parents', text: null },
    ],
    active: true, ownerId: ANNA.id, ownerName: 'Anna', lastRunAt: null, lastResult: null, createdAt: '2026-10-14T08:00:00Z', updatedAt: '2026-10-14T08:00:00Z',
  });
  // Marc edits the name: Anna stays the owner; Marc sets the actions: Marc owns it — and lacks the scene
  assert.equal((await as(MARC)('PATCH', `/presence/rules/${rule.id}`, { name: 'Sparen!' })).json.rule.ownerId, ANNA.id);
  const m = (await as(MARC)('PATCH', `/presence/rules/${rule.id}`, { actions: [QA('scene:away')] })).json.rule;
  assert.deepEqual([m.ownerId, m.actions[0].available], [MARC.id, false], 'Marc does not have that scene: "Aktion nicht mehr verfügbar"');
  const list = (await as(ANNA)('GET', '/presence/rules')).json;
  assert.deepEqual([list.rules.length, list.log], [1, []]);
  assert.equal((await as(ANNA)('DELETE', `/presence/rules/${rule.id}`)).status, 200);
  assert.equal((await as(ANNA)('DELETE', `/presence/rules/${rule.id}`)).status, 404);
}));

test('all away: after the grace time, once per transition, quick action as the owner via gc.actions, non-sharing people do not count', () => {
  const log = [];
  return withFamily(ON(log), async (host, { as, clock }) => {
    await share(as, ANNA, MARC);
    const rule = (await as(ANNA)('POST', '/presence/rules', { trigger: 'all_away', graceMinutes: 10, actions: [QA('scene:away', 'Heizung 17 °C'), { type: 'notify', to: 'all' }] })).json.rule;
    await as(ANNA)('POST', '/presence', { home: true });
    await as(MARC)('POST', '/presence', { home: true });
    clock.add(MIN);
    await as(ANNA)('POST', '/presence', { home: false });
    await host.tick();
    assert.equal(log.length, 0, 'Marc is still home');
    clock.add(MIN);
    await as(MARC)('POST', '/presence', { home: false }); // 08:02 — everyone who shares is away (Lena, Tim: not shared)
    clock.add(9 * MIN);
    await host.tick();
    assert.equal(log.length, 0, 'grace: 9 minutes');
    clock.add(MIN);
    await host.tick();
    assert.equal(log.length, 1, 'after 10 minutes');
    assert.equal(log[0].id, 'scene:away');
    assert.deepEqual(log[0].viewer, { id: ANNA.id, name: 'Anna', role: 'user', portal: true, loggedIn: true, automation: true, via: 'gatecontrol-familie' });
    assert.deepEqual(host.actionRuns[0].lang, 'de');
    const n = pushes(host, 'presence_rule');
    assert.deepEqual([n.length, n[0].topic, n[0].title, n[0].users.sort()], [1, 'presence', 'Alle sind unterwegs', [ANNA.id, MARC.id, LENA.id, TIM.id]]);
    assert.deepEqual(n[0].data.familie, { type: 'presence_rule', ruleId: rule.id, trigger: 'all_away', userId: null });
    // once per transition: more ticks, nothing
    for (let i = 0; i < 3; i++) { clock.add(5 * MIN); await host.tick(); }
    assert.equal(log.length, 1);
    const l = (await as(ANNA)('GET', '/presence/log')).json.log;
    assert.deepEqual(l.map((x) => [x.ruleId, x.trigger, x.ok]), [[rule.id, 'all_away', true]]);
    assert.deepEqual(l[0].results, [
      { type: 'quick_action', plugin: SH, id: 'scene:away', title: 'Heizung 17 °C', state: null, verb: null, ok: true, message: 'Szene gestartet', error: null, unchanged: false },
      { type: 'notify', ok: true, sent: 4, error: null },
    ]);
    const r = (await as(ANNA)('GET', '/presence/rules')).json.rules[0];
    assert.deepEqual([r.lastRunAt, r.lastResult.ok], ['2026-10-14T08:12:00Z', true]);
    // a new transition (Marc back and gone again) — but within 10 minutes of the last run: throttled, retried while all stay away
    clock.set(Date.UTC(2026, 9, 14, 8, 13));
    await as(MARC)('POST', '/presence', { home: true });
    clock.add(MIN);
    await as(MARC)('POST', '/presence', { home: false }); // 08:14 — with grace 0 the new episode is due at once, within 10 minutes of the last run (08:12)
    await as(ANNA)('PATCH', `/presence/rules/${rule.id}`, { graceMinutes: 0 });
    await host.tick();
    assert.equal(log.length, 1, 'throttled (last run 08:12)');
    clock.set(Date.UTC(2026, 9, 14, 8, 22));
    await host.tick();
    assert.equal(log.length, 2, 'retried after the 10 minutes while everyone stays away');
    await host.tick();
    assert.equal(log.length, 2);
  });
});

test('all away needs at least one sharing person who reported; unknown blocks', () => {
  const log = [];
  return withFamily(ON(log), async (host, { as, clock }) => {
    await as(ANNA)('POST', '/presence/rules', { trigger: 'all_away', graceMinutes: 0, actions: [QA('scene:away')] });
    await host.tick();
    assert.equal(log.length, 0, 'nobody shares');
    await share(as, ANNA, MARC);
    await as(ANNA)('POST', '/presence', { home: false });
    await host.tick();
    assert.equal(log.length, 0, 'Marc shares but never reported: unknown, not away');
    clock.add(MIN);
    await as(MARC)('POST', '/presence', { home: false });
    assert.equal(log.length, 1, 'grace 0: at once, in the report');
  });
});

test('arrivals: first home, a child home alone, a person; time window; after sunset; 10-minute throttle drops a repeat', () => {
  const log = [];
  return withFamily(ON(log, { settings: { lat: '52.52', lon: '13.405' } }), async (host, { as, clock }) => {
    await share(as, ANNA, MARC, TIM, LENA);
    const first = (await as(ANNA)('POST', '/presence/rules', { trigger: 'first_home', actions: [QA('scene:home')] })).json.rule;
    const alone = (await as(MARC)('POST', '/presence/rules', { trigger: 'child_home_alone', actions: [{ type: 'notify', to: 'parents', text: '{name} ist zuhause' }] })).json.rule;
    const tim = (await as(ANNA)('POST', '/presence/rules', { trigger: 'person_home', userId: TIM.id, conditions: { time: { from: '15:00', to: '18:00' } }, actions: [{ type: 'notify', to: [ANNA.id] }] })).json.rule;
    const dark = (await as(ANNA)('POST', '/presence/rules', { trigger: 'person_away', userId: LENA.id, conditions: { afterSunset: true }, actions: [{ type: 'notify', to: 'parents' }] })).json.rule;
    for (const u of [ANNA, MARC, LENA, TIM]) await as(u)('POST', '/presence', { home: false });
    clock.add(MIN);
    // 10:01 Tim comes home first and alone
    await as(TIM)('POST', '/presence', { home: true });
    assert.equal(log.length, 1, 'first home → scene as Anna');
    assert.deepEqual([log[0].id, log[0].viewer.id], ['scene:home', ANNA.id]);
    const p = pushes(host, 'presence_rule');
    assert.deepEqual(p.map((x) => [x.data.familie.ruleId, x.title, x.users.sort()]), [[alone.id, 'Tim ist zuhause', [ANNA.id, MARC.id]]], 'child alone; person_home outside its window');
    // Lena comes home: not first, not alone (no parent home, but a child — still "alone": no sharing parent)
    clock.add(MIN);
    await as(LENA)('POST', '/presence', { home: true });
    assert.equal(log.length, 1, 'not the first one');
    assert.equal(pushes(host, 'presence_rule').length, 1, 'throttled: child_home_alone ran a minute ago — the repeat is dropped');
    // a parent home → no "alone"
    clock.add(15 * MIN);
    await as(ANNA)('POST', '/presence', { home: true });
    clock.add(MIN);
    await as(TIM)('POST', '/presence', { home: false });
    clock.add(MIN);
    await as(TIM)('POST', '/presence', { home: true });
    assert.equal(pushes(host, 'presence_rule').length, 1, 'Anna is home');
    // 16:30 Tim comes home: within the window
    clock.set(Date.UTC(2026, 9, 14, 14, 30));
    await as(TIM)('POST', '/presence', { home: false });
    clock.add(MIN);
    await as(TIM)('POST', '/presence', { home: true });
    assert.deepEqual(pushes(host, 'presence_rule').slice(1).map((x) => [x.data.familie.ruleId, x.title, x.users]), [[tim.id, 'Tim ist zuhause', [ANNA.id]]]);
    // Lena leaves at 17:00 (sun up in Berlin) and at 19:00 (after sunset)
    clock.set(Date.UTC(2026, 9, 14, 15, 0));
    await as(LENA)('POST', '/presence', { home: false });
    assert.equal(pushes(host, 'presence_rule').filter((x) => x.data.familie.ruleId === dark.id).length, 0, 'sun still up');
    clock.set(Date.UTC(2026, 9, 14, 16, 50));
    await as(LENA)('POST', '/presence', { home: true });
    clock.add(MIN);
    await as(LENA)('POST', '/presence', { home: false });
    const d = pushes(host, 'presence_rule').filter((x) => x.data.familie.ruleId === dark.id);
    assert.deepEqual([d.length, d[0].title], [1, 'Lena ist unterwegs']);
    assert.equal(presence.THROTTLE_MS, 10 * MIN);
    assert.ok(first.id);
  });
});

test('time windows span midnight; afterSunset ignored without a location', () => {
  assert.equal(presence.inWindow('23:30', { from: '22:00', to: '06:00' }), true);
  assert.equal(presence.inWindow('05:59', { from: '22:00', to: '06:00' }), true);
  assert.equal(presence.inWindow('06:00', { from: '22:00', to: '06:00' }), false);
  assert.equal(presence.inWindow('12:00', { from: '08:00', to: '12:00' }), false);
  assert.equal(presence.inWindow('12:00', null), true);
  const rule = { conditions: { time: null, afterSunset: true } };
  assert.equal(presence.conditionsHold(rule, { tz: 'Europe/Berlin', location: null }, Date.UTC(2026, 9, 14, 10)), true);
  assert.equal(presence.conditionsHold(rule, { tz: 'Europe/Berlin', location: { lat: 52.52, lon: 13.405 } }, Date.UTC(2026, 9, 14, 10)), false);
});

test('a quick action that vanished: shown as unavailable, the run is logged as failed (not_found)', () => {
  const log = [];
  return withFamily(ON(log, { gone: true }), async (host, { as }) => {
    await share(as, ANNA);
    const rule = (await as(ANNA)('POST', '/presence/rules', { trigger: 'person_away', userId: ANNA.id, actions: [QA('scene:away', 'Heizung 17 °C'), QA('scene:home')] })).json.rule;
    assert.deepEqual(rule.actions.map((a) => a.available), [false, true]);
    await as(ANNA)('POST', '/presence', { home: false });
    assert.deepEqual(log.map((x) => x.id), ['scene:home'], 'only the one still offered ran');
    const l = (await as(ANNA)('GET', '/presence/rules')).json;
    assert.deepEqual(l.log[0].results.map((x) => [x.id, x.ok, x.error]), [['scene:away', false, 'not_found'], ['scene:home', true, null]]);
    assert.deepEqual([l.log[0].ok, l.rules[0].lastResult.ok], [false, false]);
    assert.ok(host.logs.some((x) => x.level === 'warn' && x.message.includes('presence rule run failed')));
  });
});

test('admin page: who is home, rules saved there run as the administrator; the wall shows home / away', () => {
  const log = [];
  return withFamily({ ...ON(log), settings: { mod_presence: true, mod_wall: true } }, async (host, { as, admin, call }) => {
    await share(as, ANNA, TIM);
    await as(ANNA)('POST', '/presence', { home: true });
    const st = (await admin('GET', 'presence')).json;
    assert.deepEqual([st.modules, st.location, st.actionsAvailable, st.actions.map((a) => a.id)], [{ presence: true }, null, true, ['scene:away', 'scene:home']]);
    assert.deepEqual(st.members.map((m) => [m.name, m.state]), [['Anna', 'home'], ['Marc', 'not_shared'], ['Lena', 'not_shared'], ['Tim', 'unknown']]);
    const r = (await admin('POST', 'presence/rules', { trigger: 'person_home', userId: TIM.id, actions: [QA('scene:home', 'Heizung 21 °C')] })).json.rule;
    assert.deepEqual([r.ownerId, r.ownerName, r.actions[0].available], [ADMIN.id, 'admin', true]);
    assert.equal((await admin('PATCH', `presence/rules/${r.id}`, { active: false })).json.rule.active, false);
    await admin('PATCH', `presence/rules/${r.id}`, { active: true });
    await as(TIM)('POST', '/presence', { home: true });
    assert.deepEqual([log.length, log[0].viewer.id, log[0].viewer.automation], [1, ADMIN.id, true]);
    assert.equal((await admin('GET', 'presence')).json.log.length, 1);
    assert.equal((await as(ANNA)('GET', '/presence/rules')).json.rules[0].ownerName, 'admin', 'the same rules in the portal');
    assert.equal((await call(portal(ANNA), 'GET', '/admin/presence')).json.code, 'forbidden', 'admin pages only');
    assert.equal((await admin('DELETE', `presence/rules/${r.id}`)).status, 200);
    // the wall: home / away for sharing members, nothing for device trust
    await admin('POST', 'members', { userId: KUECHE.id, role: 'wall' });
    const w = (await call(portal(KUECHE), 'GET', '/wall')).json;
    assert.deepEqual(w.members.map((m) => [m.name, m.presence]), [['Anna', 'home'], ['Marc', null], ['Lena', null], ['Tim', 'home']]);
    assert.ok((await call(portal(KUECHE, false), 'GET', '/wall')).json.members.every((m) => m.presence === null));
    assert.equal((await call(portal(KUECHE), 'GET', '/presence')).json.code, 'forbidden');
    // removing a member drops its consent
    await admin('DELETE', `members/${TIM.id}`);
    await admin('POST', 'members', { userId: TIM.id, role: 'child', birthdate: '2017-01-01' });
    assert.equal((await as(ANNA)('GET', '/presence')).json.members.find((m) => m.userId === TIM.id).state, 'not_shared');
  });
});

test('gc.actions refused by the host (rate limit): logged per action, the rule run still completes', () => {
  const log = [];
  return withFamily(ON(log), async (host, { as }) => {
    await share(as, ANNA);
    const rule = (await as(ANNA)('POST', '/presence/rules', { trigger: 'person_home', userId: ANNA.id, actions: [QA('scene:home'), { type: 'notify', to: [MARC.id] }] })).json.rule;
    // use up the host's 60 runs per hour
    for (let i = 0; i < 60; i++) await host.gc.actions.run({ userId: ANNA.id, plugin: SH, id: 'scene:home' });
    await as(ANNA)('POST', '/presence', { home: true });
    const l = (await as(ANNA)('GET', '/presence/log')).json.log[0];
    assert.deepEqual([l.ruleId, l.ok, l.results.map((x) => [x.type, x.ok, x.error])], [rule.id, false, [['quick_action', false, 'rate_limit'], ['notify', true, null]]]);
    assert.equal(pushes(host, 'presence_rule').length, 1);
  });
});
