'use strict';

// Wishlists — "Wunschlisten" (module wishes, default on).
//
//   GET    wishes[?gotIt=1]          every member's list: { lists: [{ ownerId, name, color, items }] }
//   POST   wishes                    { title, url, priceCents, note, occasion, ownerId? } (ownerId: parents for a child)
//   PATCH  wishes/<id>               the owner (parents also for a child): the fields, sort, gotIt
//   DELETE wishes/<id>               the owner (parents also for a child)
//   POST   wishes/<id>/reserve       anyone but the owner: "Ich besorge das"
//   POST   wishes/<id>/unreserve     whoever reserved it: "freigeben"
//
// The surprise stays: for the caller's OWN items reservedBy / reservedAt are
// always null and reservedByMe false — in every answer, also after an edit.
// An item marked gotIt (after the occasion) is hidden unless ?gotIt=1.

const store = require('./store');
const { fail, posInt, text, optText, multiline, bool, intIn, iso } = require('./util');

const OCCASIONS = ['birthday', 'christmas', 'other'];
const TITLE_MAX = 80;
const URL_MAX = 300;
const NOTE_MAX = 200;
const MAX_ITEMS = 200;
const MAX_PRICE = 10000000;

function view(row, viewerId) {
  const own = row.owner_id === viewerId;
  return {
    id: row.id, ownerId: row.owner_id, title: row.title, url: row.url || null, priceCents: row.price_cents == null ? null : row.price_cents,
    note: row.note || '', occasion: OCCASIONS.includes(row.occasion) ? row.occasion : null, sort: row.sort, createdAt: iso(row.created_at),
    reservedBy: own || row.reserved_by == null ? null : row.reserved_by,
    reservedAt: own || row.reserved_by == null ? null : iso(row.reserved_at),
    // addition: the caller reserved it (never true for the owner)
    reservedByMe: !own && row.reserved_by === viewerId,
    gotIt: !!row.got_it,
  };
}

/** https only, at most 300 characters; ''/null → null. */
function url(v) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || v.length > URL_MAX || /\s/.test(v.trim())) throw fail('invalid', { field: 'url' });
  let u;
  try { u = new URL(v.trim()); } catch { throw fail('invalid', { field: 'url' }); }
  if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) throw fail('invalid', { field: 'url' });
  return v.trim();
}

function note(v) {
  if (v == null) return '';
  const s = multiline(v);
  if (s == null || s.length > NOTE_MAX) throw fail('invalid', { field: 'note' });
  return s;
}

function occasion(v) {
  if (v == null || v === '') return null;
  if (!OCCASIONS.includes(v)) throw fail('invalid', { field: 'occasion' });
  return v;
}

function price(v) {
  if (v == null) return null;
  return intIn(v, 0, MAX_PRICE);
}

/** May the caller change `ownerId`'s list? The owner; parents also a child's. */
function mayEdit(r, ownerId) {
  if (ownerId === r.me.userId) return true;
  const o = r.fam.byId.get(ownerId);
  return r.me.role === 'parent' && !!o && o.role === 'child';
}

async function getRow(gc, r, raw) {
  const id = posInt(raw);
  const row = id ? await store.one(gc, 'SELECT * FROM wishes WHERE id = ?', [id]) : null;
  if (!row || !r.fam.byId.has(row.owner_id)) throw fail('not_found');
  return row;
}

/** GET wishes */
async function get(gc, r) {
  const all = ['1', 'true'].includes(String((r.query || {}).gotIt || ''));
  const rows = await store.all(gc, `SELECT * FROM wishes ${all ? '' : 'WHERE got_it = 0'} ORDER BY owner_id, sort, id`);
  return {
    lists: r.fam.list.map((m) => ({
      ownerId: m.userId, name: m.name, color: m.color,
      items: rows.filter((x) => x.owner_id === m.userId).map((x) => view(x, r.me.userId)),
    })),
  };
}

/** POST wishes */
async function create(gc, r) {
  const b = r.body || {};
  const ownerId = b.ownerId == null ? r.me.userId : posInt(b.ownerId);
  if (!ownerId || !r.fam.byId.has(ownerId)) throw fail('invalid', { field: 'ownerId' });
  if (!mayEdit(r, ownerId)) throw fail('forbidden');
  const n = (await store.one(gc, 'SELECT COUNT(*) AS n, COALESCE(MAX(sort), -1) AS s FROM wishes WHERE owner_id = ?', [ownerId]));
  if (n.n >= MAX_ITEMS) throw fail('too_many');
  const res = await store.run(gc, `INSERT INTO wishes (owner_id, title, url, price_cents, note, occasion, sort, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [ownerId, text(b.title, TITLE_MAX), url(b.url), price(b.priceCents), note(b.note), occasion(b.occasion), n.s + 1, r.me.userId, r.now, r.now]);
  return { item: view(await store.one(gc, 'SELECT * FROM wishes WHERE id = ?', [res.lastInsertRowid]), r.me.userId) };
}

/** PATCH wishes/<id> */
async function update(gc, r, raw) {
  const row = await getRow(gc, r, raw);
  if (!mayEdit(r, row.owner_id)) throw fail('forbidden');
  const b = r.body || {};
  const f = {
    title: b.title !== undefined ? text(b.title, TITLE_MAX) : row.title,
    url: b.url !== undefined ? url(b.url) : row.url,
    price_cents: b.priceCents !== undefined ? price(b.priceCents) : row.price_cents,
    note: b.note !== undefined ? note(b.note) : row.note,
    occasion: b.occasion !== undefined ? occasion(b.occasion) : row.occasion,
    sort: b.sort !== undefined ? intIn(b.sort, 0, 9999) : row.sort,
    got_it: b.gotIt !== undefined ? (bool(b.gotIt) ? 1 : 0) : row.got_it,
  };
  await store.run(gc, 'UPDATE wishes SET title = ?, url = ?, price_cents = ?, note = ?, occasion = ?, sort = ?, got_it = ?, updated_at = ? WHERE id = ?',
    [f.title, f.url, f.price_cents, f.note, f.occasion, f.sort, f.got_it, r.now, row.id]);
  return { item: view(await store.one(gc, 'SELECT * FROM wishes WHERE id = ?', [row.id]), r.me.userId) };
}

/** DELETE wishes/<id> */
async function remove(gc, r, raw) {
  const row = await getRow(gc, r, raw);
  if (!mayEdit(r, row.owner_id)) throw fail('forbidden');
  await store.run(gc, 'DELETE FROM wishes WHERE id = ?', [row.id]);
  return {};
}

/** POST wishes/<id>/reserve — anyone but the owner. */
async function reserve(gc, r, raw) {
  const row = await getRow(gc, r, raw);
  if (row.owner_id === r.me.userId) throw fail('forbidden');
  if (row.got_it) throw fail('invalid');
  if (row.reserved_by != null && row.reserved_by !== r.me.userId) throw fail('already_taken');
  if (row.reserved_by == null) await store.run(gc, 'UPDATE wishes SET reserved_by = ?, reserved_at = ? WHERE id = ?', [r.me.userId, r.now, row.id]);
  return { item: view(await store.one(gc, 'SELECT * FROM wishes WHERE id = ?', [row.id]), r.me.userId) };
}

/** POST wishes/<id>/unreserve — whoever reserved it. */
async function unreserve(gc, r, raw) {
  const row = await getRow(gc, r, raw);
  if (row.owner_id === r.me.userId) throw fail('forbidden');
  if (row.reserved_by != null && row.reserved_by !== r.me.userId) throw fail('forbidden');
  if (row.reserved_by != null) await store.run(gc, 'UPDATE wishes SET reserved_by = NULL, reserved_at = NULL WHERE id = ?', [row.id]);
  return { item: view(await store.one(gc, 'SELECT * FROM wishes WHERE id = ?', [row.id]), r.me.userId) };
}

/** Overview: own open wishes and what the caller is getting for others. */
async function overview(gc, r) {
  const mine = (await store.one(gc, 'SELECT COUNT(*) AS n FROM wishes WHERE owner_id = ? AND got_it = 0', [r.me.userId])).n;
  const reserved = (await store.one(gc, 'SELECT COUNT(*) AS n FROM wishes WHERE reserved_by = ? AND owner_id != ? AND got_it = 0', [r.me.userId, r.me.userId])).n;
  return { mine, reservedByMe: reserved };
}

module.exports = { OCCASIONS, view, url, get, create, update, remove, reserve, unreserve, overview };
