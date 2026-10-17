'use strict';

// Quick actions, widgets and the Start tile of the GateControl apps
// (docs/plugins.md "Quick actions", "Widgets", "Start tiles in the apps") —
// for GateControl administrators only, like the plugin page; anybody else
// gets no actions and no tile, and every run checks the administrator again.
//
//   per enabled connection (device host:<id>, title = connection name)
//     refresh:<id>              button „Aktualisieren“ (poll now), carrying the
//                               connection's widget (power: false): guests running
//                               „5/7“, CPU, RAM and storage of the cluster, the
//                               reachability as the badge, problems as the status
//   per watched guest (device vm:<host>:<vmid>, title = guest name)
//     guest:<host>:<vmid>       toggle on = running: start / clean shutdown (never
//                               a hard stop), asks before shutting down only, honours
//                               a target state (on → start unless running, off →
//                               shut down unless stopped — else nothing to do);
//                               carries the guest's widget (power: true): CPU,
//                               RAM, uptime
//     reboot:<host>:<vmid>      button „Neustart“ (clean reboot, asks first)
//   Start tile „Proxmox“        all connections: guests running, CPU, RAM, storage
//
// Built from the stored status (no Proxmox call while listing). A run goes
// through the page's code (control.run / poll.pollHost): the guest is located
// fresh, the task followed, the action logged with the administrator's name
// and where it came from („App“, „Regel“ for another plugin's automation,
// „Benachrichtigung“) and kept in „Letzte Aktionen“. An answer that would pass
// the host's 10 s limit says the order is on its way; the run goes on.

const store = require('./store');
const config = require('./config');
const poll = require('./poll');
const control = require('./control');
const alerts = require('./alerts');
const snapshot = require('./snapshot');

const QA_MAX = 16;
const QA_BUDGET_MS = 8000;      // GateControl waits 10 s for runQuickAction
const QA_WAIT_MS = 4000;        // how long a run waits for the Proxmox task
const EXPECT_MS = 15 * 60000;   // an action's outcome shows until the next poll, at most this long
const ID_RE = /^(?:(refresh):([1-9][0-9]{0,9})|(guest|reboot):([1-9][0-9]{0,9}):([1-9][0-9]{0,9}))$/;

const ICONS = Object.freeze({
  server: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01M12 7h4M12 17h4',
  refresh: 'M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5',
  cpu: 'M7 7h10v10H7zM10 10h4v4h-4zM9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3',
  memory: 'M2 8h20v8H2zM6 11v2M10 11v2M14 11v2M18 11v2M5 16v3M19 16v3',
  disk: 'M4 5c0-1.7 3.6-3 8-3s8 1.3 8 3v14c0 1.7-3.6 3-8 3s-8-1.3-8-3zM4 5c0 1.7 3.6 3 8 3s8-1.3 8-3M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18zM12 7v5l3 3',
  play: 'M7 4v16l13-8z',
  stop: 'M6 6h12v12H6z',
  reboot: 'M4 12a8 8 0 1 0 2.34-5.66M4 4v5h5',
  qemu: 'M3 4h18v12H3zM8 20h8M12 16v4',
  lxc: 'M12 2l9 5v10l-9 5-9-5V7zM3 7l9 5 9-5M12 12v10',
  guests: 'M3 4h18v12H3zM8 20h8M12 16v4',
});
// the guest toggle per state: on = running (green play), off = stopped (neutral stop)
const GUEST_LOOK = Object.freeze({ on: { icon: ICONS.play, tone: 'good' }, off: { icon: ICONS.stop, tone: 'neutral' } });

let budgetMs = QA_BUDGET_MS;
const PENDING = Symbol('pending');

/** A GateControl administrator (the apps' viewer, or the user of another plugin's automation). */
function isAdmin(user) {
  return !!(user && typeof user === 'object' && user.role === 'admin' && Number.isInteger(user.id));
}

/** A text as the host takes it unchanged: no control characters, trimmed, at most `max` characters (… when cut). */
function clip(v, max) {
  let s = String(v == null ? '' : v).replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length > max) s = s.slice(0, max - 1).replace(/[\ud800-\udbff]$/, '').trimEnd() + '…';
  return s;
}

const pctInt = (used, total) => {
  const p = snapshot.pct(used, total);
  return p == null ? null : Math.round(p);
};

/** Seconds → „12 Min“, „5 Std“, „3 T“. */
function uptimeText(sec, t, lang) {
  const s = Number(sec);
  if (!Number.isFinite(s) || s <= 0) return null;
  if (s < 3600) return t(lang, 'uptime.min', { n: Math.max(1, Math.floor(s / 60)) });
  if (s < 86400) return t(lang, 'uptime.h', { n: Math.floor(s / 3600) });
  return t(lang, 'uptime.d', { n: Math.floor(s / 86400) });
}

/** Where the run came from, for the log and „Letzte Aktionen“. */
function routeOf(via, automation) {
  if (automation === true) return 'Regel';
  return via === 'notification' ? 'Benachrichtigung' : 'App';
}

// ─── Facts from the stored status ───────────────

/** Sums over the nodes / storages of one or more snapshots. */
function sums(snaps) {
  const s = { guests: 0, running: 0, cpu: 0, cpus: 0, mem: 0, maxmem: 0, disk: 0, maxdisk: 0, any: false };
  for (const snap of snaps) {
    if (!snap) continue;
    s.any = true;
    for (const g of snap.guests || []) {
      if (g.template) continue;
      s.guests++;
      if (g.status === 'running') s.running++;
    }
    for (const n of snap.nodes || []) {
      if (!n.online) continue;
      if (n.cpu != null && n.maxcpu) { s.cpu += n.cpu * n.maxcpu; s.cpus += n.maxcpu; }
      if (n.mem != null && n.maxmem) { s.mem += n.mem; s.maxmem += n.maxmem; }
    }
    for (const st of snap.storages || []) {
      if (st.used != null && st.total) { s.disk += st.used; s.maxdisk += st.total; }
    }
  }
  return {
    any: s.any, guests: s.guests, running: s.running,
    cpu: s.cpus ? Math.round((s.cpu / s.cpus) * 100) : null,
    ram: pctInt(s.mem, s.maxmem),
    storage: pctInt(s.disk, s.maxdisk),
  };
}

/** One connection: reachability, totals and the most important problem. */
function hostFacts(h, snap, cfg, t, lang, errorText) {
  const f = sums([snap]);
  const reachable = h.status === 'ok' ? true : (h.status === 'error' ? false : null);
  const offline = snap ? (snap.nodes || []).filter((n) => !n.online).map((n) => n.name) : [];
  let full = null;
  for (const st of (snap && snap.storages) || []) {
    const p = snapshot.pct(st.used, st.total);
    if (p != null && p >= cfg.storagePct && (!full || p > full.pct)) full = { storage: st.storage, pct: Math.round(p) };
  }
  let status = null;
  let state = reachable ? 'good' : null;
  if (reachable === false) {
    status = errorText(h.last_error, lang) || t(lang, 'error.PVE_UNREACHABLE'); // the badge says „Nicht erreichbar“
    state = 'crit';
  } else if (!snap) status = t(lang, 'widget.status_no_data');
  else if (offline.length) {
    status = offline.length === 1 ? t(lang, 'widget.status_node_offline', { node: offline[0] }) : t(lang, 'widget.status_nodes_offline', { n: offline.length });
    state = 'warn';
  } else if (full) {
    status = t(lang, 'widget.status_storage', full);
    state = 'warn';
  }
  return { ...f, reachable, offline, full, status, state };
}

/** The connection's widget, carried by its refresh button. */
function hostWidget(f, cfg, t, lang) {
  const w = {
    label: clip(t(lang, 'widget.guests'), 24), value: f.any ? `${f.running}/${f.guests}` : null, unit: null,
    status: f.status ? clip(f.status, 60) : null, state: f.state, readings: [], controls: [], power: false,
  };
  // a value at a notification threshold of the settings is marked (CPU / RAM: when switched on)
  const reading = (id, label, value, icon, warn) => {
    if (value == null) return;
    const r = { id, label: clip(t(lang, label), 20), value, unit: '%', icon };
    if (warn) r.state = 'warn';
    w.readings.push(r);
  };
  reading('cpu', 'widget.cpu', f.cpu, ICONS.cpu, cfg.cpuPct > 0 && f.cpu >= cfg.cpuPct);
  reading('ram', 'widget.ram', f.ram, ICONS.memory, cfg.ramPct > 0 && f.ram >= cfg.ramPct);
  reading('storage', 'widget.storage', f.storage, ICONS.disk, !!f.full);
  const label = f.reachable === true ? 'widget.reachable' : (f.reachable === false ? 'widget.unreachable' : 'widget.not_polled');
  w.badge = { icon: ICONS.server, label: clip(t(lang, label), 20) };
  if (f.reachable != null) w.badge.state = f.reachable ? 'good' : 'crit';
  return w;
}

/**
 * The state the apps show for a guest: the outcome of the latest action through
 * the plugin while it runs or until the next poll saw it, else the polled status.
 */
function guestState(g, snap, latest) {
  const a = latest || null;
  const fresh = a && (a.status === 'running' || (a.status === 'ok' && a.finished_at != null && a.finished_at > ((snap && snap.at) || 0)));
  if (fresh) return { state: a.action === 'start' || a.action === 'reboot' ? 'on' : 'off', pending: a.status === 'running' ? a.action : null };
  if (!g) return { state: null, pending: null };
  if (g.status === 'running' || g.status === 'paused') return { state: 'on', pending: null };
  if (g.status === 'stopped') return { state: 'off', pending: null };
  return { state: null, pending: null };
}

/** The guest's widget, carried by its toggle (the guest's on/off switch). */
function guestWidget(h, g, snap, gs, t, lang) {
  const running = g && g.status === 'running' && !gs.pending;
  const w = {
    label: clip(t(lang, 'widget.cpu'), 24), value: running && g.cpu != null ? Math.round(g.cpu * 100) : null, unit: running && g.cpu != null ? '%' : null,
    status: null, state: gs.state, readings: [], controls: [], power: true,
  };
  if (running) {
    const ram = pctInt(g.mem, g.maxmem);
    if (ram != null) w.readings.push({ id: 'ram', label: clip(t(lang, 'widget.ram'), 20), value: ram, unit: '%', icon: ICONS.memory });
    const up = uptimeText(g.uptime, t, lang);
    if (up) w.readings.push({ id: 'uptime', label: clip(t(lang, 'widget.uptime'), 20), value: clip(up, 16), icon: ICONS.clock });
  }
  const node = g && snap ? (snap.nodes || []).find((n) => n.name === g.node) : null;
  let status;
  if (h.status === 'error') { status = t(lang, 'widget.status_host_down'); w.state = 'crit'; }
  else if (!g) { status = t(lang, 'widget.status_missing'); w.state = 'warn'; }
  else if (node && !node.online) { status = t(lang, 'widget.status_node_offline', { node: g.node }); w.state = 'warn'; }
  else if (gs.pending) status = t(lang, 'widget.status_' + gs.pending);
  else if (g.status === 'running') status = t(lang, 'widget.status_running', { node: g.node || '?' });
  else if (g.status === 'paused') status = t(lang, 'widget.status_paused');
  else if (g.status === 'stopped') status = t(lang, 'widget.status_stopped');
  if (status) w.status = clip(status, 60);
  return w;
}

// ─── Listing ────────────────────────────────────

function hostDevice(h, lang, t) {
  return { id: `host:${h.id}`, title: clip(h.name, 40) || 'Proxmox', subtitle: clip(h.cluster_name ? `${t(lang, 'qa.host_subtitle')} · ${h.cluster_name}` : t(lang, 'qa.host_subtitle'), 60), icon: ICONS.server };
}

function guestTitle(g, vmid) {
  return clip(g && g.name ? g.name : String(vmid), 40);
}

/** Everything the actions and the tile are built from: enabled connections with status, watched guests, recent actions. */
async function gather(gc) {
  const cfg = await config.load(gc);
  const since = Date.now() - EXPECT_MS;
  const hosts = [];
  for (const h of await store.listHosts(gc)) {
    if (!h.enabled) continue;
    hosts.push({ h, snap: await store.snapshotOf(gc, h.id), watched: await store.watchedOf(gc, h.id), latest: await store.latestActions(gc, h.id, since) });
  }
  return { cfg, hosts };
}

function hostAction(x, cfg, t, lang, errorText) {
  const f = hostFacts(x.h, x.snap, cfg, t, lang, errorText);
  return {
    id: `refresh:${x.h.id}`, title: clip(t(lang, 'qa.refresh'), 40), subtitle: clip(x.h.name, 60), icon: ICONS.refresh, kind: 'button',
    device: hostDevice(x.h, lang, t), widget: hostWidget(f, cfg, t, lang),
  };
}

function guestActions(x, g, vmid, t, lang) {
  const gs = guestState(g, x.snap, x.latest.get(vmid));
  const type = g.type === 'lxc' ? 'lxc' : 'qemu';
  const title = guestTitle(g, vmid);
  const subtitle = clip(`${t(lang, 'qa.kind_' + type, { vmid })} · ${x.h.name}`, 60);
  const device = { id: `vm:${x.h.id}:${vmid}`, title, subtitle, icon: ICONS[type] };
  const toggle = {
    id: `guest:${x.h.id}:${vmid}`, title, subtitle, icon: ICONS[type], kind: 'toggle', device,
    confirm: true, confirmWhen: 'off', look: GUEST_LOOK,
    verbs: { on: clip(t(lang, 'qa.verb_on'), 20), off: clip(t(lang, 'qa.verb_off'), 20) }, targets: true,
    widget: guestWidget(x.h, g, x.snap, gs, t, lang),
  };
  if (gs.state) toggle.state = gs.state;
  const reboot = { id: `reboot:${x.h.id}:${vmid}`, title: clip(t(lang, 'qa.reboot'), 40), subtitle: title, icon: ICONS.reboot, kind: 'button', device, confirm: true };
  return [toggle, reboot];
}

/** The quick actions for `user` (administrators only): every connection first, then the watched guests while there is room. */
async function list(gc, user, lang, t, errorText) {
  if (!isAdmin(user)) return [];
  const { cfg, hosts } = await gather(gc);
  const out = hosts.slice(0, QA_MAX).map((x) => hostAction(x, cfg, t, lang, errorText));
  for (const x of hosts) {
    for (const vmid of x.watched) {
      const g = x.snap ? (x.snap.guests || []).find((y) => y.vmid === vmid) : null;
      if (!g || g.template) continue; // unknown to the last poll (removed?) or a template: nothing to switch
      if (out.length + 2 > QA_MAX) return out;
      out.push(...guestActions(x, g, vmid, t, lang));
    }
  }
  return out;
}

/** The Start tile of the apps: one „Proxmox“ tile over every enabled connection (administrators in the apps only). */
async function tiles(gc, user, lang, t, errorText) {
  if (!isAdmin(user) || user.app !== true) return [];
  const { cfg, hosts } = await gather(gc);
  if (!hosts.length) return [];
  const facts = hosts.map((x) => hostFacts(x.h, x.snap, cfg, t, lang, errorText));
  const f = sums(hosts.map((x) => x.snap));
  let state = null;
  if (facts.some((x) => x.state === 'crit')) state = 'crit';
  else if (facts.some((x) => x.state === 'warn')) state = 'warn';
  else if (facts.some((x) => x.state === 'good')) state = 'good';
  const items = [];
  if (f.any) items.push({ label: clip(t(lang, 'tile.guests'), 20), value: `${f.running}/${f.guests}`, icon: ICONS.guests });
  if (f.cpu != null) items.push({ label: clip(t(lang, 'widget.cpu'), 20), value: f.cpu, unit: '%', icon: ICONS.cpu });
  if (f.ram != null) items.push({ label: clip(t(lang, 'widget.ram'), 20), value: f.ram, unit: '%', icon: ICONS.memory });
  if (f.storage != null) items.push({ label: clip(t(lang, 'widget.storage'), 20), value: f.storage, unit: '%', icon: ICONS.disk });
  return [{ title: t(lang, 'tile.title'), value: f.any ? clip(t(lang, 'tile.value', { running: f.running, total: f.guests }), 40) : '–', state, icon: ICONS.server, items }];
}

// ─── Runs ───────────────────────────────────────

/** The widget of one listed action after a run (null when it is no longer listed). */
async function widgetAfter(gc, hostId, vmid, t, lang, errorText) {
  const { cfg, hosts } = await gather(gc);
  const x = hosts.find((y) => y.h.id === hostId);
  if (!x) return null;
  if (vmid == null) return hostAction(x, cfg, t, lang, errorText).widget;
  const g = x.snap ? (x.snap.guests || []).find((y) => y.vmid === vmid) : null;
  return g ? guestActions(x, g, vmid, t, lang)[0].widget : null;
}

/** `p` or PENDING, whichever comes first within the budget (started at `started`). */
async function within(p, started) {
  let timer = null;
  const budget = new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, budgetMs - (Date.now() - started)), PENDING); });
  try { return await Promise.race([p, budget]); } finally { clearTimeout(timer); }
}

/**
 * Run one quick action for an administrator.
 * args: { user, lang, id, via, automation, target } as the host passes them.
 */
async function run(gc, args, t, errorText) {
  const started = Date.now();
  const { user, id, via, automation } = args || {};
  const lang = args && args.lang === 'en' ? 'en' : 'de';
  const target = args && (args.target === 'on' || args.target === 'off') ? args.target : null;
  if (!isAdmin(user)) return { ok: false, message: t(lang, 'error.forbidden') };
  const m = typeof id === 'string' ? ID_RE.exec(id) : null;
  if (!m) return { ok: false, message: t(lang, 'qa.unknown') };
  const kind = m[1] || m[3];
  const hostId = Number(m[2] || m[4]);
  const vmid = m[5] ? Number(m[5]) : null;
  const host = await store.getHost(gc, hostId);
  if (!host) return { ok: false, message: t(lang, 'qa.unknown') };
  if (!host.enabled) return { ok: false, message: t(lang, 'error.host_disabled') };
  const hostName = clip(host.name, 40);
  const widget = () => widgetAfter(gc, hostId, vmid, t, lang, errorText).catch(() => null);

  if (kind === 'refresh') {
    const job = (async () => {
      const r = await poll.pollHost(gc, host, await config.load(gc), { timeoutMs: 6000 });
      try { await alerts.check(gc, [r]); } catch { /* logged in check */ }
      return r;
    })();
    const r = await within(job, started).catch((e) => ({ ok: false, error: (e && e.code) || 'INTERNAL' }));
    if (r === PENDING) {
      job.catch(() => {});
      return { ok: true, message: clip(t(lang, 'qa.refresh_pending', { host: hostName }), 120) };
    }
    if (r.ok) return { ok: true, message: clip(t(lang, 'qa.refreshed', { host: hostName }), 120), widget: await widget() };
    return { ok: false, message: clip(t(lang, 'qa.refresh_failed', { host: hostName, error: errorText(r.error, lang) }), 120), widget: await widget() };
  }

  // a guest: the last poll's name for the messages (the run itself looks the guest up fresh)
  const snap = await store.snapshotOf(gc, hostId);
  const known = snap ? (snap.guests || []).find((y) => y.vmid === vmid) : null;
  let guest = guestTitle(known, vmid);
  const route = routeOf(via, automation);
  const opts = { via: route, waitMs: Math.min(control.timing.waitMs, QA_WAIT_MS) };
  let pick;
  if (kind === 'reboot') pick = 'reboot';
  else {
    // on = running (or paused); never a hard stop: off = a clean shutdown
    pick = (status) => {
      const on = status === 'running' || status === 'paused';
      const want = target || (on ? 'off' : 'on');
      if (want === 'on') return on ? null : 'start';
      return status === 'stopped' ? null : 'shutdown';
    };
  }
  const job = control.run(gc, host, vmid, pick, user, opts);
  let a;
  try {
    a = await within(job, started);
  } catch (e) {
    const code = e && e.code;
    if (!code) gc.log.warn('proxmox quick action failed', id, (e && e.message) || 'error');
    if (code === 'GUEST_STATE' && kind === 'reboot') return { ok: false, message: clip(t(lang, 'qa.not_running', { guest }), 120), widget: await widget() };
    return { ok: false, message: clip(errorText(code || 'INTERNAL', lang), 120), widget: await widget() };
  }
  if (a === PENDING) {
    job.catch((e) => gc.log.warn('proxmox quick action failed late', id, (e && e.code) || 'error'));
    return { ok: true, message: clip(t(lang, 'qa.pending', { guest }), 120) };
  }
  if (a.guest_name) guest = clip(a.guest_name, 40);
  if (a.skipped) {
    const on = a.status === 'running' || a.status === 'paused';
    return { ok: true, message: clip(t(lang, on ? 'qa.already_on' : 'qa.already_off', { guest }), 120), state: on ? 'on' : 'off', widget: await widget() };
  }
  const expected = a.action === 'shutdown' ? 'off' : 'on';
  const out = { ok: true, message: null };
  if (kind === 'guest') out.state = expected;
  if (a.status === 'ok') out.message = t(lang, a.action === 'start' ? 'qa.started' : (a.action === 'shutdown' ? 'qa.shutdown_done' : 'qa.rebooted'), { guest });
  else if (a.status === 'running') out.message = t(lang, `qa.${a.action}_running`, { guest });
  else {
    out.ok = false;
    delete out.state;
    const error = a.status === 'timeout' ? t(lang, 'action.status.timeout') : (a.exitstatus || t(lang, 'action.status.error'));
    out.message = t(lang, 'qa.failed', { guest, action: t(lang, 'action.' + a.action), error });
  }
  out.message = clip(out.message, 120);
  out.widget = await widget();
  return out;
}

module.exports = {
  isAdmin, list, tiles, run, uptimeText, routeOf, ICONS, QA_MAX, QA_BUDGET_MS,
  /** Tests: the time budget of a run in ms (null: the default 8 s). */
  _setBudgetForTest(ms) { budgetMs = ms == null ? QA_BUDGET_MS : ms; },
};
