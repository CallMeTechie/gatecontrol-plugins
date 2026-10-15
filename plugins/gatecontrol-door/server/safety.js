'use strict';

// Safety notices (topic door) and the safety net of the automatic unlock
// (topic auto). Pure decisions in evaluate(); the background run sends.
//
//   open too long   door sensor "open" for ≥ N min (per lock, default 5, 0 = off)
//                   → people with `lock` on that lock, once per opening
//   jammed          motor blocked → administrators and people with `lock`, once per jam
//   not reachable   > 10 min → administrators and people with `lock`, once per outage
//   battery         critical → administrators and people with `lock`, at most once per day
//   night check     at the lock's time (default 22:00, off-able), the lock unlocked
//                   → people with `lock`, with the button "Zusperren" (once per night)
//   auto re-lock    an automatic unlock and the door sensor did not report "open" within
//                   3 min → locked again + "wieder zugesperrt"; without a door sensor a push asks
//
// The state of what was announced is kept in gc.storage ('door.alerts'), so a
// restart neither repeats nor forgets anything. Nothing is announced about a
// condition that was already there on the first sighting after an install.

const store = require('./store');
const locks = require('./locks');
const rights = require('./rights');
const history = require('./history');
const push = require('./push');
const notify = require('./notify');
const tz = require('./tz');
const nuki = require('./nuki');
const control = require('./control');

const KEY = 'door.alerts';
const UNREACHABLE_MS = 10 * 60000;
const NIGHT_WINDOW_MIN = 120;
const UNLOCKED = new Set(['unlocked', 'unlatched']);

/**
 * Decide the notices of one lock. prev = the stored alert state of the lock (or null on the first
 * sighting), now, local = tz.local(now). → { next, notices: [{ key, … }] }
 */
function evaluate(prev, lock, now, local) {
  const first = prev == null;
  const p = prev || {};
  const s = lock.state;
  const next = { ...p };
  const notices = [];
  // door open too long
  const openMin = lock.door_sensor ? lock.open_too_long_min : 0;
  if (openMin > 0 && s.door === 'open' && s.doorOpenSince && s.reachable) {
    if (now - s.doorOpenSince >= openMin * 60000 && p.openSince !== s.doorOpenSince) {
      next.openSince = s.doorOpenSince;
      if (!first) notices.push({ key: 'open_long', min: Math.floor((now - s.doorOpenSince) / 60000) });
    }
  }
  // jammed
  if (s.state === 'jammed' && s.jammedSince) {
    if (p.jamSince !== s.jammedSince) {
      next.jamSince = s.jammedSince;
      if (!first) notices.push({ key: 'jammed' });
    }
  }
  // not reachable for > 10 min
  if (!s.reachable && s.unreachableSince && now - s.unreachableSince >= UNREACHABLE_MS) {
    if (p.unreachableSince !== s.unreachableSince) {
      next.unreachableSince = s.unreachableSince;
      if (!first) notices.push({ key: 'unreachable', min: Math.floor((now - s.unreachableSince) / 60000) });
    }
  }
  // battery critical: once per local day
  if (s.reachable && s.batteryCritical && p.batteryDay !== local.date) {
    next.batteryDay = local.date;
    notices.push({ key: 'battery' });
  }
  // night check: within 2 h after the lock's time, once per local day (smart locks only)
  const nc = lock.night_check ? tz.minutesOf(lock.night_check) : null;
  if (nc != null && !nuki.isOpener(lock.device_type) && local.minutes >= nc && local.minutes < nc + NIGHT_WINDOW_MIN && p.nightDay !== local.date) {
    next.nightDay = local.date;
    if (s.reachable && UNLOCKED.has(s.state)) notices.push({ key: 'night', time: lock.night_check });
  }
  return { next, notices };
}

async function admins(gc) {
  try { return (await gc.users.list()).filter((u) => u.role === 'admin').map((u) => u.id); } catch { return []; }
}

/** Evaluate and send the notices for all locks (after a poll). */
async function check(gc, cfg, now) {
  const all = await locks.all(gc);
  if (!all.length) return;
  const stored = (await notify.loadState(gc, KEY)) || {};
  const prevJson = JSON.stringify(stored);
  const local = tz.local(now, cfg.timezone);
  const r = await rights.load(gc);
  const adminIds = await admins(gc);
  const next = {};
  const lang = cfg.notifyLang;
  for (const lock of all) {
    const { next: n, notices } = evaluate(stored[lock.id] || null, lock, now, local);
    next[lock.id] = n;
    const lockUsers = rights.usersWith(r, lock.id, 'lock');
    for (const x of notices) {
      const name = lock.name;
      const base = { topic: 'door', priority: 'normal', collapseKey: `door:${lock.id}:${x.key}`, data: { door: { type: x.key, lockId: lock.id }, actions: [push.viewAction(lang)] } };
      if (x.key === 'open_long') await push.send(gc, { ...base, users: lockUsers, title: push.t(lang, 'door.open_long', { name, min: x.min }) });
      if (x.key === 'jammed') await push.send(gc, { ...base, priority: 'high', users: [...lockUsers, ...adminIds], title: push.t(lang, 'door.jammed', { name }), body: push.t(lang, 'door.jammed_body') });
      if (x.key === 'unreachable') await push.send(gc, { ...base, users: [...lockUsers, ...adminIds], title: push.t(lang, 'door.unreachable', { name }), body: push.t(lang, 'door.unreachable_body', { min: x.min }) });
      if (x.key === 'battery') await push.send(gc, { ...base, users: [...lockUsers, ...adminIds], title: push.t(lang, 'door.battery', { name }), body: push.t(lang, 'door.battery_body') });
      if (x.key === 'night') {
        const actions = lock.actions.includes('lock') ? [push.quickAction(push.t(lang, 'action.lock'), lock.id, 'lock'), push.viewAction(lang)] : [push.viewAction(lang)];
        await push.send(gc, { ...base, users: lockUsers, title: push.t(lang, 'door.night', { name }), body: push.t(lang, 'door.night_body', { time: x.time }), data: { door: { type: 'night', lockId: lock.id }, actions } });
      }
      if (x.key !== 'battery') await store.tx(gc, () => history.add(gc, { at: now, kind: 'alert', lockId: lock.id, via: 'system', action: x.key, result: 'ok' }));
    }
  }
  await notify.saveState(gc, KEY, next, prevJson);
}

/** Locks with an automatic unlock waiting (poll them every 10 s). → Set of source keys */
async function pendingSources(gc) {
  const rows = await store.all(gc, "SELECT DISTINCT lock_id FROM auto_runs WHERE status = 'pending'");
  const out = new Set();
  for (const r of rows) {
    const l = await locks.get(gc, r.lock_id);
    if (l) out.add(locks.sourceKey(l));
  }
  return out;
}

/**
 * The safety net after an automatic unlock: door opened → done; locked by someone → done;
 * 3 min without "open" → with a door sensor lock again (via 'system'), without one ask by push.
 */
async function autoRelock(gc, cfg, now, t) {
  const rows = await store.all(gc, "SELECT id, lock_id, user_id, at FROM auto_runs WHERE status = 'pending' ORDER BY at");
  const lang = cfg.notifyLang;
  for (const run of rows) {
    const lock = await locks.get(gc, run.lock_id);
    const setStatus = (status) => store.tx(gc, () => store.run(gc, 'UPDATE auto_runs SET status = ?, closed_at = ? WHERE id = ?', [status, now, run.id]));
    if (!lock) { await setStatus('gone'); continue; }
    const s = lock.state;
    if (lock.door_sensor && s.doorOpenSince && s.doorOpenSince >= run.at - 1000) { await setStatus('opened'); continue; }
    // locked by someone (a poll at least 20 s after the unlock — the bridge's cached state lags behind)
    if (s.state === 'locked' && s.updatedAt && s.updatedAt > run.at + 20000) { await setStatus('locked'); continue; }
    if (now - run.at < control.RELOCK_AFTER_MS) continue;
    const users = [run.user_id];
    if (!lock.door_sensor) {
      await setStatus('asked');
      await push.send(gc, {
        topic: 'auto', priority: 'normal', users, collapseKey: `auto:${lock.id}`,
        title: push.t(lang, 'auto.ask', { name: lock.name }), body: push.t(lang, 'auto.ask_body'),
        data: { door: { type: 'auto_ask', lockId: lock.id }, actions: [push.quickAction(push.t(lang, 'action.lock'), lock.id, 'lock'), push.viewAction(lang)] },
      });
      continue;
    }
    let ok = false;
    let reason = null;
    try {
      if (!lock.actions.includes('lock')) throw Object.assign(new Error('unsupported'), { code: 'unsupported' });
      await locks.execute(gc, lock, 'lock');
      ok = true;
    } catch (e) {
      reason = (e && e.code) || 'lock_failed';
    }
    await setStatus(ok ? 'relocked' : 'relock_failed');
    await store.tx(gc, () => history.add(gc, { at: now, kind: 'action', lockId: lock.id, userId: run.user_id, via: 'system', action: 'lock', result: ok ? 'ok' : 'failed', reason: ok ? 'auto_relock' : reason }));
    if (ok) {
      await store.tx(gc, () => locks.assumeAfter(gc, lock, 'lock', now));
      locks.pollSoon(lock, now + 5000);
    } else gc.log.warn('automatic re-lock failed', lock.id, reason);
    await push.send(gc, {
      topic: 'auto', priority: ok ? 'normal' : 'high', users, collapseKey: `auto:${lock.id}`,
      title: push.t(lang, ok ? 'auto.relocked' : 'auto.relock_failed', { name: lock.name }), body: push.t(lang, ok ? 'auto.relocked_body' : 'auto.relock_failed_body'),
      data: { door: { type: ok ? 'auto_relocked' : 'auto_relock_failed', lockId: lock.id }, actions: [push.viewAction(lang)] },
    });
    if (!ok && t) gc.log.info('re-lock reason', t('de', 'reason.' + reason));
  }
}

module.exports = { KEY, evaluate, check, autoRelock, pendingSources, UNREACHABLE_MS };
