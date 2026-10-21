'use strict';

// The page and the portal section "Fahrzeuge" (inside GateControl's
// "Fahrzeug" tab, ui.portal.sections; render gets view.section = 'skoda').
// The host shows plugin HTML only in a sandboxed frame (opaque origin, inline
// scripts/styles only, no network, images only as data: URLs): the page
// talks to this plugin's API through window.GC.call (the parent page adds
// the session, CSRF token and rate limit). Everything is read once from ui/.

const fs = require('node:fs');
const path = require('node:path');
const texts = require('./texts.json');

const UI = path.join(__dirname, '..', 'ui');
// Maps (plugin.json ui.maps, 1.6.0): GateControl serves its bundled Leaflet at
// this frame-loadable URL and relays the OpenStreetMap tiles (window.GC.tiles).
const LEAFLET = Object.freeze({ js: '/plugins/_shared/leaflet/leaflet.js', css: '/plugins/_shared/leaflet/leaflet.css' });
const read = (f) => fs.readFileSync(path.join(UI, f), 'utf8');
const FILES = {
  css: read('style.css'),
  common: read('common.js'),
  main: { html: read('admin.html'), js: read('admin.js') },
  // 1.6.0: the map module before the page script (SK.lbMap)
  logbook: { html: read('logbook.html'), js: read('lbmap.js') + '\n' + read('logbook.js') },
  portal: { html: read('portal.html'), js: read('portal.js'), css: read('portal.css') },
};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** JSON for an inline <script>: no "</script>", no "<!--". */
function island(v) {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** {{t:key}} → the escaped text in the viewer's language. */
function fill(html, t, lang) {
  return html.replace(/\{\{t:([a-z0-9_.-]+)\}\}/g, (_, k) => esc(t(lang, k)));
}

/**
 * The admin page "main" or "logbook", the portal section "skoda" or "logbook" (1.5.0).
 * @param {{view:'page'|'portal', page?:string, section?:string, lang?:string, loggedIn?:boolean}} view
 * @param {(lang:string, key:string) => string} t
 */
function render(view, t) {
  const lang = view && view.lang === 'en' ? 'en' : 'de';
  const portal = view && view.view === 'portal';
  const logbook = portal ? view.section === 'logbook' : view && view.page === 'logbook';
  const page = logbook ? FILES.logbook : (portal ? FILES.portal : FILES.main);
  const ctx = { lang, view: portal ? 'portal' : 'page', page: portal ? null : (logbook ? 'logbook' : 'main'), loggedIn: portal ? !!view.loggedIn : true, section: portal ? (logbook ? 'logbook' : 'skoda') : null, texts: texts[lang], leaflet: logbook ? LEAFLET : null };
  return '<style>' + FILES.css + (page.css || '') + '</style>'
    + fill(page.html, t, lang)
    + '<script>window.SK_CTX=' + island(ctx) + ';</script>'
    + '<script>' + FILES.common + '</script>'
    + '<script>' + page.js + '</script>';
}

module.exports = { render, esc, island };
