// Bundles entry.mjs into ui/vendor/noble.js (one minified IIFE, window.VaultNoble) — run by build.sh inside a
// temporary folder with the packages of package-lock.json installed (npm ci).
//
// One patch: @noble/hashes 1.8.0 yields inside argon2idAsync with `nextTick = async () => {}` — a microtask, so the
// browser gets no chance to repaint, handle input or run timers while Argon2id runs (the frame freezes, the progress
// bar stands still, the auto-lock timer waits). The patch makes nextTick a macrotask: a MessageChannel message (no
// 4 ms clamp, not throttled in a hidden tab), and every 5th time setTimeout(0) — a loop that only posts messages can
// keep timers waiting in some engines (Node drains a port's messages in one go). The build fails if the expected
// source line is not found (another version of the package).
import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';

const out = process.argv[2];
const banner = fs.readFileSync(process.argv[3], 'utf8');
const ORIGINAL = 'export const nextTick = async () => { };';
const PATCHED = 'let yields = 0; export const nextTick = () => new Promise((resolve) => { if (typeof MessageChannel === "function" && ++yields % 5 !== 0) { const c = new MessageChannel(); c.port1.onmessage = () => { c.port1.close(); resolve(); }; c.port2.postMessage(0); } else setTimeout(resolve, 0); });';
let patched = 0;

const yieldToBrowser = {
  name: 'noble-next-tick',
  setup(build) {
    build.onLoad({ filter: /[\\/]@noble[\\/]hashes[\\/]esm[\\/]utils\.js$/ }, (args) => {
      const src = fs.readFileSync(args.path, 'utf8');
      if (src.split(ORIGINAL).length !== 2) throw new Error('nextTick of @noble/hashes not found: ' + args.path);
      patched++;
      return { contents: src.replace(ORIGINAL, PATCHED), loader: 'js', resolveDir: path.dirname(args.path) };
    });
  },
};

const res = await esbuild.build({
  entryPoints: ['entry.mjs'], bundle: true, minify: true, format: 'iife', globalName: 'VaultNoble', target: 'es2020',
  legalComments: 'none', charset: 'ascii', write: false, logLevel: 'warning', plugins: [yieldToBrowser],
});
if (patched !== 1) throw new Error('nextTick patched ' + patched + ' times');
fs.writeFileSync(out, banner + res.outputFiles[0].text);
console.log('wrote ' + out + ' (' + fs.statSync(out).size + ' bytes)');
