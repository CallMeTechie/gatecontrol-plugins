'use strict';

// Plugin settings: the declared ones (plugin.json ui.settings: timezone,
// notify_lang) and the module switches mod_* (gc.settings keys of the
// plugin's own, written only by the page "Funktionen" — one source of truth,
// deliberately not in ui.settings).

const tz = require('./tz');

const MODULES = Object.freeze(['shopping', 'tasks', 'stars', 'dates', 'locate', 'arrival_sos', 'places']);
const MODULE_DEFAULTS = Object.freeze(Object.fromEntries(MODULES.map((m) => [m, true])));
const FALLBACK_TZ = 'Europe/Berlin';

/** The server's time zone: TZ of the plugin process (set by the host), else Intl's, else Europe/Berlin. */
function serverTz() {
  const env = typeof process !== 'undefined' && process.env ? process.env.TZ : null;
  if (env && tz.valid(env)) return env;
  try {
    const z = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (z && tz.valid(z)) return z;
  } catch { /* no Intl zone */ }
  return FALLBACK_TZ;
}

function bool(v, d) { return typeof v === 'boolean' ? v : (v === 'true' ? true : (v === 'false' ? false : d)); }

/** settings (gc.settings.all()) → { tz, tzSetting, lang, modules, problems } */
function fromSettings(s) {
  const v = s || {};
  const problems = [];
  const raw = typeof v.timezone === 'string' ? v.timezone.trim() : '';
  let zone = serverTz();
  if (raw) {
    if (tz.valid(raw)) zone = raw;
    else problems.push('timezone');
  }
  const modules = {};
  for (const m of MODULES) modules[m] = bool(v['mod_' + m], MODULE_DEFAULTS[m]);
  return { tz: zone, tzSetting: raw, lang: v.notify_lang === 'en' ? 'en' : 'de', modules, problems };
}

async function load(gc) {
  let s = {};
  try { s = await gc.settings.all(); } catch { /* defaults */ }
  return fromSettings(s);
}

/** Store module switches ({ shopping: false, … }; unknown keys → 'invalid'). */
async function saveModules(gc, patch) {
  for (const [k, v] of Object.entries(patch)) await gc.settings.set('mod_' + k, v);
}

module.exports = { MODULES, MODULE_DEFAULTS, serverTz, fromSettings, load, saveModules };
