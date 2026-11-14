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
//   1.13.0 — the portal page „Verknüpfte Dienste“ (ui/bridges.js): a QR step also carries `display.matrix`
//   { size, rows } — the code's modules, drawn by the page (the apps draw from `display.data` themselves).
//
// Kept here (migration 006): the consent, the parents' grants and WHICH account is linked on which network (the
// bridge's login id and state — for the count on the admin card and the state without asking the bridge). Never the
// phone number, never a session key: those stay in the bridge.

const store = require('./store');
const log = require('./log');
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
  return { ...s, networks: (s.networks || []).map((n) => ({ ...n, linked: linked[n.id] || 0 })) };
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

/** May this person link on this network? → { allowed, lock: null | 'child' } */
async function allowed(gc, userId, net, now, fam) {
  const f = fam || await family(gc, now);
  if (!f.children.has(userId)) return { allowed: true, lock: null };
  return (await grantsOf(gc, userId)).has(net) ? { allowed: true, lock: null } : { allowed: false, lock: 'child' };
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
    out.push({ userId: id, networks: Object.fromEntries(NETWORKS.map((n) => [n, g.has(n)])), linked: Object.fromEntries(NETWORKS.map((n) => [n, l.has(n)])) });
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
  const nets = body && typeof body === 'object' && body.networks && typeof body.networks === 'object' && !Array.isArray(body.networks) ? body.networks : null;
  if (!nets || !Object.keys(nets).length) throw fail('invalid');
  for (const [k, v] of Object.entries(nets)) if (!NETWORKS.includes(k) || typeof v !== 'boolean') throw fail('invalid');
  const had = await grantsOf(who.gc, childId);
  await store.tx(who.gc, async () => {
    for (const [k, v] of Object.entries(nets)) {
      if (v) await store.run(who.gc, 'INSERT INTO bridge_grants (child_id, network, granted_by, at) VALUES (?, ?, ?, ?) ON CONFLICT(child_id, network) DO NOTHING', [childId, k, who.parentId, who.now]);
      else await store.run(who.gc, 'DELETE FROM bridge_grants WHERE child_id = ? AND network = ?', [childId, k]);
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
    await store.tx(who.gc, () => store.run(who.gc, 'DELETE FROM bridge_links WHERE user_id = ? AND network = ?', [childId, net]));
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
 *   bridge_children  {} → { available, networks: ['whatsapp'], children: [{ userId, networks, linked }] }
 *   bridge_child_set { childId, networks: { whatsapp: boolean } } → { child, unlinked }
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
    return { available: true, networks: nets, children: await childrenOf(who) };
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
  });
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
  await store.tx(ctx.gc, () => store.run(ctx.gc, 'DELETE FROM bridge_links WHERE user_id = ? AND network = ? AND login_id = ?', [ctx.viewer, net, loginId]));
  return { unlinked: true };
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
  throw fail('not_found');
}

module.exports = { route, service, offered, adminView, adminSet, mine, allowed, api, NETWORKS, FLOWS };
