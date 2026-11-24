'use strict';

// 1.9.1: the browser session to a registered Windows PC — credentials stored at the PC („Bearbeiten“ › Anmeldung) go to
// the browser always and to the apps as credential_mode allows (GateControl then negotiates NLA; without them it
// skips NLA, gc.remote version 10); the keyboard layout of the device (keyboard_layout, gc.remote version 10).

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, MARC, SABINE } = require('./helpers');
const support = require('../server/support');
const connect = require('../server/connect');

support.TIMING.waitMs = 1500;
support.TIMING.facadeWaitMs = 1500;
support.TIMING.pollMs = 10;

const DEVICES = [
  { id: '801', userId: MARC.id, name: 'Marc PC', platform: 'windows', vpnIp: '10.8.0.61' },
  { id: '802', userId: SABINE.id, name: 'Sabine Laptop', platform: 'windows', vpnIp: '10.8.0.62' },
];
const PC = { id: '801', platform: 'windows', vpnIp: '10.8.0.61' };
const REG = { name: 'Büro-PC Marc', edition: 'pro', rdp: { available: true, enabled: true, port: 3389 }, osUser: 'marc', appVersion: '1.95.0' };
const PASSWORD = 'Pc-Geheim-41!';

async function start(remote = {}) {
  const s = await setup({ gatecontrol: '1.284.0', remote, host: { devices: DEVICES } });
  const app = async (user, dev, method, path, body) => {
    const r = await s.host.request({ method, path, body: body || null, user: { ...user, app: true, portal: true, loggedIn: true, device: dev }, lang: 'de' });
    return { status: r.status || 200, ...r.json };
  };
  const { host: h } = await app(MARC, PC, 'POST', '/host/register', REG);
  await app(MARC, PC, 'PUT', '/host/access', { users: [SABINE.id], groups: [] });
  await s.adminReq('PUT', 'rights/user/' + SABINE.id, { rdp: true });
  await app(MARC, PC, 'PUT', '/host/share', { shareMode: 'open' });
  return { ...s, app, id: h.deviceId };
}

async function pcOpens(host, app) {
  for (let i = 0; i < 200; i++) {
    const s = host.notifications.filter((n) => n.topic === 'remote_signal' && n.data && n.data.type === 'remote.firewall.open').slice(-1)[0];
    if (s && !s.answered) { s.answered = true; return app(MARC, PC, 'POST', '/host/firewall', { sessionKey: s.data.sessionKey, state: 'open' }); }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('no firewall signal');
}

async function browser(s) {
  const p = s.req(SABINE, 'POST', '/devices/' + s.id + '/connect');
  await pcOpens(s.host, s.app);
  const r = await p;
  assert.equal(r.ok, true, JSON.stringify(r));
  return s.host.remote.calls.filter((c) => c.op === 'session').slice(-1)[0];
}

test('without credentials: the browser session has none (GateControl skips NLA), no keyboard layout of its own', async () => {
  const s = await start({ v10: true });
  try {
    const c = await browser(s);
    assert.equal(c.credential, null);
    assert.equal(c.options.nla_enabled, true);
    assert.equal('keyboard_layout' in c.options, false, 'auto: GateControl takes the language of the browser');
  } finally { await s.host.close(); }
});

test('credentials stored at the PC: the browser uses them, never logged; the apps only as credential_mode allows', async () => {
  const s = await start({ v10: true });
  try {
    const put = await s.adminReq('PUT', 'devices/' + s.id, { credentials: { username: 'marc', password: PASSWORD }, config: { domain: 'BUERO' } });
    assert.equal(put.ok, true, JSON.stringify(put));
    const handle = (await s.host.gc.db.get('SELECT credential FROM devices WHERE id = ?', [s.id])).row.credential;
    assert.match(handle, /^rv_/);
    const c = await browser(s);
    assert.equal(c.credential, handle, 'the vault handle, GateControl resolves it');
    assert.equal(JSON.stringify(s.host.logs || []).includes(PASSWORD), false);
    assert.equal(JSON.stringify(s.host.remote.calls).includes(PASSWORD), false);
    // the old app API: credential_mode none (as registered) → no credentials for the apps
    const U = { id: SABINE.id, tokenId: 802, peerId: 62, scopes: ['client', 'client:rdp'], platform: 'windows', selfIp: '10.8.0.62' };
    await s.host.legacyImport({ schema: 1, dataset: 'remote', exportedAt: new Date().toISOString(), routes: [], sessions: [], maintenance: [] });
    let p = s.host.clientFacade('connect', { id: s.id, user: U, query: { ecdhPublicKey: 'K' } });
    await pcOpens(s.host, s.app);
    let r = await p;
    assert.equal(r.status, 200, JSON.stringify(r));
    assert.equal(r.body.connection.credential_mode, 'none');
    assert.equal(r.body.connection.credentials_e2ee, undefined);
    // „Anmeldedaten an die Apps“: Benutzername und Passwort → sealed for the app
    await s.adminReq('PUT', 'devices/' + s.id, { config: { credential_mode: 'full' } });
    p = s.host.clientFacade('connect', { id: s.id, user: U, query: { ecdhPublicKey: 'K' } });
    await pcOpens(s.host, s.app);
    r = await p;
    assert.equal(r.status, 200, JSON.stringify(r));
    assert.equal(r.body.connection.credential_mode, 'full');
    assert.equal(r.body.connection.domain, 'BUERO');
    assert.deepEqual(JSON.parse(Buffer.from(r.body.connection.credentials_e2ee.data, 'base64').toString()), { username: 'marc', password: PASSWORD, domain: 'BUERO' });
    // nur Benutzername
    await s.adminReq('PUT', 'devices/' + s.id, { config: { credential_mode: 'user_only' } });
    p = s.host.clientFacade('connect', { id: s.id, user: U, query: { ecdhPublicKey: 'K' } });
    await pcOpens(s.host, s.app);
    r = await p;
    assert.equal(JSON.parse(Buffer.from(r.body.connection.credentials_e2ee.data, 'base64').toString()).password, null);
  } finally { await s.host.close(); }
});

test('unreadable credentials of the PC: credential_unreadable before the firewall opens', async () => {
  const s = await start({ v10: true });
  try {
    await s.adminReq('PUT', 'devices/' + s.id, { credentials: { username: 'marc', password: PASSWORD } });
    await s.host.gc.db.run('UPDATE devices SET credential_unreadable = 1 WHERE id = ?', [s.id]);
    const before = s.host.notifications.length;
    assert.equal((await s.req(SABINE, 'POST', '/devices/' + s.id + '/connect')).code, 'credential_unreadable');
    assert.equal(s.host.notifications.slice(before).some((n) => n.data && n.data.type === 'remote.firewall.open'), false);
  } finally { await s.host.close(); }
});

test('keyboard layout of the device: passed with gc.remote version 10, never to an older GateControl', async () => {
  const s = await start({ v10: true });
  try {
    const put = await s.adminReq('PUT', 'devices/' + s.id, { config: { keyboard_layout: 'de-ch-qwertz' } });
    assert.equal(put.ok, true, JSON.stringify(put));
    assert.equal((await s.adminReq('PUT', 'devices/' + s.id, { config: { keyboard_layout: 'xx-yy' } })).code, 'invalid');
    assert.equal((await browser(s)).options.keyboard_layout, 'de-ch-qwertz');
  } finally { await s.host.close(); }
  const d = { protocol: 'rdp', config: { keyboard_layout: 'de-de-qwertz' } };
  assert.deepEqual(connect.layoutOption(d, { remote: { version: 9 } }), {});
  assert.deepEqual(connect.layoutOption(d, { remote: { version: 10 } }), { keyboard_layout: 'de-de-qwertz' });
  assert.deepEqual(connect.layoutOption({ config: { keyboard_layout: 'auto' } }, { remote: { version: 10 } }), {});
  assert.equal(connect.optionsOf(d).keyboard_layout, undefined, 'without gc: nothing new');
  assert.equal(connect.optionsOf(d, { remote: { version: 10 } }).keyboard_layout, 'de-de-qwertz');
});

test('keyboard layout of a device made here: browser session and the old app API carry it (version 10)', async () => {
  const s = await setup({ remote: { v10: true } });
  try {
    const d = (await s.adminReq('POST', 'devices', { name: 'Büro', protocol: 'rdp', config: { host: '10.8.0.44', port: 3389, browser_enabled: true, keyboard_layout: 'fr-fr-azerty' } })).device;
    const r = await s.adminReq('POST', 'devices/' + d.id + '/connect', {});
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(s.host.remote.calls.filter((c) => c.op === 'session').slice(-1)[0].options.keyboard_layout, 'fr-fr-azerty');
  } finally { await s.host.close(); }
});
