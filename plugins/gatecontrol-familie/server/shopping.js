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
//                                        (once per list, person and 15 minutes); 1.9.0: with the setting
//                                        shopping_chat 'family' (default) also a card „<Name> geht jetzt
//                                        einkaufen · <Liste> · n Artikel“ with „Zur Liste“ in the family chat
//                                        → { notified, chat: { ok, code } | null }
//   1.9.0 — a list asked of a person:
//   POST shopping/lists/<id>/assign { userId | null, dueAt?: ISO | null, notify?: 'direct' | 'family' | 'push' }
//                                        any member (not a wall tablet); userId a family member, null = no one
//                                        (the request ends). notify (default: the setting shopping_notify,
//                                        'direct'): a card „Kannst du einkaufen gehen?“ — „<Liste> · n Artikel ·
//                                        bis …“ with „Übernehmen“ / „Heute nicht“ (this plugin's quick actions
//                                        shop-take:<listId> / shop-decline:<listId>, listed only for the person
//                                        asked while the request is open — server/quick.js) into the direct chat
//                                        of the two (Messenger target direct:<uid>), else the family chat, else
//                                        a push with the same two buttons; 'family' starts with the family chat;
//                                        'push' only the push. Asking oneself sends nothing.
//                                        → { list, notified: { via: 'direct' | 'family' | 'push' | null, ok, code } | null }
// Every list carries assignee { userId, by, at, state: 'open' | 'taken' | 'declined', notify } | null and
// dueAt (ISO | null) — in GET shopping and the overview; a change of them is a change of the list
// (updatedAt, ?since).

const store = require('./store');
const push = require('./push');
const tz = require('./tz');
const format = require('./format');
const messenger = require('./messenger');
const { SHOPPING_NOTIFY } = require('./config');
const { fail, line, iso, parseIso, posInt } = require('./util');

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;
const MAX_OPS = 200;
const TEXT_MAX = 120;
const QTY_MAX = 40;
const NAME_MAX = 40;
const ICON_MAX = 32;
const TOMBSTONE_DAYS = 30;
const GOING_GAP_MS = 15 * 60000;
const DAY = 86400000;

const ASSIGN_STATES = ['open', 'taken', 'declined'];
const ROUTE = 'plg-gatecontrol-familie';

/** 1.9.0: who is asked to do the shopping (null: nobody). */
const assigneeOf = (r) => (r.assignee_id == null ? null : {
  userId: r.assignee_id, by: r.assigned_by == null ? null : r.assigned_by, at: iso(r.assigned_at), state: ASSIGN_STATES.includes(r.assign_state) ? r.assign_state : 'open', notify: r.assign_notify || null,
});

const listView = (r) => ({
  id: r.id, name: r.name, icon: r.icon || null, sort: r.sort, updatedAt: iso(r.updated_at), deleted: !!r.deleted, assignee: assigneeOf(r), dueAt: iso(r.due_at),
});
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
  const rows = await store.all(gc, `SELECT l.*, (SELECT COUNT(*) FROM shop_items i WHERE i.list_id = l.id AND i.deleted = 0 AND i.checked = 0) AS open
    FROM shop_lists l WHERE l.deleted = 0 ORDER BY l.sort, l.created_at`);
  return rows.map((r) => ({ id: r.id, name: r.name, icon: r.icon || null, open: r.open, assignee: assigneeOf(r), dueAt: iso(r.due_at) }));
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

/**
 * POST shopping/ops (inside a transaction). opts.only: the ops this caller may
 * use (the wall tablet: item_add, item_check) — any other op is rejected with
 * the code 'forbidden'.
 */
async function applyOps(gc, body, user, now, opts) {
  const only = opts && Array.isArray(opts.only) ? opts.only : null;
  const ops = body && body.ops;
  if (!Array.isArray(ops) || ops.length > MAX_OPS) throw fail('invalid');
  let applied = 0;
  const rejected = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const fn = op && typeof op === 'object' && !Array.isArray(op) && typeof op.op === 'string' && Object.prototype.hasOwnProperty.call(OPS, op.op) ? OPS[op.op] : null;
    if (!fn) { rejected.push({ index: i, code: 'invalid' }); continue; }
    if (only && !only.includes(op.op)) { rejected.push({ index: i, code: 'forbidden' }); continue; }
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
  // the person asked goes: the request is taken
  if (l.assignee_id === r.me.userId && l.assign_state !== 'taken') await store.run(gc, "UPDATE shop_lists SET assign_state = 'taken', updated_at = ? WHERE id = ?", [r.now, listId]);
  // 1.9.0: a card in the family chat (setting shopping_chat), after the commit
  if (r.cfg.shoppingChat === 'family' && Array.isArray(r.after)) {
    const card = {
      kind: 'notice', title: push.t(lang, 'card.going_title', { name: r.me.name }).slice(0, 80), text: `${l.name} · ${itemsText(lang, open)}`,
      link: { label: push.t(lang, 'card.going_link'), route: ROUTE },
    };
    r.after.push(async () => {
      const res = await messenger.sendCard(gc, r.fam, r.cfg, r.now, 'family', card, r.me.userId);
      return { chat: { ok: res.ok, code: res.code } };
    });
  }
  r.pushes.push({
    topic: 'shopping', users: to,
    title: push.t(lang, 'shopping.going', { name: r.me.name, list: l.name }),
    body: push.t(lang, open === 0 ? 'shopping.going_body_0' : (open === 1 ? 'shopping.going_body_1' : 'shopping.going_body_n'), { n: open }),
    priority: 'normal', collapseKey: `going:${listId}`, ttl: 2 * 3600,
    data: { familie: { type: 'shopping_going', listId, userId: r.me.userId } },
  });
  return { notified: to.length, chat: null };
}

/** "3 Artikel" in the notification language. */
function itemsText(lang, n) {
  return push.t(lang, n === 0 ? 'shopping.items_0' : (n === 1 ? 'shopping.items_1' : 'shopping.items_n'), { n });
}

/** "bis heute 18:00" / "bis Fr, 17.10. 18:00" — or '' without a due time. */
function dueText(lang, dueAt, cfg, now) {
  if (dueAt == null) return '';
  const date = tz.localDate(dueAt, cfg.tz);
  return push.t(lang, 'card.due', { when: `${format.rel(date, tz.localDate(now, cfg.tz), lang)} ${format.time(dueAt, cfg.tz)}` });
}

/** The quick action ids of a request (null when the list id is too long for one). */
function requestIds(listId) {
  const take = `shop-take:${listId}`;
  const decline = `shop-decline:${listId}`;
  return decline.length <= 64 ? { take, decline } : null;
}

/**
 * Ask `userId` (after the commit): the card into the chat (direct → family, see the head of this file),
 * else a push with the two buttons. Never throws. → { via, ok, code }
 */
async function ask(gc, r, l, userId, dueAt, mode, open) {
  const lang = r.cfg.lang;
  const due = dueText(lang, dueAt, r.cfg, r.now);
  const text = [l.name, itemsText(lang, open), due].filter(Boolean).join(' · ');
  const ids = requestIds(l.id);
  if (mode !== 'push') {
    const card = {
      kind: 'notice', title: push.t(lang, 'card.shop_title'), text,
      actions: ids ? [{ actionId: ids.take, label: push.t(lang, 'card.shop_take') }, { actionId: ids.decline, label: push.t(lang, 'card.shop_decline') }] : [],
    };
    const res = await messenger.sendCardTo(gc, r.fam, r.cfg, r.now, mode, card, r.me.userId, userId);
    if (res.ok) return { via: res.via, ok: true, code: null };
  }
  const actions = ids ? [
    { type: 'quick_action', label: push.t(lang, 'card.shop_take').slice(0, 24), plugin: 'gatecontrol-familie', id: ids.take },
    { type: 'quick_action', label: push.t(lang, 'card.shop_decline').slice(0, 24), plugin: 'gatecontrol-familie', id: ids.decline },
  ] : [];
  const sent = await push.send(gc, {
    topic: 'shopping', users: [userId], priority: 'normal', collapseKey: `assign:${l.id}`, ttl: 12 * 3600,
    title: push.t(lang, 'shopping.assign_title', { name: r.me.name }), body: text,
    data: { familie: { type: 'shopping_assigned', listId: l.id, by: r.me.userId }, ...(actions.length ? { actions } : {}) },
  });
  return { via: 'push', ok: !!sent.sent, code: sent.sent ? null : (sent.error || 'failed') };
}

/** POST shopping/lists/<id>/assign (inside a transaction; the card / push after the commit through r.after) */
async function assign(gc, r, listId) {
  if (typeof listId !== 'string' || !ID_RE.test(listId)) throw fail('not_found');
  const l = await getList(gc, listId);
  if (!l || l.deleted) throw fail('not_found');
  const b = r.body || {};
  if (b.userId === undefined) throw fail('invalid', { field: 'userId' });
  if (b.userId === null) {
    await store.run(gc, 'UPDATE shop_lists SET assignee_id = NULL, assigned_by = NULL, assigned_at = NULL, due_at = NULL, assign_state = NULL, assign_notify = NULL, updated_at = ? WHERE id = ?', [r.now, listId]);
    return { list: listView(await getList(gc, listId)), notified: null };
  }
  const userId = posInt(b.userId);
  if (!userId || !r.fam.byId.has(userId)) throw fail('invalid', { field: 'userId' });
  let dueAt = null;
  if (b.dueAt != null && b.dueAt !== '') {
    dueAt = parseIso(b.dueAt);
    if (dueAt == null) throw fail('invalid', { field: 'dueAt' });
  }
  const mode = b.notify === undefined || b.notify === null ? r.cfg.shoppingNotify : b.notify;
  if (!SHOPPING_NOTIFY.includes(mode)) throw fail('invalid', { field: 'notify' });
  await store.run(gc, `UPDATE shop_lists SET assignee_id = ?, assigned_by = ?, assigned_at = ?, due_at = ?, assign_state = 'open', assign_notify = ?, updated_at = ? WHERE id = ?`,
    [userId, r.me.userId, r.now, dueAt, mode, r.now, listId]);
  const open = (await store.one(gc, 'SELECT COUNT(*) AS n FROM shop_items WHERE list_id = ? AND deleted = 0 AND checked = 0', [listId])).n;
  const row = await getList(gc, listId);
  if (userId !== r.me.userId && Array.isArray(r.after)) r.after.push(async () => ({ notified: await ask(gc, r, row, userId, dueAt, mode, open) }));
  return { list: listView(row), notified: null };
}

/** The open requests asked of `userId` (quick actions): [{ id, name, open, dueAt, by }] */
async function requestsOf(gc, userId) {
  return store.all(gc, `SELECT l.id, l.name, l.due_at, l.assigned_by, (SELECT COUNT(*) FROM shop_items i WHERE i.list_id = l.id AND i.deleted = 0 AND i.checked = 0) AS open
    FROM shop_lists l WHERE l.deleted = 0 AND l.assignee_id = ? AND l.assign_state = 'open' ORDER BY l.assigned_at`, [userId]);
}

/**
 * „Übernehmen“ / „Heute nicht“ (inside a transaction): the request of `listId` answered by `userId` → the list row, or
 * null when it is no open request of that person. The one who asked is told (pushes).
 */
async function answer(gc, fam, cfg, now, listId, userId, take, pushes) {
  const l = await getList(gc, listId);
  if (!l || l.deleted || l.assignee_id !== userId || l.assign_state !== 'open') return null;
  await store.run(gc, 'UPDATE shop_lists SET assign_state = ?, updated_at = ? WHERE id = ?', [take ? 'taken' : 'declined', now, listId]);
  const me = fam.byId.get(userId);
  if (l.assigned_by && l.assigned_by !== userId && fam.byId.has(l.assigned_by)) {
    pushes.push({
      topic: 'shopping', users: [l.assigned_by], priority: 'normal', collapseKey: `assign:${listId}`, ttl: 12 * 3600,
      title: push.t(cfg.lang, take ? 'shopping.taken' : 'shopping.declined', { name: me ? me.name : '', list: l.name }),
      data: { familie: { type: take ? 'shopping_taken' : 'shopping_declined', listId, userId } },
    });
  }
  return getList(gc, listId);
}

/** One list with its open items (wall view): `listId` or, when it is gone or empty, the first list. */
async function wallList(gc, listId) {
  const lists = await summary(gc);
  const l = lists.find((x) => x.id === listId) || lists[0] || null;
  if (!l) return { list: null, lists, items: [], open: 0 };
  const items = await store.all(gc, 'SELECT * FROM shop_items WHERE list_id = ? AND deleted = 0 AND checked = 0 ORDER BY created_at', [l.id]);
  return { list: { id: l.id, name: l.name, icon: l.icon }, lists, items: items.map((x) => ({ id: x.id, text: x.text, qty: x.qty || null })), open: items.length };
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

module.exports = {
  get, summary, wallList, applyOps, going, goingNow, purge, assign, answer, requestsOf, requestIds, itemsText, dueText, ID_RE, MAX_OPS, TOMBSTONE_DAYS, GOING_GAP_MS,
};
