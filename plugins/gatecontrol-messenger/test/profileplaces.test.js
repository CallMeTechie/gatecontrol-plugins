'use strict';

// 1.28.0: „Meine Orte“ from GateControl's profile (gc.places version 1) — against the mock host's gc.places
// (tools/testing/mock-places.js). Names and places made up.
//
//   GET places       own profile places + Familie's places, each with ref / source, sorted for the chips (most used here
//                    in 90 days, last used, name); familie/places unchanged; features.profilePlaces
//   place messages   place.ref 'profile:<id>' resolved on the server (the profile's point, not the app's), markUsed,
//                    reportUsage location_message (the plugin's total per place), refs only as the person may see them,
//                    the ref pattern; placesChanged → the copy follows (place_messages.changed), a deleted place keeps
//                    the copy with place.missing
//   arrival          dest.ref 'profile:<id>': label and point from the profile; placesChanged moves a live arrival

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, app, ANNA, MARC, LENA, DAY } = require('./helpers');

const ARBEIT = { id: 12, userId: ANNA.id, name: 'Arbeit', icon: 'work', lat: 50.110922, lon: 8.682127, radiusM: 200, address: 'Hafenstraße 4, Musterstadt' };
const STUDIO = { id: 13, userId: ANNA.id, name: 'Fitnessstudio', icon: 'gym', lat: 50.12, lon: 8.69, radiusM: 60 };
const OMA_HAUS = { id: 20, userId: MARC.id, name: 'Bei Oma', icon: 'family', lat: 50.3, lon: 8.5, radiusM: 300, visibility: 'family' };
const MARC_GEHEIM = { id: 21, userId: MARC.id, name: 'Geheim', lat: 50.4, lon: 8.4, visibility: 'self' };
const PLACES = { places: [ARBEIT, STUDIO, OMA_HAUS, MARC_GEHEIM], families: [[ANNA.id, MARC.id]] };
const familie = (calls = []) => ({
  plugin: 'gatecontrol-familie', provides: ['places'],
  service: async (x) => { calls.push(x); return [{ id: 'home', name: 'Zuhause', lat: 50.05, lon: 8.6, radiusM: 150 }, { id: 'place:3', name: 'Grundschule', lat: 50.06, lon: 8.61, radiusM: 150 }]; },
});
const DEV = 'pixel-anna-01';
const pm = (convId, place, extra = {}) => ({ deviceId: DEV, trigger: 'enter', place, text: 'Bin angekommen.', conversationId: convId, ...extra });
const tick = () => new Promise((r) => setImmediate(r));

test('GET places: own profile places and Familie places with ref and source; chips order by use here', async () => {
  const calls = [];
  await withHost({ gatecontrol: '1.178.0', places: PLACES, services: [familie(calls)] }, async (host, c) => {
    const me = c.as(ANNA);
    assert.equal((await me('GET', 'me')).json.features.profilePlaces, true);
    let r = await me('GET', 'places');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.sources, { profile: true, familie: true });
    assert.deepEqual(r.json.places.map((p) => [p.ref, p.source, p.name]), [
      ['profile:12', 'profile', 'Arbeit'], ['profile:13', 'profile', 'Fitnessstudio'], ['place:3', 'familie', 'Grundschule'], ['home', 'familie', 'Zuhause'],
    ], 'nothing used yet: by name; Marc\'s family place is not one of Anna\'s own');
    const a = r.json.places[0];
    assert.deepEqual([a.id, a.icon, a.lat, a.lon, a.radiusM, a.address, a.visibility, a.lastUsedAt, a.usageCount], [12, 'work', 50.110922, 8.682127, 200, 'Hafenstraße 4, Musterstadt', 'self', null, 0]);
    assert.deepEqual([r.json.places[3].icon, r.json.places[3].id, r.json.places[3].address], ['home', 'home', null]);
    // the conversation for the place messages
    const g = await c.direct(ANNA, MARC);
    for (const place of [{ ref: 'home', name: 'Zuhause', lat: 50.05, lon: 8.6 }, { ref: 'profile:13' }, { ref: 'profile:13' }]) {
      assert.equal((await me('POST', 'place-messages', pm(g.id, place))).status, 200);
      c.clock.add(1000);
    }
    r = await me('GET', 'places');
    assert.deepEqual(r.json.places.map((p) => [p.ref, p.usageCount]), [['profile:13', 2], ['home', 1], ['profile:12', 0], ['place:3', 0]]);
    assert.ok(r.json.places[0].lastUsedAt && r.json.places[1].lastUsedAt);
    // uses older than 90 days do not count (and go with the clean-up)
    c.clock.add(91 * DAY);
    await host.tick();
    assert.deepEqual((await me('GET', 'places')).json.places.map((p) => p.usageCount), [0, 0, 0, 0]);
    // familie/places stays as it was
    r = await me('GET', 'familie/places');
    assert.deepEqual(r.json.places.map((p) => p.id), ['home', 'place:3']);
  });
  // without gc.places (an older GateControl) and without Familie: an empty picker, no feature word
  await withHost({}, async (host, c) => {
    const r = await c.as(ANNA)('GET', 'places');
    assert.deepEqual([r.status, r.json.places, r.json.sources], [200, [], { profile: false, familie: false }]);
    assert.equal((await c.as(ANNA)('GET', 'me')).json.features.profilePlaces, undefined);
  });
});

test('place messages: ref profile:<id> takes the profile\'s point, markUsed, reportUsage; visibility and the ref pattern', async () => {
  await withHost({ places: PLACES }, async (host, c) => {
    const me = c.as(ANNA);
    const g = await c.direct(ANNA, MARC);
    let r = await me('POST', 'place-messages', pm(g.id, { ref: 'profile:12', name: 'Büro', lat: 1, lon: 1, radiusM: 2000 }));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const p = r.json.placeMessage;
    assert.deepEqual(p.place, { ref: 'profile:12', source: 'profile', familieId: null, name: 'Büro', lat: 50.110922, lon: 8.682127, radiusM: 200, missing: false },
      'point and radius from the profile, the app\'s name stays');
    await tick();
    assert.ok(host.places.all().find((x) => x.id === 12).lastUsedAt, 'markUsed');
    assert.deepEqual(host.places.usage(12), [{ plugin: 'gatecontrol-messenger', kind: 'location_message', count: 1 }]);
    // without a name: the profile's; a radius below 100 m goes up to 100
    r = await me('POST', 'place-messages', pm(g.id, { ref: 'profile:13' }));
    assert.deepEqual([r.json.placeMessage.place.name, r.json.placeMessage.place.radiusM], ['Fitnessstudio', 100]);
    const second = r.json.placeMessage.id;
    // a family member's place shared with the family counts; reportUsage sums the whole plugin
    r = await me('POST', 'place-messages', pm(g.id, { ref: 'profile:20' }));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    r = await c.as(MARC)('POST', 'place-messages', pm(g.id, { ref: 'profile:20' }));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    await tick();
    assert.deepEqual(host.places.usage(20), [{ plugin: 'gatecontrol-messenger', kind: 'location_message', count: 2 }]);
    // not visible / unknown / bad pattern → invalid, nothing kept
    for (const ref of ['profile:21', 'profile:999', 'profile:0', 'profile:', 'profile:12a', 'Profile:12', 'profile: 12', 'profile:12:1', 'place:x', 'homes', 12, true]) {
      assert.equal((await me('POST', 'place-messages', pm(g.id, { ref, name: 'X', lat: 50, lon: 8 }))).json.code, 'invalid', JSON.stringify(ref));
    }
    assert.equal((await c.as(LENA)('POST', 'place-messages', pm((await c.direct(LENA, MARC)).id, { ref: 'profile:20' }))).json.code, 'invalid', 'Lena is not in the family');
    // change to another place: both counts follow; delete
    r = await me('PUT', `place-messages/${second}`, { place: { ref: 'profile:12' } });
    assert.deepEqual([r.json.placeMessage.place.ref, r.json.placeMessage.place.name], ['profile:12', 'Arbeit']);
    await tick();
    assert.deepEqual([host.places.usage(12)[0].count, host.places.usage(13)], [2, []]);
    assert.equal((await me('DELETE', `place-messages/${p.id}`)).status, 200);
    await tick();
    assert.equal(host.places.usage(12)[0].count, 1);
    // an older app: the ref as familieId; a Familie ref gives the familieId
    r = await me('POST', 'place-messages', pm(g.id, { familieId: 'profile:13', name: 'Studio', lat: 1, lon: 1 }));
    assert.deepEqual([r.json.placeMessage.place.ref, r.json.placeMessage.place.lat, r.json.placeMessage.place.familieId], ['profile:13', 50.12, 'profile:13']);
    r = await me('POST', 'place-messages', pm(g.id, { ref: 'place:3', name: 'Grundschule', lat: 50.06, lon: 8.61 }));
    assert.deepEqual([r.json.placeMessage.place.ref, r.json.placeMessage.place.source, r.json.placeMessage.place.familieId], ['place:3', 'familie', 'place:3']);
  });
});

test('place messages: placesChanged moves the copy (place_messages.changed), a deleted place keeps it with missing', async () => {
  await withHost({ places: PLACES }, async (host, c) => {
    const me = c.as(ANNA);
    const g = await c.direct(ANNA, MARC);
    const a = (await me('POST', 'place-messages', pm(g.id, { ref: 'profile:12' }))).json.placeMessage;
    const b = (await me('POST', 'place-messages', pm(g.id, { ref: 'profile:20' }))).json.placeMessage;
    const other = (await me('POST', 'place-messages', pm(g.id, { name: 'Park', lat: 50.2, lon: 8.2 }))).json.placeMessage;
    c.resetEvents();
    await host.places.update(12, { lat: 50.2, lon: 8.7, radiusM: 400, name: 'Büro' });
    let l = (await me('GET', 'place-messages')).json.placeMessages;
    assert.deepEqual(l.find((x) => x.id === a.id).place, { ref: 'profile:12', source: 'profile', familieId: null, name: 'Büro', lat: 50.2, lon: 8.7, radiusM: 400, missing: false });
    assert.deepEqual(c.events('place_messages.changed').map((e) => [e.data.id, e.data.reason, e.data.place, e.users]), [[a.id, 'updated', true, [ANNA.id]]]);
    assert.deepEqual(l.find((x) => x.id === other.id).place.lat, 50.2, 'others untouched');
    // the same again: nothing changes, no event
    c.resetEvents();
    await host.places.changed(ANNA.id, [12], false);
    assert.deepEqual(c.events('place_messages.changed'), []);
    // Marc no longer shares his place: Anna's copy holds, missing
    await host.places.update(20, { visibility: 'self' });
    l = (await me('GET', 'place-messages')).json.placeMessages;
    assert.deepEqual([l.find((x) => x.id === b.id).place.missing, l.find((x) => x.id === b.id).place.lat], [true, 50.3]);
    // shared again → back
    await host.places.update(20, { visibility: 'family', lat: 50.31 });
    l = (await me('GET', 'place-messages')).json.placeMessages;
    assert.deepEqual([l.find((x) => x.id === b.id).place.missing, l.find((x) => x.id === b.id).place.lat], [false, 50.31]);
    // deleted: the copy stays, missing; choosing a place again clears it
    c.resetEvents();
    await host.places.remove(12);
    l = (await me('GET', 'place-messages')).json.placeMessages;
    assert.deepEqual(l.find((x) => x.id === a.id).place, { ref: 'profile:12', source: 'profile', familieId: null, name: 'Büro', lat: 50.2, lon: 8.7, radiusM: 400, missing: true });
    assert.deepEqual(c.events('place_messages.changed').map((e) => [e.data.id, e.data.place]), [[a.id, true]]);
    const r = await me('PUT', `place-messages/${a.id}`, { place: { ref: 'profile:13' } });
    assert.deepEqual([r.json.placeMessage.place.ref, r.json.placeMessage.place.missing], ['profile:13', false]);
  });
});

test('arrival: dest.ref profile:<id> — label and point from the profile; placesChanged moves a live arrival', async () => {
  await withHost({ places: PLACES }, async (host, c) => {
    const g = await c.direct(ANNA, MARC);
    const m = await c.send(ANNA, g.id, { kind: 'arrival', arrival: { dest: { ref: 'profile:12' } } });
    assert.deepEqual(m.arrival.dest, { label: 'Arbeit', lat: 50.110922, lon: 8.682127, radiusM: 200, ref: 'profile:12' });
    const gl = await c.direct(ANNA, LENA);
    const m2 = await c.send(ANNA, gl.id, { kind: 'arrival', arrival: { dest: { ref: 'profile:13', label: 'Sport', lat: 1, lon: 1, radiusM: 500 } } });
    assert.deepEqual(m2.arrival.dest, { label: 'Sport', lat: 50.12, lon: 8.69, radiusM: 500, ref: 'profile:13' }, 'the profile\'s point, the sender\'s label and radius');
    const bad = await c.call(app(ANNA), 'POST', `conversations/${g.id}/messages`, { clientId: c.cid(), kind: 'arrival', arrival: { dest: { ref: 'profile:21' } } });
    assert.equal(bad.json.code, 'invalid');
    c.resetEvents();
    await host.places.update(12, { lat: 50.2, lon: 8.7, radiusM: 300 });
    const msgs = (await c.as(MARC)('GET', `conversations/${g.id}/messages`)).json.messages;
    assert.deepEqual(msgs.find((x) => x.id === m.id).arrival.dest, { label: 'Arbeit', lat: 50.2, lon: 8.7, radiusM: 300, ref: 'profile:12' });
    assert.deepEqual(c.events('arrival.update').map((e) => [e.data.messageId, e.data.state]), [[m.id, 'live']]);
    // arrived at the new point
    const r = await c.as(ANNA)('POST', `messages/${m.id}/arrival`, { lat: 50.2, lon: 8.7 });
    assert.equal(r.json.arrived, true);
    await host.places.remove(13);
    const d2 = (await c.as(LENA)('GET', `conversations/${gl.id}/messages`)).json.messages.find((x) => x.id === m2.id).arrival.dest;
    assert.equal(d2.missing, true);
  });
});
