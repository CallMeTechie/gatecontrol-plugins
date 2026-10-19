#!/usr/bin/env node
'use strict';

// Store metadata of the catalogue (catalog-meta.json in the repository root):
//   node tools/catalog-meta.js            validate it (also run by tools/validate.js without ids)
//
// Optional per released plugin id; tools/catalog.js copies the fields below
// into that plugin's object in catalog.json. GateControl ignores unknown or
// invalid values, this check is strict so mistakes never reach the store:
//   category   family | home | mobility | infrastructure | other
//   icon       family | chat | calendar | door | bulb | snowflake | car | server | nas | puzzle
//   summary    { de, en }  one sentence each, ≤ 160 characters
//   audience   all | admins
//   keywords   ≤ 12 lowercase search words (German and English), each ≤ 32 characters
//   related    ≤ 4 other released plugin ids ("passt gut dazu")
//   highlight  { version, title: { de, en } ≤ 80, text: { de, en } ≤ 280 }; version has a CHANGELOG section

const fs = require('node:fs');
const path = require('node:path');
const lib = require('./lib');

const FILE = path.join(__dirname, '..', 'catalog-meta.json');
const FIELDS = ['category', 'icon', 'summary', 'audience', 'keywords', 'related', 'highlight'];
const CATEGORIES = ['family', 'home', 'mobility', 'infrastructure', 'other'];
const ICONS = ['family', 'chat', 'calendar', 'door', 'bulb', 'snowflake', 'car', 'server', 'nas', 'puzzle'];
const AUDIENCES = ['all', 'admins'];
const LANGS = ['de', 'en'];

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
        for (const k of Object.keys(h)) if (!['version', 'title', 'text'].includes(k)) errors.push(at(`highlight: unknown key "${k}"`));
        if (typeof h.version !== 'string' || !lib.parseSemver(h.version)) errors.push(at(`highlight.version: "${h.version}" is not a version`));
        else if (ids.has(id) && !changelog(id, h.version)) errors.push(at(`highlight.version: no "## ${h.version}" section in CHANGELOG.md`));
        text(at('highlight.title'), h.title, 80);
        text(at('highlight.text'), h.text, 280);
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

module.exports = { FILE, FIELDS, CATEGORIES, ICONS, AUDIENCES, readMeta, pick, validateMeta, validateFile, check };
