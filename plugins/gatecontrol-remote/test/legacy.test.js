'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, snapshot, rdpDevice, MARC, SABINE, LEA, TIM } = require('./helpers');

test('the take-over keeps ids, settings, credential handles, access lists and the history', async () => {
  const { host, adminReq, req } = await setup({ remote: { l4: [{ peerId: 7, host: '192.168.1.20', port: 3389, listenPort: 13389 }] } });
  try {
    const snap = snapshot(host);
    const r = await host.legacyImport(snap);
    assert.equal(r.ok, true);
    assert.equal(r.counts.devices, 4);
    assert.equal(r.counts.sessions, 2);
    assert.equal(r.counts.listenerErrors, 0);
    const list = (await adminReq('GET', 'devices')).devices;
    assert.deepEqual(list.map((d) => d.id).sort(), [3, 4, 5, 6]);
    const pc = list.find((d) => d.id === 3);
    assert.equal(pc.source, 'import');
    assert.equal(pc.config.browser_enabled, true);
    assert.deepEqual(pc.config.tags, ['büro']);
    assert.deepEqual(pc.access.users, [MARC.id]);
    assert.deepEqual(pc.credential.has, { username: true, password: true, domain: true, privateKey: false, passphrase: false });
    // the gateway target reuses the L4 port of its old route
    const gw = list.find((d) => d.id === 5);
    assert.equal(gw.listener, 'route-5');
    assert.equal(host.remote.listeners.get('route-5').shared, true);
    // maintenance window and token list
    const tok = list.find((d) => d.id === 6);
    assert.equal(tok.config.maintenance_enabled, true);
    assert.deepEqual(tok.access.tokens, [77]);
    // rights: who saw a target gets the right of its protocol
    const m = await adminReq('GET', 'rights');
    const p = (id) => m.people.find((x) => x.id === id);
    assert.equal(p(MARC.id).set.rdp, true, 'Marc saw the open and his own targets');
    assert.equal(p(LEA.id).set.ssh, true, 'Lea saw the SSH target of the family');
    assert.equal(p(SABINE.id).set.ssh, null, 'Sabine did not');
    assert.equal(p(SABINE.id).set.rdp, true, 'the open targets: everybody');
    assert.deepEqual((await req(MARC, 'GET', '/overview')).devices.map((d) => d.id).sort(), [3, 5], 'Marc: his own, the open one; never the token-only one');
    // the history, ids kept
    const hist = (await adminReq('GET', 'sessions')).sessions;
    assert.deepEqual(hist.map((s) => s.id), [42, 41]);
    assert.equal(hist[1].tokenName, 'Marc Laptop');
    assert.equal(hist[1].durationSeconds, 3600);
    assert.equal(hist[1].imported, true);
    assert.equal(hist[1].startedAt, '2026-10-01T08:00:00.000Z');
    const set = await adminReq('GET', 'settings');
    assert.equal(set.import.runs, 1);
    assert.equal(set.import.counts.devices, 4);
  } finally { await host.close(); }
});

test('"Erneut übernehmen" replaces the taken-over devices, keeps the own ones and an administrator\'s decisions', async () => {
  const { host, adminReq } = await setup({ remote: { l4: [{ peerId: 7, host: '192.168.1.20', port: 3389, listenPort: 13389 }] } });
  try {
    await host.legacyImport(snapshot(host));
    const own = (await adminReq('POST', 'devices', rdpDevice({ top: { name: 'Eigenes Gerät' } }))).device;
    await adminReq('PUT', 'devices/3', { name: 'Geändert' });
    await adminReq('PUT', 'rights/user/' + SABINE.id, { rdp: false });
    // the next snapshot: target 6 is gone
    const s2 = snapshot(host);
    s2.routes = s2.routes.filter((r) => r.id !== 6);
    const r = await host.legacyImport(s2);
    assert.equal(r.counts.devices, 3);
    const list = (await adminReq('GET', 'devices')).devices;
    assert.deepEqual(list.map((d) => d.id).sort((a, b) => a - b), [3, 4, 5, own.id]);
    assert.equal(list.find((d) => d.id === 3).name, 'Büro-PC', 'taken-over devices are replaced');
    assert.equal((await adminReq('GET', 'rights')).people.find((x) => x.id === SABINE.id).set.rdp, false, 'never taken away');
    assert.equal((await adminReq('GET', 'settings')).import.runs, 2);
    assert.equal([...host.remote.vault.values()].filter((v) => v.source === 'rdp_route:3').length, 1, 'the same handle again');
    assert.equal((await adminReq('GET', 'sessions')).sessions.length, 2);
  } finally { await host.close(); }
});

test('an unreadable credential and a gateway port that cannot be reused are reported, not fatal', async () => {
  const { host, adminReq } = await setup({ remote: { l4: [{ peerId: 7, host: '192.168.9.9', port: 3389, listenPort: 13389 }] } });
  try {
    const s = snapshot(host);
    s.routes[0].credential_unreadable = true;
    const r = await host.legacyImport(s);
    assert.equal(r.counts.unreadable, 1);
    assert.equal(r.counts.listenerErrors, 1);
    const list = (await adminReq('GET', 'devices')).devices;
    assert.equal(list.find((d) => d.id === 3).credential.readable, false);
    assert.equal(list.find((d) => d.id === 5).listenerError, 'ERR_REMOTE_PORT_IN_USE');
    assert.equal(TIM.id, 5);
  } finally { await host.close(); }
});
