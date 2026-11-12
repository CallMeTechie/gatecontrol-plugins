'use strict';

// Devices (port of GateControl's src/services/midea/index.js, plus Dreo):
// state cache and per-device lock, cloud account, adding devices (Midea cloud
// or LAN, Dreo cloud), control, connection test and the background run.
// Dreo devices (vendor 'dreo') are handled by dreoservice.js.

const store = require('./store');
const lan = require('./lan');
const ac = require('./ac');
const alerts = require('./alerts');
const dreo = require('./dreoservice');
const dreoImport = require('./dreoimport');
const { MideaCloud, SESSION_GONE_CODES, LOGIN_REFUSED_CODES } = require('./cloud');
const { createGuard, clock: guardClock } = require('./loginguard');

const { codeError } = store;

// Cloud state is served from cache within this window (instant page/widget load,
// no cloud round-trip, no re-login); beyond it the cached state is still served
// but a background refresh is kicked off. LAN devices are local/fast and unaffected.
const CLOUD_STATE_TTL_MS = 90000;
// 2.2.4: a cloud device that did not answer is asked again by the tiles, the search and the apps'
// quick actions at most this often (before: with every look — the more devices were offline, the
// more cloud calls). Opening the device's page still asks at once.
const CLOUD_OFFLINE_RETRY_MS = 30000;
const LAN_TIMEOUT_MS = 8000;

const cache = new Map();          // deviceId -> { state, online, lastAt }
const locks = new Map();          // deviceId -> Promise chain tail
const lockDepth = new Map();      // deviceId -> active operation count
const cloudRefreshInFlight = new Map(); // device id → its running background cloud refresh (dedupe)
const status = { lastPollAt: null };
let pollRunning = false;

// ── Per-device mutex ──────────────────────────────────────────────────────────

function withDeviceLock(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  lockDepth.set(id, (lockDepth.get(id) || 0) + 1);
  const done = () => {
    const n = (lockDepth.get(id) || 1) - 1;
    if (n <= 0) lockDepth.delete(id); else lockDepth.set(id, n);
  };
  const next = prev.then(fn, fn);
  next.then(done, done);
  locks.set(id, next.catch(() => { /* keeps the lock chain alive; the caller sees the error via its own promise */ }));
  return next;
}

// ── Cloud ─────────────────────────────────────────────────────────────────────

/** Tests replace this to talk to a fake cloud. */
function newCloud(gc, app) {
  return new MideaCloud(app, { fetch: (url, opts) => gc.http.fetch(url, opts) });
}

async function cloudFromConfig(gc) {
  const cfg = await store.loadConfig(gc);
  if (!cfg.email) throw codeError('MIDEA_CLOUD_NOT_CONFIGURED', 'cloud not configured');
  const c = module.exports.newCloud(gc, cfg.app);
  if (cfg.session) c.setSession(cfg.session);
  return { c, cfg };
}

// ── Logins (2.2.4): never on a mere error, never more than one at a time, never without a limit ──
//
// Before 2.2.4 every general cloud error threw the session away and logged in again, per call and
// without a limit: one device the cloud kept refusing meant a new login with every look at it — the
// account's owner got Midea's "someone signed in" notice every few seconds. Now (loginguard.js):
//  * a new login only when the session really is gone: Midea code 3106, or — for any other code — when
//    the account itself (the appliance list) refuses the session too (asked at most every 10 minutes);
//  * device offline, no reply (3176), cloud unreachable, 429: never a login; 429 pauses the cloud calls;
//  * parallel calls share one login; a failed or useless login is followed by a growing wait, and at
//    most 3 per hour / 6 per day happen — then "connect again" with one notification.

const guard = createGuard('cloud_guard', {
  code: 'MIDEA_CLOUD_LOGIN_PAUSED',
  onBlock: (gc, reason) => alerts.account(gc, 'Midea', reason),
});
const SESSION_CHECK_MS = 10 * 60000;
let sessionChecked = { id: null, at: 0 };   // the session the account accepted last (and when)
let dead = null;                            // id of a session the cloud refused: not used again

const sessionId = (s) => (s && (s.accessToken || s.sessionId)) || null;
const isCloudCode = (e) => Boolean(e && e.code === 'MIDEA_CLOUD_ERROR' && e.mideaCode);
const minutes = (ms) => Math.max(1, Math.ceil(ms / 60000));

function loginFatal(e) {
  if (e && e.code === 'MIDEA_CLOUD_2FA_REQUIRED') return 'twofa';
  if (isCloudCode(e) && LOGIN_REFUSED_CODES.has(e.mideaCode)) return 'credentials';
  return null;
}

/** A session for `c`: the stored one when it is newer than `refused`, else ONE guarded login. */
async function login(gc, c, refused, why) {
  const cur = await store.loadConfig(gc);
  const have = sessionId(cur.session);
  if (have && have !== sessionId(refused) && have !== dead) { c.setSession(cur.session); return; } // someone else logged in meanwhile
  const session = await guard.login(gc, async () => {
    c.setSession(null);
    await c.login(cur.email, cur.password);
    await store.saveSession(gc, c.getSession());
    return c.getSession();
  }, why, { fatal: loginFatal, unsent: (e) => e && e.code === 'MIDEA_CLOUD_UNREACHABLE' });
  c.setSession(session);
}

/**
 * A call failed: is the session gone (→ true: log in again)? Everything else is noted (429 pauses
 * the calls, a 2FA demand asks for a person) and stays what it is — an error of this one call.
 */
async function sessionGone(gc, c, e, what) {
  if (e.code === 'MIDEA_CLOUD_RATE_LIMITED') {
    const ms = await guard.rateLimited(gc);
    gc.log.warn(`midea cloud: rate limit (${what}) — no login, cloud calls paused for ${minutes(ms)} min`);
    return false;
  }
  if (e.code === 'MIDEA_CLOUD_2FA_REQUIRED') { await guard.block(gc, 'twofa'); return false; }
  if (e.code === 'MIDEA_CLOUD_NO_REPLY') { await guard.ok(gc); return false; }   // the cloud took the call: the session works
  if (!isCloudCode(e)) return false;                                               // unreachable, no answer, no session key …
  if (SESSION_GONE_CODES.has(e.mideaCode)) {
    gc.log.info(`midea cloud: Midea-Code ${e.mideaCode} (${what}) — session gone, new login`);
    return true;
  }
  const sid = sessionId(c.getSession());
  if (what !== 'list') {
    if (sessionChecked.id === sid && guardClock.now() - sessionChecked.at < SESSION_CHECK_MS) {
      gc.log.debug(`midea cloud: Midea-Code ${e.mideaCode} (${what}) — session checked recently, no login`);
      return false;
    }
    try {
      await c.listDevices();
      sessionChecked = { id: sid, at: guardClock.now() };
      gc.log.info(`midea cloud: Midea-Code ${e.mideaCode} (${what}) — the account still answers: not a session problem, no login`);
      return false;
    } catch (pe) {
      if (!isCloudCode(pe)) {
        if (pe.code === 'MIDEA_CLOUD_RATE_LIMITED') await guard.rateLimited(gc);
        gc.log.debug(`midea cloud: Midea-Code ${e.mideaCode} (${what}) — session check failed (${pe.code || 'ERROR'}), no login`);
        return false;
      }
      gc.log.info(`midea cloud: Midea-Code ${e.mideaCode} (${what}) — the account refuses the session too (Midea-Code ${pe.mideaCode}), new login`);
      return true;
    }
  }
  gc.log.info(`midea cloud: Midea-Code ${e.mideaCode} (${what}) — the account refuses the session, new login`);
  return true;
}

/** One cloud call (`what` names it in the log) with the account's session; at most one guarded new login. */
async function withCloud(gc, fn, what = 'call') {
  const { c } = await cloudFromConfig(gc);
  const wait = await guard.paused(gc);
  if (wait) throw codeError('MIDEA_CLOUD_RATE_LIMITED', `cloud calls paused for ${minutes(wait)} min after a rate limit`);
  const sid = sessionId(c.getSession());
  if (!sid || sid === dead) await login(gc, c, c.getSession(), sid ? `${what}: the session was refused` : `${what}: no session`);
  let first;
  try {
    const out = await fn(c);
    await guard.ok(gc);
    return out;
  } catch (e) {
    if (!(await sessionGone(gc, c, e, what))) throw e;
    first = e;
  }
  const refused = c.getSession();
  dead = sessionId(refused);
  await login(gc, c, refused, `${what}: Midea-Code ${first.mideaCode}`);
  try {
    const out = await fn(c);
    await guard.ok(gc);
    return out;
  } catch (e) {
    if (isCloudCode(e)) {
      // the new login did not help: this is no session problem after all — wait before the next one
      sessionChecked = { id: sessionId(c.getSession()), at: guardClock.now() };
      const until = await guard.failed(gc);
      gc.log.warn(`midea cloud: Midea-Code ${e.mideaCode} (${what}) also after a new login — next login in ${minutes(until - guardClock.now())} min at the earliest`);
    } else await sessionGone(gc, c, e, what);
    throw e;
  }
}

async function connectCloud(gc, email, password, app = 'msmarthome') {
  const c = module.exports.newCloud(gc, app);
  const prev = (await store.loadConfig(gc)).session;
  if (prev && typeof prev.deviceId === 'string' && /^[0-9a-f]{16}$/.test(prev.deviceId)) c.deviceId = prev.deviceId; // the same device as before
  const res = await c.login(email, password);     // throws typed MideaCloudError (e.g. 2FA)
  await store.saveConfig(gc, { app, email, password, session: c.getSession() });
  // a person signed in: the brake starts over
  dead = null;
  sessionChecked = { id: null, at: 0 };
  await guard.manual(gc);
  return res;
}

/** What the settings page and the banner show about the Midea account: { needsReauth, reason, wait, until }. */
async function getCloudStatus(gc) {
  const v = await guard.view(gc);
  return { needsReauth: Boolean(v.blocked), reason: v.blocked, wait: v.wait, until: v.until };
}

async function listCloudDevices(gc) {
  return withCloud(gc, (c) => c.listDevices(), 'list');
}

// ── LAN ───────────────────────────────────────────────────────────────────────

/** Tests replace this to talk to a fake device. */
function connectTarget(gc, index, timeoutMs) {
  return gc.net.tcpTarget(lan.TARGET, { index, timeoutMs });
}

async function lanFor(gc, d) {
  if (!Number.isInteger(d.target_index)) throw codeError('MIDEA_NO_TARGET', 'device has no access target');
  const creds = d.protocol_version === 3 ? await store.credentialsOf(gc, d.id) : null;
  if (d.protocol_version === 3 && !creds) throw codeError('MIDEA_NO_CREDENTIALS', 'device has no token/key');
  return new lan.LanDevice({
    connect: (timeoutMs) => module.exports.connectTarget(gc, d.target_index, timeoutMs),
    deviceId: d.device_id,
    protocolVersion: d.protocol_version,
    token: creds && creds.token,
    key: creds && creds.key,
    timeoutMs: LAN_TIMEOUT_MS,
  });
}

/** The assigned "ac" targets: [{ index, label }]. */
async function acTargets(gc) {
  const all = await gc.net.targets();
  const t = (all || []).find((x) => x.id === lan.TARGET);
  return t ? t.assigned || [] : [];
}

async function discoverLan(gc) {
  try {
    return await lan.discover(gc);
  } catch (e) {
    if (e && e.code === 'ERR_NET_DENIED') throw codeError('MIDEA_DISCOVERY_DENIED', 'local discovery is not allowed');
    throw e;
  }
}

// ── Device state operations ───────────────────────────────────────────────────

/** What went wrong, for the log: the code and — for a refusal of the cloud — Midea's code and text (never secrets). */
const failureOf = (err) => (err && err.code ? `${err.code}${err.mideaCode ? ': ' + String(err.message || '').replace(/[\0-\x1f\x7f]/g, ' ').slice(0, 160) : ''}` : String((err && err.message) || err));

const setCache = (id, state, online) => cache.set(id, { state, online, lastAt: Date.now() });

// Fetch live cloud state, update the cache, and return the parsed state (or
// {offline:true} on failure). This is the ONLY place that hits the cloud for state.
function fetchCloudState(gc, id, d) {
  return withDeviceLock(id, async () => {
    try {
      const resp = await withCloud(gc, (c) => c.sendCommand(d.cloud_appliance_id, ac.buildQuery()), 'state');
      const state = ac.parseState(resp);
      setCache(id, state, true);
      return state;
    } catch (err) {
      gc.log.debug('getState (cloud) failed (offline)', id, failureOf(err));
      setCache(id, null, false);
      return { offline: true };
    }
  });
}

// Kick a single background refresh for a stale-but-usable cache entry. Deduped
// per device so overlapping page/widget loads don't stack cloud calls.
function refreshCloudState(gc, id, d) {
  if (cloudRefreshInFlight.has(id)) return cloudRefreshInFlight.get(id);
  const p = Promise.resolve()
    .then(() => fetchCloudState(gc, id, d))
    .catch((err) => { gc.log.debug('cloud state refresh failed', id, err && err.message); })
    .finally(() => cloudRefreshInFlight.delete(id));
  cloudRefreshInFlight.set(id, p);
  return p;
}

async function deviceOrThrow(gc, id) {
  const d = await store.getDevice(gc, id);
  if (!d) throw codeError('MIDEA_DEVICE_NOT_FOUND', 'device not found');
  return d;
}

async function getState(gc, id) {
  const d = await deviceOrThrow(gc, id);
  if (d.vendor === 'dreo') return dreo.getState(gc, d);

  if (d.transport === 'cloud') {
    const cached = cache.get(d.id);
    // Serve a known-online cached state instantly — no cloud round-trip, no
    // re-login. Beyond the TTL still serve it, but refresh in the background.
    if (cached && cached.online && cached.state) {
      if (Date.now() - cached.lastAt >= CLOUD_STATE_TTL_MS) refreshCloudState(gc, d.id, d);
      return cached.state;
    }
    // No usable cache (first load / last known offline) → fetch synchronously.
    return fetchCloudState(gc, d.id, d);
  }

  return withDeviceLock(d.id, async () => {
    try {
      const state = await (await lanFor(gc, d)).getState();
      setCache(d.id, state, true);
      await store.updateDevice(gc, d.id, { last_seen_at: new Date().toISOString() });
      return state;
    } catch (err) {
      gc.log.debug('getState failed (offline)', d.id, err.code || err.message);
      setCache(d.id, null, false);
      return { offline: true };
    }
  });
}

/** A cloud cache entry that needs no refresh yet (online: 90 s, offline: 30 s). */
const cloudFresh = (c) => Boolean(c && Date.now() - c.lastAt < (c.online && c.state ? CLOUD_STATE_TTL_MS : CLOUD_OFFLINE_RETRY_MS));

/**
 * The cached state of a device without any network (portal Start tiles and
 * search answer within 1.5 s). A cloud device without a usable cache gets a
 * background refresh, so the next look has one.
 */
function cachedState(gc, d) {
  if (d.vendor === 'dreo') return dreo.cachedState(gc, d);
  const c = cache.get(d.id);
  if (d.transport === 'cloud' && !cloudFresh(c)) refreshCloudState(gc, d.id, d);
  if (!c) return null;
  return c.online && c.state ? c.state : { offline: true };
}

/**
 * Like cachedState, but a cloud state older than the TTL is first refreshed
 * for up to `waitMs` (the apps' quick actions, 2.0.1): a device switched with
 * its remote or the Midea app shows its real state on the next look instead
 * of the one after. Past `waitMs` the cached state, the refresh lands later.
 */
async function recentState(gc, d, waitMs) {
  const c = cache.get(d.id);
  if (d.vendor === 'dreo' || d.transport !== 'cloud' || cloudFresh(c)) return cachedState(gc, d);
  let timer;
  const wait = new Promise((resolve) => { timer = setTimeout(resolve, waitMs); if (timer.unref) timer.unref(); });
  await Promise.race([refreshCloudState(gc, d.id, d), wait]);
  clearTimeout(timer);
  return cachedState(gc, d);
}

async function setState(gc, id, patch) {
  const d = await deviceOrThrow(gc, id);
  if (d.vendor === 'dreo') return withDeviceLock(d.id, () => dreo.setState(gc, d, patch));

  if (d.transport === 'cloud') {
    return withDeviceLock(d.id, async () => {
      try {
        // Inline read-modify-write inside the single lock (withDeviceLock is NOT
        // reentrant — never call the public getState() here).
        const cur = ac.parseState(await withCloud(gc, (c) => c.sendCommand(d.cloud_appliance_id, ac.buildQuery()), 'state'));
        const merged = { ...cur, ...patch };
        const resp = await withCloud(gc, (c) => c.sendCommand(d.cloud_appliance_id, ac.buildSet(merged)), 'control');
        const state = ac.parseState(resp);
        setCache(d.id, state, true);
        return state;
      } catch (err) {
        gc.log.debug('setState (cloud) failed (offline)', d.id, failureOf(err));
        setCache(d.id, null, false);
        return { offline: true };
      }
    });
  }

  return withDeviceLock(d.id, async () => {
    const state = await (await lanFor(gc, d)).setState(patch);
    setCache(d.id, state, true);
    return state;
  });
}

async function testConnection(gc, id) {
  const d = await deviceOrThrow(gc, id);
  const t0 = Date.now();
  const state = await withDeviceLock(d.id, async () => (await lanFor(gc, d)).getState());
  setCache(d.id, state, true);
  return { ok: true, version: d.protocol_version, latencyMs: Date.now() - t0, state };
}

// ── Add device (V3 transactional: token fetched BEFORE persistence) ───────────

function redacted(d, hasCredentials) {
  return { ...d, has_credentials: hasCredentials };
}

async function addDevice(gc, { sn, name, transport, cloud_appliance_id, target_index }) {
  const existing = await store.listDevices(gc);
  const exists = (deviceSn) => existing.some((x) => x.device_sn === deviceSn);
  const duplicate = () => codeError('MIDEA_DEVICE_EXISTS', 'device already added');

  // ── Dreo: a heater or air conditioner of the Dreo account ────────────────
  if (transport === 'dreo') {
    if (exists('dreo-' + sn)) throw duplicate();
    const found = (await dreo.listCloudDevices(gc)).find((x) => x.sn === sn);
    if (!found) throw codeError('MIDEA_NOT_IN_CLOUD', 'device not found in the Dreo account');
    if (!found.kind) throw codeError('DREO_UNSUPPORTED', `${found.model || 'this device'} is not a heater or air conditioner`);
    const d = await store.createDevice(gc, dreoImport.record(found, name));
    await dreoImport.undismiss(gc, sn);
    return redacted(d, false);
  }

  // ── Cloud-only path ───────────────────────────────────────────────────────
  if (transport === 'cloud') {
    if (!cloud_appliance_id) throw codeError('MIDEA_INVALID', 'cloud_appliance_id required');
    const deviceSn = 'cloud-' + cloud_appliance_id;
    if (exists(deviceSn)) throw duplicate();
    const d = await store.createDevice(gc, {
      name: name || `Midea Cloud ${cloud_appliance_id}`,
      device_sn: deviceSn,
      transport: 'cloud',
      cloud_appliance_id,
    });
    return redacted(d, false);
  }

  // ── LAN: an assigned home target "ac" ─────────────────────────────────────
  const targets = await acTargets(gc);
  const target = targets.find((t) => t.index === target_index);
  if (!target) throw codeError('MIDEA_NO_TARGET', 'no such access target');

  // Duplicate pre-check BEFORE expensive cloud calls
  if (sn && exists(sn)) throw duplicate();

  // Who answers at the target (unicast discovery); not every device does.
  const info = await lan.probe(gc, target_index).catch(() => null);

  // Cloud resolution (only when sn provided and cloud configured)
  let c = null;
  try { ({ c } = await cloudFromConfig(gc)); } catch { c = null; }

  let match = null;
  if (c && sn) {
    if (!c.getSession()) await login(gc, c, null, 'add device: no session');
    const cloudList = await c.listDevices();
    match = cloudList.find((x) => x.sn === sn);
    if (!match) throw codeError('MIDEA_NOT_IN_CLOUD', 'device not found in cloud account');
  }

  const protocolVersion = info ? info.version : (sn ? 3 : 2);
  const deviceSn = sn || `lan-${info ? info.deviceId : 'target-' + target_index}`;
  if (exists(deviceSn)) throw duplicate();

  // ── TRANSACTIONAL BOUNDARY ──
  // For V3 devices, getToken MUST succeed BEFORE createDevice: any failure
  // here leaves the database untouched.
  let token = null;
  let key = null;
  if (protocolVersion === 3) {
    if (!c) throw codeError('MIDEA_CLOUD_NOT_CONFIGURED', 'cloud not configured — required for V3 token');
    const deviceId = match ? match.id : (info && info.deviceId);
    if (!deviceId) throw codeError('MIDEA_NOT_IN_CLOUD', 'device id unknown — choose the cloud device');
    if (!c.getSession()) await login(gc, c, null, 'add device: no session');
    const tk = await c.getToken(deviceId);  // throws → nothing persisted
    token = tk.token;
    key = tk.key;
  }

  const d = await store.createDevice(gc, {
    name: name || (match && match.name) || `Midea ${sn || target.label}`,
    device_sn: deviceSn,
    device_id: String(match ? match.id : (info && info.deviceId) || ''),
    transport: 'lan',
    target_index,
    protocol_version: protocolVersion,
    token,
    key,
  });
  return redacted(d, Boolean(token && key));
}

// ── Registry ──────────────────────────────────────────────────────────────────

async function removeDevice(gc, id) {
  const d = await store.getDevice(gc, id);
  if (d && d.vendor === 'dreo') {
    dreo.forget(d);
    // 2.1.0: removed by hand → the import of the account does not bring it back
    if (d.cloud_appliance_id) await dreoImport.dismiss(gc, String(d.cloud_appliance_id));
  }
  cache.delete(Number(id));
  return store.removeDevice(gc, id);
}

async function getStatus(gc) {
  const devices = await store.listDevices(gc);
  const cloud = await getCloudStatus(gc);
  return {
    devices: devices.map((d) => {
      if (d.vendor === 'dreo') {
        const st = dreo.cachedState(gc, d);
        return { id: d.id, name: d.name, enabled: d.enabled, online: Boolean(st && !st.offline), state: st && !st.offline ? st : null, checked: st != null, transport: d.transport, vendor: d.vendor };
      }
      const c = cache.get(d.id) || {};
      return { id: d.id, name: d.name, enabled: d.enabled, online: Boolean(c.online), state: c.state || null, checked: Boolean(c.lastAt), transport: d.transport, vendor: d.vendor };
    }),
    lastPollAt: status.lastPollAt,
    cloud_needs_reauth: cloud.needsReauth,
    cloud_reauth_reason: cloud.reason,
    dreo: { ...dreo.getStatus(), supported: dreo.supported(gc) },
  };
}

// ── Background (LAN poll + the Dreo socket; never 24/7 Midea cloud polling) ──

async function pollTick(gc) {
  if (pollRunning) return;                          // no overlapping ticks
  pollRunning = true;
  try {
    const all = await store.listDevices(gc);
    const observations = await dreo.tick(gc, all).catch((e) => { gc.log.debug('dreo tick failed', e.code || e.message); return []; });
    const devices = all.filter((d) => d.enabled && d.vendor !== 'dreo' && d.transport !== 'cloud' && d.target_index != null);
    if (!devices.length && !observations.length) return;
    if (devices.length) status.lastPollAt = new Date().toISOString();
    for (const d of devices) {
      if (lockDepth.get(d.id)) continue;            // skip devices with an active queue
      let st = null;
      try { st = await getState(gc, d.id); } catch { /* offline handled internally */ }
      const online = !!(st && !st.offline);
      observations.push({ device: { id: d.id, name: d.name }, online, state: online ? st : null });
    }
    await alerts.check(gc, observations).catch(() => {}); // notifications (errors are logged there)
  } finally {
    pollRunning = false;
  }
}

/** Forget every cached state (new data was imported). */
function reset() {
  cache.clear();
  alerts.reset();
  dreo.reset();
  guard.forget();
  dead = null;
  sessionChecked = { id: null, at: 0 };
}

module.exports = {
  CLOUD_STATE_TTL_MS,
  withDeviceLock, connectCloud, getCloudStatus, listCloudDevices, discoverLan, acTargets,
  getState, cachedState, recentState, setState, testConnection, addDevice, removeDevice, getStatus, pollTick, reset,
  // seams for the tests
  newCloud, connectTarget, _cache: cache, _guard: guard,
};
