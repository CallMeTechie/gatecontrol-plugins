'use strict';

// Take-over of the built-in Remote Desktops (dataset "remote", hook
// legacyImport — docs/plugins.md "Built-in data import"). The administrator
// starts it on the plugin's page in the plugin area ("Daten übernehmen") and
// can run it again ("Erneut übernehmen"): the taken-over devices and their
// history are replaced, devices made in the plugin stay.
//
//   routes[]        → devices (ids kept: rights and history keep matching), the settings
//                     as they were; credentials arrive as vault handles of GateControl
//                     (never a password); a gateway target gets the listener route-<id>,
//                     which reuses the L4 port of the old route
//   user_ids, group_ids, token_ids → the access lists of the devices
//   who could see a target before → the right "Remote Desktops nutzen" (RDP, VNC) or
//                     "SSH nutzen" (SSH, Telnet) — never taken away from someone an
//                     administrator already decided for
//   sessions[]      → the history (ids kept)
//   maintenance[]   → the maintenance windows of the devices

const store = require('./store');
const devices = require('./devices');
const rights = require('./rights');
const { bool, clip, parseTime } = require('./util');

const IMPORT_KEY = 'remote.import';
const CHUNK = 500;

const ids = (v) => (Array.isArray(v) ? [...new Set(v.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))] : []);

/** One route of the snapshot → a device (bad values fall back to the default instead of failing the whole import). */
function deviceOf(r, now) {
  const protocol = devices.PROTOCOLS.includes(r.protocol) ? r.protocol : 'rdp';
  const config = { ...devices.DEFAULTS, port: devices.DEFAULT_PORT[protocol] };
  for (const k of Object.keys(devices.FIELDS)) {
    if (r[k] === undefined) continue;
    let v = r[k];
    if (devices.FIELDS[k] === 'bool') v = bool(v);
    if (k === 'tags' && !Array.isArray(v)) v = [];
    try { config[k] = devices.checkField(k, v); } catch { /* keep the default */ }
  }
  // host names of old rows may carry characters the page refuses — keep them as they were
  if (typeof r.host === 'string' && r.host.trim()) config.host = r.host.trim().slice(0, 253);
  for (const k of devices.KEPT) if (r[k] !== undefined) config[k] = devices.BOOLS.includes(k) ? bool(r[k]) : r[k];
  if (config.access_mode === 'gateway' && !config.gateway_listen_port) config.gateway_listen_port = config.port;
  // 1.2: a taken-over SSH target stays on Guacamole until an administrator switches it to the terminal
  config.ssh_engine = 'guac';
  const created = parseTime(r.created_at) || now;
  return {
    id: r.id, name: clip(String(r.name || ''), 100) || ('#' + r.id), protocol, enabled: r.enabled === undefined ? true : bool(r.enabled), source: 'import', config,
    credential: typeof r.credential === 'string' && r.credential ? r.credential : null,
    sftpCredential: typeof r.sftp_credential === 'string' && r.sftp_credential ? r.sftp_credential : null,
    credentialUnreadable: bool(r.credential_unreadable), listener: null, listenerError: null, createdAt: created,
    access: { users: ids(r.user_ids), groups: ids(r.group_ids), tokens: ids(r.token_ids) },
  };
}

function normalise(snapshot) {
  const s = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const routes = (Array.isArray(s.routes) ? s.routes : []).filter((r) => r && Number.isSafeInteger(r.id) && r.id > 0 && r.id < devices.FIRST_OWN_ID);
  const sessions = (Array.isArray(s.sessions) ? s.sessions : []).filter((x) => x && Number.isSafeInteger(x.id) && x.id > 0 && Number.isSafeInteger(x.route_id));
  const maintenance = Array.isArray(s.maintenance) ? s.maintenance.filter((m) => m && Number.isSafeInteger(m.route_id)) : [];
  return { routes, sessions, maintenance };
}

async function insertSessions(gc, rows, names) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK).map((x) => {
      const started = parseTime(x.started_at) || 0;
      const ended = parseTime(x.ended_at);
      return {
        id: x.id, device_id: x.route_id, device_name: names.get(x.route_id) || null, token_id: Number.isSafeInteger(x.token_id) ? x.token_id : null,
        token_name: x.token_name ? String(x.token_name).slice(0, 120) : null, peer_id: Number.isSafeInteger(x.peer_id) ? x.peer_id : null,
        status: x.status === 'active' ? 'active' : 'ended', protocol: devices.PROTOCOLS.includes(x.protocol) ? x.protocol : 'rdp',
        via: x.via === 'browser' ? 'browser' : 'native', started_at: started, last_heartbeat: parseTime(x.last_heartbeat), ended_at: ended,
        duration_seconds: Number.isInteger(x.duration_seconds) ? x.duration_seconds : null, end_reason: x.end_reason ? String(x.end_reason).slice(0, 40) : null,
        client_ip: x.client_ip ? String(x.client_ip).slice(0, 64) : null,
      };
    });
    await gc.db.run(`INSERT OR REPLACE INTO sessions (id, device_id, device_name, token_id, token_name, peer_id, status, protocol, via, started_at, last_heartbeat, ended_at, duration_seconds, end_reason, client_ip, imported)
      SELECT json_extract(value, '$.id'), json_extract(value, '$.device_id'), json_extract(value, '$.device_name'), json_extract(value, '$.token_id'),
        json_extract(value, '$.token_name'), json_extract(value, '$.peer_id'), json_extract(value, '$.status'), json_extract(value, '$.protocol'),
        json_extract(value, '$.via'), json_extract(value, '$.started_at'), json_extract(value, '$.last_heartbeat'), json_extract(value, '$.ended_at'),
        json_extract(value, '$.duration_seconds'), json_extract(value, '$.end_reason'), json_extract(value, '$.client_ip'), 1 FROM json_each(?)`, [JSON.stringify(chunk)]);
  }
}

/** Who could see a target before (src/services/rdpAcl.js): the listed people and groups, else everybody. */
async function grantRights(gc, list, now) {
  let users = [];
  try { users = (await gc.users.list()) || []; } catch { users = []; }
  let n = 0;
  for (const u of users) {
    if (u.role === 'admin') continue;
    const mine = await rights.groupsOf(gc, u.id);
    const sees = (d) => (d.access.users.length || d.access.groups.length ? d.access.users.includes(u.id) || d.access.groups.some((g) => mine.includes(g)) : true);
    const seen = list.filter((d) => d.enabled && sees(d));
    for (const key of ['rdp', 'ssh']) {
      if (seen.some((d) => rights.rightFor(d.protocol) === key)) { await rights.grant(gc, u.id, key, now); n++; }
    }
  }
  rights.reset();
  return n;
}

/**
 * legacyImport hook → { ok: true, counts }
 */
async function importSnapshot(snapshot, gc, now = Date.now()) {
  const data = normalise(snapshot);
  const list = data.routes.map((r) => deviceOf(r, now));
  for (const m of data.maintenance) {
    const d = list.find((x) => x.id === m.route_id);
    if (!d) continue;
    d.config.maintenance_enabled = bool(m.enabled);
    if (typeof m.schedule === 'string') d.config.maintenance_schedule = m.schedule.slice(0, 1000);
  }
  const before = (await devices.all(gc)).filter((d) => d.source === 'import');
  const keep = new Set(list.map((d) => d.id));
  // a re-run keeps what only the plugin knows (1.2: terminal, tmux, recording)
  for (const d of list) {
    const prev = before.find((x) => x.id === d.id);
    if (!prev) continue;
    for (const k of ['ssh_engine', 'tmux_enabled', 'tmux_name', 'recording', 'term_tested_at']) if (prev.config[k] !== undefined) d.config[k] = prev.config[k];
  }
  // a target of a gateway: the listener that reuses the old route's L4 port
  let listenerErrors = 0;
  if (gc.remote) {
    for (const d of list) {
      if (d.config.access_mode !== 'gateway') continue;
      const c = d.config;
      const key = 'route-' + d.id;
      if (!c.gateway_peer_id && !c.gateway_pool_id) { d.listener = key; d.listenerError = 'no_gateway'; listenerErrors++; continue; }
      try {
        const l = await gc.remote.listener({ key, gateway: c.gateway_pool_id ? { poolId: c.gateway_pool_id } : { peerId: c.gateway_peer_id }, host: c.host, port: c.port, listenPort: c.gateway_listen_port || c.port });
        d.listener = l.key;
      } catch (e) {
        d.listener = key;
        d.listenerError = String((e && e.code) || 'error').slice(0, 60);
        listenerErrors++;
        gc.log.warn('listener of a taken-over gateway target not made', d.id, (e && e.code) || 'error');
      }
    }
    for (const d of before) {
      if (keep.has(d.id) || !d.listener) continue;
      try { await gc.remote.listener.remove(d.listener); } catch { /* gone already */ }
    }
  }
  const names = new Map(list.map((d) => [d.id, d.name]));
  await store.tx(gc, async () => {
    for (const d of before) {
      if (keep.has(d.id)) continue;
      await store.run(gc, 'DELETE FROM device_access WHERE device_id = ?', [d.id]);
      await store.run(gc, 'DELETE FROM devices WHERE id = ?', [d.id]);
    }
    for (const d of list) {
      // a device of the plugin with this id cannot exist (they start at 100000) — an imported one is replaced
      await devices.write(gc, d, now);
      await store.run(gc, 'DELETE FROM device_access WHERE device_id = ?', [d.id]);
      await devices.setAccess(gc, d.id, d.access);
    }
    await store.run(gc, 'DELETE FROM sessions WHERE imported = 1');
    await insertSessions(gc, data.sessions, names);
  });
  const granted = await grantRights(gc, list, now);
  let prev = null;
  try { prev = await gc.settings.get(IMPORT_KEY); } catch { prev = null; }
  if (typeof prev === 'string') { try { prev = JSON.parse(prev); } catch { prev = null; } }
  const counts = { devices: list.length, sessions: data.sessions.length, maintenance: list.filter((d) => d.config.maintenance_enabled).length, listenerErrors, rights: granted,
    unreadable: list.filter((d) => d.credentialUnreadable).length };
  await gc.settings.set(IMPORT_KEY, { at: new Date(now).toISOString(), counts, runs: ((prev && prev.runs) || 0) + 1 });
  gc.log.info('built-in Remote Desktops taken over', JSON.stringify(counts));
  return { ok: true, counts };
}

async function lastImport(gc) {
  let v = null;
  try { v = await gc.settings.get(IMPORT_KEY); } catch { v = null; }
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
  return v && typeof v === 'object' ? v : null;
}

module.exports = { importSnapshot, normalise, deviceOf, lastImport, IMPORT_KEY };
