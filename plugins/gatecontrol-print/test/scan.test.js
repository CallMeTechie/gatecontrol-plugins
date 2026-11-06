'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, MARC, SABINE, HP, BRO } = require('./helpers');

describe('scanning into Drive', () => {
  let h;
  before(async () => { h = await setup(); });
  after(async () => { await h.host.close(); });

  it('scan from the feeder, another page from the glass, previews, the AI\'s name and folder, save as one PDF', async () => {
    let r = await h.req(MARC, 'POST', '/scan', { deviceId: HP, source: 'feeder', mode: 'document' });
    assert.equal(r.ok, true, JSON.stringify(r));
    const id = r.scan.id;
    assert.equal(r.scan.scanning, true);
    const scan1 = h.host.print.calls.filter((c) => c.op === 'scan').pop().args;
    assert.deepEqual([scan1.source, scan1.mode, scan1.user], ['feeder', 'document', MARC.id]);
    assert.equal((await h.req(MARC, 'POST', `/scan/${id}/more`, {})).code, 'scan_running');
    const hostScans = [...h.host.print.scans.keys()];
    h.host.printScanPages(hostScans[0], [{ data: 'p1' }, { data: 'p2' }]);
    r = await h.req(MARC, 'GET', `/scan/${id}`);
    assert.equal(r.scan.scanning, false);
    assert.equal(r.scan.pages.length, 2);
    assert.ok(r.scan.pages[0].thumb);
    // "Weitere Seite" from the glass
    r = await h.req(MARC, 'POST', `/scan/${id}/more`, { source: 'platen' });
    assert.equal(r.ok, true, JSON.stringify(r));
    h.host.printScanPages([...h.host.print.scans.keys()][1], [{ data: 'p3' }]);
    r = await h.req(MARC, 'GET', `/scan/${id}`);
    assert.equal(r.scan.pages.length, 3);
    // another person sees nothing of it
    assert.equal((await h.req(SABINE, 'GET', `/scan/${id}`)).code, 'not_found');
    // the AI: the first page as a picture to Drive's suggest_folder
    r = await h.req(MARC, 'POST', `/scan/${id}/suggest`);
    assert.deepEqual(r.suggestion, { name: '2026-11-06 Stadtwerke Rechnung.pdf', where: 'Finanzen › Strom', folderId: 42 });
    const sug = h.drive.calls.find((c) => c.name === 'suggest_folder');
    assert.equal(sug.user, MARC.id);
    assert.match(sug.payload.name, /\.jpg$/);
    const handed = h.host.handOvers.find((x) => x.mediaId === sug.payload.mediaId);
    assert.equal(handed.mime, 'image/jpeg');
    // save: one PDF of three pages into the suggested folder
    r = await h.req(MARC, 'POST', `/scan/${id}/save`, {});
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.scan.state, 'saved');
    assert.equal(r.scan.savedWhere, 'Finanzen › Strom › 2026-11-06 Stadtwerke Rechnung.pdf');
    const save = h.drive.calls.find((c) => c.name === 'save_file');
    assert.deepEqual([save.payload.folderId, save.payload.name, save.payload.onConflict, save.payload.source.plugin], [42, '2026-11-06 Stadtwerke Rechnung.pdf', 'rename', 'gatecontrol-print']);
    const doc = h.host.handOvers.find((x) => x.mediaId === save.payload.mediaId);
    assert.equal(doc.mime, 'application/pdf');
    assert.equal((await h.req(MARC, 'POST', `/scan/${id}/save`, {})).code, 'invalid', 'saved once');
  });

  it('without the AI: the name typed in, into the configured area and folder', async () => {
    await h.adminReq('PUT', 'settings', { aiFile: false, driveArea: 'family', folder: 'Dokumente' });
    let r = await h.req(SABINE, 'POST', '/scan', { deviceId: HP, source: 'platen' });
    const id = r.scan.id;
    h.host.printScanPages([...h.host.print.scans.keys()].pop(), [{ data: 'x' }]);
    await h.req(SABINE, 'GET', `/scan/${id}`);
    assert.equal((await h.req(SABINE, 'POST', `/scan/${id}/suggest`)).suggestion, null);
    r = await h.req(SABINE, 'POST', `/scan/${id}/save`, { name: 'Zeugnis Lea' });
    assert.equal(r.ok, true, JSON.stringify(r));
    const save = h.drive.calls.filter((c) => c.name === 'save_file').pop();
    assert.deepEqual([save.payload.area, save.payload.path, save.payload.folderId], ['family', 'Dokumente/Zeugnis Lea.pdf', undefined]);
    await h.adminReq('PUT', 'settings', { aiFile: true, driveArea: 'mine', folder: 'Scans' });
  });

  it('remove a page, discard; a failed scan shows the scanner\'s reason; no scanner, no right', async () => {
    let r = await h.req(MARC, 'POST', '/scan', { deviceId: HP });
    const id = r.scan.id;
    h.host.printScanPages([...h.host.print.scans.keys()].pop(), [{ data: 'a' }, { data: 'b' }]);
    await h.req(MARC, 'GET', `/scan/${id}`);
    r = await h.req(MARC, 'POST', `/scan/${id}/remove-page`, { n: 1 });
    assert.equal(r.scan.pages.length, 1);
    r = await h.req(MARC, 'POST', `/scan/${id}/more`, {});
    h.host.printScanPages([...h.host.print.scans.keys()].pop(), [], { state: 'failed', error: 'feeder_empty' });
    r = await h.req(MARC, 'GET', `/scan/${id}`);
    assert.deepEqual([r.scan.error, r.scan.pages.length, r.scan.scanning], ['feeder_empty', 1, false]);
    assert.equal((await h.req(MARC, 'POST', `/scan/${id}/discard`)).discarded, true);
    assert.equal((await h.req(MARC, 'POST', '/scan', { deviceId: BRO })).code, 'not_found');
    await h.adminReq('PUT', 'rights/' + MARC.id, { scan: false });
    assert.equal((await h.req(MARC, 'POST', '/scan', { deviceId: HP })).code, 'no_right');
    await h.adminReq('PUT', 'rights/' + MARC.id, { reset: true });
  });

  it('Drive missing: scans cannot be saved (no_drive), the overview says so', async () => {
    const x = await setup({ noDrive: true });
    try {
      const o = await x.req(MARC, 'GET', '/overview');
      assert.deepEqual([o.drive, o.ai], [false, false]);
      const r = await x.req(MARC, 'POST', '/scan', { deviceId: HP });
      x.host.printScanPages([...x.host.print.scans.keys()].pop(), [{ data: 'a' }]);
      await x.req(MARC, 'GET', `/scan/${r.scan.id}`);
      assert.equal((await x.req(MARC, 'POST', `/scan/${r.scan.id}/save`, {})).code, 'no_drive');
    } finally { await x.host.close(); }
  });
});
