'use strict';

// The Familie plugin's rules (1.1.0): its rule trigger „Stunde fällt aus“ (school_change) runs on the
// changes this plugin finds. After every background cycle, the changes dispatch() released — the
// ones that are pushed (not the baseline, the lesson not over, within notify_days, after the quiet
// hours just like the pushes) — of students mapped to a GateControl user go to Familie in ONE call:
//
//   gc.services.call({ plugin: 'gatecontrol-familie', service: 'rule_event', payload: {
//     type: 'school_change', events: [{ userId, kind, date: 'YYYY-MM-DD', start: 'HH:MM', subject, text }] } })
//   → { ok: true, fired } | { ok: false, code }
//
// at most the 20 newest changes per call; text like the push line, in the notification language
// („Lena: Mathe 3. Std. (09:50) fällt aus“). Only when gc.services.available says Familie offers it
// (GateControl ≥ 1.178.0 — an older host has no gc.services.available: nothing is sent). Each change
// is handed over once (changes.rule_at), also when Familie is not there or the call fails. Errors
// never stop the cycle; the last result is kept for the admin page (gc.storage 'rule_event').
//
// The other way round, the service school_students (callers: gatecontrol-familie only):
//   {} → { ok: true, students: [{ userId, name }] }   the enabled students mapped to a user, by display name.

const store = require('./store');
const changes = require('./changes');
const notify = require('./notify');
const texts = require('./texts.json');

const FAMILIE = 'gatecontrol-familie';
const SERVICE = 'rule_event';
const MAX_EVENTS = 20;
const LAST_KEY = 'rule_event';
const SUBJECT_MAX = 80;
const TEXT_MAX = 200;

const t = (lang, key, params) => notify.fmt(texts, lang, key, params);

/** Is Familie's rule_event reachable (GateControl ≥ 1.178.0)? */
async function available(gc) {
  if (!gc || !gc.services || typeof gc.services.available !== 'function' || typeof gc.services.call !== 'function') return false;
  try { return (await gc.services.available(FAMILIE, SERVICE)) === true; } catch { return false; }
}

/** The subject as the push names it: the long name when short, else the short one. */
function subjectOf(c, lang) {
  const d = c.detail || {};
  return (d.subjectLong && d.subjectLong.length <= 24 ? d.subjectLong : c.subject) || d.subjectLong || t(lang, 'push.lesson');
}

/** One change of a student → the event of rule_event. */
function eventOf(student, c, lang) {
  const subject = subjectOf(c, lang);
  const period = changes.periodLabel(c.period, null, lang);
  const when = period ? `${period} (${c.t_start})` : `(${c.t_start})`;
  const text = t(lang, `rule.${c.kind}`, { name: student.display, subject, when });
  return { userId: student.user_id, kind: c.kind, date: c.date, start: c.t_start, subject: subject.slice(0, SUBJECT_MAX), text: text.slice(0, TEXT_MAX) };
}

function hostCode(e) {
  const c = e && e.code;
  if (c === 'ERR_SERVICE_UNAVAILABLE' || c === 'ERR_SERVICES_DENIED') return 'unavailable';
  if (c === 'ERR_RATE_LIMIT') return 'rate_limit';
  if (c === 'ERR_TIMEOUT') return 'timeout';
  if (c === 'ERR_INVALID') return 'invalid';
  return 'failed';
}

const byLesson = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.start < b.start ? -1 : a.start > b.start ? 1 : 0);

/**
 * Hand the released changes (dispatch()'s `events`: [{ change, student }]) to Familie's rules.
 * → the result { at, ok, fired, events, code } | null (nothing sent). Never throws.
 */
async function send(gc, cfg, now, items) {
  if (!Array.isArray(items) || !items.length) return null;
  let result = null;
  try {
    if (await available(gc)) {
      const newest = items.slice().sort((a, b) => (b.change.detected_at - a.change.detected_at) || (b.change.id - a.change.id)).slice(0, MAX_EVENTS);
      const events = newest.map((x) => eventOf(x.student, x.change, cfg.lang)).sort(byLesson);
      try {
        const r = await gc.services.call({ plugin: FAMILIE, service: SERVICE, payload: { type: 'school_change', events } });
        result = r && r.ok === true
          ? { at: now, ok: true, fired: Number.isSafeInteger(r.fired) && r.fired >= 0 ? r.fired : 0, events: events.length, code: null }
          : { at: now, ok: false, fired: 0, events: events.length, code: r && typeof r.code === 'string' && /^[a-z_]{1,32}$/.test(r.code) ? r.code : 'failed' };
      } catch (e) {
        result = { at: now, ok: false, fired: 0, events: events.length, code: hostCode(e) };
      }
      if (!result.ok) gc.log.warn('rule events not delivered', result.code);
      try { await gc.storage.set(LAST_KEY, result); } catch { /* only the diagnostics */ }
    }
  } catch (e) {
    gc.log.warn('rule events failed', (e && (e.code || e.message)) || 'error');
  }
  // each change once — sent, skipped (no Familie) or failed
  try { await store.setRuleAt(gc, items.map((x) => x.change.id), now); } catch (e) { gc.log.warn('rule events not marked', (e && e.code) || 'error'); }
  return result;
}

/** For the admin page: { available, last: { at, ok, fired, events, code } | null }. */
async function status(gc) {
  let last = null;
  try {
    const v = await gc.storage.get(LAST_KEY);
    if (v && typeof v === 'object' && Number.isFinite(v.at)) last = { at: v.at, ok: v.ok === true, fired: Number(v.fired) || 0, events: Number(v.events) || 0, code: v.code || null };
  } catch { last = null; }
  return { available: await available(gc), last };
}

/** The service school_students (Familie's rule editor) → { ok, students: [{ userId, name }] }. */
async function students(gc) {
  const out = [];
  const seen = new Set();
  for (const s of await store.listStudents(gc)) {
    if (!s.enabled || s.missing || s.user_id == null || seen.has(s.user_id)) continue;
    seen.add(s.user_id);
    out.push({ userId: s.user_id, name: String(s.display || s.name || '').slice(0, 60) });
  }
  return { ok: true, students: out.slice(0, 100) };
}

const SERVICES = { school_students: { caller: FAMILIE, fn: students } };

/** The hook service({ name, caller, user, payload }) → the answer; a refusal is { ok: false, code }. */
async function handle(gc, call) {
  const c = call && typeof call === 'object' ? call : {};
  const sv = Object.prototype.hasOwnProperty.call(SERVICES, c.name) ? SERVICES[c.name] : null;
  if (!sv) return { ok: false, code: 'not_found' };
  if (c.caller !== sv.caller) return { ok: false, code: 'forbidden' };
  try {
    return await sv.fn(gc, c.payload);
  } catch (e) {
    gc.log.warn('service failed', c.name, (e && (e.code || e.message)) || 'error');
    return { ok: false, code: 'failed' };
  }
}

module.exports = { FAMILIE, SERVICE, MAX_EVENTS, available, eventOf, send, status, students, handle };
