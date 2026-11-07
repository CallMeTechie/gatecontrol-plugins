'use strict';

// 1.1.0 — searchable PDFs (GateControl's text recognition on a gateway, gc.print.ocr), office files and plain text,
// paper and tray, GET jobs/<id> for the apps, the printer's stop reasons in the history.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, devices, MARC, SABINE, LEA, HP, BRO, pdf } = require('./helpers');

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function withP3c() {
  const list = devices();
  list[0].printer.office = true;
  list[0].printer.media = { sizes: ['iso_a4_210x297mm', 'iso_a5_148x210mm', 'na_index-4x6_4x6in'], default: 'iso_a4_210x297mm', sources: ['main', 'photo'], sourceDefault: 'main', ready: [] };
  list[1].printer.office = false;
  list[1].gatewayOffice = 'off';
  return list;
}

describe('1.1.0: office files, text, paper and tray, the job for the apps', () => {
  let h;
  before(async () => { h = await setup({ host: { gatecontrol: '1.247.0', print: { devices: withP3c(), ocr: { available: true } } } }); });
  after(async () => { await h.host.close(); });

  const upload = async (user, buf, mime) => {
    const r = await h.host.upload({ ...user, portal: true, loggedIn: true }, buf, mime);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.mediaId;
  };

  it('the overview names office support, paper and trays (never an address)', async () => {
    const r = await h.req(MARC, 'GET', '/overview');
    const hp = r.printers.find((d) => d.id === HP);
    assert.equal(hp.printer.office, true);
    assert.deepEqual(hp.printer.media, { sizes: ['iso_a4_210x297mm', 'iso_a5_148x210mm', 'na_index-4x6_4x6in'], default: 'iso_a4_210x297mm', sources: ['main', 'photo'], sourceDefault: 'main' });
    const bro = r.printers.find((d) => d.id === BRO);
    assert.deepEqual([bro.printer.office, bro.printer.media.sizes], [false, []]);
    assert.equal(r.ocr, true);
  });

  it('an office file where the gateway converts it; where not: the real reason (office_off)', async () => {
    const m = await upload(SABINE, Buffer.from('PK\u0003\u0004 docx'), DOCX);
    let r = await h.req(SABINE, 'POST', '/print', { deviceId: HP, mediaId: m, name: 'Elternbrief.docx' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(h.host.print.calls.filter((c) => c.op === 'submit').pop().args.mediaId, m);
    r = await h.req(SABINE, 'POST', '/print', { deviceId: BRO, mediaId: m });
    assert.equal(r.code, 'office_off');
    assert.match(r.error, /Office-Dateien drucken/);
    const txt = await upload(SABINE, Buffer.from('Einkaufsliste\nMilch\n'), 'text/plain');
    r = await h.req(SABINE, 'POST', '/print', { deviceId: BRO, mediaId: txt });
    assert.equal(r.ok, true, 'text works without the office service');
  });

  it('paper and tray go to GateControl; one the printer does not name is refused', async () => {
    const m = await upload(MARC, pdf(1), 'application/pdf');
    const r = await h.req(MARC, 'POST', '/print', { deviceId: HP, mediaId: m, media: 'na_index-4x6_4x6in', source: 'photo' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual([r.job.media, r.job.source], ['na_index-4x6_4x6in', 'photo']);
    const call = h.host.print.calls.filter((c) => c.op === 'submit').pop().args;
    assert.deepEqual([call.media, call.source], ['na_index-4x6_4x6in', 'photo']);
    assert.equal((await h.req(MARC, 'POST', '/print', { deviceId: HP, mediaId: m, media: 'na_legal_8.5x14in' })).code, 'invalid');
    assert.equal((await h.req(MARC, 'POST', '/print', { deviceId: BRO, mediaId: m, source: 'main' })).code, 'invalid');
    // empty = the printer's default
    assert.equal((await h.req(MARC, 'POST', '/print', { deviceId: HP, mediaId: m, media: '', source: '' })).ok, true);
  });

  it('GET jobs/<id>: the person\'s own job, fresh (stop reason, pages after converting); another person: not found', async () => {
    const m = await upload(MARC, Buffer.from('PK\u0003\u0004 docx'), DOCX);
    const job = (await h.req(MARC, 'POST', '/print', { deviceId: HP, mediaId: m })).job;
    assert.equal(job.pages, 1);
    h.host.printJob(job.id, { state: 'printing', message: 'media-empty', pages: 4 });
    const r = await h.req(MARC, 'GET', '/jobs/' + job.id);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual([r.job.state, r.job.message, r.job.pages], ['printing', 'media-empty', 4]);
    assert.equal((await h.req(SABINE, 'GET', '/jobs/' + job.id)).code, 'not_found');
    h.host.printJob(job.id, { state: 'done', message: null });
    assert.equal((await h.req(MARC, 'GET', '/jobs/' + job.id)).job.state, 'done');
    // the background takes the pages over too (the day's page count)
    const m2 = await upload(LEA, Buffer.from('PK\u0003\u0004 docx'), DOCX);
    const j2 = (await h.req(LEA, 'POST', '/print', { deviceId: HP, mediaId: m2 })).job;
    h.host.printJob(j2.id, { state: 'printing', pages: 3 });
    await h.host.tick();
    assert.equal((await h.req(LEA, 'GET', '/overview')).jobs.find((x) => x.id === j2.id).pages, 3);
  });
});

describe('1.1.0: searchable PDFs of scans', () => {
  let h;
  before(async () => { h = await setup({ host: { gatecontrol: '1.247.0', print: { devices: withP3c(), ocr: { available: true } } } }); });
  after(async () => { await h.host.close(); });

  async function scanned(user, n = 2) {
    const r = await h.req(user, 'POST', '/scan', { deviceId: HP, source: 'feeder', mode: 'document' });
    assert.equal(r.ok, true, JSON.stringify(r));
    const hostScan = [...h.host.print.scans.keys()].pop();
    h.host.printScanPages(hostScan, Array.from({ length: n }, () => ({ mime: 'image/jpeg', data: 'jpeg' })), { state: 'done' });
    const s = await h.req(user, 'GET', '/scan/' + r.scan.id);
    assert.equal(s.scan.pages.length, n);
    return s.scan.id;
  }

  it('save searchable: GateControl recognises the text, the PDF goes to Drive with it', async () => {
    const id = await scanned(MARC);
    const r = await h.req(MARC, 'POST', `/scan/${id}/save`, { name: 'Stadtwerke Rechnung', searchable: true, useSuggestion: false });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.scan.state, 'ocr');
    assert.deepEqual(r.scan.ocr, { page: 0, pages: 2 });
    const call = h.host.print.calls.filter((c) => c.op === 'ocr').pop().args;
    assert.deepEqual([call.user, call.name, call.deviceId, call.pages.length], [MARC.id, 'Stadtwerke Rechnung.pdf', HP, 2]);
    const ocrId = [...h.host.print.ocr.keys()].pop();
    h.host.printOcr(ocrId, { state: 'running', page: 1 });
    let s = await h.req(MARC, 'GET', '/scan/' + id);
    assert.deepEqual([s.scan.state, s.scan.ocr.page], ['ocr', 1]);
    h.host.printOcr(ocrId, { state: 'done', text: 'Rechnung Nr. 4711 Betrag 129,00 €' });
    s = await h.req(MARC, 'GET', '/scan/' + id);
    assert.deepEqual([s.scan.state, s.scan.searchable, s.scan.savedName], ['saved', true, 'Stadtwerke Rechnung.pdf']);
    const save = h.drive.calls.filter((c) => c.name === 'save_file').pop();
    assert.equal(save.payload.text, 'Rechnung Nr. 4711 Betrag 129,00 €', 'the text for Drive\'s search');
    assert.equal(save.payload.path, 'Scans/Stadtwerke Rechnung.pdf');
    const hist = await h.adminReq('GET', 'history');
    assert.equal(hist.items.find((x) => x.id === id).searchable, true);
  });

  it('the background files it when nobody looks; a failed recognition files the plain PDF and says why', async () => {
    const id = await scanned(SABINE, 1);
    await h.req(SABINE, 'POST', `/scan/${id}/save`, { searchable: true, useSuggestion: false });
    const ocrId = [...h.host.print.ocr.keys()].pop();
    h.host.printOcr(ocrId, { state: 'failed', error: 'ocr_timeout' });
    await h.host.tick();
    const s = await h.req(SABINE, 'GET', '/scan/' + id);
    assert.deepEqual([s.scan.state, s.scan.searchable, s.scan.ocrError], ['saved', false, 'ocr_timeout']);
    const save = h.drive.calls.filter((c) => c.name === 'save_file').pop();
    assert.equal(save.payload.text, undefined);
  });

  it('no gateway with text recognition: saved as a plain PDF at once (searchable false, ocr_unavailable)', async () => {
    h.host.print.ocrAvailable = false;
    assert.equal((await h.req(MARC, 'GET', '/overview')).ocr, false);
    const id = await scanned(MARC, 1);
    const r = await h.req(MARC, 'POST', `/scan/${id}/save`, { searchable: true, useSuggestion: false });
    assert.deepEqual([r.scan.state, r.scan.searchable, r.scan.ocrError], ['saved', false, 'ocr_unavailable']);
    h.host.print.ocrAvailable = true;
  });

  it('discard while the text is recognised: GateControl is told; without searchable nothing changes', async () => {
    const id = await scanned(MARC, 1);
    await h.req(MARC, 'POST', `/scan/${id}/save`, { searchable: true, useSuggestion: false });
    const ocrId = [...h.host.print.ocr.keys()].pop();
    await h.req(MARC, 'POST', `/scan/${id}/discard`);
    assert.equal(h.host.print.ocr.get(ocrId).state, 'canceled');
    const id2 = await scanned(MARC, 1);
    const n = h.host.print.calls.filter((c) => c.op === 'ocr').length;
    const r = await h.req(MARC, 'POST', `/scan/${id2}/save`, { useSuggestion: false });
    assert.deepEqual([r.scan.state, r.scan.searchable], ['saved', null]);
    assert.equal(h.host.print.calls.filter((c) => c.op === 'ocr').length, n);
  });

  it('an older GateControl (no gc.print.ocr): no option, saving works as before', async () => {
    const old = await setup();
    try {
      const o = await old.req(MARC, 'GET', '/overview');
      assert.equal(o.ocr, false);
      assert.deepEqual(o.printers[0].printer.media, { sizes: [], default: null, sources: [], sourceDefault: null });
    } finally { await old.host.close(); }
  });
});
