'use strict';

// Members and roles: only GateControl users, admin API (administrators on
// the admin pages only), GET me per role, not_member, age from the
// birthdate, 18 = adult (never locatable), app/portal visibility, device
// trust in the portal reads only; from 14 the hint for "Kind bestätigt" and
// the push on the 14th birthday.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withFamily, ADMIN, ANNA, MARC, LENA, TIM, OMA, app, portal, birth, pushes, T0, DAY } = require('./helpers');
const members = require('../server/members');

test('age: full years on the local date; 29 February counts from 1 March', () => {
  assert.equal(members.age('2014-10-14', '2026-10-13'), 11);
  assert.equal(members.age('2014-10-14', '2026-10-14'), 12);
  assert.equal(members.age('2008-02-29', '2026-02-28'), 17);
  assert.equal(members.age('2008-02-29', '2026-03-01'), 18);
  assert.equal(members.age('2008-02-29', '2028-02-29'), 20);
  assert.equal(members.age('not a date', '2026-01-01'), null);
});

test('admin API: add, edit, remove members; only GateControl users; children need a birthdate', () => withFamily({}, async (host, { admin }) => {
  const st = await admin('GET', 'status');
  assert.equal(st.status, 200);
  assert.deepEqual(st.json.members.map((m) => [m.userId, m.role]), [[2, 'parent'], [3, 'parent'], [4, 'child'], [5, 'child']]);
  const lena = st.json.members.find((m) => m.userId === LENA.id);
  assert.deepEqual([lena.age, lena.adult, lena.locateMode, lena.locatable, lena.starGoal], [12, false, 'confirm', true, 25]);
  // 1.3.0: colour and picture of the GateControl account (default palette[id % 10])
  assert.deepEqual([lena.avatarUrl, lena.color, lena.colorHex, lena.initials, lena.presence], [null, 'yellow', '#EAB308', 'LE', null]);
  assert.deepEqual(st.json.users.filter((u) => !u.member).map((u) => u.id), [ADMIN.id, OMA.id, 7]);
  assert.deepEqual(st.json.modules, {
    shopping: true, tasks: true, stars: true, dates: true, locate: true, arrival_sos: true, places: true, rides: true, emergency: true, wall: false,
    allowance: false, wishes: true, expenses: false, board: true, meals: false, presence: false,
  });
  assert.equal(st.json.settings.timezone, 'Europe/Berlin');

  assert.equal((await admin('POST', 'members', { userId: 99, role: 'parent' })).status, 404, 'no such GateControl user');
  assert.equal((await admin('POST', 'members', { userId: ANNA.id, role: 'parent' })).json.code, 'invalid', 'already a member');
  assert.equal((await admin('POST', 'members', { userId: OMA.id, role: 'child' })).json.code, 'invalid', 'child without birthdate');
  assert.equal((await admin('POST', 'members', { userId: OMA.id, role: 'grandma' })).status, 400);
  assert.equal((await admin('POST', 'members', { userId: OMA.id, role: 'child', birthdate: '2030-01-01' })).status, 400, 'future birthdate');
  const oma = await admin('POST', 'members', { userId: OMA.id, role: 'parent', birthdate: '1946-10-20' });
  assert.equal(oma.status, 200);
  assert.equal(oma.json.member.age, 79);

  const e = await admin('PATCH', 'members/' + TIM.id, { locateMode: 'off', starGoal: 30 });
  assert.deepEqual([e.json.member.locateMode, e.json.member.starGoal, e.json.member.locatable], ['off', 30, false]);
  assert.equal((await admin('PATCH', 'members/' + TIM.id, { locateMode: 'sometimes' })).status, 400);
  assert.equal((await admin('PATCH', 'members/' + MARC.id, { role: 'child' })).status, 400, 'a child needs a birthdate');
  assert.equal((await admin('DELETE', 'members/' + OMA.id)).status, 200);
  assert.equal((await admin('DELETE', 'members/' + OMA.id)).status, 404);
}));

test('admin API: administrators on the admin pages only — never a portal or app caller, never a plain user', () => withFamily({}, async (host, { call }) => {
  assert.equal((await call({ ...ADMIN, portal: true, loggedIn: true }, 'GET', '/admin/status')).status, 403);
  assert.equal((await call(app(ADMIN), 'GET', '/admin/status')).status, 403);
  assert.equal((await call(ANNA, 'GET', '/admin/status')).status, 403);
  assert.equal((await call(app(ANNA), 'POST', '/admin/members', { userId: OMA.id, role: 'parent' })).json.code, 'forbidden');
}));

test('GET me: own role and age; locate fields of children for parents only; non-members get not_member', () => withFamily({}, async (host, { as, call }) => {
  const anna = await as(ANNA)('GET', '/me');
  assert.equal(anna.status, 200);
  assert.deepEqual(anna.json.me, { userId: 2, name: 'Anna', role: 'parent', age: null, locateMode: null, avatarUrl: null, color: 'green', colorHex: '#22C55E', initials: 'AN', presence: null });
  assert.equal(anna.json.serverTime, '2026-10-14T08:00:00Z');
  const tim = anna.json.members.find((m) => m.userId === TIM.id);
  assert.deepEqual(tim, { userId: 5, name: 'Tim', role: 'child', age: 9, avatarUrl: null, color: 'orange', colorHex: '#F97316', initials: 'TI', presence: null, locateMode: 'auto', locatable: true });
  const marc = anna.json.members.find((m) => m.userId === MARC.id);
  assert.ok(!('locateMode' in marc) && marc.age === null, 'parents: no locate fields, age null');

  const lena = await as(LENA)('GET', '/me');
  assert.deepEqual([lena.json.me.role, lena.json.me.age, lena.json.me.locateMode], ['child', 12, 'confirm']);
  for (const m of lena.json.members) assert.ok(!('locateMode' in m) && !('locatable' in m), 'children see no locate fields');

  for (const u of [OMA, ADMIN]) {
    const r = await as(u)('GET', '/me');
    assert.deepEqual([r.status, r.json.ok, r.json.code], [403, false, 'not_member']);
    assert.equal(typeof r.json.error, 'string');
    assert.equal((await as(u)('GET', '/shopping')).json.code, 'not_member', 'every endpoint');
    assert.equal((await as(u)('POST', '/sos', {})).json.code, 'not_member');
  }
  assert.equal((await call(app(ANNA), 'GET', '/nothing')).json.code, 'not_found');
}));

test('18th birthday: an adult child is no longer locatable (admin page, me, API refuses)', () => withFamily({}, async (host, { admin, as, clock }) => {
  // Lena turns 18 tomorrow
  await admin('PATCH', 'members/' + LENA.id, { birthdate: birth(18, { daysAfterBirthday: -1 }) });
  let me = await as(ANNA)('GET', '/me');
  assert.equal(me.json.members.find((m) => m.userId === LENA.id).locatable, true);
  assert.equal(me.json.members.find((m) => m.userId === LENA.id).age, 17);
  clock.add(DAY);
  me = await as(ANNA)('GET', '/me');
  const lena = me.json.members.find((m) => m.userId === LENA.id);
  assert.deepEqual([lena.age, lena.locatable, lena.locateMode], [18, false, 'off']);
  assert.equal((await as(LENA)('GET', '/me')).json.me.locateMode, 'off');
  const st = await admin('GET', 'status');
  assert.equal(st.json.members.find((m) => m.userId === LENA.id).adult, true);
  const r = await as(ANNA)('POST', '/locate/' + LENA.id);
  assert.deepEqual([r.status, r.json.code], [409, 'adult']);
  // the admin page says so
  const html = (await host.render({ view: 'page', page: 'members', lang: 'de' })).html;
  assert.ok(html.includes('volljährig – Ortung beendet'));
}));

test('app tab and portal tab: members only, and only while at least one module is on', () => withFamily({}, async (host, { admin }) => {
  assert.equal(await host.appVisible(ANNA), true);
  assert.equal(await host.appVisible(TIM), true);
  assert.equal(await host.appVisible(OMA), false, 'not a member');
  assert.equal(await host.appVisible(ADMIN), false);
  // the hook also accepts the bare user (appVisible(user))
  assert.equal(await host.plugin.appVisible(app(ANNA), host.gc), true);
  assert.equal(await host.plugin.appVisible(app(OMA), host.gc), false);
  assert.equal(await host.portalVisible(ANNA), true);
  assert.equal(await host.portalVisible(OMA), false);
  assert.equal(await host.portalVisible(ANNA, 'home'), false, 'no sections');
  await admin('PUT', 'modules', { shopping: false, tasks: false, stars: false, dates: false, locate: false, arrival_sos: false, rides: false, emergency: false, wall: true });
  assert.equal(await host.appVisible(ANNA), true, 'places still on');
  await admin('PUT', 'modules', { places: false, wishes: false });
  assert.equal(await host.appVisible(ANNA), true, 'board still on (1.2.0)');
  await admin('PUT', 'modules', { board: false });
  assert.equal(await host.appVisible(ANNA), false, 'every module off (the wall view is no family feature)');
  await admin('PUT', 'modules', { presence: true });
  assert.equal(await host.appVisible(ANNA), true, 'a 1.2.0 module alone is enough');
  await admin('PUT', 'modules', { presence: false });
  assert.equal(await host.portalVisible(ANNA), false);
}));

test('portal: device trust reads the everyday parts only, changes nothing; a real login may write', () => withFamily({}, async (host, { call }) => {
  const trust = portal(ANNA, false);
  assert.equal((await call(trust, 'GET', '/me')).status, 200);
  assert.equal((await call(trust, 'GET', '/shopping')).status, 200);
  assert.equal((await call(trust, 'GET', '/overview')).json.locate, null, 'no locate card');
  for (const [m, p, b] of [['POST', '/shopping/ops', { ops: [] }], ['POST', '/tasks', { title: 'x', assignees: [2] }], ['POST', '/locate/5'], ['GET', '/locate/requests'], ['GET', '/places'], ['POST', '/sos', {}], ['GET', '/sos']]) {
    const r = await call(trust, m, p, b);
    assert.deepEqual([r.status, r.json.code], [403, 'login_required'], `${m} ${p}`);
  }
  const ok = await call(portal(ANNA, true), 'POST', '/shopping/ops', { ops: [{ op: 'list_add', id: 'list-0001-aaaa', name: 'REWE' }] });
  assert.equal(ok.json.applied, 1);
  assert.equal(T0, Date.now(), 'clock mocked');
}));

test('from 14: a hint for "Automatisch" (admin pages); new children of 14+ start with "Kind bestätigt"', () => withFamily({}, async (host, { admin }) => {
  const kid = (st, id) => st.json.members.find((m) => m.userId === id);
  let st = await admin('GET', 'status');
  assert.deepEqual([kid(st, LENA.id).ageHint, kid(st, TIM.id).ageHint], [false, false], '12 (confirm) and 9 (auto)');
  await admin('PATCH', 'members/' + LENA.id, { birthdate: birth(14), locateMode: 'auto' });
  st = await admin('GET', 'status');
  assert.deepEqual([kid(st, LENA.id).age, kid(st, LENA.id).ageHint], [14, true]);
  await admin('PATCH', 'members/' + LENA.id, { locateMode: 'confirm' });
  assert.equal(kid(await admin('GET', 'status'), LENA.id).ageHint, false);
  await admin('PATCH', 'members/' + LENA.id, { birthdate: birth(18), locateMode: 'auto' });
  assert.equal(kid(await admin('GET', 'status'), LENA.id).ageHint, false, 'adult: no locating at all');
  const oma = await admin('POST', 'members', { userId: OMA.id, role: 'child', birthdate: birth(15) });
  assert.deepEqual([oma.json.member.locateMode, oma.json.member.ageHint], ['confirm', false]);
  // the pages show the hint next to the select (members.js / modules.js use this text)
  for (const page of ['members', 'modules']) assert.ok((await host.render({ view: 'page', page, lang: 'de' })).html.includes("T('members.age_hint'"), page);
  const t = require('../server/texts.json');
  assert.equal(t.de['members.age_hint'].replace('{{name}}', 'Lena'), 'Ab 14 empfehlen wir „Lena bestätigt“');
}));

test('14th birthday (tick, from 09:00): the parents get one hint when the phone still answers automatically', () => withFamily({}, async (host, { admin, clock }) => {
  // Lena turns 14 tomorrow (auto), Tim turns 14 tomorrow too but confirms himself
  await admin('PATCH', 'members/' + LENA.id, { birthdate: birth(14, { daysAfterBirthday: -1 }), locateMode: 'auto' });
  await admin('PATCH', 'members/' + TIM.id, { birthdate: birth(14, { daysAfterBirthday: -1 }), locateMode: 'confirm' });
  await host.tick();
  assert.equal(pushes(host, 'locate_age_hint').length, 0, 'not yet 14');
  const tomorrow = (hh, mm) => Date.UTC(2026, 9, 15, hh - 2, mm);
  clock.set(tomorrow(8, 59));
  await host.tick();
  assert.equal(pushes(host, 'locate_age_hint').length, 0, 'before 09:00');
  clock.set(tomorrow(9, 0));
  await host.tick();
  await host.tick();
  const p = pushes(host, 'locate_age_hint');
  assert.deepEqual(p.map((x) => [x.topic, x.users.sort(), x.title, x.data.familie]), [
    ['locate', [ANNA.id, MARC.id], 'Lena ist heute 14 – Ortung auf „Lena bestätigt“ umstellen?', { type: 'locate_age_hint', childId: LENA.id }],
  ]);
  clock.set(tomorrow(18, 0));
  await host.tick();
  assert.equal(pushes(host, 'locate_age_hint').length, 1, 'once');
  const st = await admin('GET', 'status');
  assert.equal(st.json.members.find((m) => m.userId === LENA.id).locateMode, 'auto', 'never switched by itself');
  // the next day: nothing; module off: nothing
  clock.set(tomorrow(10, 0) + DAY);
  await host.tick();
  assert.equal(pushes(host, 'locate_age_hint').length, 1);
}));

test('14th birthday: nothing while locating is switched off; 29 February counts from 1 March', () => withFamily({}, async (host, { admin, clock }) => {
  assert.equal(members.age('2012-02-29', '2026-02-28'), 13);
  assert.equal(members.age('2012-02-29', '2026-03-01'), 14);
  await admin('PATCH', 'members/' + LENA.id, { birthdate: birth(14, { daysAfterBirthday: -1 }), locateMode: 'auto' });
  await admin('PUT', 'modules', { locate: false });
  clock.set(Date.UTC(2026, 9, 15, 8, 0));
  await host.tick();
  assert.equal(pushes(host, 'locate_age_hint').length, 0);
}));
