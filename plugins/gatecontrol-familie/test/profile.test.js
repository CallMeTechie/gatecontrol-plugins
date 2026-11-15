'use strict';

// 1.26.0 — the birthday from the user profile (GateControl ≥ 1.280.0, gc.profile, permissions.profile ["birthday"]):
// a parent's comes from the profile as the viewer may see it, a child's stays with the parents; taken over once when
// Familie's own is empty (only when somebody else sees it); without the year day and month, no age; the hook
// profileChanged reads it again, the hook myData hands over the person's part of „Meine Daten“. An older GateControl:
// everything as before.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withFamily, ADMIN, ANNA, MARC, LENA, TIM, OMA, DAY, T0 } = require('./helpers');

const FAMILY = [[ANNA.id, MARC.id, LENA.id, TIM.id]];
const PROFILE = (people) => ({ profile: { people, families: FAMILY } });
const YEAR = { from: '2026-10-14', to: '2027-10-13' };
const birthdays = async (as, u) => (await as(u)('GET', '/dates', null, YEAR)).json.events.filter((e) => e.kind === 'birthday');
const statusOf = async (admin, id) => (await admin('GET', 'status')).json.members.find((m) => m.userId === id);

test('an older GateControl: no gc.profile — the admin page keeps the birthdays, nothing from a profile', () => withFamily({}, async (host, { as, admin }) => {
  const st = (await admin('GET', 'status')).json;
  assert.equal(st.profile, false);
  const anna = st.members.find((m) => m.userId === ANNA.id);
  assert.equal(anna.birthdate, '1986-04-03');
  assert.equal(anna.birthdaySource, 'family');
  assert.deepEqual(anna.birthday, { month: 4, day: 3, year: 1986 });
  assert.equal((await admin('PATCH', `members/${ANNA.id}`, { birthdate: '1986-04-04' })).json.member.birthdate, '1986-04-04');
  assert.ok((await birthdays(as, MARC)).some((e) => e.id === `member:${ANNA.id}` && e.date === '2027-04-04' && e.years === 41));
}));

test('parents: the profile leads; the admin page shows it read-only, a value sent there is ignored', () => withFamily(PROFILE({
  [ANNA.id]: { birthday: '1986-03-14' },
}), async (host, { as, admin }) => {
  const st = (await admin('GET', 'status')).json;
  assert.equal(st.profile, true);
  const anna = st.members.find((m) => m.userId === ANNA.id);
  assert.equal(anna.birthdaySource, 'profile');
  // the setup sent 1986-04-03 for Anna: ignored. The administrator is no family member — "Familie" hides it from him
  assert.equal(anna.birthdate, null);
  assert.equal((await admin('PATCH', `members/${ANNA.id}`, { birthdate: '1990-01-01' })).json.member.birthdate, null);
  // Marc (family) sees it: date and age, the dates of everybody
  const b = (await birthdays(as, MARC)).find((e) => e.id === `member:${ANNA.id}`);
  assert.equal(b.date, '2027-03-14');
  assert.equal(b.years, 41);
  assert.equal(b.baseDate, '1986-03-14');
  // the viewer counts: Marc's request asked with viewer Marc
  assert.ok(host.profile.calls.some((c) => c.userId === ANNA.id && c.viewer === MARC.id && c.counted));
  // taken over once (somebody else saw it) — the administrator's page now shows Familie's copy
  assert.equal((await statusOf(admin, ANNA.id)).birthdate, '1986-03-14');
  // children: the parents keep it, a profile value does not count
  host.profile.set(LENA.id, { birthday: '2000-01-01', visibility: { birthday: 'all' } });
  const lena = await statusOf(admin, LENA.id);
  assert.equal(lena.birthdaySource, 'family');
  assert.equal(lena.age, 12);
  assert.equal((await admin('PATCH', `members/${LENA.id}`, { birthdate: '2014-01-02' })).json.member.birthdate, '2014-01-02');
}));

test('without the year: day and month, no age; a birthday only for herself is never taken over', () => withFamily(PROFILE({
  [MARC.id]: { birthday: '1980-07-02', yearHidden: true },
  [ANNA.id]: { birthday: '1986-03-14', visibility: { birthday: 'self' } },
}), async (host, { as, admin, clock }) => {
  const marc = (await birthdays(as, ANNA)).find((e) => e.id === `member:${MARC.id}`);
  assert.equal(marc.date, '2027-07-02');
  assert.equal(marc.years, null);
  assert.equal(marc.baseDate, null);
  assert.equal((await statusOf(admin, MARC.id)).birthdate, null, 'no year → nothing to take over');
  // Anna's is "Nur ich": others do not see it, she does — and Familie does not copy it
  assert.ok(!(await birthdays(as, MARC)).some((e) => e.id === `member:${ANNA.id}`));
  assert.ok((await birthdays(as, ANNA)).some((e) => e.id === `member:${ANNA.id}` && e.years === 41));
  assert.equal((await statusOf(admin, ANNA.id)).birthdate, null);
  // the reminder on the day: without the year, without an age
  host.profile.set(MARC.id, { birthday: '1980-10-15', yearHidden: true, visibility: { birthday: 'all' } });
  await host.profile.changed(MARC.id, ['birthday']);
  clock.set(T0 + DAY);
  const from = host.notifications.length;
  await host.tick();
  const n = host.notifications.slice(from).find((x) => x.data && x.data.familie && x.data.familie.eventId === `member:${MARC.id}`);
  assert.ok(n, 'reminded');
  assert.equal(n.title, 'Marc hat heute Geburtstag');
}));

test('profileChanged: a changed birthday is read again; removed in the profile, the copy goes too', () => withFamily(PROFILE({
  [ANNA.id]: { birthday: '1986-03-14' },
}), async (host, { as, admin }) => {
  await birthdays(as, MARC);
  assert.equal((await statusOf(admin, ANNA.id)).birthdate, '1986-03-14');
  host.profile.set(ANNA.id, { birthday: '1986-03-15' });
  // cached until the hook says so
  assert.ok((await birthdays(as, MARC)).some((e) => e.id === `member:${ANNA.id}` && e.date === '2027-03-14'));
  assert.deepEqual(await host.profile.changed(ANNA.id, ['birthday']), ['birthday']);
  assert.ok((await birthdays(as, MARC)).some((e) => e.id === `member:${ANNA.id}` && e.date === '2027-03-15'));
  assert.equal((await statusOf(admin, ANNA.id)).birthdate, '1986-03-14', 'taken over once only — Familie keeps its copy');
  host.profile.set(ANNA.id, { birthday: null });
  await host.profile.changed(ANNA.id, ['birthday', 'about']);
  assert.ok(!(await birthdays(as, MARC)).some((e) => e.id === `member:${ANNA.id}`));
  assert.equal((await statusOf(admin, ANNA.id)).birthdate, null, 'the copy of the profile went');
}));

test('a value from before stays while the profile has none', () => withFamily({ profile: { people: {}, families: FAMILY }, family: false }, async (host, { as, admin }) => {
  // an older Familie stored Anna's birthday (members.birthdate, entered by the parents)
  assert.equal((await admin('POST', 'members', { userId: ANNA.id, role: 'parent' })).status, 200);
  assert.equal((await admin('POST', 'members', { userId: MARC.id, role: 'parent' })).status, 200);
  await host.gc.db.run('UPDATE members SET birthdate = ? WHERE user_id = ?', ['1986-04-03', ANNA.id]);
  assert.ok((await birthdays(as, MARC)).some((e) => e.id === `member:${ANNA.id}` && e.date === '2027-04-03'));
  assert.equal((await statusOf(admin, ANNA.id)).birthdate, '1986-04-03');
}));

test('myData: role, birthday and the own emergency card — nothing of the others, null for somebody else', () => withFamily(PROFILE({}), async (host, { as }) => {
  assert.equal((await as(LENA)('PUT', `/emergency/members/${LENA.id}`, { bloodType: 'A+', allergies: 'Erdnüsse', contacts: [] })).status, 200);
  assert.equal((await as(TIM)('PUT', `/emergency/members/${TIM.id}`, { allergies: 'Tims Daten' })).status, 200);
  const { data } = await host.profile.myData(LENA.id);
  assert.equal(data.role, 'child');
  assert.equal(data.birthdateFrom, 'family');
  assert.match(data.birthdate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(data.locateMode, 'confirm');
  assert.equal(data.emergencyCard.bloodType, 'A+');
  assert.equal(data.emergencyCard.allergies, 'Erdnüsse');
  assert.ok(!JSON.stringify(data).includes('Tims Daten'));
  assert.equal((await host.profile.myData(MARC.id)).data.emergencyCard, null);
  assert.deepEqual(await host.profile.myData(OMA.id), { data: null });
  assert.deepEqual(await host.profile.myData(ADMIN.id), { data: null });
}));
