'use strict';

// The handbook of a plugin and its set-up notices (plugin.json `handbook` / `setupNotices`, GateControl ≥ 1.241.0 shows
// them on Einstellungen › Plugins › <Plugin>: tab „Handbuch“ and a banner „Handeln nötig“). Older hosts ignore both keys.
// Checked by tools/validate.js (every plugin) and tools/release-check.js (the released one); tools/pack.js refuses a
// package without the handbook files. No dependencies, no GateControl checkout needed.
//
// plugin.json:
//   "handbook": { "de": "HANDBUCH.md", "en": "HANDBOOK.md" }       required for every plugin of this repository
//     * paths relative to the plugin folder, packed with it, ending in .md, at most 256 KB each
//     * first line exactly `<!-- version: X.Y.Z -->` = plugin.json version (the handbook is touched with every release)
//     * a heading "Neu in X.Y.Z" (de) / "New in X.Y.Z" (en) for the current version
//     * Markdown subset of the host (GateControl's services/plugins/markdown.js): headings # … ### (anchor = slug of the
//       text: lower case, ä → ae, ö → oe, ü → ue, ß → ss, other accents dropped, everything else but a–z / 0–9 → "-",
//       at most 100 characters; or explicit `## Text {#anchor}` – the same anchor in both languages), paragraphs, lists, **bold**,
//       *italic*, `code`, code blocks, tables, `> **Hinweis:** …` blocks, links to https:// or to an anchor `#…` of the
//       same file. No raw HTML (no other `<!-- … -->` either), no pictures, no duplicate anchors.
//   "setupNotices": [ { id, since, title: { de, en }, text: { de, en }, handbook?, check } ]   optional, ≤ 20
//     * id `^[a-z0-9]+(-[a-z0-9]+)*$` ≤ 64, unique; since = a version ≤ plugin.json version (shown from that version on)
//     * title ≤ 120, text ≤ 1000 characters, both languages (the host's limits)
//     * handbook: an anchor – a string (the same anchor in both languages: give the headings an explicit `{#anchor}`)
//       or { de, en } (one per language; a missing one falls back to the other like on the host) – that exists in the
//       handbook of its language. Deep link of the host: /settings/plugins/manage/<id>?tab=handbook#<anchor>
//     * check: { type: 'manual' }
//              { type: 'gatewayService', feature, service }   feature of the gateway and its compose service – the host
//                                                             knows cameras → kameras, ai → ki, radio/zigbee → deconz;
//                                                             other features: the stored switch + telemetry "managed"
//              an unknown type counts as manual on the host; this repository refuses it (a typo)
//              { type: 'gatewayVersion', min, feature? }      every gateway (with that feature on) at least `min`
//              { type: 'hostVersion', min }                   GateControl at least `min`

const fs = require('node:fs');
const path = require('node:path');

const LANGS = ['de', 'en'];
const MAX_BYTES = 256 * 1024;
const VERSION_LINE = /^<!-- version: (\S+) -->$/;
const ANCHOR_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
const NOTICE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FEATURE_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const SERVICE_RE = FEATURE_RE;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const NOTICES_MAX = 20;
const CHECKS = {
  manual: [],
  gatewayService: ['feature', 'service'],
  gatewayVersion: ['min', 'feature'],
  hostVersion: ['min'],
};
const NEW_IN = { de: 'Neu in', en: 'New in' };

/** Anchor of a heading text (the host's slug). */
function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
    .replace(/-+$/, '');
}

/** The plain text of a heading, like the host (links → their text, escapes, no ` and *, no _ at word edges). */
function plainText(s) {
  return String(s)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\\(.)/g, '$1')
    .replace(/[`*]/g, '')
    .replace(/(^|\s)_+|_+(\s|$)/g, '$1$2')
    .trim();
}

/** Headings of a handbook (outside code blocks) → [{ level, text, anchor, line }]. */
function headings(md) {
  const out = [];
  let fence = null;
  md.split(/\r?\n/).forEach((l, i) => {
    const f = /^\s*(`{3,}|~{3,})/.exec(l);
    if (f) { if (!fence) fence = f[1][0]; else if (f[1][0] === fence) fence = null; return; }
    if (fence) return;
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l);
    if (!h) return;
    let text = h[2];
    let anchor = null;
    const ex = /\s*\{#([^}\s]*)\}$/.exec(text);
    if (ex) { anchor = ex[1]; text = text.slice(0, ex.index); }
    const plain = plainText(text);
    out.push({ level: h[1].length, text: plain, anchor: anchor == null ? slug(plain) : anchor, explicit: anchor != null, line: i + 1 });
  });
  return out;
}

/** Errors of one handbook file's text (`lang` for the "Neu in" heading, `version` of plugin.json). */
function checkText(md, { version, lang, file }) {
  const errors = [];
  const e = (msg) => errors.push(`${file}: ${msg}`);
  const lines = md.split(/\r?\n/);
  const m = VERSION_LINE.exec(lines[0] || '');
  if (!m) e('first line must be "<!-- version: ' + version + ' -->"');
  else if (m[1] !== version) e(`version ${m[1]} ≠ plugin.json version ${version} (update the handbook with every release)`);
  const hs = headings(md);
  if (!hs.length) e('no heading');
  const seen = new Set();
  for (const h of hs) {
    if (h.level > 3) e(`line ${h.line}: only headings # … ### are shown`);
    if (!ANCHOR_RE.test(h.anchor)) e(`line ${h.line}: heading without a usable anchor`);
    else if (seen.has(h.anchor)) e(`line ${h.line}: anchor "${h.anchor}" twice (give one an explicit {#anchor})`);
    seen.add(h.anchor);
  }
  const want = `${NEW_IN[lang]} ${version}`;
  if (!hs.some((h) => h.text.trim() === want)) e(`no heading "${want}"`);
  let fence = null;
  lines.forEach((l, i) => {
    if (i === 0) return;
    const f = /^\s*(`{3,}|~{3,})/.exec(l);
    if (f) { if (!fence) fence = f[1][0]; else if (f[1][0] === fence) fence = null; return; }
    if (fence) return;
    const text = l.replace(/`[^`]*`/g, '``'); // inline code may show anything
    if (/<!--/.test(text) || /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/.test(text)) e(`line ${i + 1}: raw HTML is not shown`);
    if (/!\[[^\]]*\]\(/.test(text)) e(`line ${i + 1}: no pictures`);
    for (const lk of text.matchAll(/\[[^\]]*\]\(([^)\s]*)(?:\s+"[^"]*")?\)/g)) {
      const url = lk[1];
      if (url.startsWith('#')) { if (!seen.has(url.slice(1))) e(`line ${i + 1}: link to unknown anchor ${url}`); } else if (!/^https:\/\/[^\s/]+/.test(url)) e(`line ${i + 1}: links only to https:// or #anchor (${url || 'empty'})`);
    }
  });
  if (fence) e('code block not closed');
  return errors;
}

const isLoc = (v, max) => !!(v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === LANGS.length
  && LANGS.every((l) => typeof v[l] === 'string' && v[l].trim() && v[l].length <= max));

function semverCmp(a, b) {
  const pa = a.split(/[.-]/).slice(0, 3).map(Number);
  const pb = b.split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/** Errors of plugin.json `setupNotices` (`anchors`: { de: Set, en: Set } of the handbooks, or null when they are broken). */
function checkNotices(raw, anchors) {
  const v = raw.setupNotices;
  if (v === undefined) return [];
  const errors = [];
  const e = (msg) => errors.push('setupNotices: ' + msg);
  if (!Array.isArray(v) || v.length > NOTICES_MAX) return ['setupNotices: an array of at most ' + NOTICES_MAX];
  const ids = new Set();
  v.forEach((n, i) => {
    const at = n && typeof n.id === 'string' ? n.id : `#${i}`;
    if (!n || typeof n !== 'object' || Array.isArray(n)) { e(`${at}: not an object`); return; }
    const extra = Object.keys(n).filter((k) => !['id', 'since', 'title', 'text', 'handbook', 'check'].includes(k));
    if (extra.length) e(`${at}: unknown key ${extra.join(', ')}`);
    if (typeof n.id !== 'string' || n.id.length > 64 || !NOTICE_ID_RE.test(n.id)) e(`${at}: invalid id`);
    else if (ids.has(n.id)) e(`${at}: id twice`);
    ids.add(n.id);
    if (typeof n.since !== 'string' || !SEMVER_RE.test(n.since)) e(`${at}: invalid since`);
    else if (typeof raw.version === 'string' && SEMVER_RE.test(raw.version) && semverCmp(n.since, raw.version) > 0) e(`${at}: since ${n.since} is newer than the plugin (${raw.version})`);
    if (!isLoc(n.title, 120)) e(`${at}: title must be { de, en }, each 1 … 120 characters`);
    if (!isLoc(n.text, 1000)) e(`${at}: text must be { de, en }, each 1 … 1000 characters`);
    if (n.handbook !== undefined) {
      const h = n.handbook;
      const ok = (x) => typeof x === 'string' && ANCHOR_RE.test(x);
      let per = null;
      if (ok(h)) per = { de: h, en: h };
      else if (h && typeof h === 'object' && !Array.isArray(h) && Object.keys(h).length && Object.keys(h).every((k) => LANGS.includes(k) && ok(h[k]))) per = { de: h.de || h.en, en: h.en || h.de };
      if (!per) e(`${at}: handbook must be an anchor or { de, en } of anchors`);
      else if (anchors) for (const l of LANGS) if (!anchors[l].has(per[l])) e(`${at}: anchor "${per[l]}" is not in the ${l} handbook`);
    }
    const c = n.check;
    if (!c || typeof c !== 'object' || Array.isArray(c) || !Object.prototype.hasOwnProperty.call(CHECKS, c.type)) { e(`${at}: check.type must be one of ${Object.keys(CHECKS).join(', ')}`); return; }
    const bad = Object.keys(c).filter((k) => k !== 'type' && !CHECKS[c.type].includes(k));
    if (bad.length) e(`${at}: check ${c.type}: unknown key ${bad.join(', ')}`);
    if (c.type === 'gatewayService') {
      if (typeof c.feature !== 'string' || !FEATURE_RE.test(c.feature)) e(`${at}: check gatewayService: invalid feature`);
      if (typeof c.service !== 'string' || !SERVICE_RE.test(c.service)) e(`${at}: check gatewayService: invalid service`);
    }
    if (c.type === 'gatewayVersion' || c.type === 'hostVersion') {
      if (typeof c.min !== 'string' || !SEMVER_RE.test(c.min)) e(`${at}: check ${c.type}: invalid min`);
    }
    if (c.type === 'gatewayVersion' && c.feature !== undefined && (typeof c.feature !== 'string' || !FEATURE_RE.test(c.feature))) e(`${at}: check gatewayVersion: invalid feature`);
  });
  return errors;
}

/**
 * Errors of a plugin's handbook and set-up notices. `dir` = the plugin folder, `raw` = its plugin.json, `files` = the
 * packed files (tools/stage.js stagedFiles) or null to look at the folder only.
 */
function check(dir, raw, files = null) {
  const errors = [];
  const hb = raw.handbook;
  let anchors = { de: new Set(), en: new Set() };
  if (!hb || typeof hb !== 'object' || Array.isArray(hb) || Object.keys(hb).length !== 2 || !LANGS.every((l) => typeof hb[l] === 'string')) {
    errors.push('handbook: plugin.json needs "handbook": { "de": "HANDBUCH.md", "en": "HANDBOOK.md" }');
    anchors = null;
  } else {
    for (const l of LANGS) {
      const p = hb[l];
      if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.md$/.test(p) || p.split('/').some((s) => s === '..' || s === '.')) { errors.push(`handbook.${l}: invalid path ${p}`); anchors = null; continue; }
      const abs = path.join(dir, ...p.split('/'));
      if (!fs.existsSync(abs) || (files && !files.includes(p))) { errors.push(`handbook.${l}: ${p} missing (or not packed)`); anchors = null; continue; }
      const buf = fs.readFileSync(abs);
      if (buf.length > MAX_BYTES) errors.push(`handbook.${l}: ${p} larger than ${MAX_BYTES / 1024} KB`);
      const md = buf.toString('utf8');
      if (md.includes('�')) errors.push(`handbook.${l}: ${p} is not UTF-8`);
      const errs = checkText(md, { version: raw.version, lang: l, file: p });
      errors.push(...errs.map((x) => 'handbook: ' + x));
      if (anchors) anchors[l] = new Set(headings(md).map((h) => h.anchor));
    }
    if (hb.de === hb.en) errors.push('handbook: de and en must be two files');
  }
  errors.push(...checkNotices(raw, anchors));
  return errors;
}

/** The files of the handbook a package must contain (for tools/pack.js). */
function files(raw) {
  const hb = raw && raw.handbook;
  return hb && typeof hb === 'object' ? LANGS.map((l) => hb[l]).filter((p) => typeof p === 'string') : [];
}

module.exports = { check, checkText, checkNotices, headings, slug, files, LANGS, CHECKS };
