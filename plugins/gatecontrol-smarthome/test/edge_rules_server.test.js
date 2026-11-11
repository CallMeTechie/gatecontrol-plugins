'use strict';

// Logic chains for Shelly and Tasmota devices — the server part (server/rules.js with source 'edge',
// server/edgerules.js): the builder's definition is checked against the devices of the GateControl gateway, kept,
// compiled and handed to the gateway's edge part with the device list (gc.edge.configure { devices, rules, tz });
// the deCONZ rules stay what they were.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHost, hostError } = require('../../../tools/testing/mock-host');
const { DIR, ADMIN, ADA, USERS, fakeDeconz, connected, asAdmin } = require('./helpers');
const edgeRules = require('../edge/rules');

const GW = { id: 7, name: 'Pi Keller', state: 'running', version: '1.20.0' };
const GW2 = { id: 8, name: 'NAS Büro', state: 'running', version: '1.20.0' };

async function withEdge(o, fn) {
  const calls = [];
  const state = { gateways: o.gateways || [GW, GW2] };
  const call = async (gatewayId, method, params) => {
    calls.push({ gatewayId, method, params });
    if (method === 'info') return { version: '1.10.0', startedAt: '2026-11-11T04:00:00.000Z', mqtt: 'ok', lan: ['192.168.1.23'], devices: 0, found: 0 };
    if (method === 'discover') return { devices: [] };
    if (method === 'command') return { sent: 1 };
    throw hostError('edge_error', `unknown_method: unknown method ${method}`);
  };
  const host = await createHost(DIR, { users: USERS, gatecontrol: '1.228.1', edge: { get gateways() { return state.gateways; }, call }, targets: { gateway: (o.deconz || []).map((g, i) => ({ label: `phoscon-${i}`, fetch: g.fetch })) } });
  try {
    await host.start();
    await fn(host, calls, state);
  } finally {
    await host.stop();
    await host.close();
  }
}

const admin = (host, method, p, body) => {
  const [pathOnly, qs] = String(p).split('?');
  return host.request({ method, path: pathOnly, query: Object.fromEntries(new URLSearchParams(qs || '')), body: body === undefined ? null : body, user: ADMIN });
};

/** A plug with metering, a dimmer (Gen1), a shutter, an H&T and a Tasmota plug behind gateway 7; a plug behind gateway 8. */
async function house(host) {
  const mk = async (gateway, name, family) => (await admin(host, 'POST', '/edge/devices', { gateway_id: gateway, name, family })).json.credentials;
  const now = new Date().toISOString();
  const plug = await mk(7, 'Waschmaschine', 'shelly2');
  const dimmer = await mk(7, 'Deckenlicht', 'shelly1');
  const rollo = await mk(7, 'Rollladen', 'shelly2');
  const ht = await mk(7, 'Klima Keller', 'shelly1');
  const fan = await mk(7, 'Lüfter', 'tasmota');
  const other = await mk(8, 'Büro', 'shelly2');
  await host.edgeEvent(7, 'states', { devices: [
    { base: plug.base, family: 'shelly2', online: true, seenAt: now, ch: { 'switch:0': { on: true, power: 1800, energy: 100 } }, sensor: {}, info: {}, drop: [] },
    { base: dimmer.base, family: 'shelly1', online: true, seenAt: now, ch: { 'light:0': { on: false, bri: 70 } }, sensor: {}, info: {}, drop: [] },
    { base: rollo.base, family: 'shelly2', online: true, seenAt: now, ch: { 'cover:0': { pos: 60, moving: null } }, sensor: {}, info: {}, drop: [] },
    { base: ht.base, family: 'shelly1', online: null, seenAt: now, ch: {}, sensor: { temperature: 14.8, humidity: 63, battery: 82 }, info: {}, drop: [] },
    { base: fan.base, family: 'tasmota', online: true, seenAt: now, ch: { 'switch:0': { on: false } }, sensor: {}, info: {}, drop: [] },
  ] });
  await host.edgeEvent(8, 'states', { devices: [{ base: other.base, family: 'shelly2', online: true, seenAt: now, ch: { 'switch:0': { on: false } }, sensor: {}, info: {}, drop: [] }] });
  const rows = (await host.gc.db.query("SELECT id, name FROM resources WHERE deconz_type = 'edge'")).rows;
  const id = (name) => rows.find((r) => r.name === name).id;
  return { id, bases: { plug: plug.base, dimmer: dimmer.base, rollo: rollo.base, ht: ht.base, fan: fan.base, other: other.base } };
}

test('an edge rule: checked, kept, compiled and handed to the gateway\'s edge part — which accepts every compiled rule', () => withEdge({}, async (host) => {
  const h = await house(host);
  const def = {
    triggers: [{ kind: 'state', resourceId: h.id('Waschmaschine'), event: 'on' }, { kind: 'power', resourceId: h.id('Waschmaschine'), op: 'lt', value: 5 }],
    actions: [{ kind: 'light', resourceId: h.id('Deckenlicht'), set: { bri: 40 } }, { kind: 'cover', resourceId: h.id('Rollladen'), set: { cover: 'close' } }, { kind: 'relay', resourceId: h.id('Lüfter'), set: { on: true } }],
    timeWindow: { from: '08:00', to: '22:00' },
    delay: { minutes: 3, onRetrigger: 'cancel' },
  };
  const r = await admin(host, 'POST', '/rules', { gateway_id: 7, source: 'edge', name: 'Wäsche fertig', definition: def });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual({ source: r.json.rule.source, synced: r.json.rule.synced, enabled: r.json.rule.enabled, deconz: r.json.rule.deconz_rule_id }, { source: 'edge', synced: true, enabled: true, deconz: null });
  const id = r.json.rule.id;
  const cfg = host.edgeConfigs.get(7);
  assert.equal(cfg.devices.length, 5);
  assert.equal(cfg.tz, Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.deepEqual(cfg.rules, [{
    id,
    triggers: [{ base: h.bases.plug, ch: 'switch:0', field: 'on', op: 'eq', value: true }, { base: h.bases.plug, ch: 'switch:0', field: 'power', op: 'lt', value: 5 }],
    actions: [
      { base: h.bases.dimmer, family: 'shelly1', ch: 'light:0', op: 'bri', value: 40 },
      { base: h.bases.rollo, family: 'shelly2', ch: 'cover:0', op: 'close' },
      { base: h.bases.fan, family: 'tasmota', ch: 'switch:0', op: 'on' },
    ],
    window: { from: '08:00', to: '22:00' },
    delay: { minutes: 3, mode: 'cancel' },
  }]);
  // every kind of trigger and action the builder offers compiles into something the edge part runs
  const more = {
    triggers: [{ kind: 'cover', resourceId: h.id('Rollladen'), event: 'closed' }, { kind: 'temperature', resourceId: h.id('Klima Keller'), op: 'lt', value: 3 }, { kind: 'humidity', resourceId: h.id('Klima Keller'), op: 'gt', value: 70 }, { kind: 'state', resourceId: h.id('Deckenlicht'), event: 'off' }],
    actions: [{ kind: 'cover', resourceId: h.id('Rollladen'), set: { pos: 30 } }, { kind: 'light', resourceId: h.id('Deckenlicht'), set: { on: false } }],
  };
  assert.equal((await admin(host, 'POST', '/rules', { gateway_id: 7, source: 'edge', name: 'Alles', definition: more })).status, 200);
  const compiled = host.edgeConfigs.get(7).rules;
  assert.equal(compiled.length, 2);
  for (const c of compiled) assert.deepEqual(edgeRules.cleanRule(JSON.parse(JSON.stringify(c))), c, 'the edge part takes the rule as it is');
  assert.deepEqual(compiled[1].triggers.slice(0, 1), [{ base: h.bases.rollo, ch: 'cover:0', field: 'pos', op: 'lt', value: 1 }]);
  assert.deepEqual([compiled[1].window, compiled[1].delay], [null, null]);

  // the list of the page: the rules of this gateway, with the definition as the builder sent it
  const list = (await admin(host, 'GET', '/rules?gateway_id=7&source=edge')).json;
  assert.deepEqual(list.rules.map((x) => [x.name, x.orphaned, x.source]), [['Wäsche fertig', false, 'edge'], ['Alles', false, 'edge']]);
  assert.deepEqual(list.rules[0].definition, def);
  assert.deepEqual([list.cancelSupported, list.limit_warn], [true, false]);
  assert.deepEqual((await admin(host, 'GET', '/rules?gateway_id=8&source=edge')).json.rules, [], 'another gateway has its own rules');
  assert.deepEqual(host.edgeConfigs.get(8).rules, []);
}));

test('edit, switch off, delete: the edge part gets the new list each time; `fired` records when a chain ran', () => withEdge({}, async (host) => {
  const h = await house(host);
  const def = { triggers: [{ kind: 'state', resourceId: h.id('Lüfter'), event: 'on' }], actions: [{ kind: 'relay', resourceId: h.id('Waschmaschine'), set: { on: false } }] };
  const id = (await admin(host, 'POST', '/rules', { gateway_id: 7, source: 'edge', name: 'Test', definition: def })).json.rule.id;
  const up = await admin(host, 'PUT', `/rules/${id}`, { name: 'Test 2', definition: { ...def, delay: { minutes: 10, onRetrigger: 'reset' } } });
  assert.equal(up.status, 200);
  assert.deepEqual([up.json.rule.name, host.edgeConfigs.get(7).rules[0].delay], ['Test 2', { minutes: 10, mode: 'reset' }]);
  // off: kept here, not sent
  assert.equal((await admin(host, 'POST', `/rules/${id}/enabled`, { enabled: false })).json.rule.enabled, false);
  assert.deepEqual(host.edgeConfigs.get(7).rules, []);
  assert.equal((await admin(host, 'POST', `/rules/${id}/enabled`, { enabled: true })).json.rule.enabled, true);
  assert.equal(host.edgeConfigs.get(7).rules.length, 1);
  // the edge part reports a run (twice in one bundle: the later time counts; another gateway's event changes nothing)
  assert.equal((await admin(host, 'GET', '/rules?gateway_id=7&source=edge')).json.rules[0].last_fired_at, null);
  const at = new Date(Date.now() - 60000).toISOString();
  await host.edgeEvent(8, 'fired', { rules: [{ id, at }] });
  assert.equal((await admin(host, 'GET', '/rules?gateway_id=7&source=edge')).json.rules[0].last_fired_at, null);
  await host.edgeEvent(7, 'fired', { rules: [{ id, at: new Date(Date.now() - 120000).toISOString() }, { id, at }, { id: 'x' }, null, { id: 99999, at }] });
  assert.equal((await admin(host, 'GET', '/rules?gateway_id=7&source=edge')).json.rules[0].last_fired_at, at);
  await host.edgeEvent(7, 'fired', { rules: [{ id, at: new Date(Date.now() + 3600000).toISOString() }] });
  assert.ok(Date.parse((await admin(host, 'GET', '/rules?gateway_id=7&source=edge')).json.rules[0].last_fired_at) <= Date.now(), 'a clock ahead on the gateway is no time in the future here');
  // $online: the list goes out again (the gateway was away while rules changed)
  host.edgeConfigs.clear();
  await host.edgeEvent(7, '$online', null);
  assert.equal(host.edgeConfigs.get(7).rules.length, 1);
  assert.equal((await admin(host, 'DELETE', `/rules/${id}`)).status, 200);
  assert.deepEqual(host.edgeConfigs.get(7).rules, []);
  assert.deepEqual((await admin(host, 'GET', '/rules?gateway_id=7&source=edge')).json.rules, []);
}));

test('what does not fit is refused with a reason and changes nothing', () => withEdge({}, async (host) => {
  const h = await house(host);
  const ok = { triggers: [{ kind: 'state', resourceId: h.id('Lüfter'), event: 'on' }], actions: [{ kind: 'relay', resourceId: h.id('Waschmaschine'), set: { on: false } }] };
  const post = (definition, extra = {}) => admin(host, 'POST', '/rules', { gateway_id: 7, source: 'edge', name: 'X', definition, ...extra });
  const cases = [
    [{ ...ok, triggers: [{ kind: 'state', resourceId: h.id('Büro'), event: 'on' }] }, 'foreign_resource'],            // a device of another gateway
    [{ ...ok, actions: [{ kind: 'relay', resourceId: 99999, set: { on: true } }] }, 'foreign_resource'],
    [{ ...ok, triggers: [] }, 'no_trigger'],
    [{ ...ok, actions: [] }, 'no_action'],
    [{ ...ok, triggers: [{ kind: 'state', resourceId: h.id('Klima Keller'), event: 'on' }] }, 'bad_state_trigger'],    // a sensor is not switched
    [{ ...ok, triggers: [{ kind: 'power', resourceId: h.id('Lüfter'), op: 'lt', value: 5 }] }, 'bad_power_trigger'],   // no metering
    [{ ...ok, triggers: [{ kind: 'temperature', resourceId: h.id('Klima Keller'), op: 'eq', value: 5 }] }, 'bad_threshold_op'],
    [{ ...ok, triggers: [{ kind: 'temperature', resourceId: h.id('Klima Keller'), op: 'lt', value: 'kalt' }] }, 'bad_threshold_value'],
    [{ ...ok, triggers: [{ kind: 'motion', resourceId: h.id('Lüfter'), event: 'detected' }] }, 'bad_threshold_op'],    // a deCONZ trigger
    [{ ...ok, actions: [{ kind: 'relay', resourceId: h.id('Waschmaschine'), set: { bri: 50 } }] }, 'no_bri_capability'],
    [{ ...ok, actions: [{ kind: 'sensor', resourceId: h.id('Klima Keller'), set: { on: true } }] }, 'not_controllable'],
    [{ ...ok, actions: [{ kind: 'cover', resourceId: h.id('Rollladen'), set: { pos: 140 } }] }, 'bad_cover_action'],
    [{ ...ok, timeWindow: { from: '8', to: '22:00' } }, 'bad_time_window'],
    [{ ...ok, delay: { minutes: 2000 } }, 'bad_delay_minutes'],
  ];
  for (const [def, detail] of cases) {
    const r = await post(def);
    assert.deepEqual([r.status, r.json.code, r.json.detail], [400, 'SMARTHOME_RULE_INVALID', detail], detail);
  }
  assert.equal((await post(ok, { name: 'ein viel zu langer Name für eine Regel' })).json.detail, 'name_too_long');
  assert.equal((await post(ok, { source: 'cloud' })).json.detail, 'bad_source');
  assert.equal((await host.gc.db.query('SELECT COUNT(*) AS n FROM rules')).rows[0].n, 0);
  assert.deepEqual(host.edgeConfigs.get(7).rules, []);
  // at most 40 rules per gateway
  for (let i = 0; i < 40; i++) assert.equal((await post(ok, { name: `R${i}` })).status, 200);
  const full = await post(ok, { name: 'R40' });
  assert.deepEqual([full.status, full.json.code], [409, 'SMARTHOME_EDGE_RULE_LIMIT']);
  assert.equal(host.edgeConfigs.get(7).rules.length, 40);
  assert.ok(Buffer.byteLength(JSON.stringify(host.edgeConfigs.get(7))) < 48 * 1024, 'fits GateControl\'s limit for gc.edge.configure');
}));

test('a device that is gone: the rule stays (read-only on the page) and is no longer sent', () => withEdge({}, async (host) => {
  const h = await house(host);
  const def = { triggers: [{ kind: 'state', resourceId: h.id('Lüfter'), event: 'on' }], actions: [{ kind: 'relay', resourceId: h.id('Waschmaschine'), set: { on: false } }] };
  const id = (await admin(host, 'POST', '/rules', { gateway_id: 7, source: 'edge', name: 'Test', definition: def })).json.rule.id;
  const fan = (await admin(host, 'GET', '/edge/devices?gateway_id=7')).json.devices.find((d) => d.name === 'Lüfter');
  assert.equal((await admin(host, 'DELETE', `/edge/devices/${fan.id}`)).status, 200);
  assert.deepEqual(host.edgeConfigs.get(7).rules, [], 'removing the device sends the list without the rule');
  const list = (await admin(host, 'GET', '/rules?gateway_id=7&source=edge')).json.rules;
  assert.deepEqual(list.map((r) => [r.id, r.orphaned]), [[id, true]]);
  assert.equal((await admin(host, 'PUT', `/rules/${id}`, { name: 'Test', definition: def })).json.detail, 'foreign_resource');
  assert.equal((await admin(host, 'DELETE', `/rules/${id}`)).status, 200);
}));

test('deCONZ rules and edge rules do not touch each other; only administrators; without gc.edge the page says so', async () => {
  const deconz = fakeDeconz();
  // GateControl's gateway 1 and the plugin's deCONZ gateway 1 are different things with the same number
  await withEdge({ deconz: [deconz], gateways: [GW, GW2, { id: 1, name: 'Pi Dach', state: 'running', version: '1.20.0' }] }, async (host) => {
    const h = await house(host);
    const c = await connected(host);
    assert.equal(c.id, 1);
    const dz = await asAdmin(host, 'POST', '/rules', { gateway_id: c.id, name: 'Flur', definition: { triggers: [{ kind: 'motion', resourceId: c.by('Bewegung Flur').id, event: 'detected' }], actions: [{ kind: 'light', resourceId: c.by('Stehlampe').id, set: { on: true } }] } });
    assert.equal(dz.status, 200, JSON.stringify(dz.json));
    assert.equal(dz.json.rule.source, 'deconz');
    const def = { triggers: [{ kind: 'state', resourceId: h.id('Lüfter'), event: 'on' }], actions: [{ kind: 'relay', resourceId: h.id('Waschmaschine'), set: { on: false } }] };
    const er = await admin(host, 'POST', '/rules', { gateway_id: 7, source: 'edge', name: 'Edge', definition: def });
    assert.equal(er.status, 200);
    // … and one on GateControl's gateway 1
    const dach = (await admin(host, 'POST', '/edge/devices', { gateway_id: 1, name: 'Dachfenster', family: 'tasmota' })).json.credentials;
    await host.edgeEvent(1, 'states', { devices: [{ base: dach.base, family: 'tasmota', online: true, seenAt: new Date().toISOString(), ch: { 'switch:0': { on: false } }, sensor: {}, info: {}, drop: [] }] });
    const dachId = (await host.gc.db.get("SELECT id FROM resources WHERE name = 'Dachfenster'")).row.id;
    assert.equal((await admin(host, 'POST', '/rules', { gateway_id: 1, source: 'edge', name: 'Dach', definition: { triggers: [{ kind: 'state', resourceId: dachId, event: 'on' }], actions: [{ kind: 'relay', resourceId: dachId, set: { on: false } }] } })).status, 200);
    assert.deepEqual((await admin(host, 'GET', `/rules?gateway_id=${c.id}`)).json.rules.map((r) => r.name), ['Flur']);
    assert.deepEqual((await admin(host, 'GET', '/rules?gateway_id=1&source=edge')).json.rules.map((r) => r.name), ['Dach']);
    assert.deepEqual((await admin(host, 'GET', '/rules?gateway_id=7&source=edge')).json.rules.map((r) => r.name), ['Edge']);
    assert.deepEqual((await admin(host, 'GET', '/rules?gateway_id=7')).json.rules, [], 'gateway 7 is no deCONZ gateway');
    // a deCONZ trigger in an edge rule, an edge resource in a deCONZ rule
    assert.equal((await admin(host, 'POST', '/rules', { gateway_id: 7, source: 'edge', name: 'Mix', definition: { ...def, triggers: [{ kind: 'motion', resourceId: c.by('Bewegung Flur').id, event: 'detected' }] } })).json.detail, 'foreign_resource');
    assert.equal((await asAdmin(host, 'POST', '/rules', { gateway_id: c.id, name: 'Mix', definition: { triggers: [{ kind: 'motion', resourceId: c.by('Bewegung Flur').id, event: 'detected' }], actions: [{ kind: 'relay', resourceId: h.id('Waschmaschine'), set: { on: true } }] } })).json.detail, 'foreign_resource');
    // the deCONZ resync leaves the edge rule alone (it has no deCONZ objects by design)
    const before = deconz.calls.length;
    host.plugin._state.resynced = false;
    await host.tick();
    assert.ok(!deconz.calls.slice(before).some((x) => x.method === 'POST' && /\/rules$/.test(x.path)), 'no deCONZ rule is created for an edge rule');
    // removing the deCONZ gateway takes its rules along, not the edge rules
    assert.equal((await asAdmin(host, 'DELETE', `/gateways/${c.id}`)).status, 200);
    assert.deepEqual((await host.gc.db.query('SELECT name, source, gateway_id FROM rules ORDER BY id')).rows.map((r) => [r.name, r.source, r.gateway_id]), [['Edge', 'edge', 7], ['Dach', 'edge', 1]]);
    // a portal viewer never reaches the rules
    const viewer = await host.request({ method: 'GET', path: '/rules', query: { gateway_id: '7', source: 'edge' }, user: { ...ADA, portal: true } });
    assert.equal(viewer.status, 403);
  });
  // an older GateControl (no gc.edge): edge rules cannot be made, deCONZ rules as before
  const host = await createHost(DIR, { users: USERS, gatecontrol: '1.227.0', targets: { gateway: [{ label: 'phoscon-0', fetch: fakeDeconz().fetch }] } });
  try {
    await host.start();
    const r = await admin(host, 'POST', '/rules', { gateway_id: 7, source: 'edge', name: 'X', definition: { triggers: [{ kind: 'state', resourceId: 1, event: 'on' }], actions: [{ kind: 'relay', resourceId: 1, set: { on: true } }] } });
    assert.deepEqual([r.status, r.json.code], [409, 'SMARTHOME_EDGE_UNAVAILABLE']);
    assert.deepEqual((await admin(host, 'GET', '/rules?gateway_id=7&source=edge')).json.rules, []);
  } finally { await host.stop(); await host.close(); }
});

test('the rules page knows every text it uses (German and English)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const texts = require('../server/texts.json');
  const js = fs.readFileSync(path.join(DIR, 'ui/rules.js'), 'utf8');
  const html = fs.readFileSync(path.join(DIR, 'ui/rules.html'), 'utf8');
  const used = new Set([...js.matchAll(/\bT\('([a-z0-9_.-]+)'/g)].map((m) => m[1]).concat([...html.matchAll(/\{\{t:([a-z0-9_.-]+)\}\}/g)].map((m) => m[1])));
  for (const k of used) {
    if (/[._]$/.test(k)) continue; // a prefix: 'rules.what_' + kind
    assert.ok(k in texts.de && k in texts.en, k);
  }
  for (const k of ['state', 'cover', 'power', 'temperature', 'humidity']) assert.ok(texts.de['rules.what_' + k] && texts.en['rules.what_' + k], k);
  for (const k of ['open', 'close', 'stop', 'pos_open', 'position']) assert.ok(texts.de['cover.' + k] && texts.en['cover.' + k], k);
});
