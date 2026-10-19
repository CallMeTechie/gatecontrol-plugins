#!/usr/bin/env node
'use strict';

// Build catalog.json from release index entries (*.index.json):
//   node tools/catalog.js <folder with *.index.json> --out catalog.json --repo <owner/repo>
//
// The catalogue is always rebuilt from the published releases — the
// releases are the source of truth, so a deleted release disappears and a
// broken catalogue is fixed by running the catalog workflow again.
//
// {
//   "schema": 1, "generated_at": "…", "repository": "owner/repo",
//   "plugins": {
//     "<id>": { "id", "name", "description", "publisher",
//               "latest": <entry of the highest non-pre-release version (or the highest one)>,
//               "versions": [<entries, newest first>],
//               // optional store metadata from catalog-meta.json (tools/catalog-meta.js), only when set:
//               "category", "icon", "summary": { de, en }, "audience", "keywords": [], "related": [],
//               "highlight": { "version", "title": { de, en }, "text": { de, en } } }
//   }
// }
//
// Every version entry (in "versions" and "latest") also gets "notes": the
// "## <version>" section of plugins/<id>/CHANGELOG.md in this checkout,
// trimmed, at most 6000 characters (cut at a line end, then "\n…"). No
// section, no CHANGELOG or no plugin folder → no "notes".

const fs = require('node:fs');
const path = require('node:path');
const lib = require('./lib');
const catalogMeta = require('./catalog-meta');

const NOTES_MAX = 6000;

/** CHANGELOG section text → release notes of at most NOTES_MAX characters; null when empty. */
function capNotes(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (!t) return null;
  if (t.length <= NOTES_MAX) return t;
  const room = NOTES_MAX - 2; // "\n…"
  let cut = t.lastIndexOf('\n', room);
  if (cut <= 0) cut = room;
  return t.slice(0, cut).trimEnd() + '\n…';
}

/** Release notes of one plugin version from its CHANGELOG.md, or null. */
function notesFor(id, version) {
  try { return capNotes(lib.changelogSection(id, version)); } catch { return null; }
}

/** Index entries (parsed) + store metadata ({ <id>: meta }) → catalog.json object. */
function buildCatalog(entries, { meta = {}, repo = null, notes = notesFor } = {}) {
  const byId = new Map();
  for (const e of entries) {
    if (!byId.has(e.id)) byId.set(e.id, new Map());
    byId.get(e.id).set(e.version, e);
  }
  const plugins = {};
  for (const id of [...byId.keys()].sort()) {
    const versions = [...byId.get(id).values()]
      .sort((a, b) => lib.compareSemver(b.version, a.version))
      .map((e) => {
        const n = notes(id, e.version);
        return n ? { ...e, notes: n } : e;
      });
    const latest = versions.find((v) => !v.prerelease) || versions[0];
    plugins[id] = { id, name: latest.name, description: latest.description, publisher: latest.publisher, latest, versions, ...catalogMeta.pick(meta[id]) };
  }
  return { schema: 1, generated_at: new Date().toISOString(), repository: repo, plugins };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const dir = args[0];
  const out = opt('--out');
  if (!dir || !out) lib.fail('usage: node tools/catalog.js <folder> --out catalog.json --repo <owner/repo> [--meta catalog-meta.json]');

  const entries = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.index.json')).sort()) {
    let e;
    try { e = lib.readJson(path.join(dir, f)); } catch (err) { lib.fail(`${f}: ${err.message}`); }
    if (!e || e.schema !== 1 || !lib.ID_RE.test(e.id || '') || !lib.parseSemver(e.version) || !/^[0-9a-f]{64}$/.test(e.sha256 || '') || !e.url) {
      lib.fail(`${f}: not a valid index entry`);
    }
    entries.push(e);
  }

  // Store metadata is optional: a broken file never stops the catalogue (CI validates it).
  let meta = {};
  const metaFile = opt('--meta') || catalogMeta.FILE;
  try { meta = catalogMeta.readMeta(metaFile); } catch (err) {
    process.stderr.write(`${process.env.GITHUB_ACTIONS ? '::warning::' : ''}${path.basename(metaFile)}: ${err.message} (store metadata left out)\n`);
  }

  const catalog = buildCatalog(entries, { meta, repo: opt('--repo') || null });
  fs.writeFileSync(out, JSON.stringify(catalog, null, 2) + '\n');
  process.stdout.write(`${out}: ${Object.keys(catalog.plugins).length} plugin(s), ${Object.values(catalog.plugins).reduce((n, p) => n + p.versions.length, 0)} release(s)\n`);
}

module.exports = { NOTES_MAX, capNotes, notesFor, buildCatalog };
