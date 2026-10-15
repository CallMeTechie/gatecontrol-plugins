'use strict';

// gatecontrol-door — "Tür & Kamera": Nuki smart locks / openers (local
// bridge or Nuki Web) and Ring doorbells / cameras (UNOFFICIAL Ring API,
// "inoffiziell, ohne Gewähr" — server/ring.js) in GateControl.
//
//   person API (app tab, portal tab)  — server/api.js
//   admin API  admin/* (admin pages)  — server/admin.js
//   every action                      — server/control.js (rights, time window, rate limit, history)
//   quick actions (apps, widget, notification buttons, other plugins' automation)
//
// Background (every 5 s, GateControl ≥ 1.169.0): the Ring event poll
// (server/cameras.js), Nuki polling every 30 s per bridge / Nuki Web account
// (10 s while an automatic unlock waits for the door, at once after an
// action), safety notices and the automatic re-lock (server/safety.js), the
// Nuki Web log import (every 2 min), retention (hourly).

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
const push = require('./push');
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
  const json = { ok: false, code, error: t(lang, 'error.' + code) };
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
const QA_ID_RE = /^(\d{1,9}):(lock|unlock|open)$/;
const QA_MAX = 16;

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
    await step('purge', () => store.tx(gc, () => history.purge(gc, now, cfg.mediaDays)));
  }
}

/** Is the viewer one the apps' quick actions may serve (app owner or another plugin's automation)? */
function qaViewer(user) {
  if (!user || !Number.isSafeInteger(user.id)) return null;
  if (user.automation === true) return 'automation';
  if (user.app === true && user.loggedIn !== false && user.kiosk !== true) return 'app';
  return null;
}

async function quickActionsFor(gc, user, lang) {
  const kind = qaViewer(user);
  if (!kind) return [];
  const r = await rights.load(gc);
  const out = [];
  for (const lock of await locks.all(gc)) {
    const level = rights.levelOf(r, user.id, lock.id);
    if (!level) continue;
    const opener = nuki.isOpener(lock.device_type);
    const sub = clip(t(lang, 'state.' + lock.state.state), 60) || null;
    for (const a of lock.actions) {
      if (!rights.atLeast(level, rights.NEEDS[a])) continue;
      if (kind === 'automation' && a === 'open') continue;
      const key = a === 'open' && opener ? 'buzz' : a;
      out.push({ id: `${lock.id}:${a}`, title: clip(t(lang, 'qa.' + key, { name: lock.name }), 40), subtitle: sub, icon: ICONS[a], kind: 'button', confirm: a !== 'lock' });
    }
  }
  return out.slice(0, QA_MAX);
}

async function runQuickActionFor(gc, arg) {
  const a = arg || {};
  const lang = a.lang === 'en' ? 'en' : 'de';
  const user = a.user;
  // GateControl ≥ 1.169.0: { automation } is true only for another plugin's gc.actions.run (user.automation as well)
  const automation = a.automation === true || !!(user && user.automation === true);
  const m = typeof a.id === 'string' ? QA_ID_RE.exec(a.id) : null;
  const kind = automation ? (user && Number.isSafeInteger(user.id) ? 'automation' : null) : qaViewer(user);
  if (!m || !kind) return { ok: false, message: t(lang, 'error.not_found') };
  const viewer = automation ? { ...user, automation: true, app: false } : { ...user, automation: false };
  const via = automation ? 'automation' : (a.via === 'notification' ? 'notification' : 'app');
  const caller = automation ? (typeof a.via === 'string' && a.via !== 'app' && a.via !== 'notification' ? a.via : (user.via || null)) : null;
  try {
    const cfg = await config.load(gc);
    const out = await control.perform(gc, { cfg, t, lang, now: Date.now(), via, caller }, viewer, Number(m[1]), m[2]);
    return { ok: true, message: out.message };
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
    control.reset();
    state.lastPurge = 0;
    state.lastLogImport = 0;
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

  /** The portal tab "Tür": people with a right on at least one lock. */
  async portalVisible({ user, section } = {}, gc) {
    if (section) return false;
    return api.visibleFor(gc, user);
  },

  /** Start tiles: one per visible lock with its state (≤ 8). */
  async portalTiles({ user, lang } = {}, gc) {
    if (!user || !Number.isSafeInteger(user.id)) return [];
    const r = await rights.load(gc);
    const out = [];
    for (const lock of await locks.all(gc)) {
      if (!rights.levelOf(r, user.id, lock.id)) continue;
      const s = lock.state;
      const st = !s.reachable || s.state === 'jammed' ? 'crit' : (s.state === 'locked' ? 'good' : (s.state === 'unlocked' || s.state === 'unlatched' ? 'warn' : 'off'));
      out.push({ title: clip(lock.name, 40), value: clip(t(lang, s.reachable ? 'state.' + s.state : 'portal.unreachable'), 40), state: st, icon: s.state === 'locked' ? ICONS.lock : ICONS.unlock });
    }
    return out.slice(0, 8);
  },

  /** The app tab (ui.app): people with a right on at least one lock (appVisible(user) or appVisible({ user })). */
  async appVisible(arg, gc) {
    const user = arg && typeof arg === 'object' && arg.user && typeof arg.user === 'object' ? arg.user : arg;
    return api.visibleFor(gc, user);
  },

  /** Quick actions of the apps: per lock and right — zusperren / aufsperren / öffnen (opener: Summer). */
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
