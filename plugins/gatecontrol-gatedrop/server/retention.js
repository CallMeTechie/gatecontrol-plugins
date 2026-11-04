'use strict';

// Retention (since 1.5.0, set by an administrator on the page "Übersicht"; migrations/004_admin.sql):
//   after     days a send's files stay on the server once every recipient picked it up: 0 (at once — 15 minutes so a
//             running download ends), 1, 3, 7
//   unpicked  days for what nobody (or not everybody) picked up: 3, 7, 14, 30 — counted from sending; a picked-up send
//             never stays longer than that either
// Default 7 / 7: a send's files go 7 days after sending, as before 1.5.0. A link for outsiders keeps the time chosen
// when it was made — the files stay at least as long as an active link of the send. Settings apply to existing sends
// too (refreshAll). sends.expires_at is the result; the background (jobs.js) deletes the files then.
//
// A pick-up (deliveries.picked_at) is a real confirmation only (sends.js, transfers.js): the target device's
// POST sends/<id>/opened, the receiving device's direct result with every byte, the person's opened (a family: each
// member at sending), a NAS / Drive save, a Messenger message that carries every file. sends.picked_at: every delivery
// that needs the server copy (not links, not failed / expired ones) is picked up — the latest; a send of links only:
// its first download.

const store = require('./store');
const { fail } = require('./util');

const DAY = 86400000;
const AFTER = Object.freeze([0, 1, 3, 7]);
const UNPICKED = Object.freeze([3, 7, 14, 30]);
const DEFAULTS = Object.freeze({ afterDays: 7, unpickedDays: 7 });
const GRACE_MS = 15 * 60000; // "at once": a download that was just started still ends
const CHUNK = 200;

let cache = null;

function reset() { cache = null; }

/** The administrator's setting → { afterDays, unpickedDays }. */
async function get(gc) {
  if (cache) return cache;
  const rows = await store.all(gc, "SELECT key, value FROM settings WHERE key IN ('retention.after', 'retention.unpicked')");
  const v = Object.fromEntries(rows.map((r) => [r.key, Number(r.value)]));
  cache = {
    afterDays: AFTER.includes(v['retention.after']) ? v['retention.after'] : DEFAULTS.afterDays,
    unpickedDays: UNPICKED.includes(v['retention.unpicked']) ? v['retention.unpicked'] : DEFAULTS.unpickedDays,
  };
  return cache;
}

/** [after ms, unpicked ms] of a setting. */
const spans = (r) => [Math.max(r.afterDays * DAY, GRACE_MS), r.unpickedDays * DAY];

// sends.expires_at from picked_at, created_at and the send's active links: ?1 = after (ms), ?2 = unpicked (ms).
const EXPIRY = `MAX(
    COALESCE((SELECT MAX(l.expires_at) FROM links l WHERE l.send_id = sends.id AND l.revoked_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.send_id = sends.id AND d.kind = 'link' AND d.target = l.token AND d.status = 'expired')), 0),
    CASE WHEN sends.picked_at IS NULL THEN sends.created_at + ? ELSE MIN(sends.picked_at + ?, sends.created_at + ?) END)`;
const expiryParams = (r) => { const [a, u] = spans(r); return [u, a, u]; };

/**
 * A send's pick-up as its deliveries say → the time (ms) or null. Links do not count — unless the send has only links:
 * then its first download (the links' counter).
 */
async function pickedOf(gc, sendId) {
  const dels = await store.all(gc, 'SELECT kind, status, picked_at FROM deliveries WHERE send_id = ?', [sendId]);
  const units = dels.filter((d) => d.kind !== 'link');
  if (!units.length) {
    const l = await store.one(gc, 'SELECT MIN(created_at) AS at, MAX(downloads) AS n FROM links WHERE send_id = ?', [sendId]);
    return l && l.n > 0 ? l.at : null;
  }
  if (units.some((d) => d.picked_at == null && d.status !== 'failed' && d.status !== 'expired')) return null;
  const at = units.map((d) => d.picked_at).filter((x) => x != null);
  return at.length ? Math.max(...at) : null;
}

/** After a change of a send's deliveries or links: its pick-up and expiry anew (not for files already gone). */
async function touch(gc, sendId) {
  const s = await store.one(gc, 'SELECT purged, removed_at FROM sends WHERE id = ?', [sendId]);
  if (!s || s.purged || s.removed_at) return;
  const picked = await pickedOf(gc, sendId);
  // two steps: an UPDATE reads the row as it was (the expiry needs the new pick-up)
  await store.run(gc, 'UPDATE sends SET picked_at = ? WHERE id = ? AND purged = 0 AND removed_at IS NULL', [picked, sendId]);
  await store.run(gc, `UPDATE sends SET expires_at = ${EXPIRY} WHERE id = ? AND purged = 0 AND removed_at IS NULL`, [...expiryParams(await get(gc)), sendId]);
}

/** Every send with its files still on the server: the expiry after a new setting (in steps of 200, by id). → count */
async function refreshAll(gc) {
  const r = await get(gc);
  let last = '';
  let n = 0;
  for (;;) {
    const ids = await store.all(gc, 'SELECT id FROM sends WHERE purged = 0 AND removed_at IS NULL AND id > ? ORDER BY id LIMIT ?', [last, CHUNK]);
    if (!ids.length) break;
    const to = ids[ids.length - 1].id;
    const res = await store.run(gc, `UPDATE sends SET expires_at = ${EXPIRY} WHERE purged = 0 AND removed_at IS NULL AND id > ? AND id <= ?`, [...expiryParams(r), last, to]);
    n += (res && res.changes) || 0;
    last = to;
    if (ids.length < CHUNK) break;
  }
  return n;
}

/** PUT admin/retention { afterDays, unpickedDays } → the setting (applied to existing sends too). */
async function set(gc, body, now) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b || !AFTER.includes(b.afterDays) || !UNPICKED.includes(b.unpickedDays)) throw fail('invalid');
  await store.tx(gc, async () => {
    for (const [k, v] of [['retention.after', b.afterDays], ['retention.unpicked', b.unpickedDays]]) {
      await store.run(gc, 'INSERT INTO settings (key, value, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, at = excluded.at', [k, String(v), now]);
    }
  });
  cache = null;
  await refreshAll(gc);
  return view(await get(gc));
}

/** The setting as the admin page and GET targets show it. */
const view = (r) => ({ afterDays: r.afterDays, unpickedDays: r.unpickedDays, after: [...AFTER], unpicked: [...UNPICKED] });

/** The expiry of a new send (no pick-up yet, links come later through touch). */
async function initial(gc, now) {
  return now + (await get(gc)).unpickedDays * DAY;
}

module.exports = { get, set, view, touch, refreshAll, pickedOf, initial, reset, AFTER, UNPICKED, DEFAULTS, GRACE_MS, DAY };
