'use strict';

// 1.30.0: „Meine Orte“ from GateControl's profile (gc.places version 1) — against the mock host's gc.places
// (tools/testing/mock-places.js). Names and places made up.
//
//   services places   includeProfile: the person's own profile places shown to the family, ref / source on every entry;
//                     without it the answer of before
//   reminders         ref 'profile:<id>' → point, radius and title from the profile; markUsed, reportUsage reminder;
//                     placesChanged moves the copy, a deleted place keeps it (missing); a point by hand drops the link
//   rules             placeId 'profile:<id>' (visibility family / all) → a linked rule place the phones watch; not in the
//                     parents' list, profilePlaces there and in rules/options; placesChanged moves it; reportUsage rule;
//                     gone with its last rule

const test = require('node:test');
const assert = require('node:assert/strict');
const { withFamily, ANNA, MARC, LENA, TIM, OMA } = require('./helpers');

const ARBEIT = { id: 12, userId: ANNA.id, name: 'Arbeit', icon: 'work', lat: 52.5101, lon: 13.3901, radiusM: 200, visibility: 'self' };
const VEREIN = { id: 13, userId: MARC.id, name: 'Sportverein', icon: 'gym', lat: 52.5401, lon: 13.4201, radiusM: 120, visibility: 'family' };
const OMA_HAUS = { id: 14, userId: OMA.id, name: 'Bei Oma', lat: 52.6, lon: 13.5, visibility: 'all' };
const ANNA_FAM = { id: 15, userId: ANNA.id, name: 'Büro Nord', lat: 52.55, lon: 13.35, radiusM: 2000, visibility: 'family' };
const PLACES = { places: [ARBEIT, VEREIN, OMA_HAUS, ANNA_FAM], families: [[ANNA.id, MARC.id, LENA.id, TIM.id]] };
const MSG = 'gatecontrol-messenger';
const call = (host, name, payload) => host.callService(name, { caller: MSG, user: null, payload });
const rows = async (host, sql, params) => (await host.gc.db.query(sql, params || [])).rows;

test('services places: includeProfile adds the person\'s own profile places shown to the family; without it as before', () => withFamily({ places: PLACES, settings: { lat: '52.52', lon: '13.405', mod_presence: true } }, async (host, { as }) => {
  const s = (await as(ANNA)('POST', '/presence/places', { name: 'Schule', lat: 52.5301, lon: 13.4101, radius: 300 })).json.place;
  const before = [{ id: 'home', name: 'Zuhause', lat: 52.52, lon: 13.405, radiusM: 150 }, { id: `place:${s.id}`, name: 'Schule', lat: 52.5301, lon: 13.4101, radiusM: 300 }];
  assert.deepEqual(await call(host, 'places', { userId: ANNA.id }), before);
  assert.deepEqual(await call(host, 'places', { userId: ANNA.id, includeProfile: false }), before);
  assert.deepEqual(await call(host, 'places', { userId: ANNA.id, includeProfile: true }), [
    { ...before[0], ref: 'home', source: 'familie' }, { ...before[1], ref: `place:${s.id}`, source: 'familie' },
    { id: 'profile:15', ref: 'profile:15', source: 'profile', name: 'Büro Nord', icon: 'pin', lat: 52.55, lon: 13.35, radiusM: 2000, visibility: 'family' },
  ], 'only her own and only family / all (Arbeit is „nur ich“, Marc\'s place is his)');
  assert.deepEqual((await call(host, 'places', { userId: MARC.id, includeProfile: true })).filter((p) => p.source === 'profile').map((p) => p.ref), ['profile:13']);
}));

test('place reminders: ref profile:<id> takes the profile\'s point; markUsed, reportUsage; placesChanged and missing', () => withFamily({ places: PLACES }, async (host, { as }) => {
  let r = await as(ANNA)('POST', '/places', { ref: 'profile:12', note: 'Ausweis abgeben', lat: 1, lon: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  let p = r.json.place;
  assert.deepEqual([p.title, p.lat, p.lon, p.radius, p.ref, p.missing], ['Arbeit', 52.5101, 13.3901, 200, 'profile:12', false]);
  assert.ok(host.places.all().find((x) => x.id === 12).lastUsedAt, 'markUsed');
  assert.deepEqual(host.places.usage(12), [{ plugin: 'gatecontrol-familie', kind: 'reminder', count: 1 }]);
  // Marc's family place for Tim; Oma's „all“ place too; a place Anna may not see, bad refs → invalid
  r = await as(ANNA)('POST', '/places', { ref: 'profile:13', title: 'Training', targetUserId: TIM.id });
  assert.deepEqual([r.status, r.json.place.title, r.json.place.radius, r.json.place.consent], [200, 'Training', 120, 'pending']);
  const training = r.json.place;
  assert.equal((await as(ANNA)('POST', '/places', { ref: 'profile:14' })).status, 200);
  for (const ref of ['profile:999', 'profile:0', 'place:3', 'home', 'profile:12 ', 12]) {
    assert.equal((await as(ANNA)('POST', '/places', { ref, title: 'X', lat: 52, lon: 13 })).json.code, 'invalid', JSON.stringify(ref));
  }
  assert.equal((await as(MARC)('POST', '/places', { ref: 'profile:12' })).json.code, 'invalid', 'Anna\'s „nur ich“ place is not Marc\'s to use');
  // the place moves: the copy follows, the consent stays
  await host.places.update(13, { lat: 52.545, lon: 13.425, radiusM: 400 });
  let list = (await as(ANNA)('GET', '/places')).json.places;
  p = list.find((x) => x.id === training.id);
  assert.deepEqual([p.lat, p.lon, p.radius, p.missing, p.consent], [52.545, 13.425, 400, false, 'pending']);
  // Marc hides it: the copy stays, missing; shown again → back
  await host.places.update(13, { visibility: 'self' });
  assert.equal((await as(ANNA)('GET', '/places')).json.places.find((x) => x.id === training.id).missing, true);
  await host.places.update(13, { visibility: 'family' });
  assert.equal((await as(ANNA)('GET', '/places')).json.places.find((x) => x.id === training.id).missing, false);
  // deleted: copy stays, missing
  const mine = list.find((x) => x.ref === 'profile:12');
  await host.places.remove(12);
  list = (await as(ANNA)('GET', '/places')).json.places;
  assert.deepEqual([list.find((x) => x.id === mine.id).lat, list.find((x) => x.id === mine.id).missing], [52.5101, true]);
  // a point set by hand drops the link; deleting a reminder lowers the count
  r = await as(ANNA)('PATCH', `/places/${training.id}`, { lat: 52.6, lon: 13.6 });
  assert.deepEqual([r.json.place.ref, r.json.place.lat, r.json.place.missing], [null, 52.6, false]);
  assert.deepEqual(host.places.usage(13), [], 'reportUsage 0 removes it');
  r = await as(ANNA)('PATCH', `/places/${training.id}`, { ref: 'profile:13' });
  assert.deepEqual([r.json.place.ref, r.json.place.lat], ['profile:13', 52.545]);
  assert.equal(host.places.usage(13)[0].count, 1);
  assert.equal((await as(ANNA)('DELETE', `/places/${training.id}`)).status, 200);
  assert.deepEqual(host.places.usage(13), []);
}));

test('rules: a profile place shown to the family as the rule\'s place — linked, watched, moved, reported, tidied', () => withFamily({ places: PLACES, settings: { mod_presence: true } }, async (host, { as, admin }) => {
  const QA = { type: 'notify', to: 'parents' };
  // what may be chosen: family / all places of members (and one's own shown to the family) — not Oma's (no member)
  let l = (await as(ANNA)('GET', '/presence/places')).json;
  assert.deepEqual([l.places, l.profilePlaces.map((p) => [p.ref, p.name, p.radius, p.ownerName, p.own])], [[], [['profile:15', 'Büro Nord', 2000, null, true], ['profile:13', 'Sportverein', 120, 'Marc', false]]]);
  assert.deepEqual((await as(ANNA)('GET', '/rules/options')).json.profilePlaces.map((p) => p.ref), ['profile:15', 'profile:13']);
  // „nur ich“ and Oma's are refused
  for (const placeId of ['profile:12', 'profile:14', 'profile:999', 'profile:x']) {
    const r = await as(ANNA)('POST', '/presence/rules', { trigger: 'place_enter', placeId, actions: [QA] });
    assert.deepEqual([r.json.code, r.json.field], ['invalid', 'placeId'], placeId);
  }
  let r = await as(ANNA)('POST', '/presence/rules', { name: 'Verein', trigger: 'place_enter', placeId: 'profile:13', userId: MARC.id, actions: [QA] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const rule = r.json.rule;
  assert.deepEqual([rule.placeName, rule.placeRef, rule.placeMissing], ['Sportverein', 'profile:13', false]);
  assert.equal((await as(ANNA)('GET', '/presence/places')).json.places.length, 0, 'not one of the parents\' places');
  assert.equal((await as(ANNA)('PATCH', `/presence/places/${rule.placeId}`, { name: 'X' })).json.code, 'not_found');
  assert.deepEqual(host.places.usage(13), [{ plugin: 'gatecontrol-familie', kind: 'rule', count: 1 }]);
  // the unified rules API: the same place again → the same linked place
  r = await as(ANNA)('POST', '/rules', { title: 'Verein verlassen', scope: 'house', trigger: { type: 'place_exit', placeId: 'profile:13', userId: null }, actions: [QA] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.rule.trigger.placeId, r.json.rule.trigger.placeRef], [rule.placeId, 'profile:13']);
  const second = r.json.rule;
  assert.equal(host.places.usage(13)[0].count, 2);
  // the phones watch it
  assert.equal((await as(MARC)('PUT', '/presence/consent', { places: true })).status, 200);
  let w = (await as(MARC)('GET', '/presence/watch')).json.places;
  assert.deepEqual(w.map((x) => [x.id, x.name, x.lat, x.radius, x.transitions]), [[rule.placeId, 'Sportverein', 52.5401, 120, ['enter', 'exit']]]);
  // Marc moves it: the watch list follows; hidden → the copy stays, missing
  await host.places.update(13, { lat: 52.55, radiusM: 250, name: 'Verein' });
  w = (await as(MARC)('GET', '/presence/watch')).json.places;
  assert.deepEqual(w.map((x) => [x.name, x.lat, x.radius]), [['Verein', 52.55, 250]]);
  await host.places.update(13, { visibility: 'self' });
  let rl = (await as(ANNA)('GET', '/presence/rules')).json.rules.find((x) => x.id === rule.id);
  assert.deepEqual([rl.placeMissing, rl.placeName], [true, 'Verein']);
  assert.equal((await as(MARC)('GET', '/presence/watch')).json.places[0].lat, 52.55);
  await host.places.update(13, { visibility: 'all' });
  rl = (await as(ANNA)('GET', '/presence/rules')).json.rules.find((x) => x.id === rule.id);
  assert.equal(rl.placeMissing, false);
  // a place event at the linked place works as with any rule place
  r = await as(MARC)('POST', `/presence/places/${rule.placeId}/event`, { transition: 'enter' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  // another place for the rule: the old link stays while the second rule uses it; then it goes
  r = await as(ANNA)('PATCH', `/presence/rules/${rule.id}`, { placeId: 'profile:15' });
  assert.deepEqual([r.status, r.json.rule.placeRef], [200, 'profile:15']);
  assert.deepEqual([host.places.usage(13)[0].count, host.places.usage(15)[0].count], [1, 1]);
  assert.equal((await as(ANNA)('DELETE', `/rules/${second.id}`)).status, 200);
  assert.deepEqual(host.places.usage(13), []);
  assert.deepEqual((await rows(host, 'SELECT profile_ref FROM rule_places ORDER BY id')).map((x) => x.profile_ref), ['profile:15'], 'the unused link went');
  // the admin page lists the choosable places for the administrator (no member: only „all“ places of members)
  const a = (await admin('GET', 'presence')).json;
  assert.ok(Array.isArray(a.profilePlaces));
}));
