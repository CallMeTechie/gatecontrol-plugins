'use strict';

// gatecontrol-smarthome — Phoscon/deCONZ Smart Home as a GateControl plugin
// (formerly built into GateControl: src/services/smarthome, routes/api/smarthome.js,
// the Smart Home pages and the portal part of "Zuhause").
//
//   admin API   (Settings → Plugins, the plugin pages; administrators only)
//     GET  /gateways · /targets · /resources[?gateway_id] · /users
//     POST /gateways · /gateways/:id/sync · /gateways/:id/test · /resources/:id/state
//     PUT  /gateways/:id · /resources/:id/owners        DELETE /gateways/:id
//     GET  /rules?gateway_id[&source=edge] · /rules/gateway-count?gateway_id
//     POST /rules { …, source? } · /rules/:id/enabled   PUT /rules/:id   DELETE /rules/:id
//          source 'edge': logic chains of the Shelly / Tasmota devices of a GateControl gateway (server/edgerules.js)
//     POST /rules/check { gateway_id, id?, definition }   loops and shared devices of an edge chain (before saving)
//     POST /rules/test { gateway_id, id? | definition, run? }   Testlauf on the gateway; run: "Trotzdem ausführen"
//     GET  /rules/runs[?gateway_id | ?server=1][&rule_id][&problems=1]   the protocol of the chains (last 200 per place)
//          since 1.12.0 source 'server': chains with devices of several gateways / of deCONZ, run by the server part
//          (server/serverchains.js; POST /rules { source: 'server', … } without gateway_id, GET /rules?source=server);
//          quick_users [ids] in POST / PUT /rules: the portal viewers a chain with "Von Hand (App)" is released for
//     GET  /rules/devices?gateway_id | ?server=1   what the editor offers for a place (resources, buttons; z2m { approved,
//          status, link } when a gateway has zigbee2mqtt devices — since 1.15.0)
//     GET  /rules/people               the people for "freigegeben für" / "Mitteilung an" ({ id, username, admin })
//     GET  /rules/location?gateway_id | ?server=1 · PUT /rules/location { gateway_id | server: true, lat, lon } | { …, location: null }
//          where a place is (sunrise / sunset)
//     PUT  /resources/:id { area }      the area ("Bereich") of any resource
//     PUT  /resources/:id { name }      "In Smart Home benennen": lights / sensors (in deCONZ), Bluetooth sensors
//     GET  /find?focus=zigbee:<mac>|ble:<mac>   where the page's deep link points to
//   Bluetooth sensors through a GateControl gateway (server/radio.js; GateControl with gc.radio, phase 3c step 2)
//   Zigbee devices of zigbee2mqtt through a GateControl gateway (server/zigbee.js; gc.radio.zigbee / gc.radio.command)
//     GET  /ble/gateways · /ble/resources[?gateway_id]
//     POST /resources/:id/ota { action: 'check' | 'update' }   a firmware update of a zigbee2mqtt device
//   Shelly / Tasmota through a GateControl gateway (server/edge.js; GateControl ≥ 1.228.1 gc.edge, gc.mqtt.accounts)
//     GET  /edge/gateways · /edge/found?gateway_id · /edge/devices[?gateway_id] · /edge/devices/:id · /edge/setup/:job
//     POST /edge/devices (by hand: account, password once) · /edge/setup (automatic) · /edge/setup/:job/password
//          /edge/setup/:job/manual · /edge/devices/:id/password · /edge/devices/:id/family · /edge/gateways/:id/refresh
//     PUT  /edge/devices/:id · /edge/devices/:id/owners      DELETE /edge/devices/:id · /edge/setup/:job
//   portal API  (the identified portal viewer — owner-scoped)
//     GET  /portal                     own devices and sensors
//     POST /portal/resources/:id/state control (the host lets only signed-in viewers change things)
//     GET  /portal/chains              the chains this viewer may start (since 1.12.0: "Von Hand (App)"; administrators
//                                      all of them, anybody else those an administrator released for them)
//     POST /portal/chains/:id/run      start one (its NUR WENN is checked) → { ok, result, message }
//   quick actions of the GateControl apps (hooks quickActions / runQuickAction)
//     the same owner scope as the portal: a toggle per own light, plug and
//     group, a button per scene of an own group; dimmable lights and groups
//     carry a widget (brightness as the value, a brightness slider); the toggles
//     declare their verbs and honour a target state (GateControl ≥ 1.173.0:
//     `target` 'on'|'off' sets that state, never switches over)
//     since 1.12.0 first: a button chain:<id> per logic chain with "Von Hand (App)" the viewer may start (at most 8)
//     since 1.13.0: the battery of a device as the widget's badge (server/battery.js), sensors on batteries last as
//     buttons sensor:<id> with a widget that only shows (its value, the badge; a run answers with it)
//   PUT  /resources/:id { kind }     since 1.13.0: light | plug | relay for one output of a zigbee2mqtt device with several
//   Heizung (since 1.14.0, server/heating.js — rooms = areas of the thermostats, presets, weekly plans, boost, window,
//   holiday, "Heizung abwesend"; the plan runs in the background run)
//     GET  /heating                    house, rooms, plans (administrators: every room)
//     PUT  /heating/house { presets?, away? } · PUT /heating/vacation { from, to, preheat_h?, preset?, rooms? } · DELETE /heating/vacation
//     POST /heating/plans · PUT /heating/plans/:id { name, week, presets?, window?, away?, rooms? } · DELETE /heating/plans/:id
//     PUT  /heating/rooms/:id { presets?, max_setpoint? }
//     POST /heating/rooms/:id { action: setpoint | preset | boost | boost_stop | resume | mode | skip_today, … }
//     portal: GET /portal/heating (the viewer's rooms: those with a thermostat assigned to them) ·
//             POST /portal/heating/rooms/:id { action … } (setpoint within the room's upper limit, preset, boost, resume;
//             mode and skip_today only for administrators)
//     quick actions: heat:<room> (a card: actual value, target stepper, presets), heat:<room>:boost, heat:<room>:plan,
//             heat:away (administrators: the toggle "Heizung abwesend", targets — the rules of Familie switch it)
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
const battery = require('./battery');
const deconzCaps = require('./caps');
const edge = require('./edge');
const radio = require('./radio');
const zigbee = require('./zigbee');
const edgerules = require('./edgerules');
const serverchains = require('./serverchains');
const heating = require('./heating');
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
  SMARTHOME_NOT_RENAMABLE: [400, 'error.not_renamable'],
  SMARTHOME_INVALID_PATCH: [400, 'error.invalid_patch'],
  SMARTHOME_NOT_OWNER: [403, 'error.not_owner'],
  SMARTHOME_RULE_INVALID: [400, 'error.rule_invalid'],
  SMARTHOME_RULE_NOT_FOUND: [404, 'error.rule_not_found'],
  DECONZ_RULE_LIMIT_REACHED: [409, 'error.rule_limit_reached'],
  SMARTHOME_EDGE_RULE_LIMIT: [409, 'error.edge_rule_limit'],
  SMARTHOME_RULE_LOOP: [409, 'error.rule_loop'],
  SMARTHOME_RULE_STOPPED: [409, 'error.rule_stopped'],
  SMARTHOME_EDGE_RULE_PENDING: [409, 'error.edge_rule_pending'],
  DECONZ_UNREACHABLE: [502, 'error.unreachable'],
  SMARTHOME_EDGE_UNAVAILABLE: [409, 'error.edge_unavailable'],
  SMARTHOME_EDGE_UNREACHABLE: [502, 'error.edge_unreachable'],
  SMARTHOME_MQTT_OFF: [409, 'error.mqtt_off'],
  SMARTHOME_RADIO_UNAVAILABLE: [409, 'error.radio_unavailable'],
  SMARTHOME_RADIO_UNREACHABLE: [502, 'error.radio_unreachable'],
  SMARTHOME_PREFIX_TOO_LONG: [400, 'error.prefix_too_long'],
  SMARTHOME_HEAT_INVALID: [400, 'error.heat_invalid'],
  SMARTHOME_HEAT_ROOM_NOT_FOUND: [404, 'error.heat_room_not_found'],
  SMARTHOME_HEAT_PLAN_NOT_FOUND: [404, 'error.heat_plan_not_found'],
  SMARTHOME_HEAT_LIMIT: [403, 'error.heat_limit'],
  SMARTHOME_HEAT_OFF: [409, 'error.heat_off'],
  SMARTHOME_TUYA_CLOUD: [502, 'error.tuya_cloud'],
  SMARTHOME_TUYA_CLOUD_AUTH: [400, 'error.tuya_cloud_auth'],
  SMARTHOME_TUYA_CLOUD_DENIED: [409, 'error.tuya_cloud_denied'],
  SMARTHOME_TUYA_NO_CLOUD: [409, 'error.tuya_no_cloud'],
  SMARTHOME_TUYA_SESSION: [404, 'error.tuya_session'],
  SMARTHOME_TUYA_FILE: [400, 'error.tuya_file'],
  SMARTHOME_TUYA_KEY: [409, 'error.tuya_key'],
  SMARTHOME_TUYA_OFFLINE: [502, 'error.tuya_offline'],
  FORBIDDEN: [403, 'error.forbidden'],
  NOT_FOUND: [404, 'error.not_found'],
  INVALID: [400, 'error.invalid'],
};

function fail(code, detail) { return Object.assign(new Error(code), { code, detail }); }

function errorResponse(e, lang) {
  const known = e && ERRORS[e.code];
  const [status, key] = known || [502, 'common.error'];
  const json = { ok: false, code: (e && e.code) || null, error: t(lang, key) };
  if (e && (e.code === 'SMARTHOME_RULE_INVALID' || e.code === 'SMARTHOME_HEAT_INVALID') && typeof e.detail === 'string') json.detail = e.detail;
  if (e && e.code === 'SMARTHOME_RULE_LOOP' && Array.isArray(e.chains)) json.chains = e.chains.slice(0, 20);
  // the Tuya cloud's own code (e.g. "tuya 1106") — helps with the set-up of the cloud project
  if (e && /^SMARTHOME_TUYA_CLOUD/.test(e.code) && typeof e.message === 'string' && /^tuya [0-9a-z]{1,12}$/.test(e.message)) json.detail = e.message;
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

const STATE_KEYS = new Set(['on', 'bri', 'reachable', 'type', 'value', 'pos', 'moving', 'power', 'energy_today', 'humidity', 'battery',
  'lowbattery', 'sleeping', 'lastupdated', 'setpoint', 'mode', 'heating', 'ct', 'hue', 'sat', 'colormode']);
const EDGE_CAPS = ['bri', 'power', 'position', 'cover', 'reading', 'ct', 'color', 'scenes'];
const Z2M_CAPS = ['bri', 'ct', 'color', 'power', 'position', 'cover', 'reading', 'setpoint', 'modes'];
/** Portal: only the controllable surface — never gateway, target or deCONZ internals. */
function portalResource(r) {
  const st = {};
  for (const [k, v] of Object.entries(r.state || {})) if (STATE_KEYS.has(k)) st[k] = v;
  let caps = r.capabilities || {};
  if (r.deconz_type === 'edge') caps = Object.fromEntries(EDGE_CAPS.filter((k) => k in caps).map((k) => [k, caps[k]]));
  if (r.deconz_type === 'z2m') caps = Object.fromEntries(Z2M_CAPS.filter((k) => k in caps).map((k) => [k, caps[k]]));
  return { id: r.id, kind: r.kind, name: r.name, area: r.area || null, capabilities: caps, state: st };
}

/** Portal patch: on (boolean) and bri (0-100, with the capability); a cover open/close/stop or pos; scenes take {}. */
function portalPatch(raw, caps, kind) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const patch = {};
  if (kind === 'thermostat') {
    // a thermostat (zigbee2mqtt): the target temperature within its limits and / or one of its modes
    const sp = caps && caps.setpoint;
    if ('setpoint' in raw) {
      if (!sp || typeof raw.setpoint !== 'number' || !Number.isFinite(raw.setpoint) || raw.setpoint < sp.min || raw.setpoint > sp.max) return null;
      patch.setpoint = raw.setpoint;
    }
    if ('mode' in raw) {
      if (!(caps && Array.isArray(caps.modes) && caps.modes.includes(raw.mode))) return null;
      patch.mode = raw.mode;
    }
    return Object.keys(patch).length ? patch : null;
  }
  if (kind === 'cover') {
    if ('cover' in raw) { if (!['open', 'close', 'stop'].includes(raw.cover)) return null; patch.cover = raw.cover; }
    if ('pos' in raw) {
      if (!(caps && caps.position) || typeof raw.pos !== 'number' || !Number.isFinite(raw.pos) || raw.pos < 0 || raw.pos > 100) return null;
      patch.pos = raw.pos;
    }
    return Object.keys(patch).length === 1 ? patch : null;
  }
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
  // a scene of the light itself (Tuya, since 1.21.0)
  if ('scene' in raw && caps && Array.isArray(caps.scenes)) {
    if (!caps.scenes.includes(raw.scene)) return null;
    patch.scene = raw.scene;
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
  // a scene stands in its group's area (when the viewer has that group)
  const groupArea = new Map(owned.filter((r) => r.kind === 'group' && r.area).map((g) => [`${g.gateway_id}/${g.deconz_id}`, g.area]));
  for (const r of owned) if (r.kind === 'scene' && !r.area) r.area = groupArea.get(sceneGroupKey(r)) || null;
  const sensors = owned.filter((r) => r.kind === 'sensor').map(portalResource); // switches stay out
  const devices = owned.filter((r) => r.kind !== 'sensor' && r.kind !== 'switch').map(portalResource);
  // "Batterie schwach" at or below the threshold of the notification (settings, default 15 %); since 1.13.0 also
  // for devices (zigbee2mqtt on batteries) and with the level of the battery symbol (battery_level good | warn | crit)
  const withBattery = [...sensors, ...devices].filter((s) => battery.of(s.state));
  if (withBattery.length) {
    const lowAt = await batteryLowAt(gc);
    for (const s of withBattery) {
      if (battery.isLow(s.state, lowAt)) s.state.battery_low = true;
      s.state.battery_level = battery.levelOf(s.state, lowAt);
    }
  }
  return { devices, sensors };
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
  relay: 'M12 3v9M6.3 7.3a8 8 0 1 0 11.4 0',
  cover: 'M4 3h16v18H4zM4 9h16M4 15h16',
};

/** "Batterie schwach" at or below this (the plugin setting of the notification, 5–50 %, default 15). */
async function batteryLowAt(gc) {
  try { return alerts.configOf(await gc.settings.all()).batteryLow; } catch { return alerts.configOf(null).batteryLow; }
}

/** The page's view of a resource with a battery (since 1.13.0): battery_low and battery_level (good | warn | crit). */
function withBatteryView(r, lowAt) {
  if (!battery.of(r.state)) return r;
  return { ...r, battery_low: battery.isLow(r.state, lowAt), battery_level: battery.levelOf(r.state, lowAt) };
}

function fmtNum(v, lang) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString(lang === 'en' ? 'en-GB' : 'de-DE', { maximumFractionDigits: 1 }) : null;
}

function kindLabel(r, lang) {
  if (r.kind === 'sensor') return t(lang, 'sensor.' + ((r.state && r.state.type) || (r.capabilities && r.capabilities.reading) || 'unknown'));
  if (r.kind === 'cover') return t(lang, 'cover.' + ((r.capabilities && r.capabilities.cover) || 'shutter'));
  return t(lang, 'kind.' + r.kind);
}

/** A cover's position as text: "60 % offen", "fährt auf", or the kind when unknown. */
function coverText(st, lang) {
  if (st.moving === 'opening' || st.moving === 'closing') return t(lang, 'cover.' + st.moving);
  if (st.pos != null && Number.isFinite(Number(st.pos))) return Number(st.pos) <= 0 ? t(lang, 'cover.closed') : t(lang, 'cover.pos_open', { pos: fmtNum(st.pos, lang) });
  return null;
}

function deviceTile(d, lang) {
  const st = d.state || {};
  if (d.kind === 'thermostat') {
    const v = fmtNum(st.value, lang);
    return { section: 'smarthome', title: d.name || '', value: v == null || st.value == null ? '–' : v, unit: v == null || st.value == null ? null : '°C', state: st.heating ? 'on' : null, icon: TILE_ICONS.temperature };
  }
  if (d.kind === 'cover') {
    return { section: 'smarthome', title: d.name || '', value: coverText(st, lang) || '–', state: st.reachable === false ? 'warn' : null, icon: TILE_ICONS.cover };
  }
  let value = st.on ? t(lang, 'portal.on') : t(lang, 'portal.off');
  if (st.on && d.capabilities && d.capabilities.bri && st.bri != null) value += ' · ' + fmtNum(st.bri, lang) + ' %';
  if (st.on && st.power != null && Number.isFinite(Number(st.power))) value += ' · ' + fmtNum(Math.round(st.power), lang) + ' W';
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

// ─── Logic chains from the apps ("Von Hand (App)") ──

const CHAIN_ICON = 'M6 3v12M18 9c0 7-12 5-12 9M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM21 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0z';
const CHAINS_MAX = 8;

/** Who may start a chain: an administrator always, anybody else when an administrator released it for them. */
function mayStart(user, row) {
  if (!user || !Number.isInteger(user.id) || user.loggedIn === false) return false;
  if (user.role === 'admin') return true;
  return rules.quickUsersOf(row).includes(user.id);
}

/** The enabled chains with the trigger "Von Hand (App)" this viewer may start, with the name of their place. */
async function startableChains(gc, user) {
  if (!user || !Number.isInteger(user.id) || user.loggedIn === false) return [];
  const list = (await gc.db.query("SELECT * FROM rules WHERE source IN ('edge', 'server') AND enabled = 1 ORDER BY name, id")).rows;
  const out = [];
  let gws = null;
  for (const row of list) {
    const def = store.parseJson(row.definition_json) || {};
    if (def.version !== 2 || !Array.isArray(def.triggers) || !def.triggers.some((t) => t && t.kind === 'manual')) continue;
    if (!mayStart(user, row)) continue;
    let place = null;
    if (row.source === 'edge') {
      if (!gws) gws = new Map((edge.available(gc) ? await gc.edge.gateways().catch(() => []) : []).map((g) => [g.id, g.name]));
      place = gws.get(row.gateway_id) || null;
    }
    out.push({ row, place });
  }
  return out;
}

function chainView(x, lang) {
  return { id: x.row.id, name: clip(x.row.name, 40), place: x.row.source, place_name: x.place, offline: x.row.source === 'edge' };
}

function chainAction(x, lang) {
  const sub = x.row.source === 'server' ? t(lang, 'qa.chain_server') : t(lang, 'qa.chain_gateway', { gw: x.place || t(lang, 'qa.chain_gw') });
  return { id: `chain:${x.row.id}`, title: clip(x.row.name, 40) || t(lang, 'qa.chain'), subtitle: clip(sub, 60), icon: CHAIN_ICON, kind: 'button',
    device: { id: 'chains', title: clip(t(lang, 'qa.chains'), 40), icon: CHAIN_ICON } };
}

/** Start one chain for a viewer (its NUR WENN is checked): { ok, result, message }. */
async function startChainFor(gc, user, lang, id) {
  const row = (await gc.db.get("SELECT * FROM rules WHERE id = ? AND source IN ('edge', 'server')", [Number(id)])).row;
  const def = row ? store.parseJson(row.definition_json) || {} : {};
  if (!row || !row.enabled || def.version !== 2 || !(def.triggers || []).some((x) => x && x.kind === 'manual') || !mayStart(user, row)) {
    return { ok: false, result: 'not_found', message: t(lang, 'qa.unknown') };
  }
  const name = clip(row.name, 40);
  try {
    const res = row.source === 'server'
      ? await serverchains.test(gc, { id: row.id }, { run: true, by: 'app' })
      : await edge.testRule(gc, row.gateway_id, { id: row.id, run: true, by: 'app' });
    const result = res && typeof res.result === 'string' ? res.result : (res && res.started ? 'started' : 'skip');
    if (result === 'started') return { ok: true, result, message: clip(t(lang, 'qa.chain_started', { name }), 120) };
    if (result === 'running') return { ok: true, result, message: clip(t(lang, 'qa.chain_running', { name }), 120) };
    if (result === 'stopped') return { ok: false, result, message: t(lang, 'error.rule_stopped') };
    return { ok: false, result: result === 'unknown' ? 'unknown' : 'skip', message: clip(t(lang, 'qa.chain_skipped', { name }), 120) };
  } catch (e) {
    if (!ERRORS[e && e.code]) gc.log.warn('chain start failed', row.id, (e && (e.code || e.message)) || e);
    return { ok: false, result: 'error', message: errorResponse(e, lang).json.error };
  }
}

// ─── Quick actions of the apps (declarative; the host checks and caps them) ──

const QA_MAX = 16;
const QA_ID_RE = /^(light|plug|group|scene|relay|cover|sensor):([1-9][0-9]{0,9})(?::(open|stop|close))?$/;
const COVER_OPS = ['open', 'stop', 'close'];
const COVER_ICONS = { open: 'M12 19V5M5 12l7-7 7 7', stop: 'M7 7h10v10H7z', close: 'M12 5v14M5 12l7 7 7-7' };
const SCENE_ICON = 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z';

/** A text as the host takes it unchanged: no control characters, trimmed, at most `max` UTF-16 units. */
function clip(v, max) {
  let s = String(v == null ? '' : v).replace(/[\0-\x1f\x7f]/g, ' ').trim();
  if (s.length > max) s = s.slice(0, max).replace(/[\ud800-\udbff]$/, '').trimEnd();
  return s;
}

const BRI = { min: 1, max: 100, step: 1, fallback: 100 };
// the colour temperature of the widgets in kelvin (the lights take mired: 1 000 000 / K), since 1.21.0
const CT_K = { min: 2200, max: 6500, step: 100, fallback: 4000 };
// the fixed colours of the widgets (hue 0–65535, sat 0–254 as deCONZ, zigbee2mqtt and Tuya take them)
const QA_COLOURS = [
  { id: 'white', hue: 0, sat: 0 }, { id: 'red', hue: 0, sat: 254 }, { id: 'orange', hue: 5461, sat: 254 }, { id: 'yellow', hue: 10923, sat: 254 },
  { id: 'green', hue: 21845, sat: 254 }, { id: 'cyan', hue: 32768, sat: 254 }, { id: 'blue', hue: 43690, sat: 254 }, { id: 'purple', hue: 50972, sat: 254 },
];

/** The fixed colour a light shows now (null: another colour, white light, or not known). */
function colourOf(st) {
  if (st.colormode !== 'hs' || !Number.isFinite(Number(st.hue)) || !Number.isFinite(Number(st.sat))) return null;
  const hue = Number(st.hue);
  const sat = Number(st.sat);
  if (sat < 40) return 'white';
  const near = QA_COLOURS.filter((c) => c.sat > 0).map((c) => ({ id: c.id, d: Math.min(Math.abs(c.hue - hue), 65536 - Math.abs(c.hue - hue)) })).sort((a, b) => a.d - b.d)[0];
  return near && near.d <= 1500 && sat >= 180 ? near.id : null;
}

/**
 * The battery of a resource as the badge of its widget (since 1.13.0; GateControl ≥ 1.175.0 shows it right of the
 * device's name, older hosts drop it): `ctx` { lowAt, now } — without one (or without a battery) the widget stays as
 * it is.
 */
function withBadge(w, r, lang, ctx) {
  if (!w || !ctx) return w;
  const b = battery.badge(r.state, { lowAt: ctx.lowAt, lang, now: ctx.now });
  if (b) w.badge = b;
  return w;
}

/** What the battery badges need: the threshold "Batterie schwach" and the time of the answer. */
async function badgeCtx(gc) { return { lowAt: await batteryLowAt(gc), now: Date.now() }; }

/** Whether a resource's quick action carries a widget: a dimmable light or group (never a plug or a scene). */
function dimmable(r) {
  return (r.kind === 'light' || r.kind === 'group') && Boolean(r.capabilities && r.capabilities.bri);
}

/** Readings of a metered device (Shelly / Tasmota): the power now and the energy of today. */
function powerReadings(r, lang, withPower) {
  const st = r.state || {};
  const out = [];
  if (withPower && st.power != null && Number.isFinite(Number(st.power))) out.push({ id: 'power', label: clip(t(lang, 'card.power'), 20), value: Math.round(Number(st.power)), unit: 'W' });
  if (st.energy_today != null && Number.isFinite(Number(st.energy_today))) out.push({ id: 'today', label: clip(t(lang, 'card.today'), 20), value: Math.round(Number(st.energy_today) * 100) / 100, unit: 'kWh' });
  return out;
}

const metered = (r) => (r.kind === 'plug' || r.kind === 'relay') && Boolean(r.capabilities && r.capabilities.power);

/**
 * The widget of a dimmable light or group (GateControl ≥ 1.171.0; older hosts
 * leave it out): the brightness as the value while on ("Off" otherwise), the
 * kind and reachability as the status, a brightness slider. A metered light
 * (Shelly / Tasmota) adds its power as a reading.
 */
function widgetOf(r, lang, ctx) {
  const st = r.state || {};
  const caps = r.capabilities || {};
  const bri = st.bri == null || !Number.isFinite(Number(st.bri)) ? null : Math.min(BRI.max, Math.max(BRI.min, Math.round(Number(st.bri))));
  let status = t(lang, 'kind.' + r.kind);
  if (st.tuya_key) status += ' · ' + t(lang, 'qa.tuya_key');
  else if (st.reachable === false) status += ' · ' + t(lang, 'qa.unreachable');
  const w = { label: clip(t(lang, 'portal.brightness'), 24), value: t(lang, 'portal.off'), unit: null, status: clip(status, 60), state: st.on ? 'on' : 'off', controls: [] };
  if (st.on) {
    if (bri != null) { w.value = bri; w.unit = '%'; } else w.value = t(lang, 'portal.on');
  }
  w.controls.push({ id: 'bri', kind: 'slider', label: clip(t(lang, 'portal.brightness'), 20), value: bri == null ? BRI.fallback : bri, min: BRI.min, max: BRI.max, step: BRI.step, unit: '%' });
  // since 1.21.0, for every colour light (Tuya, deCONZ, zigbee2mqtt): the colour temperature as a slider in kelvin, up to
  // eight fixed colours and — Tuya — the light's own scenes as choices (at most four controls in all)
  if (r.kind === 'light') {
    if (caps.color === 'ct' || caps.ct === true) {
      const k = Number.isFinite(Number(st.ct)) && Number(st.ct) > 0 ? Math.round(1e6 / Number(st.ct) / 100) * 100 : CT_K.fallback;
      w.controls.push({ id: 'ct', kind: 'slider', label: clip(t(lang, 'warmth'), 20), value: Math.min(CT_K.max, Math.max(CT_K.min, k)), min: CT_K.min, max: CT_K.max, step: CT_K.step, unit: 'K' });
    }
    if (caps.color === 'hs' || caps.color === 'xy') {
      w.controls.push({ id: 'color', kind: 'choice', label: clip(t(lang, 'color'), 20), value: colourOf(st), options: QA_COLOURS.map((c) => ({ id: c.id, label: clip(t(lang, 'qa.colour.' + c.id), 20) })) });
    }
    if (Array.isArray(caps.scenes) && caps.scenes.length >= 2) {
      w.controls.push({ id: 'scene', kind: 'choice', label: clip(t(lang, 'qa.scene'), 20), value: st.colormode === 'scene' && caps.scenes.includes(st.scene) ? st.scene : null,
        options: caps.scenes.slice(0, 8).map((id) => ({ id, label: clip(t(lang, 'qa.scene.' + id), 20) })) });
    }
  }
  // a Shelly / Tasmota / Tuya light that does not answer (or whose key no longer fits): greyed out, the reason in the status
  if (r.deconz_type === 'edge' && (st.reachable === false || st.tuya_key)) for (const c of w.controls) c.disabled = true;
  if (r.capabilities && r.capabilities.power) {
    const readings = powerReadings(r, lang, true);
    if (readings.length) w.readings = readings;
  }
  return withBadge(w, r, lang, ctx);
}

/** A metered plug or switch (Shelly / Tasmota): the power now as the value, today's energy as a reading. */
function powerWidgetOf(r, lang, ctx) {
  const st = r.state || {};
  let status = kindLabel(r, lang) + ' · ' + t(lang, st.on ? 'portal.on' : 'portal.off');
  if (st.reachable === false) status = kindLabel(r, lang) + ' · ' + t(lang, 'qa.unreachable');
  const power = st.power != null && Number.isFinite(Number(st.power)) ? Math.round(Number(st.power)) : null;
  return withBadge({
    label: clip(t(lang, 'card.power'), 24), value: power, unit: power == null ? null : 'W', status: clip(status, 60), state: st.on ? 'on' : 'off',
    readings: powerReadings(r, lang, false), controls: [],
  }, r, lang, ctx);
}

/**
 * A plain switch on batteries (zigbee2mqtt) — without a widget of its own: on / off as the value, the kind as the
 * status, the battery as the badge (since 1.13.0). Null without a battery: such a switch stays a plain toggle.
 */
function batteryWidgetOf(r, lang, ctx) {
  if (!ctx || !battery.of(r.state)) return null;
  const st = r.state || {};
  let status = kindLabel(r, lang);
  if (st.reachable === false) status += ' · ' + t(lang, 'qa.unreachable');
  return withBadge({ label: null, value: t(lang, st.on ? 'portal.on' : 'portal.off'), unit: null, status: clip(status, 60), state: st.on ? 'on' : 'off', controls: [] }, r, lang, ctx);
}

/**
 * A sensor on batteries (since 1.13.0) as a card of the apps: its value (temperature, humidity, open / closed …), the
 * humidity of a temperature sensor as a reading, asleep / unreachable in the status, the battery as the badge; no
 * on / off (power: false), nothing to switch.
 */
function sensorWidgetOf(r, lang, ctx) {
  const st = r.state || {};
  let status = kindLabel(r, lang);
  if (st.sleeping === true && st.lastupdated) {
    const age = battery.ageText(st.lastupdated, ctx ? ctx.now : Date.now(), lang);
    status += ' · ' + (st.reachable === false ? t(lang, 'qa.sensor_silent', { ago: age || '–' }) : (age ? t(lang, 'qa.sensor_asleep', { ago: age }) : t(lang, 'qa.sensor_asleep_now')));
  } else if (st.reachable === false) status += ' · ' + t(lang, 'qa.unreachable');
  const w = { label: clip(kindLabel(r, lang), 24), value: null, unit: null, status: clip(status, 60), state: null, readings: [], controls: [], power: false };
  const tile = sensorTile(r, lang);
  if (tile.value !== '–' && tile.value != null) { w.value = clip(tile.value, 24); w.unit = tile.unit || null; }
  if (tile.state === 'good' || tile.state === 'warn' || tile.state === 'crit') w.state = tile.state;
  if (st.type === 'temperature' && st.humidity != null && Number.isFinite(Number(st.humidity))) {
    w.readings.push({ id: 'humidity', label: clip(t(lang, 'sensor.humidity'), 20), value: Math.round(Number(st.humidity)), unit: '%' });
  }
  return withBadge(w, r, lang, ctx);
}

/** A sensor on batteries as a button of the apps (since 1.13.0): a card that shows, nothing to run. */
function sensorAction(r, lang, ctx) {
  const st = r.state || {};
  const icon = TILE_ICONS[st.type || (r.capabilities && r.capabilities.reading)] || TILE_ICONS.sensor;
  const w = sensorWidgetOf(r, lang, ctx);
  return { id: `${r.kind}:${r.id}`, title: clip(r.name, 40) || kindLabel(r, lang), subtitle: w.status, icon, kind: 'button', device: { ...deviceOf(r, lang), icon }, widget: w };
}

/** A cover (Shelly / Tasmota): the position as the value, a position slider; carried by its "open" button. */
function coverWidgetOf(r, lang, ctx) {
  const st = r.state || {};
  const pos = st.pos != null && Number.isFinite(Number(st.pos)) ? Math.round(Number(st.pos)) : null;
  let status = kindLabel(r, lang);
  if (st.reachable === false) status += ' · ' + t(lang, 'qa.unreachable');
  else if (st.moving === 'opening' || st.moving === 'closing') status += ' · ' + t(lang, 'cover.' + st.moving);
  const w = { label: clip(t(lang, 'cover.position'), 24), value: pos, unit: pos == null ? null : '%', status: clip(status, 60), state: st.reachable === false ? 'warn' : null, power: false, controls: [] };
  if (r.capabilities && r.capabilities.position) w.controls.push({ id: 'pos', kind: 'slider', label: clip(t(lang, 'cover.position'), 20), value: pos == null ? 0 : pos, min: 0, max: 100, step: 1, unit: '%' });
  return withBadge(w, r, lang, ctx);
}

/** A resource as the apps group quick actions (GateControl ≥ 1.172.0): r:<resource id>, its name and icon. */
function deviceOf(r, lang) {
  return { id: `r:${r.id}`, title: clip(r.name, 40) || kindLabel(r, lang), icon: r.kind === 'scene' ? SCENE_ICON : (TILE_ICONS[r.kind] || TILE_ICONS.light) };
}

/** A cover's three buttons (open, stop, close) as one device; the "open" button carries the widget. */
function coverActions(r, lang, ctx) {
  const device = deviceOf(r, lang);
  const st = r.state || {};
  const sub = clip(st.reachable === false ? kindLabel(r, lang) + ' · ' + t(lang, 'qa.unreachable') : (coverText(st, lang) || kindLabel(r, lang)), 60);
  return COVER_OPS.map((op) => {
    const a = { id: `cover:${r.id}:${op}`, title: clip(t(lang, 'cover.' + op), 40), subtitle: sub, icon: COVER_ICONS[op], kind: 'button', device };
    if (op === 'open') a.widget = coverWidgetOf(r, lang, ctx);
    return a;
  });
}

/** `device`: the resource's own, for a scene its group's (when the viewer has that group). */
function quickAction(r, lang, device, ctx) {
  const name = clip(r.name, 40) || kindLabel(r, lang);
  if (r.kind === 'scene') return { id: `scene:${r.id}`, title: name, subtitle: t(lang, 'kind.scene'), icon: SCENE_ICON, kind: 'button', device: device || deviceOf(r, lang) };
  const st = r.state || {};
  let subtitle = kindLabel(r, lang);
  if (st.reachable === false) subtitle += ' · ' + t(lang, 'qa.unreachable');
  else if (st.on && r.capabilities && r.capabilities.bri && st.bri != null) subtitle += ' · ' + fmtNum(st.bri, lang) + ' %';
  else if (st.on && st.power != null && Number.isFinite(Number(st.power))) subtitle += ' · ' + fmtNum(Math.round(st.power), lang) + ' W';
  const a = {
    id: `${r.kind}:${r.id}`, title: name, subtitle: clip(subtitle, 60), icon: TILE_ICONS[r.kind] || TILE_ICONS.light, kind: 'toggle', state: st.on ? 'on' : 'off',
    device: device || deviceOf(r, lang), verbs: { on: t(lang, 'qa.verb_on'), off: t(lang, 'qa.verb_off') }, targets: true,
  };
  const w = widgetFor(r, lang, ctx);
  if (w) a.widget = w;
  return a;
}

/** The widget of a toggle: dimmable, metered, or (since 1.13.0) a plain one on batteries; none otherwise. */
function widgetFor(r, lang, ctx) {
  if (dimmable(r)) return widgetOf(r, lang, ctx);
  if (metered(r)) return powerWidgetOf(r, lang, ctx);
  return batteryWidgetOf(r, lang, ctx);
}

/** The deCONZ group of a scene on its gateway: "<gateway id>/<group id>" (capabilities.group_id, else the id's prefix). */
function sceneGroupKey(r) {
  const gid = r.capabilities && r.capabilities.group_id != null ? r.capabilities.group_id : String(r.deconz_id).split('/')[0];
  return `${r.gateway_id}/${gid}`;
}

/**
 * The viewer's own controllable devices (exactly the portal's devices: owned,
 * enabled, scenes of an owned group) as quick actions — cached state only,
 * no gateway round trip. Switches first (groups, lights, plugs, switched
 * outputs), then the buttons of covers (open / stop / close), scenes last.
 * Every resource is its own device (r:<id>); a scene belongs to its group's
 * device when the viewer has that group, else it is a device of its own.
 */
async function quickActionsFor(gc, user, lang) {
  if (!user || !Number.isInteger(user.id) || user.loggedIn === false) return [];
  // thermostats are set in the portal (a target temperature is no switch)
  const owned = await ownedResources(gc, user.id);
  const devices = owned.filter((r) => r.kind !== 'sensor' && r.kind !== 'switch' && r.kind !== 'thermostat');
  // since 1.13.0: sensors on batteries (Shelly H&T, deCONZ, zigbee2mqtt, Bluetooth) as cards with their battery, last
  const sensors = owned.filter((r) => r.kind === 'sensor' && battery.of(r.state));
  const ctx = await badgeCtx(gc);
  const groups = new Map(devices.filter((r) => r.kind === 'group').map((g) => [`${g.gateway_id}/${g.deconz_id}`, g]));
  const toggles = devices.filter((d) => d.kind !== 'scene' && d.kind !== 'cover');
  const covers = devices.filter((d) => d.kind === 'cover');
  const scenes = devices.filter((d) => d.kind === 'scene');
  // the chains the viewer may start come first (at most 8), then the devices
  const out = (await startableChains(gc, user)).slice(0, CHAINS_MAX).map((x) => chainAction(x, lang));
  // since 1.14.0: the heating — a card per room of the viewer (its thermostats stay out of the devices), at most 8
  out.push(...(await heating.quickActions(gc, user, lang).catch((e) => { gc.log.warn('heating quick actions failed', (e && (e.code || e.message)) || e); return []; })));
  out.push(...toggles.map((d) => quickAction(d, lang, null, ctx)));
  for (const c of covers) if (out.length + 3 <= QA_MAX) out.push(...coverActions(c, lang, ctx));
  for (const d of scenes) {
    const group = groups.get(sceneGroupKey(d));
    out.push(quickAction(d, lang, group ? deviceOf(group, lang) : null, ctx));
  }
  for (const s of sensors) out.push(sensorAction(s, lang, ctx));
  return out.slice(0, QA_MAX);
}

/** The widget of a resource after a change (the cached state follows what was sent). */
async function widgetAfter(gc, r, lang, ctx) {
  const now = (await store.getResource(gc, r.id)) || r;
  if (r.kind === 'cover') return coverWidgetOf(now, lang, ctx);
  return widgetFor(now, lang, ctx) || undefined;
}

/**
 * Run one quick action with the portal's checks (owner, enabled, controllable).
 * A toggle switches over; with a target ('on' | 'off', GateControl ≥ 1.173.0)
 * it sets that state, whatever the cached state says. With a control
 * (GateControl ≥ 1.171.0): `bri` sets the brightness of a dimmable light or
 * group and switches it on, `pos` moves a cover. A cover's buttons open, stop
 * or close it. A resource with a widget answers with it.
 */
async function runQuickActionFor(gc, user, lang, id, control, value, target) {
  // the heating (since 1.14.0): its own checks; a target in half degrees (no rounding to whole numbers as below)
  if (typeof id === 'string' && id.startsWith('heat:')) return heating.runQuickAction(gc, user, lang, id, control, value, target);
  const cm = typeof id === 'string' ? /^chain:([1-9][0-9]{0,9})$/.exec(id) : null;
  if (cm) {
    if (control !== undefined || target !== undefined) return { ok: false, message: t(lang, 'qa.unknown') };
    const r = await startChainFor(gc, user, lang, Number(cm[1]));
    return { ok: r.ok, message: r.message };
  }
  const m = typeof id === 'string' ? QA_ID_RE.exec(id) : null;
  if (!m || !user || !Number.isInteger(user.id) || user.loggedIn === false) return { ok: false, message: t(lang, 'qa.unknown') };
  if ((m[1] === 'cover') !== (m[3] !== undefined)) return { ok: false, message: t(lang, 'qa.unknown') };
  const rid = Number(m[2]);
  let r = null;
  let ctx = null;
  try {
    if (!(await store.canAccess(gc, rid, user.id))) throw fail('SMARTHOME_NOT_OWNER');
    r = await store.getResource(gc, rid);
    if (!r || !r.enabled || r.kind !== m[1]) throw fail('SMARTHOME_RESOURCE_NOT_FOUND');
    ctx = await badgeCtx(gc);
    // a sensor (since 1.13.0): a card that shows, nothing to run — the answer is its widget as it is now
    if (r.kind === 'sensor') {
      if (control !== undefined || target !== undefined || !battery.of(r.state)) return { ok: false, message: t(lang, 'qa.unknown') };
      return { ok: true, message: null, widget: sensorWidgetOf(r, lang, ctx) };
    }
    const name = clip(r.name, 40);
    if (control !== undefined) {
      const v = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : NaN;
      if (r.kind === 'cover') {
        if (control !== 'pos' || !(r.capabilities && r.capabilities.position) || !(v >= 0 && v <= 100)) return { ok: false, message: t(lang, 'qa.unknown') };
        await service.setResourceState(gc, rid, { pos: v });
        return { ok: true, message: null, widget: await widgetAfter(gc, r, lang, ctx) };
      }
      // since 1.21.0: the colour temperature (kelvin), a fixed colour, a scene of the light
      const caps = r.capabilities || {};
      if (control === 'ct' && r.kind === 'light' && (caps.color === 'ct' || caps.ct === true)) {
        if (!(v >= CT_K.min && v <= CT_K.max)) return { ok: false, message: t(lang, 'qa.unknown') };
        await service.setResourceState(gc, rid, { ct: Math.max(153, Math.min(500, Math.round(1e6 / v))), on: true });
        return { ok: true, message: null, state: 'on', widget: await widgetAfter(gc, r, lang, ctx) };
      }
      if (control === 'color' && r.kind === 'light' && (caps.color === 'hs' || caps.color === 'xy')) {
        const c = QA_COLOURS.find((x) => x.id === value);
        if (!c) return { ok: false, message: t(lang, 'qa.unknown') };
        await service.setResourceState(gc, rid, { hue: c.hue, sat: c.sat, on: true });
        return { ok: true, message: null, state: 'on', widget: await widgetAfter(gc, r, lang, ctx) };
      }
      if (control === 'scene' && r.kind === 'light' && Array.isArray(caps.scenes)) {
        if (!caps.scenes.includes(value)) return { ok: false, message: t(lang, 'qa.unknown') };
        await service.setResourceState(gc, rid, { scene: value });
        return { ok: true, message: null, state: 'on', widget: await widgetAfter(gc, r, lang, ctx) };
      }
      if (control !== 'bri' || !dimmable(r) || !(v >= BRI.min && v <= BRI.max)) return { ok: false, message: t(lang, 'qa.unknown') };
      await service.setResourceState(gc, rid, { bri: v, on: true });
      return { ok: true, message: null, state: 'on', widget: await widgetAfter(gc, r, lang, ctx) };
    }
    if (r.kind === 'scene') {
      await service.setResourceState(gc, rid, {});
      return { ok: true, message: clip(t(lang, 'portal.scene_done', { name }), 120) };
    }
    if (r.kind === 'cover') {
      await service.setResourceState(gc, rid, { cover: m[3] });
      const out = { ok: true, message: clip(t(lang, 'cover.done_' + m[3], { name }), 120) };
      if (m[3] === 'open') out.widget = await widgetAfter(gc, r, lang, ctx);
      return out;
    }
    const on = target === 'on' || target === 'off' ? target === 'on' : !(r.state && r.state.on);
    await service.setResourceState(gc, rid, { on });
    const out = { ok: true, message: clip(t(lang, on ? 'qa.switched_on' : 'qa.switched_off', { name }), 120), state: on ? 'on' : 'off' };
    const widget = await widgetAfter(gc, r, lang, ctx);
    if (widget) out.widget = widget;
    return out;
  } catch (e) {
    if (!ERRORS[e && e.code]) gc.log.warn('quick action failed', id, (e && (e.code || e.message)) || e);
    const out = { ok: false, message: errorResponse(e, lang).json.error };
    if (r && r.kind === 'cover') { if (m[3] === 'open') out.widget = coverWidgetOf(r, lang, ctx); } else if (r && r.kind !== 'scene') {
      const w = widgetFor(r, lang, ctx);
      if (w) out.widget = w;
    }
    return out;
  }
}

// ─── Routes ─────────────────────────────────────

async function portalRoute(req, gc, seg) {
  const user = req.user;
  if (req.method === 'GET' && seg.length === 1) return { json: { ok: true, ...(await portalData(gc, user.id)) } };
  if (seg[1] === 'heating') {
    const viewer = { id: user.id, role: user.role, lang: req.lang };
    if (req.method === 'GET' && seg.length === 2) return { json: { ok: true, ...(await heating.overview(gc, viewer, req.lang)) } };
    if (req.method === 'POST' && seg.length === 4 && seg[2] === 'rooms') {
      const id = posInt(seg[3]);
      if (!id) throw fail('NOT_FOUND');
      return { json: { ok: true, room: await heating.act(gc, id, req.body, viewer) } };
    }
    throw fail('NOT_FOUND');
  }
  if (seg[1] === 'chains') {
    if (req.method === 'GET' && seg.length === 2) return { json: { ok: true, chains: (await startableChains(gc, user)).map((x) => chainView(x, req.lang)) } };
    if (req.method === 'POST' && seg.length === 4 && seg[3] === 'run') {
      const id = posInt(seg[2]);
      if (!id) throw fail('NOT_FOUND');
      const r = await startChainFor(gc, user, req.lang, id);
      if (r.result === 'not_found') throw fail('SMARTHOME_RULE_NOT_FOUND');
      return { json: { ok: r.ok, result: r.result, message: r.message } };
    }
    throw fail('NOT_FOUND');
  }
  if (req.method === 'POST' && seg[1] === 'resources' && seg[3] === 'state' && seg.length === 4) {
    const id = posInt(seg[2]);
    if (!id) throw fail('NOT_FOUND');
    if (!(await store.canAccess(gc, id, user.id))) throw fail('SMARTHOME_NOT_OWNER');
    const resource = await store.getResource(gc, id);
    if (!resource || !resource.enabled) throw fail('SMARTHOME_RESOURCE_NOT_FOUND');
    if (resource.kind === 'sensor' || resource.kind === 'switch') throw fail('SMARTHOME_NOT_CONTROLLABLE');
    const patch = portalPatch(req.body && req.body.patch, resource.capabilities, resource.kind);
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

/** What the editor of a chain offers for a place: { resources, devices (buttons of Shelly / Tasmota) }. */
async function editorDevices(gc, place) {
  const view = (r, placeName) => ({ id: r.id, kind: r.kind, name: r.name, area: r.area || null, enabled: !!r.enabled, capabilities: r.capabilities || {}, state: r.state || {}, place: placeName || null,
    source: (r.capabilities && r.capabilities.source) || (r.deconz_type === 'edge' ? 'edge' : 'deconz') });
  if (place === 0) {
    const gwNames = new Map((await store.listGateways(gc)).map((g) => [g.id, g.name]));
    const edgeNames = new Map((edge.available(gc) ? await gc.edge.gateways().catch(() => []) : []).map((g) => [g.id, g.name]));
    const devGw = new Map((await require('./edgestore').listDevices(gc)).map((d) => [d.id, d.gateway_id]));
    const byId = await edgerules.resourcesOf(gc, 0);
    const resources = [...byId.values()].map(({ resource: r }) => {
      let pn = null;
      if (r.deconz_type === 'edge') pn = edgeNames.get(devGw.get(r.edge_device_id)) || null;
      else if (r.gateway_id) pn = gwNames.get(r.gateway_id) || null;
      else pn = (r.capabilities && r.capabilities.gateway) || null;
      return view(r, pn);
    });
    return { resources, devices: [] };
  }
  const byId = await edgerules.resourcesOf(gc, place);
  const devices = (await require('./edgestore').listDevices(gc, place)).map((d) => ({ id: d.id, name: d.name, family: d.family }));
  const resources = [...byId.values()].map(({ resource: r }) => view(r, null));
  // zigbee2mqtt devices of the gateway (since 1.15.0, GateControl ≥ 1.317.0): confirmed for it? (the editor's hint)
  let z2m = null;
  if (resources.some((r) => r.source === 'z2m')) {
    const approved = await edgerules.z2mApproved(gc, place);
    z2m = { approved, status: edgerules.z2mStatus(place, approved), link: edgerules.z2mLink(place) };
  }
  return { resources, devices, z2m };
}

/** The heating's admin API (administrators: every room, the plans, the house). */
async function heatingRoute(req, gc, seg, body) {
  const m = req.method;
  const [, b, c] = seg;
  const viewer = { id: req.user.id, role: 'admin', all: true, lang: req.lang };
  if (seg.length === 1 && m === 'GET') return { json: { ok: true, ...(await heating.overview(gc, viewer, req.lang)) } };
  if (seg.length === 2 && b === 'house' && m === 'PUT') return { json: { ok: true, house: await heating.setHouse(gc, body) } };
  if (seg.length === 2 && b === 'vacation' && m === 'PUT') return { json: { ok: true, house: await heating.setVacation(gc, body) } };
  if (seg.length === 2 && b === 'vacation' && m === 'DELETE') return { json: { ok: true, house: await heating.setVacation(gc, null) } };
  if (b === 'plans') {
    if (seg.length === 2 && m === 'POST') return { json: { ok: true, plan: await heating.savePlan(gc, null, body) } };
    const id = posInt(c);
    if (!id || seg.length !== 3) throw fail('NOT_FOUND');
    if (m === 'PUT') return { json: { ok: true, plan: await heating.savePlan(gc, id, body) } };
    if (m === 'DELETE') return { json: await heating.deletePlan(gc, id) };
    throw fail('NOT_FOUND');
  }
  if (b === 'rooms' && seg.length === 3) {
    const id = posInt(c);
    if (!id) throw fail('NOT_FOUND');
    if (m === 'PUT') return { json: { ok: true, room: await heating.setRoom(gc, id, body) } };
    if (m === 'POST') return { json: { ok: true, room: await heating.act(gc, id, body, viewer) } };
  }
  throw fail('NOT_FOUND');
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

  if (a === 'find' && seg.length === 1 && m === 'GET') {
    return { json: { ok: true, found: await service.findFocus(gc, req.query && req.query.focus) } };
  }

  if (a === 'ble') {
    if (seg.length === 2 && b === 'gateways' && m === 'GET') return { json: { ok: true, ...(await radio.gateways(gc)) } };
    if (seg.length === 2 && b === 'resources' && m === 'GET') {
      const gid = req.query && req.query.gateway_id ? posInt(req.query.gateway_id) : null;
      const users = await usersById(gc);
      const owners = await store.allOwners(gc);
      const lowAt = await batteryLowAt(gc);
      const resources = (await radio.list(gc, gid)).map((r) => withBatteryView({ ...r, owners: (owners.get(r.id) || []).filter((uid) => users.has(uid)).map((uid) => users.get(uid)) }, lowAt));
      return { json: { ok: true, resources } };
    }
    throw fail('NOT_FOUND');
  }

  if (a === 'resources') {
    if (seg.length === 1 && m === 'GET') {
      const gid = req.query && req.query.gateway_id ? posInt(req.query.gateway_id) : null;
      const users = await usersById(gc);
      const owners = await store.allOwners(gc);
      const list = await store.listResources(gc, gid || undefined);
      const lowAt = await batteryLowAt(gc);
      const resources = [];
      for (const r of list) {
        const ids = r.kind === 'scene' ? await store.inheritedOwnerIdsOf(gc, r) : (owners.get(r.id) || []);
        resources.push(withBatteryView({ ...r, owners: ids.filter((uid) => users.has(uid)).map((uid) => users.get(uid)) }, lowAt));
      }
      return { json: { ok: true, resources } };
    }
    const id = posInt(b);
    if (!id) throw fail('NOT_FOUND');
    if (seg.length === 2 && m === 'PUT' && body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 32) : '';
      if (!name) throw fail('INVALID');
      return { json: { ok: true, name, ...(await service.renameResource(gc, id, name)) } };
    }
    // since 1.13.0: the kind of one output of a zigbee2mqtt device with several (light, plug, switch)
    if (seg.length === 2 && m === 'PUT' && body.kind !== undefined) {
      const resource = await store.getResource(gc, id);
      if (!resource) throw fail('SMARTHOME_RESOURCE_NOT_FOUND');
      return { json: { ok: true, ...(await zigbee.setKind(gc, resource, body.kind)) } };
    }
    if (seg.length === 2 && m === 'PUT') {
      if (body.area !== null && typeof body.area !== 'string') throw fail('INVALID');
      const area = typeof body.area === 'string' ? body.area.replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) : null;
      if (!(await store.setArea(gc, id, area || null))) throw fail('SMARTHOME_RESOURCE_NOT_FOUND');
      return { json: { ok: true, area: area || null } };
    }
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
    if (seg.length === 3 && c === 'ota' && m === 'POST') {
      const resource = await store.getResource(gc, id);
      if (!resource || !resource.enabled) throw fail('SMARTHOME_RESOURCE_NOT_FOUND');
      return { json: await zigbee.ota(gc, resource, body.action) };
    }
    throw fail('NOT_FOUND');
  }

  if (a === 'edge') return edge.route(req, gc, seg.slice(1), body, usersById);

  if (a === 'heating') return heatingRoute(req, gc, seg, body);

  if (a === 'rules') {
    const serverPlace = (q) => q && (q.server === '1' || q.server === true || q.source === 'server');
    if (seg.length === 1 && m === 'GET') {
      if (req.query && req.query.source === 'server') {
        const list = await rules.list(gc, 0, 'server');
        return { json: { ok: true, rules: list, gc_rule_count: list.length, limit_warn: false, cancelSupported: true, location: await edgerules.locationOf(gc, 0) } };
      }
      if (req.query && req.query.source === 'edge') {
        const gid = gatewayIdQuery(req);
        const list = await rules.list(gc, gid, 'edge');
        return { json: { ok: true, rules: list, gc_rule_count: list.length, limit_warn: false, cancelSupported: true, location: await edgerules.locationOf(gc, gid) } };
      }
      const list = await rules.list(gc, gatewayIdQuery(req));
      return { json: { ok: true, rules: list, gc_rule_count: list.length, limit_warn: rules.limitWarn(list.length), cancelSupported: deconzCaps.cancelSupported } };
    }
    if (seg.length === 2 && b === 'gateway-count' && m === 'GET') return { json: { ok: true, ...(await rules.gatewayRuleCount(gc, gatewayIdQuery(req))) } };
    if (seg.length === 2 && b === 'people' && m === 'GET') {
      // who a chain may be released for ("Von Hand (App)": administrators need no release) and who gets a notification
      let list = [];
      try { list = await gc.users.list(); } catch { /* users unavailable */ }
      return { json: { ok: true, users: list.map((u) => ({ id: u.id, username: u.name, admin: u.role === 'admin' })) } };
    }
    if (seg.length === 2 && b === 'devices' && m === 'GET') return { json: { ok: true, ...(await editorDevices(gc, serverPlace(req.query) ? 0 : gatewayIdQuery(req))) } };
    if (seg.length === 2 && b === 'location') {
      const q = m === 'GET' ? (req.query || {}) : body;
      const place = serverPlace(q) ? 0 : posInt(q.gateway_id);
      if (place == null) throw fail('SMARTHOME_RULE_INVALID', 'missing_gateway_id');
      if (m === 'GET') return { json: { ok: true, location: await edgerules.locationOf(gc, place) } };
      if (m !== 'PUT') throw fail('NOT_FOUND');
      const loc = await edgerules.setLocation(gc, place, body.location === null ? null : { lat: body.lat, lon: body.lon });
      // the chains of the place (and the server's, which may fall back to a gateway's place) get the sun
      if (place) await edge.configureGateway(gc, place);
      await serverchains.reload(gc);
      return { json: { ok: true, location: loc } };
    }
    if (seg.length === 2 && b === 'runs' && m === 'GET') {
      const q = req.query || {};
      const gid = serverPlace(q) ? 0 : (q.gateway_id ? posInt(q.gateway_id) : null);
      // what the gateway kept while it was away, before the list is read (best effort, the gateway may be away)
      if (edge.available(gc)) {
        const gws = gid ? [gid] : (gid === 0 ? [] : (await gc.edge.gateways().catch(() => [])).filter((g) => g.state === 'running').map((g) => g.id));
        await Promise.all(gws.map((g) => edge.catchUp(gc, g)));
      }
      return { json: { ok: true, runs: await edgerules.listRuns(gc, { gatewayId: gid, ruleId: q.rule_id ? posInt(q.rule_id) : null, problems: q.problems === '1' }) } };
    }
    if (seg.length === 2 && b === 'check' && m === 'POST') {
      const gid = body.source === 'server' ? 0 : posInt(body.gateway_id);
      if (gid == null || !body.definition || typeof body.definition !== 'object') throw fail('SMARTHOME_RULE_INVALID', 'missing_fields');
      const a = await edgerules.analyse(gc, gid, posInt(body.id), body.definition);
      return { json: { ok: true, loop: a.loop, chains: a.chains, shared: a.shared } };
    }
    if (seg.length === 2 && b === 'test' && m === 'POST') {
      const server = body.source === 'server';
      const gid = server ? 0 : posInt(body.gateway_id);
      if (gid == null) throw fail('SMARTHOME_RULE_INVALID', 'missing_gateway_id');
      const id = posInt(body.id);
      if (id) {
        const row = await rules.get(gc, id);
        if (!row || row.source !== (server ? 'server' : 'edge') || row.gateway_id !== gid) throw fail('SMARTHOME_RULE_NOT_FOUND');
        if (!row.enabled) throw fail(row.stopped ? 'SMARTHOME_RULE_STOPPED' : 'SMARTHOME_EDGE_RULE_PENDING');
        if (server) return { json: { ok: true, test: await serverchains.test(gc, { id }, { run: body.run === true }) } };
        return { json: { ok: true, test: await edge.testRule(gc, gid, { id, ...(body.run === true ? { run: true } : {}) }) } };
      }
      if (!body.definition || typeof body.definition !== 'object') throw fail('SMARTHOME_RULE_INVALID', 'missing_fields');
      const compiled = edgerules.compileRule(1, body.definition, await edgerules.resourcesOf(gc, gid), server ? new Map() : await edgerules.devicesOf(gc, gid),
        { server, chains: await edgerules.chainIds(gc, gid) });
      if (server) return { json: { ok: true, test: await serverchains.test(gc, { rule: compiled }) } };
      return { json: { ok: true, test: await edge.testRule(gc, gid, { rule: compiled }) } };
    }
    if (seg.length === 1 && m === 'POST') {
      if (body.source !== undefined && !['deconz', 'edge', 'server'].includes(body.source)) throw fail('SMARTHOME_RULE_INVALID', 'bad_source');
      const gid = body.source === 'server' ? 0 : posInt(body.gateway_id);
      if (gid == null || typeof body.name !== 'string' || !body.name || !body.definition || typeof body.definition !== 'object') throw fail('SMARTHOME_RULE_INVALID', 'missing_fields');
      return { json: { ok: true, rule: await rules.create(gc, gid, body.name, body.definition, body.source || 'deconz', { quickUsers: body.quick_users }) } };
    }
    const id = posInt(b);
    if (!id) throw fail('NOT_FOUND');
    if (seg.length === 2 && m === 'PUT') {
      if (typeof body.name !== 'string' || !body.name || !body.definition || typeof body.definition !== 'object') throw fail('SMARTHOME_RULE_INVALID', 'missing_fields');
      return { json: { ok: true, rule: await rules.update(gc, id, body.name, body.definition, { quickUsers: body.quick_users }) } };
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
    edge.setup(gc);
    serverchains.start(gc);
    gc.log.info('smarthome started', gc.plugin.version);
  },

  async stop() {
    serverchains.stop();
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
    await edge.tick(gc).catch((e) => gc.log.warn('edge tick failed', (e && (e.code || e.message)) || e));
    await radio.sync(gc).catch((e) => gc.log.warn('radio sync failed', (e && (e.code || e.message)) || e));
    await zigbee.sync(gc).catch((e) => gc.log.warn('zigbee sync failed', (e && (e.code || e.message)) || e));
    // the plan of the heating (since 1.14.0): what each room should have now, sent where it changed
    await heating.tick(gc).catch((e) => gc.log.warn('heating failed', (e && (e.code || e.message)) || e));
    await serverchains.refresh(gc).catch(() => null);
    const s = await gc.settings.all();
    const interval = Math.max(30, Math.min(3600, Number(s.interval) || 30));
    if (Date.now() - state.lastSync < interval * 1000 - 2000) return;
    state.lastSync = Date.now();
    await service.syncAll(gc);
  },

  _state: state,
};
