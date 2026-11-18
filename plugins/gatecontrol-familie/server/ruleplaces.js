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
//
// 1.30.0 — „Meine Orte“ (server/profileplaces.js): a rule may choose a place of a person's profile the owner shows to the
// family ('profile:<id>', visibility family or all). Familie keeps it as a LINKED rule place (profile_ref): the copy the
// phones watch, made on first use (link), gone once no rule uses it (tidy), not one of the 20, never in the parents'
// list and not editable there (404). The list answers `profilePlaces` (what may be chosen); a rule's place answers
// `ref` and `missing`. placesChanged moves the copy along (missing when the place went or is not visible any more).

const store = require('./store');
const pp = require('./profileplaces');
const { fail, posInt, line, numIn, iso } = require('./util');

const MAX_PLACES = 20;
const NAME_MAX = 40;
const RADIUS_MIN = 50;
const RADIUS_MAX = 5000;
const RADIUS_DEFAULT = 200;

const rowToPlace = (x) => ({ id: x.id, name: x.name, lat: x.lat, lon: x.lon, radius: x.radius, createdBy: x.created_by, createdAt: x.created_at, updatedAt: x.updated_at,
  ref: x.profile_ref || null, missing: !!x.profile_missing });

const view = (p, rules) => ({ id: p.id, name: p.name, lat: p.lat, lon: p.lon, radius: p.radius, rules: rules || 0, createdAt: iso(p.createdAt), updatedAt: iso(p.updatedAt) });
const clampRadius = (r) => Math.min(RADIUS_MAX, Math.max(RADIUS_MIN, Math.round(Number(r) || RADIUS_DEFAULT)));

/** Every rule place: Map id → place. */
async function all(gc) {
  return new Map((await store.all(gc, 'SELECT * FROM rule_places ORDER BY id')).map((x) => [x.id, rowToPlace(x)]));
}

/** One place by a raw id (number or path segment), or null. 1.30.0: linked places only with { linked: true }. */
async function byId(gc, raw, { linked = false } = {}) {
  const id = posInt(raw);
  const row = id ? await store.one(gc, `SELECT * FROM rule_places WHERE id = ?${linked ? '' : ' AND profile_ref IS NULL'}`, [id]) : null;
  return row ? rowToPlace(row) : null;
}

/** Map placeId → number of rules (active or not) using it. */
async function ruleCounts(gc) {
  return new Map((await store.all(gc, 'SELECT place_id, COUNT(*) AS n FROM presence_rules WHERE place_id IS NOT NULL GROUP BY place_id')).map((x) => [x.place_id, x.n]));
}

const home = (cfg) => (cfg.location ? { lat: cfg.location.lat, lon: cfg.location.lon } : null);

/** The profile places `userId` may choose for a rule (gc.places, visibility family or all) → [{ ref, name, radius, … }]. */
async function choosable(gc, fam, userId) {
  if (!fam) return [];
  return (await pp.forFamily(gc, fam, userId)).map((x) => ({ ref: x.ref, name: x.name, icon: x.icon, radius: clampRadius(x.radiusM), ownerId: x.ownerId, ownerName: x.ownerName, own: x.own }));
}

/** ctx: { cfg, now, ownerId, fam } — shared by the member API (parents) and the admin page. */
async function list(gc, ctx) {
  const counts = await ruleCounts(gc);
  return {
    places: [...(await all(gc)).values()].filter((p) => !p.ref).map((p) => view(p, counts.get(p.id))), home: home(ctx.cfg),
    // 1.30.0: the profile places a rule may choose ('profile:<id>' as the rule's placeId)
    profilePlaces: await choosable(gc, ctx.fam, ctx.ownerId),
  };
}

/**
 * 1.30.0: the rule place for the profile place `ref` as `userId` may see it — shown to the family (visibility family or
 * all) and owned by a member, else 400 invalid { field: 'placeId' }. Made (or brought up to date) here → its id.
 */
async function link(gc, ref, userId, fam, now = Date.now()) {
  const p = await pp.resolve(gc, ref, userId);
  const owner = p ? (posInt(p.ownerId) || userId) : null;
  if (!p || !pp.FAMILY.includes(p.visibility) || (fam && owner !== userId && !fam.byId.has(owner))) throw fail('invalid', { field: 'placeId' });
  const name = (line(p.name) || ref).slice(0, NAME_MAX);
  const radius = clampRadius(p.radiusM);
  const row = await store.one(gc, 'SELECT id FROM rule_places WHERE profile_ref = ?', [ref]);
  if (row) {
    await store.run(gc, 'UPDATE rule_places SET name = ?, lat = ?, lon = ?, radius = ?, profile_by = ?, profile_missing = 0, updated_at = ? WHERE id = ?', [name, p.lat, p.lon, radius, userId, now, row.id]);
    return row.id;
  }
  const res = await store.run(gc, 'INSERT INTO rule_places (name, lat, lon, radius, created_by, created_at, updated_at, profile_ref, profile_by, profile_missing) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)',
    [name, p.lat, p.lon, radius, userId, now, now, ref, userId]);
  return Number(res.lastInsertRowid);
}

/** Linked rule places no rule uses any more go → the refs they had (for „Genutzt von“). */
async function tidy(gc) {
  const gone = await store.all(gc, 'SELECT id, profile_ref, profile_by FROM rule_places WHERE profile_ref IS NOT NULL AND id NOT IN (SELECT place_id FROM presence_rules WHERE place_id IS NOT NULL)');
  if (gone.length) await store.run(gc, `DELETE FROM rule_places WHERE id IN (${gone.map(() => '?').join(',')})`, gone.map((x) => x.id));
  return gone;
}

/**
 * 1.30.0 — the hook placesChanged: linked rule places at these refs take the profile place's name, point and radius as
 * the person who chose it may see it (still shown to the family); else the copy stays, missing. → how many changed.
 */
async function placesChanged(gc, refs, deleted, now = Date.now()) {
  const rows = await store.all(gc, `SELECT * FROM rule_places WHERE profile_ref IN (${refs.map(() => '?').join(',')})`, refs);
  const plan = [];
  for (const x of rows) {
    let p = null;
    if (!deleted) { try { p = await pp.resolve(gc, x.profile_ref, x.profile_by || x.created_by); } catch { continue; } }
    if (p && pp.FAMILY.includes(p.visibility)) {
      const next = { name: (line(p.name) || x.name).slice(0, NAME_MAX), lat: p.lat, lon: p.lon, radius: clampRadius(p.radiusM) };
      if (next.name === x.name && next.lat === x.lat && next.lon === x.lon && next.radius === x.radius && !x.profile_missing) continue;
      plan.push([next.name, next.lat, next.lon, next.radius, 0, now, x.id]);
    } else if (!x.profile_missing) plan.push([x.name, x.lat, x.lon, x.radius, 1, now, x.id]);
  }
  if (!plan.length) return 0;
  await store.tx(gc, async () => {
    for (const v of plan) await store.run(gc, 'UPDATE rule_places SET name = ?, lat = ?, lon = ?, radius = ?, profile_missing = ?, updated_at = ? WHERE id = ?', v);
  });
  return plan.length;
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
  const taken = (await store.all(gc, 'SELECT id, name FROM rule_places WHERE profile_ref IS NULL')).some((x) => x.id !== exceptId && String(x.name).toLowerCase() === key);
  if (taken) throw fail('name_taken', { field: 'name' });
}

async function one(gc, id) {
  const p = await byId(gc, id);
  return { place: view(p, (await ruleCounts(gc)).get(p.id)) };
}

async function create(gc, ctx, body) {
  const f = fields(body, null);
  if ((await store.one(gc, 'SELECT COUNT(*) AS n FROM rule_places WHERE profile_ref IS NULL')).n >= MAX_PLACES) throw fail('too_many');
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

module.exports = { MAX_PLACES, NAME_MAX, RADIUS_MIN, RADIUS_MAX, RADIUS_DEFAULT, all, byId, list, choosable, link, tidy, placesChanged, create, update, remove };
