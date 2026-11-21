'use strict';

// The battery of a device (since 1.13.0): one place for the quick actions of the apps (widget.badge), the portal and
// the page. A resource's state carries it as
//   battery     a whole percentage (Shelly H&T and other Shelly / Tasmota sensors, zigbee2mqtt, Bluetooth, deCONZ
//               config.battery)
//   lowbattery  true — deCONZ's "low battery" without a percentage
//   sleeping    a battery device of Shelly / Tasmota that sleeps between its reports (server/edge.js), lastupdated
//               its last report; reachable false then means: silent for longer than such a device sleeps (26 h)
// The threshold "Batterie schwach" is the plugin setting of the notification (5–50 %, default 15): at or below it the
// badge is 'warn', at or below 5 % (or deCONZ's flag, or a sleeper that is overdue — "Batterie leer?") 'crit'.

const CRIT_PCT = 5;

// 24×24 stroke icons (GateControl's quick actions take SVG path data): an outline, filled with bars by level
const OUTLINE = 'M2 7h16v10H2zM21 10v4';
const LEVEL_ICONS = Object.freeze([
  [15, OUTLINE],
  [40, OUTLINE + 'M6 10v4'],
  [75, OUTLINE + 'M6 10v4M10 10v4'],
  [Infinity, OUTLINE + 'M6 10v4M10 10v4M14 10v4'],
]);
const EMPTY_ICON = OUTLINE + 'M10 9.5v2.5M10 14.5h.01';   // an exclamation mark: low, without a percentage

const TEXTS = {
  de: { label: 'Batterie', empty: 'Batterie leer?', low: 'schwach', min: 'vor {{n}} min', h: 'vor {{n}} h', d: 'vor {{n}} T' },
  en: { label: 'Battery', empty: 'Battery empty?', low: 'low', min: '{{n}} min ago', h: '{{n}} h ago', d: '{{n}} d ago' },
};

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** What a state says of the battery: { pct (whole %) | null, flag } — or null when it says nothing. */
function of(state) {
  const st = state || {};
  const n = finite(typeof st.battery === 'string' && /^\d{1,3}$/.test(st.battery) ? Number(st.battery) : st.battery);
  const pct = n == null ? null : Math.max(0, Math.min(100, Math.round(n)));
  const flag = st.lowbattery === true;
  return pct == null && !flag ? null : { pct, flag };
}

/** The battery is low: at or below the threshold, or deCONZ's flag. */
function isLow(state, lowAt) {
  const b = of(state);
  return !!b && (b.flag || (b.pct != null && b.pct <= lowAt));
}

/** A sleeper of Shelly / Tasmota that has been silent for longer than it sleeps. */
const overdue = (st) => st.sleeping === true && st.reachable === false;

/** 'good' | 'warn' | 'crit' of a battery. */
function levelOf(state, lowAt) {
  const st = state || {};
  const b = of(st);
  if (!b) return null;
  if (overdue(st) || (b.pct == null ? b.flag : b.pct <= Math.min(CRIT_PCT, lowAt))) return 'crit';
  return b.flag || b.pct <= lowAt ? 'warn' : 'good';
}

/** "vor 3 h" — how old a value is (null: unknown or under a minute). */
function ageText(iso, now, lang) {
  const at = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return null;
  const min = Math.floor((now - at) / 60000);
  if (!(min >= 1)) return null;
  const tx = TEXTS[lang === 'en' ? 'en' : 'de'];
  const [key, n] = min < 60 ? ['min', min] : (min < 48 * 60 ? ['h', Math.floor(min / 60)] : ['d', Math.floor(min / 1440)]);
  return tx[key].replace('{{n}}', String(n));
}

/**
 * The battery as the badge of a quick action's widget (GateControl's widget.badge { icon, value, unit, state,
 * label ≤ 20 }) — null without a battery. A sleeping device (Shelly H&T) shows its last value with its age in the
 * label ("Batterie, vor 3 h"), an overdue one "Batterie leer?".
 */
function badge(state, { lowAt, lang, now = Date.now() }) {
  const st = state || {};
  const b = of(st);
  if (!b) return null;
  const tx = TEXTS[lang === 'en' ? 'en' : 'de'];
  let label = tx.label;
  if (overdue(st)) label = tx.empty;
  else if (st.sleeping === true || st.reachable === false) {
    const age = ageText(st.lastupdated, now, lang);
    if (age && `${tx.label}, ${age}`.length <= 20) label = `${tx.label}, ${age}`;
  }
  const out = { icon: b.pct == null ? EMPTY_ICON : LEVEL_ICONS.find(([max]) => b.pct <= max)[1], state: levelOf(st, lowAt), label };
  if (b.pct != null) { out.value = b.pct; out.unit = '%'; } else out.value = tx.low;
  return out;
}

module.exports = { CRIT_PCT, OUTLINE, LEVEL_ICONS, EMPTY_ICON, of, isLow, levelOf, ageText, badge };
