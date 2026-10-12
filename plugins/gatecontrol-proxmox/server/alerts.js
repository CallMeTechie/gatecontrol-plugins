'use strict';

// Proxmox notifications (plugin.json notifyTopics) from the background poll
// — no extra requests. After every poll the result is compared with the last
// seen state (kept in gc.storage 'notify.state', so a restart neither
// repeats nor loses anything):
//
//   unreachable    connection failing (network, certificate, token …) for 5 minutes,
//                  or a cluster node offline for 5 minutes (priority high);
//                  "reachable again" / "online again" replaces it (same collapse key)
//   guest_stopped  a guest marked "überwachen" went from running to stopped — not
//                  when it was shut down, stopped or rebooted through this plugin
//                  in the last 30 minutes
//   storage_full   a storage reached the threshold (setting, default 90 %); again only
//                  after it dropped 2 points below it
//   backup_failed  a finished vzdump task with an error (priority high), one message
//                  per connection and poll
//   node_load      node CPU or RAM at or above its threshold (settings, off by default)
//                  for load_minutes (default 15)
//
// Anything seen for the first time (also: the very first run, a new
// connection, a guest just marked) only records its state: nothing that was
// already the case is announced. Recipients: the administrators (default)
// or the topic's rule in GateControl (setting notify_recipients).

const crypto = require('node:crypto');
const notify = require('./notify');
const config = require('./config');
const store = require('./store');
const snapshot = require('./snapshot');

const STATE_KEY = 'notify.state';
const SUPPRESS_MS = 30 * 60000;   // a stop through the plugin is no surprise for this long
const STORAGE_HYSTERESIS = 2;      // percentage points below the threshold before it re-arms
const MAX_TASKS = 300;             // remembered vzdump tasks per connection

const TEXTS = {
  de: {
    'host.down': 'Proxmox nicht erreichbar',
    'host.down.body': '{{name}} antwortet seit {{min}} Minuten nicht ({{error}})',
    'host.up': 'Proxmox wieder erreichbar',
    'host.up.body': '{{name}} antwortet wieder',
    'node.down': 'Proxmox-Node offline',
    'node.down.body': '{{node}} ({{name}}) ist seit {{min}} Minuten offline',
    'node.up': 'Proxmox-Node wieder online',
    'node.up.body': '{{node}} ({{name}}) ist wieder online',
    'guest.title': '{{kind}} {{vmid}} gestoppt',
    'guest.body': '{{guest}} läuft nicht mehr · {{node}} · {{name}}',
    'storage.title': 'Speicher fast voll: {{storage}}',
    'storage.body': '{{storage}} ist zu {{pct}} % belegt ({{used}} von {{total}}) · {{name}}',
    'backup.title': 'Backup fehlgeschlagen',
    'backup.title_n': '{{n}} Backups fehlgeschlagen',
    'backup.body': '{{list}} · {{name}}',
    'backup.all': 'alle Gäste',
    'load.cpu': 'Hohe CPU-Last auf {{node}}',
    'load.ram': 'Hohe RAM-Belegung auf {{node}}',
    'load.body': '{{value}} % seit {{min}} Minuten (Schwelle {{th}} %) · {{name}}',
    'kind.qemu': 'VM',
    'kind.lxc': 'CT',
    'fact.host': 'Verbindung',
    'fact.node': 'Node',
    'fact.guest': 'Gast',
    'fact.error': 'Fehler',
    'fact.since': 'Seit',
    'fact.storage': 'Speicher',
    'fact.used': 'Belegt',
    'fact.free': 'Frei',
    'fact.status': 'Status',
    'fact.cpu': 'CPU',
    'fact.ram': 'RAM',
    'fact.threshold': 'Schwelle',
    'minutes': '{{n}} Minuten',
  },
  en: {
    'host.down': 'Proxmox unreachable',
    'host.down.body': '{{name}} has not answered for {{min}} minutes ({{error}})',
    'host.up': 'Proxmox reachable again',
    'host.up.body': '{{name}} answers again',
    'node.down': 'Proxmox node offline',
    'node.down.body': '{{node}} ({{name}}) has been offline for {{min}} minutes',
    'node.up': 'Proxmox node online again',
    'node.up.body': '{{node}} ({{name}}) is online again',
    'guest.title': '{{kind}} {{vmid}} stopped',
    'guest.body': '{{guest}} is no longer running · {{node}} · {{name}}',
    'storage.title': 'Storage almost full: {{storage}}',
    'storage.body': '{{storage}} is {{pct}} % full ({{used}} of {{total}}) · {{name}}',
    'backup.title': 'Backup failed',
    'backup.title_n': '{{n}} backups failed',
    'backup.body': '{{list}} · {{name}}',
    'backup.all': 'all guests',
    'load.cpu': 'High CPU load on {{node}}',
    'load.ram': 'High RAM usage on {{node}}',
    'load.body': '{{value}} % for {{min}} minutes (threshold {{th}} %) · {{name}}',
    'kind.qemu': 'VM',
    'kind.lxc': 'CT',
    'fact.host': 'Connection',
    'fact.node': 'Node',
    'fact.guest': 'Guest',
    'fact.error': 'Error',
    'fact.since': 'Since',
    'fact.storage': 'Storage',
    'fact.used': 'Used',
    'fact.free': 'Free',
    'fact.status': 'Status',
    'fact.cpu': 'CPU',
    'fact.ram': 'RAM',
    'fact.threshold': 'Threshold',
    'minutes': '{{n}} minutes',
  },
};

// Short error texts for the notification (the page has the long ones).
const ERROR_TEXTS = {
  de: {
    PVE_UNREACHABLE: 'keine Verbindung', PVE_TIMEOUT: 'Zeitüberschreitung', PVE_TLS: 'Zertifikat nicht vertrauenswürdig',
    PVE_AUTH: 'API-Token abgelehnt', PVE_FORBIDDEN: 'fehlende Rechte', PVE_GATEWAY: 'Gateway erreicht Proxmox nicht',
    PVE_NO_TARGET: 'kein Zugriffsziel', PVE_TARGET_DENIED: 'Zugriffsziel gesperrt', PVE_NO_SECRET: 'kein Token-Secret',
    PVE_HTTPS_REQUIRED: 'nur HTTPS', PVE_NODE_DOWN: 'Node nicht erreichbar', other: 'Fehler',
  },
  en: {
    PVE_UNREACHABLE: 'no connection', PVE_TIMEOUT: 'timeout', PVE_TLS: 'certificate not trusted',
    PVE_AUTH: 'API token refused', PVE_FORBIDDEN: 'missing privileges', PVE_GATEWAY: 'gateway cannot reach Proxmox',
    PVE_NO_TARGET: 'no access target', PVE_TARGET_DENIED: 'access target blocked', PVE_NO_SECRET: 'no token secret',
    PVE_HTTPS_REQUIRED: 'HTTPS only', PVE_NODE_DOWN: 'node not reachable', other: 'error',
  },
};

const hash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
const L = (lang) => (lang === 'en' ? 'en' : 'de');

/** Bytes as people read them: "40,2 GiB" / "40.2 GiB". */
function bytes(n, lang) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '–';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let i = 0;
  let x = v;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return `${notify.num(x, lang, x >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

// ─── Observations ───────────────────────────────

/**
 * A poll result → what evaluate() looks at.
 * @param {{ host, ok, snapshot, error }} r
 * @param {number[]} watched  VMIDs marked "überwachen"
 * @param {Map<number, object>} actions  latest plugin action per VMID (store.latestActions)
 */
function observe(r, watched, actions, now) {
  const host = { id: r.host.id, name: r.host.name };
  if (!r.ok || !r.snapshot) return { host, reachable: false, error: r.error || null };
  const s = r.snapshot;
  const w = new Set(watched || []);
  const viaPlugin = (vmid) => {
    const a = actions && actions.get(vmid);
    return !!(a && ['shutdown', 'stop', 'reboot'].includes(a.action) && a.status !== 'error' && now - a.started_at < SUPPRESS_MS);
  };
  return {
    host,
    reachable: true,
    nodes: (s.nodes || []).map((n) => ({ name: n.name, online: !!n.online })),
    guests: (s.guests || []).filter((g) => w.has(g.vmid)).map((g) => ({ vmid: g.vmid, name: g.name, type: g.type, node: g.node, status: g.status, stoppedByPlugin: viaPlugin(g.vmid) })),
    storages: (s.storages || []).filter((x) => x.status === 'available' && x.total > 0 && x.used != null)
      .map((x) => ({ id: x.id, storage: x.storage, node: x.node, used: x.used, total: x.total })),
    backups: (s.backups || []).map((b) => ({ upid: b.upid, node: b.node, vmid: b.vmid, ok: b.ok, status: b.status, endtime: b.endtime })),
    load: (s.nodes || []).filter((n) => n.online && !n.error).map((n) => ({
      node: n.name,
      cpu: n.cpu == null ? null : Math.round(n.cpu * 1000) / 10,
      ram: snapshot.pct(n.mem, n.maxmem),
    })),
  };
}

// ─── Pure transition logic ──────────────────────

/** "pending" → "announced" after `minutes`; first sighting → "muted". */
function downState(prevEntry, known, now, minutes) {
  const was = !!(prevEntry && prevEntry.since != null);
  const since = was ? prevEntry.since : now;
  const state = was ? prevEntry.state : (known ? 'pending' : 'muted');
  const due = state === 'pending' && now - since >= minutes * 60000;
  return { since, state: due ? 'announced' : state, due, minutes: Math.round((now - since) / 60000) };
}

/**
 * @param {object|null} prevMemo  last stored state (null = first run)
 * @param {Array} results         observations (observe())
 * @param {{ storagePct, cpuPct, ramPct, loadMin, downMin }} cfg
 * @param {number} now            ms
 * @returns {{ memo, events: Array<{ topic, kind, host, … }> }}
 */
function evaluate(prevMemo, results, cfg, now) {
  const memo = { v: 1, hosts: {} };
  const events = [];
  const prevHosts = prevMemo && prevMemo.hosts && typeof prevMemo.hosts === 'object' ? prevMemo.hosts : {};
  for (const r of results || []) {
    if (!r || !r.host) continue;
    const id = String(r.host.id);
    const prevH = prevHosts[id] || null;
    const host = r.host;

    // the connection: down = { state, since } | null
    if (!r.reachable) {
      const d = downState(prevH && prevH.down, !!prevH, now, cfg.downMin);
      if (d.due) events.push({ topic: 'unreachable', kind: 'host_down', host, minutes: d.minutes, error: r.error || null, since: d.since });
      // nothing new about nodes, guests, storage, tasks
      memo.hosts[id] = { ...(prevH || {}), down: { state: d.state, since: d.since } };
      continue;
    }
    const h = { down: null, nodes: {}, guests: {}, storage: {}, tasks: [], load: {} };
    if (prevH && prevH.down && prevH.down.state === 'announced') events.push({ topic: 'unreachable', kind: 'host_up', host });

    // nodes: { name: { state, since } | null }
    const prevNodes = (prevH && prevH.nodes) || {};
    for (const n of r.nodes || []) {
      const known = !!prevH && Object.prototype.hasOwnProperty.call(prevNodes, n.name);
      if (!n.online) {
        const d = downState(prevNodes[n.name], known, now, cfg.downMin);
        if (d.due) events.push({ topic: 'unreachable', kind: 'node_down', host, node: n.name, minutes: d.minutes, since: d.since });
        h.nodes[n.name] = { state: d.state, since: d.since };
      } else {
        if (prevNodes[n.name] && prevNodes[n.name].state === 'announced') events.push({ topic: 'unreachable', kind: 'node_up', host, node: n.name });
        h.nodes[n.name] = null;
      }
    }

    // watched guests: { vmid: status }
    const prevGuests = (prevH && prevH.guests) || {};
    for (const g of r.guests || []) {
      const before = prevGuests[g.vmid];
      h.guests[g.vmid] = g.status;
      if (before === 'running' && g.status === 'stopped' && !g.stoppedByPlugin) events.push({ topic: 'guest_stopped', kind: 'stopped', host, guest: g });
    }

    // storage: { id: 'ok' | 'announced' | 'muted' }
    const prevStorage = (prevH && prevH.storage) || {};
    for (const s of r.storages || []) {
      const before = prevStorage[s.id];
      const p = snapshot.pct(s.used, s.total);
      if (p == null) { if (before) h.storage[s.id] = before; continue; }
      if (p >= cfg.storagePct) {
        if (before === undefined) h.storage[s.id] = 'muted';
        else if (before === 'ok') { events.push({ topic: 'storage_full', kind: 'full', host, storage: s, pct: p }); h.storage[s.id] = 'announced'; } else h.storage[s.id] = before;
      } else if (p < cfg.storagePct - STORAGE_HYSTERESIS || before === undefined) h.storage[s.id] = 'ok';
      else h.storage[s.id] = before;
    }

    // backups: remembered task ids; the first look at a connection only records them
    const firstTasks = !prevH || !Array.isArray(prevH.tasks);
    const seen = new Set(firstTasks ? [] : prevH.tasks);
    const failed = [];
    const current = [];
    for (const b of r.backups || []) {
      if (!b || typeof b.upid !== 'string') continue;
      current.push(b.upid);
      if (firstTasks || seen.has(b.upid)) continue;
      if (!b.ok) failed.push(b);
    }
    if (failed.length) events.push({ topic: 'backup_failed', kind: 'failed', host, tasks: failed });
    h.tasks = [...new Set([...current, ...(firstTasks ? [] : prevH.tasks)])].slice(0, MAX_TASKS);

    // node load: { node: { cpu: { state, since } | null, ram: … } }
    const prevLoad = (prevH && prevH.load) || {};
    for (const l of r.load || []) {
      const pl = prevLoad[l.node];
      const known = !!pl;
      const entry = {};
      for (const m of ['cpu', 'ram']) {
        const th = m === 'cpu' ? cfg.cpuPct : cfg.ramPct;
        const v = l[m];
        if (!th || v == null) { entry[m] = null; continue; }
        if (v >= th) {
          const d = downState(pl && pl[m], known, now, cfg.loadMin);
          if (d.due) events.push({ topic: 'node_load', kind: m, host, node: l.node, value: v, threshold: th, minutes: d.minutes });
          entry[m] = { state: d.state, since: d.since };
        } else entry[m] = null;
      }
      h.load[l.node] = entry;
    }
    memo.hosts[id] = h;
  }
  // connections without a result this time (not due, disabled): keep what was known
  for (const [id, h] of Object.entries(prevHosts)) if (!(id in memo.hosts)) memo.hosts[id] = h;
  return { memo, events };
}

/** Undo an event in the memo (not sent: hourly budget) so the next run tries again. */
function revert(memo, ev) {
  const h = memo.hosts[String(ev.host.id)];
  if (!h) return;
  if (ev.kind === 'host_down' && h.down) h.down.state = 'pending';
  if (ev.kind === 'node_down' && h.nodes && h.nodes[ev.node]) h.nodes[ev.node].state = 'pending';
  if (ev.topic === 'guest_stopped' && h.guests) h.guests[ev.guest.vmid] = 'running';
  if (ev.topic === 'storage_full' && h.storage) h.storage[ev.storage.id] = 'ok';
  if (ev.topic === 'backup_failed' && Array.isArray(h.tasks)) {
    const drop = new Set(ev.tasks.map((t) => t.upid));
    h.tasks = h.tasks.filter((u) => !drop.has(u));
  }
  if (ev.topic === 'node_load' && h.load && h.load[ev.node] && h.load[ev.node][ev.kind]) h.load[ev.node][ev.kind].state = 'pending';
  // host_up / node_up: the announced state is gone already — a lost "reachable again" is not repeated
}

// ─── Notifications ──────────────────────────────

function errorText(code, lang) {
  const t = ERROR_TEXTS[L(lang)];
  return t[code] || t.other;
}

function time(ms, lang) {
  try { return new Date(ms).toLocaleTimeString(L(lang) === 'en' ? 'en-GB' : 'de-DE', { hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
}

/** Event → gc.notify payload (users: set by check()). */
function toNotification(gc, ev, cfg) {
  const lang = cfg.lang;
  const tx = (k, p) => notify.fmt(TEXTS, lang, k, p);
  const name = String(ev.host.name || `Proxmox ${ev.host.id}`).slice(0, 80);
  const base = { ...notify.openAction(gc, lang), host_id: ev.host.id };
  const hostFact = { label: tx('fact.host'), value: name };

  if (ev.topic === 'unreachable') {
    if (ev.kind === 'host_down' || ev.kind === 'host_up') {
      const collapseKey = `host:${ev.host.id}`;
      if (ev.kind === 'host_up') return { topic: 'unreachable', title: tx('host.up'), body: tx('host.up.body', { name }), priority: 'info', collapseKey, ttl: 12 * 3600, data: { ...base, facts: [hostFact] } };
      const err = errorText(ev.error, lang);
      return {
        topic: 'unreachable', title: tx('host.down'), body: tx('host.down.body', { name, min: notify.num(ev.minutes, lang), error: err }), priority: 'high', collapseKey, ttl: 24 * 3600,
        data: { ...base, error: ev.error || null, facts: [hostFact, { label: tx('fact.error'), value: err }, { label: tx('fact.since'), value: time(ev.since, lang) }] },
      };
    }
    const collapseKey = `node:${ev.host.id}:${ev.node}`.slice(0, 120);
    const facts = [{ label: tx('fact.node'), value: ev.node }, hostFact];
    if (ev.kind === 'node_up') return { topic: 'unreachable', title: tx('node.up'), body: tx('node.up.body', { node: ev.node, name }), priority: 'info', collapseKey, ttl: 12 * 3600, data: { ...base, node: ev.node, facts } };
    return {
      topic: 'unreachable', title: tx('node.down'), body: tx('node.down.body', { node: ev.node, name, min: notify.num(ev.minutes, lang) }), priority: 'high', collapseKey, ttl: 24 * 3600,
      data: { ...base, node: ev.node, facts: [...facts, { label: tx('fact.since'), value: time(ev.since, lang) }] },
    };
  }
  if (ev.topic === 'guest_stopped') {
    const g = ev.guest;
    const kind = tx(`kind.${g.type === 'lxc' ? 'lxc' : 'qemu'}`);
    const label = g.name ? `${g.vmid} · ${g.name}` : String(g.vmid);
    return {
      topic: 'guest_stopped', title: tx('guest.title', { kind, vmid: g.vmid }).slice(0, 120), body: tx('guest.body', { guest: label, node: g.node || '–', name }).slice(0, 1000),
      priority: 'normal', collapseKey: `guest:${ev.host.id}:${g.vmid}`, ttl: 24 * 3600,
      data: { ...base, vmid: g.vmid, facts: [{ label: tx('fact.guest'), value: `${kind} ${label}`.slice(0, 120) }, { label: tx('fact.node'), value: g.node || '–' }, hostFact] },
    };
  }
  if (ev.topic === 'storage_full') {
    const s = ev.storage;
    const where = s.node ? `${s.storage} (${s.node})` : s.storage;
    const pct = notify.num(ev.pct, lang, 1);
    return {
      topic: 'storage_full', title: tx('storage.title', { storage: s.storage }).slice(0, 120),
      body: tx('storage.body', { storage: where, pct, used: bytes(s.used, lang), total: bytes(s.total, lang), name }).slice(0, 1000),
      priority: 'normal', collapseKey: `storage:${ev.host.id}:${hash(s.id)}`, ttl: 24 * 3600,
      data: {
        ...base, storage: s.storage,
        facts: [{ label: tx('fact.storage'), value: where.slice(0, 120) }, { label: tx('fact.used'), value: `${pct} %` }, { label: tx('fact.free'), value: bytes(s.total - s.used, lang) }, hostFact],
      },
    };
  }
  if (ev.topic === 'backup_failed') {
    const list = ev.tasks.slice(0, 10).map((t) => `${t.vmid != null ? t.vmid : tx('backup.all')} (${t.node}): ${t.status}`);
    const more = ev.tasks.length > list.length ? ` (+${ev.tasks.length - list.length})` : '';
    const first = ev.tasks[0];
    return {
      topic: 'backup_failed', title: ev.tasks.length > 1 ? tx('backup.title_n', { n: ev.tasks.length }) : tx('backup.title'),
      body: tx('backup.body', { list: list.join('; ') + more, name }).slice(0, 1000), priority: 'high',
      collapseKey: `backup:${ev.host.id}:${hash(ev.tasks.map((t) => t.upid).join(','))}`, ttl: 3 * 86400,
      data: {
        ...base,
        facts: [
          { label: tx('fact.guest'), value: (first.vmid != null ? String(first.vmid) : tx('backup.all')).slice(0, 120) },
          { label: tx('fact.node'), value: String(first.node || '–').slice(0, 120) },
          { label: tx('fact.status'), value: String(first.status || '–').slice(0, 120) },
          hostFact,
        ],
      },
    };
  }
  // node_load
  const v = notify.num(ev.value, lang);
  return {
    topic: 'node_load', title: tx(ev.kind === 'ram' ? 'load.ram' : 'load.cpu', { node: ev.node }).slice(0, 120),
    body: tx('load.body', { value: v, min: notify.num(ev.minutes, lang), th: ev.threshold, name }), priority: 'normal',
    collapseKey: `load:${ev.host.id}:${ev.kind}:${ev.node}`.slice(0, 120), ttl: 6 * 3600,
    data: {
      ...base, node: ev.node,
      facts: [{ label: tx('fact.node'), value: ev.node }, { label: tx(ev.kind === 'ram' ? 'fact.ram' : 'fact.cpu'), value: `${v} %` }, { label: tx('fact.threshold'), value: `${ev.threshold} %` }, { label: tx('fact.since'), value: tx('minutes', { n: notify.num(ev.minutes, lang) }) }, hostFact],
    },
  };
}

// ─── Glue (one check at a time) ─────────────────

let notifier = null;
let chain = Promise.resolve();

function reset() { notifier = null; }

const RETRY = new Set(['THROTTLED', 'ERR_RATE_LIMIT']);

async function adminIds(gc) {
  try { return (await gc.users.list()).filter((u) => u && u.role === 'admin' && Number.isSafeInteger(u.id)).map((u) => u.id).slice(0, 100); } catch { return null; }
}

/** Compare the poll results with the last seen state and send what changed. → number sent */
function check(gc, pollResults, { now = Date.now() } = {}) {
  const run = async () => {
    if (!notifier) notifier = notify.createNotifier(gc);
    const cfg = await config.load(gc);
    const prev = await notify.loadState(gc, STATE_KEY);
    // connections that no longer exist leave the stored state
    const known = new Set((await store.listHosts(gc)).map((h) => String(h.id)));
    const prevKnown = prev ? { ...prev, hosts: Object.fromEntries(Object.entries(prev.hosts || {}).filter(([id]) => known.has(id))) } : null;
    const results = [];
    for (const r of pollResults || []) {
      if (!r || !r.host || !known.has(String(r.host.id))) continue;
      const watched = r.ok ? await store.watchedOf(gc, r.host.id) : [];
      const actions = r.ok ? await store.latestActions(gc, r.host.id, now - SUPPRESS_MS) : new Map();
      results.push(observe(r, watched, actions, now));
    }
    const { memo, events } = evaluate(prevKnown, results, cfg, now);
    let sent = 0;
    if (events.length) {
      const users = cfg.recipients === 'admins' ? await adminIds(gc) : null;
      for (const ev of events) {
        if (Array.isArray(users) && !users.length) break; // nobody to tell
        const n = { ...toNotification(gc, ev, cfg), users: users || null };
        const r = await notifier.send(n);
        if (r.sent) sent++;
        else if (RETRY.has(r.error)) revert(memo, ev);
      }
    }
    await notify.saveState(gc, STATE_KEY, memo, prev ? JSON.stringify(prev) : null);
    return sent;
  };
  const p = chain.then(run, run);
  chain = p.catch((e) => { gc.log.warn('notification check failed', (e && e.code) || (e && e.message)); });
  return p;
}

module.exports = { evaluate, observe, revert, toNotification, check, reset, bytes, STATE_KEY, TEXTS, SUPPRESS_MS, STORAGE_HYSTERESIS };
