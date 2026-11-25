'use strict';

// The devices: their Jellyfin sign-ins (pairings), the NAS passwords handed out (deliveries), the revocation and the
// reconcile (every 5 minutes, and at once through the hook devicesChanged of a GateControl that has it).
//
// Revoking a device: the plugin deletes the device in Jellyfin (DELETE /Devices?id=gc-… — every token of that device
// ends at once) and sends the device a silent signal { kind: 'media.revoke', sourceIds, reason } (signal topic
// media_signal: past the person's switches and quiet hours; a device that is offline gets it when it connects).
// owner_changed (the token went to another person) counts as removed for the old owner.
// A NAS password cannot be taken back from a device that never comes online again — the devices tab says so.

const store = require('./store');
const jf = require('./jellyfin');
const sources = require('./sources');
const rights = require('./rights');
const mapping = require('./mapping');
const log = require('./log');
const { b62, str, deviceIdOf } = require('./util');

const SIGNAL = 'media_signal';

/** The Jellyfin DeviceId of a GateControl device for a source: "gc-" + 20 characters, stable, not guessable. */
async function jellyfinDeviceId(gc, sourceId, deviceId) {
  return 'gc-' + b62(await store.pepper(gc), sourceId + ':' + deviceId, 20);
}
const jellyfinDeviceName = (name) => 'GateControl · ' + (str(name, 60) || 'Gerät');

/** The person's GateControl apps ([] when the host cannot list them). */
async function listOf(gc, userId) {
  try { return (await gc.devices.list({ userId })) || []; } catch (e) { gc.log.debug('devices unavailable', (e && e.code) || 'error'); return null; }
}

/** A silent signal to one or more devices of a person (never throws). */
async function signal(gc, userId, deviceIds, data) {
  const devices = [...new Set((deviceIds || []).map(deviceIdOf).filter(Boolean))];
  if (!devices.length) return false;
  try {
    const r = await gc.notify({ topic: SIGNAL, users: [userId], devices, silent: true, data });
    return !!(r && r.pushed !== false);
  } catch (e) { gc.log.debug('signal not sent', (e && e.code) || 'error'); return false; }
}

async function rememberContact(gc, user, now = Date.now()) {
  const d = user && user.device;
  const id = d && deviceIdOf(d.id);
  if (!id) return;
  await store.run(gc, `INSERT INTO known_devices (device_id, user_id, platform, client_type, last_contact) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET user_id = excluded.user_id, platform = COALESCE(excluded.platform, known_devices.platform),
    client_type = COALESCE(excluded.client_type, known_devices.client_type), last_contact = excluded.last_contact, removed_at = NULL`,
  [id, user.id, str(d.platform, 20) || null, str(d.clientType, 20) || null, now]);
}

async function deviceName(gc, deviceId) {
  const r = await store.one(gc, 'SELECT name FROM known_devices WHERE device_id = ?', [deviceId]);
  return (r && r.name) || null;
}

/**
 * Revoke one device for the given sources (all when sourceIds is null): Jellyfin device deleted, deliveries dropped,
 * a silent signal unless `push: false` (a device removed in GateControl cannot be reached any more).
 */
async function revoke(gc, deviceId, o = {}, now = Date.now()) {
  const reason = o.reason || 'admin';
  const where = o.sourceIds ? ` AND source_id IN (${store.marks(o.sourceIds.length)})` : '';
  const args = o.sourceIds ? [deviceId, ...o.sourceIds] : [deviceId];
  const pairs = await store.all(gc, 'SELECT * FROM pairings WHERE device_id = ?' + where, args);
  const dels = await store.all(gc, 'SELECT * FROM deliveries WHERE device_id = ?' + (o.sharesToo === false ? ' AND 0' : where), args);
  const name = (pairs[0] && pairs[0].device_name) || (dels[0] && dels[0].device_name) || (await deviceName(gc, deviceId)) || deviceId;
  const touched = new Set();
  let userId = (pairs[0] && pairs[0].user_id) || (dels[0] && dels[0].user_id) || o.userId || null;
  for (const p of pairs) {
    const src = await sources.get(gc, p.source_id);
    let gone = true;
    if (src) {
      const key = await sources.apiKey(gc, src);
      try { if (key) await jf.deleteDevice(gc, src.config.targetIndex || 0, key, p.jf_device_id); } catch (e) {
        gone = false;
        gc.log.warn('jellyfin device not deleted', (e && e.code) || 'error');
      }
    }
    if (!gone && o.keepOnError) continue;
    await store.run(gc, 'DELETE FROM pairings WHERE device_id = ? AND source_id = ?', [deviceId, p.source_id]);
    touched.add(p.source_id);
    await log.add(gc, 'revoke', `${name}: bei Jellyfin abgemeldet (${src ? src.name : p.source_id}, ${reasonText(reason)})`, { userId: p.user_id, deviceId, sourceId: p.source_id }, now);
  }
  for (const d of dels) {
    await store.run(gc, 'DELETE FROM deliveries WHERE device_id = ? AND source_id = ?', [deviceId, d.source_id]);
    touched.add(d.source_id);
    const src = await sources.get(gc, d.source_id);
    await log.add(gc, 'revoke', `${name}: Zugang zu ${src ? src.name : d.source_id} entzogen (${reasonText(reason)})` + (o.push === false ? ' – das Gerät hatte das NAS-Passwort' : ''), { userId: d.user_id, deviceId, sourceId: d.source_id }, now);
  }
  if (o.push !== false && userId && (touched.size || o.always)) {
    await signal(gc, userId, [deviceId], { kind: 'media.revoke', sourceIds: o.sourceIds ? [...touched] : null, reason });
  }
  return [...touched];
}

function reasonText(r) {
  return ({ admin: 'vom Admin', device_removed: 'Gerät in GateControl entfernt', user: 'Person deaktiviert', right: 'kein Recht mehr', mapping: 'Zuordnung geändert',
    source: 'Quelle entfernt', app: 'von der App', license: 'Lizenz' })[r] || r;
}

/**
 * Reconcile: devices removed in GateControl, people disabled, rights or mappings changed, sources removed → revoke.
 * Also checks the Jellyfin servers and links new people by name (setting auto_map). → { revoked, mapped, changed }
 */
async function reconcile(gc, cfg, now = Date.now(), o = {}) {
  const out = { revoked: 0, mapped: 0, changed: false };
  const users = (await gc.users.list()) || [];
  const byId = new Map(users.map((u) => [u.id, u]));
  const all = await sources.list(gc);
  const srcById = new Map(all.map((s) => [s.id, s]));
  const present = new Map();
  let complete = true;
  const mediaUsers = [];
  for (const u of users) {
    const m = await rights.mediaOf(gc, u);
    if (m.media) mediaUsers.push(u);
    const list = await listOf(gc, u.id);
    if (list == null) { complete = false; continue; }
    for (const d of list) {
      const id = deviceIdOf(d.id);
      if (!id) continue;
      present.set(id, u.id);
      await store.run(gc, `INSERT INTO known_devices (device_id, user_id, name, platform, client_type, last_seen) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(device_id) DO UPDATE SET user_id = excluded.user_id, name = excluded.name, platform = excluded.platform, client_type = excluded.client_type,
        last_seen = excluded.last_seen, removed_at = NULL`, [id, u.id, str(d.name, 80) || null, str(d.platform, 20) || null, str(d.clientType, 20) || null, str(d.lastSeen, 40) || null]);
    }
  }
  // devices that are gone (only when every list could be read — a host without gc.devices removes nothing)
  if (complete) {
    const known = await store.all(gc, 'SELECT device_id, user_id FROM known_devices WHERE removed_at IS NULL');
    for (const k of known) {
      if (present.has(k.device_id)) continue;
      await store.run(gc, 'UPDATE known_devices SET removed_at = ? WHERE device_id = ?', [now, k.device_id]);
    }
  }
  const removed = new Set((await store.all(gc, 'SELECT device_id FROM known_devices WHERE removed_at IS NOT NULL')).map((r) => r.device_id));
  const rows = [
    ...(await store.all(gc, "SELECT device_id, source_id, user_id, jf_user_id, 'pair' AS t FROM pairings")),
    ...(await store.all(gc, "SELECT device_id, source_id, user_id, NULL AS jf_user_id, 'share' AS t FROM deliveries")),
  ];
  const decided = new Map();
  for (const r of rows) {
    const src = srcById.get(r.source_id);
    const u = byId.get(r.user_id);
    let reason = null;
    if (removed.has(r.device_id) || (complete && !present.has(r.device_id))) reason = 'device_removed';
    else if (complete && present.get(r.device_id) !== r.user_id) reason = 'device_removed';
    else if (!u) reason = 'user';
    else if (!src || !src.enabled) reason = 'source';
    else {
      const key = u.id + ':' + src.id;
      if (!decided.has(key)) decided.set(key, (await rights.mediaOf(gc, u)).media && (await rights.sourceAccess(gc, u, src, cfg)).allowed);
      if (!decided.get(key)) reason = 'right';
      else if (r.t === 'pair') {
        const m = await mapping.of(gc, src.id, u.id);
        if (!m || m.jf_user_id !== r.jf_user_id) reason = 'mapping';
      }
    }
    if (!reason) continue;
    const t = await revoke(gc, r.device_id, { sourceIds: [r.source_id], reason, push: reason !== 'device_removed' && reason !== 'user', userId: r.user_id }, now);
    if (t.length) { out.revoked++; out.changed = true; }
  }
  // the Jellyfin servers: version, Quick Connect, libraries (o.check: false skips it, e.g. right after a device was removed)
  if (o.check !== false) {
    for (const s of all) {
      if (!s.enabled || s.kind !== 'jellyfin') continue;
      try { await sources.check(gc, s, now); } catch (e) { gc.log.debug('check failed', (e && e.code) || 'error'); }
      if (cfg.autoMap) {
        try {
          const made = await mapping.auto(gc, s, mediaUsers, now);
          for (const m of made) await log.add(gc, 'mapping', `${(byId.get(m.userId) || {}).name || m.userId} automatisch mit ${m.jfUserName} verknüpft (${s.name})`, { userId: m.userId, sourceId: s.id }, now);
          if (made.length) { out.mapped += made.length; out.changed = true; }
        } catch (e) { gc.log.debug('auto mapping failed', (e && e.code) || 'error'); }
      }
    }
  }
  // a device removed long ago: forget it after 90 days
  await store.run(gc, 'DELETE FROM known_devices WHERE removed_at IS NOT NULL AND removed_at < ?', [now - 90 * 86400000]);
  return out;
}

/** The devices tab: every app of people with the right "Medien" or with something handed out, plus removed ones that had a password. */
async function overview(gc, cfg) {
  const users = (await gc.users.list()) || [];
  const byId = new Map(users.map((u) => [u.id, u]));
  const pairs = await store.all(gc, 'SELECT * FROM pairings');
  const dels = await store.all(gc, 'SELECT * FROM deliveries');
  const reports = await store.all(gc, 'SELECT * FROM reports');
  const known = await store.all(gc, 'SELECT * FROM known_devices');
  const srcs = new Map((await sources.list(gc)).map((s) => [s.id, s]));
  const out = [];
  const seen = new Set();
  const row = (id, userId, d, k) => ({
    id, userId, person: (byId.get(userId) || {}).name || null,
    name: (d && d.name) || (k && k.name) || null, platform: (d && d.platform) || (k && k.platform) || null, clientType: (d && d.clientType) || (k && k.client_type) || null,
    appVersion: (d && d.appVersion) || null, online: d ? !!d.online : false, lastSeen: (d && d.lastSeen) || (k && k.last_seen) || null, via: (d && d.via) || null,
    removed: !!(k && k.removed_at), lastContact: (k && k.last_contact) || null,
    jellyfin: pairs.filter((p) => p.device_id === id).map((p) => ({ sourceId: p.source_id, source: (srcs.get(p.source_id) || {}).name || p.source_id, user: p.jf_user_name, state: p.state, at: p.updated_at })),
    shares: dels.filter((x) => x.device_id === id).map((x) => ({ sourceId: x.source_id, source: (srcs.get(x.source_id) || {}).name || x.source_id, rev: x.secret_rev,
      current: (srcs.get(x.source_id) || {}).secretRev === x.secret_rev, at: x.at, smb: x.smb_ok == null ? null : x.smb_ok === 1, smbProblem: x.smb_problem })),
    reports: reports.filter((r) => r.device_id === id).map((r) => ({ sourceId: r.source_id, way: r.way, ok: r.ok === 1, problem: r.problem, at: r.at })),
  });
  for (const u of users) {
    const m = await rights.mediaOf(gc, u);
    const has = pairs.some((p) => p.user_id === u.id) || dels.some((x) => x.user_id === u.id);
    if (!m.media && !has) continue;
    const list = (await listOf(gc, u.id)) || [];
    for (const d of list) {
      const id = deviceIdOf(d.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ ...row(id, u.id, d, known.find((k) => k.device_id === id)), media: m.media });
    }
  }
  for (const k of known) {
    if (seen.has(k.device_id)) continue;
    const r = row(k.device_id, k.user_id, null, k);
    if (!r.jellyfin.length && !r.shares.length && !k.removed_at) continue;
    seen.add(k.device_id);
    out.push({ ...r, media: false });
  }
  // a pairing of a device the plugin never listed (e.g. the list was not readable)
  for (const p of [...pairs, ...dels]) {
    if (seen.has(p.device_id)) continue;
    seen.add(p.device_id);
    out.push({ ...row(p.device_id, p.user_id, null, { name: p.device_name }), media: false });
  }
  void cfg;
  return out;
}

module.exports = { SIGNAL, jellyfinDeviceId, jellyfinDeviceName, listOf, signal, revoke, reconcile, overview, rememberContact, deviceName, reasonText };
