'use strict';

// gatecontrol-familie — "Familie": the family in the GateControl app (own tab,
// permissions.app + ui.app), the portal (own tab) and three admin pages.
//
//   member API (app, portal, plugin API) — see server/api.js
//   admin API  admin/* (administrators on the admin pages)  — see server/admin.js
//
// Modules (page "Funktionen", settings mod_*): shopping, tasks, stars, dates,
// locate, arrival_sos, places, rides, emergency, wall; 1.2.0 allowance,
// wishes, expenses, board, meals, presence — a module that is off answers 403
// module_off, sends nothing and keeps its data.
//
// Background (every minute): task, date and ride reminders, open rides,
// the 14th-birthday hint, expiry of locate requests, pocket money payouts
// (07:00 on the payout day), the grace time of the presence rule "all away"
// (quick actions of other plugins through gc.actions, permissions.actions,
// GateControl ≥ 1.166.0), retention (coordinates 7 days, log rows and place
// rule events 90 days,
// shopping tombstones and rides 30 days, expired pinboard notes, meals 90 days).
//
// The portal tab of a member with the role 'wall' is the wall view (a fixed
// tablet, module wall) — see server/wall.js. Wall members are the plugin's
// kiosk users (1.1.1, permissions.kiosk): reconciled on start, kept in step
// on every role change — see server/kiosk.js.

const ui = require('./ui');
const api = require('./api');
const admin = require('./admin');
const config = require('./config');
const members = require('./members');
const store = require('./store');
const tz = require('./tz');
const push = require('./push');
const shopping = require('./shopping');
const tasks = require('./tasks');
const dates = require('./dates');
const locate = require('./locate');
const safety = require('./safety');
const places = require('./places');
const rides = require('./rides');
const notices = require('./notices');
const kiosk = require('./kiosk');
const allowance = require('./allowance');
const board = require('./board');
const meals = require('./meals');
const presence = require('./presence');
const texts = require('./texts.json');
const { STATUS, isKnown } = require('./util');

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

const state = { ticking: false, lastPurge: 0 };
const PURGE_EVERY_MS = 3600000;

/** The viewer's member row ({ role }) when the account exists, else null. */
async function memberRow(gc, user) {
  if (!user || !Number.isSafeInteger(user.id)) return null;
  const row = await store.one(gc, 'SELECT user_id, role FROM members WHERE user_id = ?', [user.id]);
  if (!row) return null;
  const users = await members.usersById(gc);
  return users.has(user.id) ? row : null;
}

/**
 * Is there something for this viewer? Members: at least one module on. A wall
 * tablet: the module wall on, and never in the app (no app tab, no pushes).
 */
async function visibleFor(gc, user, { app = false } = {}) {
  const row = await memberRow(gc, user);
  if (!row) return false;
  const cfg = await config.load(gc);
  if (row.role === 'wall') return !app && cfg.modules.wall;
  return config.FAMILY_MODULES.some((m) => cfg.modules[m]);
}

/** Background steps; each in its own transaction, pushes after the commit. */
async function background(gc, now) {
  const cfg = await config.load(gc);
  const today = tz.localDate(now, cfg.tz);
  const fam = await members.load(gc, today);
  const pushes = [];
  const step = async (name, fn) => {
    try { await store.tx(gc, fn); } catch (e) { gc.log.warn('background step failed', name, (e && e.code) || (e && e.message) || 'error'); }
  };
  // a request left pending while the module was switched off ends as well
  await step('locate', () => locate.expire(gc, fam, cfg, now, cfg.modules.locate ? pushes : []));
  if (cfg.modules.tasks) await step('tasks', () => tasks.remind(gc, fam, cfg, now, pushes));
  if (cfg.modules.dates) await step('dates', () => dates.remind(gc, fam, cfg, now, pushes));
  if (cfg.modules.rides) await step('rides', () => rides.remind(gc, fam, cfg, now, pushes));
  if (cfg.modules.locate) await step('age14', () => members.ageHints(gc, fam, cfg, now, pushes));
  if (cfg.modules.allowance) await step('allowance', () => allowance.payout(gc, fam, cfg, now, pushes));
  if (cfg.modules.board) await step('board', () => board.purge(gc, now));
  if (cfg.modules.presence) {
    const runs = [];
    await step('presence', () => presence.tick(gc, fam, cfg, now, runs));
    if (runs.length) {
      try { await presence.execute(gc, fam, cfg, now, runs, pushes); } catch (e) { gc.log.warn('background step failed', 'presence_run', (e && e.code) || (e && e.message) || 'error'); }
    }
  }
  if (now - state.lastPurge >= PURGE_EVERY_MS) {
    state.lastPurge = now;
    await step('purge', async () => {
      await locate.purge(gc, now);
      await safety.purge(gc, now);
      await shopping.purge(gc, now);
      await places.purge(gc, now);
      await tasks.purge(gc, cfg, now);
      await dates.purge(gc, cfg, now);
      await rides.purge(gc, cfg, now);
      await notices.purge(gc, now);
      await meals.purge(gc, cfg, now);
      await presence.purge(gc, now);
    });
  }
  await push.flush(gc, pushes);
}

module.exports = {
  async start(gc) {
    push.reset();
    state.lastPurge = 0;
    try {
      const cfg = await config.load(gc);
      const k = await kiosk.reconcile(gc, tz.localDate(Date.now(), cfg.tz));
      if (k.allowed.length || k.removed.length) gc.log.info('kiosk users reconciled', k.allowed.length, k.removed.length);
    } catch (e) {
      gc.log.warn('kiosk reconcile failed', (e && e.code) || (e && e.message) || 'error');
    }
    gc.log.info('familie started', gc.plugin.version);
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
        if (!req.user || req.user.portal || req.user.app || req.user.role !== 'admin') return errorResponse({ code: 'forbidden' }, lang);
        return { status: 200, json: { ok: true, ...(await admin.route(req, gc, seg, cfg, now)) } };
      }
      return await api.route(req, gc, seg, cfg, now);
    } catch (e) {
      if (!isKnown(e)) gc.log.warn('request failed', req && req.method, String((req && req.path) || '').split('/').slice(0, 3).join('/'), (e && (e.code || e.message)) || 'error');
      return errorResponse(e, lang);
    }
  },

  async render(view, gc) {
    const v = view || {};
    if (v.view === 'portal' && !v.section) {
      // a wall tablet's portal tab is the wall view
      const row = await memberRow(gc, v.user).catch(() => null);
      if (row && row.role === 'wall') return { html: ui.render({ ...v, wall: true }, t) };
    }
    return { html: ui.render(v, t) };
  },

  /** The portal tab "Familie": members with at least one module on; a wall tablet with the module wall on. */
  async portalVisible({ user, section } = {}, gc) {
    if (section) return false;
    return visibleFor(gc, user);
  },

  /**
   * The app tab (ui.app): members only, with at least one module on — never a wall tablet.
   * Called as appVisible(user) or appVisible({ user, lang }) — both are accepted.
   */
  async appVisible(arg, gc) {
    const user = arg && typeof arg === 'object' && arg.user && typeof arg.user === 'object' ? arg.user : arg;
    return visibleFor(gc, user, { app: true });
  },

  async tick(gc) {
    if (state.ticking) return;
    state.ticking = true;
    try { await background(gc, Date.now()); } finally { state.ticking = false; }
  },

  _state: state,
  _background: background,
};
