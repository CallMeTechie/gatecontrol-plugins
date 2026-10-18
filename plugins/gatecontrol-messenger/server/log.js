'use strict';

// The admin page "Protokoll": errors and limits only — never a message text,
// a name, a title or who wrote to whom. The same code within 10 minutes adds
// to one row (count). Rows are kept 30 days.
//
// Codes (texts in texts.json log.code.*):
//   push_rate_limit     the chat push budget of GateControl was reached (some recipients got no push)
//   push_failed         a chat push failed otherwise
//   events_rate_limit   too many live events (600 per minute) — some apps update on their next refresh
//   events_failed       a live event could not be sent
//   media_claim_failed  a file could not be bound to its message
//   media_delete_failed a file of a deleted message could not be removed (retried)
//   decrypt_failed      a stored text could not be decrypted (key changed?)
//   quota_exceeded      an upload was refused: storage full (reported by the apps — not seen here)
//   service_refused     a call of another plugin was refused (code in detail)
//   job_failed          a background step failed (step name in detail)
//   action_failed       a home action run from a chat did not succeed (1.4.0; the target's code in detail)

const store = require('./store');

const MERGE_MS = 10 * 60000;
const KEEP_MS = 30 * 86400000;
const CODES = ['push_rate_limit', 'push_failed', 'events_rate_limit', 'events_failed', 'media_claim_failed', 'media_delete_failed', 'decrypt_failed', 'service_refused', 'job_failed', 'action_failed'];
const LEVEL = { push_rate_limit: 'limit', events_rate_limit: 'limit' };

/** Record one entry; never throws. `detail` must not carry content (a code, a count, a plugin id). */
async function add(gc, code, detail, now = Date.now()) {
  try {
    const level = LEVEL[code] || 'error';
    const d = detail == null ? null : String(detail).slice(0, 120);
    const last = await store.one(gc, 'SELECT id FROM log WHERE code = ? AND (detail IS ? OR detail = ?) AND last_at >= ? ORDER BY id DESC LIMIT 1', [code, d, d, now - MERGE_MS]);
    if (last) await store.run(gc, 'UPDATE log SET count = count + 1, last_at = ? WHERE id = ?', [now, last.id]);
    else await store.run(gc, 'INSERT INTO log (at, last_at, level, code, detail, count) VALUES (?, ?, ?, ?, ?, 1)', [now, now, level, code, d]);
  } catch (e) {
    try { gc.log.warn('log entry failed', code); } catch { /* nothing */ }
  }
}

async function purge(gc, now) {
  await store.run(gc, 'DELETE FROM log WHERE last_at < ?', [now - KEEP_MS]);
}

module.exports = { add, purge, CODES };
