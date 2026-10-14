'use strict';

// Shopping lists, offline-first. Lists and items carry client-generated ids
// (uuid), so an app can create them offline and replay its outbox later:
//
//   GET  shopping[?since=<serverTime>]   everything (not deleted) / every change since,
//                                        tombstones included (deleted: true, kept 30 days)
//   POST shopping/ops { ops: [...] }     ≤ 200 ops, applied in order, idempotent (the same
//                                        id twice never duplicates), last write wins by
//                                        arrival → { applied, rejected: [{ index, code }], serverTime }
//   POST shopping/lists/<id>/going       "Marc geht einkaufen" to the other members
//                                        (once per list, person and 15 minutes)

const store = require('./store');
const push = require('./push');
const { fail, line, iso, parseIso } = require('./util');

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;
const MAX_OPS = 200;
const TEXT_MAX = 120;
const QTY_MAX = 40;
const NAME_MAX = 40;
const ICON_MAX = 32;
const TOMBSTONE_DAYS = 30;
const GOING_GAP_MS = 15 * 60000;
const DAY = 86400000;

const listView = (r) => ({ id: r.id, name: r.name, icon: r.icon || null, sort: r.sort, updatedAt: iso(r.updated_at), deleted: !!r.deleted });
const itemView = (r) => ({
  id: r.id, listId: r.list_id, text: r.text, qty: r.qty || null, checked: !!r.checked, checkedBy: r.checked_by == null ? null : r.checked_by,
  updatedAt: iso(r.updated_at), deleted: !!r.deleted,
});

/** GET shopping */
async function get(gc, query, now) {
  if (query && query.since != null && query.since !== '') {
    const since = parseIso(String(query.since));
    if (since == null) throw fail('invalid');
    // whole seconds: the serverTime handed out is floored, so >= never misses a change
    const from = Math.floor(since / 1000) * 1000;
    const lists = await store.all(gc, 'SELECT * FROM shop_lists WHERE updated_at >= ? ORDER BY sort, created_at', [from]);
    const items = await store.all(gc, 'SELECT * FROM shop_items WHERE updated_at >= ? ORDER BY created_at', [from]);
    return { lists: lists.map(listView), items: items.map(itemView), serverTime: iso(now) };
  }
  const lists = await store.all(gc, 'SELECT * FROM shop_lists WHERE deleted = 0 ORDER BY sort, created_at');
  const items = await store.all(gc, `SELECT i.* FROM shop_items i JOIN shop_lists l ON l.id = i.list_id
    WHERE i.deleted = 0 AND l.deleted = 0 ORDER BY i.created_at`);
  return { lists: lists.map(listView), items: items.map(itemView), serverTime: iso(now) };
}

/** Open (unchecked) items per list → [{ id, name, open }] (overview). */
async function summary(gc) {
  const rows = await store.all(gc, `SELECT l.id, l.name, l.icon, (SELECT COUNT(*) FROM shop_items i WHERE i.list_id = l.id AND i.deleted = 0 AND i.checked = 0) AS open
    FROM shop_lists l WHERE l.deleted = 0 ORDER BY l.sort, l.created_at`);
  return rows.map((r) => ({ id: r.id, name: r.name, icon: r.icon || null, open: r.open }));
}

// ─── ops ────────────────────────────────────────

class OpError extends Error { constructor(code) { super(code); this.code = code; } }
const rej = (code) => new OpError(code);

const opId = (v) => {
  if (typeof v !== 'string' || !ID_RE.test(v)) throw rej('invalid');
  return v;
};
const opText = (v, max, required) => {
  if (v == null || v === '') { if (required) throw rej('invalid'); return null; }
  const s = line(v);
  if (s == null || (required && !s) || s.length > max) throw rej('invalid');
  return s || null;
};

const getList = (gc, id) => store.one(gc, 'SELECT * FROM shop_lists WHERE id = ?', [id]);
const getItem = (gc, id) => store.one(gc, 'SELECT * FROM shop_items WHERE id = ?', [id]);

const OPS = {
  async list_add(gc, op, user, at) {
    const id = opId(op.id);
    const name = opText(op.name, NAME_MAX, true);
    const icon = opText(op.icon, ICON_MAX, false);
    if (await getList(gc, id)) return; // replayed: already there (or already deleted)
    const max = await store.one(gc, 'SELECT COALESCE(MAX(sort), -1) AS m FROM shop_lists');
    await store.run(gc, 'INSERT INTO shop_lists (id, name, icon, sort, created_by, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, 0)',
      [id, name, icon, max.m + 1, user.id, at, at]);
  },
  async list_rename(gc, op, user, at) {
    const id = opId(op.id);
    const name = opText(op.name, NAME_MAX, true);
    const l = await getList(gc, id);
    if (!l || l.deleted) throw rej('not_found');
    if (op.icon !== undefined) {
      await store.run(gc, 'UPDATE shop_lists SET name = ?, icon = ?, updated_at = ? WHERE id = ?', [name, opText(op.icon, ICON_MAX, false), at, id]);
    } else {
      await store.run(gc, 'UPDATE shop_lists SET name = ?, updated_at = ? WHERE id = ?', [name, at, id]);
    }
  },
  async list_delete(gc, op, user, at) {
    const id = opId(op.id);
    const l = await getList(gc, id);
    if (!l) throw rej('not_found');
    if (l.deleted) return;
    await store.run(gc, 'UPDATE shop_lists SET deleted = 1, updated_at = ? WHERE id = ?', [at, id]);
    await store.run(gc, 'UPDATE shop_items SET deleted = 1, updated_at = ? WHERE list_id = ? AND deleted = 0', [at, id]);
    await store.run(gc, 'UPDATE places SET list_id = NULL WHERE list_id = ?', [id]);
  },
  async item_add(gc, op, user, at) {
    const id = opId(op.id);
    const listId = opId(op.listId);
    const text = opText(op.text, TEXT_MAX, true);
    const qty = opText(op.qty, QTY_MAX, false);
    if (await getItem(gc, id)) return; // replayed
    const l = await getList(gc, listId);
    if (!l || l.deleted) throw rej('not_found');
    await store.run(gc, 'INSERT INTO shop_items (id, list_id, text, qty, checked, checked_by, created_by, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, 0, NULL, ?, ?, ?, 0)',
      [id, listId, text, qty, user.id, at, at]);
  },
  async item_edit(gc, op, user, at) {
    const id = opId(op.id);
    if (op.text === undefined && op.qty === undefined) throw rej('invalid');
    const text = op.text === undefined ? undefined : opText(op.text, TEXT_MAX, true);
    const qty = op.qty === undefined ? undefined : opText(op.qty, QTY_MAX, false);
    const it = await getItem(gc, id);
    if (!it || it.deleted) throw rej('not_found');
    await store.run(gc, 'UPDATE shop_items SET text = ?, qty = ?, updated_at = ? WHERE id = ?',
      [text === undefined ? it.text : text, qty === undefined ? it.qty : qty, at, id]);
  },
  async item_check(gc, op, user, at) {
    const id = opId(op.id);
    if (typeof op.checked !== 'boolean') throw rej('invalid');
    const it = await getItem(gc, id);
    if (!it || it.deleted) throw rej('not_found');
    await store.run(gc, 'UPDATE shop_items SET checked = ?, checked_by = ?, updated_at = ? WHERE id = ?', [op.checked ? 1 : 0, op.checked ? user.id : null, at, id]);
  },
  async item_delete(gc, op, user, at) {
    const id = opId(op.id);
    const it = await getItem(gc, id);
    if (!it) throw rej('not_found');
    if (it.deleted) return;
    await store.run(gc, 'UPDATE shop_items SET deleted = 1, updated_at = ? WHERE id = ?', [at, id]);
  },
  async clear_checked(gc, op, user, at) {
    const listId = opId(op.listId);
    const l = await getList(gc, listId);
    if (!l || l.deleted) throw rej('not_found');
    await store.run(gc, 'UPDATE shop_items SET deleted = 1, updated_at = ? WHERE list_id = ? AND checked = 1 AND deleted = 0', [at, listId]);
  },
};

/** POST shopping/ops (inside a transaction) */
async function applyOps(gc, body, user, now) {
  const ops = body && body.ops;
  if (!Array.isArray(ops) || ops.length > MAX_OPS) throw fail('invalid');
  let applied = 0;
  const rejected = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const fn = op && typeof op === 'object' && !Array.isArray(op) && typeof op.op === 'string' && Object.prototype.hasOwnProperty.call(OPS, op.op) ? OPS[op.op] : null;
    if (!fn) { rejected.push({ index: i, code: 'invalid' }); continue; }
    try {
      await fn(gc, op, user, now);
      applied++;
    } catch (e) {
      if (!(e instanceof OpError)) throw e;
      rejected.push({ index: i, code: e.code });
    }
  }
  return { applied, rejected, serverTime: iso(now) };
}

/** POST shopping/lists/<id>/going (inside a transaction; the push goes to r.pushes) */
async function going(gc, r, listId) {
  if (typeof listId !== 'string' || !ID_RE.test(listId)) throw fail('not_found');
  const l = await getList(gc, listId);
  if (!l || l.deleted) throw fail('not_found');
  const prev = await store.one(gc, 'SELECT at FROM shop_going WHERE list_id = ? AND user_id = ?', [listId, r.me.userId]);
  if (prev && r.now - prev.at < GOING_GAP_MS) throw fail('too_soon', { retryAfter: Math.ceil((GOING_GAP_MS - (r.now - prev.at)) / 1000) });
  await store.run(gc, 'INSERT INTO shop_going (list_id, user_id, at) VALUES (?, ?, ?) ON CONFLICT(list_id, user_id) DO UPDATE SET at = excluded.at', [listId, r.me.userId, r.now]);
  const open = (await store.one(gc, 'SELECT COUNT(*) AS n FROM shop_items WHERE list_id = ? AND deleted = 0 AND checked = 0', [listId])).n;
  const to = r.fam.list.filter((m) => m.userId !== r.me.userId).map((m) => m.userId);
  const lang = r.cfg.lang;
  r.pushes.push({
    topic: 'shopping', users: to,
    title: push.t(lang, 'shopping.going', { name: r.me.name, list: l.name }),
    body: push.t(lang, open === 0 ? 'shopping.going_body_0' : (open === 1 ? 'shopping.going_body_1' : 'shopping.going_body_n'), { n: open }),
    priority: 'normal', collapseKey: `going:${listId}`, ttl: 2 * 3600,
    data: { familie: { type: 'shopping_going', listId, userId: r.me.userId } },
  });
  return { notified: to.length };
}

/** Who is shopping right now (last hour) → [{ userId, listId, at }] (overview). */
async function goingNow(gc, now) {
  const rows = await store.all(gc, `SELECT g.list_id, g.user_id, g.at FROM shop_going g JOIN shop_lists l ON l.id = g.list_id
    WHERE g.at >= ? AND l.deleted = 0 ORDER BY g.at DESC`, [now - 3600000]);
  return rows.map((x) => ({ userId: x.user_id, listId: x.list_id, at: iso(x.at) }));
}

/** Retention (tick): tombstones after 30 days, old "going" rows. */
async function purge(gc, now) {
  const before = now - TOMBSTONE_DAYS * DAY;
  await store.run(gc, 'DELETE FROM shop_items WHERE deleted = 1 AND updated_at < ?', [before]);
  await store.run(gc, 'DELETE FROM shop_lists WHERE deleted = 1 AND updated_at < ?', [before]);
  await store.run(gc, 'DELETE FROM shop_going WHERE at < ?', [now - DAY]);
}

module.exports = { get, summary, applyOps, going, goingNow, purge, ID_RE, MAX_OPS, TOMBSTONE_DAYS, GOING_GAP_MS };
