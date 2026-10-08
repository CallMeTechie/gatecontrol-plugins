'use strict';

// gatecontrol-midea — Midea air conditioners (cloud and LAN) as a GateControl
// plugin (formerly built into GateControl: src/services/midea,
// routes/api/midea.js, the Klimaanlage page and its part of the portal tab
// "Zuhause").
//
//   admin API   (the plugin page; administrators only)
//     GET  /status · /cloud · /cloud/devices · /targets · /users · /devices
//     POST /cloud/connect · /discover · /devices
//     PUT  /devices/:id · /devices/:id/owners            DELETE /devices/:id
//     GET  /devices/:id/state   POST /devices/:id/state · /devices/:id/test
//   portal API  (the identified portal viewer — owner-scoped)
//     GET  /portal · /portal/devices/:id/state
//     POST /portal/devices/:id/state   control (the host lets only signed-in viewers change things)
//
// Requests run with the requesting user's rights: req.user.portal = a portal
// viewer, who only ever sees and controls what an administrator assigned to
// them; the admin API is reached only by administrators (the host's admin
// routes), and a portal viewer is refused there.

const ui = require('./ui');
const store = require('./store');
const service = require('./service');
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
  MIDEA_CLOUD_2FA_REQUIRED: [409, 'error.twofa'],
  MIDEA_CLOUD_RATE_LIMITED: [429, 'error.ratelimit'],
  MIDEA_CLOUD_NOT_CONFIGURED: [409, 'error.cloud_not_configured'],
  MIDEA_CLOUD_ERROR: [502, 'error.cloud'],
  MIDEA_CLOUD_UNREACHABLE: [502, 'error.cloud_unreachable'],
  MIDEA_CLOUD_NO_REPLY: [502, 'error.no_reply'],
  MIDEA_CLOUD_NO_TOKEN: [502, 'error.no_token'],
  MIDEA_CLOUD_NO_SESSION: [502, 'error.cloud'],
  MIDEA_EMAIL_PASSWORD_REQUIRED: [400, 'error.email_password_required'],
  MIDEA_DEVICE_EXISTS: [409, 'error.exists'],
  MIDEA_DEVICE_NOT_FOUND: [404, 'error.device_not_found'],
  MIDEA_NOT_IN_CLOUD: [404, 'error.not_in_cloud'],
  MIDEA_NO_TARGET: [400, 'error.no_target'],
  MIDEA_NO_CREDENTIALS: [409, 'error.no_credentials'],
  MIDEA_DISCOVERY_DENIED: [409, 'error.discovery_denied'],
  MIDEA_OWNER_UNKNOWN_USER: [400, 'error.owner_unknown_user'],
  MIDEA_USER_IDS_REQUIRED: [400, 'error.user_ids_required'],
  MIDEA_INVALID_PATCH: [400, 'error.invalid_patch'],
  MIDEA_NOT_OWNER: [403, 'error.not_owner'],
  MIDEA_OFFLINE: [502, 'error.offline'],
  MIDEA_INVALID: [400, 'error.invalid'],
  ERR_NET_DENIED: [400, 'error.target_denied'],
  ERR_NET: [502, 'error.unreachable'],
  FORBIDDEN: [403, 'error.forbidden'],
  NOT_FOUND: [404, 'error.not_found'],
};
// errors whose own message helps the administrator (Midea codes, LAN timeouts) — never secrets
const DETAIL = new Set(['MIDEA_CLOUD_ERROR', 'MIDEA_CLOUD_NO_SESSION', 'ERR_NET_DENIED', 'ERR_NET']);

function fail(code, detail) { return Object.assign(new Error(code), { code, detail }); }

function errorResponse(e, lang) {
  const known = e && ERRORS[e.code];
  const [status, key] = known || [502, 'error.device'];
  const json = { ok: false, code: (e && e.code) || null, error: t(lang, key) };
  const detail = !known || DETAIL.has(e.code) ? String((e && e.message) || '').replace(/[\0-\x1f\x7f]/g, ' ').slice(0, 200) : '';
  if (detail && detail !== e.code) json.detail = detail;
  return { status, json };
}

const posInt = (v) => {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d{1,10}$/.test(v) ? Number(v) : NaN);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const targetIndex = (v) => (Number.isInteger(v) && v >= 0 && v < 32 ? v : null);

const MODES = new Set(['auto', 'cool', 'heat', 'dry', 'fan']);
const FAN_SPEEDS = new Set([1, 20, 40, 60, 80, 100, 102]); // percent steps like the Midea app (1–100, 100 = max) + auto (102)
/**
 * Whitelist + range/type check; a clean patch or null (→ 400). At least one
 * valid field. Swing only from the admin page (the portal never offered it).
 */
function validatePatch(raw, { swing = false } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const patch = {};
  const bool = (k) => { if (k in raw) { if (typeof raw[k] !== 'boolean') return false; patch[k] = raw[k]; } return true; };
  if (!bool('power') || !bool('turbo') || !bool('eco')) return null;
  if (swing && (!bool('swingV') || !bool('swingH'))) return null;
  if ('targetTemp' in raw) { const v = Number(raw.targetTemp); if (typeof raw.targetTemp === 'boolean' || !Number.isFinite(v) || v < 16 || v > 30) return null; patch.targetTemp = v; }
  if ('mode' in raw) { if (!MODES.has(raw.mode)) return null; patch.mode = raw.mode; }
  if ('fanSpeed' in raw) { if (!FAN_SPEEDS.has(raw.fanSpeed)) return null; patch.fanSpeed = raw.fanSpeed; }
  return Object.keys(patch).length ? patch : null;
}

// ─── Views ──────────────────────────────────────

async function usersById(gc) {
  const m = new Map();
  try { for (const u of await gc.users.list()) m.set(u.id, { id: u.id, username: u.name, role: u.role }); } catch { /* users unavailable */ }
  return m;
}

/** Portal: only the controllable surface — never the target, cloud ids or keys. */
function portalDevice(d, st) {
  return { id: d.id, name: d.name, transport: d.transport, state: st || null };
}

async function ownedDevices(gc, userId) {
  const ids = new Set(await store.devicesOwnedBy(gc, userId));
  if (!ids.size) return [];
  return (await store.listDevices(gc)).filter((d) => ids.has(d.id));
}

// ─── Portal Start tiles and search (declarative; the host renders them) ──

const AC_ICON = 'M2 4h20v10H2zM6 9h12M6 18v1M10 18v2M14 18v2M18 18v1';

function fmtTemp(v, lang) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString(lang === 'en' ? 'en-GB' : 'de-DE', { maximumFractionDigits: 1 }) : null;
}

function statusLine(st, lang) {
  if (!st) return null;
  if (st.offline) return t(lang, 'portal.offline');
  if (!st.power) return t(lang, 'portal.power_off');
  const mode = t(lang, 'portal.mode_' + (MODES.has(st.mode) ? st.mode : 'auto'));
  const target = fmtTemp(st.targetTemp, lang);
  return target ? `${mode} · ${t(lang, 'portal.target')} ${target} °C` : mode;
}

function deviceTile(d, st, lang) {
  const tile = { section: 'midea', title: d.name || '', value: statusLine(st, lang) || '–', unit: null, state: null, icon: AC_ICON };
  if (st && st.offline) tile.state = 'warn';
  else if (st) tile.state = st.power ? 'on' : 'off';
  return tile;
}

// ─── Routes ─────────────────────────────────────

async function portalRoute(req, gc, seg) {
  const user = req.user;
  if (req.method === 'GET' && seg.length === 1) {
    const devices = await ownedDevices(gc, user.id);
    // parallel live state — a device being offline never aborts the list
    const states = await Promise.all(devices.map((d) => service.getState(gc, d.id).catch(() => ({ offline: true }))));
    return { json: { ok: true, devices: devices.map((d, i) => portalDevice(d, states[i])) } };
  }
  if (seg[1] === 'devices' && seg[3] === 'state' && seg.length === 4) {
    const id = posInt(seg[2]);
    if (!id) throw fail('NOT_FOUND');
    if (!(await store.isOwner(gc, id, user.id))) throw fail('MIDEA_NOT_OWNER');
    if (req.method === 'GET') return { json: { ok: true, state: await service.getState(gc, id) } };
    if (req.method === 'POST') {
      const patch = validatePatch(req.body && req.body.patch);
      if (!patch) throw fail('MIDEA_INVALID_PATCH');
      const st = await service.setState(gc, id, patch);
      if (!st || st.offline) throw fail('MIDEA_OFFLINE');
      return { json: { ok: true, state: st } };
    }
  }
  throw fail('NOT_FOUND');
}

async function adminRoute(req, gc, seg) {
  const m = req.method;
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const [a, b, c] = seg;

  if (a === 'status' && seg.length === 1 && m === 'GET') {
    const cloud = store.redactConfig(await store.loadConfig(gc));
    return { json: { ok: true, ...(await service.getStatus(gc)), cloud: { ...cloud, configured: Boolean(cloud.email) } } };
  }
  if (a === 'targets' && seg.length === 1 && m === 'GET') return { json: { ok: true, targets: await service.acTargets(gc) } };
  if (a === 'users' && seg.length === 1 && m === 'GET') return { json: { ok: true, users: [...(await usersById(gc)).values()] } };
  if (a === 'discover' && seg.length === 1 && m === 'POST') return { json: { ok: true, devices: await service.discoverLan(gc) } };

  if (a === 'cloud') {
    if (seg.length === 1 && m === 'GET') {
      const cloud = store.redactConfig(await store.loadConfig(gc));
      return { json: { ok: true, cloud: { ...cloud, configured: Boolean(cloud.email) } } };
    }
    if (b === 'connect' && seg.length === 2 && m === 'POST') {
      const email = typeof body.email === 'string' ? body.email.trim().slice(0, 200) : '';
      const password = typeof body.password === 'string' ? body.password.slice(0, 500) : '';
      if (!email || !password) throw fail('MIDEA_EMAIL_PASSWORD_REQUIRED');
      const app = body.app === undefined ? 'msmarthome' : body.app;
      if (!store.APPS.has(app)) throw fail('MIDEA_INVALID');
      return { json: { ...(await service.connectCloud(gc, email, password, app)), ok: true } };
    }
    if (b === 'devices' && seg.length === 2 && m === 'GET') return { json: { ok: true, devices: await service.listCloudDevices(gc) } };
    throw fail('NOT_FOUND');
  }

  if (a === 'devices') {
    if (seg.length === 1 && m === 'GET') {
      const users = await usersById(gc);
      const owners = await store.allOwners(gc);
      const targets = await service.acTargets(gc).catch(() => []);
      const devices = [];
      for (const d of await store.listDevices(gc)) {
        const tg = d.target_index == null ? null : targets.find((x) => x.index === d.target_index);
        devices.push({
          ...d,
          target_label: tg ? tg.label : null,
          has_credentials: d.protocol_version === 3 && d.transport === 'lan' ? Boolean(await store.credentialsOf(gc, d.id)) : false,
          owners: (owners.get(d.id) || []).filter((uid) => users.has(uid)).map((uid) => users.get(uid)),
        });
      }
      return { json: { ok: true, devices } };
    }
    if (seg.length === 1 && m === 'POST') {
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : '';
      const str = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 100) : null);
      if (body.transport === 'cloud') {
        const id = str(body.cloud_appliance_id) || (typeof body.cloud_appliance_id === 'number' ? String(body.cloud_appliance_id) : null);
        if (!id || !/^[0-9A-Za-z_-]{1,40}$/.test(id)) throw fail('MIDEA_INVALID');
        return { json: { ok: true, device: await service.addDevice(gc, { transport: 'cloud', cloud_appliance_id: id, name }) } };
      }
      const index = targetIndex(body.target_index);
      if (index == null) throw fail('MIDEA_NO_TARGET');
      return { json: { ok: true, device: await service.addDevice(gc, { transport: 'lan', target_index: index, sn: str(body.sn), name }) } };
    }
    const id = posInt(b);
    if (!id) throw fail('NOT_FOUND');
    const d = await store.getDevice(gc, id);
    if (!d) throw fail('MIDEA_DEVICE_NOT_FOUND');
    if (seg.length === 2 && m === 'PUT') {
      const patch = {};
      if (body.name !== undefined) { if (typeof body.name !== 'string' || !body.name.trim()) throw fail('MIDEA_INVALID'); patch.name = body.name.trim().slice(0, 100); }
      if (body.enabled !== undefined) { if (typeof body.enabled !== 'boolean') throw fail('MIDEA_INVALID'); patch.enabled = body.enabled; }
      if (body.target_index !== undefined) {
        if (d.transport === 'cloud') throw fail('MIDEA_INVALID');
        if (body.target_index !== null) {
          const assigned = await service.acTargets(gc);
          if (targetIndex(body.target_index) == null || !assigned.some((x) => x.index === body.target_index)) throw fail('MIDEA_NO_TARGET');
        }
        patch.target_index = body.target_index;
      }
      return { json: { ok: true, device: await store.updateDevice(gc, id, patch) } };
    }
    if (seg.length === 2 && m === 'DELETE') return { json: await service.removeDevice(gc, id) };
    if (seg.length === 3 && c === 'owners' && m === 'PUT') {
      const raw = body.user_ids !== undefined ? body.user_ids : body.userIds;
      if (!Array.isArray(raw) || raw.length > 1000) throw fail('MIDEA_USER_IDS_REQUIRED');
      const ids = await store.setOwners(gc, id, raw);
      const users = await usersById(gc);
      return { json: { ok: true, device_id: id, owners: ids.filter((uid) => users.has(uid)).map((uid) => users.get(uid)) } };
    }
    if (seg.length === 3 && c === 'state' && m === 'GET') return { json: { ok: true, state: await service.getState(gc, id) } };
    if (seg.length === 3 && c === 'state' && m === 'POST') {
      const patch = validatePatch(body.patch && typeof body.patch === 'object' ? body.patch : body, { swing: true });
      if (!patch) throw fail('MIDEA_INVALID_PATCH');
      return { json: { ok: true, state: await service.setState(gc, id, patch) } };
    }
    if (seg.length === 3 && c === 'test' && m === 'POST') return { json: { ...(await service.testConnection(gc, id)), ok: true } };
    throw fail('NOT_FOUND');
  }

  throw fail('NOT_FOUND');
}

module.exports = {
  async start(gc) {
    service.reset();
    gc.log.info('midea started', gc.plugin.version);
  },

  async request(req, gc) {
    const lang = req.lang;
    try {
      const seg = String(req.path || '/').split('/').filter(Boolean);
      if (!seg.length) throw fail('NOT_FOUND');
      if (seg[0] === 'portal') {
        if (!req.user || !Number.isInteger(req.user.id)) throw fail('FORBIDDEN');
        return await portalRoute(req, gc, seg);
      }
      // admin API: administrators only, never a portal viewer
      if (!req.user || req.user.portal || req.user.role !== 'admin') throw fail('FORBIDDEN');
      return await adminRoute(req, gc, seg);
    } catch (e) {
      if (!ERRORS[e && e.code]) gc.log.warn('request failed', req.method, req.path, (e && (e.code || e.message)) || e);
      return errorResponse(e, lang);
    }
  },

  async render(view, gc) {
    return { html: ui.render(view, t) };
  },

  /** The section in the portal tab "Zuhause" only for viewers with air conditioners assigned to them. */
  async portalVisible({ user }, gc) {
    if (!user) return false;
    return (await store.devicesOwnedBy(gc, user.id)).length > 0;
  },

  /** Start tab: up to four of the viewer's air conditioners (cached state only — no device round trip). */
  async portalTiles({ user, lang }, gc) {
    if (!user) return [];
    return (await ownedDevices(gc, user.id)).slice(0, 4).map((d) => deviceTile(d, service.cachedState(gc, d), lang));
  },

  /** Portal search: the viewer's own air conditioners by name. */
  async portalSearch({ user, lang, q }, gc) {
    if (!user || typeof q !== 'string' || q.length < 2) return [];
    const needle = q.toLowerCase();
    return (await ownedDevices(gc, user.id)).filter((d) => String(d.name || '').toLowerCase().includes(needle)).slice(0, 10)
      .map((d) => ({ title: d.name, subtitle: statusLine(service.cachedState(gc, d), lang) || t(lang, 'portal.title'), section: 'midea' }));
  },

  /** Built-in data handed over by GateControl (once, by an administrator). */
  async legacyImport(snapshot, gc) {
    state.importing = true;
    try {
      const out = await legacy.importSnapshot(snapshot, gc);
      service.reset();
      return out;
    } finally { state.importing = false; }
  },

  /** Background: the LAN devices' state every 30 seconds (cloud devices only on demand, as before). */
  async tick(gc) {
    if (state.importing) return;
    await service.pollTick(gc);
  },

  _state: state,
  _validatePatch: validatePatch,
};
