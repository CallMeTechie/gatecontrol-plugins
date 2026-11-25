'use strict';

// The mock host's hook devicesChanged (GateControl ≥ 1.322.0): removed / blocked app tokens and new ones.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHost } = require('../testing/mock-host');

const CODE = `let seen = [];
module.exports = {
  async devicesChanged(change, gc) { seen.push(change); seen.push({ listed: (await gc.devices.list({ userId: 1 })).map((d) => d.id) }); },
  async request() { return { json: { seen } }; },
};`;

function plugin(perms) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-plugin-'));
  fs.mkdirSync(path.join(dir, 'server'));
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id: 'dc-test', name: 'D', version: '1.0.0', entry: 'server/index.js', permissions: perms }));
  fs.writeFileSync(path.join(dir, 'server', 'index.js'), CODE);
  return dir;
}

test('devicesChanged: the hook gets the host\'s entries, removed devices leave the list', async () => {
  const dir = plugin({ devices: true, users: true });
  const devices = [{ id: '7', userId: 1, name: 'Pixel', platform: 'android' }, { id: '8', userId: 1, name: 'TV', platform: 'android', clientType: 'android-tv' }];
  const host = await createHost(dir, { gatecontrol: '1.317.1', users: [{ id: 1, name: 'Ada', role: 'admin' }], devices });
  try {
    await host.start();
    const p = await host.devicesChanged({ removed: [{ id: 7, userId: 1, name: 'Pixel', platform: 'android', reason: 'revoked' }], added: ['9'] });
    assert.deepEqual(p.removed, [{ id: '7', userId: 1, name: 'Pixel', platform: 'android', clientType: null, reason: 'revoked' }]);
    assert.deepEqual(p.added, [{ id: '9', userId: null, name: null, platform: null, clientType: null, reason: 'created' }]);
    const r = await host.request({ method: 'GET', path: '/' });
    assert.deepEqual(r.json.seen[1], { listed: ['8'] });
    await assert.rejects(host.devicesChanged({ removed: [{ id: '8', reason: 'created' }] }), { code: 'ERR_INVALID' });
  } finally { await host.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('devicesChanged: nothing for a plugin without permissions.devices', async () => {
  const dir = plugin({ users: true });
  const host = await createHost(dir, { gatecontrol: '1.317.1', users: [{ id: 1, name: 'Ada', role: 'admin' }] });
  try {
    await host.start();
    assert.equal(await host.devicesChanged({ removed: ['1'] }), null);
  } finally { await host.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
