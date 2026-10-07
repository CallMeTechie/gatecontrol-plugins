#!/usr/bin/env node
'use strict';

// Run plugin tests (node:test) against the mock host (tools/testing/mock-host.js):
//   node tools/test.js [<id> ...]        default: every plugin + the tools' own tests

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const lib = require('./lib');

function testFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...testFiles(p));
    else if (e.isFile() && e.name.endsWith('.test.js')) out.push(p);
  }
  return out.sort();
}

const ids = process.argv.slice(2);
const files = [];
if (!ids.length) files.push(...testFiles(path.join(lib.ROOT, 'tools', 'test')));
for (const id of ids.length ? ids : lib.listPlugins()) {
  const f = testFiles(path.join(lib.pluginDir(id), 'test'));
  if (!f.length) lib.fail(`${id}: no test/*.test.js`);
  files.push(...f);
}
if (!files.length) lib.fail('no tests found');
const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...files.map((f) => path.relative(lib.ROOT, f))], { cwd: lib.ROOT, stdio: 'inherit' });
process.exit(r.status == null ? 1 : r.status);
