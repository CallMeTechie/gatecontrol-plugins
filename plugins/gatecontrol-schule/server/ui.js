'use strict';

// The plugin page (accounts, students, change log) and the portal tab "Schule". The host shows
// plugin HTML only in a sandboxed frame (opaque origin, inline scripts/styles only, no
// network): the page talks to this plugin's API through window.GC.call. No external scripts;
// everything is read once from ui/. Data from the API is put into the page with textContent
// only (ui/common.js el()).

const fs = require('node:fs');
const path = require('node:path');
const texts = require('./texts.json');

const UI = path.join(__dirname, '..', 'ui');
const read = (f) => fs.readFileSync(path.join(UI, f), 'utf8');
const FILES = {
  css: read('style.css'),
  common: read('common.js'),
  main: { html: read('admin.html'), js: read('admin.js') },
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
 * @param {{view:'page'|'portal', lang?:string, user?:object}} view
 * @param {(lang:string, key:string) => string} t
 */
function render(view, t) {
  const lang = view && view.lang === 'en' ? 'en' : 'de';
  const portal = view && view.view === 'portal';
  const page = portal ? FILES.portal : FILES.main;
  const ctx = { lang, view: portal ? 'portal' : 'page', kiosk: !!(portal && view.user && view.user.kiosk === true), texts: texts[lang] };
  return '<style>' + FILES.css + (page.css || '') + '</style>'
    + fill(page.html, t, lang)
    + '<script>window.SC_CTX=' + island(ctx) + ';</script>'
    + '<script>' + FILES.common + '</script>'
    + '<script>' + page.js + '</script>';
}

module.exports = { render, esc, island };
