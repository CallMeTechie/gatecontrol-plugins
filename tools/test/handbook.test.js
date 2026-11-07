'use strict';

// plugin.json "handbook" / "setupNotices" (tools/handbook.js): every plugin has a handbook of its current version, the
// rules of the Markdown subset and of the notices, and the mock host accepts both keys.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lib = require('../lib');
const handbook = require('../handbook');
const { stagedFiles } = require('../stage');
const { createHost } = require('../testing/mock-host');

const doc = (version, lang, body = '') => `<!-- version: ${version} -->\n# Titel\n\n## Einrichten\n\nText.\n\n## ${lang === 'en' ? 'New in' : 'Neu in'} ${version}\n\n- x\n${body}`;

test('every plugin has a handbook of its version and valid set-up notices', () => {
  for (const id of lib.listPlugins()) {
    const dir = lib.pluginDir(id);
    const raw = lib.readJson(path.join(dir, 'plugin.json'));
    assert.deepEqual(handbook.check(dir, raw, stagedFiles(dir)), [], id);
    assert.deepEqual(handbook.files(raw), ['HANDBUCH.md', 'HANDBOOK.md'], id);
  }
});

test('slugs like the host: umlauts, ß, punctuation; explicit anchors', () => {
  assert.equal(handbook.slug('Häufige Fragen / Fehlersuche'), 'haeufige-fragen-fehlersuche');
  assert.equal(handbook.slug('Größe & Maße'), 'groesse-masse');
  assert.equal(handbook.slug('Neu in 1.6.1'), 'neu-in-1-6-1');
  assert.equal(handbook.slug('Café & Škoda'), 'cafe-skoda');
  assert.equal(handbook.slug('x'.repeat(99) + ' y'), 'x'.repeat(99));
  const hs = handbook.headings('# A\n```\n# not a heading\n```\n## Setting up cameras {#kameras-einrichten}\n### **Bold** `x`\n### Siehe [Kapitel](#a) snake_case\n');
  assert.deepEqual(hs.map((h) => [h.level, h.anchor]), [[1, 'a'], [2, 'kameras-einrichten'], [3, 'bold-x'], [3, 'siehe-kapitel-snake-case']]);
});

test('handbook text: version line, "Neu in", Markdown subset', () => {
  const ok = (md, lang = 'de') => handbook.checkText(md, { version: '1.2.3', lang, file: 'H.md' });
  assert.deepEqual(ok(doc('1.2.3', 'de', '\nSiehe [oben](#einrichten) und [Seite](https://example.com/a).\n\n> **Hinweis:** `<b>` in Code ist erlaubt.\n')), []);
  assert.deepEqual(ok(doc('1.2.3', 'en'), 'en'), []);
  assert.match(ok(doc('1.2.2', 'de')).join(), /version 1\.2\.2 ≠ plugin\.json version 1\.2\.3/);
  assert.match(ok(doc('1.2.3', 'de').replace(/^<!--.*\n/, '')).join(), /first line/);
  assert.match(ok(doc('1.2.3', 'de').replace('Neu in', 'Änderungen in')).join(), /no heading "Neu in 1\.2\.3"/);
  assert.match(ok(doc('1.2.3', 'de'), 'en').join(), /no heading "New in 1\.2\.3"/);
  for (const [bad, re] of [
    ['<b>fett</b>', /raw HTML/], ['<!-- Notiz -->', /raw HTML/], ['![Bild](https://example.com/a.png)', /no pictures/],
    ['[x](http://example.com)', /links only/], ['[x](javascript:alert(1))', /links only/], ['[x](kapitel.md)', /links only/],
    ['[x](#gibt-es-nicht)', /unknown anchor/], ['#### Zu tief', /only headings/], ['## Einrichten', /twice/], ['```\nnie zu', /not closed/],
  ]) assert.match(ok(doc('1.2.3', 'de', '\n' + bad + '\n')).join(), re, bad);
});

test('setup notices: shape, since, anchors in both handbooks, check types', () => {
  const anchors = { de: new Set(['kameras-einrichten']), en: new Set(['kameras-einrichten']) };
  const n = (o = {}) => ({ id: 'cameras-compose', since: '1.6.0', title: { de: 'T', en: 'T' }, text: { de: 'X', en: 'X' }, handbook: 'kameras-einrichten', check: { type: 'manual' }, ...o });
  const errs = (list, a = anchors) => handbook.checkNotices({ version: '1.6.1', setupNotices: list }, a);
  assert.deepEqual(errs(undefined), []);
  assert.deepEqual(errs([n(), n({ id: 'b', check: { type: 'gatewayService', feature: 'cameras', service: 'kameras' } }),
    n({ id: 'c', handbook: undefined, check: { type: 'gatewayVersion', min: '1.28.0', feature: 'print' } }), n({ id: 'd', check: { type: 'gatewayVersion', min: '1.28.0' } }),
    n({ id: 'e', check: { type: 'hostVersion', min: '1.240.0' } }), n({ id: 'f', handbook: { de: 'kameras-einrichten', en: 'kameras-einrichten' } }),
    n({ id: 'g', handbook: { de: 'kameras-einrichten' } }), n({ id: 'h', check: { type: 'gatewayService', feature: 'radio', service: 'deconz' } })]), []);
  for (const [list, re] of [
    [{}, /array/], [Array.from({ length: 21 }, (_, i) => n({ id: 'n' + i })), /array/], [[n(), n()], /id twice/], [[n({ id: 'A b' })], /invalid id/],
    [[n({ since: '1.7.0' })], /newer than the plugin/], [[n({ since: 'x' })], /invalid since/], [[n({ title: { de: 'T' } })], /title/],
    [[n({ text: { de: 'x'.repeat(1001), en: 'x' } })], /text/], [[n({ title: { de: 'x'.repeat(121), en: 'x' } })], /title/], [[n({ handbook: { fr: 'x' } })], /handbook must be/], [[n({ handbook: { de: 'kameras-einrichten', en: 'camera-setup' } })], /not in the en handbook/], [[n({ handbook: 'fehlt' })], /not in the de handbook/], [[n({ extra: 1 })], /unknown key extra/],
    [[n({ check: { type: 'cron' } })], /check\.type/], [[n({ check: undefined })], /check\.type/],
    [[n({ check: { type: 'gatewayService', feature: 'cameras' } })], /invalid service/], [[n({ check: { type: 'gatewayService', feature: 'Cameras', service: 'kameras' } })], /invalid feature/], [[n({ check: { type: 'hostVersion', min: '1.2' } })], /invalid min/],
    [[n({ check: { type: 'manual', min: '1.0.0' } })], /unknown key min/],
  ]) assert.match(errs(list).join(), re, JSON.stringify(list).slice(0, 80));
  assert.match(errs([n()], { de: anchors.de, en: new Set() }).join(), /not in the en handbook/);
});

test('a plugin without a handbook fails; the mock host accepts handbook and setupNotices', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-plugin-'));
  try {
    fs.mkdirSync(path.join(tmp, 'server'));
    const raw = { id: 'hb-test', name: 'HB', version: '1.0.0', entry: 'server/index.js' };
    fs.writeFileSync(path.join(tmp, 'server', 'index.js'), 'module.exports = {};');
    assert.match(handbook.check(tmp, raw).join(), /needs "handbook"/);
    raw.handbook = { de: 'HANDBUCH.md', en: 'HANDBOOK.md' };
    assert.match(handbook.check(tmp, raw).join(), /HANDBUCH\.md missing/);
    fs.writeFileSync(path.join(tmp, 'HANDBUCH.md'), doc('1.0.0', 'de'));
    fs.writeFileSync(path.join(tmp, 'HANDBOOK.md'), doc('1.0.0', 'en'));
    raw.setupNotices = [{ id: 'x', since: '1.0.0', title: { de: 'T', en: 'T' }, text: { de: 'X', en: 'X' }, handbook: 'einrichten', check: { type: 'manual' } }];
    assert.deepEqual(handbook.check(tmp, raw), []);
    assert.match(handbook.check(tmp, raw, ['plugin.json', 'server/index.js', 'HANDBOOK.md']).join(), /not packed/);
    fs.writeFileSync(path.join(tmp, 'plugin.json'), JSON.stringify(raw));
    const host = await createHost(tmp);
    await host.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
