'use strict';

// The administrator's settings (plugin.json ui.settings, Einstellungen › Plugins › Notizen & Aufgaben).

const tz = require('./tz');

const SOURCES = ['gatecontrol-familie', 'gatecontrol-mail', 'gatecontrol-drive', 'gatecontrol-schule', 'gatecontrol-alltag'];
const DEFAULTS = {
  timezone: 'Europe/Berlin', notify_lang: 'de', sharing: 'all', vaults: true,
  source_familie: true, source_mail: true, source_drive: true, source_schule: true, source_alltag: true,
  import_mstodo: true, mstodo_sync: true, import_dsnote: true, attach_mb: 25, quota_mb: 2048, calendar_tasks: true,
};

let cache = null;

async function get(gc) {
  if (cache) return cache;
  let raw = {};
  try { raw = (await gc.settings.all()) || {}; } catch { raw = {}; }
  const c = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (raw[k] !== undefined && raw[k] !== null && typeof raw[k] === typeof DEFAULTS[k]) c[k] = raw[k];
  if (!tz.valid(c.timezone)) c.timezone = 'Europe/Berlin';
  if (!['all', 'groups', 'off'].includes(c.sharing)) c.sharing = 'all';
  c.attach_mb = Math.min(100, Math.max(1, Math.round(c.attach_mb) || 25));
  c.quota_mb = Math.max(0, Math.round(c.quota_mb) || 0);
  cache = c;
  return c;
}

/** Is a source switched on by the administrator? */
const sourceOn = (c, plugin) => c['source_' + plugin.replace(/^gatecontrol-/, '')] !== false;

function reset() { cache = null; }

module.exports = { get, reset, sourceOn, SOURCES, DEFAULTS };
