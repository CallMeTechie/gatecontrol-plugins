'use strict';

// The pages and the portal tab: every text key they use exists in German and English, the render escapes,
// the portal keeps to the frame (no network of its own, ≥ 44 px targets in the styles).

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

  it('every key the pages and the server name exists', () => {
    const keys = new Set();
    for (const f of files.filter((x) => /\.(js|html)$/.test(x))) {
      const s = fs.readFileSync(path.join(UI, f), 'utf8');
      for (const m of s.matchAll(/\{\{t:([a-z0-9_.-]+)\}\}/g)) keys.add(m[1]);
      for (const m of s.matchAll(/\bT\('([a-z0-9_.]+)'(?!\s*\+)/g)) keys.add(m[1]);
    }
    const server = fs.readdirSync(path.join(__dirname, '..', 'server')).filter((x) => x.endsWith('.js'));
    for (const f of server) {
      const s = fs.readFileSync(path.join(__dirname, '..', 'server', f), 'utf8');
      for (const m of s.matchAll(/\bt\(lang, '([a-z0-9_.]+)'/g)) if (!m[1].endsWith('.')) keys.add(m[1]);
    }
    const missing = [...keys].filter((k) => !(k in texts.de));
    assert.deepEqual(missing, []);
  });

  it('every API error and job state has a text', () => {
    const { STATUS } = require('../server/util');
    for (const code of Object.keys(STATUS)) assert.ok(texts.de['error.' + code], code);
    for (const s of ['queued', 'sending', 'printing', 'waiting', 'done', 'failed', 'expired', 'canceled']) assert.ok(texts.de['job.' + s], s);
  });

  it('render: each page and the portal, in both languages, without unfilled keys', async () => {
    for (const lang of ['de', 'en']) {
      for (const view of [...ui.PAGES.map((page) => ({ view: 'page', page })), { view: 'portal' }]) {
        const { html } = await plugin.render({ ...view, lang });
        assert.doesNotMatch(html, /\{\{t:/, `${view.page || 'portal'} ${lang}`);
        assert.match(html, /window\.PR_CTX=/);
      }
    }
    assert.equal(ui.island('</script>'), '"\\u003c/script>"');
  });

  it('the frame has no network of its own: no fetch/XMLHttpRequest, files only through GC.upload', () => {
    for (const f of files.filter((x) => x.endsWith('.js'))) {
      const s = fs.readFileSync(path.join(UI, f), 'utf8');
      assert.doesNotMatch(s, /\bfetch\(|XMLHttpRequest|innerHTML/, f);
    }
    assert.match(fs.readFileSync(path.join(UI, 'portal.js'), 'utf8'), /window\.GC\.upload\(/);
    assert.match(fs.readFileSync(path.join(UI, 'style.css'), 'utf8'), /\.pr-portal \.btn[^{]*\{min-height:44px/);
  });
});
