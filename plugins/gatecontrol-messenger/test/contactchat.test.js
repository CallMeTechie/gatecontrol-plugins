'use strict';

// 1.18.0: „Neuer Chat“ with contacts (bridges stage 4c) — against the mock host's gc.bridges version 6 and a stand-in for
// Mail's service contacts_phones.
//
//   sections   GateControl, WhatsApp (the bridge's contacts: names and sealed references, never a number), the address
//              book (the person's own numbers); the feature word bridge_contacts only for people with a link
//   merged     an address book number that is a WhatsApp contact: once, under WhatsApp, with the address book's name
//   tapping    a WhatsApp contact: the chat at once, nothing counted; an address book number: exactly this number is
//              checked, counted in the brake, a „no“ remembered for 30 days (no number kept) — and forgotten on unlink
//   states     bridge down, logged out, a child without permission, Mail missing

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, app, ANNA, MARC, LENA, DAY } = require('./helpers');

const V6 = { enabled: true, networks: { whatsapp: true }, running: true, version: 6 };
const GC = '1.219.0';
const WA = [
  { number: '+4915112345678', name: 'Kim Muster' },
  { number: '+4917099887766', name: 'Lena B. (WhatsApp)' },
  { number: '+4916011112222', name: 'Tom Richter' },
];
// Anna's address book in Mail
const BOOK = {
  [ANNA.id]: [
    { id: 11, name: 'Paul Hoffmann', phones: [{ key: 'mobile', kind: 'mobile', value: '0160 98765432', e164: '+4916098765432', landline: false }] },
    { id: 12, name: 'Sabine Wolf', phones: [
      { key: 'mobile', kind: 'mobile', value: '+49 151 23456780', e164: '+4915123456780', landline: false },
      { key: 'work', kind: 'work', value: '+49 170 2345678', e164: '+491702345678', landline: false },
      { key: 'home', kind: 'home', value: '+49 30 12345678', e164: '+493012345678', landline: true }] },
    { id: 13, name: 'Lena Berger', phones: [{ key: 'mobile', kind: 'mobile', value: '0170 99887766', e164: '+4917099887766', landline: false }] },
  ],
};
function mail(calls = []) {
  return {
    plugin: 'gatecontrol-mail', provides: { contacts_phones: { label: { de: 'Kontakte', en: 'Contacts' }, maxPerHour: 3600 } },
    service: async ({ name, caller, user, payload }) => {
      calls.push({ name, caller, userId: user && user.id, payload });
      if (!user || payload.userId !== user.id) return { ok: false, code: 'forbidden' };
      if (calls.off) return { ok: false, code: 'unavailable', reason: 'feature_off' };
      let items = BOOK[user.id] || [];
      if (payload.q) items = items.filter((x) => x.name.toLowerCase().includes(payload.q.toLowerCase()));
      if (payload.ids) items = items.filter((x) => payload.ids.includes(x.id));
      return { ok: true, items, next: null };
    },
  };
}
const familie = () => ({ plugin: 'gatecontrol-familie', provides: ['family_roles'], service: () => ({ ok: true, parents: [ANNA.id, MARC.id], children: [LENA.id] }) });

async function link(c, host, user) {
  const me = c.as(user);
  assert.equal((await me('POST', 'bridges/whatsapp/consent', { accept: true })).status, 200);
  let r = await me('POST', 'bridges/whatsapp/login', { flow: 'qr' });
  host.bridges.confirm(r.json.login.processId);
  r = await me('POST', `bridges/whatsapp/login/${r.json.login.processId}/${r.json.login.step.id}`, {});
  assert.equal(r.json.login.step.type, 'complete');
  return r.json.login.step.loginId;
}
const list = async (c, user = ANNA, q) => {
  const r = await c.as(user)('GET', 'contacts/new-chat', null, { network: 'whatsapp', ...(q ? { q } : {}) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json;
};
const left = async (c) => (await c.as(ANNA)('GET', 'bridges')).json.bridges.networks[0].newChat.limit.left;

test('three sections, merged by the number — WhatsApp contacts without a number, the address book with; the feature word only with a link', async () => {
  const calls = [];
  await withHost({ bridges: V6, gatecontrol: GC, services: [mail(calls)] }, async (host, c) => {
    host.bridges.contacts = WA.map((x) => ({ ...x }));
    assert.equal((await c.as(ANNA)('GET', 'me')).json.features.bridge_contacts, undefined);
    let r = await list(c);
    assert.deepEqual([r.whatsapp, r.addressBook, r.numberEntry], [null, null, false], 'nothing linked: GateControl only');
    assert.deepEqual(r.gatecontrol.map((p) => p.name), ['admin', 'Lena', 'Marc', 'Oma']);
    await c.direct(ANNA, MARC);
    await link(c, host, ANNA);
    assert.equal((await c.as(ANNA)('GET', 'me')).json.features.bridge_contacts, true);
    assert.equal((await c.as(MARC)('GET', 'me')).json.features.bridge_contacts, undefined, 'only who linked');
    r = await list(c);
    assert.equal(r.numberEntry, true);
    assert.deepEqual(r.limit, { perHour: 10, left: 10, retryAfterS: 0 });
    // WhatsApp: sorted by name; Lena's number is in the address book too → her name from there, once
    assert.equal(r.whatsapp.state, 'ok');
    assert.deepEqual(r.whatsapp.items.map((x) => [x.name, x.alsoInAddressBook, x.addressBookId]), [['Kim Muster', false, null], ['Lena Berger', true, 13], ['Tom Richter', false, null]]);
    for (const x of r.whatsapp.items) assert.match(x.ref, /^k[A-Za-z0-9_-]{40,}$/);
    assert.doesNotMatch(JSON.stringify(r.whatsapp), /4915112345678|4917099887766|4916011112222|15112345678/, 'no number of a WhatsApp contact');
    // the address book: without Lena (merged), with the numbers — they are Anna's own
    assert.deepEqual(r.addressBook.items.map((x) => x.name), ['Paul Hoffmann', 'Sabine Wolf']);
    assert.deepEqual(r.addressBook.items[1].phones.map((p) => [p.key, p.number, p.landline, p.notOnNetwork]),
      [['mobile', '+49 151 23456780', false, false], ['work', '+49 170 2345678', false, false], ['home', '+49 30 12345678', true, false]]);
    // merged on the server: matchNumbers, no question about a number
    assert.deepEqual(host.bridges.state.log.filter((x) => ['resolve', 'create_dm'].includes(x.op)), []);
    assert.ok(host.bridges.state.log.some((x) => x.op === 'match'));
    assert.ok(calls.every((x) => x.caller === 'gatecontrol-messenger' && x.userId === ANNA.id && x.payload.userId === ANNA.id));
    // GateControl: „Chat öffnen“ only with a chat that has a message
    assert.equal(r.gatecontrol.find((p) => p.name === 'Marc').conversationId, null);
    // a search: in all sections; a number in the field: the last line
    r = await list(c, ANNA, 'ber');
    assert.deepEqual([r.gatecontrol.length, r.whatsapp.items.map((x) => x.name), r.addressBook], [0, ['Lena Berger'], null]);
    r = await list(c, ANNA, '0171 5550123');
    assert.deepEqual(r.number, { e164: '+491715550123', show: '+49 171 5550123', conversationId: null });
    assert.equal((await list(c, ANNA, 'Kim')).number, null);
    assert.equal((await c.as(ANNA)('GET', 'contacts/new-chat', null, { network: 'signal' })).json.code, 'invalid');
  });
});

test('a WhatsApp contact: the chat at once, nothing counted; a chat that exists: „Chat öffnen“; an old reference: contact_expired', async () => {
  await withHost({ bridges: V6, gatecontrol: GC, services: [mail()] }, async (host, c) => {
    host.bridges.contacts = WA.map((x) => ({ ...x }));
    await link(c, host, ANNA);
    let r = await list(c);
    const kim = r.whatsapp.items[0];
    let s = await c.as(ANNA)('POST', 'bridges/whatsapp/chats', { ref: kim.ref });
    assert.equal(s.status, 200, JSON.stringify(s.json));
    assert.deepEqual([s.json.created, s.json.conversation.title], [true, 'Kim Muster']);
    const convId = s.json.conversation.id;
    assert.equal(await left(c), 10, 'nothing checked, nothing counted');
    assert.deepEqual(host.bridges.state.log.filter((x) => ['resolve', 'create_dm'].includes(x.op)), []);
    // the bridge names the chat in its list from now on → „Chat öffnen“
    host.bridges.contacts[0].chatId = [...host.bridges.state.contactDms.values()][0];
    r = await list(c);
    assert.equal(r.whatsapp.items[0].conversationId, convId);
    s = await c.as(ANNA)('POST', 'bridges/whatsapp/chats', { ref: r.whatsapp.items[0].ref });
    assert.deepEqual([s.json.created, s.json.conversation.id], [false, convId]);
    host.bridges.expireRefs();
    s = await c.as(ANNA)('POST', 'bridges/whatsapp/chats', { ref: r.whatsapp.items[0].ref });
    assert.deepEqual([s.status, s.json.code], [409, 'contact_expired']);
    assert.equal((await c.as(ANNA)('POST', 'bridges/whatsapp/chats', { ref: 'nope' })).json.code, 'invalid');
    assert.equal((await c.as(MARC)('POST', 'bridges/whatsapp/chats', { ref: kim.ref })).json.code, 'bridge_unlinked');
  });
});

test('an address book number: exactly it is checked and counted; „nicht bei WhatsApp“ is remembered 30 days without the number, forgotten on unlink', async () => {
  await withHost({ bridges: V6, gatecontrol: GC, services: [mail()] }, async (host, c) => {
    host.bridges.contacts = WA.map((x) => ({ ...x }));
    host.bridges.numbers.set('+491702345678', { name: 'Sabine W.' });
    const loginId = await link(c, host, ANNA);
    const me = c.as(ANNA);
    // Paul's only number is not at WhatsApp
    let s = await me('POST', 'bridges/whatsapp/chats', { contactId: 11, phoneKind: 'mobile' });
    assert.deepEqual([s.status, s.json.code, s.json.reason], [404, 'not_found', 'not_on_network']);
    assert.equal(await left(c), 9, 'the check counted');
    const rows = (await host.gc.db.query('SELECT * FROM bridge_not_on')).rows;
    assert.deepEqual(rows.map((x) => [x.user_id, x.network, x.card_id, x.phone_key]), [[ANNA.id, 'whatsapp', 11, 'mobile']]);
    assert.doesNotMatch(JSON.stringify(rows), /98765432/, 'never the number');
    // asked again: remembered, nobody asked, nothing counted
    const asked = host.bridges.state.log.filter((x) => x.op === 'resolve').length;
    s = await me('POST', 'bridges/whatsapp/chats', { contactId: 11, phoneKind: 'mobile' });
    assert.deepEqual([s.status, s.json.reason, s.json.remembered], [404, 'not_on_network', true]);
    assert.equal(host.bridges.state.log.filter((x) => x.op === 'resolve').length, asked);
    assert.equal(await left(c), 9);
    let r = await list(c);
    assert.equal(r.addressBook.items[0].phones[0].notOnNetwork, true);
    // Sabine's work number is: the chat opens, „Chat öffnen“ from now on — without asking again
    s = await me('POST', 'bridges/whatsapp/chats', { contactId: 12, phoneKind: 'work' });
    assert.equal(s.status, 200, JSON.stringify(s.json));
    assert.equal(s.json.created, true);
    assert.equal(await left(c), 8, 'one check for the tap');
    r = await list(c);
    assert.equal(r.addressBook.items.find((x) => x.contactId === 12).conversationId, s.json.conversation.id);
    const again = await me('POST', 'bridges/whatsapp/chats', { contactId: 12, phoneKind: 'work' });
    assert.deepEqual([again.json.created, again.json.conversation.id], [false, s.json.conversation.id]);
    assert.equal(await left(c), 8);
    // the protocol: checked, the source, found or not — no number, no name
    const log = JSON.stringify((await c.admin('GET', 'log')).json);
    assert.match(log, /bridge_number_checked/);
    assert.match(log, /addressbook found/);
    assert.match(log, /addressbook not_found/);
    assert.doesNotMatch(log + JSON.stringify(host.bridges.state.log), /98765432|2345678|Paul|Sabine/);
    // wrong input; a number that is not there any more
    for (const bad of [{ contactId: 12 }, { contactId: 'x', phoneKind: 'work' }, { contactId: 12, phoneKind: 'fax' }]) {
      assert.equal((await me('POST', 'bridges/whatsapp/chats', bad)).json.code, 'invalid', JSON.stringify(bad));
    }
    assert.deepEqual([(await me('POST', 'bridges/whatsapp/chats', { contactId: 12, phoneKind: 'other' })).json.reason], ['contact_gone']);
    assert.deepEqual([(await me('POST', 'bridges/whatsapp/chats', { contactId: 99, phoneKind: 'mobile' })).json.reason], ['contact_gone']);
    // 30 days later Paul is asked again
    c.clock.add(31 * DAY);
    s = await me('POST', 'bridges/whatsapp/chats', { contactId: 11, phoneKind: 'mobile' });
    assert.equal(s.json.remembered, undefined);
    // unlinking forgets
    assert.equal((await me('DELETE', `bridges/whatsapp/logins/${loginId}`)).status, 200);
    assert.deepEqual((await host.gc.db.query('SELECT * FROM bridge_not_on')).rows, []);
  });
});

test('the brake: taps of address book numbers share the admin\'s checks per hour with typed numbers', async () => {
  await withHost({ bridges: V6, gatecontrol: GC, services: [mail()] }, async (host, c) => {
    await link(c, host, ANNA);
    assert.equal((await c.admin('PUT', 'bridges', { newChatPerHour: 2 })).status, 200);
    const me = c.as(ANNA);
    assert.equal((await me('POST', 'bridges/whatsapp/resolve', { number: '+4915199999999' })).json.found, false);
    assert.equal((await me('POST', 'bridges/whatsapp/chats', { contactId: 12, phoneKind: 'mobile' })).status, 404);
    const s = await me('POST', 'bridges/whatsapp/chats', { contactId: 12, phoneKind: 'work' });
    assert.deepEqual([s.status, s.json.code], [429, 'rate_limited']);
    assert.ok(s.json.retryAfterS > 0);
    assert.equal((await list(c)).limit.left, 0);
  });
});

test('states: bridge down, logged out, a child without permission, Mail missing', async () => {
  const calls = [];
  await withHost({ bridges: V6, gatecontrol: GC, services: [mail(calls), familie()] }, async (host, c) => {
    host.bridges.contacts = WA.map((x) => ({ ...x }));
    const loginId = await link(c, host, ANNA);
    host.bridges.setHost({ bridgeDown: true });
    let r = await list(c);
    assert.deepEqual([r.whatsapp.state, r.whatsapp.items, r.addressBook.state, r.numberEntry], ['unreachable', [], 'unreachable', true]);
    assert.equal(r.addressBook.items.length, 3, 'shown, not tappable — nothing merged without the list');
    host.bridges.setHost({ bridgeDown: false });
    host.bridges.logOut(ANNA.id, loginId);
    await c.as(ANNA)('GET', 'bridges');
    r = await list(c);
    assert.deepEqual([r.whatsapp.state, r.addressBook.state], ['logged_out', 'logged_out']);
    // a child the parents did not allow: GateControl only
    r = await list(c, LENA);
    assert.deepEqual([r.whatsapp, r.addressBook, r.numberEntry, r.gatecontrol.length > 0], [null, null, false, true]);
    // Mail without contacts (switched off): no address book section
    calls.off = true;
    const mc = await c.as(MARC);
    await link(c, host, MARC);
    r = await list(c, MARC);
    assert.deepEqual([r.whatsapp.state, r.addressBook, r.addressBookReason], ['ok', null, 'feature_off']);
    assert.equal((await mc('POST', 'bridges/whatsapp/chats', { contactId: 11, phoneKind: 'mobile' })).json.code, 'mail_missing');
  });
  // no Mail at all
  await withHost({ bridges: V6, gatecontrol: GC }, async (host, c) => {
    host.bridges.contacts = WA.map((x) => ({ ...x }));
    await link(c, host, ANNA);
    const r = await list(c);
    assert.deepEqual([r.whatsapp.items.length, r.addressBook, r.addressBookReason], [3, null, 'no_mail']);
  });
  // a GateControl with gc.bridges version 5: no WhatsApp section, no feature word — the number dialog as before
  await withHost({ bridges: { ...V6, version: 5 }, gatecontrol: GC, services: [mail()] }, async (host, c) => {
    await link(c, host, ANNA);
    assert.equal((await c.as(ANNA)('GET', 'me')).json.features.bridge_contacts, undefined);
    const r = await list(c);
    assert.deepEqual([r.whatsapp, r.addressBook, r.numberEntry], [null, null, false]);
    void app;
  });
});
