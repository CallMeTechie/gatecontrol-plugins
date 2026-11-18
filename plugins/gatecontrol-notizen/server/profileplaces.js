'use strict';

// 1.8.0: „Meine Orte“ live in the user profile of GateControl (1.299.0: gc.places version 2, permissions.places).
//
//   The profile keeps the places; Notizen keeps a reference ('profile:<id>') and a copy of each place a task hangs on
//   or that is remembered for a kind („mein Baumarkt“): a row of `places` with profile_id (migrations/010). Tasks,
//   the phones' fences, „Nicht hier“ and the favourites work on that row as before; the hook placesChanged brings the
//   copy up to date, and when a place is deleted in the profile the row stays as a plain copy (profile_id NULL) —
//   the task keeps its place.
//
//   move()     the one-time move of the old „Meine Orte“ (named rows and the remembered ones) into the profile:
//              gc.places.importFor({ userId, places, source: 'notizen' }) per person with sourceRef = the old id —
//              idempotent (run again: nothing twice). Places of Familie ('familie:…') stay a reference to Familie;
//              what the profile refuses stays the task's place and is reported (place_moves, GET places notMoved,
//              the status line of the settings, the log).
//   changed()  the hook placesChanged { userId, ids, deleted }
//   usage()    „Genutzt von“: gc.places.reportUsage({ kind: 'task', count }) — the open tasks at each place, sent
//              when it changed (after a task's place changed, and in the background run for done / deleted ones)
//   createOne / updateOne / removeOne   POST / PATCH / DELETE places: gc.places.create / update / remove (version 2,
//              only the owner — another's place or an unknown id is ERR_NOT_FOUND)
//   searchAddress   the address search of POST places/search: gc.places.search (the server's search, its limits)

const store = require('./store');
const events = require('./events');
const { fail, line, posInt } = require('./util');

const SOURCE = 'notizen';
const KIND = 'task';
const NAME_MAX = 60;            // the profile's limits (gc.places)
const ADDRESS_MAX = 200;
const COPY_NAME = 80;           // the copy in `places` (as before)
const COPY_ADDRESS = 160;
const RADIUS_MIN = 50;
const RADIUS_MAX = 2000;
const RADIUS_DEFAULT = 150;
const IMPORT_MAX = 100;
const MOVE_USERS = 200;         // people per run of the move (the rest in the next background run)
const REF_RE = /^profile:(\d{1,15})$/;
const ICONS = ['home', 'work', 'school', 'gym', 'shop', 'family', 'pin'];
const VISIBILITY = ['self', 'family', 'all'];

const state = { moved: false, running: null, failed: null };
function reset() { state.moved = false; state.failed = null; }

// plugin.json asks for GateControl ≥ 1.299.0: gc.places version 2 (without the permission confirmed: no gc.places)
const has = (gc) => !!(gc.places && Number(gc.places.version) >= 2);
function need(gc) { if (!has(gc)) throw fail('unavailable', { reason: 'places' }); return gc.places; }

/**
 * A gc.places error → the plugin's refusal, with the codes Notizen 1.7 answered (not_found, invalid with the field,
 * too_many) and of 1.8.0 (duplicate, in_use) — anything else is thrown on.
 */
function mapped(e, field) {
  if (e && e.code === 'ERR_NOT_FOUND') return fail('not_found', { field: field || 'place' });
  if (e && e.code === 'ERR_INVALID') return fail('invalid', { field: (e.field === 'radiusM' ? 'radius' : e.field) || field || 'place' });
  if (e && e.code === 'ERR_DUPLICATE') return fail('duplicate', { field: 'name' });
  if (e && e.code === 'ERR_LIMIT') return fail('too_many');
  if (e && e.code === 'ERR_IN_USE') return fail('in_use', { usedBy: (Array.isArray(e.usedBy) ? e.usedBy : []).map((x) => ({ plugin: x.plugin, pluginName: x.pluginName, kind: x.kind, count: x.count })) });
  return e;
}

const refOf = (id) => 'profile:' + id;
/** 'profile:<id>' → id | null */
function parseRef(v) { const m = typeof v === 'string' ? REF_RE.exec(v) : null; return m ? Number(m[1]) : null; }
const msOf = (s) => { const n = typeof s === 'string' ? Date.parse(s.replace(' ', 'T') + 'Z') : NaN; return Number.isFinite(n) ? n : null; };
const cut = (s, n) => Array.from(String(s || '')).slice(0, n).join('').trim();
const clamp = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(RADIUS_MIN, Math.min(RADIUS_MAX, n)) : RADIUS_DEFAULT; };

/** A profile place → the API's Place (as before: id, name, address, lat, lon, radius, named, ref, family; plus icon, visibility, usedBy). */
function view(p, extra = {}) {
  return { id: p.id, ref: refOf(p.id), name: p.name, address: p.address || '', lat: p.lat, lon: p.lon, radius: p.radiusM, named: true, family: false,
    icon: p.icon || 'pin', visibility: p.visibility || 'self', own: p.own !== false, ...(p.own === false ? { ownerId: p.ownerId, ownerName: p.ownerName || '' } : {}),
    ...(Array.isArray(p.usedBy) ? { usedBy: p.usedBy } : {}), ...(extra.favFor ? { favFor: extra.favFor } : {}), ...(extra.uses != null ? { uses: extra.uses } : {}),
    updatedAt: msOf(p.updatedAt) };
}

/** Is the place `p` one of this person's own? */
const ownBy = (p, userId) => p.own !== false && (p.ownerId == null || p.ownerId === userId);

/** Is the copy `row` what the profile place `p` says? */
function same(row, p, userId) {
  const c = copyOf(p);
  return row.name === c.name && row.address === c.address && row.lat === c.lat && row.lon === c.lon && row.radius === c.radius && !!row.named === ownBy(p, userId);
}

/** The copy of a profile place in `places`. */
const copyOf = (p) => ({ name: cut(line(p.name, COPY_NAME), COPY_NAME) || 'Ort', address: line(p.address || '', COPY_ADDRESS), lat: p.lat, lon: p.lon, radius: clamp(p.radiusM) });
const jsonCopy = (r) => ({ name: r.name, address: r.address || '', lat: r.lat, lon: r.lon, radius: r.radius });

/** The person's own places of the profile (gc.places.list owner = the person), own ones only. */
async function own(gc, userId) {
  // without gc.places (the permission not confirmed yet): no places of the profile — tasks keep their copies
  if (!has(gc)) return [];
  try { return (await need(gc).list({ userId, owner: userId })).filter((p) => p && p.own !== false && Number.isSafeInteger(p.id)); } catch (e) { throw mapped(e); }
}

/** A place this person may see (own, or another's with „Familie“ / „Alle“) → place | null. */
async function get(gc, userId, id) {
  const pid = posInt(id);
  if (!pid || !has(gc)) return null;
  try { return await need(gc).get({ userId, id: pid }); } catch (e) { if (e && e.code === 'ERR_NOT_FOUND') return null; throw mapped(e); }
}

/** One of the person's own places → place, else not_found. */
async function mine(gc, userId, id, field) {
  const p = await get(gc, userId, id);
  if (!p || p.own === false || (p.ownerId != null && p.ownerId !== userId)) throw fail('not_found', { field: field || 'place' });
  return p;
}

/** The open tasks of a person's places (watchers) — everybody of their lists sees them. */
async function watchers(gc, rowIds) {
  const out = new Set();
  for (const part of store.chunks(rowIds)) {
    if (!part.length) continue;
    const rows = await store.all(gc, `SELECT DISTINCT m.user_id FROM tasks t INDEXED BY idx_tasks_place_id JOIN list_members m ON m.list_id = t.list_id
      WHERE t.place_id IN (${store.marks(part.length)}) AND t.done_at IS NULL AND t.deleted_at IS NULL LIMIT 500`, part);
    for (const r of rows) out.add(r.user_id);
  }
  return [...out];
}

/** The tasks at the row `rowId`: their place_json gets `ref` ('profile:<id>' | taken away) and the copy. */
async function retag(gc, rowId, ref, copy, extra = {}) {
  const rows = await store.all(gc, 'SELECT id, place_json FROM tasks INDEXED BY idx_tasks_place_id WHERE place_id = ? LIMIT 5000', [rowId]);
  for (const r of rows) {
    let j;
    try { j = JSON.parse(r.place_json); } catch { j = null; }
    if (!j || typeof j !== 'object') continue;
    const next = { ...j, copy, ...extra };
    if (ref) next.ref = ref; else delete next.ref;
    if (JSON.stringify(next) !== r.place_json) await store.run(gc, 'UPDATE tasks SET place_json = ? WHERE id = ?', [JSON.stringify(next), r.id]);
  }
  return rows.length;
}

/** The tasks of row `from` go to row `to` (the same place twice); `from` is deleted. */
async function merge(gc, from, to, now) {
  await store.run(gc, 'UPDATE tasks SET place_id = ? WHERE place_id = ?', [to, from]);
  await store.run(gc, 'UPDATE OR IGNORE place_picks SET place_id = ? WHERE place_id = ?', [to, from]);
  await store.run(gc, 'DELETE FROM place_picks INDEXED BY idx_place_picks_place WHERE place_id = ?', [from]);
  await store.run(gc, 'UPDATE places SET deleted_at = ?, updated_at = ?, profile_id = NULL WHERE id = ?', [now, now, from]);
}

/**
 * The person's copy of the profile place `p` → the row id (made when there is none). `adopt`: a row of the person that
 * becomes the copy (the old place of „Meine Orte“, a hit remembered as „mein Baumarkt“) — it keeps its ref and tasks.
 */
async function mirror(gc, userId, p, now, adopt = null) {
  const c = copyOf(p);
  // named: one of the person's own „Meine Orte“ (0: another person's place shared with „Familie“ / „Alle“)
  const named = ownBy(p, userId) ? 1 : 0;
  const have = await store.one(gc, 'SELECT * FROM places WHERE user_id = ? AND profile_id = ? AND deleted_at IS NULL', [userId, p.id]);
  if (have) {
    if (!same(have, p, userId)) {
      await store.run(gc, 'UPDATE places SET name = ?, address = ?, lat = ?, lon = ?, radius = ?, named = ?, updated_at = ? WHERE id = ?', [c.name, c.address, c.lat, c.lon, c.radius, named, now, have.id]);
    }
    if (adopt && adopt !== have.id) await merge(gc, adopt, have.id, now);
    return have.id;
  }
  if (adopt) {
    await store.run(gc, 'UPDATE places SET profile_id = ?, name = ?, address = ?, lat = ?, lon = ?, radius = ?, named = ?, updated_at = ? WHERE id = ?', [p.id, c.name, c.address, c.lat, c.lon, c.radius, named, now, adopt]);
    return adopt;
  }
  const r = await store.run(gc, 'INSERT INTO places (user_id, name, address, lat, lon, radius, named, ref, profile_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)',
    [userId, c.name, c.address, c.lat, c.lon, c.radius, named, p.id, now, now]);
  return Number(r.lastInsertRowid);
}


/** The place of the profile is gone (or no longer visible): the row stays a plain copy, the tasks keep it. */
async function fallback(gc, row, now) {
  await store.run(gc, 'UPDATE places SET profile_id = NULL, named = 0, updated_at = ? WHERE id = ?', [now, row.id]);
  await store.run(gc, 'DELETE FROM place_picks INDEXED BY idx_place_picks_place WHERE place_id = ?', [row.id]);
  const tasks = await retag(gc, row.id, null, jsonCopy(row), { was: refOf(row.profile_id) });
  // no task hangs on it: nothing to keep (the hourly purge takes it)
  if (!tasks) await store.run(gc, 'UPDATE places SET deleted_at = ? WHERE id = ?', [now, row.id]);
}

/** What gc.places.importFor gets for a place: only the fields the profile knows (unknown keys are refused). */
function item(sourceRef, f) {
  return { sourceRef: String(sourceRef), ...fieldsOf(f) };
}
/** A place of the plugin (name, address, lat, lon, radius, icon?, visibility?) → the profile's fields (gc.places.create). */
function fieldsOf(f) {
  const out = { name: cut(line(f.name, NAME_MAX * 2), NAME_MAX), lat: f.lat, lon: f.lon, radiusM: clamp(f.radius) };
  const address = cut(line(f.address || '', ADDRESS_MAX * 2), ADDRESS_MAX);
  if (address) out.address = address;
  if (ICONS.includes(f.icon)) out.icon = f.icon;
  if (VISIBILITY.includes(f.visibility)) out.visibility = f.visibility;
  return out;
}

/**
 * A new place of the profile (POST places: gc.places.create) → the profile's place. `free`: a name in use becomes
 * „Name 2“, „Name 3“ … (a hit remembered as „mein Baumarkt“) — else it is refused (409 duplicate).
 */
async function createOne(gc, userId, f, { free = false } = {}) {
  const base = fieldsOf(f);
  for (let i = 1; ; i++) {
    const suffix = i === 1 ? '' : ' ' + i;
    const place = { ...base, name: i === 1 ? base.name : cut(base.name, NAME_MAX - suffix.length) + suffix };
    try { return await need(gc).create({ userId, place }); } catch (e) {
      if (free && e && e.code === 'ERR_DUPLICATE' && i < 20) continue;
      throw mapped(e);
    }
  }
}

/** PATCH places/<id>: gc.places.update (only the person's own; `patch` in the profile's fields) → the profile's place. */
async function updateOne(gc, userId, id, patch) {
  try { return await need(gc).update({ userId, id, patch }); } catch (e) { throw mapped(e); }
}

/**
 * DELETE places/<id>: first this plugin's own „Genutzt von“ goes to 0 (the tasks keep their copy of the place), then
 * gc.places.remove. Another plugin still uses the place → in_use { usedBy } (unless `force`); the count of the tasks
 * is told again then (the place stays).
 */
async function removeOne(gc, userId, id, { force = false, now } = {}) {
  const g = need(gc);
  try { await g.reportUsage({ userId, id, kind: KIND, count: 0 }); } catch (e) { throw mapped(e); }
  await store.run(gc, 'DELETE FROM place_usage WHERE profile_id = ?', [id]);
  try { return await g.remove({ userId, id, force: force === true }); } catch (e) {
    await usage(gc, now).catch(() => {});
    throw mapped(e);
  }
}

/**
 * The address search (POST places/search with an address): gc.places.search — the server's search with the
 * administrator's setting, the rounding of `near`, the cache and 30 searches per person and hour (shared with the
 * person's apps). → { results: [{ name, address, lat, lon, distanceM }], attribution }
 */
async function searchAddress(gc, userId, q, near, lang) {
  try {
    return await need(gc).search({ userId, q, ...(near ? { near: { lat: near.lat, lon: near.lon } } : {}), lang: lang === 'en' ? 'en' : 'de' });
  } catch (e) {
    if (e && e.code === 'ERR_SEARCH_OFF') throw fail('module_off', { reason: 'admin' });
    if (e && e.code === 'ERR_RATE_LIMIT') throw fail('busy', { reason: 'limit', retryAfter: Math.max(1, Number(e.retryAfterS) || 60) });
    if (e && e.code === 'ERR_UNAVAILABLE') throw fail('unavailable', { reason: 'service' });
    throw mapped(e, 'q');
  }
}

// ─── the one-time move ──────────────────────────

/** The rows still to be moved: named or remembered, not Familie's, not moved yet. */
const CANDIDATES = `FROM places p WHERE p.deleted_at IS NULL AND p.profile_id IS NULL
  AND (p.named = 1 OR EXISTS (SELECT 1 FROM place_picks k INDEXED BY idx_place_picks_place WHERE k.place_id = p.id AND k.fav = 1))
  AND NOT EXISTS (SELECT 1 FROM place_moves m WHERE m.old_id = p.id)`;

async function moveUser(gc, userId, now, out) {
  const rows = await store.all(gc, `SELECT p.* ${CANDIDATES} AND p.user_id = ? ORDER BY p.named DESC, p.id LIMIT ${IMPORT_MAX}`, [userId]);
  const fam = rows.filter((r) => r.ref && r.ref.startsWith('familie:'));
  const rest = rows.filter((r) => !fam.includes(r));
  let res = { map: {}, skipped: [] };
  if (rest.length) res = await need(gc).importFor({ userId, source: SOURCE, places: rest.map((r) => item(r.id, r)) });
  const map = (res && res.map) || {};
  const skipped = new Map(((res && res.skipped) || []).filter((s) => s && s.sourceRef != null).map((s) => [String(s.sourceRef), s]));
  const placesById = new Map();
  if (Object.keys(map).length) for (const p of await own(gc, userId)) placesById.set(p.id, p);
  await store.tx(gc, async () => {
    for (const r of fam) {
      // a place of Familie stays a reference to Familie (familie:home, familie:place:<n>) — not a place of the profile
      await store.run(gc, 'INSERT OR REPLACE INTO place_moves (old_id, user_id, name, state, profile_id, field, created, at) VALUES (?, ?, ?, ?, NULL, NULL, 0, ?)', [r.id, userId, r.name, 'family', now]);
      await store.run(gc, 'UPDATE places SET named = 0 WHERE id = ?', [r.id]);
      out.family++;
    }
    for (const r of rest) {
      const hit = map[String(r.id)];
      const p = hit ? placesById.get(hit.id) : null;
      if (p) {
        const rowId = await mirror(gc, userId, p, now, r.id);
        await store.run(gc, 'INSERT OR REPLACE INTO place_moves (old_id, user_id, name, state, profile_id, field, created, at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)', [r.id, userId, r.name, 'moved', p.id, hit.created ? 1 : 0, now]);
        const row = await store.one(gc, 'SELECT * FROM places WHERE id = ?', [rowId]);
        await retag(gc, rowId, refOf(p.id), jsonCopy(row));
        out.moved++;
        continue;
      }
      if (hit) continue; // imported, but not readable right now: the next run
      const s = skipped.get(String(r.id)) || { reason: 'invalid', field: null };
      const st = s.reason === 'limit' ? 'limit' : 'invalid';
      // refused by the profile: the tasks keep it as their place (place_json with the copy), it leaves „Meine Orte“
      await store.run(gc, 'INSERT OR REPLACE INTO place_moves (old_id, user_id, name, state, profile_id, field, created, at) VALUES (?, ?, ?, ?, NULL, ?, 0, ?)', [r.id, userId, r.name, st, s.field || null, now]);
      await store.run(gc, 'UPDATE places SET named = 0 WHERE id = ?', [r.id]);
      await retag(gc, r.id, null, jsonCopy(r), { kept: st });
      out[st]++;
      out.refused.push({ userId, id: r.id, name: r.name, reason: st, field: s.field || null });
    }
  });
  return rows.length;
}

/** The move (at the start and in the background run until it is done) → what happened | null (nothing to do). */
function move(gc, now) {
  if (state.moved || !has(gc)) return Promise.resolve(null);
  if (state.running) return state.running;
  state.running = (async () => {
    const out = { users: 0, moved: 0, family: 0, invalid: 0, limit: 0, refused: [] };
    try {
      const tried = new Set();
      for (let i = 0; i < MOVE_USERS; i++) {
        const next = await store.one(gc, `SELECT p.user_id ${CANDIDATES} ${tried.size ? `AND p.user_id NOT IN (${store.marks(tried.size)})` : ''} ORDER BY p.user_id LIMIT 1`, [...tried]);
        if (!next) break;
        tried.add(next.user_id);
        out.users++;
        try { for (let k = 0; k < 20 && (await moveUser(gc, next.user_id, now, out)) === IMPORT_MAX; k++) { /* the next 100 */ } } catch (e) {
          if (e && e.code === 'ERR_NOT_FOUND') {
            // the person is no more (account deleted): their places stay what they were — tasks keep them
            await store.run(gc, `INSERT OR IGNORE INTO place_moves (old_id, user_id, name, state, profile_id, field, created, at) SELECT p.id, p.user_id, p.name, 'invalid', NULL, 'userId', 0, ? ${CANDIDATES} AND p.user_id = ?`, [now, next.user_id]);
          } else throw e;
        }
      }
      // done when nothing is left (a place imported but not readable right now stays for the next run)
      state.moved = !(await store.one(gc, `SELECT 1 AS x ${CANDIDATES} LIMIT 1`));
      state.failed = null;
    } catch (e) {
      state.failed = (e && (e.code || e.message)) || 'error';
      gc.log.warn('places move failed', state.failed);
    }
    if (out.moved || out.family || out.invalid || out.limit) {
      gc.log.info('places moved to the profile', JSON.stringify({ users: out.users, moved: out.moved, family: out.family, invalid: out.invalid, limit: out.limit }));
      for (const x of out.refused) gc.log.warn('place not moved to the profile', JSON.stringify(x));
      events.changed(gc, [...new Set(out.refused.map((x) => x.userId))], 'places');
    }
    if (out.users) await usage(gc, now).catch(() => {});
    return out;
  })().finally(() => { state.running = null; });
  return state.running;
}

/** GET places notMoved: what the profile refused at the move (the tasks keep it). */
async function notMoved(gc, userId) {
  const rows = await store.all(gc, "SELECT old_id, name, state, field FROM place_moves INDEXED BY idx_place_moves_user WHERE user_id = ? AND state IN ('invalid', 'limit') ORDER BY old_id LIMIT 100", [userId]);
  return rows.map((r) => ({ name: r.name, reason: r.state, field: r.field || null }));
}

/** For the status line of the settings: how many places were moved, kept with Familie, refused. */
async function summary(gc) {
  const rows = await store.all(gc, 'SELECT state, COUNT(*) AS n FROM place_moves GROUP BY state');
  const out = { moved: 0, family: 0, invalid: 0, limit: 0, done: state.moved, failed: state.failed };
  for (const r of rows) out[r.state] = r.n;
  return out;
}

// ─── the hook placesChanged ─────────────────────

/** placesChanged { userId, ids, deleted }: the copies follow the profile; a place gone → the tasks keep the copy. */
async function changed(gc, payload, now) {
  const ids = [...new Set((payload && Array.isArray(payload.ids) ? payload.ids : []).map(posInt).filter(Boolean))].slice(0, 100);
  if (!ids.length) return { rows: 0 };
  const rows = await store.all(gc, `SELECT * FROM places INDEXED BY idx_places_pid WHERE profile_id IN (${store.marks(ids.length)}) AND deleted_at IS NULL`, ids);
  if (!rows.length) return { rows: 0 };
  const tell = new Set(rows.map((r) => r.user_id));
  for (const u of await watchers(gc, rows.map((r) => r.id))) tell.add(u);
  const seen = new Map();
  if (!payload.deleted) {
    for (const u of new Set(rows.map((r) => r.user_id))) {
      try { seen.set(u, new Map((await need(gc).list({ userId: u })).map((p) => [p.id, p]))); } catch { seen.set(u, null); }
    }
  }
  let gone = 0;
  let changedRows = 0;
  await store.tx(gc, async () => {
    for (const r of rows) {
      const visible = payload.deleted ? new Map() : seen.get(r.user_id);
      if (!visible) continue; // the host did not answer: as it was, the next change or run brings it
      const p = visible.get(r.profile_id);
      if (p) {
        if (same(r, p, r.user_id)) continue;
        await mirror(gc, r.user_id, p, now);
        const row = await store.one(gc, 'SELECT * FROM places WHERE id = ?', [r.id]);
        await retag(gc, r.id, refOf(p.id), jsonCopy(row));
        changedRows++;
      } else { await fallback(gc, r, now); gone++; changedRows++; }
    }
  });
  if (!changedRows) return { rows: rows.length, gone: 0, changed: 0 };
  events.changed(gc, [...tell], 'places');
  events.changed(gc, [...tell], 'tasks');
  await usage(gc, now).catch(() => {});
  return { rows: rows.length, gone, changed: changedRows };
}

/** The background run (hourly): every copy against the profile — for a hook that did not reach a stopped plugin. */
async function refresh(gc, now) {
  if (!has(gc)) return 0;
  const users = await store.all(gc, 'SELECT DISTINCT user_id FROM places INDEXED BY idx_places_pid WHERE profile_id IS NOT NULL AND deleted_at IS NULL LIMIT 5000');
  let n = 0;
  for (const u of users) {
    const ids = (await store.all(gc, 'SELECT profile_id FROM places WHERE user_id = ? AND profile_id IS NOT NULL AND deleted_at IS NULL', [u.user_id])).map((r) => r.profile_id);
    for (const part of store.chunks(ids, 100)) n += (await changed(gc, { userId: u.user_id, ids: part, deleted: false }, now)).gone || 0;
  }
  return n;
}

// ─── „Genutzt von“ ──────────────────────────────

/** gc.places.reportUsage for every place whose number of open tasks changed since it was told last. */
async function usage(gc, now) {
  if (!has(gc)) return 0;
  // told for a person with a copy of the place (their own copy first: the owner always sees it). A count of 0 is
  // taken for any place (gc.places version 2) — also one that person may no longer see, or one that is gone
  const counts = await store.all(gc, `SELECT p.profile_id AS pid, COALESCE(MIN(CASE WHEN p.named = 1 THEN p.user_id END), MIN(p.user_id)) AS uid,
      (SELECT COUNT(*) FROM tasks t INDEXED BY idx_tasks_place_id WHERE t.place_id IN (SELECT q.id FROM places q INDEXED BY idx_places_pid WHERE q.profile_id = p.profile_id AND q.deleted_at IS NULL)
        AND t.done_at IS NULL AND t.deleted_at IS NULL) AS n
    FROM places p INDEXED BY idx_places_pid WHERE p.profile_id IS NOT NULL AND p.deleted_at IS NULL GROUP BY p.profile_id LIMIT 20000`);
  const sent = new Map((await store.all(gc, 'SELECT * FROM place_usage LIMIT 20000')).map((r) => [r.profile_id, r]));
  const todo = [];
  for (const c of counts) { const s = sent.get(c.pid); sent.delete(c.pid); if (!s ? c.n > 0 : s.sent !== c.n) todo.push({ pid: c.pid, uid: c.uid, n: c.n }); }
  // no copy any more (the place is gone, or no task needs it): 0
  for (const s of sent.values()) todo.push({ pid: s.profile_id, uid: s.user_id, n: 0, drop: true });
  let n = 0;
  for (const x of todo) {
    try {
      await gc.places.reportUsage({ userId: x.uid, id: x.pid, kind: KIND, count: x.n });
    } catch (e) {
      // the host did not answer: next time. A count > 0 for a place gone or no longer visible: the hook comes — and
      // a 0 is always taken (version 2), so nothing stays behind
      if (!e || (e.code !== 'ERR_NOT_FOUND' && e.code !== 'ERR_INVALID')) continue;
    }
    n++;
    if (x.drop || x.n === 0) await store.run(gc, 'DELETE FROM place_usage WHERE profile_id = ?', [x.pid]);
    else await store.run(gc, 'INSERT INTO place_usage (profile_id, user_id, sent, at) VALUES (?, ?, ?, ?) ON CONFLICT(profile_id) DO UPDATE SET user_id = excluded.user_id, sent = excluded.sent, at = excluded.at', [x.pid, x.uid, x.n, now]);
  }
  return n;
}

module.exports = { has, need, reset, state, view, own, get, mine, mirror, merge, fallback, retag, createOne, updateOne, removeOne, searchAddress, fieldsOf, parseRef, refOf, msOf, jsonCopy, move, notMoved, summary, changed, refresh, usage,
  SOURCE, KIND, NAME_MAX, ADDRESS_MAX };
