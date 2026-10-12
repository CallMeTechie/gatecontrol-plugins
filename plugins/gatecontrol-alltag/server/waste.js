'use strict';

// Müllabfuhr: the dates of each plan (Abfuhrplan) from its source — an
// uploaded ICS file, recurring rules, or an online provider — kept as the
// last good result in the database. A provider is an unofficial API, so it
// fails soft: on an error the stored dates stay, the plan shows the error
// and the next try backs off (30 min … 12 h); a good refresh happens at
// most twice a day. ICS and rules need no network; they are expanded once a
// day so the window moves along.

const ics = require('./ics');
const tz = require('./tz');
const store = require('./store');
const schedule = require('./schedule');
const fractions = require('./fractions');
const providers = require('./providers');

const HOUR = 3600000;
const PROVIDER_EVERY = 12 * HOUR;          // ≤ 2 good refreshes a day
const BACKOFF = [0.5, 1, 2, 4, 8, 12].map((h) => h * HOUR);
const LOCAL_EVERY = 24 * HOUR;             // ICS / rules: re-expanded daily
const LOCAL_RETRY = 24 * HOUR;             // a broken ICS is not retried more often
const PAST_DAYS = 7;                       // dates kept before today
const AHEAD_DAYS = 400;                    // … and after
const PER_TICK = 2;                        // plans refreshed per background run
const ICS_MAX_CHARS = 900 * 1024;          // upload: the host's request body is ≤ 1 MB JSON

/** The window of dates a plan keeps (plain dates). */
function windowOf(now, cfg) {
  const today = tz.localDate(now, cfg.tz);
  return { today, from: tz.addDays(today, -PAST_DAYS), to: tz.addDays(today, AHEAD_DAYS) };
}

/** Raw entries [{ date, name, color?, type? }] of a plan's source within [from, to]. */
async function entriesOf(gc, plan, cfg, { from, to }) {
  let out;
  if (plan.source === 'provider') {
    const p = providers.get(plan.provider);
    if (!p || !plan.provider_config) throw store.codeError('PROVIDER_CONFIG');
    out = await p.dates(gc, plan.provider_config, { from, to });
  } else if (plan.source === 'ics') {
    const text = await store.planIcs(gc, plan.id);
    if (!text) throw store.codeError('ICS_MISSING');
    out = icsEntries(text, cfg, { from, to });
  } else if (plan.source === 'rules') {
    out = schedule.fromRules(plan.rules, from, to);
  } else throw store.codeError('INVALID');
  return schedule.applyExceptions(out.filter((e) => e && e.name), plan.exceptions);
}

/** ICS → waste entries (one per event and day; the summary is the fraction). */
function icsEntries(text, cfg, { from, to }) {
  const r = ics.expand(text, { tz: cfg.tz, from: tz.toUtc({ ...tz.parseDate(from) }, cfg.tz), to: tz.toUtc({ ...tz.parseDate(tz.addDays(to, 1)) }, cfg.tz) });
  return r.instances.map((i) => ({ date: i.allDay ? i.date : tz.localDate(i.start, cfg.tz), name: i.title })).filter((e) => e.name && e.date >= from && e.date <= to);
}

/** Store entries: fractions (created on first sight) and the dates. → number of dates */
async function storeEntries(gc, plan, entries) {
  const byKey = new Map();
  for (const e of entries) {
    const key = fractions.normalize(e.name).slice(0, 120);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, { key, name: String(e.name).replace(/\s+/g, ' ').trim().slice(0, 120), color: e.color || null, type: e.type || fractions.classify(e.name) });
  }
  const ids = await store.ensureFractions(gc, plan.id, [...byKey.values()]);
  const rows = [];
  for (const e of entries) {
    const id = ids.get(fractions.normalize(e.name).slice(0, 120));
    if (id) rows.push({ date: e.date, fraction_id: id });
  }
  await store.replaceDates(gc, plan.id, rows);
  return rows.length;
}

/**
 * Refresh one plan now. Never throws: the result says what happened; on an
 * error the stored dates stay untouched.
 */
async function refreshPlan(gc, plan, cfg, now = Date.now()) {
  const win = windowOf(now, cfg);
  try {
    const entries = await entriesOf(gc, plan, cfg, win);
    const n = await storeEntries(gc, plan, entries);
    const every = plan.source === 'provider' ? PROVIDER_EVERY + Math.floor(Math.random() * HOUR) : LOCAL_EVERY;
    await store.updatePlan(gc, plan.id, { status: 'ok', last_error: null, error_count: 0, last_attempt_at: now, last_success_at: now, next_refresh_at: now + every });
    return { ok: true, dates: n };
  } catch (e) {
    const code = (e && e.code) || 'REFRESH_FAILED';
    const count = (plan.error_count || 0) + 1;
    const delay = plan.source === 'provider' ? BACKOFF[Math.min(count - 1, BACKOFF.length - 1)] : LOCAL_RETRY;
    await store.updatePlan(gc, plan.id, { status: 'error', last_error: String(code).slice(0, 60), error_count: count, last_attempt_at: now, next_refresh_at: now + delay });
    gc.log.warn('waste plan refresh failed', plan.id, code);
    return { ok: false, code };
  }
}

/** Background: the plans that are due (at most PER_TICK, none started after `deadline`). */
async function tick(gc, cfg, now = Date.now(), deadline = Infinity) {
  const due = (await store.listPlans(gc)).filter((p) => p.enabled && p.next_refresh_at <= now)
    .sort((a, b) => a.next_refresh_at - b.next_refresh_at).slice(0, PER_TICK);
  let n = 0;
  for (const p of due) {
    if (Date.now() >= deadline) break;
    await refreshPlan(gc, p, cfg, now);
    n++;
  }
  return n;
}

/** May this viewer see the plan? (users null = everyone) */
function visibleTo(plan, userId) {
  return !!plan.enabled && (plan.users == null || plan.users.includes(userId));
}

/**
 * Upcoming pickups: Map(planId → [{ date, fractions: [{ id, name, type, color }] }])
 * from today on (hidden fractions left out).
 */
async function upcoming(gc, planIds, cfg, now, { days = 60, limit = 8 } = {}) {
  const today = tz.localDate(now, cfg.tz);
  const rows = await store.datesBetween(gc, null, today, tz.addDays(today, days));
  const want = new Set(planIds);
  const out = new Map(planIds.map((id) => [id, []]));
  for (const r of rows) {
    if (!want.has(r.plan_id) || r.hidden) continue;
    const list = out.get(r.plan_id);
    let day = list[list.length - 1];
    if (!day || day.date !== r.date) {
      if (list.length >= limit) continue;
      day = { date: r.date, fractions: [] };
      list.push(day);
    }
    day.fractions.push(fractions.present({ id: r.fraction_id, source_name: r.source_name, type: r.type, name: r.name, color: r.color || null, hidden: r.hidden }));
  }
  return out;
}

/** Provider lookup for the admin picker: level 'places' | 'streets' | 'houses'. */
async function lookup(gc, { provider, service, place, street }) {
  const p = providers.get(provider);
  if (!p) throw store.codeError('PROVIDER_UNKNOWN');
  if (!p.customService.test(String(service || ''))) throw store.codeError('PROVIDER_CONFIG');
  if (street) return { level: 'houses', items: await p.houses(gc, service, place, street) };
  if (place) return { level: 'streets', items: await p.streets(gc, service, place) };
  return { level: 'places', items: await p.places(gc, service) };
}

/** Dates a provider configuration would bring (admin preview; nothing stored). */
async function preview(gc, provider, config, cfg, now = Date.now()) {
  const p = providers.get(provider);
  if (!p) throw store.codeError('PROVIDER_UNKNOWN');
  const today = tz.localDate(now, cfg.tz);
  const list = await p.dates(gc, config, { from: today, to: tz.addDays(today, 60) });
  return list.slice(0, 40).map((e) => ({ date: e.date, name: e.name, type: fractions.classify(e.name), color: e.color || fractions.COLORS[fractions.classify(e.name)] }));
}

module.exports = {
  windowOf, entriesOf, icsEntries, storeEntries, refreshPlan, tick, visibleTo, upcoming, lookup, preview,
  PROVIDER_EVERY, BACKOFF, LOCAL_EVERY, PER_TICK, ICS_MAX_CHARS,
};
