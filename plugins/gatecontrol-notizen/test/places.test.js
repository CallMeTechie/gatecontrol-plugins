'use strict';

// 1.5.0 — a task at a place: the place a line names (found by the server — the parser ui/quickparse.js and its vectors
// are untouched), „Meine Orte“ and the remembered place of a kind, the place search through the server (rounded
// position, cache, one request at a time, the switches of the administrator and of the person), the list of places a
// phone watches (sorted, cut to its budget, shared with Familie) and what a place that fired may show. The search
// service is a fake that speaks Nominatim's /search; the clock is pinned (helpers) and only ever set.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ANNA, MARC, LENA, BOB, clock, T0 } = require('./helpers');
const { host, HOME, CELL } = require('./placefakes');
const search = require('../server/placesearch');
const words = require('../server/placewords');
const places = require('../server/places');
const store = require('../server/store');

const done = async (h) => { search.state.pauseMs = search.PAUSE_MS; await h.close(); clock.set(T0); };
const task = async (h, user, id) => (await h.ok(user, 'GET', 'tasks/' + id)).task;
const parse = async (h, user, text) => (await h.ok(user, 'POST', 'parse', { text }));

test('the parser and its vectors are as they were (Android and Windows carry the same vectors)', () => {
  const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', f))).digest('hex');
  assert.equal(sha('ui/quickparse.js'), '1fcb5e337f4fd5ea8e42a8e73be614b3e94c75aeddf4f9ef6975b8dbbc8793d7');
  assert.equal(sha('test/vectors/quickparse.json'), '72f79800c231127a286f816230b3822ff6bc28d7cf0cc5a80c110a9cc90e8367');
});

test('me: the feature words, the search off by default, the person\'s own switches', async () => {
  const h = await host({ settings: { place_search: 'off' } });
  try {
    const me = await h.ok(ANNA, 'GET', 'me');
    assert.ok(me.features.includes('places') && me.features.includes('placeSearch'));
    assert.deepEqual(me.places.search, { state: 'off', enabled: false, mine: true, service: 'off', radiusKm: 15, decimals: 2, attribution: { text: '© OpenStreetMap', url: 'https://www.openstreetmap.org/copyright' } });
    assert.equal(me.places.nearby, true);
    assert.deepEqual(me.places.quiet, { from: '21:00', to: '07:00' });
    assert.equal(me.places.perTask, 5);
    assert.deepEqual(me.prefs.places, { search: true, nearby: true, quiet: { from: '21:00', to: '07:00' } });
    // no setting at all is off as well (a fresh installation)
    const r = await h.call(ANNA, 'POST', 'places/search', { key: 'kind:diy', near: HOME });
    assert.equal(r.status, 403);
    assert.deepEqual(r.json, { ok: false, code: 'module_off', reason: 'admin' });
    assert.equal(h.net.calls.length, 0);
    const p = (await h.ok(ANNA, 'PUT', 'prefs', { places: { search: false, quiet: null } })).prefs.places;
    assert.deepEqual(p, { search: false, nearby: true, quiet: null });
    assert.deepEqual((await h.ok(ANNA, 'PUT', 'prefs', { places: { quiet: { from: '22:00', to: '06:30' } } })).prefs.places.quiet, { from: '22:00', to: '06:30' });
    assert.equal((await h.ok(ANNA, 'PUT', 'prefs', { places: { quiet: { from: 'x', to: '06:30' } } })).prefs.places.quiet, null, 'no valid times: no quiet hours');
  } finally { await done(h); }
});

test('the line names a place: a kind, a name, an address, an own place, the family\'s — and what is no place', async () => {
  const h = await host();
  try {
    await h.ok(ANNA, 'POST', 'places', { name: 'Oma', address: 'Gartenweg 5', lat: 52.4, lon: 13.2 });
    const k = (await parse(h, ANNA, 'beim Baumarkt Schrauben kaufen')).place;
    assert.deepEqual({ via: k.via, word: k.word, key: k.key, label: k.label, title: k.title, certain: k.certain, trigger: k.trigger, place: k.place, options: k.options, search: k.search },
      { via: 'kind', word: 'beim Baumarkt', key: 'kind:diy', label: 'Baumarkt', title: 'Schrauben kaufen', certain: true, trigger: 'enter', place: null, options: [], search: 'on' });
    const n = (await parse(h, ANNA, 'bei Lidl Pfand wegbringen morgen 9 Uhr'));
    assert.equal(n.parsed.date, '2026-11-09');
    assert.deepEqual([n.place.via, n.place.key, n.place.label, n.place.title], ['name', 'name:lidl', 'Lidl', 'Pfand wegbringen']);
    // one word left would be no title: it stays („Bei Lidl einkaufen“)
    assert.equal((await parse(h, ANNA, 'bei Lidl einkaufen')).place.title, 'bei Lidl einkaufen');
    const o = (await parse(h, ANNA, 'bei Oma Leiter zurückgeben')).place;
    assert.deepEqual([o.via, o.key, o.place.name, o.place.address, o.place.named, o.title, o.certain], ['own', null, 'Oma', 'Gartenweg 5', true, 'Leiter zurückgeben', true]);
    const f = (await parse(h, ANNA, 'zu Hause Blumen gießen')).place;
    assert.deepEqual([f.via, f.place.familyId, f.place.name, f.place.family, f.title], ['family', 'home', 'Zuhause', true, 'Blumen gießen']);
    assert.equal((await parse(h, ANNA, 'an der Schule Zettel abgeben')).place.place.familyId, 'place:3');
    const a = (await parse(h, ANNA, 'Paket Ringstraße 21 abgeben')).place;
    assert.deepEqual([a.via, a.query, a.title], ['address', 'Ringstraße 21', 'Paket abgeben']);
    // a kind without a preposition is offered, but not surely meant; a date is no place; nor are these
    const bare = (await parse(h, ANNA, 'Apotheke')).place;
    assert.deepEqual([bare.via, bare.key, bare.certain], ['kind', 'kind:pharmacy', false]);
    for (const s of ['am Montag Mama anrufen', 'im Garten Unkraut jäten', 'bei mir aufräumen', 'zu erledigen', 'am besten gleich', 'Steuererklärung']) assert.equal((await parse(h, ANNA, s)).place, null, s);
    // Bob is not of the family: „zu Hause“ is nothing to him
    assert.equal((await parse(h, BOB, 'zu Hause Blumen gießen')).place, null);
    // every kind of the table is a word the detection finds, with a label in both languages
    for (const [id, kind] of Object.entries(words.KINDS)) {
      for (const w of kind.words) assert.equal(words.detect('bei ' + w + ' etwas holen', 'de', {}).key, 'kind:' + id, w);
      assert.ok(kind.de && kind.en && kind.phrase && kind.tags.length, id);
    }
    assert.equal(h.net.calls.length, 0, 'finding the place in a line asks nobody');
  } finally { await done(h); }
});

test('the search: a rounded position, the nearest first, a filter by map tags, a cache — and nothing kept', async () => {
  const h = await host();
  try {
    const r = await h.ok(ANNA, 'POST', 'places/search', { key: 'kind:diy', near: HOME });
    assert.deepEqual(r.cell, CELL);
    assert.deepEqual(r.results.map((x) => [x.ref, x.name, x.address, x.placeId, x.fav]), [
      ['osm:W101', 'Baumarkt Nord', 'Industriestraße 4, Berlin', null, false],
      ['osm:W102', 'Baumarkt am Ring', 'Ringstraße 21, Berlin', null, false],
      ['osm:N103', 'Baumarkt Süd', 'Am Hafen 2, Berlin', null, false]], 'the restaurant „Zum Baumarkt“ is no Baumarkt');
    assert.ok(r.results[0].distanceM < r.results[1].distanceM && r.results[1].distanceM < r.results[2].distanceM);
    assert.deepEqual(r.results.map((x) => x.minutes), r.results.map((x) => search.minutes(x.distanceM)));
    assert.deepEqual([r.key, r.label, r.kind, r.radiusKm, r.any, r.approx], ['kind:diy', 'Baumarkt', 'kind', 15, true, true]);
    assert.deepEqual(r.attribution, { text: '© OpenStreetMap', url: 'https://www.openstreetmap.org/copyright' });
    // what went out: the phrase and a box around the rounded cell — never the position, a name or an id
    assert.equal(h.net.calls.length, 2, 'the near box had too few, the wide one was asked');
    for (const c of h.net.calls) {
      assert.ok(c.url.startsWith('https://nominatim.openstreetmap.org/search?'));
      assert.equal(c.q, '[Baumarkt]');
      assert.equal(c.bounded, '1');
      assert.ok(!/52\.5203|13\.4051|Anna|Berg/.test(c.url), c.url);
      assert.match(c.agent, /^GateControl-Notizen\/1\.5\.0 \(.+github\.com\/CallMeTechie\/gatecontrol\)$/);
    }
    assert.equal(h.net.calls[0].viewbox, search.boxOf(CELL, 4));
    assert.equal(h.net.calls[1].viewbox, search.boxOf(CELL, 15));
    // the same cell again (another person, a position 300 m away): from the cache
    const again = await h.ok(MARC, 'POST', 'places/search', { key: 'kind:diy', near: { lat: 52.5218, lon: 13.4068 } });
    assert.deepEqual(again.results.map((x) => x.ref), r.results.map((x) => x.ref));
    assert.equal(h.net.calls.length, 2);
    // a name; free text finds its kind, its address or is a name
    const lidl = await h.ok(ANNA, 'POST', 'places/search', { q: 'Lidl', near: HOME });
    assert.deepEqual([lidl.key, lidl.kind, lidl.label, lidl.results.map((x) => [x.name, x.address])], ['name:lidl', 'name', 'Lidl', [['Lidl Marktstraße', 'Marktstraße 12, Berlin'], ['Lidl Bahnhofsplatz', 'Bahnhofsplatz 3, Berlin']]]);
    assert.equal((await h.ok(ANNA, 'POST', 'places/search', { q: 'zum Baumarkt', near: HOME })).key, 'kind:diy');
    const addr = await h.ok(ANNA, 'POST', 'places/search', { q: 'Ringstraße 21', near: HOME });
    assert.deepEqual([addr.kind, addr.key, addr.any, addr.results[0].name, addr.results[0].ref], ['address', null, false, 'Ringstraße 21', 'osm:N301']);
    assert.equal(h.net.calls[h.net.calls.length - 1].bounded, null, 'an address is searched near, not only inside the box');
    // nothing found: an empty list, cached as well
    const none = await h.ok(ANNA, 'POST', 'places/search', { key: 'kind:fuel', near: HOME });
    assert.deepEqual([none.results, none.any, none.radiusKm], [[], false, 15]);
    const before = h.net.calls.length;
    await h.ok(ANNA, 'POST', 'places/search', { key: 'kind:fuel', near: HOME });
    assert.equal(h.net.calls.length, before);
    // near one of the person's places instead of a position (the portal)
    const oma = (await h.ok(ANNA, 'POST', 'places', { name: 'Oma', lat: 52.5207, lon: 13.4099 })).place;
    assert.deepEqual((await h.ok(ANNA, 'POST', 'places/search', { key: 'kind:diy', nearPlaceId: oma.id })).cell, CELL);
    assert.deepEqual((await h.ok(ANNA, 'POST', 'places/search', { key: 'kind:diy', nearFamilyId: 'home' })).cell, CELL);
    // nothing of a search is in the database or the log
    const dump = JSON.stringify(await store.all(h.host.gc, 'SELECT * FROM places')) + JSON.stringify(await store.all(h.host.gc, 'SELECT * FROM place_picks')) + JSON.stringify(h.host.logs);
    assert.ok(!/52\.5203|13\.4051|Baumarkt Nord|\[Baumarkt\]/.test(dump));
    // refused: no position, a bad key, another person's place
    for (const [body, field] of [[{ key: 'kind:diy' }, 'near'], [{ key: 'kind:diy', near: { lat: 95, lon: 1 } }, 'near'], [{ key: 'kind:nope', near: HOME }, 'key'], [{ q: 'x', near: HOME }, 'q']]) {
      const bad = await h.call(ANNA, 'POST', 'places/search', body);
      assert.deepEqual([bad.status, bad.json.code, bad.json.field], [400, 'invalid', field], JSON.stringify(body));
    }
    assert.equal((await h.call(MARC, 'POST', 'places/search', { key: 'kind:diy', nearPlaceId: oma.id })).status, 404);
  } finally { await done(h); }
});

test('the search keeps to the service\'s rules: one request at a time with a pause, a limit per person, a rest after a failure', async () => {
  const h = await host({ pauseMs: 120 });
  try {
    // three searches at once: six requests, never two closer than the pause
    await Promise.all(['kind:diy', 'kind:fuel', 'kind:bakery'].map((key) => h.ok(ANNA, 'POST', 'places/search', { key, near: HOME })));
    assert.equal(h.net.calls.length, 6);
    for (let i = 1; i < h.net.calls.length; i++) assert.ok(h.net.calls[i].at - h.net.calls[i - 1].at >= 110, `pause before request ${i}: ${h.net.calls[i].at - h.net.calls[i - 1].at} ms`);
    // the same search twice at once is one search
    search.state.pauseMs = 0;
    const n = h.net.calls.length;
    await Promise.all([1, 2, 3].map(() => h.ok(MARC, 'POST', 'places/search', { key: 'kind:pharmacy', near: HOME })));
    assert.equal(h.net.calls.length, n + 2);
    // the limit per person: PER_HOUR searches that really go out, then 429 until the hour has passed; cached ones are free
    search.reset(); search.state.pauseMs = 0;
    const kinds = Object.keys(words.KINDS);
    for (let i = 0; i < search.PER_HOUR; i++) await h.ok(LENA, 'POST', 'places/search', { key: 'kind:' + kinds[i], near: HOME });
    const over = await h.call(LENA, 'POST', 'places/search', { key: 'kind:' + kinds[search.PER_HOUR], near: HOME });
    assert.deepEqual([over.status, over.json.code, over.json.reason], [429, 'busy', 'limit']);
    assert.ok(over.json.retryAfter > 0 && over.json.retryAfter <= 3600);
    await h.ok(LENA, 'POST', 'places/search', { key: 'kind:' + kinds[0], near: HOME });
    await h.ok(MARC, 'POST', 'places/search', { key: 'kind:' + kinds[search.PER_HOUR], near: HOME });
    clock.set(T0 + 3601000);
    await h.ok(LENA, 'POST', 'places/search', { key: 'kind:' + kinds[search.PER_HOUR + 1], near: HOME });
    // the service fails: 503, and it is left alone for a minute — nothing of the query in the log
    search.reset(); search.state.pauseMs = 0;
    h.net.fail = true;
    const calls = h.net.calls.length;
    const down = await h.call(ANNA, 'POST', 'places/search', { key: 'kind:diy', near: HOME });
    assert.deepEqual([down.status, down.json.code, down.json.reason], [503, 'unavailable', 'service']);
    assert.equal(h.net.calls.length, calls + 1);
    assert.equal((await h.call(ANNA, 'POST', 'places/search', { key: 'kind:diy', near: HOME })).status, 503);
    assert.equal(h.net.calls.length, calls + 1, 'left alone');
    h.net.fail = false;
    clock.set(clock.now() + 61000);
    assert.equal((await h.ok(ANNA, 'POST', 'places/search', { key: 'kind:diy', near: HOME })).results.length, 3);
    assert.ok(h.host.logs.some((l) => /place search failed/.test(String(l.message))));
    assert.ok(!/Baumarkt|52\.5|13\.4/.test(JSON.stringify(h.host.logs)));
  } finally { await done(h); }
});

test('the switches: the administrator\'s (off, the public service, an own one), the person\'s own', async () => {
  const h = await host({ settings: { place_search: 'own' }, targets: true });
  try {
    assert.equal((await h.ok(ANNA, 'GET', 'me')).places.search.state, 'on');
    const r = await h.ok(ANNA, 'POST', 'places/search', { key: 'kind:diy', near: HOME });
    assert.equal(r.results.length, 3);
    assert.ok(h.net.calls.every((c) => c.url.startsWith('/search?')), 'the own service: the access target, never the public host');
    // the person's own switch
    await h.ok(MARC, 'PUT', 'prefs', { places: { search: false } });
    const off = await h.call(MARC, 'POST', 'places/search', { key: 'kind:diy', near: HOME });
    assert.deepEqual([off.status, off.json], [403, { ok: false, code: 'module_off', reason: 'self' }]);
    assert.deepEqual([(await h.ok(MARC, 'GET', 'me')).places.search.state, (await h.ok(MARC, 'GET', 'me')).places.search.mine], ['off', false]);
    assert.equal((await parse(h, MARC, 'beim Baumarkt Schrauben kaufen')).place.search, 'off');
    const st = await h.host.settingsStatus('de');
    assert.deepEqual(st.filter((x) => x.group === 'places').map((x) => [x.tone, x.text]), [['ok', 'Ortssuche über den eigenen Dienst (Zugriffsziel „Ortssuche“).']]);
  } finally { await done(h); }
  // an own service chosen, but no target assigned: unavailable (503), and the settings page says so
  const g = await host({ settings: { place_search: 'own' } });
  try {
    assert.equal((await g.ok(ANNA, 'GET', 'me')).places.search.state, 'unavailable');
    assert.equal((await g.call(ANNA, 'POST', 'places/search', { key: 'kind:diy', near: HOME })).status, 503);
    assert.equal((await g.host.settingsStatus('de')).find((x) => x.group === 'places').tone, 'warn');
    assert.equal(g.net.calls.length, 0);
  } finally { await done(g); }
  const o = await host();
  try {
    const line = (await o.host.settingsStatus('en')).find((x) => x.group === 'places');
    assert.equal(line.tone, 'ok');
    assert.match(line.text, /usage policy/);
  } finally { await done(o); }
});

test('„Meine Orte“: add, change, delete; the remembered place of a kind comes first and without asking', async () => {
  const h = await host();
  try {
    const oma = (await h.ok(ANNA, 'POST', 'places', { name: 'Oma', address: 'Gartenweg 5', lat: 52.4, lon: 13.2, clientId: 'place-oma-0001' })).place;
    assert.deepEqual([oma.name, oma.radius, oma.named, oma.ref, oma.family], ['Oma', 150, true, null, false]);
    assert.equal((await h.ok(ANNA, 'POST', 'places', { name: 'Oma', lat: 52.4, lon: 13.2, clientId: 'place-oma-0001' })).replayed, true);
    assert.equal((await h.ok(ANNA, 'PATCH', 'places/' + oma.id, { name: 'Oma Inge', radius: 20 })).place.radius, 50, 'the radius stays between 50 and 2000 m');
    for (const [body, field] of [[{ lat: 1, lon: 1 }, 'name'], [{ name: 'x', lat: 91, lon: 1 }, 'lat'], [{ name: 'x', lat: 1, lon: '2' }, 'lon'], [{ name: 'x', lat: 1, lon: 2, ref: 'http://x' }, 'ref']]) {
      const bad = await h.call(ANNA, 'POST', 'places', body);
      assert.deepEqual([bad.status, bad.json.field], [400, field]);
    }
    assert.equal((await h.call(MARC, 'PATCH', 'places/' + oma.id, { name: 'x' })).status, 404, 'another person\'s place');
    // a task at a search hit, remembered as „mein Baumarkt“
    const hit = (await h.ok(ANNA, 'POST', 'places/search', { key: 'kind:diy', near: HOME })).results[1];
    const t1 = (await h.ok(ANNA, 'POST', 'tasks', { text: 'beim Baumarkt Schrauben kaufen', place: { ref: hit.ref, name: hit.name, address: hit.address, lat: hit.lat, lon: hit.lon, key: 'kind:diy', remember: true } })).task;
    assert.equal(t1.title, 'Schrauben kaufen', 'the place\'s words leave the title');
    assert.deepEqual([t1.place.mode, t1.place.name, t1.place.address, t1.place.ref, t1.place.trigger, t1.place.key, t1.place.label, t1.place.own, t1.place.consent, t1.place.watch, t1.place.nearby],
      ['place', 'Baumarkt am Ring', 'Ringstraße 21, Berlin', 'osm:W102', 'enter', 'kind:diy', 'Baumarkt', false, 'accepted', true, true]);
    const all = await h.ok(ANNA, 'GET', 'places');
    assert.deepEqual(all.places.map((p) => [p.name, p.named, p.favFor.map((f) => f.label)]), [['Oma Inge', true, []], ['Baumarkt am Ring', false, ['Baumarkt']]]);
    assert.deepEqual(all.favs.map((f) => [f.key, f.label, f.uses]), [['kind:diy', 'Baumarkt', 1]]);
    assert.deepEqual(all.family.map((f) => [f.familyId, f.name]), [['home', 'Zuhause'], ['place:3', 'Schule']]);
    // next time: the remembered one is there without a search, and first in the list of the search
    const calls = h.net.calls.length;
    const p = (await parse(h, ANNA, 'beim Baumarkt Dübel holen')).place;
    assert.deepEqual([p.place.name, p.uses, p.options.length], ['Baumarkt am Ring', 1, 1]);
    assert.equal(h.net.calls.length, calls);
    const auto = await h.ok(ANNA, 'POST', 'tasks', { text: 'beim Baumarkt Dübel holen', place: 'auto' });
    assert.deepEqual([auto.task.title, auto.task.place.name, auto.place.place.name], ['Dübel holen', 'Baumarkt am Ring', 'Baumarkt am Ring']);
    assert.equal((await h.ok(ANNA, 'GET', 'places')).favs[0].uses, 2, '„zuletzt zweimal gewählt“');
    const list = (await h.ok(ANNA, 'POST', 'places/search', { key: 'kind:diy', near: HOME })).results;
    assert.deepEqual(list.map((x) => [x.name, x.fav, x.uses, x.placeId != null]), [['Baumarkt am Ring', true, 2, true], ['Baumarkt Nord', false, 0, false], ['Baumarkt Süd', false, 0, false]]);
    // 'auto' takes only what is decided and surely meant: no remembered Lidl → no place; a bare kind word → no place
    const no = await h.ok(ANNA, 'POST', 'tasks', { text: 'bei Lidl Pfand wegbringen', place: 'auto' });
    assert.deepEqual([no.task.place, no.task.title, no.place.via], [null, 'bei Lidl Pfand wegbringen', 'name']);
    assert.equal((await h.ok(ANNA, 'POST', 'tasks', { text: 'Baumarkt anrufen wegen Lieferung', place: 'auto' })).task.place, null);
    assert.equal((await h.ok(ANNA, 'POST', 'tasks', { text: 'beim Baumarkt Schrauben kaufen' })).task.place, null, 'without `place` nothing is hung on (older apps)');
    // another one for this once; remembering another one; forgetting
    const nord = list[1];
    const t2 = (await h.ok(ANNA, 'POST', 'tasks', { title: 'Farbe', place: { ref: nord.ref, name: nord.name, address: nord.address, lat: nord.lat, lon: nord.lon, key: 'kind:diy' } })).task;
    assert.equal((await h.ok(ANNA, 'GET', 'places')).favs[0].placeId, t1.place.id, 'still the remembered one');
    assert.equal((await h.ok(ANNA, 'PUT', 'places/favs', { key: 'kind:diy', placeId: t2.place.id })).favs[0].placeId, t2.place.id);
    assert.deepEqual((await h.ok(ANNA, 'PUT', 'places/favs', { key: 'kind:diy', placeId: null })).favs, []);
    assert.equal((await parse(h, ANNA, 'beim Baumarkt Dübel holen')).place.place, null);
    assert.equal((await parse(h, ANNA, 'beim Baumarkt Dübel holen')).place.options.length, 2, 'the ones chosen before are still offered first');
    // an own place: by name, no search, no hint at other places
    const t3 = (await h.ok(ANNA, 'POST', 'tasks', { text: 'bei Oma Inge Leiter zurückgeben', place: 'auto' })).task;
    assert.deepEqual([t3.title, t3.place.name, t3.place.own, t3.place.key, t3.place.nearby], ['Leiter zurückgeben', 'Oma Inge', true, null, false]);
    // the family's home
    const t4 = (await h.ok(ANNA, 'POST', 'tasks', { text: 'zu Hause Blumen gießen', place: 'auto' })).task;
    assert.deepEqual([t4.title, t4.place.name, t4.place.ref, t4.place.lat], ['Blumen gießen', 'Zuhause', 'familie:home', 52.5203]);
    // deleted: gone from „Meine Orte“; the task keeps its place
    assert.deepEqual(await h.ok(ANNA, 'DELETE', 'places/' + oma.id), { ok: true });
    assert.deepEqual(await h.ok(ANNA, 'DELETE', 'places/' + oma.id), { ok: true, gone: true });
    assert.ok(!(await h.ok(ANNA, 'GET', 'places')).places.some((x) => x.id === oma.id));
    assert.equal((await task(h, ANNA, t3.id)).place.name, 'Oma Inge');
    assert.equal((await parse(h, ANNA, 'bei Oma Inge klingeln')).place.via, 'name');
  } finally { await done(h); }
});

test('the place of a task: set, change, take away; „Jeder Lidl“; refused input; a repeating task keeps it', async () => {
  const h = await host();
  try {
    const t1 = (await h.ok(ANNA, 'POST', 'tasks', { title: 'Pfand wegbringen', place: { any: true, key: 'name:lidl', label: 'LIDL' } })).task;
    assert.deepEqual([t1.place.mode, t1.place.name, t1.place.id, t1.place.lat, t1.place.key, t1.place.label, t1.place.nearby], ['any', 'Jeder LIDL', null, null, 'name:lidl', 'LIDL', false]);
    // a pin on the map, on leaving
    let t = (await h.ok(ANNA, 'PATCH', 'tasks/' + t1.id, { place: { name: 'Werkstatt Meier', lat: 52.51, lon: 13.39, radius: 300, trigger: 'exit', key: null } })).task;
    assert.deepEqual([t.place.mode, t.place.name, t.place.radius, t.place.trigger, t.place.key, t.place.ref], ['place', 'Werkstatt Meier', 300, 'exit', null, null]);
    // only the trigger
    t = (await h.ok(ANNA, 'PATCH', 'tasks/' + t1.id, { place: { trigger: 'enter' } })).task;
    assert.deepEqual([t.place.name, t.place.trigger], ['Werkstatt Meier', 'enter']);
    const at = t.updatedAt;
    clock.set(T0 + 60000);
    assert.equal((await h.ok(ANNA, 'PATCH', 'tasks/' + t1.id, { place: { trigger: 'enter' } })).task.updatedAt, at, 'the same again writes nothing');
    assert.equal((await h.ok(ANNA, 'PATCH', 'tasks/' + t1.id, { place: null })).task.place, null);
    assert.equal((await h.ok(ANNA, 'PATCH', 'tasks/' + t1.id, { place: null })).task.place, null);
    for (const [place, field] of [[{ trigger: 'enter' }, 'place'], ['x', 'place'], [{ any: true }, 'place.key'], [{ lat: 1, lon: 2 }, 'place.name'], [{ name: 'x', lat: 1, lon: 2, trigger: 'stay' }, 'place.trigger'],
      [{ name: 'x', lat: 1, lon: 2, key: 'kind:nope' }, 'place.key'], [{ name: 'x', lat: 1, lon: 200 }, 'place.lon'], [{ name: 'x', lat: 1, lon: 2, ref: 'osm:X1' }, 'place.ref'], [{ any: true, key: 'kind:diy', remember: true }, 'place.remember']]) {
      const bad = await h.call(ANNA, 'PATCH', 'tasks/' + t1.id, { place });
      assert.deepEqual([bad.status, bad.json.code, bad.json.field], [400, 'invalid', field], JSON.stringify(place));
    }
    assert.equal((await h.call(ANNA, 'PATCH', 'tasks/' + t1.id, { place: { placeId: 999 } })).status, 404);
    assert.equal((await h.call(ANNA, 'PATCH', 'tasks/' + t1.id, { place: { familyId: 'place:99' } })).status, 404);
    // a sub task has no place of its own
    const sub = (await h.ok(ANNA, 'POST', 'tasks', { title: 'Flaschen', parentId: t1.id, place: { name: 'x', lat: 1, lon: 2 } })).task;
    assert.equal(sub.place, null);
    // a repeating task: the next one hangs on the same place
    const rep = (await h.ok(ANNA, 'POST', 'tasks', { title: 'Wasser holen', due: { date: '2026-11-09' }, repeat: { type: 'weekly', interval: 1, days: [1] }, place: { familyId: 'place:3', trigger: 'exit' } })).task;
    const next = (await h.ok(ANNA, 'POST', `tasks/${rep.id}/complete`, { done: true })).next;
    assert.deepEqual([next.place.name, next.place.trigger, next.place.watch], ['Schule', 'exit', true]);
    // a member who may only look does not change the place
    const l = (await h.ok(ANNA, 'POST', 'lists', { name: 'Geteilt' })).list;
    await h.ok(ANNA, 'PUT', `lists/${l.id}/members`, { members: [{ id: LENA.id, role: 'read' }] });
    const shared = (await h.ok(ANNA, 'POST', 'tasks', { title: 'Brot', listId: l.id, place: { name: 'Bäcker', lat: 52.5, lon: 13.4 } })).task;
    assert.equal((await h.call(LENA, 'PATCH', 'tasks/' + shared.id, { place: null })).status, 403);
    assert.equal((await h.call(LENA, 'POST', `tasks/${shared.id}/place/skip`, { fence: 'p:' + shared.place.id })).status, 403);
    assert.equal((await h.call(LENA, 'POST', `tasks/${shared.id}/place/later`, {})).status, 403);
    // a place made offline is named by its clientId; an unknown one is refused until the place has arrived
    assert.deepEqual((await h.call(ANNA, 'POST', 'tasks', { title: 'Paket', place: { placeClientId: 'place-buero-0001' } })).json, { ok: false, code: 'unknown_client_id', field: 'place.placeClientId', clientId: 'place-buero-0001' });
    await h.ok(ANNA, 'POST', 'places', { name: 'Büro', lat: 52.6, lon: 13.5, clientId: 'place-buero-0001' });
    assert.deepEqual([(await h.ok(ANNA, 'POST', 'tasks', { title: 'Paket', place: { placeClientId: 'place-buero-0001' } })).task.place].map((x) => [x.name, x.own]), [['Büro', true]]);
    assert.equal((await task(h, LENA, shared.id)).place.watch, false, 'Lena sees the place; her phone does not watch it');
  } finally { await done(h); }
});

test('what a phone watches: the tasks\' places by urgency, the other places of a kind near, one fence per place, the budget', async () => {
  const h = await host();
  try {
    const hits = (await h.ok(ANNA, 'POST', 'places/search', { key: 'kind:diy', near: HOME })).results;
    const nord = hits[0];
    const mk = (title, extra, place) => h.ok(ANNA, 'POST', 'tasks', { title, ...extra, place }).then((r) => r.task);
    const a = await mk('Schrauben kaufen', {}, { ref: nord.ref, name: nord.name, address: nord.address, lat: nord.lat, lon: nord.lon, key: 'kind:diy' });
    const b = await mk('Farbe holen', { due: { date: '2026-11-08' } }, { ref: nord.ref, name: nord.name, address: nord.address, lat: nord.lat, lon: nord.lon, key: 'kind:diy' });
    const oma = (await h.ok(ANNA, 'POST', 'places', { name: 'Oma', lat: 52.4, lon: 13.2 })).place;
    const c = await mk('Leiter zurückgeben', { due: { date: '2026-11-07' }, important: true }, { placeId: oma.id });
    const d = await mk('Pfand wegbringen', {}, { any: true, key: 'name:lidl' });
    const e = await mk('Auto abholen', {}, { name: 'Werkstatt', lat: 52.51, lon: 13.39, trigger: 'exit' });
    // without a position: only the tasks' own places — the overdue one first, then the one due today, then the rest (newest first)
    const w0 = await h.ok(ANNA, 'POST', 'places/watch', {});
    assert.deepEqual(w0.fences.map((f) => [f.id, f.name, f.radius, f.transitions, f.tasks.map((x) => x.taskId)]), [
      ['p:' + oma.id, 'Oma', 150, ['enter'], [c.id]],
      ['osm:W101', 'Baumarkt Nord', 150, ['enter'], [b.id, a.id]],
      ['p:' + e.place.id, 'Werkstatt', 150, ['exit'], [e.id]]]);
    assert.deepEqual([w0.max, w0.perTask, w0.refreshM, w0.cell, w0.nearby, w0.dropped, w0.search], [60, 5, 3000, null, true, 0, 'on']);
    const first = w0.fences[1].tasks[1];
    assert.deepEqual(first, { taskId: a.id, listId: a.listId, area: 'private', title: 'Schrauben kaufen', kind: 'place', trigger: 'enter', planned: null, tag: `place:${a.id}:osm:W101`, important: false, due: null,
      notification: { title: 'Schrauben kaufen', body: 'Angekommen: Baumarkt Nord · Aufgaben', collapseKey: 'task:' + a.id, actions: [{ id: 'done', label: 'Erledigt' }, { id: 'later', label: 'Später' }] }, attachedList: null });
    assert.equal(w0.fences[2].tasks[0].notification.body, 'Verlassen: Werkstatt · Aufgaben');
    // with a position: the other Baumärkte for both tasks (one fence each), every Lidl for „Jeder Lidl“ — the nearest first
    const calls = h.net.calls.length;
    const w = await h.ok(ANNA, 'POST', 'places/watch', { near: HOME });
    assert.deepEqual(w.cell, CELL);
    assert.deepEqual(w.fences.map((f) => [f.id, f.radius, f.tasks.map((x) => [x.taskId, x.kind, x.planned])]), [
      ['p:' + oma.id, 150, [[c.id, 'place', null]]],
      ['osm:W101', 150, [[b.id, 'place', null], [a.id, 'place', null]]],
      ['p:' + e.place.id, 150, [[e.id, 'place', null]]],
      ['osm:N201', 150, [[d.id, 'place', null]]],
      ['osm:N202', 150, [[d.id, 'place', null]]],
      ['osm:W102', 300, [[b.id, 'nearby', 'Baumarkt Nord'], [a.id, 'nearby', 'Baumarkt Nord']]],
      ['osm:N103', 300, [[b.id, 'nearby', 'Baumarkt Nord'], [a.id, 'nearby', 'Baumarkt Nord']]]]);
    const near = w.fences[5].tasks[1];
    assert.deepEqual(near.notification, { title: 'Baumarkt am Ring ist gleich hier', body: 'Schrauben kaufen · geplant war Baumarkt Nord', collapseKey: 'task:' + a.id,
      actions: [{ id: 'done', label: 'Erledigt' }, { id: 'not_here', label: 'Nicht hier' }, { id: 'later', label: 'Später' }] });
    assert.equal(near.tag, `place:${a.id}:osm:W102`);
    // the searches behind it use a coarser cell and are few: the Baumärkte and the Lidls, once
    const sent = h.net.calls.slice(calls);
    assert.ok(sent.length >= 2 && sent.length <= 4, String(sent.length));
    assert.ok(sent.every((x) => !/52\.5203|13\.4051/.test(x.url)));
    await h.ok(ANNA, 'POST', 'places/watch', { near: { lat: 52.5231, lon: 13.4012 } });
    assert.equal(h.net.calls.length, calls + sent.length, 'a little further: from the cache');
    // the budget: the phone says what it has room for; the tasks' own places come first, `dropped` says what did not fit
    const cut = await h.ok(ANNA, 'POST', 'places/watch', { near: HOME, budget: 4 });
    assert.deepEqual([cut.max, cut.fences.map((f) => f.id), cut.dropped], [4, ['p:' + oma.id, 'osm:W101', 'p:' + e.place.id, 'osm:N201'], 3]);
    assert.deepEqual((await h.ok(ANNA, 'POST', 'places/watch', { near: HOME, budget: 0 })).fences, []);
    assert.equal((await h.call(ANNA, 'POST', 'places/watch', { budget: -1 })).status, 400);
    assert.equal((await h.call(ANNA, 'POST', 'places/watch', { near: { lat: 'x' } })).status, 400);
    // „Nicht hier“ takes one place away for one task; „in der Nähe“ switched off takes them all — „Jeder Lidl“ stays
    await h.ok(ANNA, 'POST', `tasks/${a.id}/place/skip`, { fence: 'osm:W102' });
    let now = await h.ok(ANNA, 'POST', 'places/watch', { near: HOME });
    assert.deepEqual(now.fences.find((f) => f.id === 'osm:W102').tasks.map((x) => x.taskId), [b.id]);
    assert.equal((await task(h, ANNA, a.id)).place.skipped, 1);
    await h.ok(ANNA, 'PUT', 'prefs', { places: { nearby: false } });
    now = await h.ok(ANNA, 'POST', 'places/watch', { near: HOME });
    assert.deepEqual([now.nearby, now.fences.map((f) => f.id)], [false, ['p:' + oma.id, 'osm:W101', 'p:' + e.place.id, 'osm:N201', 'osm:N202']]);
    // the person's search switched off: only the tasks' own places, nothing goes out
    await h.ok(ANNA, 'PUT', 'prefs', { places: { nearby: true, search: false } });
    search.reset(); search.state.pauseMs = 0;
    const n = h.net.calls.length;
    now = await h.ok(ANNA, 'POST', 'places/watch', { near: HOME });
    assert.deepEqual([now.search, now.nearby, now.fences.length], ['off', false, 3]);
    assert.equal(h.net.calls.length, n);
    // done: the task is gone from the list
    await h.ok(ANNA, 'POST', `tasks/${c.id}/complete`, { done: true });
    assert.ok(!(await h.ok(ANNA, 'POST', 'places/watch', {})).fences.some((f) => f.id === 'p:' + oma.id));
    // Marc has nothing to watch; nothing of Anna's reaches him
    assert.deepEqual((await h.ok(MARC, 'POST', 'places/watch', { near: HOME })).fences, []);
  } finally { await done(h); }
});

test('the budget is shared with Familie: what its phones watch comes off; an older Familie counts as the worst case', async () => {
  const h = await host({ fam: { reminders: 44 } });
  try {
    assert.equal((await h.ok(ANNA, 'POST', 'places/watch', {})).max, 45, '100 − 10 in reserve − 45 of Familie');
    h.fam.reminders = 69;
    assert.equal((await h.ok(ANNA, 'POST', 'places/watch', {})).max, 20);
    h.fam.reminders = 120;
    assert.equal((await h.ok(ANNA, 'POST', 'places/watch', {})).max, 0);
    h.fam.reminders = 0;
    assert.equal((await h.ok(ANNA, 'POST', 'places/watch', {})).max, 60, 'never more than 60');
  } finally { await done(h); }
  const old = await host({ fam: { noBudget: true } });
  try { assert.equal((await old.ok(ANNA, 'POST', 'places/watch', {})).max, 30); } finally { await done(old); }
  const none = await host({ noFamily: true });
  try {
    assert.equal((await none.ok(ANNA, 'POST', 'places/watch', {})).max, 60);
    assert.deepEqual((await none.ok(ANNA, 'GET', 'places')).family, []);
    assert.equal((await none.ok(ANNA, 'GET', 'me')).places.family, false);
  } finally { await done(none); }
});

test('a place fired: once per place and three hours, „in der Nähe“ once per task, quiet hours, „Später“, „Nicht hier“, done', async () => {
  const h = await host();
  try {
    const hits = (await h.ok(ANNA, 'POST', 'places/search', { key: 'kind:diy', near: HOME })).results;
    const nord = hits[0];
    const a = (await h.ok(ANNA, 'POST', 'tasks', { title: 'Schrauben kaufen', place: { ref: nord.ref, name: nord.name, lat: nord.lat, lon: nord.lon, key: 'kind:diy' } })).task;
    const fire = (fence, transition = 'enter', user = ANNA) => h.ok(user, 'POST', 'places/fired', { taskId: a.id, fence, transition });
    // the task's own place: the first device rings, the second one (same pocket) does not
    assert.deepEqual(await fire('osm:W101'), { ok: true, notify: true, kind: 'place' });
    assert.deepEqual(await fire('osm:W101'), { ok: true, notify: false, reason: 'recent' });
    assert.deepEqual(await fire('osm:W101', 'exit'), { ok: true, notify: false, reason: 'transition' });
    clock.set(T0 + places.REPEAT_MS + 1000);
    assert.equal((await fire('osm:W101')).notify, true, 'three hours later it reminds again');
    // another Baumarkt on the way: once per task, not at the next one right after
    assert.deepEqual(await fire('osm:W102'), { ok: true, notify: true, kind: 'nearby' });
    assert.deepEqual(await fire('osm:N103'), { ok: true, notify: false, reason: 'recent' });
    // „Nicht hier“
    await h.ok(ANNA, 'POST', `tasks/${a.id}/place/skip`, { fence: 'osm:N103' });
    clock.set(clock.now() + places.REPEAT_MS + 1000);
    assert.deepEqual(await fire('osm:N103'), { ok: true, notify: false, reason: 'skipped' });
    // quiet hours hold back only the hints on the way (22:30 in Berlin), not the task's own place
    clock.set(Date.parse('2026-11-09T21:30:00Z'));
    assert.deepEqual(await fire('osm:W102'), { ok: true, notify: false, reason: 'quiet' });
    assert.equal((await fire('osm:W101')).notify, true);
    await h.ok(ANNA, 'PUT', 'prefs', { places: { quiet: null } });
    assert.equal((await fire('osm:W102')).notify, true);
    // „Später“: three hours of rest for this task, or until a time
    clock.set(Date.parse('2026-11-10T10:00:00Z'));
    const l = await h.ok(ANNA, 'POST', `tasks/${a.id}/place/later`, {});
    assert.deepEqual(l, { ok: true, later: '2026-11-10T14:00:00+01:00', laterMs: clock.now() + places.LATER_MS });
    assert.equal((await task(h, ANNA, a.id)).place.later, '2026-11-10T14:00:00+01:00');
    assert.deepEqual(await fire('osm:W101'), { ok: true, notify: false, reason: 'later' });
    clock.set(clock.now() + places.LATER_MS + 1000);
    assert.equal((await fire('osm:W101')).notify, true);
    assert.equal((await h.call(ANNA, 'POST', `tasks/${a.id}/place/later`, { until: '2026-11-01T10:00:00Z' })).status, 400);
    // „in der Nähe“ switched off by the person
    await h.ok(ANNA, 'PUT', 'prefs', { places: { nearby: false } });
    clock.set(clock.now() + places.REPEAT_MS + 1000);
    assert.deepEqual(await fire('osm:W102'), { ok: true, notify: false, reason: 'off' });
    // someone else, a fence that is none, a task without a place, a task that is done
    assert.deepEqual(await fire('osm:W101', 'enter', MARC), { ok: true, notify: false, reason: 'gone' });
    assert.equal((await h.call(ANNA, 'POST', 'places/fired', { taskId: a.id, fence: 'somewhere', transition: 'enter' })).status, 400);
    assert.equal((await h.call(ANNA, 'POST', 'places/fired', { taskId: a.id, fence: 'osm:W101', transition: 'dwell' })).status, 400);
    const plain = (await h.ok(ANNA, 'POST', 'tasks', { title: 'ohne Ort' })).task;
    assert.deepEqual(await h.ok(ANNA, 'POST', 'places/fired', { taskId: plain.id, fence: 'osm:W101', transition: 'enter' }), { ok: true, notify: false, reason: 'gone' });
    assert.equal((await h.call(ANNA, 'POST', `tasks/${plain.id}/place/skip`, { fence: 'osm:W101' })).status, 400);
    await h.ok(ANNA, 'POST', `tasks/${a.id}/complete`, { done: true });
    assert.deepEqual(await fire('osm:W101'), { ok: true, notify: false, reason: 'done' });
    // what is kept of all this: which fence fired when — no position
    const row = await store.one(h.host.gc, 'SELECT place_state FROM tasks WHERE id = ?', [a.id]);
    assert.deepEqual(Object.keys(JSON.parse(row.place_state)).sort(), ['fired', 'hint', 'later', 'skip']);
    assert.ok(!/"lat"|"lon"|52\.|13\./.test(row.place_state));
  } finally { await done(h); }
});

test('a place for someone else: their phone watches it only after they agreed; a new place asks again', async () => {
  const h = await host();
  try {
    const l = (await h.ok(ANNA, 'POST', 'lists', { name: 'Familie' })).list;
    await h.ok(ANNA, 'PUT', `lists/${l.id}/members`, { members: [{ id: MARC.id, role: 'write' }] });
    h.host.notifications.length = 0;
    const t1 = (await h.ok(ANNA, 'POST', 'tasks', { title: 'Milch mitbringen', listId: l.id, assigneeId: MARC.id, place: { name: 'Lidl Marktstraße', lat: 52.526, lon: 13.416, key: 'name:lidl' } })).task;
    assert.deepEqual([t1.place.consent, t1.place.watch, t1.place.by], ['pending', false, ANNA.id]);
    const ask = h.host.notifications.find((n) => n.data && n.data.notizen && n.data.notizen.kind === 'place_consent');
    assert.deepEqual([ask.users, ask.topic, ask.title, ask.body], [[MARC.id], 'shared', 'Anna Berg möchte dich erinnern', 'Milch mitbringen · beim Ankommen an Lidl Marktstraße']);
    assert.deepEqual(ask.data.actions, [{ type: 'callback', id: 'place_accept', label: 'Annehmen' }, { type: 'callback', id: 'place_decline', label: 'Ablehnen' }]);
    assert.deepEqual(ask.data.notizen, { kind: 'place_consent', taskId: t1.id, listId: l.id, area: 'private', task: t1.id });
    // until then: Marc sees the task with its place, but his phone watches nothing — and Anna's neither
    assert.deepEqual([(await task(h, MARC, t1.id)).place.consent, (await task(h, MARC, t1.id)).place.watch], ['pending', false]);
    assert.deepEqual((await h.ok(MARC, 'POST', 'places/watch', {})).fences, []);
    assert.deepEqual((await h.ok(ANNA, 'POST', 'places/watch', {})).fences, []);
    assert.deepEqual(await h.ok(MARC, 'POST', 'places/fired', { taskId: t1.id, fence: 'p:' + t1.place.id, transition: 'enter' }), { ok: true, notify: false, reason: 'gone' });
    // only Marc answers; the button of the push
    assert.equal((await h.call(ANNA, 'POST', `tasks/${t1.id}/place/consent`, { accept: true })).status, 403);
    assert.deepEqual(await h.press(MARC, ask, 'place_accept'), { ok: true, consent: 'accepted' });
    assert.deepEqual((await h.ok(MARC, 'POST', 'places/watch', {})).fences.map((f) => [f.name, f.tasks[0].title]), [['Lidl Marktstraße', 'Milch mitbringen']]);
    assert.equal((await task(h, MARC, t1.id)).place.watch, true);
    assert.deepEqual(await h.press(ANNA, ask, 'place_accept'), { ok: false, code: 'forbidden' });
    // Anna moves the place: asked again
    h.host.notifications.length = 0;
    const moved = (await h.ok(ANNA, 'PATCH', 'tasks/' + t1.id, { place: { name: 'Lidl am Bahnhof', lat: 52.508, lon: 13.375, key: 'name:lidl' } })).task;
    assert.equal(moved.place.consent, 'pending');
    assert.equal(h.host.notifications.filter((n) => n.data && n.data.notizen && n.data.notizen.kind === 'place_consent').length, 1);
    assert.deepEqual(await h.ok(MARC, 'POST', `tasks/${t1.id}/place/consent`, { accept: false }), { ok: true, consent: 'declined' });
    assert.deepEqual((await h.ok(MARC, 'POST', 'places/watch', {})).fences, []);
    // Marc sets the place himself: no question
    const own = (await h.ok(MARC, 'PATCH', 'tasks/' + t1.id, { place: { name: 'Lidl Marktstraße', lat: 52.526, lon: 13.416 } })).task;
    assert.deepEqual([own.place.consent, own.place.watch], ['accepted', true]);
    // the task goes to Anna: it is her phone's now — the place was Marc's choice, so she is asked
    h.host.notifications.length = 0;
    const back = (await h.ok(MARC, 'PATCH', 'tasks/' + t1.id, { assigneeId: ANNA.id })).task;
    assert.deepEqual([back.place.consent, back.place.watch], ['pending', false]);
    assert.deepEqual(h.host.notifications.filter((n) => n.data.notizen.kind === 'place_consent').map((n) => n.users), [[ANNA.id]]);
  } finally { await done(h); }
});

test('a task with a place and a shopping list: the reminder at the place carries „Liste öffnen“; the morning hint names the place', async () => {
  const h = await host();
  try {
    const L = '6f1c2a90-1111-4c1d-9a00-000000000001';
    await h.ok(ANNA, 'POST', 'shopping/ops', { ops: [{ op: 'list_add', id: L, name: 'Einkauf', icon: 'cart' }, { op: 'item_add', id: '0a0b0c0d-0000-4000-8000-000000000001', listId: L, text: 'Milch' }, { op: 'item_add', id: '0a0b0c0d-0000-4000-8000-000000000002', listId: L, text: 'Brot' }] });
    const both = await h.ok(ANNA, 'POST', 'parse', { text: 'bei Lidl einkaufen' });
    assert.deepEqual([both.attach.via, both.attach.list.name, both.place.via, both.place.key], ['word', 'Einkauf', 'name', 'name:lidl']);
    const t1 = (await h.ok(ANNA, 'POST', 'tasks', { text: 'bei Lidl einkaufen', attach: 'auto', due: { date: '2026-11-08' }, place: { name: 'Lidl Marktstraße', lat: 52.526, lon: 13.416, ref: 'osm:N201', key: 'name:lidl' } })).task;
    assert.deepEqual([t1.title, t1.attachedList.name, t1.place.name], ['bei Lidl einkaufen', 'Einkauf', 'Lidl Marktstraße']);
    const e = (await h.ok(ANNA, 'POST', 'places/watch', {})).fences[0].tasks[0];
    assert.deepEqual(e.attachedList, { id: t1.attachedList.id, uid: L, name: 'Einkauf', open: 2, total: 2 });
    assert.deepEqual(e.notification, { title: 'bei Lidl einkaufen', body: 'Angekommen: Lidl Marktstraße · Einkauf · 2 Punkte', collapseKey: 'task:' + t1.id,
      actions: [{ id: 'open_list', label: 'Liste öffnen' }, { id: 'done', label: 'Erledigt' }] });
    // the next morning: never arrived — „Gestern offen geblieben“ says where
    const plain = (await h.ok(ANNA, 'POST', 'tasks', { title: 'Rezept abholen', due: { date: '2026-11-08' } })).task;
    h.host.notifications.length = 0;
    clock.set(Date.parse('2026-11-09T06:31:00Z'));
    await h.host.tick();
    const y = h.host.notifications.find((n) => n.data && n.data.notizen && n.data.notizen.kind === 'yesterday');
    assert.deepEqual(y.body.split('\n').sort(), ['Rezept abholen · Aufgaben', 'bei Lidl einkaufen · Lidl Marktstraße']);
    assert.deepEqual((await h.ok(ANNA, 'GET', 'yesterday')).items.map((x) => [x.id, x.place && x.place.name]).sort(), [[t1.id, 'Lidl Marktstraße'], [plain.id, null]].sort());
  } finally { await done(h); }
});

test('the hourly purge: places taken once and deleted ones go when no task and no choice needs them', async () => {
  const h = await host();
  try {
    const names = async () => (await store.all(h.host.gc, 'SELECT name FROM places ORDER BY id')).map((r) => r.name);
    const once = (await h.ok(ANNA, 'POST', 'tasks', { title: 'Einmal', place: { name: 'Irgendwo', lat: 52.5, lon: 13.4 } })).task;
    const used = (await h.ok(ANNA, 'POST', 'tasks', { title: 'Noch offen', place: { name: 'Werkstatt', lat: 52.51, lon: 13.39 } })).task;
    await h.ok(ANNA, 'POST', 'tasks', { title: 'Farbe', place: { name: 'Baumarkt Nord', lat: 52.539, lon: 13.424, ref: 'osm:W101', key: 'kind:diy', remember: true } });
    const office = (await h.ok(ANNA, 'POST', 'places', { name: 'Büro', lat: 52.6, lon: 13.5 })).place;
    const gone = (await h.ok(ANNA, 'POST', 'places', { name: 'Alte Wohnung', lat: 52.7, lon: 13.6 })).place;
    await h.ok(ANNA, 'PATCH', 'tasks/' + once.id, { place: null });
    await h.ok(ANNA, 'DELETE', 'places/' + gone.id);
    assert.equal(await places.purge(h.host.gc, clock.now()), 1, 'the deleted one at once');
    assert.deepEqual(await names(), ['Irgendwo', 'Werkstatt', 'Baumarkt Nord', 'Büro']);
    // a month later: the place taken once and not used any more goes; named, used and remembered ones stay
    assert.equal(await places.purge(h.host.gc, clock.now() + 31 * 86400000), 1);
    assert.deepEqual(await names(), ['Werkstatt', 'Baumarkt Nord', 'Büro']);
    assert.equal((await task(h, ANNA, used.id)).place.name, 'Werkstatt');
    assert.equal(office.named, true);
  } finally { await done(h); }
});
