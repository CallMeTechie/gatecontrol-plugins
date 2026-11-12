'use strict';

// The settings page (admin/*): only an administrator in the admin UI; lists and own entries, profiles (with the
// switch "Mitglieder dürfen unterbrechen"), devices, suspending for all VPN devices, "Domain prüfen", the query log,
// the plugin's own settings, the set-up dialog and the move from Pi-hole.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, settings, P, ADMIN, MARC, LEA } = require('./helpers');

describe('who gets to the settings page', () => {
  let s;
  afterEach(async () => { if (s) await s.host.close(); s = null; });

  it('an administrator in the admin UI — never a user, never the portal or an app, not even as an administrator', async () => {
    s = await setup();
    assert.equal((await s.admin('GET', 'all')).http, 200);
    for (const user of [MARC, { ...ADMIN, portal: true, loggedIn: true }, { ...ADMIN, portal: true, loggedIn: true, app: true }, { ...ADMIN, automation: true }]) {
      for (const [m, p, b] of [['GET', 'all'], ['PUT', 'settings', { enabled: false }], ['PUT', 'config', { logView: 'own' }], ['POST', 'pause', { minutes: 5 }], ['GET', 'log'], ['POST', 'restart']]) {
        const r = await s.admin(m, p, b, null, user);
        assert.deepEqual([r.http, r.code], [403, 'forbidden'], `${user.name} ${m} ${p}`);
      }
    }
    assert.equal(s.host.vpnDns.settings.enabled, true);
    assert.equal((await s.admin('GET', 'nope')).http, 404);
  });
});

describe('admin/all, lists and own entries', () => {
  let s;
  afterEach(async () => { if (s) await s.host.close(); s = null; });

  it('everything the page shows', async () => {
    s = await setup();
    const r = await s.admin('GET', 'all');
    assert.deepEqual(Object.keys(r).sort(), ['catalog', 'config', 'devices', 'durations', 'groups', 'http', 'lists', 'maxMinutes', 'ok', 'pauses', 'peerGroups', 'settings', 'stats', 'status', 'users'].sort());
    assert.deepEqual([r.status.state, r.status.peers.filtered, r.status.peers.ownDns, r.status.peers.gateways], ['filtering', 8, 1, 1]);
    assert.deepEqual(r.settings.profiles.map((p) => p.name), ['Standard', 'Kinder', 'Büro']);
    assert.deepEqual(r.groups.map((g) => [g.name, g.kind]), [['Büro', 'team'], ['Familie', 'family']]);
    assert.deepEqual(r.peerGroups, [{ id: 3, name: 'Büro-Geräte' }]);
    assert.ok(r.users.some((u) => u.name === 'Lea' && u.role === 'user') && r.users.some((u) => u.name === 'Anna' && u.role === 'admin'));
    assert.deepEqual(r.config.pause, { who: 'all', maxMinutes: 60, forever: false, profiles: {} });
    assert.deepEqual([r.config.logView, r.config.notify, r.config.setupDone], ['admins', { outage: true, weekly: false }, false]);
    assert.deepEqual(r.devices.find((d) => d.peerId === P.leaPhone).profile, { id: 'pkinder01', name: 'Kinder' });
    assert.equal(r.stats.today.top[0].domain, 'doubleclick.net');
    const live = await s.admin('GET', 'live');
    assert.deepEqual(Object.keys(live).sort(), ['devices', 'http', 'ok', 'pauses', 'status', 'today']);
  });

  it('settings: only the keys of gc.vpnDns.set; a bad value names the field; GateControl sees the administrator as the actor', async () => {
    s = await setup();
    let r = await s.admin('PUT', 'settings', { upstream: { provider: 'cloudflare', fallbackRouter: false } });
    assert.deepEqual([r.http, r.settings.upstream], [200, { provider: 'cloudflare', url: null, fallbackRouter: false }]);
    r = await s.admin('PUT', 'settings', { upstream: { provider: 'custom', url: 'http://plain.example' } });
    assert.deepEqual([r.http, r.code], [400, 'invalid']);
    assert.match(r.detail, /upstream\.url/);
    r = await s.admin('PUT', 'settings', { profiles: [] });
    assert.deepEqual([r.http, r.code, r.detail], [400, 'invalid', 'profiles']);
    r = await s.admin('PUT', 'settings', { nonsense: 1 });
    assert.equal(r.http, 400);
    assert.deepEqual(s.host.vpnDns.activity.map((a) => [a.type, a.actor, a.automated]), [['vpn_dns_changed', ADMIN.id, false]]);
  });

  it('own entries: add (several at once, a URL is cut to its host), the other list loses the domain, remove, per profile', async () => {
    s = await setup();
    let r = await s.admin('POST', 'entries', { list: 'allow', domains: ['Klarna.com', 'https://t.co/abc', 'temu.com'] });
    assert.equal(r.http, 200);
    assert.deepEqual(r.settings.allow, ['klarna.com', 'paypal.com', 'sparkasse.de', 't.co', 'temu.com']);
    assert.deepEqual(r.settings.deny, [], 'temu.com moved from "Immer gesperrt"');
    r = await s.admin('POST', 'entries', { list: 'allow', domains: ['t.co'], remove: true });
    assert.ok(!r.settings.allow.includes('t.co'));
    r = await s.admin('POST', 'entries', { list: 'deny', domain: 'anton.app', profileId: 'pkinder01' });
    const kinder = r.settings.profiles.find((p) => p.id === 'pkinder01');
    assert.deepEqual([kinder.deny, kinder.allow], [['anton.app', 'roblox.com'], []]);
    assert.deepEqual(r.settings.profiles.map((p) => p.name), ['Standard', 'Kinder', 'Büro'], 'the other profiles stay');
    r = await s.admin('POST', 'entries', { list: 'allow', domains: ['kein domain'] });
    assert.deepEqual([r.http, r.code], [400, 'invalid_domain']);
    r = await s.admin('POST', 'entries', { list: 'allow', domains: ['x.de'], profileId: 'nope' });
    assert.equal(r.http, 404);
    r = await s.admin('POST', 'entries', { list: 'maybe', domains: ['x.de'] });
    assert.equal(r.http, 400);
  });

  it('"Domain prüfen": for the default profile, a profile, a device; refresh and restart', async () => {
    s = await setup();
    let r = await s.admin('POST', 'test', { domain: 'https://Ads.TikTok.com/x?y', peerId: P.leaPhone });
    assert.deepEqual([r.result.domain, r.result.action, r.result.reason, r.result.list, r.result.profile.name, r.result.device.name], ['ads.tiktok.com', 'block', 'list', 'ads', 'Kinder', 'Leas Handy']);
    r = await s.admin('POST', 'test', { domain: 'online-banking.sparkasse.de' });
    assert.deepEqual([r.result.action, r.result.reason, r.result.profile.id], ['allow', 'profile_allow', 'default']);
    r = await s.admin('POST', 'test', { domain: 'ads.tiktok.com', profileId: 'pbuero001' });
    assert.deepEqual([r.result.action, r.result.profile.name], ['allow', 'Büro']);
    r = await s.admin('POST', 'test', { domain: '' });
    assert.deepEqual([r.http, r.code], [400, 'invalid_domain']);
    assert.deepEqual(await s.admin('POST', 'lists/refresh'), { http: 200, ok: true, started: true });
    r = await s.admin('POST', 'restart');
    assert.deepEqual([r.restarting, s.host.vpnDns.restarts], [true, 1]);
    await s.host.vpnDnsEvent({ type: 'fallback' });
    r = await s.admin('POST', 'test', { domain: 'x.de' });
    assert.deepEqual([r.http, r.code], [503, 'unavailable']);
  });
});

describe('profiles and devices', () => {
  let s;
  afterEach(async () => { if (s) await s.host.close(); s = null; });

  it('create, change (the others keep everything), the switch "dürfen unterbrechen", delete', async () => {
    s = await setup({ config: { pause: { who: 'profile' } } });
    let r = await s.admin('POST', 'profiles', { profile: { name: 'Gäste', lists: ['ads', 'malware', 'adult'], groups: [2] }, pauseAllowed: false });
    assert.equal(r.http, 200);
    const id = r.profile.id;
    assert.match(id, /^p[0-9a-f]{8}$/);
    assert.deepEqual([r.profile.name, r.profile.lists, r.profile.groups], ['Gäste', ['ads', 'malware', 'adult'], [2]]);
    assert.deepEqual(r.config.pause.profiles, { [id]: false });
    assert.deepEqual(r.settings.profiles.map((p) => [p.name, p.users]), [['Standard', []], ['Kinder', [4, 5]], ['Büro', []], ['Gäste', []]]);
    r = await s.admin('PUT', 'profiles/' + id, { profile: { name: 'Besuch', safeSearch: true, schedules: [{ days: [6, 7], from: '00:00', to: '24:00', block: 'all' }] }, pauseAllowed: true });
    assert.deepEqual([r.profile.name, r.profile.safeSearch, r.profile.lists, r.profile.schedules.length, r.config.pause.profiles], ['Besuch', true, ['ads', 'malware', 'adult'], 1, {}]);
    // a name that exists, a bad time, an unknown person
    r = await s.admin('PUT', 'profiles/' + id, { profile: { name: 'kinder' } });
    assert.deepEqual([r.http, r.code], [409, 'name_taken']);
    r = await s.admin('PUT', 'profiles/' + id, { profile: { schedules: [{ days: [1], from: '08:00', to: '08:00', block: 'all' }] } });
    assert.deepEqual([r.http, r.code], [400, 'invalid']);
    r = await s.admin('PUT', 'profiles/' + id, { profile: { users: [999] } });
    assert.equal(r.http, 400);
    // the default profile: lists yes, members never, no delete
    r = await s.admin('PUT', 'profiles/default', { profile: { lists: ['ads'], users: [4] } });
    assert.deepEqual([r.http, r.profile.lists, r.profile.users], [200, ['ads'], []]);
    r = await s.admin('DELETE', 'profiles/default');
    assert.equal(r.http, 400);
    await s.config({ pause: { profiles: { [id]: false } } });
    r = await s.admin('DELETE', 'profiles/' + id);
    assert.deepEqual([r.settings.profiles.map((p) => p.name), r.config.pause.profiles], [['Standard', 'Kinder', 'Büro'], {}], 'its switch is forgotten');
    assert.equal((await s.admin('DELETE', 'profiles/' + id)).http, 404);
    assert.equal((await s.admin('PUT', 'profiles/nope', { profile: { name: 'x' } })).http, 404);
  });

  it('at most 16 profiles', async () => {
    s = await setup({ settings: { enabled: true, profiles: [{ id: 'default', name: 'Standard' }, ...Array.from({ length: 15 }, (_, i) => ({ id: 'p' + String(i).padStart(8, '0'), name: 'P' + i }))] } });
    const r = await s.admin('POST', 'profiles', { profile: { name: 'Zu viel' } });
    assert.deepEqual([r.http, r.code, r.max], [409, 'limit', 16]);
  });

  it('"Profil ändern" of a device: an own profile beats the person\'s, none falls back, excluded', async () => {
    s = await setup();
    const dev = (r) => r.devices.find((d) => d.peerId === P.leaPhone);
    let r = await s.admin('PUT', 'devices/' + P.leaPhone, { profileId: 'pbuero001' });
    assert.deepEqual([dev(r).profile.name, dev(r).via], ['Büro', 'peer']);
    assert.deepEqual(r.settings.profiles.find((p) => p.id === 'pbuero001').peers, [P.leaPhone, P.officePc].sort((a, b) => a - b));
    r = await s.admin('PUT', 'devices/' + P.leaPhone, { profileId: 'pkinder01' });
    assert.deepEqual(r.settings.profiles.map((p) => p.peers), [[], [P.leaPhone], [P.officePc]], 'moved, not added twice');
    r = await s.admin('PUT', 'devices/' + P.leaPhone, { profileId: null });
    assert.deepEqual([dev(r).profile.name, dev(r).via], ['Kinder', 'user']);
    r = await s.admin('PUT', 'devices/' + P.leaPhone, { excluded: true });
    assert.deepEqual([dev(r).state, dev(r).profile, r.settings.excluded], ['excluded', null, [P.leaPhone]]);
    r = await s.admin('PUT', 'devices/' + P.leaPhone, { excluded: false });
    assert.equal(dev(r).state, 'filtered');
    assert.equal((await s.admin('PUT', 'devices/' + P.gateway, { excluded: true })).http, 404);
    assert.equal((await s.admin('PUT', 'devices/' + P.leaPhone, { profileId: 'default' })).http, 404);
    assert.equal((await s.admin('PUT', 'devices/' + P.leaPhone, {})).http, 400);
  });

  it('suspending for all VPN devices, +30 min, switching back on; a single device', async () => {
    s = await setup();
    let r = await s.admin('POST', 'pause', { minutes: 30 });
    assert.deepEqual([r.http, r.pause.scope, r.pause.by.name], [200, 'all', 'Anna']);
    let live = await s.admin('GET', 'live');
    assert.deepEqual([live.status.pause.scope, live.status.peers.suspended, live.devices.find((d) => d.peerId === P.leaPhone).suspendedBy], ['all', 8, 'all']);
    const until = Date.parse(live.status.pause.until);
    r = await s.admin('POST', 'pause', { extend: 30 });
    assert.equal(Date.parse(r.pause.until) - until, 30 * 60000);
    r = await s.admin('POST', 'pause', { forever: true });
    assert.equal(r.pause.openEnd, true);
    r = await s.admin('POST', 'resume');
    assert.equal(r.resumed, true);
    assert.equal((await s.admin('GET', 'live')).status.pause, null);
    // a single device suspended by its owner: the administrator ends it on the tab "Geräte"
    await s.app(LEA, P.leaPhone, 'POST', 'pause', { minutes: 30 });
    r = await s.admin('POST', 'devices/' + P.leaPhone + '/resume');
    assert.equal(r.resumed, true);
    assert.equal(s.host.vpnDns.pauses.size, 0);
  });
});

describe('query log and the plugin\'s own settings', () => {
  let s;
  afterEach(async () => { if (s) await s.host.close(); s = null; });

  it('the administrator sees everything, filters, clears', async () => {
    const now = Date.now();
    s = await setup({ settings: settings({ log: { enabled: true, retentionDays: 7 } }), vpnDns: { log: [
      { at: now - 3 * 86400000, peerId: P.marcPhone, name: 'old.example', action: 'allow', reason: 'default', profileId: 'default' },
      { at: now - 2000, peerId: P.leaPhone, name: 'ads.tiktok.com', action: 'block', reason: 'list', profileId: 'pkinder01', list: 'ads' },
      { at: now - 1000, peerId: P.marcPhone, name: 'example.org', action: 'allow', reason: 'default', profileId: 'default' },
    ] } });
    let r = await s.admin('GET', 'log');
    assert.deepEqual(r.entries.map((e) => [e.device, e.person, e.domain, e.result, e.profile.name]), [['Marcs Handy', 'Marc', 'example.org', 'allowed', 'Standard'], ['Leas Handy', 'Lea', 'ads.tiktok.com', 'blocked', 'Kinder'], ['Marcs Handy', 'Marc', 'old.example', 'allowed', 'Standard']]);
    r = await s.admin('GET', 'log', null, { days: '1' });
    assert.equal(r.entries.length, 2);
    r = await s.admin('GET', 'log', null, { peerId: String(P.leaPhone), blockedOnly: '1' });
    assert.deepEqual(r.entries.map((e) => e.domain), ['ads.tiktok.com']);
    r = await s.admin('PUT', 'settings', { log: { retentionDays: 30 } });
    assert.deepEqual(r.settings.log, { enabled: true, retentionDays: 30 });
    r = await s.admin('POST', 'log/clear');
    assert.deepEqual([r.removed, (await s.admin('GET', 'log')).entries], [3, []]);
    await s.admin('PUT', 'settings', { log: { enabled: false } });
    r = await s.admin('GET', 'log');
    assert.deepEqual([r.http, r.code], [409, 'log_off']);
  });

  it('config: only known keys and values', async () => {
    s = await setup();
    let r = await s.config({ pause: { who: 'profile', maxMinutes: 240, forever: true, profiles: { pkinder01: false, pbuero001: true } }, logView: 'own', notify: { outage: false, weekly: true } });
    assert.deepEqual(r.config, { setupDone: false, pause: { who: 'profile', maxMinutes: 240, forever: true, profiles: { pkinder01: false } }, logView: 'own', notify: { outage: false, weekly: true } });
    for (const bad of [{ pause: { who: 'everybody' } }, { pause: { maxMinutes: 45 } }, { pause: { forever: 'yes' } }, { pause: { profiles: { 'Bad Id': false } } }, { logView: 'all' }, { notify: { sms: true } }, { other: 1 }, []]) {
      r = await s.config(bad);
      assert.deepEqual([r.http, r.code], [400, 'invalid'], JSON.stringify(bad));
    }
    assert.equal((await s.admin('GET', 'all')).config.pause.maxMinutes, 240, 'nothing of the bad patches was stored');
  });
});

describe('set-up and the move from Pi-hole', () => {
  let s;
  afterEach(async () => { if (s) await s.host.close(); s = null; });

  it('a new server: lists, switch on, probe, done', async () => {
    s = await setup({ settings: null });
    let all = await s.admin('GET', 'all');
    assert.deepEqual([all.status.state, all.settings.enabled, all.config.setupDone, all.status.pihole.wantsChain], ['off', false, false, false]);
    let r = await s.admin('POST', 'setup/start', { lists: ['ads', 'malware', 'gambling'], allow: [] });
    assert.deepEqual([r.http, r.settings.enabled, r.settings.profiles[0].lists], [200, true, ['ads', 'malware', 'gambling']]);
    r = await s.admin('GET', 'setup/state');
    assert.deepEqual([r.status.state, r.probe.block, r.probe.allow], ['filtering', { domain: 'googlesyndication.com', action: 'block' }, { domain: 'example.org', action: 'allow' }]);
    assert.ok(r.lists.lists.filter((l) => l.used).every((l) => l.loaded));
    r = await s.admin('POST', 'setup/finish');
    assert.deepEqual([r.config.setupDone, r.status.state], [true, 'filtering']);
    // without an ad list nothing of the probe names is blocked: the probe says so instead of failing
    await s.admin('PUT', 'profiles/default', { profile: { lists: ['malware'] } });
    r = await s.admin('GET', 'setup/state');
    assert.deepEqual(r.probe.block, { domain: 'googlesyndication.com', action: 'allow' });
    assert.deepEqual(s.host.vpnDnsClientInfo(), { plugin: 'gatecontrol-dns', state: 'filtering' });
  });

  it('"Später" only remembers the dialog; bad lists are refused', async () => {
    s = await setup({ settings: null });
    let r = await s.admin('POST', 'setup/later');
    assert.deepEqual([r.config.setupDone, s.host.vpnDns.settings.enabled], [true, false]);
    r = await s.admin('POST', 'setup/start', { lists: ['nope'] });
    assert.equal(r.http, 400);
    r = await s.admin('POST', 'setup/start', {});
    assert.equal(r.http, 400);
    assert.equal(s.host.vpnDns.settings.enabled, false);
  });

  it('from Pi-hole: exceptions taken over, Pi-hole gives up the chain only once the filter answers', async () => {
    s = await setup({ settings: null, vpnDns: { pihole: { configured: true, wantsChain: true }, service: 'starting' } });
    let all = await s.admin('GET', 'all');
    assert.deepEqual(all.status.pihole, { configured: true, wantsChain: true, chain: 'active' });
    let r = await s.admin('POST', 'setup/start', { lists: ['ads', 'malware', 'ads_stevenblack'], allow: ['PayPal.com', 'sparkasse.de', 'paypal.com'] });
    assert.deepEqual(r.settings.allow, ['paypal.com', 'sparkasse.de']);
    // the filter still loads its lists: Pi-hole keeps filtering, nothing is released
    r = await s.admin('GET', 'setup/state');
    assert.deepEqual([r.status.state, r.status.chain, r.status.pihole.chain, r.probe], ['starting', 'pihole', 'active', null]);
    r = await s.admin('POST', 'setup/finish');
    assert.deepEqual([r.http, r.code], [409, 'not_filtering']);
    assert.equal(s.host.vpnDns.pihole.wantsChain, true);
    assert.equal((await s.admin('GET', 'all')).config.setupDone, false);
    // it answers: the chain goes to the filter, then Pi-hole is released
    s.host.vpnDnsSet({ service: 'filtering' });
    r = await s.admin('GET', 'setup/state');
    assert.deepEqual([r.status.state, r.status.chain, r.status.pihole.chain, r.probe.block.action], ['filtering', 'filter', 'displaced', 'block']);
    r = await s.admin('POST', 'setup/finish');
    assert.deepEqual([r.http, r.pihole, r.config.setupDone], [200, { configured: true, wantsChain: false, chain: 'off' }, true]);
    assert.ok(s.host.vpnDns.activity.some((a) => a.type === 'vpn_dns_pihole_released' && a.actor === ADMIN.id));
  });

  it('the switch-over fails: "Zurück" switches the protection off again, Pi-hole was never released', async () => {
    s = await setup({ settings: null, vpnDns: { pihole: { configured: true, wantsChain: true }, service: 'fallback' } });
    await s.admin('POST', 'setup/start', { lists: ['ads'] });
    let r = await s.admin('GET', 'setup/state');
    assert.deepEqual([r.status.state, r.probe], ['fallback', null]);
    r = await s.admin('POST', 'setup/cancel');
    assert.deepEqual([r.http, r.settings.enabled], [200, false]);
    const all = await s.admin('GET', 'all');
    assert.deepEqual([all.status.state, all.status.pihole.chain, s.host.vpnDns.pihole.wantsChain], ['off', 'active', true]);
  });
});
