'use strict';

// The person API — the GateControl apps (Android, Windows: /api/v1/client/plugins/gatecontrol-dns/api/…, the viewer
// carries `peerId`, the VPN peer of the asking device) and the portal tab: the state of the protection for the own
// device, suspending it and switching it back on, for administrators and parents also the people they may decide
// for, the own query log. Every call is checked here (server/rights.js) — the apps only draw what `may` says.
//
//   GET  status                      → state, device, profile, pause, counters, top, may, today, devices, manage
//   POST pause  { minutes | forever: true | extend: minutes, peerId? | userId? | all? }
//   POST resume { peerId? | userId? | all? }
//   GET  people                      → the people (with their devices) the viewer may suspend for (admin, parent)
//   GET  log?limit&before&peerId&blockedOnly&search   → the viewer's own devices only
//
// Without a target a change holds for the asking device (`peerId` of the viewer), else for all devices of the person.

const config = require('./config');
const rights = require('./rights');
const { fail, host, posInt, clip, percent } = require('./util');

function personOf(req) {
  const u = req.user;
  if (!u || !Number.isSafeInteger(u.id) || u.loggedIn === false || u.kiosk === true || u.automation === true) throw fail('forbidden');
  return u;
}

const isPeer = (d) => d.type === 'peer';
const ownerOf = (d) => (d.user ? { id: d.user.id, role: d.user.role } : null);

/** Everything a decision needs, read once per request. */
async function load(gc, user) {
  const [st, devices, pauses, cfg, fam] = await Promise.all([
    host(() => gc.vpnDns.status()), host(() => gc.vpnDns.devices()), host(() => gc.vpnDns.pauses()), config.load(gc), rights.families(gc),
  ]);
  // the asking device: the peer of the app's token — the viewer's own (or one without a person)
  let own = Number.isSafeInteger(user.peerId) ? devices.find((d) => d.peerId === user.peerId && isPeer(d)) || null : null;
  if (own && own.user && own.user.id !== user.id) own = null;
  const mine = devices.filter((d) => isPeer(d) && ((d.user && d.user.id === user.id) || (own && d.peerId === own.peerId)));
  return { st, devices, pauses, cfg, fam, own, mine, actor: { id: user.id, role: user.role === 'admin' ? 'admin' : 'user' } };
}

/** The suspension that holds for a device right now (as gc.vpnDns.pauses() answers it), or null. */
function pauseOf(c, d) {
  if (!d || !d.suspended) return null;
  if (d.suspendedBy === 'all') return c.pauses.find((p) => p.scope === 'all') || null;
  if (d.suspendedBy === 'peer') return c.pauses.find((p) => p.scope === 'peer' && p.id === d.peerId) || null;
  return (d.user && c.pauses.find((p) => p.scope === 'user' && p.id === d.user.id)) || null;
}

function pauseView(p, user, now = Date.now()) {
  if (!p) return null;
  const until = p.until ? Date.parse(p.until) : null;
  return {
    scope: p.scope, until: p.until || null, openEnd: !!p.openEnd, since: p.since || null,
    by: p.by ? { userId: p.by.userId, name: p.by.name } : null, byMe: !!(p.by && p.by.userId === user.id),
    remainingSeconds: until ? Math.max(0, Math.round((until - now) / 1000)) : null,
  };
}

function deviceView(c, d, user) {
  return {
    peerId: d.peerId, name: d.name, platform: d.platform || null, state: d.state, ownDns: d.ownDns || null,
    profile: d.profile ? { id: d.profile.id, name: d.profile.name } : null,
    suspended: !!d.suspended, pause: pauseView(pauseOf(c, d), user),
    today: d.today ? { queries: d.today.queries, blocked: d.today.blocked, percent: percent(d.today.blocked, d.today.queries) } : null,
  };
}

/** The target of a change: { scope, id, owner, profileIds, devices } — from the body, else the asking device, else the person. */
async function targetOf(gc, c, user, body) {
  const b = body && typeof body === 'object' ? body : {};
  const self = { id: user.id, role: c.actor.role };
  if (b.all === true) return { scope: 'all', id: null, owner: null, profileIds: [], devices: c.devices.filter((d) => d.state === 'filtered') };
  if (b.peerId !== undefined && b.peerId !== null) {
    const id = posInt(b.peerId);
    const d = id && c.devices.find((x) => x.peerId === id && isPeer(x));
    if (!d) throw fail('not_found');
    return { scope: 'peer', id, owner: ownerOf(d) || (c.own && c.own.peerId === id ? self : null), profileIds: d.profileId ? [d.profileId] : [], devices: [d] };
  }
  if (b.userId !== undefined && b.userId !== null) {
    const id = posInt(b.userId);
    if (!id) throw fail('invalid', { detail: 'userId' });
    const devs = c.devices.filter((d) => isPeer(d) && d.user && d.user.id === id);
    let owner = id === user.id ? self : (devs[0] ? ownerOf(devs[0]) : null);
    if (!owner) {
      let u = null;
      try { u = gc.users ? await gc.users.get(id) : null; } catch { u = null; }
      if (!u) throw fail('not_found');
      owner = { id, role: u.role === 'admin' ? 'admin' : 'user' };
    }
    return { scope: 'user', id, owner, profileIds: [...new Set(devs.map((d) => d.profileId).filter(Boolean))], devices: devs };
  }
  if (c.own) return { scope: 'peer', id: c.own.peerId, owner: self, profileIds: c.own.profileId ? [c.own.profileId] : [], devices: [c.own] };
  return { scope: 'user', id: user.id, owner: self, profileIds: [...new Set(c.mine.map((d) => d.profileId).filter(Boolean))], devices: c.mine };
}

/** What the viewer may do with a target right now: { pause, resume, extend, reason, durations, maxMinutes, forever }. */
function mayView(c, target) {
  const dec = rights.may(c.actor, target, c.cfg, c.fam);
  const lim = dec.ok ? dec.limits : rights.limits(c.actor, c.cfg);
  const filtered = target.devices.filter((d) => d.state === 'filtered');
  const suspended = target.scope === 'all' ? !!c.st.pause : filtered.some((d) => d.suspended);
  const byAll = target.scope !== 'all' && filtered.some((d) => d.suspendedBy === 'all');
  let reason = null;
  if (c.st.state === 'off' || c.st.state === 'starting') reason = 'off';
  else if (c.st.state === 'fallback') reason = 'fallback';
  else if (!target.devices.length) reason = 'no_device';
  else if (!filtered.length) reason = 'not_filtered';
  else if (!dec.ok) reason = dec.reason;
  const own = !!target.owner && target.owner.id === c.actor.id;
  const active = c.st.state === 'filtering';
  return {
    pause: !reason && !suspended,
    // switching back on is always allowed for the own devices — but a suspension for all devices ends only by an administrator
    resume: active && suspended && (c.actor.role === 'admin' || (!byAll && (dec.ok || own))),
    extend: !reason && suspended && !byAll && !filtered.some((d) => { const p = pauseOf(c, d); return p && p.openEnd; }),
    reason: reason || (suspended && byAll && c.actor.role !== 'admin' ? 'paused_for_all' : null),
    durations: reason ? [] : lim.durations, maxMinutes: lim.maxMinutes, forever: !reason && lim.forever,
  };
}

/** "Top gesperrte Domains" of today for the own devices — only with the query log on and when users may see it. */
async function topOf(gc, c, user, peerId) {
  if (!c.st.log.enabled || (c.cfg.logView !== 'own' && c.actor.role !== 'admin')) return null;
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  let r;
  try { r = await gc.vpnDns.log({ limit: 500, blockedOnly: true, since: since.toISOString(), ...(peerId ? { peerId } : { userId: user.id }) }); } catch { return null; }
  const n = new Map();
  for (const e of (r && r.entries) || []) n.set(e.name, (n.get(e.name) || 0) + 1);
  return [...n.entries()].map(([domain, count]) => ({ domain, count })).sort((a, b) => b.count - a.count || (a.domain < b.domain ? -1 : 1)).slice(0, 5);
}

/** The times of the profile that hold today (the server's weekday, Monday = 1). */
function todayOf(settings, profileId, now = new Date()) {
  const p = profileId && settings ? settings.profiles.find((x) => x.id === profileId) : null;
  if (!p) return [];
  const day = now.getDay() === 0 ? 7 : now.getDay();
  return p.schedules.filter((s) => s.days.includes(day)).map((s) => ({ from: s.from, to: s.to, block: s.block, categories: s.categories.slice() }));
}

async function status(gc, user) {
  const c = await load(gc, user);
  const target = await targetOf(gc, c, user, {});
  const d = c.own;
  const filtered = target.devices.filter((x) => x.state === 'filtered');
  let state;
  if (c.st.state === 'off' || c.st.state === 'starting') state = c.st.state;
  else if (c.st.state === 'fallback') state = 'fallback';
  else if (!filtered.length) state = 'unfiltered';
  else state = filtered.every((x) => x.suspended) ? 'paused' : 'active';
  const first = filtered.find((x) => x.suspended) || null;
  // counters: this device (query log on), all own devices (no asking device), else the whole server
  let counters;
  if (d && d.today) counters = { scope: 'device', queries: d.today.queries, blocked: d.today.blocked };
  else if (!d && c.st.log.enabled && c.mine.length) counters = { scope: 'person', queries: c.mine.reduce((n, x) => n + ((x.today && x.today.queries) || 0), 0), blocked: c.mine.reduce((n, x) => n + ((x.today && x.today.blocked) || 0), 0) };
  else counters = { scope: 'server', queries: c.st.today.queries, blocked: c.st.today.blocked };
  counters.percent = percent(counters.blocked, counters.queries);
  let settings = null;
  const profile = (d && d.profile) || (target.devices[0] && target.devices[0].profile) || null;
  if (profile) { try { settings = await gc.vpnDns.get(); } catch { settings = null; } }
  const prof = profile && settings ? settings.profiles.find((x) => x.id === profile.id) : null;
  return {
    state,
    enabled: !!c.st.enabled,
    device: d ? { peerId: d.peerId, name: d.name, platform: d.platform || null, state: d.state, ownDns: d.ownDns || null } : null,
    profile: profile ? { id: profile.id, name: profile.name, safeSearch: !!(prof && prof.safeSearch) } : null,
    pause: state === 'paused' ? pauseView(pauseOf(c, first), user) : null,
    outage: c.st.state === 'fallback' ? { since: c.st.since || null } : null,
    counters,
    top: await topOf(gc, c, user, d ? d.peerId : null),
    may: mayView(c, target),
    today: todayOf(settings, profile && profile.id),
    devices: c.mine.map((x) => deviceView(c, x, user)),
    manage: c.actor.role === 'admin' || rights.isParent(c.fam, user.id),
    log: { enabled: !!c.st.log.enabled, visible: !!c.st.log.enabled && (c.cfg.logView === 'own' || c.actor.role === 'admin') },
    serverTime: new Date().toISOString(),
  };
}

function gate(c) {
  if (c.st.state === 'off' || c.st.state === 'starting') throw fail('off');
  if (c.st.state !== 'filtering') throw fail('not_filtering');
}

async function pause(gc, user, body) {
  const c = await load(gc, user);
  gate(c);
  const target = await targetOf(gc, c, user, body);
  if (target.scope !== 'all' && !target.devices.length) throw fail('no_device');
  const dec = rights.may(c.actor, target, c.cfg, c.fam);
  if (!dec.ok) throw fail('not_allowed', { reason: dec.reason });
  if (target.scope !== 'all' && !target.devices.some((d) => d.state === 'filtered')) throw fail('not_allowed', { reason: 'not_filtered' });
  const running = c.pauses.find((p) => p.scope === target.scope && (target.scope === 'all' || p.id === target.id)) || null;
  const end = rights.endOf(body, dec.limits, running, fail);
  const r = await host(() => gc.vpnDns.pause({ scope: target.scope, ...(target.scope === 'all' ? {} : { id: target.id }), ...end }, { actor: user.id }));
  return { pause: pauseView(r, user), status: await status(gc, user) };
}

async function resume(gc, user, body) {
  const c = await load(gc, user);
  gate(c);
  const target = await targetOf(gc, c, user, body);
  const own = !!target.owner && target.owner.id === user.id;
  if (target.scope === 'all' || !own) {
    const dec = rights.may(c.actor, target, c.cfg, c.fam);
    if (!dec.ok) throw fail('not_allowed', { reason: dec.reason });
  }
  let resumed = false;
  const end = async (t) => { if (await host(() => gc.vpnDns.resume(t, { actor: user.id }))) resumed = true; };
  if (target.scope === 'all') await end({ scope: 'all' });
  else {
    const byAll = target.devices.some((d) => d.suspendedBy === 'all');
    if (byAll && c.actor.role !== 'admin') throw fail('not_allowed', { reason: 'paused_for_all' });
    if (target.scope === 'peer') {
      await end({ scope: 'peer', id: target.id });
      // the device is (also) suspended through its person: that suspension ends too
      const d = target.devices[0];
      if (d.user && c.pauses.some((p) => p.scope === 'user' && p.id === d.user.id)) await end({ scope: 'user', id: d.user.id });
    } else {
      await end({ scope: 'user', id: target.id });
      for (const d of target.devices) if (c.pauses.some((p) => p.scope === 'peer' && p.id === d.peerId)) await end({ scope: 'peer', id: d.peerId });
    }
    if (byAll) await end({ scope: 'all' });
  }
  return { resumed, status: await status(gc, user) };
}

/** The people the viewer may suspend for — an administrator: everybody with a VPN device; a parent: the family. */
async function people(gc, user) {
  const c = await load(gc, user);
  const admin = c.actor.role === 'admin';
  const fam = rights.familyOf(c.fam, user.id);
  if (!admin && !fam.length) throw fail('forbidden');
  const by = new Map();
  for (const d of c.devices) {
    if (!isPeer(d) || !d.user || d.state === 'disabled') continue;   // switched-off devices have nothing to suspend
    if (!admin && d.user.id !== user.id && (!fam.includes(d.user.id) || d.user.role === 'admin')) continue;
    if (!by.has(d.user.id)) by.set(d.user.id, { userId: d.user.id, name: d.user.name, role: d.user.role === 'admin' ? 'admin' : 'user', self: d.user.id === user.id, devices: [] });
    by.get(d.user.id).devices.push(d);
  }
  const list = [...by.values()].sort((a, b) => (b.self - a.self) || a.name.localeCompare(b.name));
  return {
    all: admin ? { may: mayView(c, { scope: 'all', id: null, owner: null, profileIds: [], devices: c.devices.filter((d) => d.state === 'filtered') }), pause: pauseView(c.st.pause, user) } : null,
    people: list.map((p) => ({
      userId: p.userId, name: p.name, role: p.role, self: p.self,
      may: mayView(c, { scope: 'user', id: p.userId, owner: { id: p.userId, role: p.role }, profileIds: [...new Set(p.devices.map((d) => d.profileId).filter(Boolean))], devices: p.devices }),
      devices: p.devices.map((d) => ({
        ...deviceView(c, d, user),
        may: mayView(c, { scope: 'peer', id: d.peerId, owner: ownerOf(d), profileIds: d.profileId ? [d.profileId] : [], devices: [d] }),
      })),
    })),
  };
}

const RESULT = (e) => (e.reason === 'safe_search' ? 'safe_search' : (e.action === 'block' ? 'blocked' : (e.reason === 'suspended' ? 'allowed_paused' : 'allowed')));

/** A log entry for a view: the device's name, the domain, what happened. */
function logEntry(e, devices, names) {
  const d = devices.find((x) => x.peerId === e.peerId);
  return {
    id: e.id, at: e.at, peerId: e.peerId, device: d ? d.name : null, person: d && d.user ? d.user.name : null, domain: e.name, type: e.type || null,
    result: RESULT(e), action: e.action, reason: e.reason || null, list: e.list || null,
    profile: e.profileId ? { id: e.profileId, name: names.get(e.profileId) || e.profileId } : null,
  };
}

async function log(gc, user, query) {
  const c = await load(gc, user);
  if (!c.st.log.enabled) throw fail('log_off');
  if (c.cfg.logView !== 'own' && c.actor.role !== 'admin') throw fail('not_allowed', { reason: 'log_admins_only' });
  const q = query && typeof query === 'object' ? query : {};
  // never more than the viewer's own devices: GateControl narrows to the peers of this person
  const ask = { userId: user.id, limit: Math.min(100, posInt(q.limit) || 50) };
  if (posInt(q.before)) ask.before = posInt(q.before);
  if (q.peerId !== undefined && q.peerId !== '') {
    const id = posInt(q.peerId);
    if (!id || !c.mine.some((d) => d.peerId === id)) throw fail('forbidden');
    ask.peerId = id;
  }
  if (q.blockedOnly === true || q.blockedOnly === '1' || q.blockedOnly === 'true') ask.blockedOnly = true;
  const search = clip(q.search, 100);
  if (search) ask.search = search;
  const r = await host(() => gc.vpnDns.log(ask));
  let settings = null;
  try { settings = await gc.vpnDns.get(); } catch { settings = null; }
  const names = new Map(((settings && settings.profiles) || []).map((p) => [p.id, p.name]));
  return { entries: ((r && r.entries) || []).map((e) => logEntry(e, c.mine, names)), next: (r && r.next) || null };
}

/** The portal tab: signed-in people with a VPN device of their own, and those who decide for others — while the protection is on. */
async function visibleFor(gc, user) {
  if (!gc.vpnDns || !user || !Number.isSafeInteger(user.id) || user.loggedIn === false || user.kiosk === true) return false;
  try {
    const st = await gc.vpnDns.status();
    if (!st.enabled) return false;
    if (user.role === 'admin') return true;
    const devices = await gc.vpnDns.devices();
    if (devices.some((d) => isPeer(d) && d.user && d.user.id === user.id)) return true;
    return rights.isParent(await rights.families(gc), user.id);
  } catch { return false; }
}

async function route(req, gc, seg) {
  const m = String(req.method || 'GET').toUpperCase();
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const user = personOf(req);
  if (seg.length !== 1) throw fail('not_found');
  if (seg[0] === 'status' && m === 'GET') return status(gc, user);
  if (seg[0] === 'pause' && m === 'POST') return pause(gc, user, b);
  if (seg[0] === 'resume' && m === 'POST') return resume(gc, user, b);
  if (seg[0] === 'people' && m === 'GET') return people(gc, user);
  if (seg[0] === 'log' && m === 'GET') return log(gc, user, req.query || {});
  throw fail('not_found');
}

module.exports = { route, status, pause, resume, people, log, visibleFor, logEntry, pauseView };
