'use strict';

// Sources, secrets and the network rule (home direct, away only through the VPN, the exception with an HTTPS address).

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, withJellyfin, withShare, MILA, JONAS, LENA, BUERO, KEY } = require('./helpers');

test('a Jellyfin source: checked on save, the key never in the database or an answer', async () => {
  const t = await setup();
  try {
    const s = await withJellyfin(t);
    assert.equal(s.id, 'jf-1');
    assert.equal(s.hasKey, true);
    assert.equal(s.status.ok, true);
    assert.equal(s.status.version, '10.10.7');
    assert.equal(s.status.quickConnect, true);
    assert.ok(!JSON.stringify(s).includes(KEY));
    assert.ok(t.host.secrets.has('jf.jf-1.key'));
    const list = await t.adminReq('GET', 'sources');
    assert.ok(!JSON.stringify(list).includes(KEY));
    assert.deepEqual(list.targets.jellyfin, [{ index: 0, label: '192.168.1.20:8096 über Gateway Zuhause' }]);
    // an http address for away is refused, direct without an address too
    let r = await t.adminReq('PUT', 'sources/jf-1', { away: { direct: true, address: 'http://jellyfin.example.test' } });
    assert.equal(r.status, 400);
    assert.equal(r.field, 'away.address');
    r = await t.adminReq('PUT', 'sources/jf-1', { away: { direct: true } });
    assert.equal(r.status, 422);
    assert.equal(r.code, 'away_address_required');
    r = await t.adminReq('POST', 'sources', { kind: 'jellyfin', name: 'X', address: 'http://192.168.1.21:8096', key: 'kurz' });
    assert.equal(r.code, 'invalid');
    assert.equal(r.field, 'key');
  } finally { await t.host.close(); }
});

test('the network rule in v1/sources: VPN away by default, direct only with the exception and an HTTPS address', async () => {
  const t = await setup();
  try {
    await withJellyfin(t);
    let l = await t.appReq(MILA, '11', 'GET', 'sources');
    const jf1 = l.sources.find((s) => s.id === 'jf-1');
    assert.deepEqual(jf1.home, { address: 'http://192.168.1.20:8096' });
    assert.deepEqual(jf1.away, { mode: 'vpn' });
    assert.equal(l.network.rule, 'home_direct_away_vpn');
    assert.equal(l.network.vpnRequiredAway, true);
    assert.deepEqual(l.network.home.probes[0], { kind: 'jellyfin', url: 'http://192.168.1.20:8096/System/Info/Public', serverId: jf1.serverId });
    // an away address alone changes nothing
    await t.adminReq('PUT', 'sources/jf-1', { away: { direct: false, address: 'https://jellyfin.example.test' } });
    l = await t.appReq(MILA, '11', 'GET', 'sources');
    assert.deepEqual(l.sources[0].away, { mode: 'vpn' });
  } finally { await t.host.close(); }
  const t2 = await setup({ host: { settings: { away_direct_all: true } } });
  try {
    await withJellyfin(t2, { away: { address: 'https://jellyfin.example.test' } });
    const l = await t2.appReq(MILA, '11', 'GET', 'sources');
    assert.deepEqual(l.sources[0].away, { mode: 'direct', address: 'https://jellyfin.example.test' });
    assert.equal(l.network.vpnRequiredAway, false);
  } finally { await t2.host.close(); }
  const t3 = await setup();
  try {
    await withJellyfin(t3, { away: { direct: true, address: 'https://jellyfin.example.test:8920' } });
    const l = await t3.appReq(MILA, '11', 'GET', 'sources');
    assert.deepEqual(l.sources[0].away, { mode: 'direct', address: 'https://jellyfin.example.test:8920' });
  } finally { await t3.host.close(); }
});

test('a share: the password only for allowed devices, children without shares, a new password raises secretRev', async () => {
  const t = await setup();
  try {
    await withJellyfin(t);
    const sh = await withShare(t);
    assert.equal(sh.hasPassword, true);
    assert.equal(sh.status.webdav, 'ok');
    assert.ok(!JSON.stringify(sh).includes('geheim-Lese-PW-1'));
    const l = await t.appReq(MILA, '11', 'GET', 'sources');
    const s = l.sources.find((x) => x.id === 'sh-1');
    assert.equal(s.password, undefined, 'the list never carries a password');
    assert.equal(s.secretRev, 1);
    assert.equal(s.folder, 'filme');
    assert.deepEqual(s.away, { mode: 'vpn' });
    const sec = await t.appReq(MILA, '11', 'GET', 'sources/sh-1/secret');
    assert.deepEqual({ user: sec.user, password: sec.password, rev: sec.rev }, { user: 'medien-lesen', password: 'geheim-Lese-PW-1', rev: 1 });
    // Lena is a child of the family: no share (the setting is off)
    const ll = await t.appReq(LENA, '31', 'GET', 'sources');
    assert.deepEqual(ll.sources.map((x) => x.id), ['jf-1']);
    assert.equal((await t.appReq(LENA, '31', 'GET', 'sources/sh-1/secret')).code, 'no_access');
    // without a device the password is not handed out
    assert.equal((await t.appReq(MILA, null, 'GET', 'sources/sh-1/secret')).code, 'no_device');
    // the log names the delivery, never the password
    const lg = await t.adminReq('GET', 'log');
    assert.ok(lg.log.some((x) => /Zugang zu Filme \(NAS\) an Pixel von Mila \(Mila\) ausgeliefert/.test(x.text)));
    assert.ok(!JSON.stringify(lg).includes('geheim'));
    assert.ok(!t.host.logs.some((x) => JSON.stringify(x).includes('geheim')));
    // a new password: secretRev 2, the device sees that its revision is old
    const r = await t.adminReq('PUT', 'sources/sh-1/password', { password: 'neu-PW-2' });
    assert.equal(r.source.secretRev, 2);
    assert.ok(t.host.events.some((e) => e.type === 'media.changed'));
    const d = await t.adminReq('GET', 'devices');
    assert.equal(d.devices.find((x) => x.id === '11').shares[0].current, false);
    // the device reports its SMB sign-in
    assert.equal((await t.appReq(MILA, '11', 'POST', 'shares/sh-1/checked', { protocol: 'smb', ok: true })).ok, true);
    // http WebDAV is refused
    const bad = await t.adminReq('POST', 'sources', { kind: 'share', name: 'X', user: 'u', password: 'p', webdav: { address: 'http://192.168.1.20:5005/x' } });
    assert.equal(bad.field, 'webdav.address');
  } finally { await t.host.close(); }
});

test('people without the right get no media, the app tab follows the right and the sources', async () => {
  const t = await setup();
  try {
    assert.equal(await t.host.appVisible(MILA), false, 'no source yet');
    await withJellyfin(t);
    assert.equal(await t.host.appVisible(MILA), true);
    assert.equal(await t.host.appVisible(BUERO), false, 'no right');
    const l = await t.appReq(BUERO, null, 'GET', 'sources');
    assert.equal(l.media, false);
    assert.deepEqual(l.sources, []);
    // the right for one person, then "list" mode of the source without that person
    await t.adminReq('PUT', 'rights/user/5', { media: true });
    assert.equal(await t.host.appVisible(BUERO), true);
    await t.adminReq('PUT', 'sources/jf-1/access', { mode: 'list', groups: [{ id: 21 }] });
    assert.equal(await t.host.appVisible(BUERO), false);
    assert.equal(await t.host.appVisible(JONAS), true, 'Jonas is in the group Erwachsene');
    // rev: unchanged when nothing changed
    const a = await t.appReq(JONAS, '21', 'GET', 'sources');
    const b = await t.appReq(JONAS, '21', 'GET', 'sources', null, { query: { since: a.rev } });
    assert.equal(b.unchanged, true);
    assert.equal(b.sources, undefined);
  } finally { await t.host.close(); }
});

test('the licence: a plan or GateControl lifetime licence does not count', async () => {
  const t = await setup({ host: { gatecontrol: '1.317.1', license: { licensed: true, state: 'valid', source: 'lifetime' } } });
  try {
    await withJellyfin(t);
    assert.equal(await t.host.appVisible(MILA), false);
    const r = await t.appReq(MILA, '11', 'GET', 'sources');
    assert.equal(r.status, 403);
    assert.equal(r.code, 'license_required');
    assert.equal(r.reason, 'not_own');
    const o = await t.adminReq('GET', 'overview');
    assert.equal(o.license.ok, false);
  } finally { await t.host.close(); }
  const t2 = await setup({ host: { license: { licensed: true, state: 'valid', source: 'license' } } });
  try {
    await withJellyfin(t2);
    assert.equal(await t2.host.appVisible(MILA), true);
  } finally { await t2.host.close(); }
});
