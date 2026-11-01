'use strict';

// The portal tab "Drive" and the admin pages (overview, people, teams — 0.3.0). The host shows plugin HTML only in a sandboxed frame (opaque origin, inline scripts and
// styles only — no external script, no network of its own, no storage): the page talks to this plugin's API through
// window.GC.call, uploads with GC.upload and gets live events with GC.on. Everything is inlined here, read once from
// ui/: portal.css · portal.html · DP_CTX · vaultcrypto.js · vault.js (vault folders, 1.9.0) · bulk.js (several at once,
// 1.12.0) · ki.js (AI in Drive, 1.14.0) · places.js (places and people, 1.16.0) · portal.js.
//
// Maps (since 1.16.0, plugin.json ui.maps): GateControl serves its bundled Leaflet at a frame-loadable URL and the
// OpenStreetMap tiles through its relay (window.GC.tiles); DP_CTX carries both URLs (as the Familie plugin does). The
// pages fall back to a list when Leaflet cannot be loaded.
//
// The portal tab is for a signed-in person only (never a kiosk device, never a viewer known only by device trust):
// the others get the page with loggedIn: false, which shows "Bitte melde dich an" and calls nothing.
// The section "Fotorahmen" (since 1.7.0, `section=frame` in the tab "Zuhause"): ui/frame.* — a slide show of the
// frame albums for a kiosk device (GET frame, frame.js); anyone else gets the page with kiosk: false and a note.

const fs = require('node:fs');
const path = require('node:path');
const texts = require('./texts.json');

const LEAFLET = Object.freeze({ js: '/plugins/_shared/leaflet/leaflet.js', css: '/plugins/_shared/leaflet/leaflet.css' });
const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

const UI = path.join(__dirname, '..', 'ui');
const read = (f) => fs.readFileSync(path.join(UI, f), 'utf8');

/** Text that goes into an inline <script>: it must not close the element or open an HTML comment. */
function inlineScript(name, src) {
  if (/<\/script|<!--/i.test(src)) throw new Error(`ui/${name} cannot be inlined (contains </script or <!--)`);
  return src;
}

const FILES = {
  css: read('portal.css'), html: read('portal.html'),
  js: inlineScript('vaultcrypto.js', read('vaultcrypto.js')) + '\n' + inlineScript('vault.js', read('vault.js')) + '\n' + inlineScript('bulk.js', read('bulk.js')) + '\n'
    + inlineScript('ki.js', read('ki.js')) + '\n' + inlineScript('places.js', read('places.js')) + '\n' + inlineScript('portal.js', read('portal.js')),
  admin: { css: read('admin.css'), html: read('admin.html'), js: inlineScript('admin.js', read('admin.js')) },
  frame: { css: read('frame.css'), html: read('frame.html'), js: inlineScript('frame.js', read('frame.js')) },
};
const PAGES = ['overview', 'people', 'teams'];

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** JSON for an inline <script>: no "</script>", no "<!--". */
function island(v) {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

const fill = (html, t, lang) => html.replace(/\{\{t:([a-z0-9_.-]+)\}\}/g, (_, k) => esc(t(lang, k)));

/** The page texts (p.* for the portal, a.* for the admin pages; err.*) of one language. */
function portalTexts(lang, prefix = 'p.') {
  const all = texts[lang];
  const out = {};
  for (const [k, v] of Object.entries(all)) if (k.startsWith(prefix) || k.startsWith('err.')) out[k] = v;
  for (const [k, v] of Object.entries(all)) if (k.startsWith('error.')) out['err.' + k.slice(6)] = out['err.' + k.slice(6)] || v;
  return out;
}

/**
 * @param {{view?: 'page'|'portal', lang?: string, loggedIn?: boolean, user?: object}} view
 * @param {(lang: string, key: string) => string} t
 */
function render(view, t) {
  const v = view || {};
  const lang = v.lang === 'en' ? 'en' : 'de';
  if (v.view !== 'portal') {
    // an admin page (GateControl's admin UI, administrators only)
    const pageId = PAGES.includes(v.page) ? v.page : 'overview';
    const a = FILES.admin;
    return '<style>' + FILES.css + a.css + '</style>'
      + fill(a.html, t, lang)
      + '<script>window.DA_CTX=' + island({ lang, page: pageId, texts: portalTexts(lang, 'a.') }) + ';</script>'
      + '<script>' + a.js + '</script>';
  }
  const u = v.user || {};
  if (v.section === 'frame') {
    // the photo frame of a kiosk device (frame.js answers GET frame to nobody else)
    const f = FILES.frame;
    const fctx = { lang, view: 'frame', kiosk: u.kiosk === true, texts: portalTexts(lang, 'f.') };
    return '<style>' + f.css + '</style>' + fill(f.html, t, lang)
      + '<script>window.DF_CTX=' + island(fctx) + ';</script>'
      + '<script>' + f.js + '</script>';
  }
  const loggedIn = (v.loggedIn === true || u.loggedIn === true) && u.kiosk !== true;
  const ctx = { lang, view: 'portal', loggedIn, viewer: Number.isSafeInteger(u.id) ? u.id : null, texts: portalTexts(lang), leaflet: LEAFLET, tiles: TILES };
  return '<style>' + FILES.css + '</style>'
    + fill(FILES.html, t, lang)
    + '<script>window.DP_CTX=' + island(ctx) + ';</script>'
    + '<script>' + FILES.js + '</script>';
}

module.exports = { render, esc, island, portalTexts, LEAFLET, TILES };
