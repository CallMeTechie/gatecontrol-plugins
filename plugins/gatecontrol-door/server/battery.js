'use strict';

// 1.8.0: the battery of a lock / an opener as the badge of its widget (24×24 stroke): an outline filled with 0–3 bars
// by level, a lightning bolt while it charges (Smart Lock 3.0 Pro / 4.0 with the Power Pack), an exclamation mark for
// "critical" without a percentage (older bridges report only batteryCritical)
const BATTERY_OUTLINE = 'M2 7h16v10H2zM21 10v4';
const BATTERY_ICONS = Object.freeze([
  [15, BATTERY_OUTLINE],
  [40, BATTERY_OUTLINE + 'M6 10v4'],
  [75, BATTERY_OUTLINE + 'M6 10v4M10 10v4'],
  [Infinity, BATTERY_OUTLINE + 'M6 10v4M10 10v4M14 10v4'],
]);
const BATTERY_CHARGING_ICON = BATTERY_OUTLINE + 'M11 9l-3 3h4l-3 3';
const BATTERY_CRITICAL_ICON = BATTERY_OUTLINE + 'M10 9.5v2.5M10 14.5h.01';
const BATTERY_WARN_PCT = 30;
const BATTERY_CRIT_PCT = 15;
const { clip } = require('./util');

/**
 * The battery of a lock's state as GateControl's widget.badge { icon, value, unit, state, label } — null when the
 * lock reports nothing about it (no percentage and not critical). state: crit when Nuki reports batteryCritical or at
 * ≤ 15 %, warn at ≤ 30 %, good otherwise; charging: the lightning icon and the label „Akku lädt“.
 */
function badge(t, lang, s) {
  const pct = s && typeof s.batteryPercent === 'number' && Number.isFinite(s.batteryPercent) ? Math.max(0, Math.min(100, Math.round(s.batteryPercent))) : null;
  const critical = !!(s && s.batteryCritical);
  if (pct == null && !critical) return null;
  const level = critical || (pct != null && pct <= BATTERY_CRIT_PCT) ? 'crit' : (pct != null && pct <= BATTERY_WARN_PCT ? 'warn' : 'good');
  const charging = !!(s && s.batteryCharging);
  const icon = charging ? BATTERY_CHARGING_ICON : (pct == null ? BATTERY_CRITICAL_ICON : BATTERY_ICONS.find(([max]) => pct <= max)[1]);
  const label = clip(t(lang, charging ? 'qa.battery_charging' : (critical ? 'qa.battery_critical' : 'qa.battery')), 20);
  return pct == null ? { icon, value: clip(t(lang, 'qa.battery_low'), 8), state: level, label } : { icon, value: pct, unit: '%', state: level, label };
}

module.exports = { badge, BATTERY_ICONS, BATTERY_CHARGING_ICON, BATTERY_CRITICAL_ICON, BATTERY_WARN_PCT, BATTERY_CRIT_PCT };
