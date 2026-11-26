'use strict';

// Media sources: Jellyfin servers and NAS shares. Secrets (API key, NAS password) are secrets of the plugin
// (gc.settings.setSecret), never in the database and never in an answer to the browser.
//
// Network rule (what the apps do with it, see the handbook "Netz"): at home a device plays directly in the home
// network (`address`, the SMB/WebDAV addresses) — never through the server or a tunnel. Away it plays only through the
// VPN, but not at the home addresses: the server routes no home network to the gateway (the gateway is only a proxy per
// route). What the tunnel reaches are the GateControl routes (domain → Caddy on the server → gateway → target; the VPN's
// DNS resolves route domains, also of routes released for internal use only). So away a device gets an HTTPS address of
// its own — `away: { mode: 'vpn', address }`, used only with the tunnel up: the address saved in the dialog (prefilled
// with https://<domain of the route>), else derived from the route the source runs over (awayAddressOf). Exception per
// source or for all (setting away_direct_all): "Unterwegs ohne VPN erlauben" — then `away: { mode: 'direct', address }`
// (only with a saved address). SMB has no way away (only WebDAV); a source without any address stays `{ mode: 'vpn' }`.
//
// Home detection (network.home.probes, see probesOf): every source gives the devices at least one probe they run over
// the local network only. Unique: `jellyfin` (the server ID, learned on save/check and kept in config.serverId) and `tls`
// (the pinned WebDAV certificate). Without either: `tcp` to the home address (SMB 445, the WebDAV/Jellyfin port) — it
// keeps a device at home off the tunnel, but a foreign network with the same address answers it too (unique: false;
// the tab Quellen marks such a source).

const store = require('./store');
const jf = require('./jellyfin');
const { fail, str, posInt, httpUrl, smbUrl, sha256Hex, folderOf, json, sourceIdOf } = require('./util');

const KINDS = ['jellyfin', 'share'];
const KEY_RE = /^[A-Za-z0-9]{16,128}$/;

const keyName = (id) => 'jf.' + id + '.key';
const pwName = (id) => 'share.' + id + '.pw';

function parse(row) {
  if (!row) return null;
  return {
    id: row.id, kind: row.kind, name: row.name, position: row.position, enabled: row.enabled === 1,
    config: json(row.config, {}), status: json(row.status, {}), secretRev: row.secret_rev, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

async function list(gc) {
  return (await store.all(gc, 'SELECT * FROM sources ORDER BY position, created_at')).map(parse);
}
async function get(gc, id) {
  const sid = sourceIdOf(id);
  return sid ? parse(await store.one(gc, 'SELECT * FROM sources WHERE id = ?', [sid])) : null;
}
async function need(gc, id) {
  const s = await get(gc, id);
  if (!s) throw fail('not_found');
  return s;
}

async function secret(gc, name) {
  try { const v = await gc.settings.get(name); return typeof v === 'string' && v ? v : null; } catch { return null; }
}
const apiKey = (gc, src) => secret(gc, keyName(src.id));
const password = (gc, src) => secret(gc, pwName(src.id));

const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/i;

/**
 * The plugin's assigned home targets: { jellyfin: [{ index, label }], webdav: [...], smb: [...] } (gc.net.targets()).
 * GateControl labels a route assignment with the route's domain, a peer with "Name (IP)", an address with host[:port].
 */
async function targetsOf(gc) {
  const out = { jellyfin: [], webdav: [], smb: [] };
  try {
    for (const t of (await gc.net.targets()) || []) {
      if (out[t.id]) out[t.id] = (t.assigned || []).map((a) => ({ index: a.index, label: a.label || null }));
    }
  } catch (e) { gc.log.debug('targets unavailable', (e && e.code) || 'error'); }
  return out;
}

/** The domain of the route behind assignment `index` of target `id`, or null (a peer, an address, an L4 route). */
function routeDomain(targets, id, index, home) {
  if (!targets || index == null) return null;
  const a = (targets[id] || []).find((x) => x.index === index);
  const label = a && typeof a.label === 'string' ? a.label.trim().toLowerCase() : '';
  if (!HOSTNAME_RE.test(label)) return null;
  const h = hostPort(home);
  return h && h.host.toLowerCase() === label ? null : label; // an assigned home address with a name is no route
}

/**
 * The HTTPS address a device uses away (through the tunnel): the saved one, else (sources saved before 1.3.0) one
 * derived from the route the source runs over — https://<domain> for Jellyfin, https://<domain>/<path of the WebDAV
 * address> for a share. SMB alone has none. → the address or null.
 */
function awayAddressOf(src, targets) {
  const c = src.config || {};
  if (c.away && c.away.address) return c.away.address;
  if (src.kind === 'jellyfin') {
    const d = routeDomain(targets, 'jellyfin', c.targetIndex || 0, c.address);
    return d ? 'https://' + d : null;
  }
  const dav = c.webdav;
  if (!dav || dav.targetIndex == null) return null;
  const d = routeDomain(targets, 'webdav', dav.targetIndex, dav.address);
  if (!d) return null;
  let p = '';
  try { p = new URL(dav.address).pathname.replace(/\/+$/, ''); } catch { p = ''; }
  return 'https://' + d + p;
}

/**
 * Away: `{ mode: 'vpn', address? }` — the address only with the tunnel up; `{ mode: 'direct', address }` with the source's
 * own switch or the setting for all and a saved HTTPS address. targets: targetsOf (for sources without a saved address).
 */
function awayOf(src, cfg, targets) {
  const a = (src.config && src.config.away) || {};
  if ((a.direct === true || (cfg && cfg.awayDirectAll)) && a.address) return { mode: 'direct', address: a.address };
  const address = awayAddressOf(src, targets);
  return address ? { mode: 'vpn', address } : { mode: 'vpn' };
}

function cleanAway(b, prev) {
  const a = b && typeof b === 'object' ? b : (prev || {});
  let address = null;
  if (a.address != null && a.address !== '') {
    address = httpUrl(a.address, { https: true });
    if (!address) throw fail('invalid', { field: 'away.address', reason: 'https' });
  }
  const direct = a.direct === true;
  if (direct && !address) throw fail('away_address_required');
  return { direct, address };
}

const targetIndex = (v, d = 0) => {
  if (v == null || v === '') return d;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 99) throw fail('invalid', { field: 'targetIndex' });
  return n;
};

/** The configuration of a source from the admin dialog (prev = the current one when editing). */
function cleanConfig(kind, b, prev = {}) {
  const accessMode = b.accessMode === 'list' || (b.accessMode == null && prev.accessMode === 'list') ? 'list' : 'all';
  if (kind === 'jellyfin') {
    const address = httpUrl(b.address != null ? b.address : prev.address);
    if (!address) throw fail('invalid', { field: 'address' });
    const ti = targetIndex(b.targetIndex, prev.targetIndex || 0);
    // the server ID stays while address and target stay; a new address/target learns it again with the next check
    const serverId = address === prev.address && ti === (prev.targetIndex || 0) && prev.serverId ? prev.serverId : null;
    return {
      targetIndex: ti, address, serverId,
      away: cleanAway(b.away, prev.away),
      downloads: typeof b.downloads === 'boolean' ? b.downloads : prev.downloads !== false,
      alwaysOriginal: typeof b.alwaysOriginal === 'boolean' ? b.alwaysOriginal : prev.alwaysOriginal === true,
      accessMode,
    };
  }
  const smbIn = b.smb !== undefined ? b.smb : prev.smb;
  const davIn = b.webdav !== undefined ? b.webdav : prev.webdav;
  let smb = null;
  let webdav = null;
  if (smbIn && (smbIn.address || smbIn.address === '')) {
    const address = smbUrl(smbIn.address);
    if (!address) throw fail('invalid', { field: 'smb.address' });
    smb = { address, targetIndex: smbIn.targetIndex == null || smbIn.targetIndex === '' ? null : targetIndex(smbIn.targetIndex) };
  }
  if (davIn && (davIn.address || davIn.address === '')) {
    const address = httpUrl(davIn.address, { https: true });
    if (!address) throw fail('invalid', { field: 'webdav.address', reason: 'https' });
    let certSha256 = null;
    if (davIn.certSha256 != null && davIn.certSha256 !== '') {
      certSha256 = sha256Hex(davIn.certSha256);
      if (!certSha256) throw fail('invalid', { field: 'webdav.certSha256' });
    }
    webdav = { address, certSha256, targetIndex: davIn.targetIndex == null || davIn.targetIndex === '' ? null : targetIndex(davIn.targetIndex) };
  }
  if (!smb && !webdav) throw fail('invalid', { field: 'smb' });
  const user = str(b.user != null ? b.user : prev.user, 100);
  if (!user) throw fail('invalid', { field: 'user' });
  return { smb, webdav, user, away: cleanAway(b.away, prev.away), accessMode };
}

async function nextId(gc, kind) {
  const k = 'seq.' + kind;
  const n = ((await gc.storage.get(k)) || 0) + 1;
  await gc.storage.set(k, n);
  return (kind === 'jellyfin' ? 'jf-' : 'sh-') + n;
}

async function create(gc, b, now = Date.now()) {
  const body = b && typeof b === 'object' ? b : {};
  if (!KINDS.includes(body.kind)) throw fail('invalid', { field: 'kind' });
  const name = str(body.name, 60);
  if (!name) throw fail('invalid', { field: 'name' });
  const config = cleanConfig(body.kind, body);
  if (body.kind === 'jellyfin' && !KEY_RE.test(String(body.key || ''))) throw fail('invalid', { field: 'key' });
  if (body.kind === 'share' && !(typeof body.password === 'string' && body.password.length >= 1 && body.password.length <= 256)) throw fail('invalid', { field: 'password' });
  const id = await nextId(gc, body.kind);
  const pos = (await store.one(gc, 'SELECT COALESCE(MAX(position), 0) + 1 AS p FROM sources')).p;
  await store.run(gc, 'INSERT INTO sources (id, kind, name, position, enabled, config, status, secret_rev, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)',
    [id, body.kind, name, pos, JSON.stringify(config), '{}', body.kind === 'share' ? 1 : 0, now, now]);
  if (body.kind === 'jellyfin') await gc.settings.setSecret(keyName(id), String(body.key));
  else await gc.settings.setSecret(pwName(id), body.password);
  return get(gc, id);
}

async function update(gc, id, b, now = Date.now()) {
  const src = await need(gc, id);
  const body = b && typeof b === 'object' ? b : {};
  const name = body.name != null ? str(body.name, 60) : src.name;
  if (!name) throw fail('invalid', { field: 'name' });
  const config = cleanConfig(src.kind, body, src.config);
  const enabled = typeof body.enabled === 'boolean' ? body.enabled : src.enabled;
  await store.run(gc, 'UPDATE sources SET name = ?, config = ?, enabled = ?, updated_at = ? WHERE id = ?', [name, JSON.stringify(config), enabled ? 1 : 0, now, src.id]);
  return { before: src, after: await get(gc, src.id) };
}

async function setKey(gc, id, key) {
  const src = await need(gc, id);
  if (src.kind !== 'jellyfin') throw fail('invalid');
  if (!KEY_RE.test(String(key || ''))) throw fail('invalid', { field: 'key' });
  await gc.settings.setSecret(keyName(src.id), String(key));
}

/** A new NAS password: every device that may see the share gets it with its next contact (secretRev rises). */
async function setPassword(gc, id, pw, now = Date.now()) {
  const src = await need(gc, id);
  if (src.kind !== 'share') throw fail('invalid');
  if (!(typeof pw === 'string' && pw.length >= 1 && pw.length <= 256)) throw fail('invalid', { field: 'password' });
  await gc.settings.setSecret(pwName(src.id), pw);
  await store.run(gc, 'UPDATE sources SET secret_rev = secret_rev + 1, updated_at = ? WHERE id = ?', [now, src.id]);
  return get(gc, src.id);
}

async function remove(gc, id) {
  const src = await need(gc, id);
  await store.tx(gc, async () => {
    for (const t of ['sources WHERE id', 'source_access WHERE source_id', 'mappings WHERE source_id', 'pairings WHERE source_id', 'deliveries WHERE source_id', 'reports WHERE source_id']) {
      await store.run(gc, 'DELETE FROM ' + t + ' = ?', [src.id]);
    }
  });
  try { await gc.settings.setSecret(src.kind === 'jellyfin' ? keyName(src.id) : pwName(src.id), null); } catch (e) { gc.log.debug('secret not removed', (e && e.code) || 'error'); }
  return src;
}

async function setStatus(gc, src, status, now = Date.now()) {
  await store.run(gc, 'UPDATE sources SET status = ? WHERE id = ?', [JSON.stringify({ ...status, at: now }), src.id]);
}

/** Check a Jellyfin source: reachable, new enough, key valid, Quick Connect, libraries, users → the status. */
async function checkJellyfin(gc, index, key) {
  const out = { ok: false, reachable: false, keyValid: null, quickConnect: null, libraries: [], users: 0, problem: null };
  try {
    const info = await jf.publicInfo(gc, index);
    Object.assign(out, { reachable: true, serverId: info.serverId, serverName: info.name, version: info.version, versionOk: info.versionOk, localAddress: info.localAddress });
    if (!info.versionOk) out.problem = 'version_old';
  } catch (e) { out.problem = (e && e.extra && e.extra.reason) === 'no_target' ? 'no_target' : 'unreachable'; return out; }
  out.quickConnect = await jf.quickConnectEnabled(gc, index).catch(() => null);
  if (!key) { out.problem = out.problem || 'no_key'; return out; }
  try {
    await jf.checkKey(gc, index, key);
    out.keyValid = true;
    out.libraries = await jf.libraries(gc, index, key).catch(() => []);
    const us = await jf.users(gc, index, key).catch(() => []);
    out.users = us.length;
  } catch (e) {
    out.keyValid = e && e.code === 'key_invalid' ? false : null;
    out.problem = out.problem || (out.keyValid === false ? 'key_invalid' : 'unreachable');
    return out;
  }
  if (!out.problem && out.quickConnect === false) out.problem = 'quick_connect_off';
  out.ok = !out.problem;
  return out;
}

/** Check a share: WebDAV sign-in and folder through the target "webdav" (PROPFIND, Depth 0). SMB is checked by the devices. */
async function checkShare(gc, src, pw) {
  const out = { ok: false, webdav: null, problem: null };
  const dav = src.config.webdav;
  if (dav && dav.targetIndex != null) {
    try {
      const path = new URL(dav.address).pathname || '/';
      const r = await gc.net.fetchTarget('webdav', path.endsWith('/') ? path : path + '/', {
        index: dav.targetIndex, method: 'PROPFIND',
        headers: { Depth: '0', Authorization: 'Basic ' + Buffer.from(src.config.user + ':' + (pw || ''), 'utf8').toString('base64') },
        timeoutMs: 10000,
      });
      out.webdav = r.status === 207 || r.status === 200 ? 'ok' : (r.status === 401 || r.status === 403 ? 'login_failed' : (r.status === 404 ? 'folder_missing' : 'error'));
    } catch (e) { out.webdav = e && e.code === 'ERR_NET_DENIED' ? 'no_target' : 'unreachable'; }
    if (out.webdav !== 'ok') out.problem = 'webdav_' + out.webdav;
  }
  // SMB: the server does not reach it — the devices check it themselves (POST v1/shares/{id}/checked)
  out.smb = src.config.smb ? 'devices' : null;
  out.ok = !out.problem;
  return out;
}

/**
 * Check a source and keep the result as its status. A Jellyfin server's ID is kept in config.serverId (the home probe),
 * also when a later check does not reach the server. → the status (+ serverIdLearned when the ID is new or changed).
 */
async function check(gc, src, now = Date.now()) {
  let status;
  let serverIdLearned = false;
  if (src.kind === 'jellyfin') {
    status = await checkJellyfin(gc, src.config.targetIndex || 0, await apiKey(gc, src));
    if (status.serverId && status.serverId !== src.config.serverId) {
      const cur = await get(gc, src.id);
      if (cur) {
        await store.run(gc, 'UPDATE sources SET config = ? WHERE id = ?', [JSON.stringify({ ...cur.config, serverId: status.serverId }), src.id]);
        src.config = { ...cur.config, serverId: status.serverId };
        serverIdLearned = true;
      }
    }
  } else status = await checkShare(gc, src, await password(gc, src));
  await setStatus(gc, src, status, now);
  return { ...status, at: now, serverIdLearned };
}

const DEFAULT_PORT = { 'http:': 80, 'https:': 443, 'smb:': 445 };
/** Host and port of a home address (port from the address, else the protocol's default). */
function hostPort(addr) {
  try {
    const u = new URL(addr);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const port = Number(u.port) || DEFAULT_PORT[u.protocol];
    return host && port ? { host, port } : null;
  } catch { return null; }
}

/** The Jellyfin server ID the plugin knows (config, else the last status). */
const serverIdOf = (src) => (src.config && src.config.serverId) || (src.status && src.status.serverId) || null;

/**
 * The home probes of one source, unique ones first. Every source gives at least one (as long as its address parses):
 *   { kind: 'jellyfin', url, serverId, sourceId, unique: true }   GET url → Id == serverId
 *   { kind: 'tls', url, certSha256, sourceId, unique: true }      TLS handshake → certificate SHA-256 == certSha256
 *   { kind: 'tcp', host, port, sourceId, unique: false }          TCP connect to host:port succeeds
 */
function probesOf(src) {
  const c = src.config || {};
  const out = [];
  const tcp = (addr) => {
    const hp = hostPort(addr);
    if (hp && !out.some((p) => p.kind === 'tcp' && p.host === hp.host && p.port === hp.port)) out.push({ kind: 'tcp', host: hp.host, port: hp.port, sourceId: src.id, unique: false });
  };
  if (src.kind === 'jellyfin') {
    const serverId = serverIdOf(src);
    if (serverId && c.address) out.push({ kind: 'jellyfin', url: c.address + '/System/Info/Public', serverId, sourceId: src.id, unique: true });
    else if (c.address) tcp(c.address);
    return out;
  }
  if (c.webdav && c.webdav.certSha256) out.push({ kind: 'tls', url: c.webdav.address, certSha256: c.webdav.certSha256, sourceId: src.id, unique: true });
  else {
    if (c.smb) tcp(c.smb.address);
    if (c.webdav) tcp(c.webdav.address);
  }
  return out;
}

/** For the admin pages: how devices recognise home for this source. level: unique | weak | none. */
function homeOf(src) {
  const probes = probesOf(src);
  const level = probes.some((p) => p.unique) ? 'unique' : (probes.length ? 'weak' : 'none');
  let why = null;
  if (level !== 'unique') why = src.kind === 'jellyfin' ? 'no_server_id' : 'no_cert';
  return { level, why, probes };
}

/** The share's folder for matching on the devices ("filme"). */
function folder(src) {
  const c = src.config || {};
  return folderOf((c.smb && c.smb.address) || (c.webdav && c.webdav.address));
}

module.exports = {
  KINDS, list, get, need, create, update, remove, setKey, setPassword, apiKey, password, awayOf, awayAddressOf, targetsOf, check, checkJellyfin, checkShare, cleanConfig, setStatus, folder, keyName, pwName, posInt,
  probesOf, homeOf, serverIdOf, hostPort,
};
