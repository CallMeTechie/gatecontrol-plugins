'use strict';

// Devices — the targets of the former Remote Desktops with every setting
// (admin page "Geräte"). A device keeps its settings as one JSON value named
// like the columns of GateControl's rdp_routes, so a taken-over target
// connects exactly as before and the old app API (facade.js) answers in the
// old shape. Passwords and keys stay in GateControl's vault (gc.remote.vault):
// the plugin keeps the handle only.
//
// How a device is reached (access_mode):
//   internal / both   directly at host:port (a VPN address or the server's LAN)
//   external          at external_hostname:external_port (a public port forward)
//   gateway           through a home gateway: an L4 listener of the plugin
//                     (gc.remote.listener, key route-<id> / dev-<id>) that the
//                     gateway passes on to host:port in its home network.
//
// Since 1.1 a device is of a kind: `target` (made on the admin page or taken
// over) or `host` — a Windows PC the GateControl app registered with the switch
// "Remote Desktop erlauben" (server/hosts.js): its owner, the app installation,
// the state the app reports and how it is shared ("nur mit Code" / "ohne Code").

const store = require('./store');
const { fail, fromHost, clip, multiline, bool, iso, posInt } = require('./util');
const maintenance = require('./maintenance');

const PROTOCOLS = ['rdp', 'vnc', 'ssh', 'telnet'];
const DEFAULT_PORT = { rdp: 3389, vnc: 5900, ssh: 22, telnet: 23 };
const ACCESS_MODES = ['internal', 'external', 'both', 'gateway'];
const MAC_RE = /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/;
const HOST_RE = /^[A-Za-z0-9.:_-]{1,253}$/;
// a tmux session name as GateControl's terminal accepts it (no ".", ":", quotes or spaces)
const TMUX_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const RECORDING = ['off', 'optional', 'always'];
const FIRST_OWN_ID = 100000;
// a host without a heartbeat for three minutes (three missed host/state) is offline
const HOST_OFFLINE_MS = 180000;

// field → rule. 'bool', 'text:<max>', 'lines:<max>', 'port', 'int:<min>:<max>', 'id', [enum], 'tags', 'mac', 'host'
const FIELDS = Object.freeze({
  description: 'lines:500',
  host: 'host',
  port: 'port',
  access_mode: ACCESS_MODES,
  external_hostname: 'host',
  external_port: 'port',
  gateway_host: 'host',            // a Microsoft Remote Desktop Gateway (RD Gateway) for the apps
  gateway_port: 'port',
  gateway_peer_id: 'id',
  gateway_pool_id: 'id',
  gateway_listen_port: 'port',
  credential_mode: ['none', 'user_only', 'full'],
  domain: 'text:256',
  resolution_mode: ['fullscreen', 'fixed', 'dynamic'],
  resolution_width: 'int:1:7680',
  resolution_height: 'int:1:7680',
  multi_monitor: 'bool',
  color_depth: [8, 15, 16, 24, 32],
  redirect_clipboard: 'bool',
  redirect_printers: 'bool',
  redirect_drives: 'bool',
  redirect_usb: 'bool',
  redirect_smartcard: 'bool',
  audio_mode: ['local', 'remote', 'off'],
  network_profile: ['lan', 'broadband', 'modem', 'auto'],
  nla_enabled: 'bool',
  disable_wallpaper: 'bool',
  disable_themes: 'bool',
  disable_animations: 'bool',
  bandwidth_limit: 'int:0:10000000',
  session_timeout: 'int:0:100000',
  admin_session: 'bool',
  remote_app: 'text:256',
  start_program: 'text:512',
  wol_enabled: 'bool',
  wol_mac_address: 'mac',
  maintenance_enabled: 'bool',
  maintenance_schedule: 'lines:1000',
  credential_rotation_enabled: 'bool',
  credential_rotation_days: 'int:1:3650',
  tags: 'tags',
  notes: 'lines:2000',
  health_check_enabled: 'bool',
  browser_enabled: 'bool',
  browser_clipboard: 'bool',
  rdp_disable_audio: 'bool',
  // 1.2 (gc.remote version 3): SSH in GateControl's own terminal with tmux, recordings
  ssh_engine: ['term', 'guac'],    // term: the terminal of GateControl (xterm.js / the apps' native one) · guac: Guacamole as before
  tmux_enabled: 'bool',            // the terminal runs `tmux new -A -s <name>`: the session survives a lost connection
  tmux_name: 'tmux',               // default: gc-<short name of the device>
  recording: ['off', 'optional', 'always'],
});

// kept from the take-over and given back to the old apps, but not changed on the page in version 1
const KEPT = ['gateway_l4_route_id', 'credential_rotation_last', 'sharing_enabled', 'sharing_mode', 'sharing_require_consent', 'screenshot_enabled',
  'browser_enable_sftp', 'sftp_host', 'sftp_port', 'sftp_username', 'sftp_disable_download', 'sftp_disable_upload', 'browser_enable_audio', 'audio_servername'];

const BOOLS = Object.keys(FIELDS).filter((k) => FIELDS[k] === 'bool').concat(['sharing_enabled', 'sharing_require_consent', 'screenshot_enabled',
  'browser_enable_sftp', 'sftp_disable_download', 'sftp_disable_upload', 'browser_enable_audio']);

const DEFAULTS = Object.freeze({
  description: null, host: '', port: 3389, access_mode: 'internal', external_hostname: null, external_port: null,
  gateway_host: null, gateway_port: null, gateway_peer_id: null, gateway_pool_id: null, gateway_listen_port: null,
  credential_mode: 'full', domain: null, resolution_mode: 'fullscreen', resolution_width: null, resolution_height: null,
  multi_monitor: false, color_depth: 32, redirect_clipboard: true, redirect_printers: false, redirect_drives: false, redirect_usb: false,
  redirect_smartcard: false, audio_mode: 'local', network_profile: 'auto', nla_enabled: true, disable_wallpaper: false, disable_themes: false,
  disable_animations: false, bandwidth_limit: null, session_timeout: null, admin_session: false, remote_app: null, start_program: null,
  wol_enabled: false, wol_mac_address: null, maintenance_enabled: false, maintenance_schedule: null, credential_rotation_enabled: false,
  credential_rotation_days: null, credential_rotation_last: null, tags: [], notes: null, health_check_enabled: true, browser_enabled: false,
  browser_clipboard: false, rdp_disable_audio: false,
  ssh_engine: 'term', tmux_enabled: true, tmux_name: null, recording: 'off',
});

function parseJson(s, fb) { try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : fb; } catch { return fb; } }

/** One field of a patch, checked → the value to store (null clears). */
function checkField(k, v) {
  const rule = FIELDS[k];
  if (v === null || v === '') return rule === 'bool' ? false : (rule === 'tags' ? [] : null);
  if (rule === 'bool') { if (typeof v !== 'boolean') throw fail('invalid', { field: k }); return v; }
  if (Array.isArray(rule)) { if (!rule.includes(v)) throw fail('invalid', { field: k }); return v; }
  if (rule === 'port') { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 65535) throw fail('invalid', { field: k }); return n; }
  if (rule === 'id') { const n = posInt(v); if (!n) throw fail('invalid', { field: k }); return n; }
  if (rule === 'mac') { const s = String(v).trim(); if (!MAC_RE.test(s)) throw fail('invalid', { field: k }); return s.toUpperCase().replace(/-/g, ':'); }
  if (rule === 'host') { const s = String(v).trim(); if (!HOST_RE.test(s)) throw fail('invalid', { field: k }); return s; }
  if (rule === 'tmux') { const s = String(v).trim(); if (!TMUX_RE.test(s)) throw fail('invalid', { field: k }); return s; }
  if (rule === 'tags') {
    if (!Array.isArray(v) || v.length > 20) throw fail('invalid', { field: k });
    return [...new Set(v.map((x) => clip(x, 40)).filter(Boolean))];
  }
  const [kind, a, b] = rule.split(':');
  if (kind === 'int') { const n = Number(v); if (!Number.isInteger(n) || n < +a || n > +b) throw fail('invalid', { field: k }); return n; }
  if (kind === 'text') { if (typeof v !== 'string') throw fail('invalid', { field: k }); return clip(v, +a) || null; }
  if (kind === 'lines') { if (typeof v !== 'string') throw fail('invalid', { field: k }); return multiline(v, +a) || null; }
  throw fail('invalid', { field: k });
}

/** Rules across fields (the ones of rdp_routes' validation). */
function checkWhole(d) {
  const c = d.config;
  if (!d.name) throw fail('invalid', { field: 'name' });
  if (!c.host) throw fail('invalid', { field: 'host' });
  if (c.access_mode === 'gateway' && !c.gateway_peer_id && !c.gateway_pool_id) throw fail('invalid', { field: 'gateway_peer_id' });
  if ((c.access_mode === 'external' || c.access_mode === 'both') && !c.external_hostname) throw fail('invalid', { field: 'external_hostname' });
  if (c.wol_enabled && (d.protocol === 'ssh' || d.protocol === 'telnet')) throw fail('invalid', { field: 'wol_enabled' });
  if (c.wol_enabled && !c.wol_mac_address) throw fail('invalid', { field: 'wol_mac_address' });
  if (c.maintenance_enabled) {
    const p = maintenance.parse(c.maintenance_schedule);
    if (!p.windows.length || p.errors.length) throw fail('invalid', { field: 'maintenance_schedule', lines: p.errors.slice(0, 5) });
  }
  if (c.resolution_mode === 'fixed' && (!c.resolution_width || !c.resolution_height)) throw fail('invalid', { field: 'resolution_width' });
}

/** The state of a registered PC (kind host) — null for a target. */
function hostOf(r, now = Date.now()) {
  if (r.kind !== 'host') return null;
  const registered = bool(r.registered);
  const online = registered && Number.isFinite(r.last_seen) && now - r.last_seen < HOST_OFFLINE_MS;
  return {
    owner: r.owner_user_id || null, tokenDeviceId: r.token_device_id || null, platform: r.platform || 'windows', edition: r.edition || null,
    rdpAvailable: r.rdp_available == null ? null : bool(r.rdp_available), rdpEnabled: r.rdp_enabled == null ? null : bool(r.rdp_enabled),
    shareMode: r.share_mode === 'open' ? 'open' : 'code', allowOpen: r.allow_open == null ? true : bool(r.allow_open), registered, online,
    lastSeen: r.last_seen || null, osUser: r.os_user || null, appVersion: r.app_version || null,
  };
}

/** How a person connects to a PC now: 'open' (no code, no question) only when the owner switched it on and the admin allows it. */
function connectMode(d) {
  if (!d || !d.host) return null;
  return d.host.shareMode === 'open' && d.host.allowOpen ? 'open' : 'code';
}

/** Can a session reach the PC at all (switch on, Remote Desktop on in Windows, the app reports)? */
function hostReady(d) {
  return !!(d && d.host && d.host.registered && d.host.rdpEnabled !== false && d.host.online);
}

function fromRow(r) {
  if (!r) return null;
  const host = hostOf(r);
  const config = { ...DEFAULTS, ...parseJson(r.config, {}) };
  for (const k of BOOLS) if (k in config) config[k] = bool(config[k]);
  if (!Array.isArray(config.tags)) config.tags = [];
  return {
    id: r.id, name: r.name, protocol: PROTOCOLS.includes(r.protocol) ? r.protocol : 'rdp', enabled: bool(r.enabled), source: r.source,
    config, credential: r.credential || null, sftpCredential: r.sftp_credential || null, credentialUnreadable: bool(r.credential_unreadable),
    listener: r.listener || null, listenerError: r.listener_error || null, kind: host ? 'host' : 'target', host,
    // a PC: online is what its app reports (3389 is closed between sessions, a check would always fail)
    status: host ? { online: host.online, responseTime: null, lastCheck: host.lastSeen }
      : { online: r.online == null ? null : bool(r.online), responseTime: r.response_time == null ? null : r.response_time, lastCheck: r.last_check || null },
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

async function get(gc, id) {
  const n = posInt(id);
  if (!n) return null;
  return fromRow(await store.one(gc, 'SELECT * FROM devices WHERE id = ?', [n]));
}

async function need(gc, id) {
  const d = await get(gc, id);
  if (!d) throw fail('not_found');
  return d;
}

async function all(gc) {
  return (await store.all(gc, 'SELECT * FROM devices ORDER BY name COLLATE NOCASE, id')).map(fromRow);
}

/** The access lists of all devices: Map id → { users, groups, tokens } */
async function accessLists(gc) {
  const out = new Map();
  for (const r of await store.all(gc, 'SELECT device_id, kind, principal_id FROM device_access ORDER BY principal_id')) {
    if (!out.has(r.device_id)) out.set(r.device_id, { users: [], groups: [], tokens: [] });
    const e = out.get(r.device_id);
    (r.kind === 'user' ? e.users : r.kind === 'group' ? e.groups : e.tokens).push(r.principal_id);
  }
  return out;
}

const emptyAccess = () => ({ users: [], groups: [], tokens: [] });

/** How an SSH device connects: 'term' (GateControl's terminal, gc.remote version 3) or 'guac'; null for other protocols. */
function engineOf(d, gc) {
  if (!d || d.protocol !== 'ssh') return null;
  const v3 = !gc || !!(gc.remote && gc.remote.version >= 3);
  return d.config.ssh_engine === 'term' && v3 ? 'term' : 'guac';
}

/** The tmux session of a device in the terminal: its own name or gc-<short name>; null with tmux off or another engine. */
function tmuxOf(d) {
  if (!d || d.protocol !== 'ssh' || d.config.ssh_engine !== 'term' || !d.config.tmux_enabled) return null;
  if (d.config.tmux_name && TMUX_RE.test(d.config.tmux_name)) return d.config.tmux_name;
  const slug = String(d.name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 29);
  return 'gc-' + (slug || String(d.id));
}

/** Where gc.remote reaches the device: { id, name, host, port } | { id, name, listener } (+ mac) */
function targetOf(d) {
  const c = d.config;
  const t = { id: 'dev-' + d.id, name: d.name.slice(0, 120) };
  if (c.access_mode === 'gateway') t.listener = d.listener || listenerKey(d);
  else if (c.access_mode === 'external') { t.host = c.external_hostname; t.port = c.external_port || c.port; } else { t.host = c.host; t.port = c.port; }
  if (c.wol_enabled && c.wol_mac_address) t.mac = c.wol_mac_address;
  return t;
}

/** A taken-over gateway target keeps the key of its route (the L4 port is reused). */
function listenerKey(d) {
  return d.listener || (d.source === 'import' ? 'route-' + d.id : 'dev-' + d.id);
}

/** The vault metadata of every handle → Map handle → metadata */
async function vaultInfo(gc) {
  const m = new Map();
  try { for (const v of (await gc.remote.vault.list()) || []) m.set(v.handle, v); } catch (e) { gc.log.debug('vault list failed', (e && e.code) || 'error'); }
  return m;
}

function credentialView(d, vault) {
  const v = d.credential ? vault.get(d.credential) : null;
  const has = v ? v.has : { username: false, password: false, domain: false, privateKey: false, passphrase: false };
  return { set: !!v, has, readable: v ? v.readable !== false && !d.credentialUnreadable : !d.credentialUnreadable, updatedAt: v ? v.updatedAt : null };
}

function rotationDue(d, now = Date.now()) {
  const c = d.config;
  if (!c.credential_rotation_enabled || !c.credential_rotation_days) return false;
  const last = Date.parse(c.credential_rotation_last || '') || d.createdAt;
  return now - last >= c.credential_rotation_days * 86400000;
}

/** A device for the admin page: every setting, never a secret. */
function adminView(d, access, vault, now = Date.now()) {
  const a = access || emptyAccess();
  return {
    id: d.id, name: d.name, protocol: d.protocol, enabled: d.enabled, source: d.source, config: d.config,
    credential: credentialView(d, vault), access: { users: a.users, groups: a.groups, tokens: a.tokens, open: !a.users.length && !a.groups.length && !a.tokens.length },
    listener: d.listener, listenerError: d.listenerError, status: { ...d.status, lastCheck: iso(d.status.lastCheck) },
    maintenance: maintenance.inWindow(d.config, new Date(now)), rotationDue: rotationDue(d, now),
    kind: d.kind, host: d.host ? hostView(d) : null,
    createdAt: iso(d.createdAt), updatedAt: iso(d.updatedAt),
  };
}

/** The state of a PC for the pages (never the app's token). */
function hostView(d) {
  const h = d.host;
  return { owner: h.owner, edition: h.edition, rdpAvailable: h.rdpAvailable, rdpEnabled: h.rdpEnabled, shareMode: h.shareMode, allowOpen: h.allowOpen,
    connect: connectMode(d), registered: h.registered, online: h.online, lastSeen: iso(h.lastSeen), osUser: h.osUser, appVersion: h.appVersion };
}

/** The next id of a device made in the plugin (≥ 100000, never one of GateControl's rdp_routes). */
async function nextId(gc) {
  const r = await store.one(gc, 'SELECT MAX(id) AS m FROM devices');
  return Math.max((r && r.m) || 0, FIRST_OWN_ID - 1) + 1;
}

/** Apply a patch from the admin page onto a device (new: d = null) → the device to store. */
function applyPatch(d, b) {
  const next = d ? { ...d, config: { ...d.config } } : { id: null, name: '', protocol: 'rdp', enabled: true, source: 'plugin', config: { ...DEFAULTS }, credential: null };
  if (b.name !== undefined) next.name = clip(b.name, 100);
  if (b.protocol !== undefined) {
    if (!PROTOCOLS.includes(b.protocol)) throw fail('invalid', { field: 'protocol' });
    if (!d && (!b.config || b.config.port === undefined)) next.config.port = DEFAULT_PORT[b.protocol];
    next.protocol = b.protocol;
  }
  if (b.enabled !== undefined) { if (typeof b.enabled !== 'boolean') throw fail('invalid', { field: 'enabled' }); next.enabled = b.enabled; }
  const c = b.config && typeof b.config === 'object' && !Array.isArray(b.config) ? b.config : {};
  for (const [k, v] of Object.entries(c)) {
    if (!(k in FIELDS)) throw fail('invalid', { field: k });
    next.config[k] = checkField(k, v);
  }
  // a gateway or a failover pool of gateways, never both
  if (next.config.gateway_peer_id && next.config.gateway_pool_id) throw fail('invalid', { field: 'gateway_pool_id' });
  checkWhole(next);
  return next;
}

/** Credentials of the page: { username, password, privateKey, passphrase } — undefined keeps, '' clears. */
function credentialPatch(b, domain) {
  const x = b && typeof b === 'object' ? b : null;
  if (!x) return null;
  const out = {};
  for (const k of ['username', 'password', 'privateKey', 'passphrase']) {
    if (x[k] === undefined) continue;
    if (x[k] !== null && typeof x[k] !== 'string') throw fail('invalid', { field: 'credentials.' + k });
    const max = k === 'privateKey' ? 16384 : 1024;
    if (typeof x[k] === 'string' && x[k].length > max) throw fail('invalid', { field: 'credentials.' + k });
    out[k] = x[k] === '' ? null : x[k];
  }
  out.domain = domain || null;
  return out;
}

/** The listener of a gateway device is made / changed / removed with the device. */
async function syncListener(gc, d, before) {
  const c = d.config;
  if (c.access_mode === 'gateway') {
    const key = listenerKey(d);
    try {
      const l = await gc.remote.listener({ key, gateway: c.gateway_pool_id ? { poolId: c.gateway_pool_id } : { peerId: c.gateway_peer_id }, host: c.host, port: c.port, listenPort: c.gateway_listen_port || c.port });
      return { listener: l.key, error: null, listenPort: l.listenPort };
    } catch (e) {
      const err = fromHost(e, 'listener_failed');
      if (e && e.suggestedPort) err.extra = { ...(err.extra || {}), suggestedPort: e.suggestedPort };
      throw err;
    }
  }
  if (before && before.listener) {
    try { await gc.remote.listener.remove(before.listener); } catch (e) { gc.log.warn('listener not removed', (e && e.code) || 'error'); }
  }
  return { listener: null, error: null };
}

async function write(gc, d, now = Date.now()) {
  await store.run(gc, `INSERT INTO devices (id, name, protocol, enabled, source, config, credential, sftp_credential, credential_unreadable, listener, listener_error, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, protocol = excluded.protocol, enabled = excluded.enabled, source = excluded.source, config = excluded.config,
      credential = excluded.credential, sftp_credential = excluded.sftp_credential, credential_unreadable = excluded.credential_unreadable,
      listener = excluded.listener, listener_error = excluded.listener_error, updated_at = excluded.updated_at`,
  [d.id, d.name, d.protocol, d.enabled ? 1 : 0, d.source || 'plugin', JSON.stringify(d.config), d.credential || null, d.sftpCredential || null,
    d.credentialUnreadable ? 1 : 0, d.listener || null, d.listenerError || null, d.createdAt || now, now]);
}

/** Who may reach the device: { users: [ids], groups: [ids], tokens?: [ids] } (tokens stay unless given). */
async function setAccess(gc, id, a) {
  const users = Array.isArray(a.users) ? [...new Set(a.users.map(posInt).filter(Boolean))].slice(0, 2000) : null;
  const groups = Array.isArray(a.groups) ? [...new Set(a.groups.map(posInt).filter(Boolean))].slice(0, 500) : null;
  const tokens = Array.isArray(a.tokens) ? [...new Set(a.tokens.map(posInt).filter(Boolean))].slice(0, 2000) : null;
  for (const [kind, list] of [['user', users], ['group', groups], ['token', tokens]]) {
    if (!list) continue;
    await store.run(gc, 'DELETE FROM device_access WHERE device_id = ? AND kind = ?', [id, kind]);
    for (const p of list) await store.run(gc, 'INSERT OR IGNORE INTO device_access (device_id, kind, principal_id) VALUES (?, ?, ?)', [id, kind, p]);
  }
}

/** Create or change a device from the admin page → the admin view. */
async function save(gc, id, b, now = Date.now()) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw fail('invalid');
  const before = id ? await need(gc, id) : null;
  const next = applyPatch(before && before.kind === 'host' ? { ...before, config: { ...before.config } } : before, b);
  if (before && before.kind === 'host') {
    // a PC: where it is reached comes from its app (host/register), never from the page
    next.protocol = 'rdp';
    for (const k of ['host', 'port', 'access_mode', 'external_hostname', 'external_port', 'gateway_peer_id', 'gateway_pool_id', 'gateway_listen_port', 'wol_enabled', 'wol_mac_address']) next.config[k] = before.config[k];
  }
  if (!before) { next.id = await nextId(gc); next.createdAt = now; }
  // credentials → the vault (a handle per device)
  const cred = credentialPatch(b.credentials, next.config.domain);
  if (cred && Object.keys(cred).some((k) => k !== 'domain')) {
    try {
      const v = await gc.remote.vault.put({ ...cred, label: next.name.slice(0, 120), ...(next.credential ? { handle: next.credential } : {}) });
      next.credential = v.handle;
      next.credentialUnreadable = v.readable === false;
    } catch (e) { throw fromHost(e); }
  } else if (next.credential && before && before.config.domain !== next.config.domain) {
    try { await gc.remote.vault.put({ handle: next.credential, domain: next.config.domain || null }); } catch (e) { gc.log.debug('domain not stored in the vault', (e && e.code) || 'error'); }
  }
  const l = await syncListener(gc, next, before);
  next.listener = l.listener;
  next.listenerError = null;
  if (l.listenPort && next.config.access_mode === 'gateway' && !next.config.gateway_listen_port) next.config.gateway_listen_port = l.listenPort;
  await store.tx(gc, async () => {
    await write(gc, next, now);
    if (b.access) await setAccess(gc, next.id, b.access);
  });
  return next.id;
}

/** Delete a device: its listener, its vault entries and its access lists go; the history stays. */
async function remove(gc, id) {
  const d = await need(gc, id);
  if (d.listener) { try { await gc.remote.listener.remove(d.listener); } catch (e) { gc.log.warn('listener not removed', (e && e.code) || 'error'); } }
  for (const h of [d.credential, d.sftpCredential]) {
    if (!h) continue;
    try { await gc.remote.vault.remove(h); } catch (e) { gc.log.debug('vault entry not removed', (e && e.code) || 'error'); }
  }
  await store.tx(gc, async () => {
    await store.run(gc, 'DELETE FROM device_access WHERE device_id = ?', [d.id]);
    await store.run(gc, 'DELETE FROM devices WHERE id = ?', [d.id]);
  });
  return { removed: true };
}

/** Mark the credentials as renewed today (rotation reminder). */
async function rotated(gc, id, now = Date.now()) {
  const d = await need(gc, id);
  d.config.credential_rotation_last = new Date(now).toISOString();
  await write(gc, d, now);
}

async function setStatus(gc, id, s, now = Date.now()) {
  await store.run(gc, 'UPDATE devices SET online = ?, response_time = ?, last_check = ? WHERE id = ?',
    [s.online == null ? null : (s.online ? 1 : 0), Number.isFinite(s.responseTime) ? Math.round(s.responseTime) : null, now, id]);
}

module.exports = {
  PROTOCOLS, DEFAULT_PORT, ACCESS_MODES, FIELDS, KEPT, BOOLS, DEFAULTS, FIRST_OWN_ID, HOST_OFFLINE_MS, TMUX_RE, RECORDING, engineOf, tmuxOf,
  hostOf, hostView, connectMode, hostReady,
  get, need, all, accessLists, emptyAccess, targetOf, listenerKey, vaultInfo, credentialView, adminView, rotationDue,
  applyPatch, checkField, save, remove, rotated, setStatus, setAccess, write, fromRow, nextId,
};
