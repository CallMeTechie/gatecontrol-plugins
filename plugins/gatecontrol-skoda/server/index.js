'use strict';

// gatecontrol-skoda — Škoda vehicles (MySkoda) as a GateControl plugin
// (formerly built into GateControl: src/services/skoda, routes/api/skoda.js,
// the Fahrzeuge page and the vehicle part of the portal tab "Fahrzeug").
//
//   admin API   (Settings → Plugins, the plugin page; administrators only)
//     GET  /  · /users · /vehicles/:id/details · /vehicles/:id/image?part=N
//     POST /accounts · /accounts/:id/sync · /vehicles/:id/refresh · /vehicles/:id/command
//     PUT  /accounts/:id · /accounts/:id/spin · /vehicles/:id/owners · /settings
//     DELETE /accounts/:id
//   portal API  (the identified portal viewer — owner-scoped)
//     GET  /portal · /portal/vehicles/:id/image?part=N · /portal/vehicles/:id/details
//     POST /portal/vehicles/:id/command   (the host lets only signed-in viewers change things)
//   quick actions of the GateControl apps (hooks quickActions / runQuickAction)
//     the portal's controls for a signed-in owner, grouped per vehicle
//     (device v:<id>): climate (with the vehicle's widget), charging, window
//     heating and the lock (one toggle: locked/unlocked, with the account's
//     S-PIN; unlocking asks first); right after a command they show the state
//     the vehicle should report (control.expectedState), and an answer that
//     would pass the host's time limit says the command is on its way;
//     every toggle declares its verbs and honours a target state (GateControl
//     ≥ 1.173.0: `target` 'on'|'off' always sends the command for that state —
//     a locked vehicle asked to lock is locked again, never unlocked)
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
const alerts = require('./alerts');
const texts = require('./texts.json');

const state = { importing: false };

// GateControl waits at most 10 s for runQuickAction (then 504): a command
// still queued behind the account's sync answers "on its way" before that.
const QA_BUDGET_MS = 8000;
let qaBudgetMs = QA_BUDGET_MS;

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
  SKODA_SPIN_REJECTED: [409, 'cmd.spin_rejected'],
  SKODA_NO_SESSION: [409, 'error.no_session'],
  SKODA_UNAUTHORIZED: [409, 'error.no_session'],
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
  // the Škoda cloud refused: say so, with its HTTP status (the reason goes to the log, logError)
  if (!known && e && e.code === 'SKODA_API_ERROR' && Number.isInteger(e.status) && e.status >= 400 && e.status <= 599) {
    // spinRejected: the refusal of a lock/unlock marked the stored S-PIN as rejected (control.js)
    const key = e.status >= 500 ? 'error.api_server' : (e.spinRejected ? 'error.api_refused_spin' : 'error.api_refused');
    return { status: 502, json: { ok: false, code: e.code, error: t(lang, key, { status: e.status }) } };
  }
  const [status, key] = known || [502, 'error.generic'];
  return { status, json: { ok: false, code: (e && e.code) || null, error: t(lang, key) } };
}

/** An unexpected error to the log: its code, and for a refused Škoda request the HTTP status and Škoda's reason. */
function logError(gc, what, ...context) {
  const e = context.pop();
  const extra = e && e.code === 'SKODA_API_ERROR' ? [`HTTP ${e.status}`, ...(e.detail ? [e.detail] : [])] : [];
  gc.log.warn(what, ...context, (e && e.code) || 'error', ...extra);
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
// 24×24 stroke icons of the widget readings and tile items
const BATTERY_ICON = 'M2 7h16v10H2zM21 10v4M5 10v4M8 10v4M11 10v4';
const ROUTE_ICON = 'M3 19a3 3 0 1 0 6 0a3 3 0 1 0-6 0M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15M15 5a3 3 0 1 0 6 0a3 3 0 1 0-6 0';
const LOCK_CLOSED_ICON = 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4M12 15v2';
const LOCK_OPEN_ICON = 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 7.9-1M12 15v2';
// the widget badge (24×24 stroke): a battery filled to the level — empty (≤ 15 %), one,
// two or three bars (≤ 40, ≤ 75, above) — and with a lightning bolt while charging
const BATTERY_OUTLINE = 'M2 7h16v10H2zM21 10v4';
const BATTERY_LEVEL_ICONS = Object.freeze([
  [15, BATTERY_OUTLINE],
  [40, BATTERY_OUTLINE + 'M6 10v4'],
  [75, BATTERY_OUTLINE + 'M6 10v4M10 10v4'],
  [Infinity, BATTERY_OUTLINE + 'M6 10v4M10 10v4M14 10v4'],
]);
const BATTERY_CHARGING_ICON = BATTERY_OUTLINE + 'M11 9l-3 3h4l-3 3';

function fmtNum(v, lang) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString(lang === 'en' ? 'en-GB' : 'de-DE', { maximumFractionDigits: 0 }) : null;
}

/** A finite number or null. */
function num(v) {
  const n = v == null || v === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * The vehicle's charge level (whole %), range (whole km), lock (true / false / null)
 * and charging from the stored state — lock and charging as the apps show them (appStates).
 */
function vehicleFacts(v, states = appStates(v)) {
  const st = v.state || {};
  const soc = num(st.soc);
  const range = num(st.rangeKm);
  return {
    soc: soc == null ? null : Math.round(soc),
    range: range == null ? null : Math.round(range),
    locked: states.lock == null ? null : states.lock === 'on',
    charging: states.charging === 'on',
  };
}

/** The lock as a reading / tile item: closed (good) or open (crit). */
function lockItem(locked, label) {
  return { label, icon: locked ? LOCK_CLOSED_ICON : LOCK_OPEN_ICON, state: locked ? 'good' : 'crit' };
}

/** Start tile items for the apps (GateControl ≥ 1.172.0): charge level, range, lock — each only when known. */
function tileItems(f, lang) {
  const items = [];
  if (f.soc != null) items.push({ label: t(lang, 'widget.soc'), icon: BATTERY_ICON, value: f.soc, unit: '%', state: f.soc <= 15 ? 'crit' : 'good' });
  if (f.range != null) items.push({ label: t(lang, 'portal.range'), icon: ROUTE_ICON, value: f.range, unit: 'km' });
  if (f.locked != null) items.push(lockItem(f.locked, t(lang, f.locked ? 'qa.lock_locked' : 'qa.lock_unlocked')));
  return items;
}

function vehicleTile(v, lang) {
  const s = v.state || {};
  const f = vehicleFacts(v);
  const soc = s.soc == null ? null : Number(s.soc);
  const parts = [];
  if (soc != null && Number.isFinite(soc)) parts.push(fmtNum(soc, lang) + ' %');
  if (s.rangeKm != null && fmtNum(s.rangeKm, lang) != null) parts.push(fmtNum(s.rangeKm, lang) + ' km');
  if (f.charging) parts.push(t(lang, 'portal.charging'));
  else if (f.locked === false) parts.push(t(lang, 'portal.unlocked'));
  let tone = null;
  if (f.charging) tone = 'on';
  else if (soc != null && soc <= 15) tone = 'crit';
  else if (f.locked === false) tone = 'warn';
  else if (soc != null) tone = 'good';
  // `value` for the portal; the apps show `items` (older GateControl versions leave them out)
  return { section: 'skoda', title: v.name || v.model || '', value: parts.length ? parts.join(' · ') : '–', state: tone, icon: CAR_ICON, items: tileItems(f, lang) };
}

// ─── Quick actions of the apps (declarative; the host checks and caps them) ──

const QA_MAX = 16;
// unlock:<id> is no longer listed (the lock is one toggle); the host answers 404 for it
const QA_ID_RE = /^(climate|charging|windowheat|lock):([1-9][0-9]{0,9})$/;
const QA_ICONS = {
  climate: 'M12 2v20M3.3 7l17.4 10M3.3 17L20.7 7M9 3l3 2 3-2M9 21l3-2 3 2',
  charging: 'M13 2L4 14h7l-1 8 9-12h-7z',
  windowheat: 'M3 9c4-3 14-3 18 0l-2 7H5zM9 18c-1 1 1 2 0 3M15 18c-1 1 1 2 0 3',
  lock: LOCK_CLOSED_ICON,
};
// the lock toggle per state (GateControl ≥ 1.172.0): on = locked (green, closed), off = unlocked (red, open)
const LOCK_LOOK = Object.freeze({ on: { icon: LOCK_CLOSED_ICON, tone: 'good' }, off: { icon: LOCK_OPEN_ICON, tone: 'crit' } });

/** A text as the host takes it unchanged: no control characters, trimmed, at most `max` UTF-16 units. */
function clip(v, max) {
  let s = String(v == null ? '' : v).replace(/[\0-\x1f\x7f]/g, ' ').trim();
  if (s.length > max) s = s.slice(0, max).replace(/[\ud800-\udbff]$/, '').trimEnd();
  return s;
}

/** The toggles' states from the stored vehicle state (as the portal shows them): 'on' | 'off' | null. */
function toggleStates(s) {
  const st = s || {};
  const cl = st.climate || {};
  const ch = st.charging || {};
  const up = (x) => String(x || '').toUpperCase();
  return {
    climate: cl.state == null ? null : (up(cl.state) !== 'OFF' ? 'on' : 'off'),
    charging: ch.state == null ? null : (up(ch.state) === 'CHARGING' ? 'on' : 'off'),
    windowheat: typeof cl.windowHeating === 'boolean' ? (cl.windowHeating ? 'on' : 'off') : null,
    lock: typeof st.locked === 'boolean' ? (st.locked ? 'on' : 'off') : null,
  };
}

/**
 * The states the apps show (climate, charging, windowheat, lock: 'on' | 'off' | null):
 * the reported ones, or — for a few minutes after a command, until the vehicle
 * reports it — the state the command aims for (control.expectedState).
 */
function appStates(v) {
  const out = toggleStates(v.state);
  for (const kind of Object.keys(out)) out[kind] = control.expectedState(v.id, kind, out[kind]);
  return out;
}

/** The vehicle as the apps group its actions (GateControl ≥ 1.172.0): v:<id>, name (or model), model below a different name. */
function deviceOf(v, lang) {
  const title = clip(v.name || v.model || '', 40) || t(lang, 'portal.vehicle');
  const d = { id: `v:${v.id}`, title, icon: CAR_ICON };
  const model = clip(v.model || '', 60);
  if (model && model !== clip(v.name || '', 60)) d.subtitle = model;
  return d;
}

/** The charge level as the widget badge: battery icon by level (lightning while charging), whole %; null without one. */
function socBadge(f, lang) {
  if (f.soc == null) return null;
  const icon = f.charging ? BATTERY_CHARGING_ICON : BATTERY_LEVEL_ICONS.find(([max]) => f.soc <= max)[1];
  return { icon, value: f.soc, unit: '%', state: f.soc <= 15 ? 'crit' : 'good', label: clip(t(lang, 'widget.soc'), 20) };
}

/**
 * The vehicle's widget, carried by its climate action (GateControl ≥ 1.172.0;
 * older hosts leave the new fields out): the charge level as the badge right
 * of the vehicle's name (GateControl ≥ 1.175.0; older hosts drop it), no main
 * value, the range as the only reading (the lock shows on its own toggle),
 * charging / climate as the status, the card's colour from the charge level only
 * (red ≤ 15 %, else green; none without one — never from the lock). `power: false` —
 * the climate toggle is one of the vehicle's buttons, not its on/off switch.
 */
function vehicleWidget(v, lang, states = appStates(v)) {
  const f = vehicleFacts(v, states);
  const w = { label: null, value: null, unit: null, status: null, state: null, readings: [], controls: [], power: false, badge: socBadge(f, lang) };
  if (f.range != null) w.readings.push({ id: 'range', label: clip(t(lang, 'portal.range'), 20), value: f.range, unit: 'km', icon: ROUTE_ICON });
  if (f.charging) w.status = t(lang, 'widget.charging');
  else if (states.climate === 'on') w.status = t(lang, 'widget.climate_on');
  if (f.soc != null) w.state = f.soc <= 15 ? 'crit' : 'good';
  return w;
}

/**
 * The lock as one toggle: on = locked, off = unlocked, no state when unknown; asks before unlocking.
 * For another plugin's automation (rules, GateControl ≥ 1.166.0) the title is „Schloss“ — the state
 * is in `state`, a rule picks a target with the verbs.
 */
function lockAction(lang, states, automation) {
  const locked = states.lock == null ? null : states.lock === 'on';
  const a = {
    kind: 'toggle', title: t(lang, automation || locked == null ? 'qa.lock_unknown' : (locked ? 'qa.lock_locked' : 'qa.lock_unlocked')),
    icon: locked === false ? LOCK_OPEN_ICON : LOCK_CLOSED_ICON, look: LOCK_LOOK, confirm: true, confirmWhen: 'off',
  };
  if (locked != null) a.state = locked ? 'on' : 'off';
  return a;
}

/** The viewer's own vehicles (the portal's owner scope), stored state only. */
async function ownVehicles(gc, userId) {
  const ids = new Set(await store.vehiclesOwnedBy(gc, userId));
  if (!ids.size) return [];
  return (await store.listVehicles(gc)).filter((v) => ids.has(v.id));
}

/**
 * The portal's vehicle controls as quick actions — only for a signed-in owner
 * (the portal shows controls only then), grouped per vehicle (device): climate
 * (carrying the vehicle's widget), charging (a vehicle with a battery), window
 * heating; the lock as one toggle only with the account's S-PIN, unlocking
 * asks first. No cloud call.
 */
async function quickActionsFor(gc, user, lang) {
  if (!user || !Number.isInteger(user.id) || user.loggedIn !== true) return [];
  const automation = user.automation === true;
  const out = [];
  for (const v of await ownVehicles(gc, user.id)) {
    const st = appStates(v);
    const subtitle = clip(v.name || v.model || t(lang, 'portal.vehicle'), 60);
    const device = deviceOf(v, lang);
    const add = (kind, extra) => out.push({ id: `${kind}:${v.id}`, title: t(lang, 'qa.' + kind), subtitle, icon: QA_ICONS[kind], device, ...extra });
    const toggle = (kind, extra) => add(kind, { kind: 'toggle', ...(st[kind] ? { state: st[kind] } : {}), verbs: verbsOf(kind, lang), targets: true, ...extra });
    toggle('climate', { widget: vehicleWidget(v, lang, st) });
    if ((v.state && v.state.soc != null) || st.charging) toggle('charging');
    toggle('windowheat');
    if (await store.getSpin(gc, v.account_id)) add('lock', { ...lockAction(lang, st, automation), verbs: verbsOf('lock', lang), targets: true });
    if (out.length >= QA_MAX) break;
  }
  return out.slice(0, QA_MAX);
}

/** What setting each state of a toggle is called as a command (GateControl ≥ 1.173.0): { on, off }. */
function verbsOf(kind, lang) {
  return { on: t(lang, `qa.verb_${kind}_on`), off: t(lang, `qa.verb_${kind}_off`) };
}

/**
 * The command an action sends now, with its args and the state it aims for. Without a target a
 * toggle switches the shown state over (locked → unlock, else → lock); with a target ('on' | 'off',
 * GateControl ≥ 1.173.0) always the command for that state, whatever the vehicle shows.
 */
function commandFor(kind, v, target) {
  const st = appStates(v);
  // the lock: locked → unlock, else (unlocked or unknown) → lock
  const want = target === 'on' || target === 'off' ? target : (kind === 'lock' ? (st.lock === 'on' ? 'off' : 'on') : (st[kind] === 'on' ? 'off' : 'on'));
  if (kind === 'climate') {
    if (want === 'off') return { action: 'ac_stop', args: {}, state: 'off' };
    const c = Number(v.state && v.state.climate && v.state.climate.targetC);
    return { action: 'ac_start', args: { temp: Number.isFinite(c) && c >= 15.5 && c <= 30 ? c : 21 }, state: 'on' }; // like the portal
  }
  if (kind === 'charging') return want === 'off' ? { action: 'charge_stop', args: {}, state: 'off' } : { action: 'charge_start', args: {}, state: 'on' };
  if (kind === 'windowheat') return want === 'off' ? { action: 'window_heat_stop', args: {}, state: 'off' } : { action: 'window_heat_start', args: {}, state: 'on' };
  return want === 'off' ? { action: 'unlock', args: {}, state: 'off' } : { action: 'lock', args: {}, state: 'on' };
}

const PENDING = Symbol('pending');

/**
 * Run one quick action with the portal's checks (signed in, owner). A command
 * that takes longer than the budget (queued behind the account's sync) is
 * answered "on its way" without a state and finishes in the background.
 */
async function runQuickActionFor(gc, user, lang, id, target) {
  const started = Date.now();
  const m = typeof id === 'string' ? QA_ID_RE.exec(id) : null;
  if (!m || !user || !Number.isInteger(user.id)) return { ok: false, message: t(lang, 'qa.unknown') };
  const [, kind, raw] = m;
  const vid = Number(raw);
  try {
    if (user.loggedIn !== true) throw fail('LOGIN_REQUIRED');
    if (!(await store.isOwner(gc, vid, user.id))) throw fail('SKODA_NOT_OWNER');
    const v = await store.getVehicle(gc, vid);
    if (!v) throw fail('SKODA_VEHICLE_NOT_FOUND');
    const c = commandFor(kind, v, target);
    const name = clip(v.name || v.model || t(lang, 'portal.vehicle'), 40);
    const run = control.runCommand(gc, vid, c.action, c.args); // its refresh runs on in the background
    let timer = null;
    const budget = new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, qaBudgetMs - (Date.now() - started)), PENDING); });
    const first = await Promise.race([run, budget]).finally(() => clearTimeout(timer));
    if (first === PENDING) {
      run.catch((e) => logError(gc, 'quick action failed late', id, e));
      return { ok: true, message: clip(t(lang, 'qa.pending', { name }), 120) };
    }
    const out = { ok: true, message: clip(t(lang, `qa.${kind}${c.state ? '_' + c.state : ''}_sent`, { name }), 120) };
    if (c.state) out.state = c.state;
    return out;
  } catch (e) {
    if (!(e && Object.prototype.hasOwnProperty.call(ERRORS, e.code))) logError(gc, 'quick action failed', id, e);
    return { ok: false, message: clip(errorResponse(e, lang).json.error, 120) };
  }
}

// ─── Routes ─────────────────────────────────────

function vehicleId(seg) {
  const id = posInt(seg);
  if (!id) throw fail('NOT_FOUND');
  return id;
}

/**
 * GET …/image?part=N (N from 0, default 0): one part of the render,
 * { ok, type, part, parts, size, data } — the page loads part 0 … parts-1
 * and joins the base64 slices (one answer stays well under the host's 1 MB).
 * No image or no such part → NOT_FOUND; a malformed part → SKODA_VALIDATION.
 */
async function imageAnswer(gc, id, query) {
  const raw = query && query.part;
  let part = 0;
  if (raw !== undefined && raw !== null) {
    part = typeof raw === 'number' ? raw : (typeof raw === 'string' && /^(0|[1-9][0-9]{0,5})$/.test(raw) ? Number(raw) : NaN);
    if (!Number.isInteger(part) || part < 0) throw fail('SKODA_VALIDATION');
  }
  const out = await store.imagePart(gc, id, part);
  if (!out) throw fail('NOT_FOUND');
  return { json: { ok: true, ...out } };
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
  if (m === 'GET' && seg[3] === 'image') return imageAnswer(gc, id, req.query);
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
    if (c === 'image' && m === 'GET') return imageAnswer(gc, id, req.query);
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
  alerts.reset();
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
      if (!(e && Object.prototype.hasOwnProperty.call(ERRORS, e.code))) logError(gc, 'request failed', req.method, req.path, e);
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

  /** Quick actions of the apps: the portal's vehicle controls for a signed-in owner, at most 16. */
  async quickActions({ user, lang }, gc) {
    return quickActionsFor(gc, user, lang);
  },

  /**
   * Runs one of them (the host only passes an id quickActions just listed for this viewer; checked here again).
   * `target` 'on' | 'off' (GateControl ≥ 1.173.0, a rule or app asking for a state): the command for that state.
   */
  async runQuickAction({ user, lang, id, target }, gc) {
    return runQuickActionFor(gc, user, lang, id, target === 'on' || target === 'off' ? target : undefined);
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
  /** Tests: the time budget of runQuickAction in ms (null: the default 8 s). */
  _setQuickActionBudgetForTest(ms) { qaBudgetMs = ms == null ? QA_BUDGET_MS : ms; },
};
