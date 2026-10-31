'use strict';

// The mock host without room for new files (GateControl ≥ 1.204.0, media.areas — mediaAreas.capacityCheck): this server
// full (507 server_full) or a storage target failing while the files waiting for it fill the cache (503
// storage_unavailable). host.mediaCapacity(code) — each way a file arrives answers as GateControl does.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHost } = require('../testing/mock-host');

function tmpPlugin(manifest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capacity-'));
  fs.mkdirSync(path.join(dir, 'server'));
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id: 'cap-test', name: 'T', version: '1.0.0', entry: 'server/index.js', ...manifest }));
  fs.writeFileSync(path.join(dir, 'server', 'index.js'), 'module.exports = { async start() {} };');
  return dir;
}

const perms = { mail: { purpose: { de: 'Mail', en: 'Mail' }, maxConnections: 2 }, network: { internet: ['files.example.com'] } };
const media = { maxBytes: 1048576, types: ['application/*', 'image/*'], quotaDefault: '1GB' };

async function hostFor(areas) {
  const dir = tmpPlugin({ permissions: perms, media: { ...media, ...(areas ? { areas: true } : {}) } });
  return createHost(dir, {
    gatecontrol: '1.219.0',
    users: [{ id: 2, name: 'Anna', role: 'user' }],
    fetch: async () => ({ status: 200, headers: { 'content-type': 'application/pdf' }, body: Buffer.from('%PDF') }),
    mail: {
      imap: async (o, ctx) => ({
        open: async () => ({ uidValidity: 1, uidNext: 2, exists: 1 }),
        download: async () => ({ mediaId: ctx.putMedia({ data: 'teil', mime: 'application/pdf' }), bytes: 4, mime: 'application/pdf' }),
      }),
      smtp: async () => ({ messageId: '<x@y>' }),
    },
  });
}

test('mock host: no room for new files — upload 507 / 503, gc.media.fetch the code, gc.mail ERR_INVALID with it, gc.media.copy', async () => {
  const host = await hostFor(true);
  try {
    const gc = host.gc;
    const kept = await host.upload({ id: 2 }, Buffer.from('a'), 'application/pdf');
    assert.equal(kept.status, 200);
    host.mediaCapacity('server_full');
    assert.deepEqual(await host.upload({ id: 2 }, Buffer.from('b'), 'application/pdf'), { status: 507, body: { ok: false, code: 'server_full' } });
    await assert.rejects(gc.media.fetch('https://files.example.com/a.pdf'), (e) => e.code === 'server_full' && e.message === 'server_full');
    await assert.rejects(gc.media.copy(kept.body.mediaId), (e) => e.code === 'ERR_MEDIA_QUOTA' && e.message === 'server_full');
    const s = await gc.mail.imap.connect({ host: 'imap.example.com', port: 993, security: 'tls', auth: { user: 'a@example.com', pass: 'x' } });
    await s.open('INBOX');
    await assert.rejects(s.download(1, '2'), (e) => e.code === 'ERR_INVALID' && e.message === 'server_full');
    // a send goes out; only the copy for "Gesendet" is refused afterwards (as GateControl does)
    await assert.rejects(gc.mail.smtp.send({ host: 'smtp.example.com', port: 465, security: 'tls', auth: { user: 'a@example.com', pass: 'x' }, appendCopy: true,
      message: { from: { address: 'a@example.com' }, to: [{ address: 'b@example.com' }], subject: 'x', text: 'x' } }), (e) => e.code === 'ERR_INVALID' && e.message === 'server_full');
    assert.equal(host.mailSent.length, 1);
    host.mediaCapacity('storage_unavailable');
    assert.deepEqual(await host.upload({ id: 2 }, Buffer.from('b'), 'application/pdf'), { status: 503, body: { ok: false, code: 'storage_unavailable' } });
    await assert.rejects(gc.media.copy(kept.body.mediaId), (e) => e.code === 'ERR_BUSY' && e.message === 'storage_unavailable');
    // files already there stay readable; room again
    assert.ok(await gc.media.info(kept.body.mediaId));
    host.mediaCapacity(null);
    assert.equal((await gc.media.fetch('https://files.example.com/a.pdf')).bytes, 4);
    assert.throws(() => host.mediaCapacity('full'), /unknown capacity code/);
  } finally {
    await host.close();
  }
});

test('mock host: without media.areas GateControl checks no room — host.mediaCapacity changes nothing', async () => {
  const host = await hostFor(false);
  try {
    host.mediaCapacity('server_full');
    assert.equal((await host.upload({ id: 2 }, Buffer.from('a'), 'application/pdf')).status, 200);
    assert.equal((await host.gc.media.fetch('https://files.example.com/a.pdf')).bytes, 4);
  } finally {
    await host.close();
  }
});

test('mock host: an area on a storage target — media.info stored "target", the area\'s state set by the test', async () => {
  const host = await hostFor(true);
  try {
    const gc = host.gc;
    await gc.media.areas.ensure('docs', { label: 'Docs' });
    const up = await host.upload({ id: 2 }, Buffer.from('a'), 'application/pdf');
    await gc.media.claim(up.body.mediaId, { area: 'docs' });
    assert.equal((await gc.media.info(up.body.mediaId)).stored, 'server');
    Object.assign(host.mediaAreas.get('docs'), { target: { id: 1, kind: 'webdav', label: 'NAS' }, state: 'unreachable', error: 'unreachable' });
    assert.equal((await gc.media.info(up.body.mediaId)).stored, 'target');
    const i = await gc.media.areas.info('docs');
    assert.deepEqual([i.target.kind, i.state, i.error], ['webdav', 'unreachable', 'unreachable']);
  } finally {
    await host.close();
  }
});
