'use strict';

// Who is who: the accounts of GateControl (gc.users), the people table (language for pushes, accounts seen as a
// kiosk device — a wall tablet is no person and never gets a vault), and the pushes this plugin sends.

const store = require('./store');
const { t } = require('./text');

/** Enabled GateControl accounts → Map id → { id, name, role }. */
async function users(gc) {
  let list = [];
  try { list = await gc.users.list(); } catch { list = []; }
  const out = new Map();
  for (const u of Array.isArray(list) ? list : []) {
    if (u && Number.isSafeInteger(u.id)) out.set(u.id, { id: u.id, name: u.name || `#${u.id}`, role: u.role });
  }
  return out;
}

// "seen" timestamps are written at most once per TOUCH_EVERY_MS and person (and when the language changes): every request
// wrote one row (before 1.4.3) — on a slow disk ~300 ms each
const TOUCH_EVERY_MS = 10 * 60000;
const touchedBy = new WeakMap(); // gc → { people: Map(user id → { lang, at }), kiosk: Set(user id) }
function touchedOf(gc) {
  let t = touchedBy.get(gc);
  if (!t) { t = { people: new Map(), kiosk: new Set(), accounts: new Map() }; touchedBy.set(gc, t); }
  return t;
}

/** Remember the language (pushes) and that the person was here. */
async function touch(gc, user, lang, now) {
  const l = lang === 'en' ? 'en' : 'de';
  const seen = touchedOf(gc).people;
  const prev = seen.get(user.id);
  if (prev && prev.lang === l && now - prev.at < TOUCH_EVERY_MS && now >= prev.at) return;
  if (seen.size >= 5000) seen.clear();
  seen.set(user.id, { lang: l, at: now });
  await store.run(gc, `INSERT INTO people (user_id, lang, seen_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET lang = excluded.lang, seen_at = excluded.seen_at`, [user.id, lang === 'en' ? 'en' : 'de', now]);
}

async function markKiosk(gc, userId, now = Date.now()) {
  const kiosk = touchedOf(gc).kiosk;
  if (kiosk.has(userId)) return; // marked already
  await store.run(gc, `INSERT INTO people (user_id, kiosk, seen_at) VALUES (?, 1, ?)
    ON CONFLICT(user_id) DO UPDATE SET kiosk = 1`, [userId, now]);
  kiosk.add(userId);
}

/** "zuletzt gesehen" of a vault account (the sync of an app): at most once per TOUCH_EVERY_MS. */
async function seenAccount(gc, userId, now) {
  const seen = touchedOf(gc).accounts;
  const prev = seen.get(userId);
  if (prev != null && now - prev < TOUCH_EVERY_MS && now >= prev) return;
  if (seen.size >= 5000) seen.clear();
  seen.set(userId, now);
  await store.run(gc, 'UPDATE accounts SET seen_at = ? WHERE user_id = ?', [now, userId]);
}

async function kioskIds(gc) {
  return new Set((await store.all(gc, 'SELECT user_id FROM people WHERE kiosk = 1')).map((r) => r.user_id));
}

async function langOf(gc, userId) {
  const r = await store.one(gc, 'SELECT lang FROM people WHERE user_id = ?', [userId]);
  return r && r.lang === 'en' ? 'en' : 'de';
}

/**
 * A push to one person in their language: topic 'share' or 'emergency'. Never throws (a failed push changes
 * nothing that happened). Pushes carry no secret — at most a person's name; vault names are encrypted.
 */
async function push(gc, userId, topic, key, params, data) {
  try {
    const lang = await langOf(gc, userId);
    await gc.notify({
      topic,
      title: t(lang, `push.${key}.title`, params),
      body: t(lang, `push.${key}.body`, params),
      users: [userId],
      collapseKey: `vault-${topic}:${(data && (data.vault || data.emergency)) || userId}`,
      data: { vault: { topic, event: key, ...(data || {}) } },
    });
  } catch (e) {
    gc.log.warn('push failed', topic, (e && e.code) || 'error');
  }
}

module.exports = { users, touch, markKiosk, seenAccount, kioskIds, langOf, push, TOUCH_EVERY_MS };
