'use strict';

// One row of presence_rules → the rule object shared by server/presence.js (presence and
// place triggers, the run), server/rules.js (the rule API, 1.9.0) and server/reminders.js
// (snooze / done of a reminder).
//
// A rule: { id, name, title, scope, trigger, userId, placeId, graceMinutes, schedule,
// conditions: { time, afterSunset, device, calendar }, actions, active, ownerId, lastRunAt,
// lastKey, createdAt, updatedAt }. title falls back to the name of rules made before 1.9.0;
// scope 'house' | 'personal'; schedule { weekdays, time } for the trigger 'schedule'; 1.12.0: school
// { kinds, days } for the trigger 'school_change' (server/school.js), null for every other trigger.

const store = require('./store');
const { parseJson } = require('./util');

const SCHOOL_KINDS = ['cancelled', 'changed', 'extra', 'restored'];
const SCHOOL_DAYS = ['today', 'tomorrow', 'any'];

/** The stored options of the trigger 'school_change' (trigger_json) → { kinds, days } (defaults for anything broken). */
function schoolOptions(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const kinds = Array.isArray(o.kinds) ? SCHOOL_KINDS.filter((k) => o.kinds.includes(k)) : [];
  return { kinds: kinds.length ? kinds : ['cancelled'], days: SCHOOL_DAYS.includes(o.days) ? o.days : 'any' };
}

function rowToRule(x) {
  const c = parseJson(x.conditions_json, {});
  const s = parseJson(x.schedule_json, null);
  return {
    id: x.id, name: x.name || '', title: x.title != null && x.title !== '' ? x.title : (x.name || ''), scope: x.scope === 'personal' ? 'personal' : 'house',
    trigger: x.trigger_type, userId: x.user_id == null ? null : x.user_id, placeId: x.place_id == null ? null : x.place_id,
    graceMinutes: x.grace_minutes,
    schedule: s && Array.isArray(s.weekdays) && typeof s.time === 'string' ? { weekdays: s.weekdays, time: s.time } : null,
    school: x.trigger_type === 'school_change' ? schoolOptions(parseJson(x.trigger_json, null)) : null,
    conditions: {
      time: c.time && c.time.from && c.time.to ? { from: c.time.from, to: c.time.to } : null, afterSunset: c.afterSunset === true,
      device: Array.isArray(c.device) ? c.device : [], calendar: c.calendar && typeof c.calendar === 'object' ? c.calendar : null,
    },
    actions: parseJson(x.actions_json, []), active: !!x.active, ownerId: x.owner_id, lastRunAt: x.last_run_at, lastKey: x.last_key,
    createdAt: x.created_at, updatedAt: x.updated_at,
  };
}

async function ruleById(gc, id) {
  const row = Number.isSafeInteger(id) ? await store.one(gc, 'SELECT * FROM presence_rules WHERE id = ?', [id]) : null;
  return row ? rowToRule(row) : null;
}

async function activeRules(gc, trigger) {
  return (await store.all(gc, 'SELECT * FROM presence_rules WHERE active = 1 AND trigger_type = ? ORDER BY id', [trigger])).map(rowToRule);
}

module.exports = { SCHOOL_KINDS, SCHOOL_DAYS, schoolOptions, rowToRule, ruleById, activeRules };
