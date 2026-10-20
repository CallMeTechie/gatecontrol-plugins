'use strict';

// The frames of the plugin. The host shows plugin HTML only in a sandboxed frame (opaque origin,
// inline scripts/styles only, no network): the page talks to this plugin's API through
// window.GC.call. No external scripts; everything is read once from ui/. Data from the API is put
// into the page with textContent only (ui/common.js el()).
//
// 1.3.0 — information and settings apart:
//   page 'main'    „Schule“: only the information (ui/view.*) — per child the week, changes, exams,
//                  homework; without an account a pointer to the settings
//   page 'setup'   „Konten & Kinder“ (plugin.json ui.settingsPage): GateControl ≥ 1.188.0 shows it in
//                  Einstellungen › Plugins › Schule › Einstellungen; older hosts as a second page tab.
//                  WebUntis accounts (scan the QR code, upload a picture of it, type it in), children
//                  (name, colour, GateControl user, recipients, wall tablet), diagnostics
//   portal         the tab „Schule“ (the same view as 'main', for what the viewer may see)
//   portal section 'webuntis' (plugin.json ui.portal.profileSections, GateControl ≥ 1.188.0): on the
//                  viewer's own profile — link his own WebUntis account (server/link.js)
// The QR decoder (ui/vendor/jsqr, Apache-2.0) is not inlined: a frame asks for it (GET qr-decoder)
// only when the browser has no BarcodeDetector, and runs it as an inline script.

const fs = require('node:fs');
const path = require('node:path');
const texts = require('./texts.json');

const UI = path.join(__dirname, '..', 'ui');
const read = (f) => fs.readFileSync(path.join(UI, f), 'utf8');
const PROFILE_SECTION = 'webuntis';

const FILES = {
  css: read('style.css'),
  common: read('common.js'),
  view: { html: read('view.html'), js: read('view.js'), css: read('view.css') },
  setup: { html: read('setup.html'), js: read('scan.js') + '\n' + read('setup.js'), css: read('setup.css') },
  link: { html: read('link.html'), js: read('scan.js') + '\n' + read('link.js'), css: read('setup.css') },
};

let decoder = null;
/** The vendored jsQR (ui/vendor/jsqr/jsQR.js) as text, read on first use. */
function qrDecoder() {
  if (decoder == null) decoder = read('vendor/jsqr/jsQR.js');
  return decoder;
}

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
 * @param {{view:'page'|'portal', page?:string, section?:string, lang?:string, user?:object}} view
 * @param {(lang:string, key:string) => string} t
 */
function render(view, t) {
  const v = view || {};
  const lang = v.lang === 'en' ? 'en' : 'de';
  const portal = v.view === 'portal';
  let kind = 'view';
  if (portal && v.section === PROFILE_SECTION) kind = 'link';
  else if (!portal && v.page === 'setup') kind = 'setup';
  const page = FILES[kind];
  const ctx = {
    lang, view: portal ? 'portal' : 'page', kind,
    kiosk: !!(portal && v.user && v.user.kiosk === true), texts: texts[lang],
  };
  return '<style>' + FILES.css + (page.css || '') + '</style>'
    + fill(page.html, t, lang)
    + '<script>window.SC_CTX=' + island(ctx) + ';</script>'
    + '<script>' + FILES.common + '</script>'
    + '<script>' + page.js + '</script>';
}

module.exports = { render, esc, island, qrDecoder, PROFILE_SECTION };
