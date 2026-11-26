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
    assert.deepEqual(l.network.home.probes[0], { kind: 'jellyfin', url: 'http://192.168.1.20:8096/System/Info/Public', serverId: jf1.serverId, sourceId: 'jf-1', unique: true });
    // an away address keeps the VPN: the device uses it only with the tunnel up (1.3.0)
    await t.adminReq('PUT', 'sources/jf-1', { away: { direct: false, address: 'https://jellyfin.example.test' } });
    l = await t.appReq(MILA, '11', 'GET', 'sources');
    assert.deepEqual(l.sources[0].away, { mode: 'vpn', address: 'https://jellyfin.example.test' });
    assert.equal(l.network.vpnRequiredAway, true);
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

test('away through the VPN: sources saved without an away address get one from their route (before 1.3.0)', async () => {
  const t = await setup({ jfLabel: 'jellyfin.example.test', davLabel: 'nas.example.test' });
  try {
    await withJellyfin(t);
    await withShare(t);
    // an SMB-only share has no way away
    await t.adminReq('POST', 'sources', { kind: 'share', name: 'Musik', user: 'medien-lesen', password: 'geheim-Lese-PW-2', smb: { address: 'smb://192.168.1.20/musik' } });
    let l = await t.appReq(MILA, '11', 'GET', 'sources');
    const by = (id) => l.sources.find((x) => x.id === id);
    assert.deepEqual(by('jf-1').away, { mode: 'vpn', address: 'https://jellyfin.example.test' });
    assert.deepEqual(by('sh-1').away, { mode: 'vpn', address: 'https://nas.example.test/filme' });
    assert.deepEqual(by('sh-2').away, { mode: 'vpn' });
    // the admin pages show the same
    const a = await t.adminReq('GET', 'sources');
    assert.deepEqual(a.sources.map((x) => x.away.address || null), ['https://jellyfin.example.test', 'https://nas.example.test/filme', null]);
    const o = await t.adminReq('GET', 'overview');
    assert.equal(o.sources[0].away.address, 'https://jellyfin.example.test');
    // a saved address wins; the exception without VPN needs a saved one (a derived address keeps the VPN)
    await t.adminReq('PUT', 'sources/jf-1', { away: { direct: false, address: 'https://media.example.test' } });
    l = await t.appReq(MILA, '11', 'GET', 'sources');
    assert.deepEqual(by('jf-1').away, { mode: 'vpn', address: 'https://media.example.test' });
  } finally { await t.host.close(); }
  const t2 = await setup({ jfLabel: 'jellyfin.example.test', host: { settings: { away_direct_all: true } } });
  try {
    await withJellyfin(t2);
    const l = await t2.appReq(MILA, '11', 'GET', 'sources');
    assert.deepEqual(l.sources[0].away, { mode: 'vpn', address: 'https://jellyfin.example.test' });
  } finally { await t2.host.close(); }
});

test('awayAddressOf: only a route domain counts, never a peer, an address with a name or an L4 route', () => {
  const sources = require('../server/sources');
  const jf = (label, address = 'http://192.168.1.20:8096') => sources.awayAddressOf({ kind: 'jellyfin', config: { targetIndex: 0, address } }, { jellyfin: [{ index: 0, label }] });
  assert.equal(jf('Jellyfin.Example.Test'), 'https://jellyfin.example.test');
  assert.equal(jf('NAS (10.8.0.20:8096)'), null, 'a VPN peer');
  assert.equal(jf('192.168.1.20:8096'), null, 'an address');
  assert.equal(jf('10.0.0.5'), null, 'an IP address');
  assert.equal(jf('nas.home.example.test', 'http://nas.home.example.test:8096'), null, 'the home address itself');
  assert.equal(jf('l4.example.test:9000'), null, 'an L4 route');
  assert.equal(jf(null), null);
  assert.equal(sources.awayAddressOf({ kind: 'jellyfin', config: { targetIndex: 1, address: 'http://192.168.1.20:8096' } }, { jellyfin: [{ index: 0, label: 'jellyfin.example.test' }] }), null, 'another index');
  assert.equal(sources.awayAddressOf({ kind: 'jellyfin', config: { away: { address: 'https://media.example.test' } } }, null), 'https://media.example.test');
  assert.equal(sources.awayAddressOf({ kind: 'share', config: { webdav: { address: 'https://192.168.1.20:5006/Filme%20HD/', targetIndex: 0 } } }, { webdav: [{ index: 0, label: 'nas.example.test' }] }), 'https://nas.example.test/Filme%20HD');
  assert.equal(sources.awayAddressOf({ kind: 'share', config: { smb: { address: 'smb://192.168.1.20/filme', targetIndex: 0 } } }, { webdav: [{ index: 0, label: 'nas.example.test' }] }), null, 'SMB only');
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

test('home probes: one for every source — jellyfin / tls unique, else tcp to the home address over the LAN', async () => {
  const t = await setup();
  try {
    // Jellyfin not reachable on save: no server ID yet → tcp to its address, the tab marks it
    t.jelly.state.down = true;
    let jf = await withJellyfin(t);
    assert.equal(jf.home.level, 'weak');
    assert.equal(jf.home.why, 'no_server_id');
    // an SMB-only share, a WebDAV-only share without certificate, a pair with certificate
    await withShare(t, { name: 'Musik', smb: { address: 'smb://192.168.1.30/musik' }, webdav: null });
    await withShare(t, { name: 'Fotos', smb: null, webdav: { address: 'https://192.168.1.31:5006/fotos', targetIndex: 0 } });
    await withShare(t, { name: 'Filme' });
    let l = await t.appReq(MILA, '11', 'GET', 'sources');
    assert.equal(l.sources.find((s) => s.id === 'jf-1').serverId, null);
    assert.deepEqual(l.network.home.probes, [
      { kind: 'tls', url: 'https://192.168.1.20:5006/filme', certSha256: '9c'.repeat(32), sourceId: 'sh-3', unique: true },
      { kind: 'tcp', host: '192.168.1.20', port: 8096, sourceId: 'jf-1', unique: false },
      { kind: 'tcp', host: '192.168.1.30', port: 445, sourceId: 'sh-1', unique: false },
      { kind: 'tcp', host: '192.168.1.31', port: 5006, sourceId: 'sh-2', unique: false },
    ]);
    let srcs = (await t.adminReq('GET', 'sources')).sources;
    assert.deepEqual(srcs.map((s) => [s.id, s.home.level, s.home.why]), [['jf-1', 'weak', 'no_server_id'], ['sh-1', 'weak', 'no_cert'], ['sh-2', 'weak', 'no_cert'], ['sh-3', 'unique', null]]);
    assert.deepEqual((await t.adminReq('GET', 'overview')).sources.map((s) => s.home.level), ['weak', 'weak', 'weak', 'unique']);
    // the next reconcile reaches Jellyfin: the server ID is kept and the apps are told (media.changed)
    t.jelly.state.down = false;
    const before = t.host.events.length;
    require('../server/index')._state.lastReconcile = 0;
    await t.host.tick();
    assert.ok(t.host.events.slice(before).some((e) => e.type === 'media.changed'));
    l = await t.appReq(MILA, '11', 'GET', 'sources');
    jf = l.sources.find((s) => s.id === 'jf-1');
    assert.ok(jf.serverId);
    assert.deepEqual(l.network.home.probes[0], { kind: 'jellyfin', url: 'http://192.168.1.20:8096/System/Info/Public', serverId: jf.serverId, sourceId: 'jf-1', unique: true });
    assert.equal(l.network.home.probes.filter((p) => p.sourceId === 'jf-1').length, 1);
    // the server off again: the ID stays (no fallback to tcp), also after an edit that keeps the address
    t.jelly.state.down = true;
    await t.adminReq('POST', 'sources/jf-1/check');
    await t.adminReq('PUT', 'sources/jf-1', { name: 'NAS' });
    l = await t.appReq(MILA, '11', 'GET', 'sources');
    assert.equal(l.sources.find((s) => s.id === 'jf-1').serverId, jf.serverId);
    assert.equal(l.network.home.probes[0].kind, 'jellyfin');
    srcs = (await t.adminReq('GET', 'sources')).sources;
    assert.equal(srcs[0].home.level, 'unique');
    // a new address forgets it until the server answers there
    await t.adminReq('PUT', 'sources/jf-1', { address: 'http://192.168.1.21:8096' });
    l = await t.appReq(MILA, '11', 'GET', 'sources');
    assert.deepEqual(l.network.home.probes.find((p) => p.sourceId === 'jf-1'), { kind: 'tcp', host: '192.168.1.21', port: 8096, sourceId: 'jf-1', unique: false });
    t.jelly.state.down = false;
    await t.adminReq('PUT', 'sources/jf-1', { name: 'NAS 2' });
    l = await t.appReq(MILA, '11', 'GET', 'sources');
    assert.equal(l.network.home.probes.find((p) => p.sourceId === 'jf-1').kind, 'jellyfin', 'learned on save');
    // a pair SMB + WebDAV without certificate: both ports
    await t.adminReq('PUT', 'sources/sh-3', { webdav: { address: 'https://192.168.1.20:5006/filme', certSha256: null, targetIndex: 0 } });
    l = await t.appReq(MILA, '11', 'GET', 'sources');
    assert.deepEqual(l.network.home.probes.filter((p) => p.sourceId === 'sh-3').map((p) => [p.kind, p.host, p.port]), [['tcp', '192.168.1.20', 445], ['tcp', '192.168.1.20', 5006]]);
  } finally { await t.host.close(); }
});
