'use strict';

// The portal's places and people of 1.16.0 (ui/places.js) in the small fake DOM against the mock host: "Fotos" with the
// search's marks and suggestions (a place: the result with its districts), "Personen" with "Wer ist das?" (naming, then
// "Rückgängig"), a person with "Ist das auch …?", "Karte" without Leaflet (the places below), and "Orte und Personen" in
// the Drive settings ("Alle Gesichtsdaten löschen" after asking).

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

// exact face vectors: identity i is the unit vector e_i, each face 0.8 to it along its own direction
const DIM = 128;
let dir = 20;
function faceVec(i) {
  const v = new Float32Array(DIM);
  v[i] = 0.8;
  v[dir++] = 0.6;
  return Buffer.from(v.buffer).toString('base64');
}

/** Anna: people on, four photos of identity 0 (two in Hamburg-Altona, two in Köln), three of identity 1 in Hamburg. */
async function setup(c) {
  const a = c.as(ANNA);
  const mine = await c.area(ANNA, 'mine');
  await a('PUT', 'photos/settings', { people: true });
  const shots = [[0, { lat: 53.552, lon: 9.9354 }], [0, { lat: 53.5521, lon: 9.9355 }], [0, { lat: 50.9413, lon: 6.9583 }], [0, { lat: 50.9413, lon: 6.9583 }],
    [1, { lat: 53.5452, lon: 9.9667 }], [1, { lat: 53.5452, lon: 9.9667 }], [1, { lat: 53.5452, lon: 9.9667 }]];
  let k = 0;
  for (const [who, geo] of shots) {
    k++;
    const r = await c.put(ANNA, mine.rootId, `p${k}.jpg`, `p${k}`, { mime: 'image/jpeg', takenAt: Date.UTC(2026, 2, 10 + k, 12), geo });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const x = await a('PUT', `nodes/${r.json.node.id}/faces`, { model: 'sface-2021dec', faces: [{ box: [0.3, 0.2, 0.2, 0.25], score: 0.9, embedding: faceVec(who) }] });
    assert.equal(x.status, 200, JSON.stringify(x.json));
  }
  const people = (await a('GET', 'people')).json.people;
  assert.equal(people.length, 2);
  return { a, mine, people };
}

test('smoke: "Personen" — "Wer ist das?", naming with "Rückgängig"; a person; the search with a person and a place', async () => {
  await withHost({}, async (host, c) => {
    const s = await setup(c);
    const calls = [];
    const f = createWindow(portalHtml(), frameGc(host, ANNA, calls));
    const $ = (id) => f.document.getElementById(id);
    try {
      f.run();
      await until('the app', () => !$('dp-app').hidden && navItem($('dp-nav'), 'Personen'));
      assert.ok(navItem($('dp-nav'), 'Karte'), '"Karte" below "Fotos"');
      navItem($('dp-nav'), 'Personen').click();
      await until('people', () => textOf($('dp-main')).includes('Wer ist das?'));
      assert.ok(textOf($('dp-main')).includes('0 benannt · 2 noch ohne Namen'));
      assert.ok(textOf($('dp-main')).includes('Alle 7 Fotos angesehen'));
      // name the one with four photos
      const four = $('dp-main').querySelectorAll('.dp-pp-p').find((b) => textOf(b).includes('4 Fotos'));
      four.click();
      const input = await until('the dialog', () => $('dp-dialog').querySelector('input'));
      assert.ok(textOf($('dp-dialog')).includes('4 Fotos · 2026'));
      // suggestions of the family (the accounts of this server)
      input.value = 'Mar';
      input.dispatchEvent({ type: 'input' });
      await until('suggestion', () => textOf($('dp-dialog')).includes('Marc'));
      input.value = 'Mama';
      input.dispatchEvent({ type: 'input' });
      byText($('dp-dialog'), 'span', 'Speichern').parentNode.click();
      await until('saved', () => textOf($('dp-dialog')).includes('„Mama“ gespeichert'));
      const mama = s.people.find((p) => p.count === 4);
      assert.equal((await s.a('GET', `people/${mama.id}`)).json.person.name, 'Mama');
      // "Rückgängig": the name goes again
      byText($('dp-dialog'), 'span', 'Rückgängig').parentNode.click();
      await until('undone', () => $('dp-dialog').hidden);
      assert.equal((await s.a('GET', `people/${mama.id}`)).json.person.name, null);
      await s.a('PATCH', `people/${mama.id}`, { name: 'Mama' });
      // the person's page: "Zusammen mit" none, the places
      navItem($('dp-nav'), 'Personen').click();
      await until('named', () => textOf($('dp-main')).includes('Benannt'));
      $('dp-main').querySelectorAll('.dp-pp-p').find((b) => textOf(b).includes('Mama')).click();
      await until('person', () => textOf($('dp-main')).includes('Köln · 2'));
      assert.ok(textOf($('dp-main')).includes('Hamburg · 2'));
      // a place of the person: Fotos with both marks
      byText($('dp-main'), 'button', 'Hamburg · 2').click();
      await until('result', () => textOf($('dp-main')).includes('2 Fotos mit Mama in Hamburg'));
      assert.ok(textOf($('dp-main')).includes('Ortsteile'));
      assert.ok(textOf($('dp-main')).includes('Altona'));
      const q = calls.filter((x) => x.path === 'photos').pop().query;
      assert.deepEqual([q.person, q.place, q.districts, q.with], [String(mama.id), 'geonames:2911298', '1', 'people']);
      // the search's marks: remove the person → every photo in Hamburg
      $('dp-main').querySelectorAll('.dp-pp-tx').find((b) => b.getAttribute('aria-label') === 'Mama entfernen').click();
      await until('Hamburg only', () => textOf($('dp-main')).includes('5 Fotos in Hamburg'));
      // suggestions while typing: a person
      const field = $('dp-main').querySelector('.dp-pp-in');
      field.value = 'ma';
      field.dispatchEvent({ type: 'input' });
      const row = await until('suggestion', () => $('dp-main').querySelectorAll('.dp-pp-sugrow').find((b) => textOf(b).includes('Mama')));
      row.click();
      await until('both again', () => textOf($('dp-main')).includes('2 Fotos mit Mama in Hamburg'));
    } finally {
      f.stop();
    }
  });
});

test('smoke: "Karte" without Leaflet (the places below), the settings "Orte und Personen", "Alle Gesichtsdaten löschen"', async () => {
  await withHost({}, async (host, c) => {
    const s = await setup(c);
    const calls = [];
    const f = createWindow(portalHtml(), frameGc(host, ANNA, calls));
    const $ = (id) => f.document.getElementById(id);
    try {
      f.run();
      await until('the app', () => !$('dp-app').hidden && navItem($('dp-nav'), 'Karte'));
      navItem($('dp-nav'), 'Karte').click();
      await until('places', () => $('dp-main').querySelectorAll('.dp-pp-place').length === 2);
      assert.ok(textOf($('dp-main')).includes('GeoNames'), 'the attribution');
      assert.ok(textOf($('dp-main')).includes('Hamburg') && textOf($('dp-main')).includes('5 Fotos'));
      $('dp-main').querySelectorAll('.dp-pp-place')[0].click();
      await until('the place', () => textOf($('dp-main')).includes('5 Fotos in Hamburg'));
      // the settings
      $('dp-nav').querySelectorAll('[aria-label]').find((e) => e.getAttribute('aria-label') === 'Drive-Einstellungen').click();
      await until('section', () => textOf($('dp-main')).includes('Alle Gesichtsdaten löschen'));
      assert.ok(textOf($('dp-main')).includes('Aufnahmeort mitsichern'));
      assert.ok(!textOf($('dp-main')).includes('Ort beim Teilen entfernen'), 'not offered by this server');
      const del = $('dp-main').querySelectorAll('.dp-set-row').find((r) => textOf(r).includes('Alle Gesichtsdaten löschen')).querySelector('button');
      del.click();
      await until('asks', () => textOf($('dp-dialog')).includes('Alle Gesichtsdaten löschen?'));
      $('dp-dialog').querySelectorAll('button').find((b) => b.className.includes('dp-btn-danger')).click();
      await until('deleted', () => textOf($('dp-toast')).includes('Gesichtsdaten gelöscht (7 Gesichter)'));
      const st = (await s.a('GET', 'photos/settings')).json;
      assert.equal(st.people, false);
      assert.deepEqual((await s.a('GET', 'people')).json.people, []);
      await until('the switch off', () => textOf($('dp-main')).includes('So funktioniert es'));
    } finally {
      f.stop();
    }
  });
});
