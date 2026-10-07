'use strict';

// Import of GateControl's built-in Smart Home data (legacyImport hook; the
// host side is src/services/plugins/legacy.js) and the rendered pages.

const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeDeconz, withHost, asAdmin, asPortal, ADMIN, ADA } = require('./helpers');

function snapshot(extra = {}) {
  return {
    schema: 1, dataset: 'smarthome', exportedAt: '2026-10-07T12:00:00.000Z',
    gateways: [
      { id: 4, name: 'Wohnung', enabled: true, api_key: 'KEY1234567', last_seen_at: '2026-10-07 11:00:00', created_at: '2026-07-01 10:00:00', updated_at: null, target: { id: 'gateway', index: 0, label: 'phoscon-0.example.com' } },
      { id: 6, name: 'Garten', enabled: false, api_key: null, target: null },
    ],
    resources: [
      { id: 10, gateway_id: 4, deconz_id: '3', deconz_type: 'lights', uniqueid: 'l1', kind: 'light', name: 'Stehlampe', capabilities: { on: true, bri: true, color: 'ct' }, state: { on: true, bri: 40 }, enabled: true },
      { id: 11, gateway_id: 4, deconz_id: '8', deconz_type: 'groups', kind: 'group', name: 'Wohnzimmer', capabilities: { on: true, bri: true, color: 'hs' }, state: { on: true }, enabled: true },
      { id: 12, gateway_id: 4, deconz_id: '8/2', deconz_type: 'scenes', kind: 'scene', name: 'Wohnzimmer · Abend', capabilities: { group_id: '8', scene_id: '2' }, state: {}, enabled: true },
      { id: 13, gateway_id: 99, deconz_id: '1', deconz_type: 'lights', kind: 'light', name: 'foreign gateway', capabilities: {}, state: {}, enabled: true },
    ],
    owners: [{ resource_id: 10, user_id: 2 }, { resource_id: 11, user_id: 2 }, { resource_id: 13, user_id: 2 }],
    rules: [{ id: 5, gateway_id: 4, name: 'Flur', enabled: true, definition: { triggers: [], actions: [{ kind: 'light', resourceId: 10, set: { on: true } }] }, deconz_rule_id: '17', deconz_schedule_id: null, deconz_clip_sensor_id: null }],
    ...extra,
  };
}

test('import keeps ids, owners, rule links; the API key becomes a secret; targets come from the host', () => {
  const gw = fakeDeconz();
  return withHost({ gateways: [gw] }, async (host) => {
    const out = await host.legacyImport(snapshot());
    assert.deepEqual(out, { ok: true, counts: { gateways: 2, resources: 3, owners: 2, rules: 1 } });
    const gws = (await asAdmin(host, 'GET', '/gateways')).json.gateways;
    assert.deepEqual(gws.map((g) => [g.id, g.name, g.target_index, g.enabled, g.has_key]), [[4, 'Wohnung', 0, 1, true], [6, 'Garten', null, 0, false]]);
    assert.equal(await host.gc.settings.get('gw.4.apikey'), 'KEY1234567');
    assert.ok(host.secrets.has('gw.4.apikey'));
    const res = (await asAdmin(host, 'GET', '/resources')).json.resources;
    assert.deepEqual(res.map((r) => r.id).sort(), [10, 11, 12], 'rows of unknown gateways dropped');
    assert.deepEqual(res.find((r) => r.id === 10).owners, [{ id: 2, username: 'Ada' }]);
    assert.deepEqual(res.find((r) => r.id === 12).owners, [{ id: 2, username: 'Ada' }], 'scene inherits from its group');
    const rules = (await host.request({ path: '/rules', query: { gateway_id: '4' }, user: ADMIN })).json.rules;
    assert.deepEqual(rules.map((r) => [r.id, r.name, r.deconz_rule_id, r.orphaned]), [[5, 'Flur', '17', false]]);
    // the imported gateway works through the host-assigned target with the imported key
    const r = await asAdmin(host, 'POST', '/resources/10/state', { on: false });
    assert.equal(r.status, 200);
    assert.deepEqual(gw.calls.at(-1), { method: 'PUT', path: '/api/KEY1234567/lights/3/state', body: { on: false }, index: 0 });
    // the portal sees the owner's devices right away
    assert.deepEqual((await asPortal(host, ADA, 'GET', '/portal')).json.devices.map((d) => d.id).sort(), [10, 11, 12]);
    // new rows continue after the imported ids
    const created = await asAdmin(host, 'POST', '/gateways', { name: 'Neu', target_index: 0, apiKey: 'KEY1234567' });
    assert.equal(created.json.gateway.id, 7);
    assert.ok(host.logs.some((l) => /built-in Smart Home data imported/.test(l.message)));
    assert.ok(!host.logs.some((l) => l.message.includes('KEY1234567')), 'the key is never logged');
  });
});

test('import is idempotent: running it again replaces the plugin data', () => withHost({ gateways: [fakeDeconz()] }, async (host) => {
  await host.legacyImport(snapshot());
  await asAdmin(host, 'PUT', '/resources/10/owners', { userIds: [3] });
  const again = await host.legacyImport(snapshot({ gateways: [snapshot().gateways[0]] }));
  assert.deepEqual(again.counts, { gateways: 1, resources: 3, owners: 2, rules: 1 });
  assert.deepEqual((await host.gc.db.query('SELECT resource_id, user_id FROM resource_owners ORDER BY resource_id')).rows, [{ resource_id: 10, user_id: 2 }, { resource_id: 11, user_id: 2 }]);
  assert.equal((await host.gc.db.get('SELECT COUNT(*) AS n FROM gateways')).row.n, 1);
  assert.equal(await host.gc.settings.get('gw.6.apikey'), null);
}));

test('a snapshot that is not a smarthome snapshot is refused, nothing changes', () => withHost({ gateways: [fakeDeconz()] }, async (host) => {
  await host.legacyImport(snapshot());
  for (const bad of [null, { schema: 2, dataset: 'smarthome' }, { schema: 1, dataset: 'midea' }]) {
    await assert.rejects(host.legacyImport(bad), { code: 'SMARTHOME_IMPORT_INVALID' });
  }
  assert.equal((await host.gc.db.get('SELECT COUNT(*) AS n FROM resources')).row.n, 3);
}));

test('render: main page, rules page and portal tab in both languages, texts escaped, context as safe JSON', () => withHost({}, async (host) => {
  const main = (await host.render({ view: 'page', page: 'main', lang: 'de' })).html;
  assert.match(main, /<h1 class="page-title">Smart Home<\/h1>/);
  assert.match(main, /id="sh-connect-modal"/);
  assert.match(main, /window\.SH_CTX=\{"lang":"de","view":"page","page":"main","loggedIn":true/);
  assert.doesNotMatch(main.split('window.SH_CTX=')[1].split(';</script>')[0], /</, 'no "<" inside the JSON island');
  const rules = (await host.render({ view: 'page', page: 'rules', lang: 'en' })).html;
  assert.match(rules, /<h1 class="page-title">Logic Chains<\/h1>/);
  assert.match(rules, /id="shr-modal"/);
  const portal = (await host.render({ view: 'portal', page: null, lang: 'de', loggedIn: false, user: { ...ADA, portal: true } })).html;
  assert.match(portal, /id="pt-sh-tiles"/);
  assert.match(portal, /"view":"portal","page":null,"loggedIn":false/);
  assert.doesNotMatch(main + rules + portal, /\{\{t:/, 'every text placeholder is filled');
  assert.doesNotMatch(main + rules + portal, /https?:\/\//, 'no external resources');
}));
