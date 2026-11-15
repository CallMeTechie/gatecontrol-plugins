'use strict';

// The mock host's mirror of GateControl 1.281.0 gc.remote (src/services/remote/, hostApi.js remoteCall, the child
// bootstrap's makeRemote): only with permissions.remote; sessions check person, licence, target, credential and options;
// the vault answers metadata only; listeners reuse an L4 route of the same target; the facade needs ECDH.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHost } = require('../testing/mock-host');

const USERS = [{ id: 1, name: 'admin', role: 'admin' }, { id: 2, name: 'Anna', role: 'user' }];

const CODE = `
const seen = [];
module.exports = {
  async start(gc) { if (gc.remote) gc.remote.on('session', (ev) => { seen.push(ev); }); },
  async request(req, gc) {
    const b = req.body || {};
    if (req.path === '/has') return { json: { remote: !!gc.remote, version: gc.remote ? gc.remote.version : null, gateways: !!(gc.remote && gc.remote.gateways) } };
    if (req.path === '/seen') return { json: { seen } };
    const fn = b.op.split('.').reduce((o, k) => o[k], gc.remote);
    try { return { json: { ok: true, result: await fn(...(b.args || [])) } }; } catch (e) { return { json: { ok: false, code: e.code } }; }
  },
  async clientFacade(p) {
    if (p.op === 'connect') return { status: 200, body: { ok: true, connection: { id: 3, password: 'leak' } }, credential: { handle: p.query.h, fields: ['username'] } };
    if (p.op === 'list') return { handled: false };
    return { status: 200, body: { ok: true, server: p.server || null } };
  },
};`;

function plugin(perms) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-plugin-'));
  fs.mkdirSync(path.join(dir, 'server'));
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id: 'rm-test', name: 'R', version: '1.0.0', entry: 'server/index.js', permissions: perms }));
  fs.writeFileSync(path.join(dir, 'server', 'index.js'), CODE);
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const call = (host, op, ...args) => host.request({ method: 'POST', path: '/x', body: { op, args } }).then((r) => r.json);

test('gc.remote only with permissions.remote on GateControl 1.281.0, gateways() from 1.282.0', async () => {
  const a = plugin({ remote: true });
  const b = plugin({ storage: true });
  try {
    const h1 = await createHost(a.dir, { gatecontrol: '1.280.0', users: USERS });
    assert.equal((await h1.request({ path: '/has' })).json.remote, false);
    await h1.close();
    const h2 = await createHost(a.dir, { gatecontrol: '1.281.0', users: USERS });
    assert.deepEqual((await h2.request({ path: '/has' })).json, { remote: true, version: 1, gateways: false });
    await h2.close();
    const h3 = await createHost(a.dir, { gatecontrol: '1.282.0', users: USERS });
    assert.equal((await h3.request({ path: '/has' })).json.gateways, true);
    await h3.close();
    const h4 = await createHost(b.dir, { gatecontrol: '1.281.0', users: USERS });
    assert.equal((await h4.request({ path: '/has' })).json.remote, false);
    await h4.close();
    const c = plugin({ remote: 'yes' });
    try { await assert.rejects(createHost(c.dir, { gatecontrol: '1.281.0' }), (e) => e.code === 'ERR_INVALID'); } finally { c.done(); }
  } finally { a.done(); b.done(); }
});

test('sessions: person, licence, target rules, credential, options; open and close emit the session events', async () => {
  const p = plugin({ remote: true });
  const host = await createHost(p.dir, { gatecontrol: '1.281.0', users: USERS, remote: { limits: { perUser: 1 } } });
  try {
    await host.start();
    const t = { id: 'dev-1', host: '10.8.0.44', port: 3389 };
    assert.equal((await call(host, 'session', { user: 9, target: t, protocol: 'rdp' })).code, 'ERR_NOT_FOUND');
    assert.equal((await call(host, 'session', { user: 2, target: { id: 'x', host: '127.0.0.1', port: 22 }, protocol: 'ssh' })).code, 'ERR_REMOTE_NOT_ALLOWED');
    assert.equal((await call(host, 'session', { user: 2, target: { id: 'x', host: '10.8.0.1', port: 22 }, protocol: 'ssh' })).code, 'ERR_REMOTE_NOT_ALLOWED');
    assert.equal((await call(host, 'session', { user: 2, target: { id: 'x', host: '192.168.1.5', port: 22, gateway: { peerId: 7 } }, protocol: 'ssh' })).code, 'ERR_REMOTE_LISTENER_REQUIRED');
    assert.equal((await call(host, 'session', { user: 2, target: t, protocol: 'rdp', record: true })).code, 'ERR_REMOTE_RECORDING_UNAVAILABLE');
    assert.equal((await call(host, 'session', { user: 2, target: t, protocol: 'rdp', options: { sftp: true } })).code, 'ERR_INVALID');
    assert.equal((await call(host, 'session', { user: 2, target: t, protocol: 'rdp', credential: 'rv_' + '0'.repeat(32) })).code, 'ERR_REMOTE_CREDENTIAL_NOT_FOUND');
    const v = (await call(host, 'vault.put', { username: 'u', password: 'p' })).result;
    assert.deepEqual(v.has, { username: true, password: true, domain: false, privateKey: false, passphrase: false });
    assert.equal(JSON.stringify(v).includes('"p"'), false);
    host.license.licensed = false;
    assert.equal((await call(host, 'session', { user: 2, target: t, protocol: 'rdp' })).code, 'ERR_REMOTE_UNLICENSED');
    host.license.licensed = true;
    const s = (await call(host, 'session', { user: 2, target: t, protocol: 'rdp', credential: v.handle, options: { color_depth: 16 } })).result;
    assert.match(s.url, /^\/remote\/session\/[A-Za-z0-9_-]{43}$/);
    const { sessionId } = await host.remoteOpen(s.ref);
    assert.equal((await call(host, 'session', { user: 2, target: t, protocol: 'rdp' })).code, 'ERR_REMOTE_LIMIT');
    assert.equal((await call(host, 'sessions', { active: true })).result.length, 1);
    await host.remoteClose(sessionId, 'heartbeat');
    const seen = (await host.request({ path: '/seen' })).json.seen;
    assert.deepEqual(seen.map((e) => e.phase), ['start', 'abort']);
    assert.equal(seen[1].reason, 'heartbeat');
  } finally { await host.close(); p.done(); }
});

test('listeners reuse an L4 route, wake has a rate limit, recordings are not there yet', async () => {
  const p = plugin({ remote: true });
  const host = await createHost(p.dir, { gatecontrol: '1.281.0', users: USERS, remote: { l4: [{ peerId: 7, host: '192.168.1.20', port: 3389, listenPort: 13389 }] } });
  try {
    const l = (await call(host, 'listener', { key: 'route-5', gateway: { peerId: 7 }, host: '192.168.1.20', port: 3389, listenPort: 13389 })).result;
    assert.equal(l.shared, true);
    assert.equal((await call(host, 'listener', { key: 'dev-9', gateway: { peerId: 7 }, host: '192.168.1.21', port: 3389, listenPort: 13389 })).code, 'ERR_REMOTE_PORT_IN_USE');
    assert.equal((await call(host, 'listeners')).result.length, 1);
    assert.equal((await call(host, 'wake', { id: 'd', listener: 'route-5', mac: 'AA:BB:CC:DD:EE:FF' })).result.via, 'gateway');
    assert.equal((await call(host, 'wake', { id: 'd', listener: 'route-5', mac: 'AA:BB:CC:DD:EE:FF' })).code, 'ERR_REMOTE_RATE_LIMITED');
    assert.deepEqual((await call(host, 'recordings.available')).result, { available: false, reason: 'not_yet' });
    assert.equal((await call(host, 'listener.remove', 'route-5')).result.removed, true);
  } finally { await host.close(); p.done(); }
});

test('the facade: credential keys removed, credentials only with ECDH, handled: false passes on, `server` from 1.282.0', async () => {
  const p = plugin({ remote: true });
  const host = await createHost(p.dir, { gatecontrol: '1.282.0', users: USERS });
  try {
    const h = (await call(host, 'vault.put', { username: 'tom', password: 'x' })).result.handle;
    const no = await host.clientFacade('connect', { id: 3, user: { id: 2 }, query: { h } });
    assert.deepEqual(no, { status: 400, body: { ok: false, error: 'ecdh_required' } });
    const r = await host.clientFacade('connect', { id: 3, user: { id: 2 }, query: { h, ecdhPublicKey: 'K' } });
    assert.equal(r.body.connection.password, undefined);
    assert.deepEqual(JSON.parse(Buffer.from(r.body.connection.credentials_e2ee.data, 'base64').toString()), { username: 'tom', password: null, domain: null });
    assert.deepEqual(await host.clientFacade('list', { user: { id: 2 } }), { handled: false });
    assert.deepEqual((await host.clientFacade('status', { id: 3, user: { id: 2 } })).body.server, { connectHost: 'gc.example.test' });
  } finally { await host.close(); p.done(); }
});
