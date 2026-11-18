'use strict';

// The mock host's mirror of GateControl 1.298.0 gc.places („Meine Orte“, src/services/places.js, hostApi.js placesCall,
// the child bootstrap makePlaces): only with permissions.places === true, what the person may see (own, others' "all",
// in one family "family"), resolve with and without a person, markUsed only own, reportUsage absolute per place /
// plugin / kind, importFor idempotent, the hook placesChanged after a change of the test's side. GateControl 1.299.0
// (version 2): create / update / remove for the owner, search, reportUsage with count 0 for any place id.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHost } = require('../testing/mock-host');

const USERS = [{ id: 1, name: 'admin', role: 'admin' }, { id: 2, name: 'Anna', role: 'user' }, { id: 3, name: 'Marc', role: 'user' }, { id: 4, name: 'Bob', role: 'user' }];
const PLACES = {
  places: [
    { id: 12, userId: 2, name: 'Arbeit', icon: 'work', lat: 50.110922, lon: 8.682127, radiusM: 200 },
    { id: 13, userId: 3, name: 'Bei Oma', lat: 50.3, lon: 8.5, visibility: 'family' },
    { id: 14, userId: 3, name: 'Verein', lat: 50.4, lon: 8.4, visibility: 'all' },
    { id: 15, userId: 3, name: 'Geheim', lat: 50.5, lon: 8.3 },
  ],
  families: [[2, 3]],
};

const CODE = `
const seen = [];
module.exports = {
  async request(req, gc) {
    const b = req.body || {};
    if (req.path === '/has') return { json: { places: !!gc.places, version: gc.places ? gc.places.version : null, seen } };
    try { return { json: { ok: true, result: await gc.places[b.op](b.arg) } }; } catch (e) { return { json: { ok: false, code: e.code, field: e.field, usedBy: e.usedBy, retryAfterS: e.retryAfterS } }; }
  },
  async placesChanged(arg) { seen.push(arg); },
};`;

function plugin(perms) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-plugin-'));
  fs.mkdirSync(path.join(dir, 'server'));
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id: 'pl-test', name: 'P', version: '1.0.0', entry: 'server/index.js', permissions: perms }));
  fs.writeFileSync(path.join(dir, 'server', 'index.js'), CODE);
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function withHost(perms, opts, fn) {
  const p = plugin(perms);
  const host = await createHost(p.dir, { users: USERS, ...opts });
  await host.start();
  try { return await fn(host); } finally { await host.close(); p.done(); }
}
const op = (host, name, arg) => host.request({ method: 'POST', path: '/x', body: { op: name, arg } }).then((r) => r.json);

test('gc.places: from GateControl 1.298.0 or with opts.places, only with permissions.places === true', async () => {
  await withHost({ places: true }, { gatecontrol: '1.297.0' }, async (host) => {
    assert.equal((await host.request({ path: '/has' })).json.places, false);
  });
  await withHost({}, { gatecontrol: '1.298.0' }, async (host) => {
    assert.equal((await host.request({ path: '/has' })).json.places, false, 'without the permission there is no gc.places');
  });
  await withHost({ places: true }, { gatecontrol: '1.298.0' }, async (host) => {
    assert.deepEqual([(await host.request({ path: '/has' })).json.places, (await host.request({ path: '/has' })).json.version], [true, 1]);
  });
  await assert.rejects(withHost({ places: 'read' }, { places: {} }, async () => {}), /permissions.places: invalid/);
});

test('list / get / resolve: what the person may see; resolve without a person any place', () => withHost({ places: true }, { places: PLACES }, async (host) => {
  let r = await op(host, 'list', { userId: 2 });
  assert.deepEqual(r.result.map((p) => [p.ref, p.own, p.ownerId, p.ownerName, 'usedBy' in p]), [
    ['profile:12', true, 2, undefined, true], ['profile:13', false, 3, 'Marc', false], ['profile:14', false, 3, 'Marc', false],
  ]);
  assert.deepEqual(r.result[0], { id: 12, ref: 'profile:12', name: 'Arbeit', icon: 'work', lat: 50.110922, lon: 8.682127, radiusM: 200, address: null, visibility: 'self',
    source: 'manual', usedBy: [], createdAt: r.result[0].createdAt, updatedAt: r.result[0].updatedAt, lastUsedAt: null, ownerId: 2, own: true });
  assert.deepEqual((await op(host, 'list', { userId: 4 })).result.map((p) => p.id), [14], 'not in the family: only "all"');
  assert.deepEqual((await op(host, 'list', { userId: 2, owner: 2 })).result.map((p) => p.id), [12]);
  assert.equal((await op(host, 'list', { userId: 99 })).code, 'ERR_NOT_FOUND');
  assert.equal((await op(host, 'list', { userId: 0 })).code, 'ERR_INVALID');
  assert.equal((await op(host, 'get', { userId: 2, id: 15 })).result, null);
  assert.equal((await op(host, 'get', { userId: 4, id: 13 })).result, null);
  assert.equal((await op(host, 'get', { userId: 2, id: 13 })).result.name, 'Bei Oma');
  assert.equal((await op(host, 'resolve', 'profile:15')).result.ownerId, 3, 'without a person: any place');
  assert.equal((await op(host, 'resolve', { ref: 'profile:15', userId: 2 })).result, null);
  for (const bad of ['profile:0', 'place:3', 'home', 'profile:x', 12]) assert.equal((await op(host, 'resolve', bad)).code, 'ERR_INVALID', String(bad));
}));

test('markUsed own only; reportUsage absolute, 0 removes; importFor idempotent; placesChanged after add / update / remove', () => withHost({ places: true }, { places: PLACES }, async (host) => {
  assert.ok((await op(host, 'markUsed', { userId: 2, id: 12 })).result.lastUsedAt);
  assert.equal((await op(host, 'markUsed', { userId: 2, id: 13 })).code, 'ERR_NOT_FOUND');
  assert.deepEqual((await op(host, 'reportUsage', { userId: 2, id: 13, kind: 'location_message', count: 3 })).result.usedBy, [{ plugin: 'pl-test', pluginName: 'P', kind: 'location_message', count: 3 }]);
  await op(host, 'reportUsage', { userId: 2, id: 13, kind: 'location_message', count: 1 });
  assert.deepEqual(host.places.usage(13), [{ plugin: 'pl-test', kind: 'location_message', count: 1 }]);
  await op(host, 'reportUsage', { userId: 2, id: 13, kind: 'location_message', count: 0 });
  assert.deepEqual(host.places.usage(13), []);
  assert.equal((await op(host, 'reportUsage', { userId: 2, id: 15, kind: 'x', count: 1 })).code, 'ERR_NOT_FOUND');
  assert.equal((await op(host, 'reportUsage', { userId: 2, id: 12, kind: 'Bad', count: 1 })).code, 'ERR_INVALID');
  assert.equal((await op(host, 'reportUsage', { userId: 2, id: 12, kind: 'x', count: 1.5 })).code, 'ERR_INVALID');
  const imp = { userId: 2, source: 'notizen', places: [{ sourceRef: 'a', name: 'Arbeit', lat: 50, lon: 8 }, { sourceRef: 'b', name: 'Nix', lat: 0, lon: 0 }, { sourceRef: 'c', name: 'Fav', lat: 1, lon: 1, favorite: true }] };
  let r = await op(host, 'importFor', imp);
  assert.deepEqual([r.result.map.a.created, r.result.skipped], [true, [{ sourceRef: 'b', reason: 'invalid', field: 'lat' }, { sourceRef: 'c', reason: 'invalid', field: 'favorite' }]]);
  assert.equal(host.places.all().find((p) => p.id === r.result.map.a.id).name, 'Arbeit 2');
  const again = await op(host, 'importFor', imp);
  assert.deepEqual([again.result.map.a.id, again.result.map.a.created], [r.result.map.a.id, false]);
  const placed = await host.places.add(2, { name: 'Studio', lat: 50.12, lon: 8.69 });
  await host.places.update(placed.id, { lat: 50.13 });
  assert.equal(host.places.all().find((p) => p.id === placed.id).lon, 8.69, 'lat alone keeps lon');
  await host.places.remove(placed.id);
  r = (await host.request({ path: '/has' })).json.seen;
  assert.deepEqual(r, [{ userId: 2, ids: [r[0].ids[0]], deleted: false }, { userId: 2, ids: [placed.id], deleted: false }, { userId: 2, ids: [placed.id], deleted: false }, { userId: 2, ids: [placed.id], deleted: true }]);
}));

test('version 2 (GateControl 1.299.0): create / update / remove only for the owner, the codes with their fields, the hook', async () => {
  await withHost({ places: true }, { gatecontrol: '1.298.0' }, async (host) => {
    assert.equal((await host.request({ path: '/has' })).json.version, 1);
    assert.equal((await op(host, 'create', { userId: 2, place: { name: 'x', lat: 1, lon: 1 } })).ok, false, 'version 1 has no create');
  });
  await withHost({ places: true }, { gatecontrol: '1.299.0', places: PLACES }, async (host) => {
    assert.equal((await host.request({ path: '/has' })).json.version, 2);
    const made = (await op(host, 'create', { userId: 2, place: { name: 'Studio', lat: 50.12, lon: 8.69, icon: 'gym' } })).result;
    assert.deepEqual([made.name, made.icon, made.radiusM, made.visibility, made.source, made.own, made.ownerId, made.ref], ['Studio', 'gym', 150, 'self', 'manual', true, 2, 'profile:' + made.id]);
    for (const [place, code, field] of [[{ name: 'arbeit', lat: 1, lon: 1 }, 'ERR_DUPLICATE', 'name'], [{ name: 'Y', lat: 1, lon: 1, source: 'notizen' }, 'ERR_INVALID', 'source'],
      [{ name: 'Y', lat: 0, lon: 0 }, 'ERR_INVALID', 'lat'], [{ name: 'Y', lat: 1, lon: 1, radiusM: 20 }, 'ERR_INVALID', 'radiusM']]) {
      const r = await op(host, 'create', { userId: 2, place });
      assert.deepEqual([r.code, r.field], [code, field], JSON.stringify(place));
    }
    assert.equal((await op(host, 'create', { userId: 99, place: { name: 'Y', lat: 1, lon: 1 } })).code, 'ERR_NOT_FOUND');
    // update: own only (Marc's place Anna may see is not hers), lat and lon together, {} changes nothing
    const up = (await op(host, 'update', { userId: 2, id: made.id, patch: { name: 'Atelier', lat: 50.2, lon: 8.7, address: 'Hof 1' } })).result;
    assert.deepEqual([up.name, up.lat, up.lon, up.address], ['Atelier', 50.2, 8.7, 'Hof 1']);
    assert.equal((await op(host, 'update', { userId: 2, id: made.id, patch: { address: null } })).result.address, null);
    assert.deepEqual([(await op(host, 'update', { userId: 2, id: made.id, patch: { lat: 50.3 } })).field], ['lon']);
    assert.equal((await op(host, 'update', { userId: 2, id: 14, patch: { name: 'x' } })).code, 'ERR_NOT_FOUND', 'visible, but Marc\'s');
    assert.equal((await op(host, 'update', { userId: 2, id: made.id, patch: { name: 'ARBEIT' } })).code, 'ERR_DUPLICATE');
    const seen = (await host.request({ path: '/has' })).json.seen.length;
    await op(host, 'update', { userId: 2, id: made.id, patch: {} });
    assert.equal((await host.request({ path: '/has' })).json.seen.length, seen, 'an empty patch: no hook');
    // remove: in use (by any plugin) only with force
    host.places.setUsage(made.id, 'gatecontrol-messenger', 'location_message', 2);
    const busy = await op(host, 'remove', { userId: 2, id: made.id });
    assert.deepEqual([busy.code, busy.usedBy], ['ERR_IN_USE', [{ plugin: 'gatecontrol-messenger', pluginName: 'gatecontrol-messenger', kind: 'location_message', count: 2 }]]);
    assert.equal((await op(host, 'remove', { userId: 3, id: made.id, force: true })).code, 'ERR_NOT_FOUND', 'not Marc\'s');
    assert.deepEqual((await op(host, 'remove', { userId: 2, id: made.id, force: true })).result, { deleted: true, id: made.id });
    assert.deepEqual(host.places.usage(made.id), []);
    const hooks = (await host.request({ path: '/has' })).json.seen;
    assert.deepEqual(hooks.map((x) => [x.userId, x.ids, x.deleted]), [[2, [made.id], false], [2, [made.id], false], [2, [made.id], false], [2, [made.id], true]]);
    // reportUsage 0 for a place Anna does not see (Marc's „Geheim“) or one that is gone: taken, only her own row
    host.places.setUsage(15, 'pl-test', 'task', 4);
    host.places.setUsage(15, 'other', 'task', 1);
    assert.deepEqual((await op(host, 'reportUsage', { userId: 2, id: 15, kind: 'task', count: 0 })).result, { usedBy: [] });
    assert.deepEqual(host.places.usage(15), [{ plugin: 'other', kind: 'task', count: 1 }]);
    assert.deepEqual((await op(host, 'reportUsage', { userId: 2, id: 9999, kind: 'task', count: 0 })).result, { usedBy: [] });
    assert.equal((await op(host, 'reportUsage', { userId: 2, id: 15, kind: 'task', count: 1 })).code, 'ERR_NOT_FOUND');
  });
});

test('version 2: search — the cell rounded, at most 8 hits, a cache, 30 per person and hour, the switch', () => withHost({ places: true }, { gatecontrol: '1.299.0', places: PLACES }, async (host) => {
  host.places.searchWith(({ q }) => Array.from({ length: 10 }, (_, i) => ({ name: `${q} ${i + 1}`, address: 'Frankfurt', lat: 50.1 + i / 100, lon: 8.68 })));
  const r = (await op(host, 'search', { userId: 2, q: 'Hauptstraße', near: '50.1109,8.6821' })).result;
  assert.equal(r.results.length, 8);
  assert.deepEqual(Object.keys(r.results[0]).sort(), ['address', 'distanceM', 'lat', 'lon', 'name', 'source']);
  assert.deepEqual(r.attribution, { text: '© OpenStreetMap', url: 'https://www.openstreetmap.org/copyright' });
  assert.deepEqual(host.places.searches, [{ userId: 2, q: 'Hauptstraße', near: { lat: 50.11, lon: 8.68 }, lang: 'de' }]);
  await op(host, 'search', { userId: 2, q: 'Hauptstraße', near: { lat: 50.112, lon: 8.679 } });
  assert.equal(host.places.searches.length, 1, 'the same cell: from the cache');
  assert.equal((await op(host, 'search', { userId: 2, q: 'ab' })).field, 'q');
  assert.equal((await op(host, 'search', { userId: 2, q: 'abc', near: 'hier' })).field, 'near');
  assert.equal((await op(host, 'search', { userId: 99, q: 'abc' })).code, 'ERR_NOT_FOUND');
  for (let i = 0; i < 29; i++) await op(host, 'search', { userId: 2, q: 'Weg ' + i });
  const lim = await op(host, 'search', { userId: 2, q: 'Weg 99' });
  assert.equal(lim.code, 'ERR_RATE_LIMIT');
  assert.ok(lim.retryAfterS > 0);
  assert.equal((await op(host, 'search', { userId: 3, q: 'Weg 99' })).ok, true, 'per person');
  host.places.searchOff(true);
  assert.equal((await op(host, 'search', { userId: 3, q: 'Weg 98' })).code, 'ERR_SEARCH_OFF');
}));
