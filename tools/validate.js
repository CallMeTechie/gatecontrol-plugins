#!/usr/bin/env node
'use strict';

// Validate plugins: node tools/validate.js [<id> ...]   (default: every plugin)
//
// plugin.json is checked with GateControl's own validator (src/services/plugins/
// manifest.js of the pinned checkout — the exact rules of docs/plugins.md, the
// same code that checks an upload), plus the repository rules:
//   * folder name = plugin.json id
//   * every file path is valid inside a package (package.js checkPath)
//   * migrations are named <number>_<name>.sql, numbers unique
//   * CHANGELOG.md has a section for the current version
//   * the plugin has tests (test/*.test.js)

const fs = require('node:fs');
const path = require('node:path');
const lib = require('./lib');
const { stagedFiles } = require('./stage');

function validatePlugin(id) {
  const errors = [];
  const dir = lib.pluginDir(id);
  let raw;
  try { raw = lib.readJson(path.join(dir, 'plugin.json')); } catch (e) { return ['plugin.json: ' + e.message]; }
  if (raw.id !== id) errors.push(`plugin.json: id "${raw.id}" does not match folder "${id}"`);

  let files;
  try { files = stagedFiles(dir); } catch (e) { errors.push('files: ' + e.message); }
  if (files) {
    const pkg = lib.gcRequire('src/services/plugins/package');
    for (const p of files) {
      try { pkg.checkPath(p); } catch (e) { errors.push(`files: ${p}: ${e.message}`); }
    }
    const manifest = lib.gcRequire('src/services/plugins/manifest');
    const res = manifest.validate(raw, { files: new Set(files) });
    for (const e of res.errors) errors.push('plugin.json: ' + e);
    if (res.ok) {
      const mdir = res.manifest.migrations.replace(/\/+$/, '') + '/';
      const seen = new Set();
      for (const p of files) {
        if (!p.startsWith(mdir)) continue;
        const m = /^(\d{1,6})_([A-Za-z0-9_-]{1,80})\.sql$/.exec(p.slice(mdir.length));
        if (!m) { errors.push(`migrations: ${p}: not <number>_<name>.sql (would be ignored)`); continue; }
        if (seen.has(+m[1])) errors.push(`migrations: duplicate number ${m[1]}`);
        seen.add(+m[1]);
      }
    }
  }

  if (typeof raw.version === 'string' && lib.changelogSection(id, raw.version) == null) {
    errors.push(`CHANGELOG.md: no "## ${raw.version}" section`);
  }
  const testDir = path.join(dir, 'test');
  if (!fs.existsSync(testDir) || !fs.readdirSync(testDir).some((f) => f.endsWith('.test.js'))) {
    errors.push('test: no test/*.test.js');
  }
  return errors;
}

if (require.main === module) {
  const ids = process.argv.slice(2).length ? process.argv.slice(2) : lib.listPlugins();
  if (!ids.length) lib.fail('no plugins found');
  let bad = 0;
  for (const id of ids) {
    let errors;
    try { errors = validatePlugin(id); } catch (e) { errors = [e.message]; }
    if (errors.length) {
      bad++;
      for (const e of errors) {
        process.stdout.write(process.env.GITHUB_ACTIONS ? `::error file=plugins/${id}/plugin.json::${id}: ${e}\n` : `✗ ${id}: ${e}\n`);
      }
    } else {
      process.stdout.write(`✓ ${id}\n`);
    }
  }
  if (bad) process.exit(1);
}

module.exports = { validatePlugin };
