'use strict';

// 1.2.0 — the school day ends earlier (server/changes.js earlyEnds, server/dayend.js): found only when a
// fetch after the baseline moves today's / tomorrow's end EARLIER, once per student, date and new end,
// only for students mapped to a user; handed to Familie's school_day_end in one call (held in the quiet
// hours, expired when no longer true, skipped without Familie). And the service school_day for Familie's
// wall tablet.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, asAdmin, setupParent, lessonAt, tickAt, at, LENA, T0 } = require('./helpers');
const changes = require('../server/changes');
const poll = require('../server/poll');
const config = require('../server/config');
const store = require('../server/store');
const dayend = require('../server/dayend');

const MIN = 60000;
const FAMILIE = 'gatecontrol-familie';
const endCalls = (host) => host.serviceCalls.filter((c) => c.plugin === FAMILIE && c.service === 'school_day_end');

function familie(o = {}) {
  const f = {
    plugin: FAMILIE, provides: ['rule_event', 'school_day_end'], got: [],
    service: async (c) => {
      if (c.name !== 'school_day_end') return { ok: true, fired: 0 };
      f.got.push({ caller: c.caller, payload: c.payload });
      if (o.throws) throw new Error('kaputt');
      return o.answer ? o.answer(c) : { ok: true, notified: 2, matched: 1 };
    },
  };
  return f;
}

async function household(host, o = {}) {
  const s = await setupParent(host, o);
  await asAdmin(host, 'PUT', `/students/${s.lena.id}`, { alias: 'Lena' });
  return s;
}

test('end of a day: the last lesson that takes place; planned: the plan with cancellations, without extra lessons', () => {
  const rows = [
    { date: '2026-10-20', t_start: '08:00', t_end: '08:45', state: 'normal' },
    { date: '2026-10-20', t_start: '11:40', t_end: '12:25', state: 'cancelled' },
    { date: '2026-10-20', t_start: '10:40', t_end: '11:25', state: 'normal', removed: true },
    { date: '2026-10-20', t_start: '09:50', t_end: '10:35', state: 'normal' },
    { date: '2026-10-20', t_start: '13:00', t_end: '13:45', state: 'normal', added: true },
  ];
  assert.equal(changes.endOf(rows, '2026-10-20'), '13:45');
  assert.equal(changes.plannedEndOf(rows, '2026-10-20'), '12:25');
  assert.equal(changes.endOf(rows.slice(0, 4), '2026-10-20'), '10:35');
  assert.equal(changes.endOf(rows, '2026-10-21'), null);
});

test('detected only when the end moves earlier after the baseline; once per date and new end; one call with the text', () => {
  const f = familie();
  return withHost({ services: [f], gatecontrol: '1.178.0' }, async (host, untis) => {
    // the baseline with the last lesson already cancelled: nothing
    lessonAt(untis, 101, 20261020, 1140).code = 'cancelled';
    const { lena } = await household(host);
    await tickAt(host, T0 + 15 * MIN);
    assert.equal(endCalls(host).length, 0, 'not on the baseline, nothing changed');
    // a lesson in the middle: the end stays
    lessonAt(untis, 101, 20261020, 850).code = 'cancelled';
    await tickAt(host, T0 + 30 * MIN);
    assert.equal(endCalls(host).length, 0);
    // the 4th lesson now too: today ends at 10:35 instead of 12:25 (the plan)
    lessonAt(untis, 101, 20261020, 1040).code = 'cancelled';
    // tomorrow's last lesson; Max (no user) as well
    lessonAt(untis, 101, 20261021, 1140).code = 'cancelled';
    lessonAt(untis, 102, 20261020, 1140).code = 'cancelled';
    await tickAt(host, T0 + 45 * MIN);
    assert.equal(endCalls(host).length, 1);
    assert.equal(f.got[0].caller, 'gatecontrol-schule');
    assert.deepEqual(f.got[0].payload, { events: [
      { userId: LENA.id, date: '2026-10-20', plannedEnd: '12:25', newEnd: '10:35', text: 'Lena hat am Di 20.10. schon um 10:35 Schluss (statt 12:25)' },
      { userId: LENA.id, date: '2026-10-21', plannedEnd: '12:25', newEnd: '11:25', text: 'Lena hat am Mi 21.10. schon um 11:25 Schluss (statt 12:25)' },
    ] });
    assert.deepEqual((await asAdmin(host, 'GET', '/status')).json.dayEnds, { available: true, last: { at: T0 + 45 * MIN, ok: true, events: 2, notified: 2, code: null } });
    // nothing new: no call; back later and earlier again to the same end: still once
    await tickAt(host, T0 + 60 * MIN);
    delete lessonAt(untis, 101, 20261020, 1040).code;
    await tickAt(host, T0 + 75 * MIN);
    lessonAt(untis, 101, 20261020, 1040).code = 'cancelled';
    await tickAt(host, T0 + 90 * MIN);
    assert.equal(endCalls(host).length, 1, 'once per date and new end');
    // even earlier: a new event, still measured against the plan
    lessonAt(untis, 101, 20261020, 950).code = 'cancelled';
    await tickAt(host, T0 + 105 * MIN);
    assert.deepEqual(f.got[1].payload.events.map((e) => [e.date, e.plannedEnd, e.newEnd]), [['2026-10-20', '12:25', '08:45']]);
    // the planned end has passed: nothing for today any more
    lessonAt(untis, 101, 20261020, 800).code = 'cancelled';
    delete lessonAt(untis, 101, 20261020, 950).code;
    await tickAt(host, at('2026-10-20T10:30:00Z')); // 12:30
    assert.equal(endCalls(host).length, 2);
    const rows = (await host.gc.db.query('SELECT student_id, date, new_end, status FROM day_ends ORDER BY date, new_end')).rows;
    assert.deepEqual(rows.map((r) => [r.student_id, r.date, r.new_end, r.status]), [
      [lena.id, '2026-10-20', '08:45', 'sent'], [lena.id, '2026-10-20', '10:35', 'sent'], [lena.id, '2026-10-21', '11:25', 'sent'],
    ]);
  });
});

test('quiet hours hold it; a lesson back meanwhile expires it; without Familie (or an old host) it is skipped', async () => {
  const f = familie();
  await withHost({ services: [f], gatecontrol: '1.178.0', now: at('2026-10-20T19:30:00Z') }, async (host, untis) => {
    await household(host);
    lessonAt(untis, 101, 20261021, 1140).code = 'cancelled';
    await tickAt(host, at('2026-10-20T20:31:00Z')); // 22:31
    await tickAt(host, at('2026-10-21T03:59:00Z')); // 05:59
    assert.equal(f.got.length, 0, 'held');
    await tickAt(host, at('2026-10-21T04:01:00Z')); // 06:01
    assert.deepEqual(f.got.map((x) => x.payload.events.map((e) => [e.date, e.newEnd])), [[['2026-10-21', '11:25']]]);
  });
  const g = familie();
  await withHost({ services: [g], gatecontrol: '1.178.0', now: at('2026-10-20T19:30:00Z') }, async (host, untis) => {
    await household(host);
    lessonAt(untis, 101, 20261021, 1140).code = 'cancelled';
    await tickAt(host, at('2026-10-20T20:31:00Z'));
    delete lessonAt(untis, 101, 20261021, 1140).code;
    await tickAt(host, at('2026-10-21T04:01:00Z'));
    assert.equal(g.got.length, 0, 'no longer true');
    assert.deepEqual((await host.gc.db.query('SELECT status FROM day_ends')).rows.map((r) => r.status), ['expired']);
  });
  for (const opts of [{ gatecontrol: '1.178.0' }, { services: [familie()] }]) {
    await withHost(opts, async (host, untis) => {
      await household(host);
      lessonAt(untis, 101, 20261020, 1140).code = 'cancelled';
      await tickAt(host, T0 + 15 * MIN);
      assert.equal(endCalls(host).length, 0);
      assert.deepEqual((await host.gc.db.query('SELECT status FROM day_ends')).rows.map((r) => r.status), ['skipped']);
      assert.equal((await asAdmin(host, 'GET', '/status')).json.accounts[0].status, 'ok');
    });
  }
});

test('errors never stop the cycle; a refusal is kept for the admin page, a rate limit retries', async () => {
  await withHost({ services: [familie({ throws: true })], gatecontrol: '1.178.0' }, async (host, untis) => {
    await household(host);
    lessonAt(untis, 101, 20261020, 1140).code = 'cancelled';
    await tickAt(host, T0 + 15 * MIN);
    assert.deepEqual((await asAdmin(host, 'GET', '/status')).json.dayEnds.last, { at: T0 + 15 * MIN, ok: false, events: 1, notified: 0, code: 'failed' });
    assert.equal(host.notifications.filter((n) => n.topic === 'changes').length, 1, 'the push as ever');
    await tickAt(host, T0 + 30 * MIN);
    assert.equal(endCalls(host).length, 1, 'not again');
  });
  const later = familie();
  await withHost({ services: [later], gatecontrol: '1.178.0' }, async (host, untis) => {
    await household(host);
    lessonAt(untis, 101, 20261020, 1140).code = 'cancelled';
    // fetch only (no dispatch): the early end is recorded
    const cfg = config.fromSettings({});
    const acc = (await store.listAccounts(host.gc))[0];
    await poll.pollAccount(host.gc, acc, cfg, T0 + 15 * MIN);
    const limitedGc = { ...host.gc, services: { available: async () => true, call: async () => { throw Object.assign(new Error('limit'), { code: 'ERR_RATE_LIMIT' }); } } };
    const r = await dayend.send(limitedGc, cfg, T0 + 15 * MIN, false);
    assert.equal(r.code, 'rate_limit');
    assert.deepEqual((await host.gc.db.query('SELECT status FROM day_ends')).rows.map((x) => x.status), ['pending']);
    const ok = await dayend.send(host.gc, cfg, T0 + 16 * MIN, false);
    assert.deepEqual([ok.ok, ok.events], [true, 1]);
    assert.deepEqual((await host.gc.db.query('SELECT status FROM day_ends')).rows.map((x) => x.status), ['sent']);
  });
});

// 1.3.0: Lena is mapped to the user LENA — her colour is that user's favourite colour (mock: palette[3] = lime)
const LENA_COLOR = '#84CC16';

test('school_day: only for Familie; the wall students mapped to a user; times, counts, holiday, exams, free', () => withHost({}, async (host, untis) => {
  untis.state.exams = [{ id: 1, examDate: 20261020, startTime: 950, endTime: 1035, subject: 'E', name: 'Vokabeltest', assignedStudents: [{ id: 101 }] }];
  const { max } = await household(host, { wall: true });
  const call = (payload, caller = FAMILIE) => host.callService('school_day', { caller, payload });
  assert.deepEqual(await call({ date: '2026-10-20' }, 'gatecontrol-messenger'), { ok: false, code: 'forbidden' });
  for (const bad of [{}, { date: 'heute' }, { date: '2026-02-30' }, { date: '2026-10-18' }, { date: '2026-11-03' }]) assert.deepEqual(await call(bad), { ok: false, code: 'invalid' }, JSON.stringify(bad));
  lessonAt(untis, 101, 20261020, 800).code = 'cancelled';
  lessonAt(untis, 101, 20261020, 1040).code = 'irregular';
  await tickAt(host, T0 + 15 * MIN);
  assert.deepEqual(await call({ date: '2026-10-20' }), { ok: true, date: '2026-10-20', students: [
    { userId: LENA.id, name: 'Lena', color: LENA_COLOR, start: '08:50', end: '12:25', cancelled: 1, changed: 1, exams: [{ subject: 'Englisch', name: 'Vokabeltest' }], free: false },
  ] });
  assert.deepEqual((await call({ date: '2026-10-24' })).students, [{ userId: LENA.id, name: 'Lena', color: LENA_COLOR, cancelled: 0, changed: 0, exams: [], free: true }], 'Saturday');
  assert.deepEqual((await call({ date: '2026-10-30' })).students, [{ userId: LENA.id, name: 'Lena', color: LENA_COLOR, cancelled: 0, changed: 0, holiday: 'Brückentag', exams: [], free: true }]);
  // Max on the wall too, but not mapped to a user: left out; Lena off the wall: nobody
  await asAdmin(host, 'PUT', `/students/${max.id}`, { show_on_wall: true });
  assert.equal((await call({ date: '2026-10-20' })).students.length, 1);
  const st = (await asAdmin(host, 'GET', '/status')).json.accounts[0].students.find((s) => s.person_id === 101);
  await asAdmin(host, 'PUT', `/students/${st.id}`, { show_on_wall: false });
  assert.deepEqual((await call({ date: '2026-10-20' })).students, []);
}));
