'use strict';

// The portal's overview (1.18.0, ui/overview.js) in the small fake DOM against the mock host: Drive opens on "Übersicht"
// (the switch "Übersicht | Dateien | Fotos" at the top), the tiles in the order of the mockup — "Zu erledigen" (a
// deadline, the photos to check, Mail's attachments to file through a fake Mail), "Zuletzt geöffnet", "Neu in Familie"
// with the storage, "Erinnerungen", "Orte" —, a click on a file opens its folder, "Fotos" without memories and band but
// with "Karte" and "Personen" up top; a direct link still opens its node.

const test = require('node:test');
const assert = require('node:assert/strict');
const ui = require('../server/ui');
const { t } = require('../server/text');
const { withHost, ANNA, MARC, T0, MIN, DAY } = require('./helpers');
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
const tileOf = (main, title) => main.querySelectorAll('.dp-ov-tile').find((x) => x.getAttribute('aria-label') === title) || null;
const pageBtn = (doc, label) => byText(doc.getElementById('dp-pages'), 'button', label);
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

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

const mail = {
  plugin: 'gatecontrol-mail', provides: ['tofile_count'],
  service: async ({ name, user, payload }) => (name === 'tofile_count' && user && user.id === payload.userId ? { ok: true, count: 3, hint: 'Familie › Versicherungen' } : { ok: false, code: 'forbidden' }),
};

/** Anna: a document with a deadline, two photos a year ago (one to check, both in Hamburg); Marc: two photos in the family. */
async function setup(host, c) {
  const a = c.as(ANNA);
  const mine = await c.area(ANNA, 'mine');
  const fam = await c.area(ANNA, 'family');
  const docs = (await a('POST', 'nodes', { parentId: mine.rootId, name: 'Dokumente' })).json.node;
  const rech = (await c.put(ANNA, docs.id, 'Rechnung Stadtwerke.pdf', '%PDF-1', { mime: 'application/pdf' })).json.node;
  await host.gc.db.run('INSERT INTO doc_deadlines (node_id, kind, date, label, found_at) VALUES (?, ?, ?, ?, ?)', [rech.id, 'payment', day(T0 + 3 * DAY), 'Rechnung Stadtwerke zahlen', T0]);
  const y = new Date(T0);
  const ago = new Date(y.getFullYear() - 1, y.getMonth(), y.getDate(), 12).getTime();
  const p1 = (await c.put(ANNA, mine.rootId, 'Strand.jpg', 's', { mime: 'image/jpeg', takenAt: ago, geo: { lat: 53.5452, lon: 9.9667 } })).json.node;
  await c.put(ANNA, mine.rootId, 'Hafen.jpg', 'h', { mime: 'image/jpeg', takenAt: ago + 60000, geo: { lat: 53.5452, lon: 9.9667 } });
  assert.equal((await a('POST', 'photos/review', { ids: [p1.id], review: true })).status, 200);
  const urlaub = (await c.as(MARC)('POST', 'nodes', { parentId: fam.rootId, name: 'Urlaub 2026' })).json.node;
  c.clock.add(MIN);
  await c.put(MARC, urlaub.id, 'u1.jpg', '1', { mime: 'image/jpeg' });
  await c.put(MARC, urlaub.id, 'u2.jpg', '2', { mime: 'image/jpeg' });
  c.clock.add(5 * MIN);
  // Anna opened the bill
  assert.equal((await a('GET', `nodes/${rech.id}/content`)).status, 200);
  return { mine, fam, docs, rech };
}

test('smoke: Drive opens on "Übersicht" — the tiles of the mockup; a file opens its folder; "Fotos" without memories and band', async () => {
  await withHost({ services: [mail], gatecontrol: '1.216.0' }, async (host, c) => {
    const s = await setup(host, c);
    const calls = [];
    const f = createWindow(portalHtml(), frameGc(host, ANNA, calls));
    const $ = (id) => f.document.getElementById(id);
    try {
      f.run();
      await until('the overview', () => !$('dp-app').hidden && $('dp-main').querySelector('.dp-ov-tile'));
      assert.equal(pageBtn(f.document, 'Übersicht').getAttribute('aria-pressed'), 'true');
      assert.equal(pageBtn(f.document, 'Dateien').getAttribute('aria-pressed'), 'false');
      assert.ok(!calls.some((x) => /\/children$/.test(x.path) && !x.query.dirs), 'no folder loaded for the start');
      const main = $('dp-main');
      // row 1: Zu erledigen · Zuletzt geöffnet · Neu in Familie (with the storage); row 2: Erinnerungen · Orte
      assert.deepEqual(main.querySelectorAll('.dp-ov-tile').map((x) => x.getAttribute('aria-label')), ['Zu erledigen', 'Zuletzt geöffnet', 'Neu in Familie', 'Erinnerungen', 'Orte']);
      const todo = textOf(tileOf(main, 'Zu erledigen'));
      for (const x of ['Rechnung Stadtwerke zahlen', 'in 3 Tagen', '1 Foto prüfen', 'Arbeit oder privat?', '3 Mail-Anhänge zum Ablegen', 'Vorschlag: Familie › Versicherungen']) assert.ok(todo.includes(x), x);
      assert.equal(textOf(tileOf(main, 'Zu erledigen').querySelector('.dp-ov-th')).trim(), 'Zu erledigen3');
      const recent = tileOf(main, 'Zuletzt geöffnet');
      assert.ok(textOf(recent).includes('Rechnung Stadtwerke.pdf'));
      assert.ok(textOf(recent).includes('gerade eben · Meine Dateien'));
      assert.equal(textOf(recent.querySelector('.dp-ov-fi')), 'PDF');
      const fam = textOf(tileOf(main, 'Neu in Familie'));
      assert.ok(fam.includes('Marc hat 2 Fotos hinzugefügt'), fam);
      assert.ok(fam.includes('Urlaub 2026 · vor 5 Min.'), fam);
      assert.ok(/Speicher · \d+ B von 50 GB/.test(fam), fam);
      const mem = tileOf(main, 'Erinnerungen');
      assert.ok(textOf(mem).includes('Heute vor einem Jahr'));
      assert.ok(textOf(mem).includes('2 Fotos'));
      assert.ok(mem.querySelector('img'), 'the cover');
      const pl = tileOf(main, 'Orte');
      assert.equal(textOf(pl.querySelector('.dp-ov-bubble')), '2');
      assert.ok(byText(pl, 'button', 'Hamburg · 2'));
      // a file of "Zuletzt geöffnet": its folder, marked, shown
      recent.querySelector('.dp-ov-row').click();
      await until('the preview', () => !$('dp-dialog').hidden && byText($('dp-dialog'), 'h3', 'Rechnung Stadtwerke.pdf'));
      assert.equal(textOf($('dp-crumbs')).replace(/\s+/g, ''), 'MeineDateien›Dokumente');
      assert.equal(pageBtn(f.document, 'Dateien').getAttribute('aria-pressed'), 'true');
      $('dp-dialog').querySelector('.dp-ib').click();
      // "Fotos": only the photos — no memories, no band; "Karte" and "Personen" up top
      calls.length = 0;
      pageBtn(f.document, 'Fotos').click();
      await until('photos', () => $('dp-main').querySelectorAll('.dp-ph').length === 4);
      assert.equal(pageBtn(f.document, 'Fotos').getAttribute('aria-pressed'), 'true');
      assert.equal($('dp-main').querySelector('.dp-mem'), null);
      assert.equal($('dp-main').querySelector('.dp-wk-band'), null);
      assert.ok(textOf($('dp-main').querySelector('.dp-wk-chips')).includes('Prüfen1'), 'the count on the chip');
      assert.ok(!calls.some((x) => x.path === 'photos/memories'));
      assert.ok($('dp-tools').querySelectorAll('button').find((x) => x.getAttribute('aria-label') === 'Karte'));
      assert.ok($('dp-tools').querySelectorAll('button').find((x) => x.getAttribute('aria-label') === 'Personen'));
      // back to the overview; "1 Foto prüfen" opens "Fotos" with "Prüfen"
      pageBtn(f.document, 'Übersicht').click();
      await until('the overview again', () => tileOf($('dp-main'), 'Zu erledigen'));
      byText(tileOf($('dp-main'), 'Zu erledigen'), 'span', '1 Foto prüfen').parentNode.parentNode.click();
      await until('to check', () => $('dp-main').querySelectorAll('.dp-ph').length === 1);
      const chip = byText($('dp-main').querySelector('.dp-wk-chips'), 'span', 'Prüfen').parentNode;
      assert.equal(chip.getAttribute('aria-pressed'), 'true');
      // "Dateien": the folder shown last
      pageBtn(f.document, 'Dateien').click();
      await until('the folder', () => textOf($('dp-crumbs')).replace(/\s+/g, '') === 'MeineDateien›Dokumente');
    } finally { f.stop(); }
  });
});

test('smoke: nothing yet — only the storage; a direct link opens its node, not the overview', async () => {
  await withHost({}, async (host, c) => {
    const calls = [];
    const f = createWindow(portalHtml(), frameGc(host, ANNA, calls));
    const $ = (id) => f.document.getElementById(id);
    try {
      f.run();
      await until('the overview', () => !$('dp-app').hidden && $('dp-main').querySelector('.dp-ov-tile'));
      assert.deepEqual($('dp-main').querySelectorAll('.dp-ov-tile').map((x) => x.getAttribute('aria-label')), ['Speicher']);
      assert.ok(/^Speicher0 B von 50 GB$/.test(textOf($('dp-main')).trim()), textOf($('dp-main')));
    } finally { f.stop(); }
    const mine = await c.area(ANNA, 'mine');
    const pdf = (await c.put(ANNA, mine.rootId, 'Strom.pdf', '%PDF-1', { mime: 'application/pdf' })).json.node;
    const w = createWindow(portalHtml(), frameGc(host, ANNA, []));
    w.window.location = { search: `?drive=${pdf.id}`, hash: '' };
    const $w = (id) => w.document.getElementById(id);
    try {
      w.run();
      await until('the preview', () => !$w('dp-dialog').hidden && byText($w('dp-dialog'), 'h3', 'Strom.pdf'));
      assert.equal(byText($w('dp-pages'), 'button', 'Dateien').getAttribute('aria-pressed'), 'true');
      assert.equal($w('dp-main').querySelector('.dp-ov-tile'), null);
    } finally { w.stop(); }
  });
});
