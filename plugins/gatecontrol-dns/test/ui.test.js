'use strict';

// The settings page and the portal tab: every text key they use exists in German and English, the render escapes,
// the pages keep to the frame (no network of their own, no title of their own) and carry all six tabs.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ui = require('../server/ui');
const texts = require('../server/texts.json');
const plugin = require('../server/index');
const manifest = require('../plugin.json');
const { STATUS } = require('../server/util');

const UI = path.join(__dirname, '..', 'ui');
const SERVER = path.join(__dirname, '..', 'server');
const files = fs.readdirSync(UI);
const t = plugin._t;

describe('texts', () => {
  it('German and English have the same keys, none is empty', () => {
    assert.deepEqual(Object.keys(texts.de).sort(), Object.keys(texts.en).sort());
    for (const l of ['de', 'en']) for (const [k, v] of Object.entries(texts[l])) assert.ok(typeof v === 'string' && v.trim(), `${l} ${k}`);
  });

  it('every key the pages and the server name exists', () => {
    const keys = new Set();
    for (const f of files.filter((x) => /\.(js|html)$/.test(x))) {
      const s = fs.readFileSync(path.join(UI, f), 'utf8');
      for (const m of s.matchAll(/\{\{t:([a-z0-9_.-]+)\}\}/g)) keys.add(m[1]);
      for (const m of s.matchAll(/'([a-z]{1,7}\.[a-z0-9_]+)'/g)) if (!m[1].endsWith('_') && !/\.(js|json|html|css)$/.test(m[1])) keys.add(m[1]);
    }
    for (const f of fs.readdirSync(SERVER).filter((x) => x.endsWith('.js'))) {
      const s = fs.readFileSync(path.join(SERVER, f), 'utf8');
      for (const m of s.matchAll(/\bt\(lang, [^)]*?'((?:notify|error|reason)\.[a-z0-9_]+)'/g)) keys.add(m[1]);
      for (const m of s.matchAll(/'(notify\.[a-z0-9_]+)'/g)) keys.add(m[1]);
    }
    assert.ok(keys.size > 300, String(keys.size));
    assert.deepEqual([...keys].filter((k) => !(k in texts.de)), []);
  });

  it('the keys built at run time exist: errors, reasons, lists, categories, states, days, providers', () => {
    const need = [
      ...Object.keys(STATUS).map((c) => 'error.' + c),
      ...['admins_only', 'profile', 'admin_target', 'not_yours', 'not_filtered', 'no_device', 'fallback', 'off', 'paused_for_all', 'log_admins_only', 'internet_paused', 'paused'].map((r) => 'reason.' + r),
      ...['ads', 'malware', 'adult', 'gambling', 'ads_stevenblack'].flatMap((l) => ['list.' + l, 'listd.' + l]),
      ...['social', 'games', 'video'].map((c) => 'cat.' + c),
      ...['off', 'starting', 'fallback', 'active', 'paused'].map((x) => 'st.' + x),
      ...[1, 2, 3, 4, 5, 6, 7].map((d) => 'day.' + d),
      ...['quad9', 'cloudflare', 'custom', 'system'].flatMap((p) => ['se.prov_' + p, 'se.prov_' + p + '_hint']),
      ...['filtered', 'ownDns', 'excluded', 'gateway', 'disabled'].map((x) => 'dv.f_' + x),
      ...['blocked', 'allowed', 'allowed_paused', 'safe_search'].map((x) => 'lg.r_' + x),
      ...['device', 'person', 'server'].map((x) => 'po.scope_' + x),
      ...['timeout', 'fallback', 'nodns'].flatMap((x) => ['wz.failed_' + x, 'wz.failed_' + x + '_pihole']),
      ...['list', 'denyAll', 'denyProfile', 'schedule', 'pause', 'other'].map((x) => 'by.' + x),
      ...['profile_deny', 'profile_allow'].flatMap((x) => ['reason.' + x, 'reason.' + x + '_all', 'reason.' + x + '_in', 'reason.' + x + '_profile']),
      'li.allow_title', 'li.deny_title', 'li.allow_hint', 'li.deny_hint', 'pf.allow_label', 'pf.deny_label',
    ];
    assert.deepEqual(need.filter((k) => !(k in texts.de)), []);
  });

  it('t() fills placeholders and falls back to German and to the key', () => {
    assert.equal(t('de', 'error.too_long', { maxMinutes: 30 }), 'Länger als 30 Minuten darfst du nicht unterbrechen.');
    assert.equal(t('en', 'ov.resume'), 'Switch back on');
    assert.equal(t('fr', 'ov.resume'), 'Wieder einschalten');
    assert.equal(t('de', 'no.such'), 'no.such');
  });

  it('every notify topic of plugin.json is sent by the plugin and the other way round', () => {
    const src = fs.readFileSync(path.join(SERVER, 'notices.js'), 'utf8');
    const sent = new Set([...src.matchAll(/topic: '([a-z_]+)'/g)].map((m) => m[1]));
    assert.deepEqual([...sent].sort(), manifest.notifyTopics.map((x) => x.id).sort());
  });
});

describe('render', () => {
  it('the settings page: six tabs, texts in the viewer\'s language, no title of its own, nothing from outside', () => {
    for (const page of ['main', 'protection']) {
      const html = ui.render({ view: 'page', page, lang: 'de' }, t);
      for (const id of ['overview', 'lists', 'profiles', 'devices', 'log', 'settings']) assert.ok(html.includes(`data-tab="${id}"`), id);
      assert.ok(html.includes('Listen &amp; Ausnahmen'));
      assert.ok(!/<h1[\s>]/.test(html), 'GateControl shows the page title');
      assert.ok(!/(src|href)="https?:/.test(html), 'no network of its own');
      assert.ok(html.includes('window.DNS_CTX='));
    }
    const en = ui.render({ view: 'page', page: 'protection', lang: 'en' }, t);
    assert.ok(en.includes('Lists &amp; exceptions') && en.includes('"lang":"en"'));
  });

  it('the portal tab is its own page', () => {
    const html = ui.render({ view: 'portal', lang: 'de' }, t);
    assert.ok(html.includes('dn-portal') && html.includes('"view":"portal"'));
    assert.ok(!html.includes('data-tab='));
  });

  it('the page scripts never build HTML from data', () => {
    for (const f of ['admin.js', 'portal.js', 'common.js']) {
      const s = fs.readFileSync(path.join(UI, f), 'utf8');
      const inner = [...s.matchAll(/\.innerHTML\s*=/g)].length;
      assert.ok(inner <= (f === 'admin.js' ? 1 : 0), `${f}: innerHTML only for the fixed donut SVG`);
      assert.ok(!/insertAdjacentHTML|document\.write|eval\(/.test(s), f);
    }
  });

  it('island: no way out of the inline script', () => {
    assert.equal(ui.island({ a: '</script><!--' }), '{"a":"\\u003c/script>\\u003c!--"}');
    assert.equal(ui.esc('<b>"x"&\'y\''), '&lt;b&gt;&quot;x&quot;&amp;&#39;y&#39;');
  });

  it('plugin.json: the settings page is a page of the plugin, the permissions are the few it needs', () => {
    assert.equal(manifest.ui.settingsPage, 'protection');
    assert.ok(manifest.ui.pages.findIndex((p) => p.id === 'protection') >= 1);
    assert.equal(manifest.ui.nav, undefined, 'administration lives on the settings page, not in the sidebar');
    assert.deepEqual(Object.keys(manifest.permissions).sort(), ['app', 'background', 'groups', 'notify', 'portal', 'users', 'vpnDns']);
    assert.equal(manifest.permissions.groups, 'read');
    assert.equal(manifest.gatecontrol, '>=1.267.0');
    assert.deepEqual(manifest.license, { required: true });
  });
});
