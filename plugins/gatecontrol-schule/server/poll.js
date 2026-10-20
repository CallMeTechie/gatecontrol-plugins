'use strict';

// Fetching the timetables. The background tick runs every 60 s; an account
// is fetched when its next_fetch_at has come:
//   * Mon–Sat 05:30–20:00 (plugin time zone) every `poll_minutes` (default 15), otherwise
//     hourly — at the latest at the start of the next such window;
//   * after an error with back-off: network / failed 5, 10, 20 … ≤ 120 min; auth / no_right
//     1, 2, 4 … ≤ 24 h (repeated bad logins could lock the WebUntis account);
//   * one login per account and cycle, logout at its end (also after an error).
// A cycle: login → the account's persons (api/app/config: a student account is the student,
// a parent account lists its children) → timegrid and holidays once a day → each enabled
// student's timetable from Monday of this week to Sunday of next week (14 days, always
// ≥ today + 7; the portal shows this and next week) → change detection (server/changes.js)
// → 1.2.0: homework (once per account) and exams (per student) for the same dates — optional,
// never failing the cycle (server/extras.js).
// 1.4.0: then the account's school messages (≤ every 15 min, server/messages.js) and the fetched
// students' absences (≤ hourly, server/absences.js) — optional the same way.

const store = require('./store');
const untis = require('./untis');
const tt = require('./timetable');
const changes = require('./changes');
const extras = require('./extras');
const messages = require('./messages');
const absences = require('./absences');
const tz = require('./tz');

const MIN = 60000;
const HOUR = 3600000;
const WINDOW_FROM = 5 * 60 + 30;
const WINDOW_TO = 20 * 60;
const REFRESH_GAP_MS = 5 * MIN;

/** Mon–Sat 05:30–20:00 in the plugin's zone? */
function inWindow(ms, cfg) {
  const p = tz.parts(ms, cfg.tz);
  const m = p.hh * 60 + p.mm;
  return p.wd >= 1 && p.wd <= 6 && m >= WINDOW_FROM && m < WINDOW_TO;
}

/** Start of the next polling window after `ms`. */
function nextWindowStart(ms, cfg) {
  const today = tz.localDate(ms, cfg.tz);
  for (let i = 0; i <= 8; i++) {
    const d = tz.addDays(today, i);
    const wd = tz.weekday(d);
    if (wd === 0) continue;
    const t = tz.at(d, { hh: Math.floor(WINDOW_FROM / 60), mm: WINDOW_FROM % 60 }, cfg.tz);
    if (t > ms) return t;
  }
  return ms + HOUR;
}

/** When to fetch next after a good cycle at `now`. */
function nextFetch(now, cfg) {
  if (inWindow(now, cfg)) return now + cfg.pollMinutes * MIN;
  return Math.min(now + HOUR, nextWindowStart(now, cfg));
}

/** Back-off after the n-th error in a row. */
function backoff(code, n, cfg) {
  const k = Math.max(0, Math.min(10, n - 1));
  if (code === 'auth' || code === 'no_right') return Math.min(HOUR * 2 ** k, 24 * HOUR);
  return Math.min(Math.max(5 * MIN, 5 * MIN * 2 ** k), 2 * HOUR);
}

/** The dates a cycle fetches: Monday of this week … Sunday of next week (14 days, ≥ today + 7). */
function rangeOf(now, cfg) {
  const monday = tz.weekStart(tz.localDate(now, cfg.tz));
  return { from: monday, to: tz.addDays(monday, 13) };
}

/**
 * One cycle of an account. → { ok, code?, students, changes, pending, persons }
 * opts.persons: true → also answer the persons found (adding an account).
 */
async function pollAccount(gc, acc, cfg, now, opts = {}) {
  const deadline = opts.deadline || Infinity;
  const cred = await store.getCred(gc, acc);
  const result = { ok: false, code: null, students: 0, changes: 0, pending: 0, persons: [] };
  await store.updateAccount(gc, acc.id, { last_attempt_at: now });
  let client = null;
  try {
    if (!cred) throw new untis.UntisError('auth', 'no_credentials');
    client = untis.createClient(gc, acc);
    const login = await client.login(cred, now);
    let conf = null;
    try { conf = await client.appConfig(); } catch (e) {
      if (untis.codeOf(e) === 'network') throw e;
      gc.log.info('app config not available', acc.id, untis.codeOf(e));
    }
    const persons = untis.studentsOf(acc, login, conf);
    result.persons = persons;
    const self = ((conf && conf.persons) || []).find((p) => p.id === (conf && conf.personId));
    await store.updateAccount(gc, acc.id, {
      person_id: (conf && conf.personId) || login.personId || null,
      person_type: (self && self.type) || login.personType || null,
    });
    const students = await store.syncStudents(gc, acc.id, persons, now);
    const range = rangeOf(now, cfg);
    // timegrid and holidays once per day (they hardly change; an error keeps the old ones)
    let grid = acc.timegrid;
    if (acc.meta_day !== tz.localDate(now, cfg.tz)) {
      try {
        grid = tt.compactTimegrid(await client.timegrid());
        const holidays = tt.compactHolidays(await client.holidays(), tz.addDays(range.from, -30), tz.addDays(range.from, 120));
        await store.updateAccount(gc, acc.id, { timegrid: grid, holidays, meta_day: tz.localDate(now, cfg.tz) });
      } catch (e) {
        if (untis.codeOf(e) === 'network') throw e;
        gc.log.info('timegrid/holidays not available', acc.id, untis.codeOf(e));
        grid = acc.timegrid;
      }
    }
    const due = students.filter((s) => s.enabled && !s.missing);
    let failures = 0;
    let firstError = null;
    const fetched = [];
    for (const s of due) {
      if (Date.now() > deadline) break; // the rest in the next cycle
      try {
        const raw = await client.timetable(s.person_id, range.from, range.to);
        const rows = tt.normalize(raw, grid, range);
        const r = await changes.apply(gc, s, rows, range, cfg, now);
        fetched.push({ student: s, raw, rows });
        result.students += 1;
        result.changes += r.changes;
        result.pending += r.pending;
      } catch (e) {
        const code = untis.codeOf(e);
        if (code === 'network') throw e;
        failures += 1;
        firstError = firstError || e;
        await store.updateStudent(gc, s.id, { last_error: code });
        gc.log.warn('timetable not fetched', acc.id, s.id, code);
      }
    }
    if (due.length && failures === due.length) throw firstError;
    // 1.2.0: homework and exams (never throws)
    const extrasState = await extras.fetchAccount(gc, client, acc, fetched, range, now, deadline);
    // 1.4.0: messages and absences (never throw; their pauses go into the same state)
    await messages.fetchAccount(gc, client, acc, fetched, extrasState, cfg, now, deadline);
    await absences.fetchAccount(gc, client, acc, fetched, extrasState, cfg, now, deadline);
    await store.updateAccount(gc, acc.id, {
      extras: extrasState,
      status: 'ok', last_error: failures ? untis.codeOf(firstError) : null, error_count: 0, last_success_at: now,
      next_fetch_at: nextFetch(now, cfg),
    });
    result.ok = true;
    result.code = failures ? untis.codeOf(firstError) : null;
  } catch (e) {
    const code = untis.codeOf(e);
    const fresh = await store.getAccount(gc, acc.id);
    const n = ((fresh && fresh.error_count) || 0) + 1;
    if (fresh) {
      await store.updateAccount(gc, acc.id, {
        status: 'error', last_error: code, last_error_at: now, error_count: n, next_fetch_at: now + backoff(code, n, cfg),
      });
    }
    // codes only: never a credential, a one-time password, a session id or a response body
    gc.log.warn('webuntis fetch failed', acc.id, code, e && e.detail != null ? String(e.detail).slice(0, 20) : '');
    result.code = code;
  } finally {
    if (client && client.loggedIn) await client.logout();
  }
  return result;
}

/** Background: every due account (none started after the deadline). */
async function tick(gc, cfg, now, deadline) {
  for (const acc of await store.listAccounts(gc)) {
    if (Date.now() > deadline) break;
    if (acc.next_fetch_at > now) continue;
    await pollAccount(gc, acc, cfg, now, { deadline });
  }
}

/**
 * A person asked for fresh data (quick action): the account is fetched in the next tick, at most
 * every 5 minutes and never during an error back-off. → true when asked.
 */
async function askRefresh(gc, acc, now) {
  if (acc.status === 'error' && acc.next_fetch_at > now) return false;
  if (acc.last_attempt_at && now - acc.last_attempt_at < REFRESH_GAP_MS) return false;
  if (acc.refresh_asked_at && now - acc.refresh_asked_at < REFRESH_GAP_MS) return false;
  await store.updateAccount(gc, acc.id, { next_fetch_at: Math.min(acc.next_fetch_at, now), refresh_asked_at: now });
  return true;
}

module.exports = { inWindow, nextWindowStart, nextFetch, backoff, rangeOf, pollAccount, tick, askRefresh };
