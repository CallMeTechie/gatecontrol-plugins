'use strict';

// Accounts and vehicles (port of GateControl's src/services/skoda/index.js):
// login, sync of the garage and the vehicle state, render image, refresh,
// background polling with rate-limit backoff. Everything that talks to the
// Škoda cloud for one account runs under that account's lock (poller,
// manual refresh, commands, details, removal) — the refresh token is
// single-use, so two parallel refreshes would log the account out.

const auth = require('./auth');
const { SkodaClient } = require('./client');
const { fetchFor } = require('./http');
const store = require('./store');

const REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
const COMMAND_REFRESH_COOLDOWN_MS = 30 * 1000;
const BACKOFF_START_MIN = 60;
const BACKOFF_CAP_MIN = 240;
// The render is stored as a BLOB and served in parts (store.imagePart), so
// only the host's http.fetch limit (5 MB) bounds it; 4 MB leaves headroom.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const POLL_MIN = 5;
const POLL_MAX = 1440;
const POLL_DEFAULT = 15;

const state = { lastSyncAt: null, lastPoll: 0, polling: false };
// ponytail: these maps grow one entry per vehicle/account ever touched —
// fine for a household fleet (same trade-off as the built-in integration).
const refreshCooldown = new Map(); // vehicleId -> ts
const cmdRefreshCooldown = new Map(); // vehicleId -> ts (after a command, 30 s window)
const accountLocks = new Map(); // accountId -> promise chain tail

function codeError(code, message) { return Object.assign(new Error(message || code), { code }); }

/** Serialises everything that talks to the cloud for one account. */
function withAccountLock(id, fn) {
  const prev = accountLocks.get(id) || Promise.resolve();
  const next = prev.then(fn, fn);
  accountLocks.set(id, next.catch(() => { /* keeps the chain alive; the caller sees the error via its own promise */ }));
  return next;
}

/** Poll interval in minutes from the plugin setting (5–1440, default 15). */
async function pollIntervalMin(gc) {
  const v = Number(await gc.settings.get('interval'));
  if (!Number.isFinite(v) || v <= 0) return POLL_DEFAULT;
  return Math.max(POLL_MIN, Math.min(POLL_MAX, Math.round(v)));
}

function clientFor(gc, accountId) {
  return new SkodaClient({
    getSession: () => store.getSession(gc, accountId),
    saveSession: (tokens) => store.saveSession(gc, accountId, tokens),
    fetchImpl: fetchFor(gc),
  });
}

async function ensureSession(gc, account) {
  if (await store.getSession(gc, account.id)) return;
  const password = await store.getPassword(gc, account.id);
  if (!password) throw codeError('SKODA_LOGIN_FAILED', 'no password stored');
  const tokens = await auth.login(account.email, password, { fetchImpl: fetchFor(gc) });
  await store.saveSession(gc, account.id, tokens);
}

function firstRenderUrl(vehicleInfo) {
  const renders = (vehicleInfo && vehicleInfo.compositeRenders) || [];
  for (const render of renders) {
    for (const layer of (render && render.layers) || []) {
      if (layer && typeof layer.url === 'string' && layer.url) return layer.url;
    }
  }
  return null;
}

async function syncVehicle(gc, client, accountId, garageEntry) {
  const row = await store.upsertVehicle(gc, accountId, garageEntry);
  const { state: vehicleState } = await client.fetchFullState(garageEntry.vin);
  await store.saveState(gc, row.id, vehicleState);

  // Render image: fetch once, refetch when the url changes or no image is
  // stored (e.g. one skipped by 1.0.0 as too large).
  try {
    const info = await client.vehicleInfo(garageEntry.vin);
    const url = firstRenderUrl(info);
    if (url && (!row.has_image || row.image_url !== url)) {
      const img = await client.renderImage(url);
      if (img.bytes.length <= MAX_IMAGE_BYTES) await store.saveImage(gc, row.id, img, url);
      else gc.log.warn('vehicle render too large, skipped', img.bytes.length);
    }
  } catch (e) {
    if (e.code === 'SKODA_RATE_LIMITED' || e.code === 'SKODA_UNAUTHORIZED') throw e;
    gc.log.warn('vehicle render image not loaded', e.code || e.message);
  }
}

function syncAccount(gc, accountId) {
  return withAccountLock(accountId, () => syncAccountLocked(gc, accountId));
}

async function syncAccountLocked(gc, accountId) {
  let account = null;
  try {
    account = await store.getAccount(gc, accountId);
    if (!account) return { ok: false, error: 'not found' };
    await ensureSession(gc, account);
    const client = clientFor(gc, accountId);
    const garage = await client.garage();
    const entries = ((garage && garage.vehicles) || []).filter((e) => e && typeof e.vin === 'string' && /^[A-Za-z0-9]{1,32}$/.test(e.vin));
    for (const entry of entries) await syncVehicle(gc, client, accountId, entry);
    await store.setStatus(gc, accountId, 'ok', null, { backoffMin: 0, nextRetryAt: null });
    state.lastSyncAt = new Date().toISOString();
    return { ok: true, vehicles: entries.length };
  } catch (e) {
    if (e.code === 'SKODA_RATE_LIMITED') {
      const prev = (account && account.backoff_min) || 0;
      const backoffMin = prev ? Math.min(prev * 2, BACKOFF_CAP_MIN) : BACKOFF_START_MIN;
      const nextRetryAt = new Date(Date.now() + backoffMin * 60000).toISOString();
      await store.setStatus(gc, accountId, 'rate_limited', 'HTTP 429', { backoffMin, nextRetryAt });
    } else if (e.code === 'SKODA_LOGIN_FAILED' || e.code === 'SKODA_TERMS_REQUIRED' || e.code === 'SKODA_AUTH_FLOW_CHANGED') {
      await store.saveSession(gc, accountId, null).catch(() => {}); // drop a stale session, fresh login after the fix
      await store.setStatus(gc, accountId, 'login_failed', `${e.code}: ${e.message}`);
    } else if (e.code === 'SKODA_UNAUTHORIZED') {
      // expired/invalid session: drop it, the next run logs in again with the stored password
      await store.saveSession(gc, accountId, null).catch(() => {});
      await store.setStatus(gc, accountId, 'error', `${e.code}: ${e.message}`);
    } else {
      await store.setStatus(gc, accountId, 'error', e.code ? `${e.code}: ${e.message}` : e.message);
    }
    gc.log.warn('sync failed', `account ${accountId}`, e.code || e.message);
    return { ok: false, error: e.message };
  }
}

async function syncAll(gc, { ignoreRetryAt = false } = {}) {
  for (const acc of await store.listAccounts(gc)) {
    if (acc.status === 'login_failed') continue;
    if (!ignoreRetryAt && acc.status === 'rate_limited' && acc.next_retry_at && new Date(acc.next_retry_at) > new Date()) continue;
    await syncAccount(gc, acc.id);
  }
}

async function refreshVehicle(gc, vehicleId, { afterCommand = false } = {}) {
  const map = afterCommand ? cmdRefreshCooldown : refreshCooldown;
  const cooldown = afterCommand ? COMMAND_REFRESH_COOLDOWN_MS : REFRESH_COOLDOWN_MS;
  const last = map.get(vehicleId) || 0;
  if (Date.now() - last < cooldown) throw codeError('SKODA_REFRESH_COOLDOWN', 'refresh cooldown active');
  const v = await store.getVehicle(gc, vehicleId);
  if (!v) throw codeError('SKODA_VEHICLE_NOT_FOUND', 'vehicle not found');
  map.set(vehicleId, Date.now());
  return syncAccount(gc, v.account_id);
}

function removeAccount(gc, accountId) {
  // waits for an in-flight sync of this account: it would re-insert vehicles otherwise
  return withAccountLock(accountId, () => store.removeAccount(gc, accountId));
}

/** Background run (tick): every <interval> minutes all accounts. */
async function pollTick(gc) {
  if (state.polling) return false;
  const interval = await pollIntervalMin(gc);
  if (Date.now() - state.lastPoll < interval * 60000 - 2000) return false;
  state.polling = true;
  state.lastPoll = Date.now();
  try {
    if ((await store.listAccounts(gc)).length) await syncAll(gc);
  } finally {
    state.polling = false;
  }
  return true;
}

function reset() {
  refreshCooldown.clear();
  cmdRefreshCooldown.clear();
  accountLocks.clear();
  state.lastSyncAt = null;
  state.lastPoll = 0;
  state.polling = false;
}

module.exports = {
  state, withAccountLock, clientFor, pollIntervalMin, firstRenderUrl,
  syncAccount, syncAll, refreshVehicle, removeAccount, pollTick, reset,
  MAX_IMAGE_BYTES, POLL_MIN, POLL_MAX,
};
