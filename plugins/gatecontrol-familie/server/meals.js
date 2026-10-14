'use strict';

// Meal plan — "Essensplan" (module meals, default off). Every member reads and plans.
//
//   GET    meals?week=YYYY-Www                   (default: this ISO week) → { week, days: [{ date, lunch, dinner }] }
//   PUT    meals/<date>/<slot>                   { title ≤ 60, note ≤ 200, cook: userId|null, ingredients: [text ≤ 60] }
//   DELETE meals/<date>/<slot>
//   POST   meals/<date>/<slot>/to-shopping       { listId } → the ingredients as shopping items
//
// slot: 'lunch' | 'dinner'. A meal: { title, note, cook, ingredients,
// updatedAt, updatedBy } or null. to-shopping skips an ingredient already
// open on that list (case-insensitive, open = not checked and not deleted)
// and duplicates among the ingredients → { added, skipped, itemIds }.
// Meals are kept 90 days after their date.

const crypto = require('node:crypto');
const store = require('./store');
const tz = require('./tz');
const shopping = require('./shopping');
const { fail, posInt, text, multiline, date, iso, parseJson, line } = require('./util');

const SLOTS = ['lunch', 'dinner'];
const TITLE_MAX = 60;
const NOTE_MAX = 200;
const INGREDIENT_MAX = 60;
const MAX_INGREDIENTS = 40;
const KEEP_DAYS = 90;
const WEEK_RE = /^(\d{4})-W(\d{2})$/;

const isoWd = (d) => ((tz.weekday(d) + 6) % 7) + 1;

/** The Monday of ISO week 1 of `y`. */
function week1(y) {
  const jan4 = tz.dateStr(y, 1, 4);
  return tz.addDays(jan4, -(isoWd(jan4) - 1));
}

/** 'YYYY-MM-DD' → 'YYYY-Www' */
function weekOf(d) {
  const thu = tz.addDays(d, 4 - isoWd(d));
  const y = tz.parseDate(thu).y;
  return `${y}-W${String(Math.floor(tz.diffDays(week1(y), thu) / 7) + 1).padStart(2, '0')}`;
}

/** 'YYYY-Www' → its Monday (invalid → 'invalid'). */
function mondayOf(w) {
  const m = WEEK_RE.exec(String(w || ''));
  if (!m) throw fail('invalid', { field: 'week' });
  const y = +m[1];
  const n = +m[2];
  const monday = tz.addDays(week1(y), (n - 1) * 7);
  if (n < 1 || weekOf(monday) !== `${m[1]}-W${m[2]}`) throw fail('invalid', { field: 'week' });
  return monday;
}

const mealView = (x) => (x ? {
  title: x.title, note: x.note || '', cook: x.cook_id == null ? null : x.cook_id, ingredients: parseJson(x.ingredients_json, []),
  updatedAt: iso(x.updated_at), updatedBy: x.updated_by == null ? null : x.updated_by,
} : null);

async function day(gc, d) {
  const rows = await store.all(gc, 'SELECT * FROM meals WHERE date = ?', [d]);
  const of = (s) => mealView(rows.find((x) => x.slot === s));
  return { date: d, lunch: of('lunch'), dinner: of('dinner') };
}

/** GET meals?week= */
async function get(gc, r) {
  const q = (r.query || {}).week;
  const week = q == null || q === '' ? weekOf(r.today) : String(q);
  const monday = mondayOf(week);
  const sunday = tz.addDays(monday, 6);
  const rows = await store.all(gc, 'SELECT * FROM meals WHERE date >= ? AND date <= ?', [monday, sunday]);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = tz.addDays(monday, i);
    const of = (s) => mealView(rows.find((x) => x.date === d && x.slot === s));
    days.push({ date: d, lunch: of('lunch'), dinner: of('dinner') });
  }
  return { week, days };
}

function slotOf(v) {
  if (!SLOTS.includes(v)) throw fail('not_found');
  return v;
}

function ingredients(v) {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > MAX_INGREDIENTS) throw fail('invalid', { field: 'ingredients' });
  return v.map((x) => {
    const s = line(x);
    if (!s || s.length > INGREDIENT_MAX) throw fail('invalid', { field: 'ingredients' });
    return s;
  });
}

/** PUT meals/<date>/<slot> */
async function put(gc, r, rawDate, rawSlot) {
  const d = date(rawDate);
  const slot = slotOf(rawSlot);
  const b = r.body || {};
  const title = text(b.title, TITLE_MAX);
  let note = '';
  if (b.note != null) {
    note = multiline(b.note);
    if (note == null || note.length > NOTE_MAX) throw fail('invalid', { field: 'note' });
  }
  let cook = null;
  if (b.cook != null) {
    cook = posInt(b.cook);
    if (!cook || !r.fam.byId.has(cook)) throw fail('invalid', { field: 'cook' });
  }
  const ing = ingredients(b.ingredients);
  await store.run(gc, `INSERT INTO meals (date, slot, title, note, cook_id, ingredients_json, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date, slot) DO UPDATE SET title = excluded.title, note = excluded.note, cook_id = excluded.cook_id, ingredients_json = excluded.ingredients_json,
      updated_at = excluded.updated_at, updated_by = excluded.updated_by`, [d, slot, title, note, cook, JSON.stringify(ing), r.now, r.me.userId]);
  return { date: d, slot, meal: mealView(await store.one(gc, 'SELECT * FROM meals WHERE date = ? AND slot = ?', [d, slot])) };
}

/** DELETE meals/<date>/<slot> */
async function remove(gc, r, rawDate, rawSlot) {
  const d = date(rawDate);
  const slot = slotOf(rawSlot);
  const res = await store.run(gc, 'DELETE FROM meals WHERE date = ? AND slot = ?', [d, slot]);
  if (!res.changes) throw fail('not_found');
  return {};
}

/** POST meals/<date>/<slot>/to-shopping { listId } (needs the module shopping) */
async function toShopping(gc, r, rawDate, rawSlot) {
  if (!r.cfg.modules.shopping) throw fail('module_off');
  const d = date(rawDate);
  const slot = slotOf(rawSlot);
  const meal = await store.one(gc, 'SELECT * FROM meals WHERE date = ? AND slot = ?', [d, slot]);
  if (!meal) throw fail('not_found');
  const listId = (r.body || {}).listId;
  if (typeof listId !== 'string' || !shopping.ID_RE.test(listId)) throw fail('invalid', { field: 'listId' });
  const list = await store.one(gc, 'SELECT deleted FROM shop_lists WHERE id = ?', [listId]);
  if (!list || list.deleted) throw fail('not_found');
  const open = await store.all(gc, 'SELECT text FROM shop_items WHERE list_id = ? AND deleted = 0 AND checked = 0', [listId]);
  const seen = new Set(open.map((x) => x.text.trim().toLowerCase()));
  const ops = [];
  let skipped = 0;
  for (const t of parseJson(meal.ingredients_json, [])) {
    const s = String(t).slice(0, 120);
    const key = s.trim().toLowerCase();
    if (!key || seen.has(key)) { skipped++; continue; }
    seen.add(key);
    ops.push({ op: 'item_add', id: crypto.randomUUID(), listId, text: s });
  }
  if (ops.length) {
    const res = await shopping.applyOps(gc, { ops }, { id: r.me.userId }, r.now);
    if (res.rejected.length) throw fail('invalid');
  }
  return { added: ops.length, skipped, itemIds: ops.map((o) => o.id) };
}

/** Today's meals (overview, wall). */
function today(gc, r) {
  return day(gc, r.today);
}

async function purge(gc, cfg, now) {
  await store.run(gc, 'DELETE FROM meals WHERE date < ?', [tz.addDays(tz.localDate(now, cfg.tz), -KEEP_DAYS)]);
}

module.exports = { SLOTS, weekOf, mondayOf, get, put, remove, toShopping, today, purge };
