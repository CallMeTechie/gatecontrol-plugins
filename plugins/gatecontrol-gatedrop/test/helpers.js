'use strict';

// Test helpers: the mock host as GateControl 1.193.0 (media up to 2 GB, gc.devices, notify devices/silent,
// gc.media.handOver, gc.publicLinks, target uploads) with a household — an administrator, the parents Anna and
// Marc, their child Lena, Oma (no family role) and a wall tablet account — their app installations, Familie's
// family_roles (a fake), and on request the real Messenger and NAS (Synology) plugins as linked mock hosts.
// A controllable clock (node:test mock timers, Date only).

const path = require('node:path');
const { mock } = require('node:test');
const { createHost } = require('../../../tools/testing/mock-host');

const DIR = path.join(__dirname, '..');
const MESSENGER_DIR = path.join(__dirname, '..', '..', 'gatecontrol-messenger');
const SYNOLOGY_DIR = path.join(__dirname, '..', '..', 'gatecontrol-synology');
const ADMIN = { id: 1, name: 'admin', role: 'admin' };
const ANNA = { id: 2, name: 'Anna', role: 'user' };
const MARC = { id: 3, name: 'Marc', role: 'user' };
const LENA = { id: 4, name: 'Lena', role: 'user' };
const OMA = { id: 5, name: 'Oma', role: 'user' };
const WALL = { id: 6, name: 'Küche', role: 'user' };
const USERS = [ADMIN, ANNA, MARC, LENA, OMA, WALL];
const ROLES = { parents: [ANNA.id, MARC.id], children: [LENA.id] };

const T0 = Date.UTC(2026, 9, 21, 9, 0, 0);
const MIN = 60000;
const DAY = 86400000;

/** Anna's phone and PC (online), her tablet (offline), a web client (never a target); Marc's phone. */
function devices() {
  return [
    { id: 'anna-phone', userId: ANNA.id, name: 'Pixel', platform: 'android', online: true },
    { id: 'anna-pc', userId: ANNA.id, name: 'Büro-PC', platform: 'windows', online: true },
    { id: 'anna-tab', userId: ANNA.id, name: 'Tablet', platform: 'android', online: false },
    { id: 'anna-web', userId: ANNA.id, name: 'Browser', platform: 'web', online: true },
    { id: 'marc-phone', userId: MARC.id, name: 'Marcs Handy', platform: 'android', online: true },
  ];
}

const familie = (roles = ROLES) => ({ plugin: 'gatecontrol-familie', provides: ['family_roles'], service: async () => (roles ? { ok: true, ...roles } : { ok: false, code: 'forbidden' }) });

function startClock(at = T0) {
  mock.timers.enable({ apis: ['Date'], now: at });
  let now = at;
  return {
    now: () => now,
    add(ms) { now += ms; mock.timers.setTime(now); },
    stop() { mock.timers.reset(); },
  };
}

/** The viewer of an app request from `device` (GateControl ≥ 1.193.0: user.device), or of the portal. */
const app = (u, device) => ({ ...u, portal: true, loggedIn: true, app: true, ...(device ? { device: { id: device, platform: device.endsWith('pc') ? 'windows' : 'android' } } : {}) });
const portal = (u, loggedIn = true) => ({ ...u, portal: true, loggedIn });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n%fake\n');

/**
 * opts: { messenger: true (the real Messenger, linked), nas: true (the real NAS plugin with a fake DSM, a NAS and a drop
 * folder /Familie/Ablage), roles (Familie's answer; null = Familie refuses, false = no Familie), links (the admin switch,
 * default on), publicUrl, mediaQuota, devices }
 * fn(host, c): c = { clock, as(user, device?) → (method, path, body, query), portal(user), upload(user, buf, mime, o) → mediaId,
 *   presence(user, device, ip, listening, prefix?), pushes(), messenger (its host), nas: { host, dsm, folderId } }
 */
async function withHost(opts, fn) {
  const o = opts || {};
  const clock = startClock(o.at || T0);
  const services = [];
  if (o.roles !== false) services.push(familie(o.roles === undefined ? ROLES : o.roles));
  let mh = null;
  let nas = null;
  try {
    if (o.messenger) {
      mh = await createHost(MESSENGER_DIR, { users: USERS, gatecontrol: '1.193.0', services: services.slice() });
      await mh.start();
      services.push({ plugin: 'gatecontrol-messenger', host: mh });
    }
    if (o.nas) {
      const { fakeDsm } = require('../../gatecontrol-synology/test/helpers');
      const dsm = fakeDsm('dsm72.json');
      const sh = await createHost(SYNOLOGY_DIR, { users: USERS, gatecontrol: '1.193.0', targets: { nas: [{ label: 'nas.home', fetch: dsm.fetch, upload: dsm.upload }] } });
      await sh.start();
      const add = await sh.request({ method: 'POST', path: '/nas', user: ADMIN, body: { name: 'Keller', target_index: 0, username: 'gc-monitor', password: 'S3cret-Pa55!word' } });
      const f = await sh.request({ method: 'POST', path: '/drop-folders', user: ADMIN, body: { nas_id: add.json.nas.id, path: '/Familie/Ablage', label: 'Ablage' } });
      nas = { host: sh, dsm, folderId: f.json.folder.id };
      services.push({ plugin: 'gatecontrol-synology', host: sh });
    }
    const host = await createHost(DIR, {
      users: USERS, gatecontrol: '1.193.0', devices: o.devices || devices(), services, publicLinks: o.links !== false,
      ...(o.publicUrl !== undefined ? { publicUrl: o.publicUrl } : {}), mediaQuota: o.mediaQuota,
    });
    await host.start();
    const call = (user, method, p, body, query) => host.request({ method, path: p, body: body === undefined ? null : body, query: query || {}, user, lang: o.lang || 'de' });
    const c = {
      clock, call, messenger: mh, nas,
      as: (u, device) => (method, p, body, query) => call(app(u, device), method, p, body, query),
      portal: (u, loggedIn) => (method, p, body, query) => call(portal(u, loggedIn), method, p, body, query),
      async upload(user, buf, mime, uo) {
        const r = await host.upload(user, buf, mime, uo);
        if (r.status !== 200) throw new Error('upload: ' + JSON.stringify(r.body));
        return r.body.mediaId;
      },
      presence(user, device, ip, listening, prefix = 24) {
        return call(app(user, device), 'PUT', 'presence', { lan: [{ ip, prefix }], port: 47731, listening });
      },
      pushes: () => host.notifications.filter((n) => n.topic),
    };
    try {
      return await fn(host, c);
    } finally {
      await host.close();
    }
  } finally {
    if (mh) await mh.close();
    if (nas) await nas.host.close();
    clock.stop();
  }
}

module.exports = { DIR, ADMIN, ANNA, MARC, LENA, OMA, WALL, USERS, ROLES, T0, MIN, DAY, devices, familie, app, portal, withHost, PNG, PDF };
