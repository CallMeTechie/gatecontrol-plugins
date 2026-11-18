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
//
// 1.30.0 — „Meine Orte“ (server/profileplaces.js): `ref: 'profile:<id>'` makes a place of a person's profile the
// reminder's place, as its owner may see it: lat / lon / radius are taken over (radius into 50–2000) and the title
// defaults to the place's name. The reference and the copy are kept; the hook placesChanged moves the copy along (the
// target's phone watches the new point), a place that went or is not visible any more keeps the copy (missing: true).
// A PATCH with lat / lon and without ref drops the link (`ref: null` too). „Genutzt von“: reportUsage kind reminder.

const store = require('./store');
const push = require('./push');
const shoppingIds = require('./shopping').ID_RE;
const hubmark = require('./hubmark');
const pp = require('./profileplaces');
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
const GONE_KEEP_DAYS = 30;

function rowToPlace(r) {
  return {
    id: r.id, ownerId: r.owner_id, targetUserId: r.target_user_id, title: r.title, note: r.note || '', lat: r.lat, lon: r.lon, radius: r.radius,
    trigger: r.trigger_on, action: r.action_kind, listId: r.list_id || null, tellUserIds: parseJson(r.tell_json, []), repeat: r.repeat,
    active: !!r.active, consent: CONSENTS.includes(r.consent) ? r.consent : 'pending',
    createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), lastTriggeredAt: iso(r.last_triggered_at),
    // 1.30.0: a place of a person's profile, and whether it went (the copy above still holds)
    ref: r.place_ref || null, missing: !!r.place_missing,
  };
}

/**
 * 1.24.0: where the reminder lives for the phone of its target — 'notizen': the hub hands it to that phone as a task at a
 * place (Familie says active false, so no phone watches it twice); 'familie': as ever (also for a moved reminder whose
 * person's phone does not ask the hub: an older app).
 */
async function homed(gc, x, p, now) {
  const served = await hubmark.hubServes(gc, x, now);
  return { ...p, active: served ? false : p.active, home: served ? 'notizen' : 'familie', moved: x.in_hub === 1 };
}

function view(p, fam) {
  const name = (id) => { const m = fam.byId.get(id); return m ? m.name : null; };
  return { ...p, tellUserIds: p.tellUserIds.filter((id) => fam.byId.has(id)), ownerName: name(p.ownerId), targetName: name(p.targetUserId) };
}

async function getPlace(gc, id) {
  const r = await store.one(gc, 'SELECT * FROM places WHERE id = ? AND gone_at IS NULL', [id]);
  return r ? rowToPlace(r) : null;
}

/** GET places */
async function list(gc, r) {
  const rows = await store.all(gc, 'SELECT * FROM places WHERE (owner_id = ? OR target_user_id = ?) AND gone_at IS NULL ORDER BY id', [r.me.userId, r.me.userId]);
  const out = [];
  for (const x of rows) out.push(await homed(gc, x, view(rowToPlace(x), r.fam), r.now));
  return { places: out };
}

async function fields(gc, body, existing, r) {
  const b = { ...(body || {}) };
  const cur = existing || {};
  const out = {};
  // 1.30.0: a profile place → its point and radius (and, without a title, its name)
  out.ref = existing ? cur.ref : null;
  if (b.ref !== undefined) {
    out.ref = pp.cleanRef(b.ref);
    if (out.ref) {
      const p = await pp.resolve(gc, out.ref, r.me.userId);
      if (!p) throw fail('invalid', { field: 'ref' });
      b.lat = p.lat;
      b.lon = p.lon;
      b.radius = Math.min(2000, Math.max(50, Math.round(Number(p.radiusM) || 150)));
      if (b.title === undefined && !existing) b.title = String(p.name || '').slice(0, TITLE_MAX);
    }
  } else if (existing && (b.lat !== undefined || b.lon !== undefined)) out.ref = null; // a point set by hand drops the link
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

/**
 * 1.24.0: after a reminder was made or changed while the hub owns them — one that can live there (it tells nobody: those
 * stay Familie's) goes there, one that is there already follows.
 */
async function toHub(gc, id) {
  if (!hubmark.state.on) return;
  await store.run(gc, "UPDATE places SET in_hub = 1, dirty = dirty + 1 WHERE id = ? AND (in_hub = 1 OR (action_kind != 'tell' AND active = 1))", [id]);
}

async function activeCount(gc, target, exceptId) {
  return (await store.one(gc, "SELECT COUNT(*) AS n FROM places WHERE target_user_id = ? AND active = 1 AND consent != 'declined' AND gone_at IS NULL AND id != ?", [target, exceptId || 0])).n;
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
  const res = await store.run(gc, `INSERT INTO places (owner_id, target_user_id, title, note, lat, lon, radius, trigger_on, action_kind, list_id, tell_json, repeat, active, consent, created_at, updated_at, place_ref, place_missing)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  [r.me.userId, f.targetUserId, f.title, f.note, f.lat, f.lon, f.radius, f.trigger, f.action, f.listId, JSON.stringify(f.tellUserIds), f.repeat, f.active ? 1 : 0, consent, r.now, r.now, f.ref]);
  const id = res.lastInsertRowid;
  await toHub(gc, id);
  if (f.ref) await used(gc, r.me.userId, f.ref, [f.ref]);
  // 1.24.0: a reminder that lives in the hub is asked about there — unless that person's phone still listens to Familie
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
  const changed = ['title', 'note', 'lat', 'lon', 'radius', 'trigger', 'action', 'repeat', 'targetUserId', 'listId', 'ref'].some((k) => f[k] !== p[k])
    || JSON.stringify(f.tellUserIds) !== JSON.stringify(p.tellUserIds) || (f.active && !p.active);
  let consent = p.consent;
  if (f.targetUserId === r.me.userId) consent = 'accepted';
  else if (changed) consent = 'pending';
  await store.run(gc, `UPDATE places SET target_user_id = ?, title = ?, note = ?, lat = ?, lon = ?, radius = ?, trigger_on = ?, action_kind = ?, list_id = ?, tell_json = ?, repeat = ?, active = ?, consent = ?, updated_at = ?,
    place_ref = ?, place_missing = ? WHERE id = ?`,
    [f.targetUserId, f.title, f.note, f.lat, f.lon, f.radius, f.trigger, f.action, f.listId, JSON.stringify(f.tellUserIds), f.repeat, f.active ? 1 : 0, consent, r.now,
      f.ref, f.ref && (!r.body || r.body.ref === undefined) && p.missing ? 1 : 0, id]);
  await toHub(gc, id);
  if (f.ref || p.ref) await used(gc, r.me.userId, r.body && r.body.ref ? f.ref : null, [f.ref, p.ref]);
  if (consent === 'pending' && changed) consentPush(r, id, f.targetUserId, f.title);
  return { place: view(await getPlace(gc, id), r.fam) };
}

/** DELETE places/<id> (owner or target) */
async function remove(gc, r, rawId) {
  const id = posInt(rawId);
  const p = id ? await getPlace(gc, id) : null;
  if (!p || (p.ownerId !== r.me.userId && p.targetUserId !== r.me.userId)) throw fail('not_found');
  // 1.24.0: a reminder the hub has stays hidden until the hub was told (then it goes with the retention)
  const x = await store.one(gc, 'SELECT in_hub FROM places WHERE id = ?', [id]);
  if (hubmark.state.on && x && x.in_hub === 1) await store.run(gc, 'UPDATE places SET gone_at = ?, dirty = dirty + 1 WHERE id = ?', [r.now, id]);
  else await store.run(gc, 'DELETE FROM places WHERE id = ?', [id]);
  if (p.ref) await used(gc, r.me.userId, null, [p.ref]);
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
  await hubmark.place(gc, id);
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
  if (deactivate) await hubmark.place(gc, id);
  return { place: view(await getPlace(gc, id), r.fam), told, repeated: repeat };
}

/** 1.30.0: „zuletzt genutzt“ of the chosen profile place (own only) and „Genutzt von“ of the touched ones. Never throws. */
async function used(gc, userId, ref, refs) {
  if (ref) await pp.markUsed(gc, userId, ref);
  await pp.report(gc, userId, refs.filter(Boolean));
}

/**
 * 1.30.0 — the hook placesChanged: reminders at these profile refs take the place's point and radius as their owner may
 * see it (the hub learns it: dirty); a place that went or is not visible to the owner keeps the copy, missing. The
 * consent stays (the person agreed to the place). → how many changed.
 */
async function placesChanged(gc, refs, deleted, now = Date.now()) {
  const rows = await store.all(gc, `SELECT id, owner_id, lat, lon, radius, place_ref, place_missing FROM places WHERE gone_at IS NULL AND place_ref IN (${refs.map(() => '?').join(',')})`, refs);
  const plan = [];
  for (const x of rows) {
    let p = null;
    if (!deleted) { try { p = await pp.resolve(gc, x.place_ref, x.owner_id); } catch { continue; } }
    if (p) {
      const radius = Math.min(2000, Math.max(50, Math.round(Number(p.radiusM) || 150)));
      if (p.lat === x.lat && p.lon === x.lon && radius === x.radius && !x.place_missing) continue;
      plan.push([p.lat, p.lon, radius, 0, now, x.id]);
    } else if (!x.place_missing) plan.push([x.lat, x.lon, x.radius, 1, now, x.id]);
  }
  if (!plan.length) return 0;
  await store.tx(gc, async () => {
    for (const v of plan) {
      await store.run(gc, 'UPDATE places SET lat = ?, lon = ?, radius = ?, place_missing = ?, updated_at = ? WHERE id = ?', v);
      await hubmark.place(gc, v[5]);
    }
  });
  return plan.length;
}

async function purge(gc, now) {
  await store.run(gc, 'DELETE FROM place_events WHERE at < ?', [now - EVENT_DAYS * DAY]);
  await store.run(gc, 'DELETE FROM places WHERE gone_at IS NOT NULL AND gone_at < ? AND dirty = 0', [now - GONE_KEEP_DAYS * DAY]);
}

module.exports = { MAX_ACTIVE, list, create, update, remove, consent, triggered, purge, placesChanged, view, rowToPlace };
