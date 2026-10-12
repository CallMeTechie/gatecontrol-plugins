'use strict';

// NAS notifications (plugin.json notifyTopics) from the background polls —
// no extra requests to the NAS. After every poll the observations are
// compared with the last seen state (gc.storage 'notify.state', so a
// restart neither repeats nor loses anything):
//
//   unreachable  N polls in a row failed (setting, default 3; priority high);
//                "reachable again" replaces it (same collapse key). Quiet
//                while a reboot requested here runs (20 min) and after a
//                shutdown requested here until the NAS answers again.
//   storage      a volume or storage pool degraded / crashed (high), back
//                to normal (info); a volume at or above N % (setting,
//                default 90; normal; again only after it fell 2 points below)
//   disk         drive health warning / failing (high); drive temperature at
//                or above N °C (setting, default 55; again after 3 °C below)
//   update       a DSM update is available (info, once per version)
//   backup       a Hyper Backup task's last run failed or was partial
//   power        reboot / shutdown requested in GateControl (sent by the
//                control action itself, not here)
//
// A NAS, volume, pool, drive or task seen for the first time (also: the
// very first run) only records its state: nothing that was already the
// case is announced.

const notify = require('./notify');

const STATE_KEY = 'notify.state';
const REBOOT_GRACE_MS = 20 * 60000;
const FULL_HYSTERESIS = 2;
const TEMP_HYSTERESIS = 3;

const TEXTS = {
  de: {
    'down.title': 'NAS nicht erreichbar',
    'down.body': '{{name}} antwortet seit {{n}} Abfragen nicht.',
    'up.title': 'NAS wieder erreichbar',
    'up.body': '{{name}} antwortet wieder.',
    'vol.degraded': 'Volume beeinträchtigt',
    'vol.crashed': 'Volume abgestürzt',
    'vol.normal': 'Volume wieder in Ordnung',
    'pool.degraded': 'Speicherpool beeinträchtigt',
    'pool.crashed': 'Speicherpool abgestürzt',
    'pool.normal': 'Speicherpool wieder in Ordnung',
    'storage.body': '{{nas}} · {{what}}: {{status}}',
    'status.degraded': 'beeinträchtigt',
    'status.crashed': 'abgestürzt',
    'status.normal': 'normal',
    'full.title': 'Speicher fast voll',
    'full.body': '{{what}} auf {{nas}} ist zu {{pct}} % belegt.',
    'disk.warning': 'Laufwerk meldet Probleme',
    'disk.failing': 'Laufwerk fällt aus',
    'disk.body': '{{nas}} · {{disk}}: {{status}}',
    'health.warning': 'Warnung',
    'health.failing': 'Ausfall droht',
    'hot.title': 'Laufwerk zu heiß',
    'hot.body': '{{disk}} in {{nas}} hat {{temp}} °C.',
    'update.title': 'DSM-Update verfügbar',
    'update.body': '{{nas}}: {{version}}',
    'backup.failed': 'Datensicherung fehlgeschlagen',
    'backup.partial': 'Datensicherung unvollständig',
    'backup.body': '{{nas}} · Hyper Backup „{{task}}“',
    'power.reboot': 'NAS wird neu gestartet',
    'power.shutdown': 'NAS wird heruntergefahren',
    'power.body': '{{nas}} – angefordert von {{user}} in GateControl.',
    'power.body_shutdown': '{{nas}} – angefordert von {{user}} in GateControl. Einschalten nur am Gerät (oder per Wake-on-LAN).',
    'pool.name': 'Speicherpool {{n}}',
    'fact.nas': 'NAS',
    'fact.volume': 'Volume',
    'fact.pool': 'Speicherpool',
    'fact.status': 'Status',
    'fact.used': 'Belegt',
    'fact.free': 'Frei',
    'fact.disk': 'Laufwerk',
    'fact.model': 'Modell',
    'fact.temp': 'Temperatur',
    'fact.installed': 'Installiert',
    'fact.available': 'Verfügbar',
    'fact.task': 'Aufgabe',
    'fact.time': 'Zeit',
    'fact.last_seen': 'Zuletzt erreichbar',
    'fact.by': 'Von',
  },
  en: {
    'down.title': 'NAS unreachable',
    'down.body': '{{name}} has not answered for {{n}} polls.',
    'up.title': 'NAS reachable again',
    'up.body': '{{name}} answers again.',
    'vol.degraded': 'Volume degraded',
    'vol.crashed': 'Volume crashed',
    'vol.normal': 'Volume healthy again',
    'pool.degraded': 'Storage pool degraded',
    'pool.crashed': 'Storage pool crashed',
    'pool.normal': 'Storage pool healthy again',
    'storage.body': '{{nas}} · {{what}}: {{status}}',
    'status.degraded': 'degraded',
    'status.crashed': 'crashed',
    'status.normal': 'healthy',
    'full.title': 'Storage almost full',
    'full.body': '{{what}} on {{nas}} is {{pct}} % full.',
    'disk.warning': 'Drive reports problems',
    'disk.failing': 'Drive failing',
    'disk.body': '{{nas}} · {{disk}}: {{status}}',
    'health.warning': 'warning',
    'health.failing': 'failing',
    'hot.title': 'Drive too hot',
    'hot.body': '{{disk}} in {{nas}} is at {{temp}} °C.',
    'update.title': 'DSM update available',
    'update.body': '{{nas}}: {{version}}',
    'backup.failed': 'Backup failed',
    'backup.partial': 'Backup incomplete',
    'backup.body': '{{nas}} · Hyper Backup “{{task}}”',
    'power.reboot': 'NAS is restarting',
    'power.shutdown': 'NAS is shutting down',
    'power.body': '{{nas}} – requested by {{user}} in GateControl.',
    'power.body_shutdown': '{{nas}} – requested by {{user}} in GateControl. Power on only at the device (or by Wake-on-LAN).',
    'pool.name': 'Storage pool {{n}}',
    'fact.nas': 'NAS',
    'fact.volume': 'Volume',
    'fact.pool': 'Storage pool',
    'fact.status': 'Status',
    'fact.used': 'Used',
    'fact.free': 'Free',
    'fact.disk': 'Drive',
    'fact.model': 'Model',
    'fact.temp': 'Temperature',
    'fact.installed': 'Installed',
    'fact.available': 'Available',
    'fact.task': 'Task',
    'fact.time': 'Time',
    'fact.last_seen': 'Last reachable',
    'fact.by': 'By',
  },
};

const RANK = { normal: 0, degraded: 1, crashed: 2 };
const HEALTH = { normal: 0, warning: 1, failing: 2 };

// ─── Conditions of a status (shared with the page) ──

/**
 * What is wrong in a status right now (for the page; the notifications use
 * the same conditions, as transitions):
 * [{ level: 'crit'|'warn'|'info', kind, id?, name?, … }]
 */
function issuesOf(snap, cfg) {
  const out = [];
  if (!snap) return out;
  for (const p of snap.pools || []) {
    if (p.status === 'crashed' || p.status === 'degraded') out.push({ level: p.status === 'crashed' ? 'crit' : 'warn', kind: 'pool', status: p.status, id: p.id, num: p.num });
  }
  for (const v of snap.volumes || []) {
    if (v.status === 'crashed' || v.status === 'degraded') out.push({ level: v.status === 'crashed' ? 'crit' : 'warn', kind: 'volume', status: v.status, id: v.id, name: v.name });
    if (v.pct != null && v.pct >= cfg.fullPct) out.push({ level: v.pct >= 98 ? 'crit' : 'warn', kind: 'full', id: v.id, name: v.name, pct: v.pct });
  }
  for (const d of snap.disks || []) {
    if (d.health === 'failing' || d.health === 'warning') out.push({ level: d.health === 'failing' ? 'crit' : 'warn', kind: 'disk', status: d.health, id: d.id, name: d.name });
    if (d.temp != null && d.temp >= cfg.diskTempMax) out.push({ level: 'warn', kind: 'hot', id: d.id, name: d.name, temp: d.temp });
  }
  for (const t of snap.backups || []) {
    if (t.result === 'failed' || t.result === 'partial') out.push({ level: 'warn', kind: 'backup', status: t.result, id: t.id, name: t.name, time: t.last_time });
  }
  if (snap.ups && (snap.ups.state === 'battery' || snap.ups.state === 'low')) out.push({ level: snap.ups.state === 'low' ? 'crit' : 'warn', kind: 'ups', status: snap.ups.state, charge: snap.ups.charge });
  if (snap.update && snap.update.available) out.push({ level: 'info', kind: 'update', version: snap.update.version });
  return out;
}

// ─── Transitions ────────────────────────────────

function emptyNas() {
  return { down: null, vol: {}, pool: {}, full: {}, disk: {}, hot: {} };
}

/** The previous state of the storage/disk maps, or a fresh one (first sighting of the NAS). */
function carry(prevN) {
  if (!prevN) return emptyNas();
  const n = { ...emptyNas(), ...prevN };
  for (const k of ['vol', 'pool', 'full', 'disk', 'hot']) n[k] = { ...(prevN[k] || {}) };
  if (prevN.backup) n.backup = { ...prevN.backup };
  return n;
}

/**
 * Pure transition logic.
 * @param {object|null} prevMemo  last stored state (null = first run)
 * @param {Array<{ nas: { id, name }, reachable: boolean, failures: number,
 *   power?: { state: 'reboot'|'shutdown', at: number }|null, snap?: object|null, lastSeen?: number|null }>} obs
 *   one entry per NAS polled now (NAS not polled keep their state)
 * @param {{ unreachablePolls, fullPct, diskTempMax }} cfg
 * @param {number} now  ms
 * @returns {{ memo, events: Array<{ topic, kind, nas, … }> }}
 */
function evaluate(prevMemo, obs, cfg, now) {
  const memo = { v: 1, nas: {} };
  const events = [];
  const prevAll = (prevMemo && prevMemo.nas) || {};
  for (const o of obs || []) {
    if (!o || !o.nas) continue;
    const id = String(o.nas.id);
    const prevN = prevMemo ? prevAll[id] || null : null;
    const n = carry(prevN);
    const nas = o.nas;

    if (!o.reachable) {
      const power = o.power || null;
      const expected = power && (power.state === 'shutdown' || (power.state === 'reboot' && now - (power.at || 0) < REBOOT_GRACE_MS));
      if (expected) {
        // quiet: the administrator switched it off / restarts it
        if (n.down !== 'announced') n.down = power.state === 'shutdown' ? 'off' : n.down;
      } else if ((o.failures || 0) >= cfg.unreachablePolls) {
        // never seen answering (new NAS, or already down at the first run): the page shows it, no alarm
        if (!prevN || !prevN.seen) n.down = 'muted';
        else if (n.down !== 'announced' && n.down !== 'muted') {
          events.push({ topic: 'unreachable', kind: 'down', nas, failures: o.failures, lastSeen: o.lastSeen || null });
          n.down = 'announced';
        }
      }
      memo.nas[id] = n;
      continue;
    }

    if (prevN && n.down === 'announced') events.push({ topic: 'unreachable', kind: 'up', nas });
    n.down = null;
    const snap = o.snap;
    if (!snap) { memo.nas[id] = n; continue; }
    const seen = !!prevN && !!prevN.seen;

    // volumes and pools: status
    for (const [map, list, kind] of [[n.vol, snap.volumes, 'volume'], [n.pool, snap.pools, 'pool']]) {
      const ids = new Set();
      for (const x of list || []) {
        ids.add(x.id);
        const was = map[x.id];
        if (x.status === 'unknown' && was !== undefined) continue; // unreadable now: keep what was known
        const st = x.status === 'unknown' ? 'normal' : x.status;
        if (seen && was !== undefined) {
          if (RANK[st] > RANK[was]) events.push({ topic: 'storage', kind, status: st, nas, item: x });
          else if (st === 'normal' && RANK[was] > 0) events.push({ topic: 'storage', kind, status: 'normal', nas, item: x });
        }
        map[x.id] = st;
      }
      for (const k of Object.keys(map)) if (!ids.has(k)) delete map[k];
    }

    // volumes: almost full (with hysteresis)
    const volIds = new Set();
    for (const v of snap.volumes || []) {
      volIds.add(v.id);
      if (v.pct == null) continue;
      const was = n.full[v.id];
      const over = v.pct >= cfg.fullPct || (was === true && v.pct > cfg.fullPct - FULL_HYSTERESIS);
      if (seen && was === false && over) events.push({ topic: 'storage', kind: 'full', nas, item: v });
      n.full[v.id] = over;
    }
    for (const k of Object.keys(n.full)) if (!volIds.has(k)) delete n.full[k];

    // drives: health and temperature
    const diskIds = new Set();
    for (const d of snap.disks || []) {
      diskIds.add(d.id);
      const was = n.disk[d.id];
      if (d.health !== 'unknown' || was === undefined) {
        const h = d.health === 'unknown' ? 'normal' : d.health;
        if (seen && was !== undefined && HEALTH[h] > HEALTH[was]) events.push({ topic: 'disk', kind: h, nas, item: d });
        n.disk[d.id] = h;
      }
      if (d.temp != null) {
        const wasHot = n.hot[d.id];
        const hot = d.temp >= cfg.diskTempMax || (wasHot === true && d.temp > cfg.diskTempMax - TEMP_HYSTERESIS);
        if (seen && wasHot === false && hot) events.push({ topic: 'disk', kind: 'hot', nas, item: d });
        n.hot[d.id] = hot;
      }
    }
    for (const m of [n.disk, n.hot]) for (const k of Object.keys(m)) if (!diskIds.has(k)) delete m[k];

    // DSM update: once per version (null = not checked this time: keep)
    if (snap.update) {
      const ver = snap.update.available ? (snap.update.version || '?') : null;
      const had = prevN && Object.prototype.hasOwnProperty.call(prevN, 'update');
      if (ver && had && prevN.update !== ver) events.push({ topic: 'update', kind: 'available', nas, version: ver, installed: snap.info && snap.info.dsm });
      // remember the last announced version even when it is gone (installed): never twice
      n.update = ver || (had ? prevN.update : null);
    }

    // Hyper Backup: a new failed / partial run (result + time)
    if (Array.isArray(snap.backups)) {
      const prevB = (prevN && prevN.backup) || null;
      const b = {};
      for (const t of snap.backups) {
        const key = `${t.result}|${t.last_time || ''}`;
        const was = prevB ? prevB[String(t.id)] : undefined;
        if (seen && prevB && was !== undefined && was !== key && (t.result === 'failed' || t.result === 'partial')) {
          events.push({ topic: 'backup', kind: t.result, nas, item: t });
        }
        b[String(t.id)] = key;
      }
      n.backup = b;
    }

    n.seen = true;
    memo.nas[id] = n;
  }
  // NAS without an observation this time: keep what was known
  for (const [id, n] of Object.entries(prevAll)) if (!(id in memo.nas)) memo.nas[id] = n;
  return { memo, events };
}

// ─── Notifications ──────────────────────────────

const GB = 1e9;
function bytes(v, lang) {
  if (v == null) return '–';
  const tb = v >= 1e12;
  return `${notify.num(tb ? v / 1e12 : v / GB, lang, tb ? 2 : 0)} ${tb ? 'TB' : 'GB'}`;
}

function fmtTime(ms, lang) {
  if (!ms) return '–';
  try {
    return new Date(ms).toLocaleString(lang === 'en' ? 'en-GB' : 'de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch { return '–'; }
}

const cut = (s, n) => String(s == null ? '' : s).slice(0, n);
const fact = (label, value) => ({ label: cut(label, 60), value: cut(value, 120) || '–' });

/** Event → gc.notify payload (users: null — the topic's rule decides, e.g. administrators). */
function toNotification(gc, ev, cfg) {
  const lang = cfg.lang;
  const tx = (k, p) => notify.fmt(TEXTS, lang, k, p);
  const nasName = ev.nas.name || `NAS ${ev.nas.id}`;
  const base = { ...notify.openAction(gc, lang), nas_id: ev.nas.id };
  const nasFact = fact(tx('fact.nas'), nasName);

  if (ev.topic === 'unreachable') {
    const collapseKey = `down:${ev.nas.id}`;
    if (ev.kind === 'up') {
      return { topic: 'unreachable', title: tx('up.title'), body: tx('up.body', { name: nasName }), priority: 'info', collapseKey, ttl: 12 * 3600, users: null, data: { ...base, facts: [nasFact] } };
    }
    const facts = [nasFact];
    if (ev.lastSeen) facts.push(fact(tx('fact.last_seen'), fmtTime(ev.lastSeen, lang)));
    return {
      topic: 'unreachable', title: tx('down.title'), body: tx('down.body', { name: nasName, n: ev.failures }), priority: 'high', collapseKey, ttl: 24 * 3600, users: null,
      data: { ...base, facts },
    };
  }

  if (ev.topic === 'storage') {
    const it = ev.item;
    if (ev.kind === 'full') {
      return {
        topic: 'storage', title: tx('full.title'), body: tx('full.body', { what: it.name, nas: nasName, pct: notify.num(it.pct, lang, 1) }), priority: 'normal',
        collapseKey: `full:${ev.nas.id}:${it.id}`, ttl: 24 * 3600, users: null,
        data: { ...base, facts: [nasFact, fact(tx('fact.volume'), it.name), fact(tx('fact.used'), `${notify.num(it.pct, lang, 1)} % (${bytes(it.used, lang)} / ${bytes(it.total, lang)})`), fact(tx('fact.free'), bytes(it.total != null && it.used != null ? it.total - it.used : null, lang))] },
      };
    }
    const isPool = ev.kind === 'pool';
    const what = isPool ? tx('pool.name', { n: it.num != null ? it.num : it.id }) : it.name;
    const facts = [nasFact, fact(isPool ? tx('fact.pool') : tx('fact.volume'), what), fact(tx('fact.status'), tx(`status.${ev.status}`) + (it.raw_status && it.raw_status !== ev.status ? ` (${it.raw_status})` : ''))];
    if (!isPool && it.pct != null) facts.push(fact(tx('fact.used'), `${notify.num(it.pct, lang, 1)} %`));
    return {
      topic: 'storage', title: tx(`${isPool ? 'pool' : 'vol'}.${ev.status}`), body: tx('storage.body', { nas: nasName, what, status: tx(`status.${ev.status}`) }),
      priority: ev.status === 'normal' ? 'info' : 'high', collapseKey: `${isPool ? 'pool' : 'vol'}:${ev.nas.id}:${it.id}`, ttl: 24 * 3600, users: null, data: { ...base, facts },
    };
  }

  if (ev.topic === 'disk') {
    const d = ev.item;
    const facts = [nasFact, fact(tx('fact.disk'), d.name)];
    if (d.model) facts.push(fact(tx('fact.model'), [d.vendor, d.model].filter(Boolean).join(' ')));
    if (d.temp != null) facts.push(fact(tx('fact.temp'), `${notify.num(d.temp, lang)} °C`));
    if (ev.kind === 'hot') {
      return {
        topic: 'disk', title: tx('hot.title'), body: tx('hot.body', { disk: d.name, nas: nasName, temp: notify.num(d.temp, lang) }), priority: 'normal',
        collapseKey: `hot:${ev.nas.id}:${d.id}`, ttl: 12 * 3600, users: null, data: { ...base, facts },
      };
    }
    facts.push(fact(tx('fact.status'), tx(`health.${ev.kind}`) + (d.raw_status ? ` (${d.raw_status})` : '')));
    return {
      topic: 'disk', title: tx(`disk.${ev.kind}`), body: tx('disk.body', { nas: nasName, disk: d.name, status: tx(`health.${ev.kind}`) }), priority: 'high',
      collapseKey: `disk:${ev.nas.id}:${d.id}`, ttl: 48 * 3600, users: null, data: { ...base, facts },
    };
  }

  if (ev.topic === 'update') {
    const facts = [nasFact];
    if (ev.installed) facts.push(fact(tx('fact.installed'), ev.installed));
    facts.push(fact(tx('fact.available'), ev.version));
    return {
      topic: 'update', title: tx('update.title'), body: tx('update.body', { nas: nasName, version: ev.version }), priority: 'info',
      collapseKey: `update:${ev.nas.id}`, ttl: 7 * 86400, users: null, data: { ...base, facts },
    };
  }

  // backup
  const t = ev.item;
  const facts = [nasFact, fact(tx('fact.task'), t.name)];
  if (t.last_time) facts.push(fact(tx('fact.time'), t.last_time));
  return {
    topic: 'backup', title: tx(`backup.${ev.kind === 'partial' ? 'partial' : 'failed'}`), body: tx('backup.body', { nas: nasName, task: t.name }), priority: 'normal',
    collapseKey: `backup:${ev.nas.id}:${t.id}`, ttl: 48 * 3600, users: null, data: { ...base, facts },
  };
}

/** The "power" notice of a reboot / shutdown requested here (also the activity entry). */
function powerNotification(gc, nas, action, userName, cfg) {
  const lang = cfg.lang;
  const tx = (k, p) => notify.fmt(TEXTS, lang, k, p);
  return {
    topic: 'power', title: tx(`power.${action}`), body: tx(action === 'shutdown' ? 'power.body_shutdown' : 'power.body', { nas: nas.name, user: userName || '?' }),
    priority: 'info', collapseKey: `power:${nas.id}`, ttl: 12 * 3600, users: null,
    data: { ...notify.openAction(gc, lang), nas_id: nas.id, facts: [fact(tx('fact.nas'), nas.name), fact(tx('fact.by'), userName || '?')] },
  };
}

// ─── Glue (one check at a time) ─────────────────

let notifier = null;
let chain = Promise.resolve();

function reset() { notifier = null; }
function notifierOf(gc) { if (!notifier) notifier = notify.createNotifier(gc); return notifier; }

/**
 * Compare the observations of the polls just made with the last seen state
 * and send what changed. `known`: ids of the NAS that still exist.
 */
function check(gc, obs, cfg, { now = Date.now(), known = null } = {}) {
  const run = async () => {
    const prev = await notify.loadState(gc, STATE_KEY);
    let prevKnown = prev;
    if (prev && known) prevKnown = { ...prev, nas: Object.fromEntries(Object.entries(prev.nas || {}).filter(([id]) => known.has(Number(id)))) };
    const { memo, events } = evaluate(prevKnown, obs, cfg, now);
    let sent = 0;
    for (const ev of events) {
      const r = await notifierOf(gc).send(toNotification(gc, ev, cfg));
      if (r.sent) sent++;
    }
    await notify.saveState(gc, STATE_KEY, memo, prev ? JSON.stringify(prev) : null);
    return sent;
  };
  const p = chain.then(run, run);
  chain = p.catch((e) => { gc.log.warn('notification check failed', (e && e.code) || (e && e.message)); });
  return p;
}

/** Send the "power" notice (best effort; the action already happened). */
async function sendPower(gc, nas, action, userName, cfg) {
  try { return await notifierOf(gc).send(powerNotification(gc, nas, action, userName, cfg)); } catch (e) { return { sent: false, error: (e && e.code) || 'ERR' }; }
}

module.exports = { evaluate, issuesOf, toNotification, powerNotification, check, sendPower, reset, STATE_KEY, TEXTS, REBOOT_GRACE_MS };
