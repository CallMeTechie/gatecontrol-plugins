'use strict';

// 1.2 (stage 3, gc.remote version 3): SSH in GateControl's terminal with tmux (browser and the apps' native terminals),
// the switch of old Guacamole SSH devices, host keys and keys made in GateControl, recordings (optional / always with the
// hint, per device and person), watching and deleting them, and the protocol.

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, ADMIN, MARC, SABINE, LEA, BUERO, snapshot } = require('./helpers');

const PI = { name: 'Pi im Keller', protocol: 'ssh', config: { host: '10.8.0.50', port: 22, browser_enabled: true } };
const DEVICES = [{ id: '901', userId: MARC.id, name: 'Marc Handy', platform: 'android', vpnIp: '10.8.0.71' }];
const PHONE = { id: '901', platform: 'android', vpnIp: '10.8.0.71' };

async function start(o = {}) {
  const s = await setup({ gatecontrol: o.gatecontrol || '1.285.0', remote: o.remote, host: { devices: DEVICES } });
  const app = async (user, method, path, body) => {
    const r = await s.host.request({ method, path, body: body || null, user: { ...user, app: true, portal: true, loggedIn: true, device: PHONE }, lang: 'de' });
    return { status: r.status || 200, ...r.json };
  };
  const pi = (await s.adminReq('POST', 'devices', { ...PI, credentials: { username: 'pi', password: 'himbeere' } })).device;
  await s.adminReq('PUT', 'rights/group/' + BUERO, { ssh: true });
  return { ...s, app, pi };
}

const sessionCalls = (host) => host.remote.calls.filter((c) => c.op === 'session');

test('a new SSH device uses the terminal with tmux; taken-over ones stay on Guacamole until switched (one or all)', async () => {
  const { host, adminReq, req, pi } = await start();
  try {
    assert.equal(pi.config.ssh_engine, 'term');
    assert.equal(pi.config.tmux_enabled, true);
    assert.equal(pi.ssh.engine, 'term');
    assert.equal(pi.ssh.tmux, 'gc-pi-im-keller');
    const r = await req(MARC, 'POST', '/devices/' + pi.id + '/connect');
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual([r.session.engine, r.session.recording, r.session.tmux], ['term', false, { create: 'gc-pi-im-keller' }]);
    const c = sessionCalls(host).pop();
    assert.deepEqual([c.engine, c.record, c.tmux], ['term', false, { create: 'gc-pi-im-keller' }]);
    // the take-over: the SSH route of "Remote Desktops" keeps Guacamole
    await host.legacyImport(snapshot(host));
    const nas = (await adminReq('GET', 'devices')).devices.find((d) => d.name === 'NAS-Konsole');
    assert.equal(nas.config.ssh_engine, 'guac');
    assert.equal((await adminReq('GET', 'devices/' + nas.id)).device.ssh.engine, 'guac');
    // the administrator tries the terminal first (engine term once), the device notes the successful test
    await adminReq('PUT', 'devices/' + nas.id, { config: { browser_enabled: true } });
    const t = await adminReq('POST', 'devices/' + nas.id + '/connect', { engine: 'term' });
    assert.equal(t.ok, false, 'no credential on the taken-over target');
    assert.equal(t.code, 'credential_required');
    await adminReq('PUT', 'devices/' + nas.id, { credentials: { username: 'root', password: 'x' } });
    const t2 = await adminReq('POST', 'devices/' + nas.id + '/connect', { engine: 'term' });
    assert.equal(t2.session.engine, 'term');
    await host.remoteOpen(t2.session.ref);
    assert.ok((await adminReq('GET', 'devices/' + nas.id)).device.config.term_tested_at, 'tested');
    // switch one, then back, then all
    assert.equal((await adminReq('POST', 'devices/ssh-engine', { engine: 'term', ids: [nas.id] })).switched, 1);
    assert.equal((await adminReq('POST', 'devices/ssh-engine', { engine: 'guac', ids: [nas.id] })).switched, 1);
    const all = await adminReq('POST', 'devices/ssh-engine', { engine: 'term' });
    assert.equal(all.switched, 1);
    assert.ok(all.devices.filter((d) => d.protocol === 'ssh').every((d) => d.config.ssh_engine === 'term'));
    assert.equal((await adminReq('POST', 'devices/ssh-engine', { engine: 'x' })).code, 'invalid');
    const logs = (await adminReq('GET', 'sessions/shares')).entries.filter((e) => e.type === 'remote_ssh_engine_changed');
    assert.equal(logs.length, 3);
    // a re-run of the take-over keeps the switch
    await host.legacyImport(snapshot(host));
    assert.equal((await adminReq('GET', 'devices/' + nas.id)).device.config.ssh_engine, 'term');
  } finally { await host.close(); }
});

test('tmux: the list for "Fortsetzen", names strictly checked, own name, tmux off', async () => {
  const { host, adminReq, req, pi } = await start({ remote: { tmux: { } } });
  try {
    host.remote.calls.length = 0;
    let l = await req(MARC, 'GET', '/devices/' + pi.id + '/tmux');
    assert.deepEqual([l.sessions, l.tmux, l.hostKey], [[], 'gc-pi-im-keller', 'pinned']);
    assert.equal((await req(LEA, 'GET', '/devices/' + pi.id + '/tmux')).code, 'no_right');
    for (const bad of [{ attach: "x'; rm -rf /" }, { attach: 'a b' }, { create: 'a.b' }, { attach: 'a', create: 'b' }, 'work']) {
      assert.equal((await req(MARC, 'POST', '/devices/' + pi.id + '/connect', { tmux: bad })).code, 'invalid', JSON.stringify(bad));
    }
    assert.equal(sessionCalls(host).length, 0, 'nothing reached GateControl');
    const r = await req(MARC, 'POST', '/devices/' + pi.id + '/connect', { tmux: { attach: 'work' } });
    assert.deepEqual(r.session.tmux, { attach: 'work' });
    // an own name; tmux off → no tmux option, none may be asked for
    await adminReq('PUT', 'devices/' + pi.id, { config: { tmux_name: 'keller' } });
    assert.deepEqual((await req(MARC, 'POST', '/devices/' + pi.id + '/connect')).session.tmux, { create: 'keller' });
    assert.equal((await adminReq('PUT', 'devices/' + pi.id, { config: { tmux_name: 'a:b' } })).code, 'invalid');
    await adminReq('PUT', 'devices/' + pi.id, { config: { tmux_enabled: false } });
    assert.equal((await req(MARC, 'POST', '/devices/' + pi.id + '/connect')).session.tmux, null);
    assert.equal((await req(MARC, 'POST', '/devices/' + pi.id + '/connect', { tmux: { attach: 'work' } })).code, 'invalid');
    l = await req(MARC, 'GET', '/devices/' + pi.id + '/tmux');
    assert.deepEqual([l.sessions, l.tmux], [[], null]);
  } finally { await host.close(); }
});

test('tmux list: sessions, no tmux on the device, no host key yet, a changed host key', async () => {
  // the device made first gets the first own id (100000)
  const id = 'dev-100000';
  for (const [value, want] of [
    [[{ name: 'gc-pi-im-keller', windows: 2, attached: 1 }, { name: 'my notes' }], (r) => assert.deepEqual(r.sessions.map((x) => [x.name, x.attachable]), [['gc-pi-im-keller', true], ['my notes', false]])],
    ['unpinned', (r) => assert.deepEqual([r.sessions, r.hostKey], [[], 'unpinned'])],
    ['unavailable', (r) => assert.equal(r.code, 'tmux_unavailable')],
    ['mismatch', (r) => assert.equal(r.code, 'host_key_mismatch')],
  ]) {
    const { host, req, pi } = await start({ remote: { tmux: { [id]: value } } });
    try { want(await req(MARC, 'GET', '/devices/' + pi.id + '/tmux')); } finally { await host.close(); }
  }
});

test('the native terminal of an app: via app, no browser switch needed, never a Guacamole device', async () => {
  const { host, adminReq, app, req, pi } = await start();
  try {
    await adminReq('PUT', 'devices/' + pi.id, { config: { browser_enabled: false } });
    const r = await app(MARC, 'POST', '/devices/' + pi.id + '/connect', { via: 'app', protocol: 'ssh', tmux: { create: 'handy' } });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual([r.session.engine, r.session.recording, r.session.tmux], ['term', false, { create: 'handy' }]);
    assert.match(r.session.ref, /^[A-Za-z0-9_-]{43}$/);
    // the app opens the terminal: GateControl reports via app — the history says so
    await host.remoteOpen(r.session.ref, { via: 'app' });
    const hist = (await adminReq('GET', 'sessions')).sessions;
    assert.deepEqual([hist[0].via, hist[0].engine], ['app', 'term']);
    // a guacd device cannot be opened by an app
    await adminReq('PUT', 'devices/' + pi.id, { config: { ssh_engine: 'guac', browser_enabled: true } });
    assert.equal((await app(MARC, 'POST', '/devices/' + pi.id + '/connect', { via: 'app' })).code, 'invalid');
    // "via: app" from a browser is refused
    assert.equal((await req(MARC, 'POST', '/devices/' + pi.id + '/connect', { via: 'app' })).code, 'invalid');
  } finally { await host.close(); }
});

test('recording: off / optional (the person asks) / always (the hint; an app must confirm), the stricter of device and person', async () => {
  const { host, adminReq, req, app, pi } = await start();
  try {
    // off: no recording, and none may be asked for
    assert.equal((await req(MARC, 'POST', '/devices/' + pi.id + '/connect', { record: true })).code, 'invalid');
    // optional on the device: only when asked
    await adminReq('PUT', 'devices/' + pi.id, { config: { recording: 'optional' } });
    let ov = await req(MARC, 'GET', '/overview');
    assert.equal(ov.devices[0].recording, 'optional');
    assert.equal((await req(MARC, 'POST', '/devices/' + pi.id + '/connect')).session.recording, false);
    assert.equal((await req(MARC, 'POST', '/devices/' + pi.id + '/connect', { record: true })).session.recording, true);
    assert.equal(sessionCalls(host).pop().record, true);
    // always for the person (the device says optional): the stricter holds
    await adminReq('PUT', 'rights/user/' + MARC.id, { recording: 'always' });
    ov = await req(MARC, 'GET', '/overview');
    assert.equal(ov.devices[0].recording, 'always');
    assert.equal((await req(MARC, 'POST', '/devices/' + pi.id + '/connect')).session.recording, true, 'the browser: GateControl\'s page shows the hint');
    assert.equal((await app(MARC, 'POST', '/devices/' + pi.id + '/connect', { via: 'app' })).code, 'recording_required');
    assert.equal((await app(MARC, 'POST', '/devices/' + pi.id + '/connect', { via: 'app', record: true })).session.recording, true);
    // the person sees it in the profile
    assert.equal((await req(MARC, 'GET', '/profile')).recording, 'always');
    // Sabine (group Büro, no own setting): the device's optional
    assert.equal((await req(SABINE, 'GET', '/overview')).devices[0].recording, 'optional');
    // a group setting
    await adminReq('PUT', 'rights/group/' + BUERO, { recording: 'always' });
    assert.equal((await req(SABINE, 'GET', '/overview')).devices[0].recording, 'always');
    const mx = await adminReq('GET', 'rights');
    assert.equal(mx.groups.find((g) => g.id === BUERO).set.recording, 'always');
    assert.equal(mx.people.find((u) => u.id === SABINE.id).effective.recording, 'always');
    assert.equal((await adminReq('PUT', 'rights/user/' + SABINE.id, { recording: 'sometimes' })).code, 'invalid');
  } finally { await host.close(); }
});

test('recording needs the drive: always without it → no session; GateControl before version 3 → as 1.1', async () => {
  const { host, adminReq, req, pi } = await start({ remote: { recordings: { available: false, reason: 'no_drive', engines: { term: false, guac: false } } } });
  try {
    await adminReq('PUT', 'devices/' + pi.id, { config: { recording: 'always' } });
    const r = await req(MARC, 'POST', '/devices/' + pi.id + '/connect');
    assert.equal(r.code, 'recording_unavailable');
    assert.equal(sessionCalls(host).length, 0);
    await adminReq('PUT', 'devices/' + pi.id, { config: { recording: 'optional' } });
    assert.equal((await req(MARC, 'POST', '/devices/' + pi.id + '/connect', { record: true })).code, 'recording_unavailable');
    assert.equal((await req(MARC, 'POST', '/devices/' + pi.id + '/connect')).session.recording, false);
  } finally { await host.close(); }
  const old = await start({ gatecontrol: '1.284.0' });
  try {
    const r = await old.req(MARC, 'POST', '/devices/' + old.pi.id + '/connect');
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.session.engine, 'guac', 'no terminal without version 3');
    const c = sessionCalls(old.host).pop();
    assert.equal(c.engine, 'guac');
    assert.equal(c.tmux, null);
    assert.equal((await old.req(MARC, 'GET', '/devices/' + old.pi.id + '/tmux')).code, 'offline');
    assert.deepEqual((await old.adminReq('GET', 'recordings')).recordings, []);
  } finally { await old.host.close(); }
});

test('recordings: the list (admin all, owner own devices), playback for that person only, delete, retention, the protocol', async () => {
  const { host, adminReq, req, pi } = await start();
  try {
    await adminReq('PUT', 'devices/' + pi.id, { config: { recording: 'always' } });
    const r = await req(MARC, 'POST', '/devices/' + pi.id + '/connect');
    const { sessionId } = await host.remoteOpen(r.session.ref);
    await host.remoteClose(sessionId, 'normal');
    const list = (await adminReq('GET', 'recordings')).recordings;
    assert.equal(list.length, 1);
    assert.deepEqual([list[0].deviceId, list[0].deviceName, list[0].userName, list[0].format], [pi.id, 'Pi im Keller', 'Marc', 'asciicast']);
    assert.ok(!JSON.stringify(list).includes('himbeere'));
    const hist = (await adminReq('GET', 'sessions')).sessions;
    assert.equal(hist[0].recordingId, list[0].id);
    // Marc recorded it, but the device is no PC of his: a person sees no recordings of devices they do not own
    assert.deepEqual((await req(MARC, 'GET', '/recordings')).recordings, []);
    assert.equal((await req(MARC, 'POST', '/recordings/' + list[0].id + '/play')).code, 'not_found');
    // the administrator watches: a ticket for exactly the administrator
    const p = await adminReq('POST', 'recordings/' + list[0].id + '/play');
    assert.equal(p.ok, true, JSON.stringify(p));
    assert.match(p.ref, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(p.format, 'asciicast');
    assert.deepEqual(host.remote.calls.filter((c) => c.op === 'stream').pop(), { op: 'stream', id: list[0].id, user: ADMIN.id });
    await host.remoteView(p.ref);
    let shares = (await adminReq('GET', 'sessions/shares')).entries;
    assert.ok(shares.some((e) => e.type === 'remote_recording_viewed' && e.userId === ADMIN.id && e.deviceId === pi.id));
    // delete
    assert.deepEqual([(await adminReq('DELETE', 'recordings/' + list[0].id)).removed], [true]);
    assert.equal((await adminReq('GET', 'recordings')).recordings.length, 0);
    shares = (await adminReq('GET', 'sessions/shares')).entries;
    assert.ok(shares.some((e) => e.type === 'remote_recording_deleted'));
    assert.equal((await adminReq('DELETE', 'recordings/rr_nope')).code, 'not_found');
    // retention: the plugin's days
    const r2 = await req(MARC, 'POST', '/devices/' + pi.id + '/connect');
    const o2 = await host.remoteOpen(r2.session.ref);
    await host.remoteClose(o2.sessionId, 'normal');
    host.remote.recordings[0].createdAt = new Date(Date.now() - 40 * 86400000).toISOString();
    assert.equal((await adminReq('PUT', 'settings', { recordingDays: 30 })).settings.recordingDays, 30);
    assert.equal(await require('../server/recordings').purge(host.gc, 30), 1);
    assert.equal(host.remote.recordings.length, 0);
    assert.equal((await adminReq('PUT', 'settings', { recordingDays: 0 })).code, 'invalid');
  } finally { await host.close(); }
});

test('the owner of a PC watches the recordings of the PC; a changed host key lands in the protocol; host key reset and a generated key', async () => {
  const { host, adminReq, req, pi } = await start();
  try {
    // a PC of Marc (kind host) with a recording
    const store = require('../server/store');
    await store.run(host.gc, "UPDATE devices SET kind = 'host', owner_user_id = ?, registered = 1 WHERE id = ?", [MARC.id, pi.id]);
    host.remote.recordings.push({ id: 'rr_' + 'a'.repeat(32), sessionId: 1, targetId: 'dev-' + pi.id, userId: SABINE.id, protocol: 'ssh', format: 'asciicast', status: 'ready', bytes: 1, durationSeconds: 5, startedAt: new Date().toISOString(), createdAt: new Date().toISOString() });
    const mine = (await req(MARC, 'GET', '/recordings')).recordings;
    assert.equal(mine.length, 1);
    assert.equal((await req(MARC, 'POST', '/recordings/' + mine[0].id + '/play')).ok, true);
    assert.equal((await req(SABINE, 'POST', '/recordings/' + mine[0].id + '/play')).code, 'not_found', 'the person recorded is not the owner');
    await store.run(host.gc, "UPDATE devices SET kind = 'target', owner_user_id = NULL WHERE id = ?", [pi.id]);
    // the terminal of GateControl refused a changed key: the protocol has it
    const r = await req(MARC, 'POST', '/devices/' + pi.id + '/connect');
    await host.remoteAbortTerm(r.session.ref, 'host_key_mismatch');
    assert.ok((await adminReq('GET', 'sessions/shares')).entries.some((e) => e.type === 'remote_host_key_changed' && e.deviceId === pi.id));
    // host key: shown, reset (protocol), a new key (public half only)
    host.remote.hostKeys.set('dev-' + pi.id, { targetId: 'dev-' + pi.id, alg: 'ssh-ed25519', sha256: 'B'.repeat(43), source: 'trust', pinnedBy: MARC.id, pinnedAt: new Date().toISOString() });
    let d = (await adminReq('GET', 'devices/' + pi.id)).device;
    assert.equal(d.ssh.hostKey.sha256, 'B'.repeat(43));
    d = (await adminReq('DELETE', 'devices/' + pi.id + '/hostkey')).device;
    assert.equal(d.ssh.hostKey, null);
    assert.ok((await adminReq('GET', 'sessions/shares')).entries.some((e) => e.type === 'remote_host_key_reset'));
    const k = await adminReq('POST', 'devices/' + pi.id + '/key', {});
    assert.match(k.publicKey, /^ssh-ed25519 /);
    assert.equal(k.device.ssh.publicKey, k.publicKey);
    assert.ok(!JSON.stringify(k).includes('PRIVATE KEY'));
    assert.equal(k.device.credential.has.privateKey, true);
    assert.equal(k.device.credential.has.password, true, 'username and password stay');
  } finally { await host.close(); }
});
