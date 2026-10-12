'use strict';

// The plugin settings (plugin.json ui.settings), checked: a value out of
// range falls back to its default. gc.settings.all() also returns the
// plugin's secrets (DSM accounts) — only the declared keys are read here and
// nothing of it is ever sent to the browser as is.

const DEFAULTS = Object.freeze({
  poll_interval: 120,
  unreachable_polls: 3,
  storage_full_pct: 90,
  disk_temp_max: 55,
  notify_lang: 'de',
});

const RANGES = Object.freeze({
  poll_interval: [60, 3600],
  unreachable_polls: [1, 20],
  storage_full_pct: [50, 99],
  disk_temp_max: [40, 80],
});

function intIn(v, key) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  const [lo, hi] = RANGES[key];
  return Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n) : null;
}

/** settings → config used everywhere */
function fromSettings(s) {
  const v = s || {};
  const pick = (key) => {
    const n = intIn(v[key], key);
    return n == null ? DEFAULTS[key] : n;
  };
  return {
    interval: pick('poll_interval'),
    unreachablePolls: pick('unreachable_polls'),
    fullPct: pick('storage_full_pct'),
    diskTempMax: pick('disk_temp_max'),
    lang: v.notify_lang === 'en' ? 'en' : 'de',
  };
}

async function load(gc) {
  let s = {};
  try { s = await gc.settings.all(); } catch { /* defaults */ }
  return fromSettings(s);
}

/** The declared settings as the page shows them (never anything else of gc.settings). */
function view(cfg) {
  return {
    poll_interval: cfg.interval, unreachable_polls: cfg.unreachablePolls, storage_full_pct: cfg.fullPct,
    disk_temp_max: cfg.diskTempMax, notify_lang: cfg.lang,
  };
}

module.exports = { DEFAULTS, RANGES, intIn, fromSettings, load, view };
