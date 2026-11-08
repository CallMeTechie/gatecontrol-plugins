'use strict';

// „Notizen & Aufgaben“ (the hub plugin gatecontrol-notizen) — this plugin as one of its sources, contract v1
// (gatecontrol-plugins docs/notes-sources-contract.md). The same file in every source plugin; what a plugin reports is its
// own adapter (collect / complete).
//
//   push   gatecontrol-notizen:todo_changed { v: 1, upsert: [Item], remove: [id] } — what changed since the last push:
//          the plugin's current items (collect) are compared with what the hub got (table todo_sent: id, hash, at), so
//          only real changes go out, whatever changed them (a person, the background sync, a new day). At most every
//          10 s: from the background run (tick, the plugin's own pace) and 5 s after a person changed something
//          (soon). ≤ 200 upserts and 500 removals per call, ≤ MAX_CALLS calls per flush; ERR_RATE_LIMIT / ERR_TIMEOUT /
//          ERR_SERVICE_UNAVAILABLE / ERR_SERVICE_FAILED keep the difference for the next run.
//   pull   service todo_items { v, cursor?, limit? } → { ok, items, cursor, now } — the person's items, by id, ≤ 15 KB.
//   tick   service todo_complete { v, id, done } → { ok, item } | { ok: false, code } — the plugin's own action.
//
// Without the hub (not installed, stopped, an older GateControl without gc.services.available) nothing is sent and
// nothing changes for the plugin; the hub pulls everything when it comes. Only the hub may call the two services.

const crypto = require('node:crypto');

const HUB = 'gatecontrol-notizen';
const PUSH = 'todo_changed';
const SERVICES = ['todo_items', 'todo_complete'];
const V = 1;
const MIN_GAP_MS = 10000;          // pushes at most every 10 s
const DEBOUNCE_MS = 5000;          // after a person's change
const AVAILABLE_TTL_MS = 60000;    // a known "no hub" is asked again after a minute
const CACHE_MS = 30000;            // the items of a pull (its pages) are computed once
const MAX_UPSERT = 200;
const MAX_REMOVE = 500;
const MAX_CALLS = 5;
const PAYLOAD_MAX = 400 * 1024;    // the host takes 512 KB
const PAGE_BYTES = 15 * 1024;      // an answer is ≤ 16 KB in all
const FORBIDDEN_BACKOFF_MS = 3600000;
const INVALID_BACKOFF_MS = 600000;
const RETRY_CODES = ['ERR_RATE_LIMIT', 'ERR_TIMEOUT', 'ERR_SERVICE_UNAVAILABLE', 'ERR_SERVICE_FAILED'];

const KINDS = ['task', 'event', 'deadline', 'homework', 'exam', 'list', 'note'];
const ID_RE = /^[A-Za-z0-9:._-]{1,120}$/;
const GROUP_RE = /^[A-Za-z0-9:._-]{1,80}$/;
const ROUTE_RE = /^[A-Za-z0-9/._:=-]{0,200}$/;
const META_TYPE_RE = /^[a-z_]{1,32}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const META_MAX = 1024;

/** Plain text on one line, cut to `max` characters (with „…“). */
function plain(v, max) {
  const s = String(v == null ? '' : v).replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, Math.max(1, max - 1)).trimEnd() + '…' : s;
}

const uid = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);

/**
 * An item as the plugin built it → the item of the contract (fields in a fixed order, cut to their limits) or null when
 * it cannot be one (no id / title / kind / users). updatedAt is set by stamp().
 */
function clean(x, plugin) {
  if (!x || typeof x !== 'object') return null;
  if (typeof x.id !== 'string' || !ID_RE.test(x.id) || !KINDS.includes(x.kind)) return null;
  const title = plain(x.title, 200);
  if (!title) return null;
  const users = [...new Set((Array.isArray(x.users) ? x.users : []).map(uid).filter(Boolean))].slice(0, 50);
  if (!users.length) return null;
  const out = { id: x.id, kind: x.kind, title };
  const sub = plain(x.subtitle, 200);
  out.subtitle = sub || null;
  let due = null;
  let allDay = false;
  if (typeof x.due === 'string' && DATE_RE.test(x.due)) { due = x.due; allDay = true; } else if (typeof x.due === 'string' && DATETIME_RE.test(x.due) && Number.isFinite(Date.parse(x.due))) due = x.due;
  out.due = due;
  out.allDay = allDay;
  out.lead = x.lead === 'evening' ? 'evening' : null;
  out.area = x.area === 'work' ? 'work' : 'private';
  out.users = users;
  out.assignee = uid(x.assignee);
  const an = plain(x.assigneeName, 60);
  out.assigneeName = an || null;
  out.important = x.important === true;
  out.done = x.done === true;
  out.canComplete = x.canComplete === true;
  const p = x.progress;
  out.progress = p && Number.isSafeInteger(p.done) && Number.isSafeInteger(p.total) && p.total > 0 && p.done >= 0 ? { done: Math.min(p.done, p.total), total: p.total } : null;
  const g = x.group;
  out.group = g && typeof g.id === 'string' && GROUP_RE.test(g.id) ? { id: g.id, label: plain(g.label, 80) || g.id } : null;
  out.meta = meta(x.meta);
  const route = x.open && typeof x.open.route === 'string' && ROUTE_RE.test(x.open.route) ? x.open.route : '';
  out.open = { plugin, route };
  out.updatedAt = Number.isSafeInteger(x.updatedAt) && x.updatedAt > 0 ? x.updatedAt : 0;
  return out;
}

/** meta: flat, strings ≤ 120 / finite numbers / booleans, type [a-z_]{1,32}, ≤ 1 KB as JSON — or null. */
function meta(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const out = {};
  for (const [k, v] of Object.entries(m)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(k) || v == null) continue;
    if (k === 'type') { if (typeof v === 'string' && META_TYPE_RE.test(v)) out.type = v; continue; }
    if (typeof v === 'string') { const s = plain(v, 120); if (s) out[k] = s; } else if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[k] = v;
    if (JSON.stringify(out).length > META_MAX) { delete out[k]; break; }
  }
  return Object.keys(out).length ? out : null;
}

/** The hash of an item without its updatedAt (what the hub would see change). */
function hashOf(item) {
  const { updatedAt, ...rest } = item;
  return crypto.createHash('sha1').update(JSON.stringify(rest)).digest('hex');
}

/**
 * updatedAt that never goes back: an item as the hub got it keeps max(its own time, the time it went out); a changed one
 * gets at least `now` (and later than what went out).
 */
function stamp(item, hash, sent, now) {
  if (sent && sent.hash === hash) return Math.max(item.updatedAt, sent.at);
  return Math.max(item.updatedAt, now, sent ? sent.at + 1 : 0);
}

const sizeOf = (x) => Buffer.byteLength(JSON.stringify(x)) + 1;

/**
 * create({ plugin, collect, complete, tx?, intervalMs? }) — the source of one plugin.
 *   collect(gc, now) → [item]  every current item (open ones, and those done within the last 24 h), with `users`
 *   complete(gc, user, item, done, now) → { ok: true } | { ok: false, code } — what ticking it off in the plugin does
 *                                         (only called for an item of that person that can be completed)
 *   tx(gc, fn)                  the plugin's transaction helper (writes to todo_sent); default: BEGIN … COMMIT
 *   intervalMs                  the background run pushes at most this often (default 60 s; never below 10 s)
 *   now()                       the plugin's clock (default Date.now)
 */
function create(o) {
  const plugin = o.plugin;
  const clock = typeof o.now === 'function' ? o.now : () => Date.now();
  const interval = Math.max(MIN_GAP_MS, o.intervalMs || 60000);
  const tx = o.tx || (async (gc, fn) => {
    await gc.db.exec('BEGIN');
    try { const r = await fn(); await gc.db.exec('COMMIT'); return r; } catch (e) { await gc.db.exec('ROLLBACK').catch(() => {}); throw e; }
  });
  const state = { lastFlush: 0, lastRun: 0, flushing: null, timer: null, hub: null, hubAt: 0, backoffUntil: 0, cache: null, warned: new Set(), noTimer: false };

  function reset() {
    if (state.timer) clearTimeout(state.timer);
    Object.assign(state, { lastFlush: 0, lastRun: 0, flushing: null, timer: null, hub: null, hubAt: 0, backoffUntil: 0, cache: null, warned: new Set() });
  }

  const warnOnce = (gc, key, ...a) => {
    if (state.warned.has(key)) return;
    state.warned.add(key);
    try { gc.log.warn(...a); } catch { /* no log */ }
  };

  /** Is the hub there (gc.services.available; asks nobody, not counted)? */
  async function available(gc, now = clock()) {
    if (!gc.services || typeof gc.services.available !== 'function' || typeof gc.services.call !== 'function') { state.hub = false; state.hubAt = now; return false; }
    let on = false;
    try { on = (await gc.services.available(HUB, PUSH)) === true; } catch { on = false; }
    state.hub = on;
    state.hubAt = now;
    return on;
  }

  /** The current items (cleaned; one per id) → Map id → item. */
  async function items(gc, now) {
    const out = new Map();
    for (const x of (await o.collect(gc, now)) || []) {
      const c = clean(x, plugin);
      if (c && !out.has(c.id)) out.set(c.id, c);
    }
    return out;
  }

  async function snapshot(gc, now, fresh) {
    if (!fresh && state.cache && now - state.cache.at < CACHE_MS && now >= state.cache.at) return state.cache.items;
    const m = await items(gc, now);
    state.cache = { at: now, items: m };
    return m;
  }

  async function sentRows(gc, ids) {
    const out = new Map();
    if (ids === null) {
      for (const r of (await gc.db.query('SELECT id, hash, at FROM todo_sent', [])).rows || []) out.set(r.id, r);
      return out;
    }
    for (let i = 0; i < ids.length; i += 200) {
      const part = ids.slice(i, i + 200);
      const rows = (await gc.db.query(`SELECT id, hash, at FROM todo_sent WHERE id IN (${part.map(() => '?').join(',')})`, part)).rows || [];
      for (const r of rows) out.set(r.id, r);
    }
    return out;
  }

  /** What the hub got now: [{ id, hash, at }] upserted, ids removed. */
  async function record(gc, put, gone) {
    if (!put.length && !gone.length) return;
    await tx(gc, async () => {
      for (const r of put) {
        await gc.db.run('INSERT INTO todo_sent (id, hash, at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET hash = excluded.hash, at = excluded.at', [r.id, r.hash, r.at]);
      }
      for (const id of gone) await gc.db.run('DELETE FROM todo_sent WHERE id = ?', [id]);
    });
  }

  /** The difference to what the hub got → { upsert: [{ item, hash }], remove: [id] }. */
  async function diff(gc, now) {
    const cur = await snapshot(gc, now, true);
    const sent = await sentRows(gc, null);
    const upsert = [];
    for (const item of cur.values()) {
      const hash = hashOf(item);
      const s = sent.get(item.id);
      if (s && s.hash === hash) continue;
      upsert.push({ item: { ...item, updatedAt: stamp(item, hash, s, now) }, hash });
    }
    const remove = [...sent.keys()].filter((id) => !cur.has(id));
    return { upsert, remove };
  }

  /**
   * Push what changed. → { sent: calls, upserted, removed, skipped?: reason }. Never throws. opts.force: without the
   * 10 s gap (tests, an explicit run).
   */
  async function flush(gc, now = clock(), opts = {}) {
    if (state.flushing) return state.flushing;
    const run = (async () => {
      if (!opts.force && now - state.lastFlush < MIN_GAP_MS && now >= state.lastFlush) return { sent: 0, skipped: 'gap' };
      if (now < state.backoffUntil) return { sent: 0, skipped: 'backoff' };
      if (!(await available(gc, now))) return { sent: 0, skipped: 'unavailable' };
      state.lastFlush = now;
      let d;
      try { d = await diff(gc, now); } catch (e) { warnOnce(gc, 'collect', 'notizen: items failed', (e && (e.code || e.message)) || 'error'); return { sent: 0, skipped: 'error' }; }
      let calls = 0;
      let upserted = 0;
      let removed = 0;
      const ups = d.upsert.slice();
      const rems = d.remove.slice();
      while ((ups.length || rems.length) && calls < MAX_CALLS) {
        const chunk = [];
        let bytes = 64;
        while (ups.length && chunk.length < MAX_UPSERT) {
          const s = sizeOf(ups[0].item);
          if (chunk.length && bytes + s > PAYLOAD_MAX) break;
          chunk.push(ups.shift());
          bytes += s;
        }
        const gone = rems.splice(0, MAX_REMOVE);
        let res;
        calls++;
        try {
          res = await gc.services.call({ plugin: HUB, service: PUSH, payload: { v: V, upsert: chunk.map((x) => x.item), remove: gone } });
        } catch (e) {
          const code = (e && e.code) || 'error';
          if (!RETRY_CODES.includes(code)) warnOnce(gc, `push:${code}`, 'notizen: push failed', code);
          if (code === 'ERR_SERVICES_DENIED') state.backoffUntil = now + FORBIDDEN_BACKOFF_MS;
          break;
        }
        if (!res || res.ok !== true) {
          const code = (res && res.code) || 'failed';
          warnOnce(gc, `refused:${code}`, 'notizen: the hub refused the push', code);
          if (code === 'forbidden') state.backoffUntil = now + FORBIDDEN_BACKOFF_MS;
          else if (code === 'invalid') state.backoffUntil = now + INVALID_BACKOFF_MS;
          break;
        }
        for (const r of Array.isArray(res.rejected) ? res.rejected.slice(0, 5) : []) warnOnce(gc, `rejected:${r && r.code}:${r && r.field}`, 'notizen: item rejected', r && r.code, r && r.field);
        // a rejected item went out as well: the same item would be rejected again
        await record(gc, chunk.map((x) => ({ id: x.item.id, hash: x.hash, at: x.item.updatedAt })), gone);
        upserted += chunk.length;
        removed += gone.length;
      }
      return { sent: calls, upserted, removed };
    })().catch((e) => { warnOnce(gc, 'flush', 'notizen: flush failed', (e && (e.code || e.message)) || 'error'); return { sent: 0, skipped: 'error' }; });
    state.flushing = run;
    try { return await run; } finally { state.flushing = null; }
  }

  /** The background run: at the plugin's pace (intervalMs). */
  async function tick(gc, now = clock()) {
    if (now - state.lastRun < interval && now >= state.lastRun) return { sent: 0, skipped: 'interval' };
    state.lastRun = now;
    return flush(gc, now);
  }

  /** A person changed something: push in 5 s (at most every 10 s) — not when the hub is known to be missing. */
  function soon(gc) {
    state.cache = null;
    if (state.noTimer || state.timer) return;
    const now = clock();
    if (state.hub === false && now - state.hubAt < AVAILABLE_TTL_MS && now >= state.hubAt) return;
    const wait = Math.max(DEBOUNCE_MS, state.lastFlush + MIN_GAP_MS - now);
    state.timer = setTimeout(() => {
      state.timer = null;
      flush(gc, clock()).catch(() => {});
    }, Math.min(wait, MIN_GAP_MS));
    if (state.timer && typeof state.timer.unref === 'function') state.timer.unref();
  }

  function stop() {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
  }

  // ─── the services (only the hub calls them) ───

  const refuse = (code) => ({ ok: false, code });

  /** todo_items { v, cursor?, limit? } for `user`. */
  async function pull(gc, user, payload, now) {
    const limit = payload.limit == null ? 50 : payload.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return refuse('invalid');
    if (payload.cursor != null && !(typeof payload.cursor === 'string' && ID_RE.test(payload.cursor))) return refuse('invalid');
    const all = [...(await snapshot(gc, now, !payload.cursor)).values()].filter((x) => x.users.includes(user.id)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const start = payload.cursor ? all.findIndex((x) => x.id > payload.cursor) : 0;
    const rest = start < 0 ? [] : all.slice(start);
    const page = [];
    let bytes = 0;
    for (const x of rest) {
      if (page.length >= limit) break;
      const s = sizeOf(x);
      if (page.length && bytes + s > PAGE_BYTES) break;
      page.push(x);
      bytes += s;
    }
    const sent = await sentRows(gc, page.map((x) => x.id));
    const out = [];
    const put = [];
    for (const x of page) {
      const hash = hashOf(x);
      const s = sent.get(x.id);
      const at = stamp(x, hash, s, now);
      out.push({ ...x, updatedAt: at });
      // the hub has it now (the person's view of it is the whole item): no push for it
      if (!s || s.hash !== hash) put.push({ id: x.id, hash, at });
    }
    if (put.length) await record(gc, put, []);
    const more = rest.length > page.length;
    return { ok: true, items: out, cursor: more && page.length ? page[page.length - 1].id : null, now };
  }

  /** todo_complete { v, id, done } for `user`. */
  async function tickOff(gc, user, payload, now) {
    if (typeof payload.id !== 'string' || !ID_RE.test(payload.id) || typeof payload.done !== 'boolean') return refuse('invalid');
    const cur = await snapshot(gc, now, true);
    const item = cur.get(payload.id);
    if (!item || !item.users.includes(user.id)) return refuse('not_found');
    if (!item.canComplete) return refuse('read_only');
    let res;
    try { res = await o.complete(gc, user, item, payload.done, now); } catch (e) {
      warnOnce(gc, 'complete', 'notizen: complete failed', (e && (e.code || e.message)) || 'error');
      return refuse('invalid');
    }
    if (!res || res.ok !== true) return refuse((res && res.code) || 'invalid');
    const after = await snapshot(gc, now, true);
    const x = after.get(payload.id);
    if (!x) return { ok: true };
    const sent = (await sentRows(gc, [x.id])).get(x.id);
    const hash = hashOf(x);
    const at = stamp(x, hash, sent, now);
    // the hub takes the answer's item: no push for it
    if (!sent || sent.hash !== hash) await record(gc, [{ id: x.id, hash, at }], []);
    return { ok: true, item: { ...x, updatedAt: at } };
  }

  /**
   * The hook service(…) for todo_items / todo_complete → the answer, or undefined when `call.name` is none of them.
   * Only the hub may call (forbidden), only for a person (invalid without user).
   */
  async function service(gc, call) {
    const c = call && typeof call === 'object' ? call : {};
    if (!SERVICES.includes(c.name)) return undefined;
    if (c.caller !== HUB) return refuse('forbidden');
    const user = c.user && uid(c.user.id) ? c.user : null;
    if (!user) return refuse('invalid');
    const payload = c.payload && typeof c.payload === 'object' && !Array.isArray(c.payload) ? c.payload : {};
    const now = clock();
    try {
      return c.name === 'todo_items' ? await pull(gc, user, payload, now) : await tickOff(gc, user, payload, now);
    } catch (e) {
      warnOnce(gc, `service:${c.name}`, 'notizen: service failed', c.name, (e && (e.code || e.message)) || 'error');
      return refuse('invalid');
    }
  }

  return { state, reset, available, flush, tick, soon, stop, service, items: (gc, now = clock()) => items(gc, now), clean: (x) => clean(x, plugin) };
}

/** A date-time with the offset of `zone` at `ms` ("2026-11-09T09:00:00+01:00"). */
function isoIn(ms, zone) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: zone || undefined, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const local = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  const off = Math.round((local - Math.floor(ms / 1000) * 1000) / 60000);
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

module.exports = { HUB, PUSH, SERVICES, V, MIN_GAP_MS, MAX_UPSERT, MAX_REMOVE, PAGE_BYTES, KINDS, create, clean, hashOf, plain, isoIn };
