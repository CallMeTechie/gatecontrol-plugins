'use strict';

// The plugin settings (plugin.json ui.settings), checked: an invalid value
// falls back to its default and is named in `problems` (the admin page shows
// them). Undeclared keys of gc.settings.all() (the account secrets) are
// ignored here and never leave the plugin.

const tz = require('./tz');

const DEFAULTS = Object.freeze({
  timezone: 'Europe/Berlin',
  notify_lang: 'de',
  poll_minutes: 15,
  notify_days: 2,
  quiet_from: '21:00',
  quiet_to: '06:00',
  reminder_time: '18:00',
  self_link: true,
});

function int(v, min, max, d) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\s*\d{1,4}\s*$/.test(v) ? Number(v) : NaN);
  return Number.isInteger(n) && n >= min && n <= max ? n : d;
}

/** settings (gc.settings.all()) → the config used everywhere. */
function fromSettings(s) {
  const v = s || {};
  const problems = [];
  const zone = typeof v.timezone === 'string' && v.timezone.trim() ? v.timezone.trim() : DEFAULTS.timezone;
  const zoneOk = tz.valid(zone);
  if (!zoneOk) problems.push('timezone');
  const poll = int(v.poll_minutes, 5, 120, null);
  if (poll == null && v.poll_minutes != null && v.poll_minutes !== '') problems.push('poll_minutes');
  const days = int(v.notify_days, 1, 7, null);
  if (days == null && v.notify_days != null && v.notify_days !== '') problems.push('notify_days');
  // quiet hours: both empty = none; one of them invalid = the defaults
  const qf = v.quiet_from == null ? DEFAULTS.quiet_from : String(v.quiet_from).trim();
  const qt = v.quiet_to == null ? DEFAULTS.quiet_to : String(v.quiet_to).trim();
  let quiet = null;
  if (qf !== '' || qt !== '') {
    const a = tz.parseTime(qf);
    const b = tz.parseTime(qt);
    if (a && b) quiet = { from: a, to: b };
    else {
      problems.push('quiet');
      quiet = { from: tz.parseTime(DEFAULTS.quiet_from), to: tz.parseTime(DEFAULTS.quiet_to) };
    }
  }
  // 1.2.0: the evening reminder of tomorrow's exams and homework; empty = none
  const rt = v.reminder_time == null ? DEFAULTS.reminder_time : String(v.reminder_time).trim();
  let reminder = null;
  if (rt !== '') {
    reminder = tz.parseTime(rt);
    if (!reminder) {
      problems.push('reminder_time');
      reminder = tz.parseTime(DEFAULTS.reminder_time);
    }
  }
  return {
    tz: zoneOk ? zone : DEFAULTS.timezone,
    reminder,
    lang: v.notify_lang === 'en' ? 'en' : 'de',
    pollMinutes: poll == null ? DEFAULTS.poll_minutes : poll,
    notifyDays: days == null ? DEFAULTS.notify_days : days,
    quiet,
    // 1.3.0: people may link their own WebUntis student account in their GateControl profile
    selfLink: v.self_link == null ? DEFAULTS.self_link : v.self_link === true || v.self_link === 'true',
    problems,
  };
}

async function load(gc) {
  let s = {};
  try { s = await gc.settings.all(); } catch { /* defaults */ }
  return fromSettings(s);
}

const hhmm = (t) => (t ? `${tz.pad(t.hh)}:${tz.pad(t.mm)}` : null);

/** Is `ms` within the quiet hours of `cfg` (from ≤ t < to, over midnight when from > to)? */
function inQuiet(cfg, ms) {
  if (!cfg.quiet) return false;
  const p = tz.parts(ms, cfg.tz);
  const m = p.hh * 60 + p.mm;
  const a = cfg.quiet.from.hh * 60 + cfg.quiet.from.mm;
  const b = cfg.quiet.to.hh * 60 + cfg.quiet.to.mm;
  if (a === b) return false;
  return a < b ? m >= a && m < b : m >= a || m < b;
}

module.exports = { DEFAULTS, fromSettings, load, hhmm, inQuiet };
