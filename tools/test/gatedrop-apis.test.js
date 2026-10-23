'use strict';

// The mock host's mirror of GateControl 1.193.0 (GateDrop): media up to 2 GB, permissions.devices with
// gc.devices.list and pushes to single devices / silent data pushes, gc.media.handOver between linked mock
// hosts, gc.net.uploadTarget, permissions.publicLinks with gc.publicLinks and the public link route.
// Gated: with an older opts.gatecontrol none of it exists.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHost } = require('../testing/mock-host');

const USERS = [{ id: 1, name: 'admin', role: 'admin' }, { id: 2, name: 'Anna', role: 'user' }, { id: 3, name: 'Ben', role: 'user' }, { id: 4, name: 'Alt', role: 'user', disabled: true }];
const DEVICES = [{ id: 'a-phone', userId: 2, name: 'Pixel', platform: 'android', online: true }, { id: 'a-pc', userId: 2, name: 'PC', platform: 'windows' }, { id: 'b-phone', userId: 3, platform: 'android' }];
const BIG = { maxBytes: 2 * 1024 ** 3, types: ['application/pdf', 'image/png'], quotaDefault: '10GB' };

const dirs = [];
function plugin(id, manifest, code = 'module.exports = {};') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-plugin-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, 'server'));
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id, name: id, version: '1.0.0', entry: 'server/index.js', ...manifest }));
  fs.writeFileSync(path.join(dir, 'server', 'index.js'), code);
  return dir;
}
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

test('1.193.0 gate: media up to 2 GB, the new functions; an older host refuses the size and has none of them', async () => {
  const dir = plugin('gd-a', { media: BIG, permissions: { devices: true, publicLinks: true, notify: true } });
  await assert.rejects(createHost(dir, { gatecontrol: '1.192.0' }), (e) => e.code === 'ERR_INVALID' && /media.maxBytes/.test(e.message));
  const h = await createHost(dir, { gatecontrol: '1.193.0', users: USERS });
  try {
    assert.equal(typeof h.gc.devices.list, 'function');
    assert.equal(typeof h.gc.media.handOver, 'function');
    assert.equal(typeof h.gc.net.uploadTarget, 'function');
    assert.equal(typeof h.gc.publicLinks.create, 'function');
    const r = await h.upload({ id: 2 }, Buffer.from('%PDF'), 'application/pdf', { bytes: 1.5 * 1024 ** 3 });
    assert.deepEqual([r.status, r.body.bytes], [200, 1.5 * 1024 ** 3]);
    assert.equal((await h.upload({ id: 2 }, Buffer.from('%PDF'), 'application/pdf', { bytes: 2 * 1024 ** 3 + 1 })).status, 413);
  } finally { await h.close(); }
  const old = await createHost(plugin('gd-b', { media: { maxBytes: 4096, types: ['image/png'] }, permissions: { devices: 'yes' } }), { gatecontrol: '1.192.0' });
  try {
    assert.equal(old.gc.devices, undefined);
    assert.equal(old.gc.publicLinks, undefined);
    assert.equal(old.gc.media.handOver, undefined);
    assert.equal(old.gc.net.uploadTarget, undefined);
  } finally { await old.close(); }
  await assert.rejects(createHost(plugin('gd-c', { permissions: { publicLinks: 1 } }), { gatecontrol: '1.193.0' }), /permissions.publicLinks/);
});

test('devices: the person\'s installations; pushes to single devices and silent data pushes, checked', async () => {
  const dir = plugin('gd-d', { permissions: { devices: true, notify: true }, notifyTopics: [{ id: 'received', label: 'R' }] });
  const h = await createHost(dir, { gatecontrol: '1.193.0', users: USERS, devices: DEVICES });
  try {
    assert.deepEqual(await h.gc.devices.list({ userId: 2 }), [
      { id: 'a-phone', name: 'Pixel', platform: 'android', clientType: 'android', appVersion: null, online: true, lastSeen: null, via: null },
      { id: 'a-pc', name: 'PC', platform: 'windows', clientType: 'windows', appVersion: null, online: false, lastSeen: null, via: null },
    ]);
    await assert.rejects(h.gc.devices.list({ userId: 4 }), (e) => e.code === 'ERR_INVALID');
    await h.gc.notify({ topic: 'received', title: 'x', users: [2], devices: ['a-pc'] });
    await h.gc.notify({ topic: 'received', silent: true, users: [2], devices: ['a-phone'], data: { k: 1 } });
    assert.deepEqual(h.notifications.map((n) => [n.devices, n.silent, n.kind, n.title]), [[['a-pc'], undefined, undefined, 'x'], [['a-phone'], true, 'data', 'gd-d']]);
    await h.gc.notify({ topic: 'received', silent: true, users: [2] }); // data is optional
    for (const [n, what] of [[{ title: 'x', users: [2], devices: ['b-phone'] }, 'not a device of these users'], [{ title: 'x', devices: ['a-pc'] }, 'devices need users'],
      [{ title: 'x', users: [2], devices: [] }, 'invalid devices'], [{ silent: true, users: [2], image: { data: 'x', mime: 'image/png' } }, 'no image'], [{ title: 'x', silent: 'y' }, 'silent must be a boolean']]) {
      await assert.rejects(h.gc.notify({ topic: 'received', ...n }), (e) => e.code === 'ERR_INVALID' && e.message.includes(what), JSON.stringify(n));
    }
  } finally { await h.close(); }
  const no = await createHost(plugin('gd-e', { permissions: { notify: true }, notifyTopics: [{ id: 'm', label: 'M', chat: true }, { id: 'r', label: 'R' }] }), { gatecontrol: '1.193.0', users: USERS, devices: DEVICES });
  try {
    await assert.rejects(no.gc.devices.list({ userId: 2 }), (e) => e.code === 'ERR_DEVICES_DENIED');
    await assert.rejects(no.gc.notify({ topic: 'r', title: 'x', users: [2], devices: ['a-pc'] }), (e) => e.code === 'ERR_DEVICES_DENIED');
    await assert.rejects(no.gc.notify({ topic: 'r', silent: true, users: [2] }), (e) => e.code === 'ERR_DEVICES_DENIED');
    await assert.rejects(no.gc.notify({ topic: 'm', title: 'x', users: [2], silent: true }), (e) => e.code === 'ERR_INVALID' && /chat topics/.test(e.message));
  } finally { await no.close(); }
});

test('hand-over between linked hosts: the target\'s types, size and quota; permission; services through the linked host', async () => {
  const target = await createHost(plugin('gd-target', { media: { maxBytes: 1024 * 1024, types: ['application/pdf'], quotaDefault: '2MB', uploads: false }, services: { provides: { take: { label: 'Take' } } } },
    'module.exports = { async service({ name, caller, user, payload }, gc) { const i = await gc.media.info(payload.mediaId); return { ok: true, caller, user: user && user.id, owner: i && i.owner, bytes: i && i.bytes }; } };'), { gatecontrol: '1.193.0', users: USERS });
  const src = await createHost(plugin('gd-src', { media: BIG, permissions: { services: ['gd-target:take'] } }), { gatecontrol: '1.193.0', users: USERS, services: [{ plugin: 'gd-target', host: target }] });
  const lone = await createHost(plugin('gd-lone', { media: BIG }), { gatecontrol: '1.193.0', users: USERS, services: [{ plugin: 'gd-target', host: target }] });
  try {
    const pdf = (await src.upload({ id: 2 }, Buffer.from('%PDF-1'), 'application/pdf')).body.mediaId;
    const h = await src.gc.media.handOver(pdf, { toPlugin: 'gd-target', user: 2 });
    assert.match(h.mediaId, /^[0-9a-f]{32}$/);
    assert.notEqual(h.mediaId, pdf);
    const info = await target.gc.media.info(h.mediaId);
    assert.deepEqual([info.owner, info.claimed, info.mime, info.bytes], [2, false, 'application/pdf', 6]);
    assert.deepEqual(await src.gc.services.call({ plugin: 'gd-target', service: 'take', userId: 2, payload: { mediaId: h.mediaId } }), { ok: true, caller: 'gd-src', user: 2, owner: 2, bytes: 6 });
    assert.deepEqual(src.handOvers, [{ to: 'gd-target', from: pdf, mediaId: h.mediaId, user: 2, mime: 'application/pdf', bytes: 6 }]);
    const png = (await src.upload({ id: 2 }, Buffer.from('png'), 'image/png')).body.mediaId;
    const big = (await src.upload({ id: 2 }, Buffer.from('%PDF'), 'application/pdf', { bytes: 2 * 1024 * 1024 })).body.mediaId;
    const mid = (await src.upload({ id: 2 }, Buffer.from('%PDF'), 'application/pdf', { bytes: 1024 * 1024 })).body.mediaId;
    await assert.rejects(src.gc.media.handOver(png, { toPlugin: 'gd-target', user: 2 }), (e) => e.code === 'ERR_MEDIA_TYPE');
    await assert.rejects(src.gc.media.handOver(big, { toPlugin: 'gd-target', user: 2 }), (e) => e.code === 'ERR_MEDIA_TOO_LARGE');
    await src.gc.media.handOver(mid, { toPlugin: 'gd-target', user: 2 });
    await assert.rejects(src.gc.media.handOver(mid, { toPlugin: 'gd-target', user: 2 }), (e) => e.code === 'ERR_MEDIA_QUOTA');
    await assert.rejects(src.gc.media.handOver(pdf, { toPlugin: 'gd-target', user: 4 }), (e) => e.code === 'ERR_INVALID');
    await assert.rejects(src.gc.media.handOver(pdf, { toPlugin: 'gd-other', user: 2 }), (e) => e.code === 'ERR_SERVICES_DENIED');
    await assert.rejects(src.gc.media.handOver('f'.repeat(32), { toPlugin: 'gd-target', user: 2 }), (e) => e.code === 'ERR_INVALID');
    const l = (await lone.upload({ id: 2 }, Buffer.from('%PDF'), 'application/pdf')).body.mediaId;
    await assert.rejects(lone.gc.media.handOver(l, { toPlugin: 'gd-target', user: 2 }), (e) => e.code === 'ERR_SERVICES_DENIED');
  } finally { await src.close(); await lone.close(); await target.close(); }
});

test('uploadTarget: a multipart POST of an own media file to a home target, recorded; checks', async () => {
  const got = [];
  const dir = plugin('gd-up', { media: BIG, permissions: { network: { homeTargets: [{ id: 'nas', label: 'NAS', protocols: ['http'] }] } } });
  const h = await createHost(dir, { gatecontrol: '1.193.0', users: USERS, targets: { nas: [{ label: 'n', upload: async (p, o) => { got.push({ p, o }); return { status: 200, body: '{"success":true}' }; } }] } });
  try {
    const m = (await h.upload({ id: 2 }, Buffer.from('%PDF-x'), 'application/pdf')).body.mediaId;
    const r = await h.gc.net.uploadTarget('nas', '/webapi/entry.cgi', { query: { api: 'X' }, headers: { 'X-T': '1' }, form: { fields: { path: '/a', n: 1 }, file: { field: 'file', mediaId: m, name: 'a.pdf' } }, timeoutMs: 600000 });
    assert.deepEqual([r.status, r.body], [200, '{"success":true}']);
    assert.deepEqual([got[0].p, got[0].o.query, got[0].o.fields, got[0].o.file.name, got[0].o.file.data.toString()], ['/webapi/entry.cgi', { api: 'X' }, { path: '/a', n: '1' }, 'a.pdf', '%PDF-x']);
    assert.deepEqual(h.uploads[0].file, { field: 'file', name: 'a.pdf', mime: 'application/pdf', bytes: 6 });
    for (const [o, code] of [[{ form: { file: { field: 'file', mediaId: m, name: '../x' } } }, 'ERR_INVALID'], [{ form: { file: { field: 'file', mediaId: 'f'.repeat(32), name: 'x' } } }, 'ERR_INVALID'],
      [{ form: { file: { field: 'file', mediaId: m, name: 'x' } }, timeoutMs: 31 * 60000 }, 'ERR_INVALID'], [{}, 'ERR_INVALID']]) {
      await assert.rejects(h.gc.net.uploadTarget('nas', '/x', o), (e) => e.code === code, JSON.stringify(o));
    }
    await assert.rejects(h.gc.net.uploadTarget('other', '/x', { form: { file: { field: 'f', mediaId: m, name: 'x' } } }), (e) => e.code === 'ERR_NET_DENIED');
  } finally { await h.close(); }
});

test('public links: permission and switch, create checks, counters, PIN lock, downloads, revoke and the hook', async () => {
  const dir = plugin('gd-links', { media: BIG, permissions: { publicLinks: true } },
    'const ev = []; module.exports = { ev, async publicLinkEvent(e) { ev.push(e); } };');
  const h = await createHost(dir, { gatecontrol: '1.193.0', users: USERS });
  try {
    const m = (await h.upload({ id: 2 }, Buffer.from('%PDF'), 'application/pdf')).body.mediaId;
    const base = { title: 'Fotos', files: [{ mediaId: m, name: 'a.pdf' }], expiresAt: Date.now() + 3600000, ownerUserId: 2, pin: '4819' };
    await assert.rejects(h.gc.publicLinks.create(base), (e) => e.code === 'ERR_PUBLIC_LINKS_DISABLED', 'off by default');
    h.setPublicLinks(true);
    await assert.rejects(h.gc.publicLinks.create(base), (e) => e.code === 'ERR_INVALID' && /claimed/.test(e.message));
    await h.gc.media.claim(m);
    for (const bad of [{ expiresAt: Date.now() + 31 * 86400000 }, { expiresAt: Date.now() + 1000 }, { pin: '12' }, { ownerUserId: 4 }, { files: [] }, { files: new Array(21).fill(base.files[0]) }, { title: 'x'.repeat(121) }, { maxDownloads: 0 }, { maxDownloads: 1001 }]) {
      await assert.rejects(h.gc.publicLinks.create({ ...base, ...bad }), (e) => e.code === 'ERR_INVALID', JSON.stringify(bad));
    }
    const l = await h.gc.publicLinks.create(base);
    assert.match(l.token, /^[A-Za-z0-9_-]{24}$/);
    assert.deepEqual([l.url, l.expiresAt], [`https://gc.example.com/s/${l.token}`, base.expiresAt]);
    const g = await h.gc.publicLinks.get(l.token);
    assert.deepEqual([g.pin, g.downloads, g.locked, g.state, g.active, g.pinFailures, g.ownerUserId, g.files[0].id, g.files[0].name], [true, 0, false, 'active', true, 0, 2, '1', 'a.pdf']);
    assert.equal((await h.publicLinkDownload(l.token, { pin: '4819', file: 1 })).status, 200);
    assert.equal((await h.publicLinkDownload(l.token, { pin: '1111', file: 1 })).status, 403);
    assert.equal((await h.gc.publicLinks.get(l.token)).files[0].downloads, 1);
    for (let i = 0; i < 3; i++) assert.equal((await h.publicLinkUnlock(l.token, '0000')).status, 403);
    assert.equal((await h.publicLinkUnlock(l.token, '0000')).status, 410);
    assert.equal((await h.publicLinkDownload(l.token, { pin: '4819' })).status, 410);
    assert.equal((await h.gc.publicLinks.get(l.token)).state, 'locked');
    assert.deepEqual(h.plugin.ev, [{ token: l.token, event: 'download', file: { id: '1', name: 'a.pdf' }, zip: false, downloads: 1 }, { token: l.token, event: 'locked', file: null, zip: false, downloads: 1 }]);
    assert.deepEqual((await h.gc.publicLinks.list({ ownerUserId: 2 })).map((x) => x.token), [l.token]);
    assert.equal(await h.gc.publicLinks.revoke(l.token), false, 'locked: not active any more');
    // maxDownloads per file: used up
    const u = await h.gc.publicLinks.create({ ...base, pin: undefined, maxDownloads: 1 });
    assert.equal((await h.publicLinkDownload(u.token)).status, 200);
    assert.equal((await h.publicLinkDownload(u.token)).status, 410);
    assert.equal((await h.gc.publicLinks.get(u.token)).state, 'used');
    const v = await h.gc.publicLinks.create({ ...base, pin: undefined });
    assert.equal(await h.gc.publicLinks.revoke(v.token), true);
    assert.equal((await h.gc.publicLinks.get(v.token)).state, 'revoked');
    assert.equal((await h.publicLinkDownload(v.token)).status, 410);
    h.setPublicLinks(false);
    await assert.rejects(h.gc.publicLinks.list({}), (e) => e.code === 'ERR_PUBLIC_LINKS_DISABLED');
  } finally { await h.close(); }
  const nourl = await createHost(plugin('gd-nourl', { media: BIG, permissions: { publicLinks: true } }), { gatecontrol: '1.193.0', users: USERS, publicLinks: true, publicUrl: null });
  try {
    const m = (await nourl.upload({ id: 2 }, Buffer.from('%PDF'), 'application/pdf')).body.mediaId;
    await nourl.gc.media.claim(m);
    await assert.rejects(nourl.gc.publicLinks.create({ files: [{ mediaId: m, name: 'a' }], expiresAt: Date.now() + 120000, ownerUserId: 2 }), (e) => e.code === 'ERR_NO_PUBLIC_URL');
  } finally { await nourl.close(); }
});
