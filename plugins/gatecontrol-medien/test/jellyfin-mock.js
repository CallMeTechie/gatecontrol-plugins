'use strict';

// A Jellyfin for the tests, built from the answers recorded in the spike M0 (fixtures/jellyfin-<version>.json, a real
// Jellyfin 10.9.11 / 10.10.7 / 10.11.11): the same bodies and status codes for every call the plugin makes, with a
// little state (users, Quick Connect requests, devices). The devices start Quick Connect here like a real app would.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const KEY = 'f77f2a7ea9c44ce780aa4c24a0ddef2c';

function fixture(version) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'jellyfin-' + version + '.json'), 'utf8'));
}

function createJellyfin(version = '10.10.7', o = {}) {
  const fx = fixture(version);
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const adminUser = clone(fx.users[0]);
  const template = clone(fx.newUser);
  const mk = (name, x = {}) => {
    const u = clone(template);
    u.Name = name;
    u.Id = x.id || crypto.createHash('md5').update(name).digest('hex');
    u.Policy = { ...u.Policy, IsAdministrator: !!x.admin, IsDisabled: !!x.disabled };
    return u;
  };
  const st = {
    fx, key: o.key || KEY, quickConnect: fx.configuration.QuickConnectAvailable, config: clone(fx.configuration),
    users: [adminUser, ...(o.users || ['mila', 'jonas', 'lena', 'gast']).map((n) => (typeof n === 'string' ? mk(n) : mk(n.name, n)))],
    requests: new Map(), devices: new Map(), calls: [], down: false,
  };
  const reply = (status, body) => ({ status, headers: { 'content-type': 'application/json' }, body: body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body)) });
  const tokenOf = (h) => { const m = /Token="([^"]*)"/.exec((h && (h.Authorization || h.authorization)) || ''); return m ? m[1] : null; };
  const authed = (h) => tokenOf(h) === st.key;

  async function fetch(p, opts = {}) {
    const method = String(opts.method || 'GET').toUpperCase();
    st.calls.push({ method, path: p, auth: tokenOf(opts.headers) ? 'token' : 'none' });
    if (st.down) { const e = new Error('connect ECONNREFUSED'); e.code = 'ERR_NET'; throw e; }
    const u = new URL(p, 'http://jf');
    const q = u.searchParams;
    const route = method + ' ' + u.pathname;
    if (route === 'GET /System/Info/Public') return reply(200, fx.publicInfo);
    if (route === 'GET /QuickConnect/Enabled') return reply(200, st.quickConnect);
    if (!authed(opts.headers)) return reply(401, '');
    switch (route) {
      case 'GET /System/Info': return reply(200, fx.systemInfo);
      case 'GET /Users': return reply(200, st.users);
      case 'GET /Library/VirtualFolders': return reply(200, [{ Name: 'Filme', CollectionType: 'movies' }, { Name: 'Serien', CollectionType: 'tvshows' }]);
      case 'GET /System/Configuration': return reply(200, { ...st.config, QuickConnectAvailable: st.quickConnect });
      case 'POST /System/Configuration': st.quickConnect = !!(opts.json && opts.json.QuickConnectAvailable); return reply(204);
      case 'POST /Users/New': {
        const name = opts.json && opts.json.Name;
        if (!name || st.users.some((x) => x.Name.toLowerCase() === String(name).toLowerCase())) return reply(400, 'Error processing request.');
        const nu = mk(name);
        st.users.push(nu);
        return reply(200, nu);
      }
      case 'POST /QuickConnect/Authorize': {
        if (!st.quickConnect) return reply(401, 'Quick connect is disabled');
        const r = st.requests.get(q.get('code'));
        if (!r) return reply(404, 'Error processing request.');
        if (r.authorized) return reply(500, 'Error processing request.');
        const user = st.users.find((x) => x.Id === q.get('userId'));
        if (!user) return reply(404, 'Error processing request.');
        r.authorized = user.Id;
        st.devices.set(r.deviceId, { ...clone(fx.device), Id: r.deviceId, Name: r.deviceName, LastUserId: user.Id, LastUserName: user.Name });
        return reply(200, true);
      }
      case 'GET /Devices/Info': { const d = st.devices.get(q.get('id')); return d ? reply(200, d) : reply(404, { status: 404, title: 'Not Found' }); }
      case 'GET /Devices': {
        const items = [...st.devices.values()].filter((d) => !q.get('userId') || d.LastUserId === q.get('userId'));
        return reply(200, { Items: items, TotalRecordCount: items.length, StartIndex: 0 });
      }
      case 'DELETE /Devices': return st.devices.delete(q.get('id')) ? reply(204) : reply(404, { status: 404, title: 'Not Found' });
      default:
        if (method === 'GET' && u.pathname.startsWith('/Users/')) {
          const x = st.users.find((y) => y.Id === u.pathname.slice(7));
          return x ? reply(200, x) : reply(404, 'Error processing request.');
        }
        return reply(404, '');
    }
  }

  /** What an app does: POST /QuickConnect/Initiate with its DeviceId → the code (null when Quick Connect is off). */
  function initiate(deviceId, deviceName) {
    if (!st.quickConnect) return null;
    const code = String(100000 + crypto.randomInt(899999));
    st.requests.set(code, { deviceId, deviceName, authorized: null });
    return code;
  }
  const userId = (name) => (st.users.find((x) => x.Name === name) || {}).Id;
  return { fetch, initiate, state: st, userId, KEY };
}

module.exports = { createJellyfin, fixture, KEY };
