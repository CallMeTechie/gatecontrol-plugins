'use strict';

// The locks: registry (admin page "Geräte"), last known state (lock_state),
// polling and the raw action call to Nuki (bridge or web, server/nuki.js).
// Rights, time windows and the history are checked/written in server/control.js.
//
// Polling (background, every 5 s tick): each source — one bridge, or the
// Nuki Web account — at most every 30 s, every 10 s while an automatic
// unlock waits for the door (safety net), and right after an action (twice:
// at once and 10 s later, the bridge's cached state lags behind).
//
// Transitional states that do not end (1.0.1): the bridge's /list answers
// with its cached lastKnownState and Nuki Web's /smartlock with the cloud's
// copy; both can stay on unlocking / locking / unlatching (opener: opening /
// boot_run) long after the lock has stopped, e.g. after an opening through the
// Nuki app, keypad or button. Then:
//   bridge  the overview transitional for ≥ 30 s → /lockState (the bridge asks
//           the lock over Bluetooth), at most once per 60 s per lock; its answer
//           is saved instead (and used while /list stays on that same code)
//   web     transitional for ≥ 60 s → GET /smartlock/{id}, at most once per
//           2 min per lock
//   display the saved state transitional for ≥ 3 min → the last stable state is
//           shown with stale: true (displayState) — never for safety decisions:
//           server/control.js refuses an automatic unlock then (state_unclear).
// A failed re-read keeps the overview's state for that poll.

const store = require('./store');
const nuki = require('./nuki');
const { fail, parseJson, iso } = require('./util');

const POLL_MS = 30000;
const POLL_FAST_MS = 10000;
const STALE_MS = 3 * 60000;
const REFRESH = {
  bridge: { afterMs: 30000, everyMs: 60000, via: 'lockState' },
  web: { afterMs: 60000, everyMs: 120000, via: 'smartlock_id' },
};
const WEB_TOKEN = 'nuki.web_token';
const bridgeSecret = (id) => `bridge.${id}.token`;

// refreshedAt: lock id → ms of the last single re-read · fresh: lock id → { code, obs } (the re-read's
// answer, used while the overview keeps reporting the same transitional code)
const mem = { lastPoll: new Map(), soon: new Map(), refreshedAt: new Map(), fresh: new Map() };
function reset() { mem.lastPoll.clear(); mem.soon.clear(); mem.refreshedAt.clear(); mem.fresh.clear(); }

function sourceKey(lock) {
  return lock.source === 'web' ? 'web' : `bridge:${lock.bridge_id}`;
}

/** Ask for a poll of this lock's source at `at` (ms). */
function pollSoon(lock, at) {
  const k = sourceKey(lock);
  const list = mem.soon.get(k) || [];
  list.push(at);
  mem.soon.set(k, list);
}

function rowToLock(r) {
  const actions = parseJson(r.actions, []).filter((a) => ['lock', 'unlock', 'open'].includes(a));
  return {
    id: r.id, name: r.name, source: r.source, bridge_id: r.bridge_id, nuki_id: r.nuki_id, device_type: r.device_type,
    actions: actions.filter((a) => nuki.supportedActions(r.device_type).includes(a)),
    door_sensor: r.door_sensor === 1, open_too_long_min: r.open_too_long_min, night_check: r.night_check || null, sort: r.sort,
    state: {
      state: r.st_state || 'unknown', nukiState: r.nuki_state == null ? null : r.nuki_state, door: r.door || null,
      batteryCritical: r.battery_critical === 1, batteryPercent: r.battery_percent == null ? null : r.battery_percent,
      batteryCharging: r.battery_charging === 1, reachable: r.reachable === 1, updatedAt: r.updated_at || null, checkedAt: r.checked_at || null,
      unreachableSince: r.unreachable_since || null, doorOpenSince: r.door_open_since || null, jammedSince: r.jammed_since || null,
      movingSince: r.moving_since || null, stableState: r.stable_state || null, via: r.nuki_via || null,
      listNukiState: r.list_nuki_state == null ? null : r.list_nuki_state, listMovingSince: r.list_moving_since || null,
    },
  };
}

const SELECT = `SELECT l.*, s.state AS st_state, s.nuki_state, s.door, s.battery_critical, s.battery_percent, s.battery_charging,
  s.reachable, s.updated_at, s.checked_at, s.unreachable_since, s.door_open_since, s.jammed_since,
  s.moving_since, s.stable_state, s.nuki_via, s.list_nuki_state, s.list_moving_since
  FROM locks l LEFT JOIN lock_state s ON s.lock_id = l.id`;

async function all(gc) {
  return (await store.all(gc, `${SELECT} ORDER BY l.sort, l.id`)).map(rowToLock);
}

async function get(gc, id) {
  const r = await store.one(gc, `${SELECT} WHERE l.id = ?`, [id]);
  return r ? rowToLock(r) : null;
}

async function bridges(gc) {
  return store.all(gc, 'SELECT id, name, target_index, created_at, updated_at FROM bridges ORDER BY id');
}

async function bridgeToken(gc, id) {
  const t = await gc.settings.get(bridgeSecret(id));
  return typeof t === 'string' && t ? t : null;
}

async function webToken(gc) {
  const t = await gc.settings.get(WEB_TOKEN);
  return typeof t === 'string' && t ? t : null;
}

/**
 * The state to show: a transitional state saved for ≥ 3 min is not believed any more — the last
 * stable state is shown instead, with stale: true ("Zustand unklar – zuletzt: …"). For display only:
 * every safety decision uses lock.state.state.  → { state, stale }
 */
function displayState(lock, now = Date.now()) {
  const s = lock.state;
  const stale = nuki.isTransitional(s.state) && s.movingSince != null && now - s.movingSince >= STALE_MS;
  return { state: stale ? (s.stableState || 'unknown') : s.state, stale };
}

/** The state view for the API (no Nuki internals). */
function stateView(lock, now = Date.now()) {
  const s = lock.state;
  const d = displayState(lock, now);
  return {
    lock: d.state, stale: d.stale, door: lock.door_sensor ? (s.door || 'unknown') : null,
    batteryCritical: s.batteryCritical, batteryPercent: s.batteryPercent, batteryCharging: s.batteryCharging,
    reachable: s.reachable, updatedAt: iso(s.updatedAt),
  };
}

/** What Nuki reported, for the admin page "Geräte" (diagnostics). */
function diagView(lock, now = Date.now()) {
  const s = lock.state;
  return {
    source: lock.source, nukiState: s.nukiState, via: s.via, listNukiState: s.listNukiState,
    updatedAt: iso(s.updatedAt), checkedAt: iso(s.checkedAt), movingSince: iso(s.movingSince),
    stableState: s.stableState, stale: displayState(lock, now).stale,
  };
}

/**
 * Store an observed state (null = not reachable). Keeps the "since" times of open door, jam, outage and
 * of a transitional state, and the last stable state.
 * meta = { via, listCode, listSince } — where obs came from and the overview's raw code (diagnostics).
 */
async function saveState(gc, lock, obs, now, meta = {}) {
  const prev = lock.state;
  if (!obs) {
    await store.run(gc, `INSERT INTO lock_state (lock_id, reachable, checked_at, unreachable_since) VALUES (?, 0, ?, ?)
      ON CONFLICT(lock_id) DO UPDATE SET reachable = 0, checked_at = excluded.checked_at,
      unreachable_since = COALESCE(lock_state.unreachable_since, excluded.unreachable_since)`, [lock.id, now, now]);
    return;
  }
  const doorOpenSince = obs.door === 'open' ? (prev.door === 'open' && prev.doorOpenSince ? prev.doorOpenSince : now) : null;
  const jammedSince = obs.state === 'jammed' ? (prev.state === 'jammed' && prev.jammedSince ? prev.jammedSince : now) : null;
  const moving = nuki.isTransitional(obs.state);
  const movingSince = moving ? (nuki.isTransitional(prev.state) && prev.movingSince ? prev.movingSince : now) : null;
  const prevStable = prev.state && prev.state !== 'unknown' && !nuki.isTransitional(prev.state);
  const stableState = moving ? (prevStable ? prev.state : prev.stableState) : obs.state;
  await store.run(gc, `INSERT INTO lock_state (lock_id, state, nuki_state, door, battery_critical, battery_percent, battery_charging, reachable,
      updated_at, checked_at, unreachable_since, door_open_since, jammed_since, moving_since, stable_state, nuki_via, list_nuki_state, list_moving_since)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(lock_id) DO UPDATE SET state = excluded.state, nuki_state = excluded.nuki_state, door = excluded.door,
      battery_critical = excluded.battery_critical, battery_percent = excluded.battery_percent, battery_charging = excluded.battery_charging,
      reachable = 1, updated_at = excluded.updated_at, checked_at = excluded.checked_at, unreachable_since = NULL,
      door_open_since = excluded.door_open_since, jammed_since = excluded.jammed_since, moving_since = excluded.moving_since,
      stable_state = excluded.stable_state, nuki_via = excluded.nuki_via, list_nuki_state = excluded.list_nuki_state,
      list_moving_since = excluded.list_moving_since`, [
    lock.id, obs.state, obs.nukiState, obs.door, obs.batteryCritical ? 1 : 0, obs.batteryPercent, obs.batteryCharging ? 1 : 0,
    now, now, doorOpenSince, jammedSince, movingSince, stableState, meta.via || null,
    meta.listCode == null ? obs.nukiState : meta.listCode, meta.listSince || null,
  ]);
}

/**
 * The overview (bridge /list, web /smartlock) reports a transitional state: since `listSince` (ms).
 * Long enough → read this one lock again (bridge /lockState, web GET /smartlock/{id}), rate-limited per
 * lock; between two re-reads the last answer stands while the overview keeps the same code.
 * → { obs, via } to save instead, or null (keep the overview's state).
 */
async function refreshStuck(gc, lock, obs, listSince, now, src) {
  const web = lock.source === 'web';
  const r = web ? REFRESH.web : REFRESH.bridge;
  if (now - listSince < r.afterMs) return null;
  const code = obs.nukiState;
  const last = mem.refreshedAt.get(lock.id);
  if (last != null && now - last < r.everyMs) {
    const f = mem.fresh.get(lock.id);
    return f && f.code === code ? { obs: f.obs, via: r.via } : null;
  }
  mem.refreshedAt.set(lock.id, now);
  mem.fresh.delete(lock.id);
  const source = web ? 'web' : 'bridge';
  try {
    let st = null;
    if (web) {
      const d = await nuki.webLock(gc, src.token, lock);
      st = d && d.reachable !== false ? d.state : null;
    } else st = await nuki.bridgeLockState(gc, src.bridge, src.token, lock);
    if (!st || st.state === 'unknown') {
      gc.log.debug('nuki transitional state: re-read gave no state', lock.id, source);
      return null;
    }
    mem.fresh.set(lock.id, { code, obs: st });
    gc.log.debug('nuki transitional state refreshed', lock.id, source, `${code} -> ${st.nukiState}`, `${Math.round((now - listSince) / 1000)}s`);
    return { obs: st, via: r.via };
  } catch (e) {
    gc.log.debug('nuki transitional state: re-read failed', lock.id, source, (e && e.code) || 'error');
    return null;
  }
}

/**
 * Poll the sources that are due (or all of `force`). → [{ lock (before), after (lock) }] for every polled lock.
 * fast: source keys that poll every 10 s (pending automatic unlocks).
 */
async function poll(gc, now, { force = false, fast = new Set(), only = null } = {}) {
  const list = (await all(gc)).filter((l) => !only || only.includes(l.id));
  const bySource = new Map();
  for (const l of list) {
    const k = sourceKey(l);
    if (!bySource.has(k)) bySource.set(k, []);
    bySource.get(k).push(l);
  }
  const changed = [];
  for (const [k, group] of bySource) {
    const soon = (mem.soon.get(k) || []).filter((t) => t <= now);
    const every = fast.has(k) ? POLL_FAST_MS : POLL_MS;
    const due = force || soon.length || !mem.lastPoll.has(k) || now - mem.lastPoll.get(k) >= every - 500;
    if (!due) continue;
    mem.lastPoll.set(k, now);
    if (soon.length) mem.soon.set(k, (mem.soon.get(k) || []).filter((t) => t > now));
    let found = null;
    const src = { bridge: null, token: null };
    try {
      if (k === 'web') {
        src.token = await webToken(gc);
        found = new Map((await nuki.webList(gc, src.token)).map((d) => [d.nukiId, d]));
      } else {
        src.bridge = await store.one(gc, 'SELECT * FROM bridges WHERE id = ?', [group[0].bridge_id]);
        if (!src.bridge) throw fail('not_configured');
        src.token = await bridgeToken(gc, src.bridge.id);
        found = new Map((await nuki.bridgeList(gc, src.bridge, src.token)).map((d) => [d.nukiId, d]));
      }
    } catch (e) {
      found = null;
      gc.log.debug('nuki poll failed', k, (e && e.code) || 'error');
    }
    for (const l of group) {
      const d = found && found.get(String(l.nuki_id));
      const reachable = !!(d && d.state && d.reachable !== false && d.state.state !== 'unknown');
      let obs = reachable ? d.state : null;
      const meta = { via: k === 'web' ? 'smartlock' : 'list', listCode: obs ? obs.nukiState : null, listSince: null };
      if (obs && nuki.isTransitional(obs.state)) {
        // the overview has been on this transitional code since …
        meta.listSince = l.state.listNukiState === obs.nukiState && l.state.listMovingSince ? l.state.listMovingSince : now;
        const fresh = await refreshStuck(gc, l, obs, meta.listSince, now, src);
        if (fresh) { obs = fresh.obs; meta.via = fresh.via; }
      } else if (obs) mem.fresh.delete(l.id);
      await store.tx(gc, () => saveState(gc, l, obs, now, meta));
      changed.push({ before: l, after: await get(gc, l.id) });
    }
  }
  return changed;
}

/** Run an action on the lock itself (no rights check here). → { ok } or throws a code. */
async function execute(gc, lock, action) {
  if (!lock.actions.includes(action)) throw fail('unsupported');
  if (lock.source === 'web') {
    const token = await webToken(gc);
    return nuki.webAction(gc, token, lock, action);
  }
  const bridge = await store.one(gc, 'SELECT * FROM bridges WHERE id = ?', [lock.bridge_id]);
  if (!bridge) throw fail('not_configured');
  const token = await bridgeToken(gc, bridge.id);
  return nuki.bridgeAction(gc, bridge, token, lock, action);
}

/** The state right after a successful action, until the next poll says otherwise. */
const AFTER = { lock: 'locked', unlock: 'unlocked', open: 'unlatched' };
async function assumeAfter(gc, lock, action, now) {
  const state = nuki.isOpener(lock.device_type) ? 'open' : AFTER[action];
  if (!state) return;
  mem.fresh.delete(lock.id);
  await store.run(gc, `UPDATE lock_state SET state = ?, updated_at = ?, reachable = 1, unreachable_since = NULL, moving_since = NULL,
    stable_state = ?, nuki_state = NULL, nuki_via = 'assumed' WHERE lock_id = ?`, [state, now, state, lock.id]);
}

module.exports = {
  POLL_MS, POLL_FAST_MS, STALE_MS, REFRESH, WEB_TOKEN, bridgeSecret, reset, sourceKey, pollSoon, all, get, bridges, bridgeToken, webToken,
  displayState, stateView, diagView, saveState, poll, execute, assumeAfter, rowToLock, _mem: mem,
};
