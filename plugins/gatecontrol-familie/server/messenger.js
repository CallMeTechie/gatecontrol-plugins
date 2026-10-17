'use strict';

// Messenger (1.6.0) — the plugin gatecontrol-messenger (≥ 1.0.0) through
// GateControl's services between plugins (GateControl ≥ 1.177.0,
// gc.services.call, plugin.json permissions.services):
//
//   sync_group   { key: 'family', title, userIds }   the group „Familie“ with exactly the family
//                members (parents and children, never a wall tablet); members cannot leave it or
//                change it in the messenger, they can mute it
//   send_message { conversation: 'family' | 'user:<id>', text, title? }   the rule action
//                „Messenger-Nachricht senden“ (server/presence.js): a message from „GateControl“
//                into the group, or into the person's own read-only channel „Familie“
//
// Optional in every way: without the messenger (not installed, stopped, an older
// GateControl without gc.services) nothing fails — the rule action is not offered,
// the page „Funktionen“ says why, a rule that still has one logs `unavailable`.
//
// The family group (admin switch on „Funktionen“, gc.settings messenger_group, default on)
// is kept in step by the background run: when the members (or the title, which follows
// the notification language) differ from the last sync, right after a member change on
// the admin pages, once after every start, and every 6 hours to heal (e.g. a reinstalled
// messenger). sync_group is idempotent. Switched off, Familie stops syncing — the
// messenger has no service to hand a managed group back, so the group stays as it is.
//
// Availability: the host refuses calls to a messenger that is missing or stopped
// (ERR_SERVICE_UNAVAILABLE) before counting them, so retrying costs nothing; such a
// retry runs every 5 minutes. With the group switched off, availability is found out
// by a deliberately empty send_message (the messenger answers `invalid` and notes it in
// its own log) — only while it is unknown or unavailable, and every 6 hours.
//
// Budget: the host allows 60 service calls per hour and calling plugin — the sync uses a
// few per day; a rule action one per run (group) or one per person.
//
// State (gc.storage 'messenger'): { available: true|false|null, reason, checkedAt,
// sync: { at, ok, hash, conversationId, members, added, removed, ignored, error } | null }

const PLUGIN = 'gatecontrol-messenger';
const KEY = 'family';
const STORE_KEY = 'messenger';
const SETTING = 'messenger_group';
const TITLE = { de: 'Familie', en: 'Family' };
const HEAL_MS = 6 * 3600000;
const RETRY_UNAVAILABLE_MS = 5 * 60000;
const RETRY_FAILED_MS = 15 * 60000;
const TEXT_MAX = 500;
const PEOPLE_MAX = 20;

const proc = { started: false, running: null };

/** Does this GateControl offer gc.services (≥ 1.177.0)? */
const hasApi = (gc) => !!(gc && gc.services && typeof gc.services.call === 'function');

const groupTitle = (cfg) => TITLE[cfg && cfg.lang === 'en' ? 'en' : 'de'];

async function loadState(gc) {
  let v = null;
  try { v = await gc.storage.get(STORE_KEY); } catch { /* no storage */ }
  const s = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  return {
    available: typeof s.available === 'boolean' ? s.available : null,
    reason: typeof s.reason === 'string' ? s.reason : null,
    checkedAt: Number.isFinite(s.checkedAt) ? s.checkedAt : null,
    sync: s.sync && typeof s.sync === 'object' ? s.sync : null,
  };
}

async function saveState(gc, s) {
  try { await gc.storage.set(STORE_KEY, s); } catch (e) { gc.log.warn('messenger state not saved', (e && e.code) || (e && e.message)); }
}

/** A host or messenger refusal → our code. */
function codeOf(e) {
  const c = e && e.code;
  if (c === 'ERR_SERVICE_UNAVAILABLE' || c === 'ERR_SERVICES_DENIED') return 'unavailable';
  if (c === 'ERR_RATE_LIMIT') return 'rate_limit';
  if (c === 'ERR_TIMEOUT') return 'timeout';
  if (c === 'ERR_INVALID') return 'invalid';
  return 'failed';
}

/**
 * One service call → { ok: true, result } | { ok: false, code, answered }. `answered`: the messenger
 * itself answered (it is there), else the host refused or the call failed.
 */
async function call(gc, service, payload) {
  if (!hasApi(gc)) return { ok: false, code: 'unavailable', answered: false, noApi: true };
  try {
    const r = await gc.services.call({ plugin: PLUGIN, service, payload });
    if (r && r.ok === true) return { ok: true, result: r, answered: true };
    const code = r && typeof r.code === 'string' && /^[a-z_]{1,32}$/.test(r.code) ? r.code : 'failed';
    return { ok: false, code, answered: true };
  } catch (e) {
    const code = codeOf(e);
    // a provider that threw or timed out is there, but broken — not "unavailable"
    return { ok: false, code, answered: code === 'failed' || code === 'timeout' };
  }
}

/** Remember what a call told about availability; logs the change once. */
async function note(gc, res, now, st) {
  const s = st || await loadState(gc);
  let next = s.available;
  let reason = s.reason;
  if (res.ok || res.answered) { next = true; reason = null; } else if (res.code === 'unavailable') { next = false; reason = res.noApi ? 'no_api' : 'not_running'; }
  if (next !== s.available) gc.log.info(next ? 'messenger available' : 'messenger not available', reason || '');
  s.available = next;
  s.reason = reason;
  s.checkedAt = now;
  return s;
}

/** The members of the group: the family without wall tablets, sorted. */
const wanted = (fam) => fam.list.map((m) => m.userId).sort((a, b) => a - b);
const hashOf = (title, ids) => `${title}|${ids.join(',')}`;

/**
 * Sync the group now (o.force) or when due. Never throws; serialised in this process.
 * → the saved state.
 */
function sync(gc, fam, cfg, now, o = {}) {
  const run = async () => {
    const s = await loadState(gc);
    if (!cfg.messengerGroup) return s;
    if (!hasApi(gc)) {
      if (s.available !== false || s.reason !== 'no_api') { await note(gc, { ok: false, code: 'unavailable', noApi: true }, now, s); await saveState(gc, s); }
      return s;
    }
    const title = groupTitle(cfg);
    const ids = wanted(fam);
    const hash = hashOf(title, ids);
    const last = s.sync;
    // nobody to put in and no group yet: nothing to create
    if (!ids.length && !(last && last.conversationId)) return s;
    if (!o.force) {
      const since = last ? now - last.at : Infinity;
      // a rule run may have found the messenger gone: look again like a failed sync would
      const checkedAgo = s.checkedAt == null ? Infinity : now - s.checkedAt;
      let due = !last || last.hash !== hash || since >= HEAL_MS || !proc.started || (s.available === false && checkedAgo >= RETRY_UNAVAILABLE_MS);
      if (last && !last.ok) {
        due = !proc.started || since >= (last.error === 'unavailable' ? RETRY_UNAVAILABLE_MS : RETRY_FAILED_MS)
          || (last.hash !== hash && last.error !== 'rate_limit');
      }
      if (!due) return s;
    }
    const res = await call(gc, 'sync_group', { key: KEY, title, userIds: ids });
    await note(gc, res, now, s);
    if (res.ok) {
      const r = res.result;
      const list = (v) => (Array.isArray(v) ? v.filter((x) => Number.isSafeInteger(x)) : []);
      s.sync = {
        at: now, ok: true, hash, conversationId: Number.isSafeInteger(r.conversationId) ? r.conversationId : null, members: ids.length,
        added: list(r.added), removed: list(r.removed), ignored: list(r.ignored), error: null,
      };
      if (r.created || s.sync.added.length || s.sync.removed.length) gc.log.info('messenger group synced', s.sync.conversationId, `+${s.sync.added.length}`, `-${s.sync.removed.length}`);
    } else {
      s.sync = { ...(last || {}), at: now, ok: false, hash, error: res.code };
      if (res.code !== 'unavailable') gc.log.warn('messenger group sync failed', res.code);
    }
    await saveState(gc, s);
    return s;
  };
  const p = (proc.running || Promise.resolve()).then(run, run).catch((e) => {
    gc.log.warn('messenger sync failed', (e && (e.code || e.message)) || 'error');
    return loadState(gc);
  });
  proc.running = p;
  return p;
}

/**
 * Background (every minute, outside any transaction): the group sync, or — with the group
 * switched off — the availability check (see the head of this file).
 */
async function tick(gc, fam, cfg, now) {
  try {
    if (cfg.messengerGroup) await sync(gc, fam, cfg, now);
    else {
      const s = await loadState(gc);
      if (!hasApi(gc)) {
        if (s.available !== false || s.reason !== 'no_api') { await note(gc, { ok: false, code: 'unavailable', noApi: true }, now, s); await saveState(gc, s); }
      } else {
        const since = s.checkedAt == null ? Infinity : now - s.checkedAt;
        const due = !proc.started || s.available == null || (s.available === false ? since >= RETRY_UNAVAILABLE_MS : since >= HEAL_MS);
        if (due) {
          const res = await call(gc, 'send_message', {});
          await note(gc, res, now, s);
          await saveState(gc, s);
        }
      }
    }
  } catch (e) {
    gc.log.warn('messenger tick failed', (e && (e.code || e.message)) || 'error');
  }
  proc.started = true;
}

/** After a plugin start: the first tick syncs (or checks) at once. */
function reset() {
  proc.started = false;
  proc.running = null;
}

/** What the pages need: { api, available, reason, group, title, sync, checkedAt } (no service call). */
async function info(gc, cfg) {
  const s = await loadState(gc);
  const api = hasApi(gc);
  const sync2 = s.sync ? {
    at: Number.isFinite(s.sync.at) ? new Date(s.sync.at).toISOString() : null, ok: !!s.sync.ok, error: s.sync.error || null,
    members: Number.isSafeInteger(s.sync.members) ? s.sync.members : null, conversationId: s.sync.conversationId || null,
    ignored: Array.isArray(s.sync.ignored) ? s.sync.ignored : [],
  } : null;
  return {
    api, available: api ? s.available : false, reason: api ? s.reason : 'no_api', group: !!cfg.messengerGroup, title: groupTitle(cfg),
    sync: sync2, checkedAt: s.checkedAt == null ? null : new Date(s.checkedAt).toISOString(),
  };
}

/** Switch the group on or off (admin, page „Funktionen“). */
async function setGroup(gc, on) {
  await gc.settings.set(SETTING, !!on);
}

// ─── the rule action ───────────────────────────────

/**
 * Run one rule action { type: 'messenger', to: 'family' | [userId], text } with the final text
 * (placeholders already replaced) → a result for the rule log:
 * { type, to, ok, sent, error }. Never throws.
 */
async function sendAction(gc, fam, cfg, now, action, text, triggerUser) {
  const to = action.to === 'family' ? 'family' : (Array.isArray(action.to) ? action.to : []);
  const base = { type: 'messenger', to: to === 'family' ? 'family' : to.slice() };
  const body = String(text || '').slice(0, TEXT_MAX);
  if (!hasApi(gc)) return { ...base, ok: false, sent: 0, error: 'unavailable' };
  const finish = async (res) => { const st = await loadState(gc); await note(gc, res, now, st); await saveState(gc, st); };
  if (to === 'family') {
    if (!cfg.messengerGroup) return { ...base, ok: false, sent: 0, error: 'group_off' };
    let res = await call(gc, 'send_message', { conversation: 'family', text: body });
    if (!res.ok && res.code === 'not_found') {
      // the group is not there (yet, or the messenger lost it): sync, then once more
      await sync(gc, fam, cfg, now, { force: true });
      res = await call(gc, 'send_message', { conversation: 'family', text: body });
    }
    await finish(res);
    return { ...base, ok: res.ok, sent: res.ok ? 1 : 0, error: res.ok ? null : res.code };
  }
  // single people: each into the person's own channel „Familie“ (the person who sets the rule off gets none)
  const ids = to.filter((id) => fam.byId.has(id) && id !== triggerUser);
  if (!ids.length) return { ...base, ok: false, sent: 0, error: 'no_recipients' };
  let sent = 0;
  let error = null;
  let told = null; // the answer that tells most about availability: one from the messenger, else the first
  for (const id of ids) {
    const res = await call(gc, 'send_message', { conversation: `user:${id}`, text: body, title: groupTitle(cfg) });
    if (res.ok || res.answered || !told) told = res;
    if (res.ok) sent++;
    else {
      error = error || res.code;
      if (res.code === 'unavailable' || res.code === 'rate_limit') break;
    }
  }
  if (told) await finish(told);
  return { ...base, ok: sent === ids.length, sent, error: sent === ids.length ? null : error };
}

module.exports = {
  PLUGIN, KEY, SETTING, TEXT_MAX, PEOPLE_MAX, HEAL_MS, RETRY_UNAVAILABLE_MS, RETRY_FAILED_MS,
  hasApi, groupTitle, call, sync, tick, reset, info, setGroup, sendAction, loadState, _proc: proc,
};
