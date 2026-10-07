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
const { internetAllowed } = require('../testing/mock-host');

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
