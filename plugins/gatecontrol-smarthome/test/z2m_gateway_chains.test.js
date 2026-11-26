'use strict';

// zigbee2mqtt in the chains on a gateway (1.15.0) — the optional capability mqtt.topic:zigbee2mqtt/# (plugin.json
// edge.optionalCapabilities, GateControl 1.317.0: gc.edge.capabilities / requestCapability). Saving a chain with such
// devices asks for it when it is not confirmed; the chain is stored, but not sent to the gateway until an administrator
// confirmed it (the others run as before); the page learns why (rule.z2m, rule.z2m_link). An older gateway refuses the
// topic (event `z2m` denied → 'unavailable'). An older GateControl (no API): zigbee2mqtt devices are no resources of a
// gateway, as before (foreign_resource). The manifest keeps edge.capabilities as they were (no update_pending).

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHost, hostError } = require('../../../tools/testing/mock-host');
const { DIR, USERS, ADMIN } = require('./helpers');

const KEY = 'mqtt.topic:zigbee2mqtt/#';
const GW7 = { id: 7, name: 'Pi Keller', state: 'running', version: '1.20.0' };

async function withHost(o, fn) {
  const call = async (gatewayId, method) => {
    if (method === 'info') return { version: '1.15.0', startedAt: '2026-11-22T04:00:00.000Z', mqtt: 'ok', lan: ['192.168.1.23'], devices: 0, found: 0 };
    if (method === 'runs') return { epoch: 'e1', runs: [], more: false };
    if (method === 'discover') return { devices: [] };
    throw hostError('edge_error', `unknown_method: unknown method ${method}`);
  };
  const optional = o.optional || {};
  const host = await createHost(DIR, { users: USERS, gatecontrol: o.gatecontrol || '1.317.0', edge: { gateways: [GW7], call, ...(o.gatecontrol === '1.228.1' ? {} : { optional }) } });
  try {
    await host.start();
    await fn(host, optional);
  } finally {
    await host.stop();
    await host.close();
  }
}

const admin = (host, method, p, body) => {
  const [pathOnly, qs] = String(p).split('?');
  return host.request({ method, path: pathOnly, query: Object.fromEntries(new URLSearchParams(qs || '')), body: body === undefined ? null : body, user: ADMIN });
};
const post = (host, name, definition) => admin(host, 'POST', '/rules', { gateway_id: 7, source: 'edge', name, definition });
const BASE = (triggers, steps) => ({ version: 2, triggers, conditions: { mode: 'all', list: [] }, steps, retrigger: 'restart' });

/** A Shelly lamp behind gateway 7 and a contact and a lamp of zigbee2mqtt on gateway 7. */
async function house(host) {
  const flur = (await admin(host, 'POST', '/edge/devices', { gateway_id: 7, name: 'Flurlicht', family: 'shelly2' })).json.credentials;
  await host.edgeEvent(7, 'states', { devices: [
    { base: flur.base, family: 'shelly2', online: true, seenAt: new Date().toISOString(), ch: { 'light:0': { on: false, bri: 40 } }, sensor: {}, info: {}, drop: [] },
  ] });
  const z2m = async (hex, kind, name, caps, st) => Number((await host.gc.db.run(`INSERT INTO resources (gateway_id, deconz_id, deconz_type, uniqueid, kind, name, capabilities_json, state_json)
    VALUES (0, ?, 'z2m', ?, ?, ?, ?, ?)`, [`z2m:${hex}`, hex.match(/../g).join(':'), kind, name, JSON.stringify({ source: 'z2m', gateway_id: 7, gateway: 'Pi Keller', ...caps }), JSON.stringify(st)])).lastInsertRowid);
  const tuer = await z2m('00158d0000000001', 'sensor', 'Kellertür', { reading: 'open' }, { reachable: true, type: 'open', value: false });
  const keller = await z2m('00158d00000000aa', 'light', 'Kellerlicht', { bri: true }, { reachable: true, on: false });
  const lamp = (await host.gc.db.query("SELECT id FROM resources WHERE deconz_type = 'edge' AND name = 'Flurlicht'")).rows[0].id;
  return { tuer, keller, lamp };
}

test('not confirmed yet: the chain is stored, the capability asked for (once a day), the chain waits — the others run; confirmed: it goes to the gateway', () => withHost({}, async (host, optional) => {
  const h = await house(host);
  const shelly = (await post(host, 'Flur', BASE([{ kind: 'time', at: '07:00' }], [{ kind: 'action', resourceId: h.lamp, set: { on: true } }]))).json.rule;
  assert.equal(shelly.z2m, null, 'a chain without zigbee2mqtt needs nothing');
  assert.deepEqual(host.edgeRequests, []);

  const def = BASE([{ kind: 'contact', resourceId: h.tuer, event: 'open' }], [{ kind: 'action', resourceId: h.keller, set: { on: true } }, { kind: 'action', resourceId: h.lamp, set: { on: true } }]);
  const r = await post(host, 'Kellertür', def);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.rule.z2m, 'approval');
  assert.equal(r.json.rule.z2m_link, '/gateways#gw/7/edge');
  assert.deepEqual(host.edgeRequests, [{ gatewayId: 7, key: KEY, notified: true }]);
  let cfg = host.edgeConfigs.get(7);
  assert.deepEqual(cfg.rules.map((x) => x.id), [shelly.id], 'only the chain without zigbee2mqtt runs');
  assert.deepEqual(cfg.z2m, []);

  // saved again: asked again, GateControl notes it once a day only
  const u = await admin(host, 'PUT', `/rules/${r.json.rule.id}`, { name: 'Kellertür', definition: def });
  assert.equal(u.json.rule.z2m, 'approval');
  assert.deepEqual(host.edgeRequests.map((x) => x.notified), [true, false]);

  let list = (await admin(host, 'GET', '/rules?gateway_id=7&source=edge')).json.rules;
  assert.deepEqual(list.map((x) => [x.name, x.z2m, x.z2m_link || null]), [['Flur', null, null], ['Kellertür', 'approval', '/gateways#gw/7/edge']]);

  // an administrator confirms it: the next background round sends the chain with its zigbee2mqtt devices
  optional[7] = [KEY];
  await host.tick();
  cfg = host.edgeConfigs.get(7);
  assert.deepEqual(cfg.rules.map((x) => x.id), [shelly.id, r.json.rule.id]);
  assert.deepEqual(cfg.z2m.map((d) => [d.ieee, d.kind, d.name]), [['0x00158d0000000001', 'sensor', 'Kellertür'], ['0x00158d00000000aa', 'light', 'Kellerlicht']]);
  list = (await admin(host, 'GET', '/rules?gateway_id=7&source=edge')).json.rules;
  assert.deepEqual(list.map((x) => x.z2m), [null, null]);

  // an older gateway refuses the topic: the page says so, the chain stays on the gateway
  await host.edgeEvent(7, 'z2m', { state: 'denied' });
  list = (await admin(host, 'GET', '/rules?gateway_id=7&source=edge')).json.rules;
  assert.deepEqual(list.map((x) => x.z2m), [null, 'unavailable']);
  assert.ok(host.logs.some((l) => l.level === 'warn' && /zigbee2mqtt is not available on gateway 7/.test(l.message)));
  await host.edgeEvent(7, 'z2m', { state: 'ok' });
  assert.equal((await admin(host, 'GET', '/rules?gateway_id=7&source=edge')).json.rules[1].z2m, null);

  // taken back: the chain waits again
  optional[7] = [];
  await host.tick();
  assert.deepEqual(host.edgeConfigs.get(7).rules.map((x) => x.id), [shelly.id]);
  assert.equal((await admin(host, 'GET', '/rules?gateway_id=7&source=edge')).json.rules[1].z2m, 'approval');
}));

test('confirmed beforehand: nothing is asked, the chain runs at once; the editor offers the zigbee2mqtt devices of the gateway', () => withHost({ optional: { 7: [KEY] } }, async (host) => {
  const h = await house(host);
  const r = await post(host, 'Kellertür', BASE([{ kind: 'contact', resourceId: h.tuer, event: 'open' }], [{ kind: 'action', resourceId: h.keller, set: { on: true } }]));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.rule.z2m, null);
  assert.deepEqual(host.edgeRequests, []);
  assert.deepEqual(host.edgeConfigs.get(7).rules.map((x) => x.id), [r.json.rule.id]);
  const ed = (await admin(host, 'GET', '/rules/devices?gateway_id=7')).json;
  assert.deepEqual(ed.resources.filter((x) => x.source === 'z2m').map((x) => x.name).sort(), ['Kellerlicht', 'Kellertür']);
}));

test('an older GateControl (no optional capabilities): zigbee2mqtt devices are no resources of a gateway (foreign_resource), as before', () => withHost({ gatecontrol: '1.228.1' }, async (host) => {
  const h = await house(host);
  const r = await post(host, 'Kellertür', BASE([{ kind: 'contact', resourceId: h.tuer, event: 'open' }], [{ kind: 'action', resourceId: h.lamp, set: { on: true } }]));
  assert.deepEqual([r.status, r.json.detail], [400, 'foreign_resource']);
  const ed = (await admin(host, 'GET', '/rules/devices?gateway_id=7')).json;
  assert.deepEqual(ed.resources.filter((x) => x.source === 'z2m'), []);
}));

test('a version 1 chain never takes a zigbee2mqtt device of the gateway', () => withHost({ optional: { 7: [KEY] } }, async (host) => {
  const h = await house(host);
  const r = await post(host, 'Alt', { triggers: [{ kind: 'state', resourceId: h.lamp, event: 'on' }], actions: [{ kind: 'light', resourceId: h.keller, set: { on: true } }] });
  assert.deepEqual([r.status, r.json.detail], [400, 'foreign_resource']);
}));

test('the manifest: zigbee2mqtt/# is optional, edge.capabilities stay those of 1.14.0 (no update_pending), GateControl ≥ 1.317.1 (1.16.0: the heating card)', () => {
  const manifest = require('../plugin.json');
  assert.deepEqual(manifest.edge.capabilities, { mdns: { services: ['_shelly._tcp', '_http._tcp'] }, http: { lan: true }, mqtt: { topics: ['shellies/#', 'tasmota/#'] } });
  assert.deepEqual(manifest.edge.optionalCapabilities, { mqtt: { topics: ['zigbee2mqtt/#', 'gatecontrol/contacts/#'] } });
  assert.equal(manifest.gatecontrol, '>=1.317.1');
});
