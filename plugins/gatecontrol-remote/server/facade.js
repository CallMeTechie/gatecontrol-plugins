'use strict';

// The old app API /api/v1/client/rdp* answered from the plugin (hook
// clientFacade, docs/plugins.md "Facade for the old app API"). GateControl
// hands each request of the apps released before the plugin to this hook once
// the built-in data was taken over; the answers keep the old shape so Android
// and Windows keep working unchanged.
//
//   list              GET    /rdp                  the RDP devices the app's person may use
//   status            GET    /rdp/:id/status       a check of the device now
//   connect           GET    /rdp/:id/connect      connection data; credentials only through
//                                                  GateControl with ECDH (this answer names the
//                                                  vault handle, never a value)
//   browserSession    POST   /rdp/:id/browser-session   → GateControl makes the guacamole token
//   sessionStart / sessionHeartbeat / sessionEnd   the app's own session reports (history.js)
//   wake / statusAdmin / statusAll   (GateControl with gc.remote version 2) what the Windows app asks of the
//                                    admin API /api/v1/rdp: POST /:id/wol, GET /:id/status, GET /status
//
// A PC that registered itself (kind host, stage 2) is in `list` only while it is shared "ohne Code" and
// ready; `connect` opens its firewall for the app's own VPN address (selfIp) first, `sessionEnd` closes it.
//
// 1.9: as in the portal, administrators reach every device: an administrator's app sees every enabled RDP device
// and every registered PC (also with a code, also offline) and its state, and connects to a PC "ohne Code" like
// everybody on its list. A PC "nur mit Code" answers code_required to administrators, too (the code and the
// confirmation at the PC). Everybody else sees and uses what the access lists give them, as before.
//
// The same rules as the portal: the right of the protocol and the access list
// of the device (rights.js), the token's scope (client:rdp or full-access),
// enabled, the maintenance window, never the app's own computer (selfIp).
// A GateControl without `payload.server` (1.281.0) does not fill in the
// connect address of a gateway target or the device's DNS name: there the core
// keeps answering from its own tables ({ handled: false }).

const devices = require('./devices');
const rights = require('./rights');
const history = require('./history');
const connect = require('./connect');
const maintenance = require('./maintenance');
const support = require('./support');
const { iso, posInt, isKnown } = require('./util');

const json = (status, body) => ({ status, body });
const err = (status, error, extra) => json(status, { ok: false, error, ...(extra || {}) });

/** The route of the old API: every setting, the access lists as the old JSON text, booleans as booleans. */
function routeView(d, access, server) {
  const c = d.config;
  const out = { id: d.id, name: d.name, protocol: d.protocol, enabled: d.enabled };
  for (const k of [...Object.keys(devices.FIELDS), ...devices.KEPT]) out[k] = c[k] === undefined ? null : c[k];
  out.tags = JSON.stringify(Array.isArray(c.tags) ? c.tags : []);
  out.user_ids = access.users.length ? JSON.stringify(access.users) : null;
  out.group_ids = access.groups.length ? JSON.stringify(access.groups) : null;
  out.token_ids = access.tokens.length ? JSON.stringify(access.tokens) : null;
  out.has_credentials = !!d.credential;
  out.created_at = iso(d.createdAt);
  out.updated_at = iso(d.updatedAt);
  return { ...out, ...endpointOf(d, server) };
}

/** Where an app connects (resolveConnectEndpoint of the core): the server's address for a gateway target. */
function endpointOf(d, server) {
  const c = d.config;
  if (c.access_mode === 'gateway') return { connect_address: (server && server.connectHost) || null, connect_port: c.gateway_listen_port || c.port || 3389 };
  if ((c.access_mode === 'external' || c.access_mode === 'both') && c.external_hostname) return { connect_address: c.external_hostname, connect_port: c.external_port || c.port || 3389 };
  return { connect_address: c.host, connect_port: c.port || 3389 };
}

function statusOf(d) {
  return { online: d.status.online === true, lastCheck: iso(d.status.lastCheck) };
}

function hasScope(user) {
  const s = Array.isArray(user && user.scopes) ? user.scopes : [];
  return s.includes('full-access') || s.includes('client:rdp');
}

const personOf = (u) => (u && Number.isSafeInteger(u.id) && u.id > 0 ? u : null);

async function personWithRole(gc, u) {
  if (!personOf(u)) return null;
  let full = null;
  try { full = await gc.users.get(u.id); } catch { full = null; }
  return full ? { id: full.id, role: full.role, name: full.name } : null;
}

const isAdmin = (user) => !!(user && user.role === 'admin');

/** May the app's person use the device by its access list? The rights of the person and the access list (role user). */
async function allowed(gc, p, user, d, access, r) {
  return rights.mayUse(gc, user ? { id: user.id, role: 'user' } : null, d, access, { tokenId: p.user.tokenId, rights: r || (user ? await rights.of(gc, user) : undefined) });
}

/** 1.9: may the app's person see and use the device? Administrators every enabled one (as in the portal), everybody else what `allowed` gives. */
async function visible(gc, p, user, d, access, r) {
  if (isAdmin(user)) return !!d.enabled;
  return allowed(gc, p, user, d, access, r);
}

async function deviceFor(gc, p, user) {
  const d = await devices.get(gc, p.id);
  if (!d) return { error: err(404, 'RDP route not found') };
  const access = (await devices.accessLists(gc)).get(d.id) || devices.emptyAccess();
  return { d, access, ok: await visible(gc, p, user, d, access) };
}

async function list(gc, p, user) {
  const all = await devices.all(gc);
  const lists = await devices.accessLists(gc);
  const r = user ? await rights.of(gc, user) : null;
  const selfIp = p.user.selfIp || null;
  const out = [];
  for (const d of all) {
    if (d.protocol !== 'rdp' || !d.enabled) continue;
    if (selfIp && d.config.host === selfIp) continue;
    // a PC: only "ohne Code" and ready (with a code the old apps cannot ask); 1.9: an administrator every registered one
    if (d.kind === 'host' && (isAdmin(user) ? !d.host.registered : (devices.connectMode(d) !== 'open' || !devices.hostReady(d)))) continue;
    const access = lists.get(d.id) || devices.emptyAccess();
    if (!(await visible(gc, p, user, d, access, r))) continue;
    out.push({ ...routeView(d, access, p.server), status: statusOf(d) });
  }
  return json(200, { ok: true, routes: out });
}

function connectionOf(d, server) {
  const c = d.config;
  const conn = { id: d.id, name: d.name, host: c.host, port: c.port, ...endpointOf(d, server) };
  for (const k of ['external_hostname', 'external_port', 'access_mode', 'gateway_host', 'gateway_port', 'credential_mode', 'domain', 'resolution_mode',
    'resolution_width', 'resolution_height', 'multi_monitor', 'color_depth', 'redirect_clipboard', 'redirect_printers', 'redirect_drives', 'redirect_usb',
    'redirect_smartcard', 'audio_mode', 'network_profile', 'nla_enabled', 'disable_wallpaper', 'disable_themes', 'disable_animations', 'bandwidth_limit',
    'session_timeout', 'admin_session', 'remote_app', 'start_program', 'wol_enabled', 'maintenance_enabled', 'maintenance_schedule']) conn[k] = c[k] === undefined ? null : c[k];
  return conn;
}

async function connectOp(gc, p, user) {
  const x = await deviceFor(gc, p, user);
  if (x.error) return x.error;
  const d = x.d;
  if (d.protocol !== 'rdp') return err(400, 'Only RDP targets can be opened in the app');
  if (!d.enabled) return err(403, 'RDP route is disabled');
  if (p.user.selfIp && p.user.selfIp === d.config.host) return err(400, 'Cannot RDP to the host you are running on');
  if (!x.ok) return err(403, 'Not authorized for this RDP route');
  if (maintenance.inWindow(d.config)) return err(503, 'Route is in maintenance window', { maintenance: true, maintenance_schedule: d.config.maintenance_schedule });
  if (d.kind === 'host') return connectHost(gc, p, user, d);
  const connection = connectionOf(d, p.server);
  connection.online = d.status.online === true;
  if (d.config.credential_mode !== 'none' && (d.credential || d.credentialUnreadable)) {
    if (d.credentialUnreadable) return err(409, 'credentials_invalid');
    const fields = d.config.credential_mode === 'user_only' ? ['username', 'domain'] : ['username', 'password', 'domain'];
    return { status: 200, body: { ok: true, connection }, credential: { handle: d.credential, fields } };
  }
  return json(200, { ok: true, connection });
}

/** A PC "ohne Code": its firewall opens for the app's own VPN address, then the connection (no stored credentials). */
async function connectHost(gc, p, user, d) {
  if (devices.connectMode(d) !== 'open') return err(403, 'code_required');
  if (!devices.hostReady(d)) return err(503, 'Host is offline');
  if (!user || !p.user.selfIp) return err(400, 'no_vpn');
  try {
    await support.open(gc, d, { allow: p.user.selfIp, via: 'app', helperUserId: user.id, helperTokenId: posInt(p.user.tokenId), waitMs: support.TIMING.facadeWaitMs });
  } catch (e) {
    if (isKnown(e) && (e.code === 'firewall_timeout' || e.code === 'firewall_failed')) return err(504, e.code);
    throw e;
  }
  return json(200, { ok: true, connection: { ...support.connectionOf(d), online: true } });
}

/** The state of a device: a PC as its app reports it, any other device checked now. */
async function stateNow(gc, d) {
  if (d.kind === 'host') return { online: d.status.online === true, responseTime: null, lastCheck: iso(d.status.lastCheck) };
  return connect.probe(gc, d);
}

async function statusOp(gc, p, user) {
  const x = await deviceFor(gc, p, user);
  if (x.error) return x.error;
  if (!x.ok) return err(403, 'Not authorized for this RDP route');
  return json(200, { ok: true, status: await stateNow(gc, x.d) });
}

/** The admin API the Windows app uses (GateControl with gc.remote version 2): wake, statusAdmin, statusAll. */
async function adminOp(gc, p, user) {
  if (p.op === 'statusAll') {
    const lists = await devices.accessLists(gc);
    const r = user ? await rights.of(gc, user) : null;
    const statuses = {};
    for (const d of await devices.all(gc)) {
      if (d.protocol !== 'rdp' || !d.enabled) continue;
      if (!(await visible(gc, p, user, d, lists.get(d.id) || devices.emptyAccess(), r))) continue;
      statuses[d.id] = { online: d.status.online === true, responseTime: d.status.responseTime, lastCheck: iso(d.status.lastCheck) };
    }
    return json(200, { ok: true, statuses });
  }
  const x = await deviceFor(gc, p, user);
  if (x.error) return x.error;
  if (!x.ok) return err(403, 'Not authorized for this RDP route');
  if (p.op === 'statusAdmin') return json(200, { ok: true, id: x.d.id, ...(await stateNow(gc, x.d)) });
  if (!x.d.config.wol_enabled || !x.d.config.wol_mac_address) return err(400, 'Wake-on-LAN is not configured for this route');
  try {
    const w = await connect.wake(gc, user, x.d.id, { admin: true });
    return json(200, { ok: true, message: w && w.via === 'gateway' ? 'Magic packet sent via gateway' : 'Magic packet sent' });
  } catch (e) {
    if (isKnown(e) && e.code === 'rate_limited') return err(429, 'WoL cooldown — try again in a few seconds');
    if (isKnown(e)) return err(500, 'Failed to send Wake-on-LAN packet');
    throw e;
  }
}

const BROWSER_ERR = {
  disabled: [403, 'not_enabled'], no_right: [403, 'not_authorized'], no_browser: [403, 'not_enabled'], credential_unreadable: [409, 'mint_failed'],
  maintenance: [503, 'maintenance_active'], limit: [429, 'limit_reached'],
};

async function browserOp(gc, p, user, cfg) {
  const x = await deviceFor(gc, p, user);
  if (x.error) return err(404, 'not_found');
  const d = x.d;
  if (!user || !x.ok) return err(403, 'not_authorized');
  // a PC: browser sessions only from the portal (the firewall belongs to the ticket there)
  if (d.kind === 'host') return err(403, 'not_enabled');
  try {
    await connect.admit(gc, user, d, x.access, { admin: true });
    // the plugin's own limits; GateControl checks its own when it makes the token
    const cfgLimits = cfg || {};
    if (cfgLimits.maxPerUser || cfgLimits.maxPerDevice) {
      const live = (await gc.remote.sessions({ active: true, limit: 500 })) || [];
      if ((cfgLimits.maxPerUser && live.filter((s) => s.userId === user.id).length >= cfgLimits.maxPerUser)
        || (cfgLimits.maxPerDevice && live.filter((s) => s.targetId === 'dev-' + d.id).length >= cfgLimits.maxPerDevice)) return err(429, 'limit_reached');
    }
  } catch (e) {
    const m = isKnown(e) && BROWSER_ERR[e.code];
    if (m) return err(m[0], m[1]);
    throw e;
  }
  return { guac: { target: devices.targetOf(d), protocol: d.protocol, mode: 'control', ...(d.credential ? { credential: d.credential } : {}), options: connect.optionsOf(d) } };
}

function who(p, user) {
  return { userId: user ? user.id : null, tokenId: posInt(p.user.tokenId), peerId: posInt(p.user.peerId), tokenName: null, ip: p.ip || null };
}

async function sessionOp(gc, p, user) {
  const b = p.body && typeof p.body === 'object' ? p.body : {};
  try {
    if (p.op === 'sessionStart') {
      const x = await deviceFor(gc, p, user);
      if (x.error) return x.error;
      if (!x.ok) return err(403, 'Not authorized for this RDP route');
      return json(201, { ok: true, session: await history.nativeStart(gc, x.d, who(p, user)) });
    }
    if (p.op === 'sessionHeartbeat') {
      if (!b.sessionId) return err(400, 'sessionId required');
      await history.heartbeat(gc, b.sessionId, who(p, user));
      return json(200, { ok: true });
    }
    const id = posInt(p.id);
    const ended = await history.nativeEnd(gc, id, b.sessionId == null ? null : b.sessionId, b.endReason, who(p, user));
    // a PC: the rule for this app closes with its session
    if (id) await support.appSessionEnded(gc, id, posInt(p.user.tokenId));
    return json(200, { ok: true, session: ended });
  } catch (e) {
    if (!isKnown(e)) throw e;
    const msg = (e.extra && e.extra.message) || e.code;
    return err(e.code === 'forbidden' ? 403 : e.code === 'not_found' ? 404 : 400, msg);
  }
}

/** The hook. `cfg` = the plugin's settings. */
async function handle(p, gc, cfg) {
  if (!p || typeof p !== 'object' || !p.user) return { handled: false };
  // GateControl 1.281.0 (no `server`): the core keeps answering from its own tables
  if (!p.server || typeof p.server !== 'object') return { handled: false };
  if (!hasScope(p.user)) return err(403, 'Token does not have client:rdp permission');
  const user = await personWithRole(gc, p.user);
  switch (p.op) {
    case 'list': return list(gc, p, user);
    case 'status': return statusOp(gc, p, user);
    case 'connect': return connectOp(gc, p, user);
    case 'browserSession': return browserOp(gc, p, user, cfg);
    case 'sessionStart': case 'sessionHeartbeat': case 'sessionEnd': return sessionOp(gc, p, user);
    case 'wake': case 'statusAdmin': case 'statusAll': return adminOp(gc, p, user);
    default: return { handled: false };
  }
}

module.exports = { handle, routeView, endpointOf, connectionOf };
