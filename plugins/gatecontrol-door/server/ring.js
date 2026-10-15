'use strict';

// Ring — the UNOFFICIAL Ring API, as the open-source projects ring-client-api
// (github.com/dgreif/ring, used by Homebridge) and python-ring-doorbell (used
// by Home Assistant) use it. Ring does not document or support it: it can
// change or stop working at any time ("inoffiziell, ohne Gewähr"). Everything
// Ring-specific lives in this one module; the rest of the plugin only sees
// devices, events and pictures.
//
// Hosts (plugin.json permissions.network.internet): oauth.ring.com,
// api.ring.com, app-snaps.ring.com.
//
// Authentication (OAuth password grant of the Android app, client_id
// "ring_official_android", scope "client"):
//   POST https://oauth.ring.com/oauth/token
//     { client_id, scope, grant_type: 'password', username, password }
//     headers: 2fa-support: true, 2fa-code: <code or ''>, hardware_id: <id>, User-Agent: android:com.ringapp
//     → 412 { tsv_state: 'sms'|'email'|'totp', phone }   a 2FA code is needed (sent by Ring)
//     → 400 { error: 'Verification Code …' }              wrong code
//     → 200 { access_token, expires_in, refresh_token }
//   refresh: { client_id, scope, grant_type: 'refresh_token', refresh_token }
//   The refresh token ROTATES: every answer may carry a new one, which is
//   stored at once (gc.settings.setSecret 'ring.refresh_token') — the old one
//   stops working. Refreshes are serialised (one at a time). The password is
//   never stored: the login wizard sends it with each step and it is dropped.
//   The hardware id (a random UUID, setting 'ring.hardware_id') is generated
//   once per installation and sent with every request.
// Session: POST https://api.ring.com/clients_api/session { device: { hardware_id,
//   metadata: { api_version: 11, device_model }, os: 'android' } } once per process
//   and every 12 hours (registers the hardware id; a 404 naming it = again).
// Devices: GET clients_api/ring_devices → doorbots, authorized_doorbots (doorbells),
//   stickup_cams (cameras): id, description, kind, location_id, battery_life,
//   alerts.connection, settings.motion_detection_enabled.
// Events without push: ring-client-api and Home Assistant receive dings through
//   Firebase Cloud Messaging (a persistent TCP connection to Google) — a plugin
//   can only make HTTP requests (gc.http.fetch), so it polls instead:
//   GET clients_api/dings/active → [{ id_str, doorbot_id, kind: ding|motion|on_demand, now, expires_in }]
//     (Home Assistant's python-ring-doorbell still reads it; an active ding
//     lasts about a minute) — every background tick (5 s), plus as a catch-up
//   GET clients_api/locations/<location_id>/events?limit=20 → { events: [{ ding_id_str,
//     doorbot_id, kind, created_at }] } (ring-client-api getCameraEvents) — every 30 s.
// Pictures: GET https://app-snaps.ring.com/snapshots/next/<id>?after-ms=…&max-wait-ms=…&extras=force
//   (a fresh snapshot, ring-client-api getNextSnapshot) and
//   GET clients_api/snapshots/image/<id> (the latest stored one, python-ring-doorbell).
//
// Errors are codes only (never tokens, passwords or Ring's answer text):
// ring_not_connected, ring_login_failed (token no longer valid → log in
// again), ring_rate_limited (429, extra.retryAfter seconds), ring_error.

const crypto = require('node:crypto');
const { fail } = require('./util');

const OAUTH = 'https://oauth.ring.com/oauth/token';
const API = 'https://api.ring.com/clients_api/';
const SNAPS = 'https://app-snaps.ring.com/snapshots/next/';
const CLIENT_ID = 'ring_official_android';
const USER_AGENT = 'android:com.ringapp';
const API_VERSION = 11;
const DEVICE_MODEL = 'GateControl';
const SECRET = 'ring.refresh_token';
const HWID = 'ring.hardware_id';
const SESSION_EVERY_MS = 12 * 3600000;
const TIMEOUT = 15000;

// in-memory state of this process (the access token is never stored)
const mem = { access: null, accessUntil: 0, sessionAt: 0, refreshing: null };

function reset() {
  mem.access = null; mem.accessUntil = 0; mem.sessionAt = 0; mem.refreshing = null;
}

async function hardwareId(gc) {
  let id = await gc.settings.get(HWID);
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) {
    id = crypto.randomUUID();
    await gc.settings.set(HWID, id);
  }
  return id;
}

async function hasToken(gc) {
  const t = await gc.settings.get(SECRET);
  return typeof t === 'string' && t.length > 0;
}

function parse(res) {
  if (!res) return null;
  if (typeof res.body === 'string') { try { return JSON.parse(res.body); } catch { return null; } }
  return null;
}

function retryAfter(res) {
  const h = res && res.headers && res.headers['retry-after'];
  const n = Number(Array.isArray(h) ? h[0] : h);
  return Number.isFinite(n) && n > 0 ? Math.min(3600, Math.ceil(n)) : 60;
}

/** One OAuth token request → the answer object; stores a rotated refresh token at once. */
async function tokenRequest(gc, grant, code) {
  const hwid = await hardwareId(gc);
  let res;
  try {
    res = await gc.http.fetch(OAUTH, {
      method: 'POST',
      headers: { '2fa-support': 'true', '2fa-code': code || '', hardware_id: hwid, 'User-Agent': USER_AGENT, accept: 'application/json' },
      json: { client_id: CLIENT_ID, scope: 'client', ...grant },
      timeoutMs: TIMEOUT,
    });
  } catch {
    throw fail('ring_error');
  }
  const body = parse(res) || {};
  if (res.status === 200 && typeof body.access_token === 'string' && typeof body.refresh_token === 'string') {
    // rotation: the newest refresh token replaces the stored one before anything else happens
    await gc.settings.setSecret(SECRET, body.refresh_token);
    mem.access = body.access_token;
    mem.accessUntil = Date.now() + Math.max(60, Math.min(Number(body.expires_in) || 3600, 86400)) * 1000 - 60000;
    return { ok: true };
  }
  return { ok: false, status: res.status, body, retryAfter: retryAfter(res) };
}

/**
 * Login wizard step: email + password (+ the 2FA code in the second step).
 * → { connected: true } or { needsCode: true, tsvState, phone } (phone as Ring masks it).
 * The password is used for this request only and never stored.
 */
async function login(gc, { email, password, code }) {
  const r = await tokenRequest(gc, { grant_type: 'password', username: email, password }, code);
  if (r.ok) {
    mem.sessionAt = 0;
    return { connected: true };
  }
  const err = typeof r.body.error === 'string' ? r.body.error : '';
  const desc = typeof r.body.error_description === 'string' ? r.body.error_description : '';
  if (r.status === 412) {
    const tsv = ['sms', 'email', 'totp'].includes(r.body.tsv_state) ? r.body.tsv_state : null;
    const phone = typeof r.body.phone === 'string' ? r.body.phone.replace(/[^0-9*+ ()x.@a-zA-Z_-]/g, '').slice(0, 40) : null;
    return { needsCode: true, tsvState: tsv, phone };
  }
  if (r.status === 400 && /^verification code/i.test(err)) throw fail('ring_bad_code');
  if (r.status === 429 || /too many requests/i.test(desc)) throw fail('ring_rate_limited', { retryAfter: r.retryAfter });
  throw fail('ring_login_failed');
}

/** Forget the connection (the refresh token is deleted; Ring keeps the device entry until removed there). */
async function logout(gc) {
  reset();
  await gc.settings.setSecret(SECRET, null);
}

/** A valid access token (refreshing with the stored refresh token; one refresh at a time). */
async function accessToken(gc, force = false) {
  if (!force && mem.access && Date.now() < mem.accessUntil) return mem.access;
  if (mem.refreshing) return mem.refreshing;
  mem.refreshing = (async () => {
    const rt = await gc.settings.get(SECRET);
    if (typeof rt !== 'string' || !rt) throw fail('ring_not_connected');
    const r = await tokenRequest(gc, { grant_type: 'refresh_token', refresh_token: rt });
    if (r.ok) return mem.access;
    mem.access = null;
    if (r.status === 429) throw fail('ring_rate_limited', { retryAfter: r.retryAfter });
    if (r.status === 400 || r.status === 401 || r.status === 403) throw fail('ring_login_failed');
    throw fail('ring_error');
  })();
  try { return await mem.refreshing; } finally { mem.refreshing = null; }
}

async function rawRequest(gc, url, opts, token) {
  const hwid = await hardwareId(gc);
  try {
    return await gc.http.fetch(url, {
      method: opts.method || 'GET',
      headers: { authorization: `Bearer ${token}`, hardware_id: hwid, 'User-Agent': USER_AGENT, accept: opts.binary ? 'image/jpeg' : 'application/json', ...(opts.headers || {}) },
      ...(opts.json ? { json: opts.json } : {}),
      ...(opts.binary ? { binary: true } : {}),
      timeoutMs: opts.timeoutMs || TIMEOUT,
    });
  } catch {
    throw fail('ring_error');
  }
}

async function ensureSession(gc, token) {
  if (mem.sessionAt && Date.now() - mem.sessionAt < SESSION_EVERY_MS) return;
  const hwid = await hardwareId(gc);
  const res = await rawRequest(gc, API + 'session', {
    method: 'POST', json: { device: { hardware_id: hwid, metadata: { api_version: API_VERSION, device_model: DEVICE_MODEL }, os: 'android' } },
  }, token);
  if (res.status === 429) throw fail('ring_rate_limited', { retryAfter: retryAfter(res) });
  if (res.status === 401) throw Object.assign(fail('ring_error'), { unauthorized: true });
  if (res.status < 200 || res.status >= 300) throw fail('ring_error');
  mem.sessionAt = Date.now();
}

/** An authorised request to Ring (token, session, one retry after a 401). → the host's fetch result */
async function request(gc, url, opts = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await accessToken(gc, attempt > 0);
    try {
      await ensureSession(gc, token);
    } catch (e) {
      if (e && e.unauthorized && attempt === 0) continue;
      throw e;
    }
    const res = await rawRequest(gc, url, opts, token);
    if (res.status === 401 && attempt === 0) continue;
    if (res.status === 401) throw fail('ring_login_failed');
    if (res.status === 404 && /hardware/i.test(String(res.body || '')) && attempt === 0) { mem.sessionAt = 0; continue; }
    if (res.status === 429) throw fail('ring_rate_limited', { retryAfter: retryAfter(res) });
    return res;
  }
  throw fail('ring_error');
}

async function getJson(gc, path) {
  const res = await request(gc, API + path);
  if (res.status < 200 || res.status >= 300) throw fail('ring_error');
  const body = parse(res);
  if (body == null) throw fail('ring_error');
  return body;
}

function batteryOf(d) {
  const v = d.battery_life;
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n) : null;
}

/** GET ring_devices → doorbells and cameras: [{ ringId, name, kind, doorbell, locationId, battery, online, motionDetection }] */
async function devices(gc) {
  const body = await getJson(gc, 'ring_devices');
  const out = [];
  const add = (list, doorbell) => {
    for (const d of Array.isArray(list) ? list : []) {
      if (!d || d.id == null || out.some((x) => x.ringId === String(d.id))) continue;
      out.push({
        ringId: String(d.id), name: typeof d.description === 'string' && d.description.trim() ? d.description.trim().slice(0, 60) : `Ring ${d.id}`,
        kind: typeof d.kind === 'string' ? d.kind.slice(0, 40) : null, doorbell, locationId: d.location_id == null ? null : String(d.location_id).slice(0, 80),
        battery: batteryOf(d), online: !(d.alerts && d.alerts.connection === 'offline'),
        motionDetection: !(d.settings && d.settings.motion_detection_enabled === false),
      });
    }
  };
  add(body.doorbots, true);
  add(body.authorized_doorbots, true);
  add(body.stickup_cams, false);
  return out;
}

const EVENT_KINDS = new Set(['ding', 'motion']);

/** GET dings/active → [{ id, ringId, kind: 'ding'|'motion', at }] (on_demand = live view, ignored) */
async function activeDings(gc) {
  const body = await getJson(gc, 'dings/active');
  if (!Array.isArray(body)) return [];
  const out = [];
  for (const d of body) {
    if (!d || d.doorbot_id == null || !EVENT_KINDS.has(d.kind)) continue;
    const id = d.id_str != null ? String(d.id_str) : (d.id != null ? String(d.id) : null);
    if (!id || !/^[0-9A-Za-z_-]{1,40}$/.test(id)) continue;
    const at = Number.isFinite(Number(d.now)) && Number(d.now) > 1e9 ? Math.round(Number(d.now) * (Number(d.now) < 1e11 ? 1000 : 1)) : Date.now();
    out.push({ id, ringId: String(d.doorbot_id), kind: d.kind, at });
  }
  return out;
}

/** GET locations/<id>/events?limit=n → [{ id, ringId, kind, at }] (dings and motion only) */
async function locationEvents(gc, locationId, limit = 20) {
  if (!/^[0-9A-Za-z_-]{1,80}$/.test(String(locationId || ''))) return [];
  const body = await getJson(gc, `locations/${encodeURIComponent(locationId)}/events?limit=${limit}`);
  const list = body && Array.isArray(body.events) ? body.events : [];
  const out = [];
  for (const e of list) {
    if (!e || e.doorbot_id == null || !EVENT_KINDS.has(e.kind)) continue;
    const id = e.ding_id_str != null ? String(e.ding_id_str) : (e.ding_id != null ? String(e.ding_id) : null);
    const at = Date.parse(e.created_at);
    if (!id || !/^[0-9A-Za-z_-]{1,40}$/.test(id) || !Number.isFinite(at)) continue;
    out.push({ id, ringId: String(e.doorbot_id), kind: e.kind, at });
  }
  return out;
}

/** The picture of an answer → Buffer (JPEG only) or null. */
function imageOf(res) {
  if (!res || res.status !== 200 || typeof res.bodyBase64 !== 'string') return null;
  const buf = Buffer.from(res.bodyBase64, 'base64');
  return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 ? buf : null;
}

/**
 * A fresh snapshot: app-snaps.ring.com/snapshots/next/<id> (waits up to maxWaitMs for a picture
 * newer than afterMs; force asks the camera for one now). → Buffer or null
 */
async function nextSnapshot(gc, ringId, { afterMs = 0, maxWaitMs = 8000, force = true } = {}) {
  if (!/^\d{1,20}$/.test(String(ringId))) return null;
  const q = [`after-ms=${Math.max(0, Math.floor(afterMs))}`, `max-wait-ms=${Math.max(1000, Math.min(15000, maxWaitMs))}`, force ? 'extras=force' : null].filter(Boolean).join('&');
  const res = await request(gc, `${SNAPS}${ringId}?${q}`, { binary: true, timeoutMs: Math.min(20000, maxWaitMs + 5000) });
  return imageOf(res);
}

/** The latest stored snapshot: clients_api/snapshots/image/<id> → Buffer or null */
async function latestSnapshot(gc, ringId) {
  if (!/^\d{1,20}$/.test(String(ringId))) return null;
  const res = await request(gc, `${API}snapshots/image/${ringId}`, { binary: true });
  return imageOf(res);
}

module.exports = {
  OAUTH, API, SNAPS, CLIENT_ID, USER_AGENT, SECRET, HWID,
  login, logout, hasToken, hardwareId, accessToken, request, devices, activeDings, locationEvents, nextSnapshot, latestSnapshot, reset,
  _mem: mem,
};
