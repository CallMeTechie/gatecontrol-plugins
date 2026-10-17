'use strict';

// Places as triggers for presence rules (1.5.0, module presence): rule places
// (parents, admin page; ≤ 20, unique names, in use), the own consent for
// places next to share, the phone's watch list (consent, active rules, anyone
// vs. a person, union of transitions, a version), place events (fire through
// throttle and conditions, person filter, repeats, late events, no consent,
// module off), rule validation, notification texts with {place}, the log.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { withFamily, ADMIN, ANNA, MARC, LENA, TIM, MIN, DAY, portal, pushes } = require('./helpers');
const presence = require('../server/presence');

const SH = 'gatecontrol-smarthome';
/** A smart home plugin with one scene for Anna and the administrator; runs are recorded. */
function smarthome(log) {
  return [{
    plugin: SH, pluginName: 'Smart Home',
    quickActions: (viewer) => (viewer.id === ANNA.id || viewer.id === ADMIN.id ? [{ id: 'scene:home', title: 'Heizung 21 °C' }] : []),
    runQuickAction: (viewer, id) => { log.push({ viewer, id }); return { ok: true, message: 'Szene gestartet' }; },
  }];
}
const ON = (log = [], settings = {}) => ({ settings: { mod_presence: true, ...settings }, actions: smarthome(log) });
const QA = { type: 'quick_action', plugin: SH, id: 'scene:home', title: 'Heizung 21 °C' };
const SCHULE = { name: 'Schule', lat: 52.5301, lon: 13.4101, radius: 150 };
const HOME = { name: 'Zuhause', lat: 52.52, lon: 13.405, radius: 500 };
/** Rows straight from the plugin's database. */
const rows = async (host, sql, params) => (await host.gc.db.query(sql, params || [])).rows;
const count = async (host, sql, params) => (await host.gc.db.get(sql, params || [])).row.n;
const version = (places) => crypto.createHash('sha1').update(JSON.stringify(places)).digest('hex').slice(0, 12);

async function agree(as, ...users) {
  for (const u of users) assert.equal((await as(u)('PUT', '/presence/consent', { places: true })).status, 200);
}
async function place(as, body) {
  const r = await as(ANNA)('POST', '/presence/places', body);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.place;
}
async function rule(as, body) {
  const r = await as(ANNA)('POST', '/presence/rules', body);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.rule;
}

test('rule places: parents only, validation, unique names, default radius, at most 20, in use, the admin page', () => withFamily(ON([], { lat: '52.52', lon: '13.405' }), async (host, { as, admin, clock }) => {
  assert.equal((await as(TIM)('GET', '/presence/places')).json.code, 'parents_only');
  assert.equal((await as(LENA)('POST', '/presence/places', SCHULE)).json.code, 'parents_only');
  assert.deepEqual((await as(MARC)('GET', '/presence/places')).json, { ok: true, places: [], home: { lat: 52.52, lon: 13.405 } });
  for (const [bad, field] of [
    [{ ...SCHULE, name: '' }, 'name'], [{ ...SCHULE, name: '   ' }, 'name'], [{ ...SCHULE, name: 'x'.repeat(41) }, 'name'], [{ ...SCHULE, name: 7 }, 'name'],
    [{ ...SCHULE, lat: 91 }, 'lat'], [{ ...SCHULE, lat: '52.5' }, 'lat'], [{ ...SCHULE, lon: -180.5 }, 'lon'], [{ name: 'Schule', lat: 52 }, 'lon'],
    [{ ...SCHULE, radius: 49 }, 'radius'], [{ ...SCHULE, radius: 5001 }, 'radius'], [{ ...SCHULE, radius: 120.5 }, 'radius'], [{ ...SCHULE, radius: '200' }, 'radius'],
  ]) {
    const r = await as(ANNA)('POST', '/presence/places', bad);
    assert.deepEqual([r.status, r.json.code, r.json.field], [400, 'invalid', field], JSON.stringify(bad));
  }
  const s = await place(as, { name: '  Schule\u0007 Nord ', lat: 52.5301, lon: 13.4101 });
  assert.deepEqual(s, { id: s.id, name: 'Schule Nord', lat: 52.5301, lon: 13.4101, radius: 200, rules: 0, createdAt: '2026-10-14T08:00:00Z', updatedAt: '2026-10-14T08:00:00Z' }, 'trimmed, control characters removed, radius 200');
  const dup = await as(MARC)('POST', '/presence/places', { ...SCHULE, name: 'SCHULE nord' });
  assert.deepEqual([dup.status, dup.json.code], [409, 'name_taken']);
  clock.add(MIN);
  const p = (await as(MARC)('PATCH', `/presence/places/${s.id}`, { radius: 5000, name: 'Schule' })).json.place;
  assert.deepEqual([p.name, p.radius, p.lat, p.updatedAt], ['Schule', 5000, 52.5301, '2026-10-14T08:01:00Z'], 'any subset');
  assert.equal((await as(MARC)('PATCH', `/presence/places/${s.id}`, { name: 'schule' })).json.place.name, 'schule', 'the own name in other letters');
  assert.equal((await as(MARC)('PATCH', `/presence/places/${s.id}`, { lat: -91 })).json.field, 'lat');
  assert.equal((await as(MARC)('PATCH', '/presence/places/999', { radius: 100 })).status, 404);
  // in use: not deletable, the rules named (an unnamed rule by its number)
  const r1 = await rule(as, { name: 'Ankommen', trigger: 'place_enter', placeId: s.id, actions: [QA] });
  const r2 = await rule(as, { trigger: 'place_exit', placeId: s.id, active: false, actions: [{ type: 'notify', to: 'parents' }] });
  assert.equal((await as(ANNA)('GET', '/presence/places')).json.places[0].rules, 2, 'active and inactive rules count');
  const del = await as(ANNA)('DELETE', `/presence/places/${s.id}`);
  assert.deepEqual([del.status, del.json.code, del.json.rules], [409, 'in_use', ['Ankommen', `#${r2.id}`]]);
  await as(ANNA)('DELETE', `/presence/rules/${r1.id}`);
  await as(ANNA)('PATCH', `/presence/rules/${r2.id}`, { trigger: 'all_away' });
  assert.deepEqual((await as(ANNA)('DELETE', `/presence/places/${s.id}`)).json, { ok: true });
  assert.equal((await as(ANNA)('DELETE', `/presence/places/${s.id}`)).status, 404);
  // at most 20
  for (let i = 1; i <= 20; i++) await place(as, { name: `Ort ${i}`, lat: 50 + i / 100, lon: 8 });
  const many = await as(ANNA)('POST', '/presence/places', { name: 'Ort 21', lat: 50, lon: 8 });
  assert.deepEqual([many.status, many.json.code], [409, 'too_many']);
  // the admin page: the same places and functions, also in GET admin/presence
  const st = (await admin('GET', 'presence')).json;
  assert.deepEqual([st.places.length, st.home], [20, { lat: 52.52, lon: 13.405 }]);
  assert.equal((await admin('GET', 'presence/places')).json.places.length, 20);
  assert.equal((await admin('POST', 'presence/places', { name: 'Ort 22', lat: 1, lon: 1 })).json.code, 'too_many');
  const first = st.places[0];
  assert.equal((await admin('PATCH', `presence/places/${first.id}`, { name: 'Sporthalle' })).json.place.name, 'Sporthalle');
  assert.equal((await admin('PATCH', `presence/places/${first.id}`, { name: 'ort 2' })).json.code, 'name_taken');
  assert.deepEqual((await admin('DELETE', `presence/places/${first.id}`)).json, { ok: true });
  assert.equal((await as(ANNA)('GET', '/presence/places')).json.places.length, 19);
}));

test('rule places: without a location home is null; module off and device trust are refused', () => withFamily(ON(), async (host, { as, call, admin }) => {
  assert.equal((await as(ANNA)('GET', '/presence/places')).json.home, null);
  assert.equal((await call(portal(ANNA, false), 'GET', '/presence/places')).json.code, 'login_required');
  await admin('PUT', 'modules', { presence: false });
  for (const [m, p, b] of [['GET', '/presence/places'], ['POST', '/presence/places', SCHULE], ['PATCH', '/presence/places/1', { radius: 100 }], ['DELETE', '/presence/places/1'],
    ['GET', '/presence/watch'], ['POST', '/presence/places/1/event', { transition: 'enter' }]]) {
    assert.equal((await as(ANNA)(m, p, b)).json.code, 'module_off', `${m} ${p}`);
  }
}));

test('consent: share and places each optional, at least one; independent of each other; GET presence shows them', () => withFamily(ON(), async (host, { as }) => {
  assert.equal((await as(ANNA)('PUT', '/presence/consent', {})).json.code, 'invalid');
  assert.equal((await as(ANNA)('PUT', '/presence/consent', { places: 'ja' })).json.code, 'invalid');
  assert.equal((await as(ANNA)('PUT', '/presence/consent', { share: true, places: null })).json.code, 'invalid');
  const a = (await as(ANNA)('PUT', '/presence/consent', { places: true })).json;
  assert.deepEqual(a, { ok: true, consent: { share: false, places: true }, state: { userId: ANNA.id, state: 'not_shared', home: null, since: null } });
  assert.deepEqual((await as(ANNA)('PUT', '/presence/consent', { share: true })).json.consent, { share: true, places: true }, 'the body { share } as before keeps places');
  await as(ANNA)('POST', '/presence', { home: true });
  assert.deepEqual((await as(ANNA)('PUT', '/presence/consent', { places: false })).json, {
    ok: true, consent: { share: true, places: false }, state: { userId: ANNA.id, state: 'home', home: true, since: '2026-10-14T08:00:00Z' },
  }, 'places off keeps home / away');
  await as(ANNA)('PUT', '/presence/consent', { share: false, places: true });
  await as(TIM)('PUT', '/presence/consent', { share: true, places: true });
  const g = (await as(ANNA)('GET', '/presence')).json;
  assert.deepEqual(g.me, { share: false, places: true });
  assert.deepEqual(g.members.map((m) => [m.name, m.shared, m.placesShared, m.state]), [
    ['Anna', false, true, 'not_shared'], ['Marc', false, false, 'not_shared'], ['Lena', false, false, 'not_shared'], ['Tim', true, true, 'unknown'],
  ]);
  assert.deepEqual((await as(LENA)('GET', '/overview')).json.presence.members.map((m) => m.placesShared), [true, false, false, true]);
}));

test('watch list: only with consent, active place rules for anyone or the caller, union of transitions by id, a version', () => withFamily(ON(), async (host, { as, clock }) => {
  const s = await place(as, SCHULE);
  const h = await place(as, HOME);
  const w0 = (await as(MARC)('GET', '/presence/watch')).json;
  assert.deepEqual(w0, { ok: true, places: [], version: version([]) });
  // rules: Zuhause enter for anyone, Zuhause exit for Marc, Schule enter for Tim, an inactive one and a person rule
  const homeAny = await rule(as, { trigger: 'place_enter', placeId: h.id, userId: null, actions: [QA] });
  await rule(as, { trigger: 'place_exit', placeId: h.id, userId: MARC.id, actions: [QA] });
  await rule(as, { trigger: 'place_enter', placeId: s.id, userId: TIM.id, actions: [QA] });
  await rule(as, { trigger: 'place_exit', placeId: s.id, active: false, actions: [QA] });
  await rule(as, { trigger: 'person_home', userId: MARC.id, actions: [QA] });
  assert.deepEqual((await as(MARC)('GET', '/presence/watch')).json, { ok: true, places: [], version: version([]) }, 'no consent → empty, never an error');
  await agree(as, MARC, TIM, LENA);
  const marc = (await as(MARC)('GET', '/presence/watch')).json;
  const homeEntry = { id: h.id, name: 'Zuhause', lat: 52.52, lon: 13.405, radius: 500 };
  assert.deepEqual(marc.places, [{ ...homeEntry, transitions: ['enter', 'exit'] }], 'Marc: Zuhause enter (anyone) + exit (Marc)');
  assert.equal(marc.version, version(marc.places));
  assert.match(marc.version, /^[0-9a-f]{12}$/);
  const tim = (await as(TIM)('GET', '/presence/watch')).json;
  assert.deepEqual(tim.places, [{ id: s.id, name: 'Schule', lat: 52.5301, lon: 13.4101, radius: 150, transitions: ['enter'] }, { ...homeEntry, transitions: ['enter'] }].sort((a, b) => a.id - b.id), 'sorted by id');
  assert.deepEqual((await as(LENA)('GET', '/presence/watch')).json.places, [{ ...homeEntry, transitions: ['enter'] }]);
  // the version: the same while nothing changes, new when a place or a rule changes; GET / POST presence carry it
  assert.equal((await as(MARC)('GET', '/presence/watch')).json.version, marc.version);
  assert.equal((await as(MARC)('GET', '/presence')).json.watchVersion, marc.version);
  await as(MARC)('PUT', '/presence/consent', { share: true });
  assert.equal((await as(MARC)('POST', '/presence', { home: true })).json.watchVersion, marc.version);
  clock.add(MIN);
  await as(ANNA)('PATCH', `/presence/places/${h.id}`, { radius: 300 });
  const v2 = (await as(MARC)('GET', '/presence/watch')).json;
  assert.notEqual(v2.version, marc.version);
  assert.equal(v2.places[0].radius, 300);
  await as(ANNA)('PATCH', `/presence/rules/${homeAny.id}`, { active: false });
  assert.deepEqual((await as(MARC)('GET', '/presence/watch')).json.places.map((p) => p.transitions), [['exit']], 'an inactive rule is not watched');
  assert.deepEqual((await as(LENA)('GET', '/presence/watch')).json.places, []);
  // consent off: empty (the version of the empty list)
  await as(MARC)('PUT', '/presence/consent', { places: false });
  assert.deepEqual((await as(MARC)('GET', '/presence/watch')).json, { ok: true, places: [], version: version([]) });
  assert.equal((await as(MARC)('GET', '/presence')).json.watchVersion, version([]));
}));

test('rules: place triggers need an existing place; userId a member or null; other triggers have no place; a changed place starts afresh', () => withFamily(ON(), async (host, { as }) => {
  const s = await place(as, SCHULE);
  const h = await place(as, HOME);
  for (const [bad, field] of [
    [{ trigger: 'place_enter', actions: [QA] }, 'placeId'], [{ trigger: 'place_exit', placeId: 999, actions: [QA] }, 'placeId'], [{ trigger: 'place_enter', placeId: 'Schule', actions: [QA] }, 'placeId'],
    [{ trigger: 'place_enter', placeId: s.id, userId: 99, actions: [QA] }, 'userId'], [{ trigger: 'place_enter', placeId: s.id, userId: 'Tim', actions: [QA] }, 'userId'],
  ]) {
    const r = (await as(ANNA)('POST', '/presence/rules', bad)).json;
    assert.deepEqual([r.code, r.field], ['invalid', field], JSON.stringify(bad));
  }
  const anyone = await rule(as, { trigger: 'place_exit', placeId: h.id, actions: [QA] });
  assert.deepEqual([anyone.trigger, anyone.userId, anyone.placeId, anyone.placeName], ['place_exit', null, h.id, 'Zuhause'], 'no userId = anyone');
  const tim = await rule(as, { trigger: 'place_enter', placeId: s.id, userId: TIM.id, actions: [QA] });
  assert.deepEqual([tim.userId, tim.placeId, tim.placeName], [TIM.id, s.id, 'Schule']);
  const other = await rule(as, { trigger: 'first_home', placeId: s.id, userId: TIM.id, actions: [QA] });
  assert.deepEqual([other.userId, other.placeId, other.placeName], [null, null, null], 'other triggers: no place, no person');
  // PATCH: the place stays when not given; the place's current name; another trigger drops the place
  await as(ANNA)('PATCH', `/presence/places/${s.id}`, { name: 'Grundschule' });
  const t2 = (await as(ANNA)('PATCH', `/presence/rules/${tim.id}`, { trigger: 'place_exit' })).json.rule;
  assert.deepEqual([t2.trigger, t2.userId, t2.placeId, t2.placeName], ['place_exit', TIM.id, s.id, 'Grundschule']);
  assert.deepEqual((await as(ANNA)('PATCH', `/presence/rules/${tim.id}`, { userId: null })).json.rule.userId, null, 'anyone');
  const moved = (await as(ANNA)('PATCH', `/presence/rules/${tim.id}`, { placeId: h.id })).json.rule;
  assert.deepEqual([moved.placeId, moved.placeName], [h.id, 'Zuhause']);
  assert.equal((await as(ANNA)('PATCH', `/presence/rules/${tim.id}`, { placeId: null })).json.field, 'placeId');
  const person = (await as(ANNA)('PATCH', `/presence/rules/${tim.id}`, { trigger: 'person_home', userId: LENA.id })).json.rule;
  assert.deepEqual([person.trigger, person.userId, person.placeId, person.placeName], ['person_home', LENA.id, null, null]);
  assert.equal((await as(ANNA)('PATCH', `/presence/rules/${anyone.id}`, { trigger: 'person_home' })).json.field, 'userId', 'from "anyone" to a person rule needs a person');
  assert.equal(presence.TRIGGERS.includes('place_enter') && presence.TRIGGERS.includes('place_exit'), true);
}));

test('events: fire the matching rules (person filter), notify with {place}, data.placeId, the log with the place name at the time', () => {
  const log = [];
  return withFamily(ON(log), async (host, { as, clock }) => {
    const s = await place(as, SCHULE);
    const h = await place(as, HOME);
    const timSchool = await rule(as, { name: 'Tim da', trigger: 'place_enter', placeId: s.id, userId: TIM.id, actions: [{ type: 'notify', to: 'parents' }] });
    const anyHome = await rule(as, { trigger: 'place_enter', placeId: h.id, actions: [QA, { type: 'notify', to: [ANNA.id], text: '{name} ist gleich bei {place}' }] });
    const leave = await rule(as, { trigger: 'place_exit', placeId: s.id, actions: [{ type: 'notify', to: 'all' }] });
    await agree(as, TIM, LENA, MARC);
    // Lena arrives at school: Tim's rule is not hers
    const l1 = (await as(LENA)('POST', `/presence/places/${s.id}/event`, { transition: 'enter' })).json;
    assert.deepEqual(l1, { ok: true, fired: 0, late: false, repeated: false });
    // Tim arrives at school (the phone's time half a minute ago)
    const t1 = (await as(TIM)('POST', `/presence/places/${s.id}/event`, { transition: 'enter', at: '2026-10-14T07:59:30Z' })).json;
    assert.deepEqual(t1, { ok: true, fired: 1, late: false, repeated: false });
    let p = pushes(host, 'presence_rule');
    assert.deepEqual(p.map((x) => [x.title, x.body, x.users.sort(), x.data.familie]), [
      ['Tim ist bei Schule angekommen', 'Tim da', [ANNA.id, MARC.id], { type: 'presence_rule', ruleId: timSchool.id, trigger: 'place_enter', userId: TIM.id, placeId: s.id }],
    ]);
    // Marc arrives at home ("anyone"): the scene as Anna, the own text with {name} and {place}
    clock.add(MIN);
    assert.equal((await as(MARC)('POST', `/presence/places/${h.id}/event`, { transition: 'enter' })).json.fired, 1);
    assert.deepEqual(log.map((x) => [x.id, x.viewer.id]), [['scene:home', ANNA.id]]);
    p = pushes(host, 'presence_rule');
    assert.deepEqual([p[1].title, p[1].users, p[1].data.familie.placeId], ['Marc ist gleich bei Zuhause', [ANNA.id], h.id]);
    // Tim leaves school: everyone else is told
    clock.add(MIN);
    assert.equal((await as(TIM)('POST', `/presence/places/${s.id}/event`, { transition: 'exit' })).json.fired, 1);
    p = pushes(host, 'presence_rule');
    assert.deepEqual([p[2].title, p[2].users.sort()], ['Tim hat Schule verlassen', [ANNA.id, MARC.id, LENA.id]]);
    // the log: placeId and the name at the time; renamed later, the log keeps it and the rule shows the new one
    await as(ANNA)('PATCH', `/presence/places/${s.id}`, { name: 'Grundschule' });
    const l = (await as(ANNA)('GET', '/presence/log')).json.log;
    assert.deepEqual(l.map((x) => [x.ruleId, x.trigger, x.userId, x.placeId, x.placeName, x.ok]), [
      [leave.id, 'place_exit', TIM.id, s.id, 'Schule', true], [anyHome.id, 'place_enter', MARC.id, h.id, 'Zuhause', true], [timSchool.id, 'place_enter', TIM.id, s.id, 'Schule', true],
    ]);
    const rules = (await as(ANNA)('GET', '/presence/rules')).json.rules;
    assert.deepEqual(rules.map((x) => x.placeName), ['Grundschule', 'Zuhause', 'Grundschule']);
    assert.equal(rules[0].lastRunAt, '2026-10-14T08:00:00Z');
    // every event is stored (no position)
    const ev = await rows(host, 'SELECT place_id, user_id, transition, at, received_at, fired, late FROM place_rule_events ORDER BY id');
    assert.deepEqual(ev.map((x) => [x.place_id, x.user_id, x.transition, x.fired, x.late]), [[s.id, LENA.id, 'enter', 0, 0], [s.id, TIM.id, 'enter', 1, 0], [h.id, MARC.id, 'enter', 1, 0], [s.id, TIM.id, 'exit', 1, 0]]);
    assert.deepEqual([ev[1].at, ev[1].received_at], [Date.UTC(2026, 9, 14, 7, 59, 30), Date.UTC(2026, 9, 14, 8, 0)]);
    // English notification texts
    assert.equal(require('../server/push').t('en', 'presence.place_enter', { name: 'Tim', place: 'School' }), 'Tim arrived at School');
    assert.equal(require('../server/push').t('en', 'presence.place_exit', { name: 'Tim', place: 'School' }), 'Tim left School');
  });
});

test('events: repeats within 60 s and late events run nothing; the 10-minute throttle; conditions; errors', () => {
  const log = [];
  return withFamily(ON(log), async (host, { as, clock }) => {
    const h = await place(as, HOME);
    const r = await rule(as, { trigger: 'place_enter', placeId: h.id, actions: [QA] });
    const night = await rule(as, { trigger: 'place_exit', placeId: h.id, userId: TIM.id, conditions: { time: { from: '22:00', to: '06:00' } }, actions: [{ type: 'notify', to: 'parents' }] });
    const ev = (u, body) => as(u)('POST', `/presence/places/${h.id}/event`, body);
    // errors: no consent, unknown place, bad transition / at
    assert.deepEqual([(await ev(TIM, { transition: 'enter' })).status, (await ev(TIM, { transition: 'enter' })).json.code], [409, 'no_consent']);
    await agree(as, TIM, LENA);
    assert.deepEqual([(await as(TIM)('POST', '/presence/places/999/event', { transition: 'enter' })).status], [404]);
    assert.equal((await as(TIM)('POST', '/presence/places/abc/event', { transition: 'enter' })).json.code, 'not_found');
    for (const [b, field] of [[{ transition: 'arrive' }, 'transition'], [{}, 'transition'], [{ transition: 'enter', at: 'gestern' }, 'at'], [{ transition: 'enter', at: 12 }, 'at']]) {
      const x = await ev(TIM, b);
      assert.deepEqual([x.status, x.json.code, x.json.field], [400, 'invalid', field], JSON.stringify(b));
    }
    assert.equal(await count(host, 'SELECT COUNT(*) AS n FROM place_rule_events'), 0, 'refused events are not stored');
    // a late event (the phone was offline): recorded, nothing runs
    assert.deepEqual((await ev(TIM, { transition: 'enter', at: '2026-10-14T07:49:00Z' })).json, { ok: true, fired: 0, late: true, repeated: false });
    assert.equal(log.length, 0);
    // exactly 10 minutes old is not late yet
    assert.deepEqual((await ev(LENA, { transition: 'enter', at: '2026-10-14T07:50:00Z' })).json, { ok: true, fired: 1, late: false, repeated: false });
    assert.equal(log.length, 1);
    // a repeat within 60 s (same person, place, transition): nothing; another person is no repeat — but throttled
    clock.add(30000);
    assert.deepEqual((await ev(LENA, { transition: 'enter' })).json, { ok: true, fired: 0, late: false, repeated: false }, 'the last one was at 07:50 (phone time): no repeat, throttled');
    assert.deepEqual((await ev(LENA, { transition: 'enter' })).json, { ok: true, fired: 0, late: false, repeated: true });
    clock.add(5 * MIN);
    assert.deepEqual((await ev(TIM, { transition: 'enter' })).json, { ok: true, fired: 0, late: false, repeated: false }, 'throttled: the rule ran at 08:00');
    clock.set(Date.UTC(2026, 9, 14, 8, 10));
    assert.deepEqual((await ev(TIM, { transition: 'enter', at: '2026-10-14T08:09:50Z' })).json, { ok: true, fired: 1, late: false, repeated: false }, '10 minutes after the last run');
    assert.equal(log.length, 2);
    // a future time is clamped to now
    clock.add(2 * MIN);
    await ev(TIM, { transition: 'exit', at: '2030-01-01T00:00:00Z' });
    const [last] = await rows(host, 'SELECT at, received_at FROM place_rule_events ORDER BY id DESC LIMIT 1');
    assert.equal(last.at, last.received_at);
    assert.equal(pushes(host, 'presence_rule').filter((x) => x.data.familie.ruleId === night.id).length, 0, 'outside the time window');
    // 23:00 local (21:00 UTC): inside the window
    clock.set(Date.UTC(2026, 9, 14, 21, 0));
    assert.equal((await ev(TIM, { transition: 'exit' })).json.fired, 1);
    assert.deepEqual(pushes(host, 'presence_rule').map((x) => x.title), ['Tim hat Zuhause verlassen']);
    // places consent off: the phone stops; events are refused, the stored ones stay
    await as(TIM)('PUT', '/presence/consent', { places: false });
    assert.equal((await ev(TIM, { transition: 'enter' })).json.code, 'no_consent');
    assert.equal(await count(host, 'SELECT COUNT(*) AS n FROM place_rule_events WHERE user_id = ?', [TIM.id]), 5);
    assert.equal(r.trigger, 'place_enter');
    // kept 90 days
    clock.add(91 * DAY);
    await host.tick();
    assert.equal(await count(host, 'SELECT COUNT(*) AS n FROM place_rule_events'), 0);
    assert.equal(presence.EVENT_LATE_MS, 10 * MIN);
    assert.equal(presence.EVENT_DEDUPE_MS, MIN);
  });
});
