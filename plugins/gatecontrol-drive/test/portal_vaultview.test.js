'use strict';

// The viewer of vault files in the portal (1.22.0, ui/vaultview.js) in the fake DOM against the mock host: it comes
// with GET viewer/vaultview (not part of the page), shows a picture, a PDF, a text and Markdown decrypted in memory —
// never a URL, never a download, nothing handed to the page — and drops everything when it closes, when the vault
// locks (by hand, by time, the tab left) and when a decryption is still running. Videos, office files and files too
// large get a note and are not decrypted at all. pdf.js comes in pieces (GET viewer/pdfjs) that fit GateControl's answers.
// Since 1.29.0 office files (docx, xlsx, pptx, odt, ods, odp) are read in the tab too (ui/vaultoffice.js, its own
// tests in vault_office.test.js): shown as text and tables built from text nodes — nothing of a prepared file becomes
// an element, an attribute or an address; older formats, files with a password and files that are not safe get a note.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ui = require('../server/ui');
const viewer = require('../server/viewer');
const texts = require('../server/texts.json');
const { t } = require('../server/text');
const VC = require('../ui/vaultcrypto');
const VV = require('../ui/vaultview');
const { withHost, ANNA, MIN } = require('./helpers');
const { createWindow } = require('./fake-dom');
const F = require('./office-files');

const portalHtml = () => ui.render({ view: 'portal', lang: 'de', user: { id: ANNA.id, loggedIn: true } }, t);
const tick = () => new Promise((r) => setTimeout(r, 2));
async function until(what, fn, n = 2500) {
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
  let n = byText(nav, 'span', label);
  while (n && n.localName !== 'button') n = n.parentNode;
  return n || null;
};
const click = (root, text) => { let s = byText(root, 'span', text); assert.ok(s, `no button "${text}"`); while (s.localName !== 'button' && s.parentNode) s = s.parentNode; s.click(); };
const ib = (root, label) => root.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === label);
const viewerOf = (w) => w.document.body.querySelectorAll('[data-vault-viewer]')[0] || null;

/** window.GC of a portal frame: GC.keys, GC.mediaBytes (counted), and no way out recorded (saveFile, openTab). */
function frameGc(host, user, keys, seen) {
  const viewerUser = { ...user, portal: true, loggedIn: true };
  return {
    async call(method, p, body) {
      const [pathPart, qs] = String(p).split('?');
      const query = Object.fromEntries(new URLSearchParams(qs || ''));
      seen.calls.push(method + ' ' + pathPart);
      const r = await host.request({ method, path: pathPart, query, body: body === undefined ? null : body, user: viewerUser, lang: 'de' });
      if (r.status !== 200) { const e = new Error('http ' + r.status); e.status = r.status; e.data = r.json; throw e; }
      return r.json;
    },
    on() {},
    keys: {
      get: async (name) => (keys.has(name) ? keys.get(name) : null),
      put: async (name, k) => { keys.set(name, k); return true; },
      remove: async (name) => keys.delete(name),
    },
    async mediaBytes(url, o) {
      seen.reads++;
      if (seen.gate) await seen.gate;
      const r = await host.mediaFromUrl(url, { range: `bytes=${o.start}-${o.end}` });
      const b = Buffer.from(r.body);
      return { data: b.buffer.slice(b.byteOffset, b.byteOffset + b.length), start: o.start, end: o.end, total: 0 };
    },
    saveFile: async () => { seen.out.push('saveFile'); return { ok: true }; },
    openTab: () => { seen.out.push('openTab'); },
  };
}

const fileOf = (name, data) => ({ name, size: data.length, slice: (a, b) => ({ arrayBuffer: async () => { const x = Buffer.from(data).subarray(a, b); return x.buffer.slice(x.byteOffset, x.byteOffset + x.length); } }) });

/** A vault of Anna's with files made here (the device key in GC.keys) → { vault, tk, keys } */
async function vaultWith(host, c, files) {
  const mine = await c.area(ANNA, 'mine');
  const kp = await VC.generateDeviceKey();
  const raw = await VC.exportPublic(kp.publicKey);
  const id = VC.newVaultId();
  const tk = VC.newVaultKey();
  const rec = VC.newRecoveryKey();
  const rk = await VC.recoveryKeyPair(rec.key);
  const a = c.as(ANNA);
  const r = await a('POST', 'vaults', { id, parentId: mine.rootId, nameCipher: await VC.encryptName(tk, id, 1, 'Privat'), recoveryPub: VC.b64u(rk.publicRaw), recoveryAuth: await VC.recoveryAuth(rec.key),
    recoveryWrap: await VC.wrapKey(tk, rk.publicRaw, id, 1), device: { publicKey: VC.b64u(raw), name: 'Browser', platform: 'web' }, wrap: await VC.wrapKey(tk, raw, id, 1) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const vault = r.json.vault;
  for (const [name, data] of Object.entries(files)) {
    const parts = await VC.encryptContent(tk, id, 1, fileOf(name, Buffer.from(data)));
    const up = await host.upload(ANNA, Buffer.concat(parts.map((p) => Buffer.from(p))), 'application/octet-stream');
    const cm = await a('POST', 'uploads/commit', { mediaId: up.body.mediaId, parentId: vault.nodeId, encrypted: true, nameCipher: await VC.encryptName(tk, id, 1, name), keyVersion: 1 });
    assert.equal(cm.status, 200, JSON.stringify(cm.json));
  }
  const keys = new Map([['drive-device-' + ANNA.id, { publicKey: kp.publicKey, privateKey: kp.privateKey }]]);
  return { vault, tk, keys };
}

/** The portal open in the vault, unlocked: { w, $, seen, plain } — plain: every plaintext chunk the viewer got. */
async function openVault(host, c, files, o = {}) {
  const { keys } = await vaultWith(host, c, files);
  const seen = { calls: [], reads: 0, out: [], urls: [], gate: null };
  const w = createWindow(portalHtml(), frameGc(host, ANNA, keys, seen));
  const $ = (id) => w.document.getElementById(id);
  const plain = [];
  w.window.URL = { createObjectURL: (x) => { seen.urls.push(x); return 'blob:null/x'; }, revokeObjectURL() {} };
  if (o.decoder !== false) {
    // ImageDecoder of WebCodecs: decodes the bytes, no URL (records what it got and what was closed)
    w.window.ImageDecoder = class {
      static isTypeSupported() { return true; }
      constructor(init) { this.init = init; seen.decoder = this; this.closed = false; }
      async decode() { const self = this; this.frame = { displayWidth: 40, displayHeight: 30, closed: false, close() { this.closed = true; } }; return { image: self.frame }; }
      close() { this.closed = true; }
    };
  }
  if (o.pdfjs) w.window.pdfjsLib = o.pdfjs;
  // the browser's inflate (office files, 1.29.0)
  if (o.inflate !== false) w.window.DecompressionStream = DecompressionStream;
  // what the reader of office files was handed (the decrypted bytes): seen.office
  seen.office = [];
  let office = null;
  Object.defineProperty(w.window, 'DriveVaultOffice', { configurable: true, get: () => office, set: (v) => { office = { ...v, read: (b, n, x) => { seen.office.push(b); return v.read(b, n, x); } }; } });
  w.run();
  // the viewer as the server hands it over — run as an inline script by the fake DOM
  await until('the app', () => !$('dp-app').hidden && navItem($('dp-nav'), 'Verschlüsselt'));
  navItem($('dp-nav'), 'Verschlüsselt').click();
  await until('lock screen', () => textOf($('dp-main')).includes('Tresor gesperrt'));
  click($('dp-main'), 'Entsperren');
  await until('names', () => byText($('dp-main'), 'span', Object.keys(files)[0]));
  return { w, $, seen, plain };
}

/** Opens file `name` of the vault in the viewer; resolves when its content (or note) is shown. */
async function show(ctx, name, done) {
  let b = byText(ctx.$('dp-main'), 'span', name);
  while (b && b.localName !== 'button') b = b.parentNode;
  b.click();
  const v = await until('the viewer', () => viewerOf(ctx.w));
  await until('shown', () => done(v)).catch((e) => { console.log('VIEWER:', textOf(v)); throw e; });
  // the chunks the viewer holds: wrapped so the test can check they were overwritten
  return v;
}

test('viewer: not part of the page — GET viewer/vaultview hands over script, style and texts; pdf.js in pieces that fit GateControl\'s answers', async () => {
  const html = portalHtml();
  assert.ok(!html.includes('function jpegOrientation') && !html.includes('.dp-vv-back'), 'the viewer is not inlined');
  assert.ok(!html.includes('p.vv.'), 'nor its texts');
  assert.ok(Buffer.byteLength(html) < 1024 * 1024 * 0.6, 'the portal page budget of portal.test.js');
  const r = viewer.vaultview('de');
  // since 1.29.0: the reader of office files in front of the viewer, in one answer below GateControl's 1 MiB
  assert.equal(r.code, fs.readFileSync(path.join(__dirname, '..', 'ui', 'vaultoffice.js'), 'utf8') + '\n' + fs.readFileSync(path.join(__dirname, '..', 'ui', 'vaultview.js'), 'utf8'));
  assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, ...r })) < 1024 * 1024 * 0.5, 'the viewer fits one answer');
  assert.ok(!/\bnew Function\b|\beval\(|innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment|\.href\b|\.src\b/.test(r.code), 'the viewer builds no HTML and sets no address');
  assert.ok(r.css.includes('.dp-vv-back'));
  assert.equal(r.texts['p.vv.download'], 'Herunterladen');
  assert.equal(viewer.vaultview('en').texts['p.vv.download'], 'Download');
  for (const k of Object.keys(texts.de)) if (k.startsWith('p.vv.')) assert.ok(texts.en[k], 'en ' + k);
  // pdf.js: every piece below GateControl's 1 MiB per answer, joined they are exactly the vendored files
  const joined = { worker: '', lib: '' };
  const first = viewer.pdfjsPart({ part: 0 });
  for (let i = 0; i < first.parts; i++) {
    const p = viewer.pdfjsPart({ part: i });
    assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, ...p })) < 1024 * 1024, 'piece ' + i);
    joined[p.file] += p.code;
  }
  assert.equal(joined.worker, fs.readFileSync(path.join(viewer.DIR, 'pdf.worker.min.mjs'), 'utf8'));
  assert.equal(joined.lib, fs.readFileSync(path.join(viewer.DIR, 'pdf.min.mjs'), 'utf8'));
  assert.ok(!/\bnew Function\b|\beval\(/.test(joined.worker + joined.lib), 'pdf.js without eval (the frame CSP forbids it anyway)');
  assert.throws(() => viewer.pdfjsPart({ part: first.parts }), (e) => e.code === 'invalid');
  assert.ok(fs.existsSync(path.join(viewer.DIR, 'LICENSE')), 'its licence goes with it');
  await withHost({}, async (host, c) => {
    const a = c.as(ANNA);
    const v = await a('GET', 'viewer/vaultview');
    assert.equal(v.status, 200);
    assert.equal(v.json.texts['p.vv.download'], 'Herunterladen');
    const p = await a('GET', 'viewer/pdfjs', null, { part: 0 });
    assert.equal(p.status, 200);
    assert.equal(p.json.file, 'worker');
    assert.equal((await a('GET', 'viewer/pdfjs', null, { part: 99 })).status, 400);
  });
});

test('viewer: kinds and Markdown — text nodes only, never HTML of the file; the orientation of a JPEG', () => {
  assert.deepEqual(['a.JPG', 'b.png', 'c.pdf', 'd.md', 'e.txt', 'f.mp4', 'g.docx', 'h.heic', 'i.zip', 'noext'].map(VV.kindOf),
    ['image', 'image', 'pdf', 'markdown', 'text', 'video', 'office', 'heic', 'other', 'other']);
  const { Document } = require('./fake-dom');
  const doc = new Document();
  const h = (tag, o, kids) => {
    const n = doc.createElement(tag);
    if (o && o.text != null) n.textContent = o.text;
    if (o && o.class) n.className = o.class;
    (Array.isArray(kids) ? kids : kids == null ? [] : [kids]).forEach((k) => n.appendChild(typeof k === 'string' ? doc.createTextNode(k) : k));
    return n;
  };
  const out = VV.markdown(h, '# Titel\n\nText mit **fett** und `code` <script>alert(1)</script>\n\n- eins\n- [x] zwei\n\n```\n<b>roh</b>\n```\n> Zitat');
  assert.deepEqual(out.map((e) => e.localName), ['h2', 'p', 'ul', 'pre', 'blockquote']);
  assert.ok(textOf(out[1]).includes('<script>alert(1)</script>'), 'HTML stays text');
  assert.equal(out[1].querySelectorAll('script').length, 0);
  assert.equal(out[1].querySelectorAll('strong')[0].textContent, 'fett');
  assert.equal(textOf(out[2]), 'eins☑ zwei');
  assert.equal(textOf(out[3]), '<b>roh</b>');
  // EXIF orientation 6 (turned right) in a minimal JPEG APP1 segment, big endian
  const exif = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(VV.jpegOrientation(new Uint8Array(exif)), 6);
  assert.equal(VV.jpegOrientation(new Uint8Array([0x89, 0x50])), 1);
});

test('viewer: a picture decrypted in memory (ImageDecoder, no URL), zoom; closing drops the bytes, the frame and the canvas', async () => {
  await withHost({}, async (host, c) => {
    const pic = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xd9]), Buffer.alloc(3000, 7)]);
    const ctx = await openVault(host, c, { 'Foto.jpg': pic });
    try {
      const v = await show(ctx, 'Foto.jpg', (x) => x.querySelectorAll('canvas').length === 1);
      const canvas = v.querySelectorAll('canvas')[0];
      assert.equal(canvas.width, 40);
      assert.equal(canvas.height, 30);
      assert.equal(canvas.getContext('2d').drawn.length, 1, 'drawn once');
      const dec = ctx.seen.decoder;
      const got = dec.init.data;
      assert.ok(dec.frame.closed && dec.closed, 'the decoded frame and the decoder are closed once drawn');
      assert.ok(got.every((b) => b === 0), 'the decrypted bytes are overwritten once drawn');
      assert.deepEqual(ctx.seen.urls, [], 'no object URL');
      assert.ok(textOf(v).includes('nur im Speicher entschlüsselt'));
      // zoom in and back
      click(v, '+');
      assert.ok(canvas.style.width && canvas.style.width.endsWith('px'));
      click(v, 'Einpassen');
      assert.equal(canvas.style.width, '');
      // "Herunterladen" asks first, in the viewer (no confirm() in the sandbox)
      click(v, 'Herunterladen');
      await until('the question', () => textOf(v).includes('nicht verschlüsselt'));
      click(v, 'Abbrechen');
      assert.ok(!textOf(v).includes('nicht verschlüsselt'));
      // closed with the ✕: gone, the canvas emptied
      v.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === 'Schließen').click();
      assert.equal(viewerOf(ctx.w), null);
      assert.equal(canvas.width, 0);
      assert.equal(canvas.height, 0);
      assert.deepEqual(ctx.seen.out, [], 'nothing left the tab');
      assert.ok(!ctx.seen.calls.some((x) => /viewer\/pdfjs/.test(x)), 'no PDF renderer for a picture');
    } finally { ctx.w.stop(); }
  });
});

test('viewer: a text and Markdown; Escape closes; the lock (by hand, by time, the tab left) closes the viewer and forgets everything', async () => {
  await withHost({}, async (host, c) => {
    const ctx = await openVault(host, c, { 'Notiz.txt': 'Zugang Keller: 4711\n<b>nicht fett</b>', 'Liste.md': '# Einkauf\n\n- Milch\n- **Brot**' });
    try {
      let v = await show(ctx, 'Notiz.txt', (x) => x.querySelectorAll('pre').length === 1);
      const pre = v.querySelectorAll('pre')[0];
      assert.equal(pre.textContent, 'Zugang Keller: 4711\n<b>nicht fett</b>');
      assert.equal(pre.querySelectorAll('b').length, 0);
      ctx.w.document._bubble({ type: 'keydown', key: 'Escape', stopPropagation() {} });
      assert.equal(viewerOf(ctx.w), null, 'Escape closes it');
      assert.equal(pre.textContent, '', 'the text is dropped');

      v = await show(ctx, 'Liste.md', (x) => x.querySelectorAll('h2').length === 1);
      assert.equal(textOf(v.querySelectorAll('ul')[0]), 'MilchBrot');
      // "Jetzt sperren" — the lock closes the viewer first
      const md = v.querySelectorAll('.dp-vv-md')[0];
      ib(v, 'Tresore jetzt sperren').click();
      await until('locked', () => viewerOf(ctx.w) === null);
      assert.equal(md.childNodes.length, 0);

      // by time: 3 minutes without anything done (the default of the Drive settings)
      (await until('the vault locked in the menu', () => navItem(ctx.$('dp-nav'), 'Verschlüsselt'))).click();
      await until('lock screen', () => textOf(ctx.$('dp-main')).includes('Tresor gesperrt'));
      click(ctx.$('dp-main'), 'Entsperren');
      await until('names', () => byText(ctx.$('dp-main'), 'span', 'Notiz.txt'));
      v = await show(ctx, 'Notiz.txt', (x) => x.querySelectorAll('pre').length === 1);
      c.clock.add(2 * MIN);
      v.dispatchEvent({ type: 'pointerdown' });
      assert.ok(viewerOf(ctx.w), 'use in the viewer keeps it open');
      c.clock.add(3 * MIN + 1000);
      v.dispatchEvent({ type: 'pointerdown' });
      await until('locked by time', () => viewerOf(ctx.w) === null && textOf(ctx.$('dp-toast')).includes('Tresore gesperrt.'));

      // the tab left (Drive settings "Beim Verlassen des Tabs sperren" is on by default)
      (await until('the vault locked in the menu 2', () => navItem(ctx.$('dp-nav'), 'Verschlüsselt'))).click();
      await until('lock screen 2', () => textOf(ctx.$('dp-main')).includes('Tresor gesperrt'));
      click(ctx.$('dp-main'), 'Entsperren');
      await until('names 2', () => byText(ctx.$('dp-main'), 'span', 'Notiz.txt'));
      await show(ctx, 'Notiz.txt', (x) => x.querySelectorAll('pre').length === 1);
      ctx.w.document.visibilityState = 'hidden';
      ctx.w.document.dispatchEvent({ type: 'visibilitychange' });
      await until('locked when hidden', () => viewerOf(ctx.w) === null);
      assert.deepEqual(ctx.seen.urls, []);
      assert.deepEqual(ctx.seen.out, []);
    } finally { ctx.w.stop(); }
  });
});

test('viewer: a decryption still running when the vault locks stops at its next read; nothing is shown afterwards', async () => {
  await withHost({}, async (host, c) => {
    // 3 chunks of 1 MiB → 1 read of the header + reads of the chunks (8 MiB windows: one)
    const big = Buffer.alloc(3 * 1048576 + 10, 0x41);
    const ctx = await openVault(host, c, { 'Gross.txt': big });
    try {
      let release;
      ctx.seen.gate = new Promise((r) => { release = r; });
      const before = ctx.seen.reads;
      let b = byText(ctx.$('dp-main'), 'span', 'Gross.txt');
      while (b && b.localName !== 'button') b = b.parentNode;
      b.click();
      const v = await until('the viewer', () => viewerOf(ctx.w));
      await until('reading', () => ctx.seen.reads > before);
      assert.ok(textOf(v).includes('Wird entschlüsselt'));
      ib(v, 'Tresore jetzt sperren').click();
      await until('closed', () => viewerOf(ctx.w) === null);
      const at = ctx.seen.reads;
      ctx.seen.gate = null;
      release();
      for (let i = 0; i < 50; i++) await tick();
      assert.equal(ctx.seen.reads, at, 'no further read after the lock');
      assert.equal(viewerOf(ctx.w), null, 'nothing opens again');
    } finally { ctx.w.stop(); }
  });
});

test('viewer: a PDF through pdf.js (the document destroyed and the pages emptied on close); videos and old office formats get a note and are never decrypted', async () => {
  await withHost({}, async (host, c) => {
    const rec = { got: null, destroyed: 0, rendered: 0 };
    const pdfjs = {
      AnnotationMode: { ENABLE: 1 },
      getDocument(o) {
        rec.got = o;
        const doc = {
          numPages: 2,
          getPage: async () => ({ getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }), render: () => { rec.rendered++; return { promise: Promise.resolve() }; }, cleanup() {} }),
          destroy() { rec.destroyed++; },
        };
        return { promise: Promise.resolve(doc), destroy() {} };
      },
    };
    const ctx = await openVault(host, c, { 'Vertrag.pdf': '%PDF-1.7 geheim', 'Urlaub.mp4': 'not really a video', 'Tabelle.xls': 'an old workbook' }, { pdfjs });
    try {
      const v = await show(ctx, 'Vertrag.pdf', (x) => x.querySelectorAll('canvas').length === 2);
      assert.equal(Buffer.from(rec.got.data).toString(), '%PDF-1.7 geheim', 'pdf.js gets the bytes, no URL');
      assert.equal(rec.got.isEvalSupported, false);
      assert.equal(rec.got.disableAutoFetch, true);
      assert.ok(rec.got.url === undefined);
      assert.equal(rec.rendered, 2);
      assert.ok(textOf(v).includes('2 Seiten'));
      const pages = v.querySelectorAll('canvas');
      v.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === 'Schließen').click();
      assert.equal(rec.destroyed, 1, 'the document is destroyed');
      assert.ok(Buffer.from(rec.got.data).every((b) => b === 0), 'the PDF bytes are overwritten');
      assert.ok(pages.every((p) => p.width === 0), 'the pages are emptied');

      const reads = ctx.seen.reads;
      let n = await show(ctx, 'Urlaub.mp4', (x) => textOf(x).includes('Videos aus Tresoren'));
      assert.equal(ctx.seen.reads, reads, 'a video is not decrypted in the tab');
      assert.ok(textOf(n).includes('App'));
      n.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === 'Schließen').click();
      // an office format that is not read in the tab (Excel 97–2003): a note that names it, nothing decrypted
      n = await show(ctx, 'Tabelle.xls', (x) => textOf(x).includes('Dieses Office-Format (.xls)'));
      assert.ok(textOf(n).includes('docx') && textOf(n).includes('xlsx'));
      assert.equal(ctx.seen.reads, reads);
      assert.equal(ctx.seen.office.length, 0);
      // the explicit way out: asks, then downloads (the one object URL, for the download)
      click(n, 'Herunterladen');
      click(await until('question', () => byText(n, 'span', 'Trotzdem herunterladen') && n), 'Trotzdem herunterladen');
      await until('downloaded', () => ctx.seen.urls.length === 1);
      assert.ok(ctx.seen.reads > reads);
      assert.deepEqual(ctx.seen.out, []);
    } finally { ctx.w.stop(); }
  });
});

test('viewer: a file larger than the viewer decrypts in memory gets a note — nothing decrypted', async () => {
  await withHost({}, async (host, c) => {
    const ctx = await openVault(host, c, { 'Klein.txt': 'x' });
    try {
      // the size of the node decides before anything is read
      const sc = ctx.w.document.createElement('script');
      sc.textContent = viewer.vaultview('de').code;
      ctx.w.document.head.appendChild(sc);
      ctx.w.window.DriveVaultView.LIMITS.text = 10;
      const reads = ctx.seen.reads;
      const v = await show(ctx, 'Klein.txt', (x) => textOf(x).includes('Zu groß für die Ansicht'));
      assert.equal(ctx.seen.reads, reads);
      assert.ok(textOf(v).includes('höchstens 0 MB'));
    } finally { ctx.w.stop(); }
  });
});

// ── office files (1.29.0) ──────────────────────────────────

const OFFICE_TAGS = new Set(['div', 'p', 'span', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'hr', 'sup', 'sub', 'section', 'button', 'svg', 'path', 'use', 'circle', 'rect', 'line', 'polyline', 'g']);
const OFFICE_ATTRS = new Set(['class', 'colspan', 'scope', 'role', 'aria-selected', 'aria-label', 'aria-hidden', 'type']);
/** Everything below the office view is one of a few elements with a few attributes — none of them can load or run anything. */
function assertInert(view) {
  for (const e of view.all()) {
    const svg = !!e.namespaceURI && /svg/.test(e.namespaceURI);
    if (!svg) assert.ok(OFFICE_TAGS.has(e.localName), 'element <' + e.localName + '>');
    for (const [k, v] of e.attributes) {
      if (!svg) assert.ok(OFFICE_ATTRS.has(k), `attribute ${k} on <${e.localName}>`);
      assert.ok(!/^on/i.test(k) && !/javascript:|https?:|file:|data:/i.test(v), `${k}="${v}"`);
    }
  }
  for (const bad of ['script', 'img', 'a', 'iframe', 'object', 'embed', 'link', 'style', 'form', 'input', 'video', 'audio', 'base', 'meta']) assert.equal(view.querySelectorAll(bad).length, 0, '<' + bad + '>');
}
const tabsOf = (root) => root.querySelectorAll('button').filter((b) => b.getAttribute('role') === 'tab');
const headOf = (root) => root.querySelectorAll('thead')[0].querySelectorAll('th').map(textOf);
const rowsOf = (root) => root.querySelectorAll('tbody')[0].querySelectorAll('tr');
const closeViewer = (v) => v.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === 'Schließen').click();

test('office: a Word file of a vault is read in the tab — headings, a list, a table as elements with text; a prepared file stays text; closing drops everything', async () => {
  await withHost({}, async (host, c) => {
    const evil = '&lt;script&gt;window.PWNED=1&lt;/script&gt;&lt;img src=x onerror="window.PWNED=2"&gt;';
    const body = F.wp('Mietvertrag', { style: 'berschrift1' }) + F.wp('Zwischen Anna und Jonas', { bold: true }) + F.wp('Kaltmiete', { num: [2, 0] }) + F.wp('Kaution', { num: [2, 0] })
      + '<w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>' + F.wp('Summe') + '</w:tc></w:tr><w:tr><w:tc>' + F.wp('950 €') + '</w:tc><w:tc>' + F.wp('210 €') + '</w:tc></w:tr></w:tbl>'
      + F.wp(evil)
      + '<w:p onclick="window.PWNED=3"><w:hyperlink r:id="rIdJs"><w:r><w:t>Klick mich</w:t></w:r></w:hyperlink><w:r><w:drawing/></w:r></w:p>';
    const file = F.docx(body, { rels: [{ id: 'rIdJs', type: F.REL + '/hyperlink', target: 'javascript:window.PWNED=4', external: true }], extra: { 'word/vbaProject.bin': { raw: Buffer.from('no deflate'), usize: 99 } } });
    const ctx = await openVault(host, c, { 'Vertrag.docm': file });
    try {
      const v = await show(ctx, 'Vertrag.docm', (x) => x.querySelectorAll('.dp-vo')[0] && textOf(x).includes('Kaution'));
      const view = v.querySelectorAll('.dp-vo')[0];
      assert.ok(textOf(v).includes('Leseansicht'), 'says what kind of view this is');
      assert.equal(textOf(view.querySelectorAll('h2')[0]), 'Mietvertrag');
      assert.equal(view.querySelectorAll('.is-b').map(textOf).join(), 'Zwischen Anna und Jonas');
      assert.deepEqual(view.querySelectorAll('.dp-vo-li').map(textOf), ['1.Kaltmiete', '2.Kaution']);
      assert.deepEqual(view.querySelectorAll('td').map((td) => [td.getAttribute('colspan'), textOf(td)]), [['2', 'Summe'], [null, '950 €'], [null, '210 €']]);
      // the prepared parts: text, a mark for the picture — never an element, a handler or an address
      assert.ok(textOf(view).includes('<script>window.PWNED=1</script><img src=x onerror="window.PWNED=2">'));
      assert.ok(textOf(view).includes('Klick mich') && textOf(view).includes('[Bild]'));
      assertInert(view);
      assert.equal(ctx.w.window.PWNED, undefined);
      assert.deepEqual(ctx.seen.urls, [], 'no URL of the plaintext');
      assert.deepEqual(ctx.seen.out, []);
      assert.ok(byText(v, 'span', 'Herunterladen'), 'the one way out stays');
      assert.equal(ctx.seen.office.length, 1);
      assert.ok(Buffer.from(ctx.seen.office[0]).every((b) => b === 0), 'the decrypted bytes are overwritten once they are read');
      closeViewer(v);
      assert.equal(viewerOf(ctx.w), null);
      assert.equal(view.childNodes.length, 0, 'the view is emptied');
    } finally { ctx.w.stop(); }
  });
});

test('office: an Excel file with its sheets as tabs, a presentation as slides, the real files written by LibreOffice', async () => {
  await withHost({}, async (host, c) => {
    const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', 'office', n));
    const book = F.xlsx([
      { name: 'Ausgaben', data: '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" s="4"><f>SUM(B2:B9)</f><v>1234.5</v></c></row><row r="5"><c r="A5" t="inlineStr"><is><t>&lt;b onmouseover=alert(1)&gt;fett&lt;/b&gt;</t></is></c></row>' },
      { name: '<img src=x>', data: '<row r="1"><c r="C1" s="1"><v>46027</v></c></row>' },
      { name: 'Leer', data: '' },
    ], { shared: ['Miete'] });
    const deck = F.pptx([F.sp('Urlaub', { title: true }) + F.sp(['Ostsee', 'Alpen']), '']);
    const ctx = await openVault(host, c, { 'Haushalt.xlsx': book, 'Urlaub.pptx': deck, 'Mietvertrag.docx': fx('Mietvertrag.docx'), 'Haushalt.ods': fx('Haushalt.ods'), 'Urlaub.odp': fx('Urlaub.odp') });
    try {
      let v = await show(ctx, 'Haushalt.xlsx', (x) => x.querySelectorAll('.dp-vo-grid')[0]);
      let view = v.querySelectorAll('.dp-vo')[0];
      assert.ok(textOf(v).includes('3 Blätter'));
      const tabs = tabsOf(view);
      assert.deepEqual(tabs.map(textOf), ['Ausgaben', '<img src=x>', 'Leer']);
      assert.deepEqual(tabs.map((b) => b.getAttribute('aria-selected')), ['true', 'false', 'false']);
      assert.deepEqual(headOf(view), ['', 'A', 'B']);
      assert.deepEqual(rowsOf(view).map((tr) => tr.childNodes.map(textOf)), [['1', 'Miete', '1.234,50 €'], ['5', '<b onmouseover=alert(1)>fett</b>', '']]);
      assert.equal(view.querySelectorAll('td').filter((td) => td.className === 'is-num').length, 1);
      assert.ok(rowsOf(view)[1].className.includes('is-gap'), 'rows left out are marked');
      assert.ok(!textOf(view).includes('SUM('), 'no formula');
      assertInert(view);
      tabs[1].click();
      assert.deepEqual(rowsOf(view).map((tr) => tr.childNodes.map(textOf)), [['1', '', '', '05.01.2026']]);
      assert.deepEqual(tabs.map((b) => b.getAttribute('aria-selected')), ['false', 'true', 'false']);
      tabs[2].click();
      assert.ok(textOf(view).includes('Dieses Blatt ist leer.'));
      assertInert(view);
      closeViewer(v);

      v = await show(ctx, 'Urlaub.pptx', (x) => x.querySelectorAll('.dp-vo-slide').length === 2);
      view = v.querySelectorAll('.dp-vo')[0];
      assert.ok(textOf(v).includes('2 Folien'));
      assert.deepEqual(view.querySelectorAll('.dp-vo-slide').map(textOf), ['Folie 1UrlaubOstseeAlpen', 'Folie 2Kein Text auf dieser Folie.']);
      assertInert(view);
      closeViewer(v);

      v = await show(ctx, 'Mietvertrag.docx', (x) => x.querySelectorAll('.dp-vo')[0] && textOf(x).includes('Unterschrift'));
      view = v.querySelectorAll('.dp-vo')[0];
      assert.deepEqual(view.querySelectorAll('h2,h3').map(textOf), ['Mietvertrag Wohnung Lindenstraße 12', '§ 1 Mietsache', '§ 2 Miete']);
      assert.equal(view.querySelectorAll('td').length, 7);
      assert.deepEqual(view.querySelectorAll('sup,sub').map((e) => e.localName + textOf(e)), ['sup2', 'sub2']);
      assertInert(view);
      closeViewer(v);

      v = await show(ctx, 'Haushalt.ods', (x) => x.querySelectorAll('.dp-vo-grid')[0]);
      assert.equal(rowsOf(v).length, 6);
      assert.equal(tabsOf(v).length, 0, 'one sheet needs no tabs');
      closeViewer(v);
      v = await show(ctx, 'Urlaub.odp', (x) => x.querySelectorAll('.dp-vo-slide').length === 3);
      assert.ok(textOf(v).includes('Katzensitter fragen'));
      assert.deepEqual(ctx.seen.urls, []);
      assert.ok(ctx.seen.office.every((b) => Buffer.from(b).every((x) => x === 0)));
    } finally { ctx.w.stop(); }
  });
});

test('office: a file that is not safe, has a password, is broken or too large inside gets a note and "Herunterladen" — never a view; the lock closes the view', async () => {
  await withHost({}, async (host, c) => {
    const doctype = F.docx('', { document: `<!DOCTYPE d [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;">]><w:document ${F.W}><w:body>${F.wp('&b;')}</w:body></w:document>` });
    const ole = Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.alloc(700)]);
    const good = F.docx(F.wp('Lesbar'));
    const ctx = await openVault(host, c, { 'Bombe.docx': doctype, 'Geschuetzt.xlsx': ole, 'Kaputt.pptx': Buffer.from('PK\u0003\u0004 this is no archive'), 'Gut.docx': good });
    try {
      for (const [name, text] of [['Bombe.docx', 'nicht vorkommen darf'], ['Geschuetzt.xlsx', 'Kennwort geschützt'], ['Kaputt.pptx', 'lässt sich hier nicht lesen']]) {
        const v = await show(ctx, name, (x) => textOf(x).includes(text));
        assert.equal(v.querySelectorAll('.dp-vo').length, 0, name + ': no view');
        assert.ok(byText(v, 'span', 'Herunterladen'), name);
        closeViewer(v);
      }
      // a browser without DecompressionStream says so
      const DS = ctx.w.window.DecompressionStream;
      ctx.w.window.DecompressionStream = undefined;
      let v = await show(ctx, 'Gut.docx', (x) => textOf(x).includes('kann Office-Dateien nicht entpacken'));
      closeViewer(v);
      ctx.w.window.DecompressionStream = DS;
      // the lock of the vaults closes an office view like any other
      v = await show(ctx, 'Gut.docx', (x) => textOf(x).includes('Lesbar'));
      const view = v.querySelectorAll('.dp-vo')[0];
      ib(v, 'Tresore jetzt sperren').click();
      await until('locked', () => !viewerOf(ctx.w));
      assert.equal(view.childNodes.length, 0);
      assert.ok(ctx.seen.office.every((b) => Buffer.from(b).every((x) => x === 0)));
      assert.deepEqual(ctx.seen.urls, []);
    } finally { ctx.w.stop(); }
  });
});
