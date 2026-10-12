'use strict';

// The Proxmox VE client (server/pve.js) and the snapshot (server/snapshot.js):
// token header, /api2/json paths, error codes for the documented failures
// (401/403/500/595, network, certificate, not assigned), UPID handling and
// the normalised status from the PVE 8.x answers.

const test = require('node:test');
const assert = require('node:assert/strict');
const pve = require('../server/pve');
const snapshot = require('../server/snapshot');
const { fixture, fakePve, withHost, TOKEN_ID, SECRET } = require('./helpers');

const client = (host, o = {}) => pve.createClient(host.gc, { index: 0, tokenId: TOKEN_ID, secret: SECRET, ...o });

test('auth header: PVEAPIToken=USER@REALM!TOKENID=SECRET on every request, paths under /api2/json', async () => {
  await withHost({}, async (host, fake) => {
    const c = client(host);
    assert.deepEqual(await c.version(), fixture().version);
    await c.clusterStatus();
    await c.resources('vm');
    await c.nodeStatus('pve1');
    await c.nodeTasks('pve1', { typefilter: 'vzdump', limit: 20 });
    assert.equal(pve.authHeader(TOKEN_ID, SECRET), `PVEAPIToken=${TOKEN_ID}=${SECRET}`);
    for (const call of fake.calls) {
      assert.equal(call.headers.authorization, `PVEAPIToken=gatecontrol@pve!monitor=${SECRET}`);
      assert.match(call.path, /^\/api2\/json\//);
    }
    assert.deepEqual(fake.calls.map((x) => x.path), [
      '/api2/json/version', '/api2/json/cluster/status', '/api2/json/cluster/resources?type=vm',
      '/api2/json/nodes/pve1/status', '/api2/json/nodes/pve1/tasks?typefilter=vzdump&limit=20',
    ]);
    // through the home target "pve", assignment 0, no redirects followed
    const f = host.fetches.at(-1);
    assert.equal(f.target, 'pve');
    assert.equal(f.index, 0);
    assert.equal(f.opts.redirect, 'manual');
  });
});

test('invalid token id / secret / target are refused before any request', async () => {
  await withHost({}, async (host, fake) => {
    assert.throws(() => client(host, { tokenId: 'root@pam' }), { code: 'TOKEN_ID_INVALID' });
    assert.throws(() => client(host, { tokenId: 'root@pam!tok=en' }), { code: 'TOKEN_ID_INVALID' });
    assert.throws(() => client(host, { secret: '' }), { code: 'PVE_NO_SECRET' });
    assert.throws(() => client(host, { secret: 'a b c d e f g h' }), { code: 'PVE_NO_SECRET' });
    assert.throws(() => client(host, { index: null }), { code: 'PVE_NO_TARGET' });
    assert.equal(fake.calls.length, 0);
    assert.ok(pve.validTokenId('gatecontrol@pve!monitor'));
    assert.ok(pve.validTokenId('root@pam!gc-1'));
    assert.ok(!pve.validTokenId('gatecontrol@pve'));
  });
});

test('HTTP errors → codes (401 token, 403 privilege, 500, 595 node, 502 gateway, 3xx https, 501), never the body', async () => {
  const cases = [[401, 'PVE_AUTH'], [403, 'PVE_FORBIDDEN'], [500, 'PVE_SERVER'], [595, 'PVE_NODE_DOWN'], [502, 'PVE_GATEWAY'], [504, 'PVE_GATEWAY'],
    [301, 'PVE_HTTPS_REQUIRED'], [400, 'PVE_BAD_REQUEST'], [501, 'PVE_NOT_FOUND'], [418, 'PVE_HTTP']];
  await withHost({}, async (host, fake) => {
    for (const [status, code] of cases) {
      fake.fail = () => ({ status, body: '{"data":null,"message":"secret detail ' + SECRET + '"}' });
      await assert.rejects(client(host).version(), (e) => {
        assert.equal(e.code, code, `HTTP ${status}`);
        assert.equal(e.status, status);
        assert.ok(!e.message.includes('secret detail') && !e.message.includes(SECRET));
        return true;
      });
    }
  });
});

test('a wrong token is answered with 401 by Proxmox → PVE_AUTH', async () => {
  await withHost({}, async (host) => {
    await assert.rejects(client(host, { secret: '11111111-2222-3333-4444-555555555555' }).version(), { code: 'PVE_AUTH' });
  });
});

test('network, certificate, timeout and target errors of the host → codes', async () => {
  const cases = [
    [Object.assign(new Error('connect ECONNREFUSED 192.0.2.11:8006'), { code: 'ERR_NET' }), 'PVE_UNREACHABLE'],
    [Object.assign(new Error('self-signed certificate'), { code: 'ERR_NET' }), 'PVE_TLS'],
    [Object.assign(new Error('unable to verify the first certificate'), { code: 'ERR_NET' }), 'PVE_TLS'],
    [Object.assign(new Error("Hostname/IP does not match certificate's altnames: IP: 192.0.2.11 is not in the cert's list"), { code: 'ERR_NET' }), 'PVE_TLS'],
    [Object.assign(new Error('timeout'), { code: 'ERR_NET' }), 'PVE_TIMEOUT'],
    [Object.assign(new Error('no target assigned for pve — an administrator assigns it in Settings → Plugins'), { code: 'ERR_NET_DENIED' }), 'PVE_NO_TARGET'],
    [Object.assign(new Error('blocked_address'), { code: 'ERR_NET_DENIED' }), 'PVE_TARGET_DENIED'],
  ];
  await withHost({}, async (host, fake) => {
    for (const [err, code] of cases) {
      fake.down = err;
      await assert.rejects(client(host).version(), { code }, err.message);
    }
  });
  // the mock host itself: an index nobody assigned
  await withHost({}, async (host) => {
    await assert.rejects(client(host, { index: 3 }).version(), { code: 'PVE_NO_TARGET' });
  });
});

test('an answer without { data } or not JSON → PVE_BAD_RESPONSE', async () => {
  await withHost({}, async (host, fake) => {
    fake.fail = () => ({ status: 200, body: '<html>Router login</html>' });
    await assert.rejects(client(host).version(), { code: 'PVE_BAD_RESPONSE' });
    fake.fail = () => ({ status: 200, body: '{"errors":{}}' });
    await assert.rejects(client(host).version(), { code: 'PVE_BAD_RESPONSE' });
  });
});

test('guest action: POST …/status/<action> → UPID; task status by encoded UPID on the UPID node', async () => {
  await withHost({}, async (host, fake) => {
    const c = client(host);
    const upid = await c.guestAction('pve2', 'lxc', 200, 'reboot');
    assert.ok(pve.validUpid(upid), upid);
    assert.equal(pve.upidNode(upid), 'pve2');
    const post = fake.calls.at(-1);
    assert.equal(post.method, 'POST');
    assert.equal(post.path, '/api2/json/nodes/pve2/lxc/200/status/reboot');
    const st = await c.taskStatus('pve2', upid);
    assert.equal(st.status, 'running');
    assert.equal(fake.calls.at(-1).path, `/api2/json/nodes/pve2/tasks/${encodeURIComponent(upid)}/status`);
    assert.ok(!fake.calls.at(-1).path.includes('@'), 'UPID is encoded in the path');
    await assert.rejects(c.guestAction('pve1', 'qemu', 100, 'destroy'), { code: 'INVALID' });
    await assert.rejects(c.taskStatus('pve1', 'UPID:bad'), { code: 'INVALID' });
    await assert.rejects(c.guestAction('pve1', 'qemu', 99, 'start'), { code: 'INVALID' });
    await assert.rejects(c.guestAction('../x', 'qemu', 100, 'start'), { code: 'PVE_BAD_RESPONSE' });
    // Proxmox answering something else than a UPID
    fake.fail = (p) => (p.includes('/status/start') ? { status: 200, body: '{"data":"not-a-upid"}' } : undefined);
    await assert.rejects(c.guestAction('pve1', 'qemu', 101, 'start'), { code: 'PVE_BAD_RESPONSE' });
  });
});

test('UPID format (PVE 8): UPID:node:pid:pstart:starttime:type:id:user:', () => {
  assert.ok(pve.validUpid('UPID:pve1:0002A1B3:01F4C2D1:66F1A000:vzdump:100:root@pam:'));
  assert.ok(pve.validUpid('UPID:pve1:0002A0F0:01F4B000:66F09E80:vzdump::root@pam:'));
  assert.ok(pve.validUpid('UPID:pve-2:00001001:01F4C2D1:66F1B000:qmshutdown:100:gatecontrol@pve!monitor:'));
  assert.ok(!pve.validUpid('UPID:pve1:0002A1B3:01F4C2D1:66F1A000:vzdump:100:root@pam'));
  assert.ok(!pve.validUpid('UPID:pve1/../x:0002A1B3:01F4C2D1:66F1A000:vzdump:100:root@pam:'));
  assert.equal(pve.upidNode('nope'), null);
});

test('snapshot: nodes, guests, storages (shared once), backups, HA, cluster from the PVE 8 answers', () => {
  const fx = fixture();
  const s = snapshot.normalize({
    version: fx.version, clusterStatus: fx.cluster_status, resources: fx.cluster_resources,
    nodeStatus: { pve1: { data: fx.node_status.pve1 }, pve2: { error: 'PVE_NODE_DOWN' } },
    tasks: { pve1: { data: fx.tasks.pve1 }, pve2: { data: fx.tasks.pve2 } },
    ha: { data: fx.ha_status }, updates: { pve1: { count: 2, error: null }, pve2: { count: null, error: 'PVE_FORBIDDEN' } },
  }, 1000);
  assert.deepEqual(s.version, { version: '8.2.4', release: '8.2' });
  assert.deepEqual(s.cluster, { name: 'homelab', quorate: true, nodes: 2 });
  assert.deepEqual(s.nodes.map((n) => n.name), ['pve1', 'pve2']);
  const n1 = s.nodes[0];
  assert.equal(n1.online, true);
  assert.equal(n1.ip, '192.0.2.11');
  assert.equal(n1.pveversion, '8.2.4');
  assert.deepEqual(n1.load, [0.42, 0.35, 0.3], 'loadavg strings → numbers');
  assert.deepEqual(n1.swap, { used: 0, total: 8 * 1024 ** 3 });
  assert.equal(n1.rootfs.total, 94 * 1024 ** 3);
  assert.equal(n1.maxcpu, 8);
  assert.equal(n1.mem, 12 * 1024 ** 3);
  assert.equal(n1.updates, 2);
  assert.equal(s.nodes[1].error, 'PVE_NODE_DOWN', 'a failing node keeps its error');
  assert.equal(s.nodes[1].load, null);
  assert.equal(s.nodes[1].mem, 5 * 1024 ** 3, 'falls back to /cluster/resources');
  assert.equal(s.nodes[1].updatesError, 'PVE_FORBIDDEN');
  assert.deepEqual(s.guests.map((g) => [g.vmid, g.type, g.status, g.template]), [[100, 'qemu', 'running', false], [101, 'qemu', 'stopped', false], [200, 'lxc', 'running', false], [9000, 'qemu', 'stopped', true]]);
  assert.deepEqual(s.guests[0].tags, ['prod', 'web']);
  assert.equal(s.guests[2].hastate, 'started');
  assert.deepEqual(s.storages.map((x) => x.id), ['storage/pve1/local', 'storage/pve1/local-lvm', 'storage/pve2/local', 'storage/nas']);
  const nas = s.storages.find((x) => x.storage === 'nas');
  assert.equal(nas.shared, true);
  assert.equal(nas.node, null);
  assert.deepEqual(nas.nodes, ['pve1', 'pve2']);
  assert.deepEqual(s.backups.map((b) => [b.node, b.vmid, b.ok]), [['pve2', 200, true], ['pve1', 100, true], ['pve1', null, true]], 'newest first; WARNINGS count as done');
  assert.deepEqual(s.ha, { quorum: 'OK', master: 'pve1', services: 1, errors: [] });
});

test('snapshot: a single node without cluster, offline node, running tasks and failed backups', () => {
  const fx = fixture();
  const status = fx.cluster_status.filter((x) => x.type === 'node' && x.name === 'pve1');
  const res = fx.cluster_resources.map((r) => (r.id === 'node/pve2' ? { ...r, status: 'offline' } : r));
  const tasks = [
    { upid: 'UPID:pve1:0002A1B4:01F4C2D1:66F1A100:vzdump:101:root@pam:', type: 'vzdump', id: '101', starttime: 1727111300, endtime: 1727111320, status: 'job errors' },
    { upid: 'UPID:pve1:0002A1B5:01F4C2D1:66F1A200:vzdump:100:root@pam:', type: 'vzdump', id: '100', starttime: 1727111400 }, // still running
  ];
  const s = snapshot.normalize({ clusterStatus: status, resources: res, nodeStatus: {}, tasks: { pve1: { data: tasks } }, ha: null }, 5);
  assert.equal(s.cluster, null);
  assert.equal(s.version, null);
  assert.deepEqual(s.nodes.map((n) => [n.name, n.online]), [['pve1', true], ['pve2', false]]);
  assert.deepEqual(s.backups.map((b) => [b.vmid, b.ok, b.status]), [[101, false, 'job errors']]);
  assert.equal(snapshot.taskOk('OK'), true);
  assert.equal(snapshot.taskOk('WARNINGS: 2'), true);
  assert.equal(snapshot.taskOk('unexpected status'), false);
  assert.equal(snapshot.pct(45, 50), 90);
  assert.equal(snapshot.pct(1, 0), null);
});

test('fakePve answers the documented shape { data } (fixture sanity)', async () => {
  const fake = fakePve();
  const r = await fake.fetch('/api2/json/version', { headers: { authorization: `PVEAPIToken=${TOKEN_ID}=${SECRET}` } });
  assert.deepEqual(Object.keys(JSON.parse(r.body)), ['data']);
});
