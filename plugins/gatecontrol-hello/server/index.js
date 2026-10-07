'use strict';

// gatecontrol-hello — the example plugin of this repository (ported from
// GateControl's test fixture tests/fixtures/plugins/hello). It shows the host
// API of docs/plugins.md: API routes, a page and a portal tab rendered from
// ui/page.html, settings, key/value storage, the plugin's own database,
// internet and home-network access, users, notifications and a background tick.

const fs = require('node:fs');
const path = require('node:path');

const TEMPLATE = fs.readFileSync(path.join(__dirname, '..', 'ui', 'page.html'), 'utf8');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fill(tpl, values) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => esc(values[k]));
}

async function errorJson(fn) {
  try { return await fn(); } catch (e) { return { status: 502, json: { ok: false, code: e.code || null, error: e.message } }; }
}

module.exports = {
  async start(gc) {
    gc.log.info('hello started', gc.plugin.version);
  },

  async request(req, gc) {
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
  },
};
