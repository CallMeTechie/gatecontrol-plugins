'use strict';

// Plugin settings: the declared ones (plugin.json ui.settings: timezone,
// notify_lang), the module switches mod_* and the wall tablet's shopping list
// wall_list (gc.settings keys of the plugin's own, written only by the page
// "Funktionen" — one source of truth, deliberately not in ui.settings).
//
// The module "wall" (Wand-Tablet, default off) is no family feature of its
// own: it only switches the wall view for members with the role 'wall'.
//
// 1.2.0 adds allowance (default off), wishes (on), expenses (off), board (on),
// meals (off) and presence (off), and the declared settings lat / lon (the
// home's location, only for the presence condition "after sunset").
//
// 1.6.0: messenger_group (default on) — the group „Familie“ in the Messenger
// plugin (server/messenger.js), switched on the page „Funktionen“.
//
// 1.9.0: the module rules („Regeln und Erinnerungen“, default on — rules are no
// longer bound to the module presence; presence triggers still need it) and the
// declared settings children_own_rules (children may make their own reminders,
// default off), shopping_notify (how „<Name> bitten“ asks by default: direct |
// family | push, default direct) and shopping_chat („Ich gehe einkaufen“ as a card
// in the family chat: family | off, default family).
//
// 1.13.0: the declared setting school_early_end_notify (default on) — an early end of school
// (Schule plugin) without a pickup in the rides tells the parents (server/schoolend.js).

const tz = require('./tz');

const MODULES = Object.freeze(['shopping', 'tasks', 'stars', 'dates', 'locate', 'arrival_sos', 'places', 'rides', 'emergency', 'wall',
  'allowance', 'wishes', 'expenses', 'board', 'meals', 'presence', 'rules']);
const OFF_BY_DEFAULT = ['wall', 'allowance', 'expenses', 'meals', 'presence'];
const MODULE_DEFAULTS = Object.freeze(Object.fromEntries(MODULES.map((m) => [m, !OFF_BY_DEFAULT.includes(m)])));
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

/** A coordinate setting (number or numeric text) within ±max, else null. */
function coord(v, max) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v.trim().replace(',', '.')) : NaN);
  return Number.isFinite(n) && Math.abs(n) <= max ? n : null;
}

const SHOPPING_NOTIFY = Object.freeze(['direct', 'family', 'push']);
const SHOPPING_CHAT = Object.freeze(['family', 'off']);

/**
 * settings (gc.settings.all()) → { tz, tzSetting, lang, modules, wallList, location, messengerGroup,
 * childrenOwnRules, shoppingNotify, shoppingChat, schoolEarlyEndNotify, problems }
 */
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
  // the home's location (presence: "after sunset"); both or nothing, 0/0 counts as not set
  const lat = coord(v.lat, 90);
  const lon = coord(v.lon, 180);
  const location = lat != null && lon != null && !(lat === 0 && lon === 0) ? { lat, lon } : null;
  const messengerGroup = bool(v.messenger_group, true);
  const childrenOwnRules = bool(v.children_own_rules, false);
  const shoppingNotify = SHOPPING_NOTIFY.includes(v.shopping_notify) ? v.shopping_notify : 'direct';
  const shoppingChat = SHOPPING_CHAT.includes(v.shopping_chat) ? v.shopping_chat : 'family';
  const schoolEarlyEndNotify = bool(v.school_early_end_notify, true);
  return {
    tz: zone, tzSetting: raw, lang: v.notify_lang === 'en' ? 'en' : 'de', modules, wallList, location, messengerGroup,
    childrenOwnRules, shoppingNotify, shoppingChat, schoolEarlyEndNotify, problems,
  };
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

module.exports = { MODULES, MODULE_DEFAULTS, FAMILY_MODULES, SHOPPING_NOTIFY, SHOPPING_CHAT, serverTz, fromSettings, load, saveModules, saveWallList };
