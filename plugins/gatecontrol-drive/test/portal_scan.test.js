'use strict';

// The portal and GateControl's virus scan (1.19.0) in the small fake DOM against the mock host (opts.scan): the chips
// "Gesperrt – Schadsoftware", "Wird geprüft …", "Warnung – Schadsoftware", quietly "Nicht prüfbar"; a blocked file's
// menu says why and offers no download, preview, office or sharing; an upload the scan refuses (422 infected, the
// code in GC.upload's data as the real bridge hands it) says "Datei abgelehnt – Schadsoftware gefunden."

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

/** window.GC of a portal frame; GC.upload refuses like GateControl's bridge: Error(code) with status and data. */
function frameGc(host, user) {
  const viewer = { ...user, portal: true, loggedIn: true };
  return {
    async call(method, p, body) {
      const [pathPart, qs] = String(p).split('?');
      const query = Object.fromEntries(new URLSearchParams(qs || ''));
      const r = await host.request({ method, path: pathPart, query, body: body === undefined ? null : body, user: viewer, lang: 'de' });
      if (r.status !== 200) { const e = new Error('http ' + r.status); e.status = r.status; e.data = r.json; throw e; }
      return r.json;
    },
    async upload(file) {
      const r = await host.upload(user, Buffer.from(file.data), file.type || 'application/octet-stream');
      if (r.status !== 200) throw Object.assign(new Error(r.body.code), { status: r.status, data: r.body });
      return { mediaId: r.body.mediaId, mime: r.body.mime, bytes: r.body.bytes };
    },
    on() {},
  };
}

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

test('portal: chips of the scan, a blocked file\'s menu, a refused upload', async () => {
  const scanner = (f) => {
    const s = f.data.toString();
    if (s.includes('EICAR')) return { state: 'infected', finding: 'Eicar-Test-Signature' };
    if (s === 'pending') return { state: 'pending' };
    if (s === 'macro') return { state: 'infected', blocked: false, finding: 'GC.Office.Macro' };
    if (s === 'zip') return { state: 'unscannable', blocked: false, finding: 'encrypted' };
    if (s === 'virus') return { deleted: true, finding: 'Win.Trojan.Agent' };
    return null;
  };
  await withHost({ scan: scanner }, async (host, c) => {
    const mine = await c.area(ANNA, 'mine');
    await c.put(ANNA, mine.rootId, 'eicar.txt', EICAR);
    await c.put(ANNA, mine.rootId, 'gross.mp4', 'pending', { mime: 'video/mp4' });
    await c.put(ANNA, mine.rootId, 'makro.docm', 'macro');
    await c.put(ANNA, mine.rootId, 'geheim.zip', 'zip', { mime: 'application/zip' });
    await c.put(ANNA, mine.rootId, 'brief.txt', 'hallo');
    const f = createWindow(portalHtml(), frameGc(host, ANNA));
    const $ = (id) => f.document.getElementById(id);
    try {
      f.run();
      const b = await until('the switch', () => byText($('dp-pages'), 'button', 'Dateien'));
      b.click();
      await until('files', () => byText($('dp-main'), 'span', 'eicar.txt'));
      await until('the cards', () => $('dp-main').querySelectorAll('.dp-card').length === 5);
      const card = (name) => $('dp-main').querySelectorAll('.dp-card').find((x) => textOf(x).includes(name));
      const chip = (name) => { const x = card(name).querySelector('.dp-scan'); return x ? textOf(x) : null; };
      assert.equal(chip('eicar.txt'), 'Gesperrt – Schadsoftware');
      assert.equal(chip('gross.mp4'), 'Wird geprüft …');
      assert.equal(chip('makro.docm'), 'Warnung – Schadsoftware');
      assert.equal(chip('geheim.zip'), 'Nicht prüfbar');
      assert.equal(chip('brief.txt'), null);
      // a click on the blocked file: its menu with the reason, nothing that opens it
      card('eicar.txt').querySelector('.dp-open').click();
      await until('menu', () => textOf($('dp-dialog')).includes('Schadsoftware gefunden (Eicar-Test-Signature)'));
      for (const no of ['Herunterladen', 'Vorschau', 'Teilen']) assert.ok(!byText($('dp-dialog'), 'span', no), no);
      assert.ok(byText($('dp-dialog'), 'span', 'In den Papierkorb'), 'it can still go');
      // a refused upload
      const input = $('dp-file');
      input.files = [{ name: 'virus.exe', data: 'virus', type: 'application/octet-stream', size: 5, lastModified: Date.UTC(2026, 9, 20) }];
      input.dispatchEvent({ type: 'change', target: input });
      await until('refused', () => textOf($('dp-ups')).includes('Datei abgelehnt – Schadsoftware gefunden.'));
    } finally {
      f.stop();
    }
  });
});
