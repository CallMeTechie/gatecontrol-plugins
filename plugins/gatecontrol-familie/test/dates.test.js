'use strict';

// Dates and birthdays: occurrences between from and to (yearly repeat,
// 29 February → 28 February in other years, multi-day events), member
// birthdays as read-only virtual events, every member may edit, reminders
// from 08:00 local once per occurrence.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withFamily, ANNA, MARC, LENA, TIM, MIN, DAY, pushes } = require('./helpers');
const dates = require('../server/dates');

test('expansion: yearly from the base date on, 29 February in other years, multi-day overlap', () => {
  const leap = { id: 1, date: '2008-02-29', endDate: null, repeat: 'yearly' };
  assert.deepEqual(dates.occurrences(leap, '2026-01-01', '2026-12-31'), [{ date: '2026-02-28', endDate: null }]);
  assert.deepEqual(dates.occurrences(leap, '2028-01-01', '2028-12-31'), [{ date: '2028-02-29', endDate: null }]);
  assert.deepEqual(dates.occurrences(leap, '2007-01-01', '2008-12-31'), [{ date: '2008-02-29', endDate: null }], 'nothing before the base date');
  assert.equal(dates.inYear('2008-02-29', 2100), '2100-02-28', '2100 is no leap year');
  assert.equal(dates.inYear('2008-02-29', 2000), '2000-02-29');
  const camp = { id: 2, date: '2026-10-12', endDate: '2026-10-16', repeat: 'none' };
  assert.deepEqual(dates.occurrences(camp, '2026-10-14', '2026-10-20'), [{ date: '2026-10-12', endDate: '2026-10-16' }], 'started before, still running');
  assert.deepEqual(dates.occurrences(camp, '2026-10-17', '2026-10-20'), []);
  const ny = { id: 3, date: '2025-12-31', endDate: '2026-01-01', repeat: 'yearly' };
  assert.deepEqual(dates.occurrences(ny, '2027-01-01', '2027-01-05'), [{ date: '2026-12-31', endDate: '2027-01-01' }], 'a yearly span crossing the year');
});

test('API: create / edit / delete by every member; occurrences with member birthdays; checks', () => withFamily({}, async (host, { as, admin }) => {
  const e = await as(TIM)('POST', '/dates', { title: 'Elternabend 4b', date: '2026-10-14', time: '19:00', memberIds: [ANNA.id], remindDays: 0, note: 'Raum 12' });
  assert.equal(e.status, 200);
  assert.deepEqual(e.json.event, {
    id: e.json.event.id, title: 'Elternabend 4b', date: '2026-10-14', time: '19:00', endDate: null, allDay: false, repeat: 'none', memberIds: [ANNA.id],
    kind: 'event', remindDays: 0, note: 'Raum 12', baseDate: '2026-10-14', years: null, readOnly: false, createdBy: TIM.id,
    place: null, endTime: null, origin: null,
  });
  const helga = await as(ANNA)('POST', '/dates', { title: 'Oma Helga', date: '1946-10-20', kind: 'birthday', remindDays: 3 });
  assert.deepEqual([helga.json.event.repeat, helga.json.event.allDay, helga.json.event.time], ['yearly', true, null]);
  await admin('PATCH', 'members/' + TIM.id, { birthdate: '2016-11-09' });
  const g = await as(LENA)('GET', '/dates', null, { from: '2026-10-14', to: '2026-11-30' });
  assert.deepEqual(g.json.events.map((x) => [x.id, x.date, x.title, x.years]), [
    [e.json.event.id, '2026-10-14', 'Elternabend 4b', null],
    [helga.json.event.id, '2026-10-20', 'Oma Helga', 80],
    ['member:5', '2026-11-09', 'Tim', 10],
  ]);
  const tim = g.json.events[2];
  assert.deepEqual([tim.kind, tim.repeat, tim.memberIds, tim.readOnly, tim.allDay, tim.baseDate], ['birthday', 'yearly', [TIM.id], true, true, '2016-11-09']);
  assert.equal((await as(ANNA)('PATCH', '/dates/member:5', { title: 'x' })).json.code, 'read_only');
  assert.equal((await as(ANNA)('DELETE', '/dates/member%3A5')).json.code, 'read_only');
  const p = await as(MARC)('PATCH', `/dates/${e.json.event.id}`, { time: null, endDate: '2026-10-15' });
  assert.deepEqual([p.json.event.allDay, p.json.event.time, p.json.event.endDate, p.json.event.title], [true, null, '2026-10-15', 'Elternabend 4b']);
  assert.equal((await as(LENA)('DELETE', `/dates/${e.json.event.id}`)).status, 200, 'children too');
  assert.equal((await as(LENA)('DELETE', `/dates/${e.json.event.id}`)).status, 404);
  for (const bad of [{ title: 'x' }, { title: '', date: '2026-10-14' }, { title: 'x', date: '2026-10-14', time: '7:00' }, { title: 'x', date: '2026-10-14', endDate: '2026-10-13' },
    { title: 'x', date: '2026-10-14', remindDays: 15 }, { title: 'x', date: '2026-10-14', repeat: 'weekly' }, { title: 'x', date: '2026-10-14', memberIds: [99] }]) {
    assert.equal((await as(ANNA)('POST', '/dates', bad)).json.code, 'invalid', JSON.stringify(bad));
  }
  assert.equal((await as(ANNA)('GET', '/dates', null, { from: '2026-01-01', to: '2027-02-06' })).json.code, 'invalid', 'more than 400 days');
  assert.equal((await as(ANNA)('GET', '/dates', null, { from: '2026-01-01', to: '2027-02-05' })).status, 200, '400 days');
  const def = await as(ANNA)('GET', '/dates');
  assert.deepEqual([def.json.from, def.json.to], ['2026-10-14', '2026-12-13'], 'default: today + 60 days');
  const ov = await as(ANNA)('GET', '/overview');
  assert.deepEqual(ov.json.dates.next.map((x) => x.title), ['Oma Helga'], 'next 14 days');
}));

test('reminders: from 08:00 local, remindDays before, once per occurrence; member birthdays to everyone else', () => withFamily({}, async (host, { as, admin, clock }) => {
  await as(ANNA)('POST', '/dates', { title: 'Oma Helga', date: '1946-10-17', kind: 'birthday', remindDays: 3 });
  await as(ANNA)('POST', '/dates', { title: 'Zahnarzt Lena', date: '2026-10-15', time: '09:30', memberIds: [LENA.id, ANNA.id], remindDays: 1 });
  await as(ANNA)('POST', '/dates', { title: 'Ohne Erinnerung', date: '2026-10-14' });
  await admin('PATCH', 'members/' + TIM.id, { birthdate: '2016-10-15' });
  clock.set(Date.UTC(2026, 9, 14, 5, 59)); // 07:59 Berlin
  await host.tick();
  assert.equal(pushes(host, 'date').length, 0);
  clock.add(MIN);
  await host.tick();
  const p = pushes(host, 'date');
  assert.deepEqual(p.map((x) => x.title).sort(), ['Morgen: Zahnarzt Lena', 'Oma Helga wird in 3 Tagen 80']);
  const zahn = p.find((x) => x.title.startsWith('Morgen'));
  assert.deepEqual(zahn.users.sort(), [ANNA.id, LENA.id]);
  assert.equal(zahn.body, 'Do, 15.10. · 09:30');
  assert.equal(zahn.topic, 'dates');
  assert.equal(zahn.data.familie.type, 'date');
  assert.equal(zahn.data.familie.date, '2026-10-15');
  const helga = p.find((x) => x.title.startsWith('Oma'));
  assert.equal(helga.users.length, 4, 'no members: everyone');
  await host.tick();
  assert.equal(pushes(host, 'date').length, 2, 'once per occurrence');
  // the next day: Tim's birthday (on the day) to everyone but Tim
  clock.add(DAY);
  await host.tick();
  const tim = pushes(host, 'date').slice(2);
  assert.deepEqual(tim.map((x) => x.title), ['Tim wird heute 10']);
  assert.deepEqual(tim[0].users.sort(), [ANNA.id, MARC.id, LENA.id]);
  assert.equal(tim[0].data.familie.eventId, 'member:5');
  await admin('PUT', 'modules', { dates: false });
  clock.add(DAY * 2);
  await host.tick();
  assert.equal(pushes(host, 'date').length, 3, 'module off: nothing');
}));
