'use strict';

// Rules and reminders (1.9.0, module rules — „Regeln und Erinnerungen“, default on): the
// presence rules grown into one rule model with a title, a scope, the trigger 'schedule' and
// conditions of other plugins. The engine: server/presence.js (presence and place triggers, the
// run), server/conditions.js (schedule, device values, calendar), server/reminders.js (facts,
// buttons, snooze / done).
//
// Member API (app, portal; paths relative to the plugin's /api/; a viewer recognised only by
// device trust gets 403 login_required, a wall tablet 403 forbidden):
//   GET    rules                 { rules: [rule], log: [run], can: { house, personal }, open: [reminder] }
//                                children see only their own rules (and their runs)
//   POST   rules                 rule body (below) → { rule }
//   PATCH  rules/<id>            any subset → { rule }   ({ active } pauses / resumes)
//   DELETE rules/<id>            {}
//   POST   rules/<id>/test       the dry run („Probelauf“, nothing runs) → { wouldFire, details: [{ kind, ok, text }] }
//   POST   rules/test            the same for an unsaved rule body
//   GET    rules/options         what the editor offers → { triggers, devices, actions, calendars, places, people,
//                                messenger, can, features, location }
//   1.11.0:
//   POST   rules/open/<ruleId>/done | snooze   { key } — one's own open reminder („Erledigt“, „In 1 Std.“)
//   PUT    rules/vacation        { on, until?: 'YYYY-MM-DD' } (parents) — the holiday mode: every active
//                                house rule paused, those resumed when it ends (by hand or after `until`)
//   GET rules also carries `vacation: { on, until, since, paused }`; `open` every member's for parents.
//   1.12.0: the trigger 'school_change' („Stunde fällt aus“, server/school.js) — offered in rules/options
//   (`triggers` and `school: { students: [{ userId, name }] }`) only while the Schule plugin is there.
// Admin page „Regeln & Erinnerungen“: admin/rules … with the same paths (every rule; quick actions of a
// rule saved there run as the administrator).
//
// Rights: house rules (scope 'house') only parents (and the administrator); a person's own rules
// (scope 'personal') every parent, children only with the setting children_own_rules (default off).
// A personal rule tells only its owner (notify / messenger to oneself) and switches only quick
// actions its owner has; its owner never changes. Parents see every rule, may pause or delete a
// child's own rule, and leave another parent's own rules alone. The scope cannot be changed.
// Limits: 50 house rules, 20 own rules per person (409 too_many).
//
// Rule (client JSON):
//   { id, title, scope, active, kind: 'reminder' | 'presence' | 'place',
//     trigger: { type: 'schedule', weekdays: [1..7], time: 'HH:MM' }
//            | { type: 'all_away', graceMinutes } | { type: 'first_home' } | { type: 'child_home_alone' }
//            | { type: 'person_home' | 'person_away', userId }
//            | { type: 'place_enter' | 'place_exit', placeId, placeName, userId | null }
//            | { type: 'school_change', userId | null, kinds: ['cancelled' | 'changed' | 'extra' | 'restored'], days: 'today' | 'tomorrow' | 'any' }   (1.12.0, kind 'school'),
//     conditions: { time: { from, to } | null, afterSunset, device: [{ actionId, field, op, value, label, unit }],
//                   calendar: { dayOffset, sources, match, memberIds } | null },
//     actions: [{ type: 'quick_action', actionId, plugin, id, title, state, kind, verb, available, needsTarget }
//              | { type: 'notify', to: 'parents' | 'all' | [userId], text, facts, buttons }
//              | { type: 'messenger', to: 'family' | [userId], text }],
//     lastRunAt, lastResult: { at, ok, skipped } | null, ownerId, ownerName, editable, pausable, createdAt, updatedAt }
//   On input `to: 'me'` is the caller; a quick action is { actionId } or { plugin, id } (+ state for a switch).

const store = require('./store');
const tz = require('./tz');
const members = require('./members');
const presence = require('./presence');
const ruleplaces = require('./ruleplaces');
const conditions = require('./conditions');
const reminders = require('./reminders');
const messenger = require('./messenger');
const rulerow = require('./rulerow');
const format = require('./format');
const school = require('./school');
const { fail, posInt, optText, bool, iso, parseJson, userIds } = require('./util');

const SCHEDULE = 'schedule';
const SCHOOL = school.TRIGGER;
const TRIGGERS = [SCHEDULE, ...presence.TRIGGERS, SCHOOL];
const SCOPES = ['house', 'personal'];
const MAX_HOUSE = 50;
const MAX_PERSONAL = 20;
const TITLE_MAX = 60;
const LOG_SHOWN = 50;
const SELF = 'gatecontrol-familie';
const ACTION_REF_RE = /^([a-z0-9]+(?:-[a-z0-9]+)*)\/([A-Za-z0-9:._-]{1,64})$/;

const isPlace = (t) => !!presence.PLACE_TRIGGERS[t];
const isPerson = (t) => t === 'person_home' || t === 'person_away';
const kindOf = (t) => (t === SCHEDULE ? 'reminder' : (isPlace(t) ? 'place' : (t === SCHOOL ? 'school' : 'presence')));
const bad = (field) => fail('invalid', { field });

// ─── rights ─────────────────────────────────────

/** ctx = { fam, cfg, now, lang, me (member | null on the admin page), userId, admin } */
function can(ctx) {
  if (ctx.admin) return { house: true, personal: false };
  const role = ctx.me && ctx.me.role;
  return { house: role === 'parent', personal: role === 'parent' || (role === 'child' && ctx.cfg.childrenOwnRules === true) };
}

function visible(rule, ctx) {
  if (ctx.admin || (ctx.me && ctx.me.role === 'parent')) return true;
  return rule.scope === 'personal' && rule.ownerId === ctx.userId;
}

/** What the caller may do with a rule: 'full' | 'pause' (active, delete) | null. */
function rights(rule, ctx) {
  if (ctx.admin) return 'full';
  const me = ctx.me;
  if (!me || me.role === 'wall') return null;
  if (rule.scope === 'house') return me.role === 'parent' ? 'full' : null;
  if (rule.ownerId === ctx.userId) return can(ctx).personal ? 'full' : 'pause';
  const owner = ctx.fam.byId.get(rule.ownerId);
  if (me.role === 'parent' && (!owner || owner.role === 'child')) return 'pause';
  return null;
}

// ─── parsing ────────────────────────────────────

function wrap(fn) {
  try { return fn(); } catch (e) {
    if (e instanceof conditions.Bad) throw bad(e.field);
    throw e;
  }
}

/** The trigger of a body (object, or the flat fields of the presence API) → { trigger, userId, placeId, graceMinutes, schedule, school } */
function parseTrigger(b, cur, fam) {
  let t = b.trigger;
  if (t === undefined && cur) {
    return { trigger: cur.trigger, userId: cur.userId, placeId: cur.placeId, graceMinutes: cur.graceMinutes, schedule: cur.schedule, school: cur.school || null };
  }
  if (typeof t === 'string') t = { type: t, userId: b.userId, placeId: b.placeId, graceMinutes: b.graceMinutes, ...(b.schedule || {}) };
  if (!t || typeof t !== 'object' || Array.isArray(t) || !TRIGGERS.includes(t.type)) throw bad('trigger');
  const out = { trigger: t.type, userId: null, placeId: null, graceMinutes: presence.GRACE_DEFAULT, schedule: null, school: null };
  if (t.type === SCHOOL) {
    // 1.12.0: a child (or any child), the kinds of change, the day of the lesson
    let o;
    try { o = school.parseTrigger(t, fam); } catch (e) { if (e instanceof school.Invalid) throw bad(e.field); throw e; }
    out.userId = o.userId;
    out.school = { kinds: o.kinds, days: o.days };
  } else if (t.type === SCHEDULE) {
    out.schedule = conditions.parseSchedule(t);
    if (!out.schedule) throw bad('trigger.schedule');
  } else if (isPerson(t.type)) {
    const id = posInt(t.userId);
    if (!id || !fam.byId.has(id)) throw bad('trigger.userId');
    out.userId = id;
  } else if (isPlace(t.type)) {
    const id = t.userId == null ? null : posInt(t.userId);
    if (t.userId != null && (!id || !fam.byId.has(id))) throw bad('trigger.userId');
    out.userId = id;
    out.placeId = t.placeId == null ? null : t.placeId;
  } else if (t.type === 'all_away' && t.graceMinutes != null) {
    if (!Number.isInteger(t.graceMinutes) || t.graceMinutes < 0 || t.graceMinutes > 120) throw bad('trigger.graceMinutes');
    out.graceMinutes = t.graceMinutes;
  }
  return out;
}

function parseConds(v, fam) {
  if (v == null) return { time: null, afterSunset: false, device: [], calendar: null };
  if (typeof v !== 'object' || Array.isArray(v)) throw bad('conditions');
  const base = presence.parseConditions({ time: v.time, afterSunset: v.afterSunset });
  const device = wrap(() => conditions.parseDevice(v.device));
  const calendar = wrap(() => conditions.parseCalendar(v.calendar));
  if (calendar && calendar.memberIds && calendar.memberIds.some((id) => !fam.byId.has(id))) throw bad('conditions.calendar.memberIds');
  return { ...base, device, calendar };
}

/** `to` of a notify / messenger action: 'me' → [the owner]; ids must be members. */
function people(v, at, fam, ownerId, max) {
  if (v === 'me') return [ownerId];
  let ids;
  try { ids = userIds(v, max); } catch { throw bad(`${at}.to`); }
  if (!ids.length || ids.some((id) => !fam.byId.has(id))) throw bad(`${at}.to`);
  return ids;
}

function parseActions(v, fam, scope, ownerId) {
  if (!Array.isArray(v) || !v.length || v.length > presence.MAX_ACTIONS) throw bad('actions');
  const own = (at, to) => { if (scope === 'personal' && !(Array.isArray(to) && to.length === 1 && to[0] === ownerId)) throw fail('forbidden', { field: `${at}.to` }); };
  return v.map((a, i) => {
    const at = `actions.${i}`;
    if (!a || typeof a !== 'object' || Array.isArray(a)) throw bad(at);
    if (a.type === 'quick_action') {
      let plugin = a.plugin;
      let id = a.id;
      if (typeof a.actionId === 'string') {
        const m = ACTION_REF_RE.exec(a.actionId);
        if (!m) throw bad(`${at}.actionId`);
        [, plugin, id] = m;
      }
      if (typeof plugin !== 'string' || plugin.length < 2 || plugin.length > 64 || !presence.PLUGIN_ID_RE.test(plugin) || plugin === SELF) throw bad(`${at}.plugin`);
      if (typeof id !== 'string' || !presence.ACTION_ID_RE.test(id)) throw bad(`${at}.id`);
      let title;
      try { title = optText(a.title, presence.NAME_MAX); } catch { throw bad(`${at}.title`); }
      if (a.state != null && !presence.STATES.includes(a.state)) throw bad(`${at}.state`);
      return { type: 'quick_action', plugin, id, title: title || null, state: a.state == null ? null : a.state, kind: null, verb: null };
    }
    if (a.type === 'notify') {
      const to = a.to === 'parents' || a.to === 'all' ? a.to : people(a.to, at, fam, ownerId, 50);
      own(at, to);
      let text;
      try { text = optText(a.text, presence.TEXT_MAX); } catch { throw bad(`${at}.text`); }
      if (a.facts != null && typeof a.facts !== 'boolean') throw bad(`${at}.facts`);
      const buttons = reminders.parseButtons(a.buttons);
      if (!buttons) throw bad(`${at}.buttons`);
      return { type: 'notify', to, text: text || null, facts: a.facts === true, buttons };
    }
    if (a.type === 'messenger') {
      const to = a.to === 'family' ? 'family' : people(a.to, at, fam, ownerId, messenger.PEOPLE_MAX);
      own(at, to);
      let text;
      try { text = optText(a.text, messenger.TEXT_MAX); } catch { throw bad(`${at}.text`); }
      return { type: 'messenger', to, text: text || null };
    }
    throw bad(`${at}.type`);
  });
}

/** Body → the fields of a rule (cur: the stored rule for PATCH). */
function fields(body, cur, ctx, scope, ownerId) {
  const b = body || {};
  const f = { scope, ownerId };
  if (b.title !== undefined || b.name !== undefined) {
    try { f.title = optText(b.title !== undefined ? b.title : b.name, TITLE_MAX) || ''; } catch { throw bad('title'); }
  } else f.title = cur ? cur.title : '';
  Object.assign(f, parseTrigger(b, cur, ctx.fam));
  // 1.12.0: a child's own school rule only for the child itself (null = itself)
  if (f.trigger === SCHOOL && scope === 'personal' && f.userId != null && f.userId !== ownerId) {
    const owner = ctx.fam.byId.get(ownerId);
    if (owner && owner.role === 'child') throw fail('forbidden', { field: 'trigger.userId' });
  }
  f.conditions = b.conditions !== undefined ? parseConds(b.conditions, ctx.fam) : (cur ? cur.conditions : { time: null, afterSunset: false, device: [], calendar: null });
  f.actions = b.actions !== undefined || !cur ? parseActions(b.actions, ctx.fam, scope, ownerId) : cur.actions;
  f.active = b.active !== undefined ? bool(b.active) : (cur ? cur.active : true);
  return f;
}

/** Quick actions (and quick action buttons) of a personal rule: only what the owner has. */
async function checkOwn(gc, f, lang) {
  if (f.scope !== 'personal') return;
  const refs = [];
  f.actions.forEach((a, i) => {
    if (a.type === 'quick_action') refs.push([`${a.plugin}/${a.id}`, `actions.${i}`]);
    if (a.type === 'notify') a.buttons.filter((x) => x.startsWith('quick_action:')).forEach((x) => refs.push([x.slice(13), `actions.${i}.buttons`]));
  });
  if (!refs.length) return;
  const own = await reminders.ownRefs(gc, f.ownerId, lang, null);
  for (const [ref, field] of refs) if (!own.has(ref)) throw fail('forbidden', { field });
}

async function checkModules(f, ctx) {
  // the school trigger (1.12.0) needs only the module rules, like a schedule
  if (f.trigger !== SCHEDULE && f.trigger !== SCHOOL && !ctx.cfg.modules.presence) throw fail('module_off', { field: 'trigger' });
}

// ─── views ──────────────────────────────────────

function triggerView(rule, places) {
  if (rule.trigger === SCHEDULE) return { type: SCHEDULE, weekdays: rule.schedule ? rule.schedule.weekdays : [], time: rule.schedule ? rule.schedule.time : null };
  if (isPerson(rule.trigger)) return { type: rule.trigger, userId: rule.userId };
  if (isPlace(rule.trigger)) {
    const p = rule.placeId != null ? places.get(rule.placeId) : null;
    return { type: rule.trigger, placeId: p ? p.id : null, placeName: p ? p.name : null, userId: rule.userId };
  }
  if (rule.trigger === 'all_away') return { type: 'all_away', graceMinutes: rule.graceMinutes };
  if (rule.trigger === SCHOOL) {
    const o = rule.school || rulerow.schoolOptions(null);
    return { type: SCHOOL, userId: rule.userId, kinds: o.kinds.slice(), days: o.days };
  }
  return { type: rule.trigger };
}

function view(rule, ctx, avail, last, places) {
  const listed = avail.get(rule.ownerId);
  const owner = ctx.fam.byId.get(rule.ownerId) || ctx.fam.users.get(rule.ownerId);
  const r = rights(rule, ctx);
  const c = rule.conditions;
  return {
    id: rule.id, title: rule.title, scope: rule.scope, active: rule.active, kind: kindOf(rule.trigger),
    trigger: triggerView(rule, places),
    conditions: { time: c.time, afterSunset: c.afterSunset, device: c.device || [], calendar: c.calendar || null },
    actions: rule.actions.map((a) => {
      if (a.type === 'quick_action') return { ...presence.actionView(a, listed), actionId: `${a.plugin}/${a.id}` };
      if (a.type === 'notify') return { ...a, facts: a.facts === true, buttons: Array.isArray(a.buttons) ? a.buttons : [] };
      return a;
    }),
    lastRunAt: iso(rule.lastRunAt),
    lastResult: last ? { at: iso(last.at), ok: !!last.ok, skipped: parseJson(last.results_json, []).some((y) => y && y.type === 'condition') } : null,
    ownerId: rule.ownerId, ownerName: owner ? owner.name : null, editable: r === 'full', pausable: r === 'full' || r === 'pause',
    createdAt: iso(rule.createdAt), updatedAt: iso(rule.updatedAt),
  };
}

async function allRules(gc) {
  return (await store.all(gc, 'SELECT * FROM presence_rules ORDER BY id')).map(rulerow.rowToRule);
}

async function views(gc, ctx, rules) {
  const avail = await presence.availability(gc, rules, ctx.lang);
  const lastRows = await store.all(gc, 'SELECT l.* FROM presence_log l WHERE l.id = (SELECT m.id FROM presence_log m WHERE m.rule_id = l.rule_id ORDER BY m.at DESC, m.id DESC LIMIT 1)');
  const last = new Map(lastRows.map((x) => [x.rule_id, x]));
  const places = await ruleplaces.all(gc);
  return rules.map((x) => view(x, ctx, avail, last.get(x.id), places));
}

async function one(gc, ctx, id) {
  const rule = await rulerow.ruleById(gc, id);
  return (await views(gc, ctx, [rule]))[0];
}

// ─── the API ────────────────────────────────────

// ─── the holiday mode (1.11.0) ──────────────────

const VACATION = 'vacation';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function vacationOf(gc) {
  const v = await gc.storage.get(VACATION);
  return v && typeof v === 'object' && v.on === true ? { on: true, until: v.until || null, since: v.since || null, paused: Array.isArray(v.paused) ? v.paused : [] }
    : { on: false, until: null, since: null, paused: [] };
}

const vacationView = (v) => ({ on: v.on, until: v.until, since: v.since ? new Date(v.since).toISOString() : null, paused: v.paused.length });

/** On: pause every active house rule (remembering which); off: resume those that still exist. Inside a transaction. */
async function setVacation(gc, ctx, body) {
  if (!can(ctx).house) throw fail('parents_only');
  const b = body || {};
  if (typeof b.on !== 'boolean') throw bad('on');
  const until = b.until == null || b.until === '' ? null : String(b.until);
  if (until != null && (!DATE_RE.test(until) || until < tz.localDate(ctx.now, ctx.cfg.tz))) throw bad('until');
  const cur = await vacationOf(gc);
  if (b.on) {
    if (cur.on) {
      await gc.storage.set(VACATION, { ...cur, until });
      return { vacation: vacationView({ ...cur, until }) };
    }
    const rows = await store.all(gc, "SELECT id FROM presence_rules WHERE scope = 'house' AND active = 1");
    const ids = rows.map((x) => x.id);
    if (ids.length) await store.run(gc, `UPDATE presence_rules SET active = 0, updated_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`, [ctx.now, ...ids]);
    const v = { on: true, until, since: ctx.now, paused: ids };
    await gc.storage.set(VACATION, v);
    return { vacation: vacationView(v) };
  }
  await endVacation(gc, ctx.now, cur);
  return { vacation: vacationView({ on: false, until: null, since: null, paused: [] }) };
}

async function endVacation(gc, now, cur) {
  if (cur.on && cur.paused.length) {
    await store.run(gc, `UPDATE presence_rules SET active = 1, updated_at = ? WHERE active = 0 AND id IN (${cur.paused.map(() => '?').join(',')})`, [now, ...cur.paused]);
  }
  await gc.storage.set(VACATION, { on: false });
}

/** Background (inside a transaction): the holiday mode ends after its last day. */
async function vacationTick(gc, cfg, now) {
  const v = await vacationOf(gc);
  if (v.on && v.until && tz.localDate(now, cfg.tz) > v.until) await endVacation(gc, now, v);
}

/** POST rules/open/<ruleId>/done | snooze — inside the request's transaction. */
async function openAction(gc, ctx, rawId, action, body) {
  if (action !== 'done' && action !== 'snooze') throw fail('not_found');
  const id = posInt(rawId);
  if (!id) throw fail('not_found');
  return reminders.act(gc, ctx.now, ctx.userId, id, body && body.key, action);
}

/** GET rules */
async function list(gc, ctx) {
  const rules = (await allRules(gc)).filter((x) => visible(x, ctx));
  const ids = new Set(rules.map((x) => x.id));
  const all = ctx.admin || (ctx.me && ctx.me.role === 'parent');
  const rows = await store.all(gc, 'SELECT * FROM presence_log ORDER BY at DESC, id DESC LIMIT ?', [all ? LOG_SHOWN : 500]);
  const log = rows.filter((x) => all || ids.has(x.rule_id)).slice(0, LOG_SHOWN).map((x) => ({ ...presence.logView(x), ruleTitle: x.rule_name || '' }));
  return {
    rules: await views(gc, ctx, rules), log, can: can(ctx),
    // 1.11.0: parents and the admin page see every member's open reminders (with userId), the others their own
    open: await reminders.openFor(gc, ctx.cfg, ctx.now, all ? null : ctx.userId, ctx.fam),
    vacation: vacationView(await vacationOf(gc)),
  };
}

async function ruleOf(gc, raw) {
  const id = posInt(raw);
  const rule = id ? await rulerow.ruleById(gc, id) : null;
  if (!rule) throw fail('not_found');
  return rule;
}

/** POST rules (inside a transaction) */
async function create(gc, ctx, body) {
  const b = body || {};
  const c = can(ctx);
  const scope = b.scope === undefined ? (c.house ? 'house' : 'personal') : b.scope;
  if (!SCOPES.includes(scope)) throw bad('scope');
  if (!c[scope]) throw fail(scope === 'house' ? 'parents_only' : 'forbidden', { field: 'scope' });
  const ownerId = ctx.userId;
  const f = fields(b, null, ctx, scope, ownerId);
  await checkModules(f, ctx);
  if (scope === 'house' && (await store.one(gc, "SELECT COUNT(*) AS n FROM presence_rules WHERE scope = 'house'")).n >= MAX_HOUSE) throw fail('too_many');
  if (scope === 'personal' && (await store.one(gc, "SELECT COUNT(*) AS n FROM presence_rules WHERE scope = 'personal' AND owner_id = ?", [ownerId])).n >= MAX_PERSONAL) throw fail('too_many');
  await presence.checkPlace(gc, f);
  await checkOwn(gc, f, ctx.lang);
  f.actions = await presence.checkTargets(gc, f.actions, ownerId, ctx.lang);
  const lastKey = f.schedule ? conditions.initialKey(f.schedule, ctx.now, ctx.cfg.tz) : null;
  const res = await store.run(gc, `INSERT INTO presence_rules (name, title, scope, trigger_type, user_id, place_id, grace_minutes, schedule_json, conditions_json, actions_json, active,
    owner_id, last_key, trigger_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [f.title, f.title, scope, f.trigger, f.userId, f.placeId, f.graceMinutes, f.schedule ? JSON.stringify(f.schedule) : null, JSON.stringify(f.conditions), JSON.stringify(f.actions),
    f.active ? 1 : 0, ownerId, lastKey, f.school ? JSON.stringify(f.school) : null, ctx.now, ctx.now]);
  return { rule: await one(gc, ctx, Number(res.lastInsertRowid)) };
}

/** PATCH rules/<id> (inside a transaction) */
async function update(gc, ctx, raw, body) {
  const cur = await ruleOf(gc, raw);
  if (!visible(cur, ctx)) throw fail('not_found');
  const r = rights(cur, ctx);
  const b = body || {};
  if (!r) throw fail(cur.scope === 'house' ? 'parents_only' : 'forbidden');
  if (r === 'pause' && Object.keys(b).some((k) => k !== 'active')) throw fail('forbidden');
  if (b.scope !== undefined && b.scope !== cur.scope) throw bad('scope');
  const owner = cur.scope === 'house' && b.actions !== undefined ? ctx.userId : cur.ownerId;
  const f = fields(b, cur, ctx, cur.scope, owner);
  if (b.trigger !== undefined) await checkModules(f, ctx);
  await presence.checkPlace(gc, f);
  if (b.actions !== undefined) {
    await checkOwn(gc, f, ctx.lang);
    f.actions = await presence.checkTargets(gc, f.actions, owner, ctx.lang);
  }
  // a changed trigger (place, schedule) starts afresh
  const same = f.trigger === cur.trigger && f.placeId === cur.placeId && JSON.stringify(f.schedule) === JSON.stringify(cur.schedule);
  const lastKey = same ? cur.lastKey : (f.schedule ? conditions.initialKey(f.schedule, ctx.now, ctx.cfg.tz) : null);
  await store.run(gc, `UPDATE presence_rules SET name = ?, title = ?, trigger_type = ?, user_id = ?, place_id = ?, grace_minutes = ?, schedule_json = ?, conditions_json = ?, actions_json = ?,
    active = ?, owner_id = ?, last_key = ?, trigger_json = ?, updated_at = ? WHERE id = ?`,
  [f.title, f.title, f.trigger, f.userId, f.placeId, f.graceMinutes, f.schedule ? JSON.stringify(f.schedule) : null, JSON.stringify(f.conditions), JSON.stringify(f.actions),
    f.active ? 1 : 0, owner, lastKey, f.school ? JSON.stringify(f.school) : null, ctx.now, cur.id]);
  if (!f.active) await store.run(gc, "UPDATE rule_reminders SET state = 'resolved', snooze_until = NULL WHERE rule_id = ? AND state IN ('open', 'snoozed')", [cur.id]);
  return { rule: await one(gc, ctx, cur.id) };
}

/** DELETE rules/<id> (inside a transaction) */
async function remove(gc, ctx, raw) {
  const cur = await ruleOf(gc, raw);
  if (!visible(cur, ctx)) throw fail('not_found');
  if (!rights(cur, ctx)) throw fail(cur.scope === 'house' ? 'parents_only' : 'forbidden');
  await store.run(gc, 'DELETE FROM presence_rules WHERE id = ?', [cur.id]);
  await store.run(gc, 'DELETE FROM rule_reminders WHERE rule_id = ?', [cur.id]);
  await store.run(gc, 'DELETE FROM rule_fired WHERE rule_id = ?', [cur.id]);
  return {};
}

// ─── the dry run ────────────────────────────────

const say = conditions.say;

/** „fällt aus, Vertretung“ / „heute“ — the options of a school trigger in words. */
function schoolWords(o, lang) {
  return { kinds: o.kinds.map((k) => say(lang, `school.kind_${k}`)).join(', '), days: say(lang, `school.days_${o.days}`) };
}

function triggerText(rule, ctx, places) {
  const name = (id) => { const m = ctx.fam.byId.get(id); return m ? m.name : '–'; };
  if (rule.trigger === SCHOOL) {
    const child = school.childOf(rule, ctx.fam);
    return say(ctx.lang, 'test.trig_school_change', { name: child ? name(child) : say(ctx.lang, 'test.any_child'), ...schoolWords(rule.school || rulerow.schoolOptions(null), ctx.lang) });
  }
  if (isPerson(rule.trigger)) return say(ctx.lang, `test.trig_${rule.trigger}`, { name: name(rule.userId) });
  if (isPlace(rule.trigger)) {
    const p = rule.placeId != null ? places.get(rule.placeId) : null;
    return say(ctx.lang, `test.trig_${rule.trigger}`, { name: rule.userId ? name(rule.userId) : say(ctx.lang, 'test.someone'), place: p ? p.name : '–' });
  }
  return say(ctx.lang, `test.trig_${rule.trigger}`);
}

/**
 * The dry run of a rule (nothing runs, nothing is stored) → { wouldFire, details: [{ kind, ok, text }], at }.
 * schedule: today a day of the schedule? — the time window and „after sunset“ checked at today's time of the
 * schedule; device values and the calendar as they are now. Other triggers: whether the conditions hold now.
 */
async function dryRun(gc, ctx, rule) {
  const { cfg, now, lang } = ctx;
  const details = [];
  const places = await ruleplaces.all(gc);
  let ok = true;
  let at = now;
  if (!rule.active) { details.push({ kind: 'trigger', ok: false, text: say(lang, 'test.paused') }); ok = false; }
  if (rule.trigger === SCHEDULE) {
    const today = tz.localDate(now, cfg.tz);
    const s = rule.schedule;
    const when = s ? conditions.scheduledAt(s, today, cfg.tz) : null;
    if (when != null) {
      at = when;
      const done = rule.lastKey === `sched:${today}`;
      details.push({ kind: 'trigger', ok: true, text: say(lang, done && when <= now ? 'test.sched_done' : 'test.sched_today', { time: s.time }) });
    } else {
      const next = s ? conditions.nextDay(s, tz.addDays(today, 1)) : null;
      details.push({ kind: 'trigger', ok: false, text: next ? say(lang, 'test.sched_not_today', { day: format.dayShort(next, lang), time: s.time }) : say(lang, 'test.sched_none') });
      ok = false;
    }
  } else if (rule.trigger === SCHOOL) {
    // 1.12.0: one simulated event — the rule's child (else the first child) and its first kind, today or tomorrow
    const o = rule.school || rulerow.schoolOptions(null);
    const there = await school.available(gc);
    const child = school.childOf(rule, ctx.fam);
    const m = child ? ctx.fam.byId.get(child) : ctx.fam.list.find((x) => x.role === 'child');
    const sample = say(lang, `test.school_sample_${o.kinds[0]}`, { name: m ? m.name : '–', day: say(lang, o.days === 'tomorrow' ? 'school.days_tomorrow' : 'school.days_today') });
    details.push({ kind: 'trigger', ok: there ? null : false, text: there ? say(lang, 'test.school_event', { what: triggerText(rule, ctx, places), sample }) : say(lang, 'test.school_gone') });
    if (!there) ok = false;
  } else {
    const off = !cfg.modules.presence;
    details.push({ kind: 'trigger', ok: off ? false : null, text: off ? say(lang, 'test.presence_off') : say(lang, 'test.event', { what: triggerText(rule, ctx, places) }) });
    if (off) ok = false;
  }
  const c = rule.conditions;
  if (c.time) {
    const p = tz.parts(at, cfg.tz);
    const hold = conditions.inWindow(`${tz.pad(p.hh)}:${tz.pad(p.mm)}`, c.time);
    details.push({ kind: 'time', ok: hold, text: say(lang, hold ? 'test.time_ok' : 'test.time_no', { from: c.time.from, to: c.time.to }) });
    if (!hold) ok = false;
  }
  if (c.afterSunset) {
    if (!cfg.location) details.push({ kind: 'sunset', ok: null, text: say(lang, 'test.sun_none') });
    else {
      const hold = conditions.syncHold({ conditions: { time: null, afterSunset: true } }, cfg, at);
      details.push({ kind: 'sunset', ok: hold, text: say(lang, hold ? 'test.sun_ok' : 'test.sun_no') });
      if (!hold) ok = false;
    }
  }
  if (conditions.needsEvaluate(rule)) {
    const ev = await conditions.evaluate(gc, ctx.fam, cfg, now, rule, lang, new Map());
    for (const x of ev.checks) details.push({ kind: x.kind, ok: x.known === false ? false : x.ok, text: x.text });
    if (!ev.ok) ok = false;
  }
  const own = rule.actions.some((a) => a.type === 'quick_action') ? await presence.ownerActions(gc, rule.ownerId, lang) : null;
  for (const a of rule.actions) {
    if (a.type === 'quick_action') {
      const x = own && own.get(`${a.plugin}|${a.id}`);
      details.push({ kind: 'action', ok: own ? !!x : null, text: say(lang, own && !x ? 'test.qa_gone' : 'test.qa', { what: (x && x.title) || a.title || a.id }) });
    } else if (a.type === 'notify') {
      const to = presence.recipients(a, ctx.fam, null, rule);
      details.push({ kind: 'action', ok: to.length > 0, text: say(lang, to.length ? 'test.notify' : 'test.notify_none', { names: to.map((id) => ctx.fam.byId.get(id).name).join(', ') }) });
    } else if (a.type === 'messenger') {
      const info = await messenger.info(gc, cfg);
      const there = info.available === true;
      details.push({ kind: 'action', ok: there, text: say(lang, there ? 'test.msg' : 'test.msg_gone') });
    }
  }
  return { wouldFire: ok, details };
}

/** POST rules/<id>/test */
async function test(gc, ctx, raw) {
  const rule = await ruleOf(gc, raw);
  if (!visible(rule, ctx)) throw fail('not_found');
  return dryRun(gc, ctx, rule);
}

/** POST rules/test — an unsaved rule body (checked like POST rules, nothing stored). */
async function testBody(gc, ctx, body) {
  const b = body || {};
  const c = can(ctx);
  const scope = b.scope === undefined ? (c.house ? 'house' : 'personal') : b.scope;
  if (!SCOPES.includes(scope)) throw bad('scope');
  if (!c[scope]) throw fail(scope === 'house' ? 'parents_only' : 'forbidden', { field: 'scope' });
  const f = fields(b, null, ctx, scope, ctx.userId);
  await presence.checkPlace(gc, f);
  const rule = { id: null, title: f.title, scope, trigger: f.trigger, userId: f.userId, placeId: f.placeId, graceMinutes: f.graceMinutes, schedule: f.schedule, school: f.school,
    conditions: f.conditions, actions: f.actions, active: f.active, ownerId: ctx.userId, lastKey: null };
  return dryRun(gc, ctx, rule);
}

// ─── options ────────────────────────────────────

/** GET rules/options — what the editor offers the caller. */
async function options(gc, ctx) {
  const { cfg, lang } = ctx;
  let listed = [];
  let actionsAvailable = false;
  if (conditions.hasList(gc)) {
    try { listed = await gc.actions.list({ userId: ctx.userId, lang, withWidget: true }); actionsAvailable = true; } catch { listed = []; }
  }
  const devices = [];
  for (const a of listed) {
    const flds = conditions.widgetFields(a.widget, lang);
    if (!flds.length) continue;
    // 1.9.1: the widget stands for its device — named after it („Elroq“), not after the action that carries
    // it („Elroq – Klimatisierung“, whose widget shows the battery)
    const d = a.device && a.device.title;
    devices.push({ actionId: conditions.refOf(a), label: String(d || a.title || a.id).slice(0, 60), icon: (a.device && a.device.icon) || a.icon || null, fields: flds });
  }
  const calendars = [];
  if (cfg.modules.dates) calendars.push({ source: 'familie', label: say(lang, 'cond.src_familie') });
  let alltag = false;
  if (conditions.hasServices(gc)) {
    try {
      const r = await gc.services.call({ plugin: conditions.ALLTAG, service: 'calendar_list', userId: ctx.userId, payload: {} });
      if (r && r.ok === true && Array.isArray(r.subscriptions)) {
        alltag = true;
        calendars.push({ source: 'alltag', label: say(lang, 'cond.src_alltag') });
        for (const s of r.subscriptions) if (s && Number.isSafeInteger(s.id)) calendars.push({ source: `alltag:${s.id}`, label: String(s.name || s.id).slice(0, 40) });
      }
    } catch { /* no Alltag */ }
  }
  const pres = cfg.modules.presence;
  const consent = await presence.load(gc, ctx.fam);
  const info = await messenger.info(gc, cfg);
  // 1.12.0: „Stunde fällt aus“ only while the Schule plugin is there and answered (its students, cached 5 minutes)
  const students = await school.students(gc, ctx.now);
  const self = ctx.me && ctx.me.role === 'child' && !ctx.admin ? ctx.userId : null;
  const kids = students ? students.filter((x) => { const m = ctx.fam.byId.get(x.userId); return m && m.role === 'child' && (self == null || x.userId === self); }) : null;
  const triggers = TRIGGERS.filter((type) => type !== SCHOOL || kids)
    .map((type) => ({ type, group: type === SCHEDULE ? 'time' : (isPlace(type) ? 'places' : (type === SCHOOL ? 'school' : 'presence')), available: type === SCHEDULE || type === SCHOOL || pres }));
  return {
    triggers,
    ...(kids ? { school: { students: kids } } : {}),
    devices,
    actions: listed.map((a) => ({
      actionId: conditions.refOf(a), plugin: a.plugin, id: a.id, pluginName: a.pluginName || a.plugin, title: a.title, subtitle: a.subtitle || null, icon: a.icon || null,
      kind: a.kind, state: a.state == null ? null : a.state, verbs: a.verbs || null, device: a.device || null,
    })),
    actionsAvailable,
    calendars,
    places: pres ? [...(await ruleplaces.all(gc)).values()].map((p) => ({ id: p.id, name: p.name, radius: p.radius })) : [],
    people: ctx.fam.list.map((m) => ({ userId: m.userId, name: m.name, role: m.role, ...members.faceOf(m), placesShared: !!(consent.get(m.userId) && consent.get(m.userId).places) })),
    messenger: { available: info.available === true, group: !!info.group },
    can: can(ctx),
    features: { deviceValues: conditions.hasGet(gc), buttons: reminders.callbacks(gc), alltag },
    location: !!cfg.location,
  };
}

// ─── the trigger 'schedule' ─────────────────────

/** Background (inside a transaction): the schedule rules whose time has come → runs. */
async function scheduleTick(gc, fam, cfg, now, runs) {
  if (cfg.modules.rules === false) return;
  for (const rule of await rulerow.activeRules(gc, SCHEDULE)) {
    if (!rule.schedule) continue;
    const key = conditions.dueKey(rule.schedule, now, cfg.tz);
    if (!key || rule.lastKey === key) continue;
    const ok = conditions.syncHold(rule, cfg, now);
    await store.run(gc, `UPDATE presence_rules SET last_key = ?${ok ? ', last_run_at = ?' : ''} WHERE id = ?`, ok ? [key, now, rule.id] : [key, rule.id]);
    if (ok) runs.push({ rule, trigger: SCHEDULE, userId: null, key });
  }
}

module.exports = {
  SCHOOL, TRIGGERS, SCOPES, MAX_HOUSE, MAX_PERSONAL, can, visible, rights, list, create, update, remove, test, testBody, dryRun, options, scheduleTick, kindOf,
  setVacation, vacationTick, vacationOf, openAction,
};
