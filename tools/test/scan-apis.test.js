'use strict';

// The mock host's mirror of GateControl's virus scan (opts.scan; src/services/scan/, docs/feature-malware-scan-contract.md):
// the state of every new file in upload answers and gc.media.info, 423 for files it holds back, the host API codes,
// hand-over keeping the state, host.mediaScanned with the hook. Without opts.scan none of it (an older host).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHost } = require('../testing/mock-host');

const USERS = [{ id: 1, name: 'admin', role: 'admin' }, { id: 2, name: 'Anna', role: 'user' }];
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
const MEDIA = { maxBytes: 1024 * 1024, types: ['application/pdf', 'application/octet-stream'], quotaDefault: '10MB' };

const dirs = [];
function plugin(id, manifest, code = 'module.exports = {};') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-plugin-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, 'server'));
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id, name: id, version: '1.0.0', entry: 'server/index.js', ...manifest }));
  fs.writeFileSync(path.join(dir, 'server', 'index.js'), code);
  return dir;
}
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

test('without opts.scan: no scan in answers and info (an older host)', async () => {
  const h = await createHost(plugin('sc-old', { media: MEDIA }), { gatecontrol: '1.193.0', users: USERS });
  try {
    const r = await h.upload({ id: 2 }, Buffer.from(EICAR), 'application/pdf');
    assert.equal(r.status, 200);
    assert.equal(r.body.scan, undefined);
    assert.equal((await h.gc.media.info(r.body.mediaId)).scan, undefined);
    assert.equal((await h.mediaGet({ id: 2 }, r.body.mediaId)).status, 200);
  } finally { await h.close(); }
});

test('opts.scan: upload answers and info carry the state; EICAR is quarantined and held back (423, host API codes)', async () => {
  const seen = [];
  const h = await createHost(plugin('sc-a', { media: MEDIA }, 'module.exports = { async mediaScanned(p) { (globalThis.__scanSeen = globalThis.__scanSeen || []).push(p); } };'),
    { gatecontrol: '1.193.0', users: USERS, scan: true });
  globalThis.__scanSeen = seen;
  try {
    const ok = await h.upload({ id: 2 }, Buffer.from('%PDF-1'), 'application/pdf');
    assert.deepEqual(ok.body.scan, { state: 'clean', blocked: false, finding: null });
    const info = await h.gc.media.info(ok.body.mediaId);
    assert.deepEqual([info.scan.state, info.scan.blocked, info.scan.finding, typeof info.scan.at], ['clean', false, null, 'string']);
    const bad = await h.upload({ id: 2 }, Buffer.from(EICAR), 'application/pdf');
    assert.deepEqual(bad.body.scan, { state: 'infected', blocked: true, finding: 'Eicar-Test-Signature' });
    const got = await h.mediaGet({ id: 2 }, bad.body.mediaId);
    assert.deepEqual([got.status, got.json, got.headers['cache-control']], [423, { ok: false, code: 'quarantined', finding: 'Eicar-Test-Signature' }, 'no-store']);
    const url = await h.gc.media.url(bad.body.mediaId, { user: 2 });
    assert.equal((await h.mediaFromUrl(url)).status, 423);
    // a result after the upload answered: the hook hears it
    const p = await h.mediaScanned(bad.body.mediaId, { state: 'clean' });
    assert.deepEqual(p, { mediaId: bad.body.mediaId, state: 'clean', blocked: false, finding: null });
    assert.deepEqual(seen, [p]);
    assert.equal((await h.mediaGet({ id: 2 }, bad.body.mediaId)).status, 200);
    await h.mediaScanned(ok.body.mediaId, { state: 'deleted' });
    assert.equal(await h.gc.media.info(ok.body.mediaId), null);
    assert.equal(seen[1].state, 'deleted');
  } finally { await h.close(); delete globalThis.__scanSeen; }
});

test('opts.scan as a function: pending (Retry-After), deleted at once (422), held (503); host API errors', async () => {
  let next = null;
  const h = await createHost(plugin('sc-b', { media: MEDIA }), { gatecontrol: '1.193.0', users: USERS, scan: () => next });
  try {
    next = { state: 'pending' };
    const pend = await h.upload({ id: 2 }, Buffer.from('%PDF-big'), 'application/pdf');
    assert.deepEqual(pend.body.scan, { state: 'pending', blocked: true, finding: null });
    const r = await h.mediaGet({ id: 2 }, pend.body.mediaId);
    assert.deepEqual([r.status, r.json.code, r.headers['retry-after']], [423, 'scan_pending', '5']);
    next = { state: 'unscannable', blocked: false, finding: 'encrypted' };
    const un = await h.upload({ id: 2 }, Buffer.from('zip'), 'application/pdf');
    assert.deepEqual(un.body.scan, { state: 'unscannable', blocked: false, finding: 'encrypted' });
    assert.equal((await h.mediaGet({ id: 2 }, un.body.mediaId)).status, 200);
    next = { deleted: true, finding: 'Win.Trojan.Agent' };
    assert.deepEqual(await h.upload({ id: 2 }, Buffer.from('x'), 'application/pdf'), { status: 422, body: { ok: false, code: 'infected', finding: 'Win.Trojan.Agent' } });
    next = { hold: true };
    assert.deepEqual(await h.upload({ id: 2 }, Buffer.from('x'), 'application/pdf'), { status: 503, body: { ok: false, code: 'scan_unavailable' } });
    assert.equal(h.media.size, 2);
  } finally { await h.close(); }
});

test('hand-over: a held-back file goes nowhere; a copy keeps the state of the source', async () => {
  const target = await createHost(plugin('sc-target', { media: MEDIA, services: { provides: { take: { label: 'Take' } } } }), { gatecontrol: '1.193.0', users: USERS, scan: true });
  const src = await createHost(plugin('sc-src', { media: MEDIA, permissions: { services: ['sc-target:take'] } }), { gatecontrol: '1.193.0', users: USERS, scan: true, services: [{ plugin: 'sc-target', host: target }] });
  try {
    const bad = (await src.upload({ id: 2 }, Buffer.from(EICAR), 'application/pdf')).body.mediaId;
    await assert.rejects(src.gc.media.handOver(bad, { toPlugin: 'sc-target', user: 2 }), (e) => e.code === 'ERR_MEDIA_QUARANTINED');
    const marked = (await src.upload({ id: 2 }, Buffer.from('%PDF'), 'application/pdf')).body.mediaId;
    await src.mediaScanned(marked, { state: 'infected', blocked: false, finding: 'GC.Office.Macro' });
    const h = await src.gc.media.handOver(marked, { toPlugin: 'sc-target', user: 2 });
    assert.deepEqual((await target.gc.media.info(h.mediaId)).scan.state, 'infected');
    const pend = (await src.upload({ id: 2 }, Buffer.from('%PDF-2'), 'application/pdf')).body.mediaId;
    await src.mediaScanned(pend, { state: 'pending' });
    await assert.rejects(src.gc.media.handOver(pend, { toPlugin: 'sc-target', user: 2 }), (e) => e.code === 'ERR_MEDIA_SCAN_PENDING');
    await src.mediaScanned(pend, { state: 'unscannable', blocked: true, finding: 'too_large' });
    await assert.rejects(src.gc.media.handOver(pend, { toPlugin: 'sc-target', user: 2 }), (e) => e.code === 'ERR_MEDIA_BLOCKED');
  } finally { await src.close(); await target.close(); }
});
