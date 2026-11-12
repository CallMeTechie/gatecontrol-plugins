'use strict';

// GateControl 1.264.0 for the mock host (tools/testing/mock-host.js): gc.vpnDns — the DNS protection of the VPN devices
// (src/services/vpnDns.js, hostApi.js vpnDnsCall / vpnDnsActor, the child bootstrap's makeVpnDns; docs/plugins.md "DNS
// protection"). Opt-in: opts.gatecontrol ≥ '1.264.0' or opts.vpnDns; only a plugin with permissions.vpnDns: true has
// gc.vpnDns (an older GateControl ignores the key — no gc.vpnDns; without the permission the host answers
// ERR_VPN_DNS_DENIED).
//
//   createHost(dir, { vpnDns: {
//     peers: [{ id, name, ip: '10.8.0.12', type: 'peer' | 'gateway', platform, userId, peerGroup: { id, name }, dns: '1.1.1.1',
//               enabled: true }],                       // the VPN peers (users are opts.users, person groups opts.groups)
//     settings: { … },                                  // what gc.vpnDns.get() answers at the start (normalised)
//     service: 'filtering' | 'starting' | 'fallback',   // what the filter service does once the protection is on
//     internalDns: true,                                // false: GC_DNS_ENABLED off → blockedBy 'internal_dns_off'
//     pihole: { configured: true, wantsChain: true },   // a Pi-hole that manages the DNS chain
//     today: { queries, blocked, cached, top: [{ domain, count }] }, days: [{ day, queries, blocked, cached }],
//     perPeer: { <peerId>: { queries, blocked } },      // counters per device (only answered with the query log on)
//     log: [{ at (ms | ISO), peerId, name, type, action, reason, profileId, list }],   // oldest first
//     lists: { <listId>: { entries, updatedAt, checkedAt, error } },                   // what the service has loaded
//     test: ({ domain, profile, device, suspended }) => ({ action, reason, list, category, safeSearch }) | null,
//   } })
//
// Like the host:
//   * reading works anywhere; a change needs an acting person — the one person with a changing host.request in flight,
//     or { actor: userId } (automated when that person has no changing request in flight); ERR_NOT_PERSON otherwise;
//   * set / refreshLists / restart / releasePihole / clearLog need an administrator as the actor (ERR_NOT_ADMIN);
//   * pause / resume: for all devices only an administrator, for an administrator's devices only an administrator or
//     that person (ERR_FORBIDDEN) — everything else is the plugin's decision;
//   * set(patch) validates like vpnDns.validate (ERR_INVALID, the message starts with the field), profiles are matched
//     by id, a new one gets 'p' + 8 hex; which profile holds: device → person → peer group → person group → default;
//   * enabled: false ends every suspension; log.enabled: false deletes the log and the counters per device;
//   * test(): the default answers from the profile's own entries and from the lists by a few fixed names
//     (doubleclick.net / app-measurement.com / ads.tiktok.com → 'ads', paket-zustellung-dhl.top → 'malware',
//     pornhub.com → 'adult', bet365.com → 'gambling'), opts.vpnDns.test overrides it.
// For tests: host.vpnDns = { settings, pauses: Map, log, activity: [{ type, actor, automated, … }], calls, state },
// host.vpnDnsSet({ service, pihole, today, perPeer, peers, lists, internalDns }) changes what GateControl knows,
// host.vpnDnsEvent({ type: 'fallback' | 'restored' }) delivers an event to gc.vpnDns.on handlers (it also sets the
// service state), host.vpnDnsExpire(now?) ends the suspensions that ran out (events `resumed` with reason 'expired'),
// host.vpnDnsLog(entry) appends a log entry.

const crypto = require('node:crypto');
const { domainToASCII } = require('node:url');

const MINUTE = 60000;
const DAY = 24 * 60 * MINUTE;
const DEFAULT_ID = 'default';
const ID_RE = /^[a-z0-9_-]{1,32}$/;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const LIMITS = Object.freeze({ profiles: 16, schedules: 12, patterns: 200, members: 256, excluded: 512, name: 40, top: 20, topKeep: 50, logPage: 500, pauseMinutes: 7 * 24 * 60, retentionDays: 90 });
const LISTS = Object.freeze([
  { id: 'ads', format: 'adblock', entries: 78000, source: "HaGeZi's Multi LIGHT", home: 'https://github.com/hagezi/dns-blocklists', license: 'GPL-3.0', defaultOn: true },
  { id: 'malware', format: 'adblock', entries: 195000, source: "HaGeZi's Threat Intelligence Feeds (mini)", home: 'https://github.com/hagezi/dns-blocklists', license: 'GPL-3.0', defaultOn: true },
  { id: 'adult', format: 'adblock', entries: 92000, source: "HaGeZi's NSFW", home: 'https://github.com/hagezi/dns-blocklists', license: 'GPL-3.0', defaultOn: false },
  { id: 'gambling', format: 'adblock', entries: 110000, source: "HaGeZi's Gambling (mini)", home: 'https://github.com/hagezi/dns-blocklists', license: 'GPL-3.0', defaultOn: false },
  { id: 'ads_stevenblack', format: 'hosts', entries: 80000, source: 'StevenBlack Unified hosts', home: 'https://github.com/StevenBlack/hosts', license: 'MIT', defaultOn: false },
]);
const LIST_IDS = LISTS.map((l) => l.id);
const CATEGORIES = Object.freeze({
  social: ['facebook.com', 'instagram.com', 'snapchat.com', 'tiktok.com', 'x.com'],
  games: ['epicgames.com', 'minecraft.net', 'roblox.com', 'steampowered.com'],
  video: ['netflix.com', 'twitch.tv', 'youtube.com'],
});
const CATEGORY_IDS = Object.keys(CATEGORIES);
const PROVIDERS = ['quad9', 'cloudflare', 'custom', 'system'];
const SAMPLE = { 'doubleclick.net': 'ads', 'app-measurement.com': 'ads', 'ads.tiktok.com': 'ads', 'googlesyndication.com': 'ads', 'paket-zustellung-dhl.top': 'malware', 'pornhub.com': 'adult', 'bet365.com': 'gambling' };

function normPattern(v) {
  if (typeof v !== 'string') return null;
  let s = v.trim().toLowerCase().replace(/\.$/, '');
  if (!s || s.length > 253) return null;
  let wild = false;
  if (s.startsWith('*.')) { wild = true; s = s.slice(2); }
  if (!/^[\p{L}\p{N}._-]+$/u.test(s)) return null;
  const ascii = domainToASCII(s);
  if (!ascii || ascii.length > 253) return null;
  const labels = ascii.split('.');
  if (labels.length < 2 && !wild) return null;
  if (!labels.every((l) => /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/.test(l))) return null;
  return (wild ? '*.' : '') + ascii;
}
function patternsSoft(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const x of v.slice(0, LIMITS.patterns)) { const p = normPattern(x); if (p && !out.includes(p)) out.push(p); }
  return out.sort();
}
function normSchedule(x) {
  if (!x || typeof x !== 'object') return null;
  const days = Array.isArray(x.days) ? [...new Set(x.days.filter((d) => Number.isInteger(d) && d >= 1 && d <= 7))].sort((a, b) => a - b) : [];
  if (!days.length || !HHMM_RE.test(x.from)) return null;
  if (x.to !== '24:00' && !HHMM_RE.test(x.to)) return null;
  let span;
  if (x.from === '00:00' && (x.to === '24:00' || x.to === '00:00')) span = { from: '00:00', to: '24:00' };
  else { const end = x.to === '24:00' ? '00:00' : x.to; if (x.from === end) return null; span = { from: x.from, to: end }; }
  const block = x.block === 'all' ? 'all' : 'categories';
  const categories = block === 'categories' && Array.isArray(x.categories) ? CATEGORY_IDS.filter((c) => x.categories.includes(c)) : [];
  if (block === 'categories' && !categories.length) return null;
  return { days, from: span.from, to: span.to, block, categories, allowAlways: patternsSoft(x.allowAlways) };
}
function validDohUrl(s) {
  if (typeof s !== 'string' || s.length > 300) return false;
  try { const u = new URL(s.trim()); return u.protocol === 'https:' && !!u.hostname && !u.username && !u.password && !/[\s"'<>\\]/.test(s); } catch { return false; }
}
const cleanText = (v, max) => (typeof v === 'string' ? (v.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, max) || null) : null); // eslint-disable-line no-control-regex
const ints = (v, max) => (Array.isArray(v) ? [...new Set(v.filter((x) => Number.isSafeInteger(x) && x > 0))].slice(0, max).sort((a, b) => a - b) : []);
const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);
const clone = (v) => JSON.parse(JSON.stringify(v));
const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const matches = (name, pattern) => { const p = pattern.replace(/^\*\./, ''); return name === p || name.endsWith('.' + p); };

function install({ opts, perms, atLeast, enabledUser, hostError, personCtx, groupUsers, groupExists, logs, wire }) {
  const o = opts.vpnDns && typeof opts.vpnDns === 'object' ? opts.vpnDns : null;
  const host = !!o || atLeast(264);
  if (host && perms.vpnDns != null && typeof perms.vpnDns !== 'boolean') throw hostError('ERR_INVALID', 'plugin.json: permissions.vpnDns: invalid');
  const on = host && perms.vpnDns === true;
  const cfg = o || {};
  const invalid = (message) => hostError('ERR_INVALID', message);

  const defaultProfile = () => ({ id: DEFAULT_ID, name: 'Standard', lists: LISTS.filter((l) => l.defaultOn).map((l) => l.id), safeSearch: false, allow: [], deny: [], schedules: [], groups: [], peerGroups: [], users: [], peers: [] });
  function normProfile(p, i) {
    const r = p && typeof p === 'object' ? p : {};
    const id = i === 0 ? DEFAULT_ID : (typeof r.id === 'string' && ID_RE.test(r.id) && r.id !== DEFAULT_ID ? r.id : null);
    if (!id) return null;
    const members = (v) => (i === 0 ? [] : ints(v, LIMITS.members));
    return {
      id, name: cleanText(r.name, LIMITS.name) || (i === 0 ? 'Standard' : id), lists: Array.isArray(r.lists) ? LIST_IDS.filter((l) => r.lists.includes(l)) : [],
      safeSearch: r.safeSearch === true, allow: patternsSoft(r.allow), deny: patternsSoft(r.deny),
      schedules: Array.isArray(r.schedules) ? r.schedules.slice(0, LIMITS.schedules).map(normSchedule).filter(Boolean) : [],
      groups: members(r.groups), peerGroups: members(r.peerGroups), users: members(r.users), peers: members(r.peers),
    };
  }
  function normalize(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const up = r.upstream && typeof r.upstream === 'object' ? r.upstream : {};
    let provider = PROVIDERS.includes(up.provider) ? up.provider : 'quad9';
    const url = typeof up.url === 'string' && validDohUrl(up.url) ? up.url.trim() : null;
    if (provider === 'custom' && !url) provider = 'quad9';
    const list = Array.isArray(r.profiles) && r.profiles.length ? r.profiles : [defaultProfile()];
    const profiles = [];
    for (let i = 0; i < list.length && profiles.length < LIMITS.profiles; i++) {
      const p = normProfile(list[i], profiles.length);
      if (p && !profiles.some((q) => q.id === p.id)) profiles.push(p);
    }
    if (!profiles.length) profiles.push(defaultProfile());
    const log = r.log && typeof r.log === 'object' ? r.log : {};
    const days = Number(log.retentionDays);
    return {
      enabled: r.enabled === true,
      upstream: { provider, url: provider === 'custom' ? url : null, fallbackRouter: up.fallbackRouter !== false },
      blockResponse: r.blockResponse === 'nxdomain' ? 'nxdomain' : 'zero',
      allow: patternsSoft(r.allow), deny: patternsSoft(r.deny),
      log: { enabled: log.enabled === true, retentionDays: Number.isInteger(days) && days >= 1 && days <= LIMITS.retentionDays ? days : 7 },
      excluded: ints(r.excluded, LIMITS.excluded), profiles,
    };
  }

  const state = {
    settings: normalize(cfg.settings),
    peers: (cfg.peers || []).map((p) => ({ ...p })),
    service: cfg.service || 'filtering',
    internalDns: cfg.internalDns !== false,
    pihole: { configured: !!(cfg.pihole && cfg.pihole.configured), wantsChain: !!(cfg.pihole && cfg.pihole.wantsChain) },
    today: cfg.today ? clone(cfg.today) : { queries: 0, blocked: 0, cached: 0, top: [] },
    days: cfg.days ? clone(cfg.days) : [],
    perPeer: new Map(Object.entries(cfg.perPeer || {}).map(([k, v]) => [Number(k), { ...v }])),
    lists: cfg.lists ? clone(cfg.lists) : {},
    log: [],
    pauses: new Map(),     // 'all:0' | 'peer:<id>' | 'user:<id>' → { scope, target, until (ms | null), by: { userId, name }, automated, at }
    activity: [],
    calls: [],
    since: Date.now(),
    restarts: 0,
    refreshes: 0,
  };
  let logSeq = 0;
  const addLog = (e) => { state.log.push({ id: ++logSeq, at: typeof e.at === 'string' ? Date.parse(e.at) : (e.at || Date.now()), peerId: e.peerId, name: String(e.name), type: e.type || 'A', action: e.action === 'block' ? 'block' : 'allow', reason: e.reason || null, profileId: e.profileId || null, list: e.list || null }); };
  for (const e of cfg.log || []) addLog(e);

  const handlers = [];
  async function deliver(ev) {
    const payload = { ...ev, at: new Date().toISOString() };
    for (const fn of handlers.slice()) {
      try { await fn(wire(payload)); } catch (err) { logs.push({ level: 'error', message: 'gc.vpnDns.on handler failed: ' + String((err && err.message) || err) }); }
    }
  }
  const audit = (type, details, ctx) => state.activity.push({ type, ...details, ...(ctx && ctx.actor ? { actor: ctx.actor.id } : {}), automated: !!(ctx && ctx.automated) });

  const need = () => { if (perms.vpnDns !== true) throw hostError('ERR_VPN_DNS_DENIED', 'this plugin has no vpnDns permission'); };
  /** hostApi.js vpnDnsActor */
  function actorOf(args) {
    let id = args && Number.isSafeInteger(args.actor) && args.actor > 0 ? args.actor : null;
    if (args && args.actor != null && !id) throw hostError('ERR_INVALID', 'actor: a user id');
    let automated = false;
    if (id) {
      const e = personCtx.get(id);
      automated = !(e && e.write > 0);
    } else {
      const writers = [...personCtx.entries()].filter(([, e]) => e.write > 0).map(([uid]) => uid);
      if (!writers.length) throw hostError('ERR_NOT_PERSON', 'only inside a changing request (POST/PUT/PATCH/DELETE) of a signed-in person, or with { actor }');
      if (writers.length !== 1) throw hostError('ERR_NOT_PERSON', 'several people are changing something right now — name the acting person with { actor }');
      id = writers[0];
    }
    const u = enabledUser(id);
    if (!u) throw hostError('ERR_NOT_PERSON', 'unknown or disabled person');
    return { actor: { id: u.id, name: u.name, role: u.role }, automated };
  }

  const wanted = () => state.internalDns && state.settings.enabled;
  const stateNow = () => (wanted() ? state.service : 'off');
  const peerOf = (id) => state.peers.find((p) => p.id === id) || null;

  function patterns(v, what) {
    if (!Array.isArray(v) || v.length > LIMITS.patterns) throw invalid(`${what}: up to ${LIMITS.patterns} domains`);
    const out = [];
    for (const x of v) {
      const p = normPattern(x);
      if (!p) throw invalid(`${what}: "${String(x).slice(0, 60)}" is no domain`);
      if (!out.includes(p)) out.push(p);
    }
    return out.sort();
  }
  function memberIds(v, what, ok, label) {
    if (!Array.isArray(v) || v.length > LIMITS.members || !v.every((x) => Number.isSafeInteger(x) && x > 0)) throw invalid(`${what}: up to ${LIMITS.members} ids`);
    const ids = [...new Set(v)].sort((a, b) => a - b);
    if (ids.some((x) => !ok(x))) throw invalid(`${what}: unknown ${label}`);
    return ids;
  }
  function validateProfile(b, i, cur, taken) {
    const what = `profiles[${i}]`;
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw invalid(`${what}: object`);
    const out = cur ? clone(cur) : { ...defaultProfile(), id: null, name: null, lists: [] };
    for (const [k, v] of Object.entries(b)) {
      const f = `${what}.${k}`;
      if (k === 'id') continue;
      if (k === 'name') {
        const n = cleanText(v, LIMITS.name);
        if (!n) throw invalid(`${f}: 1…${LIMITS.name} characters`);
        out.name = n;
      } else if (k === 'lists') {
        if (!Array.isArray(v) || !v.every((x) => LIST_IDS.includes(x))) throw invalid(`${f}: ids of the catalogue`);
        out.lists = LIST_IDS.filter((l) => v.includes(l));
      } else if (k === 'safeSearch') {
        if (typeof v !== 'boolean') throw invalid(`${f} must be true or false`);
        out.safeSearch = v;
      } else if (k === 'allow' || k === 'deny') out[k] = patterns(v, f);
      else if (k === 'schedules') {
        if (!Array.isArray(v) || v.length > LIMITS.schedules) throw invalid(`${f}: up to ${LIMITS.schedules}`);
        out.schedules = v.map((x, j) => {
          if (!x || typeof x !== 'object') throw invalid(`${f}[${j}]: object`);
          if (x.allowAlways !== undefined) patterns(x.allowAlways, `${f}[${j}].allowAlways`);
          const n = normSchedule(x);
          if (!n) throw invalid(`${f}[${j}]: days 1–7, from/to HH:MM (different, or 00:00–24:00 for the whole day), block all or categories with at least one category`);
          return n;
        });
      } else if (['groups', 'peerGroups', 'users', 'peers'].includes(k)) {
        if (i === 0) { if (Array.isArray(v) && !v.length) continue; throw invalid('the default profile has no members'); }
        if (k === 'groups') out.groups = memberIds(v, f, (x) => groupExists(x), 'group');
        else if (k === 'peerGroups') out.peerGroups = memberIds(v, f, (x) => state.peers.some((p) => p.peerGroup && p.peerGroup.id === x), 'peer group');
        else if (k === 'users') out.users = memberIds(v, f, (x) => !!enabledUser(x), 'or disabled person');
        else out.peers = memberIds(v, f, (x) => { const p = peerOf(x); return !!p && p.type !== 'gateway'; }, 'device (gateways are never filtered)');
      } else throw invalid(`${f}: unknown`);
    }
    if (!out.name) throw invalid(`${what}.name: 1…${LIMITS.name} characters`);
    if (taken.has(out.name.toLowerCase())) throw invalid(`${what}.name: a profile with this name exists`);
    taken.add(out.name.toLowerCase());
    return out;
  }
  /** vpnDns.validate */
  function validate(patch, before) {
    const b = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : null;
    if (!b) throw invalid('invalid settings');
    const out = clone(before);
    let any = false;
    for (const [k, v] of Object.entries(b)) {
      any = true;
      if (k === 'enabled') {
        if (typeof v !== 'boolean') throw invalid('enabled must be true or false');
        out.enabled = v;
      } else if (k === 'blockResponse') {
        if (v !== 'zero' && v !== 'nxdomain') throw invalid('blockResponse: zero or nxdomain');
        out.blockResponse = v;
      } else if (k === 'allow' || k === 'deny') out[k] = patterns(v, k);
      else if (k === 'upstream') {
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalid('upstream: object');
        for (const [f, val] of Object.entries(v)) {
          if (f === 'provider') { if (!PROVIDERS.includes(val)) throw invalid(`upstream.provider: ${PROVIDERS.join(', ')}`); out.upstream.provider = val; } else if (f === 'url') {
            if (val !== null && !validDohUrl(val)) throw invalid('upstream.url: an https address');
            out.upstream.url = val === null ? null : val.trim();
          } else if (f === 'fallbackRouter') { if (typeof val !== 'boolean') throw invalid('upstream.fallbackRouter must be true or false'); out.upstream.fallbackRouter = val; } else throw invalid(`upstream.${f}: unknown`);
        }
        if (out.upstream.provider === 'custom' && !out.upstream.url) throw invalid('upstream.url is needed for an own server');
        if (out.upstream.provider !== 'custom') out.upstream.url = null;
      } else if (k === 'log') {
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalid('log: object');
        for (const [f, val] of Object.entries(v)) {
          if (f === 'enabled') { if (typeof val !== 'boolean') throw invalid('log.enabled must be true or false'); out.log.enabled = val; } else if (f === 'retentionDays') {
            if (!Number.isInteger(val) || val < 1 || val > LIMITS.retentionDays) throw invalid(`log.retentionDays: 1…${LIMITS.retentionDays}`);
            out.log.retentionDays = val;
          } else throw invalid(`log.${f}: unknown`);
        }
      } else if (k === 'excluded') {
        if (!Array.isArray(v) || v.length > LIMITS.excluded || !v.every((x) => Number.isSafeInteger(x) && x > 0)) throw invalid(`excluded: up to ${LIMITS.excluded} device ids`);
        const ids = [...new Set(v)].sort((a, c) => a - c);
        if (ids.some((x) => !peerOf(x))) throw invalid('excluded: unknown device');
        out.excluded = ids;
      } else if (k === 'profiles') {
        if (!Array.isArray(v) || !v.length || v.length > LIMITS.profiles) throw invalid(`profiles: 1…${LIMITS.profiles}`);
        if (v[0] && v[0].id !== undefined && v[0].id !== DEFAULT_ID) throw invalid('profiles[0] is the default profile (id "default")');
        const taken = new Set();
        const seen = new Set();
        out.profiles = v.map((p, i) => {
          const id = i === 0 ? DEFAULT_ID : (p && typeof p.id === 'string' ? p.id : null);
          if (id !== null && i > 0 && (!ID_RE.test(id) || id === DEFAULT_ID)) throw invalid(`profiles[${i}].id: invalid`);
          if (id !== null && seen.has(id)) throw invalid(`profiles[${i}].id: twice`);
          const cur = id ? before.profiles.find((q) => q.id === id) || null : null;
          const n = validateProfile(p, i, cur, taken);
          n.id = id || ('p' + crypto.randomBytes(4).toString('hex'));
          seen.add(n.id);
          return n;
        });
      } else throw invalid(`${k}: unknown`);
    }
    if (!any) throw invalid('nothing to change');
    return normalize(out);
  }

  /** vpnDns.resolve */
  function resolve(s = state.settings) {
    const byPeer = new Map();
    const byUser = new Map();
    const byPeerGroup = new Map();
    const byGroupUser = new Map();
    for (const p of s.profiles.slice(1)) {
      for (const id of p.peers) if (!byPeer.has(id)) byPeer.set(id, p.id);
      for (const id of p.users) if (!byUser.has(id)) byUser.set(id, p.id);
      for (const id of p.peerGroups) if (!byPeerGroup.has(id)) byPeerGroup.set(id, p.id);
      if (p.groups.length) for (const uid of groupUsers(p.groups)) if (!byGroupUser.has(uid)) byGroupUser.set(uid, { profileId: p.id, groups: p.groups });
    }
    const excluded = new Set(s.excluded);
    return state.peers.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)) || a.id - b.id).map((p) => {
      const owner = p.userId ? enabledUser(p.userId) : null;
      const dev = {
        peerId: p.id, name: p.name, ip: p.ip || null, type: p.type === 'gateway' ? 'gateway' : 'peer', platform: p.platform || null,
        user: owner ? { id: owner.id, name: owner.name, role: owner.role } : null,
        peerGroup: p.peerGroup ? { id: p.peerGroup.id, name: p.peerGroup.name } : null,
        state: 'filtered', ownDns: null, profileId: null, via: null, viaId: null,
      };
      if (dev.type === 'gateway') { dev.state = 'gateway'; return dev; }
      if (p.enabled === false || !dev.ip) { dev.state = 'disabled'; return dev; }
      if (excluded.has(p.id)) { dev.state = 'excluded'; return dev; }
      dev.ownDns = p.dns || null;
      if (dev.ownDns) dev.state = 'ownDns';
      const uid = owner ? owner.id : null;
      if (byPeer.has(p.id)) Object.assign(dev, { profileId: byPeer.get(p.id), via: 'peer', viaId: p.id });
      else if (uid && byUser.has(uid)) Object.assign(dev, { profileId: byUser.get(uid), via: 'user', viaId: uid });
      else if (p.peerGroup && byPeerGroup.has(p.peerGroup.id)) Object.assign(dev, { profileId: byPeerGroup.get(p.peerGroup.id), via: 'peerGroup', viaId: p.peerGroup.id });
      else if (uid && byGroupUser.has(uid)) Object.assign(dev, { profileId: byGroupUser.get(uid).profileId, via: 'group', viaId: byGroupUser.get(uid).groups[0] });
      else Object.assign(dev, { profileId: DEFAULT_ID, via: 'default', viaId: null });
      return dev;
    });
  }

  const running = (now) => [...state.pauses.values()].filter((r) => r.until == null || r.until > now).sort((a, b) => (a.scope < b.scope ? -1 : (a.scope > b.scope ? 1 : a.target - b.target)));
  const pauseView = (r) => ({ scope: r.scope, id: r.scope === 'all' ? null : r.target, until: iso(r.until), openEnd: r.until == null, since: iso(r.at), by: r.by ? { ...r.by } : null, automated: !!r.automated });
  function suspended(devices, now) {
    const out = { all: null, keys: new Map() };
    const put = (id, until) => {
      const v = until == null ? 0 : until;
      const cur = out.keys.get(id);
      out.keys.set(id, cur === undefined ? v : (cur === 0 || v === 0 ? 0 : Math.max(cur, v)));
    };
    for (const r of running(now)) {
      if (r.scope === 'all') out.all = r.until == null ? 0 : r.until;
      else if (r.scope === 'peer') put(r.target, r.until);
      else for (const d of devices) if (d.user && d.user.id === r.target) put(d.peerId, r.until);
    }
    return out;
  }
  function targetOf(t) {
    const scope = t && t.scope;
    if (scope === 'all') return { scope, id: 0, owner: null };
    const id = t && t.id;
    if (!Number.isSafeInteger(id) || id <= 0) throw invalid('id: the id of the device or person');
    if (scope === 'peer') {
      const p = peerOf(id);
      if (!p || p.type === 'gateway') throw hostError('ERR_NOT_FOUND', 'unknown device');
      const u = p.userId ? enabledUser(p.userId) : null;
      return { scope, id, owner: u ? { id: u.id, role: u.role } : null };
    }
    if (scope === 'user') {
      const u = enabledUser(id);
      if (!u) throw hostError('ERR_NOT_FOUND', 'unknown or disabled person');
      return { scope, id, owner: { id: u.id, role: u.role } };
    }
    throw invalid('scope: all, peer or user');
  }
  function needMay(target, ctx) {
    const a = ctx.actor;
    if (a.role === 'admin') return;
    if (target.scope === 'all') throw hostError('ERR_FORBIDDEN', 'only an administrator suspends the protection for all devices');
    if (target.owner && target.owner.role === 'admin' && target.owner.id !== a.id) throw hostError('ERR_FORBIDDEN', 'not for the devices of an administrator');
  }
  function untilOf(t, now) {
    if (t.forever === true) return null;
    if (t.minutes !== undefined) {
      if (!Number.isInteger(t.minutes) || t.minutes < 1 || t.minutes > LIMITS.pauseMinutes) throw invalid(`minutes: 1…${LIMITS.pauseMinutes}`);
      return now + t.minutes * MINUTE;
    }
    if (typeof t.until === 'string' && t.until.length <= 64) {
      const ms = Date.parse(t.until);
      if (Number.isFinite(ms) && ms > now && ms <= now + LIMITS.pauseMinutes * MINUTE) return ms;
    }
    throw invalid('minutes, until (ISO, at most 7 days ahead) or forever: true');
  }

  function listsView() {
    const s = state.settings;
    const used = new Set(s.profiles.flatMap((p) => p.lists));
    const up = wanted() && state.service !== 'starting';
    return LISTS.map((l) => {
      const given = state.lists[l.id];
      const t = given !== undefined ? given : (up && used.has(l.id) ? { entries: l.entries + 214, updatedAt: Date.now() - 3 * 3600000, checkedAt: Date.now() - 3 * 3600000 } : null);
      const loaded = up && !!t && t.loaded !== false && t.entries != null;
      return {
        id: l.id, source: l.source, home: l.home, license: l.license, defaultOn: l.defaultOn, used: used.has(l.id),
        loaded, entries: loaded ? t.entries : l.entries, estimated: !loaded,
        updatedAt: t ? iso(typeof t.updatedAt === 'string' ? Date.parse(t.updatedAt) : t.updatedAt) : null,
        checkedAt: t ? iso(typeof t.checkedAt === 'string' ? Date.parse(t.checkedAt) : t.checkedAt) : null,
        error: t && t.error ? t.error : null,
        profiles: s.profiles.filter((p) => p.lists.includes(l.id)).map((p) => p.id),
      };
    });
  }
  function devicesView(now = Date.now()) {
    const s = state.settings;
    const list = resolve(s);
    const sus = suspended(list, now);
    const names = new Map(s.profiles.map((p) => [p.id, p.name]));
    const direct = new Set(running(now).filter((r) => r.scope === 'peer').map((r) => r.target));
    return list.map((d) => {
      const own = sus.keys.get(d.peerId);
      const until = d.profileId ? (sus.all !== null ? sus.all : (own === undefined ? null : own)) : null;
      return {
        ...d,
        profile: d.profileId ? { id: d.profileId, name: names.get(d.profileId) || d.profileId } : null,
        suspended: until !== null, suspendedUntil: until ? iso(until) : null,
        suspendedBy: until === null ? null : (sus.all !== null ? 'all' : (direct.has(d.peerId) ? 'peer' : 'user')),
        today: s.log.enabled ? (state.perPeer.get(d.peerId) ? { ...state.perPeer.get(d.peerId) } : { queries: 0, blocked: 0 }) : null,
      };
    });
  }
  function profileOfUser(uid, s) {
    for (const p of s.profiles.slice(1)) if (p.users.includes(uid)) return p.id;
    for (const p of s.profiles.slice(1)) if (p.groups.length && groupUsers(p.groups).has(uid)) return p.id;
    return DEFAULT_ID;
  }
  /** what the filter service answers for a name in a profile */
  function decide(domain, profile, s) {
    const allow = [...profile.allow, ...s.allow];
    const deny = [...profile.deny, ...s.deny];
    if (allow.some((p) => matches(domain, p))) return { action: 'allow', reason: 'profile_allow' };
    if (deny.some((p) => matches(domain, p))) return { action: 'block', reason: 'profile_deny' };
    for (const [name, list] of Object.entries(SAMPLE)) if (matches(domain, name) && profile.lists.includes(list)) return { action: 'block', reason: 'list', list };
    if (profile.safeSearch && /^(www\.)?google\.[a-z.]+$/.test(domain)) return { action: 'allow', reason: 'default', safeSearch: 'forcesafesearch.google.com' };
    return { action: 'allow', reason: 'default' };
  }

  const read = (name, fn) => async (args) => { need(); state.calls.push(name); return fn(args || {}); };
  const change = (name, admin, fn) => async (args) => {
    need();
    state.calls.push(name);
    const ctx = actorOf(args || {});
    if (admin && ctx.actor.role !== 'admin') throw hostError('ERR_NOT_ADMIN', 'only an administrator');
    return fn(args || {}, ctx);
  };

  const api = {
    'vpnDns.status': read('status', () => {
      const now = Date.now();
      const s = state.settings;
      const st = stateNow();
      const devices = resolve(s);
      const sus = suspended(devices, now);
      const count = (x) => devices.filter((d) => d.state === x).length;
      const all = running(now).find((r) => r.scope === 'all');
      const wantsChain = state.pihole.configured && state.pihole.wantsChain;
      const up = st === 'filtering' || st === 'fallback';
      const lv = listsView();
      const loaded = lv.filter((l) => l.loaded);
      return {
        available: true, enabled: s.enabled, blockedBy: s.enabled && !state.internalDns ? 'internal_dns_off' : null,
        state: st, since: st === 'off' ? null : iso(state.since),
        chain: st === 'filtering' ? 'filter' : (wantsChain && st !== 'fallback' ? 'pihole' : 'default'),
        pihole: { configured: state.pihole.configured, wantsChain, chain: !wantsChain ? 'off' : (st === 'filtering' ? 'displaced' : (st === 'fallback' ? 'fallback' : 'active')) },
        pause: all ? pauseView(all) : null,
        pauses: running(now).filter((r) => r.scope !== 'all').length,
        service: st === 'off' || st === 'fallback' ? { running: false } : {
          running: true, ready: up, pid: 4711, startedAt: iso(state.since), port: 5354, listen: 'running',
          upstream: { provider: s.upstream.provider, lastOkAt: iso(now - 2000), lastError: null, fallbacks: 0, encryptedDown: false },
          memory: { rss: 48 * 1024 * 1024, lists: loaded.reduce((n, l) => n + l.entries * 8, 0) }, cacheEntries: 120, truncated: 0, failOpen: 0, asOf: iso(now),
        },
        peers: {
          filtered: count('filtered'), ownDns: count('ownDns'), excluded: count('excluded'), gateways: count('gateway'),
          suspended: sus.all !== null ? count('filtered') : devices.filter((d) => d.state === 'filtered' && sus.keys.has(d.peerId)).length,
        },
        lists: lv.filter((l) => l.used),
        today: { queries: state.today.queries || 0, blocked: state.today.blocked || 0, cached: state.today.cached || 0 },
        log: { ...s.log },
      };
    }),
    'vpnDns.catalog': read('catalog', () => ({
      lists: LISTS.map((l) => ({ id: l.id, source: l.source, home: l.home, license: l.license, format: l.format, entries: l.entries, defaultOn: l.defaultOn })),
      categories: CATEGORY_IDS.map((id) => ({ id, domains: CATEGORIES[id].slice() })),
      providers: [{ id: 'quad9', label: 'Quad9', home: 'https://quad9.net' }, { id: 'cloudflare', label: 'Cloudflare', home: 'https://1.1.1.1' }, { id: 'custom', label: null, home: null }, { id: 'system', label: null, home: null }],
      limits: { ...LIMITS },
    })),
    'vpnDns.get': read('get', () => clone(state.settings)),
    'vpnDns.set': change('set', true, ({ patch }, ctx) => {
      const before = state.settings;
      const after = validate(patch, before);
      const keys = Object.keys(after).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
      if (!keys.length) return clone(after);
      state.settings = after;
      if (before.log.enabled && !after.log.enabled) { state.log.length = 0; state.perPeer.clear(); }
      if (before.enabled && !after.enabled) state.pauses.clear();
      if (!before.enabled && after.enabled) state.since = Date.now();
      audit('vpn_dns_changed', { changed: keys, enabled: after.enabled }, ctx);
      return clone(after);
    }),
    'vpnDns.devices': read('devices', () => devicesView()),
    'vpnDns.lists': read('lists', () => {
      const lv = listsView();
      const loaded = lv.filter((l) => l.loaded);
      const up = wanted() && state.service !== 'starting';
      return { lists: lv, memoryBytes: up ? loaded.reduce((n, l) => n + l.entries * 8, 0) : null, entries: up ? loaded.reduce((n, l) => n + l.entries, 0) : null, asOf: iso(Date.now()) };
    }),
    'vpnDns.refreshLists': change('refreshLists', true, () => {
      if (!wanted() || state.service === 'fallback') throw hostError('ERR_UNAVAILABLE', 'the filter service does not answer (ENOENT)');
      state.refreshes++;
      return { started: true };
    }),
    'vpnDns.stats': read('stats', ({ opts: so }) => {
      const now = Date.now();
      const days = Number.isInteger(so && so.days) ? Math.max(1, Math.min(90, so.days)) : 7;
      const from = dayKey(now - (days - 1) * DAY);
      const today = dayKey(now);
      const rows = [...state.days.filter((d) => d.day >= from && d.day < today), ...(state.today.queries ? [{ day: today, queries: state.today.queries, blocked: state.today.blocked, cached: state.today.cached || 0, top: state.today.top }] : [])];
      const all = new Map();
      for (const r of rows) for (const e of r.top || []) all.set(e.domain, (all.get(e.domain) || 0) + e.count);
      const sorted = (list) => list.slice().sort((a, b) => b.count - a.count || (a.domain < b.domain ? -1 : 1)).slice(0, LIMITS.top);
      const per = () => [...state.perPeer.entries()].map(([peerId, v]) => ({ peerId, queries: v.queries, blocked: v.blocked })).sort((a, b) => a.peerId - b.peerId);
      return {
        today: { day: today, queries: state.today.queries || 0, blocked: state.today.blocked || 0, cached: state.today.cached || 0, top: sorted(state.today.top || []) },
        days: rows.map((r) => ({ day: r.day, queries: r.queries, blocked: r.blocked, cached: r.cached || 0 })),
        top: sorted([...all.entries()].map(([domain, count]) => ({ domain, count }))),
        perPeer: state.settings.log.enabled ? per() : null,
        perPeerToday: state.settings.log.enabled ? per() : null,
      };
    }),
    'vpnDns.test': read('test', ({ domain, who }) => {
      const d = normPattern(String(domain || '').trim().replace(/^\*\./, ''));
      if (!d) throw invalid('no domain');
      const s = state.settings;
      const w = who && typeof who === 'object' ? who : {};
      let dev = null;
      let profileId = DEFAULT_ID;
      if (w.peerId !== undefined && w.peerId !== null) {
        dev = devicesView().find((x) => x.peerId === w.peerId);
        if (!dev) throw hostError('ERR_NOT_FOUND', 'unknown device');
        profileId = dev.profileId;
      } else if (w.userId !== undefined && w.userId !== null) {
        if (!enabledUser(w.userId)) throw hostError('ERR_NOT_FOUND', 'unknown or disabled person');
        profileId = profileOfUser(w.userId, s);
      } else if (w.profileId !== undefined && w.profileId !== null) {
        if (!s.profiles.some((p) => p.id === w.profileId)) throw hostError('ERR_NOT_FOUND', 'unknown profile');
        profileId = w.profileId;
      }
      if (stateNow() !== 'filtering') throw hostError('ERR_UNAVAILABLE', 'the filter service does not answer (ENOENT)');
      const profile = profileId ? s.profiles.find((p) => p.id === profileId) : null;
      let r;
      if (!profile) r = { action: 'allow', reason: 'no_profile' };
      else if (dev && dev.suspended) r = { action: 'allow', reason: 'suspended' };
      else r = (typeof cfg.test === 'function' && cfg.test({ domain: d, profile: clone(profile), device: dev })) || decide(d, profile, s);
      return {
        domain: d, action: r.action, reason: r.reason, list: r.list || null, category: r.category || null, safeSearch: r.safeSearch || null,
        profile: profile ? { id: profile.id, name: profile.name } : null,
        device: dev ? { peerId: dev.peerId, name: dev.name, state: dev.state } : null,
        filtered: !dev || dev.state === 'filtered',
      };
    }),
    'vpnDns.pauses': read('pauses', () => running(Date.now()).map(pauseView)),
    'vpnDns.pause': change('pause', false, async ({ target }, ctx) => {
      const t = targetOf(target);
      needMay(t, ctx);
      const now = Date.now();
      const until = untilOf(target || {}, now);
      const r = { scope: t.scope, target: t.id, until, by: { userId: ctx.actor.id, name: ctx.actor.name }, automated: ctx.automated, at: now };
      state.pauses.set(`${t.scope}:${t.id}`, r);
      audit('vpn_dns_paused', { scope: t.scope, target_id: t.id || null, until: iso(until) }, ctx);
      const view = pauseView(r);
      await deliver({ type: 'paused', ...view });
      return view;
    }),
    'vpnDns.resume': change('resume', false, async ({ target }, ctx) => {
      const t = targetOf(target);
      needMay(t, ctx);
      const key = `${t.scope}:${t.id}`;
      const cur = state.pauses.get(key);
      state.pauses.delete(key);
      if (!cur || (cur.until != null && cur.until <= Date.now())) return false;
      audit('vpn_dns_resumed', { scope: t.scope, target_id: t.id || null }, ctx);
      await deliver({ type: 'resumed', scope: t.scope, id: t.scope === 'all' ? null : t.id, reason: 'manual', by: { userId: ctx.actor.id, name: ctx.actor.name } });
      return true;
    }),
    'vpnDns.restart': change('restart', true, (a, ctx) => {
      if (!wanted()) throw hostError('ERR_UNAVAILABLE', 'the DNS protection is switched off');
      state.restarts++;
      const how = state.service === 'fallback' ? 'not_running' : 'asked';
      audit('vpn_dns_service_restart', { how }, ctx);
      return { restarting: true, how };
    }),
    'vpnDns.releasePihole': change('releasePihole', true, (a, ctx) => {
      if (stateNow() !== 'filtering') throw hostError('ERR_NOT_FILTERING', 'the DNS protection does not filter yet — Pi-hole keeps the chain');
      if (state.pihole.wantsChain) { state.pihole.wantsChain = false; audit('vpn_dns_pihole_released', {}, ctx); }
      return { configured: state.pihole.configured, wantsChain: false, chain: 'off' };
    }),
    'vpnDns.log': read('log', ({ query }) => {
      if (!state.settings.log.enabled) throw hostError('ERR_LOG_OFF', 'the query log is switched off');
      const q = query && typeof query === 'object' ? query : {};
      const limit = Number.isInteger(q.limit) ? Math.max(1, Math.min(LIMITS.logPage, q.limit)) : 100;
      let rows = state.log.slice().sort((a, b) => b.id - a.id);
      if (Number.isSafeInteger(q.before) && q.before > 0) rows = rows.filter((r) => r.id < q.before);
      if (Number.isSafeInteger(q.peerId) && q.peerId > 0) rows = rows.filter((r) => r.peerId === q.peerId);
      if (Number.isSafeInteger(q.userId) && q.userId > 0) rows = rows.filter((r) => { const p = peerOf(r.peerId); return !!p && p.userId === q.userId; });
      if (q.blockedOnly === true) rows = rows.filter((r) => r.action === 'block');
      if (typeof q.search === 'string' && q.search.trim()) { const needle = q.search.trim().toLowerCase().slice(0, 100); rows = rows.filter((r) => r.name.includes(needle)); }
      if (typeof q.since === 'string' && Number.isFinite(Date.parse(q.since))) rows = rows.filter((r) => r.at >= Date.parse(q.since));
      const page = rows.slice(0, limit);
      return { entries: page.map((r) => ({ ...r, at: iso(r.at) })), next: rows.length > limit ? page[page.length - 1].id : null };
    }),
    'vpnDns.clearLog': change('clearLog', true, (a, ctx) => {
      const n = state.log.length;
      state.log.length = 0;
      state.perPeer.clear();
      audit('vpn_dns_log_cleared', { entries: n }, ctx);
      return { removed: n };
    }),
  };

  /** gc.vpnDns (the child bootstrap's makeVpnDns) */
  const gcPart = (call) => {
    const obj = (x) => (x && typeof x === 'object' ? x : {});
    const actor = (x) => (obj(x).actor != null ? { actor: obj(x).actor } : {});
    return Object.freeze({
      version: 1,
      status: () => call('vpnDns.status', {}),
      catalog: () => call('vpnDns.catalog', {}),
      get: () => call('vpnDns.get', {}),
      set: (patch, x) => call('vpnDns.set', { patch: obj(patch), ...actor(x) }),
      devices: () => call('vpnDns.devices', {}),
      lists: () => call('vpnDns.lists', {}),
      refreshLists: (x) => call('vpnDns.refreshLists', { ...actor(x) }),
      stats: (x) => call('vpnDns.stats', { opts: obj(x) }),
      test: (domain, who) => call('vpnDns.test', { domain: String(domain), who: obj(who) }),
      pauses: () => call('vpnDns.pauses', {}),
      pause: (target, x) => call('vpnDns.pause', { target: obj(target), ...actor(x) }),
      resume: (target, x) => call('vpnDns.resume', { target: obj(target), ...actor(x) }),
      restart: (x) => call('vpnDns.restart', { ...actor(x) }),
      releasePihole: (x) => call('vpnDns.releasePihole', { ...actor(x) }),
      log: (query) => call('vpnDns.log', { query: obj(query) }),
      clearLog: (x) => call('vpnDns.clearLog', { ...actor(x) }),
      on: (handler) => {
        if (typeof handler !== 'function') throw new TypeError('gc.vpnDns.on(handler)');
        handlers.push(handler);
        return () => { const i = handlers.indexOf(handler); if (i >= 0) handlers.splice(i, 1); };
      },
    });
  };

  /** host.vpnDnsSet({ service, pihole, today, days, perPeer, peers, lists, internalDns, settings }) */
  function hostSet(x = {}) {
    if (x.service) { if (x.service !== state.service) state.since = Date.now(); state.service = x.service; }
    if (x.pihole) Object.assign(state.pihole, x.pihole);
    if (x.today) state.today = clone(x.today);
    if (x.days) state.days = clone(x.days);
    if (x.perPeer) { state.perPeer.clear(); for (const [k, v] of Object.entries(x.perPeer)) state.perPeer.set(Number(k), { ...v }); }
    if (x.peers) state.peers = x.peers.map((p) => ({ ...p }));
    if (x.lists) state.lists = clone(x.lists);
    if (typeof x.internalDns === 'boolean') state.internalDns = x.internalDns;
    if (x.settings) state.settings = normalize(x.settings);
  }
  /** host.vpnDnsEvent({ type: 'fallback' | 'restored' }) — the outage as the host reports it */
  async function hostEvent(ev) {
    if (ev.type === 'fallback') { state.service = 'fallback'; state.since = Date.now(); state.activity.push({ type: 'vpn_dns_fallback' }); }
    if (ev.type === 'restored') { state.service = 'filtering'; state.since = Date.now(); state.activity.push({ type: 'vpn_dns_restored' }); }
    await deliver(ev);
  }
  /** host.vpnDnsExpire(now) — vpnDns.sweepPauses: suspensions that ran out end with an event */
  async function hostExpire(now = Date.now()) {
    let n = 0;
    for (const [key, r] of [...state.pauses]) {
      if (r.until == null || r.until > now) continue;
      state.pauses.delete(key);
      n++;
      await deliver({ type: 'resumed', scope: r.scope, id: r.scope === 'all' ? null : r.target, reason: 'expired', by: null });
    }
    return n;
  }

  /** what GET /api/v1/client/permissions carries as `vpnDns` (vpnDns.clientInfo) */
  const clientInfo = (pluginId, usable) => (wanted() && usable ? { plugin: pluginId, state: stateNow() } : null);

  return { on, api, gcPart, state, hostSet, hostEvent, hostExpire, hostLog: addLog, clientInfo };
}

module.exports = { install, LIMITS, LISTS, CATEGORIES };
