#!/usr/bin/env node
'use strict';

// Validate plugins: node tools/validate.js [<id> ...]   (default: every plugin + catalog-meta.json)
//
// plugin.json is checked with GateControl's own validator (src/services/plugins/
// manifest.js of the pinned checkout — the exact rules of docs/plugins.md, the
// same code that checks an upload), plus the repository rules:
//   * folder name = plugin.json id
//   * every file path is valid inside a package (package.js checkPath)
//   * migrations are named <number>_<name>.sql, numbers unique
//   * CHANGELOG.md has a section for the current version
//   * the plugin has tests (test/*.test.js)
// A plugin that needs a newer GateControl than the pinned one (its "gatecontrol" range starts above it — built for a
// version that is not released yet) is checked by the pinned validator without the keys that version brought
// (NEWER_KEYS, checked here by the rules of docs/plugins.md instead); bump gatecontrol.ref once it is released.
// Without ids, catalog-meta.json (store metadata of catalog.json) is checked
// too (tools/catalog-meta.js).

const fs = require('node:fs');
const path = require('node:path');
const lib = require('./lib');
const { stagedFiles } = require('./stage');
const catalogMeta = require('./catalog-meta');

// Keys of newer GateControl versions the pinned validator may not know: version → [{ path, check(value) → error | null,
// replace?(value) → what the pinned validator checks instead (else the key is left out) }].
// `path`: keys from the manifest root; '*' = every key of that object.
const isPurpose = (p) => !!(p && typeof p === 'object' && !Array.isArray(p) && ['de', 'en'].some((l) => typeof p[l] === 'string' && p[l].trim())
  && Object.values(p).every((v) => typeof v === 'string' && v.length <= 200));
const NEWER_KEYS = {
  '1.216.0': [
    // permissions.mail { purpose: { de, en }, maxConnections?: 1 … 200 } (gc.mail)
    { path: ['permissions', 'mail'], check: (v) => (v && typeof v === 'object' && !Array.isArray(v) && isPurpose(v.purpose)
      && Object.keys(v).every((k) => k === 'purpose' || k === 'maxConnections')
      && (v.maxConnections === undefined || (Number.isInteger(v.maxConnections) && v.maxConnections >= 1 && v.maxConnections <= 200)) ? null : 'permissions.mail: invalid') },
    // permissions.network.images: true (gc.http.fetchImage)
    { path: ['permissions', 'network', 'images'], check: (v) => (typeof v === 'boolean' ? null : 'permissions.network: invalid images') },
    // services.provides.<name>.maxPerHour: 60 … 3600
    { path: ['services', 'provides', '*', 'maxPerHour'], check: (v) => (Number.isInteger(v) && v >= 60 && v <= 3600 ? null : 'services.provides: invalid maxPerHour') },
  ],
  '1.219.0': [
    // permissions.mail.dav { purpose: { de, en } } (gc.mail.dav — CalDAV/CardDAV)
    { path: ['permissions', 'mail', 'dav'], check: (v) => (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every((k) => k === 'purpose') && isPurpose(v.purpose) ? null : 'permissions.mail.dav: invalid') },
    // permissions.notify { perHour: 1 … 1000 } (before: 120) — checked here, the pinned validator sees at most 120
    { path: ['permissions', 'notify'], replace: (v) => (v && typeof v === 'object' ? { perHour: Math.min(v.perHour, 120) } : v), check: (v) => (v === true || v === false || (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && Number.isInteger(v.perHour) && v.perHour >= 1 && v.perHour <= 1000) ? null : 'permissions.notify: invalid') },
  ],
};

/** A copy of `raw` without the keys of versions newer than the pinned one, the repository's own errors for them, the keys. */
function withoutNewerKeys(raw, pinned) {
  const copy = JSON.parse(JSON.stringify(raw));
  const errors = [];
  const removed = [];
  for (const [version, keys] of Object.entries(NEWER_KEYS)) {
    if (lib.compareSemver(version, pinned) <= 0) continue;
    for (const k of keys) {
      const walk = (obj, i, trail) => {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
        const seg = k.path[i];
        const names = seg === '*' ? Object.keys(obj) : [seg];
        for (const name of names) {
          if (!Object.prototype.hasOwnProperty.call(obj, name)) continue;
          if (i < k.path.length - 1) { walk(obj[name], i + 1, [...trail, name]); continue; }
          const err = k.check(obj[name]);
          if (err) errors.push(err);
          removed.push([...trail, name].join('.') + ` (${version})`);
          // `replace`: a value the pinned validator knows instead of none (a key others depend on)
          if (k.replace && !err) obj[name] = k.replace(obj[name]); else delete obj[name];
        }
      };
      walk(copy, 0, []);
    }
  }
  return { copy, errors, removed };
}

function validatePlugin(id, notes = []) {
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
    // built for a GateControl newer than the pinned one: without the keys the pinned validator cannot know
    const newer = lib.needsNewerHost(raw);
    let checked = raw;
    if (newer) {
      const w = withoutNewerKeys(raw, lib.gatecontrolVersion());
      checked = w.copy;
      for (const e of w.errors) errors.push('plugin.json: ' + e);
      notes.push(`needs GateControl ${newer}, pinned is ${lib.gatecontrolVersion()}: checked without ${w.removed.length ? w.removed.join(', ') : 'nothing'}; not packed until gatecontrol.ref is bumped`);
    }
    const res = manifest.validate(checked, { files: new Set(files) });
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
  const all = !process.argv.slice(2).length;
  const ids = all ? lib.listPlugins() : process.argv.slice(2);
  if (!ids.length) lib.fail('no plugins found');
  let bad = 0;
  for (const id of ids) {
    let errors;
    const notes = [];
    try { errors = validatePlugin(id, notes); } catch (e) { errors = [e.message]; }
    for (const n of notes) process.stdout.write(process.env.GITHUB_ACTIONS ? `::notice file=plugins/${id}/plugin.json::${id}: ${n}\n` : `ℹ ${id}: ${n}\n`);
    if (errors.length) {
      bad++;
      for (const e of errors) {
        process.stdout.write(process.env.GITHUB_ACTIONS ? `::error file=plugins/${id}/plugin.json::${id}: ${e}\n` : `✗ ${id}: ${e}\n`);
      }
    } else {
      process.stdout.write(`✓ ${id}\n`);
    }
  }
  if (all && !catalogMeta.check()) bad++;
  if (bad) process.exit(1);
}

module.exports = { validatePlugin, withoutNewerKeys, NEWER_KEYS };
