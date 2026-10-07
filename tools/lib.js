'use strict';

// Shared helpers of the repository tools (no dependencies).

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PLUGINS = path.join(ROOT, 'plugins');
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
// <id>-v<semver>, e.g. gatecontrol-smarthome-v1.0.0
const TAG_RE = /^([a-z0-9]+(?:-[a-z0-9]+)*)-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

function fail(msg) {
  process.stderr.write(msg.endsWith('\n') ? msg : msg + '\n');
  process.exit(1);
}

/** The pinned GateControl commit (gatecontrol.ref). */
function gatecontrolRef() {
  const ref = fs.readFileSync(path.join(ROOT, 'gatecontrol.ref'), 'utf8').trim();
  if (!/^[0-9a-f]{40}$/.test(ref)) throw new Error('gatecontrol.ref must hold a 40-character commit SHA');
  return ref;
}

/**
 * The GateControl checkout whose scripts/plugin-pack.js and services are used:
 * $GATECONTROL_DIR, else ./.gatecontrol (CI, tools/fetch-gatecontrol.sh), else ../gatecontrol.
 */
function gatecontrolDir() {
  const candidates = [process.env.GATECONTROL_DIR, path.join(ROOT, '.gatecontrol'), path.join(ROOT, '..', 'gatecontrol')].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'scripts', 'plugin-pack.js'))) return path.resolve(c);
  }
  throw new Error('no GateControl checkout found (set GATECONTROL_DIR, run tools/fetch-gatecontrol.sh, or clone it next to this repository)');
}

/** require() a module of the GateControl checkout, e.g. gcRequire('src/services/plugins/manifest'). */
function gcRequire(rel) {
  return require(path.join(gatecontrolDir(), rel));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function config() {
  const f = path.join(ROOT, 'plugins.config.json');
  const c = fs.existsSync(f) ? readJson(f) : {};
  return (c && c.plugins) || {};
}

/** Settings of one plugin from plugins.config.json (release defaults to true). */
function pluginConfig(id) {
  const c = config()[id] || {};
  return { release: c.release !== false, example: !!c.example };
}

/** Plugin ids = folders under plugins/ that hold a plugin.json. */
function listPlugins() {
  if (!fs.existsSync(PLUGINS)) return [];
  return fs.readdirSync(PLUGINS, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(PLUGINS, e.name, 'plugin.json')))
    .map((e) => e.name)
    .sort();
}

function pluginDir(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('invalid plugin id: ' + id);
  const dir = path.join(PLUGINS, id);
  if (!fs.existsSync(path.join(dir, 'plugin.json'))) throw new Error('unknown plugin: ' + id);
  return dir;
}

/** The section of CHANGELOG.md for `version` ("## 1.2.0", "## [1.2.0] - date", "## v1.2.0"), or null. */
function changelogSection(id, version) {
  const f = path.join(pluginDir(id), 'CHANGELOG.md');
  if (!fs.existsSync(f)) return null;
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
  const esc = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const head = new RegExp('^##\\s+\\[?v?' + esc + '\\]?(?:\\s|$)');
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join('\n').trim();
}

function parseSemver(v) {
  const m = SEMVER_RE.exec(String(v));
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] };
}

/** Semver precedence: <0, 0, >0. */
function compareSemver(a, b) {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) throw new Error('invalid version');
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] - y[k];
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && +p !== +q) return +p - +q;
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/** "gatecontrol-smarthome-v1.0.0" → { id, version } or null. */
function parseTag(tag) {
  const m = TAG_RE.exec(String(tag));
  if (!m || !parseSemver(m[2])) return null;
  return { id: m[1], version: m[2] };
}

/** Append key=value lines to $GITHUB_OUTPUT (or print them locally). */
function setOutputs(obj) {
  const lines = Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, lines);
  else process.stdout.write(lines);
}

module.exports = {
  ROOT, PLUGINS, ID_RE, SEMVER_RE, TAG_RE,
  fail, gatecontrolRef, gatecontrolDir, gcRequire, readJson, config, pluginConfig, listPlugins, pluginDir,
  changelogSection, parseSemver, compareSemver, parseTag, setOutputs,
};
