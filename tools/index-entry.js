#!/usr/bin/env node
'use strict';

// Release metadata of a verified package:
//   node tools/index-entry.js <file.gcplugin> --tag <tag> --repo <owner/repo> --key-id <id> --public-key <b64>
// Writes next to the package:
//   <file>.sha256       "<hex>  <name>" (sha256sum format)
//   <id>-<version>.index.json  the catalog entry of this release (schema below)

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const lib = require('./lib');

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const file = args[0];
const tag = opt('--tag');
const repo = opt('--repo');
if (!file || !tag || !repo || !opt('--key-id') || !opt('--public-key')) {
  lib.fail('usage: node tools/index-entry.js <file.gcplugin> --tag <tag> --repo <owner/repo> --key-id <id> --public-key <b64>');
}

const buf = fs.readFileSync(file);
const files = lib.gcRequire('src/services/plugins/package').decode(buf);
const manifest = JSON.parse(files.get('plugin.json').toString('utf8'));
const t = lib.parseTag(tag);
if (!t || t.id !== manifest.id || t.version !== manifest.version) lib.fail(`tag ${tag} does not match package ${manifest.id} ${manifest.version}`);

const name = path.basename(file);
const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
const base = `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/`;
const entry = {
  schema: 1,
  id: manifest.id,
  name: manifest.name,
  description: manifest.description || null,
  publisher: manifest.publisher,
  version: manifest.version,
  prerelease: lib.parseSemver(manifest.version).pre.length > 0,
  gatecontrol: manifest.gatecontrol,
  license_required: !!(manifest.license && manifest.license.required),
  file: name,
  size: buf.length,
  sha256,
  url: base + encodeURIComponent(name),
  signature: { alg: 'Ed25519', key_id: opt('--key-id'), public_key: opt('--public-key') },
  tag,
  release_url: `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`,
  published_at: new Date().toISOString(),
};
const dir = path.dirname(file);
fs.writeFileSync(file + '.sha256', `${sha256}  ${name}\n`);
const indexFile = path.join(dir, `${manifest.id}-${manifest.version}.index.json`);
fs.writeFileSync(indexFile, JSON.stringify(entry, null, 2) + '\n');
process.stdout.write(`${path.basename(indexFile)}: sha256 ${sha256}, ${buf.length} bytes\n`);
