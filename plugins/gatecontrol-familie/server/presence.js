'use strict';

// Presence & smart home — "Anwesenheit & Smart Home" (module presence, default
// off). The app knows home/away from the home network (no GPS) and reports it
// only for people who agreed themselves.
//
//   PUT  presence/consent { share?, places? }   only for oneself, at least one of them; share false deletes the state
//                                          → { consent: { share, places }, state }
//   POST presence { home, at? }            the app; only with consent (409 no_consent), ≤ 1 per minute (429 too_soon)
//   GET  presence                          { members: [{ userId, name, role, avatarUrl, color, colorHex, initials, presence,
//                                          shared, placesShared, state, home, since }], me: { share, places }, home: [userId],
//                                          watchVersion }   (POST presence answers watchVersion too)
//                                          state: 'home' | 'away' | 'unknown' (shares, nothing reported yet) | 'not_shared'
//                                          presence (1.3.0, the ring): 'home' | 'away' | 'unknown' | null (not shared)
//   GET  presence/actions                  the quick actions of the other plugins available to the caller (gc.actions.list;
//                                          GateControl ≥ 1.173.0: each with device, verbs { on, off } | null, targets, state)
//   GET  presence/rules                    parents: { rules, log }       GET presence/log (addition): { log }
//   POST presence/rules    PATCH|DELETE presence/rules/<id>                parents
//   1.5.0 — places as triggers (the places themselves: server/ruleplaces.js):
//   GET  presence/watch                    any member: the places the caller's phone watches { places: [{ id, name, lat,
//                                          lon, radius, transitions }], version } — empty without places consent
//   POST presence/places/<id>/event { transition: 'enter' | 'exit', at? }   the phone → { fired, late, repeated }
//
// A rule: { id, name, trigger, userId, placeId, placeName, graceMinutes, conditions: { time: { from, to } | null,
// afterSunset }, actions: [...], active, ownerId, ownerName, lastRunAt, lastResult, createdAt, updatedAt }
//   trigger  all_away          every sharing member away (and at least one), for ≥ graceMinutes (0–120, default 10)
//            first_home        a sharing member comes home while no other sharing member is home
//            child_home_alone  a child comes home and no sharing parent is home
//            person_home / person_away   { userId } comes home / leaves
//            place_enter / place_exit (1.5.0)   { placeId (required), userId (a member, or null = anyone who
//                              shares places) } arrives at / leaves the place; placeName = its current name
//   conditions (optional)  time: local window (may span midnight, from inclusive, to exclusive);
//            afterSunset: the sun is down at the home (settings lat / lon) — ignored without a location
//   actions  { type: 'quick_action', plugin, id, title?, state } — runs with gc.actions.run as the rule's owner
//            (the person who last set the actions; on the admin page the administrator). 1.4.0: `state`
//            'on' | 'off' is the target state of a toggle (null for a button), checked against the owner's
//            gc.actions.list when the actions are set: a toggle without one → 400 state_required, one on a
//            button → 400 invalid (an action the owner does not have is kept as given). Stored with it:
//            `kind` ('toggle' | 'button' | null = not known) and `verb` (the toggle's word for the state,
//            „Verriegeln“). The run passes `state` (GateControl ≥ 1.173.0: the plugin sets that state, a
//            locked car is never unlocked). A toggle stored without a state (rules made before 1.4.0) is
//            NOT run: result { ok: false, error: 'needs_target' }; rule views mark it `needsTarget: true`
//            (the pages: „Zielzustand fehlt – Regel bearbeiten“).
//            { type: 'notify', to: 'parents' | 'all' | [userId], text? } — push topic presence ({name} = the person,
//            {place} = the place of a place rule; data.familie of a place rule carries placeId)
//            1.6.0: { type: 'messenger', to: 'family' | [userId] (1–20 members), text? (≤ 500, same placeholders) }
//            — „Messenger-Nachricht senden“ through the Messenger plugin (server/messenger.js): into the
//            group „Familie“ (only while the group is switched on: else error 'group_off') or into each
//            person's own channel „Familie-Hinweise“ (not to the person who sets the rule off). Without the
//            messenger the action is not offered (listRules: `messenger.available`); a rule that still has
//            one logs { ok: false, error: 'unavailable' } and the rest of the rule runs.
// A rule fires once per transition and at most once per 10 minutes; a
// throttled "all away" is retried while everyone stays away, a throttled
// arrival or departure is dropped. Each run is logged with the result of every
// action (the last 50 are shown, rows kept 90 days; a quick action's result carries
// its state, verb and `unchanged`: the plugin found the state already set). In a
// rule view every quick action carries `available`: false when the owner no
// longer has it (the pages show "Aktion nicht mehr verfügbar"), null when
// unknown; `needsTarget` and `verb` (the owner's current word for the state).
//
// Places (1.5.0): the geofencing runs on the phone of a person who agreed
// („Orte für Regeln teilen“, consent `places`, independent of `share`). The
// watch list holds the places of the ACTIVE place rules for anyone or for the
// caller, with the union of their transitions; its version (12 hex of sha1)
// lets the phone re-fetch when it changed. An event within 60 s of the same
// one is a repeat (nothing runs); one older than 10 minutes (the phone was
// offline) is recorded but runs nothing — a late arrival must not open a door.
// Otherwise the matching rules run like every other trigger (throttle,
// conditions, after the commit). Events are kept 90 days, without positions.
//
// The place in the messenger status (1.8.0, server/messenger.js placeStatus): a change of
// home / away, a place event that runs (not repeated, not late) and a withdrawn consent
// collect { userId, place } into r.placeStatus — the place's name („Zuhause“ for home, the
// rule place's name), null when away / after leaving a place while not at home / without
// consent; sent to the Messenger after the commit. Never a position.
//
// 1.9.0 — rules and reminders (server/rules.js: the API `rules`, the trigger 'schedule', title,
// scope, device and calendar conditions; server/conditions.js, server/reminders.js): rules run
// only with the module rules on (default on); presence and place triggers still need the module
// presence. The conditions device / calendar are checked here, after the commit, right before the
// actions (not met → nothing runs, a log row { skipped: true } says why). The API presence/rules
// stays for the pages of before: it lists and changes only house rules with a presence or place
// trigger and keeps what it does not know (title, schedule, device / calendar conditions, the
// facts and buttons of a notification).
//
// 1.12.0 — the trigger 'school_change' (server/school.js, runs come from the service rule_event): the
// child the event is about is told as well (a lesson that falls out concerns the child itself), the
// event's text goes into {event} and the log (`event`).

const crypto = require('node:crypto');
const store = require('./store');
const members = require('./members');
const ruleplaces = require('./ruleplaces');
const rulerow = require('./rulerow');
const conditions = require('./conditions');
const reminders = require('./reminders');
const messenger = require('./messenger');
const texts = require('./texts.json');
const { fail, posInt, optText, bool, intIn, iso, parseIso, parseJson, userIds, TIME_RE } = require('./util');

const { rowToRule } = rulerow;

const TRIGGERS = ['all_away', 'first_home', 'child_home_alone', 'person_home', 'person_away', 'place_enter', 'place_exit'];
const PLACE_TRIGGERS = { place_enter: 'enter', place_exit: 'exit' };
const TRANSITIONS = ['enter', 'exit'];
const EVENT_DEDUPE_MS = 60000;
const EVENT_LATE_MS = 10 * 60000;
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
const STATES = ['on', 'off'];

// ─── state ──────────────────────────────────────

/** The name of home in the messenger status (1.8.0): „Zuhause“ / „Home“ (notification language). */
const homeName = (cfg) => texts[cfg && cfg.lang === 'en' ? 'en' : 'de']['services.home'];

/** Collect a place change for the messenger status (1.8.0) — r.placeStatus, when the caller has one. */
function notePlace(r, userId, place) {
  if (r && Array.isArray(r.placeStatus)) r.placeStatus.push({ userId, place: place || null });
}

/** Map userId → { share, places, home: bool|null, since } for the family members (places: 1.5.0, the own consent for places). */
async function load(gc, fam) {
  const consent = new Map((await store.all(gc, 'SELECT user_id, share, places FROM presence_consent')).map((x) => [x.user_id, x]));
  const state = new Map((await store.all(gc, 'SELECT * FROM presence_state')).map((x) => [x.user_id, x]));
  const out = new Map();
  for (const m of fam.list) {
    const c = consent.get(m.userId);
    const share = !!(c && c.share);
    const s = share ? state.get(m.userId) : null;
    out.set(m.userId, { share, places: !!(c && c.places), home: s ? !!s.home : null, since: s ? s.since : null });
  }
  return out;
}

function stateOf(p) {
  if (!p || !p.share) return 'not_shared';
  if (p.home == null) return 'unknown';
  return p.home ? 'home' : 'away';
}

/** The avatar ring of one state (1.3.0): 'home' | 'away' | 'unknown' | null (not shared). */
function ringOf(p) {
  const s = stateOf(p);
  return s === 'not_shared' ? null : s;
}

/**
 * Every member's ring for the member objects of the app and the pages (1.3.0):
 * Map userId → 'home' | 'away' | 'unknown' | null. Empty (all null) when the
 * module is off or for a viewer recognised only by device trust.
 */
async function rings(gc, fam, cfg, trustOnly) {
  if (!cfg.modules.presence || trustOnly) return new Map();
  const map = await load(gc, fam);
  return new Map([...map.entries()].map(([id, p]) => [id, ringOf(p)]));
}

function membersView(fam, map) {
  return fam.list.map((m) => {
    const p = map.get(m.userId);
    return {
      userId: m.userId, name: m.name, role: m.role, ...members.faceOf(m), presence: ringOf(p),
      shared: !!(p && p.share), placesShared: !!(p && p.places), state: stateOf(p), home: p ? p.home : null, since: iso(p && p.since),
    };
  });
}

/** GET presence */
async function get(gc, r) {
  const map = await load(gc, r.fam);
  const mine = map.get(r.me.userId);
  return {
    members: membersView(r.fam, map),
    me: { share: !!(mine && mine.share), places: !!(mine && mine.places) },
    home: [...map.entries()].filter(([, p]) => p.share && p.home === true).map(([id]) => id),
    watchVersion: (await watch(gc, r.me.userId)).version,
  };
}

/**
 * PUT presence/consent { share?, places? } — only for oneself; each optional, at least one.
 * share false deletes the home / away state; places false empties the phone's watch list
 * (the place events stay for the log).
 */
async function consent(gc, r) {
  const b = r.body || {};
  if (b.share === undefined && b.places === undefined) throw fail('invalid');
  const share = b.share === undefined ? undefined : bool(b.share);
  const places = b.places === undefined ? undefined : bool(b.places);
  const cur = await store.one(gc, 'SELECT share, places FROM presence_consent WHERE user_id = ?', [r.me.userId]);
  const next = { share: share !== undefined ? share : !!(cur && cur.share), places: places !== undefined ? places : !!(cur && cur.places) };
  await store.run(gc, `INSERT INTO presence_consent (user_id, share, places, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET share = excluded.share, places = excluded.places, updated_at = excluded.updated_at`,
  [r.me.userId, next.share ? 1 : 0, next.places ? 1 : 0, r.now]);
  if (!next.share) await store.run(gc, 'DELETE FROM presence_state WHERE user_id = ?', [r.me.userId]);
  const p = (await load(gc, r.fam)).get(r.me.userId);
  // 1.8.0: a withdrawn consent takes the place out of the messenger status (home stays while shared)
  if ((cur && cur.share && !next.share) || (cur && cur.places && !next.places)) notePlace(r, r.me.userId, p.share && p.home === true ? homeName(r.cfg) : null);
  return { consent: next, state: { userId: r.me.userId, state: stateOf(p), home: p.home, since: iso(p.since) } };
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
    notePlace(r, r.me.userId, home ? homeName(r.cfg) : null);
    await fire(gc, r.fam, r.cfg, r.now, events, r.runs);
    await checkAllAway(gc, r.fam, r.cfg, r.now, r.runs);
  } else {
    await store.run(gc, 'UPDATE presence_state SET reported_at = ? WHERE user_id = ?', [r.now, r.me.userId]);
  }
  const since = changed ? at : row.since;
  return { state: { userId: r.me.userId, home, since: iso(since) }, changed, watchVersion: (await watch(gc, r.me.userId)).version };
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

/** Local "HH:MM" of now in the window (from inclusive, to exclusive; may span midnight). */
const { inWindow } = conditions;

/** The rule's own conditions (time window, after sunset) — the others are checked by execute(). */
function conditionsHold(rule, cfg, now) {
  return conditions.syncHold(rule, cfg, now);
}

const throttled = (rule, now) => rule.lastRunAt != null && now - rule.lastRunAt < THROTTLE_MS;

const activeRules = rulerow.activeRules;

/**
 * Event triggers: the matching rules run now (not throttled, conditions hold) → runs.
 * A place event ({ trigger: 'place_enter' | 'place_exit', userId, placeId, placeName }) matches
 * the rules of that place for anyone (userId null) or that person.
 */
async function fire(gc, fam, cfg, now, events, runs) {
  // 1.9.0: no rule runs while the module rules is off
  if (cfg.modules.rules === false) return;
  for (const ev of events) {
    const place = !!PLACE_TRIGGERS[ev.trigger];
    for (const rule of await activeRules(gc, ev.trigger)) {
      if ((ev.trigger === 'person_home' || ev.trigger === 'person_away') && rule.userId !== ev.userId) continue;
      if (place && (rule.placeId !== ev.placeId || (rule.userId !== null && rule.userId !== ev.userId))) continue;
      if (throttled(rule, now) || !conditionsHold(rule, cfg, now)) continue;
      await store.run(gc, 'UPDATE presence_rules SET last_run_at = ? WHERE id = ?', [now, rule.id]);
      runs.push(place ? { rule, trigger: ev.trigger, userId: ev.userId, placeId: ev.placeId, placeName: ev.placeName } : { rule, trigger: ev.trigger, userId: ev.userId });
    }
  }
}

/**
 * "Everyone away": all sharing members reported away (at least one). The
 * episode is the moment the last one left; each rule handles it once, after
 * its grace time — throttled: later, while everyone stays away.
 */
async function checkAllAway(gc, fam, cfg, now, runs) {
  if (cfg.modules.rules === false) return;
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

/** The text of a notify or messenger action: its own (or the default of the trigger) with the placeholders filled. */
function actionText(a, run, person, cfg, vars) {
  return reminders.textOf(a, run, person, cfg, vars, run.rule);
}

function recipients(action, fam, triggerUser, rule) {
  let ids;
  if (action.to === 'parents') ids = members.parents(fam).map((m) => m.userId);
  else if (action.to === 'all') ids = fam.list.map((m) => m.userId);
  else ids = (Array.isArray(action.to) ? action.to : []).filter((id) => fam.byId.has(id));
  // 1.9.0: a person's own rule only ever tells that person
  if (rule && rule.scope === 'personal') ids = ids.filter((id) => id === rule.ownerId);
  return ids.filter((id) => id !== triggerUser);
}

/**
 * Run the collected rules (after the commit): quick actions as the owner,
 * notifications into `pushes`; one log row per run.
 */
async function execute(gc, fam, cfg, now, runs, pushes) {
  const lists = new Map(); // ownerId → Promise<Map('plugin|id' → action)> (only for actions stored without a known kind)
  const listOf = (owner) => {
    if (!lists.has(owner)) lists.set(owner, gc.actions.list({ userId: owner, lang: cfg.lang }).then((l) => new Map(l.map((x) => [`${x.plugin}|${x.id}`, x]))));
    return lists.get(owner);
  };
  const cache = new Map(); // device values and quick action lists of this pass
  for (const run of runs) {
    const { rule } = run;
    const person = run.userId ? fam.byId.get(run.userId) : null;
    // 1.12.0: nobody is left out of a school event's notification (the child did not cause it)
    const causer = run.trigger === 'school_change' ? null : run.userId;
    const results = [];
    // 1.9.0: the conditions that need other plugins (device values, calendar), right before the actions
    let ev = null;
    if (conditions.needsEvaluate(rule)) {
      try { ev = await conditions.evaluate(gc, fam, cfg, now, rule, cfg.lang, cache); } catch (e) { ev = { ok: false, checks: [{ kind: 'device', ok: false, known: false, text: (e && e.code) || 'error' }], facts: [], vars: {} }; }
      if (!ev.ok) {
        const skipped = ev.checks.filter((x) => !x.ok).map((x) => ({ type: 'condition', kind: x.kind, ok: false, known: x.known !== false, text: x.text, error: x.known === false ? 'unknown' : 'not_met' }));
        await writeLog(gc, run, now, false, skipped);
        continue;
      }
    }
    const key = run.key || `run:${now}`;
    for (const a of rule.actions) {
      if (a.type === 'quick_action') {
        const state = STATES.includes(a.state) ? a.state : null;
        const base = { type: 'quick_action', plugin: a.plugin, id: a.id, title: a.title || null, state, verb: (state && a.verb) || null };
        if (!gc.actions || typeof gc.actions.run !== 'function') { results.push({ ...base, ok: false, message: null, error: 'unavailable' }); continue; }
        // 1.9.0: a person's own rule switches only what that person may switch (its owner never changes)
        try {
          // without a state: a button runs; a toggle (or an action stored before 1.4.0 that the owner lists as one) needs a target first
          if (!state && a.kind !== 'button') {
            const listed = a.kind === 'toggle' ? a : (await listOf(rule.ownerId)).get(`${a.plugin}|${a.id}`);
            if (listed && listed.kind === 'toggle') { results.push({ ...base, ok: false, message: null, error: 'needs_target' }); continue; }
          }
          const x = await gc.actions.run({ userId: rule.ownerId, plugin: a.plugin, id: a.id, lang: cfg.lang, ...(state ? { state } : {}) });
          results.push({
            ...base, ok: !!(x && x.ok === true), message: (x && x.message) || null, error: (x && x.error) || (x && x.ok === true ? null : 'failed'),
            unchanged: !!(x && x.unchanged === true),
          });
        } catch (e) {
          results.push({ ...base, ok: false, message: null, error: hostCode(e) });
        }
      } else if (a.type === 'notify') {
        const to = recipients(a, fam, causer, rule);
        // 1.9.0: facts and buttons (server/reminders.js); a reminder row per person with buttons
        const out = await reminders.notifyPushes(gc, fam, cfg, now, { rule, run, action: a, person, ev, to, key, cache });
        pushes.push(...out.pushes);
        if (out.keyed.length) await reminders.remember(gc, cfg, now, rule.id, key, out.keyed);
        results.push({ type: 'notify', ok: to.length > 0, sent: to.length, error: to.length ? null : 'no_recipients' });
      } else if (a.type === 'messenger') {
        // 1.6.0: never throws; without the messenger { ok: false, error: 'unavailable' } and the rest runs
        // 1.9.0: a person's own rule only writes to that person
        const target = rule.scope === 'personal' ? { ...a, to: [rule.ownerId] } : a;
        const res = await messenger.sendAction(gc, fam, cfg, now, target, actionText(a, run, person, cfg, ev && ev.vars), rule.scope === 'personal' ? null : causer);
        if (res.error === 'unavailable') gc.log.warn('messenger not available – rule action skipped', rule.id);
        results.push(res);
      }
    }
    const ok = results.every((x) => x.ok);
    await writeLog(gc, run, now, ok, results);
    if (!ok) gc.log.warn('presence rule run failed', rule.id, results.filter((x) => !x.ok).map((x) => x.error).join(','));
  }
}

/** One row of the rule log (own transaction); results of type 'condition': not run, a condition of another plugin was not met. */
async function writeLog(gc, run, now, ok, results) {
  const { rule } = run;
  try {
    await store.tx(gc, () => store.run(gc, `INSERT INTO presence_log (rule_id, rule_name, trigger_type, user_id, at, ok, results_json, place_id, place_name, event_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [rule.id, rule.title || rule.name, run.trigger, run.userId || null, now, ok ? 1 : 0, JSON.stringify(results),
      run.placeId || null, run.placeName || null, run.event || null]));
  } catch (e) { gc.log.warn('presence log failed', (e && e.code) || 'error'); }
}

// ─── places (1.5.0) ─────────────────────────────

/** Has `userId` agreed to report places? */
async function placesConsent(gc, userId) {
  const c = await store.one(gc, 'SELECT places FROM presence_consent WHERE user_id = ?', [userId]);
  return !!(c && c.places);
}

/**
 * GET presence/watch — the places the phone of `userId` watches: those of the active place rules
 * for anyone or for this person, with the union of their transitions, by id; empty without
 * consent. version: the first 12 hex characters of sha1 over the JSON of the list.
 */
async function watch(gc, userId) {
  const places = [];
  if (await placesConsent(gc, userId)) {
    const rows = await store.all(gc, `SELECT r.trigger_type, p.id, p.name, p.lat, p.lon, p.radius FROM presence_rules r JOIN rule_places p ON p.id = r.place_id
      WHERE r.active = 1 AND r.trigger_type IN ('place_enter', 'place_exit') AND (r.user_id IS NULL OR r.user_id = ?) ORDER BY p.id`, [userId]);
    for (const x of rows) {
      let w = places[places.length - 1];
      if (!w || w.id !== x.id) { w = { id: x.id, name: x.name, lat: x.lat, lon: x.lon, radius: x.radius, transitions: [] }; places.push(w); }
      const t = PLACE_TRIGGERS[x.trigger_type];
      if (!w.transitions.includes(t)) w.transitions = TRANSITIONS.filter((y) => y === t || w.transitions.includes(y));
    }
  }
  return { places, version: crypto.createHash('sha1').update(JSON.stringify(places)).digest('hex').slice(0, 12) };
}

/**
 * POST presence/places/<id>/event { transition, at? } — the phone of the caller entered / left a
 * rule place. Recorded either way; a repeat (same person, place and transition within 60 s) or a
 * late event (more than 10 minutes old) runs nothing, otherwise the matching rules → r.runs.
 */
async function placeEvent(gc, r, raw) {
  if (!(await placesConsent(gc, r.me.userId))) throw fail('no_consent');
  const place = await ruleplaces.byId(gc, raw);
  if (!place) throw fail('not_found');
  const b = r.body || {};
  if (!TRANSITIONS.includes(b.transition)) throw fail('invalid', { field: 'transition' });
  let at = b.at == null ? r.now : parseIso(b.at);
  if (at == null) throw fail('invalid', { field: 'at' });
  at = Math.min(at, r.now);
  const prev = await store.one(gc, 'SELECT at FROM place_rule_events WHERE user_id = ? AND place_id = ? AND transition = ? ORDER BY at DESC, id DESC LIMIT 1',
    [r.me.userId, place.id, b.transition]);
  const repeated = !!(prev && Math.abs(at - prev.at) < EVENT_DEDUPE_MS);
  const late = r.now - at > EVENT_LATE_MS;
  const before = r.runs.length;
  if (!repeated && !late) {
    const trigger = b.transition === 'enter' ? 'place_enter' : 'place_exit';
    // 1.8.0: the messenger status — the place's name on arrival; on leaving „Zuhause“ while at home, else null
    if (b.transition === 'enter') notePlace(r, r.me.userId, place.name);
    else {
      const p = (await load(gc, r.fam)).get(r.me.userId);
      notePlace(r, r.me.userId, p && p.share && p.home === true ? homeName(r.cfg) : null);
    }
    await fire(gc, r.fam, r.cfg, r.now, [{ trigger, userId: r.me.userId, placeId: place.id, placeName: place.name }], r.runs);
  }
  const fired = r.runs.length - before;
  await store.run(gc, 'INSERT INTO place_rule_events (place_id, user_id, transition, at, received_at, fired, late) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [place.id, r.me.userId, b.transition, at, r.now, fired, late ? 1 : 0]);
  return { fired, late, repeated };
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
      if (a.state != null && !STATES.includes(a.state)) throw fail('invalid', { field: `${at}.state` });
      return { type: 'quick_action', plugin: a.plugin, id: a.id, title: title || null, state: a.state == null ? null : a.state, kind: null, verb: null };
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
    if (a.type === 'messenger') {
      let to;
      if (a.to === 'family') to = 'family';
      else {
        try { to = userIds(a.to, messenger.PEOPLE_MAX); } catch { throw fail('invalid', { field: `${at}.to` }); }
        if (!to.length || to.some((id) => !fam.byId.has(id))) throw fail('invalid', { field: `${at}.to` });
      }
      let text;
      try { text = optText(a.text, messenger.TEXT_MAX); } catch { throw fail('invalid', { field: `${at}.text` }); }
      return { type: 'messenger', to, text: text || null };
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
  } else if (PLACE_TRIGGERS[f.trigger]) {
    // a place rule: a member, or null = anyone who shares places; the place is checked by checkPlace
    const raw = b.userId !== undefined ? b.userId : (cur ? cur.userId : null);
    const id = raw == null ? null : posInt(raw);
    if (raw != null && (!id || !fam.byId.has(id))) throw fail('invalid', { field: 'userId' });
    f.userId = id;
  } else f.userId = null;
  f.placeId = PLACE_TRIGGERS[f.trigger] ? (b.placeId !== undefined ? b.placeId : (cur ? cur.placeId : null)) : null;
  f.graceMinutes = b.graceMinutes !== undefined ? intIn(b.graceMinutes, 0, 120) : (cur ? cur.graceMinutes : GRACE_DEFAULT);
  f.conditions = b.conditions !== undefined ? parseConditions(b.conditions) : (cur ? cur.conditions : { time: null, afterSunset: false });
  // 1.9.0: the pages of before know only the time window and „after sunset“ — the device and calendar conditions stay
  f.conditions = { ...f.conditions, device: cur && cur.conditions.device ? cur.conditions.device : [], calendar: cur && cur.conditions.calendar ? cur.conditions.calendar : null };
  f.actions = b.actions !== undefined || !cur ? parseActions(b.actions, fam) : cur.actions;
  f.active = b.active !== undefined ? bool(b.active) : (cur ? cur.active : true);
  return f;
}

/** A place rule needs an existing rule place (400 invalid { field: 'placeId' }); f.placeId becomes its id. */
async function checkPlace(gc, f) {
  if (!PLACE_TRIGGERS[f.trigger]) return;
  const p = f.placeId == null ? null : await ruleplaces.byId(gc, f.placeId);
  if (!p) throw fail('invalid', { field: 'placeId' });
  f.placeId = p.id;
}

/** The quick actions `owner` has right now: Map 'plugin|id' → listed action, or null when unknown. */
async function ownerActions(gc, owner, lang) {
  if (!gc.actions || typeof gc.actions.list !== 'function') return null;
  try {
    return new Map((await gc.actions.list({ userId: owner, lang })).map((a) => [`${a.plugin}|${a.id}`, a]));
  } catch { return null; }
}

/**
 * The quick actions of a rule being saved, checked against what the owner has (1.4.0): a toggle needs
 * a target state (400 state_required), a button takes none (400 invalid); kind and verb stored with
 * them. An action the owner does not have (or a list the host refuses) is kept as given, kind unknown.
 */
async function checkTargets(gc, actions, owner, lang) {
  if (!actions.some((a) => a.type === 'quick_action')) return actions;
  const listed = await ownerActions(gc, owner, lang);
  return actions.map((a, i) => {
    if (a.type !== 'quick_action') return a;
    const x = listed && listed.get(`${a.plugin}|${a.id}`);
    if (!x) return { ...a, kind: null, verb: null };
    if (x.kind === 'toggle') {
      if (!a.state) throw fail('state_required', { field: `actions.${i}.state` });
      return { ...a, kind: 'toggle', verb: (x.verbs && x.verbs[a.state]) || null };
    }
    if (a.state) throw fail('invalid', { field: `actions.${i}.state` });
    return { ...a, kind: 'button', verb: null };
  });
}

/** Which quick actions each owner has right now: Map ownerId → Map('plugin|id' → action) | null (unknown). */
async function availability(gc, rules, lang) {
  const out = new Map();
  for (const owner of new Set(rules.filter((x) => x.actions.some((a) => a.type === 'quick_action')).map((x) => x.ownerId))) {
    out.set(owner, await ownerActions(gc, owner, lang));
  }
  return out;
}

/** A rule's quick action as the pages see it: available, needsTarget (a toggle without a state), the current verb. */
function actionView(a, listed) {
  const x = listed ? listed.get(`${a.plugin}|${a.id}`) : null;
  const state = STATES.includes(a.state) ? a.state : null;
  const kind = x ? x.kind : (a.kind || null);
  return {
    ...a, state, kind, verb: state ? ((x && x.verbs && x.verbs[state]) || a.verb || null) : null,
    available: listed ? !!x : null, needsTarget: !state && kind === 'toggle',
  };
}

function ruleView(rule, fam, avail, last, places) {
  const listed = avail.get(rule.ownerId);
  const owner = fam.byId.get(rule.ownerId) || fam.users.get(rule.ownerId);
  const place = rule.placeId != null && PLACE_TRIGGERS[rule.trigger] ? places.get(rule.placeId) : null;
  return {
    id: rule.id, name: rule.name, trigger: rule.trigger, userId: rule.userId, placeId: place ? place.id : null, placeName: place ? place.name : null,
    graceMinutes: rule.graceMinutes, conditions: { time: rule.conditions.time, afterSunset: rule.conditions.afterSunset },
    actions: rule.actions.map((a) => (a.type === 'quick_action' ? actionView(a, listed) : a)),
    active: rule.active, ownerId: rule.ownerId, ownerName: owner ? owner.name : null, lastRunAt: iso(rule.lastRunAt),
    lastResult: last ? { at: iso(last.at), ok: !!last.ok } : null, createdAt: iso(rule.createdAt), updatedAt: iso(rule.updatedAt),
  };
}

const logView = (x) => ({
  id: x.id, ruleId: x.rule_id, ruleName: x.rule_name || '', trigger: x.trigger_type, userId: x.user_id == null ? null : x.user_id,
  placeId: x.place_id == null ? null : x.place_id, placeName: x.place_name == null ? null : x.place_name, at: iso(x.at), ok: !!x.ok, results: parseJson(x.results_json, []),
  // 1.9.0: not run — a device or calendar condition was not met (results of type 'condition')
  skipped: parseJson(x.results_json, []).some((y) => y && y.type === 'condition'),
  // 1.12.0: what a school event said („Lena: Mathe 3. Std. (09:50) fällt aus“), else null
  event: x.event_text == null ? null : x.event_text,
});

async function log(gc) {
  return (await store.all(gc, 'SELECT * FROM presence_log ORDER BY at DESC, id DESC LIMIT ?', [LOG_SHOWN])).map(logView);
}

/** 1.9.0: the rules the API presence/rules knows — house rules with a presence or place trigger. */
const legacy = (rule) => rule.scope === 'house' && TRIGGERS.includes(rule.trigger);

async function rulesView(gc, fam, lang, ids) {
  const rows = await store.all(gc, 'SELECT * FROM presence_rules ORDER BY id');
  const rules = rows.map(rowToRule).filter((x) => legacy(x) && (!ids || ids.includes(x.id)));
  const avail = await availability(gc, rules, lang);
  const lastRows = await store.all(gc, 'SELECT l.* FROM presence_log l WHERE l.id = (SELECT m.id FROM presence_log m WHERE m.rule_id = l.rule_id ORDER BY m.at DESC, m.id DESC LIMIT 1)');
  const last = new Map(lastRows.map((x) => [x.rule_id, x]));
  const places = await ruleplaces.all(gc);
  return rules.map((x) => ruleView(x, fam, avail, last.get(x.id), places));
}

/** ctx: { fam, cfg, now, ownerId, lang } — shared by the member API (parents) and the admin page. */
async function listRules(gc, ctx) {
  // 1.6.0: whether the editor offers „Messenger-Nachricht senden“ (and the group as a target)
  return { rules: await rulesView(gc, ctx.fam, ctx.lang), log: await log(gc), messenger: await messenger.info(gc, ctx.cfg) };
}

async function createRule(gc, ctx, body) {
  if ((await store.one(gc, "SELECT COUNT(*) AS n FROM presence_rules WHERE scope = 'house'")).n >= MAX_RULES) throw fail('too_many');
  const f = ruleFields(body, null, ctx.fam);
  await checkPlace(gc, f);
  f.actions = await checkTargets(gc, f.actions, ctx.ownerId, ctx.lang);
  const res = await store.run(gc, `INSERT INTO presence_rules (name, title, scope, trigger_type, user_id, place_id, grace_minutes, conditions_json, actions_json, active, owner_id, created_at, updated_at)
    VALUES (?, ?, 'house', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [f.name, f.name, f.trigger, f.userId, f.placeId, f.graceMinutes, JSON.stringify(f.conditions), JSON.stringify(f.actions), f.active ? 1 : 0, ctx.ownerId, ctx.now, ctx.now]);
  return { rule: (await rulesView(gc, ctx.fam, ctx.lang, [res.lastInsertRowid]))[0] };
}

async function ruleRow(gc, raw) {
  const id = posInt(raw);
  const row = id ? await store.one(gc, 'SELECT * FROM presence_rules WHERE id = ?', [id]) : null;
  if (!row || !legacy(rowToRule(row))) throw fail('not_found');
  return rowToRule(row);
}

/** 1.9.0: a notification set again through the pages of before keeps its facts and buttons. */
function keepExtras(actions, cur) {
  const old = cur.actions.find((a) => a.type === 'notify');
  if (!old || (!old.facts && !(old.buttons && old.buttons.length))) return actions;
  return actions.map((a) => (a.type === 'notify' ? { ...a, facts: !!old.facts, buttons: Array.isArray(old.buttons) ? old.buttons : [] } : a));
}

async function updateRule(gc, ctx, raw, body) {
  const cur = await ruleRow(gc, raw);
  const f = ruleFields(body, cur, ctx.fam);
  await checkPlace(gc, f);
  // whoever sets the actions owns them: the quick actions run as that person (and are checked against what they have)
  const owner = body && body.actions !== undefined ? ctx.ownerId : cur.ownerId;
  if (body && body.actions !== undefined) f.actions = keepExtras(await checkTargets(gc, f.actions, owner, ctx.lang), cur);
  // a changed trigger or place starts afresh
  const lastKey = f.trigger === cur.trigger && f.placeId === cur.placeId ? cur.lastKey : null;
  // the name of before is the title (1.9.0)
  const title = body && body.name !== undefined ? f.name : cur.title;
  await store.run(gc, `UPDATE presence_rules SET name = ?, title = ?, trigger_type = ?, user_id = ?, place_id = ?, grace_minutes = ?, conditions_json = ?, actions_json = ?, active = ?, owner_id = ?,
    last_key = ?, updated_at = ? WHERE id = ?`, [f.name, title, f.trigger, f.userId, f.placeId, f.graceMinutes, JSON.stringify(f.conditions), JSON.stringify(f.actions), f.active ? 1 : 0, owner, lastKey, ctx.now, cur.id]);
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
  await store.run(gc, 'DELETE FROM place_rule_events WHERE at < ?', [now - LOG_KEEP_DAYS * DAY]);
}

/** Overview: who is home (sharing members only), the caller's consent; 1.3.0: every member like GET presence. */
async function overview(gc, r) {
  const map = await load(gc, r.fam);
  const mine = map.get(r.me.userId);
  return {
    home: [...map.entries()].filter(([, p]) => p.share && p.home === true).map(([id, p]) => ({ userId: id, since: iso(p.since) })),
    share: !!(mine && mine.share),
    members: membersView(r.fam, map),
  };
}

module.exports = {
  STATES, MAX_ACTIONS, NAME_MAX, TEXT_MAX, PLUGIN_ID_RE, ACTION_ID_RE, GRACE_DEFAULT, legacy, actionView, availability, ownerActions, checkPlace, checkTargets, parseConditions, logView, hostCode, recipients,
  TRIGGERS, PLACE_TRIGGERS, THROTTLE_MS, REPORT_GAP_MS, EVENT_DEDUPE_MS, EVENT_LATE_MS, load, stateOf, ringOf, rings, membersView, get, consent, report, transitionEvents,
  inWindow, conditionsHold, fire, checkAllAway, tick, execute, listRules, createRule, updateRule, removeRule, actions, log, purge, overview, watch, placeEvent,
};
