'use strict';

// People in the photos (1.16.0, feature photoPeople — server/faces.js): PUT nodes/<id>/faces with synthetic SFace vectors
// (128 values), grouping into people (≥ same to a person, unsure between maybe and same, three faces make a person),
// GET people / people/<id>, naming (the same name merges), merge, similar, uncertain + confirm, faces/<id>/move,
// person= / with=people / q= on names, unfaced=1, the children's folders, people: false, a purged photo — and a few
// thousand faces at once.

const test = require('node:test');
const { performance } = require('node:perf_hooks');
const assert = require('node:assert/strict');
const faces = require('../server/faces');
const { withHost, ANNA, MARC, LENA } = require('./helpers');

const DIM = 128;
const MODEL = 'sface-2021dec';

/** A seeded random source (mulberry32) with normal values. */
function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () => Math.sqrt(-2 * Math.log(next() + 1e-12)) * Math.cos(2 * Math.PI * next());
  return { next, normal };
}
const unit = (v) => { const n = Math.hypot(...v); return v.map((x) => x / n); };
const randomUnit = (r) => unit(Array.from({ length: DIM }, () => r.normal()));
/** A face of identity `base`: cosine ≈ c to it. */
function faceOf(r, base, c) {
  const noise = randomUnit(r);
  const d = noise.reduce((s, x, i) => s + x * base[i], 0);
  const orth = unit(noise.map((x, i) => x - d * base[i]));
  return unit(base.map((x, i) => c * x + Math.sqrt(1 - c * c) * orth[i]));
}
const b64 = (v) => Buffer.from(new Float32Array(v).buffer).toString('base64');
const face = (v, box = [0.3, 0.2, 0.2, 0.25]) => ({ box, landmarks: [[0.35, 0.3], [0.45, 0.3], [0.4, 0.35], [0.36, 0.4], [0.44, 0.4]], score: 0.93, embedding: b64(v) });

async function photo(c, user, parentId, name, o = {}) {
  const r = await c.put(user, parentId, name, name, { mime: 'image/jpeg', ...o });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.node;
}

test('PUT faces: off by default (403 feature_off), checked bodies; three similar faces make a person; unfaced=1 and progress', async () => {
  await withHost({}, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const r = rng(1);
    const lea = randomUnit(r);
    const p1 = await photo(c, ANNA, mine.rootId, 'p1.jpg');
    let x = await a('PUT', `nodes/${p1.id}/faces`, { model: MODEL, faces: [face(faceOf(r, lea, 0.8))] });
    assert.deepEqual([x.status, x.json.code], [403, 'feature_off']);
    x = await a('GET', 'photos/settings');
    assert.deepEqual([x.json.people, x.json.peopleKids, x.json.keepGeo], [false, false, true]);
    x = await a('PUT', 'photos/settings', { people: true });
    assert.equal(x.json.people, true);
    // the bodies
    const bad = async (body, field) => { const y = await a('PUT', `nodes/${p1.id}/faces`, body); assert.equal(y.status, 400, JSON.stringify(body).slice(0, 80)); assert.equal(y.json.field, field); };
    await bad({ model: 'other', faces: [] }, 'model');
    await bad({ faces: [] }, 'model');
    await bad({ model: MODEL, faces: [{ ...face(lea), box: [0.5, 0.5, 0.7, 0.2] }] }, 'faces');
    await bad({ model: MODEL, faces: [{ ...face(lea), embedding: b64(lea.slice(0, 64)) }] }, 'faces');
    await bad({ model: MODEL, faces: Array.from({ length: 51 }, () => face(lea)) }, 'faces');
    await bad({ model: MODEL, faces: 'none' }, 'faces');
    // unfaced: every picture (not a video, not a text)
    const p2 = await photo(c, ANNA, mine.rootId, 'p2.jpg');
    const p3 = await photo(c, ANNA, mine.rootId, 'p3.jpg');
    const p4 = await photo(c, ANNA, mine.rootId, 'p4.jpg');
    await photo(c, ANNA, mine.rootId, 'v.mp4', { mime: 'video/mp4' });
    x = await a('GET', 'photos', null, { unfaced: '1', model: MODEL });
    assert.deepEqual(x.json.items.map((i) => i.name).sort(), ['p1.jpg', 'p2.jpg', 'p3.jpg', 'p4.jpg']);
    assert.equal((await a('GET', 'photos', null, { unfaced: '1', model: 'x' })).json.field, 'model');
    // two faces: no person yet
    x = await a('PUT', `nodes/${p1.id}/faces`, { model: MODEL, faces: [face(faceOf(r, lea, 0.8))] });
    assert.equal(x.status, 200, JSON.stringify(x.json));
    assert.deepEqual(x.json.faces.map((f) => f.person), [null]);
    await a('PUT', `nodes/${p2.id}/faces`, { model: MODEL, faces: [face(faceOf(r, lea, 0.8))] });
    assert.deepEqual((await a('GET', 'people')).json.people, []);
    // the third: a person without a name
    x = await a('PUT', `nodes/${p3.id}/faces`, { model: MODEL, faces: [face(faceOf(r, lea, 0.8))] });
    const pid = x.json.faces[0].person;
    assert.ok(pid);
    x = await a('GET', 'people');
    assert.equal(x.json.people.length, 1);
    const p = x.json.people[0];
    assert.deepEqual([p.id, p.name, p.count, p.hidden, p.contact], [pid, null, 3, false, null]);
    assert.ok(p.cover.faceId && p.cover.item && p.cover.box.length === 4);
    assert.deepEqual(x.json.progress, { done: 3, total: 4 });
    // looked at, nothing found
    x = await a('PUT', `nodes/${p4.id}/faces`, { model: MODEL, faces: [] });
    assert.deepEqual(x.json.faces, []);
    assert.equal((await a('GET', 'photos', null, { unfaced: '1', model: MODEL })).json.items.length, 0);
    assert.deepEqual((await a('GET', 'people')).json.progress, { done: 4, total: 4 });
    // the next face joins the person at once
    const p5 = await photo(c, ANNA, mine.rootId, 'p5.jpg');
    x = await a('PUT', `nodes/${p5.id}/faces`, { model: MODEL, faces: [face(faceOf(r, lea, 0.8))] });
    assert.equal(x.json.faces[0].person, pid);
    // a stranger: no person
    x = await a('PUT', `nodes/${p5.id}/faces`, { model: MODEL, faces: [face(faceOf(r, lea, 0.8)), face(randomUnit(r), [0.6, 0.1, 0.1, 0.1])] });
    assert.deepEqual(x.json.faces.map((f) => f.person), [pid, null]);
    // only mine: Marc sees no people and cannot put faces without his switch
    assert.deepEqual((await c.as(MARC)('GET', 'people')).json.people, []);
    assert.equal((await c.as(MARC)('GET', `people/${pid}`)).status, 404);
  });
});

/** Anna with people on and photos of three identities: Lea (5 alone, 3 with Papa), Papa (4 alone), Tim (3). */
async function family(c, seed = 7) {
  const a = c.as(ANNA);
  const mine = await c.area(ANNA, 'mine');
  await a('PUT', 'photos/settings', { people: true });
  const r = rng(seed);
  const ids = { lea: randomUnit(r), papa: randomUnit(r), tim: randomUnit(r) };
  const base = Date.UTC(2020, 5, 1, 12);
  let k = 0;
  const shot = async (who, o = {}) => {
    k++;
    const n = await photo(c, ANNA, mine.rootId, `f${k}.jpg`, { takenAt: base + k * 86400000 * 30, ...o });
    const list = who.map((w, i) => face(faceOf(r, ids[w], 0.8), [0.1 + i * 0.3, 0.2, 0.2, 0.25]));
    const x = await a('PUT', `nodes/${n.id}/faces`, { model: MODEL, faces: list });
    assert.equal(x.status, 200, JSON.stringify(x.json));
    return { node: n, faces: x.json.faces };
  };
  const shots = [];
  for (let i = 0; i < 5; i++) shots.push(await shot(['lea'], i === 0 ? { geo: { lat: 50.9413, lon: 6.9583 } } : {}));
  for (let i = 0; i < 4; i++) shots.push(await shot(['papa']));
  for (let i = 0; i < 3; i++) shots.push(await shot(['lea', 'papa'], i === 0 ? { geo: { lat: 53.5452, lon: 9.9667 } } : {}));
  for (let i = 0; i < 3; i++) shots.push(await shot(['tim']));
  const people = (await a('GET', 'people')).json.people;
  const byCount = (n) => people.find((p) => p.count === n);
  return { a, mine, r, ids, shot, shots, lea: byCount(8), papa: byCount(7), tim: byCount(3), people };
}

test('people: names (the same name merges), hidden, contact, together, places, years; person= / with=people / q= on names; suggest', async () => {
  await withHost({}, async (host, c) => {
    const t = await family(c);
    const { a } = t;
    assert.equal(t.people.length, 3);
    assert.ok(t.lea && t.papa && t.tim);
    let x = await a('PATCH', `people/${t.lea.id}`, { name: 'Lea', contact: { kind: 'family', id: 4, name: 'Lena' } });
    assert.equal(x.status, 200, JSON.stringify(x.json));
    assert.deepEqual([x.json.person.name, x.json.person.contact, x.json.mergedInto], ['Lea', { kind: 'family', id: '4', name: 'Lena' }, null]);
    await a('PATCH', `people/${t.papa.id}`, { name: 'Papa' });
    x = await a('GET', `people/${t.lea.id}`);
    const p = x.json.person;
    assert.deepEqual([p.count, p.uncertain], [8, 0]);
    assert.deepEqual(p.together, [{ id: t.papa.id, name: 'Papa', count: 3 }]);
    assert.deepEqual(p.places.map((g) => [g.name, g.count]).sort(), [['Hamburg', 1], ['Köln', 1]]);
    assert.deepEqual(p.years, { from: 2020, to: 2021 });
    // person= (every one of them), with=people
    x = await a('GET', 'photos', null, { person: `${t.lea.id},${t.papa.id}`, with: 'people' });
    assert.equal(x.json.items.length, 3);
    assert.ok(x.json.items.every((i) => i.people.includes(t.lea.id) && i.people.includes(t.papa.id)));
    assert.equal((await a('GET', 'photos', null, { person: '99999' })).status, 404);
    assert.equal((await a('GET', 'photos', null, { person: 'x' })).json.field, 'person');
    // Tim has no name: not in `people` of the items
    x = await a('GET', 'photos', null, { person: String(t.tim.id), with: 'people' });
    assert.ok(x.json.items.every((i) => i.people.length === 0));
    // q= on names, with a place, with a label
    const count = async (q) => (await a('GET', 'photos', null, { q })).json.items.length;
    assert.equal(await count('lea'), 8);
    assert.equal(await count('lea papa'), 3);
    assert.equal(await count('lea hamburg'), 1);
    assert.equal(await count('papa köln'), 0);
    x = await a('GET', 'photos', null, { q: 'lea hamburg' });
    assert.deepEqual(x.json.search.people, [{ id: t.lea.id, name: 'Lea' }]);
    assert.deepEqual(x.json.search.places.map((g) => g.name), ['Hamburg']);
    x = await a('GET', 'photos/suggest', null, { q: 'pa' });
    assert.deepEqual(x.json.people, [{ id: t.papa.id, name: 'Papa', count: 7 }]);
    // hidden: out of the search and the suggestions
    await a('PATCH', `people/${t.papa.id}`, { hidden: true });
    assert.equal(await count('papa'), 0);
    assert.deepEqual((await a('GET', 'photos/suggest', null, { q: 'pa' })).json.people, []);
    x = await a('GET', 'people');
    assert.equal(x.json.people.find((q) => q.id === t.papa.id).hidden, true);
    assert.deepEqual((await a('GET', `people/${t.lea.id}`)).json.person.together, []);
    await a('PATCH', `people/${t.papa.id}`, { hidden: false });
    // the same name merges (case and accents aside)
    x = await a('PATCH', `people/${t.tim.id}`, { name: ' lÉa ' });
    assert.equal(x.status, 200, JSON.stringify(x.json));
    assert.deepEqual([x.json.mergedInto, x.json.person.id, x.json.person.name, x.json.person.count], [t.lea.id, t.lea.id, 'Lea', 11]);
    assert.equal((await a('GET', `people/${t.tim.id}`)).status, 404);
    // an empty name removes it; bad bodies
    x = await a('PATCH', `people/${t.papa.id}`, { name: '' });
    assert.equal(x.json.person.name, null);
    assert.equal((await a('PATCH', `people/${t.papa.id}`, { hidden: 'yes' })).json.field, 'hidden');
    assert.equal((await a('PATCH', `people/${t.papa.id}`, { contact: { kind: 'x', id: 1, name: 'a' } })).json.field, 'contact');
    // the op 'people' in the change log
    const ch = (await a('GET', 'changes', null, { since: '0', limit: '1000' })).json.changes;
    assert.ok(ch.some((e) => e.op === 'people'));
  });
});

test('merge, similar, uncertain + confirm, faces/<id>/move (never suggested again), a second PUT keeps what was confirmed', async () => {
  await withHost({}, async (host, c) => {
    const t = await family(c, 11);
    const { a, r, ids, mine } = t;
    // unsure faces of Lea: cosine ≈ 0.36 to her centre
    const unsure = [];
    for (let i = 0; i < 3; i++) {
      const n = await photo(c, ANNA, mine.rootId, `u${i}.jpg`);
      const x = await a('PUT', `nodes/${n.id}/faces`, { model: MODEL, faces: [face(faceOf(r, ids.lea, 0.37), [0.2, 0.2, 0.3, 0.3])] });
      assert.equal(x.json.faces[0].person, null);
      unsure.push({ node: n, face: x.json.faces[0].id });
    }
    let x = await a('GET', `people/${t.lea.id}`);
    assert.equal(x.json.person.uncertain, 3);
    x = await a('GET', `people/${t.lea.id}/uncertain`, null, { limit: '10' });
    assert.equal(x.json.faces.length, 3);
    assert.ok(x.json.faces.every((f) => f.item && f.box && f.score >= 0.3 && f.score < 0.42));
    // one yes, one no
    x = await a('POST', `people/${t.lea.id}/confirm`, { faceIds: [unsure[0].face], yes: true });
    assert.equal(x.status, 200, JSON.stringify(x.json));
    assert.deepEqual([x.json.changed, x.json.person.count, x.json.person.uncertain], [1, 9, 2]);
    x = await a('POST', `people/${t.lea.id}/confirm`, { faceIds: [unsure[1].face], yes: false });
    assert.equal(x.json.person.uncertain, 1);
    assert.equal((await a('POST', `people/${t.lea.id}/confirm`, { faceIds: [], yes: true })).json.field, 'faceIds');
    // a second PUT of those photos: the confirmed face keeps Lea, the rejected one is not unsure about her again
    x = await a('PUT', `nodes/${unsure[0].node.id}/faces`, { model: MODEL, faces: [face(faceOf(r, ids.lea, 0.37), [0.21, 0.2, 0.3, 0.3])] });
    assert.equal(x.json.faces[0].person, t.lea.id);
    await a('PUT', `nodes/${unsure[1].node.id}/faces`, { model: MODEL, faces: [face(faceOf(r, ids.lea, 0.37), [0.21, 0.2, 0.3, 0.3])] });
    x = await a('GET', `people/${t.lea.id}/uncertain`);
    assert.deepEqual(x.json.faces.map((f) => f.item.id), [unsure[2].node.id]);
    // "Nicht diese Person": a face of Lea out — and never back in her suggestions
    const leaFace = t.shots[1].faces[0].id;
    x = await a('POST', `faces/${leaFace}/move`, { person: null });
    assert.deepEqual(x.json.face, { id: leaFace, person: null });
    assert.equal((await a('GET', `people/${t.lea.id}`)).json.person.count, 8);
    // "Zu … verschieben": to Papa
    x = await a('POST', `faces/${leaFace}/move`, { person: t.papa.id });
    assert.equal(x.json.face.person, t.papa.id);
    assert.equal((await a('GET', `people/${t.papa.id}`)).json.person.count, 8);
    assert.equal((await a('POST', `faces/${leaFace}/move`, {})).json.field, 'person');
    assert.equal((await c.as(MARC)('POST', `faces/${leaFace}/move`, { person: null })).status, 404);
    // merge: Tim into Papa
    x = await a('POST', `people/${t.tim.id}/merge`, { into: t.papa.id });
    assert.equal(x.status, 200, JSON.stringify(x.json));
    assert.equal(x.json.person.count, 11);
    assert.equal((await a('POST', `people/${t.papa.id}/merge`, { into: t.papa.id })).json.field, 'into');
    assert.equal((await a('GET', 'people')).json.people.length, 2);
  });
});

test('similar: two people whose centres are close (≥ merge) — "Sieht aus wie …"', async () => {
  await withHost({}, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    await a('PUT', 'photos/settings', { people: true });
    // exact vectors: identities X and Y with cosine 0.52; each face 0.8 to its identity along its own direction —
    // a face of Y is ≈ 0.41 to the centre of X (stays apart, < same), the centres are ≈ 0.50 (≥ merge)
    const e = (i) => Array.from({ length: DIM }, (_, k) => (k === i ? 1 : 0));
    const x0 = e(0);
    const y0 = e(0).map((v, k) => 0.52 * v + Math.sqrt(1 - 0.52 * 0.52) * e(1)[k]);
    let dir = 2;
    for (const who of [x0, y0]) {
      for (let i = 0; i < 12; i++) {
        const d = e(dir++);
        const node = await photo(c, ANNA, mine.rootId, `s${dir}.jpg`);
        const v = unit(who.map((w, k) => 0.8 * w + 0.6 * d[k]));
        assert.equal((await a('PUT', `nodes/${node.id}/faces`, { model: MODEL, faces: [face(v)] })).status, 200);
      }
    }
    const people = (await a('GET', 'people')).json.people;
    assert.equal(people.length, 2, JSON.stringify(people.map((p) => p.count)));
    const [p, q] = people;
    let x = await a('GET', `people/${p.id}/similar`);
    assert.equal(x.status, 200, JSON.stringify(x.json));
    assert.deepEqual(x.json.people.map((s) => s.id), [q.id]);
    assert.ok(x.json.people[0].score >= 0.45);
    // hidden people are not suggested
    await a('PATCH', `people/${q.id}`, { hidden: true });
    x = await a('GET', `people/${p.id}/similar`);
    assert.deepEqual(x.json.people, []);
  });
});

test('the children\'s folders only with peopleKids; people: false deletes everything; a purged photo takes its faces along', async () => {
  await withHost({}, async (host, c) => {
    const t = await family(c, 3);
    const { a, r, ids } = t;
    const child = await c.area(LENA, 'child');
    const lp = await photo(c, LENA, child.rootId, 'lena.jpg');
    // Anna reads Lena's folder (a parent): not without peopleKids
    let x = await a('GET', 'photos', null, { unfaced: '1', model: MODEL });
    assert.ok(!x.json.items.some((i) => i.id === lp.id));
    x = await a('PUT', `nodes/${lp.id}/faces`, { model: MODEL, faces: [face(faceOf(r, ids.lea, 0.8))] });
    assert.deepEqual([x.status, x.json.code, x.json.reason], [403, 'feature_off', 'kids']);
    await a('PUT', 'photos/settings', { peopleKids: true });
    assert.ok((await a('GET', 'photos', null, { unfaced: '1', model: MODEL })).json.items.some((i) => i.id === lp.id));
    x = await a('PUT', `nodes/${lp.id}/faces`, { model: MODEL, faces: [face(faceOf(r, ids.lea, 0.8))] });
    assert.equal(x.json.faces[0].person, t.lea.id);
    assert.equal((await a('GET', `people/${t.lea.id}`)).json.person.count, 9);
    // off again: those faces go
    await a('PUT', 'photos/settings', { peopleKids: false });
    assert.equal((await a('GET', `people/${t.lea.id}`)).json.person.count, 8);
    // a purged photo: its faces go, the person's count follows
    const one = t.shots[0].node;
    await a('DELETE', `nodes/${one.id}`);
    assert.equal((await a('GET', `people/${t.lea.id}`)).json.person.count, 7, 'in the trash: not counted');
    await a('DELETE', `trash/${one.id}`);
    assert.equal((await a('GET', `people/${t.lea.id}`)).json.person.count, 7);
    // people off: every face, person and name
    x = await a('PUT', 'photos/settings', { people: false });
    assert.equal(x.status, 200, JSON.stringify(x.json));
    assert.equal(x.json.people, false);
    assert.equal(x.json.deleted, 17, 'the faces of the 17 photos left');
    assert.deepEqual((await a('GET', 'people')).json, { ok: true, people: [], progress: { done: 0, total: 0 } });
    assert.equal((await a('GET', 'photos', null, { unfaced: '1', model: MODEL })).json.code, 'feature_off');
    assert.equal((await a('GET', 'photos', null, { q: 'lea' })).json.items.length, 0);
  });
});

test('a few thousand faces: groups stay right and each PUT stays quick (centres in memory, not every face)', async (tc) => {
  await withHost({}, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    await a('PUT', 'photos/settings', { people: true });
    const r = rng(42);
    const IDS = 40;
    const bases = Array.from({ length: IDS }, () => randomUnit(r));
    const truth = new Map();
    const PHOTOS = 1500;
    let faceCount = 0;
    let slowest = 0;
    const started = performance.now();
    for (let i = 0; i < PHOTOS; i++) {
      const n = await photo(c, ANNA, mine.rootId, `b${i}.jpg`);
      // two known people a photo, every third photo a stranger too
      const who = [Math.floor(r.next() * IDS), Math.floor(r.next() * IDS)];
      const list = who.map((w, k) => face(faceOf(r, bases[w], 0.72), [0.05 + k * 0.4, 0.2, 0.2, 0.25]));
      if (i % 3 === 0) list.push(face(randomUnit(r), [0.8, 0.7, 0.1, 0.1]));
      const t0 = performance.now();
      const x = await a('PUT', `nodes/${n.id}/faces`, { model: MODEL, faces: list });
      slowest = Math.max(slowest, i > PHOTOS - 100 ? performance.now() - t0 : 0);
      assert.equal(x.status, 200, JSON.stringify(x.json));
      x.json.faces.forEach((f, k) => { if (k < 2) truth.set(f.id, who[k]); });
      faceCount += list.length;
    }
    assert.ok(faceCount >= 3400, String(faceCount));
    // every person is one identity; nearly every face of an identity is in its person
    const people = (await a('GET', 'people')).json.people;
    const rows = await host.gc.db.query('SELECT id, person_id FROM faces');
    const persons = new Map();
    for (const row of (rows.rows || rows)) {
      if (!truth.has(row.id)) continue;
      if (!persons.has(row.person_id)) persons.set(row.person_id, []);
      persons.get(row.person_id).push(truth.get(row.id));
    }
    const real = new Set(people.map((p) => p.id));
    let placed = 0;
    for (const [pid, list] of persons) {
      if (!real.has(pid)) continue;
      const top = Math.max(...[...new Set(list)].map((w) => list.filter((x) => x === w).length));
      assert.ok(top / list.length > 0.98, `person ${pid}: ${top}/${list.length}`);
      placed += list.length;
    }
    assert.ok(placed / truth.size > 0.95, `${placed}/${truth.size} faces in their person`);
    assert.ok(people.length >= IDS && people.length <= IDS + 5, String(people.length));
    assert.ok(slowest < 250, `slowest PUT ${slowest} ms`);
    // the centres in memory are the database's
    faces.forgetCentres();
    const n = await photo(c, ANNA, mine.rootId, 'last.jpg');
    const x = await a('PUT', `nodes/${n.id}/faces`, { model: MODEL, faces: [face(faceOf(r, bases[0], 0.72))] });
    assert.ok(real.has(x.json.faces[0].person));
    tc.diagnostic(`${faceCount} faces on ${PHOTOS} photos, ${people.length} people, ${Math.round(performance.now() - started)} ms, slowest of the last 100 PUTs ${Math.round(slowest)} ms`);
  });
});
