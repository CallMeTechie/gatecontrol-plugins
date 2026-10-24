'use strict';

// The admin page "Übersicht" (counts, who uses Vault) and the portal tab "Vault" (1.1.0: the password manager in the
// browser). The host shows plugin HTML only in a sandboxed frame (opaque origin, inline scripts and styles only — no
// external script, no WebAssembly, no network of its own, no storage): the pages talk to this plugin's API through
// window.GC.call and hand files to the page with GC.saveFile. Everything is inlined here, read once from ui/:
//
//   portal tab   portal.css · portal.html · VA_CTX · vendor/noble.js (noble hashes/ciphers/curves + uqr, MIT; 1.2.0
//                jsQR, Apache-2.0; built by test/vendor-build/build.sh — under test/, so not packed) · crypto.js
//                (window.VaultCrypto) · logic.js (window.VaultLogic) · portal.js
//
// The portal tab is for a signed-in person only (never a kiosk device, never a viewer known only by device trust):
// the others get the page with loggedIn: false, which shows "Bitte melde dich an" and calls nothing.

const fs = require('node:fs');
const path = require('node:path');
const texts = require('./texts.json');

const UI = path.join(__dirname, '..', 'ui');
const read = (f) => fs.readFileSync(path.join(UI, f), 'utf8');

/** Text that goes into an inline <script>: it must not close the element or open an HTML comment. */
function inlineScript(name, src) {
  if (/<\/script|<!--/i.test(src)) throw new Error(`ui/${name} cannot be inlined (contains </script or <!--)`);
  return src;
}

const PORTAL_LIBS = ['vendor/noble.js', 'crypto.js', 'logic.js'];
const FILES = {
  css: read('style.css'),
  overview: { html: read('overview.html'), js: read('overview.js') },
  portal: {
    css: read('portal.css'),
    html: read('portal.html'),
    lib: PORTAL_LIBS.map((f) => inlineScript(f, read(f))),
    js: inlineScript('portal.js', read('portal.js')),
  },
};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** JSON for an inline <script>: no "</script>", no "<!--". */
function island(v) {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

const fill = (html, t, lang) => html.replace(/\{\{t:([a-z0-9_.-]+)\}\}/g, (_, k) => esc(t(lang, k)));

/**
 * @param {{view?: 'page'|'portal', page?: string, lang?: string, loggedIn?: boolean, user?: object}} view
 * @param {(lang: string, key: string) => string} t
 */
function render(view, t) {
  const v = view || {};
  const lang = v.lang === 'en' ? 'en' : 'de';
  if (v.view === 'portal') {
    const u = v.user || {};
    const loggedIn = (v.loggedIn === true || u.loggedIn === true) && u.kiosk !== true;
    const ctx = { lang, view: 'portal', loggedIn, viewer: Number.isSafeInteger(u.id) ? u.id : null, texts: texts[lang] };
    const p = FILES.portal;
    return '<style>' + FILES.css + p.css + '</style>'
      + fill(p.html, t, lang)
      + '<script>window.VA_CTX=' + island(ctx) + ';</script>'
      + p.lib.map((src) => '<script>' + src + '</script>').join('')
      + '<script>' + p.js + '</script>';
  }
  return '<style>' + FILES.css + '</style>' + fill(FILES.overview.html, t, lang)
    + '<script>window.VA_CTX=' + island({ lang, texts: texts[lang] }) + ';</script>'
    + '<script>' + FILES.overview.js + '</script>';
}

module.exports = { render, esc, island, PORTAL_LIBS };
