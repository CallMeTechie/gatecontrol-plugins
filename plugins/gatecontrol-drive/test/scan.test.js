'use strict';

// GateControl's virus scan (1.19.0, server/scan.js; the mock host's opts.scan): the state on file nodes and photo items,
// blocked files refused for content, links, ZIPs, Mail; the hook mediaScanned (later results — op 'scan' in the change
// log, the live event); link uploads; the housekeeping asks again for files still being checked. Without the scan
// (an older GateControl) nothing changes.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC, MIN } = require('./helpers');

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
const MAIL = 'gatecontrol-mail';
const mailPlugin = () => ({ plugin: MAIL, provides: ['new_draft'], service: async () => ({ ok: true }), media: { maxBytes: 52428800, types: ['application/*', 'image/*', 'text/*'], quotaDefault: '1GB' } });

test('an older GateControl (no scan): no field, nothing refused; GET me lists the feature', async () => {
  await withHost({}, async (host, c) => {
    const mine = await c.area(ANNA, 'mine');
    const r = await c.put(ANNA, mine.rootId, 'eicar.txt', EICAR);
    assert.equal(r.status, 200);
    assert.equal(r.json.node.scan, undefined);
    assert.equal((await c.as(ANNA)('GET', `nodes/${r.json.node.id}/content`)).status, 200);
    assert.ok((await c.as(ANNA)('GET', 'me')).json.features.includes('scan'));
  });
});

test('upload and commit: the state on the node; a quarantined file opens, shares and leaves nothing', async () => {
  await withHost({ scan: true, services: [mailPlugin()] }, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const ok = (await c.put(ANNA, mine.rootId, 'brief.txt', 'Hallo')).json.node;
    assert.deepEqual(ok.scan, { state: 'clean', blocked: false, finding: null });
    const bad = (await c.put(ANNA, mine.rootId, 'eicar.txt', EICAR)).json.node;
    assert.deepEqual(bad.scan, { state: 'infected', blocked: true, finding: 'Eicar-Test-Signature' });
    assert.equal(bad.preview, null);
    // the lists carry it
    const kids = (await a('GET', `nodes/${mine.rootId}/children`)).json.items;
    assert.deepEqual(kids.map((n) => [n.name, n.scan && n.scan.state]), [['brief.txt', 'clean'], ['eicar.txt', 'infected']]);
    // content, versions, links: 423 quarantined with a clear text
    const got = await a('GET', `nodes/${bad.id}/content`);
    assert.deepEqual([got.status, got.json.code, got.json.error], [423, 'quarantined', 'Die Datei ist gesperrt: Der Virenscan hat Schadsoftware gefunden.']);
    assert.deepEqual(got.json.scan, { state: 'infected', blocked: true, finding: 'Eicar-Test-Signature' });
    const link = await a('POST', 'links', { nodeId: bad.id, mode: 'download', expires: '7d' });
    assert.deepEqual([link.status, link.json.code], [423, 'quarantined']);
    assert.equal((await a('POST', 'links', { nodeIds: [ok.id, bad.id], mode: 'download', expires: '7d' })).json.code, 'quarantined');
    // a ZIP leaves it out
    const z = await a('POST', 'zip', { ids: [ok.id, bad.id] });
    assert.equal(z.status, 200);
    assert.deepEqual([z.json.files, z.json.skipped], [1, [{ id: bad.id, reason: 'blocked' }]]);
    // Mail's give_file and share_link
    const give = await host.callService('give_file', { caller: MAIL, user: { id: ANNA.id, name: ANNA.name, role: ANNA.role }, payload: { nodeId: bad.id } });
    assert.deepEqual([give.ok, give.code], [false, 'quarantined']);
    const share = await host.callService('share_link', { caller: MAIL, user: { id: ANNA.id, name: ANNA.name, role: ANNA.role }, payload: { nodeId: bad.id } });
    assert.deepEqual([share.ok, share.code], [false, 'quarantined']);
    // English
    const en = await host.request({ method: 'GET', path: `nodes/${bad.id}/content`, user: { ...ANNA, portal: true, loggedIn: true }, lang: 'en' });
    assert.equal(en.json.error, 'The file is blocked: the virus scan found malware.');
  });
});

test('marked only (not blocked): the file stays usable, the state warns', async () => {
  await withHost({ scan: () => ({ state: 'infected', blocked: false, finding: 'GC.Office.Macro' }) }, async (host, c) => {
    const mine = await c.area(ANNA, 'mine');
    const n = (await c.put(ANNA, mine.rootId, 'makro.docm', 'x')).json.node;
    assert.deepEqual(n.scan, { state: 'infected', blocked: false, finding: 'GC.Office.Macro' });
    assert.equal((await c.as(ANNA)('GET', `nodes/${n.id}/content`)).status, 200);
  });
});

test('mediaScanned: a check that ends later — op \'scan\', the live event; a later block; the housekeeping asks again', async () => {
  let next = { state: 'pending' };
  await withHost({ scan: () => next }, async (host, c) => {
    const a = c.as(ANNA);
    const fam = await c.area(ANNA, 'family');
    const n = (await c.put(ANNA, fam.rootId, 'video.mp4', 'big', { mime: 'video/mp4' })).json.node;
    assert.deepEqual(n.scan, { state: 'pending', blocked: true, finding: null });
    assert.equal((await a('GET', `nodes/${n.id}/content`)).json.code, 'scan_pending');
    const seq = (await a('GET', 'me')).json.latest;
    const before = c.events().length;
    await host.mediaScanned(n.mediaId, { state: 'clean' });
    const ch = (await c.as(MARC)('GET', 'changes', null, { since: seq })).json.changes;
    assert.deepEqual(ch.map((x) => [x.op, x.nodeId, x.node.scan.state]), [['scan', n.id, 'clean']]);
    assert.ok(c.events().slice(before).some((e) => e.type === 'changed' && e.users.includes(MARC.id)));
    assert.equal((await a('GET', `nodes/${n.id}`)).json.node.scan.state, 'clean');
    // the nightly re-check with new signatures blocks it
    await host.mediaScanned(n.mediaId, { state: 'infected', finding: 'Win.Trojan.Agent-1' });
    assert.deepEqual((await a('GET', `nodes/${n.id}`)).json.node.scan, { state: 'infected', blocked: true, finding: 'Win.Trojan.Agent-1' });
    assert.equal((await a('GET', `nodes/${n.id}/content`)).json.code, 'quarantined');
    // the quarantine ends: the host deleted the file — Drive keeps the node, blocked
    await host.mediaScanned(n.mediaId, { state: 'deleted' });
    assert.equal((await a('GET', `nodes/${n.id}`)).json.node.scan.blocked, true);
    // a missed hook: the housekeeping asks again for a file still 'pending'
    const p = (await c.put(ANNA, fam.rootId, 'gross.zip', 'zip', { mime: 'application/zip' })).json.node;
    host.media.get(p.mediaId).scan = { state: 'clean', blocked: false, finding: null, at: new Date().toISOString() };
    c.clock.add(5 * MIN);
    await host.tick();
    assert.equal((await a('GET', `nodes/${p.id}`)).json.node.scan.state, 'clean');
  });
});

test('upload links: a file deleted at once never arrives; a quarantined one arrives blocked', async () => {
  let next = null;
  await withHost({ scan: () => next }, async (host, c) => {
    const a = c.as(ANNA);
    const fam = await c.area(ANNA, 'family');
    const inbox = (await a('POST', 'nodes', { parentId: fam.rootId, name: 'Eingang' })).json.node;
    const l = (await a('POST', 'links', { nodeId: inbox.id, mode: 'upload', expires: '7d' })).json.link;
    next = { deleted: true, finding: 'Win.Trojan.Agent' };
    const r = await host.publicLinkUpload(l.token, { name: 'Rechnung.exe', data: 'MZ', mime: 'application/octet-stream' });
    assert.deepEqual([r.status, r.code], [422, 'infected']);
    assert.equal((await a('GET', 'nodes/by-path', null, { area: fam.id, path: 'Eingang/Rechnung.exe' })).status, 404);
    next = { state: 'infected', finding: 'Win.Trojan.Agent' };
    assert.equal((await host.publicLinkUpload(l.token, { name: 'Rechnung.pdf', data: '%PDF', mime: 'application/pdf' })).status, 200);
    const n = await a('GET', 'nodes/by-path', null, { area: fam.id, path: 'Eingang/Rechnung.pdf' });
    assert.deepEqual(n.json.node.scan, { state: 'infected', blocked: true, finding: 'Win.Trojan.Agent' });
  });
});

test('save_file from Mail or GateDrop: the hand-over\'s state comes along', async () => {
  await withHost({ scan: () => ({ state: 'unscannable', blocked: false, finding: 'encrypted' }) }, async (host, c) => {
    const mediaId = (await host.upload(ANNA, Buffer.from('zip'), 'application/zip')).body.mediaId;
    const r = await host.callService('save_file', { caller: MAIL, user: { id: ANNA.id, name: ANNA.name, role: ANNA.role }, payload: { mediaId, area: 'mine', path: 'Mail/a.zip' } });
    assert.equal(r.ok, true, JSON.stringify(r));
    const n = (await c.as(ANNA)('GET', `nodes/${r.nodeId}`)).json.node;
    assert.deepEqual(n.scan, { state: 'unscannable', blocked: false, finding: 'encrypted' });
  });
});
