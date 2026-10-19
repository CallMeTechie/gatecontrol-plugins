'use strict';

// Dreo devices as the plugin shows them: the raw values a heater or air
// conditioner reports (keys of the Dreo app, see dreo.js) → the plugin's
// state ({ power, mode, targetTemp, indoorTemp, … } in °C), what a device can
// do (caps: modes, target range, swing, fan levels, switches) and a change of
// that state → the Dreo command (params). Mapping after hass-dreo (MIT):
//
//   heater  poweron · mode 'hotair' (+ htalevel 1…n) | 'eco' (thermostat, ecolevel) | 'coolair' (fan)
//           ecolevel/temperature in °F · oscon/oscangle (0 = swing, 60/90/120) or oscmode 0…4
//           childlockon · muteon (sound = not muteon) · winopenon · ptcon (heating, read only)
//           DR-HSH016S (tower fan + heater): mode 1 heat / 2 fan, htamode 1 power / 2 eco
//   ac      poweron · mode 1 cool 2 dry 3 fan 4 sleep 5 eco · templevel (°F, the app's own °C table)
//           temperature (°F) · windlevel 1 low 2 medium 3 high 4 auto · oscmode 2 on / 0 off · rh

const HEATER_PREFIXES = ['DR-HSH', 'WH'];
const AC_PREFIXES = ['DR-HAC'];

/** 'heater' | 'ac' | null (a Dreo device this plugin does not control: fans, purifiers, …) */
function kindOf(model) {
  const m = String(model || '').toUpperCase();
  if (HEATER_PREFIXES.some((p) => m.startsWith(p))) return 'heater';
  if (AC_PREFIXES.some((p) => m.startsWith(p))) return 'ac';
  return null;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round1 = (v) => Math.round(v * 10) / 10;
/** A temperature as the device reports it: °F (Dreo's unit) → °C; small values are already °C. */
function toC(v) {
  if (!isNum(v)) return null;
  return v > 45 ? round1((v - 32) * 5 / 9) : round1(v);
}
const cToF = (c) => Math.round(c * 9 / 5 + 32);

// ─── Heater ─────────────────────────────────────

const HEATER_TARGET = { min: 5, max: 35, step: 1 };        // ecolevel 41…95 °F
const SWING_ANGLES = { 0: 'osc', 60: '60', 90: '90', 120: '120' };
const SWING_OSCMODE = { 0: 'off', 1: 'osc', 2: '60', 3: '90', 4: '120' };

function heatLevels(model) {
  return /^DR-HSH016S/i.test(String(model || '')) ? 5 : 3;
}
const isCombo = (raw) => isNum(raw.mode);  // DR-HSH016S: integer function instead of a mode string

function heaterMode(raw, model) {
  const levels = heatLevels(model);
  const level = isNum(raw.htalevel) ? Math.min(levels, Math.max(1, Math.round(raw.htalevel))) : 1;
  if (isCombo(raw)) {
    if (raw.mode === 2) return 'fan';
    return raw.htamode === 2 ? 'eco' : 'heat' + level;
  }
  if (raw.mode === 'coolair') return 'fan';
  if (raw.mode === 'eco') return 'eco';
  if (raw.mode === 'hotair') return 'heat' + level;
  return null;
}

function heaterSwing(raw) {
  if (isNum(raw.oscmode)) return SWING_OSCMODE[raw.oscmode] || 'off';
  if (typeof raw.oscon !== 'boolean') return null;
  if (!raw.oscon) return 'off';
  return 'oscangle' in raw ? (SWING_ANGLES[raw.oscangle] || 'osc') : 'on';
}

function heaterSwingOptions(raw) {
  if (isNum(raw.oscmode) || 'oscangle' in raw) return ['off', 'osc', '60', '90', '120'];
  if (typeof raw.oscon === 'boolean') return ['off', 'on'];
  return null;
}

// ─── Air conditioner ────────────────────────────

const AC_MODES = { 1: 'cool', 2: 'dry', 3: 'fan', 4: 'sleep', 5: 'eco' };
const AC_MODE_NUM = { cool: 1, dry: 2, fan: 3, sleep: 4, eco: 5 };
const AC_FAN = { 1: 'low', 2: 'medium', 3: 'high', 4: 'auto' };
const AC_FAN_NUM = { low: 1, medium: 2, high: 3, auto: 4 };
// what the Dreo remote sends for a °C setting (hass-dreo CELSIUS_TO_FAHRENHEIT_MAP)
const AC_C_TO_F = { 16: 61, 17: 63, 18: 65, 19: 67, 20: 68, 21: 70, 22: 72, 23: 74, 24: 76, 25: 77, 26: 79, 27: 81, 28: 83, 29: 85, 30: 86 };
const AC_TARGET = { min: 16, max: 30, step: 1 };

function acTargetC(f) {
  if (!isNum(f)) return null;
  if (f <= 45) return Math.round(f);
  let best = null;
  for (const [c, v] of Object.entries(AC_C_TO_F)) if (best == null || Math.abs(v - f) < Math.abs(AC_C_TO_F[best] - f)) best = Number(c);
  return best;
}

// ─── State, caps, commands ──────────────────────

/** The plugin's state of a Dreo device; null fields = not reported. */
function normalize(kind, model, raw) {
  const r = raw || {};
  const st = { power: typeof r.poweron === 'boolean' ? r.poweron : null, mode: null, targetTemp: null, indoorTemp: toC(r.temperature) };
  if (kind === 'heater') {
    st.mode = heaterMode(r, model);
    st.targetTemp = isNum(r.ecolevel) ? Math.round(toC(r.ecolevel)) : null;
    st.swing = heaterSwing(r);
    if (typeof r.ptcon === 'boolean') st.heating = r.ptcon;
  } else if (kind === 'ac') {
    st.mode = AC_MODES[r.mode] || null;
    st.targetTemp = acTargetC(r.templevel);
    st.fanLevel = AC_FAN[r.windlevel] || null;
    st.swing = isNum(r.oscmode) ? (r.oscmode === 0 ? 'off' : 'on') : null;
    if (isNum(r.rh)) st.humidity = r.rh;
  }
  if (typeof r.childlockon === 'boolean') st.childLock = r.childlockon;
  if (typeof r.muteon === 'boolean') st.sound = !r.muteon;
  if (typeof r.winopenon === 'boolean') st.window = r.winopenon;
  return st;
}

const SWITCHES = ['childLock', 'sound', 'window'];

/**
 * What the device offers, with labels in the viewer's language:
 * { vendor, kind, modes: [{ id, label }], target, fan, swing, switches }.
 */
function capsOf(kind, model, raw, t, lang) {
  const r = raw || {};
  const L = (k, p) => t(lang, k, p);
  const caps = { vendor: 'dreo', kind, modes: [], target: null, fan: null, swing: null, switches: [] };
  if (kind === 'heater') {
    for (let i = 1; i <= heatLevels(model); i++) caps.modes.push({ id: 'heat' + i, label: L('dmode.heat', { n: i }) });
    caps.modes.push({ id: 'eco', label: L('dmode.eco') }, { id: 'fan', label: L('dmode.fan') });
    caps.target = { ...HEATER_TARGET };
    const sw = heaterSwingOptions(r);
    if (sw) caps.swing = { options: sw.map((id) => ({ id, label: L('swing.' + id) })) };
  } else if (kind === 'ac') {
    caps.modes = ['cool', 'dry', 'fan', 'sleep', 'eco'].map((id) => ({ id, label: L(id === 'eco' ? 'dmode.eco_ac' : 'dmode.' + id) }));
    caps.target = { ...AC_TARGET };
    caps.fan = { kind: 'levels', options: ['auto', 'low', 'medium', 'high'].map((id) => ({ id, label: L('fanlevel.' + id) })) };
    caps.swing = { options: ['off', 'on'].map((id) => ({ id, label: L('swing.' + id) })) };
  }
  const st = normalize(kind, model, r);
  caps.switches = SWITCHES.filter((k) => typeof st[k] === 'boolean').map((id) => ({ id, label: L('switch.' + id) }));
  return caps;
}

function modeParams(kind, model, raw, mode) {
  if (kind === 'ac') return AC_MODE_NUM[mode] ? { mode: AC_MODE_NUM[mode] } : null;
  const m = /^heat([1-9])$/.exec(mode);
  if (m && Number(m[1]) > heatLevels(model)) return null;
  if (isCombo(raw)) {
    if (mode === 'fan') return { mode: 2 };
    if (mode === 'eco') return { mode: 1, htamode: 2 };
    return m ? { mode: 1, htamode: 1, htalevel: Number(m[1]) } : null;
  }
  if (mode === 'fan') return { mode: 'coolair' };
  if (mode === 'eco') return { mode: 'eco' };
  return m ? { mode: 'hotair', htalevel: Number(m[1]) } : null;
}

function swingParams(kind, raw, swing) {
  if (kind === 'ac') return swing === 'on' ? { oscmode: 2 } : swing === 'off' ? { oscmode: 0 } : null;
  if (isNum(raw.oscmode)) {
    const n = Object.keys(SWING_OSCMODE).find((k) => SWING_OSCMODE[k] === swing);
    return n == null ? null : { oscmode: Number(n) };
  }
  if (swing === 'off') return { oscon: false };
  if (swing === 'on') return 'oscangle' in raw ? null : { oscon: true };
  const a = Object.keys(SWING_ANGLES).find((k) => SWING_ANGLES[k] === swing);
  return a == null || !('oscangle' in raw) ? null : { oscon: true, oscangle: Number(a) };
}

/**
 * A checked change → Dreo params, or null when anything in it is not what
 * this device offers (→ 400). Picking a mode or a swing turns the device on.
 */
function toParams(kind, model, raw, patch, caps) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return null;
  const r = raw || {};
  const out = {};
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (k === 'power') {
      if (typeof v !== 'boolean') return null;
      out.poweron = v;
    } else if (k === 'mode') {
      if (typeof v !== 'string' || !caps.modes.some((m) => m.id === v)) return null;
      const p = modeParams(kind, model, r, v);
      if (!p) return null;
      Object.assign(out, p);
      if (!('power' in patch) && r.poweron !== true) out.poweron = true;
    } else if (k === 'targetTemp') {
      const n = typeof v === 'number' ? v : NaN;
      if (!caps.target || !Number.isFinite(n) || n < caps.target.min || n > caps.target.max) return null;
      const c = Math.round(n);
      // in the unit the device reports (°F as a rule; a device that already reports °C gets °C)
      const current = kind === 'ac' ? r.templevel : r.ecolevel;
      if (isNum(current) && current <= 45) out[kind === 'ac' ? 'templevel' : 'ecolevel'] = c;
      else if (kind === 'ac') out.templevel = AC_C_TO_F[c];
      else out.ecolevel = Math.min(95, Math.max(41, cToF(c)));
    } else if (k === 'swing') {
      if (typeof v !== 'string' || !caps.swing || !caps.swing.options.some((o) => o.id === v)) return null;
      const p = swingParams(kind, r, v);
      if (!p) return null;
      Object.assign(out, p);
    } else if (k === 'fanLevel') {
      if (kind !== 'ac' || !AC_FAN_NUM[v]) return null;
      out.windlevel = AC_FAN_NUM[v];
    } else if (SWITCHES.includes(k)) {
      if (typeof v !== 'boolean' || !caps.switches.some((s) => s.id === k)) return null;
      if (k === 'childLock') out.childlockon = v;
      else if (k === 'sound') out.muteon = !v;
      else out.winopenon = v;
    } else {
      return null;
    }
  }
  return Object.keys(out).length ? out : null;
}

module.exports = { kindOf, normalize, capsOf, toParams, toC, heatLevels, AC_C_TO_F };
