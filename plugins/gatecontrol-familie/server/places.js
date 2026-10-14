'use strict';

// Place reminders. The geofencing runs on the target's phone; the server
// keeps the places, asks for consent when someone else sets a reminder for a
// person ("Anna möchte dich erinnern: …") and tells the family when a
// reminder with action 'tell' fires.
//
//   GET    places                         where I am owner or target
//   POST   places                         any member (targetUserId defaults to me)
//   PATCH  places/<id>                    owner (a change of a reminder for someone else → consent pending again)
//   DELETE places/<id>                    owner or target
//   POST   places/<id>/consent {accept}   target
//   POST   places/<id>/triggered {transition, at}   the target's app on a geofence transition
//
// At most 50 active places per target person (Android allows 100 geofences
// per app). Transitions are logged 90 days (no coordinates).

const store = require('./store');
const push = require('./push');
const shoppingIds = require('./shopping').ID_RE;
const { fail, posInt, text, multiline, bool, intIn, numIn, iso, parseIso, userIds, parseJson } = require('./util');

const TITLE_MAX = 60;
const NOTE_MAX = 500;
const MAX_ACTIVE = 50;
const TRIGGERS = ['enter', 'exit'];
const ACTIONS = ['note', 'list', 'tell'];
const REPEATS = ['once', 'always'];
const CONSENTS = ['accepted', 'pending', 'declined'];
const DEDUPE_MS = 60000;
const EVENT_DAYS = 90;
const DAY = 86400000;

function rowToPlace(r) {
  return {
    id: r.id, ownerId: r.owner_id, targetUserId: r.target_user_id, title: r.title, note: r.note || '', lat: r.lat, lon: r.lon, radius: r.radius,
    trigger: r.trigger_on, action: r.action_kind, listId: r.list_id || null, tellUserIds: parseJson(r.tell_json, []), repeat: r.repeat,
    active: !!r.active, consent: CONSENTS.includes(r.consent) ? r.consent : 'pending',
    createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), lastTriggeredAt: iso(r.last_triggered_at),
  };
}

function view(p, fam) {
  const name = (id) => { const m = fam.byId.get(id); return m ? m.name : null; };
  return { ...p, tellUserIds: p.tellUserIds.filter((id) => fam.byId.has(id)), ownerName: name(p.ownerId), targetName: name(p.targetUserId) };
}

async function getPlace(gc, id) {
  const r = await store.one(gc, 'SELECT * FROM places WHERE id = ?', [id]);
  return r ? rowToPlace(r) : null;
}

/** GET places */
async function list(gc, r) {
  const rows = await store.all(gc, 'SELECT * FROM places WHERE owner_id = ? OR target_user_id = ? ORDER BY id', [r.me.userId, r.me.userId]);
  return { places: rows.map((x) => view(rowToPlace(x), r.fam)) };
}

async function fields(gc, body, existing, r) {
  const b = body || {};
  const cur = existing || {};
  const out = {};
  out.title = b.title !== undefined || !existing ? text(b.title, TITLE_MAX) : cur.title;
  if (b.note !== undefined) {
    const n = b.note == null ? '' : multiline(b.note);
    if (n == null || n.length > NOTE_MAX) throw fail('invalid');
    out.note = n;
  } else out.note = existing ? cur.note : '';
  out.lat = b.lat !== undefined || !existing ? numIn(b.lat, -90, 90) : cur.lat;
  out.lon = b.lon !== undefined || !existing ? numIn(b.lon, -180, 180) : cur.lon;
  out.radius = b.radius !== undefined ? intIn(Math.round(Number(b.radius)), 50, 2000) : (existing ? cur.radius : 150);
  out.trigger = b.trigger !== undefined ? b.trigger : (cur.trigger || 'enter');
  if (!TRIGGERS.includes(out.trigger)) throw fail('invalid');
  out.action = b.action !== undefined ? b.action : (cur.action || 'note');
  if (!ACTIONS.includes(out.action)) throw fail('invalid');
  out.repeat = b.repeat !== undefined ? b.repeat : (cur.repeat || 'always');
  if (!REPEATS.includes(out.repeat)) throw fail('invalid');
  out.active = b.active !== undefined ? bool(b.active) : (existing ? cur.active : true);
  let target = existing ? cur.targetUserId : r.me.userId;
  if (b.targetUserId !== undefined && b.targetUserId !== null) {
    target = posInt(b.targetUserId);
    if (!target) throw fail('invalid');
  }
  if (!r.fam.byId.has(target)) throw fail('invalid');
  out.targetUserId = target;
  out.listId = null;
  if (out.action === 'list') {
    const id = b.listId !== undefined ? b.listId : cur.listId;
    if (typeof id !== 'string' || !shoppingIds.test(id)) throw fail('invalid');
    const l = await store.one(gc, 'SELECT deleted FROM shop_lists WHERE id = ?', [id]);
    if (!l || l.deleted) throw fail('invalid');
    out.listId = id;
  }
  out.tellUserIds = [];
  if (out.action === 'tell') {
    const ids = b.tellUserIds !== undefined ? userIds(b.tellUserIds, 20) : (cur.tellUserIds || []);
    if (!ids.length || ids.some((id) => !r.fam.byId.has(id))) throw fail('invalid');
    out.tellUserIds = ids;
  }
  return out;
}

async function activeCount(gc, target, exceptId) {
  return (await store.one(gc, "SELECT COUNT(*) AS n FROM places WHERE target_user_id = ? AND active = 1 AND consent != 'declined' AND id != ?", [target, exceptId || 0])).n;
}

function consentPush(r, id, target, title) {
  r.pushes.push({
    topic: 'places', users: [target], priority: 'normal', collapseKey: `place:${id}`, ttl: 7 * 86400,
    title: push.t(r.cfg.lang, 'place.consent', { name: r.me.name, title }), body: push.t(r.cfg.lang, 'place.consent_body'),
    data: { familie: { type: 'place_consent', placeId: id } },
  });
}

/** POST places */
async function create(gc, r) {
  const f = await fields(gc, r.body, null, r);
  if (f.active && await activeCount(gc, f.targetUserId) >= MAX_ACTIVE) throw fail('too_many_places');
  const consent = f.targetUserId === r.me.userId ? 'accepted' : 'pending';
  const res = await store.run(gc, `INSERT INTO places (owner_id, target_user_id, title, note, lat, lon, radius, trigger_on, action_kind, list_id, tell_json, repeat, active, consent, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [r.me.userId, f.targetUserId, f.title, f.note, f.lat, f.lon, f.radius, f.trigger, f.action, f.listId, JSON.stringify(f.tellUserIds), f.repeat, f.active ? 1 : 0, consent, r.now, r.now]);
  const id = res.lastInsertRowid;
  if (consent === 'pending') consentPush(r, id, f.targetUserId, f.title);
  return { place: view(await getPlace(gc, id), r.fam) };
}

/** PATCH places/<id> (owner) */
async function update(gc, r, rawId) {
  const id = posInt(rawId);
  const p = id ? await getPlace(gc, id) : null;
  if (!p || (p.ownerId !== r.me.userId && p.targetUserId !== r.me.userId)) throw fail('not_found');
  if (p.ownerId !== r.me.userId) throw fail('forbidden');
  const f = await fields(gc, r.body, p, r);
  if (f.active && (!p.active || f.targetUserId !== p.targetUserId) && await activeCount(gc, f.targetUserId, id) >= MAX_ACTIVE) throw fail('too_many_places');
  const changed = ['title', 'note', 'lat', 'lon', 'radius', 'trigger', 'action', 'repeat', 'targetUserId', 'listId'].some((k) => f[k] !== p[k])
    || JSON.stringify(f.tellUserIds) !== JSON.stringify(p.tellUserIds) || (f.active && !p.active);
  let consent = p.consent;
  if (f.targetUserId === r.me.userId) consent = 'accepted';
  else if (changed) consent = 'pending';
  await store.run(gc, `UPDATE places SET target_user_id = ?, title = ?, note = ?, lat = ?, lon = ?, radius = ?, trigger_on = ?, action_kind = ?, list_id = ?, tell_json = ?, repeat = ?, active = ?, consent = ?, updated_at = ? WHERE id = ?`,
    [f.targetUserId, f.title, f.note, f.lat, f.lon, f.radius, f.trigger, f.action, f.listId, JSON.stringify(f.tellUserIds), f.repeat, f.active ? 1 : 0, consent, r.now, id]);
  if (consent === 'pending' && changed) consentPush(r, id, f.targetUserId, f.title);
  return { place: view(await getPlace(gc, id), r.fam) };
}

/** DELETE places/<id> (owner or target) */
async function remove(gc, r, rawId) {
  const id = posInt(rawId);
  const p = id ? await getPlace(gc, id) : null;
  if (!p || (p.ownerId !== r.me.userId && p.targetUserId !== r.me.userId)) throw fail('not_found');
  await store.run(gc, 'DELETE FROM places WHERE id = ?', [id]);
  return {};
}

/** POST places/<id>/consent { accept } (target) */
async function consent(gc, r, rawId) {
  const id = posInt(rawId);
  const p = id ? await getPlace(gc, id) : null;
  if (!p || (p.ownerId !== r.me.userId && p.targetUserId !== r.me.userId)) throw fail('not_found');
  if (p.targetUserId !== r.me.userId) throw fail('forbidden');
  const accept = bool(r.body && r.body.accept);
  if (accept && p.active && p.consent === 'declined' && await activeCount(gc, p.targetUserId, id) >= MAX_ACTIVE) throw fail('too_many_places');
  await store.run(gc, 'UPDATE places SET consent = ?, updated_at = ? WHERE id = ?', [accept ? 'accepted' : 'declined', r.now, id]);
  return { place: view(await getPlace(gc, id), r.fam) };
}

/** POST places/<id>/triggered { transition, at } (target's app) */
async function triggered(gc, r, rawId) {
  const id = posInt(rawId);
  const p = id ? await getPlace(gc, id) : null;
  if (!p || (p.ownerId !== r.me.userId && p.targetUserId !== r.me.userId)) throw fail('not_found');
  if (p.targetUserId !== r.me.userId) throw fail('forbidden');
  const b = r.body || {};
  if (!TRIGGERS.includes(b.transition)) throw fail('invalid');
  let at = b.at == null ? r.now : parseIso(b.at);
  if (at == null) throw fail('invalid');
  if (at > r.now + 5 * 60000) at = r.now;
  const live = p.active && p.consent === 'accepted' && b.transition === p.trigger;
  const prev = await store.one(gc, 'SELECT at FROM place_events WHERE place_id = ? AND transition = ? ORDER BY at DESC, id DESC LIMIT 1', [id, b.transition]);
  const repeat = !!(prev && Math.abs(at - prev.at) < DEDUPE_MS);
  let told = 0;
  if (live && !repeat && p.action === 'tell') {
    const to = p.tellUserIds.filter((u) => u !== r.me.userId && r.fam.byId.has(u));
    if (to.length) {
      r.pushes.push({
        topic: 'places', users: to, priority: 'normal', collapseKey: `placetell:${id}`, ttl: 6 * 3600,
        title: push.t(r.cfg.lang, b.transition === 'exit' ? 'place.left' : 'place.entered', { name: r.me.name, title: p.title }),
        body: p.note ? p.note.split('\n')[0].slice(0, 200) : undefined,
        data: { familie: { type: 'place_tell', placeId: id, userId: r.me.userId, transition: b.transition } },
      });
      told = to.length;
    }
  }
  await store.run(gc, 'INSERT INTO place_events (place_id, user_id, title, transition, at, told) VALUES (?, ?, ?, ?, ?, ?)', [id, r.me.userId, p.title, b.transition, at, told]);
  const deactivate = live && !repeat && p.repeat === 'once';
  await store.run(gc, `UPDATE places SET last_triggered_at = ?${deactivate ? ', active = 0' : ''} WHERE id = ?`, [at, id]);
  return { place: view(await getPlace(gc, id), r.fam), told, repeated: repeat };
}

async function purge(gc, now) {
  await store.run(gc, 'DELETE FROM place_events WHERE at < ?', [now - EVENT_DAYS * DAY]);
}

module.exports = { MAX_ACTIVE, list, create, update, remove, consent, triggered, purge, view, rowToPlace };
