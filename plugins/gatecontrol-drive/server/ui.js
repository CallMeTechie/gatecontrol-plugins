'use strict';

// The portal tab "Drive". The host shows plugin HTML only in a sandboxed frame (opaque origin, inline scripts and
// styles only — no external script, no network of its own, no storage): the page talks to this plugin's API through
// window.GC.call, uploads with GC.upload and gets live events with GC.on. Everything is inlined here, read once from
// ui/: portal.css · portal.html · DP_CTX · portal.js.
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

const FILES = { css: read('portal.css'), html: read('portal.html'), js: inlineScript('portal.js', read('portal.js')) };

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** JSON for an inline <script>: no "</script>", no "<!--". */
function island(v) {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

const fill = (html, t, lang) => html.replace(/\{\{t:([a-z0-9_.-]+)\}\}/g, (_, k) => esc(t(lang, k)));

/** The portal texts (p.*, err.*) of one language. */
function portalTexts(lang) {
  const all = texts[lang];
  const out = {};
  for (const [k, v] of Object.entries(all)) if (k.startsWith('p.') || k.startsWith('err.')) out[k] = v;
  for (const [k, v] of Object.entries(all)) if (k.startsWith('error.')) out['err.' + k.slice(6)] = out['err.' + k.slice(6)] || v;
  return out;
}

/**
 * @param {{view?: 'page'|'portal', lang?: string, loggedIn?: boolean, user?: object}} view
 * @param {(lang: string, key: string) => string} t
 */
function render(view, t) {
  const v = view || {};
  const lang = v.lang === 'en' ? 'en' : 'de';
  if (v.view !== 'portal') return `<p style="font-family:var(--font);color:var(--muted)">${esc(t(lang, 'p.admin_later'))}</p>`;
  const u = v.user || {};
  const loggedIn = (v.loggedIn === true || u.loggedIn === true) && u.kiosk !== true;
  const ctx = { lang, view: 'portal', loggedIn, viewer: Number.isSafeInteger(u.id) ? u.id : null, texts: portalTexts(lang) };
  return '<style>' + FILES.css + '</style>'
    + fill(FILES.html, t, lang)
    + '<script>window.DP_CTX=' + island(ctx) + ';</script>'
    + '<script>' + FILES.js + '</script>';
}

module.exports = { render, esc, island, portalTexts };
