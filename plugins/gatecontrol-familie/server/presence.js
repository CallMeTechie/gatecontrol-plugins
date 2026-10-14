'use strict';

// Presence & smart home — "Anwesenheit & Smart Home" (module presence, default
// off). The app knows home/away from the home network (no GPS) and reports it
// only for people who agreed themselves.
//
//   PUT  presence/consent { share }        only for oneself; false deletes the state
//   POST presence { home, at? }            the app; only with consent (409 no_consent), ≤ 1 per minute (429 too_soon)
//   GET  presence                          { members: [{ userId, name, role, shared, state, home, since }], me: { share }, home: [userId] }
//                                          state: 'home' | 'away' | 'unknown' (shares, nothing reported yet) | 'not_shared'
//   GET  presence/actions                  the quick actions of the other plugins available to the caller (gc.actions.list)
//   GET  presence/rules                    parents: { rules, log }       GET presence/log (addition): { log }
//   POST presence/rules    PATCH|DELETE presence/rules/<id>                parents
//
// A rule: { id, name, trigger, userId, graceMinutes, conditions: { time: { from, to } | null,
// afterSunset }, actions: [...], active, ownerId, ownerName, lastRunAt, lastResult, createdAt, updatedAt }
//   trigger  all_away          every sharing member away (and at least one), for ≥ graceMinutes (0–120, default 10)
//            first_home        a sharing member comes home while no other sharing member is home
//            child_home_alone  a child comes home and no sharing parent is home
//            person_home / person_away   { userId } comes home / leaves
//   conditions (optional)  time: local window (may span midnight, from inclusive, to exclusive);
//            afterSunset: the sun is down at the home (settings lat / lon) — ignored without a location
//   actions  { type: 'quick_action', plugin, id, title? } — runs with gc.actions.run as the rule's owner
//            (the person who last set the actions; on the admin page the administrator)
//            { type: 'notify', to: 'parents' | 'all' | [userId], text? } — push topic presence ({name} = the person)
// A rule fires once per transition and at most once per 10 minutes; a
// throttled "all away" is retried while everyone stays away, a throttled
// arrival or departure is dropped. Each run is logged with the result of every
// action (the last 50 are shown, rows kept 90 days). In a rule view every
// quick action carries `available`: false when the owner no longer has it
// (the pages show "Aktion nicht mehr verfügbar"), null when unknown.

const store = require('./store');
const tz = require('./tz');
const push = require('./push');
const members = require('./members');
const sun = require('./sun');
const { fail, posInt, optText, bool, intIn, iso, parseIso, parseJson, userIds, TIME_RE } = require('./util');

const TRIGGERS = ['all_away', 'first_home', 'child_home_alone', 'person_home', 'person_away'];
const REPORT_GAP_MS = 60000;
const THROTTLE_MS = 10 * 60000;
const GRACE_DEFAULT = 10;
const MAX_RULES = 50;
const MAX_ACTIONS = 10;
const LOG_SHOWN = 50;
const LOG_KEEP_DAYS = 90;
const NAME_MAX = 60;
const TEXT_MAX = 120;
const PLUGIN_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ACTION_ID_RE = /^[A-Za-z0-9:._-]{1,64}$/;
const DAY = 86400000;
const SELF = 'gatecontrol-familie';

// ─── state ──────────────────────────────────────

/** Map userId → { share, home: bool|null, since } for the family members. */
async function load(gc, fam) {
  const consent = new Map((await store.all(gc, 'SELECT user_id, share FROM presence_consent')).map((x) => [x.user_id, !!x.share]));
  const state = new Map((await store.all(gc, 'SELECT * FROM presence_state')).map((x) => [x.user_id, x]));
  const out = new Map();
  for (const m of fam.list) {
    const share = consent.get(m.userId) === true;
    const s = share ? state.get(m.userId) : null;
    out.set(m.userId, { share, home: s ? !!s.home : null, since: s ? s.since : null });
  }
  return out;
}

function stateOf(p) {
  if (!p || !p.share) return 'not_shared';
  if (p.home == null) return 'unknown';
  return p.home ? 'home' : 'away';
}

function membersView(fam, map) {
  return fam.list.map((m) => {
    const p = map.get(m.userId);
    return { userId: m.userId, name: m.name, role: m.role, color: m.color, shared: !!(p && p.share), state: stateOf(p), home: p ? p.home : null, since: iso(p && p.since) };
  });
}

/** GET presence */
async function get(gc, r) {
  const map = await load(gc, r.fam);
  const mine = map.get(r.me.userId);
  return {
    members: membersView(r.fam, map),
    me: { share: !!(mine && mine.share) },
    home: [...map.entries()].filter(([, p]) => p.share && p.home === true).map(([id]) => id),
  };
}

/** The wall's avatars: 'home' | 'away' | null per member. */
async function wallStates(gc, fam) {
  const map = await load(gc, fam);
  return new Map([...map.entries()].map(([id, p]) => [id, p.share && p.home != null ? (p.home ? 'home' : 'away') : null]));
}

/** PUT presence/consent { share } — only for oneself. */
async function consent(gc, r) {
  const share = bool((r.body || {}).share);
  await store.run(gc, `INSERT INTO presence_consent (user_id, share, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET share = excluded.share, updated_at = excluded.updated_at`, [r.me.userId, share ? 1 : 0, r.now]);
  if (!share) await store.run(gc, 'DELETE FROM presence_state WHERE user_id = ?', [r.me.userId]);
  const p = (await load(gc, r.fam)).get(r.me.userId);
  return { consent: { share }, state: { userId: r.me.userId, state: stateOf(p), home: p.home, since: iso(p.since) } };
}

/** POST presence { home, at? } — the app. Transitions collect rule runs into r.runs. */
async function report(gc, r) {
  const b = r.body || {};
  const home = bool(b.home);
  const map = await load(gc, r.fam);
  const mine = map.get(r.me.userId);
  if (!mine || !mine.share) throw fail('no_consent');
  const row = await store.one(gc, 'SELECT * FROM presence_state WHERE user_id = ?', [r.me.userId]);
  if (row && r.now - row.reported_at < REPORT_GAP_MS) throw fail('too_soon', { retryAfter: Math.ceil((REPORT_GAP_MS - (r.now - row.reported_at)) / 1000) });
  let at = b.at == null ? r.now : parseIso(b.at);
  if (at == null) throw fail('invalid', { field: 'at' });
  // the phone's time of the change: not in the future, not more than a day back, not before the last change
  at = Math.min(at, r.now);
  if (at < r.now - DAY) at = r.now;
  if (row && at < row.since) at = r.now;
  const changed = !row || !!row.home !== home;
  if (changed) {
    await store.run(gc, `INSERT INTO presence_state (user_id, home, since, reported_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET home = excluded.home, since = excluded.since, reported_at = excluded.reported_at`, [r.me.userId, home ? 1 : 0, at, r.now]);
    const events = transitionEvents(r.fam, map, r.me, home);
    await fire(gc, r.fam, r.cfg, r.now, events, r.runs);
    await checkAllAway(gc, r.fam, r.cfg, r.now, r.runs);
  } else {
    await store.run(gc, 'UPDATE presence_state SET reported_at = ? WHERE user_id = ?', [r.now, r.me.userId]);
  }
  const since = changed ? at : row.since;
  return { state: { userId: r.me.userId, home, since: iso(since) }, changed };
}

/** The events of one person's change (`map`: the states before it). */
function transitionEvents(fam, map, m, home) {
  const others = [...map.entries()].filter(([id, p]) => id !== m.userId && p.share);
  if (!home) return [{ trigger: 'person_away', userId: m.userId }];
  const ev = [{ trigger: 'person_home', userId: m.userId }];
  if (!others.some(([, p]) => p.home === true)) ev.push({ trigger: 'first_home', userId: m.userId });
  if (m.role === 'child') {
    const parentHome = others.some(([id, p]) => p.home === true && (fam.byId.get(id) || {}).role === 'parent');
    if (!parentHome) ev.push({ trigger: 'child_home_alone', userId: m.userId });
  }
  return ev;
}

// ─── rules ──────────────────────────────────────

function rowToRule(x) {
  const c = parseJson(x.conditions_json, {});
  return {
    id: x.id, name: x.name || '', trigger: x.trigger_type, userId: x.user_id == null ? null : x.user_id, graceMinutes: x.grace_minutes,
    conditions: { time: c.time && c.time.from && c.time.to ? { from: c.time.from, to: c.time.to } : null, afterSunset: c.afterSunset === true },
    actions: parseJson(x.actions_json, []), active: !!x.active, ownerId: x.owner_id, lastRunAt: x.last_run_at, lastKey: x.last_key,
    createdAt: x.created_at, updatedAt: x.updated_at,
  };
}

/** Local "HH:MM" of now in the window (from inclusive, to exclusive; may span midnight). */
function inWindow(hm, w) {
  if (!w) return true;
  return w.from < w.to ? hm >= w.from && hm < w.to : hm >= w.from || hm < w.to;
}

function conditionsHold(rule, cfg, now) {
  const p = tz.parts(now, cfg.tz);
  if (!inWindow(`${tz.pad(p.hh)}:${tz.pad(p.mm)}`, rule.conditions.time)) return false;
  if (rule.conditions.afterSunset && cfg.location && !sun.isDown(now, cfg.location.lat, cfg.location.lon)) return false;
  return true;
}

const throttled = (rule, now) => rule.lastRunAt != null && now - rule.lastRunAt < THROTTLE_MS;

async function activeRules(gc, trigger) {
  return (await store.all(gc, 'SELECT * FROM presence_rules WHERE active = 1 AND trigger_type = ? ORDER BY id', [trigger])).map(rowToRule);
}

/** Event triggers: the matching rules run now (not throttled, conditions hold) → runs. */
async function fire(gc, fam, cfg, now, events, runs) {
  for (const ev of events) {
    for (const rule of await activeRules(gc, ev.trigger)) {
      if ((ev.trigger === 'person_home' || ev.trigger === 'person_away') && rule.userId !== ev.userId) continue;
      if (throttled(rule, now) || !conditionsHold(rule, cfg, now)) continue;
      await store.run(gc, 'UPDATE presence_rules SET last_run_at = ? WHERE id = ?', [now, rule.id]);
      runs.push({ rule, trigger: ev.trigger, userId: ev.userId });
    }
  }
}

/**
 * "Everyone away": all sharing members reported away (at least one). The
 * episode is the moment the last one left; each rule handles it once, after
 * its grace time — throttled: later, while everyone stays away.
 */
async function checkAllAway(gc, fam, cfg, now, runs) {
  const map = await load(gc, fam);
  const sharing = [...map.values()].filter((p) => p.share);
  if (!sharing.length || !sharing.every((p) => p.home === false)) return;
  const left = Math.max(...sharing.map((p) => p.since));
  const key = `away:${left}`;
  for (const rule of await activeRules(gc, 'all_away')) {
    if (rule.lastKey === key || now < left + rule.graceMinutes * 60000) continue;
    if (throttled(rule, now)) continue;
    const ok = conditionsHold(rule, cfg, now);
    await store.run(gc, `UPDATE presence_rules SET last_key = ?${ok ? ', last_run_at = ?' : ''} WHERE id = ?`, ok ? [key, now, rule.id] : [key, rule.id]);
    if (ok) runs.push({ rule, trigger: 'all_away', userId: null });
  }
}

/** Background (inside a transaction): the grace times of "all away". */
async function tick(gc, fam, cfg, now, runs) {
  await checkAllAway(gc, fam, cfg, now, runs);
}

function hostCode(e) {
  const c = e && e.code;
  if (c === 'ERR_RATE_LIMIT') return 'rate_limit';
  if (c === 'ERR_INVALID') return 'invalid';
  if (c === 'ERR_ACTIONS_DENIED') return 'denied';
  return 'error';
}

function recipients(action, fam, triggerUser) {
  let ids;
  if (action.to === 'parents') ids = members.parents(fam).map((m) => m.userId);
  else if (action.to === 'all') ids = fam.list.map((m) => m.userId);
  else ids = (Array.isArray(action.to) ? action.to : []).filter((id) => fam.byId.has(id));
  return ids.filter((id) => id !== triggerUser);
}

/**
 * Run the collected rules (after the commit): quick actions as the owner,
 * notifications into `pushes`; one log row per run.
 */
async function execute(gc, fam, cfg, now, runs, pushes) {
  for (const run of runs) {
    const { rule } = run;
    const person = run.userId ? fam.byId.get(run.userId) : null;
    const results = [];
    for (const a of rule.actions) {
      if (a.type === 'quick_action') {
        const base = { type: 'quick_action', plugin: a.plugin, id: a.id, title: a.title || null };
        if (!gc.actions || typeof gc.actions.run !== 'function') { results.push({ ...base, ok: false, message: null, error: 'unavailable' }); continue; }
        try {
          const x = await gc.actions.run({ userId: rule.ownerId, plugin: a.plugin, id: a.id, lang: cfg.lang });
          results.push({ ...base, ok: !!(x && x.ok === true), message: (x && x.message) || null, error: (x && x.error) || (x && x.ok === true ? null : 'failed') });
        } catch (e) {
          results.push({ ...base, ok: false, message: null, error: hostCode(e) });
        }
      } else if (a.type === 'notify') {
        const to = recipients(a, fam, run.userId);
        const name = person ? person.name : '';
        const text = (a.text || push.t(cfg.lang, `presence.${run.trigger}`, { name })).split('{name}').join(name);
        if (to.length) {
          pushes.push({
            topic: 'presence', users: to, priority: 'normal', collapseKey: `presence:${rule.id}`, ttl: 6 * 3600,
            title: text.slice(0, 120), body: rule.name || undefined,
            data: { familie: { type: 'presence_rule', ruleId: rule.id, trigger: run.trigger, userId: run.userId || null } },
          });
        }
        results.push({ type: 'notify', ok: to.length > 0, sent: to.length, error: to.length ? null : 'no_recipients' });
      }
    }
    const ok = results.every((x) => x.ok);
    try {
      await store.tx(gc, () => store.run(gc, 'INSERT INTO presence_log (rule_id, rule_name, trigger_type, user_id, at, ok, results_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [rule.id, rule.name, run.trigger, run.userId || null, now, ok ? 1 : 0, JSON.stringify(results)]));
    } catch (e) { gc.log.warn('presence log failed', (e && e.code) || 'error'); }
    if (!ok) gc.log.warn('presence rule run failed', rule.id, results.filter((x) => !x.ok).map((x) => x.error).join(','));
  }
}

// ─── rule API ───────────────────────────────────

function parseConditions(v) {
  if (v == null) return { time: null, afterSunset: false };
  if (typeof v !== 'object' || Array.isArray(v)) throw fail('invalid', { field: 'conditions' });
  let time = null;
  if (v.time != null) {
    const t = v.time;
    if (typeof t !== 'object' || !TIME_RE.test(String(t.from)) || !TIME_RE.test(String(t.to)) || t.from === t.to) throw fail('invalid', { field: 'conditions.time' });
    time = { from: t.from, to: t.to };
  }
  const afterSunset = v.afterSunset == null ? false : bool(v.afterSunset);
  return { time, afterSunset };
}

function parseActions(v, fam) {
  if (!Array.isArray(v) || !v.length || v.length > MAX_ACTIONS) throw fail('invalid', { field: 'actions' });
  return v.map((a, i) => {
    const at = `actions.${i}`;
    if (!a || typeof a !== 'object' || Array.isArray(a)) throw fail('invalid', { field: at });
    if (a.type === 'quick_action') {
      if (typeof a.plugin !== 'string' || a.plugin.length < 2 || a.plugin.length > 64 || !PLUGIN_ID_RE.test(a.plugin) || a.plugin === SELF) throw fail('invalid', { field: `${at}.plugin` });
      if (typeof a.id !== 'string' || !ACTION_ID_RE.test(a.id)) throw fail('invalid', { field: `${at}.id` });
      let title;
      try { title = optText(a.title, NAME_MAX); } catch { throw fail('invalid', { field: `${at}.title` }); }
      return { type: 'quick_action', plugin: a.plugin, id: a.id, title: title || null };
    }
    if (a.type === 'notify') {
      let to;
      if (a.to === 'parents' || a.to === 'all') to = a.to;
      else {
        try { to = userIds(a.to, 50); } catch { throw fail('invalid', { field: `${at}.to` }); }
        if (!to.length || to.some((id) => !fam.byId.has(id))) throw fail('invalid', { field: `${at}.to` });
      }
      let text;
      try { text = optText(a.text, TEXT_MAX); } catch { throw fail('invalid', { field: `${at}.text` }); }
      return { type: 'notify', to, text: text || null };
    }
    throw fail('invalid', { field: `${at}.type` });
  });
}

function ruleFields(body, cur, fam) {
  const b = body || {};
  const f = {};
  f.name = b.name !== undefined ? (optText(b.name, NAME_MAX) || '') : (cur ? cur.name : '');
  f.trigger = b.trigger !== undefined || !cur ? b.trigger : cur.trigger;
  if (!TRIGGERS.includes(f.trigger)) throw fail('invalid', { field: 'trigger' });
  const person = f.trigger === 'person_home' || f.trigger === 'person_away';
  if (person) {
    const id = b.userId !== undefined ? posInt(b.userId) : (cur ? cur.userId : null);
    if (!id || !fam.byId.has(id)) throw fail('invalid', { field: 'userId' });
    f.userId = id;
  } else f.userId = null;
  f.graceMinutes = b.graceMinutes !== undefined ? intIn(b.graceMinutes, 0, 120) : (cur ? cur.graceMinutes : GRACE_DEFAULT);
  f.conditions = b.conditions !== undefined ? parseConditions(b.conditions) : (cur ? cur.conditions : { time: null, afterSunset: false });
  f.actions = b.actions !== undefined || !cur ? parseActions(b.actions, fam) : cur.actions;
  f.active = b.active !== undefined ? bool(b.active) : (cur ? cur.active : true);
  return f;
}

/** Which quick actions each owner has right now: Map ownerId → Set('plugin|id') | null (unknown). */
async function availability(gc, rules, lang) {
  const out = new Map();
  for (const owner of new Set(rules.filter((x) => x.actions.some((a) => a.type === 'quick_action')).map((x) => x.ownerId))) {
    if (!gc.actions || typeof gc.actions.list !== 'function') { out.set(owner, null); continue; }
    try {
      out.set(owner, new Set((await gc.actions.list({ userId: owner, lang })).map((a) => `${a.plugin}|${a.id}`)));
    } catch { out.set(owner, null); }
  }
  return out;
}

function ruleView(rule, fam, avail, last) {
  const set = avail.get(rule.ownerId);
  const owner = fam.byId.get(rule.ownerId) || fam.users.get(rule.ownerId);
  return {
    id: rule.id, name: rule.name, trigger: rule.trigger, userId: rule.userId, graceMinutes: rule.graceMinutes, conditions: rule.conditions,
    actions: rule.actions.map((a) => (a.type === 'quick_action' ? { ...a, available: set ? set.has(`${a.plugin}|${a.id}`) : null } : a)),
    active: rule.active, ownerId: rule.ownerId, ownerName: owner ? owner.name : null, lastRunAt: iso(rule.lastRunAt),
    lastResult: last ? { at: iso(last.at), ok: !!last.ok } : null, createdAt: iso(rule.createdAt), updatedAt: iso(rule.updatedAt),
  };
}

const logView = (x) => ({ id: x.id, ruleId: x.rule_id, ruleName: x.rule_name || '', trigger: x.trigger_type, userId: x.user_id == null ? null : x.user_id, at: iso(x.at), ok: !!x.ok, results: parseJson(x.results_json, []) });

async function log(gc) {
  return (await store.all(gc, 'SELECT * FROM presence_log ORDER BY at DESC, id DESC LIMIT ?', [LOG_SHOWN])).map(logView);
}

async function rulesView(gc, fam, lang, ids) {
  const rows = await store.all(gc, 'SELECT * FROM presence_rules ORDER BY id');
  const rules = rows.map(rowToRule).filter((x) => !ids || ids.includes(x.id));
  const avail = await availability(gc, rules, lang);
  const lastRows = await store.all(gc, 'SELECT l.* FROM presence_log l WHERE l.id = (SELECT m.id FROM presence_log m WHERE m.rule_id = l.rule_id ORDER BY m.at DESC, m.id DESC LIMIT 1)');
  const last = new Map(lastRows.map((x) => [x.rule_id, x]));
  return rules.map((x) => ruleView(x, fam, avail, last.get(x.id)));
}

/** ctx: { fam, cfg, now, ownerId, lang } — shared by the member API (parents) and the admin page. */
async function listRules(gc, ctx) {
  return { rules: await rulesView(gc, ctx.fam, ctx.lang), log: await log(gc) };
}

async function createRule(gc, ctx, body) {
  if ((await store.one(gc, 'SELECT COUNT(*) AS n FROM presence_rules')).n >= MAX_RULES) throw fail('too_many');
  const f = ruleFields(body, null, ctx.fam);
  const res = await store.run(gc, `INSERT INTO presence_rules (name, trigger_type, user_id, grace_minutes, conditions_json, actions_json, active, owner_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [f.name, f.trigger, f.userId, f.graceMinutes, JSON.stringify(f.conditions), JSON.stringify(f.actions), f.active ? 1 : 0, ctx.ownerId, ctx.now, ctx.now]);
  return { rule: (await rulesView(gc, ctx.fam, ctx.lang, [res.lastInsertRowid]))[0] };
}

async function ruleRow(gc, raw) {
  const id = posInt(raw);
  const row = id ? await store.one(gc, 'SELECT * FROM presence_rules WHERE id = ?', [id]) : null;
  if (!row) throw fail('not_found');
  return rowToRule(row);
}

async function updateRule(gc, ctx, raw, body) {
  const cur = await ruleRow(gc, raw);
  const f = ruleFields(body, cur, ctx.fam);
  // whoever sets the actions owns them: the quick actions run as that person
  const owner = body && body.actions !== undefined ? ctx.ownerId : cur.ownerId;
  // a changed trigger starts afresh
  const lastKey = f.trigger === cur.trigger ? cur.lastKey : null;
  await store.run(gc, `UPDATE presence_rules SET name = ?, trigger_type = ?, user_id = ?, grace_minutes = ?, conditions_json = ?, actions_json = ?, active = ?, owner_id = ?,
    last_key = ?, updated_at = ? WHERE id = ?`, [f.name, f.trigger, f.userId, f.graceMinutes, JSON.stringify(f.conditions), JSON.stringify(f.actions), f.active ? 1 : 0, owner, lastKey, ctx.now, cur.id]);
  return { rule: (await rulesView(gc, ctx.fam, ctx.lang, [cur.id]))[0] };
}

async function removeRule(gc, raw) {
  const cur = await ruleRow(gc, raw);
  await store.run(gc, 'DELETE FROM presence_rules WHERE id = ?', [cur.id]);
  return {};
}

/** GET presence/actions — what the caller (or the admin) could put into a rule. */
async function actions(gc, userId, lang) {
  if (!gc.actions || typeof gc.actions.list !== 'function') return { actions: [], available: false };
  try {
    return { actions: await gc.actions.list({ userId, lang }), available: true };
  } catch (e) {
    return { actions: [], available: false, error: hostCode(e) };
  }
}

async function purge(gc, now) {
  await store.run(gc, 'DELETE FROM presence_log WHERE at < ?', [now - LOG_KEEP_DAYS * DAY]);
}

/** Overview: who is home (sharing members only) and the caller's consent. */
async function overview(gc, r) {
  const map = await load(gc, r.fam);
  const mine = map.get(r.me.userId);
  return {
    home: [...map.entries()].filter(([, p]) => p.share && p.home === true).map(([id, p]) => ({ userId: id, since: iso(p.since) })),
    share: !!(mine && mine.share),
  };
}

module.exports = {
  TRIGGERS, THROTTLE_MS, REPORT_GAP_MS, load, stateOf, membersView, get, wallStates, consent, report, transitionEvents, inWindow, conditionsHold,
  fire, checkAllAway, tick, execute, listRules, createRule, updateRule, removeRule, actions, log, purge, overview,
};
