'use strict';

// Import of GateControl's built-in Klimaanlage data (legacyImport hook; the
// host side is src/services/plugins/legacy.js, dataset "midea") and the
// rendered pages.

const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeAc, fakeCloud, withHost, asAdmin, asPortal, ADA, BOB } = require('./helpers');

const APPLIANCE = '153931628798542';
const DEVICE_ID = '151732605161920';
const TOKEN = 'a1'.repeat(64);
const KEY = 'b2'.repeat(32);
const PASSWORD = 'secret-pw';

function snapshot(cloud, extra = {}) {
  return {
    schema: 1, dataset: 'midea', exportedAt: '2026-10-08T12:00:00.000Z',
    cloud: [{ app: 'msmarthome', email: cloud.email, password: PASSWORD, session: null }],
    devices: [
      { id: 3, name: 'Wohnzimmer', device_sn: 'cloud-' + APPLIANCE, device_id: null, transport: 'cloud', cloud_appliance_id: APPLIANCE, protocol_version: 3, enabled: true, token: null, key: null, target: null, created_at: '2026-06-01 10:00:00' },
      { id: 5, name: 'Büro', device_sn: 'SN-LAN', device_id: DEVICE_ID, transport: 'lan', protocol_version: 3, enabled: true, token: TOKEN, key: KEY, target: { id: 'ac', index: 0, label: '192.168.1.60' } },
      { id: 6, name: 'Keller', device_sn: 'lan-127.0.0.1', device_id: '', transport: 'lan', protocol_version: 2, enabled: false, token: 'nothex!', key: null, target: null },
      { id: 7, name: 'Doppelt', device_sn: 'SN-LAN', transport: 'lan', protocol_version: 2 },
    ],
    owners: [{ device_id: 3, user_id: 2 }, { device_id: 5, user_id: 3 }, { device_id: 99, user_id: 2 }],
    ...extra,
  };
}

test('import keeps ids and owners; account and keys become secrets; LAN targets come from the host', () => {
  const devCloud = fakeAc({ power: true, targetTemp: 21 });
  const devLan = fakeAc({ power: false, targetTemp: 25 });
  const cloud = fakeCloud({ devices: { [APPLIANCE]: devCloud }, password: PASSWORD });
  return withHost({ cloud, lan: [{ dev: devLan, version: 3, deviceId: DEVICE_ID, token: TOKEN, key: KEY }] }, async (host) => {
    const out = await host.legacyImport(snapshot(cloud));
    assert.deepEqual(out, { ok: true, counts: { cloud: 1, devices: 3, owners: 2 } });
    const devices = (await asAdmin(host, 'GET', '/devices')).json.devices;
    assert.deepEqual(devices.map((d) => [d.id, d.name, d.transport, d.target_index, d.enabled, d.has_credentials]), [
      [3, 'Wohnzimmer', 'cloud', null, true, false],
      [5, 'Büro', 'lan', 0, true, true],
      [6, 'Keller', 'lan', null, false, false],
    ], 'a duplicate serial is dropped');
    assert.deepEqual(devices.find((d) => d.id === 3).owners.map((o) => o.username), ['Ada']);
    assert.equal(await host.gc.settings.get('cloud.password'), PASSWORD);
    assert.equal(await host.gc.settings.get('dev.5.key'), KEY);
    assert.ok(!host.secrets.has('dev.6.token'), 'garbage keys are not stored');
    assert.deepEqual((await asAdmin(host, 'GET', '/cloud')).json.cloud.email, cloud.email);

    // both work right away: the cloud device with the imported account, the LAN one through target 0
    assert.equal((await asAdmin(host, 'GET', '/devices/3/state')).json.state.targetTemp, 21);
    assert.equal((await asAdmin(host, 'GET', '/devices/5/state')).json.state.targetTemp, 25);
    // the portal sees the owners' devices
    assert.deepEqual((await asPortal(host, ADA, 'GET', '/portal')).json.devices.map((d) => d.id), [3]);
    assert.deepEqual((await asPortal(host, BOB, 'GET', '/portal')).json.devices.map((d) => d.id), [5]);
    // new rows continue after the imported ids
    const added = await asAdmin(host, 'POST', '/devices', { transport: 'cloud', cloud_appliance_id: '42' });
    assert.equal(added.json.device.id, 7);
    assert.ok(host.logs.some((l) => /built-in Klimaanlage data imported/.test(l.message)));
    const logs = JSON.stringify(host.logs);
    assert.ok(!logs.includes(PASSWORD) && !logs.includes(KEY) && !logs.includes(TOKEN), 'secrets are never logged');
  });
});

test('import is idempotent and replaces the plugin data (also the account and old keys)', () => {
  const cloud = fakeCloud({ password: PASSWORD });
  return withHost({ cloud }, async (host) => {
    await host.legacyImport(snapshot(cloud));
    await asAdmin(host, 'PUT', '/devices/3/owners', { user_ids: [3] });
    await asAdmin(host, 'POST', '/devices', { transport: 'cloud', cloud_appliance_id: '42' });
    const again = await host.legacyImport(snapshot(cloud));
    assert.deepEqual(again.counts, { cloud: 1, devices: 3, owners: 2 });
    const devices = (await asAdmin(host, 'GET', '/devices')).json.devices;
    assert.deepEqual(devices.map((d) => d.id), [3, 5, 6]);
    assert.deepEqual(devices.find((d) => d.id === 3).owners.map((o) => o.id), [2]);
    // a snapshot without the LAN device and without an account removes both
    const smaller = snapshot(cloud, { cloud: [], devices: snapshot(cloud).devices.slice(0, 1), owners: [] });
    assert.deepEqual((await host.legacyImport(smaller)).counts, { cloud: 0, devices: 1, owners: 0 });
    assert.equal(await host.gc.settings.get('dev.5.key'), null);
    assert.equal(await host.gc.settings.get('cloud.password'), null);
    assert.equal((await asAdmin(host, 'GET', '/cloud')).json.cloud.configured, false);
  });
});

test('a snapshot of another dataset or schema is refused, nothing changed', () => withHost({}, async (host) => {
  await assert.rejects(host.legacyImport({ schema: 1, dataset: 'smarthome', gateways: [] }), /not a midea snapshot/);
  await assert.rejects(host.legacyImport({ schema: 2, dataset: 'midea', devices: [] }), /not a midea snapshot/);
  assert.deepEqual((await asAdmin(host, 'GET', '/devices')).json.devices, []);
}));

test('pages render with texts in the viewer\'s language and no secrets', () => {
  const cloud = fakeCloud({ password: PASSWORD });
  return withHost({ cloud }, async (host) => {
    await host.legacyImport(snapshot(cloud));
    const de = (await host.render({ view: 'page', page: 'main', lang: 'de' })).html;
    assert.match(de, /<h1 class="page-title">Klimaanlage<\/h1>/);
    assert.match(de, /window\.MD_CTX=/);
    assert.doesNotMatch(de, /\{\{t:/, 'every placeholder filled');
    const en = (await host.render({ view: 'page', page: 'main', lang: 'en' })).html;
    assert.match(en, /Air conditioning/);
    const portal = (await host.render({ view: 'portal', section: 'midea', lang: 'de', loggedIn: false })).html;
    assert.match(portal, /id="pt-md-list"/);
    assert.match(portal, /"loggedIn":false/);
    for (const html of [de, en, portal]) {
      assert.ok(!html.includes(PASSWORD) && !html.includes(KEY) && !html.includes(TOKEN));
    }
  });
});

test('every text key used by the code exists in German and English', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const texts = require('../server/texts.json');
  const dir = path.join(__dirname, '..');
  const src = ['server/index.js', 'ui/admin.html', 'ui/admin.js', 'ui/portal.html', 'ui/portal.js', 'ui/common.js']
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  const used = new Set();
  for (const m of src.matchAll(/\{\{t:([a-z0-9_.-]+)\}\}/g)) used.add(m[1]);
  for (const m of src.matchAll(/\bT\('([a-z0-9_.-]+)'\s*[,)]/g)) used.add(m[1]);
  for (const m of src.matchAll(/\bt\(lang, '([a-z0-9_.-]+)'\s*[,)]/g)) used.add(m[1]);
  for (const m of src.matchAll(/\[\d{3}, '([a-z0-9_.-]+)'\]/g)) used.add(m[1]);
  for (const k of ['mode.auto', 'mode.cool', 'mode.heat', 'mode.dry', 'mode.fan', 'portal.mode_auto', 'portal.mode_cool', 'portal.mode_heat', 'portal.mode_dry', 'portal.mode_fan']) used.add(k);
  assert.ok(used.size > 80);
  for (const k of used) {
    assert.ok(texts.de[k], `de: ${k}`);
    assert.ok(texts.en[k], `en: ${k}`);
  }
  assert.deepEqual(Object.keys(texts.de).sort(), Object.keys(texts.en).sort());
});
