'use strict';

// What 1.1.0 adds (GateControl ≥ 1.267.0, gc.vpnDns.version 4): "Fremden DNS und DoT sperren", the entry that hit and
// for whom an own entry holds ("Domain prüfen", the query log), profiles shared
// with a home network, "Internet pausieren" of the family plugin on the VPN devices, the picked duration of a
// suspension, the suspension per person, the notice "Filter ausgefallen" for users.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, settings, P, ADMIN, MARC, LEA, TIM, GAST } = require('./helpers');

const HOME = () => [{
  gateway: { peerId: P.gateway, name: 'Pi Keller' },
  profiles: [
    { id: 'default', name: 'Standard', lists: ['ads'] },
    { id: 'phome0001', name: 'Kinder zu Hause', lists: ['ads', 'adult'], safeSearch: true, deny: ['tiktok.com'], users: [4], devices: 3 },
  ],
}];

describe('"Umgehung erschweren": foreign DNS and DoT', () => {
  let s;
  afterEach(async () => { if (s) await s.host.close(); s = null; });

  it('off by default; switched on: active for the filtered devices only; an error of the firewall is shown', async () => {
    s = await setup();
    let all = await s.admin('GET', 'all');
    assert.equal(all.settings.blockForeignDns, false);
    assert.deepEqual(all.status.foreignDns, { enabled: false, active: false, devices: 0, since: null, error: null });
    let r = await s.admin('PUT', 'settings', { blockForeignDns: true });
    assert.deepEqual([r.http, r.settings.blockForeignDns, r.status.foreignDns.enabled, r.status.foreignDns.active, r.status.foreignDns.devices], [200, true, true, true, 8]);
    all = await s.admin('GET', 'all');
    const blocked = (id) => all.devices.find((d) => d.peerId === id).foreignDnsBlocked;
    assert.deepEqual([blocked(P.leaPhone), blocked(P.marcWork), blocked(P.gateway)], [true, false, false], 'own DNS and gateways stay untouched');
    // suspended for everybody, or the filter fell back: no rules
    await s.admin('POST', 'pause', { minutes: 5 });
    assert.deepEqual([(await s.admin('GET', 'live')).status.foreignDns.active], [false]);
    await s.admin('POST', 'resume');
    s.host.vpnDnsSet({ foreignDnsError: 'iptables-restore: line 4 failed' });
    const fd = (await s.admin('GET', 'live')).status.foreignDns;
    assert.deepEqual([fd.enabled, fd.active, fd.error], [true, false, 'iptables-restore: line 4 failed']);
    r = await s.admin('PUT', 'settings', { blockForeignDns: 'yes' });
    assert.deepEqual([r.http, r.code], [400, 'invalid']);
    assert.deepEqual(s.host.vpnDns.activity.filter((a) => a.type === 'vpn_dns_changed').map((a) => a.changed), [['blockForeignDns']]);
  });
});

describe('"Domain prüfen" and the query log: the entry that hit, for whom it holds', () => {
  let s;
  afterEach(async () => { if (s) await s.host.close(); s = null; });

  it('test: match { entry, kind } and scope', async () => {
    s = await setup();
    const check = async (body) => { const r = (await s.admin('POST', 'test', body)).result; return [r.action, r.reason, r.scope, r.match, r.list]; };
    assert.deepEqual(await check({ domain: 'shop.temu.com' }), ['block', 'profile_deny', 'all', { entry: 'temu.com', kind: 'domain' }, null]);
    assert.deepEqual(await check({ domain: 'roblox.com', profileId: 'pkinder01' }), ['block', 'profile_deny', 'profile', { entry: 'roblox.com', kind: 'domain' }, null]);
    assert.deepEqual(await check({ domain: 'www.paypal.com', peerId: P.leaPhone }), ['allow', 'profile_allow', 'all', { entry: 'paypal.com', kind: 'domain' }, null]);
    assert.deepEqual(await check({ domain: 'anton.app', peerId: P.leaPhone }), ['allow', 'profile_allow', 'profile', { entry: 'anton.app', kind: 'domain' }, null]);
    assert.deepEqual(await check({ domain: 'cdn.ads.tiktok.com' }), ['block', 'list', null, { entry: 'ads.tiktok.com', kind: 'domain' }, 'ads']);
    assert.deepEqual(await check({ domain: 'example.org' }), ['allow', 'default', null, null, null]);
  });

  it('log: entries carry the scope, the filter narrows to it', async () => {
    const now = Date.now();
    const log = [
      { at: now - 5000, peerId: P.leaPhone, name: 'temu.com', action: 'block', reason: 'profile_deny', profileId: 'pkinder01', scope: 'all' },
      { at: now - 4000, peerId: P.leaPhone, name: 'roblox.com', action: 'block', reason: 'profile_deny', profileId: 'pkinder01', scope: 'profile' },
      { at: now - 3000, peerId: P.leaPhone, name: 'anton.app', action: 'allow', reason: 'profile_allow', profileId: 'pkinder01', scope: 'profile' },
      { at: now - 2000, peerId: P.leaPhone, name: 'doubleclick.net', action: 'block', reason: 'list', profileId: 'pkinder01', list: 'ads' },
      { at: now - 1000, peerId: P.leaPhone, name: 'old.example', action: 'block', reason: 'profile_deny', profileId: 'pkinder01' },
    ];
    s = await setup({ settings: settings({ log: { enabled: true, retentionDays: 7 } }), vpnDns: { log }, config: { logView: 'own' } });
    let r = await s.admin('GET', 'log');
    assert.deepEqual(r.entries.map((e) => [e.domain, e.scope]), [['old.example', null], ['doubleclick.net', null], ['anton.app', 'profile'], ['roblox.com', 'profile'], ['temu.com', 'all']]);
    r = await s.admin('GET', 'log', null, { scope: 'all' });
    assert.deepEqual(r.entries.map((e) => e.domain), ['temu.com']);
    r = await s.admin('GET', 'log', null, { scope: 'profile', blockedOnly: '1' });
    assert.deepEqual(r.entries.map((e) => e.domain), ['roblox.com']);
    r = await s.admin('GET', 'log', null, { scope: 'nonsense' });
    assert.equal(r.entries.length, 5, 'an unknown scope does not filter');
    r = await s.portal(LEA, 'GET', 'log');
    assert.deepEqual(r.entries.map((e) => e.scope), [null, null, 'profile', 'profile', 'all']);
  });

  it('blockedBy of today reaches the overview', async () => {
    s = await setup({ vpnDns: { today: { queries: 100, blocked: 30, cached: 0, top: [], blockedBy: { list: 20, denyAll: 4, denyProfile: 3, schedule: 2, pause: 1 } } } });
    const all = await s.admin('GET', 'all');
    assert.deepEqual(all.status.today.blockedBy, { list: 20, denyAll: 4, denyProfile: 3, schedule: 2, pause: 1, other: 0 });
    assert.deepEqual((await s.admin('GET', 'live')).today.blockedBy, all.status.today.blockedBy);
  });
});

describe('profiles shared with a home network', () => {
  let s;
  afterEach(async () => { if (s) await s.host.close(); s = null; });
  const homeProfile = (id) => s.host.vpnDns.homes[0].profiles.find((p) => p.id === id);

  it('link to a profile of the home: its content is taken over, the name and the VPN members stay', async () => {
    s = await setup({ vpnDns: { homes: HOME() } });
    let all = await s.admin('GET', 'all');
    assert.deepEqual(all.homes.map((h) => [h.gateway, h.configured, h.profiles.map((p) => [p.id, p.name, p.linkedTo])]), [[{ peerId: P.gateway, name: 'Pi Keller' }, true, [['default', 'Standard', null], ['phome0001', 'Kinder zu Hause', null]]]]);
    let r = await s.admin('PUT', 'profiles/pkinder01', { profile: { name: 'Kinder', home: { gateway: P.gateway, profile: 'phome0001' }, groups: [], peerGroups: [], peers: [P.timTablet] } });
    assert.equal(r.http, 200);
    assert.deepEqual(r.profile.home, { gateway: P.gateway, profile: 'phome0001', gatewayName: 'Pi Keller', name: 'Kinder zu Hause' });
    assert.deepEqual([r.profile.name, r.profile.lists, r.profile.safeSearch, r.profile.deny, r.profile.allow, r.profile.users, r.profile.peers, r.profile.schedules], ['Kinder', ['ads', 'adult'], true, ['tiktok.com'], [], [4], [P.timTablet], []]);
    all = await s.admin('GET', 'all');
    assert.equal(all.homes[0].profiles[1].linkedTo, 'pkinder01');
    // a change here is a change of the shared profile
    r = await s.admin('PUT', 'profiles/pkinder01', { profile: { name: 'Kinder unterwegs', lists: ['ads', 'adult', 'gambling'], users: [4, 5] } });
    assert.deepEqual([homeProfile('phome0001').lists, homeProfile('phome0001').users, homeProfile('phome0001').name, r.profile.name], [['ads', 'adult', 'gambling'], [4, 5], 'Kinder zu Hause', 'Kinder unterwegs']);
    r = await s.admin('POST', 'entries', { list: 'deny', domains: ['snapchat.com'], profileId: 'pkinder01' });
    assert.deepEqual(homeProfile('phome0001').deny, ['snapchat.com', 'tiktok.com']);
    // a change at home is seen here
    s.host.vpnDns.homes[0].profiles[1].safeSearch = false;
    assert.equal((await s.admin('GET', 'all')).settings.profiles.find((p) => p.id === 'pkinder01').safeSearch, false);
    // a home profile only once
    r = await s.admin('PUT', 'profiles/pbuero001', { profile: { home: { gateway: P.gateway, profile: 'phome0001' } } });
    assert.deepEqual([r.http, r.code], [400, 'home_invalid']);
    // unlink: both keep what they have
    r = await s.admin('PUT', 'profiles/pkinder01', { profile: { home: null } });
    assert.deepEqual([r.profile.home, r.profile.lists, homeProfile('phome0001').lists], [null, ['ads', 'adult', 'gambling'], ['ads', 'adult', 'gambling']]);
    r = await s.admin('PUT', 'profiles/pkinder01', { profile: { lists: ['ads'] } });
    assert.deepEqual(homeProfile('phome0001').lists, ['ads', 'adult', 'gambling'], 'separate again');
  });

  it('"im Heimnetz neu anlegen": the home gets the profile; a name taken there saves nothing', async () => {
    s = await setup({ vpnDns: { homes: HOME() } });
    let r = await s.admin('PUT', 'profiles/pbuero001', { profile: { home: { gateway: P.gateway, create: true } } });
    assert.equal(r.http, 200);
    const made = homeProfile(r.profile.home.profile);
    assert.deepEqual([r.profile.home.gatewayName, r.profile.home.name, made.name, made.lists, made.allow], ['Pi Keller', 'Büro', 'Büro', ['malware'], ['login.microsoftonline.com']]);
    r = await s.admin('POST', 'profiles', { profile: { name: 'Kinder zu Hause', lists: ['ads'], home: { gateway: P.gateway, create: true } } });
    assert.deepEqual([r.http, r.code], [409, 'home_name_taken']);
    assert.deepEqual([(await s.admin('GET', 'all')).settings.profiles.length, s.host.vpnDns.homes[0].profiles.length], [3, 3], 'nothing was saved on either side');
    // a new profile that takes a home profile over
    r = await s.admin('POST', 'profiles', { profile: { name: 'Zuhause', home: { gateway: P.gateway, profile: 'phome0001' } } });
    assert.deepEqual([r.http, r.profile.lists, r.profile.users, r.profile.home.name], [200, ['ads', 'adult'], [4], 'Kinder zu Hause']);
  });

  it('the default profile only goes with the home\'s default profile; bad values', async () => {
    s = await setup({ vpnDns: { homes: HOME() } });
    let r = await s.admin('PUT', 'profiles/default', { profile: { home: { gateway: P.gateway, profile: 'phome0001' } } });
    assert.deepEqual([r.http, r.code], [400, 'home_invalid']);
    r = await s.admin('PUT', 'profiles/default', { profile: { home: { gateway: P.gateway, create: true } } });
    assert.deepEqual([r.http, r.code], [400, 'home_invalid']);
    r = await s.admin('PUT', 'profiles/default', { profile: { home: { gateway: P.gateway, profile: 'default' } } });
    assert.deepEqual([r.http, r.profile.lists, r.profile.home.name], [200, ['ads'], 'Standard']);
    for (const home of ['x', {}, { gateway: 'pi' }, { gateway: P.gateway }, { gateway: P.gateway, profile: 7 }, []]) {
      r = await s.admin('PUT', 'profiles/pkinder01', { profile: { home } });
      assert.deepEqual([r.http, r.code, r.detail], [400, 'invalid', 'profile.home'], JSON.stringify(home));
    }
    r = await s.admin('PUT', 'profiles/pkinder01', { profile: { home: { gateway: 999, profile: 'phome0001' } } });
    assert.deepEqual([r.http, r.code], [400, 'home_invalid']);
  });

  it('a home profile that is gone: the link is dropped, the profile keeps the last content', async () => {
    s = await setup({ vpnDns: { homes: HOME() } });
    await s.admin('PUT', 'profiles/pkinder01', { profile: { home: { gateway: P.gateway, profile: 'phome0001' } } });
    s.host.vpnDnsSet({ homes: [{ gateway: { peerId: P.gateway, name: 'Pi Keller' }, profiles: [{ id: 'default', name: 'Standard' }] }] });
    const p = (await s.admin('GET', 'all')).settings.profiles.find((x) => x.id === 'pkinder01');
    assert.deepEqual([p.home, p.lists, p.deny], [null, ['ads', 'adult'], ['tiktok.com']]);
  });
});

describe('"Internet pausieren" of the family plugin on the VPN devices', () => {
  let s;
  afterEach(async () => { if (s) await s.host.close(); s = null; });
  const until = () => Date.now() + 45 * 60000;

  it('status: the protection is active, the internet is paused — suspending is no way out', async () => {
    const end = until();
    s = await setup({ vpnDns: { internet: { pause: { [LEA.id]: end } } } });
    let r = await s.app(LEA, P.leaPhone, 'GET', 'status');
    assert.deepEqual([r.http, r.state, r.pause], [200, 'active', null], 'no new state: older apps keep showing "active"');
    assert.deepEqual([r.internet.paused, r.internet.until, r.internet.remainingSeconds > 2600], [true, new Date(end).toISOString(), true]);
    assert.deepEqual(r.may, { pause: false, resume: false, extend: false, reason: 'internet_paused', durations: [], maxMinutes: 60, forever: false });
    assert.deepEqual([r.devices[0].internetPaused, r.devices[0].timesSuspended], [new Date(end).toISOString(), null]);
    r = await s.app(LEA, P.leaPhone, 'POST', 'pause', { minutes: 5 });
    assert.deepEqual([r.http, r.code, r.reason], [403, 'not_allowed', 'internet_paused']);
    assert.equal(r.error, 'Das Internet ist pausiert (Familie). Den Schutz zu unterbrechen ändert daran nichts.');
    assert.equal(s.host.vpnDns.pauses.size, 0);
    // the sibling is not paused
    r = await s.app(TIM, P.timTablet, 'GET', 'status');
    assert.deepEqual([r.internet, r.may.pause, r.may.reason], [null, true, null]);
    // "Domain prüfen" for the device: paused — only "Immer erlaubt" answers
    assert.deepEqual([(await s.admin('POST', 'test', { domain: 'example.org', peerId: P.leaPhone })).result.reason, (await s.admin('POST', 'test', { domain: 'anton.app', peerId: P.leaPhone })).result.reason], ['paused', 'profile_allow']);
  });

  it('people: the parent sees the pause and gets no button for it; the administrator neither', async () => {
    const end = until();
    s = await setup({ vpnDns: { internet: { pause: { [LEA.id]: end }, extend: { [TIM.id]: end } } } });
    for (const who of [MARC, ADMIN]) {
      const r = await s.portal(who, 'GET', 'people');
      const lea = r.people.find((p) => p.userId === LEA.id);
      const tim = r.people.find((p) => p.userId === TIM.id);
      assert.deepEqual([lea.internet.until, lea.may.pause, lea.may.reason, lea.devices[0].may.reason, lea.devices[0].internetPaused], [new Date(end).toISOString(), false, 'internet_paused', 'internet_paused', new Date(end).toISOString()], who.name);
      assert.deepEqual([tim.internet, tim.may.pause, tim.devices[0].timesSuspended], [null, true, new Date(end).toISOString()], who.name);
      const p = await s.portal(who, 'POST', 'pause', { minutes: 5, userId: LEA.id });
      assert.deepEqual([p.http, p.code, p.reason], [403, 'not_allowed', 'internet_paused'], who.name);
    }
    // for all VPN devices an administrator still suspends (it does not lift the pause)
    const all = await s.admin('POST', 'pause', { minutes: 5 });
    assert.equal(all.http, 200);
    const r = await s.app(LEA, P.leaPhone, 'GET', 'status');
    assert.deepEqual([r.state, r.internet.paused, r.may.reason], ['paused', true, 'paused_for_all']);
  });

  it('a device that was suspended before the pause can still be switched back on', async () => {
    s = await setup();
    await s.app(LEA, P.leaPhone, 'POST', 'pause', { minutes: 30 });
    s.host.vpnDnsSet({ internet: { pause: { [LEA.id]: until() } } });
    let r = await s.app(LEA, P.leaPhone, 'GET', 'status');
    assert.deepEqual([r.state, r.internet.paused, r.may.pause, r.may.resume, r.may.extend, r.may.reason], ['paused', true, false, true, true, null]);
    r = await s.app(LEA, P.leaPhone, 'POST', 'resume', {});
    assert.deepEqual([r.http, r.resumed, r.status.state, r.status.may.reason], [200, true, 'active', 'internet_paused']);
  });

  it('the setting "wirkt auch unterwegs" off: nothing of it reaches the VPN devices', async () => {
    s = await setup({ vpnDns: { internet: { pause: { [LEA.id]: until() } } } });
    assert.equal((await s.admin('GET', 'all')).settings.homeInternet, true, 'on by default');
    let r = await s.admin('PUT', 'settings', { homeInternet: false });
    assert.deepEqual([r.http, r.settings.homeInternet], [200, false]);
    r = await s.app(LEA, P.leaPhone, 'GET', 'status');
    assert.deepEqual([r.internet, r.may.pause, r.devices[0].internetPaused], [null, true, null]);
    r = await s.admin('PUT', 'settings', { homeInternet: 1 });
    assert.deepEqual([r.http, r.code], [400, 'invalid']);
  });
});

describe('small additions for the apps', () => {
  let s;
  afterEach(async () => { if (s) await s.host.close(); s = null; });

  it('pause.minutes: the picked duration, with "+30 Min." the whole of it, null without an end', async () => {
    s = await setup({ config: { pause: { forever: true, maxMinutes: 240 } } });
    let r = await s.app(LEA, P.leaPhone, 'POST', 'pause', { minutes: 30 });
    assert.deepEqual([r.pause.minutes, r.status.pause.minutes], [30, 30]);
    r = await s.app(LEA, P.leaPhone, 'POST', 'pause', { extend: 30 });
    assert.equal(r.status.pause.minutes, 60);
    r = await s.app(LEA, P.leaPhone, 'POST', 'pause', { forever: true });
    assert.deepEqual([r.status.pause.openEnd, r.status.pause.minutes], [true, null]);
  });

  it('people[].pause: the suspension of the person, else the one all its filtered devices share', async () => {
    s = await setup();
    await s.portal(MARC, 'POST', 'pause', { minutes: 30, userId: LEA.id });
    await s.app(TIM, P.timTablet, 'POST', 'pause', { minutes: 5 });
    await s.app(MARC, P.marcPhone, 'POST', 'pause', { minutes: 5 });
    const r = await s.portal(MARC, 'GET', 'people');
    const of = (u) => r.people.find((p) => p.userId === u.id);
    assert.deepEqual([of(LEA).pause.scope, of(LEA).pause.minutes, of(LEA).pause.byMe, of(LEA).pause.by.name], ['user', 30, true, 'Marc']);
    assert.deepEqual([of(TIM).pause.scope, of(TIM).pause.minutes, of(TIM).pause.byMe], ['peer', 5, false], 'the one device Tim has');
    assert.equal(of(MARC).pause, null, 'only one of Marc\'s filtered devices is suspended');
    assert.deepEqual([of(LEA).internet, of(TIM).internet], [null, null]);
  });

  it('"Filter ausgefallen" also for users: off by default, then everybody whose VPN device is filtered — never twice for administrators', async () => {
    s = await setup({ config: { notify: { outageUsers: true } } });
    await s.host.vpnDnsEvent({ type: 'fallback' });
    assert.deepEqual(s.host.notifications.map((n) => [n.topic, n.users, n.priority]), [['outage', [ADMIN.id, 7], 'high'], ['outage', [MARC.id, LEA.id, TIM.id, GAST.id], 'normal']]);
    assert.match(s.host.notifications[1].body, /^Seit \d\d:\d\d Uhr antwortet der Filter nicht\. Dein Internet über das VPN läuft ungefiltert weiter/);
    await s.host.vpnDnsEvent({ type: 'restored' });
    assert.deepEqual(s.host.notifications.slice(2).map((n) => [n.users.length, n.title]), [[2, 'DNS-Schutz läuft wieder'], [4, 'DNS-Schutz läuft wieder']]);
    let r = await s.config({ notify: { outageUsers: false } });
    assert.equal(r.config.notify.outageUsers, false);
    await s.host.vpnDnsEvent({ type: 'fallback' });
    assert.equal(s.host.notifications.length, 5, 'only the administrators again');
    r = await s.config({ notify: { outageUsers: 'yes' } });
    assert.deepEqual([r.http, r.code], [400, 'invalid']);
  });
});
