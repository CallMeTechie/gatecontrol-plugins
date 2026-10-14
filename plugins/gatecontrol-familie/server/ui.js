'use strict';

// The admin pages (members, modules, log), the portal tab and — for a member
// with the role 'wall' — the wall tablet's view in that tab. The host shows
// plugin HTML only in a sandboxed frame (opaque origin, inline scripts and
// styles, no network of its own): the pages talk to this plugin's API
// through window.GC.call. Everything is read once from ui/.
//
// Maps (plugin.json ui.maps): GateControl serves its bundled Leaflet at a
// frame-loadable URL and allows the OpenStreetMap tiles in the frame. The
// URL is this ONE constant; the pages fall back to coordinates with an
// OpenStreetMap link when Leaflet cannot be loaded.

const fs = require('node:fs');
const path = require('node:path');
const texts = require('./texts.json');

const LEAFLET = Object.freeze({
  js: '/plugins/_shared/leaflet/leaflet.js',
  css: '/plugins/_shared/leaflet/leaflet.css',
});
const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

const UI = path.join(__dirname, '..', 'ui');
const read = (f) => fs.readFileSync(path.join(UI, f), 'utf8');
const PAGES = ['members', 'modules', 'log'];
const FILES = {
  css: read('style.css'),
  common: read('common.js'),
  map: read('map.js'),
  members: { html: read('members.html'), js: read('members.js'), map: true },
  modules: { html: read('modules.html'), js: read('modules.js'), map: false },
  log: { html: read('log.html'), js: read('log.js'), map: true },
  portal: { html: read('portal.html'), js: read('portal.js'), css: read('portal.css'), map: true },
  wall: { html: read('wall.html'), js: read('wall.js'), css: read('wall.css'), map: false },
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
 * @param {{view:'page'|'portal', page?:string, lang?:string, loggedIn?:boolean, user?:object, wall?:boolean}} view
 * @param {(lang:string, key:string) => string} t
 */
function render(view, t) {
  const v = view || {};
  const lang = v.lang === 'en' ? 'en' : 'de';
  const portal = v.view === 'portal';
  const pageId = portal ? (v.wall === true ? 'wall' : 'portal') : (PAGES.includes(v.page) ? v.page : 'members');
  const page = FILES[pageId];
  const loggedIn = portal ? (v.loggedIn === true || !!(v.user && v.user.loggedIn === true)) : true;
  const ctx = { lang, view: portal ? 'portal' : 'page', page: pageId, loggedIn, texts: texts[lang], leaflet: LEAFLET, tiles: TILES };
  return '<style>' + FILES.css + (page.css || '') + '</style>'
    + fill(page.html, t, lang)
    + '<script>window.FA_CTX=' + island(ctx) + ';</script>'
    + '<script>' + FILES.common + '</script>'
    + (page.map ? '<script>' + FILES.map + '</script>' : '')
    + '<script>' + page.js + '</script>';
}

module.exports = { render, esc, island, LEAFLET, TILES, PAGES };
