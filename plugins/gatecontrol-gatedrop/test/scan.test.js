'use strict';

// GateControl's virus scan (1.4.0, server/scan.js; the mock host's opts.scan): a file it holds back is never sent
// (422 infected, 423 scan_pending / scan_blocked, with its name), the items of a send carry `scan`, a later block
// (hook mediaScanned) takes the file off — GET items/<mediaId> 423, not available; a Drive delivery of a file blocked
// in between fails with the code. Without the scan (an older GateControl) nothing changes.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC, PDF } = require('./helpers');

const EICAR = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');

test('an older GateControl (no scan): sent as before, no `scan` on the items', async () => {
  await withHost({}, async (host, c) => {
    const m = await c.upload(ANNA, EICAR, 'application/pdf');
    const r = await c.as(ANNA, 'anna-phone')('POST', 'sends', { items: [{ mediaId: m, name: 'a.pdf' }], to: { devices: ['anna-pc'] } });
    assert.equal(r.status, 200);
    assert.equal(r.json.send.items[0].scan, undefined);
    assert.equal(r.json.send.items[0].available, true);
  });
});

test('POST sends: malware 422, still being checked 423 scan_pending, not checkable 423 scan_blocked; clean is sent with its state', async () => {
  let next = null;
  await withHost({ scan: (f) => (f.data.includes('EICAR') ? { state: 'infected', finding: 'Eicar-Test-Signature' } : next) }, async (host, c) => {
    const as = c.as(ANNA, 'anna-phone');
    const bad = await c.upload(ANNA, EICAR, 'application/pdf');
    const r = await as('POST', 'sends', { items: [{ mediaId: bad, name: 'rechnung.pdf' }], to: { people: [String(MARC.id)] } });
    assert.deepEqual([r.status, r.json.code, r.json.name], [422, 'infected', 'rechnung.pdf']);
    assert.match(r.json.error, /Schadsoftware/);
    next = { state: 'pending' };
    const big = await c.upload(ANNA, PDF, 'application/pdf');
    const p = await as('POST', 'sends', { items: [{ mediaId: big }], to: { devices: ['anna-pc'] } });
    assert.deepEqual([p.status, p.json.code], [423, 'scan_pending']);
    next = { state: 'unscannable', blocked: true, finding: 'encrypted' };
    const zip = await c.upload(ANNA, Buffer.from('zip'), 'application/zip');
    assert.equal((await as('POST', 'sends', { items: [{ mediaId: zip }], to: { devices: ['anna-pc'] } })).json.code, 'scan_blocked');
    // the check of the big file ends: it goes now
    await host.mediaScanned(big, { state: 'clean' });
    const ok = await as('POST', 'sends', { items: [{ mediaId: big, name: 'gross.pdf' }], to: { devices: ['anna-pc'] } });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.send.items[0].scan, { state: 'clean', blocked: false, finding: null });
    // nothing was sent before
    assert.equal(c.pushes().length, 1);
  });
});

test('a later block (mediaScanned): the item is held back for the recipient — not available, GET items 423', async () => {
  await withHost({ scan: true }, async (host, c) => {
    const m = await c.upload(ANNA, PDF, 'application/pdf');
    const r = (await c.as(ANNA, 'anna-phone')('POST', 'sends', { items: [{ mediaId: m, name: 'a.pdf' }], to: { devices: ['anna-pc'] } })).json;
    const pc = c.as(ANNA, 'anna-pc');
    assert.equal((await pc('GET', `items/${m}`)).status, 200);
    await host.mediaScanned(m, { state: 'infected', finding: 'Win.Trojan.Agent-1' });
    const s = (await pc('GET', `sends/${r.id}`)).json.send;
    assert.deepEqual([s.items[0].available, s.items[0].mediaId, s.items[0].scan], [false, null, { state: 'infected', blocked: true, finding: 'Win.Trojan.Agent-1' }]);
    const got = await pc('GET', `items/${m}`);
    assert.deepEqual([got.status, got.json.code, got.json.scan.finding], [423, 'quarantined', 'Win.Trojan.Agent-1']);
    assert.equal((await host.mediaGet(ANNA, m)).status, 423, 'GateControl holds it back too');
    // released by an administrator
    await host.mediaScanned(m, { state: 'clean' });
    assert.equal((await pc('GET', `items/${m}`)).status, 200);
  });
});

test('a Drive delivery of a file the scan holds back in between fails with the code', async () => {
  await withHost({ scan: true, drive: true }, async (host, c) => {
    const deliver = require('../server/deliver');
    const m = await c.upload(ANNA, PDF, 'application/pdf');
    // the check finished clean, a re-check blocked it before the delivery ran (it runs after the answer)
    await host.mediaScanned(m, { state: 'infected', finding: 'X' });
    const ctx = { gc: host.gc, viewer: ANNA.id, lang: 'de', now: Date.now() };
    const r = await deliver.drive(ctx, { id: 'x' }, [{ idx: 0, media_id: m, name: 'a.pdf' }], { target: 'mine' });
    assert.deepEqual([r.status, r.error], ['failed', 'quarantined']);
    assert.equal(c.drive.saved.length, 0);
  });
});
