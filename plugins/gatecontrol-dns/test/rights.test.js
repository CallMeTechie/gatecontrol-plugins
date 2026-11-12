'use strict';

// Who may suspend for whom — the matrix of the decision (server/rights.js) and the same through the API:
// everybody for their own devices; administrators for everybody; parents for the members of their family, never for
// an administrator; "Nur Admins" / "Je Profil"; the longest duration and "bis ich wieder einschalte".

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const rights = require('../server/rights');
const config = require('../server/config');
const { fail } = require('../server/util');
const { setup, P, ADMIN, MARC, SABINE, LEA, TIM, GAST, BOSS } = require('./helpers');

const FAM = [{ id: 1, name: 'Familie', parents: [2, 3], members: [2, 3, 4, 5] }];
const cfg = (pause) => config.normalise({ pause });
const A = (u) => ({ id: u.id, role: u.role });
const peer = (owner, profileId = 'default') => ({ scope: 'peer', owner: owner ? A(owner) : null, profileIds: [profileId] });

describe('rights.may — the matrix', () => {
  const rows = [
    // who, target, settings, → ok | reason
    ['a user, the own device', LEA, peer(LEA), {}, true],
    ['a user, the own device, "Nur Admins"', LEA, peer(LEA), { who: 'admins' }, 'admins_only'],
    ['a user, the own device, "Je Profil" allowed', LEA, peer(LEA, 'pa'), { who: 'profile', profiles: { pb: false } }, true],
    ['a user, the own device, "Je Profil" locked', LEA, peer(LEA, 'pb'), { who: 'profile', profiles: { pb: false } }, 'profile'],
    ['a locked profile only counts with "Je Profil"', LEA, peer(LEA, 'pb'), { who: 'all', profiles: { pb: false } }, true],
    ['a user, somebody else', GAST, peer(LEA), {}, 'not_yours'],
    ['a child, the parent', LEA, peer(MARC), {}, 'not_yours'],
    ['a child, the sibling', LEA, peer(TIM), {}, 'not_yours'],
    ['a parent, the child', MARC, peer(LEA), {}, true],
    ['a parent, the child whose profile is locked', MARC, peer(LEA, 'pb'), { who: 'profile', profiles: { pb: false } }, true],
    ['a parent, the other parent', MARC, peer(SABINE), {}, true],
    ['a parent, the child, "Nur Admins"', MARC, peer(LEA), { who: 'admins' }, 'admins_only'],
    ['a parent, somebody outside the family', MARC, peer(GAST), {}, 'not_yours'],
    ['a parent, an administrator', MARC, peer(ADMIN), {}, 'admin_target'],
    ['a user, all devices', MARC, { scope: 'all' }, {}, 'admins_only'],
    ['a user, a device without a person', MARC, peer(null), {}, 'not_yours'],
    ['an administrator, the own device, "Nur Admins"', ADMIN, peer(ADMIN), { who: 'admins' }, true],
    ['an administrator, a user', ADMIN, peer(LEA, 'pb'), { who: 'profile', profiles: { pb: false } }, true],
    ['an administrator, another administrator', ADMIN, peer(BOSS), {}, true],
    ['an administrator, all devices', ADMIN, { scope: 'all' }, { who: 'admins' }, true],
    ['an administrator, a device without a person', ADMIN, peer(null), {}, true],
  ];
  for (const [name, who, target, pause, want] of rows) {
    it(name, () => {
      const r = rights.may(A(who), target, cfg(pause), FAM);
      if (want === true) assert.equal(r.ok, true, JSON.stringify(r));
      else assert.deepEqual({ ok: r.ok, reason: r.reason }, { ok: false, reason: want });
    });
  }

  it('an administrator who is also a parent is asked as an administrator; a parent administrator in the family is never a target of parents', () => {
    const fam = [{ id: 1, name: 'F', parents: [1, 2], members: [1, 2, 4] }];
    assert.equal(rights.may(A(MARC), peer(ADMIN), cfg({}), fam).reason, 'admin_target');
    assert.equal(rights.may(A(ADMIN), peer(MARC), cfg({ who: 'admins' }), fam).ok, true);
  });

  it('limits: users get the durations up to the longest one, administrators everything', () => {
    assert.deepEqual(rights.limits(A(LEA), cfg({})), { durations: [5, 30, 60], maxMinutes: 60, forever: false });
    assert.deepEqual(rights.limits(A(LEA), cfg({ maxMinutes: 5 })), { durations: [5], maxMinutes: 5, forever: false });
    assert.deepEqual(rights.limits(A(LEA), cfg({ maxMinutes: 240, forever: true })), { durations: [5, 30, 60, 240], maxMinutes: 240, forever: true });
    assert.deepEqual(rights.limits(A(ADMIN), cfg({ maxMinutes: 5 })), { durations: [5, 30, 60, 240], maxMinutes: 10080, forever: true });
  });

  it('endOf: minutes within the limit, forever only when offered, extend from the end of the running suspension', () => {
    const lim = { durations: [5, 30, 60], maxMinutes: 60, forever: false };
    const now = Date.parse('2026-11-12T13:00:00Z');
    assert.deepEqual(rights.endOf({ minutes: 30 }, lim, null, fail, now), { minutes: 30 });
    assert.throws(() => rights.endOf({ minutes: 61 }, lim, null, fail, now), { code: 'too_long' });
    assert.throws(() => rights.endOf({ forever: true }, lim, null, fail, now), { code: 'forever_not_allowed' });
    assert.deepEqual(rights.endOf({ forever: true }, { ...lim, forever: true }, null, fail, now), { forever: true });
    assert.throws(() => rights.endOf({}, lim, null, fail, now), { code: 'invalid' });
    assert.throws(() => rights.endOf({ minutes: 0 }, lim, null, fail, now), { code: 'invalid' });
    assert.throws(() => rights.endOf({ minutes: '30' }, lim, null, fail, now), { code: 'invalid' });
    // +30 min on a suspension that ends in 20 minutes: 50 minutes ahead
    assert.deepEqual(rights.endOf({ extend: 30 }, lim, { until: '2026-11-12T13:20:00.000Z', openEnd: false }, fail, now), { until: '2026-11-12T13:50:00.000Z' });
    // … on one that ends in 40 minutes: 70 minutes ahead — longer than the longest duration
    assert.throws(() => rights.endOf({ extend: 30 }, lim, { until: '2026-11-12T13:40:00.000Z', openEnd: false }, fail, now), { code: 'too_long' });
    assert.deepEqual(rights.endOf({ extend: 30 }, lim, null, fail, now), { until: '2026-11-12T13:30:00.000Z' });
    assert.throws(() => rights.endOf({ extend: 30 }, lim, { until: null, openEnd: true }, fail, now), { code: 'invalid' });
  });
});

describe('the matrix through the API (apps)', () => {
  let s;
  afterEach(async () => { if (s) await s.host.close(); s = null; });
  const pause = (who, peerId, body) => s.app(who, peerId, 'POST', 'pause', body);

  it('everybody for the own device; nobody for a stranger; a child not for the parents', async () => {
    s = await setup();
    assert.equal((await pause(LEA, P.leaPhone, { minutes: 5 })).http, 200);
    assert.equal((await pause(GAST, P.guest, { minutes: 5 })).http, 200);
    for (const [who, own, body] of [[GAST, P.guest, { peerId: P.leaPhone, minutes: 5 }], [GAST, P.guest, { userId: LEA.id, minutes: 5 }], [LEA, P.leaPhone, { userId: MARC.id, minutes: 5 }], [LEA, P.leaPhone, { peerId: P.timTablet, minutes: 5 }]]) {
      const r = await pause(who, own, body);
      assert.deepEqual([r.http, r.code, r.reason], [403, 'not_allowed', 'not_yours'], JSON.stringify(body));
    }
    // nothing but the two own suspensions reached GateControl
    assert.deepEqual([...s.host.vpnDns.pauses.keys()].sort(), ['peer:' + P.guest, 'peer:' + P.leaPhone].sort());
  });

  it('parents for the family — a device or the person — but never for an administrator, and not outside the family', async () => {
    s = await setup({ groups: [{ id: 1, name: 'Familie', kind: 'family', members: [{ userId: 2, role: 'parent' }, { userId: 4, role: 'child' }, { userId: 7, role: 'parent' }] }] });
    assert.equal((await pause(MARC, P.marcPhone, { peerId: P.leaPhone, minutes: 30 })).http, 200);
    assert.equal((await pause(MARC, P.marcPhone, { userId: LEA.id, minutes: 30 })).http, 200);
    // Chef is an administrator and a parent of the same family
    let r = await pause(MARC, P.marcPhone, { userId: BOSS.id, minutes: 5 });
    assert.deepEqual([r.http, r.code, r.reason], [403, 'not_allowed', 'admin_target']);
    r = await pause(MARC, P.marcPhone, { peerId: P.boss, minutes: 5 });
    assert.deepEqual([r.http, r.code, r.reason], [403, 'not_allowed', 'admin_target']);
    // Tim is not in this family
    r = await pause(MARC, P.marcPhone, { userId: TIM.id, minutes: 5 });
    assert.deepEqual([r.http, r.reason], [403, 'not_yours']);
    assert.equal(s.host.vpnDns.pauses.has('user:' + BOSS.id), false);
    // every suspension names the acting person
    assert.ok(s.host.vpnDns.activity.filter((a) => a.type === 'vpn_dns_paused').every((a) => a.actor === MARC.id && a.automated === false));
  });

  it('administrators for everybody and for all devices; a user never for all devices', async () => {
    s = await setup();
    assert.equal((await pause(ADMIN, P.annaPhone, { userId: GAST.id, minutes: 600 })).http, 200);
    assert.equal((await pause(ADMIN, P.annaPhone, { userId: BOSS.id, forever: true })).http, 200);
    assert.equal((await pause(ADMIN, P.annaPhone, { all: true, forever: true })).http, 200);
    const r = await pause(MARC, P.marcPhone, { all: true, minutes: 5 });
    assert.deepEqual([r.http, r.code, r.reason], [403, 'not_allowed', 'admins_only']);
  });

  it('"Nur Admins": users and parents see the state but may not suspend', async () => {
    s = await setup({ config: { pause: { who: 'admins' } } });
    let r = await pause(LEA, P.leaPhone, { minutes: 5 });
    assert.deepEqual([r.http, r.reason], [403, 'admins_only']);
    r = await pause(MARC, P.marcPhone, { userId: LEA.id, minutes: 5 });
    assert.deepEqual([r.http, r.reason], [403, 'admins_only']);
    const st = await s.app(LEA, P.leaPhone, 'GET', 'status');
    assert.deepEqual([st.state, st.may.pause, st.may.reason, st.may.durations], ['active', false, 'admins_only', []]);
    assert.equal((await pause(ADMIN, P.annaPhone, { minutes: 5 })).http, 200);
  });

  it('"Je Profil": the profile of the device decides for its owner, parents may still suspend for the child', async () => {
    s = await setup({ config: { pause: { who: 'profile', profiles: { pkinder01: false } } } });
    let r = await pause(LEA, P.leaPhone, { minutes: 5 });
    assert.deepEqual([r.http, r.code, r.reason], [403, 'not_allowed', 'profile']);
    assert.match(r.error, /frag deine Eltern/);
    const st = await s.app(LEA, P.leaPhone, 'GET', 'status');
    assert.deepEqual([st.may.pause, st.may.reason, st.profile.name], [false, 'profile', 'Kinder']);
    assert.equal((await pause(MARC, P.marcPhone, { minutes: 5 })).http, 200, 'Marc: profile Standard, allowed');
    assert.equal((await pause(MARC, P.marcPhone, { peerId: P.leaPhone, minutes: 5 })).http, 200, 'the parent for the child');
    // all devices of a person: one locked profile among them locks it for the person
    await s.config({ pause: { profiles: { pkinder01: true, pbuero001: false } } });
    r = await s.portal(MARC, 'POST', 'pause', { minutes: 5 });
    assert.deepEqual([r.http, r.reason], [403, 'profile'], 'Marc owns the office PC (profile Büro)');
    assert.equal((await pause(MARC, P.marcPhone, { minutes: 5 })).http, 200, 'his phone alone is fine');
  });

  it('the longest duration and "bis ich wieder einschalte" hold for users and parents, not for administrators', async () => {
    s = await setup({ config: { pause: { maxMinutes: 30 } } });
    let r = await pause(LEA, P.leaPhone, { minutes: 60 });
    assert.deepEqual([r.http, r.code, r.maxMinutes], [403, 'too_long', 30]);
    r = await pause(LEA, P.leaPhone, { forever: true });
    assert.deepEqual([r.http, r.code], [403, 'forever_not_allowed']);
    r = await pause(MARC, P.marcPhone, { userId: LEA.id, forever: true });
    assert.deepEqual([r.http, r.code], [403, 'forever_not_allowed']);
    r = await pause(LEA, P.leaPhone, { minutes: 30 });
    assert.equal(r.http, 200);
    r = await pause(LEA, P.leaPhone, { extend: 30 });
    assert.deepEqual([r.http, r.code], [403, 'too_long'], '+30 min would end 60 minutes ahead');
    assert.deepEqual((await s.app(LEA, P.leaPhone, 'GET', 'status')).may.durations, [5, 30]);
    assert.equal((await pause(ADMIN, P.annaPhone, { forever: true })).http, 200);
    assert.equal((await pause(ADMIN, P.annaPhone, { minutes: 10080 })).http, 200);
    await s.config({ pause: { forever: true, maxMinutes: 240 } });
    r = await pause(LEA, P.leaPhone, { forever: true });
    assert.deepEqual([r.http, r.pause.openEnd, r.status.may.forever], [200, true, true]);
  });

  it('switching back on: the own devices always, somebody else\'s only with the right, all devices only an administrator', async () => {
    s = await setup({ config: { pause: { who: 'profile', profiles: { pkinder01: false } } } });
    // the parent suspends for the child; the child (profile locked) may end it
    await pause(MARC, P.marcPhone, { userId: LEA.id, minutes: 30 });
    let st = await s.app(LEA, P.leaPhone, 'GET', 'status');
    assert.deepEqual([st.state, st.pause.scope, st.pause.byMe, st.pause.by.name, st.may.pause, st.may.resume], ['paused', 'user', false, 'Marc', false, true]);
    let r = await s.app(LEA, P.leaPhone, 'POST', 'resume', {});
    assert.deepEqual([r.http, r.resumed, r.status.state], [200, true, 'active']);
    // a stranger may not end somebody else's suspension
    await pause(MARC, P.marcPhone, { minutes: 30 });
    r = await s.app(GAST, P.guest, 'POST', 'resume', { peerId: P.marcPhone });
    assert.deepEqual([r.http, r.reason], [403, 'not_yours']);
    // suspended for all devices: only an administrator switches it back on
    await pause(ADMIN, P.annaPhone, { all: true, minutes: 30 });
    st = await s.app(GAST, P.guest, 'GET', 'status');
    assert.deepEqual([st.state, st.pause.scope, st.may.resume, st.may.reason], ['paused', 'all', false, 'paused_for_all']);
    r = await s.app(GAST, P.guest, 'POST', 'resume', {});
    assert.deepEqual([r.http, r.reason], [403, 'paused_for_all']);
    r = await s.app(MARC, P.marcPhone, 'POST', 'resume', { all: true });
    assert.deepEqual([r.http, r.reason], [403, 'admins_only']);
    r = await s.app(ADMIN, P.annaPhone, 'POST', 'resume', { all: true });
    assert.deepEqual([r.http, r.resumed], [200, true]);
  });

  it('the family is read from GateControl\'s groups: without a family group there are no parents; a change takes effect', async () => {
    s = await setup({ groups: [] });
    let r = await pause(MARC, P.marcPhone, { userId: LEA.id, minutes: 5 });
    assert.deepEqual([r.http, r.reason], [403, 'not_yours']);
    assert.equal((await s.app(MARC, P.marcPhone, 'GET', 'status')).manage, false);
    assert.equal((await s.app(MARC, P.marcPhone, 'GET', 'people')).http, 403);
    await s.host.close();
    s = await setup();
    assert.equal((await s.app(MARC, P.marcPhone, 'GET', 'status')).manage, true);
    // Marc is no longer a parent: the hook groupsChanged drops the cache
    s.host.editGroups.setMember(1, MARC.id, 'child');
    await s.host.groupsChanged();
    r = await pause(MARC, P.marcPhone, { userId: LEA.id, minutes: 5 });
    assert.deepEqual([r.http, r.reason], [403, 'not_yours']);
  });
});
