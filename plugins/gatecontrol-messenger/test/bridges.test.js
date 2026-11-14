'use strict';

// 1.12.0: bridges to other messengers, first stage — against the mock host's stand-in for GateControl's gc.bridges
// and for the bridge behind it (tools/testing/mock-bridges.js; no WhatsApp, no Matrix). The administrator's card
// (hidden unless GateControl offers bridges), a person's own link by pairing code and by QR code, the states
// linked / logged out, the notes that must be confirmed first, and the children's lock with the parents' yes.
// 1.13.0: the portal page „Verknüpfte Dienste“ (offered only while a bridge is switched on; a QR step carries the
// code's modules), „outdated“ and the probe on the admin card, the services for the Familie page, and taking a
// child's permission back — which also ends the child's link.

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
    assert.deepEqual(b.networks, [{ id: 'whatsapp', enabled: false, state: 'off', version: null, memMb: null, limitMb: null, outdated: false, wantVersion: '0.2610.0', linked: 0 }]);
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
    assert.deepEqual(b.networks[0], { id: 'whatsapp', enabled: true, state: 'running', version: '0.2610.0', memMb: 93, limitMb: 512, outdated: false, wantVersion: '0.2610.0', linked: 0 });
  });
});

test('a person links their own WhatsApp with the pairing code — notes first', async () => {
  await withHost({ bridges: ON }, async (host, c) => {
    const anna = c.as(ANNA);
    let mine = (await anna('GET', 'bridges')).json.bridges;
    assert.deepEqual(mine, { available: true, location: 'server', networks: [{ id: 'whatsapp', state: 'running', allowed: true, lock: null, consent: null, outdated: false, version: '0.2610.0', wantVersion: '0.2610.0', logins: [] }] });

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
    assert.deepEqual((await c.as(ANNA)('GET', 'bridges/children')).json.children, [{ userId: LENA.id, networks: { whatsapp: false }, linked: { whatsapp: false } }]);
    assert.equal((await c.as(ANNA)('PUT', `bridges/children/${MARC.id}`, { networks: { whatsapp: true } })).status, 404, 'a parent is no child');
    for (const bad of [{}, { networks: {} }, { networks: { signal: true } }, { networks: { whatsapp: 'yes' } }]) {
      assert.equal((await c.as(ANNA)('PUT', `bridges/children/${LENA.id}`, bad)).json.code, 'invalid');
    }

    const r = await c.as(ANNA)('PUT', `bridges/children/${LENA.id}`, { networks: { whatsapp: true } });
    assert.deepEqual(r.json.child, { userId: LENA.id, networks: { whatsapp: true }, linked: { whatsapp: false } });
    assert.deepEqual(r.json.unlinked, {});
    mine = (await lena('GET', 'bridges')).json.bridges;
    assert.equal(mine.networks[0].allowed, true);
    const loginId = await link(c, host, LENA, 'qr');

    assert.deepEqual((await c.as(ANNA)('GET', 'bridges/children')).json.children[0].linked, { whatsapp: true }, 'parents see THAT the child linked — never the number');
    assert.ok(!JSON.stringify((await c.as(ANNA)('GET', 'bridges/children')).json).includes(loginId));

    // the other parent takes it back: the child's account is unlinked as well (GateControl logs who did it), and no new link
    const back = await c.as(MARC)('PUT', `bridges/children/${LENA.id}`, { networks: { whatsapp: false } });
    assert.deepEqual(back.json.unlinked, { whatsapp: true });
    assert.deepEqual(back.json.child, { userId: LENA.id, networks: { whatsapp: false }, linked: { whatsapp: false } });
    assert.deepEqual(host.bridges.state.log.filter((l) => l.op === 'unlink_for'), [{ op: 'unlink_for', userId: LENA.id, by: MARC.id, network: 'whatsapp', logins: 1 }]);
    assert.equal((await lena('POST', 'bridges/whatsapp/login', { flow: 'qr' })).json.code, 'bridge_locked');
    mine = (await lena('GET', 'bridges')).json.bridges;
    assert.equal(mine.networks[0].lock, 'child');
    assert.deepEqual(mine.networks[0].logins, []);
    // taking back what was never allowed and never linked: nothing to end, nothing asked of the bridge
    assert.deepEqual((await c.as(MARC)('PUT', `bridges/children/${LENA.id}`, { networks: { whatsapp: false } })).json.unlinked, {});
    assert.equal(host.bridges.state.log.filter((l) => l.op === 'unlink_for').length, 1);

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

test('1.13.0 — a GateControl without unlinkFor (1.273.x): taking the permission back locks, the link stays, and the answer says so', async () => {
  await withHost({ bridges: { ...ON, version: 1 }, services: [familie()] }, async (host, c) => {
    const lena = c.as(LENA);
    await c.as(ANNA)('PUT', `bridges/children/${LENA.id}`, { networks: { whatsapp: true } });
    const loginId = await link(c, host, LENA, 'qr');
    const back = await c.as(ANNA)('PUT', `bridges/children/${LENA.id}`, { networks: { whatsapp: false } });
    assert.deepEqual(back.json.unlinked, { whatsapp: false });
    assert.deepEqual(back.json.child.linked, { whatsapp: true });
    assert.equal((await lena('POST', 'bridges/whatsapp/login', { flow: 'qr' })).json.code, 'bridge_locked');
    // the child can still end it herself
    assert.equal((await lena('DELETE', `bridges/whatsapp/logins/${loginId}`)).json.unlinked, true);
  });
});

test('1.13.0 — the services for the Familie page: only Familie, only a parent, and revoking unlinks the child', async () => {
  await withHost({ bridges: ON, services: [familie()] }, async (host, c) => {
    const svc = (name, user, payload, caller = 'gatecontrol-familie') => host.callService(name, { caller, user, payload: payload || {} });
    assert.deepEqual(Object.keys(require('../plugin.json').services.provides).filter((k) => k.startsWith('bridge_')), ['bridge_children', 'bridge_child_set']);

    // not for another plugin, not for a child, a grandmother or an administrator who is no parent, not without a person
    assert.deepEqual(await svc('bridge_children', { id: ANNA.id }, {}, 'gatecontrol-drive'), { ok: false, code: 'forbidden' });
    for (const u of [LENA, OMA, ADMIN]) assert.deepEqual(await svc('bridge_children', { id: u.id }), { ok: false, code: 'forbidden' });
    assert.deepEqual(await svc('bridge_children', null), { ok: false, code: 'forbidden' });
    assert.deepEqual(await svc('bridge_child_set', { id: OMA.id }, { childId: LENA.id, networks: { whatsapp: true } }), { ok: false, code: 'forbidden' });

    let r = await svc('bridge_children', { id: ANNA.id });
    assert.deepEqual(r, { ok: true, available: true, networks: ['whatsapp'], children: [{ userId: LENA.id, networks: { whatsapp: false }, linked: { whatsapp: false } }] });
    assert.deepEqual(await svc('bridge_child_set', { id: ANNA.id }, { childId: MARC.id, networks: { whatsapp: true } }), { ok: false, code: 'not_found' });
    for (const bad of [{}, { childId: LENA.id }, { childId: LENA.id, networks: { signal: true } }, { childId: 'x', networks: { whatsapp: true } }]) {
      assert.deepEqual(await svc('bridge_child_set', { id: ANNA.id }, bad), { ok: false, code: 'invalid' });
    }
    r = await svc('bridge_child_set', { id: ANNA.id }, { childId: LENA.id, networks: { whatsapp: true } });
    assert.deepEqual(r, { ok: true, child: { userId: LENA.id, networks: { whatsapp: true }, linked: { whatsapp: false } }, unlinked: {} });
    assert.equal((await c.as(LENA)('GET', 'bridges')).json.bridges.networks[0].allowed, true);
    await link(c, host, LENA, 'phone');

    // GateControl ends a link for somebody else only while that person is acting — here: Marc's request to Familie
    r = await svc('bridge_child_set', { id: MARC.id }, { childId: LENA.id, networks: { whatsapp: false } });
    assert.deepEqual(r.unlinked, { whatsapp: false }, 'nobody was acting: refused by GateControl, said so');
    assert.equal((await c.as(LENA)('GET', 'bridges')).json.bridges.networks[0].logins.length, 1);
    await svc('bridge_child_set', { id: MARC.id }, { childId: LENA.id, networks: { whatsapp: true } });
    r = await host.bridges.acting(MARC.id, () => svc('bridge_child_set', { id: MARC.id }, { childId: LENA.id, networks: { whatsapp: false } }));
    assert.deepEqual(r, { ok: true, child: { userId: LENA.id, networks: { whatsapp: false }, linked: { whatsapp: false } }, unlinked: { whatsapp: true } });
    assert.deepEqual(host.bridges.state.log.filter((l) => l.op === 'unlink_for'), [{ op: 'unlink_for', userId: LENA.id, by: MARC.id, network: 'whatsapp', logins: 1 }]);
    const mine = (await c.as(LENA)('GET', 'bridges')).json.bridges.networks[0];
    assert.equal(mine.lock, 'child');
    assert.deepEqual(mine.logins, []);
  });

  // nothing is offered while the bridges are off, missing, or Familie is not there
  await withHost({ bridges: true, services: [familie()] }, async (host) => {
    assert.deepEqual(await host.callService('bridge_children', { caller: 'gatecontrol-familie', user: { id: ANNA.id }, payload: {} }), { ok: true, available: false, networks: [], children: [] });
  });
  await withHost({ services: [familie()] }, async (host) => {
    assert.deepEqual(await host.callService('bridge_children', { caller: 'gatecontrol-familie', user: { id: ANNA.id }, payload: {} }), { ok: true, available: false, networks: [], children: [] });
  });
  await withHost({ bridges: ON }, async (host) => {
    assert.deepEqual(await host.callService('bridge_children', { caller: 'gatecontrol-familie', user: { id: ANNA.id }, payload: {} }), { ok: false, code: 'forbidden' });
  });
});

test('1.13.0 — „Verknüpfte Dienste“ is offered only while a bridge is switched on; a QR step carries the modules', async () => {
  await withHost({}, async (host, c) => {
    assert.equal((await c.as(ANNA)('GET', 'me')).json.features.linked_services, undefined);
  });
  await withHost({ bridges: true }, async (host, c) => {
    assert.equal((await c.as(ANNA)('GET', 'me')).json.features.linked_services, undefined, 'offered by the server, but switched off');
  });
  await withHost({ bridges: ON }, async (host, c) => {
    const anna = c.as(ANNA);
    assert.equal((await anna('GET', 'me')).json.features.linked_services, true);
    assert.equal((await anna('GET', 'me')).json.features.bridges, false, 'the outside chats themselves are not there yet');
    await anna('POST', 'bridges/whatsapp/consent', { accept: true });
    const qr = (await anna('POST', 'bridges/whatsapp/login', { flow: 'qr' })).json.login;
    const m = qr.step.display.matrix;
    assert.ok(m.size >= 21 && m.rows.length === m.size);
    for (const row of m.rows) assert.match(row, new RegExp(`^[01]{${m.size}}$`));
    assert.equal(m.rows[0].slice(0, 7), '1111111', 'a finder pattern in the corner');
    assert.equal(qr.step.display.data, '2@fake-qr-payload,one,two,three', 'the apps draw from the content themselves');
    // a pairing code has no modules
    await anna('DELETE', `bridges/whatsapp/login/${qr.processId}`);
    const ph = (await anna('POST', 'bridges/whatsapp/login', { flow: 'phone' })).json.login;
    const code = (await anna('POST', `bridges/whatsapp/login/${ph.processId}/${ph.step.id}`, { input: { phone_number: '+4915120000000' } })).json.login;
    assert.deepEqual(code.step.display, { type: 'code', data: 'K7P2-M4X9' });

    host.bridges.setHost({ outdated: true });
    const mine = (await anna('GET', 'bridges')).json.bridges.networks[0];
    assert.equal(mine.outdated, true);
    assert.equal(mine.version, '0.2609.0');
    const a = (await c.admin('GET', 'bridges')).json.bridges;
    assert.equal(a.networks[0].outdated, true);
    assert.equal(a.host.limitsProvisional, true);
    assert.equal(a.host.probe, null);
  });
});

test('1.13.0 — the portal page and the admin card: texts in both languages, the page is part of the portal', () => {
  const html = ui.render({ view: 'portal', lang: 'de', loggedIn: true, user: { id: 2, loggedIn: true } }, (l, k) => texts[l][k] || k);
  assert.ok(html.includes('window.MSBridges'), 'bridges.js is delivered with the portal');
  assert.ok(html.includes('.ms-brp-qr'));
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'ui', 'bridges.js'), 'utf8');
  // keys written out in full (a key ending in "_" is completed at run time — those are listed below)
  const used = new Set([...src.matchAll(/T\('((?:br|admin|common)\.[a-z0-9_.]+)'/g)].map((m) => m[1]).filter((k) => !k.endsWith('_')));
  for (const k of ['br.note_whatsapp_unofficial', 'br.note_whatsapp_ban', 'br.note_whatsapp_phone', 'br.note_whatsapp_e2e', 'br.flow_phone', 'br.flow_qr',
    'br.sub_logged_out_whatsapp', 'br.code_step1_whatsapp', 'br.code_step2_whatsapp', 'br.qr_lead_whatsapp', 'br.qr_step1_whatsapp', 'br.qr_step2_whatsapp',
    'br.runs_on_server', 'br.runs_on_gateway', 'br.sub_starting', 'br.sub_unreachable', 'br.pill_starting', 'br.pill_unreachable', 'br.runs_current', 'br.runs_outdated',
    'br.sub_logged_out', 'br.sub_logged_out_at', 'br.new_code', 'br.new_qr', 'br.relink_hint', 'br.sub_locked',
    'admin.br_net_whatsapp', 'admin.br_mark_whatsapp']) used.add(k);
  assert.ok(used.size > 60);
  for (const k of used) for (const lang of ['de', 'en']) assert.ok(texts[lang][k], `${lang} ${k}`);
  const keys = (l) => Object.keys(texts[l]).filter((k) => k.startsWith('br.') || k.startsWith('admin.br_')).sort();
  assert.deepEqual(keys('de'), keys('en'));
  // no number about memory is claimed anywhere: the card shows what was measured, or how to measure
  for (const lang of ['de', 'en']) {
    assert.match(texts[lang]['admin.br_limits'], /update\.sh bridges-probe/);
    for (const k of keys(lang)) assert.doesNotMatch(texts[lang][k], /0[.,][3-6] ?GB|\d{3} ?MB/, `${lang} ${k}`);
  }
  // nothing of the page ends in innerHTML
  assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|document\.write/);
});
