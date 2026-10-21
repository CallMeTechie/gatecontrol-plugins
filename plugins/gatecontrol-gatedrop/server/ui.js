'use strict';

// The portal tab "GateDrop" and the admin page "Übersicht". The host shows plugin HTML only in a sandboxed
// frame (opaque origin, inline scripts and styles, no network of its own): the pages talk to this plugin's
// API through window.GC.call, upload with GC.upload and show / download files through signed /plugin-media/
// URLs (GET items/<mediaId>). Read once from ui/.

const fs = require('node:fs');
const path = require('node:path');
const texts = require('./texts.json');

const UI = path.join(__dirname, '..', 'ui');
const read = (f) => fs.readFileSync(path.join(UI, f), 'utf8');
const FILES = {
  css: read('style.css'),
  common: read('common.js'),
  overview: { html: read('overview.html'), js: read('overview.js') },
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

function render(view, t) {
  const v = view || {};
  const lang = v.lang === 'en' ? 'en' : 'de';
  const portal = v.view === 'portal';
  const page = portal ? FILES.portal : FILES.overview;
  const u = v.user || {};
  const loggedIn = portal ? (v.loggedIn === true || u.loggedIn === true) && u.kiosk !== true : true;
  const ctx = { lang, view: portal ? 'portal' : 'page', loggedIn, texts: texts[lang], viewer: Number.isSafeInteger(u.id) ? u.id : null };
  return '<style>' + FILES.css + (page.css || '') + '</style>'
    + fill(page.html, t, lang)
    + '<script>window.GD_CTX=' + island(ctx) + ';</script>'
    + '<script>' + FILES.common + '</script>'
    + '<script>' + page.js + '</script>';
}

module.exports = { render, esc, island };
