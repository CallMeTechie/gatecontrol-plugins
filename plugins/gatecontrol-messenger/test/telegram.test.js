'use strict';

// 1.24.0 — Telegram (GateControl with gc.bridges version 11; the mock host's stand-in, tools/testing/mock-bridges.js):
// the administrator's application id (passed straight through — never kept or logged here), „noch nicht eingerichtet“,
// the link by number, code and password (a wrong one asked again), bots, large groups muted at first, Telegram channels and
// the parents' „Telegram-Kanäle“, a file too large for GateControl and a bot's buttons. Names and numbers are made up.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, app, ANNA, MARC, LENA } = require('./helpers');
const texts = require('../server/texts.json');

const ON = { enabled: true, networks: { whatsapp: true, telegram: true }, running: true, version: 11 };
const READY = { ...ON, telegramApp: true };
const B = { bridged: '1' };
const BC = { bridged: '1', channels: '1' };
const APP = { apiId: '20000001', apiHash: '0123456789ABCDEF0123456789abcdef' };
const PASSWORD = 'Wanderweg-Eifel-7';
const KIM = { id: 'c' + 'k'.repeat(21), name: 'Kim Muster' };
const CH = { channel: true, system: true };
let n = 0;
/** Everything the plugin keeps (its database file, all tables) and logged — as text. */
function kept(host) {
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(require('node:path').join(host.filesDir, '..', 'plugin.db'));
  try {
    const tables = d.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    return JSON.stringify([tables.map((t) => d.prepare(`SELECT * FROM "${t}"`).all()), host.logs]);
  } finally { d.close(); }
}
const eid = () => `$tg${++n}`;
const familie = () => ({ plugin: 'gatecontrol-familie', provides: ['family_roles'], service: () => ({ ok: true, parents: [ANNA.id, MARC.id], children: [LENA.id] }) });

async function linkTelegram(c, host, user, password = null) {
  const me = c.as(user);
  assert.equal((await me('POST', 'bridges/telegram/consent', { accept: true })).status, 200);
  host.bridges.tgPassword = password;
  let r = await me('POST', 'bridges/telegram/login', { flow: 'phone' });
  const step = (s, value) => me('POST', `bridges/telegram/login/${s.processId}/${s.step.id}`, { input: { [s.step.fields[0].id]: value } });
  r = await step(r.json.login, '+4915100000000');
  r = await step(r.json.login, '47000');
  if (password) r = await step(r.json.login, password);
  assert.equal(r.json.login.step.type, 'complete', JSON.stringify(r.json));
}

test('without the application id: Telegram says „noch nicht eingerichtet“, nothing can be linked', async () => {
  await withHost({ bridges: ON }, async (host, c) => {
    const b = (await c.as(ANNA)('GET', 'bridges')).json.bridges;
    const tg = b.networks.find((x) => x.id === 'telegram');
    assert.equal(tg.needs, 'app');
    assert.deepEqual(tg.flows, ['qr', 'phone']);
    const a = (await c.admin('GET', 'bridges')).json.bridges;
    assert.deepEqual(a.telegramApp, { set: false, setAt: null, setBy: null });
  });
});

test('the administrator enters the application id: passed to GateControl, never kept or logged here', async () => {
  await withHost({ bridges: ON }, async (host, c) => {
    for (const bad of [{ apiId: '12', apiHash: APP.apiHash }, { apiId: APP.apiId, apiHash: 'xyz' }, { apiId: APP.apiId }, 'x']) {
      assert.equal((await c.admin('PUT', 'bridges', { telegramApp: bad })).json.code, 'invalid', JSON.stringify(bad));
    }
    assert.equal((await c.admin('PUT', 'bridges', { telegramApp: APP, enabled: true })).json.code, 'invalid', 'on its own only');
    assert.equal((await c.as(ANNA)('PUT', 'admin/bridges', { telegramApp: APP })).status, 403);
    const a = (await c.admin('PUT', 'bridges', { telegramApp: APP })).json.bridges;
    assert.equal(a.telegramApp.set, true);
    assert.deepEqual(host.bridges.tgApps.slice(-1), [{ apiId: 20000001, apiHash: APP.apiHash.toLowerCase() }]);
    // nothing of it in the plugin's tables or its log
    const dump = kept(host);
    assert.doesNotMatch(dump, /20000001|0123456789abcdef/i);
    const log = (await c.admin('GET', 'log')).json;
    assert.match(JSON.stringify(log), /Telegram-Anwendung hinterlegt/);
    assert.equal((await c.admin('PUT', 'bridges', { telegramApp: null })).json.bridges.telegramApp.set, false);
  });
});

test('linked by number, code and password — a wrong code and a wrong password are asked again', async () => {
  await withHost({ bridges: READY }, async (host, c) => {
    const me = c.as(ANNA);
    await me('POST', 'bridges/telegram/consent', { accept: true });
    host.bridges.tgPassword = PASSWORD;
    let r = await me('POST', 'bridges/telegram/login', { flow: 'phone' });
    assert.deepEqual(r.json.login.step.fields.map((f) => f.type), ['phone_number']);
    const step = (s, value) => me('POST', `bridges/telegram/login/${s.processId}/${s.step.id}`, { input: { [s.step.fields[0].id]: value } });
    r = await step(r.json.login, '+4915100000000');
    assert.deepEqual(r.json.login.step.fields.map((f) => f.type), ['2fa_code']);
    r = await step(r.json.login, '11111');
    assert.equal(r.json.login.step.retry, true);
    r = await step(r.json.login, '47000');
    assert.deepEqual(r.json.login.step.fields.map((f) => f.type), ['password']);
    assert.ok(!r.json.login.step.retry);
    r = await step(r.json.login, 'falsch');
    assert.equal(r.json.login.step.retry, true);
    r = await step(r.json.login, PASSWORD);
    assert.equal(r.json.login.step.type, 'complete');
    assert.doesNotMatch(kept(host), new RegExp(PASSWORD), 'the password is kept nowhere here');
    // the QR code is the other way in
    const q = await me('POST', 'bridges/telegram/login', { flow: 'qr' });
    assert.match(q.json.login.step.display.data, /^tg:\/\/login\?token=/);
  });
});

test('a bot, a large group muted at first, a file too large for GateControl, a bot\'s buttons', async () => {
  await withHost({ bridges: READY }, async (host, c) => {
    await linkTelegram(c, host, ANNA);
    const botRef = host.bridges.chat(ANNA.id, { kind: 'direct', name: 'Paketdienst-Bot', network: 'telegram' });
    const grpRef = host.bridges.chat(ANNA.id, { kind: 'group', name: 'Wandergruppe Eifel', network: 'telegram' });
    const bot = { id: botRef, kind: 'direct', name: 'Paketdienst-Bot', channel: false, readOnly: false, bot: true };
    const grp = { id: grpRef, kind: 'group', name: 'Wandergruppe Eifel', channel: false, readOnly: false, members: 340 };
    await host.bridges.deliver([
      { userId: ANNA.id, network: 'telegram', type: 'chat', chat: bot },
      { userId: ANNA.id, network: 'telegram', type: 'chat', chat: grp },
      { userId: ANNA.id, network: 'telegram', type: 'message', chat: bot, id: eid(), sender: KIM, kind: 'text', text: 'Deine Sendung kommt morgen.', buttons: true, replyTo: null },
      { userId: ANNA.id, network: 'telegram', type: 'message', chat: grp, id: eid(), sender: KIM, kind: 'text', text: 'Treffpunkt 8 Uhr', replyTo: null },
      { userId: ANNA.id, network: 'telegram', type: 'message', chat: grp, id: eid(), sender: KIM, kind: 'unsupported', tooLarge: true, text: null, replyTo: null },
    ]);
    await host.tick();
    const list = (await c.call(app(ANNA), 'GET', 'conversations', null, B)).json.conversations;
    const b = list.find((x) => x.bridge && x.bridge.bot);
    assert.ok(b, JSON.stringify(list.map((x) => x.bridge)));
    assert.equal(b.bridge.label, 'Telegram');
    const g = list.find((x) => x.bridge && x.bridge.members === 340);
    assert.ok(g);
    assert.equal(g.muted, true, 'a group of 200 and more is muted at first');
    assert.equal(b.muted, false);
    const bm = (await c.call(app(ANNA), 'GET', `conversations/${b.id}/messages`, null, B)).json.messages;
    assert.equal(bm[0].bridge.buttons, true);
    const gm = (await c.call(app(ANNA), 'GET', `conversations/${g.id}/messages`, null, B)).json.messages;
    assert.deepEqual([gm[1].bridge.placeholder.kind, gm[1].bridge.placeholder.state, gm[1].bridge.placeholder.reason], ['file', 'failed', 'too_large']);
  });
});

test('„Telegram-Kanäle“: a child sees Telegram channels only with the parents\' second switch (default off)', async () => {
  await withHost({ bridges: READY, services: [familie()] }, async (host, c) => {
    const svc = (name, user, payload) => host.callService(name, { caller: 'gatecontrol-familie', user, payload: payload || {} });
    let r = await svc('bridge_children', { id: ANNA.id });
    assert.deepEqual(r.channels, ['telegram']);
    assert.deepEqual(r.children[0].channels, { telegram: false });
    assert.deepEqual(await svc('bridge_child_set', { id: ANNA.id }, { childId: LENA.id, channels: { telegram: true } }), { ok: false, code: 'invalid' }, 'only next to the permission itself');
    assert.deepEqual(await svc('bridge_child_set', { id: ANNA.id }, { childId: LENA.id, channels: { whatsapp: true } }), { ok: false, code: 'invalid' }, 'only Telegram has the switch');
    r = await svc('bridge_child_set', { id: ANNA.id }, { childId: LENA.id, networks: { telegram: true } });
    assert.deepEqual(r.child.channels, { telegram: false });
    await linkTelegram(c, host, LENA);
    const chRef = host.bridges.chat(LENA.id, { kind: 'group', name: 'Wetter Musterland', channel: true, readOnly: true, network: 'telegram' });
    const channel = { id: chRef, kind: 'group', name: 'Wetter Musterland', channel: true, readOnly: true };
    const post = (text) => ({ userId: LENA.id, network: 'telegram', type: 'message', chat: channel, id: eid(), sender: CH, kind: 'text', text, replyTo: null });
    await host.bridges.deliver([{ userId: LENA.id, network: 'telegram', type: 'chat', chat: channel }, post('Unwetterwarnung')]);
    await host.tick();
    assert.equal((await c.call(app(LENA), 'GET', 'channels', null, BC)).json.channels.length, 0, 'not for the child');
    r = await svc('bridge_child_set', { id: ANNA.id }, { childId: LENA.id, channels: { telegram: true } });
    assert.deepEqual(r.child.channels, { telegram: true });
    await host.bridges.deliver([{ userId: LENA.id, network: 'telegram', type: 'chat', chat: channel }, post('Neue Warnung')]);
    await host.tick();
    const page = (await c.call(app(LENA), 'GET', 'channels', null, BC)).json.channels;
    assert.equal(page.length, 1);
    assert.equal(page[0].bridge.network, 'telegram');
  });
});

test('texts: every Telegram text in German and English', () => {
  for (const k of Object.keys(texts.de).filter((x) => /telegram|br_tg|needs_app|noapp|bc\.(bot|buttons|members)|code_wrong|pw_|other_number|next_step/i.test(x))) {
    assert.ok(typeof texts.en[k] === 'string' && texts.en[k].length, `en: ${k}`);
  }
  assert.equal(texts.de['bc.buttons'], 'Diese Nachricht hat Knöpfe. Öffne sie in {{network}}.');
  assert.equal(texts.de['br.sub_noapp'], 'Noch nicht eingerichtet. Ein Admin muss GateControl einmal bei Telegram anmelden.');
});
