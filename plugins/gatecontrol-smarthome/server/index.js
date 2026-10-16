'use strict';

// gatecontrol-smarthome — Phoscon/deCONZ Smart Home as a GateControl plugin
// (formerly built into GateControl: src/services/smarthome, routes/api/smarthome.js,
// the Smart Home pages and the portal part of "Zuhause").
//
//   admin API   (Settings → Plugins, the plugin pages; administrators only)
//     GET  /gateways · /targets · /resources[?gateway_id] · /users
//     POST /gateways · /gateways/:id/sync · /gateways/:id/test · /resources/:id/state
//     PUT  /gateways/:id · /resources/:id/owners        DELETE /gateways/:id
//     GET  /rules?gateway_id · /rules/gateway-count?gateway_id
//     POST /rules · /rules/:id/enabled   PUT /rules/:id   DELETE /rules/:id
//   portal API  (the identified portal viewer — owner-scoped)
//     GET  /portal                     own devices and sensors
//     POST /portal/resources/:id/state control (the host lets only signed-in viewers change things)
//   quick actions of the GateControl apps (hooks quickActions / runQuickAction)
//     the same owner scope as the portal: a toggle per own light, plug and
//     group, a button per scene of an own group; dimmable lights and groups
//     carry a widget (brightness as the value, a brightness slider); the toggles
//     declare their verbs and honour a target state (GateControl ≥ 1.173.0:
//     `target` 'on'|'off' sets that state, never switches over)
//
// Requests run with the requesting user's rights: req.user.portal = a portal
// viewer, who only ever sees and controls what an administrator assigned to
// them; the admin API is reached only by administrators (the host's admin
// routes), and a portal viewer is refused there.

const ui = require('./ui');
const store = require('./store');
const service = require('./service');
const rules = require('./rules');
const legacy = require('./legacy');
const alerts = require('./alerts');
const deconzCaps = require('./caps');
const { validApiKey } = require('./deconz');
const texts = require('./texts.json');

const state = { lastSync: 0, resynced: false, importing: false };

function t(lang, key, params) {
  const l = lang === 'en' ? 'en' : 'de';
  let s = (texts[l] && texts[l][key]) || texts.de[key] || key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{{${k}}}`).join(String(v));
  return s;
}

// error code → [HTTP status, text key]
const ERRORS = {
  DECONZ_LINK_BUTTON_NOT_PRESSED: [409, 'error.link_button'],
  SMARTHOME_NO_TARGET: [400, 'error.no_target'],
  SMARTHOME_TARGET_DENIED: [400, 'error.target_denied'],
  SMARTHOME_NO_API_KEY: [409, 'error.no_api_key'],
  SMARTHOME_INVALID_KEY: [400, 'error.invalid_key'],
  SMARTHOME_GATEWAY_NOT_FOUND: [404, 'error.gateway_not_found'],
  SMARTHOME_RESOURCE_NOT_FOUND: [404, 'error.resource_not_found'],
  SMARTHOME_NOT_ASSIGNABLE: [400, 'error.not_assignable'],
  SMARTHOME_OWNER_UNKNOWN_USER: [400, 'error.owner_unknown_user'],
  SMARTHOME_USER_IDS_REQUIRED: [400, 'error.user_ids_required'],
  SMARTHOME_NOT_CONTROLLABLE: [400, 'error.not_controllable'],
  SMARTHOME_INVALID_PATCH: [400, 'error.invalid_patch'],
  SMARTHOME_NOT_OWNER: [403, 'error.not_owner'],
  SMARTHOME_RULE_INVALID: [400, 'error.rule_invalid'],
  SMARTHOME_RULE_NOT_FOUND: [404, 'error.rule_not_found'],
  DECONZ_RULE_LIMIT_REACHED: [409, 'error.rule_limit_reached'],
  DECONZ_UNREACHABLE: [502, 'error.unreachable'],
  FORBIDDEN: [403, 'error.forbidden'],
  NOT_FOUND: [404, 'error.not_found'],
  INVALID: [400, 'error.invalid'],
};

function fail(code, detail) { return Object.assign(new Error(code), { code, detail }); }

function errorResponse(e, lang) {
  const known = e && ERRORS[e.code];
  const [status, key] = known || [502, 'common.error'];
  const json = { ok: false, code: (e && e.code) || null, error: t(lang, key) };
  if (e && e.code === 'SMARTHOME_RULE_INVALID' && typeof e.detail === 'string') json.detail = e.detail;
  return { status, json };
}

const posInt = (v) => {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d{1,10}$/.test(v) ? Number(v) : NaN);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// ─── Views ──────────────────────────────────────

function gatewayView(g, targets, keys) {
  const tg = targets.find((a) => a.index === g.target_index);
  return { id: g.id, name: g.name, target_index: g.target_index, target_label: tg ? tg.label : null, enabled: g.enabled, last_seen_at: g.last_seen_at, has_key: keys.has(g.id) };
}

async function usersById(gc) {
  const m = new Map();
  try { for (const u of await gc.users.list()) m.set(u.id, { id: u.id, username: u.name }); } catch { /* users unavailable */ }
  return m;
}

const STATE_KEYS = new Set(['on', 'bri', 'reachable', 'type', 'value']);
/** Portal: only the controllable surface — never gateway, target or deCONZ internals. */
function portalResource(r) {
  const st = {};
  for (const [k, v] of Object.entries(r.state || {})) if (STATE_KEYS.has(k)) st[k] = v;
  return { id: r.id, kind: r.kind, name: r.name, capabilities: r.capabilities || {}, state: st };
}

/** Portal patch: on (boolean) and bri (0-100, with the capability); scenes take {}. */
function portalPatch(raw, caps) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const patch = {};
  if ('on' in raw) { if (typeof raw.on !== 'boolean') return null; patch.on = raw.on; }
  if ('bri' in raw && caps && caps.bri) {
    if (typeof raw.bri !== 'number' || !Number.isFinite(raw.bri) || raw.bri < 0 || raw.bri > 100) return null;
    patch.bri = raw.bri;
  }
  const colour = caps && (caps.color === 'hs' || caps.color === 'xy');
  const temp = caps && (caps.color === 'ct' || caps.ct);
  for (const [k, lo, hi, ok] of [['hue', 0, 65535, colour], ['sat', 0, 254, colour], ['ct', 153, 500, temp]]) {
    if (!(k in raw) || !ok) continue;
    if (typeof raw[k] !== 'number' || !Number.isFinite(raw[k]) || raw[k] < lo || raw[k] > hi) return null;
    patch[k] = raw[k];
  }
  return patch;
}

/** The viewer's resources (owned, enabled; scenes of an owned group), as stored. */
async function ownedResources(gc, userId) {
  const ids = new Set(await store.resourcesOwnedBy(gc, userId));
  if (!ids.size) return [];
  return (await store.listResources(gc)).filter((r) => r.enabled && ids.has(r.id));
}

async function portalData(gc, userId) {
  const owned = await ownedResources(gc, userId);
  return {
    devices: owned.filter((r) => r.kind !== 'sensor' && r.kind !== 'switch').map(portalResource),
    sensors: owned.filter((r) => r.kind === 'sensor').map(portalResource), // switches stay out
  };
}

// ─── Portal Start tiles and search (declarative; the host renders them) ──

const TILE_ICONS = {
  light: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.8.8 1 1.5 1 2.5h6c0-1 .2-1.7 1-2.5A6 6 0 0 0 12 3z',
  plug: 'M9 2v5M15 2v5M7 7h10v3a5 5 0 0 1-10 0zM12 15v7',
  group: 'M3 11l9-7 9 7M5 10v10h14V10',
  temperature: 'M10 13V5a2 2 0 1 1 4 0v8a4 4 0 1 1-4 0z',
  water: 'M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z',
  humidity: 'M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11zM9 14a3 3 0 0 0 3 3',
  open: 'M4 3h16v18H4zM14 3v18',
  sensor: 'M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4',
};

function fmtNum(v, lang) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString(lang === 'en' ? 'en-GB' : 'de-DE', { maximumFractionDigits: 1 }) : null;
}

function kindLabel(r, lang) {
  if (r.kind === 'sensor') return t(lang, 'sensor.' + ((r.state && r.state.type) || (r.capabilities && r.capabilities.reading) || 'unknown'));
  return t(lang, 'kind.' + r.kind);
}

function deviceTile(d, lang) {
  const st = d.state || {};
  let value = st.on ? t(lang, 'portal.on') : t(lang, 'portal.off');
  if (st.on && d.capabilities && d.capabilities.bri && st.bri != null) value += ' · ' + fmtNum(st.bri, lang) + ' %';
  return { section: 'smarthome', title: d.name || '', value, state: st.on ? 'on' : 'off', icon: TILE_ICONS[d.kind] || TILE_ICONS.light };
}

function sensorTile(s, lang) {
  const st = s.state || {};
  const v = st.value;
  const tile = { section: 'smarthome', title: s.name || '', value: '–', unit: null, state: null, icon: TILE_ICONS[st.type] || TILE_ICONS.sensor };
  if (v === null || v === undefined || v === '') return tile;
  switch (st.type) {
    case 'temperature': return { ...tile, value: fmtNum(v, lang), unit: '°C' };
    case 'humidity': return { ...tile, value: fmtNum(v, lang), unit: '%' };
    case 'lightlevel': return { ...tile, value: fmtNum(v, lang), unit: 'lx' };
    case 'open': return { ...tile, value: t(lang, v ? 'portal.open' : 'portal.closed'), state: v ? 'warn' : 'good' };
    case 'presence': return { ...tile, value: t(lang, v ? 'portal.motion' : 'portal.no_motion') };
    case 'water': return { ...tile, value: t(lang, v ? 'portal.wet' : 'portal.dry'), state: v ? 'crit' : 'good' };
    default: return tile;
  }
}

// ─── Quick actions of the apps (declarative; the host checks and caps them) ──

const QA_MAX = 16;
const QA_ID_RE = /^(light|plug|group|scene):([1-9][0-9]{0,9})$/;
const SCENE_ICON = 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z';

/** A text as the host takes it unchanged: no control characters, trimmed, at most `max` UTF-16 units. */
function clip(v, max) {
  let s = String(v == null ? '' : v).replace(/[\0-\x1f\x7f]/g, ' ').trim();
  if (s.length > max) s = s.slice(0, max).replace(/[\ud800-\udbff]$/, '').trimEnd();
  return s;
}

const BRI = { min: 1, max: 100, step: 1, fallback: 100 };

/** Whether a resource's quick action carries a widget: a dimmable light or group (never a plug or a scene). */
function dimmable(r) {
  return (r.kind === 'light' || r.kind === 'group') && Boolean(r.capabilities && r.capabilities.bri);
}

/**
 * The widget of a dimmable light or group (GateControl ≥ 1.171.0; older hosts
 * leave it out): the brightness as the value while on ("Off" otherwise), the
 * kind and reachability as the status, a brightness slider.
 */
function widgetOf(r, lang) {
  const st = r.state || {};
  const bri = st.bri == null || !Number.isFinite(Number(st.bri)) ? null : Math.min(BRI.max, Math.max(BRI.min, Math.round(Number(st.bri))));
  let status = t(lang, 'kind.' + r.kind);
  if (st.reachable === false) status += ' · ' + t(lang, 'qa.unreachable');
  const w = { label: clip(t(lang, 'portal.brightness'), 24), value: t(lang, 'portal.off'), unit: null, status: clip(status, 60), state: st.on ? 'on' : 'off', controls: [] };
  if (st.on) {
    if (bri != null) { w.value = bri; w.unit = '%'; } else w.value = t(lang, 'portal.on');
  }
  w.controls.push({ id: 'bri', kind: 'slider', label: clip(t(lang, 'portal.brightness'), 20), value: bri == null ? BRI.fallback : bri, min: BRI.min, max: BRI.max, step: BRI.step, unit: '%' });
  return w;
}

/** A resource as the apps group quick actions (GateControl ≥ 1.172.0): r:<resource id>, its name and icon. */
function deviceOf(r, lang) {
  return { id: `r:${r.id}`, title: clip(r.name, 40) || t(lang, 'kind.' + r.kind), icon: r.kind === 'scene' ? SCENE_ICON : (TILE_ICONS[r.kind] || TILE_ICONS.light) };
}

/** `device`: the resource's own, for a scene its group's (when the viewer has that group). */
function quickAction(r, lang, device) {
  const name = clip(r.name, 40) || t(lang, 'kind.' + r.kind);
  if (r.kind === 'scene') return { id: `scene:${r.id}`, title: name, subtitle: t(lang, 'kind.scene'), icon: SCENE_ICON, kind: 'button', device: device || deviceOf(r, lang) };
  const st = r.state || {};
  let subtitle = t(lang, 'kind.' + r.kind);
  if (st.reachable === false) subtitle += ' · ' + t(lang, 'qa.unreachable');
  else if (st.on && r.capabilities && r.capabilities.bri && st.bri != null) subtitle += ' · ' + fmtNum(st.bri, lang) + ' %';
  const a = {
    id: `${r.kind}:${r.id}`, title: name, subtitle: clip(subtitle, 60), icon: TILE_ICONS[r.kind] || TILE_ICONS.light, kind: 'toggle', state: st.on ? 'on' : 'off',
    device: device || deviceOf(r, lang), verbs: { on: t(lang, 'qa.verb_on'), off: t(lang, 'qa.verb_off') }, targets: true,
  };
  if (dimmable(r)) a.widget = widgetOf(r, lang);
  return a;
}

/** The deCONZ group of a scene on its gateway: "<gateway id>/<group id>" (capabilities.group_id, else the id's prefix). */
function sceneGroupKey(r) {
  const gid = r.capabilities && r.capabilities.group_id != null ? r.capabilities.group_id : String(r.deconz_id).split('/')[0];
  return `${r.gateway_id}/${gid}`;
}

/**
 * The viewer's own controllable devices (exactly the portal's devices: owned,
 * enabled, scenes of an owned group) as quick actions — cached state only,
 * no gateway round trip. Switches first (groups, lights, plugs), scenes last.
 * Every resource is its own device (r:<id>); a scene belongs to its group's
 * device when the viewer has that group, else it is a device of its own.
 */
async function quickActionsFor(gc, user, lang) {
  if (!user || !Number.isInteger(user.id) || user.loggedIn === false) return [];
  const devices = (await ownedResources(gc, user.id)).filter((r) => r.kind !== 'sensor' && r.kind !== 'switch');
  const groups = new Map(devices.filter((r) => r.kind === 'group').map((g) => [`${g.gateway_id}/${g.deconz_id}`, g]));
  const toggles = devices.filter((d) => d.kind !== 'scene');
  const scenes = devices.filter((d) => d.kind === 'scene');
  return [...toggles, ...scenes].slice(0, QA_MAX).map((d) => {
    const group = d.kind === 'scene' ? groups.get(sceneGroupKey(d)) : null;
    return quickAction(d, lang, group ? deviceOf(group, lang) : null);
  });
}

/** The widget of a dimmable resource after a change (the cached state follows what was sent). */
async function widgetAfter(gc, r, lang) {
  if (!dimmable(r)) return undefined;
  const now = await store.getResource(gc, r.id);
  return widgetOf(now || r, lang);
}

/**
 * Run one quick action with the portal's checks (owner, enabled, controllable).
 * A toggle switches over; with a target ('on' | 'off', GateControl ≥ 1.173.0)
 * it sets that state, whatever the cached state says. With a control
 * (GateControl ≥ 1.171.0): `bri` sets the brightness of a dimmable light or
 * group and switches it on. A dimmable resource's answer carries its widget.
 */
async function runQuickActionFor(gc, user, lang, id, control, value, target) {
  const m = typeof id === 'string' ? QA_ID_RE.exec(id) : null;
  if (!m || !user || !Number.isInteger(user.id) || user.loggedIn === false) return { ok: false, message: t(lang, 'qa.unknown') };
  const rid = Number(m[2]);
  let r = null;
  try {
    if (!(await store.canAccess(gc, rid, user.id))) throw fail('SMARTHOME_NOT_OWNER');
    r = await store.getResource(gc, rid);
    if (!r || !r.enabled || r.kind !== m[1]) throw fail('SMARTHOME_RESOURCE_NOT_FOUND');
    const name = clip(r.name, 40);
    if (control !== undefined) {
      const bri = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : NaN;
      if (control !== 'bri' || !dimmable(r) || !(bri >= BRI.min && bri <= BRI.max)) return { ok: false, message: t(lang, 'qa.unknown') };
      await service.setResourceState(gc, rid, { bri, on: true });
      return { ok: true, message: null, state: 'on', widget: await widgetAfter(gc, r, lang) };
    }
    if (r.kind === 'scene') {
      await service.setResourceState(gc, rid, {});
      return { ok: true, message: clip(t(lang, 'portal.scene_done', { name }), 120) };
    }
    const on = target === 'on' || target === 'off' ? target === 'on' : !(r.state && r.state.on);
    await service.setResourceState(gc, rid, { on });
    const out = { ok: true, message: clip(t(lang, on ? 'qa.switched_on' : 'qa.switched_off', { name }), 120), state: on ? 'on' : 'off' };
    const widget = await widgetAfter(gc, r, lang);
    if (widget) out.widget = widget;
    return out;
  } catch (e) {
    if (!ERRORS[e && e.code]) gc.log.warn('quick action failed', id, (e && (e.code || e.message)) || e);
    const out = { ok: false, message: errorResponse(e, lang).json.error };
    if (r && dimmable(r)) out.widget = widgetOf(r, lang);
    return out;
  }
}

// ─── Routes ─────────────────────────────────────

async function portalRoute(req, gc, seg) {
  const user = req.user;
  if (req.method === 'GET' && seg.length === 1) return { json: { ok: true, ...(await portalData(gc, user.id)) } };
  if (req.method === 'POST' && seg[1] === 'resources' && seg[3] === 'state' && seg.length === 4) {
    const id = posInt(seg[2]);
    if (!id) throw fail('NOT_FOUND');
    if (!(await store.canAccess(gc, id, user.id))) throw fail('SMARTHOME_NOT_OWNER');
    const resource = await store.getResource(gc, id);
    if (!resource || !resource.enabled) throw fail('SMARTHOME_RESOURCE_NOT_FOUND');
    if (resource.kind === 'sensor' || resource.kind === 'switch') throw fail('SMARTHOME_NOT_CONTROLLABLE');
    const patch = portalPatch(req.body && req.body.patch, resource.capabilities);
    if (patch === null) throw fail('SMARTHOME_INVALID_PATCH');
    await service.setResourceState(gc, id, patch);
    return { json: { ok: true } };
  }
  throw fail('NOT_FOUND');
}

function gatewayIdQuery(req) {
  const id = posInt(req.query && req.query.gateway_id);
  if (!id) throw fail('SMARTHOME_RULE_INVALID', 'missing_gateway_id');
  return id;
}

async function adminRoute(req, gc, seg) {
  const m = req.method;
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const [a, b, c] = seg;

  if (a === 'targets' && seg.length === 1 && m === 'GET') return { json: { ok: true, targets: await service.gatewayTargets(gc) } };

  if (a === 'users' && seg.length === 1 && m === 'GET') {
    return { json: { ok: true, users: [...(await usersById(gc)).values()] } };
  }

  if (a === 'gateways') {
    if (seg.length === 1 && m === 'GET') {
      const targets = await service.gatewayTargets(gc);
      const list = await store.listGateways(gc);
      const keys = new Set();
      for (const g of list) if (await store.apiKeyOf(gc, g.id)) keys.add(g.id);
      return { json: { ok: true, gateways: list.map((g) => gatewayView(g, targets, keys)) } };
    }
    if (seg.length === 1 && m === 'POST') {
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : '';
      const index = Number.isInteger(body.target_index) && body.target_index >= 0 && body.target_index < 32 ? body.target_index : null;
      if (!name || index == null) throw fail('INVALID');
      if (body.apiKey != null && body.apiKey !== '' && typeof body.apiKey !== 'string') throw fail('INVALID');
      const gw = await service.connectGateway(gc, { name, target_index: index, apiKey: body.apiKey ? body.apiKey.trim() : null });
      return { json: { ok: true, gateway: { id: gw.id, name: gw.name, target_index: gw.target_index, enabled: gw.enabled } } };
    }
    const id = posInt(b);
    if (!id) throw fail('NOT_FOUND');
    const gw = await store.getGateway(gc, id);
    if (!gw) throw fail('SMARTHOME_GATEWAY_NOT_FOUND');
    if (seg.length === 2 && m === 'PUT') {
      const patch = {};
      if (body.name !== undefined) { if (typeof body.name !== 'string' || !body.name.trim()) throw fail('INVALID'); patch.name = body.name.trim().slice(0, 100); }
      if (body.target_index !== undefined) {
        if (body.target_index !== null && !(Number.isInteger(body.target_index) && body.target_index >= 0 && body.target_index < 32)) throw fail('INVALID');
        patch.target_index = body.target_index;
      }
      if (body.enabled !== undefined) { if (typeof body.enabled !== 'boolean') throw fail('INVALID'); patch.enabled = body.enabled; }
      if (body.apiKey !== undefined && body.apiKey !== '') {
        if (typeof body.apiKey !== 'string' || !validApiKey(body.apiKey.trim())) throw fail('SMARTHOME_INVALID_KEY');
        patch.apiKey = body.apiKey.trim();
      }
      const g = await store.updateGateway(gc, id, patch);
      return { json: { ok: true, gateway: { id: g.id, name: g.name, target_index: g.target_index, enabled: g.enabled, last_seen_at: g.last_seen_at } } };
    }
    if (seg.length === 2 && m === 'DELETE') return { json: await store.removeGateway(gc, id) };
    if (seg.length === 3 && c === 'sync' && m === 'POST') return { json: { ok: true, ...(await service.syncGateway(gc, id)) } };
    if (seg.length === 3 && c === 'test' && m === 'POST') return { json: { ok: true, ...(await service.testGateway(gc, id)) } };
    throw fail('NOT_FOUND');
  }

  if (a === 'resources') {
    if (seg.length === 1 && m === 'GET') {
      const gid = req.query && req.query.gateway_id ? posInt(req.query.gateway_id) : null;
      const users = await usersById(gc);
      const owners = await store.allOwners(gc);
      const list = await store.listResources(gc, gid || undefined);
      const resources = [];
      for (const r of list) {
        const ids = r.kind === 'scene' ? await store.inheritedOwnerIdsOf(gc, r) : (owners.get(r.id) || []);
        resources.push({ ...r, owners: ids.filter((uid) => users.has(uid)).map((uid) => users.get(uid)) });
      }
      return { json: { ok: true, resources } };
    }
    const id = posInt(b);
    if (!id) throw fail('NOT_FOUND');
    if (seg.length === 3 && c === 'owners' && m === 'PUT') {
      if (!Array.isArray(body.userIds) || body.userIds.length > 1000) throw fail('SMARTHOME_USER_IDS_REQUIRED');
      const ids = await store.setOwners(gc, id, body.userIds);
      const users = await usersById(gc);
      return { json: { ok: true, resource_id: id, owners: ids.filter((uid) => users.has(uid)).map((uid) => users.get(uid)) } };
    }
    if (seg.length === 3 && c === 'state' && m === 'POST') {
      const patch = body.patch && typeof body.patch === 'object' && !Array.isArray(body.patch) ? body.patch : body;
      await service.setResourceState(gc, id, patch);
      return { json: { ok: true } };
    }
    throw fail('NOT_FOUND');
  }

  if (a === 'rules') {
    if (seg.length === 1 && m === 'GET') {
      const list = await rules.list(gc, gatewayIdQuery(req));
      return { json: { ok: true, rules: list, gc_rule_count: list.length, limit_warn: rules.limitWarn(list.length), cancelSupported: deconzCaps.cancelSupported } };
    }
    if (seg.length === 2 && b === 'gateway-count' && m === 'GET') return { json: { ok: true, ...(await rules.gatewayRuleCount(gc, gatewayIdQuery(req))) } };
    if (seg.length === 1 && m === 'POST') {
      const gid = posInt(body.gateway_id);
      if (!gid || typeof body.name !== 'string' || !body.name || !body.definition || typeof body.definition !== 'object') throw fail('SMARTHOME_RULE_INVALID', 'missing_fields');
      return { json: { ok: true, rule: await rules.create(gc, gid, body.name, body.definition) } };
    }
    const id = posInt(b);
    if (!id) throw fail('NOT_FOUND');
    if (seg.length === 2 && m === 'PUT') {
      if (typeof body.name !== 'string' || !body.name || !body.definition || typeof body.definition !== 'object') throw fail('SMARTHOME_RULE_INVALID', 'missing_fields');
      return { json: { ok: true, rule: await rules.update(gc, id, body.name, body.definition) } };
    }
    if (seg.length === 2 && m === 'DELETE') { await rules.remove(gc, id); return { json: { ok: true } }; }
    if (seg.length === 3 && c === 'enabled' && m === 'POST') {
      if (typeof body.enabled !== 'boolean') throw fail('INVALID');
      return { json: { ok: true, rule: await rules.setEnabled(gc, id, body.enabled) } };
    }
    throw fail('NOT_FOUND');
  }

  throw fail('NOT_FOUND');
}

module.exports = {
  async start(gc) {
    state.lastSync = 0;
    state.resynced = false;
    alerts.reset();
    gc.log.info('smarthome started', gc.plugin.version);
  },

  async request(req, gc) {
    const lang = req.lang;
    try {
      const seg = String(req.path || '/').split('/').filter(Boolean);
      if (!seg.length) throw fail('NOT_FOUND');
      if (seg[0] === 'portal') return await portalRoute(req, gc, seg);
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

  /** The section in the portal tab "Zuhause" only for viewers with devices assigned to them. */
  async portalVisible({ user }, gc) {
    if (!user) return false;
    return (await store.resourcesOwnedBy(gc, user.id)).length > 0;
  },

  /** Start tab: up to four of the viewer's devices and three sensor values (declarative, rendered by the host). */
  async portalTiles({ user, lang }, gc) {
    if (!user) return [];
    const { devices, sensors } = await portalData(gc, user.id);
    return [
      ...devices.filter((d) => d.kind !== 'scene').slice(0, 4).map((d) => deviceTile(d, lang)),
      ...sensors.slice(0, 3).map((s) => sensorTile(s, lang)),
    ];
  },

  /** Portal search: the viewer's own devices and sensors by name. */
  async portalSearch({ user, lang, q }, gc) {
    if (!user || typeof q !== 'string' || q.length < 2) return [];
    const needle = q.toLowerCase();
    const { devices, sensors } = await portalData(gc, user.id);
    return [...devices, ...sensors].filter((r) => String(r.name || '').toLowerCase().includes(needle)).slice(0, 10)
      .map((r) => ({ title: r.name, subtitle: kindLabel(r, lang), section: 'smarthome' }));
  },

  /** Quick actions of the apps: the viewer's own lights, plugs and groups (toggles, dimmable ones with a widget) and scenes (buttons), at most 16. */
  async quickActions({ user, lang }, gc) {
    return quickActionsFor(gc, user, lang);
  },

  /**
   * Runs one of them (the host only passes an id quickActions just listed for this viewer; checked here
   * again). control/value (GateControl ≥ 1.171.0) only when the app used the widget's brightness slider;
   * target 'on' | 'off' (GateControl ≥ 1.173.0) sets a toggle's state.
   */
  async runQuickAction({ user, lang, id, control, value, target }, gc) {
    return runQuickActionFor(gc, user, lang, id, control, value, target === 'on' || target === 'off' ? target : undefined);
  },

  /** Built-in data handed over by GateControl (once, by an administrator). */
  async legacyImport(snapshot, gc) {
    state.importing = true;
    try { return await legacy.importSnapshot(snapshot, gc); } finally { state.importing = false; }
  },

  /** Background: rules that lost their deCONZ objects once, then sync every <interval> seconds. */
  async tick(gc) {
    if (state.importing) return;
    if (!state.resynced) {
      state.resynced = true;
      try { await rules.resyncPending(gc); } catch (e) { gc.log.warn('rule resync failed', e.code || e.message); }
    }
    const s = await gc.settings.all();
    const interval = Math.max(30, Math.min(3600, Number(s.interval) || 30));
    if (Date.now() - state.lastSync < interval * 1000 - 2000) return;
    state.lastSync = Date.now();
    await service.syncAll(gc);
  },

  _state: state,
};
