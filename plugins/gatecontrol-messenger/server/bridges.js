'use strict';

// 1.12.0 — bridges to other messengers, first stage (WhatsApp; a preview of GateControl: gc.bridges exists only on a
// server that offers it, permissions.bridges — feature-detected, never assumed). The bridges run next to the server;
// GateControl talks to them, this plugin names a network and a person. Nothing here reads or writes a chat yet — a
// later version maps the outside chats. What this file does:
//
//   administrators (admin page „Übersicht“, card „Brücken“ — hidden while GateControl does not offer bridges)
//     GET admin/bridges   { bridges: { available, reason, enabled, location, locations, networks: [{ id, enabled, state,
//                         version, memMb, limitMb, linked }], host, history } } — states, versions, memory and how
//                         many people linked; never who, never a number, never a contact
//     PUT admin/bridges   { enabled?, networks?: { whatsapp?: boolean } } → the same
//   every person, for their OWN account only (GateControl refuses anything else as well)
//     GET    bridges                              { bridges: { available, networks: [{ id, state, allowed, lock, consent,
//                                                 logins: [{ id, name, state, since }] }] } }
//     POST   bridges/:network/consent             { accept: true } — the notes before the first link were read
//     POST   bridges/:network/login               { flow: 'phone' | 'qr' } → { login: { processId, step } }
//     POST   bridges/:network/login/:process/:step  { input? } → { login: { processId, step } | { processId, waiting: true } }
//     DELETE bridges/:network/login/:process      cancel
//     DELETE bridges/:network/logins/:id          unlink
//   parents (Familie's family_roles) for their children — off until a parent allows it, per child and network
//     GET bridges/children                        { children: [{ userId, networks: { whatsapp: boolean }, linked: { whatsapp: boolean } }] }
//     PUT bridges/children/:userId                { networks: { whatsapp: boolean } } → { child, unlinked: { whatsapp?: boolean } }
//   1.13.0 — the same two for the Familie plugin, whose page carries the switches (services bridge_children /
//   bridge_child_set, from gatecontrol-familie only, `user` = the parent). Taking a permission back also UNLINKS
//   the child's account on that network (gc.bridges.unlinkFor, GateControl with gc.bridges.version ≥ 2 — it checks
//   that the parent is acting right now and writes it to its activity log); on an older GateControl the link stays
//   until the child or the service ends it, and the answer says so (unlinked false).
//   1.16.0 — a second switch per child and network: newChat { whatsapp: boolean } — may the child start NEW chats by
//   phone number (default off; only together with the permission itself). bridge_children answers `newChat: true`
//   (the server can look numbers up) and each child's newChat; bridge_child_set takes newChat next to / instead of
//   networks. An older Familie never sends it: children stay without new chats by number.
//   1.16.0 — GET bridges: each network carries newChat { available, reason, limit: { perHour, left, retryAfterS } }
//   (the line „WhatsApp-Chat mit Nummer“ in „Neuer Chat“); resolve answers existing / avatarUrl as well.
//   1.13.0 — the portal page „Verknüpfte Dienste“ (ui/bridges.js): a QR step also carries `display.matrix`
//   { size, rows } — the code's modules, drawn by the page (the apps draw from `display.data` themselves).
//
// Kept here (migration 006): the consent, the parents' grants and WHICH account is linked on which network (the
// bridge's login id and state — for the count on the admin card and the state without asking the bridge). Never the
// phone number, never a session key: those stay in the bridge.

const store = require('./store');
const log = require('./log');
const seal = require('./seal');
const config = require('./config');
const familie = require('./familie');
const { fail, posInt, iso } = require('./util');
const { encode } = require('./vendor/uqr');

const NETWORKS = ['whatsapp'];
const FLOWS = ['phone', 'qr'];
const ID_RE = /^[A-Za-z0-9._:=+-]{1,128}$/;
const STATES = ['connected', 'connecting', 'logged_out', 'error', 'unknown'];

/** gc.bridges when this GateControl has it (a newer server with the preview, the permission granted). */
function api(gc) {
  const b = gc && gc.bridges;
  return b && typeof b.status === 'function' && typeof b.configure === 'function' && b.login && typeof b.logins === 'function' ? b : null;
}

const NONE = Object.freeze({ available: false, reason: 'no_host', enabled: false, location: 'server', locations: [], networks: [], host: null, history: { enabled: false } });

async function hostStatus(gc) {
  const b = api(gc);
  if (!b) return NONE;
  try {
    const s = await b.status();
    return s && typeof s === 'object' ? s : NONE;
  } catch { return NONE; }
}

/** GateControl's refusals → this API's codes (the reason travels along as `reason`). */
function mapped(e) {
  const reason = e && typeof e.reason === 'string' ? e.reason : null;
  switch (e && e.code) {
    case 'ERR_BRIDGES_UNAVAILABLE': return fail('bridge_off', { reason });
    case 'ERR_BRIDGE_UNREACHABLE': return fail('bridge_unreachable', { reason });
    case 'ERR_BRIDGE':
      if (reason === 'not_found') return fail('not_found');
      if (reason === 'unsupported_step') return fail('bridge_unsupported', { reason });
      return fail('bridge_failed', { reason });
    case 'ERR_BUSY': return fail('rate_limited');
    case 'ERR_INVALID': return fail('invalid');
    case 'ERR_NOT_ADMIN': case 'ERR_NOT_PERSON': case 'ERR_BRIDGES_DENIED': return fail('forbidden');
    default: return e;
  }
}

function network(v) {
  if (!NETWORKS.includes(v)) throw fail('not_found');
  return v;
}
function ident(v) {
  if (typeof v !== 'string' || !ID_RE.test(v)) throw fail('invalid');
  return v;
}

/** The networks a person can link right now (the bridges are offered, switched on, the network too) — [] otherwise. */
async function offered(gc) {
  const s = await hostStatus(gc);
  if (!s.available || !s.enabled) return [];
  return (s.networks || []).filter((n) => NETWORKS.includes(n.id) && n.enabled).map((n) => n.id);
}

// ─── Administrators ────────────────────────────────────

async function adminView(gc, now) {
  const s = await hostStatus(gc);
  // only accounts that still exist count
  const users = await require('./people').users(gc, now);
  const rows = await store.all(gc, "SELECT network, user_id FROM bridge_links WHERE state != 'logged_out' GROUP BY network, user_id");
  const linked = {};
  for (const r of rows) if (users.has(r.user_id)) linked[r.network] = (linked[r.network] || 0) + 1;
  // 1.16.0: a new chat by number — the limit per person and hour (only while GateControl can look numbers up)
  const cfg = await config.load(gc);
  return { ...s, networks: (s.networks || []).map((n) => ({ ...n, linked: linked[n.id] || 0 })),
    newChat: { available: !!require('./bridgemedia').newChatApi(gc), perHour: cfg.newChatPerHour, min: config.NEW_CHAT_PER_HOUR.min, max: config.NEW_CHAT_PER_HOUR.max } };
}

async function adminSet(gc, body, now) {
  const b = api(gc);
  if (!b) throw fail('bridge_off', { reason: 'no_host' });
  const p = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!p) throw fail('invalid');
  const patch = {};
  if (p.enabled !== undefined) { if (typeof p.enabled !== 'boolean') throw fail('invalid'); patch.enabled = p.enabled; }
  if (p.networks !== undefined) {
    if (!p.networks || typeof p.networks !== 'object' || Array.isArray(p.networks)) throw fail('invalid');
    patch.networks = {};
    for (const [k, v] of Object.entries(p.networks)) {
      if (!NETWORKS.includes(k) || typeof v !== 'boolean') throw fail('invalid');
      patch.networks[k] = v;
    }
  }
  // 1.16.0: the limit of a new chat by number is the plugin's own setting
  if (p.newChatPerHour !== undefined) {
    if (!Number.isSafeInteger(p.newChatPerHour) || p.newChatPerHour < config.NEW_CHAT_PER_HOUR.min || p.newChatPerHour > config.NEW_CHAT_PER_HOUR.max) throw fail('invalid');
    if (Object.keys(patch).length) throw fail('invalid');
    await config.update(gc, { newChatPerHour: p.newChatPerHour });
    return adminView(gc, now);
  }
  if (!Object.keys(patch).length) throw fail('invalid');
  try { await b.configure(patch); } catch (e) {
    await log.add(gc, 'bridge_refused', `configure: ${String((e && e.code) || 'error').slice(0, 40)}`, now);
    throw mapped(e);
  }
  return adminView(gc, now);
}

// ─── Children ──────────────────────────────────────────

/** Is `userId` a child of Familie, and who are the parents? Without Familie nobody is a child. */
async function family(gc, now) {
  const r = await familie.roles(gc, now);
  return r ? { parents: new Set(r.parents), children: new Set(r.children) } : { parents: new Set(), children: new Set() };
}

async function grantsOf(gc, userId) {
  const rows = await store.all(gc, 'SELECT network FROM bridge_grants WHERE child_id = ?', [userId]);
  return new Set(rows.map((r) => r.network));
}
/** 1.16.0: the networks a child may start new chats on by number. */
async function newChatGrantsOf(gc, userId) {
  const rows = await store.all(gc, 'SELECT network FROM bridge_grants WHERE child_id = ? AND new_chat = 1', [userId]);
  return new Set(rows.map((r) => r.network));
}

/**
 * May this person link on this network? → { allowed, lock: null | 'child', child, newChat }
 * newChat (1.16.0): may they start a new chat by number — everybody else yes, a child only with the parents' second switch.
 */
async function allowed(gc, userId, net, now, fam) {
  const f = fam || await family(gc, now);
  if (!f.children.has(userId)) return { allowed: true, lock: null, child: false, newChat: true };
  return (await grantsOf(gc, userId)).has(net)
    ? { allowed: true, lock: null, child: true, newChat: (await newChatGrantsOf(gc, userId)).has(net) }
    : { allowed: false, lock: 'child', child: true, newChat: false };
}

/** Which networks an account is linked on right now (as last seen; never a number or a name). */
async function linkedOf(gc, userId) {
  const rows = await store.all(gc, "SELECT DISTINCT network FROM bridge_links WHERE user_id = ? AND state != 'logged_out'", [userId]);
  return new Set(rows.map((r) => r.network));
}

/** The children of `parentId` with the parents' switches. who: { gc, now, users, parentId } */
async function childrenOf(who) {
  const f = await family(who.gc, who.now);
  if (!f.parents.has(who.parentId)) throw fail('forbidden');
  const out = [];
  for (const id of [...f.children].sort((a, b) => a - b)) {
    if (!who.users.has(id)) continue;
    const g = await grantsOf(who.gc, id);
    const l = await linkedOf(who.gc, id);
    const nc = await newChatGrantsOf(who.gc, id);
    out.push({ userId: id, networks: Object.fromEntries(NETWORKS.map((n) => [n, g.has(n)])), linked: Object.fromEntries(NETWORKS.map((n) => [n, l.has(n)])),
      // 1.16.0: new chats by number (off until a parent allows it; always off without the permission itself)
      newChat: Object.fromEntries(NETWORKS.map((n) => [n, g.has(n) && nc.has(n)])) });
  }
  return out;
}

/**
 * A parent's switch. Taking a permission back ends the child's link on that network as well.
 * → { child, unlinked: { <network>: true (ended) | false (could not be ended — it stays until the child or the service ends it) } }
 */
async function childGrant(who, childId, body) {
  const f = await family(who.gc, who.now);
  if (!f.parents.has(who.parentId)) throw fail('forbidden');
  if (!f.children.has(childId) || !who.users.has(childId)) throw fail('not_found');
  const flags = (o) => {
    if (o === undefined) return {};
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw fail('invalid');
    for (const [k, v] of Object.entries(o)) if (!NETWORKS.includes(k) || typeof v !== 'boolean') throw fail('invalid');
    return o;
  };
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const nets = flags(b.networks);
  // 1.16.0: newChat — new chats by number, only next to the permission itself
  const newChat = flags(b.newChat);
  if (!Object.keys(nets).length && !Object.keys(newChat).length) throw fail('invalid');
  const had = await grantsOf(who.gc, childId);
  for (const [k, v] of Object.entries(newChat)) if (v && !(nets[k] === true || (nets[k] === undefined && had.has(k)))) throw fail('invalid');
  await store.tx(who.gc, async () => {
    for (const [k, v] of Object.entries(nets)) {
      if (v) await store.run(who.gc, 'INSERT INTO bridge_grants (child_id, network, granted_by, at) VALUES (?, ?, ?, ?) ON CONFLICT(child_id, network) DO NOTHING', [childId, k, who.parentId, who.now]);
      else await store.run(who.gc, 'DELETE FROM bridge_grants WHERE child_id = ? AND network = ?', [childId, k]);
    }
    for (const [k, v] of Object.entries(newChat)) {
      if (nets[k] === false) continue;
      await store.run(who.gc, 'UPDATE bridge_grants SET new_chat = ? WHERE child_id = ? AND network = ?', [v ? 1 : 0, childId, k]);
    }
  });
  const unlinked = {};
  for (const [k, v] of Object.entries(nets)) {
    if (v) continue;
    const linked = (await linkedOf(who.gc, childId)).has(k);
    if (!had.has(k) && !linked) continue;
    const r = await unlinkChild(who, childId, k);
    if (r !== null) unlinked[k] = r;
  }
  return { child: (await childrenOf(who)).find((c) => c.userId === childId), unlinked };
}

/** End a child's link → true (ended, or the bridge knows none), false (it could not be ended), null (the bridges are off: nothing can be linked). */
async function unlinkChild(who, childId, net) {
  const b = api(who.gc);
  const s = await hostStatus(who.gc);
  const n = (s.networks || []).find((x) => x.id === net);
  if (!b || !s.available || !s.enabled || !n || !n.enabled) return null;
  if (typeof b.unlinkFor !== 'function') return false;
  try {
    await b.unlinkFor(childId, net, who.parentId);
    await store.tx(who.gc, async () => {
      await store.run(who.gc, 'DELETE FROM bridge_links WHERE user_id = ? AND network = ?', [childId, net]);
      await forgetNumbers(who.gc, childId, net);
    });
    return true;
  } catch (e) {
    await log.add(who.gc, 'bridge_refused', `unlinkFor: ${String((e && e.code) || 'error').slice(0, 40)}${e && e.reason ? ' ' + String(e.reason).slice(0, 40) : ''}`, who.now);
    return false;
  }
}

const whoOf = (ctx) => ({ gc: ctx.gc, now: ctx.now, users: ctx.users, parentId: ctx.viewer });
const childrenView = (ctx) => childrenOf(whoOf(ctx));
const childSet = (ctx, childId, body) => childGrant(whoOf(ctx), childId, body);

/**
 * The services for the Familie plugin (its page „Mitglieder“ carries the parents' switches) — `user` is the parent.
 *   bridge_children  {} → { available, networks: ['whatsapp'], newChat, children: [{ userId, networks, linked, newChat }] }
 *   bridge_child_set { childId, networks?: { whatsapp: boolean }, newChat?: { whatsapp: boolean } } → { child, unlinked }
 * newChat (1.16.0): true when this GateControl can start chats by number — only then has the Familie page the second
 * switch per child.
 */
async function service(ctx, name, caller, user, payload) {
  if (caller !== 'gatecontrol-familie') throw fail('forbidden');
  const parentId = user && posInt(user.id);
  if (!parentId || !ctx.users.has(parentId)) throw fail('forbidden');
  const who = { gc: ctx.gc, now: ctx.now, users: ctx.users, parentId };
  if (name === 'bridge_children') {
    const nets = await offered(ctx.gc);
    // nothing to switch while no bridge is offered: the Familie page shows nothing then
    if (!nets.length) return { available: false, networks: [], children: [] };
    return { available: true, networks: nets, newChat: !!require('./bridgemedia').newChatApi(ctx.gc), children: await childrenOf(who) };
  }
  const childId = posInt(payload.childId);
  if (!childId) throw fail('invalid');
  return childGrant(who, childId, payload);
}

// ─── A person's own link ───────────────────────────────

async function remember(gc, userId, net, logins, now) {
  await store.tx(gc, async () => {
    const seen = new Set();
    for (const l of logins) {
      if (!l || !ID_RE.test(String(l.id || ''))) continue;
      const state = STATES.includes(l.state) ? l.state : 'unknown';
      seen.add(l.id);
      await store.run(gc, `INSERT INTO bridge_links (user_id, network, login_id, state, linked_at, seen_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, network, login_id) DO UPDATE SET state = excluded.state, seen_at = excluded.seen_at`, [userId, net, l.id, state, now, now]);
    }
    const rows = await store.all(gc, 'SELECT login_id FROM bridge_links WHERE user_id = ? AND network = ?', [userId, net]);
    for (const r of rows) if (!seen.has(r.login_id)) await store.run(gc, 'DELETE FROM bridge_links WHERE user_id = ? AND network = ? AND login_id = ?', [userId, net, r.login_id]);
    // 1.16.0: no link left (ended at the service) — the keyed hashes of numbers go as well
    if (!seen.size && rows.length) await forgetNumbers(gc, userId, net);
  });
}

/** 1.14.0: ask the bridge for the viewer's logins on one network and keep what it says (their own request must be in flight). */
async function refresh(ctx, net) {
  const b = api(ctx.gc);
  if (!b || !NETWORKS.includes(net)) return;
  await remember(ctx.gc, ctx.viewer, net, await b.logins(ctx.viewer, net), ctx.now);
}

/** GET bridges — the viewer's own state. Asks the bridge only for networks that run. */
async function mine(ctx) {
  const s = await hostStatus(ctx.gc);
  if (!s.available || !s.enabled) return { available: false, networks: [] };
  const b = api(ctx.gc);
  const fam = await family(ctx.gc, ctx.now);
  const consents = new Map((await store.all(ctx.gc, 'SELECT network, at FROM bridge_consent WHERE user_id = ?', [ctx.viewer])).map((r) => [r.network, r.at]));
  const out = [];
  for (const n of s.networks || []) {
    if (!NETWORKS.includes(n.id) || !n.enabled) continue;
    const a = await allowed(ctx.gc, ctx.viewer, n.id, ctx.now, fam);
    let logins = [];
    let state = n.state;
    if (n.state === 'running') {
      try {
        logins = await b.logins(ctx.viewer, n.id);
        await remember(ctx.gc, ctx.viewer, n.id, logins, ctx.now);
      } catch (e) {
        // what was known last, marked as not reachable
        state = 'unreachable';
        logins = (await store.all(ctx.gc, 'SELECT login_id AS id, state, linked_at FROM bridge_links WHERE user_id = ? AND network = ?', [ctx.viewer, n.id]))
          .map((r) => ({ id: r.id, name: '', state: r.state, since: iso(r.linked_at) }));
      }
    }
    out.push({
      id: n.id, state, allowed: a.allowed, lock: a.lock, consent: consents.has(n.id) ? iso(consents.get(n.id)) : null,
      // 1.16.0: a new chat by number — the line in „Neuer Chat“ and why it does not work right now
      newChat: await newChatState(ctx, n.id, a, state, await store.all(ctx.gc, 'SELECT state FROM bridge_links WHERE user_id = ? AND network = ?', [ctx.viewer, n.id])),
      // 1.13.0: the bridge runs an older program than GateControl expects — sending and receiving may fail until the
      // administrator updated it; nothing has to be linked again
      outdated: n.outdated === true, version: typeof n.version === 'string' ? n.version : null, wantVersion: typeof n.wantVersion === 'string' ? n.wantVersion : null,
      // the name is the person's own account at the service (WhatsApp: their number) — theirs to see, nobody else's
      logins: logins.map((l) => ({ id: l.id, name: typeof l.name === 'string' ? l.name.slice(0, 80) : '', state: STATES.includes(l.state) ? l.state : 'unknown', since: l.since || null })),
    });
  }
  // where the bridges run (today always the server) — the page says so
  return { available: true, location: s.location === 'server' ? 'server' : 'gateway', networks: out };
}

/** The modules of a QR code → { size, rows: ['0101…'] } (error correction M, no quiet zone), or null. */
function qrMatrix(text) {
  if (typeof text !== 'string' || !text || text.length > 2048) return null;
  try {
    const q = encode(text, { ecc: 'M', border: 0 });
    return { size: q.size, rows: q.data.map((row) => row.map((x) => (x ? '1' : '0')).join('')) };
  } catch { return null; }
}

/** Everything before a login step: the bridge is offered, the person may, and has read the notes. */
async function gate(ctx, net, { consent = true } = {}) {
  const b = api(ctx.gc);
  if (!b) throw fail('bridge_off', { reason: 'no_host' });
  const a = await allowed(ctx.gc, ctx.viewer, net, ctx.now);
  if (!a.allowed) throw fail('bridge_locked');
  if (consent && !(await store.one(ctx.gc, 'SELECT 1 AS x FROM bridge_consent WHERE user_id = ? AND network = ?', [ctx.viewer, net]))) throw fail('consent_required');
  return b;
}

async function consent(ctx, net, body) {
  if (!body || body.accept !== true) throw fail('invalid');
  await gate(ctx, net, { consent: false });
  await store.tx(ctx.gc, () => store.run(ctx.gc, 'INSERT INTO bridge_consent (user_id, network, at) VALUES (?, ?, ?) ON CONFLICT(user_id, network) DO NOTHING', [ctx.viewer, net, ctx.now]));
  const row = await store.one(ctx.gc, 'SELECT at FROM bridge_consent WHERE user_id = ? AND network = ?', [ctx.viewer, net]);
  return { consent: iso(row.at) };
}

/** A step for the apps: what to show — never more than GateControl handed over. */
async function stepOut(ctx, net, r) {
  if (r && r.waiting === true) return { processId: r.processId, waiting: true };
  const s = (r && r.step) || {};
  if (s.type === 'complete') {
    try { await remember(ctx.gc, ctx.viewer, net, await api(ctx.gc).logins(ctx.viewer, net), ctx.now); } catch { /* GET bridges catches up */ }
    return { processId: r.processId, step: { id: s.id, type: 'complete', loginId: s.loginId || null } };
  }
  return {
    processId: r.processId,
    step: {
      id: s.id, type: s.type,
      ...(s.type === 'user_input' ? { fields: (s.fields || []).map((f) => ({ id: f.id, type: f.type, optional: f.optional === true })) } : {}),
      ...(s.type === 'display_and_wait' ? { display: {
        type: s.display && s.display.type, data: s.display && s.display.data,
        ...(s.display && s.display.type === 'qr' ? { matrix: qrMatrix(s.display.data) } : {}),
      } } : {}),
    },
  };
}

async function loginStart(ctx, net, body) {
  const flow = body && body.flow;
  if (!FLOWS.includes(flow)) throw fail('invalid');
  const b = await gate(ctx, net);
  try { return await stepOut(ctx, net, await b.login.start(ctx.viewer, net, flow)); } catch (e) { throw mapped(e); }
}

async function loginStep(ctx, net, processId, stepId, body) {
  const b = await gate(ctx, net);
  const input = body && body.input;
  const kind = input === undefined || input === null ? 'display_and_wait' : 'user_input';
  if (kind === 'user_input') {
    if (typeof input !== 'object' || Array.isArray(input)) throw fail('invalid');
    const keys = Object.keys(input);
    if (!keys.length || keys.length > 8 || keys.some((k) => !ID_RE.test(k) || typeof input[k] !== 'string' || input[k].length > 500)) throw fail('invalid');
  }
  try { return await stepOut(ctx, net, await b.login.step(ctx.viewer, net, ident(processId), ident(stepId), kind, kind === 'user_input' ? input : undefined)); } catch (e) { throw mapped(e); }
}

async function loginCancel(ctx, net, processId) {
  const b = api(ctx.gc);
  if (!b) throw fail('bridge_off', { reason: 'no_host' });
  try { await b.login.cancel(ctx.viewer, net, ident(processId)); } catch (e) { throw mapped(e); }
  return { cancelled: true };
}

/** Unlink: always allowed for one's own account — also for a child whose permission was taken back. */
async function unlink(ctx, net, loginId) {
  const b = api(ctx.gc);
  if (!b) throw fail('bridge_off', { reason: 'no_host' });
  try { await b.logout(ctx.viewer, net, ident(loginId)); } catch (e) { throw mapped(e); }
  await store.tx(ctx.gc, async () => {
    await store.run(ctx.gc, 'DELETE FROM bridge_links WHERE user_id = ? AND network = ? AND login_id = ?', [ctx.viewer, net, loginId]);
    // 1.16.0: the keyed hashes of numbers go with the last link
    if (!(await store.one(ctx.gc, 'SELECT 1 AS x FROM bridge_links WHERE user_id = ? AND network = ?', [ctx.viewer, net]))) await forgetNumbers(ctx.gc, ctx.viewer, net);
  });
  return { unlinked: true };
}

// ─── A new chat by number (1.15.0; 1.16.0: the dialog in the apps and the portal) ─────

const LOOKUP_WINDOW_MS = 3600000;     // 1.16.0: the admin's limit counts per hour (config newChatPerHour, 1–60)
const RECENT_MS = 15 * 60000;         // a number just found: starting its chat counts no second time
const LOOKUP_TIMEOUT_MS = 15000;      // the bridge has this long, then „nicht erreichbar“
const NUMBER_RE = /^\+[1-9][0-9]{6,14}$/;
const lookups = new Map(); // userId → [times of checks that counted]
const recent = new Map();  // userId → Map(mark of a number found → time) — in memory only, never the number

/** The number of the body, the way GateControl reads it (+ and the country code; spaces, dashes, dots, brackets,
 *  a leading 00) → '+49…', else invalid_number. A national 0 after +49 is no number. Never logged or stored. */
function numberOf(v) {
  if (typeof v !== 'string' || !v.trim() || v.length > 40) return null;
  let x = v.replace(/[\s\-./()]/g, '');
  if (x.startsWith('00')) x = '+' + x.slice(2);
  if (!NUMBER_RE.test(x) || x.startsWith('+490')) return null;
  return x;
}
function numberIn(body) {
  const n = numberOf(body && typeof body === 'object' ? body.number : null);
  if (!n) throw fail('invalid_number');
  return n;
}

/** The checks that counted in the last hour → { perHour, left, retryAfterS, list } */
function budget(ctx) {
  const perHour = ctx.cfg && Number.isSafeInteger(ctx.cfg.newChatPerHour) ? ctx.cfg.newChatPerHour : config.DEFAULTS.newChatPerHour;
  const list = (lookups.get(ctx.viewer) || []).filter((t) => ctx.now - t < LOOKUP_WINDOW_MS);
  const left = Math.max(0, perHour - list.length);
  const retryAfterS = left > 0 ? 0 : Math.max(1, Math.ceil((LOOKUP_WINDOW_MS - (ctx.now - list[list.length - perHour])) / 1000));
  return { perHour, left, retryAfterS, list };
}

/** Count one check (before asking the service) → a function that takes it back (an answer that does not count). */
function take(ctx) {
  const b = budget(ctx);
  if (b.left <= 0) throw fail('rate_limited', { retryAfterS: b.retryAfterS, perHour: b.perHour });
  const t = ctx.now;
  b.list.push(t);
  if (lookups.size > 2000) lookups.clear();
  lookups.set(ctx.viewer, b.list);
  return () => {
    const l = lookups.get(ctx.viewer) || [];
    const i = l.lastIndexOf(t);
    if (i >= 0) l.splice(i, 1);
  };
}

function remembered(ctx, mark) {
  const m = recent.get(ctx.viewer);
  const t = m && m.get(mark);
  return !!(t && ctx.now - t < RECENT_MS);
}
function remember1(ctx, mark) {
  if (!mark) return;
  let m = recent.get(ctx.viewer);
  if (!m) { if (recent.size > 2000) recent.clear(); m = new Map(); recent.set(ctx.viewer, m); }
  for (const [k, t] of m) if (ctx.now - t >= RECENT_MS) m.delete(k);
  if (m.size > 50) m.delete(m.keys().next().value);
  m.set(mark, ctx.now);
}

/** The keyed hash of a number of this person and network (seal.mark) — never the number. */
const markOf = (ctx, net, number) => seal.mark(`${ctx.viewer}|${net}|${number}`);

async function forgetNumbers(gc, userId, net) {
  await store.run(gc, 'UPDATE conversations SET bridge_num = NULL WHERE bridge_owner = ? AND bridge_net = ? AND bridge_num IS NOT NULL', [userId, net]);
  recent.delete(userId);
}

/** The conversation of a chat started with this number here (open at the service) → its row, or null. */
async function chatOfNumber(ctx, net, mark) {
  if (!mark) return null;
  return store.one(ctx.gc, 'SELECT * FROM conversations WHERE bridge_owner = ? AND bridge_net = ? AND bridge_num = ? AND bridge_closed = 0 LIMIT 1', [ctx.viewer, net, mark]);
}

/**
 * GET bridges → networks[].newChat: { available, reason, limit: { perHour, left, retryAfterS } }
 * reason: off (GateControl cannot look numbers up) · unlinked · child_locked · child_new_chat_off · logged_out ·
 * unreachable. The apps show the line „WhatsApp-Chat mit Nummer“ for everything but off, unlinked and
 * child_new_chat_off; the other reasons are the dialog's states.
 */
async function newChatState(ctx, net, a, state, links) {
  const b = budget(ctx);
  const limit = { perHour: b.perHour, left: b.left, retryAfterS: b.retryAfterS };
  let reason = null;
  if (!require('./bridgemedia').newChatApi(ctx.gc)) reason = 'off';
  else if (!links.length) reason = 'unlinked';
  else if (!a.allowed) reason = 'child_locked';
  else if (!a.newChat) reason = 'child_new_chat_off';
  else if (!links.some((l) => l.state !== 'logged_out')) reason = 'logged_out';
  else if (state !== 'running') reason = 'unreachable';
  return { available: reason === null, reason, limit };
}

/** GET me features.bridge_new_chat (1.16.0): GateControl can look numbers up and the person linked a service — the
 *  first chat can be one they start themselves. */
async function newChatFeature(ctx) {
  if (!require('./bridgemedia').newChatApi(ctx.gc)) return false;
  return !!(await store.one(ctx.gc, 'SELECT 1 AS x FROM bridge_links WHERE user_id = ? LIMIT 1', [ctx.viewer]));
}

/** Who may ask: gc.bridges version 4, the bridge offered, a child allowed (and with the second switch), the person's
 *  own link alive. */
async function newGate(ctx, net) {
  const b = require('./bridgemedia').newChatApi(ctx.gc);
  if (!b) throw fail('feature_off');
  const a = await allowed(ctx.gc, ctx.viewer, net, ctx.now);
  if (!a.allowed) throw fail('bridge_locked');
  const links = await store.all(ctx.gc, 'SELECT state FROM bridge_links WHERE user_id = ? AND network = ?', [ctx.viewer, net]);
  if (!links.length) throw fail('bridge_unlinked', { reason: 'unlinked' });
  if (!a.newChat) throw fail('child_new_chat_off');
  if (!links.some((l) => l.state !== 'logged_out')) throw fail('bridge_logged_out', { reason: 'logged_out' });
  return b;
}

/** A call to the bridge, at most LOOKUP_TIMEOUT_MS long. */
function timed(p) {
  let t = null;
  const out = Promise.race([p, new Promise((_, reject) => {
    t = setTimeout(() => reject(fail('bridge_unreachable', { reason: 'timeout' })), LOOKUP_TIMEOUT_MS);
    if (t.unref) t.unref();
  })]);
  return out.finally(() => clearTimeout(t));
}

function lookupMapped(e) {
  if (e && e.code === 'ERR_RATE_LIMIT') return fail('rate_limited', Number.isSafeInteger(e.retryAfterS) ? { retryAfterS: e.retryAfterS } : null);
  if (e && e.code === 'ERR_INVALID' && e.reason === 'invalid_number') return fail('invalid_number');
  if (e && e.code === 'ERR_BRIDGE' && e.reason === 'not_found') return fail('not_found', { reason: 'not_on_network' });
  // GateControl lost the login (the service dropped the linked device)
  if (e && e.code === 'ERR_BRIDGE' && (e.reason === 'logged_out' || e.reason === 'not_logged_in')) return fail('bridge_logged_out', { reason: 'logged_out' });
  return mapped(e);
}
/** Refusals that asked nobody at the service: they do not count. */
const NOT_COUNTED = ['invalid_number', 'rate_limited', 'bridge_unreachable', 'bridge_off', 'bridge_logged_out', 'feature_off', 'forbidden'];

/** The chat as GET conversations/:id?bridged=1 shows it (the caller asked for exactly this one). */
async function convView(ctx, convId) {
  const conversations = require('./conversations');
  ctx.bridged = true;
  const a = await conversations.access(ctx, convId);
  return conversations.view(ctx, a.conv, a.me, a.members);
}

/**
 * POST bridges/:network/resolve { number } → { found, name, avatarUrl, existing: null | { conversationId } }
 * Is this number at the service, under which name? A chat started with it here before → existing, without asking
 * the service (and without counting). Invalid numbers count neither.
 */
async function resolveNumber(ctx, net, body) {
  const b = await newGate(ctx, net);
  const number = numberIn(body);
  const mark = markOf(ctx, net, number);
  const known = await chatOfNumber(ctx, net, mark);
  if (known) {
    const v = await convView(ctx, known.id);
    return { found: true, name: v.title || null, avatarUrl: v.avatarUrl || null, existing: { conversationId: known.id } };
  }
  const back = take(ctx);
  let r;
  try { r = await timed(b.resolve(ctx.viewer, net, number)); } catch (e) {
    const m = lookupMapped(e);
    if (!m || NOT_COUNTED.includes(m.code)) back();
    throw m;
  }
  const name = r && typeof r.name === 'string' ? r.name.replace(/[\0-\x1f\x7f]/g, ' ').trim().slice(0, 120) || null : null;
  if (!(r && r.found === true)) return { found: false, name: null, avatarUrl: null, existing: null };
  remember1(ctx, mark);
  // a GateControl that names the chat it knows for this number (not yet: version 4 answers only found and name)
  const ref = r.chat && typeof r.chat === 'object' && typeof r.chat.id === 'string' ? r.chat.id : null;
  const conv = ref ? await store.one(ctx.gc, 'SELECT id FROM conversations WHERE bridge_owner = ? AND bridge_net = ? AND bridge_ref = ? AND bridge_closed = 0', [ctx.viewer, net, ref]) : null;
  if (conv) {
    const v = await convView(ctx, conv.id);
    return { found: true, name: name || v.title || null, avatarUrl: v.avatarUrl || null, existing: { conversationId: conv.id } };
  }
  return { found: true, name, avatarUrl: null, existing: null };
}

/** POST bridges/:network/chats { number } → { conversation, created } — the direct chat with this number, made or found. */
async function newChat(ctx, net, body) {
  const b = await newGate(ctx, net);
  const number = numberIn(body);
  const mark = markOf(ctx, net, number);
  const known = await chatOfNumber(ctx, net, mark);
  if (known) return { conversation: await convView(ctx, known.id), created: false };
  // a number just checked (and found) counts no second time
  const back = remembered(ctx, mark) ? () => {} : take(ctx);
  let r;
  try { r = await timed(b.createDm(ctx.viewer, net, number)); } catch (e) {
    const m = lookupMapped(e);
    if (!m || NOT_COUNTED.includes(m.code)) back();
    throw m;
  }
  const chat = r && r.chat && typeof r.chat === 'object' ? r.chat : null;
  if (!chat) throw fail('bridge_failed', { reason: 'bad_answer' });
  return store.tx(ctx.gc, async () => {
    const before = await store.one(ctx.gc, 'SELECT id FROM conversations WHERE bridge_owner = ? AND bridge_net = ? AND bridge_ref = ?', [ctx.viewer, net, String(chat.id || '')]);
    const conv = await require('./bridgechats').openChat(ctx, net, { id: chat.id, kind: 'direct', name: chat.name });
    if (!conv) throw fail('bridge_failed', { reason: 'bad_answer' });
    // 1.16.0: found again by the keyed hash of the number (never the number)
    if (mark && conv.kind === 'direct') await store.run(ctx.gc, 'UPDATE conversations SET bridge_num = ? WHERE id = ?', [mark, conv.id]);
    return { conversation: await convView(ctx, conv.id), created: !before };
  });
}

// ─── Routes ────────────────────────────────────────────

/** bridges/* of the app API → the answer's body, or null when the path is not ours. */
async function route(ctx, req, seg) {
  if (seg[0] !== 'bridges') return null;
  const m = String(req.method || 'GET').toUpperCase();
  if (seg.length === 1 && m === 'GET') return { bridges: await mine(ctx) };
  if (seg[1] === 'children') {
    if (seg.length === 2 && m === 'GET') return { children: await childrenView(ctx) };
    const id = seg.length === 3 ? posInt(seg[2]) : null;
    if (id && (m === 'PUT' || m === 'PATCH')) return childSet(ctx, id, req.body);
    throw fail('not_found');
  }
  if (seg.length < 3) throw fail('not_found');
  const net = network(seg[1]);
  if (seg.length === 3 && seg[2] === 'consent' && m === 'POST') return consent(ctx, net, req.body);
  if (seg.length === 3 && seg[2] === 'login' && m === 'POST') return { login: await loginStart(ctx, net, req.body) };
  if (seg.length === 5 && seg[2] === 'login' && m === 'POST') return { login: await loginStep(ctx, net, seg[3], seg[4], req.body) };
  if (seg.length === 4 && seg[2] === 'login' && m === 'DELETE') return loginCancel(ctx, net, seg[3]);
  if (seg.length === 4 && seg[2] === 'logins' && m === 'DELETE') return unlink(ctx, net, seg[3]);
  // 1.15.0: a new chat by number (1.16.0: the dialog „Neuer WhatsApp-Chat“ in the portal; README "App-API")
  if (seg.length === 3 && seg[2] === 'resolve' && m === 'POST') return resolveNumber(ctx, net, req.body);
  if (seg.length === 3 && seg[2] === 'chats' && m === 'POST') return newChat(ctx, net, req.body);
  throw fail('not_found');
}

module.exports = { route, service, offered, adminView, adminSet, mine, allowed, refresh, api, numberOf, newChatFeature, NETWORKS, FLOWS, LOOKUP_TIMEOUT_MS, _resetLookups: () => { lookups.clear(); recent.clear(); } };
