'use strict';

// Logikketten Stufe 1 (1.11.0) — the server part: version 2 definitions of the chains on a GateControl gateway
// (checked, compiled, accepted by the edge part as they are), version 1 chains unchanged and shown as version 2,
// the loop check (a sure loop is refused, a possible one is a warning), the protocol (event `runs`, what the gateway
// kept while it was away, the brake switches a chain off), the Testlauf through the gateway, admins only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHost, hostError } = require('../../../tools/testing/mock-host');
const { DIR, ADA, USERS, ADMIN } = require('./helpers');
const edgeRules = require('../edge/rules');

const GW = { id: 7, name: 'Pi Keller', state: 'running', version: '1.20.0' };

async function withEdge(o, fn) {
  const calls = [];
  const state = { runs: o.runs || null, test: o.test || null };
  const call = async (gatewayId, method, params) => {
    calls.push({ gatewayId, method, params });
    if (method === 'info') return { version: '1.11.0', startedAt: '2026-11-18T04:00:00.000Z', mqtt: 'ok', lan: ['192.168.1.23'], devices: 0, found: 0 };
    if (method === 'discover') return { devices: [] };
    if (method === 'runs' && state.runs) return state.runs(params);
    if (method === 'test' && state.test) return state.test(params);
    throw hostError('edge_error', `unknown_method: unknown method ${method}`);
  };
  const host = await createHost(DIR, { users: USERS, gatecontrol: '1.228.1', edge: { gateways: [GW], call } });
  try {
    await host.start();
    await fn(host, calls, state);
  } finally {
    await host.stop();
    await host.close();
  }
}

const admin = (host, method, p, body, user = ADMIN) => {
  const [pathOnly, qs] = String(p).split('?');
  return host.request({ method, path: pathOnly, query: Object.fromEntries(new URLSearchParams(qs || '')), body: body === undefined ? null : body, user });
};

/** A button (Shelly Plus i4), a dimmer, a plug with metering and a Tasmota fan behind gateway 7. */
async function house(host) {
  const mk = async (name, family) => (await admin(host, 'POST', '/edge/devices', { gateway_id: 7, name, family })).json.credentials;
  const now = new Date().toISOString();
  const taster = await mk('Taster Flur', 'shelly2');
  const dimmer = await mk('Flurlicht', 'shelly2');
  const plug = await mk('Waschmaschine', 'shelly2');
  const fan = await mk('Lüfter', 'tasmota');
  await host.edgeEvent(7, 'states', { devices: [
    { base: dimmer.base, family: 'shelly2', online: true, seenAt: now, ch: { 'light:0': { on: false, bri: 40 } }, sensor: {}, info: {}, drop: [] },
    { base: plug.base, family: 'shelly2', online: true, seenAt: now, ch: { 'switch:0': { on: true, power: 1800 } }, sensor: {}, info: {}, drop: [] },
    { base: fan.base, family: 'tasmota', online: true, seenAt: now, ch: { 'switch:0': { on: false } }, sensor: {}, info: {}, drop: [] },
  ] });
  const res = (await host.gc.db.query("SELECT id, name FROM resources WHERE deconz_type = 'edge'")).rows;
  const devs = (await host.gc.db.query('SELECT id, name, base FROM edge_devices')).rows;
  return {
    id: (name) => res.find((r) => r.name === name).id,
    dev: (name) => devs.find((d) => d.name === name).id,
    base: { taster: taster.base, dimmer: dimmer.base, plug: plug.base, fan: fan.base },
  };
}

const post = (host, name, definition) => admin(host, 'POST', '/rules', { gateway_id: 7, source: 'edge', name, definition });

test('a version 2 chain: checked, kept as sent, compiled — and the edge part takes the compiled chain as it is', () => withEdge({}, async (host) => {
  const h = await house(host);
  const def = {
    version: 2,
    triggers: [{ kind: 'button', deviceId: h.dev('Taster Flur'), input: 1, event: 'single' }, { kind: 'time', at: '06:30' }, { kind: 'power', resourceId: h.id('Waschmaschine'), op: 'lt', value: 5 }],
    conditions: { mode: 'any', list: [{ kind: 'time', from: '18:00', to: '23:30' }, { kind: 'state', resourceId: h.id('Lüfter'), is: 'off' }, { kind: 'days', days: [5, 1] }] },
    steps: [{ kind: 'action', resourceId: h.id('Flurlicht'), set: { bri: 60 } }, { kind: 'wait', seconds: 180 }, { kind: 'action', resourceId: h.id('Flurlicht'), set: { on: false } }],
    retrigger: 'cancel',
  };
  const r = await post(host, 'Flurlicht nachts mit Taster und Uhrzeit', def);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const cfg = host.edgeConfigs.get(7).rules;
  assert.deepEqual(cfg, [{
    id: r.json.rule.id, v: 2,
    when: [{ k: 'btn', base: h.base.taster, input: 1, ev: 'single' }, { k: 'time', at: '06:30' }, { k: 'dev', base: h.base.plug, ch: 'switch:0', field: 'power', op: 'lt', value: 5 }],
    cond: { mode: 'any', list: [{ k: 'time', from: '18:00', to: '23:30' }, { k: 'dev', base: h.base.fan, ch: 'switch:0', field: 'on', op: 'eq', value: false }, { k: 'days', days: [1, 5] }] },
    steps: [{ k: 'act', base: h.base.dimmer, family: 'shelly2', ch: 'light:0', op: 'bri', value: 60 }, { k: 'wait', s: 180 }, { k: 'act', base: h.base.dimmer, family: 'shelly2', ch: 'light:0', op: 'off' }],
    re: 'cancel',
  }]);
  assert.deepEqual(edgeRules.cleanRule(JSON.parse(JSON.stringify(cfg[0]))), cfg[0], 'the edge part takes the chain as it is');
  const list = (await admin(host, 'GET', '/rules?gateway_id=7&source=edge')).json.rules;
  assert.deepEqual([list[0].definition, list[0].v2, list[0].orphaned, list[0].stopped, list[0].runs_today], [def, def, false, null, 0]);

  // what does not fit is refused with a reason
  const ok = { version: 2, triggers: [{ kind: 'time', at: '07:00' }], conditions: { mode: 'all', list: [] }, steps: [{ kind: 'action', resourceId: h.id('Lüfter'), set: { on: true } }] };
  const cases = [
    [{ ...ok, triggers: [{ kind: 'button', deviceId: 9999, input: 0, event: 'single' }] }, 'foreign_device'],
    [{ ...ok, triggers: [{ kind: 'button', deviceId: h.dev('Taster Flur'), input: 0, event: 'quintuple' }] }, 'bad_button_trigger'],
    [{ ...ok, triggers: [{ kind: 'time', at: '7 Uhr' }] }, 'bad_time_trigger'],
    [{ ...ok, triggers: [{ kind: 'sun', event: 'sunset' }] }, 'foreign_resource'],      // stage 2
    [{ ...ok, conditions: { mode: 'all', list: [{ kind: 'days', days: [8] }] } }, 'bad_days_condition'],
    [{ ...ok, steps: [{ kind: 'wait', seconds: 60 }] }, 'no_action'],
    [{ ...ok, steps: [...ok.steps, { kind: 'wait', seconds: 86401 }] }, 'bad_wait'],
    [{ ...ok, steps: [...ok.steps, { kind: 'notify', text: 'x' }] }, 'bad_step'],
    [{ ...ok, steps: Array.from({ length: 21 }, () => ok.steps[0]) }, 'too_many_steps'],
    [{ ...ok, version: 3 }, 'bad_version'],
  ];
  for (const [d, detail] of cases) {
    const x = await post(host, 'X', d);
    assert.deepEqual([x.status, x.json.code, x.json.detail], [400, 'SMARTHOME_RULE_INVALID', detail], detail);
  }
  assert.equal((await post(host, 'Zwanzig Schritte', { ...ok, steps: Array.from({ length: 20 }, () => ok.steps[0]) })).status, 200, '20 steps fit');
}));

test('a version 1 chain runs unchanged; the new editor sees it as version 2 ("wird wahr: A und B"); saved, it is version 2', () => withEdge({}, async (host) => {
  const h = await house(host);
  const v1 = {
    triggers: [{ kind: 'state', resourceId: h.id('Waschmaschine'), event: 'on' }, { kind: 'power', resourceId: h.id('Waschmaschine'), op: 'gt', value: 1000 }],
    actions: [{ kind: 'relay', resourceId: h.id('Lüfter'), set: { on: true } }],
    timeWindow: { from: '08:00', to: '22:00' },
    delay: { minutes: 3, onRetrigger: 'cancel' },
  };
  const r = await post(host, 'Wäsche', v1);
  assert.equal(r.status, 200);
  const sent = host.edgeConfigs.get(7).rules[0];
  assert.equal(sent.v, undefined, 'still version 1 for the edge part');
  assert.deepEqual(sent.delay, { minutes: 3, mode: 'cancel' });
  const row = (await admin(host, 'GET', '/rules?gateway_id=7&source=edge')).json.rules[0];
  assert.deepEqual(row.definition, v1, 'no migration of the data');
  assert.deepEqual(row.v2, {
    version: 2,
    triggers: [{ kind: 'all', parts: v1.triggers }],
    conditions: { mode: 'all', list: [{ kind: 'state', resourceId: h.id('Waschmaschine'), is: 'on' }, { kind: 'power', resourceId: h.id('Waschmaschine'), op: 'gt', value: 1000 }, { kind: 'time', from: '08:00', to: '22:00' }] },
    steps: [{ kind: 'wait', seconds: 180 }, { kind: 'action', resourceId: h.id('Lüfter'), set: { on: true } }],
    retrigger: 'cancel',
  });
  // saved from the editor: version 2, "wird wahr" compiled as one trigger of all parts
  const up = await admin(host, 'PUT', `/rules/${r.json.rule.id}`, { name: 'Wäsche', definition: row.v2 });
  assert.equal(up.status, 200, JSON.stringify(up.json));
  const c = host.edgeConfigs.get(7).rules[0];
  assert.deepEqual(c.when, [{ k: 'all', parts: sent.triggers }]);
  assert.deepEqual(c.steps[0], { k: 'wait', s: 180 });
  // a single trigger stays a single one, ignore / reset become ignore / restart
  const one = (await admin(host, 'GET', '/rules?gateway_id=7&source=edge')).json.rules;
  assert.equal(one.length, 1);
  const r2 = await post(host, 'Eins', { triggers: [v1.triggers[0]], actions: v1.actions, delay: { minutes: 1, onRetrigger: 'reset' } });
  const v2 = (await admin(host, 'GET', '/rules?gateway_id=7&source=edge')).json.rules.find((x) => x.id === r2.json.rule.id).v2;
  assert.deepEqual([v2.triggers, v2.retrigger, v2.conditions.list], [[v1.triggers[0]], 'restart', []]);
  // deCONZ rules stay version 1
  const d = await admin(host, 'POST', '/rules', { gateway_id: 1, name: 'D', definition: { version: 2, triggers: [], steps: [] } });
  assert.deepEqual([d.status, d.json.detail], [400, 'bad_version']);
}));

test('loops: a sure one (A switches X off, B on again, no NUR WENN) is refused; a possible one is a warning; shared devices are named', () => withEdge({}, async (host) => {
  const h = await house(host);
  const X = h.id('Lüfter');
  const trig = (event) => ({ kind: 'state', resourceId: X, event });
  const set = (on) => ({ kind: 'action', resourceId: X, set: { on } });
  const a = await post(host, 'Lüfter aus', { version: 2, triggers: [trig('on')], conditions: { mode: 'all', list: [] }, steps: [set(false)] });
  assert.equal(a.status, 200);
  const b = { version: 2, triggers: [trig('off')], conditions: { mode: 'all', list: [] }, steps: [set(true)] };
  const check = await admin(host, 'POST', '/rules/check', { gateway_id: 7, definition: b });
  assert.deepEqual([check.json.loop, check.json.chains], ['sure', ['Lüfter aus']]);
  const refused = await post(host, 'Lüfter an', b);
  assert.deepEqual([refused.status, refused.json.code, refused.json.chains], [409, 'SMARTHOME_RULE_LOOP', ['Lüfter aus']]);
  assert.equal((await host.gc.db.query('SELECT COUNT(*) AS n FROM rules')).rows[0].n, 1);
  // with a condition it may loop, but need not: saved, with a warning in the editor
  const guarded = { ...b, conditions: { mode: 'all', list: [{ kind: 'time', from: '08:00', to: '09:00' }] } };
  assert.deepEqual((await admin(host, 'POST', '/rules/check', { gateway_id: 7, definition: guarded })).json.loop, 'possible');
  assert.equal((await post(host, 'Lüfter morgens an', guarded)).status, 200);
  // the same direction twice is no swing: possible at most
  const same = { version: 2, triggers: [trig('off')], conditions: { mode: 'all', list: [] }, steps: [set(false)] };
  assert.notEqual((await admin(host, 'POST', '/rules/check', { gateway_id: 7, definition: same })).json.loop, 'sure');
  // no loop, but another chain switches the same device
  const other = { version: 2, triggers: [{ kind: 'time', at: '22:00' }], conditions: { mode: 'all', list: [] }, steps: [set(false)] };
  const c = (await admin(host, 'POST', '/rules/check', { gateway_id: 7, definition: other })).json;
  assert.deepEqual([c.loop, c.shared], [null, [{ device: 'Lüfter', chains: ['Lüfter aus', 'Lüfter morgens an'] }]]);
}));

test('protocol: runs come with the event and after an absence; the brake switches a chain off with why; "Wieder starten"', () => withEdge({}, async (host, calls, state) => {
  const h = await house(host);
  const def = { version: 2, triggers: [{ kind: 'button', deviceId: h.dev('Taster Flur'), input: 0, event: 'single' }], conditions: { mode: 'all', list: [] }, steps: [{ kind: 'action', resourceId: h.id('Flurlicht'), set: { on: true } }] };
  const id = (await post(host, 'Flur', def)).json.rule.id;
  const now = Date.now();
  const at = (s) => new Date(now - s * 1000).toISOString();
  const run = (n, s, res, extra = {}) => ({ u: `ep1:${n}`, s, r: id, at: at(100 - n), by: 'event', tr: 0, res, why: null, ev: [[0, 'trig', 0], [2, 'cond', 'ok'], [9, 'act', 0], [140, 'ack', 0]], end: at(99 - n), ...extra });
  await host.edgeEvent(7, 'runs', { runs: [run(1, 1, 'ok'), run(2, 2, 'running'), { u: 'bad' }, run(3, 3, 'ok', { r: 9999 })] });
  let runs = (await admin(host, 'GET', '/rules/runs?gateway_id=7')).json.runs;
  assert.deepEqual(runs.map((r) => [r.uid, r.result, r.late]), [['ep1:2', 'running', false], ['ep1:1', 'ok', false]], 'unknown chains and broken records are left out');
  assert.deepEqual(runs[1].ev, [[0, 'trig', 0], [2, 'cond', 'ok'], [9, 'act', 0], [140, 'ack', 0]]);
  // the gateway was away: what it kept comes in when it is back (from where the server part stopped)
  state.runs = (p) => ({ epoch: 'ep1', runs: [run(2, 5, 'ok'), run(4, 6, 'stopped', { why: 'rate:12', ev: [[0, 'stop', 12]] })].filter((r) => r.s > (p.after || 0)), more: false });
  await host.edgeEvent(7, '$online', null);
  assert.deepEqual(calls.filter((c) => c.method === 'runs').pop().params, { epoch: 'ep1', after: 2 }, 'from where the server part stopped');
  runs = (await admin(host, 'GET', '/rules/runs?gateway_id=7')).json.runs;
  assert.deepEqual(runs.map((r) => [r.uid, r.result, r.late]), [['ep1:4', 'stopped', true], ['ep1:2', 'ok', true], ['ep1:1', 'ok', false]]);
  assert.deepEqual((await admin(host, 'GET', '/rules/runs?gateway_id=7&problems=1')).json.runs.map((r) => r.uid), ['ep1:4']);
  // the brake: off, with why; the gateway gets the list without it
  let row = (await admin(host, 'GET', '/rules?gateway_id=7&source=edge')).json.rules[0];
  assert.equal(row.enabled, false);
  assert.equal(row.stopped.reason, 'rate:12');
  assert.equal(row.runs_today, 4 - 1, 'today, without the skipped (none here): 3 runs');
  assert.deepEqual(host.edgeConfigs.get(7).rules, []);
  // the same stop again (a second pull) changes nothing; "Wieder starten" clears it and sends the chain again
  await host.edgeEvent(7, 'runs', { runs: [run(4, 6, 'stopped', { why: 'rate:12' })] });
  assert.equal((await admin(host, 'POST', `/rules/${id}/enabled`, { enabled: true })).json.rule.stopped, null);
  row = (await admin(host, 'GET', '/rules?gateway_id=7&source=edge')).json.rules[0];
  assert.deepEqual([row.enabled, row.stopped], [true, null]);
  assert.equal(host.edgeConfigs.get(7).rules.length, 1);
  // an old stop that arrives after the restart does not switch it off again
  await host.edgeEvent(7, 'runs', { runs: [run(5, 7, 'stopped', { why: 'rate:11', at: at(3600) })] });
  assert.equal((await admin(host, 'GET', '/rules?gateway_id=7&source=edge')).json.rules[0].enabled, true);
  // at most 200 per gateway
  await host.edgeEvent(7, 'runs', { runs: Array.from({ length: 64 }, (_, i) => run(100 + i, 100 + i, 'ok')) });
  for (let k = 0; k < 3; k++) await host.edgeEvent(7, 'runs', { runs: Array.from({ length: 64 }, (_, i) => run(200 + k * 64 + i, 200 + k * 64 + i, 'ok')) });
  assert.equal((await host.gc.db.get('SELECT COUNT(*) AS n FROM rule_runs WHERE gateway_id = 7')).row.n, 200);
  // a deleted chain takes its runs along
  await admin(host, 'DELETE', `/rules/${id}`);
  assert.equal((await host.gc.db.get('SELECT COUNT(*) AS n FROM rule_runs')).row.n, 0);
}));

test('Testlauf through the gateway: a saved chain by id, a draft compiled; "Trotzdem ausführen" only for a saved one; admins only', () => withEdge({}, async (host, calls, state) => {
  const h = await house(host);
  const def = { version: 2, triggers: [{ kind: 'time', at: '07:00' }], conditions: { mode: 'all', list: [{ kind: 'state', resourceId: h.id('Lüfter'), is: 'on' }] }, steps: [{ kind: 'action', resourceId: h.id('Flurlicht'), set: { on: true } }] };
  const id = (await post(host, 'Morgens', def)).json.rule.id;
  state.test = (p) => (p.run ? { started: true, at: new Date().toISOString() } : { at: new Date().toISOString(), v: 2, result: 'skip', checks: [{ ok: false, v: false }], mode: 'all', running: false, stopped: null });
  const t = await admin(host, 'POST', '/rules/test', { gateway_id: 7, id });
  assert.deepEqual([t.status, t.json.test.result], [200, 'skip']);
  assert.deepEqual(calls.filter((c) => c.method === 'test').pop().params, { id });
  assert.equal((await admin(host, 'POST', '/rules/test', { gateway_id: 7, id, run: true })).json.test.started, true);
  assert.deepEqual(calls.filter((c) => c.method === 'test').pop().params, { id, run: true });
  const draft = await admin(host, 'POST', '/rules/test', { gateway_id: 7, definition: def, run: true });
  assert.equal(draft.status, 200);
  const p = calls.filter((c) => c.method === 'test').pop().params;
  assert.deepEqual(Object.keys(p), ['rule'], 'a draft is only checked');
  assert.equal(p.rule.v, 2);
  // off: not on the gateway
  await admin(host, 'POST', `/rules/${id}/enabled`, { enabled: false });
  assert.equal((await admin(host, 'POST', '/rules/test', { gateway_id: 7, id })).json.code, 'SMARTHOME_EDGE_RULE_PENDING');
  // the gateway away
  state.test = null;
  assert.equal((await admin(host, 'POST', '/rules/test', { gateway_id: 7, definition: def })).json.code, 'SMARTHOME_EDGE_UNREACHABLE');
  // administrators only
  for (const [m, path, body] of [['POST', '/rules/test', { gateway_id: 7, id }], ['POST', '/rules/check', { gateway_id: 7, definition: def }], ['GET', '/rules/runs', undefined]]) {
    assert.equal((await admin(host, m, path, body, ADA)).status, 403);
    assert.equal((await admin(host, m, path, body, { ...ADMIN, portal: true })).status, 403);
  }
}));

test('the logic chains page knows every text it uses, also the composed ones (German and English)', () => {
  const texts = require('../server/texts.json');
  const keys = [];
  for (let d = 1; d <= 7; d++) keys.push('chain.day_' + d);
  for (const k of ['single', 'double', 'triple', 'long']) keys.push('chain.press_' + k);
  for (const k of ['ok', 'no', 'unk']) keys.push('chain.check_' + k);
  for (const k of ['limit', 'fail', 'noack']) keys.push('chain.why_' + k);
  for (const k of ['goes_on', 'goes_off', 'goes_open', 'goes_closed', 'is_on', 'is_off', 'is_open', 'is_closed', 'if_short', 'if_any_short', 'runs_gateway', 'runs_deconz',
    'connected', 'not_connected', 'new_title', 'edit_title', 'k_wait', 'k_action', 'unit_h', 'unit_min', 'unit_s', 'up', 'down', 'days_workdays', 'days_weekend', 'days_every', 'would_run', 'would_run_nocond']) keys.push('chain.' + k);
  keys.push('error.rule_loop', 'error.rule_stopped', 'error.edge_rule_pending', 'add.buttons', 'add.buttons_hint');
  for (const k of keys) assert.ok(texts.de[k] && texts.en[k], k);
});
