'use strict';

// 1.23.0 — „Andere Messenger“ (server/linked.js, ui/portal-linked.js): parents allow a child to link its own account
// at another messenger with the bridges of the Messenger plugin. Familie only carries the switches — the Messenger
// keeps them, reached through its services bridge_children / bridge_child_set. Tested twice: against a stand-in for
// those services (what Familie asks, what it shows, what it refuses), and against the REAL Messenger plugin in a
// second mock host with GateControl's bridges behind it (tools/testing/mock-bridges.js) — taking a permission back
// ends the child's link there.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHost } = require('../../../tools/testing/mock-host');
const { withFamily, ADMIN, ANNA, MARC, LENA, TIM, OMA, USERS, portal } = require('./helpers');
const linked = require('../server/linked');
const ui = require('../server/ui');
const texts = require('../server/texts.json');

const MESSENGER = path.join(__dirname, '..', '..', 'gatecontrol-messenger');

/** A stand-in for the Messenger's two services. */
function standIn(over = {}) {
  const st = { grants: new Set(), links: new Set([`${TIM.id}:whatsapp`]), calls: [], ...over };
  const child = (id) => ({ userId: id, networks: { whatsapp: st.grants.has(`${id}:whatsapp`) }, linked: { whatsapp: st.links.has(`${id}:whatsapp`) } });
  return {
    st,
    entry: {
      plugin: 'gatecontrol-messenger', provides: over.provides || ['bridge_children', 'bridge_child_set'],
      service: (c) => {
        st.calls.push({ name: c.name, user: c.user && c.user.id, payload: c.payload });
        if (st.fail) throw new Error('boom');
        if (![ANNA.id, MARC.id].includes(c.user && c.user.id)) return { ok: false, code: 'forbidden' };
        if (c.name === 'bridge_children') return st.off ? { ok: true, available: false, networks: [], children: [] } : { ok: true, available: true, networks: ['whatsapp'], children: [LENA.id, TIM.id, 9999].map(child) };
        const id = c.payload.childId;
        const on = c.payload.networks.whatsapp;
        const unlinked = {};
        if (on) st.grants.add(`${id}:whatsapp`);
        else {
          st.grants.delete(`${id}:whatsapp`);
          if (st.links.has(`${id}:whatsapp`)) { unlinked.whatsapp = !st.keep; if (!st.keep) st.links.delete(`${id}:whatsapp`); }
        }
        return { ok: true, child: child(id), unlinked };
      },
    },
  };
}
const WITH = (s, extra = {}) => ({ gatecontrol: '1.273.0', services: [s.entry], ...extra });

test('without the Messenger, with an older one, or with no bridge switched on: nothing is offered, nothing breaks', async () => {
  linked._reset();
  await withFamily({ gatecontrol: '1.273.0' }, async (host, { as }) => {
    assert.deepEqual((await as(ANNA)('GET', '/messengers')).json.messengers, { available: false, manage: true, networks: [], children: [] });
    const r = await as(ANNA)('PUT', `/messengers/${LENA.id}`, { networks: { whatsapp: true } });
    assert.deepEqual([r.status, r.json.code], [409, 'unavailable']);
  });
  // a Messenger before 1.13.0: the services are not there
  linked._reset();
  const old = standIn({ provides: ['send_message'] });
  await withFamily(WITH(old), async (host, { as }) => {
    assert.equal((await as(ANNA)('GET', '/messengers')).json.messengers.available, false);
    assert.equal(old.st.calls.length, 0, 'asking what is not offered costs nothing');
  });
  linked._reset();
  const off = standIn({ off: true });
  await withFamily(WITH(off), async (host, { as }) => {
    assert.deepEqual((await as(ANNA)('GET', '/messengers')).json.messengers, { available: false, manage: true, networks: [], children: [] });
  });
  linked._reset();
  const broken = standIn({ fail: true });
  await withFamily(WITH(broken), async (host, { as }) => {
    assert.equal((await as(ANNA)('GET', '/messengers')).json.messengers.available, false);
    const r = await as(ANNA)('PUT', `/messengers/${LENA.id}`, { networks: { whatsapp: true } });
    assert.deepEqual([r.status, r.json.code], [409, 'unavailable']);
  });
});

test('parents see every child with the switch per service; nobody else sees or changes anything', async () => {
  linked._reset();
  const s = standIn();
  await withFamily(WITH(s), async (host, { as, call }) => {
    const m = (await as(ANNA)('GET', '/messengers')).json.messengers;
    assert.deepEqual([m.available, m.manage, m.networks], [true, true, ['whatsapp']]);
    assert.deepEqual(m.children.map((c) => [c.userId, c.name, c.networks, c.linked]), [
      [LENA.id, 'Lena', { whatsapp: false }, { whatsapp: false }],
      [TIM.id, 'Tim', { whatsapp: false }, { whatsapp: true }],
    ], 'only members of this family, with what the Messenger says');
    assert.ok(m.children[0].colorHex && m.children[0].initials, 'the face of the account');
    assert.deepEqual(s.st.calls, [{ name: 'bridge_children', user: ANNA.id, payload: {} }], 'asked as the parent');

    // a child, a person outside the family, device trust only
    for (const u of [LENA, TIM]) {
      assert.deepEqual((await as(u)('GET', '/messengers')).json.messengers, { available: false, manage: false, networks: [], children: [] });
      const r = await as(u)('PUT', `/messengers/${LENA.id}`, { networks: { whatsapp: true } });
      assert.deepEqual([r.status, r.json.code], [403, 'parents_only']);
    }
    assert.equal((await as(ADMIN)('GET', '/messengers')).json.code, 'not_member');
    assert.equal((await as(OMA)('PUT', `/messengers/${LENA.id}`, { networks: { whatsapp: true } })).json.code, 'not_member');
    const trust = await call(portal(ANNA, false), 'GET', '/messengers');
    assert.deepEqual([trust.status, trust.json.code], [403, 'login_required']);
    assert.equal(s.st.calls.filter((c) => c.name === 'bridge_child_set').length, 0, 'the Messenger was never asked for them');

    // only children of the family, only known services, only booleans
    for (const [id, body, code] of [[MARC.id, { networks: { whatsapp: true } }, 'not_found'], [9999, { networks: { whatsapp: true } }, 'not_found'], ['x', { networks: { whatsapp: true } }, 'not_found'],
      [LENA.id, {}, 'invalid'], [LENA.id, { networks: {} }, 'invalid'], [LENA.id, { networks: { signal: true } }, 'invalid'], [LENA.id, { networks: { whatsapp: 1 } }, 'invalid']]) {
      assert.equal((await as(ANNA)('PUT', `/messengers/${id}`, body)).json.code, code, JSON.stringify([id, body]));
    }
    assert.equal(s.st.calls.filter((c) => c.name === 'bridge_child_set').length, 0);
  });
});

test('allowing and taking back: the answer says whether the child’s link was ended; the list is asked again after a change', async () => {
  linked._reset();
  const s = standIn();
  await withFamily(WITH(s), async (host, { as }) => {
    await as(ANNA)('GET', '/messengers');
    await as(ANNA)('GET', '/messengers');
    assert.equal(s.st.calls.length, 1, 'kept for five minutes — the service budget is shared');

    let r = (await as(ANNA)('PUT', `/messengers/${LENA.id}`, { networks: { whatsapp: true } })).json;
    assert.deepEqual([r.child.userId, r.child.name, r.child.networks, r.child.linked, r.unlinked], [LENA.id, 'Lena', { whatsapp: true }, { whatsapp: false }, {}]);
    assert.deepEqual(s.st.calls[1], { name: 'bridge_child_set', user: ANNA.id, payload: { childId: LENA.id, networks: { whatsapp: true } } });
    assert.equal((await as(ANNA)('GET', '/messengers')).json.messengers.children[0].networks.whatsapp, true);
    assert.equal(s.st.calls.length, 3, 'asked again after the change');

    // Tim has an account linked: taking the permission back ends it
    await as(MARC)('PUT', `/messengers/${TIM.id}`, { networks: { whatsapp: true } });
    r = (await as(MARC)('PUT', `/messengers/${TIM.id}`, { networks: { whatsapp: false } })).json;
    assert.deepEqual([r.child.networks, r.child.linked, r.unlinked], [{ whatsapp: false }, { whatsapp: false }, { whatsapp: true }]);

    // …or it could not be ended (an older GateControl): said so, the link is still shown
    s.st.links.add(`${TIM.id}:whatsapp`);
    s.st.keep = true;
    r = (await as(MARC)('PUT', `/messengers/${TIM.id}`, { networks: { whatsapp: false } })).json;
    assert.deepEqual([r.child.linked, r.unlinked], [{ whatsapp: true }, { whatsapp: false }]);
    // nothing of Familie's own is written: no table, no log
    assert.ok(!host.logs.some((l) => l.level === 'warn' || l.level === 'error'), JSON.stringify(host.logs));
  });
});

test('with the real Messenger and GateControl’s bridges: a parent’s yes lets the child link, taking it back unlinks', async () => {
  linked._reset();
  const roles = { plugin: 'gatecontrol-familie', provides: ['family_roles'], service: () => ({ ok: true, parents: [ANNA.id, MARC.id], children: [LENA.id, TIM.id] }) };
  const messenger = await createHost(MESSENGER, { users: USERS, gatecontrol: '1.273.0', services: [roles], bridges: { enabled: true, networks: { whatsapp: true }, running: true } });
  await messenger.start();
  try {
    await withFamily({ gatecontrol: '1.273.0', services: [{ plugin: 'gatecontrol-messenger', host: messenger }] }, async (host, { as }) => {
      const chat = (u) => (method, p, body) => messenger.request({ method, path: p, body: body === undefined ? null : body, query: {}, user: { ...u, portal: true, loggedIn: true, app: true }, lang: 'de' });
      const m = (await as(ANNA)('GET', '/messengers')).json.messengers;
      assert.deepEqual(m.children.map((c) => [c.userId, c.networks.whatsapp, c.linked.whatsapp]), [[LENA.id, false, false], [TIM.id, false, false]]);
      assert.equal((await chat(LENA)('GET', 'bridges')).json.bridges.networks[0].lock, 'child');

      let r = (await as(ANNA)('PUT', `/messengers/${LENA.id}`, { networks: { whatsapp: true } })).json;
      assert.deepEqual([r.child.networks, r.unlinked], [{ whatsapp: true }, {}]);
      assert.equal((await chat(LENA)('GET', 'bridges')).json.bridges.networks[0].allowed, true);

      // Lena links her account in the chat
      await chat(LENA)('POST', 'bridges/whatsapp/consent', { accept: true });
      const qr = (await chat(LENA)('POST', 'bridges/whatsapp/login', { flow: 'qr' })).json.login;
      messenger.bridges.confirm(qr.processId);
      assert.equal((await chat(LENA)('POST', `bridges/whatsapp/login/${qr.processId}/${qr.step.id}`, {})).json.login.step.type, 'complete');
      linked._reset();
      assert.deepEqual((await as(MARC)('GET', '/messengers')).json.messengers.children[0].linked, { whatsapp: true });

      // Marc takes it back on Familie's page — GateControl ends the link while his request is in flight
      r = (await messenger.bridges.acting(MARC.id, () => as(MARC)('PUT', `/messengers/${LENA.id}`, { networks: { whatsapp: false } }))).json;
      assert.deepEqual([r.child.networks, r.child.linked, r.unlinked], [{ whatsapp: false }, { whatsapp: false }, { whatsapp: true }]);
      assert.deepEqual(messenger.bridges.state.log.filter((l) => l.op === 'unlink_for'), [{ op: 'unlink_for', userId: LENA.id, by: MARC.id, network: 'whatsapp', logins: 1 }]);
      const mine = (await chat(LENA)('GET', 'bridges')).json.bridges.networks[0];
      assert.deepEqual([mine.lock, mine.logins], ['child', []]);
    });
  } finally { await messenger.close(); }
});

test('the card: part of the portal, hidden by default, texts in both languages, the services listed', () => {
  const html = ui.render({ view: 'portal', lang: 'de', loggedIn: true, user: { id: ANNA.id, loggedIn: true } }, (l, k) => texts[l][k] || k);
  assert.match(html, /<section class="fa-card" id="fa-linked" aria-labelledby="fa-lk-h" hidden>/);
  assert.ok(html.includes("A.api('GET', 'messengers')"), 'portal-linked.js is delivered with the portal');
  const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'ui', 'portal-linked.js'), 'utf8');
  const used = new Set([...src.matchAll(/T\('(linked\.[a-z_]+)'/g)].map((m) => m[1]).filter((k) => !k.endsWith('_')));
  for (const k of ['linked.title', 'linked.sub', 'linked.hint', 'linked.net_whatsapp', 'linked.confirm', 'linked.confirm_linked']) used.add(k);
  for (const k of used) for (const lang of ['de', 'en']) assert.ok(texts[lang][k], `${lang} ${k}`);
  const keys = (l) => Object.keys(texts[l]).filter((k) => k.startsWith('linked.')).sort();
  assert.deepEqual(keys('de'), keys('en'));
  assert.equal(keys('de').length, used.size, 'no text without a use');
  assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML/);
  const manifest = require('../plugin.json');
  for (const s of ['bridge_children', 'bridge_child_set']) assert.ok(manifest.permissions.services.includes(`gatecontrol-messenger:${s}`));
});
