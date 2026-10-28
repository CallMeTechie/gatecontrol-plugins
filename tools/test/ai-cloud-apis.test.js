'use strict';

// The mock host's mirror of GateControl's AI service (gc.ai, permissions.ai — 1.214.0) and cloud accounts (gc.cloud,
// permissions.cloudImport — 1.213.0); opts.ai / opts.cloud switch them on for any emulated version, an older host has
// neither (feature detection).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHost, hostError } = require('../testing/mock-host');

const USERS = [{ id: 1, name: 'admin', role: 'admin' }, { id: 2, name: 'Anna', role: 'user' }, { id: 3, name: 'Ben', role: 'user' }];
const PURPOSE = { de: 'Dokumente lesen', en: 'Read documents' };
const MEDIA = { maxBytes: 4096, types: ['application/pdf', 'image/png', 'image/heic', 'text/plain', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'] };
const SCHEMA = { type: 'object', required: ['kind'], properties: { kind: { type: 'string', enum: ['invoice', 'other'] }, amount: { type: 'number', nullable: true } } };

const dirs = [];
function plugin(id, manifest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-plugin-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, 'server'));
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id, name: id, version: '1.0.0', entry: 'server/index.js', ...manifest }));
  fs.writeFileSync(path.join(dir, 'server', 'index.js'), 'module.exports = {};');
  return dir;
}
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

test('gc.ai: from 1.214.0 (or opts.ai); permissions.ai needs text; available / status like the host', async () => {
  const dir = plugin('ai-a', { media: MEDIA, permissions: { ai: { purpose: PURPOSE, capabilities: ['text', 'vision'] } } });
  const old = await createHost(dir, { users: USERS, gatecontrol: '1.213.0' });
  try { assert.equal(old.gc.ai, undefined); } finally { await old.close(); }
  // 1.214.0 without a provider: there, not available
  const bare = await createHost(dir, { users: USERS, gatecontrol: '1.214.0' });
  try {
    assert.equal(await bare.gc.ai.available(), false);
    assert.deepEqual(await bare.gc.ai.status(), { available: false, mediaAllowed: true, capabilities: [], budgetLeftCents: null });
    await assert.rejects(bare.gc.ai.extract({ task: 'doc', input: [{ type: 'text', text: 'x' }], schema: SCHEMA }), (e) => e.code === 'ERR_AI_NOT_CONFIGURED');
  } finally { await bare.close(); }
  await assert.rejects(createHost(plugin('ai-bad', { permissions: { ai: { purpose: PURPOSE, capabilities: ['vision'] } } }), { ai: {} }), /permissions.ai/);
  const h = await createHost(dir, { users: USERS, ai: {} });
  try {
    assert.equal(await h.gc.ai.available(), true);
    assert.equal(await h.gc.ai.available({ capability: 'vision' }), true);
    assert.equal(await h.gc.ai.available({ capability: 'audio' }), false);
    await assert.rejects(h.gc.ai.available({ capability: 'smell' }), (e) => e.code === 'ERR_INVALID');
    assert.deepEqual(await h.gc.ai.status(), { available: true, mediaAllowed: true, capabilities: ['text', 'vision'], budgetLeftCents: 1000 });
    h.ai.mediaAllowed = false;
    assert.equal(await h.gc.ai.available({ capability: 'vision' }), false);
    assert.deepEqual((await h.gc.ai.status()).capabilities, ['text']);
    h.ai.allowed = false;
    assert.equal(await h.gc.ai.available(), false);
    assert.deepEqual(await h.gc.ai.status(), { available: false, mediaAllowed: false, capabilities: [], budgetLeftCents: null });
  } finally { await h.close(); }
  // without the permission: false, the off status, requests denied
  const np = await createHost(plugin('ai-b', {}), { users: USERS, gatecontrol: '1.214.0' });
  try {
    assert.equal(await np.gc.ai.available(), false);
    assert.deepEqual(await np.gc.ai.status(), { available: false, mediaAllowed: false, capabilities: [], budgetLeftCents: null });
    await assert.rejects(np.gc.ai.extract({ task: 'doc', input: [{ type: 'text', text: 'x' }], schema: SCHEMA }), (e) => e.code === 'ERR_AI_DENIED');
  } finally { await np.close(); }
});

test('gc.ai.extract: the arguments and the schema subset, the refusals in the host\'s order, the answer fitted', async () => {
  const dir = plugin('ai-c', { media: MEDIA, permissions: { ai: { purpose: PURPOSE, capabilities: ['text', 'vision'] } } });
  const h = await createHost(dir, { users: USERS, ai: { extract: async (req) => (req.task === 'bad' ? { kind: 'nope' } : { kind: 'invoice', amount: 12.5, extra: 1 }), perHour: 5 } });
  try {
    const r = await h.gc.ai.extract({ task: 'Drive.doc', user: 2, input: [{ type: 'text', label: 'Text', text: 'Rechnung' }], schema: SCHEMA });
    assert.deepEqual([r.ok, r.data, r.fallback, r.usage.costCents], [true, { kind: 'invoice', amount: 12.5 }, false, 0.2], 'unknown properties dropped');
    const bad = (o) => h.gc.ai.extract({ task: 'doc', input: [{ type: 'text', text: 'x' }], schema: SCHEMA, ...o });
    const invalid = (e) => e.code === 'ERR_INVALID';
    await assert.rejects(bad({ task: '1doc' }), invalid);
    await assert.rejects(bad({ task: 'x'.repeat(41) }), invalid);
    await assert.rejects(bad({ user: 99 }), invalid);
    await assert.rejects(bad({ input: [] }), invalid);
    await assert.rejects(bad({ input: [{ type: 'text', text: '' }] }), invalid, 'only empty text');
    await assert.rejects(bad({ input: new Array(65).fill({ type: 'text', text: 'x' }) }), invalid);
    await assert.rejects(bad({ maxOutputTokens: 32001 }), invalid);
    await assert.rejects(bad({ timeoutMs: 999 }), invalid);
    await assert.rejects(bad({ schema: { type: 'array', items: { type: 'string' } } }), invalid, 'the root is an object');
    await assert.rejects(bad({ schema: { type: 'object', properties: { n: { type: 'integer', enum: [1, 2] } } } }), invalid, 'enum of strings only');
    await assert.rejects(bad({ schema: { type: 'object', properties: { s: { type: 'string', minimum: 1 } } } }), invalid);
    await assert.rejects(bad({ schema: { type: 'object', properties: { s: { type: 'string' } }, additionalProperties: false } }), invalid);
    await assert.rejects(bad({ schema: { type: 'object', properties: {} } }), invalid);
    // pictures: JPEG, PNG, WebP, GIF only
    const png = (await h.upload({ id: 2 }, Buffer.from('png'), 'image/png')).body.mediaId;
    const heic = (await h.upload({ id: 2 }, Buffer.from('heic'), 'image/heic')).body.mediaId;
    const pdf = (await h.upload({ id: 2 }, Buffer.from('%PDF'), 'application/pdf')).body.mediaId;
    await assert.rejects(bad({ input: [{ type: 'media', mediaId: heic }] }), invalid, 'HEIC is no picture for the AI');
    await assert.rejects(bad({ input: [{ type: 'media', mediaId: pdf }] }), invalid);
    // every request past its arguments counts against perHour (five after the next two)
    await assert.rejects(bad({ task: 'bad' }), (e) => e.code === 'ERR_AI_INVALID_OUTPUT');
    assert.equal((await bad({ input: [{ type: 'media', mediaId: png }] })).ok, true);
    await assert.rejects(bad({}), (e) => e.code === 'ERR_RATE_LIMIT');
    h.ai.perHour = 100;
    h.ai.mediaAllowed = false;
    await assert.rejects(bad({ input: [{ type: 'media', mediaId: png }] }), (e) => e.code === 'ERR_AI_MEDIA_DISABLED');
    h.ai.mediaAllowed = true;
    h.ai.capabilities = ['text'];
    await assert.rejects(bad({ input: [{ type: 'media', mediaId: png }] }), (e) => e.code === 'ERR_AI_CAPABILITY');
    h.ai.budgetLeftCents = 0;
    await assert.rejects(bad({}), (e) => e.code === 'ERR_AI_BUDGET');
    h.ai.allowed = false;
    await assert.rejects(bad({}), (e) => e.code === 'ERR_AI_DENIED');
    await assert.rejects(bad({ task: '' }), invalid, 'the arguments come first');
  } finally { await h.close(); }
  // a provider error is passed on
  const pe = await createHost(dir, { users: USERS, ai: { extract: async () => { throw hostError('ERR_TIMEOUT', 'slow'); } } });
  try {
    await assert.rejects(pe.gc.ai.extract({ task: 'doc', input: [{ type: 'text', text: 'x' }], schema: SCHEMA }), (e) => e.code === 'ERR_TIMEOUT');
    assert.equal(pe.aiRequests[0].outcome, 'ERR_TIMEOUT');
  } finally { await pe.close(); }
});

test('gc.cloud: from 1.213.0 (or opts.cloud); connections per person and plugin, list like the host, import into the media store', async () => {
  const files = {
    'google:anna@example.com': [
      { id: 'd', parent: null, name: 'Ordner', isDir: true },
      { id: 'a', parent: 'd', name: 'a.pdf', mime: 'application/pdf', data: 'aaa', modifiedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'b', parent: null, name: 'Brief', mime: 'application/vnd.google-apps.document', data: 'docx' },
      { id: 'c', parent: null, name: 'zu groß.pdf', mime: 'application/pdf', size: 5000 },
    ],
  };
  const dir = plugin('cl-a', { media: MEDIA, permissions: { cloudImport: { purpose: PURPOSE } } });
  const old = await createHost(dir, { users: USERS, gatecontrol: '1.212.0' });
  try { assert.equal(old.gc.cloud, undefined); } finally { await old.close(); }
  const bare = await createHost(dir, { users: USERS, gatecontrol: '1.213.0' });
  try { assert.deepEqual(await bare.gc.cloud.available(), { google: false, microsoft: false }); } finally { await bare.close(); }
  await assert.rejects(createHost(plugin('cl-bad', { permissions: { cloudImport: true } }), { cloud: {} }), /permissions.cloudImport/);
  const h = await createHost(dir, { users: USERS, cloud: { files, pageSize: 1 } });
  try {
    assert.deepEqual(await h.gc.cloud.available(), { google: true, microsoft: false });
    await assert.rejects(h.gc.cloud.connectUrl({ user: 2, provider: 'microsoft', returnTo: '/portal' }), (e) => e.code === 'ERR_CLOUD_NOT_CONFIGURED');
    for (const rt of ['https://evil.example/', '/portal//x', '/admin', '/portal?' + 'x'.repeat(300)]) {
      await assert.rejects(h.gc.cloud.connectUrl({ user: 2, provider: 'google', returnTo: rt }), (e) => e.code === 'ERR_INVALID', rt);
    }
    assert.match((await h.gc.cloud.connectUrl({ user: 2, provider: 'google', returnTo: '/portal?x=1#plg-cl-a' })).url, /^https:\/\/gc\.example\.com\/oauth\/cloud\/start\?flow=[A-Za-z0-9_-]{16,64}$/);
    const c = h.cloudConnect(2, 'google', 'anna@example.com');
    assert.match(c.id, /^[0-9a-f]{24}$/);
    assert.deepEqual(await h.gc.cloud.connections({ user: 2 }), [c]);
    assert.deepEqual(await h.gc.cloud.connections({ user: 3 }), []);
    await assert.rejects(h.gc.cloud.list({ user: 3, connection: c.id }), (e) => e.code === 'ERR_CLOUD_NOT_FOUND');
    let l = await h.gc.cloud.list({ user: 2, connection: c.id });
    assert.deepEqual([l.items, l.next], [[{ id: 'd', name: 'Ordner', isDir: true, size: null, mime: null, modifiedAt: null }], '1']);
    l = await h.gc.cloud.list({ user: 2, connection: c.id, cursor: l.next });
    assert.deepEqual(l.items, [{ id: 'b', name: 'Brief.docx', isDir: false, size: null, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', modifiedAt: null }]);
    assert.deepEqual((await h.gc.cloud.list({ user: 2, connection: c.id, folderId: 'd' })).items, [{ id: 'a', name: 'a.pdf', isDir: false, size: 3, mime: 'application/pdf', modifiedAt: '2026-01-01T00:00:00.000Z' }]);
    const got = await h.gc.cloud.import({ user: 2, connection: c.id, fileId: 'b' });
    assert.deepEqual([got.name, got.mime, got.size], ['Brief.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 4]);
    const info = await h.gc.media.info(got.mediaId);
    assert.deepEqual([info.owner, info.claimed], [2, false]);
    await assert.rejects(h.gc.cloud.import({ user: 2, connection: c.id, fileId: 'c' }), (e) => e.code === 'ERR_CLOUD_TOO_LARGE');
    await assert.rejects(h.gc.cloud.import({ user: 2, connection: c.id, fileId: 'd' }), (e) => e.code === 'ERR_INVALID');
    h.cloudRevoke(c.id);
    assert.equal((await h.gc.cloud.connections({ user: 2 }))[0].error, 'auth');
    await assert.rejects(h.gc.cloud.list({ user: 2, connection: c.id }), (e) => e.code === 'ERR_CLOUD_AUTH');
    assert.equal(h.cloudConnect(2, 'google', 'anna@example.com').id, c.id, 'the same account: the same connection');
    assert.equal((await h.gc.cloud.list({ user: 2, connection: c.id })).items.length, 1);
    assert.equal(await h.gc.cloud.disconnect({ user: 2, connection: c.id }), true);
    assert.deepEqual(await h.gc.cloud.connections({ user: 2 }), []);
  } finally { await h.close(); }
  const np = await createHost(plugin('cl-b', {}), { users: USERS, gatecontrol: '1.213.0' });
  try {
    await assert.rejects(np.gc.cloud.available(), (e) => e.code === 'ERR_CLOUD_DENIED');
    await assert.rejects(np.gc.cloud.connections({ user: 2 }), (e) => e.code === 'ERR_CLOUD_DENIED');
  } finally { await np.close(); }
});
