'use strict';

// AI for documents (1.8.0, server/insights.js, server/deadlines.js) against the mock host's gc.ai: hidden without the
// host's AI service, the queue of the background run (one recognition per version, text first, pictures only when
// allowed), the suggestion taken with one click, deadlines with a reminder, rights.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC, LENA, OMA, BOB, DAY, MIN } = require('./helpers');

const TEXT = 'Stadtwerke Musterstadt\nRechnung Nr. 4711 vom 20.10.2026\nGesamtbetrag 84,20 EUR\nZahlbar bis 10.11.2026';

/** An AI that answers like a provider: an invoice, the folder "Rechnungen", a payment deadline. */
function invoiceAi(o = {}) {
  return {
    ...o,
    extract: async (req) => {
      if (o.onExtract) await o.onExtract(req);
      const folders = req.input.find((x) => x.label === 'Folders').text.split('\n');
      const i = folders.findIndex((l) => /: Rechnungen$/.test(l));
      return {
        kind: 'invoice', title: 'Stromrechnung Oktober', date: '2026-10-20', sender: 'Stadtwerke Musterstadt', amount: 84.2, currency: 'eur',
        folder: i >= 0 ? i : null, name: '2026-10-20 Stadtwerke Rechnung.pdf',
        deadlines: [{ kind: 'payment', date: '2026-11-10', label: 'Rechnung bezahlen' }, { kind: 'payment', date: 'bald', label: null }],
      };
    },
  };
}

test('without GateControl\'s AI service (or switched off): no docAi, no insight on nodes, status off, POST refused', async () => {
  const check = async (opts) => withHost(opts, async (host, c) => {
    const a = c.as(ANNA);
    const me = (await a('GET', 'me')).json;
    assert.ok(!me.features.includes('docAi'));
    assert.ok(me.areas.every((x) => !('docAi' in x)));
    const mine = await c.area(ANNA, 'mine');
    const f = (await c.put(ANNA, mine.rootId, 'Rechnung.pdf', 'pdf', { mime: 'application/pdf', text: TEXT })).json.node;
    assert.ok(!('insight' in f));
    assert.ok(!('insight' in (await a('GET', `nodes/${mine.rootId}/children`)).json.items[0]));
    const g = await a('GET', `nodes/${f.id}/insight`);
    assert.equal(g.status, 200);
    assert.equal(g.json.status, 'off');
    assert.deepEqual(g.json.deadlines, []);
    assert.equal((await a('POST', `nodes/${f.id}/insight`)).json.code, 'feature_off');
    assert.equal((await a('POST', `nodes/${f.id}/insight/apply`, { name: true })).status, 403);
    assert.equal((await a('PATCH', `areas/${mine.id}`, { docAi: false })).json.code, 'feature_off');
    await host.tick();
    assert.equal((host.aiRequests || []).length, 0);
    assert.deepEqual((await a('GET', 'deadlines')).json.deadlines, []);
  });
  await check({});
  // GateControl 1.214.0 without a provider set up: gc.ai is there, not available
  await check({ gatecontrol: '1.214.0' });
  await check({ ai: invoiceAi(), settings: { doc_ai: false } });
  await check({ ai: invoiceAi({ allowed: false }) });
  await check({ ai: invoiceAi({ configured: false }) });
});

test('a document with text: queued once per version, recognised in the background, suggestion and deadlines, nothing moved', async () => {
  await withHost({ ai: invoiceAi() }, async (host, c) => {
    const a = c.as(ANNA);
    const me = (await a('GET', 'me')).json;
    assert.ok(me.features.includes('docAi'));
    assert.deepEqual(me.areas.map((x) => [x.kind, x.docAi]), [['mine', true], ['family', true], ['child', false]]);
    const mine = me.areas.find((x) => x.kind === 'mine');
    const bills = (await a('POST', 'nodes', { parentId: mine.rootId, name: 'Rechnungen' })).json.node;
    await a('POST', 'nodes', { parentId: mine.rootId, name: 'Urlaub' });
    const up = await c.put(ANNA, mine.rootId, 'Scan 2026-10-26.pdf', 'pdf1', { mime: 'application/pdf', text: TEXT });
    const id = up.json.node.id;
    assert.deepEqual(up.json.node.insight, { status: 'pending', kind: null });
    // a picture without text and the setting off: nothing goes to the AI on its own
    const pic = (await c.put(ANNA, mine.rootId, 'Foto.jpg', 'jpeg', { mime: 'image/jpeg' })).json.node;
    assert.deepEqual(pic.insight, { status: 'none', kind: null });
    let g = (await a('GET', `nodes/${id}/insight`)).json;
    assert.equal(g.status, 'pending');
    assert.equal(host.aiRequests.length, 0, 'nothing in the request itself');

    const t = await host.tick();
    assert.deepEqual(t.insights, { recognised: 1, failed: 0, waiting: 0 });
    assert.equal(host.aiRequests.length, 1);
    const req = host.aiRequests[0];
    assert.equal(req.task, 'drive_document');
    assert.equal(req.user, ANNA.id);
    assert.ok(req.input.every((x) => x.type === 'text'), 'the text, never the file');
    assert.equal(req.input.find((x) => x.label === 'Document text').text, TEXT);
    assert.match(req.input.find((x) => x.label === 'Folders').text, /^0: \/\n1: Rechnungen\n2: Urlaub$/);
    assert.ok(c.events().some((e) => e.type === 'changed' && e.data.areas.includes(mine.id)));

    g = (await a('GET', `nodes/${id}/insight`)).json;
    assert.equal(g.status, 'ready');
    assert.deepEqual([g.kind, g.title, g.date, g.sender, g.amount, g.currency], ['invoice', 'Stromrechnung Oktober', '2026-10-20', 'Stadtwerke Musterstadt', 84.2, 'EUR']);
    assert.deepEqual(g.suggestion, { folderId: bills.id, folderPath: 'Rechnungen', name: '2026-10-20 Stadtwerke Rechnung.pdf' });
    assert.equal(g.deadlines.length, 1, 'a deadline without a real date is dropped');
    // since 1.14.0 also the family calendar (the viewer's entry) and when it was found; since 1.17.0 all entries (calendars)
    assert.deepEqual({ ...g.deadlines[0], id: 0 }, { id: 0, kind: 'payment', date: '2026-11-10', label: 'Rechnung bezahlen', reminder: null, calendar: null, calendars: [], foundAt: new Date(c.clock.now()).toISOString() });
    // nothing happened on its own
    const n = (await a('GET', `nodes/${id}`)).json.node;
    assert.deepEqual([n.name, n.parentId], ['Scan 2026-10-26.pdf', mine.rootId]);
    assert.deepEqual(n.insight, { status: 'ready', kind: 'invoice' });
    const kids = (await a('GET', `nodes/${mine.rootId}/children`)).json.items;
    assert.deepEqual(kids.find((x) => x.id === id).insight, { status: 'ready', kind: 'invoice' });
    assert.equal(kids.find((x) => x.isDir).insight, undefined, 'folders carry none');

    // no repeat without a reason
    await host.tick();
    c.clock.add(10 * MIN);
    await host.tick();
    assert.equal(host.aiRequests.length, 1);
    // the same version again (uploads/check, a rename): no new recognition
    await a('PATCH', `nodes/${id}`, { name: 'Scan.pdf' });
    await host.tick();
    assert.equal(host.aiRequests.length, 1);
    // a new version with text: once more; one without text: the suggestion goes, the deadline stays
    await c.put(ANNA, mine.rootId, 'Scan.pdf', 'pdf2', { mime: 'application/pdf', text: TEXT + '\nKorrektur', onConflict: 'version' });
    assert.equal((await a('GET', `nodes/${id}/insight`)).json.status, 'pending');
    await host.tick();
    assert.equal(host.aiRequests.length, 2);
    await c.put(ANNA, mine.rootId, 'Scan.pdf', 'pdf3', { mime: 'application/pdf', onConflict: 'version' });
    g = (await a('GET', `nodes/${id}/insight`)).json;
    assert.equal(g.status, 'none');
    assert.equal(g.deadlines.length, 1);
    await host.tick();
    assert.equal(host.aiRequests.length, 2);
  });
});

test('apply: rename, move or both with one click — a free name, write needed, only a ready suggestion', async () => {
  await withHost({ ai: invoiceAi() }, async (host, c) => {
    const a = c.as(ANNA);
    const fam = await c.area(ANNA, 'family');
    const bills = (await a('POST', 'nodes', { parentId: fam.rootId, name: 'Rechnungen' })).json.node;
    // a file of the suggested name is there already
    await c.put(ANNA, bills.id, '2026-10-20 Stadtwerke Rechnung.pdf', 'old', { mime: 'application/pdf' });
    const f = (await c.put(ANNA, fam.rootId, 'scan.PDF', 'pdf', { mime: 'application/pdf', text: TEXT })).json.node;
    assert.equal((await a('POST', `nodes/${f.id}/insight/apply`, { name: true })).json.code, 'invalid', 'not ready yet');
    await host.tick();
    assert.equal((await a('POST', `nodes/${f.id}/insight/apply`, {})).status, 400);
    // Marc (family, write) takes the folder, then Anna the name
    const m = await c.as(MARC)('POST', `nodes/${f.id}/insight/apply`, { folder: true });
    assert.equal(m.status, 200);
    assert.deepEqual([m.json.node.parentId, m.json.node.name], [bills.id, 'scan.PDF']);
    assert.equal(m.json.insight.suggestion.folderId, null, 'it is there now');
    assert.equal(m.json.insight.suggestion.name, '2026-10-20 Stadtwerke Rechnung.PDF', 'the file keeps its own extension');
    const r = await a('POST', `nodes/${f.id}/insight/apply`, { name: true });
    assert.equal(r.json.node.name, '2026-10-20 Stadtwerke Rechnung (2).PDF');
    assert.equal(r.json.insight.suggestion, null);
    assert.equal((await a('POST', `nodes/${f.id}/insight/apply`, { name: true })).json.code, 'invalid');
    // both at once
    const g = (await c.put(ANNA, fam.rootId, 'zwei.pdf', 'pdf2', { mime: 'application/pdf', text: TEXT })).json.node;
    await host.tick();
    const both = await a('POST', `nodes/${g.id}/insight/apply`, { name: true, folder: true });
    assert.deepEqual([both.json.node.parentId, both.json.node.name], [bills.id, '2026-10-20 Stadtwerke Rechnung (3).pdf']);
    const ch = (await a('GET', 'changes', null, { since: 0 })).json.changes.filter((x) => x.nodeId === g.id).map((x) => x.op);
    assert.deepEqual(ch, ['create', 'move']);
    // the suggested folder is gone: not found
    const h = (await c.put(ANNA, fam.rootId, 'drei.pdf', 'pdf3', { mime: 'application/pdf', text: TEXT })).json.node;
    await host.tick();
    await a('DELETE', `nodes/${bills.id}`);
    assert.equal((await a('POST', `nodes/${h.id}/insight/apply`, { folder: true })).status, 404);
    assert.equal((await a('GET', `nodes/${h.id}/insight`)).json.suggestion.folderId, null);
  });
});

test('rights: readers see it, writers ask and take it, a child\'s folder is off by default, Oma has no seat', async () => {
  await withHost({ ai: invoiceAi() }, async (host, c) => {
    const lena = c.as(LENA);
    const child = await c.area(LENA, 'child');
    assert.equal(child.docAi, false);
    const f = (await c.put(LENA, child.rootId, 'Zeugnis.pdf', 'pdf', { mime: 'application/pdf', text: 'Zeugnis Klasse 7' })).json.node;
    assert.deepEqual(f.insight, { status: 'off', kind: null });
    assert.equal((await lena('GET', `nodes/${f.id}/insight`)).json.status, 'off');
    assert.equal((await lena('POST', `nodes/${f.id}/insight`)).json.code, 'feature_off');
    await host.tick();
    assert.equal(host.aiRequests.length, 0);
    // the parent reads, may not switch it or ask
    assert.equal((await c.as(MARC)('PATCH', `areas/${child.id}`, { docAi: true })).status, 403);
    // Lena switches it on, then asks
    const on = await lena('PATCH', `areas/${child.id}`, { docAi: true });
    assert.deepEqual(on.json.area, { id: child.id, docAi: true });
    assert.equal((await lena('PATCH', `areas/${child.id}`, { docAi: 'ja' })).status, 400);
    assert.equal((await lena('POST', `nodes/${f.id}/insight`)).json.status, 'pending');
    await host.tick();
    const marc = c.as(MARC);
    assert.equal((await marc('GET', `nodes/${f.id}/insight`)).json.status, 'ready');
    assert.equal((await marc('POST', `nodes/${f.id}/insight`)).status, 403);
    assert.equal((await marc('POST', `nodes/${f.id}/insight/apply`, { name: true })).status, 403);
    // switched off again: what waits goes, status off
    await lena('PATCH', `areas/${child.id}`, { docAi: false });
    assert.equal((await marc('GET', `nodes/${f.id}/insight`)).json.status, 'off');
    // Anna's own files: nobody else
    const mine = await c.area(ANNA, 'mine');
    const g = (await c.put(ANNA, mine.rootId, 'Vertrag.pdf', 'pdf', { mime: 'application/pdf', text: TEXT })).json.node;
    assert.equal((await c.as(BOB)('GET', `nodes/${g.id}/insight`)).status, 404);
    assert.equal((await c.as(MARC)('PATCH', `areas/${mine.id}`, { docAi: false })).status, 404);
    assert.equal((await c.as(OMA)('GET', `nodes/${g.id}/insight`)).json.code, 'no_seat');
    // a folder has no insight
    assert.equal((await c.as(ANNA)('GET', `nodes/${mine.rootId}/insight`)).status, 400);
  });
});

test('pictures: only when GateControl allows them — on request, or on their own with doc_ai_images', async () => {
  await withHost({ ai: invoiceAi() }, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const pic = (await c.put(ANNA, mine.rootId, 'Brief.jpg', 'jpegbytes', { mime: 'image/jpeg' })).json.node;
    await host.tick();
    assert.equal(host.aiRequests.length, 0);
    assert.equal((await a('POST', `nodes/${pic.id}/insight`)).json.status, 'pending');
    await host.tick();
    assert.deepEqual(host.aiRequests[0].input.at(-1), { type: 'media', mediaId: pic.mediaId });
    assert.equal((await a('GET', `nodes/${pic.id}/insight`)).json.status, 'ready');
    // a PDF or a HEIC picture without text cannot be read (gc.ai takes JPEG, PNG, WebP, GIF only)
    for (const [name, mime] of [['leer.pdf', 'application/pdf'], ['Scan.heic', 'image/heic']]) {
      const f = (await c.put(ANNA, mine.rootId, name, 'bytes', { mime })).json.node;
      const no = await a('POST', `nodes/${f.id}/insight`);
      assert.deepEqual([no.status, no.json.code, no.json.reason], [422, 'unsupported', 'no_text'], name);
    }
    // with its recognised text a HEIC scan goes as text
    const heic = (await c.put(ANNA, mine.rootId, 'Scan2.heic', 'bytes2', { mime: 'image/heic', text: TEXT })).json.node;
    assert.equal(heic.insight.status, 'pending');
    await host.tick();
    assert.ok(host.aiRequests.at(-1).input.every((x) => x.type === 'text'));
    // GateControl's switch "Bilder an KI senden" off
    host.ai.mediaAllowed = false;
    const pic2 = (await c.put(ANNA, mine.rootId, 'Brief2.jpg', 'jpeg2', { mime: 'image/jpeg' })).json.node;
    const off = await a('POST', `nodes/${pic2.id}/insight`);
    assert.deepEqual([off.status, off.json.reason], [422, 'media_disabled']);
  });
  await withHost({ ai: invoiceAi(), settings: { doc_ai_images: true } }, async (host, c) => {
    const mine = await c.area(ANNA, 'mine');
    const pic = (await c.put(ANNA, mine.rootId, 'Brief.png', 'png', { mime: 'image/png' })).json.node;
    assert.equal(pic.insight.status, 'pending');
    // a picture that the AI may not get any more by the time the run comes: failed, not sent
    host.ai.mediaAllowed = false;
    await host.tick();
    assert.equal(host.aiRequests.length, 0);
    assert.deepEqual([(await c.as(ANNA)('GET', `nodes/${pic.id}/insight`)).json.status, (await c.as(ANNA)('GET', `nodes/${pic.id}/insight`)).json.error], ['failed', 'media_disabled']);
  });
});

test('costs: at most three a run; a failure stays failed until asked; GateControl\'s limits keep the queue', async () => {
  let fail = null;
  await withHost({ ai: invoiceAi({ onExtract: () => { if (fail) throw Object.assign(new Error(fail), { code: fail }); } }) }, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push((await c.put(ANNA, mine.rootId, `Doc ${i}.pdf`, 'pdf' + i, { mime: 'application/pdf', text: TEXT })).json.node.id);
    assert.equal((await host.tick()).insights.recognised, 3);
    // the rate limit of GateControl: it stays in the queue, nothing failed
    fail = 'ERR_RATE_LIMIT';
    assert.deepEqual((await host.tick()).insights, { recognised: 0, failed: 0, waiting: 1 });
    assert.equal((await a('GET', `nodes/${ids[3]}/insight`)).json.status, 'pending');
    // the provider failed: failed, and not tried again on its own
    fail = 'ERR_AI_PROVIDER';
    assert.equal((await host.tick()).insights.failed, 2);
    const g = (await a('GET', `nodes/${ids[3]}/insight`)).json;
    assert.deepEqual([g.status, g.error], ['failed', 'ai_provider']);
    const before = host.aiRequests.length;
    fail = null;
    await host.tick();
    assert.equal(host.aiRequests.length, before);
    // asked again: once more
    assert.equal((await a('POST', `nodes/${ids[3]}/insight`)).json.status, 'pending');
    await a('POST', `nodes/${ids[3]}/insight`);
    await host.tick();
    assert.equal(host.aiRequests.length, before + 1);
    assert.equal((await a('GET', `nodes/${ids[3]}/insight`)).json.status, 'ready');
    // the budget is used up: GateControl refuses, failed with ai_budget
    host.ai.budgetLeftCents = 0;
    await a('POST', `nodes/${ids[4]}/insight`);
    await host.tick();
    assert.equal((await a('GET', `nodes/${ids[4]}/insight`)).json.error, 'ai_budget');
  });
});

test('deadlines: a reminder of my own N days before, once; the list; replaced by a new recognition, kept when the same', async () => {
  await withHost({ ai: invoiceAi() }, async (host, c) => {
    const a = c.as(ANNA);
    const fam = await c.area(ANNA, 'family');
    const f = (await c.put(ANNA, fam.rootId, 'Rechnung.pdf', 'pdf', { mime: 'application/pdf', text: TEXT })).json.node;
    await host.tick();
    const dl = (await a('GET', `nodes/${f.id}/insight`)).json.deadlines[0];
    assert.equal((await a('POST', `deadlines/${dl.id}/remind`, { daysBefore: 91 })).status, 400);
    const r = await a('POST', `deadlines/${dl.id}/remind`, { daysBefore: 3 });
    assert.deepEqual(r.json.deadline.reminder, { at: '2026-11-07T07:00:00.000Z', daysBefore: 3, sent: false });
    // Marc sees the deadline without a reminder of his; Bob not at all
    assert.equal((await c.as(MARC)('GET', `nodes/${f.id}/insight`)).json.deadlines[0].reminder, null);
    assert.equal((await c.as(BOB)('POST', `deadlines/${dl.id}/remind`, { daysBefore: 1 })).status, 404);
    // the list of the deadlines I read, with the file
    const list = (await a('GET', 'deadlines')).json.deadlines;
    assert.deepEqual(list.map((x) => [x.id, x.date, x.node.id, x.node.name]), [[dl.id, '2026-11-10', f.id, 'Rechnung.pdf']]);
    assert.deepEqual((await a('GET', 'deadlines', null, { from: '2026-11-11' })).json.deadlines, []);
    assert.equal((await a('GET', 'deadlines', null, { from: '11.11.2026' })).status, 400);
    assert.deepEqual((await c.as(MARC)('GET', 'deadlines')).json.deadlines.map((x) => x.id), [dl.id]);
    // a new recognition with the same deadline keeps the reminder
    await a('POST', `nodes/${f.id}/insight`);
    await host.tick();
    assert.equal((await a('GET', `nodes/${f.id}/insight`)).json.deadlines[0].reminder.daysBefore, 3);
    // not yet
    c.clock.add(11 * DAY);
    await host.tick();
    assert.equal(c.pushes().filter((n) => n.topic === 'deadline').length, 0);
    c.clock.add(DAY);
    await host.tick();
    await host.tick();
    const sent = c.pushes().filter((n) => n.topic === 'deadline');
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].users, [ANNA.id]);
    assert.equal(sent[0].title, 'Zahlungsfrist am 10.11.2026');
    assert.equal(sent[0].body, 'Rechnung bezahlen – Rechnung.pdf');
    assert.deepEqual(sent[0].data.drive, { node: f.id, area: fam.id, deadline: dl.id });
    assert.equal(sent[0].data.actions[0].target, `/portal?drive=${f.id}#plg-gatecontrol-drive`);
    assert.equal((await a('GET', `nodes/${f.id}/insight`)).json.deadlines[0].reminder.sent, true);
    // removed; a past deadline takes none
    assert.equal((await a('DELETE', `deadlines/${dl.id}/remind`)).json.deadline.reminder, null);
    c.clock.add(3 * DAY);
    assert.equal((await a('POST', `deadlines/${dl.id}/remind`, { daysBefore: 0 })).status, 200, 'the day itself still');
    c.clock.add(DAY);
    assert.equal((await a('POST', `deadlines/${dl.id}/remind`, { daysBefore: 0 })).json.field, 'date');
  });
});

test('deadlines: no reminder for a file in the trash or one the person no longer reads; purge removes everything', async () => {
  await withHost({ ai: invoiceAi() }, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const f = (await c.put(ANNA, mine.rootId, 'Rechnung.pdf', 'pdf', { mime: 'application/pdf', text: TEXT })).json.node;
    await host.tick();
    const dl = (await a('GET', `nodes/${f.id}/insight`)).json.deadlines[0];
    await a('POST', `deadlines/${dl.id}/remind`, { daysBefore: 1 });
    await a('DELETE', `nodes/${f.id}`);
    c.clock.add(20 * DAY);
    await host.tick();
    assert.equal(c.pushes().filter((n) => n.topic === 'deadline').length, 0);
    assert.equal((await a('DELETE', `trash/${f.id}`)).status, 200);
    for (const tbl of ['doc_insights', 'doc_deadlines', 'doc_reminders']) {
      assert.equal((await host.gc.db.get(`SELECT COUNT(*) AS n FROM ${tbl}`)).row.n, 0, tbl);
    }
  });
});
