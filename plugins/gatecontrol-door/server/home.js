'use strict';

// 1.6.0 — Kameras im Heimnetz (ONVIF/RTSP) through GateControl's gateways
// (gc.cameras, permissions.cameras; GateControl with "Kameras", the gateway's
// docs/cameras.md). The cameras themselves, their passwords (encrypted on the
// server), recordings and clips belong to GateControl and the gateway; this
// plugin keeps who sees which camera (home_camera_rights), the push switch per
// camera and when it last pushed (home_camera_prefs), and shows everything.
//
// Without gc.cameras (an older GateControl) every view answers
// { supported: false, minGatecontrol } and nothing else changes — Ring and the
// locks work as before.
//
// Push "Person an der Einfahrt" with a snapshot: on the first `person` of an
// event (hook cameraEvent), to everybody who sees the camera, at most once per
// camera every 5 minutes (topic "kamera"); "Niemand ist zu Hause" when the
// gateway says so.
//
// 1.7.0: the camera list carries the resolution (width/height) and the sound
// (audio: the app offers "Ton"; hasAudio: the stream has a sound track); each
// person may switch the push off for a camera (home_camera_user_prefs,
// PUT cameras/home/<id>/prefs { push }); the push carries "Ansehen"
// (open_app_route — the apps open that camera); HTTPS cameras: "HTTPS" and
// "Zertifikat nicht prüfen" (tlsInsecure, the administrator's choice per
// camera; default: checked, error cam_tls).

const store = require('./store');
const rights = require('./rights');
const push = require('./push');
const tz = require('./tz');
const { fail, text, bool } = require('./util');

const MIN_GATECONTROL = '1.240.0';
const PUSH_GAP_MS = 5 * 60_000;
const CAM_ID_RE = /^c[0-9a-f]{15}$/;
const EVENT_ID_RE = /^e[0-9a-f]{15}$/;
const KINDS = ['person', 'vehicle', 'animal', 'motion'];
const RECORD = ['motion', 'away', 'never'];
const DAYS = [7, 14, 30];
const SAVE_MAX = 700 * 1024;

const has = (gc) => !!(gc && gc.cameras);

/** Host errors → this plugin's error codes (texts error.cam_*). */
const HOST = {
  ERR_CAMERA_AUTH: 'cam_auth', ERR_CAMERA_UNREACHABLE: 'cam_unreachable', ERR_CAMERA_NOT_ALLOWED: 'cam_not_allowed', ERR_CAMERA_OFFLINE: 'cam_offline',
  ERR_CAMERA_UNSUPPORTED: 'cam_unsupported', ERR_CAMERA_LIMIT: 'cam_limit', ERR_CAMERA_NOT_READY: 'cam_not_ready', ERR_CAMERA_SERVICE_MISSING: 'cam_service',
  ERR_NOT_FOUND: 'not_found', ERR_INVALID: 'invalid', ERR_CAMERAS_DENIED: 'cam_needs_gc', ERR_CAMERA_TLS: 'cam_tls',
};

async function host(fn) {
  try { return await fn(); } catch (e) {
    const code = e && HOST[e.code];
    if (code) throw fail(code);
    throw e;
  }
}

function needCameras(gc) {
  if (!has(gc)) throw fail('cam_needs_gc', { minGatecontrol: MIN_GATECONTROL });
}

function camId(v) {
  if (typeof v !== 'string' || !CAM_ID_RE.test(v)) throw fail('not_found');
  return v;
}

// ─── local rows (rights, push) ───────────────────────────────

async function prefsMap(gc) {
  const m = new Map();
  for (const p of await store.all(gc, 'SELECT camera_id, push, last_push_at FROM home_camera_prefs')) m.set(p.camera_id, { push: p.push === 1, lastPushAt: p.last_push_at });
  return m;
}

async function setPush(gc, id, on) {
  await store.run(gc, `INSERT INTO home_camera_prefs (camera_id, push, last_push_at) VALUES (?, ?, NULL)
    ON CONFLICT(camera_id) DO UPDATE SET push = excluded.push`, [id, on ? 1 : 0]);
}

/** The cameras this person switched the push off for (Set of camera ids). */
async function mutedOf(gc, userId) {
  const out = new Set();
  for (const p of await store.all(gc, 'SELECT camera_id FROM home_camera_user_prefs WHERE user_id = ? AND push = 0', [userId])) out.add(p.camera_id);
  return out;
}

/** Who switched the push of this camera off (Set of user ids). */
async function mutedFor(gc, cameraId) {
  const out = new Set();
  for (const p of await store.all(gc, 'SELECT user_id FROM home_camera_user_prefs WHERE camera_id = ? AND push = 0', [cameraId])) out.add(p.user_id);
  return out;
}

/** Does this person see the home camera? (admin page "Berechtigungen", column "sieht") */
function sees(r, userId, id) {
  const s = r.homeCams && r.homeCams.get(userId);
  return !!s && s.has(id);
}

function viewers(r, id) {
  const out = [];
  for (const [uid, s] of r.homeCams || []) if (s.has(id)) out.push(uid);
  return out.sort((a, b) => a - b);
}

// ─── views ───────────────────────────────────────────────────

function settingsOf(cam) {
  const s = cam && cam.settings ? cam.settings : {};
  return { record: s.record || 'motion', events: Array.isArray(s.events) ? s.events : [], retentionDays: s.retentionDays || 14, stream: s.stream || 'main', audio: !!s.audio };
}

async function cameraView(gc, cam, prefs) {
  let snap = null;
  try { snap = (await gc.cameras.snapshotUrl(cam.id)).url; } catch { snap = null; }
  const p = prefs.get(cam.id) || { push: true };
  const settings = settingsOf(cam);
  const hasAudio = typeof cam.hasAudio === 'boolean' ? cam.hasAudio : null;
  const dim = (v) => (Number.isInteger(v) && v > 0 && v < 20000 ? v : null);
  return {
    id: cam.id, kind: 'home', name: cam.name, gatewayId: cam.gatewayId, gateway: cam.gateway, model: [cam.manufacturer, cam.model].filter(Boolean).join(' ') || null,
    host: cam.host, source: cam.source, state: cam.state, online: !!cam.online, codec: cam.codec, events: cam.events, settings,
    // 1.7.0: resolution of the stream (gateway report; null unknown) and sound — "Ton" when switched on and the
    // stream is not known to have none (hasAudio: GateControl ≥ 1.242.0 / gateway ≥ 1.29.0, else null)
    width: dim(cam.width), height: dim(cam.height), audio: settings.audio && hasAudio !== false, hasAudio,
    https: cam.https === true, tlsInsecure: cam.tlsInsecure === true,
    push: p.push !== false, snapshotUrl: snap, snapshotAt: cam.snapshotAt || null, lastEventAt: cam.lastEventAt || null,
  };
}

function dayRange(day, zone, now) {
  const want = typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : tz.local(now, zone).date;
  // the local midnight: search the UTC hours around the date (zones are within ±14 h)
  const base = Date.parse(want + 'T00:00:00Z');
  if (!Number.isFinite(base)) throw fail('invalid', { field: 'day' });
  let start = null;
  for (let h = -14; h <= 14; h++) {
    const t = base + h * 3600_000;
    const l = tz.local(t, zone);
    if (l.date === want && l.minutes === 0) { start = t; break; }
  }
  if (start === null) start = base;
  return { day: want, since: start, until: start + 24 * 3600_000 };
}

function eventView(e) {
  return {
    id: e.id, cameraId: e.cameraId, camera: e.camera, kind: e.kind, kinds: e.kinds, startedAt: e.startedAt, endedAt: e.endedAt, nobodyHome: e.nobodyHome,
    ms: e.clip ? e.clip.ms : null, thumbUrl: e.thumbUrl || null, clipUrl: e.clipUrl || null,
  };
}

// ─── admin ───────────────────────────────────────────────────

/** GET admin/home → everything of the section "Kameras" on the page "Geräte". */
async function adminView(gc, cfg, now) {
  if (!has(gc)) return { supported: false, minGatecontrol: MIN_GATECONTROL };
  const av = await host(() => gc.cameras.available());
  const prefs = await prefsMap(gc);
  const cams = await host(() => gc.cameras.list());
  const range = dayRange(null, cfg.timezone, now);
  const today = await host(() => gc.cameras.events({ since: new Date(range.since).toISOString(), until: new Date(range.until).toISOString(), limit: 50 }));
  return {
    supported: true, minGatecontrol: MIN_GATECONTROL, available: av.available, gateways: av.gateways,
    cameras: await Promise.all(cams.map((c) => cameraView(gc, c, prefs))),
    today: today.map(eventView), day: range.day,
  };
}

function cleanSettings(s) {
  if (s == null) return undefined;
  if (typeof s !== 'object' || Array.isArray(s)) throw fail('invalid', { field: 'settings' });
  const out = {};
  if (s.record !== undefined) { if (!RECORD.includes(s.record)) throw fail('invalid', { field: 'record' }); out.record = s.record; }
  if (s.events !== undefined) { if (!Array.isArray(s.events) || !s.events.every((k) => KINDS.includes(k))) throw fail('invalid', { field: 'events' }); out.events = s.events; }
  if (s.retentionDays !== undefined) { if (!DAYS.includes(s.retentionDays)) throw fail('invalid', { field: 'retentionDays' }); out.retentionDays = s.retentionDays; }
  if (s.stream !== undefined) { if (s.stream !== 'main' && s.stream !== 'sub') throw fail('invalid', { field: 'stream' }); out.stream = s.stream; }
  if (s.audio !== undefined) out.audio = bool(s.audio);
  return out;
}

function target(body) {
  const out = { gatewayId: Number(body.gatewayId) };
  if (!Number.isSafeInteger(out.gatewayId) || out.gatewayId <= 0) throw fail('invalid', { field: 'gatewayId' });
  if (typeof body.rtspUrl === 'string' && body.rtspUrl.trim()) {
    if (body.rtspUrl.length > 400 || !/^rtsp:\/\//i.test(body.rtspUrl.trim())) throw fail('invalid', { field: 'rtspUrl' });
    out.rtspUrl = body.rtspUrl.trim();
  } else {
    if (typeof body.host !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(body.host.trim())) throw fail('invalid', { field: 'host' });
    out.host = body.host.trim();
    if (body.onvifPort != null) { if (!Number.isInteger(body.onvifPort) || body.onvifPort < 1 || body.onvifPort > 65535) throw fail('invalid', { field: 'onvifPort' }); out.onvifPort = body.onvifPort; }
    if (typeof body.onvifPath === 'string' && body.onvifPath) out.onvifPath = body.onvifPath;
    // 1.7.0: ONVIF over HTTPS; "Zertifikat nicht prüfen" only when the administrator ticks it
    if (body.onvifTls !== undefined) out.onvifTls = bool(body.onvifTls);
    if (body.tlsInsecure !== undefined) out.tlsInsecure = bool(body.tlsInsecure);
  }
  const user = body.user == null ? '' : body.user;
  const password = body.password == null ? '' : body.password;
  if (typeof user !== 'string' || user.length > 64 || typeof password !== 'string' || password.length > 128) throw fail('invalid', { field: 'user' });
  out.user = user;
  out.password = password;
  return out;
}

async function adminRoute(gc, method, seg, body, query, cfg, now) {
  const [, , b, c] = seg;
  const n = seg.length;
  if (n === 2 && method === 'GET') return adminView(gc, cfg, now);
  needCameras(gc);
  if (b === 'discover' && n === 3 && method === 'POST') return host(() => gc.cameras.discover(body.gatewayId != null ? { gatewayId: Number(body.gatewayId) } : {}));
  if (b === 'test' && n === 3 && method === 'POST') return { test: await host(() => gc.cameras.test(target(body))) };
  if (b === 'cameras' && n === 3 && method === 'POST') {
    const name = text(body.name, 60);
    const t = target(body);
    const r = await host(() => gc.cameras.add({ ...t, name, ...(typeof body.profile === 'string' ? { profile: body.profile } : {}), settings: cleanSettings(body.settings) }));
    await setPush(gc, r.camera.id, body.push === undefined ? true : bool(body.push));
    return { camera: await cameraView(gc, r.camera, await prefsMap(gc)), snapshot: r.snapshot };
  }
  if (b === 'cameras' && n >= 4) {
    const id = camId(c);
    if (n === 4 && (method === 'PATCH' || method === 'PUT')) {
      const patch = {};
      if (body.name !== undefined) patch.name = text(body.name, 60);
      if (body.user !== undefined) { if (typeof body.user !== 'string' || body.user.length > 64) throw fail('invalid', { field: 'user' }); patch.user = body.user; }
      if (typeof body.password === 'string' && body.password) { if (body.password.length > 128) throw fail('invalid', { field: 'password' }); patch.password = body.password; }
      if (body.tlsInsecure !== undefined) patch.tlsInsecure = bool(body.tlsInsecure);
      const s = cleanSettings(body.settings);
      if (s && Object.keys(s).length) patch.settings = s;
      let cam = null;
      if (Object.keys(patch).length) cam = await host(() => gc.cameras.update(id, patch));
      if (body.push !== undefined) await setPush(gc, id, bool(body.push));
      if (!cam) cam = (await host(() => gc.cameras.list())).find((x) => x.id === id);
      if (!cam) throw fail('not_found');
      return { camera: await cameraView(gc, cam, await prefsMap(gc)) };
    }
    if (n === 4 && method === 'DELETE') {
      await host(() => gc.cameras.remove(id, { deleteClips: query && query.clips === '1' }));
      await store.tx(gc, async () => {
        await store.run(gc, 'DELETE FROM home_camera_prefs WHERE camera_id = ?', [id]);
        await store.run(gc, 'DELETE FROM home_camera_rights WHERE camera_id = ?', [id]);
        await store.run(gc, 'DELETE FROM home_camera_user_prefs WHERE camera_id = ?', [id]);
      });
      return {};
    }
  }
  if (b === 'events' && n === 4 && method === 'DELETE') {
    if (!EVENT_ID_RE.test(String(c))) throw fail('not_found');
    return host(() => gc.cameras.deleteEvent(c));
  }
  throw fail('not_found');
}

// ─── people (portal tab, app) ────────────────────────────────

async function visible(gc, r, user) {
  if (!has(gc) || !user || !Number.isSafeInteger(user.id)) return [];
  let cams = [];
  try { cams = await gc.cameras.list(); } catch { return []; }
  return cams.filter((c) => sees(r, user.id, c.id));
}

/** GET cameras → the home cameras this person sees (Ring cameras: GET me as before). */
async function personList(gc, c) {
  if (!has(gc)) return { supported: false, minGatecontrol: MIN_GATECONTROL, cameras: [] };
  const prefs = await prefsMap(gc);
  const cams = await visible(gc, c.r, c.user);
  const muted = await mutedOf(gc, c.user.id);
  // people never see the address nor the certificate choice; prefs.push = their own push (1.7.0)
  return {
    supported: true, minGatecontrol: MIN_GATECONTROL, every: 10,
    cameras: await Promise.all(cams.map((x) => cameraView(gc, x, prefs).then((v) => ({ ...v, host: undefined, tlsInsecure: undefined, https: undefined, prefs: { push: !muted.has(x.id) } })))),
  };
}

async function ownCamera(gc, c, id) {
  needCameras(gc);
  const cam = (await visible(gc, c.r, c.user)).find((x) => x.id === id);
  if (!cam) throw fail('not_found');
  return cam;
}

async function personRoute(gc, c, req, seg, query) {
  const [, b, x] = seg;
  const n = seg.length;
  const method = String(req.method || 'GET').toUpperCase();
  if (n === 2 && b === 'home' && method === 'GET') return personList(gc, c);
  if (n === 4 && b === 'home') {
    const id = camId(x);
    const cam = await ownCamera(gc, c, id);
    const what = seg[3];
    if (what === 'live' && method === 'GET') return { live: await host(() => gc.cameras.live(cam.id, req)) };
    if (what === 'still' && method === 'GET') return { still: await host(() => gc.cameras.snapshot(cam.id, { maxBytes: SAVE_MAX })) };
    if (what === 'prefs' && (method === 'PUT' || method === 'PATCH')) {
      // 1.7.0: the own push "Personen an der Kamera" of this camera (read-only devices: no)
      if (!rights.canAct(c.user)) throw fail('read_only');
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      if (body.push === undefined) throw fail('invalid', { field: 'push' });
      const on = bool(body.push);
      await store.tx(gc, () => store.run(gc, `INSERT INTO home_camera_user_prefs (user_id, camera_id, push) VALUES (?, ?, ?)
        ON CONFLICT(user_id, camera_id) DO UPDATE SET push = excluded.push`, [c.user.id, cam.id, on ? 1 : 0]));
      return { prefs: { push: on } };
    }
    if (what === 'clips' && method === 'GET') {
      const range = dayRange(query && query.day, c.cfg.timezone, c.now);
      const list = await host(() => gc.cameras.events({ cameraId: cam.id, since: new Date(range.since).toISOString(), until: new Date(range.until).toISOString(), limit: 100 }));
      return { day: range.day, clips: list.map(eventView) };
    }
  }
  throw fail('not_found');
}

// ─── push (hook cameraEvent) ─────────────────────────────────

/**
 * A camera event: push with a snapshot to the people who see the camera — on the first `person`
 * of an event (phase start or update), at most once per camera every 5 minutes.
 */
async function onEvent(gc, ev, t, now = Date.now()) {
  if (!ev || !CAM_ID_RE.test(String(ev.cameraId)) || ev.phase === 'end') return { pushed: false, why: 'phase' };
  if (!(Array.isArray(ev.kinds) ? ev.kinds : [ev.kind]).includes('person')) return { pushed: false, why: 'kind' };
  const prefs = await prefsMap(gc);
  const p = prefs.get(ev.cameraId) || { push: true, lastPushAt: null };
  if (p.push === false) return { pushed: false, why: 'off' };
  if (p.lastPushAt && now - p.lastPushAt < PUSH_GAP_MS) return { pushed: false, why: 'gap' };
  const r = await rights.load(gc);
  // 1.7.0: without the people who switched this camera's push off for themselves
  const muted = await mutedFor(gc, ev.cameraId);
  const users = viewers(r, ev.cameraId).filter((u) => !muted.has(u));
  if (!users.length) return { pushed: false, why: 'nobody' };
  // reserve the slot first: two events of one camera at the same moment push once
  const claimed = await store.tx(gc, async () => {
    const cur = await store.one(gc, 'SELECT last_push_at FROM home_camera_prefs WHERE camera_id = ?', [ev.cameraId]);
    if (cur && cur.last_push_at && now - cur.last_push_at < PUSH_GAP_MS) return false;
    await store.run(gc, `INSERT INTO home_camera_prefs (camera_id, push, last_push_at) VALUES (?, 1, ?)
      ON CONFLICT(camera_id) DO UPDATE SET last_push_at = excluded.last_push_at`, [ev.cameraId, now]);
    return true;
  });
  if (!claimed) return { pushed: false, why: 'gap' };
  const cfg = await require('./config').load(gc);
  const lang = cfg.notifyLang === 'en' ? 'en' : 'de';
  let image;
  try { const s = await gc.cameras.snapshot(ev.cameraId); image = { data: s.data, mime: 'image/jpeg' }; } catch { image = undefined; }
  const at = tz.local(Date.parse(ev.at) || now, cfg.timezone);
  const hhmm = `${String(Math.floor(at.minutes / 60)).padStart(2, '0')}:${String(at.minutes % 60).padStart(2, '0')}`;
  const body = ev.nobodyHome === true ? t(lang, 'home.push_body_away', { time: hhmm }) : t(lang, 'home.push_body', { time: hhmm });
  try {
    await gc.notify({
      topic: 'kamera', title: t(lang, 'home.push_title', { name: ev.camera || '' }).slice(0, 120), body, priority: 'high', users,
      collapseKey: 'homecam:' + ev.cameraId, ttl: 6 * 3600,
      // "Ansehen" (1.7.0): the apps open this camera (data.door.cameraId), the portal the plugin's tab
      data: { door: { type: 'home_camera_event', cameraId: ev.cameraId, eventId: ev.id }, actions: [push.viewAction(lang)] },
      ...(image ? { image } : {}),
    });
  } catch (e) {
    gc.log.warn('camera push failed', (e && e.code) || 'error');
    return { pushed: false, why: 'notify' };
  }
  return { pushed: true, users };
}

module.exports = {
  MIN_GATECONTROL, PUSH_GAP_MS, has, mutedOf, mutedFor, adminView, adminRoute, personList, personRoute, onEvent, sees, viewers, visible, dayRange, cleanSettings,
};
