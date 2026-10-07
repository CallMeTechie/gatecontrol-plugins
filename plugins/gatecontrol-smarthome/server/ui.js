'use strict';

// Pages and the portal tab. The host shows plugin HTML only in a sandboxed
// frame (opaque origin, inline scripts/styles only, no network): the page
// talks to this plugin's API through window.GC.call (the parent page adds the
// session, CSRF token and rate limit). Everything is read once from ui/.

const fs = require('node:fs');
const path = require('node:path');
const texts = require('./texts.json');

const UI = path.join(__dirname, '..', 'ui');
const read = (f) => fs.readFileSync(path.join(UI, f), 'utf8');
const FILES = {
  css: read('style.css'),
  common: read('common.js'),
  main: { html: read('admin.html'), js: read('admin.js') },
  rules: { html: read('rules.html'), js: read('rules.js') },
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
 * @param {{view:'page'|'portal', page?:string, lang?:string, loggedIn?:boolean}} view
 * @param {(lang:string, key:string) => string} t
 */
function render(view, t) {
  const lang = view && view.lang === 'en' ? 'en' : 'de';
  const portal = view && view.view === 'portal';
  const page = portal ? FILES.portal : (view && view.page === 'rules' ? FILES.rules : FILES.main);
  const ctx = { lang, view: portal ? 'portal' : 'page', page: portal ? null : (view.page === 'rules' ? 'rules' : 'main'), loggedIn: portal ? !!view.loggedIn : true, texts: texts[lang] };
  return '<style>' + FILES.css + (page.css || '') + '</style>'
    + fill(page.html, t, lang)
    + '<script>window.SH_CTX=' + island(ctx) + ';</script>'
    + '<script>' + FILES.common + '</script>'
    + '<script>' + page.js + '</script>';
}

module.exports = { render, esc, island };
