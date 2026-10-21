'use strict';

// Test helpers: the mock host (tools/testing/mock-host.js — as GateControl 1.180.0 unless a test names another version
// media / events / chat notifications / services) with five accounts (an
// administrator, Anna, Marc, Lena, Oma), callers as the apps and the portal
// see them, and a controllable clock (node:test mock timers, Date only).

const path = require('node:path');
const { mock } = require('node:test');
const { createHost } = require('../../../tools/testing/mock-host');

const DIR = path.join(__dirname, '..');
const ADMIN = { id: 1, name: 'admin', role: 'admin' };
const ANNA = { id: 2, name: 'Anna', role: 'user' };
const MARC = { id: 3, name: 'Marc', role: 'user' };
const LENA = { id: 4, name: 'Lena', role: 'user' };
const OMA = { id: 5, name: 'Oma', role: 'user' };
const USERS = [ADMIN, ANNA, MARC, LENA, OMA];

const T0 = Date.UTC(2026, 9, 17, 10, 0, 0);
const SEC = 1000;
const MIN = 60000;
const HOUR = 3600000;
const DAY = 86400000;

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

// a 1×1 PNG and a few bytes of "audio"
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const OGG = Buffer.from('OggS\0\x02fake-opus-voice-message-bytes');
const PDF = Buffer.from('%PDF-1.4\n%fake\n');

/** A real PNG of w × h pixels (grey) — push pictures need 32…2560 px a side. */
function png(w, h) {
  const zlib = require('node:zlib');
  const crc = (buf) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0; // 8-bit greyscale
  const raw = Buffer.alloc((w + 1) * h, 0x80);
  for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0;
  return Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

let seq = 0;
const cid = () => `client-${Date.now()}-${++seq}`;

/**
 * fn(host, ctx): ctx = { clock, call(user, method, path, body, query), as(user) → (method, path, body, query),
 * admin(method, path, body, query), send(user, convId, body), direct(a, b) → conversation, group(owner, ids, title) → conversation,
 * upload(user, buf, mime) → mediaId, events(type?) since the last reset, resetEvents(), pushes() }
 */
async function withHost(opts, fn) {
  const o = opts || {};
  const clock = startClock(o.at || T0);
  const host = await createHost(DIR, { users: o.users || USERS, settings: o.settings || {}, services: o.services, mediaQuota: o.mediaQuota, connected: o.connected, gatecontrol: o.gatecontrol || '1.180.0', actions: o.actions, actionsApi: o.actionsApi, routeTopics: o.routeTopics, sinkActive: o.sinkActive });
  await host.start();
  const call = (user, method, p, body, query) => host.request({ method, path: p, body: body === undefined ? null : body, query: query || {}, user, lang: o.lang || 'de' });
  const as = (u, viewer = app) => (method, p, body, query) => call(viewer(u), method, p, body, query);
  const admin = (method, p, body, query) => call(ADMIN, method, '/admin/' + p.replace(/^\//, ''), body, query);
  let evFrom = 0;
  const ctx = {
    clock, call, as, admin,
    async send(user, convId, body) {
      const r = await call(app(user), 'POST', `conversations/${convId}/messages`, { clientId: cid(), kind: 'text', ...body });
      if (r.status !== 200) throw new Error('send: ' + JSON.stringify(r.json));
      return r.json.message;
    },
    async direct(a, b) {
      const r = await call(app(a), 'POST', 'conversations', { kind: 'direct', userIds: [b.id] });
      if (r.status !== 200) throw new Error('direct: ' + JSON.stringify(r.json));
      return r.json.conversation;
    },
    async group(owner, members, title = 'Familie') {
      const r = await call(app(owner), 'POST', 'conversations', { kind: 'group', userIds: members.map((m) => m.id), title });
      if (r.status !== 200) throw new Error('group: ' + JSON.stringify(r.json));
      return r.json.conversation;
    },
    async upload(user, buf, mime) {
      const r = await host.upload(user, buf, mime);
      if (r.status !== 200) throw new Error('upload: ' + JSON.stringify(r.body));
      return r.body.mediaId;
    },
    events(type) { return host.events.slice(evFrom).filter((e) => !type || e.type === type); },
    resetEvents() { evFrom = host.events.length; },
    pushes() { return host.notifications.filter((n) => n.kind === 'message'); },
    cid,
  };
  try {
    return await fn(host, ctx);
  } finally {
    await host.close();
    clock.stop();
  }
}

module.exports = { DIR, ADMIN, ANNA, MARC, LENA, OMA, USERS, T0, SEC, MIN, HOUR, DAY, startClock, app, portal, withHost, PNG, OGG, PDF, png, cid };
