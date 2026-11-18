'use strict';

// gc.places for the mock host (tools/testing/mock-host.js): „Meine Orte“, the places of the user profile (GateControl ≥
// 1.298.0, src/services/places.js, hostApi.js placesCall, the child bootstrap makePlaces; docs/plugins.md „Meine Orte“).
// Opt-in: opts.places or opts.gatecontrol ≥ '1.298.0'. Like the child bootstrap, gc.places exists only with
// permissions.places === true (any other value: plugin.json invalid); gc.places.version === 1.
//
//   createHost(dir, { places: {
//     places: [{ id: 12, userId: 2, name: 'Arbeit', lat: 50.11, lon: 8.68, radiusM?: 150, icon?: 'pin', address?: null,
//                visibility?: 'self' | 'family' | 'all', source?: 'manual', lastUsedAt?: null }],
//     families: [[2, 3, 4]],   // accounts in one GateControl group of the kind "Familie" (default: opts.profile.families)
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
//
// The test's side (host.places):
//   await host.places.add(userId, input)       a person creates a place in „Mein Profil“ → place; the hook placesChanged
//   await host.places.update(id, patch)        changes it (lat/lon/radiusM/name/visibility/…) → place; the hook
//   await host.places.remove(id)               deletes it (with its usage) → the hook with deleted: true
//   host.places.seed(userId, input)            like add, without the hook (what an earlier run left behind)
//   await host.places.changed(userId, ids, deleted)  only the hook placesChanged { userId, ids, deleted }
//   host.places.usage(id)                       [{ plugin, kind, count }] — what reportUsage stored for the place
//   host.places.all()                           every place as stored (copies)
//   host.places.calls                           [{ op, args }] every gc.places call

const ICONS = ['home', 'work', 'school', 'gym', 'shop', 'family', 'pin'];
const VISIBILITY = ['self', 'family', 'all'];
const SOURCES = ['notizen', 'familie', 'messenger'];
const KIND_RE = /^[a-z][a-z0-9_.-]{0,39}$/;
const REF_RE = /^profile:([1-9][0-9]{0,15})$/;
const MAX_PLACES = 100;
const USAGE_MAX = 1000000;

const stamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const round6 = (n) => Math.round(n * 1e6) / 1e6;

function install({ opts, perms, atLeast, enabledUser, userById, hostError, wire, pluginId, pluginName }) {
  let plugin = {};
  let hook = async () => undefined;
  const o = opts.places && typeof opts.places === 'object' ? opts.places : null;
  const on = !!o || atLeast(298);
  if (on && perms.places != null && perms.places !== true) throw hostError('ERR_INVALID', 'plugin.json: permissions.places: invalid');
  const allowed = on && perms.places === true;
  const famSrc = (o && o.families) || (opts.profile && opts.profile.families) || [];
  const families = famSrc.map((ids) => new Set(ids));
  const sameFamily = (a, b) => families.some((f) => f.has(a) && f.has(b));
  const rows = new Map(); // id → stored place
  const usage = new Map(); // `${placeId}|${plugin}|${kind}` → count
  const imports = new Map(); // `${userId}|${source}|${sourceRef}` → id
  const calls = [];
  let nextId = 1;

  const invalid = (field) => hostError('ERR_INVALID', `invalid ${field}`);
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
    if (mine.some((r) => r.name.toLowerCase() === f.name.toLowerCase())) throw hostError('ERR_DUPLICATE', 'name taken');
    const id = input && positive(input.id) && !rows.has(positive(input.id)) ? positive(input.id) : nextId;
    nextId = Math.max(nextId, id + 1);
    const at = stamp(when);
    const r = { id, userId: uid, ...f, source, createdAt: at, updatedAt: at, lastUsedAt: (input && input.lastUsedAt) || null };
    rows.set(id, r);
    return r;
  }

  const placesHook = async (userId, ids, deleted) => {
    if (!allowed || typeof plugin.placesChanged !== 'function') return false;
    try { await hook('placesChanged', { userId, ids: [...ids], deleted: !!deleted }); } catch { /* like the host: the answer is ignored */ }
    return true;
  };

  for (const p of (o && o.places) || []) create(p.userId, p, p.source || 'manual');

  const record = (op, args) => { calls.push({ op, args }); if (!allowed) throw hostError('ERR_PLACES_DENIED', 'this plugin has no places permission'); };

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
      const p = placeFor(needId(args.id, 'id'), needId(args.userId));
      if (!p) throw hostError('ERR_NOT_FOUND', 'unknown place');
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
        imports.set(key, r.id);
        fresh.push(r.id);
        map[sr] = { id: r.id, ref: `profile:${r.id}`, created: true };
      }
      if (fresh.length) await placesHook(uid, fresh, false);
      return { map, skipped };
    },
  };

  const gcPart = (call) => {
    const x = (v) => (v && typeof v === 'object' ? v : {});
    return Object.freeze({
      version: 1,
      list: (a) => call('places.list', { userId: x(a).userId, owner: x(a).owner == null ? null : x(a).owner }),
      get: (a) => call('places.get', { userId: x(a).userId, id: x(a).id }),
      resolve: (ref) => call('places.resolve', typeof ref === 'string' ? { ref } : { ref: x(ref).ref, userId: x(ref).userId == null ? null : x(ref).userId }),
      markUsed: (a) => call('places.markUsed', { userId: x(a).userId, id: x(a).id }),
      reportUsage: (a) => call('places.reportUsage', { userId: x(a).userId, id: x(a).id, kind: x(a).kind, count: x(a).count }),
      importFor: (a) => call('places.importFor', { userId: x(a).userId, places: x(a).places, source: x(a).source }),
    });
  };

  const control = {
    calls,
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
    all() { return [...rows.values()].map((r) => ({ ...r })); },
    setFamilies(list) { families.length = 0; for (const ids of list || []) families.push(new Set(ids)); },
  };

  return { on: allowed, api, gcPart, control };
}

module.exports = { install };
