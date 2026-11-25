'use strict';

// Person ↔ Jellyfin user per Jellyfin source. Automatic by name (the whole name or only the first name, case and
// accents ignored, only when exactly one Jellyfin user fits), changeable by hand, "In Jellyfin anlegen" for people
// without a user. Jellyfin administrators are never offered: a device with an admin account could change Jellyfin.

const store = require('./store');
const jf = require('./jellyfin');
const sources = require('./sources');
const { fail, str, posInt } = require('./util');

const fold = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').toLowerCase().trim();

/** Jellyfin users that may be linked (no administrators, no disabled ones). */
async function candidates(gc, src) {
  const key = await sources.apiKey(gc, src);
  if (!key) throw fail('not_configured');
  return (await jf.users(gc, src.config.targetIndex || 0, key)).filter((u) => !u.admin && !u.disabled);
}

async function of(gc, sourceId, userId) {
  return store.one(gc, 'SELECT * FROM mappings WHERE source_id = ? AND user_id = ?', [sourceId, userId]);
}
async function all(gc, sourceId) {
  return store.all(gc, 'SELECT * FROM mappings WHERE source_id = ?', [sourceId]);
}

/** The Jellyfin user that fits a person by name, or null (none or more than one). */
function match(person, users) {
  const full = fold(person.name);
  const first = full.split(/\s+/)[0];
  const byFull = users.filter((u) => fold(u.name) === full);
  if (byFull.length === 1) return byFull[0];
  const byFirst = users.filter((u) => fold(u.name) === first);
  return byFirst.length === 1 ? byFirst[0] : null;
}

/**
 * Link people without a mapping (never changes a mapping that exists, also not "bewusst ohne").
 * people = the persons to look at → [{ userId, jfUserId, jfUserName }] the new links.
 */
async function auto(gc, src, people, now = Date.now()) {
  const users = await candidates(gc, src);
  const taken = new Set((await all(gc, src.id)).filter((m) => m.jf_user_id).map((m) => m.jf_user_id));
  const out = [];
  for (const p of people) {
    if (await of(gc, src.id, p.id)) continue;
    const u = match(p, users.filter((x) => !taken.has(x.id)));
    if (!u) continue;
    await store.run(gc, "INSERT INTO mappings (source_id, user_id, jf_user_id, jf_user_name, how, updated_at) VALUES (?, ?, ?, ?, 'auto', ?)", [src.id, p.id, u.id, u.name, now]);
    taken.add(u.id);
    out.push({ userId: p.id, jfUserId: u.id, jfUserName: u.name });
  }
  return out;
}

/** By hand: jfUserId (a non-admin user of that server), null = "bewusst ohne", undefined via clear() = back to automatic. */
async function set(gc, src, userId, jfUserId, now = Date.now()) {
  const uid = posInt(userId);
  if (!uid || !(await gc.users.get(uid))) throw fail('not_found');
  if (jfUserId === null) {
    await store.run(gc, `INSERT INTO mappings (source_id, user_id, jf_user_id, jf_user_name, how, updated_at) VALUES (?, ?, NULL, NULL, 'none', ?)
      ON CONFLICT(source_id, user_id) DO UPDATE SET jf_user_id = NULL, jf_user_name = NULL, how = 'none', updated_at = excluded.updated_at`, [src.id, uid, now]);
    return { userId: uid, jfUserId: null, how: 'none' };
  }
  const id = str(jfUserId, 64);
  const u = (await candidates(gc, src)).find((x) => x.id === id);
  if (!u) throw fail('invalid', { field: 'jfUserId' });
  await store.run(gc, `INSERT INTO mappings (source_id, user_id, jf_user_id, jf_user_name, how, updated_at) VALUES (?, ?, ?, ?, 'manual', ?)
    ON CONFLICT(source_id, user_id) DO UPDATE SET jf_user_id = excluded.jf_user_id, jf_user_name = excluded.jf_user_name, how = 'manual', updated_at = excluded.updated_at`, [src.id, uid, u.id, u.name, now]);
  return { userId: uid, jfUserId: u.id, jfUserName: u.name, how: 'manual' };
}

async function clear(gc, src, userId) {
  await store.run(gc, 'DELETE FROM mappings WHERE source_id = ? AND user_id = ?', [src.id, posInt(userId)]);
}

/** A login name from a person's name: the first name, lower case, a–z 0–9 . _ - only ("paul"). */
function suggestName(person) {
  const n = fold(person.name).split(/\s+/)[0].replace(/[^a-z0-9._-]/g, '');
  return n.slice(0, 40) || 'gc-' + person.id;
}

/** "In Jellyfin anlegen": a normal user with a random password nobody knows, linked to the person. */
async function createFor(gc, src, userId, name, now = Date.now()) {
  const uid = posInt(userId);
  const person = uid ? await gc.users.get(uid) : null;
  if (!person) throw fail('not_found');
  const login = str(name, 40) || suggestName(person);
  if (!/^[A-Za-z0-9._@ -]{1,40}$/.test(login)) throw fail('invalid', { field: 'name' });
  const key = await sources.apiKey(gc, src);
  if (!key) throw fail('not_configured');
  const u = await jf.createUser(gc, src.config.targetIndex || 0, key, login);
  await store.run(gc, `INSERT INTO mappings (source_id, user_id, jf_user_id, jf_user_name, how, updated_at) VALUES (?, ?, ?, ?, 'created', ?)
    ON CONFLICT(source_id, user_id) DO UPDATE SET jf_user_id = excluded.jf_user_id, jf_user_name = excluded.jf_user_name, how = 'created', updated_at = excluded.updated_at`, [src.id, uid, u.id, u.name, now]);
  return { userId: uid, jfUserId: u.id, jfUserName: u.name, how: 'created' };
}

module.exports = { candidates, of, all, match, auto, set, clear, createFor, suggestName, fold };
