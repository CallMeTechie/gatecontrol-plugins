'use strict';

// Shared GateControl calendars (since 1.9.0, mockup Teilen): a person shares an own GateControl calendar (source 'local')
// with people or person groups of GateControl (gc.groups) at one of three levels —
//   freebusy  only when they are busy (no titles)
//   read      titles, places and times
//   write     also new events and changes (without attendees: invitations stay the owner's)
// Events marked private are „Gebucht“ at every level and never open. The recipient shows a calendar under „Mit mir
// geteilt“ (cal_shared); the owner sees „hat angenommen“ once they did. Calendars of accounts (Exchange, Google) are
// shared at the provider — what the sync brings (Graph `owner`) is listed beside them.
//
//   GET calendars/<id>/shares · POST calendars/<id>/shares · PATCH/DELETE calendars/<id>/shares/<shareId>
//   GET shared · PATCH shared/<calendarId> · GET principals?q=
// Live event `calendar` { kind: 'shares' } to the recipients (and the owner) when a share changes; a change in a shared
// calendar goes to its recipients as `calendar` { kind: 'changed', calendarId } (pimstore.touchCalendar).

const store = require('./store');
const config = require('./config');
const pimstore = require('./pimstore');
const push = require('./push');
const { t } = require('./text');
const { fail, posInt, clip } = require('./util');

const LEVELS = ['freebusy', 'read', 'write'];
const RANK = { freebusy: 1, read: 2, write: 3 };
const SHARES_MAX = 50;

const userName = async (gc, id) => { try { const u = await gc.users.get(id); return (u && u.name) || ''; } catch { return ''; } };

/** A membership test that asks GateControl once per group. */
function memberOf(gc, userId) {
  const cache = new Map();
  return async (groupId) => {
    if (!cache.has(groupId)) {
      let v = false;
      if (gc.groups && typeof gc.groups.isMember === 'function') { try { v = await gc.groups.isMember(userId, groupId, { nested: true }); } catch { v = false; } }
      cache.set(groupId, v);
    }
    return cache.get(groupId);
  };
}

/** May the person use sharing (the administrator)? */
async function check(gc) {
  const cfg = await config.get(gc);
  if (!cfg.calendar.sharing) throw fail('feature_off', { feature: 'sharing' });
  return cfg;
}

/**
 * The calendars shared with person `userId` → Map calendarId → { cal, level, via: 'user'|'group', groupId } (the highest
 * level of a direct share and the shares to their groups). Own calendars never.
 */
async function sharedWith(gc, userId) {
  const cfg = await config.get(gc);
  const out = new Map();
  if (!cfg.calendar.enabled || !cfg.calendar.sharing) return out;
  const rows = await store.all(gc, `SELECT s.*, c.user_id AS owner FROM cal_shares s JOIN calendars c ON c.id = s.calendar_id
    WHERE c.source = 'local' AND c.user_id <> ? AND ((s.type = 'user' AND s.principal_id = ?) OR s.type = 'group') ORDER BY s.id`, [userId, userId]);
  const member = memberOf(gc, userId);
  for (const s of rows) {
    if (s.type === 'group' && !(await member(s.principal_id))) continue;
    const have = out.get(s.calendar_id);
    if (have && RANK[have.level] >= RANK[s.level]) continue;
    out.set(s.calendar_id, { level: s.level, via: s.type, groupId: s.type === 'group' ? s.principal_id : null, owner: s.owner });
  }
  // the owner must still be someone who may use Mail
  for (const [id, x] of [...out]) if (!(await config.allowed(gc, cfg, x.owner))) out.delete(id);
  return out;
}

/** The level of person `userId` on calendar `cal` (a row): 'owner' | 'write' | 'read' | 'freebusy' | null. */
async function levelOf(gc, userId, cal) {
  if (!cal) return null;
  if (cal.user_id === userId) return 'owner';
  if (cal.source !== 'local') return null;
  const x = (await sharedWith(gc, userId)).get(cal.id);
  return x ? x.level : null;
}

/** An own GateControl calendar of the person to share (404 for anyone else's, 409 not_supported for an account's). */
async function ownLocal(gc, userId, id) {
  const c = await pimstore.ownCalendar(gc, userId, id);
  if (c.source !== 'local') throw fail('not_supported', { what: 'share' });
  return c;
}

/** The people a share reaches (a group: its members with the subgroups), at most 500. */
async function reach(gc, s) {
  if (s.type === 'user') return [s.principal_id];
  if (!gc.groups || typeof gc.groups.members !== 'function') return [];
  try { return (await gc.groups.members(s.principal_id, { nested: true })).filter((m) => m.enabled !== false).map((m) => m.userId).slice(0, 500); } catch { return []; }
}

/** Everybody calendar `calId` is shared with (users and the members of groups), without its owner. */
async function recipients(gc, calId, ownerId) {
  const out = new Set();
  for (const s of await store.all(gc, 'SELECT * FROM cal_shares WHERE calendar_id = ?', [calId])) for (const u of await reach(gc, s)) out.add(u);
  out.delete(ownerId);
  return [...out];
}

async function liveTo(gc, users, data) {
  for (const part of store.chunks([...new Set(users)].filter((u) => Number.isSafeInteger(u) && u > 0), 500)) {
    if (!part.length) continue;
    try { await gc.events.emit({ users: part, type: 'calendar', data }); } catch { /* nobody listening */ }
  }
}

/** A share row → the Share of the API. */
async function shareView(gc, s) {
  if (s.type === 'user') {
    const seen = await store.one(gc, 'SELECT accepted_at FROM cal_shared WHERE user_id = ? AND calendar_id = ?', [s.principal_id, s.calendar_id]);
    return { id: s.id, type: 'user', principalId: s.principal_id, name: await userName(gc, s.principal_id), level: s.level, state: seen && seen.accepted_at ? 'accepted' : 'pending', members: null, createdAt: s.created_at };
  }
  let g = null;
  try { g = gc.groups && typeof gc.groups.get === 'function' ? await gc.groups.get(s.principal_id) : null; } catch { g = null; }
  return { id: s.id, type: 'group', principalId: s.principal_id, name: g ? g.path || g.name : '', level: s.level, state: 'group', members: g ? (g.totalMemberCount != null ? g.totalMemberCount : g.memberCount || 0) : 0, createdAt: s.created_at };
}

/** GET calendars/<id>/shares → { items: [Share], freeBusy } (freeBusy: the person's „Frei/Gebucht für alle in GateControl“) */
async function list(gc, ctx, calId) {
  await check(gc);
  const c = await ownLocal(gc, ctx.userId, calId);
  const items = [];
  for (const s of await store.all(gc, 'SELECT * FROM cal_shares WHERE calendar_id = ? ORDER BY id', [c.id])) items.push(await shareView(gc, s));
  return { items, freeBusy: (await pimstore.calPrefs(gc, ctx.userId)).prefs.freeBusy };
}

/** POST calendars/<id>/shares { type: 'user'|'group', id, level } → { share } (again for the same principal: the new level) */
async function add(gc, ctx, calId, b) {
  await check(gc);
  const c = await ownLocal(gc, ctx.userId, calId);
  const type = b.type === 'group' ? 'group' : b.type === 'user' ? 'user' : null;
  const pid = posInt(b.id);
  if (!type) throw fail('invalid', { field: 'type' });
  if (!pid) throw fail('invalid', { field: 'id' });
  if (!LEVELS.includes(b.level)) throw fail('invalid', { field: 'level' });
  if (type === 'user') {
    if (pid === ctx.userId) throw fail('invalid', { field: 'id' });
    let u = null;
    try { u = await gc.users.get(pid); } catch { u = null; }
    if (!u) throw fail('not_found');
  } else {
    let g = null;
    try { g = gc.groups && typeof gc.groups.get === 'function' ? await gc.groups.get(pid) : null; } catch { g = null; }
    if (!g || g.archived) throw fail('not_found');
  }
  const now = Date.now();
  const have = await store.one(gc, 'SELECT * FROM cal_shares WHERE calendar_id = ? AND type = ? AND principal_id = ?', [c.id, type, pid]);
  if (have) await store.run(gc, 'UPDATE cal_shares SET level = ?, updated_at = ? WHERE id = ?', [b.level, now, have.id]);
  else {
    const n = await store.one(gc, 'SELECT COUNT(*) AS n FROM cal_shares WHERE calendar_id = ?', [c.id]);
    if (n.n >= SHARES_MAX) throw fail('limit', { max: SHARES_MAX });
    await store.run(gc, 'INSERT INTO cal_shares (calendar_id, owner_id, type, principal_id, level, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [c.id, ctx.userId, type, pid, b.level, now, now]);
  }
  const s = await store.one(gc, 'SELECT * FROM cal_shares WHERE calendar_id = ? AND type = ? AND principal_id = ?', [c.id, type, pid]);
  await liveTo(gc, [...await reach(gc, s), ctx.userId], { kind: 'shares', calendarId: c.id });
  // a person (not a group) hears of a new share once
  if (!have && type === 'user') {
    const lang = await push.langOf(gc, pid);
    try {
      await gc.notify({ topic: 'calendar_share', users: [pid], collapseKey: `share:${c.id}`, title: clip(ctx.userName || await userName(gc, ctx.userId) || 'GateControl', 120),
        body: clip(t(lang, 'push.share', { name: c.name, level: t(lang, `share.level_${b.level}`) }), 300), data: { calendar: { sharedCalendarId: c.id } } });
    } catch (e) { gc.log.warn('share push failed', (e && (e.code || e.message)) || 'error'); }
  }
  return { share: await shareView(gc, s) };
}

async function ownShare(gc, ctx, calId, shareId) {
  await check(gc);
  const c = await ownLocal(gc, ctx.userId, calId);
  const s = Number.isSafeInteger(shareId) ? await store.one(gc, 'SELECT * FROM cal_shares WHERE id = ? AND calendar_id = ?', [shareId, c.id]) : null;
  if (!s) throw fail('not_found');
  return { c, s };
}

/** PATCH calendars/<id>/shares/<shareId> { level } → { share } */
async function patch(gc, ctx, calId, shareId, b) {
  const { c, s } = await ownShare(gc, ctx, calId, shareId);
  if (!LEVELS.includes(b.level)) throw fail('invalid', { field: 'level' });
  await store.run(gc, 'UPDATE cal_shares SET level = ?, updated_at = ? WHERE id = ?', [b.level, Date.now(), s.id]);
  await liveTo(gc, [...await reach(gc, s), ctx.userId], { kind: 'shares', calendarId: c.id });
  return { share: await shareView(gc, await store.one(gc, 'SELECT * FROM cal_shares WHERE id = ?', [s.id])) };
}

/** DELETE calendars/<id>/shares/<shareId> → { ok } */
async function remove(gc, ctx, calId, shareId) {
  const { c, s } = await ownShare(gc, ctx, calId, shareId);
  const who = await reach(gc, s);
  await store.run(gc, 'DELETE FROM cal_shares WHERE id = ?', [s.id]);
  if (s.type === 'user') await store.run(gc, 'DELETE FROM cal_shared WHERE user_id = ? AND calendar_id = ?', [s.principal_id, c.id]);
  await liveTo(gc, [...who, ctx.userId], { kind: 'shares', calendarId: c.id });
  return { ok: true };
}

/** The SharedCalendar of calendar row `c` for its recipient. */
async function sharedView(gc, userId, c, x, names) {
  const mine = await store.one(gc, 'SELECT * FROM cal_shared WHERE user_id = ? AND calendar_id = ?', [userId, c.id]);
  if (!names.has(c.user_id)) names.set(c.user_id, await userName(gc, c.user_id));
  let group = null;
  if (x.via === 'group') { try { const g = await gc.groups.get(x.groupId); group = g ? g.name : null; } catch { group = null; } }
  return {
    id: c.id, name: c.name, color: (mine && mine.color) || c.color, owner: { userId: c.user_id, name: names.get(c.user_id) }, level: x.level, via: x.via, group,
    visible: !!(mine && mine.visible), accepted: !!(mine && mine.accepted_at), writable: x.level === 'write',
  };
}

/**
 * GET shared → { items: [SharedCalendar], accounts: [{ calendarId, accountId, name, color, owner, writable, visible }] } —
 * GateControl calendars shared with the person, and calendars of their accounts that belong to another mailbox (as far
 * as the sync brings them: Microsoft 365).
 */
async function shared(gc, ctx) {
  const cfg = await check(gc);
  const map = await sharedWith(gc, ctx.userId);
  const names = new Map();
  const items = [];
  for (const [id, x] of map) {
    const c = await store.one(gc, 'SELECT * FROM calendars WHERE id = ?', [id]);
    if (c) items.push(await sharedView(gc, ctx.userId, c, x, names));
  }
  items.sort((a, b) => a.owner.name.localeCompare(b.owner.name) || a.name.localeCompare(b.name));
  const accounts = [];
  if (cfg.calendar.accounts) {
    for (const c of await store.all(gc, "SELECT c.*, a.email AS acc_email, a.calendar_sync FROM calendars c JOIN accounts a ON a.id = c.account_id WHERE c.user_id = ? AND c.source = 'graph' AND c.owner_email IS NOT NULL", [ctx.userId])) {
      if (c.calendar_sync === 0 || c.owner_email === String(c.acc_email).toLowerCase()) continue;
      accounts.push({ calendarId: c.id, accountId: c.account_id, name: c.name, color: c.color, owner: { email: c.owner_email }, writable: c.writable === 1, visible: c.visible === 1 });
    }
  }
  return { items, accounts };
}

/** PATCH shared/<calendarId> { visible?, color? } → { item } — shown under „Mit mir geteilt“ (the first time: accepted). */
async function patchShared(gc, ctx, calId, b) {
  await check(gc);
  const x = (await sharedWith(gc, ctx.userId)).get(calId);
  if (!x) throw fail('not_found');
  const c = await store.one(gc, 'SELECT * FROM calendars WHERE id = ?', [calId]);
  if (b.visible !== undefined && typeof b.visible !== 'boolean') throw fail('invalid', { field: 'visible' });
  const color = b.color === undefined ? undefined : pimstore.colorArg(b.color);
  if (b.color !== undefined && b.color !== null && !color) throw fail('invalid', { field: 'color' });
  const have = await store.one(gc, 'SELECT * FROM cal_shared WHERE user_id = ? AND calendar_id = ?', [ctx.userId, calId]);
  const visible = b.visible !== undefined ? (b.visible ? 1 : 0) : (have ? have.visible : 0);
  const col = b.color !== undefined ? color : (have ? have.color : null);
  const accepted = (have && have.accepted_at) || (visible ? Date.now() : null);
  await store.run(gc, `INSERT INTO cal_shared (user_id, calendar_id, visible, color, accepted_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, calendar_id) DO UPDATE SET visible = excluded.visible, color = excluded.color, accepted_at = excluded.accepted_at`, [ctx.userId, calId, visible, col, accepted]);
  if (!(have && have.accepted_at) && accepted) await liveTo(gc, [c.user_id], { kind: 'shares', calendarId: calId });
  return { item: await sharedView(gc, ctx.userId, c, x, new Map()) };
}

/**
 * GET principals?q= → { items: [{ type: 'user'|'group', id, name, sub }] } — people of this GateControl who may use Mail
 * and person groups whose name has `q` (≥ 2 characters; ≤ 20), to share with. Never addresses.
 */
async function principals(gc, ctx, q) {
  const text = String(q || '').trim().toLowerCase().slice(0, 60);
  if (text.length < 2) return { items: [] };
  const cfg = await config.get(gc);
  const items = [];
  let users = [];
  try { users = await gc.users.list(); } catch { users = []; }
  for (const u of users) {
    if (u.id === ctx.userId || !String(u.name || '').toLowerCase().includes(text)) continue;
    if (!(await config.allowed(gc, cfg, u.id))) continue;
    items.push({ type: 'user', id: u.id, name: u.name, sub: null, initials: u.initials || null, color: u.colorHex || null });
    if (items.length >= 12) break;
  }
  if (gc.groups && typeof gc.groups.list === 'function') {
    let groups = [];
    try { groups = await gc.groups.list(); } catch { groups = []; }
    for (const g of groups) {
      if (g.archived || !(`${g.name} ${g.path || ''}`).toLowerCase().includes(text)) continue;
      items.push({ type: 'group', id: g.id, name: g.name, sub: g.path && g.path !== g.name ? g.path : null, members: g.totalMemberCount != null ? g.totalMemberCount : (g.memberCount || null) });
      if (items.length >= 20) break;
    }
  }
  return { items };
}

// ─── events of shared calendars ─────────────────

/** The shared calendars of the person to show (visible, or those asked for by id) → [{ cal, level }]. */
async function shownCalendars(gc, userId, want) {
  const map = await sharedWith(gc, userId);
  const out = [];
  for (const [id, x] of map) {
    if (want) { if (!want.includes(String(id))) continue; } else {
      const mine = await store.one(gc, 'SELECT visible FROM cal_shared WHERE user_id = ? AND calendar_id = ?', [userId, id]);
      if (!mine || mine.visible !== 1) continue;
    }
    const cal = await store.one(gc, 'SELECT * FROM calendars WHERE id = ?', [id]);
    if (cal) out.push({ cal, level: x.level });
  }
  return out;
}

/**
 * The occurrences of shared calendars in [from, to) as person `userId` may see them: freebusy (and every private
 * event) only „Gebucht“ / „Vorläufig“ without anything else and without eventId; read: title, place, times; write: the
 * same, editable. → [Occurrence + { shared: level }]
 */
async function items(gc, ctx, from, to, want) {
  const calendars = require('./calendars');
  const out = [];
  for (const { cal, level } of await shownCalendars(gc, ctx.userId, want)) {
    const list = await calendars.occurrences(gc, cal.user_id, [cal.id], from, to, 2000);
    let i = 0;
    for (const o of list) {
      i++;
      if (level === 'freebusy' || o.private) {
        const st = busyOf(o);
        if (!st) continue;
        out.push({
          key: `s:${cal.id}:${i}:${o.start}`, eventId: null, calendarId: cal.id, occurrence: null, title: t(ctx.lang, st === 'tentative' ? 'fb.tentative' : 'fb.busy'), start: o.start, end: o.end, allDay: o.allDay,
          ...(o.allDay ? { startDate: o.startDate, endDate: o.endDate } : {}), timeZone: o.timeZone, location: null, online: null, status: 'confirmed', busy: st, myResponse: null,
          recurring: false, attendees: 0, private: true, reminder: null, shared: level,
        });
        continue;
      }
      out.push({ ...o, myResponse: null, reminder: null, ...(level === 'read' ? { online: null } : {}), shared: level });
    }
  }
  return out;
}

/** What an occurrence makes its person: 'busy' | 'tentative' | null (free, cancelled, declined). */
function busyOf(o) {
  if (o.status === 'cancelled' || o.myResponse === 'declined' || o.busy === 'free') return null;
  if (o.private) return 'busy';
  if (o.busy === 'tentative' || o.status === 'tentative' || o.myResponse === 'tentative' || o.myResponse === 'needs_action') return 'tentative';
  return 'busy';
}

/** An event of a calendar shared with the person at read or write (never a private one) → { ev, cal, level } or 404. */
async function sharedEvent(gc, userId, id) {
  const ev = Number.isSafeInteger(id) ? await store.one(gc, 'SELECT * FROM events WHERE id = ?', [id]) : null;
  if (!ev || ev.user_id === userId || ev.private === 1) throw fail('not_found');
  const cal = await store.one(gc, 'SELECT * FROM calendars WHERE id = ?', [ev.calendar_id]);
  const level = await levelOf(gc, userId, cal);
  if (level !== 'read' && level !== 'write') throw fail('not_found');
  return { ev, cal, level };
}

/** GET events/<id> of a shared calendar: read → title, place, times (no description, attendees); write → editable. */
async function getEvent(gc, ctx, id, q) {
  const { ev, cal, level } = await sharedEvent(gc, ctx.userId, id);
  const occ = typeof q.occurrence === 'string' && q.occurrence ? q.occurrence : null;
  const full = await require('./calendars').full(gc, cal.user_id, ev, cal, occ);
  if (full.private) throw fail('not_found');
  const base = { ...full, myResponse: null, reminder: null, reminders: [], canRespond: false, invitationId: null, shared: level };
  if (level === 'write') return { ...base, readOnly: false, canEdit: true, canDelete: true };
  return { ...base, description: '', descriptionHtml: null, organizer: null, attendees: [], attendeesCount: full.attendees.length, online: null, url: null, categories: [], readOnly: true, canEdit: false, canDelete: false };
}

/**
 * The context to write with into a calendar shared at `write` (the owner's; attendees are the owner's business — 409
 * not_supported { what: 'shared_attendees' }). Own calendars: `ctx` itself.
 */
async function writeCtx(gc, ctx, calId, b) {
  const id = posInt(calId);
  if (!id) return ctx;
  const cal = await store.one(gc, 'SELECT * FROM calendars WHERE id = ?', [id]);
  if (!cal || cal.user_id === ctx.userId) return ctx;
  const level = await levelOf(gc, ctx.userId, cal);
  if (!level) throw fail('not_found');
  if (level !== 'write') throw fail('read_only');
  if (b && Array.isArray(b.attendees) && b.attendees.length) throw fail('not_supported', { what: 'shared_attendees' });
  return { ...ctx, userId: cal.user_id, actorId: ctx.userId, userName: await userName(gc, cal.user_id) };
}

/** The context to change event `id` of another person with (a calendar shared at write; never a private event). */
async function eventCtx(gc, ctx, id, b) {
  const own = Number.isSafeInteger(id) ? await store.one(gc, 'SELECT user_id FROM events WHERE id = ?', [id]) : null;
  if (!own || own.user_id === ctx.userId) return ctx;
  const { cal, level } = await sharedEvent(gc, ctx.userId, id);
  if (level !== 'write') throw fail('read_only');
  if (b && b.attendees !== undefined) throw fail('not_supported', { what: 'shared_attendees' });
  return { ...ctx, userId: cal.user_id, actorId: ctx.userId, userName: await userName(gc, cal.user_id) };
}

module.exports = {
  LEVELS, sharedWith, levelOf, recipients, list, add, patch, remove, shared, patchShared, principals, items, busyOf, getEvent, writeCtx, eventCtx, shownCalendars,
};
