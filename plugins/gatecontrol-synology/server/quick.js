'use strict';

// What the GateControl apps get from this plugin (declarative data; the host
// checks and caps it, the apps draw it — never plugin HTML):
//
//   quick actions  per NAS a device nas:<id> with the buttons
//                    refresh:<id>          "Aktualisieren" — carries the NAS widget (power: false)
//                    backup:<id>:<task>    "Backup jetzt" per Hyper Backup task (confirm)
//                    reboot:<id>           "Neustart" (confirm)
//                    shutdown:<id>         "Herunterfahren" (confirm)
//   widget         storage used (all volumes together) as the large value,
//                  CPU / RAM / temperature as readings, the health as the
//                  badge, the most important problem as the status line
//   Start tile     per NAS: "62 % belegt", items storage, temperature, health
//
// Built from the stored NAS rows and their last good status only — no
// request to a NAS while listing. Health and problems are the page's
// (ui/admin.js stateOf, alerts.issuesOf), so the apps never say anything
// else than the plugin page.

const alerts = require('./alerts');
const notify = require('./notify');

const QA_MAX = 16;
const TILE_MAX = 8;
const BACKUPS_PER_NAS = 4;
const QA_ID_RE = /^(refresh|reboot|shutdown):([1-9][0-9]{0,9})$|^backup:([1-9][0-9]{0,9}):(0|[1-9][0-9]{0,9})$/;
const CPU_RAM_WARN = 90; // like the page's metrics
const FULL_CRIT = 98;    // like alerts.issuesOf

// 24×24 stroke icons (SVG path data)
const ICONS = Object.freeze({
  nas: 'M5 3h14v18H5zM8 7h8M8 11h8M9 16.5h.01M12 16.5h.01M15 16.5h.01',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  backup: 'M3 4h18v4H3zM5 8v12h14V8M12 11v6M9.5 13.5L12 11l2.5 2.5',
  reboot: 'M4 12a8 8 0 1 0 2.3-5.7M4 4v5h5',
  shutdown: 'M12 3v9M6.4 6.4a8 8 0 1 0 11.2 0',
  cpu: 'M7 7h10v10H7zM10 10h4v4h-4zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4',
  memory: 'M3 7h18v10H3zM7 10v4M11 10v4M15 10v4M6 17v3M18 17v3',
  thermometer: 'M10 13V5a2 2 0 1 1 4 0v8a4 4 0 1 1-4 0z',
  storage: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3v12c0 1.7-3.6 3-8 3s-8-1.3-8-3zM4 6c0 1.7 3.6 3 8 3s8-1.3 8-3M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  shieldCheck: 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6zM8.5 12l2.5 2.5 4.5-5',
  shieldAlert: 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6zM12 8v5M12 16h.01',
});

/** A text as the host takes it unchanged: no control characters, trimmed, at most `max` UTF-16 units. */
function clip(v, max) {
  let s = String(v == null ? '' : v).replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length > max) s = s.slice(0, max).replace(/[\ud800-\udbff]$/, '').trimEnd();
  return s;
}

/**
 * A message for the apps (≤ 120): as it is, else its leading sentences that
 * fit (a sentence ends with . ! ? after two characters other than space,
 * "(" or "." and before a capital — "z. B." and "e.g." end none), else cut
 * at a word with "…".
 */
function short(v, max = 120) {
  const s = clip(v, 10000);
  if (s.length <= max) return s;
  let end = 0;
  for (const m of s.matchAll(/[^\s(.]{2}[.!?](?=\s+[A-ZÄÖÜ„“"])/g)) {
    const at = m.index + m[0].length;
    if (at > max) break;
    end = at;
  }
  if (end) return s.slice(0, end);
  const cut = clip(s, max - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > max / 2 ? cut.slice(0, sp) : cut).replace(/[\s,;:–-]+$/, '') + '…';
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** Storage used in % over all volumes with a known size (null without one). */
function storagePct(data) {
  let total = 0;
  let used = 0;
  for (const v of (data && data.volumes) || []) {
    if (!finite(v.total) || v.total <= 0) continue;
    total += v.total;
    used += finite(v.used) ? v.used : 0;
  }
  return total > 0 ? Math.max(0, Math.min(100, Math.round((used * 100) / total))) : null;
}

/** Colour of the storage value: crit from 98 %, warn from the "almost full" setting. */
function storageState(pct, cfg) {
  if (pct == null) return null;
  if (pct >= FULL_CRIT) return 'crit';
  return pct >= cfg.fullPct ? 'warn' : null;
}

/** One problem of alerts.issuesOf as the page says it (ui/admin.js issueText). */
function issueText(t, lang, i) {
  const n = (v, d = 0) => notify.num(v, lang, d) || '–';
  switch (i.kind) {
    case 'pool': return t(lang, `issue.pool_${i.status}`, { name: t(lang, 'pool.name', { n: i.num != null ? i.num : i.id }) });
    case 'volume': return t(lang, `issue.volume_${i.status}`, { name: i.name });
    case 'full': return t(lang, 'issue.full', { name: i.name, pct: n(i.pct, 1) });
    case 'disk': return t(lang, `issue.disk_${i.status}`, { name: i.name });
    case 'hot': return t(lang, 'issue.hot', { name: i.name, temp: n(i.temp) });
    case 'backup': return t(lang, `issue.backup_${i.status}`, { name: i.name });
    case 'ups': return t(lang, `issue.ups_${i.status}`, { charge: n(i.charge) });
    case 'update': return t(lang, 'issue.update', { version: i.version || '?' });
    default: return String(i.kind || '');
  }
}

/**
 * The health of a NAS as the page shows it (ui/admin.js stateOf):
 * { state: 'good'|'warn'|'crit'|null, short (≤ 20, the page's tag), line (≤ 60, the most important problem) }.
 * A shut-down NAS, a new one and one without data are neutral (null).
 */
function healthOf(n, data, cfg, t, lang) {
  const out = (state, shortKey, line) => ({ state, short: clip(t(lang, shortKey), 20), line: clip(line || t(lang, shortKey), 60) });
  if (n.power_state === 'shutdown' && n.status !== 'ok') return out(null, 'st.shutdown');
  if (n.power_state === 'reboot') return out('warn', 'st.reboot');
  if (n.status === 'new') return out(null, 'st.new', t(lang, 'widget.no_data'));
  if (n.status === 'otp') return out('crit', 'st.otp');
  if (n.status === 'auth') return out('crit', 'qa.short_auth', t(lang, 'st.auth'));
  if (n.status === 'error') return n.error_count >= cfg.unreachablePolls ? out('crit', 'st.unreachable') : out('warn', 'st.error', t(lang, 'qa.poll_failed'));
  const issues = alerts.issuesOf(data, cfg);
  const crit = issues.find((i) => i.level === 'crit');
  if (crit) return out('crit', 'st.crit', issueText(t, lang, crit));
  const warn = issues.find((i) => i.level === 'warn');
  if (warn) return out('warn', 'st.warn', issueText(t, lang, warn));
  if (!data) return out(null, 'st.new', t(lang, 'widget.no_data'));
  const info = issues.find((i) => i.level === 'info');
  return out('good', 'st.ok', info ? issueText(t, lang, info) : t(lang, 'widget.all_ok'));
}

/** CPU / RAM / temperature readings — live values only (a NAS that does not answer shows none). */
function readingsOf(n, data, t, lang) {
  if (!data || n.status !== 'ok') return [];
  const util = data.util || {};
  const info = data.info || {};
  const out = [];
  if (finite(util.cpu)) out.push({ id: 'cpu', label: clip(t(lang, 'widget.cpu'), 20), value: Math.round(util.cpu), unit: '%', icon: ICONS.cpu, state: util.cpu >= CPU_RAM_WARN ? 'warn' : null });
  if (finite(util.ram)) out.push({ id: 'ram', label: clip(t(lang, 'widget.ram'), 20), value: Math.round(util.ram), unit: '%', icon: ICONS.memory, state: util.ram >= CPU_RAM_WARN ? 'warn' : null });
  if (finite(info.temp)) out.push({ id: 'temp', label: clip(t(lang, 'widget.temp'), 20), value: Math.round(info.temp), unit: '°C', icon: ICONS.thermometer, state: info.temp_warn ? 'warn' : null });
  return out;
}

/** The widget of a NAS (on its "Aktualisieren" button). */
function widgetOf(n, data, cfg, t, lang) {
  const h = healthOf(n, data, cfg, t, lang);
  const pct = storagePct(data);
  return {
    label: clip(t(lang, 'widget.storage'), 24),
    value: pct,
    unit: pct == null ? null : '%',
    status: h.line,
    state: h.state,
    readings: readingsOf(n, data, t, lang),
    controls: [],
    power: false,
    badge: { icon: h.state === 'good' || h.state == null ? ICONS.shieldCheck : ICONS.shieldAlert, value: null, state: h.state, label: clip(t(lang, 'widget.health'), 20) },
  };
}

function deviceOf(n, data, t, lang) {
  const title = clip(n.name, 40) || `NAS ${n.id}`;
  const model = data && data.info && data.info.model ? clip(data.info.model, 60) : '';
  return { id: `nas:${n.id}`, title, ...(model ? { subtitle: model } : {}), icon: ICONS.nas };
}

/** The Hyper Backup tasks the buttons offer (at most 4 per NAS, in DSM's order). */
function backupTasks(data) {
  return Array.isArray(data && data.backups) ? data.backups.filter((b) => b && Number.isSafeInteger(b.id) && b.id >= 0).slice(0, BACKUPS_PER_NAS) : [];
}

/** The quick actions of one NAS: refresh (widget), backup per task, restart, shut down. */
function actionsOf(n, data, cfg, t, lang) {
  const device = deviceOf(n, data, t, lang);
  const name = device.title;
  const out = [{ id: `refresh:${n.id}`, title: clip(t(lang, 'qa.refresh'), 40), subtitle: clip(name, 60), icon: ICONS.refresh, kind: 'button', device, widget: widgetOf(n, data, cfg, t, lang) }];
  const tasks = backupTasks(data);
  for (const b of tasks) {
    const task = clip(b.name, 40) || `#${b.id}`;
    out.push({
      id: `backup:${n.id}:${b.id}`, kind: 'button', confirm: true, icon: ICONS.backup, device,
      title: tasks.length > 1 ? task : clip(t(lang, 'qa.backup'), 40),
      subtitle: clip(tasks.length > 1 ? `${t(lang, 'qa.backup')} · ${name}` : `${name} · ${task}`, 60),
    });
  }
  out.push({ id: `reboot:${n.id}`, title: clip(t(lang, 'qa.reboot'), 40), subtitle: clip(name, 60), icon: ICONS.reboot, kind: 'button', confirm: true, device });
  out.push({ id: `shutdown:${n.id}`, title: clip(t(lang, 'qa.shutdown'), 40), subtitle: clip(name, 60), icon: ICONS.shutdown, kind: 'button', confirm: true, device });
  return out;
}

/** All quick actions: the enabled NAS in the page's order, at most 16 entries. */
function actionsFor(list, snaps, cfg, t, lang) {
  const out = [];
  for (const n of list) {
    if (!n.enabled) continue;
    const snap = snaps.get(n.id);
    out.push(...actionsOf(n, snap ? snap.data : null, cfg, t, lang));
    if (out.length >= QA_MAX) break;
  }
  return out.slice(0, QA_MAX);
}

/** The Start tile of a NAS (apps): "62 % belegt", items storage, temperature, health. */
function tileOf(n, data, cfg, t, lang) {
  const h = healthOf(n, data, cfg, t, lang);
  const pct = storagePct(data);
  const items = [];
  if (pct != null) items.push({ label: clip(t(lang, 'tile.storage'), 20), icon: ICONS.storage, value: pct, unit: '%', state: storageState(pct, cfg) });
  const info = data && data.info;
  if (n.status === 'ok' && info && finite(info.temp)) items.push({ label: clip(t(lang, 'widget.temp'), 20), icon: ICONS.thermometer, value: Math.round(info.temp), unit: '°C', state: info.temp_warn ? 'warn' : null });
  items.push({ label: h.short, icon: h.state === 'good' || h.state == null ? ICONS.shieldCheck : ICONS.shieldAlert, state: h.state });
  return {
    section: 'nas', title: clip(n.name, 60) || `NAS ${n.id}`,
    value: clip(pct != null ? t(lang, 'tile.used', { pct }) : h.short, 40),
    state: h.state, icon: ICONS.nas, items,
  };
}

function tilesFor(list, snaps, cfg, t, lang) {
  return list.filter((n) => n.enabled).slice(0, TILE_MAX).map((n) => {
    const snap = snaps.get(n.id);
    return tileOf(n, snap ? snap.data : null, cfg, t, lang);
  });
}

/** "refresh:3" → { kind: 'refresh', nas: 3 }, "backup:3:1" → { kind: 'backup', nas: 3, task: 1 }; null when no such id. */
function parseId(id) {
  const m = typeof id === 'string' ? QA_ID_RE.exec(id) : null;
  if (!m) return null;
  return m[1] ? { kind: m[1], nas: Number(m[2]) } : { kind: 'backup', nas: Number(m[3]), task: Number(m[4]) };
}

module.exports = {
  actionsFor, actionsOf, tilesFor, tileOf, widgetOf, healthOf, storagePct, issueText, parseId, clip, short,
  ICONS, QA_MAX, TILE_MAX, BACKUPS_PER_NAS,
};
