'use strict';

// Who reminds of a deadline (since 1.30.0): Drive itself, as ever — or „Notizen & Aufgaben“ (gatecontrol-notizen ≥ 1.7.0),
// when the administrator chose it (Einstellungen › Plugins › Drive › „Fristen erinnert“, setting deadline_reminders:
// 'drive' — the default, nothing changes — | 'notizen').
//
// Nothing moves: the deadline stays at its file, the person's reminder (doc_reminders: days before, when) stays here and
// is set and removed here. With 'notizen' Drive hands its open reminders to the hub, which rings them as tasks with
// „Erledigt“ / „Später“ — and Drive sends no notification of its own for what the hub took (doc_reminders.handed_at).
//
//   hand over   gatecontrol-notizen:deadline_reminders { v: 1, reminders: [{ id: 'deadline:<id>', userId, at, daysBefore,
//               sent }] } — ALL reminders the hub has or may have, each time (≤ MAX, the next ones first): of deadlines
//               that are not ticked off (one the hub has stays named for a day after, as the item does: the hub's
//               task is done by then, whichever of the two messages comes first), of live files outside a vault the
//               person still reads, in the days Drive reports as items (notizen.js WINDOW_BACK / WINDOW_AHEAD). A reminder due within MARGIN_MS that the hub
//               does not have yet stays Drive's own. → { ok, taken, rejected: ['<deadline id>:<user id>'] } — what is
//               not rejected is the hub's (handed_at); what the list no longer names is no longer.
//               Sent when the list changed (at most every INTERVAL_MS, a few seconds after a person changed a
//               reminder), every REFRESH_MS anyway, and again after RETRY_MS while the hub rejected something.
//   claim       service deadline_claim { v: 1, id, userId } (only the hub calls) → { ok, send } — the hub asks before the
//               first ring of a reminder. send: true marks it sent here (asked twice: the same answer); send: false —
//               it is not the hub's (Drive reminds itself, did so already, the deadline is ticked off, the file is
//               gone, in a vault or no longer the person's to read).
//
// So a reminder comes from exactly one side: Drive sends what is not handed over, the hub what Drive lets it claim.
// The way back: the setting on 'drive' — everything is Drive's again (the hub is told with an empty list); the hub
// stopped, removed or older — the service is not there, Drive sends what comes due itself. A reminder that came due
// while it was the hub's and is older than LATE_MAX is not sent after the fact.
// A vault's file has no deadline and no reminder (deadlines.js reach); should a row be left, it is never handed over.

const crypto = require('node:crypto');
const store = require('./store');
const { day } = require('./util');

const HUB = 'gatecontrol-notizen';
const PUT = 'deadline_reminders';
const CLAIM = 'deadline_claim';
const SETTING = 'deadline_reminders';
const KEY = 'deadline_hub';
const DAY = 86400000;
const WINDOW_BACK = 7;        // as notizen.js: the days Drive reports as items of the hub
const WINDOW_AHEAD = 180;
const MAX = 500;
const MARGIN_MS = 5 * 60000;
const INTERVAL_MS = 120000;
const REFRESH_MS = 6 * 3600000;
const RETRY_MS = 600000;
const DEBOUNCE_MS = 6000;     // after the items of the same change went out (todohub.js: 5 s)
const LATE_MAX = 24 * 3600000;
const ID_RE = /^deadline:(\d{1,15})$/;

/** 'notizen' | 'drive' — the administrator's choice. */
async function mode(gc) {
  let all = null;
  try { all = await gc.settings.all(); } catch { all = null; }
  return all && all[SETTING] === 'notizen' ? 'notizen' : 'drive';
}

/** Is the hub's service there now (asks nobody)? */
async function available(gc) {
  if (!gc.services || typeof gc.services.available !== 'function' || typeof gc.services.call !== 'function') return false;
  try { return (await gc.services.available(HUB, PUT)) === true; } catch { return false; }
}

/** Does the hub ring what it took — the choice is 'notizen' and its service is there? */
const active = async (gc) => (await mode(gc)) === 'notizen' && await available(gc);

/** Everything is Drive's again; what came due long ago while it was the hub's is not sent after the fact. */
async function takeBack(gc, now) {
  await store.run(gc, 'UPDATE doc_reminders SET sent_at = at WHERE handed_at IS NOT NULL AND sent_at IS NULL AND at < ?', [now - LATE_MAX]);
  await store.run(gc, 'UPDATE doc_reminders SET handed_at = NULL WHERE handed_at IS NOT NULL');
}

/** asPerson(gc, uid, now) → the person's context (index.js personContext) or null. */
function create(asPerson) {
  const state = { last: 0, timer: null };

  const memory = async (gc) => { try { const m = await gc.storage.get(KEY); return m && typeof m === 'object' ? m : null; } catch { return null; } };
  const remember = async (gc, m) => { try { await gc.storage.set(KEY, m); } catch { /* best effort */ } };

  /** The list for the hub → [{ row, entry }] (see the top). */
  async function collect(gc, now) {
    const rows = await store.all(gc, `SELECT r.deadline_id, r.user_id, r.days_before, r.at, r.sent_at, r.handed_at, n.area_id FROM doc_reminders r
      JOIN doc_deadlines d ON d.id = r.deadline_id CROSS JOIN nodes n ON n.id = d.node_id
      WHERE (d.done_at IS NULL OR d.done_at > ?) AND n.deleted_at IS NULL AND n.vault_id IS NULL AND d.date >= ? AND d.date <= ?
        AND (r.handed_at IS NOT NULL OR (d.done_at IS NULL AND r.sent_at IS NULL AND r.at > ?)) ORDER BY r.at, r.deadline_id, r.user_id LIMIT ?`,
    [now - DAY, day(now - WINDOW_BACK * DAY), day(now + WINDOW_AHEAD * DAY), now + MARGIN_MS, MAX]);
    const reads = new Map(); // user id → Set(area id) | null
    const out = [];
    for (const r of rows) {
      if (!reads.has(r.user_id)) {
        let ctx = null;
        try { ctx = await asPerson(gc, r.user_id, now); } catch { ctx = null; }
        reads.set(r.user_id, ctx ? new Set((await ctx.visible()).map((v) => v.area.id)) : null);
      }
      const areas = reads.get(r.user_id);
      if (!areas || !areas.has(r.area_id)) continue;
      out.push({ row: r, entry: { id: `deadline:${r.deadline_id}`, userId: r.user_id, at: r.at, daysBefore: r.days_before, sent: r.sent_at != null } });
    }
    return out;
  }

  /** The background run (and `soon`): the list to the hub when it is due → 'sent' | 'refused' | 'back' | null (nothing to do). Never throws. */
  async function sync(gc, now = Date.now(), force = false) {
    try {
      if (!force && now - state.last < INTERVAL_MS) return null;
      state.last = now;
      const mem = await memory(gc);
      const want = await mode(gc);
      const there = await available(gc);
      if (want !== 'notizen') {
        // the way back: everything is Drive's again, and the hub is told so (when it is there — else when it comes)
        if (!mem) return null;
        await takeBack(gc, now);
        if (!there) return 'back';
        try {
          const res = await gc.services.call({ plugin: HUB, service: PUT, payload: { v: 1, reminders: [] } });
          if (res && res.ok === true) await remember(gc, null);
        } catch { /* told with the next run */ }
        return 'back';
      }
      if (!there) return null;
      const list = await collect(gc, now);
      const payload = { v: 1, reminders: list.map((x) => x.entry) };
      const hash = crypto.createHash('sha1').update(JSON.stringify(payload.reminders)).digest('hex');
      const age = mem && Number.isFinite(mem.at) ? now - mem.at : Infinity;
      const due = !mem || age > REFRESH_MS || (mem.refused || mem.pending ? age > RETRY_MS : mem.hash !== hash) || (force && mem.hash !== hash);
      if (!due) return null;
      // nothing to hand over and nothing handed over before: the hub need not hear of it
      if (!list.length && (!mem || mem.empty)) { await remember(gc, { hash, at: now, empty: true }); return null; }
      let res = null;
      try { res = await gc.services.call({ plugin: HUB, service: PUT, payload }); } catch (e) {
        gc.log.warn('deadline reminders to the hub failed', (e && e.code) || 'error');
        return null;
      }
      if (!res || res.ok !== true) {
        // the hub does not take them (its source Drive is off, it cannot ask Drive back): Drive reminds itself
        await takeBack(gc, now);
        await remember(gc, { hash, at: now, refused: true });
        return 'refused';
      }
      const rejected = new Set(Array.isArray(res.rejected) ? res.rejected.filter((x) => typeof x === 'string') : []);
      const named = new Set();
      for (const { row } of list) {
        const key = `${row.deadline_id}:${row.user_id}`;
        named.add(key);
        if (rejected.has(key)) {
          if (row.handed_at != null) await store.run(gc, 'UPDATE doc_reminders SET handed_at = NULL WHERE deadline_id = ? AND user_id = ?', [row.deadline_id, row.user_id]);
        } else if (row.handed_at == null) {
          await store.run(gc, 'UPDATE doc_reminders SET handed_at = ? WHERE deadline_id = ? AND user_id = ?', [now, row.deadline_id, row.user_id]);
        }
      }
      // what the list no longer names (ticked off, the file gone, no longer read) is not the hub's any more
      for (const r of await store.all(gc, 'SELECT deadline_id, user_id FROM doc_reminders WHERE handed_at IS NOT NULL')) {
        if (!named.has(`${r.deadline_id}:${r.user_id}`)) await store.run(gc, 'UPDATE doc_reminders SET handed_at = NULL WHERE deadline_id = ? AND user_id = ?', [r.deadline_id, r.user_id]);
      }
      await remember(gc, { hash, at: now, pending: rejected.size > 0, empty: !list.length });
      return 'sent';
    } catch (e) {
      gc.log.warn('deadline reminders to the hub failed', (e && (e.code || e.message)) || 'error');
      return null;
    }
  }

  /** A person changed a reminder or ticked a deadline off: the hub hears of it in a few seconds. */
  function soon(gc) {
    if (state.timer) return;
    state.timer = setTimeout(() => { state.timer = null; sync(gc, Date.now(), true); }, DEBOUNCE_MS);
    if (typeof state.timer.unref === 'function') state.timer.unref();
  }

  function stop() {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
  }

  /** The service deadline_claim (see the top) → the answer, or undefined when `call.name` is another service. */
  async function service(gc, call, now = Date.now()) {
    const c = call && typeof call === 'object' ? call : {};
    if (c.name !== CLAIM) return undefined;
    if (c.caller !== HUB) return { ok: false, code: 'forbidden' };
    const p = c.payload && typeof c.payload === 'object' && !Array.isArray(c.payload) ? c.payload : {};
    const m = typeof p.id === 'string' ? ID_RE.exec(p.id) : null;
    const uid = c.user && Number.isSafeInteger(c.user.id) && c.user.id > 0 ? c.user.id : null;
    if (p.v !== 1 || !m || !uid || p.userId !== uid) return { ok: false, code: 'invalid' };
    const no = { ok: true, send: false };
    try {
      if ((await mode(gc)) !== 'notizen') return no;
      const r = await store.one(gc, `SELECT r.handed_at, d.done_at, n.area_id, n.deleted_at, n.vault_id FROM doc_reminders r JOIN doc_deadlines d ON d.id = r.deadline_id
        JOIN nodes n ON n.id = d.node_id WHERE r.deadline_id = ? AND r.user_id = ?`, [Number(m[1]), uid]);
      if (!r || r.handed_at == null || r.done_at != null || r.deleted_at != null || r.vault_id) return no;
      const ctx = await asPerson(gc, uid, now);
      if (!ctx || !(await ctx.visible()).some((v) => v.area.id === r.area_id)) return no;
      await store.run(gc, 'UPDATE doc_reminders SET sent_at = COALESCE(sent_at, ?) WHERE deadline_id = ? AND user_id = ?', [now, Number(m[1]), uid]);
      return { ok: true, send: true };
    } catch (e) {
      gc.log.warn('deadline claim failed', (e && (e.code || e.message)) || 'error');
      return { ok: false, code: 'failed' };
    }
  }

  return { state, sync, soon, stop, service, collect };
}

module.exports = { HUB, PUT, CLAIM, SETTING, KEY, MAX, MARGIN_MS, INTERVAL_MS, REFRESH_MS, RETRY_MS, LATE_MAX, WINDOW_BACK, WINDOW_AHEAD, mode, available, active, takeBack, create };
