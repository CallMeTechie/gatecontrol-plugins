'use strict';

// Control of VMs and containers (server/control.js): administrators only, an
// explicit confirmation (a hard stop twice), the guest located fresh, the
// UPID task followed until it ends or times out, everything logged.

const test = require('node:test');
const assert = require('node:assert/strict');
const control = require('../server/control');
const store = require('../server/store');
const { withHost, asAdmin, addHost, shortWait, ADA, ADMIN, SECRET } = require('./helpers');

control.timing.pollMs = 1;
// generous: the wait ends as soon as the task does — a fixed short wait made a loaded CI runner give up
// before the first status poll ('running' instead of the result); a task that must outlast the wait never
// ends (taskPolls: Infinity) and runs with a short wait (shortWait)
control.timing.waitMs = 10000;

const act = (host, id, vmid, body, user = ADMIN) => host.request({ method: 'POST', path: `/hosts/${id}/guests/${vmid}/action`, body, user });

test('shutdown: guest located, POST …/qemu/100/status/shutdown, task polled until stopped/OK, logged with the admin', async () => {
  await withHost({ pveOpts: { taskPolls: 2 } }, async (host, fake) => {
    const id = await addHost(host);
    fake.calls.length = 0;
    const r = await act(host, id, 100, { action: 'shutdown', confirm: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const a = r.json.action;
    assert.equal(a.status, 'ok');
    assert.equal(a.exitstatus, 'OK');
    assert.equal(a.node, 'pve1');
    assert.equal(a.guest_type, 'qemu');
    assert.equal(a.user_name, 'admin');
    assert.equal(a.status_text, 'erledigt');
    assert.equal(a.upid, undefined, 'the page does not need the UPID');
    const p = fake.calls.map((c) => `${c.method} ${c.path.replace(/tasks\/[^/]+\/status/, 'tasks/<upid>/status')}`);
    assert.deepEqual(p, [
      'GET /api2/json/cluster/resources?type=vm',
      'POST /api2/json/nodes/pve1/qemu/100/status/shutdown',
      'GET /api2/json/nodes/pve1/tasks/<upid>/status',
      'GET /api2/json/nodes/pve1/tasks/<upid>/status',
      'GET /api2/json/nodes/pve1/tasks/<upid>/status',
    ]);
    assert.ok(host.logs.some((l) => l.level === 'info' && /proxmox action #1 shutdown qemu\/100 on pve1 connection 1 by admin/.test(l.message)));
    assert.ok(host.logs.some((l) => /proxmox action finished #1 shutdown qemu\/100 ok/.test(l.message)));
    // the next poll is due right away (the page shows the new state)
    assert.equal((await store.getHost(host.gc, id)).next_poll_at, 0);
    const list = (await asAdmin(host, 'GET', '/status')).json.actions;
    assert.equal(list[0].action, 'shutdown');
    assert.equal(list[0].status, 'ok');
  });
});

test('container start and reboot use the lxc path; the node comes from Proxmox, not the stored snapshot (migrated guest)', async () => {
  await withHost({}, async (host, fake) => {
    const id = await addHost(host);
    // the container migrated to pve1 since the last poll
    fake.fx.cluster_resources.find((r) => r.vmid === 200).node = 'pve1';
    fake.calls.length = 0;
    const r = await act(host, id, 200, { action: 'reboot', confirm: true });
    assert.equal(r.json.action.status, 'ok');
    assert.ok(fake.calls.some((c) => c.method === 'POST' && c.path === '/api2/json/nodes/pve1/lxc/200/status/reboot'));
    const s = await act(host, id, 101, { action: 'start', confirm: true });
    assert.equal(s.json.action.status, 'ok');
    assert.ok(fake.calls.some((c) => c.method === 'POST' && c.path === '/api2/json/nodes/pve1/qemu/101/status/start'));
  });
});

test('a task ending with an error → status error with Proxmox exit status', async () => {
  await withHost({ pveOpts: { taskExit: "can't lock file '/var/lock/qemu-server/lock-100.conf' - got timeout" } }, async (host) => {
    const id = await addHost(host);
    const r = await act(host, id, 100, { action: 'reboot', confirm: true });
    assert.equal(r.json.action.status, 'error');
    assert.match(r.json.action.exitstatus, /can't lock file/);
    assert.equal(r.json.action.status_text, 'fehlgeschlagen');
  });
});

test('a task still running after the wait: the page follows it (GET /actions/:id), then it finishes; time out after the limit', () => shortWait(async () => {
  await withHost({ pveOpts: { taskPolls: Infinity } }, async (host, fake) => {
    const id = await addHost(host);
    const r = await act(host, id, 100, { action: 'shutdown', confirm: true });
    const a = r.json.action;
    assert.equal(a.status, 'running');
    const g1 = await asAdmin(host, 'GET', `/actions/${a.id}`);
    assert.equal(g1.json.action.status, 'running');
    // the task ends
    for (const t of fake.tasks.values()) t.polls = 0;
    const g2 = await asAdmin(host, 'GET', `/actions/${a.id}`);
    assert.equal(g2.json.action.status, 'ok');
    assert.ok(g2.json.action.finished_at >= a.started_at);
    // another one that never ends: the background run gives up after the limit
    const r2 = await act(host, id, 101, { action: 'start', confirm: true });
    assert.equal(r2.json.action.status, 'running');
    const row = await store.getAction(host.gc, r2.json.action.id);
    await control.refreshRunning(host.gc, { now: row.started_at + control.TIMEOUT_MS.start + 1000 });
    const done = await store.getAction(host.gc, row.id);
    assert.equal(done.status, 'timeout');
    assert.ok(host.logs.some((l) => l.level === 'warn' && /timed out/.test(l.message)));
    assert.equal((await asAdmin(host, 'GET', '/actions/999')).status, 404);
  });
}));

test('tick follows running tasks', () => shortWait(async () => {
  await withHost({ pveOpts: { taskPolls: Infinity } }, async (host, fake) => {
    const id = await addHost(host);
    const r = await act(host, id, 100, { action: 'stop', confirm: true, confirm_hard: true });
    assert.equal(r.json.action.status, 'running');
    for (const t of fake.tasks.values()) t.polls = 0;
    await host.tick();
    assert.equal((await store.getAction(host.gc, r.json.action.id)).status, 'ok');
  });
}));

test('confirmation: missing → 400 CONFIRM_REQUIRED, a hard stop needs confirm_hard too; nothing reaches Proxmox', async () => {
  await withHost({}, async (host, fake) => {
    const id = await addHost(host);
    fake.calls.length = 0;
    for (const body of [{ action: 'shutdown' }, { action: 'shutdown', confirm: 'yes' }, { action: 'stop', confirm: true }, { action: 'stop', confirm: true, confirm_hard: 'true' }]) {
      const r = await act(host, id, 100, body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.json.code, 'CONFIRM_REQUIRED');
    }
    const bad = await act(host, id, 100, { action: 'destroy', confirm: true });
    assert.equal(bad.json.code, 'ACTION_INVALID');
    assert.equal(fake.calls.length, 0);
  });
});

test('administrators only: a portal viewer (even an admin) and a non-admin are refused before anything happens', async () => {
  await withHost({}, async (host, fake) => {
    const id = await addHost(host);
    fake.calls.length = 0;
    const viewers = [{ ...ADA }, { ...ADA, portal: true, loggedIn: true }, { ...ADMIN, portal: true, loggedIn: true }, null];
    for (const user of viewers) {
      const r = await host.request({ method: 'POST', path: `/hosts/${id}/guests/100/action`, body: { action: 'start', confirm: true }, user });
      assert.equal(r.status, 403, JSON.stringify(user));
      assert.equal(r.json.code, 'FORBIDDEN');
    }
    assert.equal(fake.calls.length, 0);
    assert.equal((await store.recentActions(host.gc)).length, 0);
  });
});

test('state checks: start on a running guest, shutdown of a stopped one, a template, an unknown VMID, a disabled connection', async () => {
  await withHost({}, async (host, fake) => {
    const id = await addHost(host);
    assert.equal((await act(host, id, 100, { action: 'start', confirm: true })).json.code, 'GUEST_STATE');
    assert.equal((await act(host, id, 101, { action: 'shutdown', confirm: true })).json.code, 'GUEST_STATE');
    assert.equal((await act(host, id, 9000, { action: 'start', confirm: true })).json.code, 'GUEST_TEMPLATE');
    const nf = await act(host, id, 555, { action: 'start', confirm: true });
    assert.equal(nf.status, 404);
    assert.equal(nf.json.code, 'GUEST_NOT_FOUND');
    assert.equal((await act(host, id, 12, { action: 'start', confirm: true })).status, 404, 'VMIDs start at 100');
    assert.ok(!fake.calls.some((c) => c.method === 'POST'));
    await asAdmin(host, 'PUT', `/hosts/${id}`, { enabled: false });
    assert.equal((await act(host, id, 101, { action: 'start', confirm: true })).json.code, 'HOST_DISABLED');
  });
});

test('missing privilege (403 on the POST) → PVE_FORBIDDEN with a hint, no action stored', async () => {
  await withHost({}, async (host, fake) => {
    const id = await addHost(host);
    fake.fail = (p, o) => (o.method === 'POST' ? { status: 403 } : undefined);
    const r = await act(host, id, 101, { action: 'start', confirm: true });
    assert.equal(r.status, 502);
    assert.equal(r.json.code, 'PVE_FORBIDDEN');
    assert.match(r.json.error, /VM\.PowerMgmt/);
    assert.equal((await store.recentActions(host.gc)).length, 0);
  });
});

test('no secret in any answer or log of a control flow', async () => {
  await withHost({}, async (host) => {
    const id = await addHost(host);
    const r = await act(host, id, 100, { action: 'shutdown', confirm: true });
    const st = await asAdmin(host, 'GET', '/status');
    assert.ok(!JSON.stringify([r, st]).includes(SECRET));
    assert.ok(!JSON.stringify(host.logs).includes(SECRET));
  });
});
