'use strict';

// 1.11.0: GateControl's virus scan (server/scan.js; the mock host's opts.scan): a file in quarantine is not sent
// ("nicht gesendet – Schadsoftware", 422 infected), the message's file carries `media.scan`, a held-back file has no URL
// and no preview ("Datei gesperrt" for the recipient), a later result (hook mediaScanned) updates the message (updated_at,
// the live event message.update), no push picture of a held-back file, "In Drive speichern" refused. Without the scan
// (an older GateControl) nothing changes.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC, PDF, PNG, portal } = require('./helpers');

const EICAR = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
let n = 0;
const cid = () => `scan-client-${++n}`;

test('an older GateControl (no scan): sent as before, no `scan`; GET me lists the feature', async () => {
  await withHost({}, async (host, c) => {
    assert.equal((await c.as(ANNA)('GET', 'me')).json.features.scan, true);
    const d = await c.direct(ANNA, MARC);
    const id = await c.upload(ANNA, EICAR, 'application/pdf');
    const m = await c.send(ANNA, d.id, { kind: 'file', mediaId: id, meta: { fileName: 'a.pdf' } });
    assert.equal(m.media.scan, undefined);
  });
});

test('sending: malware is not sent (422 infected with the find), not checkable and blocked 423; clean and pending are sent with their state', async () => {
  let next = null;
  await withHost({ scan: (f) => (f.data.includes('EICAR') ? { state: 'infected', finding: 'Eicar-Test-Signature' } : next) }, async (host, c) => {
    const d = await c.direct(ANNA, MARC);
    const bad = await c.upload(ANNA, EICAR, 'application/pdf');
    const r = await c.as(ANNA)('POST', `conversations/${d.id}/messages`, { clientId: cid(), kind: 'file', mediaId: bad, meta: { fileName: 'rechnung.pdf' } });
    assert.deepEqual([r.status, r.json.code, r.json.finding, r.json.error], [422, 'infected', 'Eicar-Test-Signature', 'Nicht gesendet – der Virenscan hat in der Datei Schadsoftware gefunden.']);
    next = { state: 'unscannable', blocked: true, finding: 'encrypted' };
    const zip = await c.upload(ANNA, Buffer.from('zip'), 'application/zip');
    assert.equal((await c.as(ANNA)('POST', `conversations/${d.id}/messages`, { clientId: cid(), kind: 'file', mediaId: zip, meta: { fileName: 'a.zip' } })).json.code, 'scan_blocked');
    next = null;
    const ok = await c.send(ANNA, d.id, { kind: 'file', mediaId: await c.upload(ANNA, PDF, 'application/pdf'), meta: { fileName: 'brief.pdf' } });
    assert.deepEqual(ok.media.scan, { state: 'clean', blocked: false, finding: null });
    next = { state: 'pending' };
    const big = await c.send(ANNA, d.id, { kind: 'file', mediaId: await c.upload(ANNA, PDF, 'application/pdf'), meta: { fileName: 'film.pdf' } });
    assert.deepEqual(big.media.scan, { state: 'pending', blocked: true, finding: null });
    // nothing of the refused ones in the chat
    const list = (await c.as(MARC)('GET', `conversations/${d.id}/messages`)).json.messages;
    assert.deepEqual(list.map((m) => m.media && m.media.scan.state), ['clean', 'pending']);
  });
});

test('a held-back file: no URL, no preview, no push picture; the check ends → message.update; a later block; to-drive refused', async () => {
  let next = { state: 'pending' };
  const d0 = { plugin: 'gatecontrol-drive', provides: ['list_areas', 'save_file'], media: { maxBytes: 26214400, types: ['image/*', 'application/*'], quotaDefault: '1GB' }, service: async () => ({ ok: true, nodeId: 1, name: 'x', where: 'x' }) };
  await withHost({ gatecontrol: '1.193.0', scan: () => next, services: [d0] }, async (host, c) => {
    const d = await c.direct(ANNA, MARC);
    const img = await c.upload(ANNA, PNG, 'image/png');
    const m = await c.send(ANNA, d.id, { kind: 'image', mediaId: img });
    // the recipient's portal: no URL of a file still being checked
    const seen = (await c.call(portal(MARC), 'GET', `conversations/${d.id}/messages`)).json.messages[0];
    assert.deepEqual([seen.media.url, seen.media.thumbUrl, seen.media.scan.state], [null, null, 'pending']);
    assert.equal(c.pushes().at(-1).image, undefined, 'no push picture');
    // the check ends: the message changes, the members hear it
    c.resetEvents();
    c.clock.add(5000);
    await host.mediaScanned(img, { state: 'clean' });
    const ev = c.events('message.update');
    assert.equal(ev.length, 1);
    assert.deepEqual([ev[0].users.sort(), ev[0].data.messageId, ev[0].data.scan.state], [[ANNA.id, MARC.id], m.id, 'clean']);
    const changed = (await c.as(MARC)('GET', `conversations/${d.id}/messages`, null, { changedSince: new Date(Date.now() - 1000).toISOString() })).json.messages;
    assert.deepEqual(changed.map((x) => [x.id, x.media.scan.state]), [[m.id, 'clean']]);
    assert.match((await c.call(portal(MARC), 'GET', `conversations/${d.id}/messages`)).json.messages[0].media.url, /^\/plugin-media\//);
    // a later block (the nightly re-check): "Datei gesperrt", "In Drive speichern" refused
    await host.mediaScanned(img, { state: 'infected', finding: 'Win.Trojan.Agent-1' });
    const after = (await c.call(portal(MARC), 'GET', `conversations/${d.id}/messages`)).json.messages[0];
    assert.deepEqual([after.media.url, after.media.scan], [null, { state: 'infected', blocked: true, finding: 'Win.Trojan.Agent-1' }]);
    const r = await c.as(MARC)('POST', `messages/${m.id}/to-drive`, {});
    assert.deepEqual([r.status, r.json.code], [423, 'quarantined']);
    assert.equal((await host.mediaGet(MARC, img)).status, 423, 'GateControl holds it back too');
    next = null;
  });
});
