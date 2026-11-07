'use strict';

// The portal's "Alle · Fotos · Videos" (1.25.0, feature mediaFilter) in the small fake DOM against the mock host: on
// "Fotos" (photos?media=, the video's length on its tile) and over the hits of the search (search?media=, an empty field
// then lists the newest videos).

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
const navItem = (nav, label) => {
  const icon = nav.querySelectorAll('[aria-label]').find((e) => e.getAttribute('aria-label') === label);
  if (icon) return icon;
  let n = byText(nav, 'span', label);
  while (n && n.localName !== 'button') n = n.parentNode;
  return n || null;
};

function frameGc(host, user, calls) {
  const viewer = { ...user, portal: true, loggedIn: true };
  return {
    async call(method, p, body) {
      const [pathPart, qs] = String(p).split('?');
      const query = Object.fromEntries(new URLSearchParams(qs || ''));
      calls.push({ method, path: pathPart, query, body });
      const r = await host.request({ method, path: pathPart, query, body: body === undefined ? null : body, user: viewer, lang: 'de' });
      if (r.status !== 200) { const e = new Error('http ' + r.status); e.status = r.status; e.data = r.json; throw e; }
      return r.json;
    },
    async upload() { throw new Error('no upload here'); },
    on() {},
  };
}

test('"Fotos": Alle · Fotos · Videos, the length of a video on its tile', async () => {
  await withHost({ gatecontrol: '1.210.0' }, async (host, c) => {
    const mine = await c.area(ANNA, 'mine');
    await c.put(ANNA, mine.rootId, 'Strand.jpg', 'p', { mime: 'image/jpeg', takenAt: Date.UTC(2026, 5, 3, 12) });
    await c.put(ANNA, mine.rootId, 'Strand.mp4', 'v', { mime: 'video/mp4', takenAt: Date.UTC(2026, 5, 4, 12), durationMs: 83000 });
    const calls = [];
    const f = createWindow(portalHtml(), frameGc(host, ANNA, calls));
    const $ = (id) => f.document.getElementById(id);
    try {
      f.run();
      await until('the app', () => !$('dp-app').hidden && navItem($('dp-nav'), 'Fotos'));
      navItem($('dp-nav'), 'Fotos').click();
      await until('the photos', () => $('dp-main').querySelectorAll('.dp-ph').length === 2);
      const seg = $('dp-main').querySelector('.dp-media-seg');
      assert.ok(seg, 'the filter');
      assert.deepEqual(seg.querySelectorAll('button').map((b) => [textOf(b), b.getAttribute('aria-pressed')]), [['Alle', 'true'], ['Fotos', 'false'], ['Videos', 'false']]);
      assert.ok(textOf($('dp-main')).includes('1:23'), 'the video\'s length');
      byText(seg, 'button', 'Videos').click();
      await until('only the video', () => $('dp-main').querySelectorAll('.dp-ph').length === 1);
      assert.equal($('dp-main').querySelector('.dp-ph').getAttribute('aria-label'), 'Strand.mp4');
      assert.ok(calls.some((x) => x.path === 'photos' && x.query.media === 'video'));
      assert.ok(calls.some((x) => x.path === 'photos/months' && x.query.media === 'video'));
      byText($('dp-main').querySelector('.dp-media-seg'), 'button', 'Fotos').click();
      await until('only the picture', () => $('dp-main').querySelectorAll('.dp-ph').length === 1 && $('dp-main').querySelector('.dp-ph').getAttribute('aria-label') === 'Strand.jpg');
    } finally {
      f.stop();
    }
  });
});

test('search: Videos over the hits, an empty field then lists the newest videos', async () => {
  await withHost({ gatecontrol: '1.210.0' }, async (host, c) => {
    const mine = await c.area(ANNA, 'mine');
    await c.put(ANNA, mine.rootId, 'Urlaub.jpg', 'p', { mime: 'image/jpeg' });
    await c.put(ANNA, mine.rootId, 'Urlaub.mp4', 'v', { mime: 'video/mp4' });
    await c.put(ANNA, mine.rootId, 'Hochzeit.mp4', 'v2', { mime: 'video/mp4' });
    const calls = [];
    const f = createWindow(portalHtml(), frameGc(host, ANNA, calls));
    const $ = (id) => f.document.getElementById(id);
    try {
      f.run();
      await until('the app', () => !$('dp-app').hidden);
      const q = $('dp-q');
      q.value = 'Urlaub';
      q.dispatchEvent({ type: 'input' });
      await until('the hits', () => byText($('dp-main'), 'span', 'Urlaub.jpg') && byText($('dp-main'), 'span', 'Urlaub.mp4'));
      const seg = await until('the filter', () => $('dp-main').querySelector('.dp-media-seg'));
      byText(seg, 'button', 'Videos').click();
      await until('only the video', () => byText($('dp-main'), 'span', 'Urlaub.mp4') && !byText($('dp-main'), 'span', 'Urlaub.jpg'));
      assert.ok(calls.some((x) => x.path === 'search' && x.query.q === 'Urlaub' && x.query.media === 'video'));
      // the field emptied: the newest videos
      q.value = '';
      q.dispatchEvent({ type: 'input' });
      await until('every video', () => byText($('dp-main'), 'span', 'Hochzeit.mp4') && byText($('dp-main'), 'span', 'Urlaub.mp4'));
      assert.ok(calls.some((x) => x.path === 'search' && !x.query.q && x.query.media === 'video'));
    } finally {
      f.stop();
    }
  });
});
