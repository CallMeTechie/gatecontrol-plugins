'use strict';

// Deliveries that wait for GateControl's virus check (1.4.1, server/retry.js; the mock host's opts.scan): a hand-over
// (Drive, NAS, the Messenger) that only the running check holds back stays 'pending' with error 'scan_pending' — never
// 'failed' — and goes once the result is in (hook mediaScanned): clean → delivered, quarantined / not checkable and
// blocked / deleted → failed with quarantined / scan_blocked. The background tries a missed one again every 5 minutes
// and gives up after 24 hours (scan_pending).

const test = require('node:test');
const assert = require('node:assert/strict');
const bg = require('../server/bg');
const { withHost, ANNA, MARC, PDF, PNG, MIN, DAY } = require('./helpers');

/** Holds the work after the answer (NAS, Drive) back until the returned function is called. */
function holdBackground(gc) {
  let open = null;
  bg.queue(() => new Promise((r) => { open = r; }), gc);
  return () => open();
}

/** A send to Anna's Drive whose file a re-check takes back into the check before the Drive delivery runs. */
async function waitingDrive(host, c, items) {
  const open = holdBackground(host.gc);
  const r = (await c.as(ANNA, 'anna-phone')('POST', 'sends', { items: items.map((x) => ({ mediaId: x.m, name: x.name })), to: { drive: true } })).json;
  await host.mediaScanned(items[0].m, { state: 'pending' }); // an administrator's "Erneut prüfen"
  open();
  await host.plugin._idle();
  return r;
}

const deliveryOf = async (c, id) => (await c.as(ANNA)('GET', `sends/${id}`)).json.send.deliveries[0];

/** A Messenger that answers send_file with scan_pending while `checking` (its copy of the file is still checked). */
function fakeMessenger() {
  const m = {
    plugin: 'gatecontrol-messenger', provides: ['send_file'], media: { maxBytes: 2147483648, types: ['image/*', 'application/*'], quotaDefault: '10GB' },
    checking: true, sent: [], received: [],
    async service({ payload }) {
      if (m.checking) return { ok: false, code: 'scan_pending' };
      m.sent.push(payload);
      return { ok: true, conversationId: 9 };
    },
  };
  return m;
}

test('Drive: a file still being checked — the delivery waits (pending, scan_pending), nothing handed over; clean → saved', async () => {
  await withHost({ scan: true, drive: true }, async (host, c) => {
    const m = await c.upload(ANNA, PDF, 'application/pdf');
    const r = await waitingDrive(host, c, [{ m, name: 'Zeugnis.pdf' }]);
    let d = await deliveryOf(c, r.id);
    assert.deepEqual([d.status, d.error, d.via, d.files], ['pending', 'scan_pending', null, []], 'waiting, not failed');
    assert.deepEqual([c.drive.saved.length, host.handOvers.length], [0, 0], 'nothing handed over yet');
    // the check ends clean: GateControl's hook → saved now
    await host.mediaScanned(m, { state: 'clean' });
    await host.plugin._idle();
    d = await deliveryOf(c, r.id);
    assert.deepEqual([d.status, d.error, d.via, d.where], ['delivered', null, 'server', ['Meine Dateien › GateDrop › Zeugnis.pdf']]);
    assert.equal(c.drive.saved.length, 1);
    // a later result of the same file changes nothing any more
    await host.mediaScanned(m, { state: 'clean' });
    await host.plugin._idle();
    assert.equal(c.drive.saved.length, 1);
  });
});

test('Drive: the waiting file is quarantined / not checkable / deleted → failed with quarantined / scan_blocked; the other files are saved', async () => {
  await withHost({ scan: true, drive: true }, async (host, c) => {
    const cases = [
      [{ state: 'infected', finding: 'Win.Trojan.Agent-1' }, 'quarantined'],
      [{ state: 'unscannable', blocked: true, finding: 'encrypted' }, 'scan_blocked'],
      [{ state: 'deleted' }, 'quarantined'],
    ];
    for (const [result, code] of cases) {
      const m = await c.upload(ANNA, PDF, 'application/pdf');
      const ok = await c.upload(ANNA, PNG, 'image/png');
      const r = await waitingDrive(host, c, [{ m, name: 'a.pdf' }, { m: ok, name: 'b.png' }]);
      assert.equal((await deliveryOf(c, r.id)).status, 'pending');
      const before = c.drive.saved.length;
      await host.mediaScanned(m, result);
      await host.plugin._idle();
      const d = await deliveryOf(c, r.id);
      assert.deepEqual([d.status, d.error, d.where], ['failed', code, ['Meine Dateien › GateDrop › b.png']], `${result.state} → ${code}`);
      assert.deepEqual(c.drive.saved.slice(before).map((s) => s.payload.path), ['GateDrop/b.png'], 'only the clean file');
    }
  });
});

test('NAS: the delivery waits for the check and goes into the same folder (below the drop folder) afterwards', async () => {
  await withHost({ scan: true, nas: true }, async (host, c) => {
    const m = await c.upload(ANNA, PDF, 'application/pdf');
    const open = holdBackground(host.gc);
    const r = (await c.as(ANNA)('POST', 'sends', { items: [{ mediaId: m, name: 'rechnung.pdf' }], to: { nas: [{ id: c.nas.folderId, path: 'Rechnungen' }] } })).json;
    await host.mediaScanned(m, { state: 'pending' });
    open();
    await host.plugin._idle();
    let d = await deliveryOf(c, r.id);
    assert.deepEqual([d.status, d.error], ['pending', 'scan_pending']);
    assert.equal(c.nas.dsm.state.uploads.length, 0);
    await host.mediaScanned(m, { state: 'clean' });
    await host.plugin._idle();
    d = await deliveryOf(c, r.id);
    assert.deepEqual([d.status, d.error, d.paths], ['delivered', null, ['/Familie/Ablage/Rechnungen/rechnung.pdf']]);
    assert.deepEqual(host.serviceCalls.filter((x) => x.service === 'save_file').map((x) => x.payload.folderId), [c.nas.folderId]);
  });
});

test('person: the Messenger answers scan_pending — the delivery waits (the person sees nothing yet), sent once the result is in', async () => {
  const messenger = fakeMessenger();
  await withHost({ scan: true, services: [messenger] }, async (host, c) => {
    const m = await c.upload(ANNA, PNG, 'image/png');
    const r = (await c.as(ANNA, 'anna-phone')('POST', 'sends', { items: [{ mediaId: m, name: 'foto.png' }], to: { people: [String(MARC.id)] } })).json;
    assert.deepEqual([r.deliveries[0].status, r.deliveries[0].error], ['pending', 'scan_pending']);
    assert.equal(messenger.sent.length, 0);
    assert.equal((await c.as(MARC)('GET', 'inbox', null, { kind: 'received' })).json.items.length, 0, 'not in the person\'s inbox');
    assert.equal(c.pushes().length, 0, 'no push');
    messenger.checking = false;
    await host.mediaScanned(m, { state: 'clean' });
    await host.plugin._idle();
    const d = await deliveryOf(c, r.id);
    assert.deepEqual([d.status, d.error, d.conversationId], ['delivered', null, 9]);
    assert.deepEqual([messenger.sent.length, messenger.sent[0].names, messenger.sent[0].user], [1, ['foto.png'], ANNA.id]);
  });
});

test('background: a missed result — tried again after 5 minutes; still checked after 24 hours → failed with scan_pending', async () => {
  await withHost({ scan: true, drive: true }, async (host, c) => {
    const a = await c.upload(ANNA, PDF, 'application/pdf');
    const ra = await waitingDrive(host, c, [{ m: a, name: 'a.pdf' }]);
    const b = await c.upload(ANNA, PDF, 'application/pdf');
    const rb = await waitingDrive(host, c, [{ m: b, name: 'b.pdf' }]);
    // a's check ends, but the hook did not reach GateDrop
    host.media.get(a).scan = { state: 'clean', blocked: false, finding: null, at: new Date().toISOString() };
    assert.equal((await host.tick()).scanRetried, 0, 'not within 5 minutes');
    c.clock.add(5 * MIN + 1000);
    assert.equal((await host.tick()).scanRetried, 2);
    assert.deepEqual([(await deliveryOf(c, ra.id)).status, (await deliveryOf(c, rb.id)).status], ['delivered', 'pending']);
    assert.equal((await deliveryOf(c, rb.id)).error, 'scan_pending');
    c.clock.add(DAY);
    assert.equal((await host.tick()).scanRetried, 1);
    const d = await deliveryOf(c, rb.id);
    assert.deepEqual([d.status, d.error], ['failed', 'scan_pending'], 'given up');
    assert.equal(c.drive.saved.length, 1, 'only a');
    assert.equal((await host.tick()).scanRetried, 0);
  });
});

test('portal: a waiting delivery reads „wartet auf die Virenprüfung“', () => {
  const texts = require('../server/texts.json');
  assert.equal(texts.de['status.scan_wait'], 'wartet auf die Virenprüfung');
  assert.equal(texts.en['status.scan_wait'], 'waiting for the virus check');
  assert.match(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'ui', 'portal.js'), 'utf8'), /d\.error === 'scan_pending'\) return T\('status\.scan_wait'\)/);
});
