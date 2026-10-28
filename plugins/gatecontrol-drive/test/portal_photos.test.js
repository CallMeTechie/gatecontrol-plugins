'use strict';

// The portal's pages of 1.7.0 in the small fake DOM against the mock host: "Fotos" (months, choosing, into an album),
// "Alben" (the photo frame), "Speicher" (duplicates into the trash), "Zeitreise" (preview, run, undo) — and the photo
// frame's own page on a kiosk device.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ui = require('../server/ui');
const { t } = require('../server/text');
const { withHost, ANNA, OMA } = require('./helpers');
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

test('smoke: "Fotos" by month, choose two, a new album; "Alben": the photo frame on', async () => {
  await withHost({ gatecontrol: '1.210.0' }, async (host, c) => {
    const mine = await c.area(ANNA, 'mine');
    for (const [name, t0] of [['Juni.jpg', Date.UTC(2026, 5, 3, 12)], ['Juli1.jpg', Date.UTC(2026, 6, 4, 12)], ['Juli2.jpg', Date.UTC(2026, 6, 5, 12)]]) {
      await c.put(ANNA, mine.rootId, name, name, { mime: 'image/jpeg', takenAt: t0 });
    }
    await c.put(ANNA, mine.rootId, 'Text.txt', 'kein Foto');
    const calls = [];
    const f = createWindow(portalHtml(), frameGc(host, ANNA, calls));
    const $ = (id) => f.document.getElementById(id);
    try {
      f.run();
      await until('the app', () => !$('dp-app').hidden && byText($('dp-nav'), 'span', 'Fotos'));
      byText($('dp-nav'), 'span', 'Fotos').parentNode.click();
      await until('months', () => textOf($('dp-main')).includes('Juli 2026') && textOf($('dp-main')).includes('Juni 2026'));
      assert.ok(textOf($('dp-main')).includes('2 Fotos'), 'the month\'s count');
      const tiles = $('dp-main').querySelectorAll('.dp-ph');
      assert.equal(tiles.length, 3, 'pictures only');
      assert.match(tiles[0].querySelector('img').getAttribute('src'), /^\/plugin-media\/.*\/preview$/);
      // choose two, a new album
      byText($('dp-main'), 'span', 'Auswählen').parentNode.click();
      await until('choosing', () => byText($('dp-main'), 'span', 'Zum Album hinzufügen'));
      $('dp-main').querySelectorAll('.dp-ph')[0].click();
      $('dp-main').querySelectorAll('.dp-ph')[1].click();
      await until('2 chosen', () => textOf($('dp-main')).includes('2 ausgewählt'));
      byText($('dp-main'), 'span', 'Zum Album hinzufügen').parentNode.click();
      const name = await until('dialog', () => $('dp-dialog').querySelector('input'));
      name.value = 'Sommer';
      byText($('dp-dialog'), 'span', 'Anlegen und hinzufügen').parentNode.click();
      await until('added', () => textOf($('dp-toast')).includes('2 Fotos sind jetzt im Album „Sommer“'));
      const al = (await c.as(ANNA)('GET', 'albums')).json.albums[0];
      assert.deepEqual([al.name, al.count], ['Sommer', 2]);
      // the album: on the photo frame (asks first)
      byText($('dp-nav'), 'span', 'Alben').parentNode.click();
      await until('album card', () => byText($('dp-main'), 'span', 'Sommer'));
      byText($('dp-main'), 'span', 'Sommer').parentNode.parentNode.click();
      await until('album page', () => byText($('dp-main'), 'span', 'Im Fotorahmen zeigen'));
      assert.equal($('dp-main').querySelectorAll('.dp-ph').length, 2);
      byText($('dp-main'), 'span', 'Im Fotorahmen zeigen').parentNode.click();
      await until('confirm', () => textOf($('dp-dialog')).includes('Wandtablets'));
      $('dp-dialog').querySelectorAll('button').find((b) => b.className.includes('dp-btn-primary')).click();
      await until('on', () => textOf($('dp-toast')).includes('läuft jetzt im Fotorahmen'));
      assert.equal((await c.as(ANNA)('GET', `albums/${al.id}`)).json.album.frame, true);
    } finally {
      f.stop();
    }
  });
});

test('smoke: "Speicher" — duplicates, the copy into the trash; "Zeitreise" — preview, run, undo', async () => {
  await withHost({}, async (host, c) => {
    const mine = await c.area(ANNA, 'mine');
    const fam = await c.area(ANNA, 'family');
    await c.put(ANNA, mine.rootId, 'Original.pdf', 'gleich', { mime: 'application/pdf' });
    c.clock.add(1000);
    const copy = (await c.put(ANNA, fam.rootId, 'Kopie.pdf', 'gleich', { mime: 'application/pdf' })).json.node;
    c.clock.add(120000);
    const calls = [];
    const f = createWindow(portalHtml(), frameGc(host, ANNA, calls));
    const $ = (id) => f.document.getElementById(id);
    try {
      f.run();
      await until('the app', () => !$('dp-app').hidden && byText($('dp-nav'), 'span', 'Speicher'));
      byText($('dp-nav'), 'span', 'Speicher').parentNode.click();
      await until('duplicates', () => textOf($('dp-main')).includes('Doppelte Dateien') && byText($('dp-main'), 'span', '1 Datei in den Papierkorb'));
      assert.ok(textOf($('dp-main')).includes('Die größten Dateien'));
      byText($('dp-main'), 'span', '1 Datei in den Papierkorb').parentNode.click();
      await until('confirm', () => textOf($('dp-dialog')).includes('kommt in den Papierkorb'));
      $('dp-dialog').querySelectorAll('button').find((b) => b.className.includes('dp-btn-danger')).click();
      await until('trashed', () => textOf($('dp-toast')).includes('1 Datei liegt im Papierkorb'));
      assert.equal((await c.as(ANNA)('GET', `nodes/${copy.id}`)).status, 404, 'the younger copy is in the trash');
      // the time travel of my files: back to before the copy went into the trash
      c.clock.add(120000);
      byText($('dp-nav'), 'span', 'Familie Berg').parentNode.click();
      await until('family', () => byText($('dp-tools'), 'span', 'Zeitreise'));
      byText($('dp-tools'), 'span', 'Zeitreise').parentNode.click();
      const when = await until('the field', () => $('dp-dialog').querySelector('input'));
      const d = new Date(c.clock.now() - 150000); // the field has minutes: a minute between the copy and its delete
      const p = (n) => String(n).padStart(2, '0');
      when.value = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
      when.dispatchEvent({ type: 'change' });
      await until('preview', () => textOf($('dp-dialog')).includes('1 gelöschtes Element kommt zurück'));
      byText($('dp-dialog'), 'span', 'Zurücksetzen').parentNode.click();
      await until('done', () => textOf($('dp-dialog')).includes('Zeitreise abgeschlossen'));
      assert.equal((await c.as(ANNA)('GET', `nodes/${copy.id}`)).status, 200, 'back');
      byText($('dp-dialog'), 'span', 'Rückgängig machen').parentNode.click();
      await until('undone', () => textOf($('dp-toast')).includes('rückgängig gemacht'));
      assert.equal((await c.as(ANNA)('GET', `nodes/${copy.id}`)).status, 404, 'in the trash again');
    } finally {
      f.stop();
    }
  });
});

test('the photo frame\'s page on a kiosk device shows the pictures; elsewhere it says where it runs', async () => {
  await withHost({ gatecontrol: '1.210.0' }, async (host, c) => {
    const mine = await c.area(ANNA, 'mine');
    const pic = (await c.put(ANNA, mine.rootId, 'Wand.jpg', 'wand', { mime: 'image/jpeg', takenAt: Date.UTC(2025, 4, 6) })).json.node;
    const al = (await c.as(ANNA)('POST', 'albums', { name: 'Wand' })).json.album;
    await c.as(ANNA)('POST', `albums/${al.id}/items`, { ids: [pic.id] });
    await c.as(ANNA)('PATCH', `albums/${al.id}`, { frame: true });
    const KIOSK = { ...OMA, portal: true, loggedIn: true, kiosk: true };
    const gc = {
      async call(method, p) {
        const r = await host.request({ method, path: p, query: {}, body: null, user: KIOSK, lang: 'de' });
        if (r.status !== 200) throw Object.assign(new Error('http'), { status: r.status });
        return r.json;
      },
      on() {},
    };
    const f = createWindow(ui.render({ view: 'portal', section: 'frame', lang: 'de', user: KIOSK }, t), gc);
    const $ = (id) => f.document.getElementById(id);
    try {
      f.run();
      const img = await until('a picture', () => [$('df-a'), $('df-b')].find((x) => x.getAttribute('src')));
      assert.match(img.getAttribute('src'), /\/preview\?size=large$/);
      img.dispatchEvent({ type: 'load' });
      await until('shown', () => img.className.includes('is-on') && textOf($('df-when')) === 'Mai 2025');
    } finally {
      f.stop();
    }
    const g = createWindow(ui.render({ view: 'portal', section: 'frame', lang: 'de', user: { id: 2, loggedIn: true } }, t), gc);
    try {
      g.run();
      assert.ok(textOf(g.document.getElementById('df-msg')).includes('Wandtablets'));
    } finally {
      g.stop();
    }
  });
});

test('the frame page keeps the frame\'s rules (no modals, storage, innerHTML, eval, console, external URL)', () => {
  for (const f of ['frame.js', 'frame.html', 'frame.css']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'ui', f), 'utf8');
    assert.ok(!/\b(alert|confirm|prompt|print)\(/.test(src), f);
    assert.ok(!/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write/.test(src), f);
    assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie/.test(src), f);
    assert.ok(!/\beval\(|new Function|\bconsole\.\w+\(/.test(src), f);
    assert.ok(!/https?:\/\/[\w.-]/.test(src), f);
  }
});

/** A tiny JPEG with EXIF DateTimeOriginal (and OffsetTimeOriginal when `offset`), big-endian TIFF. */
function jpegWithExif(when, offset) {
  const tiff = Buffer.alloc(90);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8); // IFD0: one entry — the pointer to the Exif IFD
  tiff.writeUInt16BE(0x8769, 10); tiff.writeUInt16BE(4, 12); tiff.writeUInt32BE(1, 14); tiff.writeUInt32BE(26, 18);
  tiff.writeUInt32BE(0, 22);
  tiff.writeUInt16BE(offset ? 2 : 1, 26);
  tiff.writeUInt16BE(0x9003, 28); tiff.writeUInt16BE(2, 30); tiff.writeUInt32BE(20, 32); tiff.writeUInt32BE(56, 36);
  if (offset) { tiff.writeUInt16BE(0x9011, 40); tiff.writeUInt16BE(2, 42); tiff.writeUInt32BE(7, 44); tiff.writeUInt32BE(76, 48); }
  tiff.write(when + '\0', 56, 'latin1');
  if (offset) tiff.write(offset + '\0', 76, 'latin1');
  const app1 = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(app1.length + 2);
  return Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE1]), len, app1, Buffer.from([0xFF, 0xD9])]);
}

test('upload in the portal: takenAt from a JPEG\'s EXIF (with its offset, else the browser\'s time), else the file\'s date', async () => {
  await withHost({}, async (host, c) => {
    const calls = [];
    const gc = frameGc(host, ANNA, calls);
    gc.upload = async (file) => {
      const r = await host.upload(ANNA, Buffer.from(file.data), file.type);
      return { mediaId: r.body.mediaId, mime: r.body.mime, bytes: r.body.bytes };
    };
    const asFile = (name, data, type, lastModified) => ({
      name, type, size: data.length, lastModified, data,
      slice: (a, b) => ({ arrayBuffer: async () => { const s = data.subarray(a, b); return s.buffer.slice(s.byteOffset, s.byteOffset + s.length); } }),
    });
    const f = createWindow(portalHtml(), gc);
    const $ = (id) => f.document.getElementById(id);
    try {
      f.run();
      await until('the app', () => !$('dp-app').hidden && byText($('dp-tools'), 'span', 'Hochladen'));
      const files = [
        asFile('Exif.jpg', jpegWithExif('2024:07:14 18:30:05', '+02:00'), 'image/jpeg', Date.UTC(2026, 0, 1)),
        asFile('Lokal.jpg', jpegWithExif('2024:07:14 18:30:05', null), 'image/jpeg', Date.UTC(2026, 0, 1)),
        asFile('Ohne.png', Buffer.from('png'), 'image/png', Date.UTC(2025, 2, 3)),
        asFile('Text.txt', Buffer.from('txt'), 'text/plain', Date.UTC(2025, 2, 3)),
      ];
      $('dp-file').files = files;
      $('dp-file').dispatchEvent({ type: 'change', target: $('dp-file') });
      await until('committed', () => calls.filter((x) => x.path === 'uploads/commit').length === 4);
      const body = (n) => calls.find((x) => x.path === 'uploads/commit' && x.body.name === n).body;
      assert.equal(body('Exif.jpg').takenAt, Date.UTC(2024, 6, 14, 16, 30, 5));
      assert.equal(body('Lokal.jpg').takenAt, new Date(2024, 6, 14, 18, 30, 5).getTime(), 'no offset: the browser\'s time');
      assert.equal(body('Ohne.png').takenAt, Date.UTC(2025, 2, 3), 'no EXIF: the file\'s date');
      assert.equal(body('Text.txt').takenAt, undefined, 'not a picture: the server takes mtime');
      await until('done', () => textOf($('dp-ups')).includes('Hochgeladen'));
    } finally {
      f.stop();
    }
  });
});
