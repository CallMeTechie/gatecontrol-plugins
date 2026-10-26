'use strict';

// Group chats for GateControl groups (1.9.0, GateControl ≥ 1.200.0, plugin.json permissions.groups "read",
// docs/plugins.md "Groups"):
//
// The administrator picks groups on the page „Übersicht“ (card „Gruppenchats für GateControl-Gruppen“,
// GC.pickPrincipals; settings row `groupChats` = [groupId], at most 50). For each of them the messenger
// keeps a managed group chat (managed_by gatecontrol-messenger, managed_key 'group:<id>' — the machinery of
// sync_group, services.syncManaged) in step with the group:
//
//   members  the group's effective members (gc.groups.members(id, { nested: true }): members of subgroups
//            count, archived subgroups and disabled accounts do not), only accounts the messenger knows
//   title    the group's path („Verwaltung › Buchhaltung“; longer than 80 characters: its name)
//   admins   the direct leads, deputies and group admins of the group (role lead / deputy / admin) — chat
//            admins; everybody else is a member. Like Familie's group, members cannot change members, title
//            or picture of a managed chat, nor leave it.
//
// Kept in step: right after the selection changes, on the hook groupsChanged (any change — what a change
// means is found out by comparing: name, path, members and roles of every selected group; nothing that
// does not differ from the last sync is written), on the first background run after a start (no replay
// of changes missed while stopped) and every 6 hours to heal.
//
// A group that is deselected, archived or deleted (also: the hook groupDeleting, before it goes) — its chat
// is handed back like release_group: a normal group chat without sync, admins = its chat admins, i.e. the
// group's former leads (none: the member who joined first). An archived or deleted group also leaves the
// selection. A group of the kind 'family' is never synced here: Familie keeps the family chat itself
// (sync_group, key 'family'); selecting it is refused with the reason `family`.
//
// The hook groupUsage: „Gruppenchat <Titel>“ — „bleibt als normaler Chat ohne Abgleich“.
//
// An older GateControl (no gc.groups): nothing happens; the card says it needs GateControl 1.200.0.
//
// State (settings row `groupChatState`): { <groupId>: { hash, at, ok, error, conversationId, title, members } }.

const crypto = require('node:crypto');
const store = require('./store');
const log = require('./log');
const people = require('./people');
const config = require('./config');
const live = require('./live');
const conversations = require('./conversations');
const services = require('./services');
const { fail, isKnown, posInt } = require('./util');

const SELF = 'gatecontrol-messenger';
const SETTING = 'groupChats';
const STATE = 'groupChatState';
const MAX = 50;
const HEAL_MS = 6 * 3600000;
const ADMIN_ROLES = ['lead', 'deputy', 'admin'];
const OPTIONS_MAX = 500;
const KEY_RE = /^group:(\d{1,15})$/;

const keyOf = (id) => `group:${id}`;
// started: the first background run after a start syncs; running: one run at a time; lastRun: the last full run
const proc = { started: false, running: null, lastRun: 0 };

/** Does this GateControl hand out its groups (≥ 1.200.0)? */
const available = (gc) => !!(gc && gc.groups && typeof gc.groups.get === 'function' && typeof gc.groups.members === 'function');

async function readRow(gc, key, fallback) {
  const r = await store.one(gc, 'SELECT value FROM settings WHERE key = ?', [key]);
  if (!r) return fallback;
  try { return JSON.parse(r.value); } catch { return fallback; }
}
const writeRow = (gc, key, value) => store.run(gc, 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, JSON.stringify(value)]);

/** The selected group ids. */
async function selected(gc) {
  const v = await readRow(gc, SETTING, []);
  return Array.isArray(v) ? [...new Set(v.filter((x) => Number.isSafeInteger(x) && x > 0))].slice(0, MAX) : [];
}

async function loadState(gc) {
  const v = await readRow(gc, STATE, {});
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

/** A context like a service call's (no viewer); `flush` sends the queued events and pushes. */
async function context(gc, now) {
  return { gc, viewer: null, now, lang: 'de', users: await people.users(gc, now), cfg: await config.load(gc), portal: false, box: live.outbox() };
}
const flush = (ctx) => require('./api').flush(ctx);

/** The messenger's managed chats of GateControl groups → Map(groupId → conversation row). */
async function chats(gc) {
  const out = new Map();
  for (const r of await store.all(gc, "SELECT * FROM conversations WHERE managed_by = ? AND managed_key LIKE 'group:%'", [SELF])) {
    const m = KEY_RE.exec(r.managed_key || '');
    if (m) out.set(Number(m[1]), r);
  }
  return out;
}

/** What the chat of group `id` should be → { title, userIds, adminIds, hash } | { gone: 'deleted' | 'archived' | 'family' } | { error }. */
async function wanted(ctx, id) {
  const g = await ctx.gc.groups.get(id);
  if (!g) return { gone: 'deleted' };
  if (g.archived) return { gone: 'archived' };
  if (g.kind === 'family') return { gone: 'family', title: g.path || g.name };
  const list = await ctx.gc.groups.members(id, { nested: true });
  const userIds = [];
  const adminIds = [];
  for (const m of Array.isArray(list) ? list : []) {
    if (!m || m.enabled === false || !ctx.users.has(m.userId) || userIds.includes(m.userId)) continue;
    userIds.push(m.userId);
    if (m.direct && ADMIN_ROLES.includes(m.role)) adminIds.push(m.userId);
  }
  userIds.sort((a, b) => a - b);
  adminIds.sort((a, b) => a - b);
  const path = String(g.path || g.name || '').replace(/[\0-\x1f\x7f]/g, ' ').trim();
  const title = (path.length <= conversations.TITLE_MAX ? path : String(g.name || '').slice(0, conversations.TITLE_MAX).trim()) || `#${id}`;
  if (userIds.length > conversations.GROUP_MAX) return { error: 'too_many', title };
  const hash = crypto.createHash('sha256').update(JSON.stringify([title, userIds, adminIds])).digest('hex').slice(0, 16);
  return { title, userIds, adminIds, hash };
}

/** Hand the chat of group `id` back (a normal chat, admins = its chat admins) → true when there was one. */
async function release(ctx, id, reason) {
  const conv = await services.managed(ctx.gc, SELF, keyOf(id));
  if (!conv) return false;
  const admins = (await conversations.membersOf(ctx.gc, conv.id)).filter((m) => m.role === 'admin').map((m) => m.user_id);
  await store.tx(ctx.gc, () => services.releaseManaged(ctx, SELF, keyOf(id), { adminIds: admins }));
  // the plugin log of GateControl (the page „Protokoll“ lists errors and limits only)
  ctx.gc.log.info('group chat released', id, reason);
  return true;
}

/**
 * Bring every selected group's chat in step and hand back the chats of groups no longer selected (see the head
 * of this file) → { synced, released, dropped, errors }. o.force: write even when nothing differs.
 */
async function reconcile(gc, now, o = {}) {
  const out = { synced: 0, released: 0, dropped: [], errors: 0 };
  if (!available(gc)) return out;
  const ctx = await context(gc, now);
  const sel = await selected(gc);
  const state = await loadState(gc);
  const existing = await chats(gc);
  const keep = [];
  for (const id of sel) {
    let w;
    try { w = await wanted(ctx, id); } catch (e) { w = { error: (e && e.code) || 'error' }; }
    if (w.gone === 'deleted' || w.gone === 'archived') {
      try { if (await release(ctx, id, w.gone)) out.released++; } catch (e) { gc.log.warn('group chat release failed', id, (e && (e.code || e.message)) || 'error'); keep.push(id); continue; }
      out.dropped.push({ id, reason: w.gone });
      delete state[id];
      continue;
    }
    keep.push(id);
    if (w.gone === 'family') { state[id] = { ...(state[id] || {}), ok: false, error: 'family', title: w.title, at: now }; continue; }
    if (w.error) {
      if ((state[id] || {}).error !== w.error) await log.add(gc, 'group_chat_failed', `group ${id}: ${w.error}`, now);
      state[id] = { ...(state[id] || {}), ok: false, error: w.error, title: w.title || (state[id] || {}).title || null, at: now };
      out.errors++;
      continue;
    }
    const prev = state[id] || {};
    if (!o.force && prev.ok && prev.hash === w.hash && existing.has(id)) continue;
    const ev = ctx.box.events.length;
    const pu = ctx.box.pushes.length;
    const af = ctx.box.after.length;
    try {
      const r = await store.tx(gc, () => services.syncManaged(ctx, SELF, keyOf(id), w.title, w.userIds, { adminIds: w.adminIds }));
      state[id] = { hash: w.hash, at: now, ok: true, error: null, conversationId: r.conversationId, title: w.title, members: w.userIds.length };
      out.synced++;
    } catch (e) {
      // nothing of a rolled-back sync goes out
      ctx.box.events.length = ev;
      ctx.box.pushes.length = pu;
      ctx.box.after.length = af;
      const code = isKnown(e) ? e.code : ((e && e.code) || 'failed');
      gc.log.warn('group chat sync failed', id, (e && (e.code || e.message)) || 'error');
      if (prev.error !== code) await log.add(gc, 'group_chat_failed', `group ${id}: ${code}`, now);
      state[id] = { ...prev, ok: false, error: code, at: now };
      out.errors++;
    }
  }
  // chats of groups that are no longer selected
  for (const [id] of existing) {
    if (keep.includes(id)) continue;
    try { if (await release(ctx, id, 'deselected')) out.released++; } catch (e) { gc.log.warn('group chat release failed', id, (e && (e.code || e.message)) || 'error'); }
  }
  for (const k of Object.keys(state)) if (!keep.includes(Number(k))) delete state[k];
  await store.tx(gc, async () => {
    if (out.dropped.length) await writeRow(gc, SETTING, keep);
    await writeRow(gc, STATE, state);
  });
  await flush(ctx);
  return out;
}

/** One run of fn at a time (reconcile, groupDeleting); fn's errors are logged → its answer or null. */
async function serial(gc, what, fn) {
  while (proc.running) { try { await proc.running; } catch { /* logged by that run */ } }
  const p = fn().catch((e) => { gc.log.warn(what, (e && (e.code || e.message)) || 'error'); return null; });
  proc.running = p;
  try { return await p; } finally { if (proc.running === p) proc.running = null; }
}

/** reconcile, one at a time (never throws) → its answer or null. */
async function run(gc, now = Date.now(), o = {}) {
  if (!available(gc)) return null;
  const r = await serial(gc, 'group chats failed', () => reconcile(gc, now, o));
  if (r) proc.lastRun = now;
  return r;
}

/** Background (every minute): after a start and every 6 hours (only when something is selected or a chat is left). */
async function tick(gc, now) {
  if (!available(gc)) return null;
  if (proc.started && now - proc.lastRun < HEAL_MS) return null;
  proc.started = true;
  proc.lastRun = now;
  if (!(await selected(gc)).length && !(await chats(gc)).size) return null;
  return run(gc, now);
}

/** The hook groupsChanged: any change → compare and sync what differs. */
async function changed(gc, changes, now = Date.now()) {
  if (!available(gc) || !Array.isArray(changes) || !changes.length) return null;
  if (!(await selected(gc)).length && !(await chats(gc)).size) return null;
  return run(gc, now);
}

/** The hook groupDeleting: the group's chat is handed back before the group goes; it leaves the selection. */
async function deleting(gc, groupId, now = Date.now()) {
  const id = posInt(groupId);
  if (!id || !available(gc)) return false;
  const sel = await selected(gc);
  if (!sel.includes(id) && !(await chats(gc)).has(id)) return false;
  return (await serial(gc, 'group chat release failed', async () => {
    const ctx = await context(gc, now);
    const done = await release(ctx, id, 'deleted');
    const state = await loadState(gc);
    delete state[id];
    const keep = (await selected(gc)).filter((x) => x !== id);
    await store.tx(gc, async () => {
      await writeRow(gc, SETTING, keep);
      await writeRow(gc, STATE, state);
    });
    await flush(ctx);
    return done;
  })) === true;
}

/** The hook groupUsage: the chat of a selected group → [{ kind, label, onDelete }]. */
async function usage(gc, groupId) {
  const id = posInt(groupId);
  if (!id || !available(gc) || !(await selected(gc)).includes(id)) return [];
  const st = (await loadState(gc))[id];
  if (!st || st.error === 'family') return [];
  return [{ kind: 'Messenger', label: `Gruppenchat ${st.title || `#${id}`}`, onDelete: 'bleibt als normaler Chat ohne Abgleich' }];
}

/** The card on „Übersicht“ (admin API): { available, max, selected: [...], options: [...] }. */
async function view(gc) {
  if (!available(gc)) return { available: false, max: MAX, selected: [], options: [] };
  const sel = await selected(gc);
  const state = await loadState(gc);
  const items = [];
  for (const id of sel) {
    let g = null;
    try { g = await gc.groups.get(id); } catch { g = null; }
    const st = state[id] || {};
    items.push({
      id, path: g ? g.path : (st.title || null), kind: g ? g.kind : null, gone: !g, archived: !!(g && g.archived),
      members: Number.isSafeInteger(st.members) ? st.members : null, conversationId: st.conversationId || null,
      ok: !!st.ok, error: st.error || null, syncedAt: st.ok && Number.isFinite(st.at) ? new Date(st.at).toISOString() : null,
    });
  }
  let options = [];
  try {
    const list = await gc.groups.list();
    options = (Array.isArray(list) ? list : []).filter((g) => g && !g.archived).slice(0, OPTIONS_MAX)
      .map((g) => ({ id: g.id, path: g.path || g.name, kind: g.kind, family: g.kind === 'family' }));
  } catch { options = []; }
  return { available: true, max: MAX, selected: items, options };
}

/**
 * PUT admin/group-chats { groupIds: [id] } — the new selection (≤ 50). Unknown ids → invalid; family and archived
 * groups are left out and named in `skipped` [{ id, path, reason: 'family' | 'archived' }]. Synced (and released) at once.
 */
async function select(gc, body, now = Date.now()) {
  if (!available(gc)) throw fail('unavailable');
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b || !Array.isArray(b.groupIds) || b.groupIds.length > MAX) throw fail('invalid');
  const ids = [];
  for (const x of b.groupIds) {
    const id = posInt(x);
    if (!id) throw fail('invalid');
    if (!ids.includes(id)) ids.push(id);
  }
  const keep = [];
  const skipped = [];
  for (const id of ids) {
    const g = await gc.groups.get(id);
    if (!g) throw fail('invalid');
    if (g.kind === 'family') skipped.push({ id, path: g.path || g.name, reason: 'family' });
    else if (g.archived) skipped.push({ id, path: g.path || g.name, reason: 'archived' });
    else keep.push(id);
  }
  await store.tx(gc, () => writeRow(gc, SETTING, keep));
  const result = await run(gc, now);
  return { ...(await view(gc)), skipped, result };
}

function reset() { proc.started = false; proc.running = null; proc.lastRun = 0; }

module.exports = { SELF, SETTING, STATE, MAX, HEAL_MS, ADMIN_ROLES, keyOf, available, selected, loadState, reconcile, run, tick, changed, deleting, usage, view, select, reset, _proc: proc };
