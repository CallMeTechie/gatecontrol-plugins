'use strict';

// 1.27.0 — place messages („Beim Ankommen senden“; feature word placeMessages, README "App-API", since 1.27.0).
// „When I reach Zuhause, send ‚Bin da, Tür ist offen.‘ to Kim Muster.“ A rule of one person, watched by ONE phone
// (deviceId): the phone's geofencing notices the arrival or the departure and calls POST place-messages/:id/fire. The
// server never learns where the person is — it keeps the place sealed for the phone and sends only the finished text,
// marked meta.placeMessage { name, trigger } (no coordinates; only the sender's own view shows the line „Ortsnachricht ·
// Zuhause“). Over WhatsApp only the text arrives.
//
//   target   a chat the person may write into (no channel, no read-only chat), or a person's entry (its lead chat): the
//            way 'auto' follows person.reply, 'gatecontrol' / a network that way (while it cannot send: GateControl)
//   limits   10 active ones per person (limit), once an hour each (too_soon), at most 30 minutes late (expired)
//   places   Familie's places come from the existing GET familie/places — the app copies name and coordinates, the
//            Familie id stays for its picker (familieId); without Familie a place on the map. 1.27.1: Familie's ids are
//            'home' and 'place:<id>' (gatecontrol-familie services places()), so the text id takes ':' and '.' too
//   event    place_messages.changed { id, reason: created | updated | deleted | fired } to the person's own devices
//   1.28.0   „Meine Orte“ (profileplaces.js): place.ref 'profile:<id>' | 'home' | 'place:<id>' next to the old familieId.
//            A profile place is resolved on the server (gc.places, as the person may see it): its name, point and radius
//            are kept as a copy (the fallback); the column place_ref finds the place messages of a place when the hook
//            placesChanged says it changed — then the copy follows (reason 'updated', place: true), a place gone or no longer visible
//            keeps the copy and answers place.missing: true. „Genutzt von“: gc.places.reportUsage location_message.

const store = require('./store');
const seal = require('./seal');
const live = require('./live');
const pp = require('./profileplaces');
const { fail, posInt, line, iso, parseIso } = require('./util');

const ACTIVE_MAX = 10;
const TEXT_MAX = 1000;
const NAME_MAX = 80;
const RADIUS_MIN = 100;
const RADIUS_MAX = 2000;
const RADIUS_DEFAULT = 150;
const EVERY_MS = 3600000;
const LATE_MS = 30 * 60000;
const AHEAD_MS = 5 * 60000;
const DEVICE_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const WAY_RE = /^[a-z]{2,20}$/;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const FAMILIE_ID_RE = /^[A-Za-z0-9_:.-]{1,64}$/;
const KEYS = ['deviceId', 'trigger', 'place', 'text', 'conversationId', 'way', 'repeat', 'window', 'ask', 'enabled', 'bridged', 'channels', 'people'];

const LIMITS = { activeMax: ACTIVE_MAX, textMax: TEXT_MAX, nameMax: NAME_MAX, radiusMinM: RADIUS_MIN, radiusMaxM: RADIUS_MAX, radiusDefaultM: RADIUS_DEFAULT, everyS: EVERY_MS / 1000, lateS: LATE_MS / 1000 };

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

const clampRadius = (r) => Math.min(RADIUS_MAX, Math.max(RADIUS_MIN, Math.round(Number(r) || RADIUS_DEFAULT)));

/** The copy of a profile place (gc.places answer) → { name, lat, lon, radiusM } (radius into 100…2000). */
function copyOf(p) {
  return { name: (line(p.name) || '').slice(0, NAME_MAX) || null, lat: p.lat, lon: p.lon, radiusM: clampRadius(p.radiusM) };
}

/**
 * The place of a body → { ref, familieId, name, lat, lon, radiusM }. 1.28.0: `ref` 'profile:<id>' is resolved as the
 * viewer may see it (invalid when unknown or not visible): name, point and radius come from the profile, the app's copy
 * is not needed. Familie's refs ('home', 'place:<id>') and a bare point keep the app's copy as before. An older app that
 * sends the ref as familieId is understood too.
 */
async function cleanPlace(ctx, v) {
  const p = obj(v);
  if (!p) throw fail('invalid');
  let familieId = null;
  if (p.familieId != null) {
    if (typeof p.familieId === 'number' && posInt(p.familieId)) familieId = p.familieId;
    else if (typeof p.familieId === 'string' && FAMILIE_ID_RE.test(p.familieId)) familieId = p.familieId;
    else throw fail('invalid');
  }
  let ref = pp.cleanRef(p.ref);
  if (ref == null && typeof familieId === 'string' && pp.REF_RE.test(familieId)) ref = familieId;
  if (ref != null && familieId == null && !pp.profileId(ref)) familieId = ref;
  if (ref != null && pp.profileId(ref)) {
    const found = await pp.resolve(ctx.gc, ref, ctx.viewer);
    if (found === null) throw fail('invalid');
    if (found) {
      const c = copyOf(found);
      const name = p.name == null ? c.name : line(p.name);
      if (!name || name.length > NAME_MAX) throw fail('invalid');
      return { ref, familieId, name, lat: c.lat, lon: c.lon, radiusM: c.radiusM };
    }
    // an older GateControl without gc.places: the app's copy, as for any other place
  }
  const name = line(p.name);
  if (!name || name.length > NAME_MAX) throw fail('invalid');
  const num = (x, max) => { if (typeof x !== 'number' || !Number.isFinite(x) || Math.abs(x) > max) throw fail('invalid'); return x; };
  const radius = p.radiusM == null ? RADIUS_DEFAULT : p.radiusM;
  if (!Number.isInteger(radius) || radius < RADIUS_MIN || radius > RADIUS_MAX) throw fail('invalid');
  return { ref, familieId, name, lat: num(p.lat, 90), lon: num(p.lon, 180), radiusM: radius };
}

function cleanText(v) {
  if (typeof v !== 'string') throw fail('invalid');
  const s = v.replace(/\r\n?/g, '\n').replace(/[\0-\x08\x0b-\x1f\x7f]/g, '').replace(/\n{4,}/g, '\n\n\n').trim();
  if (!s || s.length > TEXT_MAX) throw fail('invalid');
  return s;
}

function cleanWindow(v) {
  if (v == null) return null;
  const w = obj(v);
  if (!w || !Array.isArray(w.days) || !w.days.length || w.days.length > 7) throw fail('invalid');
  const days = [];
  for (const d of w.days) {
    if (!Number.isInteger(d) || d < 1 || d > 7) throw fail('invalid');
    if (!days.includes(d)) days.push(d);
  }
  if (!HHMM_RE.test(String(w.from || '')) || !HHMM_RE.test(String(w.to || '')) || w.from === w.to) throw fail('invalid');
  return { days: days.sort((a, b) => a - b), from: w.from, to: w.to };
}

/**
 * The target of a place message: a conversation of the viewer they may write into, and the way. → { conv, way }
 * A person's entry (any of its ways): auto or one of its ways (bad_request: the person has no such way); a chat that is
 * no person: auto or its own way.
 */
async function target(ctx, convRaw, wayRaw) {
  const conversations = require('./conversations');
  const persons = require('./persons');
  const x = await conversations.access(ctx, convRaw);
  const c = x.conv;
  if (c.readonly || c.bridge_channel || c.bridge_read_only) throw fail('readonly');
  const way = wayRaw == null ? 'auto' : wayRaw;
  if (typeof way !== 'string' || !WAY_RE.test(way)) throw fail('invalid');
  const p = await persons.personOf(ctx, c.id);
  if (p) {
    const ways = await persons.waysOf(ctx, p);
    if (way !== 'auto' && !ways.some((w) => persons.wayOf(w.conv) === way)) throw fail('bad_request');
    const lead = persons.leadOf(ways);
    return { conv: lead ? lead.conv : c, way };
  }
  if (way !== 'auto' && way !== persons.wayOf(c)) throw fail('bad_request');
  return { conv: c, way };
}

async function activeCount(ctx, exceptId = 0) {
  const r = await store.one(ctx.gc, 'SELECT COUNT(*) AS n FROM place_messages WHERE user_id = ? AND enabled = 1 AND done_at IS NULL AND id != ?', [ctx.viewer, exceptId]);
  return r ? r.n : 0;
}

async function rowOf(ctx, idRaw) {
  const id = posInt(idRaw);
  const r = id ? await store.one(ctx.gc, 'SELECT * FROM place_messages WHERE id = ? AND user_id = ?', [id, ctx.viewer]) : null;
  if (!r) throw fail('not_found');
  return r;
}

/** The title of the target (the person's name, the chat's title) and the person — best effort. */
async function targetInfo(ctx, convId) {
  const conversations = require('./conversations');
  const persons = require('./persons');
  try {
    const p = await persons.personOf(ctx, convId);
    if (p) {
      const e = await persons.entryOf(ctx, p);
      if (e) return { title: e.title || null, personId: p.id, reply: e.person.reply || null };
    }
    const x = await conversations.access(ctx, convId);
    const v = await conversations.view(ctx, x.conv, x.me, x.members);
    return { title: v.title || null, personId: null, reply: null };
  } catch { return { title: null, personId: null, reply: null }; }
}

async function view(ctx, r) {
  const place = seal.openJson(r.place_enc) || {};
  const t = seal.open(r.text_enc);
  let win = null;
  try { win = r.window_json ? JSON.parse(r.window_json) : null; } catch { win = null; }
  const info = await targetInfo(ctx, r.conv_id);
  return {
    id: r.id, deviceId: r.device_id, trigger: r.trig,
    place: {
      ref: place.ref || r.place_ref || null, source: pp.sourceOf(place.ref || r.place_ref || null),
      familieId: place.familieId != null ? place.familieId : null, name: place.name || null, lat: place.lat, lon: place.lon, radiusM: place.radiusM || RADIUS_DEFAULT,
      // 1.28.0: the profile place went or is not visible any more — the copy still holds, the app offers to choose again
      missing: !!r.place_missing,
    },
    text: typeof t === 'string' ? t : null,
    conversationId: r.conv_id, way: r.way, repeat: r.repeat, window: win, ask: !!r.ask, enabled: !!r.enabled,
    lastFiredAt: iso(r.last_fired_at), doneAt: iso(r.done_at), createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
    // what the overview shows: „an Kim Muster · Automatisch · gerade WhatsApp“
    target: { title: info.title, personId: info.personId, reply: r.way === 'auto' ? info.reply : null },
  };
}

function changed(ctx, id, reason) {
  live.queue(ctx.box, [ctx.viewer], 'place_messages.changed', { id, reason });
}

/** GET place-messages → { placeMessages (newest first), limits } */
async function list(ctx) {
  const rows = await store.all(ctx.gc, 'SELECT * FROM place_messages WHERE user_id = ? ORDER BY id DESC', [ctx.viewer]);
  const out = [];
  for (const r of rows) out.push(await view(ctx, r));
  return { placeMessages: out, limits: LIMITS, serverTime: iso(ctx.now) };
}

/** POST place-messages → { placeMessage } */
async function create(ctx, body) {
  const b = obj(body);
  if (!b) throw fail('invalid');
  for (const k of Object.keys(b)) if (!KEYS.includes(k)) throw fail('invalid');
  if (typeof b.deviceId !== 'string' || !DEVICE_RE.test(b.deviceId)) throw fail('invalid');
  if (b.trigger !== 'enter' && b.trigger !== 'exit') throw fail('invalid');
  const place = await cleanPlace(ctx, b.place);
  const text = cleanText(b.text);
  const tg = await target(ctx, b.conversationId, b.way);
  const repeat = b.repeat == null ? 'once' : b.repeat;
  if (repeat !== 'once' && repeat !== 'always') throw fail('invalid');
  const win = cleanWindow(b.window);
  if (b.ask != null && typeof b.ask !== 'boolean') throw fail('invalid');
  if (b.enabled != null && typeof b.enabled !== 'boolean') throw fail('invalid');
  const enabled = b.enabled !== false;
  if (enabled && (await activeCount(ctx)) >= ACTIVE_MAX) throw fail('limit');
  const r = await store.run(ctx.gc, `INSERT INTO place_messages (user_id, device_id, trig, place_enc, text_enc, conv_id, way, repeat, window_json, ask, enabled, created_at, updated_at, place_ref, place_missing)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  [ctx.viewer, b.deviceId, b.trigger, seal.sealJson(place), seal.seal(text), tg.conv.id, tg.way, repeat, win ? JSON.stringify(win) : null, b.ask === false ? 0 : 1, enabled ? 1 : 0, ctx.now, ctx.now, place.ref]);
  changed(ctx, r.lastInsertRowid, 'created');
  await pp.used(ctx, place.ref);
  pp.afterSave(ctx, { used: place.ref });
  return { placeMessage: await view(ctx, await rowOf(ctx, r.lastInsertRowid)) };
}

/** PUT place-messages/:id { any of the fields } → { placeMessage }. Switching one on again starts it afresh (doneAt null). */
async function update(ctx, idRaw, body) {
  const row = await rowOf(ctx, idRaw);
  const b = obj(body);
  if (!b) throw fail('invalid');
  for (const k of Object.keys(b)) if (!KEYS.includes(k)) throw fail('invalid');
  const set = {};
  if (b.deviceId !== undefined) { if (typeof b.deviceId !== 'string' || !DEVICE_RE.test(b.deviceId)) throw fail('invalid'); set.device_id = b.deviceId; }
  if (b.trigger !== undefined) { if (b.trigger !== 'enter' && b.trigger !== 'exit') throw fail('invalid'); set.trig = b.trigger; }
  let place = null;
  if (b.place !== undefined) {
    place = await cleanPlace(ctx, b.place);
    set.place_enc = seal.sealJson(place);
    set.place_ref = place.ref;
    set.place_missing = 0;
  }
  if (b.text !== undefined) set.text_enc = seal.seal(cleanText(b.text));
  if (b.conversationId !== undefined || b.way !== undefined) {
    const tg = await target(ctx, b.conversationId !== undefined ? b.conversationId : row.conv_id, b.way !== undefined ? b.way : row.way);
    set.conv_id = tg.conv.id;
    set.way = tg.way;
  }
  if (b.repeat !== undefined) { if (b.repeat !== 'once' && b.repeat !== 'always') throw fail('invalid'); set.repeat = b.repeat; }
  if (b.window !== undefined) { const w = cleanWindow(b.window); set.window_json = w ? JSON.stringify(w) : null; }
  if (b.ask !== undefined) { if (typeof b.ask !== 'boolean') throw fail('invalid'); set.ask = b.ask ? 1 : 0; }
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== 'boolean') throw fail('invalid');
    set.enabled = b.enabled ? 1 : 0;
    if (b.enabled) {
      set.done_at = null;
      if ((await activeCount(ctx, row.id)) >= ACTIVE_MAX) throw fail('limit');
    }
  }
  const keys = Object.keys(set);
  if (keys.length) {
    await store.run(ctx.gc, `UPDATE place_messages SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, [...keys.map((k) => set[k]), ctx.now, row.id]);
    changed(ctx, row.id, 'updated');
  }
  if (place) {
    await pp.used(ctx, place.ref);
    pp.afterSave(ctx, { used: place.ref, refs: [row.place_ref] });
  }
  return { placeMessage: await view(ctx, await rowOf(ctx, row.id)) };
}

/** DELETE place-messages/:id → { deleted: true } */
async function remove(ctx, idRaw) {
  const row = await rowOf(ctx, idRaw);
  await store.run(ctx.gc, 'DELETE FROM place_messages WHERE id = ?', [row.id]);
  changed(ctx, row.id, 'deleted');
  pp.afterSave(ctx, { refs: [row.place_ref] });
  return { deleted: true, id: row.id };
}

/** Where a firing goes → the conversation id: the person's reply way (auto), the way named (while it can send), else the chat. */
async function sendTo(ctx, row) {
  const persons = require('./persons');
  const p = await persons.personOf(ctx, row.conv_id);
  if (!p) return row.conv_id;
  const e = await persons.entryOf(ctx, p);
  if (!e || !e.person.reply) throw fail('not_found');
  if (row.way === 'auto') return e.person.reply.conversationId;
  const w = e.person.ways.find((x) => x.way === row.way);
  if (w && w.can.send) return w.conversationId;
  const gcw = e.person.ways.find((x) => x.way === persons.GC_WAY);
  return gcw ? gcw.conversationId : (w ? w.conversationId : e.person.reply.conversationId);
}

/**
 * POST place-messages/:id/fire { at, deviceId } → { placeMessage, message, duplicate, way, conversationId } — the phone
 * reached (or left) the place at `at`: the text goes out now, like a message from the composer. The same `at` again sends
 * nothing new (duplicate). `route` is api.route (sending through it checks the chat as every message does).
 */
async function fire(ctx, idRaw, body, route) {
  const row = await rowOf(ctx, idRaw);
  const b = obj(body) || {};
  const at = parseIso(typeof b.at === 'string' ? b.at : '');
  if (at == null || at > ctx.now + AHEAD_MS) throw fail('invalid');
  if (typeof b.deviceId !== 'string' || !DEVICE_RE.test(b.deviceId)) throw fail('invalid');
  if (b.deviceId !== row.device_id) throw fail('not_allowed');
  const again = row.last_fired_at != null && row.last_fired_at === at;
  if (!again) {
    if (!row.enabled || row.done_at != null) throw fail('closed');
    if (ctx.now - at > LATE_MS) throw fail('expired');
    if (row.last_fired_at != null && Math.abs(at - row.last_fired_at) < EVERY_MS) throw fail('too_soon');
  }
  const place = seal.openJson(row.place_enc) || {};
  const text = seal.open(row.text_enc);
  if (typeof text !== 'string' || !text) throw fail('invalid');
  const convId = await store.tx(ctx.gc, () => sendTo(ctx, row));
  ctx.placeMessage = { name: place.name || null, trigger: row.trig };
  let r;
  try {
    r = await route(ctx, { method: 'POST', body: { clientId: `place-${row.id}-${at}`, kind: 'text', text }, query: {} }, ['conversations', String(convId), 'messages']);
  } finally { ctx.placeMessage = null; }
  const res = await store.tx(ctx.gc, async () => {
    if (!again) {
      await store.run(ctx.gc, 'UPDATE place_messages SET last_fired_at = ?, done_at = ?, enabled = ?, updated_at = ? WHERE id = ?',
        [at, row.repeat === 'once' ? ctx.now : row.done_at, row.repeat === 'once' ? 0 : row.enabled, ctx.now, row.id]);
      changed(ctx, row.id, 'fired');
    }
    return view(ctx, await rowOf(ctx, row.id));
  });
  const msg = r && r.json ? r.json.message : null;
  const persons = require('./persons');
  const conv = await store.one(ctx.gc, 'SELECT bridge_net FROM conversations WHERE id = ?', [convId]);
  return { placeMessage: res, message: msg, duplicate: !!(r && r.json && r.json.duplicate), way: persons.wayOf(conv), conversationId: convId };
}

/** The routes place-messages[/:id[/fire]] → the answer's body, or null (not this file's). */
async function route(ctx, req, seg, tx, apiRoute) {
  if (seg[0] !== 'place-messages') return null;
  const m = String(req.method || 'GET').toUpperCase();
  // a client that knows place messages knows bridged chats and persons (their targets)
  ctx.bridged = true;
  ctx.people = true;
  if (seg.length === 1 && m === 'GET') return tx(() => list(ctx));
  if (seg.length === 1 && m === 'POST') return tx(() => create(ctx, req.body));
  if (seg.length === 2 && (m === 'PUT' || m === 'PATCH')) return tx(() => update(ctx, seg[1], req.body));
  if (seg.length === 2 && m === 'DELETE') return tx(() => remove(ctx, seg[1]));
  if (seg.length === 3 && seg[2] === 'fire' && m === 'POST') return fire(ctx, seg[1], req.body, apiRoute);
  throw fail('not_found');
}

/** Place messages whose chat went (the plugin's clean-up) → the profile refs they had (for „Genutzt von“). */
async function tidy(gc) {
  const gone = await store.all(gc, 'SELECT DISTINCT user_id, place_ref FROM place_messages WHERE place_ref IS NOT NULL AND conv_id NOT IN (SELECT id FROM conversations)');
  await store.run(gc, 'DELETE FROM place_messages WHERE conv_id NOT IN (SELECT id FROM conversations)');
  return gone.filter((r) => pp.profileId(r.place_ref));
}

/**
 * 1.28.0 — the hook placesChanged: the place messages at these profile refs take the place's new name, point and radius
 * as the owner of each place message may see it; a place that went (deleted) or is not visible to them any more keeps
 * the copy and is marked missing. → how many changed (event place_messages.changed { id, reason: 'updated', place: true }).
 */
async function placesChanged(ctx, refs, deleted) {
  const gc = ctx.gc;
  const rows = await store.all(gc, `SELECT id, user_id, place_enc, place_ref, place_missing FROM place_messages WHERE place_ref IN (${refs.map(() => '?').join(',')})`, refs);
  const looked = new Map();
  const plan = [];
  for (const r of rows) {
    const key = `${r.user_id}|${r.place_ref}`;
    if (!looked.has(key)) {
      let found = null;
      if (!deleted) { try { found = await pp.resolve(gc, r.place_ref, r.user_id); } catch { found = undefined; } }
      looked.set(key, found);
    }
    const found = looked.get(key);
    if (found === undefined) continue; // the host did not answer — keep everything as it is
    const old = seal.openJson(r.place_enc) || {};
    if (found) {
      const c = copyOf(found);
      const next = { ...old, ref: r.place_ref, name: c.name || old.name, lat: c.lat, lon: c.lon, radiusM: c.radiusM };
      const same = next.name === old.name && next.lat === old.lat && next.lon === old.lon && next.radiusM === old.radiusM;
      if (same && !r.place_missing) continue;
      plan.push({ r, enc: seal.sealJson(next), missing: 0 });
    } else if (!r.place_missing) {
      plan.push({ r, enc: r.place_enc, missing: 1 });
    }
  }
  if (!plan.length) return 0;
  await store.tx(gc, async () => {
    for (const x of plan) {
      await store.run(gc, 'UPDATE place_messages SET place_enc = ?, place_missing = ?, updated_at = ? WHERE id = ?', [x.enc, x.missing, ctx.now, x.r.id]);
      live.queue(ctx.box, [x.r.user_id], 'place_messages.changed', { id: x.r.id, reason: 'updated', place: true });
    }
  });
  return plan.length;
}

module.exports = { route, list, create, update, remove, fire, tidy, placesChanged, LIMITS, ACTIVE_MAX };
