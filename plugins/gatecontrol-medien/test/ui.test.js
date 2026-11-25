'use strict';

// The admin pages render (every text key exists in both languages), the manifest's pages and tabs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup } = require('./helpers');
const texts = require('../server/texts.json');
const manifest = require('../plugin.json');

test('every page renders in German and English without a missing text', async () => {
  const t = await setup();
  try {
    for (const lang of ['de', 'en']) {
      for (const page of ['overview', 'sources', 'people', 'devices']) {
        const r = await t.host.render({ page, lang });
        assert.match(r.html, /window\.MD_CTX=/);
        assert.doesNotMatch(r.html, /\{\{t:/);
      }
    }
  } finally { await t.host.close(); }
});

test('text keys: the same in de and en, and every key the pages use exists', () => {
  assert.deepEqual(Object.keys(texts.de).sort(), Object.keys(texts.en).sort());
  const ui = path.join(__dirname, '..', 'ui');
  for (const f of fs.readdirSync(ui)) {
    const s = fs.readFileSync(path.join(ui, f), 'utf8');
    for (const m of s.matchAll(/T\('([a-z0-9_.]+)'[,)]/g)) assert.ok(m[1] in texts.de, f + ': ' + m[1]);
    for (const m of s.matchAll(/\{\{t:([a-z0-9_.-]+)\}\}/g)) assert.ok(m[1] in texts.de, f + ': ' + m[1]);
  }
  for (const code of Object.keys(require('../server/util').STATUS)) assert.ok(('error.' + code) in texts.de, code);
});

test('manifest: own licence, app tab, the three settings tabs, a signal topic', () => {
  assert.equal(manifest.version, '1.0.0');
  assert.deepEqual(manifest.license, { required: true });
  assert.deepEqual(manifest.ui.settingsPages, ['sources', 'people', 'devices']);
  assert.equal(manifest.ui.app.label.de, 'Medien');
  assert.deepEqual(manifest.notifyTopics.map((x) => [x.id, x.signal]), [['media_signal', true]]);
  assert.deepEqual(manifest.permissions.network.homeTargets.map((x) => x.id), ['jellyfin', 'webdav', 'smb']);
});
