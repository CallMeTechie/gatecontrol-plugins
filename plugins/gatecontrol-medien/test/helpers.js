'use strict';

// Test helpers: the mock host (tools/testing/mock-host.js, GateControl 1.317.1 — devices, groups, signal topics)
// with a family, a Jellyfin from the spike's recordings (test/jellyfin-mock.js) and devices.
//
//   ADMIN Mila (admin, parent) · JONAS (parent) · LENA (child) · PAUL (child) · BUERO (no family)
//   devices: Pixel von Mila (android, '11'), Wohnzimmer-TV (android-tv of Mila, '12'), Büro-PC (windows of Jonas, '21'),
//            Tablet von Lena ('31')

const path = require('node:path');
const { createHost } = require('../../../tools/testing/mock-host');
const { createJellyfin, KEY } = require('./jellyfin-mock');

const DIR = path.join(__dirname, '..');
const MILA = { id: 1, name: 'Mila', role: 'admin' };
const JONAS = { id: 2, name: 'Jonas', role: 'user' };
const LENA = { id: 3, name: 'Lena', role: 'user' };
const PAUL = { id: 4, name: 'Paul', role: 'user' };
const BUERO = { id: 5, name: 'Büro-Konto', role: 'user' };
const USERS = [MILA, JONAS, LENA, PAUL, BUERO];
const FAMILY = 20;
const ADULTS = 21;

const DEVICES = () => [
  { id: '11', userId: 1, name: 'Pixel von Mila', platform: 'android', appVersion: '1.155.0', online: true, via: 'lan' },
  { id: '12', userId: 1, name: 'Wohnzimmer-TV', platform: 'android', clientType: 'android-tv', online: true, via: 'lan' },
  { id: '21', userId: 2, name: 'Büro-PC', platform: 'windows', clientType: 'pro', online: false },
  { id: '31', userId: 3, name: 'Tablet von Lena', platform: 'android', online: true },
];

async function setup(o = {}) {
  const jelly = createJellyfin(o.jellyfin || '10.10.7', o.jf || {});
  const devices = o.devices || DEVICES();
  const host = await createHost(DIR, {
    gatecontrol: '1.317.1',
    users: USERS,
    groups: [
      { id: FAMILY, name: 'Familie', kind: 'family', members: [{ userId: 1, role: 'parent' }, { userId: 2, role: 'parent' }, { userId: 3, role: 'child' }, { userId: 4, role: 'child' }] },
      { id: ADULTS, name: 'Erwachsene', kind: 'team', members: [{ userId: 1, role: 'member' }, { userId: 2, role: 'member' }] },
    ],
    devices,
    targets: {
      jellyfin: [{ label: o.jfLabel || '192.168.1.20:8096 über Gateway Zuhause', fetch: (p, x) => jelly.fetch(p, x) }],
      webdav: [{ label: o.davLabel || '192.168.1.20:5006', fetch: o.webdav || (async (p, x) => ({ status: /Basic /.test(String((x.headers || {}).Authorization)) ? 207 : 401, body: '' })) }],
    },
    ...(o.host || {}),
  });
  await host.start();
  const adminReq = async (method, p, body, x = {}) => {
    const r = await host.request({ method, path: '/admin/' + p, body: body || null, user: { ...MILA }, lang: 'de', ...(x.query ? { query: x.query } : {}) });
    return { status: r.status || 200, ...r.json };
  };
  /** An app request of a device (user.device as GateControl hands it to a plugin with permissions.devices). */
  const appReq = async (user, deviceId, method, p, body, x = {}) => {
    const d = devices.find((y) => y.id === deviceId);
    const dev = deviceId ? { id: deviceId, platform: d ? d.platform : 'android', ...(d && d.clientType ? { clientType: d.clientType } : {}) } : undefined;
    const r = await host.request({ method, path: '/v1/' + p, body: body || null, query: x.query || {}, user: { ...user, portal: true, loggedIn: true, app: true, ...(dev ? { device: dev } : {}) }, lang: 'de' });
    return { status: r.status || 200, ...r.json };
  };
  return { host, jelly, devices, adminReq, appReq };
}

/** A Jellyfin source as the dialog sends it (the right "Medien" for the family group first). */
async function withJellyfin(t, x = {}) {
  await t.adminReq('PUT', 'rights/group/' + FAMILY, { media: true });
  const r = await t.adminReq('POST', 'sources', { kind: 'jellyfin', name: 'DS918+', targetIndex: 0, address: 'http://192.168.1.20:8096', key: KEY, ...x });
  return r.source;
}

async function withShare(t, x = {}) {
  const r = await t.adminReq('POST', 'sources', { kind: 'share', name: 'Filme', user: 'medien-lesen', password: 'geheim-Lese-PW-1',
    smb: { address: 'smb://192.168.1.20/filme' }, webdav: { address: 'https://192.168.1.20:5006/filme', certSha256: '9c'.repeat(32), targetIndex: 0 }, ...x });
  return r.source;
}

/** What an app does for its first Jellyfin sign-in: read its DeviceId from v1/sources, start Quick Connect, hand the code over. */
async function pair(t, user, deviceId, sourceId = 'jf-1') {
  const list = await t.appReq(user, deviceId, 'GET', 'sources');
  const s = list.sources.find((x) => x.id === sourceId);
  const code = t.jelly.initiate(s.device.id, s.device.name);
  return t.appReq(user, deviceId, 'POST', 'jellyfin/pair', { sourceId, code });
}

module.exports = { setup, withJellyfin, withShare, pair, MILA, JONAS, LENA, PAUL, BUERO, USERS, FAMILY, ADULTS, KEY, DEVICES };
