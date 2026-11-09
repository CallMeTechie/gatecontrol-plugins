'use strict';

// 1.13.0: „Rückgängig“ for a move, a copy, an archive, a delete (into the trash) or junk — POST messages/undo { token }.
// A bulk call keeps what reversing it needs for UNDO_MS (table undo_log): per mail its folder before and after, its
// local id after, and where the server put it (IMAP: the new uid from MOVE / COPYUID, else the target's UIDNEXT before
// and the Message-ID; Microsoft: the new Graph id). The token is the person's alone and works once.

const crypto = require('node:crypto');
const store = require('./store');
const engine = require('./engine');
const push = require('./push');
const { fail, parse } = require('./util');

const UNDO_MS = 2 * 60000;
const KINDS = new Set(['move', 'copy', 'archive', 'delete', 'junk']);
const SYNC_WAIT_MS = 8000;

/** p, waited for at most `ms` (the sync goes on in the background). */
function within(p, ms) {
  let timer;
  return Promise.race([p.catch(() => null), new Promise((res) => { timer = setTimeout(res, ms); if (timer.unref) timer.unref(); })]).finally(() => clearTimeout(timer));
}

/**
 * Keep an undo for `kind` of person `userId`: entries [{ id, newId, accountId, fromFolderId, toFolderId, uid, remoteId,
 * hint }] → the API's `undo` ({ token, kind, count, expiresAt, items }) or null when there is nothing to take back.
 */
async function keep(gc, userId, kind, entries) {
  if (!KINDS.has(kind) || !entries.length) return null;
  const now = Date.now();
  const token = crypto.randomBytes(18).toString('base64url');
  await store.run(gc, 'DELETE FROM undo_log WHERE expires_at < ?', [now - UNDO_MS]);
  await store.run(gc, 'INSERT INTO undo_log (token, user_id, kind, data_json, at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    [token, userId, kind, JSON.stringify(entries), now, now + UNDO_MS]);
  return {
    token, kind, count: entries.length, expiresAt: now + UNDO_MS,
    items: entries.map((e) => ({ id: e.id, newId: e.newId || null, accountId: e.accountId, fromFolderId: e.fromFolderId, toFolderId: e.toFolderId })),
  };
}

/** POST messages/undo { token } → { ok, kind, restored, failed, items (Summary) } */
async function run(gc, userId, b, answerRows) {
  const token = b && b.token;
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(token)) throw fail('invalid', { field: 'token' });
  const row = await store.one(gc, 'SELECT * FROM undo_log WHERE token = ? AND user_id = ? AND used = 0', [token, userId]);
  if (!row) throw fail('not_found', { field: 'token' });
  if (row.expires_at < Date.now()) throw fail('undo_expired');
  // taken at once: a second tap (or a second device) does not move the mail twice
  const took = await store.run(gc, 'UPDATE undo_log SET used = 1 WHERE token = ? AND used = 0', [token]);
  if (took && took.changes === 0) throw fail('not_found', { field: 'token' });
  const entries = parse(row.data_json, []);
  const byAccount = new Map();
  for (const e of entries) { if (!byAccount.has(e.accountId)) byAccount.set(e.accountId, []); byAccount.get(e.accountId).push(e); }
  let restored = 0;
  let failed = 0;
  const ids = [];
  for (const [accountId, list] of byAccount) {
    const a = await store.one(gc, 'SELECT * FROM accounts WHERE id = ? AND user_id = ?', [accountId, userId]);
    if (!a) { failed += list.length; continue; }
    let r;
    try {
      r = row.kind === 'copy' ? await engine.dropCopies(gc, a, list) : await engine.moveBack(gc, a, list);
    } catch (e) {
      // the server could not be reached: the token stays (asking again finds what went back already in place)
      if (byAccount.size === 1) { await store.run(gc, 'UPDATE undo_log SET used = 0 WHERE token = ?', [token]); throw e; }
      failed += list.length;
      continue;
    }
    restored += r.done;
    failed += r.failed;
    if (r.restored) ids.push(...r.restored);
    // the folders the mail came from load again (mail back without a new uid comes with this sync)
    const folders = new Set(list.map((e) => (row.kind === 'copy' ? e.toFolderId : e.fromFolderId)));
    for (const fid of folders) {
      const f = await store.one(gc, 'SELECT * FROM folders WHERE id = ?', [fid]);
      if (f && row.kind !== 'copy') await within(engine.syncOne(gc, a, f), SYNC_WAIT_MS);
    }
    // mail that came back without a new uid is here again with a new id (found by its Message-ID)
    if (row.kind !== 'copy') {
      const have = new Set(r.restored || []);
      for (const e of list) {
        if (have.has(e.newId) || !e.messageId) continue;
        const again = await store.one(gc, 'SELECT id FROM messages WHERE folder_id = ? AND message_id = ? ORDER BY id DESC', [e.fromFolderId, e.messageId]);
        if (again && !ids.includes(again.id)) ids.push(again.id);
      }
    }
    for (const fid of new Set([...list.map((e) => e.fromFolderId), ...list.map((e) => e.toFolderId)])) await push.changed(gc, userId, accountId, fid);
  }
  return { ok: true, kind: row.kind, restored, failed, items: row.kind === 'copy' ? [] : await answerRows(gc, userId, ids) };
}

module.exports = { keep, run, UNDO_MS };
