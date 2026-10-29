'use strict';

// The portal (1.12.0): several at once — the checkboxes (the head: all / some / none), click, Strg+Klick, Umschalt+Klick,
// Strg+A, Esc, the green bar, "Ziel wählen" and "Gleiche Namen am Ziel", the snackbar with "Rückgängig", dragging onto a
// folder (with Strg: copy — the bytes through GC.mediaBytes and GC.upload), Strg+X / Strg+V, the right-click menu, Entf,
// a ZIP, one link for several files; the photos with Strg / Umschalt and "Alle" / "Keine" per month.

const test = require('node:test');
const assert = require('node:assert/strict');
const ui = require('../server/ui');
const ops = require('../server/ops');
const { t } = require('../server/text');
const { withHost, ANNA } = require('./helpers');
const { createWindow } = require('./fake-dom');

const portalHtml = () => ui.render({ view: 'portal', lang: 'de', user: { id: 2, loggedIn: true } }, t);
const tick = () => new Promise((r) => setTimeout(r, 2));
async function until(what, fn, n = 2000) {
  for (let i = 0; i < n; i++) {
    const v = fn();
    if (v) return v;
    await tick();
  }
  throw new Error('timed out waiting for ' + what);
}
const textOf = (n) => (n.nodeType === 3 ? n.data : n.childNodes.map(textOf).join(''));
const byText = (root, tag, text) => root.querySelectorAll(tag).find((e) => textOf(e).trim() === text);
const buttonOf = (root, text) => { let s = byText(root, 'span', text) || byText(root, 'button', text); while (s && s.localName !== 'button') s = s.parentNode; return s; };

/** window.GC of a portal frame for `user`: call, upload (a File or a Blob), mediaBytes (a range of a signed URL), on. */
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
    async upload(file) {
      const data = file.data != null ? Buffer.from(file.data) : Buffer.from(await file.arrayBuffer());
      const r = await host.upload(user, data, file.type || 'application/octet-stream');
      if (r.status !== 200) { const e = new Error('upload'); e.status = r.status; e.code = r.body.code; throw e; }
      return { mediaId: r.body.mediaId, mime: r.body.mime, bytes: r.body.bytes };
    },
    async mediaBytes(url, o) {
      const r = await host.mediaFromUrl(url, { range: `bytes=${o.start}-${o.end}` });
      if (r.status !== 200 && r.status !== 206) throw new Error('bytes ' + r.status);
      const b = Buffer.from(r.body);
      return { data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), start: o.start, end: o.end, total: null };
    },
    on(type, fn) { if (type === 'event') listeners.push(fn); },
  };
}

/** Every live event the host sent so far goes to the frame. */
function deliver(c, gc, from) {
  const evs = c.events().slice(from);
  for (const ev of evs) for (const fn of gc.listeners) fn({ plugin: 'gatecontrol-drive', type: ev.type, data: ev.data });
  return c.events().length;
}

async function setup(c) {
  const a = c.as(ANNA);
  const mine = await c.area(ANNA, 'mine');
  const mk = async (p, n) => (await a('POST', 'nodes', { parentId: p, name: n })).json.node;
  const docs = await mk(mine.rootId, 'Dokumente');
  const rech = await mk(mine.rootId, 'Rechnungen');
  const vert = await mk(docs.id, 'Verträge');
  const put = async (p, n, d) => (await c.put(ANNA, p, n, d, { mime: 'application/pdf' })).json.node;
  return { a, mine, docs, rech, vert, fa: await put(docs.id, 'a.pdf', 'AAA'), fb: await put(docs.id, 'b.pdf', 'BBB'), fc: await put(docs.id, 'c.pdf', 'CCC'),
    rb: await put(rech.id, 'b.pdf', 'other b'), rc: await put(rech.id, 'c.pdf', 'CCC') };
}

test('portal: choosing in the list, the bar, "Ziel wählen", the same names, undo; drag with Strg copies; Strg+X / V; Entf; ZIP; one link', async () => {
  await withHost({}, async (host, c) => {
    const s = await setup(c);
    const calls = [];
    const gc = frameGc(host, ANNA, calls);
    const f = createWindow(portalHtml(), gc);
    const doc = f.document;
    const $ = (id) => doc.getElementById(id);
    const rowOf = (name) => $('dp-main').querySelectorAll('.dp-row').find((r) => !r.className.includes('dp-head') && r.querySelectorAll('.dp-name').some((x) => textOf(x) === name));
    const key = (k, o) => { doc.activeElement = null; doc.dispatchEvent({ type: 'keydown', key: k, ...(o || {}) }); };
    const bar = () => $('dp-main').querySelector('.dp-selbar');
    let seen = 0;
    try {
      f.run();
      await until('the tree', () => $('dp-nav').querySelectorAll('.dp-tree-row').find((r) => textOf(r).trim() === 'Dokumente'));
      assert.ok(textOf($('dp-nav')).includes('Ziehen auf einen Ordner verschiebt.'), 'the hint in the menu');
      byText($('dp-nav'), 'span', 'Dokumente').parentNode.click();
      await until('Dokumente', () => textOf($('dp-crumbs')).includes('Dokumente') && byText($('dp-main'), 'span', 'a.pdf'));
      $('dp-tools').querySelectorAll('button').find((b) => b.getAttribute('aria-label') === 'Liste').click();
      await until('the list', () => rowOf('a.pdf'));
      assert.ok(textOf($('dp-main')).includes('Auswahl aufheben'), 'the row of shortcuts');
      const head = $('dp-main').querySelector('.dp-head').querySelector('.dp-cb');
      assert.ok(head, 'the head has a checkbox');
      // a click on a row chooses it; Strg+Klick one more; Umschalt+Klick a range (folders first: Verträge, a, b, c)
      rowOf('a.pdf').dispatchEvent({ type: 'click' });
      assert.ok(rowOf('a.pdf').className.includes('is-sel'));
      assert.ok(textOf(bar()).includes('1 ausgewählt · 1 Datei'));
      rowOf('c.pdf').dispatchEvent({ type: 'click', ctrlKey: true });
      assert.ok(textOf(bar()).includes('2 ausgewählt · 2 Dateien'));
      rowOf('Verträge').dispatchEvent({ type: 'click', shiftKey: true });
      assert.ok(textOf(bar()).includes('4 ausgewählt · 3 Dateien, 1 Ordner'), textOf(bar()));
      assert.equal(head.getAttribute('aria-checked'), 'true', 'all four');
      rowOf('Verträge').querySelector('.dp-cb').click();
      assert.deepEqual([head.indeterminate, head.getAttribute('aria-checked')], [true, 'mixed'], 'some');
      rowOf('Verträge').querySelector('.dp-cb').click();
      // the bar's buttons: a folder and files — no ZIP, no link (with the reason)
      const zipBtn = bar().querySelectorAll('button').find((b) => b.getAttribute('data-act') === 'zip');
      assert.equal(zipBtn.disabled, true);
      assert.equal(zipBtn.getAttribute('title'), 'ZIP geht für einen Ordner oder für Dateien');
      assert.equal(bar().querySelectorAll('button').find((b) => b.getAttribute('data-act') === 'link').getAttribute('title'), 'Ein Link für mehrere geht nur mit Dateien');
      // Esc: none; Strg+A: all
      key('Escape');
      assert.ok(bar().hidden);
      key('a', { ctrlKey: true });
      assert.ok(textOf(bar()).includes('4 ausgewählt'));
      key('Escape');
      // b.pdf and c.pdf → "Verschieben nach …" → Rechnungen
      rowOf('b.pdf').querySelector('.dp-cb').click();
      rowOf('c.pdf').querySelector('.dp-cb').click();
      assert.ok(textOf(bar()).includes('2 ausgewählt'));
      buttonOf(bar(), 'Verschieben nach …').click();
      await until('Ziel wählen', () => textOf($('dp-dialog')).includes('Ziel wählen') && textOf($('dp-dialog')).includes('Verträge'));
      assert.ok(textOf($('dp-dialog')).includes('2 Elemente aus „Dokumente“'));
      assert.ok(textOf($('dp-dialog')).includes('Familie Berg'), 'the areas as chips');
      assert.ok(byText($('dp-dialog'), 'button', 'Kinder · Lena (nur ansehen)').disabled, 'read only: greyed');
      const go = $('dp-dialog').querySelector('.dp-b-go');
      assert.equal(textOf(go), 'Hierher verschieben (2)');
      assert.equal(go.disabled, true, 'they are here already');
      buttonOf($('dp-dialog'), 'Eine Ebene höher').click();
      await until('the top', () => byText($('dp-dialog'), 'span', 'Rechnungen'));
      buttonOf($('dp-dialog'), 'Rechnungen').click();
      await until('Rechnungen', () => textOf($('dp-dialog')).includes('Ziel: Meine Dateien › Rechnungen') && !go.disabled);
      go.click();
      // the same names: one question
      await until('the question', () => textOf($('dp-dialog')).includes('Gleiche Namen am Ziel'));
      const q = textOf($('dp-dialog'));
      assert.ok(q.includes('2 Namen gibt es dort schon'), q);
      assert.ok(q.includes('Im Ordner „Rechnungen“ liegen bereits:'));
      assert.ok(q.includes('gleicher Inhalt'));
      assert.ok(q.includes('„c.pdf“ wird in jedem Fall nur einmal behalten'));
      buttonOf($('dp-dialog'), 'Beide behalten').click();
      buttonOf($('dp-dialog'), 'Verschieben').click();
      await until('the snackbar', () => !$('dp-snack').hidden && textOf($('dp-snack')).includes('2 Elemente nach „Rechnungen“ verschoben'));
      const there = (await s.a('GET', `nodes/${s.rech.id}/children`)).json.items.map((x) => x.name).sort();
      assert.deepEqual(there, ['b (2).pdf', 'b.pdf', 'c.pdf']);
      // undo
      buttonOf($('dp-snack'), 'Rückgängig').click();
      await until('undone', () => textOf($('dp-toast')).includes('Rückgängig gemacht'));
      assert.deepEqual((await s.a('GET', `nodes/${s.docs.id}/children`)).json.items.map((x) => x.name).sort(), ['Verträge', 'a.pdf', 'b.pdf', 'c.pdf']);
      await until('the list again', () => rowOf('b.pdf'));
      // drag a.pdf onto Verträge with Strg: a copy (the bytes through this tab)
      seen = c.events().length;
      const dt = { setData() {}, effectAllowed: '' };
      rowOf('a.pdf').dispatchEvent({ type: 'dragstart', dataTransfer: dt });
      rowOf('Verträge').dispatchEvent({ type: 'dragover', ctrlKey: true, dataTransfer: dt });
      assert.ok(textOf(rowOf('Verträge')).includes('1 Element hierher kopieren'));
      rowOf('Verträge').dispatchEvent({ type: 'drop', ctrlKey: true, dataTransfer: dt });
      await until('copied', () => !$('dp-snack').hidden && textOf($('dp-snack')).includes('1 Element nach „Verträge“ kopiert'));
      const copy = (await s.a('GET', 'nodes/by-path', null, { area: s.mine.id, path: 'Dokumente/Verträge/a.pdf' })).json.node;
      assert.equal(copy.sha256, s.fa.sha256);
      assert.ok(calls.some((x) => x.path.endsWith('/transfers') && x.body && x.body.maxSize === 100 * 1024 * 1024), 'the tab brings the bytes, up to 100 MB a file');
      deliver(c, gc, seen);
      // Strg+X in Dokumente, Strg+V in Rechnungen
      await until('the list', () => rowOf('a.pdf'));
      rowOf('a.pdf').dispatchEvent({ type: 'click' });
      key('x', { ctrlKey: true });
      assert.ok(textOf($('dp-toast')).includes('1 Element ausgeschnitten'));
      assert.ok(rowOf('a.pdf').className.includes('is-cut'));
      byText($('dp-nav'), 'span', 'Rechnungen').parentNode.click();
      await until('Rechnungen', () => textOf($('dp-crumbs')).includes('Rechnungen') && rowOf('b.pdf'));
      key('v', { ctrlKey: true });
      await until('pasted', () => textOf($('dp-snack')).includes('1 Element nach „Rechnungen“ verschoben'));
      assert.ok((await s.a('GET', `nodes/${s.fa.id}`)).json.node.path === 'Rechnungen/a.pdf');
      await until('a.pdf here, marked new', () => rowOf('a.pdf') && textOf(rowOf('a.pdf')).includes('neu hier'));
      // the right-click menu of one: into the trash (asks first)
      rowOf('a.pdf').dispatchEvent({ type: 'contextmenu', clientX: 100, clientY: 100 });
      const menu = await until('the menu', () => $('dp-root').querySelector('.dp-ctx'));
      const labels = menu.querySelectorAll('button').map((b) => textOf(b));
      for (const x of ['Herunterladen als ZIP', 'AusschneidenStrg+X', 'KopierenStrg+C', 'Verschieben nach …', 'Kopieren nach …', 'UmbenennenF2', 'Link teilen', 'In den PapierkorbEntf']) assert.ok(labels.includes(x), x);
      menu.querySelectorAll('button').find((b) => textOf(b) === 'In den PapierkorbEntf').click();
      await until('confirm', () => textOf($('dp-dialog')).includes('1 Element in den Papierkorb?'));
      $('dp-dialog').querySelectorAll('button').find((b) => b.className.includes('dp-btn-danger')).click();
      await until('trashed', () => textOf($('dp-snack')).includes('1 Element in den Papierkorb'));
      assert.equal((await s.a('GET', `nodes/${s.fa.id}`)).status, 404);
      // Entf with two chosen
      await until('the list', () => !rowOf('a.pdf') && rowOf('b (2).pdf') === undefined && rowOf('b.pdf'));
      rowOf('b.pdf').dispatchEvent({ type: 'click' });
      rowOf('c.pdf').dispatchEvent({ type: 'click', ctrlKey: true });
      key('Delete');
      await until('confirm 2', () => textOf($('dp-dialog')).includes('2 Elemente in den Papierkorb?'));
      $('dp-dialog').querySelectorAll('button').find((b) => b.className.includes('dp-btn-danger')).click();
      await until('trashed 2', () => textOf($('dp-snack')).includes('2 Elemente in den Papierkorb'));
      // back in Dokumente: a ZIP of two files, one link for both
      byText($('dp-nav'), 'span', 'Dokumente').parentNode.click();
      await until('Dokumente', () => textOf($('dp-crumbs')).includes('Dokumente') && rowOf('b.pdf'));
      rowOf('b.pdf').dispatchEvent({ type: 'click' });
      rowOf('c.pdf').dispatchEvent({ type: 'click', ctrlKey: true });
      buttonOf(bar(), 'Herunterladen (ZIP)').click();
      await until('the zip', () => textOf($('dp-toast')).includes('„Drive – 2 Dateien.zip“ wird heruntergeladen'));
      assert.ok([...host.publicLinks.values()].some((l) => l.kind === 'files' && l.files.length === 2));
      buttonOf(bar(), 'Link teilen').click();
      await until('link dialog', () => textOf($('dp-dialog')).includes('Ein Link für 2 Dateien'));
      buttonOf($('dp-dialog'), 'Link erstellen').click();
      await until('the url', () => $('dp-dialog').querySelectorAll('span').find((x) => /^https:\/\/gc\.example\.com\/s\//.test(textOf(x))));
      assert.equal((await s.a('GET', 'links')).json.links[0].count, 2);
    } finally {
      await ops.idle();
      f.stop();
    }
  });
});

test('portal: dragging onto a folder of the menu moves; a running job shows its card and can be cancelled', async () => {
  await withHost({}, async (host, c) => {
    const s = await setup(c);
    const calls = [];
    const gc = frameGc(host, ANNA, calls);
    delete gc.mediaBytes; // an older GateControl: this tab cannot bring the bytes of a copy
    const f = createWindow(portalHtml(), gc);
    const doc = f.document;
    const $ = (id) => doc.getElementById(id);
    const tree = (name) => $('dp-nav').querySelectorAll('.dp-tree-row').find((r) => textOf(r).trim() === name);
    try {
      f.run();
      await until('the tree', () => tree('Rechnungen'));
      byText($('dp-nav'), 'span', 'Dokumente').parentNode.click();
      await until('Dokumente', () => textOf($('dp-crumbs')).includes('Dokumente') && $('dp-main').querySelectorAll('.dp-card').length === 4);
      const card = (name) => $('dp-main').querySelectorAll('.dp-card').find((x) => textOf(x).includes(name));
      const dt = { setData() {}, effectAllowed: '' };
      card('a.pdf').querySelector('.dp-cb').click();
      card('a.pdf').dispatchEvent({ type: 'dragstart', dataTransfer: dt });
      const target = tree('Rechnungen');
      target.dispatchEvent({ type: 'dragover', dataTransfer: dt });
      assert.ok(textOf(target).includes('1 Element hierher verschieben'));
      assert.ok(target.className.includes('is-drop'));
      target.dispatchEvent({ type: 'drop', dataTransfer: dt });
      await until('moved', () => textOf($('dp-snack')).includes('1 Element nach „Rechnungen“ verschoben'));
      assert.equal((await s.a('GET', `nodes/${s.fa.id}`)).json.node.parentId, s.rech.id);
      // a copy this tab cannot bring bytes for: its card stays, "Abbrechen" ends it
      await until('3 cards', () => $('dp-main').querySelectorAll('.dp-card').length === 3);
      card('b.pdf').dispatchEvent({ type: 'click' });
      card('b.pdf').dispatchEvent({ type: 'dragstart', dataTransfer: dt });
      card('Verträge').dispatchEvent({ type: 'drop', ctrlKey: true, dataTransfer: dt });
      const opcard = await until('the card', () => $('dp-main').querySelector('.dp-opcard'));
      assert.ok(textOf(opcard).includes('Kopiere „b.pdf“ nach Verträge'), textOf(opcard));
      assert.ok(textOf(opcard).includes('0 von 1 Dateien'));
      buttonOf(opcard, 'Abbrechen').click();
      await until('cancelled', () => textOf($('dp-snack')).includes('Abgebrochen') && !$('dp-main').querySelector('.dp-opcard'));
    } finally {
      await ops.idle();
      f.stop();
    }
  });
});

test('portal: photos — Strg / Umschalt with a click choose, "Alle" / "Keine" per month, then into the trash', async () => {
  await withHost({}, async (host, c) => {
    const mine = await c.area(ANNA, 'mine');
    const ids = [];
    for (const [n, d] of [['a.jpg', '2026-07-03'], ['b.jpg', '2026-07-02'], ['c.jpg', '2026-07-01'], ['d.jpg', '2026-06-10']]) {
      ids.push((await c.put(ANNA, mine.rootId, n, 'jpeg ' + n, { mime: 'image/jpeg', takenAt: `${d}T10:00:00Z` })).json.node.id);
    }
    const gc = frameGc(host, ANNA, []);
    const f = createWindow(portalHtml(), gc);
    const $ = (id) => f.document.getElementById(id);
    try {
      f.run();
      await until('the app', () => !$('dp-app').hidden && byText($('dp-nav'), 'span', 'Fotos'));
      byText($('dp-nav'), 'span', 'Fotos').parentNode.click();
      await until('months', () => textOf($('dp-main')).includes('Juli 2026') && $('dp-main').querySelectorAll('.dp-ph').length === 4);
      const tile = (i) => $('dp-main').querySelectorAll('.dp-ph')[i];
      tile(0).dispatchEvent({ type: 'click', ctrlKey: true });
      await until('choosing', () => textOf($('dp-main')).includes('1 ausgewählt'));
      tile(2).dispatchEvent({ type: 'click', shiftKey: true });
      await until('three', () => textOf($('dp-main')).includes('3 ausgewählt'));
      // "Keine" of July, "Alle" of June
      const months = $('dp-main').querySelectorAll('.dp-ph-allm');
      assert.deepEqual(months.map((b) => textOf(b)), ['Keine', 'Alle']);
      months[0].click();
      await until('none', () => textOf($('dp-main')).includes('0 ausgewählt'));
      $('dp-main').querySelectorAll('.dp-ph-allm')[1].click();
      await until('june', () => textOf($('dp-main')).includes('1 ausgewählt'));
      buttonOf($('dp-main'), 'Löschen').click();
      await until('confirm', () => textOf($('dp-dialog')).includes('1 Element in den Papierkorb?'));
      $('dp-dialog').querySelectorAll('button').find((b) => b.className.includes('dp-btn-danger')).click();
      await until('gone', () => $('dp-main').querySelectorAll('.dp-ph').length === 3);
      assert.equal((await c.as(ANNA)('GET', `nodes/${ids[3]}`)).status, 404);
    } finally {
      await ops.idle();
      f.stop();
    }
  });
});

test('portal on GateControl 1.215: a folder and files in one ZIP, a copy on the server (no bytes through the tab)', async () => {
  await withHost({ gatecontrol: '1.215.0' }, async (host, c) => {
    const s = await setup(c);
    const calls = [];
    const gc = frameGc(host, ANNA, calls);
    const f = createWindow(portalHtml(), gc);
    const $ = (id) => f.document.getElementById(id);
    const card = (name) => $('dp-main').querySelectorAll('.dp-card').find((x) => textOf(x).includes(name));
    try {
      f.run();
      await until('the tree', () => $('dp-nav').querySelectorAll('.dp-tree-row').find((r) => textOf(r).trim() === 'Dokumente'));
      byText($('dp-nav'), 'span', 'Dokumente').parentNode.click();
      await until('Dokumente', () => textOf($('dp-crumbs')).includes('Dokumente') && card('a.pdf'));
      card('Verträge').querySelector('.dp-cb').click();
      card('a.pdf').querySelector('.dp-cb').click();
      const bar = $('dp-main').querySelector('.dp-selbar');
      const zip = bar.querySelectorAll('button').find((b) => b.getAttribute('data-act') === 'zip');
      assert.equal(zip.disabled, false, 'a folder and a file: one ZIP');
      zip.click();
      await until('the zip', () => textOf($('dp-toast')).includes('wird heruntergeladen'));
      // copy b.pdf into Verträge by dragging with Strg: done on the server
      const dt = { setData() {}, effectAllowed: '' };
      card('b.pdf').dispatchEvent({ type: 'click' });
      card('b.pdf').dispatchEvent({ type: 'dragstart', dataTransfer: dt });
      card('Verträge').dispatchEvent({ type: 'drop', ctrlKey: true, dataTransfer: dt });
      await until('copied', () => textOf($('dp-snack')).includes('1 Element nach „Verträge“ kopiert'));
      assert.ok(!calls.some((x) => x.path.includes('/transfers')), 'no bytes through the tab');
      assert.equal(host.mediaCopies.length, 1);
    } finally {
      await ops.idle();
      f.stop();
    }
  });
});
