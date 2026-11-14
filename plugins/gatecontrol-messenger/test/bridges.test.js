'use strict';

// 1.12.0: bridges to other messengers, first stage — against the mock host's stand-in for GateControl's gc.bridges
// and for the bridge behind it (tools/testing/mock-bridges.js; no WhatsApp, no Matrix). The administrator's card
// (hidden unless GateControl offers bridges), a person's own link by pairing code and by QR code, the states
// linked / logged out, the notes that must be confirmed first, and the children's lock with the parents' yes.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, app, portal, ADMIN, ANNA, MARC, LENA, OMA } = require('./helpers');
const ui = require('../server/ui');
const texts = require('../server/texts.json');

const ON = { enabled: true, networks: { whatsapp: true }, running: true };
/** Familie offering family_roles: parents Anna and Marc, child Lena. */
const familie = () => ({ plugin: 'gatecontrol-familie', provides: ['family_roles'], service: () => ({ ok: true, parents: [ANNA.id, MARC.id], children: [LENA.id] }) });

async function link(c, host, user, flow = 'phone') {
  const me = c.as(user);
  assert.equal((await me('POST', 'bridges/whatsapp/consent', { accept: true })).status, 200);
  let r = await me('POST', 'bridges/whatsapp/login', { flow });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  let login = r.json.login;
  if (flow === 'phone') {
    r = await me('POST', `bridges/whatsapp/login/${login.processId}/${login.step.id}`, { input: { phone_number: '+4915120000000' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    login = r.json.login;
  }
  host.bridges.confirm(login.processId);
  r = await me('POST', `bridges/whatsapp/login/${login.processId}/${login.step.id}`, {});
  assert.equal(r.json.login.step.type, 'complete', JSON.stringify(r.json));
  return r.json.login.step.loginId;
}

test('an older GateControl (no gc.bridges): nothing is offered, nothing breaks', async () => {
  await withHost({}, async (host, c) => {
    const a = (await c.admin('GET', 'bridges')).json.bridges;
    assert.equal(a.available, false);
    assert.equal(a.reason, 'no_host');
    assert.equal((await c.admin('PUT', 'bridges', { enabled: true })).json.code, 'bridge_off');
    assert.deepEqual((await c.as(ANNA)('GET', 'bridges')).json.bridges, { available: false, networks: [] });
    assert.equal((await c.as(ANNA)('POST', 'bridges/whatsapp/login', { flow: 'qr' })).json.code, 'bridge_off');
    assert.equal((await c.as(ANNA)('GET', 'me')).json.features.bridges, false, 'the apps are told nothing yet');
  });
});

test('GateControl without the preview: the card stays hidden', async () => {
  await withHost({ bridges: { preview: false } }, async (host, c) => {
    const a = (await c.admin('GET', 'bridges')).json.bridges;
    assert.equal(a.available, false);
    assert.equal(a.reason, 'preview_off');
    assert.equal((await c.admin('PUT', 'bridges', { enabled: true })).json.code, 'bridge_off');
    assert.deepEqual((await c.as(ANNA)('GET', 'bridges')).json.bridges, { available: false, networks: [] });
  });
});

test('administrators switch the bridges — off by default; nobody else may', async () => {
  await withHost({ bridges: true }, async (host, c) => {
    let b = (await c.admin('GET', 'bridges')).json.bridges;
    assert.equal(b.available, true);
    assert.equal(b.enabled, false);
    assert.equal(b.location, 'server');
    assert.deepEqual(b.locations.map((l) => l.kind), ['server']);
    assert.deepEqual(b.networks, [{ id: 'whatsapp', enabled: false, state: 'off', version: null, memMb: null, limitMb: null, linked: 0 }]);
    assert.equal(b.history.enabled, false);
    // while it is off, people are offered nothing
    assert.deepEqual((await c.as(ANNA)('GET', 'bridges')).json.bridges, { available: false, networks: [] });

    for (const u of [ANNA, app(ADMIN), portal(ADMIN)]) assert.equal((await c.call(u, 'PUT', 'admin/bridges', { enabled: true })).status, 403);
    for (const bad of [null, {}, { enabled: 'yes' }, { networks: { signal: true } }, { networks: { whatsapp: 1 } }, { networks: [] }]) {
      assert.equal((await c.admin('PUT', 'bridges', bad)).json.code, 'invalid', JSON.stringify(bad));
    }
    assert.equal(host.bridges.state.enabled, false);

    b = (await c.admin('PUT', 'bridges', { enabled: true, networks: { whatsapp: true } })).json.bridges;
    assert.equal(b.enabled, true);
    assert.equal(b.networks[0].state, 'starting');
    assert.deepEqual(host.bridges.state.log.at(-1), { op: 'configure', by: ADMIN.id, enabled: true, networks: { whatsapp: true } });

    host.bridges.setHost({ state: 'failed', error: 'compose_missing' });
    b = (await c.admin('GET', 'bridges')).json.bridges;
    assert.equal(b.networks[0].state, 'failed');
    assert.equal(b.host.error, 'compose_missing');

    host.bridges.setHost({ state: 'running', error: null, running: true, memMb: 93 });
    b = (await c.admin('GET', 'bridges')).json.bridges;
    assert.deepEqual(b.networks[0], { id: 'whatsapp', enabled: true, state: 'running', version: 'v26.10', memMb: 93, limitMb: 512, linked: 0 });
  });
});

test('a person links their own WhatsApp with the pairing code — notes first', async () => {
  await withHost({ bridges: ON }, async (host, c) => {
    const anna = c.as(ANNA);
    let mine = (await anna('GET', 'bridges')).json.bridges;
    assert.deepEqual(mine, { available: true, networks: [{ id: 'whatsapp', state: 'running', allowed: true, lock: null, consent: null, logins: [] }] });

    // not before the notes were confirmed
    assert.equal((await anna('POST', 'bridges/whatsapp/login', { flow: 'phone' })).json.code, 'consent_required');
    assert.equal((await anna('POST', 'bridges/whatsapp/consent', {})).json.code, 'invalid');
    const ok = await anna('POST', 'bridges/whatsapp/consent', { accept: true });
    assert.match(ok.json.consent, /^\d{4}-/);

    assert.equal((await anna('POST', 'bridges/whatsapp/login', { flow: 'sms' })).json.code, 'invalid');
    let r = await anna('POST', 'bridges/whatsapp/login', { flow: 'phone' });
    assert.deepEqual(r.json.login.step, { id: 'fi.mau.whatsapp.login.phone', type: 'user_input', fields: [{ id: 'phone_number', type: 'phone_number', optional: false }] });
    const pid = r.json.login.processId;

    r = await anna('POST', `bridges/whatsapp/login/${pid}/${r.json.login.step.id}`, { input: { phone_number: 'abc' } });
    assert.equal(r.status, 502);
    assert.equal(r.json.code, 'bridge_failed');
    assert.equal(r.json.reason, 'm_bad_json');

    r = await anna('POST', `bridges/whatsapp/login/${pid}/fi.mau.whatsapp.login.phone`, { input: { phone_number: '+4915120000000' } });
    assert.deepEqual(r.json.login.step, { id: 'fi.mau.whatsapp.login.pairing_code', type: 'display_and_wait', display: { type: 'code', data: 'K7P2-M4X9' } });
    const sid = r.json.login.step.id;

    // the phone has not confirmed yet → ask again
    r = await anna('POST', `bridges/whatsapp/login/${pid}/${sid}`, {});
    assert.deepEqual(r.json.login, { processId: pid, waiting: true });
    // nobody else can continue it
    assert.equal((await c.as(MARC)('POST', 'bridges/whatsapp/consent', { accept: true })).status, 200);
    assert.equal((await c.as(MARC)('POST', `bridges/whatsapp/login/${pid}/${sid}`, {})).json.code, 'not_found');

    host.bridges.confirm(pid);
    r = await anna('POST', `bridges/whatsapp/login/${pid}/${sid}`, {});
    assert.equal(r.json.login.step.type, 'complete');
    const loginId = r.json.login.step.loginId;

    mine = (await anna('GET', 'bridges')).json.bridges;
    assert.equal(mine.networks[0].logins.length, 1);
    assert.equal(mine.networks[0].logins[0].id, loginId);
    assert.equal(mine.networks[0].logins[0].state, 'connected');
    assert.equal(mine.networks[0].logins[0].name, '+4915120000000', 'their own number, shown to themselves');
    assert.deepEqual((await c.as(MARC)('GET', 'bridges')).json.bridges.networks[0].logins, [], 'nobody else sees it');

    // the administrator sees a count — no number, no login id, no name
    const adminJson = JSON.stringify((await c.admin('GET', 'bridges')).json);
    assert.equal(JSON.parse(adminJson).bridges.networks[0].linked, 1);
    assert.ok(!adminJson.includes('4915120000000') && !adminJson.includes(loginId) && !adminJson.includes('Anna'));
    // and the plugin keeps no number
    const rows = (await host.gc.db.query('SELECT * FROM bridge_links')).rows;
    assert.equal(rows.length, 1);
    assert.ok(!JSON.stringify(rows).includes('4915120000000'));
  });
});

test('QR code; logged out by WhatsApp; unlinking; a cancelled and an expired login', async () => {
  await withHost({ bridges: ON }, async (host, c) => {
    const marc = c.as(MARC);
    await marc('POST', 'bridges/whatsapp/consent', { accept: true });
    let r = await marc('POST', 'bridges/whatsapp/login', { flow: 'qr' });
    assert.equal(r.json.login.step.type, 'display_and_wait');
    assert.equal(r.json.login.step.display.type, 'qr');
    assert.ok(r.json.login.step.display.data.length > 10);
    const first = r.json.login;
    host.bridges.expire(first.processId);
    r = await marc('POST', `bridges/whatsapp/login/${first.processId}/${first.step.id}`, {});
    assert.equal(r.json.code, 'bridge_failed');
    assert.equal(r.json.reason, 'fi_mau_whatsapp_login_timeout');

    r = await marc('POST', 'bridges/whatsapp/login', { flow: 'qr' });
    assert.deepEqual((await marc('DELETE', `bridges/whatsapp/login/${r.json.login.processId}`)).json.cancelled, true);
    assert.equal((await marc('DELETE', `bridges/whatsapp/login/${r.json.login.processId}`)).json.code, 'not_found');

    const loginId = await link(c, host, MARC, 'qr');
    assert.equal((await c.admin('GET', 'bridges')).json.bridges.networks[0].linked, 1);

    // WhatsApp dropped the linked device (phone offline for too long): the state says so, the count drops
    host.bridges.logOut(MARC.id, loginId);
    const mine = (await marc('GET', 'bridges')).json.bridges;
    assert.equal(mine.networks[0].logins[0].state, 'logged_out');
    assert.equal((await c.admin('GET', 'bridges')).json.bridges.networks[0].linked, 0);

    // somebody else cannot unlink it; the person can
    assert.equal((await c.as(ANNA)('DELETE', `bridges/whatsapp/logins/${loginId}`)).json.code, 'not_found');
    assert.deepEqual((await marc('DELETE', `bridges/whatsapp/logins/${loginId}`)).json.unlinked, true);
    assert.deepEqual((await marc('GET', 'bridges')).json.bridges.networks[0].logins, []);
    assert.deepEqual((await host.gc.db.query('SELECT * FROM bridge_links')).rows, []);

    // a step GateControl does not offer (passkey) is named
    host.bridges.oddStep = 'webauthn';
    r = await marc('POST', 'bridges/whatsapp/login', { flow: 'qr' });
    assert.equal(r.json.code, 'bridge_unsupported');
    // ids are checked before anything reaches GateControl
    assert.equal((await marc('POST', 'bridges/whatsapp/login/a%2F..%2Fb/step', {})).json.code, 'invalid');
    assert.equal((await marc('POST', 'bridges/signal/login', { flow: 'qr' })).status, 404);
  });
});

test('the bridge does not answer: the last known state, marked', async () => {
  await withHost({ bridges: ON }, async (host, c) => {
    const loginId = await link(c, host, ANNA);
    host.bridges.setHost({ running: false });
    let mine = (await c.as(ANNA)('GET', 'bridges')).json.bridges;
    assert.equal(mine.networks[0].state, 'starting', 'GateControl reports it as not up');
    // GateControl says running, but the bridge itself is gone
    host.bridges.setHost({ running: true, bridgeDown: true });
    mine = (await c.as(ANNA)('GET', 'bridges')).json.bridges;
    assert.equal(mine.networks[0].state, 'unreachable');
    assert.deepEqual(mine.networks[0].logins.map((l) => [l.id, l.state, l.name]), [[loginId, 'connected', '']]);
    assert.equal((await c.as(ANNA)('POST', 'bridges/whatsapp/login', { flow: 'qr' })).status, 503);
  });
});

test('children: locked until a parent allows it, per child and network', async () => {
  await withHost({ bridges: ON, services: [familie()] }, async (host, c) => {
    const lena = c.as(LENA);
    let mine = (await lena('GET', 'bridges')).json.bridges;
    assert.equal(mine.networks[0].allowed, false);
    assert.equal(mine.networks[0].lock, 'child');
    assert.equal((await lena('POST', 'bridges/whatsapp/consent', { accept: true })).json.code, 'bridge_locked');
    assert.equal((await lena('POST', 'bridges/whatsapp/login', { flow: 'qr' })).json.code, 'bridge_locked');

    // only parents see and switch it — not the child, not a grandmother, not an administrator who is no parent
    for (const u of [LENA, OMA, ADMIN]) {
      assert.equal((await c.as(u)('GET', 'bridges/children')).status, 403);
      assert.equal((await c.as(u)('PUT', `bridges/children/${LENA.id}`, { networks: { whatsapp: true } })).status, 403);
    }
    assert.deepEqual((await c.as(ANNA)('GET', 'bridges/children')).json.children, [{ userId: LENA.id, networks: { whatsapp: false } }]);
    assert.equal((await c.as(ANNA)('PUT', `bridges/children/${MARC.id}`, { networks: { whatsapp: true } })).status, 404, 'a parent is no child');
    for (const bad of [{}, { networks: {} }, { networks: { signal: true } }, { networks: { whatsapp: 'yes' } }]) {
      assert.equal((await c.as(ANNA)('PUT', `bridges/children/${LENA.id}`, bad)).json.code, 'invalid');
    }

    const r = await c.as(ANNA)('PUT', `bridges/children/${LENA.id}`, { networks: { whatsapp: true } });
    assert.deepEqual(r.json.child, { userId: LENA.id, networks: { whatsapp: true } });
    mine = (await lena('GET', 'bridges')).json.bridges;
    assert.equal(mine.networks[0].allowed, true);
    const loginId = await link(c, host, LENA, 'qr');

    // the other parent takes it back: no new link — unlinking her own account still works
    await c.as(MARC)('PUT', `bridges/children/${LENA.id}`, { networks: { whatsapp: false } });
    assert.equal((await lena('POST', 'bridges/whatsapp/login', { flow: 'qr' })).json.code, 'bridge_locked');
    mine = (await lena('GET', 'bridges')).json.bridges;
    assert.equal(mine.networks[0].lock, 'child');
    assert.equal(mine.networks[0].logins.length, 1);
    assert.equal((await lena('DELETE', `bridges/whatsapp/logins/${loginId}`)).json.unlinked, true);

    // adults are not affected
    assert.equal((await c.as(OMA)('GET', 'bridges')).json.bridges.networks[0].allowed, true);
  });
});

test('without Familie nobody is a child', async () => {
  await withHost({ bridges: ON }, async (host, c) => {
    assert.equal((await c.as(LENA)('GET', 'bridges')).json.bridges.networks[0].allowed, true);
    assert.equal((await c.as(ANNA)('GET', 'bridges/children')).status, 403);
  });
});

test('kiosk devices and signed-out viewers get nothing', async () => {
  await withHost({ bridges: ON }, async (host, c) => {
    assert.equal((await c.call(portal(ANNA, false), 'GET', 'bridges')).json.code, 'login_required');
    assert.equal((await c.call({ ...app(ANNA), kiosk: true }, 'GET', 'bridges')).status, 403);
  });
});

test('the admin card: hidden by default, texts in both languages', () => {
  for (const lang of ['de', 'en']) {
    const html = ui.render({ view: 'page', page: 'overview', lang }, (l, k) => texts[l][k] || k);
    assert.match(html, /<section class="ms-card" aria-labelledby="ms-h-br" id="ms-br" hidden>/);
    assert.ok(!/admin\.br_[a-z_]+</.test(html.split('<script>')[0]), 'no unresolved key in the card');
    for (const k of ['admin.br_err_compose', 'admin.br_state_running', 'admin.br_linked_one', 'error.bridge_locked', 'error.consent_required']) assert.ok(texts[lang][k], `${lang} ${k}`);
  }
  assert.deepEqual(Object.keys(texts.de).filter((k) => k.startsWith('admin.br_') || k.startsWith('error.bridge_')).sort(),
    Object.keys(texts.en).filter((k) => k.startsWith('admin.br_') || k.startsWith('error.bridge_')).sort());
});
