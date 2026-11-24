'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, snapshot, MARC, SABINE, ADMIN } = require('./helpers');

const APP = (user, x = {}) => ({ id: user.id, tokenId: 900 + user.id, peerId: 100 + user.id, scopes: ['client', 'client:rdp'], platform: 'android', ...x });

async function imported(o) {
  const s = await setup({ remote: { l4: [{ peerId: 7, host: '192.168.1.20', port: 3389, listenPort: 13389 }], connectHost: 'gc.example.test' }, ...(o || {}) });
  await s.host.legacyImport(snapshot(s.host));
  return s;
}

test('list: the RDP devices of the app\'s person in the old shape, never its own computer', async () => {
  const { host } = await imported();
  try {
    const r = await host.clientFacade('list', { user: APP(MARC) });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    const ids = r.body.routes.map((x) => x.id).sort();
    assert.deepEqual(ids, [3, 5]);
    const pc = r.body.routes.find((x) => x.id === 3);
    assert.equal(pc.connect_address, '10.8.0.43');
    assert.equal(pc.connect_port, 3389);
    for (const k of ['multi_monitor', 'redirect_clipboard', 'redirect_printers', 'redirect_drives', 'admin_session', 'wol_enabled', 'maintenance_enabled', 'enabled']) {
      assert.equal(typeof pc[k], 'boolean', k);
    }
    assert.equal(pc.user_ids, '[2]');
    assert.deepEqual(pc.status, { online: false, lastCheck: null });
    assert.equal(JSON.stringify(r.body).includes('rv_'), false, 'no vault handle for the app');
    const gw = r.body.routes.find((x) => x.id === 5);
    assert.equal(gw.connect_address, 'gc.example.test');
    assert.equal(gw.connect_port, 13389);
    // the app on the computer itself
    const self = await host.clientFacade('list', { user: APP(MARC, { selfIp: '10.8.0.43' }) });
    assert.deepEqual(self.body.routes.map((x) => x.id), [5]);
    // a token without client:rdp
    assert.equal((await host.clientFacade('list', { user: APP(MARC, { scopes: ['client'] }) })).status, 403);
    // an old app's token without a person: only the device that lists the token
    const tok = await host.clientFacade('list', { user: { id: null, tokenId: 77, peerId: null, scopes: ['full-access'] } });
    assert.deepEqual(tok.body.routes.map((x) => x.id), [6]);
    // 1.9: an administrator's app sees every enabled RDP device, also the ones whose lists do not name them
    const adm = await host.clientFacade('list', { user: APP(ADMIN) });
    assert.deepEqual(adm.body.routes.map((x) => x.id).sort(), [3, 5, 6]);
    assert.equal((await host.clientFacade('status', { id: 3, user: APP(ADMIN) })).status, 200);
    assert.deepEqual(Object.keys((await host.clientFacade('statusAll', { user: APP(ADMIN) })).body.statuses).sort(), ['3', '5', '6']);
    // a device of GateControl (no PC of a person): the administrator connects like on the admin page
    assert.equal((await host.clientFacade('connect', { id: 3, user: APP(ADMIN), query: { ecdhPublicKey: 'K' } })).status, 200);
    // everybody else: unchanged
    assert.deepEqual((await host.clientFacade('list', { user: APP(SABINE) })).body.routes.map((x) => x.id), [5]);
    assert.equal((await host.clientFacade('status', { id: 3, user: APP(SABINE) })).status, 403);
  } finally { await host.close(); }
});

test('connect: connection data, credentials only through the core with ECDH', async () => {
  const { host } = await imported();
  try {
    const no = await host.clientFacade('connect', { id: 3, user: APP(MARC), query: {} });
    assert.equal(no.status, 400);
    assert.equal(no.body.error, 'ecdh_required');
    const r = await host.clientFacade('connect', { id: 3, user: APP(MARC), query: { ecdhPublicKey: 'BASE64KEY' } });
    assert.equal(r.status, 200, JSON.stringify(r));
    const c = r.body.connection;
    assert.equal(c.id, 3);
    assert.equal(c.host, '10.8.0.43');
    assert.equal(c.credential_mode, 'full');
    assert.equal(c.password, undefined);
    assert.equal('peer_fqdn' in c, false, 'the core adds the DNS names');
    assert.deepEqual(JSON.parse(Buffer.from(c.credentials_e2ee.data, 'base64').toString()), { username: 'tom', password: 'geheim', domain: 'FIRMA' });
    // someone else: 403; an unknown id: 404; SSH: 400; maintenance: 503
    assert.equal((await host.clientFacade('connect', { id: 3, user: APP(SABINE), query: { ecdhPublicKey: 'K' } })).status, 403);
    assert.equal((await host.clientFacade('connect', { id: 999, user: APP(MARC), query: { ecdhPublicKey: 'K' } })).status, 404);
    const m = await host.clientFacade('connect', { id: 6, user: { id: null, tokenId: 77, scopes: ['client:rdp'] }, query: { ecdhPublicKey: 'K' } });
    const now = new Date();
    if (now.getHours() * 60 + now.getMinutes() < 1439) { assert.equal(m.status, 503); assert.equal(m.body.maintenance, true); }
  } finally { await host.close(); }
});

test('user_only gives the app the username and the domain, not the password', async () => {
  const { host, adminReq } = await imported();
  try {
    await adminReq('PUT', 'devices/3', { config: { credential_mode: 'user_only' } });
    const r = await host.clientFacade('connect', { id: 3, user: APP(MARC), query: { ecdhPublicKey: 'K' } });
    assert.deepEqual(JSON.parse(Buffer.from(r.body.connection.credentials_e2ee.data, 'base64').toString()), { username: 'tom', password: null, domain: 'FIRMA' });
  } finally { await host.close(); }
});

test('status, browser session and the app\'s session reports', async () => {
  const { host, adminReq } = await imported();
  try {
    const st = await host.clientFacade('status', { id: 3, user: APP(MARC) });
    assert.equal(st.body.status.online, true);
    const b = await host.clientFacade('browserSession', { id: 3, user: APP(MARC) });
    assert.equal(b.status, 200, JSON.stringify(b));
    assert.equal(b.body.wsPath, '/api/v1/remote/guac-tunnel');
    assert.equal((await host.clientFacade('browserSession', { id: 4, user: APP(MARC) })).status, 403, 'browser access is off / no right');
    const s = await host.clientFacade('sessionStart', { id: 3, user: APP(MARC), ip: '10.8.0.12' });
    assert.equal(s.status, 201);
    const sid = s.body.session.id;
    assert.ok(sid >= 1000000000);
    assert.equal((await host.clientFacade('sessionHeartbeat', { id: 3, user: APP(MARC), body: { sessionId: sid } })).body.ok, true);
    assert.equal((await host.clientFacade('sessionHeartbeat', { id: 3, user: APP(SABINE), body: { sessionId: sid } })).status, 403, 'not your session');
    assert.equal((await host.clientFacade('sessionHeartbeat', { id: 3, user: APP(MARC), body: {} })).status, 400);
    const e = await host.clientFacade('sessionEnd', { id: 3, user: APP(MARC), body: { endReason: 'normal' } });
    assert.equal(e.body.session.id, sid);
    const hist = (await adminReq('GET', 'sessions')).sessions;
    assert.equal(hist[0].id, sid);
    assert.equal(hist[0].status, 'ended');
    assert.equal(hist[0].via, 'native');
  } finally { await host.close(); }
});

test('apps that stopped reporting end as "timeout"', async () => {
  const { host, adminReq } = await imported();
  try {
    const s = await host.clientFacade('sessionStart', { id: 3, user: APP(MARC) });
    // the sweep with a clock 10 minutes ahead (the device checks and the purge are not due)
    const idx = require('../server/index');
    idx._state.lastCheck = Date.now();
    idx._state.lastPurge = Date.now();
    idx._state.lastReconcile = Date.now();
    const realNow = Date.now;
    Date.now = () => realNow() + 600000;
    try { await host.tick(); } finally { Date.now = realNow; }
    const hist = (await adminReq('GET', 'sessions')).sessions;
    assert.equal(hist.find((x) => x.id === s.body.session.id).endReason, 'timeout');
  } finally { await host.close(); }
});

test('a GateControl without `server` in the payload (1.281.0) keeps answering from its own tables', async () => {
  // no opts.remote: exactly 1.281.0
  const { createHost } = require('../../../tools/testing/mock-host');
  const host = await createHost(require('node:path').join(__dirname, '..'), { gatecontrol: '1.281.0', users: [ADMIN, MARC] });
  try {
    await host.start();
    assert.deepEqual(await host.clientFacade('list', { user: APP(MARC) }), { handled: false });
    // and no gateway list: the device page falls back to the gateway's number
    const r = await host.request({ method: 'GET', path: '/admin/devices', user: ADMIN });
    assert.equal(r.json.available, false);
  } finally { await host.close(); }
});
