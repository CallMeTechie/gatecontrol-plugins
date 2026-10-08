'use strict';

// Portal section "Fahrzeuge" (ported from GateControl's tests/skoda_portal*.test.js
// and the vehicle part of the portal): only the viewer's own vehicles,
// redacted; position, address and departure times only after a real login;
// commands only for a signed-in owner. Start tiles, search, visibility.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, asAdmin, asPortal, connected, ADA, BOB, PNG } = require('./helpers');

async function owned(host, cloud) {
  const ids = await connected(host, cloud);
  await asAdmin(host, 'PUT', `/vehicles/${ids.vehicleId}/owners`, { user_ids: [ADA.id] });
  return ids;
}

test('portal: own vehicles only, redacted (no VIN, account), signed in → position with address and timers', () => withHost({}, async (host, cloud) => {
  const { vehicleId } = await owned(host, cloud);
  const r = await asPortal(host, ADA, 'GET', '/portal');
  assert.equal(r.status, 200);
  assert.equal(r.json.loggedIn, true);
  const v = r.json.vehicles[0];
  assert.deepEqual(Object.keys(v).sort(), ['fetched_at', 'has_image', 'id', 'model', 'name', 'state']);
  assert.equal(v.id, vehicleId);
  assert.ok(!JSON.stringify(r.json).includes('TMBTESTVIN'), 'no VIN in the portal');
  assert.deepEqual(v.state.position, { lat: 51, lon: 7, address: 'Hauptstraße 5, 50667 Köln' });
  assert.equal(v.state.climate.timers.length, 2);
  assert.equal(v.state.soc, 74);
  assert.deepEqual(Object.keys(v.state).sort(), ['capturedAt', 'charging', 'climate', 'detail', 'doorsOpen', 'health', 'lightsOn', 'locked', 'maintenance', 'position', 'rangeKm', 'soc', 'windowsOpen']);
  assert.ok(cloud.calls.some((c) => c.url.startsWith('https://nominatim.openstreetmap.org/reverse?') && c.headers['user-agent'].startsWith('GateControl/')));
  assert.deepEqual((await asPortal(host, BOB, 'GET', '/portal')).json, { ok: true, vehicles: [], loggedIn: true });
}));

test('portal: device trust only (not signed in) → no position, no timers, no commands', () => withHost({}, async (host, cloud) => {
  const { vehicleId } = await owned(host, cloud);
  const geocodes = () => cloud.calls.filter((c) => c.url.includes('nominatim')).length;
  const r = await asPortal(host, ADA, 'GET', '/portal', undefined, false);
  assert.equal(r.json.loggedIn, false);
  assert.equal(r.json.vehicles[0].state.position, null);
  assert.deepEqual(r.json.vehicles[0].state.climate.timers, []);
  assert.equal(geocodes(), 0, 'no address lookup for a trust-only viewer');
  const c = await asPortal(host, ADA, 'POST', `/portal/vehicles/${vehicleId}/command`, { action: 'ac_stop', args: {} }, false);
  assert.equal(c.status, 403);
  assert.equal(c.json.code, 'LOGIN_REQUIRED');
}));

test('portal: commands, image and details only for the owner; details with masked VIN', () => withHost({}, async (host, cloud) => {
  const { vehicleId } = await owned(host, cloud);
  const n = cloud.commands.length;
  const denied = await asPortal(host, BOB, 'POST', `/portal/vehicles/${vehicleId}/command`, { action: 'ac_stop', args: {} });
  assert.equal(denied.status, 403);
  assert.equal(denied.json.code, 'SKODA_NOT_OWNER');
  assert.equal((await asPortal(host, BOB, 'GET', `/portal/vehicles/${vehicleId}/image`)).status, 403);
  assert.equal((await asPortal(host, BOB, 'GET', `/portal/vehicles/${vehicleId}/details`)).status, 403);
  assert.equal(cloud.commands.length, n);
  const ok = await asPortal(host, ADA, 'POST', `/portal/vehicles/${vehicleId}/command`, { action: 'charge_limit', args: { limit: 90 } });
  assert.equal(ok.status, 200);
  assert.deepEqual(cloud.commands.at(-1).body, { targetSOCInPercent: 90 });
  const img = await asPortal(host, ADA, 'GET', `/portal/vehicles/${vehicleId}/image`);
  assert.equal(img.json.image, 'data:image/png;base64,' + PNG.toString('base64'));
  const d = await asPortal(host, ADA, 'GET', `/portal/vehicles/${vehicleId}/details`);
  assert.equal(d.json.details.meta.vin, '***0001');
  assert.equal(d.json.details.meta.title, 'Škoda Elroq 85');
  assert.deepEqual(d.json.details.equipment, ['Wärmepumpe', 'Matrix-LED']);
  assert.deepEqual(d.json.details.connection, { online: true, ignitionOn: false, inMotion: false });
  assert.deepEqual(d.json.details.drivingScore, { weekly: 81, monthly: 78, lastCalculationDate: '2026-07-21' });
  // the administrator gets the full VIN — from the same cache entry, which the portal form never changed
  const admin = await asAdmin(host, 'GET', `/vehicles/${vehicleId}/details`);
  assert.equal(admin.json.details.meta.vin, 'TMBTESTVIN000001');
  assert.equal(cloud.calls.filter((c) => c.url.includes('/vehicle-information/') && !c.url.endsWith('/equipment')).length, 1, 'cached for 5 minutes');
  // unknown sub-paths
  assert.equal((await asPortal(host, ADA, 'GET', '/portal/vehicles/abc/image')).status, 404);
  assert.equal((await asPortal(host, ADA, 'DELETE', `/portal/vehicles/${vehicleId}/command`)).status, 404);
}));

test('details: 429 is cached briefly, a missing session is a typed 409', () => withHost({}, async (host, cloud) => {
  const { accountId, vehicleId } = await owned(host, cloud);
  cloud.fail['/vehicle-information/'] = 429;
  assert.equal((await asAdmin(host, 'GET', `/vehicles/${vehicleId}/details`)).status, 429);
  delete cloud.fail['/vehicle-information/'];
  assert.equal((await asAdmin(host, 'GET', `/vehicles/${vehicleId}/details`)).status, 429, 'not hammering a rate-limited cloud');
  require('../server/details').reset();
  await host.gc.settings.setSecret(`acc.${accountId}.access`, null);
  const r = await asAdmin(host, 'GET', `/vehicles/${vehicleId}/details`);
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'SKODA_NO_SESSION');
}));

test('portalVisible, Start tiles and search: only the viewer\'s vehicles, declarative', () => withHost({}, async (host, cloud) => {
  await owned(host, cloud);
  assert.equal(await host.portalVisible(ADA, 'skoda'), true);
  assert.equal(await host.portalVisible(BOB, 'skoda'), false);
  const tiles = await host.portalTiles(ADA);
  assert.deepEqual(tiles, [{ section: 'skoda', title: 'Elroq', value: '74 % · 310 km · lädt', state: 'on', icon: 'M5 16l1-5 2-3h8l2 3 1 5v3h-2a2 2 0 0 1-4 0H9a2 2 0 0 1-4 0H3v-3z' }]);
  assert.equal((await host.portalTiles(ADA, 'en'))[0].value, '74 % · 310 km · charging');
  assert.deepEqual(await host.portalTiles(BOB), []);
  assert.equal(cloud.calls.filter((c) => c.url.includes('nominatim')).length, 0, 'tiles never look up an address');
  assert.deepEqual(await host.portalSearch(ADA, 'elr'), [{ title: 'Elroq', subtitle: 'Fahrzeug', section: 'skoda' }]);
  assert.deepEqual(await host.portalSearch(ADA, 'x'), []);
  assert.deepEqual(await host.portalSearch(BOB, 'elr'), []);
}));
