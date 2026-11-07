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

  it('a PDF to a printer without PDF: the real reason (gateway too old, converting off, no format), never „only PDF and pictures“', async () => {
    const m = await upload(MARC, pdf(1), 'application/pdf');
    const bro = h.host.print.devices.find((d) => d.id === BRO);
    const cases = [['old', 'gateway_update', /ab Version 1\.30\.0/], ['off', 'convert_off', /Umwandeln ist am Gateway ausgeschaltet/], [undefined, 'printer_format', /kein Format, in das das Gateway/]];
    for (const [hook, code, text] of cases) {
      bro.gatewayConvert = hook;
      const r = await h.req(MARC, 'POST', '/print', { deviceId: BRO, mediaId: m });
      assert.deepEqual([r.code, r.status], [code, 409], hook);
      assert.match(r.error, text);
      assert.doesNotMatch(r.error, /Es gehen PDF-Dateien und Bilder/);
    }
    delete bro.gatewayConvert;
    const en = await h.req(MARC, 'POST', '/print', { deviceId: BRO, mediaId: m }, { lang: 'en' });
    assert.match(en.error, /takes no PDF files/);
    const bad = await h.host.upload({ ...MARC, portal: true, loggedIn: true }, Buffer.from('PK'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.equal(bad.status, 415, 'Office files are not among the media types');
  });

  it('a printer without PDF whose gateway converts (HP OfficeJet Pro 8720): the PDF is printed', async () => {
    const bro = h.host.print.devices.find((d) => d.id === BRO);
    bro.printer.convert = 'image/pwg-raster';
    try {
      // the school letter from Android's print dialog: "<uuid>-<name>", no ".pdf"
      const m = await upload(MARC, pdf(1), 'application/pdf');
      const r = await h.req(MARC, 'POST', '/print', { deviceId: BRO, mediaId: m, name: '306ee607-2bbf-458c-880c-ed82755135bf-Digitaler Elternabend' });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual([r.job.state, r.job.pages, r.job.name], ['queued', 1, '306ee607-2bbf-458c-880c-ed82755135bf-Digitaler Elternabend']);
      // while the gateway converts: "wird für den Drucker umgewandelt" (state sending, message converting)
      h.host.printJob(r.job.id, { state: 'sending', message: 'converting' });
      await h.host.tick();
      const mine = (await h.req(MARC, 'GET', '/overview')).jobs.find((x) => x.id === r.job.id);
      assert.deepEqual([mine.state, mine.message], ['sending', 'converting']);
      // the type counts by the content: a PDF the phone called a JPEG
      const odd = await upload(MARC, pdf(3), 'image/jpeg');
      assert.equal((await h.req(MARC, 'POST', '/print', { deviceId: BRO, mediaId: odd })).job.pages, 3);
    } finally { delete bro.printer.convert; }
  });

  it('ERR_PRINT_FORMAT → the plugin\'s code: by e.reason, from an older GateControl by its message', () => {
    const { formatCode, fromHost } = require('../server/util');
    const e = (message, reason) => Object.assign(new Error(message), { code: 'ERR_PRINT_FORMAT' }, reason ? { reason } : {});
    assert.equal(formatCode(e('x', 'file_type')), 'format');
    assert.equal(formatCode(e('x', 'damaged')), 'damaged');
    assert.equal(formatCode(e('x', 'printer')), 'printer_format');
    assert.equal(formatCode(e('x', 'gateway_update')), 'gateway_update');
    assert.equal(formatCode(e('x', 'convert_off')), 'convert_off');
    assert.equal(formatCode(e('this printer takes no PDF')), 'gateway_update', 'GateControl 1.241: the printer takes no PDF – needs the update');
    assert.equal(formatCode(e('this printer takes neither JPEG nor PDF')), 'gateway_update');
    assert.equal(formatCode(e('not a PDF file')), 'damaged');
    assert.equal(formatCode(e('the picture cannot be read')), 'damaged');
    assert.equal(formatCode(e('only PDF files and pictures can be printed')), 'format');
    assert.equal(formatCode(e('x', 'bogus')), 'format');
    assert.equal(fromHost(e('x', 'convert_off')).code, 'convert_off');
    assert.equal(fromHost(Object.assign(new Error('x'), { code: 'ERR_PRINT_OFFLINE' })).code, 'offline');
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
