'use strict';

// Test helpers: the mock host (tools/testing/mock-host.js) with a fake
// Phoscon/deCONZ gateway behind the home target "gateway".

const path = require('node:path');
const { createHost } = require('../../../tools/testing/mock-host');

const DIR = path.join(__dirname, '..');

const ADMIN = { id: 1, name: 'admin', role: 'admin' };
const ADA = { id: 2, name: 'Ada', role: 'user' };
const BOB = { id: 3, name: 'Bob', role: 'user' };
const USERS = [ADMIN, ADA, BOB];

/**
 * A fake deCONZ REST API (enough of it for the plugin): lights, groups with
 * scenes, sensors, rules, schedules, CLIP sensors; link button; api key.
 */
function fakeDeconz(opts = {}) {
  const gw = {
    key: opts.key || 'KEY1234567',
    linkPressed: opts.linkPressed !== false,
    newKey: opts.newKey || 'NEWKEY99',
    config: { name: 'Phoscon-GW', swversion: '2.27.4', apiversion: '1.16.0' },
    lights: opts.lights || {
      1: { name: 'Configuration tool 1', type: 'Configuration tool', state: { reachable: true } },
      2: { name: 'Poolpumpe', type: 'On/Off plug-in unit', uniqueid: 'p1', state: { on: false } },
      3: { name: 'Stehlampe', type: 'Color temperature light', uniqueid: 'l1', state: { on: true, bri: 254, ct: 300, reachable: true } },
      4: { name: 'Bunt', type: 'Extended color light', uniqueid: 'l2', state: { on: false, bri: 127, hue: 100, sat: 100, xy: [0.3, 0.3] } },
    },
    groups: opts.groups || {
      8: { name: 'Wohnzimmer', state: { any_on: true }, scenes: [{ id: '2', name: 'Abend' }] },
    },
    sensors: opts.sensors || {
      1: { name: 'Daylight', type: 'Daylight', state: { daylight: true } },
      10: { name: 'Temp', type: 'ZHATemperature', uniqueid: 't1', state: { temperature: 2150 } },
      14: { name: 'Fensterkontakt', type: 'ZHAOpenClose', uniqueid: 's1', state: { open: true } },
      12: { name: 'Bewegung Flur', type: 'ZHAPresence', uniqueid: 'm1', state: { presence: false } },
      16: { name: 'Smart Switch', type: 'ZHASwitch', uniqueid: 'sw1', modelid: 'RWL021', state: { buttonevent: 1002 } },
    },
    rules: {},
    schedules: {},
    clip: {},
    seq: 20,
    calls: [],
    failRulesWith: null,
    down: false,
  };
  const json = (body, status = 200) => ({ status, body: JSON.stringify(body) });
  const unauthorized = (p) => json([{ error: { type: 1, address: p, description: 'unauthorized user' } }], 403);

  gw.fetch = async (p, o = {}) => {
    const method = (o.method || 'GET').toUpperCase();
    gw.calls.push({ method, path: p, body: o.json, index: o.index });
    if (gw.down) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ERR_NET' });
    if (p === '/api' && method === 'POST') {
      return gw.linkPressed ? json([{ success: { username: gw.newKey } }]) : json([{ error: { type: 101, address: '/', description: 'link button not pressed' } }]);
    }
    if (p === '/api/config') return json(gw.config);
    const m = /^\/api\/([^/]+)(\/.*)$/.exec(p);
    if (!m) return json([{ error: { type: 4, description: 'not found' } }], 404);
    if (m[1] !== gw.key && m[1] !== gw.newKey) return unauthorized(p);
    const rest = m[2];
    const seg = rest.split('/').filter(Boolean);
    const coll = seg[0];
    if (method === 'GET' && seg.length === 1) {
      if (coll === 'config') return json(gw.config);
      const src = { lights: gw.lights, groups: gw.groups, sensors: { ...gw.sensors, ...gw.clip }, rules: gw.rules, schedules: gw.schedules }[coll];
      return src ? json(src) : json([], 404);
    }
    if (method === 'PUT' && (coll === 'lights' || coll === 'groups')) {
      const target = coll === 'lights' ? gw.lights[seg[1]] : gw.groups[seg[1]];
      if (!target) return json([{ error: { type: 3, address: rest, description: 'resource not available' } }], 404);
      if (coll === 'lights' && seg[2] === 'state') Object.assign(target.state, o.json || {});
      if (coll === 'groups' && seg[2] === 'action' && o.json && 'on' in o.json) target.state.any_on = o.json.on;
      return json([{ success: { [rest]: o.json } }]);
    }
    if (method === 'POST' && ['rules', 'schedules', 'sensors'].includes(coll) && seg.length === 1) {
      if (coll === 'rules' && gw.failRulesWith) return gw.failRulesWith;
      const id = String(++gw.seq);
      ({ rules: gw.rules, schedules: gw.schedules, sensors: gw.clip })[coll][id] = o.json;
      return json([{ success: { id } }]);
    }
    if (method === 'PUT' && ['rules', 'sensors'].includes(coll)) {
      const store = coll === 'rules' ? gw.rules : gw.clip;
      if (!store[seg[1]]) return json([{ error: { type: 3, description: 'not available' } }], 404);
      return json([{ success: {} }]);
    }
    if (method === 'DELETE' && ['rules', 'schedules', 'sensors'].includes(coll)) {
      const store = ({ rules: gw.rules, schedules: gw.schedules, sensors: gw.clip })[coll];
      if (!store[seg[1]]) return json([{ error: { type: 3, description: 'not available' } }], 404);
      delete store[seg[1]];
      return json([{ success: `/${coll}/${seg[1]} deleted` }]);
    }
    return json([{ error: { type: 4, description: 'method not available' } }], 405);
  };
  return gw;
}

/** Mock host with `gateways` (fake deCONZ instances) as the assigned targets 0…n. */
async function withHost(o, fn) {
  const gateways = o.gateways || [];
  const host = await createHost(DIR, {
    users: o.users || USERS,
    settings: o.settings,
    license: o.license,
    targets: { gateway: gateways.map((g, i) => ({ label: `phoscon-${i}.example.com`, fetch: g.fetch })) },
  });
  try {
    await host.start();
    await fn(host);
  } finally {
    await host.stop();
    await host.close();
  }
}

/** Requests as an administrator / a portal viewer. */
const asAdmin = (host, method, p, body) => host.request({ method, path: p, body: body === undefined ? null : body, user: ADMIN });
const asPortal = (host, user, method, p, body) => host.request({ method, path: p, body: body === undefined ? null : body, user: { ...user, portal: true } });

/** Connect the fake gateway (index 0 by default) with its key and sync it. */
async function connected(host, { index = 0, key = 'KEY1234567', name = 'Wohnung' } = {}) {
  const r = await asAdmin(host, 'POST', '/gateways', { name, target_index: index, apiKey: key });
  if (r.status !== 200) throw new Error('connect failed: ' + JSON.stringify(r.json));
  const id = r.json.gateway.id;
  await asAdmin(host, 'POST', `/gateways/${id}/sync`);
  const res = (await host.request({ path: '/resources', query: { gateway_id: String(id) }, user: ADMIN })).json.resources;
  const by = (name) => res.find((x) => x.name === name);
  return { id, resources: res, by };
}

module.exports = { DIR, ADMIN, ADA, BOB, USERS, fakeDeconz, withHost, asAdmin, asPortal, connected };
