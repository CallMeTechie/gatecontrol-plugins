'use strict';

// The admin API (administrators on the admin pages only; never a portal or app caller):
//
//   GET    admin/status                      bridges, home targets, Nuki Web, Ring, locks, cameras, Ring modes, settings
//   POST   admin/bridges { name, targetIndex, token }      PATCH|DELETE admin/bridges/<id>
//   GET    admin/bridges/<id>/devices        the bridge's /list (test + "add lock")
//   PUT    admin/web { token | null }        GET admin/web/devices
//   POST   admin/locks { … }                 PATCH|DELETE admin/locks/<id>   POST admin/locks/<id>/refresh
//   POST   admin/ring/login { email, password, code? }      POST admin/ring/logout · admin/ring/sync
//   PATCH  admin/cameras/<id> { name?, lockId?, enabled? }  GET admin/cameras/<id>/snapshot[?refresh=1]
//   POST   admin/modes/<locationId>/<disarmed|home|away>    switch a Ring location's mode (server/modes.js)
//   GET    admin/rights                      PUT admin/rights/<userId> { locks?, autoUnlock?, window?, cameras?, modes?, cameraRights? }
//                                            1.5.0: cameraRights { <cameraId>: true|false } — who sees a camera without a lock
//                                            (GET: cameraRights { <userId>: [cameraId] }, the cameras of a lock follow its rights)
//   GET    admin/history[?cursor&limit&lockId&kind]          GET admin/events/<id>
//   GET    admin/settings                    PUT admin/settings { timezone?, notifyLang?, mediaDays?, motionGapMin?, ring?, nukiLogImport?, familyChat? }
//                                            both answer { config, chat: { api, available, last } } (1.3.0, server/chat.js)
//                                            1.4.0: last.fallback { to, sent, failed } | null; chat.detect = the doorbell diagnosis
//                                            { lastDing: { at, seenAt, delayS, source: 'active'|'events', camera, outcome, pushed } | null,
//                                              active: { state: 'ok'|'off', code, since, offUntil } | null } (server/cameras.js)
//                                            1.5.0: warnings [{ code: 'ring_off' } | { code: 'no_viewers', camera, lock }] —
//                                            Ring connected but not polled (no ring is noticed: no push, no chat card),
//                                            a camera (switched on) nobody sees (its rings reach nobody)
//
// Secrets (bridge tokens, the Nuki Web token, the Ring refresh token) are
// written with gc.settings.setSecret and NEVER sent back — the pages only see
// hasToken: true/false. The Ring password is used for the login request and
// dropped; it is never stored or logged.

const store = require('./store');
const locks = require('./locks');
const nuki = require('./nuki');
const ring = require('./ring');
const rights = require('./rights');
const cameras = require('./cameras');
const modes = require('./modes');
const config = require('./config');
const chat = require('./chat');
const views = require('./views');
const api = require('./api');
const { fail, posInt, text, bool, intIn, iso } = require('./util');

const MAX_LOCKS = 20;
const MAX_BRIDGES = 8;
const BRIDGE_TOKEN_RE = /^[A-Za-z0-9]{4,64}$/;
const WEB_TOKEN_RE = /^[A-Za-z0-9._~+/=-]{10,2000}$/;
const NUKI_ID_RE = /^\d{1,20}$/;
const LEVELS = ['none', 'view', 'lock', 'open'];

async function targetList(gc) {
  try {
    const t = (await gc.net.targets()).find((x) => x.id === nuki.TARGET);
    return t ? t.assigned.map((a) => ({ index: a.index, label: a.label })) : [];
  } catch { return []; }
}

async function bridgeViews(gc) {
  const targets = await targetList(gc);
  const out = [];
  for (const b of await locks.bridges(gc)) {
    const tgt = targets.find((x) => x.index === b.target_index);
    out.push({ id: b.id, name: b.name, targetIndex: b.target_index, targetLabel: tgt ? tgt.label : null, hasToken: !!(await locks.bridgeToken(gc, b.id)) });
  }
  return out;
}

async function ringView(gc, now) {
  const s = await cameras.status(gc, now);
  return { connected: s.connected, state: s.state, broken: s.broken, since: iso(s.since), code: s.code, lastOk: iso(s.lastOk) };
}

async function status(gc, cfg, now) {
  return {
    bridges: await bridgeViews(gc), targets: await targetList(gc), web: { hasToken: !!(await locks.webToken(gc)) },
    ring: await ringView(gc, now), locks: (await locks.all(gc)).map((l) => views.adminLockView(l, now)),
    cameras: (await cameras.all(gc)).map(views.adminCameraView), ringModes: (await modes.all(gc)).filter((l) => l.present === 1).map(modes.adminView), config: cfg,
  };
}

// ─── bridges & web ─────────────────────────────

async function bridgeInput(gc, body, partial) {
  const out = {};
  if (!partial || body.name !== undefined) out.name = text(body.name, 40);
  if (!partial || body.targetIndex !== undefined) {
    out.targetIndex = intIn(body.targetIndex, 0, 63);
    const targets = await targetList(gc);
    if (!targets.some((x) => x.index === out.targetIndex)) throw fail('no_target', { field: 'targetIndex' });
  }
  if (!partial || body.token !== undefined) {
    if (typeof body.token !== 'string' || !BRIDGE_TOKEN_RE.test(body.token.trim())) throw fail('invalid', { field: 'token' });
    out.token = body.token.trim();
  }
  return out;
}

async function createBridge(gc, body, now) {
  const n = (await store.one(gc, 'SELECT COUNT(*) AS n FROM bridges')).n;
  if (n >= MAX_BRIDGES) throw fail('too_many');
  const v = await bridgeInput(gc, body, false);
  const id = await store.tx(gc, async () => (await store.run(gc, 'INSERT INTO bridges (name, target_index, created_at, updated_at) VALUES (?, ?, ?, ?)', [v.name, v.targetIndex, now, now])).lastInsertRowid);
  await gc.settings.setSecret(locks.bridgeSecret(id), v.token);
  return { bridge: (await bridgeViews(gc)).find((b) => b.id === id) };
}

async function updateBridge(gc, id, body, now) {
  const b = await store.one(gc, 'SELECT id FROM bridges WHERE id = ?', [id]);
  if (!b) throw fail('not_found');
  const v = await bridgeInput(gc, body, true);
  await store.tx(gc, async () => {
    if (v.name !== undefined) await store.run(gc, 'UPDATE bridges SET name = ?, updated_at = ? WHERE id = ?', [v.name, now, id]);
    if (v.targetIndex !== undefined) await store.run(gc, 'UPDATE bridges SET target_index = ?, updated_at = ? WHERE id = ?', [v.targetIndex, now, id]);
  });
  if (v.token !== undefined) await gc.settings.setSecret(locks.bridgeSecret(id), v.token);
  return { bridge: (await bridgeViews(gc)).find((x) => x.id === id) };
}

async function deleteBridge(gc, id) {
  const used = await store.one(gc, 'SELECT COUNT(*) AS n FROM locks WHERE bridge_id = ?', [id]);
  if (used.n > 0) throw fail('too_many', { reason: 'in_use' });
  const r = await store.tx(gc, () => store.run(gc, 'DELETE FROM bridges WHERE id = ?', [id]));
  if (!r.changes) throw fail('not_found');
  await gc.settings.setSecret(locks.bridgeSecret(id), null);
  return {};
}

const deviceView = (d) => ({ nukiId: d.nukiId, deviceType: d.deviceType, type: nuki.isOpener(d.deviceType) ? 'opener' : 'smartlock', name: d.name, supported: nuki.supportedActions(d.deviceType) });

async function bridgeDevices(gc, id) {
  const b = await store.one(gc, 'SELECT * FROM bridges WHERE id = ?', [id]);
  if (!b) throw fail('not_found');
  return { devices: (await nuki.bridgeList(gc, b, await locks.bridgeToken(gc, id))).map(deviceView) };
}

async function setWeb(gc, body) {
  if (body.token === null || body.token === '') {
    await gc.settings.setSecret(locks.WEB_TOKEN, null);
    return { web: { hasToken: false } };
  }
  if (typeof body.token !== 'string' || !WEB_TOKEN_RE.test(body.token.trim())) throw fail('invalid', { field: 'token' });
  await gc.settings.setSecret(locks.WEB_TOKEN, body.token.trim());
  return { web: { hasToken: true } };
}

async function webDevices(gc) {
  return { devices: (await nuki.webList(gc, await locks.webToken(gc))).map(deviceView) };
}

// ─── locks ─────────────────────────────────────

async function lockInput(gc, body, cur) {
  const v = {};
  const has = (k) => !cur || body[k] !== undefined;
  if (has('name')) v.name = text(body.name, 40);
  if (has('source')) {
    if (body.source !== 'bridge' && body.source !== 'web') throw fail('invalid', { field: 'source' });
    v.source = body.source;
  }
  const source = v.source || (cur && cur.source);
  if (has('bridgeId') || (v.source === 'bridge')) {
    if (source === 'bridge') {
      const id = posInt(body.bridgeId);
      if (!id || !(await store.one(gc, 'SELECT id FROM bridges WHERE id = ?', [id]))) throw fail('invalid', { field: 'bridgeId' });
      v.bridgeId = id;
    } else v.bridgeId = null;
  }
  if (v.source === 'web') v.bridgeId = null;
  if (has('nukiId')) {
    if (!NUKI_ID_RE.test(String(body.nukiId == null ? '' : body.nukiId))) throw fail('invalid', { field: 'nukiId' });
    v.nukiId = String(body.nukiId);
  }
  if (has('deviceType')) {
    if (!Number.isInteger(body.deviceType) || !nuki.knownType(body.deviceType)) throw fail('invalid', { field: 'deviceType' });
    v.deviceType = body.deviceType;
  }
  const deviceType = v.deviceType != null ? v.deviceType : cur && cur.device_type;
  if (has('actions') || v.deviceType != null) {
    const list = body.actions !== undefined ? body.actions : cur.actions;
    if (!Array.isArray(list) || !list.length || !list.every((a) => nuki.supportedActions(deviceType).includes(a))) throw fail('invalid', { field: 'actions' });
    v.actions = ['lock', 'unlock', 'open'].filter((a) => list.includes(a));
  }
  if (has('doorSensor')) v.doorSensor = body.doorSensor === undefined ? false : bool(body.doorSensor);
  if (has('openTooLongMin')) v.openTooLongMin = body.openTooLongMin === undefined ? 5 : intIn(body.openTooLongMin, 0, 240);
  if (has('nightCheck')) {
    if (body.nightCheck === undefined && !cur) v.nightCheck = '22:00';
    else if (body.nightCheck === null || body.nightCheck === '') v.nightCheck = null;
    else if (typeof body.nightCheck === 'string' && /^([01]\d|2[0-3]):([0-5]\d)$/.test(body.nightCheck)) v.nightCheck = body.nightCheck;
    else throw fail('invalid', { field: 'nightCheck' });
  }
  return v;
}

async function createLock(gc, body, now) {
  const n = (await store.one(gc, 'SELECT COUNT(*) AS n FROM locks')).n;
  if (n >= MAX_LOCKS) throw fail('too_many');
  const v = await lockInput(gc, body, null);
  const id = await store.tx(gc, async () => (await store.run(gc, `INSERT INTO locks (name, source, bridge_id, nuki_id, device_type, actions, door_sensor, open_too_long_min, night_check, sort, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [v.name, v.source, v.bridgeId || null, v.nukiId, v.deviceType, JSON.stringify(v.actions), v.doorSensor ? 1 : 0, v.openTooLongMin, v.nightCheck, n, now, now])).lastInsertRowid);
  const lock = await locks.get(gc, id);
  locks.pollSoon(lock, now);
  return { lock: views.adminLockView(lock, now) };
}

async function updateLock(gc, id, body, now) {
  const cur = await locks.get(gc, id);
  if (!cur) throw fail('not_found');
  const v = await lockInput(gc, body, cur);
  const cols = { name: 'name', source: 'source', bridgeId: 'bridge_id', nukiId: 'nuki_id', deviceType: 'device_type', doorSensor: 'door_sensor', openTooLongMin: 'open_too_long_min', nightCheck: 'night_check' };
  await store.tx(gc, async () => {
    for (const [k, col] of Object.entries(cols)) {
      if (v[k] === undefined) continue;
      const val = typeof v[k] === 'boolean' ? (v[k] ? 1 : 0) : v[k];
      await store.run(gc, `UPDATE locks SET ${col} = ?, updated_at = ? WHERE id = ?`, [val, now, id]);
    }
    if (v.actions) await store.run(gc, 'UPDATE locks SET actions = ?, updated_at = ? WHERE id = ?', [JSON.stringify(v.actions), now, id]);
    // a different device: the old state does not apply
    if (v.nukiId !== undefined || v.source !== undefined || v.bridgeId !== undefined) await store.run(gc, 'DELETE FROM lock_state WHERE lock_id = ?', [id]);
  });
  const lock = await locks.get(gc, id);
  locks.pollSoon(lock, now);
  return { lock: views.adminLockView(lock, now) };
}

async function deleteLock(gc, id) {
  const r = await store.tx(gc, async () => {
    const x = await store.run(gc, 'DELETE FROM locks WHERE id = ?', [id]);
    if (x.changes) {
      for (const sql of ['DELETE FROM lock_state WHERE lock_id = ?', 'DELETE FROM rights WHERE lock_id = ?', 'DELETE FROM auto_runs WHERE lock_id = ?', 'UPDATE cameras SET lock_id = NULL WHERE lock_id = ?']) await store.run(gc, sql, [id]);
    }
    return x;
  });
  if (!r.changes) throw fail('not_found');
  return {};
}

async function refreshLock(gc, id, now) {
  const lock = await locks.get(gc, id);
  if (!lock) throw fail('not_found');
  await locks.poll(gc, now, { force: true, only: [id] });
  return { lock: views.adminLockView(await locks.get(gc, id), now) };
}

// ─── Ring ──────────────────────────────────────

async function ringLogin(gc, body, now) {
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email || email.length > 200 || !/^[^\s@]+@[^\s@]+$/.test(email)) throw fail('invalid', { field: 'email' });
  if (!password || password.length > 200) throw fail('invalid', { field: 'password' });
  let code = null;
  if (body.code != null && body.code !== '') {
    if (typeof body.code !== 'string' || !/^\d{4,10}$/.test(body.code.trim())) throw fail('invalid', { field: 'code' });
    code = body.code.trim();
  }
  const r = await ring.login(gc, { email, password, code });
  if (r.connected) {
    await cameras.loggedIn(gc, now);
    let count = null;
    try { count = await cameras.sync(gc, now); } catch (e) { gc.log.warn('ring device sync failed', (e && e.code) || 'error'); }
    gc.log.info('ring connected', count == null ? '' : count + ' devices');
    return { ring: { connected: true, devices: count } };
  }
  return { ring: { connected: false, needsCode: true, tsvState: r.tsvState, phone: r.phone } };
}

async function ringLogout(gc) {
  await ring.logout(gc);
  await cameras.loggedOut(gc);
  gc.log.info('ring disconnected');
  return { ring: { connected: false } };
}

async function ringSync(gc, now) {
  if (!(await ring.hasToken(gc))) throw fail('ring_not_connected');
  return { count: await cameras.sync(gc, now), cameras: (await cameras.all(gc)).map(views.adminCameraView) };
}

/** The admin page's mode buttons (administrators may always switch; Ring Alarm locations never). */
async function switchMode(gc, req, cfg, now, t, id, mode) {
  if (!modes.MODES.includes(mode)) throw fail('not_found');
  const out = await modes.perform(gc, { cfg, t, lang: req.lang, now, via: 'admin', adminPage: true }, req.user, id, mode);
  return { message: out.message, ringMode: modes.adminView(out.location) };
}

async function updateCamera(gc, id, body) {
  const cam = await cameras.get(gc, id);
  if (!cam) throw fail('not_found');
  await store.tx(gc, async () => {
    if (body.name !== undefined) await store.run(gc, 'UPDATE cameras SET name = ? WHERE id = ?', [text(body.name, 60), id]);
    if (body.enabled !== undefined) await store.run(gc, 'UPDATE cameras SET enabled = ? WHERE id = ?', [bool(body.enabled) ? 1 : 0, id]);
    if (body.lockId !== undefined) {
      let lockId = null;
      if (body.lockId !== null) {
        lockId = posInt(body.lockId);
        if (!lockId || !(await store.one(gc, 'SELECT id FROM locks WHERE id = ?', [lockId]))) throw fail('invalid', { field: 'lockId' });
      }
      await store.run(gc, 'UPDATE cameras SET lock_id = ? WHERE id = ?', [lockId, id]);
    }
  });
  return { camera: views.adminCameraView(await cameras.get(gc, id)) };
}

async function adminSnapshot(gc, cfg, id, query, now, userId) {
  const cam = await cameras.get(gc, id);
  if (!cam) throw fail('not_found');
  const refresh = query && (query.refresh === '1' || query.refresh === 'true');
  const m = await cameras.snapshot(gc, cfg, cam, { refresh, userId }, now);
  return { snapshot: { cameraId: cam.id, ...views.imageView(m) } };
}

// ─── rights ────────────────────────────────────

async function rightsView(gc) {
  let users = [];
  try { users = (await gc.users.list()).map((u) => ({ id: u.id, name: u.name, role: u.role, avatarUrl: u.avatarUrl || null, colorHex: u.colorHex || null, initials: u.initials || null })); } catch { users = []; }
  const r = await rights.load(gc);
  const levels = {};
  for (const [uid, m] of r.levels) levels[uid] = Object.fromEntries(m);
  const prefs = {};
  for (const [uid, p] of r.prefs) prefs[uid] = p;
  const camPrefs = {};
  for (const p of await store.all(gc, 'SELECT user_id, camera_id, ding, motion FROM camera_prefs')) {
    camPrefs[p.user_id] = camPrefs[p.user_id] || {};
    camPrefs[p.user_id][p.camera_id] = { ding: p.ding === 1, motion: p.motion === 1 };
  }
  const modeRights = {};
  for (const [uid, set] of r.modes) modeRights[uid] = [...set].sort();
  const cameraRights = {};
  for (const [uid, set] of r.cams) cameraRights[uid] = [...set].sort((a, b) => a - b);
  return {
    users, locks: (await locks.all(gc)).map((l) => ({ id: l.id, name: l.name, type: nuki.isOpener(l.device_type) ? 'opener' : 'smartlock', actions: l.actions })),
    cameras: (await cameras.all(gc)).filter((c) => c.present === 1).map((c) => ({ id: c.id, name: c.name, lockId: c.lock_id || null })),
    // Ring locations a mode right makes sense for (present, cameras there, no Ring Alarm)
    locations: (await modes.all(gc)).filter(modes.readable).map((l) => ({ id: l.location_id, name: l.name, supported: modes.supported(l) })),
    rights: levels, prefs, cameraPrefs: camPrefs, modeRights, cameraRights,
  };
}

async function putRights(gc, userId, body, now) {
  let user = null;
  try { user = await gc.users.get(userId); } catch { user = null; }
  if (!user) throw fail('not_found');
  const lockIds = new Set((await locks.all(gc)).map((l) => l.id));
  const camIds = new Set((await cameras.all(gc)).map((c) => c.id));
  const levels = [];
  if (body.locks !== undefined) {
    if (!body.locks || typeof body.locks !== 'object' || Array.isArray(body.locks)) throw fail('invalid', { field: 'locks' });
    for (const [k, lv] of Object.entries(body.locks)) {
      const id = posInt(k);
      if (!id || !lockIds.has(id) || !LEVELS.includes(lv)) throw fail('invalid', { field: 'locks' });
      levels.push([id, lv]);
    }
  }
  const modeSet = [];
  if (body.modes !== undefined) {
    if (!body.modes || typeof body.modes !== 'object' || Array.isArray(body.modes)) throw fail('invalid', { field: 'modes' });
    const locIds = new Set((await modes.all(gc)).filter(modes.readable).map((l) => l.location_id));
    for (const [k, on] of Object.entries(body.modes)) {
      if (!locIds.has(k) || typeof on !== 'boolean') throw fail('invalid', { field: 'modes' });
      modeSet.push([k, on]);
    }
  }
  const camRights = [];
  if (body.cameraRights !== undefined) {
    if (!body.cameraRights || typeof body.cameraRights !== 'object' || Array.isArray(body.cameraRights)) throw fail('invalid', { field: 'cameraRights' });
    for (const [k, on] of Object.entries(body.cameraRights)) {
      const id = posInt(k);
      if (!id || !camIds.has(id) || typeof on !== 'boolean') throw fail('invalid', { field: 'cameraRights' });
      camRights.push([id, on]);
    }
  }
  const autoUnlock = body.autoUnlock === undefined ? undefined : bool(body.autoUnlock);
  const win = body.window === undefined ? undefined : rights.parseWindow(body.window);
  const camPrefs = [];
  if (body.cameras !== undefined) {
    if (!body.cameras || typeof body.cameras !== 'object' || Array.isArray(body.cameras)) throw fail('invalid', { field: 'cameras' });
    for (const [k, p] of Object.entries(body.cameras)) {
      const id = posInt(k);
      if (!id || !camIds.has(id) || !p || typeof p !== 'object') throw fail('invalid', { field: 'cameras' });
      camPrefs.push([id, p.ding === undefined ? null : bool(p.ding), p.motion === undefined ? null : bool(p.motion)]);
    }
  }
  await store.tx(gc, async () => {
    for (const [id, lv] of levels) {
      if (lv === 'none') await store.run(gc, 'DELETE FROM rights WHERE user_id = ? AND lock_id = ?', [userId, id]);
      else await store.run(gc, 'INSERT INTO rights (user_id, lock_id, level) VALUES (?, ?, ?) ON CONFLICT(user_id, lock_id) DO UPDATE SET level = excluded.level', [userId, id, lv]);
    }
    if (autoUnlock !== undefined || win !== undefined) {
      const cur = (await store.one(gc, 'SELECT auto_unlock, time_window FROM user_prefs WHERE user_id = ?', [userId])) || { auto_unlock: 0, time_window: null };
      await store.run(gc, `INSERT INTO user_prefs (user_id, auto_unlock, time_window, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET auto_unlock = excluded.auto_unlock, time_window = excluded.time_window, updated_at = excluded.updated_at`, [
        userId, autoUnlock === undefined ? cur.auto_unlock : (autoUnlock ? 1 : 0), win === undefined ? cur.time_window : (win ? JSON.stringify(win) : null), now,
      ]);
    }
    for (const [id, on] of camRights) {
      if (on) await store.run(gc, 'INSERT OR IGNORE INTO camera_rights (user_id, camera_id) VALUES (?, ?)', [userId, id]);
      else await store.run(gc, 'DELETE FROM camera_rights WHERE user_id = ? AND camera_id = ?', [userId, id]);
    }
    for (const [loc, on] of modeSet) {
      if (on) await store.run(gc, 'INSERT OR IGNORE INTO mode_rights (user_id, location_id) VALUES (?, ?)', [userId, loc]);
      else await store.run(gc, 'DELETE FROM mode_rights WHERE user_id = ? AND location_id = ?', [userId, loc]);
    }
    for (const [id, ding, motion] of camPrefs) {
      const cur = (await store.one(gc, 'SELECT ding, motion FROM camera_prefs WHERE user_id = ? AND camera_id = ?', [userId, id])) || { ding: 1, motion: 0 };
      await store.run(gc, `INSERT INTO camera_prefs (user_id, camera_id, ding, motion) VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, camera_id) DO UPDATE SET ding = excluded.ding, motion = excluded.motion`, [userId, id, ding == null ? cur.ding : (ding ? 1 : 0), motion == null ? cur.motion : (motion ? 1 : 0)]);
    }
  });
  gc.log.info('rights changed', userId);
  return rightsView(gc);
}

// ─── doorbell warnings (1.5.0) ─────────────────

/**
 * What keeps rings from reaching anybody, for the diagnosis: polling switched off while Ring is
 * connected, and cameras (present, switched on) nobody sees — without a lock nobody was given them,
 * with a lock nobody has a right on it.
 */
async function warnings(gc, cfg) {
  if (!(await ring.hasToken(gc))) return [];
  const out = [];
  if (!cfg.ring) out.push({ code: 'ring_off' });
  const r = await rights.load(gc);
  const lockNames = new Map((await locks.all(gc)).map((l) => [l.id, l.name]));
  for (const cam of await cameras.all(gc)) {
    if (cam.present !== 1 || cam.enabled !== 1) continue;
    if (!rights.cameraViewers(r, cam).length) out.push({ code: 'no_viewers', camera: cam.name, lock: cam.lock_id ? lockNames.get(cam.lock_id) || null : null });
  }
  return out;
}

async function settingsView(gc, config_) {
  return { config: config_, chat: { ...(await chat.info(gc)), detect: await cameras.diagnosis(gc) }, warnings: await warnings(gc, config_) };
}

// ─── route ─────────────────────────────────────

async function route(req, gc, seg, cfg, now, t) {
  const method = String(req.method || 'GET').toUpperCase();
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const query = req.query || {};
  const [, a, b, c] = seg;
  const n = seg.length;
  const id = b != null ? posInt(b) : null;
  const GET = method === 'GET';
  const POST = method === 'POST';
  const PATCH = method === 'PATCH' || method === 'PUT';
  const DELETE = method === 'DELETE';
  const needId = () => { if (!id) throw fail('not_found'); };

  if (a === 'status' && n === 2 && GET) return status(gc, cfg, now);
  if (a === 'bridges') {
    if (n === 2 && POST) return createBridge(gc, body, now);
    needId();
    if (n === 3 && PATCH) return updateBridge(gc, id, body, now);
    if (n === 3 && DELETE) return deleteBridge(gc, id);
    if (n === 4 && c === 'devices' && GET) return bridgeDevices(gc, id);
  }
  if (a === 'web') {
    if (n === 2 && PATCH) return setWeb(gc, body);
    if (n === 3 && b === 'devices' && GET) return webDevices(gc);
  }
  if (a === 'locks') {
    if (n === 2 && GET) return { locks: (await locks.all(gc)).map((l) => views.adminLockView(l, now)) };
    if (n === 2 && POST) return createLock(gc, body, now);
    needId();
    if (n === 3 && PATCH) return updateLock(gc, id, body, now);
    if (n === 3 && DELETE) return deleteLock(gc, id);
    if (n === 4 && c === 'refresh' && POST) return refreshLock(gc, id, now);
  }
  if (a === 'ring' && n === 3 && POST) {
    if (b === 'login') return ringLogin(gc, body, now);
    if (b === 'logout') return ringLogout(gc);
    if (b === 'sync') return ringSync(gc, now);
  }
  if (a === 'modes' && n === 4 && POST) return switchMode(gc, req, cfg, now, t, b, c);
  if (a === 'cameras') {
    needId();
    if (n === 3 && PATCH) return updateCamera(gc, id, body);
    if (n === 4 && c === 'snapshot' && GET) return adminSnapshot(gc, cfg, id, query, now, req.user.id);
  }
  if (a === 'rights') {
    if (n === 2 && GET) return rightsView(gc);
    needId();
    if (n === 3 && PATCH) return putRights(gc, id, body, now);
  }
  if (a === 'history' && n === 2 && GET) {
    const ctx = await api.context(gc, req, cfg, now, t);
    return api.historyPage(gc, ctx, query, { all: true });
  }
  if (a === 'events' && n === 3 && GET) {
    needId();
    const ctx = await api.context(gc, req, cfg, now, t);
    return api.event(gc, ctx, id, { admin: true });
  }
  if (a === 'settings') {
    if (n === 2 && GET) return settingsView(gc, cfg);
    if (n === 2 && PATCH) return settingsView(gc, await config.update(gc, body));
  }
  throw fail('not_found');
}

module.exports = { route, MAX_LOCKS, MAX_BRIDGES };
