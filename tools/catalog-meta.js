#!/usr/bin/env node
'use strict';

// Store metadata of the catalogue (catalog-meta.json in the repository root):
//   node tools/catalog-meta.js            validate it (also run by tools/validate.js without ids)
//
// Optional per released plugin id; tools/catalog.js copies the fields below
// into that plugin's object in catalog.json. GateControl ignores unknown or
// invalid values, this check is strict so mistakes never reach the store:
//   category   family | home | work | mobility | infrastructure | other
//   icon       family | chat | calendar | door | bulb | snowflake | car | server | nas | puzzle | cloud (GateControl ≥ 1.206)
//   summary    { de, en }  one sentence each, ≤ 160 characters
//   audience   all | admins
//   keywords   ≤ 12 lowercase search words (German and English), each ≤ 32 characters
//   related    ≤ 4 other released plugin ids ("passt gut dazu")
//   highlight  { version, title: { de, en } ≤ 80, text: { de, en } ≤ 280, tags? }; version has a CHANGELOG section
//              tags: ≤ 4 chips beside the highlight, { icon, text: { de, en } ≤ 40 }
// Detail page of the store:
//   adds         ≤ 8 × { icon, title: { de, en } ≤ 80, text: { de, en } ≤ 120 }  "Was <Plugin> hinzufügt"
//   permissions  ≤ 10 × { icon, title: { de, en } ≤ 80, text: { de, en } ≤ 200, tag?: { de, en } ≤ 24 }
//                "Das darf das Plugin" – tag only on sensitive ones (Netzwerk, Steuern, Standort, Benutzer …)
//   shows        ≤ 3 × { kind: tile | list | widget, caption: { de, en } ≤ 60, value?: string ≤ 12 }
//                captions of the wireframes "So sieht es bei dir aus"
//   needs        { de, en } ≤ 80  what it needs besides GateControl (an account, a token, a device)
//   languages    non-empty subset of de, en
// icon of adds, permissions and highlight tags: one of DETAIL_ICONS below.

const fs = require('node:fs');
const path = require('node:path');
const lib = require('./lib');

const FILE = path.join(__dirname, '..', 'catalog-meta.json');
const FIELDS = ['category', 'icon', 'summary', 'audience', 'keywords', 'related', 'highlight', 'adds', 'permissions', 'shows', 'needs', 'languages'];
const CATEGORIES = ['family', 'home', 'work', 'mobility', 'infrastructure', 'other'];
const ICONS = ['family', 'chat', 'calendar', 'door', 'bulb', 'snowflake', 'car', 'server', 'nas', 'puzzle', 'cloud'];
const AUDIENCES = ['all', 'admins'];
const LANGS = ['de', 'en'];
const DETAIL_ICONS = ['page', 'app', 'portal', 'widget', 'tile', 'action', 'bell', 'clock', 'data', 'network', 'chat', 'key',
  'location', 'users', 'door', 'calendar', 'camera', 'car', 'bulb', 'server', 'shield', 'link', 'cloud'];
const SHOW_KINDS = ['tile', 'list', 'widget'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** catalog-meta.json → its "plugins" object; {} when the file is missing. Throws on unreadable JSON. */
function readMeta(file = FILE) {
  if (!fs.existsSync(file)) return {};
  const m = lib.readJson(file);
  return isObj(m) && isObj(m.plugins) ? m.plugins : {};
}

/** The catalogue fields of one plugin's meta (only the known ones that are present). */
function pick(meta) {
  const out = {};
  if (!isObj(meta)) return out;
  for (const k of FIELDS) if (meta[k] !== undefined) out[k] = meta[k];
  return out;
}

/**
 * Errors of a parsed catalog-meta.json.
 *   ids:       released plugin ids (default: plugins/ minus release: false)
 *   changelog: (id, version) → true when CHANGELOG.md has that section
 */
function validateMeta(raw, { ids, changelog } = {}) {
  ids = new Set(ids || lib.listPlugins().filter((id) => lib.pluginConfig(id).release));
  changelog = changelog || ((id, v) => lib.changelogSection(id, v) != null);
  const errors = [];
  if (!isObj(raw)) return ['not a JSON object'];
  for (const k of Object.keys(raw)) if (!['$comment', 'plugins'].includes(k)) errors.push(`unknown key "${k}"`);
  if (raw.$comment !== undefined && typeof raw.$comment !== 'string') errors.push('$comment: not a string');
  if (!isObj(raw.plugins)) return [...errors, 'plugins: not an object'];

  const text = (where, v, max) => {
    if (!isObj(v)) { errors.push(`${where}: not an object with de and en`); return; }
    for (const k of Object.keys(v)) if (!LANGS.includes(k)) errors.push(`${where}: unknown language "${k}"`);
    for (const l of LANGS) {
      const s = v[l];
      if (typeof s !== 'string' || !s.trim()) errors.push(`${where}.${l}: missing`);
      else if (s !== s.trim()) errors.push(`${where}.${l}: leading or trailing whitespace`);
      else if (s.length > max) errors.push(`${where}.${l}: ${s.length} characters (max ${max})`);
    }
  };
  const oneOf = (where, v, list) => {
    if (!list.includes(v)) errors.push(`${where}: "${v}" is not one of ${list.join(', ')}`);
  };
  // array of objects with the given keys (optional ones end in "?"), each checked by `item`
  const rows = (where, v, max, keys, item) => {
    if (!Array.isArray(v)) { errors.push(`${where}: not an array`); return; }
    if (!v.length) errors.push(`${where}: empty (leave it out instead)`);
    if (v.length > max) errors.push(`${where}: ${v.length} (max ${max})`);
    const known = keys.map((k) => k.replace(/\?$/, ''));
    v.forEach((x, i) => {
      const w = `${where}[${i}]`;
      if (!isObj(x)) { errors.push(`${w}: not an object`); return; }
      for (const k of Object.keys(x)) if (!known.includes(k)) errors.push(`${w}: unknown key "${k}"`);
      item(w, x);
    });
  };
  const iconText = (titleMax, textMax) => (w, x) => {
    oneOf(`${w}.icon`, x.icon, DETAIL_ICONS);
    text(`${w}.title`, x.title, titleMax);
    text(`${w}.text`, x.text, textMax);
  };

  for (const [id, m] of Object.entries(raw.plugins)) {
    const at = (k) => `${id}: ${k}`;
    if (!ids.has(id)) errors.push(`${id}: not a released plugin of this repository`);
    if (!isObj(m)) { errors.push(`${id}: not an object`); continue; }
    for (const k of Object.keys(m)) if (!FIELDS.includes(k)) errors.push(at(`unknown key "${k}"`));
    if (m.category !== undefined) oneOf(at('category'), m.category, CATEGORIES);
    if (m.icon !== undefined) oneOf(at('icon'), m.icon, ICONS);
    if (m.audience !== undefined) oneOf(at('audience'), m.audience, AUDIENCES);
    if (m.summary !== undefined) text(at('summary'), m.summary, 160);
    if (m.keywords !== undefined) {
      if (!Array.isArray(m.keywords)) errors.push(at('keywords: not an array'));
      else {
        if (m.keywords.length > 12) errors.push(at(`keywords: ${m.keywords.length} (max 12)`));
        for (const w of m.keywords) {
          if (typeof w !== 'string' || !w.trim() || w !== w.trim()) errors.push(at(`keywords: invalid "${w}"`));
          else if (w.length > 32) errors.push(at(`keywords: "${w}" longer than 32 characters`));
          else if (w !== w.toLowerCase()) errors.push(at(`keywords: "${w}" not lowercase`));
        }
        if (new Set(m.keywords).size !== m.keywords.length) errors.push(at('keywords: duplicates'));
      }
    }
    if (m.related !== undefined) {
      if (!Array.isArray(m.related)) errors.push(at('related: not an array'));
      else {
        if (m.related.length > 4) errors.push(at(`related: ${m.related.length} (max 4)`));
        for (const r of m.related) {
          if (r === id) errors.push(at('related: names itself'));
          else if (typeof r !== 'string' || !ids.has(r)) errors.push(at(`related: "${r}" is not a released plugin of this repository`));
        }
        if (new Set(m.related).size !== m.related.length) errors.push(at('related: duplicates'));
      }
    }
    if (m.highlight !== undefined) {
      const h = m.highlight;
      if (!isObj(h)) errors.push(at('highlight: not an object'));
      else {
        for (const k of Object.keys(h)) if (!['version', 'title', 'text', 'tags'].includes(k)) errors.push(at(`highlight: unknown key "${k}"`));
        if (typeof h.version !== 'string' || !lib.parseSemver(h.version)) errors.push(at(`highlight.version: "${h.version}" is not a version`));
        else if (ids.has(id) && !changelog(id, h.version)) errors.push(at(`highlight.version: no "## ${h.version}" section in CHANGELOG.md`));
        text(at('highlight.title'), h.title, 80);
        text(at('highlight.text'), h.text, 280);
        if (h.tags !== undefined) {
          rows(at('highlight.tags'), h.tags, 4, ['icon', 'text'], (w, x) => {
            oneOf(`${w}.icon`, x.icon, DETAIL_ICONS);
            text(`${w}.text`, x.text, 40);
          });
        }
      }
    }
    if (m.adds !== undefined) rows(at('adds'), m.adds, 8, ['icon', 'title', 'text'], iconText(80, 120));
    if (m.permissions !== undefined) {
      rows(at('permissions'), m.permissions, 10, ['icon', 'title', 'text', 'tag?'], (w, x) => {
        iconText(80, 200)(w, x);
        if (x.tag !== undefined) text(`${w}.tag`, x.tag, 24);
      });
    }
    if (m.shows !== undefined) {
      rows(at('shows'), m.shows, 3, ['kind', 'caption', 'value?'], (w, x) => {
        oneOf(`${w}.kind`, x.kind, SHOW_KINDS);
        text(`${w}.caption`, x.caption, 60);
        if (x.value !== undefined) {
          if (typeof x.value !== 'string' || !x.value.trim() || x.value !== x.value.trim()) errors.push(`${w}.value: invalid "${x.value}"`);
          else if (x.value.length > 12) errors.push(`${w}.value: ${x.value.length} characters (max 12)`);
        }
      });
    }
    if (m.needs !== undefined) text(at('needs'), m.needs, 80);
    if (m.languages !== undefined) {
      if (!Array.isArray(m.languages)) errors.push(at('languages: not an array'));
      else {
        if (!m.languages.length) errors.push(at('languages: empty'));
        for (const l of m.languages) oneOf(at('languages'), l, LANGS);
        if (new Set(m.languages).size !== m.languages.length) errors.push(at('languages: duplicates'));
      }
    }
  }
  return errors;
}

/** Errors of the catalog-meta.json file (none when it is missing). */
function validateFile(file = FILE) {
  if (!fs.existsSync(file)) return [];
  let raw;
  try { raw = lib.readJson(file); } catch (e) { return [e.message]; }
  return validateMeta(raw);
}

/** Validate catalog-meta.json and print the result like tools/validate.js; true when valid. */
function check(file = FILE) {
  const errors = validateFile(file);
  for (const e of errors) {
    process.stdout.write(process.env.GITHUB_ACTIONS ? `::error file=catalog-meta.json::${e}\n` : `✗ catalog-meta.json: ${e}\n`);
  }
  if (!errors.length) process.stdout.write('✓ catalog-meta.json\n');
  return !errors.length;
}

if (require.main === module && !check()) process.exit(1);

module.exports = { FILE, FIELDS, CATEGORIES, ICONS, AUDIENCES, DETAIL_ICONS, SHOW_KINDS, readMeta, pick, validateMeta, validateFile, check };
