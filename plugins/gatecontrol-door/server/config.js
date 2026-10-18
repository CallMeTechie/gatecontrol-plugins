'use strict';

// The plugin's own settings (admin page "Einstellungen"), stored as one JSON
// value under the plugin key 'door.config' (gc.settings.set keeps undeclared
// keys of the plugin's own). Secrets are separate (gc.settings.setSecret).

const tz = require('./tz');
const { fail, bool, intIn } = require('./util');

const KEY = 'door.config';
const DEFAULTS = Object.freeze({
  timezone: '',          // IANA zone for time windows and the night check; '' = the server's zone
  notifyLang: 'de',      // language of the push texts
  mediaDays: 7,          // pictures are kept 1–30 days
  ring: true,            // Ring polling on/off (the connection stays)
  motionGapMin: 5,       // at most one motion push per camera in this many minutes (1–60)
  nukiLogImport: true,   // import keypad / manual operations from the Nuki Web log
  familyChat: true,      // 1.3.0: a ring as a card in the Messenger's family chat (server/chat.js; only when the messenger is there)
});
const HISTORY_DAYS = 90;

function normalise(v) {
  const c = { ...DEFAULTS };
  if (v && typeof v === 'object') {
    if (typeof v.timezone === 'string' && tz.valid(v.timezone)) c.timezone = v.timezone;
    if (v.notifyLang === 'en' || v.notifyLang === 'de') c.notifyLang = v.notifyLang;
    if (Number.isInteger(v.mediaDays) && v.mediaDays >= 1 && v.mediaDays <= 30) c.mediaDays = v.mediaDays;
    if (typeof v.ring === 'boolean') c.ring = v.ring;
    if (Number.isInteger(v.motionGapMin) && v.motionGapMin >= 1 && v.motionGapMin <= 60) c.motionGapMin = v.motionGapMin;
    if (typeof v.nukiLogImport === 'boolean') c.nukiLogImport = v.nukiLogImport;
    if (typeof v.familyChat === 'boolean') c.familyChat = v.familyChat;
  }
  return c;
}

async function load(gc) {
  let v = null;
  try { v = await gc.settings.get(KEY); } catch { v = null; }
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
  return normalise(v);
}

/** Validate a change from the admin page (only the given keys) and store it. */
async function update(gc, body) {
  const cur = await load(gc);
  const b = body && typeof body === 'object' ? body : {};
  const next = { ...cur };
  if (b.timezone !== undefined) {
    if (typeof b.timezone !== 'string' || !tz.valid(b.timezone.trim())) throw fail('invalid', { field: 'timezone' });
    next.timezone = b.timezone.trim();
  }
  if (b.notifyLang !== undefined) {
    if (b.notifyLang !== 'de' && b.notifyLang !== 'en') throw fail('invalid', { field: 'notifyLang' });
    next.notifyLang = b.notifyLang;
  }
  if (b.mediaDays !== undefined) next.mediaDays = intIn(b.mediaDays, 1, 30);
  if (b.motionGapMin !== undefined) next.motionGapMin = intIn(b.motionGapMin, 1, 60);
  if (b.ring !== undefined) next.ring = bool(b.ring);
  if (b.nukiLogImport !== undefined) next.nukiLogImport = bool(b.nukiLogImport);
  if (b.familyChat !== undefined) next.familyChat = bool(b.familyChat);
  await gc.settings.set(KEY, next);
  return next;
}

module.exports = { KEY, DEFAULTS, HISTORY_DAYS, load, update, normalise };
