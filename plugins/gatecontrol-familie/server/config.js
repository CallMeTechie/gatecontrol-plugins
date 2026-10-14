'use strict';

// Plugin settings: the declared ones (plugin.json ui.settings: timezone,
// notify_lang), the module switches mod_* and the wall tablet's shopping list
// wall_list (gc.settings keys of the plugin's own, written only by the page
// "Funktionen" — one source of truth, deliberately not in ui.settings).
//
// The module "wall" (Wand-Tablet, default off) is no family feature of its
// own: it only switches the wall view for members with the role 'wall'.

const tz = require('./tz');

const MODULES = Object.freeze(['shopping', 'tasks', 'stars', 'dates', 'locate', 'arrival_sos', 'places', 'rides', 'emergency', 'wall']);
const MODULE_DEFAULTS = Object.freeze(Object.fromEntries(MODULES.map((m) => [m, m !== 'wall'])));
/** The modules people use in the app / portal (the wall view is not one of them). */
const FAMILY_MODULES = Object.freeze(MODULES.filter((m) => m !== 'wall'));
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

/** settings (gc.settings.all()) → { tz, tzSetting, lang, modules, wallList, problems } */
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
  const wallList = typeof v.wall_list === 'string' && v.wall_list.length <= 64 ? v.wall_list : '';
  return { tz: zone, tzSetting: raw, lang: v.notify_lang === 'en' ? 'en' : 'de', modules, wallList, problems };
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

/** The shopping list shown on the wall tablet ('' = the first list). */
async function saveWallList(gc, listId) {
  await gc.settings.set('wall_list', listId || '');
}

module.exports = { MODULES, MODULE_DEFAULTS, FAMILY_MODULES, serverTz, fromSettings, load, saveModules, saveWallList };
