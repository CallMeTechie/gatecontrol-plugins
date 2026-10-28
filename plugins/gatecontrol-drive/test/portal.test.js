'use strict';

// The portal tab "Drive" (0.2.0): what render() hands the frame (everything inline, nothing the frame CSP blocks,
// texts in de and en), and a smoke test of the real ui/portal.js in a small fake DOM against the mock host: the areas,
// a new folder, uploads (a name that exists asks), the actions of a file, sharing (the link shown), the trash.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ui = require('../server/ui');
const texts = require('../server/texts.json');
const manifest = require('../plugin.json');
const { t } = require('../server/text');
const { withHost, ANNA, OMA } = require('./helpers');
const { createWindow } = require('./fake-dom');

const UI = path.join(__dirname, '..', 'ui');
const ctxOf = (html) => JSON.parse(html.split('window.DP_CTX=')[1].split(';</script>')[0]);
const portalHtml = (o) => ui.render({ view: 'portal', lang: 'de', user: { id: 2, loggedIn: true }, ...o }, t);

test('render: the portal tab inlines its style, the context and the script; no title of its own; plugin.json declares it', () => {
  for (const lang of ['de', 'en']) {
    const html = portalHtml({ lang });
    assert.ok(!/\{\{t:/.test(html), 'all keys filled');
    assert.ok(!/<h1/i.test(html), 'GateControl shows the title');
    const ctx = ctxOf(html);
    assert.deepEqual([ctx.lang, ctx.view, ctx.loggedIn, ctx.viewer], [lang, 'portal', true, 2]);
    assert.equal(ctx.texts['p.share'], texts[lang]['p.share']);
    assert.equal(ctx.texts['err.links_disabled'], texts[lang]['error.links_disabled'], 'API error texts as err.*');
    assert.equal((html.match(/<script>/g) || []).length, 2);
    assert.ok(!/<script[^>]*\bsrc=|<link\b|<iframe\b|@import|url\(\s*['"]?https?:/i.test(html), 'nothing loaded from elsewhere');
    assert.ok(Buffer.byteLength(html) < 1024 * 1024 * 0.5, `well below the host's 1 MB (${Buffer.byteLength(html)} bytes)`);
  }
  for (const id of ['dp-app', 'dp-nav', 'dp-main', 'dp-crumbs', 'dp-q', 'dp-tools', 'dp-msg', 'dp-dialog', 'dp-file', 'dp-ups', 'dp-drop']) assert.ok(portalHtml().includes(`id="${id}"`), id);
  assert.equal(ctxOf(portalHtml({ user: { id: 2, loggedIn: false } })).loggedIn, false, 'device trust only: no files');
  assert.equal(ctxOf(portalHtml({ user: { id: 2, loggedIn: true, kiosk: true } })).loggedIn, false, 'never on a kiosk device');
  assert.deepEqual(manifest.ui.portal.label, { de: 'Drive', en: 'Drive' });
  assert.equal(manifest.permissions.publicLinks, true);
});

test('the frame\'s rules: no modals, no storage, no innerHTML, no eval, nothing in the console, no external URL', () => {
  for (const f of ['portal.js', 'portal.html', 'portal.css', 'admin.js', 'admin.html', 'admin.css', 'vault.js', 'vaultcrypto.js']) {
    // vault.js (1.9.0): a decrypted file leaves the frame as a download of a blob: URL (allow-downloads) — never shown
    const src = fs.readFileSync(path.join(UI, f), 'utf8').replace(f === 'vault.js' ? /URL\.(createObjectURL|revokeObjectURL)/g : /$^/, 'URL.x');
    assert.ok(!/\b(alert|confirm|prompt|print)\(/.test(src), `${f}: sandboxed frames have no modals`);
    assert.ok(!/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment/.test(src), `${f}: text only through textContent / attributes`);
    assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie/.test(src), `${f}: the frame has no storage`);
    assert.ok(!/WebAssembly\.|createObjectURL|\beval\(|new Function/.test(src), `${f}: CSP`);
    assert.ok(!/\bconsole\.\w+\(/.test(src), `${f}: nothing in the console`);
    assert.ok(!/https?:\/\/[\w.-]/.test(src.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, '')), `${f}: no external URL`);
  }
});

test('texts: every key the portal uses exists in de and en; the same keys in both', () => {
  assert.deepEqual(Object.keys(texts.de).sort(), Object.keys(texts.en).sort());
  for (const l of ['de', 'en']) for (const [k, v] of Object.entries(texts[l])) assert.ok(typeof v === 'string' && v.trim(), `${l}: ${k} empty`);
  const src = fs.readFileSync(path.join(UI, 'portal.js'), 'utf8') + fs.readFileSync(path.join(UI, 'vault.js'), 'utf8');
  const html = fs.readFileSync(path.join(UI, 'portal.html'), 'utf8');
  const keys = new Set();
  for (const m of src.matchAll(/\bT\('([a-z0-9_.]+)'\s*[,)]/gi)) keys.add(m[1]);
  for (const m of src.matchAll(/\? '(p\.[a-z0-9_]+)' : '(p\.[a-z0-9_]+)'/g)) { keys.add(m[1]); keys.add(m[2]); }
  for (const m of html.matchAll(/\{\{t:([a-z0-9_.]+)\}\}/g)) keys.add(m[1]);
  const ctx = ctxOf(portalHtml());
  for (const k of keys) assert.ok(ctx.texts[k] != null || texts.de[k] != null, `missing text ${k}`);
  for (const m of src.matchAll(/\b(?:U\.)?P\('([a-z0-9_.]+)'/g)) for (const l of ['de', 'en']) for (const s of ['.one', '.other']) assert.ok(texts[l][m[1] + s], `${l}: ${m[1]}${s}`);
  for (const s of ['active', 'expired', 'revoked', 'locked', 'used', 'gone', 'ended']) assert.ok(texts.de['p.state_' + s], s);
  for (const s of ['open', 'download', 'zip', 'upload', 'unlock', 'pin_failed', 'locked']) assert.ok(texts.de['p.ev_' + s], s);
  for (const s of ['moved', 'trashed', 'revoked']) assert.ok(texts.de['p.ended_' + s], s);
});

// ── the smoke test ─────────────────────────────────────────

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
/** A button of the menu (since 1.11.0): an area, a folder, a page — by its text, or an icon by its label. */
const navItem = (nav, label) => {
  const icon = nav.querySelectorAll('[aria-label]').find((e) => e.getAttribute('aria-label') === label);
  if (icon) return icon;
  let n = byText(nav, 'span', label);
  while (n && n.localName !== 'button') n = n.parentNode;
  return n || null;
};

/** window.GC of a portal frame for `user` against the mock host: call, upload, on. */
function frameGc(host, user, calls) {
  const viewer = { ...user, portal: true, loggedIn: true };
  const listeners = [];
  return {
    listeners,
    async call(method, p, body) {
      const [pathPart, qs] = String(p).split('?');
      const query = Object.fromEntries(new URLSearchParams(qs || ''));
      calls.push({ method, path: pathPart, query, body });
      const r = await host.request({ method, path: pathPart, query, body: body === undefined ? null : body, user: viewer, lang: 'de' });
      if (r.status !== 200) { const e = new Error('http ' + r.status); e.status = r.status; e.data = r.json; throw e; }
      return r.json;
    },
    async upload(file, o) {
      if (o && o.onProgress) o.onProgress({ loaded: file.size, total: file.size });
      const r = await host.upload(user, Buffer.from(file.data), file.type || 'application/octet-stream');
      if (r.status !== 200) { const e = new Error('upload'); e.status = r.status; e.code = r.body.code; throw e; }
      return { mediaId: r.body.mediaId, mime: r.body.mime, bytes: r.body.bytes };
    },
    on(type, fn) { if (type === 'event') listeners.push(fn); },
  };
}

const file = (name, data, type) => ({ name, data, type, size: Buffer.byteLength(data), lastModified: Date.UTC(2026, 9, 20) });

test('smoke: areas, a new folder, uploads with a name that exists, a file\'s actions, sharing, the trash', async () => {
  await withHost({}, async (host, c) => {
    const calls = [];
    const gc = frameGc(host, ANNA, calls);
    const f = createWindow(portalHtml(), gc);
    const doc = f.document;
    const $ = (id) => doc.getElementById(id);
    try {
      f.run();
      // the areas: my files, the family, Lena's folder (read)
      await until('the app', () => !$('dp-app').hidden && navItem($('dp-nav'), 'Familie Berg'));
      for (const label of ['Meine Dateien', 'Familie Berg', 'Kinder · Lena', 'Geteilte Links', 'Papierkorb']) assert.ok(navItem($('dp-nav'), label), label);
      await until('empty folder', () => textOf($('dp-main')).includes('Dieser Ordner ist leer'));
      // a new folder
      // (in the menu "Neu" since 1.11.0: a folder, files, a folder from the computer, a vault)
      byText($('dp-tools'), 'span', 'Neu').parentNode.click();
      await until('the menu', () => byText($('dp-dialog'), 'span', 'Neuer Tresor'));
      assert.ok(textOf($('dp-dialog')).includes('Erscheint im Menü unter „Tresore“'));
      byText($('dp-dialog'), 'span', 'Neuer Ordner').parentNode.click();
      const input = await until('name field', () => $('dp-dialog').querySelector('input'));
      input.value = 'Rechnungen';
      byText($('dp-dialog'), 'span', 'Anlegen').parentNode.click();
      await until('the folder', () => byText($('dp-main'), 'span', 'Rechnungen'));
      // uploads: two files; the same name again asks — "Als neue Version"
      const fileInput = $('dp-file');
      fileInput.files = [file('Brief.pdf', '%PDF-1', 'application/pdf'), file('Foto.jpg', 'jpeg', 'image/jpeg')];
      fileInput.dispatchEvent({ type: 'change', target: fileInput });
      await until('both uploaded', () => textOf($('dp-ups')).includes('Hochgeladen'));
      await until('in the folder', () => byText($('dp-main'), 'span', 'Brief.pdf') && byText($('dp-main'), 'span', 'Foto.jpg'));
      assert.ok($('dp-main').querySelector('img'), 'the picture has a tile');
      assert.match($('dp-main').querySelector('img').getAttribute('src'), /^\/plugin-media\/[0-9a-f]{32}\.\d+\.\d+\.[A-Za-z0-9_-]{22}\/preview$/, 'its preview');
      fileInput.files = [file('Brief.pdf', '%PDF-22', 'application/pdf')];
      fileInput.dispatchEvent({ type: 'change', target: fileInput });
      await until('the question', () => byText($('dp-dialog'), 'span', 'Als neue Version'));
      byText($('dp-dialog'), 'span', 'Als neue Version').parentNode.click();
      await until('done again', () => textOf($('dp-ups')).includes('Hochgeladen') && calls.filter((x) => x.path === 'uploads/commit').length === 4);
      const mine = await c.area(ANNA, 'mine');
      const brief = (await c.as(ANNA)('GET', 'nodes/by-path', null, { area: mine.id, path: 'Brief.pdf' })).json.node;
      assert.equal(brief.rev, 2);
      assert.equal((await c.as(ANNA)('GET', `nodes/${brief.id}/versions`)).json.versions.length, 1);
      // the actions of Brief.pdf: share → a link
      const card = $('dp-main').querySelectorAll('.dp-card').find((x) => textOf(x).includes('Brief.pdf'));
      card.querySelector('.dp-more').click();
      await until('menu', () => byText($('dp-dialog'), 'span', 'Teilen'));
      byText($('dp-dialog'), 'span', 'Teilen').parentNode.click();
      await until('share dialog', () => byText($('dp-dialog'), 'span', 'Link erstellen'));
      byText($('dp-dialog'), 'button', '1 Tag').click();
      byText($('dp-dialog'), 'span', 'Link erstellen').parentNode.click();
      const urlSpan = await until('the url', () => $('dp-dialog').querySelectorAll('span').find((s) => /^https:\/\/gc\.example\.com\/s\//.test(textOf(s))));
      const token = textOf(urlSpan).split('/s/')[1];
      assert.equal(host.publicLinks.get(token).kind, 'files');
      byText($('dp-dialog'), 'span', 'Kopieren').parentNode.click();
      assert.equal(doc.copied[doc.copied.length - 1], textOf(urlSpan), 'copied');
      // the shared links page
      navItem($('dp-nav'), 'Geteilte Links').click();
      await until('links page', () => textOf($('dp-main')).includes('Brief.pdf') && textOf($('dp-main')).includes('aktiv'));
      // back to my files, Foto.jpg into the trash
      navItem($('dp-nav'), 'Meine Dateien').click();
      await until('files', () => byText($('dp-main'), 'span', 'Foto.jpg'));
      $('dp-main').querySelectorAll('.dp-card').find((x) => textOf(x).includes('Foto.jpg')).querySelector('.dp-more').click();
      await until('menu', () => byText($('dp-dialog'), 'span', 'In den Papierkorb'));
      byText($('dp-dialog'), 'span', 'In den Papierkorb').parentNode.click();
      await until('confirm', () => $('dp-dialog').querySelectorAll('button').find((b) => b.className.includes('dp-btn-danger')));
      $('dp-dialog').querySelectorAll('button').find((b) => b.className.includes('dp-btn-danger')).click();
      await until('gone', () => !byText($('dp-main'), 'span', 'Foto.jpg'));
      navItem($('dp-nav'), 'Papierkorb').click();
      await until('in the trash', () => byText($('dp-main'), 'span', 'Foto.jpg'));
      byText($('dp-main'), 'span', 'Wiederherstellen').parentNode.click();
      await until('restored', () => textOf($('dp-toast')).includes('ist wieder da'));
      // a live event of another device reloads the folder
      navItem($('dp-nav'), 'Meine Dateien').click();
      await until('files', () => byText($('dp-main'), 'span', 'Foto.jpg'));
      await c.put(ANNA, mine.rootId, 'Vom Handy.txt', 'hi');
      const ev = c.events().filter((e) => e.type === 'changed').pop();
      for (const fn of gc.listeners) fn({ plugin: 'gatecontrol-drive', type: ev.type, data: ev.data });
      await until('live', () => byText($('dp-main'), 'span', 'Vom Handy.txt'));
    } finally {
      f.stop();
    }
  });
});

test('smoke: into the trash and also on all my devices (Drive knows a phone of mine)', async () => {
  await withHost({}, async (host, c) => {
    const mine = await c.area(ANNA, 'mine'); // from Anna's phone: Drive knows it now
    await c.put(ANNA, mine.rootId, 'Foto.jpg', 'jpeg', { mime: 'image/jpeg' });
    await c.put(ANNA, mine.rootId, 'Notiz.txt', 'x');
    const calls = [];
    const f = createWindow(portalHtml(), frameGc(host, ANNA, calls));
    const $ = (id) => f.document.getElementById(id);
    const trash = async (name, everywhere) => {
      $('dp-main').querySelectorAll('.dp-card').find((x) => textOf(x).includes(name)).querySelector('.dp-more').click();
      await until('menu', () => byText($('dp-dialog'), 'span', 'In den Papierkorb'));
      byText($('dp-dialog'), 'span', 'In den Papierkorb').parentNode.click();
      const box = await until('the option', () => byText($('dp-dialog'), 'span', 'Auch auf meinem Gerät löschen'));
      if (everywhere) box.parentNode.querySelector('input').checked = true;
      $('dp-dialog').querySelectorAll('button').find((b) => b.className.includes('dp-btn-danger')).click();
      await until('gone', () => !byText($('dp-main'), 'span', name));
    };
    try {
      f.run();
      await until('files', () => !$('dp-app').hidden && byText($('dp-main'), 'span', 'Foto.jpg'));
      await trash('Notiz.txt', false);
      assert.deepEqual(calls.filter((x) => x.method === 'DELETE').map((x) => x.query), [{}]);
      await trash('Foto.jpg', true);
      assert.deepEqual(calls.filter((x) => x.method === 'DELETE').map((x) => x.query), [{}, { everywhere: '1' }]);
      await until('toast', () => textOf($('dp-toast')).includes('auf deinen Geräten gelöscht'));
      const w = (await c.as(ANNA)('GET', 'wipes')).json.wipes;
      assert.deepEqual(w.map((x) => x.name), ['Foto.jpg']);
    } finally {
      f.stop();
    }
  });
});

test('smoke: a person not switched on sees why; a signed-out viewer is asked to sign in', async () => {
  await withHost({}, async (host) => {
    const f = createWindow(portalHtml({ user: { id: OMA.id, loggedIn: true } }), frameGc(host, OMA, []));
    try {
      f.run();
      await until('message', () => textOf(f.document.getElementById('dp-msg')).includes('noch nicht freigeschaltet'));
    } finally { f.stop(); }
    const g = createWindow(portalHtml({ user: { id: OMA.id, loggedIn: false } }), frameGc(host, OMA, []));
    try {
      g.run();
      assert.ok(textOf(g.document.getElementById('dp-msg')).includes('Bitte melde dich an'));
    } finally { g.stop(); }
  });
});

test('smoke (1.5.0): a file deleted on a device shows it and can be kept; an empty file uploads; the page "Geräte"', async () => {
  await withHost({}, async (host, c) => {
    const pc = c.as(ANNA, 'tok-pc');
    const mine = await c.area(ANNA, 'mine');
    const dev = (await pc('PUT', 'devices/pc-1', { name: 'PC', platform: 'windows', version: '1.40.0' })).json.device;
    await pc('PUT', 'devices/pc-1/folders', [{ localPath: 'C:\\Users\\Anna\\Pictures', mode: 'backup', nodeId: dev.folder.id, lastBackup: '2026-10-26T08:00:00Z' }]);
    const f = (await c.put(ANNA, mine.rootId, 'Alt.txt', 'x')).json.node;
    await pc('DELETE', `nodes/${f.id}`, null, { after: String(30 * 86400) });
    const calls = [];
    const w = createWindow(portalHtml(), frameGc(host, ANNA, calls));
    const $ = (id) => w.document.getElementById(id);
    try {
      w.run();
      await until('files', () => !$('dp-app').hidden && byText($('dp-main'), 'span', 'Alt.txt'));
      const card = $('dp-main').querySelectorAll('.dp-card').find((x) => textOf(x).includes('Alt.txt'));
      assert.match(textOf(card.querySelector('.dp-mark')), /^wird am \d\d\.\d\d\.\d{4} gelöscht$/);
      assert.match(card.querySelector('.dp-mark').getAttribute('title'), /^Auf „PC“ gelöscht – kommt am .* in den Papierkorb\.$/);
      card.querySelector('.dp-more').click();
      await until('menu', () => byText($('dp-dialog'), 'span', 'Behalten'));
      byText($('dp-dialog'), 'span', 'Behalten').parentNode.click();
      await until('kept', () => textOf($('dp-toast')).includes('„Alt.txt“ bleibt.'));
      assert.equal(JSON.stringify(calls.filter((x) => x.method === 'PATCH').map((x) => x.body)), '[{"deleteAt":null}]');
      assert.equal((await pc('GET', `nodes/${f.id}`)).json.node.deleteAt, undefined);
      await until('no mark', () => !$('dp-main').querySelector('.dp-mark'));

      // an empty file: no GC.upload, commit { size: 0 }
      const fileInput = $('dp-file');
      fileInput.files = [file('leer.txt', '', 'text/plain')];
      fileInput.dispatchEvent({ type: 'change', target: fileInput });
      await until('uploaded', () => byText($('dp-main'), 'span', 'leer.txt'));
      const commit = calls.filter((x) => x.path === 'uploads/commit').pop();
      assert.equal(commit.body.mediaId, undefined);
      assert.equal(commit.body.size, 0);
      assert.equal((await pc('GET', 'nodes/by-path', null, { area: mine.id, path: 'leer.txt' })).json.node.size, 0);

      // Geräte: the PC with its folder, then forgotten
      navItem($('dp-nav'), 'Geräte').click();
      await until('devices', () => textOf($('dp-main')).includes('C:\\Users\\Anna\\Pictures'));
      const main = textOf($('dp-main'));
      for (const s of ['PC', 'windows · 1.40.0', 'Nur sichern', 'Meine Dateien › Geräte › PC', 'zuletzt gesichert']) assert.ok(main.includes(s), s);
      byText($('dp-main'), 'span', 'Gerät vergessen').parentNode.click();
      await until('confirm', () => $('dp-dialog').querySelectorAll('button').find((b) => b.className.includes('dp-btn-danger')));
      $('dp-dialog').querySelectorAll('button').find((b) => b.className.includes('dp-btn-danger')).click();
      await until('forgotten', () => textOf($('dp-main')).includes('Noch keine Geräte'));
      assert.deepEqual((await pc('GET', 'devices')).json.devices, []);
      assert.equal((await pc('GET', `nodes/${dev.folder.id}`)).status, 200, 'its folder stays');
    } finally {
      w.stop();
    }
  });
});

test('smoke (1.6.0): a direct link opens its file, "Direktlink kopieren", "Ordner hochladen" and a dropped folder with an empty one', async () => {
  await withHost({ settings: { portal_url: 'https://gc.example.com' } }, async (host, c) => {
    const mine = await c.area(ANNA, 'mine');
    const dir = (await c.as(ANNA)('POST', 'nodes', { parentId: mine.rootId, name: 'Rechnungen' })).json.node;
    const pdf = (await c.put(ANNA, dir.id, 'Strom.pdf', '%PDF-1', { mime: 'application/pdf' })).json.node;
    const calls = [];
    const w = createWindow(portalHtml(), frameGc(host, ANNA, calls));
    w.window.location = { search: `?drive=${pdf.id}`, hash: '' };
    const $ = (id) => w.document.getElementById(id);
    try {
      w.run();
      // the file's folder, the file marked and shown
      await until('the preview', () => !$('dp-dialog').hidden && byText($('dp-dialog'), 'h3', 'Strom.pdf'));
      assert.equal(textOf($('dp-crumbs')).replace(/\s+/g, ''), 'MeineDateien›Rechnungen');
      const card = $('dp-main').querySelectorAll('.dp-card').find((x) => textOf(x).includes('Strom.pdf'));
      assert.ok(card.className.includes('dp-hl'));
      $('dp-dialog').querySelector('.dp-ib').click();
      // the direct link of a file
      card.querySelector('.dp-more').click();
      await until('menu', () => byText($('dp-dialog'), 'span', 'Direktlink kopieren'));
      byText($('dp-dialog'), 'span', 'Direktlink kopieren').parentNode.click();
      assert.equal(w.document.copied.pop(), `https://gc.example.com/portal?drive=${pdf.id}#plg-gatecontrol-drive`);

      // "Ordner hochladen": the chosen folder with its sub folders, an empty file too
      byText($('dp-tools'), 'span', 'Neu').parentNode.click();
      assert.ok(await until('the menu', () => byText($('dp-dialog'), 'span', 'Ordner hochladen')));
      $('dp-dialog').querySelector('.dp-ib').click();
      const rel = (p, data, type) => Object.assign(file(p.split('/').pop(), data, type), { webkitRelativePath: p });
      $('dp-dir').files = [rel('Urlaub/2026/Strand.jpg', 'jpeg', 'image/jpeg'), rel('Urlaub/Liste.txt', 'Sonnencreme'), rel('Urlaub/leer.txt', '')];
      $('dp-dir').dispatchEvent({ type: 'change', target: $('dp-dir') });
      await until('uploaded', () => textOf($('dp-ups')).includes('Hochgeladen') && byText($('dp-main'), 'span', 'Urlaub'));
      const a = c.as(ANNA);
      for (const p of ['Rechnungen/Urlaub/2026/Strand.jpg', 'Rechnungen/Urlaub/Liste.txt', 'Rechnungen/Urlaub/leer.txt']) {
        assert.equal((await a('GET', 'nodes/by-path', null, { area: mine.id, path: p })).status, 200, p);
      }
      // a dropped folder: its files and an empty sub folder
      const entry = {
        isFile: false, isDirectory: true, name: 'Projekt',
        createReader() {
          let done = false;
          return { readEntries(cb) { const out = done ? [] : [
            { isFile: true, isDirectory: false, name: 'Plan.txt', file(ok) { ok(file('Plan.txt', 'Schritt 1')); } },
            { isFile: false, isDirectory: true, name: 'Leer', createReader() { return { readEntries(cb2) { cb2([]); } }; } },
          ]; done = true; cb(out); } };
        },
      };
      $('dp-root').dispatchEvent({ type: 'drop', dataTransfer: { types: ['Files'], items: [{ webkitGetAsEntry: () => entry }], files: [] } });
      await until('dropped', () => byText($('dp-main'), 'span', 'Projekt'));
      await until('all done', () => textOf($('dp-ups')).includes('Hochgeladen'));
      assert.equal((await a('GET', 'nodes/by-path', null, { area: mine.id, path: 'Rechnungen/Projekt/Plan.txt' })).status, 200);
      const leer = await a('GET', 'nodes/by-path', null, { area: mine.id, path: 'Rechnungen/Projekt/Leer' });
      assert.equal(leer.status, 200);
      assert.equal(leer.json.node.isDir, true);
    } finally {
      w.stop();
    }
  });
});

test('smoke (1.6.0): a stopped device of mine shows the banner — "Rückgängig machen"; an administrator\'s page "Vorfälle"', async () => {
  const { ADMIN } = require('./helpers');
  const seats = { [ANNA.id]: 'family', [ADMIN.id]: 'business' };
  await withHost({ settings: { guard_files: 5 }, seats }, async (host, c) => {
    const mine = await c.area(ANNA, 'mine');
    const pc = c.as(ANNA, 'tok-pc');
    await pc('PUT', 'devices/pc-1', { name: 'Arbeits-PC' });
    const files = [];
    for (let i = 1; i <= 6; i++) files.push((await c.put(ANNA, mine.rootId, `Text${i}.txt`, `t${i}`)).json.node);
    for (let i = 0; i < 5; i++) await pc('PATCH', `nodes/${files[i].id}`, { name: files[i].name + '.locked' });
    assert.equal((await pc('GET', 'me')).json.guard.locked, true);
    const gc = frameGc(host, ANNA, []);
    const w = createWindow(portalHtml(), gc);
    const $ = (id) => w.document.getElementById(id);
    try {
      w.run();
      await until('banner', () => !$('dp-guard').hidden && textOf($('dp-guard')).includes('Arbeits-PC'));
      assert.ok(textOf($('dp-guard')).includes('Drive hat ungewöhnliche Änderungen von „Arbeits-PC“ gestoppt'));
      assert.ok(textOf($('dp-guard')).includes('Text1.txt.locked'));
      assert.ok(byText($('dp-guard'), 'span', 'War ich – freigeben'));
      byText($('dp-guard'), 'span', 'Rückgängig machen').parentNode.click();
      await until('confirm', () => byText($('dp-dialog'), 'h3', 'Änderungen rückgängig machen?'));
      $('dp-dialog').querySelectorAll('button').find((b) => b.className.includes('dp-btn-primary')).click();
      await until('undone', () => textOf($('dp-toast')).includes('Rückgängig gemacht: 5 wiederhergestellt, 0 in den Papierkorb.'));
      assert.ok($('dp-guard').hidden);
      await until('names back', () => byText($('dp-main'), 'span', 'Text1.txt'));
      assert.equal((await pc('GET', 'me')).json.guard.locked, false);
      // live: a new incident shows at once
      for (let i = 0; i < 5; i++) await pc('PATCH', `nodes/${files[i].id}`, { name: files[i].name + '.wncry' });
      const ev = c.events().filter((e) => e.type === 'guard').pop();
      assert.equal(ev.data.incident.state, 'open');
      for (const fn of gc.listeners) fn({ plugin: 'gatecontrol-drive', type: ev.type, data: ev.data });
      await until('banner again', () => !$('dp-guard').hidden);
    } finally {
      w.stop();
    }
    // an administrator: everyone's incidents in the banner and on the page "Vorfälle"
    const g = createWindow(portalHtml({ user: { id: ADMIN.id, loggedIn: true } }), frameGc(host, ADMIN, []));
    const $$ = (id) => g.document.getElementById(id);
    try {
      g.run();
      await until('admin banner', () => !$$('dp-guard').hidden && textOf($$('dp-guard')).includes('(Anna)'));
      navItem($$('dp-nav'), 'Vorfälle').click();
      await until('page', () => textOf($$('dp-main')).includes('rückgängig gemacht') && textOf($$('dp-main')).includes('gestoppt'));
      const open = $$('dp-main').querySelectorAll('.dp-incident').find((x) => textOf(x).includes('gestoppt'));
      byText(open, 'span', 'War ich – freigeben').parentNode.click();
      await until('confirm', () => byText($$('dp-dialog'), 'h3', 'Gerät freigeben?'));
      $$('dp-dialog').querySelectorAll('button').find((b) => b.className.includes('dp-btn-primary')).click();
      await until('released', () => textOf($$('dp-toast')).includes('darf wieder schreiben'));
      await until('banner gone', () => $$('dp-guard').hidden);
      assert.equal((await pc('GET', 'me')).json.guard.locked, false);
    } finally {
      g.stop();
    }
  });
});
