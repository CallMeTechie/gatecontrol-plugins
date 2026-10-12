'use strict';

// The plugin settings (plugin.json ui.settings), checked: an invalid time
// or zone falls back to its default (the admin page shows the problem).

const tz = require('./tz');

const DEFAULTS = Object.freeze({
  waste_enabled: true,
  calendar_enabled: true,
  timezone: 'Europe/Berlin',
  waste_evening_time: '18:00',
  waste_morning: false,
  waste_morning_time: '06:30',
  calendar_allday_time: '07:00',
  notify_lang: 'de',
});

function bool(v, d) { return typeof v === 'boolean' ? v : (v === 'true' ? true : (v === 'false' ? false : d)); }

/** settings (gc.settings.all()) → config used everywhere. */
function fromSettings(s) {
  const v = s || {};
  const problems = [];
  const zone = typeof v.timezone === 'string' && v.timezone.trim() ? v.timezone.trim() : DEFAULTS.timezone;
  const zoneOk = tz.valid(zone);
  if (!zoneOk) problems.push('timezone');
  const time = (key) => {
    const t = tz.parseTime(v[key]);
    if (!t && v[key] != null && v[key] !== '') problems.push(key);
    return t || tz.parseTime(DEFAULTS[key]);
  };
  return {
    wasteEnabled: bool(v.waste_enabled, DEFAULTS.waste_enabled),
    calendarEnabled: bool(v.calendar_enabled, DEFAULTS.calendar_enabled),
    tz: zoneOk ? zone : DEFAULTS.timezone,
    evening: time('waste_evening_time'),
    morning: bool(v.waste_morning, DEFAULTS.waste_morning),
    morningTime: time('waste_morning_time'),
    alldayTime: time('calendar_allday_time'),
    lang: v.notify_lang === 'en' ? 'en' : 'de',
    problems,
  };
}

async function load(gc) {
  let s = {};
  try { s = await gc.settings.all(); } catch { /* defaults */ }
  return fromSettings(s);
}

const hhmm = (t) => `${tz.pad(t.hh)}:${tz.pad(t.mm)}`;

module.exports = { DEFAULTS, fromSettings, load, hhmm };
