'use strict';

// Pocket money (module allowance, bookkeeping only): who sees and books what,
// the payout at 07:00 on the payout day exactly once per period (ticks,
// restarts, catch-up, never before the rule was switched on), stars →
// money only on request of the child and approval of a parent (convertible =
// earned − converted − pending; the weekly star counter stays), pushes.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withFamily, ANNA, MARC, LENA, TIM, OMA, MIN, HOUR, DAY, pushes } = require('./helpers');
const allowance = require('../server/allowance');

const ON = { settings: { mod_allowance: true } };
/** Saturday 2026-10-17 in Berlin (CEST): hh:mm local → ms */
const SAT = (hh, mm = 0) => Date.UTC(2026, 9, 17, hh - 2, mm);

test('payout dates: weekly on a weekday, monthly on a day 1–28; period keys; money in de and en', () => {
  const w = { interval: 'weekly', weekday: 6, dayOfMonth: null };
  assert.equal(allowance.payoutOnOrBefore(w, '2026-10-14'), '2026-10-10');
  assert.equal(allowance.payoutOnOrBefore(w, '2026-10-17'), '2026-10-17');
  assert.equal(allowance.payoutAfter(w, '2026-10-17'), '2026-10-24');
  assert.equal(allowance.payoutAfter(w, '2026-10-14'), '2026-10-17');
  const m = { interval: 'monthly', weekday: null, dayOfMonth: 1 };
  assert.equal(allowance.payoutOnOrBefore(m, '2026-10-14'), '2026-10-01');
  assert.equal(allowance.payoutOnOrBefore({ ...m, dayOfMonth: 20 }, '2026-01-14'), '2025-12-20');
  assert.equal(allowance.payoutAfter({ ...m, dayOfMonth: 20 }, '2026-12-20'), '2027-01-20');
  assert.deepEqual([allowance.periodKey(w, '2026-10-17'), allowance.periodKey(m, '2026-10-01')], ['w:2026-10-17', 'm:2026-10']);
  assert.deepEqual([allowance.euro(500, 'de'), allowance.euro(-850, 'de'), allowance.euro(1234567, 'en')], ['5,00 €', '−8,50 €', '€12345.67']);
});

test('who sees what: parents every child, a child only itself; parents book, set the rule, decide', () => withFamily(ON, async (host, { as }) => {
  const a = (await as(ANNA)('GET', '/allowance')).json;
  assert.deepEqual(a.accounts.map((x) => x.childId), [LENA.id, TIM.id]);
  assert.equal(a.currency, 'EUR');
  assert.deepEqual(a.accounts[1], {
    childId: TIM.id, name: 'Tim', balanceCents: 0, rule: { amountCents: 0, interval: 'weekly', weekday: 6, dayOfMonth: null, active: false }, starRate: null,
    nextPayout: null, nextPayoutAt: null, stars: { earned: 0, converted: 0, pending: 0, convertible: 0 }, bookings: [], requests: [],
  });
  assert.deepEqual((await as(TIM)('GET', '/allowance')).json.accounts.map((x) => x.childId), [TIM.id]);
  for (const [m, p, b] of [['POST', `/allowance/${TIM.id}/bookings`, { cents: 100 }], ['PUT', `/allowance/${TIM.id}/rule`, { amountCents: 500 }], ['POST', '/allowance/requests/1/approve']]) {
    assert.equal((await as(LENA)(m, p, b)).json.code, 'parents_only', `${m} ${p}`);
  }
  assert.equal((await as(ANNA)('POST', `/allowance/${ANNA.id}/bookings`, { cents: 100 })).status, 404, 'parents have no account');
  assert.equal((await as(ANNA)('POST', `/allowance/${OMA.id}/bookings`, { cents: 100 })).status, 404);
  for (const bad of [{ cents: 0 }, { cents: 1.5 }, { cents: '100' }, { cents: 100, kind: 'stars' }, { cents: 100, note: 'x'.repeat(81) }, { cents: 100000001 }]) {
    assert.equal((await as(ANNA)('POST', `/allowance/${TIM.id}/bookings`, bad)).json.code, 'invalid', JSON.stringify(bad));
  }
  // a spend is always negative; only parent bookings take the balance below zero
  const b1 = (await as(ANNA)('POST', `/allowance/${TIM.id}/bookings`, { cents: 300, note: 'Oma zum Geburtstag' })).json;
  assert.deepEqual([b1.booking.cents, b1.booking.kind, b1.booking.note, b1.booking.by, b1.balanceCents], [300, 'manual', 'Oma zum Geburtstag', ANNA.id, 300]);
  const b2 = (await as(MARC)('POST', `/allowance/${TIM.id}/bookings`, { cents: 850, kind: 'spend', note: 'Kino mit Mia' })).json;
  assert.deepEqual([b2.booking.cents, b2.balanceCents], [-850, -550]);
  assert.equal((await as(ANNA)('POST', `/allowance/${TIM.id}/bookings`, { cents: -100, kind: 'spend' })).json.booking.cents, -100);
  const t = (await as(TIM)('GET', '/allowance')).json.accounts[0];
  assert.deepEqual([t.balanceCents, t.bookings.map((x) => x.cents)], [-650, [-100, -850, 300]], 'newest first');
  // remove a manual booking (addition); never an automatic one
  assert.equal((await as(TIM)('DELETE', `/allowance/${TIM.id}/bookings/${b1.booking.id}`)).json.code, 'parents_only');
  assert.equal((await as(ANNA)('DELETE', `/allowance/${TIM.id}/bookings/${b1.booking.id}`)).json.balanceCents, -950);
  assert.equal((await as(ANNA)('DELETE', `/allowance/${LENA.id}/bookings/${b2.booking.id}`)).status, 404, 'another child\'s booking');
}));

test('rule: validation and partial updates; nextPayout', () => withFamily(ON, async (host, { as }) => {
  const anna = as(ANNA);
  for (const bad of [{ amountCents: -1 }, { amountCents: 100001 }, { interval: 'daily' }, { weekday: 8 }, { interval: 'monthly', dayOfMonth: 29 }, { active: 'yes' }, { starRate: { stars: 0, cents: 100 } }, { starRate: 5 }]) {
    assert.equal((await anna('PUT', `/allowance/${TIM.id}/rule`, bad)).json.code, 'invalid', JSON.stringify(bad));
  }
  let a = (await anna('PUT', `/allowance/${TIM.id}/rule`, { amountCents: 500, weekday: 6, active: true, starRate: { stars: 10, cents: 100 } })).json.account;
  assert.deepEqual([a.rule, a.starRate, a.nextPayout, a.nextPayoutAt], [{ amountCents: 500, interval: 'weekly', weekday: 6, dayOfMonth: null, active: true }, { stars: 10, cents: 100 }, '2026-10-17', '2026-10-17T05:00:00Z']);
  a = (await anna('PUT', `/allowance/${TIM.id}/rule`, { interval: 'monthly', dayOfMonth: 15 })).json.account;
  assert.deepEqual([a.rule, a.starRate, a.nextPayout], [{ amountCents: 500, interval: 'monthly', weekday: null, dayOfMonth: 15, active: true }, { stars: 10, cents: 100 }, '2026-10-15']);
  a = (await anna('PUT', `/allowance/${TIM.id}/rule`, { active: false, starRate: null })).json.account;
  assert.deepEqual([a.rule.active, a.starRate, a.nextPayout], [false, null, null]);
}));

test('payout: at 07:00 on the payout day, once per period (ticks, restarts), push to the child', () => withFamily(ON, async (host, { as, clock }) => {
  await as(ANNA)('PUT', `/allowance/${TIM.id}/rule`, { amountCents: 500, weekday: 6, active: true });
  await as(ANNA)('PUT', `/allowance/${LENA.id}/rule`, { amountCents: 2000, interval: 'monthly', dayOfMonth: 1, active: true });
  clock.set(SAT(6, 59));
  await host.tick();
  assert.equal(pushes(host, 'allowance_paid').length, 0, 'not before 07:00');
  clock.set(SAT(7, 0));
  await host.tick();
  await host.tick();
  host.plugin._state.lastPurge = 0;
  await host.start(); // a restart
  await host.tick();
  clock.add(HOUR);
  await host.tick();
  const p = pushes(host, 'allowance_paid');
  assert.equal(p.length, 1, 'once per period');
  assert.deepEqual([p[0].topic, p[0].users, p[0].title, p[0].data.familie.childId, p[0].data.familie.cents], ['allowance', [TIM.id], 'Dein Taschengeld ist da: 5,00 €', TIM.id, 500]);
  let t = (await as(TIM)('GET', '/allowance')).json.accounts[0];
  assert.deepEqual([t.balanceCents, t.bookings.map((x) => [x.kind, x.cents, x.by])], [500, [['allowance', 500, null]]]);
  assert.equal(t.nextPayout, '2026-10-24');
  // the next Saturday again — once
  clock.set(SAT(7, 30) + 7 * DAY);
  await host.tick();
  await host.tick();
  t = (await as(TIM)('GET', '/allowance')).json.accounts[0];
  assert.equal(t.balanceCents, 1000);
  // Lena: monthly on the 1st, never paid for October (switched on after it) — November yes
  assert.equal((await as(LENA)('GET', '/allowance')).json.accounts[0].balanceCents, 0);
  clock.set(Date.UTC(2026, 10, 1, 6, 0) + 5 * MIN); // 1 Nov 07:05 CET
  await host.tick();
  assert.equal((await as(LENA)('GET', '/allowance')).json.accounts[0].balanceCents, 2000);
  assert.equal(pushes(host, 'allowance_paid').filter((x) => x.users[0] === LENA.id)[0].title, 'Dein Taschengeld ist da: 20,00 €');
}));

test('payout: a missed period is caught up once; switching on or rescheduling never pays a past payout', () => withFamily(ON, async (host, { as, clock }) => {
  // switched on on Saturday at 10:00 — today's 07:00 was before: nothing until next Saturday
  clock.set(SAT(10));
  const a = (await as(ANNA)('PUT', `/allowance/${TIM.id}/rule`, { amountCents: 500, weekday: 6, active: true })).json.account;
  assert.equal(a.nextPayout, '2026-10-17', 'shown as today …');
  await host.tick();
  assert.equal((await as(TIM)('GET', '/allowance')).json.accounts[0].balanceCents, 0, '… but not paid: switched on after 07:00');
  // the server was down the whole next Saturday: caught up on Sunday, once
  clock.set(SAT(12) + 8 * DAY);
  await host.tick();
  await host.tick();
  const t = (await as(TIM)('GET', '/allowance')).json.accounts[0];
  assert.deepEqual([t.balanceCents, t.bookings.length], [500, 1]);
  // rescheduled to Sunday on Sunday: today's Sunday 07:00 is before the change
  await as(ANNA)('PUT', `/allowance/${TIM.id}/rule`, { weekday: 7 });
  await host.tick();
  assert.equal((await as(TIM)('GET', '/allowance')).json.accounts[0].balanceCents, 500);
  // an amount change keeps the schedule
  await as(ANNA)('PUT', `/allowance/${TIM.id}/rule`, { amountCents: 600 });
  clock.set(SAT(7, 1) + 9 * DAY); // Monday: the latest Sunday was before the change
  await host.tick();
  assert.equal((await as(TIM)('GET', '/allowance')).json.accounts[0].balanceCents, 500);
  clock.set(Date.UTC(2026, 10, 1, 6, 1)); // Sunday 1 Nov 07:01 CET
  await host.tick();
  assert.equal((await as(TIM)('GET', '/allowance')).json.accounts[0].balanceCents, 1100);
}));

test('stars → money: the child asks, a parent approves; convertible = earned − converted − pending; the weekly counter stays', () => withFamily(ON, async (host, { as, clock }) => {
  const task = (await as(ANNA)('POST', '/tasks', { title: 'Müll raus', assignees: [TIM.id], repeat: 'daily', stars: 4 })).json.task;
  for (let i = 0; i < 3; i++) { await as(TIM)('POST', `/tasks/${task.id}/done`); clock.add(DAY); }
  // 3 days later (Saturday): 12 stars earned
  assert.equal((await as(TIM)('POST', `/allowance/${TIM.id}/convert`, { stars: 10 })).json.code, 'no_star_rate');
  await as(ANNA)('PUT', `/allowance/${TIM.id}/rule`, { starRate: { stars: 10, cents: 100 } });
  let t = (await as(TIM)('GET', '/allowance')).json.accounts[0];
  assert.deepEqual(t.stars, { earned: 12, converted: 0, pending: 0, convertible: 12 });
  assert.equal((await as(TIM)('GET', '/overview')).json.allowance.convertibleStars, 12);
  // only the child itself, in multiples of the rate, not more than it has
  assert.equal((await as(ANNA)('POST', `/allowance/${TIM.id}/convert`, { stars: 10 })).json.code, 'forbidden');
  assert.equal((await as(LENA)('POST', `/allowance/${TIM.id}/convert`, { stars: 10 })).json.code, 'forbidden');
  assert.deepEqual([(await as(TIM)('POST', `/allowance/${TIM.id}/convert`, { stars: 12 })).json.code, (await as(TIM)('POST', `/allowance/${TIM.id}/convert`, { stars: 12 })).json.multipleOf], ['invalid', 10]);
  const big = await as(TIM)('POST', `/allowance/${TIM.id}/convert`, { stars: 20 });
  assert.deepEqual([big.status, big.json.code, big.json.available], [409, 'not_enough_stars', 12]);
  const from = host.notifications.length;
  const req = (await as(TIM)('POST', `/allowance/${TIM.id}/convert`, { stars: 10 })).json;
  assert.deepEqual([req.request.status, req.request.stars, req.request.cents, req.stars.pending, req.stars.convertible], ['pending', 10, 100, 10, 2]);
  assert.equal((await as(TIM)('POST', `/allowance/${TIM.id}/convert`, { stars: 10 })).json.code, 'not_enough_stars', 'pending stars are reserved');
  const ask = pushes(host, 'allowance_convert', from);
  assert.equal(ask.length, 1);
  assert.deepEqual([ask[0].topic, ask[0].users.sort(), ask[0].title], ['allowance', [ANNA.id, MARC.id], 'Tim möchte 10 ★ in 1,00 € umwandeln']);
  assert.deepEqual(ask[0].data.familie, { type: 'allowance_convert', requestId: req.request.id, childId: TIM.id, stars: 10, cents: 100 });
  assert.equal((await as(ANNA)('GET', '/overview')).json.allowance.pendingRequests, 1);
  // approve → booking 'stars', converted += 10
  const ok = (await as(MARC)('POST', `/allowance/requests/${req.request.id}/approve`)).json;
  assert.deepEqual([ok.request.status, ok.request.decidedBy, ok.balanceCents], ['approved', MARC.id, 100]);
  assert.equal((await as(ANNA)('POST', `/allowance/requests/${req.request.id}/approve`)).json.code, 'not_pending', 'only once');
  const done = pushes(host, 'allowance_decided', from);
  assert.deepEqual([done[0].users, done[0].title, done[0].data.familie.status], [[TIM.id], 'Marc hat das Umwandeln angenommen: +1,00 €', 'approved']);
  t = (await as(TIM)('GET', '/allowance')).json.accounts[0];
  assert.deepEqual(t.stars, { earned: 12, converted: 10, pending: 0, convertible: 2 });
  assert.deepEqual(t.bookings.map((x) => [x.kind, x.cents, x.note]), [['stars', 100, '10 ★']]);
  assert.equal((await as(TIM)('GET', '/tasks')).json.stars.week[TIM.id], 12, 'the weekly counter is unchanged');
  // decline: nothing booked, the stars are free again
  for (let i = 0; i < 2; i++) { await as(TIM)('POST', `/tasks/${task.id}/done`); clock.add(DAY); }
  const r2 = (await as(TIM)('POST', `/allowance/${TIM.id}/convert`, { stars: 10 })).json.request;
  await as(ANNA)('POST', `/allowance/requests/${r2.id}/decline`);
  t = (await as(TIM)('GET', '/allowance')).json.accounts[0];
  assert.deepEqual([t.stars.convertible, t.balanceCents, t.requests.map((x) => x.status)], [10, 100, ['declined', 'approved']]);
  assert.equal(pushes(host, 'allowance_decided', from)[1].title, 'Anna hat das Umwandeln von 10 ★ abgelehnt');
  assert.equal((await as(ANNA)('POST', '/allowance/requests/999/approve')).status, 404);
}));

test('stars of task rows removed by the retention stay convertible', () => withFamily(ON, async (host, { as, clock }) => {
  const task = (await as(ANNA)('POST', '/tasks', { title: 'Hund', assignees: [LENA.id], repeat: 'daily', stars: 5 })).json.task;
  await as(LENA)('POST', `/tasks/${task.id}/done`);
  clock.add(401 * DAY);
  await host.tick();
  const l = (await as(LENA)('GET', '/allowance')).json.accounts[0];
  assert.deepEqual(l.stars, { earned: 5, converted: 0, pending: 0, convertible: 5 });
}));
