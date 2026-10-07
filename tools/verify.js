#!/usr/bin/env node
'use strict';

// Verify a built package with GateControl's own reader and signature check.
//
//   GC_PLUGIN_PUBLIC_KEY=<base64 raw 32> node tools/verify.js <file.gcplugin> [--id <id>] [--version <v>]
//
// Fails unless the package decodes, its plugin.json is valid (and has the
// expected id/version), and it carries a valid signature by exactly that
// public key. Prints the key id (first 16 hex of sha256 of the raw key).

const fs = require('node:fs');
const lib = require('./lib');

function verifyPackage(file, { publicKey, id, version }) {
  if (!publicKey || !/^[A-Za-z0-9+/]{43}=$/.test(publicKey.trim())) throw new Error('GC_PLUGIN_PUBLIC_KEY missing or not a base64 32-byte Ed25519 public key');
  const pub = publicKey.trim();
  const pkg = lib.gcRequire('src/services/plugins/package');
  const signature = lib.gcRequire('src/services/plugins/signature');
  const manifest = lib.gcRequire('src/services/plugins/manifest');

  const files = pkg.decode(fs.readFileSync(file));
  const pj = files.get('plugin.json');
  if (!pj) throw new Error('plugin.json missing in package');
  const res = manifest.validate(JSON.parse(pj.toString('utf8')), { files: new Set(files.keys()) });
  if (!res.ok) throw new Error('plugin.json invalid: ' + res.errors.join(', '));
  if (id && res.manifest.id !== id) throw new Error(`package id ${res.manifest.id} ≠ ${id}`);
  if (version && res.manifest.version !== version) throw new Error(`package version ${res.manifest.version} ≠ ${version}`);

  const prev = process.env.GC_PLUGIN_PUBKEYS;
  process.env.GC_PLUGIN_PUBKEYS = JSON.stringify([pub]);
  let v;
  try { v = signature.verify(files); } finally {
    if (prev === undefined) delete process.env.GC_PLUGIN_PUBKEYS; else process.env.GC_PLUGIN_PUBKEYS = prev;
  }
  if (v.status === 'none') throw new Error('package is UNSIGNED');
  if (v.status === 'invalid') throw new Error('signature does not verify');
  if (v.status !== 'trusted' || v.publicKey !== pub) throw new Error(`signed by a different key (key id ${v.keyId}), expected ${signature.keyId(pub)}`);
  return { manifest: res.manifest, publicKey: v.publicKey, keyId: v.keyId };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const file = args.find((a, i) => !a.startsWith('--') && !['--id', '--version'].includes(args[i - 1]));
  if (!file) lib.fail('usage: GC_PLUGIN_PUBLIC_KEY=… node tools/verify.js <file.gcplugin> [--id <id>] [--version <v>]');
  try {
    const r = verifyPackage(file, { publicKey: process.env.GC_PLUGIN_PUBLIC_KEY, id: opt('--id'), version: opt('--version') });
    process.stdout.write(`${file}: signature OK (${r.manifest.id} ${r.manifest.version}, key id ${r.keyId})\n`);
    lib.setOutputs({ key_id: r.keyId });
  } catch (e) {
    lib.fail(`verify: ${file}: ${e.message}`);
  }
}

module.exports = { verifyPackage };
