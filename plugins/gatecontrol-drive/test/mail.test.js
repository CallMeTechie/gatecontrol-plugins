'use strict';

// The services for GateControl Mail (1.15.0, server/mail.js): suggest_folder (rule, learned, AI, kind; never a vault, a
// folder the person cannot write to; the same bytes already there), save_file with source and learn, give_file (a hand-over
// to the caller), share_link (GateControl's public links, at most 30 days, a PIN as password).

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC, LENA, OMA, FAMILY } = require('./helpers');

const MAIL = 'gatecontrol-mail';

/** Mail as another plugin of the mock host: it takes files Drive hands over (new_draft is its service). */
function mailPlugin() {
  return { plugin: MAIL, provides: ['new_draft'], service: async () => ({ ok: true }), media: { maxBytes: 52428800, types: ['application/*', 'image/*'], quotaDefault: '1GB' } };
}

function setup(host, c) {
  const call = (user, name, payload) => host.callService(name, { caller: MAIL, user: user ? { id: user.id, name: user.name, role: user.role } : null, payload });
  const handed = async (user, data, mime = 'application/pdf') => (await host.upload(user, Buffer.from(data), mime)).body.mediaId;
  const mkdir = async (user, parentId, name) => (await c.as(user)('POST', 'nodes', { parentId, name, isDir: true })).json.node;
  return { call, handed, mkdir };
}

test('suggest_folder: the rule and the learned folder of a sender, the kind of a document, nothing without a hint; sha256Exists', async () => {
  await withHost({ services: [mailPlugin()] }, async (host, c) => {
    const { call, handed, mkdir } = setup(host, c);
    const mine = await c.area(ANNA, 'mine');
    const fam = await c.area(ANNA, 'family');
    const rechnungen = await mkdir(ANNA, mine.rootId, 'Rechnungen');
    const strom = await mkdir(ANNA, fam.rootId, 'Strom');
    const from = { name: 'Stadtwerke', address: 'Rechnung@Stadtwerke.example' };

    // no rule yet, no AI: the kind by the name → a folder named for it
    const s1 = await call(ANNA, 'suggest_folder', { mediaId: await handed(ANNA, '%PDF-a'), name: 'Rechnung 2026-10.pdf', from, subject: 'Ihre Rechnung', date: Date.UTC(2026, 10, 3) });
    assert.equal(s1.ok, true, JSON.stringify(s1));
    assert.deepEqual([s1.suggestion.folderId, s1.suggestion.reason, s1.suggestion.where, s1.kind, s1.sha256Exists], [rechnungen.id, 'kind', 'Meine Dateien › Rechnungen', 'invoice', false]);
    assert.ok(s1.suggestion.confidence < 0.9);
    // nothing to go by
    const s0 = await call(ANNA, 'suggest_folder', { mediaId: await handed(ANNA, 'x'), name: 'IMG_2001.pdf' });
    assert.deepEqual([s0.ok, s0.suggestion, s0.sha256Exists], [true, null, false]);

    // save with source and learn: the file shows where it came from, the sender is remembered
    const saved = await call(ANNA, 'save_file', {
      mediaId: await handed(ANNA, '%PDF-a'), folderId: strom.id, name: 'Rechnung 2026-10.pdf',
      source: { plugin: MAIL, label: 'Aus Mail von Stadtwerke, 03.11.', ref: '4711' }, learn: { from: from.address },
    });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const node = (await c.as(MARC)('GET', `nodes/${saved.nodeId}`)).json.node;
    assert.deepEqual(node.source, { plugin: MAIL, label: 'Aus Mail von Stadtwerke, 03.11.', ref: '4711', at: node.source.at, appLink: 'gatecontrol://plugin/gatecontrol-mail/message/4711' });
    const listed = (await c.as(ANNA)('GET', `nodes/${strom.id}/children`)).json.items[0];
    assert.equal(listed.source.label, 'Aus Mail von Stadtwerke, 03.11.');

    // learned: the folder of the last save (any case of the address); the same bytes are there now
    const s2 = await call(ANNA, 'suggest_folder', { mediaId: await handed(ANNA, '%PDF-a'), name: 'Rechnung 2026-11.pdf', from: { address: 'rechnung@stadtwerke.example' } });
    assert.deepEqual([s2.suggestion.folderId, s2.suggestion.reason, s2.suggestion.areaId, s2.suggestion.path, s2.suggestion.where, s2.sha256Exists],
      [strom.id, 'learned', `family:${FAMILY}`, 'Strom', 'Berg › Strom'.replace('Berg', fam.label), true]);
    assert.ok(s2.suggestion.confidence < 0.9);
    // "Immer für diesen Absender": a rule
    await call(ANNA, 'save_file', { mediaId: await handed(ANNA, '%PDF-b'), folderId: strom.id, name: 'x.pdf', learn: { from: from.address, always: true } });
    const s3 = await call(ANNA, 'suggest_folder', { mediaId: await handed(ANNA, '%PDF-c'), name: 'Rechnung.pdf', from });
    assert.deepEqual([s3.suggestion.reason, s3.suggestion.confidence], ['rule', 1]);
    // the rule belongs to Anna only; Marc saves the sender elsewhere → his own learned folder
    const s4 = await call(MARC, 'suggest_folder', { mediaId: await handed(MARC, '%PDF-c'), name: 'Rechnung.pdf', from });
    assert.notEqual(s4.suggestion && s4.suggestion.reason, 'rule');
    // a folder that went: no suggestion from it
    await c.as(ANNA)('DELETE', `nodes/${strom.id}`);
    const s5 = await call(ANNA, 'suggest_folder', { mediaId: await handed(ANNA, '%PDF-d'), name: 'Rechnung.pdf', from });
    assert.equal(s5.suggestion.reason, 'kind');

    // refusals: someone else's file, a claimed one, bad input, no seat
    assert.equal((await call(ANNA, 'suggest_folder', { mediaId: await handed(MARC, 'x'), name: 'a.pdf' })).code, 'upload_invalid');
    assert.equal((await call(ANNA, 'suggest_folder', { mediaId: 'nope', name: 'a.pdf' })).code, 'invalid');
    assert.equal((await call(ANNA, 'suggest_folder', { mediaId: await handed(ANNA, 'x'), name: '../a' })).code, 'invalid');
    assert.equal((await call(OMA, 'suggest_folder', { mediaId: await handed(OMA, 'x'), name: 'a.pdf' })).code, 'no_seat');
    // save_file checks source and learn before it stores anything
    assert.equal((await call(ANNA, 'save_file', { mediaId: await handed(ANNA, 'x'), path: 'a.pdf', source: { plugin: 'gatecontrol-other', label: 'x' } })).code, 'invalid');
    assert.equal((await call(ANNA, 'save_file', { mediaId: await handed(ANNA, 'x'), path: 'a.pdf', source: { label: 'x', ref: 'a b' } })).code, 'invalid');
    assert.equal((await call(ANNA, 'save_file', { mediaId: await handed(ANNA, 'x'), path: 'a.pdf', learn: { from: 'kein Absender' } })).code, 'invalid');
  });
});

test('suggest_folder with AI for documents: folders the person may write to (no vault, no read-only child folder), a picture only when allowed', async () => {
  const requests = [];
  const ai = {
    mediaAllowed: true,
    extract: async (req) => {
      requests.push(req);
      assert.equal(req.task, 'drive_mail_filing');
      const folders = req.input.find((x) => x.label === 'Folders').text.split('\n');
      assert.ok(!folders.some((l) => /Geheim|Kinder/.test(l)), 'never a vault, never a folder only read: ' + folders.join(' | '));
      const i = folders.findIndex((l) => /› Versicherungen$/.test(l));
      return { kind: 'insurance', title: 'Kfz-Versicherung', folder: i >= 0 ? i : null, name: '2026-11-03 Kfz-Versicherung', confidence: 0.93 };
    },
  };
  await withHost({ ai, services: [mailPlugin()] }, async (host, c) => {
    const { call, handed, mkdir } = setup(host, c);
    const fam = await c.area(ANNA, 'family');
    const vers = await mkdir(ANNA, fam.rootId, 'Versicherungen');
    // a vault folder is never offered (made in the database as the vault feature would)
    await host.gc.db.run("INSERT INTO nodes (area_id, parent_id, name, is_dir, created_at, created_by, updated_at, updated_by, vault_id) VALUES (?, ?, 'Geheim', 1, 0, 2, 0, 2, 1)", [fam.id, fam.rootId]).catch(() => {});
    const s = await call(ANNA, 'suggest_folder', { mediaId: await handed(ANNA, 'scan', 'image/jpeg'), name: 'Scan.jpg', from: { name: 'Muster AG', address: 'post@muster.example' }, subject: 'Ihre Police', date: '2026-11-03' });
    assert.equal(s.ok, true, JSON.stringify(s));
    assert.deepEqual([s.suggestion.folderId, s.suggestion.reason, s.suggestion.confidence, s.suggestion.name, s.kind, s.title], [vers.id, 'ai', 0.93, '2026-11-03 Kfz-Versicherung.jpg', 'insurance', 'Kfz-Versicherung']);
    const req = requests[0];
    assert.ok(req.input.some((x) => x.type === 'media'), 'a picture goes along while pictures are allowed');
    assert.ok(req.input.some((x) => x.label === 'Subject' && x.text === 'Ihre Police'));
    assert.equal(req.user, ANNA.id);
    // a PDF: only the words
    await call(ANNA, 'suggest_folder', { mediaId: await handed(ANNA, '%PDF'), name: 'Police.pdf' });
    assert.ok(!requests[1].input.some((x) => x.type === 'media'));
    // a learned folder wins without asking the AI
    await call(ANNA, 'save_file', { mediaId: await handed(ANNA, '%PDF-z'), folderId: vers.id, name: 'p.pdf', learn: { from: 'post@muster.example' } });
    const n = requests.length;
    assert.equal((await call(ANNA, 'suggest_folder', { mediaId: await handed(ANNA, '%PDF-y'), name: 'p2.pdf', from: { address: 'post@muster.example' } })).suggestion.reason, 'learned');
    assert.equal(requests.length, n);
  });
});

test('give_file: a file the person reads, handed over to the caller; folders, vaults, other people\'s files and big files refused', async () => {
  const mail = mailPlugin();
  await withHost({ services: [mail] }, async (host, c) => {
    const { call, mkdir } = setup(host, c);
    const fam = await c.area(ANNA, 'family');
    const f = (await c.put(MARC, fam.rootId, 'Vertrag.pdf', '%PDF-vertrag', { mime: 'application/pdf' })).json.node;
    const r = await call(ANNA, 'give_file', { nodeId: f.id });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual([r.name, r.mime, r.size], ['Vertrag.pdf', 'application/pdf', 12]);
    assert.match(r.mediaId, /^[0-9a-f]{32}$/);
    const h = host.handOvers.at(-1);
    assert.deepEqual([h.to, h.user, h.mediaId], [MAIL, ANNA.id, r.mediaId]);
    // the file stays in Drive
    assert.equal((await c.as(ANNA)('GET', `nodes/${f.id}`)).status, 200);
    const dir = await mkdir(ANNA, fam.rootId, 'Ordner');
    assert.equal((await call(ANNA, 'give_file', { nodeId: dir.id })).code, 'invalid');
    assert.equal((await call(ANNA, 'give_file', { nodeId: 99999 })).code, 'not_found');
    assert.equal((await call(OMA, 'give_file', { nodeId: f.id })).code, 'no_seat');
    const lenas = (await c.put(LENA, (await c.area(LENA, 'mine')).rootId, 'privat.pdf', 'x', { mime: 'application/pdf' })).json.node;
    assert.equal((await call(ANNA, 'give_file', { nodeId: lenas.id })).code, 'not_found');
    await host.gc.db.run('UPDATE nodes SET vault_id = 1 WHERE id = ?', [f.id]);
    assert.equal((await call(ANNA, 'give_file', { nodeId: f.id })).code, 'encrypted');
    await host.gc.db.run('UPDATE nodes SET vault_id = NULL, size = ? WHERE id = ?', [60 * 1024 * 1024, f.id]);
    assert.equal((await call(ANNA, 'give_file', { nodeId: f.id })).code, 'too_large');
  });
});

test('share_link: a download link of 1 to 90 days (GateControl ends it after 30 at most), a PIN as password, write rights, never a vault', async () => {
  await withHost({ services: [mailPlugin()] }, async (host, c) => {
    const { call } = setup(host, c);
    const fam = await c.area(ANNA, 'family');
    const f = (await c.put(ANNA, fam.rootId, 'Fotos.zip', 'zip', { mime: 'application/zip' })).json.node;
    const now = Date.now();
    const a = await call(ANNA, 'share_link', { nodeId: f.id });
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.match(a.url, /^https:\/\/gc\.example\.com\/s\//);
    assert.equal(a.expiresAt, now + 14 * 86400000);
    const b = await call(ANNA, 'share_link', { nodeId: f.id, expiresDays: 90, password: '4711' });
    assert.equal(b.expiresAt, now + 30 * 86400000);
    const link = [...host.publicLinks.values()].at(-1);
    assert.equal(link.pin != null && link.pin !== false, true);
    assert.equal((await call(ANNA, 'share_link', { nodeId: f.id, expiresDays: 91 })).code, 'invalid');
    assert.equal((await call(ANNA, 'share_link', { nodeId: f.id, password: 'geheim' })).code, 'invalid');
    // Lena's folder: Anna only reads it
    const lf = (await c.put(LENA, (await c.area(LENA, 'child')).rootId, 'x.pdf', 'x', { mime: 'application/pdf' })).json.node;
    assert.equal((await call(ANNA, 'share_link', { nodeId: lf.id })).code, 'forbidden');
    await host.gc.db.run('UPDATE nodes SET vault_id = 1 WHERE id = ?', [f.id]);
    assert.equal((await call(ANNA, 'share_link', { nodeId: f.id })).code, 'encrypted');
  });
  // links not allowed by the administrator
  await withHost({ links: false, services: [mailPlugin()] }, async (host, c) => {
    const { call } = setup(host, c);
    const f = (await c.put(ANNA, (await c.area(ANNA, 'mine')).rootId, 'a.pdf', 'a', { mime: 'application/pdf' })).json.node;
    assert.equal((await call(ANNA, 'share_link', { nodeId: f.id })).code, 'links_disabled');
  });
});
