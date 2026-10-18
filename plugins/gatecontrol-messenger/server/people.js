'use strict';

// The people of the messenger: every enabled GateControl account (gc.users),
// without accounts seen on a kiosk device (a wall tablet is no person to chat
// with). Each person's preferences (read receipts, "typing …", preview in
// pushes) start from the administrator's defaults for new accounts.

const store = require('./store');
const config = require('./config');
const { fail, bool, parseJson } = require('./util');

// 1.4.0: privacy, notifications and chat preferences (prefs.ext, JSON — no content)
const AUDIENCE = ['all', 'family', 'nobody'];
const STATUS_AUDIENCE = ['all', 'family', 'custom'];
const PLACE_AUDIENCE = ['nobody', 'family', 'all'];
const REMINDER_MIN = [0, 15, 60, 120, 1440];
const EXT_DEFAULTS = Object.freeze({
  privacy: Object.freeze({ lastSeen: 'all', avatar: 'all', statusDefault: 'all', placeInStatus: 'family', groupAdd: 'all', defaultDisappearingS: 0 }),
  notify: Object.freeze({ groupsMentionsOnly: false, reactions: true, statusDigest: false, eventReminderMin: 60 }),
  chats: Object.freeze({ keepArchived: true }),
});
const DISAPPEARING = [0, 86400, 604800, 2592000];

/** prefs.ext → { privacy, notify, chats } with the defaults for what is missing or broken. */
function extOf(r) {
  const raw = parseJson(r && r.ext, {});
  const pick = (sec, k, ok) => {
    const v = raw && raw[sec] && typeof raw[sec] === 'object' ? raw[sec][k] : undefined;
    return ok(v) ? v : EXT_DEFAULTS[sec][k];
  };
  const isB = (v) => typeof v === 'boolean';
  return {
    privacy: {
      lastSeen: pick('privacy', 'lastSeen', (v) => AUDIENCE.includes(v)),
      avatar: pick('privacy', 'avatar', (v) => AUDIENCE.includes(v)),
      statusDefault: pick('privacy', 'statusDefault', (v) => STATUS_AUDIENCE.includes(v)),
      placeInStatus: pick('privacy', 'placeInStatus', (v) => PLACE_AUDIENCE.includes(v)),
      groupAdd: pick('privacy', 'groupAdd', (v) => AUDIENCE.includes(v)),
      defaultDisappearingS: pick('privacy', 'defaultDisappearingS', (v) => DISAPPEARING.includes(v)),
    },
    notify: {
      groupsMentionsOnly: pick('notify', 'groupsMentionsOnly', isB),
      reactions: pick('notify', 'reactions', isB),
      statusDigest: pick('notify', 'statusDigest', isB),
      eventReminderMin: pick('notify', 'eventReminderMin', (v) => REMINDER_MIN.includes(v)),
    },
    chats: { keepArchived: pick('chats', 'keepArchived', isB) },
  };
}

const CACHE_MS = 10000;
let cache = { at: 0, map: null };

/** Map id → { id, name, role, avatarUrl, color, colorHex, initials } of the enabled accounts (cached 10 s). */
async function users(gc, now = Date.now()) {
  if (cache.map && now - cache.at < CACHE_MS && now >= cache.at) return cache.map;
  const list = await gc.users.list();
  const map = new Map();
  for (const u of Array.isArray(list) ? list : []) if (u && Number.isSafeInteger(u.id)) map.set(u.id, u);
  cache = { at: now, map };
  return map;
}

function reset() { cache = { at: 0, map: null }; }

/** The face of a person for the API: { userId, name, avatarUrl, initials, colorHex, color, gone }. */
function face(id, map) {
  const u = map.get(id);
  if (!u) return { userId: id, name: null, avatarUrl: null, initials: null, colorHex: null, color: null, gone: true };
  return { userId: id, name: u.name, avatarUrl: u.avatarUrl || null, initials: u.initials || null, colorHex: u.colorHex || null, color: u.color || null, gone: false };
}

function prefsOut(r) {
  return { readReceipts: !!r.read_receipts, typing: !!r.typing, preview: !!r.preview, ...extOf(r) };
}

/** The prefs row of a person (created from the defaults when missing). */
async function prefsRow(gc, userId, now = Date.now()) {
  let r = await store.one(gc, 'SELECT * FROM prefs WHERE user_id = ?', [userId]);
  if (r) return r;
  const d = (await config.load(gc)).defaults;
  await store.run(gc, 'INSERT OR IGNORE INTO prefs (user_id, read_receipts, typing, preview, updated_at) VALUES (?, ?, ?, ?, ?)', [userId, d.readReceipts ? 1 : 0, d.typing ? 1 : 0, d.preview ? 1 : 0, now]);
  r = await store.one(gc, 'SELECT * FROM prefs WHERE user_id = ?', [userId]);
  return r;
}

/** Prefs of several people → Map id → { readReceipts, typing, preview, lang } (defaults for unknown). */
async function prefsOf(gc, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const d = (await config.load(gc)).defaults;
  for (const id of ids) out.set(id, { readReceipts: d.readReceipts, typing: d.typing, preview: d.preview, ...extOf(null), lang: null, lastSeen: null });
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    const rows = await store.all(gc, `SELECT * FROM prefs WHERE user_id IN (${store.marks(part.length)})`, part);
    for (const r of rows) out.set(r.user_id, { ...prefsOut(r), lang: r.lang || null, lastSeen: r.last_seen || null });
  }
  return out;
}

/** Remember language, last visit and whether the account is used on a kiosk device. */
async function touch(gc, user, lang, now = Date.now()) {
  const r = await prefsRow(gc, user.id, now);
  const l = lang === 'en' ? 'en' : 'de';
  const kiosk = user.kiosk === true ? 1 : r.kiosk;
  // one write per minute at most
  if (r.lang !== l || r.kiosk !== kiosk || !r.last_seen || now - r.last_seen >= 60000) {
    await store.run(gc, 'UPDATE prefs SET lang = ?, kiosk = ?, last_seen = ? WHERE user_id = ?', [l, kiosk, now, user.id]);
  }
}

/** An account used on a kiosk device (wall tablet): hidden from "people" from now on. */
async function markKiosk(gc, userId, now = Date.now()) {
  const r = await prefsRow(gc, userId, now);
  if (!r.kiosk) await store.run(gc, 'UPDATE prefs SET kiosk = 1 WHERE user_id = ?', [userId]);
}

async function updatePrefs(gc, userId, body, now = Date.now()) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b) throw fail('invalid');
  const r = await prefsRow(gc, userId, now);
  const next = prefsOut(r);
  for (const k of ['readReceipts', 'typing', 'preview']) if (b[k] !== undefined) next[k] = bool(b[k]);
  // 1.4.0: partial updates of privacy / notify / chats
  const section = (name, rules) => {
    if (b[name] === undefined) return;
    const v = b[name];
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw fail('invalid');
    for (const [k, val] of Object.entries(v)) {
      if (!rules[k]) throw fail('invalid');
      if (!rules[k](val)) throw fail('invalid');
      next[name][k] = val;
    }
  };
  const isB = (v) => typeof v === 'boolean';
  section('privacy', {
    lastSeen: (v) => AUDIENCE.includes(v), avatar: (v) => AUDIENCE.includes(v), statusDefault: (v) => STATUS_AUDIENCE.includes(v),
    placeInStatus: (v) => PLACE_AUDIENCE.includes(v), groupAdd: (v) => AUDIENCE.includes(v), defaultDisappearingS: (v) => DISAPPEARING.includes(v),
  });
  section('notify', { groupsMentionsOnly: isB, reactions: isB, statusDigest: isB, eventReminderMin: (v) => REMINDER_MIN.includes(v) });
  section('chats', { keepArchived: isB });
  const ext = JSON.stringify({ privacy: next.privacy, notify: next.notify, chats: next.chats });
  await store.run(gc, 'UPDATE prefs SET read_receipts = ?, typing = ?, preview = ?, ext = ?, updated_at = ? WHERE user_id = ?', [next.readReceipts ? 1 : 0, next.typing ? 1 : 0, next.preview ? 1 : 0, ext, now, userId]);
  return next;
}

/** The people one can start a chat with: enabled accounts, not kiosk devices, not oneself. */
async function list(gc, viewerId) {
  const map = await users(gc);
  const kiosk = new Set((await store.all(gc, 'SELECT user_id FROM prefs WHERE kiosk = 1')).map((r) => r.user_id));
  return [...map.values()].filter((u) => u.id !== viewerId && !kiosk.has(u.id))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'de'))
    .map((u) => ({ id: u.id, name: u.name, avatarUrl: u.avatarUrl || null, initials: u.initials || null, colorHex: u.colorHex || null, color: u.color || null }));
}

module.exports = {
  users, reset, face, prefsRow, prefsOf, prefsOut, extOf, touch, markKiosk, updatePrefs, list, EXT_DEFAULTS, AUDIENCE, STATUS_AUDIENCE, PLACE_AUDIENCE, REMINDER_MIN,
};
