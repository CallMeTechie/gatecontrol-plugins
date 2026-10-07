'use strict';

// What of a plugin folder goes into its package: everything except the
// development-only top-level folders below and dot files (the packer skips
// those anyway). Symbolic links and special files are refused.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EXCLUDE_TOP = new Set(['test', 'tests', 'node_modules']);

/** Relative paths (with "/") of the files that are packed. */
function stagedFiles(dir) {
  const out = [];
  const walk = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      if (!rel && EXCLUDE_TOP.has(e.name)) continue;
      const r = rel ? rel + '/' + e.name : e.name;
      const a = path.join(abs, e.name);
      if (e.isSymbolicLink()) throw new Error('symbolic links are not allowed: ' + r);
      if (e.isDirectory()) walk(a, r);
      else if (e.isFile()) out.push(r);
      else throw new Error('not a regular file: ' + r);
    }
  };
  walk(path.resolve(dir), '');
  return out.sort();
}

/** Copy the packed files of `dir` into a fresh temporary folder; returns { dir, cleanup }. */
function stage(dir) {
  const files = stagedFiles(dir);
  const base = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'gcplugin-'));
  const target = path.join(base, 'plugin');
  for (const rel of files) {
    const to = path.join(target, ...rel.split('/'));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(dir, ...rel.split('/')), to);
  }
  return { dir: target, files, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

module.exports = { stagedFiles, stage, EXCLUDE_TOP };
