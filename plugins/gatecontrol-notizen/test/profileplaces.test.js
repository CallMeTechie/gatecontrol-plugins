'use strict';

// 1.8.0 — „Meine Orte“ move into the user profile (GateControl 1.298.0, gc.places; tools/testing/mock-places.js):
// the one-time move (importFor per person, sourceRef = the old id; idempotent; places of Familie stay a reference to
// Familie; what the profile refuses stays the tasks' place and is reported), the hook placesChanged (the copies follow,
// a deleted or no longer visible place leaves the tasks a copy) and „Genutzt von“ (reportUsage: open tasks per place).
// The old data is written as 1.7.0 left it, then the move runs as at the start of the plugin.

const test = require('node:test');
const assert = require('node:assert/strict');
const { ANNA, MARC, LENA, BOB, clock, T0 } = require('./helpers');
const { host } = require('./placefakes');
const search = require('../server/placesearch');
const pp = require('../server/profileplaces');
const plugin = require('../server/index');
const store = require('../server/store');

const done = async (h) => { search.state.pauseMs = search.PAUSE_MS; await h.close(); clock.set(T0); };
const task = async (h, user, id) => (await h.ok(user, 'GET', 'tasks/' + id)).task;
const json = async (h, id) => JSON.parse((await store.one(h.host.gc, 'SELECT place_json FROM tasks WHERE id = ?', [id])).place_json);

/** A place as 1.7.0 kept it (migrations/007) → its id. */
async function oldPlace(h, userId, f) {
  const r = await store.run(h.host.gc, 'INSERT INTO places (user_id, name, address, lat, lon, radius, named, ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [userId, f.name, f.address || '', f.lat, f.lon, f.radius || 150, f.named === false ? 0 : 1, f.ref || null, T0 - 86400000, T0 - 86400000]);
  return Number(r.lastInsertRowid);
}
/** A task at an old place, as 1.7.0 wrote it. */
async function oldTask(h, user, title, placeId, extra = {}) {
  const t = (await h.ok(user, 'POST', 'tasks', { title })).task;
  await store.run(h.host.gc, 'UPDATE tasks SET place_id = ?, place_json = ? WHERE id = ?', [placeId, JSON.stringify({ key: extra.key || null, label: null, any: false, trigger: 'enter', by: user.id, who: user.id, consent: 'accepted' }), t.id]);
  return t;
}
const fav = (h, userId, key, placeId, uses = 3) => store.run(h.host.gc, 'INSERT INTO place_picks (user_id, key, place_id, uses, used_at, fav) VALUES (?, ?, ?, ?, ?, 1)', [userId, key, placeId, uses, T0 - 3600000]);
const profileOf = (h, userId) => h.host.places.all().filter((p) => p.userId === userId);

test('the move: named and remembered places into the profile (sourceRef = old id), tasks on profile:<id>, Familie kept, the refused ones reported', async () => {
  // Anna has a place „Büro“ in her profile already (made in „Mein Profil“)
  const h = await host({ places: { places: [{ userId: 1, name: 'Büro', lat: 50.11, lon: 8.68 }] } });
  try {
    const gc = h.host.gc;
    const buero = await oldPlace(h, ANNA.id, { name: 'Büro', address: 'Hafenstraße 4, Musterstadt', lat: 52.6, lon: 13.5, radius: 200 });
    const oma = await oldPlace(h, ANNA.id, { name: 'Oma', lat: 52.4, lon: 13.2 });
    const long = await oldPlace(h, ANNA.id, { name: 'Gartenhaus am Ende des langen Weges hinter der alten Mühle am Bach', lat: 52.45, lon: 13.25, radius: 20 });
    const nord = await oldPlace(h, ANNA.id, { name: 'Baumarkt Nord', address: 'Industriestraße 4, Berlin', lat: 52.539, lon: 13.424, named: false, ref: 'osm:W101' });
    const home = await oldPlace(h, ANNA.id, { name: 'Zuhause', lat: 52.5203, lon: 13.4051, ref: 'familie:home' });
    const none = await oldPlace(h, ANNA.id, { name: 'Nirgendwo', lat: 0, lon: 0 });
    const once = await oldPlace(h, ANNA.id, { name: 'Irgendwo', lat: 52.3, lon: 13.1, named: false });
    const marcOma = await oldPlace(h, MARC.id, { name: 'Oma', lat: 52.41, lon: 13.21 });
    await fav(h, ANNA.id, 'kind:diy', nord);
    await fav(h, ANNA.id, 'name:zuhause', home);
    const t1 = await oldTask(h, ANNA, 'Akten holen', buero);
    const t2 = await oldTask(h, ANNA, 'Schrauben kaufen', nord, { key: 'kind:diy' });
    const t3 = await oldTask(h, ANNA, 'Blumen gießen', home);
    const t4 = await oldTask(h, ANNA, 'Irgendwas', none);
    const t5 = await oldTask(h, ANNA, 'Nur so', once);
    const t6 = await oldTask(h, MARC, 'Kuchen bringen', marcOma);
    h.host.places.calls.length = 0;

    // the start of 1.8.0
    pp.reset();
    await plugin.start(gc);
    await h.host.places.settle();

    // what went to the profile: one importFor per person, only the fields the profile knows, sourceRef = the old id
    const imports = h.host.places.calls.filter((c) => c.method === 'importFor');
    assert.deepEqual(imports.map((c) => [c.args.userId, c.args.source, c.args.places.map((p) => p.sourceRef)]),
      [[ANNA.id, 'notizen', [buero, oma, long, none, nord].map(String)], [MARC.id, 'notizen', [String(marcOma)]]]);
    for (const c of imports) for (const p of c.args.places) assert.deepEqual(Object.keys(p).filter((k) => !['sourceRef', 'name', 'lat', 'lon', 'radiusM', 'address'].includes(k)), [], 'no other field');
    assert.deepEqual(imports[0].args.places[0], { sourceRef: String(buero), name: 'Büro', lat: 52.6, lon: 13.5, radiusM: 200, address: 'Hafenstraße 4, Musterstadt' });
    assert.equal(imports[0].args.places[2].name.length, 60, 'a name longer than the profile takes is cut');
    assert.equal(imports[0].args.places[2].radiusM, 50);

    const anna = profileOf(h, ANNA.id);
    assert.deepEqual(anna.map((p) => [p.name, p.source, p.sourceRef]), [['Büro', 'manual', null], ['Büro 2', 'notizen', String(buero)], ['Oma', 'notizen', String(oma)],
      ['Gartenhaus am Ende des langen Weges hinter der alten Mühle a', 'notizen', String(long)], ['Baumarkt Nord', 'notizen', String(nord)]]);
    assert.deepEqual(profileOf(h, MARC.id).map((p) => [p.name, p.sourceRef]), [['Oma', String(marcOma)]]);
    const id = (name) => anna.find((p) => p.name === name).id;

    // the table old → new
    const moves = await store.all(gc, 'SELECT old_id, user_id, state, profile_id, field, created FROM place_moves ORDER BY old_id');
    assert.deepEqual(moves.map((m) => [m.old_id, m.user_id, m.state, m.profile_id, m.field, m.created]), [
      [buero, 1, 'moved', id('Büro 2'), null, 1], [oma, 1, 'moved', id('Oma'), null, 1], [long, 1, 'moved', anna[3].id, null, 1], [nord, 1, 'moved', id('Baumarkt Nord'), null, 1],
      [home, 1, 'family', null, null, 0], [none, 1, 'invalid', null, 'lat', 0], [marcOma, 2, 'moved', profileOf(h, MARC.id)[0].id, null, 1]]);

    // the tasks: on profile:<id> with a copy of the place; Familie's stays Familie's; the refused one keeps its place
    const v1 = (await task(h, ANNA, t1.id)).place;
    assert.deepEqual([v1.id, v1.ref, v1.name, v1.radius, v1.own], [id('Büro 2'), 'profile:' + id('Büro 2'), 'Büro 2', 200, true]);
    assert.deepEqual(await json(h, t1.id), { key: null, label: null, any: false, trigger: 'enter', by: 1, who: 1, consent: 'accepted', ref: 'profile:' + id('Büro 2'),
      copy: { name: 'Büro 2', address: 'Hafenstraße 4, Musterstadt', lat: 52.6, lon: 13.5, radius: 200 } });
    const v2 = (await task(h, ANNA, t2.id)).place;
    assert.deepEqual([v2.id, v2.ref, v2.name, v2.key], [id('Baumarkt Nord'), 'profile:' + id('Baumarkt Nord'), 'Baumarkt Nord', 'kind:diy']);
    const v3 = (await task(h, ANNA, t3.id)).place;
    assert.deepEqual([v3.id, v3.ref, v3.name], [home, 'familie:home', 'Zuhause']);
    assert.equal((await json(h, t3.id)).ref, undefined);
    const v4 = (await task(h, ANNA, t4.id)).place;
    assert.deepEqual([v4.id, v4.ref, v4.name, v4.lat, v4.lon, v4.own], [none, null, 'Nirgendwo', 0, 0, false]);
    assert.deepEqual([(await json(h, t4.id)).kept, (await json(h, t4.id)).copy], ['invalid', { name: 'Nirgendwo', address: '', lat: 0, lon: 0, radius: 150 }]);
    assert.deepEqual([(await task(h, ANNA, t5.id)).place.name, (await task(h, ANNA, t5.id)).place.id], ['Irgendwo', once], 'a place taken once is no place of „Meine Orte“: it stays');
    assert.equal((await task(h, MARC, t6.id)).place.ref, 'profile:' + profileOf(h, MARC.id)[0].id);
    // the fence of a moved place stays the same for the phones
    const w = await h.ok(ANNA, 'POST', 'places/watch', {});
    assert.ok(w.fences.some((f) => f.id === 'p:' + buero && f.ref === 'profile:' + id('Büro 2')));
    assert.ok(w.fences.some((f) => f.id === 'osm:W101' && f.ref === 'profile:' + id('Baumarkt Nord')));

    // GET places: the profile's places, the favourite as a reference to it, what was refused
    const all = await h.ok(ANNA, 'GET', 'places');
    assert.deepEqual(all.places.map((p) => [p.name, p.ref]), anna.map((p) => [p.name, 'profile:' + p.id]).sort((x, y) => x[0].localeCompare(y[0], 'de')));
    assert.deepEqual(all.favs.map((f) => [f.key, f.placeId, f.ref, f.uses]), [['kind:diy', id('Baumarkt Nord'), 'profile:' + id('Baumarkt Nord'), 3]], 'the favourite of a place of Familie stays here, not in the profile');
    assert.deepEqual(all.notMoved, [{ name: 'Nirgendwo', reason: 'invalid', field: 'lat' }]);
    assert.deepEqual((await h.ok(MARC, 'GET', 'places')).notMoved, []);
    // the quick entry knows the moved ones, „mein Baumarkt“ too
    assert.equal((await h.ok(ANNA, 'POST', 'parse', { text: 'bei Oma Kuchen essen' })).place.place.id, id('Oma'));
    assert.equal((await h.ok(ANNA, 'POST', 'parse', { text: 'beim Baumarkt Dübel holen' })).place.place.id, id('Baumarkt Nord'));
    // „Genutzt von“: the open tasks per place
    assert.deepEqual(h.host.places.usage(id('Büro 2')), [{ plugin: 'gatecontrol-notizen', kind: 'task', count: 1 }]);
    assert.deepEqual(h.host.places.usage(id('Oma')), [], 'no task: nothing told');
    // reported: the log and the status line of the settings
    assert.ok(h.host.logs.some((l) => /place not moved to the profile/.test(l.message) && /Nirgendwo/.test(JSON.stringify(l))));
    const st = (await h.host.settingsStatus('de')).filter((x) => x.group === 'places');
    assert.deepEqual(st[1], { group: 'places', tone: 'warn', text: '„Meine Orte“ sind ins Profil umgezogen (5). 1 hat das Profil nicht angenommen – die Aufgaben behalten sie als ihren Ort.' });

    // twice: nothing twice — at the next start, and even when the table of the move were lost (importFor knows the sourceRef)
    const before = h.host.places.all().length;
    pp.reset();
    await plugin.start(gc);
    assert.equal(h.host.places.all().length, before);
    await store.run(gc, "DELETE FROM place_moves WHERE state = 'moved'");
    await store.run(gc, 'UPDATE places SET profile_id = NULL WHERE id IN (?, ?)', [buero, oma]);
    pp.reset();
    const again = await pp.move(gc, clock.now());
    await h.host.places.settle();
    assert.equal(h.host.places.all().length, before, 'no place twice');
    assert.equal(again.moved, 2);
    assert.deepEqual((await store.all(gc, 'SELECT old_id, profile_id, created FROM place_moves WHERE old_id IN (?, ?) ORDER BY old_id', [buero, oma])).map((m) => [m.profile_id, m.created]), [[id('Büro 2'), 0], [id('Oma'), 0]]);
    assert.equal((await task(h, ANNA, t1.id)).place.id, id('Büro 2'));
    assert.equal(await pp.move(gc, clock.now()), null, 'done: nothing more to do');
  } finally { await done(h); }
});

test('the move: the profile full (100 places) — the rest stays the tasks\' place; a host that fails is asked again in the background run', async () => {
  const full = Array.from({ length: 100 }, (_, i) => ({ userId: BOB.id, name: 'Ort ' + (i + 1), lat: 52 + i / 1000, lon: 13 }));
  const h = await host({ places: { places: full } });
  try {
    const gc = h.host.gc;
    const kiosk = await oldPlace(h, BOB.id, { name: 'Kiosk', lat: 52.2, lon: 13.3 });
    const t = await oldTask(h, BOB, 'Zeitung', kiosk);
    const anna = await oldPlace(h, ANNA.id, { name: 'Sportplatz', lat: 52.21, lon: 13.31 });
    // the host fails once: nothing is lost, the next background run moves it
    pp.reset();
    h.host.places.failNext('ERR_INTERNAL');
    const first = await pp.move(gc, clock.now());
    assert.equal(first.moved, 0);
    assert.equal(pp.state.moved, false);
    assert.equal((await store.all(gc, 'SELECT * FROM place_moves')).length, 0);
    assert.equal((await h.host.settingsStatus('de')).filter((x) => x.group === 'places')[1].text, 'Der Umzug von „Meine Orte“ ins Profil hat noch nicht geklappt – er wird im Hintergrund wiederholt.');
    await h.host.tick();
    assert.equal(pp.state.moved, true);
    assert.deepEqual((await store.all(gc, 'SELECT old_id, state FROM place_moves ORDER BY old_id')).map((m) => [m.old_id, m.state]), [[kiosk, 'limit'], [anna, 'moved']]);
    assert.equal(profileOf(h, BOB.id).length, 100);
    assert.deepEqual([(await task(h, BOB, t.id)).place.name, (await task(h, BOB, t.id)).place.id], ['Kiosk', kiosk]);
    assert.deepEqual((await h.ok(BOB, 'GET', 'places')).notMoved, [{ name: 'Kiosk', reason: 'limit', field: null }]);
    // a new place does not fit either
    const r = await h.call(BOB, 'POST', 'places', { name: 'Noch einer', lat: 52.9, lon: 13.9 });
    assert.deepEqual([r.status, r.json.code], [409, 'too_many']);
  } finally { await done(h); }
});

test('placesChanged: the copies follow the profile (name, point, radius); deleted or no longer visible → the tasks keep the copy', async () => {
  const h = await host();
  try {
    const arbeit = await h.host.places.add(ANNA.id, { name: 'Arbeit', icon: 'work', lat: 52.6, lon: 13.5, radiusM: 200, address: 'Hafenstraße 4' });
    // Marc's place „Sportverein“ for the family: Anna may hang a task on it (it is not one of her „Meine Orte“)
    const verein = await h.host.places.add(MARC.id, { name: 'Sportverein', lat: 52.55, lon: 13.45, visibility: 'family' });
    await h.host.places.settle();
    const a = (await h.ok(ANNA, 'POST', 'tasks', { title: 'Schlüssel abgeben', place: { placeId: arbeit.id } })).task;
    const b = (await h.ok(ANNA, 'POST', 'tasks', { title: 'Trikot holen', place: { ref: 'profile:' + verein.id } })).task;
    assert.deepEqual([a.place.id, a.place.name, a.place.radius, a.place.own], [arbeit.id, 'Arbeit', 200, true]);
    assert.deepEqual([b.place.id, b.place.name, b.place.own], [verein.id, 'Sportverein', false]);
    assert.equal((await h.call(BOB, 'POST', 'tasks', { title: 'x', place: { placeId: verein.id } })).status, 404, 'Bob is not of the family');
    assert.deepEqual((await h.ok(ANNA, 'GET', 'places')).places.map((p) => p.name), ['Arbeit'], 'another person\'s place is no place of „Meine Orte“');
    assert.deepEqual(h.host.places.usage(verein.id), [{ plugin: 'gatecontrol-notizen', kind: 'task', count: 1 }]);
    // changed in the profile → the hook; the task shows it, the phones are told
    h.host.events.length = 0;
    await h.host.places.update(arbeit.id, { name: 'Büro', lat: 52.61, lon: 13.51, radiusM: 300 });
    require('../server/events').now();
    const v = (await task(h, ANNA, a.id)).place;
    assert.deepEqual([v.name, v.lat, v.lon, v.radius, v.ref], ['Büro', 52.61, 13.51, 300, 'profile:' + arbeit.id]);
    assert.ok(h.host.events.some((e) => e.type === 'changed' && e.data.what.includes('places') && e.users.includes(ANNA.id)));
    assert.equal((await json(h, a.id)).copy.name, 'Büro');
    // the same again: nothing written, nobody told
    h.host.events.length = 0;
    assert.deepEqual(await plugin.placesChanged({ userId: ANNA.id, ids: [arbeit.id], deleted: false }, h.host.gc), { rows: 1, gone: 0, changed: 0 });
    require('../server/events').now();
    assert.equal(h.host.events.length, 0);
    // Marc makes his place private: Anna's task keeps a copy, without the reference
    await h.host.places.update(verein.id, { visibility: 'self' });
    const vb = (await task(h, ANNA, b.id)).place;
    assert.deepEqual([vb.ref, vb.name, vb.lat, vb.own], [null, 'Sportverein', 52.55, false]);
    assert.equal((await json(h, b.id)).was, 'profile:' + verein.id);
    assert.deepEqual(h.host.places.usage(verein.id), [], '„Genutzt von“ goes with it');
    // told for Anna herself — a 0 is taken for a place she no longer sees (gc.places version 2), no detour over Marc
    assert.deepEqual(h.host.places.calls.filter((x) => x.method === 'reportUsage' && x.args.id === verein.id).map((x) => [x.args.userId, x.args.count]), [[ANNA.id, 1], [ANNA.id, 0]]);
    // Anna deletes „Büro“ in her profile: the task keeps the place, the reminder at the place goes on
    await h.host.places.remove(arbeit.id);
    const va = (await task(h, ANNA, a.id)).place;
    assert.deepEqual([va.ref, va.name, va.radius, va.watch], [null, 'Büro', 300, true]);
    assert.ok((await h.ok(ANNA, 'POST', 'places/watch', {})).fences.some((f) => f.name === 'Büro' && f.tasks[0].taskId === a.id));
    // the hourly run finds a change the hook missed (the plugin was stopped)
    const c = (await h.ok(LENA, 'POST', 'tasks', { title: 'Bücher', place: { placeId: (await h.host.places.add(LENA.id, { name: 'Bücherei', lat: 52.52, lon: 13.42 })).id } })).task;
    const lib = h.host.places.all().find((p) => p.name === 'Bücherei');
    await h.host.places.settle();
    // the copy is behind the profile (a change while the plugin was stopped): the hourly run brings it up to date
    await store.run(h.host.gc, 'UPDATE places SET radius = 999 WHERE profile_id = ?', [lib.id]);
    assert.equal(await pp.refresh(h.host.gc, clock.now()), 0);
    assert.equal((await task(h, LENA, c.id)).place.radius, 150);
    // a task done: „Genutzt von“ follows in the background run
    assert.equal(h.host.places.usage(lib.id)[0].count, 1);
    await h.ok(LENA, 'POST', `tasks/${c.id}/complete`, { done: true });
    await h.host.tick();
    assert.deepEqual(h.host.places.usage(lib.id), []);
  } finally { await done(h); }
});
