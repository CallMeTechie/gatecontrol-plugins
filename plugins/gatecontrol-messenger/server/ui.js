'use strict';

// The admin pages (overview, log) and the portal tab "Chats". The host shows
// plugin HTML only in a sandboxed frame (opaque origin, inline scripts and
// styles, no network of its own): the pages talk to this plugin's API through
// window.GC.call, upload with GC.upload, get live events with GC.on('event')
// and show files through signed /plugin-media/ URLs. Read once from ui/.

const fs = require('node:fs');
const path = require('node:path');
const texts = require('./texts.json');

const UI = path.join(__dirname, '..', 'ui');
const read = (f) => fs.readFileSync(path.join(UI, f), 'utf8');
const PAGES = ['overview', 'log'];
const FILES = {
  css: read('style.css'),
  common: read('common.js'),
  overview: { html: read('overview.html'), js: read('overview.js') },
  log: { html: read('log.html'), js: read('log.js') },
  portal: { html: read('portal.html'), js: read('portal.js'), css: read('portal.css') },
};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** JSON for an inline <script>: no "</script>", no "<!--". */
function island(v) {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** The {{t:…}} placeholders → the escaped text in the viewer's language. */
function fill(html, t, lang) {
  return html.replace(/\{\{t:([a-z0-9_.-]+)\}\}/g, (_, k) => esc(t(lang, k)));
}

/**
 * @param {{view:'page'|'portal', page?:string, lang?:string, loggedIn?:boolean, user?:object}} view
 * @param {(lang:string, key:string) => string} t
 */
function render(view, t) {
  const v = view || {};
  const lang = v.lang === 'en' ? 'en' : 'de';
  const portal = v.view === 'portal';
  const pageId = portal ? 'portal' : (PAGES.includes(v.page) ? v.page : 'overview');
  const page = FILES[pageId];
  const u = v.user || {};
  const loggedIn = portal ? (v.loggedIn === true || u.loggedIn === true) && u.kiosk !== true : true;
  const ctx = { lang, view: portal ? 'portal' : 'page', page: pageId, loggedIn, texts: texts[lang], viewer: Number.isSafeInteger(u.id) ? u.id : null };
  return '<style>' + FILES.css + (page.css || '') + '</style>'
    + fill(page.html, t, lang)
    + '<script>window.MS_CTX=' + island(ctx) + ';</script>'
    + '<script>' + FILES.common + '</script>'
    + '<script>' + page.js + '</script>';
}

module.exports = { render, esc, island, PAGES };
