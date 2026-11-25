'use strict';

// The plugin's settings (plugin.json ui.settings) with their defaults and limits.

const DEFAULTS = Object.freeze({ auto_map: true, children_shares: false, away_direct_all: false, max_offline_days: 90, offline_hint_days: 30, cast: true, log_days: 90 });

const num = (v, min, max, d) => (Number.isFinite(Number(v)) ? Math.max(min, Math.min(max, Math.round(Number(v)))) : d);
const bool = (v, d) => (typeof v === 'boolean' ? v : d);

async function load(gc) {
  let s = {};
  try { s = (await gc.settings.all()) || {}; } catch { s = {}; }
  return {
    autoMap: bool(s.auto_map, DEFAULTS.auto_map),
    childrenShares: bool(s.children_shares, DEFAULTS.children_shares),
    awayDirectAll: bool(s.away_direct_all, DEFAULTS.away_direct_all),
    maxOfflineDays: num(s.max_offline_days, 7, 3650, DEFAULTS.max_offline_days),
    offlineHintDays: num(s.offline_hint_days, 1, 3650, DEFAULTS.offline_hint_days),
    cast: bool(s.cast, DEFAULTS.cast),
    logDays: num(s.log_days, 7, 730, DEFAULTS.log_days),
  };
}

module.exports = { DEFAULTS, load };
