'use strict';

// Dreo devices of the plugin (dreo.js = the protocol, dreomodel.js = the
// mapping): the account, the device list of the account, the live state and
// commands. One WebSocket per account carries the commands and every
// device's reports, so the state stays current without polling; the REST
// state is read on first use, while the socket is down, and every 10 minutes
// as a safety net. Needs gc.http.websocket (GateControl ≥ 1.184.0); on older
// versions Dreo answers DREO_NEEDS_UPDATE and Midea works as before.

const store = require('./store');
const model = require('./dreomodel');
const { DreoApi, DreoLink, md5 } = require('./dreo');

const { codeError } = store;

const REFRESH_MS = 10 * 60000;        // REST state while the socket is up
const REFRESH_DOWN_MS = 2 * 60000;    // … and while it is down
const BACKOFF_MS = [30000, 60000, 120000, 300000];

const raw = new Map();        // serial number → the device's raw values (REST state + reports)
const online = new Map();     // serial number → connected to the Dreo cloud
const readAt = new Map();     // serial number → ms of the last REST state
const refreshing = new Set(); // serial numbers with a REST read in flight
const status = { connected: false, needsLogin: false, lastError: null, failures: 0, retryAt: 0 };
let link = null;

const supported = (gc) => Boolean(gc.http && typeof gc.http.websocket === 'function');
const snOf = (d) => d.cloud_appliance_id;

/** Tests replace these two. */
function newApi(gc) {
  return new DreoApi({ fetch: (url, o) => gc.http.fetch(url, o) });
}
function newLink(gc) {
  return new DreoLink({ open: (url) => gc.http.websocket(url, { timeoutMs: 10000 }) });
}

function onReport(sn, values) {
  raw.set(sn, { ...(raw.get(sn) || {}), ...values });
  if (typeof values.connected === 'boolean') online.set(sn, values.connected);
  else if (!online.has(sn)) online.set(sn, true);
}

function linkOf(gc) {
  if (!link) {
    link = module.exports.newLink(gc);
    link.on('report', onReport);
    link.on('online', (sn, on) => online.set(sn, on));
    link.on('down', () => { status.connected = false; });
  }
  return link;
}

function needSupport(gc) {
  if (!supported(gc)) throw codeError('DREO_NEEDS_UPDATE', 'Dreo needs GateControl 1.184.0 or newer');
}

async function account(gc) {
  const cfg = await store.loadDreo(gc);
  if (!cfg.email || !cfg.passwordMd5) throw codeError('DREO_NOT_CONFIGURED', 'Dreo account not connected');
  return cfg;
}

let loggingIn = null;   // one login at a time: parallel callers whose token was refused share it

/** The stored access token, or a new login (refused = the token that was just refused). */
async function tokenOf(gc, cfg, refused) {
  if (cfg.token && cfg.token !== refused) return cfg.token;
  if (!loggingIn) {
    loggingIn = (async () => {
      const cur = await store.loadDreo(gc);
      if (cur.token && cur.token !== refused) return cur;   // someone else logged in meanwhile
      let r;
      try {
        r = await module.exports.newApi(gc).login(cur.email, cur.passwordMd5, cur.region);
      } catch (e) {
        if (e.code === 'DREO_LOGIN_FAILED') status.needsLogin = true;
        throw e;
      }
      status.needsLogin = false;
      Object.assign(cur, { token: r.token, region: r.region });
      await store.saveDreo(gc, cur);
      return cur;
    })().finally(() => { loggingIn = null; });
  }
  const fresh = await loggingIn;
  Object.assign(cfg, { token: fresh.token, region: fresh.region });
  return fresh.token;
}

/** A REST call with the account's token; one new login when the token was refused. */
async function withApi(gc, fn) {
  const cfg = await account(gc);
  const api = module.exports.newApi(gc);
  const tk = await tokenOf(gc, cfg);
  try {
    return await fn(api, cfg.region, tk);
  } catch (e) {
    if (e.code !== 'DREO_AUTH') throw e;
    const next = await tokenOf(gc, cfg, tk);
    return fn(api, cfg.region, next);
  }
}

// ─── Account and devices ────────────────────────

async function connect(gc, email, password) {
  needSupport(gc);
  const passwordMd5 = md5(password);
  const r = await module.exports.newApi(gc).login(email, passwordMd5, 'EU');
  await store.saveDreo(gc, { email, region: r.region, passwordMd5, token: r.token });
  Object.assign(status, { needsLogin: false, lastError: null, failures: 0, retryAt: 0 });
  if (link) link.close();
  return { region: r.region };
}

/** The account's devices → [{ sn, name, model, productName, kind }] (kind null = not a heater or air conditioner). */
async function listCloudDevices(gc) {
  const list = await withApi(gc, (api, region, tk) => api.devices(region, tk));
  return list.map((d) => ({ ...d, kind: model.kindOf(d.model) }));
}

/** An open socket for the account (a refused token → one new login). */
async function ensureLink(gc) {
  needSupport(gc);
  const cfg = await account(gc);
  const l = linkOf(gc);
  const tk = await tokenOf(gc, cfg);
  try {
    await l.ensure(cfg.region, tk);
  } catch (e) {
    if (!/\b40[13]\b/.test(String(e.message))) throw e;
    await l.ensure(cfg.region, await tokenOf(gc, cfg, tk));
  }
  status.connected = true;
}

// ─── State ──────────────────────────────────────

async function readState(gc, d) {
  const sn = snOf(d);
  const values = await withApi(gc, (api, region, tk) => api.state(region, tk, sn));
  raw.set(sn, { ...(raw.get(sn) || {}), ...values });
  online.set(sn, values.connected !== false);
  readAt.set(sn, Date.now());
}

function stateOf(d) {
  const sn = snOf(d);
  const r = raw.get(sn);
  if (!r) return null;
  if (online.get(sn) === false) return { offline: true };
  return model.normalize(d.kind, d.model, r);
}

function stale(sn) {
  const age = Date.now() - (readAt.get(sn) || 0);
  return age >= (link && link.connected ? REFRESH_MS : REFRESH_DOWN_MS);
}

function refreshInBackground(gc, d) {
  const sn = snOf(d);
  if (refreshing.has(sn) || !supported(gc)) return;
  refreshing.add(sn);
  readState(gc, d)
    .catch((e) => { gc.log.debug('dreo state refresh failed', d.id, e.code || e.message); })
    .finally(() => refreshing.delete(sn));
}

/** The live state (cached while the socket reports; a REST read when none or stale). Never throws: offline instead. */
async function getState(gc, d) {
  const sn = snOf(d);
  try {
    needSupport(gc);
    ensureLink(gc).catch((e) => { status.lastError = e.code || e.message; });
    if (!raw.has(sn) || stale(sn)) await readState(gc, d);
  } catch (e) {
    gc.log.debug('dreo getState failed', d.id, e.code || e.message);
    status.lastError = e.code || e.message;
    if (!raw.has(sn)) return { offline: true };
  }
  return stateOf(d) || { offline: true };
}

/** The cached state without any network (a background read when there is none). */
function cachedState(gc, d) {
  const sn = snOf(d);
  if (!raw.has(sn) || stale(sn)) refreshInBackground(gc, d);
  return stateOf(d);
}

/** What this device offers, labels in `lang` (from its last known values). */
function capsOf(d, t, lang) {
  return model.capsOf(d.kind, d.model, raw.get(snOf(d)) || {}, t, lang);
}

const noText = (lang, key) => key;

/** Change the state: checked against the device's caps, sent over the socket, answered with the new state. */
async function setState(gc, d, patch) {
  needSupport(gc);
  const sn = snOf(d);
  if (!raw.has(sn)) await readState(gc, d);
  const r = raw.get(sn) || {};
  const params = model.toParams(d.kind, d.model, r, patch, capsOf(d, noText, 'de'));
  if (!params) throw codeError('MIDEA_INVALID_PATCH', 'not a change this device offers');
  await ensureLink(gc);
  await link.command(sn, params);
  raw.set(sn, { ...(raw.get(sn) || r), ...params });  // the device's reports follow
  online.set(sn, true);
  return stateOf(d);
}

// ─── Background ─────────────────────────────────

/**
 * Every run of the background job: keep the socket up while enabled Dreo
 * devices exist (back off after failures), read stale states, and return the
 * observations for the notifications (online = connected to the Dreo cloud).
 */
async function tick(gc, devices) {
  const mine = devices.filter((d) => d.vendor === 'dreo' && d.enabled);
  if (!mine.length || !supported(gc)) {
    if (!mine.length && link) { link.close(); status.connected = false; }
    return [];
  }
  const cfg = await store.loadDreo(gc);
  if (!cfg.email || !cfg.passwordMd5 || status.needsLogin) return [];
  if (!(link && link.connected) && Date.now() >= status.retryAt) {
    try {
      await ensureLink(gc);
      Object.assign(status, { failures: 0, retryAt: 0, lastError: null });
    } catch (e) {
      status.lastError = e.code || e.message;
      status.retryAt = Date.now() + BACKOFF_MS[Math.min(status.failures, BACKOFF_MS.length - 1)];
      status.failures += 1;
      gc.log.debug('dreo connection failed', status.lastError);
    }
  }
  const out = [];
  for (const d of mine) {
    const sn = snOf(d);
    if (stale(sn)) {
      try { await readState(gc, d); } catch (e) { gc.log.debug('dreo state read failed', d.id, e.code || e.message); }
    }
    if (!raw.has(sn)) continue;
    const st = stateOf(d);
    const on = Boolean(st && !st.offline);
    out.push({ device: { id: d.id, name: d.name }, online: on, state: on ? st : null });
  }
  return out;
}

function forget(d) {
  const sn = snOf(d);
  raw.delete(sn); online.delete(sn); readAt.delete(sn);
}

function getStatus() {
  return { connected: Boolean(link && link.connected), needs_login: status.needsLogin, last_error: status.lastError };
}

function reset() {
  if (link) link.close();
  link = null;
  raw.clear(); online.clear(); readAt.clear(); refreshing.clear();
  Object.assign(status, { connected: false, needsLogin: false, lastError: null, failures: 0, retryAt: 0 });
  loggingIn = null;
}

module.exports = {
  supported, connect, listCloudDevices, ensureLink, getState, cachedState, setState, capsOf, tick, forget, getStatus, reset,
  newApi, newLink, _raw: raw,
};
