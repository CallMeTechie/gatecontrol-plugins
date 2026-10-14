'use strict';

// gatecontrol-alltag — "Alltag": waste collection dates (Müllabfuhr) and
// calendar subscriptions (Kalender) with reminders through GateControl's
// notification center and a part of the portal tab "Zuhause".
//
//   admin API   (the plugin page; administrators only)
//     GET  /status                       everything the page shows
//     POST /plans   PUT|DELETE /plans/:id   POST /plans/:id/refresh   GET /plans/:id/dates
//                                        (a plan's reminder: { lead, time, extra, extra_time })
//     PUT  /plans/:id/fractions/:fid     rename / recolour / retype / hide
//     POST /providers/lookup · /providers/preview · /ics/preview
//     POST /subscriptions   PUT|DELETE /subscriptions/:id   POST /subscriptions/:id/refresh
//     GET  /subscriptions/:id/events
//     POST /test/waste · /test/calendar   a sample reminder to the requesting administrator
//   app API     (the GateControl app, req.user.app; GateControl ≥ 1.164.0 permissions.app)
//     GET  /app/events?from=YYYY-MM-DD&to=YYYY-MM-DD   the caller's events and pickups (≤ 62 days)
//   portal API  (the identified portal viewer)
//     GET  /portal/waste      the plans this person sees (read-only, also for device trust)
//     GET  /portal/calendar   the person's calendars — details only after a real login,
//                             a device-trust viewer gets a count
//
// Requests run with the requesting user's rights: the admin API is reached
// only by administrators (the host's admin routes) and refuses a portal
// viewer; the portal API only ever answers with what that viewer may see.
// The internet address of a calendar is a secret and never leaves the
// plugin (the browser gets its host only).

const ui = require('./ui');
const store = require('./store');
const config = require('./config');
const waste = require('./waste');
const calendar = require('./calendar');
const alerts = require('./alerts');
const fractions = require('./fractions');
const schedule = require('./schedule');
const providers = require('./providers');
const ics = require('./ics');
const format = require('./format');
const tz = require('./tz');
const texts = require('./texts.json');

const crypto = require('node:crypto');

const DAY = 86400000;
const APP_MAX_DAYS = 62;

function t(lang, key, params) {
  const l = lang === 'en' ? 'en' : 'de';
  let s = (texts[l] && texts[l][key]) || texts.de[key] || key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{{${k}}}`).join(String(v));
  return s;
}

// error code → [HTTP status, text key]
const ERRORS = {
  INVALID: [400, 'error.invalid'],
  NAME_REQUIRED: [400, 'error.name_required'],
  RULES_REQUIRED: [400, 'error.rules_required'],
  ICS_REQUIRED: [400, 'error.ics_required'],
  ICS_INVALID: [400, 'error.ics_invalid'],
  ICS_TOO_LARGE: [413, 'error.ics_too_large'],
  ICS_EMPTY: [400, 'error.ics_empty'],
  URL_INVALID: [400, 'error.url_invalid'],
  URL_HOST_NOT_ALLOWED: [400, 'error.url_host'],
  URL_REQUIRED: [400, 'error.url_required'],
  PATH_INVALID: [400, 'error.path_invalid'],
  TARGET_REQUIRED: [400, 'error.target_required'],
  USERS_INVALID: [400, 'error.users_invalid'],
  REMINDER_INVALID: [400, 'error.reminder_invalid'],
  PROVIDER_UNKNOWN: [400, 'error.provider_unknown'],
  PROVIDER_CONFIG: [400, 'error.provider_config'],
  PROVIDER_NOT_FOUND: [502, 'error.provider_not_found'],
  PROVIDER_REFUSED: [502, 'error.provider_refused'],
  PROVIDER_RATE_LIMITED: [502, 'error.provider_rate'],
  PROVIDER_UNREACHABLE: [502, 'error.provider_unreachable'],
  PROVIDER_DENIED: [502, 'error.provider_unreachable'],
  PROVIDER_HTTP: [502, 'error.provider_http'],
  PROVIDER_BAD_RESPONSE: [502, 'error.provider_bad'],
  AREA_DISABLED: [409, 'error.area_disabled'],
  LOGIN_REQUIRED: [403, 'error.login_required'],
  FORBIDDEN: [403, 'error.forbidden'],
  NOT_FOUND: [404, 'error.not_found'],
};

function fail(code) { return Object.assign(new Error(code), { code }); }

function errorResponse(e, lang) {
  const known = e && ERRORS[e.code];
  const [status, key] = known || [500, 'error.internal'];
  return { status, json: { ok: false, code: known ? e.code : 'INTERNAL', error: t(lang, key) } };
}

const posInt = (v) => {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d{1,10}$/.test(v) ? Number(v) : NaN);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const str = (v, max) => (typeof v === 'string' ? v.replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

async function usersById(gc) {
  const m = new Map();
  try { for (const u of await gc.users.list()) m.set(u.id, { id: u.id, username: u.name, role: u.role }); } catch { /* users unavailable */ }
  return m;
}

/** A users list from the API → ids of existing users (USERS_INVALID otherwise). null stays null (plans: everyone). */
async function cleanUsers(gc, raw, { allowNull }) {
  if (raw === null && allowNull) return null;
  if (!Array.isArray(raw) || raw.length > 500) throw fail('USERS_INVALID');
  const known = await usersById(gc);
  const ids = [...new Set(raw.map(posInt))];
  if (ids.some((id) => !id || !known.has(id))) throw fail('USERS_INVALID');
  return ids;
}

async function targetsOf(gc) {
  try {
    const t0 = (await gc.net.targets()).find((x) => x.id === 'calendar');
    return t0 ? t0.assigned.map((a) => ({ index: a.index, label: a.label })) : [];
  } catch { return []; }
}

// ─── Admin views ────────────────────────────────

async function planView(gc, p, cfg, users, upcomingMap, now) {
  const frs = (await store.listFractions(gc, p.id)).map((f) => ({ ...fractions.present(f), source_name: f.source_name, renamed: !!f.name }));
  const today = tz.localDate(now, cfg.tz);
  return {
    id: p.id, name: p.name, source: p.source, provider: p.provider, provider_config: p.provider_config,
    ics_name: p.ics_name, ics_size: p.ics_size, rules: p.rules, exceptions: p.exceptions,
    users: p.users == null ? null : p.users.filter((id) => users.has(id)).map((id) => users.get(id)),
    reminder: reminderView(p, cfg),
    enabled: p.enabled, status: p.status, last_error: p.last_error, error_text: p.last_error ? t(cfg.uiLang, ERRORS[p.last_error] ? ERRORS[p.last_error][1] : 'error.refresh') : null,
    last_attempt_at: p.last_attempt_at, last_success_at: p.last_success_at, next_refresh_at: p.next_refresh_at,
    date_count: await store.countDates(gc, p.id, today), fractions: frs,
    upcoming: (upcomingMap.get(p.id) || []).map((d) => ({ date: d.date, label: format.rel(d.date, today, cfg.uiLang), fractions: d.fractions })),
  };
}

async function subView(gc, s, cfg, users, targets, now) {
  const week = await store.eventsBetween(gc, [s.id], now, now + 7 * DAY, 500);
  const tg = s.target_index == null ? null : targets.find((x) => x.index === s.target_index);
  return {
    id: s.id, name: s.name, color: s.color, source: s.source, address: calendar.masked(s), url_host: s.url_host,
    target_index: s.target_index, target_label: tg ? tg.label : null, target_path: s.source === 'target' ? s.target_path : null,
    has_credentials: s.source === 'target' ? Boolean((await store.subSecret(gc, s.id, 'user')) || (await store.subSecret(gc, s.id, 'password'))) : false,
    reminder: s.reminder, allday_reminder: s.allday_reminder,
    users: s.users.filter((id) => users.has(id)).map((id) => users.get(id)),
    enabled: s.enabled, status: s.status, last_error: s.last_error,
    error_text: s.last_error ? t(cfg.uiLang, 'calerror.' + String(s.last_error).split(':')[0]) : null,
    last_attempt_at: s.last_attempt_at, last_success_at: s.last_success_at, next_refresh_at: s.next_refresh_at,
    event_count: s.event_count, truncated: s.truncated, week_count: week.length,
  };
}

/** The reminder a plan uses (its own or the defaults) for the page: { lead: 'off'|0–3, time, extra, extra_time, custom }. */
function reminderView(p, cfg) {
  const r = alerts.reminderOf(p, cfg);
  return { lead: r.lead == null ? 'off' : r.lead, time: config.hhmm(r.time), extra: r.extra, extra_time: config.hhmm(r.extraTime), custom: r.custom };
}

// ─── Plans (admin) ──────────────────────────────

/**
 * The reminder of a plan from a request body: null = the plugin settings
 * (defaults); an object { lead: 'off' | 0–3 | null, time: 'HH:MM' | null,
 * extra: boolean | null, extra_time: 'HH:MM' | null } — a field left out or
 * null follows the settings. On update, fields left out keep their value.
 */
function cleanReminder(raw, existing) {
  if (raw === null) return { lead: null, time: null, extra: null, extra_time: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) throw fail('REMINDER_INVALID');
  const out = { lead: null, time: null, extra: null, extra_time: null, ...(existing || {}) };
  const time = (v) => {
    if (v === null) return null;
    const m = typeof v === 'string' ? /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(v.trim()) : null;
    if (!m) throw fail('REMINDER_INVALID');
    return `${m[1].padStart(2, '0')}:${m[2]}`;
  };
  if (raw.lead !== undefined) {
    if (raw.lead !== null && raw.lead !== 'off' && !(Number.isInteger(raw.lead) && raw.lead >= 0 && raw.lead <= alerts.MAX_LEAD)) throw fail('REMINDER_INVALID');
    out.lead = raw.lead;
  }
  if (raw.time !== undefined) out.time = time(raw.time);
  if (raw.extra !== undefined) {
    if (raw.extra !== null && typeof raw.extra !== 'boolean') throw fail('REMINDER_INVALID');
    out.extra = raw.extra;
  }
  if (raw.extra_time !== undefined) out.extra_time = time(raw.extra_time);
  return out;
}

function cleanProviderConfig(provider, raw) {
  const p = providers.get(provider);
  if (!p) throw fail('PROVIDER_UNKNOWN');
  if (!raw || typeof raw !== 'object') throw fail('PROVIDER_CONFIG');
  const ref = (v, required) => {
    if (v == null || v === '') { if (required) throw fail('PROVIDER_CONFIG'); return null; }
    if (typeof v !== 'object' || v.id == null) throw fail('PROVIDER_CONFIG');
    const id = String(v.id).slice(0, 200);
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(id)) throw fail('PROVIDER_CONFIG');
    return { id, name: str(v.name, 120) || id };
  };
  const service = typeof raw.service === 'string' ? raw.service.trim() : '';
  if (!p.customService.test(service)) throw fail('PROVIDER_CONFIG');
  const known = p.services.find((s) => s.id === service);
  return { service, serviceTitle: known ? known.title : (str(raw.serviceTitle, 120) || service), place: ref(raw.place, true), street: ref(raw.street, false), house: ref(raw.house, false) };
}

function checkIcs(text) {
  if (typeof text !== 'string' || !text.trim()) throw fail('ICS_REQUIRED');
  if (text.length > waste.ICS_MAX_CHARS) throw fail('ICS_TOO_LARGE');
  const r = ics.readEvents(text, { tz: 'UTC', calTz: null }); // throws ICS_INVALID
  if (!r.events.length) throw fail('ICS_EMPTY');
  return text;
}

/** Plan fields from a request body (create: all required for the source; update: only given ones). */
async function planFields(gc, body, existing) {
  const out = {};
  if (!existing || body.name !== undefined) {
    out.name = str(body.name, 60);
    if (!out.name) throw fail('NAME_REQUIRED');
  }
  const source = body.source !== undefined ? body.source : (existing ? existing.source : undefined);
  if (!['ics', 'rules', 'provider'].includes(source)) throw fail('INVALID');
  if (!existing || body.source !== undefined) out.source = source;
  if (source === 'provider' && (!existing || body.provider !== undefined || body.provider_config !== undefined || body.source !== undefined)) {
    out.provider = body.provider !== undefined ? body.provider : existing && existing.provider;
    out.provider_config = cleanProviderConfig(out.provider, body.provider_config !== undefined ? body.provider_config : existing && existing.provider_config);
  }
  if (source === 'rules' && (!existing || body.rules !== undefined || body.source !== undefined)) {
    const rules = schedule.cleanList(body.rules !== undefined ? body.rules : existing && existing.rules, schedule.cleanRule, schedule.MAX_RULES);
    if (!rules) throw fail('INVALID');
    if (!rules.length) throw fail('RULES_REQUIRED');
    out.rules = rules;
  }
  if (source === 'ics' && (body.ics !== undefined || !existing || existing.source !== 'ics')) {
    out.ics_text = checkIcs(body.ics);
    out.ics_name = str(body.ics_name, 120) || 'kalender.ics';
  }
  if (source !== 'ics' && existing && existing.source === 'ics') { out.ics_text = null; out.ics_name = null; }
  if (body.exceptions !== undefined) {
    const ex = schedule.cleanList(body.exceptions, schedule.cleanException, schedule.MAX_EXCEPTIONS);
    if (!ex) throw fail('INVALID');
    out.exceptions = ex;
  }
  if (body.users !== undefined) out.users = await cleanUsers(gc, body.users, { allowNull: true });
  if (body.reminder !== undefined) out.reminder = cleanReminder(body.reminder, existing && existing.reminder);
  if (body.enabled !== undefined) { if (typeof body.enabled !== 'boolean') throw fail('INVALID'); out.enabled = body.enabled; }
  return out;
}

// ─── Subscriptions (admin) ──────────────────────

async function subFields(gc, body, existing, targets) {
  const out = {};
  const secrets = {};
  if (!existing || body.name !== undefined) { out.name = str(body.name, 60); if (!out.name) throw fail('NAME_REQUIRED'); }
  if (!existing || body.color !== undefined) out.color = fractions.validColor(body.color) || '#0d9488';
  const source = body.source !== undefined ? body.source : (existing ? existing.source : undefined);
  if (!['url', 'target'].includes(source)) throw fail('INVALID');
  if (!existing || body.source !== undefined) out.source = source;
  if (source === 'url') {
    const given = typeof body.url === 'string' && body.url.trim();
    if (given) {
      const { url, host } = calendar.checkUrl(body.url);
      secrets.url = url;
      out.url_host = host;
    } else if (!existing || existing.source !== 'url') throw fail('URL_REQUIRED');
    if (existing && existing.source === 'target') { out.target_index = null; out.target_path = null; secrets.user = null; secrets.password = null; }
  } else {
    if (!existing || body.target_index !== undefined || existing.source !== 'target') {
      const idx = Number.isInteger(body.target_index) ? body.target_index : null;
      if (idx == null || !targets.some((x) => x.index === idx)) throw fail('TARGET_REQUIRED');
      out.target_index = idx;
    }
    if (!existing || body.path !== undefined || existing.source !== 'target') out.target_path = calendar.checkPath(body.path);
    if (body.username !== undefined) secrets.user = str(body.username, 200) || null;
    if (typeof body.password === 'string' && body.password) secrets.password = body.password.slice(0, 500);
    if (body.clear_credentials === true) { secrets.user = null; secrets.password = null; }
    if (existing && existing.source === 'url') { out.url_host = null; secrets.url = null; }
  }
  if (!existing || body.reminder !== undefined) {
    const r = body.reminder === undefined ? '15' : String(body.reminder);
    if (!calendar.REMINDERS.includes(r)) throw fail('INVALID');
    out.reminder = r;
  }
  if (body.allday_reminder !== undefined) { if (typeof body.allday_reminder !== 'boolean') throw fail('INVALID'); out.allday_reminder = body.allday_reminder; } else if (!existing) out.allday_reminder = true;
  if (body.users !== undefined) out.users = await cleanUsers(gc, body.users, { allowNull: false });
  if (body.enabled !== undefined) { if (typeof body.enabled !== 'boolean') throw fail('INVALID'); out.enabled = body.enabled; }
  return { fields: out, secrets };
}

async function saveSecrets(gc, id, secrets) {
  for (const [k, v] of Object.entries(secrets)) await store.setSubSecret(gc, id, k, v);
}

// ─── Routes ─────────────────────────────────────

async function adminRoute(req, gc, seg, cfg) {
  const m = req.method;
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const [a, b, c, d] = seg;
  const now = Date.now();

  if (a === 'status' && seg.length === 1 && m === 'GET') {
    const users = await usersById(gc);
    const targets = await targetsOf(gc);
    const plans = await store.listPlans(gc);
    const up = await waste.upcoming(gc, plans.map((p) => p.id), cfg, now, { days: 60, limit: 6 });
    const subs = await store.listSubs(gc);
    return {
      json: {
        ok: true,
        config: { waste_enabled: cfg.wasteEnabled, calendar_enabled: cfg.calendarEnabled, timezone: cfg.tz, evening: config.hhmm(cfg.evening), morning: cfg.morning,
          morning_time: config.hhmm(cfg.morningTime), allday_time: config.hhmm(cfg.alldayTime), notify_lang: cfg.lang, problems: cfg.problems },
        plans: await Promise.all(plans.map((p) => planView(gc, p, cfg, users, up, now))),
        subscriptions: await Promise.all(subs.map((s) => subView(gc, s, cfg, users, targets, now))),
        providers: providers.describe(),
        hosts: { exact: calendar.EXACT_HOSTS, suffix: calendar.SUFFIX_HOSTS },
        targets, users: [...users.values()],
      },
    };
  }

  if (a === 'providers' && seg.length === 2 && m === 'POST') {
    if (b === 'lookup') {
      const r = await waste.lookup(gc, { provider: body.provider, service: typeof body.service === 'string' ? body.service.trim() : '', place: body.place ? String(body.place) : null, street: body.street ? String(body.street) : null });
      return { json: { ok: true, ...r } };
    }
    if (b === 'preview') return { json: { ok: true, dates: await waste.preview(gc, body.provider, cleanProviderConfig(body.provider, body.provider_config), cfg, now) } };
  }

  if (a === 'ics' && b === 'preview' && seg.length === 2 && m === 'POST') {
    const text = checkIcs(body.ics);
    const today = tz.localDate(now, cfg.tz);
    const entries = waste.icsEntries(text, cfg, { from: today, to: tz.addDays(today, 400) });
    const names = new Map();
    for (const e of entries) names.set(fractions.normalize(e.name), e.name);
    return { json: { ok: true, count: entries.length, fractions: [...names.values()].map((n) => ({ name: n, type: fractions.classify(n), color: fractions.COLORS[fractions.classify(n)] })), first: entries.slice(0, 10) } };
  }

  if (a === 'plans') {
    if (seg.length === 1 && m === 'POST') {
      const f = await planFields(gc, body, null);
      if (f.users === undefined) f.users = null;
      const plan = await store.createPlan(gc, f);
      const result = await waste.refreshPlan(gc, plan, cfg, now);
      return { status: 201, json: { ok: true, plan: { id: plan.id }, result } };
    }
    const id = posInt(b);
    if (!id) throw fail('NOT_FOUND');
    const plan = await store.getPlan(gc, id);
    if (!plan) throw fail('NOT_FOUND');
    if (seg.length === 2 && m === 'PUT') {
      const f = await planFields(gc, body, plan);
      const updated = await store.updatePlan(gc, id, { ...f, next_refresh_at: 0, error_count: 0 });
      const result = updated.enabled ? await waste.refreshPlan(gc, updated, cfg, now) : null;
      return { json: { ok: true, plan: { id }, result } };
    }
    if (seg.length === 2 && m === 'DELETE') return { json: { ok: await store.deletePlan(gc, id) } };
    if (seg.length === 3 && c === 'refresh' && m === 'POST') return { json: { ok: true, result: await waste.refreshPlan(gc, plan, cfg, now) } };
    if (seg.length === 3 && c === 'dates' && m === 'GET') {
      const today = tz.localDate(now, cfg.tz);
      const rows = await store.datesBetween(gc, id, today, tz.addDays(today, 120));
      return { json: { ok: true, dates: rows.slice(0, 200).map((r) => ({ date: r.date, label: format.rel(r.date, today, cfg.uiLang), ...fractions.present({ id: r.fraction_id, source_name: r.source_name, type: r.type, name: r.name, color: r.color, hidden: r.hidden }) })) } };
    }
    if (seg.length === 4 && c === 'fractions' && m === 'PUT') {
      const fid = posInt(d);
      if (!fid) throw fail('NOT_FOUND');
      const patch = {};
      if (body.name !== undefined) { if (body.name !== null && typeof body.name !== 'string') throw fail('INVALID'); patch.name = str(body.name, 60) || null; }
      if (body.color !== undefined) { if (body.color !== null && !fractions.validColor(body.color)) throw fail('INVALID'); patch.color = fractions.validColor(body.color); }
      if (body.type !== undefined) { if (!fractions.TYPES.includes(body.type)) throw fail('INVALID'); patch.type = body.type; }
      if (body.hidden !== undefined) { if (typeof body.hidden !== 'boolean') throw fail('INVALID'); patch.hidden = body.hidden; }
      const f = await store.updateFraction(gc, id, fid, patch);
      if (!f) throw fail('INVALID');
      return { json: { ok: true, fraction: { ...fractions.present(f), source_name: f.source_name } } };
    }
    throw fail('NOT_FOUND');
  }

  if (a === 'subscriptions') {
    const targets = await targetsOf(gc);
    if (seg.length === 1 && m === 'POST') {
      const { fields, secrets } = await subFields(gc, body, null, targets);
      // default visibility: the administrator who adds it
      if (fields.users === undefined) fields.users = posInt(req.user.id) ? [req.user.id] : [];
      fields.created_by = posInt(req.user.id);
      const sub = await store.createSub(gc, fields);
      await saveSecrets(gc, sub.id, secrets);
      const result = await calendar.refreshSub(gc, await store.getSub(gc, sub.id), cfg, now, { force: true });
      return { status: 201, json: { ok: true, subscription: { id: sub.id }, result } };
    }
    const id = posInt(b);
    if (!id) throw fail('NOT_FOUND');
    const sub = await store.getSub(gc, id);
    if (!sub) throw fail('NOT_FOUND');
    if (seg.length === 2 && m === 'PUT') {
      const { fields, secrets } = await subFields(gc, body, sub, targets);
      await saveSecrets(gc, id, secrets);
      const updated = await store.updateSub(gc, id, { ...fields, next_refresh_at: 0, error_count: 0, etag: null, last_modified: null });
      const result = updated.enabled ? await calendar.refreshSub(gc, updated, cfg, now, { force: true }) : null;
      return { json: { ok: true, subscription: { id }, result } };
    }
    if (seg.length === 2 && m === 'DELETE') {
      await store.clearSubSecrets(gc, id);
      return { json: { ok: await store.deleteSub(gc, id) } };
    }
    if (seg.length === 3 && c === 'refresh' && m === 'POST') return { json: { ok: true, result: await calendar.refreshSub(gc, sub, cfg, now, { force: true }) } };
    if (seg.length === 3 && c === 'events' && m === 'GET') {
      const today = tz.localDate(now, cfg.tz);
      const list = await store.eventsBetween(gc, [id], now - DAY, now + 30 * DAY, 30);
      return { json: { ok: true, events: list.map((e) => eventView(e, cfg, today, cfg.uiLang)) } };
    }
    throw fail('NOT_FOUND');
  }

  if (a === 'test' && seg.length === 2 && m === 'POST' && (b === 'waste' || b === 'calendar')) {
    const r = await alerts.sendTest(gc, b, req.user.id);
    return { json: { ok: r.sent, pushed: r.pushed, error: r.error } };
  }
  throw fail('NOT_FOUND');
}

function eventView(e, cfg, today, lang) {
  return {
    date: e.date, label: format.rel(e.date, today, lang), all_day: e.all_day, title: e.title, location: e.location || null,
    time: e.all_day ? null : format.time(e.start_ms, cfg.tz), end: e.all_day ? null : format.time(e.end_ms, cfg.tz),
  };
}

// ─── Portal ─────────────────────────────────────

async function visiblePlans(gc, userId) {
  return (await store.listPlans(gc)).filter((p) => waste.visibleTo(p, userId));
}
async function visibleSubs(gc, userId) {
  return (await store.listSubs(gc)).filter((s) => calendar.visibleTo(s, userId));
}

/** The viewer's pickups: [{ id, name, days: [{ date, label, rel, fractions }] }] */
async function portalWaste(gc, user, cfg, lang, now, limit = 5) {
  if (!cfg.wasteEnabled) return [];
  const plans = await visiblePlans(gc, user.id);
  const up = await waste.upcoming(gc, plans.map((p) => p.id), cfg, now, { days: 60, limit });
  const today = tz.localDate(now, cfg.tz);
  return plans.map((p) => ({
    id: p.id, name: p.name,
    days: (up.get(p.id) || []).map((d) => ({ date: d.date, label: format.rel(d.date, today, lang), rel: d.date === today ? 'today' : (d.date === tz.addDays(today, 1) ? 'tomorrow' : null), fractions: d.fractions.map((f) => ({ name: f.name, type: f.type, color: f.color })) })),
  }));
}

/** The viewer's events from now to the end of day +7 (details: real login only). */
async function portalEvents(gc, user, cfg, now) {
  if (!cfg.calendarEnabled) return { subs: [], events: [] };
  const subs = await visibleSubs(gc, user.id);
  const today = tz.localDate(now, cfg.tz);
  const end = tz.toUtc({ ...tz.parseDate(tz.addDays(today, 8)) }, cfg.tz);
  const events = await store.eventsBetween(gc, subs.map((s) => s.id), now, end, 300);
  return { subs, events };
}

async function portalRoute(req, gc, seg, cfg) {
  const user = req.user;
  const lang = req.lang;
  const now = Date.now();
  if (req.method !== 'GET' || seg.length !== 2) throw fail('NOT_FOUND');
  if (seg[1] === 'waste') return { json: { ok: true, enabled: cfg.wasteEnabled, plans: await portalWaste(gc, user, cfg, lang, now) } };
  if (seg[1] === 'calendar') {
    const { subs, events } = await portalEvents(gc, user, cfg, now);
    if (user.loggedIn !== true) return { json: { ok: true, enabled: cfg.calendarEnabled, loggedIn: false, count: events.length } };
    const byId = new Map(subs.map((s) => [s.id, s]));
    const today = tz.localDate(now, cfg.tz);
    const days = [];
    for (const e of events) {
      // an all-day event that started earlier is listed today
      const date = e.date < today ? today : e.date;
      let day = days.find((x) => x.date === date);
      if (!day) { day = { date, label: format.cap(format.rel(date, today, lang)), events: [] }; days.push(day); }
      const s = byId.get(e.sub_id);
      day.events.push({ ...eventView(e, cfg, today, lang), calendar: s.name, color: s.color });
    }
    days.sort((x, y) => (x.date < y.date ? -1 : 1));
    return { json: { ok: true, enabled: cfg.calendarEnabled, loggedIn: true, days } };
  }
  throw fail('NOT_FOUND');
}

// ─── App (GateControl app, permissions.app) ─────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /app/events?from=&to= — the caller's calendar events and waste pickups
 * between two local dates (inclusive, at most 62 days), with the same
 * visibility as the portal: calendars assigned to the person, plans for
 * everyone or for the person; a switched-off area answers with an empty list.
 *   { events: [{ id, title, date, time, endTime, allDay, calendar: { id, name, color }, endDate, location }],
 *     waste:  [{ date, kinds: [name], color, plan: { id, name }, fractions: [{ name, type, color }] }] }
 */
async function appEvents(gc, user, query, cfg, now) {
  const q = query || {};
  const today = tz.localDate(now, cfg.tz);
  const from = q.from == null || q.from === '' ? today : String(q.from);
  const to = q.to == null || q.to === '' ? tz.addDays(from, 31) : String(q.to);
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || !tz.parseDate(from) || !tz.parseDate(to) || to < from || tz.diffDays(from, to) > APP_MAX_DAYS) throw fail('INVALID');
  const events = [];
  if (cfg.calendarEnabled) {
    const subs = await visibleSubs(gc, user.id);
    const byId = new Map(subs.map((s) => [s.id, s]));
    const startMs = tz.toUtc({ ...tz.parseDate(from) }, cfg.tz);
    const endMs = tz.toUtc({ ...tz.parseDate(tz.addDays(to, 1)) }, cfg.tz);
    for (const e of await store.eventsBetween(gc, subs.map((s) => s.id), startMs, endMs, 2000)) {
      const s = byId.get(e.sub_id);
      const lastDay = e.all_day && e.end_date ? tz.addDays(e.end_date, -1) : (e.all_day ? e.date : tz.localDate(Math.max(e.start_ms, e.end_ms - 1), cfg.tz));
      events.push({
        id: `${e.sub_id}:${crypto.createHash('sha1').update(String(e.ikey)).digest('hex').slice(0, 16)}`,
        title: e.title, date: e.date,
        time: e.all_day ? null : format.time(e.start_ms, cfg.tz),
        endTime: e.all_day || e.end_ms <= e.start_ms ? null : format.time(e.end_ms, cfg.tz),
        allDay: e.all_day,
        calendar: { id: s.id, name: s.name, color: s.color },
        endDate: lastDay > e.date ? lastDay : null,
        location: e.location || null,
      });
    }
  }
  const waste = [];
  if (cfg.wasteEnabled) {
    const plans = await visiblePlans(gc, user.id);
    const want = new Map(plans.map((p) => [p.id, p]));
    const byKey = new Map();
    for (const r of await store.datesBetween(gc, null, from, to)) {
      if (!want.has(r.plan_id) || r.hidden) continue;
      const key = `${r.plan_id}|${r.date}`;
      let day = byKey.get(key);
      if (!day) {
        const p = want.get(r.plan_id);
        day = { date: r.date, kinds: [], color: null, plan: { id: p.id, name: p.name }, fractions: [] };
        byKey.set(key, day);
        waste.push(day);
      }
      const f = fractions.present({ id: r.fraction_id, source_name: r.source_name, type: r.type, name: r.name, color: r.color || null, hidden: r.hidden });
      day.kinds.push(f.name);
      day.fractions.push({ name: f.name, type: f.type, color: f.color });
      if (!day.color) day.color = f.color;
    }
    waste.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.plan.id - b.plan.id));
  }
  return { events, waste };
}

// ─── Portal Start tiles and search (declarative; the host renders them) ──

const ICON_WASTE = 'M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3';
const ICON_CAL = 'M4 5h16v15H4zM4 10h16M8 3v4M16 3v4';

async function tiles(gc, user, lang, cfg, now) {
  const out = [];
  const plans = await portalWaste(gc, user, cfg, lang, now, 1);
  for (const p of plans.slice(0, 3)) {
    const next = p.days[0];
    const title = plans.length > 1 ? `${t(lang, 'tile.waste')} · ${p.name}` : t(lang, 'tile.waste');
    if (!next) { out.push({ section: 'waste', title, value: t(lang, 'tile.waste_none'), icon: ICON_WASTE }); continue; }
    out.push({ section: 'waste', title, value: `${next.label} · ${next.fractions.map((f) => f.name).join(', ')}`, state: next.rel ? 'on' : null, icon: ICON_WASTE });
  }
  if (cfg.calendarEnabled) {
    const subs = await visibleSubs(gc, user.id);
    if (subs.length) {
      const today = tz.localDate(now, cfg.tz);
      const end = tz.toUtc({ ...tz.parseDate(tz.addDays(today, 1)) }, cfg.tz);
      const todays = await store.eventsBetween(gc, subs.map((s) => s.id), now, end, 100);
      const count = todays.length === 1 ? t(lang, 'tile.one_event') : t(lang, 'tile.events', { n: todays.length });
      let value = todays.length ? count : t(lang, 'tile.no_events');
      if (user.loggedIn === true) {
        const next = todays.find((e) => !e.all_day && e.start_ms >= now) || todays.find((e) => !e.all_day);
        if (next) value += ` · ${t(lang, 'tile.next', { time: format.time(next.start_ms, cfg.tz), title: next.title })}`;
      }
      out.push({ section: 'calendar', title: t(lang, 'tile.today'), value, state: todays.length ? 'on' : null, icon: ICON_CAL });
    }
  }
  return out.slice(0, 8);
}

// ─── Module ─────────────────────────────────────

const state = { started: false, ticking: false };
const TICK_BUDGET_MS = 50000;

module.exports = {
  async start(gc) {
    alerts.reset();
    state.started = true;
    gc.log.info('alltag started', gc.plugin.version);
  },

  async request(req, gc) {
    const lang = req.lang;
    try {
      const seg = String(req.path || '/').split('/').filter(Boolean);
      if (!seg.length) throw fail('NOT_FOUND');
      const cfg = { ...(await config.load(gc)), uiLang: lang === 'en' ? 'en' : 'de' };
      if (seg[0] === 'app') {
        // the GateControl app only (the token owner as viewer, app: true)
        if (!req.user || !Number.isInteger(req.user.id) || req.user.app !== true) throw fail('FORBIDDEN');
        if (req.method !== 'GET' || seg.length !== 2 || seg[1] !== 'events') throw fail('NOT_FOUND');
        return { json: { ok: true, ...(await appEvents(gc, req.user, req.query, cfg, Date.now())) } };
      }
      if (seg[0] === 'portal') {
        if (!req.user || !Number.isInteger(req.user.id)) throw fail('FORBIDDEN');
        return await portalRoute(req, gc, seg, cfg);
      }
      // admin API: administrators only, never a portal or app viewer
      if (!req.user || req.user.portal || req.user.app || req.user.role !== 'admin') throw fail('FORBIDDEN');
      return await adminRoute(req, gc, seg, cfg);
    } catch (e) {
      if (!ERRORS[e && e.code]) gc.log.warn('request failed', req.method, String(req.path || '').split('/').slice(0, 3).join('/'), (e && e.code) || 'error');
      return errorResponse(e, lang);
    }
  },

  async render(view, gc) {
    return { html: ui.render(view, t) };
  },

  /** Sections in "Zuhause" only for viewers with something to see (no own tab). */
  async portalVisible({ user, section }, gc) {
    if (!user || !section) return false;
    const cfg = await config.load(gc);
    if (section === 'waste') return cfg.wasteEnabled && (await visiblePlans(gc, user.id)).length > 0;
    if (section === 'calendar') return cfg.calendarEnabled && (await visibleSubs(gc, user.id)).length > 0;
    return false;
  },

  /** Start tab: next pickup per plan; today's events (titles only after a real login). */
  async portalTiles({ user, lang }, gc) {
    if (!user) return [];
    return tiles(gc, user, lang, await config.load(gc), Date.now());
  },

  /** Portal search: titles of the viewer's upcoming events (real login only). */
  async portalSearch({ user, lang, q }, gc) {
    if (!user || user.loggedIn !== true || typeof q !== 'string' || q.length < 2) return [];
    const cfg = await config.load(gc);
    if (!cfg.calendarEnabled) return [];
    const subs = await visibleSubs(gc, user.id);
    if (!subs.length) return [];
    const now = Date.now();
    const byId = new Map(subs.map((s) => [s.id, s]));
    const needle = q.toLowerCase();
    const today = tz.localDate(now, cfg.tz);
    const list = await store.eventsBetween(gc, subs.map((s) => s.id), now, now + calendar.AHEAD_MS, 2000);
    return list.filter((e) => e.title.toLowerCase().includes(needle) || (e.location && e.location.toLowerCase().includes(needle))).slice(0, 10)
      .map((e) => ({
        title: e.title,
        subtitle: [format.cap(format.rel(e.date, today, lang)), e.all_day ? t(lang, 'portal.all_day') : format.time(e.start_ms, cfg.tz), byId.get(e.sub_id).name].join(' · '),
        section: 'calendar',
      }));
  },

  /**
   * Background (every minute): reminders first, then the refreshes that are
   * due — none started after 50 s, so a slow provider never runs the tick
   * into the host's 120 s limit; an overlapping run is skipped.
   */
  async tick(gc) {
    if (state.ticking) return;
    state.ticking = true;
    try {
      const deadline = Date.now() + TICK_BUDGET_MS;
      const cfg = await config.load(gc);
      try { await alerts.check(gc); } catch { /* logged in check */ }
      if (cfg.wasteEnabled) await waste.tick(gc, cfg, Date.now(), deadline);
      if (cfg.calendarEnabled) await calendar.tick(gc, cfg, Date.now(), deadline);
    } finally { state.ticking = false; }
  },

  async settingsChanged(values, gc) {
    // the time zone or reminder times changed: refresh the local sources so dates follow the zone
    for (const p of await store.listPlans(gc)) if (p.source !== 'provider') await store.updatePlan(gc, p.id, { next_refresh_at: 0 });
    for (const s of await store.listSubs(gc)) await store.updateSub(gc, s.id, { last_parsed_at: null, next_refresh_at: 0 });
  },

  _state: state,
};
