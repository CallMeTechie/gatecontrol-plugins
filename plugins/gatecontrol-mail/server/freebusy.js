'use strict';

// Free/busy (since 1.9.0, mockup Planer): when the people of an event and its resources are busy — never titles.
//
//   within GateControl  a person with a Mail address (their accounts): all their calendars but iCal subscriptions,
//                       unless they switched „Frei/Gebucht für alle in GateControl“ off (CalPrefs.freeBusy) — then only
//                       the calendars they shared with the asker (at any level), else „unbekannt“
//   Microsoft 365       colleagues of the asker's Microsoft 365 account (the same domain): Graph getSchedule with the
//                       account's Calendars.ReadWrite — without it, or when Graph refuses, „unbekannt“, never an error
//   resources           their bookings (confirmed: busy, a request: tentative)
//   anyone else         „unbekannt“
// Private events are „busy“, whatever they are. Suggestions: the next slots in the asker's working hours (CalPrefs.
// workHours) when everybody known is free.
//
//   POST freebusy { from, to, attendees: [email], resources?: [id] } → { from, to, items: [Row] }
//   POST freebusy/suggest { duration, from?, to?, attendees, resources?, limit? } → { items: [{ start, end }], unknown, workHours, timeZone }

const store = require('./store');
const config = require('./config');
const tz = require('./tz');
const ms = require('./microsoft');
const pimstore = require('./pimstore');
const resources = require('./resources');
const shares = require('./shares');
const { fail, email, posInt, DAY } = require('./util');

const RANGE_MAX = 31 * DAY;
const SUGGEST_MAX = 14 * DAY;
const ATTENDEES_MAX = 50;
const STEP = 30 * 60000;

async function check(gc) {
  const cfg = await config.get(gc);
  if (!cfg.calendar.freeBusy) throw fail('feature_off', { feature: 'freeBusy' });
  return cfg;
}

const numArg = (v, field) => {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^-?\d{1,15}$/.test(v) ? Number(v) : NaN);
  if (!Number.isSafeInteger(n)) throw fail('invalid', { field });
  return n;
};

/** Blocks [{ start, end, status }] → sorted, without overlaps; where both meet, busy wins over tentative. */
function merge(list) {
  const pts = [...new Set(list.flatMap((b) => [b.start, b.end]))].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const z = pts[i + 1];
    let st = null;
    for (const b of list) if (b.start < z && b.end > a) { st = b.status === 'busy' ? 'busy' : (st || 'tentative'); if (st === 'busy') break; }
    if (!st) continue;
    const last = out[out.length - 1];
    if (last && last.end === a && last.status === st) last.end = z;
    else out.push({ start: a, end: z, status: st });
  }
  return out;
}

/** The busy blocks of person `userId` in [from, to) from calendars `calIds` (no titles). */
async function personBlocks(gc, userId, calIds, from, to) {
  if (!calIds.length) return [];
  const list = await require('./calendars').occurrences(gc, userId, calIds, from, to, 5000);
  const out = [];
  for (const o of list) {
    const st = shares.busyOf(o);
    if (st) out.push({ start: Math.max(from, o.start), end: Math.min(to, o.end), status: st });
  }
  return merge(out.filter((b) => b.end > b.start));
}

/** The calendars of person `userId` that count for asker `askerId` (null: free/busy unknown). */
async function countingCalendars(gc, cfg, userId, askerId) {
  const all = (await store.all(gc, "SELECT c.id, c.source, c.account_id, a.calendar_sync FROM calendars c LEFT JOIN accounts a ON a.id = c.account_id WHERE c.user_id = ? AND c.source <> 'ics'", [userId]))
    .filter((c) => c.account_id == null || (cfg.calendar.accounts && c.calendar_sync !== 0));
  if (userId === askerId) return all.map((c) => c.id);
  const prefs = (await pimstore.calPrefs(gc, userId, cfg)).prefs;
  if (prefs.freeBusy) return all.map((c) => c.id);
  // switched off: only what the person shared with the asker
  const out = [];
  for (const c of all) {
    if (c.source !== 'local') continue;
    const lv = await shares.levelOf(gc, askerId, { id: c.id, user_id: userId, source: 'local' });
    if (lv) out.push(c.id);
  }
  return out.length ? out : null;
}

/** GateControl people behind addresses → Map email → userId (people who may use Mail). */
async function peopleOf(gc, cfg, emails) {
  const out = new Map();
  for (const part of store.chunks([...new Set(emails)], 80)) {
    if (!part.length) continue;
    for (const r of await store.all(gc, `SELECT email, user_id FROM accounts WHERE email IN (${store.marks(part.length)})`, part)) {
      if (!out.has(r.email) && await config.allowed(gc, cfg, r.user_id)) out.set(r.email, r.user_id);
    }
  }
  return out;
}

const graphTime = (x) => {
  if (!x || typeof x.dateTime !== 'string') return null;
  const s = x.dateTime.replace(/\.\d+$/, '');
  const v = Date.parse(/Z$|[+-]\d\d:\d\d$/.test(s) ? s : s + 'Z');
  return Number.isFinite(v) ? v : null;
};
const GRAPH_STATUS = { busy: 'busy', oof: 'busy', workingElsewhere: 'busy', tentative: 'tentative' };

/**
 * Microsoft 365 colleagues: getSchedule over the asker's Microsoft 365 account of the same domain (with the calendar
 * scope) → Map email → blocks (null for the unknown ones). Never throws.
 */
async function microsoft(gc, cfg, askerId, emails, from, to) {
  const out = new Map();
  if (!emails.length || !cfg.calendar.accounts) return out;
  const all = await store.all(gc, "SELECT * FROM accounts WHERE user_id = ? AND provider = 'm365' AND calendar_sync <> 0 ORDER BY id", [askerId]);
  const accounts = all.filter((a) => ms.hasScope(ms.grantedScopes(a), config.MS_CALENDAR_SCOPE));
  // colleagues of an account without the calendar right: Microsoft 365 people, „unbekannt“ (Account.missingScopes says why)
  for (const a of all) {
    if (accounts.includes(a)) continue;
    const domain = String(a.email).split('@')[1];
    for (const e of emails) if (e.split('@')[1] === domain && !out.has(e)) out.set(e, null);
  }
  for (const a of accounts) {
    const domain = String(a.email).split('@')[1];
    const mine = emails.filter((e) => (!out.has(e) || out.get(e) === null) && e.split('@')[1] === domain).slice(0, 20);
    if (!mine.length) continue;
    let r;
    try {
      r = await ms.graph(gc, a, 'POST', '/me/calendar/getSchedule', {
        schedules: mine, startTime: { dateTime: new Date(from).toISOString().replace('Z', ''), timeZone: 'UTC' },
        endTime: { dateTime: new Date(to).toISOString().replace('Z', ''), timeZone: 'UTC' }, availabilityViewInterval: 15,
      }, { soft403: true, headers: { prefer: 'outlook.timezone="UTC"' } });
    } catch { r = null; }
    if (!r || r.status >= 300 || !r.json || !Array.isArray(r.json.value)) { for (const e of mine) out.set(e, null); continue; }
    for (const e of mine) out.set(e, null);
    for (const x of r.json.value) {
      const e = email(x && x.scheduleId);
      if (!e || !mine.includes(e) || x.error) continue;
      const blocks = [];
      for (const it of Array.isArray(x.scheduleItems) ? x.scheduleItems : []) {
        const st = GRAPH_STATUS[it && it.status];
        const s = graphTime(it && it.start);
        const z = graphTime(it && it.end);
        if (st && s != null && z != null && z > s) blocks.push({ start: Math.max(from, s), end: Math.min(to, z), status: st });
      }
      out.set(e, merge(blocks.filter((b) => b.end > b.start)));
    }
  }
  return out;
}

/** The rows of free/busy for asker `ctx` in [from, to). */
async function rows(gc, ctx, cfg, from, to, attendees, resourceIds) {
  const own = await pimstore.ownAddresses(gc, ctx.userId);
  const items = [];
  const names = new Map();
  const nameOf = async (id) => { if (!names.has(id)) { let n = ''; try { const u = await gc.users.get(id); n = (u && u.name) || ''; } catch { n = ''; } names.set(id, n); } return names.get(id); };
  // the asker
  items.push({ key: 'self', kind: 'self', email: null, resourceId: null, userId: ctx.userId, name: await nameOf(ctx.userId), state: 'ok',
    blocks: await personBlocks(gc, ctx.userId, await countingCalendars(gc, cfg, ctx.userId, ctx.userId), from, to) });
  const resIds = [...new Set([...resourceIds, ...attendees.map(resources.idOf).filter((x) => x != null)])];
  const people = attendees.filter((e) => !resources.isAddress(e) && !own.has(e));
  const gcPeople = await peopleOf(gc, cfg, people);
  const rest = people.filter((e) => !gcPeople.has(e));
  const msRows = await microsoft(gc, cfg, ctx.userId, rest, from, to);
  for (const e of people) {
    const uid = gcPeople.get(e);
    if (uid === ctx.userId) continue;
    if (uid) {
      const cals = await countingCalendars(gc, cfg, uid, ctx.userId);
      items.push({ key: e, kind: 'person', email: e, resourceId: null, userId: uid, name: await nameOf(uid), state: cals ? 'ok' : 'unknown', blocks: cals ? await personBlocks(gc, uid, cals, from, to) : [] });
      continue;
    }
    const m = msRows.get(e);
    if (msRows.has(e)) items.push({ key: e, kind: 'microsoft', email: e, resourceId: null, userId: null, name: e, state: m ? 'ok' : 'unknown', blocks: m || [] });
    else items.push({ key: e, kind: 'external', email: e, resourceId: null, userId: null, name: e, state: 'unknown', blocks: [] });
  }
  for (const id of resIds) {
    const r = await resources.get(gc, id);
    if (!r || !cfg.resources.enabled || !(await resources.mayBook(gc, r, ctx.userId))) {
      items.push({ key: `resource:${id}`, kind: 'resource', email: resources.addressOf(id), resourceId: id, userId: null, name: '', state: 'unknown', blocks: [] });
      continue;
    }
    const bl = (await resources.blocks(gc, id, from, to)).map((b) => ({ start: Math.max(from, b.start), end: Math.min(to, b.end), status: b.status === 'busy' ? 'busy' : 'tentative' }));
    items.push({ key: `resource:${id}`, kind: 'resource', email: resources.addressOf(id), resourceId: id, userId: null, name: r.name, state: 'ok', blocks: merge(bl) });
  }
  return items;
}

function argsOf(b) {
  const attendees = [];
  if (b.attendees != null) {
    if (!Array.isArray(b.attendees) || b.attendees.length > ATTENDEES_MAX) throw fail('invalid', { field: 'attendees' });
    for (const a of b.attendees) {
      const e = email(typeof a === 'string' ? a : a && a.email);
      if (!e) throw fail('invalid', { field: 'attendees' });
      if (!attendees.includes(e)) attendees.push(e);
    }
  }
  const res = [];
  if (b.resources != null) {
    if (!Array.isArray(b.resources) || b.resources.length > 20) throw fail('invalid', { field: 'resources' });
    for (const r of b.resources) { const id = posInt(r); if (!id) throw fail('invalid', { field: 'resources' }); if (!res.includes(id)) res.push(id); }
  }
  return { attendees, res };
}

/** POST freebusy { from, to, attendees, resources? } → { from, to, items: [{ key, kind, email, resourceId, userId, name, state, blocks }] } */
async function query(gc, ctx, b) {
  const cfg = await check(gc);
  await pimstore.ensureSetup(gc, ctx.userId, ctx.lang);
  const from = numArg(b.from, 'from');
  const to = numArg(b.to, 'to');
  if (to <= from || to - from > RANGE_MAX) throw fail('invalid', { field: 'to' });
  const { attendees, res } = argsOf(b);
  return { from, to, items: await rows(gc, ctx, cfg, from, to, attendees, res) };
}

/**
 * POST freebusy/suggest { duration (minutes, 5…1440), from?, to?, attendees, resources?, limit? (1…10, 4) } →
 * { items: [{ start, end }], unknown: [key], workHours, timeZone } — slots of `duration` in the working hours of the asker
 * (their zone) from `from` (now, at the next half hour) up to `to` (≤ 14 days) where the asker, every known person and
 * every resource is free (tentative counts as taken); they do not overlap.
 */
async function suggest(gc, ctx, b) {
  const cfg = await check(gc);
  await pimstore.ensureSetup(gc, ctx.userId, ctx.lang);
  const duration = Number(b.duration);
  if (!Number.isInteger(duration) || duration < 5 || duration > 1440) throw fail('invalid', { field: 'duration' });
  const now = Date.now();
  let from = b.from != null ? numArg(b.from, 'from') : now;
  from = Math.max(from, now);
  from = Math.ceil(from / STEP) * STEP;
  const to = b.to != null ? numArg(b.to, 'to') : from + 7 * DAY;
  if (to <= from || to - from > SUGGEST_MAX) throw fail('invalid', { field: 'to' });
  const limit = Math.min(Math.max(Number.isInteger(b.limit) ? b.limit : 4, 1), 10);
  const { attendees, res } = argsOf(b);
  const list = await rows(gc, ctx, cfg, from, to, attendees, res);
  const busy = merge(list.filter((r) => r.state === 'ok').flatMap((r) => r.blocks.map((x) => ({ ...x, status: 'busy' }))));
  const { prefs } = await pimstore.calPrefs(gc, ctx.userId, cfg);
  const zone = prefs.timeZone;
  const wh = prefs.workHours;
  const len = duration * 60000;
  const items = [];
  const taken = (s, e) => busy.some((x) => x.start < e && x.end > s);
  for (let day = tz.localDate(from, zone); items.length < limit; day = tz.addDays(day, 1)) {
    const dayStart = tz.at(day, { hh: 0, mm: 0 }, zone);
    if (dayStart >= to) break;
    const wd = ((tz.weekday(day) + 6) % 7) + 1;
    if (!wh.days.includes(wd)) continue;
    const winA = tz.at(day, tz.parseTime(wh.from), zone);
    const winZ = wh.to === '24:00' ? tz.at(tz.addDays(day, 1), { hh: 0, mm: 0 }, zone) : tz.at(day, tz.parseTime(wh.to), zone);
    let s = Math.max(winA, from);
    s = winA + Math.ceil((s - winA) / STEP) * STEP;
    while (s + len <= Math.min(winZ, to) && items.length < limit) {
      if (!taken(s, s + len)) { items.push({ start: s, end: s + len }); s += len; s = winA + Math.ceil((s - winA) / STEP) * STEP; } else s += STEP;
    }
  }
  return { items, unknown: list.filter((r) => r.state !== 'ok').map((r) => r.key), workHours: wh, timeZone: zone };
}

module.exports = { query, suggest, merge, personBlocks, rows };
