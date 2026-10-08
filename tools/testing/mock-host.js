'use strict';

// A mock of the GateControl plugin host for plugin unit tests (node:test).
//
// It loads the plugin's entry in-process and hands it a `gc` object with the
// shape of the real one (docs/plugins.md "Plugin code (host API)"). Like the
// real IPC every argument and result goes through JSON, and the host checks
// the permissions of plugin.json, throwing errors with the host's codes
// (ERR_NET_DENIED, ERR_STORAGE_DENIED, ERR_USERS_DENIED, ERR_NOTIFY_DENIED,
// ERR_RATE_LIMIT, ERR_INVALID). It does NOT reproduce the process sandbox,
// the network checks on resolved addresses or the real HTTP stack: network
// answers come from the handlers a test passes in.
//
//   const { createHost } = require('../../../tools/testing/mock-host');
//   const host = await createHost(path.join(__dirname, '..'), {
//     settings: { greeting: 'Hi' },                 // values (defaults from plugin.json are applied)
//     users: [{ id: 1, name: 'Ada', role: 'admin' }],
//     license: { required: false, licensed: true, state: 'valid', expiresAt: null },
//     fetch: async (url, opts) => ({ status: 200, body: '…' }),            // internet
//     targets: { gateway: [{ label: 'deCONZ', fetch: async (path, opts) => ({ status: 200, body: '{}' }) }] },
//     discover: async (data, opts) => [{ address: '192.168.1.5', port: 6445, data: Buffer }],
//   });
//   await host.start();
//   const res = await host.request({ method: 'GET', path: '/ping' });
//   host.logs, host.notifications, host.fetches; await host.close();
//   await host.legacyImport(snapshot); await host.portalVisible({ id: 2, name: 'Ada', role: 'user' }, 'section-id');
//   await host.portalTiles(user); await host.portalSearch(user, 'lamp');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SQL_DENY = /\b(attach|detach|vacuum|pragma|load_extension|sqlite_dbpage|fts3_tokenizer)\b|_gc_/i;
const DEFAULT_USER = Object.freeze({ id: 1, name: 'admin', role: 'admin' });

function hostError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** JSON round trip, as over the IPC channel (Buffers become { type, data }). */
function wire(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function parseHostEntry(raw) {
  const s = String(raw).trim().toLowerCase();
  const i = s.lastIndexOf(':');
  const hasPort = i >= 0 && (s.match(/:/g) || []).length === 1;
  const host = hasPort ? s.slice(0, i) : s;
  const ports = hasPort ? s.slice(i + 1).split(',').map((p) => {
    const [a, b] = p.trim().split('-').map(Number);
    return [a, b || a];
  }) : null;
  return host.startsWith('*.') ? { wildcard: true, host: host.slice(2), ports } : { wildcard: false, host, ports };
}

/** Is `url` allowed by permissions.network.internet? */
function internetAllowed(list, url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  return list.map(parseHostEntry).some((e) => {
    const hostOk = e.wildcard ? host.endsWith('.' + e.host) : host === e.host;
    return hostOk && (!e.ports || e.ports.some(([a, b]) => port >= a && port <= b));
  });
}

function networkOf(manifest) {
  const n = (manifest.permissions && manifest.permissions.network) || {};
  const obj = Array.isArray(n) ? { internet: n } : n;
  return { internet: obj.internet || [], homeTargets: obj.homeTargets || [], localDiscovery: obj.localDiscovery || null };
}

function settingDefaults(manifest) {
  const out = {};
  for (const s of (manifest.ui && manifest.ui.settings) || []) out[s.key] = s.default === undefined ? null : s.default;
  return out;
}

const SETTING_KEY_RE = /^[a-z][a-z0-9_.-]{0,63}$/;
function settingKey(k) {
  return typeof k === 'string' && SETTING_KEY_RE.test(k) && !['__proto__', 'constructor', 'prototype'].includes(k);
}

function openDb(file) {
  let sqlite;
  try { sqlite = require('node:sqlite'); } catch { return null; }
  return new sqlite.DatabaseSync(file);
}

/**
 * @param {string} pluginDir  folder with plugin.json
 * @param {object} [opts]     see the header
 */
async function createHost(pluginDir, opts = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8'));
  const perms = manifest.permissions || {};
  const net = networkOf(manifest);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `gcmock-${manifest.id}-`));
  const filesDir = path.join(tmp, 'files');
  fs.mkdirSync(filesDir);

  const logs = [];
  const notifications = [];
  const fetches = [];
  const kv = new Map();
  const settings = { ...settingDefaults(manifest), ...(opts.settings || {}) };
  const secrets = new Set(); // keys stored with gc.settings.setSecret (encrypted on the real host)
  const users = (opts.users || [DEFAULT_USER]).map((u) => ({ id: u.id, name: u.name, role: u.role }));
  const license = { required: !!(manifest.license && manifest.license.required), licensed: true, state: 'valid', expiresAt: null, ...(opts.license || {}) };

  // Storage: the plugin's own SQLite database with its migrations applied.
  let db = null;
  if (perms.storage) {
    db = openDb(path.join(tmp, 'plugin.db'));
    if (db) {
      const mdir = path.join(pluginDir, manifest.migrations || 'migrations');
      if (fs.existsSync(mdir)) {
        const list = fs.readdirSync(mdir).map((f) => [f, /^(\d{1,6})_[A-Za-z0-9_-]{1,80}\.sql$/.exec(f)]).filter(([, m]) => m)
          .sort((a, b) => Number(a[1][1]) - Number(b[1][1]));
        for (const [f] of list) db.exec('BEGIN;' + fs.readFileSync(path.join(mdir, f), 'utf8') + ';COMMIT;');
      }
    }
  }
  const needStorage = () => {
    if (!perms.storage) throw hostError('ERR_STORAGE_DENIED', 'this plugin has no storage permission');
  };
  const needDb = (sql) => {
    needStorage();
    if (!db) throw hostError('ERR_INVALID', 'node:sqlite is not available in this Node.js version');
    if (typeof sql !== 'string' || !sql.trim() || SQL_DENY.test(sql)) throw hostError('ERR_INVALID', 'statement not allowed');
  };
  const declaredTarget = (id) => {
    const t = net.homeTargets.find((x) => x.id === id);
    if (!t) throw hostError('ERR_NET_DENIED', `target ${id} is not declared in plugin.json`);
    const assigned = (opts.targets && opts.targets[id]) || [];
    return { t, assigned };
  };
  const pickAssigned = (id, index) => {
    const { assigned } = declaredTarget(id);
    const a = assigned[Number(index) || 0];
    if (!a) throw hostError('ERR_NET_DENIED', `target ${id} is not assigned`);
    return a;
  };

  const api = {
    'http.fetch': async ({ url, opts: o }) => {
      if (!internetAllowed(net.internet, url)) throw hostError('ERR_NET_DENIED', `host not allowed: ${url}`);
      fetches.push({ url, opts: o });
      if (!opts.fetch) throw hostError('ERR_NET', 'no fetch handler in this test');
      const r = await opts.fetch(url, o);
      return { status: 200, headers: {}, url, redirects: [], ...r };
    },
    'targets.list': async () => net.homeTargets.map((t) => ({
      id: t.id, protocols: t.protocols, assigned: ((opts.targets && opts.targets[t.id]) || []).map((a, index) => ({ index, label: a.label || `${t.id} ${index}` })),
    })),
    'target.fetch': async ({ target, index, path: p, opts: o }) => {
      const { t } = declaredTarget(target);
      if (!t.protocols.includes('http')) throw hostError('ERR_NET_DENIED', `target ${target} has no http protocol`);
      const a = pickAssigned(target, index);
      fetches.push({ target, index: Number(index) || 0, path: p, opts: o });
      if (!a.fetch) throw hostError('ERR_NET', 'no fetch handler for this target');
      const r = await a.fetch(p, o);
      return { status: 200, headers: {}, redirects: [], ...r };
    },
    'target.udp': async ({ target, index, dataBase64, port }) => {
      const a = pickAssigned(target, index);
      if (!a.udp) throw hostError('ERR_NET', 'no udp handler for this target');
      const answers = await a.udp(Buffer.from(dataBase64, 'base64'), { port });
      return answers.map((x) => ({ address: x.address, port: x.port, dataBase64: Buffer.from(x.data).toString('base64') }));
    },
    discover: async ({ dataBase64, ports }) => {
      const allowed = (net.localDiscovery && net.localDiscovery.udp) || [];
      if (!allowed.length) throw hostError('ERR_NET_DENIED', 'no localDiscovery permission');
      for (const p of ports || []) if (!allowed.map(Number).includes(Number(p))) throw hostError('ERR_NET_DENIED', `port ${p} not declared`);
      if (!opts.discover) return [];
      const answers = await opts.discover(Buffer.from(dataBase64, 'base64'), { ports });
      return answers.map((x) => ({ address: x.address, port: x.port, dataBase64: Buffer.from(x.data).toString('base64') }));
    },
    'storage.get': async ({ key }) => { needStorage(); return kv.has(String(key)) ? wire(kv.get(String(key))) : null; },
    'storage.set': async ({ key, value }) => { needStorage(); kv.set(String(key), wire(value)); return null; },
    'storage.delete': async ({ key }) => { needStorage(); return kv.delete(String(key)); },
    'storage.list': async ({ prefix }) => { needStorage(); return [...kv.keys()].filter((k) => k.startsWith(prefix || '')).sort(); },
    'db.query': async ({ sql, params, mode }) => {
      needDb(sql);
      const stmt = db.prepare(sql);
      const args = Array.isArray(params) ? params : params == null ? [] : [params];
      if (mode === 'run') {
        const r = stmt.run(...args);
        return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
      }
      if (mode === 'get') return { row: stmt.get(...args) || null };
      return { rows: stmt.all(...args), truncated: false };
    },
    'db.exec': async ({ sql }) => { needDb(sql); db.exec(sql); return null; },
    'settings.all': async () => ({ ...settings }),
    'settings.get': async ({ key }) => (Object.prototype.hasOwnProperty.call(settings, key) && settings[key] !== undefined ? settings[key] : null),
    'settings.set': async ({ key, value }) => {
      // like the host: declared keys plus the plugin's own (JSON) keys; no prototype names
      if (!settingKey(key)) throw hostError('ERR_INVALID', 'invalid setting');
      settings[key] = value === undefined ? null : value;
      return null;
    },
    'settings.setSecret': async ({ key, value }) => {
      if (!settingKey(key)) throw hostError('ERR_INVALID', 'invalid setting');
      const def = ((manifest.ui && manifest.ui.settings) || []).find((d) => d.key === key);
      if (def && def.type !== 'secret') throw hostError('ERR_INVALID', 'invalid setting');
      if (value != null && (typeof value !== 'string' || value.length > 4000)) throw hostError('ERR_INVALID', 'invalid secret');
      if (value == null || value === '') { delete settings[key]; secrets.delete(key); } else { settings[key] = value; secrets.add(key); }
      return null;
    },
    'users.list': async () => {
      if (!perms.users) throw hostError('ERR_USERS_DENIED', 'this plugin has no users permission');
      return users;
    },
    'users.get': async ({ id }) => {
      if (!perms.users) throw hostError('ERR_USERS_DENIED', 'this plugin has no users permission');
      return users.find((u) => u.id === Number(id)) || null;
    },
    notify: async ({ message, opts: o }) => {
      if (!perms.notify) throw hostError('ERR_NOTIFY_DENIED', 'this plugin has no notify permission');
      const msg = String(message || '').trim();
      if (!msg) throw hostError('ERR_INVALID', 'empty message');
      if (notifications.length >= 30) throw hostError('ERR_RATE_LIMIT', 'too many notifications');
      notifications.push({ message: msg, severity: (o && o.severity) || 'info' });
      return {};
    },
    'license.status': async () => ({ ...license }),
  };

  const call = async (name, args) => wire(await api[name](wire(args)));
  const log = (level) => (...a) => logs.push({ level, message: a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') });

  const gc = Object.freeze({
    plugin: Object.freeze({ id: manifest.id, version: manifest.version, filesDir }),
    log: Object.freeze({ debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') }),
    http: Object.freeze({ fetch: (url, o) => call('http.fetch', { url: String(url), opts: o || {} }) }),
    net: Object.freeze({
      targets: () => call('targets.list', {}),
      fetchTarget: (id, p, o) => call('target.fetch', { target: String(id), index: o && o.index, path: String(p || '/'), opts: o || {} }),
      tcpTarget: async () => { throw hostError('ERR_NET', 'tcpTarget is not mocked; test it against a real GateControl'); },
      udpTarget: async (id, data, o) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
        const list = await call('target.udp', { target: String(id), index: o && o.index, port: o && o.port, dataBase64: buf.toString('base64') });
        return list.map((x) => ({ address: x.address, port: x.port, data: Buffer.from(x.dataBase64, 'base64') }));
      },
      discover: async (data, o) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
        const list = await call('discover', { dataBase64: buf.toString('base64'), ports: o && o.ports });
        return list.map((x) => ({ address: x.address, port: x.port, data: Buffer.from(x.dataBase64, 'base64') }));
      },
    }),
    storage: Object.freeze({
      get: (key) => call('storage.get', { key }),
      set: (key, value) => call('storage.set', { key, value }),
      delete: (key) => call('storage.delete', { key }),
      list: (prefix) => call('storage.list', { prefix }),
    }),
    db: Object.freeze({
      query: (sql, params) => call('db.query', { sql, params, mode: 'all' }),
      get: (sql, params) => call('db.query', { sql, params, mode: 'get' }),
      run: (sql, params) => call('db.query', { sql, params, mode: 'run' }),
      exec: (sql) => call('db.exec', { sql }),
    }),
    settings: Object.freeze({
      get: (key) => call('settings.get', { key }),
      all: () => call('settings.all', {}),
      set: (key, value) => call('settings.set', { key, value }),
      setSecret: (key, value) => call('settings.setSecret', { key, value: value == null ? null : String(value) }),
    }),
    users: Object.freeze({ list: () => call('users.list', {}), get: (id) => call('users.get', { id }) }),
    notify: (message, o) => call('notify', { message: String(message), opts: o || {} }),
    license: Object.freeze({ status: () => call('license.status', {}) }),
  });

  const entry = path.join(pluginDir, manifest.entry);
  delete require.cache[require.resolve(entry)];
  const plugin = require(entry);
  const hook = async (name, ...a) => (typeof plugin[name] === 'function' ? wire(await plugin[name](...a.map(wire), gc)) : undefined);

  return {
    manifest, gc, plugin, logs, notifications, fetches, kv, settings, filesDir,
    start: () => hook('start'),
    stop: () => hook('stop'),
    tick: () => hook('tick'),
    settingsChanged: (values) => hook('settingsChanged', values),
    /** portalVisible hook: false hides the portal tab (section = null) or a section for this viewer (no hook → true) */
    async portalVisible(user, section = null) {
      if (typeof plugin.portalVisible !== 'function') return true;
      return (await hook('portalVisible', { user: { portal: true, ...user }, lang: 'de', section })) !== false;
    },
    /** portalTiles hook: declarative Start tiles for this viewer (no hook → []) */
    portalTiles: async (user, lang = 'de') => (typeof plugin.portalTiles === 'function' ? hook('portalTiles', { user: { portal: true, ...user }, lang }) : []),
    /** portalSearch hook: declarative search results for this viewer (no hook → []) */
    portalSearch: async (user, q, lang = 'de') => (typeof plugin.portalSearch === 'function' ? hook('portalSearch', { user: { portal: true, ...user }, lang, q }) : []),
    /** legacyImport hook: the host hands over the built-in data (first-party plugins only) */
    legacyImport: (snapshot) => hook('legacyImport', snapshot),
    /** keys stored with gc.settings.setSecret */
    secrets,
    /** req = { method, path, query, body, user, lang } (defaults filled in); returns { status, json | html … } */
    async request(req) {
      const r = await hook('request', { method: 'GET', query: {}, body: null, user: users[0] || DEFAULT_USER, lang: 'de', ...req });
      return { status: 200, ...r };
    },
    /** view = { view: 'page'|'portal', page, section, user, lang, loggedIn } */
    render: (view) => hook('render', { view: 'page', page: 'main', user: users[0] || DEFAULT_USER, lang: 'de', ...view }),
    async close() {
      if (db) { db.close(); db = null; }
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

module.exports = { createHost, internetAllowed, hostError };
