'use strict';

// 1.6.0: the chat sink of GateControl's notification center (GateControl ≥ 1.191.0, permissions.notifySink):
// hook deliverNotice (family group / own notice channels per source, cards with the full text, link, buttons),
// idempotent per notification id, pushes like chat messages (muted → silent; family group: only the people handed
// over), hook mayRouteToFamily (administrators, Familie's parents), conversation fields listPinned / notice.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ADMIN, ANNA, MARC, LENA, OMA } = require('./helpers');

const GC = '1.191.0';
const FAM = 'gatecontrol-familie';
const SCHULE = {
  topic: 'plugin:gatecontrol-schule:messages', source: 'plugin:gatecontrol-schule', sourceLabel: 'Schule', topicLabel: 'Nachrichten der Schule',
  title: 'Nachricht: Wandertag', body: 'Frau Berger: Am Freitag ist Wandertag …', priority: 'normal',
  data: { route: 'plg-gatecontrol-schule', schule: { messageId: '7-123', studentId: 4 } },
};
const LONG = 'Liebe Eltern,\n\n' + 'am Freitag ist Wandertag. '.repeat(200);

/** Familie offering family_roles: parent Marc, child Lena. */
const familie = (o = {}) => ({
  plugin: FAM, provides: ['family_roles'], calls: 0,
  service: async function service() { this.calls++; if (o.fail) throw new Error('down'); return { ok: true, parents: [MARC.id], children: [LENA.id] }; },
});

const familyGroup = (host, ids) => host.callService('sync_group', { caller: FAM, payload: { key: 'family', title: 'Familie', userIds: ids } });

async function convs(c, user) { return (await c.as(user)('GET', 'conversations')).json.conversations; }
async function lastMsg(c, user, convId) { return (await c.as(user)('GET', `conversations/${convId}/messages`)).json.messages.pop(); }

test('own: a read-only notice channel per person and source, one card with the full text, link and source; covered', async () => {
  await withHost({ gatecontrol: GC }, async (host, c) => {
    const card = { text: LONG.slice(0, 4000), link: { label: 'Ganze Nachricht lesen', route: 'plg-gatecontrol-schule' } };
    const r = await host.deliverNotice({ ...SCHULE, id: 41, own: [ANNA.id, MARC.id], card, imageUrl: '/notify-media/abcdefghijklmnopqrstuvwxyz.jpg' });
    assert.deepEqual([r.error, r.covered.sort(), r.fallback], [null, [ANNA.id, MARC.id], []]);
    const list = await convs(c, ANNA);
    assert.equal(list.length, 1);
    const ch = list[0];
    assert.deepEqual([ch.kind, ch.title, ch.readonly, ch.managedBy, ch.listPinned, ch.notice, ch.members.map((m) => m.userId)],
      ['group', 'Schule', true, 'gatecontrol-messenger', false, { source: 'plugin:gatecontrol-schule', label: 'Schule' }, [ANNA.id]]);
    assert.deepEqual(ch.can, { send: false, pin: false, editInfo: false, manageMembers: false, leave: false, setDisappearing: false });
    assert.equal(ch.unread, 1);
    const m = await lastMsg(c, ANNA, ch.id);
    assert.deepEqual([m.kind, m.senderId, m.via, m.text.length], ['card', null, 'gatecontrol-messenger', 4000]);
    assert.deepEqual([m.card.kind, m.card.title, m.card.text.length, m.card.image, m.card.imageUrl], ['notice', 'Nachricht: Wandertag', 4000, null, '/notify-media/abcdefghijklmnopqrstuvwxyz.jpg']);
    assert.deepEqual(m.card.link, { label: 'Ganze Nachricht lesen', route: 'plg-gatecontrol-schule', kind: null });
    assert.deepEqual(m.card.notice, { source: 'plugin:gatecontrol-schule', sourceLabel: 'Schule', topic: 'plugin:gatecontrol-schule:messages', topicLabel: 'Nachrichten der Schule', priority: 'normal', data: SCHULE.data });
    assert.deepEqual(m.card.actions, []);
    // Marc has a channel of his own; nobody else sees Anna's
    const mc = (await convs(c, MARC))[0];
    assert.notEqual(mc.id, ch.id);
    assert.equal((await c.as(MARC)('GET', `conversations/${ch.id}`)).status, 404);
    // pushed like a chat message, titled with the source
    const pushes = c.pushes();
    assert.deepEqual(pushes.map((p) => p.users).flat().sort(), [ANNA.id, MARC.id]);
    assert.deepEqual([pushes[0].title, pushes[0].data.sender.name, pushes[0].priority], ['Schule', 'Schule', 'normal']);
    assert.ok(pushes[0].body.startsWith('Nachricht: Wandertag: Liebe Eltern,'), pushes[0].body.slice(0, 60));
    // the next notification of the source: the same channel; the title follows the source's name; the core: another channel
    await host.deliverNotice({ ...SCHULE, id: 42, sourceLabel: 'Schule Hof', own: [ANNA.id], body: 'Kurz' });
    await host.deliverNotice({ id: 43, topic: 'vpn_down', source: 'core', sourceLabel: 'GateControl', topicLabel: 'VPN', title: 'VPN getrennt', body: 'Peer Handy', priority: 'high', own: [ANNA.id] });
    const after = await convs(c, ANNA);
    assert.equal(after.length, 2);
    assert.deepEqual(after.map((x) => [x.title, x.notice.source]).sort(), [['GateControl', 'core'], ['Schule Hof', 'plugin:gatecontrol-schule']]);
    assert.equal(after.find((x) => x.id === ch.id).unread, 2);
    const vpn = await lastMsg(c, ANNA, after.find((x) => x.notice.source === 'core').id);
    assert.deepEqual([vpn.card.title, vpn.text, vpn.card.notice.priority, vpn.card.link], ['VPN getrennt', 'Peer Handy', 'high', null]);
    assert.equal(c.pushes().pop().priority, 'high', 'high / critical notifications push as high');
    // GET me announces it
    assert.equal((await c.as(ANNA)('GET', 'me')).json.features.notices, true);
  });
});

test('family: ONE card in Familie\'s group, covered = the handed-over members, pushed to them only; listPinned', async () => {
  await withHost({ gatecontrol: GC }, async (host, c) => {
    // no group yet: nobody is covered (the core puts it into their inboxes)
    let r = await host.deliverNotice({ ...SCHULE, id: 1, family: [ANNA.id, MARC.id] });
    assert.deepEqual([r.covered, r.fallback], [[], [ANNA.id, MARC.id]]);
    const g = await familyGroup(host, [ANNA.id, MARC.id, LENA.id]);
    const before = c.pushes().length;
    // Oma is no member → not covered; Lena is a member but not handed over (e.g. muted the topic): sees it, no push
    r = await host.deliverNotice({ ...SCHULE, id: 2, family: [ANNA.id, MARC.id, OMA.id], own: [ADMIN.id] });
    assert.deepEqual([r.covered.sort(), r.fallback], [[ADMIN.id, ANNA.id, MARC.id], [OMA.id]]);
    const msgs = (await c.as(LENA)('GET', `conversations/${g.conversationId}/messages`)).json.messages.filter((m) => m.kind === 'card');
    assert.equal(msgs.length, 1, 'one card for the household');
    assert.deepEqual([msgs[0].card.kind, msgs[0].card.notice.sourceLabel, msgs[0].text], ['notice', 'Schule', SCHULE.body]);
    const pushed = c.pushes().slice(before).filter((p) => p.data.conversation && p.data.conversation.id === String(g.conversationId));
    assert.deepEqual(pushed.map((p) => p.users).flat().sort(), [ANNA.id, MARC.id]);
    // listPinned: the family group only
    const list = await convs(c, ANNA);
    assert.deepEqual(list.map((x) => [x.id, x.listPinned]), [[g.conversationId, true]]);
    const adminList = await convs(c, ADMIN);
    assert.deepEqual(adminList.map((x) => [x.listPinned, !!x.notice]), [[false, true]]);
    // the same notification again (the core retrying): nothing new, the same answer
    r = await host.deliverNotice({ ...SCHULE, id: 2, family: [ANNA.id, MARC.id, OMA.id], own: [ADMIN.id] });
    assert.deepEqual(r.covered.sort(), [ADMIN.id, ANNA.id, MARC.id]);
    assert.equal((await c.as(LENA)('GET', `conversations/${g.conversationId}/messages`)).json.messages.filter((m) => m.kind === 'card').length, 1);
    assert.equal((await convs(c, ADMIN))[0].unread, 1);
  });
});

test('cards: buttons from card.actions / data.actions (quick actions), the first open_app_route as link, run as the presser', async () => {
  const schule = { plugin: 'gatecontrol-schule', quickActions: () => [{ id: 'msg:read', title: 'Gelesen', kind: 'button' }], runQuickAction: () => ({ ok: true, message: 'ok' }) };
  await withHost({ gatecontrol: GC, actions: [schule] }, async (host, c) => {
    const data = { ...SCHULE.data, actions: [
      { type: 'open_app_route', label: 'Öffnen', target: 'plg-gatecontrol-schule' },
      { type: 'quick_action', label: 'Gelesen', plugin: 'gatecontrol-schule', id: 'msg:read' },
      { type: 'quick_action', label: 'Fremd', plugin: 'gatecontrol-messenger', id: 'x' },
      { type: 'callback', id: 'later', label: 'Später' },
    ] };
    await host.deliverNotice({ ...SCHULE, id: 5, own: [ANNA.id], data });
    const ch = (await convs(c, ANNA))[0];
    const m = await lastMsg(c, ANNA, ch.id);
    assert.deepEqual(m.card.link, { label: 'Öffnen', route: 'plg-gatecontrol-schule', kind: null });
    assert.deepEqual(m.card.actions.map((a) => [a.plugin, a.actionId, a.label, a.canRun]), [['gatecontrol-schule', 'msg:read', 'Gelesen', true]]);
    assert.deepEqual(m.card.notice.data, SCHULE.data, 'data without its buttons');
    const run = await c.as(ANNA)('POST', `messages/${m.id}/action/run`, { actionId: 'msg:read' });
    assert.equal(run.json.result.ok, true, JSON.stringify(run.json));
    // card.link wins over the buttons; a bad route is left out
    await host.deliverNotice({ ...SCHULE, id: 6, own: [ANNA.id], data, card: { text: 'x', link: { label: 'Ganze Nachricht lesen', route: 'https://evil' } } });
    const m2 = await lastMsg(c, ANNA, ch.id);
    assert.deepEqual(m2.card.link, { label: 'Öffnen', route: 'plg-gatecontrol-schule', kind: null });
  });
});

test('a muted notice channel stays silent (still covered); bad payloads cover nobody; the hook never throws', async () => {
  await withHost({ gatecontrol: GC }, async (host, c) => {
    await host.deliverNotice({ ...SCHULE, id: 10, own: [ANNA.id] });
    const ch = (await convs(c, ANNA))[0];
    assert.equal((await c.as(ANNA)('PATCH', `conversations/${ch.id}`, { notify: 'none' })).status, 200, 'mute works on a notice channel');
    const n = c.pushes().length;
    const r = await host.deliverNotice({ ...SCHULE, id: 11, own: [ANNA.id] });
    assert.deepEqual(r.covered, [ANNA.id]);
    assert.equal(c.pushes().length, n, 'muted: no push');
    for (const bad of [{ source: 'evil source' }, { topic: 'bad topic!' }, { id: 'a b' }]) {
      const x = await host.deliverNotice({ ...SCHULE, ...bad, own: [ANNA.id] });
      assert.deepEqual([x.covered, x.error], [[], null], JSON.stringify(bad));
    }
    // an unknown or disabled account: not covered
    assert.deepEqual((await host.deliverNotice({ ...SCHULE, id: 12, own: [99] })).covered, []);
    assert.ok((await c.admin('GET', 'log')).json.entries.some((e) => e.code === 'notice_failed' && e.detail === 'invalid'));
    // a member leaving the channel is impossible
    assert.equal((await c.as(ANNA)('PATCH', `conversations/${ch.id}`, { remove: [ANNA.id] })).json.code, 'readonly');
  });
});

test('mayRouteToFamily: administrators and Familie\'s parents; children, others and a missing Familie: no', async () => {
  const fam = familie();
  await withHost({ gatecontrol: GC, services: [fam] }, async (host) => {
    assert.equal(await host.mayRouteToFamily(ADMIN), true);
    assert.equal(await host.mayRouteToFamily(MARC), true, 'a parent');
    assert.equal(await host.mayRouteToFamily(LENA), false, 'a child');
    assert.equal(await host.mayRouteToFamily(OMA), false);
    assert.ok(fam.calls <= 1, 'family_roles cached');
  });
  await withHost({ gatecontrol: GC }, async (host) => {
    assert.equal(await host.mayRouteToFamily(MARC), false, 'no Familie');
  });
  await withHost({ gatecontrol: GC, services: [familie({ fail: true })] }, async (host) => {
    assert.equal(await host.mayRouteToFamily(MARC), false, 'Familie failing');
  });
});

test('older GateControl: no chat sink (the core keeps everything in the inbox)', async () => {
  await withHost({ gatecontrol: '1.190.0' }, async (host) => {
    await assert.rejects(host.deliverNotice({ ...SCHULE, own: [ANNA.id] }), (e) => e.code === 'ERR_SINK_DENIED');
    assert.equal(await host.mayRouteToFamily(MARC), false);
  });
});

test('portal: "Mein Status" above "Angeheftet", then "GateControl" and the listPinned chats; notice channels marked', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'portal.js'), 'utf8');
  const list = src.slice(src.indexOf('function renderList()'), src.indexOf('// ── conversation shell ──'));
  const at = (s) => { const i = list.indexOf(s); assert.ok(i >= 0, s); return i; };
  assert.ok(at('if (strip) rows.appendChild(strip);') < at("T('portal.pinned')"));
  assert.ok(at("T('portal.pinned')") < at('rows.appendChild(inboxRow())'));
  assert.ok(at('rows.appendChild(inboxRow())') < at('pinned.forEach'));
  assert.ok(at('pinned.forEach') < at("T('portal.chats')"));
  assert.ok(src.includes("c.notice ? el('span', { class: 'ms-row-tag', text: T('notice.badge') })"));
  const rich = fs.readFileSync(path.join(__dirname, '..', 'ui', 'rich.js'), 'utf8');
  assert.ok(rich.includes("[n.sourceLabel, n.topicLabel].filter(Boolean).join(' · ')"), 'card head "<source> · <topic>"');
});

const TOPICS = [
  { id: 'vpn_down', label: { de: 'VPN getrennt', en: 'VPN down' }, source: 'core', sourceLabel: 'GateControl' },
  { id: 'security', label: { de: 'Sicherheit', en: 'Security' }, source: 'core', sourceLabel: 'GateControl' },
  { id: 'plugin:gatecontrol-schule:messages', label: { de: 'Nachrichten der Schule', en: 'School messages' }, source: 'plugin:gatecontrol-schule', sourceLabel: 'Schule' },
];

test('portal/notify-routes: GateControl\'s routes of the caller — own, family (parents only), locked, unknown, refusals', async () => {
  await withHost({ gatecontrol: GC, services: [familie()], routeTopics: TOPICS }, async (host, c) => {
    const me = (await c.as(ANNA)('GET', 'me')).json;
    assert.equal(me.features.notice_routes, true);
    let r = await c.as(ANNA)('GET', 'portal/notify-routes');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, sink: true, canFamily: false, groups: [
      { source: 'core', label: 'GateControl', topics: [
        { id: 'vpn_down', label: 'VPN getrennt', dest: 'inbox', locked: false, familySetBy: null },
        { id: 'security', label: 'Sicherheit', dest: 'inbox', locked: true, familySetBy: null }] },
      { source: 'plugin:gatecontrol-schule', label: 'Schule', topics: [
        { id: 'plugin:gatecontrol-schule:messages', label: 'Nachrichten der Schule', dest: 'inbox', locked: false, familySetBy: null }] },
    ] });
    // own chat: for Anna only
    r = await c.as(ANNA)('PUT', 'portal/notify-routes', { topic: 'plugin:gatecontrol-schule:messages', dest: 'own' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.groups[1].topics[0].dest, 'own');
    assert.ok(host.routes.own.get(ANNA.id).has('plugin:gatecontrol-schule:messages'));
    // family: not for Anna (no parent), yes for Marc (Familie's parent) — then for everyone, lifted only by a parent
    r = await c.as(ANNA)('PUT', 'portal/notify-routes', { topic: 'vpn_down', dest: 'family' });
    assert.deepEqual([r.status, r.json.code], [403, 'family_not_allowed']);
    r = await c.as(MARC)('PUT', 'portal/notify-routes', { topic: 'vpn_down', dest: 'family' });
    assert.deepEqual([r.status, r.json.canFamily, r.json.groups[0].topics[0].dest, r.json.groups[0].topics[0].familySetBy], [200, true, 'family', 'Marc']);
    assert.deepEqual((await c.as(ANNA)('GET', 'portal/notify-routes')).json.groups[0].topics[0], { id: 'vpn_down', label: 'VPN getrennt', dest: 'family', locked: false, familySetBy: 'Marc' });
    r = await c.as(ANNA)('PUT', 'portal/notify-routes', { topic: 'vpn_down', dest: 'inbox' });
    assert.deepEqual([r.status, r.json.code], [403, 'family_not_allowed'], 'lifting the household route needs the right');
    r = await c.as(ADMIN)('PUT', 'portal/notify-routes', { topic: 'vpn_down', dest: 'inbox' });
    assert.equal(r.json.groups[0].topics[0].dest, 'inbox', 'an administrator lifts it');
    // refusals
    for (const [body, st, code] of [
      [{ topic: 'security', dest: 'own' }, 409, 'locked'],
      [{ topic: 'plugin:other:x', dest: 'own' }, 404, 'not_found'],
      [{ topic: 'vpn_down', dest: 'elsewhere' }, 400, 'invalid'],
      [{ dest: 'own' }, 400, 'invalid'],
    ]) {
      r = await c.as(ANNA)('PUT', 'portal/notify-routes', body);
      assert.deepEqual([r.status, r.json.code], [st, code], JSON.stringify(body));
    }
    // English labels in an English request
    r = await host.request({ method: 'GET', path: 'portal/notify-routes', query: {}, body: null, user: { ...ANNA, portal: true, loggedIn: true }, lang: 'en' });
    assert.equal(r.json.groups[0].topics[0].label, 'VPN down');
  });
});

test('portal/notify-routes: no active sink → sink false and no_sink; older GateControl → routes_off, no feature', async () => {
  await withHost({ gatecontrol: GC, routeTopics: TOPICS, sinkActive: false }, async (host, c) => {
    const r = await c.as(ANNA)('GET', 'portal/notify-routes');
    assert.deepEqual([r.json.sink, r.json.canFamily], [false, false]);
    const p = await c.as(ANNA)('PUT', 'portal/notify-routes', { topic: 'vpn_down', dest: 'own' });
    assert.deepEqual([p.status, p.json.code], [409, 'no_sink']);
  });
  await withHost({ gatecontrol: '1.190.0' }, async (host, c) => {
    assert.equal((await c.as(ANNA)('GET', 'me')).json.features.notice_routes, undefined);
    const r = await c.as(ANNA)('GET', 'portal/notify-routes');
    assert.deepEqual([r.status, r.json.code], [409, 'routes_off']);
  });
});

test('portal: "Wo Mitteilungen erscheinen" from the chat settings and a notice channel\'s info; GateControl / Familien-Chat (canFamily) / Eigener Chat', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const rich = fs.readFileSync(path.join(__dirname, '..', 'ui', 'rich.js'), 'utf8');
  const portal = fs.readFileSync(path.join(__dirname, '..', 'ui', 'portal.js'), 'utf8');
  assert.ok(rich.includes("if (f.notice_routes)") && rich.includes('noticeRoutes();'));
  assert.ok(rich.includes("M.api('GET', 'portal/notify-routes')") && rich.includes("M.api('PUT', 'portal/notify-routes'"));
  assert.ok(rich.includes("if (v.canFamily) opts.push(['family', T('routes.family'), T('routes.family_hint')]);"));
  assert.ok(rich.includes("T('routes.locked')") && rich.includes("T('routes.no_sink')"));
  assert.ok(portal.includes('R.noticeRoutes()'));
  assert.ok(rich.includes("T(r.chat.created ? 'routes.chat_created' : 'routes.chat_used'"), '1.7.0: the toast after "own chat"');
});

test('1.7.0 ensureNoticeChat: choosing "own chat" creates the source\'s channel at once, then finds it; portal toast data', async () => {
  await withHost({ gatecontrol: '1.192.0', services: [familie()], routeTopics: TOPICS }, async (host, c) => {
    // the portal page: own → GateControl had the chat created (empty, read-only, only Anna)
    let r = await c.as(ANNA)('PUT', 'portal/notify-routes', { topic: 'plugin:gatecontrol-schule:messages', dest: 'own' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const list = await convs(c, ANNA);
    assert.equal(list.length, 1);
    const ch = list[0];
    assert.deepEqual([ch.title, ch.readonly, ch.notice, ch.members.map((m) => m.userId), ch.unread], ['Schule', true, { source: 'plugin:gatecontrol-schule', label: 'Schule' }, [ANNA.id], 0]);
    assert.deepEqual(r.json.chat, { source: 'plugin:gatecontrol-schule', label: 'Schule', conversationId: String(ch.id), created: true });
    assert.ok(c.events('conversation.update').some((e) => e.users.includes(ANNA.id) && e.data.reason === 'created'), 'the chat list learns of it at once');
    // again (another topic of the same source would do the same): the existing chat
    r = await c.as(ANNA)('PUT', 'portal/notify-routes', { topic: 'plugin:gatecontrol-schule:messages', dest: 'own' });
    assert.deepEqual(r.json.chat, { source: 'plugin:gatecontrol-schule', label: 'Schule', conversationId: String(ch.id), created: false });
    // the next notification lands in that very chat
    await host.deliverNotice({ ...SCHULE, id: 77, own: [ANNA.id] });
    assert.deepEqual((await convs(c, ANNA)).map((x) => [x.id, x.unread]), [[ch.id, 1]]);
    // GateControl's own topics: a chat "GateControl" of its own
    r = await c.as(ANNA)('PUT', 'portal/notify-routes', { topic: 'vpn_down', dest: 'own' });
    assert.deepEqual([r.json.chat.source, r.json.chat.label, r.json.chat.created], ['core', 'GateControl', true]);
    assert.equal((await convs(c, ANNA)).length, 2);
    // inbox → no chat; Marc's chat is his own
    r = await c.as(ANNA)('PUT', 'portal/notify-routes', { topic: 'vpn_down', dest: 'inbox' });
    assert.equal(r.json.chat, null);
    r = await c.as(MARC)('PUT', 'portal/notify-routes', { topic: 'plugin:gatecontrol-schule:messages', dest: 'own' });
    assert.equal(r.json.chat.created, true);
    assert.notEqual(r.json.chat.conversationId, String(ch.id));
  });
});

test('1.7.0 ensureNoticeChat: bad arguments → null (never throws); an older GateControl → chat null', async () => {
  await withHost({ gatecontrol: '1.192.0', routeTopics: TOPICS }, async (host, c) => {
    const plugin = require('../server/index.js');
    for (const arg of [null, {}, { user: { id: 999 }, source: 'core' }, { user: { id: ANNA.id }, source: 'nope' }, { user: { id: ANNA.id } }]) {
      assert.equal(await plugin.ensureNoticeChat(arg, host.gc), null, JSON.stringify(arg));
    }
    assert.equal((await convs(c, ANNA)).length, 0);
  });
  await withHost({ gatecontrol: GC, routeTopics: TOPICS }, async (host, c) => {
    const r = await c.as(ANNA)('PUT', 'portal/notify-routes', { topic: 'plugin:gatecontrol-schule:messages', dest: 'own' });
    assert.deepEqual([r.status, r.json.chat], [200, null]);
    assert.equal((await convs(c, ANNA)).length, 0, 'a 1.191 host: the chat comes with the first notification');
  });
});
