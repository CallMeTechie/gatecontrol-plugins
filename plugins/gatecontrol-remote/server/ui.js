'use strict';

// The admin pages (devices, rights, sessions, settings), the portal tab and the
// profile section. The host shows plugin HTML only in a sandboxed frame (opaque
// origin, inline scripts and styles, no network of its own): the pages talk to
// this plugin's API through window.GC.call; a session opens on GateControl's
// own page with window.GC.openSession(ref).

const fs = require('node:fs');
const path = require('node:path');
const texts = require('./texts.json');

const UI = path.join(__dirname, '..', 'ui');
const read = (f) => fs.readFileSync(path.join(UI, f), 'utf8');
const PAGES = ['devices', 'rights', 'sessions', 'settings'];
const FILES = {
  css: read('style.css'),
  common: read('common.js'),
  // 1.7: the wizard „Gerät hinzufügen“ (ui/wizard.js) comes before the page
  devices: { html: read('devices.html'), js: read('wizard.js') + '\n' + read('devices.js') },
  rights: { html: read('rights.html'), js: read('rights.js') },
  sessions: { html: read('sessions.html'), js: read('sessions.js') },
  settings: { html: read('settings.html'), js: read('settings.js') },
  portal: { html: read('portal.html'), js: read('portal.js') },
  profile: { html: read('profile.html'), js: read('profile.js') },
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
  const pageId = portal ? (v.section === 'rights' ? 'profile' : 'portal') : (PAGES.includes(v.page) ? v.page : 'devices');
  const page = FILES[pageId];
  const ctx = { lang, view: portal ? 'portal' : 'page', page: pageId, texts: texts[lang] };
  return '<style>' + FILES.css + '</style>'
    + fill(page.html, t, lang)
    + '<script>window.RM_CTX=' + island(ctx) + ';</script>'
    + '<script>' + FILES.common + '</script>'
    + '<script>' + page.js + '</script>';
}

module.exports = { render, esc, island, PAGES };
