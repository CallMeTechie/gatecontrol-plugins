'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, rdpDevice, ADMIN, MARC, SABINE, LEA, BUERO } = require('./helpers');

async function withDevice(o = {}) {
  const s = await setup(o);
  const d = (await s.adminReq('POST', 'devices', { ...rdpDevice(o.device || {}), credentials: { username: 'tom', password: 'geheim' } })).device;
  return { ...s, d };
}

test('Verbinden: a ticket of GateControl for a person with the right, the history records the tunnel', async () => {
  const { host, adminReq, req, d } = await withDevice();
  try {
    // without the right: no tab, no session
    assert.equal(await host.portalVisible(MARC), false);
    assert.equal((await req(MARC, 'POST', '/devices/' + d.id + '/connect')).code, 'no_right');
    await adminReq('PUT', 'rights/group/' + BUERO, { rdp: true });
    assert.equal(await host.portalVisible(MARC), true);
    const ov = await req(MARC, 'GET', '/overview');
    assert.deepEqual(ov.devices.map((x) => x.name), ['Büro-PC']);
    assert.equal(JSON.stringify(ov).includes('10.8.0.44'), false, 'the portal gets no address');
    const r = await req(MARC, 'POST', '/devices/' + d.id + '/connect');
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.match(r.session.ref, /^[A-Za-z0-9_-]{43}$/);
    const call = host.remote.calls.find((c) => c.op === 'session');
    assert.equal(call.user, MARC.id);
    assert.deepEqual(call.target, { id: 'dev-' + d.id, name: 'Büro-PC', host: '10.8.0.44', port: 3389 });
    assert.equal(call.protocol, 'rdp');
    assert.match(call.credential, /^rv_/);
    assert.equal(call.options.nla_enabled, true);
    // the person opens the page → start, closes it → end
    const { sessionId } = await host.remoteOpen(r.session.ref);
    let hist = (await adminReq('GET', 'sessions')).sessions;
    assert.equal(hist.length, 1);
    assert.equal(hist[0].status, 'active');
    assert.equal(hist[0].via, 'browser');
    assert.equal(hist[0].userName, 'Marc');
    // the administrator ends it
    assert.equal((await adminReq('POST', 'sessions/' + hist[0].id + '/end')).ended, true);
    hist = (await adminReq('GET', 'sessions')).sessions;
    assert.equal(hist[0].status, 'ended');
    assert.equal(hist[0].endReason, 'ended_by_plugin');
    assert.ok(sessionId > 0);
    const csv = await adminReq('GET', 'sessions/csv');
    assert.match(csv.csv, /^id,device,person/);
    assert.match(csv.csv, /"Büro-PC","Marc"/);
  } finally { await host.close(); }
});

test('the person\'s own "no" wins over the group, the access list limits the devices', async () => {
  const { host, adminReq, req, d } = await withDevice();
  try {
    await adminReq('PUT', 'rights/group/' + BUERO, { rdp: true });
    await adminReq('PUT', 'rights/user/' + SABINE.id, { rdp: false });
    assert.equal((await req(SABINE, 'POST', '/devices/' + d.id + '/connect')).code, 'no_right');
    await adminReq('PUT', 'rights/user/' + LEA.id, { rdp: true });
    assert.equal((await req(LEA, 'GET', '/overview')).devices.length, 1, 'no list: everybody with the right');
    await adminReq('PUT', 'devices/' + d.id + '/access', { users: [], groups: [BUERO] });
    assert.equal((await req(LEA, 'GET', '/overview')).devices.length, 0);
    assert.equal((await req(MARC, 'GET', '/overview')).devices.length, 1);
    const m = await adminReq('GET', 'rights');
    assert.equal(m.people.find((p) => p.id === SABINE.id).effective.rdp, false);
    assert.equal(m.people.find((p) => p.id === MARC.id).source.rdp, 'group');
    assert.equal(m.people.find((p) => p.id === MARC.id).effective.share, true, 'share is on by default');
    assert.deepEqual(m.devices[0].access.groups, [BUERO]);
    const view = await adminReq('GET', 'rights/user/' + MARC.id);
    assert.deepEqual(view.devices.map((x) => x.name), ['Büro-PC']);
    // an administrator's right cannot be changed
    assert.equal((await adminReq('PUT', 'rights/user/' + ADMIN.id, { rdp: false })).code, 'invalid');
    // the profile section
    assert.equal(await host.portalVisible(LEA, 'rights'), true);
    const p = await req(MARC, 'GET', '/profile');
    assert.deepEqual(p.rights, { rdp: true, ssh: false, support: false, share: true });
    assert.equal(p.devices.total, 1);
  } finally { await host.close(); }
});

test('no browser access, maintenance, an unreadable credential, the plugin\'s limit and no licence are refused', async () => {
  const { host, adminReq, req, d } = await withDevice();
  try {
    await adminReq('PUT', 'rights/user/' + MARC.id, { rdp: true });
    await adminReq('PUT', 'devices/' + d.id, { config: { browser_enabled: false } });
    assert.equal((await req(MARC, 'POST', '/devices/' + d.id + '/connect')).code, 'no_browser');
    await adminReq('PUT', 'devices/' + d.id, { config: { browser_enabled: true, maintenance_enabled: true, maintenance_schedule: 'Mo-So 00:00-23:59' } });
    const now = new Date();
    if (now.getHours() * 60 + now.getMinutes() < 1439) assert.equal((await req(MARC, 'POST', '/devices/' + d.id + '/connect')).code, 'maintenance');
    await adminReq('PUT', 'devices/' + d.id, { config: { maintenance_enabled: false } });
    // the plugin's own limit of one session per person
    await adminReq('PUT', 'settings', { maxPerUser: 1 });
    const t = await req(MARC, 'POST', '/devices/' + d.id + '/connect');
    await host.remoteOpen(t.session.ref);
    assert.equal((await req(MARC, 'POST', '/devices/' + d.id + '/connect')).code, 'limit');
    await adminReq('PUT', 'settings', { maxPerUser: 0 });
    // the licence ran out: GateControl refuses new sessions, the data stays
    host.license.licensed = false;
    const u = await req(MARC, 'POST', '/devices/' + d.id + '/connect');
    assert.equal(u.status, 403);
    assert.equal(u.code, 'unlicensed');
    assert.match(u.error, /Lizenz/);
    host.license.licensed = true;
    host.remoteUnreadable([...host.remote.vault.keys()][0]);
    assert.equal((await req(MARC, 'POST', '/devices/' + d.id + '/connect')).code, 'credential_unreadable');
    assert.equal((await adminReq('GET', 'devices')).devices.length, 1);
  } finally { await host.close(); }
});

test('administrators connect to every device from the admin page, also view only; a kiosk viewer never', async () => {
  const { host, adminReq, req, d } = await withDevice();
  try {
    await adminReq('PUT', 'devices/' + d.id + '/access', { users: [MARC.id], groups: [] });
    const r = await adminReq('POST', 'devices/' + d.id + '/connect', { mode: 'view' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.session.mode, 'view');
    const kiosk = await host.request({ method: 'GET', path: '/overview', user: { ...MARC, portal: true, loggedIn: true, kiosk: true } });
    assert.equal(kiosk.json.code, 'forbidden');
  } finally { await host.close(); }
});

test('a gateway device connects through its listener, SSH needs the right "SSH nutzen"', async () => {
  const { host, adminReq, req } = await setup();
  try {
    const g = (await adminReq('POST', 'devices', rdpDevice({ config: { host: '192.168.1.20', access_mode: 'gateway', gateway_pool_id: 3, wol_enabled: true, wol_mac_address: 'AA:BB:CC:DD:EE:02' } }))).device;
    const s = (await adminReq('POST', 'devices', { name: 'Pi', protocol: 'ssh', config: { host: '10.8.0.60', browser_enabled: true }, credentials: { username: 'pi', privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----' } })).device;
    await adminReq('PUT', 'rights/user/' + MARC.id, { rdp: true });
    const r = await req(MARC, 'POST', '/devices/' + g.id + '/connect');
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(host.remote.calls.find((c) => c.op === 'session').target, { id: 'dev-' + g.id, name: 'Büro-PC', listener: 'dev-' + g.id, mac: 'AA:BB:CC:DD:EE:02' });
    const w = await req(MARC, 'POST', '/devices/' + g.id + '/wake');
    assert.equal(w.wake.via, 'gateway');
    assert.equal((await req(MARC, 'POST', '/devices/' + s.id + '/connect')).code, 'no_right');
    await adminReq('PUT', 'rights/user/' + MARC.id, { ssh: true });
    const ssh = await req(MARC, 'POST', '/devices/' + s.id + '/connect');
    assert.equal(ssh.session.protocol, 'ssh');
    assert.deepEqual(host.remote.calls.filter((c) => c.op === 'session')[1].options, { browser_clipboard: false });
  } finally { await host.close(); }
});
