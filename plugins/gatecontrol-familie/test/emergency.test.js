'use strict';

// Emergency card (Notfall-Karte): every member reads all cards; a member
// edits its own, parents every card and the family's numbers; validation of
// phone numbers and lengths (the field is named, never the value); never in
// a push or a log line; not for device-trust portal viewers.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withFamily, ANNA, MARC, LENA, TIM, OMA, portal, app } = require('./helpers');

const CARD = {
  bloodType: 'A+', weightKg: 32, allergies: 'Erdnüsse (schwer)', medications: 'Notfall-Pen (Adrenalin)', conditions: '', notes: 'Pen im Schulranzen',
  insurance: { name: 'AOK', number: 'A123454821' }, contacts: [{ label: 'Kinderarzt Dr. Berg', phone: '0221 123 456', note: 'Mo–Fr 8–18' }],
};

test('read: every member sees every card and the family\'s numbers; nothing seeded', () => withFamily({}, async (host, { as }) => {
  const r = await as(TIM)('GET', '/emergency');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.contacts, [], 'no default numbers');
  assert.equal(r.json.updatedAt, null);
  assert.deepEqual(r.json.members.map((m) => m.userId), [ANNA.id, MARC.id, LENA.id, TIM.id]);
  const tim = r.json.members.find((m) => m.userId === TIM.id);
  assert.deepEqual(tim, {
    userId: TIM.id, name: 'Tim', birthdate: tim.birthdate, age: 9, bloodType: null, weightKg: null, allergies: '', medications: '', conditions: '', notes: '',
    insurance: null, contacts: [], updatedAt: null, updatedBy: null,
  });
  assert.match(tim.birthdate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(r.json.members.find((m) => m.userId === MARC.id).birthdate, null);
  assert.equal((await as(OMA)('GET', '/emergency')).json.code, 'not_member');
}));

test('write: own card for everyone, every card and the family\'s numbers for parents', () => withFamily({}, async (host, { as, clock }) => {
  const own = await as(TIM)('PUT', `/emergency/members/${TIM.id}`, CARD);
  assert.equal(own.status, 200);
  assert.deepEqual(own.json.member, {
    userId: TIM.id, name: 'Tim', birthdate: own.json.member.birthdate, age: 9, ...CARD, updatedAt: '2026-10-14T08:00:00Z', updatedBy: { userId: TIM.id, name: 'Tim' },
  });
  assert.equal((await as(TIM)('PUT', `/emergency/members/${LENA.id}`, { notes: 'x' })).json.code, 'parents_only');
  assert.equal((await as(ANNA)('PUT', `/emergency/members/${OMA.id}`, { notes: 'x' })).status, 404, 'not a member');
  // partial: only what is named changes
  clock.add(60000);
  const p = await as(MARC)('PUT', `/emergency/members/${TIM.id}`, { weightKg: 33.25, bloodType: 'O-' });
  assert.deepEqual([p.json.member.weightKg, p.json.member.bloodType, p.json.member.allergies, p.json.member.updatedBy.name], [33.3, '0-', 'Erdnüsse (schwer)', 'Marc']);
  assert.deepEqual((await as(MARC)('PUT', `/emergency/members/${TIM.id}`, { insurance: null, contacts: [] })).json.member.insurance, null);
  // the family's numbers: parents only
  assert.equal((await as(LENA)('PUT', '/emergency/contacts', { contacts: [] })).json.code, 'parents_only');
  const fam = await as(ANNA)('PUT', '/emergency/contacts', { contacts: [{ label: 'Giftnotruf', phone: '030 19240', note: 'rund um die Uhr' }, { label: 'Kinderarzt', phone: '+49 (221) 123-456/7' }] });
  assert.deepEqual(fam.json.contacts, [{ label: 'Giftnotruf', phone: '030 19240', note: 'rund um die Uhr' }, { label: 'Kinderarzt', phone: '+49 (221) 123-456/7', note: '' }]);
  assert.deepEqual(fam.json.updatedBy, { userId: ANNA.id, name: 'Anna' });
  const all = await as(LENA)('GET', '/emergency');
  assert.equal(all.json.contacts.length, 2);
  assert.equal(all.json.updatedAt, '2026-10-14T08:01:00Z');
}));

test('validation: phone format, lengths, blood type, weight — the field is named, the value never', () => withFamily({}, async (host, { as }) => {
  const put = (body) => as(ANNA)('PUT', `/emergency/members/${TIM.id}`, body);
  const cases = [
    [{ contacts: [{ label: 'Arzt', phone: 'abc' }] }, 'contacts.0.phone'],
    [{ contacts: [{ label: 'Arzt', phone: '0221 123 456 ext 2' }] }, 'contacts.0.phone'],
    [{ contacts: [{ label: 'Arzt', phone: '0221.123.456' }] }, 'contacts.0.phone'],
    [{ contacts: [{ label: 'Arzt', phone: '+ / ( ) -' }] }, 'contacts.0.phone'],
    [{ contacts: [{ label: 'Arzt', phone: '1'.repeat(31) }] }, 'contacts.0.phone'],
    [{ contacts: [{ label: 'Arzt', phone: 123 }] }, 'contacts.0.phone'],
    [{ contacts: [{ label: '', phone: '112' }] }, 'contacts.0.label'],
    [{ contacts: [{ label: 'x'.repeat(61), phone: '112' }] }, 'contacts.0.label'],
    [{ contacts: [{ label: 'Arzt', phone: '112', note: 'x'.repeat(81) }] }, 'contacts.0.note'],
    [{ contacts: new Array(11).fill({ label: 'A', phone: '1' }) }, 'contacts'],
    [{ contacts: 'Arzt' }, 'contacts'],
    [{ allergies: 'x'.repeat(301) }, 'allergies'],
    [{ medications: 'x'.repeat(301) }, 'medications'],
    [{ conditions: 'x'.repeat(301) }, 'conditions'],
    [{ notes: 'x'.repeat(501) }, 'notes'],
    [{ allergies: 42 }, 'allergies'],
    [{ bloodType: 'C+' }, 'bloodType'],
    [{ weightKg: 'schwer' }, 'weightKg'],
    [{ weightKg: 900 }, 'weightKg'],
    [{ insurance: { name: 'x'.repeat(61) } }, 'insurance'],
    [{ insurance: { number: 'x'.repeat(41) } }, 'insurance'],
    [{ insurance: 'AOK' }, 'insurance'],
  ];
  for (const [body, field] of cases) {
    const r = await put(body);
    assert.deepEqual([r.status, r.json.code, r.json.field], [400, 'invalid', field], JSON.stringify(body).slice(0, 80));
    assert.ok(!JSON.stringify(r.json).includes('abc') || field !== 'contacts.0.phone', 'no value in the answer');
  }
  assert.equal((await put({ allergies: 'x'.repeat(300), notes: 'y'.repeat(500), contacts: new Array(10).fill({ label: 'A', phone: '1' }) })).status, 200, 'the limits themselves are fine');
  assert.equal((await put({ bloodType: 'unknown' })).json.member.bloodType, 'unknown');
  assert.equal((await put({ bloodType: 'ab+' })).json.member.bloodType, 'AB+');
  const fam = await as(ANNA)('PUT', '/emergency/contacts', { contacts: new Array(21).fill({ label: 'A', phone: '1' }) });
  assert.deepEqual([fam.status, fam.json.field], [400, 'contacts']);
  assert.equal((await as(ANNA)('PUT', '/emergency/contacts', {})).json.field, 'contacts');
  assert.equal((await as(ANNA)('PUT', '/emergency/contacts', { contacts: new Array(20).fill({ label: 'A', phone: '1' }) })).status, 200);
}));

test('health data never in a push or a log; not for device trust or a wall tablet; removed with the member', () => withFamily({ settings: { mod_wall: true } }, async (host, { as, admin, call }) => {
  await as(TIM)('PUT', `/emergency/members/${TIM.id}`, CARD);
  await as(ANNA)('PUT', `/emergency/members/${TIM.id}`, { contacts: [{ label: 'Arzt', phone: 'kaputt' }] });
  await call(app(ANNA), 'PUT', '/emergency/members/abc', { allergies: 'Erdnüsse' });
  await host.tick();
  const everything = JSON.stringify(host.notifications) + JSON.stringify(host.logs);
  for (const secret of ['Erdnüsse', 'Adrenalin', 'A123454821', 'kaputt', '0221 123 456']) assert.ok(!everything.includes(secret), secret);
  // device trust: no health data
  const trust = await call(portal(ANNA, false), 'GET', '/emergency');
  assert.deepEqual([trust.status, trust.json.code], [403, 'login_required']);
  assert.equal((await call(portal(ANNA, true), 'GET', '/emergency')).status, 200);
  // a wall tablet: never
  await admin('POST', 'members', { userId: 7, role: 'wall' });
  assert.equal((await call(portal({ id: 7, name: 'Küche', role: 'user' }), 'GET', '/emergency')).json.code, 'forbidden');
  // removed member: card gone
  await admin('DELETE', 'members/' + TIM.id);
  await admin('POST', 'members', { userId: TIM.id, role: 'child', birthdate: '2017-01-01' });
  assert.equal((await as(ANNA)('GET', '/emergency')).json.members.find((m) => m.userId === TIM.id).allergies, '');
}));
