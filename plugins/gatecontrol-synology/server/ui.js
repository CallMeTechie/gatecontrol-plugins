'use strict';

// The plugin page (administrators only; tabs NAS / Einstellungen). The host
// shows plugin HTML only in a sandboxed frame (opaque origin, inline
// scripts/styles only, no network): the page talks to this plugin's API
// through window.GC.call (the parent page adds the session, CSRF token and
// rate limit). Everything is read once from ui/.

const fs = require('node:fs');
const path = require('node:path');
const texts = require('./texts.json');

const UI = path.join(__dirname, '..', 'ui');
const read = (f) => fs.readFileSync(path.join(UI, f), 'utf8');
const FILES = { css: read('style.css'), common: read('common.js'), html: read('admin.html'), js: read('admin.js') };

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
 * @param {{view:'page'|'portal', lang?:string}} view
 * @param {(lang:string, key:string) => string} t
 * @param {boolean} admin  an administrator in the admin interface (anyone else gets a notice only)
 */
function render(view, t, admin) {
  const lang = view && view.lang === 'en' ? 'en' : 'de';
  if (!admin) return `<style>${FILES.css}</style><main class="sy-page"><div class="banner">${esc(t(lang, 'page.admin_only'))}</div></main>`;
  const ctx = { lang, texts: texts[lang] };
  return '<style>' + FILES.css + '</style>'
    + fill(FILES.html, t, lang)
    + '<script>window.SY_CTX=' + island(ctx) + ';</script>'
    + '<script>' + FILES.common + '</script>'
    + '<script>' + FILES.js + '</script>';
}

module.exports = { render, esc, island };
