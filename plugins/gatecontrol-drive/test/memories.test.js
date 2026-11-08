'use strict';

// The page „Erinnerungen“ (1.26.0, feature `memoryCollections` — server/memories.js): GET memories with its collections
// (Heute vor X Jahren with more than 10 photos, Ausflüge und Reisen far from home, Mit <Person>, Diesen Monat vor X
// Jahren, Jahresrückblick, Orte) and GET memories/photos?id= page by page — only private photos: nothing below the work
// folder (whatever workInMemories says), nothing marked „Prüfen“, nothing of a team folder; the overview's cards the same.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, BOB, T0 } = require('./helpers');
const memories = require('../server/memories');

const KOELN = { lat: 50.9413, lon: 6.9583 };
const BONN = { lat: 50.7374, lon: 7.0982 };
const HH = { lat: 53.5452, lon: 9.9667 };
const JPEG = 'image/jpeg';

// exact face vectors: identity i is the unit vector e_i, each face 0.8 to it along its own direction
const DIM = 128;
let dir = 20;
function faceVec(i) {
  const v = new Float32Array(DIM);
  v[i] = 0.8;
  v[dir++] = 0.6;
  return Buffer.from(v.buffer).toString('base64');
}

const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
/** Local noon of y-m-d (+ minutes). */
const at = (y, m, d, min = 0) => new Date(y, m - 1, d, 12, min).getTime();
const now = new Date(T0);
const Y = now.getFullYear();
const [M, D] = [now.getMonth() + 1, now.getDate()];
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

/** Anna's photos: home Köln on many days, a trip to Hamburg, a day in Bonn (near home), this day in earlier years. */
async function annasPhotos(c) {
  const a = c.as(ANNA);
  const mine = await c.area(ANNA, 'mine');
  const put = async (name, takenAt, geo, parentId = mine.rootId) => ok(await c.put(ANNA, parentId, name, name, { mime: JPEG, takenAt, ...(geo ? { geo } : {}) })).node;
  const out = { mine, koeln: [], put };
  // home: 2 a day on 25 days of a March (Y-2)
  for (let i = 0; i < 50; i++) out.koeln.push(await put(`k${i}.jpg`, at(Y - 2, 3, 1 + (i % 25), i), KOELN));
  // this day 1 year ago: 12 (a memory), 2 years ago: exactly 10 (none), 3 years ago: 13 of which one in the work folder
  // and one to check (11 private)
  for (let i = 0; i < 12; i++) await put(`y1-${i}.jpg`, at(Y - 1, M, D, i), KOELN);
  for (let i = 0; i < 10; i++) await put(`y2-${i}.jpg`, at(Y - 2, M, D, i), KOELN);
  const arbeit = ok(await a('POST', 'nodes', { parentId: mine.rootId, name: 'Arbeit' })).node;
  for (let i = 0; i < 11; i++) await put(`y3-${i}.jpg`, at(Y - 3, M, D, i), KOELN);
  out.job = await put('y3-baustelle.jpg', at(Y - 3, M, D, 30), KOELN, arbeit.id);
  out.check = await put('y3-pruefen.jpg', at(Y - 3, M, D, 31), KOELN);
  ok(await a('PUT', 'photos/settings', { workFolder: arbeit.id }));
  ok(await a('POST', 'photos/review', { ids: [out.check.id], review: true, hint: 60 }));
  // this month a year ago: 8 more (20 with the 12 of this day)
  for (let i = 0; i < 8; i++) await put(`m1-${i}.jpg`, at(Y - 1, M, 1 + i), KOELN);
  // a trip to Hamburg (Y-1, July 10 – 14: 4 on the 10th, 11th, 12th and 14th — the 13th without photos)
  for (const d of [10, 11, 12, 14]) for (let i = 0; i < 4; i++) await put(`hh-${d}-${i}.jpg`, at(Y - 1, 7, d, i), HH);
  // Bonn (about 25 km from Köln): no trip, but a place
  for (let i = 0; i < 11; i++) await put(`bonn-${i}.jpg`, at(Y - 2, 5, 4, i), BONN);
  return out;
}

test('GET memories: the collections in their order with counts and covers — only private photos', async () => {
  await withHost({}, async (host, c) => {
    const a = c.as(ANNA);
    assert.ok(ok(await a('GET', 'me')).features.includes('memoryCollections'));
    const t = await annasPhotos(c);
    // people: Noah on 11 photos of home and on the work photo
    ok(await a('PUT', 'photos/settings', { people: true }));
    for (const n of [...t.koeln.slice(0, 11), t.job]) {
      ok(await a('PUT', `nodes/${n.id}/faces`, { model: 'sface-2021dec', faces: [{ box: [0.1, 0.1, 0.3, 0.3], score: 0.9, embedding: faceVec(0) }] }));
    }
    const noah = ok(await a('GET', 'people')).people[0];
    ok(await a('PATCH', `people/${noah.id}`, { name: 'Noah' }));

    const r = ok(await a('GET', 'memories'));
    assert.equal(r.date, dayKey(Y, M, D));
    assert.equal(r.home.name, 'Köln');
    const brief = r.collections.map((x) => [x.id, x.count]);
    assert.deepEqual(brief, [
      [`day:${dayKey(Y - 1, M, D)}`, 12],
      [`day:${dayKey(Y - 3, M, D)}`, 11],
      [`trip:${dayKey(Y - 1, 7, 10)}:${dayKey(Y - 1, 7, 14)}`, 16],
      [`person:${noah.id}`, 11],
      [`month:${Y - 1}-${pad(M)}`, 20],
      [`year:${Y - 2}`, 71],
      [`place:${r.home.key}`, 91],
      [r.collections[7].id, 16],
      [r.collections[8].id, 11],
    ]);
    const [d1, d3, trip, person, month, year, home, hh, bonn] = r.collections;
    assert.deepEqual([d1.kind, d1.yearsAgo, d1.date, d3.yearsAgo], ['day', 1, dayKey(Y - 1, M, D), 3]);
    assert.equal(d1.cover.name, 'y1-0.jpg');
    assert.ok(Object.prototype.hasOwnProperty.call(d1.cover, 'previewUrl'));
    assert.equal(d1.from, new Date(Y - 1, M - 1, D - 1).toISOString());
    assert.equal(d1.to, new Date(Y - 1, M - 1, D + 2).toISOString());
    assert.deepEqual([trip.kind, trip.place.name, trip.places, trip.days, trip.firstDay, trip.lastDay, trip.cover.name], ['trip', 'Hamburg', ['Hamburg'], 5, dayKey(Y - 1, 7, 10), dayKey(Y - 1, 7, 14), 'hh-10-0.jpg']);
    assert.match(trip.place.key, /^geonames:\d+$/);
    assert.deepEqual([person.kind, person.person], ['person', { id: noah.id, name: 'Noah' }]);
    assert.equal(person.cover.name, 'k10.jpg', 'the newest photo with Noah');
    assert.deepEqual([month.kind, month.yearsAgo, month.month], ['month', 1, `${Y - 1}-${pad(M)}`]);
    assert.deepEqual([year.kind, year.year], ['year', Y - 2]);
    assert.deepEqual([home.kind, home.place.name, hh.place.name, bonn.place.name], ['place', 'Köln', 'Hamburg', 'Bonn']);
    // never a work photo or one to check as a cover
    for (const x of r.collections) assert.ok(x.cover && x.cover.work === false && x.cover.review === null, x.id);

    // the photos of each collection: the same count, newest first, page by page
    const all = async (id) => {
      const got = [];
      let before = null;
      for (let i = 0; i < 20; i++) {
        const p = ok(await a('GET', 'memories/photos', null, { id, limit: 5, ...(before ? { before } : {}) }));
        assert.equal(p.id, id);
        got.push(...p.items);
        if (!p.next) break;
        before = p.next;
      }
      return got;
    };
    for (const x of r.collections) {
      const items = await all(x.id);
      assert.equal(items.length, x.count, x.id);
      assert.ok(items.every((it, i) => i === 0 || it.takenAt <= items[i - 1].takenAt), x.id);
      assert.ok(!items.some((it) => it.id === t.job.id || it.id === t.check.id), x.id);
    }
    assert.ok((await all(trip.id)).every((it) => it.name.startsWith('hh-')));

    // the work photo stays out even with workInMemories (only the photo frame's since 1.26.0)
    ok(await a('PUT', 'photos/settings', { workInMemories: true }));
    const again = ok(await a('GET', 'memories'));
    assert.equal(again.collections.find((x) => x.id === d3.id).count, 11);
    assert.equal(again.collections.find((x) => x.kind === 'person').count, 11);
    const old = ok(await a('GET', 'photos/memories')).groups.find((g) => g.yearsAgo === 3);
    assert.equal(old.items.length, 11, 'GET photos/memories only private photos too');

    // the overview: the days with more than 10 photos only, with the collection's id
    const ov = ok(await a('GET', 'overview'));
    assert.deepEqual(ov.memories.map((g) => [g.yearsAgo, g.count, g.id]), [[1, 12, d1.id], [3, 11, d3.id]]);

    // a photo checked (Privat): it counts again
    ok(await a('POST', 'photos/review', { ids: [t.check.id], review: false }));
    assert.equal(ok(await a('GET', 'memories')).collections.find((x) => x.id === d3.id).count, 12);

    // another date
    const other = ok(await a('GET', 'memories', null, { date: dayKey(Y, 7, 11) }));
    assert.equal(other.collections.filter((x) => x.kind === 'day').length, 1);
    assert.equal(other.collections.find((x) => x.kind === 'day').count, 12, 'the 10th – 12th of July: 12 in Hamburg');

    // wrong ids and dates
    for (const id of ['', 'x', 'day:2025-02-30', 'month:2025-13', 'year:25', `trip:${dayKey(Y - 1, 7, 14)}:${dayKey(Y - 1, 7, 10)}`, 'trip:2020-01-01:2020-06-01', 'place:hamburg']) {
      assert.equal((await a('GET', 'memories/photos', null, { id })).status, 400, id);
    }
    assert.equal((await a('GET', 'memories/photos', null, { id: 'person:999' })).status, 404);
    assert.equal((await a('GET', 'memories', null, { date: '2026-02-30' })).status, 400);
    assert.equal((await a('GET', 'memories/photos', null, { id: d1.id, limit: 0 })).status, 400);
  });
});

test('GET memories: nothing yet, a team folder never, people only while the switch is on', async () => {
  await withHost({}, async (host, c) => {
    const b = c.as(BOB);
    assert.deepEqual(ok(await b('GET', 'memories')).collections, []);
    const tm = ok(await c.admin('POST', 'admin/teams', { label: 'Baustelle', members: [{ principal: `u:${BOB.id}`, role: 'write' }] }));
    const team = (await c.area(BOB, 'team'));
    assert.ok(team, JSON.stringify(tm));
    const mine = await c.area(BOB, 'mine');
    for (let i = 0; i < 12; i++) ok(await c.put(BOB, team.rootId, `t${i}.jpg`, `t${i}`, { mime: JPEG, takenAt: at(Y - 1, M, D, i) }));
    assert.deepEqual(ok(await b('GET', 'memories')).collections, [], 'a team folder is work');
    assert.equal(ok(await b('GET', 'overview')).memories, undefined);
    for (let i = 0; i < 11; i++) ok(await c.put(BOB, mine.rootId, `p${i}.jpg`, `p${i}`, { mime: JPEG, takenAt: at(Y - 1, M, D, i) }));
    const r = ok(await b('GET', 'memories'));
    assert.deepEqual(r.collections.map((x) => [x.kind, x.count]), [['day', 11]]);
    assert.equal(r.home, null);
    const p = ok(await b('GET', 'memories/photos', null, { id: r.collections[0].id }));
    assert.equal(p.items.length, 11);
    assert.ok(p.items.every((x) => x.name.startsWith('p')));
  });
});

test('trips: days in a row far from home; a day at home in between ends one', () => {
  const named = new Map([[1, { id: 1, lat: 50.94, lon: 6.96 }], [2, { id: 2, lat: 53.55, lon: 9.97 }], [3, { id: 3, lat: 50.74, lon: 7.1 }]]);
  const row = (d, p, n, id) => ({ d, p, n, t: new Date(d).getTime(), id });
  const rows = [
    row('2025-01-01', 1, 5, 1), row('2025-01-02', 1, 5, 2), row('2025-01-03', 1, 5, 3), row('2025-01-04', 1, 1, 4), row('2025-01-05', 1, 1, 5),
    // 5 + 5 in Hamburg, then a day at home, then 12 more: two trips, the first too small
    row('2025-02-01', 2, 5, 10), row('2025-02-02', 2, 4, 11), row('2025-02-03', 1, 1, 12), row('2025-02-04', 2, 12, 13),
    // Bonn: too near
    row('2025-03-01', 3, 30, 20),
    // two days in Hamburg with a day without photos between: one trip
    row('2025-04-01', 2, 6, 30), row('2025-04-03', 2, 6, 31),
  ];
  assert.equal(memories.homeOf(rows), 1);
  const trips = memories.tripsOf(rows, named, 1);
  assert.deepEqual(trips.map((x) => [x.firstDay, x.lastDay, x.days, x.count, x.first.id]), [['2025-04-01', '2025-04-03', 3, 12, 30], ['2025-02-04', '2025-02-04', 1, 12, 13]]);
  assert.deepEqual(memories.tripsOf(rows, named, null), []);
});
