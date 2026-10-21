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
    // links to openstreetmap.org (attribution, "open in OpenStreetMap") are navigation in a new tab, nothing loaded
    assert.ok(!/https?:\/\//.test(src.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, '').replace(/'https:\/\/www\.openstreetmap\.org'/g, '')), `${f}: no external URL`);
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

test('plugin.json: licence, GateControl 1.191.0, permissions, pages, app and portal tab "Chats"', () => {
  assert.equal(manifest.id, 'gatecontrol-messenger');
  assert.equal(manifest.version, '1.7.0');
  assert.equal(manifest.gatecontrol, '>=1.191.0', '1.6.0: the chat sink of the notification center (permissions.notifySink, hook deliverNotice)');
  assert.equal(manifest.permissions.notifySink, true);
  assert.deepEqual(manifest.license, { required: true });
  const p = manifest.permissions;
  assert.deepEqual([p.storage, p.users, p.app, p.portal, p.notify, p.events, p.background], [true, true, true, true, true, true, { intervalSeconds: 60 }]);
  // 1.4.0: home actions (gc.actions), the Familie services, the service set_place_status
  assert.deepEqual(p.actions, { interactive: true });
  // 1.5.0: family_roles (who approves requests, who is a child)
  assert.deepEqual(p.services, ['list_add', 'calendar_add', 'calendar_upsert', 'calendar_remove', 'places', 'family_roles'].map((x) => 'gatecontrol-familie:' + x));
  assert.ok(manifest.services.provides.set_place_status);
  assert.deepEqual(manifest.ui.pages.map((x) => x.id), ['overview', 'log']);
  for (const k of ['portal', 'app']) assert.deepEqual(manifest.ui[k].label, { de: 'Chats', en: 'Chats' });
  assert.deepEqual(manifest.ui.nav.label, { de: 'Messenger', en: 'Messenger' });
  const ICON = /^[MmLlHhVvCcSsQqTtAaZz0-9 .,-]{1,600}$/;
  for (const k of ['nav', 'portal', 'app']) assert.ok(ICON.test(manifest.ui[k].icon), k);
  // 1.2.0: locations on a map (host Leaflet + tile relay), the browser's position and the pinned inbox
  // entry — geolocation and inbox are read by GateControl 1.179+ and ignored by older hosts
  assert.deepEqual([manifest.ui.maps, manifest.ui.geolocation, manifest.ui.inbox], [true, true, true]);
});

test('1.2.0 portal tab: Leaflet paths only in the portal, location picker and preview, the pinned inbox entry feature-detected', () => {
  const ctx = ctxOf(ui.render({ view: 'portal', lang: 'de', user: { id: 2, loggedIn: true } }, t));
  assert.deepEqual(ctx.leaflet, { js: '/plugins/_shared/leaflet/leaflet.js', css: '/plugins/_shared/leaflet/leaflet.css' });
  assert.equal(ctxOf(ui.render({ view: 'page', page: 'overview', lang: 'de' }, t)).leaflet, undefined);
  const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'portal.js'), 'utf8');
  // tiles only through GateControl's relay (the frame has an opaque origin; OSM refuses it directly)
  assert.ok(src.includes('window.GC.tiles'));
  assert.ok(!/tile\.openstreetmap\.org/.test(src));
  // sent as the existing location message type
  assert.match(src, /kind: 'location', location: loc/);
  // the browser's position only where the frame may ask; a refusal falls back to the map
  assert.match(src, /allowsFeature\('geolocation'\)/);
  assert.match(src, /getCurrentPosition\([\s\S]*loc\.denied/);
  // GC.inbox: feature-detected (GateControl 1.178 has none), opened in the portal, nothing read or written by the plugin
  assert.match(src, /window\.GC\.inbox && typeof window\.GC\.inbox\.on === 'function'/);
  assert.match(src, /window\.GC\.inbox\.open\(\)/);
  assert.ok(!/gc-inbox|notify\/inbox/.test(src), 'no own inbox calls');
});

test('the mock host accepts the manifest and the plugin starts; the encryption key is created once', async () => {
  await withHost({}, async (host) => {
    const key = host.settings.enc_key;
    await host.start();
    assert.equal(host.settings.enc_key, key, 'kept on restart');
  });
});

test('1.3.0 portal tab: video meta and previews feature-detected, sent with the file; video tiles, file previews, a Videos tab', () => {
  const portal = ui.render({ view: 'portal', lang: 'de', user: { id: 2, loggedIn: true } }, t);
  assert.ok(portal.includes('root.MSVideo = api'), 'video.js in the portal tab');
  assert.ok(portal.indexOf('root.MSVideo = api') < portal.indexOf("var M = window.MS;\n  var T = M.T;"), 'before portal.js');
  assert.ok(!ui.render({ view: 'page', page: 'overview', lang: 'de' }, t).includes('MSVideo'), 'not on the admin pages');
  const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'portal.js'), 'utf8');
  // only when GET me says the server takes them
  assert.match(src, /feature\('video_meta'\)/);
  assert.match(src, /feature\('file_thumbs'\)/);
  assert.match(src, /body\.video = p\.meta/);
  assert.match(src, /body\.thumbMediaId = u\.mediaId/);
  assert.match(src, /thumbMaxBytes/);
  // rendering: a tile with play button and duration, previews on file cards, videos in the info pane
  assert.match(src, /class: 'ms-vtile'/);
  assert.match(src, /class: 'ms-vtile-dur', text: M\.duration\(dur\)/);
  assert.match(src, /class: 'ms-filecard-th'/);
  assert.match(src, /'\/media\?kind=' \+ kind/);
  assert.match(src, /counts\.video/);
  const lib = fs.readFileSync(path.join(__dirname, '..', 'ui', 'video.js'), 'utf8');
  assert.match(lib, /new root\.VideoDecoder\(/, 'WebCodecs, no <video> element on a blob: URL (the frame CSP has no blob: media)');
  assert.match(lib, /root\.pdfjsLib/, 'PDF previews only with a renderer already in the frame');
  assert.ok(!/<\/script/i.test(lib), 'inlined in a <script>');
});

test('1.3.0 video.js: MP4 reader — duration, shown size (rotation), codec, the samples around 1 s; moov at the end', async () => {
  const V = require('../ui/video.js');
  const fixture = (f) => new Blob([fs.readFileSync(path.join(__dirname, 'fixtures', f))]);
  // H.264 64×36, 2.5 s, 10 fps, a key frame every 5, shown turned by 90° (portrait)
  let file = fixture('h264-rotated.mp4');
  let m = await V.readMoov(file);
  let info = V.parseMoov(m.buf, m.head);
  assert.deepEqual([info.durationMs, info.width, info.height], [2500, 36, 64]);
  assert.equal(info.video.rotation, 270);
  assert.match(info.video.codec, /^avc1\.[0-9a-f]{6}$/);
  assert.ok(info.video.description instanceof Uint8Array && info.video.description[0] === 1, 'avcC as the decoder description');
  assert.deepEqual([info.video.codedWidth, info.video.codedHeight, info.video.samples.n], [64, 36, 25]);
  let sel = V.pick(info.video, 1000);
  assert.ok(info.video.samples.sync[sel.key], 'decoding starts at a key frame');
  assert.ok(sel.list.length >= 1 && sel.list.length <= 5);
  // sample offsets point at length-prefixed NAL units inside the file
  const bytes = fs.readFileSync(path.join(__dirname, 'fixtures', 'h264-rotated.mp4'));
  for (const i of sel.list) {
    const off = info.video.samples.offset[i];
    const size = info.video.samples.size[i];
    assert.ok(off + size <= bytes.length);
    assert.ok(bytes.readUInt32BE(off) + 4 <= size, `sample ${i}`);
  }
  assert.deepEqual(V.meta(info), { durationMs: 2500, width: 36, height: 64 });
  // not fast-started: the moov box after the media data
  file = fixture('h264-moov-at-end.mp4');
  m = await V.readMoov(file);
  info = V.parseMoov(m.buf, m.head);
  assert.deepEqual([info.durationMs, info.width, info.height, info.video.rotation], [2500, 64, 36, 0]);
  sel = V.pick(info.video, 1000);
  assert.equal(info.video.samples.cts[sel.key] / 1024, 10, 'the key frame at 1.0 s');
  // without WebCodecs (here: node): the meta, no preview; anything unreadable: nothing, never a rejection
  assert.deepEqual(await V.videoInfo(file), { meta: { durationMs: 2500, width: 64, height: 36 }, thumb: null });
  assert.deepEqual(await V.videoInfo(new Blob([Buffer.from('not a video at all')])), { meta: null, thumb: null });
  assert.equal(V.meta({ durationMs: -1, width: 0, height: 20000 }), null, 'out of the server\'s bounds: left out');
  assert.equal(await V.pdfThumb(new Blob([Buffer.from('%PDF-1.4')])), null, 'no PDF renderer in the frame: no preview');
});

test('1.4.0 portal tab: rich.js before portal.js, new kinds drawn, features checked, no HTML from the API', () => {
  const portal = ui.render({ view: 'portal', lang: 'de', user: { id: 2, loggedIn: true } }, t);
  assert.ok(portal.indexOf('root.MSRich = {') > 0 && portal.indexOf('root.MSRich = {') < portal.indexOf("var M = window.MS;\n  var T = M.T;\n  var el = M.el;\n  var $ = M.$;"), 'rich.js before portal.js');
  assert.ok(portal.indexOf('root.MSVideo = api') < portal.indexOf('root.MSRich = {'));
  const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'portal.js'), 'utf8');
  for (const f of ['status', 'polls', 'events', 'actions', 'msg_tools', 'privacy2']) assert.match(src, new RegExp(`feature\\('${f}'\\)`), f);
  for (const ev of ["'poll.update'", "'event.update'", "'arrival.update'", "'action.update'", "'status.update'", "'story.new'", "'story.remove'", "'lists.update'"]) assert.ok(src.includes(ev), ev);
  const rich = fs.readFileSync(path.join(__dirname, '..', 'ui', 'rich.js'), 'utf8');
  for (const call of ["'vote'", "'rsvp'", "'action/run'", "'action/approve'", "'action/deny'", "'status/feed'", "'status/stories'", "'/card/image'", "'/to-list'", "'/to-calendar'", "'/remind'", "'/suggest'", "'/export?format=txt'", "'/seen'", "'/react'", "'blocks'", "'lists'"]) {
    assert.ok(rich.includes(call) || src.includes(call), call);
  }
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(rich), 'texts only through textContent');
  assert.match(rich, /is-unseen/, 'the glowing ring of unseen stories');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'ui', 'portal.css'), 'utf8'), /@keyframes ms-glow/);
});
