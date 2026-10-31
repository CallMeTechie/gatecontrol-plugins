'use strict';

// GateControl 1.219.0 in the tooling: the keys of 1.219.0 for an older pinned validator (permissions.mail.dav,
// permissions.notify.perHour up to 1000) and the mock host's gc.mail.dav / iMIP (tools/testing/mock-mail.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { withoutNewerKeys } = require('../validate');
const { createHost } = require('../testing/mock-host');

test('the keys of 1.219.0: mail.dav left out, notify.perHour checked up to 1000 and given to an older validator as ≤ 120', () => {
  const raw = { permissions: { mail: { purpose: { de: 'x', en: 'x' }, dav: { purpose: { de: 'Kalender', en: 'Calendars' } } }, notify: { perHour: 600 } } };
  const w = withoutNewerKeys(raw, '1.217.0');
  assert.deepEqual(w.errors, []);
  assert.deepEqual(w.copy.permissions, { mail: { purpose: { de: 'x', en: 'x' } }, notify: { perHour: 120 } });
  const bad = withoutNewerKeys({ permissions: { mail: { purpose: { de: 'x' }, dav: {} }, notify: { perHour: 2000 } } }, '1.217.0');
  assert.deepEqual(bad.errors, ['permissions.mail.dav: invalid', 'permissions.notify: invalid']);
  assert.deepEqual(withoutNewerKeys(raw, '1.219.0').removed, []);
});

function tmpPlugin(manifest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc219-'));
  fs.mkdirSync(path.join(dir, 'server'));
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id: 'mail-test', name: 'T', version: '1.0.0', entry: 'server/index.js', ...manifest }));
  fs.writeFileSync(path.join(dir, 'server', 'index.js'), 'module.exports = { async start() {} };');
  return dir;
}

test('mock host 1.219.0: gc.mail.dav.request with the host checks (https, ports, headers, redirects), icalEvent, calendar parts', async () => {
  const dir = tmpPlugin({ permissions: { mail: { purpose: { de: 'Mail', en: 'Mail' }, dav: { purpose: { de: 'Kalender', en: 'Calendars' } } } }, media: { maxBytes: 1048576, types: ['application/*', 'text/plain'] } });
  const seen = [];
  const host = await createHost(dir, {
    gatecontrol: '1.219.0',
    mail: {
      smtp: async () => ({ messageId: '<x@y>' }),
      dav: async (req) => {
        seen.push(req);
        if (req.url.endsWith('/moved')) return { status: 301, headers: { location: '/home/' } };
        if (req.url.endsWith('/away')) return { status: 302, headers: { location: 'https://other.example/x' } };
        if (req.method === 'PROPFIND') return { status: 207, multistatus: { responses: [{ href: '/home/', status: null, propstat: [{ status: 200, props: { '{DAV:}displayname': { text: 'Home' } } }] }], syncToken: null } };
        return { status: 401 };
      },
    },
  });
  try {
    const dav = host.gc.mail.dav;
    const r = await dav.request({ url: 'https://dav.example.com/moved', method: 'PROPFIND', headers: { depth: '0' }, body: '<x/>', auth: { user: 'a', pass: 'b' } });
    assert.deepEqual([r.status, r.url, r.multistatus.responses[0].href], [207, 'https://dav.example.com/home/', 'https://dav.example.com/home/']);
    assert.deepEqual(seen.map((x) => x.url), ['https://dav.example.com/moved', 'https://dav.example.com/home/'], 'same origin: followed with auth');
    const away = await dav.request({ url: 'https://dav.example.com/away', method: 'GET', auth: { user: 'a', pass: 'b' } });
    assert.deepEqual([away.status, away.headers.location], [302, 'https://other.example/x'], 'another origin comes back');
    assert.equal((await dav.request({ url: 'https://dav.example.com/x', method: 'GET' })).status, 401, 'HTTP statuses are no errors');
    await assert.rejects(dav.request({ url: 'http://dav.example.com/', method: 'GET' }), { code: 'ERR_NETWORK_DENIED' });
    await assert.rejects(dav.request({ url: 'https://dav.example.com:8080/', method: 'GET' }), { code: 'ERR_NETWORK_DENIED' });
    await assert.rejects(dav.request({ url: 'https://192.168.1.2/', method: 'GET' }), { code: 'ERR_NETWORK_DENIED' });
    await assert.rejects(dav.request({ url: 'https://dav.example.com/', method: 'MKCOL' }), { code: 'ERR_INVALID' });
    await assert.rejects(dav.request({ url: 'https://dav.example.com/', method: 'GET', headers: { authorization: 'Basic x' } }), { code: 'ERR_INVALID' });
    await assert.rejects(dav.request({ url: 'https://dav.example.com/', method: 'PUT', body: 'x'.repeat(2 * 1024 * 1024 + 1) }), { code: 'ERR_MAIL_LIMIT' });
    assert.ok(host.davRequests.every((x) => !x.auth || !('pass' in x.auth)), 'no password in the record');
    const msg = (method, content, filename) => ({ host: 'smtp.example.com', port: 587, security: 'starttls', auth: { user: 'a', pass: 'b' },
      message: { from: { address: 'a@example.com' }, to: [{ address: 'b@example.com' }], subject: 'Einladung', text: 'x', icalEvent: { method, content, ...(filename ? { filename } : {}) } } });
    const ok = 'BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR\r\n';
    assert.equal((await host.gc.mail.smtp.send(msg('REQUEST', ok, 'invite.ics'))).messageId, '<x@y>');
    await assert.rejects(host.gc.mail.smtp.send(msg('REPLY', ok)), { code: 'ERR_INVALID' }, 'METHOD must match');
    await assert.rejects(host.gc.mail.smtp.send(msg('REQUEST', ok, 'invite.txt')), { code: 'ERR_INVALID' });
    await assert.rejects(host.gc.mail.smtp.send(msg('PUBLISH', ok)), { code: 'ERR_INVALID' });
    const raw = await host.gc.mail.compose({ from: { address: 'a@example.com' }, to: [], subject: 'x', text: 'y', icalEvent: { method: 'REQUEST', content: ok } });
    const parsed = await host.gc.mail.parse(raw.mediaId);
    assert.deepEqual(parsed.calendar.map((c) => c.method), ['REQUEST']);
  } finally {
    await host.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // an older host: no gc.mail.dav, icalEvent refused — the dav key itself is accepted (like maxPerHour)
  const d2 = tmpPlugin({ permissions: { mail: { purpose: { de: 'Mail', en: 'Mail' }, dav: { purpose: { de: 'K', en: 'C' } } } } });
  const h2 = await createHost(d2, { gatecontrol: '1.217.0', mail: { smtp: async () => ({}) } });
  assert.equal(h2.gc.mail.dav, undefined);
  await assert.rejects(h2.gc.mail.smtp.send({ host: 'smtp.example.com', port: 587, security: 'starttls', auth: { user: 'a', pass: 'b' },
    message: { from: { address: 'a@example.com' }, to: [{ address: 'b@example.com' }], icalEvent: { method: 'REQUEST', content: 'BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\n' } } }), { code: 'ERR_INVALID' });
  await h2.close();
  fs.rmSync(d2, { recursive: true, force: true });
  // without dav in the permission: no gc.mail.dav on 1.219.0 either
  const d3 = tmpPlugin({ permissions: { mail: { purpose: { de: 'Mail', en: 'Mail' } } } });
  const h3 = await createHost(d3, { gatecontrol: '1.219.0', mail: {} });
  assert.equal(h3.gc.mail.dav, undefined);
  await h3.close();
  fs.rmSync(d3, { recursive: true, force: true });
});
