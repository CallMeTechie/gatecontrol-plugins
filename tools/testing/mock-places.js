'use strict';

// gc.places for the mock host (tools/testing/mock-host.js): „Meine Orte“, the places of the user profile (GateControl ≥
// 1.298.0, src/services/places.js, hostApi.js placesCall, the child bootstrap makePlaces; docs/plugins.md „Meine Orte“).
// Opt-in: opts.places or opts.gatecontrol ≥ '1.298.0'. Like the child bootstrap, gc.places exists only with
// permissions.places === true (any other value: plugin.json invalid); gc.places.version === 1 — 2 from GateControl
// 1.299.0 (or opts.places.version: 2): create / update / remove / search, reportUsage with count 0 for any place id.
//
//   createHost(dir, { places: {
//     places: [{ id: 12, userId: 2, name: 'Arbeit', lat: 50.11, lon: 8.68, radiusM?: 150, icon?: 'pin', address?: null,
//                visibility?: 'self' | 'family' | 'all', source?: 'manual', lastUsedAt?: null }],
//     families: [[2, 3, 4]],   // accounts in one GateControl group of the kind "Familie" (default: opts.profile.families)
//     version?: 1 | 2,         // gc.places.version (default: 2 from GateControl 1.299.0, else 1)
//     search?: ({ userId, q, near, lang }) => [{ name, address, lat, lon }]   // the server's address search (version 2)
//   } })
//
// Like the host:
//   gc.places.list({ userId, owner? })        → [place] — all own places (own: true, usedBy), of other enabled accounts those
//                                               with visibility "all" and, in one family, "family" (own: false, ownerId,
//                                               ownerName, no usedBy); own first, then by name. Unknown userId ERR_NOT_FOUND
//   gc.places.get({ userId, id })             → place | null (unknown or not visible)
//   gc.places.resolve('profile:<id>')          → place | null — any place (ownerId, usedBy); resolve({ ref, userId }) only
//                                               when visible; any other ref form ERR_INVALID
//   gc.places.markUsed({ userId, id })        → { id, lastUsedAt } — own places only, else ERR_NOT_FOUND; no hook
//   gc.places.reportUsage({ userId, id, kind, count }) → { usedBy } — kind /^[a-z][a-z0-9_.-]{0,39}$/, count 0…1 000 000
//                                               (absolute; 0 removes), the place visible for userId (else ERR_NOT_FOUND)
//   gc.places.importFor({ userId, places, source }) → { map, skipped } — idempotent over (person, source, sourceRef)
//   Without the permission: ERR_PLACES_DENIED (only reachable through the raw call — gc.places is missing then).
// Version 2 (GateControl 1.299.0; userId is always the owner — another's place or an unknown id: ERR_NOT_FOUND):
//   gc.places.create({ userId, place })       → place (own, ownerId, source 'manual') — unknown keys ERR_INVALID (err.field),
//                                               a name in use (any case) ERR_DUPLICATE field 'name', 100 places ERR_LIMIT
//   gc.places.update({ userId, id, patch })   → place — lat and lon only together, address null clears, {} no change
//   gc.places.remove({ userId, id, force? })  → { deleted: true, id } — „Genutzt von“ (any plugin) without force: ERR_IN_USE
//                                               with err.usedBy [{ plugin, pluginName, kind, count }]
//   gc.places.search({ userId, q, near?, lang? }) → { results: [{ name, address, lat, lon, source: 'osm', distanceM? }],
//                                               attribution } — q 3…120 (ERR_INVALID field q), near 'lat,lon' | { lat, lon }
//                                               rounded to 2 decimals (ERR_INVALID field near), ≤ 8 hits, 30 per person and
//                                               hour (ERR_RATE_LIMIT, err.retryAfterS; a cached one does not count)
//   gc.places.reportUsage with count 0: any positive id (not visible, gone) → only this plugin's row, { usedBy: [] }
//   Every change of create / update / remove calls the hook placesChanged (also of the calling plugin).
//
// The test's side (host.places):
//   await host.places.add(userId, input)       a person creates a place in „Mein Profil“ → place; the hook placesChanged
//   await host.places.update(id, patch)        changes it (lat/lon/radiusM/name/visibility/…) → place; the hook
//   await host.places.remove(id)               deletes it (with its usage) → the hook with deleted: true
//   host.places.seed(userId, input)            like add, without the hook (what an earlier run left behind)
//   await host.places.changed(userId, ids, deleted)  only the hook placesChanged { userId, ids, deleted }
//   host.places.usage(id)                       [{ plugin, kind, count }] — what reportUsage stored for the place
//   host.places.setUsage(id, plugin, kind, count)  what another plugin keeps there (count 0 removes)
//   host.places.all()                           every place as stored (copies)
//   host.places.calls                           [{ op, method, args }] every gc.places call (method = op)
//   await host.places.settle()                  the hooks of gc.places calls have run (they are awaited: at once)
//   host.places.failNext(code, extra?)          the next gc.places call throws code (a host that is gone for a moment)
//   host.places.searchWith(fn) / searchOff(on)  the address search (version 2): what it finds / the administrator's switch
//   host.places.searches                        [{ userId, q, near, lang }] what reached the search (near rounded)

const ICONS = ['home', 'work', 'school', 'gym', 'shop', 'family', 'pin'];
const VISIBILITY = ['self', 'family', 'all'];
const SOURCES = ['notizen', 'familie', 'messenger'];
const KIND_RE = /^[a-z][a-z0-9_.-]{0,39}$/;
const REF_RE = /^profile:([1-9][0-9]{0,15})$/;
const MAX_PLACES = 100;
const USAGE_MAX = 1000000;
const SEARCH_HITS = 8;
const SEARCH_PER_HOUR = 30;
const ATTRIBUTION = Object.freeze({ text: '© OpenStreetMap', url: 'https://www.openstreetmap.org/copyright' });
const PLACE_KEYS = ['name', 'icon', 'lat', 'lon', 'radiusM', 'address', 'visibility'];

const stamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const round6 = (n) => Math.round(n * 1e6) / 1e6;

function install({ opts, perms, atLeast, enabledUser, userById, hostError, wire, pluginId, pluginName }) {
  let plugin = {};
  let hook = async () => undefined;
  const o = opts.places && typeof opts.places === 'object' ? opts.places : null;
  const on = !!o || atLeast(298);
  if (on && perms.places != null && perms.places !== true) throw hostError('ERR_INVALID', 'plugin.json: permissions.places: invalid');
  const allowed = on && perms.places === true;
  const version = o && o.version != null ? Number(o.version) : (atLeast(299) ? 2 : 1);
  const famSrc = (o && o.families) || (opts.profile && opts.profile.families) || [];
  const families = famSrc.map((ids) => new Set(ids));
  const sameFamily = (a, b) => families.some((f) => f.has(a) && f.has(b));
  const rows = new Map(); // id → stored place
  const usage = new Map(); // `${placeId}|${plugin}|${kind}` → count
  const imports = new Map(); // `${userId}|${source}|${sourceRef}` → id
  const calls = [];
  const searches = [];
  const searchCache = new Map(); // `${lang}|${q}|${near}` → hits
  const spent = new Map(); // userId → [ms] of the searches that went out
  let search = (o && typeof o.search === 'function') ? o.search : () => [];
  let searchOff = false;
  let failNext = null;
  let nextId = 1;

  const invalid = (field) => Object.assign(hostError('ERR_INVALID', `invalid ${field}`), { field });
  const positive = (v) => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null; };
  const needId = (v, field = 'userId') => { const n = positive(v); if (!n) throw invalid(field); return n; };
  const userOf = (id) => userById(id) || null;

  function fields(input, { partial = false, base = {} } = {}) {
    const p = input && typeof input === 'object' ? input : {};
    const out = { ...base };
    if (!partial || p.name !== undefined) {
      const name = typeof p.name === 'string' ? p.name.replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
      if (!name || name.length > 60) throw invalid('name');
      out.name = name;
    }
    if (!partial || p.lat !== undefined || p.lon !== undefined) {
      const lat = Number(p.lat);
      const lon = Number(p.lon);
      if (p.lat == null || !Number.isFinite(lat) || Math.abs(lat) > 90) throw invalid('lat');
      if (p.lon == null || !Number.isFinite(lon) || Math.abs(lon) > 180) throw invalid('lon');
      if (lat === 0 && lon === 0) throw invalid('lat');
      out.lat = round6(lat);
      out.lon = round6(lon);
    }
    if (!partial || p.radiusM !== undefined) {
      const r = p.radiusM == null ? 150 : Math.round(Number(p.radiusM));
      if (!Number.isFinite(r) || r < 50 || r > 2000) throw invalid('radiusM');
      out.radiusM = r;
    }
    if (!partial || p.icon !== undefined) {
      const icon = p.icon == null ? 'pin' : p.icon;
      if (!ICONS.includes(icon)) throw invalid('icon');
      out.icon = icon;
    }
    if (!partial || p.visibility !== undefined) {
      const v = p.visibility == null ? 'self' : p.visibility;
      if (!VISIBILITY.includes(v)) throw invalid('visibility');
      out.visibility = v;
    }
    if (!partial || p.address !== undefined) {
      const a = p.address == null ? null : String(p.address).trim();
      if (a && a.length > 200) throw invalid('address');
      out.address = a || null;
    }
    return out;
  }

  function usedBy(id) {
    const out = [];
    for (const [k, count] of usage) {
      const [pid, plug, kind] = k.split('|');
      if (Number(pid) === id && count > 0) out.push({ plugin: plug, pluginName: plug === pluginId ? (pluginName || plug) : plug, kind, count });
    }
    return out.sort((a, b) => (a.plugin + a.kind).localeCompare(b.plugin + b.kind));
  }

  function view(r, extra, withUsage) {
    return {
      id: r.id, ref: `profile:${r.id}`, name: r.name, icon: r.icon, lat: r.lat, lon: r.lon, radiusM: r.radiusM,
      address: r.address || null, visibility: r.visibility, source: r.source,
      ...(withUsage ? { usedBy: usedBy(r.id) } : {}),
      createdAt: r.createdAt, updatedAt: r.updatedAt, lastUsedAt: r.lastUsedAt || null,
      ...(extra || {}),
    };
  }

  const relation = (viewer, owner) => (viewer === owner ? 'self' : (viewer && sameFamily(viewer, owner) ? 'family' : 'other'));
  const sees = (level, rel) => rel === 'self' || level === 'all' || (level === 'family' && rel === 'family');

  function placeFor(id, viewer) {
    const r = rows.get(id);
    if (!r) return null;
    if (viewer) {
      const rel = relation(viewer, r.userId);
      if (rel !== 'self' && !enabledUser(r.userId)) return null;
      if (!sees(r.visibility, rel)) return null;
      if (rel !== 'self') {
        const u = userOf(r.userId);
        return view(r, { ownerId: r.userId, ownerName: u ? u.name : String(r.userId), own: false }, false);
      }
    }
    return view(r, { ownerId: r.userId, ...(viewer ? { own: true } : {}) }, true);
  }

  function create(userId, input, source = 'manual', when = Date.now()) {
    const uid = needId(userId);
    if (!userOf(uid)) throw hostError('ERR_NOT_FOUND', 'unknown user');
    const f = fields(input);
    const mine = [...rows.values()].filter((r) => r.userId === uid);
    if (mine.length >= MAX_PLACES) throw hostError('ERR_LIMIT', 'at most 100 places');
    if (mine.some((r) => r.name.toLowerCase() === f.name.toLowerCase())) throw Object.assign(hostError('ERR_DUPLICATE', 'name taken'), { field: 'name' });
    const id = input && positive(input.id) && !rows.has(positive(input.id)) ? positive(input.id) : nextId;
    nextId = Math.max(nextId, id + 1);
    const at = stamp(when);
    const r = { id, userId: uid, ...f, source, sourceRef: null, createdAt: at, updatedAt: at, lastUsedAt: (input && input.lastUsedAt) || null };
    rows.set(id, r);
    return r;
  }

  const placesHook = async (userId, ids, deleted) => {
    if (!allowed || typeof plugin.placesChanged !== 'function') return false;
    try { await hook('placesChanged', { userId, ids: [...ids], deleted: !!deleted }); } catch { /* like the host: the answer is ignored */ }
    return true;
  };

  for (const p of (o && o.places) || []) create(p.userId, p, p.source || 'manual');

  const record = (op, args) => {
    calls.push({ op, method: op, args });
    if (!allowed) throw hostError('ERR_PLACES_DENIED', 'this plugin has no places permission');
    if (failNext) { const f = failNext; failNext = null; throw Object.assign(hostError(f.code, 'failed'), f.extra || {}); }
  };
  /** Version 2: one of userId's own places (another's, or unknown: ERR_NOT_FOUND — never "exists, not yours"). */
  const ownRow = (userId, id) => {
    const uid = needId(userId);
    if (!userOf(uid)) throw hostError('ERR_NOT_FOUND', 'unknown user');
    const r = rows.get(needId(id, 'id'));
    if (!r || r.userId !== uid) throw hostError('ERR_NOT_FOUND', 'unknown place');
    return r;
  };
  const known = (p) => {
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw invalid('body');
    const bad = Object.keys(p).find((k) => !PLACE_KEYS.includes(k));
    if (bad) throw invalid(bad);
    return p;
  };
  /** 'lat,lon' | { lat, lon } → { lat, lon } rounded to two decimals (the server's cell) | null for none; else ERR_INVALID near. */
  const cellOf = (near) => {
    if (near == null || near === '') return null;
    let lat;
    let lon;
    if (typeof near === 'string') { const m = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(near); if (m) { lat = Number(m[1]); lon = Number(m[2]); } }
    else if (typeof near === 'object' && !Array.isArray(near)) { lat = Number(near.lat); lon = Number(near.lon); }
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw invalid('near');
    return { lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100 };
  };
  const metres = (a, b) => {
    const rad = Math.PI / 180;
    const h = Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lon - a.lon) * rad) / 2) ** 2;
    return Math.round(2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h))));
  };

  const api = {
    'places.list': async (args) => {
      record('list', args);
      const viewer = needId(args.userId);
      if (!userOf(viewer)) throw hostError('ERR_NOT_FOUND', 'unknown user');
      const owner = args.owner == null ? null : needId(args.owner, 'owner');
      const list = [...rows.values()].filter((r) => (owner == null || r.userId === owner)).map((r) => placeFor(r.id, viewer)).filter(Boolean);
      return list.sort((a, b) => (a.own === b.own ? a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id - b.id : (a.own ? -1 : 1)));
    },
    'places.get': async (args) => {
      record('get', args);
      return placeFor(needId(args.id, 'id'), needId(args.userId));
    },
    'places.resolve': async (args) => {
      record('resolve', args);
      const m = typeof args.ref === 'string' ? REF_RE.exec(args.ref.trim()) : null;
      if (!m) throw hostError('ERR_INVALID', "ref must be 'profile:<id>'");
      return placeFor(Number(m[1]), args.userId == null ? null : needId(args.userId));
    },
    'places.markUsed': async (args) => {
      record('markUsed', args);
      const uid = needId(args.userId);
      const r = rows.get(needId(args.id, 'id'));
      if (!r || r.userId !== uid) throw hostError('ERR_NOT_FOUND', 'unknown place');
      r.lastUsedAt = stamp(Date.now());
      return { id: r.id, lastUsedAt: r.lastUsedAt };
    },
    'places.reportUsage': async (args) => {
      record('reportUsage', args);
      if (typeof args.kind !== 'string' || !KIND_RE.test(args.kind)) throw invalid('kind');
      if (typeof args.count !== 'number' || !Number.isSafeInteger(args.count) || args.count < 0 || args.count > USAGE_MAX) throw invalid('count');
      const pid = needId(args.id, 'id');
      const p = placeFor(pid, needId(args.userId));
      if (!p) {
        // version 2: a count can always be taken down — only this plugin's own row, nothing of the others
        if (version < 2 || args.count !== 0) throw hostError('ERR_NOT_FOUND', 'unknown place');
        usage.delete(`${pid}|${pluginId}|${args.kind}`);
        return { usedBy: [] };
      }
      const k = `${p.id}|${pluginId}|${args.kind}`;
      if (args.count === 0) usage.delete(k); else usage.set(k, args.count);
      return { usedBy: usedBy(p.id) };
    },
    'places.importFor': async (args) => {
      record('importFor', args);
      const uid = needId(args.userId);
      if (!userOf(uid)) throw hostError('ERR_NOT_FOUND', 'unknown user');
      if (!SOURCES.includes(args.source)) throw invalid('source');
      if (!Array.isArray(args.places) || args.places.length > 100) throw invalid('places');
      const map = {};
      const skipped = [];
      const fresh = [];
      for (const p of args.places) {
        const sr = p && typeof p.sourceRef === 'string' ? p.sourceRef : '';
        if (!sr || sr.length > 120 || /[\0-\x1f\x7f]/.test(sr) || map[sr]) throw invalid('sourceRef');
        const key = `${uid}|${args.source}|${sr}`;
        if (imports.has(key) && rows.has(imports.get(key))) { const id = imports.get(key); map[sr] = { id, ref: `profile:${id}`, created: false }; continue; }
        const bad = Object.keys(p).find((k) => !['sourceRef', 'name', 'lat', 'lon', 'icon', 'radiusM', 'address', 'visibility'].includes(k));
        if (bad) { skipped.push({ sourceRef: sr, reason: 'invalid', field: bad }); continue; }
        if ([...rows.values()].filter((r) => r.userId === uid).length >= MAX_PLACES) { skipped.push({ sourceRef: sr, reason: 'limit' }); continue; }
        let f;
        try { f = fields(p); } catch (e) { skipped.push({ sourceRef: sr, reason: 'invalid', field: String(e.message).replace(/^invalid /, '') }); continue; }
        let name = f.name;
        for (let i = 2; [...rows.values()].some((r) => r.userId === uid && r.name.toLowerCase() === name.toLowerCase()); i++) name = `${f.name.slice(0, 60 - String(i).length - 1)} ${i}`;
        const r = create(uid, { ...f, name }, args.source);
        r.sourceRef = sr;
        imports.set(key, r.id);
        fresh.push(r.id);
        map[sr] = { id: r.id, ref: `profile:${r.id}`, created: true };
      }
      if (fresh.length) await placesHook(uid, fresh, false);
      return { map, skipped };
    },
    // ── version 2 (GateControl 1.299.0) ──
    'places.create': async (args) => {
      record('create', args);
      const uid = needId(args.userId);
      if (!userOf(uid)) throw hostError('ERR_NOT_FOUND', 'unknown user');
      const r = create(uid, fields(known(args.place)));
      await placesHook(uid, [r.id], false);
      return placeFor(r.id, uid);
    },
    'places.update': async (args) => {
      record('update', args);
      const r = ownRow(args.userId, args.id);
      const patch = known(args.patch);
      if (!Object.keys(patch).length) return placeFor(r.id, r.userId);
      if ((patch.lat === undefined) !== (patch.lon === undefined)) throw invalid(patch.lat === undefined ? 'lat' : 'lon');
      const f = fields(patch, { partial: true });
      if (f.name && [...rows.values()].some((x) => x.userId === r.userId && x.id !== r.id && x.name.toLowerCase() === f.name.toLowerCase())) {
        throw Object.assign(hostError('ERR_DUPLICATE', 'name taken'), { field: 'name' });
      }
      Object.assign(r, f, { updatedAt: stamp(Date.now()) });
      await placesHook(r.userId, [r.id], false);
      return placeFor(r.id, r.userId);
    },
    'places.remove': async (args) => {
      record('remove', args);
      const r = ownRow(args.userId, args.id);
      const used = usedBy(r.id);
      if (used.length && args.force !== true) throw Object.assign(hostError('ERR_IN_USE', 'the place is in use'), { usedBy: used });
      rows.delete(r.id);
      for (const k of [...usage.keys()]) if (k.startsWith(`${r.id}|`)) usage.delete(k);
      await placesHook(r.userId, [r.id], true);
      return { deleted: true, id: r.id };
    },
    'places.search': async (args) => {
      record('search', args);
      const uid = needId(args.userId);
      if (!userOf(uid)) throw hostError('ERR_NOT_FOUND', 'unknown user');
      if (searchOff) throw hostError('ERR_SEARCH_OFF', 'the address search is switched off');
      const q = typeof args.q === 'string' ? args.q.replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
      if (Array.from(q).length < 3 || Array.from(q).length > 120) throw invalid('q');
      const cell = cellOf(args.near);
      const lang = args.lang === 'en' ? 'en' : 'de';
      const key = `${lang}|${q.toLowerCase()}|${cell ? cell.lat + ',' + cell.lon : '-'}`;
      let hits = searchCache.get(key);
      if (!hits) {
        const now = Date.now();
        const list = (spent.get(uid) || []).filter((t) => now - t < 3600000);
        if (list.length >= SEARCH_PER_HOUR) throw Object.assign(hostError('ERR_RATE_LIMIT', 'too many searches'), { retryAfterS: Math.max(1, Math.ceil((list[0] + 3600000 - now) / 1000)) });
        list.push(now);
        spent.set(uid, list);
        searches.push({ userId: uid, q, near: cell, lang });
        hits = (await search({ userId: uid, q, near: cell, lang }) || []).map((h) => ({ name: String(h.name || ''), address: String(h.address || ''), lat: round6(Number(h.lat)), lon: round6(Number(h.lon)), source: 'osm' }));
        searchCache.set(key, hits);
      }
      return { results: hits.slice(0, SEARCH_HITS).map((h) => (cell ? { ...h, distanceM: metres(cell, h) } : { ...h })), attribution: { ...ATTRIBUTION } };
    },
  };

  const gcPart = (call) => {
    const x = (v) => (v && typeof v === 'object' ? v : {});
    return Object.freeze({
      version,
      list: (a) => call('places.list', { userId: x(a).userId, owner: x(a).owner == null ? null : x(a).owner }),
      get: (a) => call('places.get', { userId: x(a).userId, id: x(a).id }),
      resolve: (ref) => call('places.resolve', typeof ref === 'string' ? { ref } : { ref: x(ref).ref, userId: x(ref).userId == null ? null : x(ref).userId }),
      markUsed: (a) => call('places.markUsed', { userId: x(a).userId, id: x(a).id }),
      reportUsage: (a) => call('places.reportUsage', { userId: x(a).userId, id: x(a).id, kind: x(a).kind, count: x(a).count }),
      importFor: (a) => call('places.importFor', { userId: x(a).userId, places: x(a).places, source: x(a).source }),
      ...(version >= 2 ? {
        create: (a) => call('places.create', { userId: x(a).userId, place: x(a).place }),
        update: (a) => call('places.update', { userId: x(a).userId, id: x(a).id, patch: x(a).patch }),
        remove: (a) => call('places.remove', { userId: x(a).userId, id: x(a).id, force: x(a).force === true }),
        search: (a) => call('places.search', { userId: x(a).userId, q: x(a).q, near: x(a).near == null ? null : x(a).near, lang: x(a).lang }),
      } : {}),
    });
  };

  const control = {
    calls,
    searches,
    version,
    settle: async () => undefined,
    failNext(code, extra) { failNext = { code, extra: extra || null }; },
    searchWith(fn) { search = typeof fn === 'function' ? fn : () => []; searchCache.clear(); },
    searchOff(v = true) { searchOff = !!v; },
    bind(p, h) { plugin = p; hook = h; },
    seed(userId, input) { return wire(view(create(userId, input), { ownerId: Number(userId) }, true)); },
    async add(userId, input) {
      const r = create(userId, input);
      await placesHook(r.userId, [r.id], false);
      return wire(view(r, { ownerId: r.userId }, true));
    },
    async update(id, patch) {
      const r = rows.get(Number(id));
      if (!r) throw hostError('ERR_NOT_FOUND', 'unknown place');
      const x = patch && typeof patch === 'object' ? { ...patch } : {};
      if (x.lat !== undefined || x.lon !== undefined) { if (x.lat === undefined) x.lat = r.lat; if (x.lon === undefined) x.lon = r.lon; }
      Object.assign(r, fields(x, { partial: true }), { updatedAt: stamp(Date.now()) });
      await placesHook(r.userId, [r.id], false);
      return wire(view(r, { ownerId: r.userId }, true));
    },
    async remove(id) {
      const r = rows.get(Number(id));
      if (!r) throw hostError('ERR_NOT_FOUND', 'unknown place');
      rows.delete(r.id);
      for (const k of [...usage.keys()]) if (k.startsWith(`${r.id}|`)) usage.delete(k);
      await placesHook(r.userId, [r.id], true);
      return true;
    },
    changed: (userId, ids, deleted = false) => placesHook(Number(userId), ids || [], deleted),
    usage(id) { return usedBy(Number(id)).map(({ plugin: p, kind, count }) => ({ plugin: p, kind, count })); },
    /** What another plugin keeps at a place („Genutzt von“ of Messenger, Familie …): count 0 removes. */
    setUsage(id, plugin, kind, count) { const k = `${Number(id)}|${plugin}|${kind}`; if (count > 0) usage.set(k, count); else usage.delete(k); },
    all() { return [...rows.values()].map((r) => ({ ...r })); },
    setFamilies(list) { families.length = 0; for (const ids of list || []) families.push(new Set(ids)); },
  };

  return { on: allowed, api, gcPart, control };
}

module.exports = { install };
