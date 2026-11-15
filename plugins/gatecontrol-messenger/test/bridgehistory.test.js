'use strict';

// 1.17.0: older messages, the phone warning, the media area, the snapshot — against the mock host's gc.bridges
// version 5 (tools/testing/mock-bridges.js: deliverHistory = GateControl's bridge_backlog, phoneOffline / clientOutdated
// = the bridge's own words about a login).
//
//   history    what a person chooses (GET/PUT bridges/history); at night a small portion per run, without push, as
//              read, one conversation.update per chat; by day nothing; a file of it only on request
//   in order   history GateControl hands over in the normal stream (before a new message of the chat): no push either
//   phone      the bridge's warning → once a push, the hint in GET bridges; gone when the phone is back
//   storage    files of bridged chats go into the sealed media area „bruecken“ (GateControl with media areas)
//   admin      the history switch, the night window, „Jetzt sichern“, what the card shows — numbers only

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, app, ADMIN, ANNA, MARC } = require('./helpers');

const V5 = { enabled: true, networks: { whatsapp: true }, running: true, version: 5 };
const B = { bridged: '1' };
const KIM = { id: 'c' + 'k'.repeat(21), name: 'Kim Muster' };
const DAY = 86400000;
// 02:30 in Berlin (October: UTC+2) — in the default night window 01:00–05:00
const NIGHT = Date.UTC(2026, 9, 17, 0, 30, 0);
// 12:00 in Berlin
const NOON = Date.UTC(2026, 9, 17, 10, 0, 0);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 9)]);
let n = 0;
const eid = () => `$h${++n}`;

async function link(c, host, user) {
  const me = c.as(user);
  assert.equal((await me('POST', 'bridges/whatsapp/consent', { accept: true })).status, 200);
  let r = await me('POST', 'bridges/whatsapp/login', { flow: 'qr' });
  host.bridges.confirm(r.json.login.processId);
  r = await me('POST', `bridges/whatsapp/login/${r.json.login.processId}/${r.json.login.step.id}`, {});
  assert.equal(r.json.login.step.type, 'complete');
  return host.bridges.state.logins.get(user.id)[0].id;
}
const text = (chat, body, at, extra = {}) => ({ userId: ANNA.id, type: 'message', chat, id: eid(), sender: KIM, kind: 'text', text: body, replyTo: null, at, ...extra });
const list = async (c, user = ANNA) => (await c.call(app(user), 'GET', 'conversations', null, B)).json.conversations;
const msgs = async (c, convId, user = ANNA) => (await c.call(app(user), 'GET', `conversations/${convId}/messages`, null, B)).json.messages;

test('a GateControl without history (version 4): no choice, no feature word, nothing pulled', async () => {
  await withHost({ bridges: { ...V5, version: 4 } }, async (host, c) => {
    await link(c, host, ANNA);
    const b = (await c.as(ANNA)('GET', 'bridges')).json.bridges;
    assert.equal(b.history, null);
    assert.equal((await c.as(ANNA)('GET', 'me')).json.features.bridge_history, undefined);
    assert.equal((await c.as(ANNA)('PUT', 'bridges/history', { days: 0 })).json.code, 'feature_off');
    const a = (await c.admin('GET', 'bridges')).json.bridges;
    assert.deepEqual([a.history.available, a.backup, a.cleanup, a.media], [false, null, null, null]);
  });
});

test('history: each person chooses (off, 30 days, everything) — only for themselves, only from the offered values', async () => {
  await withHost({ bridges: V5 }, async (host, c) => {
    await link(c, host, ANNA);
    let b = (await c.as(ANNA)('GET', 'bridges')).json.bridges;
    assert.deepEqual(b.history, { available: true, days: 30, default: 30, options: [0, 30, -1], pending: 0 });
    assert.equal((await c.as(ANNA)('GET', 'me')).json.features.bridge_history, true);
    assert.equal((await c.as(MARC)('GET', 'me')).json.features.bridge_history, undefined, 'only once a service is linked');
    for (const days of [7, '30', null, 90]) assert.equal((await c.as(ANNA)('PUT', 'bridges/history', { days })).json.code, 'invalid');
    const r = await c.as(ANNA)('PUT', 'bridges/history', { days: -1 });
    assert.equal(r.status, 200);
    assert.equal(r.json.history.days, -1);
    assert.deepEqual(host.bridges.state.log.filter((x) => x.op === 'history_set'), [{ op: 'history_set', userId: ANNA.id, days: -1 }]);
    // switched off by the administrator: shown, but not offered
    host.bridges.setHistory(false);
    b = (await c.as(ANNA)('GET', 'bridges')).json.bridges;
    assert.equal(b.history.available, false);
  });
});

test('at night a small portion: filed in order, without push, as read, one live event per chat; by day nothing', async () => {
  await withHost({ bridges: V5, at: NOON }, async (host, c) => {
    await link(c, host, ANNA);
    const ref = host.bridges.chat(ANNA.id, { name: 'Kim Muster' });
    const chat = { id: ref, kind: 'direct', name: 'Kim Muster' };
    const old = NOON - 10 * DAY;
    const first = text(chat, 'Vor zehn Tagen', old);
    await host.bridges.deliverHistory([first, text(chat, 'Neun Tage', old + DAY), text(chat, 'Acht Tage', old + 2 * DAY)]);
    await host.tick();
    assert.equal(host.bridges.backlog.length, 3, 'by day nothing is taken');
    assert.equal((await list(c)).length, 0);

    c.clock.set(NIGHT + DAY);
    c.resetEvents();
    await host.tick();
    assert.equal(host.bridges.backlog.length, 0, 'filed and acknowledged');
    const [conv] = await list(c);
    assert.equal(conv.unread, 0, 'history is read');
    const m = await msgs(c, conv.id);
    assert.deepEqual(m.map((x) => x.text), ['Vor zehn Tagen', 'Neun Tage', 'Acht Tage']);
    assert.equal(m[0].createdAt, new Date(old).toISOString(), 'at its own time');
    assert.equal(c.pushes().length, 0, 'no push for history');
    assert.equal(c.events('message.new').length, 0);
    assert.deepEqual(c.events('conversation.update').map((e) => e.data.reason), ['history']);
    // the same piece again (a crash before the acknowledgement): nothing twice
    await host.bridges.deliverHistory([first]);
    c.clock.add(60000);
    await host.tick();
    assert.equal((await msgs(c, conv.id)).length, 3);
  });
});

test('history in the normal stream (before a new message of its chat): no push for it, the new one pushes', async () => {
  await withHost({ bridges: V5, at: NOON }, async (host, c) => {
    await link(c, host, ANNA);
    const ref = host.bridges.chat(ANNA.id, { name: 'Kim Muster' });
    const chat = { id: ref, kind: 'direct', name: 'Kim Muster' };
    await host.bridges.deliver([text(chat, 'Alt', NOON - 3 * DAY, { history: true }), text(chat, 'Neu', NOON)]);
    const [conv] = await list(c);
    assert.deepEqual((await msgs(c, conv.id)).map((x) => x.text), ['Alt', 'Neu']);
    assert.equal(c.pushes().length, 1, 'only the new message');
    assert.equal(conv.unread, 1);
  });
});

test('a file of the history waits until the person asks for it', async () => {
  await withHost({ bridges: V5, at: NIGHT, scan: true }, async (host, c) => {
    await link(c, host, ANNA);
    const ref = host.bridges.chat(ANNA.id, { name: 'Kim Muster' });
    const chat = { id: ref, kind: 'direct', name: 'Kim Muster' };
    const file = host.bridges.file(ANNA.id, { data: JPEG, mime: 'image/jpeg' });
    await host.bridges.deliverHistory([{ userId: ANNA.id, type: 'message', chat, id: eid(), sender: KIM, kind: 'media', media: { kind: 'image', name: 'alt.jpg', ref: file, mime: 'image/jpeg', size: JPEG.length }, text: null, replyTo: null, at: NIGHT - 5 * DAY }]);
    await host.tick();
    await host.tick();
    assert.equal(host.bridges.fetches.length, 0, 'not fetched by itself');
    const [conv] = await list(c);
    let [m] = await msgs(c, conv.id);
    assert.deepEqual([m.kind, m.bridge.placeholder.state], ['text', 'on_request']);
    assert.equal((await c.as(MARC)('POST', `messages/${m.id}/fetch`, {}, B)).status, 404, 'nobody else');
    const r = await c.call(app(ANNA), 'POST', `messages/${m.id}/fetch`, {}, B);
    assert.equal(r.status, 200);
    await host.tick();
    [m] = await msgs(c, conv.id);
    assert.equal(m.kind, 'image');
    assert.equal(host.bridges.fetches.length, 1);
    assert.equal((await c.call(app(ANNA), 'POST', `messages/${m.id}/fetch`, {}, B)).json.code, 'invalid', 'once');
  });
});

test('phone not seen: one push, the hint under the service; gone when the phone is back', async () => {
  await withHost({ bridges: V5, at: NOON }, async (host, c) => {
    const login = await link(c, host, ANNA);
    host.bridges.phoneOffline(ANNA.id, login, new Date(NOON - 2 * DAY).toISOString());
    await host.tick();
    let push = host.notifications.filter((x) => x.topic === 'bridge');
    assert.equal(push.length, 1);
    assert.deepEqual(push[0].users, [ANNA.id]);
    assert.match(push[0].title, /Handy seit 14 Tagen nicht gesehen/);
    let b = (await c.as(ANNA)('GET', 'bridges')).json.bridges;
    assert.deepEqual(b.networks[0].phone, { offline: true, days: 14, leftDays: 0 });
    assert.equal(b.networks[0].logins[0].state, 'connected', 'the link still works');
    // the next hour: no second push for the same time
    c.clock.add(3600000 + 1);
    await host.tick();
    assert.equal(host.notifications.filter((x) => x.topic === 'bridge').length, 1);
    assert.equal((await c.admin('GET', 'bridges')).json.bridges.networks[0].phoneOffline, 1, 'the card counts, names nobody');
    // back
    host.bridges.phoneOffline(ANNA.id, login, null);
    c.clock.add(3600000 + 1);
    await host.tick();
    b = (await c.as(ANNA)('GET', 'bridges')).json.bridges;
    assert.equal(b.networks[0].phone.offline, false);
    push = host.notifications.filter((x) => x.topic === 'bridge');
    assert.equal(push.length, 1);
    assert.doesNotMatch(JSON.stringify(push), /\+49/, 'no number in a push');
  });
});

test('WhatsApp turns the bridge’s version away: „veraltet“ for the person and on the card', async () => {
  await withHost({ bridges: V5 }, async (host, c) => {
    const login = await link(c, host, ANNA);
    host.bridges.clientOutdated(ANNA.id, login, true);
    const b = (await c.as(ANNA)('GET', 'bridges')).json.bridges;
    assert.equal(b.networks[0].clientOutdated, true);
    assert.equal((await c.admin('GET', 'bridges')).json.bridges.networks[0].clientOutdated, true);
  });
});

test('storage: files of bridged chats go into the sealed media area „bruecken“; the card shows where', async () => {
  await withHost({ bridges: V5, gatecontrol: '1.204.0', scan: true }, async (host, c) => {
    await link(c, host, ANNA);
    const ref = host.bridges.chat(ANNA.id, { name: 'Kim Muster' });
    const chat = { id: ref, kind: 'direct', name: 'Kim Muster' };
    const file = host.bridges.file(ANNA.id, { data: JPEG, mime: 'image/jpeg' });
    await host.bridges.deliver([{ userId: ANNA.id, type: 'message', chat, id: eid(), sender: KIM, kind: 'media', media: { kind: 'image', name: 'a.jpg', ref: file, mime: 'image/jpeg', size: JPEG.length }, text: null, replyTo: null }]);
    await host.tick();
    const area = host.mediaAreas.get('bruecken');
    assert.ok(area, 'made');
    assert.equal(area.sealed, true);
    const [conv] = await list(c);
    const [m] = await msgs(c, conv.id);
    assert.equal(m.kind, 'image');
    assert.equal(host.media.get(m.media.id).area, 'bruecken');
    const a = (await c.admin('GET', 'bridges')).json.bridges;
    assert.deepEqual([a.media.target.kind, a.media.count, a.media.encrypted], ['server', 1, true]);
  });
});

test('admin: the history switch, the night window, „Jetzt sichern“ — administrators only', async () => {
  await withHost({ bridges: V5 }, async (host, c) => {
    let a = (await c.admin('GET', 'bridges')).json.bridges;
    assert.deepEqual([a.history.available, a.history.enabled, a.history.from, a.history.to, a.history.default], [true, true, '01:00', '05:00', 30]);
    assert.deepEqual([a.backup.time, a.backup.requested], ['03:10', false]);
    a = (await c.admin('PUT', 'bridges', { history: false })).json.bridges;
    assert.equal(a.history.enabled, false);
    a = (await c.admin('PUT', 'bridges', { historyFrom: '23:30', historyTo: '04:00' })).json.bridges;
    assert.deepEqual([a.history.from, a.history.to], ['23:30', '04:00']);
    for (const bad of [{ historyFrom: '25:00' }, { historyFrom: '01:00', enabled: true }, { backupNow: false }, { backupTime: '3:10' }, { history: 'yes' }]) {
      assert.equal((await c.admin('PUT', 'bridges', bad)).json.code, 'invalid', JSON.stringify(bad));
    }
    a = (await c.admin('PUT', 'bridges', { backupNow: true })).json.bridges;
    assert.equal(a.backup.requested, true);
    a = (await c.admin('PUT', 'bridges', { backupTime: '02:45' })).json.bridges;
    assert.equal(a.backup.time, '02:45');
    assert.equal((await c.call({ ...ANNA, portal: true, loggedIn: true }, 'PUT', '/admin/bridges', { backupNow: true })).status, 403);
    assert.doesNotMatch(JSON.stringify(a), /Kim|\+49/);
    assert.equal(ADMIN.role, 'admin');
  });
});

test('a login is named by GateControl’s reference — a phone number kept by an older version is replaced at the start', async () => {
  await withHost({ bridges: V5 }, async (host, c) => {
    const login = await link(c, host, ANNA);
    assert.match(login, /^l[A-Za-z0-9_-]{22}$/, 'the mock host hands out references like GateControl');
    // what Messenger ≤ 1.16 kept: the bridge's own id (at WhatsApp the person's number)
    await host.gc.db.query("INSERT INTO bridge_links (user_id, network, login_id, state, linked_at, seen_at) VALUES (3, 'whatsapp', '4915198765432', 'connected', 1, 1)");
    await host.start();
    const rows = (await host.gc.db.query('SELECT user_id, login_id FROM bridge_links ORDER BY user_id')).rows;
    assert.doesNotMatch(JSON.stringify(rows), /4915198765432/);
    assert.equal(rows.find((r) => r.user_id === ANNA.id).login_id, login, 'a reference stays as it is');
    assert.match(rows.find((r) => r.user_id === 3).login_id, /^h1\./);
    // unlinking by the reference still works
    const b = (await c.as(ANNA)('GET', 'bridges')).json.bridges;
    assert.equal(b.networks[0].logins[0].id, login);
    assert.equal((await c.as(ANNA)('DELETE', `bridges/whatsapp/logins/${login}`)).status, 200);
  });
});
