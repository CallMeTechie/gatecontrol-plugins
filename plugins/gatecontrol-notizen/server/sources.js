'use strict';

// Items of the other plugins (docs/notes-sources-contract.md): sources push (`todo_changed`, services.js), the hub keeps
// a copy (src_items, who sees what in src_item_users), reconciles now and then (`<source>:todo_items`, paged) and ticks
// items off in their plugin (`<source>:todo_complete`). The screens never call a source.

const store = require('./store');
const tz = require('./tz');
const config = require('./config');
const events = require('./events');
const calsync = require('./calsync');
const { fail, posInt, line, area: areaOf, parse } = require('./util');

const SOURCES = config.SOURCES;
const ID_RE = /^[A-Za-z0-9:._-]{1,120}$/;
const GROUP_RE = /^[A-Za-z0-9:._-]{1,80}$/;
const ROUTE_RE = /^[A-Za-z0-9/._:=-]{0,200}$/;
const KINDS = ['task', 'event', 'deadline', 'homework', 'exam', 'list', 'note'];
const MAX_UPSERT = 200;
const MAX_REMOVE = 500;
const PULL_EVERY = 12 * 3600 * 1000;
const PULL_PER_HOUR = 300;          // per source, below the 600 the sources declare
const PULL_PER_TICK = 12;           // service calls a background run may make for reconciliation
const PAGES_PER_RUN = 5;
const ACTIVE_DAYS = 30;
const GONE_PURGE = 7 * 86400000;
const DONE_KEEP = 36 * 3600 * 1000; // done items without news from their source go after this

const calls = new Map(); // plugin → [times] of pulls in the last hour

/** One item of the contract → the row's fields, or { error: field }. */
function check(raw, plugin, needUsers) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'item' };
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) return { error: 'id' };
  const bad = (field) => ({ error: field, id: raw.id });
  if (!KINDS.includes(raw.kind)) return bad('kind');
  const title = line(raw.title, 200);
  if (!title) return bad('title');
  if (raw.subtitle != null && typeof raw.subtitle !== 'string') return bad('subtitle');
  let dueDate = null;
  let dueTime = null;
  let dueAt = null;
  const allDay = raw.allDay === true || (typeof raw.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.due));
  if (raw.due != null) {
    if (typeof raw.due !== 'string') return bad('due');
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw.due)) {
      if (!tz.parseDate(raw.due)) return bad('due');
      dueDate = raw.due;
    } else {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?([zZ]|[+-]\d{2}:\d{2})$/.test(raw.due)) return bad('due');
      dueAt = Date.parse(raw.due);
      if (!Number.isFinite(dueAt)) return bad('due');
    }
  }
  const users = Array.isArray(raw.users) ? [...new Set(raw.users.map(posInt))] : null;
  if (users && (users.includes(null) || users.length > 50)) return bad('users');
  if (needUsers && (!users || !users.length)) return bad('users');
  if (raw.lead != null && raw.lead !== 'evening') return bad('lead');
  if (raw.area != null && raw.area !== 'private' && raw.area !== 'work') return bad('area');
  if (raw.assignee != null && !posInt(raw.assignee)) return bad('assignee');
  for (const k of ['important', 'done', 'canComplete', 'allDay']) if (raw[k] != null && typeof raw[k] !== 'boolean') return bad(k);
  let prog = null;
  if (raw.progress != null) {
    const p = raw.progress;
    if (!p || !Number.isSafeInteger(p.done) || !Number.isSafeInteger(p.total) || p.done < 0 || p.total < 0 || p.done > p.total || p.total > 100000) return bad('progress');
    prog = p;
  }
  let group = null;
  if (raw.group != null) {
    if (!raw.group || typeof raw.group.id !== 'string' || !GROUP_RE.test(raw.group.id)) return bad('group');
    group = { id: raw.group.id, label: line(raw.group.label, 80) || raw.group.id };
  }
  let meta = null;
  if (raw.meta != null) {
    if (typeof raw.meta !== 'object' || Array.isArray(raw.meta)) return bad('meta');
    meta = {};
    for (const [k, v] of Object.entries(raw.meta)) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(k)) return bad('meta');
      if (typeof v === 'string') meta[k] = line(v, 120);
      else if (typeof v === 'number' && Number.isFinite(v)) meta[k] = v;
      else if (typeof v === 'boolean') meta[k] = v;
      else if (v != null) return bad('meta');
    }
    if (JSON.stringify(meta).length > 1024) return bad('meta');
    if (meta.type != null && !(typeof meta.type === 'string' && /^[a-z_]{1,32}$/.test(meta.type))) return bad('meta');
  }
  if (!raw.open || raw.open.plugin !== plugin || typeof raw.open.route !== 'string' || !ROUTE_RE.test(raw.open.route)) return bad('open');
  const updatedAt = raw.updatedAt == null ? Date.now() : raw.updatedAt;
  if (!Number.isFinite(updatedAt) || updatedAt < 0) return bad('updatedAt');
  return {
    item: {
      extId: raw.id, kind: raw.kind, title, subtitle: raw.subtitle ? line(raw.subtitle, 200) || null : null, dueDate, dueAt, dueTime, allDay: !!allDay || (dueDate && !dueAt),
      lead: raw.lead || null, area: areaOf(raw.area), users, assignee: posInt(raw.assignee) || null, assigneeName: raw.assigneeName ? line(raw.assigneeName, 60) || null : null,
      important: !!raw.important, done: !!raw.done, canComplete: raw.canComplete !== false, prog, group, meta, route: raw.open.route, updatedAt: Math.round(updatedAt),
    },
  };
}

/** Write checked items of `plugin`. opts: { forUser, run } (a reconciliation for one person) — else a push (users exact). */
async function write(gc, ctx, plugin, items, opts = {}) {
  const touched = new Set();
  let accepted = 0;
  const now = ctx.now;
  for (const it of items) {
    // a date-time with offset → the date and time in the hub's zone
    if (it.dueAt != null) { const p = tz.parts(it.dueAt, ctx.tz); it.dueDate = tz.dateStr(p.y, p.m, p.d); it.dueTime = `${tz.pad(p.hh)}:${tz.pad(p.mm)}`; }
    else if (it.dueDate) it.dueAt = tz.at(it.dueDate, { hh: 23, mm: 59 }, ctx.tz);
    const have = await store.one(gc, 'SELECT id, updated_at, done FROM src_items WHERE plugin = ? AND ext_id = ?', [plugin, it.extId]);
    let id = have ? have.id : null;
    const fresh = !have || it.updatedAt >= have.updated_at;
    const vals = [it.kind, it.title, it.subtitle, it.dueDate, it.dueTime, it.dueAt, it.allDay ? 1 : 0, it.lead, it.area, it.assignee, it.assigneeName,
      it.important ? 1 : 0, it.done ? 1 : 0, it.done ? (have && have.done ? undefined : now) : null, it.canComplete ? 1 : 0, it.prog ? it.prog.done : null, it.prog ? it.prog.total : null,
      it.group ? it.group.id : null, it.group ? it.group.label : null, it.meta ? JSON.stringify(it.meta) : null, it.route, it.updatedAt, now];
    if (!have) {
      const r = await store.run(gc, `INSERT INTO src_items (plugin, ext_id, kind, title, subtitle, due_date, due_time, due_at, all_day, lead, area, assignee_id, assignee_name,
        important, done, done_at, can_complete, prog_done, prog_total, group_id, group_label, meta_json, open_route, updated_at, received_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [plugin, it.extId, ...vals.map((v) => (v === undefined ? null : v))]);
      id = Number(r.lastInsertRowid);
    } else if (fresh) {
      const doneAt = vals[13];
      vals.splice(13, 1);
      await store.run(gc, `UPDATE src_items SET kind = ?, title = ?, subtitle = ?, due_date = ?, due_time = ?, due_at = ?, all_day = ?, lead = ?, area = ?, assignee_id = ?,
        assignee_name = ?, important = ?, done = ?, can_complete = ?, prog_done = ?, prog_total = ?, group_id = ?, group_label = ?, meta_json = ?, open_route = ?, updated_at = ?,
        received_at = ?${doneAt === undefined ? '' : ', done_at = ?'} WHERE id = ?`, [...vals, ...(doneAt === undefined ? [] : [doneAt]), id]);
      if (!!have.done !== it.done) await carried(gc, ctx, plugin, it.extId, it.done);
    }
    const before = (await store.all(gc, 'SELECT user_id FROM src_item_users WHERE item_id = ?', [id])).map((r) => r.user_id);
    before.forEach((u) => touched.add(u));
    if (opts.forUser) {
      await store.run(gc, `INSERT INTO src_item_users (user_id, item_id, run) VALUES (?, ?, ?) ON CONFLICT(user_id, item_id) DO UPDATE SET run = excluded.run`, [opts.forUser, id, opts.run || 0]);
      touched.add(opts.forUser);
    } else if (fresh && it.users) {
      for (const u of before) if (!it.users.includes(u)) await store.run(gc, 'DELETE FROM src_item_users WHERE user_id = ? AND item_id = ?', [u, id]);
      for (const u of it.users) { if (!before.includes(u)) await store.run(gc, 'INSERT OR IGNORE INTO src_item_users (user_id, item_id, run) VALUES (?, ?, 0)', [u, id]); touched.add(u); }
    }
    accepted++;
  }
  return { accepted, touched };
}

/** A source ticked an item off (or undid it): the hub task carrying it follows. */
async function carried(gc, ctx, plugin, extId, done) {
  const rows = await store.all(gc, 'SELECT id, list_id, cal_event_id FROM tasks INDEXED BY idx_tasks_src WHERE src_plugin = ? AND src_id = ? AND deleted_at IS NULL AND parent_id IS NULL', [plugin, extId]);
  for (const r of rows) {
    await store.run(gc, `UPDATE tasks SET done_at = ${done ? 'COALESCE(done_at, ?)' : 'NULL'}, updated_at = ? WHERE id = ?`, done ? [ctx.now, ctx.now, r.id] : [ctx.now, r.id]);
    // 1.3.0: its event in Mail's calendar follows („✓“) with the next background run
    if (r.cal_event_id) await calsync.touch(gc, r.id);
    const ms = await store.all(gc, 'SELECT user_id FROM list_members WHERE list_id = ?', [r.list_id]);
    events.changed(gc, ms.map((m) => m.user_id), 'tasks');
  }
}

async function removeIds(gc, plugin, ids) {
  const touched = new Set();
  let removed = 0;
  for (const extId of ids) {
    const have = await store.one(gc, 'SELECT id FROM src_items WHERE plugin = ? AND ext_id = ?', [plugin, extId]);
    if (!have) continue;
    for (const u of await store.all(gc, 'SELECT user_id FROM src_item_users WHERE item_id = ?', [have.id])) touched.add(u.user_id);
    await store.run(gc, 'DELETE FROM src_item_users WHERE item_id = ?', [have.id]);
    await store.run(gc, 'DELETE FROM src_items WHERE id = ?', [have.id]);
    // a hub task that carried it stays, as a task of its own
    await store.run(gc, 'UPDATE tasks SET src_plugin = NULL, src_id = NULL WHERE src_plugin = ? AND src_id = ?', [plugin, extId]);
    removed++;
  }
  return { removed, touched };
}

/** The service todo_changed (services.js): a push of `caller`. */
async function push(gc, ctx, caller, payload) {
  if (!SOURCES.includes(caller)) return { ok: false, code: 'forbidden' };
  const p = payload || {};
  const up = p.upsert == null ? [] : p.upsert;
  const rm = p.remove == null ? [] : p.remove;
  if (!Array.isArray(up) || !Array.isArray(rm) || up.length > MAX_UPSERT || rm.length > MAX_REMOVE) return { ok: false, code: 'invalid' };
  const rejected = [];
  const good = [];
  for (const raw of up) {
    const c = check(raw, caller, true);
    if (c.error) rejected.push({ id: raw && typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : null, code: 'invalid', field: c.error });
    else good.push(c.item);
  }
  const ids = rm.filter((x) => typeof x === 'string' && ID_RE.test(x));
  const res = await store.tx(gc, async () => {
    const w = await write(gc, ctx, caller, good);
    const r = await removeIds(gc, caller, ids);
    await store.run(gc, `INSERT INTO src_state (plugin, available, pushes, last_push) VALUES (?, 1, 1, ?)
      ON CONFLICT(plugin) DO UPDATE SET available = 1, pushes = pushes + 1, last_push = excluded.last_push, gone_at = NULL`, [caller, ctx.now]);
    return { accepted: w.accepted, removed: r.removed, touched: new Set([...w.touched, ...r.touched]) };
  });
  events.changed(gc, [...res.touched], 'items');
  return { ok: true, accepted: res.accepted, removed: res.removed, rejected: rejected.slice(0, 50) };
}

// ── reconciliation ─────────────────────────────────

function budget(plugin, now) {
  const l = (calls.get(plugin) || []).filter((x) => now - x < 3600000);
  calls.set(plugin, l);
  return PULL_PER_HOUR - l.length;
}

async function available(gc, plugin) {
  try { return !!(gc.services && typeof gc.services.available === 'function' && await gc.services.available(plugin, 'todo_items')); } catch { return false; }
}

/** Ask for a reconciliation of `plugin` (or every source) for this person soon (opening the hub, „Jetzt abgleichen“). */
async function schedule(gc, userId, plugin, when) {
  for (const p of plugin ? [plugin] : SOURCES) {
    await store.run(gc, `INSERT INTO src_sync (plugin, user_id, next_at, state) VALUES (?, ?, ?, 'due')
      ON CONFLICT(plugin, user_id) DO UPDATE SET next_at = MIN(next_at, excluded.next_at), state = CASE WHEN state = 'running' THEN state ELSE 'due' END`, [p, userId, when]);
  }
}

/** One page of a reconciliation of (plugin, user) → true when it is complete. */
async function pullPage(gc, ctx, s) {
  const plugin = s.plugin;
  calls.get(plugin).push(ctx.now);
  let res;
  try {
    res = await gc.services.call({ plugin, service: 'todo_items', userId: s.user_id, payload: { v: 1, cursor: s.cursor || null, limit: 50 } });
  } catch (e) {
    const code = (e && e.code) || 'failed';
    const wait = code === 'ERR_RATE_LIMIT' ? 600000 : code === 'ERR_SERVICE_UNAVAILABLE' ? 3600000 : code === 'ERR_INVALID' ? PULL_EVERY : 900000;
    await store.run(gc, "UPDATE src_sync SET state = 'error', error = ?, next_at = ?, cursor = NULL WHERE plugin = ? AND user_id = ?", [code.slice(0, 40), ctx.now + wait, plugin, s.user_id]);
    await store.run(gc, 'INSERT INTO src_state (plugin, error) VALUES (?, ?) ON CONFLICT(plugin) DO UPDATE SET error = excluded.error', [plugin, code.slice(0, 40)]);
    return true;
  }
  if (!res || res.ok !== true || !Array.isArray(res.items)) {
    await store.run(gc, "UPDATE src_sync SET state = 'error', error = ?, next_at = ?, cursor = NULL WHERE plugin = ? AND user_id = ?", [String((res && res.code) || 'invalid').slice(0, 40), ctx.now + PULL_EVERY, plugin, s.user_id]);
    return true;
  }
  const good = [];
  for (const raw of res.items.slice(0, 200)) { const c = check(raw, plugin, false); if (c.item) good.push(c.item); }
  const last = typeof res.cursor !== 'string' || !res.cursor;
  const touched = await store.tx(gc, async () => {
    const w = await write(gc, ctx, plugin, good, { forUser: s.user_id, run: s.run });
    if (last) {
      // what did not come is no longer this person's
      const gone = await store.all(gc, `SELECT u.item_id FROM src_item_users u JOIN src_items i ON i.id = u.item_id AND i.plugin = ? WHERE u.user_id = ? AND u.run < ?`, [plugin, s.user_id, s.run]);
      for (const g of gone) {
        await store.run(gc, 'DELETE FROM src_item_users WHERE user_id = ? AND item_id = ?', [s.user_id, g.item_id]);
        const left = await store.one(gc, 'SELECT 1 AS x FROM src_item_users WHERE item_id = ? LIMIT 1', [g.item_id]);
        if (!left) await store.run(gc, 'DELETE FROM src_items WHERE id = ?', [g.item_id]);
      }
      if (gone.length) w.touched.add(s.user_id);
      await store.run(gc, "UPDATE src_sync SET state = 'done', error = NULL, cursor = NULL, last_at = ?, next_at = ? WHERE plugin = ? AND user_id = ?",
        [ctx.now, ctx.now + PULL_EVERY + Math.floor(Math.random() * 3600000), plugin, s.user_id]);
      await store.run(gc, 'INSERT INTO src_state (plugin, available, last_pull) VALUES (?, 1, ?) ON CONFLICT(plugin) DO UPDATE SET available = 1, last_pull = excluded.last_pull, error = NULL, gone_at = NULL', [plugin, ctx.now]);
    } else {
      await store.run(gc, "UPDATE src_sync SET cursor = ?, state = 'running' WHERE plugin = ? AND user_id = ?", [String(res.cursor).slice(0, 2000), plugin, s.user_id]);
    }
    return w.touched;
  });
  events.changed(gc, [...touched], 'items');
  return last;
}

/** The background part (every minute): availability, due reconciliations within the budgets, old done items. */
async function tick(gc, ctx) {
  const cfg = await config.get(gc);
  const avail = new Map();
  for (const plugin of SOURCES) {
    const on = config.sourceOn(cfg, plugin) && await available(gc, plugin);
    avail.set(plugin, on);
    const st = await store.one(gc, 'SELECT * FROM src_state WHERE plugin = ?', [plugin]);
    if (on && (!st || !st.available)) {
      // a source came (or came back): everybody active gets a reconciliation soon, spread over 30 minutes
      await store.run(gc, 'INSERT INTO src_state (plugin, available) VALUES (?, 1) ON CONFLICT(plugin) DO UPDATE SET available = 1, gone_at = NULL', [plugin]);
      const active = await store.all(gc, 'SELECT user_id FROM prefs WHERE updated_at > ?', [ctx.now - ACTIVE_DAYS * 86400000]);
      for (const a of active) await schedule(gc, a.user_id, plugin, ctx.now + Math.floor(Math.random() * 1800000));
    } else if (!on && st && st.available) {
      await store.run(gc, 'UPDATE src_state SET available = 0, gone_at = ? WHERE plugin = ?', [ctx.now, plugin]);
    } else if (!on && st && st.gone_at && ctx.now - st.gone_at > GONE_PURGE) {
      await store.run(gc, 'DELETE FROM src_item_users WHERE item_id IN (SELECT id FROM src_items WHERE plugin = ?)', [plugin]);
      await store.run(gc, 'DELETE FROM src_items WHERE plugin = ?', [plugin]);
      await store.run(gc, 'DELETE FROM src_sync WHERE plugin = ?', [plugin]);
      await store.run(gc, 'UPDATE src_state SET gone_at = NULL WHERE plugin = ?', [plugin]);
    }
    if (!calls.has(plugin)) calls.set(plugin, []);
  }
  let made = 0;
  const due = await store.all(gc, 'SELECT * FROM src_sync WHERE next_at <= ? ORDER BY next_at LIMIT 50', [ctx.now]);
  for (const s of due) {
    if (made >= PULL_PER_TICK) break;
    if (!avail.get(s.plugin)) { await store.run(gc, 'UPDATE src_sync SET next_at = ? WHERE plugin = ? AND user_id = ?', [ctx.now + 3600000, s.plugin, s.user_id]); continue; }
    if (budget(s.plugin, ctx.now) <= 0) continue;
    if (!s.cursor) { s.run = (s.run || 0) + 1; await store.run(gc, "UPDATE src_sync SET run = ?, state = 'running' WHERE plugin = ? AND user_id = ?", [s.run, s.plugin, s.user_id]); }
    for (let i = 0; i < PAGES_PER_RUN && made < PULL_PER_TICK && budget(s.plugin, ctx.now) > 0; i++) {
      made++;
      const doneNow = await pullPage(gc, ctx, s);
      if (doneNow) break;
      s.cursor = (await store.one(gc, 'SELECT cursor FROM src_sync WHERE plugin = ? AND user_id = ?', [s.plugin, s.user_id])).cursor;
    }
  }
  // done items whose source said nothing more for a day and a half
  const old = await store.all(gc, 'SELECT id FROM src_items INDEXED BY idx_src_items_done WHERE done = 1 AND done_at < ? LIMIT 500', [ctx.now - DONE_KEEP]);
  for (const o of old) { await store.run(gc, 'DELETE FROM src_item_users WHERE item_id = ?', [o.id]); await store.run(gc, 'DELETE FROM src_items WHERE id = ?', [o.id]); }
  return { pulls: made };
}

// ── for the screens ─────────────────────────────────

/** The items `ctx.userId` sees (a person's choices of „Quellen“ applied; prefs = prefs.js view). */
async function visible(gc, ctx, prefs, opts = {}) {
  const cfg = await config.get(gc);
  const on = new Set();
  for (const p of SOURCES) {
    if (!config.sourceOn(cfg, p)) continue;
    if (prefs.sources[p] && prefs.sources[p].on === false) continue;
    on.add(p);
  }
  if (opts.plugin) { if (!on.has(opts.plugin)) return []; on.clear(); on.add(opts.plugin); }
  if (!on.size) return [];
  const gone = new Set((await store.all(gc, 'SELECT plugin FROM src_state WHERE available = 0')).map((r) => r.plugin));
  const rows = await store.all(gc, `SELECT i.* FROM src_item_users u JOIN src_items i ON i.id = u.item_id WHERE u.user_id = ? LIMIT 5000`, [ctx.userId]);
  // items a hub task of this person carries are shown as that task
  const carried = new Set((await store.all(gc, `SELECT t.src_plugin, t.src_id FROM list_members m JOIN tasks t INDEXED BY idx_tasks_src ON t.list_id = m.list_id
    WHERE m.user_id = ? AND t.src_plugin IS NOT NULL AND t.deleted_at IS NULL AND t.parent_id IS NULL`, [ctx.userId])).map((r) => r.src_plugin + '|' + r.src_id));
  const out = [];
  for (const r of rows) {
    if (!on.has(r.plugin) || gone.has(r.plugin)) continue;
    if (carried.has(r.plugin + '|' + r.ext_id) && !opts.withCarried) continue;
    const meta = parse(r.meta_json, {}) || {};
    const sp = prefs.sources[r.plugin] || {};
    let area = r.area;
    if (r.group_id) {
      const g = prefs.groups[r.plugin + '|' + r.group_id];
      if (g === 'hide') continue;
      if (g === 'private' || g === 'work') area = g;
    }
    if (opts.area && area !== opts.area) continue;
    if (r.plugin === 'gatecontrol-familie' && r.assignee_id && r.assignee_id !== ctx.userId) {
      if (sp.kids === 'none' || sp.kids === 'mine') continue;
    }
    if (r.plugin === 'gatecontrol-mail' && meta.flagged === true && sp.flagged === false) continue;
    out.push({ row: r, area, meta });
  }
  return out;
}

/** An item row → the API's Item. */
function view(ctx, x, prefs, labels) {
  const r = x.row;
  let show = r.due_date ? { date: r.due_date, time: r.due_time || null } : null;
  if (r.lead === 'evening' && r.due_date) {
    const sp = prefs.sources[r.plugin] || {};
    show = { date: tz.addDays(r.due_date, -1), time: /^\d{2}:\d{2}$/.test(sp.evening || '') ? sp.evening : prefs.evening };
  }
  const overdue = !r.done && !!show && (show.time ? tz.at(show.date, tz.parseTime(show.time), ctx.tz) < ctx.now && r.kind !== 'event' : show.date < ctx.today);
  return {
    uid: 's:' + r.id, type: 'source', id: r.id, kind: r.kind, title: r.title, subtitle: r.subtitle || null,
    source: { plugin: r.plugin, label: labels(r.plugin), open: { plugin: r.plugin, route: r.open_route || '' } },
    due: r.due_date ? { date: r.due_date, time: r.due_time || null } : null, show, allDay: !!r.all_day, lead: r.lead || null, overdue,
    area: x.area, important: !!r.important, done: !!r.done, doneAt: r.done_at || null, canComplete: !!r.can_complete,
    assignee: r.assignee_id || r.assignee_name ? { id: r.assignee_id || null, name: r.assignee_name || null } : null,
    progress: r.prog_total != null ? { done: r.prog_done || 0, total: r.prog_total } : null,
    group: r.group_id ? { id: r.group_id, label: r.group_label } : null, meta: x.meta, updatedAt: r.updated_at,
  };
}

/** An item the person sees (by the hub's id) → its row (not_found otherwise). */
async function access(gc, ctx, id) {
  const iid = posInt(id);
  if (!iid) throw fail('not_found');
  const r = await store.one(gc, 'SELECT i.* FROM src_item_users u JOIN src_items i ON i.id = u.item_id WHERE u.user_id = ? AND u.item_id = ?', [ctx.userId, iid]);
  if (!r) throw fail('not_found');
  return r;
}

/** Tick an item off in its plugin (todo_complete) and keep the answer → the row as it is now. */
async function complete(gc, ctx, plugin, extId, done) {
  let res;
  try {
    res = await gc.services.call({ plugin, service: 'todo_complete', userId: ctx.userId, payload: { v: 1, id: extId, done: !!done } });
  } catch (e) {
    throw fail('unavailable', { reason: (e && e.code) || 'failed' });
  }
  if (!res || res.ok !== true) throw fail(res && res.code === 'read_only' ? 'forbidden' : 'unavailable', { reason: (res && typeof res.code === 'string' && res.code.slice(0, 40)) || 'failed' });
  await store.tx(gc, async () => {
    const c = res.item ? check(res.item, plugin, false) : null;
    if (c && c.item && c.item.extId === extId) await write(gc, ctx, plugin, [{ ...c.item, updatedAt: Math.max(c.item.updatedAt, ctx.now) }], {});
    else await store.run(gc, `UPDATE src_items SET done = ?, done_at = ?, updated_at = MAX(updated_at, ?) WHERE plugin = ? AND ext_id = ?`, [done ? 1 : 0, done ? ctx.now : null, ctx.now, plugin, extId]);
  });
  const users = await store.all(gc, 'SELECT u.user_id FROM src_item_users u JOIN src_items i ON i.id = u.item_id WHERE i.plugin = ? AND i.ext_id = ?', [plugin, extId]);
  events.changed(gc, users.map((u) => u.user_id), 'items');
  return store.one(gc, 'SELECT * FROM src_items WHERE plugin = ? AND ext_id = ?', [plugin, extId]);
}

/** „Quellen“: per source whether it is there, the person's groups and counts, the last reconciliation. */
async function status(gc, ctx) {
  const cfg = await config.get(gc);
  const out = [];
  for (const p of SOURCES) {
    const st = await store.one(gc, 'SELECT * FROM src_state WHERE plugin = ?', [p]);
    const sync = await store.one(gc, 'SELECT * FROM src_sync WHERE plugin = ? AND user_id = ?', [p, ctx.userId]);
    const groups = await store.all(gc, `SELECT i.group_id, MAX(i.group_label) AS label, COUNT(*) AS n FROM src_item_users u JOIN src_items i ON i.id = u.item_id
      WHERE u.user_id = ? AND i.plugin = ? AND i.group_id IS NOT NULL GROUP BY i.group_id LIMIT 50`, [ctx.userId, p]);
    const n = await store.one(gc, 'SELECT COUNT(*) AS n FROM src_item_users u JOIN src_items i ON i.id = u.item_id WHERE u.user_id = ? AND i.plugin = ? AND i.done = 0', [ctx.userId, p]);
    out.push({
      plugin: p, enabled: config.sourceOn(cfg, p), available: !!(st && st.available), open: n.n,
      lastSync: sync && sync.last_at ? sync.last_at : null, error: sync && sync.state === 'error' ? sync.error : null,
      groups: groups.map((g) => ({ id: g.group_id, label: g.label, count: g.n })),
    });
  }
  return out;
}

module.exports = { SOURCES, KINDS, check, write, push, tick, schedule, visible, view, access, complete, status, removeIds, _calls: calls };
