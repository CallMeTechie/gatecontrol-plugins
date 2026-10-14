'use strict';

// Locating children — only on request, the child always sees it.
//
//   POST locate/<childUserId>               a parent asks (module on, child < 18, mode ≠ off)
//   POST locate/requests/<id>/answer        the child's app sends the fix
//   POST locate/requests/<id>/decline       the child declines
//   POST locate/requests/<id>/fail          the child's app could not get a fix
//   GET  locate/requests?childId=&limit=    parents: any child; a child: its own (transparency)
//   GET  locate/requests/<id>
//
// A request is pending 10 minutes, then expires (tick). One open request per
// child, at least 60 s between requests and at most 30 per child and local
// day. Coordinates are deleted 7 days after the answer; the rows (who, when,
// what happened — no coordinates) stay 90 days and are the log.

const store = require('./store');
const tz = require('./tz');
const push = require('./push');
const members = require('./members');
const { fail, posInt, iso, parseIso, numIn, intIn } = require('./util');

const PENDING_MS = 10 * 60000;
const GAP_MS = 60000;
const PER_DAY = 30;
const COORD_DAYS = 7;
const ROW_DAYS = 90;
const FAIL_CODES = ['no_permission', 'location_off', 'timeout'];
const DAY = 86400000;

function view(r, fam) {
  const name = (id) => { const m = fam && fam.byId.get(id); return m ? m.name : null; };
  const has = r.status === 'answered' && !r.purged && r.lat != null;
  return {
    id: r.id, childId: r.child_id, requestedBy: r.requested_by, mode: r.mode, status: r.status,
    createdAt: iso(r.created_at), expiresAt: iso(r.expires_at), answeredAt: iso(r.answered_at),
    lat: has ? r.lat : null, lon: has ? r.lon : null, accuracy: has ? r.accuracy : null, at: has ? iso(r.fix_at) : null,
    battery: has ? r.battery : null,
    // additions: names for the lists, the decline reason / fail code, coordinates deleted
    childName: name(r.child_id), requestedByName: name(r.requested_by), reason: r.reason || null, purged: !!r.purged,
  };
}

/** POST locate/<childId> */
async function request(gc, r, rawChild) {
  if (r.me.role !== 'parent') throw fail('parents_only');
  const childId = posInt(rawChild);
  const child = childId ? r.fam.byId.get(childId) : null;
  const refusal = members.locateRefusal(child, r.cfg);
  if (refusal) throw fail(refusal);
  const last = await store.one(gc, 'SELECT * FROM locate_requests WHERE child_id = ? ORDER BY created_at DESC, id DESC LIMIT 1', [childId]);
  if (last && last.status === 'pending' && last.expires_at > r.now) {
    throw fail('too_soon', { retryAfter: Math.ceil((last.expires_at - r.now) / 1000), requestId: last.id });
  }
  if (last && r.now - last.created_at < GAP_MS) throw fail('too_soon', { retryAfter: Math.ceil((GAP_MS - (r.now - last.created_at)) / 1000) });
  const dayStart = tz.at(r.today, { hh: 0, mm: 0 }, r.cfg.tz);
  const count = (await store.one(gc, 'SELECT COUNT(*) AS n FROM locate_requests WHERE child_id = ? AND created_at >= ?', [childId, dayStart])).n;
  if (count >= PER_DAY) throw fail('daily_limit');
  // an earlier request still marked pending but past its time is closed first
  await store.run(gc, "UPDATE locate_requests SET status = 'expired' WHERE child_id = ? AND status = 'pending' AND expires_at <= ?", [childId, r.now]);
  const mode = child.locateMode === 'auto' ? 'auto' : 'confirm';
  const res = await store.run(gc, 'INSERT INTO locate_requests (child_id, requested_by, mode, status, created_at, expires_at) VALUES (?, ?, ?, \'pending\', ?, ?)',
    [childId, r.me.userId, mode, r.now, r.now + PENDING_MS]);
  const id = res.lastInsertRowid;
  const lang = r.cfg.lang;
  r.pushes.push({
    topic: 'locate', users: [childId], priority: 'high', collapseKey: `locate:${id}`, ttl: PENDING_MS / 1000,
    title: push.t(lang, mode === 'auto' ? 'locate.request_auto' : 'locate.request_confirm', { name: r.me.name }),
    body: push.t(lang, mode === 'auto' ? 'locate.request_auto_body' : 'locate.request_confirm_body', { name: r.me.name }),
    data: { familie: { type: 'locate_request', requestId: id, mode, from: r.me.name } },
  });
  return { request: view(await getRow(gc, id), r.fam) };
}

const getRow = (gc, id) => store.one(gc, 'SELECT * FROM locate_requests WHERE id = ?', [id]);

/** The child's own pending request (else not_found / not_pending). */
async function ownPending(gc, r, rawId) {
  const id = posInt(rawId);
  const row = id ? await getRow(gc, id) : null;
  if (!row || row.child_id !== r.me.userId) throw fail('not_found');
  if (row.status !== 'pending' || row.expires_at <= r.now) throw fail('not_pending');
  return row;
}

function resultPush(r, row, key, body, type) {
  const child = r.fam.byId.get(row.child_id) || r.me;
  if (!r.fam.byId.has(row.requested_by)) return;
  r.pushes.push({
    topic: 'locate', users: [row.requested_by], priority: 'high', collapseKey: `locate:${row.id}`, ttl: 3600,
    title: push.t(r.cfg.lang, key, { name: child.name }), body,
    data: { familie: { type, requestId: row.id, childId: row.child_id } },
  });
}

/** POST locate/requests/<id>/answer { lat, lon, accuracy, at, battery? } */
async function answer(gc, r, rawId) {
  const row = await ownPending(gc, r, rawId);
  const b = r.body || {};
  const lat = numIn(b.lat, -90, 90);
  const lon = numIn(b.lon, -180, 180);
  const accuracy = b.accuracy == null ? null : Math.round(numIn(b.accuracy, 0, 100000) * 10) / 10;
  let fixAt = b.at == null ? r.now : parseIso(b.at);
  if (fixAt == null) throw fail('invalid');
  if (fixAt > r.now + 5 * 60000) fixAt = r.now;
  const battery = b.battery == null ? null : intIn(Math.round(Number(b.battery)), 0, 100);
  await store.run(gc, "UPDATE locate_requests SET status = 'answered', answered_at = ?, lat = ?, lon = ?, accuracy = ?, fix_at = ?, battery = ? WHERE id = ?",
    [r.now, lat, lon, accuracy, fixAt, battery, row.id]);
  resultPush(r, row, 'locate.result',
    accuracy == null ? push.t(r.cfg.lang, 'locate.result_body_unknown') : push.t(r.cfg.lang, 'locate.result_body', { m: Math.round(accuracy) }), 'locate_result');
  return { request: view(await getRow(gc, row.id), r.fam) };
}

/** POST locate/requests/<id>/decline { reason?: 'busy' } */
async function decline(gc, r, rawId) {
  const row = await ownPending(gc, r, rawId);
  const b = r.body || {};
  if (b.reason != null && b.reason !== 'busy') throw fail('invalid');
  const reason = b.reason === 'busy' ? 'busy' : null;
  await store.run(gc, "UPDATE locate_requests SET status = 'declined', answered_at = ?, reason = ? WHERE id = ?", [r.now, reason, row.id]);
  resultPush(r, row, 'locate.declined', push.t(r.cfg.lang, reason ? 'locate.declined_body' : 'locate.declined_body_none'), 'locate_declined');
  return { request: view(await getRow(gc, row.id), r.fam) };
}

/** POST locate/requests/<id>/fail { code } */
async function failRequest(gc, r, rawId) {
  const row = await ownPending(gc, r, rawId);
  const code = r.body && r.body.code;
  if (!FAIL_CODES.includes(code)) throw fail('invalid');
  await store.run(gc, "UPDATE locate_requests SET status = 'failed', answered_at = ?, reason = ? WHERE id = ?", [r.now, code, row.id]);
  resultPush(r, row, 'locate.failed', push.t(r.cfg.lang, `locate.fail.${code}`), 'locate_failed');
  return { request: view(await getRow(gc, row.id), r.fam) };
}

/** May the viewer see this request? Parents: every one; a child: its own. */
function visibleTo(row, me) {
  return me.role === 'parent' || row.child_id === me.userId;
}

/** GET locate/requests?childId=&limit= */
async function list(gc, r) {
  const q = r.query || {};
  const limit = q.limit == null || q.limit === '' ? 20 : posInt(String(q.limit));
  if (!limit || limit > 100) throw fail('invalid');
  let childId = q.childId == null || q.childId === '' ? null : posInt(String(q.childId));
  if (q.childId != null && q.childId !== '' && !childId) throw fail('invalid');
  if (r.me.role !== 'parent') {
    if (childId && childId !== r.me.userId) throw fail('forbidden');
    childId = r.me.userId;
  }
  const rows = childId
    ? await store.all(gc, 'SELECT * FROM locate_requests WHERE child_id = ? ORDER BY created_at DESC, id DESC LIMIT ?', [childId, limit])
    : await store.all(gc, 'SELECT * FROM locate_requests ORDER BY created_at DESC, id DESC LIMIT ?', [limit]);
  return { requests: rows.map((x) => view(expiredNow(x, r.now), r.fam)) };
}

/** A pending row past its time reads as expired even before the tick closed it. */
function expiredNow(row, now) {
  return row.status === 'pending' && row.expires_at <= now ? { ...row, status: 'expired' } : row;
}

/** GET locate/requests/<id> */
async function one(gc, r, rawId) {
  const id = posInt(rawId);
  const row = id ? await getRow(gc, id) : null;
  if (!row || !visibleTo(row, r.me)) throw fail('not_found');
  return { request: view(expiredNow(row, r.now), r.fam) };
}

/** Overview: per child the latest request → [{ childId, status, at }] (parents: all children; a child: itself). */
async function last(gc, r) {
  const kids = r.me.role === 'parent' ? members.children(r.fam) : [r.me];
  const out = [];
  for (const k of kids) {
    const row = await store.one(gc, 'SELECT * FROM locate_requests WHERE child_id = ? ORDER BY created_at DESC, id DESC LIMIT 1', [k.userId]);
    if (!row) continue;
    const x = expiredNow(row, r.now);
    out.push({ childId: k.userId, status: x.status, at: iso(x.answered_at || x.created_at), requestId: x.id });
  }
  return out;
}

/** Background: expire pending requests (push to the requester). Collects pushes. */
async function expire(gc, fam, cfg, now, pushes) {
  const rows = await store.all(gc, "SELECT * FROM locate_requests WHERE status = 'pending' AND expires_at <= ?", [now]);
  for (const row of rows) {
    await store.run(gc, "UPDATE locate_requests SET status = 'expired' WHERE id = ? AND status = 'pending'", [row.id]);
    const child = fam.byId.get(row.child_id);
    if (!child || !fam.byId.has(row.requested_by)) continue;
    pushes.push({
      topic: 'locate', users: [row.requested_by], priority: 'high', collapseKey: `locate:${row.id}`, ttl: 3600,
      title: push.t(cfg.lang, 'locate.expired', { name: child.name }), body: push.t(cfg.lang, 'locate.expired_body'),
      data: { familie: { type: 'locate_expired', requestId: row.id, childId: row.child_id } },
    });
  }
}

/** Retention: coordinates 7 days after the answer, rows after 90 days. */
async function purge(gc, now) {
  await store.run(gc, 'UPDATE locate_requests SET lat = NULL, lon = NULL, accuracy = NULL, battery = NULL, purged = 1 WHERE purged = 0 AND answered_at IS NOT NULL AND answered_at < ? AND lat IS NOT NULL',
    [now - COORD_DAYS * DAY]);
  await store.run(gc, 'DELETE FROM locate_requests WHERE created_at < ?', [now - ROW_DAYS * DAY]);
}

/** The last answered position per child (log page / portal map) — coordinates still kept only. */
async function lastPositions(gc, fam, childIds) {
  const out = [];
  for (const id of childIds) {
    const row = await store.one(gc, "SELECT * FROM locate_requests WHERE child_id = ? AND status = 'answered' AND purged = 0 AND lat IS NOT NULL ORDER BY answered_at DESC LIMIT 1", [id]);
    if (row) out.push(view(row, fam));
  }
  return out;
}

module.exports = {
  PENDING_MS, GAP_MS, PER_DAY, COORD_DAYS, ROW_DAYS, FAIL_CODES, view, request, answer, decline, failRequest, list, one, last, expire, purge, lastPositions,
};
