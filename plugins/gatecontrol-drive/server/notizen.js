'use strict';

// Drive as a source of „Notizen & Aufgaben“ (1.27.0, gatecontrol-notizen; contract v1, server/todohub.js): the deadlines
// of documents (deadlines.js) as its items —
//
//   { id: 'deadline:<id>', kind: 'deadline', title: what to do („Kfz-Versicherung kündigen“, as in the calendar),
//     subtitle: the file's name, due: the day (allDay), users: every person with a seat who reads the file's area,
//     area: 'work' for a team folder, else 'private', group: the area (area:<id>), meta: { type: the kind, amount: „84,20 €“
//     for a payment when the AI read one }, done: ticked off (POST deadlines/<id>/done or in the hub), canComplete: true,
//     open: node/<fileId> }
//
// Deadlines from WINDOW_BACK days ago (overdue) to WINDOW_AHEAD days ahead of live files outside a vault, at most
// MAX_ITEMS; one ticked off longer than a day ago is not „zu tun“ any more. Who reads an area is worked out like the
// apps do (the person's context, areas.visible) for every seat — so the background run compares at most every
// INTERVAL_MS. Without the hub nothing is sent.

const store = require('./store');
const deadlines = require('./deadlines');
const todohub = require('./todohub');
const { day } = require('./util');

const PLUGIN = 'gatecontrol-drive';
const DAY = 86400000;
const WINDOW_BACK = 7;
const WINDOW_AHEAD = 180;
const MAX_ITEMS = 1000;
const INTERVAL_MS = 120000;

function money(amount, currency, lang) {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || !currency) return null;
  try { return new Intl.NumberFormat(lang === 'en' ? 'en-GB' : 'de-DE', { style: 'currency', currency }).format(amount); } catch { return null; }
}

/**
 * The source. asPerson(gc, uid, now) → the person's context (index.js personContext: seat, licence, visible areas) or
 * null; areaLabel(ctx, area) → the area's label in that person's language.
 */
function create(asPerson, areaLabel) {
  /** Who reads which area: Map area id → { area, users: [uid], ctx (the first reader's) }. */
  async function readers(gc, now) {
    const out = new Map();
    for (const s of await store.all(gc, 'SELECT user_id FROM seats ORDER BY user_id')) {
      let ctx = null;
      try { ctx = await asPerson(gc, s.user_id, now); } catch { ctx = null; }
      if (!ctx) continue;
      for (const v of await ctx.visible()) {
        let e = out.get(v.area.id);
        if (!e) { e = { area: v.area, users: [], ctx }; out.set(v.area.id, e); }
        e.users.push(s.user_id);
      }
    }
    return out;
  }

  async function collect(gc, now) {
    const areas = await readers(gc, now);
    if (!areas.size) return [];
    const ids = [...areas.keys()];
    const from = day(now - WINDOW_BACK * DAY);
    const to = day(now + WINDOW_AHEAD * DAY);
    const rows = [];
    // from the deadlines of these days to their files (CROSS JOIN, 1.29.1 — as deadlines.js FROM), not every node of the areas
    for (const part of store.chunks(ids)) {
      rows.push(...await store.all(gc, `SELECT d.id AS dl_id, d.kind AS dl_kind, d.date AS dl_date, d.label AS dl_label, d.found_at AS dl_found,
        d.done_at AS dl_done_at, n.id, n.name, n.area_id, n.rev FROM doc_deadlines d CROSS JOIN nodes n ON n.id = d.node_id
        WHERE n.area_id IN (${store.marks(part.length)}) AND n.deleted_at IS NULL AND n.vault_id IS NULL AND d.date >= ? AND d.date <= ?
          AND (d.done_at IS NULL OR d.done_at > ?) ORDER BY d.date, d.id LIMIT ?`, [...part, from, to, now - DAY, MAX_ITEMS]));
    }
    rows.sort((a, b) => (a.dl_date < b.dl_date ? -1 : a.dl_date > b.dl_date ? 1 : a.dl_id - b.dl_id));
    const list = rows.slice(0, MAX_ITEMS);
    const docs = await deadlines.docsOf(gc, list);
    const out = [];
    for (const r of list) {
      const a = areas.get(r.area_id);
      if (!a) continue;
      const lang = a.ctx.lang;
      const doc = docs.get(r.id) || null;
      const d = { id: r.dl_id, kind: r.dl_kind, date: r.dl_date, label: r.dl_label };
      const amount = r.dl_kind === 'payment' && doc ? money(doc.amount, doc.currency, lang) : null;
      out.push({
        id: `deadline:${r.dl_id}`, kind: 'deadline', title: deadlines.calendarTitle(lang, d, r, doc), subtitle: r.name,
        due: r.dl_date, allDay: true, area: a.area.kind === 'team' ? 'work' : 'private', users: a.users,
        important: false, done: r.dl_done_at != null, canComplete: true,
        group: { id: `area:${a.area.id}`, label: areaLabel(a.ctx, a.area) },
        meta: { type: r.dl_kind, ...(amount ? { amount } : {}) },
        open: { plugin: PLUGIN, route: `node/${r.id}` },
        updatedAt: Math.max(r.dl_found || 0, r.dl_done_at || 0),
      });
    }
    return out;
  }

  /** Ticking a deadline off (or not) as that person — they must still read the file. */
  async function complete(gc, user, item, done, now) {
    const ctx = await asPerson(gc, user.id, now);
    if (!ctx) return { ok: false, code: 'forbidden' };
    try {
      await deadlines.setDone(ctx, item.id.split(':')[1], done);
    } catch (e) {
      if (e && (e.code === 'not_found' || e.code === 'encrypted' || e.code === 'forbidden')) return { ok: false, code: e.code === 'encrypted' ? 'read_only' : e.code };
      throw e;
    }
    return { ok: true };
  }

  return todohub.create({ plugin: PLUGIN, collect, complete, tx: (gc, fn) => store.tx(gc, fn), intervalMs: INTERVAL_MS });
}

module.exports = { create, WINDOW_BACK, WINDOW_AHEAD, MAX_ITEMS, INTERVAL_MS };
