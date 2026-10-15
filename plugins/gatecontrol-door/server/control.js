'use strict';

// Running a door action — the one path every action takes (app, portal, a
// notification's button, the app's quick actions, another plugin's
// automation). Checked again on the server every time:
//
//   1. the lock exists and offers the action (admin page: which actions exist)
//   2. the viewer may act at all (never a kiosk device / device-trust portal viewer)
//   3. the right: lock/unlock need `lock`, open (unlatch, opener "Summer") needs `open`
//   4. the person's weekly time window
//   5. at most 10 actions per minute per person
//   6. automation (another plugin's gc.actions.run, user.automation, e.g. the
//      Familie rule "Person kommt heim"): ONLY when all of these hold —
//        action unlock (lock is allowed too; open/unlatch never) · the person's
//        opt-in "automatisch aufsperren" and at least `lock` · the time window ·
//        at most once per 10 min per person and lock · the lock reachable and
//        currently locked (asked fresh; a transitional state that has not ended
//        for 3 min → state_unclear) · the door sensor (if any) closed.
//      Otherwise refused: history row + push (topic auto) "Automatisches
//      Aufsperren abgelehnt: …".
//
// Every run that names an existing lock is written to the history (also a
// refused or failed one). An automatic unlock is followed by the safety net
// (server/safety.js autoRelock): door not opened within 3 min → locked again.

const store = require('./store');
const locks = require('./locks');
const rights = require('./rights');
const history = require('./history');
const push = require('./push');
const nuki = require('./nuki');
const { fail, rateLimiter, clip } = require('./util');

const PER_MINUTE = 10;
const AUTO_GAP_MS = 10 * 60000;
const FRESH_MS = 15000;
const RELOCK_AFTER_MS = 3 * 60000;

const limiter = rateLimiter(PER_MINUTE, 60000);
const autoDone = new Map(); // `${userId}:${lockId}` → ms of the last automatic unlock
function reset() { limiter.reset(); autoDone.clear(); }

/** The verb of an action for messages (opener: "Summer"). */
function verbKey(lock, action) {
  if (action === 'open' && nuki.isOpener(lock.device_type)) return 'buzz';
  return action;
}

/**
 * Run `action` on lock `lockId` for `user`.
 *   ctx = { cfg, t, lang, now, via: 'app'|'portal'|'notification'|'automation', caller (plugin id for automation) }
 * → { ok: true, message, lock } — throws fail(code) when refused or failed (after writing the history).
 */
async function perform(gc, ctx, user, lockId, action) {
  const { cfg, t, now } = ctx;
  const lang = ctx.lang === 'en' ? 'en' : 'de';
  const nlang = cfg.notifyLang;
  const automation = user && user.automation === true;
  const via = automation ? 'automation' : (ctx.via || 'app');
  let lock = await locks.get(gc, lockId);
  if (!lock) throw fail('not_found');
  if (!rights.ACTIONS.includes(action)) throw fail('not_found');
  const r = await rights.load(gc);
  const level = rights.levelOf(r, user.id, lock.id);
  const prefs = rights.prefsOf(r, user.id);

  const record = (result, reason, extra = {}) => store.tx(gc, () => history.add(gc, {
    at: now, kind: 'action', lockId: lock.id, userId: user.id, userName: user.name || null, via, caller: automation ? ctx.caller || user.via || null : null,
    action, result, reason, ...extra,
  }));
  const refuse = async (code, extra) => {
    await record('refused', code);
    if (automation) await pushAutoRefused(gc, cfg, lock, user, code, t);
    throw fail(code, extra);
  };

  // what the lock can do at all; an unknown viewer or no right at all is "not found" for this person
  if (!level) await refuse('no_right');
  if (!lock.actions.includes(action)) await refuse('unsupported');
  if (!rights.canAct(user)) await refuse('read_only');
  if (automation && action === 'open') await refuse('auto_open');
  if (!rights.atLeast(level, rights.NEEDS[action])) await refuse(automation ? 'auto_no_right' : 'no_right');
  if (automation && action === 'unlock' && !prefs.autoUnlock) await refuse('auto_off');
  if (!rights.windowAllows(prefs.window, now, cfg.timezone)) await refuse('outside_window');
  const autoKey = `${user.id}:${lock.id}`;
  if (automation && action === 'unlock' && autoDone.has(autoKey) && now - autoDone.get(autoKey) < AUTO_GAP_MS) await refuse('auto_too_soon');
  if (!limiter.hit(`u:${user.id}`, now)) await refuse('rate_limited', { retryAfter: limiter.retryAfter(`u:${user.id}`, now) });

  if (automation && action === 'unlock') {
    // the state must be fresh: ask the source now when the last poll is older than 15 s
    if (!lock.state.checkedAt || now - lock.state.checkedAt > FRESH_MS) {
      try { await locks.poll(gc, now, { force: true, only: [lock.id] }); } catch { /* refused below */ }
      lock = (await locks.get(gc, lock.id)) || lock;
    }
    if (!lock.state.reachable) await refuse('unreachable');
    // the real (fresh) state only: a transitional state that has not ended for 3 min is unclear —
    // never "locked" because the last stable state was (the display's fallback is not a fact)
    if (locks.displayState(lock, now).stale) await refuse('state_unclear');
    if (lock.state.state !== 'locked') await refuse('not_locked');
    if (lock.door_sensor && lock.state.door !== 'closed') await refuse('door_open');
  }

  try {
    await locks.execute(gc, lock, action);
  } catch (e) {
    const code = (e && e.code) || 'lock_failed';
    await record('failed', code);
    gc.log.warn('lock action failed', lock.id, action, code);
    if (automation) await pushAutoRefused(gc, cfg, lock, user, code === 'lock_unreachable' ? 'unreachable' : 'failed', t);
    throw fail(['lock_unreachable', 'nuki_auth', 'no_target', 'not_configured', 'rate_limited', 'unsupported'].includes(code) ? code : 'lock_failed');
  }
  await record('ok', null);
  await store.tx(gc, () => locks.assumeAfter(gc, lock, action, now));
  locks.pollSoon(lock, now);
  locks.pollSoon(lock, now + 10000);

  if (automation && action === 'unlock') {
    autoDone.set(autoKey, now);
    await store.tx(gc, () => store.run(gc, "INSERT INTO auto_runs (lock_id, user_id, at, status) VALUES (?, ?, ?, 'pending')", [lock.id, user.id, now]));
    const canRelock = lock.actions.includes('lock');
    await push.send(gc, {
      topic: 'auto', priority: 'normal', users: [user.id], collapseKey: `auto:${lock.id}`,
      title: push.t(nlang, 'auto.done', { name: lock.name }), body: push.t(nlang, lock.door_sensor ? 'auto.done_body' : 'auto.done_body_nosensor'),
      data: { door: { type: 'auto_unlocked', lockId: lock.id }, actions: [...(canRelock ? [push.quickAction(push.t(nlang, 'action.relock'), lock.id, 'lock')] : []), push.viewAction(nlang)] },
    });
  }
  const fresh = (await locks.get(gc, lock.id)) || lock;
  return { ok: true, message: clip(t(lang, `done.${verbKey(lock, action)}`, { name: lock.name }), 120), lock: fresh };
}

async function pushAutoRefused(gc, cfg, lock, user, code, t) {
  const nlang = cfg.notifyLang;
  await push.send(gc, {
    topic: 'auto', priority: 'normal', users: [user.id], collapseKey: `auto:${lock.id}`,
    title: push.t(nlang, 'auto.refused', { reason: t(nlang, 'reason.' + code) }), body: push.t(nlang, 'auto.refused_body', { name: lock.name }),
    data: { door: { type: 'auto_refused', lockId: lock.id, reason: code }, actions: [push.viewAction(nlang)] },
  });
}

module.exports = { perform, reset, verbKey, PER_MINUTE, AUTO_GAP_MS, RELOCK_AFTER_MS, FRESH_MS, _autoDone: autoDone };
