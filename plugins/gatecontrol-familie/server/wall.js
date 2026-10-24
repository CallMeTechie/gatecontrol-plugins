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
//              chosen shopping list (setting wall_list, page "Funktionen");
//              1.2.0: today's meals (module meals) and, per member, home/away
//              (module presence, sharing members only, never for device trust alone —
//              null otherwise); 1.14.0: `wifi` — Wi-Fi shared from the Vault plugin („Freigabe auf
//              Wandtablet“, server/wifi.js) with its QR code, null without (or for device trust alone);
//              1.3.0: every member with its face (avatarUrl,
//              color, colorHex, initials) and presence 'home' | 'away' |
//              'unknown' | null — the ring of the avatar (refreshed with the poll);
//              1.13.0: `school` — the children's school day from the Schule plugin (service
//              school_day, cached 10 minutes per date in server/school.js): „Schule heute“, from
//              15:00 „Schule morgen“ — { day: 'today' | 'tomorrow', date, students: [{ userId, name,
//              start, end, cancelled, changed, holiday, exams: [{ subject, name }], free }] }, null
//              without the Schule plugin or without students to show
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
const meals = require('./meals');
const presence = require('./presence');
const members = require('./members');
const school = require('./school');
const wifi = require('./wifi');
const { fail, iso } = require('./util');

const DARK_FROM = 21;
const DARK_UNTIL = 6;
const BIRTHDAY_DAYS = 7;
const MAX_ITEMS = 40;
const SCHOOL_TOMORROW_FROM = 15;

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
    members: [],
    modules: { tasks: !!mod.tasks, shopping: !!mod.shopping, dates: !!mod.dates, rides: !!mod.rides, stars: !!(mod.tasks && mod.stars), meals: !!mod.meals, presence: !!mod.presence },
    today: null, tasks: null, shopping: null, meals: null, school: null, wifi: null,
  };
  // who is home: not for a viewer recognised only by device trust (like positions)
  const rings = await presence.rings(gc, r.fam, r.cfg, r.trustOnly);
  out.members = r.fam.list.map((m) => ({ userId: m.userId, name: m.name, role: m.role, ...members.faceOf(m), presence: rings.get(m.userId) || null }));
  if (mod.meals) out.meals = await meals.today(gc, r);
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
  // 1.13.0: the school day of the children (Schule plugin)
  out.school = await schoolDay(gc, r, p.hh >= SCHOOL_TOMORROW_FROM ? 'tomorrow' : 'today');
  // 1.14.0: Wi-Fi shared from Vault (a kiosk device or a signed-in wall account only)
  out.wifi = await wifi.forWall(gc, r);
  if (mod.tasks) out.tasks = await tasks.forWall(gc, r);
  if (mod.shopping) {
    const s = await shopping.wallList(gc, r.cfg.wallList);
    out.shopping = { list: s.list, open: s.open, items: s.items.slice(0, MAX_ITEMS) };
  }
  return out;
}

/**
 * „Schule heute“ / „Schule morgen“: the Schule plugin's day (names as the family knows them), or null.
 * 1.13.1: each child with its colour and picture — the Schule plugin's (≥ 1.3.0), else the member's
 * favourite colour and picture — and the member's initials, so the wall tells the children apart.
 */
async function schoolDay(gc, r, day) {
  const date = day === 'tomorrow' ? tz.addDays(r.today, 1) : r.today;
  let list = null;
  try { list = await school.dayFor(gc, date, r.now); } catch { list = null; }
  if (!list || !list.length) return null;
  return {
    day, date,
    students: list.map((s) => {
      const m = r.fam.byId.get(s.userId) || null;
      return {
        ...s, name: m ? m.name : s.name,
        color: s.color || (m && m.colorHex) || null, avatarUrl: s.avatarUrl || (m && m.avatarUrl) || null, initials: m ? m.initials : null,
      };
    }),
  };
}

function dateView(e) {
  return { id: e.id, title: e.title, date: e.date, time: e.time, endDate: e.endDate, allDay: e.allDay };
}

module.exports = { allowed, guard, view, isDark, DARK_FROM, DARK_UNTIL, SCHOOL_TOMORROW_FROM };
