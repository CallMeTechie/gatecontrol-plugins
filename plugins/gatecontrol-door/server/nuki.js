'use strict';

// Nuki — two ways to the locks, chosen per lock by the administrator:
//
// * Bridge HTTP API (local, preferred): the home target "nuki-bridge" (one
//   assignment per bridge, gc.net.fetchTarget with { index }). Hashed token
//   authentication — never the plain token in a URL:
//     ts   = current UTC time "YYYY-MM-DDTHH:MM:SSZ" (the bridge accepts ±60 s)
//     rnr  = a random integer 0…65535 (never reused within the window)
//     hash = sha256 hex of "<ts>,<rnr>,<token>"
//   Endpoints: /list, /lockState?nukiId&deviceType, /lockAction?nukiId&deviceType&action.
//   A bridge handles one request at a time: every request to one bridge is
//   serialised here (a promise chain per bridge) and has a timeout.
// * Nuki Web API (cloud, api.nuki.io): bearer token (the administrator's API
//   token), GET /smartlock, POST /smartlock/{id}/action { action },
//   GET /smartlock/{id}/log (optional import of keypad / manual operations).
//
// Device types — the same numbers in the bridge's deviceType and the Web API's
// `type`: 0 Smart Lock 1.0/2.0 ("keyturner"), 1 Box (no lock, ignored),
// 2 Opener, 3 Smart Door, 4 Smart Lock 3.0/4.0 (Pro), 5 newer smart locks
// (Ultra / 5th generation — handled as a smart lock). So: smart lock 0, 3, 4, 5
// · opener 2. Actions: smart lock 1 unlock, 2 lock, 3 unlatch ("öffnen");
// opener 3 electric strike actuation ("Summer"). Tokens are never logged:
// errors carry codes only.
//
// Transitional states (the lock is moving): smart lock unlocking (2),
// locking (4), unlatching (7); opener opening (7), boot_run (253). The
// bridge's /list and Nuki Web's /smartlock can stay on one of them long after
// the lock has stopped — server/locks.js then asks the lock itself
// (bridgeLockState / webLock).
//
// Nuki Web (1.0.2): GET /smartlock and /smartlock/{id} answer the cloud's
// copy. `updateDate` (ISO 8601, top level of the smartlock) is when that copy
// last changed; `serverState` (0 ok, 4 offline, …) top level; `state` holds
// mode, state, trigger, lastAction, doorState, battery*. A transitional state
// whose updateDate is older than 60 s cannot be live (a lock moves for a few
// seconds) — server/locks.js treats it as unclear at once.

const crypto = require('node:crypto');
const { fail } = require('./util');

const TARGET = 'nuki-bridge';
const WEB = 'https://api.nuki.io';
const SMARTLOCK_TYPES = new Set([0, 3, 4, 5]);
const OPENER = 2;
const TIMEOUT = { list: 8000, state: 15000, action: 25000, web: 15000 };

const SMARTLOCK_ACTION = { unlock: 1, lock: 2, open: 3 };
const OPENER_ACTION = { open: 3 };

const LOCK_STATES = { 0: 'uncalibrated', 1: 'locked', 2: 'unlocking', 3: 'unlocked', 4: 'locking', 5: 'unlatched', 6: 'unlocked', 7: 'unlatching', 254: 'jammed', 255: 'unknown' };
const OPENER_STATES = { 0: 'untrained', 1: 'online', 3: 'rto_active', 5: 'open', 7: 'opening', 253: 'boot_run', 255: 'unknown' };
// door sensor (bridge doorsensorState / web doorState): 1 deactivated, 2 closed, 3 open, 4 unknown, 5 calibrating,
// 16 uncalibrated, 240 removed, 255 unknown
const DOOR_STATES = { 1: 'deactivated', 2: 'closed', 3: 'open', 4: 'unknown', 5: 'calibrating', 16: 'uncalibrated', 240: 'removed', 255: 'unknown' };

const TRANSITIONAL = new Set(['unlocking', 'locking', 'unlatching', 'opening', 'boot_run']);

const isOpener = (deviceType) => Number(deviceType) === OPENER;
/** Is this (our) state name one of a lock that is moving? */
const isTransitional = (state) => TRANSITIONAL.has(state);
const knownType = (t) => SMARTLOCK_TYPES.has(Number(t)) || isOpener(t);

/** The actions a device type can do (in this plugin). */
function supportedActions(deviceType) {
  return isOpener(deviceType) ? ['open'] : ['lock', 'unlock', 'open'];
}

/** Our action → the Nuki action number (null when the device cannot do it). */
function actionCode(deviceType, action) {
  const map = isOpener(deviceType) ? OPENER_ACTION : SMARTLOCK_ACTION;
  return Object.prototype.hasOwnProperty.call(map, action) ? map[action] : null;
}

function stateName(deviceType, code) {
  const map = isOpener(deviceType) ? OPENER_STATES : LOCK_STATES;
  return map[Number(code)] || 'unknown';
}

function doorName(code) {
  if (code == null) return null;
  return DOOR_STATES[Number(code)] || 'unknown';
}

function batteryPercent(v) {
  const n = Number(v);
  return v != null && Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n) : null;
}

/** "YYYY-MM-DDTHH:MM:SSZ" (whole seconds, UTC). */
function bridgeTs(now) {
  return new Date(Math.floor(now / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The hashed token parameters: ts, rnr, hash = sha256("<ts>,<rnr>,<token>"). */
function hashAuth(token, now = Date.now(), rnr = crypto.randomInt(0, 65536)) {
  const ts = bridgeTs(now);
  const hash = crypto.createHash('sha256').update(`${ts},${rnr},${token}`).digest('hex');
  return { ts, rnr, hash };
}

function query(params) {
  return Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
}

// ─── Bridge ────────────────────────────────────

const chains = new Map(); // bridge id → promise chain (one request at a time)

function serialise(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const p = prev.then(fn, fn);
  const tail = p.catch(() => {});
  chains.set(key, tail);
  tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return p;
}

function parseBody(res) {
  if (res && typeof res.body === 'string') {
    try { return JSON.parse(res.body); } catch { return null; }
  }
  return res && res.json != null ? res.json : null;
}

/**
 * One request to a bridge: bridge = { id, target_index }, token (secret).
 * → parsed JSON; throws no_target / nuki_auth / lock_unreachable / nuki_error.
 */
function bridgeRequest(gc, bridge, token, path, params, timeoutMs) {
  if (!token) return Promise.reject(fail('not_configured'));
  return serialise(`bridge:${bridge.id}`, async () => {
    const auth = hashAuth(token);
    const url = `${path}?${query({ ...params, ts: auth.ts, rnr: auth.rnr, hash: auth.hash })}`;
    let res;
    try {
      res = await gc.net.fetchTarget(TARGET, url, { index: bridge.target_index, method: 'GET', timeoutMs });
    } catch (e) {
      if (e && e.code === 'ERR_NET_DENIED') throw fail('no_target');
      throw fail('lock_unreachable');
    }
    if (res.status === 401 || res.status === 403) throw fail('nuki_auth');
    if (res.status === 404) throw fail('not_found');
    if (res.status === 503) throw fail('lock_unreachable');
    if (res.status < 200 || res.status >= 300) throw fail('nuki_error');
    const body = parseBody(res);
    if (body == null) throw fail('nuki_error');
    return body;
  });
}

/**
 * The raw fields Nuki reported, for the admin diagnostics (1.0.2): only the listed keys, only numbers,
 * booleans and short strings — never anything else of the answer (no tokens, no names).
 */
function rawFields(src, keys) {
  if (!src || typeof src !== 'object') return null;
  const out = {};
  for (const k of keys) {
    const v = src[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' && v.length <= 40) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}
const BRIDGE_RAW = ['mode', 'state', 'stateName', 'doorsensorState', 'doorsensorStateName', 'timestamp'];

/** A bridge state object (/list lastKnownState or /lockState) → our state. */
function fromBridgeState(deviceType, s) {
  if (!s || typeof s !== 'object') return null;
  return {
    state: stateName(deviceType, s.state),
    nukiState: Number.isInteger(s.state) ? s.state : null,
    door: doorName(s.doorsensorState),
    batteryCritical: s.batteryCritical === true,
    batteryPercent: batteryPercent(s.batteryChargeState),
    batteryCharging: s.batteryCharging === true,
    raw: rawFields(s, BRIDGE_RAW),
    cloudAt: null,
  };
}

/** GET /list → [{ nukiId, deviceType, name, state }] (the bridge's cached states — no radio traffic). */
async function bridgeList(gc, bridge, token) {
  const list = await bridgeRequest(gc, bridge, token, '/list', {}, TIMEOUT.list);
  if (!Array.isArray(list)) throw fail('nuki_error');
  return list.filter((d) => d && d.nukiId != null && knownType(d.deviceType)).map((d) => ({
    nukiId: String(d.nukiId), deviceType: Number(d.deviceType), name: typeof d.name === 'string' ? d.name.slice(0, 60) : '',
    state: fromBridgeState(d.deviceType, d.lastKnownState),
  }));
}

/** GET /lockState — asks the lock itself over Bluetooth (slower; used only when asked). */
async function bridgeLockState(gc, bridge, token, lock) {
  const s = await bridgeRequest(gc, bridge, token, '/lockState', { nukiId: lock.nuki_id, deviceType: lock.device_type }, TIMEOUT.state);
  if (s && s.success === false) throw fail('lock_unreachable');
  return fromBridgeState(lock.device_type, s);
}

/** GET /lockAction — waits for the lock (the bridge answers when it is done). */
async function bridgeAction(gc, bridge, token, lock, action) {
  const code = actionCode(lock.device_type, action);
  if (code == null) throw fail('unsupported');
  const r = await bridgeRequest(gc, bridge, token, '/lockAction', { nukiId: lock.nuki_id, deviceType: lock.device_type, action: code }, TIMEOUT.action);
  if (!r || r.success !== true) throw fail('lock_failed');
  return { ok: true, batteryCritical: r.batteryCritical === true };
}

// ─── Web API ───────────────────────────────────

async function webRequest(gc, token, method, path, json) {
  if (!token) throw fail('not_configured');
  let res;
  try {
    res = await gc.http.fetch(WEB + path, {
      method, headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, ...(json ? { json } : {}), timeoutMs: TIMEOUT.web,
    });
  } catch {
    throw fail('lock_unreachable');
  }
  if (res.status === 401 || res.status === 403) throw fail('nuki_auth');
  if (res.status === 404) throw fail('not_found');
  if (res.status === 429) throw fail('rate_limited');
  if (res.status < 200 || res.status >= 300) throw fail('nuki_error');
  if (res.status === 204 || !res.body) return null;
  const body = parseBody(res);
  if (body == null) throw fail('nuki_error');
  return body;
}

/** Nuki Web's updateDate (ISO 8601) → ms, or null. */
function webDate(v) {
  if (typeof v !== 'string' || v.length > 40) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}
const WEB_RAW = ['mode', 'state', 'lastAction', 'trigger', 'doorState'];

/**
 * A Web API smartlock → ours. state.cloudAt: the smartlock's updateDate (when the cloud's copy last
 * changed — it only gets news from the lock while the lock / its bridge is online); state.raw: the raw
 * fields mode, state, lastAction, trigger, doorState (from smartlock.state) and serverState, updateDate.
 */
function fromWebLock(d) {
  const s = (d && d.state) || {};
  const raw = { ...(rawFields(s, WEB_RAW) || {}), ...(rawFields(d, ['serverState', 'updateDate']) || {}) };
  return {
    nukiId: String(d.smartlockId), deviceType: Number(d.type), name: typeof d.name === 'string' ? d.name.slice(0, 60) : '',
    // serverState 0 = ok; anything else (4 offline, …) = not reachable through the cloud
    reachable: d.serverState == null || Number(d.serverState) === 0,
    state: {
      state: stateName(d.type, s.state),
      nukiState: Number.isInteger(s.state) ? s.state : null,
      door: doorName(s.doorState === 0 ? null : s.doorState),
      batteryCritical: s.batteryCritical === true,
      batteryPercent: batteryPercent(s.batteryCharge),
      batteryCharging: s.batteryCharging === true,
      raw: Object.keys(raw).length ? raw : null,
      cloudAt: webDate(d.updateDate),
    },
  };
}

/** GET /smartlock → [{ nukiId, deviceType, name, reachable, state }] */
async function webList(gc, token) {
  const list = await webRequest(gc, token, 'GET', '/smartlock');
  if (!Array.isArray(list)) throw fail('nuki_error');
  return list.filter((d) => d && d.smartlockId != null && knownType(d.type)).map(fromWebLock);
}

/** GET /smartlock/{id} — one lock, read again (a transitional state that does not end). */
async function webLock(gc, token, lock) {
  if (!/^\d{1,20}$/.test(String(lock.nuki_id))) throw fail('invalid');
  const d = await webRequest(gc, token, 'GET', `/smartlock/${lock.nuki_id}`);
  if (!d || typeof d !== 'object' || d.smartlockId == null) throw fail('nuki_error');
  return fromWebLock(d);
}

/** POST /smartlock/{id}/action { action } (the cloud forwards it; 204 = accepted). */
async function webAction(gc, token, lock, action) {
  const code = actionCode(lock.device_type, action);
  if (code == null) throw fail('unsupported');
  if (!/^\d{1,20}$/.test(String(lock.nuki_id))) throw fail('invalid');
  await webRequest(gc, token, 'POST', `/smartlock/${lock.nuki_id}/action`, { action: code });
  return { ok: true };
}

// Web API log triggers: 0 system, 1 manual, 2 button, 3 automatic, 4 web, 5 app, 6 auto lock,
// 7 accessory, 255 keypad. Imported are the ones GateControl did not cause itself.
const LOG_IMPORT = { 1: 'nuki', 2: 'nuki', 3: 'nuki', 6: 'nuki', 7: 'keypad', 255: 'keypad' };
const LOG_ACTION = { 1: 'unlock', 2: 'lock', 3: 'open', 4: 'lock', 5: 'open' };

/** GET /smartlock/{id}/log?limit=n → [{ extId, at, action, via, name }] for import into the history. */
async function webLog(gc, token, lock, limit = 20) {
  if (!/^\d{1,20}$/.test(String(lock.nuki_id))) return [];
  const list = await webRequest(gc, token, 'GET', `/smartlock/${lock.nuki_id}/log?limit=${limit}`);
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const e of list) {
    if (!e || e.id == null || !LOG_IMPORT[e.trigger]) continue;
    const at = Date.parse(e.date);
    if (!Number.isFinite(at)) continue;
    const keypad = LOG_IMPORT[e.trigger] === 'keypad' || /keypad/i.test(String(e.name || ''));
    out.push({ extId: `nukilog:${e.id}`, at, action: LOG_ACTION[e.action] || null, via: keypad ? 'keypad' : 'nuki', name: typeof e.name === 'string' ? e.name.slice(0, 60) : null });
  }
  return out;
}

module.exports = {
  TARGET, WEB, SMARTLOCK_TYPES, OPENER, TIMEOUT, LOCK_STATES, OPENER_STATES, DOOR_STATES, TRANSITIONAL,
  isOpener, isTransitional, knownType, supportedActions, actionCode, stateName, doorName, hashAuth, bridgeTs,
  bridgeList, bridgeLockState, bridgeAction, webList, webLock, webAction, webLog, fromBridgeState, fromWebLock, rawFields, webDate,
  _chains: chains,
};
