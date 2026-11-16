'use strict';

// The portal tab "Fernzugriff" and the profile section (a signed-in person):
// the devices the person may reach with their state, "Verbinden" (a ticket of
// GateControl's session page), wake-on-LAN, and the person's own rights.
// Rights are checked on every call (rights.js).
//
// Since 1.1 also the app API of the GateControl apps (same paths, req.user.app):
//   GET  devices                      the devices of the person like the portal, with owner, online and
//                                     connect: { mode: 'code' | 'open' } of a PC
//   POST devices/<id>/connect         a PC "ohne Code": browser → { session }, app → { connection }
//   POST code/redeem                  { code, mode, via, deviceId? } → { request } (server/support.js)
//   GET  requests/<id>, POST requests/<id>/connect
//   host/*                            the PC's own app (server/hosts.js)
//
// Since 1.2 (gc.remote version 3) — the native terminals of the apps and the recordings:
//   GET  devices/<id>/tmux            { sessions: [{ name, windows, attached, created, activity, attachable }], tmux, hostKey }
//   POST devices/<id>/connect         { via: 'app', tmux?: { attach | create }, record? } → { session: { ref, expiresAt, engine: 'term',
//                                     recording, tmux } }; the app turns ref into a token: POST /api/v1/client/remote/term-token
//   GET  recordings?device&limit      { recordings: [...] } — administrators all, others the recordings of their own devices
//   POST recordings/<id>/play         { url, ref, expiresAt, format } — GateControl's playback page, for this person only
//
// Since 1.3 (gc.remote version 4) — the screen of a phone (GateControl's relay gc-screen.v1, only watching):
//   host/register { platform: 'android', … }   the phone's switch "Bildschirm freigeben" (server/hosts.js)
//   POST host/requests/<id> allow       → { request, screen: { ref, expiresAt, wsPath } } — the sending side for the phone
//   POST host/screen/<id>/end           { reason: consent_denied | stopped | failed } → { ended }
//   POST devices/<id>/connect           a phone "ohne Code" → { request } (the phone always asks; then GET requests/<id>)
//   POST requests/<id>/connect          a phone → { session: { ref, expiresAt, protocol: 'screen', engine: 'screen', mode: 'view', device } }
//   GET  devices                        a phone: protocol 'screen', platform 'android', screen: { view: true, control: false }
//
// Since 1.4 (gc.remote version 5) — controlling a phone:
//   POST code/redeem / devices/<id>/connect  { mode: 'control' } to a phone → a request of mode control when its app can be
//                                       controlled, else mode view with modeReason (phone_view_only | server_view_only)
//   POST host/requests/<id> allow       { decision: 'allow', mode: 'control' | 'view' } — control only when asked and chosen
//   GET  devices                        a phone: screen: { view: true, control } (control: its app and GateControl can do it)

const devices = require('./devices');
const rights = require('./rights');
const connect = require('./connect');
const maintenance = require('./maintenance');
const hosts = require('./hosts');
const codes = require('./codes');
const support = require('./support');
const log = require('./log');
const recordings = require('./recordings');
const { fail, iso, posInt } = require('./util');

function personOf(req) {
  const u = req.user;
  if (!u || !Number.isSafeInteger(u.id) || u.loggedIn === false || u.kiosk === true || u.automation === true) throw fail('forbidden');
  return u;
}

/** A device as the portal shows it — no address, no secret. A PC: its owner, how one connects, its state. 1.2: SSH engine, tmux, recording. */
function deviceView(d, names, x = {}) {
  const v = {
    id: d.id, name: d.name, protocol: d.protocol, description: d.config.description || null,
    online: d.status.online, lastCheck: iso(d.status.lastCheck), browser: !!d.config.browser_enabled,
    maintenance: maintenance.inWindow(d.config), wake: !!(d.config.wol_enabled && d.config.wol_mac_address),
    credentialUnreadable: d.credentialUnreadable, tags: d.config.tags || [], kind: d.kind,
  };
  if (d.protocol === 'ssh') {
    v.engine = devices.engineOf(d, x.gc);
    v.tmux = v.engine === 'term' ? devices.tmuxOf(d) : null;
  }
  if (x.recording) v.recording = x.recording;
  if (d.kind === 'host') {
    v.platform = d.host.platform;
    if (devices.isPhone(d)) v.screen = { view: true, control: devices.phoneCanControl(x.gc, d) };
    v.owner = { id: d.host.owner, name: (names && names.get(d.host.owner)) || null };
    v.connect = { mode: devices.connectMode(d) };
    v.ready = devices.hostReady(d);
    v.state = hosts.stateOf(d);
  }
  return v;
}

async function namesOf(gc) {
  const m = new Map();
  try { for (const u of (await gc.users.list()) || []) m.set(u.id, u.name); } catch { /* names stay empty */ }
  return m;
}

/** The devices this person may use (administrators: every enabled one). */
async function mine(gc, user) {
  const r = await rights.of(gc, user);
  const lists = await devices.accessLists(gc);
  const out = [];
  for (const d of await devices.all(gc)) {
    if (await rights.mayUse(gc, user, d, lists.get(d.id) || devices.emptyAccess(), { rights: r })) out.push(d);
  }
  return { rights: r, list: out };
}

async function visibleFor(gc, user) {
  if (!user || !Number.isSafeInteger(user.id)) return false;
  const r = await rights.of(gc, user);
  return r.rdp || r.ssh || r.support;
}

async function overview(gc, user) {
  const { rights: r, list } = await mine(gc, user);
  const names = await namesOf(gc);
  // a switched-off PC is in the admin's list ("abgemeldet"), not in the portal
  const shown = list.filter((d) => d.kind !== 'host' || d.host.registered);
  const v3 = !!(gc.remote && gc.remote.version >= 3);
  const views = [];
  for (const d of shown) views.push(deviceView(d, names, { gc, recording: v3 ? await rights.policyFor(gc, user, d, { rights: r }) : null }));
  return {
    rights: { rdp: r.rdp, ssh: r.ssh, support: r.support, share: r.share },
    devices: views,
    recordings: v3 ? { watch: user.role === 'admin' || shown.some((d) => d.kind === 'host' && d.host.owner === user.id) } : null,
    hasRemote: !!gc.remote,
    // "Code eingeben": with the right to redeem support codes, or a PC that asks for a code
    codeEntry: !!(gc.remote && gc.remote.version >= 2) && (r.support || shown.some((d) => d.kind === 'host' && devices.connectMode(d) === 'code')),
  };
}

/** The profile section: what the person may do, how many devices that reaches, the own PCs and their protocol. */
async function profile(gc, user) {
  const { rights: r, list } = await mine(gc, user);
  const own = (await devices.all(gc)).filter((d) => d.kind === 'host' && d.host.owner === user.id);
  return {
    rights: { rdp: r.rdp, ssh: r.ssh, support: r.support, share: r.share }, source: r.source, admin: user.role === 'admin',
    // 1.2: "immer aufzeichnen" is visible to the person (their own setting or a group's) and on their own PCs
    recording: r.recording || null,
    devices: { total: list.length, rdp: list.filter((d) => rights.rightFor(d.protocol) === 'rdp').length, ssh: list.filter((d) => rights.rightFor(d.protocol) === 'ssh').length },
    hosts: own.map((d) => ({ id: d.id, name: d.name, platform: d.host.platform, registered: d.host.registered, online: d.host.online, shareMode: d.host.shareMode, allowOpen: d.host.allowOpen, recording: d.config.recording || 'off' })),
    history: own.length ? await log.list(gc, { ownerUserId: user.id, limit: 30 }) : [],
  };
}

/** The asking app installation of an app request, else null (portal). */
function helperDevice(req) {
  if (!req.user || req.user.app !== true) return null;
  try { return hosts.appDevice(req); } catch { return null; }
}

/** "Verbinden" with a PC: only "ohne Code" (owner's switch, admin allows) and with the right and access. */
async function connectHost(gc, user, d, req, { admin = false } = {}) {
  if (devices.connectMode(d) !== 'open') throw fail('code_required');
  const access = (await devices.accessLists(gc)).get(d.id) || devices.emptyAccess();
  if (!admin && !(await rights.mayUse(gc, user, d, access))) throw fail('no_right');
  const via = req.user && req.user.app === true ? 'app' : 'browser';
  // a phone always asks its person (and Android asks again): "ohne Code" spares the code, never the question
  if (devices.isPhone(d)) return { request: await support.create(gc, user, d, { mode: req.body && req.body.mode === 'control' ? 'control' : 'view', via, helperDevice: helperDevice(req) }) };
  return support.connectTo(gc, user, d, { mode: req.body && req.body.mode === 'view' && via === 'browser' ? 'view' : 'control', via, helperDevice: helperDevice(req) });
}

/** POST code/redeem { code, mode, via, deviceId? } → { request } */
async function redeem(gc, user, req) {
  if (!gc.remote || !(gc.remote.version >= 2)) throw fail('offline');
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const app = req.user && req.user.app === true;
  const via = b.via === 'app' || (b.via == null && app) ? 'app' : 'browser';
  if (via === 'app' && !app) throw fail('invalid', { field: 'via' });
  const pick = b.deviceId == null ? null : posInt(b.deviceId);
  if (b.deviceId != null && !pick) throw fail('invalid', { field: 'deviceId' });
  const id = await codes.check(gc, user, b.code, {
    deviceId: pick,
    deviceOf: (x) => devices.get(gc, x),
    onVoid: async (x) => { const d = await devices.get(gc, x); await support.signal(gc, d, { type: 'remote.code.void' }); },
  });
  const d = await devices.get(gc, id);
  if (!d || d.kind !== 'host') throw fail('code_invalid');
  await log.write(gc, 'remote_code_redeemed', { device: d, userId: user.id, details: { via } });
  return { request: await support.create(gc, user, d, { mode: b.mode, via, helperDevice: helperDevice(req) }) };
}

/** host/* — the PC's own app (never the portal). */
async function hostRoute(req, gc, seg, m) {
  if (!req.user || req.user.app !== true) throw fail('forbidden');
  if (!gc.remote || !(gc.remote.version >= 2)) throw fail('offline');
  if (seg.length === 1 && m === 'DELETE') return hosts.unregister(gc, req, support);
  const what = seg[1];
  if (seg.length === 2 && what === 'register' && m === 'POST') return hosts.register(gc, req);
  if (seg.length === 2 && what === 'state' && m === 'POST') return hosts.heartbeat(gc, req, support);
  if (seg.length === 2 && what === 'share' && m === 'PUT') return hosts.share(gc, req);
  if (seg.length === 2 && what === 'access' && (m === 'GET' || m === 'PUT')) return hosts.access(gc, req);
  const d = await hosts.mine(gc, req.user, hosts.appDevice(req));
  if (seg.length === 2 && what === 'code' && m === 'POST') {
    if (!d.host.registered) throw fail('not_found');
    if (!(await rights.of(gc, req.user)).share) throw fail('no_share_right');
    return codes.issue(gc, d.id);
  }
  if (seg.length === 2 && what === 'firewall') {
    if (m === 'GET') return support.openList(gc, d);
    if (m === 'POST') return support.report(gc, d, req.body);
  }
  if (seg.length === 3 && what === 'requests' && m === 'POST') return support.decide(gc, d, seg[2], req.body || {});
  if (seg.length === 4 && what === 'screen' && seg[3] === 'end' && m === 'POST') return support.phoneEnded(gc, d, seg[2], req.body || {});
  throw fail('not_found');
}

async function route(req, gc, seg, cfg) {
  const m = String(req.method || 'GET').toUpperCase();
  const user = personOf(req);
  if (seg[0] === 'overview' && m === 'GET' && seg.length === 1) return overview(gc, user);
  if (seg[0] === 'profile' && m === 'GET' && seg.length === 1) return profile(gc, user);
  if (seg[0] === 'devices' && seg.length === 1 && m === 'GET') {
    const o = await overview(gc, user);
    return { devices: o.devices, rights: o.rights, codeEntry: o.codeEntry };
  }
  if (seg[0] === 'devices' && seg.length === 3 && seg[2] === 'tmux' && m === 'GET') return connect.tmuxSessions(gc, user, seg[1]);
  if (seg[0] === 'devices' && seg.length === 3 && m === 'POST') {
    if (seg[2] === 'connect') {
      const d = await devices.need(gc, seg[1]);
      if (d.kind === 'host') return connectHost(gc, user, d, req);
      const b = req.body && typeof req.body === 'object' ? req.body : {};
      const via = b.via === 'app' && req.user && req.user.app === true ? 'app' : 'browser';
      if (b.via === 'app' && via !== 'app') throw fail('invalid', { field: 'via' });
      return { session: await connect.open(gc, user, seg[1], cfg, { admin: false, via, tmux: b.tmux, record: b.record }) };
    }
    if (seg[2] === 'wake') return { wake: await connect.wake(gc, user, seg[1], { admin: false }) };
  }
  if (seg[0] === 'code' && seg[1] === 'redeem' && seg.length === 2 && m === 'POST') return redeem(gc, user, req);
  if (seg[0] === 'requests' && seg.length === 2 && m === 'GET') return support.get(gc, user, seg[1]);
  if (seg[0] === 'requests' && seg.length === 3 && seg[2] === 'connect' && m === 'POST') {
    const app = req.user && req.user.app === true;
    return support.connectRequest(gc, user, seg[1], { via: app ? 'app' : 'browser', helperDevice: helperDevice(req) });
  }
  if (seg[0] === 'host') return hostRoute(req, gc, seg, m);
  if (seg[0] === 'recordings' && seg.length === 1 && m === 'GET') {
    const q = req.query || {};
    return { recordings: await recordings.list(gc, user, { deviceId: q.device, limit: q.limit }) };
  }
  if (seg[0] === 'recordings' && seg.length === 3 && seg[2] === 'play' && m === 'POST') return recordings.play(gc, user, seg[1]);
  throw fail('not_found');
}

module.exports = { route, visibleFor, overview, profile, deviceView, connectHost };
