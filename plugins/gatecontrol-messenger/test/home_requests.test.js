'use strict';

// 1.5.0: home actions for families — GET actions/requestable (what a person may ask for, also without the
// right), request approvers 'parents' (Familie's family_roles; without Familie 'rights') | 'rights' | [ids],
// approving needs the right still, requestTtlMin, childrenMayRequest, grant offAtEnd (the device off as the
// granter when the grant ends) and grantMaxDays, the target 'direct:<id>' of send_message, GET me homeActions.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ADMIN, ANNA, MARC, LENA, OMA, MIN, HOUR, DAY, T0 } = require('./helpers');

const iso = (ms) => new Date(ms).toISOString();

/** The door and a light: who may run what (changeable during a test). */
function home() {
  const can = { 'lock1:open': [ANNA.id, MARC.id], 'light:1': [ANNA.id, OMA.id], 'scene:1': [ANNA.id] };
  const p = {
    can,
    plugin: 'gatecontrol-door', pluginName: 'Tür',
    quickActions: (v) => [
      { id: 'lock1:open', title: 'Haustür öffnen', kind: 'button' },
      { id: 'light:1', title: 'Flurlicht', kind: 'toggle', state: 'on' },
      { id: 'scene:1', title: 'Gute Nacht', kind: 'button' },
    ].filter((a) => can[a.id].includes(v.id)),
    runQuickAction: (v, id) => ({ ok: true, message: id === 'light:1' ? 'Licht aus' : 'ok', state: id === 'light:1' ? 'off' : undefined }),
  };
  return p;
}

/** Familie offering family_roles: parents Anna and Marc, child Lena. */
const familie = (o = {}) => ({
  plugin: 'gatecontrol-familie', provides: ['family_roles'], calls: 0,
  service: async function service() { this.calls++; return o.answer || { ok: true, parents: [ANNA.id, MARC.id], children: [LENA.id] }; },
});

test('requestable: the approvers\' actions (also without the own right), parents from Familie, rights, a list, a chat; approvers of a request', async () => {
  const h = home();
  const fam = familie();
  await withHost({ actions: [h], services: [fam] }, async (host, c) => {
    const lena = c.as(LENA);
    let r = (await lena('GET', 'actions/requestable')).json;
    assert.deepEqual([r.approvers, r.approversDefault, r.canRequest, r.requestTtlMin], ['parents', 'parents', true, 15]);
    assert.deepEqual(r.actions.map((a) => [a.id, a.plugin, a.label, a.approverIds, a.self]), [
      ['lock1:open', 'gatecontrol-door', 'Haustür öffnen', [ANNA.id, MARC.id], false],
      ['light:1', 'gatecontrol-door', 'Flurlicht', [ANNA.id], false],
      ['scene:1', 'gatecontrol-door', 'Gute Nacht', [ANNA.id], false],
    ]);
    r = (await lena('GET', 'actions/requestable', null, { approvers: 'rights' })).json;
    assert.equal(r.approvers, 'rights');
    assert.deepEqual(r.actions.find((a) => a.id === 'light:1').approverIds, [ANNA.id, OMA.id]);
    r = (await lena('GET', 'actions/requestable', null, { approvers: String(MARC.id) })).json;
    assert.deepEqual([r.approvers, r.actions.map((a) => a.id)], ['list', ['lock1:open']]);
    const g2 = await c.group(LENA, [ANNA]);
    r = (await lena('GET', 'actions/requestable', null, { conversationId: String(g2.id) })).json;
    assert.deepEqual(r.actions.map((a) => a.approverIds), [[ANNA.id], [ANNA.id], [ANNA.id]], 'only members of that chat');
    assert.equal((await lena('GET', 'actions/requestable', null, { approvers: 'kids' })).json.code, 'invalid');
    // Oma sees Anna's actions too, and knows which she may run herself
    r = (await c.as(OMA)('GET', 'actions/requestable', null, { approvers: 'rights' })).json;
    assert.equal(r.actions.find((a) => a.id === 'light:1').self, true);
    // a request without approvers: the default (parents) among the members who may run it
    const g = await c.group(ANNA, [MARC, LENA, OMA]);
    const q = await c.send(LENA, g.id, { kind: 'action', action: { mode: 'request', actionId: 'light:1', plugin: 'gatecontrol-door' } });
    assert.deepEqual([q.action.approverIds, q.action.approvers, q.action.expiresAt], [[ANNA.id], 'parents', iso(Date.now() + 15 * MIN)]);
    assert.equal((await c.as(OMA)('POST', `messages/${q.id}/action/approve`)).json.code, 'not_allowed', 'not a parent');
    const q2 = await c.send(LENA, g.id, { kind: 'action', action: { mode: 'request', actionId: 'light:1', approvers: 'rights' } });
    assert.deepEqual([q2.action.approverIds.sort(), q2.action.approvers], [[ANNA.id, OMA.id], 'rights']);
    const q3 = await c.send(LENA, g.id, { kind: 'action', action: { mode: 'request', actionId: 'lock1:open', approvers: [MARC.id, OMA.id] } });
    assert.deepEqual([q3.action.approverIds, q3.action.approvers], [[MARC.id], 'list'], 'Oma may not open');
    // approving needs the right still: Anna loses the light
    h.can['light:1'] = [OMA.id];
    c.clock.add(21 * 1000);
    assert.equal((await c.as(ANNA)('POST', `messages/${q.id}/action/approve`)).json.code, 'not_allowed');
    let a = await c.as(OMA)('POST', `messages/${q2.id}/action/approve`);
    assert.deepEqual([a.json.message.action.state, a.json.result.ok], ['done', true]);
    // after 15 minutes a request is closed, the background run marks it expired
    c.clock.add(15 * MIN);
    assert.equal((await c.as(MARC)('POST', `messages/${q3.id}/action/approve`)).json.code, 'closed');
    await host.tick();
    assert.equal((await c.as(LENA)('GET', `conversations/${g.id}/messages`)).json.messages.find((x) => x.id === q3.id).action.state, 'expired');
    // the administrator's time
    await c.admin('PUT', 'settings', { requestTtlMin: 60 });
    const q4 = await c.send(LENA, g.id, { kind: 'action', action: { mode: 'request', actionId: 'lock1:open' } });
    c.clock.add(30 * MIN);
    a = await c.as(MARC)('POST', `messages/${q4.id}/action/approve`);
    assert.equal(a.json.result.ok, true);
    assert.equal((await c.admin('PUT', 'settings', { requestTtlMin: 7 })).json.code, 'invalid');
    assert.ok(fam.calls <= 2, `family_roles cached (${fam.calls} calls)`);
  });
});

test('childrenMayRequest off: Familie\'s children cannot ask (requestable empty, request not_allowed); parents can; GET me homeActions', async () => {
  await withHost({ actions: [home()], services: [familie()] }, async (host, c) => {
    await c.admin('PUT', 'settings', { childrenMayRequest: false });
    const g = await c.group(ANNA, [MARC, LENA]);
    const r = (await c.as(LENA)('GET', 'actions/requestable')).json;
    assert.deepEqual([r.canRequest, r.actions], [false, []]);
    assert.equal((await c.as(LENA)('POST', `conversations/${g.id}/messages`, { clientId: c.cid(), kind: 'action', action: { mode: 'request', actionId: 'lock1:open' } })).json.code, 'not_allowed');
    assert.equal((await c.send(MARC, g.id, { kind: 'action', action: { mode: 'request', actionId: 'light:1' } })).action.approverIds[0], ANNA.id);
    const me = (await c.as(LENA)('GET', 'me')).json;
    assert.deepEqual(me.homeActions, { available: true, reason: null, approversDefault: 'parents', childrenMayRequest: false, familyRoles: true, canRequest: false, doorbell: null });
    assert.deepEqual(['actions', 'action_requests', 'grant_off'].map((k) => me.features[k]), [true, true, true]);
    assert.deepEqual([me.limits.requestTtlMin, me.limits.grantMaxDays], [15, 7]);
    assert.equal((await c.as(ANNA)('GET', 'me')).json.homeActions.canRequest, true);
    assert.equal((await c.admin('GET', 'settings')).json.familyRoles, true);
  });
});

test('without Familie (or Familie refusing): \'parents\' is \'rights\', the default is rights; reasons in GET me', async () => {
  await withHost({ actions: [home()] }, async (host, c) => {
    const g = await c.group(ANNA, [MARC, LENA, OMA]);
    const q = await c.send(LENA, g.id, { kind: 'action', action: { mode: 'request', actionId: 'light:1', approvers: 'parents' } });
    assert.deepEqual([q.action.approverIds.sort(), q.action.approvers], [[ANNA.id, OMA.id], 'rights']);
    const me = (await c.as(LENA)('GET', 'me')).json.homeActions;
    assert.deepEqual([me.approversDefault, me.familyRoles, me.canRequest], ['rights', false, true]);
    await c.admin('PUT', 'settings', { requestApproversDefault: 'parents', childrenMayRequest: false });
    assert.equal((await c.as(LENA)('GET', 'actions/requestable')).json.approvers, 'rights', 'no Familie → rights');
    assert.equal((await c.as(LENA)('GET', 'actions/requestable')).json.canRequest, true, 'without Familie nobody is a child');
    await c.admin('PUT', 'settings', { allowActions: false });
    assert.deepEqual([(await c.as(LENA)('GET', 'me')).json.homeActions.available, (await c.as(LENA)('GET', 'me')).json.homeActions.reason], [false, 'off']);
    assert.equal((await c.as(LENA)('GET', 'actions/requestable')).json.code, 'feature_off');
  });
  await withHost({ actions: [home()], services: [familie({ answer: { ok: false, code: 'forbidden' } })] }, async (host, c) => {
    const g = await c.group(ANNA, [MARC, LENA, OMA]);
    const q = await c.send(LENA, g.id, { kind: 'action', action: { mode: 'request', actionId: 'light:1' } });
    assert.deepEqual([q.action.approverIds.sort(), q.action.approvers], [[ANNA.id, OMA.id], 'rights'], 'Familie refuses → rights');
  });
  await withHost({ actionsApi: false }, async (host, c) => {
    assert.deepEqual((await c.as(LENA)('GET', 'me')).json.homeActions.reason, 'host');
  });
});

test('grant: grantMaxDays; offAtEnd switches a toggle off as the granter when it ends (system message grant_off); not for buttons', async () => {
  const h = home();
  await withHost({ actions: [h] }, async (host, c) => {
    const g = await c.group(ANNA, [LENA]);
    const grant = (actionId, until, extra = {}) => c.as(ANNA)('POST', `conversations/${g.id}/messages`, { clientId: c.cid(), kind: 'action', action: { mode: 'grant', actionId, grant: { toUserId: LENA.id, until: iso(until), ...extra } } });
    assert.equal((await grant('light:1', T0 + 8 * DAY)).json.code, 'invalid', 'over 7 days');
    await c.admin('PUT', 'settings', { grantMaxDays: 14 });
    assert.equal((await grant('light:1', T0 + 8 * DAY)).json.ok, true);
    assert.equal((await grant('light:1', T0 + HOUR, { offAtEnd: 'yes' })).json.code, 'invalid');
    const b = (await grant('scene:1', T0 + HOUR, { offAtEnd: true })).json.message;
    assert.equal(b.action.grant.offAtEnd, false, 'a button has no off');
    const m = (await grant('light:1', T0 + HOUR, { offAtEnd: true })).json.message;
    assert.deepEqual(m.action.grant, { toUserId: LENA.id, until: iso(T0 + HOUR), offAtEnd: true });
    host.actionRuns.length = 0;
    c.clock.add(HOUR + MIN);
    await host.tick();
    const runs = host.actionRuns.filter((x) => x.id === 'light:1');
    assert.equal(runs.length, 1, 'once');
    assert.deepEqual([runs[0].userId, runs[0].state, runs[0].viewer.automation], [ANNA.id, 'off', true]);
    const list = (await c.as(LENA)('GET', `conversations/${g.id}/messages`)).json.messages;
    assert.equal(list.find((x) => x.id === m.id).action.state, 'expired');
    const sys = list.filter((x) => x.kind === 'system' && x.system.event === 'grant_off');
    assert.deepEqual(sys.map((x) => x.system), [{ event: 'grant_off', messageId: m.id, label: 'Flurlicht', ok: true, byUserId: ANNA.id, toUserId: LENA.id }]);
    await host.tick();
    assert.equal(host.actionRuns.filter((x) => x.id === 'light:1').length, 1, 'never again');
    const texts = require('../server/texts.json');
    for (const k of ['sys.grant_off', 'sys.grant_off_failed']) assert.ok(texts.de[k] && texts.en[k], k);
  });
});

test('send_message target direct:<id>: the direct chat of the calling person and that person (found or created), a card "via" the plugin; refusals', async () => {
  await withHost({}, async (host, c) => {
    const anna = { id: ANNA.id, name: 'Anna', role: 'user' };
    const card = { kind: 'notice', title: 'Kannst du einkaufen gehen?', text: 'Wocheneinkauf · 5 Artikel · bis 18:00', actions: ['shop-take:3', 'shop-decline:3'] };
    let r = await host.callService('send_message', { caller: 'gatecontrol-familie', user: anna, payload: { conversation: `direct:${LENA.id}`, card } });
    assert.equal(r.ok, true, JSON.stringify(r));
    const conv = (await c.as(LENA)('GET', 'conversations')).json.conversations.find((x) => x.id === r.conversationId);
    assert.deepEqual([conv.kind, conv.peer.userId], ['direct', ANNA.id]);
    const msg = (await c.as(LENA)('GET', `conversations/${conv.id}/messages`)).json.messages.pop();
    assert.deepEqual([msg.kind, msg.via, msg.senderId, msg.card.title, msg.card.actions.map((a) => [a.plugin, a.actionId])],
      ['card', 'gatecontrol-familie', null, 'Kannst du einkaufen gehen?', [['gatecontrol-familie', 'shop-take:3'], ['gatecontrol-familie', 'shop-decline:3']]]);
    // the same chat again — also the one the two already had
    const d = await c.direct(MARC, ANNA);
    r = await host.callService('send_message', { caller: 'gatecontrol-familie', user: anna, payload: { conversation: `direct:${LENA.id}`, text: 'Danke!' } });
    assert.equal(r.conversationId, conv.id);
    r = await host.callService('send_message', { caller: 'gatecontrol-familie', user: anna, payload: { conversation: `direct:${MARC.id}`, text: 'Hallo' } });
    assert.equal(r.conversationId, d.id);
    const notice = (await c.as(MARC)('GET', `conversations/${d.id}/messages`)).json.messages.pop();
    assert.deepEqual([notice.kind, notice.via, notice.text, notice.system.event], ['system', 'gatecontrol-familie', 'Hallo', 'notice']);
    // a list of targets
    r = await host.callService('send_message', { caller: 'gatecontrol-familie', user: anna, payload: { conversation: [`direct:${LENA.id}`, `direct:${OMA.id}`], text: 'Essen ist fertig' } });
    assert.deepEqual([r.sent, r.failed], [2, 0]);
    // refusals: no user, oneself, unknown, blocked either way
    const send = (user, conversation) => host.callService('send_message', { caller: 'gatecontrol-familie', user, payload: { conversation, text: 'x' } });
    assert.deepEqual(await send(null, `direct:${LENA.id}`), { ok: false, code: 'invalid' });
    assert.deepEqual(await send(anna, `direct:${ANNA.id}`), { ok: false, code: 'invalid' });
    assert.deepEqual(await send(anna, 'direct:999'), { ok: false, code: 'invalid' });
    await c.as(OMA)('POST', 'blocks', { userId: ANNA.id });
    assert.deepEqual(await send(anna, `direct:${OMA.id}`), { ok: false, code: 'forbidden' });
    assert.ok(ADMIN.id);
  });
});

test('GET me homeActions.doorbell: the time of the last door card in a chat of the person', async () => {
  await withHost({}, async (host, c) => {
    await host.callService('sync_group', { caller: 'gatecontrol-familie', payload: { key: 'family', title: 'Familie', userIds: [ANNA.id, MARC.id] } });
    assert.equal((await c.as(ANNA)('GET', 'me')).json.homeActions.doorbell, null);
    c.clock.add(MIN);
    await host.callService('send_message', { caller: 'gatecontrol-door', payload: { conversation: 'family', card: { kind: 'doorbell', title: 'Klingel · Haustür', text: 'Eingang · 10:01' } } });
    assert.deepEqual((await c.as(ANNA)('GET', 'me')).json.homeActions.doorbell, { lastCardAt: iso(T0 + MIN) });
    assert.equal((await c.as(LENA)('GET', 'me')).json.homeActions.doorbell, null, 'not in that chat');
  });
});
