'use strict';

// Test helpers: the mock host (tools/testing/mock-host.js) with a family
// (Anna and Marc parents, Lena 12 and Tim 9 children, Oma not a member, an
// administrator who is no member, Küche an account for a wall tablet — no
// member until a test adds it), callers as the app / the portal sees them,
// and a controllable clock (node:test mock timers, Date only).

const path = require('node:path');
const { mock } = require('node:test');
const { createHost } = require('../../../tools/testing/mock-host');
const tz = require('../server/tz');

const DIR = path.join(__dirname, '..');
const BERLIN = 'Europe/Berlin';
const ADMIN = { id: 1, name: 'admin', role: 'admin' };
const ANNA = { id: 2, name: 'Anna', role: 'user' };
const MARC = { id: 3, name: 'Marc', role: 'user' };
const LENA = { id: 4, name: 'Lena', role: 'user' };
const TIM = { id: 5, name: 'Tim', role: 'user' };
const OMA = { id: 6, name: 'Oma', role: 'user' };
const KUECHE = { id: 7, name: 'Küche', role: 'user' };
const USERS = [ADMIN, ANNA, MARC, LENA, TIM, OMA, KUECHE];

/** 2026-10-14 (Wednesday) 10:00 in Berlin (CEST, UTC+2) */
const T0 = Date.UTC(2026, 9, 14, 8, 0, 0);
const MIN = 60000;
const HOUR = 3600000;
const DAY = 86400000;

/** Years before the T0 date, e.g. birth(12) = '2014-10-14' minus a day: 12 years old. */
function birth(years, { daysAfterBirthday = 30 } = {}) {
  const d = tz.addDays('2026-10-14', -daysAfterBirthday);
  const p = tz.parseDate(d);
  return tz.dateStr(p.y - years, p.m, p.d);
}

/** Clock: mock Date at T0; clock.set(ms), clock.add(ms), clock.now(). */
function startClock(at = T0) {
  mock.timers.enable({ apis: ['Date'], now: at });
  let now = at;
  return {
    now: () => now,
    set(ms) { now = ms; mock.timers.setTime(ms); },
    add(ms) { now += ms; mock.timers.setTime(now); },
    stop() { mock.timers.reset(); },
  };
}

const app = (u) => ({ ...u, portal: true, loggedIn: true, app: true });
const portal = (u, loggedIn = true) => ({ ...u, portal: true, loggedIn });

/**
 * A host with the users above; family: true adds the family through the admin API.
 * fn(host, ctx) with ctx = { clock, call(user, method, path, body, query), admin(method, path, body, query) }
 */
async function withFamily(opts, fn) {
  const o = opts || {};
  const clock = startClock(o.at || T0);
  const host = await createHost(DIR, { users: USERS, settings: { timezone: BERLIN, ...(o.settings || {}) }, notifyFail: o.notifyFail });
  await host.start();
  const call = (user, method, p, body, query) => host.request({ method, path: p, body: body === undefined ? null : body, query: query || {}, user, lang: o.lang || 'de' });
  const admin = (method, p, body, query) => call(ADMIN, method, '/admin/' + p.replace(/^\//, ''), body, query);
  const ctx = { clock, call, admin, as: (u) => (method, p, body, query) => call(app(u), method, p, body, query) };
  try {
    if (o.family !== false) {
      for (const [u, body] of [
        [ANNA, { role: 'parent', birthdate: '1986-04-03' }],
        [MARC, { role: 'parent' }],
        [LENA, { role: 'child', birthdate: birth(12), locateMode: 'confirm', starGoal: 25 }],
        [TIM, { role: 'child', birthdate: birth(9), locateMode: 'auto' }],
      ]) {
        const r = await admin('POST', 'members', { userId: u.id, ...body });
        if (r.status !== 200) throw new Error('setup: ' + JSON.stringify(r.json));
      }
    }
    return await fn(host, ctx);
  } finally {
    await host.close();
    clock.stop();
  }
}

/** Notifications recorded by the mock host since index `from`, optionally of one type (data.familie.type). */
function pushes(host, type, from = 0) {
  return host.notifications.slice(from).filter((n) => !type || (n.data && n.data.familie && n.data.familie.type === type));
}

module.exports = {
  DIR, BERLIN, ADMIN, ANNA, MARC, LENA, TIM, OMA, KUECHE, USERS, T0, MIN, HOUR, DAY, birth, startClock, app, portal, withFamily, pushes,
};
