'use strict';

// The mock host's mirror of GateControl 1.236.0 gc.print (src/services/homePrint.js, hostApi.js printCall, the child
// bootstrap's makePrint): only with permissions.print; submit checks the person, the device, the plugin's media and the
// printer's formats; scans deliver unclaimed media of the person; pdf makes one file of the pages.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHost } = require('../testing/mock-host');

const USERS = [{ id: 1, name: 'admin', role: 'admin' }, { id: 2, name: 'Anna', role: 'user' }];
const DEV = [
  { id: 'u:' + 'a'.repeat(32), name: 'HP', online: true, gatewayOnline: true, printer: { color: true, duplex: true, formats: ['application/pdf', 'image/jpeg'], copiesMax: 99 }, scanner: { platen: true, feeder: false } },
  { id: 'h:' + 'b'.repeat(16), name: 'Brother', online: true, gatewayOnline: false, printer: { color: false, duplex: false, formats: ['image/urf'], copiesMax: 1 }, scanner: null },
];

const CODE = `
module.exports = {
  async request(req, gc) {
    const b = req.body || {};
    if (req.path === '/has') return { json: { print: !!gc.print } };
    try { return { json: { ok: true, result: await gc.print[b.op](...(b.args || [])) } }; } catch (e) { return { json: { ok: false, code: e.code } }; }
  },
};`;

function plugin(perms) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-plugin-'));
  fs.mkdirSync(path.join(dir, 'server'));
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
    id: 'pr-test', name: 'P', version: '1.0.0', entry: 'server/index.js', permissions: perms,
    media: { maxBytes: 1048576, types: ['application/pdf', 'image/jpeg', 'text/plain'], quotaDefault: '10MB' },
  }));
  fs.writeFileSync(path.join(dir, 'server', 'index.js'), CODE);
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const call = (host, op, ...args) => host.request({ method: 'POST', path: '/x', body: { op, args } }).then((r) => r.json);

test('gc.print: only with permissions.print, from GateControl 1.236.0 or with opts.print', async () => {
  for (const [perms, opts, want] of [[{ print: true }, { gatecontrol: '1.236.0' }, true], [{ print: true }, { gatecontrol: '1.231.0' }, false], [{}, { gatecontrol: '1.236.0' }, false], [{ print: true }, { print: { devices: [] } }, true]]) {
    const p = plugin(perms);
    const host = await createHost(p.dir, { users: USERS, ...opts });
    try {
      await host.start();
      assert.equal((await host.request({ path: '/has' })).json.print, want, JSON.stringify([perms, opts]));
    } finally { await host.close(); p.done(); }
  }
  const p = plugin({ print: 'yes' });
  await assert.rejects(createHost(p.dir, { users: USERS, gatecontrol: '1.236.0' }), { code: 'ERR_INVALID' });
  p.done();
});

test('gc.print: submit checks like the host; jobs, cancel; scans and pdf', async () => {
  const p = plugin({ print: true });
  const host = await createHost(p.dir, { users: USERS, print: { devices: DEV } });
  try {
    await host.start();
    const up = async (data, mime) => (await host.upload({ id: 2, name: 'Anna', role: 'user', portal: true, loggedIn: true }, Buffer.from(data), mime)).body.mediaId;
    const pdf = await up('%PDF-1.4 << /Type /Page >> << /Type /Page >>', 'application/pdf');
    const txt = await up('hallo', 'text/plain');
    let r = await call(host, 'submit', { deviceId: DEV[0].id, mediaId: pdf, user: 2, copies: 2, color: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual([r.result.state, r.result.pages, r.result.copies, r.result.color], ['queued', 2, 2, true]);
    assert.equal((await call(host, 'submit', { deviceId: DEV[0].id, mediaId: txt, user: 2 })).code, 'ERR_PRINT_FORMAT');
    assert.equal((await call(host, 'submit', { deviceId: DEV[1].id, mediaId: pdf, user: 2 })).code, 'ERR_PRINT_OFFLINE');
    assert.equal((await call(host, 'submit', { deviceId: DEV[0].id, mediaId: pdf, user: 9 })).code, 'ERR_NOT_FOUND');
    assert.equal((await call(host, 'submit', { deviceId: DEV[0].id, mediaId: pdf, user: 2, copies: 0 })).code, 'ERR_INVALID');
    assert.deepEqual((await call(host, 'pages', { mediaId: pdf })).result, { pages: 2, format: 'application/pdf' });
    const id = r.result.id;
    host.printJob(id, { state: 'waiting', error: 'printer_offline' });
    assert.equal((await call(host, 'job', id)).result.error, 'printer_offline');
    assert.deepEqual((await call(host, 'cancel', id)).result, { canceled: true, state: 'canceled' });
    assert.equal((await call(host, 'jobs', {})).result.length, 1);
    r = await call(host, 'scan', { deviceId: DEV[0].id, user: 2 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal((await call(host, 'scan', { deviceId: DEV[0].id, user: 2 })).code, 'ERR_PRINT_BUSY');
    const s = host.printScanPages(r.result.scanId, [{ data: 'p1' }, { data: 'p2' }]);
    assert.equal(s.pages.length, 2);
    const st = (await call(host, 'scanStatus', r.result.scanId)).result;
    assert.deepEqual([st.state, st.pages.length], ['done', 2]);
    const doc = (await call(host, 'pdf', { pages: st.pages.map((x) => x.mediaId), user: 2, name: 'Scan' })).result;
    assert.deepEqual([doc.pages, doc.name], [2, 'Scan.pdf']);
  } finally { await host.close(); p.done(); }
});
