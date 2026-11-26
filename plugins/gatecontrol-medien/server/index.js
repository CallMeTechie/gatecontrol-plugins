'use strict';

// gatecontrol-medien — "Medien": Jellyfin and the NAS shares set up once on the server; the GateControl apps on
// phones, TVs and PCs get the sources and their access automatically (App-API v1). The plugin never handles
// videos: it only lists sources, hands out the NAS password to allowed devices and confirms Quick Connect codes (away
// the devices play through the VPN over the source's route, see server/sources.js).
//
//   admin API  admin/*  (tabs Quellen, Personen, Geräte, the overview)   — server/admin.js
//   App API    v1/*     (apps with a device token)                     — server/app.js, server/cast.js
//   Jellyfin admin client (target "jellyfin")                          — server/jellyfin.js
//   sources, secrets, the network rule (home direct, away VPN)         — server/sources.js
//   rights "Medien" and per source, children                           — server/rights.js
//   person ↔ Jellyfin user                                             — server/mapping.js
//   pairings, deliveries, revocation, reconcile                        — server/devices.js
//   "Videos umwandeln" step 1: the list, admin/convert, v1/convert     — server/convert.js, server/convert-rules.js
//
// Background (every 60 s): the reconcile every 5 minutes (devices removed in GateControl, rights, mappings, the
// Jellyfin servers), the log's retention once an hour. With a GateControl that has the hook devicesChanged a removed
// device loses its Jellyfin access at once; the reconcile stays the safety net. The list "Umwandeln" scans Jellyfin
// once an administrator opened it (then changes every 30 minutes, all once a day) and watches /Sessions every 60 s.

const ui = require('./ui');
const app = require('./app');
const admin = require('./admin');
const config = require('./config');
const devices = require('./devices');
const rights = require('./rights');
const license = require('./license');
const log = require('./log');
const convert = require('./convert');
const texts = require('./texts.json');
const { STATUS, isKnown, deviceIdOf } = require('./util');

function t(lang, key, params) {
  const l = lang === 'en' ? 'en' : 'de';
  let s = (texts[l] && texts[l][key]) || texts.de[key] || key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{{${k}}}`).join(String(v));
  return s;
}

function errorResponse(e, lang) {
  const code = isKnown(e) ? e.code : 'internal';
  const json = { ok: false, v: 1, code, error: t(lang, 'error.' + code) };
  if (e && e.extra) for (const [k, v] of Object.entries(e.extra)) if (!(k in json)) json[k] = v;
  return { status: STATUS[code] || 500, json };
}

const RECONCILE_MS = 300000;
const PURGE_MS = 3600000;
const state = { ticking: false, lastReconcile: 0, lastPurge: 0 };

async function background(gc, now) {
  const cfg = await config.load(gc);
  if (now - state.lastReconcile >= RECONCILE_MS) {
    state.lastReconcile = now;
    rights.reset();
    try {
      const r = await devices.reconcile(gc, cfg, now);
      if (r.changed) await admin.changed(gc);
    } catch (e) { gc.log.warn('reconcile failed', (e && e.code) || (e && e.message) || 'error'); }
  }
  if (now - state.lastPurge >= PURGE_MS) {
    state.lastPurge = now;
    try { await log.purge(gc, cfg.logDays, now); } catch (e) { gc.log.debug('purge failed', (e && e.code) || 'error'); }
  }
  try { await convert.background(gc, now); } catch (e) { gc.log.debug('convert failed', (e && e.code) || 'error'); }
}

module.exports = {
  async start(gc) {
    state.lastReconcile = 0;
    state.lastPurge = 0;
    rights.reset();
    gc.log.info('medien started', gc.plugin && gc.plugin.version);
  },

  async request(req, gc) {
    const lang = req && req.lang === 'en' ? 'en' : 'de';
    try {
      const seg = String(req.path || '/').split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
      if (!seg.length) return errorResponse({ code: 'not_found', known: true }, lang);
      const cfg = await config.load(gc);
      if (seg[0] === 'admin') {
        if (!req.user || req.user.portal || req.user.app || req.user.automation || req.user.role !== 'admin') return errorResponse({ code: 'forbidden', known: true }, lang);
        return { status: 200, json: { ok: true, ...(await admin.route(req, gc, seg, cfg)) } };
      }
      if (seg[0] === 'v1') {
        const lic = await license.state(gc);
        if (!lic.ok) return errorResponse({ code: 'license_required', known: true, extra: { reason: lic.reason } }, lang);
        return { status: 200, json: { ok: true, ...(await app.route(req, gc, seg, cfg)) } };
      }
      return errorResponse({ code: 'not_found', known: true }, lang);
    } catch (e) {
      if (!isKnown(e)) gc.log.warn('request failed', req && req.method, String((req && req.path) || '').split('/').slice(0, 3).join('/'), (e && (e.code || e.message)) || 'error');
      return errorResponse(e, lang);
    }
  },

  async render(view, gc) {
    return { html: ui.render(view || {}, t) };
  },

  /** The app tab "Medien": the person has the right and sees at least one source (and the licence counts). */
  async appVisible(user, gc) {
    if (!(await license.state(gc)).ok) return false;
    const cfg = await config.load(gc);
    const sources = require('./sources');
    return (await rights.visibleSources(gc, user, await sources.list(gc), cfg)).length > 0;
  },

  /**
   * Hook devicesChanged (GateControl ≥ 1.322.0, permissions.devices; bundled at most once a second, no replay):
   * { removed: [{ id, userId, name, platform, clientType, reason }], added } — reason of a removed one: revoked |
   * user_disabled | user_deleted | owner_changed. The removed devices lose Jellyfin and the NAS access at once; an older
   * GateControl has no hook and the reconcile every 5 minutes does it.
   */
  async devicesChanged(payload, gc) {
    const removed = Array.isArray(payload && payload.removed) ? payload.removed : [];
    let any = false;
    for (const r of removed.slice(0, 500)) {
      const id = deviceIdOf(r && typeof r === 'object' ? r.id : r);
      if (!id) continue;
      const why = r && typeof r === 'object' ? r.reason : null;
      const reason = why === 'user_disabled' || why === 'user_deleted' ? 'user' : 'device_removed';
      const touched = await devices.revoke(gc, id, { reason, push: false });
      await require('./store').run(gc, 'UPDATE known_devices SET removed_at = ? WHERE device_id = ?', [Date.now(), id]);
      if (touched.length) any = true;
    }
    if (any) await admin.changed(gc);
  },

  async groupsChanged(_x, gc) {
    rights.reset();
    // a person left a group (e.g. lost the right through it): the next tick reconciles at once
    state.lastReconcile = 0;
    void gc;
  },

  async settingsChanged(_values, gc) {
    rights.reset();
    state.lastReconcile = 0;
    try { await admin.changed(gc); } catch { /* nobody listens */ }
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
