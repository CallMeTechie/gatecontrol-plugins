'use strict';

// The mock host's mirror of GateControl 1.177.0 (messenger foundations):
// plugin media (`media`, gc.media, uploads, mediaAccess, signed URLs, clean-up),
// realtime events (permissions.events, gc.events.emit), chat notifications
// (notifyTopics[].chat) and services between plugins (services.provides,
// permissions.services, gc.services.call, the hook service).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createHost } = require('../testing/mock-host');

const USERS = [{ id: 1, name: 'admin', role: 'admin' }, { id: 2, name: 'Anna', role: 'user' }, { id: 3, name: 'Ben', role: 'user' }, { id: 4, name: 'Alt', role: 'user', disabled: true }];

/** A plugin folder with plugin.json `manifest` and server/index.js `code` → { dir, done } */
function plugin(manifest, code = 'module.exports = {};') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-plugin-'));
  fs.mkdirSync(path.join(dir, 'server'));
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id: 'msg-test', name: 'M', version: '1.0.0', entry: 'server/index.js', ...manifest }));
  fs.writeFileSync(path.join(dir, 'server', 'index.js'), code);
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const MEDIA = { maxBytes: 200 * 1024, types: ['image/png', 'audio/ogg', 'application/pdf'], quotaDefault: '1MB' };

test('media: plugin.json is validated like GateControl', async () => {
  for (const [m, what] of [['x', 'media'], [{ maxBytes: 100, types: ['image/png'] }, 'media.maxBytes'], [{ maxBytes: 4096, types: ['text/html'] }, 'media.types'],
    [{ maxBytes: 4096, types: ['image/svg+xml'] }, 'media.types'], [{ maxBytes: 4096, types: [] }, 'media.types'],
    [{ maxBytes: 4096, types: ['image/png'], quotaDefault: '1 XB' }, 'media.quotaDefault'], [{ maxBytes: 4096 * 1024, types: ['image/png'], quotaDefault: '2MB' }, 'media.quotaDefault']]) {
    const p = plugin({ media: m });
    try { await assert.rejects(createHost(p.dir), (e) => e.code === 'ERR_INVALID' && e.message.includes(what), JSON.stringify(m)); } finally { p.done(); }
  }
  const ok = plugin({ media: { maxBytes: 4096, types: ['Image/PNG', 'image/png'] } });
  try {
    const h = await createHost(ok.dir);
    assert.deepEqual(await h.gc.media.usage(), { bytes: 0, count: 0, quota: 1024 ** 3, maxBytes: 4096, types: ['image/png'] }, 'default quota 1 GB');
    await h.close();
  } finally { ok.done(); }
});

test('media: uploads, gc.media.info/claim/delete/usage, quota, clean-up', async () => {
  const p = plugin({ permissions: { app: true }, media: MEDIA });
  const h = await createHost(p.dir, { users: USERS });
  try {
    const anna = { id: 2, name: 'Anna', role: 'user' };
    assert.deepEqual(await h.upload(anna, Buffer.from('<b>'), 'text/html'), { status: 415, body: { ok: false, code: 'unsupported_type' } });
    assert.deepEqual(await h.upload(anna, Buffer.alloc(0), 'image/png'), { status: 411, body: { ok: false, code: 'length_required' } });
    assert.deepEqual(await h.upload(anna, Buffer.alloc(200 * 1024 + 1), 'image/png'), { status: 413, body: { ok: false, code: 'too_large' } });
    const up = await h.upload(anna, crypto.randomBytes(1000), 'image/png; charset=binary');
    assert.equal(up.status, 200);
    assert.match(up.body.mediaId, /^[0-9a-f]{32}$/);
    assert.deepEqual([up.body.mime, up.body.bytes], ['image/png', 1000]);
    const id = up.body.mediaId;
    const info = await h.gc.media.info(id);
    assert.deepEqual([info.mediaId, info.owner, info.claimed, info.bytes], [id, 2, false, 1000]);
    assert.match(info.sha256, /^[0-9a-f]{64}$/);
    assert.equal(await h.gc.media.info('f'.repeat(32)), null);
    await assert.rejects(h.gc.media.info('nope'), { code: 'ERR_INVALID' });
    await assert.rejects(h.gc.media.claim('f'.repeat(32)), { code: 'ERR_INVALID' });
    assert.equal((await h.gc.media.claim(id)).claimed, true);
    assert.equal((await h.gc.media.claim(id)).claimed, true, 'idempotent');
    // quota 1 MB
    for (let i = 0; i < 5; i++) assert.equal((await h.upload(anna, crypto.randomBytes(200 * 1024), 'audio/ogg')).status, 200);
    assert.deepEqual(await h.upload(anna, crypto.randomBytes(200 * 1024), 'audio/ogg'), { status: 507, body: { ok: false, code: 'quota_exceeded' } });
    const usage = await h.gc.media.usage();
    assert.deepEqual([usage.count, usage.quota, usage.maxBytes], [6, 1024 * 1024, 200 * 1024]);
    // clean-up: unclaimed files older than 24 h
    assert.equal(h.mediaCleanup(), 0);
    assert.equal(h.mediaCleanup(Date.now() + 25 * 3600 * 1000), 5);
    assert.ok(await h.gc.media.info(id), 'claimed stays');
    assert.equal(await h.gc.media.delete(id), true);
    assert.equal(await h.gc.media.delete(id), false);
    assert.equal(h.media.size, 0);
  } finally { await h.close(); p.done(); }
  const q = plugin({ media: MEDIA });
  const h2 = await createHost(q.dir, { mediaQuota: 300 * 1024 });
  try {
    assert.equal((await h2.upload({ id: 1 }, Buffer.alloc(200 * 1024), 'image/png')).status, 200);
    assert.equal((await h2.upload({ id: 1 }, Buffer.alloc(200 * 1024), 'image/png')).status, 507, 'opts.mediaQuota (the administrator\'s value)');
  } finally { await h2.close(); q.done(); }
  const none = plugin({});
  const h3 = await createHost(none.dir);
  try {
    assert.equal((await h3.upload({ id: 1 }, Buffer.alloc(10), 'image/png')).status, 404);
    for (const fn of [() => h3.gc.media.info('a'.repeat(32)), () => h3.gc.media.usage(), () => h3.gc.media.url('a'.repeat(32))]) await assert.rejects(fn(), { code: 'ERR_MEDIA_DENIED' });
  } finally { await h3.close(); none.done(); }
});

test('media: mediaAccess decides the apps\' download (no hook → the uploader only), Range, signed frame URLs', async () => {
  const code = `module.exports = { async mediaAccess({ user, mediaId, owner, mime }, gc) {
    await gc.storage.set('last', { user, mediaId, owner, mime });
    return user.id === owner || user.id === 3;
  } };`;
  const p = plugin({ permissions: { app: true, storage: true }, media: MEDIA }, code);
  const h = await createHost(p.dir, { users: USERS });
  try {
    const data = crypto.randomBytes(5000);
    const id = (await h.upload({ id: 2 }, data, 'audio/ogg')).body.mediaId;
    const full = await h.mediaGet({ id: 2, name: 'Anna', role: 'user' }, id);
    assert.equal(full.status, 200);
    assert.ok(full.body.equals(data));
    assert.deepEqual(h.kv.get('last'), { user: { portal: true, loggedIn: true, app: true, id: 2, name: 'Anna', role: 'user' }, mediaId: id, owner: 2, mime: 'audio/ogg' });
    assert.equal((await h.mediaGet({ id: 3 }, id)).status, 200);
    assert.equal((await h.mediaGet({ id: 1 }, id)).status, 404);
    const part = await h.mediaGet({ id: 2 }, id, { range: 'bytes=100-199' });
    assert.equal(part.status, 206);
    assert.equal(part.headers['content-range'], 'bytes 100-199/5000');
    assert.ok(part.body.equals(data.subarray(100, 200)));
    assert.equal((await h.mediaGet({ id: 2 }, id, { range: 'bytes=5000-' })).status, 416);
    // frames: gc.media.url
    const url = await h.gc.media.url(id, { user: 2, ttlS: 600 });
    assert.match(url, new RegExp(`^/plugin-media/${id}\\.\\d+\\.2\\.[A-Za-z0-9_-]{22}$`));
    assert.equal((await h.mediaFromUrl(url)).status, 200);
    assert.equal((await h.mediaFromUrl(url, { range: 'bytes=-10' })).status, 206);
    assert.equal((await h.mediaFromUrl(url, { now: Date.now() + 3600 * 1000 })).status, 404, 'expired');
    assert.equal((await h.mediaFromUrl(url.replace('.2.', '.3.'))).status, 404, 'tampered');
    for (const bad of [{ ttlS: 10 }, { ttlS: 90000 }, { user: 'x' }]) await assert.rejects(h.gc.media.url(id, bad), { code: 'ERR_INVALID' }, JSON.stringify(bad));
    await assert.rejects(h.gc.media.url('f'.repeat(32)), { code: 'ERR_INVALID' });
    await h.gc.media.delete(id);
    assert.equal((await h.mediaFromUrl(url)).status, 404, 'deleted');
  } finally { await h.close(); p.done(); }
  const bare = plugin({ media: MEDIA });
  const h2 = await createHost(bare.dir);
  try {
    const id = (await h2.upload({ id: 2 }, Buffer.from('%PDF'), 'application/pdf')).body.mediaId;
    const r = await h2.mediaGet({ id: 2 }, id);
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-disposition'], 'attachment', 'documents as a download');
    assert.equal((await h2.mediaGet({ id: 3 }, id)).status, 404, 'no hook → the uploader only');
  } finally { await h2.close(); bare.done(); }
});

test('events: permissions.events, gc.events.emit checks, 600 per minute, recorded', async () => {
  const p = plugin({ permissions: { events: true } });
  const h = await createHost(p.dir, { connected: (u) => (u === 2 ? 2 : 0) });
  try {
    assert.deepEqual(await h.gc.events.emit({ users: [2, 2, 3], type: 'message.new', data: { id: 7 } }), { delivered: 2 });
    assert.deepEqual(h.events, [{ users: [2, 3], type: 'message.new', data: { id: 7 } }]);
    await h.gc.events.emit({ users: [3], type: 'typing' });
    assert.equal(h.events[1].data, null);
    for (const bad of [{ users: [], type: 'x' }, { users: ['2'], type: 'x' }, { users: [2], type: 'Bad' }, { users: [2], type: 'x', data: 'z'.repeat(4095) }]) {
      await assert.rejects(h.gc.events.emit(bad), { code: 'ERR_INVALID' }, JSON.stringify(bad).slice(0, 60));
    }
    for (let i = 0; i < 598; i++) await h.gc.events.emit({ users: [2], type: 'x' });
    await assert.rejects(h.gc.events.emit({ users: [2], type: 'x' }), { code: 'ERR_RATE_LIMIT' });
  } finally { await h.close(); p.done(); }
  const q = plugin({ permissions: {} });
  const h2 = await createHost(q.dir);
  try {
    await assert.rejects(h2.gc.events.emit({ users: [2], type: 'x' }), { code: 'ERR_EVENTS_DENIED' });
    assert.deepEqual(await (async () => { const x = plugin({ permissions: { events: true } }); const hh = await createHost(x.dir); try { return await hh.gc.events.emit({ users: [5, 6], type: 'x' }); } finally { await hh.close(); x.done(); } })(), { delivered: 2 }, 'default: one stream per person');
  } finally { await h2.close(); q.done(); }
  const bad = plugin({ permissions: { events: 'yes' } });
  try { await assert.rejects(createHost(bad.dir), { code: 'ERR_INVALID' }); } finally { bad.done(); }
});

test('chat notifications: notifyTopics[].chat, conversation/sender/users, reply/mark_read, own budget', async () => {
  for (const topics of [[{ id: 'm', label: 'M', chat: 'yes' }], [{ id: 'm', label: 'M', chat: true, allowCritical: true }], [{ id: 'default', label: 'M', chat: true }]]) {
    const b = plugin({ permissions: { notify: true }, notifyTopics: topics });
    try { await assert.rejects(createHost(b.dir), { code: 'ERR_INVALID' }, JSON.stringify(topics)); } finally { b.done(); }
  }
  const p = plugin({ permissions: { notify: true, app: true }, notifyTopics: [{ id: 'message', label: 'Nachrichten', chat: true }, { id: 'news', label: 'News' }] });
  const h = await createHost(p.dir, { users: USERS });
  const msg = (over = {}) => ({ topic: 'message', title: 'Anna', body: 'Hallo', users: [3], conversation: { id: 12, title: 'Familie', isGroup: true }, sender: { id: 2, name: 'Anna', avatarUrl: null }, ...over });
  try {
    const r = await h.gc.notify(msg({ priority: 'critical', data: { messageId: 5, actions: [
      { type: 'reply', label: 'Antworten', path: '/conversations/12/messages' },
      { type: 'mark_read', label: 'Gelesen', path: 'conversations/12/read', body: { upTo: 5 } },
    ] } }));
    assert.deepEqual(r, { pushed: true, id: 1, skipped: [] });
    assert.deepEqual(h.notifications[0], {
      kind: 'message', topic: 'message', title: 'Anna', body: 'Hallo', priority: 'high', users: [3], collapseKey: 'chat:12', ttl: null,
      data: {
        route: 'plg-msg-test', messageId: 5,
        actions: [
          { id: 'reply', label: 'Antworten', type: 'reply', path: 'conversations/12/messages' },
          { id: 'mark_read', label: 'Gelesen', type: 'mark_read', path: 'conversations/12/read', body: { upTo: 5 } },
        ],
        conversation: { id: '12', title: 'Familie', isGroup: true }, sender: { id: 2, name: 'Anna', avatarUrl: null },
      },
    });
    for (const bad of [msg({ users: undefined }), msg({ conversation: undefined }), msg({ conversation: { id: 'a b' } }), msg({ sender: { id: 2, name: '' } }),
      msg({ sender: { id: 2, name: 'A', avatarUrl: 'https://x.example/a.png' } }), msg({ data: { actions: [{ type: 'reply', label: 'A', path: '../x' }] } }),
      msg({ data: { actions: [{ type: 'reply', label: 'x'.repeat(25), path: 'a' }] } })]) {
      await assert.rejects(h.gc.notify(bad), { code: 'ERR_INVALID' });
    }
    // own budget, apart from permissions.notify (30 per hour)
    for (let i = 0; i < 119; i++) await h.gc.notify(msg());
    const r2 = await h.gc.notify(msg({ users: [3, 2] }));
    assert.deepEqual(r2.skipped, [3], '120 per recipient');
    await assert.rejects(h.gc.notify(msg()), { code: 'ERR_RATE_LIMIT' });
    await h.gc.notify({ topic: 'news', title: 'normal topic' });
    assert.equal(h.notifications.at(-1).kind, undefined);
  } finally { await h.close(); p.done(); }
  const noApp = plugin({ permissions: { notify: true }, notifyTopics: [{ id: 'message', label: 'N', chat: true }] });
  const h2 = await createHost(noApp.dir);
  try {
    await assert.rejects(h2.gc.notify({ topic: 'message', title: 'A', users: [3], conversation: { id: 'c' }, sender: { id: 2, name: 'A' }, data: { actions: [{ type: 'reply', label: 'A', path: 'a' }] } }), { code: 'ERR_INVALID' }, 'reply needs permissions.app');
  } finally { await h2.close(); noApp.done(); }
});

test('services: validated declarations, gc.services.call against opts.services, the plugin\'s own hook', async () => {
  for (const [m, what] of [[{ permissions: { services: 'x' } }, 'permissions.services'], [{ permissions: { services: ['msg-test:a'] } }, 'own service'],
    [{ services: { provides: { 'Bad-Name': { label: 'x' } } } }, 'services.provides'], [{ services: [] }, 'services']]) {
    const b = plugin(m);
    try { await assert.rejects(createHost(b.dir), (e) => e.code === 'ERR_INVALID' && e.message.includes(what)); } finally { b.done(); }
  }
  const calls = [];
  const services = [{ plugin: 'gatecontrol-messenger', provides: ['send_message'], service: async (a) => { calls.push(a); if (a.payload && a.payload.fail) throw new Error('nope'); if (a.payload && a.payload.big) return { x: 'y'.repeat(17000) }; return { ok: true, messageId: 9 }; } }];
  const p = plugin({ permissions: { services: ['gatecontrol-messenger:send_message', 'gatecontrol-messenger:sync_group', 'gatecontrol-other:x'] } });
  const h = await createHost(p.dir, { users: USERS, services });
  try {
    assert.deepEqual(await h.gc.services.call({ plugin: 'gatecontrol-messenger', service: 'send_message', userId: 2, payload: { text: 'Hi' } }), { ok: true, messageId: 9 });
    assert.deepEqual(calls[0], { name: 'send_message', caller: 'msg-test', user: { id: 2, name: 'Anna', role: 'user' }, payload: { text: 'Hi' } });
    await h.gc.services.call({ plugin: 'gatecontrol-messenger', service: 'send_message' });
    assert.deepEqual([calls[1].user, calls[1].payload], [null, null]);
    await assert.rejects(h.gc.services.call({ plugin: 'gatecontrol-messenger', service: 'other' }), { code: 'ERR_SERVICES_DENIED' });
    await assert.rejects(h.gc.services.call({ plugin: 'gatecontrol-messenger', service: 'sync_group' }), { code: 'ERR_SERVICE_UNAVAILABLE' });
    await assert.rejects(h.gc.services.call({ plugin: 'gatecontrol-other', service: 'x' }), { code: 'ERR_SERVICE_UNAVAILABLE' });
    for (const bad of [{ userId: 4 }, { userId: 99 }, { userId: '2' }, { payload: { x: 'y'.repeat(16 * 1024) } }]) {
      await assert.rejects(h.gc.services.call({ plugin: 'gatecontrol-messenger', service: 'send_message', ...bad }), { code: 'ERR_INVALID' }, JSON.stringify(bad).slice(0, 40));
    }
    await assert.rejects(h.gc.services.call({ plugin: 'gatecontrol-messenger', service: 'send_message', payload: { fail: true } }), (e) => e.code === 'ERR_SERVICE_FAILED' && /nope/.test(e.message));
    await assert.rejects(h.gc.services.call({ plugin: 'gatecontrol-messenger', service: 'send_message', payload: { big: true } }), { code: 'ERR_SERVICE_FAILED' });
    assert.deepEqual(h.serviceCalls.map((c) => c.ok), [true, true, false, false]);
    for (let i = 0; i < 56; i++) await h.gc.services.call({ plugin: 'gatecontrol-messenger', service: 'send_message' });
    await assert.rejects(h.gc.services.call({ plugin: 'gatecontrol-messenger', service: 'send_message' }), { code: 'ERR_RATE_LIMIT' });
  } finally { await h.close(); p.done(); }

  // the plugin as a provider: host.callService runs its hook
  const prov = plugin({ services: { provides: { send_message: { label: { de: 'Senden', en: 'Send' } } } } },
    'module.exports = { async service({ name, caller, user, payload }) { return { name, caller, user, echo: payload }; } };');
  const h2 = await createHost(prov.dir);
  try {
    assert.deepEqual(await h2.callService('send_message', { caller: 'gatecontrol-familie', user: { id: 2, name: 'Anna', role: 'user' }, payload: { to: 'group' } }),
      { name: 'send_message', caller: 'gatecontrol-familie', user: { id: 2, name: 'Anna', role: 'user' }, echo: { to: 'group' } });
    await assert.rejects(h2.callService('other'), { code: 'ERR_SERVICE_UNAVAILABLE' });
  } finally { await h2.close(); prov.done(); }
  const noHook = plugin({ services: { provides: { a: { label: 'A' } } } });
  const h3 = await createHost(noHook.dir);
  try { await assert.rejects(h3.callService('a'), { code: 'ERR_SERVICE_FAILED' }); } finally { await h3.close(); noHook.done(); }
});
