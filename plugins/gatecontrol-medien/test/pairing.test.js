'use strict';

// Pairing (flow A: Quick Connect started by the device, confirmed by the plugin with the API key), mapping, revocation.

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, withJellyfin, withShare, pair, MILA, JONAS, LENA, PAUL } = require('./helpers');

test('flow A: the device gets its own Jellyfin access for its linked user, without anybody typing', async () => {
  const t = await setup();
  try {
    await withJellyfin(t);
    const l = await t.appReq(MILA, '11', 'GET', 'sources');
    const s = l.sources[0];
    assert.deepEqual(s.user, { id: t.jelly.userId('mila'), name: 'mila' });
    assert.match(s.device.id, /^gc-[A-Za-z0-9]{20}$/);
    assert.equal(s.device.name, 'GateControl · Pixel von Mila');
    assert.equal(s.paired, false);
    // the same device id on every call, a different one per device
    const l2 = await t.appReq(MILA, '12', 'GET', 'sources');
    assert.notEqual(l2.sources[0].device.id, s.device.id);
    assert.equal((await t.appReq(MILA, '11', 'GET', 'sources')).sources[0].device.id, s.device.id);
    const r = await pair(t, MILA, '11');
    assert.equal(r.ok, true);
    assert.equal(r.userName, 'mila');
    assert.equal(r.deviceId, s.device.id);
    assert.equal(t.jelly.state.devices.get(s.device.id).LastUserName, 'mila');
    assert.equal((await t.appReq(MILA, '11', 'POST', 'jellyfin/paired', { sourceId: 'jf-1', jellyfinDeviceId: s.device.id })).ok, true);
    assert.equal((await t.appReq(MILA, '11', 'GET', 'sources')).sources[0].paired, true);
    const lg = await t.adminReq('GET', 'log');
    assert.ok(lg.log.some((x) => x.text === 'Pixel von Mila bei Jellyfin (DS918+) als mila angemeldet'));
    // never a code or a key in the log
    assert.ok(!t.host.logs.some((x) => /\b\d{6}\b/.test(JSON.stringify(x)) && /code/i.test(JSON.stringify(x))));
  } finally { await t.host.close(); }
});

test('refusals: no mapping, a code of another device, Quick Connect off, the rate limit, no device', async () => {
  const t = await setup();
  try {
    await withJellyfin(t);
    // Paul has no Jellyfin user
    const lp = await t.appReq(PAUL, null, 'GET', 'sources');
    assert.equal(lp.sources[0].problem, 'no_mapping');
    t.devices.push({ id: '41', userId: 4, name: 'Pauls Handy', platform: 'android', online: true });
    let r = await t.appReq(PAUL, '41', 'POST', 'jellyfin/pair', { sourceId: 'jf-1', code: t.jelly.initiate('gc-x', 'x') });
    assert.equal(r.status, 409);
    assert.equal(r.code, 'no_mapping');
    // a code that a different DeviceId started
    r = await t.appReq(MILA, '11', 'POST', 'jellyfin/pair', { sourceId: 'jf-1', code: t.jelly.initiate('gc-fremdesGeraet000000', 'fremd') });
    assert.equal(r.code, 'device_mismatch');
    // an unknown code
    r = await t.appReq(MILA, '11', 'POST', 'jellyfin/pair', { sourceId: 'jf-1', code: '999999' });
    assert.equal(r.status, 422);
    assert.equal(r.code, 'code_invalid');
    // Quick Connect off
    t.jelly.state.quickConnect = false;
    t.jelly.state.requests.set('424242', { deviceId: 'gc-y', deviceName: 'y', authorized: null });
    r = await t.appReq(MILA, '11', 'POST', 'jellyfin/pair', { sourceId: 'jf-1', code: '424242' });
    assert.equal(r.code, 'quick_connect_off');
    t.jelly.state.quickConnect = true;
    // without a device
    r = await t.appReq(MILA, null, 'POST', 'jellyfin/pair', { sourceId: 'jf-1', code: '123456' });
    assert.equal(r.code, 'no_device');
    // 10 per hour and device
    for (let i = 0; i < 7; i++) await t.appReq(MILA, '11', 'POST', 'jellyfin/pair', { sourceId: 'jf-1', code: '99999' + i });
    r = await t.appReq(MILA, '11', 'POST', 'jellyfin/pair', { sourceId: 'jf-1', code: '888888' });
    assert.equal(r.status, 429);
    // a Jellyfin administrator is never offered for a mapping
    const ppl = await t.adminReq('GET', 'people');
    assert.ok(!ppl.jellyfinUsers['jf-1'].some((u) => u.name === 'admin'));
    const bad = await t.adminReq('PUT', 'sources/jf-1/mapping/2', { jfUserId: t.jelly.userId('admin') });
    assert.equal(bad.field, 'jfUserId');
  } finally { await t.host.close(); }
});

test('mapping by hand, "bewusst ohne", "In Jellyfin anlegen"', async () => {
  const t = await setup();
  try {
    await withJellyfin(t);
    let ppl = await t.adminReq('GET', 'people');
    assert.equal(ppl.people.find((p) => p.id === 2).links['jf-1'].how, 'auto');
    assert.equal(ppl.people.find((p) => p.id === 3).family, 'child');
    assert.equal(ppl.people.find((p) => p.id === 1).family, 'parent');
    // Paul: create the user in Jellyfin
    const c = await t.adminReq('POST', 'sources/jf-1/mapping/4/create', { name: 'paul' });
    assert.equal(c.mapping.how, 'created');
    assert.ok(t.jelly.state.users.some((u) => u.Name === 'paul' && !u.Policy.IsAdministrator));
    // Jonas: deliberately none → his paired device is signed out
    await pair(t, JONAS, '21');
    assert.equal(t.jelly.state.devices.size, 1);
    await t.adminReq('PUT', 'sources/jf-1/mapping/2', { jfUserId: null });
    assert.equal(t.jelly.state.devices.size, 0, 'the mapping changed: the device is deleted in Jellyfin');
    ppl = await t.adminReq('GET', 'people');
    assert.equal(ppl.people.find((p) => p.id === 2).links['jf-1'].how, 'none');
    // a revoked device gets a silent signal
    const sig = t.host.notifications.filter((n) => n.topic === 'media_signal');
    assert.equal(sig.length, 1);
    assert.deepEqual(sig[0].devices, ['21']);
    assert.equal(sig[0].silent, true);
    assert.equal(sig[0].data.kind, 'media.revoke');
    assert.deepEqual(sig[0].data.sourceIds, ['jf-1']);
    // back to automatic: jonas again
    await t.adminReq('PUT', 'sources/jf-1/mapping/2', { auto: true });
    ppl = await t.adminReq('GET', 'people');
    assert.equal(ppl.people.find((p) => p.id === 2).links['jf-1'].jfUserName, 'jonas');
    void LENA;
  } finally { await t.host.close(); }
});

test('revocation: a device removed in GateControl (reconcile and the hook devicesChanged), a right taken away', async () => {
  const t = await setup();
  try {
    await withJellyfin(t);
    await withShare(t);
    await pair(t, MILA, '11');
    await pair(t, MILA, '12');
    await t.appReq(MILA, '11', 'GET', 'sources/sh-1/secret');
    assert.equal(t.jelly.state.devices.size, 2);
    // 1) the hook of GateControl ≥ 1.322.0: the phone's token is revoked
    const ch = await t.host.devicesChanged({ removed: [{ id: '11', userId: 1, name: 'Pixel von Mila', platform: 'android', reason: 'revoked' }] });
    assert.equal(ch.removed[0].reason, 'revoked');
    assert.equal(t.jelly.state.devices.size, 1, 'signed out of Jellyfin at once');
    let d = await t.adminReq('GET', 'devices');
    const gone = d.devices.find((x) => x.id === '11');
    assert.equal(gone.removed, true);
    assert.equal(gone.jellyfin.length, 0);
    assert.ok((await t.adminReq('GET', 'log')).log.some((x) => /Pixel von Mila: Zugang zu Filme entzogen .*das Gerät hatte das NAS-Passwort/.test(x.text)));
    // 2) without the hook: the TV disappears from the list, the reconcile (every 5 minutes) catches it
    t.devices.splice(t.devices.findIndex((x) => x.id === '12'), 1);
    require('../server/index')._state.lastReconcile = 0;
    await t.host.tick();
    assert.equal(t.jelly.state.devices.size, 0);
    // 3) a right taken away: Jonas paired, then the family loses "Medien" and Jonas has no own row
    await pair(t, JONAS, '21');
    assert.equal(t.jelly.state.devices.size, 1);
    await t.adminReq('PUT', 'rights/group/20', { media: false });
    assert.equal(t.jelly.state.devices.size, 0);
    d = await t.adminReq('GET', 'devices');
    assert.equal(d.devices.find((x) => x.id === '21'), undefined, 'no right, nothing left: not listed');
    // admin "Abmelden" of a device with a password
    await t.adminReq('PUT', 'rights/user/2', { media: true });
    await withShare(t, { name: 'Musik', smb: { address: 'smb://192.168.1.20/musik' }, webdav: null });
    assert.equal((await t.appReq(JONAS, '21', 'GET', 'sources/sh-2/secret')).ok, true);
    const before = t.host.notifications.length;
    await t.adminReq('POST', 'devices/21/revoke', {});
    const sig = t.host.notifications.slice(before).find((n) => n.topic === 'media_signal');
    assert.equal(sig.data.kind, 'media.revoke');
    assert.equal(sig.data.reason, 'admin');
  } finally { await t.host.close(); }
});

test('removing a source signs every device out and deletes its secret', async () => {
  const t = await setup();
  try {
    await withJellyfin(t);
    await pair(t, MILA, '11');
    await t.adminReq('DELETE', 'sources/jf-1');
    assert.equal(t.jelly.state.devices.size, 0);
    assert.equal((await t.adminReq('GET', 'sources')).sources.length, 0);
    assert.equal(t.host.secrets.has('jf.jf-1.key'), false, 'the API key is deleted');
    const l = await t.appReq(MILA, '11', 'GET', 'sources');
    assert.deepEqual(l.sources, []);
    // the app signs out itself (DELETE v1/jellyfin/device) — nothing left here
    assert.deepEqual((await t.appReq(MILA, '11', 'DELETE', 'jellyfin/device')).sources, []);
  } finally { await t.host.close(); }
});
