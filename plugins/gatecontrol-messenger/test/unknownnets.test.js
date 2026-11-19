'use strict';

// 1.28.2 — a newer GateControl offers a bridge network this Messenger does not know yet (Telegram with Messenger
// 1.23.0): the admin page showed the raw text key „admin.br_net_telegram“. Such a network is left out everywhere —
// the admin card, its probe lines, the portal — and the known ones stay as they are.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { withHost, ANNA } = require('./helpers');
const texts = require('../server/texts.json');

const ON = { enabled: true, networks: { whatsapp: true }, running: true };
const PROBE = {
  at: '2026-11-18T10:00:00.000Z', result: 'ok', windowSeconds: 600, diskMb: 120,
  services: { hs: { running: true, memMb: 60 }, whatsapp: { running: true, memMb: 90 }, 'whatsapp-relay': { running: true, memMb: 10 }, matrix: { running: true, memMb: 30 }, 'matrix-relay': { running: true, memMb: 5 } },
  sockets: { hs: true, whatsapp: true, matrix: true },
};

test('server: a network the plugin does not know is left out of the admin card, its probe and the portal', async () => {
  await withHost({ bridges: ON }, async (host, c) => {
    host.bridges.setHost({ newerNetworks: ['matrix'], probe: PROBE });
    const a = (await c.admin('GET', 'bridges')).json.bridges;
    assert.deepEqual(a.networks.map((n) => n.id), ['whatsapp'], 'only the known network');
    assert.deepEqual(Object.keys(a.host.probe.services).sort(), ['hs', 'whatsapp', 'whatsapp-relay']);
    assert.deepEqual(Object.keys(a.host.probe.sockets).sort(), ['hs', 'whatsapp']);
    assert.equal(a.host.probe.result, 'ok', 'the rest of the probe stays');
    // switching it from here stays refused (as before)
    assert.equal((await c.admin('PUT', 'bridges', { networks: { matrix: false } })).status, 400);
    const put = (await c.admin('PUT', 'bridges', { networks: { whatsapp: true } })).json.bridges;
    assert.deepEqual(put.networks.map((n) => n.id), ['whatsapp']);
    const mine = (await c.as(ANNA)('GET', 'bridges')).json.bridges;
    assert.deepEqual(mine.networks.map((n) => n.id), ['whatsapp']);
    assert.ok(!JSON.stringify(a).includes('matrix') && !JSON.stringify(mine).includes('matrix'), 'nowhere');
  });
});

function pages(lang) {
  const window = { MS_CTX: { texts: texts[lang], lang } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'ui', 'common.js'), 'utf8'), { window, document: {} });
  return window.MS;
}

test('pages: only networks with a name are shown — never a text key', () => {
  for (const lang of ['de', 'en']) {
    const M = pages(lang);
    for (const id of ['whatsapp', 'signal', 'telegram']) assert.equal(M.netKnown(id), true, `${lang} ${id}`);
    for (const id of ['matrix', '', null, undefined, 'constructor']) assert.equal(M.netKnown(id), false, `${lang} ${id}`);
    const b = { available: true, enabled: true, networks: [{ id: 'whatsapp' }, { id: 'matrix' }, null, { id: 'telegram' }] };
    const k = M.knownNets(b);
    assert.deepEqual(k.networks.map((n) => n.id), ['whatsapp', 'telegram']);
    assert.equal(k.available, true, 'the rest stays');
    assert.equal(b.networks.length, 4, 'the answer itself is not changed');
    const same = { available: true, networks: [{ id: 'signal' }] };
    assert.equal(M.knownNets(same), same, 'nothing to leave out: the same object');
    assert.equal(M.knownNets(null), null);
    assert.deepEqual(M.knownNets({ available: false }), { available: false });
  }
});

test('pages: the lists take the bridges answer through knownNets, the probe lines through netKnown', () => {
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'ui', f), 'utf8');
  assert.match(src('overview.js'), /function renderBr\(b\) \{\n {4}b = M\.knownNets\(b\);/);
  assert.match(src('overview.js'), /Object\.keys\(p\.services \|\| \{\}\)\.filter\(known\)/);
  assert.equal((src('bridges.js').match(/M\.knownNets\(r\.bridges \|\| \{\}\)/g) || []).length, 2);
  assert.match(src('portal.js'), /var b = M\.knownNets\(r\.bridges \|\| \{\}\);\n {10}\(b\.networks \|\| \[\]\)\.filter\(function \(n\) \{ return n\.newChat/);
});
