'use strict';

// The viewer of pictures and videos (1.21.0, ui/viewer.js) in the small fake DOM against the mock host: a click on a
// picture in "Dateien" opens it full size (no download), ← → go through the pictures and videos of the folder, a video
// plays from the signed URL, a file the virus scan holds back shows its reason and asks for no URL, a marked one only
// after "Trotzdem ansehen", a type the browser cannot play says so; Esc closes; other files keep their preview;
// "Fotos" opens the same viewer over the photos shown.

const test = require('node:test');
const assert = require('node:assert/strict');
const ui = require('../server/ui');
const { t } = require('../server/text');
const { withHost, ANNA } = require('./helpers');
const { createWindow } = require('./fake-dom');

const portalHtml = (o) => ui.render({ view: 'portal', lang: 'de', user: { id: 2, loggedIn: true }, ...o }, t);
const tick = () => new Promise((r) => setTimeout(r, 2));
async function until(what, fn, n = 1500) {
  for (let i = 0; i < n; i++) {
    const v = fn();
    if (v) return v;
    await tick();
  }
  throw new Error('timed out waiting for ' + what);
}
const textOf = (n) => (n.nodeType === 3 ? n.data : n.childNodes.map(textOf).join(''));
const byText = (root, tag, text) => root.querySelectorAll(tag).find((e) => textOf(e).trim() === text);
const byLabel = (root, label) => root.querySelectorAll('button').find((e) => e.getAttribute('aria-label') === label);

function frameGc(host, user, calls) {
  const viewer = { ...user, portal: true, loggedIn: true };
  return {
    async call(method, p, body) {
      const [pathPart, qs] = String(p).split('?');
      const query = Object.fromEntries(new URLSearchParams(qs || ''));
      calls.push({ method, path: pathPart });
      const r = await host.request({ method, path: pathPart, query, body: body === undefined ? null : body, user: viewer, lang: 'de' });
      if (r.status !== 200) { const e = new Error('http ' + r.status); e.status = r.status; e.data = r.json; throw e; }
      return r.json;
    },
    async upload() { throw new Error('no upload here'); },
    async mediaBytes(url, o) {
      const r = await host.mediaFromUrl(url, { range: `bytes=${o.start}-${o.end}` });
      return { data: r.body };
    },
    on() {},
  };
}

const key = (f, k) => f.document.getElementById('dp-root').dispatchEvent({ type: 'keydown', key: k });

test('viewer: a picture opens full size, ← → through the folder\'s pictures and videos, a video plays, Esc', async () => {
  const scanner = (x) => {
    const s = x.data.toString();
    if (s === 'pending') return { state: 'pending' };
    if (s === 'macro') return { state: 'infected', blocked: false, finding: 'GC.Test' };
    return null;
  };
  await withHost({ scan: scanner }, async (host, c) => {
    const mine = await c.area(ANNA, 'mine');
    await c.put(ANNA, mine.rootId, 'a-Strand.jpg', 'jpg1', { mime: 'image/jpeg' });
    await c.put(ANNA, mine.rootId, 'b-Berg.png', 'png1', { mime: 'image/png' });
    await c.put(ANNA, mine.rootId, 'c-Brief.txt', 'hallo');
    await c.put(ANNA, mine.rootId, 'd-Film.mp4', 'mp4-bytes', { mime: 'video/mp4' });
    await c.put(ANNA, mine.rootId, 'e-Neu.mp4', 'pending', { mime: 'video/mp4' });
    await c.put(ANNA, mine.rootId, 'f-Warnung.webm', 'macro', { mime: 'video/webm' });
    const calls = [];
    const f = createWindow(portalHtml(), frameGc(host, ANNA, calls));
    const $ = (id) => f.document.getElementById(id);
    const vw = () => $('dp-root').querySelector('.dp-vw');
    const title = () => textOf(vw().querySelector('.dp-vw-title'));
    const contentCalls = () => calls.filter((x) => /\/content$/.test(x.path)).length;
    try {
      f.run();
      const b = await until('the switch', () => byText($('dp-pages'), 'button', 'Dateien'));
      b.click();
      await until('files', () => byText($('dp-main'), 'span', 'a-Strand.jpg'));
      const card = (name) => $('dp-main').querySelectorAll('.dp-card').find((x) => textOf(x).includes(name));
      card('a-Strand.jpg').querySelector('.dp-open').click();
      await until('the viewer', () => vw());
      assert.equal(title(), 'a-Strand.jpg');
      assert.ok($('dp-app').hidden, 'the list goes away meanwhile');
      assert.ok(textOf(vw()).includes('1 / 5'), 'pictures and videos of the folder, not the text');
      await until('the original', () => /^\/plugin-media\//.test(vw().querySelector('.dp-vw-img').getAttribute('src') || '') || (vw().querySelector('.dp-vw-img') && contentCalls() === 1));
      assert.ok(byLabel(vw(), 'Vergrößern') && byLabel(vw(), 'Verkleinern'), 'zoom');
      assert.ok(byLabel(vw(), 'Herunterladen') && byLabel(vw(), 'Teilen') && byLabel(vw(), 'Details'));
      // zoom: + and the picture is scaled
      key(f, '+');
      assert.match(vw().querySelector('.dp-vw-img').style.transform, /scale\(1\.5\)/);
      key(f, '0');
      assert.equal(vw().querySelector('.dp-vw-img').style.transform, '');
      // the details
      byLabel(vw(), 'Details').click();
      const info = vw().querySelector('.dp-vw-info');
      assert.ok(!info.hidden && textOf(info).includes('Größe') && textOf(info).includes('image/jpeg') && textOf(info).includes('Meine Dateien'));
      // → the next: the PNG, then the video
      key(f, 'ArrowRight');
      assert.equal(title(), 'b-Berg.png');
      key(f, 'ArrowRight');
      assert.equal(title(), 'd-Film.mp4');
      const video = await until('the video', () => { const v = vw().querySelector('.dp-vw-video'); return v && v.getAttribute('src') ? v : null; });
      assert.match(video.getAttribute('src'), /^\/plugin-media\//, 'streamed from the signed URL (GateControl answers Range)');
      assert.ok(video.hasAttribute('controls'));
      assert.equal(video.getAttribute('preload'), 'metadata', 'nothing loaded whole first');
      assert.ok(!byLabel(vw(), 'Vergrößern'), 'no zoom for a video');
      // still being checked: its reason, no URL asked for
      const before = contentCalls();
      key(f, 'ArrowRight');
      assert.equal(title(), 'e-Neu.mp4');
      assert.ok(textOf(vw()).includes('Der Virenscan prüft diese Datei noch'));
      assert.ok(!vw().querySelector('.dp-vw-video'));
      assert.ok(!byLabel(vw(), 'Herunterladen'), 'no download either');
      assert.equal(contentCalls(), before);
      // marked as malware: only after "Trotzdem ansehen"
      key(f, 'ArrowRight');
      assert.equal(title(), 'f-Warnung.webm');
      assert.ok(textOf(vw()).includes('Öffne sie nur, wenn du ihr vertraust'));
      assert.equal(contentCalls(), before);
      byText(vw(), 'span', 'Trotzdem ansehen').parentNode.click();
      await until('the marked video', () => { const v = vw().querySelector('.dp-vw-video'); return v && v.getAttribute('src'); });
      // the last one: → stays, ← goes back
      key(f, 'ArrowRight');
      assert.equal(title(), 'f-Warnung.webm');
      key(f, 'ArrowLeft');
      assert.equal(title(), 'e-Neu.mp4');
      // Esc closes, the list is back
      key(f, 'Escape');
      assert.equal(vw(), null);
      assert.ok(!$('dp-app').hidden);
      // a text file keeps its preview (no viewer)
      card('c-Brief.txt').querySelector('.dp-open').click();
      await until('the preview', () => !$('dp-dialog').hidden);
      assert.equal(vw(), null);
    } finally {
      f.stop();
    }
  });
});

test('viewer: a video the browser cannot play says so, with "Herunterladen"; a playback error too', async () => {
  await withHost({}, async (host, c) => {
    const mine = await c.area(ANNA, 'mine');
    await c.put(ANNA, mine.rootId, 'Konzert.mkv', 'mkv-bytes', { mime: 'video/x-matroska' });
    await c.put(ANNA, mine.rootId, 'Party.mp4', 'hevc-bytes', { mime: 'video/mp4' });
    const calls = [];
    const f = createWindow(portalHtml(), frameGc(host, ANNA, calls));
    const $ = (id) => f.document.getElementById(id);
    const vw = () => $('dp-root').querySelector('.dp-vw');
    try {
      f.run();
      // a browser that plays MP4 but not Matroska
      const make = f.document.createElement.bind(f.document);
      f.document.createElement = (tag) => {
        const el = make(tag);
        if (tag === 'video') el.canPlayType = (m) => (m === 'video/mp4' ? 'maybe' : '');
        return el;
      };
      const b = await until('the switch', () => byText($('dp-pages'), 'button', 'Dateien'));
      b.click();
      await until('files', () => byText($('dp-main'), 'span', 'Konzert.mkv'));
      const card = (name) => $('dp-main').querySelectorAll('.dp-card').find((x) => textOf(x).includes(name));
      card('Konzert.mkv').querySelector('.dp-open').click();
      await until('the viewer', () => vw());
      assert.ok(textOf(vw()).includes('Dieses Video (MKV) kann dein Browser nicht abspielen'));
      assert.ok(byText(vw(), 'span', 'Trotzdem abspielen'));
      assert.ok(byText(vw().querySelector('.dp-vw-stage'), 'span', 'Herunterladen'));
      // "Trotzdem abspielen" tries it
      byText(vw(), 'span', 'Trotzdem abspielen').parentNode.click();
      const v = await until('the video', () => { const x = vw().querySelector('.dp-vw-video'); return x && x.getAttribute('src') ? x : null; });
      // the browser fails to decode it: the same hint
      v.dispatchEvent({ type: 'error' });
      assert.ok(textOf(vw()).includes('kann dein Browser nicht abspielen'));
      assert.ok(!vw().querySelector('.dp-vw-video'));
      // "Herunterladen" in the viewer: the bytes through GC.mediaBytes, a download of its own (not the inline URL)
      const clicked = [];
      const make2 = f.document.createElement;
      f.document.createElement = (tag) => {
        const el = make2(tag);
        if (tag === 'a') el.click = () => clicked.push(el.getAttribute('download'));
        return el;
      };
      f.window.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
      byText(vw().querySelector('.dp-vw-stage'), 'span', 'Herunterladen').parentNode.click();
      await until('the download', () => clicked.length === 1);
      assert.equal(clicked[0], 'Konzert.mkv');
    } finally {
      f.stop();
    }
  });
});

test('viewer: "Fotos" opens the photos shown in the same viewer', async () => {
  await withHost({ gatecontrol: '1.210.0' }, async (host, c) => {
    const mine = await c.area(ANNA, 'mine');
    for (const [name, t0] of [['Juni.jpg', Date.UTC(2026, 5, 3, 12)], ['Juli.jpg', Date.UTC(2026, 6, 4, 12)]]) {
      await c.put(ANNA, mine.rootId, name, name, { mime: 'image/jpeg', takenAt: t0 });
    }
    const calls = [];
    const f = createWindow(portalHtml(), frameGc(host, ANNA, calls));
    const $ = (id) => f.document.getElementById(id);
    const vw = () => $('dp-root').querySelector('.dp-vw');
    try {
      f.run();
      const b = await until('the switch', () => byText($('dp-pages'), 'button', 'Fotos'));
      b.click();
      await until('photos', () => $('dp-main').querySelectorAll('.dp-ph').length === 2);
      $('dp-main').querySelectorAll('.dp-ph')[0].click();
      await until('the viewer', () => vw());
      assert.equal(textOf(vw().querySelector('.dp-vw-title')), 'Juli.jpg', 'newest first, as shown');
      assert.ok(textOf(vw()).includes('1 / 2'));
      // the large preview at once
      assert.match(vw().querySelector('.dp-vw-img').getAttribute('src'), /\/preview/);
      key(f, 'ArrowRight');
      assert.equal(textOf(vw().querySelector('.dp-vw-title')), 'Juni.jpg');
      byLabel(vw(), 'Schließen').click();
      assert.equal(vw(), null);
    } finally {
      f.stop();
    }
  });
});
