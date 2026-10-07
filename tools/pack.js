#!/usr/bin/env node
'use strict';

// Build .gcplugin packages with GateControl's own packer (scripts/plugin-pack.js
// of the pinned checkout — see gatecontrol.ref; it is never copied here).
//
//   node tools/pack.js <id> [<id> ...] [--out dist]     unsigned dev build
//   node tools/pack.js --all [--out dist]               every plugin, unsigned
//   node tools/pack.js <id> --sign [--out dist]         signed (CI release only)
//
// Without --sign GC_PLUGIN_SIGNING_KEY is removed from the packer's
// environment, so a dev build is always unsigned. With --sign the key must be
// set and the packer must report a signed package. The key is never printed.

const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const lib = require('./lib');
const { stage } = require('./stage');

function packPlugin(id, { out, sign }) {
  const dir = lib.pluginDir(id);
  const raw = lib.readJson(path.join(dir, 'plugin.json'));
  const packer = path.join(lib.gatecontrolDir(), 'scripts', 'plugin-pack.js');
  const env = { ...process.env };
  if (sign) {
    if (!env.GC_PLUGIN_SIGNING_KEY || !env.GC_PLUGIN_SIGNING_KEY.trim()) throw new Error('--sign: GC_PLUGIN_SIGNING_KEY is not set');
  } else {
    delete env.GC_PLUGIN_SIGNING_KEY;
  }
  fs.mkdirSync(out, { recursive: true });
  const file = path.resolve(out, `${raw.id}-${raw.version}.gcplugin`);
  const st = stage(dir);
  try {
    const res = execFileSync(process.execPath, [packer, st.dir, '-o', file], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const signed = /\bsigned\)\s*$/.test(res.trim()) && !/UNSIGNED/.test(res);
    if (sign !== signed) throw new Error(`packer produced a${signed ? ' signed' : 'n unsigned'} package, expected ${sign ? 'signed' : 'unsigned'}`);
  } catch (e) {
    fs.rmSync(file, { force: true });
    const msg = e.stderr ? String(e.stderr).trim() : e.message;
    throw new Error(`${id}: ${msg}`);
  } finally {
    st.cleanup();
  }
  return { id: raw.id, version: raw.version, file, signed: sign, size: fs.statSync(file).size };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const oi = args.indexOf('--out');
  const out = path.resolve(oi >= 0 ? args[oi + 1] : path.join(lib.ROOT, 'dist'));
  const sign = args.includes('--sign');
  let ids = args.filter((a, i) => !a.startsWith('--') && (oi < 0 || i !== oi + 1));
  if (args.includes('--all')) ids = lib.listPlugins();
  if (!ids.length) lib.fail('usage: node tools/pack.js <id> [<id> ...] | --all [--out dist] [--sign]');
  if (sign && ids.length !== 1) lib.fail('--sign packs exactly one plugin');
  for (const id of ids) {
    try {
      const r = packPlugin(id, { out, sign });
      process.stdout.write(`${path.relative(process.cwd(), r.file)} (${r.size} bytes, ${r.signed ? 'signed' : 'UNSIGNED'})\n`);
    } catch (e) {
      lib.fail('pack: ' + e.message);
    }
  }
}

module.exports = { packPlugin };
