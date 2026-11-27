'use strict';

// The source dialog assigns the home targets itself (1.1.0, GateControl ≥ 1.324.0 window.GC.targets):
// suggestions from a route, reuse or append of an assignment (indices of other sources never move), pruning
// unused assignments at the end, the fallback without GC.targets.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'ui', 'common.js'), 'utf8');

/** common.js in a sandbox with a fake GC.targets over `state` ({ jellyfin: [...], webdav: [...] }). */
function load(state, opts = {}) {
  const calls = [];
  const targets = opts.noTargets ? undefined : {
    get: async () => ({
      targets: Object.keys(state).map((id) => ({ id, multiple: true, assigned: state[id].map((a, index) => ({ index, ...a, display: 'x' })) })),
      routes: opts.routes || [], peers: opts.peers || [],
    }),
    set: async (id, list) => {
      if (opts.setFails) throw new Error('refused');
      calls.push([id, list]); state[id] = list.map((a) => ({ ...a })); return { assigned: list };
    },
  };
  const api = [];
  const call = async (method, p, body) => { api.push([method, p, JSON.parse(JSON.stringify(body || null))]); return {}; };
  const window = { GC: { call, targets }, MD_CTX: { texts: {}, lang: 'de' } };
  vm.runInNewContext(SRC, { window, document: {}, setTimeout, clearTimeout, Promise, Object, Number, String });
  return { MD: window.MD, calls, api };
}

test('suggestions: home address from the route target (not a peer route), https://<domain> for away', () => {
  const { MD } = load({ jellyfin: [] });
  assert.deepEqual({ ...MD.suggest({ domain: 'jf.example.com', https: true, backend: { scheme: 'http', host: '192.168.2.151', port: 8096, via: 'gateway' } }) },
    { home: 'http://192.168.2.151:8096', away: 'https://jf.example.com' });
  assert.deepEqual({ ...MD.suggest({ domain: 'jf.example.com', https: false, backend: { scheme: 'http', host: '10.8.0.5', port: 8096, via: 'peer' } }) },
    { home: null, away: null });
  assert.deepEqual({ ...MD.suggest(null) }, { home: null, away: null });
});

test('ensureTarget reuses an assignment, appends a new one, keeps the others', async () => {
  const state = { jellyfin: [{ kind: 'host', host: '192.168.1.20', port: 8096, scheme: 'http' }, { kind: 'route', routeId: 7 }] };
  const { MD, calls } = load(state);
  assert.equal(MD.hasTargets, true);
  assert.equal(await MD.ensureTarget('jellyfin', 'r:7'), 1);
  assert.equal(calls.length, 0);
  assert.equal(await MD.ensureTarget('jellyfin', 'a:0'), 0);
  assert.equal(await MD.ensureTarget('jellyfin', 'p:4', { port: 8096, scheme: 'http' }), 2);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][1])), [
    { kind: 'host', host: '192.168.1.20', port: 8096, scheme: 'http' }, { kind: 'route', routeId: 7 }, { kind: 'peer', peerId: 4, port: 8096, scheme: 'http' }]);
  assert.equal(await MD.ensureTarget('jellyfin', 'p:4', { port: 8096, scheme: 'http' }), 2);
  assert.equal(await MD.ensureTarget('webdav', ''), null);
});

test('pruneTargets drops only unused routes/peers at the end, never an address or a used index', async () => {
  const state = { jellyfin: [{ kind: 'route', routeId: 1 }, { kind: 'route', routeId: 2 }, { kind: 'host', host: '192.168.1.9', port: null, scheme: 'http' }, { kind: 'route', routeId: 3 }] };
  const { MD, calls } = load(state);
  assert.equal(await MD.pruneTargets('jellyfin', [0]), true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][1])).map((a) => a.kind + (a.routeId || '')), ['route1', 'route2', 'host']);
  assert.equal(await MD.pruneTargets('jellyfin', [0]), false);
});

test('1.4.0: ensureTarget remembers a new assignment as made by the dialog (admin/targets/made), not a reused one', async () => {
  const state = { jellyfin: [{ kind: 'route', routeId: 7 }] };
  const { MD, api } = load(state);
  await MD.ensureTarget('jellyfin', 'r:7');
  assert.equal(api.length, 0);
  state.smb = [];
  const r = load(state);
  assert.equal(await r.MD.ensureTarget('smb', 'p:9', { port: 445, scheme: 'http' }), 0);
  assert.deepEqual(r.api, [['POST', 'admin/targets/made', { target: 'smb', assignment: { kind: 'peer', peerId: 9, port: 445, scheme: 'http' } }]]);
});

test('1.4.0: pruneTargets removes an unused assignment the dialog made also in the middle — sources renumbered first', async () => {
  const list = () => [{ kind: 'route', routeId: 1 }, { kind: 'route', routeId: 2 }, { kind: 'host', host: '192.168.1.9', port: null, scheme: 'http' }, { kind: 'route', routeId: 3 }, { kind: 'route', routeId: 4 }];
  // route 2 (index 1) made by the dialog and unused; route 3 (index 3) unused but not made → stays; route 4 used
  let state = { jellyfin: list() };
  let x = load(state);
  assert.equal(await x.MD.pruneTargets('jellyfin', [0, 4], ['jellyfin:route:2']), true);
  assert.deepEqual(x.api, [['POST', 'admin/targets/compact', { target: 'jellyfin', map: { 0: 0, 2: 1, 3: 2, 4: 3 }, forget: ['jellyfin:route:2'] }]]);
  assert.deepEqual(state.jellyfin.map((a) => a.kind + (a.routeId || '')), ['route1', 'host', 'route3', 'route4']);
  // nothing more to do
  x = load(state);
  assert.equal(await x.MD.pruneTargets('jellyfin', [0, 3], ['jellyfin:route:2']), false);
  assert.equal(x.api.length, 0);
  // an address is never removed, even when "made" (the page cannot make one)
  state = { jellyfin: [{ kind: 'host', host: '192.168.1.9', port: null, scheme: 'http' }, { kind: 'route', routeId: 5 }] };
  x = load(state);
  assert.equal(await x.MD.pruneTargets('jellyfin', [1], []), false);
  // setting the list fails: the sources are renumbered back
  state = { jellyfin: list() };
  x = load(state, { setFails: true });
  assert.equal(await x.MD.pruneTargets('jellyfin', [0, 4], ['jellyfin:route:2']), false);
  assert.deepEqual(x.api.map((a) => a[2].map), [{ 0: 0, 2: 1, 3: 2, 4: 3 }, { 0: 0, 1: 2, 2: 3, 3: 4 }]);
  assert.equal(state.jellyfin.length, 5);
});

test('1.4.0: the NAS dialog checks before saving (admin/probe kind share), keeps a failed result in the dialog', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'sources.js'), 'utf8');
  assert.match(src, /P\.api\('POST', 'admin\/probe', \{ kind: 'share'/);
  assert.match(src, /return probe\(b\)/);
  assert.equal((src.match(/if \(!b\) return false;/g) || []).length, 2, 'add and edit keep the dialog open');
  assert.match(src, /T\('nas\.save_anyway'\)/);
  assert.match(src, /P\.pruneTargets\(id, used\[id\], made\)/);
});

test('without GC.targets (older GateControl): no assignment from the page', async () => {
  const { MD } = load({}, { noTargets: true });
  assert.equal(MD.hasTargets, false);
  assert.equal(await MD.targetsData(), null);
  await assert.rejects(MD.ensureTarget('jellyfin', 'r:1'));
  assert.equal(await MD.ensureTarget('jellyfin', 'a:0'), 0);
});

test('manifest asks for permissions.network.assignTargets and GateControl ≥ 1.328.0 (targets only on this page since 1.325.0, transcode since 1.328.0); no "Zugriffsziele öffnen" any more', () => {
  const m = require('../plugin.json');
  assert.equal(m.permissions.network.assignTargets, true);
  assert.equal(m.gatecontrol, '>=1.328.0');
  const ui = path.join(__dirname, '..', 'ui');
  for (const f of fs.readdirSync(ui)) assert.doesNotMatch(fs.readFileSync(path.join(ui, f), 'utf8'), /openSettings|targetsLink|targets_open/, f);
});

// 1.2.0: one choice "Wo läuft Jellyfin?" / "Wo liegt die NAS?" — the access target and the addresses follow from it

const ROUTES = [
  { id: 3, label: 'jellyfin.example.com', domain: 'jellyfin.example.com', type: 'http', https: true, internal: false, enabled: true, gateway: true,
    backend: { scheme: 'http', host: '192.168.2.151', port: 8096, via: 'gateway' } },
  { id: 4, label: 'nas.example.com', domain: 'nas.example.com', type: 'http', https: true, internal: false, enabled: true, gateway: true,
    backend: { scheme: 'https', host: '192.168.2.10', port: 5006, via: 'gateway' } },
  { id: 5, label: 'wiki.example.com', domain: 'wiki.example.com', type: 'http', https: false, internal: true, enabled: true, gateway: false,
    backend: { scheme: 'http', host: '10.8.0.9', port: 8080, via: 'peer' } },
  { id: 6, label: 'game.example.com:25565', domain: 'game.example.com', type: 'l4', https: false, internal: false, enabled: true, gateway: true, backend: null },
];
const PEERS = [{ id: 9, label: 'NAS', ip: '10.8.0.31', gateway: false }];

test('whereText: a route by its domain, a peer by name, an assigned address as shown', () => {
  const { MD } = load({ jellyfin: [{ kind: 'host', host: '192.168.1.20', port: 8096, scheme: 'http' }], webdav: [] }, { routes: ROUTES, peers: PEERS });
  const td = { targets: [{ id: 'jellyfin', multiple: true, assigned: [{ index: 0, kind: 'host', host: '192.168.1.20', port: 8096, scheme: 'http', display: '192.168.1.20:8096' }] }], routes: ROUTES, peers: PEERS };
  assert.equal(MD.whereText(td, 'r:3', 'jellyfin'), 'jellyfin.example.com');
  assert.equal(MD.whereText(td, 'p:9', 'jellyfin'), 'NAS (10.8.0.31)');
  assert.equal(MD.whereText(td, 'a:0', 'jellyfin'), '192.168.1.20:8096');
  assert.equal(MD.whereText(td, { kind: 'route', routeId: 4 }, 'webdav'), 'nas.example.com');
  assert.equal(MD.whereText(td, '', 'jellyfin'), null);
  assert.equal(MD.whereText(td, 'a:7', 'jellyfin'), null);
  assert.equal(MD.assignedAt(td, 'jellyfin', 0).host, '192.168.1.20');
  assert.equal(MD.assignedAt(td, 'webdav', 0), null);
});

test('suggestJellyfin: home address from the route target (port 8096 by default), https://<domain> away; nothing from a peer route', () => {
  const { MD } = load({});
  const td = { targets: [{ id: 'jellyfin', multiple: true, assigned: [{ index: 0, kind: 'host', host: '192.168.1.20', port: null, scheme: 'http' }] }], routes: ROUTES, peers: PEERS };
  assert.deepEqual({ ...MD.suggestJellyfin(td, 'r:3') }, { home: 'http://192.168.2.151:8096', away: 'https://jellyfin.example.com' });
  assert.deepEqual({ ...MD.suggestJellyfin(td, 'r:5') }, { home: null, away: null }, 'peer route, no HTTPS');
  assert.deepEqual({ ...MD.suggestJellyfin(td, 'a:0') }, { home: 'http://192.168.1.20:8096', away: null });
  assert.deepEqual({ ...MD.suggestJellyfin(td, 'p:9') }, { home: null, away: null });
});

test('suggestShare: SMB on the NAS host, WebDAV only with an HTTPS target, away through the route, a name', () => {
  const { MD } = load({});
  const td = { targets: [], routes: ROUTES, peers: PEERS };
  assert.deepEqual({ ...MD.suggestShare(td, 'r:4', 'video') }, { smb: 'smb://192.168.2.10/video', webdav: 'https://192.168.2.10:5006/video', away: 'https://nas.example.com/video', name: 'NAS Video' });
  assert.deepEqual({ ...MD.suggestShare(td, 'r:3', '/filme/') }, { smb: 'smb://192.168.2.151/filme', webdav: null, away: 'https://jellyfin.example.com/filme', name: 'NAS Filme' }, 'HTTP target: no WebDAV');
  assert.deepEqual({ ...MD.suggestShare(td, 'p:9', 'video') }, { smb: null, webdav: null, away: null, name: 'NAS Video' }, 'a peer: its VPN address is no home address');
  assert.deepEqual({ ...MD.suggestShare(td, 'r:4', 'a/b') }, { smb: null, webdav: null, away: null, name: null }, 'one folder only');
  assert.deepEqual({ ...MD.suggestShare(td, 'r:4', '') }, { smb: null, webdav: null, away: null, name: null });
});

test('likely routes for the choices, the hint of a route card', () => {
  const { MD } = load({}, { routes: ROUTES });
  assert.deepEqual(ROUTES.filter(MD.likelyJellyfin).map((r) => r.id), [3]);
  assert.deepEqual(ROUTES.filter(MD.likelyNas).map((r) => r.id), [4]);
  assert.equal(MD.routeHint(ROUTES[0]), 'where.route · where.to_gw · HTTPS');
  assert.equal(MD.routeHint(ROUTES[2]), 'where.route · where.to · HTTP · src.via_internal');
});

test('the dialogs: one choice, no select of access targets, "Prüfen und speichern", prune after every dialog', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'sources.js'), 'utf8');
  assert.match(src, /P\.whereChoice\(td, 'jellyfin'/);
  assert.match(src, /P\.whereChoice\(td, 'webdav'/);
  assert.match(src, /P\.ensureTarget\('jellyfin', v,/);
  assert.match(src, /P\.ensureTarget\('webdav', v,/);
  assert.match(src, /P\.ensureTarget\('smb', v, \{ port: 445/);
  assert.match(src, /ck\.serverName/, 'the name from Jellyfin');
  assert.doesNotMatch(src, /targetSelect|src\.target_hint/);
  assert.equal((src.match(/load\(\)\.then\(prune\)/g) || []).length, 3, 'add, edit, remove');
});

test('away (1.3.0): the address for away is shown for both modes, the line names it also through the VPN', () => {
  const { MD } = load({});
  assert.equal(MD.awayText({ kind: 'jellyfin', away: { mode: 'vpn', address: 'https://jellyfin.example.test' } }), 'away.vpn_via');
  assert.equal(MD.awayText({ kind: 'jellyfin', away: { mode: 'direct', address: 'https://jellyfin.example.test' } }), 'away.direct');
  assert.equal(MD.awayText({ kind: 'jellyfin', away: { mode: 'vpn' } }), 'away.none');
  assert.equal(MD.awayText({ kind: 'share', away: { mode: 'vpn' } }), 'away.none_share');
  const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'sources.js'), 'utf8');
  assert.doesNotMatch(src, /addrField\.hidden/, 'the address field is not hidden in the VPN mode');
  assert.equal((src.match(/suggestInto\(away\.addr, sg[01]\.away\)/g) || []).length, 2, 'editing a source without an away address prefills it from the route');
});
