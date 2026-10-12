'use strict';

// Reminders (plugin.json notifyTopics), checked by the background run every
// minute from what is already stored — no extra requests:
//
//   waste     per plan (Abfuhrplan, migrations/002): the main reminder 0–3
//             days before the pickup at HH:MM ("Heute: …", "Morgen: …",
//             "Übermorgen: …", "Am Do, 15.10.: …") or none, and optionally a
//             second one on the pickup day ("Heute: …"). A plan without its
//             own setting (the plans of 1.0.0 until they are edited) uses the
//             plugin settings: the evening before at waste_evening_time and,
//             with waste_morning, on the day at waste_morning_time. One per
//             plan, pickup day and kind (main / pickup day): changing a plan's
//             reminder never repeats one already sent for that day. Collapse
//             key waste:<plan>:<date> (the pickup-day one replaces the main
//             one); to the plan's people (users) or, without a list, the
//             topic's subscribers.
//   calendar  per subscription: at the start or 10/15/30/60 minutes before
//             a timed event, all-day events in the morning (default 07:00);
//             collapse key per event instance; only to the subscription's
//             people.
//
// Every possible reminder is an observation { key, due, expires }. The pure
// evaluate() sends what is due and not expired yet and remembers it in
// gc.storage (notify.state): a restart neither repeats a reminder nor loses
// one that fell into the downtime (as long as it is still useful). The very
// first run only records what is already due — installing the plugin at
// 18:05 does not announce the 18:00 reminder. A reminder that was already due
// at the previous check without being sent (a plan created or its reminder
// changed afterwards, new dates from the provider) is "late": per plan only
// the one of the nearest pickup goes out, the others are recorded — editing
// a plan never sends a flood of past reminders. A reminder held back by the
// hourly budget is tried again while it is still due.

const crypto = require('node:crypto');
const tz = require('./tz');
const store = require('./store');
const notify = require('./notify');
const config = require('./config');
const format = require('./format');
const waste = require('./waste');
const calendar = require('./calendar');

const STATE_KEY = 'notify.state';
const MIN = 60000;
const DAY = 86400000;

const TEXTS = {
  de: {
    'waste.today': 'Heute: {{list}}',
    'waste.tomorrow': 'Morgen: {{list}}',
    'waste.in2': 'Übermorgen: {{list}}',
    'waste.on': 'Am {{date}}: {{list}}',
    'waste.body': '{{plan}} · {{date}}',
    'waste.body_one': 'Abfuhr am {{date}}',
    'cal.in': 'In {{min}} Minuten · {{time}}',
    'cal.now': 'Jetzt · {{time}}',
    'cal.allday': 'Heute · ganztägig',
    'cal.allday_days': 'Ab heute · {{days}} Tage',
    'fact.fractions': 'Abfuhr',
    'fact.plan': 'Abfuhrplan',
    'fact.date': 'Datum',
    'fact.calendar': 'Kalender',
    'fact.time': 'Zeit',
    'fact.location': 'Ort',
    'test.prefix': 'Test – ',
    'test.waste_none': 'Gelber Sack, Papier',
    'test.cal_title': 'Beispieltermin',
  },
  en: {
    'waste.today': 'Today: {{list}}',
    'waste.tomorrow': 'Tomorrow: {{list}}',
    'waste.in2': 'Day after tomorrow: {{list}}',
    'waste.on': 'On {{date}}: {{list}}',
    'waste.body': '{{plan}} · {{date}}',
    'waste.body_one': 'Collection on {{date}}',
    'cal.in': 'In {{min}} minutes · {{time}}',
    'cal.now': 'Now · {{time}}',
    'cal.allday': 'Today · all day',
    'cal.allday_days': 'From today · {{days}} days',
    'fact.fractions': 'Collection',
    'fact.plan': 'Plan',
    'fact.date': 'Date',
    'fact.calendar': 'Calendar',
    'fact.time': 'Time',
    'fact.location': 'Location',
    'test.prefix': 'Test – ',
    'test.waste_none': 'Yellow bag, paper',
    'test.cal_title': 'Sample event',
  },
};

const hash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
const fmtDay = (date, cfg) => format.dayShort(date, cfg.lang);
const fmtTime = (ms, cfg) => format.time(ms, cfg.tz);

// ─── Observations (what could be due) ───────────

const MAX_LEAD = 3; // days before the pickup

/**
 * The reminder a plan actually uses: its own fields, the plugin settings
 * for every field it leaves open (null). → { lead: 0–3 | null (none), time,
 * extra, extraTime, custom } with times as { hh, mm }.
 */
function reminderOf(plan, cfg) {
  const r = (plan && plan.reminder) || {};
  const lead = r.lead === 'off' ? null : (Number.isInteger(r.lead) && r.lead >= 0 && r.lead <= MAX_LEAD ? r.lead : 1);
  return {
    lead,
    time: tz.parseTime(r.time) || cfg.evening,
    extra: typeof r.extra === 'boolean' ? r.extra : !!cfg.morning,
    extraTime: tz.parseTime(r.extra_time) || cfg.morningTime,
    custom: r.lead != null || r.time != null || r.extra != null || r.extra_time != null,
  };
}

/**
 * When the reminders of one pickup day are due (pure): the main one
 * (kind 'e', `lead` days before at `time`; until the pickup day begins —
 * on the day itself until noon, at least 2 h) and the pickup-day one
 * (kind 'm', until noon, at least 2 h). The local wall clock of `zone`
 * (DST-correct: the date is counted in days, the time set on that day).
 * The kind letters are those of 1.0.0 (evening / morning), so a stored
 * state carries over.
 * @returns {Array<{ kind: 'e'|'m', due: number, expires: number }>}
 */
function wasteSchedule(date, rem, zone) {
  const out = [];
  const sameDay = (due) => Math.max(tz.at(date, { hh: 12, mm: 0 }, zone), due + 2 * 3600000);
  if (rem.lead != null) {
    const due = tz.at(tz.addDays(date, -rem.lead), rem.time, zone);
    out.push({ kind: 'e', due, expires: rem.lead ? tz.toUtc({ ...tz.parseDate(date) }, zone) : sameDay(due) });
  }
  if (rem.extra) {
    const due = tz.at(date, rem.extraTime, zone);
    out.push({ kind: 'm', due, expires: sameDay(due) });
  }
  return out;
}

/** Waste reminders of the plans' next pickups (today … MAX_LEAD days ahead). */
async function wasteObservations(gc, cfg, now) {
  if (!cfg.wasteEnabled) return [];
  const plans = (await store.listPlans(gc)).filter((p) => p.enabled);
  if (!plans.length) return [];
  const today = tz.localDate(now, cfg.tz);
  const upcoming = await waste.upcoming(gc, plans.map((p) => p.id), cfg, now, { days: MAX_LEAD, limit: MAX_LEAD + 1 });
  const out = [];
  for (const plan of plans) {
    const rem = reminderOf(plan, cfg);
    for (const day of upcoming.get(plan.id) || []) {
      if (day.date < today || !day.fractions.length) continue;
      const base = { kind: 'waste', group: `w:${plan.id}`, plan: { id: plan.id, name: plan.name, users: plan.users }, date: day.date, fractions: day.fractions.map((f) => ({ name: f.name, type: f.type })) };
      for (const s of wasteSchedule(day.date, rem, cfg.tz)) {
        out.push({ ...base, key: `w:${plan.id}:${day.date}:${s.kind}`, when: s.kind === 'm' ? 'pickup_day' : 'main', due: s.due, expires: s.expires });
      }
    }
  }
  return out;
}

/** Calendar reminders of the next two days. */
async function calendarObservations(gc, cfg, now) {
  if (!cfg.calendarEnabled) return [];
  const subs = (await store.listSubs(gc)).filter((s) => s.enabled && s.users.length);
  if (!subs.length) return [];
  const byId = new Map(subs.map((s) => [s.id, s]));
  const events = await store.eventsBetween(gc, subs.map((s) => s.id), now - DAY, now + 2 * DAY, 2000);
  const out = [];
  for (const e of events) {
    const sub = byId.get(e.sub_id);
    const base = { kind: 'calendar', sub: { id: sub.id, name: sub.name, users: sub.users }, event: { ikey: e.ikey, title: e.title, location: e.location || null, allDay: e.all_day, start: e.start_ms, end: e.end_ms, date: e.date, endDate: e.end_date } };
    if (e.all_day) {
      if (!sub.allday_reminder) continue;
      const due = tz.at(e.date, cfg.alldayTime, cfg.tz);
      out.push({ ...base, key: `c:${sub.id}:${hash(e.ikey)}:${due}`, lead: null, due, expires: tz.toUtc({ ...tz.parseDate(tz.addDays(e.date, 1)) }, cfg.tz) });
      continue;
    }
    if (!calendar.REMINDERS.includes(sub.reminder) || sub.reminder === 'off') continue;
    const lead = sub.reminder === 'start' ? 0 : Number(sub.reminder);
    const due = e.start_ms - lead * MIN;
    out.push({ ...base, key: `c:${sub.id}:${hash(e.ikey)}:${due}`, lead, due, expires: lead ? e.start_ms : e.start_ms + 15 * MIN });
  }
  return out;
}

async function observations(gc, cfg, now) {
  return [...(await wasteObservations(gc, cfg, now)), ...(await calendarObservations(gc, cfg, now))];
}

// ─── Pure transition logic ──────────────────────

/**
 * @param {object|null} prev  last stored state (null = first run)
 * @param {Array<{ key, kind, due, expires, group?, date? }>} observations
 * @param {{ wasteEnabled, calendarEnabled }} cfg
 * @param {number} now  ms
 * @returns {{ memo: { v, at, sent: { key: expires }, retry: { key: expires } }, events: Array }}
 *
 * An observation is announced once, when it is due and not expired. One
 * that was already due at the previous check (prev.at) and is neither sent
 * nor waiting for a retry is late — it was not there before (a new plan,
 * changed reminder settings, new dates). Late ones of a group (a plan) are
 * all recorded, but only one goes out: the nearest date, the latest due
 * time — and none when the group sends a regular one in this run.
 */
function evaluate(prev, observations, cfg, now) {
  const first = !prev || typeof prev.sent !== 'object' || prev.sent === null;
  const sent = {};
  const retry = {};
  // forget what expired more than a day ago
  if (!first) for (const [k, exp] of Object.entries(prev.sent)) if (Number(exp) + DAY > now) sent[k] = Number(exp);
  if (!first && prev.retry && typeof prev.retry === 'object') for (const [k, exp] of Object.entries(prev.retry)) if (Number(exp) > now) retry[k] = Number(exp);
  const last = !first && Number.isFinite(prev.at) && prev.at <= now ? prev.at : null;
  const events = [];
  const late = new Map(); // group → observations
  for (const o of observations || []) {
    if (!o || typeof o.key !== 'string') continue;
    if (o.kind === 'waste' && !cfg.wasteEnabled) continue;
    if (o.kind === 'calendar' && !cfg.calendarEnabled) continue;
    if (sent[o.key] != null) continue;
    if (o.due > now || now >= o.expires) continue;
    sent[o.key] = o.expires;
    if (first) continue; // first run: already due = only recorded
    const isLate = o.group != null && last != null && o.due <= last && retry[o.key] == null;
    delete retry[o.key];
    if (!isLate) { events.push(o); continue; }
    if (!late.has(o.group)) late.set(o.group, []);
    late.get(o.group).push(o);
  }
  for (const [group, list] of late) {
    if (events.some((e) => e.group === group)) continue;
    const ord = (o) => (o.date != null ? String(o.date) : '');
    list.sort((a, b) => (ord(a) < ord(b) ? -1 : (ord(a) > ord(b) ? 1 : b.due - a.due)));
    events.push(list[0]);
  }
  return { memo: { v: 2, at: now, sent, retry }, events };
}

// ─── Notifications ──────────────────────────────

/** Observation → gc.notify payload. */
function toNotification(gc, o, cfg, now, { test = false } = {}) {
  const lang = cfg.lang;
  const tx = (k, p) => notify.fmt(TEXTS, lang, k, p);
  const pre = test ? tx('test.prefix') : '';
  const base = notify.openAction(gc, lang);
  const ttl = (exp) => Math.max(60, Math.min(30 * 86400, Math.round((exp - now) / 1000)));
  if (o.kind === 'waste') {
    const list = o.fractions.map((f) => f.name).join(', ');
    const ahead = tz.diffDays(tz.localDate(now, cfg.tz), o.date);
    const key = ahead <= 0 ? 'waste.today' : (ahead === 1 ? 'waste.tomorrow' : (ahead === 2 ? 'waste.in2' : 'waste.on'));
    const day = fmtDay(o.date, cfg);
    const facts = [{ label: tx('fact.fractions'), value: list.slice(0, 120) }, { label: tx('fact.plan'), value: o.plan.name.slice(0, 120) }, { label: tx('fact.date'), value: day }];
    return {
      topic: 'waste', title: (pre + tx(key, { list, date: day })).slice(0, 120), body: tx('waste.body', { plan: o.plan.name, date: day }),
      priority: 'normal', users: o.plan.users && o.plan.users.length ? o.plan.users : null,
      collapseKey: `waste:${o.plan.id}:${o.date}`, ttl: ttl(o.expires + 6 * 3600000),
      data: { ...base, plan_id: o.plan.id, date: o.date, facts },
    };
  }
  const e = o.event;
  const time = e.allDay ? null : `${fmtTime(e.start, cfg)}${e.end > e.start ? '–' + fmtTime(e.end, cfg) : ''}`;
  let body;
  if (e.allDay) {
    const days = e.endDate ? tz.diffDays(e.date, e.endDate) : 1;
    body = days > 1 ? tx('cal.allday_days', { days }) : tx('cal.allday');
  } else body = o.lead ? tx('cal.in', { min: o.lead, time }) : tx('cal.now', { time });
  if (e.location) body += ` · ${e.location}`;
  const facts = [{ label: tx('fact.calendar'), value: o.sub.name.slice(0, 120) }];
  if (time) facts.push({ label: tx('fact.time'), value: time });
  if (e.location) facts.push({ label: tx('fact.location'), value: e.location.slice(0, 120) });
  return {
    topic: 'calendar', title: (pre + (e.title || '–')).slice(0, 120), body: body.slice(0, 1000), priority: 'normal',
    users: o.sub.users, collapseKey: `cal:${o.sub.id}:${hash(e.ikey)}`, ttl: ttl(Math.max(o.expires, e.end || 0)),
    data: { ...base, sub_id: o.sub.id, facts },
  };
}

// ─── Glue (one check at a time) ─────────────────

let notifier = null;
let chain = Promise.resolve();

function reset() { notifier = null; }
function notifierOf(gc) { if (!notifier) notifier = notify.createNotifier(gc); return notifier; }

const RETRY = new Set(['THROTTLED', 'ERR_RATE_LIMIT']);

/** Compare what is due with what was sent and send the rest. → number sent */
function check(gc, { now = Date.now() } = {}) {
  const run = async () => {
    const cfg = await config.load(gc);
    const obs = await observations(gc, cfg, now);
    const prev = await notify.loadState(gc, STATE_KEY);
    const { memo, events } = evaluate(prev, obs, cfg, now);
    let sent = 0;
    for (const ev of events) {
      // nobody assigned (a calendar, or a plan limited to an empty list): nobody gets it
      if (ev.kind === 'calendar' && !(ev.sub.users && ev.sub.users.length)) continue;
      if (ev.kind === 'waste' && Array.isArray(ev.plan.users) && !ev.plan.users.length) continue;
      const r = await notifierOf(gc).send(toNotification(gc, ev, cfg, now));
      if (r.sent) sent++;
      else if (RETRY.has(r.error)) { delete memo.sent[ev.key]; memo.retry[ev.key] = ev.expires; } // budget used up: again while still due
    }
    await notify.saveState(gc, STATE_KEY, memo, prev ? JSON.stringify(prev) : null);
    return sent;
  };
  const p = chain.then(run, run);
  chain = p.catch((e) => { gc.log.warn('reminder check failed', (e && e.code) || (e && e.message)); });
  return p;
}

/** "Test-Erinnerung senden": one sample reminder of the area to the requesting administrator. */
async function sendTest(gc, area, userId, { now = Date.now() } = {}) {
  const cfg = await config.load(gc);
  let o;
  if (area === 'waste') {
    const plans = (await store.listPlans(gc)).filter((p) => p.enabled);
    const up = plans.length ? await waste.upcoming(gc, [plans[0].id], cfg, now, { days: 60, limit: 1 }) : new Map();
    const next = plans.length ? (up.get(plans[0].id) || [])[0] : null;
    const tomorrow = tz.addDays(tz.localDate(now, cfg.tz), 1);
    o = {
      kind: 'waste', plan: { id: plans.length ? plans[0].id : 0, name: plans.length ? plans[0].name : 'Alltag', users: [userId] },
      date: next ? next.date : tomorrow, fractions: next ? next.fractions : [{ name: notify.fmt(TEXTS, cfg.lang, 'test.waste_none') }], expires: now + 3600000,
    };
  } else {
    const start = now + 15 * MIN;
    o = {
      kind: 'calendar', sub: { id: 0, name: 'Alltag', users: [userId] }, lead: 15, expires: start,
      event: { ikey: `test-${now}`, title: notify.fmt(TEXTS, cfg.lang, 'test.cal_title'), location: null, allDay: false, start, end: start + 3600000, date: tz.localDate(start, cfg.tz), endDate: null },
    };
  }
  const n = toNotification(gc, o, cfg, now, { test: true });
  n.users = [userId];
  n.collapseKey = `test:${area}`;
  return notifierOf(gc).send(n);
}

module.exports = { evaluate, reminderOf, wasteSchedule, MAX_LEAD, toNotification, observations, wasteObservations, calendarObservations, check, sendTest, reset, STATE_KEY, TEXTS };
