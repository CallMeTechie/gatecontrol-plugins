'use strict';

// gatecontrol-print — "Drucken & Scannen": the printers and scanners at home,
// usable from anywhere through GateControl (gc.print — the gateways find
// them, print over IPP and scan over eSCL; GateControl ≥ 1.236.0).
//
//   person API (portal tab)           — server/api.js
//   admin API  admin/* (admin pages)  — server/admin.js
//   rights per person                 — server/rights.js (checked before every job and scan)
//   printing, the history, notices    — server/jobs.js
//   scanning into Drive (AI name, searchable PDF) — server/scans.js, server/drive.js
//
// Background (every 30 s): the job states into the history, "Druck fertig /
// fehlgeschlagen" once per job; retention (hourly).

const ui = require('./ui');
const api = require('./api');
const admin = require('./admin');
const config = require('./config');
const rights = require('./rights');
const jobs = require('./jobs');
const scans = require('./scans');
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

const state = { ticking: false, lastPurge: 0 };
const PURGE_EVERY_MS = 3600000;

async function background(gc, now) {
  const cfg = await config.load(gc);
  if (!gc.print) return;
  try { await jobs.sync(gc, cfg, t, now); } catch (e) { gc.log.warn('job sync failed', (e && e.code) || (e && e.message) || 'error'); }
  // searchable PDFs: file the ones whose text recognition ended (also when nobody looks)
  try { await scans.advanceAll(gc, cfg, now); } catch (e) { gc.log.warn('searchable scans not carried on', (e && e.code) || 'error'); }
  if (now - state.lastPurge >= PURGE_EVERY_MS) {
    state.lastPurge = now;
    try { await jobs.purge(gc, cfg.historyDays, now); await scans.purge(gc, cfg.historyDays, now); } catch (e) { gc.log.warn('purge failed', (e && e.code) || 'error'); }
  }
}

module.exports = {
  async start(gc) {
    rights.reset();
    jobs.reset();
    state.lastPurge = 0;
    if (!gc.print) gc.log.warn('gc.print is missing — GateControl 1.236.0 or newer is needed');
    gc.log.info('print started', gc.plugin.version);
  },

  async request(req, gc) {
    const lang = req && req.lang === 'en' ? 'en' : 'de';
    try {
      const seg = String(req.path || '/').split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
      if (!seg.length) return errorResponse({ code: 'not_found' }, lang);
      if (!gc.print) return errorResponse({ code: 'offline' }, lang);
      const cfg = await config.load(gc);
      if (seg[0] === 'admin') {
        // admin pages only: an administrator in GateControl's admin UI, never a portal or app caller
        if (!req.user || req.user.portal || req.user.app || req.user.automation || req.user.role !== 'admin') return errorResponse({ code: 'forbidden' }, lang);
        return { status: 200, json: { ok: true, ...(await admin.route(req, gc, seg, cfg)) } };
      }
      return { status: 200, json: { ok: true, ...(await api.route(req, gc, seg, cfg, lang)) } };
    } catch (e) {
      if (!isKnown(e)) gc.log.warn('request failed', req && req.method, String((req && req.path) || '').split('/').slice(0, 3).join('/'), (e && (e.code || e.message)) || 'error');
      return errorResponse(e, lang);
    }
  },

  async render(view, gc) {
    return { html: ui.render(view || {}, t) };
  },

  /** The portal tab: people who may print or scan. */
  async portalVisible({ user, section } = {}, gc) {
    if (section) return false;
    return api.visibleFor(gc, user);
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
