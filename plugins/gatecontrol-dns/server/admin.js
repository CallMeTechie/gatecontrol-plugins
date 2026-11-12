'use strict';

// The settings page (admin/*): overview, lists and own entries, profiles, devices, the query log, the settings and
// the set-up dialog. Only an administrator in GateControl's admin UI gets here
// (server/index.js); GateControl checks the administrator again for every change (the actor of gc.vpnDns).
//
//   GET  admin/all                       everything the page shows
//   GET  admin/live                      what changes by itself (state, devices, suspensions, today)
//   PUT  admin/settings                  enabled, upstream, blockResponse, allow, deny, log, excluded, blockForeignDns,
//                                        homeInternet (gc.vpnDns.set)
//   PUT  admin/config                    the plugin's own settings (server/config.js)
//   POST admin/profiles                  a new profile            PUT | DELETE admin/profiles/<id>
//                                        profile.home: { gateway, profile } | { gateway, create: true } | null — shared
//                                        with a profile of a home network (gc.vpnDns.homes)
//   PUT  admin/devices/<peerId>          { profileId | null, excluded }      POST admin/devices/<peerId>/resume
//   POST admin/pause  { minutes | forever | extend }   POST admin/resume     — for all VPN devices
//   POST admin/test   { domain, peerId? | profileId? }                        "Domain prüfen"
//   POST admin/entries { list: 'allow' | 'deny', domains: [], profileId?, remove? }
//   POST admin/lists/refresh · POST admin/restart · GET admin/log · POST admin/log/clear
//   POST admin/setup/start { lists } · GET admin/setup/state · POST admin/setup/finish | later | cancel

const config = require('./config');
const rights = require('./rights');
const api = require('./api');
const { fail, host, posInt, clip } = require('./util');

const SETTINGS_KEYS = ['enabled', 'upstream', 'blockResponse', 'allow', 'deny', 'log', 'excluded', 'blockForeignDns', 'homeInternet'];
const PROFILE_KEYS = ['name', 'lists', 'safeSearch', 'allow', 'deny', 'schedules', 'groups', 'peerGroups', 'users', 'peers', 'home'];
// names the ad lists of the catalogue block (which ones depends on the list — the first that is blocked is shown)
const PROBE_BLOCK = ['googlesyndication.com', 'doubleclick.net', 'google-analytics.com', 'app-measurement.com'];
const PROBE_ALLOW = 'example.org';

const v = (gc) => gc.vpnDns;

async function names(gc) {
  let users = [];
  let groups = [];
  try { users = ((await gc.users.list()) || []).map((u) => ({ id: u.id, name: u.name, role: u.role === 'admin' ? 'admin' : 'user' })); } catch { users = []; }
  try { groups = ((await gc.groups.list()) || []).filter((g) => !g.archived).map((g) => ({ id: g.id, name: g.path || g.name, kind: g.kind })); } catch { groups = []; }
  return { users, groups };
}

function peerGroupsOf(devices) {
  const by = new Map();
  for (const d of devices) if (d.peerGroup && !by.has(d.peerGroup.id)) by.set(d.peerGroup.id, { id: d.peerGroup.id, name: d.peerGroup.name });
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function all(gc) {
  const [status, settings, catalog, devices, lists, stats, pauses, homes, cfg, nm] = await Promise.all([
    host(() => v(gc).status()), host(() => v(gc).get()), host(() => v(gc).catalog()), host(() => v(gc).devices()), host(() => v(gc).lists()),
    host(() => v(gc).stats({ days: 7 })), host(() => v(gc).pauses()), host(() => v(gc).homes()), config.load(gc), names(gc),
  ]);
  return { status, settings, catalog, devices, lists, stats, pauses, homes, config: cfg, users: nm.users, groups: nm.groups, peerGroups: peerGroupsOf(devices), durations: rights.DURATIONS, maxMinutes: config.MAX_MINUTES };
}

async function live(gc) {
  const [status, devices, pauses, stats] = await Promise.all([host(() => v(gc).status()), host(() => v(gc).devices()), host(() => v(gc).pauses()), host(() => v(gc).stats({ days: 1 }))]);
  return { status, devices, pauses, today: stats.today };
}

const actor = (user) => ({ actor: user.id });

/** `home` of a profile: null (no longer shared), { gateway, profile } (the home's profile) or { gateway, create: true }. */
function homeField(h) {
  if (h === null) return null;
  if (!h || typeof h !== 'object' || Array.isArray(h) || !posInt(h.gateway)) throw fail('invalid', { detail: 'profile.home' });
  if (h.create === true) return { gateway: posInt(h.gateway), create: true };
  if (typeof h.profile !== 'string' || !h.profile) throw fail('invalid', { detail: 'profile.home' });
  return { gateway: posInt(h.gateway), profile: h.profile };
}

function profileFields(b, isDefault) {
  const src = b && typeof b === 'object' && !Array.isArray(b) ? b : null;
  if (!src) throw fail('invalid', { detail: 'profile' });
  const out = {};
  for (const k of PROFILE_KEYS) {
    if (src[k] === undefined) continue;
    if (isDefault && ['groups', 'peerGroups', 'users', 'peers'].includes(k)) continue; // the default profile has no members
    if (k === 'home') { out.home = homeField(src.home); continue; }
    out[k] = src[k];
  }
  return out;
}

async function saveProfile(gc, user, id, body) {
  const before = await host(() => v(gc).get());
  const limits = (await host(() => v(gc).catalog())).limits;
  const b = body && typeof body === 'object' ? body : {};
  let profiles;
  if (id === null) {
    if (before.profiles.length >= limits.profiles) throw fail('limit', { max: limits.profiles });
    profiles = [...before.profiles.map((p) => ({ id: p.id })), profileFields(b.profile, false)];
  } else {
    if (!before.profiles.some((p) => p.id === id)) throw fail('not_found');
    profiles = before.profiles.map((p) => (p.id === id ? { id, ...profileFields(b.profile, id === 'default') } : { id: p.id }));
  }
  const after = await host(() => v(gc).set({ profiles }, actor(user)));
  const known = new Set(before.profiles.map((p) => p.id));
  const saved = id === null ? after.profiles.find((p) => !known.has(p.id)) : after.profiles.find((p) => p.id === id);
  let cfg = await config.load(gc);
  if (saved && typeof b.pauseAllowed === 'boolean') cfg = await config.save(gc, { pause: { profiles: { [saved.id]: b.pauseAllowed } } });
  return { settings: after, profile: saved || null, config: cfg };
}

async function removeProfile(gc, user, id) {
  if (id === 'default') throw fail('invalid', { detail: 'default' });
  const before = await host(() => v(gc).get());
  if (!before.profiles.some((p) => p.id === id)) throw fail('not_found');
  const after = await host(() => v(gc).set({ profiles: before.profiles.filter((p) => p.id !== id).map((p) => ({ id: p.id })) }, actor(user)));
  return { settings: after, config: await config.prune(gc, after.profiles.map((p) => p.id)) };
}

/** "Profil ändern" of a device: its own profile (none = the person's, the group's or the default one) or left out entirely. */
async function saveDevice(gc, user, peerId, body) {
  const b = body && typeof body === 'object' ? body : {};
  const before = await host(() => v(gc).get());
  const devices = await host(() => v(gc).devices());
  const d = devices.find((x) => x.peerId === peerId);
  if (!d || d.type !== 'peer') throw fail('not_found');
  const patch = {};
  if (b.excluded !== undefined) {
    if (typeof b.excluded !== 'boolean') throw fail('invalid', { detail: 'excluded' });
    const set = new Set(before.excluded);
    if (b.excluded) set.add(peerId); else set.delete(peerId);
    patch.excluded = [...set];
  }
  if (b.profileId !== undefined) {
    const pid = b.profileId === null || b.profileId === '' ? null : String(b.profileId);
    if (pid !== null && (pid === 'default' || !before.profiles.some((p) => p.id === pid))) throw fail('not_found');
    patch.profiles = before.profiles.map((p, i) => {
      if (i === 0) return { id: p.id };
      const has = p.peers.includes(peerId);
      if (p.id === pid) return has ? { id: p.id } : { id: p.id, peers: [...p.peers, peerId] };
      return has ? { id: p.id, peers: p.peers.filter((x) => x !== peerId) } : { id: p.id };
    });
  }
  if (!Object.keys(patch).length) throw fail('invalid');
  const after = await host(() => v(gc).set(patch, actor(user)));
  return { settings: after, devices: await host(() => v(gc).devices()) };
}

/** Own entries: add to (or remove from) "Immer erlaubt" / "Immer gesperrt" — for everybody or in one profile. */
async function entries(gc, user, body) {
  const b = body && typeof body === 'object' ? body : {};
  const list = b.list === 'allow' || b.list === 'deny' ? b.list : null;
  const raw = Array.isArray(b.domains) ? b.domains : (typeof b.domain === 'string' ? [b.domain] : null);
  if (!list || !raw || !raw.length || raw.length > 200) throw fail('invalid', { detail: 'domains' });
  const clean = raw.map((x) => clip(String(x), 260).toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '').replace(/\.$/, '')).filter(Boolean);
  if (!clean.length) throw fail('invalid_domain');
  const other = list === 'allow' ? 'deny' : 'allow';
  const before = await host(() => v(gc).get());
  const apply = (o) => {
    const mine = new Set(o[list]);
    const theirs = new Set(o[other]);
    for (const d of clean) { if (b.remove === true) mine.delete(d); else { mine.add(d); theirs.delete(d); } }
    return { [list]: [...mine], ...(theirs.size !== o[other].length ? { [other]: [...theirs] } : {}) };
  };
  let patch;
  if (b.profileId !== undefined && b.profileId !== null && b.profileId !== '') {
    const pid = String(b.profileId);
    if (!before.profiles.some((p) => p.id === pid)) throw fail('not_found');
    patch = { profiles: before.profiles.map((p) => (p.id === pid ? { id: p.id, ...apply(p) } : { id: p.id })) };
  } else patch = apply(before);
  return { settings: await host(() => v(gc).set(patch, actor(user))) };
}

async function test(gc, body) {
  const b = body && typeof body === 'object' ? body : {};
  const domain = clip(String(b.domain || ''), 260).toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '');
  if (!domain) throw fail('invalid_domain');
  const who = posInt(b.peerId) ? { peerId: posInt(b.peerId) } : (b.profileId ? { profileId: String(b.profileId) } : {});
  return { result: await host(() => v(gc).test(domain, who)) };
}

async function adminLog(gc, query) {
  const q = query && typeof query === 'object' ? query : {};
  const ask = { limit: Math.min(200, posInt(q.limit) || 100) };
  if (posInt(q.before)) ask.before = posInt(q.before);
  if (posInt(q.peerId)) ask.peerId = posInt(q.peerId);
  if (q.blockedOnly === true || q.blockedOnly === '1' || q.blockedOnly === 'true') ask.blockedOnly = true;
  if (q.scope === 'all' || q.scope === 'profile') ask.scope = q.scope;   // own entries: for everybody / of a profile
  const search = clip(q.search, 100);
  if (search) ask.search = search;
  const days = posInt(q.days);
  if (days) { const since = new Date(); since.setHours(0, 0, 0, 0); ask.since = new Date(since.getTime() - (days - 1) * 86400000).toISOString(); }
  const [r, devices, settings] = await Promise.all([host(() => v(gc).log(ask)), host(() => v(gc).devices()), host(() => v(gc).get())]);
  const nm = new Map(settings.profiles.map((p) => [p.id, p.name]));
  return { entries: ((r && r.entries) || []).map((e) => api.logEntry(e, devices, nm)), next: (r && r.next) || null };
}

// ─── Set-up ───

async function setupStart(gc, user, body) {
  const b = body && typeof body === 'object' ? body : {};
  if (!Array.isArray(b.lists)) throw fail('invalid', { detail: 'lists' });
  const before = await host(() => v(gc).get());
  const patch = {
    profiles: before.profiles.map((p, i) => (i === 0 ? { id: 'default', lists: b.lists } : { id: p.id })),
    enabled: true,
  };
  return { settings: await host(() => v(gc).set(patch, actor(user))) };
}

/** Where the switch-over stands: the state, the lists and — once the service answers — the probe. */
async function setupState(gc) {
  const [status, lists] = await Promise.all([host(() => v(gc).status()), host(() => v(gc).lists())]);
  let probe = null;
  if (status.state === 'filtering' || (status.service && status.service.ready)) {
    try {
      const t0 = Date.now();
      const ok = await v(gc).test(PROBE_ALLOW);
      const ms = Date.now() - t0;
      let block = null;
      for (const domain of PROBE_BLOCK) {
        const r = await v(gc).test(domain);
        if (!block || r.action === 'block') block = { domain, action: r.action };
        if (r.action === 'block') break;
      }
      probe = { block, allow: { domain: PROBE_ALLOW, action: ok.action }, ms };
    } catch { probe = null; }
  }
  return { status, lists, probe };
}

async function setupFinish(gc) {
  return { config: await config.save(gc, { setupDone: true }), status: await host(() => v(gc).status()) };
}

async function route(req, gc, seg) {
  const m = String(req.method || 'GET').toUpperCase();
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const user = req.user;
  const what = seg[1];
  const n = seg.length;
  if (what === 'all' && m === 'GET' && n === 2) return all(gc);
  if (what === 'live' && m === 'GET' && n === 2) return live(gc);
  if (what === 'settings' && m === 'PUT' && n === 2) {
    const patch = {};
    for (const k of Object.keys(b)) { if (!SETTINGS_KEYS.includes(k)) throw fail('invalid', { detail: k }); patch[k] = b[k]; }
    return { settings: await host(() => v(gc).set(patch, actor(user))), status: await host(() => v(gc).status()) };
  }
  if (what === 'config' && m === 'PUT' && n === 2) return { config: await config.save(gc, b) };
  if (what === 'profiles') {
    if (m === 'POST' && n === 2) return saveProfile(gc, user, null, b);
    if (m === 'PUT' && n === 3) return saveProfile(gc, user, seg[2], b);
    if (m === 'DELETE' && n === 3) return removeProfile(gc, user, seg[2]);
  }
  if (what === 'devices' && posInt(seg[2])) {
    if (m === 'PUT' && n === 3) return saveDevice(gc, user, posInt(seg[2]), b);
    if (m === 'POST' && n === 4 && seg[3] === 'resume') return api.resume(gc, user, { peerId: posInt(seg[2]) });
  }
  if (what === 'pause' && m === 'POST' && n === 2) return api.pause(gc, user, { ...b, all: true, peerId: undefined, userId: undefined });
  if (what === 'resume' && m === 'POST' && n === 2) return api.resume(gc, user, { all: true });
  if (what === 'test' && m === 'POST' && n === 2) return test(gc, b);
  if (what === 'entries' && m === 'POST' && n === 2) return entries(gc, user, b);
  if (what === 'lists' && seg[2] === 'refresh' && m === 'POST' && n === 3) return host(() => v(gc).refreshLists(actor(user)));
  if (what === 'restart' && m === 'POST' && n === 2) return host(() => v(gc).restart(actor(user)));
  if (what === 'log') {
    if (m === 'GET' && n === 2) return adminLog(gc, req.query || {});
    if (m === 'POST' && n === 3 && seg[2] === 'clear') return host(() => v(gc).clearLog(actor(user)));
  }
  if (what === 'setup') {
    if (m === 'POST' && n === 3 && seg[2] === 'start') return setupStart(gc, user, b);
    if (m === 'GET' && n === 3 && seg[2] === 'state') return setupState(gc);
    if (m === 'POST' && n === 3 && seg[2] === 'finish') return setupFinish(gc);
    if (m === 'POST' && n === 3 && seg[2] === 'later') return { config: await config.save(gc, { setupDone: true }) };
    if (m === 'POST' && n === 3 && seg[2] === 'cancel') return { settings: await host(() => v(gc).set({ enabled: false }, actor(user))) };
  }
  throw fail('not_found');
}

module.exports = { route, all, PROBE_BLOCK, PROBE_ALLOW };
