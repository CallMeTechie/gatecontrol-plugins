'use strict';

// Logikketten Stufe 2 (1.12.0) — the server part: the new parts of a chain compiled for the edge part (sun, "seit",
// contacts and motion, "Von Hand (App)", "Andere Kette starten", "Mitteilung senden"), the place of a gateway for the
// sun, zigbee2mqtt devices of a gateway in its chains, the loop check with chains that start chains, the chains that
// run on the server ("Mehrere Gateways"), the notifications of both, and the quick actions of the apps with who may
// start what (administrators always, portal viewers only when released) — plus the Tasmota buttons (SetOption73) the
// server's set-up job passes on.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHost, hostError } = require('../../../tools/testing/mock-host');
const { DIR, ADA, BOB, USERS, ADMIN } = require('./helpers');
const edgeRules = require('../edge/rules');

const GW7 = { id: 7, name: 'Pi Keller', state: 'running', version: '1.20.0' };
const GW8 = { id: 8, name: 'Pi Garage', state: 'running', version: '1.20.0' };

async function withEdge(o, fn) {
  const calls = [];
  const state = { test: o.test || null };
  const call = async (gatewayId, method, params) => {
    calls.push({ gatewayId, method, params });
    if (method === 'info') return { version: '1.12.0', startedAt: '2026-11-18T04:00:00.000Z', mqtt: 'ok', lan: ['192.168.1.23'], devices: 0, found: 0 };
    if (method === 'discover') return { devices: [] };
    if (method === 'command') return { sent: 1 };
    if (method === 'runs') return { epoch: 'e1', runs: [], more: false };
    if (method === 'probe') return { ip: params.ip, family: 'tasmota', gen: null, model: 'Sonoff Basic', name: 'sonoff-flur', firmware: '14.2.0', id: 'tasmota_A1', mac: '24:A1:60:A1:B2:C3', auth: false };
    if (method === 'setup') return { ok: true, host: '192.168.1.23', port: 1883 };
    if (method === 'test' && state.test) return state.test(params, gatewayId);
    throw hostError('edge_error', `unknown_method: unknown method ${method}`);
  };
  // GateControl 1.317.0: zigbee2mqtt/# confirmed for both gateways (test/z2m_gateway_chains.test.js: not confirmed yet)
  const optional = o.optional || { 7: ['mqtt.topic:zigbee2mqtt/#'], 8: ['mqtt.topic:zigbee2mqtt/#'] };
  const host = await createHost(DIR, { users: USERS, gatecontrol: '1.317.0', edge: { gateways: [GW7, GW8], call, optional } });
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
const portal = (host, user, method, p, body) => host.request({ method, path: p, body: body === undefined ? null : body, user: { ...user, portal: true, loggedIn: true } });
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** A plug and a lamp behind gateway 7, a lamp behind gateway 8, a contact and a lamp of zigbee2mqtt on gateway 7. */
async function house(host) {
  const mk = async (gw, name, family) => (await admin(host, 'POST', '/edge/devices', { gateway_id: gw, name, family })).json.credentials;
  const now = new Date().toISOString();
  const plug = await mk(7, 'Waschmaschine', 'shelly2');
  const flur = await mk(7, 'Flurlicht', 'shelly2');
  const hof = await mk(8, 'Hoflicht', 'shelly2');
  await host.edgeEvent(7, 'states', { devices: [
    { base: plug.base, family: 'shelly2', online: true, seenAt: now, ch: { 'switch:0': { on: true, power: 3 } }, sensor: {}, info: {}, drop: [] },
    { base: flur.base, family: 'shelly2', online: true, seenAt: now, ch: { 'light:0': { on: false, bri: 40 } }, sensor: {}, info: {}, drop: [] },
  ] });
  await host.edgeEvent(8, 'states', { devices: [{ base: hof.base, family: 'shelly2', online: true, seenAt: now, ch: { 'light:0': { on: false, bri: 40 } }, sensor: {}, info: {}, drop: [] }] });
  const z2m = async (hex, kind, name, caps, st) => (await host.gc.db.run(`INSERT INTO resources (gateway_id, deconz_id, deconz_type, uniqueid, kind, name, capabilities_json, state_json)
    VALUES (0, ?, 'z2m', ?, ?, ?, ?, ?)`, [`z2m:${hex}`, hex.match(/../g).join(':'), kind, name, JSON.stringify({ source: 'z2m', gateway_id: 7, gateway: 'Pi Keller', ...caps }), JSON.stringify(st)])).lastInsertRowid;
  const tuer = Number(await z2m('00158d0000000001', 'sensor', 'Kellertür', { reading: 'open' }, { reachable: true, type: 'open', value: false }));
  const keller = Number(await z2m('00158d00000000aa', 'light', 'Kellerlicht', { bri: true }, { reachable: true, on: false }));
  const res = (await host.gc.db.query("SELECT id, name FROM resources WHERE deconz_type = 'edge'")).rows;
  return { id: (name) => res.find((r) => r.name === name).id, tuer, keller, base: { plug: plug.base, flur: flur.base, hof: hof.base } };
}

const post = (host, name, definition, extra = {}) => admin(host, 'POST', '/rules', { gateway_id: 7, source: 'edge', name, definition, ...extra });
const BASE = (triggers, steps, conditions = { mode: 'all', list: [] }) => ({ version: 2, triggers, conditions, steps, retrigger: 'restart' });

test('stage 2 parts are compiled for the gateway — sun, "seit", contact of zigbee2mqtt, Von Hand, another chain, a notification — and the edge part takes them', () => withEdge({}, async (host) => {
  const h = await house(host);
  const two = (await post(host, 'Gute Nacht', BASE([{ kind: 'manual' }], [{ kind: 'action', resourceId: h.id('Flurlicht'), set: { on: false } }]))).json.rule;
  const def = BASE(
    [{ kind: 'sun', event: 'sunset', offset: -15 }, { kind: 'power', resourceId: h.id('Waschmaschine'), op: 'lt', value: 5, for: 3 }, { kind: 'contact', resourceId: h.tuer, event: 'open' }, { kind: 'manual' }],
    [{ kind: 'action', resourceId: h.keller, set: { bri: 60 } }, { kind: 'chain', ruleId: two.id }, { kind: 'notify', text: 'Die Waschmaschine ist fertig.', users: [ADA.id] }],
    { mode: 'all', list: [{ kind: 'time', from: { sun: 'sunset', offset: 0 }, to: '23:30' }, { kind: 'state', resourceId: h.id('Flurlicht'), is: 'off', for: 2 }] },
  );
  const r = await post(host, 'Wäsche fertig', def, { quick_users: [ADA.id] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const cfg = host.edgeConfigs.get(7);
  const sent = cfg.rules.find((x) => x.id === r.json.rule.id);
  assert.deepEqual(sent.when, [
    { k: 'sun', ev: 'set', off: -15 },
    { k: 'dev', base: h.base.plug, ch: 'switch:0', field: 'power', op: 'lt', value: 5, for: 3 },
    { k: 'dev', base: 'zigbee2mqtt/0x00158d0000000001', ch: 'sensor', field: 'open', op: 'eq', value: true },
    { k: 'man' },
  ]);
  assert.deepEqual(sent.cond.list, [{ k: 'time', from: { sun: 'set', off: 0 }, to: '23:30' }, { k: 'dev', base: h.base.flur, ch: 'light:0', field: 'on', op: 'eq', value: false, for: 2 }]);
  assert.deepEqual(sent.steps, [{ k: 'act', base: 'zigbee2mqtt/0x00158d00000000aa', family: 'z2m', ch: 'light:0', op: 'bri', value: 60 }, { k: 'chain', id: two.id }, { k: 'note' }]);
  assert.deepEqual(edgeRules.cleanRule(JSON.parse(JSON.stringify(sent))), sent, 'the edge part takes it as it is');
  assert.deepEqual(cfg.z2m.map((d) => [d.ieee, d.kind, d.name]), [['0x00158d0000000001', 'sensor', 'Kellertür'], ['0x00158d00000000aa', 'light', 'Kellerlicht']]);
  assert.equal(cfg.sun, null, 'no place yet');
  const listed = (await admin(host, 'GET', '/rules?gateway_id=7&source=edge')).json;
  assert.deepEqual(listed.rules.find((x) => x.id === r.json.rule.id).quick_users, [ADA.id]);
  assert.equal(listed.location, null);

  // the place of the gateway: rounded, sent with the list; cleared again
  let loc = await admin(host, 'PUT', '/rules/location', { gateway_id: 7, lat: 52.5208, lon: 13.4049 });
  assert.deepEqual(loc.json.location, { lat: 52.52, lon: 13.4 });
  assert.deepEqual(host.edgeConfigs.get(7).sun, { lat: 52.52, lon: 13.4 });
  assert.deepEqual((await admin(host, 'GET', '/rules/location?gateway_id=7')).json.location, { lat: 52.52, lon: 13.4 });
  assert.deepEqual((await admin(host, 'GET', '/rules/location?server=1')).json.location, { lat: 52.52, lon: 13.4 }, 'the server falls back to a gateway\'s place');
  for (const bad of [{ lat: 91, lon: 0 }, { lat: 'x', lon: 1 }, { lat: 0, lon: 0 }]) assert.equal((await admin(host, 'PUT', '/rules/location', { gateway_id: 7, ...bad })).status, 400);
  loc = await admin(host, 'PUT', '/rules/location', { gateway_id: 7, location: null });
  assert.equal(loc.json.location, null);
  assert.equal(host.edgeConfigs.get(7).sun, null);

  // what does not fit
  const ok = BASE([{ kind: 'time', at: '07:00' }], [{ kind: 'action', resourceId: h.id('Flurlicht'), set: { on: true } }]);
  const cases = [
    [{ ...ok, triggers: [{ kind: 'power', resourceId: h.id('Waschmaschine'), op: 'lt', value: 5, for: 0 }] }, 'bad_for'],
    [{ ...ok, triggers: [{ kind: 'power', resourceId: h.id('Waschmaschine'), op: 'lt', value: 5, for: 1441 }] }, 'bad_for'],
    [{ ...ok, triggers: [{ kind: 'motion', resourceId: h.tuer, event: 'detected' }] }, 'bad_motion_trigger'],
    [{ ...ok, conditions: { mode: 'all', list: [{ kind: 'time', from: { sun: 'noon' }, to: '23:00' }] } }, 'bad_time_condition'],
    [{ ...ok, steps: [{ kind: 'chain', ruleId: 99999 }] }, 'foreign_chain'],
    [{ ...ok, steps: [{ kind: 'notify', text: 'x'.repeat(201) }] }, 'bad_notify_step'],
    [{ ...ok, steps: [{ kind: 'notify', text: 'Hallo', users: ['ada'] }] }, 'bad_notify_step'],
    [{ ...ok, steps: [{ kind: 'action', resourceId: h.keller, set: { pos: 20 } }] }, 'bad_action'],      // a lamp has no position
  ];
  for (const [d, detail] of cases) {
    const x = await post(host, 'X', d);
    assert.deepEqual([x.status, x.json.code, x.json.detail], [400, 'SMARTHOME_RULE_INVALID', detail], detail);
  }
  assert.equal((await post(host, 'Q', ok, { quick_users: ['ada'] })).json.detail, 'quick_users');
  // a chain does not start itself
  const self = (await post(host, 'Selbst', ok)).json.rule;
  const s2 = await admin(host, 'PUT', `/rules/${self.id}`, { name: 'Selbst', definition: { ...ok, steps: [{ kind: 'chain', ruleId: self.id }] } });
  assert.equal(s2.json.detail, 'self_chain');
  // a chain of another place is not "another chain" here
  const other = (await admin(host, 'POST', '/rules', { gateway_id: 8, source: 'edge', name: 'Garage', definition: BASE([{ kind: 'manual' }], [{ kind: 'action', resourceId: h.id('Hoflicht'), set: { on: true } }]) })).json.rule;
  assert.equal((await post(host, 'Fremd', { ...ok, steps: [{ kind: 'chain', ruleId: other.id }] })).json.detail, 'foreign_chain');
  // the chain it starts is gone: the chain stays, read-only ("Gerät fehlt"), and is not sent
  await admin(host, 'DELETE', `/rules/${two.id}`);
  const after = (await admin(host, 'GET', '/rules?gateway_id=7&source=edge')).json.rules.find((x) => x.id === r.json.rule.id);
  assert.equal(after.orphaned, true);
  assert.ok(!host.edgeConfigs.get(7).rules.some((x) => x.id === r.json.rule.id));
}));

test('loops with "Andere Kette starten": two chains that start each other without NUR WENN are refused; with one it is a warning', () => withEdge({}, async (host) => {
  const h = await house(host);
  const a = (await post(host, 'A', BASE([{ kind: 'manual' }], [{ kind: 'action', resourceId: h.id('Flurlicht'), set: { on: true } }]))).json.rule;
  const b = (await post(host, 'B', BASE([{ kind: 'manual' }], [{ kind: 'chain', ruleId: a.id }]))).json.rule;
  let r = await admin(host, 'PUT', `/rules/${a.id}`, { name: 'A', definition: BASE([{ kind: 'manual' }], [{ kind: 'chain', ruleId: b.id }]) });
  assert.deepEqual([r.status, r.json.code, r.json.chains], [409, 'SMARTHOME_RULE_LOOP', ['B']]);
  const withCond = BASE([{ kind: 'manual' }], [{ kind: 'chain', ruleId: b.id }], { mode: 'all', list: [{ kind: 'state', resourceId: h.id('Flurlicht'), is: 'off' }] });
  const c = await admin(host, 'POST', '/rules/check', { gateway_id: 7, id: a.id, definition: withCond });
  assert.deepEqual([c.json.loop, c.json.chains], ['possible', ['B']]);
  r = await admin(host, 'PUT', `/rules/${a.id}`, { name: 'A', definition: withCond });
  assert.equal(r.status, 200);
}));

test('a chain on the server ("Mehrere Gateways"): a plug on one gateway switches a lamp on another and notifies; runs at place 0', () => withEdge({}, async (host, calls) => {
  const h = await house(host);
  const def = BASE([{ kind: 'power', resourceId: h.id('Waschmaschine'), op: 'gt', value: 1000 }],
    [{ kind: 'action', resourceId: h.id('Hoflicht'), set: { on: true } }, { kind: 'notify', text: 'Waschmaschine läuft.' }]);
  const r = await admin(host, 'POST', '/rules', { source: 'server', name: 'Garage und Keller', definition: def });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.rule.source, r.json.rule.gateway_id], ['server', 0]);
  assert.ok(!host.edgeConfigs.get(7).rules.some((x) => x.id === r.json.rule.id), 'not on a gateway');
  const list = (await admin(host, 'GET', '/rules?source=server')).json.rules;
  assert.deepEqual(list.map((x) => [x.name, x.source, x.orphaned]), [['Garage und Keller', 'server', false]]);

  const now = new Date().toISOString();
  await host.edgeEvent(7, 'states', { devices: [{ base: h.base.plug, family: 'shelly2', online: true, seenAt: now, ch: { 'switch:0': { on: true, power: 1800 } }, sensor: {}, info: {}, drop: [] }] });
  const cmd = await until(() => calls.find((c) => c.method === 'command' && c.gatewayId === 8));
  assert.deepEqual([cmd.params.base, cmd.params.op], [h.base.hof, 'on']);
  const n = await until(() => host.notifications.find((x) => x.topic === 'chains'));
  assert.deepEqual([n.title, n.body, n.users == null], ['Garage und Keller', 'Waschmaschine läuft.', true]);
  const runs = await until(async () => { const x = (await admin(host, 'GET', '/rules/runs?server=1')).json.runs; return x.length && x[0].result !== 'running' ? x : null; });
  assert.deepEqual([runs[0].gateway_id, runs[0].rule_id, runs[0].result], [0, r.json.rule.id, 'ok']);
  assert.ok((await admin(host, 'GET', '/rules/runs')).json.runs.some((x) => x.gateway_id === 0), 'all places together too');

  // Testlauf on the server; "Trotzdem ausführen"
  const t = await admin(host, 'POST', '/rules/test', { source: 'server', id: r.json.rule.id });
  assert.deepEqual([t.status, t.json.test.v, t.json.test.result], [200, 2, 'run']);
  const draft = await admin(host, 'POST', '/rules/test', { source: 'server', definition: def });
  assert.equal(draft.json.test.result, 'run');

  // what a chain on the server cannot have
  assert.equal((await admin(host, 'POST', '/rules', { source: 'server', name: 'Alt', definition: { triggers: def.triggers, actions: [] } })).json.detail, 'bad_version');
  const taster = (await host.gc.db.get('SELECT id FROM edge_devices LIMIT 1')).row.id;
  assert.equal((await admin(host, 'POST', '/rules', { source: 'server', name: 'T', definition: BASE([{ kind: 'button', deviceId: taster, input: 0, event: 'single' }], def.steps) })).json.detail, 'button_on_server');
  // the editor's devices: every place, with its name
  const devs = (await admin(host, 'GET', '/rules/devices?server=1')).json.resources;
  assert.deepEqual(['Hoflicht', 'Kellertür'].map((x) => devs.find((d) => d.name === x).place), ['Pi Garage', 'Pi Keller']);
  const gw7 = (await admin(host, 'GET', '/rules/devices?gateway_id=7')).json;
  assert.deepEqual(gw7.resources.map((x) => x.name).sort(), ['Flurlicht', 'Kellerlicht', 'Kellertür', 'Waschmaschine']);
  assert.deepEqual(gw7.devices.map((d) => d.name).sort(), ['Flurlicht', 'Waschmaschine']);
  // off: the engine forgets it
  await admin(host, 'POST', `/rules/${r.json.rule.id}/enabled`, { enabled: false });
  assert.equal((await admin(host, 'POST', '/rules/test', { source: 'server', id: r.json.rule.id })).json.code, 'SMARTHOME_EDGE_RULE_PENDING');
  // administrators only
  for (const [m, p, b] of [['POST', '/rules', { source: 'server', name: 'X', definition: def }], ['GET', '/rules/devices?server=1'], ['PUT', '/rules/location', { server: true, lat: 1, lon: 1 }]]) {
    assert.equal((await admin(host, m, p, b, ADA)).status, 403);
    assert.equal((await admin(host, m, p, b, { ...ADMIN, portal: true })).status, 403);
  }
}));

test('notifications of a chain on a gateway: event `notify` → topic chains, only to the chosen people, an event that comes twice once', () => withEdge({}, async (host) => {
  const h = await house(host);
  const r = (await post(host, 'Wäsche fertig', BASE([{ kind: 'power', resourceId: h.id('Waschmaschine'), op: 'lt', value: 5, for: 3 }],
    [{ kind: 'action', resourceId: h.id('Flurlicht'), set: { on: false } }, { kind: 'notify', text: 'Die Waschmaschine ist fertig.', users: [ADA.id, 999] }]))).json.rule;
  const note = { r: r.id, i: 1, at: new Date().toISOString(), u: 'abc123:7' };
  await host.edgeEvent(7, 'notify', { notes: [note] });
  await host.edgeEvent(7, 'notify', { notes: [note] });
  const sent = host.notifications.filter((x) => x.topic === 'chains');
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0].title, sent[0].body, sent[0].users], ['Wäsche fertig', 'Die Waschmaschine ist fertig.', [ADA.id]]);
  // not a notification step, another gateway's chain, an unknown chain: nothing
  await host.edgeEvent(7, 'notify', { notes: [{ ...note, i: 0, u: 'abc123:8' }, { ...note, r: 99999, u: 'abc123:9' }] });
  await host.edgeEvent(8, 'notify', { notes: [{ ...note, u: 'abc123:10' }] });
  assert.equal(host.notifications.filter((x) => x.topic === 'chains').length, 1);
}));

test('quick actions: a chain with "Von Hand (App)" for administrators; for a portal viewer only when released; started with NUR WENN', () => withEdge({}, async (host, calls, state) => {
  const h = await house(host);
  state.test = (p) => (p.run && p.by === 'app' ? { started: p.id !== skipId, result: p.id === skipId ? 'skip' : 'started', at: new Date().toISOString() } : { at: new Date().toISOString() });
  const gute = (await post(host, 'Gute Nacht', BASE([{ kind: 'manual' }], [{ kind: 'action', resourceId: h.id('Flurlicht'), set: { on: false } }]), { quick_users: [ADA.id] })).json.rule;
  const kino = (await post(host, 'Kino', BASE([{ kind: 'manual' }], [{ kind: 'action', resourceId: h.id('Flurlicht'), set: { bri: 10 } }]))).json.rule;
  await post(host, 'Morgens', BASE([{ kind: 'time', at: '07:00' }], [{ kind: 'action', resourceId: h.id('Flurlicht'), set: { on: true } }]), { quick_users: [ADA.id] });
  const skipId = kino.id;
  const srv = (await admin(host, 'POST', '/rules', { source: 'server', name: 'Urlaub', definition: BASE([{ kind: 'manual' }], [{ kind: 'action', resourceId: h.id('Hoflicht'), set: { on: true } }]), quick_users: [BOB.id] })).json.rule;

  const ids = (list) => list.filter((a) => a.id.startsWith('chain:')).map((a) => [a.id, a.title, a.subtitle, a.kind]);
  assert.deepEqual(ids(await host.quickActions(ADMIN)), [
    [`chain:${gute.id}`, 'Gute Nacht', 'Kette · Pi Keller', 'button'], [`chain:${kino.id}`, 'Kino', 'Kette · Pi Keller', 'button'], [`chain:${srv.id}`, 'Urlaub', 'Kette · über Server', 'button'],
  ], 'administrators: every chain with "Von Hand (App)", sorted by name');
  assert.deepEqual(ids(await host.quickActions(ADA)), [[`chain:${gute.id}`, 'Gute Nacht', 'Kette · Pi Keller', 'button']], 'Ada: only what was released for her');
  assert.deepEqual(ids(await host.quickActions(BOB)).map((x) => x[0]), [`chain:${srv.id}`]);
  assert.deepEqual(ids(await host.quickActions(ADMIN, 'en'))[2].slice(2), ['Chain · through the server', 'button']);
  assert.deepEqual(await host.plugin.quickActions({ user: { ...ADA, portal: true, loggedIn: false }, lang: 'de' }, host.gc), [], 'not signed in: nothing');

  let run = await host.runQuickAction(ADA, `chain:${gute.id}`);
  assert.deepEqual([run.status, run.body.ok, run.body.message], [200, true, '„Gute Nacht“ gestartet']);
  assert.deepEqual(calls.filter((c) => c.method === 'test').pop(), { gatewayId: 7, method: 'test', params: { id: gute.id, run: true, by: 'app' } });
  assert.equal((await host.runQuickAction(ADA, `chain:${kino.id}`)).status, 404, 'not listed for Ada');
  const direct = await host.plugin.runQuickAction({ user: { ...ADA, portal: true, loggedIn: true, app: true }, lang: 'de', id: `chain:${kino.id}` }, host.gc);
  assert.deepEqual([direct.ok, direct.message], [false, 'Diese Aktion gibt es nicht mehr.'], 'checked again in the plugin');
  run = await host.runQuickAction(ADMIN, `chain:${kino.id}`);
  assert.deepEqual([run.body.ok, run.body.message], [false, '„Kino“ nicht gestartet – „Nur wenn“ gilt gerade nicht']);
  // a chain on the server runs in the plugin
  run = await host.runQuickAction(BOB, `chain:${srv.id}`);
  assert.deepEqual([run.body.ok, run.body.message], [true, '„Urlaub“ gestartet']);
  await until(() => calls.find((c) => c.method === 'command' && c.gatewayId === 8));

  // the portal API for the apps' own screen
  let pc = await portal(host, ADA, 'GET', '/portal/chains');
  assert.deepEqual(pc.json.chains, [{ id: gute.id, name: 'Gute Nacht', place: 'edge', place_name: 'Pi Keller', offline: true }]);
  pc = await portal(host, ADA, 'POST', `/portal/chains/${gute.id}/run`);
  assert.deepEqual([pc.status, pc.json.ok, pc.json.result], [200, true, 'started']);
  assert.equal((await portal(host, ADA, 'POST', `/portal/chains/${kino.id}/run`)).status, 404);
  assert.equal((await portal(host, BOB, 'GET', '/portal/chains')).json.chains[0].place, 'server');
  // the editor's people: administrators need no release
  assert.deepEqual((await admin(host, 'GET', '/rules/people')).json.users, [{ id: 1, username: 'admin', admin: true }, { id: 2, username: 'Ada', admin: false }, { id: 3, username: 'Bob', admin: false }]);
  assert.equal((await admin(host, 'GET', '/rules/people', undefined, ADA)).status, 403);
  // released no more, switched off: gone
  await admin(host, 'PUT', `/rules/${gute.id}`, { name: 'Gute Nacht', definition: BASE([{ kind: 'manual' }], [{ kind: 'action', resourceId: h.id('Flurlicht'), set: { on: false } }]), quick_users: [] });
  assert.deepEqual(ids(await host.quickActions(ADA)), []);
  await admin(host, 'POST', `/rules/${kino.id}/enabled`, { enabled: false });
  assert.ok(!ids(await host.quickActions(ADMIN)).some((x) => x[0] === `chain:${kino.id}`));
}));

test('Einrichtungshilfe on the server: "Tasten als Taster melden" goes to the gateway as buttons: true — only on request', () => withEdge({}, async (host, calls) => {
  const setupCalls = () => calls.filter((c) => c.method === 'setup');
  const run = async (body) => {
    const r = await admin(host, 'POST', '/edge/setup', { gateway_id: 7, ...body });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    await until(async () => ['waiting', 'done', 'failed'].includes((await admin(host, 'GET', `/edge/setup/${r.json.job.id}`)).json.job.state));
    return setupCalls().pop().params;
  };
  let p = await run({ name: 'Licht Flur', candidate: { ip: '192.168.1.62', family: 'tasmota' }, buttons: true });
  assert.equal(p.buttons, true);
  assert.equal(p.family, 'tasmota');
  p = await run({ name: 'Licht Keller', candidate: { ip: '192.168.1.63', family: 'tasmota' } });
  assert.equal('buttons' in p, false, 'not asked for');
  p = await run({ name: 'Licht Bad', candidate: { ip: '192.168.1.64', family: 'tasmota' }, buttons: 'yes' });
  assert.equal('buttons' in p, false, 'only true counts');
}));
