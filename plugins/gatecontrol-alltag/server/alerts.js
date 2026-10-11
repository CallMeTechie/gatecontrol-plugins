'use strict';

// Reminders (plugin.json notifyTopics), checked by the background run every
// minute from what is already stored — no extra requests:
//
//   waste     "Morgen: Gelber Sack, Papier" the evening before (default
//             18:00) and, when switched on, "Heute: …" on the morning of the
//             day (default 06:30); one per plan and day (collapse key
//             waste:<plan>:<date>, the morning one replaces the evening one);
//             to the plan's people (users) or, without a list, the topic's
//             subscribers.
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
// 18:05 does not announce the 18:00 reminder. A reminder held back by the
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
    'waste.on': '{{date}}: {{list}}',
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
    'waste.on': '{{date}}: {{list}}',
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

/** Waste reminders of the plans' next pickups (today … day after tomorrow). */
async function wasteObservations(gc, cfg, now) {
  if (!cfg.wasteEnabled) return [];
  const plans = (await store.listPlans(gc)).filter((p) => p.enabled);
  if (!plans.length) return [];
  const today = tz.localDate(now, cfg.tz);
  const upcoming = await waste.upcoming(gc, plans.map((p) => p.id), cfg, now, { days: 2, limit: 3 });
  const out = [];
  for (const plan of plans) {
    for (const day of upcoming.get(plan.id) || []) {
      if (day.date < today || !day.fractions.length) continue;
      const base = { kind: 'waste', plan: { id: plan.id, name: plan.name, users: plan.users }, date: day.date, fractions: day.fractions.map((f) => ({ name: f.name, type: f.type })) };
      const midnight = tz.toUtc({ ...tz.parseDate(day.date) }, cfg.tz);
      out.push({ ...base, key: `w:${plan.id}:${day.date}:e`, when: 'evening', due: tz.at(tz.addDays(day.date, -1), cfg.evening, cfg.tz), expires: midnight });
      if (cfg.morning) {
        const due = tz.at(day.date, cfg.morningTime, cfg.tz);
        out.push({ ...base, key: `w:${plan.id}:${day.date}:m`, when: 'morning', due, expires: Math.max(tz.at(day.date, { hh: 12, mm: 0 }, cfg.tz), due + 2 * 3600000) });
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
 * @param {Array<{ key, kind, due, expires }>} observations
 * @param {{ wasteEnabled, calendarEnabled }} cfg
 * @param {number} now  ms
 * @returns {{ memo: { v, at, sent: { key: expires } }, events: Array }}
 */
function evaluate(prev, observations, cfg, now) {
  const first = !prev || typeof prev.sent !== 'object' || prev.sent === null;
  const sent = {};
  // forget what expired more than a day ago
  if (!first) for (const [k, exp] of Object.entries(prev.sent)) if (Number(exp) + DAY > now) sent[k] = Number(exp);
  const events = [];
  for (const o of observations || []) {
    if (!o || typeof o.key !== 'string') continue;
    if (o.kind === 'waste' && !cfg.wasteEnabled) continue;
    if (o.kind === 'calendar' && !cfg.calendarEnabled) continue;
    if (sent[o.key] != null) continue;
    if (o.due > now || now >= o.expires) continue;
    sent[o.key] = o.expires;
    if (!first) events.push(o); // first run: already due = only recorded
  }
  return { memo: { v: 1, at: now, sent }, events };
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
    const today = tz.localDate(now, cfg.tz);
    const key = o.date === today ? 'waste.today' : (o.date === tz.addDays(today, 1) ? 'waste.tomorrow' : 'waste.on');
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
      else if (RETRY.has(r.error)) delete memo.sent[ev.key]; // budget used up: again while still due
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

module.exports = { evaluate, toNotification, observations, wasteObservations, calendarObservations, check, sendTest, reset, STATE_KEY, TEXTS };
