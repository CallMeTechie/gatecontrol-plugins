'use strict';

// Import of GateControl's built-in Fahrzeuge data (legacyImport hook; the
// host side is src/services/plugins/legacy.js, dataset "skoda") and the
// rendered page / portal section.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, asAdmin, asPortal, PNG, ADA, VIN } = require('./helpers');

const STATE = { capturedAt: '2026-10-01T08:00:00Z', locked: true, soc: 64, rangeKm: 251, position: { lat: 51, lon: 7 }, climate: { timers: [] }, health: { mileageKm: 100, warnings: [] } };

function snapshot(extra = {}) {
  return {
    schema: 1, dataset: 'skoda', exportedAt: '2026-10-08T12:00:00.000Z',
    accounts: [
      { id: 3, email: 'ada@example.com', password: 'pw-secret-1', spin: '4711', session: { accessToken: 'AT1', refreshToken: 'RT1' }, status: 'ok', status_detail: null, backoff_min: 0, next_retry_at: null, created_at: '2026-07-01 10:00:00', updated_at: null },
      { id: 5, email: 'bob@example.com', password: 'other-pw', spin: null, session: null, status: 'rate_limited', status_detail: 'HTTP 429', backoff_min: 60, next_retry_at: '2026-10-08T13:00:00Z' },
      { id: 6, email: 'not an email', password: 'x' },
    ],
    vehicles: [
      { id: 7, account_id: 3, vin: VIN, name: 'Elroq', model: 'Elroq 85', state: STATE, image: PNG.toString('base64'), image_url: 'https://iprenders.blob.core.windows.net/renders/car.png', fetched_at: '2026-10-01 08:01:00' },
      { id: 8, account_id: 5, vin: 'TMBTESTVIN000002', name: 'Enyaq', model: null, state: null, image: Buffer.from('GIF89a-not-an-allowed-type').toString('base64'), image_url: 'https://x' },
      { id: 9, account_id: 99, vin: 'TMBTESTVIN000003', name: 'foreign account' },
      { id: 10, account_id: 3, vin: 'bad vin!', name: 'invalid' },
    ],
    owners: [{ vehicle_id: 7, user_id: 2 }, { vehicle_id: 8, user_id: 3 }, { vehicle_id: 9, user_id: 2 }, { vehicle_id: 7, user_id: 2 }],
    ...extra,
  };
}

test('import keeps ids and owners; password, S-PIN and session become secrets; the account works right away', () => withHost({}, async (host, cloud) => {
  cloud.issue(); // the cloud knows AT1/RT1 of the imported session
  const out = await host.legacyImport(snapshot());
  assert.deepEqual(out, { ok: true, counts: { accounts: 2, vehicles: 2, owners: 2 } });
  const st = (await asAdmin(host, 'GET', '/')).json;
  assert.deepEqual(st.accounts.map((a) => [a.id, a.email, a.status, a.has_credentials, a.has_spin]),
    [[3, 'ada@example.com', 'ok', true, true], [5, 'bob@example.com', 'rate_limited', true, false]]);
  assert.deepEqual(st.vehicles.map((v) => [v.id, v.account_id, v.vin, v.name, v.has_image]), [[7, 3, VIN, 'Elroq', true], [8, 5, 'TMBTESTVIN000002', 'Enyaq', false]]);
  assert.deepEqual(st.vehicles[0].state, STATE);
  assert.deepEqual(st.vehicles[0].owners, [{ id: 2, username: 'Ada' }]);
  assert.equal((await asAdmin(host, 'GET', '/vehicles/7/image')).json.image, 'data:image/png;base64,' + PNG.toString('base64'));
  for (const [k, v] of [['acc.3.password', 'pw-secret-1'], ['acc.3.spin', '4711'], ['acc.3.access', 'AT1'], ['acc.3.refresh', 'RT1'], ['acc.5.password', 'other-pw']]) {
    assert.equal(await host.gc.settings.get(k), v, k);
    assert.ok(host.secrets.has(k), k + ' is a secret');
  }
  assert.equal(await host.gc.settings.get('acc.5.access'), null);
  assert.ok(!host.logs.some((l) => /pw-secret|other-pw|4711|AT1|RT1/.test(l.message)), 'secrets are never logged');
  assert.ok(host.logs.some((l) => /built-in Fahrzeuge data imported/.test(l.message)));
  // the imported session works without a new login; the portal sees the owner's vehicle at once
  assert.equal((await asAdmin(host, 'POST', '/accounts/3/sync')).json.result.ok, true);
  assert.equal(cloud.logins, 0);
  assert.deepEqual((await asPortal(host, ADA, 'GET', '/portal')).json.vehicles.map((v) => v.id), [7]);
  assert.equal((await asAdmin(host, 'POST', '/vehicles/7/command', { action: 'lock', args: {} })).status, 200, 'imported S-PIN works');
  // new rows continue after the imported ids
  const created = await asAdmin(host, 'POST', '/accounts', { email: 'eve@example.com', password: 'x' });
  assert.equal(created.json.account.id, 6);
}));

test('import is idempotent: running it again replaces the plugin data and drops secrets of gone accounts', () => withHost({}, async (host) => {
  await host.legacyImport(snapshot());
  await asAdmin(host, 'PUT', '/vehicles/7/owners', { user_ids: [3] });
  const again = await host.legacyImport(snapshot({ accounts: [snapshot().accounts[0]] }));
  assert.deepEqual(again.counts, { accounts: 1, vehicles: 1, owners: 1 });
  assert.deepEqual((await host.gc.db.query('SELECT vehicle_id, user_id FROM vehicle_owners')).rows, [{ vehicle_id: 7, user_id: 2 }]);
  assert.equal(await host.gc.settings.get('acc.5.password'), null);
  assert.equal(await host.gc.settings.get('acc.3.password'), 'pw-secret-1');
}));

test('a snapshot that is not a skoda snapshot is refused, nothing changes', () => withHost({}, async (host) => {
  await host.legacyImport(snapshot());
  for (const bad of [null, { schema: 2, dataset: 'skoda' }, { schema: 1, dataset: 'smarthome' }]) {
    await assert.rejects(host.legacyImport(bad), { code: 'SKODA_IMPORT_INVALID' });
  }
  assert.equal((await host.gc.db.get('SELECT COUNT(*) AS n FROM vehicles')).row.n, 2);
}));

test('a session token the host cannot store is dropped (new login on the next sync), the import goes on', () => withHost({}, async (host) => {
  const s = snapshot();
  s.accounts[0].session = { accessToken: 'x'.repeat(4001), refreshToken: 'RT1' };
  const out = await host.legacyImport(s);
  assert.equal(out.counts.accounts, 2);
  assert.equal(await host.gc.settings.get('acc.3.access'), null);
  assert.equal(await host.gc.settings.get('acc.3.password'), 'pw-secret-1');
}));

test('render: page and portal section in both languages, texts escaped, context as safe JSON, no external resources', () => withHost({}, async (host) => {
  const main = (await host.render({ view: 'page', page: 'main', lang: 'de' })).html;
  assert.match(main, /<h1 class="page-title">Fahrzeuge<\/h1>/);
  assert.match(main, /id="sk-account-modal"/);
  assert.match(main, /id="sk-spin-modal"/);
  assert.match(main, /window\.SK_CTX=\{"lang":"de","view":"page","page":"main","loggedIn":true/);
  assert.doesNotMatch(main.split('window.SK_CTX=')[1].split(';</script>')[0], /</, 'no "<" inside the JSON island');
  const en = (await host.render({ view: 'page', page: 'main', lang: 'en' })).html;
  assert.match(en, /<h1 class="page-title">Vehicles<\/h1>/);
  const portal = (await host.render({ view: 'portal', page: null, section: 'skoda', lang: 'de', loggedIn: false, user: { ...ADA, portal: true } })).html;
  assert.match(portal, /id="pt-sk-list"/);
  assert.match(portal, /"view":"portal","page":null,"loggedIn":false/);
  assert.doesNotMatch(main + en + portal, /\{\{t:/, 'every text placeholder is filled');
  assert.doesNotMatch(main + en + portal, /(src|href)=["']https?:/, 'no external resources');
}));

test('texts: German and English have the same keys', () => {
  const texts = require('../server/texts.json');
  assert.deepEqual(Object.keys(texts.en).sort(), Object.keys(texts.de).sort());
  for (const [k, v] of Object.entries(texts.en)) assert.ok(typeof v === 'string' && v.length, k);
});
