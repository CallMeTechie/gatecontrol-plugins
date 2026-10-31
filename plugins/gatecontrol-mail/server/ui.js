'use strict';

// The portal tab "Mail" and the admin pages (Übersicht, Einstellungen — the plugin's settings page). Plugin HTML lives in
// a sandboxed frame (opaque origin, inline scripts and styles only, no network of its own): the page talks to the
// plugin's API through window.GC.call, uploads with GC.upload and gets live events with GC.on. Read once from ui/:
// common.css · portal.css / portal.html / portal.js · admin.css / admin.html / admin.js. Since 1.3.0 the portal's script
// is pimlogic.js (the plain logic of calendar and contacts), foldertree.js (the folders as a tree, since 1.3.4),
// calendar.js and contacts.js (the areas Kalender and Kontakte) and portal.js, which attaches both.
// The portal tab is for a signed-in person the administrator allows (portalVisible); anyone else gets a note.

const fs = require('node:fs');
const path = require('node:path');
const texts = require('./texts.json');

const UI = path.join(__dirname, '..', 'ui');
const read = (f) => fs.readFileSync(path.join(UI, f), 'utf8');

function inlineScript(name, src) {
  if (/<\/script|<!--/i.test(src)) throw new Error(`ui/${name} cannot be inlined (contains </script or <!--)`);
  return src;
}

const FILES = {
  common: read('common.css'),
  portal: {
    css: read('portal.css'), html: read('portal.html'),
    js: ['pimlogic.js', 'foldertree.js', 'calendar.js', 'contacts.js', 'portal.js'].map((f) => inlineScript(f, read(f))).join('\n'),
  },
  admin: { css: read('admin.css'), html: read('admin.html'), js: inlineScript('admin.js', read('admin.js')) },
};
const PAGES = ['overview', 'settings'];

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** JSON for an inline <script>: no "</script>", no "<!--". */
function island(v) {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

const fill = (html, t, lang) => html.replace(/\{\{t:([a-z0-9_.-]+)\}\}/g, (_, k) => esc(t(lang, k)));

/** The texts of a page (`prefix`*, and the error texts as err.*) of one language. */
function pageTexts(lang, prefix) {
  const all = texts[lang] || texts.de;
  const out = {};
  for (const [k, v] of Object.entries(texts.de)) if (k.startsWith(prefix)) out[k] = all[k] != null ? all[k] : v;
  for (const [k, v] of Object.entries(texts.de)) if (k.startsWith('error.')) out['err.' + k.slice(6)] = all[k] != null ? all[k] : v;
  return out;
}

/**
 * @param {{view?: 'page'|'portal', page?: string, lang?: string, loggedIn?: boolean, user?: object, allowed?: boolean}} view
 */
function render(view, t) {
  const v = view || {};
  const lang = v.lang === 'en' ? 'en' : 'de';
  if (v.view !== 'portal') {
    const page = PAGES.includes(v.page) ? v.page : 'overview';
    const a = FILES.admin;
    return '<style>' + FILES.common + a.css + '</style>' + fill(a.html, t, lang)
      + '<script>window.MA_CTX=' + island({ lang, page, texts: pageTexts(lang, 'a.') }) + ';</script>'
      + '<script>' + a.js + '</script>';
  }
  const u = v.user || {};
  const loggedIn = (v.loggedIn === true || u.loggedIn === true) && u.kiosk !== true;
  const p = FILES.portal;
  const ctx = { lang, loggedIn, allowed: v.allowed === true, viewer: Number.isSafeInteger(u.id) ? u.id : null, texts: pageTexts(lang, 'p.') };
  return '<style>' + FILES.common + p.css + '</style>' + fill(p.html, t, lang)
    + '<script>window.MP_CTX=' + island(ctx) + ';</script>'
    + '<script>' + p.js + '</script>';
}

module.exports = { render, esc, island, pageTexts };
