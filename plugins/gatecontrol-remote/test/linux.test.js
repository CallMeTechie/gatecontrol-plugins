'use strict';

// 1.6 (stage 4): Linux devices of the agent gatecontrol-agent — host/register with platform linux, GateControl's SSH key
// for authorized_keys, the pinned host key, SSH and the desktop with a code (kind ssh | desktop), "ohne Code", the heartbeat.

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, ADMIN, MARC, SABINE } = require('./helpers');
const support = require('../server/support');

support.TIMING.waitMs = 1500;
support.TIMING.pollMs = 10;

const DEVICES = [{ id: '901', userId: MARC.id, name: 'Marc Pi', platform: 'linux', vpnIp: '10.8.0.71' }];
const PI = { id: '901', platform: 'linux', vpnIp: '10.8.0.71' };
const KEY = { alg: 'ssh-ed25519', sha256: 'k9QwJ4nV0kR4o2dQ8m1VZ7mWJkQw6m8bK2a3x5Y7z1A' };
const REG = {
  platform: 'linux', name: 'pi-garten', appVersion: '1.0.0', os: { id: 'raspbian', version: '12', arch: 'arm64' },
  ssh: { offered: true, user: 'pi', port: 22, tmux: { available: true, version: '3.3a' }, hostKey: KEY },
  desktop: { offered: true, kind: 'wayvnc', protocol: 'vnc', port: 5900, ready: true, session: 'wayland' },
};

async function start() {
  const s = await setup({ gatecontrol: '1.288.0', host: { devices: DEVICES } });
  const app = async (user, dev, method, path, body) => {
    const r = await s.host.request({ method, path, body: body || null, user: { ...user, app: true, portal: true, loggedIn: true, device: dev }, lang: 'de' });
    return { status: r.status || 200, ...r.json };
  };
  return { ...s, app };
}

const signals = (host, type) => host.notifications.filter((n) => n.topic === 'remote_signal' && n.data && (!type || n.data.type === type));
const lastSignal = (host, type) => signals(host, type).slice(-1)[0];

test('register: a Linux device gets GateControl\'s SSH key, its host key is pinned, it is private to its owner', async () => {
  const { host, app, adminReq, req } = await start();
  try {
    const r = await app(MARC, PI, 'POST', '/host/register', REG);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.host.platform, 'linux');
    assert.equal(r.host.state, 'ready');
    assert.equal(r.codeRequired, true);
    assert.match(r.host.ssh.publicKey, /^ssh-ed25519 /);
    assert.equal(r.host.ssh.from, '10.8.0.1');
    assert.equal(r.host.ssh.user, 'pi');
    assert.deepEqual(r.host.desktop, { offered: true, protocol: 'vnc', port: 5900 });
    const pins = await host.gc.remote.hostKeys.list();
    assert.ok(pins.some((p) => p.targetId === 'dev-' + r.host.deviceId && p.sha256 === KEY.sha256 && p.alg === KEY.alg));
    const d = (await adminReq('GET', 'devices')).devices.find((x) => x.id === r.host.deviceId);
    assert.equal(d.protocol, 'ssh');
    assert.equal(d.config.host, '10.8.0.71');
    assert.equal(d.config.port, 22);
    assert.equal(d.config.ssh_engine, 'term');
    assert.equal(d.config.tmux_enabled, true);
    assert.equal(d.credential.set, true);
    assert.equal(d.host.platform, 'linux');
    assert.deepEqual(d.host.ssh, { offered: true, user: 'pi', tmux: true, tmuxVersion: '3.3a' });
    assert.equal(d.host.desktop.kind, 'wayvnc');
    // the same key again: registering once more keeps the key (authorized_keys stays valid)
    const again = await app(MARC, PI, 'POST', '/host/register', REG);
    assert.equal(again.host.ssh.publicKey, r.host.ssh.publicKey);
    // another account: a new key
    const other = await app(MARC, PI, 'POST', '/host/register', { ...REG, ssh: { ...REG.ssh, user: 'marc' } });
    assert.notEqual(other.host.ssh.publicKey, r.host.ssh.publicKey);
    // Sabine does not see Marc's device; Marc with the right "SSH nutzen" does (in the portal: platform, SSH, desktop)
    assert.equal((await req(SABINE, 'GET', '/overview')).devices.length, 0);
    await adminReq('PUT', 'rights/user/' + MARC.id, { ssh: true });
    const mine = (await req(MARC, 'GET', '/overview')).devices;
    assert.equal(mine.length, 1);
    assert.equal(mine[0].platform, 'linux');
    assert.deepEqual(mine[0].ssh, { offered: true, tmux: true });
    assert.equal(mine[0].desktop.protocol, 'vnc');
    assert.equal(mine[0].rdp, undefined);
  } finally { await host.close(); }
});

test('register: what the agent reports is checked', async () => {
  const { host, app } = await start();
  try {
    assert.equal((await app(MARC, PI, 'POST', '/host/register', { ...REG, ssh: { ...REG.ssh, user: 'root' } })).code, 'invalid');
    assert.equal((await app(MARC, PI, 'POST', '/host/register', { ...REG, ssh: { ...REG.ssh, hostKey: { alg: 'ssh-ed25519', sha256: 'x' } } })).code, 'host_key_invalid');
    assert.equal((await app(MARC, PI, 'POST', '/host/register', { ...REG, desktop: { ...REG.desktop, port: 22 } })).code, 'invalid');
    assert.equal((await app(MARC, PI, 'POST', '/host/register', { ...REG, ssh: { offered: false }, desktop: { offered: false } })).code, 'invalid');
    assert.equal((await app(MARC, { ...PI, vpnIp: null }, 'POST', '/host/register', REG)).code, 'no_vpn');
  } finally { await host.close(); }
});

test('SSH with a code: the agent allows, the helper gets GateControl\'s terminal (without access of their own), the code is void', async () => {
  const { host, app, req, adminReq } = await start();
  try {
    await app(MARC, PI, 'POST', '/host/register', REG);
    await adminReq('PUT', 'rights/user/' + SABINE.id, { support: true });
    const c = await app(MARC, PI, 'POST', '/host/code');
    const r = await req(SABINE, 'POST', '/code/redeem', { code: c.code, mode: 'view', kind: 'ssh' });
    assert.equal(r.request.kind, 'ssh');
    assert.equal(r.request.mode, 'control', 'the terminal is always typed in');
    const s = lastSignal(host, 'remote.request');
    assert.equal(s.data.kind, 'ssh');
    assert.equal(s.data.from.name, 'Sabine');
    await app(MARC, PI, 'POST', '/host/requests/' + r.request.id, { decision: 'allow', mode: 'control' });
    const t = await req(SABINE, 'POST', '/requests/' + r.request.id + '/connect', {});
    assert.equal(t.ok, true, JSON.stringify(t));
    assert.equal(t.session.engine, 'term');
    assert.deepEqual(t.session.tmux, { create: 'gc-pi-garten' });
    assert.ok(lastSignal(host, 'remote.code.void'), 'the agent shows a new code');
    // no firewall for SSH (it comes from the hub)
    assert.equal(signals(host, 'remote.firewall.open').length, 0);
    // SSH switched off at the device: a request for SSH is refused
    await app(MARC, PI, 'POST', '/host/register', { ...REG, ssh: { offered: false } });
    const c2 = await app(MARC, PI, 'POST', '/host/code');
    assert.equal((await req(SABINE, 'POST', '/code/redeem', { code: c2.code, kind: 'ssh' })).code, 'ssh_off');
    assert.equal((await req(ADMIN, 'POST', '/code/redeem', { code: (await app(MARC, PI, 'POST', '/host/code')).code, kind: 'rdp' })).code, 'invalid');
  } finally { await host.close(); }
});

test('the desktop with a code: the firewall opens the desktop port for the hub, the session is VNC to the device', async () => {
  const { host, app, req, adminReq } = await start();
  try {
    const reg = await app(MARC, PI, 'POST', '/host/register', REG);
    await adminReq('PUT', 'rights/user/' + SABINE.id, { support: true });
    const r = await req(SABINE, 'POST', '/code/redeem', { code: (await app(MARC, PI, 'POST', '/host/code')).code, mode: 'control', kind: 'desktop' });
    assert.equal(r.request.kind, 'desktop');
    await app(MARC, PI, 'POST', '/host/requests/' + r.request.id, { decision: 'allow' });
    const conn = req(SABINE, 'POST', '/requests/' + r.request.id + '/connect', {});
    let sig = null;
    for (let i = 0; i < 200 && !sig; i++) { sig = lastSignal(host, 'remote.firewall.open'); if (!sig) await new Promise((res) => setTimeout(res, 5)); }
    assert.equal(sig.data.port, 5900);
    assert.equal(sig.data.allow, '10.8.0.1');
    await app(MARC, PI, 'POST', '/host/firewall', { sessionKey: sig.data.sessionKey, state: 'open' });
    const t = await conn;
    assert.equal(t.ok, true, JSON.stringify(t));
    assert.equal(t.session.protocol, 'vnc');
    // the desktop stops listening: no new desktop request
    await app(MARC, PI, 'POST', '/host/state', { desktop: { ready: false }, online: true });
    const c = await app(MARC, PI, 'POST', '/host/code');
    assert.equal((await req(SABINE, 'POST', '/code/redeem', { code: c.code, kind: 'desktop' })).code, 'desktop_off');
    assert.equal(reg.host.deviceId > 0, true);
  } finally { await host.close(); }
});

test('ohne Code: SSH straight into the terminal for people with the right and access', async () => {
  const { host, app, req } = await start();
  try {
    const r = await app(MARC, PI, 'POST', '/host/register', { ...REG, shareMode: 'open' });
    assert.equal(r.codeRequired, false);
    // the administrator: every device
    const t = await req(ADMIN, 'POST', '/devices/' + r.host.deviceId + '/connect', {});
    assert.equal(t.ok, true, JSON.stringify(t));
    assert.equal(t.session.engine, 'term');
    // Sabine has neither the right nor access
    assert.equal((await req(SABINE, 'POST', '/devices/' + r.host.deviceId + '/connect', {})).code, 'no_right');
  } finally { await host.close(); }
});

test('heartbeat: a changed host key is pinned again and logged, tmux goes away', async () => {
  const { host, app, adminReq } = await start();
  try {
    const r = await app(MARC, PI, 'POST', '/host/register', REG);
    const key2 = { alg: 'ssh-ed25519', sha256: 'Z9QwJ4nV0kR4o2dQ8m1VZ7mWJkQw6m8bK2a3x5Y7z1A' };
    const hb = await app(MARC, PI, 'POST', '/host/state', { online: true, ssh: { tmux: { available: false }, hostKey: key2 }, desktop: { ready: true } });
    assert.equal(hb.ok, true, JSON.stringify(hb));
    assert.deepEqual(hb.pending, []);
    const pins = await host.gc.remote.hostKeys.list();
    assert.equal(pins.find((p) => p.targetId === 'dev-' + r.host.deviceId).sha256, key2.sha256);
    const d = (await adminReq('GET', 'devices')).devices.find((x) => x.id === r.host.deviceId);
    assert.equal(d.config.tmux_enabled, false);
    assert.equal(d.host.ssh.tmux, false);
    assert.equal(d.host.hostKey.sha256, key2.sha256);
    const log = (await adminReq('GET', 'sessions/shares')).entries;
    assert.ok(log.some((e) => e.type === 'remote_host_key_changed'), JSON.stringify(log.map((e) => e.type)));
    // signing off: DELETE host
    assert.equal((await app(MARC, PI, 'DELETE', '/host')).removed, true);
  } finally { await host.close(); }
});
