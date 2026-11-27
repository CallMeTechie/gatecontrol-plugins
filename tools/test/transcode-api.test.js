'use strict';

// The mock host's mirror of gc.transcode ("Videos umwandeln", GateControl's src/services/homeTranscode.js, hostApi.js
// transcodeCall, the child bootstrap's makeTranscode): only with permissions.transcode and opts.transcode; the host's
// checks before the gateway (gateway, capability, switch, online, id, path under a media folder) with err.reason; the
// stand-in gateway (queue, pause, ack, trash) and the hook transcodeChanged.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHost } = require('../testing/mock-host');

const CODE = `
const seen = [];
module.exports = {
  async start(gc) { if (gc.transcode) gc.transcode.on((ev) => { seen.push(ev); }); },
  async request(req, gc) {
    const b = req.body || {};
    if (req.path === '/has') return { json: { transcode: !!gc.transcode } };
    if (req.path === '/seen') return { json: { seen } };
    try { return { json: { ok: true, result: await gc.transcode[b.op](...(b.args || [])) } }; } catch (e) { return { json: { ok: false, code: e.code, reason: e.reason || null } }; }
  },
};`;

function plugin(perms) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-plugin-'));
  fs.mkdirSync(path.join(dir, 'server'));
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id: 'tc-test', name: 'T', version: '1.0.0', entry: 'server/index.js', permissions: perms }));
  fs.writeFileSync(path.join(dir, 'server', 'index.js'), CODE);
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const call = (host, op, ...args) => host.request({ method: 'POST', path: '/x', body: { op, args } }).then((r) => r.json);
const GWS = [{ id: 3, name: 'NAS', roots: ['/volume2/mediathek'] }, { id: 4, name: 'Alt', supported: false }, { id: 5, name: 'Aus', enabled: false, supported: true }];

test('gc.transcode: only with permissions.transcode and opts.transcode', async () => {
  for (const [perms, opts, want] of [[{ transcode: true }, { transcode: { gateways: [] } }, true], [{ transcode: true }, {}, false], [{}, { transcode: { gateways: [] } }, false]]) {
    const p = plugin(perms);
    const host = await createHost(p.dir, opts);
    try {
      await host.start();
      assert.equal((await host.request({ path: '/has' })).json.transcode, want, JSON.stringify([perms, opts]));
    } finally { await host.close(); p.done(); }
  }
  const p = plugin({ transcode: 'yes' });
  await assert.rejects(createHost(p.dir, { transcode: { gateways: [] } }), { code: 'ERR_INVALID' });
  p.done();
});

test('gc.transcode: the host checks first, the gateway stand-in, the hook', async () => {
  const p = plugin({ transcode: true });
  const host = await createHost(p.dir, { transcode: { gateways: GWS } });
  try {
    await host.start();
    const av = (await call(host, 'available')).result;
    assert.equal(av.available, true);
    assert.deepEqual(av.gateways.map((g) => [g.id, g.supported, g.enabled]), [[3, true, true], [4, false, true], [5, true, false]]);
    assert.deepEqual(av.gateways[0].settings, { roots: ['/volume2/mediathek'], software: false, trashDays: 14, quality: 23 });
    const P = '/volume2/mediathek/Serie/Folge 01.mkv';
    for (const [args, code, reason] of [
      [{ gatewayId: 9, id: 'abcdefgh', path: P }, 'ERR_NOT_FOUND', 'unknown_gateway'],
      [{ gatewayId: 4, id: 'abcdefgh', path: P }, 'ERR_TRANSCODE_UNSUPPORTED', 'gateway_update'],
      [{ gatewayId: 5, id: 'abcdefgh', path: P }, 'ERR_TRANSCODE_UNSUPPORTED', 'feature_disabled'],
      [{ gatewayId: 3, id: 'kurz', path: P }, 'ERR_INVALID', 'invalid_request'],
      [{ gatewayId: 3, id: 'abcdefgh', path: '/volume1/andere/x.mkv' }, 'ERR_INVALID', 'outside_roots'],
      [{ gatewayId: 3, id: 'abcdefgh', path: '/volume2/mediathek/../x.mkv' }, 'ERR_INVALID', 'bad_path'],
      [{ gatewayId: 3, id: 'abcdefgh', path: '/volume2/mediathek/.gc-papierkorb/x.mkv' }, 'ERR_INVALID', 'bad_path'],
    ]) {
      const r = await call(host, 'submit', args);
      assert.deepEqual([r.ok, r.code, r.reason], [false, code, reason], JSON.stringify(args));
    }
    const s = await call(host, 'submit', { gatewayId: 3, id: 'job-0001', path: P });
    assert.equal(s.result.job.state, 'queued');
    assert.equal((await call(host, 'submit', { gatewayId: 3, id: 'job-0001', path: P })).ok, true, 'the same id and path again');
    assert.equal((await call(host, 'submit', { gatewayId: 3, id: 'job-0002', path: P })).reason, 'already_queued');
    assert.equal((await call(host, 'submit', { gatewayId: 3, id: 'job-0001', path: P + 'x' })).reason, 'duplicate_id');
    // pause all / one, resume
    assert.equal((await call(host, 'pause', 3, { ttlSec: 5 })).reason, 'invalid_request');
    assert.equal((await call(host, 'pause', 3, { ttlSec: 180 })).result.pause.all, true);
    assert.equal((await call(host, 'resume', 3)).result.pause.all, false);
    // the gateway reports: stored (report) and handed to the hook
    assert.equal((await call(host, 'report', 3)).result, null);
    host.transcode.finish(3, 'job-0001');
    await host.transcode.report(3);
    const rep = (await call(host, 'report', 3)).result;
    assert.equal(rep.jobs[0].state, 'done');
    assert.equal(rep.trash.length, 1);
    assert.ok(rep.reportedAt);
    const seen = (await host.request({ path: '/seen' })).json.seen;
    assert.equal(seen.length, 1);
    assert.equal(seen[0].gatewayId, 3);
    // ack, restore, purge, settings
    assert.equal((await call(host, 'ack', 3, ['job-0001'])).result.removed, 1);
    assert.equal((await call(host, 'restore', 3, 'job-0001')).result.restored, true);
    assert.deepEqual([(await call(host, 'restore', 3, 'job-0001')).code, (await call(host, 'restore', 3, 'job-0001')).reason], ['ERR_TRANSCODE_FAILED', 'not_in_trash']);
    assert.equal((await call(host, 'purge', 3, { all: true })).result.purged, true);
    assert.equal((await call(host, 'purge', 3, {})).reason, 'invalid_request');
    assert.deepEqual((await call(host, 'settings', 3, { trashDays: 7 })).result, { trashDays: 7, quality: 23 });
    assert.equal((await call(host, 'settings', 3, { roots: [] })).code, 'ERR_INVALID');
    // offline
    host.transcode.gateway(3).online = false;
    assert.deepEqual([(await call(host, 'status', 3)).code], ['ERR_TRANSCODE_OFFLINE']);
  } finally { await host.close(); p.done(); }
});
