'use strict';

// The history (admin page "Sitzungen"): sessions of the apps (they report start,
// heartbeat and end through the old app API, facade.js) and browser sessions
// (GateControl's event gc.remote.on('session')). Taken-over rows keep the id
// of rdp_sessions; new ones start at 1000000000. Recording comes in a later
// version (gc.remote.recordings.available() says when).

const store = require('./store');
const { fail, iso, posInt } = require('./util');

const FIRST_OWN_ID = 1000000000;
const STALE_HEARTBEAT_MS = 300000;   // an app's session without a heartbeat for 5 minutes ends ("timeout"), as before
const STALE_START_MS = 300000;       // … or one that never sent a heartbeat

async function nextId(gc) {
  const r = await store.one(gc, 'SELECT MAX(id) AS m FROM sessions');
  return Math.max((r && r.m) || 0, FIRST_OWN_ID - 1) + 1;
}

function devIdOf(targetId) {
  const m = /^dev-(\d{1,12})$/.exec(String(targetId || ''));
  return m ? Number(m[1]) : null;
}

/** GateControl's event of a browser session: start → a row, end / abort → closed. */
async function onEvent(gc, ev, now = Date.now()) {
  if (!ev || typeof ev !== 'object' || !Number.isSafeInteger(ev.sessionId)) return;
  const deviceId = devIdOf(ev.targetId);
  if (ev.phase === 'start') {
    const d = deviceId ? await store.one(gc, 'SELECT name FROM devices WHERE id = ?', [deviceId]) : null;
    const started = Date.parse(ev.startedAt) || now;
    await store.tx(gc, async () => {
      if (await store.one(gc, 'SELECT id FROM sessions WHERE host_session_id = ?', [ev.sessionId])) return;
      await store.run(gc, `INSERT INTO sessions (id, device_id, device_name, user_id, status, protocol, mode, via, started_at, host_session_id)
        VALUES (?, ?, ?, ?, 'active', ?, ?, 'browser', ?, ?)`,
      [await nextId(gc), deviceId || 0, d ? d.name : null, ev.userId || null, ev.protocol || 'rdp', ev.mode || 'control', started, ev.sessionId]);
    });
    return;
  }
  if (ev.phase === 'end' || ev.phase === 'abort') {
    const ended = Date.parse(ev.endedAt) || now;
    const row = await store.one(gc, 'SELECT id, started_at FROM sessions WHERE host_session_id = ?', [ev.sessionId]);
    if (!row) return;
    const dur = Number.isInteger(ev.durationSeconds) ? ev.durationSeconds : Math.max(0, Math.round((ended - row.started_at) / 1000));
    await store.run(gc, "UPDATE sessions SET status = 'ended', ended_at = ?, duration_seconds = ?, end_reason = ? WHERE id = ? AND status = 'active'",
      [ended, dur, String(ev.reason || (ev.phase === 'abort' ? 'aborted' : 'normal')).slice(0, 40), row.id]);
  }
}

/** An app reports a session start (POST /api/v1/client/rdp/:id/session) → { id, status, started_at } */
async function nativeStart(gc, device, who, now = Date.now()) {
  const id = await store.tx(gc, async () => {
    const n = await nextId(gc);
    await store.run(gc, `INSERT INTO sessions (id, device_id, device_name, user_id, token_id, token_name, peer_id, status, protocol, via, started_at, client_ip)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, 'native', ?, ?)`,
    [n, device.id, device.name, who.userId || null, who.tokenId || null, who.tokenName || null, who.peerId || null, device.protocol, now, who.ip || null]);
    return n;
  });
  return { id, status: 'active', started_at: iso(now) };
}

/** A session belongs to the caller: the same token or the same VPN device (the old rule). */
const ownedBy = (row, who) => (who.tokenId != null && row.token_id != null && row.token_id === who.tokenId)
  || (who.peerId != null && row.peer_id != null && row.peer_id === who.peerId);

async function heartbeat(gc, sessionId, who, now = Date.now()) {
  const id = posInt(sessionId);
  if (!id) throw fail('invalid', { field: 'sessionId' });
  const row = await store.one(gc, 'SELECT * FROM sessions WHERE id = ?', [id]);
  if (!row) throw fail('not_found', { message: 'Session not found' });
  if (!ownedBy(row, who)) throw fail('forbidden', { message: 'Not your session' });
  if (row.status !== 'active') throw fail('not_found', { message: 'Session is not active' });
  await store.run(gc, 'UPDATE sessions SET last_heartbeat = ? WHERE id = ?', [now, id]);
}

/** End an app's session: by id, else the caller's newest open one of the device → { id, duration_seconds, end_reason } */
async function nativeEnd(gc, deviceId, sessionId, reason, who, now = Date.now()) {
  let row = null;
  const id = sessionId == null ? null : posInt(sessionId);
  if (id) row = await store.one(gc, 'SELECT * FROM sessions WHERE id = ?', [id]);
  else if (who.tokenId != null) row = await store.one(gc, "SELECT * FROM sessions WHERE device_id = ? AND token_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1", [deviceId, who.tokenId]);
  else if (who.peerId != null) row = await store.one(gc, "SELECT * FROM sessions WHERE device_id = ? AND peer_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1", [deviceId, who.peerId]);
  if (!row && !id) throw fail('invalid', { message: 'No active session found' });
  if (!row) throw fail('not_found', { message: 'Session not found' });
  if (!ownedBy(row, who)) throw fail('forbidden', { message: 'Not your session' });
  const dur = Math.max(0, Math.floor((now - row.started_at) / 1000));
  const why = String(reason || 'normal').replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || 'normal';
  await store.run(gc, "UPDATE sessions SET status = 'ended', ended_at = ?, duration_seconds = ?, end_reason = ? WHERE id = ?", [now, dur, why, row.id]);
  return { id: row.id, duration_seconds: dur, end_reason: why };
}

/** Apps that stopped reporting: their sessions end as "timeout" (the old cleanup). */
async function sweep(gc, now = Date.now()) {
  const rows = await store.all(gc, `SELECT id, started_at FROM sessions WHERE status = 'active' AND via = 'native'
    AND ((last_heartbeat IS NOT NULL AND last_heartbeat < ?) OR (last_heartbeat IS NULL AND started_at < ?))`, [now - STALE_HEARTBEAT_MS, now - STALE_START_MS]);
  for (const r of rows) {
    await store.run(gc, "UPDATE sessions SET status = 'ended', ended_at = ?, duration_seconds = ?, end_reason = 'timeout' WHERE id = ?",
      [now, Math.max(0, Math.floor((now - r.started_at) / 1000)), r.id]);
  }
  return rows.length;
}

/** Browser sessions GateControl no longer runs (a restart ends every ticket): closed as "server_restart". */
async function reconcile(gc, now = Date.now()) {
  if (!gc.remote) return 0;
  let live;
  try { live = (await gc.remote.sessions({ active: true, limit: 500 })) || []; } catch { return 0; }
  const ids = new Set(live.map((s) => s.id));
  const open = await store.all(gc, "SELECT id, host_session_id, started_at FROM sessions WHERE status = 'active' AND via = 'browser' AND host_session_id IS NOT NULL");
  let n = 0;
  for (const r of open) {
    if (ids.has(r.host_session_id)) continue;
    if (now - r.started_at < 60000) continue;
    await store.run(gc, "UPDATE sessions SET status = 'ended', ended_at = ?, duration_seconds = ?, end_reason = 'server_restart' WHERE id = ?",
      [now, Math.max(0, Math.floor((now - r.started_at) / 1000)), r.id]);
    n++;
  }
  return n;
}

function view(r, names) {
  return {
    id: r.id, deviceId: r.device_id, deviceName: r.device_name, userId: r.user_id, userName: r.user_id ? (names.get(r.user_id) || null) : null,
    tokenName: r.token_name, status: r.status, protocol: r.protocol, mode: r.mode, via: r.via,
    startedAt: iso(r.started_at), endedAt: iso(r.ended_at), durationSeconds: r.duration_seconds, endReason: r.end_reason, clientIp: r.client_ip,
    hostSessionId: r.host_session_id, imported: r.imported === 1,
  };
}

async function namesOf(gc) {
  const m = new Map();
  try { for (const u of (await gc.users.list()) || []) m.set(u.id, u.name); } catch { /* names stay empty */ }
  return m;
}

/** The newest sessions: { deviceId, userId, status, before (id), limit ≤ 200 } */
async function list(gc, o = {}) {
  const where = [];
  const p = [];
  if (posInt(o.deviceId)) { where.push('device_id = ?'); p.push(posInt(o.deviceId)); }
  if (posInt(o.userId)) { where.push('user_id = ?'); p.push(posInt(o.userId)); }
  if (o.status === 'active' || o.status === 'ended') { where.push('status = ?'); p.push(o.status); }
  if (posInt(o.before)) { where.push('started_at < (SELECT started_at FROM sessions WHERE id = ?)'); p.push(posInt(o.before)); }
  const limit = Math.min(200, posInt(o.limit) || 100);
  const rows = await store.all(gc, `SELECT * FROM sessions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY started_at DESC, id DESC LIMIT ${limit}`, p);
  const names = await namesOf(gc);
  return rows.map((r) => view(r, names));
}

/** CSV of the history (the export of the former page) — every cell quoted, formulas neutralised. */
async function csv(gc) {
  const rows = await store.all(gc, 'SELECT * FROM sessions ORDER BY started_at DESC LIMIT 20000');
  const names = await namesOf(gc);
  const esc = (v) => {
    if (v == null) return '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const head = 'id,device,person,token,protocol,via,status,started_at,ended_at,duration_seconds,end_reason,client_ip';
  return [head, ...rows.map((r) => [r.id, r.device_name, r.user_id ? names.get(r.user_id) : '', r.token_name, r.protocol, r.via, r.status,
    iso(r.started_at), iso(r.ended_at), r.duration_seconds, r.end_reason, r.client_ip].map(esc).join(','))].join('\n');
}

async function purge(gc, days, now = Date.now()) {
  const r = await store.run(gc, "DELETE FROM sessions WHERE status = 'ended' AND started_at < ?", [now - days * 86400000]);
  return (r && r.changes) || 0;
}

/** Open sessions per device (for the device list) → Map deviceId → count */
async function activeCounts(gc) {
  const m = new Map();
  for (const r of await store.all(gc, "SELECT device_id, COUNT(*) AS n FROM sessions WHERE status = 'active' GROUP BY device_id")) m.set(r.device_id, r.n);
  return m;
}

module.exports = { onEvent, nativeStart, heartbeat, nativeEnd, sweep, reconcile, list, csv, purge, activeCounts, devIdOf, nextId, FIRST_OWN_ID };
