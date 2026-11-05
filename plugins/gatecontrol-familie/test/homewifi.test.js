'use strict';

// 1.17.0 — presence over the home network (GateControl ≥ 1.230.0, gc.homeNetwork of the mock host): the phone in the
// Wi-Fi as a second source next to the app. At home as soon as one switched-on source says so, away once none says „at
// home“; the rules run once per change of that combined state (no duplicate when the second source agrees, no run for
// a source that is switched off or goes silent, none for a change found late). Consent and devices only for oneself.
// Without the API (an older GateControl) everything stays as before.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withFamily, ANNA, MARC, LENA, TIM, MIN, T0, portal, kioskViewer, pushes } = require('./helpers');

const SH = 'gatecontrol-smarthome';
function smarthome(log) {
  return [{
    plugin: SH, pluginName: 'Smart Home',
    quickActions: () => [{ id: 'scene:away', title: 'Heizung 17 °C' }, { id: 'scene:home', title: 'Heizung 21 °C' }],
    runQuickAction: (viewer, id) => { log.push({ viewer, id }); return { ok: true, message: 'ok' }; },
  }];
}
const DEVICES = () => [
  { id: 11, userId: ANNA.id, name: 'Annas Handy', gateway: 'Pi Keller' },
  { id: 12, userId: ANNA.id, name: 'Annas iPad', gateway: 'Pi Keller', counts: false },
  { id: 21, userId: MARC.id, name: 'Marcs Handy', gateway: 'Pi Keller' },
  { id: 41, userId: LENA.id, name: 'Lenas Handy', gateway: 'Pi Garten' },
];
const ON = (log, extra = {}) => ({ settings: { mod_presence: true }, actions: smarthome(log || []), homeNetwork: { devices: DEVICES() }, ...extra });
const QA = (id) => ({ type: 'quick_action', plugin: SH, id });
const isoAt = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');

/** the member objects of GET presence → [name, state, source, since] */
async function who(as, user = LENA) {
  return (await as(user)('GET', '/presence')).json.members.map((m) => [m.name, m.state, m.source, m.since]);
}

test('without GateControl 1.230.0: no Wi-Fi source, the app stays the only one; nothing breaks', async () => {
  for (const extra of [{ homeNetwork: undefined }, { homeNetwork: undefined, gatecontrol: '1.229.0' }]) {
    await withFamily(ON([], extra), async (host, { as }) => {
      assert.equal(host.gc.homeNetwork, undefined);
      assert.deepEqual((await as(ANNA)('GET', '/presence/wifi')).json, { ok: true, wifi: { available: false, consent: false, since: null, devices: null } });
      for (const [path, body] of [['/presence/wifi', { enabled: true }], ['/presence/wifi/devices/11', { counts: true }]]) {
        const r = await as(ANNA)('PUT', path, body);
        assert.deepEqual([r.status, r.json.code], [409, 'unavailable'], path);
      }
      await as(ANNA)('PUT', '/presence/consent', { share: true });
      await as(ANNA)('POST', '/presence', { home: true });
      const g = (await as(ANNA)('GET', '/presence')).json;
      assert.deepEqual(g.me, { share: true, places: false, wifi: null });
      assert.deepEqual(g.members[0].source, 'app');
      await host.tick();
      assert.ok(!host.logs.some((l) => l.level === 'warn' || l.level === 'error'), JSON.stringify(host.logs));
      const page = (await host.request({ method: 'GET', path: '/admin/presence', user: { id: 1, name: 'admin', role: 'admin' } })).json;
      assert.equal(page.wifi, false);
    });
  }
});

test('„Über mein Handy im WLAN“ and „Meine Geräte“: only for oneself, GateControl checks the person too', () => withFamily(ON(), async (host, { as, call }) => {
  let w = (await as(ANNA)('GET', '/presence/wifi')).json.wifi;
  assert.deepEqual(w, { available: true, consent: false, since: null, devices: [
    { id: 11, name: 'Annas Handy', lastSeen: null, counts: true, gateway: 'Pi Keller' },
    { id: 12, name: 'Annas iPad', lastSeen: null, counts: false, gateway: 'Pi Keller' },
  ] }, 'her own devices only — names and times, never an address');
  assert.equal((await as(ANNA)('PUT', '/presence/wifi', { enabled: 'ja' })).json.code, 'invalid');
  // the body cannot name somebody else: Anna switches it on for herself
  w = (await as(ANNA)('PUT', '/presence/wifi', { enabled: true, userId: MARC.id })).json.wifi;
  assert.equal(w.consent, true);
  await host.homePresenceIdle();
  assert.deepEqual([host.homeNetwork.consent.get(ANNA.id).enabled, host.homeNetwork.consent.has(MARC.id)], [true, false]);
  // device trust only: nothing; a paired kiosk device signs in for Familie, but GateControl answers only to the person
  const trust = await call(portal(ANNA, false), 'PUT', '/presence/wifi', { enabled: false });
  assert.deepEqual([trust.status, trust.json.code], [403, 'login_required']);
  const kiosk = await call(kioskViewer(ANNA), 'PUT', '/presence/wifi', { enabled: false });
  assert.deepEqual([kiosk.status, kiosk.json.code], [403, 'not_person']);
  assert.equal(host.homeNetwork.consent.get(ANNA.id).enabled, true);
  const kw = (await call(kioskViewer(ANNA), 'GET', '/presence/wifi')).json.wifi;
  assert.deepEqual([kw.consent, kw.devices, kw.error], [true, null, 'not_person']);
  // „zählt / zählt nicht“: one's own devices only
  const other = await as(ANNA)('PUT', '/presence/wifi/devices/21', { counts: false });
  assert.deepEqual([other.status, other.json.code], [404, 'not_found']);
  assert.equal((await as(ANNA)('PUT', '/presence/wifi/devices/abc', { counts: false })).json.code, 'not_found');
  assert.equal((await as(ANNA)('PUT', '/presence/wifi/devices/12', { counts: 'ja' })).json.code, 'invalid');
  w = (await as(ANNA)('PUT', '/presence/wifi/devices/12', { counts: true })).json.wifi;
  assert.deepEqual(w.devices.map((d) => [d.id, d.counts]), [[11, true], [12, true]]);
  assert.equal(host.homeNetwork.devices.find((d) => d.id === 21).counts, true, 'Marc\'s phone untouched');
  // agreed, nothing reported yet: shares, unknown
  const g = (await as(ANNA)('GET', '/presence')).json;
  assert.deepEqual(g.me, { share: false, places: false, wifi: true }, 'share stays the app\'s consent');
  assert.deepEqual(g.members[0], { ...g.members[0], shared: true, state: 'unknown', home: null, source: null });
  // a wall tablet never gets there; children decide for themselves as well
  assert.equal((await as(TIM)('PUT', '/presence/wifi', { enabled: true })).json.wifi.consent, true);
  // switched off again
  w = (await as(ANNA)('PUT', '/presence/wifi', { enabled: false })).json.wifi;
  await host.homePresenceIdle();
  assert.equal(w.consent, false);
  assert.equal((await as(ANNA)('GET', '/presence')).json.members[0].state, 'not_shared');
}));

test('App and Wi-Fi together: at home as soon as one says so, away once none does — every rule once, no flapping', () => {
  const log = [];
  return withFamily(ON(log), async (host, { as, clock }) => {
    await as(ANNA)('POST', '/presence/rules', { trigger: 'first_home', actions: [QA('scene:home')] });
    const away = (await as(ANNA)('POST', '/presence/rules', { trigger: 'person_away', userId: ANNA.id, actions: [{ type: 'notify', to: [MARC.id] }] })).json.rule;
    await as(ANNA)('PUT', '/presence/consent', { share: true });
    await as(ANNA)('PUT', '/presence/wifi', { enabled: true });
    await host.homePresenceIdle();
    // 10:00 the gateway sees her phone → at home „· WLAN“, first home runs once
    await host.homeDevice(11, true);
    assert.deepEqual(log.map((x) => x.id), ['scene:home']);
    assert.deepEqual((await who(as))[0], ['Anna', 'home', 'wifi', isoAt(T0)]);
    // 10:02 the app says the same: nothing runs again, still since 10:00 through the Wi-Fi
    clock.add(2 * MIN);
    let r = (await as(ANNA)('POST', '/presence', { home: true })).json;
    assert.deepEqual([r.changed, r.presence], [true, { state: 'home', home: true, since: isoAt(T0), source: 'wifi' }]);
    assert.equal(log.length, 1);
    // 10:04 the app thinks she left (the phone on mobile data) — the Wi-Fi still sees it: at home, no run
    clock.add(2 * MIN);
    r = (await as(ANNA)('POST', '/presence', { home: false })).json;
    assert.deepEqual(r.presence, { state: 'home', home: true, since: isoAt(T0), source: 'wifi' });
    assert.equal(pushes(host, 'presence_rule').length, 0);
    // 10:15 the gateway (10 minutes without a sign) says away → away now, „person away“ once
    clock.add(11 * MIN);
    await host.homeDevice(11, false);
    assert.deepEqual((await who(as))[0], ['Anna', 'away', 'wifi', isoAt(T0 + 15 * MIN)]);
    const n = pushes(host, 'presence_rule');
    assert.deepEqual([n.length, n[0].users, n[0].data.familie.ruleId], [1, [MARC.id], away.id]);
    // 10:16 the app first this time → at home „· App“; the Wi-Fi a minute later changes nothing
    clock.add(MIN);
    await as(ANNA)('POST', '/presence', { home: true });
    assert.deepEqual(log.map((x) => x.id), ['scene:home', 'scene:home'], 'first home again (16 minutes after the last run)');
    clock.add(MIN);
    await host.homeDevice(11, true);
    assert.deepEqual((await who(as))[0], ['Anna', 'home', 'app', isoAt(T0 + 16 * MIN)]);
    // the app leaves: the Wi-Fi keeps her at home and is shown from now on
    clock.add(MIN);
    await as(ANNA)('POST', '/presence', { home: false });
    assert.deepEqual((await who(as))[0], ['Anna', 'home', 'wifi', isoAt(T0 + 16 * MIN)]);
    // a repeated or an older event (the hook is best-effort and not ordered): nothing
    await host.homePresenceEmit({ userId: ANNA.id, home: true, since: new Date(T0 + 17 * MIN).toISOString(), source: 'wifi' });
    await host.homePresenceEmit({ userId: ANNA.id, home: false, since: new Date(T0 + 5 * MIN).toISOString(), source: 'wifi' });
    assert.deepEqual((await who(as))[0], ['Anna', 'home', 'wifi', isoAt(T0 + 16 * MIN)]);
    assert.equal(log.length, 2);
    assert.equal(pushes(host, 'presence_rule').length, 1);
    // the log names the trigger as always
    assert.deepEqual((await as(ANNA)('GET', '/presence/log')).json.log.map((x) => x.trigger), ['first_home', 'person_away', 'first_home']);
  });
});

test('„all away“ with a person who shares only through the Wi-Fi; switching a source off runs no person rule', () => {
  const log = [];
  return withFamily(ON(log), async (host, { as, clock }) => {
    await as(ANNA)('POST', '/presence/rules', { trigger: 'all_away', graceMinutes: 0, actions: [QA('scene:away')] });
    await as(ANNA)('POST', '/presence/rules', { trigger: 'person_away', userId: MARC.id, actions: [{ type: 'notify', to: [ANNA.id] }] });
    await as(ANNA)('PUT', '/presence/consent', { share: true });
    await as(MARC)('PUT', '/presence/wifi', { enabled: true });
    await host.homePresenceIdle();
    await as(ANNA)('POST', '/presence', { home: true });
    await host.homeDevice(21, true);
    clock.add(MIN);
    await as(ANNA)('POST', '/presence', { home: false });
    assert.equal(log.length, 0, 'Marc is at home through the Wi-Fi');
    assert.deepEqual((await who(as)).slice(0, 2), [['Anna', 'away', 'app', isoAt(T0 + MIN)], ['Marc', 'home', 'wifi', isoAt(T0)]]);
    clock.add(10 * MIN);
    await host.homeDevice(21, false);
    assert.deepEqual(log.map((x) => x.id), ['scene:away'], 'everyone who shares is away');
    assert.equal(pushes(host, 'presence_rule').length, 1, 'and Marc left');
    // Marc back home, then he switches the Wi-Fi off: he no longer shares — no „person away“ for it
    clock.add(15 * MIN);
    await host.homeDevice(21, true);
    clock.add(MIN);
    await as(MARC)('PUT', '/presence/wifi', { enabled: false });
    await host.homePresenceIdle();
    assert.deepEqual((await who(as))[1], ['Marc', 'not_shared', null, null]);
    assert.equal(pushes(host, 'presence_rule').length, 1);
    // removing his only counting device: the Wi-Fi no longer knows — unknown, nothing runs
    await as(MARC)('PUT', '/presence/wifi', { enabled: true });
    await host.homePresenceIdle();
    assert.equal((await who(as))[1][1], 'home');
    await as(MARC)('PUT', '/presence/wifi/devices/21', { counts: false });
    await host.homePresenceIdle();
    assert.deepEqual((await who(as))[1], ['Marc', 'unknown', null, null]);
    assert.equal(pushes(host, 'presence_rule').length, 1);
  });
});

test('missed events: the background run catches up — a recent change runs the rules, a late one only updates the state', () => {
  const log = [];
  return withFamily(ON(log), async (host, { as, clock }) => {
    await as(ANNA)('POST', '/presence/rules', { trigger: 'person_home', userId: LENA.id, actions: [QA('scene:home')] });
    await as(ANNA)('POST', '/presence/rules', { trigger: 'person_away', userId: LENA.id, actions: [QA('scene:away')] });
    await as(LENA)('PUT', '/presence/wifi', { enabled: true });
    await host.homePresenceIdle();
    // GateControl knew it, the hook did not reach Familie (e.g. a restart): found by the next background run
    host.homeNetwork.states.set(LENA.id, { home: true, since: Date.now() - 2 * MIN });
    await host.tick();
    assert.deepEqual(log.map((x) => x.id), ['scene:home']);
    assert.deepEqual((await who(as, ANNA))[2], ['Lena', 'home', 'wifi', isoAt(T0 - 2 * MIN)]);
    // 25 minutes old when found: the state follows, the door stays shut
    clock.add(40 * MIN);
    host.homeNetwork.states.set(LENA.id, { home: false, since: Date.now() - 25 * MIN });
    await host.tick();
    assert.deepEqual((await who(as, ANNA))[2], ['Lena', 'away', 'wifi', isoAt(T0 + 15 * MIN)]);
    assert.equal(log.length, 1);
    // withdrawn somewhere else (no event): the state went from list(), the consent is asked → not shared
    host.homeNetwork.consent.set(LENA.id, { enabled: false, at: Date.now() });
    host.homeNetwork.states.delete(LENA.id);
    await host.tick();
    assert.deepEqual((await who(as, ANNA))[2], ['Lena', 'not_shared', null, null]);
    // somebody who is no member: ignored
    await host.homePresenceEmit({ userId: 6, home: true, since: new Date().toISOString() });
    assert.equal((await host.gc.db.get('SELECT COUNT(*) AS n FROM presence_wifi WHERE user_id = 6', [])).row.n, 0);
    assert.equal(log.length, 1);
  });
});

test('module presence off: Wi-Fi events are kept, no rule runs; on again the state is there', () => withFamily(ON([], { settings: { mod_presence: false } }), async (host, { as, admin }) => {
  const log = host.actionRuns;
  host.homeNetwork.consent.set(ANNA.id, { enabled: true, at: Date.now() });
  await host.homeDevice(11, true);
  assert.equal((await as(ANNA)('GET', '/presence/wifi')).json.code, 'module_off');
  assert.equal(log.length, 0);
  assert.equal((await admin('PUT', 'modules', { presence: true })).status, 200);
  assert.deepEqual((await who(as))[0], ['Anna', 'home', 'wifi', isoAt(T0)]);
}));

test('an install from before 1.17.0: the app\'s state without a combined row still shows since and source', () => withFamily(ON(), async (host, { as, clock }) => {
  await as(ANNA)('PUT', '/presence/consent', { share: true });
  await as(ANNA)('POST', '/presence', { home: true });
  await host.gc.db.run('DELETE FROM presence_now', []);
  clock.add(MIN);
  assert.deepEqual((await who(as))[0], ['Anna', 'home', 'app', isoAt(T0)]);
  // the next change is a change as before
  await as(ANNA)('POST', '/presence', { home: false });
  assert.deepEqual((await who(as))[0], ['Anna', 'away', 'app', isoAt(T0 + MIN)]);
}));
