'use strict';

// Rule places (1.5.0, module presence): the places a presence rule can be
// triggered by — "Marc kommt an der Schule an", "Anna verlässt die Arbeit",
// a big circle around home = "kurz vor Zuhause". Not the place reminders
// (server/places.js, per person): these belong to the family and are kept by
// the parents (member API) or the administrator (admin page). The phones of
// the people who agreed watch them (presence/watch, server/presence.js) and
// report only "entered / left" — never a position.
//
//   GET    presence/places          parents: { places: [{ id, name, lat, lon, radius, rules, createdAt, updatedAt }],
//                                   home: { lat, lon } | null }   (rules: how many rules use it; home: the settings location)
//   POST   presence/places          { name, lat, lon, radius? } → { place }
//   PATCH  presence/places/<id>     any subset → { place }
//   DELETE presence/places/<id>     409 in_use { rules: [name] } while a rule uses it, else {}
//   (admin page: admin/presence/places — the same functions)
//
// At most 20 (409 too_many). name 1–40 characters (single line, unique
// ignoring case → 409 name_taken), lat −90..90, lon −180..180, radius an
// integer 50–5000 m (default 200); invalid → 400 invalid { field }.

const store = require('./store');
const { fail, posInt, line, numIn, iso } = require('./util');

const MAX_PLACES = 20;
const NAME_MAX = 40;
const RADIUS_MIN = 50;
const RADIUS_MAX = 5000;
const RADIUS_DEFAULT = 200;

const rowToPlace = (x) => ({ id: x.id, name: x.name, lat: x.lat, lon: x.lon, radius: x.radius, createdBy: x.created_by, createdAt: x.created_at, updatedAt: x.updated_at });

const view = (p, rules) => ({ id: p.id, name: p.name, lat: p.lat, lon: p.lon, radius: p.radius, rules: rules || 0, createdAt: iso(p.createdAt), updatedAt: iso(p.updatedAt) });

/** Every rule place: Map id → place. */
async function all(gc) {
  return new Map((await store.all(gc, 'SELECT * FROM rule_places ORDER BY id')).map((x) => [x.id, rowToPlace(x)]));
}

/** One place by a raw id (number or path segment), or null. */
async function byId(gc, raw) {
  const id = posInt(raw);
  const row = id ? await store.one(gc, 'SELECT * FROM rule_places WHERE id = ?', [id]) : null;
  return row ? rowToPlace(row) : null;
}

/** Map placeId → number of rules (active or not) using it. */
async function ruleCounts(gc) {
  return new Map((await store.all(gc, 'SELECT place_id, COUNT(*) AS n FROM presence_rules WHERE place_id IS NOT NULL GROUP BY place_id')).map((x) => [x.place_id, x.n]));
}

const home = (cfg) => (cfg.location ? { lat: cfg.location.lat, lon: cfg.location.lon } : null);

/** ctx: { cfg, now, ownerId } — shared by the member API (parents) and the admin page. */
async function list(gc, ctx) {
  const counts = await ruleCounts(gc);
  return { places: [...(await all(gc)).values()].map((p) => view(p, counts.get(p.id))), home: home(ctx.cfg) };
}

function fields(body, cur) {
  const b = body || {};
  const f = {};
  if (b.name !== undefined || !cur) {
    const name = line(b.name);
    if (!name || name.length > NAME_MAX) throw fail('invalid', { field: 'name' });
    f.name = name;
  } else f.name = cur.name;
  const num = (k, min, max) => {
    if (b[k] === undefined && cur) return cur[k];
    try { return numIn(b[k], min, max); } catch { throw fail('invalid', { field: k }); }
  };
  f.lat = num('lat', -90, 90);
  f.lon = num('lon', -180, 180);
  if (b.radius !== undefined && b.radius !== null) {
    if (!Number.isInteger(b.radius) || b.radius < RADIUS_MIN || b.radius > RADIUS_MAX) throw fail('invalid', { field: 'radius' });
    f.radius = b.radius;
  } else f.radius = cur ? cur.radius : RADIUS_DEFAULT;
  return f;
}

async function checkName(gc, name, exceptId) {
  const key = name.toLowerCase();
  const taken = (await store.all(gc, 'SELECT id, name FROM rule_places')).some((x) => x.id !== exceptId && String(x.name).toLowerCase() === key);
  if (taken) throw fail('name_taken', { field: 'name' });
}

async function one(gc, id) {
  const p = await byId(gc, id);
  return { place: view(p, (await ruleCounts(gc)).get(p.id)) };
}

async function create(gc, ctx, body) {
  const f = fields(body, null);
  if ((await store.one(gc, 'SELECT COUNT(*) AS n FROM rule_places')).n >= MAX_PLACES) throw fail('too_many');
  await checkName(gc, f.name, 0);
  const res = await store.run(gc, 'INSERT INTO rule_places (name, lat, lon, radius, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [f.name, f.lat, f.lon, f.radius, ctx.ownerId, ctx.now, ctx.now]);
  return one(gc, res.lastInsertRowid);
}

async function update(gc, ctx, raw, body) {
  const cur = await byId(gc, raw);
  if (!cur) throw fail('not_found');
  const f = fields(body, cur);
  if (f.name !== cur.name) await checkName(gc, f.name, cur.id);
  await store.run(gc, 'UPDATE rule_places SET name = ?, lat = ?, lon = ?, radius = ?, updated_at = ? WHERE id = ?', [f.name, f.lat, f.lon, f.radius, ctx.now, cur.id]);
  return one(gc, cur.id);
}

async function remove(gc, raw) {
  const cur = await byId(gc, raw);
  if (!cur) throw fail('not_found');
  const rules = await store.all(gc, 'SELECT id, name FROM presence_rules WHERE place_id = ? ORDER BY id', [cur.id]);
  // a rule without a name is named by its number
  if (rules.length) throw fail('in_use', { rules: rules.map((x) => x.name || `#${x.id}`) });
  await store.run(gc, 'DELETE FROM rule_places WHERE id = ?', [cur.id]);
  return {};
}

module.exports = { MAX_PLACES, NAME_MAX, RADIUS_MIN, RADIUS_MAX, RADIUS_DEFAULT, all, byId, list, create, update, remove };
