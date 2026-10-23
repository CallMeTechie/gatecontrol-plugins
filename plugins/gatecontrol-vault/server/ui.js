'use strict';

// The admin page "Übersicht" (counts, who uses Vault). The host shows plugin HTML only in a sandboxed frame (opaque
// origin, inline scripts and styles, no network of its own): the page talks to this plugin's API through
// window.GC.call. Read once from ui/. Vault has no portal page yet (the browser app follows in a later version).

const fs = require('node:fs');
const path = require('node:path');
const texts = require('./texts.json');

const UI = path.join(__dirname, '..', 'ui');
const read = (f) => fs.readFileSync(path.join(UI, f), 'utf8');
const FILES = { css: read('style.css'), html: read('overview.html'), js: read('overview.js') };

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** JSON for an inline <script>: no "</script>", no "<!--". */
function island(v) {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function render(view, t) {
  const lang = (view || {}).lang === 'en' ? 'en' : 'de';
  const html = FILES.html.replace(/\{\{t:([a-z0-9_.-]+)\}\}/g, (_, k) => esc(t(lang, k)));
  return '<style>' + FILES.css + '</style>' + html
    + '<script>window.VA_CTX=' + island({ lang, texts: texts[lang] }) + ';</script>'
    + '<script>' + FILES.js + '</script>';
}

module.exports = { render, esc, island };
