'use strict';

// GateControl 1.216.0 in the tooling: plugins built for a GateControl newer than the pinned one (validate.js without the
// keys of that version, pack.js leaves them out of --all) and the mock host's mail API (tools/testing/mock-mail.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lib = require('../lib');
const { withoutNewerKeys } = require('../validate');
const { createHost, hostError } = require('../testing/mock-host');

test('minGatecontrol and the keys of a newer GateControl', () => {
  assert.equal(lib.minGatecontrol('>=1.216.0'), '1.216.0');
  assert.equal(lib.minGatecontrol('^1.2.3 || >=2.0.0'), '1.2.3');
  assert.equal(lib.minGatecontrol('*'), null);
  const raw = {
    permissions: { mail: { purpose: { de: 'x', en: 'x' }, maxConnections: 100 }, network: { internet: ['a.example'], images: true } },
    services: { provides: { a: { label: 'A', maxPerHour: 600 }, b: { label: 'B' } } },
  };
  const w = withoutNewerKeys(raw, '1.214.0');
  assert.deepEqual(w.errors, []);
  assert.deepEqual(w.copy, { permissions: { network: { internet: ['a.example'] } }, services: { provides: { a: { label: 'A' }, b: { label: 'B' } } } });
  assert.equal(w.removed.length, 3);
  assert.ok(raw.permissions.mail, 'the original stays');
  const bad = withoutNewerKeys({ permissions: { mail: { maxConnections: 500 }, network: { images: 'yes' } }, services: { provides: { a: { label: 'A', maxPerHour: 10 } } } }, '1.214.0');
  assert.deepEqual(bad.errors, ['permissions.mail: invalid', 'permissions.network: invalid images', 'services.provides: invalid maxPerHour']);
  // pinned at 1.216.0: nothing is removed (GateControl's own validator knows the keys)
  assert.deepEqual(withoutNewerKeys(raw, '1.216.0').removed, []);
});

function tmpPlugin(manifest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc216-'));
  fs.mkdirSync(path.join(dir, 'server'));
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id: 'mail-test', name: 'T', version: '1.0.0', entry: 'server/index.js', ...manifest }));
  fs.writeFileSync(path.join(dir, 'server', 'index.js'), 'module.exports = { async start() {} };');
  return dir;
}

test('mock host 1.216.0: gc.mail only with permissions.mail, sessions with the host checks, fetchImage', async () => {
  const dir = tmpPlugin({ permissions: { mail: { purpose: { de: 'Mail', en: 'Mail' }, maxConnections: 1 }, network: { images: true } }, media: { maxBytes: 1048576, types: ['application/*', 'image/*'] } });
  const sessions = [];
  const host = await createHost(dir, {
    gatecontrol: '1.216.0',
    mail: {
      imap: async (o, ctx) => {
        if (o.auth.pass === 'wrong') throw hostError('ERR_MAIL_AUTH', 'no');
        const s = { list: async () => [{ path: 'INBOX', specialUse: '\\Inbox' }], open: async () => ({ uidValidity: 1, uidNext: 2, exists: 1 }), ctx };
        sessions.push(s);
        return s;
      },
      smtp: async () => ({ messageId: '<x@y>' }),
    },
    fetchImage: async (url) => (url.includes('svg') ? { mime: 'image/svg+xml', body: Buffer.from('<svg/>') } : url.includes('404') ? { status: 404, mime: 'text/html', body: '' } : { mime: 'image/png', body: Buffer.alloc(10) }),
  });
  try {
    const gc = host.gc;
    assert.equal(typeof gc.mail.imap.connect, 'function');
    await assert.rejects(gc.mail.imap.connect({ host: 'imap.example.com', port: 25, security: 'tls', auth: { user: 'a', pass: 'b' } }), { code: 'ERR_NETWORK_DENIED' });
    await assert.rejects(gc.mail.imap.connect({ host: '192.168.1.5', port: 993, security: 'tls', auth: { user: 'a', pass: 'b' } }), { code: 'ERR_NETWORK_DENIED' });
    await assert.rejects(gc.mail.imap.connect({ host: 'imap.example.com', port: 993, security: 'tls', auth: { user: 'a', pass: 'wrong' } }), { code: 'ERR_MAIL_AUTH' });
    const s = await gc.mail.imap.connect({ host: 'imap.example.com', port: 993, security: 'tls', auth: { user: 'a', pass: 'b' } });
    assert.deepEqual(await s.list(), [{ path: 'INBOX', specialUse: '\\Inbox' }]);
    await assert.rejects(s.fetch('1:x', {}), { code: 'ERR_INVALID' });
    await assert.rejects(s.search({}), { code: 'ERR_MAIL_PROTOCOL' });
    await assert.rejects(gc.mail.imap.connect({ host: 'imap.example.com', port: 993, security: 'tls', auth: { user: 'a', pass: 'b' } }), { code: 'ERR_MAIL_LIMIT' });
    await s.close();
    const s2 = await gc.mail.imap.connect({ host: 'imap.example.com', port: 143, security: 'starttls', auth: { user: 'a', accessToken: 't' } });
    assert.equal(host.mailSessions[host.mailSessions.length - 1].oauth, true);
    sessions[sessions.length - 1].ctx.emit('exists', { path: 'INBOX', count: 2 });
    const ev = await new Promise((res) => s2.once('exists', res));
    assert.equal(ev.count, 2);
    const sent = await gc.mail.smtp.send({ host: 'smtp.example.com', port: 587, security: 'starttls', auth: { user: 'a', pass: 'b' }, appendCopy: true,
      message: { from: { address: 'a@example.com' }, to: [{ address: 'b@example.com' }], subject: 'Hi', text: 'x' } });
    assert.deepEqual([sent.messageId, sent.accepted, typeof sent.raw.mediaId], ['<x@y>', ['b@example.com'], 'string']);
    await assert.rejects(gc.mail.smtp.send({ host: 'smtp.example.com', port: 587, security: 'starttls', auth: { user: 'a', pass: 'b' },
      message: { from: { address: 'a@example.com' }, to: [], headers: { Subject: 'x' } } }), { code: 'ERR_INVALID' });
    const san = await gc.mail.sanitize('<p onclick="x()">Hi<script>alert(1)</script><img src="https://a.example/x.png"><img src="https://b.example/p.gif" width="1" height="1"></p>');
    assert.deepEqual([san.html, san.images, san.trackers], ['<p>Hi<img src="gc-img:0"></p>', ['https://a.example/x.png'], 1]);
    const img = await gc.http.fetchImage('https://a.example/x.png');
    assert.equal(Buffer.isBuffer(img.bytes), true);
    await assert.rejects(gc.http.fetchImage('https://a.example/x.svg'), { code: 'ERR_INVALID' });
    await assert.rejects(gc.http.fetchImage('https://a.example/404'), { code: 'ERR_HTTP' });
    await assert.rejects(gc.http.fetchImage('https://a.example:9000/x.png'), { code: 'ERR_NETWORK_DENIED' });
  } finally {
    await host.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // without the permission: no gc.mail; a purpose is required
  const d2 = tmpPlugin({});
  const h2 = await createHost(d2, { gatecontrol: '1.216.0' });
  assert.equal(h2.gc.mail, undefined);
  await h2.close();
  fs.rmSync(d2, { recursive: true, force: true });
  const d3 = tmpPlugin({ permissions: { mail: { maxConnections: 5 } } });
  await assert.rejects(createHost(d3, { gatecontrol: '1.216.0' }), { code: 'ERR_INVALID' });
  fs.rmSync(d3, { recursive: true, force: true });
});

test('mock host: maxPerHour of a provider counts its own calls', async () => {
  const dir = tmpPlugin({ permissions: { services: ['other:many', 'other:few'] } });
  const host = await createHost(dir, { gatecontrol: '1.216.0', services: [{ plugin: 'other', provides: { many: { label: 'M', maxPerHour: 100 }, few: { label: 'F' } }, service: async () => ({ ok: true }) }] });
  try {
    for (let i = 0; i < 80; i++) await host.gc.services.call({ plugin: 'other', service: 'many' });
    await host.gc.services.call({ plugin: 'other', service: 'few' });
    for (let i = 0; i < 20; i++) await host.gc.services.call({ plugin: 'other', service: 'many' });
    await assert.rejects(host.gc.services.call({ plugin: 'other', service: 'many' }), { code: 'ERR_RATE_LIMIT' });
  } finally {
    await host.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
