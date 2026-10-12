'use strict';

// The plugin settings (plugin.json ui.settings), checked: a value out of its
// range falls back to the default.

const DEFAULTS = Object.freeze({
  poll_interval: 60,
  storage_threshold: 90,
  cpu_threshold: 0,
  ram_threshold: 0,
  load_minutes: 15,
  show_updates: false,
  notify_recipients: 'admins',
  notify_lang: 'de',
});

/** Minutes a host or node must be unreachable / offline before it is announced. */
const DOWN_MINUTES = 5;

function intIn(v, lo, hi, d) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  return Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n) : d;
}
function bool(v, d) { return typeof v === 'boolean' ? v : (v === 'true' ? true : (v === 'false' ? false : d)); }

/** settings (gc.settings.all()) → config. Never handed to the browser as is (it holds the secrets too). */
function fromSettings(s) {
  const v = s || {};
  return {
    pollSec: intIn(v.poll_interval, 30, 3600, DEFAULTS.poll_interval),
    storagePct: intIn(v.storage_threshold, 50, 99, DEFAULTS.storage_threshold),
    cpuPct: intIn(v.cpu_threshold, 0, 100, DEFAULTS.cpu_threshold),
    ramPct: intIn(v.ram_threshold, 0, 100, DEFAULTS.ram_threshold),
    loadMin: intIn(v.load_minutes, 5, 240, DEFAULTS.load_minutes),
    showUpdates: bool(v.show_updates, DEFAULTS.show_updates),
    recipients: v.notify_recipients === 'rule' ? 'rule' : 'admins',
    lang: v.notify_lang === 'en' ? 'en' : 'de',
    downMin: DOWN_MINUTES,
  };
}

async function load(gc) {
  let s = {};
  try { s = await gc.settings.all(); } catch { /* defaults */ }
  return fromSettings(s);
}

/** What the page may see of the configuration. */
function view(cfg) {
  return {
    poll_interval: cfg.pollSec, storage_threshold: cfg.storagePct, cpu_threshold: cfg.cpuPct, ram_threshold: cfg.ramPct,
    load_minutes: cfg.loadMin, show_updates: cfg.showUpdates, notify_recipients: cfg.recipients, notify_lang: cfg.lang, down_minutes: cfg.downMin,
  };
}

module.exports = { DEFAULTS, DOWN_MINUTES, fromSettings, load, view };
