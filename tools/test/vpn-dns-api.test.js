'use strict';

// The mock host's mirror of GateControl 1.264.0 gc.vpnDns (src/services/vpnDns.js, hostApi.js vpnDnsCall / vpnDnsActor,
// the child bootstrap's makeVpnDns; tools/testing/mock-vpn-dns.js): only with permissions.vpnDns, reading anywhere,
// changes only for an acting person (the one changing request in flight, or { actor }), settings for administrators,
// the two fixed rules of suspending, the validation of set(), which profile holds, events.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHost } = require('../testing/mock-host');

const USERS = [{ id: 1, name: 'admin', role: 'admin' }, { id: 2, name: 'Anna', role: 'user' }, { id: 3, name: 'Tim', role: 'user' }, { id: 4, name: 'Weg', role: 'user', disabled: true }, { id: 5, name: 'Chef', role: 'admin' }];
const PEERS = [
  { id: 10, name: 'Annas Handy', ip: '10.8.0.10', platform: 'android', userId: 2 },
  { id: 11, name: 'Tims Tablet', ip: '10.8.0.11', platform: 'android', userId: 3, peerGroup: { id: 7, name: 'Kinder-Geräte' } },
  { id: 12, name: 'Chef-Laptop', ip: '10.8.0.12', platform: 'windows', userId: 5 },
  { id: 13, name: 'Eigener DNS', ip: '10.8.0.13', userId: 2, dns: '9.9.9.9' },
  { id: 14, name: 'Gateway', ip: '10.8.0.2', type: 'gateway' },
  { id: 15, name: 'Ohne Person', ip: '10.8.0.15' },
];

// a plugin whose request hook calls gc.vpnDns[op](...args) and answers { ok, result } or { ok: false, code, message };
// its `events` are what gc.vpnDns.on delivered
const CODE = `
const events = [];
module.exports = {
  events,
  async start(gc) { if (gc.vpnDns) gc.vpnDns.on((ev) => { events.push(ev); }); },
  async request(req, gc) {
    const b = req.body || {};
    if (b.op === 'events') return { json: { ok: true, result: events } };
    try { return { json: { ok: true, result: await gc.vpnDns[b.op](...(b.args || [])) } }; } catch (e) { return { json: { ok: false, code: e.code, message: e.message } }; }
  },
  async tick(gc) { try { await gc.vpnDns.pause({ scope: 'peer', id: 10, minutes: 5 }, global.__actor ? { actor: global.__actor } : undefined); return 'ok'; } catch (e) { return e.code; } },
};`;

function plugin(perms) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-plugin-'));
  fs.mkdirSync(path.join(dir, 'server'));
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id: 'vd-test', name: 'V', version: '1.0.0', entry: 'server/index.js', permissions: perms }));
  fs.writeFileSync(path.join(dir, 'server', 'index.js'), CODE);
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function setup(o = {}) {
  const p = plugin(o.perms || { vpnDns: true, app: true });
  const h = await createHost(p.dir, { users: USERS, groups: [{ id: 1, name: 'Team', kind: 'team', members: [{ userId: 3 }] }], vpnDns: { peers: PEERS, settings: { enabled: true }, ...(o.vpnDns || {}) }, ...(o.host || {}) });
  await h.start();
  const call = async (user, method, op, ...args) => (await h.request({ method, path: '/x', body: { op, args }, user: user ? { ...user, loggedIn: true } : { id: 0, loggedIn: false } })).json;
  const read = (op, ...args) => call(USERS[1], 'GET', op, ...args);
  const as = (user, op, ...args) => call(user, 'POST', op, ...args);
  return { h, read, as, done: async () => { await h.close(); p.done(); } };
}

test('gc.vpnDns: only with permissions.vpnDns, from GateControl 1.264.0 or with opts.vpnDns', async () => {
  const p = plugin({ vpnDns: true });
  const none = plugin({ users: true });
  const bad = plugin({ vpnDns: 'yes' });
  try {
    for (const [dir, o, has] of [[p.dir, {}, false], [p.dir, { gatecontrol: '1.263.2' }, false], [p.dir, { gatecontrol: '1.264.0' }, true], [p.dir, { vpnDns: {} }, true], [none.dir, { gatecontrol: '1.264.0' }, false]]) {
      const h = await createHost(dir, o);
      assert.equal(!!h.gc.vpnDns, has, JSON.stringify(o));
      if (has) assert.equal(h.gc.vpnDns.version, 1);
      await h.close();
    }
    await assert.rejects(createHost(bad.dir, { gatecontrol: '1.264.0' }), { code: 'ERR_INVALID' });
    const h = await createHost(bad.dir, { gatecontrol: '1.263.2' });   // an older GateControl ignores the key
    await h.close();
  } finally { p.done(); none.done(); bad.done(); }
});

test('reading works anywhere; a change needs an acting person; settings need an administrator', async () => {
  const s = await setup();
  try {
    assert.equal((await s.read('status')).result.state, 'filtering');
    assert.equal((await s.read('get')).result.profiles[0].id, 'default');
    // a GET request is no changing request
    assert.equal((await s.read('pause', { scope: 'peer', id: 10, minutes: 5 })).code, 'ERR_NOT_PERSON');
    assert.equal((await s.as(USERS[1], 'pause', { scope: 'peer', id: 10, minutes: 5 })).ok, true);
    // the background run: only with { actor } — logged as automated
    assert.equal(await s.h.tick(), 'ERR_NOT_PERSON');
    global.__actor = 2;
    assert.equal(await s.h.tick(), 'ok');
    delete global.__actor;
    assert.deepEqual(s.h.vpnDns.activity.map((a) => [a.type, a.actor, a.automated]), [['vpn_dns_paused', 2, false], ['vpn_dns_paused', 2, true]]);
    // a named actor who is unknown or disabled
    assert.equal((await s.as(USERS[1], 'pause', { scope: 'peer', id: 10, minutes: 5 }, { actor: 4 })).code, 'ERR_NOT_PERSON');
    // administrators only
    for (const [op, ...args] of [['set', { enabled: false }], ['refreshLists'], ['restart'], ['releasePihole'], ['clearLog']]) {
      assert.equal((await s.as(USERS[1], op, ...args)).code, 'ERR_NOT_ADMIN', op);
    }
    assert.equal((await s.as(USERS[0], 'refreshLists')).result.started, true);
    assert.equal((await s.as(USERS[0], 'restart')).result.restarting, true);
    // two people changing something at once: the actor has to be named
    const [a, b] = await Promise.all([s.as(USERS[1], 'pause', { scope: 'peer', id: 10, minutes: 5 }), s.as(USERS[2], 'pause', { scope: 'peer', id: 11, minutes: 5 })]);
    assert.ok([a.code, b.code].includes('ERR_NOT_PERSON'), 'whoever finds two changing requests in flight is refused');
    const [c, d] = await Promise.all([s.as(USERS[1], 'pause', { scope: 'peer', id: 10, minutes: 5 }, { actor: 2 }), s.as(USERS[2], 'pause', { scope: 'peer', id: 11, minutes: 5 }, { actor: 3 })]);
    assert.deepEqual([c.ok, d.ok, c.result.automated], [true, true, false]);
  } finally { await s.done(); }
});

test('suspending: the two fixed rules, the limits, gateways, replace and resume, expiry with an event', async () => {
  const s = await setup();
  try {
    assert.equal((await s.as(USERS[1], 'pause', { scope: 'all', minutes: 5 })).code, 'ERR_FORBIDDEN');
    assert.equal((await s.as(USERS[1], 'pause', { scope: 'peer', id: 12, minutes: 5 })).code, 'ERR_FORBIDDEN', 'an administrator\'s device');
    assert.equal((await s.as(USERS[1], 'pause', { scope: 'user', id: 5, minutes: 5 })).code, 'ERR_FORBIDDEN');
    assert.equal((await s.as(USERS[1], 'resume', { scope: 'user', id: 5 })).code, 'ERR_FORBIDDEN');
    assert.equal((await s.as(USERS[4], 'pause', { scope: 'peer', id: 12, minutes: 5 })).ok, true, 'that administrator');
    assert.equal((await s.as(USERS[0], 'pause', { scope: 'peer', id: 12, minutes: 5 })).ok, true, 'another administrator');
    // GateControl does not decide who may suspend for whom otherwise: Anna for Tim, for a device without a person
    assert.equal((await s.as(USERS[1], 'pause', { scope: 'user', id: 3, minutes: 5 })).ok, true);
    assert.equal((await s.as(USERS[1], 'pause', { scope: 'peer', id: 15, minutes: 5 })).ok, true);
    assert.equal((await s.as(USERS[1], 'pause', { scope: 'peer', id: 14, minutes: 5 })).code, 'ERR_NOT_FOUND', 'a gateway');
    assert.equal((await s.as(USERS[1], 'pause', { scope: 'user', id: 4, minutes: 5 })).code, 'ERR_NOT_FOUND', 'a disabled person');
    for (const t of [{ scope: 'peer', id: 10 }, { scope: 'peer', id: 10, minutes: 0 }, { scope: 'peer', id: 10, minutes: 10081 }, { scope: 'peer', id: 10, until: 'gestern' }, { scope: 'peer', id: 10, until: new Date(Date.now() + 8 * 86400000).toISOString() }, { scope: 'room', id: 1, minutes: 5 }, { scope: 'peer', minutes: 5 }]) {
      assert.equal((await s.as(USERS[1], 'pause', t)).code, 'ERR_INVALID', JSON.stringify(t));
    }
    let r = (await s.as(USERS[1], 'pause', { scope: 'peer', id: 10, forever: true })).result;
    assert.deepEqual([r.scope, r.id, r.until, r.openEnd, r.by, r.automated], ['peer', 10, null, true, { userId: 2, name: 'Anna' }, false]);
    r = (await s.as(USERS[1], 'pause', { scope: 'peer', id: 10, minutes: 30 })).result;   // replaces it
    assert.equal(r.openEnd, false);
    const dev = (await s.read('devices')).result;
    assert.deepEqual(dev.filter((d) => d.suspended).map((d) => [d.peerId, d.suspendedBy]), [[10, 'peer'], [12, 'peer'], [15, 'peer'], [11, 'user']]);
    assert.equal((await s.read('status')).result.pauses, 4);
    assert.equal((await s.as(USERS[1], 'resume', { scope: 'peer', id: 10 })).result, true);
    assert.equal((await s.as(USERS[1], 'resume', { scope: 'peer', id: 10 })).result, false);
    // all devices
    r = (await s.as(USERS[0], 'pause', { scope: 'all', minutes: 10 })).result;
    assert.deepEqual([r.scope, r.id], ['all', null]);
    assert.equal((await s.read('status')).result.pause.scope, 'all');
    assert.ok((await s.read('devices')).result.filter((d) => d.profile).every((d) => d.suspendedBy === 'all'));
    // expiry
    assert.equal(await s.h.vpnDnsExpire(Date.now() + 11 * 60000), 4);
    const ev = (await s.read('events')).result;
    assert.deepEqual(ev.filter((e) => e.type === 'resumed').map((e) => [e.scope, e.reason]).sort(), [['all', 'expired'], ['peer', 'expired'], ['peer', 'expired'], ['peer', 'manual'], ['user', 'expired']].sort());
    assert.ok(ev.every((e) => typeof e.at === 'string'));
    assert.equal(ev.filter((e) => e.type === 'paused').length, 7);
    // switching the protection off ends every suspension
    await s.as(USERS[1], 'pause', { scope: 'peer', id: 10, forever: true });
    await s.as(USERS[0], 'set', { enabled: false });
    assert.deepEqual((await s.read('pauses')).result, []);
    assert.equal((await s.read('status')).result.state, 'off');
  } finally { await s.done(); }
});

test('set(): validation with the field in the message, profiles by id, which profile holds', async () => {
  const s = await setup();
  try {
    const set = (patch) => s.as(USERS[0], 'set', patch);
    for (const [patch, field] of [[{}, 'nothing'], [{ nope: 1 }, 'nope'], [{ enabled: 'yes' }, 'enabled'], [{ allow: ['http://x.de/y'] }, 'allow'], [{ upstream: { provider: 'google' } }, 'upstream.provider'],
      [{ upstream: { provider: 'custom' } }, 'upstream.url'], [{ log: { retentionDays: 0 } }, 'log.retentionDays'], [{ excluded: [999] }, 'excluded'], [{ profiles: [] }, 'profiles'],
      [{ profiles: [{ id: 'other' }] }, 'profiles[0]'], [{ profiles: [{}, { name: 'A', users: [4] }] }, 'profiles[1].users'], [{ profiles: [{}, { name: 'A', peers: [14] }] }, 'profiles[1].peers'],
      [{ profiles: [{}, { name: 'A', lists: ['nope'] }] }, 'profiles[1].lists'], [{ profiles: [{}, { name: 'A' }, { name: 'a' }] }, 'profiles[2].name'], [{ profiles: [{ users: [2] }] }, 'default profile'],
      [{ profiles: [{}, { name: 'A', schedules: [{ days: [1], from: '08:00', to: '08:00' }] }] }, 'profiles[1].schedules[0]'], [{ profiles: [{}, { name: 'A', groups: [99] }] }, 'profiles[1].groups']]) {
      const r = await set(patch);
      assert.equal(r.code, 'ERR_INVALID', JSON.stringify(patch));
      assert.ok(r.message.includes(field), `${r.message} ↔ ${field}`);
    }
    let r = (await set({ allow: ['Bücher.de', '*.Example.com', 'paypal.com'], profiles: [{ lists: ['ads'] }, { name: 'Kinder', users: [3], lists: ['adult', 'ads'], schedules: [{ days: [7, 6], from: '22:00', to: '24:00', block: 'all' }] }, { name: 'Gerät', peers: [11] }, { name: 'Gruppe', groups: [1], peerGroups: [7] }] })).result;
    assert.deepEqual(r.allow, ['*.example.com', 'paypal.com', 'xn--bcher-kva.de']);
    assert.deepEqual(r.profiles.map((p) => [p.id === 'default' || /^p[0-9a-f]{8}$/.test(p.id), p.name, p.lists]), [[true, 'Standard', ['ads']], [true, 'Kinder', ['ads', 'adult']], [true, 'Gerät', []], [true, 'Gruppe', []]]);
    assert.deepEqual(r.profiles[1].schedules, [{ days: [6, 7], from: '22:00', to: '00:00', block: 'all', categories: [], allowAlways: [] }]);
    // device beats person beats peer group beats person group
    const [, kinder, geraet, gruppe] = r.profiles;
    const via = async () => Object.fromEntries((await s.read('devices')).result.map((d) => [d.peerId, [d.state, d.profile && d.profile.name, d.via]]));
    assert.deepEqual(await via(), { 10: ['filtered', 'Standard', 'default'], 11: ['filtered', 'Gerät', 'peer'], 12: ['filtered', 'Standard', 'default'], 13: ['ownDns', 'Standard', 'default'], 14: ['gateway', null, null], 15: ['filtered', 'Standard', 'default'] });
    r = (await set({ profiles: [{}, { id: kinder.id }, { id: gruppe.id }] })).result;   // "Gerät" is deleted, the others keep everything
    assert.deepEqual(r.profiles.map((p) => [p.name, p.users, p.groups]), [['Standard', [], []], ['Kinder', [3], []], ['Gruppe', [], [1]]]);
    assert.deepEqual((await via())[11], ['filtered', 'Kinder', 'user']);
    await set({ profiles: [{}, { id: kinder.id, users: [] }, { id: gruppe.id }] });
    assert.deepEqual((await via())[11], ['filtered', 'Gruppe', 'peerGroup']);
    await set({ profiles: [{}, { id: kinder.id }, { id: gruppe.id, peerGroups: [] }] });
    assert.deepEqual((await via())[11], ['filtered', 'Gruppe', 'group']);
    await set({ excluded: [11] });
    assert.deepEqual((await via())[11], ['excluded', null, null]);
    assert.ok(geraet.id);
    // the query log: per-device counters only while it is on, switching it off deletes
    assert.equal((await s.read('log')).code, 'ERR_LOG_OFF');
    assert.equal((await s.read('devices')).result[0].today, null);
    await set({ log: { enabled: true } });
    s.h.vpnDnsLog({ peerId: 10, name: 'ads.example', action: 'block', reason: 'list', profileId: 'default', list: 'ads' });
    s.h.vpnDnsSet({ perPeer: { 10: { queries: 5, blocked: 1 } } });
    assert.deepEqual((await s.read('log', { userId: 2 })).result.entries.map((e) => [e.peerId, e.name, e.action]), [[10, 'ads.example', 'block']]);
    assert.deepEqual((await s.read('log', { userId: 3 })).result.entries, []);
    assert.deepEqual((await s.read('devices')).result[0].today, { queries: 5, blocked: 1 });
    await set({ log: { enabled: false } });
    assert.equal(s.h.vpnDns.log.length, 0);
  } finally { await s.done(); }
});

test('test(), the outage, Pi-hole, what the apps learn', async () => {
  const s = await setup({ vpnDns: { pihole: { configured: true, wantsChain: true }, settings: { enabled: true, deny: ['temu.com'], allow: ['paypal.com'] } } });
  try {
    assert.deepEqual((await s.read('test', 'ADS.TikTok.com')).result, { domain: 'ads.tiktok.com', action: 'block', reason: 'list', list: 'ads', category: null, safeSearch: null, profile: { id: 'default', name: 'Standard' }, device: null, filtered: true });
    assert.deepEqual([(await s.read('test', 'shop.temu.com')).result.reason, (await s.read('test', 'paypal.com')).result.reason, (await s.read('test', 'example.org')).result.reason], ['profile_deny', 'profile_allow', 'default']);
    assert.equal((await s.read('test', 'x.de', { peerId: 14 })).result.reason, 'no_profile');
    assert.equal((await s.read('test', 'x.de', { peerId: 99 })).code, 'ERR_NOT_FOUND');
    assert.equal((await s.read('test', 'kein domain')).code, 'ERR_INVALID');
    assert.deepEqual((await s.read('status')).result.pihole, { configured: true, wantsChain: true, chain: 'displaced' });
    assert.deepEqual(s.h.vpnDnsClientInfo(), { plugin: 'vd-test', state: 'filtering' });
    await s.h.vpnDnsEvent({ type: 'fallback' });
    assert.deepEqual([(await s.read('status')).result.state, (await s.read('status')).result.service], ['fallback', { running: false }]);
    assert.equal((await s.read('test', 'x.de')).code, 'ERR_UNAVAILABLE');
    assert.equal((await s.as(USERS[0], 'releasePihole')).code, 'ERR_NOT_FILTERING');
    assert.deepEqual(s.h.vpnDnsClientInfo(), { plugin: 'vd-test', state: 'fallback' });
    await s.h.vpnDnsEvent({ type: 'restored' });
    assert.deepEqual((await s.as(USERS[0], 'releasePihole')).result, { configured: true, wantsChain: false, chain: 'off' });
    assert.deepEqual((await s.read('events')).result.map((e) => e.type), ['fallback', 'restored']);
    // the internal DNS of the server is off: switched on, but nothing runs
    s.h.vpnDnsSet({ internalDns: false });
    assert.deepEqual([(await s.read('status')).result.state, (await s.read('status')).result.blockedBy], ['off', 'internal_dns_off']);
    assert.equal(s.h.vpnDnsClientInfo(), null);
  } finally { await s.done(); }
});

test('peerId of an app viewer reaches only a plugin with permissions.vpnDns', async () => {
  const p = plugin({ app: true });
  try {
    const dir = p.dir;
    fs.writeFileSync(path.join(dir, 'server', 'index.js'), "module.exports = { async request(req) { return { json: { peerId: req.user.peerId === undefined ? 'none' : req.user.peerId } }; } };");
    let h = await createHost(dir, { users: USERS, gatecontrol: '1.264.0' });
    assert.equal((await h.request({ path: '/x', user: { ...USERS[1], app: true, peerId: 10 } })).json.peerId, 'none');
    await h.close();
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id: 'vd-test', name: 'V', version: '1.0.0', entry: 'server/index.js', permissions: { app: true, vpnDns: true } }));
    h = await createHost(dir, { users: USERS, gatecontrol: '1.264.0' });
    assert.equal((await h.request({ path: '/x', user: { ...USERS[1], app: true, peerId: 10 } })).json.peerId, 10);
    await h.close();
  } finally { p.done(); }
});

test('later hosts: gc.vpnDns.version 2 (1.265.0), 3 (1.266.0), 4 (1.267.0) — each adds fields, an older one has none of them', async () => {
  const targets = [{ name: 'pi', ip: '192.168.178.5', port: 53, gateway: null }];
  const shape = async (gatecontrol) => {
    const s = await setup({ host: { gatecontrol }, vpnDns: { pihole: { configured: true, targets }, settings: { enabled: true, deny: ['temu.com'], log: { enabled: true } }, log: [{ peerId: 10, name: 'temu.com', action: 'block', reason: 'profile_deny', scope: 'all' }] } });
    try {
      const st = (await s.read('status')).result;
      const t = (await s.read('test', 'shop.temu.com')).result;
      const dev = (await s.read('devices')).result[0];
      const get = (await s.read('get')).result;
      return [s.h.gc.vpnDns.version, 'targets' in st.pihole, 'blockedBy' in st.today, 'match' in t, 'scope' in (await s.read('log')).result.entries[0], 'foreignDns' in st, 'blockForeignDns' in get, 'foreignDnsBlocked' in dev,
        'homeInternet' in get, 'home' in get.profiles[0], 'internetPaused' in dev, typeof s.h.gc.vpnDns.homes, st.today.blockedBy ? Object.keys(st.today.blockedBy).length : 0, !!s.h.vpnDnsProtectionInfo()];
    } finally { await s.done(); }
  };
  assert.deepEqual(await shape('1.264.0'), [1, false, false, false, false, false, false, false, false, false, false, 'undefined', 0, false]);
  assert.deepEqual(await shape('1.265.0'), [2, true, true, true, true, false, false, false, false, false, false, 'undefined', 5, true]);
  assert.deepEqual(await shape('1.266.0'), [3, true, true, true, true, true, true, true, false, false, false, 'undefined', 5, true]);
  assert.deepEqual(await shape('1.267.0'), [4, true, true, true, true, true, true, true, true, true, true, 'function', 6, true]);
  // an older host does not know the newer settings
  const old = await setup({ host: { gatecontrol: '1.265.0' } });
  try {
    assert.match((await old.as(USERS[0], 'set', { blockForeignDns: true })).message, /^blockForeignDns: unknown$/);
    assert.match((await old.as(USERS[0], 'set', { homeInternet: false })).message, /^homeInternet: unknown$/);
  } finally { await old.done(); }
});

test('1.267.0: homes(), a shared profile (take over, create, unlink), "Internet pausieren" and the foreign-DNS rules', async () => {
  const homes = [{ gateway: { peerId: 14, name: 'Gateway' }, profiles: [{ id: 'default', name: 'Standard', lists: ['ads'] }, { id: 'phome0001', name: 'Zuhause', lists: ['adult'], deny: ['tiktok.com'], users: [3], devices: 2 }] }];
  const s = await setup({ host: { gatecontrol: '1.267.0' }, vpnDns: { homes, settings: { enabled: true, profiles: [{ id: 'default' }, { id: 'pkids0001', name: 'Kinder', lists: ['ads'], peers: [11] }] } } });
  const admin = USERS[0];
  try {
    assert.deepEqual((await s.read('homes')).result.map((h) => [h.gateway.peerId, h.configured, h.enabled, h.profiles.map((p) => [p.id, p.devices, p.linkedTo])]), [[14, true, true, [['default', 0, null], ['phome0001', 2, null]]]]);
    let r = await s.as(admin, 'set', { profiles: [{ id: 'default' }, { id: 'pkids0001', home: { gateway: 14, profile: 'phome0001' } }] });
    assert.deepEqual([r.result.profiles[1].home, r.result.profiles[1].lists, r.result.profiles[1].users, r.result.profiles[1].peers], [{ gateway: 14, profile: 'phome0001', gatewayName: 'Gateway', name: 'Zuhause' }, ['adult'], [3], [11]]);
    assert.equal((await s.read('homes')).result[0].profiles[1].linkedTo, 'pkids0001');
    r = await s.as(admin, 'set', { profiles: [{ id: 'default' }, { id: 'pkids0001', safeSearch: true }] });
    assert.equal(s.h.vpnDns.homes[0].profiles[1].safeSearch, true, 'a change goes to the home');
    for (const [home, msg] of [[{ gateway: 99, profile: 'x' }, /^profiles\[1\]\.home\.gateway: unknown gateway$/], [{ gateway: 14, profile: 'nope' }, /^profiles\[1\]\.home\.profile: unknown profile of this home network$/], [{ gateway: 14, profile: 'default' }, /^profiles\[1\]\.home: the default profile only goes with the home's default profile$/], ['x', /^profiles\[1\]\.home: null or \{ gateway, profile \}$/]]) {
      r = await s.as(admin, 'set', { profiles: [{ id: 'default' }, { id: 'pkids0001', home }] });
      assert.equal(r.code, 'ERR_INVALID');
      assert.match(r.message, msg);
    }
    r = await s.as(admin, 'set', { profiles: [{ id: 'default' }, { id: 'pkids0001' }, { name: 'Zuhause', home: { gateway: 14, create: true } }] });
    assert.match(r.message, /^profiles\[2\]\.home: a profile with this name exists$/);
    r = await s.as(admin, 'set', { profiles: [{ id: 'default' }, { id: 'pkids0001', home: null }, { name: 'Gäste', lists: ['malware'], home: { gateway: 14, create: true } }] });
    assert.deepEqual([r.result.profiles[1].home, r.result.profiles[1].lists, r.result.profiles[2].home.name, s.h.vpnDns.homes[0].profiles.map((p) => p.name)], [null, ['adult'], 'Gäste', ['Standard', 'Zuhause', 'Gäste']]);
    // "Internet pausieren" of a person: paused devices, only "Immer erlaubt" answers, suspending does not lift it
    const until = Date.now() + 600000;
    s.h.vpnDnsSet({ internet: { pause: { 2: until }, extend: { 3: until } } });
    const dev = (id) => s.read('devices').then((x) => x.result.find((d) => d.peerId === id));
    assert.deepEqual([(await dev(10)).internetPaused, (await dev(10)).timesSuspended, (await dev(11)).internetPaused, (await dev(11)).timesSuspended, (await dev(15)).internetPaused], [new Date(until).toISOString(), null, null, new Date(until).toISOString(), null]);
    await s.as(admin, 'pause', { scope: 'peer', id: 10, minutes: 5 });
    assert.deepEqual([(await s.read('test', 'example.org', { peerId: 10 })).result.reason, (await s.read('test', 'example.org', { peerId: 11 })).result.reason], ['paused', 'default']);
    await s.as(admin, 'resume', { scope: 'peer', id: 10 });
    // the rules against foreign DNS: for filtered devices that are neither suspended nor paused
    r = await s.as(admin, 'set', { blockForeignDns: true });
    let fd = (await s.read('status')).result.foreignDns;
    assert.deepEqual([fd.enabled, fd.active, fd.devices, fd.error, typeof fd.since], [true, true, 3, null, 'string']);
    assert.deepEqual([(await dev(10)).foreignDnsBlocked, (await dev(11)).foreignDnsBlocked, (await dev(13)).foreignDnsBlocked, (await dev(14)).foreignDnsBlocked], [false, true, false, false]);
    await s.h.vpnDnsEvent({ type: 'fallback' });
    fd = (await s.read('status')).result.foreignDns;
    assert.deepEqual([fd.enabled, fd.active, fd.devices, fd.since], [true, false, 0, null]);
    await s.as(admin, 'set', { homeInternet: false });
    assert.equal((await dev(10)).internetPaused, null);
  } finally { await s.done(); }
});
