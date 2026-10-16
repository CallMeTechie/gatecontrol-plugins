'use strict';

// Target states of switches in presence rules (1.4.0, GateControl ≥ 1.173.0): a
// toggle quick action stores the state it should get ('on' | 'off'), a button
// none — checked against the owner's gc.actions.list (400 state_required /
// invalid); the run passes `state` to gc.actions.run (a locked car is locked,
// never unlocked; a plugin without targets is skipped by the host when the
// state is already there); a toggle saved before 1.4.0 without a state is not
// run (needs_target) and marked `needsTarget` in the rule views; the log
// carries state, verb and `unchanged`.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withFamily, ADMIN, ANNA, MARC, T0 } = require('./helpers');

const SK = 'gatecontrol-skoda';
const SH = 'gatecontrol-smarthome';
const CAR = 'M5 16l1-5 2-3h8l2 3 1 5v3h-2a2 2 0 0 1-4 0H9a2 2 0 0 1-4 0H3v-3z';
const LOCK = { on: 'Verriegeln', off: 'Entriegeln' };

/**
 * Fahrzeuge (targets: true — the hook gets the target) and a smart home plugin without targets
 * (the host decides from the listed state). `world` holds the states; every hook call is recorded.
 */
function plugins(world, calls) {
  const elroq = { id: 'v:1', title: 'Elroq', subtitle: 'Škoda Elroq', icon: CAR };
  return [
    {
      plugin: SK, pluginName: 'Fahrzeuge',
      quickActions: (viewer) => (viewer.id === ANNA.id || viewer.id === ADMIN.id ? [
        { id: 'lock:1', title: 'Schloss', subtitle: 'Elroq', kind: 'toggle', state: world.lock, verbs: LOCK, targets: true, device: elroq },
        { id: 'climate:1', title: 'Klimatisierung', subtitle: 'Elroq', kind: 'toggle', state: world.climate, verbs: { on: 'Einschalten', off: 'Ausschalten' }, targets: true, device: elroq },
      ] : []),
      runQuickAction: (viewer, id, lang, extra) => {
        calls.push({ plugin: SK, id, target: extra ? extra.target : null });
        const kind = id.split(':')[0];
        const next = extra ? extra.target : (world[kind] === 'on' ? 'off' : 'on');
        world[kind] = next;
        return { ok: true, message: `${id} → ${next}`, state: next };
      },
    },
    {
      plugin: SH, pluginName: 'Smart Home',
      quickActions: (viewer) => (viewer.id === ANNA.id || viewer.id === ADMIN.id ? [
        { id: 'light:hall', title: 'Flurlicht', kind: 'toggle', state: world.hall },
        { id: 'scene:away', title: 'Abwesend' },
      ] : []),
      runQuickAction: (viewer, id, lang, extra) => {
        calls.push({ plugin: SH, id, target: extra ? extra.target : null });
        if (id === 'light:hall') world.hall = world.hall === 'on' ? 'off' : 'on';
        return { ok: true, message: id, state: id === 'light:hall' ? world.hall : null };
      },
    },
  ];
}

const opts = (world, calls) => ({ settings: { mod_presence: true }, actions: plugins(world, calls) });
const QA = (plugin, id, state, title) => ({ type: 'quick_action', plugin, id, title: title || null, ...(state === undefined ? {} : { state }) });

async function shareAndLeave(as) {
  await as(ANNA)('PUT', '/presence/consent', { share: true });
  await as(ANNA)('POST', '/presence', { home: false });
}

test('presence/actions carries device, verbs, targets and state of every action', () => {
  const world = { lock: 'on', climate: 'off', hall: 'off' };
  return withFamily(opts(world, []), async (host, { as }) => {
    const acts = (await as(ANNA)('GET', '/presence/actions')).json.actions;
    assert.deepEqual(acts[0], {
      plugin: SK, pluginName: 'Fahrzeuge', id: 'lock:1', title: 'Schloss', subtitle: 'Elroq', icon: null, kind: 'toggle', state: 'on',
      verbs: LOCK, targets: true, device: { id: 'v:1', title: 'Elroq', subtitle: 'Škoda Elroq', icon: CAR },
    });
    assert.deepEqual(acts.map((a) => [a.id, a.kind, a.verbs && a.verbs.on, a.targets]), [
      ['lock:1', 'toggle', 'Verriegeln', true], ['climate:1', 'toggle', 'Einschalten', true], ['light:hall', 'toggle', null, false], ['scene:away', 'button', null, false],
    ]);
  });
});

test('validation: a switch needs a target state (state_required), a button takes none; checked against the owner\'s list', () => {
  const world = { lock: 'on', climate: 'off', hall: 'off' };
  return withFamily(opts(world, []), async (host, { as, admin }) => {
    const post = (body) => as(ANNA)('POST', '/presence/rules', { trigger: 'all_away', ...body });
    let r = await post({ actions: [QA(SK, 'lock:1')] });
    assert.deepEqual([r.status, r.json.code, r.json.field, r.json.error], [400, 'state_required', 'actions.0.state', 'Für einen Schalter fehlt der Zielzustand.']);
    r = await post({ actions: [QA(SK, 'lock:1', 'on'), QA(SH, 'scene:away', 'on')] });
    assert.deepEqual([r.status, r.json.code, r.json.field], [400, 'invalid', 'actions.1.state']);
    r = await post({ actions: [QA(SK, 'lock:1', 'locked')] });
    assert.deepEqual([r.status, r.json.code, r.json.field], [400, 'invalid', 'actions.0.state']);
    r = await post({ actions: [QA(SK, 'lock:1', 'on', 'Elroq – Schloss'), QA(SH, 'light:hall', 'off', 'Flurlicht'), QA(SH, 'scene:away', null, 'Abwesend')] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.rule.actions, [
      { type: 'quick_action', plugin: SK, id: 'lock:1', title: 'Elroq – Schloss', state: 'on', kind: 'toggle', verb: 'Verriegeln', available: true, needsTarget: false },
      { type: 'quick_action', plugin: SH, id: 'light:hall', title: 'Flurlicht', state: 'off', kind: 'toggle', verb: null, available: true, needsTarget: false },
      { type: 'quick_action', plugin: SH, id: 'scene:away', title: 'Abwesend', state: null, kind: 'button', verb: null, available: true, needsTarget: false },
    ]);
    // Marc does not have these actions: what he saves is kept as given (kind unknown), the view marks it unavailable
    const id = r.json.rule.id;
    r = await as(MARC)('PATCH', `/presence/rules/${id}`, { actions: [QA(SK, 'lock:1', 'off'), QA(SK, 'climate:1')] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.rule.actions.map((a) => [a.state, a.kind, a.available, a.needsTarget]), [['off', null, false, false], [null, null, false, false]]);
    // the admin page checks against the administrator's list
    r = await admin('POST', 'presence/rules', { trigger: 'first_home', actions: [QA(SK, 'climate:1')] });
    assert.deepEqual([r.status, r.json.code], [400, 'state_required']);
    r = await admin('POST', 'presence/rules', { trigger: 'first_home', actions: [QA(SK, 'climate:1', 'on')] });
    assert.deepEqual([r.status, r.json.rule.actions[0].verb, r.json.rule.ownerId], [200, 'Einschalten', ADMIN.id]);
  });
});

test('execution: the target state reaches the plugin — a locked car is locked again, never unlocked; the log names the verb', () => {
  const world = { lock: 'on', climate: 'on', hall: 'off' };
  const calls = [];
  return withFamily(opts(world, calls), async (host, { as }) => {
    await as(ANNA)('POST', '/presence/rules', {
      name: 'Alle weg', trigger: 'all_away', graceMinutes: 0,
      actions: [QA(SK, 'lock:1', 'on', 'Elroq – Schloss'), QA(SK, 'climate:1', 'off', 'Elroq – Klimatisierung'), QA(SH, 'light:hall', 'off', 'Flurlicht'), QA(SH, 'scene:away', null, 'Abwesend')],
    });
    await shareAndLeave(as);
    assert.deepEqual(calls, [
      { plugin: SK, id: 'lock:1', target: 'on' },      // locked + target on: the hook gets the target (sends lock)
      { plugin: SK, id: 'climate:1', target: 'off' },
      // the hall light is already off and its plugin knows no targets: the host skips the hook (unchanged)
      { plugin: SH, id: 'scene:away', target: null },
    ]);
    assert.deepEqual(world, { lock: 'on', climate: 'off', hall: 'off' }, 'nothing flipped the wrong way');
    assert.deepEqual(host.actionRuns.map((x) => [x.id, x.state]), [['lock:1', 'on'], ['climate:1', 'off'], ['light:hall', 'off'], ['scene:away', null]]);
    const log = (await as(ANNA)('GET', '/presence/log')).json.log[0];
    assert.equal(log.ok, true);
    assert.deepEqual(log.results.map((x) => [x.title, x.state, x.verb, x.ok, x.unchanged, x.message]), [
      ['Elroq – Schloss', 'on', 'Verriegeln', true, false, 'lock:1 → on'],
      ['Elroq – Klimatisierung', 'off', 'Ausschalten', true, false, 'climate:1 → off'],
      ['Flurlicht', 'off', null, true, true, null],
      ['Abwesend', null, null, true, false, 'scene:away'],
    ]);
  });
});

test('execution: a plugin without targets switches over when the state differs; an unknown state fails (state_unknown)', () => {
  const world = { lock: 'on', climate: 'off', hall: 'on' };
  const calls = [];
  return withFamily(opts(world, calls), async (host, { as }) => {
    await as(ANNA)('POST', '/presence/rules', { trigger: 'all_away', graceMinutes: 0, actions: [QA(SH, 'light:hall', 'off', 'Flurlicht')] });
    await shareAndLeave(as);
    assert.deepEqual([calls, world.hall], [[{ plugin: SH, id: 'light:hall', target: null }], 'off']);
    // the light's state becomes unknown: the host refuses to guess
    world.hall = null;
    await as(ANNA)('POST', '/presence/rules', { trigger: 'first_home', actions: [QA(SH, 'light:hall', 'on', 'Flurlicht')] });
    await host.gc.db.run('UPDATE presence_state SET reported_at = reported_at - 120000');
    await as(ANNA)('POST', '/presence', { home: true });
    const log = (await as(ANNA)('GET', '/presence/log')).json.log[0];
    assert.deepEqual([log.ok, log.results[0].error, log.results[0].state], [false, 'state_unknown', 'on']);
    assert.equal(calls.length, 1, 'no hook call');
  });
});

test('rules from before 1.4.0: a switch without a state is not run (needs_target) and marked needsTarget; a button still runs', () => {
  const world = { lock: 'on', climate: 'off', hall: 'off' };
  const calls = [];
  return withFamily(opts(world, calls), async (host, { as, admin }) => {
    // stored as 1.3.x stored it: no state, no kind
    const legacy = [
      { type: 'quick_action', plugin: SK, id: 'lock:1', title: 'Verriegelt' },
      { type: 'quick_action', plugin: SH, id: 'scene:away', title: 'Abwesend' },
      { type: 'notify', to: 'parents', text: null },
    ];
    await host.gc.db.run(`INSERT INTO presence_rules (name, trigger_type, user_id, grace_minutes, conditions_json, actions_json, active, owner_id, created_at, updated_at)
      VALUES ('Alt', 'all_away', NULL, 0, '{}', ?, 1, ?, ?, ?)`, [JSON.stringify(legacy), ANNA.id, T0, T0]);
    const view = (await as(ANNA)('GET', '/presence/rules')).json.rules[0];
    assert.deepEqual(view.actions.slice(0, 2).map((a) => [a.id, a.state, a.kind, a.needsTarget, a.available, a.verb]), [
      ['lock:1', null, 'toggle', true, true, null], ['scene:away', null, 'button', false, true, null],
    ]);
    assert.equal((await admin('GET', 'presence')).json.rules[0].actions[0].needsTarget, true, 'the admin page too');
    await shareAndLeave(as);
    assert.deepEqual(calls, [{ plugin: SH, id: 'scene:away', target: null }], 'the lock is not touched');
    const log = (await as(ANNA)('GET', '/presence/log')).json.log[0];
    assert.deepEqual(log.results.map((x) => [x.type, x.ok, x.error]), [['quick_action', false, 'needs_target'], ['quick_action', true, null], ['notify', true, null]]);
    assert.equal(log.ok, false);
    // renaming keeps the old actions (still needs a target); setting the actions with a state fixes it
    const id = view.id;
    let r = await as(ANNA)('PATCH', `/presence/rules/${id}`, { name: 'Alt!' });
    assert.equal(r.json.rule.actions[0].needsTarget, true);
    r = await as(ANNA)('PATCH', `/presence/rules/${id}`, { actions: [QA(SK, 'lock:1')] });
    assert.deepEqual([r.status, r.json.code], [400, 'state_required']);
    r = await as(ANNA)('PATCH', `/presence/rules/${id}`, { actions: [QA(SK, 'lock:1', 'on', 'Elroq – Schloss')] });
    assert.deepEqual(r.json.rule.actions.map((a) => [a.state, a.verb, a.needsTarget]), [['on', 'Verriegeln', false]]);
  });
});
