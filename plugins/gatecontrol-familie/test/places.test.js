'use strict';

// Place reminders: own reminders are accepted at once; a reminder for
// someone else asks for consent (push), a change asks again; triggered by
// the target's app: action 'tell' pushes to the chosen people, repeat
// 'once' deactivates, everything is logged; owner/target rights; 50 active
// places per person.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withFamily, ANNA, MARC, LENA, TIM, MIN, pushes } = require('./helpers');

const SCHOOL = { title: 'Schule', lat: 52.5301, lon: 13.4102, radius: 150 };

test('own reminder: accepted, the shape of the contract; validation', () => withFamily({}, async (host, { as }) => {
  const r = await as(MARC)('POST', '/places', { ...SCHOOL, title: 'Apotheke', note: 'Rezept abholen', trigger: 'enter', action: 'note' });
  assert.equal(r.status, 200);
  const p = r.json.place;
  assert.deepEqual(
    { ownerId: p.ownerId, targetUserId: p.targetUserId, title: p.title, note: p.note, lat: p.lat, lon: p.lon, radius: p.radius, trigger: p.trigger, action: p.action, listId: p.listId, tellUserIds: p.tellUserIds, repeat: p.repeat, active: p.active, consent: p.consent },
    { ownerId: MARC.id, targetUserId: MARC.id, title: 'Apotheke', note: 'Rezept abholen', lat: 52.5301, lon: 13.4102, radius: 150, trigger: 'enter', action: 'note', listId: null, tellUserIds: [], repeat: 'always', active: true, consent: 'accepted' },
  );
  assert.equal(pushes(host).length, 0);
  for (const bad of [{ ...SCHOOL, radius: 49 }, { ...SCHOOL, radius: 2001 }, { ...SCHOOL, lat: 95 }, { ...SCHOOL, trigger: 'near' }, { ...SCHOOL, action: 'list' },
    { ...SCHOOL, action: 'list', listId: 'ffffffff-none' }, { ...SCHOOL, action: 'tell', tellUserIds: [] }, { ...SCHOOL, targetUserId: 99 }, { ...SCHOOL, title: '' }]) {
    assert.equal((await as(MARC)('POST', '/places', bad)).json.code, 'invalid', JSON.stringify(bad));
  }
  await as(MARC)('POST', '/shopping/ops', { ops: [{ op: 'list_add', id: 'list-rewe-0001', name: 'REWE' }] });
  const l = await as(MARC)('POST', '/places', { ...SCHOOL, title: 'REWE', action: 'list', listId: 'list-rewe-0001' });
  assert.equal(l.json.place.listId, 'list-rewe-0001');
  assert.deepEqual((await as(MARC)('GET', '/places')).json.places.map((x) => x.title), ['Apotheke', 'REWE']);
  assert.deepEqual((await as(ANNA)('GET', '/places')).json.places, [], 'only owner or target');
}));

test('a reminder for someone else: consent pending + push; accept / decline; a change asks again', () => withFamily({}, async (host, { as }) => {
  const r = await as(ANNA)('POST', '/places', { ...SCHOOL, targetUserId: TIM.id, trigger: 'exit', action: 'tell', tellUserIds: [ANNA.id, MARC.id], repeat: 'always' });
  const id = r.json.place.id;
  assert.equal(r.json.place.consent, 'pending');
  const c = pushes(host, 'place_consent');
  assert.deepEqual(c.map((x) => [x.topic, x.users, x.title]), [['places', [TIM.id], 'Anna möchte dich erinnern: Schule']]);
  assert.deepEqual(c[0].data.familie, { type: 'place_consent', placeId: id });
  assert.equal((await as(TIM)('GET', '/places')).json.places[0].ownerName, 'Anna', 'the target sees it');
  assert.equal((await as(ANNA)('POST', `/places/${id}/consent`, { accept: true })).json.code, 'forbidden', 'only the target');
  assert.equal((await as(LENA)('POST', `/places/${id}/consent`, { accept: true })).status, 404);
  assert.equal((await as(TIM)('POST', `/places/${id}/consent`, { accept: 'ja' })).json.code, 'invalid');
  assert.equal((await as(TIM)('POST', `/places/${id}/consent`, { accept: true })).json.place.consent, 'accepted');
  assert.equal((await as(TIM)('PATCH', `/places/${id}`, { radius: 300 })).json.code, 'forbidden', 'only the owner edits');
  const p = await as(ANNA)('PATCH', `/places/${id}`, { radius: 300 });
  assert.deepEqual([p.json.place.radius, p.json.place.consent], [300, 'pending']);
  assert.equal(pushes(host, 'place_consent').length, 2);
  const off = await as(ANNA)('PATCH', `/places/${id}`, { active: false });
  assert.deepEqual([off.json.place.active, off.json.place.consent], [false, 'pending'], 'switching off needs no new consent');
  assert.equal(pushes(host, 'place_consent').length, 2);
  assert.equal((await as(TIM)('POST', `/places/${id}/consent`, { accept: false })).json.place.consent, 'declined');
  assert.equal((await as(TIM)('DELETE', `/places/${id}`)).status, 200, 'the target may delete');
  assert.equal((await as(ANNA)('GET', '/places')).json.places.length, 0);
}));

test('triggered: tell pushes to the chosen people; once → inactive; always logged; repeats within a minute told once', () => withFamily({}, async (host, { as, admin, clock }) => {
  const r = await as(ANNA)('POST', '/places', { ...SCHOOL, targetUserId: TIM.id, trigger: 'exit', action: 'tell', tellUserIds: [ANNA.id, MARC.id, TIM.id] });
  const id = r.json.place.id;
  const early = await as(TIM)('POST', `/places/${id}/triggered`, { transition: 'exit', at: '2026-10-14T07:59:00Z' });
  assert.deepEqual([early.json.told, pushes(host, 'place_tell').length], [0, 0], 'not accepted yet: logged only');
  await as(TIM)('POST', `/places/${id}/consent`, { accept: true });
  clock.add(2 * MIN);
  assert.equal((await as(ANNA)('POST', `/places/${id}/triggered`, { transition: 'exit' })).json.code, 'forbidden', 'only the target\'s app');
  assert.equal((await as(TIM)('POST', `/places/${id}/triggered`, { transition: 'leave' })).json.code, 'invalid');
  const t = await as(TIM)('POST', `/places/${id}/triggered`, { transition: 'exit', at: '2026-10-14T08:01:30Z' });
  assert.equal(t.json.told, 2);
  assert.equal(t.json.place.lastTriggeredAt, '2026-10-14T08:01:30Z');
  const tell = pushes(host, 'place_tell');
  assert.deepEqual(tell.map((x) => [x.topic, x.users.sort(), x.title]), [['places', [ANNA.id, MARC.id], 'Tim hat „Schule“ verlassen']]);
  assert.deepEqual(tell[0].data.familie, { type: 'place_tell', placeId: id, userId: TIM.id, transition: 'exit' });
  const dup = await as(TIM)('POST', `/places/${id}/triggered`, { transition: 'exit', at: '2026-10-14T08:01:50Z' });
  assert.deepEqual([dup.json.told, dup.json.repeated], [0, true]);
  const enter = await as(TIM)('POST', `/places/${id}/triggered`, { transition: 'enter' });
  assert.equal(enter.json.told, 0, 'not the trigger of this place: logged only');
  // repeat once
  const once = (await as(TIM)('POST', '/places', { ...SCHOOL, title: 'Training', trigger: 'enter', action: 'tell', tellUserIds: [ANNA.id], repeat: 'once' })).json.place;
  assert.equal(once.consent, 'accepted');
  const o = await as(TIM)('POST', `/places/${once.id}/triggered`, { transition: 'enter' });
  assert.deepEqual([o.json.told, o.json.place.active], [1, false]);
  assert.equal(pushes(host, 'place_tell')[1].title, 'Tim ist bei „Training“ angekommen');
  const log = await admin('GET', 'log', null, { kind: 'place' });
  assert.equal(log.json.entries.length, 5, 'every transition logged');
  assert.ok(log.json.entries.every((e) => !('position' in e)), 'no coordinates in the place log');
}));

test('at most 50 active places per person', () => withFamily({}, async (host, { as }) => {
  for (let i = 0; i < 50; i++) {
    const r = await as(LENA)('POST', '/places', { ...SCHOOL, title: 'Ort ' + i });
    assert.equal(r.status, 200, String(i));
  }
  const full = await as(LENA)('POST', '/places', { ...SCHOOL, title: 'Ort 51' });
  assert.deepEqual([full.status, full.json.code], [409, 'too_many_places']);
  assert.equal((await as(ANNA)('POST', '/places', { ...SCHOOL, targetUserId: LENA.id })).json.code, 'too_many_places', 'also for reminders from others');
  assert.equal((await as(LENA)('POST', '/places', { ...SCHOOL, title: 'inaktiv', active: false })).status, 200, 'inactive ones do not count');
  const first = (await as(LENA)('GET', '/places')).json.places[0];
  await as(LENA)('PATCH', `/places/${first.id}`, { active: false });
  assert.equal((await as(LENA)('POST', '/places', { ...SCHOOL, title: 'Ort 51' })).status, 200);
}));
