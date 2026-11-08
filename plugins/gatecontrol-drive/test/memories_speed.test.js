'use strict';

// The page „Erinnerungen“ (1.26.0) with 50 000 photos: every statement of GET memories, GET memories/photos of each
// kind, GET photos/memories and GET overview < 200 ms (as Mail's test/speed.test.js — the host warns of slow statements);
// the photos of a collection on their indexes (time taken, place, a person's faces), never every photo.

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite = require('node:sqlite');
const { performance } = require('node:perf_hooks');
const { withHost, ANNA, MARC, T0, DAY } = require('./helpers');

const LIMIT_MS = 200;
const N = 50000;
const PLACES = 120;
const PEOPLE = 30;

/** Every statement's longest time while `fn` runs → Map sql → ms. */
async function timed(fn) {
  const SP = sqlite.StatementSync.prototype;
  const orig = { all: SP.all, get: SP.get, run: SP.run };
  const worst = new Map();
  for (const name of Object.keys(orig)) {
    SP[name] = function measured(...a) {
      const t = performance.now();
      try { return orig[name].apply(this, a); } finally {
        const ms = performance.now() - t;
        const k = String(this.sourceSQL).replace(/\s+/g, ' ').slice(0, 240);
        worst.set(k, Math.max(worst.get(k) || 0, ms));
      }
    };
  }
  try { await fn(); } finally { Object.assign(SP, orig); }
  return worst;
}

const plan = async (db, sql, params) => (await db.query(`EXPLAIN QUERY PLAN ${sql}`, params || [])).rows.map((r) => r.detail).join(' / ');

/** N photos in my files and the family's over twelve years, 80 % with a place (home most), faces of PEOPLE people. */
async function manyPhotos(host, c) {
  const a = c.as(ANNA);
  const mine = await c.area(ANNA, 'mine');
  const fam = await c.area(ANNA, 'family');
  const db = host.gc.db;
  const now = T0;
  await db.exec('BEGIN');
  // the cities: home (0) and others spread over Europe
  for (let p = 0; p < PLACES; p++) {
    const lat = p === 0 ? 49.9 : 40 + (p % 15);
    const lon = p === 0 ? 7.9 : -5 + (p % 25);
    await db.run('INSERT INTO geo_places (id, kind, parent, name, region, country, lat, lon, search) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)',
      [1000 + p, 'city', `Ort ${p}`, 'Region', 'DE', lat, lon, ` ort ${p} `]);
  }
  const folders = [];
  for (let f = 0; f < 40; f++) {
    const area = f % 3 ? mine : fam;
    const r = await db.run('INSERT INTO nodes (area_id, parent_id, name, is_dir, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, 1, ?, ?, ?, ?)',
      [area.id, area.rootId, `Ordner ${f}`, now, ANNA.id, now, ANNA.id]);
    folders.push({ id: Number(r.lastInsertRowid), area: area.id });
  }
  const persons = [];
  for (let p = 0; p < PEOPLE; p++) {
    const r = await db.run(`INSERT INTO persons (user_id, model, pending, name, name_fold, hidden, faces, sum, created_at, updated_at) VALUES (?, 'sface-2021dec', 0, ?, ?, 0, 0, ?, ?, ?)`,
      [ANNA.id, `Person ${p}`, `person ${p}`, { b64: Buffer.alloc(512).toString('base64') }, now, now]);
    persons.push(Number(r.lastInsertRowid));
  }
  const vec = { b64: Buffer.alloc(512).toString('base64') };
  for (let i = 0; i < N; i++) {
    const f = folders[i % folders.length];
    // bursts: about 12 a day on a third of the days of twelve years, trips (cities 1 …) every few weeks for 3 days
    const dayNo = Math.floor(i / 12) * 3 % 4380;
    const t = now - (dayNo + 1) * DAY + (i % 12) * 600000;
    const week = Math.floor(dayNo / 7);
    const away = week % 6 === 0;
    const place = i % 5 === 0 ? null : away ? 1000 + 1 + (week % (PLACES - 1)) : 1000;
    const r = await db.run(`INSERT INTO nodes (area_id, parent_id, name, is_dir, media_id, size, mime, rev, created_at, created_by, updated_at, updated_by, taken_at, geo_lat, geo_lon, geo_place)
      VALUES (?, ?, ?, 0, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`, [f.area, f.id, `Bild ${i}.jpg`, `m${String(i + 1).padStart(31, '0')}`, 2000 + i, i % 40 ? 'image/jpeg' : 'video/mp4',
      t, ANNA.id, t, ANNA.id, t, place ? 50 : null, place ? 7 : null, place]);
    const id = Number(r.lastInsertRowid);
    // faces: a third of the photos, one or two people
    if (i % 3 === 0) {
      for (const p of [persons[i % PEOPLE], ...(i % 2 ? [persons[(i + 7) % PEOPLE]] : [])]) {
        await db.run(`INSERT INTO faces (user_id, node_id, model, bx, by, bw, bh, score, vec, person_id, at) VALUES (?, ?, 'sface-2021dec', 0.1, 0.1, 0.2, 0.2, 0.9, ?, ?, ?)`,
          [ANNA.id, id, vec, p, now]);
      }
    }
    // to check: every 50th
    if (i % 50 === 0) await db.run('UPDATE nodes SET review_at = ?, review_by = ? WHERE id = ?', [now, ANNA.id, id]);
  }
  await db.exec('COMMIT');
  // the work folder: one of the folders
  assert.equal((await a('PUT', 'photos/settings', { workFolder: folders[5].id, people: true })).status, 200);
  return { a, persons, folders };
}

test(`Erinnerungen with ${N} photos: every statement < ${LIMIT_MS} ms, the photos of a collection on their indexes`, { timeout: 240000 }, async (t) => {
  await withHost({}, async (host, c) => {
    const { a, persons } = await manyPhotos(host, c);
    let list = null;
    const total = [];
    const worst = await timed(async () => {
      const t0 = performance.now();
      const r = await a('GET', 'memories');
      total.push(performance.now() - t0);
      assert.equal(r.status, 200, JSON.stringify(r.json));
      list = r.json;
      const kinds = new Set(list.collections.map((x) => x.kind));
      for (const k of ['day', 'trip', 'person', 'month', 'year', 'place']) assert.ok(kinds.has(k), `a collection of kind ${k}`);
      // the first and a second page of one collection of each kind
      for (const k of kinds) {
        const x = list.collections.find((y) => y.kind === k);
        const p = await a('GET', 'memories/photos', null, { id: x.id, limit: 60 });
        assert.equal(p.status, 200, JSON.stringify(p.json));
        assert.ok(p.json.items.length > 0, x.id);
        if (p.json.next) assert.equal((await a('GET', 'memories/photos', null, { id: x.id, limit: 60, before: p.json.next })).status, 200);
      }
      assert.equal((await a('GET', 'photos/memories')).status, 200);
      // the other photo pages with the new index (migrations/021_memories.sql)
      assert.equal((await a('GET', 'photos')).status, 200);
      assert.equal((await a('GET', 'photos/months')).status, 200);
      assert.equal((await a('GET', 'overview')).status, 200);
    });
    const slow = [...worst].filter(([, ms]) => ms >= LIMIT_MS).map(([sql, ms]) => `${Math.round(ms)} ms ${sql}`);
    assert.deepEqual(slow, [], 'statements of 200 ms or more');
    const top = [...worst].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([sql, ms]) => `${ms.toFixed(1)} ms ${sql.slice(0, 90)}`);
    t.diagnostic(`GET memories ${total[0].toFixed(0)} ms, ${list.collections.length} collections; slowest: ${top.join(' | ')}`);
    // limits: at most 30 trips, 20 people, 20 places
    assert.ok(list.collections.filter((x) => x.kind === 'trip').length <= 30);
    assert.ok(list.collections.filter((x) => x.kind === 'person').length <= 20);
    assert.ok(list.collections.filter((x) => x.kind === 'place').length <= 20);
    assert.equal(list.home.name, 'Ort 0');

    // the plans: a page of a collection on its index, never a scan of every node
    const db = host.gc.db;
    const ids = (await c.area(ANNA, 'mine')).id;
    const W = "area_id IN (?) AND is_dir = 0 AND deleted_at IS NULL AND vault_id IS NULL AND (mime LIKE 'image/%' OR mime LIKE 'video/%') AND review_at IS NULL";
    const T = 'COALESCE(taken_at, mtime, created_at)';
    const grouped = await plan(db, `SELECT (${T} + ?) / 3600000 AS h, geo_place AS p, COUNT(*) AS n, MIN(${T}) AS t, id FROM nodes INDEXED BY nodes_memories WHERE ${W} GROUP BY h, p`, [0, ids]);
    assert.match(grouped, /COVERING INDEX nodes_memories/);
    const day = await plan(db, `SELECT * FROM nodes INDEXED BY nodes_taken WHERE ${W} AND ${T} >= ? AND ${T} < ? ORDER BY ${T} DESC, id DESC LIMIT 61`, [ids, 0, 1]);
    assert.match(day, /nodes_taken/);
    assert.doesNotMatch(day, /TEMP B-TREE/);
    const place = await plan(db, `SELECT * FROM nodes WHERE ${W} AND geo_place = ? ORDER BY ${T} DESC, id DESC LIMIT 61`, [ids, 1001]);
    assert.match(place, /nodes_geo_place/);
    const person = await plan(db, `SELECT * FROM nodes WHERE ${W} AND id IN (SELECT node_id FROM faces WHERE person_id = ? AND user_id = ?) ORDER BY ${T} DESC, id DESC LIMIT 61`, [ids, persons[0], ANNA.id]);
    assert.match(person, /faces_person/);
    assert.doesNotMatch(`${day} / ${place} / ${person}`, /SCAN nodes(?! USING)/);
    // Marc sees the family's photos only: his own collections, quickly
    assert.equal((await c.as(MARC)('GET', 'memories')).status, 200);
  });
});
