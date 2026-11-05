'use strict';

// The server side of the edge part (server/edge.js) against the mock host's gc.edge (opts.edge, host.edgeEvent):
// configuration on $started and after saving, heartbeats per gateway, the settings page "Gateways" and its API.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHost, hostError } = require('../../../tools/testing/mock-host');

const DIR = path.join(__dirname, '..');
const ADMIN = { id: 1, name: 'admin', role: 'admin' };

async function withHost(opts, fn) {
  const host = await createHost(DIR, opts);
  try {
    await host.start();
    await fn(host);
  } finally {
    await host.stop();
    await host.close();
  }
}

/** gateways for opts.edge and a fake edge part: answers greet like edge/index.js, other codes on demand */
function edgeOpts(over = {}) {
  const gateways = [
    { id: 1, name: 'Keller', state: 'running', version: '1.20.0' },
    { id: 2, name: 'Garten', state: 'offline', version: null },
    { id: 3, name: 'Büro', state: 'disabled', version: '1.19.0' },
  ];
  const configs = new Map();
  return {
    gateways,
    configs,
    call: async (gatewayId, method, params) => {
      if (method !== 'greet') throw hostError('edge_error', `unknown_method: no handler for ${method}`);
      if (params.name === 'slow') throw hostError('timeout', 'the gateway did not answer in time');
      if (params.name === 'crash') throw hostError('edge_error', 'not_running: the edge part is not running');
      return { text: `Hallo ${params.name} vom Gateway`, at: '2026-11-05T10:00:00.000Z', greeting: 'Hallo' };
    },
    ...over,
  };
}

test('$started hands the greeting to that gateway; saving the settings to every running one', () => withHost({ edge: edgeOpts(), settings: { greeting: 'Moin' } }, async (host) => {
  assert.equal(host.edgeConfigs.size, 0);
  assert.deepEqual(await host.edgeEvent(1, '$started', { version: '1.1.0' }), { handled: 1 });
  assert.deepEqual(host.edgeConfigs.get(1), { greeting: 'Moin' });
  // a gateway that cannot take it now: logged, nothing thrown
  await host.edgeEvent(2, '$started', null);
  assert.ok(host.logs.some((l) => l.level === 'warn' && /edge configure failed 2 gateway_offline/.test(l.message)));

  host.edgeConfigs.clear();
  await host.saveSettings({ greeting: 'Servus' });
  assert.deepEqual([...host.edgeConfigs], [[1, { greeting: 'Servus' }]], 'only the running gateway');
}));

test('heartbeats are kept per gateway and shown with the gateways', () => withHost({ edge: edgeOpts() }, async (host) => {
  let r = await host.request({ path: '/edge/gateways' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.gateways.map((g) => [g.id, g.state, g.stateText, g.online, g.heartbeat]), [
    [1, 'running', 'läuft', true, null], [2, 'offline', 'Gateway nicht verbunden', false, null], [3, 'disabled', 'ausgeschaltet', true, null],
  ]);
  assert.equal(r.json.available, true);

  await host.edgeEvent(1, 'heartbeat', { uptimeS: 61.7 }, { at: '2026-11-05T10:01:00.000Z', seq: 1 });
  await host.edgeEvent(1, 'heartbeat', { uptimeS: 121 }, { at: '2026-11-05T10:02:00.000Z', seq: 2 });
  await host.edgeEvent(3, 'heartbeat', { uptimeS: 'x' }, { at: '2026-11-05T10:02:30.000Z', seq: 3 });
  r = await host.request({ path: '/edge/gateways', lang: 'en' });
  assert.deepEqual(r.json.gateways.map((g) => [g.id, g.stateText, g.heartbeat]), [
    [1, 'running', { at: '2026-11-05T10:02:00.000Z', uptimeS: 121 }],
    [2, 'gateway not connected', null],
    [3, 'switched off', { at: '2026-11-05T10:02:30.000Z', uptimeS: null }],
  ]);
}));

test('greet: the edge part\'s answer, or the error code with a text for people', () => withHost({ edge: edgeOpts() }, async (host) => {
  const greet = (gatewayId, name, lang = 'de') => host.request({ method: 'POST', path: '/edge/greet', body: { gatewayId, name }, lang });
  let r = await greet(1, ' Ada ');
  assert.deepEqual([r.status, r.json], [200, { ok: true, result: { text: 'Hallo Ada vom Gateway', at: '2026-11-05T10:00:00.000Z', greeting: 'Hallo' } }]);
  assert.deepEqual(host.edgeCalls.at(-1), { gatewayId: 1, method: 'greet', params: { name: 'Ada' }, timeoutMs: 10000 });

  const cases = [
    [2, 'Ada', 'gateway_offline', null, 'Das Gateway ist gerade nicht verbunden.'],
    [3, 'Ada', 'not_enabled', null, 'Der Edge-Teil ist auf diesem Gateway nicht eingeschaltet oder darf dort gerade nicht laufen.'],
    [9, 'Ada', 'not_enabled', null, 'Der Edge-Teil ist auf diesem Gateway nicht eingeschaltet oder darf dort gerade nicht laufen.'],
    [1, 'slow', 'timeout', null, 'Das Gateway hat nicht rechtzeitig geantwortet.'],
    [1, 'crash', 'edge_error', 'not_running', 'Der Edge-Teil läuft auf dem Gateway gerade nicht.'],
    ['x', 'Ada', 'ERR_INVALID', null, 'Ungültige Angaben (Gateway oder Methode).'],
  ];
  for (const [gw, name, code, detail, text] of cases) {
    r = await greet(gw, name);
    assert.equal(r.status, 502, code);
    assert.deepEqual([r.json.ok, r.json.code, r.json.detail, r.json.error], [false, code, detail, text]);
  }
  r = await greet(1, 'slow', 'en');
  assert.equal(r.json.error, 'The gateway did not answer in time.');

  // the name is checked before anything goes to the gateway
  const calls = host.edgeCalls.length;
  for (const name of ['', '   ', 'x'.repeat(65), 42, null]) {
    r = await greet(1, name);
    assert.deepEqual([r.status, r.json.code], [400, 'invalid_name'], JSON.stringify(name));
  }
  assert.equal(host.edgeCalls.length, calls);
}));

test('an error code of the edge part itself and an unknown one', () => withHost({
  edge: edgeOpts({ call: async () => { throw hostError('edge_error', 'invalid_name: name must be a text of 1 to 64 characters'); } }),
}, async (host) => {
  let r = await host.request({ method: 'POST', path: '/edge/greet', body: { gatewayId: 1, name: 'Ada' } });
  assert.deepEqual([r.json.code, r.json.detail, r.json.error], ['edge_error', 'invalid_name', 'Bitte einen Namen mit 1 bis 64 Zeichen eingeben.']);
  const h2 = await createHost(DIR, { edge: edgeOpts({ call: async () => { throw hostError('strange', 'what'); } }) });
  try {
    await h2.start();
    r = await h2.request({ method: 'POST', path: '/edge/greet', body: { gatewayId: 1, name: 'Ada' }, lang: 'en' });
    assert.deepEqual([r.json.code, r.json.detail, r.json.error], ['strange', null, 'Unknown error.']);
  } finally { await h2.stop(); await h2.close(); }
}));

test('the edge routes are for administrators on the admin pages only', () => withHost({ edge: edgeOpts() }, async (host) => {
  for (const user of [{ id: 2, name: 'Ada', role: 'user' }, { ...ADMIN, portal: true }, { ...ADMIN, app: true }, null]) {
    const r = await host.request({ path: '/edge/gateways', user });
    assert.deepEqual([r.status, r.json.code], [403, 'forbidden'], JSON.stringify(user));
  }
  assert.equal((await host.request({ path: '/edge/nope' })).status, 404);
  assert.equal((await host.request({ method: 'GET', path: '/edge/greet' })).status, 404);
}));

test('without gc.edge (GateControl < 1.228.0) the page says so and nothing breaks', () => withHost({}, async (host) => {
  assert.equal(host.gc.edge, undefined);
  assert.ok(host.logs.some((l) => l.message.startsWith('no gc.edge on this GateControl')));
  assert.deepEqual((await host.request({ path: '/edge/gateways' })).json, { ok: true, available: false, gateways: [] });
  const r = await host.request({ method: 'POST', path: '/edge/greet', body: { gatewayId: 1, name: 'Ada' } });
  assert.deepEqual([r.status, r.json.code], [409, 'unavailable']);
  await host.saveSettings({ greeting: 'Moin' });
}));

test('the settings page "Gateways" is rendered in the viewer\'s language with the texts for the frame', () => withHost({ edge: edgeOpts() }, async (host) => {
  const de = await host.render({ page: 'gateways', user: { id: 1, name: '<Ada>', role: 'admin' } });
  assert.match(de.html, /<h2>Edge-Teil auf den Gateways<\/h2>/);
  assert.match(de.html, /value="&lt;Ada&gt;"/);
  assert.match(de.html, /Reiter „Edge-Plugins“/);
  const island = /window\.HELLO=(.*?);<\/script>/.exec(de.html);
  assert.ok(island, 'texts for the frame');
  const ctx = JSON.parse(island[1]);
  assert.equal(ctx.lang, 'de');
  assert.equal(ctx.texts['error.timeout'], 'Das Gateway hat nicht rechtzeitig geantwortet.');
  assert.doesNotMatch(de.html, /\{\{/, 'every placeholder filled');
  const en = await host.render({ page: 'gateways', lang: 'en' });
  assert.match(en.html, /<h2>Edge part on the gateways<\/h2>/);
  assert.match(en.html, /<button id="hx-refresh" type="button">Refresh<\/button>/);
  // the other pages stay as they were
  assert.match((await host.render({ page: 'main' })).html, /<h1 id="hello">Hallo, admin!<\/h1>/);
}));

test('plugin.json: the edge part needs no capabilities and the settings page is a page of the plugin', () => {
  const m = require('../plugin.json');
  assert.deepEqual(m.edge, { entry: 'edge/index.js', minGateway: '1.19.0', memoryMb: 32, capabilities: {} });
  assert.equal(m.ui.settingsPage, 'gateways');
  assert.ok(m.ui.pages.some((p) => p.id === 'gateways'));
  assert.equal(m.gatecontrol, '>=1.228.0');
});
