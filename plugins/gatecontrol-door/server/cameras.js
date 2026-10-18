'use strict';

// Ring doorbells and cameras: device sync, the event poll (dings and motion
// without push receiving — see server/ring.js), pictures and the doorbell
// pushes. If Ring breaks, only this part stops: the status says "Ring-
// Verbindung gestört", administrators get one push per day at most, Nuki
// keeps working.
//
// Expected delay of a doorbell push: the poll runs every 5 s (dings/active),
// the catch-up every 30 s (location events) — about 5–15 s after the ring,
// plus the picture (up to ~8 s; without a picture when Ring has none in
// time). Back-off on errors: 5 s, 10 s, 20 s … 5 min; a 429 waits for
// Retry-After (at least 60 s).
//
// 1.3.0: a ring also goes into the Messenger's family chat as a card with the
// picture and „Tür öffnen“ (server/chat.js; setting familyChat, default on) —
// after the pushes, whether or not anybody got one.
//
// 1.4.0 — rings that never reached the chat (a ring that rang the chime but left no card):
//   * Ring has restricted dings/active for many accounts (it answers an empty list or an error);
//     an error there used to fail the whole poll, so the location events — the only source then —
//     were never read and the status said "Ring-Verbindung gestört". Now dings/active is optional:
//     an error (or a 429) switches it off for 10 minutes (Retry-After when longer) and the location
//     events are read every 15 s instead of 30 s meanwhile; a login problem still fails the poll.
//   * A ring that only shows up in the location events arrives late (Ring lists it after a delay,
//     plus up to 30 s poll interval, plus any back-off): it was dropped once older than 2 minutes —
//     and remembered as seen, so it was lost for good. Rings are now taken up to 10 minutes after
//     they happened (history, chat card); the push only up to 5 minutes (a later push could make
//     somebody open the door for nobody). Motion keeps the 2 minutes. The history's ext_id keeps
//     every ring once, across restarts too.
//   * Diagnosis (gc.storage 'door.ringdiag', admin page „Einstellungen“ and GET /me doorbell):
//     the last ring seen — when it rang, when the plugin saw it, where (dings/active or the
//     location events) and what became of it — and how dings/active answers.

const store = require('./store');
const ring = require('./ring');
const rights = require('./rights');
const history = require('./history');
const push = require('./push');
const notify = require('./notify');
const modes = require('./modes');
const tz = require('./tz');
const chat = require('./chat');
const { fail, rateLimiter } = require('./util');

const STATUS_KEY = 'door.ring';
const EVENTS_EVERY_MS = 30000;
const SYNC_EVERY_MS = 10 * 60000;
const MAX_EVENT_AGE_MS = 2 * 60000;
const DING_MAX_AGE_MS = 10 * 60000;
const DING_PUSH_MAX_AGE_MS = 5 * 60000;
const EVENTS_FAST_MS = 15000;
const ACTIVE_OFF_MS = 10 * 60000;
const DIAG_KEY = 'door.ringdiag';
const BROKEN_AFTER_MS = 2 * 60000;
const IMAGE_MAX = 300 * 1024;
const BACKOFF_MAX_MS = 5 * 60000;

const mem = {
  backoffUntil: 0, failures: 0, lastEvents: 0, lastSync: 0, seen: new Set(), motionLast: new Map(),
  refreshCam: rateLimiter(1, 15000), refreshUser: rateLimiter(6, 60000), latestCam: rateLimiter(1, 30000),
  activeOffUntil: 0, activeState: null,
};
function reset() {
  mem.backoffUntil = 0; mem.failures = 0; mem.lastEvents = 0; mem.lastSync = 0; mem.seen.clear(); mem.motionLast.clear();
  mem.refreshCam.reset(); mem.refreshUser.reset(); mem.latestCam.reset();
  mem.activeOffUntil = 0; mem.activeState = null;
}

function remember(id) {
  mem.seen.add(id);
  if (mem.seen.size > 2000) mem.seen.delete(mem.seen.values().next().value);
}

/** JPEG width/height from its SOF marker, or null. */
function jpegSize(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  for (let i = 2; i + 9 < buf.length;) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xff) { i++; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    if (marker === 0xd9 || marker === 0xda) return null;
    i += 2 + len;
  }
  return null;
}

/** A picture GateControl accepts on a push and the app shows: JPEG ≤ 300 KB, each side 32…2560 px. */
function usableImage(buf) {
  if (!buf || buf.length > IMAGE_MAX) return false;
  const s = jpegSize(buf);
  return !!s && [s.width, s.height].every((x) => x >= 32 && x <= 2560);
}

// ─── status ────────────────────────────────────

async function loadStatus(gc) {
  return (await notify.loadState(gc, STATUS_KEY)) || { state: 'off', since: null, code: null, lastOk: null, pushDay: null };
}

async function saveStatus(gc, s) {
  try { await gc.storage.set(STATUS_KEY, s); } catch { /* best effort */ }
}

/** → { connected, state: 'off'|'ok'|'error'|'login', broken, since, code, lastOk } (ISO times by the caller) */
async function status(gc, now = Date.now()) {
  const s = await loadStatus(gc);
  const connected = await ring.hasToken(gc);
  const state = connected ? (s.state === 'off' ? 'ok' : s.state) : (s.state === 'login' ? 'login' : 'off');
  const broken = state === 'login' || (state === 'error' && s.since != null && now - s.since >= BROKEN_AFTER_MS);
  return { connected, state, broken, since: s.since, code: s.code, lastOk: s.lastOk };
}

async function onOk(gc, now) {
  mem.failures = 0;
  mem.backoffUntil = 0;
  const s = await loadStatus(gc);
  if (s.state !== 'ok' || !s.lastOk || now - s.lastOk > 60000) await saveStatus(gc, { ...s, state: 'ok', since: null, code: null, lastOk: now });
}

async function onError(gc, cfg, e, now) {
  const code = (e && e.code) || 'ring_error';
  const s = await loadStatus(gc);
  const login = code === 'ring_login_failed' || code === 'ring_not_connected';
  if (code === 'ring_rate_limited') mem.backoffUntil = now + Math.max(60, (e.extra && e.extra.retryAfter) || 60) * 1000;
  else {
    mem.failures = Math.min(mem.failures + 1, 10);
    mem.backoffUntil = now + Math.min(BACKOFF_MAX_MS, 5000 * 2 ** (mem.failures - 1));
  }
  const next = { ...s, state: login ? 'login' : 'error', since: s.state === 'error' || s.state === 'login' ? s.since || now : now, code };
  if (login) await ring.logout(gc).catch(() => {});
  const broken = login || now - next.since >= BROKEN_AFTER_MS;
  const day = tz.local(now, cfg.timezone).date;
  if (broken && next.pushDay !== day) {
    next.pushDay = day;
    gc.log.warn('Ring connection broken', code);
    let admins = [];
    try { admins = (await gc.users.list()).filter((u) => u.role === 'admin').map((u) => u.id); } catch { admins = []; }
    await push.send(gc, {
      topic: 'door', priority: 'normal', users: admins, collapseKey: 'ring:broken',
      title: push.t(cfg.notifyLang, 'ring.broken'), body: push.t(cfg.notifyLang, 'ring.broken_body'), data: { door: { type: 'ring_broken' } },
    });
  }
  await saveStatus(gc, next);
}

/** Mark the connection as fresh after a login (the wizard). */
async function loggedIn(gc, now) {
  mem.failures = 0; mem.backoffUntil = 0; mem.lastSync = 0; mem.lastEvents = 0; mem.activeOffUntil = 0; mem.activeState = null;
  const s = await loadStatus(gc);
  await saveStatus(gc, { ...s, state: 'ok', since: null, code: null, lastOk: now });
}

async function loggedOut(gc) {
  const s = await loadStatus(gc);
  await saveStatus(gc, { ...s, state: 'off', since: null, code: null });
}

// ─── devices ───────────────────────────────────

async function all(gc) {
  return store.all(gc, 'SELECT * FROM cameras ORDER BY present DESC, name, id');
}

async function get(gc, id) {
  return store.one(gc, 'SELECT * FROM cameras WHERE id = ?', [id]);
}

/**
 * Device list from Ring → cameras table (new ones enabled, missing ones present = 0), then the
 * locations and their modes (server/modes.js; a failure there never fails the device sync).
 */
async function sync(gc, now) {
  const inv = await ring.inventory(gc);
  const list = inv.devices;
  await store.tx(gc, async () => {
    await store.run(gc, 'UPDATE cameras SET present = 0');
    for (const d of list) {
      await store.run(gc, `INSERT INTO cameras (ring_id, name, kind, doorbell, location_id, battery, online, present, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(ring_id) DO UPDATE SET kind = excluded.kind, doorbell = excluded.doorbell, location_id = excluded.location_id,
        battery = excluded.battery, online = excluded.online, present = 1, updated_at = excluded.updated_at`,
      [d.ringId, d.name, d.kind, d.doorbell ? 1 : 0, d.locationId, d.battery, d.online ? 1 : 0, now]);
    }
  });
  mem.lastSync = now;
  try { await modes.syncLocations(gc, inv, now); } catch (e) { gc.log.warn('ring locations failed', (e && e.code) || (e && e.message) || 'error'); }
  return list.length;
}

/** Is the doorbell poll backing off (errors, 429)? The mode poll waits then too. */
function blocked(now = Date.now()) {
  return now < mem.backoffUntil;
}

// ─── events ────────────────────────────────────

async function prefsOf(gc, cameraId) {
  const m = new Map();
  for (const p of await store.all(gc, 'SELECT user_id, ding, motion FROM camera_prefs WHERE camera_id = ?', [cameraId])) m.set(p.user_id, { ding: p.ding === 1, motion: p.motion === 1 });
  return m;
}

async function grabPicture(gc, cfg, camera, afterMs, now) {
  let buf = null;
  try { buf = await ring.nextSnapshot(gc, camera.ring_id, { afterMs, maxWaitMs: 6000, force: true }); } catch { buf = null; }
  if (!usableImage(buf)) {
    try { buf = await ring.latestSnapshot(gc, camera.ring_id); } catch { buf = null; }
  }
  if (!usableImage(buf)) return null;
  const id = await store.tx(gc, () => history.addMedia(gc, camera.id, buf, 'image/jpeg', now, cfg.mediaDays));
  return { id, buf };
}

/**
 * One ding / motion event (already de-duplicated by the caller's id check and the history's ext_id).
 * opts.push false: history, picture and chat card, no push (a ring seen late). opts.out (an object) gets
 * `outcome`: 'handled' | 'no_camera' (unknown or switched off here) | 'duplicate' (in the history already)
 * and, for a ring, `chat` (server/chat.js ring()).
 */
async function handleEvent(gc, cfg, ev, now, opts = {}) {
  const out = opts.out || {};
  const camera = await store.one(gc, 'SELECT * FROM cameras WHERE ring_id = ? AND enabled = 1', [ev.ringId]);
  if (!camera) { out.outcome = 'no_camera'; return null; }
  out.camera = camera.name;
  const lock = camera.lock_id ? await store.one(gc, 'SELECT id, name, actions, device_type FROM locks WHERE id = ?', [camera.lock_id]) : null;
  const hid = await store.tx(gc, () => history.add(gc, { at: ev.at, kind: ev.kind, cameraId: camera.id, lockId: lock ? lock.id : null, via: 'ring', result: 'ok', extId: `ring:${ev.id}` }));
  if (!hid) { out.outcome = 'duplicate'; return null; }
  out.outcome = 'handled';
  const r = await rights.load(gc);
  const prefs = await prefsOf(gc, camera.id);
  const viewers = lock ? rights.usersWith(r, lock.id, 'view') : [];
  let users;
  if (ev.kind === 'ding') users = viewers.filter((u) => !prefs.has(u) || prefs.get(u).ding);
  else {
    users = viewers.filter((u) => prefs.has(u) && prefs.get(u).motion);
    const last = mem.motionLast.get(camera.id) || 0;
    if (now - last < cfg.motionGapMin * 60000) users = [];
    if (users.length) mem.motionLast.set(camera.id, now);
  }
  // the picture: always for a ring, for motion only when somebody gets the push
  const pic = ev.kind === 'ding' || users.length ? await grabPicture(gc, cfg, camera, ev.at - 2000, now) : null;
  if (pic) await store.tx(gc, () => history.setMedia(gc, hid, pic.id));
  const local = tz.local(ev.at, cfg.timezone);
  const time = `${String(Math.floor(local.minutes / 60)).padStart(2, '0')}:${String(local.minutes % 60).padStart(2, '0')}`;
  if (users.length && opts.push !== false) await pushEvent(gc, cfg, { ev, camera, lock, users, r, pic, hid, time });
  // 1.3.0: the ring as a card in the family chat (never throws); 1.4.0: without the group „Familie“ to
  // the people who get the ring's push (their own channel „Tür & Kamera“)
  if (ev.kind === 'ding') out.chat = await chat.ring(gc, cfg, { camera, lock, time, image: pic ? pic.buf : null, people: users });
  return hid;
}

// ─── diagnosis (1.4.0) ─────────────────────────

/** The stored diagnosis → { lastDing: { at, seenAt, source, camera, outcome, pushed } | null, active } */
async function loadDiag(gc) {
  let d = null;
  try { d = await gc.storage.get(DIAG_KEY); } catch { d = null; }
  return d && typeof d === 'object' ? d : { lastDing: null, active: null };
}

async function saveDiag(gc, patch) {
  try { await gc.storage.set(DIAG_KEY, { ...(await loadDiag(gc)), ...patch }); } catch { /* best effort */ }
}

/** How dings/active answered: { state: 'ok'|'off', code, since, offUntil } — stored only when it changes. */
async function noteActive(gc, state, code, now) {
  if (mem.activeState === `${state}:${code || ''}`) return;
  mem.activeState = `${state}:${code || ''}`;
  await saveDiag(gc, { active: { state, code: code || null, since: now, offUntil: state === 'off' ? mem.activeOffUntil : null } });
}

/** For the admin page and GET /me: ISO times; outcome / chat codes as stored. */
async function diagnosis(gc) {
  const d = await loadDiag(gc);
  const isoOf = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
  const l = d.lastDing && typeof d.lastDing === 'object' ? d.lastDing : null;
  const a = d.active && typeof d.active === 'object' ? d.active : null;
  return {
    lastDing: l ? {
      at: isoOf(l.at), seenAt: isoOf(l.seenAt), delayS: Number.isFinite(l.at) && Number.isFinite(l.seenAt) ? Math.max(0, Math.round((l.seenAt - l.at) / 1000)) : null,
      source: l.source === 'active' ? 'active' : 'events', camera: typeof l.camera === 'string' ? l.camera : null, outcome: typeof l.outcome === 'string' ? l.outcome : null,
      pushed: l.pushed === true,
    } : null,
    active: a ? { state: a.state === 'off' ? 'off' : 'ok', code: typeof a.code === 'string' ? a.code : null, since: isoOf(a.since), offUntil: isoOf(a.offUntil) } : null,
  };
}

/** The pushes of one event (doorbell / motion) to `users`. */
async function pushEvent(gc, cfg, { ev, camera, lock, users, r, pic, hid, time }) {
  const lang = cfg.notifyLang;
  const image = pic ? { data: pic.buf.toString('base64'), mime: 'image/jpeg' } : undefined;
  const door = { type: ev.kind, eventId: hid, cameraId: camera.id, lockId: lock ? lock.id : null };
  const base = {
    topic: ev.kind === 'ding' ? 'doorbell' : 'motion', priority: ev.kind === 'ding' ? 'high' : 'normal', collapseKey: `ring:${camera.id}`, ttl: 3600, image,
    title: ev.kind === 'ding' ? push.t(lang, 'ding.title', { name: lock ? lock.name : camera.name }) : push.t(lang, 'motion.title', { camera: camera.name }),
    body: ev.kind === 'ding' ? push.t(lang, 'ding.body', { camera: camera.name, time }) : push.t(lang, 'motion.body', { time }),
  };
  const canOpen = lock && JSON.parse(lock.actions || '[]').includes('open');
  const openers = canOpen ? users.filter((u) => rights.atLeast(rights.levelOf(r, u, lock.id), 'open')) : [];
  const others = users.filter((u) => !openers.includes(u));
  if (openers.length) {
    const label = push.t(lang, Number(lock.device_type) === 2 ? 'action.buzz' : 'action.open');
    await push.send(gc, { ...base, users: openers, data: { door, actions: [push.quickAction(label, lock.id, 'open', { confirm: true, auth: 'device' }), push.viewAction(lang)] } });
  }
  if (others.length) await push.send(gc, { ...base, users: others, data: { door, actions: [push.viewAction(lang)] } });
}

/**
 * dings/active, optional (1.4.0): Ring has restricted it — an error or a 429 there switches it off for
 * 10 minutes (Retry-After when longer) instead of failing the poll; a login problem fails it as before.
 */
async function pollActive(gc, now) {
  if (now < mem.activeOffUntil) return [];
  try {
    const list = await ring.activeDings(gc);
    await noteActive(gc, 'ok', null, now);
    return list.map((e) => ({ ...e, source: 'active' }));
  } catch (e) {
    const code = (e && e.code) || 'ring_error';
    if (code === 'ring_login_failed' || code === 'ring_not_connected') throw e;
    const wait = code === 'ring_rate_limited' ? Math.max(ACTIVE_OFF_MS, ((e.extra && e.extra.retryAfter) || 60) * 1000) : ACTIVE_OFF_MS;
    mem.activeOffUntil = now + wait;
    gc.log.info('ring dings/active not usable — location events only', code);
    await noteActive(gc, 'off', code, now);
    return [];
  }
}

/** The background part of Ring: device sync, events, back-off, status. */
async function tick(gc, cfg, now) {
  if (!cfg.ring) return;
  if (!(await ring.hasToken(gc))) return;
  if (now < mem.backoffUntil) return;
  try {
    if (!mem.lastSync || now - mem.lastSync >= SYNC_EVERY_MS) await sync(gc, now);
    const cams = await store.all(gc, 'SELECT ring_id, location_id FROM cameras WHERE enabled = 1 AND present = 1');
    if (!cams.length) { await onOk(gc, now); return; }
    const events = await pollActive(gc, now);
    // the catch-up every 30 s — every 15 s while dings/active is off (the only source then)
    const every = now < mem.activeOffUntil ? EVENTS_FAST_MS : EVENTS_EVERY_MS;
    if (!mem.lastEvents || now - mem.lastEvents >= every) {
      mem.lastEvents = now;
      for (const loc of [...new Set(cams.map((c) => c.location_id).filter(Boolean))]) {
        for (const e of await ring.locationEvents(gc, loc, 20)) events.push({ ...e, source: 'events' });
      }
    }
    await onOk(gc, now);
    for (const ev of events.sort((a, b) => a.at - b.at)) {
      if (mem.seen.has(ev.id)) continue;
      remember(ev.id);
      const age = now - ev.at;
      const ding = ev.kind === 'ding';
      if (age > (ding ? DING_MAX_AGE_MS : MAX_EVENT_AGE_MS)) {
        if (ding) await saveDiag(gc, { lastDing: { at: ev.at, seenAt: now, source: ev.source, camera: null, outcome: 'too_old', pushed: false } });
        continue;
      }
      const out = {};
      const push = !ding || age <= DING_PUSH_MAX_AGE_MS;
      try { await handleEvent(gc, cfg, ev, now, { push, out }); } catch (e) {
        out.outcome = 'failed';
        gc.log.warn('ring event failed', (e && e.code) || (e && e.message) || 'error');
      }
      if (ding && out.outcome !== 'duplicate') {
        await saveDiag(gc, { lastDing: { at: ev.at, seenAt: now, source: ev.source, camera: out.camera || null, outcome: out.outcome || 'failed', pushed: push && out.outcome === 'handled' } });
      }
    }
  } catch (e) {
    await onError(gc, cfg, e, now);
  }
}

// ─── pictures for the API ──────────────────────

/**
 * The picture of a camera for a viewer: the newest stored one, else Ring's latest; refresh asks the
 * camera for a new one (≤ 1 per camera per 15 s, ≤ 6 per person per minute → too_soon).
 * → { cameraId, at, mime, size, data } or throws no_image / ring_not_connected / too_soon
 */
async function snapshot(gc, cfg, camera, { refresh = false, userId = 0 } = {}, now = Date.now()) {
  const connected = await ring.hasToken(gc);
  if (refresh) {
    if (!connected) throw fail('ring_not_connected');
    const ra = Math.max(mem.refreshCam.retryAfter(`c:${camera.id}`, now), mem.refreshUser.retryAfter(`u:${userId}`, now));
    if (ra > 0) throw fail('too_soon', { retryAfter: ra });
    mem.refreshCam.hit(`c:${camera.id}`, now);
    mem.refreshUser.hit(`u:${userId}`, now);
    let buf = null;
    try { buf = await ring.nextSnapshot(gc, camera.ring_id, { afterMs: now - 1000, maxWaitMs: 8000, force: true }); } catch (e) {
      if (e && (e.code === 'ring_login_failed' || e.code === 'ring_not_connected')) throw fail('ring_not_connected');
      buf = null;
    }
    if (usableImage(buf)) {
      const id = await store.tx(gc, () => history.addMedia(gc, camera.id, buf, 'image/jpeg', now, cfg.mediaDays));
      return { id, cameraId: camera.id, at: now, mime: 'image/jpeg', size: buf.length, data: buf.toString('base64') };
    }
  }
  const stored = await history.latestMedia(gc, camera.id, now);
  if (stored) return stored;
  if (connected && mem.latestCam.hit(`c:${camera.id}`, now)) {
    let buf = null;
    try { buf = await ring.latestSnapshot(gc, camera.ring_id); } catch { buf = null; }
    if (usableImage(buf)) {
      const id = await store.tx(gc, () => history.addMedia(gc, camera.id, buf, 'image/jpeg', now, cfg.mediaDays));
      return { id, cameraId: camera.id, at: now, mime: 'image/jpeg', size: buf.length, data: buf.toString('base64') };
    }
  }
  throw fail('no_image');
}

module.exports = {
  STATUS_KEY, MAX_EVENT_AGE_MS, DING_MAX_AGE_MS, DING_PUSH_MAX_AGE_MS, IMAGE_MAX, EVENTS_EVERY_MS, EVENTS_FAST_MS, ACTIVE_OFF_MS, SYNC_EVERY_MS, DIAG_KEY,
  reset, status, loggedIn, loggedOut, all, get, sync, blocked, tick, handleEvent, snapshot, usableImage, jpegSize, prefsOf, diagnosis, _mem: mem,
};
