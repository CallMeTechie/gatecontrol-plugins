'use strict';

// The shopping lists in „Notizen & Aufgaben“ (1.21.0; gatecontrol-notizen ≥ 1.4.0).
//
// Nothing moves by itself. A parent or the administrator looks at what would move (preview: „2 Einkaufslisten mit
// 14 Punkten“) and presses the button (move): Familie tells the hub who the family is (shopping_bind) and sends every
// list and item (shopping_put) — by their own ids, so a move done twice makes nothing twice. From then on the hub is
// where the lists live (mode 'hub'):
//
//   Familie → hub   a row changed in Familie (dirty, counted by server/shopping.js) goes there right after its commit, else with the
//                   background run (shopping_put; the hub writes a row only when it differs)
//   hub → Familie   the hub calls shopping_changed, Familie pulls (shopping_list: every family list, the items changed
//                   since) — at the latest every PULL_EVERY_MS. A row changed in Familie meanwhile is not overwritten:
//                   it goes to the hub next.
//
// Familie's own tables (shop_lists, shop_items, shop_going) stay the copy Familie shows — the app, the portal, the wall
// tablet, the cards in the chat — and keeps working on: the hub away → changes wait and go when it is back; the hub
// removed → Familie works on as before (where() says home 'familie'), nothing is lost. A hub that does not know the
// family any more (a fresh hub: not_found) rolls back: mode 'local', the lists are Familie's own again and the button
// is there again. „Zurückholen“ (back) does the same on purpose and tells the hub to let go (the lists stay there as
// ordinary shared lists). Without the move, or without the hub, nothing of this runs.
//
// „Ich gehe einkaufen“ and „Kannst du einkaufen gehen?“ stay Familie's (cards, pushes, quick actions): the hub hands
// them over with the service shopping_action.

const store = require('./store');
const tz = require('./tz');
const shopping = require('./shopping');
const push = require('./push');
const { fail, isKnown, iso, line, posInt } = require('./util');

const HUB = 'gatecontrol-notizen';
const SERVICES = ['shopping_bind', 'shopping_put', 'shopping_list'];
const STATE_KEY = 'notizen_shopping';
const PULL_EVERY_MS = 5 * 60000;
const AVAILABLE_TTL_MS = 60000;
const CALLS_MAX = 60;
const PAGES_MAX = 40;
const PAYLOAD_MAX = 11000;
const NAME_MAX = 40;
const TEXT_MAX = 120;
const QTY_MAX = 40;
const ICON_MAX = 32;
const HOUR = 3600000;

const state = { st: null, hub: null, hubAt: 0, running: null, timer: null, noTimer: false, warned: new Set() };

function reset() {
  if (state.timer) clearTimeout(state.timer);
  Object.assign(state, { st: null, hub: null, hubAt: 0, running: null, timer: null, warned: new Set() });
}

const fresh = () => ({ mode: 'local', members: '', since: 0, pulledAt: 0, pending: false, migratedAt: null, by: null });

async function load(gc) {
  if (state.st) return state.st;
  let v = null;
  try { v = await gc.storage.get(STATE_KEY); } catch { v = null; }
  state.st = v && typeof v === 'object' && (v.mode === 'hub' || v.mode === 'local') ? { ...fresh(), ...v } : fresh();
  return state.st;
}

async function save(gc) {
  try { await gc.storage.set(STATE_KEY, state.st); } catch (e) { warn(gc, 'state', 'shopping: state not saved', (e && e.code) || 'error'); }
}

function warn(gc, key, ...a) {
  if (state.warned.has(key)) return;
  state.warned.add(key);
  try { gc.log.warn(...a); } catch { /* no log */ }
}

/** Have the shopping lists moved into the hub (mode 'hub')? */
async function inHub(gc) {
  return (await load(gc)).mode === 'hub';
}

/** Are the hub's shopping services there (asks nobody; known answers kept a minute)? */
async function hubThere(gc, now = Date.now()) {
  if (state.hub != null && now - state.hubAt < AVAILABLE_TTL_MS && now >= state.hubAt) return state.hub;
  let on = false;
  if (gc.services && typeof gc.services.available === 'function' && typeof gc.services.call === 'function') {
    try {
      on = true;
      for (const s of SERVICES) if ((await gc.services.available(HUB, s)) !== true) { on = false; break; }
    } catch { on = false; }
  }
  state.hub = on;
  state.hubAt = now;
  return on;
}

class HubError extends Error { constructor(code, field) { super(code); this.code = code; this.field = field || null; } }

/** One call of the hub's shopping services → its answer; a refusal throws HubError(code), a host error its ERR_*. */
async function call(gc, budget, service, payload) {
  if (budget.n >= CALLS_MAX) throw new HubError('budget');
  budget.n++;
  const res = await gc.services.call({ plugin: HUB, service, payload: { v: 1, ...payload } });
  if (!res || res.ok !== true) throw new HubError((res && res.code) || 'failed', res && res.field);
  return res;
}

const membersKey = (fam) => fam.list.map((m) => `${m.userId}${m.role === 'parent' ? 'p' : ''}`).sort().join(',');
const famIds = (fam) => ({ members: fam.list.map((m) => m.userId).slice(0, 50), parents: fam.list.filter((m) => m.role === 'parent').map((m) => m.userId).slice(0, 50) });

async function bind(gc, fam, budget) {
  await call(gc, budget, 'shopping_bind', famIds(fam));
  state.st.members = membersKey(fam);
  await save(gc);
}

// ─── Familie → hub ───────────────────────────────

const ASSIGN_STATES = ['open', 'taken', 'declined'];

/** What only Familie knows of a list — who is asked, until when, who is on the way — as the hub shows it. */
async function familyOf(gc, r, now) {
  const going = await store.all(gc, 'SELECT user_id, at FROM shop_going WHERE list_id = ? AND at >= ? ORDER BY at DESC LIMIT 20', [r.id, now - HOUR]);
  return {
    assignee: r.assignee_id == null ? null : {
      userId: r.assignee_id, by: r.assigned_by == null ? null : r.assigned_by, at: iso(r.assigned_at), state: ASSIGN_STATES.includes(r.assign_state) ? r.assign_state : 'open', notify: r.assign_notify || null,
    },
    dueAt: iso(r.due_at), going: going.map((g) => ({ userId: g.user_id, at: iso(g.at) })),
  };
}

const listOut = async (gc, r, now) => ({ id: r.id, name: r.name, icon: r.icon || null, sort: r.sort, deleted: !!r.deleted, by: r.by_user || r.created_by || null, ...(await familyOf(gc, r, now)) });
const itemOut = (r) => ({
  id: r.id, listId: r.list_id, text: r.text, qty: r.qty || null, checked: !!r.checked, checkedBy: r.checked_by == null ? null : r.checked_by, deleted: !!r.deleted,
  createdBy: r.created_by == null ? null : r.created_by, createdAt: r.created_at, by: r.by_user || r.checked_by || r.created_by || null,
});

/** `rows` in parts whose JSON stays under the services' limit. */
function parts(rows, max) {
  const out = [];
  let cur = [];
  let size = 0;
  for (const r of rows) {
    const s = Buffer.byteLength(JSON.stringify(r), 'utf8') + 1;
    if (cur.length && (size + s > PAYLOAD_MAX || cur.length >= max)) { out.push(cur); cur = []; size = 0; }
    cur.push(r);
    size += s;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Every row changed in Familie since it was last in step goes to the hub → { lists, items } sent. */
async function pushChanges(gc, now, budget) {
  const sent = { lists: 0, items: 0 };
  for (let round = 0; round < 20; round++) {
    const rows = await store.all(gc, 'SELECT * FROM shop_lists INDEXED BY idx_shop_lists_dirty WHERE dirty > 0 ORDER BY sort, created_at LIMIT 100');
    if (!rows.length) break;
    const out = [];
    for (const r of rows) out.push(await listOut(gc, r, now));
    const was = new Map(rows.map((r) => [r.id, r.dirty]));
    for (const part of parts(out, 40)) {
      await call(gc, budget, 'shopping_put', { lists: part, items: [] });
      // in step — unless it changed again meanwhile (a refused row is not sent again either)
      await store.tx(gc, async () => { for (const l of part) await store.run(gc, 'UPDATE shop_lists SET synced_at = ?, dirty = MAX(0, dirty - ?) WHERE id = ?', [now, was.get(l.id), l.id]); });
      sent.lists += part.length;
    }
    if (rows.length < 100) break;
  }
  for (let round = 0; round < 50; round++) {
    const rows = await store.all(gc, 'SELECT * FROM shop_items INDEXED BY idx_shop_items_dirty WHERE dirty > 0 ORDER BY created_at, id LIMIT 200');
    if (!rows.length) break;
    const was = new Map(rows.map((r) => [r.id, r.dirty]));
    for (const part of parts(rows.map(itemOut), 60)) {
      await call(gc, budget, 'shopping_put', { lists: [], items: part });
      await store.tx(gc, async () => { for (const i of part) await store.run(gc, 'UPDATE shop_items SET synced_at = ?, dirty = MAX(0, dirty - ?) WHERE id = ?', [now, was.get(i.id), i.id]); });
      sent.items += part.length;
    }
    if (rows.length < 200) break;
  }
  return sent;
}

// ─── hub → Familie ───────────────────────────────

const getList = (gc, id) => store.one(gc, 'SELECT * FROM shop_lists WHERE id = ?', [id]);
const dirty = (r) => r.dirty > 0;
const text = (v, max) => (line(v || '') || '').slice(0, max);

/** A list of the hub onto Familie's copy → 'new' | 'back' | 'changed' | null. */
async function applyList(gc, fam, l, now) {
  if (!l || typeof l.id !== 'string' || !shopping.ID_RE.test(l.id)) return null;
  const name = text(l.name, NAME_MAX);
  if (!name) return null;
  const icon = text(l.icon, ICON_MAX) || null;
  const row = await getList(gc, l.id);
  if (!row) {
    const max = await store.one(gc, 'SELECT COALESCE(MAX(sort), -1) AS m FROM shop_lists');
    const by = posInt(l.ownerId) && fam.byId.has(l.ownerId) ? l.ownerId : null;
    await store.run(gc, 'INSERT INTO shop_lists (id, name, icon, sort, created_by, created_at, updated_at, deleted, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)',
      [l.id, name, icon, max.m + 1, by, Number.isSafeInteger(l.createdAt) && l.createdAt > 0 ? l.createdAt : now, now, now]);
    return 'new';
  }
  // changed in Familie after it was last in step: Familie's version goes to the hub next
  if (dirty(row)) return null;
  if (row.deleted) {
    await store.run(gc, 'UPDATE shop_lists SET name = ?, icon = ?, deleted = 0, updated_at = ?, synced_at = ? WHERE id = ?', [name, icon, now, now, l.id]);
    return 'back';
  }
  if (row.name === name && (row.icon || null) === icon) return null;
  await store.run(gc, 'UPDATE shop_lists SET name = ?, icon = ?, updated_at = ?, synced_at = ? WHERE id = ?', [name, icon, now, now, l.id]);
  return 'changed';
}

async function applyItem(gc, i, now) {
  if (!i || typeof i.id !== 'string' || !shopping.ID_RE.test(i.id) || typeof i.listId !== 'string') return false;
  const txt = text(i.text, TEXT_MAX);
  if (!txt) return false;
  const qty = text(i.qty, QTY_MAX) || null;
  const checked = i.checked === true ? 1 : 0;
  const by = checked ? posInt(i.checkedBy) : null;
  const deleted = i.deleted === true ? 1 : 0;
  const l = await getList(gc, i.listId);
  if (!l || l.deleted) return false;
  const row = await store.one(gc, 'SELECT * FROM shop_items WHERE id = ?', [i.id]);
  if (!row) {
    if (deleted) return false;
    await store.run(gc, 'INSERT INTO shop_items (id, list_id, text, qty, checked, checked_by, created_by, created_at, updated_at, deleted, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)',
      [i.id, l.id, txt, qty, checked, by, posInt(i.createdBy), Number.isSafeInteger(i.createdAt) && i.createdAt > 0 ? i.createdAt : now, now, now]);
    return true;
  }
  if (dirty(row) || row.list_id !== l.id) return false;
  if (row.text === txt && (row.qty || null) === qty && row.checked === checked && row.deleted === deleted && (!checked || (row.checked_by || null) === by)) return false;
  await store.run(gc, 'UPDATE shop_items SET text = ?, qty = ?, checked = ?, checked_by = ?, deleted = ?, updated_at = ?, synced_at = ? WHERE id = ?', [txt, qty, checked, by, deleted, now, now, i.id]);
  return true;
}

/** shopping_list: every family list of the hub, the items changed since the last pull → how many rows changed here. */
async function pull(gc, fam, now, budget, full) {
  const st = state.st;
  let n = 0;
  let again = false;
  let hubNow = null;
  let cursor = null;
  const seen = new Set();
  let done = false;
  for (let page = 0; page < PAGES_MAX; page++) {
    const res = await call(gc, budget, 'shopping_list', { since: full ? 0 : (st.since || 0), ...(cursor ? { cursor } : {}) });
    if (hubNow == null && Number.isSafeInteger(res.now)) hubNow = res.now;
    await store.tx(gc, async () => {
      for (const l of Array.isArray(res.lists) ? res.lists : []) {
        if (l && typeof l.id === 'string') seen.add(l.id);
        const what = await applyList(gc, fam, l, now);
        if (what) n++;
        // a list that is back (or new) has items the hub did not change since: everything once more
        if (what === 'back' || what === 'new') again = true;
      }
      for (const i of Array.isArray(res.items) ? res.items : []) if (await applyItem(gc, i, now)) n++;
    });
    cursor = typeof res.cursor === 'string' && res.cursor ? res.cursor : null;
    if (!cursor) { done = true; break; }
  }
  if (done) {
    // a list the hub no longer lists is gone there (deleted, or not shared with the family any more)
    const mine = await store.all(gc, 'SELECT id, dirty FROM shop_lists WHERE deleted = 0 AND synced_at > 0');
    await store.tx(gc, async () => {
      for (const l of mine) {
        if (seen.has(l.id) || dirty(l)) continue;
        await store.run(gc, 'UPDATE shop_lists SET deleted = 1, updated_at = ?, synced_at = ? WHERE id = ?', [now, now, l.id]);
        await store.run(gc, 'UPDATE shop_items SET deleted = 1, updated_at = ?, synced_at = ? WHERE list_id = ? AND deleted = 0', [now, now, l.id]);
        await store.run(gc, 'UPDATE places SET list_id = NULL WHERE list_id = ?', [l.id]);
        n++;
      }
    });
    // two seconds back: a row written in the hub while this pull ran is asked for again
    if (hubNow != null) st.since = Math.max(0, hubNow - 2000);
    st.pulledAt = now;
    st.pending = false;
    await save(gc);
  }
  if (again && !full && done) n += await pull(gc, fam, now, budget, true);
  return n;
}

/** The hub does not know the family any more (a fresh hub), or „Zurückholen“: the lists are Familie's own again. */
async function toLocal(gc, why) {
  await store.tx(gc, async () => {
    await store.run(gc, 'UPDATE shop_lists SET synced_at = 0, dirty = 0 WHERE synced_at != 0 OR dirty != 0');
    await store.run(gc, 'UPDATE shop_items SET synced_at = 0, dirty = 0 WHERE synced_at != 0 OR dirty != 0');
  });
  state.st = fresh();
  await save(gc);
  gc.log.warn('shopping lists back in Familie', why);
}

/**
 * One run (the background run, after a change in Familie, after shopping_changed): push, pull. → what happened; never
 * throws. opts.pull: pull now.
 */
async function sync(gc, fam, cfg, now = Date.now(), opts = {}) {
  if (state.running) {
    await state.running.catch(() => {});
    if (!opts.pull) return { skipped: 'running' };
  }
  const run = (async () => {
    const st = await load(gc);
    if (st.mode !== 'hub') return { skipped: 'local' };
    if (!cfg.modules.shopping) return { skipped: 'module_off' };
    if (!(await hubThere(gc, now))) return { skipped: 'unavailable' };
    if (!fam.list.some((m) => m.role === 'parent')) return { skipped: 'no_family' };
    const budget = { n: 0 };
    try {
      if (st.members !== membersKey(fam)) await bind(gc, fam, budget);
      const pushed = await pushChanges(gc, now, budget);
      let pulled = 0;
      if (opts.pull || st.pending || now - st.pulledAt >= PULL_EVERY_MS || now < st.pulledAt) pulled = await pull(gc, fam, now, budget, !st.pulledAt);
      return { pushed, pulled, calls: budget.n };
    } catch (e) {
      const code = (e && e.code) || 'error';
      if (e instanceof HubError && code === 'not_found' && state.st.mode === 'hub') {
        try { await toLocal(gc, 'hub_forgot'); } catch (x) { warn(gc, 'rollback', 'shopping rollback failed', (x && x.code) || 'error'); }
        return { rolledBack: true, calls: budget.n };
      }
      warn(gc, `sync:${code}`, 'shopping sync with Notizen & Aufgaben failed', code, e && e.field ? e.field : '');
      return { error: code, calls: budget.n };
    }
  })();
  state.running = run;
  try { return await run; } finally { if (state.running === run) state.running = null; }
}

// ─── the move ────────────────────────────────────

/** What would move: { lists, items, open, home, hub: { available }, canMove } */
async function preview(gc, now = Date.now()) {
  const l = await store.one(gc, 'SELECT COUNT(*) AS n FROM shop_lists WHERE deleted = 0');
  const i = await store.one(gc, `SELECT COUNT(*) AS n, SUM(CASE WHEN i.checked = 0 THEN 1 ELSE 0 END) AS open FROM shop_items i JOIN shop_lists l ON l.id = i.list_id AND l.deleted = 0 WHERE i.deleted = 0`);
  const st = await load(gc);
  const there = await hubThere(gc, now);
  return {
    lists: l.n, items: i.n || 0, open: i.open || 0, home: await where(gc), hub: { available: there },
    moved: st.mode === 'hub', canMove: there && st.mode !== 'hub', canBack: st.mode === 'hub',
  };
}

/** The button „Umziehen“ (a parent, the administrator): bind, send everything, pull → { moved: { lists, items }, home }. */
async function move(gc, fam, cfg, now, userId) {
  const err = (reason) => fail('unavailable', { reason });
  if (!cfg.modules.shopping) throw fail('module_off');
  if (!fam.list.some((m) => m.role === 'parent')) throw err('no_parent');
  state.hub = null;
  if (!(await hubThere(gc, now))) throw err('hub');
  const st = await load(gc);
  const budget = { n: 0 };
  try {
    await bind(gc, fam, budget);
  } catch (e) {
    warn(gc, 'move', 'shopping move failed', (e && e.code) || 'error');
    throw err('hub');
  }
  if (st.mode !== 'hub') {
    // everything goes (again): what is there already is not made twice — the hub knows the ids
    await store.tx(gc, async () => {
      await store.run(gc, 'UPDATE shop_lists SET synced_at = 0, dirty = 1');
      await store.run(gc, 'UPDATE shop_items SET synced_at = 0, dirty = 1');
    });
    Object.assign(st, { mode: 'hub', since: 0, pulledAt: 0, pending: false, migratedAt: now, by: userId || null });
    await save(gc);
  }
  const before = await preview(gc, now);
  const res = await sync(gc, fam, cfg, now, { pull: true });
  if (res.error || res.rolledBack || res.skipped) throw err('hub');
  gc.log.info('shopping lists moved to Notizen & Aufgaben', before.lists, before.items);
  return { moved: { lists: before.lists, items: before.items }, home: await where(gc) };
}

/** „Zurückholen“: Familie owns its lists again; the hub lets go (its lists stay as ordinary shared lists). */
async function back(gc, fam, cfg, now) {
  const st = await load(gc);
  if (st.mode !== 'hub') return { home: await where(gc) };
  // what the hub has that Familie has not yet comes along first
  if (await hubThere(gc, now)) {
    await sync(gc, fam, cfg, now, { pull: true });
    try { await call(gc, { n: 0 }, 'shopping_bind', { release: true }); } catch (e) { warn(gc, 'release', 'shopping release failed', (e && e.code) || 'error'); }
  }
  if (state.st.mode === 'hub') await toLocal(gc, 'back');
  return { home: await where(gc) };
}

/** After a change in Familie: to the hub in a second — only while the lists live there. */
function soon(gc, loadFam) {
  if (state.noTimer || state.timer || !state.st || state.st.mode !== 'hub') return;
  state.timer = setTimeout(() => {
    state.timer = null;
    loadFam().then(({ fam, cfg }) => sync(gc, fam, cfg, Date.now(), { pull: state.st && state.st.pending })).catch(() => {});
  }, 1000);
  if (typeof state.timer.unref === 'function') state.timer.unref();
}

/** shopping_changed { v, at } from the hub (only the hub): pull soon. */
async function changed(gc, c, loadFam) {
  if (!c || c.caller !== HUB) return { ok: false, code: 'forbidden' };
  const st = await load(gc);
  if (st.mode !== 'hub') return { ok: true, ignored: true };
  st.pending = true;
  await save(gc);
  soon(gc, loadFam);
  return { ok: true };
}

/**
 * shopping_action { action: 'going' | 'assign', listId, body } as a person (only the hub): „Ich gehe einkaufen“ /
 * „Kannst du einkaufen gehen?“ pressed in the hub — done here, with Familie's cards and pushes.
 * → { ok, notified, chat?, family: { assignee, dueAt, going } }
 */
async function action(gc, c, loadFam, now = Date.now()) {
  if (!c || c.caller !== HUB) return { ok: false, code: 'forbidden' };
  const p = c.payload && typeof c.payload === 'object' ? c.payload : {};
  if (!['going', 'assign'].includes(p.action) || typeof p.listId !== 'string' || !shopping.ID_RE.test(p.listId)) return { ok: false, code: 'invalid' };
  const { fam, cfg } = await loadFam();
  if (!cfg.modules.shopping) return { ok: false, code: 'module_off' };
  const me = c.user && fam.byId.get(c.user.id);
  if (!me) return { ok: false, code: 'not_member' };
  // a list made in the hub a moment ago: fetch it first
  let l = await getList(gc, p.listId);
  if ((!l || l.deleted) && (await inHub(gc))) { await sync(gc, fam, cfg, now, { pull: true }); l = await getList(gc, p.listId); }
  if (!l || l.deleted) return { ok: false, code: 'not_found' };
  const r = { cfg, now, today: tz.localDate(now, cfg.tz), fam, me, body: p.body && typeof p.body === 'object' && !Array.isArray(p.body) ? p.body : {}, pushes: [], after: [], lang: cfg.lang };
  let out;
  try {
    out = await store.tx(gc, () => (p.action === 'going' ? shopping.going(gc, r, p.listId) : shopping.assign(gc, r, p.listId)));
  } catch (e) {
    if (!isKnown(e)) throw e;
    const x = e.extra || {};
    return { ok: false, code: e.code, ...(typeof x.field === 'string' ? { field: x.field } : {}), ...(Number.isSafeInteger(x.retryAfter) ? { retryAfter: x.retryAfter } : {}) };
  }
  if (r.pushes.length) await push.flush(gc, r.pushes);
  const extra = {};
  for (const job of r.after) {
    try { Object.assign(extra, await job()); } catch (e) { gc.log.warn('after commit failed', (e && (e.code || e.message)) || 'error'); }
  }
  soon(gc, loadFam);
  return {
    ok: true, notified: extra.notified !== undefined ? extra.notified : (out.notified === undefined ? null : out.notified),
    ...(extra.chat !== undefined || out.chat !== undefined ? { chat: extra.chat !== undefined ? extra.chat : out.chat } : {}),
    family: await familyOf(gc, await getList(gc, p.listId), now),
  };
}

/** Where the shopping lists live { home: 'familie' | 'notizen', since } (GET shopping, GET overview). */
async function where(gc) {
  const st = await load(gc);
  // moved, and the hub still there (a hub that went: the lists are Familie's again for the apps)
  const there = st.mode === 'hub' && (await hubThere(gc));
  return { home: there ? 'notizen' : 'familie', since: there && st.migratedAt ? new Date(st.migratedAt).toISOString().replace(/\.\d{3}Z$/, 'Z') : null };
}

function stop() {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
}

module.exports = { HUB, SERVICES, STATE_KEY, PULL_EVERY_MS, state, reset, load, inHub, hubThere, sync, preview, move, back, soon, changed, action, where, stop };
