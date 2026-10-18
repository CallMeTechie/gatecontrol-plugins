'use strict';

// Notifications (server/alerts.js): the pure evaluate() for every topic —
// nothing on a first sighting, recovery messages, the stop through the
// plugin, thresholds and hysteresis — and the glue: restart-safe state in
// gc.storage, recipients, facts, the shared notifier's budget.

const test = require('node:test');
const assert = require('node:assert/strict');
const alerts = require('../server/alerts');
const control = require('../server/control');
const store = require('../server/store');
const { withHost, asAdmin, addHost, ADMIN, ADMIN2, SECRET } = require('./helpers');

control.timing.pollMs = 1;
// generous: the wait ends as soon as the task does — a fixed short wait made a loaded CI runner give up
// before the first status poll ('running' instead of the result); a task that must outlast the wait never
// ends (taskPolls: Infinity) and runs with a short wait (shortWait)
control.timing.waitMs = 10000;

const MIN = 60000;
const CFG = { storagePct: 90, cpuPct: 0, ramPct: 0, loadMin: 15, downMin: 5, lang: 'de' };
const HOST = { id: 1, name: 'Homelab' };
const T0 = Date.UTC(2026, 9, 12, 10, 0, 0);

function obs(over = {}) {
  return {
    host: HOST, reachable: true,
    nodes: [{ name: 'pve1', online: true }, { name: 'pve2', online: true }],
    guests: [{ vmid: 100, name: 'web', type: 'qemu', node: 'pve1', status: 'running', stoppedByPlugin: false }],
    storages: [{ id: 'storage/pve1/local-lvm', storage: 'local-lvm', node: 'pve1', used: 80, total: 100 }],
    backups: [{ upid: 'UPID:pve1:00000001:00000001:66F1A000:vzdump:100:root@pam:', node: 'pve1', vmid: 100, ok: true, status: 'OK' }],
    load: [{ node: 'pve1', cpu: 10, ram: 40 }],
    ...over,
  };
}
const down = (error = 'PVE_UNREACHABLE') => ({ host: HOST, reachable: false, error });

/** evaluate() over a sequence of [minutes, observation, cfg?] → events per step */
function run(steps, cfg = CFG, start = null) {
  let memo = start;
  return steps.map(([min, o, c]) => {
    const r = alerts.evaluate(memo, [o], c || cfg, T0 + min * MIN);
    memo = JSON.parse(JSON.stringify(r.memo)); // through gc.storage
    return r.events;
  });
}

test('first run: nothing is announced — offline node, stopped guest, full storage, failed backup are only recorded', () => {
  const o = obs({
    nodes: [{ name: 'pve1', online: true }, { name: 'pve2', online: false }],
    guests: [{ vmid: 100, name: 'web', type: 'qemu', node: 'pve1', status: 'stopped' }],
    storages: [{ id: 's1', storage: 'local-lvm', node: 'pve1', used: 95, total: 100 }],
    backups: [{ upid: 'UPID:pve1:00000002:00000001:66F1A000:vzdump:101:root@pam:', node: 'pve1', vmid: 101, ok: false, status: 'job errors' }],
    load: [{ node: 'pve1', cpu: 99, ram: 99 }],
  });
  const ev = run([[0, o], [10, o], [30, o]], { ...CFG, cpuPct: 80, ramPct: 80 });
  assert.deepEqual(ev, [[], [], []], 'what was already the case stays quiet');
  // a connection unreachable from the start: no alarm and no "reachable again"
  assert.deepEqual(run([[0, down()], [10, down()], [20, obs()]]), [[], [], []]);
});

test('connection unreachable for 5 minutes → one high alarm; reachable again → "wieder erreichbar"', () => {
  const ev = run([[0, obs()], [1, down()], [4, down()], [6, down('PVE_AUTH')], [9, down()], [12, obs()], [13, obs()]]);
  assert.deepEqual(ev.map((e) => e.map((x) => x.kind)), [[], [], [], ['host_down'], [], ['host_up'], []]);
  assert.equal(ev[3][0].minutes, 5);
  assert.equal(ev[3][0].error, 'PVE_AUTH');
  // back before 5 minutes: nothing at all
  assert.deepEqual(run([[0, obs()], [1, down()], [3, obs()], [4, down()], [8, down()]]).flat(), []);
});

test('cluster node offline for 5 minutes → node_down; online again → node_up', () => {
  const off = obs({ nodes: [{ name: 'pve1', online: true }, { name: 'pve2', online: false }] });
  const ev = run([[0, obs()], [1, off], [5, off], [7, off], [8, obs()]]);
  assert.deepEqual(ev.map((e) => e.map((x) => `${x.kind}:${x.node}`)), [[], [], [], ['node_down:pve2'], ['node_up:pve2']]);
  // a reboot (2 minutes offline): nothing
  assert.deepEqual(run([[0, obs()], [1, off], [3, obs()]]).flat(), []);
});

test('watched guest running → stopped is announced once; not when stopped through the plugin', () => {
  const stopped = (by) => obs({ guests: [{ vmid: 100, name: 'web', type: 'qemu', node: 'pve1', status: 'stopped', stoppedByPlugin: by }] });
  const ev = run([[0, obs()], [1, stopped(false)], [2, stopped(false)], [3, obs()], [4, stopped(true)], [5, obs()]]);
  assert.deepEqual(ev.map((e) => e.map((x) => x.topic)), [[], ['guest_stopped'], [], [], [], []]);
  assert.equal(ev[1][0].guest.vmid, 100);
  // stopped while the connection was unreachable: announced when it is back
  assert.deepEqual(run([[0, obs()], [1, down()], [2, stopped(false)]]).map((e) => e.map((x) => x.topic)), [[], [], ['guest_stopped']]);
  // a guest just marked "überwachen" while stopped: nothing
  assert.deepEqual(run([[0, obs({ guests: [] })], [1, stopped(false)]]).flat(), []);
});

test('observe(): only watched guests; a shutdown/stop/reboot through the plugin in the last 30 minutes suppresses', () => {
  const now = T0;
  const r = {
    host: HOST, ok: true, error: null,
    snapshot: {
      nodes: [], storages: [], backups: [],
      guests: [{ vmid: 100, name: 'a', type: 'qemu', node: 'pve1', status: 'stopped' }, { vmid: 101, name: 'b', type: 'qemu', node: 'pve1', status: 'stopped' }, { vmid: 102, name: 'c', type: 'lxc', node: 'pve1', status: 'stopped' }],
    },
  };
  const actions = new Map([
    [100, { action: 'shutdown', status: 'ok', started_at: now - 5 * MIN }],
    [101, { action: 'stop', status: 'ok', started_at: now - 31 * MIN }],
    [102, { action: 'shutdown', status: 'error', started_at: now - MIN }],
  ]);
  const o = alerts.observe(r, [100, 101, 102], actions, now);
  assert.deepEqual(o.guests.map((g) => [g.vmid, g.stoppedByPlugin]), [[100, true], [101, false], [102, false]]);
  assert.deepEqual(alerts.observe(r, [101], actions, now).guests.map((g) => g.vmid), [101]);
  assert.deepEqual(alerts.observe({ host: HOST, ok: false, error: 'PVE_TLS' }, [], new Map(), now), { host: HOST, reachable: false, error: 'PVE_TLS' });
});

test('storage almost full: at the threshold once, again only after dropping 2 points below it', () => {
  const st = (used) => obs({ storages: [{ id: 's1', storage: 'local-lvm', node: 'pve1', used, total: 100 }] });
  const ev = run([[0, st(80)], [1, st(90)], [2, st(95)], [3, st(89)], [4, st(91)], [5, st(87)], [6, st(92)]]);
  assert.deepEqual(ev.map((e) => e.length), [0, 1, 0, 0, 0, 0, 1]);
  assert.equal(ev[1][0].pct, 90);
  // own threshold
  assert.deepEqual(run([[0, st(60)], [1, st(75)]], { ...CFG, storagePct: 70 }).map((e) => e.length), [0, 1]);
});

test('backup (vzdump) failed: each new failed task once (priority high), OK and WARNINGS stay quiet, restart-safe', () => {
  const t = (n, ok, status = ok ? 'OK' : 'job errors') => ({ upid: `UPID:pve1:0000000${n}:00000001:66F1A00${n}:vzdump:10${n}:root@pam:`, node: 'pve1', vmid: 100 + n, ok, status });
  const ev = run([
    [0, obs({ backups: [t(1, true)] })],
    [1, obs({ backups: [t(2, false), t(1, true)] })],
    [2, obs({ backups: [t(2, false), t(1, true)] })],
    [3, obs({ backups: [t(4, false), t(3, true, 'WARNINGS: 1'), t(2, false)] })],
    [4, obs({ backups: [t(5, false), t(6, false), t(4, false)] })],
  ]);
  assert.deepEqual(ev.map((e) => e.map((x) => x.tasks.map((y) => y.vmid))), [[], [[102]], [], [[104]], [[105, 106]]]);
});

test('node load: off by default; at/above the threshold for load_minutes → once; below resets', () => {
  const l = (cpu, ram = 40) => obs({ load: [{ node: 'pve1', cpu, ram }] });
  assert.deepEqual(run([[0, l(10)], [1, l(99)], [30, l(99)]]).flat(), [], 'threshold 0 = off');
  const cfg = { ...CFG, cpuPct: 85, ramPct: 90, loadMin: 15 };
  const ev = run([[0, l(10)], [1, l(90)], [10, l(95)], [16, l(92)], [20, l(99)], [21, l(50)], [22, l(90)], [36, l(90, 95)], [52, l(90, 95)]], cfg);
  assert.deepEqual(ev.map((e) => e.map((x) => `${x.kind}:${x.minutes}`)), [[], [], [], ['cpu:15'], [], [], [], [], ['cpu:30', 'ram:16']]);
  // a node seen for the first time above the threshold: muted until it drops below
  assert.deepEqual(run([[0, l(99)], [20, l(99)], [40, l(99)]], cfg).flat(), []);
});

test('evaluate keeps connections without a result and drops nothing it was not asked about', () => {
  const r1 = alerts.evaluate(null, [obs()], CFG, T0);
  const r2 = alerts.evaluate(r1.memo, [{ ...obs(), host: { id: 2, name: 'B' } }], CFG, T0 + MIN);
  assert.ok(r2.memo.hosts['1'] && r2.memo.hosts['2']);
  assert.deepEqual(r2.events, []);
});

test('notifications: texts, priority, collapse key, facts with values (de and en)', async () => {
  await withHost({}, async (host) => {
    const gc = host.gc;
    const n = (ev, lang = 'de') => alerts.toNotification(gc, ev, { ...CFG, lang });
    const hd = n({ topic: 'unreachable', kind: 'host_down', host: HOST, minutes: 5, error: 'PVE_TLS', since: T0 });
    assert.equal(hd.title, 'Proxmox nicht erreichbar');
    assert.equal(hd.priority, 'high');
    assert.equal(hd.collapseKey, 'host:1');
    assert.match(hd.body, /Homelab antwortet seit 5 Minuten nicht \(Zertifikat nicht vertrauenswürdig\)/);
    assert.deepEqual(hd.data.facts.slice(0, 2), [{ label: 'Verbindung', value: 'Homelab' }, { label: 'Fehler', value: 'Zertifikat nicht vertrauenswürdig' }]);
    const up = n({ topic: 'unreachable', kind: 'host_up', host: HOST });
    assert.equal(up.collapseKey, 'host:1', 'replaces the alarm');
    assert.equal(up.priority, 'info');
    const g = n({ topic: 'guest_stopped', kind: 'stopped', host: HOST, guest: { vmid: 200, name: 'dns', type: 'lxc', node: 'pve2' } }, 'en');
    assert.equal(g.title, 'CT 200 stopped');
    assert.deepEqual(g.data.facts, [{ label: 'Guest', value: 'CT 200 · dns' }, { label: 'Node', value: 'pve2' }, { label: 'Connection', value: 'Homelab' }]);
    const s = n({ topic: 'storage_full', kind: 'full', host: HOST, storage: { id: 'storage/pve1/local-lvm', storage: 'local-lvm', node: 'pve1', used: 380 * 1024 ** 3, total: 400 * 1024 ** 3 }, pct: 95 });
    assert.equal(s.title, 'Speicher fast voll: local-lvm');
    assert.deepEqual(s.data.facts.slice(0, 3), [{ label: 'Speicher', value: 'local-lvm (pve1)' }, { label: 'Belegt', value: '95 %' }, { label: 'Frei', value: '20 GiB' }]);
    const b = n({ topic: 'backup_failed', kind: 'failed', host: HOST, tasks: [{ upid: 'U1', node: 'pve1', vmid: 101, status: 'job errors' }, { upid: 'U2', node: 'pve2', vmid: null, status: 'interrupted by signal' }] });
    assert.equal(b.title, '2 Backups fehlgeschlagen');
    assert.equal(b.priority, 'high');
    assert.match(b.body, /101 \(pve1\): job errors; alle Gäste \(pve2\): interrupted by signal/);
    const l = n({ topic: 'node_load', kind: 'ram', host: HOST, node: 'pve1', value: 93.5, threshold: 90, minutes: 15 }, 'en');
    assert.equal(l.title, 'High RAM usage on pve1');
    assert.ok(l.data.facts.length <= 6);
    for (const x of [hd, up, g, s, b, l]) {
      assert.match(x.collapseKey, /^[A-Za-z0-9_.:@/-]{1,120}$/);
      assert.equal(x.data.route, 'plg-gatecontrol-proxmox');
      assert.ok(x.data.facts.every((f) => f.label.length <= 60 && f.value.length <= 120));
    }
  });
});

test('check(): end to end over polls — recipients are the administrators, nothing twice after a restart', async () => {
  await withHost({}, async (host, fake) => {
    const id = await addHost(host); // first poll: recorded only
    assert.equal(host.notifications.length, 0);
    await asAdmin(host, 'PUT', `/hosts/${id}/guests/200/watch`, { watched: true });
    await asAdmin(host, 'POST', `/hosts/${id}/refresh`); // 200 seen running
    fake.fx.cluster_resources.find((r) => r.vmid === 200).status = 'stopped'; // stopped outside the plugin
    await asAdmin(host, 'POST', `/hosts/${id}/refresh`);
    assert.equal(host.notifications.length, 1);
    const n = host.notifications[0];
    assert.equal(n.topic, 'guest_stopped');
    assert.equal(n.title, 'CT 200 gestoppt');
    assert.deepEqual(n.users, [ADMIN.id, ADMIN2.id], 'only administrators');
    assert.ok(n.data.facts.length >= 2);
    // a restart (new process: fresh notifier, state from gc.storage) does not repeat it
    alerts.reset();
    await host.stop();
    await host.start();
    await asAdmin(host, 'POST', `/hosts/${id}/refresh`);
    await asAdmin(host, 'POST', `/hosts/${id}/refresh`);
    assert.equal(host.notifications.length, 1);
    assert.ok(host.kv.has(alerts.STATE_KEY));
    assert.ok(!JSON.stringify([...host.kv.values()]).includes(SECRET));
  });
});

test('check(): a guest shut down through the plugin is not announced', async () => {
  await withHost({}, async (host) => {
    const id = await addHost(host);
    await asAdmin(host, 'PUT', `/hosts/${id}/guests/100/watch`, { watched: true });
    await asAdmin(host, 'POST', `/hosts/${id}/refresh`);
    const r = await host.request({ method: 'POST', path: `/hosts/${id}/guests/100/action`, body: { action: 'shutdown', confirm: true }, user: ADMIN });
    assert.equal(r.json.action.status, 'ok');
    await asAdmin(host, 'POST', `/hosts/${id}/refresh`);
    const s = await store.snapshotOf(host.gc, id);
    assert.equal(s.guests.find((g) => g.vmid === 100).status, 'stopped');
    assert.equal(host.notifications.length, 0);
  });
});

test('check(): recipients "rule" leave users to the topic rule; storage and backup alarms through tick', async () => {
  await withHost({ settings: { notify_recipients: 'rule', storage_threshold: 80 } }, async (host, fake) => {
    const id = await addHost(host);
    const lvm = fake.fx.cluster_resources.find((r) => r.id === 'storage/pve1/local-lvm');
    lvm.disk = Math.round(lvm.maxdisk * 0.85); // 75 % → 85 %
    fake.fx.tasks.pve1.unshift({ upid: 'UPID:pve1:0002A1B9:01F4C2D1:66F1B100:vzdump:101:root@pam:', node: 'pve1', type: 'vzdump', id: '101', user: 'root@pam', starttime: 1727200000, endtime: 1727200100, status: 'job errors' });
    await store.updateHost(host.gc, id, { next_poll_at: 0 });
    await host.tick();
    assert.deepEqual(host.notifications.map((n) => n.topic).sort(), ['backup_failed', 'storage_full']);
    assert.ok(host.notifications.every((n) => n.users === null), 'the topic rule decides');
    assert.equal(host.notifications.find((n) => n.topic === 'backup_failed').priority, 'high');
  });
});

test('check(): connection unreachable for 5 minutes → high alarm with the error; once', async () => {
  await withHost({}, async (host, fake) => {
    const id = await addHost(host);
    fake.down = Object.assign(new Error('self-signed certificate in certificate chain'), { code: 'ERR_NET' });
    const poll = require('../server/poll');
    const config = require('../server/config');
    const cfg = config.fromSettings({});
    const t = Date.now();
    for (const m of [1, 3, 6, 8]) {
      const r = await poll.pollHost(host.gc, await store.getHost(host.gc, id), cfg, { now: t + m * MIN });
      await alerts.check(host.gc, [r], { now: t + m * MIN });
    }
    assert.equal(host.notifications.length, 1);
    assert.equal(host.notifications[0].topic, 'unreachable');
    assert.equal(host.notifications[0].priority, 'high');
    assert.match(host.notifications[0].body, /Zertifikat/);
  });
});

test('check(): held back by the hourly budget → tried again on the next run (not lost)', async () => {
  let block = true;
  await withHost({ notifyFail: () => (block ? 'ERR_RATE_LIMIT' : null) }, async (host, fake) => {
    const id = await addHost(host);
    await asAdmin(host, 'PUT', `/hosts/${id}/guests/200/watch`, { watched: true });
    await asAdmin(host, 'POST', `/hosts/${id}/refresh`);
    fake.fx.cluster_resources.find((r) => r.vmid === 200).status = 'stopped';
    await asAdmin(host, 'POST', `/hosts/${id}/refresh`);
    assert.equal(host.notifications.length, 0);
    block = false;
    alerts.reset(); // a new notifier (the old one remembers the host's refusal per code only)
    await asAdmin(host, 'POST', `/hosts/${id}/refresh`);
    assert.equal(host.notifications.length, 1);
    assert.equal(host.notifications[0].topic, 'guest_stopped');
  });
});

test('a removed connection leaves the stored state', async () => {
  await withHost({}, async (host) => {
    const id = await addHost(host);
    assert.ok((await host.gc.storage.get(alerts.STATE_KEY)).hosts[String(id)]);
    await asAdmin(host, 'DELETE', `/hosts/${id}`);
    const id2 = await addHost(host);
    const st = await host.gc.storage.get(alerts.STATE_KEY);
    assert.ok(!st.hosts[String(id)]);
    assert.ok(st.hosts[String(id2)]);
  });
});
