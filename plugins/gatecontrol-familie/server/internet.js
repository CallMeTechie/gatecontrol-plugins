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
// 1.20.0:
// * The rule action „Internet pausieren“ / „Internet fortsetzen“ (server/rules.js; the run: server/presence.js execute):
//     { type: 'internet', op: 'pause' | 'resume', userId: <child>, minutes: 1…1440 | null, until: 'HH:MM' | null }
//   — pause with exactly one of minutes / until (the next such time in the family's zone). The actor is the rule's
//   owner (who set its actions last): GateControl ≥ 1.259.0 takes { actor } outside a person's request
//   (gc.homeNetwork.internet.actors === true). Familie checks AT EVERY RUN that the owner is still a parent of the family
//   and the target still a minor child of it — else nothing runs and the rule log says so:
//     result { type: 'internet', op, userId, name, until, ok, unchanged, error: null | 'unavailable' (no API / an older
//     GateControl) | 'not_allowed' (the owner is no parent any more) | 'not_found' (no minor child of the family any
//     more) | 'not_person' | 'invalid' | 'failed' }
//   Only parents may put it into a rule (403 forbidden { field }), only for a minor child (400 invalid { field }).
// * „Zeit abgelaufen“: a pause / extra time that ran out by itself is told to the child as well (tick(), kinds
//   'pause_over' / 'extend_over' — not when a parent ended or replaced it, not when GateControl still has one, not later
//   than 15 minutes after the end). Every message of this file runs in the topic „Internet zu Hause“ (`internet`).
// * pausedBy / extendedBy carry `rule: { id, title } | null` (set by a rule in that parent's name); each child carries
//   `presence: { state: 'home' | 'away' | 'unknown' | 'not_shared', since, source: 'app' | 'wifi' | null } | null` (null:
//   the module presence is off) — a pause only works at home; GET internet answers `serverTime` and `timezone`.

const store = require('./store');
const tz = require('./tz');
const format = require('./format');
const members = require('./members');
const push = require('./push');
const presence = require('./presence');
const { fail, posInt, iso, parseIso } = require('./util');

const MIN = 60000;
const DAY = 86400000;
const MAX_PAUSE_MIN = 7 * 24 * 60;
const MAX_EXTEND_MIN = 24 * 60;
const MAX_ADD_MIN = 24 * 60;
const LOG_KEEP_DAYS = 90;
const OPS = ['pause', 'resume', 'extend'];
// 1.20.0: the rule action
const RULE_OPS = ['pause', 'resume'];
const MAX_RULE_MIN = 24 * 60;
// an end found later than this (the server was off) is not told any more
const OVER_LATE_MS = 15 * MIN;
// the rows that replace a running pause / extra time
const FAMILY = { pause: ['pause', 'resume'], extend: ['extend', 'extend_end'] };

/** gc.homeNetwork.internet, or null (GateControl < 1.231.0 or no permission). */
function api(gc) {
  const I = gc && gc.homeNetwork && gc.homeNetwork.internet;
  return I && typeof I.status === 'function' ? I : null;
}

function available(gc) { return !!api(gc); }

/** 1.20.0: does GateControl take { actor } outside a person's request (≥ 1.259.0)? Rules need it. */
function actorsKnown(gc) {
  const I = api(gc);
  return !!I && I.actors === true;
}

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
  const row = await store.one(gc, 'SELECT by_user_id, at, until_at, rule_id, rule_title FROM internet_log WHERE child_id = ? AND kind = ? ORDER BY at DESC, id DESC LIMIT 1', [childId, kind]);
  if (!row || row.until_at !== until) return null;
  const p = fam.byId.get(row.by_user_id);
  // 1.20.0: set by a rule in that parent's name
  return { userId: row.by_user_id, name: p ? p.name : null, at: iso(row.at), rule: row.rule_id == null ? null : { id: row.rule_id, title: row.rule_title || '' } };
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

/**
 * 1.20.0: where the child is, for the card (a pause only works at home) — { state, since, source } from both sources
 * (the app, the phone in the home Wi-Fi), null while the module presence is off. `map`: presence.load().
 */
function presenceOf(map, userId) {
  if (!map) return null;
  const p = map.get(userId);
  const state = presence.stateOf(p);
  const known = state === 'home' || state === 'away';
  return { state, since: known ? iso(p.since) : null, source: known ? p.source : null };
}

/** One child as the card / the app shows it. */
async function childView(gc, fam, m, st, error, map) {
  const base = { userId: m.userId, name: m.name, ...members.faceOf(m), presence: presenceOf(map, m.userId) };
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
  // 1.20.0: the server's clock and the family's zone („bis 18:30“ is that zone's time)
  const clock = { serverTime: iso(r.now), timezone: r.cfg.tz };
  if (!I) return { internet: { available: false, manage, children: [], ...clock } };
  const list = manage ? kids(r.fam) : (r.me.role === 'child' && !r.me.adult ? [r.me] : []);
  const map = await presenceMap(gc, r);
  const children = [];
  for (const m of list) {
    const { st, error } = await statusOf(I, m.userId);
    children.push(await childView(gc, r.fam, m, st, error, map));
  }
  return { internet: { available: true, manage, children, ...clock } };
}

/** presence.load() while the module presence is on (the callers of this API are signed in), else null. */
async function presenceMap(gc, r) {
  return r.cfg.modules.presence ? presence.load(gc, r.fam) : null;
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

const NOTICE_KEYS = {
  pause: 'internet.paused', resume: 'internet.resumed', extend: 'internet.extended', extend_end: 'internet.extend_ended',
  pause_over: 'internet.pause_over', extend_over: 'internet.extend_over',
};

/**
 * The child's notification (topic „Internet zu Hause“). `parent`: who did it — null for 'pause_over' / 'extend_over'
 * (it ran out by itself); 1.20.0 `rule` { id, title }: a rule did it in that parent's name („Die Regel „Abendessen“ …“).
 */
function notice(cfg, now, child, parent, kind, untilMs, rule) {
  const name = parent ? parent.name : null;
  const until = untilMs ? untilText(untilMs, now, cfg) : null;
  const key = NOTICE_KEYS[kind];
  const ttl = untilMs ? Math.max(300, Math.min(7 * 86400, Math.round((untilMs - now) / 1000))) : 6 * 3600;
  const bodyKey = rule && (kind === 'pause' || kind === 'resume') ? `${key}_${rule.title ? 'rule' : 'rule_untitled'}_body` : `${key}_body`;
  return {
    topic: 'internet', users: [child.userId], priority: 'normal', collapseKey: `internet:${child.userId}`, ttl,
    title: push.t(cfg.lang, key, { until }), body: push.t(cfg.lang, bodyKey, { name, until, rule: rule ? rule.title : '' }),
    data: { familie: { type: 'internet', kind, userId: child.userId, until: untilMs ? iso(untilMs) : null, by: parent ? parent.userId : null, ...(rule ? { ruleId: rule.id } : {}) } },
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
  return { child: await childView(gc, r.fam, child, st, null, await presenceMap(gc, r)) };
}

// ─── the rule action (1.20.0) ───────────────────

const badField = (field) => fail('invalid', { field });

/**
 * An action of a rule body → { type: 'internet', op, userId, minutes, until }. `at`: 'actions.<i>'; `owner`: the member
 * the rule will run as (null: not a member — the administrator on the admin page); `kept`: the stored action a body
 * that only says { type: 'internet' } stands for (an app that does not know the action yet sends it back like that).
 */
function parseAction(a, at, fam, owner, kept) {
  if (kept && a.op === undefined && a.userId === undefined) return checkRight({ ...kept }, at, fam, owner);
  if (!RULE_OPS.includes(a.op)) throw badField(`${at}.op`);
  const id = posInt(a.userId);
  if (!id) throw badField(`${at}.userId`);
  const out = { type: 'internet', op: a.op, userId: id, minutes: null, until: null };
  if (a.op === 'pause') {
    const hasMin = a.minutes != null;
    const hasUntil = a.until != null;
    if (hasMin === hasUntil) throw badField(`${at}.minutes`);
    if (hasMin) {
      if (!isInt(a.minutes, 1, MAX_RULE_MIN)) throw badField(`${at}.minutes`);
      out.minutes = a.minutes;
    } else {
      const t = typeof a.until === 'string' ? tz.parseTime(a.until) : null;
      if (!t) throw badField(`${at}.until`);
      out.until = `${tz.pad(t.hh)}:${tz.pad(t.mm)}`;
    }
  }
  return checkRight(out, at, fam, owner);
}

/** Only a parent puts it into a rule, only for a minor child of the family. */
function checkRight(a, at, fam, owner) {
  if (!owner || owner.role !== 'parent') throw fail('forbidden', { field: at });
  const child = fam.byId.get(a.userId);
  if (!child || child.role !== 'child' || child.adult) throw badField(`${at}.userId`);
  return a;
}

/** Why `ownerId` may not decide for `childId` (any more): 'not_allowed' | 'not_found' | null. */
function denied(fam, ownerId, childId) {
  const owner = fam.byId.get(ownerId);
  if (!owner || owner.role !== 'parent') return 'not_allowed';
  const child = fam.byId.get(childId);
  if (!child || child.role !== 'child' || child.adult) return 'not_found';
  return null;
}

/** The action as the pages see it: the child's name and `available` (could it run now as `ownerId`?). */
function actionView(gc, a, fam, ownerId) {
  const child = fam.byId.get(a.userId) || fam.users.get(a.userId);
  return {
    type: 'internet', op: RULE_OPS.includes(a.op) ? a.op : 'pause', userId: a.userId, name: child ? child.name : null,
    minutes: a.minutes == null ? null : a.minutes, until: a.until || null,
    available: actorsKnown(gc) && !denied(fam, ownerId, a.userId), problem: actorsKnown(gc) ? denied(fam, ownerId, a.userId) : 'unavailable',
  };
}

/** GET rules/options → internet: { available, children } — what „Internet zu Hause“ offers this caller for a rule. */
function ruleOptions(gc, ctx) {
  const me = ctx.fam.byId.get(ctx.userId);
  const parent = !!me && me.role === 'parent';
  return {
    available: parent && actorsKnown(gc),
    // why not: 'unavailable' (no „Internet zu Hause“ on this server, or a GateControl before 1.259.0) | 'parents_only'
    reason: !parent ? 'parents_only' : (actorsKnown(gc) ? null : 'unavailable'),
    children: parent ? kids(ctx.fam).map((m) => ({ userId: m.userId, name: m.name, ...members.faceOf(m) })) : [],
  };
}

/**
 * One „Internet pausieren“ / „Internet fortsetzen“ of a rule that runs (after the commit, never throws) → the result
 * for the rule log; the child's message into `pushes`. The actor is the rule's owner — checked now, not when it was saved.
 */
async function runAction(gc, fam, cfg, now, rule, a, pushes) {
  const child = fam.byId.get(a.userId) || fam.users.get(a.userId);
  const base = { type: 'internet', op: a.op, userId: a.userId, name: child ? child.name : null, until: null, unchanged: false };
  const no = (error) => ({ ...base, ok: false, error });
  if (!RULE_OPS.includes(a.op)) return no('invalid');
  const I = api(gc);
  // an older GateControl would log the person whose request the rule happens to run in — never without { actor }
  if (!I || I.actors !== true) return no('unavailable');
  const why = denied(fam, rule.ownerId, a.userId);
  if (why) {
    gc.log.warn('internet rule action not run', rule.id, why);
    return no(why);
  }
  const owner = fam.byId.get(rule.ownerId);
  const by = { actor: owner.userId };
  let st;
  let kind = a.op;
  let changed = true;
  try {
    if (a.op === 'pause') {
      const value = a.until ? new Date(nextAt(a.until, now, cfg.tz)).toISOString() : a.minutes;
      st = await I.pause(a.userId, value, by);
    } else {
      const before = await I.status(a.userId);
      changed = msOf(before.paused) != null && msOf(before.paused) > now;
      st = await I.resume(a.userId, by);
    }
  } catch (e) {
    const code = hostFail(e).code;
    return no(['not_person', 'invalid', 'unavailable'].includes(code) ? code : 'failed');
  }
  const untilMs = kind === 'pause' ? msOf(st.paused) : null;
  if (changed) {
    const info = { id: rule.id, title: rule.title || rule.name || '' };
    try {
      await store.tx(gc, () => store.run(gc, 'INSERT INTO internet_log (child_id, kind, until_at, minutes, by_user_id, at, rule_id, rule_title) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [a.userId, kind, untilMs, a.op === 'pause' ? a.minutes : null, owner.userId, now, info.id, info.title]));
    } catch (e) { gc.log.warn('internet log failed', (e && e.code) || 'error'); }
    pushes.push(notice(cfg, now, fam.byId.get(a.userId), owner, kind, untilMs, info));
  }
  return { ...base, until: untilMs ? iso(untilMs) : null, ok: true, unchanged: !changed, error: null };
}

// ─── „Zeit abgelaufen“ (1.20.0) ─────────────────

/**
 * Background: a pause / extra time of Familie's log whose end has come — the child is told once („Das Internet ist
 * wieder an“, „Die Extra-Zeit ist vorbei“). Not when a later row replaced it (a parent ended it, „+30 Min.“), not when
 * GateControl still has one (set elsewhere), not later than 15 minutes after the end. No transaction around the calls
 * to GateControl; the rows are marked in one of their own.
 */
async function tick(gc, fam, cfg, now, pushes) {
  const I = api(gc);
  if (!I) return { told: 0 };
  const rows = await store.all(gc, "SELECT * FROM internet_log WHERE done_at IS NULL AND kind IN ('pause', 'extend') AND until_at IS NOT NULL AND until_at <= ? ORDER BY id", [now]);
  if (!rows.length) return { told: 0 };
  const out = [];
  for (const row of rows) {
    if (now - row.until_at > OVER_LATE_MS) continue;
    const child = fam.byId.get(row.child_id);
    if (!child || child.role !== 'child') continue;
    const later = await store.one(gc, 'SELECT id FROM internet_log WHERE child_id = ? AND kind IN (?, ?) AND id > ? LIMIT 1', [row.child_id, ...FAMILY[row.kind], row.id]);
    if (later) continue;
    let st;
    try { st = await I.status(row.child_id); } catch { continue; }
    const cur = msOf(row.kind === 'pause' ? st.paused : st.extended);
    if (cur != null && cur > now) continue;
    out.push(notice(cfg, now, child, null, row.kind === 'pause' ? 'pause_over' : 'extend_over', null));
  }
  await store.tx(gc, () => store.run(gc, `UPDATE internet_log SET done_at = ? WHERE id IN (${rows.map(() => '?').join(',')})`, [now, ...rows.map((x) => x.id)]));
  pushes.push(...out);
  return { told: out.length };
}

async function purge(gc, now) {
  await store.run(gc, 'DELETE FROM internet_log WHERE at < ?', [now - LOG_KEEP_DAYS * DAY]);
}

module.exports = {
  OPS, RULE_OPS, MAX_RULE_MIN, OVER_LATE_MS, api, available, actorsKnown, view, act, purge, kids, nextAt, pauseValue, extendMinutes, untilText, hostFail,
  parseAction, denied, actionView, ruleOptions, runAction, tick,
};
