'use strict';

// Creates made offline (1.1.0): a device sends a create with `clientId` (a UUID it made) and may send it again when it
// did not see the answer. The first one makes the object and notes (person, clientId) → its id in `client_ids`
// (migrations/002_client_ids.sql) in the same transaction; a repeat finds it and answers with that object. Per person
// only: another person's clientId never reaches someone else's object. `listClientId`, `parentClientId` and
// `notebookClientId` name a parent made offline by its clientId (a sub task sent before its task is refused with
// `409 unknown_client_id`).

const store = require('./store');
const { fail } = require('./util');

const RE = /^[A-Za-z0-9_-]{8,64}$/;
const KEEP_MS = 180 * 86400000;

/** The clientId of a body (null: none), checked. */
function arg(v) {
  if (v == null) return null;
  if (typeof v !== 'string' || !RE.test(v)) throw fail('invalid', { field: 'clientId' });
  return v;
}

/** The row (person, clientId) of `kind`, or null; another kind under the same clientId is refused. */
async function find(gc, userId, clientId, kind) {
  if (!clientId || !Number.isSafeInteger(userId)) return null;
  const r = await store.one(gc, 'SELECT kind, ref_id FROM client_ids WHERE user_id = ? AND client_id = ?', [userId, clientId]);
  if (r && r.kind !== kind) throw fail('invalid', { field: 'clientId' });
  return r ? r.ref_id : null;
}

/** Inside the create's transaction: (person, clientId) → id. */
async function claim(gc, ctx, clientId, kind, refId) {
  if (!clientId) return;
  await store.run(gc, 'INSERT INTO client_ids (user_id, client_id, kind, ref_id, created_at) VALUES (?, ?, ?, ?, ?)', [ctx.userId, clientId, kind, refId, ctx.now]);
}

/** A parent named by its clientId (`field`) → its id; not made yet → 409 unknown_client_id. */
async function resolve(gc, ctx, v, kind, field) {
  if (v == null) return null;
  if (typeof v !== 'string' || !RE.test(v)) throw fail('invalid', { field });
  const r = await store.one(gc, 'SELECT kind, ref_id FROM client_ids WHERE user_id = ? AND client_id = ?', [ctx.userId, v]);
  if (!r || r.kind !== kind) throw fail('unknown_client_id', { field, clientId: v });
  return r.ref_id;
}

/** A repeated create whose object is no longer there (deleted, or the person left its list): 410 gone. */
function gone(clientId, id) {
  return fail('gone', { clientId, id });
}

/** Hourly: mappings older than 180 days go (a device sends its outbox long before). */
async function purge(gc, now) {
  const r = await store.run(gc, 'DELETE FROM client_ids WHERE created_at < ?', [now - KEEP_MS]);
  return (r && r.changes) || 0;
}

module.exports = { arg, find, claim, resolve, gone, purge, KEEP_MS };
