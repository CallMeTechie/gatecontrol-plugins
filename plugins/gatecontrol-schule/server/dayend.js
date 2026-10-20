'use strict';

// Early end of a school day → the Familie plugin (1.2.0). The change detection records an early end
// (server/changes.js earlyEnds → table day_ends, once per student, date and new end). After every
// background cycle the pending ones go to Familie in ONE call:
//
//   gc.services.call({ plugin: 'gatecontrol-familie', service: 'school_day_end', payload: {
//     events: [{ userId, date: 'YYYY-MM-DD', plannedEnd: 'HH:MM', newEnd: 'HH:MM',
//                text: 'Lena hat am Di 21.10. schon um 11:30 Schluss (statt 13:05)' }] } })   1 … 20
//   → { ok: true, notified, matched } | { ok: false, code }
//
// Familie looks for a pickup (module rides) of that child around the planned end and tells the
// driver and the parents (server/schoolend.js there). Like the pushes: held in the quiet hours; an
// early end whose planned end has passed, that is no longer true (the lesson takes place again) or
// whose student is switched off / no longer mapped expires; only the newest end per student and
// date goes. Only when gc.services.available says Familie offers it (GateControl ≥ 1.178.0);
// otherwise it is marked skipped — each early end is handed over at most once (a rate limit keeps
// it pending until its planned end). Errors never stop the cycle; the last result is kept for the
// admin page (gc.storage 'day_end').

const store = require('./store');
const tz = require('./tz');
const changes = require('./changes');
const notify = require('./notify');
const texts = require('./texts.json');

const FAMILIE = 'gatecontrol-familie';
const SERVICE = 'school_day_end';
const MAX_EVENTS = 20;
const LAST_KEY = 'day_end';
const TEXT_MAX = 200;

const t = (lang, key, params) => notify.fmt(texts, lang, key, params);

async function available(gc) {
  if (!gc || !gc.services || typeof gc.services.available !== 'function' || typeof gc.services.call !== 'function') return false;
  try { return (await gc.services.available(FAMILIE, SERVICE)) === true; } catch { return false; }
}

/** "Lena hat am Di 21.10. schon um 11:30 Schluss (statt 13:05)" */
function textOf(student, e, lang) {
  return t(lang, 'dayend.text', { name: student.display, day: changes.dayLabel(e.date, lang), new: e.new_end, planned: e.planned_end }).slice(0, TEXT_MAX);
}

function hostCode(e) {
  const c = e && e.code;
  if (c === 'ERR_SERVICE_UNAVAILABLE' || c === 'ERR_SERVICES_DENIED') return 'unavailable';
  if (c === 'ERR_RATE_LIMIT') return 'rate_limit';
  if (c === 'ERR_TIMEOUT') return 'timeout';
  if (c === 'ERR_INVALID') return 'invalid';
  return 'failed';
}

/**
 * Hand the pending early ends to Familie (or hold them in the quiet hours).
 * → the result { at, ok, events, notified, code } | null (nothing sent). Never throws.
 */
async function send(gc, cfg, now, quiet) {
  try {
    const open = await store.dayEndsWithStatus(gc, ['pending']);
    if (!open.length || quiet) return null;
    // the newest end per student and date
    const latest = new Map();
    for (const e of open) {
      const k = `${e.student_id}|${e.date}`;
      const x = latest.get(k);
      if (!x || e.detected_at > x.detected_at || (e.detected_at === x.detected_at && e.new_end < x.new_end)) latest.set(k, e);
    }
    const live = [];
    const dead = [];
    for (const e of open) {
      if (latest.get(`${e.student_id}|${e.date}`) !== e) { dead.push(e); continue; }
      const student = await store.getStudent(gc, e.student_id);
      let ok = !!student && student.enabled && !student.missing && student.user_id != null && tz.at(e.date, e.planned_end, cfg.tz) > now;
      if (ok) ok = changes.endOf(await store.lessonsBetween(gc, [e.student_id], e.date, e.date), e.date) === e.new_end;
      if (ok) live.push({ e, student });
      else dead.push(e);
    }
    if (dead.length) await store.setDayEndStatus(gc, dead, 'expired');
    if (!live.length) return null;
    if (!(await available(gc))) {
      await store.setDayEndStatus(gc, live.map((x) => x.e), 'skipped');
      return null;
    }
    const batch = live.slice(-MAX_EVENTS); // the newest; the rest stays pending for the next cycle
    const events = batch.map(({ e, student }) => ({ userId: student.user_id, date: e.date, plannedEnd: e.planned_end, newEnd: e.new_end, text: textOf(student, e, cfg.lang) }));
    let result;
    try {
      const r = await gc.services.call({ plugin: FAMILIE, service: SERVICE, payload: { events } });
      result = r && r.ok === true
        ? { at: now, ok: true, events: events.length, notified: Number.isSafeInteger(r.notified) && r.notified >= 0 ? r.notified : 0, code: null }
        : { at: now, ok: false, events: events.length, notified: 0, code: r && typeof r.code === 'string' && /^[a-z_]{1,32}$/.test(r.code) ? r.code : 'failed' };
    } catch (e) {
      result = { at: now, ok: false, events: events.length, notified: 0, code: hostCode(e) };
    }
    // each early end once — a rate limit keeps them for the next cycle (they expire with their planned end)
    if (result.code !== 'rate_limit') await store.setDayEndStatus(gc, batch.map((x) => x.e), result.ok ? 'sent' : 'failed', now);
    if (!result.ok) gc.log.warn('early ends not delivered', result.code);
    try { await gc.storage.set(LAST_KEY, result); } catch { /* only the diagnostics */ }
    return result;
  } catch (e) {
    gc.log.warn('early ends failed', (e && (e.code || e.message)) || 'error');
    return null;
  }
}

/** For the admin page: { available, last: { at, ok, events, notified, code } | null }. */
async function status(gc) {
  let last = null;
  try {
    const v = await gc.storage.get(LAST_KEY);
    if (v && typeof v === 'object' && Number.isFinite(v.at)) last = { at: v.at, ok: v.ok === true, events: Number(v.events) || 0, notified: Number(v.notified) || 0, code: v.code || null };
  } catch { last = null; }
  return { available: await available(gc), last };
}

module.exports = { FAMILIE, SERVICE, MAX_EVENTS, available, textOf, send, status };
