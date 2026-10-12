'use strict';

// Background polling (server/poll.js, tick): what is fetched, the last good
// data on errors, backoff, failing single nodes, the optional update list.

const test = require('node:test');
const assert = require('node:assert/strict');
const poll = require('../server/poll');
const store = require('../server/store');
const config = require('../server/config');
const { withHost, asAdmin, addHost } = require('./helpers');

const paths = (fake) => fake.calls.map((c) => c.path.replace(/\?.*$/, ''));

test('one poll reads version, cluster status/resources, per online node status and vzdump tasks, HA', async () => {
  await withHost({}, async (host, fake) => {
    const id = await addHost(host);
    assert.deepEqual(paths(fake).sort(), [
      '/api2/json/cluster/ha/status/current', '/api2/json/cluster/resources', '/api2/json/cluster/status',
      '/api2/json/nodes/pve1/status', '/api2/json/nodes/pve1/tasks', '/api2/json/nodes/pve2/status', '/api2/json/nodes/pve2/tasks', '/api2/json/version',
    ]);
    assert.ok(fake.calls.every((c) => c.method === 'GET'), 'polling only reads');
    assert.ok(!paths(fake).some((p) => p.includes('/apt/')), 'no update list unless switched on');
    const h = await store.getHost(host.gc, id);
    assert.equal(h.status, 'ok');
    assert.equal(h.pve_version, '8.2.4');
    assert.equal(h.cluster_name, 'homelab');
    assert.ok(h.next_poll_at > Date.now() + 50000 && h.next_poll_at <= Date.now() + 60000, 'next poll after the interval (60 s)');
    const s = (await asAdmin(host, 'GET', '/status')).json.hosts[0].snapshot;
    assert.equal(s.guests.length, 4);
    assert.equal(s.nodes.length, 2);
  });
});

test('an offline node is not asked; a node answering 595 keeps its error, the rest is stored', async () => {
  await withHost({}, async (host, fake) => {
    fake.fx.cluster_resources.find((r) => r.id === 'node/pve2').status = 'offline';
    fake.fx.cluster_status.find((r) => r.name === 'pve2').online = 0;
    const id = await addHost(host);
    assert.ok(!paths(fake).some((p) => p.startsWith('/api2/json/nodes/pve2')));
    let s = await store.snapshotOf(host.gc, id);
    assert.deepEqual(s.nodes.map((n) => [n.name, n.online]), [['pve1', true], ['pve2', false]]);
    // pve1 status fails with 595, its tasks still come
    fake.fail = (p) => (p === '/api2/json/nodes/pve1/status' ? { status: 595 } : undefined);
    await asAdmin(host, 'POST', `/hosts/${id}/refresh`);
    s = await store.snapshotOf(host.gc, id);
    assert.equal(s.nodes[0].error, 'PVE_NODE_DOWN');
    assert.equal(s.backups.length, 2);
    assert.equal((await store.getHost(host.gc, id)).status, 'ok');
  });
});

test('a failing connection keeps the last good data, counts errors and backs off (60 → 120 → 240 → 300 s)', async () => {
  await withHost({}, async (host, fake) => {
    const id = await addHost(host);
    const good = await store.snapshotOf(host.gc, id);
    fake.down = true;
    const cfg = config.fromSettings({});
    const now = Date.now();
    const delays = [];
    for (let i = 0; i < 5; i++) {
      const h = await store.getHost(host.gc, id);
      const r = await poll.pollHost(host.gc, h, cfg, { now });
      assert.equal(r.ok, false);
      assert.equal(r.error, 'PVE_UNREACHABLE');
      assert.deepEqual(r.snapshot, good, 'the last good snapshot comes along');
      delays.push(((await store.getHost(host.gc, id)).next_poll_at - now) / 1000);
    }
    assert.deepEqual(delays, [60, 120, 240, 300, 300]);
    const h = await store.getHost(host.gc, id);
    assert.equal(h.status, 'error');
    assert.equal(h.error_count, 5);
    assert.equal(h.last_error, 'PVE_UNREACHABLE');
    assert.deepEqual(await store.snapshotOf(host.gc, id), good);
    // the page shows the error and the last good data
    const v = (await asAdmin(host, 'GET', '/status')).json.hosts[0];
    assert.equal(v.status, 'error');
    assert.match(v.error_text, /nicht erreichbar/);
    assert.equal(v.snapshot.at, good.at);
    // logged once (first error) — not every time
    assert.equal(host.logs.filter((l) => l.message.startsWith('proxmox poll failed')).length, 1);
    // back again: errors reset
    fake.down = false;
    const r = await poll.pollHost(host.gc, await store.getHost(host.gc, id), cfg, { now: now + 1000 });
    assert.equal(r.ok, true);
    const h2 = await store.getHost(host.gc, id);
    assert.equal(h2.error_count, 0);
    assert.equal(h2.next_poll_at, now + 1000 + 60000);
  });
  assert.equal(poll.backoffMs(600, 3), 600000, 'a long interval is never shortened');
});

test('tick polls only due and enabled connections', async () => {
  await withHost({}, async (host, fake) => {
    const id = await addHost(host);
    fake.calls.length = 0;
    await host.tick();
    assert.equal(fake.calls.length, 0, 'not due yet');
    await store.updateHost(host.gc, id, { next_poll_at: 0 });
    await host.tick();
    assert.ok(fake.calls.length >= 6);
    fake.calls.length = 0;
    await asAdmin(host, 'PUT', `/hosts/${id}`, { enabled: false });
    await store.updateHost(host.gc, id, { next_poll_at: 0 });
    await host.tick();
    assert.equal(fake.calls.length, 0, 'disabled');
  });
});

test('settings: interval and thresholds within their ranges, changed settings poll soon', async () => {
  const c = config.fromSettings({ poll_interval: 5, storage_threshold: 120, cpu_threshold: '85', ram_threshold: -1, load_minutes: 30, notify_recipients: 'rule', notify_lang: 'en', show_updates: 'true' });
  assert.deepEqual([c.pollSec, c.storagePct, c.cpuPct, c.ramPct, c.loadMin, c.recipients, c.lang, c.showUpdates], [60, 90, 85, 0, 30, 'rule', 'en', true]);
  await withHost({ settings: { poll_interval: 300 } }, async (host) => {
    const id = await addHost(host);
    assert.ok((await store.getHost(host.gc, id)).next_poll_at > Date.now() + 290000);
    await host.settingsChanged({ poll_interval: 30 });
    assert.equal((await store.getHost(host.gc, id)).next_poll_at, 0);
  });
});

test('update list (show_updates): read-only GET apt/update per node, at most every 6 hours; 403 is shown, not fatal', async () => {
  await withHost({ settings: { show_updates: true } }, async (host, fake) => {
    fake.fail = (p) => (p === '/api2/json/nodes/pve2/apt/update' ? { status: 403 } : undefined);
    const id = await addHost(host);
    assert.ok(fake.calls.some((c) => c.path === '/api2/json/nodes/pve1/apt/update' && c.method === 'GET'));
    let s = await store.snapshotOf(host.gc, id);
    assert.equal(s.nodes[0].updates, 2);
    assert.equal(s.nodes[1].updates, null);
    assert.equal(s.nodes[1].updatesError, 'PVE_FORBIDDEN');
    assert.equal((await store.getHost(host.gc, id)).status, 'ok');
    fake.calls.length = 0;
    await asAdmin(host, 'POST', `/hosts/${id}/refresh`);
    assert.ok(!fake.calls.some((c) => c.path.includes('/apt/')), 'not again within 6 hours');
    s = await store.snapshotOf(host.gc, id);
    assert.equal(s.nodes[0].updates, 2, 'carried over');
    assert.ok(!fake.calls.some((c) => c.method !== 'GET'));
  });
});

test('HA status not readable (403) or not configured: no HA line, poll still ok', async () => {
  await withHost({}, async (host, fake) => {
    fake.fail = (p) => (p.includes('/cluster/ha/') ? { status: 403 } : undefined);
    const id = await addHost(host);
    const s = await store.snapshotOf(host.gc, id);
    assert.equal(s.ha, null);
    assert.equal((await store.getHost(host.gc, id)).status, 'ok');
  });
});

test('required calls failing (resources 403) → the connection failed with PVE_FORBIDDEN', async () => {
  await withHost({}, async (host, fake) => {
    fake.fail = (p) => (p.startsWith('/api2/json/cluster/resources') ? { status: 403 } : undefined);
    const r = await asAdmin(host, 'POST', '/hosts', { name: 'X', target_index: 0, token_id: 'gatecontrol@pve!monitor', token_secret: '0f3c9a52-7d1e-4b6a-9e2f-5a8c1d3b7e90' });
    const ref = await asAdmin(host, 'POST', `/hosts/${r.json.host.id}/refresh`);
    assert.equal(ref.json.result.ok, false);
    assert.equal(ref.json.result.error, 'PVE_FORBIDDEN');
    assert.match(ref.json.result.error_text, /Rechte/);
  });
});

test('/cluster/status not readable (403): the poll still works from /cluster/resources', async () => {
  await withHost({}, async (host, fake) => {
    fake.fail = (p) => (p === '/api2/json/cluster/status' ? { status: 403 } : undefined);
    const id = await addHost(host);
    const h = await store.getHost(host.gc, id);
    assert.equal(h.status, 'ok');
    const s = await store.snapshotOf(host.gc, id);
    assert.equal(s.cluster, null);
    assert.deepEqual(s.nodes.map((n) => [n.name, n.online]), [['pve1', true], ['pve2', true]]);
    const t = await asAdmin(host, 'POST', '/hosts/test', { target_index: 0, token_id: 'gatecontrol@pve!monitor', token_secret: '0f3c9a52-7d1e-4b6a-9e2f-5a8c1d3b7e90' });
    assert.deepEqual(t.json.result.nodes, ['pve1', 'pve2']);
    assert.equal(t.json.result.cluster, null);
  });
});
