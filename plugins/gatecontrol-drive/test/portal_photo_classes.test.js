'use strict';

// The portal (1.13.0, feature photoClasses): "Fotos" with the chips "Alle | Privat | Arbeit | Prüfen (N)" (the band of
// photos to check until 1.17.x), the question mark and the bag on the tiles; chosen photos that are all to be checked get "Arbeit" and
// "Privat" up front with the AI's guess — Arbeit moves them into the work folder by month, the snackbar undoes it;
// "Zuordnung" for the others; "Arbeitsfotos nach" in the Drive settings.

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
    const v = await fn();
    if (v) return v;
    await tick();
  }
  throw new Error('timed out waiting for ' + what);
}
const textOf = (n) => (n.nodeType === 3 ? n.data : n.childNodes.map(textOf).join(''));
const byText = (root, tag, text) => root.querySelectorAll(tag).find((e) => textOf(e).trim() === text);
const buttonOf = (root, text) => { let s = byText(root, 'span', text) || byText(root, 'button', text); while (s && s.localName !== 'button') s = s.parentNode; return s; };
const navItem = (nav, label) => {
  const icon = nav.querySelectorAll('[aria-label]').find((e) => e.getAttribute('aria-label') === label);
  if (icon) return icon;
  return buttonOf(nav, label);
};

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
    async upload() { throw new Error('no upload here'); },
    on() {},
  };
}

async function setup(c) {
  const a = c.as(ANNA);
  const mine = await c.area(ANNA, 'mine');
  const mk = async (p, n) => (await a('POST', 'nodes', { parentId: p, name: n })).json.node;
  const cam = (await a('POST', 'photos/camera')).json.folder;
  const month = await mk(await mk(cam.id, '2026').then((x) => x.id), '10');
  const arbeit = await mk(mine.rootId, 'Arbeit');
  const put = async (p, n, t0) => (await c.put(ANNA, p, n, n, { mime: 'image/jpeg', takenAt: t0 })).json.node;
  const t0 = new Date(2026, 9, 20, 12).getTime();
  const r1 = await put(month.id, 'r1.jpg', t0);
  const r2 = await put(month.id, 'r2.jpg', t0 + 1000);
  const priv = await put(month.id, 'privat.jpg', t0 + 2000);
  const job = await put(arbeit.id, 'job.jpg', t0 + 3000);
  assert.equal((await a('PUT', 'photos/settings', { workFolder: arbeit.id })).status, 200);
  await a('POST', 'photos/review', { ids: [r1.id], review: true, hint: 80 });
  await a('POST', 'photos/review', { ids: [r2.id], review: true, hint: 70 });
  return { a, mine, cam, month, arbeit, r1, r2, priv, job };
}

test('portal: the chips (since 1.18.0 without the band), the marks; all to check chosen → Arbeit up front, moved by month, undone', async () => {
  await withHost({}, async (host, c) => {
    const s = await setup(c);
    const f = createWindow(portalHtml(), frameGc(host, ANNA));
    const $ = (id) => f.document.getElementById(id);
    try {
      f.run();
      await until('the app', () => !$('dp-app').hidden && navItem($('dp-nav'), 'Fotos'));
      navItem($('dp-nav'), 'Fotos').click();
      await until('the chips', () => $('dp-main').querySelector('.dp-wk-chips') && $('dp-main').querySelectorAll('.dp-ph').length === 4);
      const chips = $('dp-main').querySelector('.dp-wk-chips');
      assert.equal(textOf(chips), 'AllePrivatArbeitPrüfen2');
      // since 1.18.0 no band: the chip's count (the overview has "2 Fotos prüfen")
      assert.ok(!textOf($('dp-main')).includes('zu prüfen –'));
      assert.equal($('dp-main').querySelectorAll('.dp-ph-mk').length, 2, 'two tiles');
      assert.equal($('dp-main').querySelectorAll('.dp-ph-wk').length, 1, 'the bag on the work photo');
      // "Prüfen": only those
      buttonOf(chips, 'Prüfen').click();
      await until('to check', () => $('dp-main').querySelectorAll('.dp-ph').length === 2 && !textOf($('dp-main')).includes('zu prüfen –'));
      // choose both: Arbeit and Privat up front, the AI's guess (80 and 70 → 75 %)
      buttonOf($('dp-main'), 'Auswählen').click();
      await until('choosing', () => $('dp-main').querySelectorAll('.dp-ph-check').length === 2);
      $('dp-main').querySelectorAll('.dp-ph')[0].click();
      $('dp-main').querySelectorAll('.dp-ph')[1].click();
      await until('the review bar', () => buttonOf($('dp-main'), 'Arbeit') && textOf($('dp-main')).includes('KI: wahrscheinlich Arbeit · 75 % sicher'));
      assert.ok(buttonOf($('dp-main'), 'Privat'));
      assert.equal(buttonOf($('dp-main').querySelector('.dp-ph-bar'), 'Zuordnung'), undefined);
      buttonOf($('dp-main'), 'Arbeit').click();
      await until('the snackbar', () => !$('dp-snack').hidden && textOf($('dp-snack')).includes('2 Fotos → Meine Dateien › Arbeit'));
      await ops.idle();
      // on the server: in Arbeit/2026/10, the marks gone
      const y = (await s.a('GET', 'nodes/by-path', null, { area: s.mine.id, path: 'Arbeit/2026/10' })).json.node;
      for (const n of [s.r1, s.r2]) {
        const v = (await s.a('GET', `nodes/${n.id}`)).json.node;
        assert.deepEqual([v.parentId, 'review' in v], [y.id, false]);
      }
      await until('nothing to check', () => textOf($('dp-main')).includes('Nichts zu prüfen.'));
      // undo: back into the camera uploads, marked again with their hints
      buttonOf($('dp-snack'), 'Rückgängig').click();
      await until('undone', async () => {
        await ops.idle();
        const v = (await s.a('GET', `nodes/${s.r1.id}`)).json.node;
        return v.parentId === s.month.id && v.review && v.review.hint === 80;
      });
      await until('r2 back', async () => (await s.a('GET', `nodes/${s.r2.id}`)).json.node.review?.hint === 70);
    } finally {
      f.close && f.close();
    }
  });
});

test('portal: "Zuordnung" for a private photo marks it; "Arbeitsfotos nach" in the Drive settings', async () => {
  await withHost({}, async (host, c) => {
    const s = await setup(c);
    const f = createWindow(portalHtml(), frameGc(host, ANNA));
    const $ = (id) => f.document.getElementById(id);
    try {
      f.run();
      await until('the app', () => !$('dp-app').hidden && navItem($('dp-nav'), 'Fotos'));
      navItem($('dp-nav'), 'Fotos').click();
      await until('the chips', () => $('dp-main').querySelector('.dp-wk-chips') && $('dp-main').querySelectorAll('.dp-ph').length === 4);
      buttonOf($('dp-main').querySelector('.dp-wk-chips'), 'Privat').click();
      await until('private', () => $('dp-main').querySelectorAll('.dp-ph').length === 1);
      buttonOf($('dp-main'), 'Auswählen').click();
      await until('choosing', () => $('dp-main').querySelectorAll('.dp-ph-check').length === 1);
      $('dp-main').querySelectorAll('.dp-ph')[0].click();
      await until('the normal bar', () => buttonOf($('dp-main'), 'Zuordnung'));
      assert.equal(buttonOf($('dp-main').querySelector('.dp-ph-bar'), 'Arbeit'), undefined);
      buttonOf($('dp-main'), 'Zuordnung').click();
      await until('the menu', () => byText($('dp-dialog'), 'span', 'Zum Prüfen markieren'));
      assert.ok(textOf($('dp-dialog')).includes('Verschiebt nach „Meine Dateien › Arbeit“'));
      assert.equal(buttonOf($('dp-dialog'), 'Ist privat').disabled, true, 'schon privat');
      buttonOf($('dp-dialog'), 'Zum Prüfen markieren').click();
      await until('marked', () => !$('dp-snack').hidden && textOf($('dp-snack')).includes('1 Foto zum Prüfen markiert'));
      assert.deepEqual((await s.a('GET', `nodes/${s.priv.id}`)).json.node.review, { hint: null });
      // the Drive settings: "Arbeitsfotos nach" with the path, a new folder chosen
      navItem($('dp-nav'), 'Drive-Einstellungen').click();
      await until('the section', () => textOf($('dp-main')).includes('Arbeitsfotos nach') && textOf($('dp-main')).includes('Meine Dateien › Arbeit'));
      assert.ok(textOf($('dp-main')).includes('Arbeitsfotos nie in Erinnerungen und Fotorahmen'));
      buttonOf($('dp-main'), 'Ändern').click();
      await until('the picker', () => textOf($('dp-dialog')).includes('Ziel: Meine Dateien › Arbeit'));
      buttonOf($('dp-dialog'), 'Eine Ebene höher').click();
      await until('the top', () => buttonOf($('dp-dialog'), 'Bilder'));
      buttonOf($('dp-dialog'), 'Bilder').click();
      await until('Bilder', () => textOf($('dp-dialog')).includes('Ziel: Meine Dateien › Bilder'));
      buttonOf($('dp-dialog'), 'Diesen Ordner nehmen').click();
      await until('refused', () => textOf($('dp-dialog')).includes('„Kamera-Uploads“ und die Ordner darüber gehen nicht'));
      buttonOf($('dp-dialog'), 'Neuer Ordner „Arbeit“ hier').click();
      await until('the new folder', () => textOf($('dp-dialog')).includes('Ziel: Meine Dateien › Bilder › Arbeit'));
      buttonOf($('dp-dialog'), 'Diesen Ordner nehmen').click();
      await until('saved', () => $('dp-dialog').hidden && textOf($('dp-main')).includes('Meine Dateien › Bilder › Arbeit'));
      const st = (await s.a('GET', 'photos/settings')).json;
      assert.equal(st.folder.path, 'Bilder/Arbeit');
    } finally {
      f.close && f.close();
    }
  });
});
