'use strict';

// The portal tab (ui/portal.html, .css, .js and the shared modules). The host shows plugin HTML only in a sandboxed
// frame (opaque origin, inline scripts and styles, no network): the page talks to this plugin's API through
// window.GC.call. Everything is read once from ui/.

const fs = require('node:fs');
const path = require('node:path');
const { texts } = require('./text');

const UI = path.join(__dirname, '..', 'ui');
const read = (f) => fs.readFileSync(path.join(UI, f), 'utf8');
const FILES = {
  css: read('common.css') + read('portal.css'),
  html: read('portal.html'),
  js: ['repeat.js', 'quickparse.js', 'notemd.js', 'vaultcrypto.js', 'nsx.js', 'portal.js'].map(read),
};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
/** JSON for an inline <script>: no "</script>", no "<!--". */
function island(v) {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function render(view) {
  const lang = view && view.lang === 'en' ? 'en' : 'de';
  const T = { ...texts.de, ...(lang === 'en' ? texts.en : {}) };
  const html = FILES.html.replace(/\{\{t:([a-z0-9_.-]+)\}\}/g, (_, k) => esc(T[k] != null ? T[k] : k));
  return '<style>' + FILES.css + '</style>' + html
    + '<script>window.NA_CTX=' + island({ lang, texts: T }) + ';</script>'
    + FILES.js.map((js) => '<script>' + js + '</script>').join('');
}

module.exports = { render, esc, island };
