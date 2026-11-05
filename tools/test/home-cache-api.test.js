'use strict';

// The mock host's mirror of GateControl 1.231.0 gc.homeCache (src/services/homeCache.js offer / withdraw / lanFor,
// hostApi.js homeCacheCall, plugins/requestRefs.js, the child bootstrap's makeHomeCache): only with
// permissions.homeCache, the stock keyed by sha256, req.homeRef only while that request runs, the hint only for own
// offers, at home, held by the gateway and for the people of the offer.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHost } = require('../testing/mock-host');

const USERS = [{ id: 1, name: 'admin', role: 'admin' }, { id: 2, name: 'Anna', role: 'user' }, { id: 3, name: 'Marc', role: 'user' }];
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// a plugin whose request hook calls gc.homeCache[op](...args) — lanHint with the request itself — and answers
// { ok, result, homeRef } or { ok: false, code }; /later calls lanHint with a request that has ended
const CODE = `
let last = null;
module.exports = {
  async request(req, gc) {
    const b = req.body || {};
    if (req.path === '/ref') return { json: { homeRef: typeof req.homeRef === 'string' } };
    if (req.path === '/later') { try { return { json: { ok: true, result: await gc.homeCache.lanHint(b.what, last) } }; } catch (e) { return { json: { ok: false, code: e.code } }; } }
    last = req;
    const args = b.op === 'lanHint' ? [b.what, req] : (b.args || []);
    try { return { json: { ok: true, result: await gc.homeCache[b.op](...args), homeRef: typeof req.homeRef === 'string', home: 'home' in req } }; } catch (e) { return { json: { ok: false, code: e.code } }; }
  },
};`;

function plugin(perms) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-plugin-'));
  fs.mkdirSync(path.join(dir, 'server'));
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
    id: 'hc-test', name: 'H', version: '1.0.0', entry: 'server/index.js', permissions: perms,
    media: { maxBytes: 1048576, types: ['text/plain'], quotaDefault: '10MB' },
  }));
  fs.writeFileSync(path.join(dir, 'server', 'index.js'), CODE);
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('gc.homeCache: only with permissions.homeCache, from GateControl 1.231.0 or with opts.homeCache', async () => {
  const p = plugin({ homeCache: true });
  const none = plugin({});
  try {
    for (const [dir, o, has] of [[p.dir, {}, false], [p.dir, { gatecontrol: '1.230.0' }, false], [p.dir, { gatecontrol: '1.231.0' }, true], [p.dir, { homeCache: {} }, true],
      [none.dir, { gatecontrol: '1.231.0', homeCache: {} }, false]]) {
      const h = await createHost(dir, o);
      assert.equal(!!h.gc.homeCache, has, JSON.stringify(o));
      // req.homeRef only for a plugin that has gc.homeCache
      const r = await h.request({ method: 'GET', path: '/ref', user: { id: 2, portal: true, loggedIn: true, app: true } });
      assert.equal(r.json.homeRef, has, JSON.stringify(o));
      await h.close();
    }
    const bad = plugin({ homeCache: 'yes' });
    await assert.rejects(createHost(bad.dir, { gatecontrol: '1.231.0' }), (e) => e.code === 'ERR_INVALID');
    // an older GateControl ignores the key
    await (await createHost(bad.dir, { gatecontrol: '1.230.0' })).close();
    bad.done();
  } finally { p.done(); none.done(); }
});

test('gc.homeCache: offer / withdraw keyed by sha256, lanHint only in the request, at home, own offers, the offer\'s people', async () => {
  const p = plugin({ homeCache: true });
  const held = new Set();
  const h = await createHost(p.dir, { users: USERS, gatecontrol: '1.231.0', homeCache: { foreign: [sha('update')], held: (s) => held.has(s) } });
  try {
    await h.start();
    const up = async (data) => (await h.upload({ id: 2 }, Buffer.from(data), 'text/plain')).body.mediaId;
    const anna = (body, o = {}) => h.request({ method: 'POST', path: '/x', body, user: { id: 2, portal: true, loggedIn: true, app: true }, ...o });
    const marc = (body, o = {}) => h.request({ method: 'POST', path: '/x', body, user: { id: 3, portal: true, loggedIn: true, app: true }, ...o });
    const a = await up('hello');
    const b = await up('hello'); // the same content
    const c = await up('update');

    // offer: checks like the host
    for (const [args, code] of [[{ kind: 'drive' }, 'ERR_INVALID'], [{ mediaId: a, kind: 'music' }, 'ERR_INVALID'], [{ mediaId: 'nope', kind: 'drive' }, 'ERR_NOT_FOUND'],
      [{ mediaId: a, kind: 'drive', userIds: [0] }, 'ERR_INVALID'], [{ mediaId: a, kind: 'drive', userIds: Array.from({ length: 257 }, (_, i) => i + 1) }, 'ERR_INVALID'],
      [{ mediaId: a, kind: 'drive', priority: 101 }, 'ERR_INVALID'], [{ mediaId: a, kind: 'drive', priority: 1.5 }, 'ERR_INVALID'],
      [{ mediaId: a, kind: 'drive', sha256: sha('other') }, 'ERR_INVALID'], [{ mediaId: a, kind: 'drive', size: 4 }, 'ERR_INVALID']]) {
      const r = await anna({ op: 'offer', args: [args] });
      assert.equal(r.json.code, code, JSON.stringify(args));
    }
    let r = await anna({ op: 'offer', args: [{ mediaId: a, kind: 'drive', userIds: [2, 2], priority: 80, sha256: sha('hello'), size: 5 }] });
    assert.deepEqual(r.json.result, { sha256: sha('hello'), size: 5, offered: true });
    assert.deepEqual(h.homeCache.offers.get(sha('hello')), { ...h.homeCache.offers.get(sha('hello')), mediaId: a, kind: 'drive', userIds: [2], priority: 80 });
    // the same content of another media id replaces the entry (one per sha256)
    r = await anna({ op: 'offer', args: [{ mediaId: b, kind: 'photos' }] });
    assert.equal(r.json.result.offered, true);
    assert.equal(h.homeCache.offers.size, 1);
    assert.deepEqual([h.homeCache.offers.get(sha('hello')).mediaId, h.homeCache.offers.get(sha('hello')).userIds, h.homeCache.offers.get(sha('hello')).priority], [b, null, 50]);
    // content in the stock from elsewhere: not offered
    assert.deepEqual((await anna({ op: 'offer', args: [{ mediaId: c, kind: 'drive' }] })).json.result, { sha256: sha('update'), size: 6, offered: false });
    await anna({ op: 'offer', args: [{ mediaId: a, kind: 'drive', userIds: [2] }] });

    // lanHint: req.homeRef only while the request runs; home: true is never part of the plugin's request
    r = await anna({ op: 'lanHint', what: { mediaId: a } });
    assert.equal(r.json.home, false);
    assert.equal(r.json.result, null); // not at home
    r = await anna({ op: 'lanHint', what: { mediaId: a } }, { home: true });
    assert.equal(r.json.result, null); // the gateway does not hold it yet
    held.add(sha('hello'));
    r = await anna({ op: 'lanHint', what: { mediaId: a } }, { home: true });
    const hint = r.json.result;
    assert.equal(hint.sha256, sha('hello'));
    assert.equal(hint.tlsSha256, 'ab'.repeat(32));
    assert.match(hint.url, new RegExp(`^https://192\\.168\\.1\\.23:8443/blob/${sha('hello')}\\?exp=${hint.exp}&sig=[0-9a-f]{64}$`));
    assert.ok(hint.exp > Date.now() / 1000 && hint.exp <= Date.now() / 1000 + 600);
    // by sha256 too; the same content under another media id
    assert.equal((await anna({ op: 'lanHint', what: sha('hello') }, { home: true })).json.result.sha256, sha('hello'));
    assert.equal((await anna({ op: 'lanHint', what: { mediaId: b } }, { home: true })).json.result.sha256, sha('hello'));
    // Marc is not one of the offer's people
    assert.equal((await marc({ op: 'lanHint', what: { mediaId: a } }, { home: true })).json.result, null);
    // not this plugin's offer (an app update), unknown content, bad input
    assert.equal((await anna({ op: 'lanHint', what: sha('update') }, { home: true })).json.result, null);
    assert.equal((await anna({ op: 'lanHint', what: sha('x') }, { home: true })).json.result, null);
    assert.equal((await anna({ op: 'lanHint', what: 'xyz' }, { home: true })).json.code, 'ERR_INVALID');
    assert.equal((await anna({ op: 'lanHint', what: { mediaId: 'nope' } }, { home: true })).json.code, 'ERR_NOT_FOUND');
    // outside the request: ERR_NOT_IN_REQUEST
    assert.equal((await h.request({ method: 'POST', path: '/later', body: { what: sha('hello') }, user: { id: 2, portal: true, loggedIn: true, app: true }, home: true })).json.code, 'ERR_NOT_IN_REQUEST');

    // withdraw by media id; a deleted media file leaves the stock with the host's hourly sweep
    assert.deepEqual((await anna({ op: 'withdraw', args: [b] })).json.result, { removed: false });
    assert.deepEqual((await anna({ op: 'withdraw', args: [a] })).json.result, { removed: true });
    assert.equal(h.homeCache.offers.size, 0);
    assert.equal((await anna({ op: 'lanHint', what: { mediaId: a } }, { home: true })).json.result, null);
    await anna({ op: 'offer', args: [{ mediaId: a, kind: 'vault' }] });
    h.media.delete(a);
    assert.equal(h.homeCacheDropStale(), 1);
    assert.equal(h.homeCache.offers.size, 0);
    assert.ok(h.homeCache.calls.some((x) => x.op === 'withdraw'));
  } finally { await h.close(); p.done(); }
});

test('gc.homeCache without the permission on a host that has it: no gc.homeCache, no req.homeRef', async () => {
  const p = plugin({});
  const h = await createHost(p.dir, { users: USERS, gatecontrol: '1.231.0' });
  try {
    assert.equal(h.gc.homeCache, undefined);
    const r = await h.request({ method: 'GET', path: '/ref', user: { id: 2, portal: true, loggedIn: true, app: true }, home: true });
    assert.equal(r.json.homeRef, false);
  } finally { await h.close(); p.done(); }
});
