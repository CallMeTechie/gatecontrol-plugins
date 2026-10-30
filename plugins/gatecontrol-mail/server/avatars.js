'use strict';

// The picture of an account at its provider, for the account lists of the apps and the portal (like the Outlook app:
// picture or the provider's mark, the address below). Microsoft: Graph's /me/photos/96x96 (else /me/photo) into the
// plugin's media — on a new sign-in and at most once a day (Graph's mediaEtag unchanged: nothing is loaded again), after a
// failure again within the hour; 404 = none (many Microsoft 365 accounts). IMAP providers have none.
// The API: Account.avatar { mediaId, mime } | null — the apps load media/<mediaId> (mediaAccess), the portal asks
// GET accounts/<id>/avatar for a signed url.

const store = require('./store');
const providers = require('./providers');
const graph = require('./graph');
const { fail } = require('./util');

const DAY = 86400000;
const RETRY = 3600000;
const MAX_BYTES = 2 * 1024 * 1024;
const PER_TICK = 3;

const running = new Map(); // account id → the look that runs

/** A row → the API's avatar. */
const view = (a) => (a && a.avatar_media ? { mediaId: a.avatar_media, mime: a.avatar_mime || 'image/jpeg' } : null);

/** Is the account's picture due for a look? */
const due = (a, now) => providers.isMicrosoft(a.provider) && (!a.avatar_at || now - a.avatar_at >= DAY);

async function set(gc, a, mediaId, mime, etag, at) {
  const old = a.avatar_media;
  await store.run(gc, 'UPDATE accounts SET avatar_media = ?, avatar_mime = ?, avatar_etag = ?, avatar_at = ? WHERE id = ?', [mediaId, mime, etag, at, a.id]);
  if (old && old !== mediaId) { try { await gc.media.delete(old); } catch { /* gone */ } }
}

/**
 * Look at the picture of account `a` (Microsoft) → true when it changed (a new one, or gone). A look of it that runs is
 * joined. Never throws: a failure keeps what is there.
 */
function refresh(gc, a, now = Date.now()) {
  if (!providers.isMicrosoft(a.provider)) return Promise.resolve(false);
  let p = running.get(a.id);
  if (!p) {
    p = look(gc, a.id, now).catch(() => false).finally(() => running.delete(a.id));
    running.set(a.id, p);
  }
  return p;
}

async function look(gc, id, now) {
  const a = await store.one(gc, 'SELECT * FROM accounts WHERE id = ?', [id]);
  if (!a) return false;
  let meta;
  try {
    meta = await graph.photo(gc, a);
  } catch (e) {
    await store.run(gc, 'UPDATE accounts SET avatar_at = ? WHERE id = ?', [now - DAY + RETRY, a.id]);
    throw e;
  }
  if (!meta || !/^image\//.test(meta.mime)) {
    await set(gc, a, null, null, null, now);
    return !!a.avatar_media;
  }
  if (a.avatar_media && meta.etag && meta.etag === a.avatar_etag && await gc.media.info(a.avatar_media).catch(() => null)) {
    await store.run(gc, 'UPDATE accounts SET avatar_at = ? WHERE id = ?', [now, a.id]);
    return false;
  }
  let got;
  try {
    got = await graph.mediaFetch(gc, a, meta.path, { name: 'avatar', mime: meta.mime, maxBytes: MAX_BYTES, timeoutMs: 30000 });
  } catch (e) {
    if (e && e.code === 'not_found') { await set(gc, a, null, null, null, now); return !!a.avatar_media; }
    await store.run(gc, 'UPDATE accounts SET avatar_at = ? WHERE id = ?', [now - DAY + RETRY, a.id]);
    throw e;
  }
  // gone meanwhile (removed while the picture came): the file goes again
  if (!(await store.one(gc, 'SELECT 1 AS x FROM accounts WHERE id = ?', [a.id]))) { try { await gc.media.delete(got.mediaId); } catch { /* gone */ } return false; }
  await gc.media.claim(got.mediaId);
  await set(gc, a, got.mediaId, got.mime && /^image\//.test(got.mime) ? got.mime : meta.mime, meta.etag, now);
  return true;
}

/** The background run: the pictures that are due (PER_TICK at most) → the accounts whose picture changed. */
async function tick(gc, now, skipUsers = new Set()) {
  const rows = await store.all(gc, "SELECT * FROM accounts WHERE state <> 'auth_failed' AND (avatar_at IS NULL OR avatar_at <= ?) ORDER BY COALESCE(avatar_at, 0) LIMIT 50", [now - DAY]);
  const out = [];
  for (const a of rows.filter((x) => due(x, now) && !skipUsers.has(x.user_id)).slice(0, PER_TICK)) {
    if (await refresh(gc, a, now)) out.push(a);
  }
  return out;
}

/** GET accounts/<id>/avatar → { mediaId, mime, size, url } (url: a signed address for the portal's frame). */
async function get(gc, userId, id) {
  const a = Number.isSafeInteger(id) ? await store.one(gc, 'SELECT * FROM accounts WHERE id = ? AND user_id = ?', [id, userId]) : null;
  if (!a || !a.avatar_media) throw fail('not_found');
  const info = await gc.media.info(a.avatar_media).catch(() => null);
  if (!info) throw fail('not_found');
  let url = null;
  try { url = await gc.media.url(a.avatar_media, { user: userId, ttlS: 86400 }); } catch { url = null; }
  return { mediaId: a.avatar_media, mime: a.avatar_mime || info.mime, size: info.bytes, url };
}

/** The account goes: its picture too. */
async function drop(gc, a) {
  if (a && a.avatar_media) { try { await gc.media.delete(a.avatar_media); } catch { /* gone */ } }
}

module.exports = { view, due, refresh, tick, get, drop, DAY, RETRY };
