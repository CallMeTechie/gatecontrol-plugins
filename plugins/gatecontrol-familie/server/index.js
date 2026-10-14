'use strict';

// gatecontrol-familie — "Familie": the family in the GateControl app (own tab,
// permissions.app + ui.app), the portal (own tab) and three admin pages.
//
//   member API (app, portal, plugin API) — see server/api.js
//   admin API  admin/* (administrators on the admin pages)  — see server/admin.js
//
// Modules (page "Funktionen", settings mod_*): shopping, tasks, stars, dates,
// locate, arrival_sos, places — a module that is off answers 403 module_off,
// sends nothing and keeps its data.
//
// Background (every minute): task and date reminders, expiry of locate
// requests, retention (coordinates 7 days, log rows 90 days, shopping
// tombstones 30 days).

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

/** Is the viewer a member and is at least one module on? (portal tab, app tab) */
async function visibleFor(gc, user) {
  if (!user || !Number.isSafeInteger(user.id)) return false;
  const cfg = await config.load(gc);
  if (!config.MODULES.some((m) => cfg.modules[m])) return false;
  const row = await store.one(gc, 'SELECT user_id FROM members WHERE user_id = ?', [user.id]);
  if (!row) return false;
  const users = await members.usersById(gc);
  return users.has(user.id);
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
  if (now - state.lastPurge >= PURGE_EVERY_MS) {
    state.lastPurge = now;
    await step('purge', async () => {
      await locate.purge(gc, now);
      await safety.purge(gc, now);
      await shopping.purge(gc, now);
      await places.purge(gc, now);
      await tasks.purge(gc, cfg, now);
      await dates.purge(gc, cfg, now);
    });
  }
  await push.flush(gc, pushes);
}

module.exports = {
  async start(gc) {
    push.reset();
    state.lastPurge = 0;
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
    return { html: ui.render(view, t) };
  },

  /** The portal tab "Familie": members only, with at least one module on. */
  async portalVisible({ user, section } = {}, gc) {
    if (section) return false;
    return visibleFor(gc, user);
  },

  /**
   * The app tab (ui.app): members only, with at least one module on.
   * Called as appVisible(user) or appVisible({ user, lang }) — both are accepted.
   */
  async appVisible(arg, gc) {
    const user = arg && typeof arg === 'object' && arg.user && typeof arg.user === 'object' ? arg.user : arg;
    return visibleFor(gc, user);
  },

  async tick(gc) {
    if (state.ticking) return;
    state.ticking = true;
    try { await background(gc, Date.now()); } finally { state.ticking = false; }
  },

  _state: state,
  _background: background,
};
