'use strict';

// gatecontrol-dns — "DNS-Schutz": the administration of GateControl's DNS protection for the VPN devices
// (gc.vpnDns, permissions.vpnDns; GateControl ≥ 1.264.0). GateControl filters — its own filter service behind the
// VPN's DNS; this plugin says what is blocked for whom, suspends the protection and reads the counters.
//
//   settings page admin/*  (administrators)       — server/admin.js
//   person API (apps, portal tab)                  — server/api.js
//   who may suspend for whom, how long             — server/rights.js
//   the plugin's own settings                      — server/config.js
//   notices (outage, end of a suspension, weekly)  — server/notices.js
//
// Background (every 15 min): the weekly report. Events (gc.vpnDns.on): outage and end of a suspension.

const ui = require('./ui');
const api = require('./api');
const admin = require('./admin');
const rights = require('./rights');
const notices = require('./notices');
const texts = require('./texts.json');
const { STATUS, isKnown, fromHost } = require('./util');

function t(lang, key, params) {
  const l = lang === 'en' ? 'en' : 'de';
  let s = (texts[l] && texts[l][key]) || texts.de[key] || key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{{${k}}}`).join(String(v));
  return s;
}

function errorResponse(err, lang) {
  const e = fromHost(err);
  const code = isKnown(e) ? e.code : 'internal';
  const extra = (e && e.extra) || {};
  const json = { ok: false, code, error: t(lang, 'error.' + code, extra) };
  for (const [k, v] of Object.entries(extra)) if (!(k in json)) json[k] = v;
  // why something is not allowed, in words (the apps show `error`)
  if (code === 'not_allowed' && extra.reason && texts.de['reason.' + extra.reason]) json.error = t(lang, 'reason.' + extra.reason);
  return { status: STATUS[code], json };
}

const state = { ticking: false, off: null };

module.exports = {
  async start(gc) {
    rights.reset();
    if (!gc.vpnDns) { gc.log.warn('gc.vpnDns is missing — GateControl 1.264.0 or newer is needed'); return; }
    if (state.off) { try { state.off(); } catch { /* gone */ } }
    state.off = gc.vpnDns.on((ev) => notices.onEvent(gc, t, ev).catch((e) => gc.log.warn('event not handled', ev && ev.type, (e && (e.code || e.message)) || 'error')));
    gc.log.info('dns protection started', gc.plugin.version);
  },

  async stop() {
    if (state.off) { try { state.off(); } catch { /* gone */ } state.off = null; }
  },

  async request(req, gc) {
    const lang = req && req.lang === 'en' ? 'en' : 'de';
    try {
      const seg = String(req.path || '/').split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
      if (!seg.length) return errorResponse({ code: 'not_found' }, lang);
      if (!gc.vpnDns) return errorResponse({ code: 'unsupported' }, lang);
      if (seg[0] === 'admin') {
        // the settings page only: an administrator in GateControl's admin UI, never a portal or app caller
        if (!req.user || req.user.portal || req.user.app || req.user.automation || req.user.role !== 'admin') return errorResponse({ code: 'forbidden' }, lang);
        return { status: 200, json: { ok: true, ...(await admin.route(req, gc, seg)) } };
      }
      return { status: 200, json: { ok: true, ...(await api.route(req, gc, seg)) } };
    } catch (e) {
      if (!isKnown(fromHost(e))) gc.log.warn('request failed', req && req.method, String((req && req.path) || '').split('/').slice(0, 3).join('/'), (e && (e.code || e.message)) || 'error');
      return errorResponse(e, lang);
    }
  },

  async render(view) {
    return { html: ui.render(view || {}, t) };
  },

  /** The portal tab: people with a VPN device of their own (and those who decide for others), while the protection is on. */
  async portalVisible({ user, section } = {}, gc) {
    if (section) return false;
    return api.visibleFor(gc, user);
  },

  /** A family changed: read the parents again. */
  async groupsChanged() {
    rights.reset();
  },

  async tick(gc) {
    if (state.ticking) return;
    state.ticking = true;
    try { await notices.weekly(gc, t, Date.now()); } catch (e) { gc.log.warn('weekly report failed', (e && (e.code || e.message)) || 'error'); } finally { state.ticking = false; }
  },

  _state: state,
  _t: t,
};
