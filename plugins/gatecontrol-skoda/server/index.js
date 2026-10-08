'use strict';

// gatecontrol-skoda — Škoda vehicles (MySkoda) as a GateControl plugin
// (formerly built into GateControl: src/services/skoda, routes/api/skoda.js,
// the Fahrzeuge page and the vehicle part of the portal tab "Fahrzeug").
//
//   admin API   (Settings → Plugins, the plugin page; administrators only)
//     GET  /  · /users · /vehicles/:id/details · /vehicles/:id/image
//     POST /accounts · /accounts/:id/sync · /vehicles/:id/refresh · /vehicles/:id/command
//     PUT  /accounts/:id · /accounts/:id/spin · /vehicles/:id/owners · /settings
//     DELETE /accounts/:id
//   portal API  (the identified portal viewer — owner-scoped)
//     GET  /portal · /portal/vehicles/:id/image · /portal/vehicles/:id/details
//     POST /portal/vehicles/:id/command   (the host lets only signed-in viewers change things)
//
// Requests run with the requesting user's rights: req.user.portal = a portal
// viewer, who only ever sees and controls the vehicles an administrator
// assigned to them (position and departure times only after a real login,
// req.user.loggedIn); the admin API is reached only by administrators.

const ui = require('./ui');
const store = require('./store');
const service = require('./service');
const control = require('./control');
const details = require('./details');
const geocode = require('./geocode');
const portal = require('./portal');
const legacy = require('./legacy');
const texts = require('./texts.json');

const state = { importing: false };

function t(lang, key, params) {
  const l = lang === 'en' ? 'en' : 'de';
  let s = (texts[l] && texts[l][key]) || texts.de[key] || key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{{${k}}}`).join(String(v));
  return s;
}

// error code → [HTTP status, text key]
const ERRORS = {
  SKODA_VALIDATION: [400, 'error.validation'],
  SKODA_OWNER_UNKNOWN_USER: [400, 'error.owner_unknown_user'],
  SKODA_UNKNOWN_COMMAND: [400, 'error.unknown_command'],
  SKODA_ACCOUNT_EXISTS: [409, 'error.account_exists'],
  SKODA_SPIN_REQUIRED: [409, 'cmd.spin_required'],
  SKODA_NO_SESSION: [409, 'error.no_session'],
  SKODA_TIMER_READONLY: [409, 'timers.readonly'],
  SKODA_REFRESH_COOLDOWN: [429, 'error.cooldown'],
  SKODA_RATE_LIMITED: [429, 'error.rate_limited'],
  SKODA_COMMAND_RATE_LIMIT: [429, 'error.command_rate_limit'],
  SKODA_VEHICLE_NOT_FOUND: [404, 'error.vehicle_not_found'],
  SKODA_TIMER_NOT_FOUND: [404, 'timers.not_found'],
  SKODA_ACCOUNT_NOT_FOUND: [404, 'error.account_not_found'],
  SKODA_NOT_OWNER: [403, 'error.not_owner'],
  LOGIN_REQUIRED: [403, 'error.login_required'],
  FORBIDDEN: [403, 'error.forbidden'],
  NOT_FOUND: [404, 'error.not_found'],
  INVALID: [400, 'error.validation'],
};

function fail(code) { return Object.assign(new Error(code), { code }); }

function errorResponse(e, lang) {
  const known = e && Object.prototype.hasOwnProperty.call(ERRORS, e.code) ? ERRORS[e.code] : null;
  const [status, key] = known || [502, 'error.generic'];
  return { status, json: { ok: false, code: (e && e.code) || null, error: t(lang, key) } };
}

const posInt = (v) => {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d{1,10}$/.test(v) ? Number(v) : NaN);
  return Number.isInteger(n) && n > 0 ? n : null;
};

async function usersById(gc) {
  const m = new Map();
  try { for (const u of await gc.users.list()) m.set(u.id, { id: u.id, username: u.name }); } catch { /* users unavailable */ }
  return m;
}

// ─── Portal Start tiles and search (declarative; the host renders them) ──

const CAR_ICON = 'M5 16l1-5 2-3h8l2 3 1 5v3h-2a2 2 0 0 1-4 0H9a2 2 0 0 1-4 0H3v-3z';

function fmtNum(v, lang) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString(lang === 'en' ? 'en-GB' : 'de-DE', { maximumFractionDigits: 0 }) : null;
}

function vehicleTile(v, lang) {
  const s = v.state || {};
  const charging = String((s.charging && s.charging.state) || '').toUpperCase() === 'CHARGING';
  const soc = s.soc == null ? null : Number(s.soc);
  const parts = [];
  if (soc != null && Number.isFinite(soc)) parts.push(fmtNum(soc, lang) + ' %');
  if (s.rangeKm != null && fmtNum(s.rangeKm, lang) != null) parts.push(fmtNum(s.rangeKm, lang) + ' km');
  if (charging) parts.push(t(lang, 'portal.charging'));
  else if (s.locked === false) parts.push(t(lang, 'portal.unlocked'));
  let tone = null;
  if (charging) tone = 'on';
  else if (soc != null && soc <= 15) tone = 'crit';
  else if (s.locked === false) tone = 'warn';
  else if (soc != null) tone = 'good';
  return { section: 'skoda', title: v.name || v.model || '', value: parts.length ? parts.join(' · ') : '–', state: tone, icon: CAR_ICON };
}

// ─── Routes ─────────────────────────────────────

function vehicleId(seg) {
  const id = posInt(seg);
  if (!id) throw fail('NOT_FOUND');
  return id;
}

async function portalRoute(req, gc, seg) {
  const user = req.user;
  const m = req.method;
  if (m === 'GET' && seg.length === 1) {
    const loggedIn = user.loggedIn === true;
    return { json: { ok: true, vehicles: await portal.vehiclesFor(gc, user.id, { loggedIn }), loggedIn } };
  }
  if (seg[1] !== 'vehicles' || seg.length !== 4) throw fail('NOT_FOUND');
  const id = vehicleId(seg[2]);
  if (!(await store.isOwner(gc, id, user.id))) throw fail('SKODA_NOT_OWNER');
  if (m === 'GET' && seg[3] === 'image') {
    const image = await store.imageOf(gc, id);
    if (!image) throw fail('NOT_FOUND');
    return { json: { ok: true, image } };
  }
  if (m === 'GET' && seg[3] === 'details') return { json: { ok: true, details: await details.getDetails(gc, id, { forAdmin: false }) } };
  if (m === 'POST' && seg[3] === 'command') {
    // the host only forwards changes of a signed-in viewer; checked here again
    if (user.loggedIn === false) throw fail('LOGIN_REQUIRED');
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    await control.runCommand(gc, id, body.action, body.args || {});
    return { json: { ok: true } };
  }
  throw fail('NOT_FOUND');
}

async function adminRoute(req, gc, seg) {
  const m = req.method;
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const [a, b, c] = seg;

  if (!seg.length && m === 'GET') {
    const users = await usersById(gc);
    const owners = await store.allOwners(gc);
    const vehicles = (await store.listVehicles(gc)).map((v) => ({
      ...v, owners: (owners.get(v.id) || []).filter((uid) => users.has(uid)).map((uid) => users.get(uid)),
    }));
    return { json: { ok: true, accounts: await store.listAccounts(gc), vehicles, lastSyncAt: service.state.lastSyncAt, poll_interval_min: await service.pollIntervalMin(gc) } };
  }

  if (a === 'users' && seg.length === 1 && m === 'GET') return { json: { ok: true, users: [...(await usersById(gc)).values()] } };

  if (a === 'settings' && seg.length === 1 && m === 'PUT') {
    const val = Number(body.poll_interval_min);
    if (!Number.isInteger(val) || val < service.POLL_MIN || val > service.POLL_MAX) throw fail('SKODA_VALIDATION');
    await gc.settings.set('interval', val);
    return { json: { ok: true } };
  }

  if (a === 'accounts') {
    if (seg.length === 1 && m === 'POST') {
      // No implicit sync: the page calls POST /accounts/:id/sync afterwards.
      const account = await store.createAccount(gc, { email: body.email, password: body.password });
      return { status: 201, json: { ok: true, account } };
    }
    const id = posInt(b);
    if (!id) throw fail('NOT_FOUND');
    if (seg.length === 2 && m === 'PUT') { await store.updatePassword(gc, id, body.password); return { json: { ok: true } }; }
    if (seg.length === 2 && m === 'DELETE') {
      if (!(await store.getAccount(gc, id))) throw fail('SKODA_ACCOUNT_NOT_FOUND');
      await service.removeAccount(gc, id); // account lock: waits for an in-flight sync
      return { json: { ok: true } };
    }
    if (seg.length === 3 && c === 'sync' && m === 'POST') {
      if (!(await store.getAccount(gc, id))) throw fail('SKODA_ACCOUNT_NOT_FOUND');
      return { json: { ok: true, result: await service.syncAccount(gc, id) } };
    }
    if (seg.length === 3 && c === 'spin' && m === 'PUT') { await store.setSpin(gc, id, body.spin); return { json: { ok: true } }; }
    throw fail('NOT_FOUND');
  }

  if (a === 'vehicles' && seg.length === 3) {
    const id = vehicleId(b);
    if (c === 'details' && m === 'GET') return { json: { ok: true, details: await details.getDetails(gc, id, { forAdmin: true }) } };
    if (c === 'image' && m === 'GET') {
      const image = await store.imageOf(gc, id);
      if (!image) throw fail('NOT_FOUND');
      return { json: { ok: true, image } };
    }
    if (c === 'refresh' && m === 'POST') { await service.refreshVehicle(gc, id); return { json: { ok: true } }; }
    if (c === 'owners' && m === 'PUT') {
      if (!Array.isArray(body.user_ids) || body.user_ids.length > 1000) throw fail('SKODA_VALIDATION');
      const ids = await store.setOwners(gc, id, body.user_ids);
      const users = await usersById(gc);
      return { json: { ok: true, owners: ids.filter((uid) => users.has(uid)).map((uid) => users.get(uid)) } };
    }
    if (c === 'command' && m === 'POST') { await control.runCommand(gc, id, body.action, body.args || {}); return { json: { ok: true } }; }
  }

  throw fail('NOT_FOUND');
}

function resetCaches() {
  service.reset();
  control.reset();
  details.reset();
  geocode.reset();
}

module.exports = {
  async start(gc) {
    resetCaches();
    gc.log.info('skoda started', gc.plugin.version);
  },

  async request(req, gc) {
    const lang = req.lang;
    try {
      const seg = String(req.path || '/').split('/').filter(Boolean);
      if (seg[0] === 'portal') {
        if (!req.user || !req.user.portal) throw fail('FORBIDDEN');
        return await portalRoute(req, gc, seg);
      }
      // admin API: administrators only, never a portal viewer
      if (!req.user || req.user.portal || req.user.role !== 'admin') throw fail('FORBIDDEN');
      return await adminRoute(req, gc, seg);
    } catch (e) {
      if (!(e && Object.prototype.hasOwnProperty.call(ERRORS, e.code))) gc.log.warn('request failed', req.method, req.path, (e && e.code) || 'error');
      return errorResponse(e, lang);
    }
  },

  async render(view, gc) {
    return { html: ui.render(view, t) };
  },

  /** The section in the portal tab "Fahrzeug" only for viewers with a vehicle assigned to them. */
  async portalVisible({ user }, gc) {
    if (!user) return false;
    return (await store.vehiclesOwnedBy(gc, user.id)).length > 0;
  },

  /** Start tab: one tile per vehicle of the viewer (charge level, range, state). */
  async portalTiles({ user, lang }, gc) {
    if (!user) return [];
    return (await portal.vehiclesFor(gc, user.id, { loggedIn: false })).slice(0, 4).map((v) => vehicleTile(v, lang));
  },

  /** Portal search: the viewer's own vehicles by name or model. */
  async portalSearch({ user, lang, q }, gc) {
    if (!user || typeof q !== 'string' || q.length < 2) return [];
    const needle = q.toLowerCase();
    return (await portal.vehiclesFor(gc, user.id, { loggedIn: false, withState: false }))
      .filter((v) => String(v.name || '').toLowerCase().includes(needle) || String(v.model || '').toLowerCase().includes(needle))
      .slice(0, 10)
      .map((v) => ({ title: v.name || v.model || '', subtitle: v.model && v.model !== v.name ? v.model : t(lang, 'portal.vehicle'), section: 'skoda' }));
  },

  /** Built-in data handed over by GateControl (once, by an administrator). */
  async legacyImport(snapshot, gc) {
    state.importing = true;
    try {
      const out = await legacy.importSnapshot(snapshot, gc);
      resetCaches();
      return out;
    } finally { state.importing = false; }
  },

  /** Background: every <interval> minutes all accounts (backoff and login_failed respected). */
  async tick(gc) {
    if (state.importing) return;
    await service.pollTick(gc);
  },

  _state: state,
};
