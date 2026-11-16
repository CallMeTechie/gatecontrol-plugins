'use strict';

// 1.1 (stage 2, the Windows switch): a PC registers itself from the app, codes, the confirmation at the PC,
// "ohne Code für Berechtigte", the firewall per session, the old apps and the protocol.

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, ADMIN, MARC, SABINE, LEA, BUERO } = require('./helpers');
const support = require('../server/support');
const codes = require('../server/codes');

support.TIMING.waitMs = 1500;
support.TIMING.facadeWaitMs = 1500;
support.TIMING.pollMs = 10;

// Marc's PC (token 801) and Sabine's laptop (token 802), Lea's phone (803)
const DEVICES = [
  { id: '801', userId: MARC.id, name: 'Marc PC', platform: 'windows', vpnIp: '10.8.0.61' },
  { id: '802', userId: SABINE.id, name: 'Sabine Laptop', platform: 'windows', vpnIp: '10.8.0.62' },
  { id: '803', userId: LEA.id, name: 'Lea Handy', platform: 'android', vpnIp: '10.8.0.63' },
];
const PC = { id: '801', platform: 'windows', vpnIp: '10.8.0.61' };
const LAPTOP = { id: '802', platform: 'windows', vpnIp: '10.8.0.62' };
const REG = { name: 'Büro-PC Marc', edition: 'pro', rdp: { available: true, enabled: true, port: 3389 }, osUser: 'marc', appVersion: '1.95.0' };

async function start(o = {}) {
  const s = await setup({ gatecontrol: '1.284.0', host: { devices: DEVICES, ...(o.host || {}) } });
  const app = async (user, dev, method, path, body) => {
    const r = await s.host.request({ method, path, body: body || null, user: { ...user, app: true, portal: true, loggedIn: true, device: dev }, lang: 'de' });
    return { status: r.status || 200, ...r.json };
  };
  return { ...s, app };
}

const signals = (host, type) => host.notifications.filter((n) => n.topic === 'remote_signal' && n.data && (!type || n.data.type === type));
const lastSignal = (host, type) => signals(host, type).slice(-1)[0];

/** Wait for a signal and answer it like the PC's app (the firewall opens). */
async function pcOpens(host, app, user, dev, state = 'open') {
  for (let i = 0; i < 200; i++) {
    const s = lastSignal(host, 'remote.firewall.open');
    if (s && !s.answered) { s.answered = true; return app(user, dev, 'POST', '/host/firewall', { sessionKey: s.data.sessionKey, state }); }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('no firewall signal');
}

test('register: a PC of the app becomes a private device of its owner; Home and no right are refused', async () => {
  const { host, app, adminReq, req } = await start();
  try {
    const r = await app(MARC, PC, 'POST', '/host/register', REG);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.host.shareMode, 'code');
    assert.equal(r.host.state, 'ready');
    assert.equal(r.codeRequired, true);
    const list = (await adminReq('GET', 'devices')).devices;
    const d = list.find((x) => x.id === r.host.deviceId);
    assert.ok(d.id >= 100000);
    assert.equal(d.kind, 'host');
    assert.equal(d.config.host, '10.8.0.61');
    assert.equal(d.config.port, 3389);
    assert.equal(d.host.ownerName, 'Marc');
    assert.equal(d.host.osUser, 'marc');
    assert.equal(d.status.online, true);
    assert.deepEqual(d.access.users, [MARC.id], 'only the owner (and the admins)');
    // the same app again: the same device
    assert.equal((await app(MARC, PC, 'POST', '/host/register', REG)).host.deviceId, r.host.deviceId);
    // Windows Home: no device
    assert.equal((await app(SABINE, LAPTOP, 'POST', '/host/register', { ...REG, edition: 'home' })).code, 'home_edition');
    // without "Eigene Geräte freigeben"
    await adminReq('PUT', 'rights/user/' + SABINE.id, { share: false });
    assert.equal((await app(SABINE, LAPTOP, 'POST', '/host/register', REG)).code, 'no_share_right');
    // the portal: not an app request
    assert.equal((await req(MARC, 'POST', '/host/register', REG)).code, 'forbidden');
    // a live event for the lists
    assert.ok(host.events.some((e) => e.type === 'devices'));
  } finally { await host.close(); }
});

test('heartbeat: state, RDP off in Windows, offline after three missed beats', async () => {
  const { host, app, adminReq } = await start();
  try {
    const { host: h } = await app(MARC, PC, 'POST', '/host/register', REG);
    const beat = await app(MARC, PC, 'POST', '/host/state', { rdp: { enabled: false }, osUser: 'marc', online: true });
    assert.equal(beat.ok, true, JSON.stringify(beat));
    assert.deepEqual(beat.pending, []);
    let d = (await adminReq('GET', 'devices/' + h.deviceId)).device;
    assert.equal(d.host.rdpEnabled, false);
    // another person's app cannot beat for this PC
    assert.equal((await app(SABINE, PC, 'POST', '/host/state', {})).code, 'not_found');
    // three minutes without a beat: offline
    await host.gc.db.run('UPDATE devices SET last_seen = ? WHERE id = ?', [Date.now() - 190000, h.deviceId]);
    d = (await adminReq('GET', 'devices/' + h.deviceId)).device;
    assert.equal(d.status.online, false);
  } finally { await host.close(); }
});

test('code → request → the person at the PC allows → the firewall opens for the hub only → the session; then it closes', async () => {
  const { host, app, req, adminReq } = await start();
  try {
    const { host: h } = await app(MARC, PC, 'POST', '/host/register', REG);
    const c = await app(MARC, PC, 'POST', '/host/code');
    assert.match(c.code, /^\d{3}-\d{3}-\d{3}$/);
    assert.ok(Date.parse(c.expiresAt) - Date.now() <= 10 * 60000);
    // stored as an HMAC only
    const row = (await host.gc.db.get('SELECT * FROM codes WHERE device_id = ?', [h.deviceId])).row;
    assert.equal(JSON.stringify(row).includes(c.code.replace(/-/g, '')), false);
    // Sabine has no right: neither support nor access
    assert.equal((await req(SABINE, 'POST', '/code/redeem', { code: c.code, mode: 'control' })).code, 'no_right');
    // a used code is used: Sabine's attempt consumed it — a new one for the next try
    const c2 = await app(MARC, PC, 'POST', '/host/code');
    await adminReq('PUT', 'rights/user/' + SABINE.id, { support: true });
    assert.equal(await host.portalVisible(SABINE), true, 'the tab for support codes');
    const ov = await req(SABINE, 'GET', '/overview');
    assert.equal(ov.codeEntry, true);
    assert.equal(ov.devices.length, 0, 'she does not see the PC');
    const r = await req(SABINE, 'POST', '/code/redeem', { code: c2.code.replace(/-/g, ' '), mode: 'control' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.request.state, 'waiting');
    // the PC is asked, with name and the mode
    const ask = lastSignal(host, 'remote.request');
    assert.equal(ask.devices[0], '801');
    assert.equal(ask.signal, true);
    assert.equal(ask.silent, true);
    assert.deepEqual([ask.data.requestId, ask.data.from.name, ask.data.mode, ask.data.via], [r.request.id, 'Sabine', 'control', 'browser']);
    // the heartbeat hands it again
    assert.equal((await app(MARC, PC, 'POST', '/host/state', {})).pending[0].requestId, r.request.id);
    // connecting before the answer: no
    assert.equal((await req(SABINE, 'POST', '/requests/' + r.request.id + '/connect')).code, 'request_waiting');
    // the person at the PC grants view only
    const dec = await app(MARC, PC, 'POST', '/host/requests/' + r.request.id, { decision: 'allow', mode: 'view' });
    assert.equal(dec.request.state, 'allowed');
    assert.equal((await req(SABINE, 'GET', '/requests/' + r.request.id)).request.mode, 'view');
    // Sabine connects: the PC opens 3389 for the hub address only
    const conn = req(SABINE, 'POST', '/requests/' + r.request.id + '/connect');
    await pcOpens(host, app, MARC, PC);
    const out = await conn;
    assert.equal(out.ok, true, JSON.stringify(out));
    const open = lastSignal(host, 'remote.firewall.open');
    assert.equal(open.data.allow, '10.8.0.1');
    assert.equal(open.data.port, 3389);
    assert.ok(Date.parse(open.data.until) - Date.now() <= 8 * 3600000 + 1000);
    const call = host.remote.calls.filter((x) => x.op === 'session').slice(-1)[0];
    assert.deepEqual([call.user, call.mode, call.target.host, call.target.port], [SABINE.id, 'view', '10.8.0.61', 3389]);
    // once only
    assert.equal((await req(SABINE, 'POST', '/requests/' + r.request.id + '/connect')).code, 'request_expired');
    // GET host/firewall after a restart of the app: the open rule
    assert.equal((await app(MARC, PC, 'GET', '/host/firewall')).open.length, 1);
    // the session page opens and closes: the rule closes, the ticket ends
    const { sessionId } = await host.remoteOpen(out.session.ref);
    await host.remoteClose(sessionId, 'normal');
    const close = lastSignal(host, 'remote.firewall.close');
    assert.equal(close.data.sessionKey, open.data.sessionKey);
    assert.equal((await app(MARC, PC, 'GET', '/host/firewall')).open.length, 0);
    // the protocol
    const types = (await adminReq('GET', 'sessions/shares')).entries.map((e) => e.type);
    for (const t of ['remote_host_registered', 'remote_code_redeemed', 'remote_request_allowed', 'remote_firewall_open', 'remote_firewall_close']) assert.ok(types.includes(t), t);
    // Marc sees it in his profile
    const prof = await req(MARC, 'GET', '/profile');
    assert.equal(prof.hosts.length, 1);
    assert.ok(prof.history.some((e) => e.type === 'remote_request_allowed'));
  } finally { await host.close(); }
});

test('deny, no answer, no report of the firewall', async () => {
  const { host, app, req, adminReq } = await start();
  try {
    await app(MARC, PC, 'POST', '/host/register', REG);
    await adminReq('PUT', 'rights/user/' + SABINE.id, { support: true });
    let r = await req(SABINE, 'POST', '/code/redeem', { code: (await app(MARC, PC, 'POST', '/host/code')).code });
    await app(MARC, PC, 'POST', '/host/requests/' + r.request.id, { decision: 'deny' });
    assert.equal((await req(SABINE, 'GET', '/requests/' + r.request.id)).request.state, 'denied');
    assert.equal((await app(MARC, PC, 'POST', '/host/requests/' + r.request.id, { decision: 'allow' })).code, 'request_expired');
    // 30 s without an answer
    r = await req(SABINE, 'POST', '/code/redeem', { code: (await app(MARC, PC, 'POST', '/host/code')).code });
    await host.gc.db.run('UPDATE requests SET expires_at = ? WHERE id = ?', [Date.now() - 1, r.request.id]);
    assert.equal((await req(SABINE, 'GET', '/requests/' + r.request.id)).request.state, 'expired');
    // allowed, but the PC never reports the open rule: firewall_timeout, and the rule is closed again
    r = await req(SABINE, 'POST', '/code/redeem', { code: (await app(MARC, PC, 'POST', '/host/code')).code });
    await app(MARC, PC, 'POST', '/host/requests/' + r.request.id, { decision: 'allow' });
    const t = await req(SABINE, 'POST', '/requests/' + r.request.id + '/connect');
    assert.equal(t.code, 'firewall_timeout');
    assert.equal(lastSignal(host, 'remote.firewall.close').data.sessionKey, lastSignal(host, 'remote.firewall.open').data.sessionKey);
    // the PC reports a failed rule
    signals(host, 'remote.firewall.open').forEach((x) => { x.answered = true; });
    r = await req(SABINE, 'POST', '/code/redeem', { code: (await app(MARC, PC, 'POST', '/host/code')).code });
    await app(MARC, PC, 'POST', '/host/requests/' + r.request.id, { decision: 'allow' });
    const f = req(SABINE, 'POST', '/requests/' + r.request.id + '/connect');
    await pcOpens(host, app, MARC, PC, 'failed');
    assert.equal((await f).code, 'firewall_failed');
  } finally { await host.close(); }
});

test('guessing: 5 wrong codes per person → locked; 10 wrong codes on a PC → its code is void', async () => {
  const { host, app, req, adminReq } = await start();
  try {
    const { host: h } = await app(MARC, PC, 'POST', '/host/register', REG);
    await adminReq('PUT', 'rights/user/' + SABINE.id, { support: true });
    await adminReq('PUT', 'rights/user/' + LEA.id, { support: true });
    for (let i = 0; i < 4; i++) assert.equal((await req(SABINE, 'POST', '/code/redeem', { code: '000-000-00' + i })).code, 'code_invalid');
    assert.equal((await req(SABINE, 'POST', '/code/redeem', { code: '000-000-009' })).code, 'code_locked');
    const good = await app(MARC, PC, 'POST', '/host/code');
    assert.equal((await req(SABINE, 'POST', '/code/redeem', { code: good.code })).code, 'code_locked', 'even the right code waits');
    // aimed at the PC (the portal names it): failures count against its code
    await host.gc.db.run('DELETE FROM code_attempts', []);
    await adminReq('PUT', 'rights/user/' + LEA.id, { rdp: true });
    await host.gc.db.run('UPDATE codes SET failures = 9 WHERE device_id = ?', [h.deviceId]);
    assert.equal((await req(LEA, 'POST', '/code/redeem', { code: '111-111-111', deviceId: h.deviceId })).code, 'code_invalid');
    assert.equal((await host.gc.db.get('SELECT * FROM codes WHERE device_id = ?', [h.deviceId])).row, null);
    assert.ok(lastSignal(host, 'remote.code.void'));
    assert.ok((await adminReq('GET', 'sessions/shares')).entries.some((e) => e.type === 'remote_code_failed'));
    assert.equal(codes.digitsOf('482 913 075'), '482913075');
    assert.equal(codes.digitsOf('48291307'), null);
  } finally { await host.close(); }
});

test('"Ohne Code für Berechtigte": direct for people with right and access, never when the admin locks it', async () => {
  const { host, app, req, adminReq } = await start();
  try {
    const { host: h } = await app(MARC, PC, 'POST', '/host/register', REG);
    // Marc shares it with the group Büro (Sabine)
    const acc = await app(MARC, PC, 'PUT', '/host/access', { users: [], groups: [BUERO] });
    assert.deepEqual(acc.access, { users: [MARC.id], groups: [BUERO] }, 'the owner stays');
    await adminReq('PUT', 'rights/group/' + BUERO, { rdp: true });
    let ov = await req(SABINE, 'GET', '/overview');
    assert.deepEqual(ov.devices.map((d) => [d.name, d.connect.mode, d.owner.name]), [['Büro-PC Marc', 'code', 'Marc']]);
    assert.equal(JSON.stringify(ov).includes('10.8.0.61'), false, 'the portal gets no address');
    assert.equal((await req(SABINE, 'POST', '/devices/' + h.deviceId + '/connect')).code, 'code_required');
    assert.equal((await app(MARC, PC, 'PUT', '/host/share', { shareMode: 'open' })).shareMode, 'open');
    ov = await req(SABINE, 'GET', '/overview');
    assert.equal(ov.devices[0].connect.mode, 'open');
    // the browser: no code, no question
    const p = req(SABINE, 'POST', '/devices/' + h.deviceId + '/connect');
    await pcOpens(host, app, MARC, PC);
    const r = await p;
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(r.session.ref);
    assert.equal(signals(host, 'remote.request').length, 0, 'no question at the PC');
    // Sabine's app: the rule for her laptop's VPN address, a connection without credentials
    const p2 = app(SABINE, LAPTOP, 'POST', '/devices/' + h.deviceId + '/connect');
    await pcOpens(host, app, MARC, PC);
    const r2 = await p2;
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.equal(lastSignal(host, 'remote.firewall.open').data.allow, '10.8.0.62');
    assert.deepEqual([r2.connection.host, r2.connection.port, r2.connection.credential_mode], ['10.8.0.61', 3389, 'none']);
    // the administrator locks "ohne Code": back to the code
    await adminReq('POST', 'devices/' + h.deviceId + '/allow-open', { allowOpen: false });
    assert.equal((await req(SABINE, 'POST', '/devices/' + h.deviceId + '/connect')).code, 'code_required');
    assert.equal((await app(MARC, PC, 'PUT', '/host/share', { shareMode: 'open' })).code, 'not_allowed');
    // the administrator, too, needs the code for a PC
    assert.equal((await adminReq('POST', 'devices/' + h.deviceId + '/connect', {})).code, 'code_required');
    // the switch goes off: abgemeldet, rules close, gone from the portal
    const before = signals(host, 'remote.firewall.close').length;
    assert.equal((await app(MARC, PC, 'DELETE', '/host')).removed, true);
    assert.ok(signals(host, 'remote.firewall.close').length > before);
    const d = (await adminReq('GET', 'devices/' + h.deviceId)).device;
    assert.equal(d.host.registered, false);
    assert.equal((await req(SABINE, 'GET', '/overview')).devices.length, 0);
    assert.equal((await app(MARC, PC, 'POST', '/host/code')).code, 'not_found');
  } finally { await host.close(); }
});

test('the old apps: a PC only "ohne Code"; connect opens the rule for the app, sessionEnd closes it; wake / status of the admin API', async () => {
  const { host, app, adminReq } = await start();
  try {
    await host.legacyImport({ schema: 1, dataset: 'remote', exportedAt: new Date().toISOString(), routes: [], sessions: [], maintenance: [] });
    const { host: h } = await app(MARC, PC, 'POST', '/host/register', REG);
    await app(MARC, PC, 'PUT', '/host/access', { users: [SABINE.id], groups: [] });
    await adminReq('PUT', 'rights/user/' + SABINE.id, { rdp: true });
    const U = { id: SABINE.id, tokenId: 802, peerId: 62, scopes: ['client', 'client:rdp'], platform: 'windows', selfIp: '10.8.0.62' };
    assert.deepEqual((await host.clientFacade('list', { user: U })).body.routes, [], 'with a code the old apps cannot ask');
    await app(MARC, PC, 'PUT', '/host/share', { shareMode: 'open' });
    const list = (await host.clientFacade('list', { user: U })).body.routes;
    assert.deepEqual(list.map((x) => [x.id, x.connect_address]), [[h.deviceId, '10.8.0.61']]);
    const p = host.clientFacade('connect', { id: h.deviceId, user: U, query: { ecdhPublicKey: 'K' } });
    await pcOpens(host, app, MARC, PC);
    const c = await p;
    assert.equal(c.status, 200, JSON.stringify(c));
    assert.equal(c.body.connection.host, '10.8.0.61');
    assert.equal(lastSignal(host, 'remote.firewall.open').data.allow, '10.8.0.62');
    assert.equal((await host.clientFacade('browserSession', { id: h.deviceId, user: U })).status, 403);
    await host.clientFacade('sessionStart', { id: h.deviceId, user: U });
    await host.clientFacade('sessionEnd', { id: h.deviceId, user: U, body: { endReason: 'normal' } });
    assert.equal(lastSignal(host, 'remote.firewall.close').data.sessionKey, lastSignal(host, 'remote.firewall.open').data.sessionKey);
    // the admin API the Windows app asks (gc.remote version 2)
    const st = await host.clientFacade('statusAdmin', { id: h.deviceId, user: U });
    assert.deepEqual([st.status, st.body.id, st.body.online], [200, h.deviceId, true]);
    const all = await host.clientFacade('statusAll', { user: U });
    assert.equal(all.body.statuses[h.deviceId].online, true);
    assert.equal((await host.clientFacade('wake', { id: h.deviceId, user: U })).status, 400, 'no wake-on-LAN for this PC');
  } finally { await host.close(); }
});

test('an app helper: redeem in the app, the rule for exactly the helper\'s device (peerAddress)', async () => {
  const { host, app, adminReq } = await start();
  try {
    await app(MARC, PC, 'POST', '/host/register', REG);
    await adminReq('PUT', 'rights/user/' + SABINE.id, { support: true });
    const r = await app(SABINE, LAPTOP, 'POST', '/code/redeem', { code: (await app(MARC, PC, 'POST', '/host/code')).code, mode: 'control' });
    assert.equal(r.request.via, 'app');
    assert.equal((await app(SABINE, LAPTOP, 'POST', '/code/redeem', { code: '1', mode: 'view' })).code, 'code_invalid');
    await app(MARC, PC, 'POST', '/host/requests/' + r.request.id, { decision: 'allow' });
    const p = app(SABINE, LAPTOP, 'POST', '/requests/' + r.request.id + '/connect');
    await pcOpens(host, app, MARC, PC);
    const c = await p;
    assert.equal(c.ok, true, JSON.stringify(c));
    assert.equal(lastSignal(host, 'remote.firewall.open').data.allow, '10.8.0.62');
    assert.ok(host.remote.calls.some((x) => x.op === 'peerAddress' && x.userId === SABINE.id && x.deviceId === '802'));
    // the GET devices of the apps
    const mine = await app(SABINE, LAPTOP, 'GET', '/devices');
    assert.equal(mine.codeEntry, true);
  } finally { await host.close(); }
});

test('admin: a PC shows owner and state; deleting it ends everything', async () => {
  const { host, app, adminReq } = await start();
  try {
    const { host: h } = await app(MARC, PC, 'POST', '/host/register', REG);
    await app(MARC, PC, 'POST', '/host/code');
    // the admin may rename it, never move it
    const saved = await adminReq('PUT', 'devices/' + h.deviceId, { name: 'Marcs PC', config: { host: '10.9.9.9' } });
    assert.equal(saved.device.name, 'Marcs PC');
    assert.equal(saved.device.config.host, '10.8.0.61');
    assert.equal((await adminReq('POST', 'devices/' + h.deviceId + '/check')).status.online, true);
    assert.equal((await adminReq('DELETE', 'devices/' + h.deviceId)).removed, true);
    assert.equal((await host.gc.db.get('SELECT * FROM codes WHERE device_id = ?', [h.deviceId])).row, null);
    // the app registers again: a new device
    const again = await app(MARC, PC, 'POST', '/host/register', REG);
    assert.equal(again.ok, true);
    assert.deepEqual((await adminReq('GET', 'devices/' + again.host.deviceId)).device.access.users, [MARC.id]);
    void ADMIN;
  } finally { await host.close(); }
});
