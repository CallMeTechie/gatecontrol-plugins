'use strict';

// Dates and times as people read them: "heute", "morgen", "Mi, 15.10.",
// "14:30" (German) / "today", "tomorrow", "Wed 15 Oct", "14:30" (English).

const tz = require('./tz');

const WD = { de: ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'], en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] };
const MON_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const REL = { de: ['heute', 'morgen'], en: ['today', 'tomorrow'] };

const L = (lang) => (lang === 'en' ? 'en' : 'de');

/** "Mi, 15.10." / "Wed 15 Oct" */
function dayShort(date, lang) {
  const p = tz.parseDate(date);
  if (!p) return '';
  const wd = WD[L(lang)][tz.weekday(date)];
  return L(lang) === 'en' ? `${wd} ${p.d} ${MON_EN[p.m - 1]}` : `${wd}, ${tz.pad(p.d)}.${tz.pad(p.m)}.`;
}

/** "heute" / "morgen" / "Mi, 15.10." relative to `today`. */
function rel(date, today, lang) {
  if (date === today) return REL[L(lang)][0];
  if (date === tz.addDays(today, 1)) return REL[L(lang)][1];
  return dayShort(date, lang);
}

/** "heute" → "Heute" */
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

/** "14:30" in the zone. */
function time(ms, zone) {
  const p = tz.parts(ms, zone);
  return `${tz.pad(p.hh)}:${tz.pad(p.mm)}`;
}

module.exports = { dayShort, rel, cap, time };
