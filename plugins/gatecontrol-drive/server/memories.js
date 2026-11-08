'use strict';

// The page „Erinnerungen“ (since 1.26.0, feature `memoryCollections`): the overview's „Alle“ opens it in the apps and
// the portal. Collections of the person's PRIVATE photos (photos.privateOnly — nothing below their work folder, nothing
// marked „Prüfen“, nothing of a team folder; whatever the setting workInMemories says, which since 1.26.0 is only the
// photo frame's), each with its count and a cover; their photos page by page like GET photos.
//
//   GET memories?date=YYYY-MM-DD   → { date, home: { key, name } | null, collections: [collection] }
//                                    without date: today (the server's time zone)
//   GET memories/photos?id=<collection id>&before=<ISO>&limit=<≤ 200>
//                                  → { id, items, next } — the photos of one collection like GET photos (newest first,
//                                    next: the `before` of the next page, else null); an unknown id: 400 invalid
//                                    { field: 'id' }, a person not mine: 404 not_found { field: 'id' }
//
// A collection: { id, kind, count, cover (a photo item: the first photo, for a person the newest), from, to (ISO: the
// time it covers; a place and a person their first and last photo) } and by kind, in this order:
//   day     „Heute vor X Jahren“: this calendar day ± 1 day in each earlier year with MORE than DAY_MORE_THAN photos
//           (the overview's cards too) — yearsAgo, date (that day)                              id day:YYYY-MM-DD
//   trip    „Ausflüge und Reisen“: days in a row with photos at a place at least TRIP_KM from home (a single day
//           without photos near home between two such days does not end it), ≥ TRIP_MIN photos there, the newest
//           TRIPS_MAX — place { key, name, region, country } (where most of them are), places [names, ≤ 3], days,
//           firstDay, lastDay                                                            id trip:YYYY-MM-DD:YYYY-MM-DD
//   person  „Mit Noah“: my named people (not hidden, while my switch people is on) on ≥ PERSON_MIN private photos, the
//           PEOPLE_MAX with most — person { id, name }                                               id person:<id>
//   month   „Diesen Monat vor X Jahren“: this calendar month in each earlier year with ≥ MONTH_MIN photos — yearsAgo,
//           month (YYYY-MM)                                                                         id month:YYYY-MM
//   year    „Jahresrückblick“: every year before this one with ≥ YEAR_MIN photos — year              id year:YYYY
//   place   „Orte“: the cities with ≥ PLACE_MIN photos, the PLACES_MAX with most — place { key, name, region,
//           country }                                                                     id place:geonames:<id>
//
// The overview's picks (since 1.28.0, feature `memoryPicks`): on a day without „Heute vor X Jahren“ the overview's
// memoryPicks — picks(): ≤ 4 collections of GET memories for today, exactly as it answers them; the first trip, person,
// month, year and place (PICK_KINDS), then filled up in the page's order; never a day. Only the chosen ones' covers.
//
// Home: the city (photoPlaces) with photos on the most days (then the most photos) — the person's own private photos
// decide it, nothing is stored. Without photos with a place: no home, no trips. A trip's photos are those at its
// places (at least TRIP_KM from home), from its first to its last day.
//
// Cheap: GET memories is one grouped query over the private photos (day × city: count, first photo), the people's
// counts (faces → nodes by key) and the covers by id; GET memories/photos one page on the index of the time taken
// (nodes_taken), of a place (nodes_geo_place) or of a person's faces (faces_person). test/memories_speed.test.js: every
// statement < 200 ms with 50 000 photos. A parent looking at photos of a child's folder: the child hears of it as for
// GET photos (GET memories/photos only; the page's covers are no look into its folder).

const store = require('./store');
const nodes = require('./nodes');
const photos = require('./photos');
const places = require('./places');
const geonames = require('./geonames');
const work = require('./work');
const { fail, iso, posInt } = require('./util');

// the minimums (documented in README.md and the handbook)
const DAY_MORE_THAN = 10;
const TRIP_MIN = 10;
const TRIP_KM = 40;
const PERSON_MIN = 10;
const MONTH_MIN = 20;
const YEAR_MIN = 50;
const PLACE_MIN = 10;
// how many at most
const TRIPS_MAX = 30;
const PEOPLE_MAX = 20;
const PLACES_MAX = 20;
const YEARS_MAX = 100;
const TRIP_DAYS_MAX = 62;
const PLACE_NAMES = 3;
// the overview's picks (1.28.0): one of each kind in this order first — never `day` (the overview's cards are those)
const PICK_KINDS = ['trip', 'person', 'month', 'year', 'place'];
// GateControl's database worker takes at most 100 parameters a statement (store.CHUNK): people in parts
const PEOPLE_CHUNK = 60;
const DAY_MS = 86400000;
const HOUR_MS = 3600000;

const TAKEN = nodes.TAKEN;

const pad = (n) => String(n).padStart(2, '0');
const dayOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 'YYYY-MM-DD' → [y, m (0 …), d] of a real day, else null. */
function partsOf(s) {
  const hit = DAY_RE.exec(String(s == null ? '' : s));
  if (!hit) return null;
  const [y, m, d] = [Number(hit[1]), Number(hit[2]) - 1, Number(hit[3])];
  const probe = new Date(y, m, d);
  if (probe.getFullYear() !== y || probe.getMonth() !== m || probe.getDate() !== d) return null;
  return [y, m, d];
}
/** The number of a calendar day (days since 1970-01-01; no time zone): consecutive days differ by 1. */
const dayNo = (key) => { const [y, m, d] = key.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / DAY_MS); };
/** The start of a local calendar day ('YYYY-MM-DD', + `plus` days) in ms. */
const startOf = (key, plus = 0) => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d + plus).getTime(); };

/** The private photos of every area the person reads but the team folders → { where, args } or null. */
async function scopeOf(ctx) {
  return photos.privateOnly(ctx, await photos.scope(ctx, {}));
}

/**
 * The grouped rows (day × city) of the private photos `sc` → [{ d, p, n, t, id }] — t / id: the first photo. SQL groups by
 * the hour (a whole number: cheap, unlike strftime's 'localtime' on every row) shifted by the minutes the server's zone
 * is off a whole hour (India: 30), so each group lies within one local day; the day of each group here. On the covering
 * index nodes_memories (migrations/021_memories.sql), never the rows of nodes.
 */
async function grouped(ctx, sc) {
  const shift = ((((-new Date(ctx.now).getTimezoneOffset()) % 60) + 60) % 60) * 60000;
  // a bare column with MIN(): id is that of the row with the smallest time taken (SQLite)
  const rows = await store.all(ctx.gc, `SELECT (${TAKEN} + ?) / ${HOUR_MS} AS h, geo_place AS p, COUNT(*) AS n, MIN(${TAKEN}) AS t, id FROM nodes INDEXED BY nodes_memories
    WHERE ${sc.where} GROUP BY h, p`, [shift, ...sc.args]);
  const out = new Map();
  for (const r of rows) {
    if (r.h == null) continue;
    const d = dayOf(new Date(r.h * HOUR_MS - shift));
    const k = `${d}|${r.p == null ? '' : r.p}`;
    const x = out.get(k);
    if (!x) out.set(k, { d, p: r.p, n: r.n, t: r.t, id: r.id });
    else {
      x.n += r.n;
      if (r.t < x.t || (r.t === x.t && r.id < x.id)) { x.t = r.t; x.id = r.id; }
    }
  }
  return [...out.values()];
}

/** The home (the city with photos on the most days, then the most photos) of the grouped rows → city id or null. */
function homeOf(rows) {
  const by = new Map();
  for (const r of rows) {
    if (r.p == null || !r.d) continue;
    const x = by.get(r.p) || { days: 0, n: 0 };
    x.days++;
    x.n += r.n;
    by.set(r.p, x);
  }
  let best = null;
  for (const [p, x] of by) if (!best || x.days > best.days || (x.days === best.days && (x.n > best.n || (x.n === best.n && p < best.p)))) best = { p, ...x };
  return best ? best.p : null;
}

/** Is city `p` (a geo_places row in `named`) at least TRIP_KM from the home city `home`? */
function far(named, home, p) {
  const h = named.get(home);
  const c = named.get(p);
  return !!(h && c) && geonames.km(h.lat, h.lon, c.lat, c.lon) >= TRIP_KM;
}

/** The first photo (smallest t) of several { t, id } → { t, id } or null. */
function firstOf(list) {
  let best = null;
  for (const x of list) if (x && x.id != null && (!best || x.t < best.t || (x.t === best.t && x.id < best.id))) best = x;
  return best;
}

/**
 * The trips of the grouped rows (ascending by day) → [{ firstDay, lastDay, days, count, first, places: [[city id,
 * count]] by count }] newest first: days in a row with photos at a far city; a single day without photos near home
 * between two of them does not end a trip.
 */
function tripsOf(rows, named, home) {
  if (home == null) return [];
  const days = new Map();
  for (const r of rows) {
    if (!r.d) continue;
    const x = days.get(r.d) || { far: 0, near: 0, places: new Map(), first: null };
    if (r.p != null && r.p !== home && far(named, home, r.p)) {
      x.far += r.n;
      x.places.set(r.p, (x.places.get(r.p) || 0) + r.n);
      x.first = firstOf([x.first, { t: r.t, id: r.id }]);
    } else if (r.p != null) x.near += r.n;
    days.set(r.d, x);
  }
  const keys = [...days.keys()].filter((k) => days.get(k).far > 0).sort();
  const out = [];
  let cur = null;
  for (const k of keys) {
    const x = days.get(k);
    const no = dayNo(k);
    const gap = cur ? no - cur.lastNo : Infinity;
    const between = gap === 2 ? days.get(dayOf(new Date(startOf(k, -1)))) : null;
    const joins = cur && (gap === 1 || (gap === 2 && !(between && between.near > 0))) && no - cur.firstNo < TRIP_DAYS_MAX;
    if (!joins) {
      cur = { firstDay: k, firstNo: no, lastDay: k, lastNo: no, count: 0, first: null, places: new Map() };
      out.push(cur);
    }
    cur.lastDay = k;
    cur.lastNo = no;
    cur.count += x.far;
    cur.first = firstOf([cur.first, x.first]);
    for (const [p, n] of x.places) cur.places.set(p, (cur.places.get(p) || 0) + n);
  }
  return out.filter((t) => t.count >= TRIP_MIN).reverse().slice(0, TRIPS_MAX).map((t) => ({
    firstDay: t.firstDay, lastDay: t.lastDay, days: t.lastNo - t.firstNo + 1, count: t.count, first: t.first,
    places: [...t.places].sort((a, b) => b[1] - a[1] || a[0] - b[0]),
  }));
}

const placeView = (p) => ({ key: places.keyOf(p.id), name: p.name, region: p.region || null, country: p.country });

/** The people of the viewer on the private photos `sc` → [{ person, count, t, id, f, l }] (most photos first). */
async function peopleOf(ctx, sc) {
  const s = await work.stored(ctx.gc, ctx.viewer);
  if (!s.people) return [];
  const persons = await store.all(ctx.gc, 'SELECT id, name FROM persons WHERE user_id = ? AND pending = 0 AND hidden = 0 AND name IS NOT NULL', [ctx.viewer]);
  if (!persons.length) return [];
  const names = new Map(persons.map((p) => [p.id, p.name]));
  const out = [];
  for (const part of store.chunks(persons.map((p) => p.id), PEOPLE_CHUNK)) {
    // a bare column with MAX(): nid is the newest photo of the person
    const rows = await store.all(ctx.gc, `SELECT f.person_id AS pid, COUNT(DISTINCT f.node_id) AS n, MIN(x.t) AS f, MAX(x.t) AS t, f.node_id AS nid
      FROM faces f JOIN (SELECT id, ${TAKEN} AS t FROM nodes WHERE ${sc.where}) x ON x.id = f.node_id
      WHERE f.user_id = ? AND f.person_id IN (${store.marks(part.length)}) GROUP BY f.person_id`, [...sc.args, ctx.viewer, ...part]);
    for (const r of rows) if (r.n >= PERSON_MIN) out.push({ person: { id: r.pid, name: names.get(r.pid) }, count: r.n, t: r.t, id: r.nid, f: r.f, l: r.t });
  }
  out.sort((a, b) => b.count - a.count || a.person.id - b.person.id);
  return out.slice(0, PEOPLE_MAX);
}

/** The date asked for (date=, else today in the server's zone) → [y, m, d]; not a day: 400 invalid { field: 'date' }. */
function dateArg(ctx, q) {
  if (q && q.date != null && q.date !== '') {
    const p = partsOf(q.date);
    if (!p) throw fail('invalid', { field: 'date' });
    return p;
  }
  const now = new Date(ctx.now);
  return [now.getFullYear(), now.getMonth(), now.getDate()];
}

/**
 * The collections of the date asked for, without their covers → { date, home (a geo_places row or null), out: [{ id, kind,
 * …, count, first: { t, id }, from, to (ms) }] } in the page's order.
 */
async function collect(ctx, q) {
  const [y, m, d] = dateArg(ctx, q);
  const date = `${y}-${pad(m + 1)}-${pad(d)}`;
  const sc = await scopeOf(ctx);
  if (!sc) return { date, home: null, out: [] };
  const rows = await grouped(ctx, sc);
  const byDay = new Map();
  for (const r of rows) {
    if (!r.d) continue;
    const x = byDay.get(r.d) || { n: 0, first: null };
    x.n += r.n;
    x.first = firstOf([x.first, { t: r.t, id: r.id }]);
    byDay.set(r.d, x);
  }
  const sum = (keys) => {
    let n = 0;
    let first = null;
    for (const k of keys) { const x = byDay.get(k); if (x) { n += x.n; first = firstOf([first, x.first]); } }
    return { n, first };
  };
  const years = [...byDay.keys()].map((k) => Number(k.slice(0, 4)));
  const fromYear = years.length ? Math.min(...years) : y;
  const out = [];
  // „Heute vor X Jahren“: more than DAY_MORE_THAN that day (± 1 day)
  for (let k = 1; k <= YEARS_MAX && y - k >= fromYear; k++) {
    const keys = [-1, 0, 1].map((x) => dayOf(new Date(y - k, m, d + x)));
    const s = sum(keys);
    const day = dayOf(new Date(y - k, m, d));
    if (s.n > DAY_MORE_THAN) out.push({ id: `day:${day}`, kind: 'day', yearsAgo: k, date: day, count: s.n, first: s.first, from: startOf(keys[0]), to: startOf(keys[2], 1) });
  }
  // the cities of the photos with a place, home and the trips
  const cityIds = [...new Set(rows.filter((r) => r.p != null).map((r) => r.p))];
  const named = await places.placeRows(ctx.gc, cityIds.map((p) => ({ geo_place: p })));
  const home = homeOf(rows);
  for (const t of tripsOf(rows, named, home)) {
    const top = named.get(t.places[0][0]);
    out.push({
      id: `trip:${t.firstDay}:${t.lastDay}`, kind: 'trip', place: top ? placeView(top) : null,
      places: t.places.slice(0, PLACE_NAMES).map(([p]) => named.get(p)).filter(Boolean).map((p) => p.name),
      days: t.days, firstDay: t.firstDay, lastDay: t.lastDay, count: t.count, first: t.first, from: startOf(t.firstDay), to: startOf(t.lastDay, 1),
    });
  }
  // „Mit <Person>“
  for (const p of await peopleOf(ctx, sc)) out.push({ id: `person:${p.person.id}`, kind: 'person', person: p.person, count: p.count, first: { t: p.t, id: p.id }, from: p.f, to: p.l });
  // „Diesen Monat vor X Jahren“
  for (let k = 1; k <= YEARS_MAX && y - k >= fromYear; k++) {
    const month = `${y - k}-${pad(m + 1)}`;
    const s = sum([...byDay.keys()].filter((x) => x.startsWith(month + '-')));
    if (s.n >= MONTH_MIN) out.push({ id: `month:${month}`, kind: 'month', yearsAgo: k, month, count: s.n, first: s.first, from: new Date(y - k, m, 1).getTime(), to: new Date(y - k, m + 1, 1).getTime() });
  }
  // „Jahresrückblick“: the years before this one
  for (let yy = y - 1; yy >= fromYear && y - yy <= YEARS_MAX; yy--) {
    const s = sum([...byDay.keys()].filter((x) => x.startsWith(`${yy}-`)));
    if (s.n >= YEAR_MIN) out.push({ id: `year:${yy}`, kind: 'year', year: yy, count: s.n, first: s.first, from: new Date(yy, 0, 1).getTime(), to: new Date(yy + 1, 0, 1).getTime() });
  }
  // „Orte“
  const byPlace = new Map();
  for (const r of rows) {
    if (r.p == null) continue;
    const x = byPlace.get(r.p) || { n: 0, first: null, l: null };
    x.n += r.n;
    x.first = firstOf([x.first, { t: r.t, id: r.id }]);
    x.l = r.d && (x.l == null || r.d > x.l) ? r.d : x.l;
    byPlace.set(r.p, x);
  }
  [...byPlace].filter(([p, x]) => x.n >= PLACE_MIN && named.has(p)).sort((a, b) => b[1].n - a[1].n || a[0] - b[0]).slice(0, PLACES_MAX).forEach(([p, x]) => {
    out.push({ id: `place:${places.keyOf(p)}`, kind: 'place', place: placeView(named.get(p)), count: x.n, first: x.first, from: x.first ? x.first.t : null, to: x.l ? startOf(x.l, 1) : null });
  });
  return { date, home: home != null ? named.get(home) || null : null, out };
}

/** Collections of collect() → as GET memories answers them: the covers (one query by id, items as GET photos has them), ISO times. */
async function finish(ctx, out) {
  const ids = [...new Set(out.map((c) => c.first && c.first.id).filter((x) => x != null))];
  const coverRows = [];
  for (const part of store.chunks(ids)) coverRows.push(...await store.all(ctx.gc, `SELECT * FROM nodes WHERE id IN (${store.marks(part.length)})`, part));
  const items = new Map((await photos.itemsOf(ctx, coverRows)).map((it) => [it.id, it]));
  return out.map(({ first, from, to, ...c }) => ({ ...c, cover: (first && items.get(first.id)) || null, from: from == null ? null : iso(from), to: to == null ? null : iso(to) }));
}

/** GET memories → { date, home, collections } */
async function list(ctx, q) {
  const { date, home, out } = await collect(ctx, q);
  return { date, home: home ? { key: places.keyOf(home.id), name: home.name } : null, collections: await finish(ctx, out) };
}

/**
 * Some collections of `list` (in the page's order, no `day`) for variety → [≤ max]: the first of each kind in the order
 * of PICK_KINDS, then filled up in the page's order.
 */
function pickFrom(list, max) {
  const from = list.filter((c) => PICK_KINDS.includes(c.kind));
  const chosen = new Set();
  for (const k of PICK_KINDS) {
    if (chosen.size >= max) break;
    const c = from.find((x) => x.kind === k);
    if (c) chosen.add(c);
  }
  for (const c of from) { if (chosen.size >= max) break; chosen.add(c); }
  return [...chosen];
}

/**
 * The overview's picks (since 1.28.0, `memoryPicks`): ≤ max collections of GET memories for today, exactly as that
 * answers them — pickFrom(); the covers of those only. The same queries as GET memories (no second kind of query).
 */
async function picks(ctx, max) {
  const { out } = await collect(ctx, {});
  const chosen = pickFrom(out, max);
  return chosen.length ? finish(ctx, chosen) : [];
}

/** A collection's id → { kind, … }; else 400 invalid { field: 'id' }. */
function idArg(id) {
  const s = String(id == null ? '' : id);
  const bad = () => fail('invalid', { field: 'id' });
  let hit = /^day:(\d{4}-\d{2}-\d{2})$/.exec(s);
  if (hit) {
    if (!partsOf(hit[1])) throw bad();
    return { kind: 'day', from: startOf(hit[1], -1), to: startOf(hit[1], 2) };
  }
  hit = /^month:(\d{4})-(\d{2})$/.exec(s);
  if (hit) {
    const [yy, mm] = [Number(hit[1]), Number(hit[2])];
    if (mm < 1 || mm > 12) throw bad();
    return { kind: 'month', from: new Date(yy, mm - 1, 1).getTime(), to: new Date(yy, mm, 1).getTime() };
  }
  hit = /^year:(\d{4})$/.exec(s);
  if (hit) return { kind: 'year', from: new Date(Number(hit[1]), 0, 1).getTime(), to: new Date(Number(hit[1]) + 1, 0, 1).getTime() };
  hit = /^place:(geonames:\d{1,10})$/.exec(s);
  if (hit) return { kind: 'place', place: places.keyArg(hit[1]) };
  hit = /^person:(\d{1,15})$/.exec(s);
  if (hit && posInt(hit[1])) return { kind: 'person', person: posInt(hit[1]) };
  hit = /^trip:(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/.exec(s);
  if (hit) {
    const [a, b] = [hit[1], hit[2]];
    if (!partsOf(a) || !partsOf(b) || b < a || dayNo(b) - dayNo(a) >= TRIP_DAYS_MAX) throw bad();
    return { kind: 'trip', firstDay: a, lastDay: b, from: startOf(a), to: startOf(b, 1) };
  }
  throw bad();
}

/** The private photos `sc` narrowed to collection `c` (idArg) → { where, args }, or null: none. */
async function narrowTo(ctx, sc, c) {
  const range = { where: `${sc.where} AND ${TAKEN} >= ? AND ${TAKEN} < ?`, args: [...sc.args, c.from, c.to] };
  if (c.kind === 'day' || c.kind === 'month' || c.kind === 'year') return range;
  if (c.kind === 'place') return { where: `${sc.where} AND geo_place = ?`, args: [...sc.args, c.place] };
  if (c.kind === 'person') return { where: `${sc.where} AND id IN (SELECT node_id FROM faces WHERE person_id = ? AND user_id = ?)`, args: [...sc.args, c.person, ctx.viewer] };
  // a trip: its far cities — home as GET memories finds it (the same grouped query), the cities of those days far from it
  const rows = await grouped(ctx, sc);
  const home = homeOf(rows);
  if (home == null) return null;
  const inTrip = [...new Set(rows.filter((r) => r.p != null && r.d >= c.firstDay && r.d <= c.lastDay).map((r) => r.p))];
  const named = await places.placeRows(ctx.gc, [...inTrip, home].map((p) => ({ geo_place: p })));
  const cities = inTrip.filter((p) => p !== home && far(named, home, p));
  if (!cities.length) return null;
  // the cities as one parameter (any number of them)
  return { where: `${range.where} AND geo_place IN (SELECT value FROM json_each(?))`, args: [...range.args, JSON.stringify(cities)] };
}

/** GET memories/photos?id=&before=&limit= → { id, items, next } */
async function photosOf(ctx, q) {
  const x = q || {};
  const c = idArg(x.id);
  const limit = photos.limitArg(x.limit);
  const before = photos.beforeArg(x.before);
  if (c.kind === 'person') {
    const p = await store.one(ctx.gc, 'SELECT id FROM persons WHERE id = ? AND user_id = ? AND pending = 0', [c.person, ctx.viewer]);
    if (!p) throw fail('not_found', { field: 'id' });
  }
  const sc = await scopeOf(ctx);
  const nw = sc ? await narrowTo(ctx, sc, c) : null;
  if (!nw) return { id: String(x.id), items: [], next: null };
  // a span of time (day, month, year, trip) on the index of the time taken; a place, a person on theirs
  const r = await photos.page(ctx.gc, nw.where, nw.args, before, limit, c.kind === 'place' || c.kind === 'person' ? 'nodes' : 'nodes INDEXED BY nodes_taken');
  await photos.noteViews(ctx, r.rows);
  return { id: String(x.id), items: await photos.itemsOf(ctx, r.rows), next: r.next };
}

module.exports = {
  list, photosOf, homeOf, tripsOf, picks, pickFrom, PICK_KINDS,
  DAY_MORE_THAN, TRIP_MIN, TRIP_KM, PERSON_MIN, MONTH_MIN, YEAR_MIN, PLACE_MIN, TRIPS_MAX, PEOPLE_MAX, PLACES_MAX,
};
