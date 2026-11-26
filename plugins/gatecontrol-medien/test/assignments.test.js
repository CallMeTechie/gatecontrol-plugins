'use strict';

// 1.4.0: the device's own ID in the app API, the NAS dialog's check before saving, tidying up unused access-target
// assignments also in the middle of a list (the sources behind a removed one are renumbered).

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, withJellyfin, withShare, MILA } = require('./helpers');

test('v1/sources and v1/cast/targets name the asking device\'s own ID (the ID of cast targets and of to/from)', async () => {
  const t = await setup();
  try {
    await withJellyfin(t);
    let l = await t.appReq(MILA, '11', 'GET', 'sources');
    assert.equal(l.deviceId, '11');
    l = await t.appReq(MILA, '12', 'GET', 'sources');
    assert.equal(l.deviceId, '12');
    const c = await t.appReq(MILA, '11', 'GET', 'cast/targets');
    assert.equal(c.deviceId, '11');
    assert.deepEqual(c.devices.map((d) => d.id), ['12']);
    // the ID is part of the answer's rev: since=rev still says unchanged for the same device
    const again = await t.appReq(MILA, '12', 'GET', 'sources', null, { query: { since: l.rev } });
    assert.equal(again.unchanged, true);
    // without a device (e.g. the browser portal)
    l = await t.appReq(MILA, null, 'GET', 'sources');
    assert.equal(l.deviceId, null);
  } finally { await t.host.close(); }
});

test('admin/probe for a NAS share: WebDAV sign-in with the entered password, or the saved one when editing; SMB by the devices', async () => {
  const good = 'Basic ' + Buffer.from('medien-lesen:geheim-Lese-PW-1').toString('base64');
  const t = await setup({ webdav: async (p, x) => ({ status: (x.headers || {}).Authorization === good ? 207 : 401, body: '' }) });
  try {
    const dav = { address: 'https://192.168.1.20:5006/filme', targetIndex: 0 };
    let r = await t.adminReq('POST', 'probe', { kind: 'share', user: 'medien-lesen', password: 'geheim-Lese-PW-1', smb: { address: 'smb://192.168.1.20/filme' }, webdav: dav });
    assert.equal(r.check.ok, true);
    assert.equal(r.check.webdav, 'ok');
    assert.equal(r.check.smb, 'devices');
    r = await t.adminReq('POST', 'probe', { kind: 'share', user: 'medien-lesen', password: 'falsch', webdav: dav });
    assert.equal(r.check.ok, false);
    assert.equal(r.check.problem, 'webdav_login_failed');
    assert.equal(r.check.smb, null);
    // nothing is saved by a probe
    assert.deepEqual((await t.adminReq('GET', 'sources')).sources, []);
    // editing: without a new password the saved one counts
    await withShare(t);
    r = await t.adminReq('POST', 'probe', { kind: 'share', sourceId: 'sh-1', user: 'medien-lesen', password: null, webdav: dav });
    assert.equal(r.check.webdav, 'ok');
    // SMB only: nothing the server can check
    r = await t.adminReq('POST', 'probe', { kind: 'share', user: 'medien-lesen', password: 'x', smb: { address: 'smb://192.168.1.20/musik' }, webdav: null });
    assert.deepEqual([r.check.ok, r.check.webdav, r.check.smb], [true, null, 'devices']);
    // bad entries as with saving
    r = await t.adminReq('POST', 'probe', { kind: 'share', user: 'medien-lesen', password: 'x', webdav: { address: 'http://192.168.1.20:5005/filme', targetIndex: 0 } });
    assert.equal(r.code, 'invalid');
  } finally { await t.host.close(); }
});

test('admin/targets/made remembers the dialog\'s own assignments; compact renumbers the sources, never drops a used one', async () => {
  const t = await setup();
  try {
    await withJellyfin(t, { targetIndex: 2 });
    await withShare(t, { webdav: { address: 'https://192.168.1.20:5006/filme', targetIndex: 3 }, smb: { address: 'smb://192.168.1.20/filme', targetIndex: 1 } });
    let r = await t.adminReq('POST', 'targets/made', { target: 'jellyfin', assignment: { kind: 'route', routeId: 7 } });
    assert.equal(r.made, 'jellyfin:route:7');
    await t.adminReq('POST', 'targets/made', { target: 'smb', assignment: { kind: 'peer', peerId: 9, port: 445, scheme: 'http' } });
    r = await t.adminReq('POST', 'targets/made', { target: 'jellyfin', assignment: { kind: 'host', host: '192.168.1.20' } });
    assert.equal(r.code, 'invalid', 'an address is the administrator\'s own');
    assert.deepEqual((await t.adminReq('GET', 'targets')).made, ['jellyfin:route:7', 'smb:peer:9:445:http']);
    assert.deepEqual((await t.adminReq('GET', 'sources')).made, ['jellyfin:route:7', 'smb:peer:9:445:http']);
    // drop index 1 of jellyfin: the source on 2 moves to 1
    r = await t.adminReq('POST', 'targets/compact', { target: 'jellyfin', map: { 0: 0, 2: 1 }, forget: ['jellyfin:route:7'] });
    assert.equal(r.changed, 1);
    let s = (await t.adminReq('GET', 'sources')).sources;
    assert.equal(s[0].config.targetIndex, 1);
    assert.deepEqual((await t.adminReq('GET', 'targets')).made, ['smb:peer:9:445:http']);
    // the share's webdav and smb separately
    r = await t.adminReq('POST', 'targets/compact', { target: 'webdav', map: { 3: 0 } });
    assert.equal(r.changed, 1);
    s = (await t.adminReq('GET', 'sources')).sources;
    assert.deepEqual([s[1].config.webdav.targetIndex, s[1].config.smb.targetIndex], [0, 1]);
    // an index in use missing from the map: refused, nothing changed
    r = await t.adminReq('POST', 'targets/compact', { target: 'smb', map: { 0: 0 } });
    assert.equal(r.code, 'conflict');
    assert.equal((await t.adminReq('GET', 'sources')).sources[1].config.smb.targetIndex, 1);
    // invalid maps
    for (const map of [{ 1: 0, 2: 0 }, { 1: -1 }, { x: 1 }, null, [1]]) assert.equal((await t.adminReq('POST', 'targets/compact', { target: 'smb', map })).code, 'invalid');
    assert.equal((await t.adminReq('POST', 'targets/compact', { target: 'other', map: {} })).code, 'invalid');
    // the inverse map puts it back
    r = await t.adminReq('POST', 'targets/compact', { target: 'jellyfin', map: { 1: 2 } });
    assert.equal((await t.adminReq('GET', 'sources')).sources[0].config.targetIndex, 2);
  } finally { await t.host.close(); }
});
