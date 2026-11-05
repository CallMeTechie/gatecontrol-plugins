'use strict';

// 1.18.0 — „Internet zu Hause“ (GateControl ≥ 1.231.0, gc.homeNetwork.internet of the mock host): parents pause the
// internet of a minor child at home or give it more time today; GateControl only checks that a signed-in person asks,
// Familie checks that this person is a parent and the target a minor child of the family. The child is told (topic
// „Internet zu Hause“), the card shows who did it and when (Familie's own log). Without the API nothing is offered.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withFamily, ADMIN, ANNA, MARC, LENA, TIM, OMA, MIN, HOUR, DAY, T0, portal, kioskViewer, pushes } = require('./helpers');
const store = require('../server/store');
const internet = require('../server/internet');

// T0 = Wed 2026-10-14 10:00 Berlin (08:00Z). Tim's profile blocks social networks, games and videos from 21:00 (19:00Z).
const SCHEDULE = { from: '2026-10-14T19:00:00.000Z', to: '2026-10-15T05:00:00.000Z', block: 'categories', categories: ['social', 'games', 'video'], active: false };
const PEOPLE = () => ({
  [TIM.id]: { devices: 2, profile: { id: 1, name: 'Kinder', gateway: 'Pi Keller' }, nextSchedule: { ...SCHEDULE } },
  [LENA.id]: { devices: 1, profile: { id: 1, name: 'Kinder', gateway: 'Pi Keller' }, nextSchedule: null },
});
const ON = (extra = {}) => ({ homeInternet: { people: PEOPLE() }, ...extra });
const Z = (s) => new Date(s).toISOString().replace('.000Z', 'Z');

test('without GateControl 1.231.0: available false, nothing to change, nothing breaks', async () => {
  for (const extra of [{}, { gatecontrol: '1.230.0' }, { gatecontrol: '1.230.0', homeNetwork: {} }]) {
    await withFamily(extra, async (host, { as }) => {
      assert.ok(!(host.gc.homeNetwork && host.gc.homeNetwork.internet));
      assert.deepEqual((await as(ANNA)('GET', '/internet')).json, { ok: true, internet: { available: false, manage: true, children: [] } });
      for (const op of ['pause', 'resume', 'extend']) {
        const r = await as(ANNA)('POST', `/internet/${TIM.id}/${op}`, { minutes: 30 });
        assert.deepEqual([r.status, r.json.code], [409, 'unavailable'], op);
      }
      await host.tick();
      assert.ok(!host.logs.some((l) => l.level === 'warn' || l.level === 'error'), JSON.stringify(host.logs));
    });
  }
});

test('GET internet: parents see every minor child, a child only itself, read only; others nothing', () => withFamily(ON(), async (host, { as, call, admin }) => {
  // an adult child (18+) is not offered
  assert.equal((await admin('POST', 'members', { userId: OMA.id, role: 'child', birthdate: '2000-01-01' })).status, 200);
  const g = (await as(ANNA)('GET', '/internet')).json.internet;
  assert.deepEqual([g.available, g.manage], [true, true]);
  assert.deepEqual(g.children.map((c) => c.userId), [LENA.id, TIM.id]);
  const tim = g.children.find((c) => c.userId === TIM.id);
  assert.deepEqual({ ...tim, avatarUrl: undefined, color: undefined, colorHex: undefined, initials: undefined }, {
    userId: TIM.id, name: 'Tim', avatarUrl: undefined, color: undefined, colorHex: undefined, initials: undefined,
    paused: null, pausedBy: null, extended: null, extendedBy: null,
    nextSchedule: { from: '2026-10-14T19:00:00Z', to: '2026-10-15T05:00:00Z', block: 'categories', categories: ['social', 'games', 'video'], active: false },
    profile: 'Kinder', devices: 2, filtered: true, error: null,
  });
  assert.ok(tim.colorHex && tim.initials, 'the face of the account');
  // a child: itself, no rights
  const own = (await as(TIM)('GET', '/internet')).json.internet;
  assert.deepEqual([own.manage, own.children.map((c) => c.userId)], [false, [TIM.id]]);
  // no member, device trust only
  assert.equal((await as(ADMIN)('GET', '/internet')).json.code, 'not_member');
  const trust = await call(portal(ANNA, false), 'GET', '/internet');
  assert.deepEqual([trust.status, trust.json.code], [403, 'login_required']);
}));

test('pause: only a parent, only a minor child; GateControl gets the parent as actor, the child a message', () => withFamily(ON(), async (host, { as, call, admin, clock }) => {
  // the rights — Familie's, not GateControl's
  for (const [user, id, status, code] of [[TIM, TIM.id, 403, 'parents_only'], [LENA, TIM.id, 403, 'parents_only'], [ANNA, MARC.id, 404, 'not_found'],
    [ANNA, 999, 404, 'not_found'], [ANNA, 'x', 404, 'not_found']]) {
    const r = await as(user)('POST', `/internet/${id}/pause`, { minutes: 30 });
    assert.deepEqual([r.status, r.json.code], [status, code], `${user.name} → ${id}`);
  }
  assert.equal((await admin('POST', 'members', { userId: OMA.id, role: 'child', birthdate: '2000-01-01' })).status, 200);
  assert.equal((await as(ANNA)('POST', `/internet/${OMA.id}/pause`, { minutes: 30 })).json.code, 'not_found', 'an adult child');
  const trust = await call(portal(ANNA, false), 'POST', `/internet/${TIM.id}/pause`, { minutes: 30 });
  assert.deepEqual([trust.status, trust.json.code], [403, 'login_required']);
  // a paired kiosk device signs in for Familie, but GateControl wants a person
  const kiosk = await call(kioskViewer(ANNA), 'POST', `/internet/${TIM.id}/pause`, { minutes: 30 });
  assert.deepEqual([kiosk.status, kiosk.json.code], [403, 'not_person']);
  assert.equal(host.homeInternet.log.length, 0);
  assert.equal(pushes(host, 'internet').length, 0);

  const r = await as(ANNA)('POST', `/internet/${TIM.id}/pause`, { minutes: 30, userId: LENA.id });
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.child.userId, r.json.child.paused, r.json.child.pausedBy], [TIM.id, Z(T0 + 30 * MIN), { userId: ANNA.id, name: 'Anna', at: Z(T0) }]);
  assert.deepEqual(host.homeInternet.log, [{ op: 'pause', userId: TIM.id, until: new Date(T0 + 30 * MIN).toISOString(), actors: [ANNA.id] }]);
  const [n] = pushes(host, 'internet');
  assert.deepEqual([n.topic, n.users, n.title, n.body], [
    'internet', [TIM.id], 'Internet-Pause bis 10:30', 'Anna hat das Internet zu Hause pausiert. GateControl funktioniert weiter.',
  ]);
  assert.deepEqual(n.data.familie, { type: 'internet', kind: 'pause', userId: TIM.id, until: Z(T0 + 30 * MIN), by: ANNA.id });
  // the card a minute later (Marc's view): who and when
  clock.add(MIN);
  const tim = (await as(MARC)('GET', '/internet')).json.internet.children.find((c) => c.userId === TIM.id);
  assert.deepEqual([tim.paused, tim.pausedBy.name, tim.pausedBy.at], [Z(T0 + 30 * MIN), 'Anna', Z(T0)]);
  // „+30 Min.“ on a running pause: from its end (Marc is now the one who set it)
  const more = (await as(MARC)('POST', `/internet/${TIM.id}/pause`, { add: 30 })).json.child;
  assert.deepEqual([more.paused, more.pausedBy.name], [Z(T0 + 60 * MIN), 'Marc']);
  assert.equal(pushes(host, 'internet').at(-1).title, 'Internet-Pause bis 11:00');
  // a pause set elsewhere (e.g. by an administrator): no „von …“
  host.homeInternetSet(TIM.id, { pause: T0 + 2 * HOUR });
  assert.equal((await as(ANNA)('GET', '/internet')).json.internet.children.find((c) => c.userId === TIM.id).pausedBy, null);
}));

test('pause until a time: the next such time in the family\'s zone, ISO times, the limits', () => withFamily(ON(), async (host, { as }) => {
  const pause = (body) => as(ANNA)('POST', `/internet/${LENA.id}/pause`, body);
  // 10:00 → „bis 7 Uhr“ is tomorrow 07:00 Berlin
  let r = await pause({ until: '07:00' });
  assert.equal(r.json.child.paused, '2026-10-15T05:00:00Z');
  assert.equal(pushes(host, 'internet').at(-1).title, 'Internet-Pause bis morgen 07:00');
  r = await pause({ until: '18:30' });
  assert.equal(r.json.child.paused, '2026-10-14T16:30:00Z');
  r = await pause({ until: '2026-10-16T08:00:00Z' });
  assert.equal(r.json.child.paused, '2026-10-16T08:00:00Z');
  assert.equal(pushes(host, 'internet').at(-1).title, 'Internet-Pause bis Fr, 16.10. 10:00');
  // without a running pause „+30“ counts from now
  await as(ANNA)('POST', `/internet/${LENA.id}/resume`);
  assert.equal((await pause({ add: 30 })).json.child.paused, Z(T0 + 30 * MIN));
  for (const body of [{}, { minutes: 30, until: '18:00' }, { minutes: 0 }, { minutes: 7 * 24 * 60 + 1 }, { minutes: '30' }, { until: '25:00' }, { until: '2026-10-14T07:00:00Z' },
    { until: '2026-10-30T08:00:00Z' }, { until: 7 }, { add: 0 }, { add: 24 * 60 + 1 }]) {
    const x = await pause(body);
    assert.deepEqual([x.status, x.json.code], [400, 'invalid'], JSON.stringify(body));
  }
  assert.deepEqual(internet.nextAt('07:00', T0, 'Europe/Berlin'), Date.parse('2026-10-15T05:00:00Z'));
}));

test('resume: the child is told; nothing running → nothing logged, nobody told', () => withFamily(ON(), async (host, { as }) => {
  const before = pushes(host, 'internet').length;
  const none = await as(ANNA)('POST', `/internet/${TIM.id}/resume`);
  assert.deepEqual([none.status, none.json.child.paused], [200, null]);
  assert.equal(pushes(host, 'internet').length, before);
  await as(ANNA)('POST', `/internet/${TIM.id}/pause`, { minutes: 60 });
  const r = (await as(MARC)('POST', `/internet/${TIM.id}/resume`)).json.child;
  assert.deepEqual([r.paused, r.pausedBy], [null, null]);
  const n = pushes(host, 'internet').at(-1);
  assert.deepEqual([n.title, n.body, n.data.familie.kind], ['Das Internet ist wieder an', 'Marc hat die Pause beendet.', 'resume']);
  assert.deepEqual(host.homeInternet.log.map((x) => [x.op, x.actors]), [['pause', [ANNA.id]], ['resume', [MARC.id]]]);
}));

test('„Heute länger“: until the blocked time starts + minutes, from the end of a running extension; 0 ends it', () => withFamily(ON(), async (host, { as, clock }) => {
  const extend = (body, child = TIM) => as(ANNA)('POST', `/internet/${child.id}/extend`, body);
  // 10:00, the block starts at 21:00: +30 → until 21:30 (the times suspended from now on)
  let c = (await extend({ minutes: 30 })).json.child;
  assert.deepEqual([c.extended, c.extendedBy.name], ['2026-10-14T19:30:00Z', 'Anna']);
  let n = pushes(host, 'internet').at(-1);
  assert.deepEqual([n.title, n.body], ['Heute länger: bis 21:30', 'Anna hat die Sperrzeiten zu Hause bis 21:30 aufgehoben.']);
  // a running extension: from its end
  c = (await extend({ minutes: 60 })).json.child;
  assert.equal(c.extended, '2026-10-14T20:30:00Z');
  // GateControl's limit of 24 hours ahead → invalid
  const tooFar = await extend({ minutes: 24 * 60 });
  assert.deepEqual([tooFar.status, tooFar.json.code], [400, 'invalid']);
  // 0 ends it
  c = (await extend({ minutes: 0 })).json.child;
  assert.deepEqual([c.extended, c.extendedBy], [null, null]);
  n = pushes(host, 'internet').at(-1);
  assert.deepEqual([n.title, n.data.familie.kind], ['Die Extra-Zeit ist vorbei', 'extend_end']);
  const count = pushes(host, 'internet').length;
  await extend({ minutes: 0 });
  assert.equal(pushes(host, 'internet').length, count, 'nothing running: nobody told');
  // fromNow, no blocked time ahead (Lena), a block already running: from now
  assert.equal((await extend({ minutes: 30, fromNow: true })).json.child.extended, Z(T0 + 30 * MIN));
  assert.equal((await extend({ minutes: 30 }, LENA)).json.child.extended, Z(T0 + 30 * MIN));
  host.homeInternetSet(TIM.id, { extend: null, nextSchedule: { ...SCHEDULE, from: '2026-10-14T07:00:00.000Z', active: true } });
  assert.equal((await extend({ minutes: 60 })).json.child.extended, Z(T0 + 60 * MIN));
  for (const body of [{}, { minutes: -1 }, { minutes: 24 * 60 + 1 }, { minutes: '30' }, { minutes: 1.5 }]) {
    const x = await extend(body);
    assert.deepEqual([x.status, x.json.code], [400, 'invalid'], JSON.stringify(body));
  }
  // what ended is gone from the card
  clock.add(2 * HOUR);
  const tim = (await as(ANNA)('GET', '/internet')).json.internet.children.find((x) => x.userId === TIM.id);
  assert.deepEqual([tim.extended, tim.extendedBy], [null, null]);
  assert.deepEqual(internet.extendMinutes({ minutes: 30 }, { extended: null, nextSchedule: { from: new Date(T0 + 23 * HOUR + 50 * MIN).toISOString(), active: false } }, T0), 30, 'over 24 h: from now');
}));

test('a child without devices at home: not filtered, still answered; English notifications', () => withFamily(ON({ settings: { notify_lang: 'en' } }), async (host, { as }) => {
  host.homeInternetSet(LENA.id, { devices: 0 });
  const lena = (await as(ANNA)('GET', '/internet')).json.internet.children.find((c) => c.userId === LENA.id);
  assert.deepEqual([lena.filtered, lena.devices, lena.profile, lena.nextSchedule], [false, 0, null, null]);
  await as(ANNA)('POST', `/internet/${TIM.id}/pause`, { until: '07:00' });
  const n = pushes(host, 'internet').at(-1);
  assert.deepEqual([n.title, n.body], ['Internet paused until tomorrow 07:00', 'Anna paused the internet at home. GateControl keeps working.']);
  await as(ANNA)('POST', `/internet/${TIM.id}/extend`, { minutes: 30 });
  assert.equal(pushes(host, 'internet').at(-1).title, 'Longer today: until 21:30');
}));

test('the log of who did it is kept 90 days', () => withFamily(ON(), async (host, { as, clock }) => {
  await as(ANNA)('POST', `/internet/${TIM.id}/pause`, { minutes: 30 });
  assert.equal((await store.all(host.gc, 'SELECT * FROM internet_log')).length, 1);
  clock.add(91 * DAY);
  await host.tick();
  assert.equal((await store.all(host.gc, 'SELECT * FROM internet_log')).length, 0);
}));
