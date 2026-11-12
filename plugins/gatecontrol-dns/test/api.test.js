'use strict';

// The person API of the apps and the portal: the state for the own device, counters (per device only with the query
// log on), suspending and switching back on, the people an administrator or parent may decide for, the own log.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, settings, P, ADMIN, MARC, LEA, TIM, GAST } = require('./helpers');

const LOG = [
  { peerId: P.leaPhone, name: 'ads.tiktok.com', action: 'block', reason: 'list', profileId: 'pkinder01', list: 'ads' },
  { peerId: P.leaPhone, name: 'ads.tiktok.com', action: 'block', reason: 'list', profileId: 'pkinder01', list: 'ads' },
  { peerId: P.leaPhone, name: 'www.google.com', action: 'allow', reason: 'safe_search', profileId: 'pkinder01' },
  { peerId: P.marcPhone, name: 'paket-zustellung-dhl.top', action: 'block', reason: 'list', profileId: 'default', list: 'malware' },
  { peerId: P.leaPhone, name: 'roblox.com', action: 'block', reason: 'profile_deny', profileId: 'pkinder01' },
  { peerId: P.leaPhone, name: 'example.org', action: 'allow', reason: 'suspended', profileId: 'pkinder01' },
];
const withLog = (o = {}) => ({ settings: settings({ log: { enabled: true, retentionDays: 7 } }), vpnDns: { log: LOG, perPeer: { [P.leaPhone]: { queries: 3310, blocked: 893 }, [P.marcPhone]: { queries: 3845, blocked: 604 }, [P.officePc]: { queries: 2319, blocked: 149 } } }, ...o });

describe('GET status', () => {
  let s;
  afterEach(async () => { if (s) await s.host.close(); s = null; });

  it('the own device: state, profile, the times of today, what is allowed — counters of the server without the query log', async () => {
    s = await setup();
    const st = await s.app(LEA, P.leaPhone, 'GET', 'status');
    assert.equal(st.http, 200);
    assert.deepEqual([st.state, st.enabled, st.pause, st.outage], ['active', true, null, null]);
    assert.deepEqual(st.device, { peerId: P.leaPhone, name: 'Leas Handy', platform: 'android', state: 'filtered', ownDns: null });
    assert.deepEqual(st.profile, { id: 'pkinder01', name: 'Kinder', safeSearch: true });
    assert.deepEqual(st.counters, { scope: 'server', queries: 18432, blocked: 3127, percent: 17 });
    assert.equal(st.top, null, 'nothing per device without the query log');
    assert.deepEqual(st.may, { pause: true, resume: false, extend: false, reason: null, durations: [5, 30, 60], maxMinutes: 60, forever: false });
    assert.deepEqual(st.devices.map((d) => [d.peerId, d.state, d.today]), [[P.leaPhone, 'filtered', null]]);
    assert.deepEqual(st.log, { enabled: false, visible: false });
    assert.equal(st.manage, false);
    assert.ok(Array.isArray(st.today) && st.today.every((x) => x.block === 'categories' && x.from && x.to));
    assert.ok(Date.parse(st.serverTime) > 0);
  });

  it('with the query log on: the counters of this device, the top blocked domains only when users may see the log', async () => {
    s = await setup(withLog());
    let st = await s.app(LEA, P.leaPhone, 'GET', 'status');
    assert.deepEqual(st.counters, { scope: 'device', queries: 3310, blocked: 893, percent: 27 });
    assert.equal(st.top, null, 'log view "Nur Admins"');
    assert.deepEqual(st.log, { enabled: true, visible: false });
    await s.config({ logView: 'own' });
    st = await s.app(LEA, P.leaPhone, 'GET', 'status');
    assert.deepEqual(st.top, [{ domain: 'ads.tiktok.com', count: 2 }, { domain: 'roblox.com', count: 1 }]);
    assert.deepEqual(st.log, { enabled: true, visible: true });
    // the portal has no asking device: all own devices together
    st = await s.portal(MARC, 'GET', 'status');
    assert.equal(st.device, null);
    assert.deepEqual(st.counters, { scope: 'person', queries: 6164, blocked: 753, percent: 12.2 });
    assert.deepEqual(st.devices.map((d) => d.name), ['Büro-PC', 'Marcs Dienst-Laptop', 'Marcs Handy']);
  });

  it('paused, fallback, off, not filtered, a token without a peer, a foreign peer id', async () => {
    s = await setup();
    await s.app(LEA, P.leaPhone, 'POST', 'pause', { minutes: 30 });
    let st = await s.app(LEA, P.leaPhone, 'GET', 'status');
    assert.deepEqual([st.state, st.pause.scope, st.pause.byMe, st.pause.openEnd, st.may.pause, st.may.resume, st.may.extend], ['paused', 'peer', true, false, false, true, true]);
    assert.ok(st.pause.remainingSeconds > 1790 && st.pause.remainingSeconds <= 1800);
    // Marc's device with a DNS server of its own
    st = await s.app(MARC, P.marcWork, 'GET', 'status');
    assert.deepEqual([st.state, st.device.state, st.device.ownDns, st.may.pause, st.may.reason], ['unfiltered', 'ownDns', '1.1.1.1', false, 'not_filtered']);
    // no peer: the person's devices; somebody else's peer id is never taken as the own device
    st = await s.app(MARC, null, 'GET', 'status');
    assert.deepEqual([st.device, st.state, st.may.pause], [null, 'active', true]);
    st = await s.app(GAST, P.leaPhone, 'GET', 'status');
    assert.equal(st.device, null);
    assert.deepEqual(st.devices.map((d) => d.peerId), [P.guest]);
    // the filter fell back
    await s.host.vpnDnsEvent({ type: 'fallback' });
    st = await s.app(LEA, P.leaPhone, 'GET', 'status');
    assert.deepEqual([st.state, st.may.pause, st.may.resume, st.may.reason, typeof st.outage.since], ['fallback', false, false, 'fallback', 'string']);
    let r = await s.app(LEA, P.leaPhone, 'POST', 'pause', { minutes: 5 });
    assert.deepEqual([r.http, r.code], [409, 'not_filtering']);
    await s.host.vpnDnsEvent({ type: 'restored' });
    // switched off
    await s.admin('PUT', 'settings', { enabled: false });
    st = await s.app(LEA, P.leaPhone, 'GET', 'status');
    assert.deepEqual([st.state, st.enabled, st.may.pause, st.may.reason], ['off', false, false, 'off']);
    r = await s.app(LEA, P.leaPhone, 'POST', 'pause', { minutes: 5 });
    assert.deepEqual([r.http, r.code], [409, 'off']);
    assert.equal(s.host.vpnDnsClientInfo(), null, 'GET /api/v1/client/permissions: vpnDns null while it is off');
  });

  it('only a signed-in person; a server without gc.vpnDns answers 501 unsupported', async () => {
    s = await setup();
    let r = await s.host.request({ method: 'GET', path: '/status', user: { ...LEA, portal: true, loggedIn: false } });
    assert.deepEqual([r.status, r.json.code], [403, 'forbidden']);
    r = await s.host.request({ method: 'POST', path: '/pause', body: { minutes: 5 }, user: { ...LEA, portal: true, loggedIn: true, kiosk: true } });
    assert.deepEqual([r.status, r.json.code], [403, 'forbidden']);
    r = await s.host.request({ method: 'GET', path: '/nope', user: { ...LEA, portal: true, loggedIn: true } });
    assert.equal(r.status, 404);
    await s.host.close();
    s = await setup({ host: { gatecontrol: '1.263.2', vpnDns: undefined } });
    assert.equal(s.host.gc.vpnDns, undefined);
    r = await s.app(LEA, P.leaPhone, 'GET', 'status');
    assert.deepEqual([r.http, r.code], [501, 'unsupported']);
    assert.equal(await s.host.portalVisible({ ...LEA, portal: true, loggedIn: true }), false);
  });
});

describe('POST pause / resume', () => {
  let s;
  afterEach(async () => { if (s) await s.host.close(); s = null; });

  it('the asking device by default, all own devices without one; +30 min; switching back on', async () => {
    s = await setup({ config: { pause: { maxMinutes: 240 } } });
    let r = await s.app(MARC, P.marcPhone, 'POST', 'pause', { minutes: 30 });
    assert.deepEqual([r.http, r.pause.scope, r.pause.byMe, r.status.state], [200, 'peer', true, 'paused']);
    assert.deepEqual([...s.host.vpnDns.pauses.keys()], ['peer:' + P.marcPhone]);
    assert.equal(r.status.devices.find((d) => d.peerId === P.officePc).suspended, false, 'only this device');
    // +30 min
    const before = Date.parse(r.pause.until);
    r = await s.app(MARC, P.marcPhone, 'POST', 'pause', { extend: 30 });
    assert.equal(Date.parse(r.pause.until) - before, 30 * 60000);
    r = await s.app(MARC, P.marcPhone, 'POST', 'resume', {});
    assert.deepEqual([r.resumed, r.status.state, r.status.pause], [true, 'active', null]);
    r = await s.app(MARC, P.marcPhone, 'POST', 'resume', {});
    assert.deepEqual([r.http, r.resumed], [200, false]);
    // the portal: all devices of the person; ending it on one device ends the person's suspension
    r = await s.portal(MARC, 'POST', 'pause', { minutes: 60 });
    assert.deepEqual([r.pause.scope, r.status.state], ['user', 'paused']);
    assert.deepEqual(r.status.devices.map((d) => [d.name, d.suspended]), [['Büro-PC', true], ['Marcs Dienst-Laptop', true], ['Marcs Handy', true]]);
    r = await s.app(MARC, P.marcPhone, 'POST', 'resume', {});
    assert.deepEqual([r.resumed, r.status.state], [true, 'active']);
    assert.equal(s.host.vpnDns.pauses.size, 0);
  });

  it('bad bodies, unknown targets, a gateway, a device that is not filtered, a person without a device', async () => {
    s = await setup();
    for (const body of [{}, { minutes: 0 }, { minutes: 1.5 }, { minutes: '5' }, { extend: -1 }, { forever: 'yes' }]) {
      const r = await s.app(LEA, P.leaPhone, 'POST', 'pause', body);
      assert.deepEqual([r.http, r.code], [400, 'invalid'], JSON.stringify(body));
    }
    let r = await s.app(ADMIN, P.annaPhone, 'POST', 'pause', { peerId: 999, minutes: 5 });
    assert.deepEqual([r.http, r.code], [404, 'not_found']);
    r = await s.app(ADMIN, P.annaPhone, 'POST', 'pause', { peerId: P.gateway, minutes: 5 });
    assert.deepEqual([r.http, r.code], [404, 'not_found']);
    r = await s.app(ADMIN, P.annaPhone, 'POST', 'pause', { userId: 999, minutes: 5 });
    assert.deepEqual([r.http, r.code], [404, 'not_found']);
    r = await s.app(MARC, P.marcWork, 'POST', 'pause', { minutes: 5 });
    assert.deepEqual([r.http, r.code, r.reason], [403, 'not_allowed', 'not_filtered']);
    assert.equal(s.host.vpnDns.pauses.size, 0);
    // English texts
    r = await s.app(MARC, P.marcWork, 'POST', 'pause', { minutes: 5 }, 'en');
    assert.match(r.error, /not filtered/);
  });

  it('two people at once: every change names its actor (no ERR_NOT_PERSON)', async () => {
    s = await setup();
    const [a, b] = await Promise.all([s.app(LEA, P.leaPhone, 'POST', 'pause', { minutes: 5 }), s.app(TIM, P.timTablet, 'POST', 'pause', { minutes: 5 })]);
    assert.deepEqual([a.http, b.http], [200, 200]);
    assert.deepEqual(s.host.vpnDns.activity.filter((x) => x.type === 'vpn_dns_paused').map((x) => x.actor).sort(), [LEA.id, TIM.id]);
  });
});

describe('GET people', () => {
  let s;
  afterEach(async () => { if (s) await s.host.close(); s = null; });

  it('a parent: oneself and the family with what is allowed; an administrator: everybody and "all"; others: 403', async () => {
    s = await setup();
    let r = await s.app(MARC, P.marcPhone, 'GET', 'people');
    assert.equal(r.http, 200);
    assert.equal(r.all, null);
    assert.deepEqual(r.people.map((p) => [p.name, p.self, p.may.pause]), [['Marc', true, true], ['Lea', false, true], ['Tim', false, true]], 'Sabine has no VPN device');
    assert.deepEqual(r.people[1].devices.map((d) => [d.peerId, d.may.pause, d.profile.name]), [[P.leaPhone, true, 'Kinder']]);
    r = await s.app(ADMIN, P.annaPhone, 'GET', 'people');
    assert.deepEqual(r.people.map((p) => p.name), ['Anna', 'Chef', 'Gast', 'Lea', 'Marc', 'Tim']);
    assert.deepEqual([r.all.may.pause, r.all.may.forever, r.all.pause], [true, true, null]);
    assert.ok(r.people.every((p) => p.may.pause));
    r = await s.app(LEA, P.leaPhone, 'GET', 'people');
    assert.deepEqual([r.http, r.code], [403, 'forbidden']);
    r = await s.app(GAST, P.guest, 'GET', 'people');
    assert.equal(r.http, 403);
  });
});

describe('GET log (the own devices only)', () => {
  let s;
  afterEach(async () => { if (s) await s.host.close(); s = null; });

  it('never another person\'s queries; "Nur Admins" hides it from users; off → log_off', async () => {
    s = await setup(withLog({ config: { logView: 'own' } }));
    let r = await s.portal(LEA, 'GET', 'log');
    assert.equal(r.http, 200);
    assert.ok(r.entries.length === 5 && r.entries.every((e) => e.peerId === P.leaPhone && e.device === 'Leas Handy'));
    assert.deepEqual(r.entries.map((e) => e.result), ['allowed_paused', 'blocked', 'safe_search', 'blocked', 'blocked']);
    assert.deepEqual(r.entries[1], { id: r.entries[1].id, at: r.entries[1].at, peerId: P.leaPhone, device: 'Leas Handy', person: 'Lea', domain: 'roblox.com', type: 'A', result: 'blocked', action: 'block', reason: 'profile_deny', list: null, scope: null, profile: { id: 'pkinder01', name: 'Kinder' } });
    r = await s.portal(LEA, 'GET', 'log', null, { blockedOnly: '1', search: 'tiktok', limit: '1' });
    assert.deepEqual([r.entries.length, r.entries[0].domain, typeof r.next], [1, 'ads.tiktok.com', 'number']);
    r = await s.portal(LEA, 'GET', 'log', null, { blockedOnly: '1', search: 'tiktok', limit: '1', before: String(r.next) });
    assert.deepEqual([r.entries.length, r.next], [1, null]);
    // somebody else's device, also for a parent and an administrator (the settings page shows everything)
    for (const who of [LEA, MARC, ADMIN]) {
      r = await s.portal(who, 'GET', 'log', null, { peerId: String(who === LEA ? P.marcPhone : P.leaPhone) });
      assert.deepEqual([r.http, r.code], [403, 'forbidden'], who.name);
    }
    r = await s.portal(ADMIN, 'GET', 'log');
    assert.deepEqual(r.entries, [], 'the administrator\'s own devices asked nothing');
    await s.config({ logView: 'admins' });
    r = await s.portal(LEA, 'GET', 'log');
    assert.deepEqual([r.http, r.code, r.reason], [403, 'not_allowed', 'log_admins_only']);
    assert.equal((await s.portal(ADMIN, 'GET', 'log')).http, 200);
    await s.admin('PUT', 'settings', { log: { enabled: false } });
    r = await s.portal(ADMIN, 'GET', 'log');
    assert.deepEqual([r.http, r.code], [409, 'log_off']);
    assert.equal(s.host.vpnDns.log.length, 0, 'switching the log off deletes it');
  });
});

describe('portal tab', () => {
  let s;
  afterEach(async () => { if (s) await s.host.close(); s = null; });

  it('visible for people with a VPN device, parents and administrators — while the protection is on', async () => {
    s = await setup();
    const vis = (u, extra) => s.host.portalVisible({ ...u, portal: true, loggedIn: true, ...extra });
    assert.equal(await vis(LEA), true);
    assert.equal(await vis(ADMIN), true);
    assert.equal(await vis({ id: 3, name: 'Sabine', role: 'user' }), true, 'a parent without a device decides for the children');
    assert.equal(await vis(LEA, { loggedIn: false }), false);
    assert.equal(await vis(LEA, { kiosk: true }), false);
    await s.admin('PUT', 'settings', { enabled: false });
    assert.equal(await vis(LEA), false);
    assert.equal(await vis(ADMIN), false);
  });
});
