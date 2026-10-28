'use strict';

// Office in the browser (1.9.0, office.js): the discovery through the home target "office", the feature, opening a
// document (a public endpoint of GateControl ≥ 1.211.0 with a form to the editor), the WOPI host — CheckFileInfo,
// GetFile, PutFile as a new version, the locks, read-only people, the proof keys — and what it refuses (vault files,
// other files, an older GateControl).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const office = require('../server/office');
const { withHost, ANNA, MARC, LENA } = require('./helpers');

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });
const MOD = Buffer.from(jwk.n, 'base64url').toString('base64');
const EXP = Buffer.from(jwk.e, 'base64url').toString('base64');

function discovery({ proof = false } = {}) {
  return `<?xml version="1.0" encoding="utf-8"?>
<wopi-discovery><net-zone name="external-http">
<app name="writer" favIconUrl="https://office.example.de/browser/x/images/x-office-document.svg">
<action default="true" ext="docx" name="edit" urlsrc="https://office.internal:9980/browser/abc/cool.html?"/>
<action ext="odt" name="edit" urlsrc="https://office.internal:9980/browser/abc/cool.html?"/>
</app>
<app name="calc"><action ext="xlsx" name="edit" urlsrc="https://office.internal:9980/browser/abc/cool.html?"/></app>
<app name="Capabilities"><action ext="" name="getinfo" urlsrc="https://office.internal:9980/hosting/capabilities"/></app>
</net-zone>${proof ? `<proof-key value="x" modulus="${MOD}" exponent="${EXP}" oldvalue="x" oldmodulus="${MOD}" oldexponent="${EXP}"/>` : ''}</wopi-discovery>`;
}

function opts(o = {}) {
  return {
    gatecontrol: o.gatecontrol || '1.211.0',
    settings: { office_url: 'https://office.example.de', ...(o.settings || {}) },
    targets: { office: [{ fetch: async (p) => (p === '/hosting/discovery' ? { status: 200, body: discovery(o) } : { status: 404, body: '' }) }] },
  };
}

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const tokenOf = (url) => new URL(url).searchParams.get('access_token');
const pathOf = (url) => new URL(url).pathname.replace(/^\/plugin-public\/gatecontrol-drive\//, '');

/** Open file `id` as `call` → the WOPI token and WOPISrc of the editor's form. */
async function open(host, call, id) {
  const r = await call('POST', `nodes/${id}/office`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const page = await host.publicRequest({ method: 'GET', path: pathOf(r.json.url), query: { access_token: tokenOf(r.json.url) } });
  assert.ok(page.form, JSON.stringify(page));
  const action = new URL(page.form.action);
  return { mode: r.json.mode, action, token: page.form.fields.access_token, ttl: Number(page.form.fields.access_token_ttl), src: action.searchParams.get('WOPISrc') };
}
const wopi = (host, o, method, sub = '', headers = {}, body = null) => host.publicRequest({ method, path: pathOf(o.src) + sub, query: { access_token: o.token }, headers, body });

test('discovery, the feature, opening: a form to the editor with WOPISrc and a token bound to the file', async () => {
  await withHost(opts(), async (host, c) => {
    const a = c.as(ANNA);
    const me = await a('GET', 'me');
    assert.ok(me.json.features.includes('office'));
    assert.ok(me.json.features.includes('vault'));
    const mine = await c.area(ANNA, 'mine');
    const f = (await c.put(ANNA, mine.rootId, 'Brief.docx', 'PK-docx', { mime: DOCX })).json.node;
    const o = await open(host, a, f.id);
    assert.equal(o.mode, 'edit');
    // the editor's address of the setting (not the internal one of the discovery), the language
    assert.equal(o.action.origin, 'https://office.example.de');
    assert.equal(o.action.pathname, '/browser/abc/cool.html');
    assert.equal(o.action.searchParams.get('lang'), 'de-DE');
    assert.equal(o.src, `https://gc.example.com/plugin-public/gatecontrol-drive/wopi/files/${f.id}`);
    assert.ok(o.ttl > Date.now() + 3 * 3600000 && o.ttl <= Date.now() + 4 * 3600000 + 1000, 'about 4 hours');
    // the open token opens nothing but its page; the WOPI token nothing but its file
    const other = (await c.put(ANNA, mine.rootId, 'Andere.docx', 'x', { mime: DOCX })).json.node;
    assert.equal((await host.publicRequest({ method: 'GET', path: `wopi/files/${other.id}`, query: { access_token: o.token } })).status, 401);
    assert.equal((await wopi(host, o, 'GET')).status, 200);
    // types the office does not open, folders, a vault's file
    const txt = (await c.put(ANNA, mine.rootId, 'a.txt', 'x')).json.node;
    assert.equal((await a('POST', `nodes/${txt.id}/office`)).json.code, 'office_unavailable');
    assert.equal((await a('POST', `nodes/${mine.rootId}/office`)).status, 400);
  });
});

test('WOPI: CheckFileInfo, GetFile, locks and PutFile — a new version, the type kept', async () => {
  await withHost(opts(), async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const f = (await c.put(ANNA, mine.rootId, 'Brief.docx', 'erste Fassung', { mime: DOCX })).json.node;
    const o = await open(host, a, f.id);
    const info = await wopi(host, o, 'GET');
    assert.equal(info.json.BaseFileName, 'Brief.docx');
    assert.equal(info.json.Size, 13);
    assert.equal(info.json.UserId, String(ANNA.id));
    assert.equal(info.json.UserFriendlyName, 'Anna');
    assert.equal(info.json.UserCanWrite, true);
    assert.equal(info.json.SupportsLocks, true);
    assert.equal(info.json.Version, '1');
    const get = await wopi(host, o, 'GET', '/contents');
    assert.equal(get.body.toString(), 'erste Fassung');
    assert.equal(get.headers['x-wopi-itemversion'], '1');
    // lock, a foreign lock, refresh, get
    assert.equal((await wopi(host, o, 'POST', '', { 'X-WOPI-Override': 'LOCK', 'X-WOPI-Lock': 'L1' })).status, 200);
    const busy = await wopi(host, o, 'POST', '', { 'X-WOPI-Override': 'LOCK', 'X-WOPI-Lock': 'L2' });
    assert.equal(busy.status, 409);
    assert.equal(busy.headers['x-wopi-lock'], 'L1');
    assert.equal((await wopi(host, o, 'POST', '', { 'X-WOPI-Override': 'REFRESH_LOCK', 'X-WOPI-Lock': 'L1' })).status, 200);
    assert.equal((await wopi(host, o, 'POST', '', { 'X-WOPI-Override': 'GET_LOCK' })).headers['x-wopi-lock'], 'L1');
    // PutFile with another lock: refused, the upload dropped
    const before = host.media.size;
    const wrong = await wopi(host, o, 'POST', '/contents', { 'X-WOPI-Override': 'PUT', 'X-WOPI-Lock': 'L2' }, Buffer.from('falsch'));
    assert.equal(wrong.status, 409);
    assert.equal(host.media.size, before);
    // PutFile: a new version; the old one is a version
    const put = await wopi(host, o, 'POST', '/contents', { 'X-WOPI-Override': 'PUT', 'X-WOPI-Lock': 'L1' }, Buffer.from('zweite Fassung'));
    assert.equal(put.status, 200, JSON.stringify(put));
    assert.equal(put.headers['x-wopi-itemversion'], '2');
    const now = (await a('GET', `nodes/${f.id}`)).json.node;
    assert.equal(now.rev, 2);
    assert.equal(now.mime, DOCX, 'the type stays a document');
    assert.equal(now.updatedBy, ANNA.id);
    assert.equal(host.media.get(now.mediaId).data.toString(), 'zweite Fassung');
    assert.equal((await a('GET', `nodes/${f.id}/versions`)).json.versions.length, 1);
    // a stale save of Collabora (another LastModifiedTime): 409 with its code
    const stale = await wopi(host, o, 'POST', '/contents', { 'X-WOPI-Override': 'PUT', 'X-WOPI-Lock': 'L1', 'X-COOL-WOPI-Timestamp': '2001-01-01T00:00:00.000Z' }, Buffer.from('alt'));
    assert.equal(stale.status, 409);
    assert.equal(stale.json.COOLStatusCode, 1010);
    // unlock; other operations are not implemented
    assert.equal((await wopi(host, o, 'POST', '', { 'X-WOPI-Override': 'UNLOCK', 'X-WOPI-Lock': 'L2' })).status, 409);
    assert.equal((await wopi(host, o, 'POST', '', { 'X-WOPI-Override': 'UNLOCK', 'X-WOPI-Lock': 'L1' })).status, 200);
    assert.equal((await wopi(host, o, 'POST', '', { 'X-WOPI-Override': 'PUT_RELATIVE' })).status, 501);
    // the file goes into the trash: the token opens nothing any more
    await a('DELETE', `nodes/${f.id}`);
    assert.equal((await wopi(host, o, 'GET')).status, 404);
  });
});

test('WOPI: a person who only reads gets view, cannot save; a right lost ends the token\'s use', async () => {
  await withHost(opts(), async (host, c) => {
    const child = await c.area(LENA, 'child');
    const f = (await c.put(LENA, child.rootId, 'Aufsatz.docx', 'Text', { mime: DOCX })).json.node;
    const o = await open(host, c.as(MARC), f.id);
    assert.equal(o.mode, 'view');
    const info = await wopi(host, o, 'GET');
    assert.equal(info.json.UserCanWrite, false);
    assert.equal(info.json.ReadOnly, true);
    assert.equal((await wopi(host, o, 'POST', '/contents', { 'X-WOPI-Override': 'PUT' }, Buffer.from('x'))).status, 401);
    assert.equal((await wopi(host, o, 'POST', '', { 'X-WOPI-Override': 'LOCK', 'X-WOPI-Lock': 'M' })).status, 401);
    host.settings.child_parents_view = false;
    assert.equal((await wopi(host, o, 'GET')).status, 404);
  });
});

test('WOPI proof keys: checked when the discovery has them (current or old key, the time)', async () => {
  await withHost(opts({ proof: true }), async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const f = (await c.put(ANNA, mine.rootId, 'Brief.docx', 'x', { mime: DOCX })).json.node;
    const o = await open(host, a, f.id);
    const ticks = (ms) => String(BigInt(ms) * 10000n + 621355968000000000n);
    const url = `https://gc.example.com/plugin-public/gatecontrol-drive/wopi/files/${f.id}?access_token=${encodeURIComponent(o.token)}`;
    const sign = (u, ts) => crypto.sign('RSA-SHA256', office.proofData(o.token, u, ts), privateKey).toString('base64');
    const ts = ticks(Date.now());
    assert.equal((await wopi(host, o, 'GET', '', { 'X-WOPI-TimeStamp': ts, 'X-WOPI-Proof': sign(url, ts), 'X-WOPI-ProofOld': 'AAAA' })).status, 200);
    assert.equal((await wopi(host, o, 'GET', '', { 'X-WOPI-TimeStamp': ts, 'X-WOPI-Proof': 'AAAA', 'X-WOPI-ProofOld': sign(url, ts) })).status, 200, 'the old proof');
    assert.equal((await wopi(host, o, 'GET', '', { 'X-WOPI-TimeStamp': ts, 'X-WOPI-Proof': sign(url + 'x', ts) })).status, 500);
    assert.equal((await wopi(host, o, 'GET')).status, 500, 'no proof');
    const old = ticks(Date.now() - 30 * 60000);
    assert.equal((await wopi(host, o, 'GET', '', { 'X-WOPI-TimeStamp': old, 'X-WOPI-Proof': sign(url, old) })).status, 500, 'older than 20 minutes');
  });
});

test('without an office server, without the home target, on an older GateControl: no office', async () => {
  await withHost(opts({ settings: { office_url: '' } }), async (host, c) => {
    assert.equal((await c.as(ANNA)('GET', 'me')).json.features.includes('office'), false);
  });
  await withHost({ ...opts(), targets: {} }, async (host, c) => {
    assert.equal((await c.as(ANNA)('GET', 'me')).json.features.includes('office'), false);
    const st = await host.plugin.settingsStatus({ lang: 'de' }, host.gc);
    assert.match(st[0].text, /Zugriffsziele/);
  });
  await withHost({ ...opts(), gatecontrol: '1.210.0' }, async (host, c) => {
    const a = c.as(ANNA);
    assert.equal((await a('GET', 'me')).json.features.includes('office'), false);
    const mine = await c.area(ANNA, 'mine');
    const f = (await c.put(ANNA, mine.rootId, 'Brief.docx', 'x', { mime: DOCX })).json.node;
    assert.equal((await a('POST', `nodes/${f.id}/office`)).json.code, 'office_unavailable');
  });
});

test('discovery parsing: urlsrc placeholders, only the document types', () => {
  const d = office.parseDiscovery(`<wopi-discovery><net-zone><app name="Word"><action name="edit" ext="docx" urlsrc="https://o.example/we/wordeditorframe.aspx?&lt;ui=UI_LLCC&amp;&gt;&lt;rs=DC_LLCC&amp;&gt;&lt;showpagestats=PERFSTATS&amp;&gt;"/>
    <action name="view" ext="pdf" urlsrc="https://o.example/x?"/></app></net-zone></wopi-discovery>`);
  assert.deepEqual(Object.keys(d.actions), ['docx']);
  const u = office.actionUrl(d.actions.docx.edit, 'https://gc.example.com/plugin-public/gatecontrol-drive/wopi/files/7', 'en', null);
  assert.equal(u, 'https://o.example/we/wordeditorframe.aspx?ui=en-US&rs=en-US&WOPISrc=https%3A%2F%2Fgc.example.com%2Fplugin-public%2Fgatecontrol-drive%2Fwopi%2Ffiles%2F7&lang=en-US');
  assert.equal(office.parseDiscovery('<html>nope</html>'), null);
});
