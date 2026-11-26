'use strict';

// The admin pages (overview, convert, sources, people, devices). The host shows plugin HTML only in a sandboxed frame
// (opaque origin, inline scripts and styles, no network of its own): the pages talk to this plugin's API through
// window.GC.call; "Personen oder Gruppen wählen …" is GateControl's own picker (GC.pickPrincipals).

const fs = require('node:fs');
const path = require('node:path');
const texts = require('./texts.json');

const UI = path.join(__dirname, '..', 'ui');
const read = (f) => fs.readFileSync(path.join(UI, f), 'utf8');
const PAGES = ['overview', 'convert', 'sources', 'people', 'devices'];
const FILES = { css: read('style.css'), common: read('common.js') };
for (const p of PAGES) FILES[p] = { html: read(p + '.html'), js: read(p + '.js') };

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function island(v) {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}
function fill(html, t, lang) {
  return html.replace(/\{\{t:([a-z0-9_.-]+)\}\}/g, (_, k) => esc(t(lang, k)));
}

function render(view, t) {
  const v = view || {};
  const lang = v.lang === 'en' ? 'en' : 'de';
  const pageId = PAGES.includes(v.page) ? v.page : 'overview';
  const page = FILES[pageId];
  const ctx = { lang, page: pageId, texts: texts[lang] };
  return '<style>' + FILES.css + '</style>'
    + fill(page.html, t, lang)
    + '<script>window.MD_CTX=' + island(ctx) + ';</script>'
    + '<script>' + FILES.common + '</script>'
    + '<script>' + page.js + '</script>';
}

module.exports = { render, esc, island, PAGES };
