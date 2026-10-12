'use strict';

// Control of VMs and containers (administrators only, confirmed in the page,
// logged): start, shutdown (clean, ACPI / container init), stop (hard, like
// pulling the plug), reboot. A node reboot or shutdown is deliberately NOT
// offered.
//
//   1. GET  /cluster/resources?type=vm            where the guest is now (node, type, status)
//   2. POST /nodes/{node}/{qemu|lxc}/{vmid}/status/{action}   → UPID of the task
//   3. GET  /nodes/{node}/tasks/{upid}/status    until status 'stopped' (exitstatus 'OK' or the error)
//
// The request waits a little for the task (timing.waitMs); a task still
// running afterwards is followed by the page (GET /actions/:id) and by the
// background run, until it ends or its time is up (TIMEOUT_MS: the task may
// still run in Proxmox, the page says so).

const store = require('./store');
const poll = require('./poll');
const { codeError, validVmid, upidNode, ACTIONS } = require('./pve');

const TIMEOUT_MS = Object.freeze({ start: 180000, shutdown: 330000, stop: 120000, reboot: 330000 });
const timing = { waitMs: 8000, pollMs: 1500, timeoutMs: 6000 }; // within the host's 30 s request limit

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Which status an action needs. */
function allowed(action, status) {
  if (action === 'start') return status === 'stopped';
  return status === 'running' || status === 'paused';
}

/** One look at the task of a running action; finishes it when the task ended or its time is up. */
async function refresh(gc, action, { now = Date.now(), client = null } = {}) {
  if (!action || action.status !== 'running') return action;
  if (!action.upid) return store.finishAction(gc, action.id, { status: 'error', exitstatus: 'no task', finished_at: now });
  const host = await store.getHost(gc, action.host_id);
  if (!host) return store.finishAction(gc, action.id, { status: 'error', exitstatus: 'connection removed', finished_at: now });
  let st = null;
  try {
    const c = client || await poll.clientFor(gc, host, { timeoutMs: timing.timeoutMs });
    st = await c.taskStatus(upidNode(action.upid) || action.node, action.upid);
  } catch (e) {
    if (now - action.started_at > TIMEOUT_MS[action.action]) return store.finishAction(gc, action.id, { status: 'timeout', exitstatus: null, finished_at: now });
    return action; // try again
  }
  if (st && st.status === 'stopped') {
    const exit = st.exitstatus == null ? '' : String(st.exitstatus);
    const ok = exit === 'OK' || /^WARNINGS?:/i.test(exit);
    const done = await store.finishAction(gc, action.id, { status: ok ? 'ok' : 'error', exitstatus: exit || null, finished_at: now });
    gc.log.info('proxmox action finished', `#${action.id}`, action.action, `${action.guest_type}/${action.vmid}`, ok ? 'ok' : 'error');
    if (ok) {
      // the page shows the new state right away: the next poll of this connection is due now
      await store.updateHost(gc, host.id, { next_poll_at: 0 });
    }
    return done;
  }
  if (now - action.started_at > TIMEOUT_MS[action.action]) {
    gc.log.warn('proxmox action timed out', `#${action.id}`, action.action, `${action.guest_type}/${action.vmid}`);
    return store.finishAction(gc, action.id, { status: 'timeout', exitstatus: null, finished_at: now });
  }
  return action;
}

/**
 * Run `action` on guest `vmid` of connection `host` for the administrator `user`.
 * → the action (status running | ok | error)
 */
async function run(gc, host, vmid, action, user) {
  if (!ACTIONS.includes(action)) throw codeError('ACTION_INVALID');
  if (!validVmid(vmid)) throw codeError('NOT_FOUND');
  const client = await poll.clientFor(gc, host, { timeoutMs: timing.timeoutMs });
  // where the guest is right now (it may have migrated since the last poll)
  const vms = await client.resources('vm');
  const g = vms.find((r) => r && Number(r.vmid) === vmid && (r.type === 'qemu' || r.type === 'lxc'));
  if (!g) throw codeError('GUEST_NOT_FOUND');
  if (Number(g.template) === 1) throw codeError('GUEST_TEMPLATE');
  if (!allowed(action, String(g.status || ''))) throw codeError('GUEST_STATE');
  const node = String(g.node || '');
  const upid = await client.guestAction(node, g.type, vmid, action);
  const started = Date.now();
  let a = await store.addAction(gc, {
    host_id: host.id, node, guest_type: g.type, vmid, guest_name: typeof g.name === 'string' ? g.name.slice(0, 120) : '', action, upid,
    status: 'running', user_id: Number.isInteger(user && user.id) ? user.id : null, user_name: user && user.name ? String(user.name).slice(0, 120) : null, started_at: started,
  });
  gc.log.info('proxmox action', `#${a.id}`, action, `${g.type}/${vmid}`, `on ${node}`, `connection ${host.id}`, `by ${a.user_name || a.user_id || '?'}`);
  const until = started + timing.waitMs;
  while (a.status === 'running' && Date.now() < until) {
    await sleep(timing.pollMs);
    a = await refresh(gc, a, { client, now: Date.now() });
  }
  return a;
}

/** Background: follow actions whose task is still running. */
async function refreshRunning(gc, { now = Date.now() } = {}) {
  for (const a of await store.runningActions(gc)) {
    try { await refresh(gc, a, { now }); } catch (e) { gc.log.warn('proxmox action check failed', `#${a.id}`, (e && e.code) || 'error'); }
  }
}

module.exports = { run, refresh, refreshRunning, allowed, TIMEOUT_MS, timing };
