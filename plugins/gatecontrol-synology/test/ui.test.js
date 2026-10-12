'use strict';

// Texts and page: German and English have the same keys, every key the page
// and the server use exists (also the composed ones), the rendered page is
// self-contained (inline only, nothing external) and the manifest fits the
// code (topics, settings, admin-only).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const texts = require('../server/texts.json');
const ui = require('../server/ui');
const parse = require('../server/parse');
const alerts = require('../server/alerts');
const config = require('../server/config');
const manifest = require('../plugin.json');
const plugin = require('../server/index');

const DIR = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');
const t = (lang, key) => (texts[lang] && texts[lang][key]) || texts.de[key] || key;

test('de and en have the same keys, no empty texts, placeholders match', () => {
  assert.deepEqual(Object.keys(texts.en).sort(), Object.keys(texts.de).sort());
  for (const k of Object.keys(texts.de)) {
    for (const l of ['de', 'en']) assert.ok(String(texts[l][k]).trim(), `${l}.${k} empty`);
    const ph = (s) => (s.match(/\{\{\w+\}\}/g) || []).sort().join();
    assert.equal(ph(texts.en[k]), ph(texts.de[k]), `placeholders of ${k}`);
  }
  assert.deepEqual(Object.keys(alerts.TEXTS.en).sort(), Object.keys(alerts.TEXTS.de).sort());
});

test('every text key of the page and the server exists (literal and composed)', () => {
  const used = new Set();
  for (const m of read('ui/admin.html').matchAll(/\{\{t:([a-z0-9_.-]+)\}\}/g)) used.add(m[1]);
  for (const f of ['ui/admin.js', 'ui/common.js']) for (const m of read(f).matchAll(/\bT\('([a-z0-9_.-]+)'\s*[,)]/g)) used.add(m[1]);
  // keys picked by a condition (T(a ? 'x.y' : 'x.z')): every key-like literal of the page scripts
  for (const f of ['ui/admin.js', 'ui/common.js']) for (const m of read(f).matchAll(/'([a-z]+\.[a-z0-9_]*[a-z0-9])'/g)) used.add(m[1]);
  for (const f of ['server/index.js', 'server/ui.js']) for (const m of read(f).matchAll(/\bt\(\w+, '([a-z0-9_.-]+)'/g)) used.add(m[1]);
  for (const [, key] of Object.values(plugin._errors)) used.add(key);
  used.add('dsm.INTERNAL');
  // composed in admin.js: 'issue.<kind>_<status>', 'vstatus.', 'health.', 'bk.', 'ups.'
  for (const s of ['degraded', 'crashed']) { used.add(`issue.pool_${s}`); used.add(`issue.volume_${s}`); }
  for (const s of ['warning', 'failing']) used.add(`issue.disk_${s}`);
  for (const s of ['failed', 'partial']) used.add(`issue.backup_${s}`);
  for (const s of ['battery', 'low']) used.add(`issue.ups_${s}`);
  for (const s of ['normal', 'degraded', 'crashed', 'unknown']) used.add(`vstatus.${s}`);
  for (const s of ['normal', 'warning', 'failing', 'unknown']) used.add(`health.${s}`);
  for (const s of ['ok', 'failed', 'partial', 'cancelled', 'running', 'none', 'unknown']) used.add(`bk.${s}`);
  for (const s of ['online', 'battery', 'low', 'unknown']) used.add(`ups.${s}`);
  const missing = [...used].filter((k) => texts.de[k] == null || texts.en[k] == null);
  assert.deepEqual(missing, []);
  assert.ok(used.size > 150, `${used.size} keys checked`);
  // every value parse.js can produce has its text
  for (const raw of ['done', 'failed', 'partial', 'cancel', '', 'running', 'x']) assert.ok(texts.de[`bk.${parse.backupResult(raw)}`]);
  for (const raw of ['normal', 'degraded', 'crashed', 'x']) assert.ok(texts.de[`vstatus.${parse.storageStatus(raw)}`]);
});

test('rendered page: inline only (no external URL, no src/href to elsewhere), texts filled, context island safe', () => {
  for (const lang of ['de', 'en']) {
    const html = ui.render({ view: 'page', lang }, t, true);
    assert.doesNotMatch(html, /\{\{t:/, 'every placeholder filled');
    assert.doesNotMatch(html, /\b(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i);
    assert.doesNotMatch(html, /<link\b|@import/i);
    assert.match(html, /window\.SY_CTX=/);
    assert.match(html, lang === 'de' ? /NAS hinzufügen/ : /Add NAS/);
    // dialogs are full-viewport fixed backdrops (GateControl dims its page around them)
    assert.match(html, /\.modal-overlay\{position:fixed;inset:0/);
    assert.match(html, /class="modal-overlay" id="sy-nas-modal"/);
  }
  const island = ui.island({ s: '</script><!--\u2028' });
  assert.doesNotMatch(island, /<\/script|<!--|\u2028/);
  assert.equal(ui.render({ view: 'page', lang: 'de' }, t, false).includes('SY_CTX'), false, 'nobody but an administrator gets the page');
});

test('manifest: admin only, topics and settings match the code', () => {
  assert.equal(manifest.id, 'gatecontrol-synology');
  assert.equal(manifest.version, '1.0.0');
  assert.deepEqual(manifest.name, { de: 'NAS (Synology)', en: 'NAS (Synology)' });
  assert.equal(manifest.license.required, true);
  assert.equal(manifest.permissions.portal, undefined);
  assert.equal(manifest.permissions.users, undefined);
  assert.equal(manifest.ui.portal, undefined);
  assert.deepEqual(manifest.permissions.network.homeTargets.map((x) => [x.id, x.protocols.join(), x.multiple]), [['nas', 'http', true]]);
  assert.deepEqual(manifest.notifyTopics.map((x) => x.id).sort(), ['backup', 'disk', 'power', 'storage', 'unreachable', 'update']);
  for (const s of manifest.ui.settings) {
    if (s.type === 'number') {
      assert.deepEqual([s.min, s.max], config.RANGES[s.key], s.key);
      assert.equal(s.default, config.DEFAULTS[s.key], s.key);
    }
  }
  assert.deepEqual(manifest.ui.settings.map((s) => s.key).sort(), Object.keys(config.DEFAULTS).sort());
});
