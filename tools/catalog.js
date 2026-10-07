#!/usr/bin/env node
'use strict';

// Build catalog.json from release index entries (*.index.json):
//   node tools/catalog.js <folder with *.index.json> --out catalog.json --repo <owner/repo>
//
// The catalogue is always rebuilt from the published releases — the
// releases are the source of truth, so a deleted release disappears and a
// broken catalogue is fixed by running the catalog workflow again.
//
// {
//   "schema": 1, "generated_at": "…", "repository": "owner/repo",
//   "plugins": {
//     "<id>": { "id", "name", "description", "publisher",
//               "latest": <entry of the highest non-pre-release version (or the highest one)>,
//               "versions": [<entries, newest first>] }
//   }
// }

const fs = require('node:fs');
const path = require('node:path');
const lib = require('./lib');

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const dir = args[0];
const out = opt('--out');
if (!dir || !out) lib.fail('usage: node tools/catalog.js <folder> --out catalog.json --repo <owner/repo>');

const byId = new Map();
for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.index.json')).sort()) {
  let e;
  try { e = lib.readJson(path.join(dir, f)); } catch (err) { lib.fail(`${f}: ${err.message}`); }
  if (!e || e.schema !== 1 || !lib.ID_RE.test(e.id || '') || !lib.parseSemver(e.version) || !/^[0-9a-f]{64}$/.test(e.sha256 || '') || !e.url) {
    lib.fail(`${f}: not a valid index entry`);
  }
  if (!byId.has(e.id)) byId.set(e.id, new Map());
  byId.get(e.id).set(e.version, e);
}

const plugins = {};
for (const id of [...byId.keys()].sort()) {
  const versions = [...byId.get(id).values()].sort((a, b) => lib.compareSemver(b.version, a.version));
  const latest = versions.find((v) => !v.prerelease) || versions[0];
  plugins[id] = { id, name: latest.name, description: latest.description, publisher: latest.publisher, latest, versions };
}
const catalog = { schema: 1, generated_at: new Date().toISOString(), repository: opt('--repo') || null, plugins };
fs.writeFileSync(out, JSON.stringify(catalog, null, 2) + '\n');
process.stdout.write(`${out}: ${Object.keys(plugins).length} plugin(s), ${[...byId.values()].reduce((n, m) => n + m.size, 0)} release(s)\n`);
