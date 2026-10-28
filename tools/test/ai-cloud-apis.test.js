'use strict';

// The mock host's mirror of GateControl's coming AI service (gc.ai, permissions.ai) and cloud accounts (gc.cloud,
// permissions.cloudImport) — opt-in with opts.ai / opts.cloud; without them a plugin finds neither (feature detection).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHost, hostError } = require('../testing/mock-host');

const USERS = [{ id: 1, name: 'admin', role: 'admin' }, { id: 2, name: 'Anna', role: 'user' }, { id: 3, name: 'Ben', role: 'user' }];
const PURPOSE = { de: 'Dokumente lesen', en: 'Read documents' };
const MEDIA = { maxBytes: 4096, types: ['application/pdf', 'image/png', 'text/plain', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'] };
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

test('gc.ai: only with opts.ai; permissions.ai checked; available / status / extract with the concept\'s refusals', async () => {
  const dir = plugin('ai-a', { media: MEDIA, permissions: { ai: { purpose: PURPOSE, capabilities: ['text', 'vision'] } } });
  const none = await createHost(dir, { users: USERS });
  try { assert.equal(none.gc.ai, undefined); } finally { await none.close(); }
  await assert.rejects(createHost(plugin('ai-bad', { permissions: { ai: { purpose: PURPOSE, capabilities: ['smell'] } } }), { ai: {} }), /permissions.ai/);
  const h = await createHost(dir, { users: USERS, ai: { extract: async (req) => (req.task === 'bad' ? { kind: 'nope' } : { kind: 'invoice', amount: 12.5 }), budgetLeftCents: 0.3, perHour: 2 } });
  try {
    assert.equal(await h.gc.ai.available(), true);
    assert.equal(await h.gc.ai.available({ capability: 'audio' }), false);
    assert.deepEqual(await h.gc.ai.status(), { available: true, mediaAllowed: true, capabilities: ['text', 'vision'], budgetLeftCents: 0.3 });
    const r = await h.gc.ai.extract({ task: 'doc', user: 2, input: [{ type: 'text', label: 'Text', text: 'Rechnung' }], schema: SCHEMA });
    assert.deepEqual([r.ok, r.data, r.fallback, r.usage.costCents], [true, { kind: 'invoice', amount: 12.5 }, false, 0.2]);
    assert.equal(h.aiRequests[0].outcome, 'ok');
    const bad = (o) => h.gc.ai.extract({ task: 'doc', input: [{ type: 'text', text: 'x' }], schema: SCHEMA, ...o });
    await assert.rejects(bad({ schema: { type: 'object', properties: {}, additionalProperties: false } }), (e) => e.code === 'ERR_INVALID');
    await assert.rejects(bad({ user: 99 }), (e) => e.code === 'ERR_INVALID');
    await assert.rejects(bad({ input: [{ type: 'media', mediaId: 'f'.repeat(32) }] }), (e) => e.code === 'ERR_INVALID');
    await assert.rejects(bad({ task: 'bad' }), (e) => e.code === 'ERR_AI_INVALID_OUTPUT');
    await assert.rejects(bad({}), (e) => e.code === 'ERR_RATE_LIMIT');
    h.ai.perHour = 100;
    h.ai.budgetLeftCents = 0;
    await assert.rejects(bad({}), (e) => e.code === 'ERR_AI_BUDGET', 'the budget is used up');
    h.ai.budgetLeftCents = 10;
    h.ai.mediaAllowed = false;
    const up = await h.upload({ id: 2 }, Buffer.from('png'), 'image/png');
    await assert.rejects(bad({ input: [{ type: 'media', mediaId: up.body.mediaId }] }), (e) => e.code === 'ERR_AI_MEDIA_DISABLED');
    h.ai.mediaAllowed = true;
    h.ai.capabilities = ['text'];
    await assert.rejects(bad({ input: [{ type: 'media', mediaId: up.body.mediaId }] }), (e) => e.code === 'ERR_AI_CAPABILITY');
    h.ai.configured = false;
    assert.equal(await h.gc.ai.available(), false);
    await assert.rejects(bad({}), (e) => e.code === 'ERR_AI_NOT_CONFIGURED');
    h.ai.allowed = false;
    await assert.rejects(bad({}), (e) => e.code === 'ERR_AI_DENIED');
  } finally { await h.close(); }
  // without the permission: false, and every request refused
  const np = await createHost(plugin('ai-b', {}), { users: USERS, ai: { extract: async () => ({}) } });
  try {
    assert.equal(await np.gc.ai.available(), false);
    await assert.rejects(np.gc.ai.status(), (e) => e.code === 'ERR_AI_DENIED');
  } finally { await np.close(); }
  // a provider error is passed on
  const pe = await createHost(dir, { users: USERS, ai: { extract: async () => { throw hostError('ERR_TIMEOUT', 'slow'); } } });
  try {
    await assert.rejects(pe.gc.ai.extract({ task: 'doc', input: [{ type: 'text', text: 'x' }], schema: SCHEMA }), (e) => e.code === 'ERR_TIMEOUT');
    assert.equal(pe.aiRequests[0].outcome, 'ERR_TIMEOUT');
  } finally { await pe.close(); }
});

test('gc.cloud: only with opts.cloud; connections per person and plugin, list with pages, import into the media store', async () => {
  const files = {
    'google:anna@example.com': [
      { id: 'd', parent: null, name: 'Ordner', isDir: true },
      { id: 'a', parent: 'd', name: 'a.pdf', mime: 'application/pdf', data: 'aaa', modifiedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'b', parent: null, name: 'Brief', mime: 'application/vnd.google-apps.document', data: 'docx' },
      { id: 'c', parent: null, name: 'big.pdf', mime: 'application/pdf', size: 5000 },
    ],
  };
  const dir = plugin('cl-a', { media: MEDIA, permissions: { cloudImport: { purpose: PURPOSE } } });
  const none = await createHost(dir, { users: USERS });
  try { assert.equal(none.gc.cloud, undefined); } finally { await none.close(); }
  await assert.rejects(createHost(plugin('cl-bad', { permissions: { cloudImport: true } }), { cloud: {} }), /permissions.cloudImport/);
  const h = await createHost(dir, { users: USERS, cloud: { files, pageSize: 1 } });
  try {
    assert.deepEqual(await h.gc.cloud.available(), { google: true, microsoft: false });
    await assert.rejects(h.gc.cloud.connectUrl({ user: 2, provider: 'microsoft', returnTo: '/portal' }), (e) => e.code === 'ERR_CLOUD_NOT_CONFIGURED');
    await assert.rejects(h.gc.cloud.connectUrl({ user: 2, provider: 'google', returnTo: 'https://evil.example/' }), (e) => e.code === 'ERR_INVALID');
    assert.match((await h.gc.cloud.connectUrl({ user: 2, provider: 'google', returnTo: '/portal?x=1#plg-cl-a' })).url, /^\/oauth\/cloud\/start\?state=/);
    const c = h.cloudConnect(2, 'google', 'anna@example.com');
    assert.deepEqual(await h.gc.cloud.connections({ user: 2 }), [c]);
    assert.deepEqual(await h.gc.cloud.connections({ user: 3 }), []);
    await assert.rejects(h.gc.cloud.list({ user: 3, connection: c.id }), (e) => e.code === 'ERR_CLOUD_NOT_FOUND');
    let l = await h.gc.cloud.list({ user: 2, connection: c.id });
    assert.deepEqual([l.items.map((x) => x.name), l.next], [['Ordner'], '1']);
    l = await h.gc.cloud.list({ user: 2, connection: c.id, cursor: l.next });
    assert.deepEqual(l.items.map((x) => x.name), ['big.pdf']);
    assert.deepEqual((await h.gc.cloud.list({ user: 2, connection: c.id, folderId: 'd' })).items, [{ id: 'a', name: 'a.pdf', isDir: false, size: 3, mime: 'application/pdf', modifiedAt: '2026-01-01T00:00:00.000Z' }]);
    const got = await h.gc.cloud.import({ user: 2, connection: c.id, fileId: 'b' });
    assert.deepEqual([got.name, got.mime, got.size], ['Brief.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 4]);
    const info = await h.gc.media.info(got.mediaId);
    assert.deepEqual([info.owner, info.claimed], [2, false]);
    await assert.rejects(h.gc.cloud.import({ user: 2, connection: c.id, fileId: 'c' }), (e) => e.code === 'ERR_CLOUD_TOO_LARGE');
    await assert.rejects(h.gc.cloud.import({ user: 2, connection: c.id, fileId: 'd' }), (e) => e.code === 'ERR_INVALID');
    h.cloudRevoke(c.id);
    await assert.rejects(h.gc.cloud.list({ user: 2, connection: c.id }), (e) => e.code === 'ERR_CLOUD_AUTH');
    assert.equal(await h.gc.cloud.disconnect({ user: 2, connection: c.id }), true);
    assert.deepEqual(await h.gc.cloud.connections({ user: 2 }), []);
  } finally { await h.close(); }
  const np = await createHost(plugin('cl-b', {}), { users: USERS, cloud: {} });
  try { await assert.rejects(np.gc.cloud.available(), (e) => e.code === 'ERR_CLOUD_DENIED'); } finally { await np.close(); }
});
