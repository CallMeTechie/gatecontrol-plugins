'use strict';

// 1.8 (gc.remote version 9): „Schlüssel automatisch einrichten“ (host key first, the password never stored), the refused
// login on the card, way and auth of the list, closing tmux sessions and windows (portal, apps, admin page), codes for the
// Linux agent from the admin page with the live state, and „Mit Agent verbinden“ (the agent takes a device made by hand over).

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, ADMIN, MARC, SABINE } = require('./helpers');

const AGENT = { id: '901', platform: 'linux', vpnIp: '10.8.0.53' };
const KEY = { alg: 'ssh-ed25519', sha256: 'k9QwJ4nV0kR4o2dQ8m1VZ7mWJkQw6m8bK2a3x5Y7z1A' };
const REG = { platform: 'linux', name: 'appserver', appVersion: '1.0.0', os: { id: 'debian' },
  ssh: { offered: true, user: 'kim', port: 22, tmux: { available: true, version: '3.4' }, hostKey: KEY } };

async function start(remote = {}, x = {}) {
  const s = await setup({ gatecontrol: '1.288.0', remote: { v9: true, candidates: { vpn: { subnet: '10.8.0.0/24' }, peers: [] }, ...remote },
    host: { devices: [{ id: '901', userId: x.agentOwner || ADMIN.id, name: 'appserver', platform: 'linux', vpnIp: '10.8.0.53' }] } });
  const app = async (user, dev, method, path, body) => {
    const r = await s.host.request({ method, path, body: body || null, user: { ...user, app: true, portal: true, loggedIn: true, device: dev }, lang: 'de' });
    return { status: r.status || 200, ...r.json };
  };
  return { ...s, app };
}

const sshDevice = (x = {}) => ({ name: 'appserver', protocol: 'ssh', config: { host: '10.8.0.50', port: 22, ssh_engine: 'term', ...(x.config || {}) },
  credentials: { username: 'kim', password: 'falsch' }, ...(x.top || {}) });

test('key set-up: the host key first, then GateControl\'s key — the password is never stored or passed on', async () => {
  const { host, adminReq } = await start();
  try {
    const d = (await adminReq('POST', 'devices', sshDevice())).device;
    assert.equal(d.auth, 'password');
    assert.equal(d.way, 'vpn');
    const f = (await adminReq('GET', 'devices')).features;
    assert.deepEqual([f.keySetup, f.tmuxKill, f.enroll], [true, true, true]);
    const scan = (await adminReq('POST', 'devices/' + d.id + '/hostkey-scan')).hostKey;
    assert.equal(scan.pinned, false);
    assert.match(scan.sha256, /^[A-Za-z0-9+/]{43}$/);
    // without the confirmation of the fingerprint nothing is sent
    const un = await adminReq('POST', 'devices/' + d.id + '/install-key', { username: 'kim', password: 'Geheim-123', account: 'self' });
    assert.equal(un.code, 'host_key_unpinned');
    assert.equal(un.step, 'hostkey');
    assert.equal(un.attemptsLeft, 4);
    const wrong = await adminReq('POST', 'devices/' + d.id + '/install-key', { username: 'kim', password: 'Geheim-123', confirm: 'A'.repeat(43) });
    assert.equal(wrong.code, 'host_key_rejected');
    const ok = await adminReq('POST', 'devices/' + d.id + '/install-key', { username: 'kim', password: 'Geheim-123', account: 'self', confirm: scan.sha256, restrictFrom: true });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(ok.result.ok, true);
    assert.deepEqual(ok.result.steps.map((s) => s.id + ':' + s.state), ['connect:done', 'hostkey:done', 'install:done', 'test:done']);
    assert.equal(ok.result.account, 'kim');
    assert.equal(ok.result.path, '/home/kim/.ssh/authorized_keys');
    assert.deepEqual(ok.result.from, ['10.8.0.1']);
    assert.equal(ok.device.auth, 'gc_key');
    assert.equal(ok.device.key.account, 'kim');
    assert.equal(ok.device.key.installedBy, ADMIN.id);
    assert.equal(ok.device.key.installedByName, 'Admin');
    assert.equal(ok.device.credential.has.password, false, 'the old password is gone from the vault');
    assert.equal(ok.device.credential.has.privateKey, true);
    assert.match(ok.device.ssh.line, /^from="10\.8\.0\.1",no-agent-forwarding,no-X11-forwarding,no-port-forwarding ssh-ed25519 \S+ gatecontrol:dev-\d+$/);
    assert.ok(!JSON.stringify(host.remote.calls).includes('Geheim-123'), 'the password is not in the calls of the host');
    const pins = await host.gc.remote.hostKeys.list();
    assert.ok(pins.some((p) => p.targetId === 'dev-' + d.id && p.sha256 === scan.sha256 && p.source === 'confirmed'));
    const logs = (await adminReq('GET', 'sessions/shares')).entries;
    assert.ok(logs.some((e) => e.type === 'remote_key_installed' && e.details.account === 'kim' && e.details.sudo === false));
    assert.ok(logs.some((e) => e.type === 'remote_key_install_failed' && e.details.code === 'host_key_unpinned'));
    assert.ok(!JSON.stringify(logs).includes('Geheim-123'));
    // removed again: the own line on the device and the key in the vault
    const rm = await adminReq('DELETE', 'devices/' + d.id + '/key');
    assert.equal(rm.removedRemote, true);
    assert.equal(rm.device.key, null);
    assert.equal(rm.device.credential.has.privateKey, false);
    assert.ok((await adminReq('GET', 'sessions/shares')).entries.some((e) => e.type === 'remote_key_removed' && e.details.removedRemote === true));
  } finally { await host.close(); }
});

test('key set-up: errors name their step and the attempts left; root through sudo; at most 5 attempts in 10 minutes', async () => {
  let next = 'auth_failed';
  const { host, adminReq } = await start({ installKey: () => next });
  try {
    const d = (await adminReq('POST', 'devices', sshDevice())).device;
    const sha = (await adminReq('POST', 'devices/' + d.id + '/hostkey-scan')).hostKey.sha256;
    const a = await adminReq('POST', 'devices/' + d.id + '/install-key', { username: 'kim', password: 'x1', confirm: sha });
    assert.deepEqual([a.status, a.code, a.step, a.attemptsLeft], [502, 'auth_failed', 'connect', 4]);
    next = 'sudo_password';
    const b = await adminReq('POST', 'devices/' + d.id + '/install-key', { username: 'kim', password: 'x2', confirm: sha, account: 'root' });
    assert.deepEqual([b.code, b.step], ['sudo_password', 'install']);
    next = 'password_auth_off';
    assert.equal((await adminReq('POST', 'devices/' + d.id + '/install-key', { username: 'kim', password: 'x3', confirm: sha })).code, 'password_auth_off');
    next = null;
    const c = await adminReq('POST', 'devices/' + d.id + '/install-key', { username: 'kim', password: 'x4', confirm: sha, account: 'root', sudoPassword: 'rootpw' });
    assert.equal(c.result.account, 'root');
    assert.equal(c.result.path, '/root/.ssh/authorized_keys');
    assert.equal(c.device.key.sudo, true);
    assert.equal(host.remote.calls.filter((x) => x.op === 'installKey').slice(-1)[0].sudo, true);
    next = 'auth_failed';
    for (let i = 0; i < 5; i++) await adminReq('POST', 'devices/' + d.id + '/install-key', { username: 'kim', password: 'x' + i, confirm: sha });
    assert.equal((await adminReq('POST', 'devices/' + d.id + '/install-key', { username: 'kim', password: 'y', confirm: sha })).code, 'rate_limited');
    // checked before anything is sent
    assert.equal((await adminReq('POST', 'devices/' + d.id + '/install-key', { username: 'kim' })).field, 'password');
    // an RDP device has no key
    const rdp = (await adminReq('POST', 'devices', { name: 'pc', protocol: 'rdp', config: { host: '10.8.0.44' } })).device;
    assert.equal((await adminReq('POST', 'devices/' + rdp.id + '/hostkey-scan')).code, 'invalid');
  } finally { await host.close(); }
});

test('the card: a refused login (auth_failed) and the way of each device', async () => {
  const { host, adminReq } = await start();
  try {
    const d = (await adminReq('POST', 'devices', sshDevice())).device;
    const t = (await adminReq('POST', 'devices/' + d.id + '/connect', {})).session;
    await host.remoteAbortTerm(t.ref, 'auth_failed');
    let v = (await adminReq('GET', 'devices')).devices.find((x) => x.id === d.id);
    assert.equal(v.auth, 'failed');
    assert.equal(v.lastAuthFailed.userId, ADMIN.id);
    assert.equal(v.lastAuthFailed.userName, 'Admin');
    // a login that works takes the hint away
    const t2 = (await adminReq('POST', 'devices/' + d.id + '/connect', {})).session;
    await host.remoteOpen(t2.ref);
    v = (await adminReq('GET', 'devices')).devices.find((x) => x.id === d.id);
    assert.equal(v.auth, 'password');
    assert.equal(v.lastAuthFailed, null);
    const gw = (await adminReq('POST', 'devices', { name: 'nas', protocol: 'ssh', config: { host: '192.168.2.20', port: 22, access_mode: 'gateway', gateway_peer_id: 7 } })).device;
    const lan = (await adminReq('POST', 'devices', { name: 'lan', protocol: 'rdp', config: { host: '192.168.5.9', port: 3389 } })).device;
    const net = (await adminReq('POST', 'devices', { name: 'vps', protocol: 'ssh', config: { host: '10.8.0.9', access_mode: 'external', external_hostname: 'vps.example.org', external_port: 22 } })).device;
    assert.deepEqual([gw.way, lan.way, net.way, gw.auth], ['home', 'server', 'net', null]);
  } finally { await host.close(); }
});

const TMUX = { 'dev-100000': [
  { name: 'gc-appserver', attached: 0, created: 1763380000, win: [{ name: 'bash', command: 'bash' }, { name: 'logs', command: 'journalctl' }, { name: 'htop', command: 'htop' }] },
  { name: 'backup', attached: 1, created: 1763390000, win: [{ name: 'rsync', command: 'rsync' }] },
  { name: 'kims build', attached: 0, created: 1763200000, win: [{ name: 'make', command: 'make' }, { name: 'bash', command: 'bash' }] },
] };

test('tmux: windows in the list, close a window, a session, every detached one — whoever may connect', async () => {
  const { host, req, adminReq } = await start({ tmux: TMUX });
  try {
    const d = (await adminReq('POST', 'devices', sshDevice({ top: { name: 'appserver' }, config: { tmux_enabled: true } }))).device;
    assert.equal(d.id, 100000);
    assert.equal((await req(SABINE, 'GET', '/devices/' + d.id + '/tmux', null, { query: { windows: '1' } })).code, 'no_right');
    await adminReq('PUT', 'rights/user/' + MARC.id, { ssh: true });
    const l = await req(MARC, 'GET', '/devices/' + d.id + '/tmux', null, { query: { windows: '1' } });
    assert.equal(l.kill, true);
    assert.deepEqual(l.sessions.map((s) => [s.id, s.name, s.windows, s.attachable]), [['$1', 'gc-appserver', 3, true], ['$2', 'backup', 1, true], ['$3', 'kims build', 2, false]]);
    assert.deepEqual(l.sessions[0].windowList.map((w) => [w.id, w.index, w.name, w.command, w.active]), [['@1', 0, 'bash', 'bash', true], ['@2', 1, 'logs', 'journalctl', false], ['@3', 2, 'htop', 'htop', false]]);
    // without windows=1 the old answer (apps before 1.8)
    assert.equal((await req(MARC, 'GET', '/devices/' + d.id + '/tmux')).sessions[0].windowList, undefined);
    const w = await req(MARC, 'POST', '/devices/' + d.id + '/tmux/kill', { session: { id: '$1', name: 'gc-appserver', created: 1763380000 }, window: { id: '@3', index: 2 } });
    assert.equal(w.killed, 'window');
    assert.equal(w.sessions[0].windows, 2);
    // the number points to another session now: nothing is closed
    assert.equal((await req(MARC, 'POST', '/devices/' + d.id + '/tmux/kill', { session: { id: '$1', name: 'anders', created: 1763380000 } })).code, 'tmux_changed');
    assert.equal((await req(MARC, 'POST', '/devices/' + d.id + '/tmux/kill', { session: { id: '$9', name: 'weg' } })).code, 'tmux_gone');
    assert.equal((await req(MARC, 'POST', '/devices/' + d.id + '/tmux/kill', { session: { id: 'gc-appserver' } })).field, 'session');
    // every detached one: an attached session is never closed
    const all = await req(MARC, 'POST', '/devices/' + d.id + '/tmux/kill-detached', { sessions: [{ id: '$1', name: 'gc-appserver', created: 1763380000 }, { id: '$2', name: 'backup' }, { id: '$3', name: 'kims build' }] });
    assert.deepEqual(all.killed, ['$1', '$3']);
    assert.deepEqual(all.skipped, [{ id: '$2', reason: 'attached' }]);
    assert.deepEqual(all.sessions.map((s) => s.name), ['backup']);
    // the administrator through the admin page
    const a = await adminReq('POST', 'devices/' + d.id + '/tmux/kill', { session: { id: '$2', name: 'backup' } });
    assert.equal(a.killed, 'session');
    assert.equal((await adminReq('GET', 'devices/' + d.id + '/tmux')).sessions.length, 0);
    const logs = (await adminReq('GET', 'sessions/shares')).entries.filter((e) => e.type === 'remote_tmux_killed');
    assert.equal(logs.length, 4);
    assert.ok(logs.some((e) => e.details.session === 'backup' && e.details.attached === true && e.details.admin === true));
    assert.ok(logs.some((e) => e.details.window === '2:htop' && e.userId === MARC.id));
  } finally { await host.close(); }
});

test('without version 9: no windows, no closing, no codes — „SSH-Schlüssel erzeugen“ as before', async () => {
  const s = await setup({ gatecontrol: '1.288.0', remote: { v7: true, tmux: { 'dev-100000': [{ name: 'gc-appserver' }] } } });
  try {
    const d = (await s.adminReq('POST', 'devices', sshDevice({ config: { tmux_enabled: true } }))).device;
    const f = (await s.adminReq('GET', 'devices')).features;
    assert.deepEqual([f.keySetup, f.tmuxKill, f.enroll], [false, false, false]);
    const l = await s.adminReq('GET', 'devices/' + d.id + '/tmux');
    assert.equal(l.kill, false);
    assert.equal(l.sessions[0].windowList, undefined);
    assert.equal((await s.adminReq('POST', 'devices/' + d.id + '/tmux/kill', { session: { id: '$1' } })).code, 'offline');
    assert.equal((await s.adminReq('POST', 'devices/' + d.id + '/install-key', { username: 'kim', password: 'x' })).code, 'offline');
    assert.equal((await s.adminReq('POST', 'enroll', { name: 'nas', ssh: { user: 'kim' } })).code, 'enroll_unavailable');
    assert.deepEqual((await s.adminReq('GET', 'enroll')).enrollments, []);
    const k = await s.adminReq('POST', 'devices/' + d.id + '/key', { username: 'kim' });
    assert.match(k.publicKey, /^ssh-ed25519 /);
    assert.match(k.line, /^from="10\.8\.0\.1",no-agent-forwarding/);
  } finally { await s.host.close(); }
});

test('a code for the agent: the command, the live state in four steps, the placeholder, „Neuer Code“', async () => {
  const { host, adminReq, app } = await start();
  try {
    assert.equal((await adminReq('POST', 'enroll', { name: 'nas-keller', ssh: { user: 'root' } })).field, 'ssh.user');
    assert.equal((await adminReq('POST', 'enroll', { name: 'nas-keller' })).field, 'ssh');
    const e = (await adminReq('POST', 'enroll', { name: 'nas-keller', ssh: { user: 'kim', tmux: true, install: true }, open: true })).enrollment;
    assert.equal(e.state, 'waiting');
    assert.equal(e.ownerId, ADMIN.id);
    assert.match(e.code, /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
    assert.equal(e.command, `sudo gatecontrol-agent enroll https://gate.example.test ${e.code} --name nas-keller\nsudo gatecontrol-agent share ssh --as kim --tmux --install-tmux\nsudo gatecontrol-agent share open`);
    assert.ok(e.steps.created && !e.steps.redeemed);
    // the options change, the code stays
    const u = (await adminReq('PUT', 'enroll/' + e.ticket, { open: false, ssh: { user: 'kim', tmux: false } })).enrollment;
    assert.equal(u.code, e.code);
    assert.equal(u.command, `sudo gatecontrol-agent enroll https://gate.example.test ${e.code} --name nas-keller\nsudo gatecontrol-agent share ssh --as kim`);
    assert.deepEqual((await adminReq('GET', 'enroll')).enrollments.map((x) => x.ticket), [e.ticket]);
    host.remoteEnrollRedeem(e.ticket, { tokenDeviceId: '901', vpnIp: '10.8.0.53' });
    let g = (await adminReq('GET', 'enroll/' + e.ticket)).enrollment;
    assert.equal(g.state, 'redeemed');
    assert.equal(g.code, null, 'a redeemed code is not shown any more');
    assert.ok(g.steps.redeemed && !g.steps.vpn);
    host.remoteEnrollHandshake(e.ticket);
    g = (await adminReq('GET', 'enroll/' + e.ticket)).enrollment;
    assert.ok(g.steps.vpn && !g.steps.registered);
    const r = await app(ADMIN, AGENT, 'POST', '/host/register', { ...REG, name: 'nas-keller' });
    assert.equal(r.ok, true, JSON.stringify(r));
    g = (await adminReq('GET', 'enroll/' + e.ticket)).enrollment;
    assert.equal(g.state, 'registered');
    assert.equal(g.deviceId, r.host.deviceId);
    assert.equal(g.device.ssh.user, 'kim');
    assert.equal(g.device.vpnIp, '10.8.0.53');
    assert.deepEqual((await adminReq('GET', 'enroll')).enrollments, [], 'no placeholder once registered');
    // „Neuer Code“: the old ticket is revoked
    const a = (await adminReq('POST', 'enroll', { name: 'pi', ssh: { user: 'pi' } })).enrollment;
    const b = (await adminReq('POST', 'enroll', { name: 'pi', ssh: { user: 'pi' }, replaces: a.ticket })).enrollment;
    assert.notEqual(a.code, b.code);
    assert.equal((await host.gc.remote.enrollment.status(a.ticket)).state, 'revoked');
    assert.equal((await adminReq('GET', 'enroll/' + a.ticket)).code, 'not_found');
    assert.equal((await adminReq('DELETE', 'enroll/' + b.ticket)).removed, true);
    assert.ok((await adminReq('GET', 'sessions/shares')).entries.some((x) => x.type === 'remote_enroll_created'));
    // only administrators
    assert.equal((await adminReq('POST', 'enroll', { name: 'x', ssh: { user: 'kim' }, ownerId: 99 })).field, 'ownerId');
  } finally { await host.close(); }
});

test('„Mit Agent verbinden“: the agent takes the device made by hand over — same id, name, rights; password and listener go', async () => {
  const { host, adminReq, app } = await start({}, { agentOwner: ADMIN.id });
  try {
    const d = (await adminReq('POST', 'devices', sshDevice({ config: { host: '192.168.2.50', access_mode: 'gateway', gateway_peer_id: 7, tmux_name: 'werkbank' } }))).device;
    await adminReq('PUT', 'devices/' + d.id + '/access', { users: [MARC.id], groups: [] });
    await host.gc.remote.hostKeys.pin({ targetId: 'dev-' + d.id, alg: KEY.alg, sha256: KEY.sha256 });
    const oldCred = (await host.gc.remote.vault.list()).length;
    assert.equal(oldCred, 1);
    const e = (await adminReq('POST', 'enroll', { name: 'appserver', ssh: { user: 'kim' }, adoptDeviceId: d.id })).enrollment;
    assert.equal(e.adoptDeviceId, d.id);
    host.remoteEnrollRedeem(e.ticket, { tokenDeviceId: '901' });
    const r = await app(ADMIN, AGENT, 'POST', '/host/register', REG);
    assert.equal(r.host.deviceId, d.id, 'the agent registers as the old device');
    const all = (await adminReq('GET', 'devices')).devices;
    assert.equal(all.length, 1);
    const v = all[0];
    assert.deepEqual([v.id, v.name, v.kind, v.host.platform, v.way, v.auth, v.config.host, v.config.access_mode, v.config.tmux_name, v.listener],
      [d.id, 'appserver', 'host', 'linux', 'agent', 'agent', '10.8.0.53', 'internal', 'werkbank', null]);
    assert.ok(v.access.users.includes(MARC.id) && v.access.users.includes(ADMIN.id));
    assert.equal(v.config.agent_previous.config.access_mode, 'gateway');
    assert.ok(!(await host.gc.remote.vault.list()).some((x) => x.has.password), 'the old password is gone');
    assert.equal(host.remote.listeners.size, 0);
    assert.equal((await adminReq('GET', 'enroll/' + e.ticket)).enrollment.state, 'registered');
    assert.ok((await adminReq('GET', 'sessions/shares')).entries.some((x) => x.type === 'remote_agent_adopted' && x.deviceId === d.id));
  } finally { await host.close(); }
});

test('„Mit Agent verbinden“ with another host key: two devices until the administrator decides', async () => {
  const { host, adminReq, app } = await start();
  try {
    const d = (await adminReq('POST', 'devices', sshDevice())).device;
    await host.gc.remote.hostKeys.pin({ targetId: 'dev-' + d.id, alg: 'ssh-ed25519', sha256: 'Z'.repeat(43) });
    const e = (await adminReq('POST', 'enroll', { name: 'appserver', ssh: { user: 'kim' }, adoptDeviceId: d.id })).enrollment;
    host.remoteEnrollRedeem(e.ticket, { tokenDeviceId: '901' });
    const r = await app(ADMIN, AGENT, 'POST', '/host/register', REG);
    assert.notEqual(r.host.deviceId, d.id);
    const c = (await adminReq('GET', 'enroll/' + e.ticket)).enrollment;
    assert.equal(c.state, 'conflict');
    assert.deepEqual([c.conflict.pinned.sha256, c.conflict.agent.sha256], ['Z'.repeat(43), KEY.sha256]);
    assert.equal((await adminReq('GET', 'devices')).devices.length, 2);
    const m = (await adminReq('POST', 'enroll/' + e.ticket + '/merge')).enrollment;
    assert.equal(m.state, 'registered');
    const all = (await adminReq('GET', 'devices')).devices;
    assert.deepEqual(all.map((x) => [x.id, x.kind]), [[d.id, 'host']]);
    const pins = await host.gc.remote.hostKeys.list();
    assert.ok(pins.some((p) => p.targetId === 'dev-' + d.id && p.sha256 === KEY.sha256));
    assert.ok(!pins.some((p) => p.targetId === 'dev-' + r.host.deviceId));
  } finally { await host.close(); }
});

test('key set-up: an own key is only replaced when asked; the copy way is tested with the key alone', async () => {
  let testCode = null;
  const { host, adminReq } = await start({ testKey: () => testCode });
  try {
    const d = (await adminReq('POST', 'devices', { name: 'vps', protocol: 'ssh', config: { host: '10.8.0.60', ssh_engine: 'term' },
      credentials: { username: 'kim', privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\neigen\n-----END OPENSSH PRIVATE KEY-----\n' } })).device;
    assert.equal(d.auth, 'own_key');
    const one = (await adminReq('GET', 'devices/' + d.id)).device;
    assert.equal(one.ssh.ownKey, true);
    const sha = (await adminReq('POST', 'devices/' + d.id + '/hostkey-scan')).hostKey.sha256;
    assert.equal((await adminReq('POST', 'devices/' + d.id + '/install-key', { username: 'kim', password: 'pw', confirm: sha })).code, 'own_key');
    const ok = await adminReq('POST', 'devices/' + d.id + '/install-key', { username: 'kim', password: 'pw', confirm: sha, replaceOwnKey: true, clearPassword: false });
    assert.equal(ok.result.ok, true, JSON.stringify(ok));
    assert.equal(host.remote.calls.filter((x) => x.op === 'installKey').slice(-1)[0].keepPassword, true);
    assert.equal(ok.device.auth, 'gc_key');
    const t = await adminReq('POST', 'devices/' + d.id + '/test-key');
    assert.equal(t.result.ok, true);
    testCode = 'key_test_failed';
    const f = await adminReq('POST', 'devices/' + d.id + '/test-key');
    assert.deepEqual([f.result.ok, f.result.error.code], [false, 'key_test_failed']);
  } finally { await host.close(); }
});

test('key set-up: password login off — the line for the copy way comes back, the key is in the vault, the password stays', async () => {
  const { host, adminReq } = await start({ installKey: () => 'password_auth_off' });
  try {
    const d = (await adminReq('POST', 'devices', sshDevice())).device;
    const sha = (await adminReq('POST', 'devices/' + d.id + '/hostkey-scan')).hostKey.sha256;
    const r = await adminReq('POST', 'devices/' + d.id + '/install-key', { username: 'kim', password: 'pw', confirm: sha });
    assert.equal(r.code, 'password_auth_off');
    assert.match(r.line, /^from="10\.8\.0\.1",no-agent-forwarding,no-X11-forwarding,no-port-forwarding ssh-ed25519 \S+ gatecontrol:dev-\d+$/);
    assert.equal(r.fromGuessed, true);
    const v = (await adminReq('GET', 'devices/' + d.id)).device;
    assert.equal(v.credential.has.privateKey, true);
    assert.equal(v.credential.has.password, true);
    // the key made by hand carries the comment GateControl finds its line by
    const k = await adminReq('POST', 'devices/' + d.id + '/key', { username: 'kim' });
    assert.match(k.publicKey, / gatecontrol:dev-\d+$/);
  } finally { await host.close(); }
});
