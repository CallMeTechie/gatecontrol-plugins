'use strict';

// The mock host's mirror of GateControl 1.280.0 gc.profile (src/services/profile.js viewFor, hostApi.js 'profile.get'):
// only the fields of permissions.profile, only what the viewer may see, the viewer only while that person has a request
// in flight; the hooks profileChanged and myData.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHost } = require('../testing/mock-host');

const USERS = [{ id: 1, name: 'admin', role: 'admin' }, { id: 2, name: 'Anna', role: 'user' }, { id: 3, name: 'Marc', role: 'user' }, { id: 4, name: 'Bob', role: 'user' }];
const PEOPLE = {
  2: { firstName: 'Anna', lastName: 'Berger', about: 'ab 17 Uhr', birthday: '1986-03-14', yearHidden: true, visibility: { lastName: 'family', about: 'self' } },
};

const CODE = `
const seen = [];
module.exports = {
  async request(req, gc) {
    const b = req.body || {};
    if (req.path === '/has') return { json: { profile: !!gc.profile, seen } };
    try { return { json: { ok: true, result: await gc.profile.get(b.id, b.viewer != null ? { viewer: b.viewer } : undefined) } }; } catch (e) { return { json: { ok: false, code: e.code } }; }
  },
  async profileChanged(arg) { seen.push(arg); },
  async myData({ userId }) { return userId === 2 ? { role: 'parent' } : null; },
};`;

function plugin(perms) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-plugin-'));
  fs.mkdirSync(path.join(dir, 'server'));
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id: 'pf-test', name: 'P', version: '1.0.0', entry: 'server/index.js', permissions: perms }));
  fs.writeFileSync(path.join(dir, 'server', 'index.js'), CODE);
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function withHost(perms, opts, fn) {
  const p = plugin(perms);
  const host = await createHost(p.dir, { users: USERS, ...opts });
  await host.start();
  try { return await fn(host); } finally { await host.close(); p.done(); }
}
const get = (host, user, id, viewer) => host.request({ method: 'POST', path: '/x', user, body: { id, viewer } }).then((r) => r.json);

test('gc.profile: from GateControl 1.280.0 or with opts.profile; without permissions.profile ERR_PROFILE_DENIED', async () => {
  await withHost({ users: true, profile: ['birthday'] }, { gatecontrol: '1.279.0' }, async (host) => {
    assert.equal((await host.request({ path: '/has' })).json.profile, false);
  });
  await withHost({ users: true }, { gatecontrol: '1.280.0' }, async (host) => {
    assert.equal((await host.request({ path: '/has' })).json.profile, true);
    assert.equal((await get(host, USERS[1], 2)).code, 'ERR_PROFILE_DENIED');
  });
  await assert.rejects(withHost({ profile: ['birthday'] }, { profile: {} }, async () => {}), /needs permissions.users/);
  await assert.rejects(withHost({ users: true, profile: ['email'] }, { profile: {} }, async () => {}), /permissions.profile: invalid/);
});

test('only the allowed fields, only what the viewer sees; the viewer only in its own request; the year hidden', () => withHost({ users: true, profile: ['firstName', 'lastName', 'about', 'birthday'] },
  { profile: { people: PEOPLE, families: [[2, 3]] } }, async (host) => {
    const anna = USERS[1]; const marc = USERS[2]; const bob = USERS[3];
    // Marc (family) in his own request
    assert.deepEqual((await get(host, marc, 2, 3)).result, { userId: 2, firstName: 'Anna', lastName: 'Berger', birthday: { date: '--03-14', month: 3, day: 14, year: null } });
    // Bob (no relation): only "all"
    assert.deepEqual((await get(host, bob, 2, 4)).result, { userId: 2, firstName: 'Anna' });
    // Marc named as viewer in Bob's request: does not count
    assert.deepEqual((await get(host, bob, 2, 3)).result, { userId: 2, firstName: 'Anna' });
    // herself: "Nur ich" too
    assert.equal((await get(host, anna, 2, 2)).result.about, 'ab 17 Uhr');
    assert.equal((await get(host, anna, 99)).result, null);
    assert.equal((await get(host, anna, 0)).code, 'ERR_INVALID');
  }));

test('the hooks: profileChanged with the fields (phones only with the permission), myData → { data }', () => withHost({ users: true, profile: ['birthday'] }, { profile: {} }, async (host) => {
  assert.deepEqual(await host.profile.changed(2, ['birthday', 'phones']), ['birthday']);
  assert.deepEqual((await host.request({ path: '/has' })).json.seen, [{ userId: 2, fields: ['birthday'] }]);
  assert.deepEqual(await host.profile.myData(2), { data: { role: 'parent' } });
  assert.deepEqual(await host.profile.myData(3), { data: null });
}));
