'use strict';

// The administrator's settings (admin page "Übersicht"), kept in the plugin's
// own table `settings` (key → JSON). The media limits (quota, file size,
// types) are GateControl's and only shown: gc.media.usage().

const store = require('./store');
const { fail, bool } = require('./util');

const RETENTION_DAYS = [0, 30, 90, 180, 365, 730];       // 0 = unlimited
const EDIT_WINDOW_MIN = [0, 5, 15, 60, 1440];            // 0 = no editing / deleting for everyone
const VOICE_MAX_S = [60, 120, 300, 600, 900];
const DISAPPEARING_S = [0, 86400, 604800, 2592000];      // off, 1 day, 1 week, 1 month

const DEFAULTS = Object.freeze({
  retentionDays: 0,
  allowDisappearing: true,
  editWindowMin: 15,
  maxVoiceS: 300,
  allowStories: true,     // 1.4.0: stories (24 h) — the status line itself is always there
  allowActions: true,     // 1.4.0: home actions in chats (action messages, plugin card buttons)
  defaults: Object.freeze({ readReceipts: true, typing: true, preview: true }),
});

let cache = null;

async function load(gc) {
  if (cache) return cache;
  const rows = await store.all(gc, 'SELECT key, value FROM settings');
  const raw = {};
  for (const r of rows) { try { raw[r.key] = JSON.parse(r.value); } catch { /* ignore a broken row */ } }
  const d = raw.defaults && typeof raw.defaults === 'object' ? raw.defaults : {};
  cache = {
    retentionDays: RETENTION_DAYS.includes(raw.retentionDays) ? raw.retentionDays : DEFAULTS.retentionDays,
    allowDisappearing: typeof raw.allowDisappearing === 'boolean' ? raw.allowDisappearing : DEFAULTS.allowDisappearing,
    editWindowMin: EDIT_WINDOW_MIN.includes(raw.editWindowMin) ? raw.editWindowMin : DEFAULTS.editWindowMin,
    maxVoiceS: VOICE_MAX_S.includes(raw.maxVoiceS) ? raw.maxVoiceS : DEFAULTS.maxVoiceS,
    allowStories: typeof raw.allowStories === 'boolean' ? raw.allowStories : DEFAULTS.allowStories,
    allowActions: typeof raw.allowActions === 'boolean' ? raw.allowActions : DEFAULTS.allowActions,
    defaults: {
      readReceipts: typeof d.readReceipts === 'boolean' ? d.readReceipts : true,
      typing: typeof d.typing === 'boolean' ? d.typing : true,
      preview: typeof d.preview === 'boolean' ? d.preview : true,
    },
  };
  return cache;
}

/** Partial update from the admin page → the new settings. */
async function update(gc, body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b) throw fail('invalid');
  const cur = await load(gc);
  const next = JSON.parse(JSON.stringify(cur));
  if (b.retentionDays !== undefined) { if (!RETENTION_DAYS.includes(b.retentionDays)) throw fail('invalid'); next.retentionDays = b.retentionDays; }
  if (b.allowDisappearing !== undefined) next.allowDisappearing = bool(b.allowDisappearing);
  if (b.allowStories !== undefined) next.allowStories = bool(b.allowStories);
  if (b.allowActions !== undefined) next.allowActions = bool(b.allowActions);
  if (b.editWindowMin !== undefined) { if (!EDIT_WINDOW_MIN.includes(b.editWindowMin)) throw fail('invalid'); next.editWindowMin = b.editWindowMin; }
  if (b.maxVoiceS !== undefined) { if (!VOICE_MAX_S.includes(b.maxVoiceS)) throw fail('invalid'); next.maxVoiceS = b.maxVoiceS; }
  if (b.defaults !== undefined) {
    if (!b.defaults || typeof b.defaults !== 'object' || Array.isArray(b.defaults)) throw fail('invalid');
    for (const k of ['readReceipts', 'typing', 'preview']) if (b.defaults[k] !== undefined) next.defaults[k] = bool(b.defaults[k]);
  }
  await store.tx(gc, async () => {
    for (const k of ['retentionDays', 'allowDisappearing', 'editWindowMin', 'maxVoiceS', 'allowStories', 'allowActions', 'defaults']) {
      await store.run(gc, 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [k, JSON.stringify(next[k])]);
    }
  });
  cache = null;
  return load(gc);
}

function reset() { cache = null; }

module.exports = { load, update, reset, DEFAULTS, RETENTION_DAYS, EDIT_WINDOW_MIN, VOICE_MAX_S, DISAPPEARING_S };
