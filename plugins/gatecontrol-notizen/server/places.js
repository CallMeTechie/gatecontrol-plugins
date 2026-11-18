'use strict';

// 1.5.0: a task at a place — „beim Baumarkt Schrauben kaufen“ reminds when the person arrives there.
//
//   The phone watches the places (geofences) and shows the reminder itself; the server keeps the places, tells every
//   phone WHICH places to watch (POST places/watch: sorted by urgency, cut to what the phone has room for — Android
//   allows an app 100 watched places, and Familie's own place reminders share them) and what the reminder says. It
//   never learns where a person is: a search gets a rounded position that is not kept (server/placesearch.js), and a
//   phone only reports „this place fired“ (POST places/fired) so that two devices do not both ring.
//
//   Task.place   { mode: 'place' | 'any', id, name, address, lat, lon, radius, ref, own, trigger: 'enter' | 'exit', key,
//                  label, by, consent, watch, nearby, skipped, later (ISO | null: „Später“ until then) }
//     mode 'place'  one place: one of „Meine Orte“, a place of the family, a hit of the search, a pin on the map
//     mode 'any'    „Jeder Lidl“: whichever place of that kind / name is near (needs the search)
//     key           the kind or name the place was chosen for ('kind:diy', 'name:lidl') — with it the task also speaks
//                   up at other places of that kind on the way („in der Nähe“, at most PER_TASK, the nearest)
//     consent       'accepted' | 'pending' | 'declined' — a place set by someone else is only watched by the phone of
//                   the person whose task it is after they agreed (POST tasks/<id>/place/consent)
//   POST | PATCH tasks { place: null | { placeId | placeClientId | familyId | lat, lon, name, address?, ref? | any: true, key?, label?,
//                  trigger?, radius?, remember? } }      remember: this place is „mein Baumarkt“ from now on
//
//   1.8.0: „Meine Orte“ are the places of the user profile (server/profileplaces.js, gc.places). Every `id` / `placeId`
//   of a place is the profile's id, `ref` is 'profile:<id>'; a task keeps a copy of its place (a row of `places`).
//
//   GET    places                 → { places: [Place], family: [FamilyPlace], favs: [{ key, label, placeId, ref }], notMoved, profile: true }
//   POST   places { name, lat, lon, address?, radius?, icon?, visibility?, ref?, clientId? } → { place }   a new place of the profile
//   PATCH  places/<id> { name?, address?, lat?, lon?, radius?, icon?, visibility? } → { place }   (gc.places.update, own only)
//   DELETE places/<id> [?force=1] → { ok }   (gc.places.remove, own only; tasks keep the place) — another plugin still
//                                   uses it: 409 in_use { usedBy, ref } unless force
//   PUT    places/favs { key, placeId | familyId | null } → { favs }
//   POST   places/search { key | q, address?, near: { lat, lon } | nearPlaceId | nearFamilyId } → { results, … }
//          (1.8.0: an address through the server's search, gc.places.search; a kind or a name as before, placesearch.js)
//   POST   places/watch { near?, budget? } → { fences, … }
//   POST   places/fired { taskId, fence, transition } → { notify, reason? }
//   POST   tasks/<id>/place/skip { fence }   „Nicht hier“      POST tasks/<id>/place/later { until? }   „Später“
//   POST   tasks/<id>/place/consent { accept }

const store = require('./store');
const tz = require('./tz');
const config = require('./config');
const prefs = require('./prefs');
const lists = require('./lists');
const duty = require('./duty');
const events = require('./events');
const clientIds = require('./clientids');
const pushprefs = require('./pushprefs');
const shopping = require('./shopping');
const search = require('./placesearch');
const pp = require('./profileplaces');
const words = require('./placewords');
const { t } = require('./text');
const { fail, posInt, line, parse, isTime } = require('./util');

const FAMILIE = 'gatecontrol-familie';
const NAME_MAX = 80;
const ADDRESS_MAX = 160;
const RADIUS_MIN = 50;
const RADIUS_MAX = 2000;
const RADIUS_DEFAULT = 150;
const NEARBY_RADIUS = 300;      // „ist gleich hier“: a wider circle around the other places of a kind
const TRIGGERS = ['enter', 'exit'];
const REF_RE = /^osm:[NWR]\d{1,18}$/;
const ICONS = ['home', 'work', 'school', 'gym', 'shop', 'family', 'pin'];
const VISIBILITY = ['self', 'family', 'all'];
const FENCE_RE = /^(?:p:\d{1,15}|osm:[NWR]\d{1,18})$/;
// Android: 100 watched places per app and device. Familie's place reminders (up to 50 a person) and rule places (up to
// 20) come first; RESERVE stays free. Without an answer of Familie about what it uses, the worst case is assumed.
const ANDROID_MAX = 100;
const RESERVE = 10;
const WATCH_MAX = 60;           // never more than this for the hub
const WATCH_FALLBACK = 30;      // Familie is there but does not say what it uses (older than 1.22.0)
const PER_TASK = 5;             // other places of a kind per task
const WATCH_FETCH = 2;          // searches one POST places/watch may send out (the rest comes from the cache or next time)
const REFRESH_M = 3000;         // a phone asks again when it moved farther than this
const REPEAT_MS = 3 * 3600000;  // the same place does not remind again within this; „in der Nähe“ of one task neither
const LATER_MS = 3 * 3600000;   // „Später“ at a place
const FIRED_KEEP = 12;
const UNNAMED_KEEP_MS = 30 * 86400000;

const famCache = new Map(); // userId → { at, list }
function reset() { famCache.clear(); search.reset(); }

const offered = async (gc, service) => { try { return !!(gc.services && typeof gc.services.available === 'function' && (await gc.services.available(FAMILIE, service)) === true); } catch { return false; } };

/** The family's places for a person (Familie's service `places`: home and the rule places) → [{ id, name, lat, lon, radius }]. */
async function familyPlaces(gc, userId) {
  const now = Date.now();
  const c = famCache.get(userId);
  if (c && now - c.at < 60000) return c.list;
  let list = [];
  if (await offered(gc, 'places')) {
    try {
      const res = await gc.services.call({ plugin: FAMILIE, service: 'places', userId, payload: { userId } });
      if (Array.isArray(res)) {
        list = res.filter((p) => p && typeof p.id === 'string' && /^(?:home|place:\d{1,9})$/.test(p.id) && typeof p.name === 'string' && Number.isFinite(p.lat) && Number.isFinite(p.lon))
          .slice(0, 30).map((p) => ({ id: p.id, name: line(p.name, NAME_MAX), lat: p.lat, lon: p.lon, radius: clampRadius(p.radiusM) }));
      }
    } catch { list = []; }
  }
  if (famCache.size > 500) famCache.clear();
  famCache.set(userId, { at: now, list });
  return list;
}

/** How many places may the hub hand this person's phone? Familie says what it uses (service `geofences`, 1.22.0). */
async function budget(gc, userId) {
  if (await offered(gc, 'geofences')) {
    try {
      const res = await gc.services.call({ plugin: FAMILIE, service: 'geofences', userId, payload: { userId } });
      if (res && res.ok === true && Number.isSafeInteger(res.total) && res.total >= 0) return { max: Math.max(0, Math.min(WATCH_MAX, ANDROID_MAX - RESERVE - res.total)), familie: res.total };
    } catch { /* the worst case below */ }
    return { max: WATCH_FALLBACK, familie: null };
  }
  return (await offered(gc, 'todo_items')) ? { max: WATCH_FALLBACK, familie: null } : { max: WATCH_MAX, familie: 0 };
}

function clampRadius(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(RADIUS_MIN, Math.min(RADIUS_MAX, n)) : RADIUS_DEFAULT;
}
const coord = (v, max, field) => { const n = typeof v === 'number' ? v : NaN; if (!Number.isFinite(n) || Math.abs(n) > max) throw fail('invalid', { field }); return Math.round(n * 1e6) / 1e6; };

/**
 * A places row (the copy of a place a task hangs on or that was chosen) → the API's Place. `id` is the profile's id
 * (null: a hit of the search, a point on the map, a place of the family — `ref` / `familyId` say which).
 */
function view(r, extra = {}) {
  const fam = !!(r.ref && r.ref.startsWith('familie:'));
  return { id: r.profile_id || null, name: r.name, address: r.address || '', lat: r.lat, lon: r.lon, radius: r.radius, named: !!(r.named && r.profile_id),
    ref: r.profile_id ? pp.refOf(r.profile_id) : r.ref || null, family: fam, ...(fam ? { familyId: r.ref.slice(8) } : {}),
    ...(extra.favFor ? { favFor: extra.favFor } : {}), ...(extra.uses != null ? { uses: extra.uses } : {}), updatedAt: r.updated_at };
}

const picksOf = (gc, userId) => store.all(gc, `SELECT k.*, p.profile_id AS p_profile, p.ref AS p_ref FROM place_picks k JOIN places p ON p.id = k.place_id AND p.deleted_at IS NULL
  WHERE k.user_id = ? ORDER BY k.fav DESC, k.uses DESC, k.used_at DESC LIMIT 2000`, [userId]);

/** The person's copy of a place of the profile they may see (`id` the profile's id) → the row id. */
async function copyFor(gc, ctx, id, field) {
  const p = await pp.get(gc, ctx.userId, id);
  if (!p) throw fail('not_found', { field: field || 'place' });
  return { rowId: await pp.mirror(gc, ctx.userId, p, ctx.now), place: p };
}

/** GET places — „Meine Orte“ (the profile's, with what each is remembered for here); the family's; the remembered. */
async function all(gc, ctx) {
  await pp.move(gc, ctx.now);
  const mine = await pp.own(gc, ctx.userId);
  const favs = (await picksOf(gc, ctx.userId)).filter((p) => p.fav);
  const byPlace = new Map();
  for (const p of favs) { if (!p.p_profile) continue; if (!byPlace.has(p.p_profile)) byPlace.set(p.p_profile, []); byPlace.get(p.p_profile).push({ key: p.key, label: words.labelOf(p.key, ctx.lang) }); }
  const ids = new Set(mine.map((p) => p.id));
  return {
    places: mine.map((p) => pp.view(p, { favFor: byPlace.get(p.id) || [] })),
    family: (await familyPlaces(gc, ctx.userId)).map((p) => ({ familyId: p.id, name: p.name, lat: p.lat, lon: p.lon, radius: p.radius })),
    favs: favs.filter((p) => p.p_profile && ids.has(p.p_profile)).map((p) => ({ key: p.key, label: words.labelOf(p.key, ctx.lang), placeId: p.p_profile, ref: pp.refOf(p.p_profile), uses: p.uses })),
    // what the profile refused when „Meine Orte“ moved there (1.8.0) — the tasks keep it as their place
    notMoved: await pp.notMoved(gc, ctx.userId),
    profile: true,
  };
}

const told = (gc, users) => events.changed(gc, users, 'places');

/** The ISO time of ms in the hub's zone with its offset (as tasks.iso). */
function iso(ctx, ms) {
  const p = tz.parts(ms, ctx.tz);
  const off = Math.round(tz.offset(ms, ctx.tz) / 60000);
  const a = Math.abs(off);
  return `${tz.dateStr(p.y, p.m, p.d)}T${tz.pad(p.hh)}:${tz.pad(p.mm)}:${tz.pad(p.ss)}${off < 0 ? '-' : '+'}${tz.pad(Math.floor(a / 60))}:${tz.pad(a % 60)}`;
}

/** POST places — a new place of the profile (gc.places.create); a hit of the search keeps its tasks. */
async function create(gc, ctx, b) {
  const cid = clientIds.arg(b.clientId);
  if (cid) {
    const have = await clientIds.find(gc, ctx.userId, cid, 'place');
    if (have) { const p = await pp.get(gc, ctx.userId, have); if (!p) throw clientIds.gone(cid, have); return { place: pp.view(p), clientId: cid, replayed: true }; }
  }
  const name = line(b.name, pp.NAME_MAX);
  if (!name) throw fail('invalid', { field: 'name' });
  const f = { name, address: line(b.address, pp.ADDRESS_MAX), lat: coord(b.lat, 90, 'lat'), lon: coord(b.lon, 180, 'lon'), radius: b.radius === undefined ? RADIUS_DEFAULT : clampRadius(b.radius) };
  if ((f.lat === 0 && f.lon === 0)) throw fail('invalid', { field: 'lat' });
  if (b.icon !== undefined) { if (typeof b.icon !== 'string' || !ICONS.includes(b.icon)) throw fail('invalid', { field: 'icon' }); f.icon = b.icon; }
  if (b.visibility !== undefined) { if (typeof b.visibility !== 'string' || !VISIBILITY.includes(b.visibility)) throw fail('invalid', { field: 'visibility' }); f.visibility = b.visibility; }
  const ref = b.ref == null ? null : (typeof b.ref === 'string' && REF_RE.test(b.ref) ? b.ref : undefined);
  if (ref === undefined) throw fail('invalid', { field: 'ref' });
  let place;
  try { place = await pp.createOne(gc, ctx.userId, f); } catch (e) { throw await duplicate(gc, ctx, e, name); }
  await store.tx(gc, async () => {
    // a hit taken once before („Baumarkt Nord“ of a task) becomes the copy of the new place: its tasks follow it
    const was = ref ? await store.one(gc, 'SELECT id FROM places WHERE user_id = ? AND ref = ? AND deleted_at IS NULL AND profile_id IS NULL', [ctx.userId, ref]) : null;
    const rowId = await pp.mirror(gc, ctx.userId, place, ctx.now, was ? was.id : null);
    if (was) { const row = await store.one(gc, 'SELECT * FROM places WHERE id = ?', [rowId]); await pp.retag(gc, rowId, place.ref || pp.refOf(place.id), pp.jsonCopy(row)); }
    await clientIds.claim(gc, ctx, cid, 'place', place.id);
  });
  told(gc, [ctx.userId]);
  return { place: pp.view(place), ...(cid ? { clientId: cid } : {}) };
}

/** 409 duplicate of the profile (a name once, without upper / lower case) → with the id of the place that has it. */
async function duplicate(gc, ctx, e, name) {
  if (!e || e.code !== 'duplicate') return e;
  const same = (await pp.own(gc, ctx.userId).catch(() => [])).find((p) => p.name.toLowerCase() === String(name).toLowerCase());
  return fail('duplicate', { field: 'name', ...(same ? { placeId: same.id } : {}) });
}

/**
 * PATCH places/<id> { name?, address?, lat?, lon?, radius?, icon?, visibility? } — one of the person's own places of
 * the profile (gc.places.update; another's or an unknown one: 404). Only what differs goes to the profile; lat or lon
 * alone keeps the other; `named` (1.7) is left alone — a place of the profile stays one (DELETE takes it away).
 */
async function update(gc, ctx, id, b) {
  const p = await pp.mine(gc, ctx.userId, id);
  const patch = {};
  if (b.name !== undefined) { const name = line(b.name, pp.NAME_MAX); if (!name) throw fail('invalid', { field: 'name' }); if (name !== p.name) patch.name = name; }
  if (b.address !== undefined) { const a = line(b.address, pp.ADDRESS_MAX); if (a !== (p.address || '')) patch.address = a || null; }
  if (b.lat !== undefined || b.lon !== undefined) {
    const lat = b.lat === undefined ? p.lat : coord(b.lat, 90, 'lat');
    const lon = b.lon === undefined ? p.lon : coord(b.lon, 180, 'lon');
    if (lat === 0 && lon === 0) throw fail('invalid', { field: 'lat' });
    if (lat !== p.lat || lon !== p.lon) { patch.lat = lat; patch.lon = lon; }
  }
  if (b.radius !== undefined) { const r = clampRadius(b.radius); if (r !== p.radiusM) patch.radiusM = r; }
  if (b.icon !== undefined) { if (typeof b.icon !== 'string' || !ICONS.includes(b.icon)) throw fail('invalid', { field: 'icon' }); if (b.icon !== (p.icon || 'pin')) patch.icon = b.icon; }
  if (b.visibility !== undefined) {
    if (typeof b.visibility !== 'string' || !VISIBILITY.includes(b.visibility)) throw fail('invalid', { field: 'visibility' });
    if (b.visibility !== (p.visibility || 'self')) patch.visibility = b.visibility;
  }
  if (!Object.keys(patch).length) return { place: pp.view(p) };
  let place;
  try { place = await pp.updateOne(gc, ctx.userId, p.id, patch); } catch (e) { throw await duplicate(gc, ctx, e, patch.name || ''); }
  // the copies follow at once (the hook placesChanged comes as well and then finds nothing to do)
  await pp.changed(gc, { userId: ctx.userId, ids: [p.id], deleted: false }, ctx.now);
  told(gc, [ctx.userId]);
  return { place: pp.view(place) };
}

/**
 * DELETE places/<id> [?force=1] — one of the person's own places of the profile (gc.places.remove; another's or an
 * unknown one: 404). As in 1.7 a task that hangs on it keeps it (its copy, place_json) and what is remembered for it
 * goes. Notizen's own „Genutzt von“ goes to 0 first; another plugin that still uses the place (Messenger, Familie) →
 * 409 in_use { usedBy: [{ plugin, pluginName, kind, count }], ref } — with force=1 it is deleted all the same.
 */
async function remove(gc, ctx, id, q = {}, b = {}) {
  const p = await pp.mine(gc, ctx.userId, id);
  const force = q.force === '1' || q.force === 'true' || (b && b.force === true);
  try { await pp.removeOne(gc, ctx.userId, p.id, { force, now: ctx.now }); } catch (e) {
    if (e && e.code === 'in_use') throw fail('in_use', { ...e.extra, ref: pp.refOf(p.id) });
    throw e;
  }
  // the tasks keep their copy (the hook placesChanged comes as well and then finds nothing to do)
  await pp.changed(gc, { userId: ctx.userId, ids: [p.id], deleted: true }, ctx.now);
  told(gc, [ctx.userId]);
  return { ok: true };
}

/** PUT places/favs { key, placeId | null } — „mein Baumarkt“: one place per kind or name. */
async function setFav(gc, ctx, b) {
  if (!b || !words.validKey(b.key)) throw fail('invalid', { field: 'key' });
  let rowId = null;
  if (b.placeId != null) rowId = (await copyFor(gc, ctx, b.placeId)).rowId;
  else if (b.familyId != null) {
    const f = (await familyPlaces(gc, ctx.userId)).find((p) => p.id === b.familyId);
    if (!f) throw fail('not_found', { field: 'place' });
    rowId = await upsert(gc, ctx, { ref: 'familie:' + f.id, name: f.name, address: '', lat: f.lat, lon: f.lon, radius: f.radius });
  }
  await store.tx(gc, () => favTx(gc, ctx, b.key, rowId));
  told(gc, [ctx.userId]);
  return { favs: (await all(gc, ctx)).favs };
}
async function favTx(gc, ctx, key, placeId) {
  await store.run(gc, 'UPDATE place_picks SET fav = 0 WHERE user_id = ? AND key = ? AND fav = 1', [ctx.userId, key]);
  if (placeId) {
    await store.run(gc, `INSERT INTO place_picks (user_id, key, place_id, uses, used_at, fav) VALUES (?, ?, ?, 0, ?, 1)
      ON CONFLICT(user_id, key, place_id) DO UPDATE SET fav = 1`, [ctx.userId, key, placeId, ctx.now]);
  }
}

// ─── the place of a task ────────────────────────

const jsonOf = (r) => { const j = parse(r && r.place_json, null); return j && typeof j === 'object' ? j : null; };
const stateOf = (r) => { const s = parse(r && r.place_state, null); return s && typeof s === 'object' ? { skip: Array.isArray(s.skip) ? s.skip : [], later: s.later || 0, fired: s.fired && typeof s.fired === 'object' ? s.fired : {}, hint: s.hint || 0 } : { skip: [], later: 0, fired: {}, hint: 0 }; };
const fenceOf = (p) => p.ref && REF_RE.test(p.ref) ? p.ref : 'p:' + p.id;

/** Task rows → Map(place id → row) of the places they hang on (whoever they belong to: the list's members see them). */
async function ofTasks(gc, rows) {
  const out = new Map();
  const ids = [...new Set(rows.map((r) => r.place_id).filter(Boolean))];
  for (const part of store.chunks(ids)) {
    if (!part.length) continue;
    for (const p of await store.all(gc, `SELECT * FROM places WHERE id IN (${store.marks(part.length)})`, part)) out.set(p.id, p);
  }
  return out;
}

/** Task.place of a row (`placeRows` of ofTasks) → the object or null. */
function taskView(ctx, r, placeRows) {
  const j = jsonOf(r);
  if (!j) return null;
  const p = r.place_id && placeRows ? placeRows.get(r.place_id) : null;
  if (!j.any && !p) return null;
  const st = stateOf(r);
  // 1.8.0: one of „Meine Orte“ of this person — a place of their profile (id is the profile's id)
  const named = !!(p && p.profile_id && p.named && p.user_id === ctx.userId);
  const label = j.key ? words.labelOf(j.key, ctx.lang, j.label) : null;
  return {
    // 1.8.0: id — the profile's id when ref is 'profile:<id>'; else, as before, the plugin's id of the place (a hit, a
    // point, a place of Familie, the copy of a place deleted in the profile) — no `placeId` to send back
    mode: j.any ? 'any' : 'place', id: p ? p.profile_id || p.id : null, name: p ? p.name : t(ctx.lang, 'pl.any', { label: label || '' }), address: p ? p.address || '' : '',
    lat: p ? p.lat : null, lon: p ? p.lon : null, radius: p ? p.radius : null, ref: p ? (p.profile_id ? pp.refOf(p.profile_id) : p.ref || null) : null, own: named,
    trigger: j.trigger === 'exit' ? 'exit' : 'enter', key: j.key || null, label, by: j.by || null,
    consent: j.consent || 'accepted', watch: j.who === ctx.userId && (j.consent || 'accepted') === 'accepted',
    // 1.6.0: mine — it is this person's phone that is to watch the place; canConsent — they may answer (POST
    // tasks/<id>/place/consent; everybody else of the list gets 403)
    mine: j.who === ctx.userId, canConsent: j.who === ctx.userId && !!j.by && j.by !== ctx.userId,
    nearby: !!j.key && j.trigger !== 'exit' && !j.any, skipped: st.skip.length, later: st.later > ctx.now ? iso(ctx, st.later) : null,
  };
}

/**
 * The `place` of POST / PATCH tasks → { change: null (nothing to write) | { placeId, json, fresh, pick } } — `cur` is
 * the task's row (null: a new task). fresh: another place than before (what the hints did so far is forgotten).
 */
async function argFor(gc, ctx, cur, v) {
  const was = cur ? jsonOf(cur) : null;
  if (v === null) return { change: was ? { placeId: null, json: null, fresh: true } : null };
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw fail('invalid', { field: 'place' });
  const trigger = v.trigger !== undefined ? v.trigger : (was ? was.trigger : 'enter');
  if (!TRIGGERS.includes(trigger)) throw fail('invalid', { field: 'place.trigger' });
  let key = was ? was.key || null : null;
  if (v.key !== undefined) { if (v.key !== null && !words.validKey(v.key)) throw fail('invalid', { field: 'place.key' }); key = v.key; }
  let placeId = cur ? cur.place_id || null : null;
  let any = !!(was && was.any);
  let chosen = false;
  let profileRef = was && !v.any && v.placeId == null && v.placeClientId == null && v.familyId == null && v.lat === undefined && v.lon === undefined ? was.ref || null : null;
  const pref = v.lat === undefined && v.lon === undefined ? pp.parseRef(v.ref) : null;
  if (v.any === true) {
    if (!key) throw fail('invalid', { field: 'place.key' });
    placeId = null; any = true; chosen = true;
  } else if (v.placeId != null || v.placeClientId != null || pref) {
    // a place of the profile (1.8.0: its id or 'profile:<id>') — or one made offline on the device, named by the
    // clientId it was made with; the task hangs on the person's copy of it
    const pid = v.placeId != null ? v.placeId : pref || await clientIds.resolve(gc, ctx, v.placeClientId, 'place', 'place.placeClientId');
    const c = await copyFor(gc, ctx, pid, 'place');
    placeId = c.rowId; profileRef = pp.refOf(c.place.id); any = false; chosen = true;
  } else if (v.familyId != null) {
    const f = (await familyPlaces(gc, ctx.userId)).find((p) => p.id === v.familyId);
    if (!f) throw fail('not_found', { field: 'place' });
    placeId = await upsert(gc, ctx, { ref: 'familie:' + f.id, name: f.name, address: '', lat: f.lat, lon: f.lon, radius: f.radius });
    profileRef = null; any = false; chosen = true;
  } else if (v.lat !== undefined || v.lon !== undefined) {
    const name = line(v.name, NAME_MAX);
    if (!name) throw fail('invalid', { field: 'place.name' });
    if (v.ref != null && (typeof v.ref !== 'string' || !REF_RE.test(v.ref))) throw fail('invalid', { field: 'place.ref' });
    placeId = await upsert(gc, ctx, { ref: v.ref || null, name, address: line(v.address, ADDRESS_MAX), lat: coord(v.lat, 90, 'place.lat'), lon: coord(v.lon, 180, 'place.lon'),
      radius: v.radius === undefined ? RADIUS_DEFAULT : clampRadius(v.radius) });
    const row = await store.one(gc, 'SELECT profile_id FROM places WHERE id = ?', [placeId]);
    profileRef = row && row.profile_id ? pp.refOf(row.profile_id) : null;
    any = false; chosen = true;
  } else if (!was) {
    throw fail('invalid', { field: 'place' });
  }
  if (v.remember === true && (!key || !placeId)) throw fail('invalid', { field: 'place.remember' });
  const label = key ? words.labelOf(key, ctx.lang, typeof v.label === 'string' ? line(v.label, 40) : (was && was.key === key ? was.label : null)) : null;
  const fresh = !was || (cur.place_id || null) !== placeId || !!was.any !== any;
  const same = was && !fresh && was.trigger === trigger && (was.key || null) === key;
  if (same && v.remember !== true) return { change: null };
  const json = { key, label, any, trigger, by: fresh || !was ? ctx.userId : was.by, who: was && !fresh ? was.who : null, consent: was && !fresh ? was.consent : null };
  // 1.8.0: a place of the profile — the reference, and the copy the task falls back to when it is deleted there
  if (profileRef && placeId && !any) {
    const row = await store.one(gc, 'SELECT * FROM places WHERE id = ?', [placeId]);
    if (row && row.profile_id) { json.ref = pp.refOf(row.profile_id); json.copy = pp.jsonCopy(row); }
  }
  return { change: same ? null : { placeId, json, fresh }, pick: key && placeId ? { key, placeId, count: chosen && fresh, fav: v.remember === true } : null };
}

/** The person's row for a place taken once (a search hit, a pin, a place of the family) — found again by its ref. */
async function upsert(gc, ctx, f) {
  if (f.ref) {
    const have = await store.one(gc, 'SELECT * FROM places WHERE user_id = ? AND ref = ? AND deleted_at IS NULL', [ctx.userId, f.ref]);
    if (have) {
      // a place of the family follows the family; the name a person gave a hit stays
      if (!have.named && (have.lat !== f.lat || have.lon !== f.lon || have.name !== f.name)) await store.run(gc, 'UPDATE places SET name = ?, address = ?, lat = ?, lon = ?, radius = ?, updated_at = ? WHERE id = ?', [f.name, f.address || have.address, f.lat, f.lon, f.radius, ctx.now, have.id]);
      return have.id;
    }
  }
  const r = await store.run(gc, 'INSERT INTO places (user_id, name, address, lat, lon, radius, named, ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)',
    [ctx.userId, f.name, f.address || '', f.lat, f.lon, f.radius, f.ref || null, ctx.now, ctx.now]);
  return Number(r.lastInsertRowid);
}

/** After the task is written: the choice is counted („zuletzt sechsmal gewählt“) and, with remember, remembered. */
async function picked(gc, ctx, pick) {
  if (!pick) return;
  // 1.8.0: „mein Baumarkt“ is one of „Meine Orte“ — a hit or a point remembered becomes a place of the profile
  if (pick.fav) await promote(gc, ctx, pick.placeId);
  await store.tx(gc, async () => {
    if (pick.count) {
      await store.run(gc, `INSERT INTO place_picks (user_id, key, place_id, uses, used_at, fav) VALUES (?, ?, ?, 1, ?, 0)
        ON CONFLICT(user_id, key, place_id) DO UPDATE SET uses = uses + 1, used_at = excluded.used_at`, [ctx.userId, pick.key, pick.placeId, ctx.now]);
    }
    if (pick.fav) await favTx(gc, ctx, pick.key, pick.placeId);
  });
}

/** The row `rowId` (a hit, a point) becomes a place of the profile (gc.places.create), the row its copy. */
async function promote(gc, ctx, rowId) {
  const r = await store.one(gc, 'SELECT * FROM places WHERE id = ? AND deleted_at IS NULL', [rowId]);
  if (!r || r.profile_id || r.user_id !== ctx.userId || (r.ref && r.ref.startsWith('familie:')) || !pp.has(gc)) return;
  let place;
  // a name in use becomes „Name 2“ (it was chosen as a kind, not typed as a name)
  try { place = await pp.createOne(gc, ctx.userId, r, { free: true }); } catch (e) { gc.log.warn('place not taken into the profile', (e && e.code) || 'error'); return; }
  await store.tx(gc, async () => {
    const id = await pp.mirror(gc, ctx.userId, place, ctx.now, r.id);
    const row = await store.one(gc, 'SELECT * FROM places WHERE id = ?', [id]);
    await pp.retag(gc, id, pp.refOf(place.id), pp.jsonCopy(row));
  });
  told(gc, [ctx.userId]);
}

/**
 * Whose phone watches the place of task `id`, and did they agree? — after every change of the task. The person whose
 * task it is (duty.js); a place they set themselves is accepted, one set by someone else waits for their answer
 * (a push with „Annehmen“ / „Ablehnen“).
 */
async function sync(gc, ctx, id) {
  const r = await store.one(gc, 'SELECT t.*, l.area AS list_area FROM tasks t JOIN lists l ON l.id = t.list_id WHERE t.id = ?', [id]);
  const j = jsonOf(r);
  if (!r || !j) return;
  const who = r.done_at || r.deleted_at ? j.who : await duty.one(gc, r);
  if (who === j.who && j.consent) return;
  const consent = !who || who === j.by ? 'accepted' : 'pending';
  await store.run(gc, 'UPDATE tasks SET place_json = ? WHERE id = ?', [JSON.stringify({ ...j, who, consent }), r.id]);
  if (consent !== 'pending') return;
  const lang = (await config.get(gc)).notify_lang;
  const p = r.place_id ? await store.one(gc, 'SELECT name FROM places WHERE id = ?', [r.place_id]) : null;
  const where = p ? p.name : t(lang, 'pl.any', { label: words.labelOf(j.key, lang, j.label) });
  await pushprefs.send(gc, [who], 'shared', {
    topic: 'shared', title: t(lang, 'n.place_ask', { name: ctx.userName || '' }).slice(0, 120),
    body: t(lang, j.trigger === 'exit' ? 'n.place_ask_exit' : 'n.place_ask_enter', { title: r.title.slice(0, 120), place: where }).slice(0, 300),
    collapseKey: 'place:' + r.id,
    data: { notizen: { kind: 'place_consent', taskId: r.id, listId: r.list_id, area: r.list_area || null, task: r.id },
      actions: [{ type: 'callback', id: 'place_accept', label: t(lang, 'n.b_accept') }, { type: 'callback', id: 'place_decline', label: t(lang, 'n.b_decline') }] },
  });
}

/** The task `id` with a place, as a member of its list. */
async function taskOf(gc, ctx, id) {
  const tid = posInt(id);
  const r = tid ? await store.one(gc, `SELECT t.*, m.role AS my_role, l.area AS list_area, l.name AS list_name FROM tasks t JOIN list_members m ON m.list_id = t.list_id AND m.user_id = ?
    JOIN lists l ON l.id = t.list_id AND l.deleted_at IS NULL WHERE t.id = ? AND t.deleted_at IS NULL`, [ctx.userId, tid]) : null;
  if (!r) throw fail('not_found');
  if (!jsonOf(r)) throw fail('invalid', { field: 'place' });
  return r;
}
/** „Nicht hier“ and „Später“ are for the person whose phone watches the place — and for who may change the task. */
const mayHint = (ctx, r) => { if (jsonOf(r).who !== ctx.userId && r.my_role === 'read') throw fail('forbidden', { reason: 'read_only' }); };
const saveState = (gc, r, st) => store.run(gc, 'UPDATE tasks SET place_state = ? WHERE id = ?', [JSON.stringify(st), r.id]);

/** POST tasks/<id>/place/consent { accept } — the person whose phone is to watch the place. */
async function consent(gc, ctx, id, b) {
  const r = await taskOf(gc, ctx, id);
  const j = jsonOf(r);
  if (j.who !== ctx.userId) throw fail('forbidden');
  const next = b && b.accept === false ? 'declined' : 'accepted';
  if (j.consent !== next) {
    await store.run(gc, 'UPDATE tasks SET place_json = ?, updated_at = ? WHERE id = ?', [JSON.stringify({ ...j, consent: next }), ctx.now, r.id]);
    events.changed(gc, await lists.memberIds(gc, r.list_id), 'tasks');
    told(gc, [ctx.userId]);
  }
  return { consent: next };
}

/** The buttons of the push „… möchte dich erinnern“ (hook notifyAction). */
async function onAction(gc, ctx, action, d) {
  if (action !== 'place_accept' && action !== 'place_decline') return { ok: false, code: 'invalid' };
  try { return { ok: true, ...(await consent(gc, ctx, d && d.taskId, { accept: action === 'place_accept' })) }; } catch (e) { return { ok: false, code: (e && e.code) || 'failed' }; }
}

/** POST tasks/<id>/place/skip { fence } — „Nicht hier“: this one place is not offered for the task any more. */
async function skip(gc, ctx, id, b) {
  const r = await taskOf(gc, ctx, id);
  mayHint(ctx, r);
  if (!b || typeof b.fence !== 'string' || !FENCE_RE.test(b.fence)) throw fail('invalid', { field: 'fence' });
  const st = stateOf(r);
  if (!st.skip.includes(b.fence)) { st.skip = [...st.skip, b.fence].slice(-50); await saveState(gc, r, st); told(gc, await lists.memberIds(gc, r.list_id)); }
  return { skipped: st.skip.length };
}

/** POST tasks/<id>/place/later { until?: ISO } — „Später“: no hint at a place for this task for LATER_MS (or until then). */
async function later(gc, ctx, id, b) {
  const r = await taskOf(gc, ctx, id);
  mayHint(ctx, r);
  let until = ctx.now + LATER_MS;
  if (b && b.until != null) {
    const ms = typeof b.until === 'string' && /[zZ]$|[+-]\d{2}:?\d{2}$/.test(b.until) ? Date.parse(b.until) : NaN;
    if (!Number.isFinite(ms) || ms <= ctx.now || ms - ctx.now > 7 * 86400000) throw fail('invalid', { field: 'until' });
    until = ms;
  }
  const st = stateOf(r);
  st.later = until;
  await saveState(gc, r, st);
  told(gc, await lists.memberIds(gc, r.list_id));
  return { later: iso(ctx, until), laterMs: until };
}

/** Is `time` ('HH:MM') inside the quiet hours { from, to } (over midnight too)? */
function quietNow(q, time) {
  if (!q || !isTime(q.from) || !isTime(q.to) || q.from === q.to) return false;
  return q.from < q.to ? time >= q.from && time < q.to : time >= q.from || time < q.to;
}

/**
 * POST places/fired { taskId, fence, transition } → { notify, reason? } — a phone's place fired; may it show the
 * reminder? One answer per place and REPEAT_MS, so two devices in the same pocket ring once. Kept: only that this
 * fence fired at this time.
 */
async function fired(gc, ctx, b) {
  if (!b || typeof b.fence !== 'string' || !FENCE_RE.test(b.fence)) throw fail('invalid', { field: 'fence' });
  if (!TRIGGERS.includes(b.transition)) throw fail('invalid', { field: 'transition' });
  let r;
  try { r = await taskOf(gc, ctx, b.taskId); } catch (e) { if (e && (e.code === 'not_found' || e.code === 'invalid')) return { notify: false, reason: 'gone' }; throw e; }
  const j = jsonOf(r);
  if (r.done_at) return { notify: false, reason: 'done' };
  if (j.who !== ctx.userId || j.consent !== 'accepted') return { notify: false, reason: 'gone' };
  if ((j.trigger === 'exit' ? 'exit' : 'enter') !== b.transition) return { notify: false, reason: 'transition' };
  const p = r.place_id ? await store.one(gc, 'SELECT * FROM places WHERE id = ?', [r.place_id]) : null;
  const primary = !!p && fenceOf(p) === b.fence;
  const nearby = !primary && !j.any;
  if (!primary && !j.key) return { notify: false, reason: 'gone' };
  const st = stateOf(r);
  if (st.skip.includes(b.fence)) return { notify: false, reason: 'skipped' };
  if (st.later > ctx.now) return { notify: false, reason: 'later' };
  const pr = await prefs.get(gc, ctx.userId);
  if (nearby) {
    if (pr.places.nearby === false) return { notify: false, reason: 'off' };
    if (quietNow(pr.places.quiet, ctx.time)) return { notify: false, reason: 'quiet' };
    if (st.hint && ctx.now - st.hint < REPEAT_MS && ctx.now >= st.hint) return { notify: false, reason: 'recent' };
  }
  const last = st.fired[b.fence];
  if (last && ctx.now - last < REPEAT_MS && ctx.now >= last) return { notify: false, reason: 'recent' };
  st.fired[b.fence] = ctx.now;
  const keys = Object.keys(st.fired).sort((x, y) => st.fired[y] - st.fired[x]);
  for (const k of keys.slice(FIRED_KEEP)) delete st.fired[k];
  if (nearby) st.hint = ctx.now;
  await saveState(gc, r, st);
  return { notify: true, kind: nearby ? 'nearby' : 'place' };
}

// ─── search and the quick entry ─────────────────

/** May this person search now? → 'on' | 'off' (administrator or the person's own switch) | 'unavailable'. */
async function searchState(gc, cfg, p) {
  const a = await search.availability(gc, cfg);
  return a === 'on' && p.places.search === false ? 'off' : a;
}

/** The person's places chosen before for a key, the remembered one first → [{ row, uses, fav }]. */
async function chosen(gc, userId, key) {
  const rows = await store.all(gc, `SELECT p.*, k.uses AS k_uses, k.fav AS k_fav FROM place_picks k JOIN places p ON p.id = k.place_id AND p.deleted_at IS NULL
    WHERE k.user_id = ? AND k.key = ? ORDER BY k.fav DESC, k.uses DESC, k.used_at DESC LIMIT 20`, [userId, key]);
  return rows.map((r) => ({ row: r, uses: r.k_uses, fav: !!r.k_fav }));
}

/**
 * The place a line of the quick entry names (`parsed` of ui/quickparse.js — the parser knows nothing of this) →
 * { via, word, query, key, label, title, certain, trigger, place, uses, options, search } | null.
 * place: decided already — one of „Meine Orte“, a place of the family, or the one remembered for the kind / name.
 */
async function suggest(gc, ctx, parsed) {
  if (!parsed || typeof parsed.title !== 'string') return null;
  await pp.move(gc, ctx.now);
  const named = await pp.own(gc, ctx.userId);
  const fam = await familyPlaces(gc, ctx.userId);
  const d = words.detect(parsed.title, ctx.lang, { own: named.map((r) => ({ id: r.id, name: r.name })), family: fam });
  if (!d) return null;
  const out = { via: d.via, word: d.word, query: d.query, key: d.key, label: d.label, title: d.title, certain: d.certain, trigger: 'enter', place: null, uses: 0, options: [],
    search: await searchState(gc, await config.get(gc), await prefs.get(gc, ctx.userId)) };
  if (d.via === 'own') out.place = pp.view(named.find((r) => r.id === d.ownId));
  else if (d.via === 'family') { const f = fam.find((p) => p.id === d.familyId); out.place = { familyId: f.id, name: f.name, address: '', lat: f.lat, lon: f.lon, radius: f.radius, family: true }; }
  else if (d.key) {
    const list = await chosen(gc, ctx.userId, d.key);
    out.options = list.map((c) => view(c.row, { uses: c.uses }));
    if (list.length && list[0].fav) { out.place = out.options[0]; out.uses = list[0].uses; }
  }
  return out;
}

/** The `place` argument of a task for a suggestion that is decided (POST tasks { text, place: 'auto' }). */
const argOf = (s) => (!s || !s.place || !s.certain ? null : s.place.familyId ? { familyId: s.place.familyId, trigger: s.trigger }
  : s.place.id ? { placeId: s.place.id, key: s.key || undefined, trigger: s.trigger }
    : { name: s.place.name, address: s.place.address || undefined, lat: s.place.lat, lon: s.place.lon, radius: s.place.radius, ...(s.place.ref && REF_RE.test(s.place.ref) ? { ref: s.place.ref } : {}), key: s.key || undefined, trigger: s.trigger });

/** POST places/search { key | q, near: { lat, lon } | nearPlaceId | nearFamilyId } → the places near, the fastest to reach first. */
async function find(gc, ctx, b) {
  const cfg = await config.get(gc);
  const p = await prefs.get(gc, ctx.userId);
  let key = null;
  let address = null;
  if (b.key != null) { if (!words.validKey(b.key)) throw fail('invalid', { field: 'key' }); key = b.key; }
  else {
    const q = line(b.q, 80);
    if (q.length < 2) throw fail('invalid', { field: 'q' });
    const d = b.address === true ? null : words.detect(q, ctx.lang, {});
    if (b.address === true) address = q;
    else if (d && d.via === 'kind') key = d.key;
    else if (d && d.via === 'address') address = q;
    else if (/\d/.test(q) && q.length > 12) address = q;
    else key = words.nameKey(q);
  }
  // near: a position (rounded here, whatever was sent) or one of the person's places (the portal has no position)
  let near = b.near;
  if (b.nearPlaceId != null) { const pl = await pp.get(gc, ctx.userId, b.nearPlaceId); if (!pl) throw fail('not_found', { field: 'place' }); near = { lat: pl.lat, lon: pl.lon }; }
  else if (b.nearFamilyId != null) { const f = (await familyPlaces(gc, ctx.userId)).find((x) => x.id === b.nearFamilyId); if (!f) throw fail('not_found', { field: 'near' }); near = { lat: f.lat, lon: f.lon }; }
  const cell = search.cellOf(near);
  // an address may be searched without a place to search near (the first place a person saves in the portal)
  if (!cell && !(address && near == null)) throw fail('invalid', { field: 'near' });
  // 1.8.0: an address through the server's search (gc.places.search: the administrator's setting of GateControl, its
  // limits) — the person's own switch still counts; a kind or a name through the plugin's search (map tags, OSM ids
  // for the phones' fences, the cache of POST places/watch)
  if (address) {
    if (p.places.search === false) throw fail('module_off', { reason: 'self' });
    return addressHits(gc, ctx, address, cell);
  }
  const st = await searchState(gc, cfg, p);
  if (st === 'off') throw fail('module_off', { reason: search.modeOf(cfg) === 'off' ? 'admin' : 'self' });
  if (st !== 'on') throw fail('unavailable', { reason: 'service' });
  const hits = await search.find(gc, cfg, { key, address, cell, lang: ctx.lang, userId: ctx.userId });
  // what the person chose before comes first: the remembered one, then the often used ones, then by distance
  const before = key ? await chosen(gc, ctx.userId, key) : [];
  const byRef = new Map(before.filter((c) => c.row.ref).map((c) => [c.row.ref, c]));
  const results = hits.map((h) => { const c = h.ref ? byRef.get(h.ref) : null; return { ref: h.ref, name: c ? c.row.name : h.name, address: h.address, lat: h.lat, lon: h.lon, distanceM: h.distanceM, minutes: h.minutes,
    placeId: c ? c.row.profile_id || null : null, fav: !!(c && c.fav), uses: c ? c.uses : 0 }; });
  for (const c of before) {
    if (c.row.ref && results.some((x) => x.ref === c.row.ref)) continue;
    const dist = cell ? search.distance(cell, c.row) : null;
    results.push({ ref: c.row.ref || null, name: c.row.name, address: c.row.address || '', lat: c.row.lat, lon: c.row.lon, distanceM: dist, minutes: dist == null ? null : search.minutes(dist), placeId: c.row.profile_id || null, fav: c.fav, uses: c.uses });
  }
  results.sort((x, y) => (y.fav - x.fav) || ((y.uses > 0) - (x.uses > 0)) || (x.distanceM - y.distanceM));
  return { key, label: key ? words.labelOf(key, ctx.lang, typeof b.label === 'string' ? line(b.label, 40) : line(b.q, 40)) : address, kind: address ? 'address' : key.startsWith('kind:') ? 'kind' : 'name', radiusKm: search.RADIUS_KM, cell,
    results: results.slice(0, search.RESULTS_MAX), any: !!key && results.length > 0, approx: true, attribution: { text: search.ATTRIBUTION, url: search.ATTRIBUTION_URL } };
}

/** POST places/search with an address: the server's search (gc.places.search) → the answer of find(). */
async function addressHits(gc, ctx, address, cell) {
  const r = await pp.searchAddress(gc, ctx.userId, Array.from(address).slice(0, 120).join(''), cell, ctx.lang);
  const results = (r && Array.isArray(r.results) ? r.results : []).slice(0, search.RESULTS_MAX).map((h) => {
    const dist = Number.isFinite(h.distanceM) ? h.distanceM : cell ? search.distance(cell, h) : null;
    return { ref: null, name: line(h.name, NAME_MAX) || line(h.address, NAME_MAX), address: line(h.address, ADDRESS_MAX), lat: h.lat, lon: h.lon, distanceM: dist,
      minutes: dist == null ? null : search.minutes(dist), placeId: null, fav: false, uses: 0 };
  });
  const a = r && r.attribution && typeof r.attribution.text === 'string' ? r.attribution : { text: search.ATTRIBUTION, url: search.ATTRIBUTION_URL };
  return { key: null, label: address, kind: 'address', radiusKm: search.RADIUS_KM, cell, results, any: false, approx: true, attribution: { text: a.text, url: a.url }, via: 'gatecontrol' };
}

// ─── what a phone watches ───────────────────────

const actionsOf = (lang, kind, list) => [
  ...(list ? [{ id: 'open_list', label: t(lang, 'n.b_list') }] : []),
  { id: 'done', label: t(lang, 'n.b_done') },
  ...(kind === 'nearby' ? [{ id: 'not_here', label: t(lang, 'n.b_not_here') }] : []),
  ...(kind === 'nearby' || !list ? [{ id: 'later', label: t(lang, 'n.b_later') }] : []),
].slice(0, 3);

/**
 * POST places/watch { near?: { lat, lon }, budget? } → { enabled, max, perTask, refreshM, cell, quiet, nearby, fences:
 * [{ id, ref, lat, lon, radius, name, address, transitions, tasks: [{ taskId, listId, area, title, kind: 'place' | 'nearby',
 * trigger, planned, tag, important, notification: { title, body, collapseKey, actions }, attachedList }] }], dropped }
 * — the places this person's phone is to watch: first the tasks' own places, the most urgent task first; then, with a
 * position and the search, the nearest other places of each task's kind. One fence per place however many tasks.
 */
async function watch(gc, ctx, b) {
  const cfg = await config.get(gc);
  const p = await prefs.get(gc, ctx.userId);
  const bud = await budget(gc, ctx.userId);
  const asked = b && b.budget != null ? (Number.isSafeInteger(b.budget) && b.budget >= 0 ? b.budget : null) : undefined;
  if (asked === null) throw fail('invalid', { field: 'budget' });
  const max = Math.min(bud.max, asked === undefined ? bud.max : asked);
  const cell = b && b.near != null ? search.cellOf(b.near) : null;
  if (b && b.near != null && !cell) throw fail('invalid', { field: 'near' });
  const st = await searchState(gc, cfg, p);
  const out = { enabled: true, max, perTask: PER_TASK, refreshM: REFRESH_M, cell, nearby: p.places.nearby !== false && st === 'on', quiet: p.places.quiet || null, search: st, fences: [], dropped: 0 };
  const rows = (await store.all(gc, `SELECT t.*, l.area AS list_area, l.name AS list_name FROM tasks t INDEXED BY idx_tasks_place JOIN list_members m ON m.list_id = t.list_id AND m.user_id = ?
    JOIN lists l ON l.id = t.list_id AND l.deleted_at IS NULL WHERE t.place_json IS NOT NULL AND t.done_at IS NULL AND t.deleted_at IS NULL AND t.parent_id IS NULL LIMIT 1000`, [ctx.userId]))
    .filter((r) => { const j = jsonOf(r); return j && j.who === ctx.userId && j.consent === 'accepted'; });
  // the most urgent first: overdue and due soonest, then the important ones, then the newest
  const far = Number.MAX_SAFE_INTEGER;
  rows.sort((x, y) => ((x.due_at || far) - (y.due_at || far)) || (y.important - x.important) || (y.id - x.id));
  const placeRows = await ofTasks(gc, rows);
  const attached = await shopping.attachInfo(gc, ctx.userId, rows.map((r) => r.attached_list));
  const fences = new Map();
  const fence = (id, f) => { if (!fences.has(id)) fences.set(id, { id, ref: f.ref || null, lat: f.lat, lon: f.lon, radius: f.radius, name: f.name, address: f.address || '', transitions: [], tasks: [], order: fences.size, dist: f.dist == null ? null : f.dist }); return fences.get(id); };
  const entry = (r, j, kind, place, planned) => {
    const a = (r.attached_list && attached.get(r.attached_list)) || null;
    const list = a ? { id: a.id, uid: a.uid, name: a.name, open: a.open, total: a.total } : null;
    const trigger = j.trigger === 'exit' ? 'exit' : 'enter';
    const body = kind === 'nearby' ? t(ctx.lang, 'n.near_body', { title: r.title.slice(0, 120), planned })
      : [t(ctx.lang, trigger === 'exit' ? 'n.place_exit' : 'n.place_enter', { place: place.name }), list ? `${list.name} · ${t(ctx.lang, list.open === 1 ? 'n.list_one' : 'n.list_n', { n: list.open })}` : r.list_name].filter(Boolean).join(' · ');
    return { taskId: r.id, listId: r.list_id, area: r.list_area || null, title: r.title.slice(0, 120), kind, trigger, planned: planned || null, tag: `place:${r.id}:${place.fence}`, important: !!r.important,
      due: r.due_date ? { date: r.due_date, time: r.due_time || null } : null,
      notification: { title: (kind === 'nearby' ? t(ctx.lang, 'n.near_title', { place: place.name }) : r.title).slice(0, 120), body: body.slice(0, 300), collapseKey: 'task:' + r.id, actions: actionsOf(ctx.lang, kind, list) },
      attachedList: list };
  };
  const add = (id, f, e) => { const x = fence(id, f); if (!x.transitions.includes(e.trigger)) x.transitions.push(e.trigger); if (!x.tasks.some((y) => y.taskId === e.taskId)) x.tasks.push(e); };
  // 1. the tasks' own places
  for (const r of rows) {
    const j = jsonOf(r);
    const pl = r.place_id ? placeRows.get(r.place_id) : null;
    if (j.any || !pl) continue;
    const s = stateOf(r);
    const id = fenceOf(pl);
    if (s.skip.includes(id)) continue;
    add(id, { ref: pl.profile_id ? pp.refOf(pl.profile_id) : pl.ref, lat: pl.lat, lon: pl.lon, radius: pl.radius, name: pl.name, address: pl.address }, entry(r, j, 'place', { name: pl.name, fence: id }, null));
  }
  // 2. the other places of each task's kind near the phone (needs a position and the search)
  if (cell && st === 'on') {
    const coarse = search.cellOf(cell, search.WATCH_STEP);
    let sent = 0;
    const perKey = new Map();
    for (const r of rows) {
      const j = jsonOf(r);
      if (!j.key || j.trigger === 'exit' || (!j.any && p.places.nearby === false)) continue;
      const pl = r.place_id ? placeRows.get(r.place_id) : null;
      let hits = perKey.get(j.key);
      if (hits === undefined) {
        hits = null;
        try {
          hits = await search.find(gc, cfg, { key: j.key, cell: coarse, lang: ctx.lang, userId: ctx.userId, cacheOnly: true });
          if (!hits && sent < WATCH_FETCH) { sent++; hits = await search.find(gc, cfg, { key: j.key, cell: coarse, lang: ctx.lang, userId: ctx.userId }); }
        } catch { hits = null; }
        perKey.set(j.key, hits);
      }
      if (!hits) continue;
      const s = stateOf(r);
      const primary = pl ? fenceOf(pl) : null;
      const near = hits.filter((h) => h.ref && h.ref !== primary && !s.skip.includes(h.ref)).map((h) => ({ ...h, dist: search.distance(cell, h) })).sort((x, y) => x.dist - y.dist).slice(0, PER_TASK);
      for (const h of near) {
        add(h.ref, { ref: h.ref, lat: h.lat, lon: h.lon, radius: j.any ? RADIUS_DEFAULT : NEARBY_RADIUS, name: h.name, address: h.address, dist: h.dist },
          entry(r, j, j.any ? 'place' : 'nearby', { name: h.name, fence: h.ref }, j.any ? null : (pl ? pl.name : null)));
      }
    }
  }
  // the tasks' own places keep their order (urgency); the others follow, the nearest first
  const list = [...fences.values()].sort((x, y) => ((x.dist == null ? 0 : 1) - (y.dist == null ? 0 : 1)) || (x.dist == null ? x.order - y.order : x.dist - y.dist));
  out.dropped = Math.max(0, list.length - max);
  out.fences = list.slice(0, max).map(({ order, dist, ...f }) => f);
  return out;
}

/** me.places — what the apps need to know before they ask. */
async function meInfo(gc, ctx, cfg, p) {
  const st = await searchState(gc, cfg, p);
  return {
    search: { state: st, enabled: search.modeOf(cfg) !== 'off', mine: p.places.search !== false, service: search.modeOf(cfg), radiusKm: search.RADIUS_KM, decimals: search.DECIMALS,
      attribution: { text: search.ATTRIBUTION, url: search.ATTRIBUTION_URL },
      // 1.8.0: an address is searched by GateControl (gc.places.search — its administrator's setting and limits)
      address: 'gatecontrol' },
    nearby: p.places.nearby !== false, quiet: p.places.quiet || null, perTask: PER_TASK, radius: { min: RADIUS_MIN, max: RADIUS_MAX, default: RADIUS_DEFAULT },
    // Familie 1.22.0 lets the hub read its places (older ones offer the service, but not to the hub)
    family: await offered(gc, 'geofences'),
    // 1.8.0: „Meine Orte“ are the places of the user profile — POST / PATCH / DELETE places change them there
    // (gc.places version 2); the server's own search for the apps: GET /api/v1/client/me/places/search
    profile: { places: true, edit: 'plugin' },
  };
}

/** The background run (hourly): places nobody needs any more — deleted ones and ones taken once, without a task. */
async function purge(gc, now) {
  // 1.8.0: a copy of a place of the profile goes as well when nothing needs it (the profile keeps the place)
  const r = await store.run(gc, `DELETE FROM places WHERE (deleted_at IS NOT NULL OR ((named = 0 OR profile_id IS NOT NULL) AND updated_at < ?))
    AND NOT EXISTS (SELECT 1 FROM tasks INDEXED BY idx_tasks_place_id WHERE tasks.place_id = places.id)
    AND NOT EXISTS (SELECT 1 FROM place_picks INDEXED BY idx_place_picks_place WHERE place_picks.place_id = places.id)`, [now - UNNAMED_KEEP_MS]);
  return (r && r.changes) || 0;
}

/** The name of the place of each task row that has one → Map(task id → name) (the morning hint's lines). */
async function namesOf(gc, lang, rows) {
  const placeRows = await ofTasks(gc, rows);
  const out = new Map();
  for (const r of rows) {
    const j = jsonOf(r);
    if (!j) continue;
    const p = r.place_id ? placeRows.get(r.place_id) : null;
    if (p) out.set(r.id, p.name); else if (j.any) out.set(r.id, t(lang, 'pl.any', { label: words.labelOf(j.key, lang, j.label) }));
  }
  return out;
}

/** 1.8.0: „Genutzt von“ of the profile's places — after a task's place changed (never fails the request). */
async function counted(gc, ctx) { try { await pp.usage(gc, ctx.now); } catch (e) { gc.log.warn('places usage failed', (e && (e.code || e.message)) || 'error'); } }

module.exports = { counted, all, create, update, remove, setFav, argFor, picked, sync, taskView, ofTasks, consent, onAction, skip, later, fired, suggest, argOf, find, watch, meInfo, purge, namesOf,
  familyPlaces, budget, quietNow, reset, jsonOf, PER_TASK, WATCH_MAX, WATCH_FALLBACK, REPEAT_MS, LATER_MS, RADIUS_DEFAULT, NEARBY_RADIUS, REFRESH_M };
