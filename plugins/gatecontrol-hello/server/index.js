'use strict';

// gatecontrol-hello — the example plugin of this repository (ported from
// GateControl's test fixture tests/fixtures/plugins/hello). It shows the host
// API of docs/plugins.md: API routes, a page and a portal tab rendered from
// ui/page.html, settings, key/value storage, the plugin's own database,
// internet and home-network access, users, notifications and a background tick.
//
// 1.1.0 — an edge part (GateControl ≥ 1.228.0, plugin.json `edge`): edge/index.js runs on home gateways where an
// administrator switched it on; server/edge.js talks to it through gc.edge. The settings page "Gateways"
// (ui.settingsPage, ui/gateways.html) lists the gateways and greets one; the setting "Begrüßung" goes to every
// gateway with gc.edge.configure.

const fs = require('node:fs');
const path = require('node:path');

const edge = require('./edge');
const { TEXTS, translator, langOf } = require('./texts');

const TEMPLATE = fs.readFileSync(path.join(__dirname, '..', 'ui', 'page.html'), 'utf8');
const GATEWAYS = fs.readFileSync(path.join(__dirname, '..', 'ui', 'gateways.html'), 'utf8');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fill(tpl, values, t) {
  return tpl
    .replace(/\{\{t:([A-Za-z0-9_.]+)\}\}/g, (_, k) => esc(t ? t(k) : k))
    .replace(/\{\{(\w+)\}\}/g, (_, k) => esc(values[k]));
}

/** JSON for an inline <script>: no "</script>", no "<!--". */
function island(v) {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** The edge routes are for administrators on the admin pages only (not the portal, not the apps). */
const isAdmin = (user) => !!(user && user.role === 'admin' && !user.portal && !user.app);

async function errorJson(fn) {
  try { return await fn(); } catch (e) { return { status: 502, json: { ok: false, code: e.code || null, error: e.message } }; }
}

module.exports = {
  async start(gc) {
    gc.log.info('hello started', gc.plugin.version);
    if (!edge.setup(gc)) gc.log.info('no gc.edge on this GateControl (edge part needs ≥ 1.228.0)');
  },

  async request(req, gc) {
    if (String(req.path || '').startsWith('/edge/')) {
      const t = translator(req.lang);
      if (!isAdmin(req.user)) return { status: 403, json: { ok: false, code: 'forbidden', error: t('error.forbidden') } };
      if (req.path === '/edge/gateways' && req.method === 'GET') return { json: await edge.list(gc, t) };
      if (req.path === '/edge/greet' && req.method === 'POST') return edge.greet(gc, req.body, t);
      return { status: 404, json: { ok: false, error: 'not_found' } };
    }
    switch (req.path) {
      case '/ping':
        return { json: { ok: true, method: req.method, user: req.user, query: req.query, lang: req.lang } };
      case '/greetings':
        if (req.method === 'POST') {
          const text = String((req.body && req.body.text) || '').trim().slice(0, 200);
          if (!text) return { status: 400, json: { ok: false, error: 'text_required' } };
          const r = await gc.db.run('INSERT INTO greetings (text) VALUES (?)', [text]);
          return { status: 201, json: { ok: true, id: r.lastInsertRowid } };
        }
        return { json: { ok: true, rows: (await gc.db.query('SELECT id, text FROM greetings ORDER BY id')).rows } };
      case '/kv':
        if (req.method === 'POST') { await gc.storage.set(String(req.body.key), req.body.value); return { json: { ok: true } }; }
        return { json: { ok: true, value: await gc.storage.get(String(req.query.key)) } };
      case '/ticks':
        return { json: { ok: true, ticks: (await gc.storage.get('ticks')) || 0 } };
      case '/settings':
        return { json: { ok: true, values: await gc.settings.all() } };
      case '/users':
        return { json: { ok: true, users: await gc.users.list() } };
      case '/license':
        return { json: { ok: true, license: await gc.license.status() } };
      case '/notify':
        await gc.notify('hello from the plugin', { severity: 'info' });
        return { json: { ok: true } };
      case '/targets':
        return { json: { ok: true, targets: await gc.net.targets() } };
      case '/fetch':
        return errorJson(async () => {
          const r = await gc.http.fetch(String(req.query.url || ''), { timeoutMs: 3000 });
          return { json: { ok: true, status: r.status, body: r.body } };
        });
      case '/gateway':
        return errorJson(async () => {
          const r = await gc.net.fetchTarget('gateway', '/api/config', { timeoutMs: 3000 });
          return { json: { ok: true, status: r.status, body: r.body } };
        });
      default:
        return { status: 404, json: { ok: false, error: 'not_found' } };
    }
  },

  async render(view, gc) {
    if (view.view !== 'portal' && view.page === 'gateways') {
      // the settings page (plugin.json ui.settingsPage): Einstellungen › Plugins › Hallo Welt › Einstellungen
      const lang = langOf(view.lang);
      return { html: '<script>window.HELLO=' + island({ lang, texts: TEXTS[lang] }) + ';</script>'
        + fill(GATEWAYS, { user: (view.user && view.user.name) || 'Welt' }, translator(lang)) };
    }
    const s = await gc.settings.all();
    const greeting = s.loud ? String(s.greeting || '').toUpperCase() : s.greeting;
    const count = (await gc.db.get('SELECT COUNT(*) AS n FROM greetings')).row.n;
    return { html: fill(TEMPLATE, { greeting, user: view.user && view.user.name, view: view.view, page: view.page, count }) };
  },

  async tick(gc) {
    const n = (await gc.storage.get('ticks')) || 0;
    await gc.storage.set('ticks', n + 1);
  },

  async settingsChanged(values, gc) {
    gc.log.info('settings changed', Object.keys(values).join(','));
    // the edge part keeps its configuration in memory only: every running one gets the new greeting
    await edge.configureAll(gc);
  },
};
