'use strict';

// Where photos were taken (1.16.0, feature photoPlaces — server/places.js, server/geonames.js): commit { geo }, PUT
// nodes/<id>/geo, geo / located on nodes and items, unlocated=1, place= / bbox= / districts=1, photos/places, photos/map,
// q= on place names, photos/suggest, keepGeo and DELETE photos/geo — and the offline names of GeoNames.

const test = require('node:test');
const assert = require('node:assert/strict');
const geonames = require('../server/geonames');
const { withHost, ANNA, MARC, LENA } = require('./helpers');

const HH_LANDUNGSBRUECKEN = { lat: 53.5452, lon: 9.9667 };
const HH_HAFENCITY = { lat: 53.5413, lon: 9.9984 };
const HH_ALTONA = { lat: 53.5520, lon: 9.9354 };
const KOELN_DOM = { lat: 50.9413, lon: 6.9583 };
const PALMA = { lat: 39.5696, lon: 2.6502 };

test('GeoNames offline: the nearest city and its district, German names, the region, the country; nothing far out at sea', () => {
  assert.ok(geonames.loaded());
  let r = geonames.lookup(HH_LANDUNGSBRUECKEN.lat, HH_LANDUNGSBRUECKEN.lon);
  assert.equal(r.city.name, 'Hamburg');
  assert.equal(r.city.country, 'DE');
  assert.equal(r.district.name, 'St. Pauli');
  r = geonames.lookup(KOELN_DOM.lat, KOELN_DOM.lon);
  assert.equal(r.city.name, 'Köln');
  assert.equal(r.city.regionDe, 'Nordrhein-Westfalen');
  r = geonames.lookup(48.137, 11.575);
  assert.equal(r.city.de, 'München');
  r = geonames.lookup(PALMA.lat, PALMA.lon);
  assert.equal(r.city.de, 'Palma de Mallorca');
  assert.equal(r.city.regionDe, 'Balearen');
  r = geonames.lookup(0, -30);
  assert.deepEqual(r, { city: null, district: null });
  // fast: a grid, not every place
  const t = Date.now();
  for (let i = 0; i < 5000; i++) geonames.lookup(47 + (i % 70) / 10, 6 + (i % 90) / 10);
  assert.ok(Date.now() - t < 2000, 'lookups take ' + (Date.now() - t) + ' ms');
});

/** Anna's photos: two at the Landungsbrücken, one in the HafenCity, one in Altona, two in Köln, one in Palma, one without. */
async function setup(c) {
  const a = c.as(ANNA);
  const mine = await c.area(ANNA, 'mine');
  const base = Date.UTC(2026, 2, 14, 12);
  const put = async (name, geo, t, o = {}) => {
    const r = await c.put(ANNA, mine.rootId, name, name, { mime: 'image/jpeg', takenAt: base + t * 3600000, ...(geo ? { geo } : {}), ...o });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json.node;
  };
  const p = {
    lb1: await put('lb1.jpg', HH_LANDUNGSBRUECKEN, 0),
    lb2: await put('lb2.jpg', { lat: '53.54521', lon: '9.96671' }, 1),
    hc: await put('hc.jpg', HH_HAFENCITY, -24),
    al: await put('al.jpg', HH_ALTONA, -24 * 200),
    k1: await put('k1.jpg', KOELN_DOM, -24 * 400),
    k2: await put('k2.jpg', KOELN_DOM, -24 * 401),
    pm: await put('pm.jpg', PALMA, -24 * 900),
    none: await put('none.jpg', null, -24 * 1000),
  };
  return { a, mine, base, put, ...p };
}

test('commit { geo }: the place on the node and the photo item, located; invalid → 400, (0, 0) → none; features', async () => {
  await withHost({}, async (host, c) => {
    const t = await setup(c);
    const { a } = t;
    const me = (await a('GET', 'me')).json;
    assert.ok(me.features.includes('photoPlaces') && me.features.includes('photoPeople'));
    assert.deepEqual(t.lb1.geo, { lat: 53.5452, lon: 9.9667, place: { key: 'geonames:2911298', name: 'Hamburg', district: 'St. Pauli', region: 'Hamburg', country: 'DE' } });
    assert.equal(t.lb1.located, true);
    assert.equal(t.lb2.geo.lat, 53.54521);
    assert.deepEqual([t.none.geo, t.none.located], [null, false]);
    const n = (await a('GET', `nodes/${t.k1.id}`)).json.node;
    assert.equal(n.geo.place.name, 'Köln');
    assert.equal(n.geo.place.region, 'Nordrhein-Westfalen');
    const items = (await a('GET', 'photos')).json.items;
    const pm = items.find((x) => x.id === t.pm.id);
    assert.equal(pm.geo.place.name, 'Palma de Mallorca');
    assert.equal(pm.geo.place.country, 'ES');
    assert.equal(items.find((x) => x.id === t.none.id).located, false);
    // children lists too
    const kids = (await a('GET', `nodes/${t.mine.rootId}/children`)).json.items;
    assert.equal(kids.find((x) => x.id === t.hc.id).geo.place.district, 'HafenCity');
    // not a position
    for (const geo of [{ lat: 91, lon: 0 }, { lat: 'x', lon: 1 }, [1, 2], { lat: 10 }]) {
      const r = await c.put(ANNA, t.mine.rootId, 'bad.jpg', 'x', { mime: 'image/jpeg', geo });
      assert.equal(r.status, 400, JSON.stringify(geo));
      assert.equal(r.json.field, 'geo');
    }
    const zero = await t.put('zero.jpg', { lat: 0, lon: 0 }, 5);
    assert.equal(zero.geo, null);
    // a new version without geo keeps the place
    const v = await c.put(ANNA, t.mine.rootId, 'k1.jpg', 'k1 neu', { mime: 'image/jpeg', onConflict: 'version' });
    assert.equal(v.json.node.geo.place.name, 'Köln');
  });
});

test('PUT nodes/<id>/geo and unlocated=1: the phones fill places in; none marks; write access; keepGeo off drops', async () => {
  await withHost({}, async (host, c) => {
    const t = await setup(c);
    const { a } = t;
    let r = await a('GET', 'photos', null, { unlocated: '1' });
    assert.deepEqual(r.json.items.map((x) => x.id), [t.none.id]);
    r = await a('PUT', `nodes/${t.none.id}/geo`, { lat: 52.52, lon: 13.405 });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.node.geo.place.name, 'Berlin');
    assert.equal((await a('GET', 'photos', null, { unlocated: '1' })).json.items.length, 0);
    r = await a('PUT', `nodes/${t.none.id}/geo`, { none: true });
    assert.deepEqual([r.json.node.geo, r.json.node.located], [null, true]);
    assert.equal((await a('GET', 'photos', null, { unlocated: '1' })).json.items.length, 0);
    assert.equal((await a('PUT', `nodes/${t.none.id}/geo`, { lat: 'a' })).json.field, 'geo');
    // a parent may read the child's photo, not write to it: 403
    const child = await c.area(LENA, 'child');
    const lp = (await c.put(LENA, child.rootId, 'lena.jpg', 'l', { mime: 'image/jpeg' })).json.node;
    assert.equal((await c.as(ANNA)('PUT', `nodes/${lp.id}/geo`, HH_ALTONA)).status, 403);
    assert.equal((await c.as(MARC)('GET', 'photos', null, { unlocated: '1' })).json.items.length, 0, 'not the child\'s photo: Marc only reads it');
    // not a picture
    const txt = (await c.put(ANNA, t.mine.rootId, 'a.txt', 'text')).json.node;
    assert.equal((await a('PUT', `nodes/${txt.id}/geo`, HH_ALTONA)).json.field, 'id');
    // keepGeo off: no geo on commits, nothing to fill in, PUT stores nothing
    r = await a('PUT', 'photos/settings', { keepGeo: false });
    assert.equal(r.json.keepGeo, false);
    assert.equal(Object.prototype.hasOwnProperty.call(r.json, 'stripGeoOnShare'), false, 'not offered');
    const off = await t.put('off.jpg', HH_ALTONA, 7);
    assert.equal(off.geo, null);
    assert.equal((await a('GET', 'photos', null, { unlocated: '1' })).json.items.length, 0);
    r = await a('PUT', `nodes/${off.id}/geo`, HH_ALTONA);
    assert.deepEqual([r.json.node.geo, r.json.node.located], [null, false]);
  });
});

test('photos/places, place= with districts, bbox=, photos/map: by count, covers, clusters per zoom', async () => {
  await withHost({}, async (host, c) => {
    const t = await setup(c);
    const { a } = t;
    let r = await a('GET', 'photos/places');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.places.map((p) => [p.name, p.count]), [['Hamburg', 4], ['Köln', 2], ['Palma de Mallorca', 1]]);
    const hh = r.json.places[0];
    assert.equal(hh.key, 'geonames:2911298');
    assert.equal(hh.cover.id, t.lb2.id, 'the newest');
    assert.equal(hh.region, 'Hamburg');
    assert.equal(hh.to, new Date(t.base + 3600000).toISOString());
    assert.ok(hh.from < hh.to);
    r = await a('GET', 'photos', null, { place: hh.key, districts: '1' });
    assert.deepEqual(r.json.items.map((x) => x.name), ['lb2.jpg', 'lb1.jpg', 'hc.jpg', 'al.jpg']);
    assert.deepEqual(r.json.districts, [{ name: 'St. Pauli', count: 2 }, { name: 'Altona', count: 1 }, { name: 'HafenCity', count: 1 }]);
    r = await a('GET', 'photos/months', null, { place: hh.key });
    assert.deepEqual(r.json.months.map((m) => m.count).reduce((x, y) => x + y, 0), 4);
    assert.equal((await a('GET', 'photos', null, { place: 'hamburg' })).json.field, 'place');
    // bbox: Hamburg only
    r = await a('GET', 'photos', null, { bbox: '9.8,53.4,10.2,53.7' });
    assert.equal(r.json.items.length, 4);
    assert.equal((await a('GET', 'photos', null, { bbox: '1,2,3' })).json.field, 'bbox');
    // the map: the world at zoom 2 — Hamburg and Köln are one cluster, Palma another; zoomed in: one place each
    r = await a('GET', 'photos/map', null, { bbox: '-180,-85,180,85', zoom: '2' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const total = r.json.clusters.reduce((s, x) => s + x.count, 0);
    assert.equal(total, 7);
    r = await a('GET', 'photos/map', null, { bbox: '0,35,15,60', zoom: '9' });
    assert.equal(r.json.clusters.reduce((s, x) => s + x.count, 0), 7);
    for (const cl of r.json.clusters) {
      assert.ok(cl.cover && cl.cover.previewUrl !== undefined);
      assert.ok(cl.lat > 35 && cl.lat < 60);
    }
    assert.ok(r.json.clusters.some((x) => x.key === 'geonames:2886242' && x.count === 2), 'Köln as one cluster with its key');
    assert.equal((await a('GET', 'photos/map', null, { bbox: '0,35,15,60', zoom: '22' })).json.field, 'zoom');
    assert.equal((await a('GET', 'photos/map', null, { zoom: '3' })).json.field, 'bbox');
    // across the date line
    r = await a('GET', 'photos/map', null, { bbox: '170,-10,-170,10', zoom: '5' });
    assert.deepEqual(r.json.clusters, []);
    // Marc sees none of Anna's
    assert.deepEqual((await c.as(MARC)('GET', 'photos/places')).json.places, []);
  });
});

test('q= on place names (German, English, region, country, without accents, word start) and photos/suggest', async () => {
  await withHost({}, async (host, c) => {
    const t = await setup(c);
    const { a } = t;
    const names = async (q) => (await a('GET', 'photos', null, { q })).json.items.map((x) => x.name).sort();
    assert.deepEqual(await names('hamburg'), ['al.jpg', 'hc.jpg', 'lb1.jpg', 'lb2.jpg']);
    assert.deepEqual(await names('Koeln'), ['k1.jpg', 'k2.jpg']);
    assert.deepEqual(await names('köln'), ['k1.jpg', 'k2.jpg']);
    assert.deepEqual(await names('Cologne'), ['k1.jpg', 'k2.jpg']);
    assert.deepEqual(await names('nordrhein'), ['k1.jpg', 'k2.jpg']);
    assert.deepEqual(await names('Mallorca'), ['pm.jpg']);
    assert.deepEqual(await names('spanien'), ['pm.jpg']);
    assert.deepEqual(await names('spain'), ['pm.jpg']);
    assert.deepEqual(await names('pauli'), ['lb1.jpg', 'lb2.jpg']);
    assert.deepEqual(await names('hamb'), ['al.jpg', 'hc.jpg', 'lb1.jpg', 'lb2.jpg']);
    assert.deepEqual(await names('altona hamburg'), ['al.jpg']);
    assert.deepEqual(await names('deutschland'), ['al.jpg', 'hc.jpg', 'k1.jpg', 'k2.jpg', 'lb1.jpg', 'lb2.jpg']);
    // a label and a place: every word one of them
    await a('PUT', `nodes/${t.k1.id}/labels`, { labels: ['dog'], source: 'device' });
    assert.deepEqual(await names('hund köln'), ['k1.jpg']);
    const r = await a('GET', 'photos', null, { q: 'hund köln' });
    assert.deepEqual(r.json.search.places, [{ key: 'geonames:2886242', name: 'Köln' }]);
    assert.deepEqual(r.json.search.people, []);
    // suggestions while typing
    let s = await a('GET', 'photos/suggest', null, { q: 'ham' });
    assert.equal(s.status, 200, JSON.stringify(s.json));
    assert.deepEqual(s.json.places[0], { key: 'geonames:2911298', name: 'Hamburg', sub: 'Hamburg, Deutschland', count: 4 });
    s = await a('GET', 'photos/suggest', null, { q: 'alt' });
    assert.ok(s.json.places.some((p) => p.name === 'Altona' && p.sub === 'Hamburg'));
    s = await a('GET', 'photos/suggest', null, { q: 'hun' });
    assert.deepEqual(s.json.labels, [{ label: 'dog', text: 'Hund', count: 1 }]);
    assert.equal((await a('GET', 'photos/suggest', null, { q: '' })).status, 400);
    // a district key filters that district
    const altona = (await a('GET', 'photos/suggest', null, { q: 'altona' })).json.places.find((p) => p.name === 'Altona');
    assert.deepEqual((await a('GET', 'photos', null, { place: altona.key })).json.items.map((x) => x.name), ['al.jpg']);
  });
});

test('DELETE photos/geo: the places of my uploads go (marked none); a purged photo takes its place along', async () => {
  await withHost({}, async (host, c) => {
    const t = await setup(c);
    const { a } = t;
    // Marc's photo in the family area keeps its place
    const fam = await c.area(MARC, 'family');
    const mp = (await c.put(MARC, fam.rootId, 'm.jpg', 'm', { mime: 'image/jpeg', geo: KOELN_DOM })).json.node;
    let r = await a('DELETE', 'photos/geo');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.deleted, 7);
    r = await a('GET', 'photos', null, { area: t.mine.id });
    assert.ok(r.json.items.every((x) => x.geo === null && x.located === (x.id !== t.none.id)));
    assert.deepEqual((await a('GET', 'photos', null, { unlocated: '1' })).json.items.map((x) => x.id), [t.none.id], 'only the one that never had a place');
    assert.equal((await c.as(MARC)('GET', `nodes/${mp.id}`)).json.node.geo.place.name, 'Köln');
    assert.deepEqual((await a('GET', 'photos/places')).json.places.map((p) => p.name), ['Köln']);
    // Marc's photo for good: its place goes with it
    await c.as(MARC)('DELETE', `nodes/${mp.id}`);
    assert.equal((await c.as(MARC)('DELETE', `trash/${mp.id}`)).status, 200);
    assert.deepEqual((await c.as(MARC)('GET', 'photos/places')).json.places, []);
  });
});
