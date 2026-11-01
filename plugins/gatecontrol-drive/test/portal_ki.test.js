'use strict';

// The portal's AI in Drive (1.14.0, ui/ki.js) in the small fake DOM against the mock host's gc.ai and a stand-in for
// Familie's calendar_add: hidden without the features; "Dateien | Fragen" with the answer card (sources, quote, the
// deadline into the family calendar) and "nichts gefunden"; "Fristen" by month with "In den Familienkalender"; "In
// Dokument umwandeln" (Scan prüfen → Excel, uploaded and filed); the photo search with its chips; the area switch.

const test = require('node:test');
const assert = require('node:assert/strict');
const ui = require('../server/ui');
const { t } = require('../server/text');
const { withHost, ANNA } = require('./helpers');
const { createWindow } = require('./fake-dom');

const portalHtml = () => ui.render({ view: 'portal', lang: 'de', user: { id: 2, loggedIn: true } }, t);
const tick = () => new Promise((r) => setTimeout(r, 2));
async function until(what, fn, n = 2500) {
  for (let i = 0; i < n; i++) {
    const v = await fn();
    if (v) return v;
    await tick();
  }
  throw new Error('timed out waiting for ' + what);
}
const textOf = (n) => (n.nodeType === 3 ? n.data : n.childNodes.map(textOf).join(''));
const byText = (root, tag, text) => root.querySelectorAll(tag).find((e) => textOf(e).trim() === text);
const buttonOf = (root, text) => { let s = byText(root, 'span', text) || byText(root, 'button', text); while (s && s.localName !== 'button') s = s.parentNode; return s; };
const navItem = (nav, label) => nav.querySelectorAll('[aria-label]').find((e) => e.getAttribute('aria-label') === label) || buttonOf(nav, label);

function frameGc(host, user, uploads) {
  const viewer = { ...user, portal: true, loggedIn: true };
  return {
    async call(method, p, body) {
      const [pathPart, qs] = String(p).split('?');
      const query = Object.fromEntries(new URLSearchParams(qs || ''));
      const r = await host.request({ method, path: pathPart, query, body: body === undefined ? null : body, user: viewer, lang: 'de' });
      if (r.status !== 200) { const e = new Error('http ' + r.status); e.status = r.status; e.data = r.json; throw e; }
      return r.json;
    },
    // GateControl's media upload of the frame: the bytes of a blob
    async upload(blob) {
      const buf = Buffer.from(await blob.arrayBuffer());
      const r = await host.upload(user, buf, blob.type);
      if (uploads) uploads.push({ mime: blob.type, size: buf.length });
      return { mediaId: r.body.mediaId };
    },
    on() {},
  };
}

const POLICY = 'Musterversicherung AG\nVersicherungsschein Kfz\nVertragslaufzeit: 01.01.2026 bis 31.12.2026, Verlängerung um jeweils ein Jahr.\nKündigung bis 30.11.2026.';

function ai() {
  return {
    extract: async (req) => {
      if (req.task === 'drive_document') {
        const text = (req.input.find((x) => x.label === 'Document text') || {}).text || '';
        return /Versicherungsschein/.test(text)
          ? { kind: 'insurance', title: 'Kfz-Versicherung', date: '2026-01-02', sender: 'Musterversicherung AG', amount: 312.5, currency: 'EUR', folder: null, name: null,
            deadlines: [{ kind: 'renewal', date: '2026-11-30', label: 'Kfz-Versicherung kündigen' }] }
          : { kind: 'other', title: null, date: null, sender: null, amount: null, currency: null, folder: null, name: null, deadlines: [] };
      }
      if (req.task === 'drive_ask_terms') return /Hund/.test(req.input[0].text) ? { terms: ['Hund'], kind: null, sender: null, year: null } : { terms: ['Kfz', 'Versicherung'], kind: null, sender: null, year: null };
      if (req.task === 'drive_ask_answer') {
        return { found: true, answer: 'Kündigen kannst du bis 30.11.2026.', sources: [{ doc: 1, quote: 'Verlängerung um jeweils ein Jahr' }] };
      }
      if (req.task === 'drive_scan_kind') return { kind: 'table', confidence: 0.9, summary: '3 Spalten, 2 Zeilen, Summenzeile', title: 'Zählerstände' };
      if (req.task === 'drive_scan_table') {
        return { title: 'Zählerstände', columns: [{ name: 'Datum', type: 'date', currency: null }, { name: 'Stand', type: 'integer', currency: null }],
          rows: [['2026-01-01', '41208'], ['2026-02-01', '41497']], total: { label: 'Verbrauch', cells: [{ column: 1, op: 'difference' }] } };
      }
      throw new Error('unexpected ' + req.task);
    },
  };
}

function familie(calls) {
  return { plugin: 'gatecontrol-familie', provides: ['calendar_add'], service: async ({ payload }) => { calls.push(payload); return { ok: true, eventId: 7 }; } };
}

test('smoke: without the host\'s AI service there are no "Fragen", no "In Dokument umwandeln"; the photo search is there', async () => {
  await withHost({}, async (host, c) => {
    const mine = await c.area(ANNA, 'mine');
    await c.put(ANNA, mine.rootId, 'Scan.jpg', 'jpeg', { mime: 'image/jpeg' });
    const f = createWindow(portalHtml(), frameGc(host, ANNA));
    const $ = (id) => f.document.getElementById(id);
    try {
      f.run();
      await until('the file', () => byText($('dp-main'), 'span', 'Scan.jpg'));
      const q = $('dp-q');
      q.value = 'Scan?';
      q.dispatchEvent({ type: 'input' });
      await until('the results', () => textOf($('dp-crumbs')).includes('Scan?'));
      assert.ok(!byText($('dp-main'), 'button', 'Fragen'));
      q.value = 'Scan';
      q.dispatchEvent({ type: 'input' });
      const more = () => $('dp-main').querySelectorAll('button').find((b) => (b.getAttribute('aria-label') || '').includes('Scan.jpg'));
      await until('the file found', more);
      more().click();
      await until('actions', () => byText($('dp-dialog'), 'span', 'Ältere Versionen'));
      assert.ok(!byText($('dp-dialog'), 'span', 'In Dokument umwandeln'));
      $('dp-dialog').querySelectorAll('button').find((b) => b.getAttribute('aria-label') === 'Schließen').click();
      navItem($('dp-nav'), 'Fotos').click();
      await until('the photos', () => $('dp-main').querySelector('.dp-k-phq'));
    } finally {
      f.stop();
    }
  });
});

test('smoke: a question with Enter — the answer card, its source, the deadline into the family calendar; nothing found', async () => {
  const calls = [];
  await withHost({ ai: ai(), services: [familie(calls)] }, async (host, c) => {
    const mine = await c.area(ANNA, 'mine');
    const file = (await c.put(ANNA, mine.rootId, 'Versicherungsschein Kfz 2026.pdf', 'pdf', { mime: 'application/pdf', text: POLICY })).json.node;
    await host.tick();
    const f = createWindow(portalHtml(), frameGc(host, ANNA));
    const $ = (id) => f.document.getElementById(id);
    try {
      f.run();
      await until('the file', () => byText($('dp-main'), 'span', 'Versicherungsschein Kfz 2026.pdf'));
      const q = $('dp-q');
      q.value = 'Bis wann kann ich die Kfz-Versicherung kündigen?';
      q.dispatchEvent({ type: 'input' });
      await until('the prompt', () => textOf($('dp-main')).includes('Mit Enter fragen'));
      assert.equal(byText($('dp-main'), 'button', 'Fragen').getAttribute('aria-pressed'), 'true');
      assert.equal(host.aiRequests.filter((r) => /^drive_ask/.test(r.task)).length, 0, 'nothing asked while typing');
      q.dispatchEvent({ type: 'keydown', key: 'Enter' });
      await until('the answer', () => $('dp-main').querySelector('.dp-k-answer') && textOf($('dp-main')).includes('1 Quelle'));
      const main = textOf($('dp-main'));
      assert.ok(main.includes('Kündigen kannst du bis 30.11.2026.'), main);
      assert.equal(textOf($('dp-main').querySelector('.dp-k-answer').querySelector('b')), '30.11.2026', 'the date bold');
      assert.ok(main.includes('„Verlängerung um jeweils ein Jahr“'));
      assert.ok(main.includes('Antwort nur aus deinen Dateien. Tresore werden nie durchsucht.'));
      assert.equal(textOf($('dp-crumbs')), 'Frage an die Dokumente');
      buttonOf($('dp-main'), 'Frist in den Familienkalender').click();
      await until('in the calendar', () => buttonOf($('dp-main'), 'Im Familienkalender ✓'));
      assert.deepEqual(calls, [{ userId: ANNA.id, title: 'Kfz-Versicherung kündigen', startsAt: '2026-11-30', allDay: true }]);
      // the source opens its file
      $('dp-main').querySelector('.dp-k-src').click();
      await until('the file shown', () => textOf($('dp-crumbs')).includes('Meine Dateien'));
      assert.ok(file.id);
      // nothing found
      q.value = 'Wann muss der Hund zum Impfen?';
      q.dispatchEvent({ type: 'input' });
      await until('the prompt', () => textOf($('dp-main')).includes('Mit Enter fragen'));
      q.dispatchEvent({ type: 'keydown', key: 'Enter' });
      await until('none', () => textOf($('dp-main')).includes('Dazu habe ich in deinen Dateien nichts gefunden.'));
      assert.ok(textOf($('dp-main')).includes('Gesucht nach: hund · in Meine Dateien und Familie Berg'));
      // "Dateien": the file search again
      byText($('dp-main'), 'button', 'Dateien').click();
      await until('files', () => textOf($('dp-crumbs')).includes('Ergebnisse') || textOf($('dp-crumbs')).includes('Hund'));
    } finally {
      f.stop();
    }
  });
});

test('smoke: "Fristen" by month — tag, "neu", the family calendar; the area switch in the settings', async () => {
  const calls = [];
  await withHost({ ai: ai(), services: [familie(calls)] }, async (host, c) => {
    const mine = await c.area(ANNA, 'mine');
    await c.put(ANNA, mine.rootId, 'Versicherungsschein Kfz 2026.pdf', 'pdf', { mime: 'application/pdf', text: POLICY });
    await host.tick();
    const f = createWindow(portalHtml(), frameGc(host, ANNA));
    const $ = (id) => f.document.getElementById(id);
    try {
      f.run();
      await until('the app', () => !$('dp-app').hidden && navItem($('dp-nav'), 'Fristen'));
      navItem($('dp-nav'), 'Fristen').click();
      await until('the list', () => byText($('dp-main'), 'button', 'Versicherungsschein Kfz 2026.pdf'));
      const main = textOf($('dp-main'));
      for (const s of ['November 2026', 'Vertragsverlängerung', 'kündigen bis', 'neu', 'Kfz-Versicherung kündigen', 'Musterversicherung AG', 'Aus deinen Dokumenten erkannt']) assert.ok(main.includes(s), s);
      buttonOf($('dp-main'), 'In den Familienkalender').click();
      await until('in the calendar', () => buttonOf($('dp-main'), 'Im Familienkalender ✓'));
      assert.equal(calls.length, 1);
      // the area's switch
      navItem($('dp-nav'), 'Drive-Einstellungen').click();
      const sw = () => $('dp-main').querySelectorAll('input').find((x) => x.getAttribute('aria-label') === 'Neue Fristen in den Familienkalender · Meine Dateien');
      await until('the switch', () => sw() && !sw().checked);
      sw().checked = true;
      sw().dispatchEvent({ type: 'change', target: sw() });
      await until('on', () => sw() && sw().checked);
      assert.equal((await c.area(ANNA, 'mine')).deadlinesToCalendar, true);
    } finally {
      f.stop();
    }
  });
});

test('smoke: "In Dokument umwandeln" — Scan prüfen, Excel with the preview, uploaded and filed, the original kept', async () => {
  await withHost({ ai: ai() }, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const house = (await a('POST', 'nodes', { parentId: mine.rootId, name: 'Haus' })).json.node;
    const pic = (await c.put(ANNA, house.id, 'Zähler.jpg', 'jpeg', { mime: 'image/jpeg' })).json.node;
    const uploads = [];
    const f = createWindow(portalHtml(), frameGc(host, ANNA, uploads));
    f.window.atob = atob;
    f.window.btoa = btoa;
    const $ = (id) => f.document.getElementById(id);
    try {
      f.run();
      await until('the app', () => !$('dp-app').hidden && navItem($('dp-nav'), 'Meine Dateien'));
      navItem($('dp-nav'), 'Meine Dateien').click();
      await until('Haus', () => byText($('dp-main'), 'span', 'Haus'));
      const folder = $('dp-main').querySelectorAll('[data-node]').find((x) => x.getAttribute('data-node') === String(house.id));
      folder.querySelector('.dp-open').click();
      await until('the scan', () => byText($('dp-main'), 'span', 'Zähler.jpg'));
      $('dp-main').querySelectorAll('[data-node]').find((x) => x.getAttribute('data-node') === String(pic.id)).querySelector('.dp-more').click();
      await until('the action', () => buttonOf($('dp-dialog'), 'In Dokument umwandeln'));
      buttonOf($('dp-dialog'), 'In Dokument umwandeln').click();
      await until('the preview', () => $('dp-dialog').querySelector('.dp-k-grid'));
      const d = textOf($('dp-dialog'));
      for (const s of ['Scan prüfen', 'Erkannt: Tabelle', '3 Spalten, 2 Zeilen, Summenzeile', 'Als Excel-Datei ablegen?', 'Kopfzeile fixiert', 'Meine Dateien › Haus', 'Original-Scan behalten', 'Ausgewertet über den KI-Anbieter']) assert.ok(d.includes(s), s);
      assert.equal(byText($('dp-dialog'), 'button', 'Excel').getAttribute('aria-pressed'), 'true');
      assert.deepEqual($('dp-dialog').querySelectorAll('button').filter((b) => b.getAttribute('aria-pressed') != null).map((b) => textOf(b)), ['PDF', 'Word', 'Excel'], 'PDF for a JPEG, Excel for a table');
      assert.ok(textOf($('dp-dialog').querySelector('.dp-k-grid')).includes('41497'));
      const nameIn = $('dp-dialog').querySelectorAll('input').find((x) => x.getAttribute('aria-label') === 'Name');
      assert.equal(nameIn.value, '2026-10-26 Zählerstände.xlsx');
      buttonOf($('dp-dialog'), 'Als Excel-Datei speichern').click();
      await until('saved', () => textOf($('dp-toast')).includes('Gespeichert: 2026-10-26 Zählerstände.xlsx'));
      assert.deepEqual(uploads.map((u) => u.mime), ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
      const kids = (await a('GET', `nodes/${house.id}/children`)).json.items.map((n) => n.name).sort();
      assert.deepEqual(kids, ['2026-10-26 Zählerstände.xlsx', 'Zähler.jpg']);
      assert.equal((await a('GET', 'search', null, { q: '41497' })).json.items[0].name, '2026-10-26 Zählerstände.xlsx');
    } finally {
      f.stop();
    }
  });
});

test('smoke: "Fotos" — the search by what is on them, the chips, the count', async () => {
  await withHost({}, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const p1 = (await c.put(ANNA, mine.rootId, 'strand.jpg', 'j1', { mime: 'image/jpeg' })).json.node;
    const p2 = (await c.put(ANNA, mine.rootId, 'meer.jpg', 'j2', { mime: 'image/jpeg' })).json.node;
    await c.put(ANNA, mine.rootId, 'katze.jpg', 'j3', { mime: 'image/jpeg' });
    await a('PUT', `nodes/${p1.id}/labels`, { labels: ['beach', 'sunset'] });
    await a('PUT', `nodes/${p2.id}/labels`, { labels: ['beach', 'sea'] });
    const f = createWindow(portalHtml(), frameGc(host, ANNA));
    const $ = (id) => f.document.getElementById(id);
    try {
      f.run();
      await until('the app', () => !$('dp-app').hidden && navItem($('dp-nav'), 'Fotos'));
      navItem($('dp-nav'), 'Fotos').click();
      await until('the photos', () => $('dp-main').querySelectorAll('.dp-ph').length === 3);
      const q = $('dp-main').querySelector('.dp-k-phq');
      assert.equal(q.getAttribute('aria-label'), 'Fotos durchsuchen');
      q.value = 'Strand';
      q.dispatchEvent({ type: 'keydown', key: 'Enter' });
      await until('the hits', () => $('dp-main').querySelector('.dp-k-phs') && $('dp-main').querySelectorAll('.dp-ph').length === 2);
      const main = textOf($('dp-main'));
      assert.ok(main.includes('2 Fotos') && main.includes('+ Meer') && main.includes('+ Sonnenuntergang') && main.includes('Begriffe auf dem Handy erkannt.'), main);
      byText($('dp-main'), 'button', '+ Meer').click();
      await until('one', () => $('dp-main').querySelectorAll('.dp-ph').length === 1 && $('dp-main').querySelector('.dp-k-phq').value === 'Strand Meer');
      const q2 = $('dp-main').querySelector('.dp-k-phq');
      q2.value = 'Giraffe';
      q2.dispatchEvent({ type: 'keydown', key: 'Enter' });
      await until('none', () => textOf($('dp-main')).includes('Keine Fotos mit diesen Begriffen.'));
    } finally {
      f.stop();
    }
  });
});
