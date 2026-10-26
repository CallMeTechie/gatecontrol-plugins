'use strict';

// Test helpers: the mock host as GateControl 1.207.0 (media areas and paths, versions and their restore, the NAS
// journal, gc.license.info with tier and seats) with a household and a small firm — an administrator, the parents
// Anna and Marc, their child Lena (a GateControl family group), Oma (no family), Bob (a colleague in the group
// "Büro") — and a combo licence for 5 people. A controllable clock (node:test mock timers, Date only).

const path = require('node:path');
const { mock } = require('node:test');
const { createHost } = require('../../../tools/testing/mock-host');

const DIR = path.join(__dirname, '..');
const ADMIN = { id: 1, name: 'admin', role: 'admin' };
const ANNA = { id: 2, name: 'Anna', role: 'user' };
const MARC = { id: 3, name: 'Marc', role: 'user' };
const LENA = { id: 4, name: 'Lena', role: 'user' };
const OMA = { id: 5, name: 'Oma', role: 'user' };
const BOB = { id: 6, name: 'Bob', role: 'user' };
const USERS = [ADMIN, ANNA, MARC, LENA, OMA, BOB];
const FAMILY = 10;
const OFFICE = 20;
const GROUPS = [
  { id: FAMILY, name: 'Familie Berg', kind: 'family', members: [{ userId: ANNA.id, role: 'parent' }, { userId: MARC.id, role: 'parent' }, { userId: LENA.id, role: 'child' }] },
  { id: OFFICE, name: 'Büro', kind: 'team', members: [{ userId: BOB.id, role: 'member' }, { userId: ANNA.id, role: 'member' }] },
];
const LICENSE = { tier: 'combo', seats: { included: 5, family: 0, business: 0 } };

const T0 = Date.UTC(2026, 9, 26, 9, 0, 0);
const MIN = 60000;
const DAY = 86400000;

function startClock(at = T0) {
  mock.timers.enable({ apis: ['Date'], now: at });
  let now = at;
  return {
    now: () => now,
    add(ms) { now += ms; mock.timers.setTime(now); },
    stop() { mock.timers.reset(); },
  };
}

/** The viewer of an app request from `device`, or of the portal. */
const app = (u, device = 'phone-' + u.id) => ({ ...u, portal: true, loggedIn: true, app: true, device: { id: device, platform: 'android' } });
const portal = (u, loggedIn = true) => ({ ...u, portal: true, loggedIn });

/**
 * opts: { license (licence of the plugin), groups, settings, links (the administrator's switch, default on), unlimited
 *   (links without an end allowed), seats: { userId: kind } (switched on by the admin before fn;
 * default Anna, Marc, Lena family, Bob business), gatecontrol }
 * fn(host, c): c = { clock, as(user, device?) → (method, path, body, query), portal(user), admin(method, path, body),
 *   upload(user, data, mime) → mediaId, put(user, parentId, name, data, o) → node, root(user, kind) → area, events() }
 */
async function withHost(opts, fn) {
  const o = opts || {};
  const clock = startClock(o.at || T0);
  try {
    const host = await createHost(DIR, {
      users: USERS, gatecontrol: o.gatecontrol || '1.207.0', groups: o.groups || GROUPS, license: o.license === undefined ? LICENSE : o.license,
      settings: o.settings || {}, publicLinks: o.links !== false, publicLinksUnlimited: o.unlimited === true,
    });
    await host.start();
    const call = (user, method, p, body, query) => host.request({ method, path: p, body: body === undefined ? null : body, query: query || {}, user, lang: o.lang || 'de' });
    const as = (u, device) => (method, p, body, query) => call(app(u, device), method, p, body, query);
    const adminCall = (method, p, body) => call(ADMIN, method, p, body);
    const seated = o.seats === undefined ? { [ANNA.id]: 'family', [MARC.id]: 'family', [LENA.id]: 'family', [BOB.id]: 'business' } : o.seats;
    for (const [uid, kind] of Object.entries(seated)) {
      const r = await adminCall('PUT', `admin/seats/${uid}`, { kind });
      if (r.status !== 200) throw new Error('seat: ' + JSON.stringify(r.json));
    }
    async function upload(user, data, mime = 'text/plain') {
      const r = await host.upload(user, Buffer.from(data), mime);
      if (r.status !== 200) throw new Error('upload: ' + JSON.stringify(r.body));
      return r.body.mediaId;
    }
    const c = {
      clock, call, as, admin: adminCall,
      portal: (u, loggedIn) => (method, p, body, query) => call(portal(u, loggedIn), method, p, body, query),
      upload,
      /** upload + commit → the answer of POST uploads/commit */
      async put(user, parentId, name, data, co = {}) {
        const mediaId = await upload(user, data, co.mime);
        return as(user)('POST', 'uploads/commit', { mediaId, parentId, name, ...co });
      },
      /** the viewer's area of `kind` (GET me) */
      async area(user, kind, id) {
        const r = await as(user)('GET', 'me');
        return r.json.areas.find((a) => a.kind === kind && (!id || a.id === id)) || null;
      },
      events: () => host.events,
      pushes: () => host.notifications.filter((n) => n.topic),
    };
    try {
      return await fn(host, c);
    } finally {
      await host.close();
    }
  } finally {
    clock.stop();
  }
}

module.exports = { DIR, ADMIN, ANNA, MARC, LENA, OMA, BOB, USERS, FAMILY, OFFICE, GROUPS, LICENSE, T0, MIN, DAY, app, portal, withHost };
