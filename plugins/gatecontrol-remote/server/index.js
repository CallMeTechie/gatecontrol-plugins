'use strict';

// gatecontrol-remote — "Fernzugriff": the former Remote Desktops of GateControl
// as a shop plugin. GateControl keeps the transport (guacd, the tunnels, the
// session page, the key vault, the gateways' L4 ports, wake-on-LAN — gc.remote
// version 1); the plugin owns the devices, the rights, the history and the pages.
//
//   person API (portal tab, profile section)   — server/api.js
//   admin API  admin/* (admin pages)           — server/admin.js
//   devices with every setting                 — server/devices.js
//   rights per person and group, access lists  — server/rights.js
//   sessions (browser and apps)                — server/connect.js, server/history.js
//   the take-over of the built-in data         — server/legacy.js (hook legacyImport)
//   the old app API /api/v1/client/rdp*        — server/facade.js (hook clientFacade)
//   Windows PCs of the app (1.1, stage 2)      — server/hosts.js, codes.js, support.js, log.js
//                                                (gc.remote version 2: GateControl after 1.283.0)
//   SSH in GateControl's terminal with tmux,   — server/connect.js, server/recordings.js
//   recordings (1.2, stage 3)                    (gc.remote version 3; older GateControl: SSH over Guacamole, no recordings)
//
// Background (every 60 s): the device checks (every `checkMinutes`), sessions of
// apps that stopped reporting, requests and firewall rules that ran out, the
// retention of the history, of the sharing protocol and (1.2) of the recordings (hourly).

const ui = require('./ui');
const api = require('./api');
const admin = require('./admin');
const config = require('./config');
const rights = require('./rights');
const history = require('./history');
const connect = require('./connect');
const legacy = require('./legacy');
const facade = require('./facade');
const support = require('./support');
const codes = require('./codes');
const log = require('./log');
const recordings = require('./recordings');
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
  const params = { ...((e && e.extra) || {}) };
  const json = { ok: false, code, error: t(lang, 'error.' + code, params) };
  if (e && e.extra) for (const [k, v] of Object.entries(e.extra)) if (!(k in json)) json[k] = v;
  return { status: STATUS[code], json };
}

const state = { ticking: false, lastCheck: 0, lastPurge: 0, lastReconcile: 0, off: null };
const PURGE_EVERY_MS = 3600000;
const RECONCILE_EVERY_MS = 300000;

async function background(gc, now) {
  if (!gc.remote) return;
  const cfg = await config.load(gc);
  if (now - state.lastCheck >= cfg.checkMinutes * 60000) {
    state.lastCheck = now;
    try {
      const changed = await connect.probeAll(gc, now);
      if (changed.length && gc.events && typeof gc.events.emit === 'function') {
        // the portal tabs reload their list (who may see which device is checked there, the event names only ids)
        try {
          const users = ((await gc.users.list()) || []).map((u) => u.id).slice(0, 500);
          if (users.length) await gc.events.emit({ users, type: 'devices', data: { changed: changed.slice(0, 50).map((c) => c.id) } });
        } catch { /* nobody listens */ }
      }
    } catch (e) { gc.log.warn('device check failed', (e && e.code) || (e && e.message) || 'error'); }
  }
  try { await history.sweep(gc, now); } catch (e) { gc.log.warn('session sweep failed', (e && e.code) || 'error'); }
  try { await support.sweep(gc, now); } catch (e) { gc.log.warn('firewall sweep failed', (e && e.code) || 'error'); }
  if (now - state.lastReconcile >= RECONCILE_EVERY_MS) {
    state.lastReconcile = now;
    try { await history.reconcile(gc, now); } catch (e) { gc.log.debug('reconcile failed', (e && e.code) || 'error'); }
  }
  if (now - state.lastPurge >= PURGE_EVERY_MS) {
    state.lastPurge = now;
    try { await history.purge(gc, cfg.historyDays, now); } catch (e) { gc.log.warn('purge failed', (e && e.code) || 'error'); }
    try { await log.purge(gc, cfg.historyDays, now); await codes.purge(gc, now); } catch (e) { gc.log.warn('purge failed', (e && e.code) || 'error'); }
    try { await recordings.purge(gc, cfg.recordingDays, now); } catch (e) { gc.log.warn('recording purge failed', (e && e.code) || 'error'); }
  }
}

module.exports = {
  async start(gc) {
    rights.reset();
    codes.reset();
    state.lastCheck = 0;
    state.lastPurge = 0;
    state.lastReconcile = 0;
    if (!gc.remote || !(gc.remote.version >= 1)) {
      gc.log.warn('gc.remote is missing — GateControl 1.281.0 or newer is needed');
      return;
    }
    if (state.off) { try { state.off(); } catch { /* gone */ } }
    state.off = gc.remote.on('session', async (ev) => {
      try { await history.onEvent(gc, ev); } catch (e) { gc.log.warn('session event not recorded', (e && e.code) || 'error'); }
      // the firewall rule of a PC closes with its browser session
      try { await support.onSession(gc, ev); } catch (e) { gc.log.warn('firewall not closed', (e && e.code) || 'error'); }
    });
    if (!(gc.remote.version >= 2)) gc.log.info('gc.remote version 1: Windows PCs of the app need a newer GateControl');
    if (!(gc.remote.version >= 3)) gc.log.info('gc.remote version ' + gc.remote.version + ': the SSH terminal and recordings need a newer GateControl');
    if (!(gc.remote.version >= 4)) gc.log.info('gc.remote version ' + gc.remote.version + ': the screen of phones needs a newer GateControl');
    gc.log.info('remote started', gc.plugin.version);
  },

  async stop() {
    if (state.off) { try { state.off(); } catch { /* gone */ } state.off = null; }
  },

  async request(req, gc) {
    const lang = req && req.lang === 'en' ? 'en' : 'de';
    try {
      const seg = String(req.path || '/').split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
      if (!seg.length) return errorResponse({ code: 'not_found' }, lang);
      if (!gc.remote) return errorResponse({ code: 'offline' }, lang);
      const cfg = await config.load(gc);
      if (seg[0] === 'admin') {
        // admin pages only: an administrator in GateControl's admin UI, never a portal or app caller
        if (!req.user || req.user.portal || req.user.app || req.user.automation || req.user.role !== 'admin') return errorResponse({ code: 'forbidden' }, lang);
        return { status: 200, json: { ok: true, ...(await admin.route(req, gc, seg, cfg)) } };
      }
      return { status: 200, json: { ok: true, ...(await api.route(req, gc, seg, cfg)) } };
    } catch (e) {
      if (!isKnown(e)) gc.log.warn('request failed', req && req.method, String((req && req.path) || '').split('/').slice(0, 3).join('/'), (e && (e.code || e.message)) || 'error');
      return errorResponse(e, lang);
    }
  },

  async render(view, gc) {
    return { html: ui.render(view || {}, t) };
  },

  /** The portal tab and the profile section: people with a right to RDP / VNC, SSH or support codes (the profile section: everybody signed in). */
  async portalVisible({ user, section } = {}, gc) {
    if (section === 'rights') return !!(user && Number.isSafeInteger(user.id));
    if (section) return false;
    return api.visibleFor(gc, user);
  },

  /** Hook legacyImport: the built-in Remote Desktops (dataset "remote"). */
  async legacyImport(snapshot, gc) {
    return legacy.importSnapshot(snapshot, gc);
  },

  /** Hook clientFacade: the old app API /api/v1/client/rdp* after the take-over. */
  async clientFacade(payload, gc) {
    try {
      return await facade.handle(payload, gc, await config.load(gc));
    } catch (e) {
      gc.log.warn('facade failed', payload && payload.op, (e && (e.code || e.message)) || 'error');
      return { status: 500, body: { ok: false, error: 'internal' } };
    }
  },

  async tick(gc) {
    if (state.ticking) return;
    state.ticking = true;
    try { await background(gc, Date.now()); } finally { state.ticking = false; }
  },

  _state: state,
  _background: background,
  _t: t,
};
