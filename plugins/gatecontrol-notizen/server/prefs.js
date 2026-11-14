'use strict';

// A person's own choices (board „Quellen“, the area last open, the times of the quick entry). GET/PUT prefs.
//
//   area      'private' | 'work'
//   evening   'HH:MM' — when items with lead 'evening' (waste collection) show the day before (default 18:00)
//   sources   { <plugin>: { on: bool, kids?: 'all'|'mine'|'none' (Familie), shoppingInMyDay?: bool (Familie),
//               flagged?: bool (Mail), evening?: 'HH:MM' (Alltag) } }
//   groups    { '<plugin>|<group id>': 'private' | 'work' | 'hide' } — Mail accounts, Schule children, Familie lists
//   times     { morning, noon, afternoon, evening, night } of the quick entry (ui/quickparse.js)
//   myday     { listdays: bool, showDone: bool } (1.2.0) — the list day card at the top of „Mein Tag“, the done ones of today
//   startArea 'last' | 'private' | 'work' (1.2.0) — the area on opening („last“: `area`)
//   notify    { reminders, shared, listday: bool } (1.2.0) — false: the plugin sends no push of that kind to the person
//             + yesterday (1.3.0): the morning hint „Gestern offen geblieben“
//   yesterdayAt 'HH:MM' (1.3.0) — when that hint comes (default 07:30)
//   calendar  { tasks: bool } (1.3.0) — false: the person's tasks with a time are not written into their calendar in Mail

const store = require('./store');
const config = require('./config');
const { fail, parse, isTime } = require('./util');

const MYDAY = { listdays: true, showDone: true };
const NOTIFY = { reminders: true, shared: true, listday: true, yesterday: true };
const CALENDAR = { tasks: true };
const YESTERDAY_AT = '07:30';
const DEFAULTS = { area: 'private', evening: '18:00', sources: {}, groups: {}, times: {}, myday: { ...MYDAY }, startArea: 'last', notify: { ...NOTIFY },
  yesterdayAt: YESTERDAY_AT, calendar: { ...CALENDAR } };
const SRC_KEYS = { on: 'bool', kids: ['all', 'mine', 'none'], shoppingInMyDay: 'bool', flagged: 'bool', evening: 'time' };
const TIME_KEYS = ['morning', 'noon', 'afternoon', 'evening', 'night'];

function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const out = {
    area: r.area === 'work' ? 'work' : 'private', evening: isTime(r.evening) ? r.evening : DEFAULTS.evening, sources: {}, groups: {}, times: {},
    myday: { ...MYDAY }, startArea: ['private', 'work'].includes(r.startArea) ? r.startArea : 'last', notify: { ...NOTIFY },
    yesterdayAt: isTime(r.yesterdayAt) ? r.yesterdayAt : YESTERDAY_AT, calendar: { ...CALENDAR },
  };
  for (const [key, def] of [['myday', MYDAY], ['notify', NOTIFY], ['calendar', CALENDAR]]) {
    const v = r[key];
    if (v && typeof v === 'object') for (const k of Object.keys(def)) if (typeof v[k] === 'boolean') out[key][k] = v[k];
  }
  for (const p of config.SOURCES) {
    const s = r.sources && r.sources[p];
    if (!s || typeof s !== 'object') continue;
    const o = {};
    for (const [k, kind] of Object.entries(SRC_KEYS)) {
      const v = s[k];
      if (kind === 'bool' && typeof v === 'boolean') o[k] = v;
      else if (kind === 'time' && isTime(v)) o[k] = v;
      else if (Array.isArray(kind) && kind.includes(v)) o[k] = v;
    }
    out.sources[p] = o;
  }
  if (r.groups && typeof r.groups === 'object') {
    for (const [k, v] of Object.entries(r.groups).slice(0, 200)) {
      if (/^gatecontrol-[a-z]+\|[A-Za-z0-9:._-]{1,80}$/.test(k) && ['private', 'work', 'hide'].includes(v)) out.groups[k] = v;
    }
  }
  if (r.times && typeof r.times === 'object') for (const k of TIME_KEYS) if (isTime(r.times[k])) out.times[k] = r.times[k];
  return out;
}

async function get(gc, userId) {
  const r = await store.one(gc, 'SELECT json FROM prefs WHERE user_id = ?', [userId]);
  return normalize(parse(r && r.json, {}));
}

// how often "used the hub" is written down: it is asked for 30 days back (sources.js), so once in 12 hours is as good
// as once an hour (before 1.2.1) — a write less with every hour someone has the hub open
const TOUCH_MS = 12 * 3600000;

/** The person used the hub now (reconciliations only for people who did within 30 days). */
async function touch(gc, userId, now) {
  const r = await store.one(gc, 'SELECT updated_at FROM prefs WHERE user_id = ?', [userId]);
  if (r && now >= r.updated_at && now - r.updated_at < TOUCH_MS) return false;
  await store.run(gc, 'INSERT INTO prefs (user_id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET updated_at = excluded.updated_at', [userId, '{}', now]);
  return !r;
}

// one PUT prefs of a person at a time (no transaction: the same choices again must stay without a write)
const queue = new Map();
function serial(userId, fn) {
  const p = (queue.get(userId) || Promise.resolve()).then(fn, fn);
  const tail = p.catch(() => {});
  queue.set(userId, tail);
  return p.finally(() => { if (queue.get(userId) === tail) queue.delete(userId); });
}

/**
 * PUT prefs { … } — merged into what is there. One at a time (1.3.0): two switches saved right after each other each
 * read the choices first — without the queue the second one wrote the first one's change away.
 */
async function put(gc, ctx, b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw fail('invalid');
  return serial(ctx.userId, async () => {
    const cur = await get(gc, ctx.userId);
    const merged = { ...cur, ...b, sources: { ...cur.sources }, groups: { ...cur.groups, ...(b.groups && typeof b.groups === 'object' ? b.groups : {}) }, times: { ...cur.times, ...(b.times || {}) },
      myday: { ...cur.myday, ...(b.myday && typeof b.myday === 'object' ? b.myday : {}) }, notify: { ...cur.notify, ...(b.notify && typeof b.notify === 'object' ? b.notify : {}) },
      calendar: { ...cur.calendar, ...(b.calendar && typeof b.calendar === 'object' ? b.calendar : {}) } };
    if (b.sources && typeof b.sources === 'object') for (const [p, s] of Object.entries(b.sources)) merged.sources[p] = { ...(cur.sources[p] || {}), ...(s || {}) };
    if (!isTime(merged.yesterdayAt)) merged.yesterdayAt = cur.yesterdayAt;
    for (const [k, v] of Object.entries(merged.groups)) if (v === null) delete merged.groups[k];
    const n = normalize(merged);
    const json = JSON.stringify(n);
    // the same choices again (an app sends the area with every start): nothing to write (1.2.1) — but "used the hub"
    const have = await store.one(gc, 'SELECT json FROM prefs WHERE user_id = ?', [ctx.userId]);
    if (have && have.json === json) { await touch(gc, ctx.userId, ctx.now); return { prefs: n }; }
    await store.run(gc, 'INSERT INTO prefs (user_id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at', [ctx.userId, json, ctx.now]);
    // 1.3.0: what follows from a choice (the calendar's events, the plan of the morning hint) — hooks.changed, set by api.js
    if (hooks.changed) await hooks.changed(gc, ctx, cur, n);
    return { prefs: n };
  });
}

const hooks = { changed: null };

module.exports = { get, put, touch, normalize, hooks, DEFAULTS, TOUCH_MS, YESTERDAY_AT };
