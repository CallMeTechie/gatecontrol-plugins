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

/** Remember the language (pushes) and that the person was here. */
async function touch(gc, user, lang, now) {
  await store.run(gc, `INSERT INTO people (user_id, lang, seen_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET lang = excluded.lang, seen_at = excluded.seen_at`, [user.id, lang === 'en' ? 'en' : 'de', now]);
}

async function markKiosk(gc, userId, now = Date.now()) {
  await store.run(gc, `INSERT INTO people (user_id, kiosk, seen_at) VALUES (?, 1, ?)
    ON CONFLICT(user_id) DO UPDATE SET kiosk = 1`, [userId, now]);
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

module.exports = { users, touch, markKiosk, kioskIds, langOf, push };
