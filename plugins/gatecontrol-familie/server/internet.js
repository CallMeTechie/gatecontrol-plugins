'use strict';

// 1.18.0 — „Internet zu Hause“: parents pause the internet of a child at home or give it more time today (GateControl ≥
// 1.231.0, permissions.homeInternet → gc.homeNetwork.internet; GateControl's docs/plugins.md "Internet at home"). A home
// gateway with the DNS filter answers the name lookups of the home network and filters per profile — the devices of a
// person (network watch: owner = the person) follow that person's profile and its times. GateControl keeps the pause /
// the extra time itself and tells the gateways; Familie never sees a MAC or IP address. GateControl only allows the
// changes inside a changing request of a signed-in person (the actor in its activity log) and does NOT check who may
// decide for whom — Familie does: only a parent of the family, only for a child of the family (not an adult one).
//
//   GET  internet                          → { internet: { available, manage, children: [child] } } — parents: every
//                                            minor child; a child: itself (read only); others: none
//   POST internet/<childId>/pause          { minutes: 1…10080 } | { until: 'HH:MM' } (the next such time in the family's
//                                            time zone) | { until: ISO } | { add: 1…1440 } (from the end of a running
//                                            pause, else from now) → { child }
//   POST internet/<childId>/resume         {} → { child }   (an extension stays)
//   POST internet/<childId>/extend         { minutes: 0…1440, fromNow? } → { child } — „Heute länger“: the times of the
//                                            profile suspended. From the end of a running extension; without one and
//                                            with blocked times still ahead today (nextSchedule not active), the minutes
//                                            count from their start („+30 Min.“ at 18:00 with a block from 21:00 → until
//                                            21:30), unless fromNow: true. 0 ends a running extension.
//   child = { userId, name, avatarUrl, color, colorHex, initials, paused, pausedBy, extended, extendedBy (ISO | null;
//             by = { userId, name, at } from Familie's own log — null when set elsewhere), nextSchedule: { from, to,
//             block: 'all' | 'categories', categories, active } | null, profile: name | null, devices, filtered, error }
//
// Without the API (an older GateControl or the permission not confirmed): available false, the POSTs 409 unavailable.
// GateControl's codes: ERR_NOT_PERSON → 403 not_person (e.g. a paired kiosk device), ERR_INVALID → 400 invalid,
// ERR_HOME_INTERNET_DENIED → 409 unavailable. The child is told about every change (topic „Internet zu Hause“).
//
// No rule action „Internet pausieren“: GateControl refuses the calls outside a person's request (rules run in the
// background), see the CHANGELOG.

const store = require('./store');
const tz = require('./tz');
const format = require('./format');
const members = require('./members');
const push = require('./push');
const { fail, posInt, iso, parseIso } = require('./util');

const MIN = 60000;
const DAY = 86400000;
const MAX_PAUSE_MIN = 7 * 24 * 60;
const MAX_EXTEND_MIN = 24 * 60;
const MAX_ADD_MIN = 24 * 60;
const LOG_KEEP_DAYS = 90;
const OPS = ['pause', 'resume', 'extend'];

/** gc.homeNetwork.internet, or null (GateControl < 1.231.0 or no permission). */
function api(gc) {
  const I = gc && gc.homeNetwork && gc.homeNetwork.internet;
  return I && typeof I.status === 'function' ? I : null;
}

function available(gc) { return !!api(gc); }

/** GateControl's codes → ours. */
function hostFail(e) {
  const c = e && e.code;
  if (c === 'ERR_NOT_PERSON') return fail('not_person');
  if (c === 'ERR_INVALID') return fail('invalid');
  if (c === 'ERR_HOME_INTERNET_DENIED') return fail('unavailable');
  return e;
}

/** The children whose internet a parent decides: minors of the family. */
function kids(fam) {
  return members.children(fam).filter((m) => !m.adult);
}

const msOf = (v) => parseIso(v);

/** The parent of Familie's log behind a running pause / extension (the row whose end is GateControl's), else null. */
async function byOf(gc, fam, childId, kind, untilIso) {
  const until = msOf(untilIso);
  if (until == null) return null;
  const row = await store.one(gc, 'SELECT by_user_id, at, until_at FROM internet_log WHERE child_id = ? AND kind = ? ORDER BY at DESC, id DESC LIMIT 1', [childId, kind]);
  if (!row || row.until_at !== until) return null;
  const p = fam.byId.get(row.by_user_id);
  return { userId: row.by_user_id, name: p ? p.name : null, at: iso(row.at) };
}

function scheduleView(s) {
  if (!s || typeof s !== 'object') return null;
  const from = msOf(s.from);
  const to = msOf(s.to);
  if (from == null || to == null) return null;
  return {
    from: iso(from), to: iso(to), block: s.block === 'all' ? 'all' : 'categories',
    categories: Array.isArray(s.categories) ? s.categories.filter((c) => typeof c === 'string').slice(0, 10) : [], active: s.active === true,
  };
}

/** One child as the card / the app shows it. */
async function childView(gc, fam, m, st, error) {
  const base = { userId: m.userId, name: m.name, ...members.faceOf(m) };
  if (!st) return { ...base, paused: null, pausedBy: null, extended: null, extendedBy: null, nextSchedule: null, profile: null, devices: 0, filtered: false, error: error || 'error' };
  const paused = iso(msOf(st.paused));
  const extended = iso(msOf(st.extended));
  return {
    ...base,
    paused, pausedBy: paused ? await byOf(gc, fam, m.userId, 'pause', st.paused) : null,
    extended, extendedBy: extended ? await byOf(gc, fam, m.userId, 'extend', st.extended) : null,
    nextSchedule: scheduleView(st.nextSchedule),
    profile: st.profile && typeof st.profile.name === 'string' ? st.profile.name.slice(0, 60) : null,
    devices: Number.isInteger(st.devices) && st.devices > 0 ? st.devices : 0,
    filtered: st.filtered === true,
    error: null,
  };
}

async function statusOf(I, userId) {
  try { return { st: await I.status(userId), error: null }; } catch (e) { return { st: null, error: hostFail(e).code || 'error' }; }
}

/** GET internet */
async function view(gc, r) {
  const I = api(gc);
  const manage = r.me.role === 'parent';
  if (!I) return { internet: { available: false, manage, children: [] } };
  const list = manage ? kids(r.fam) : (r.me.role === 'child' && !r.me.adult ? [r.me] : []);
  const children = [];
  for (const m of list) {
    const { st, error } = await statusOf(I, m.userId);
    children.push(await childView(gc, r.fam, m, st, error));
  }
  return { internet: { available: true, manage, children } };
}

/** The next "HH:MM" in the family's time zone (today when still ahead, else tomorrow) → ms. */
function nextAt(hhmm, now, zone) {
  const t = tz.parseTime(hhmm);
  if (!t) return null;
  const today = tz.localDate(now, zone);
  const a = tz.at(today, t, zone);
  return a > now ? a : tz.at(tz.addDays(today, 1), t, zone);
}

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

/** The body of pause → what GateControl gets (minutes or an ISO time). */
function pauseValue(b, st, now, zone) {
  const keys = ['minutes', 'until', 'add'].filter((k) => b[k] != null);
  if (keys.length !== 1) throw fail('invalid');
  if (keys[0] === 'minutes') {
    if (!isInt(b.minutes, 1, MAX_PAUSE_MIN)) throw fail('invalid');
    return { value: b.minutes, minutes: b.minutes };
  }
  if (keys[0] === 'add') {
    if (!isInt(b.add, 1, MAX_ADD_MIN)) throw fail('invalid');
    const cur = msOf(st.paused);
    const base = cur != null && cur > now ? cur : now;
    return { value: new Date(base + b.add * MIN).toISOString(), minutes: b.add };
  }
  if (typeof b.until !== 'string') throw fail('invalid');
  const at = tz.parseTime(b.until) ? nextAt(b.until, now, zone) : msOf(b.until);
  if (at == null || at <= now || at - now > MAX_PAUSE_MIN * MIN) throw fail('invalid');
  return { value: new Date(at).toISOString(), minutes: null };
}

/** „Heute länger“: the minutes GateControl gets (see the head). */
function extendMinutes(b, st, now) {
  if (!isInt(b.minutes, 0, MAX_EXTEND_MIN)) throw fail('invalid');
  const m = b.minutes;
  if (m === 0 || b.fromNow === true) return m;
  const ext = msOf(st.extended);
  if (ext != null && ext > now) return m;
  const s = st.nextSchedule;
  const from = s && s.active !== true ? msOf(s.from) : null;
  if (from == null || from <= now) return m;
  const total = Math.ceil((from - now) / MIN) + m;
  return total <= MAX_EXTEND_MIN ? total : m;
}

/** "18:30" today, "morgen 07:00", "Sa, 08.11. 07:00" — in the family's time zone and the notification language. */
function untilText(ms, now, cfg) {
  const day = tz.localDate(ms, cfg.tz);
  const today = tz.localDate(now, cfg.tz);
  const time = format.time(ms, cfg.tz);
  return day === today ? time : `${format.rel(day, today, cfg.lang)} ${time}`;
}

/** The child's notification (topic „Internet zu Hause“). */
function notice(cfg, now, child, parent, kind, untilMs) {
  const name = parent.name;
  const until = untilMs ? untilText(untilMs, now, cfg) : null;
  const key = { pause: 'internet.paused', resume: 'internet.resumed', extend: 'internet.extended', extend_end: 'internet.extend_ended' }[kind];
  const ttl = untilMs ? Math.max(300, Math.min(7 * 86400, Math.round((untilMs - now) / 1000))) : 6 * 3600;
  return {
    topic: 'internet', users: [child.userId], priority: 'normal', collapseKey: `internet:${child.userId}`, ttl,
    title: push.t(cfg.lang, key, { until }), body: push.t(cfg.lang, key + '_body', { name, until }),
    data: { familie: { type: 'internet', kind, userId: child.userId, until: untilMs ? iso(untilMs) : null, by: parent.userId } },
  };
}

/** POST internet/<childId>/<op> — parents only, a minor child of the family. No transaction around GateControl. */
async function act(gc, r, rawId, op) {
  if (!OPS.includes(op)) throw fail('not_found');
  const I = api(gc);
  if (!I) throw fail('unavailable');
  if (r.me.role !== 'parent') throw fail('parents_only');
  const id = posInt(rawId);
  const child = id ? r.fam.byId.get(id) : null;
  if (!child || child.role !== 'child' || child.adult) throw fail('not_found');
  const b = r.body || {};
  let before;
  try { before = await I.status(id); } catch (e) { throw hostFail(e); }
  const now = Date.now();
  let st;
  let kind = op;
  let minutes = null;
  let changed = true;
  try {
    if (op === 'pause') {
      const v = pauseValue(b, before, now, r.cfg.tz);
      minutes = v.minutes;
      st = await I.pause(id, v.value);
    } else if (op === 'resume') {
      changed = msOf(before.paused) != null && msOf(before.paused) > now;
      st = await I.resume(id);
    } else {
      minutes = extendMinutes(b, before, now);
      if (minutes === 0) {
        kind = 'extend_end';
        changed = msOf(before.extended) != null && msOf(before.extended) > now;
      }
      st = await I.extend(id, minutes);
    }
  } catch (e) { throw hostFail(e); }
  const untilMs = kind === 'pause' ? msOf(st.paused) : (kind === 'extend' ? msOf(st.extended) : null);
  if (changed) {
    await store.tx(gc, () => store.run(gc, 'INSERT INTO internet_log (child_id, kind, until_at, minutes, by_user_id, at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, kind, untilMs, minutes, r.me.userId, now]));
    r.pushes.push(notice(r.cfg, now, child, r.me, kind, untilMs));
  }
  return { child: await childView(gc, r.fam, child, st, null) };
}

async function purge(gc, now) {
  await store.run(gc, 'DELETE FROM internet_log WHERE at < ?', [now - LOG_KEEP_DAYS * DAY]);
}

module.exports = { OPS, api, available, view, act, purge, kids, nextAt, pauseValue, extendMinutes, untilText, hostFail };
