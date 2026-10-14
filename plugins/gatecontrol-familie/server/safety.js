'use strict';

// "Bin angekommen" and SOS (module arrival_sos).
//
//   POST arrival { label?, lat?, lon?, accuracy? }   → the parents (not the caller); ≥ 60 s apart
//   POST sos { lat?, lon?, accuracy?, at? }          → every parent (not the caller), priority
//                                                      critical (bypasses quiet hours); a repeat
//                                                      within 30 s returns the same sosId
//   POST sos/<id>/ack                                a parent saw it → push to the sender
//   GET  sos/<id>   GET sos?limit=                   (additions) one SOS with its acks / recent ones
//
// Coordinates are deleted after 7 days, rows after 90 days (the log).

const store = require('./store');
const push = require('./push');
const format = require('./format');
const members = require('./members');
const { fail, posInt, optText, iso, parseIso, position } = require('./util');

const ARRIVAL_GAP_MS = 60000;
const SOS_DEDUPE_MS = 30000;
const COORD_DAYS = 7;
const ROW_DAYS = 90;
const LABEL_MAX = 60;
const DAY = 86400000;

/** POST arrival */
async function arrival(gc, r) {
  const b = r.body || {};
  const label = optText(b.label, LABEL_MAX);
  const pos = position(b);
  const prev = await store.one(gc, 'SELECT at FROM arrivals WHERE user_id = ? ORDER BY at DESC, id DESC LIMIT 1', [r.me.userId]);
  if (prev && r.now - prev.at < ARRIVAL_GAP_MS) throw fail('too_soon', { retryAfter: Math.ceil((ARRIVAL_GAP_MS - (r.now - prev.at)) / 1000) });
  const res = await store.run(gc, 'INSERT INTO arrivals (user_id, label, lat, lon, accuracy, at) VALUES (?, ?, ?, ?, ?, ?)',
    [r.me.userId, label, pos.lat, pos.lon, pos.accuracy, r.now]);
  const to = members.parents(r.fam).map((m) => m.userId).filter((u) => u !== r.me.userId);
  const time = format.time(r.now, r.cfg.tz);
  r.pushes.push({
    topic: 'arrival', users: to, priority: 'normal', collapseKey: `arrival:${r.me.userId}`, ttl: 6 * 3600,
    title: push.t(r.cfg.lang, 'arrival.title', { name: r.me.name }), body: label ? `${label} · ${time}` : time,
    data: { familie: { type: 'arrival', userId: r.me.userId, label, arrivalId: res.lastInsertRowid } },
  });
  return { arrivalId: res.lastInsertRowid, notified: to.length };
}

/** Latest arrival per member within 24 h → [{ userId, label, at }] (overview). */
async function recentArrivals(gc, now) {
  const rows = await store.all(gc, `SELECT a.user_id, a.label, a.at FROM arrivals a
    WHERE a.at >= ? AND a.id = (SELECT b.id FROM arrivals b WHERE b.user_id = a.user_id ORDER BY b.at DESC, b.id DESC LIMIT 1) ORDER BY a.at DESC, a.id DESC`, [now - DAY]);
  return rows.map((x) => ({ userId: x.user_id, label: x.label || null, at: iso(x.at) }));
}

function sosView(row, acks, fam) {
  const name = (id) => { const m = fam.byId.get(id); return m ? m.name : null; };
  const has = !row.purged && row.lat != null;
  return {
    id: row.id, userId: row.user_id, name: name(row.user_id), at: iso(row.at),
    lat: has ? row.lat : null, lon: has ? row.lon : null, accuracy: has ? row.accuracy : null, fixAt: has ? iso(row.fix_at) : null,
    acks: acks.filter((a) => a.sos_id === row.id).map((a) => ({ userId: a.user_id, name: name(a.user_id), at: iso(a.at) })),
  };
}

/** POST sos */
async function sos(gc, r) {
  const b = r.body || {};
  const pos = position(b);
  let fixAt = b.at == null ? null : parseIso(b.at);
  if (b.at != null && fixAt == null) throw fail('invalid');
  if (fixAt != null && fixAt > r.now + 5 * 60000) fixAt = r.now;
  const prev = await store.one(gc, 'SELECT * FROM sos WHERE user_id = ? ORDER BY at DESC, id DESC LIMIT 1', [r.me.userId]);
  if (prev && r.now - prev.at < SOS_DEDUPE_MS) {
    // a repeat (double tap, retry): the same SOS; a better position is kept
    if (pos.lat != null && (prev.lat == null || (pos.accuracy != null && (prev.accuracy == null || pos.accuracy < prev.accuracy)))) {
      await store.run(gc, 'UPDATE sos SET lat = ?, lon = ?, accuracy = ?, fix_at = ? WHERE id = ?', [pos.lat, pos.lon, pos.accuracy, fixAt || r.now, prev.id]);
    }
    return { sosId: prev.id, repeated: true, notified: 0 };
  }
  const res = await store.run(gc, 'INSERT INTO sos (user_id, lat, lon, accuracy, fix_at, at) VALUES (?, ?, ?, ?, ?, ?)',
    [r.me.userId, pos.lat, pos.lon, pos.accuracy, pos.lat != null ? (fixAt || r.now) : null, r.now]);
  const id = res.lastInsertRowid;
  const to = members.parents(r.fam).map((m) => m.userId).filter((u) => u !== r.me.userId);
  const time = format.time(r.now, r.cfg.tz);
  const lang = r.cfg.lang;
  let body;
  if (pos.lat == null) body = push.t(lang, 'sos.body_nopos', { time });
  else if (pos.accuracy == null) body = push.t(lang, 'sos.body_pos_unknown', { time });
  else body = push.t(lang, 'sos.body_pos', { time, m: Math.round(pos.accuracy) });
  r.pushes.push({
    topic: 'sos', users: to, priority: 'critical', collapseKey: `sos:${id}`, ttl: 6 * 3600,
    title: push.t(lang, 'sos.title', { name: r.me.name }), body,
    data: { familie: { type: 'sos', sosId: id, userId: r.me.userId, lat: pos.lat, lon: pos.lon, accuracy: pos.accuracy } },
  });
  return { sosId: id, repeated: false, notified: to.length };
}

async function getSos(gc, id) {
  return store.one(gc, 'SELECT * FROM sos WHERE id = ?', [id]);
}

/** POST sos/<id>/ack (parents) */
async function ack(gc, r, rawId) {
  if (r.me.role !== 'parent') throw fail('parents_only');
  const id = posInt(rawId);
  const row = id ? await getSos(gc, id) : null;
  if (!row) throw fail('not_found');
  const had = await store.one(gc, 'SELECT 1 AS x FROM sos_acks WHERE sos_id = ? AND user_id = ?', [id, r.me.userId]);
  if (!had) {
    await store.run(gc, 'INSERT INTO sos_acks (sos_id, user_id, at) VALUES (?, ?, ?)', [id, r.me.userId, r.now]);
    if (row.user_id !== r.me.userId && r.fam.byId.has(row.user_id)) {
      r.pushes.push({
        topic: 'sos', users: [row.user_id], priority: 'high', collapseKey: `sosack:${id}`, ttl: 6 * 3600,
        title: push.t(r.cfg.lang, 'sos.ack', { name: r.me.name }), body: push.t(r.cfg.lang, 'sos.ack_body'),
        data: { familie: { type: 'sos_ack', sosId: id, userId: r.me.userId } },
      });
    }
  }
  const acks = await store.all(gc, 'SELECT * FROM sos_acks WHERE sos_id = ? ORDER BY at', [id]);
  return { sos: sosView(row, acks, r.fam) };
}

/** GET sos/<id> (the sender or a parent) */
async function one(gc, r, rawId) {
  const id = posInt(rawId);
  const row = id ? await getSos(gc, id) : null;
  if (!row || (r.me.role !== 'parent' && row.user_id !== r.me.userId)) throw fail('not_found');
  const acks = await store.all(gc, 'SELECT * FROM sos_acks WHERE sos_id = ? ORDER BY at', [id]);
  return { sos: sosView(row, acks, r.fam) };
}

/** GET sos?limit= (parents: all; others: their own) */
async function list(gc, r) {
  const q = r.query || {};
  const limit = q.limit == null || q.limit === '' ? 20 : posInt(String(q.limit));
  if (!limit || limit > 100) throw fail('invalid');
  const rows = r.me.role === 'parent'
    ? await store.all(gc, 'SELECT * FROM sos ORDER BY at DESC, id DESC LIMIT ?', [limit])
    : await store.all(gc, 'SELECT * FROM sos WHERE user_id = ? ORDER BY at DESC, id DESC LIMIT ?', [r.me.userId, limit]);
  const ids = rows.map((x) => x.id);
  const acks = ids.length ? await store.all(gc, `SELECT * FROM sos_acks WHERE sos_id IN (${store.marks(ids.length)}) ORDER BY at`, ids) : [];
  return { sos: rows.map((x) => sosView(x, acks, r.fam)) };
}

async function purge(gc, now) {
  const before = now - COORD_DAYS * DAY;
  await store.run(gc, 'UPDATE arrivals SET lat = NULL, lon = NULL, accuracy = NULL, purged = 1 WHERE purged = 0 AND at < ?', [before]);
  await store.run(gc, 'UPDATE sos SET lat = NULL, lon = NULL, accuracy = NULL, purged = 1 WHERE purged = 0 AND at < ?', [before]);
  const old = now - ROW_DAYS * DAY;
  await store.run(gc, 'DELETE FROM arrivals WHERE at < ?', [old]);
  await store.run(gc, 'DELETE FROM sos_acks WHERE sos_id IN (SELECT id FROM sos WHERE at < ?)', [old]);
  await store.run(gc, 'DELETE FROM sos WHERE at < ?', [old]);
}

module.exports = { ARRIVAL_GAP_MS, SOS_DEDUPE_MS, arrival, recentArrivals, sos, ack, one, list, purge, sosView };
