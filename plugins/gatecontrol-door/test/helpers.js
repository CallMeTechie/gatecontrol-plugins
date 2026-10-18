'use strict';

// Test helpers: the mock host (tools/testing/mock-host.js, GateControl ≥ 1.169.0
// behaviour) with people, a fake Nuki Bridge behind the home target
// "nuki-bridge" (checks the hashed token auth, never sees the plain token),
// a fake Nuki Web API and a fake (unofficial) Ring API on the internet
// handler, and a controllable clock (node:test mock timers, Date only).
//
//   ADMIN (no rights) · ANNA (open) · MARC (lock) · LENA (view) · GAST (none)

const path = require('node:path');
const crypto = require('node:crypto');
const { mock } = require('node:test');
const { createHost } = require('../../../tools/testing/mock-host');

const DIR = path.join(__dirname, '..');
const ADMIN = { id: 1, name: 'admin', role: 'admin' };
const ANNA = { id: 2, name: 'Anna', role: 'user' };
const MARC = { id: 3, name: 'Marc', role: 'user' };
const LENA = { id: 4, name: 'Lena', role: 'user' };
const GAST = { id: 5, name: 'Gast', role: 'user' };
const USERS = [ADMIN, ANNA, MARC, LENA, GAST];
const BRIDGE_TOKEN = 'abc123XYZ';
const WEB_TOKEN = 'nuki-web-token-0123456789';
/** 2026-10-14 (Wednesday) 10:00 in Berlin (CEST, UTC+2) */
const T0 = Date.UTC(2026, 9, 14, 8, 0, 0);
const SEC = 1000;
const MIN = 60000;
const HOUR = 3600000;

const app = (u) => ({ ...u, portal: true, loggedIn: true, app: true });
const portal = (u, loggedIn = true) => ({ ...u, portal: true, loggedIn });
const kiosk = (u) => ({ ...u, portal: true, loggedIn: true, kiosk: true });

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

/** A small valid JPEG header (SOF0 with the given size) — enough for the picture checks. */
function jpeg(width = 640, height = 360, pad = 200) {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xe0, 0x00, 0x04, 0, 0]), sof, Buffer.alloc(pad, 0x55), Buffer.from([0xff, 0xd9])]);
}

/**
 * A fake Nuki Bridge: devices { nukiId: { deviceType, name, state, door, batteryCritical, battery, listState } }.
 * Checks ts (±60 s), rnr (never reused), hash = sha256("ts,rnr,token"); 401 otherwise.
 * listState (optional): the code the bridge's cached lastKnownState in /list is stuck on (e.g. 7
 * unlatching) while the lock itself — /lockState — reports `state`. failLockState: /lockState → 503.
 */
function fakeBridge(devices, { token = BRIDGE_TOKEN } = {}) {
  const b = { devices, requests: [], rnrs: new Set(), down: false, busy: 0, maxBusy: 0, failAction: false, failLockState: false, plainTokenSeen: false };
  b.fetch = async (p, opts) => {
    const u = new URL('http://bridge' + p);
    b.requests.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), opts });
    if (p.includes(token)) b.plainTokenSeen = true;
    b.busy++;
    b.maxBusy = Math.max(b.maxBusy, b.busy);
    try {
      await new Promise((r) => setImmediate(r));
      if (b.down) throw Object.assign(new Error('timeout'), { code: 'ERR_NET' });
      const ts = u.searchParams.get('ts');
      const rnr = u.searchParams.get('rnr');
      const hash = u.searchParams.get('hash');
      const expect = crypto.createHash('sha256').update(`${ts},${rnr},${token}`).digest('hex');
      if (!ts || Math.abs(Date.parse(ts) - Date.now()) > 60000 || hash !== expect || b.rnrs.has(rnr) || u.searchParams.has('token')) return { status: 401, body: '' };
      b.rnrs.add(rnr);
      const dev = (id) => b.devices[id];
      const stateOf = (d, code = d.state) => ({ mode: 2, state: code, stateName: 'x', batteryCritical: !!d.batteryCritical, batteryChargeState: d.battery == null ? 80 : d.battery, batteryCharging: false, doorsensorState: d.door == null ? 1 : d.door, timestamp: new Date().toISOString() });
      if (u.pathname === '/list') {
        return { status: 200, body: JSON.stringify(Object.entries(b.devices).map(([id, d]) => ({ nukiId: Number(id), deviceType: d.deviceType, name: d.name, firmwareVersion: '3.0', lastKnownState: stateOf(d, d.listState != null ? d.listState : d.state) }))) };
      }
      const d = dev(u.searchParams.get('nukiId'));
      if (!d) return { status: 404, body: '' };
      if (u.pathname === '/lockState') return b.failLockState ? { status: 503, body: '' } : { status: 200, body: JSON.stringify({ ...stateOf(d), success: true }) };
      if (u.pathname === '/lockAction') {
        const action = Number(u.searchParams.get('action'));
        if (b.failAction) return { status: 200, body: JSON.stringify({ success: false }) };
        if (d.deviceType === 2) { if (action === 3) d.state = 5; } else d.state = { 1: 3, 2: 1, 3: 5 }[action] || d.state;
        d.lastAction = action;
        return { status: 200, body: JSON.stringify({ success: true, batteryCritical: false }) };
      }
      return { status: 404, body: '' };
    } finally {
      b.busy--;
    }
  };
  return b;
}

/**
 * A Nuki Web smartlock as GET /smartlock answers it (the fields the plugin reads, plus a few it must ignore).
 * o: { type, name, serverState, mode, trigger, lastAction, doorState, battery, updateDate }. updateDate
 * undefined → the fake cloud fills in "now" on every answer (a live cloud); a string → that (a cloud copy
 * stuck since then); null → the field is left out.
 */
function webEntry(id, state, o = {}) {
  const d = {
    smartlockId: id, accountId: 1, type: o.type == null ? 4 : o.type, lmType: 0, authId: 2, name: o.name || 'Haustür', favorite: false,
    serverState: o.serverState == null ? 0 : o.serverState, adminPinState: 0, virtualDevice: false,
    creationDate: '2024-03-01T10:00:00.000Z',
    state: {
      mode: o.mode == null ? 2 : o.mode, state, trigger: o.trigger == null ? 0 : o.trigger, lastAction: o.lastAction == null ? 1 : o.lastAction,
      batteryCritical: false, batteryCharging: false, batteryCharge: o.battery == null ? 82 : o.battery, keypadBatteryCritical: false,
      doorsensorBatteryCritical: false, doorState: o.doorState == null ? 0 : o.doorState, ringToOpenTimer: 0, nightMode: false,
    },
  };
  // key absent → the fake fills in now; null → key present but undefined (JSON leaves it out)
  if (o.updateDate !== undefined) d.updateDate = o.updateDate === null ? undefined : o.updateDate;
  return d;
}

/**
 * A fake of the unofficial Ring API and the Nuki Web API on the internet handler.
 * web.locks: GET /smartlock · web.fresh { smartlockId: lock }: what GET /smartlock/{id} answers
 * (default: the entry of web.locks) — a stale overview vs. the lock read again. An entry without
 * `updateDate` (key absent) is answered with updateDate = now (a live cloud copy).
 */
function fakeCloud() {
  const c = {
    calls: [],
    ring: {
      code: '123456', password: 'geheim', rt: 0, validRt: null, down: false, status429: false,
      devices: { doorbots: [{ id: 111, description: 'Klingel Haustür', kind: 'doorbell_v4', location_id: 'loc1', battery_life: '87', alerts: { connection: 'online' }, settings: { motion_detection_enabled: true } }],
        authorized_doorbots: [], stickup_cams: [{ id: 222, description: 'Garten', kind: 'stickup_cam_v4', location_id: 'loc1', battery_life: null, alerts: { connection: 'offline' }, settings: {} }] },
      active: [], events: [], snapshot: jpeg(), sessions: 0,
      // devices/v1/locations and the location modes (prd-api-us.prd.rings.solutions/api/v1/mode/location/<id>)
      locations: [{ location_id: 'loc1', name: 'Langenlonsheim', owner_id: 1 }],
      modes: { loc1: { mode: 'home', readOnly: false, lastUpdateTimeMS: T0 - HOUR } },
      modeStatus: null,    // a number → GET/POST mode answers that HTTP status
      modeDown: false,     // the mode host does not answer
      modeIgnore: false,   // POST answers 200 but keeps the old mode
    },
    web: { locks: [], fresh: {}, actions: [], log: [] },
  };
  c.fetch = async (url, opts) => {
    const u = new URL(url);
    const h = Object.fromEntries(Object.entries(opts.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    c.calls.push({ url, method: opts.method || 'GET', headers: h, json: opts.json });
    const R = c.ring;
    if (u.hostname === 'api.nuki.io') {
      if (h.authorization !== `Bearer ${WEB_TOKEN}`) return { status: 401, body: '' };
      const live = (d) => (d && typeof d === 'object' && !('updateDate' in d) ? { ...d, updateDate: new Date().toISOString() } : d);
      if (u.pathname === '/smartlock') return { status: 200, body: JSON.stringify(c.web.locks.map(live)) };
      const one = /^\/smartlock\/(\d+)$/.exec(u.pathname);
      if (one && (opts.method || 'GET') === 'GET') {
        const d = c.web.fresh[one[1]] || c.web.locks.find((x) => String(x.smartlockId) === one[1]);
        return d ? { status: 200, body: JSON.stringify(live(d)) } : { status: 404, body: '' };
      }
      const m = /^\/smartlock\/(\d+)\/(action|log)$/.exec(u.pathname);
      if (m && m[2] === 'action' && opts.method === 'POST') { c.web.actions.push({ id: m[1], ...opts.json }); return { status: 204, body: '' }; }
      if (m && m[2] === 'log') return { status: 200, body: JSON.stringify(c.web.log) };
      return { status: 404, body: '' };
    }
    if (R.down) throw Object.assign(new Error('down'), { code: 'ERR_NET' });
    if (R.status429) return { status: 429, headers: { 'retry-after': '120' }, body: '' };
    if (u.hostname === 'oauth.ring.com') {
      const j = opts.json || {};
      if (j.client_id !== 'ring_official_android' || !h.hardware_id) return { status: 400, body: '{}' };
      if (j.grant_type === 'password') {
        if (j.password !== R.password) return { status: 401, body: JSON.stringify({ error: 'invalid_grant' }) };
        if (!h['2fa-code']) return { status: 412, body: JSON.stringify({ next_time_in_secs: 60, phone: '+49******12', tsv_state: 'sms' }) };
        if (h['2fa-code'] !== R.code) return { status: 400, body: JSON.stringify({ error: 'Verification Code is invalid or expired' }) };
      } else if (j.grant_type === 'refresh_token') {
        if (j.refresh_token !== R.validRt) return { status: 401, body: JSON.stringify({ error: 'invalid_grant' }) };
      } else return { status: 400, body: '{}' };
      R.rt += 1;
      R.validRt = `rt-${R.rt}`;
      return { status: 200, body: JSON.stringify({ access_token: `at-${R.rt}`, expires_in: 3600, refresh_token: R.validRt, scope: 'client', token_type: 'Bearer' }) };
    }
    if (!h.authorization || h.authorization !== `Bearer at-${R.rt}`) return { status: 401, body: '' };
    if (u.hostname === 'prd-api-us.prd.rings.solutions') {
      const m = /^\/api\/v1\/mode\/location\/([^/]+)$/.exec(u.pathname);
      if (!m) return { status: 404, body: '' };
      if (R.modeDown) throw Object.assign(new Error('down'), { code: 'ERR_NET' });
      if (R.modeStatus) return { status: R.modeStatus, body: '{"error":"nope"}' };
      const cur = R.modes[decodeURIComponent(m[1])];
      if (!cur) return { status: 404, body: '' };
      if ((opts.method || 'GET') === 'POST') {
        const want = opts.json && opts.json.mode;
        if (!['disarmed', 'home', 'away'].includes(want) || cur.readOnly) return { status: 400, body: '{}' };
        if (!R.modeIgnore) { cur.mode = want; cur.lastUpdateTimeMS = Date.now(); }
      }
      return { status: 200, body: JSON.stringify({ ...cur, securityStatus: { md: 'none', returnTopic: 'x' } }) };
    }
    if (u.pathname === '/devices/v1/locations') return { status: 200, body: JSON.stringify({ user_locations: R.locations }) };
    if (u.hostname === 'app-snaps.ring.com') return R.snapshot ? { status: 200, bodyBase64: R.snapshot.toString('base64') } : { status: 404, body: '' };
    if (u.pathname === '/clients_api/session') { R.sessions++; return { status: 201, body: '{"profile":{}}' }; }
    if (u.pathname === '/clients_api/ring_devices') return { status: 200, body: JSON.stringify(R.devices) };
    if (u.pathname === '/clients_api/dings/active') return { status: 200, body: JSON.stringify(R.active) };
    if (/^\/clients_api\/locations\/[^/]+\/events$/.test(u.pathname)) return { status: 200, body: JSON.stringify({ events: R.events, meta: {} }) };
    if (/^\/clients_api\/snapshots\/image\/\d+$/.test(u.pathname)) return R.snapshot ? { status: 200, bodyBase64: R.snapshot.toString('base64') } : { status: 404, body: '' };
    return { status: 404, body: '' };
  };
  return c;
}

/**
 * A host with the people above, a bridge with a Haustür (smart lock, nukiId 1001, locked, door sensor
 * closed) and a Opener (nukiId 2002), the locks set up through the admin API, rights as above.
 * fn(host, ctx) with ctx = { clock, bridge, cloud, call(user, method, path, body, query), admin(method, path, body, query), lockId, openerId }
 */
async function withDoor(opts, fn) {
  const o = opts || {};
  const clock = startClock(o.at || T0);
  const bridge = fakeBridge(o.devices || {
    1001: { deviceType: 4, name: 'Haustür', state: 1, door: 2, battery: 80 },
    2002: { deviceType: 2, name: 'Opener', state: 1 },
  });
  const cloud = fakeCloud();
  const host = await createHost(DIR, {
    users: o.users || USERS, settings: o.settings || {}, fetch: cloud.fetch, notifyFail: o.notifyFail,
    targets: { 'nuki-bridge': [{ label: 'Bridge Flur', fetch: bridge.fetch }] },
    // 1.3.0: other plugins' services (the Messenger) and the GateControl version for gc.services.available
    services: o.services, gatecontrol: o.gatecontrol,
  });
  await host.start();
  const call = (user, method, p, body, query) => host.request({ method, path: p, body: body === undefined ? null : body, query: query || {}, user, lang: o.lang || 'de' });
  const admin = (method, p, body, query) => call(ADMIN, method, '/admin/' + p.replace(/^\//, ''), body, query);
  const ctx = { clock, bridge, cloud, call, admin, lockId: null, openerId: null };
  try {
    await admin('PUT', 'settings', { timezone: 'Europe/Berlin' });
    if (o.setup !== false) {
      const b = await admin('POST', 'bridges', { name: 'Flur', targetIndex: 0, token: BRIDGE_TOKEN });
      if (b.status !== 200) throw new Error('setup bridge: ' + JSON.stringify(b.json));
      const l = await admin('POST', 'locks', { name: 'Haustür', source: 'bridge', bridgeId: b.json.bridge.id, nukiId: '1001', deviceType: 4, actions: ['lock', 'unlock', 'open'], doorSensor: o.doorSensor !== false, ...(o.lock || {}) });
      if (l.status !== 200) throw new Error('setup lock: ' + JSON.stringify(l.json));
      ctx.lockId = l.json.lock.id;
      const op = await admin('POST', 'locks', { name: 'Hoftor', source: 'bridge', bridgeId: b.json.bridge.id, nukiId: '2002', deviceType: 2, actions: ['open'], nightCheck: null });
      ctx.openerId = op.json.lock.id;
      const set = async (u, lv, extra = {}) => {
        const r = await admin('PUT', `rights/${u.id}`, { locks: { [ctx.lockId]: lv, [ctx.openerId]: lv === 'lock' ? 'view' : lv }, ...extra });
        if (r.status !== 200) throw new Error('setup rights: ' + JSON.stringify(r.json));
      };
      await set(ANNA, 'open');
      await set(MARC, 'lock');
      await set(LENA, 'view');
      await host.tick(); // first poll
      host.notifications.length = 0;
    }
    await fn(host, ctx);
  } finally {
    clock.stop();
    await host.close();
  }
}

/** Log in to the fake Ring (2FA) through the admin API. */
async function ringLogin(ctx) {
  const a = await ctx.admin('POST', 'ring/login', { email: 'a@b.de', password: 'geheim' });
  if (!a.json.ring || !a.json.ring.needsCode) throw new Error('ring step 1: ' + JSON.stringify(a.json));
  const b = await ctx.admin('POST', 'ring/login', { email: 'a@b.de', password: 'geheim', code: '123456' });
  if (!b.json.ring || !b.json.ring.connected) throw new Error('ring step 2: ' + JSON.stringify(b.json));
  return b.json;
}

module.exports = {
  DIR, ADMIN, ANNA, MARC, LENA, GAST, USERS, BRIDGE_TOKEN, WEB_TOKEN, T0, SEC, MIN, HOUR,
  app, portal, kiosk, startClock, jpeg, fakeBridge, fakeCloud, webEntry, withDoor, ringLogin,
};
