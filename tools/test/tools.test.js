'use strict';

// Tests of the repository tooling. The pack/verify round trip needs a
// GateControl checkout (tools/fetch-gatecontrol.sh, or CI) and is skipped without.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const lib = require('../lib');
const { internetAllowed, createHost } = require('../testing/mock-host');

const TOOLS = path.join(__dirname, '..');
let gcDir = null;
try { gcDir = lib.gatecontrolDir(); } catch { /* skipped below */ }

test('tags parse into id and version', () => {
  assert.deepEqual(lib.parseTag('gatecontrol-smarthome-v1.0.0'), { id: 'gatecontrol-smarthome', version: '1.0.0' });
  assert.deepEqual(lib.parseTag('a-v2-v1.2.3-rc.1'), { id: 'a-v2', version: '1.2.3-rc.1' });
  for (const bad of ['gatecontrol-smarthome-1.0.0', 'v1.0.0', 'Smart-v1.0.0', 'x-v1.0', 'x-v01.0.0', 'x-v1.0.0 ']) assert.equal(lib.parseTag(bad), null, bad);
});

test('semver precedence', () => {
  const sorted = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.10.0', '2.0.0'];
  const shuffled = [...sorted].reverse();
  assert.deepEqual(shuffled.sort(lib.compareSemver), sorted);
});

test('changelog sections', () => {
  assert.match(lib.changelogSection('gatecontrol-hello', '1.0.0'), /Erste Version/);
  assert.equal(lib.changelogSection('gatecontrol-hello', '9.9.9'), null);
});

test('example plugins are not released', () => {
  assert.equal(lib.pluginConfig('gatecontrol-hello').release, false);
  assert.equal(lib.pluginConfig('some-other').release, true);
  const r = spawnSync(process.execPath, [path.join(TOOLS, 'release-check.js'), 'gatecontrol-hello-v1.0.0'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not released/);
});

test('mock host internet allowlist', () => {
  const list = ['api.example.com:443', '*.cloud.example', 'plain.example'];
  assert.ok(internetAllowed(list, 'https://api.example.com/x'));
  assert.ok(!internetAllowed(list, 'http://api.example.com/x'));
  assert.ok(internetAllowed(list, 'https://a.b.cloud.example/'));
  assert.ok(!internetAllowed(list, 'https://cloud.example/'));
  assert.ok(internetAllowed(list, 'http://plain.example:8080/'));
  assert.ok(!internetAllowed(list, 'file:///etc/passwd'));
});

test('mock host quick actions: checked like the host, run only for an id listed for that viewer', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-plugin-'));
  try {
    fs.mkdirSync(path.join(tmp, 'server'));
    fs.writeFileSync(path.join(tmp, 'plugin.json'), JSON.stringify({ id: 'qa-test', name: 'QA', version: '1.0.0', entry: 'server/index.js', permissions: { portal: true } }));
    fs.writeFileSync(path.join(tmp, 'server', 'index.js'), `
      let answer = null;
      module.exports = {
        _set(a) { answer = a; },
        async quickActions({ user }) { return answer || (user.id === 2 ? [{ id: 'x:1', title: 'Lamp', kind: 'toggle', state: 'on' }] : []); },
        async runQuickAction({ user, id }) { return { ok: true, message: user.app && user.loggedIn ? 'done ' + id : 'no', state: 'off' }; },
      };`);
    const host = await createHost(tmp);
    try {
      assert.deepEqual(await host.quickActions({ id: 2, name: 'Ada', role: 'user' }), [{ id: 'x:1', title: 'Lamp', subtitle: null, icon: null, kind: 'toggle', state: 'on', confirm: false }]);
      assert.deepEqual(await host.runQuickAction({ id: 2, name: 'Ada', role: 'user' }, 'x:1'), { status: 200, body: { ok: true, message: 'done x:1', state: 'off' } });
      assert.equal((await host.runQuickAction({ id: 3, name: 'Bob', role: 'user' }, 'x:1')).status, 404, 'not listed for Bob');
      assert.equal((await host.runQuickAction({ id: 2, name: 'Ada', role: 'user' }, 'x:2')).status, 404);
      const many = Array.from({ length: 17 }, (_, i) => ({ id: 'a' + i, title: 'A' }));
      for (const bad of [many, [{ id: 'a b', title: 'A' }], [{ id: 'a', title: 'x'.repeat(41) }], [{ id: 'a', title: 'A', kind: 'slider' }],
        [{ id: 'a', title: 'A', state: 'on' }], [{ id: 'a', title: 'A' }, { id: 'a', title: 'B' }], [{ id: 'a', title: 'A', icon: '<svg>' }], {}]) {
        host.plugin._set(bad);
        await assert.rejects(host.quickActions({ id: 2, name: 'Ada', role: 'user' }), { code: 'ERR_INVALID' }, JSON.stringify(bad).slice(0, 60));
      }
    } finally {
      await host.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('mock host kiosk users: needs permissions.kiosk, never an administrator or a disabled user', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-plugin-'));
  const write = (permissions) => fs.writeFileSync(path.join(tmp, 'plugin.json'), JSON.stringify({ id: 'kiosk-test', name: 'K', version: '1.0.0', entry: 'server/index.js', permissions }));
  const users = [{ id: 1, name: 'admin', role: 'admin' }, { id: 2, name: 'Küche', role: 'user' }, { id: 3, name: 'Alt', role: 'user', disabled: true }];
  try {
    fs.mkdirSync(path.join(tmp, 'server'));
    fs.writeFileSync(path.join(tmp, 'server', 'index.js'), 'module.exports = {};');
    write({ users: true, kiosk: true });
    const host = await createHost(tmp, { users, kiosk: [9] });
    try {
      assert.deepEqual(await host.gc.kiosk.list(), [9]);
      await host.gc.kiosk.allow(2, true);
      await host.gc.kiosk.allow(2, true);
      assert.deepEqual(await host.gc.kiosk.list(), [2, 9]);
      assert.deepEqual((await host.gc.users.list()).map(({ id, name, role }) => ({ id, name, role })), users.slice(0, 2).map(({ id, name, role }) => ({ id, name, role })), 'disabled accounts are not listed');
      for (const [id, allowed] of [[1, true], [3, true], [4, true], [2, 'yes'], ['2', true], [0, false]]) {
        await assert.rejects(host.gc.kiosk.allow(id, allowed), { code: 'ERR_INVALID' }, `${id} ${allowed}`);
      }
      await host.gc.kiosk.allow(2, false);
      assert.deepEqual([...host.kiosk], [9]);
    } finally {
      await host.close();
    }
    write({ storage: true });
    const without = await createHost(tmp, { users });
    try {
      await assert.rejects(without.gc.kiosk.allow(2, true), { code: 'ERR_KIOSK_DENIED' });
      await assert.rejects(without.gc.kiosk.list(), { code: 'ERR_KIOSK_DENIED' });
    } finally {
      await without.close();
    }
    write({ kiosk: 'yes' });
    await assert.rejects(createHost(tmp, { users }), { code: 'ERR_INVALID' });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('mock host gc.users faces (GateControl ≥ 1.168.0): avatarUrl, colour key (default palette[id % 10]), colorHex, initials', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'face-plugin-'));
  const pic = '/avatars/' + 'a'.repeat(22) + '.webp';
  try {
    fs.mkdirSync(path.join(tmp, 'server'));
    fs.writeFileSync(path.join(tmp, 'server', 'index.js'), 'module.exports = {};');
    fs.writeFileSync(path.join(tmp, 'plugin.json'), JSON.stringify({ id: 'face-test', name: 'F', version: '1.0.0', entry: 'server/index.js', permissions: { users: true } }));
    const users = [{ id: 1, name: 'admin', role: 'admin' }, { id: 2, name: 'Anna Berg', role: 'user', color: 'pink', avatarUrl: pic }, { id: 13, name: 'Tim', role: 'user', color: 'red' }];
    const host = await createHost(tmp, { users });
    try {
      assert.deepEqual(await host.gc.users.list(), [
        { id: 1, name: 'admin', role: 'admin', avatarUrl: null, color: 'teal', colorHex: '#14B8A6', initials: 'AD' },
        { id: 2, name: 'Anna Berg', role: 'user', avatarUrl: pic, color: 'pink', colorHex: '#EC4899', initials: 'AB' },
        { id: 13, name: 'Tim', role: 'user', avatarUrl: null, color: 'lime', colorHex: '#84CC16', initials: 'TI' },
      ], 'red is no favourite colour: the default');
      host.setUserFace(13, { color: 'indigo', avatarUrl: pic });
      assert.deepEqual(await host.gc.users.get(13), { id: 13, name: 'Tim', role: 'user', avatarUrl: pic, color: 'indigo', colorHex: '#6366F1', initials: 'TI' });
      host.setUserFace(13, { avatarUrl: null });
      assert.equal((await host.gc.users.get(13)).avatarUrl, null);
      assert.throws(() => host.setUserFace(13, { avatarUrl: '/avatars/x.gif' }), { code: 'ERR_INVALID' });
    } finally {
      await host.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('mock host plugin actions: needs permissions.actions, checked like the host, other plugins only, 60 runs per hour', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'actions-plugin-'));
  const write = (permissions) => fs.writeFileSync(path.join(tmp, 'plugin.json'), JSON.stringify({ id: 'actions-test', name: 'A', version: '1.0.0', entry: 'server/index.js', permissions }));
  const users = [{ id: 1, name: 'admin', role: 'admin' }, { id: 2, name: 'Anna', role: 'user' }, { id: 3, name: 'Alt', role: 'user', disabled: true }];
  const seen = [];
  const actions = [
    { plugin: 'gatecontrol-smarthome', pluginName: 'Smart Home',
      quickActions: (viewer) => (viewer.id === 2 ? [{ id: 'scene:evening', title: 'Abend', icon: 'M3 3h18', confirm: true }, { id: 'light:1', title: 'Flur', kind: 'toggle', state: 'off' }] : []),
      runQuickAction: (viewer, id) => { seen.push([viewer, id]); if (id === 'light:1') throw new Error('boom'); return { ok: true, message: 'Szene gestartet' }; } },
    { plugin: 'actions-test', actions: [{ id: 'own', title: 'Own' }] },
  ];
  try {
    fs.mkdirSync(path.join(tmp, 'server'));
    fs.writeFileSync(path.join(tmp, 'server', 'index.js'), 'module.exports = {};');
    write({ users: true, actions: true });
    const host = await createHost(tmp, { users, actions });
    try {
      assert.deepEqual(await host.gc.actions.list({ userId: 2, lang: 'de' }), [
        { plugin: 'gatecontrol-smarthome', pluginName: 'Smart Home', id: 'scene:evening', title: 'Abend', subtitle: null, kind: 'button', state: null },
        { plugin: 'gatecontrol-smarthome', pluginName: 'Smart Home', id: 'light:1', title: 'Flur', subtitle: null, kind: 'toggle', state: 'off' },
      ], 'no icon / confirm, never the caller itself');
      assert.deepEqual(await host.gc.actions.list({ userId: 1 }), []);
      assert.deepEqual(await host.gc.actions.run({ userId: 2, plugin: 'gatecontrol-smarthome', id: 'scene:evening' }), { ok: true, message: 'Szene gestartet', state: null });
      assert.deepEqual(seen[0][0], { id: 2, name: 'Anna', role: 'user', portal: true, loggedIn: true, automation: true, via: 'actions-test' });
      assert.deepEqual(await host.gc.actions.run({ userId: 2, plugin: 'gatecontrol-smarthome', id: 'light:1' }), { ok: false, message: null, state: null, error: 'plugin_error' });
      assert.deepEqual(await host.gc.actions.run({ userId: 1, plugin: 'gatecontrol-smarthome', id: 'scene:evening' }), { ok: false, message: null, state: null, error: 'not_found' }, 'not listed for that user');
      assert.deepEqual(await host.gc.actions.run({ userId: 2, plugin: 'gatecontrol-nothing', id: 'x' }), { ok: false, message: null, state: null, error: 'not_found' });
      for (const bad of [{ userId: '2', plugin: 'gatecontrol-smarthome', id: 'x' }, { userId: 3, plugin: 'gatecontrol-smarthome', id: 'x' }, { userId: 9, plugin: 'gatecontrol-smarthome', id: 'x' },
        { userId: 2, plugin: 'actions-test', id: 'own' }, { userId: 2, plugin: 'Bad_Id', id: 'x' }, { userId: 2, plugin: 'gatecontrol-smarthome', id: 'bad id' }, { userId: 2, plugin: 'gatecontrol-smarthome', id: 'x', lang: 'fr' }]) {
        await assert.rejects(host.gc.actions.run(bad), { code: 'ERR_INVALID' }, JSON.stringify(bad));
      }
      await assert.rejects(host.gc.actions.list({ userId: 3 }), { code: 'ERR_INVALID' });
      assert.equal(host.actionRuns.length, 4);
      for (let i = 4; i < 60; i++) await host.gc.actions.run({ userId: 2, plugin: 'gatecontrol-smarthome', id: 'scene:evening' });
      await assert.rejects(host.gc.actions.run({ userId: 2, plugin: 'gatecontrol-smarthome', id: 'scene:evening' }), { code: 'ERR_RATE_LIMIT' });
    } finally {
      await host.close();
    }
    write({ users: true });
    const without = await createHost(tmp, { users, actions });
    try {
      await assert.rejects(without.gc.actions.list({ userId: 2 }), { code: 'ERR_ACTIONS_DENIED' });
      await assert.rejects(without.gc.actions.run({ userId: 2, plugin: 'gatecontrol-smarthome', id: 'scene:evening' }), { code: 'ERR_ACTIONS_DENIED' });
    } finally {
      await without.close();
    }
    write({ actions: 'yes' });
    await assert.rejects(createHost(tmp, { users }), { code: 'ERR_INVALID' });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('catalog keeps every version and picks the latest stable one', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-'));
  try {
    const entry = (version, prerelease) => ({ schema: 1, id: 'demo', name: { de: 'Demo', en: 'Demo' }, version, prerelease, sha256: 'a'.repeat(64), url: `https://x/${version}` });
    for (const [v, p] of [['1.0.0', false], ['1.2.0', false], ['2.0.0-rc.1', true]]) fs.writeFileSync(path.join(tmp, `demo-${v}.index.json`), JSON.stringify(entry(v, p)));
    execFileSync(process.execPath, [path.join(TOOLS, 'catalog.js'), tmp, '--out', path.join(tmp, 'catalog.json'), '--repo', 'o/r']);
    const c = JSON.parse(fs.readFileSync(path.join(tmp, 'catalog.json'), 'utf8'));
    assert.equal(c.schema, 1);
    assert.equal(c.plugins.demo.latest.version, '1.2.0');
    assert.deepEqual(c.plugins.demo.versions.map((v) => v.version), ['2.0.0-rc.1', '1.2.0', '1.0.0']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('pack → sign → verify round trip with a throwaway key', { skip: !gcDir && 'no GateControl checkout' }, () => {
  const signature = lib.gcRequire('src/services/plugins/signature');
  const kp = signature.generateKeyPair();
  const other = signature.generateKeyPair();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-'));
  const run = (args, env) => spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, ...env } });
  try {
    // dev builds are unsigned even when a key is in the environment
    let r = run([path.join(TOOLS, 'pack.js'), 'gatecontrol-hello', '--out', out], { GC_PLUGIN_SIGNING_KEY: kp.privateSeed });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /UNSIGNED/);
    const file = path.join(out, 'gatecontrol-hello-1.0.0.gcplugin');
    r = run([path.join(TOOLS, 'verify.js'), file], { GC_PLUGIN_PUBLIC_KEY: kp.publicKey });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /UNSIGNED/);

    // --sign without a key fails
    r = run([path.join(TOOLS, 'pack.js'), 'gatecontrol-hello', '--sign', '--out', out], { GC_PLUGIN_SIGNING_KEY: '' });
    assert.equal(r.status, 1);

    r = run([path.join(TOOLS, 'pack.js'), 'gatecontrol-hello', '--sign', '--out', out], { GC_PLUGIN_SIGNING_KEY: kp.privateSeed });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\(\d+ bytes, signed\)/);
    assert.ok(!r.stdout.includes(kp.privateSeed) && !r.stderr.includes(kp.privateSeed));

    // the package holds no test files
    const files = lib.gcRequire('src/services/plugins/package').decode(fs.readFileSync(file));
    assert.ok(files.has('signature') && files.has('ui/page.html') && files.has('migrations/001_init.sql'));
    assert.ok(![...files.keys()].some((p) => p.startsWith('test/')));

    r = run([path.join(TOOLS, 'verify.js'), file, '--id', 'gatecontrol-hello', '--version', '1.0.0'], { GC_PLUGIN_PUBLIC_KEY: kp.publicKey, GITHUB_OUTPUT: '' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp('key id ' + signature.keyId(kp.publicKey)));

    r = run([path.join(TOOLS, 'verify.js'), file], { GC_PLUGIN_PUBLIC_KEY: other.publicKey });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /different key/);
    r = run([path.join(TOOLS, 'verify.js'), file], { GC_PLUGIN_PUBLIC_KEY: '' });
    assert.equal(r.status, 1);
    r = run([path.join(TOOLS, 'verify.js'), file, '--version', '2.0.0'], { GC_PLUGIN_PUBLIC_KEY: kp.publicKey });
    assert.equal(r.status, 1);

    // index entry + sha256 file
    r = run([path.join(TOOLS, 'index-entry.js'), file, '--tag', 'gatecontrol-hello-v1.0.0', '--repo', 'o/r', '--key-id', signature.keyId(kp.publicKey), '--public-key', kp.publicKey]);
    assert.equal(r.status, 0, r.stderr);
    const entry = JSON.parse(fs.readFileSync(path.join(out, 'gatecontrol-hello-1.0.0.index.json'), 'utf8'));
    assert.equal(entry.size, fs.statSync(file).size);
    assert.equal(entry.url, 'https://github.com/o/r/releases/download/gatecontrol-hello-v1.0.0/gatecontrol-hello-1.0.0.gcplugin');
    assert.equal(entry.gatecontrol, '>=1.146.0');
    assert.equal(fs.readFileSync(file + '.sha256', 'utf8'), `${entry.sha256}  gatecontrol-hello-1.0.0.gcplugin\n`);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('--no-license: an unsigned dev build of a licensed plugin that a test server can install', { skip: !gcDir && 'no GateControl checkout' }, () => {
  const pkg = lib.gcRequire('src/services/plugins/package');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-'));
  const run = (args) => spawnSync(process.execPath, args, { encoding: 'utf8' });
  try {
    let r = run([path.join(TOOLS, 'pack.js'), 'gatecontrol-smarthome', '--no-license', '--out', out]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /gatecontrol-smarthome-\d+\.\d+\.\d+-dev\.gcplugin .*UNSIGNED/);
    const file = fs.readdirSync(out).find((f) => f.endsWith('-dev.gcplugin'));
    const files = pkg.decode(fs.readFileSync(path.join(out, file)));
    const manifest = JSON.parse(files.get('plugin.json').toString('utf8'));
    assert.deepEqual(manifest.license, { required: false });
    assert.equal(files.has('signature'), false);
    assert.equal(lib.readJson(path.join(lib.pluginDir('gatecontrol-smarthome'), 'plugin.json')).license.required, true, 'the source stays licensed');
    r = run([path.join(TOOLS, 'pack.js'), 'gatecontrol-smarthome', '--no-license', '--sign', '--out', out]);
    assert.notEqual(r.status, 0);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
