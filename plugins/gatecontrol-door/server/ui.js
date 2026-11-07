'use strict';

// The admin pages (devices, rights, history, settings) and the portal tab.
// The host shows plugin HTML only in a sandboxed frame (opaque origin, inline
// scripts and styles, no network of its own): the pages talk to this
// plugin's API through window.GC.call. Pictures come as base64 in JSON and
// are shown as data: URLs (the frame CSP allows img-src data:).

const fs = require('node:fs');
const path = require('node:path');
const texts = require('./texts.json');
const modes = require('./modes');

const UI = path.join(__dirname, '..', 'ui');
const read = (f) => fs.readFileSync(path.join(UI, f), 'utf8');
const PAGES = ['devices', 'rights', 'history', 'settings'];
const CAMERA_PLAYER = '/plugins/_shared/camera-player/camera-player.js';
const FILES = {
  css: read('style.css'),
  common: read('common.js'),
  // 1.6.0: Kameras im Heimnetz (page "Geräte" and the portal tab)
  home: read('home.js'),
  devices: { html: read('devices.html'), js: read('devices.js') },
  rights: { html: read('rights.html'), js: read('rights.js') },
  history: { html: read('history.html'), js: read('history.js') },
  settings: { html: read('settings.html'), js: read('settings.js') },
  portal: { html: read('portal.html'), js: read('portal.js') },
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

function render(view, t) {
  const v = view || {};
  const lang = v.lang === 'en' ? 'en' : 'de';
  const portal = v.view === 'portal';
  const pageId = portal ? 'portal' : (PAGES.includes(v.page) ? v.page : 'devices');
  const page = FILES[pageId];
  const ctx = { lang, view: portal ? 'portal' : 'page', page: pageId, texts: texts[lang], modeIcons: modes.ICONS };
  return '<style>' + FILES.css + '</style>'
    + fill(page.html, t, lang)
    + '<script>window.DOOR_CTX=' + island(ctx) + ';</script>'
    + '<script>' + FILES.common + '</script>'
    // 1.7.0: GateControl's live player (MSE for Firefox and Chrome/Edge on the PC; GateControl ≥ 1.242.0 allows it
    // in the frame CSP, an older one blocks it and home.js falls back to <video src>)
    + (pageId === 'portal' ? '<script src="' + CAMERA_PLAYER + '"></script>' : '')
    + (pageId === 'devices' || pageId === 'portal' ? '<script>' + FILES.home + '</script>' : '')
    + '<script>' + page.js + '</script>';
}

module.exports = { render, esc, island, PAGES };
