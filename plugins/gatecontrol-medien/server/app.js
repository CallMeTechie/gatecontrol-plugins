'use strict';

// App API v1 (/api/v1/client/plugins/gatecontrol-medien/api/v1/…): the GateControl apps on phones, TVs and PCs.
// The contract for the apps is in the plugin README ("App-API v1"). Every answer carries v: 1; new fields come
// without a new version, the apps ignore unknown ones.

const crypto = require('node:crypto');
const store = require('./store');
const jf = require('./jellyfin');
const sources = require('./sources');
const rights = require('./rights');
const mapping = require('./mapping');
const devices = require('./devices');
const log = require('./log');
const cast = require('./cast');
const { fail, str, deviceIdOf, sourceIdOf, iso } = require('./util');

const PAIR_PER_HOUR = 10;
const CODE_RE = /^[A-Za-z0-9]{4,16}$/;

/** The asking device (permissions.devices: req.user.device) or null. */
const deviceOf = (user) => (user && user.device && deviceIdOf(user.device.id)) || null;
function needDevice(user) {
  const d = deviceOf(user);
  if (!d) throw fail('no_device');
  return d;
}

async function needMedia(gc, user) {
  if (!(await rights.mediaOf(gc, user)).media) throw fail('no_access');
}

/** A source the person sees now (else no_access; unknown → not_found). */
async function visibleSource(gc, user, id, cfg) {
  const src = await sources.get(gc, sourceIdOf(id));
  if (!src) throw fail('not_found');
  if (!src.enabled) throw fail('no_access');
  await needMedia(gc, user);
  if (!(await rights.sourceAccess(gc, user, src, cfg)).allowed) throw fail('no_access');
  return src;
}

async function jellyfinEntry(gc, user, src, deviceId, cfg, deviceName, targets) {
  const st = src.status || {};
  const m = await mapping.of(gc, src.id, user.id);
  const linked = m && m.jf_user_id ? { id: m.jf_user_id, name: m.jf_user_name } : null;
  let device = null;
  let paired = false;
  if (deviceId) {
    device = { id: await devices.jellyfinDeviceId(gc, src.id, deviceId), name: devices.jellyfinDeviceName(deviceName || user.name) };
    const p = await store.one(gc, 'SELECT state, jf_user_id FROM pairings WHERE device_id = ? AND source_id = ?', [deviceId, src.id]);
    paired = !!(p && linked && p.jf_user_id === linked.id);
  }
  return {
    id: src.id, kind: 'jellyfin', name: src.name,
    serverId: sources.serverIdOf(src), version: st.version || null,
    address: src.config.address,
    home: { address: src.config.address },
    away: sources.awayOf(src, cfg, targets),
    user: linked, problem: linked ? (st.quickConnect === false ? 'quick_connect_off' : null) : 'no_mapping',
    device, paired,
    quickConnect: st.quickConnect == null ? null : st.quickConnect,
    downloads: src.config.downloads !== false, alwaysOriginal: src.config.alwaysOriginal === true,
  };
}

function shareEntry(src, cfg, targets) {
  const c = src.config;
  return {
    id: src.id, kind: 'share', name: src.name, folder: sources.folder(src),
    smb: c.smb ? { address: c.smb.address } : null,
    webdav: c.webdav ? { address: c.webdav.address, certSha256: c.webdav.certSha256 || null } : null,
    user: c.user, secretRev: src.secretRev,
    away: sources.awayOf(src, cfg, targets),
  };
}

/**
 * How a device tells "zu Hause" from "unterwegs": probes over the local network (never through the VPN), at least one
 * per visible source (sources.probesOf) — unique ones (jellyfin, tls) first, then tcp. At most 20.
 */
function homeProbes(list) {
  const all = [];
  for (const s of list) all.push(...sources.probesOf(s));
  return [...all.filter((p) => p.unique), ...all.filter((p) => !p.unique)].slice(0, 20);
}

async function list(gc, req, cfg, now) {
  const user = req.user;
  const deviceId = deviceOf(user);
  const media = (await rights.mediaOf(gc, user)).media;
  const all = media ? await rights.visibleSources(gc, user, await sources.list(gc), cfg) : [];
  let deviceName = null;
  if (deviceId && all.some((s) => s.kind === 'jellyfin')) {
    deviceName = await devices.deviceName(gc, deviceId);
    if (!deviceName) { const d = ((await devices.listOf(gc, user.id)) || []).find((x) => String(x.id) === deviceId); deviceName = d ? str(d.name, 60) : null; }
  }
  // away addresses of sources saved before 1.3.0 come from their route (only when one lacks a saved address)
  const targets = all.some((s) => !(s.config && s.config.away && s.config.away.address)) ? await sources.targetsOf(gc) : null;
  const out = [];
  for (const s of all) out.push(s.kind === 'jellyfin' ? await jellyfinEntry(gc, user, s, deviceId, cfg, deviceName, targets) : shareEntry(s, cfg, targets));
  const body = {
    media, maxOfflineDays: cfg.maxOfflineDays, offlineHintDays: cfg.offlineHintDays,
    network: { rule: 'home_direct_away_vpn', vpnRequiredAway: out.some((s) => s.away.mode === 'vpn'), home: { probes: homeProbes(all) } },
    cast: { enabled: cfg.cast && media },
    sources: out,
  };
  const rev = 'r' + crypto.createHash('sha256').update(JSON.stringify(body)).digest('base64url').slice(0, 12);
  if (deviceId) await devices.rememberContact(gc, user, now);
  if (req.query && req.query.since === rev) return { v: 1, rev, unchanged: true, at: iso(now) };
  return { v: 1, rev, at: iso(now), ...body };
}

async function secret(gc, req, id, cfg, now) {
  const deviceId = needDevice(req.user);
  const src = await visibleSource(gc, req.user, id, cfg);
  if (src.kind !== 'share') throw fail('not_found');
  const pw = await sources.password(gc, src);
  if (!pw) throw fail('not_configured');
  const name = (await devices.deviceName(gc, deviceId)) || deviceId;
  await store.run(gc, `INSERT INTO deliveries (device_id, source_id, user_id, secret_rev, device_name, at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_id, source_id) DO UPDATE SET user_id = excluded.user_id, secret_rev = excluded.secret_rev, device_name = excluded.device_name, at = excluded.at`,
  [deviceId, src.id, req.user.id, src.secretRev, name, now]);
  await devices.rememberContact(gc, req.user, now);
  await log.add(gc, 'secret', `Zugang zu ${src.name} (NAS) an ${name} (${req.user.name}) ausgeliefert`, { userId: req.user.id, deviceId, sourceId: src.id }, now);
  return { v: 1, user: src.config.user, password: pw, rev: src.secretRev };
}

/**
 * Pairing: the device started Quick Connect itself (with the DeviceId of v1/sources) and hands over the code; the
 * plugin confirms it for the linked user with the API key and checks that the confirmed request is this device's.
 */
async function pair(gc, req, cfg, now) {
  const deviceId = needDevice(req.user);
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const src = await visibleSource(gc, req.user, b.sourceId, cfg);
  if (src.kind !== 'jellyfin') throw fail('invalid', { field: 'sourceId' });
  const code = typeof b.code === 'string' ? b.code.trim() : '';
  if (!CODE_RE.test(code)) throw fail('code_invalid');
  if (!(await store.hit(gc, 'pair:' + deviceId, PAIR_PER_HOUR, 3600000, now))) throw fail('rate_limited');
  const m = await mapping.of(gc, src.id, req.user.id);
  if (!m || !m.jf_user_id) throw fail('no_mapping');
  const key = await sources.apiKey(gc, src);
  if (!key) throw fail('not_configured');
  const index = src.config.targetIndex || 0;
  const u = await jf.user(gc, index, key, m.jf_user_id);
  if (!u) { await mapping.clear(gc, src, req.user.id); throw fail('no_mapping'); }
  if (u.admin) throw fail('admin_user');
  if (u.disabled) throw fail('user_disabled');
  const jfDeviceId = await devices.jellyfinDeviceId(gc, src.id, deviceId);
  await jf.authorize(gc, index, key, code, u.id);
  // the confirmed request must be this device's: Jellyfin made a device with exactly our DeviceId for that user
  const d = await jf.device(gc, index, key, jfDeviceId).catch(() => null);
  if (!d || d.userId !== u.id) {
    await log.add(gc, 'warn', `Anmeldung von ${(await devices.deviceName(gc, deviceId)) || deviceId} bei ${src.name} abgelehnt: der Code gehörte zu einem anderen Gerät`, { userId: req.user.id, deviceId, sourceId: src.id }, now);
    throw fail('device_mismatch');
  }
  const name = (await devices.deviceName(gc, deviceId)) || null;
  await store.run(gc, `INSERT INTO pairings (device_id, source_id, user_id, jf_device_id, jf_user_id, jf_user_name, state, device_name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'authorized', ?, ?, ?)
    ON CONFLICT(device_id, source_id) DO UPDATE SET user_id = excluded.user_id, jf_device_id = excluded.jf_device_id, jf_user_id = excluded.jf_user_id,
    jf_user_name = excluded.jf_user_name, state = 'authorized', device_name = excluded.device_name, updated_at = excluded.updated_at`,
  [deviceId, src.id, req.user.id, jfDeviceId, u.id, u.name, name, now, now]);
  await devices.rememberContact(gc, req.user, now);
  await log.add(gc, 'pair', `${name || deviceId} bei Jellyfin (${src.name}) als ${u.name} angemeldet`, { userId: req.user.id, deviceId, sourceId: src.id }, now);
  return { v: 1, userId: u.id, userName: u.name, deviceId: jfDeviceId };
}

async function paired(gc, req, cfg, now) {
  const deviceId = needDevice(req.user);
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const src = await visibleSource(gc, req.user, b.sourceId, cfg);
  const p = await store.one(gc, 'SELECT * FROM pairings WHERE device_id = ? AND source_id = ?', [deviceId, src.id]);
  if (!p) throw fail('not_found');
  if (b.jellyfinDeviceId != null && b.jellyfinDeviceId !== p.jf_device_id) throw fail('device_mismatch');
  await store.run(gc, "UPDATE pairings SET state = 'paired', updated_at = ? WHERE device_id = ? AND source_id = ?", [now, deviceId, src.id]);
  return { v: 1 };
}

/** The app signs out of Jellyfin ("Medien zurücksetzen", app signed out): the plugin deletes the device there. */
async function unpair(gc, req, now) {
  const deviceId = needDevice(req.user);
  const sid = req.query && req.query.sourceId ? sourceIdOf(req.query.sourceId) : null;
  if (req.query && req.query.sourceId && !sid) throw fail('invalid', { field: 'sourceId' });
  const own = await store.all(gc, 'SELECT source_id FROM pairings WHERE device_id = ? AND user_id = ?', [deviceId, req.user.id]);
  const ids = own.map((r) => r.source_id).filter((x) => !sid || x === sid);
  if (ids.length) await devices.revoke(gc, deviceId, { sourceIds: ids, reason: 'app', push: false, sharesToo: false }, now);
  return { v: 1, sources: ids };
}

async function shareChecked(gc, req, id, cfg, now) {
  const deviceId = needDevice(req.user);
  const src = await visibleSource(gc, req.user, id, cfg);
  if (src.kind !== 'share') throw fail('not_found');
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  if (b.protocol !== 'smb' || typeof b.ok !== 'boolean') throw fail('invalid');
  const r = await store.run(gc, 'UPDATE deliveries SET smb_ok = ?, smb_problem = ?, smb_at = ? WHERE device_id = ? AND source_id = ?',
    [b.ok ? 1 : 0, b.ok ? null : (str(b.problem, 120) || 'failed'), now, deviceId, src.id]);
  if (!r || !r.changes) throw fail('not_found');
  return { v: 1 };
}

/** The device's way to a source (home / away) — shown on the devices tab, e.g. "NAS durch den Tunnel nicht erreichbar". */
async function report(gc, req, id, cfg, now) {
  const deviceId = needDevice(req.user);
  const src = await visibleSource(gc, req.user, id, cfg);
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  if (!['home', 'away'].includes(b.way) || typeof b.ok !== 'boolean') throw fail('invalid');
  await store.run(gc, `INSERT INTO reports (device_id, source_id, way, ok, problem, at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_id, source_id, way) DO UPDATE SET ok = excluded.ok, problem = excluded.problem, at = excluded.at`,
  [deviceId, src.id, b.way, b.ok ? 1 : 0, b.ok ? null : (str(b.problem, 160) || 'failed'), now]);
  return { v: 1 };
}

async function route(req, gc, seg, cfg, now = Date.now()) {
  const user = req.user;
  if (!user || !user.app || !Number.isSafeInteger(user.id)) throw fail('forbidden');
  const m = String(req.method || 'GET').toUpperCase();
  const [, a, b, c, d] = seg;
  if (a === 'sources' && !b && m === 'GET') return list(gc, req, cfg, now);
  if (a === 'sources' && b && c === 'secret' && m === 'GET') return secret(gc, req, b, cfg, now);
  if (a === 'sources' && b && c === 'report' && m === 'POST') return report(gc, req, b, cfg, now);
  if (a === 'jellyfin' && b === 'pair' && m === 'POST') return pair(gc, req, cfg, now);
  if (a === 'jellyfin' && b === 'paired' && m === 'POST') return paired(gc, req, cfg, now);
  if (a === 'jellyfin' && b === 'device' && m === 'DELETE') return unpair(gc, req, now);
  if (a === 'shares' && b && c === 'checked' && m === 'POST') return shareChecked(gc, req, b, cfg, now);
  if (a === 'cast' && b === 'targets' && !c && m === 'GET') return cast.targets(gc, req, cfg);
  if (a === 'cast' && b && c === 'message' && !d && m === 'POST') return cast.message(gc, req, b, cfg, now);
  if (a === 'handoff' && !b && m === 'POST') return cast.handoff(gc, req, cfg, now);
  throw fail('not_found');
}

module.exports = { route, list, deviceOf, visibleSource, homeProbes };
