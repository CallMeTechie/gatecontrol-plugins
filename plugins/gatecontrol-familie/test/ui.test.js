'use strict';

// Pages, portal tab and manifest: every page renders in de and en with all
// texts filled, every text key used by the UI exists in both languages, the
// Leaflet URL lives in one constant, plugin.json declares what the contract
// asks for.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const texts = require('../server/texts.json');
const ui = require('../server/ui');
const push = require('../server/push');
const manifest = require('../plugin.json');

const t = (lang, k) => (texts[lang] && texts[lang][k]) || texts.de[k] || k;
const ctxOf = (html) => JSON.parse(html.split('window.FA_CTX=')[1].split(';</script>')[0]);

test('render: members, modules, log and the portal tab in de and en; no unresolved keys', () => {
  for (const lang of ['de', 'en']) {
    for (const view of [{ view: 'page', page: 'members' }, { view: 'page', page: 'modules' }, { view: 'page', page: 'log' }, { view: 'portal', loggedIn: true }, { view: 'portal', user: { id: 2, loggedIn: false } },
      { view: 'portal', wall: true, loggedIn: true }, { view: 'portal', wall: true, loggedIn: false }]) {
      const html = ui.render({ ...view, lang }, t);
      assert.ok(!/\{\{t:/.test(html), `${view.page || view.view}: all keys filled`);
      const ctx = ctxOf(html);
      assert.equal(ctx.lang, lang);
      assert.deepEqual(ctx.leaflet, ui.LEAFLET);
      assert.ok(html.includes('window.FA = {'), 'common helpers');
    }
  }
  assert.equal(ctxOf(ui.render({ view: 'portal', user: { loggedIn: false } }, t)).loggedIn, false);
  assert.equal(ctxOf(ui.render({ view: 'portal', loggedIn: true }, t)).loggedIn, true);
  assert.equal(ctxOf(ui.render({ view: 'portal', wall: true, user: { id: 7, portal: true, kiosk: true } }, t)).loggedIn, true, 'a kiosk device writes');
  assert.equal(ctxOf(ui.render({ view: 'page', page: 'nope' }, t)).page, 'members', 'unknown page → members');
  assert.ok(ui.render({ view: 'page', page: 'log' }, t).includes('window.FA.map'), 'the log page has the map');
  assert.ok(!ui.render({ view: 'page', page: 'modules' }, t).includes('window.FA.map'), 'the modules page does not need it');
  const wall = ui.render({ view: 'portal', wall: true, loggedIn: false }, t);
  assert.deepEqual([ctxOf(wall).page, ctxOf(wall).loggedIn], ['wall', false]);
  assert.ok(wall.includes('id="fa-wall"') && !wall.includes('window.FA.map'), 'the wall view, no map');
  assert.equal(ctxOf(ui.render({ view: 'page', page: 'members', wall: true }, t)).page, 'members', 'wall only in the portal');
});

test('texts: every key used by the pages exists in de and en; both languages have the same keys', () => {
  assert.deepEqual(Object.keys(texts.de).sort(), Object.keys(texts.en).sort());
  const dir = path.join(__dirname, '..', 'ui');
  const used = new Set();
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/\{\{t:([a-z0-9_.-]+)\}\}|\bT\('([a-z0-9_.-]+)'/g)) used.add(m[1] || m[2]);
  }
  for (const k of used) if (!k.endsWith('.') && !k.endsWith('_')) for (const l of ['de', 'en']) assert.ok(texts[l][k], `${l}: ${k}`);
  const MODS = ['shopping', 'tasks', 'stars', 'dates', 'locate', 'arrival_sos', 'places', 'rides', 'emergency'];
  const dyn = [
    ...MODS.flatMap((m) => ['module.' + m, 'module.' + m + '_desc', 'card.' + m + '_parent', 'card.' + m + '_child']),
    'module.wall', 'module.wall_desc', 'role.wall',
    ...['all', 'parents', 'children', 'none'].map((x) => 'who.' + x),
    ...['everyday', 'out', 'kids', 'home'].map((x) => 'group.' + x),
    ...['pending', 'answered', 'declined', 'failed', 'expired'].map((x) => 'status.' + x),
    ...['no_permission', 'location_off', 'timeout'].map((x) => 'fail.' + x),
    'decline.busy', 'problem.timezone',
    ...['locate', 'arrival', 'sos', 'place'].map((x) => 'kind.' + x),
    ...['auto', 'confirm', 'off'].map((x) => 'mode.' + x),
    ...['parent', 'child'].map((x) => 'role.' + x),
    ...['none', 'daily', 'weekly', 'monthly'].map((x) => 'repeat.' + x),
    ...['fixed', 'rotate', 'first'].map((x) => 'task.mode_' + x + '_short'),
    ...Object.keys(require('../server/util').STATUS).map((c) => 'error.' + c),
  ];
  for (const k of dyn) for (const l of ['de', 'en']) assert.ok(texts[l][k], `${l}: ${k}`);
  assert.deepEqual(Object.keys(push.TEXTS.de).sort(), Object.keys(push.TEXTS.en).sort(), 'push texts in both languages');
});

test('Leaflet: one constant (server/ui.js), nowhere else', () => {
  const root = path.join(__dirname, '..');
  const hits = [];
  for (const sub of ['server', 'ui']) {
    for (const f of fs.readdirSync(path.join(root, sub))) {
      const src = fs.readFileSync(path.join(root, sub, f), 'utf8');
      if (src.includes('/leaflet/leaflet.js')) hits.push(`${sub}/${f}`);
    }
  }
  assert.deepEqual(hits, ['server/ui.js']);
  assert.match(ui.LEAFLET.js, /^\/[A-Za-z0-9_./-]+\.js$/);
  assert.match(ui.LEAFLET.css, /^\/[A-Za-z0-9_./-]+\.css$/);
  assert.equal(ui.TILES, 'https://tile.openstreetmap.org/{z}/{x}/{y}.png');
});

test('plugin.json: permissions (kiosk), app tab, maps, the eight topics with SOS allowed critical', () => {
  assert.equal(manifest.id, 'gatecontrol-familie');
  assert.equal(manifest.version, '1.1.1');
  assert.equal(manifest.gatecontrol, '>=1.165.0', 'permissions.kiosk needs GateControl 1.165.0');
  const p = manifest.permissions;
  assert.deepEqual([p.storage, p.portal, p.users, p.app, p.notify, p.background, p.kiosk], [true, true, true, true, { perHour: 120 }, { intervalSeconds: 60 }, true]);
  assert.deepEqual(manifest.ui.pages.map((x) => x.id), ['members', 'modules', 'log']);
  assert.equal(manifest.ui.maps, true);
  const ICON = /^[MmLlHhVvCcSsQqTtAaZz0-9 .,-]{1,600}$/;
  for (const k of ['nav', 'portal', 'app']) {
    assert.ok(ICON.test(manifest.ui[k].icon), k);
    assert.deepEqual(manifest.ui[k].label, { de: 'Familie', en: 'Family' });
  }
  assert.deepEqual(manifest.notifyTopics.map((x) => x.id), ['shopping', 'tasks', 'dates', 'locate', 'arrival', 'sos', 'places', 'rides']);
  assert.deepEqual(manifest.notifyTopics.find((x) => x.id === 'rides').label, { de: 'Abholen & Fahrten', en: 'Pick-ups & rides' });
  assert.deepEqual(manifest.notifyTopics.filter((x) => x.allowCritical).map((x) => x.id), ['sos']);
  for (const tp of manifest.notifyTopics) assert.ok(tp.label.de && tp.label.en && tp.label.de.length <= 60 && tp.label.en.length <= 60);
});
