'use strict';

// The pages, the portal tab and the profile section: every text key they use exists in German and English, the render
// escapes, the frames keep to the sandbox (no network of their own, sessions only through GC.openSession).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ui = require('../server/ui');
const texts = require('../server/texts.json');
const plugin = require('../server/index');

const UI = path.join(__dirname, '..', 'ui');
const files = fs.readdirSync(UI);

describe('pages and texts', () => {
  it('German and English have the same keys', () => {
    assert.deepEqual(Object.keys(texts.de).sort(), Object.keys(texts.en).sort());
  });

  it('every key the pages name exists', () => {
    const keys = new Set();
    for (const f of files.filter((x) => /\.(js|html)$/.test(x))) {
      const s = fs.readFileSync(path.join(UI, f), 'utf8');
      for (const m of s.matchAll(/\{\{t:([a-z0-9_.-]+)\}\}/g)) keys.add(m[1]);
      for (const m of s.matchAll(/\bT\('([a-z0-9_.]+)'(?!\s*\+)/g)) keys.add(m[1]);
    }
    const missing = [...keys].filter((k) => !(k in texts.de));
    assert.deepEqual(missing, []);
  });

  it('every API error, field, tab, right and option of the editor has a text', () => {
    const { STATUS } = require('../server/util');
    const devices = require('../server/devices');
    for (const code of Object.keys(STATUS)) assert.ok(texts.de['error.' + code], code);
    for (const k of Object.keys(devices.FIELDS)) assert.ok(texts.de['f.' + k], 'f.' + k);
    for (const k of ['connection', 'auth', 'display', 'resources', 'performance', 'session', 'wol', 'browser', 'notes']) assert.ok(texts.de['tab.' + k], k);
    for (const k of ['rdp', 'ssh', 'support', 'share']) assert.ok(texts.de['right.' + k], k);
    for (const k of devices.ACCESS_MODES) assert.ok(texts.de['mode.' + k], k);
    for (const k of devices.PROTOCOLS) assert.ok(texts.de['proto.' + k], k);
    for (const k of ['no_gesture', 'invalid', 'not_allowed', 'timeout', 'failed']) assert.ok(texts.de['connect.failed.' + k], k);
    for (const k of ['admin', 'person', 'group', 'default']) assert.ok(texts.de['rights.src.' + k], k);
  });

  it('render: each page, the portal tab and the profile section, in both languages, without unfilled keys', async () => {
    for (const lang of ['de', 'en']) {
      for (const view of [...ui.PAGES.map((page) => ({ view: 'page', page })), { view: 'portal' }, { view: 'portal', section: 'rights' }]) {
        const { html } = await plugin.render({ ...view, lang });
        assert.doesNotMatch(html, /\{\{t:/, `${view.page || view.section || 'portal'} ${lang}`);
        assert.match(html, /window\.RM_CTX=/);
      }
    }
    assert.match((await plugin.render({ view: 'portal', section: 'rights', lang: 'de' })).html, /Das darfst du \(vom Admin festgelegt\)/);
    assert.equal(ui.island('</script>'), '"\\u003c/script>"');
  });

  it('the frames have no network of their own and open sessions only through GC.openSession', () => {
    for (const f of files.filter((x) => x.endsWith('.js'))) {
      const s = fs.readFileSync(path.join(UI, f), 'utf8');
      assert.doesNotMatch(s, /\bfetch\(|XMLHttpRequest|innerHTML|window\.open\(/, f);
    }
    assert.match(fs.readFileSync(path.join(UI, 'common.js'), 'utf8'), /window\.GC\.openSession\(ref\)/);
    assert.match(fs.readFileSync(path.join(UI, 'style.css'), 'utf8'), /\.rm-portal \.btn[^{]*\{min-height:44px/);
  });

  it('plugin.json: the permissions of the contract, an own licence, the profile section', () => {
    const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plugin.json'), 'utf8'));
    assert.equal(m.id, 'gatecontrol-remote');
    assert.equal(m.name.de, 'Fernzugriff');
    assert.equal(m.permissions.remote, true);
    assert.equal(m.license.required, true);
    assert.equal(m.ui.pages[0].id, 'devices');
    assert.equal(m.ui.portal.profileSections[0].id, 'rights');
  });
});
