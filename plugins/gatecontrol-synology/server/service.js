'use strict';

// Polling and control of the NAS. One DSM session per NAS is kept in
// memory and reused between polls (a stale one logs in again, see dsm.js);
// requests to one NAS never overlap (lock per NAS). The last good status
// stays stored when a poll fails.
//
// Status = these DSM APIs (versions clamped to what SYNO.API.Info offers):
//   SYNO.DSM.Info v2 getinfo                 model, DSM version, uptime, temperature
//     ↳ fallback SYNO.Core.System v1 info
//   SYNO.Core.System.Utilization v1 get      CPU / RAM utilisation
//   SYNO.Storage.CGI.Storage v1 load_info    volumes, storage pools, drives (S.M.A.R.T.)
//     ↳ fallback SYNO.Core.System v1 info type=storage (volumes, drives)
//   SYNO.Core.Upgrade.Server v1 check        available DSM update (every 6 h)
//   SYNO.Backup.Task v1 list                 Hyper Backup tasks (when the package is installed)
//   SYNO.Core.ExternalDevice.UPS v1 get      UPS (when one is connected)
// Control:
//   SYNO.Core.System v1 reboot / shutdown
//   SYNO.Backup.Task v1 backup task_id=<id>  "back up now"
// GateDrop (1.2.0):
//   SYNO.FileStation.Upload v2 upload        a handed-over media file into a drop folder (gc.net.uploadTarget)

const dsm = require('./dsm');
const parse = require('./parse');
const store = require('./store');

const UPDATE_EVERY_MS = 6 * 3600000;
const UPDATE_MANUAL_MS = 30 * 60000;
const AUTH_PAUSE_MS = 6 * 3600000;
const MAX_BACKOFF_MS = 15 * 60000;
const POWER_SETTLE_MS = 2 * 60000;
const BACKUP_ADDITIONAL = ['last_bkp_time', 'next_bkp_time', 'last_bkp_result', 'is_modified', 'last_bkp_progress'];

const sessions = new Map(); // nas id → { key, session }
const locks = new Map();    // nas id → promise chain

function withLock(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  const p = prev.then(fn, fn);
  const tail = p.catch(() => {});
  locks.set(id, tail);
  tail.then(() => { if (locks.get(id) === tail) locks.delete(id); });
  return p;
}

const sendTo = (gc, index) => (path, opts) => gc.net.fetchTarget('nas', path, { ...opts, index });
// GateControl ≥ 1.193.0: a multipart upload of a media file to the NAS (null on older hosts)
const uploadTo = (gc, index) => (gc.net && typeof gc.net.uploadTarget === 'function' ? (path, opts) => gc.net.uploadTarget('nas', path, { ...opts, index }) : null);

function clientFor(gc, nas) {
  const key = String(nas.target_index);
  let e = sessions.get(nas.id);
  if (!e || e.key !== key) { e = { key, session: dsm.newSession() }; sessions.set(nas.id, e); }
  return dsm.createClient({ send: sendTo(gc, nas.target_index), upload: uploadTo(gc, nas.target_index), credentials: () => store.credentials(gc, nas.id), session: e.session });
}

/** Forget the session of a NAS (credentials or target changed, deleted, poll failed). */
async function dropSession(gc, id, { logout = false } = {}) {
  const e = sessions.get(id);
  sessions.delete(id);
  if (logout && e && e.session.sid) {
    const nas = await store.getNas(gc, id).catch(() => null);
    const index = nas ? nas.target_index : Number(e.key);
    await dsm.createClient({ send: sendTo(gc, index), credentials: async () => ({}), session: e.session }).logout();
  }
}

async function logoutAll(gc) {
  for (const id of [...sessions.keys()]) await dropSession(gc, id, { logout: true }).catch(() => {});
}

/** Optional parts of the status: an API that is missing or refuses leaves its part empty; connection and login problems end the poll. */
async function optional(fn, map) {
  try { return map(await fn()); } catch (e) {
    if (dsm.NET_CODES.has(e.code) || dsm.AUTH_CODES.has(e.code) || e.code === 'SESSION_EXPIRED') throw e;
    return null;
  }
}

/**
 * Everything the page shows, from the APIs above.
 * @returns {Promise<object>} normalised status (parse.js)
 */
async function collect(c, prev, { checkUpdate }) {
  const apis = await c.apis();
  let info = null;
  if (apis['SYNO.DSM.Info']) info = await optional(() => c.call('SYNO.DSM.Info', 'getinfo', {}, { version: 2 }), parse.dsmInfo);
  if (!info || !info.model) {
    const sys = parse.systemInfo(await c.call('SYNO.Core.System', 'info', {}, { version: 1 }));
    const first = info || {};
    info = Object.fromEntries(Object.keys(sys).map((k) => [k, first[k] != null && first[k] !== false ? first[k] : sys[k]]));
  }
  const util = apis['SYNO.Core.System.Utilization'] ? await optional(() => c.call('SYNO.Core.System.Utilization', 'get', {}, { version: 1 }), parse.utilization) : null;
  let st = apis['SYNO.Storage.CGI.Storage'] ? await optional(() => c.call('SYNO.Storage.CGI.Storage', 'load_info', {}, { version: 1 }), parse.storage) : null;
  if (!st || (!st.volumes.length && !st.disks.length)) {
    const fb = await optional(() => c.call('SYNO.Core.System', 'info', { type: 'storage' }, { version: 1 }), parse.storageFallback);
    if (fb && (fb.volumes.length || fb.disks.length)) st = fb;
  }
  let update = prev ? prev.update || null : null;
  let updateChecked = false;
  if (checkUpdate && apis['SYNO.Core.Upgrade.Server']) {
    const u = await optional(() => c.call('SYNO.Core.Upgrade.Server', 'check', {}, { version: 1, timeoutMs: 30000 }), parse.upgrade);
    updateChecked = true;
    if (u) update = u;
  }
  const backups = apis['SYNO.Backup.Task'] ? await optional(() => c.call('SYNO.Backup.Task', 'list', { additional: BACKUP_ADDITIONAL }, { version: 1 }), parse.backups) : null;
  const ups = apis['SYNO.Core.ExternalDevice.UPS'] ? await optional(() => c.call('SYNO.Core.ExternalDevice.UPS', 'get', {}, { version: 1 }), parse.ups) : null;
  return {
    v: 1, info, util,
    storage_source: st ? st.source : null,
    volumes: st ? st.volumes : [], pools: st ? st.pools : [], disks: st ? st.disks : [],
    update, update_checked: updateChecked, backups, ups,
    apis: { backup: !!apis['SYNO.Backup.Task'], upgrade: !!apis['SYNO.Core.Upgrade.Server'], storage: !!st },
  };
}

/** Delay before the next poll: the interval, and after N failures doubling up to 15 min. */
function backoffMs(cfg, failures) {
  const base = cfg.interval * 1000;
  if (failures < cfg.unreachablePolls) return base;
  return Math.max(base, Math.min(MAX_BACKOFF_MS, base * 2 ** (failures - cfg.unreachablePolls + 1)));
}

/**
 * Poll one NAS now (background or "Aktualisieren").
 * opts.otp: a one-time code — log in with it first and keep the device token.
 * @returns {Promise<{ ok, reachable, code?, failures, snapshot? }>}
 */
function poll(gc, nas, cfg, { now = Date.now(), otp = null, manual = false } = {}) {
  return withLock(nas.id, async () => {
    const cur = (await store.getNas(gc, nas.id)) || nas;
    const prev = await store.getSnapshot(gc, nas.id);
    const c = clientFor(gc, cur);
    try {
      if (otp) {
        const r = await c.login({ otp });
        if (r.did) await store.setSecret(gc, nas.id, 'device', r.did);
      }
      const due = manual ? UPDATE_MANUAL_MS : UPDATE_EVERY_MS;
      const checkUpdate = !cur.update_checked_at || now - cur.update_checked_at >= due;
      const snap = await collect(c, prev && prev.data, { checkUpdate });
      await store.saveSnapshot(gc, nas.id, snap, now);
      const patch = { status: 'ok', last_error: null, error_count: 0, last_attempt_at: now, last_success_at: now, next_poll_at: now + cfg.interval * 1000 };
      if (snap.update_checked) patch.update_checked_at = now;
      if (cur.power_state && now - (cur.power_at || 0) >= POWER_SETTLE_MS) { patch.power_state = null; patch.power_at = null; }
      await store.updateNas(gc, nas.id, patch);
      return { ok: true, reachable: true, failures: 0, snapshot: snap };
    } catch (e) {
      const code = (e && e.code) || 'INTERNAL';
      sessions.delete(nas.id); // a fresh session (and API list) next time
      if (dsm.AUTH_CODES.has(code)) {
        // the NAS answered, the login did not work: pause (DSM blocks an address after repeated wrong logins)
        await store.updateNas(gc, nas.id, { status: dsm.OTP_CODES.has(code) || code === 'OTP_ENFORCED' ? 'otp' : 'auth', last_error: code, error_count: 0, last_attempt_at: now, next_poll_at: now + AUTH_PAUSE_MS });
        if (!manual) gc.log.warn('NAS login failed', nas.id, code);
        return { ok: false, reachable: true, code, failures: 0 };
      }
      if (!dsm.NET_CODES.has(code) && !(e instanceof dsm.DsmError)) gc.log.warn('NAS poll failed', nas.id, (e && e.message) || code);
      const failures = cur.error_count + 1;
      await store.updateNas(gc, nas.id, { status: 'error', last_error: code, error_count: failures, last_attempt_at: now, next_poll_at: now + backoffMs(cfg, failures) });
      return { ok: false, reachable: false, code, failures, lastSeen: cur.last_success_at };
    }
  });
}

/**
 * "Verbindung testen": log in with the given account (nothing is stored),
 * read model and DSM version, check admin rights, log out.
 * → { model, dsm, admin, did }
 */
async function test(gc, { targetIndex, account, password, device, otp }) {
  const c = dsm.createClient({ send: sendTo(gc, targetIndex), credentials: async () => ({ account, password, device }), session: dsm.newSession() });
  try {
    const r = await c.login({ otp });
    let info = await optional(() => c.call('SYNO.DSM.Info', 'getinfo', {}, { version: 2 }), parse.dsmInfo);
    if (!info || !info.model) info = await optional(() => c.call('SYNO.Core.System', 'info', {}, { version: 1 }), parse.systemInfo);
    let admin = true;
    try { await c.call('SYNO.Core.System.Utilization', 'get', {}, { version: 1 }); } catch (e) {
      if (e.code === 'PERMISSION') admin = false;
      else if (dsm.NET_CODES.has(e.code)) throw e;
    }
    return { model: info ? info.model : null, dsm: info ? info.dsm : null, admin, did: r.did };
  } finally {
    await c.logout();
  }
}

/** Reboot or shut down (SYNO.Core.System v1). */
function power(gc, nas, action, { now = Date.now() } = {}) {
  if (action !== 'reboot' && action !== 'shutdown') throw dsm.fail('INVALID');
  return withLock(nas.id, async () => {
    const c = clientFor(gc, nas);
    await c.call('SYNO.Core.System', action, {}, { version: 1 });
    sessions.delete(nas.id); // DSM ends the session with the system
    return store.updateNas(gc, nas.id, { power_state: action, power_at: now, next_poll_at: now + (action === 'reboot' ? 3 : 5) * 60000 });
  });
}

/** Hyper Backup: start a task now (SYNO.Backup.Task v1 backup). */
function startBackup(gc, nas, taskId) {
  return withLock(nas.id, async () => {
    const c = clientFor(gc, nas);
    await c.call('SYNO.Backup.Task', 'backup', { task_id: taskId }, { version: 1 });
    await store.updateNas(gc, nas.id, { next_poll_at: Date.now() + 60000 });
    return true;
  });
}

const UPLOAD_TIMEOUT_MS = 30 * 60000;
const NAME_TRIES = 5;

/** "bericht.pdf", 2 → "bericht (2).pdf" */
function nthName(name, n) {
  if (n <= 1) return name;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

/**
 * 1.2.0 (GateDrop): upload one of the plugin's media files into `dir` on the NAS; a name that exists already
 * becomes "name (2).ext", … → { dir, name } (the name it got). Throws DsmError.
 */
function saveFile(gc, nas, { dir, name, mediaId }) {
  return withLock(nas.id, async () => {
    const c = clientFor(gc, nas);
    for (let n = 1; ; n++) {
      try {
        return await c.upload({ dir, name: nthName(name, n), mediaId, timeoutMs: UPLOAD_TIMEOUT_MS });
      } catch (e) {
        if (e.code !== 'EXISTS' || n >= NAME_TRIES) throw e;
      }
    }
  });
}

module.exports = { poll, test, power, startBackup, saveFile, nthName, collect, backoffMs, dropSession, logoutAll, sessions, UPDATE_EVERY_MS, AUTH_PAUSE_MS, POWER_SETTLE_MS };
