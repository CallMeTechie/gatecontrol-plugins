'use strict';

// gc.places for the mock host (tools/testing/mock-host.js): "Meine Orte" of the user profile (GateControl 1.298.0,
// src/services/places.js, hostApi.js placesCall, the child bootstrap makePlaces; docs/plugins.md "Meine Orte").
// Opt-in: opts.places or opts.gatecontrol ≥ '1.298.0'. Like the child bootstrap, gc.places is only there with
// permissions.places === true (feature test `if (gc.places)`); an older GateControl has none at all.
//
//   createHost(dir, { places: {
//     places: [{ userId: 1, name: 'Arbeit', lat: 50.11, lon: 8.68, icon?, radiusM?, address?, visibility? }],
//     families: [[1, 2, 3]],     // accounts in one GateControl group of the kind "Familie" (visibility 'family')
//   } })
//
// Like the host:
//   gc.places.version                          1
//   gc.places.list({ userId, owner? })          [place] — own ones first (own: true, usedBy), then of others 'all' and,
//                                               in one family, 'family' (own: false, ownerId, ownerName, no usedBy)
//   gc.places.get({ userId, id })               place | null (unknown or not visible to userId)
//   gc.places.resolve('profile:<id>' | { ref, userId? })   place | null; another ref → ERR_INVALID
//   gc.places.markUsed({ userId, id })          { id, lastUsedAt } — own places only, else ERR_NOT_FOUND
//   gc.places.reportUsage({ userId, id, kind, count })     { usedBy } — absolute count per (place, plugin, kind), 0 removes
//   gc.places.importFor({ userId, places, source })        { map: { [sourceRef]: { id, ref, created } }, skipped } —
//                                               idempotent over (person, source, sourceRef); "Name 2" for a name in use;
//                                               unknown keys / bad fields → skipped invalid with the field; ≥ 100 → limit
// What the person does in "Mein Profil › Meine Orte" (each one calls the hook placesChanged like the host; awaited):
//   host.places.add(userId, fields) → place      await host.places.update(id, patch) → place
//   await host.places.remove(id)                 host.places.all() → every row      host.places.usage(id) → usedBy
//   host.places.calls                            [{ method, args }] every gc.places call
//   await host.places.settle()                   the hooks the host sent on its own (after importFor) have run
//   host.places.failNext(code)                   the next gc.places call throws code (a host that is gone for a moment)

const ICONS = ['home', 'work', 'school', 'gym', 'shop', 'family', 'pin'];
const VISIBILITY = ['self', 'family', 'all'];
const SOURCES = ['manual', 'notizen', 'familie', 'messenger'];
const NAME_MAX = 60;
const ADDRESS_MAX = 200;
const RADIUS_MIN = 50;
const RADIUS_MAX = 2000;
const RADIUS_DEFAULT = 150;
const MAX_PLACES = 100;
const IMPORT_MAX = 100;
const SOURCE_REF_MAX = 120;
const USAGE_MAX = 1000000;
const KIND_RE = /^[a-z][a-z0-9_.-]{0,39}$/;
const REF_RE = /^profile:(\d{1,15})$/;
const KEYS = ['name', 'icon', 'lat', 'lon', 'radiusM', 'address', 'visibility'];

const stamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const clean = (s) => String(s).replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();

function install({ opts, perms, atLeast, enabledUser, hostError, pluginId, pluginName }) {
  const o = opts.places && typeof opts.places === 'object' ? opts.places : null;
  const on = !!o || atLeast(298);
  const allowed = on && perms.places === true;
  if (on && perms.places != null && typeof perms.places !== 'boolean') throw hostError('ERR_INVALID', 'plugin.json: permissions.places: invalid');
  let plugin = {};
  let hook = async () => undefined;
  const rows = new Map();
  const usage = new Map(); // `${placeId}|${plugin}|${kind}` → count
  const families = ((o && o.families) || []).map((ids) => new Set(ids));
  const calls = [];
  const pending = [];
  let nextId = 1;
  let failCode = null;

  const invalid = (field, msg) => { const e = hostError('ERR_INVALID', msg || `invalid ${field}`); e.field = field; return e; };
  const user = (v, field = 'userId') => { const n = Number(v); if (!Number.isSafeInteger(n) || n <= 0) throw invalid(field); return n; };
  const sameFamily = (a, b) => families.some((f) => f.has(a) && f.has(b));
  const relation = (viewer, owner) => (viewer === owner ? 'self' : sameFamily(viewer, owner) ? 'family' : 'other');
  const sees = (vis, rel) => rel === 'self' || vis === 'all' || (vis === 'family' && rel === 'family');

  /** The fields of a place (src/services/places.js fields): unknown keys and bad values → ERR_INVALID with the field. */
  function fields(raw, partial) {
    const x = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
    if (!x) throw invalid('body');
    for (const k of Object.keys(x)) if (!KEYS.includes(k)) throw invalid(k);
    const f = {};
    if (x.name !== undefined || !partial) {
      const n = typeof x.name === 'string' ? clean(x.name) : '';
      if (!n || Array.from(n).length > NAME_MAX) throw invalid('name');
      f.name = n;
    }
    if (x.icon !== undefined) { if (!ICONS.includes(x.icon)) throw invalid('icon'); f.icon = x.icon; } else if (!partial) f.icon = 'pin';
    if (x.lat !== undefined || x.lon !== undefined || !partial) {
      const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN);
      const lat = num(x.lat);
      const lon = num(x.lon);
      if (!Number.isFinite(lat) || Math.abs(lat) > 90) throw invalid('lat');
      if (!Number.isFinite(lon) || Math.abs(lon) > 180) throw invalid('lon');
      if (lat === 0 && lon === 0) throw invalid('lat');
      f.lat = Math.round(lat * 1e6) / 1e6;
      f.lon = Math.round(lon * 1e6) / 1e6;
    }
    if (x.radiusM !== undefined) {
      const r = typeof x.radiusM === 'number' ? Math.round(x.radiusM) : NaN;
      if (!Number.isFinite(r) || r < RADIUS_MIN || r > RADIUS_MAX) throw invalid('radiusM');
      f.radiusM = r;
    } else if (!partial) f.radiusM = RADIUS_DEFAULT;
    if (x.address !== undefined) {
      if (x.address !== null && typeof x.address !== 'string') throw invalid('address');
      const a = x.address == null ? '' : clean(x.address);
      if (Array.from(a).length > ADDRESS_MAX) throw invalid('address');
      f.address = a || null;
    } else if (!partial) f.address = null;
    if (x.visibility !== undefined) { if (!VISIBILITY.includes(x.visibility)) throw invalid('visibility'); f.visibility = x.visibility; } else if (!partial) f.visibility = 'self';
    return f;
  }

  const usedBy = (id) => [...usage].filter(([k, n]) => k.startsWith(id + '|') && n > 0)
    .map(([k, n]) => { const [, p, kind] = k.split('|'); return { plugin: p, pluginName: p === pluginId ? pluginName : p, kind, count: n }; });
  function view(r, viewer) {
    const base = { id: r.id, ref: `profile:${r.id}`, name: r.name, icon: r.icon, lat: r.lat, lon: r.lon, radiusM: r.radiusM, address: r.address, visibility: r.visibility, source: r.source,
      createdAt: r.createdAt, updatedAt: r.updatedAt, lastUsedAt: r.lastUsedAt };
    if (viewer != null && viewer !== r.userId) {
      const owner = enabledUser(r.userId);
      return { ...base, ownerId: r.userId, ownerName: owner ? owner.name : '', own: false };
    }
    return { ...base, usedBy: usedBy(r.id), ownerId: r.userId, ...(viewer != null ? { own: true } : {}) };
  }
  function placeFor(id, viewer) {
    const r = rows.get(id);
    if (!r) return null;
    if (viewer != null) {
      const rel = relation(viewer, r.userId);
      if (rel !== 'self' && !enabledUser(r.userId)) return null;
      if (!sees(r.visibility, rel)) return null;
    }
    return view(r, viewer);
  }
  const ownRows = (uid) => [...rows.values()].filter((r) => r.userId === uid);
  const nameTaken = (uid, name, except) => ownRows(uid).some((r) => r.id !== except && r.name.toLowerCase() === name.toLowerCase());

  /** The hook placesChanged, as the host sends it (to a running plugin with permissions.places; the answer ignored). */
  async function changed(userId, ids, deleted) {
    if (!allowed || typeof plugin.placesChanged !== 'function' || !ids.length) return;
    try { await hook('placesChanged', { userId, ids: ids.slice(0, 100), deleted: !!deleted }); } catch { /* like the host */ }
  }
  const later = (userId, ids, deleted) => { pending.push(new Promise((resolve) => setImmediate(() => changed(userId, ids, deleted).then(resolve, resolve)))); };

  function insert(userId, f, source, sourceRef) {
    const id = nextId++;
    const now = stamp();
    rows.set(id, { id, userId, ...f, source, sourceRef: sourceRef || null, createdAt: now, updatedAt: now, lastUsedAt: null });
    return id;
  }
  for (const p of (o && o.places) || []) {
    const { userId, source, sourceRef, ...rest } = p;
    insert(userId, fields(rest, false), source || 'manual', sourceRef);
  }

  function check(method, args) {
    calls.push({ method, args });
    if (!allowed) throw hostError('ERR_PLACES_DENIED', 'this plugin has no places permission');
    if (failCode) { const c = failCode; failCode = null; throw hostError(c, 'the host failed'); }
  }

  const api = {
    'places.list': async (a) => {
      check('list', a);
      const uid = user(a.userId);
      const owner = a.owner == null ? null : user(a.owner, 'owner');
      const list = [...rows.values()].filter((r) => (owner == null || r.userId === owner)).map((r) => placeFor(r.id, uid)).filter(Boolean);
      return list.sort((x, y) => (Number(y.own) - Number(x.own)) || x.name.localeCompare(y.name, 'de', { sensitivity: 'base' }) || x.id - y.id);
    },
    'places.get': async (a) => { check('get', a); return placeFor(user(a.id, 'id'), user(a.userId)); },
    'places.resolve': async (a) => {
      check('resolve', a);
      const m = typeof a.ref === 'string' ? REF_RE.exec(a.ref.trim()) : null;
      if (!m) throw invalid('ref', "ref must be 'profile:<id>'");
      return placeFor(Number(m[1]), a.userId == null ? null : user(a.userId));
    },
    'places.markUsed': async (a) => {
      check('markUsed', a);
      const uid = user(a.userId);
      const r = rows.get(user(a.id, 'id'));
      if (!r || r.userId !== uid) throw hostError('ERR_NOT_FOUND', 'unknown place');
      r.lastUsedAt = stamp();
      return { id: r.id, lastUsedAt: r.lastUsedAt };
    },
    'places.reportUsage': async (a) => {
      check('reportUsage', a);
      const uid = user(a.userId);
      const id = user(a.id, 'id');
      if (typeof a.kind !== 'string' || !KIND_RE.test(a.kind)) throw invalid('kind');
      if (typeof a.count !== 'number' || !Number.isSafeInteger(a.count) || a.count < 0 || a.count > USAGE_MAX) throw invalid('count');
      const p = placeFor(id, uid);
      if (!p) throw hostError('ERR_NOT_FOUND', 'unknown place');
      const k = `${id}|${pluginId}|${a.kind}`;
      if (a.count === 0) usage.delete(k); else usage.set(k, a.count);
      return { usedBy: usedBy(id) };
    },
    'places.importFor': async (a) => {
      check('importFor', a);
      const uid = user(a.userId);
      if (!enabledUser(uid)) throw hostError('ERR_NOT_FOUND', 'unknown user');
      if (!SOURCES.includes(a.source) || a.source === 'manual') throw invalid('source');
      if (!Array.isArray(a.places) || a.places.length > IMPORT_MAX) throw invalid('places', `places: a list of at most ${IMPORT_MAX}`);
      const map = {};
      const skipped = [];
      const created = [];
      const seen = new Set();
      for (const raw of a.places) {
        const item = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
        const ref = typeof item.sourceRef === 'string' ? item.sourceRef.trim() : '';
        if (!ref || ref.length > SOURCE_REF_MAX || /[\0-\x1f\x7f]/.test(ref) || seen.has(ref)) { skipped.push({ sourceRef: ref || null, reason: 'invalid', field: 'sourceRef' }); continue; }
        seen.add(ref);
        const before = [...rows.values()].find((r) => r.userId === uid && r.source === a.source && r.sourceRef === ref);
        if (before) { map[ref] = { id: before.id, ref: `profile:${before.id}`, created: false }; continue; }
        const { sourceRef: _ignored, ...rest } = item;
        let f;
        try { f = fields(rest, false); } catch (e) { skipped.push({ sourceRef: ref, reason: 'invalid', field: e.field || null }); continue; }
        if (ownRows(uid).length >= MAX_PLACES) { skipped.push({ sourceRef: ref, reason: 'limit' }); continue; }
        let name = f.name;
        for (let i = 2; nameTaken(uid, name); i++) { const suffix = ` ${i}`; name = Array.from(f.name).slice(0, NAME_MAX - suffix.length).join('').trim() + suffix; }
        const id = insert(uid, { ...f, name }, a.source, ref);
        created.push(id);
        map[ref] = { id, ref: `profile:${id}`, created: true };
      }
      if (created.length) later(uid, created, false);
      return { map, skipped };
    },
  };

  const gcPart = (call) => Object.freeze({
    version: 1,
    list: (x) => call('places.list', { userId: x && x.userId, owner: x && x.owner != null ? x.owner : null }),
    get: (x) => call('places.get', { userId: x && x.userId, id: x && x.id }),
    resolve: (ref) => call('places.resolve', typeof ref === 'string' ? { ref } : { ref: ref && ref.ref, userId: ref && ref.userId != null ? ref.userId : null }),
    markUsed: (x) => call('places.markUsed', { userId: x && x.userId, id: x && x.id }),
    reportUsage: (x) => call('places.reportUsage', { userId: x && x.userId, id: x && x.id, kind: x && x.kind, count: x && x.count }),
    importFor: (x) => call('places.importFor', { userId: x && x.userId, places: x && x.places, source: x && x.source }),
  });

  const control = {
    calls,
    bind(p, h) { plugin = p; hook = h; },
    all: () => [...rows.values()].map((r) => ({ ...r })),
    usage: (id) => usedBy(id),
    failNext(code) { failCode = code || 'ERR_INTERNAL'; },
    async settle() { while (pending.length) await pending.shift(); },
    add(userId, f) {
      const { source, sourceRef, ...rest } = f || {};
      const x = fields(rest, false);
      if (nameTaken(userId, x.name)) throw hostError('ERR_INVALID', 'DUPLICATE');
      const id = insert(userId, x, source || 'manual', sourceRef);
      later(userId, [id], false);
      return view(rows.get(id), userId);
    },
    async update(id, patch) {
      const r = rows.get(id);
      if (!r) throw hostError('ERR_NOT_FOUND', 'unknown place');
      const f = fields(patch, true);
      if (f.name && nameTaken(r.userId, f.name, r.id)) throw hostError('ERR_INVALID', 'DUPLICATE');
      Object.assign(r, f, { updatedAt: stamp() });
      await changed(r.userId, [id], false);
      return view(r, r.userId);
    },
    async remove(id) {
      const r = rows.get(id);
      if (!r) return false;
      rows.delete(id);
      for (const k of [...usage.keys()]) if (k.startsWith(id + '|')) usage.delete(k);
      await changed(r.userId, [id], true);
      return true;
    },
  };

  return { on: allowed, api, gcPart, control };
}

module.exports = { install };
