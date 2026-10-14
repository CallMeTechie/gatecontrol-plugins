'use strict';

// The wall tablet — "Wand-Tablet" (module wall, default off).
//
// A GateControl account created for a fixed tablet (e.g. "Küche") becomes a
// member with the role 'wall'. Its portal tab "Familie" is the wall view
// (server/index.js render → ui/wall.*), everything in one call:
//
//   GET wall   clock data, the family's avatars, "Heute" (today's and
//              tomorrow's dates, birthdays within 7 days, today's rides),
//              today's tasks with a chip per person, the open items of the
//              chosen shopping list (setting wall_list, page "Funktionen")
//
// A wall member is no family member: never listed, no pushes, no app tab.
// It may read me / wall / dates / rides / tasks / shopping, tick tasks off
// for the person whose task it is and add / check shopping items — nothing
// else (403 forbidden): no locating, SOS, places, emergency card, overview,
// no editing of tasks, dates or rides. Writes need a real portal login or a
// paired kiosk device (req.user.kiosk, 1.1.1 — server/kiosk.js); device
// trust only reads ("Nur lesen").

const tz = require('./tz');
const format = require('./format');
const dates = require('./dates');
const tasks = require('./tasks');
const shopping = require('./shopping');
const rides = require('./rides');
const { fail, iso } = require('./util');

const DARK_FROM = 21;
const DARK_UNTIL = 6;
const BIRTHDAY_DAYS = 7;
const MAX_ITEMS = 40;

/** May a wall member call this? [method, segments] */
function allowed(method, seg) {
  const [a, b, c] = seg;
  const n = seg.length;
  if (method === 'GET') return n === 1 && ['me', 'wall', 'dates', 'rides', 'tasks', 'shopping'].includes(a);
  if (method === 'POST') return (a === 'tasks' && n === 3 && c === 'done') || (a === 'shopping' && n === 2 && b === 'ops');
  return false;
}

/** The wall's own guard (before the normal dispatch): forbidden, then module_off. */
function guard(r, method, seg) {
  if (!allowed(method, seg)) throw fail('forbidden');
  if (!r.cfg.modules.wall) throw fail('module_off');
}

const isDark = (hh) => hh >= DARK_FROM || hh < DARK_UNTIL;

/** GET wall */
async function view(gc, r) {
  const mod = r.cfg.modules;
  if (!mod.wall) throw fail('module_off');
  const lang = r.cfg.lang;
  const p = tz.parts(r.now, r.cfg.tz);
  const tomorrow = tz.addDays(r.today, 1);
  const out = {
    now: iso(r.now), date: r.today, time: `${tz.pad(p.hh)}:${tz.pad(p.mm)}`, timezone: r.cfg.tz, dark: isDark(p.hh),
    dayLabel: format.dayShort(r.today, lang),
    members: r.fam.list.map((m) => ({ userId: m.userId, name: m.name, role: m.role, color: m.color })),
    modules: { tasks: !!mod.tasks, shopping: !!mod.shopping, dates: !!mod.dates, rides: !!mod.rides, stars: !!(mod.tasks && mod.stars) },
    today: null, tasks: null, shopping: null,
  };
  if (mod.dates || mod.rides) {
    const t = { dates: [], tomorrow: [], birthdays: [], rides: [] };
    if (mod.dates) {
      const list = await dates.between(gc, r.fam, r.today, tz.addDays(r.today, BIRTHDAY_DAYS));
      const on = (e, d) => e.date <= d && (e.endDate || e.date) >= d;
      t.dates = list.filter((e) => e.kind !== 'birthday' && on(e, r.today)).map(dateView);
      t.tomorrow = list.filter((e) => e.kind !== 'birthday' && e.date === tomorrow).map(dateView);
      t.birthdays = list.filter((e) => e.kind === 'birthday').map((e) => ({ title: e.title, date: e.date, years: e.years, inDays: tz.diffDays(r.today, e.date) }));
    }
    if (mod.rides) t.rides = await rides.today(gc, r);
    out.today = t;
  }
  if (mod.tasks) out.tasks = await tasks.forWall(gc, r);
  if (mod.shopping) {
    const s = await shopping.wallList(gc, r.cfg.wallList);
    out.shopping = { list: s.list, open: s.open, items: s.items.slice(0, MAX_ITEMS) };
  }
  return out;
}

function dateView(e) {
  return { id: e.id, title: e.title, date: e.date, time: e.time, endDate: e.endDate, allDay: e.allDay };
}

module.exports = { allowed, guard, view, isDark, DARK_FROM, DARK_UNTIL };
