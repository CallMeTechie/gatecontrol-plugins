'use strict';

// Admin API (admin/*): the tabs Quellen, Personen, Geräte and the overview. Administrators in GateControl's admin UI only.
// Secrets go in (key, password) and never come back: answers say only `hasKey` / `hasPassword`.

const store = require('./store');
const jf = require('./jellyfin');
const sources = require('./sources');
const rights = require('./rights');
const mapping = require('./mapping');
const devices = require('./devices');
const log = require('./log');
const license = require('./license');
const assignments = require('./assignments');
const { fail, str, posInt } = require('./util');

const targetsOf = sources.targetsOf;

async function sourceView(gc, s, cfg, targets) {
  const hasSecret = !!(s.kind === 'jellyfin' ? await sources.apiKey(gc, s) : await sources.password(gc, s));
  const acc = await rights.accessList(gc, s.id);
  const pairs = await store.one(gc, 'SELECT COUNT(*) AS n FROM pairings WHERE source_id = ?', [s.id]);
  const dels = await store.one(gc, 'SELECT COUNT(*) AS n FROM deliveries WHERE source_id = ?', [s.id]);
  return {
    id: s.id, kind: s.kind, name: s.name, enabled: s.enabled, config: s.config, status: s.status, secretRev: s.secretRev,
    hasKey: s.kind === 'jellyfin' ? hasSecret : undefined, hasPassword: s.kind === 'share' ? hasSecret : undefined,
    away: sources.awayOf(s, cfg, targets), home: sources.homeOf(s), access: { mode: s.config.accessMode || 'all', ...acc },
    devices: s.kind === 'jellyfin' ? pairs.n : dels.n,
  };
}

/** Tell the apps of everybody with the right "Medien" that the list changed (open apps reload v1/sources). */
async function changed(gc) {
  const rev = await store.bump(gc);
  if (!gc.events || typeof gc.events.emit !== 'function') return rev;
  try {
    const users = [];
    for (const u of (await gc.users.list()) || []) if ((await rights.mediaOf(gc, u)).media) users.push(u.id);
    for (let i = 0; i < users.length; i += 500) await gc.events.emit({ users: users.slice(i, i + 500), type: 'media.changed', data: { rev } });
  } catch (e) { gc.log.debug('media.changed not sent', (e && e.code) || 'error'); }
  return rev;
}

async function people(gc, cfg) {
  const users = (await gc.users.list()) || [];
  let groups = [];
  try { if (gc.groups && typeof gc.groups.list === 'function') groups = ((await gc.groups.list()) || []).filter((g) => !g.archived); } catch { groups = []; }
  const all = await sources.list(gc);
  const rows = await store.all(gc, 'SELECT * FROM rights');
  const pick = (kind, id) => { const r = rows.find((x) => x.kind === kind && x.principal_id === id); return r && r.media != null ? r.media === 1 : null; };
  const jfUsers = {};
  for (const s of all.filter((x) => x.kind === 'jellyfin')) {
    try { jfUsers[s.id] = (await mapping.candidates(gc, s)).map((u) => ({ id: u.id, name: u.name, downloads: u.downloads, maxRating: u.maxRating })); } catch (e) { jfUsers[s.id] = null; }
  }
  const maps = await store.all(gc, 'SELECT * FROM mappings');
  const devCount = await store.all(gc, 'SELECT user_id, COUNT(DISTINCT device_id) AS n FROM (SELECT user_id, device_id FROM pairings UNION SELECT user_id, device_id FROM deliveries) GROUP BY user_id');
  const out = [];
  for (const u of users) {
    const m = await rights.mediaOf(gc, u);
    const g = await rights.groupsOf(gc, u.id);
    const access = {};
    const links = {};
    for (const s of all) {
      access[s.id] = { ...(await rights.sourceAccess(gc, u, s, cfg)), own: (await store.one(gc, "SELECT allow FROM source_access WHERE source_id = ? AND kind = 'user' AND principal_id = ?", [s.id, u.id])) };
      access[s.id].own = access[s.id].own ? access[s.id].own.allow === 1 : null;
      if (s.kind === 'jellyfin') {
        const mm = maps.find((x) => x.source_id === s.id && x.user_id === u.id);
        links[s.id] = mm ? { jfUserId: mm.jf_user_id, jfUserName: mm.jf_user_name, how: mm.how } : null;
      }
    }
    out.push({ id: u.id, name: u.name, role: u.role, color: u.colorHex || null, initials: u.initials || null, avatarUrl: u.avatarUrl || null,
      family: g.child ? 'child' : (g.parent ? 'parent' : null), media: { set: pick('user', u.id), effective: m.media, source: m.source },
      access, links, suggest: mapping.suggestName(u), devices: (devCount.find((x) => x.user_id === u.id) || {}).n || 0 });
  }
  return {
    people: out,
    groups: groups.map((g) => ({ id: g.id, name: g.name, path: g.path || g.name, kind: g.kind || null, media: pick('group', g.id) })),
    sources: all.map((s) => ({ id: s.id, kind: s.kind, name: s.name, enabled: s.enabled })),
    jellyfinUsers: jfUsers,
    settings: { autoMap: cfg.autoMap, childrenShares: cfg.childrenShares },
  };
}

async function overview(gc, cfg) {
  const all = await sources.list(gc);
  const targets = await targetsOf(gc);
  const users = (await gc.users.list()) || [];
  let media = 0;
  for (const u of users) if ((await rights.mediaOf(gc, u)).media) media++;
  const linked = await store.one(gc, 'SELECT COUNT(DISTINCT user_id) AS n FROM mappings WHERE jf_user_id IS NOT NULL');
  const devs = await store.one(gc, 'SELECT COUNT(DISTINCT device_id) AS n FROM (SELECT device_id FROM pairings UNION SELECT device_id FROM deliveries)');
  const problems = await store.all(gc, 'SELECT device_id, source_id, problem, at FROM reports WHERE ok = 0 ORDER BY at DESC LIMIT 10');
  return {
    license: await license.state(gc),
    sources: all.map((s) => ({ id: s.id, kind: s.kind, name: s.name, enabled: s.enabled, status: s.status, away: sources.awayOf(s, cfg, targets), home: { level: sources.homeOf(s).level } })),
    people: { total: users.length, media, linked: linked.n }, devices: devs.n,
    problems, settings: { awayDirectAll: cfg.awayDirectAll, cast: cfg.cast },
    log: await log.list(gc, 30),
  };
}

/**
 * A probe before saving (the dialog "Prüfung"). Jellyfin: reachable, version, key, Quick Connect, users, libraries.
 * A NAS share (kind 'share', 1.4.0): the WebDAV sign-in and folder with the entered user and password (or the saved
 * password when editing) through the dialog's WebDAV assignment — SMB only the devices can check.
 */
async function probe(gc, b) {
  if (b.kind === 'share') {
    const prev = b.sourceId ? await sources.get(gc, b.sourceId) : null;
    if (prev && prev.kind !== 'share') throw fail('invalid', { field: 'sourceId' });
    const config = sources.cleanConfig('share', b, prev ? prev.config : {});
    const pw = typeof b.password === 'string' && b.password ? b.password : (prev ? await sources.password(gc, prev) : null);
    return sources.checkShare(gc, { config }, pw);
  }
  const index = Number.isInteger(Number(b.targetIndex)) ? Number(b.targetIndex) : 0;
  let key = typeof b.key === 'string' && b.key ? b.key : null;
  if (!key && b.sourceId) { const s = await sources.get(gc, b.sourceId); if (s) key = await sources.apiKey(gc, s); }
  return sources.checkJellyfin(gc, index, key);
}

async function route(req, gc, seg, cfg, now = Date.now()) {
  const m = String(req.method || 'GET').toUpperCase();
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const [, a, x, y, z] = seg;
  if (a === 'overview' && m === 'GET') return overview(gc, cfg);
  if (a === 'targets' && !x && m === 'GET') return { targets: await targetsOf(gc), made: await assignments.made(gc) };
  if (a === 'targets' && x === 'made' && m === 'POST') return assignments.rememberMade(gc, b);
  if (a === 'targets' && x === 'compact' && m === 'POST') {
    const r = await assignments.compact(gc, b, now);
    if (r.changed) await log.add(gc, 'source', `Zugriffsziele (${b.target}) aufgeräumt: ${r.changed} Quelle(n) neu zugeordnet`, {}, now);
    return r;
  }
  if (a === 'probe' && m === 'POST') return { check: await probe(gc, b) };
  if (a === 'log' && m === 'GET') return { log: await log.list(gc, req.query && req.query.limit) };

  if (a === 'sources' && !x && m === 'GET') {
    const all = await sources.list(gc);
    const targets = await targetsOf(gc);
    const list = [];
    for (const s of all) list.push(await sourceView(gc, s, cfg, targets));
    return { sources: list, targets, made: await assignments.made(gc), settings: { awayDirectAll: cfg.awayDirectAll, childrenShares: cfg.childrenShares } };
  }
  if (a === 'sources' && !x && m === 'POST') {
    const s = await sources.create(gc, b, now);
    await log.add(gc, 'source', `Quelle ${s.name} (${s.kind === 'jellyfin' ? 'Jellyfin' : 'NAS-Freigabe'}) angelegt`, { sourceId: s.id }, now);
    let check = null;
    try { check = await sources.check(gc, s, now); } catch { check = null; }
    if (s.kind === 'jellyfin' && cfg.autoMap) {
      try {
        const ppl = [];
        for (const u of (await gc.users.list()) || []) if ((await rights.mediaOf(gc, u)).media) ppl.push(u);
        await mapping.auto(gc, s, ppl, now);
      } catch (e) { gc.log.debug('auto mapping failed', (e && e.code) || 'error'); }
    }
    await changed(gc);
    return { source: await sourceView(gc, await sources.need(gc, s.id), cfg), check };
  }
  if (a === 'sources' && x) {
    const src = await sources.need(gc, x);
    if (!y && m === 'GET') return { source: await sourceView(gc, src, cfg) };
    if (!y && m === 'PUT') {
      const { before } = await sources.update(gc, src.id, b, now);
      let after = await sources.need(gc, src.id);
      if (before.enabled && !after.enabled) await revokeSource(gc, after, 'source', now);
      // a Jellyfin source learns (again) its server ID — the devices' home probe
      if (after.kind === 'jellyfin' && after.enabled) {
        try { await sources.check(gc, after, now); } catch (e) { gc.log.debug('check failed', (e && e.code) || 'error'); }
        after = await sources.need(gc, src.id);
      }
      await log.add(gc, 'source', `Quelle ${after.name} geändert`, { sourceId: src.id }, now);
      await changed(gc);
      return { source: await sourceView(gc, after, cfg) };
    }
    if (!y && m === 'DELETE') {
      await revokeSource(gc, src, 'source', now);
      await sources.remove(gc, src.id);
      await log.add(gc, 'source', `Quelle ${src.name} entfernt`, { sourceId: src.id }, now);
      await changed(gc);
      return { removed: src.id };
    }
    if (y === 'check' && m === 'POST') return { check: await sources.check(gc, src, now) };
    if (y === 'key' && m === 'PUT') {
      await sources.setKey(gc, src.id, b.key);
      await log.add(gc, 'secret', `API-Schlüssel von ${src.name} ersetzt`, { sourceId: src.id }, now);
      return { check: await sources.check(gc, src, now) };
    }
    if (y === 'password' && m === 'PUT') {
      const s2 = await sources.setPassword(gc, src.id, b.password, now);
      await log.add(gc, 'secret', `Passwort von ${src.name} ersetzt (Stand ${s2.secretRev})`, { sourceId: src.id }, now);
      await changed(gc);
      return { source: await sourceView(gc, s2, cfg) };
    }
    if (y === 'quickconnect' && m === 'POST') {
      if (src.kind !== 'jellyfin') throw fail('invalid');
      const key = await sources.apiKey(gc, src);
      if (!key) throw fail('not_configured');
      await jf.setQuickConnect(gc, src.config.targetIndex || 0, key, b.on !== false);
      await log.add(gc, 'source', `Quick Connect in ${src.name} ${b.on !== false ? 'eingeschaltet' : 'ausgeschaltet'}`, { sourceId: src.id }, now);
      return { check: await sources.check(gc, src, now) };
    }
    if (y === 'access' && m === 'PUT') {
      const mode = b.mode === 'list' ? 'list' : 'all';
      const acc = await rights.setAccess(gc, src.id, { ...b, mode });
      await store.run(gc, 'UPDATE sources SET config = ?, updated_at = ? WHERE id = ?', [JSON.stringify({ ...src.config, accessMode: mode }), now, src.id]);
      rights.reset();
      await reconcileNow(gc, cfg, now);
      await changed(gc);
      return { access: { mode, ...acc } };
    }
    if (y === 'people' && z && m === 'PUT') {
      await rights.setPersonAccess(gc, src.id, z, b.allow === undefined ? null : b.allow);
      await reconcileNow(gc, cfg, now);
      await changed(gc);
      return { ok: true };
    }
    if (y === 'mapping' && z && m === 'PUT') {
      const r = b.jfUserId === undefined || b.auto === true ? (await mapping.clear(gc, src, z), { userId: posInt(z), how: null }) : await mapping.set(gc, src, z, b.jfUserId, now);
      if (b.auto === true && cfg.autoMap) { const u = await gc.users.get(posInt(z)); if (u) await mapping.auto(gc, src, [u], now); }
      await log.add(gc, 'mapping', `Zuordnung von ${((await gc.users.get(posInt(z))) || {}).name || z} in ${src.name} geändert`, { userId: posInt(z), sourceId: src.id }, now);
      await reconcileNow(gc, cfg, now);
      await changed(gc);
      return { mapping: r };
    }
    if (y === 'mapping' && z && seg[5] === 'create' && m === 'POST') {
      const r = await mapping.createFor(gc, src, z, b.name, now);
      await log.add(gc, 'mapping', `Jellyfin-Benutzer ${r.jfUserName} für ${((await gc.users.get(posInt(z))) || {}).name || z} angelegt (${src.name})`, { userId: posInt(z), sourceId: src.id }, now);
      await reconcileNow(gc, cfg, now);
      await changed(gc);
      return { mapping: r };
    }
    if (y === 'automap' && m === 'POST') {
      const ppl = [];
      for (const u of (await gc.users.list()) || []) if ((await rights.mediaOf(gc, u)).media) ppl.push(u);
      const made = await mapping.auto(gc, src, ppl, now);
      if (made.length) await changed(gc);
      return { mapped: made };
    }
  }
  if (a === 'people' && !x && m === 'GET') return people(gc, cfg);
  if (a === 'rights' && x && y && m === 'PUT') {
    await rights.setMedia(gc, x, y, b.media === undefined ? null : b.media, now);
    await reconcileNow(gc, cfg, now);
    await changed(gc);
    return { ok: true };
  }
  if (a === 'devices' && !x && m === 'GET') return { devices: await devices.overview(gc, cfg) };
  if (a === 'devices' && x && y === 'revoke' && m === 'POST') {
    const sid = b.sourceId ? [String(b.sourceId)] : null;
    const t = await devices.revoke(gc, String(x), { sourceIds: sid, reason: 'admin', always: true }, now);
    await changed(gc);
    return { revoked: t };
  }
  throw fail('not_found');
}

/** Revoke every device of a source (removed or switched off). */
async function revokeSource(gc, src, reason, now) {
  const ids = await store.all(gc, 'SELECT DISTINCT device_id FROM pairings WHERE source_id = ? UNION SELECT DISTINCT device_id FROM deliveries WHERE source_id = ?', [src.id, src.id]);
  for (const r of ids) await devices.revoke(gc, r.device_id, { sourceIds: [src.id], reason }, now);
}

/** After a change of rights or mappings: revoke what is no longer allowed right away (no server check). */
async function reconcileNow(gc, cfg, now) {
  rights.reset();
  try { await devices.reconcile(gc, cfg, now, { check: false }); } catch (e) { gc.log.warn('reconcile failed', (e && e.code) || 'error'); }
}

module.exports = { route, changed, people, overview, revokeSource, reconcileNow, str };
