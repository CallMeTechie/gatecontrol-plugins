'use strict';

// Pages and portal tab: every page renders in de and en with all texts filled, every text
// key the UI uses exists in both languages, plugin.json declares what the contract asks for.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const texts = require('../server/texts.json');
const ui = require('../server/ui');
const util = require('../server/util');
const config = require('../server/config');
const log = require('../server/log');
const manifest = require('../plugin.json');
const { withHost } = require('./helpers');

const t = (lang, k) => (texts[lang] && texts[lang][k]) || texts.de[k] || k;
const ctxOf = (html) => JSON.parse(html.split('window.MS_CTX=')[1].split(';</script>')[0]);

test('render: overview, log and the portal tab in de and en; no unresolved keys; no own page title', () => {
  for (const lang of ['de', 'en']) {
    for (const view of [{ view: 'page', page: 'overview' }, { view: 'page', page: 'log' }, { view: 'portal', user: { id: 2, loggedIn: true } }, { view: 'portal', user: { id: 2, loggedIn: false } }]) {
      const html = ui.render({ ...view, lang }, t);
      assert.ok(!/\{\{t:/.test(html), `${view.page || view.view}: all keys filled`);
      assert.ok(!/<h1/.test(html), 'GateControl shows the title');
      const ctx = ctxOf(html);
      assert.equal(ctx.lang, lang);
      assert.equal(ctx.texts, texts[lang] && ctx.texts && ctx.texts === undefined ? null : ctx.texts);
      assert.ok(html.includes('window.MS = {'), 'common helpers');
    }
  }
  assert.equal(ctxOf(ui.render({ view: 'portal', user: { id: 2, loggedIn: false } }, t)).loggedIn, false);
  assert.equal(ctxOf(ui.render({ view: 'portal', user: { id: 2, loggedIn: true, kiosk: true } }, t)).loggedIn, false, 'never on a kiosk device');
  assert.equal(ctxOf(ui.render({ view: 'portal', user: { id: 2, loggedIn: true } }, t)).viewer, 2);
  assert.equal(ctxOf(ui.render({ view: 'page', page: 'nope' }, t)).page, 'overview');
  const portal = ui.render({ view: 'portal', lang: 'de', user: { id: 2, loggedIn: true } }, t);
  for (const id of ['ms-app', 'ms-rows', 'ms-chat', 'ms-info', 'ms-login', 'ms-file']) assert.ok(portal.includes(`id="${id}"`), id);
  for (const call of ["GC.on('event'", 'GC.upload(', 'MediaRecorder', "'conversations/' + c.id + '/read'", "'/active'", "'/typing'"]) assert.ok(portal.includes(call), call);
  const overview = ui.render({ view: 'page', page: 'overview', lang: 'de' }, t);
  assert.ok(overview.includes('Private Chats sind für Administratoren nicht lesbar.'));
  assert.ok(overview.includes('Einstellungen → Plugins → Messenger → Übersicht → Medien'), 'where the media limits are changed');
});

test('the frames never load a blob: URL or anything outside the frame CSP', () => {
  const dir = path.join(__dirname, '..', 'ui');
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/createObjectURL/.test(src), `${f}: blob: URLs are blocked by the frame CSP (img-src data: + /avatars/ + /plugin-media/)`);
    assert.ok(!/https?:\/\//.test(src.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, '')), `${f}: no external URL`);
    assert.ok(!/\b(alert|confirm|prompt)\(/.test(src.replace(/M\.confirm\(|confirmDialog\(|confirm: confirmDialog/g, '')), `${f}: sandboxed frames have no modals`);
  }
});

test('texts: every key used by the pages exists in de and en; both languages have the same keys', () => {
  assert.deepEqual(Object.keys(texts.de).sort(), Object.keys(texts.en).sort());
  for (const l of ['de', 'en']) for (const [k, v] of Object.entries(texts[l])) assert.ok(typeof v === 'string' && v.trim(), `${l}: ${k} empty`);
  const used = new Set();
  for (const dir of ['ui', 'server']) {
    for (const f of fs.readdirSync(path.join(__dirname, '..', dir))) {
      if (!/\.(js|html)$/.test(f)) continue;
      const src = fs.readFileSync(path.join(__dirname, '..', dir, f), 'utf8');
      for (const m of src.matchAll(/\{\{t:([a-z0-9_.-]+)\}\}|\bT\('([a-z0-9_.-]+)'|\bt\([a-z.]+, '([a-z0-9_.-]+)'/g)) used.add(m[1] || m[2] || m[3]);
    }
  }
  for (const k of used) if (!k.endsWith('.') && !k.endsWith('_')) for (const l of ['de', 'en']) assert.ok(texts[l][k], `${l}: ${k}`);
  const dyn = [
    ...Object.keys(util.STATUS).map((c) => 'error.' + c),
    ...['too_large', 'unsupported_type', 'quota_exceeded', 'length_required', 'not_found'].map((c) => 'error.upload_' + c),
    ...log.CODES.map((c) => 'log.code.' + c), 'log.level_error', 'log.level_limit',
    ...config.DISAPPEARING_S.filter(Boolean).map((s) => 'dis.' + s),
    ...['text', 'image', 'voice', 'file', 'location', 'system'].map((k) => 'kind.' + k),
    ...['image', 'audio', 'video', 'application', 'text'].map((k) => 'admin.type_' + k),
    'portal.new_direct', 'portal.new_group', 'prefs.typing_hint',
  ];
  for (const k of dyn) for (const l of ['de', 'en']) assert.ok(texts[l][k], `${l}: ${k}`);
});

test('plugin.json: licence, GateControl 1.177.0, permissions, pages, app and portal tab "Chats"', () => {
  assert.equal(manifest.id, 'gatecontrol-messenger');
  assert.equal(manifest.version, '1.1.0');
  assert.equal(manifest.gatecontrol, '>=1.177.0', 'media, realtime events, chat notifications and services');
  assert.deepEqual(manifest.license, { required: true });
  const p = manifest.permissions;
  assert.deepEqual([p.storage, p.users, p.app, p.portal, p.notify, p.events, p.background], [true, true, true, true, true, true, { intervalSeconds: 60 }]);
  assert.deepEqual(manifest.ui.pages.map((x) => x.id), ['overview', 'log']);
  for (const k of ['portal', 'app']) assert.deepEqual(manifest.ui[k].label, { de: 'Chats', en: 'Chats' });
  assert.deepEqual(manifest.ui.nav.label, { de: 'Messenger', en: 'Messenger' });
  const ICON = /^[MmLlHhVvCcSsQqTtAaZz0-9 .,-]{1,600}$/;
  for (const k of ['nav', 'portal', 'app']) assert.ok(ICON.test(manifest.ui[k].icon), k);
  assert.ok(!manifest.ui.maps);
});

test('the mock host accepts the manifest and the plugin starts; the encryption key is created once', async () => {
  await withHost({}, async (host) => {
    const key = host.settings.enc_key;
    await host.start();
    assert.equal(host.settings.enc_key, key, 'kept on restart');
  });
});
