'use strict';

// 1.22.0 — the family's places and the number of watched places for „Notizen & Aufgaben“ (services `places` and
// `geofences`), tested against the real hub (plugins/gatecontrol-notizen ≥ 1.5.0 in a mock host of its own, the two
// wired through their services): „zu Hause“ and a rule place as the place of a task there, and the places a phone
// watches shared between the two plugins (Android: 100 per app). The clock is the helpers' and only ever set.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHost } = require('../../../tools/testing/mock-host');
const { withFamily, ANNA, LENA, OMA, USERS, app } = require('./helpers');

const NZ_DIR = path.join(__dirname, '..', '..', 'gatecontrol-notizen');
const nz = (f) => require(path.join(NZ_DIR, 'server', f));
const FAM = 'gatecontrol-familie';

/** Familie (the helpers' family, with a home) and the real hub, each in its own mock host. */
async function linked(fn) {
  const entry = { plugin: 'gatecontrol-notizen', provides: require(path.join(NZ_DIR, 'plugin.json')).services.provides, service: null };
  return withFamily({ gatecontrol: '1.216.0', settings: { lat: '52.52', lon: '13.405' }, services: [entry] }, async (famHost, ctx) => {
    nz('clock.js').set(null); // the hub's clock is the mocked Date of the helpers
    nz('config.js').reset();
    nz('people.js').reset();
    nz('places.js').reset();
    const hubHost = await createHost(NZ_DIR, {
      gatecontrol: '1.216.0', users: USERS, license: { required: true, licensed: true, state: 'valid', expiresAt: null },
      services: [{ plugin: FAM, provides: require('../plugin.json').services.provides, service: (c) => famHost.callService(c.name, { caller: c.caller, user: c.user, payload: c.payload }) }],
    });
    await hubHost.start();
    nz('shopping.js').state.noTimer = true;
    entry.service = (c) => hubHost.callService(c.name, { caller: c.caller, user: c.user, payload: c.payload });
    const req = (host) => (user) => async (method, p, body) => {
      const r = await host.request({ method, path: p, body: body === undefined ? null : body, query: {}, user: app(user), lang: 'de' });
      assert.equal(r.status, 200, `${method} ${p} → ${r.status} ${JSON.stringify(r.json)}`);
      return r.json;
    };
    try {
      return await fn({ fam: req(famHost), hub: req(hubHost), admin: ctx.admin, forget: () => nz('places.js').reset() });
    } finally { await hubHost.close(); }
  });
}

test('the hub offers „Zuhause“ and the rule places as places of a task — to members of the family only', () => linked(async (x) => {
  await x.admin('PUT', 'modules', { presence: true });
  const s = (await x.fam(ANNA)('POST', '/presence/places', { name: 'Schule', lat: 52.5301, lon: 13.4101, radius: 300 })).place;
  x.forget();
  assert.deepEqual((await x.hub(ANNA)('GET', 'places')).family, [
    { familyId: 'home', name: 'Zuhause', lat: 52.52, lon: 13.405, radius: 150 }, { familyId: `place:${s.id}`, name: 'Schule', lat: 52.5301, lon: 13.4101, radius: 300 }]);
  assert.equal((await x.hub(ANNA)('GET', 'me')).places.family, true);
  assert.deepEqual((await x.hub(OMA)('GET', 'places')).family, [], 'not of the family');
  // the quick entry knows them by name
  const home = await x.hub(LENA)('POST', 'tasks', { text: 'zu Hause Blumen gießen', place: 'auto' });
  assert.deepEqual([home.task.title, home.task.place.name, home.task.place.ref, home.task.place.lat, home.task.place.lon, home.task.place.radius, home.task.place.watch],
    ['Blumen gießen', 'Zuhause', 'familie:home', 52.52, 13.405, 150, true]);
  const school = await x.hub(LENA)('POST', 'tasks', { text: 'an der Schule Zettel abgeben', place: 'auto' });
  assert.deepEqual([school.task.title, school.task.place.name, school.task.place.ref, school.task.place.radius], ['Zettel abgeben', 'Schule', `familie:place:${s.id}`, 300]);
  assert.equal((await x.hub(OMA)('POST', 'tasks', { text: 'zu Hause Blumen gießen', place: 'auto' })).task.place, null);
  assert.deepEqual((await x.hub(LENA)('POST', 'places/watch', {})).fences.map((f) => [f.id, f.name, f.radius]).sort(),
    [['p:' + home.task.place.id, 'Zuhause', 150], ['p:' + school.task.place.id, 'Schule', 300]].sort());
}));

test('the watched places are shared: what Familie\'s phone watches comes off the hub\'s share', () => linked(async (x) => {
  assert.equal((await x.hub(LENA)('POST', 'places/watch', {})).max, 60, 'nothing watched for Familie: the hub\'s own ceiling');
  // 35 place reminders of Lena: 100 − 10 in reserve − 35 = 55
  for (let i = 0; i < 35; i++) await x.fam(LENA)('POST', '/places', { title: 'Ort ' + i, lat: 52.5 + i / 1000, lon: 13.4 });
  assert.equal((await x.hub(LENA)('POST', 'places/watch', {})).max, 55);
  // 50 (Familie's own limit per person): 40 are left for the hub — and the phone's own report can only lower it
  for (let i = 35; i < 50; i++) await x.fam(LENA)('POST', '/places', { title: 'Ort ' + i, lat: 52.5 + i / 1000, lon: 13.4 });
  assert.equal((await x.hub(LENA)('POST', 'places/watch', {})).max, 40);
  assert.equal((await x.hub(LENA)('POST', 'places/watch', { budget: 12 })).max, 12);
  assert.equal((await x.hub(ANNA)('POST', 'places/watch', {})).max, 60, 'they are Lena\'s phone\'s');
}));
