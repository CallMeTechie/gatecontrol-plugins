'use strict';

// The API for people (GateControl app tab, portal tab, plugin API). Paths
// relative to the plugin's /api/ (README "App API" has the JSON shapes):
//
//   GET  me                              rights, locks with state, cameras, Ring status
//   POST locks/<id>/<lock|unlock|open>   run an action (checked again: server/control.js)
//   GET  cameras/<id>/snapshot[?refresh=1]   the newest picture (JSON, base64, ≤ 300 KB)
//   PUT  cameras/<id>/prefs { ding?, motion? }   own doorbell / motion pushes for that camera
//   GET  history[?cursor=&limit=&lockId=]    own events; all events of locks with `open`; rings of viewable cameras
//   GET  events/<id>                     one ring / motion event with its picture (push "Ansehen")
//
// Every answer is { ok: true, … } or { ok: false, code, error[, retryAfter] }.
// Who sees what: only locks with a right (view / lock / open) and the cameras
// linked to them. Kiosk devices and portal viewers recognised only by device
// trust read only (403 read_only for every action). Administrators get no
// rights automatically; their history view in the portal shows everything.

const store = require('./store');
const locks = require('./locks');
const rights = require('./rights');
const cameras = require('./cameras');
const history = require('./history');
const control = require('./control');
const views = require('./views');
const { fail, posInt, bool, iso, rateLimiter } = require('./util');

const readLimiter = rateLimiter(60, 60000);

async function context(gc, req, cfg, now, t) {
  const user = req.user;
  if (!user || !Number.isSafeInteger(user.id)) throw fail('forbidden');
  const r = await rights.load(gc);
  const all = await locks.all(gc);
  const mine = all.filter((l) => rights.levelOf(r, user.id, l.id));
  return { user, r, all, mine, prefs: rights.prefsOf(r, user.id), cfg, now, t, lang: req.lang === 'en' ? 'en' : 'de' };
}

function viaOf(user) {
  if (user.app === true) return 'app';
  return 'portal';
}

async function visibleCameras(gc, c) {
  const ids = new Set(c.mine.map((l) => l.id));
  return (await cameras.all(gc)).filter((cam) => cam.enabled === 1 && cam.present === 1 && cam.lock_id && ids.has(cam.lock_id));
}

async function me(gc, c) {
  const cams = await visibleCameras(gc, c);
  const camPrefs = new Map();
  for (const p of await store.all(gc, 'SELECT camera_id, ding, motion FROM camera_prefs WHERE user_id = ?', [c.user.id])) camPrefs.set(p.camera_id, { ding: p.ding === 1, motion: p.motion === 1 });
  const lastAt = new Map();
  for (const m of await store.all(gc, 'SELECT camera_id, MAX(at) AS at FROM media WHERE expires_at > ? GROUP BY camera_id', [c.now])) lastAt.set(m.camera_id, m.at);
  const st = await cameras.status(gc, c.now);
  return {
    me: {
      userId: c.user.id, name: c.user.name || null, canAct: rights.canAct(c.user),
      autoUnlock: c.prefs.autoUnlock, window: c.prefs.window, windowOpen: rights.windowAllows(c.prefs.window, c.now, c.cfg.timezone),
    },
    locks: c.mine.map((l) => views.lockView(l, { level: rights.levelOf(c.r, c.user.id, l.id), user: c.user, prefs: c.prefs, cfg: c.cfg, now: c.now })),
    cameras: cams.map((cam) => views.cameraView(cam, { prefs: camPrefs.get(cam.id), lastImageAt: lastAt.get(cam.id) })),
    ring: { connected: st.connected, broken: st.broken },
    serverTime: iso(c.now),
  };
}

async function action(gc, c, lockId, act) {
  const lock = c.mine.find((l) => l.id === lockId);
  if (!lock || !['lock', 'unlock', 'open'].includes(act)) throw fail('not_found');
  const out = await control.perform(gc, { cfg: c.cfg, t: c.t, lang: c.lang, now: c.now, via: viaOf(c.user) }, c.user, lockId, act);
  return { message: out.message, lock: views.lockView(out.lock, { level: rights.levelOf(c.r, c.user.id, lockId), user: c.user, prefs: c.prefs, cfg: c.cfg, now: c.now }) };
}

async function camera(gc, c, id) {
  const cam = (await visibleCameras(gc, c)).find((x) => x.id === id);
  if (!cam) throw fail('not_found');
  return cam;
}

async function snapshot(gc, c, id, query) {
  const cam = await camera(gc, c, id);
  const refresh = query && (query.refresh === '1' || query.refresh === 1 || query.refresh === 'true');
  const m = await cameras.snapshot(gc, c.cfg, cam, { refresh, userId: c.user.id }, c.now);
  return { snapshot: { cameraId: cam.id, ...views.imageView(m) } };
}

async function prefs(gc, c, id, body) {
  const cam = await camera(gc, c, id);
  if (!rights.canAct(c.user)) throw fail('read_only');
  const cur = (await store.one(gc, 'SELECT ding, motion FROM camera_prefs WHERE user_id = ? AND camera_id = ?', [c.user.id, cam.id])) || { ding: 1, motion: 0 };
  const ding = body.ding === undefined ? cur.ding === 1 : bool(body.ding);
  const motion = body.motion === undefined ? cur.motion === 1 : bool(body.motion);
  await store.tx(gc, () => store.run(gc, `INSERT INTO camera_prefs (user_id, camera_id, ding, motion) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, camera_id) DO UPDATE SET ding = excluded.ding, motion = excluded.motion`, [c.user.id, cam.id, ding ? 1 : 0, motion ? 1 : 0]));
  return { prefs: { ding, motion } };
}

/** The history filter of a viewer (admins: everything). */
function historyFilter(c) {
  if (c.user.role === 'admin') return { all: true };
  return {
    userId: c.user.id,
    lockIds: c.mine.filter((l) => rights.atLeast(rights.levelOf(c.r, c.user.id, l.id), 'open')).map((l) => l.id),
    ringLockIds: c.mine.map((l) => l.id),
  };
}

async function historyPage(gc, c, query, filter) {
  const cursor = query.cursor == null || query.cursor === '' ? null : posInt(query.cursor);
  if (query.cursor != null && query.cursor !== '' && !cursor) throw fail('invalid');
  const limit = query.limit == null || query.limit === '' ? 30 : posInt(query.limit);
  if (!limit || limit > 100) throw fail('invalid');
  const lockId = query.lockId == null || query.lockId === '' ? null : posInt(query.lockId);
  const kind = typeof query.kind === 'string' && history.KINDS.includes(query.kind) ? query.kind : null;
  const page = await history.list(gc, filter, { cursor, limit, lockId, kind });
  const lockMap = new Map(c.all.map((l) => [l.id, l]));
  const camMap = new Map((await cameras.all(gc)).map((x) => [x.id, x]));
  const mediaOk = await history.existingMedia(gc, page.rows.map((x) => x.media_id), c.now);
  return { items: page.rows.map((row) => history.view(row, { locks: lockMap, cameras: camMap, t: c.t, lang: c.lang, mediaOk })), nextCursor: page.nextCursor };
}

/** One ring / motion event with its picture, when the viewer may see that camera's events. */
async function event(gc, c, id, { admin = false } = {}) {
  const row = await history.one(gc, id);
  if (!row || (row.kind !== 'ding' && row.kind !== 'motion')) throw fail('not_found');
  const cam = row.camera_id ? await cameras.get(gc, row.camera_id) : null;
  const lockId = cam && cam.lock_id ? cam.lock_id : row.lock_id;
  const level = lockId ? rights.levelOf(c.r, c.user.id, lockId) : null;
  if (!admin && c.user.role !== 'admin' && !level) throw fail('not_found');
  const m = await history.media(gc, row.media_id, c.now);
  const lockMap = new Map(c.all.map((l) => [l.id, l]));
  const camMap = new Map(cam ? [[cam.id, cam]] : []);
  const lock = lockId ? lockMap.get(lockId) : null;
  const ev = history.view(row, { locks: lockMap, cameras: camMap, t: c.t, lang: c.lang, mediaOk: new Set(m ? [m.id] : []) });
  return {
    event: {
      ...ev, lockId: lock ? lock.id : null, lockName: lock ? lock.name : null, image: views.imageView(m),
      lock: lock && level ? views.lockView(lock, { level, user: c.user, prefs: c.prefs, cfg: c.cfg, now: c.now }) : null,
    },
  };
}

/** Route a request of a person → result object (merged into { ok: true, … }). */
async function route(req, gc, seg, cfg, now, t) {
  const c = await context(gc, req, cfg, now, t);
  const method = String(req.method || 'GET').toUpperCase();
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const query = req.query || {};
  const [a, b, x] = seg;
  const n = seg.length;
  if (method === 'GET' && !readLimiter.hit(`u:${c.user.id}`, now)) throw fail('rate_limited', { retryAfter: readLimiter.retryAfter(`u:${c.user.id}`, now) });
  if (a === 'me' && n === 1 && method === 'GET') return me(gc, c);
  if (a === 'locks' && n === 3 && method === 'POST') {
    const id = posInt(b);
    if (!id) throw fail('not_found');
    return action(gc, c, id, x);
  }
  if (a === 'cameras' && n === 3) {
    const id = posInt(b);
    if (!id) throw fail('not_found');
    if (x === 'snapshot' && method === 'GET') return snapshot(gc, c, id, query);
    if (x === 'prefs' && (method === 'PUT' || method === 'PATCH')) return prefs(gc, c, id, body);
  }
  if (a === 'history' && n === 1 && method === 'GET') {
    if (!c.mine.length && c.user.role !== 'admin') return { items: [], nextCursor: null };
    return historyPage(gc, c, query, historyFilter(c));
  }
  if (a === 'events' && n === 2 && method === 'GET') {
    const id = posInt(b);
    if (!id) throw fail('not_found');
    return event(gc, c, id);
  }
  throw fail('not_found');
}

/** Is there something for this viewer (portal / app tab)? Any right on a lock. */
async function visibleFor(gc, user) {
  if (!user || !Number.isSafeInteger(user.id)) return false;
  const r = await rights.load(gc);
  if (!rights.hasAny(r, user.id)) return false;
  const all = await locks.all(gc);
  return all.some((l) => rights.levelOf(r, user.id, l.id));
}

module.exports = { route, context, me, historyPage, historyFilter, event, visibleFor, readLimiter };
