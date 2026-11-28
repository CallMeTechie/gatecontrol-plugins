'use strict';

// gatecontrol-door — "Tür & Kamera": Nuki smart locks / openers (local
// bridge or Nuki Web) and Ring doorbells / cameras (UNOFFICIAL Ring API,
// "inoffiziell, ohne Gewähr" — server/ring.js) in GateControl.
//
//   person API (app tab, portal tab)  — server/api.js
//   admin API  admin/* (admin pages)  — server/admin.js
//   every action                      — server/control.js (rights, time window, rate limit, history)
//   quick actions (apps, widget, notification buttons, other plugins' automation)
//   Ring location modes (Inaktiv / Zuhause / Abwesend) — server/modes.js
//
// Background (every 5 s, GateControl ≥ 1.169.0): the Ring event poll
// (server/cameras.js), Nuki polling every 30 s per bridge / Nuki Web account
// (10 s while an automatic unlock waits for the door, at once after an
// action), safety notices and the automatic re-lock (server/safety.js), the
// Nuki Web log import (every 2 min), the Ring mode poll (every minute),
// retention (hourly).

const ui = require('./ui');
const api = require('./api');
const admin = require('./admin');
const config = require('./config');
const store = require('./store');
const locks = require('./locks');
const rights = require('./rights');
const cameras = require('./cameras');
const control = require('./control');
const safety = require('./safety');
const history = require('./history');
const nuki = require('./nuki');
const ring = require('./ring');
const modes = require('./modes');
const push = require('./push');
const home = require('./home');
const battery = require('./battery');
const texts = require('./texts.json');
const { STATUS, isKnown, clip } = require('./util');

function t(lang, key, params) {
  const l = lang === 'en' ? 'en' : 'de';
  let s = (texts[l] && texts[l][key]) || texts.de[key] || key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{{${k}}}`).join(String(v));
  return s;
}

function errorResponse(e, lang) {
  const code = isKnown(e) ? e.code : 'internal';
  // texts may name a value of the error (Ring's HTTP status, the mode Ring reports)
  const params = { ...((e && e.extra) || {}) };
  if (params.mode != null) params.mode = modes.modeName(t, lang === 'en' ? 'en' : 'de', params.mode);
  const json = { ok: false, code, error: t(lang, 'error.' + code, params) };
  if (e && e.extra) for (const [k, v] of Object.entries(e.extra)) if (!(k in json)) json[k] = v;
  return { status: STATUS[code], json };
}

const state = { ticking: false, lastPurge: 0, lastLogImport: 0 };
const PURGE_EVERY_MS = 3600000;
const LOG_IMPORT_EVERY_MS = 120000;

const ICONS = Object.freeze({
  lock: 'M7 11V7a5 5 0 0 1 10 0v4M5 11h14v10H5z',
  unlock: 'M7 11V7a5 5 0 0 1 9.9-1M5 11h14v10H5z',
  open: 'M5 21V4a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v17M3 21h18M15 12h.01',
});
const QA_ID_RE = /^(\d{1,9}):(lock|unlock|open|toggle)$/;
// 1.11.0: how the lock switch looks per state (on = zugesperrt, off = aufgesperrt) — like the vehicle's lock
const TOGGLE_LOOK = Object.freeze({ on: { icon: ICONS.lock, tone: 'good' }, off: { icon: ICONS.unlock, tone: 'warn' } });
// states the switch shows as aufgesperrt / moving towards one side (the icon while the state is not on / off)
const OFF_STATES = new Set(['unlocked', 'unlatched']);
const OPEN_ICON_STATES = new Set(['unlocked', 'unlatched', 'unlocking', 'unlatching']);
const QA_MAX = 16;
const QA_MODE_LOCATIONS = 4; // at most 4 Ring locations (8 actions); the locks get the rest

/** Nuki Web log → history (keypad / manual operations), entries after the lock was added. */
async function importNukiLog(gc, now) {
  const token = await locks.webToken(gc);
  if (!token) return;
  for (const lock of (await locks.all(gc)).filter((l) => l.source === 'web')) {
    const row = await store.one(gc, 'SELECT created_at FROM locks WHERE id = ?', [lock.id]);
    let entries = [];
    try { entries = await nuki.webLog(gc, token, lock, 20); } catch (e) { gc.log.debug('nuki log failed', (e && e.code) || 'error'); continue; }
    for (const e of entries) {
      if (!row || e.at < row.created_at || e.at > now + 60000) continue;
      await store.tx(gc, () => history.add(gc, { at: e.at, kind: 'nuki', lockId: lock.id, userName: e.name, via: e.via, action: e.action, result: 'ok', extId: e.extId }));
    }
  }
}

async function background(gc, now) {
  const cfg = await config.load(gc);
  const step = async (name, fn) => {
    try { await fn(); } catch (e) { gc.log.warn('background step failed', name, (e && e.code) || (e && e.message) || 'error'); }
  };
  await step('ring', () => cameras.tick(gc, cfg, now));
  await step('ringmode', () => modes.tick(gc, cfg, now, cameras.blocked(now)));
  await step('nuki', async () => {
    const fast = await safety.pendingSources(gc);
    const polled = await locks.poll(gc, now, { fast });
    if (polled.length) await safety.check(gc, cfg, now);
  });
  await step('relock', () => safety.autoRelock(gc, cfg, now, t));
  if (cfg.nukiLogImport && now - state.lastLogImport >= LOG_IMPORT_EVERY_MS) {
    state.lastLogImport = now;
    await step('nukilog', () => importNukiLog(gc, now));
  }
  if (now - state.lastPurge >= PURGE_EVERY_MS) {
    state.lastPurge = now;
    // 1.7.2: at most a batch of pictures per run; more of them with the next background run, not in an hour
    await step('purge', async () => { if ((await store.tx(gc, () => history.purge(gc, now, cfg.mediaDays))).more) state.lastPurge = 0; });
  }
}

/**
 * Is the viewer one the apps' quick actions may serve (app owner, another plugin's automation, or — 1.3.0 —
 * a person's tap in another plugin: GateControl's interactive run, e.g. „Tür öffnen“ on the Messenger's
 * doorbell card: user.interactive true, automation false, via the calling plugin)?
 */
function qaViewer(user) {
  if (!user || !Number.isSafeInteger(user.id)) return null;
  if (user.automation === true) return 'automation';
  if (user.interactive === true && user.kiosk !== true) return 'interactive';
  if (user.app === true && user.loggedIn !== false && user.kiosk !== true) return 'app';
  return null;
}

/** The shown state as text: "Zustand unklar – zuletzt: …", or only "Zustand unklar" when no stable state was ever seen. */
function stateLabel(lang, shown) {
  if (!shown.stale) return t(lang, 'state.' + shown.state);
  return shown.state === 'unknown' ? t(lang, 'state.unclear') : t(lang, 'state.stale', { state: t(lang, 'state.' + shown.state) });
}

/**
 * The widget of a lock (1.8.0), carried by its first action — only when the lock reports its battery: the state as
 * the value, the door sensor (or "Zustand unklar") as the status, the battery as the badge right of the lock's name;
 * nothing to control, no on / off.
 */
function lockWidget(lang, lock, shown) {
  const s = lock.state || {};
  const badge = battery.badge(t, lang, s);
  if (!badge) return null;
  const reachable = s.reachable !== false;
  let state = null;
  if (!reachable || shown.state === 'jammed') state = 'crit';
  else if (shown.stale) state = 'warn';
  else if (shown.state === 'locked') state = 'good';
  else if (shown.state === 'unlocked' || shown.state === 'unlatched') state = 'warn';
  return {
    label: null, value: clip(reachable ? t(lang, shown.stale ? 'state.unclear' : 'state.' + shown.state) : t(lang, 'qa.unreachable'), 24) || null,
    // the status: "Zustand unklar – zuletzt: …" when unclear, else the door sensor ("Tür zu") when the lock has one
    status: clip(shown.stale ? stateLabel(lang, shown) : (lock.door_sensor && s.door ? t(lang, 'door.' + s.door) : ''), 60) || null,
    state, readings: [], controls: [], power: false, badge,
  };
}

/**
 * The switch of a lock (1.11.0, id `<id>:toggle`, the apps only): on = zugesperrt, off = aufgesperrt, no state while
 * it moves, is unclear, blocked or not reachable. The title is the state („Zugesperrt“; with several locks
 * „Haustür: Zugesperrt“), the subtitle the lock's name with the door sensor, it carries the lock's widget (the battery
 * as the badge) and asks before aufsperren (confirmWhen off) — like „Verriegelt“ of a car.
 */
function lockToggle(lang, lock, shown, device, named) {
  const s = lock.state || {};
  const reachable = s.reachable !== false;
  const stable = reachable && !shown.stale;
  const on = stable && shown.state === 'locked';
  const off = stable && OFF_STATES.has(shown.state);
  let word;
  if (!reachable) word = t(lang, 'qa.unreachable');
  else if (shown.stale) word = t(lang, 'state.unclear');
  else word = t(lang, 'state.' + shown.state);
  const name = clip(lock.name, 40) || t(lang, 'qa.device_lock');
  const title = clip(named ? t(lang, 'qa.toggle_named', { name, state: word }) : word, 40);
  // the subtitle: the name, then the door sensor ("Tür offen") or what was last seen while unclear
  const extra = shown.stale && reachable ? (shown.state === 'unknown' ? '' : t(lang, 'qa.toggle_last', { state: t(lang, 'state.' + shown.state) }))
    : (reachable && lock.door_sensor && s.door && s.door !== 'unknown' ? t(lang, 'door.' + s.door) : '');
  const a = {
    id: `${lock.id}:toggle`, title, subtitle: clip(extra ? `${name} · ${extra}` : name, 60) || null,
    icon: !shown.stale && OPEN_ICON_STATES.has(shown.state) ? ICONS.unlock : ICONS.lock,
    kind: 'toggle', look: TOGGLE_LOOK, confirm: true, confirmWhen: 'off',
    verbs: { on: t(lang, 'qa.verb_lock'), off: t(lang, 'qa.verb_unlock') }, targets: true, device,
  };
  if (on || off) a.state = on ? 'on' : 'off';
  return a;
}

async function quickActionsFor(gc, user, lang) {
  const kind = qaViewer(user);
  if (!kind) return [];
  const r = await rights.load(gc);
  // Ring mode per location the person may switch: the toggle Zuhause ⇄ Abwesend (with targets, so a
  // rule sets a fixed mode) and the button "Inaktiv"
  const ringModes = [];
  for (const row of (await modes.forUser(gc, user, r)).slice(0, QA_MODE_LOCATIONS)) ringModes.push(...modes.quickActions(t, lang, row));
  const mine = [];
  for (const lock of await locks.all(gc)) {
    const level = rights.levelOf(r, user.id, lock.id);
    if (level) mine.push({ lock, level });
  }
  // 1.11.0: in the apps a lock's zusperren / aufsperren are one switch; rules (automation) and other plugins' buttons
  // (interactive) keep the two buttons — their stored ids stay valid
  const switchOf = (x) => kind === 'app' && locks.hasToggle(x.lock) && rights.atLeast(x.level, rights.NEEDS.lock) && rights.atLeast(x.level, rights.NEEDS.unlock);
  const named = mine.filter(switchOf).length > 1;
  const out = [];
  for (const x of mine) {
    const { lock, level } = x;
    const opener = nuki.isOpener(lock.device_type);
    const shown = locks.displayState(lock, Date.now());
    const sub = clip(stateLabel(lang, shown), 60) || null;
    // the apps group a lock's actions (GateControl ≥ 1.172.0; older hosts drop the field)
    const device = { id: `lock:${lock.id}`, title: clip(lock.name, 40) || t(lang, opener ? 'qa.device_opener' : 'qa.device_lock'), icon: opener ? ICONS.open : ICONS.lock };
    let widget = lockWidget(lang, lock, shown);
    const toggle = switchOf(x);
    if (toggle) {
      const action = lockToggle(lang, lock, shown, device, named);
      // the battery on the switch, inside the one button
      if (widget) { action.widget = widget; widget = null; }
      out.push(action);
    }
    for (const a of lock.actions) {
      if (toggle && (a === 'lock' || a === 'unlock')) continue;
      if (!rights.atLeast(level, rights.NEEDS[a])) continue;
      if (kind === 'automation' && a === 'open') continue;
      const key = a === 'open' && opener ? 'buzz' : a;
      const action = { id: `${lock.id}:${a}`, title: clip(t(lang, 'qa.' + key, { name: lock.name }), 40), subtitle: sub, icon: ICONS[a], kind: 'button', confirm: a !== 'lock', device };
      // the battery (1.8.0): on the lock's first action, like a device's widget
      if (widget) { action.widget = widget; widget = null; }
      out.push(action);
    }
  }
  return [...out.slice(0, QA_MAX - ringModes.length), ...ringModes];
}

/**
 * What a run of the lock switch does: a target ('on' zusperren, 'off' aufsperren — exactly that); a push button
 * („Zusperren“, „Wieder zusperren“) only locks; a tap in the app switches over: zugesperrt → aufsperren, everything else
 * (aufgesperrt, moving, unclear, not reachable) → zusperren.
 */
function toggleAction(lock, target, via) {
  if (target === 'on') return 'lock';
  if (target === 'off') return 'unlock';
  if (via !== 'app') return 'lock';
  const shown = locks.displayState(lock, Date.now());
  return lock.state && lock.state.reachable !== false && !shown.stale && shown.state === 'locked' ? 'unlock' : 'lock';
}

/**
 * A Ring mode action → { ok, message[, state, widget] }: the button "Inaktiv" (m[1] 'disarmed'), or the
 * toggle (m[1] undefined) — its widget's choice (control 'mode'), a target ('on' away, 'off' home) or
 * a plain run (away → home, home → away, disarmed / unknown → home).
 */
async function runModeAction(gc, a, m, { lang, viewer, via, caller }) {
  const id = m[2];
  const toggle = !m[1];
  let mode = m[1];
  if (a.control !== undefined) {
    if (!toggle || a.control !== 'mode' || !modes.MODES.includes(a.value)) return { ok: false, message: t(lang, 'error.invalid') };
    mode = a.value;
  } else if (toggle) {
    const target = a.target === 'on' || a.target === 'off' ? a.target : null;
    const row = target ? null : await modes.get(gc, id);
    mode = modes.toggleMode(row ? row.mode : null, target);
  }
  try {
    const cfg = await config.load(gc);
    const out = await modes.perform(gc, { cfg, t, lang, now: Date.now(), via, caller }, viewer, id, mode);
    if (!toggle) return { ok: true, message: out.message };
    return { ok: true, message: out.message, state: modes.toggleState(out.location.mode), widget: modes.widgetOf(t, lang, out.location) };
  } catch (e) {
    if (!isKnown(e)) gc.log.warn('quick action failed', a.id, (e && (e.code || e.message)) || 'error');
    return { ok: false, message: errorResponse(e, lang).json.error };
  }
}

async function runQuickActionFor(gc, arg) {
  const a = arg || {};
  const lang = a.lang === 'en' ? 'en' : 'de';
  const user = a.user;
  // GateControl ≥ 1.169.0: { automation } is true only for another plugin's gc.actions.run (user.automation as well)
  const automation = a.automation === true || !!(user && user.automation === true);
  // 1.3.0: an interactive run (a person tapped the action in another plugin, e.g. the Messenger's chat card)
  const interactive = !automation && !!(user && user.interactive === true);
  const m = typeof a.id === 'string' ? QA_ID_RE.exec(a.id) : null;
  const mm = typeof a.id === 'string' ? modes.QA_RE.exec(a.id) : null;
  const kind = automation ? (user && Number.isSafeInteger(user.id) ? 'automation' : null) : qaViewer(user);
  if ((!m && !mm) || !kind) return { ok: false, message: t(lang, 'error.not_found') };
  const viewer = automation ? { ...user, automation: true, app: false } : { ...user, automation: false };
  const via = automation ? 'automation' : (interactive ? 'chat' : (a.via === 'notification' ? 'notification' : 'app'));
  const pluginVia = (v) => (typeof v === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v) && v !== 'app' && v !== 'notification' ? v : null);
  const caller = automation ? (typeof a.via === 'string' && a.via !== 'app' && a.via !== 'notification' ? a.via : (user.via || null))
    : (interactive ? pluginVia(user.via) || pluginVia(a.via) : null);
  if (mm) return runModeAction(gc, a, mm, { lang, viewer, via, caller });
  try {
    const cfg = await config.load(gc);
    let action = m[2];
    if (action === 'toggle') {
      // the switch is the apps' own (1.11.0): never for rules or other plugins' buttons
      const lock = kind === 'app' ? await locks.get(gc, Number(m[1])) : null;
      if (!lock || !locks.hasToggle(lock)) return { ok: false, message: t(lang, 'error.not_found') };
      action = toggleAction(lock, a.target, via);
    }
    const out = await control.perform(gc, { cfg, t, lang, now: Date.now(), via, caller }, viewer, Number(m[1]), action);
    if (m[2] !== 'toggle') return { ok: true, message: out.message };
    const res = { ok: true, message: out.message, state: action === 'lock' ? 'on' : 'off' };
    const widget = lockWidget(lang, out.lock, locks.displayState(out.lock, Date.now()));
    if (widget) res.widget = widget;
    return res;
  } catch (e) {
    if (!isKnown(e)) gc.log.warn('quick action failed', a.id, (e && (e.code || e.message)) || 'error');
    return { ok: false, message: errorResponse(e, lang).json.error };
  }
}

module.exports = {
  async start(gc) {
    push.reset();
    ring.reset();
    locks.reset();
    cameras.reset();
    modes.reset();
    control.reset();
    state.lastPurge = 0;
    state.lastLogImport = 0;
    // 1.6.0: Kameras im Heimnetz — push with a snapshot for people (server/home.js); older GateControl: no gc.cameras
    if (gc.cameras) gc.cameras.on((ev) => home.onEvent(gc, ev, t).catch((e) => gc.log.warn('camera event failed', (e && e.code) || 'error')));
    gc.log.info('door started', gc.plugin.version);
  },

  async request(req, gc) {
    const lang = req && req.lang;
    try {
      const seg = String(req.path || '/').split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
      if (!seg.length) return errorResponse({ code: 'not_found' }, lang);
      const cfg = await config.load(gc);
      const now = Date.now();
      if (seg[0] === 'admin') {
        // admin pages only: an administrator in GateControl's admin UI, never a portal or app caller
        if (!req.user || req.user.portal || req.user.app || req.user.automation || req.user.role !== 'admin') return errorResponse({ code: 'forbidden' }, lang);
        return { status: 200, json: { ok: true, ...(await admin.route(req, gc, seg, cfg, now, t)) } };
      }
      return { status: 200, json: { ok: true, ...(await api.route(req, gc, seg, cfg, now, t)) } };
    } catch (e) {
      if (!isKnown(e)) gc.log.warn('request failed', req && req.method, String((req && req.path) || '').split('/').slice(0, 3).join('/'), (e && (e.code || e.message)) || 'error');
      return errorResponse(e, lang);
    }
  },

  async render(view, gc) {
    return { html: ui.render(view || {}, t) };
  },

  /** The portal tab "Tür": people with a right on at least one lock or who may switch a Ring mode. */
  async portalVisible({ user, section } = {}, gc) {
    if (section) return false;
    return api.visibleFor(gc, user, { modes: true });
  },

  /** Start tiles: one per visible lock with its state (≤ 8). */
  async portalTiles({ user, lang } = {}, gc) {
    if (!user || !Number.isSafeInteger(user.id)) return [];
    const r = await rights.load(gc);
    const out = [];
    for (const lock of await locks.all(gc)) {
      if (!rights.levelOf(r, user.id, lock.id)) continue;
      const s = lock.state;
      const shown = locks.displayState(lock, Date.now());
      const st = !s.reachable || s.state === 'jammed' ? 'crit' : (shown.stale ? 'warn' : (s.state === 'locked' ? 'good' : (s.state === 'unlocked' || s.state === 'unlatched' ? 'warn' : 'off')));
      const value = !s.reachable ? t(lang, 'portal.unreachable') : stateLabel(lang, shown);
      out.push({ title: clip(lock.name, 40), value: clip(value, 40), state: st, icon: shown.state === 'locked' ? ICONS.lock : ICONS.unlock });
    }
    for (const row of await modes.forUser(gc, user, r)) {
      out.push({ title: clip(t(lang, 'mode.tile', { name: row.name }), 40), value: clip(modes.modeName(t, lang, row.mode), 40), state: modes.TONE[row.mode] || null, icon: modes.ICONS[row.mode] || modes.ICONS.device });
    }
    return out.slice(0, 8);
  },

  /** The app tab (ui.app): people with a right on at least one lock (appVisible(user) or appVisible({ user })). */
  async appVisible(arg, gc) {
    const user = arg && typeof arg === 'object' && arg.user && typeof arg.user === 'object' ? arg.user : arg;
    return api.visibleFor(gc, user);
  },

  /**
   * Quick actions of the apps: per lock and right — the switch zugesperrt ⇄ aufgesperrt (1.11.0) and öffnen (opener:
   * Summer); for rules and other plugins the buttons zusperren / aufsperren / öffnen as before.
   */
  async quickActions({ user, lang } = {}, gc) {
    return quickActionsFor(gc, user, lang === 'en' ? 'en' : 'de');
  },

  /** Runs one (app, notification button, or another plugin's automation) — checked again in control.perform. */
  async runQuickAction(arg, gc) {
    return runQuickActionFor(gc, arg);
  },

  async tick(gc) {
    if (state.ticking) return;
    state.ticking = true;
    try { await background(gc, Date.now()); } finally { state.ticking = false; }
  },

  _state: state,
  _background: background,
  _t: t,
  ICONS,
};
