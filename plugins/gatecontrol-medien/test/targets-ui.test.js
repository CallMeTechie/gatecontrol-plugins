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
      routes: [], peers: [],
    }),
    set: async (id, list) => { calls.push([id, list]); state[id] = list.map((a) => ({ ...a })); return { assigned: list }; },
  };
  const window = { GC: { call: async () => ({}), targets }, MD_CTX: { texts: {}, lang: 'de' } };
  vm.runInNewContext(SRC, { window, document: {}, setTimeout, clearTimeout, Promise, Object, Number, String });
  return { MD: window.MD, calls };
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

test('without GC.targets (older GateControl): no assignment from the page', async () => {
  const { MD } = load({}, { noTargets: true });
  assert.equal(MD.hasTargets, false);
  assert.equal(await MD.targetsData(), null);
  await assert.rejects(MD.ensureTarget('jellyfin', 'r:1'));
  assert.equal(await MD.ensureTarget('jellyfin', 'a:0'), 0);
});

test('manifest asks for permissions.network.assignTargets and GateControl ≥ 1.324.0; no "Zugriffsziele öffnen" any more', () => {
  const m = require('../plugin.json');
  assert.equal(m.permissions.network.assignTargets, true);
  assert.equal(m.gatecontrol, '>=1.324.0');
  const ui = path.join(__dirname, '..', 'ui');
  for (const f of fs.readdirSync(ui)) assert.doesNotMatch(fs.readFileSync(path.join(ui, f), 'utf8'), /openSettings|targetsLink|targets_open/, f);
});
