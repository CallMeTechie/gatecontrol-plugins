'use strict';

// The mock host's mirror of GateControl 1.298.0 gc.places („Meine Orte“, src/services/places.js, hostApi.js placesCall,
// the child bootstrap makePlaces): only with permissions.places === true, what the person may see (own, others' "all",
// in one family "family"), resolve with and without a person, markUsed only own, reportUsage absolute per place /
// plugin / kind, importFor idempotent, the hook placesChanged after a change of the test's side.

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
    try { return { json: { ok: true, result: await gc.places[b.op](b.arg) } }; } catch (e) { return { json: { ok: false, code: e.code } }; }
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
