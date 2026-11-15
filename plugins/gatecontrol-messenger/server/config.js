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
// 1.5.0: home actions — how long a request stays open, who approves by default, the longest grant
const REQUEST_TTL_MIN = [5, 10, 15, 30, 60, 120, 240, 1440];
const APPROVERS = ['auto', 'parents', 'rights'];          // auto: parents when Familie offers family_roles, else rights
const GRANT_MAX_DAYS = [1, 2, 3, 7, 14, 30];
// 1.16.0: a new chat by number — at most this many numbers checked per person and hour (admin: card „Brücken“)
const NEW_CHAT_PER_HOUR = { min: 1, max: 60 };
// 1.17.0: older messages of the bridges are filed in this window (local time of GateControl's update window), in small portions
const HHMM_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

const DEFAULTS = Object.freeze({
  retentionDays: 0,
  allowDisappearing: true,
  editWindowMin: 15,
  maxVoiceS: 300,
  allowStories: true,     // 1.4.0: stories (24 h) — the status line itself is always there
  allowActions: true,     // 1.4.0: home actions in chats (action messages, plugin card buttons)
  requestTtlMin: 15,      // 1.5.0: a request („Tür-Anfrage“) is open this long
  requestApproversDefault: 'auto', // 1.5.0: who may approve when the request names nobody
  childrenMayRequest: true,        // 1.5.0: Familie's children may send requests
  grantMaxDays: 7,        // 1.5.0: the longest „Gerät teilen“
  newChatPerHour: 10,     // 1.16.0: numbers checked per person and hour (GateControl itself allows 20)
  historyFrom: '01:00',   // 1.17.0: older messages of the bridges are filed from … (the server's disk is slow)
  historyTo: '05:00',     //         … to (end before start: over midnight)
  defaults: Object.freeze({ readReceipts: true, typing: true, preview: true }),
});

let cache = null;

const perHour = (v) => Number.isSafeInteger(v) && v >= NEW_CHAT_PER_HOUR.min && v <= NEW_CHAT_PER_HOUR.max;

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
    requestTtlMin: REQUEST_TTL_MIN.includes(raw.requestTtlMin) ? raw.requestTtlMin : DEFAULTS.requestTtlMin,
    requestApproversDefault: APPROVERS.includes(raw.requestApproversDefault) ? raw.requestApproversDefault : DEFAULTS.requestApproversDefault,
    childrenMayRequest: typeof raw.childrenMayRequest === 'boolean' ? raw.childrenMayRequest : DEFAULTS.childrenMayRequest,
    grantMaxDays: GRANT_MAX_DAYS.includes(raw.grantMaxDays) ? raw.grantMaxDays : DEFAULTS.grantMaxDays,
    newChatPerHour: perHour(raw.newChatPerHour) ? raw.newChatPerHour : DEFAULTS.newChatPerHour,
    historyFrom: HHMM_RE.test(String(raw.historyFrom || '')) ? raw.historyFrom : DEFAULTS.historyFrom,
    historyTo: HHMM_RE.test(String(raw.historyTo || '')) ? raw.historyTo : DEFAULTS.historyTo,
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
  if (b.requestTtlMin !== undefined) { if (!REQUEST_TTL_MIN.includes(b.requestTtlMin)) throw fail('invalid'); next.requestTtlMin = b.requestTtlMin; }
  if (b.requestApproversDefault !== undefined) { if (!APPROVERS.includes(b.requestApproversDefault)) throw fail('invalid'); next.requestApproversDefault = b.requestApproversDefault; }
  if (b.childrenMayRequest !== undefined) next.childrenMayRequest = bool(b.childrenMayRequest);
  if (b.grantMaxDays !== undefined) { if (!GRANT_MAX_DAYS.includes(b.grantMaxDays)) throw fail('invalid'); next.grantMaxDays = b.grantMaxDays; }
  if (b.newChatPerHour !== undefined) { if (!perHour(b.newChatPerHour)) throw fail('invalid'); next.newChatPerHour = b.newChatPerHour; }
  for (const k of ['historyFrom', 'historyTo']) if (b[k] !== undefined) { if (!HHMM_RE.test(String(b[k]))) throw fail('invalid'); next[k] = b[k]; }
  if (b.defaults !== undefined) {
    if (!b.defaults || typeof b.defaults !== 'object' || Array.isArray(b.defaults)) throw fail('invalid');
    for (const k of ['readReceipts', 'typing', 'preview']) if (b.defaults[k] !== undefined) next.defaults[k] = bool(b.defaults[k]);
  }
  await store.tx(gc, async () => {
    for (const k of ['retentionDays', 'allowDisappearing', 'editWindowMin', 'maxVoiceS', 'allowStories', 'allowActions', 'requestTtlMin', 'requestApproversDefault', 'childrenMayRequest', 'grantMaxDays', 'newChatPerHour', 'historyFrom', 'historyTo', 'defaults']) {
      await store.run(gc, 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [k, JSON.stringify(next[k])]);
    }
  });
  cache = null;
  return load(gc);
}

function reset() { cache = null; }

module.exports = { load, update, reset, HHMM_RE, DEFAULTS, RETENTION_DAYS, EDIT_WINDOW_MIN, VOICE_MAX_S, DISAPPEARING_S, REQUEST_TTL_MIN, APPROVERS, GRANT_MAX_DAYS, NEW_CHAT_PER_HOUR };
