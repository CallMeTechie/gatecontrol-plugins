'use strict';

// 1.20.0 — „Internet zu Hause“, the rest: the rule action „Internet pausieren“ / „fortsetzen“ (as the rule's owner,
// GateControl ≥ 1.259.0: gc.homeNetwork.internet takes { actor } — checked at every run that the owner is still a
// parent and the target still a minor child), „Zeit abgelaufen“ (a pause / extra time that ran out by itself is told
// to the child), everything in the notification topic `internet`, and what GET internet answers for a parents' view
// in the apps (where the child is and from which source, who or which rule set a pause, the server's clock).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withFamily, DIR, ADMIN, ANNA, MARC, LENA, TIM, OMA, MIN, HOUR, T0, pushes } = require('./helpers');
const store = require('../server/store');
const internet = require('../server/internet');
const texts = require('../server/texts.json');
const pushTexts = require('../server/push').TEXTS;

// T0 = Wed 2026-10-14 10:00 Berlin (08:00Z)
const PEOPLE = () => ({
  [TIM.id]: { devices: 2, profile: { id: 1, name: 'Kinder', gateway: 'Pi Keller' }, nextSchedule: null },
  [LENA.id]: { devices: 1, profile: { id: 1, name: 'Kinder', gateway: 'Pi Keller' }, nextSchedule: null },
});
/** GateControl ≥ 1.259.0: „Internet zu Hause“ with { actor } */
const ON = (extra = {}) => ({ homeInternet: { people: PEOPLE(), actors: true }, ...extra });
/** GateControl 1.231.0 … 1.258.x: „Internet zu Hause“ without { actor } */
const OLD = (extra = {}) => ({ homeInternet: { people: PEOPLE() }, ...extra });
const Z = (s) => new Date(s).toISOString().replace('.000Z', 'Z');
const DINNER = (extra = {}) => ({
  title: 'Abendessen', scope: 'house', trigger: { type: 'schedule', weekdays: [1, 2, 3, 4, 5, 6, 7], time: '10:30' },
  actions: [{ type: 'internet', op: 'pause', userId: TIM.id, minutes: 30 }], ...extra,
});
const lastLog = async (as) => (await as(ANNA)('GET', '/rules')).json.log[0];
const warned = (host, what) => host.logs.some((l) => l.level === 'warn' && JSON.stringify(l).includes(what));

test('rules/options: „Internet zu Hause“ for parents with GateControl ≥ 1.259.0; the minor children', async () => {
  await withFamily(ON(), async (host, { as, admin }) => {
    assert.equal((await admin('POST', 'members', { userId: OMA.id, role: 'child', birthdate: '2000-01-01' })).status, 200);
    const o = (await as(ANNA)('GET', '/rules/options')).json.internet;
    assert.deepEqual([o.available, o.reason, o.children.map((c) => [c.userId, c.name])], [true, null, [[LENA.id, 'Lena'], [TIM.id, 'Tim']]]);
    assert.ok(o.children[0].colorHex && o.children[0].initials, 'the face of the account');
    host.settings.children_own_rules = true;
    assert.deepEqual((await as(LENA)('GET', '/rules/options')).json.internet, { available: false, reason: 'parents_only', children: [] });
    // the admin page: an administrator who is no parent of the family
    assert.deepEqual((await admin('GET', 'rules/options')).json.internet, { available: false, reason: 'parents_only', children: [] });
  });
  // an older GateControl, or none with „Internet zu Hause“: not offered
  for (const o of [OLD(), {}, { gatecontrol: '1.258.0' }]) {
    await withFamily(o, async (host, { as }) => {
      const x = (await as(ANNA)('GET', '/rules/options')).json.internet;
      assert.deepEqual([x.available, x.reason], [false, 'unavailable'], JSON.stringify(o));
    });
  }
  assert.equal(internet.actorsKnown({ homeNetwork: { internet: { status() {}, actors: true } } }), true);
  assert.equal(internet.actorsKnown({ homeNetwork: { internet: { status() {} } } }), false);
  assert.equal(internet.actorsKnown({}), false);
});

test('saving: only a parent, only for a minor child of the family; minutes or a time', () => withFamily(ON(), async (host, { as, admin }) => {
  const made = await as(ANNA)('POST', '/rules', DINNER());
  assert.equal(made.status, 200, JSON.stringify(made.json));
  assert.deepEqual(made.json.rule.actions, [{ type: 'internet', op: 'pause', userId: TIM.id, name: 'Tim', minutes: 30, until: null, available: true, problem: null }]);
  assert.equal(made.json.rule.ownerId, ANNA.id);
  // until a time, resume, a parent's own rule
  const more = await as(MARC)('POST', '/rules', DINNER({ scope: 'personal', actions: [
    { type: 'internet', op: 'pause', userId: LENA.id, until: '7:00' }, { type: 'internet', op: 'resume', userId: TIM.id, minutes: 5 }] }));
  assert.equal(more.status, 200, JSON.stringify(more.json));
  assert.deepEqual(more.json.rule.actions.map((a) => [a.op, a.userId, a.minutes, a.until]), [['pause', LENA.id, null, '07:00'], ['resume', TIM.id, null, null]]);
  // what is wrong
  const bad = async (action, field, code = 'invalid', status = 400) => {
    const r = await as(ANNA)('POST', '/rules', DINNER({ actions: [action] }));
    assert.deepEqual([r.status, r.json.code, r.json.field], [status, code, field], JSON.stringify(action));
  };
  await bad({ type: 'internet', userId: TIM.id, minutes: 30 }, 'actions.0.op');
  await bad({ type: 'internet', op: 'extend', userId: TIM.id, minutes: 30 }, 'actions.0.op');
  await bad({ type: 'internet', op: 'pause', minutes: 30 }, 'actions.0.userId');
  await bad({ type: 'internet', op: 'pause', userId: TIM.id }, 'actions.0.minutes');
  await bad({ type: 'internet', op: 'pause', userId: TIM.id, minutes: 30, until: '18:00' }, 'actions.0.minutes');
  for (const minutes of [0, 1441, 1.5, '30']) await bad({ type: 'internet', op: 'pause', userId: TIM.id, minutes }, 'actions.0.minutes');
  for (const until of ['25:00', 'abends', 7, '2026-10-14T18:00:00Z']) await bad({ type: 'internet', op: 'pause', userId: TIM.id, until }, 'actions.0.until');
  // not a minor child of the family: a parent, somebody else, an adult child
  assert.equal((await admin('POST', 'members', { userId: OMA.id, role: 'child', birthdate: '2000-01-01' })).status, 200);
  for (const userId of [MARC.id, ADMIN.id, OMA.id, 999]) await bad({ type: 'internet', op: 'pause', userId, minutes: 30 }, 'actions.0.userId');
  // children never, not even in their own rules; the administrator only as a parent of the family
  host.settings.children_own_rules = true;
  const kid = await as(LENA)('POST', '/rules', DINNER({ scope: 'personal', actions: [{ type: 'internet', op: 'resume', userId: LENA.id }] }));
  assert.deepEqual([kid.status, kid.json.code, kid.json.field], [403, 'forbidden', 'actions.0']);
  const adm = await admin('POST', 'rules', DINNER());
  assert.deepEqual([adm.status, adm.json.code, adm.json.field], [403, 'forbidden', 'actions.0']);
  // … and not by changing a parent's rule on the admin page (the actions' owner would be the administrator)
  const patched = await admin('PATCH', `rules/${made.json.rule.id}`, { actions: DINNER().actions });
  assert.deepEqual([patched.status, patched.json.code], [403, 'forbidden']);
  assert.equal((await admin('PATCH', `rules/${made.json.rule.id}`, { title: 'Essen' })).status, 200, 'everything else of the rule');
  assert.equal((await as(ANNA)('GET', '/rules')).json.rules.find((x) => x.id === made.json.rule.id).ownerId, ANNA.id);
}));

test('the rule runs in the background as its owner: GateControl gets the actor, the child a message, the log the end', () => withFamily(ON(), async (host, { as, clock }) => {
  const rule = (await as(ANNA)('POST', '/rules', DINNER())).json.rule;
  clock.set(T0 + 30 * MIN);
  await host.tick();
  assert.deepEqual(host.homeInternet.log, [{ op: 'pause', userId: TIM.id, until: new Date(T0 + 60 * MIN).toISOString(), actors: [ANNA.id], automated: true }]);
  const [n] = pushes(host, 'internet');
  assert.deepEqual([n.topic, n.users, n.title, n.body], ['internet', [TIM.id], 'Internet-Pause bis 11:00',
    'Die Regel „Abendessen“ (Anna) hat das Internet zu Hause pausiert. GateControl funktioniert weiter.']);
  assert.deepEqual(n.data.familie, { type: 'internet', kind: 'pause', userId: TIM.id, until: Z(T0 + 60 * MIN), by: ANNA.id, ruleId: rule.id });
  const log = await lastLog(as);
  assert.deepEqual([log.ruleId, log.ok, log.results], [rule.id, true, [{ type: 'internet', op: 'pause', userId: TIM.id, name: 'Tim', until: Z(T0 + 60 * MIN), unchanged: false, ok: true, error: null }]]);
  // the card: who — the rule in Anna's name
  const tim = (await as(MARC)('GET', '/internet')).json.internet.children.find((c) => c.userId === TIM.id);
  assert.deepEqual([tim.paused, tim.pausedBy], [Z(T0 + 60 * MIN), { userId: ANNA.id, name: 'Anna', at: Z(T0 + 30 * MIN), rule: { id: rule.id, title: 'Abendessen' } }]);
  // a parent's own pause afterwards: no rule
  await as(MARC)('POST', `/internet/${TIM.id}/pause`, { add: 30 });
  assert.equal((await as(MARC)('GET', '/internet')).json.internet.children.find((c) => c.userId === TIM.id).pausedBy.rule, null);
}));

test('until a time and „fortsetzen“: the next such time; nothing running → unchanged, nobody told; a rule without a name', () => withFamily(ON(), async (host, { as, clock }) => {
  await as(ANNA)('POST', '/rules', DINNER({ title: '', actions: [{ type: 'internet', op: 'pause', userId: LENA.id, until: '07:00' }, { type: 'internet', op: 'resume', userId: TIM.id }] }));
  clock.set(T0 + 30 * MIN);
  await host.tick();
  assert.deepEqual(host.homeInternet.log.map((x) => [x.op, x.userId, x.until, x.actors]), [['pause', LENA.id, '2026-10-15T05:00:00.000Z', [ANNA.id]]], 'tomorrow 07:00 Berlin; no resume without a pause');
  assert.deepEqual(pushes(host, 'internet').map((n) => [n.users, n.title, n.body]), [[[LENA.id], 'Internet-Pause bis morgen 07:00',
    'Eine Regel von Anna hat das Internet zu Hause pausiert. GateControl funktioniert weiter.']]);
  let log = await lastLog(as);
  assert.deepEqual(log.results.map((x) => [x.op, x.ok, x.unchanged, x.until]), [['pause', true, false, '2026-10-15T05:00:00Z'], ['resume', true, true, null]]);
  // the next day Tim's internet is paused by Marc: the rule ends it
  clock.set(T0 + 24 * HOUR + 20 * MIN);
  await as(MARC)('POST', `/internet/${TIM.id}/pause`, { minutes: 60 });
  clock.set(T0 + 24 * HOUR + 30 * MIN);
  await host.tick();
  assert.deepEqual(host.homeInternet.log.at(-1), { op: 'resume', userId: TIM.id, until: null, actors: [ANNA.id], automated: true });
  const n = pushes(host, 'internet').at(-1);
  assert.deepEqual([n.users, n.title, n.body, n.data.familie.kind], [[TIM.id], 'Das Internet ist wieder an', 'Eine Regel von Anna hat die Pause beendet.', 'resume']);
  log = await lastLog(as);
  assert.deepEqual(log.results.map((x) => [x.op, x.ok, x.unchanged]), [['pause', true, false], ['resume', true, false]]);
  assert.equal((await as(ANNA)('GET', '/internet')).json.internet.children.find((c) => c.userId === TIM.id).paused, null);
}));

test('the owner is no parent any more, the child no minor of the family any more: not run, logged', () => withFamily(ON(), async (host, { as, admin, clock }) => {
  const rule = (await as(ANNA)('POST', '/rules', DINNER({ actions: [
    { type: 'internet', op: 'pause', userId: TIM.id, minutes: 30 }, { type: 'internet', op: 'pause', userId: LENA.id, minutes: 30 }, { type: 'notify', to: [MARC.id], text: 'Essen!' }] }))).json.rule;
  // Lena comes of age
  assert.equal((await admin('PATCH', `members/${LENA.id}`, { birthdate: '2000-01-01' })).status, 200);
  let view = (await as(MARC)('GET', '/rules')).json.rules.find((x) => x.id === rule.id);
  assert.deepEqual(view.actions.slice(0, 2).map((a) => [a.name, a.available, a.problem]), [['Tim', true, null], ['Lena', false, 'not_found']]);
  clock.set(T0 + 30 * MIN);
  await host.tick();
  assert.deepEqual(host.homeInternet.log.map((x) => [x.op, x.userId]), [['pause', TIM.id]]);
  let log = await lastLog(as);
  assert.equal(log.ok, false);
  assert.deepEqual(log.results.map((x) => [x.type, x.ok, x.error]), [['internet', true, null], ['internet', false, 'not_found'], ['notify', true, null]], 'the rest of the rule runs');
  assert.ok(warned(host, 'internet rule action not run'));
  // Anna leaves the family: nothing of hers pauses anybody any more
  assert.equal((await admin('DELETE', `members/${ANNA.id}`)).status, 200);
  view = (await as(MARC)('GET', '/rules')).json.rules.find((x) => x.id === rule.id);
  assert.deepEqual(view.actions[0].available === false && view.actions[0].problem, 'not_allowed');
  const before = host.homeInternet.log.length;
  const told = pushes(host, 'internet').length;
  clock.set(T0 + 24 * HOUR + 30 * MIN);
  await host.tick();
  assert.equal(host.homeInternet.log.length, before, 'GateControl is not asked');
  assert.equal(pushes(host, 'internet').length, told);
  log = (await as(MARC)('GET', '/rules')).json.log[0];
  assert.deepEqual(log.results.slice(0, 2).map((x) => [x.ok, x.error, x.name]), [[false, 'not_allowed', 'Tim'], [false, 'not_allowed', 'Lena']]);
  // the dry run says it too
  const dry = (await as(MARC)('POST', `/rules/${rule.id}/test`)).json;
  assert.deepEqual(dry.details.filter((d) => d.kind === 'action').map((d) => [d.ok, d.text]).slice(0, 1), [[false, 'Internet von Tim pausieren (30 Min.) – nicht mehr erlaubt (kein Elternteil der Familie)']]);
  // Marc saves the actions again: his rule now
  const again = await as(MARC)('PATCH', `/rules/${rule.id}`, { actions: [{ type: 'internet', op: 'pause', userId: TIM.id, minutes: 30 }] });
  assert.deepEqual([again.json.rule.ownerId, again.json.rule.actions[0].available], [MARC.id, true]);
  // a parent who became a child: no parent either
  assert.equal((await admin('PATCH', `members/${MARC.id}`, { role: 'child', birthdate: '2012-01-01' })).status, 200);
  clock.set(T0 + 48 * HOUR + 30 * MIN);
  await host.tick();
  assert.equal(host.homeInternet.log.length, before);
}));

test('inside the request of somebody else the actor is still the owner; an older GateControl never runs it', async () => {
  const rule = { title: 'Hausaufgaben', scope: 'house', trigger: { type: 'person_home', userId: TIM.id }, actions: [{ type: 'internet', op: 'pause', userId: TIM.id, minutes: 60 }] };
  await withFamily(ON({ settings: { mod_presence: true } }), async (host, { as }) => {
    assert.equal((await as(ANNA)('POST', '/rules', rule)).status, 200);
    await as(TIM)('PUT', '/presence/consent', { share: true });
    // Tim's phone reports „at home“: the rule runs in HIS request — Anna is the actor
    assert.equal((await as(TIM)('POST', '/presence', { home: true })).status, 200);
    assert.deepEqual(host.homeInternet.log, [{ op: 'pause', userId: TIM.id, until: new Date(T0 + 60 * MIN).toISOString(), actors: [ANNA.id], automated: true }]);
    const tim = (await as(ANNA)('GET', '/internet')).json.internet.children.find((c) => c.userId === TIM.id);
    assert.deepEqual([tim.pausedBy.name, tim.pausedBy.rule.title, tim.presence], ['Anna', 'Hausaufgaben', { state: 'home', since: Z(T0), source: 'app' }]);
  });
  await withFamily(OLD({ settings: { mod_presence: true } }), async (host, { as, clock }) => {
    // saved all the same (the editor does not offer it): nothing runs until GateControl is updated
    const made = await as(ANNA)('POST', '/rules', rule);
    assert.deepEqual([made.status, made.json.rule.actions[0].available, made.json.rule.actions[0].problem], [200, false, 'unavailable']);
    await as(ANNA)('POST', '/rules', DINNER());
    await as(TIM)('PUT', '/presence/consent', { share: true });
    await as(TIM)('POST', '/presence', { home: true });
    assert.deepEqual(host.homeInternet.log, [], 'never with the person of the request as the actor');
    assert.deepEqual((await lastLog(as)).results.map((x) => [x.ok, x.error]), [[false, 'unavailable']]);
    clock.set(T0 + 30 * MIN);
    await host.tick();
    assert.deepEqual(host.homeInternet.log, []);
    assert.equal(pushes(host, 'internet').length, 0);
    assert.match((await as(ANNA)('POST', `/rules/${made.json.rule.id}/test`)).json.details.at(-1).text, /fehlt oder GateControl ist zu alt/);
  });
});

test('an app that does not know the action sends { type } back: the stored step stays', () => withFamily(ON(), async (host, { as }) => {
  const rule = (await as(ANNA)('POST', '/rules', DINNER({ actions: [
    { type: 'notify', to: 'parents', text: 'Essen' }, { type: 'internet', op: 'pause', userId: TIM.id, until: '19:00' }, { type: 'internet', op: 'resume', userId: LENA.id }] }))).json.rule;
  const r = await as(MARC)('PATCH', `/rules/${rule.id}`, { title: 'Essen', actions: [{ type: 'internet' }, { type: 'notify', to: 'parents', text: 'Essen!' }, { type: 'internet', text: null }] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.rule.actions.map((a) => [a.type, a.op, a.userId, a.until]), [['internet', 'pause', TIM.id, '19:00'], ['notify', undefined, undefined, undefined], ['internet', 'resume', LENA.id, null]]);
  assert.equal(r.json.rule.ownerId, MARC.id);
  // nothing stored to stand for: invalid
  const none = await as(MARC)('POST', '/rules', DINNER({ actions: [{ type: 'internet' }] }));
  assert.deepEqual([none.status, none.json.field], [400, 'actions.0.op']);
}));

test('„Zeit abgelaufen“: a pause / extra time that ran out by itself is told to the child once', () => withFamily(ON(), async (host, { as, clock }) => {
  const kinds = () => pushes(host, 'internet').map((n) => n.data.familie.kind);
  await as(ANNA)('POST', `/internet/${TIM.id}/pause`, { minutes: 30 });
  clock.add(29 * MIN);
  await host.tick();
  assert.deepEqual(kinds(), ['pause']);
  clock.add(2 * MIN);
  await host.tick();
  const n = pushes(host, 'internet').at(-1);
  assert.deepEqual([n.topic, n.users, n.title, n.body], ['internet', [TIM.id], 'Das Internet ist wieder an', 'Die Pause ist vorbei.']);
  assert.deepEqual(n.data.familie, { type: 'internet', kind: 'pause_over', userId: TIM.id, until: null, by: null });
  await host.tick();
  assert.deepEqual(kinds(), ['pause', 'pause_over'], 'once');
  // ended by a parent before its time: nothing more
  await as(ANNA)('POST', `/internet/${TIM.id}/pause`, { minutes: 10 });
  await as(MARC)('POST', `/internet/${TIM.id}/resume`);
  clock.add(11 * MIN);
  await host.tick();
  assert.deepEqual(kinds().slice(2), ['pause', 'resume']);
  // „+30 Min.“: only the last end counts
  await as(ANNA)('POST', `/internet/${TIM.id}/pause`, { minutes: 10 });
  await as(ANNA)('POST', `/internet/${TIM.id}/pause`, { add: 30 });
  clock.add(11 * MIN);
  await host.tick();
  assert.deepEqual(kinds().slice(4), ['pause', 'pause']);
  clock.add(30 * MIN);
  await host.tick();
  assert.deepEqual(kinds().slice(4), ['pause', 'pause', 'pause_over']);
  // GateControl still has one (set elsewhere): nothing ended
  await as(ANNA)('POST', `/internet/${LENA.id}/pause`, { minutes: 10 });
  host.homeInternetSet(LENA.id, { pause: Date.now() + 2 * HOUR });
  clock.add(11 * MIN);
  await host.tick();
  assert.equal(pushes(host, 'internet').filter((x) => x.users[0] === LENA.id && x.data.familie.kind === 'pause_over').length, 0);
  host.homeInternetSet(LENA.id, { pause: null });
  // found too late (the server was off): not told any more
  await as(ANNA)('POST', `/internet/${LENA.id}/pause`, { minutes: 10 });
  clock.add(10 * MIN + internet.OVER_LATE_MS + MIN);
  await host.tick();
  assert.equal(pushes(host, 'internet').filter((x) => x.users[0] === LENA.id && x.data.familie.kind === 'pause_over').length, 0);
  assert.equal((await store.one(host.gc, 'SELECT COUNT(*) AS n FROM internet_log WHERE done_at IS NULL AND until_at <= ?', [Date.now()])).n, 0, 'every end dealt with');
  // the extra time
  await as(ANNA)('POST', `/internet/${LENA.id}/extend`, { minutes: 20 });
  clock.add(21 * MIN);
  await host.tick();
  const x = pushes(host, 'internet').at(-1);
  assert.deepEqual([x.users, x.title, x.body, x.data.familie.kind], [[LENA.id], 'Die Extra-Zeit ist vorbei', 'Die Sperrzeiten zu Hause gelten wieder.', 'extend_over']);
  // … ended by a parent: told then, not again at its time
  await as(ANNA)('POST', `/internet/${LENA.id}/extend`, { minutes: 20 });
  await as(ANNA)('POST', `/internet/${LENA.id}/extend`, { minutes: 0 });
  const count = pushes(host, 'internet').length;
  clock.add(21 * MIN);
  await host.tick();
  assert.equal(pushes(host, 'internet').length, count);
  assert.ok(!host.logs.some((l) => l.level === 'warn' || l.level === 'error'), JSON.stringify(host.logs));
}));

test('a pause a rule set runs out like any other; English', () => withFamily(ON({ settings: { notify_lang: 'en' } }), async (host, { as, clock }) => {
  await as(ANNA)('POST', '/rules', DINNER({ title: 'Dinner' }));
  clock.set(T0 + 30 * MIN);
  await host.tick();
  clock.set(T0 + 61 * MIN);
  await host.tick();
  assert.deepEqual(pushes(host, 'internet').map((n) => [n.title, n.body]), [
    ['Internet paused until 11:00', 'The rule “Dinner” (Anna) paused the internet at home. GateControl keeps working.'],
    ['The internet is back on', 'The pause is over.'],
  ]);
}));

test('GET internet for a parents\' view: where the child is and from which source, the clock; a child reads its own', () => withFamily(
  ON({ settings: { mod_presence: true }, homeNetwork: { devices: [{ id: 51, userId: TIM.id, name: 'Tims Handy', counts: true, gateway: 'Pi Keller' }] } }), async (host, { as, clock }) => {
    let g = (await as(ANNA)('GET', '/internet')).json.internet;
    assert.deepEqual([g.serverTime, g.timezone], [Z(T0), 'Europe/Berlin']);
    assert.deepEqual(g.children.map((c) => c.presence), [{ state: 'not_shared', since: null, source: null }, { state: 'not_shared', since: null, source: null }]);
    // Lena shares through the app, Tim through the phone in the Wi-Fi
    await as(LENA)('PUT', '/presence/consent', { share: true });
    g = (await as(ANNA)('GET', '/internet')).json.internet;
    assert.deepEqual(g.children.find((c) => c.userId === LENA.id).presence, { state: 'unknown', since: null, source: null });
    await as(LENA)('POST', '/presence', { home: false });
    assert.equal((await as(TIM)('PUT', '/presence/wifi', { enabled: true })).status, 200);
    await host.homePresenceIdle();
    clock.add(MIN);
    host.homeNetwork.states.set(TIM.id, { home: true, since: Date.now() });
    await host.tick();
    g = (await as(MARC)('GET', '/internet')).json.internet;
    assert.deepEqual(g.children.map((c) => [c.name, c.presence]), [
      ['Lena', { state: 'away', since: Z(T0), source: 'app' }], ['Tim', { state: 'home', since: Z(T0 + MIN), source: 'wifi' }]]);
    // the same in the answer of a change, and for the child itself
    const r = (await as(MARC)('POST', `/internet/${TIM.id}/pause`, { minutes: 30 })).json.child;
    assert.equal(r.presence.source, 'wifi');
    const own = (await as(TIM)('GET', '/internet')).json.internet;
    assert.deepEqual([own.manage, own.children.map((c) => [c.userId, c.presence.state])], [false, [[TIM.id, 'home']]]);
    // GET presence carries the source per member (since 1.17.0) and the caller's switches
    const p = (await as(TIM)('GET', '/presence')).json;
    assert.deepEqual(p.members.filter((m) => m.role === 'child').map((m) => [m.name, m.state, m.source]), [['Lena', 'away', 'app'], ['Tim', 'home', 'wifi']]);
    assert.deepEqual(p.me, { share: false, places: false, wifi: true });
    // the module presence off: no presence at all
    host.settings.mod_presence = false;
    assert.deepEqual((await as(ANNA)('GET', '/internet')).json.internet.children.map((c) => c.presence), [null, null]);
  }));

test('the topic `internet`: its own switch in the notification settings, every message of „Internet zu Hause“ in it', () => withFamily(ON(), async (host, { as, clock }) => {
  const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'plugin.json'), 'utf8'));
  assert.deepEqual(manifest.notifyTopics.find((t) => t.id === 'internet'), { id: 'internet', label: { de: 'Internet zu Hause', en: 'Internet at home' }, default: true });
  assert.equal(manifest.version, '1.20.0');
  // by hand, by a rule, run out: one topic, to the child only
  await as(ANNA)('POST', '/rules', DINNER({ actions: [{ type: 'internet', op: 'pause', userId: LENA.id, minutes: 5 }] }));
  await as(ANNA)('POST', `/internet/${TIM.id}/pause`, { minutes: 20 });
  await as(ANNA)('POST', `/internet/${TIM.id}/extend`, { minutes: 20 });
  await as(MARC)('POST', `/internet/${TIM.id}/resume`);
  await as(MARC)('POST', `/internet/${TIM.id}/extend`, { minutes: 0 });
  clock.set(T0 + 30 * MIN);
  await host.tick();
  clock.set(T0 + 36 * MIN);
  await host.tick();
  const sent = host.notifications.filter((n) => n.data && n.data.familie && n.data.familie.type === 'internet');
  assert.deepEqual(sent.map((n) => [n.data.familie.kind, n.topic, n.users]), [
    ['pause', 'internet', [TIM.id]], ['extend', 'internet', [TIM.id]], ['resume', 'internet', [TIM.id]], ['extend_end', 'internet', [TIM.id]],
    ['pause', 'internet', [LENA.id]], ['pause_over', 'internet', [LENA.id]],
  ]);
  assert.equal(host.notifications.filter((n) => n.topic === 'internet').length, sent.length);
  // every text of the topic in both languages
  const keys = Object.keys(pushTexts.de).filter((k) => k.startsWith('internet.'));
  assert.ok(keys.length >= 16);
  for (const k of keys) assert.ok(pushTexts.en[k] && pushTexts.en[k] !== pushTexts.de[k], k);
}));

test('the pages: the editor\'s tab „Internet zu Hause“, the card, texts in both languages', () => {
  const editor = fs.readFileSync(path.join(DIR, 'ui', 'rules.js'), 'utf8');
  const card = fs.readFileSync(path.join(DIR, 'ui', 'portal-internet.js'), 'utf8');
  const used = new Set();
  for (const src of [editor, card]) for (const m of src.matchAll(/T\('((?:rule\.(?:m_)?net_|internet\.)[a-z0-9_.]+)'/g)) used.add(m[1]);
  // keys built at run time
  for (const e of ['unavailable', 'not_allowed', 'not_found', 'failed']) { used.add(`rule.net_err.${e}`); used.add(`rule.net_err_hint.${e}`); }
  for (const k of ['test.net_pause', 'test.net_pause_until', 'test.net_resume', 'test.net_unavailable', 'test.net_not_allowed', 'test.net_not_found']) used.add(k);
  // prefixes of keys put together at run time (T('internet.cat_' + x), T('rule.net_err.' + e))
  for (const k of [...used]) if (/[._]$/.test(k)) used.delete(k);
  for (const c of ['social', 'games', 'video']) used.add(`internet.cat_${c}`);
  assert.ok(used.size > 40, String(used.size));
  for (const k of used) {
    assert.equal(typeof texts.de[k], 'string', `de ${k}`);
    assert.equal(typeof texts.en[k], 'string', `en ${k}`);
  }
  assert.match(editor, /id: '@internet'/);
  assert.match(editor, /type: 'internet', op: 'pause', userId: x\.userId, minutes: x\.minutes/);
  assert.match(card, /by\.rule/);
});
