'use strict';

// Rules and reminders (1.9.0): the trigger 'schedule' and the conditions that
// need other plugins — read when a rule is about to run (never inside a
// transaction), and by the dry run („Probelauf“).
//
//   schedule  { weekdays: [1..7] (ISO, Monday = 1), time: 'HH:MM' } in the family's time
//             zone; fires once per day (last_key 'sched:<YYYY-MM-DD>'), up to 2 hours late
//             (the server was down) — never for a time that passed before the rule was saved.
//   device    [{ actionId: '<plugin>/<id>', field: 'value' | 'badge' | 'reading:<id>',
//             op: '<' | '<=' | '>' | '>=' | '=', value: number }] — the value of another
//             plugin's quick action widget as the rule's owner sees it (GateControl ≥ 1.181.0:
//             gc.actions.get / gc.actions.list with withWidget); the number is taken from the
//             field („32 %“ → 32). Unknown (an older GateControl, the action gone, no number) =
//             not met, with the reason in the rule log.
//   calendar  { dayOffset: 0 | 1, sources: ['familie' | 'alltag' | 'alltag:<subId>'], match,
//             memberIds? } — an event today / tomorrow whose title contains `match` (ignoring
//             case; empty = any event): Familie's dates (memberIds: only dates of those people
//             or of the whole family) and the Alltag calendars the owner sees (service
//             gatecontrol-alltag:calendar_query, GateControl ≥ 1.177.0).
//
// Every check answers { kind, ok, known, text, facts } — text in the notification
// language for the log and the dry run; facts ({ label, value }) for a notification
// with `facts: true`.

const tz = require('./tz');
const dates = require('./dates');
const format = require('./format');
const sun = require('./sun');
const texts = require('./texts.json');
const { TIME_RE } = require('./util');

const OPS = ['<', '<=', '>', '>=', '='];
const FIELD_RE = /^(?:value|badge|reading:[A-Za-z0-9_.-]{1,32})$/;
const ACTION_REF_RE = /^([a-z0-9]+(?:-[a-z0-9]+)*)\/([A-Za-z0-9:._-]{1,64})$/;
const SOURCE_RE = /^(?:familie|alltag|alltag:\d{1,9})$/;
const ALLTAG = 'gatecontrol-alltag';
const CATCH_UP_MS = 2 * 3600000;
const MATCH_MAX = 60;
const DEVICES_MAX = 4;
const SOURCES_MAX = 10;

const say = (lang, key, params) => {
  const l = lang === 'en' ? 'en' : 'de';
  let s = (texts[l] && texts[l][key]) || texts.de[key] || key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{{${k}}}`).join(String(v));
  return s;
};

// ─── feature detection ──────────────────────────

/** GateControl ≥ 1.181.0: gc.actions.get (and with it widgets in gc.actions.list, push callbacks, notifyAction). */
const hasGet = (gc) => !!(gc && gc.actions && typeof gc.actions.get === 'function');
const hasList = (gc) => !!(gc && gc.actions && typeof gc.actions.list === 'function');
const hasServices = (gc) => !!(gc && gc.services && typeof gc.services.call === 'function');

// ─── schedule ───────────────────────────────────

/** ISO weekday of a local date: 1 = Monday … 7 = Sunday. */
const isoWd = (d) => ((tz.weekday(d) + 6) % 7) + 1;

/** { weekdays, time } → the checked schedule, or null (invalid). */
function parseSchedule(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const w = v.weekdays;
  if (!Array.isArray(w) || !w.length || w.length > 7 || !w.every((x) => Number.isInteger(x) && x >= 1 && x <= 7)) return null;
  if (typeof v.time !== 'string' || !TIME_RE.test(v.time)) return null;
  return { weekdays: [...new Set(w)].sort((a, b) => a - b), time: v.time };
}

/** When the schedule fires on `date` (ms), or null when that day is not one of its weekdays. */
function scheduledAt(s, date, zone) {
  if (!s || !s.weekdays.includes(isoWd(date))) return null;
  return tz.at(date, tz.parseTime(s.time), zone);
}

/** The key of a due run now ('sched:<date>'), or null: the time has come today and is at most 2 hours ago. */
function dueKey(s, now, zone) {
  const today = tz.localDate(now, zone);
  const at = scheduledAt(s, today, zone);
  if (at == null || now < at || now - at > CATCH_UP_MS) return null;
  return `sched:${today}`;
}

/** The key that a rule saved now starts with: today's run when its time already passed (so it does not fire at once). */
function initialKey(s, now, zone) {
  const today = tz.localDate(now, zone);
  const at = scheduledAt(s, today, zone);
  return at != null && now >= at ? `sched:${today}` : null;
}

/** The next day on or after `from` the schedule fires (within a week), or null. */
function nextDay(s, from) {
  let d = from;
  for (let i = 0; i < 8; i++) { if (s.weekdays.includes(isoWd(d))) return d; d = tz.addDays(d, 1); }
  return null;
}

// ─── the conditions of the rule itself ──────────

/** Local "HH:MM" in the window (from inclusive, to exclusive; may span midnight); no window → true. */
function inWindow(hm, w) {
  if (!w) return true;
  return w.from < w.to ? hm >= w.from && hm < w.to : hm >= w.from || hm < w.to;
}

/** The time window and „after sunset“ at `now` (sunset is ignored without the home's location). */
function syncHold(rule, cfg, now) {
  const p = tz.parts(now, cfg.tz);
  const c = rule.conditions || {};
  if (!inWindow(`${tz.pad(p.hh)}:${tz.pad(p.mm)}`, c.time)) return false;
  if (c.afterSunset && cfg.location && !sun.isDown(now, cfg.location.lat, cfg.location.lon)) return false;
  return true;
}

// ─── parsing (the rule API) ─────────────────────

class Bad extends Error { constructor(field) { super('invalid'); this.field = field; } }

/** device conditions → the checked list (≤ 4) or throws Bad(field). */
function parseDevice(v) {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > DEVICES_MAX) throw new Bad('conditions.device');
  return v.map((c, i) => {
    const at = `conditions.device.${i}`;
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Bad(at);
    const ref = typeof c.actionId === 'string' ? c.actionId : (typeof c.plugin === 'string' && typeof c.id === 'string' ? `${c.plugin}/${c.id}` : '');
    if (!ACTION_REF_RE.test(ref) || ref.startsWith('gatecontrol-familie/')) throw new Bad(`${at}.actionId`);
    const field = c.field == null ? 'value' : c.field;
    if (typeof field !== 'string' || !FIELD_RE.test(field)) throw new Bad(`${at}.field`);
    if (!OPS.includes(c.op)) throw new Bad(`${at}.op`);
    if (typeof c.value !== 'number' || !Number.isFinite(c.value) || Math.abs(c.value) > 1e9) throw new Bad(`${at}.value`);
    const label = typeof c.label === 'string' ? c.label.replace(/[\0-\x1f\x7f]/g, ' ').trim().slice(0, 60) || null : null;
    const unit = typeof c.unit === 'string' ? c.unit.replace(/[\0-\x1f\x7f]/g, ' ').trim().slice(0, 8) || null : null;
    return { actionId: ref, field, op: c.op, value: c.value, label, unit };
  });
}

/** calendar condition → the checked one, null, or throws Bad(field). memberIds are checked by the caller. */
function parseCalendar(v) {
  if (v == null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw new Bad('conditions.calendar');
  const dayOffset = v.dayOffset == null ? 0 : v.dayOffset;
  if (dayOffset !== 0 && dayOffset !== 1) throw new Bad('conditions.calendar.dayOffset');
  const sources = v.sources == null ? ['familie'] : v.sources;
  if (!Array.isArray(sources) || !sources.length || sources.length > SOURCES_MAX || !sources.every((s) => typeof s === 'string' && SOURCE_RE.test(s))) throw new Bad('conditions.calendar.sources');
  let match = '';
  if (v.match != null) {
    if (typeof v.match !== 'string') throw new Bad('conditions.calendar.match');
    match = v.match.replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (match.length > MATCH_MAX) throw new Bad('conditions.calendar.match');
  }
  let memberIds = null;
  if (v.memberIds != null) {
    if (!Array.isArray(v.memberIds) || v.memberIds.length > 50 || !v.memberIds.every((x) => Number.isSafeInteger(x) && x > 0)) throw new Bad('conditions.calendar.memberIds');
    memberIds = [...new Set(v.memberIds)];
  }
  return { dayOffset, sources: [...new Set(sources)], match, memberIds: memberIds && memberIds.length ? memberIds : null };
}

// ─── device values ──────────────────────────────

/** A number in a value: 32 → 32, "32 %" → 32, "-3,5 °C" → -3.5; anything else → null. */
function numberOf(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const m = /-?\d+(?:[.,]\d+)?/.exec(v.replace(/−/g, '-'));
  return m ? Number(m[0].replace(',', '.')) : null;
}

/** One field of a widget → { raw, unit, label } or null. */
function fieldOf(widget, field) {
  if (!widget || typeof widget !== 'object') return null;
  if (field === 'value') return widget.value == null ? null : { raw: widget.value, unit: widget.unit || null, label: widget.label || null };
  if (field === 'badge') {
    const b = widget.badge;
    if (b == null) return null;
    if (typeof b === 'object') return b.value == null ? null : { raw: b.value, unit: b.unit || null, label: b.label || null };
    return { raw: b, unit: null, label: null };
  }
  const id = field.slice('reading:'.length);
  const r = Array.isArray(widget.readings) ? widget.readings.find((x) => x && x.id === id) : null;
  return r && r.value != null ? { raw: r.value, unit: r.unit || null, label: r.label || null } : null;
}

/** "32 %" — a value with its unit as people read it. */
function shown(raw, unit) {
  const s = typeof raw === 'number' ? String(Math.round(raw * 100) / 100) : String(raw);
  return unit && !s.endsWith(unit) ? `${s} ${unit}` : s;
}

/** The fields of a widget for the editor: [{ id, label, unit, current }] (only fields that carry a number). */
function widgetFields(widget, lang) {
  const out = [];
  if (!widget || typeof widget !== 'object') return out;
  const add = (id, f, label) => { if (f && numberOf(f.raw) != null) out.push({ id, label: (f.label || label).slice(0, 40), unit: f.unit || null, current: shown(f.raw, f.unit) }); };
  add('value', fieldOf(widget, 'value'), say(lang, 'cond.field_value'));
  add('badge', fieldOf(widget, 'badge'), say(lang, 'cond.field_badge'));
  for (const r of Array.isArray(widget.readings) ? widget.readings : []) {
    if (r && typeof r.id === 'string' && /^[A-Za-z0-9_.-]{1,32}$/.test(r.id)) add(`reading:${r.id}`, fieldOf(widget, `reading:${r.id}`), r.id);
  }
  return out;
}

const refOf = (a) => (a && typeof a.actionId === 'string' ? a.actionId : (a ? `${a.plugin}/${a.id}` : ''));

/**
 * The action `actionId` as `userId` sees it, with its widget — gc.actions.get (≥ 1.181.0), else
 * gc.actions.list with withWidget (an older host drops the option: no widget). cache: Map, per run.
 * → { action, error } (error: 'unavailable' | 'not_found' | 'error').
 */
async function actionWithWidget(gc, cache, userId, actionId, lang) {
  const key = `${userId}|${actionId}`;
  if (cache && cache.has(key)) return cache.get(key);
  let out;
  try {
    if (hasGet(gc)) {
      const a = await gc.actions.get({ userId, actionId, withWidget: true, lang });
      out = a ? { action: a, error: null } : { action: null, error: 'not_found' };
    } else if (hasList(gc)) {
      const lk = `list|${userId}`;
      let list = cache && cache.get(lk);
      if (!list) { list = await gc.actions.list({ userId, lang, withWidget: true }); if (cache) cache.set(lk, list); }
      const a = (Array.isArray(list) ? list : []).find((x) => refOf(x) === actionId) || null;
      out = a ? { action: a, error: null } : { action: null, error: 'not_found' };
    } else out = { action: null, error: 'unavailable' };
  } catch {
    out = { action: null, error: 'error' };
  }
  if (cache) cache.set(key, out);
  return out;
}

function compare(a, op, b) {
  if (op === '<') return a < b;
  if (op === '<=') return a <= b;
  if (op === '>') return a > b;
  if (op === '>=') return a >= b;
  return Math.abs(a - b) < 1e-9;
}

/** One device condition → { kind: 'device', ok, known, text, facts, value } */
async function checkDevice(gc, cache, ownerId, c, lang) {
  const { action, error } = await actionWithWidget(gc, cache, ownerId, c.actionId, lang);
  const name = (action && ((action.device && action.device.title) || action.title || action.label)) || c.label || c.actionId;
  const want = `${c.op} ${shown(c.value, c.unit)}`;
  if (!action) {
    return { kind: 'device', ok: false, known: false, text: say(lang, error === 'unavailable' ? 'cond.device_unavailable' : 'cond.device_gone', { name }), facts: [], value: null };
  }
  const f = fieldOf(action.widget, c.field);
  const n = f ? numberOf(f.raw) : null;
  if (n == null) {
    const key = !action.widget && !hasGet(gc) ? 'cond.device_old' : 'cond.device_unknown';
    return { kind: 'device', ok: false, known: false, text: say(lang, key, { name, want }), facts: [], value: null };
  }
  const unit = f.unit || c.unit;
  const now = shown(f.raw, f.unit);
  const ok = compare(n, c.op, c.value);
  const label = f.label || c.label || name;
  return {
    kind: 'device', ok, known: true, text: say(lang, ok ? 'cond.device_ok' : 'cond.device_no', { name, now, want: `${c.op} ${shown(c.value, unit)}` }),
    facts: [{ label: String(label).slice(0, 40), value: now.slice(0, 120) }], value: now, device: name,
  };
}

// ─── calendar ───────────────────────────────────

/** "Mo 07:30" / "ganztägig" in the notification language. */
function whenText(date, time, today, lang) {
  const d = format.rel(date, today, lang);
  return time ? `${d} ${time}` : `${d} · ${say(lang, 'cond.all_day')}`;
}

/** Familie's dates on `day` matching the condition → [{ title, date, time, source }] */
async function familieEvents(gc, fam, cfg, day, c) {
  if (!cfg.modules.dates) return [];
  const needle = c.match.toLowerCase();
  return (await dates.between(gc, fam, day, day))
    .filter((e) => e.kind !== 'birthday' || needle)
    .filter((e) => !c.memberIds || !e.memberIds.length || e.memberIds.some((id) => c.memberIds.includes(id)))
    .filter((e) => !needle || String(e.title).toLowerCase().includes(needle))
    .map((e) => ({ title: e.title, date: e.date < day ? day : e.date, time: e.allDay ? null : e.time, source: 'familie' }));
}

/** Alltag's events on `day` (as `ownerId` sees them) → { events, error } */
async function alltagEvents(gc, ownerId, day, c, subIds) {
  if (!hasServices(gc)) return { events: [], error: 'unavailable' };
  try {
    const r = await gc.services.call({
      plugin: ALLTAG, service: 'calendar_query', userId: ownerId,
      payload: { from: day, to: day, match: c.match || undefined, ...(subIds ? { subIds } : {}) },
    });
    if (!r || r.ok !== true || !Array.isArray(r.events)) return { events: [], error: (r && typeof r.code === 'string' && /^[a-z_]{1,32}$/.test(r.code) ? r.code : 'failed') };
    return {
      events: r.events.filter((e) => e && typeof e.title === 'string').map((e) => ({
        title: e.title.slice(0, 80), date: typeof e.date === 'string' && e.date >= day ? e.date : day, time: e.allDay ? null : (typeof e.time === 'string' && TIME_RE.test(e.time) ? e.time : null),
        source: 'alltag', subName: typeof e.subName === 'string' ? e.subName.slice(0, 40) : null,
      })),
      error: null,
    };
  } catch (e) {
    const code = e && e.code;
    return { events: [], error: code === 'ERR_SERVICE_UNAVAILABLE' || code === 'ERR_SERVICES_DENIED' ? 'unavailable' : 'failed' };
  }
}

/** The calendar condition → { kind: 'calendar', ok, known, text, facts, event } */
async function checkCalendar(gc, fam, cfg, now, ownerId, c, lang) {
  const today = tz.localDate(now, cfg.tz);
  const day = tz.addDays(today, c.dayOffset);
  const found = [];
  let error = null;
  if (c.sources.includes('familie')) found.push(...await familieEvents(gc, fam, cfg, day, c));
  const all = c.sources.includes('alltag');
  const subIds = c.sources.filter((s) => s.startsWith('alltag:')).map((s) => Number(s.slice(7)));
  if (all || subIds.length) {
    const r = await alltagEvents(gc, ownerId, day, c, all ? null : subIds);
    found.push(...r.events);
    error = r.error;
  }
  found.sort((a, b) => String(a.time || '00:00').localeCompare(String(b.time || '00:00')));
  const dayWord = say(lang, c.dayOffset ? 'cond.tomorrow' : 'cond.today');
  const what = c.match ? say(lang, 'cond.cal_match', { match: c.match }) : say(lang, 'cond.cal_any');
  if (found.length) {
    const e = found[0];
    const when = whenText(e.date, e.time, today, lang);
    return {
      kind: 'calendar', ok: true, known: true, text: say(lang, 'cond.cal_ok', { when, title: e.title }),
      facts: [{ label: say(lang, 'cond.fact_event'), value: `${when} · ${e.title}`.slice(0, 120) }], event: { ...e, when },
    };
  }
  // nothing found, and a source could not be asked: unknown
  if (error) return { kind: 'calendar', ok: false, known: false, text: say(lang, 'cond.cal_unknown', { day: dayWord, what }), facts: [], event: null };
  return { kind: 'calendar', ok: false, known: true, text: say(lang, 'cond.cal_no', { day: dayWord, what }), facts: [], event: null };
}

/**
 * The conditions that need other plugins (device, calendar) of `rule` (owner: rule.ownerId) → { ok, checks, facts,
 * vars: { value, device, event } } — ok: all met (no such conditions → true).
 */
async function evaluate(gc, fam, cfg, now, rule, lang, cache) {
  const checks = [];
  const c = rule.conditions || {};
  for (const d of c.device || []) checks.push(await checkDevice(gc, cache || new Map(), rule.ownerId, d, lang));
  if (c.calendar) checks.push(await checkCalendar(gc, fam, cfg, now, rule.ownerId, c.calendar, lang));
  const firstDev = checks.find((x) => x.kind === 'device' && x.known);
  const cal = checks.find((x) => x.kind === 'calendar' && x.event);
  return {
    ok: checks.every((x) => x.ok), checks, facts: checks.flatMap((x) => x.facts).slice(0, 4),
    vars: { value: firstDev ? firstDev.value : '', device: firstDev ? firstDev.device : '', event: cal ? `${cal.event.when} ${cal.event.title}` : '' },
  };
}

/** Does the rule have conditions that need other plugins? */
const needsEvaluate = (rule) => !!(rule.conditions && ((rule.conditions.device && rule.conditions.device.length) || rule.conditions.calendar));

module.exports = {
  OPS, ALLTAG, CATCH_UP_MS, Bad, inWindow, syncHold, hasGet, hasList, hasServices, isoWd, parseSchedule, scheduledAt, dueKey, initialKey, nextDay,
  parseDevice, parseCalendar, numberOf, fieldOf, shown, widgetFields, actionWithWidget, refOf, checkDevice, checkCalendar, evaluate, needsEvaluate, say,
};
