'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, ADMIN, MARC, SABINE, LEA, HP, BRO, pdf } = require('./helpers');

describe('printing', () => {
  let h;
  before(async () => { h = await setup(); });
  after(async () => { await h.host.close(); });

  const upload = async (user, buf, mime) => {
    const r = await h.host.upload({ ...user, portal: true, loggedIn: true }, buf, mime);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.mediaId;
  };

  it('the portal overview: printers and scanners without addresses, the rights, the Drive target', async () => {
    const r = await h.req(MARC, 'GET', '/overview');
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.printers.map((d) => d.name), ['HP OfficeJet 8020', 'Brother HL-L2350DW']);
    assert.deepEqual(r.scanners.map((d) => d.id), [HP]);
    assert.equal(r.printers[0].ip, undefined, 'no address in the portal');
    assert.equal(r.pagesLeft, null);
    assert.deepEqual(r.target, { area: 'mine', folder: 'Scans' });
    assert.equal(r.drive, true);
    assert.equal(r.ai, true);
    const lea = await h.req(LEA, 'GET', '/overview');
    assert.equal(lea.pagesLeft, 20);
    assert.equal(lea.rights.bwOnly, true);
  });

  it('print from the portal: copies, colour, double-sided; the host gets the person', async () => {
    const m = await upload(SABINE, pdf(2), 'application/pdf');
    const r = await h.req(SABINE, 'POST', '/print', { deviceId: HP, mediaId: m, copies: 2, color: true, duplex: true, name: 'Bordkarte_Mallorca.pdf' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual([r.job.state, r.job.pages, r.job.copies, r.job.color, r.job.duplex, r.job.device, r.job.name], ['queued', 2, 2, true, true, 'HP OfficeJet 8020', 'Bordkarte_Mallorca.pdf']);
    const call = h.host.print.calls.filter((c) => c.op === 'submit').pop();
    assert.equal(call.args.user, SABINE.id);
  });

  it('a child: black and white only, at most 20 pages a day (pages × copies), checked on the server', async () => {
    const m = await upload(LEA, pdf(6), 'application/pdf');
    let r = await h.req(LEA, 'POST', '/print', { deviceId: HP, mediaId: m, copies: 3, color: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.job.color, false, 'colour forced off');
    assert.equal(r.pagesLeft, 2);
    r = await h.req(LEA, 'POST', '/print', { deviceId: HP, mediaId: m, copies: 1 });
    assert.equal(r.code, 'limit');
    assert.equal(r.left, 2);
    assert.match(r.error, /6 Seiten.*noch 2/);
    // a failed job does not count
    const job = (await h.req(LEA, 'GET', '/overview')).jobs[0];
    h.host.printJob(job.id, { state: 'failed', error: 'printer_rejected' });
    await h.host.tick();
    r = await h.req(LEA, 'POST', '/print', { deviceId: HP, mediaId: m, copies: 1 });
    assert.equal(r.ok, true, JSON.stringify(r));
  });

  it('a PDF to a printer without PDF, an Office file: refused with the host\'s reason', async () => {
    const m = await upload(MARC, pdf(1), 'application/pdf');
    const r = await h.req(MARC, 'POST', '/print', { deviceId: BRO, mediaId: m });
    assert.equal(r.code, 'format');
    assert.equal(r.status, 409);
    const bad = await h.host.upload({ ...MARC, portal: true, loggedIn: true }, Buffer.from('PK'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.equal(bad.status, 415, 'Office files are not among the media types');
  });

  it('background: states into the history, "Druck fertig" / "fehlgeschlagen" once to the person', async () => {
    const m = await upload(MARC, pdf(1), 'application/pdf');
    const j = (await h.req(MARC, 'POST', '/print', { deviceId: HP, mediaId: m, name: 'Rechnung.pdf' })).job;
    h.host.printJob(j.id, { state: 'waiting', error: 'printer_offline' });
    await h.host.tick();
    let mine = (await h.req(MARC, 'GET', '/overview')).jobs.find((x) => x.id === j.id);
    assert.deepEqual([mine.state, mine.error], ['waiting', 'printer_offline']);
    h.host.printJob(j.id, { state: 'done', error: null });
    await h.host.tick();
    await h.host.tick();
    const n = h.host.notifications.filter((x) => x.topic === 'print_done' && x.users.includes(MARC.id));
    assert.equal(n.length, 1);
    assert.match(n[0].body, /Rechnung\.pdf/);
    mine = (await h.req(MARC, 'GET', '/overview')).jobs.find((x) => x.id === j.id);
    assert.equal(mine.state, 'done');
    const j2 = (await h.req(MARC, 'POST', '/print', { deviceId: HP, mediaId: m })).job;
    h.host.printJob(j2.id, { state: 'expired', error: 'printer_offline' });
    await h.host.tick();
    assert.equal(h.host.notifications.filter((x) => x.topic === 'print_failed' && x.users.includes(MARC.id)).length, 1);
    assert.equal(h.host.notifications.filter((x) => x.topic === 'print_failed' && x.users.includes(LEA.id)).length, 1, 'Lea\'s rejected job');
  });

  it('cancel a waiting job; somebody else cannot', async () => {
    const m = await upload(MARC, pdf(1), 'application/pdf');
    const j = (await h.req(MARC, 'POST', '/print', { deviceId: HP, mediaId: m })).job;
    assert.equal((await h.req(SABINE, 'POST', `/jobs/${j.id}/cancel`)).code, 'not_found');
    const r = await h.req(MARC, 'POST', `/jobs/${j.id}/cancel`);
    assert.deepEqual(r.canceled, true);
  });

  it('admin: devices with ink, test page, search again, retrust; history with names', async () => {
    const d = await h.adminReq('GET', 'devices');
    assert.equal(d.ok, true, JSON.stringify(d));
    const hp = d.devices.find((x) => x.id === HP);
    assert.equal(hp.ip, '192.168.1.57');
    assert.equal(hp.printer.markers[1].low, true);
    const t = await h.adminReq('POST', `devices/${encodeURIComponent(HP)}/test`);
    assert.equal(t.ok, true, JSON.stringify(t));
    assert.equal(t.job.name, 'GateControl Testseite');
    assert.equal((await h.adminReq('POST', 'devices/discover')).asked, 1);
    await h.adminReq('POST', `devices/${encodeURIComponent(HP)}/retrust`);
    assert.deepEqual(h.host.print.retrusted, [HP]);
    const hist = await h.adminReq('GET', 'history');
    const names = new Set(hist.items.map((x) => x.userName));
    assert.ok(names.has('Sabine') && names.has('Lea') && names.has('Admin'));
    const test = hist.items.find((x) => x.name === 'GateControl Testseite');
    assert.equal(test.via, 'admin');
    // the test page never notifies
    h.host.printJob(test.id, { state: 'done' });
    await h.host.tick();
    assert.equal(h.host.notifications.filter((x) => x.users && x.users.includes(ADMIN.id)).length, 0);
  });

  it('settings: checked, kept', async () => {
    assert.equal((await h.adminReq('PUT', 'settings', { folder: '../x' })).code, 'invalid');
    assert.equal((await h.adminReq('PUT', 'settings', { bogus: 1 })).code, 'invalid');
    const r = await h.adminReq('PUT', 'settings', { driveArea: 'family', folder: 'Dokumente', aiFile: false });
    assert.deepEqual([r.settings.driveArea, r.settings.folder, r.settings.aiFile], ['family', 'Dokumente', false]);
    assert.equal((await h.adminReq('GET', 'settings')).settings.folder, 'Dokumente');
    await h.adminReq('PUT', 'settings', { driveArea: 'mine', folder: 'Scans', aiFile: true });
  });
});
