'use strict';

// Messenger (1.6.0): the group „Familie“ in gatecontrol-messenger kept in step with
// the members (sync_group), and the rule action „Messenger-Nachricht senden“
// (send_message) — against the real Messenger plugin in a second mock host, bridged
// through the mock host's services (GateControl ≥ 1.177.0). Without the messenger
// (not installed, gone, or an older GateControl without gc.services) nothing fails.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHost } = require('../../../tools/testing/mock-host');
const { withFamily, app, ANNA, MARC, LENA, TIM, OMA, KUECHE, USERS, MIN, HOUR } = require('./helpers');
const messenger = require('../server/messenger');
const config = require('../server/config');
const ui = require('../server/ui');
const texts = require('../server/texts.json');

const MSG = 'gatecontrol-messenger';
const MSG_DIR = path.join(__dirname, '..', '..', MSG);
const FAMILY = [ANNA.id, MARC.id, LENA.id, TIM.id];
const sorted = (a) => [...a].sort((x, y) => x - y);

const ALL = ['sync_group', 'send_message', 'release_group'];
const V10 = ['sync_group', 'send_message'];

/**
 * The Messenger plugin as a provider of the familie host: a mock host of its own (created on the
 * first call, so it runs on the test clock). bridge.provides = [] makes it "uninstalled";
 * bridge.v10 = true emulates a messenger 1.0.x (no release_group, a list of targets refused as invalid);
 * o.msgUsers: the accounts the messenger knows (default USERS).
 */
function messengerBridge(o = {}) {
  let mh = null;
  const bridge = {
    plugin: MSG,
    v10: !!o.v10,
    provides: o.v10 ? V10.slice() : ALL.slice(),
    async host() {
      if (!mh) { mh = await createHost(MSG_DIR, { users: o.msgUsers || USERS }); await mh.start(); }
      return mh;
    },
    service: async (c) => {
      if (bridge.v10 && c.name === 'send_message' && c.payload && Array.isArray(c.payload.conversation)) return { ok: false, code: 'invalid' };
      return (await bridge.host()).callService(c.name, { caller: c.caller, user: c.user, payload: c.payload });
    },
    /** The messenger API as `user` sees it (the app). */
    async as(user, method, p, body) {
      const h = await bridge.host();
      return h.request({ method, path: p, body: body === undefined ? null : body, query: {}, user: app(user), lang: 'de' });
    },
    /** The conversations of `user` that Familie manages. */
    async managed(user) {
      const r = await bridge.as(user, 'GET', 'conversations');
      return r.json.conversations.filter((c) => c.managedBy === 'gatecontrol-familie');
    },
    async family(user = ANNA) {
      const g = (await bridge.managed(user)).filter((c) => !c.readonly);
      return g.length ? (await bridge.as(user, 'GET', `conversations/${g[0].id}`)).json.conversation : null;
    },
    async conversation(user, id) { return (await bridge.as(user, 'GET', `conversations/${id}`)).json.conversation || null; },
    async messages(user, id) { return (await bridge.as(user, 'GET', `conversations/${id}/messages`)).json.messages; },
    close: () => (mh ? mh.close() : null),
  };
  return bridge;
}

async function withMessenger(opts, fn) {
  const bridge = messengerBridge(opts);
  try {
    return await withFamily({ ...opts, services: [bridge] }, (host, ctx) => fn(host, ctx, bridge));
  } finally {
    await bridge.close();
  }
}

const syncCalls = (host) => host.serviceCalls.filter((c) => c.service === 'sync_group');
const lastLog = async (as) => (await as(ANNA)('GET', '/presence/rules')).json.log[0];

test('the group „Familie“: created with the family (no wall tablet), follows every member change; idempotent', () => withMessenger({ settings: { mod_wall: true } }, async (host, { admin }, m) => {
  // the four members added by the setup are in the group already (one sync per change)
  let g = await m.family();
  assert.ok(g, 'the group exists');
  assert.deepEqual([g.title, g.managedBy, g.readonly, g.can.leave, g.can.manageMembers], ['Familie', 'gatecontrol-familie', false, false, false]);
  assert.deepEqual(sorted(g.members.map((x) => x.userId)), FAMILY);
  assert.ok(syncCalls(host).every((c) => c.ok && c.payload.key === 'family' && c.payload.title === 'Familie'));
  // a wall tablet is no family member; Oma joins; Tim leaves
  assert.equal((await admin('POST', 'members', { userId: KUECHE.id, role: 'wall' })).status, 200);
  assert.equal((await admin('POST', 'members', { userId: OMA.id, role: 'parent' })).status, 200);
  assert.equal((await admin('DELETE', `members/${TIM.id}`)).status, 200);
  g = await m.family();
  assert.deepEqual(sorted(g.members.map((x) => x.userId)), sorted([ANNA.id, MARC.id, LENA.id, OMA.id]));
  assert.equal((await m.as(TIM, 'GET', `conversations/${g.id}`)).status, 404, 'Tim is out');
  // a role change to wall drops the person as well
  assert.equal((await admin('PATCH', `members/${OMA.id}`, { role: 'wall' })).status, 200);
  assert.deepEqual(sorted((await m.family()).members.map((x) => x.userId)), sorted([ANNA.id, MARC.id, LENA.id]));
  // nothing changed: the ticks call nothing (the first tick after start syncs once)
  await host.tick();
  const n = syncCalls(host).length;
  for (let i = 0; i < 3; i++) await host.tick();
  assert.equal(syncCalls(host).length, n, 'no sync while nothing changed');
  // the status on the page „Funktionen“
  const st = (await admin('GET', 'status')).json.messenger;
  assert.deepEqual([st.api, st.available, st.group, st.title, st.sync.ok, st.sync.members, st.sync.conversationId], [true, true, true, 'Familie', true, 3, g.id]);
  // the same group, never a second one
  assert.equal((await m.managed(ANNA)).length, 1);
}));

test('sync at start, every 6 hours and when the title changes; repeated syncs change nothing', () => withMessenger({}, async (host, { clock }, m) => {
  const before = syncCalls(host).length;
  await host.tick();
  assert.equal(syncCalls(host).length, before + 1, 'the first tick after a start syncs');
  const g = await m.family();
  const msgs = (await m.messages(ANNA, g.id)).length;
  await host.tick();
  assert.equal(syncCalls(host).length, before + 1);
  clock.add(6 * HOUR);
  await host.tick();
  assert.equal(syncCalls(host).length, before + 2, 'healed every 6 hours');
  const last = syncCalls(host).at(-1);
  assert.deepEqual(sorted(last.payload.userIds), FAMILY);
  assert.equal((await m.messages(ANNA, g.id)).length, msgs, 'an unchanged sync writes nothing into the chat');
  // the title follows the notification language
  host.settings.notify_lang = 'en';
  await host.tick();
  assert.equal(syncCalls(host).length, before + 3);
  assert.equal((await m.family()).title, 'Family');
}));

test('the switch on „Funktionen“ with a messenger 1.0.x: off stops the sync (the group stays, the release waits), on syncs at once', () => withMessenger({ v10: true }, async (host, { admin }, m) => {
  await host.tick();
  let r = await admin('PUT', 'messenger', { group: false });
  assert.equal(r.status, 200);
  assert.equal(r.json.messenger.group, false);
  assert.equal(config.fromSettings({ messenger_group: false }).messengerGroup, false);
  assert.equal(config.fromSettings({}).messengerGroup, true, 'default on');
  const n = syncCalls(host).length;
  assert.equal((await admin('DELETE', `members/${TIM.id}`)).status, 200);
  await host.tick();
  assert.equal(syncCalls(host).length, n, 'no sync while off');
  assert.deepEqual(sorted((await m.family()).members.map((x) => x.userId)), FAMILY, 'the group stays as it was');
  assert.equal((await admin('POST', 'messenger/sync')).status, 400, 'no manual sync while off');
  assert.deepEqual([(await admin('GET', 'messenger')).json.messenger.release.ok, (await admin('GET', 'messenger')).json.messenger.available], [false, true], 'release pending; the messenger itself is there');
  r = await admin('PUT', 'messenger', { group: true });
  assert.equal(r.json.messenger.group, true);
  assert.deepEqual(sorted((await m.family()).members.map((x) => x.userId)), sorted([ANNA.id, MARC.id, LENA.id]), 'synced at once');
  r = await admin('POST', 'messenger/sync');
  assert.equal(r.json.messenger.sync.ok, true);
  assert.equal((await admin('PUT', 'messenger', { group: 'yes' })).status, 400);
}));

test('rule action „Messenger-Nachricht senden“: into the group with the placeholders, to single people into their own channel', () => withMessenger({ settings: { mod_presence: true } }, async (host, { as }, m) => {
  const rules = (await as(ANNA)('GET', '/presence/rules')).json;
  assert.deepEqual([rules.messenger.available, rules.messenger.group], [true, true], 'the editor offers the action');
  const g = await m.family();
  const r1 = await as(ANNA)('POST', '/presence/rules', { trigger: 'person_home', userId: ANNA.id, actions: [{ type: 'messenger', to: 'family', text: '{name} ist da' }] });
  assert.equal(r1.status, 200, JSON.stringify(r1.json));
  assert.deepEqual(r1.json.rule.actions, [{ type: 'messenger', to: 'family', text: '{name} ist da' }]);
  const r2 = await as(ANNA)('POST', '/presence/rules', { trigger: 'person_home', userId: ANNA.id, actions: [{ type: 'messenger', to: [MARC.id, LENA.id, ANNA.id] }] });
  assert.equal(r2.status, 200);
  await as(ANNA)('PUT', '/presence/consent', { share: true });
  await as(ANNA)('POST', '/presence', { home: true });
  // the group: a message from „GateControl“ (no sender, via Familie)
  const last = (await m.messages(MARC, g.id)).at(-1);
  assert.deepEqual([last.senderId, last.via, last.text, last.system], [null, 'gatecontrol-familie', 'Anna ist da', { event: 'notice' }]);
  // single people: their own read-only channel „Familie-Hinweise“ (1.15.1, not „Familie“ like the group) with the default text; never the person who set it off
  for (const u of [MARC, LENA]) {
    const ch = (await m.managed(u)).filter((c) => c.readonly);
    assert.equal(ch.length, 1, u.name);
    assert.equal(ch[0].title, 'Familie-Hinweise');
    assert.equal((await m.messages(u, ch[0].id)).at(-1).text, 'Anna ist zuhause');
  }
  assert.equal((await m.managed(ANNA)).filter((c) => c.readonly).length, 0, 'Anna set it off');
  const multi = host.serviceCalls.filter((c) => c.service === 'send_message' && Array.isArray(c.payload.conversation));
  assert.deepEqual(multi.map((c) => c.payload.conversation), [[`user:${MARC.id}`, `user:${LENA.id}`]], '1.7.0: both people in one call');
  const log = (await as(ANNA)('GET', '/presence/rules')).json.log;
  const res = log.map((x) => x.results[0]).sort((a, b) => (a.to === 'family' ? -1 : 1) - (b.to === 'family' ? -1 : 1));
  assert.deepEqual(res, [
    { type: 'messenger', to: 'family', ok: true, sent: 1, error: null },
    { type: 'messenger', to: [MARC.id, LENA.id, ANNA.id], ok: true, sent: 2, error: null },
  ]);
  // validation
  for (const [a, field] of [[{ type: 'messenger', to: [] }, 'actions.0.to'], [{ type: 'messenger', to: [OMA.id] }, 'actions.0.to'], [{ type: 'messenger', to: 'all' }, 'actions.0.to'],
    [{ type: 'messenger', to: 'family', text: 'x'.repeat(501) }, 'actions.0.text']]) {
    const r = await as(ANNA)('POST', '/presence/rules', { trigger: 'first_home', actions: [a] });
    assert.deepEqual([r.status, r.json.field], [400, field], JSON.stringify(a));
  }
}));

test('with the group switched off, a rule into the group is not sent (group_off); the editor does not offer the group', () => withMessenger({ settings: { mod_presence: true } }, async (host, { as, admin }) => {
  await host.tick();
  await admin('PUT', 'messenger', { group: false });
  const rules = (await as(ANNA)('GET', '/presence/rules')).json;
  assert.deepEqual([rules.messenger.available, rules.messenger.group], [true, false]);
  await as(ANNA)('POST', '/presence/rules', { trigger: 'person_home', userId: ANNA.id, actions: [{ type: 'messenger', to: 'family' }, { type: 'notify', to: [MARC.id] }] });
  await as(ANNA)('PUT', '/presence/consent', { share: true });
  const sends = host.serviceCalls.filter((c) => c.service === 'send_message').length;
  await as(ANNA)('POST', '/presence', { home: true });
  const entry = await lastLog(as);
  assert.deepEqual(entry.results.map((x) => [x.type, x.ok, x.error]), [['messenger', false, 'group_off'], ['notify', true, null]]);
  assert.equal(host.serviceCalls.filter((c) => c.service === 'send_message').length, sends, 'nothing sent');
}));

test('the messenger disappears: the rule logs „unavailable“, the rest of the rule runs, the action is no longer offered; it comes back', () => withMessenger({ settings: { mod_presence: true } }, async (host, { as, clock, admin }, m) => {
  await host.tick();
  await as(ANNA)('POST', '/presence/rules', { trigger: 'person_home', userId: ANNA.id, actions: [{ type: 'messenger', to: 'family' }, { type: 'notify', to: [MARC.id] }] });
  await as(ANNA)('PUT', '/presence/consent', { share: true });
  m.provides = []; // uninstalled / stopped
  const pushes = host.notifications.length;
  await as(ANNA)('POST', '/presence', { home: true });
  const entry = await lastLog(as);
  assert.deepEqual(entry.results.map((x) => [x.type, x.ok, x.error]), [['messenger', false, 'unavailable'], ['notify', true, null]]);
  assert.equal(host.notifications.length, pushes + 1, 'the push still went out');
  assert.ok(host.logs.some((l) => l.level === 'warn' && l.message.includes('messenger not available')), 'logged');
  let info = (await as(ANNA)('GET', '/presence/rules')).json.messenger;
  assert.deepEqual([info.available, info.reason], [false, 'not_running']);
  assert.equal((await admin('GET', 'status')).json.messenger.available, false);
  // the rule (with its messenger action) can still be read and saved
  const rule = (await as(ANNA)('GET', '/presence/rules')).json.rules[0];
  assert.equal((await as(ANNA)('PATCH', `/presence/rules/${rule.id}`, { name: 'Heim' })).status, 200);
  // back: the retry (free while missing) finds it within 5 minutes
  m.provides = ['sync_group', 'send_message'];
  clock.add(5 * MIN);
  await host.tick();
  info = (await as(ANNA)('GET', '/presence/rules')).json.messenger;
  assert.equal(info.available, true);
}));

test('without the messenger: no errors, the action is hidden, the family works as before; no service call counted', () => withFamily({ settings: { mod_presence: true } }, async (host, { as, admin, clock }) => {
  await host.tick();
  clock.add(MIN);
  await host.tick();
  assert.deepEqual(host.serviceCalls, [], 'refused before counting');
  assert.ok(!host.logs.some((l) => l.level === 'error'));
  const st = (await admin('GET', 'status')).json.messenger;
  assert.deepEqual([st.api, st.available, st.reason, st.group, st.sync && st.sync.ok], [true, false, 'not_running', true, false]);
  assert.equal((await as(ANNA)('GET', '/presence/rules')).json.messenger.available, false);
  // member changes still work
  assert.equal((await admin('POST', 'members', { userId: OMA.id, role: 'parent' })).status, 200);
  assert.equal((await admin('DELETE', `members/${OMA.id}`)).status, 200);
  assert.equal((await admin('POST', 'messenger/sync')).status, 200);
}));

test('with the group off, availability is checked by an empty send_message — only while unknown, then every 6 hours', () => withMessenger({ settings: { messenger_group: false } }, async (host, { clock }) => {
  await host.tick();
  const probes = () => host.serviceCalls.filter((c) => c.service === 'send_message' && Object.keys(c.payload || {}).length === 0).length;
  assert.equal(probes(), 1);
  assert.equal(syncCalls(host).length, 0, 'no group while off');
  await host.tick();
  clock.add(HOUR);
  await host.tick();
  assert.equal(probes(), 1);
  clock.add(6 * HOUR);
  await host.tick();
  assert.equal(probes(), 2);
}));

test('an older GateControl without gc.services: hidden, nothing called, nothing fails', async () => {
  const kv = new Map();
  const logs = [];
  const gc = {
    storage: { get: async (k) => (kv.has(k) ? kv.get(k) : null), set: async (k, v) => { kv.set(k, JSON.parse(JSON.stringify(v))); } },
    settings: { set: async () => {} },
    log: { info: (...a) => logs.push(['info', ...a]), warn: (...a) => logs.push(['warn', ...a]) },
  };
  const cfg = config.fromSettings({});
  const fam = { list: [{ userId: 2 }, { userId: 3 }], byId: new Map([[2, {}], [3, {}]]) };
  assert.equal(messenger.hasApi(gc), false);
  await messenger.tick(gc, fam, cfg, Date.now());
  const info = await messenger.info(gc, cfg);
  assert.deepEqual([info.api, info.available, info.reason], [false, false, 'no_api']);
  const res = await messenger.sendAction(gc, fam, cfg, Date.now(), { type: 'messenger', to: 'family' }, 'x', null);
  assert.deepEqual(res, { type: 'messenger', to: 'family', ok: false, sent: 0, error: 'unavailable' });
  assert.ok(!logs.some((l) => l[0] === 'warn'));
});

test('pages: the card „Messenger“ on „Funktionen“, the messenger tab in the rule editor; German texts', () => {
  const t = (lang, k) => (texts[lang] && texts[lang][k]) || texts.de[k] || k;
  const mods = ui.render({ view: 'page', page: 'modules', lang: 'de' }, t);
  assert.ok(mods.includes('id="fa-msg"') && mods.includes('id="fa-msg-switch"') && mods.includes('function renderMessenger()'));
  assert.ok(mods.includes('Gruppe „Familie“ im Messenger'));
  const pres = ui.render({ view: 'page', page: 'presence', lang: 'de' }, t);
  assert.ok(pres.includes('function messengerPanel()') && pres.includes("'@messenger'"));
  assert.equal(texts.de['rule.m_msg_title'], 'Messenger-Nachricht senden');
});

test('1.7.0: switched off, the group is handed back — a normal group, the parents its admins; on again: a new group', () => withMessenger({ settings: { mod_wall: true } }, async (host, { admin }, m) => {
  await host.tick();
  const g = await m.family();
  const r = await admin('PUT', 'messenger', { group: false });
  assert.equal(r.status, 200);
  const rel = host.serviceCalls.filter((c) => c.service === 'release_group');
  assert.deepEqual(rel.map((c) => [c.payload.key, sorted(c.payload.adminIds), c.ok]), [['family', sorted([ANNA.id, MARC.id]), true]]);
  assert.deepEqual([r.json.messenger.release.ok, r.json.messenger.release.conversationId, r.json.messenger.sync], [true, g.id, null]);
  const conv = await m.conversation(LENA, g.id);
  assert.deepEqual([conv.managedBy, conv.can.leave, conv.me.role], [null, true, 'member'], 'Lena may leave now');
  assert.equal((await m.conversation(ANNA, g.id)).me.role, 'admin');
  assert.equal((await m.conversation(MARC, g.id)).me.role, 'admin');
  assert.equal((await m.as(LENA, 'PATCH', `conversations/${g.id}`, { remove: [LENA.id] })).json.left, true);
  // nothing more to do while off: the ticks release nothing again
  await host.tick();
  assert.equal(host.serviceCalls.filter((c) => c.service === 'release_group').length, 1);
  // on again: a new managed group with the family, the old one stays a normal group
  await admin('PUT', 'messenger', { group: true });
  const g2 = await m.family();
  assert.notEqual(g2.id, g.id);
  assert.deepEqual(sorted(g2.members.map((x) => x.userId)), FAMILY);
  assert.equal((await m.conversation(ANNA, g.id)).managedBy, null);
  // and off again: that one is handed back as well
  await admin('PUT', 'messenger', { group: false });
  assert.equal((await m.conversation(ANNA, g2.id)).managedBy, null);
  assert.equal(host.serviceCalls.filter((c) => c.service === 'release_group').length, 2);
}));

test('1.7.0: a messenger 1.0.x has no release_group — the group stays; once it is updated, the release follows (every 6 hours)', () => withMessenger({ v10: true }, async (host, { admin, clock }, m) => {
  await host.tick();
  const g = await m.family();
  await admin('PUT', 'messenger', { group: false });
  assert.equal((await m.conversation(ANNA, g.id)).managedBy, 'gatecontrol-familie', 'stays managed');
  let info = (await admin('GET', 'messenger')).json.messenger;
  assert.deepEqual([info.available, info.release.ok, info.release.error], [true, false, 'unavailable'], 'the messenger is there, only the service is missing');
  assert.equal(host.serviceCalls.filter((c) => c.service === 'release_group').length, 0, 'refused before counting');
  await host.tick();
  clock.add(HOUR);
  await host.tick();
  m.provides = ALL.slice();
  m.v10 = false;
  clock.add(5 * HOUR);
  await host.tick();
  assert.equal((await m.conversation(ANNA, g.id)).managedBy, null, 'released after the update');
  info = (await admin('GET', 'messenger')).json.messenger;
  assert.deepEqual([info.release.ok, info.sync], [true, null]);
}));

test('1.7.0: several people with a messenger 1.0.x — the list is refused, then one call per person (and so for 6 hours)', () => withMessenger({ v10: true, settings: { mod_presence: true } }, async (host, { as, clock }, m) => {
  await as(ANNA)('POST', '/presence/rules', { trigger: 'person_home', userId: ANNA.id, actions: [{ type: 'messenger', to: [MARC.id, LENA.id] }] });
  await as(ANNA)('PUT', '/presence/consent', { share: true });
  const sends = () => host.serviceCalls.filter((c) => c.service === 'send_message').map((c) => c.payload.conversation);
  await as(ANNA)('POST', '/presence', { home: true });
  assert.deepEqual(sends(), [[`user:${MARC.id}`, `user:${LENA.id}`], `user:${MARC.id}`, `user:${LENA.id}`]);
  assert.deepEqual((await lastLog(as)).results, [{ type: 'messenger', to: [MARC.id, LENA.id], ok: true, sent: 2, error: null }]);
  for (const u of [MARC, LENA]) assert.equal((await m.messages(u, (await m.managed(u)).find((c) => c.readonly).id)).length, 1, u.name);
  // the next run: one call per person straight away
  await as(ANNA)('POST', '/presence', { home: false });
  clock.add(MIN);
  await as(ANNA)('POST', '/presence', { home: true });
  assert.equal(sends().filter((x) => Array.isArray(x)).length, 1);
}));

test('1.7.0: several people — refused targets are counted and named in the rule log', () => withMessenger({ settings: { mod_presence: true }, msgUsers: USERS.filter((u) => u.id !== LENA.id) }, async (host, { as }) => {
  await as(ANNA)('POST', '/presence/rules', { trigger: 'person_home', userId: ANNA.id, actions: [{ type: 'messenger', to: [MARC.id, LENA.id] }] });
  await as(ANNA)('PUT', '/presence/consent', { share: true });
  await as(ANNA)('POST', '/presence', { home: true });
  const res = (await lastLog(as)).results[0];
  assert.deepEqual([res.ok, res.sent, res.error], [false, 1, 'invalid']);
}));

test('1.7.0: GateControl 1.178.0 — with the group off, gc.services.available replaces the empty send_message', () => withMessenger({ gatecontrol: '1.178.0', settings: { messenger_group: false } }, async (host, { clock, admin }, m) => {
  await host.tick();
  assert.deepEqual(host.serviceCalls, [], 'no probe call at all');
  assert.equal((await admin('GET', 'messenger')).json.messenger.available, true);
  m.provides = [];
  clock.add(5 * MIN);
  await host.tick();
  assert.equal((await admin('GET', 'messenger')).json.messenger.available, false, 'found out within 5 minutes, for free');
  m.provides = ALL.slice();
  clock.add(5 * MIN);
  await host.tick();
  assert.equal((await admin('GET', 'messenger')).json.messenger.available, true);
  assert.deepEqual(host.serviceCalls, []);
}));

test('1.7.0: GateControl 1.178.0 — the release asks gc.services.available first (a messenger 1.0.x costs no call)', () => withMessenger({ gatecontrol: '1.178.0', v10: true }, async (host, { admin }, m) => {
  await host.tick();
  const g = await m.family();
  await admin('PUT', 'messenger', { group: false });
  assert.equal(host.serviceCalls.filter((c) => c.service === 'release_group').length, 0);
  assert.equal((await admin('GET', 'messenger')).json.messenger.release.error, 'unavailable');
  m.provides = ALL.slice();
  m.v10 = false;
  await host.start();
  await host.tick();
  assert.equal((await m.conversation(ANNA, g.id)).managedBy, null, 'after a restart the release is tried at once');
}));
