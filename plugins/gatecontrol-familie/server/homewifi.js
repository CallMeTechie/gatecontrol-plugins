'use strict';

// 1.17.0 — presence over the home network: the second source next to the app (GateControl ≥ 1.230.0,
// permissions.homePresence → gc.homeNetwork.presence; GateControl's docs/plugins.md "Presence over the home network").
// A home gateway with the network watch sees the phones in the home Wi-Fi; an administrator assigns a device to a
// person there, the PERSON agrees themselves („Über mein Handy im WLAN“) and decides which of their devices count.
// GateControl tells only „at home“ / „away“ per person (never MAC or IP addresses, never which device); „away“ comes
// after 10 minutes without a sign (the gateway's hysteresis).
//
//   GET  presence/wifi                        the caller's own: { wifi: { available, consent, since, devices } } —
//                                             devices [{ id, name, lastSeen, counts, gateway }] | null (not available)
//   PUT  presence/wifi { enabled }            only for oneself (GateControl checks it: a changing request of that very
//                                             person, else 403 not_person) → the same
//   PUT  presence/wifi/devices/<id> { counts }   only one's own device (404 not_found) → the same
//
// Without the API (an older GateControl): available false, devices null, the PUTs 409 unavailable — the app source
// and everything else stay as they are.
//
// The state: presence_wifi mirrors what GateControl says per member (consent, home, since). The hook
// (gc.homeNetwork.presence.on, best-effort, not repeated) brings each change; the background run compares with list()
// every minute (and asks the consent of every member every 10 minutes and whenever a state went away — home: null
// means the consent was withdrawn or the last counting device removed). A change goes through presence.settle(): the
// combined state of both sources, the rules. A change older than 20 minutes (gateway hysteresis + 10 minutes — e.g.
// found after a restart) only updates the state: a late arrival must not open a door.

const store = require('./store');
const config = require('./config');
const members = require('./members');
const tz = require('./tz');
const push = require('./push');
const presence = require('./presence');
const messenger = require('./messenger');
const { fail, bool, posInt, iso, parseIso } = require('./util');

const LATE_MS = 20 * 60000;
const CONSENT_EVERY_MS = 10 * 60000;
const NAME_MAX = 60;
const GATEWAY_MAX = 60;

const state = { consentAt: 0, off: null };

/** gc.homeNetwork.presence, or null (GateControl < 1.230.0 or no permission). */
function api(gc) {
  return presence.wifiAvailable(gc) ? gc.homeNetwork.presence : null;
}

/** GateControl's codes → ours. */
function hostFail(e) {
  const c = e && e.code;
  if (c === 'ERR_NOT_PERSON') return fail('not_person');
  if (c === 'ERR_NOT_FOUND') return fail('not_found');
  if (c === 'ERR_INVALID') return fail('invalid');
  if (c === 'ERR_HOME_PRESENCE_DENIED') return fail('unavailable');
  return e;
}

/** The person's consent in GateControl (false when it cannot be read). */
async function askConsent(P, userId) {
  try { return (await P.consent(userId)).consent === true; } catch { return false; }
}

const msOf = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : parseIso(v));

/**
 * One change for one member — { userId, consent, home: true|false|null, since: ms|null } — into presence_wifi, then the
 * combined state (presence.settle) and „all away“. ctx: { fam, cfg, now, runs, placeStatus }. → whether it changed.
 */
async function apply(gc, ctx, ev) {
  const cur = await store.one(gc, 'SELECT * FROM presence_wifi WHERE user_id = ?', [ev.userId]);
  const home = ev.consent && ev.home != null ? (ev.home ? 1 : 0) : null;
  const since = home == null ? null : (ev.since || ctx.now);
  // an older report than what we have (the hook is not ordered)
  if (home != null && cur && cur.consent && cur.home != null && cur.since != null && since < cur.since) return false;
  if (cur ? (!!cur.consent === !!ev.consent && cur.home === home && (home == null || cur.since === since)) : (!ev.consent && home == null)) return false;
  await store.run(gc, `INSERT INTO presence_wifi (user_id, consent, home, since, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET consent = excluded.consent, home = excluded.home, since = excluded.since, updated_at = excluded.updated_at`,
  [ev.userId, ev.consent ? 1 : 0, home, since, ctx.now]);
  // a change the gateway saw just now runs the rules; one found late only updates the state
  const live = home != null && ctx.now - since <= LATE_MS;
  await presence.settle(gc, ctx, ev.userId, { cause: 'wifi', live });
  if (ctx.cfg.modules.presence) await presence.checkAllAway(gc, ctx.fam, ctx.cfg, ctx.now, ctx.runs);
  return true;
}

/** After the commit: the rules that fired, their notifications, the place in the messenger status. */
async function finish(gc, ctx) {
  if (ctx.runs.length) await presence.execute(gc, ctx.fam, ctx.cfg, ctx.now, ctx.runs, ctx.pushes);
  if (ctx.pushes.length) await push.flush(gc, ctx.pushes);
  if (ctx.placeStatus.length) await messenger.placeStatus(gc, ctx.fam, ctx.now, ctx.placeStatus);
}

async function context(gc) {
  const cfg = await config.load(gc);
  const now = Date.now();
  const fam = await members.load(gc, tz.localDate(now, cfg.tz));
  return { fam, cfg, now, runs: [], pushes: [], placeStatus: [] };
}

/** The hook gc.homeNetwork.presence.on: { userId, home: true|false|null, since, source: 'wifi' } — never throws. */
async function onEvent(gc, ev) {
  try {
    const P = api(gc);
    if (!P || !ev || !Number.isSafeInteger(ev.userId)) return;
    const ctx = await context(gc);
    if (!ctx.fam.byId.has(ev.userId)) return;
    const known = ev.home === true || ev.home === false;
    // null: no longer known — the consent withdrawn, or the last counting device gone
    const consent = known ? true : await askConsent(P, ev.userId);
    await store.tx(gc, () => apply(gc, ctx, { userId: ev.userId, consent, home: known ? ev.home : null, since: known ? msOf(ev.since) : null }));
    await finish(gc, ctx);
  } catch (e) {
    gc.log.warn('home presence event failed', (e && (e.code || e.message)) || 'error');
  }
}

/**
 * Background (every minute while the module presence is on): list() against the mirror; the consent of every member
 * every 10 minutes (and at once after a start) and of anybody whose state went away. Missed hooks are caught up here.
 */
async function sync(gc, fam, cfg, now) {
  const P = api(gc);
  if (!P) return { changed: 0 };
  let list;
  try { list = await P.list(); } catch (e) { gc.log.warn('home presence list failed', (e && (e.code || e.message)) || 'error'); return { changed: 0 }; }
  const known = new Map((Array.isArray(list) ? list : []).filter((x) => x && Number.isSafeInteger(x.userId)).map((x) => [x.userId, x]));
  const rows = new Map((await store.all(gc, 'SELECT * FROM presence_wifi')).map((x) => [x.user_id, x]));
  const askAll = now - state.consentAt >= CONSENT_EVERY_MS;
  if (askAll) state.consentAt = now;
  const changes = [];
  for (const m of fam.list) {
    const k = known.get(m.userId);
    const row = rows.get(m.userId);
    let consent;
    if (k) consent = true;
    else if (askAll || (row && row.home != null)) consent = await askConsent(P, m.userId);
    else consent = !!(row && row.consent);
    const home = k && (k.home === true || k.home === false) ? k.home : null;
    const since = home == null ? null : msOf(k.since);
    const same = row ? (!!row.consent === consent && row.home === (home == null ? null : (home ? 1 : 0)) && (home == null || row.since === since)) : (!consent && home == null);
    if (!same) changes.push({ userId: m.userId, consent, home, since });
  }
  if (!changes.length) return { changed: 0 };
  const ctx = { fam, cfg, now, runs: [], pushes: [], placeStatus: [] };
  let changed = 0;
  await store.tx(gc, async () => { for (const c of changes) if (await apply(gc, ctx, c)) changed++; });
  await finish(gc, ctx);
  return { changed };
}

/** A device as the portal shows it: names and times only (GateControl never hands out addresses). */
function deviceView(d) {
  return {
    id: d.id, name: typeof d.name === 'string' && d.name.trim() ? d.name.trim().slice(0, NAME_MAX) : null,
    lastSeen: iso(msOf(d.lastSeen)), counts: d.counts === true,
    gateway: typeof d.gateway === 'string' && d.gateway.trim() ? d.gateway.trim().slice(0, GATEWAY_MAX) : null,
  };
}

/** GET presence/wifi — the caller's own consent and devices. */
async function view(gc, r) {
  const P = api(gc);
  if (!P) return { wifi: { available: false, consent: false, since: null, devices: null } };
  let c = null;
  try { c = await P.consent(r.me.userId); } catch (e) { throw hostFail(e); }
  let devices = null;
  let error = null;
  try {
    const list = await P.devices(r.me.userId);
    devices = (Array.isArray(list) ? list : []).filter((d) => d && Number.isSafeInteger(d.id)).map(deviceView);
  } catch (e) {
    // e.g. a paired kiosk device: GateControl answers only to the person themselves
    error = hostFail(e).code || 'error';
  }
  return { wifi: { available: true, consent: !!(c && c.consent === true), since: (c && c.since) || null, devices, ...(error ? { error } : {}) } };
}

/** PUT presence/wifi { enabled } — „Über mein Handy im WLAN“, only for oneself. */
async function setConsent(gc, r) {
  const P = api(gc);
  if (!P) throw fail('unavailable');
  const enabled = bool((r.body || {}).enabled);
  try { await P.setConsent(r.me.userId, enabled); } catch (e) { throw hostFail(e); }
  // the mirror at once (GateControl's hook follows with the state); switching is no observation: no rule runs for it
  await store.tx(gc, async () => {
    const cur = await store.one(gc, 'SELECT * FROM presence_wifi WHERE user_id = ?', [r.me.userId]);
    if (enabled && cur && cur.consent) return;
    await store.run(gc, `INSERT INTO presence_wifi (user_id, consent, home, since, updated_at) VALUES (?, ?, NULL, NULL, ?)
      ON CONFLICT(user_id) DO UPDATE SET consent = excluded.consent, home = CASE WHEN excluded.consent = 1 THEN presence_wifi.home ELSE NULL END,
      since = CASE WHEN excluded.consent = 1 THEN presence_wifi.since ELSE NULL END, updated_at = excluded.updated_at`, [r.me.userId, enabled ? 1 : 0, r.now]);
    await presence.settle(gc, r, r.me.userId, { cause: 'wifi', live: false });
    if (!enabled && r.cfg.modules.presence) await presence.checkAllAway(gc, r.fam, r.cfg, r.now, r.runs);
  });
  return view(gc, r);
}

/** PUT presence/wifi/devices/<id> { counts } — whether one's own device counts (an iPad that stays at home: no). */
async function setCounts(gc, r, raw) {
  const P = api(gc);
  if (!P) throw fail('unavailable');
  const id = posInt(raw);
  if (!id) throw fail('not_found');
  const counts = bool((r.body || {}).counts);
  try { await P.setCounts(r.me.userId, id, counts); } catch (e) { throw hostFail(e); }
  return view(gc, r);
}

/** start(): the hook; the first background run asks every consent. Never throws. */
function start(gc) {
  state.consentAt = 0;
  if (state.off) { try { state.off(); } catch { /* an earlier gc */ } state.off = null; }
  const P = api(gc);
  if (!P || typeof P.on !== 'function') return false;
  try { state.off = P.on((ev) => onEvent(gc, ev)); } catch (e) { gc.log.warn('home presence hook failed', (e && (e.code || e.message)) || 'error'); return false; }
  return true;
}

module.exports = { LATE_MS, CONSENT_EVERY_MS, start, sync, onEvent, apply, view, setConsent, setCounts, deviceView, context, _state: state };
