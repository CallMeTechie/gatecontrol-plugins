'use strict';

// Requests and the firewall per session (stage 2, the Windows switch).
//
// A helper redeems the code a PC shows (POST code/redeem) → a request; the PC gets a silent signal with the
// helper's name and picture and the mode, the person there allows ("Ansehen" / "Ansehen und steuern") or denies
// it (POST host/requests/<id>) — without an answer the request ends after 30 s. Only then the helper connects
// (POST requests/<id>/connect): the PC opens 3389 for exactly one address — the hub address for a session in the
// browser (guacd connects from there), the VPN address of the helper's app for an app session — and reports it
// (POST host/firewall). No report within 15 s: the connection is refused (firewall_timeout).
//
// The rule closes with the session (GateControl's event, the app's sessionEnd), at `until` (≤ 8 h), when the
// switch goes off, and when the app starts again (it removes every rule "GateControl RDP *" and asks
// GET host/firewall). Signals (silent data pushes on the topic remote_signal to exactly the PC's app):
//   { type: 'remote.request', requestId, from: { userId, name, avatarUrl }, mode, via, expiresAt }
//   { type: 'remote.request.cancel', requestId }
//   { type: 'remote.firewall.open', sessionKey, allow, port, until }
//   { type: 'remote.firewall.close', sessionKey }
//   { type: 'remote.code.void' }          the PC's code became void (too many wrong codes): fetch a new one
//
// 1.3 (stage 5): a phone shares its screen. A request to a phone is always "view" (control is stage 6) and always
// asked at the phone — also "ohne Code" —, and Android asks again before the picture runs. Allowed, the plugin asks
// GateControl for a ticket of its relay (gc.remote.screen): the phone gets the sending side in the answer of
// POST host/requests/<id>, the helper the viewer's ref from POST requests/<id>/connect. No firewall: the phone
// connects to the relay itself. GateControl's session events end the request; the phone hears it as
//   { type: 'remote.screen.end', requestId, reason }   (the helper or the plugin ended it)
// The signal remote.request carries kind: 'screen' | 'rdp'.

const crypto = require('node:crypto');
const store = require('./store');
const devices = require('./devices');
const rights = require('./rights');
const log = require('./log');
const { fail, fromHost, iso, clip } = require('./util');

const TOPIC = 'remote_signal';
const REQUEST_MS = 30000;          // the person at the PC answers within 30 s
const CONNECT_MS = 120000;         // an allowed request is used within 2 minutes
const SESSION_MAX_MS = 8 * 3600000;
const UNSTARTED_MS = 180000;       // a browser ticket that was never opened, an app session never reported
const TIMING = { waitMs: 15000, facadeWaitMs: 8000, pollMs: 250 };   // tests make them shorter

const randomId = (prefix) => prefix + crypto.randomBytes(12).toString('base64url');
const SCREEN_WS = '/api/v1/remote/screen-relay';
// why a phone ended a request before the picture ran (POST host/screen/<id>/end)
const PHONE_ENDS = ['consent_denied', 'stopped', 'failed'];

/** A silent signal to the PC's app — best-effort (the app also asks GET host/firewall). */
async function signal(gc, d, data, ttl = 120) {
  if (!d || !d.host || !d.host.tokenDeviceId || !d.host.owner) return false;
  try {
    const r = await gc.notify({ topic: TOPIC, silent: true, users: [d.host.owner], devices: [d.host.tokenDeviceId], data, ttl, collapseKey: data.sessionKey || data.requestId || data.type });
    return !!(r && r.pushed);
  } catch (e) {
    gc.log.warn('signal not sent', data.type, (e && e.code) || 'error');
    return false;
  }
}

function requestView(r, d) {
  return { id: r.id, device: { id: r.device_id, name: d ? d.name : null }, state: r.state, mode: r.mode, via: r.via, kind: r.kind === 'screen' ? 'screen' : 'rdp',
    expiresAt: iso(r.expires_at), decidedAt: iso(r.decided_at), ...(r.end_reason ? { endReason: r.end_reason } : {}) };
}

/** The ticket of GateControl's relay of a request ends (best-effort: it may be gone already). */
async function endScreen(gc, r) {
  if (!r || !r.screen_ref) return;
  try { await gc.remote.end({ ref: r.screen_ref }); } catch (e) { gc.log.debug('screen ticket not ended', (e && e.code) || 'error'); }
}

/** May this person ask the PC at all: "Support-Codes einlösen", or Remote Desktop with access to this PC. */
async function mayAsk(gc, user, d) {
  const r = await rights.of(gc, user);
  if (r.support) return true;
  const access = (await devices.accessLists(gc)).get(d.id) || devices.emptyAccess();
  return rights.mayUse(gc, user, d, access, { rights: r });
}

function checkReady(d) {
  if (!d || d.kind !== 'host' || !d.enabled) throw fail('not_found');
  if (!d.host.registered) throw fail('offline');
  if (d.host.rdpEnabled === false && !devices.isPhone(d)) throw fail('rdp_off');
  if (!d.host.online) throw fail('offline');
}

async function personView(gc, userId) {
  let u = null;
  try { u = await gc.users.get(userId); } catch { u = null; }
  return { userId, name: u ? u.name : null, avatarUrl: u && u.avatarUrl ? u.avatarUrl : null };
}

/** A helper's request after a valid code → the request (the PC is asked now). */
async function create(gc, user, d, { mode, via, helperDevice }, now = Date.now()) {
  checkReady(d);
  if (!(await mayAsk(gc, user, d))) throw fail('no_right');
  const phone = devices.isPhone(d);
  if (phone && (!gc.remote || typeof gc.remote.screen !== 'function')) throw fail('screen_unavailable');
  // a phone: only watching (control is stage 6)
  const m = phone || mode === 'view' ? 'view' : 'control';
  const v = via === 'app' ? 'app' : 'browser';
  // an app session (mstsc) cannot only watch
  if (!phone && v === 'app' && m === 'view') throw fail('invalid', { field: 'mode' });
  // one open question per PC: a newer one replaces it
  for (const old of await store.all(gc, "SELECT * FROM requests WHERE device_id = ? AND state = 'waiting'", [d.id])) {
    await store.run(gc, "UPDATE requests SET state = 'expired', decided_at = ? WHERE id = ?", [now, old.id]);
    await signal(gc, d, { type: 'remote.request.cancel', requestId: old.id });
  }
  const id = randomId('rq_');
  await store.run(gc, `INSERT INTO requests (id, device_id, helper_user_id, mode, via, helper_device_id, state, created_at, expires_at, kind)
    VALUES (?, ?, ?, ?, ?, ?, 'waiting', ?, ?, ?)`, [id, d.id, user.id, m, v, helperDevice ? helperDevice.id : null, now, now + REQUEST_MS, phone ? 'screen' : 'rdp']);
  const row = await store.one(gc, 'SELECT * FROM requests WHERE id = ?', [id]);
  await signal(gc, d, { type: 'remote.request', requestId: id, from: await personView(gc, user.id), mode: m, via: v, kind: phone ? 'screen' : 'rdp', expiresAt: iso(now + REQUEST_MS) }, 60);
  return requestView(row, d);
}

/** A waiting request whose 30 s ran out, an allowed one not used in time → expired (lazy and in the background). */
async function expire(gc, r, now) {
  if (r.state === 'waiting' && r.expires_at <= now) {
    await store.run(gc, "UPDATE requests SET state = 'expired', decided_at = ? WHERE id = ? AND state = 'waiting'", [now, r.id]);
    const d = await devices.get(gc, r.device_id);
    await log.write(gc, 'remote_request_expired', { device: d, userId: r.helper_user_id }, now);
    return { ...r, state: 'expired', decided_at: now };
  }
  if (r.state === 'allowed' && !r.connected_at && r.decided_at && now - r.decided_at > CONNECT_MS) {
    await store.run(gc, "UPDATE requests SET state = 'expired' WHERE id = ? AND state = 'allowed'", [r.id]);
    // a phone's relay ticket that the helper never used
    await endScreen(gc, r);
    return { ...r, state: 'expired' };
  }
  return r;
}

/** GET requests/<id> — the helper waits for the answer. */
async function get(gc, user, id, now = Date.now()) {
  let r = await store.one(gc, 'SELECT * FROM requests WHERE id = ?', [String(id || '')]);
  if (!r || r.helper_user_id !== user.id) throw fail('not_found');
  r = await expire(gc, r, now);
  return { request: requestView(r, await devices.get(gc, r.device_id)) };
}

/** The waiting requests of a PC (the heartbeat hands them again, in case a signal got lost). */
async function pendingFor(gc, d, now = Date.now()) {
  const out = [];
  for (const r of await store.all(gc, "SELECT * FROM requests WHERE device_id = ? AND state = 'waiting' ORDER BY created_at", [d.id])) {
    const x = await expire(gc, r, now);
    if (x.state !== 'waiting') continue;
    out.push({ requestId: x.id, from: await personView(gc, x.helper_user_id), mode: x.mode, via: x.via, kind: x.kind === 'screen' ? 'screen' : 'rdp', expiresAt: iso(x.expires_at) });
  }
  return out;
}

/** POST host/requests/<id> { decision, mode? } — the person at the PC answers. */
async function decide(gc, d, id, b, now = Date.now()) {
  let r = await store.one(gc, 'SELECT * FROM requests WHERE id = ? AND device_id = ?', [String(id || ''), d.id]);
  if (!r) throw fail('not_found');
  r = await expire(gc, r, now);
  if (r.state !== 'waiting') throw fail('request_expired');
  const decision = b && b.decision;
  if (decision !== 'allow' && decision !== 'deny') throw fail('invalid', { field: 'decision' });
  if (decision === 'deny') {
    await store.run(gc, "UPDATE requests SET state = 'denied', decided_at = ? WHERE id = ?", [now, r.id]);
    await log.write(gc, 'remote_request_denied', { device: d, userId: r.helper_user_id }, now);
  } else if (r.kind === 'screen') {
    // a phone: a ticket of GateControl's relay — the phone sends, the helper watches
    let t;
    try {
      t = await gc.remote.screen({ viewer: r.helper_user_id, sender: { user: d.host.owner, device: d.host.tokenDeviceId }, target: { id: 'dev-' + d.id, name: d.name.slice(0, 100) }, mode: 'view', ttlS: Math.floor(CONNECT_MS / 1000) });
    } catch (e) {
      await store.run(gc, "UPDATE requests SET state = 'ended', decided_at = ?, end_reason = 'screen_failed' WHERE id = ?", [now, r.id]);
      throw fromHost(e);
    }
    await store.run(gc, "UPDATE requests SET state = 'allowed', mode = 'view', decided_at = ?, screen_ref = ? WHERE id = ?", [now, t.ref, r.id]);
    await log.write(gc, 'remote_request_allowed', { device: d, userId: r.helper_user_id, details: { mode: 'view', via: r.via, kind: 'screen' } }, now);
    return {
      request: requestView(await store.one(gc, 'SELECT * FROM requests WHERE id = ?', [r.id]), d),
      screen: { ref: t.senderRef, expiresAt: t.senderExpiresAt || t.expiresAt, wsPath: SCREEN_WS },
    };
  } else {
    // the person may grant less than asked ("nur ansehen"), never more
    const mode = b.mode === 'view' && r.via === 'browser' ? 'view' : r.mode;
    await store.run(gc, "UPDATE requests SET state = 'allowed', mode = ?, decided_at = ? WHERE id = ?", [mode, now, r.id]);
    await log.write(gc, 'remote_request_allowed', { device: d, userId: r.helper_user_id, details: { mode, via: r.via } }, now);
  }
  return { request: requestView(await store.one(gc, 'SELECT * FROM requests WHERE id = ?', [r.id]), d) };
}

// ─── The firewall ───

async function rowOf(gc, key) { return store.one(gc, 'SELECT * FROM firewall WHERE session_key = ?', [key]); }

/** Ask the PC to open 3389 for `allow` and wait for its report (≤ waitMs) → the row; firewall_timeout / firewall_failed. */
async function open(gc, d, { allow, via, helperUserId, helperTokenId = null, requestId = null, waitMs = TIMING.waitMs }, now = Date.now()) {
  if (!allow) throw fail('no_vpn');
  const key = randomId('fw_');
  const until = now + SESSION_MAX_MS;
  await store.run(gc, `INSERT INTO firewall (session_key, device_id, request_id, helper_user_id, helper_token_id, via, allow_ip, port, state, until, opened_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`, [key, d.id, requestId, helperUserId || null, helperTokenId, via, allow, d.config.port || 3389, until, now]);
  await signal(gc, d, { type: 'remote.firewall.open', sessionKey: key, allow, port: d.config.port || 3389, until: iso(until) }, 60);
  const end = Date.now() + waitMs;
  for (;;) {
    const r = await rowOf(gc, key);
    if (r && r.state === 'open') {
      await log.write(gc, 'remote_firewall_open', { device: d, userId: helperUserId, details: { via } });
      return r;
    }
    if (!r || r.state === 'failed' || r.state === 'closed') {
      await close(gc, key, 'failed');
      throw fail('firewall_failed', { reason: r && r.reason ? r.reason : null });
    }
    if (Date.now() >= end) break;
    await new Promise((res) => setTimeout(res, TIMING.pollMs));
  }
  await close(gc, key, 'firewall_timeout');
  throw fail('firewall_timeout');
}

/** Close one rule: the PC removes it, a browser ticket ends, the request is over. */
async function close(gc, key, reason, now = Date.now()) {
  const r = await rowOf(gc, key);
  if (!r || r.state === 'closed') return false;
  await store.run(gc, "UPDATE firewall SET state = 'closed', reason = COALESCE(reason, ?), closed_at = ? WHERE session_key = ?", [String(reason || 'normal').slice(0, 40), now, key]);
  const d = await devices.get(gc, r.device_id);
  await signal(gc, d, { type: 'remote.firewall.close', sessionKey: key }, 3600);
  if (r.ref) { try { await gc.remote.end({ ref: r.ref }); } catch { /* gone */ } }
  if (r.request_id) await store.run(gc, "UPDATE requests SET state = 'ended' WHERE id = ? AND state = 'allowed'", [r.request_id]);
  if (r.state === 'open' || r.state === 'closing') await log.write(gc, 'remote_firewall_close', { device: d, userId: r.helper_user_id, details: { reason: String(reason || 'normal').slice(0, 40) } }, now);
  return true;
}

/** POST host/firewall { sessionKey, state, reason? } — the PC reports a rule. */
async function report(gc, d, b, now = Date.now()) {
  const key = b && typeof b.sessionKey === 'string' ? b.sessionKey : '';
  const r = key ? await rowOf(gc, key) : null;
  if (!r || r.device_id !== d.id) throw fail('not_found');
  const st = b.state;
  if (!['open', 'closed', 'failed'].includes(st)) throw fail('invalid', { field: 'state' });
  if (st === 'open' && r.state === 'pending') await store.run(gc, "UPDATE firewall SET state = 'open', confirmed_at = ? WHERE session_key = ?", [now, key]);
  else if (st === 'failed' && r.state === 'pending') await store.run(gc, "UPDATE firewall SET state = 'failed', reason = ? WHERE session_key = ?", [clip(b.reason, 120) || 'failed', key]);
  else if (st === 'closed' && r.state !== 'closed') await close(gc, key, 'closed_on_pc', now);
  return { ok: true };
}

/** GET host/firewall — the rules the PC should have now (after a start of the app). */
async function openList(gc, d, now = Date.now()) {
  const rows = await store.all(gc, "SELECT * FROM firewall WHERE device_id = ? AND state IN ('pending', 'open') AND until > ? ORDER BY opened_at", [d.id, now]);
  return { open: rows.map((r) => ({ sessionKey: r.session_key, allow: r.allow_ip, port: r.port, until: iso(r.until) })) };
}

/** Everything of a PC ends (switch off, deleted): requests, rules, a phone's relay. */
async function endAll(gc, d, reason, now = Date.now()) {
  for (const r of await store.all(gc, "SELECT * FROM requests WHERE device_id = ? AND state = 'waiting'", [d.id])) {
    await store.run(gc, "UPDATE requests SET state = 'ended', decided_at = ? WHERE id = ?", [now, r.id]);
    await signal(gc, d, { type: 'remote.request.cancel', requestId: r.id });
  }
  for (const r of await store.all(gc, "SELECT * FROM requests WHERE device_id = ? AND state = 'allowed' AND screen_ref IS NOT NULL", [d.id])) {
    await store.run(gc, "UPDATE requests SET state = 'ended', end_reason = COALESCE(end_reason, ?) WHERE id = ?", [String(reason || 'ended').slice(0, 40), r.id]);
    await endScreen(gc, r);
  }
  for (const r of await store.all(gc, "SELECT session_key FROM firewall WHERE device_id = ? AND state != 'closed'", [d.id])) await close(gc, r.session_key, reason, now);
}

// ─── Connecting ───

/** The session of a helper to a PC (after an allowed request, or "ohne Code") → { session } | { connection }. */
async function connectTo(gc, user, d, { mode = 'control', via = 'browser', helperDevice = null, requestId = null, server = null, waitMs } = {}) {
  checkReady(d);
  if (via === 'app') {
    let allow = null;
    if (helperDevice) {
      try { allow = typeof gc.remote.peerAddress === 'function' ? await gc.remote.peerAddress(user.id, helperDevice.id) : null; } catch (e) { throw fromHost(e); }
      allow = allow || helperDevice.vpnIp || null;
    }
    if (!allow) throw fail('no_vpn');
    await open(gc, d, { allow, via: 'app', helperUserId: user.id, helperTokenId: helperDevice ? Number(helperDevice.id) : null, requestId, waitMs });
    return { connection: connectionOf(d, server) };
  }
  if (typeof gc.remote.hubAddress !== 'function') throw fail('offline');
  const hub = await gc.remote.hubAddress();
  const row = await open(gc, d, { allow: hub, via: 'browser', helperUserId: user.id, requestId, waitMs });
  try {
    const t = await gc.remote.session({ user: user.id, target: devices.targetOf(d), protocol: 'rdp', mode: mode === 'view' ? 'view' : 'control',
      options: { browser_clipboard: !!d.config.browser_clipboard, nla_enabled: true }, ttlS: 120 });
    await store.run(gc, 'UPDATE firewall SET ref = ? WHERE session_key = ?', [t.ref, row.session_key]);
    return { session: { ref: t.ref, expiresAt: t.expiresAt, protocol: t.protocol, mode: t.mode, device: { id: d.id, name: d.name } } };
  } catch (e) {
    await close(gc, row.session_key, 'session_failed');
    throw fromHost(e);
  }
}

/** Where an app connects to the PC: its VPN address, Remote Desktop, no stored credentials (the helper signs in at the PC). */
function connectionOf(d) {
  return { id: d.id, name: d.name, host: d.config.host, port: d.config.port || 3389, connect_address: d.config.host, connect_port: d.config.port || 3389,
    access_mode: 'internal', credential_mode: 'none', domain: null, resolution_mode: d.config.resolution_mode || 'fullscreen', online: d.host.online };
}

/** POST requests/<id>/connect — after "allowed". */
async function connectRequest(gc, user, id, { via, helperDevice } = {}, now = Date.now()) {
  let r = await store.one(gc, 'SELECT * FROM requests WHERE id = ?', [String(id || '')]);
  if (!r || r.helper_user_id !== user.id) throw fail('not_found');
  r = await expire(gc, r, now);
  if (r.state === 'waiting') throw fail('request_waiting');
  if (r.state !== 'allowed' || r.connected_at) throw fail('request_expired');
  if ((via === 'app' ? 'app' : 'browser') !== r.via) throw fail('invalid', { field: 'via' });
  const d = await devices.get(gc, r.device_id);
  await store.run(gc, 'UPDATE requests SET connected_at = ? WHERE id = ?', [now, r.id]);
  if (r.kind === 'screen') {
    // a phone: the viewer's side of the relay ticket (browser: GC.openSession(ref); app: POST /api/v1/client/remote/screen-token)
    if (!r.screen_ref || !d) throw fail('request_expired');
    return { session: { ref: r.screen_ref, expiresAt: iso(r.decided_at + CONNECT_MS), protocol: 'screen', engine: 'screen', mode: 'view', device: { id: d.id, name: d.name } } };
  }
  return connectTo(gc, user, d, { mode: r.mode, via: r.via, helperDevice, requestId: r.id });
}

/** POST host/screen/<id>/end { reason } — the phone ended a request before (or while) its picture ran. */
async function phoneEnded(gc, d, id, b, now = Date.now()) {
  const r = await store.one(gc, "SELECT * FROM requests WHERE id = ? AND device_id = ? AND kind = 'screen'", [String(id || ''), d.id]);
  if (!r) throw fail('not_found');
  const reason = b && PHONE_ENDS.includes(b.reason) ? b.reason : 'stopped';
  if (r.state !== 'waiting' && r.state !== 'allowed') return { ended: false };
  await store.run(gc, "UPDATE requests SET state = 'ended', decided_at = COALESCE(decided_at, ?), end_reason = ? WHERE id = ?", [now, reason, r.id]);
  await endScreen(gc, r);
  await log.write(gc, 'remote_screen_ended', { device: d, userId: r.helper_user_id, details: { reason } }, now);
  return { ended: true };
}

/** GateControl's events of a phone's relay (1.3): start → protocol; end / abort → the request is over, the phone hears it. */
async function onScreen(gc, ev, now = Date.now()) {
  const r = await store.one(gc, 'SELECT * FROM requests WHERE screen_ref = ?', [ev.ref]);
  if (!r) return;
  const d = await devices.get(gc, r.device_id);
  if (ev.phase === 'start') {
    if (r.screen_started_at) return;
    await store.run(gc, 'UPDATE requests SET screen_started_at = ? WHERE id = ?', [now, r.id]);
    await log.write(gc, 'remote_screen_started', { device: d, userId: r.helper_user_id, details: { via: ev.via === 'app' ? 'app' : 'browser' } }, now);
    return;
  }
  if (ev.phase !== 'end' && ev.phase !== 'abort') return;
  const reason = String(ev.reason || ev.phase).slice(0, 40);
  const was = r.state;
  await store.run(gc, "UPDATE requests SET state = 'ended', end_reason = COALESCE(end_reason, ?) WHERE id = ? AND state != 'ended'", [reason, r.id]);
  if (was === 'ended' && r.end_reason) return;
  await log.write(gc, 'remote_screen_ended', { device: d, userId: r.helper_user_id, details: { reason, durationSeconds: Number.isInteger(ev.durationSeconds) ? ev.durationSeconds : null } }, now);
  // the phone ended it itself (it knows); anything else: tell it, so it shows a new code
  if (reason !== 'sender' && d) await signal(gc, d, { type: 'remote.screen.end', requestId: r.id, reason }, 300);
}

/** GateControl's session events: a browser ticket's tunnel opened (started) or ended → its rule closes. */
async function onSession(gc, ev) {
  if (ev && ev.protocol === 'screen' && typeof ev.ref === 'string') return onScreen(gc, ev);
  if (!ev || typeof ev.ref !== 'string') return;
  const rows = await store.all(gc, "SELECT session_key FROM firewall WHERE ref = ? AND state != 'closed'", [ev.ref]);
  if (!rows.length) return;
  if (ev.phase === 'start') {
    await store.run(gc, 'UPDATE firewall SET started = 1 WHERE ref = ?', [ev.ref]);
    return;
  }
  if (ev.phase === 'end' || ev.phase === 'abort') for (const r of rows) await close(gc, r.session_key, ev.reason || ev.phase);
}

/** An app reports the end of its session with a PC (old app API sessionEnd): the helper's rule closes. */
async function appSessionEnded(gc, deviceId, tokenId) {
  if (!tokenId) return;
  for (const r of await store.all(gc, "SELECT session_key FROM firewall WHERE device_id = ? AND helper_token_id = ? AND via = 'app' AND state != 'closed'", [deviceId, Number(tokenId)])) {
    await close(gc, r.session_key, 'normal');
  }
}

/** The background: run-out requests, rules past `until`, tickets never opened, app sessions never reported, PCs gone offline. */
async function sweep(gc, now = Date.now()) {
  for (const r of await store.all(gc, "SELECT * FROM requests WHERE (state = 'waiting' AND expires_at <= ?) OR (state = 'allowed' AND connected_at IS NULL AND decided_at < ?)", [now, now - CONNECT_MS])) {
    await expire(gc, r, now);
  }
  const rows = await store.all(gc, "SELECT * FROM firewall WHERE state IN ('pending', 'open')");
  for (const r of rows) {
    const d = await devices.get(gc, r.device_id);
    let why = null;
    if (r.until <= now) why = 'until';
    else if (!d || !d.host || !d.host.registered) why = 'switched_off';
    else if (r.state === 'pending' && now - r.opened_at > TIMING.waitMs + 5000) why = 'firewall_timeout';
    else if (r.via === 'browser' && !r.started && now - r.opened_at > UNSTARTED_MS) why = 'not_opened';
    else if (r.via === 'app' && now - r.opened_at > UNSTARTED_MS) {
      const s = await store.one(gc, "SELECT id FROM sessions WHERE device_id = ? AND token_id = ? AND status = 'active' AND via = 'native'", [r.device_id, r.helper_token_id]);
      if (!s) why = 'not_reported';
    }
    if (why) await close(gc, r.session_key, why, now);
  }
}

module.exports = {
  TOPIC, TIMING, REQUEST_MS, CONNECT_MS, signal, mayAsk, create, get, pendingFor, decide, open, close, report, openList, endAll,
  connectTo, connectRequest, connectionOf, onSession, onScreen, phoneEnded, appSessionEnded, sweep, requestView, checkReady, SCREEN_WS,
};
