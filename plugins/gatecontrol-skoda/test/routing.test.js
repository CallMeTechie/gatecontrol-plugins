'use strict';

// 1.6.0: the way of a trip on the map (server/routing.js) — computed once in
// the background from OpenStreetMap's routing service, kept with the trip,
// listed for the pages and the apps (app/logbook…).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const { fakeSkoda, withHost, connected, fx, ADMIN, ADA, BOB } = H;
const routing = require('../server/routing');

const GC = '1.186.0';

function req(host, user, method, p, body) {
  const [path, qs] = String(p).split('?');
  const query = Object.fromEntries(new URLSearchParams(qs || ''));
  return host.request({ method, path, query, body: body === undefined ? null : body, user });
}
const asAdmin = (host, method, p, body) => req(host, ADMIN, method, p, body);
// the client plugin bridge of GateControl: the token's owner, signed in, from an app
const asApp = (host, user, method, p, body) => req(host, { ...user, portal: true, loggedIn: true, app: true }, method, p, body);

async function withState({ lat, lon, km, moving = false }, fn) {
  const saved = { positions: fx.positions, health: fx.health };
  fx.positions = moving ? { positions: [], errors: [{ type: 'VEHICLE_IN_MOTION' }] }
    : { positions: [{ type: 'VEHICLE', gpsCoordinates: { latitude: lat, longitude: lon } }], errors: [] };
  fx.health = { ...fx.health, mileageInKm: km };
  try { return await fn(); } finally { Object.assign(fx, saved); }
}
const sync = (host, accountId) => asAdmin(host, 'POST', `/accounts/${accountId}/sync`);

/** Connect, give the vehicle to Ada, drive (parked at 51.0/7.0 with 5210 km → 51.1/7.1 with endKm). */
async function oneTrip(host, cloud, endKm = 5232) {
  const ids = await connected(host, cloud);
  await asAdmin(host, 'PUT', `/vehicles/${ids.vehicleId}/owners`, { user_ids: [ADA.id] });
  await withState({ moving: true, km: 5215 }, () => sync(host, ids.accountId));
  await withState({ lat: 51.1, lon: 7.1, km: endKm }, () => sync(host, ids.accountId));
  return ids;
}

test('simplifying: start and end kept, at most max points, straight runs dropped', () => {
  const line = Array.from({ length: 500 }, (_, i) => [51 + i * 0.0001, 7 + i * 0.0001]);
  assert.deepEqual(routing.thin(line, 150), [line[0], line[499]], 'a straight line keeps its ends');
  const zig = Array.from({ length: 400 }, (_, i) => [51 + i * 0.001, 7 + (i % 2) * 0.01]);
  const out = routing.thin(zig, 150);
  assert.ok(out.length <= 150 && out.length >= 2);
  assert.deepEqual([out[0], out.at(-1)], [zig[0], zig[399]]);
  assert.equal(routing.thin(zig.slice(0, 10), 150).length, 10, 'short ways stay as they are');
});

test('the routing answer: GeoJSON [lon, lat] → [lat, lon] rounded; garbage → null', () => {
  assert.deepEqual(routing.pointsOf([[7.123456789, 51.987654321], [7.2, 51.1]]), [[51.98765, 7.12346], [51.1, 7.2]]);
  for (const bad of [null, [], [[7, 51]], [[7, 51], [200, 51]], [[7, 51], 'x'], [[7, 51], [7, 95]]]) assert.equal(routing.pointsOf(bad), null, JSON.stringify(bad));
});

test('road or straight line: the odometer and the road must roughly agree', () => {
  const trip = { startLat: 51, startLon: 7, endLat: 51.1, endLon: 7.1, distanceKm: 22 };
  const road = { distanceM: 21000, points: [[51, 7], [51.05, 7.03], [51.1, 7.1]] };
  assert.deepEqual(routing.classify(trip, road), { kind: 'road', km: 21, points: road.points });
  // 60 km driven for a 21 km road: a detour or stops on the way
  assert.deepEqual(routing.classify({ ...trip, distanceKm: 60 }, road), { kind: 'line', km: 21, points: [[51, 7], [51.1, 7.1]] });
  // the road is much longer than what was driven (a wrong snap)
  assert.equal(routing.classify({ ...trip, distanceKm: 5 }, road).kind, 'line');
  // traffic, a wrong turn: still the road
  assert.equal(routing.classify({ ...trip, distanceKm: 30 }, road).kind, 'road');
  assert.deepEqual(routing.classify(trip, null), { kind: 'line', km: null, points: [[51, 7], [51.1, 7.1]] }, 'no road found');
});

test('background: a new trip gets its road once; listed with start, end and route (admin, portal, app)', () => {
  const cloud = fakeSkoda();
  return withHost({ cloud, gatecontrol: GC }, async (host) => {
    const { vehicleId } = await oneTrip(host, cloud);
    let trip = (await asAdmin(host, 'GET', '/logbook')).json.trips[0];
    assert.deepEqual([trip.start, trip.end, trip.route], [{ lat: 51, lon: 7 }, { lat: 51.1, lon: 7.1 }, null], 'not computed yet');
    assert.ok(trip.startedAt && trip.endedAt);
    await host.tick();
    assert.equal(cloud.routings, 1);
    const call = cloud.calls.find((c) => c.url.startsWith('https://routing.openstreetmap.de/'));
    assert.match(call.url, /\/routed-car\/route\/v1\/driving\/7,51;7\.1,51\.1\?overview=full&geometries=geojson/);
    assert.match(call.headers['user-agent'], /GateControl/);
    trip = (await asAdmin(host, 'GET', '/logbook')).json.trips[0];
    assert.deepEqual(trip.route, { kind: 'road', km: 21, points: [[51, 7], [51.04, 7.03], [51.07, 7.06], [51.1, 7.1]] });
    await host.tick();
    assert.equal(cloud.routings, 1, 'asked once per trip');

    const portal = await req(host, { ...ADA, portal: true, loggedIn: true }, 'GET', '/portal/logbook');
    assert.deepEqual(portal.json.trips[0].route, trip.route);
    // the apps (1.6.0): the token owner's logbook, changes allowed
    let r = await asApp(host, ADA, 'GET', `/app/logbook?vehicle=${vehicleId}`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.canEdit, r.json.vehicleId, r.json.trips.length, r.json.trips[0].route.kind], [true, vehicleId, 1, 'road']);
    r = await asApp(host, ADA, 'PUT', `/app/logbook/trips/${trip.id}`, { purpose: 'business', note: 'Weber GmbH' });
    assert.deepEqual([r.status, r.json.trip.purpose, r.json.trip.note], [200, 'business', 'Weber GmbH']);
    r = await asApp(host, ADA, 'GET', `/app/logbook/export?vehicle=${vehicleId}&from=${trip.date.slice(0, 7)}&format=csv`);
    assert.equal(r.json.file.type, 'text/csv');
    // not the owner, not from an app, no delete / add by hand
    assert.equal((await asApp(host, BOB, 'GET', `/app/logbook?vehicle=${vehicleId}`)).json.code, 'SKODA_NOT_OWNER');
    assert.equal((await asApp(host, BOB, 'PUT', `/app/logbook/trips/${trip.id}`, { purpose: 'private' })).json.code, 'SKODA_TRIP_NOT_FOUND');
    assert.equal((await asApp(host, ADA, 'DELETE', `/app/logbook/trips/${trip.id}`)).json.code, 'FORBIDDEN');
    assert.equal((await req(host, { ...ADA, portal: true, loggedIn: true }, 'GET', '/app/logbook')).json.code, 'FORBIDDEN', 'the portal is no app');
    assert.equal((await asApp(host, ADA, 'GET', '/app/vehicles')).status, 404);
  });
});

test('background: a detour becomes a straight line; no road found too; a failing service is asked again later', () => {
  const cloud = fakeSkoda();
  return withHost({ cloud, gatecontrol: GC }, async (host) => {
    await oneTrip(host, cloud, 5290); // 80 km for a 21 km road
    await host.tick();
    let trip = (await asAdmin(host, 'GET', '/logbook')).json.trips[0];
    assert.deepEqual(trip.route, { kind: 'line', km: 21, points: [[51, 7], [51.1, 7.1]] });
  }).then(() => {
    const c2 = fakeSkoda();
    c2.route = { code: 'NoRoute', routes: [] };
    return withHost({ cloud: c2, gatecontrol: GC }, async (host) => {
      await oneTrip(host, c2);
      await host.tick();
      assert.deepEqual((await asAdmin(host, 'GET', '/logbook')).json.trips[0].route, { kind: 'line', km: null, points: [[51, 7], [51.1, 7.1]] });
    });
  }).then(() => {
    const c3 = fakeSkoda();
    c3.route = 503;
    return withHost({ cloud: c3, gatecontrol: GC }, async (host) => {
      await oneTrip(host, c3);
      await host.tick();
      assert.equal(c3.routings, 1);
      assert.equal((await asAdmin(host, 'GET', '/logbook')).json.trips[0].route, null, 'nothing kept');
      await host.tick();
      assert.equal(c3.routings, 1, 'not again right away (waits 10 minutes, then longer)');
    });
  });
});

test('a busy month stays a small answer: the ways share 20 000 points (12…150 each)', () => {
  const { routeMaxFor } = require('../server/logbookapi');
  assert.deepEqual([routeMaxFor(1), routeMaxFor(100), routeMaxFor(200), routeMaxFor(3000)], [150, 150, 100, 12]);
});

test('page map: the same way (either direction, same purpose) is one line with its count', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const window = { SK_CTX: { lang: 'de', texts: {} } };
  const document = { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] };
  const ctx = vm.createContext({ window, document, Intl, Promise, Number, String, Object, Array, Math, Error, setTimeout, clearTimeout });
  for (const f of ['common.js', 'lbmap.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ui', f), 'utf8'), ctx);
  const home = { lat: 51.0, lon: 7.0 };
  const work = { lat: 51.1, lon: 7.1 };
  const trip = (id, start, end, purpose, extra = {}) => ({ id, start, end, purpose, distanceKm: 14, route: { kind: 'road', km: 14, points: [[start.lat, start.lon], [end.lat, end.lon]] }, ...extra });
  const groups = window.SK.lbMap.groupsOf([
    trip(1, home, work, 'commute'), trip(2, work, home, 'commute'),
    trip(3, { lat: 51.0004, lon: 7.0004 }, work, 'commute'), // ~50 m away: the same place
    trip(4, home, work, 'business'),
    trip(5, home, { lat: 51.3, lon: 7.3 }, null),
    { id: 6, start: null, end: null, purpose: null, distanceKm: 3, route: null }, // by hand: not on the map
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(groups.map((g) => [g.trips.map((x) => x.id), g.km]))), [[[1, 2, 3], 42], [[4], 14], [[5], 14]]);
});

test('portal without a real login: the list, but no positions and no ways (like the vehicle position)', () => {
  const cloud = fakeSkoda();
  return withHost({ cloud, gatecontrol: GC }, async (host) => {
    await oneTrip(host, cloud);
    await host.tick();
    const r = await req(host, { ...ADA, portal: true, loggedIn: false }, 'GET', '/portal/logbook');
    assert.equal(r.json.trips.length, 1);
    assert.deepEqual([r.json.trips[0].start, r.json.trips[0].end, r.json.trips[0].route], [null, null, null]);
    assert.equal(r.json.canEdit, false);
  });
});
