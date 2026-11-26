'use strict';

// "Auf TV/PC abspielen" (question 38 a): the phone (controller) and the TV/PC (receiver) of the same person exchange
// the cast messages of the cast contract version 1 (cast.play, cast.cmd, cast.state) through the plugin instead of
// GateDrop texts. The plugin only checks and forwards: both devices belong to the asking person, the person has the
// right "Medien", a cast.play names a source of the plugin the person sees, no secrets, size and rate limits.
//
// Transport to exactly one device:
//   * the target's push stream is open (gc.devices.list online) → a realtime event `media.cast` to the person's open
//     apps (gc.events.emit: ephemeral, 600 per minute, ~instant); every app but the addressed one ignores it (`to`);
//   * a cast.play, a cast.cmd "stop" and anything to a device that is not online → also/only a silent signal push
//     (topic media_signal, kind 'media.cast'), which a device that is offline gets when it connects (the receiver
//     drops a cast.play older than 120 s, contract 3.3). The 600 silent pushes per hour and plugin are the scarce
//     resource, so the frequent messages (state, commands) go as events while the target is online.
// The receiver de-duplicates by session + seq (a message may arrive on both ways).

const crypto = require('node:crypto');
const store = require('./store');
const sources = require('./sources');
const rights = require('./rights');
const devices = require('./devices');
const { fail, str, deviceIdOf, sourceIdOf } = require('./util');

const SESSION_RE = /^[A-Za-z0-9_-]{8,40}$/;
const TYPES = ['cast.play', 'cast.cmd', 'cast.state'];
const CMDS = ['play', 'pause', 'seek', 'seekBy', 'audio', 'subtitle', 'stop', 'status'];
const MAX_BYTES = 3000;
const PER_MINUTE = 60;
const PER_HOUR = 600;
const SECRET_KEY = /token|password|passwort|secret|apikey|api_key|accesstoken|authorization/i;

const isReceiver = (d) => d.clientType === 'android-tv' || d.platform === 'windows';

function hasSecretKey(v, depth = 0) {
  if (depth > 6 || v == null || typeof v !== 'object') return false;
  if (Array.isArray(v)) return v.some((x) => hasSecretKey(x, depth + 1));
  return Object.keys(v).some((k) => SECRET_KEY.test(k) || hasSecretKey(v[k], depth + 1));
}

async function own(gc, user) {
  const list = await devices.listOf(gc, user.id);
  if (list == null) throw fail('internal');
  return list;
}

async function needCast(gc, user, cfg) {
  if (!cfg.cast) throw fail('forbidden');
  if (!(await rights.mediaOf(gc, user)).media) throw fail('no_access');
}

/** GET v1/cast/targets — the person's TVs (GateControl TV) and PCs (GateControl for Windows), online first. */
async function targets(gc, req, cfg) {
  await needCast(gc, req.user, cfg);
  const me = req.user.device && deviceIdOf(req.user.device.id);
  const list = (await own(gc, req.user)).filter((d) => deviceIdOf(d.id) && deviceIdOf(d.id) !== me && isReceiver(d));
  list.sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0) || String(a.name).localeCompare(String(b.name)));
  return { v: 1, deviceId: me || null, devices: list.map((d) => ({ id: String(d.id), name: d.name || null, kind: d.clientType === 'android-tv' ? 'tv' : 'pc', clientType: d.clientType || null, online: !!d.online, lastSeen: d.lastSeen || null })) };
}

/** Check a message of the cast contract (section 2); cast.play carries source: { id } of the plugin. */
async function checkBody(gc, user, session, body, cfg) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('invalid', { field: 'body' });
  if (body.v !== 1 || !TYPES.includes(body.type) || body.session !== session) throw fail('invalid', { field: 'body' });
  if (!Number.isSafeInteger(body.seq) || body.seq < 0 || !Number.isSafeInteger(body.at) || body.at < 0) throw fail('invalid', { field: 'body' });
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_BYTES) throw fail('too_large');
  if (hasSecretKey(body)) throw fail('invalid', { field: 'body', reason: 'secret' });
  if (body.type === 'cast.cmd' && !CMDS.includes(body.cmd)) throw fail('invalid', { field: 'cmd' });
  if (body.type === 'cast.play') {
    const sid = sourceIdOf(body.source && body.source.id);
    const src = sid ? await sources.get(gc, sid) : null;
    if (!src || !src.enabled || !(await rights.sourceAccess(gc, user, src, cfg)).allowed) throw fail('no_access');
    if (!body.item || typeof body.item !== 'object' || !str(body.item.id, 200)) throw fail('invalid', { field: 'item' });
  }
}

/** Forward one message to exactly one other device of the same person. */
async function send(gc, user, session, to, body, cfg, now) {
  const from = user.device && deviceIdOf(user.device.id);
  if (!from) throw fail('no_device');
  if (!SESSION_RE.test(String(session || ''))) throw fail('invalid', { field: 'session' });
  const target = deviceIdOf(to);
  if (!target || target === from) throw fail('invalid', { field: 'to' });
  await needCast(gc, user, cfg);
  const list = await own(gc, user);
  const t = list.find((d) => String(d.id) === target);
  if (!t) throw fail('no_access');
  await checkBody(gc, user, session, body, cfg);
  if (!(await store.hit(gc, 'cast:m:' + from, PER_MINUTE, 60000, now)) || !(await store.hit(gc, 'cast:h:' + from, PER_HOUR, 3600000, now))) throw fail('rate_limited');
  const me = list.find((d) => String(d.id) === from);
  const data = { kind: 'media.cast', from, fromName: (me && me.name) || null, to: target, session, body };
  const via = [];
  if (t.online && gc.events && typeof gc.events.emit === 'function') {
    try {
      const r = await gc.events.emit({ users: [user.id], type: 'media.cast', data });
      if (r && r.delivered > 0) via.push('event');
    } catch (e) { gc.log.debug('cast event not sent', (e && e.code) || 'error'); }
  }
  const pushToo = body.type === 'cast.play' || (body.type === 'cast.cmd' && body.cmd === 'stop') || !via.length;
  if (pushToo && (await devices.signal(gc, user.id, [target], data))) via.push('push');
  if (!via.length) throw fail('rate_limited', { reason: 'not_delivered' });
  return { v: 1, via, online: !!t.online };
}

/** POST v1/cast/{session}/message { to, body } */
async function message(gc, req, session, cfg, now) {
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  return send(gc, req.user, session, b.to, b.body, cfg, now);
}

/** POST v1/handoff { to, sourceId, item, positionMs?, audio?, subtitle?, session? } — a cast.play built by the plugin. */
async function handoff(gc, req, cfg, now) {
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const session = SESSION_RE.test(String(b.session || '')) ? b.session : crypto.randomBytes(12).toString('hex');
  const item = b.item && typeof b.item === 'object' ? b.item : (b.itemId ? { id: b.itemId } : null);
  const body = { v: 1, session, seq: 0, at: now, type: 'cast.play', source: { id: b.sourceId }, item,
    ...(Number.isSafeInteger(b.positionMs) && b.positionMs >= 0 ? { positionMs: b.positionMs } : {}),
    ...(Number.isSafeInteger(b.audio) ? { audio: b.audio } : {}), ...(Number.isSafeInteger(b.subtitle) ? { subtitle: b.subtitle } : {}),
    ...(str(b.from, 60) ? { from: str(b.from, 60) } : {}) };
  const r = await send(gc, req.user, session, b.to, body, cfg, now);
  return { ...r, session };
}

module.exports = { targets, message, handoff, send, isReceiver, MAX_BYTES };
