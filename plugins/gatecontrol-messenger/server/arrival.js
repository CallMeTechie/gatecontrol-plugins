'use strict';

// 1.4.0 — live arrival (message kind 'arrival', README "Live arrival"). The sender shares the way to a
// destination: the app posts its position (POST messages/:id/arrival, about every 20 s); the server keeps
// only the last one (encrypted, removed as soon as the arrival is no longer live) and works out distance,
// ETA (from the smoothed speed, 40 km/h without one) and progress. Within radiusM → arrived: system message
// "X ist angekommen", a push to the others, the optional onArrive action is run as the sender, a status
// auto_place shows the destination. POST …/arrival/stop → stopped; after 3 h it stops by itself.
// Changes → event arrival.update { conversationId, messageId, state, updatedAt }.

const store = require('./store');
const seal = require('./seal');
const live = require('./live');
const messages = require('./messages');
const { fail, posInt, text, numIn, intIn, iso } = require('./util');

const RADIUS_DEFAULT = 150;
const RADIUS_MIN = 30;
const RADIUS_MAX = 5000;
const FALLBACK_MPS = 40 / 3.6;
const MIN_EVERY_MS = 15000;  // posts closer together are answered but not used (the apps post every 20 s)
const MAX_LIVE_MS = 3 * 3600000;
const ACTION_ID_RE = /^[A-Za-z0-9:._-]{1,64}$/;
const PLUGIN_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Great-circle distance in metres. */
function distance(a, b) {
  const R = 6371000;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Check `arrival` of a send body → { dest, onArrive }. */
function clean(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw fail('invalid');
  const d = v.dest;
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw fail('invalid');
  const dest = { label: text(d.label, 120), lat: numIn(d.lat, -90, 90), lon: numIn(d.lon, -180, 180), radiusM: d.radiusM == null ? RADIUS_DEFAULT : intIn(d.radiusM, RADIUS_MIN, RADIUS_MAX) };
  if (d.familiePlaceId != null) {
    if (!(typeof d.familiePlaceId === 'string' || Number.isSafeInteger(d.familiePlaceId)) || String(d.familiePlaceId).length > 64) throw fail('invalid');
    dest.familiePlaceId = d.familiePlaceId;
  }
  let onArrive = null;
  if (v.onArrive != null) {
    const o = v.onArrive;
    if (!o || typeof o !== 'object' || typeof o.actionId !== 'string' || !ACTION_ID_RE.test(o.actionId)) throw fail('invalid');
    if (o.plugin != null && (typeof o.plugin !== 'string' || !PLUGIN_RE.test(o.plugin))) throw fail('invalid');
    onArrive = { actionId: o.actionId, plugin: o.plugin || null };
  }
  return { dest, onArrive };
}

async function create(ctx, conv, msgId, a) {
  // one live arrival per person and chat: an older one stops
  const old = await store.all(ctx.gc, "SELECT msg_id FROM arrivals WHERE conv_id = ? AND sender_id = ? AND state = 'live'", [conv.id, ctx.viewer]);
  for (const o of old) await store.run(ctx.gc, "UPDATE arrivals SET state = 'stopped', pos_enc = NULL, ended_at = ? WHERE msg_id = ?", [ctx.now, o.msg_id]);
  await store.run(ctx.gc, "INSERT INTO arrivals (msg_id, conv_id, sender_id, state, radius_m, started_at) VALUES (?, ?, ?, 'live', ?, ?)", [msgId, conv.id, ctx.viewer, a.dest.radiusM, ctx.now]);
}

/** The arrival objects of these rows → Map msgId → arrival (members only — every viewer here is one). */
async function decorate(ctx, rows) {
  const out = new Map();
  for (const r of rows) {
    const def = (messages.metaOf(r) || {}).arrival;
    const row = await store.one(ctx.gc, 'SELECT * FROM arrivals WHERE msg_id = ?', [r.id]);
    if (!def || !row) continue;
    const isLive = row.state === 'live';
    const pos = isLive ? seal.openJson(row.pos_enc) : null;
    out.set(r.id, {
      dest: def.dest, onArrive: def.onArrive || null, state: row.state, etaAt: isLive ? iso(row.eta_at) : null,
      distanceM: row.distance_m == null ? null : Math.round(row.distance_m), progress: row.progress == null ? null : Math.round(row.progress * 1000) / 1000,
      lastAt: iso(row.last_at), startedAt: iso(row.started_at), endedAt: iso(row.ended_at),
      position: pos && typeof pos.lat === 'number' ? { lat: pos.lat, lon: pos.lon, accuracy: pos.accuracy == null ? null : pos.accuracy } : null,
    });
  }
  return out;
}

async function load(ctx, x, idRaw) {
  const id = posInt(idRaw);
  if (!id) throw fail('not_found');
  const msg = await messages.visibleMessage(ctx, x.me, id);
  if (msg.kind !== 'arrival' || msg.deleted_at) throw fail(msg.deleted_at ? 'deleted' : 'invalid');
  const row = await store.one(ctx.gc, 'SELECT * FROM arrivals WHERE msg_id = ?', [id]);
  if (!row) throw fail('invalid');
  if (row.sender_id !== ctx.viewer) throw fail('not_sender');
  return { msg, row, def: (messages.metaOf(msg) || {}).arrival };
}

function queueUpdate(ctx, convId, memberIds, msgId, state) {
  live.queue(ctx.box, memberIds, 'arrival.update', { conversationId: convId, messageId: msgId, state, updatedAt: iso(ctx.now) });
}

/**
 * POST messages/:id/arrival { lat, lon, accuracy?, speedMps? } → { messageId, accepted, arrived }.
 * On arrival: system message, push, the onArrive action (after the commit), status auto_place.
 */
async function position(ctx, x, idRaw, body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b) throw fail('invalid');
  const p = { lat: numIn(b.lat, -90, 90), lon: numIn(b.lon, -180, 180) };
  if (b.accuracy != null) p.accuracy = Math.round(numIn(b.accuracy, 0, 100000));
  const speed = b.speedMps == null ? null : numIn(b.speedMps, 0, 120);
  const { msg, row, def } = await load(ctx, x, idRaw);
  if (row.state !== 'live') throw fail('closed');
  if (row.last_at != null && ctx.now - row.last_at < MIN_EVERY_MS) return { messageId: msg.id, accepted: false, arrived: false };
  const dist = distance(p, def.dest);
  const startDist = row.start_dist == null ? Math.max(dist, 1) : row.start_dist;
  // speed: the app's value (smoothed) or the progress since the last post; 40 km/h without either
  let s = row.speed_mps;
  let measured = speed;
  if (measured == null && row.distance_m != null && row.last_at != null && ctx.now > row.last_at) {
    const v = (row.distance_m - dist) / ((ctx.now - row.last_at) / 1000);
    if (v > 0.5 && v < 70) measured = v;
  }
  if (measured != null && measured > 0.5) s = s == null ? measured : s * 0.6 + measured * 0.4;
  const useSpeed = s && s > 0.5 ? s : FALLBACK_MPS;
  const progress = Math.max(0, Math.min(1, 1 - dist / startDist));
  const ids = x.members.map((m) => m.user_id);
  if (dist <= row.radius_m) {
    await store.run(ctx.gc, "UPDATE arrivals SET state = 'arrived', distance_m = ?, progress = 1, eta_at = ?, pos_enc = NULL, last_at = ?, ended_at = ?, start_dist = ?, speed_mps = ? WHERE msg_id = ?",
      [dist, ctx.now, ctx.now, ctx.now, startDist, s, msg.id]);
    await arrived(ctx, x, msg, def);
    return { messageId: msg.id, accepted: true, arrived: true };
  }
  await store.run(ctx.gc, 'UPDATE arrivals SET distance_m = ?, start_dist = ?, speed_mps = ?, eta_at = ?, progress = ?, pos_enc = ?, last_at = ? WHERE msg_id = ?',
    [dist, startDist, s, Math.round(ctx.now + (dist / useSpeed) * 1000), progress, seal.sealJson(p), ctx.now, msg.id]);
  await store.run(ctx.gc, 'UPDATE messages SET updated_at = ? WHERE id = ?', [ctx.now, msg.id]);
  queueUpdate(ctx, x.conv.id, ids, msg.id, 'live');
  return { messageId: msg.id, accepted: true, arrived: false };
}

async function arrived(ctx, x, msg, def) {
  const ids = x.members.map((m) => m.user_id);
  const sysId = await messages.system(ctx, x.conv, 'arrived', { userId: ctx.viewer, messageId: msg.id, label: def.dest.label });
  await store.run(ctx.gc, 'UPDATE messages SET updated_at = ? WHERE id = ?', [ctx.now, msg.id]);
  queueUpdate(ctx, x.conv.id, ids, msg.id, 'arrived');
  live.queue(ctx.box, ids, 'message.new', { conversationId: x.conv.id, messageId: sysId, senderId: null, clientId: null, kind: 'system', createdAt: iso(ctx.now) });
  const others = ids.filter((u) => u !== ctx.viewer && ctx.users.has(u));
  if (others.length) ctx.box.pushes.push({ custom: { kind: 'arrived', conv: x.conv, members: x.members, users: others, senderId: ctx.viewer, messageId: sysId, params: { label: def.dest.label }, respectMute: true } });
  // a status auto_place shows the destination
  await require('./status').setPlace(ctx, ctx.viewer, def.dest.label);
  if (def.onArrive) {
    const viewer = ctx.viewer;
    const gc = ctx.gc;
    ctx.box.after.push(async () => {
      const actions = require('./homeactions');
      await actions.runAfterArrival(gc, viewer, x.conv, def.onArrive, msg.id);
    });
  }
}

/** POST messages/:id/arrival/stop */
async function stop(ctx, x, idRaw) {
  const { msg, row } = await load(ctx, x, idRaw);
  if (row.state !== 'live') throw fail('closed');
  await store.run(ctx.gc, "UPDATE arrivals SET state = 'stopped', pos_enc = NULL, eta_at = NULL, ended_at = ? WHERE msg_id = ?", [ctx.now, msg.id]);
  await store.run(ctx.gc, 'UPDATE messages SET updated_at = ? WHERE id = ?', [ctx.now, msg.id]);
  queueUpdate(ctx, x.conv.id, x.members.map((m) => m.user_id), msg.id, 'stopped');
  return msg.id;
}

/** Background: live arrivals older than 3 h stop. */
async function autoStop(ctx) {
  const rows = await store.all(ctx.gc, "SELECT * FROM arrivals WHERE state = 'live' AND started_at <= ? LIMIT 200", [ctx.now - MAX_LIVE_MS]);
  for (const r of rows) {
    await store.run(ctx.gc, "UPDATE arrivals SET state = 'stopped', pos_enc = NULL, eta_at = NULL, ended_at = ? WHERE msg_id = ?", [ctx.now, r.msg_id]);
    await store.run(ctx.gc, 'UPDATE messages SET updated_at = ? WHERE id = ?', [ctx.now, r.msg_id]);
    const members = await store.all(ctx.gc, 'SELECT user_id FROM members WHERE conv_id = ? AND left_at IS NULL', [r.conv_id]);
    queueUpdate(ctx, r.conv_id, members.map((m) => m.user_id), r.msg_id, 'stopped');
  }
  return rows.length;
}

module.exports = { clean, create, decorate, position, stop, autoStop, distance, RADIUS_DEFAULT, FALLBACK_MPS, MAX_LIVE_MS, MIN_EVERY_MS };
