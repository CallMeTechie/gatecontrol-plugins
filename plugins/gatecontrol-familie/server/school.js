'use strict';

// The rule trigger 'school_change' („Stunde fällt aus“, 1.12.0): a change of a child's timetable
// found by the Schule plugin (gatecontrol-schule ≥ 1.1.0) runs the matching rules.
//
//   trigger  { type: 'school_change', userId: <a child's GateControl user id> | null (any child),
//              kinds: ['cancelled' | 'changed' | 'extra' | 'restored'] (≥ 1, default ['cancelled']),
//              days: 'today' | 'tomorrow' | 'any' (default 'any') }
//            days is relative to the lesson's date in the family's time zone when the event comes.
//            A child's own rule (scope 'personal') only for itself: userId its own or null (= itself).
//
// The service rule_event (services.provides; only the caller gatecontrol-schule, else forbidden):
//   { type: 'school_change', events: [{ userId, kind, date: 'YYYY-MM-DD', start: 'HH:MM', subject, text }] (≤ 20) }
//   → { ok: true, fired: <rule runs> } | { ok: false, code: 'invalid' | 'forbidden' }
//   For each event and each active matching rule (userId or any child, kind, day) the rule runs like a
//   presence rule (time window and „after sunset“ here, device and calendar conditions right before the
//   actions); {event} in a text is the event's text, {name} the child's name. Unknown user ids (not a
//   child of the family) are ignored. Each rule handles an event once — key
//   'school:<userId>:<date>:<start>:<kind>' in rule_fired (kept 14 days) — no matter how often it comes.
//   Nothing runs while the module rules is off; a paused rule (the holiday mode too) never runs.
//
// The editor (GET rules/options) offers the trigger only while gc.services.available('gatecontrol-schule',
// 'school_students') says so (GateControl ≥ 1.178.0), with the students of that plugin { userId, name }
// (cached 5 minutes: service calls are limited to 60 an hour).

const store = require('./store');
const tz = require('./tz');
const rulerow = require('./rulerow');
const conditions = require('./conditions');
const { posInt, line, validDate, TIME_RE } = require('./util');

const TRIGGER = 'school_change';
const SCHULE = 'gatecontrol-schule';
const STUDENTS = 'school_students';
const KINDS = rulerow.SCHOOL_KINDS;
const DAYS = rulerow.SCHOOL_DAYS;
const EVENTS_MAX = 20;
const SUBJECT_MAX = 80;
const TEXT_MAX = 200;
const KEEP_DAYS = 14;
const DAY = 86400000;
const CACHE_MS = 5 * 60000;
const CACHE_FAIL_MS = 60000;

class Invalid extends Error { constructor(field) { super('invalid'); this.field = field; } }

/** The options of the trigger (t: the trigger object of a body) → { userId, kinds, days }; Invalid with a field. */
function parseTrigger(t, fam) {
  const id = t.userId == null ? null : posInt(t.userId);
  if (t.userId != null) {
    const m = id ? fam.byId.get(id) : null;
    if (!m || m.role !== 'child') throw new Invalid('trigger.userId');
  }
  let kinds = ['cancelled'];
  if (t.kinds !== undefined && t.kinds !== null) {
    if (!Array.isArray(t.kinds) || !t.kinds.length || t.kinds.length > KINDS.length * 2 || !t.kinds.every((k) => KINDS.includes(k))) throw new Invalid('trigger.kinds');
    kinds = KINDS.filter((k) => t.kinds.includes(k));
  }
  let days = 'any';
  if (t.days !== undefined && t.days !== null) {
    if (!DAYS.includes(t.days)) throw new Invalid('trigger.days');
    days = t.days;
  }
  return { userId: id, kinds, days };
}

const optionsOf = rulerow.schoolOptions;

/** The child a rule is about: its userId; a child's own rule without one: the child itself; else null (any child). */
function childOf(rule, fam) {
  if (rule.userId != null) return rule.userId;
  if (rule.scope === 'personal') {
    const owner = fam.byId.get(rule.ownerId);
    if (owner && owner.role === 'child') return owner.userId;
  }
  return null;
}

// ─── the service rule_event ─────────────────────

/** The payload of rule_event → the events; null when anything is wrong. */
function parseEvents(payload) {
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  if (!p || p.type !== TRIGGER || !Array.isArray(p.events) || p.events.length > EVENTS_MAX) return null;
  const out = [];
  for (const e of p.events) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
    const userId = posInt(e.userId);
    if (!userId || typeof e.userId !== 'number') return null;
    if (!KINDS.includes(e.kind)) return null;
    if (typeof e.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.date) || !validDate(e.date)) return null;
    if (typeof e.start !== 'string' || !TIME_RE.test(e.start)) return null;
    if (e.subject != null && typeof e.subject !== 'string') return null;
    const subject = line(e.subject || '') || '';
    if (subject.length > SUBJECT_MAX) return null;
    const text = line(e.text);
    if (!text || text.length > TEXT_MAX) return null;
    out.push({ userId, kind: e.kind, date: e.date, start: e.start, subject, text });
  }
  return out;
}

const keyOf = (ev) => `school:${ev.userId}:${ev.date}:${ev.start}:${ev.kind}`;

/** Does the event's lesson date fit the rule's days (in the family's time zone, now)? */
function dayFits(days, date, today) {
  if (days === 'today') return date === today;
  if (days === 'tomorrow') return date === tz.addDays(today, 1);
  return true;
}

/** Does `rule` (trigger school_change) match the event? */
function matches(rule, ev, fam, today) {
  const child = childOf(rule, fam);
  if (child != null && child !== ev.userId) return false;
  const o = rule.school || optionsOf(null);
  return o.kinds.includes(ev.kind) && dayFits(o.days, ev.date, today);
}

/**
 * The events (inside a transaction) → runs: each active matching rule once per event key; the time
 * window and „after sunset“ checked now (not met: handled all the same, nothing runs).
 */
async function fire(gc, fam, cfg, now, events, runs) {
  if (cfg.modules.rules === false) return;
  const rules = await rulerow.activeRules(gc, TRIGGER);
  if (!rules.length) return;
  const today = tz.localDate(now, cfg.tz);
  for (const ev of events) {
    const m = fam.byId.get(ev.userId);
    if (!m || m.role !== 'child') continue;
    const key = keyOf(ev);
    for (const rule of rules) {
      if (!matches(rule, ev, fam, today)) continue;
      if (await store.one(gc, 'SELECT 1 AS x FROM rule_fired WHERE rule_id = ? AND fire_key = ?', [rule.id, key])) continue;
      await store.run(gc, 'INSERT INTO rule_fired (rule_id, fire_key, at) VALUES (?, ?, ?)', [rule.id, key, now]);
      if (!conditions.syncHold(rule, cfg, now)) continue;
      await store.run(gc, 'UPDATE presence_rules SET last_run_at = ? WHERE id = ?', [now, rule.id]);
      runs.push({ rule, trigger: TRIGGER, userId: ev.userId, key, event: ev.text, school: ev });
    }
  }
}

async function purge(gc, now) {
  await store.run(gc, 'DELETE FROM rule_fired WHERE at < ?', [now - KEEP_DAYS * DAY]);
}

// ─── the Schule plugin ──────────────────────────

const cache = { at: 0, ok: false, students: [], ttl: 0 };

function reset() { cache.at = 0; cache.ok = false; cache.students = []; cache.ttl = 0; }

/** gc.services.available for the Schule plugin's students (GateControl ≥ 1.178.0; older: false). */
async function available(gc) {
  if (!gc || !gc.services || typeof gc.services.available !== 'function') return false;
  try { return (await gc.services.available(SCHULE, STUDENTS)) === true; } catch { return false; }
}

/**
 * The Schule plugin's students [{ userId, name }] (cached 5 minutes, a failure 1 minute), or null when it
 * is not there or did not answer.
 */
async function students(gc, now) {
  if (cache.at && now - cache.at < cache.ttl && now >= cache.at) return cache.ok ? cache.students : null;
  let list = null;
  if (await available(gc)) {
    try {
      const r = await gc.services.call({ plugin: SCHULE, service: STUDENTS, payload: {} });
      if (r && r.ok === true && Array.isArray(r.students)) {
        const seen = new Set();
        list = [];
        for (const s of r.students) {
          const id = s && posInt(s.userId);
          if (!id || seen.has(id)) continue;
          seen.add(id);
          list.push({ userId: id, name: (line(s.name) || String(id)).slice(0, 60) });
        }
      }
    } catch { list = null; }
  }
  cache.at = now;
  cache.ok = list !== null;
  cache.students = list || [];
  cache.ttl = list ? CACHE_MS : CACHE_FAIL_MS;
  return list;
}

module.exports = {
  TRIGGER, SCHULE, STUDENTS, KINDS, DAYS, EVENTS_MAX, Invalid, parseTrigger, optionsOf, childOf, parseEvents, keyOf, dayFits, matches, fire, purge,
  available, students, reset,
};
