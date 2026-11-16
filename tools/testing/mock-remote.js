'use strict';

// GateControl 1.281.0 for the mock host (tools/testing/mock-host.js): gc.remote version 1 — "Fernzugriff"
// (src/services/remote/, hostApi.js remoteCall, the child bootstrap's makeRemote; docs/plugins.md "Remote access").
// Opt-in: opts.gatecontrol ≥ '1.281.0' or opts.remote; only a plugin with permissions.remote: true has gc.remote (an
// older GateControl ignores the key — no gc.remote; a value other than a boolean is an invalid manifest).
//
//   createHost(dir, { remote: {
//     gateways: [{ peerId, name, online }], pools: [{ poolId, name }],   // gateway peers the host knows
//     l4: [{ peerId | poolId, host, port, listenPort }],                    // L4 routes that exist already (old RDP routes)
//     probe: (target) => ({ online, responseTime }),                       // default: online, 5 ms
//     limits: { global: 10, perUser: 2, perTarget: 2 },                     // config.guac
//     resolve: { 'pc.example': '10.8.0.20' },                               // host names (anything else: ERR_REMOTE_UNREACHABLE)
//   } })
//
// Like the host:
//   session({ user, target, protocol, mode?, record?, credential?, options?, ttlS? }) → { ref, url, expiresAt, mode, protocol }
//     an enabled person (ERR_NOT_FOUND), the plugin licensed (host.license.licensed, ERR_REMOTE_UNLICENSED), the target
//     rules (ERR_INVALID; loopback, link-local, unspecified, multicast, broadcast, reserved and the hub address 10.8.0.1 →
//     ERR_REMOTE_NOT_ALLOWED; a gateway target without listener → ERR_REMOTE_LISTENER_REQUIRED; an unknown listener →
//     ERR_NOT_FOUND), protocol rdp|vnc|ssh|telnet, mode view|control, record: true → ERR_REMOTE_RECORDING_UNAVAILABLE,
//     a credential handle of this plugin (ERR_REMOTE_CREDENTIAL_NOT_FOUND, ERR_REMOTE_CREDENTIAL_UNREADABLE), options of
//     the old rdp_routes only (anything else ERR_INVALID), ttlS 30 … 600, the limits (ERR_REMOTE_LIMIT, counted from the
//     open tunnels)
//   end({ ref } | { sessionId }) → { ended }   sessions({ active, targetId, limit }) → rows newest first
//   vault.put/remove/info/list — metadata only, never a value; ≤ 5000 entries (ERR_REMOTE_LIMIT)
//   probe(target) → { online, responseTime, via }   wake(target) → { sent, via } (once per 10 s and MAC: ERR_REMOTE_RATE_LIMITED)
//   listener({ key, gateway, host, port, listenPort }) → { key, routeId, listenPort, gateway, lanHost, lanPort, enabled, shared }
//     (an L4 route of opts.remote.l4 with exactly this target is reused: shared; a port of another listener →
//     ERR_REMOTE_PORT_IN_USE; an unknown gateway peer → ERR_NOT_FOUND), listener.remove(key), listeners()
//   recordings.available() → { available: false, reason: 'not_yet' }, list → [], stream → ERR_REMOTE_RECORDING_UNAVAILABLE
//   on('session', fn) — the hook remoteSession
// GateControl after 1.281.0 (the server part of Fernzugriff 1.0; opt-in opts.gatecontrol ≥ '1.283.0' or opts.remote.gateways):
//   gc.remote.gateways() → { gateways: [{ peerId, name, online }], pools: [{ poolId, name }] }, and `server: { connectHost }`
//   in the payload of the hook clientFacade (opts.remote.connectHost, default 'gc.example.test').
// GateControl with gc.remote version 2 (stage 2, the Windows switch; opt-in opts.gatecontrol ≥ '1.284.0' or opts.remote.v2):
//   gc.remote.version 2, gc.remote.hubAddress() → '10.8.0.1', `from` (the hub address; null for a listener target) in the
//   answer of session, gc.remote.peerAddress(userId, deviceId) → the device's `vpnIp` of opts.devices (null without) —
//   only for a device of that person and only while a request of that person is in flight (ERR_REMOTE_NOT_ALLOWED), and
//   the facade ops wake / statusAdmin / statusAll pass through host.clientFacade like the others.
// GateControl with gc.remote version 3 (stage 3, SSH terminal and recordings; opt-in opts.gatecontrol ≥ '1.285.0' or
// opts.remote.v3):
//   session({ …, engine: guac|term, record, options.tmux: { attach | create } }) → { …, engine, record } — engine term for
//     ssh only and with a credential that has a username and a password or key (ERR_REMOTE_CREDENTIAL_REQUIRED), tmux names
//     ^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$ (ERR_INVALID), record only while recordings.available() allows the engine
//     (ERR_REMOTE_RECORDING_UNAVAILABLE)
//   vault.generate({ kind: 'ed25519', label, username, handle }) → metadata + publicKey ('ssh-ed25519 AAAA… <label>')
//   tmux.list(target, { credential }) → opts.remote.tmux[target.id]: an array, or 'unavailable' | 'unpinned' | 'mismatch'
//     (ERR_REMOTE_TMUX_UNAVAILABLE / _HOST_KEY_UNPINNED / _HOST_KEY_MISMATCH); default []
//   hostKeys.pin / list / remove (in memory: host.remote.hostKeys)
//   recordings.available() → opts.remote.recordings (default { available: true, reason: null, engines: { term: true, guac: true },
//     usedBytes: 0, maxBytes: 10 GiB, days: 30 }); a ticket with record: true leaves a recording when its tunnel closes;
//     list({ targetId, userId, limit }), stream(id, { user }) → { ref, url, expiresAt, format } (ERR_INVALID without user),
//     remove(id) → { removed }
//   host.remoteOpen(ref, { via, hostKey }) → start with engine, via, record, recordingId (and hostKey for a terminal);
//   host.remoteView(ref) — the person opened a playback ticket: event phase recording_viewed
// The session page and the old app API for tests:
//   host.remoteOpen(ref)                    the person opens the page: a tunnel opens → { sessionId }, event phase start
//   host.remoteClose(sessionId, reason)     the tunnel ends (normal → end, heartbeat … → abort)
//   host.clientFacade(op, { id, query, body, user, ip })  the core's middleware: { status, body } as the app gets it
//     (credential keys removed, credentials_e2ee from the vault only with query.ecdhPublicKey — else 400 ecdh_required —,
//     { guac } → { ok, token, wsPath, ttl }; a plugin answer { handled: false } → { handled: false })
//   host.remote = { tickets, live, vault, listeners, wakes, calls }   host.remoteVaultSeed(entry, source) (a handle as legacy.js makes it)

const crypto = require('node:crypto');
const net = require('node:net');

const PROTOCOLS = ['rdp', 'vnc', 'ssh', 'telnet'];
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const HOST_RE = /^[A-Za-z0-9.-]{1,253}$/;
const MAC_RE = /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/;
const HANDLE_RE = /^rv_[0-9a-f]{32}$/;
const HUB = '10.8.0.1';
const TMUX_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const REC_RE = /^rr_[0-9a-f]{32}$/;
const OPTION_RULES = {
  browser_clipboard: 'bool', color_depth: [8, 16, 24, 32], nla_enabled: 'bool', network_profile: ['lan', 'broadband', 'modem', 'auto'],
  disable_wallpaper: 'bool', disable_themes: 'bool', disable_animations: 'bool', redirect_printers: 'bool', rdp_disable_audio: 'bool',
  resolution_mode: ['fullscreen', 'fixed', 'dynamic'], resolution_width: 'dim', resolution_height: 'dim', domain: 'text',
};

/** The address classes the host refuses (ipaddr.js ranges, as targets.js). */
function blocked(ip) {
  if (ip === HUB) return true;
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 127 || a === 0 || (a === 169 && b === 254) || a >= 224 || ip === '255.255.255.255';
  }
  const l = ip.toLowerCase();
  return l === '::1' || l === '::' || l.startsWith('fe80:') || l.startsWith('ff');
}

function install({ opts, perms, atLeast, enabledUser, hostError, license, personCtx, deviceList }) {
  const o = opts.remote && typeof opts.remote === 'object' ? opts.remote : null;
  const host = !!o || atLeast(281);
  if (host && perms.remote != null && typeof perms.remote !== 'boolean') throw hostError('ERR_INVALID', 'plugin.json: permissions.remote: invalid');
  const on = host && perms.remote === true;
  const next = !!(o && (o.gateways || o.pools || o.connectHost)) || atLeast(283);
  const v2 = !!(o && o.v2) || atLeast(284);
  const v3 = !!(o && o.v3) || atLeast(285);
  const state = { tickets: new Map(), live: new Map(), rows: [], vault: new Map(), listeners: new Map(), wakes: new Map(), calls: [], handlers: [], seq: 0, routeSeq: 500,
    hostKeys: new Map(), recordings: [], plays: new Map() };
  const recAvail = () => (v3 ? { available: true, reason: null, engines: { term: true, guac: true }, usedBytes: 0, maxBytes: 10 * 1024 ** 3, days: 30, ...((o && o.recordings) || {}) }
    : { available: false, reason: 'not_yet' });
  const cfg = { gateways: (o && o.gateways) || [], pools: (o && o.pools) || [], l4: (o && o.l4) || [], limits: { global: 10, perUser: 2, perTarget: 2, ...((o && o.limits) || {}) } };
  const need = () => { if (perms.remote !== true) throw hostError('ERR_REMOTE_DENIED', 'this plugin has no remote permission'); };
  const iso = (ms) => new Date(ms).toISOString();

  function portOf(v, what) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw hostError('ERR_INVALID', `${what}: 1…65535`);
    return n;
  }
  function normalise(t) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) throw hostError('ERR_INVALID', 'target required');
    const id = t.id == null ? null : String(t.id);
    if (!id || !ID_RE.test(id)) throw hostError('ERR_INVALID', 'target.id: 1…64 of A-Z a-z 0-9 . _ : -');
    const out = { id, name: t.name == null ? null : String(t.name).slice(0, 120) };
    if (t.listener != null) {
      if (typeof t.listener !== 'string' || !KEY_RE.test(t.listener)) throw hostError('ERR_INVALID', 'target.listener: a listener key');
      out.listener = t.listener;
    } else {
      if (typeof t.host !== 'string' || !t.host.trim() || t.host.length > 253) throw hostError('ERR_INVALID', 'target.host required');
      out.host = t.host.trim();
      out.port = portOf(t.port, 'target.port');
    }
    if (t.gateway != null) {
      const pid = Number(t.gateway && t.gateway.peerId);
      if (!Number.isSafeInteger(pid) || pid <= 0) throw hostError('ERR_INVALID', 'target.gateway.peerId');
      out.gatewayPeerId = pid;
    }
    if (t.mac != null) {
      if (typeof t.mac !== 'string' || !MAC_RE.test(t.mac.trim())) throw hostError('ERR_INVALID', 'target.mac: AA:BB:CC:DD:EE:FF');
      out.mac = t.mac.trim();
    }
    return out;
  }
  function resolve(h) {
    if (net.isIP(h)) { if (blocked(h)) throw hostError('ERR_REMOTE_NOT_ALLOWED', 'this address may not be used as a remote target'); return h; }
    if (!HOST_RE.test(h)) throw hostError('ERR_INVALID', 'invalid host');
    const ip = o && o.resolve && o.resolve[h];
    if (!ip) throw hostError('ERR_REMOTE_UNREACHABLE', 'the host name does not resolve');
    if (blocked(ip)) throw hostError('ERR_REMOTE_NOT_ALLOWED', 'this host name points to an address that may not be used');
    return ip;
  }
  function endpoint(t) {
    if (t.listener) {
      const l = state.listeners.get(t.listener);
      if (!l) throw hostError('ERR_NOT_FOUND', 'no such listener of this plugin');
      return { host: HUB, port: l.listenPort, listener: l };
    }
    if (t.gatewayPeerId) return { host: null, port: t.port, gatewayPeerId: t.gatewayPeerId };
    return { host: resolve(t.host), port: t.port };
  }
  function cleanOptions(x) {
    const out = {};
    if (x == null) return out;
    if (typeof x !== 'object' || Array.isArray(x)) throw hostError('ERR_INVALID', 'options: an object');
    for (const [k, v] of Object.entries(x)) {
      if (k === 'tmux' && v3) continue;
      const rule = OPTION_RULES[k];
      if (!rule) throw hostError('ERR_INVALID', `options.${k}: unknown`);
      if (v == null) continue;
      if (rule === 'bool') { if (typeof v !== 'boolean') throw hostError('ERR_INVALID', `options.${k}: true or false`); out[k] = v; } else if (rule === 'dim') {
        if (!Number.isInteger(v) || v < 1 || v > 7680) throw hostError('ERR_INVALID', `options.${k}: 1…7680`);
        out[k] = v;
      } else if (rule === 'text') { if (typeof v !== 'string' || v.length > 256) throw hostError('ERR_INVALID', `options.${k}: ≤ 256 characters`); out[k] = v; } else if (!rule.includes(v)) throw hostError('ERR_INVALID', `options.${k}: one of ${rule.join(', ')}`);
      else out[k] = v;
    }
    return out;
  }
  const meta = (e) => ({ handle: e.handle, kind: e.secret.privateKey ? 'ssh_key' : (e.secret.password ? 'password' : 'username'), label: e.label,
    has: Object.fromEntries(['username', 'password', 'domain', 'privateKey', 'passphrase'].map((k) => [k, !!e.secret[k]])), readable: e.readable !== false,
    ...(v3 ? { publicKey: e.publicKey || null } : {}), createdAt: iso(e.createdAt), updatedAt: iso(e.updatedAt) });
  function vaultPut(entry, source) {
    const x = entry && typeof entry === 'object' ? entry : {};
    const fields = ['username', 'password', 'domain', 'privateKey', 'passphrase'];
    for (const k of fields) if (x[k] != null && (typeof x[k] !== 'string' || x[k].length > (k === 'privateKey' ? 16384 : 1024))) throw hostError('ERR_INVALID', `${k}: text`);
    let e = null;
    if (x.handle != null) {
      if (typeof x.handle !== 'string' || !state.vault.has(x.handle)) throw hostError('ERR_NOT_FOUND', 'no such vault entry');
      e = state.vault.get(x.handle);
    } else if (source) e = [...state.vault.values()].find((v) => v.source === source) || null;
    const now = Date.now();
    if (!e) {
      if (state.vault.size >= 5000) throw hostError('ERR_REMOTE_LIMIT', 'at most 5000 vault entries');
      e = { handle: 'rv_' + crypto.randomBytes(16).toString('hex'), secret: {}, label: null, source: source || null, createdAt: now, updatedAt: now, readable: true };
      state.vault.set(e.handle, e);
    }
    for (const k of fields) if (x[k] !== undefined) { if (x[k] === null || x[k] === '') delete e.secret[k]; else e.secret[k] = x[k]; }
    if (x.privateKey !== undefined) e.publicKey = null;
    if (x.label !== undefined) e.label = x.label == null ? null : String(x.label).slice(0, 120);
    e.updatedAt = now;
    e.readable = true;
    return meta(e);
  }
  const ticketView = (t) => ({ ref: t.ref, url: '/remote/session/' + t.ref, expiresAt: iso(t.openBy), mode: t.mode, protocol: t.protocol,
    ...(v2 ? { from: t.target.listener ? null : HUB } : {}), ...(v3 ? { engine: t.engine, record: t.record } : {}) });
  const rowView = (r) => ({ id: r.id, targetId: r.targetId, targetName: r.targetName, userId: r.userId, protocol: r.protocol, mode: r.mode, record: !!r.record,
    ...(v3 ? { engine: r.engine, via: r.via, recordingId: r.recordingId || null } : {}),
    status: r.endedAt ? 'ended' : 'active', startedAt: iso(r.startedAt), endedAt: r.endedAt ? iso(r.endedAt) : null, durationSeconds: r.durationSeconds == null ? null : r.durationSeconds, endReason: r.endReason || null });
  const openOf = (pred) => state.rows.filter((r) => !r.endedAt && pred(r)).length;

  async function emit(ev) {
    for (const fn of state.handlers.slice()) { try { await fn(Object.freeze({ ...ev })); } catch { /* the host only logs */ } }
  }

  const api = {
    'remote.session': async (a) => {
      need();
      const uid = Number(a.user);
      if (!Number.isSafeInteger(uid) || uid <= 0) throw hostError('ERR_INVALID', 'user: a user id');
      if (!enabledUser(uid)) throw hostError('ERR_NOT_FOUND', 'no such enabled person');
      if (!license.licensed) throw hostError('ERR_REMOTE_UNLICENSED', 'the plugin has no valid licence');
      const t = normalise(a.target);
      if (!t.listener && t.gatewayPeerId) throw hostError('ERR_REMOTE_LISTENER_REQUIRED', 'a LAN target of a gateway needs a listener');
      const ep = endpoint(t);
      if (!PROTOCOLS.includes(a.protocol)) throw hostError('ERR_INVALID', 'protocol: rdp, vnc, ssh or telnet');
      const mode = a.mode == null ? 'control' : a.mode;
      if (mode !== 'view' && mode !== 'control') throw hostError('ERR_INVALID', 'mode: view or control');
      const engine = a.engine == null || !v3 ? 'guac' : a.engine;
      if (engine !== 'guac' && engine !== 'term') throw hostError('ERR_INVALID', 'engine: guac or term');
      if (engine === 'term' && a.protocol !== 'ssh') throw hostError('ERR_INVALID', 'engine term: protocol ssh only');
      if (a.record != null && typeof a.record !== 'boolean') throw hostError('ERR_INVALID', 'record: true or false');
      if (a.record === true) {
        const av = recAvail();
        if (!av.available || (engine === 'guac' && !av.engines.guac)) throw hostError('ERR_REMOTE_RECORDING_UNAVAILABLE', av.reason || 'guacd_no_drive');
      }
      const credential = a.credential == null ? null : String(a.credential);
      if (credential != null) {
        const e = HANDLE_RE.test(credential) ? state.vault.get(credential) : null;
        if (!e) throw hostError('ERR_REMOTE_CREDENTIAL_NOT_FOUND', 'no such vault entry of this plugin');
        if (e.readable === false) throw hostError('ERR_REMOTE_CREDENTIAL_UNREADABLE', 'the vault entry cannot be read');
        if (engine === 'term' && !(e.secret.username && (e.secret.password || e.secret.privateKey))) throw hostError('ERR_REMOTE_CREDENTIAL_REQUIRED', 'username and a password or key');
      } else if (engine === 'term') throw hostError('ERR_REMOTE_CREDENTIAL_REQUIRED', 'the terminal needs a vault entry');
      let tmux = null;
      if (v3 && a.options && a.options.tmux != null) {
        const x = a.options.tmux;
        const k = x && typeof x === 'object' ? Object.keys(x) : [];
        if (engine !== 'term' || k.length !== 1 || (k[0] !== 'attach' && k[0] !== 'create') || typeof x[k[0]] !== 'string' || !TMUX_RE.test(x[k[0]])) throw hostError('ERR_INVALID', 'options.tmux');
        tmux = { [k[0]]: x[k[0]] };
      }
      const options = cleanOptions(a.options);
      const ttl = a.ttlS == null ? 120 : Number(a.ttlS);
      if (!Number.isInteger(ttl) || ttl < 30 || ttl > 600) throw hostError('ERR_INVALID', 'ttlS: 30…600');
      if (openOf(() => true) >= cfg.limits.global || openOf((r) => r.userId === uid) >= cfg.limits.perUser || openOf((r) => r.targetId === t.id) >= cfg.limits.perTarget) {
        throw hostError('ERR_REMOTE_LIMIT', 'too many open sessions');
      }
      const ref = crypto.randomBytes(32).toString('base64url').slice(0, 43);
      const tk = { ref, userId: uid, target: t, endpoint: ep, protocol: a.protocol, mode, credential, options, engine, record: a.record === true, tmux, openBy: Date.now() + ttl * 1000, opened: false };
      state.tickets.set(ref, tk);
      state.calls.push({ op: 'session', ref, user: uid, target: t, protocol: a.protocol, mode, credential, options, engine, record: a.record === true, tmux });
      return ticketView(tk);
    },
    'remote.end': async (a) => {
      need();
      if (a.ref != null) {
        const t = state.tickets.get(a.ref);
        if (!t) return { ended: false };
        state.tickets.delete(a.ref);
        for (const r of state.rows) if (r.ref === a.ref && !r.endedAt) await closeRow(r, 'ended_by_plugin');
        return { ended: true };
      }
      if (a.sessionId != null) {
        const r = state.rows.find((x) => x.id === Number(a.sessionId) && !x.endedAt);
        if (!r) return { ended: false };
        await closeRow(r, 'ended_by_plugin');
        return { ended: true };
      }
      throw hostError('ERR_INVALID', 'ref or sessionId');
    },
    'remote.sessions': async (a) => {
      need();
      const lim = Math.min(500, Number.isInteger(a.limit) && a.limit > 0 ? a.limit : 100);
      return state.rows.filter((r) => (a.active ? !r.endedAt : true) && (a.targetId ? r.targetId === a.targetId : true)).slice().reverse().slice(0, lim).map(rowView);
    },
    'remote.vault.put': async (a) => { need(); return vaultPut(a.entry, null); },
    'remote.vault.remove': async (a) => { need(); if (typeof a.handle !== 'string' || !HANDLE_RE.test(a.handle)) throw hostError('ERR_INVALID', 'invalid handle'); return { removed: state.vault.delete(a.handle) }; },
    'remote.vault.info': async (a) => { need(); if (typeof a.handle !== 'string' || !HANDLE_RE.test(a.handle)) throw hostError('ERR_INVALID', 'invalid handle'); const e = state.vault.get(a.handle); return e ? meta(e) : null; },
    'remote.vault.list': async () => { need(); return [...state.vault.values()].map(meta); },
    'remote.probe': async (a) => {
      need();
      const t = normalise(a.target);
      const ep = endpoint(t);
      const via = ep.listener || ep.gatewayPeerId ? 'gateway' : 'direct';
      const r = o && typeof o.probe === 'function' ? (await o.probe(t)) || {} : { online: true, responseTime: 5 };
      state.calls.push({ op: 'probe', target: t });
      return { online: !!r.online, responseTime: r.responseTime == null ? null : r.responseTime, via };
    },
    'remote.wake': async (a) => {
      need();
      const t = normalise(a.target);
      if (!t.mac) throw hostError('ERR_INVALID', 'target.mac required');
      const k = t.mac.toLowerCase();
      const now = Date.now();
      if (now - (state.wakes.get(k) || 0) < 10000) throw hostError('ERR_REMOTE_RATE_LIMITED', 'wake-up sent a moment ago');
      state.wakes.set(k, now);
      if (t.listener && !state.listeners.has(t.listener)) throw hostError('ERR_NOT_FOUND', 'no such listener of this plugin');
      state.calls.push({ op: 'wake', target: t });
      return { sent: true, via: t.listener || t.gatewayPeerId ? 'gateway' : 'server' };
    },
    'remote.listener': async (a) => {
      need();
      const x = a.target && typeof a.target === 'object' ? a.target : {};
      if (typeof x.key !== 'string' || !KEY_RE.test(x.key)) throw hostError('ERR_INVALID', 'key: a-z 0-9 . _ - (≤ 64)');
      const g = x.gateway && typeof x.gateway === 'object' ? x.gateway : {};
      const peerId = g.peerId == null ? null : Number(g.peerId);
      const poolId = g.poolId == null ? null : Number(g.poolId);
      if (!((Number.isSafeInteger(peerId) && peerId > 0) || (Number.isSafeInteger(poolId) && poolId > 0))) throw hostError('ERR_INVALID', 'gateway: { peerId } or { poolId }');
      if (typeof x.host !== 'string' || !x.host.trim()) throw hostError('ERR_INVALID', 'host required');
      const port = portOf(x.port, 'port');
      const listenPort = x.listenPort == null ? port : portOf(x.listenPort, 'listenPort');
      if (peerId && cfg.gateways.length && !cfg.gateways.some((gw) => gw.peerId === peerId)) throw hostError('ERR_NOT_FOUND', 'gateway not found');
      const same = (r) => r.host === x.host.trim() && r.port === port && r.listenPort === listenPort && (peerId ? r.peerId === peerId : r.poolId === poolId);
      const shared = cfg.l4.find((r) => same({ peerId: r.peerId || null, poolId: r.poolId || null, host: r.host, port: r.port, listenPort: r.listenPort || r.port }));
      for (const [k, l] of state.listeners) if (k !== x.key && l.listenPort === listenPort) throw hostError('ERR_REMOTE_PORT_IN_USE', 'this port is in use');
      if (!shared && cfg.l4.some((r) => (r.listenPort || r.port) === listenPort)) throw hostError('ERR_REMOTE_PORT_IN_USE', 'this port is in use');
      const l = { key: x.key, routeId: ++state.routeSeq, listenPort, gateway: peerId ? { peerId } : { poolId }, lanHost: x.host.trim(), lanPort: port, enabled: true, shared: !!shared, peerId, poolId };
      state.listeners.set(x.key, l);
      state.calls.push({ op: 'listener', key: x.key, shared: !!shared });
      const { peerId: _p, poolId: _q, ...view } = l;
      return view;
    },
    'remote.listener.remove': async (a) => {
      need();
      if (typeof a.key !== 'string' || !KEY_RE.test(a.key)) throw hostError('ERR_INVALID', 'invalid key');
      return { removed: state.listeners.delete(a.key) };
    },
    'remote.listeners': async () => { need(); return [...state.listeners.values()].map(({ peerId, poolId, ...v }) => v); },
    'remote.recordings.available': async () => { need(); return recAvail(); },
    'remote.recordings.list': async (a) => {
      need();
      const lim = Math.min(500, Number.isInteger(a.limit) && a.limit > 0 ? a.limit : 100);
      return state.recordings.filter((r) => (a.targetId == null || r.targetId === String(a.targetId)) && (a.userId == null || r.userId === Number(a.userId))).slice().reverse().slice(0, lim).map((r) => ({ ...r }));
    },
    'remote.recordings.stream': async (a) => {
      need();
      if (!v3) throw hostError('ERR_REMOTE_RECORDING_UNAVAILABLE', 'recording comes with a later stage');
      if (typeof a.id !== 'string' || !REC_RE.test(a.id)) throw hostError('ERR_INVALID', 'invalid recording id');
      const r = state.recordings.find((x) => x.id === a.id);
      if (!r) throw hostError('ERR_NOT_FOUND', 'no such recording');
      const uid = Number(a.user);
      if (!Number.isSafeInteger(uid) || uid <= 0 || !enabledUser(uid)) throw hostError('ERR_INVALID', 'user: a user id');
      const ref = crypto.randomBytes(32).toString('base64url').slice(0, 43);
      state.plays.set(ref, { ref, recordingId: r.id, targetId: r.targetId, userId: uid });
      state.calls.push({ op: 'stream', id: r.id, user: uid });
      return { ref, url: '/remote/session/' + ref, expiresAt: iso(Date.now() + 60000), format: r.format };
    },
    'remote.recordings.remove': async (a) => {
      need();
      if (typeof a.id !== 'string' || !REC_RE.test(a.id)) throw hostError('ERR_INVALID', 'invalid recording id');
      const i = state.recordings.findIndex((x) => x.id === a.id);
      if (i < 0) return { removed: false };
      state.recordings.splice(i, 1);
      return { removed: true };
    },
    'remote.vault.generate': async (a) => {
      need();
      if (a.kind != null && a.kind !== 'ed25519') throw hostError('ERR_INVALID', 'kind: ed25519');
      const m = vaultPut({ privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nmock\n-----END OPENSSH PRIVATE KEY-----\n', passphrase: null, ...(a.username ? { username: a.username } : {}), ...(a.label !== undefined ? { label: a.label } : {}), ...(a.handle != null ? { handle: a.handle } : {}) }, null);
      const e = state.vault.get(m.handle);
      e.publicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI' + crypto.randomBytes(24).toString('base64').replace(/=/g, '') + ' ' + (a.label || 'gatecontrol');
      return { ...meta(e), fingerprint: { alg: 'ssh-ed25519', sha256: crypto.randomBytes(32).toString('base64').replace(/=+$/, '') } };
    },
    'remote.tmux.list': async (a) => {
      need();
      const t = normalise(a.target);
      endpoint(t);
      const e = a.credential == null ? null : state.vault.get(String(a.credential));
      if (!e || !e.secret.username) throw hostError('ERR_REMOTE_CREDENTIAL_REQUIRED', 'a vault entry with the username');
      state.calls.push({ op: 'tmux.list', target: t });
      const v = o && o.tmux ? o.tmux[t.id] : undefined;
      if (v === 'unavailable') throw hostError('ERR_REMOTE_TMUX_UNAVAILABLE', 'tmux is not installed');
      if (v === 'unpinned') throw hostError('ERR_REMOTE_HOST_KEY_UNPINNED', 'no host key pinned');
      if (v === 'mismatch') throw hostError('ERR_REMOTE_HOST_KEY_MISMATCH', 'the host key changed');
      return (Array.isArray(v) ? v : []).map((x) => ({ attachable: TMUX_RE.test(x.name), windows: 1, attached: 0, created: null, activity: null, ...x }));
    },
    'remote.hostKeys.pin': async (a) => {
      need();
      if (typeof a.targetId !== 'string' || !ID_RE.test(a.targetId)) throw hostError('ERR_INVALID', 'targetId');
      const sha = String(a.sha256 || '').replace(/^SHA256:/, '');
      if (!/^[A-Za-z0-9+/]{43}$/.test(sha) || !/^[a-z0-9@._-]{3,64}$/i.test(String(a.alg || ''))) throw hostError('ERR_INVALID', 'alg / sha256');
      const p = { targetId: a.targetId, alg: a.alg, sha256: sha, source: 'plugin', pinnedBy: null, pinnedAt: iso(Date.now()) };
      state.hostKeys.set(a.targetId, p);
      return { ...p };
    },
    'remote.hostKeys.list': async () => { need(); return [...state.hostKeys.values()].map((p) => ({ ...p })); },
    'remote.hostKeys.remove': async (a) => { need(); if (typeof a.targetId !== 'string' || !ID_RE.test(a.targetId)) throw hostError('ERR_INVALID', 'targetId'); return { removed: state.hostKeys.delete(a.targetId) }; },
    'remote.hubAddress': async () => { need(); return HUB; },
    'remote.peerAddress': async (a) => {
      need();
      const uid = Number(a.userId);
      if (!Number.isSafeInteger(uid) || uid <= 0) throw hostError('ERR_INVALID', 'userId required');
      const did = a.deviceId == null ? '' : String(a.deviceId);
      if (!/^[1-9]\d{0,14}$/.test(did)) throw hostError('ERR_INVALID', 'deviceId required');
      if (!personCtx || !personCtx.has(uid)) throw hostError('ERR_REMOTE_NOT_ALLOWED', 'only in a request of this person');
      const raw = (Array.isArray(opts.devices) ? opts.devices : []).find((d) => String(d.id) === did);
      const dev = deviceList ? deviceList().find((d) => d.id === did) : null;
      if (!dev || dev.userId !== uid) throw hostError('ERR_REMOTE_NOT_ALLOWED', 'not an app device of this person');
      state.calls.push({ op: 'peerAddress', userId: uid, deviceId: did });
      return (raw && raw.vpnIp) || null;
    },
    'remote.gateways': async () => { need(); return { gateways: cfg.gateways.map((g) => ({ peerId: g.peerId, name: g.name, online: g.online !== false })), pools: cfg.pools.map((p) => ({ poolId: p.poolId, name: p.name })) }; },
  };

  async function closeRow(r, reason) {
    const now = Date.now();
    r.endedAt = now;
    r.durationSeconds = Math.max(0, Math.round((now - r.startedAt) / 1000));
    r.endReason = reason;
    const phase = reason === 'normal' || reason === 'ended_by_plugin' ? 'end' : 'abort';
    if (r.recordingId) {
      state.recordings.push({ id: r.recordingId, sessionId: r.id, targetId: r.targetId, userId: r.userId, protocol: r.protocol, format: r.engine === 'term' ? 'asciicast' : 'guac',
        status: 'ready', bytes: 4096, durationSeconds: r.durationSeconds, startedAt: iso(r.startedAt), endedAt: iso(now), createdAt: iso(now) });
    }
    await emit({ phase, sessionId: r.id, ref: r.ref, targetId: r.targetId, userId: r.userId, protocol: r.protocol, mode: r.mode, record: !!r.record,
      ...(v3 ? { engine: r.engine, via: r.via, recordingId: r.recordingId || null } : {}), startedAt: iso(r.startedAt), reason, durationSeconds: r.durationSeconds, endedAt: iso(now) });
  }

  function gcPart(call) {
    const listener = (x) => call('remote.listener', { target: x && typeof x === 'object' ? x : {} });
    listener.remove = (key) => call('remote.listener.remove', { key });
    const ob = (x) => (x && typeof x === 'object' ? x : {});
    return Object.freeze({
      version: v3 ? 3 : (v2 ? 2 : 1),
      session: (x) => call('remote.session', ob(x)),
      end: (x) => call('remote.end', ob(x)),
      sessions: (x) => call('remote.sessions', ob(x)),
      vault: Object.freeze({
        put: (entry) => call('remote.vault.put', { entry: ob(entry) }),
        remove: (handle) => call('remote.vault.remove', { handle }),
        info: (handle) => call('remote.vault.info', { handle }),
        list: () => call('remote.vault.list', {}),
        ...(v3 ? { generate: (x) => call('remote.vault.generate', ob(x)) } : {}),
      }),
      ...(v3 ? {
        tmux: Object.freeze({ list: (target, x) => call('remote.tmux.list', { ...ob(x), target: ob(target) }) }),
        hostKeys: Object.freeze({ pin: (x) => call('remote.hostKeys.pin', ob(x)), list: () => call('remote.hostKeys.list', {}), remove: (targetId) => call('remote.hostKeys.remove', { targetId }) }),
      } : {}),
      probe: (target) => call('remote.probe', { target: ob(target) }),
      wake: (target) => call('remote.wake', { target: ob(target) }),
      listener: Object.freeze(listener),
      listeners: () => call('remote.listeners', {}),
      recordings: Object.freeze({
        available: () => call('remote.recordings.available', {}),
        list: (x) => call('remote.recordings.list', ob(x)),
        stream: (id, x) => call('remote.recordings.stream', { ...ob(x), id }),
        remove: (id) => call('remote.recordings.remove', { id }),
      }),
      ...(next ? { gateways: () => call('remote.gateways', {}) } : {}),
      ...(v2 ? { hubAddress: () => call('remote.hubAddress', {}), peerAddress: (userId, deviceId) => call('remote.peerAddress', { userId, deviceId }) } : {}),
      on: (name, handler) => {
        if (name !== 'session' || typeof handler !== 'function') throw new TypeError("gc.remote.on('session', handler)");
        state.handlers.push(handler);
        return () => { const i = state.handlers.indexOf(handler); if (i >= 0) state.handlers.splice(i, 1); };
      },
    });
  }

  /** The person opens the session page: a tunnel → { sessionId } (event phase start). */
  async function open(ref, x = {}) {
    const t = state.tickets.get(ref);
    if (!t) throw new Error('mock host: no such ticket');
    if (!t.opened && Date.now() > t.openBy) throw new Error('mock host: ticket expired');
    t.opened = true;
    const r = { id: ++state.seq, ref, targetId: t.target.id, targetName: t.target.name, userId: t.userId, protocol: t.protocol, mode: t.mode, startedAt: Date.now(), endedAt: null,
      engine: t.engine || 'guac', via: x.via === 'app' ? 'app' : 'browser', record: !!t.record, recordingId: t.record ? 'rr_' + crypto.randomBytes(16).toString('hex') : null };
    state.rows.push(r);
    await emit({ phase: 'start', sessionId: r.id, ref, targetId: r.targetId, userId: r.userId, protocol: r.protocol, mode: r.mode, record: r.record,
      ...(v3 ? { engine: r.engine, via: r.via, recordingId: r.recordingId, ...(r.engine === 'term' ? { hostKey: x.hostKey || { alg: 'ssh-ed25519', sha256: 'A'.repeat(43) } } : {}) } : {}), startedAt: iso(r.startedAt) });
    return { sessionId: r.id, recordingId: r.recordingId };
  }
  /** v3: the person opened a playback ticket → event phase recording_viewed. */
  async function view(ref) {
    const p = state.plays.get(ref);
    if (!p) throw new Error('mock host: no such playback ticket');
    state.plays.delete(ref);
    await emit({ phase: 'recording_viewed', recordingId: p.recordingId, targetId: p.targetId, userId: p.userId, at: iso(Date.now()) });
  }
  /** v3: a terminal that never got ready (e.g. host_key_mismatch) — only the abort event, as the core sends it. */
  async function abortTerm(ref, reason) {
    const t = state.tickets.get(ref);
    if (!t) throw new Error('mock host: no such ticket');
    await emit({ phase: 'abort', sessionId: ++state.seq, ref, targetId: t.target.id, userId: t.userId, protocol: t.protocol, mode: t.mode, record: false,
      engine: t.engine, via: 'browser', recordingId: null, startedAt: iso(Date.now()), reason, durationSeconds: 0, endedAt: iso(Date.now()) });
  }
  async function close(sessionId, reason = 'normal') {
    const r = state.rows.find((x) => x.id === sessionId && !x.endedAt);
    if (!r) throw new Error('mock host: no such open tunnel');
    await closeRow(r, reason);
  }

  /** The core's facade middleware (src/services/remote/facade.js) around the plugin's hook. */
  async function facade(hook, op, x = {}) {
    const query = {};
    for (const [k, v] of Object.entries(x.query || {})) if (k !== 'ecdhPublicKey' && k !== 'publicKey') query[k] = v;
    const u = x.user || {};
    const payload = {
      op, id: x.id == null ? null : String(x.id), query, body: x.body || null,
      user: { id: u.id || null, tokenId: u.tokenId || null, peerId: u.peerId || null, scopes: u.scopes || ['client', 'client:rdp'], platform: u.platform || null, selfIp: u.selfIp || null },
      ip: x.ip || null,
      ...(next ? { server: { connectHost: (o && o.connectHost) || 'gc.example.test' } } : {}),
    };
    const answer = await hook('clientFacade', payload);
    if (!answer || typeof answer !== 'object' || answer.handled === false) return { handled: false };
    if (answer.guac) {
      try {
        const tk = await api['remote.session']({ user: u.id, ...answer.guac });
        return { status: 200, body: { ok: true, token: 'tok_' + tk.ref.slice(0, 10), wsPath: '/api/v1/remote/guac-tunnel', ttl: 60 }, ticket: tk.ref };
      } catch (e) {
        return { status: e.code === 'ERR_REMOTE_LIMIT' ? 429 : (e.code === 'ERR_REMOTE_UNLICENSED' ? 403 : 409), body: { ok: false, error: e.code } };
      }
    }
    const status = Number.isInteger(answer.status) ? answer.status : 200;
    const body = JSON.parse(JSON.stringify(answer.body || { ok: status < 400 }));
    const KEYS = ['username', 'password', 'username_encrypted', 'password_encrypted', 'credentials', 'credentials_e2ee'];
    if (body.connection) for (const k of KEYS) delete body.connection[k];
    for (const k of KEYS) delete body[k];
    if (answer.credential != null && status < 300) {
      if (!x.query || !x.query.ecdhPublicKey) return { status: 400, body: { ok: false, error: 'ecdh_required' } };
      const e = state.vault.get(answer.credential.handle);
      if (!e || e.readable === false) return { status: 409, body: { ok: false, error: 'credentials_invalid' } };
      const want = Array.isArray(answer.credential.fields) ? answer.credential.fields : ['username', 'password', 'domain'];
      const plain = { username: want.includes('username') ? e.secret.username || null : null, password: want.includes('password') ? e.secret.password || null : null, domain: want.includes('domain') ? e.secret.domain || null : null };
      // stands for ecdhEncrypt(json, key): the test can read what an app would decrypt
      const sealed = { sealedFor: x.query.ecdhPublicKey, data: Buffer.from(JSON.stringify(plain)).toString('base64') };
      if (body.connection) body.connection.credentials_e2ee = sealed; else body.credentials_e2ee = sealed;
    }
    return { status, body };
  }

  return { on, v2, v3, api, gcPart, state, open, close, view, abortTerm, facade, vaultSeed: (entry, source) => vaultPut(entry, source), setUnreadable: (h) => { const e = state.vault.get(h); if (e) e.readable = false; } };
}

module.exports = { install };
