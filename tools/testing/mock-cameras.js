'use strict';

// GateControl with "Kameras im Heimnetz" (phase 3c step 4) for the mock host (tools/testing/mock-host.js): gc.cameras
// (src/services/homeCameras.js, hostApi.js camerasCall, the child bootstrap's makeCameras; docs/plugins.md "Cameras",
// the gateway's docs/cameras.md). Opt-in: opts.cameras; only a plugin with permissions.cameras: true has gc.cameras (an
// older GateControl ignores the key — no gc.cameras; without the permission the host answers ERR_CAMERAS_DENIED).
//
//   createHost(dir, { cameras: { gateways: [{ id, name, online, supported, enabled, service, storage, hint }],
//                                 cameras: [<camera as gc.cameras.list() answers>], found: [<discover entry>],
//                                 password: 'geheim' (what test/add accept), events: [<event>] } })
//
// Like the host:
//   available()                 { available: some enabled + supported gateway, gateways }
//   list()                      the cameras (a copy)
//   discover({ gatewayId? })    { found } (cameraId set for a host that is already a camera)
//   test(opts) / add(opts)      private IPv4 only (ERR_CAMERA_NOT_ALLOWED), the gateway enabled (ERR_CAMERA_UNSUPPORTED),
//                               the password `password` (ERR_CAMERA_AUTH); add stores a camera (never the password)
//   update(id, patch) / remove(id)
//   snapshot(id)                { data: a small JPEG (base64), mime, at }; snapshotUrl(id) → { url: '/camera-media/snap-<id>/snapshot.jpg' }
//   live(id, req)               req.homeRef of a request with `vpn: true` → mode 'live', otherwise mode 'snapshot'
//   events({ cameraId?, since?, until? }) / deleteEvent(id)
//   on(handler)                 host.cameraEvent(ev) delivers one (like the hook cameraEvent)
// host.cameras = { state }: the cameras, calls, the passwords the host was given (state.passwords — never in a list).

const crypto = require('node:crypto');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 0x11, 8, 1, 104, 2, 128, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
const PRIVATE = (ip) => {
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(String(ip || ''));
  if (!m) return false;
  const a = Number(m[1]); const b = Number(m[2]);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
};

function install({ opts, perms, hostError }) {
  const o = opts.cameras && typeof opts.cameras === 'object' ? opts.cameras : null;
  if (o && perms.cameras != null && typeof perms.cameras !== 'boolean') throw hostError('ERR_INVALID', 'plugin.json: permissions.cameras: invalid');
  const on = !!o && perms.cameras === true;
  const copy = (x) => JSON.parse(JSON.stringify(x));
  const state = {
    gateways: copy((o && o.gateways) || []), cameras: copy((o && o.cameras) || []), found: copy((o && o.found) || []), events: copy((o && o.events) || []),
    password: (o && o.password) || 'geheim', passwords: new Map(), calls: [], handlers: [], refs: new Map(),
  };
  const need = () => { if (perms.cameras !== true) throw hostError('ERR_CAMERAS_DENIED', 'this plugin has no cameras permission'); };
  const cam = (id) => { const c = state.cameras.find((x) => x.id === id); if (!c) throw hostError('ERR_NOT_FOUND', 'no such camera'); return c; };
  const gw = (id) => {
    const g = state.gateways.find((x) => x.id === Number(id));
    if (!g) throw hostError('ERR_NOT_FOUND', 'no such gateway');
    if (!g.enabled || g.supported === false) throw hostError('ERR_CAMERA_UNSUPPORTED', 'cameras are off on this gateway');
    if (g.online === false) throw hostError('ERR_CAMERA_OFFLINE', 'the gateway is offline');
    return g;
  };
  const hostOf = (a) => (typeof a.rtspUrl === 'string' && a.rtspUrl ? (/^rtsp:\/\/([^/:@]+@)?([^/:]+)/i.exec(a.rtspUrl) || [])[2] : a.host);
  const probe = (a) => {
    const g = gw(a.gatewayId);
    if (!PRIVATE(hostOf(a))) throw hostError('ERR_CAMERA_NOT_ALLOWED', 'not a private address of the home network');
    if (a.password !== state.password) throw hostError('ERR_CAMERA_AUTH', 'the camera refused the user or password');
    return { g, result: { ok: true, source: a.rtspUrl ? 'rtsp' : 'onvif', info: { manufacturer: 'Reolink', model: 'E1 Zoom', firmware: 'v3' }, profiles: [], events: { supported: true, kinds: ['person', 'vehicle'] }, codec: 'h264', snapshot: { data: JPEG.toString('base64'), mime: 'image/jpeg' } } };
  };
  const settings = (s) => ({ record: 'motion', events: ['person', 'vehicle', 'animal'], retentionDays: 14, stream: 'main', audio: false, ...(s || {}) });
  const api = {};
  const rec = (name, fn) => { api['cameras.' + name] = async (args) => { need(); state.calls.push({ name, args: copy(args || {}) }); return fn(args || {}); }; };
  rec('available', () => ({ available: state.gateways.some((g) => g.enabled && g.supported !== false), gateways: copy(state.gateways) }));
  rec('list', () => copy(state.cameras));
  rec('discover', ({ gatewayId }) => ({ found: state.found.filter((f) => gatewayId == null || f.gatewayId === gatewayId).map((f) => ({ ...f, cameraId: (state.cameras.find((c) => c.host === f.host) || {}).id || null })) }));
  rec('test', ({ opts: a }) => probe(a || {}).result);
  rec('add', ({ opts: a0 }) => {
    const a = a0 || {};
    const { g, result } = probe(a);
    const c = {
      id: 'c' + crypto.randomBytes(8).toString('hex').slice(0, 15), gatewayId: g.id, gateway: g.name, name: String(a.name || '').slice(0, 60) || 'Kamera',
      host: hostOf(a), source: result.source, manufacturer: 'Reolink', model: 'E1 Zoom', state: 'ok', online: true, codec: 'h264', width: 2560, height: 1440,
      events: { supported: true, state: 'pullpoint', kinds: ['person', 'vehicle'] }, settings: settings(a.settings), snapshotAt: null, lastEventAt: null,
    };
    state.cameras.push(c);
    state.passwords.set(c.id, a.password);
    return { camera: copy(c), snapshot: result.snapshot };
  });
  rec('update', ({ id, patch }) => {
    const c = cam(id);
    const p = patch || {};
    if (p.name !== undefined) c.name = String(p.name);
    if (p.password !== undefined) state.passwords.set(c.id, p.password);
    if (p.settings) {
      if (p.settings.record !== undefined && !['motion', 'away', 'never'].includes(p.settings.record)) throw hostError('ERR_INVALID', 'settings.record');
      c.settings = settings({ ...c.settings, ...p.settings });
    }
    return copy(c);
  });
  rec('remove', ({ id }) => { cam(id); state.cameras = state.cameras.filter((x) => x.id !== id); return { removed: true }; });
  rec('snapshot', ({ id }) => { cam(id); return { data: JPEG.toString('base64'), mime: 'image/jpeg', at: new Date().toISOString() }; });
  rec('snapshotUrl', ({ id }) => { cam(id); return { url: `/camera-media/snap-${id}/snapshot.jpg`, expiresAt: new Date(Date.now() + 600000).toISOString(), every: 10 }; });
  rec('live', ({ id, ref }) => {
    cam(id);
    const r = ref ? state.refs.get(ref) : null;
    if (r && r.vpn) return { mode: 'live', via: 'vpn', ready: true, hls: `/camera-media/live-${id}/index.m3u8`, mp4: `/camera-media/live-${id}/live.mp4`, snapshot: `/camera-media/live-${id}/snapshot.jpg`, codec: 'avc1.64001f', audio: false, expiresAt: new Date(Date.now() + 600000).toISOString() };
    return { mode: 'snapshot', snapshot: `/camera-media/snap-${id}/snapshot.jpg`, every: 10, reason: 'vpn_required', via: 'internet' };
  });
  rec('events', ({ opts: q0 }) => {
    const q = q0 || {};
    const since = q.since ? Date.parse(q.since) : -Infinity;
    const until = q.until ? Date.parse(q.until) : Infinity;
    return state.events.filter((e) => (!q.cameraId || e.cameraId === q.cameraId) && Date.parse(e.startedAt) >= since && Date.parse(e.startedAt) < until)
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)).map((e) => ({ ...copy(e), thumbUrl: `/camera-media/clip-${e.id}/thumb.jpg`, clipUrl: e.clip ? `/camera-media/clip-${e.id}/clip.mp4` : null }));
  });
  rec('deleteEvent', ({ id }) => { state.events = state.events.filter((e) => e.id !== id); return { deleted: true }; });

  const gcPart = (call) => Object.freeze({
    available: () => call('cameras.available', {}),
    list: () => call('cameras.list', {}),
    discover: (x) => call('cameras.discover', { gatewayId: x && x.gatewayId }),
    test: (x) => call('cameras.test', { opts: x || {} }),
    add: (x) => call('cameras.add', { opts: x || {} }),
    update: (id, patch) => call('cameras.update', { id, patch: patch || {} }),
    remove: (id, x) => call('cameras.remove', { id, opts: x || {} }),
    snapshot: (id, x) => call('cameras.snapshot', { id, opts: x || {} }),
    snapshotUrl: (id) => call('cameras.snapshotUrl', { id }),
    live: (id, req) => call('cameras.live', { id, ref: req && typeof req === 'object' && typeof req.homeRef === 'string' ? req.homeRef : null }),
    events: (x) => call('cameras.events', { opts: x || {} }),
    deleteEvent: (id) => call('cameras.deleteEvent', { id }),
    on: (fn) => {
      if (typeof fn !== 'function') throw new TypeError('gc.cameras.on(handler)');
      state.handlers.push(fn);
      return () => { const i = state.handlers.indexOf(fn); if (i >= 0) state.handlers.splice(i, 1); };
    },
  });

  /** the hook cameraEvent: every handler, one after the other (a handler that throws is reported to the caller) */
  async function deliver(ev) {
    const arg = Object.freeze(copy(ev));
    for (const fn of state.handlers.slice()) await fn(arg);
    return { handled: state.handlers.length };
  }

  return { on, api, gcPart, state, deliver, JPEG };
}

module.exports = { install };
