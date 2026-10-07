#!/usr/bin/env node
'use strict';

// Checks a release tag before anything is built:
//   node tools/release-check.js <id>-v<semver> [--notes <file>]
// * the tag names an existing plugin that is released (plugins.config.json)
// * the tag version equals plugin.json version
// * CHANGELOG.md has a section for that version (written to --notes)
// Outputs (GITHUB_OUTPUT): id, version, prerelease.

const fs = require('node:fs');
const path = require('node:path');
const lib = require('./lib');

const args = process.argv.slice(2);
const tag = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--notes');
const ni = args.indexOf('--notes');
if (!tag) lib.fail('usage: node tools/release-check.js <id>-v<semver> [--notes <file>]');

const t = lib.parseTag(tag);
if (!t) lib.fail(`tag "${tag}" is not <id>-v<semver> (e.g. gatecontrol-smarthome-v1.0.0)`);
let dir;
try { dir = lib.pluginDir(t.id); } catch (e) { lib.fail(`tag "${tag}": ${e.message}`); }
if (!lib.pluginConfig(t.id).release) lib.fail(`${t.id} is not released (plugins.config.json: release false)`);
const raw = lib.readJson(path.join(dir, 'plugin.json'));
if (raw.id !== t.id) lib.fail(`plugin.json id "${raw.id}" ≠ tag id "${t.id}"`);
if (raw.version !== t.version) lib.fail(`tag version ${t.version} ≠ plugin.json version ${raw.version}`);
const notes = lib.changelogSection(t.id, t.version);
if (notes == null) lib.fail(`plugins/${t.id}/CHANGELOG.md has no "## ${t.version}" section`);
if (!notes) lib.fail(`plugins/${t.id}/CHANGELOG.md: the "## ${t.version}" section is empty`);
if (ni >= 0) fs.writeFileSync(args[ni + 1], notes + '\n');
const prerelease = lib.parseSemver(t.version).pre.length > 0;
process.stderr.write(`release ${t.id} ${t.version}${prerelease ? ' (pre-release)' : ''}: OK\n`);
lib.setOutputs({ id: t.id, version: t.version, prerelease: String(prerelease) });
