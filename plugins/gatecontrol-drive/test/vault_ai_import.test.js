'use strict';

// Vault folders (1.9.0) and the features of 1.8.0: the AI for documents never reads a vault's file (no queue, GET
// insight 'off', POST insight → 409 encrypted), its deadlines take no reminder and are not listed, and the import never
// writes into a vault (the server may keep no plaintext there → 409 encrypted).

const test = require('node:test');
const assert = require('node:assert/strict');
const VC = require('../ui/vaultcrypto');
const { withHost, ANNA } = require('./helpers');

const TEXT = 'Stadtwerke Musterstadt\nRechnung Nr. 4711 vom 20.10.2026\nGesamtbetrag 84,20 EUR\nZahlbar bis 10.11.2026';
const concat = (parts) => Buffer.concat(parts.map((p) => Buffer.from(p)));

const ai = () => ({
  extract: async () => ({ kind: 'invoice', title: 'Rechnung', date: '2026-10-20', sender: 'Stadtwerke', amount: 84.2, currency: 'eur', folder: null, name: 'Rechnung.pdf',
    deadlines: [{ kind: 'payment', date: '2099-11-10', label: 'bezahlen' }] }),
});

async function vaultIn(c, parentId) {
  const kp = await VC.generateDeviceKey();
  const raw = await VC.exportPublic(kp.publicKey);
  const id = VC.newVaultId();
  const tk = VC.newVaultKey();
  const rec = VC.newRecoveryKey();
  const rk = await VC.recoveryKeyPair(rec.key);
  const r = await c.as(ANNA)('POST', 'vaults', { id, parentId, nameCipher: await VC.encryptName(tk, id, 1, 'Tresor'), recoveryPub: VC.b64u(rk.publicRaw),
    recoveryAuth: await VC.recoveryAuth(rec.key), recoveryWrap: await VC.wrapKey(tk, rk.publicRaw, id, 1), device: { publicKey: VC.b64u(raw) }, wrap: await VC.wrapKey(tk, raw, id, 1) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return { id, tk, node: r.json.node };
}

async function putEncrypted(c, v, name, data, extra = {}) {
  const mediaId = await c.upload(ANNA, concat(await VC.encryptContent(v.tk, v.id, 1, new Uint8Array(Buffer.from(data)))), 'application/octet-stream');
  return c.as(ANNA)('POST', 'uploads/commit', { mediaId, parentId: v.node.id, encrypted: true, nameCipher: await VC.encryptName(v.tk, v.id, 1, name), keyVersion: 1, ...extra });
}

test('AI for documents: never a vault\'s file — no queue, insight off, POST insight and apply 409 encrypted; deadlines neither', async () => {
  await withHost({ ai: ai() }, async (host, c) => {
    const a = c.as(ANNA);
    assert.ok((await a('GET', 'me')).json.features.includes('docAi'));
    const mine = await c.area(ANNA, 'mine');
    const v = await vaultIn(c, mine.rootId);
    const f = (await putEncrypted(c, v, 'Rechnung.pdf', TEXT, { text: TEXT })).json.node;
    assert.deepEqual(f.insight, { status: 'off', kind: null });
    assert.equal((await host.gc.db.query('SELECT COUNT(*) AS n FROM doc_insights')).rows[0].n, 0, 'not queued');
    // a row that got in anyway (a second lock) goes with the next run, nobody asks the AI
    await host.gc.db.run("INSERT INTO doc_insights (node_id, rev, status, source, queued_at) VALUES (?, 1, 'pending', 'text', 1)", [f.id]);
    await host.tick();
    assert.equal(host.aiRequests.length, 0);
    assert.equal((await host.gc.db.query('SELECT COUNT(*) AS n FROM doc_insights')).rows[0].n, 0);
    const g = await a('GET', `nodes/${f.id}/insight`);
    assert.equal(g.json.status, 'off');
    assert.deepEqual(g.json.deadlines, []);
    for (const [path, body] of [[`nodes/${f.id}/insight`, null], [`nodes/${f.id}/insight/apply`, { name: true }]]) {
      const r = await a('POST', path, body);
      assert.equal(r.status, 409, path);
      assert.equal(r.json.code, 'encrypted');
    }
    assert.deepEqual((await a('GET', `nodes/${v.node.id}/children`)).json.items.map((x) => x.insight.status), ['off']);
    // a deadline of a vault's file (it cannot come from the AI): not listed, no reminder
    const dl = await host.gc.db.run("INSERT INTO doc_deadlines (node_id, kind, date, label) VALUES (?, 'payment', '2099-11-10', 'x')", [f.id]);
    assert.deepEqual((await a('GET', 'deadlines', null, { from: '2026-01-01', to: '2100-01-01' })).json.deadlines, []);
    const rem = await a('POST', `deadlines/${dl.lastInsertRowid}/remind`, { daysBefore: 3 });
    assert.deepEqual([rem.status, rem.json.code], [409, 'encrypted']);
    // a plain file next to the vault still works
    const p = (await c.put(ANNA, mine.rootId, 'Klar.pdf', 'pdf', { mime: 'application/pdf', text: TEXT })).json.node;
    assert.equal(p.insight.status, 'pending');
  });
});

test('import: never into a vault (409 encrypted); a job whose target turned out to be one fails', async () => {
  const ACCOUNT = 'anna@example.com';
  const files = { [`google:${ACCOUNT}`]: [{ id: 'n1', parent: null, name: 'Notiz.txt', mime: 'text/plain', data: 'geheim', modifiedAt: '2026-01-05T08:00:00.000Z' }] };
  await withHost({ cloud: { files } }, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const v = await vaultIn(c, mine.rootId);
    const conn = host.cloudConnect(ANNA.id, 'google', ACCOUNT);
    const r = await a('POST', 'import/jobs', { connection: conn.id, items: [{ id: 'n1', isDir: false }], targetFolderId: v.node.id });
    assert.deepEqual([r.status, r.json.code], [409, 'encrypted']);
    const sub = await a('POST', 'nodes', { parentId: v.node.id, encrypted: true, nameCipher: await VC.encryptName(v.tk, v.id, 1, 'Sub'), keyVersion: 1 });
    assert.equal((await a('POST', 'import/jobs', { connection: conn.id, items: [{ id: 'n1', isDir: false }], targetFolderId: sub.json.node.id })).status, 409);
    // a job written before (the target made a vault's folder behind its back): it fails, nothing lands there
    const ok = await a('POST', 'import/jobs', { connection: conn.id, items: [{ id: 'n1', isDir: false }], targetFolderId: mine.rootId });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    await host.gc.db.run('UPDATE import_jobs SET target_id = ? WHERE id = ?', [v.node.id, ok.json.job.id]);
    await host.tick();
    const job = (await a('GET', 'import/jobs')).json.jobs.find((x) => x.id === ok.json.job.id);
    assert.deepEqual([job.state, job.error], ['failed', 'encrypted']);
    assert.deepEqual((await a('GET', `nodes/${v.node.id}/children`)).json.items.filter((x) => !x.encrypted), [], 'no plaintext in the vault');
    for (const m of host.media.values()) assert.equal(Buffer.from(m.data).includes(Buffer.from('geheim')), false);
  });
});
