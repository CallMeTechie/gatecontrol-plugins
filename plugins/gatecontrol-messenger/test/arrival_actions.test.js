'use strict';

// 1.4.0: live arrival (positions, ETA, arrived, stop, 3 h), home actions (GET actions, run / request /
// grant, interactive runs), plugin cards through send_message, and the 1.4 push rules (mentions only,
// reactions, features).

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC, LENA, OMA, SEC, MIN, HOUR, T0 } = require('./helpers');

const iso = (ms) => new Date(ms).toISOString();
const HOME = { label: 'Zuhause', lat: 50.0, lon: 7.0, radiusM: 150 };

test('arrival: positions → distance, ETA, progress; arrived within the radius; position only while live', async () => {
  await withHost({}, async (host, c) => {
    const g = await c.group(ANNA, [MARC]);
    const m = await c.send(ANNA, g.id, { kind: 'arrival', arrival: { dest: HOME } });
    assert.deepEqual([m.arrival.state, m.arrival.dest.label, m.arrival.position], ['live', 'Zuhause', null]);
    const anna = c.as(ANNA);
    // ~11 km north
    let r = await anna('POST', `messages/${m.id}/arrival`, { lat: 50.1, lon: 7.0, accuracy: 12 });
    assert.equal(r.json.accepted, true);
    let a = r.json.message.arrival;
    assert.ok(Math.abs(a.distanceM - 11119) < 30, String(a.distanceM));
    assert.equal(a.progress, 0);
    assert.ok(Math.abs(new Date(a.etaAt).getTime() - (T0 + (a.distanceM / (40 / 3.6)) * 1000)) < 2000, 'ETA at 40 km/h without a speed');
    assert.deepEqual(a.position, { lat: 50.1, lon: 7.0, accuracy: 12 });
    assert.equal((await c.as(MARC)('GET', `conversations/${g.id}/messages`)).json.messages.find((x) => x.id === m.id).arrival.position.lat, 50.1, 'members see it while live');
    assert.equal((await c.as(MARC)('POST', `messages/${m.id}/arrival`, { lat: 1, lon: 1 })).json.code, 'not_sender');
    // too soon: answered, not used
    c.clock.add(5 * SEC);
    assert.equal((await anna('POST', `messages/${m.id}/arrival`, { lat: 50.05, lon: 7.0 })).json.accepted, false);
    c.clock.add(20 * SEC);
    c.resetEvents();
    r = await anna('POST', `messages/${m.id}/arrival`, { lat: 50.05, lon: 7.0, speedMps: 20 });
    a = r.json.message.arrival;
    assert.ok(a.progress > 0.49 && a.progress < 0.51);
    assert.equal(c.events('arrival.update').length, 1);
    const row = await host.gc.db.get('SELECT pos_enc FROM arrivals WHERE msg_id = ?', [m.id]);
    assert.ok(row.row.pos_enc.startsWith('v1.') && !row.row.pos_enc.includes('50.05'), 'encrypted');
    c.clock.add(20 * SEC);
    const before = c.pushes().length;
    r = await anna('POST', `messages/${m.id}/arrival`, { lat: 50.0005, lon: 7.0 });
    assert.equal(r.json.arrived, true);
    a = r.json.message.arrival;
    assert.deepEqual([a.state, a.position, a.progress], ['arrived', null, 1]);
    assert.equal((await host.gc.db.get('SELECT pos_enc FROM arrivals WHERE msg_id = ?', [m.id])).row.pos_enc, null, 'the position is gone');
    const sys = (await c.as(MARC)('GET', `conversations/${g.id}/messages`)).json.messages.pop();
    assert.deepEqual(sys.system, { event: 'arrived', userId: ANNA.id, messageId: m.id, label: 'Zuhause' });
    const p = c.pushes().slice(before);
    assert.deepEqual([p.length, p[0].users, p[0].title], [1, [MARC.id], 'Anna ist angekommen']);
    assert.equal((await anna('POST', `messages/${m.id}/arrival`, { lat: 50, lon: 7 })).json.code, 'closed');
  });
});

test('arrival: stop, auto-stop after 3 h, a new one stops the old one, onArrive action as the sender', async () => {
  const actions = [{ plugin: 'gatecontrol-smarthome', pluginName: 'Smart Home', quickActions: () => [{ id: 'scene:home', title: 'Ankommen', kind: 'button' }] }];
  await withHost({ actions }, async (host, c) => {
    const g = await c.group(ANNA, [MARC]);
    const m1 = await c.send(ANNA, g.id, { kind: 'arrival', arrival: { dest: HOME } });
    const m2 = await c.send(ANNA, g.id, { kind: 'arrival', arrival: { dest: HOME, onArrive: { actionId: 'scene:home' } } });
    let list = (await c.as(MARC)('GET', `conversations/${g.id}/messages`)).json.messages;
    assert.equal(list.find((x) => x.id === m1.id).arrival.state, 'stopped');
    await c.as(ANNA)('POST', `messages/${m2.id}/arrival`, { lat: 50.0001, lon: 7.0 });
    assert.equal(host.actionRuns.length, 1);
    assert.deepEqual([host.actionRuns[0].id, host.actionRuns[0].userId, host.actionRuns[0].viewer.automation], ['scene:home', ANNA.id, true], 'onArrive runs as an automation of the sender');
    list = (await c.as(MARC)('GET', `conversations/${g.id}/messages`)).json.messages;
    assert.deepEqual(list.pop().system.event, 'action_run');
    const m3 = await c.send(ANNA, g.id, { kind: 'arrival', arrival: { dest: HOME } });
    const r = await c.as(ANNA)('POST', `messages/${m3.id}/arrival/stop`);
    assert.equal(r.json.message.arrival.state, 'stopped');
    const m4 = await c.send(ANNA, g.id, { kind: 'arrival', arrival: { dest: HOME } });
    c.clock.add(3 * HOUR + MIN);
    await host.tick();
    list = (await c.as(MARC)('GET', `conversations/${g.id}/messages`)).json.messages;
    assert.equal(list.find((x) => x.id === m4.id).arrival.state, 'stopped');
    for (const bad of [{ dest: { label: 'x', lat: 91, lon: 0 } }, { dest: { lat: 1, lon: 1 } }, { dest: { ...HOME, radiusM: 10 } }, { dest: HOME, onArrive: { actionId: 'a b' } }]) {
      assert.equal((await c.as(ANNA)('POST', `conversations/${g.id}/messages`, { clientId: c.cid(), kind: 'arrival', arrival: bad })).json.code, 'invalid', JSON.stringify(bad));
    }
  });
});

const smarthome = (allowed) => ({
  plugin: 'gatecontrol-door', pluginName: 'Tür',
  quickActions: (viewer) => (allowed.includes(viewer.id) ? [{ id: 'open:1', title: 'Haustür öffnen', kind: 'button' }, { id: 'light:1', title: 'Flurlicht', kind: 'toggle', state: 'off' }] : []),
  runQuickAction: (viewer, id) => ({ ok: true, message: id === 'open:1' ? 'Tür geöffnet' : 'Licht an' }),
});

test('home actions: GET actions, run card (interactive), request → approve / deny, grant as the granter', async () => {
  await withHost({ actions: [smarthome([ANNA.id, MARC.id])] }, async (host, c) => {
    assert.equal((await c.as(ANNA)('GET', 'me')).json.features.actions, true);
    const list = (await c.as(ANNA)('GET', 'actions')).json.actions;
    assert.deepEqual(list.map((a) => [a.id, a.plugin, a.label, a.kind]), [['open:1', 'gatecontrol-door', 'Haustür öffnen', 'button'], ['light:1', 'gatecontrol-door', 'Flurlicht', 'toggle']]);
    assert.deepEqual((await c.as(LENA)('GET', 'actions')).json.actions, []);
    const g = await c.group(ANNA, [MARC, LENA]);
    // run: a button for everyone who may run it
    const m = await c.send(ANNA, g.id, { kind: 'action', action: { mode: 'run', actionId: 'open:1', plugin: 'gatecontrol-door' } });
    assert.deepEqual([m.action.mode, m.action.label, m.action.state, m.action.can.run], ['run', 'Haustür öffnen', 'open', true]);
    assert.equal((await c.as(LENA)('GET', `conversations/${g.id}/messages`)).json.messages.find((x) => x.id === m.id).action.can.run, false);
    let r = await c.as(MARC)('POST', `messages/${m.id}/action/run`);
    assert.deepEqual([r.json.result.ok, r.json.result.message, r.json.message.action.by], [true, 'Tür geöffnet', MARC.id]);
    assert.deepEqual([host.actionRuns.pop().viewer.interactive, true], [true, true], 'a press is interactive');
    let sys = (await c.as(ANNA)('GET', `conversations/${g.id}/messages`)).json.messages.pop();
    assert.deepEqual(sys.system, { event: 'action_run', userId: MARC.id, messageId: m.id, label: 'Haustür öffnen', mode: 'run', asUserId: null });
    assert.equal((await c.as(LENA)('POST', `messages/${m.id}/action/run`)).json.code, 'not_allowed');
    // request: Lena asks, Anna and Marc may approve; the push goes to the approvers only
    const before = c.pushes().length;
    const q = await c.send(LENA, g.id, { kind: 'action', action: { mode: 'request', actionId: 'open:1' } });
    assert.deepEqual(q.action.approverIds.sort(), [ANNA.id, MARC.id]);
    const qp = c.pushes().slice(before);
    assert.deepEqual([qp.length, qp[0].users.sort(), qp[0].body], [1, [ANNA.id, MARC.id], 'Bittet um: Haustür öffnen']);
    assert.equal((await c.as(LENA)('POST', `messages/${q.id}/action/approve`)).json.code, 'not_allowed');
    r = await c.as(ANNA)('POST', `messages/${q.id}/action/approve`);
    assert.deepEqual([r.json.message.action.state, r.json.result.ok, host.actionRuns.pop().userId], ['done', true, ANNA.id]);
    assert.equal(c.pushes().pop().users[0], LENA.id, 'the requester learns it');
    assert.equal((await c.as(MARC)('POST', `messages/${q.id}/action/deny`)).json.code, 'closed');
    const q2 = await c.send(LENA, g.id, { kind: 'action', action: { mode: 'request', actionId: 'light:1' } });
    r = await c.as(MARC)('POST', `messages/${q2.id}/action/deny`);
    assert.equal(r.json.message.action.state, 'denied');
    sys = (await c.as(ANNA)('GET', `conversations/${g.id}/messages`)).json.messages.pop();
    assert.equal(sys.system.event, 'action_denied');
    // nobody may: no_approver
    assert.equal((await c.as(LENA)('POST', `conversations/${g.id}/messages`, { clientId: c.cid(), kind: 'action', action: { mode: 'request', actionId: 'nope:1' } })).json.code, 'no_approver');
    // grant: Anna lets Lena switch the light until a time — run as Anna, as an automation
    const gr = await c.send(ANNA, g.id, { kind: 'action', action: { mode: 'grant', actionId: 'light:1', grant: { toUserId: LENA.id, until: iso(T0 + HOUR) } } });
    assert.deepEqual(gr.action.grant, { toUserId: LENA.id, until: iso(T0 + HOUR) });
    assert.equal((await c.as(LENA)('GET', `conversations/${g.id}/messages`)).json.messages.find((x) => x.id === gr.id).action.can.run, true);
    r = await c.as(LENA)('POST', `messages/${gr.id}/action/run`);
    const run = host.actionRuns.pop();
    assert.deepEqual([r.json.result.ok, run.userId, run.viewer.automation, run.interactive], [true, ANNA.id, true, false]);
    assert.equal((await c.as(MARC)('POST', `messages/${gr.id}/action/run`)).json.code, 'not_allowed');
    c.clock.add(HOUR + MIN);
    assert.equal((await c.as(LENA)('POST', `messages/${gr.id}/action/run`)).json.code, 'closed');
    await host.tick();
    assert.equal((await c.as(LENA)('GET', `conversations/${g.id}/messages`)).json.messages.find((x) => x.id === gr.id).action.state, 'expired');
  });
});

test('home actions: sensitive actions cannot be granted; without gc.actions or switched off → feature_off', async () => {
  const door = { plugin: 'gatecontrol-door', quickActions: () => [{ id: 'open:1', title: 'Haustür', kind: 'button', confirm: true }] };
  await withHost({ actions: [door], gatecontrol: '1.180.0' }, async (host, c) => {
    const g = await c.group(ANNA, [MARC]);
    assert.equal((await c.as(ANNA)('GET', 'actions')).json.actions[0].needsConfirm, true);
    assert.equal((await c.as(ANNA)('POST', `conversations/${g.id}/messages`, { clientId: c.cid(), kind: 'action', action: { mode: 'grant', actionId: 'open:1', grant: { toUserId: MARC.id, until: iso(T0 + HOUR) } } })).json.code, 'not_allowed');
    await c.admin('PUT', 'settings', { allowActions: false });
    assert.equal((await c.as(ANNA)('GET', 'actions')).json.code, 'feature_off');
    assert.equal((await c.as(ANNA)('GET', 'me')).json.features.actions, undefined);
  });
  await withHost({ actionsApi: false }, async (host, c) => {
    const me = (await c.as(ANNA)('GET', 'me')).json;
    assert.equal(me.features.actions, undefined);
    assert.deepEqual(['status', 'stories', 'polls', 'events', 'arrival', 'msg_tools', 'privacy2'].map((k) => me.features[k]), [true, true, true, true, true, true, true]);
    assert.equal((await c.as(ANNA)('GET', 'actions')).json.code, 'feature_off');
  });
});

test('plugin cards: the door\'s doorbell card into "family" — picture as messenger data, buttons for the pressing person, Live-Bild link', async () => {
  const door = { plugin: 'gatecontrol-door', quickActions: (v) => (v.id === OMA.id ? [] : [{ id: 'lock1:open', title: 'Tür öffnen', kind: 'button' }]), runQuickAction: (v) => ({ ok: v.interactive === true, message: v.interactive === true ? 'offen' : 'nur persönlich' }) };
  await withHost({ actions: [door] }, async (host, c) => {
    const fam = await host.callService('sync_group', { caller: 'gatecontrol-familie', payload: { key: 'family', title: 'Familie', userIds: [ANNA.id, MARC.id, OMA.id] } });
    // a snapshot of ~250 KB (GateControl 1.180.0 takes service payloads up to 512 KB)
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(250 * 1024, 1)]);
    let r = await host.callService('send_message', { caller: 'gatecontrol-door', payload: { conversation: 'family', card: { kind: 'doorbell', title: 'Klingel · Haustür', text: 'Eingang · 10:00', imageBase64: jpeg.toString('base64'), actions: ['lock1:open'] } } });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.conversationId, fam.conversationId, '"family" of a caller without its own group: Familie\'s group');
    const msg = (await c.as(MARC)('GET', `conversations/${fam.conversationId}/messages`)).json.messages.pop();
    assert.deepEqual([msg.kind, msg.via, msg.text, msg.card.kind, msg.card.title], ['card', 'gatecontrol-door', 'Eingang · 10:00', 'doorbell', 'Klingel · Haustür']);
    assert.deepEqual(msg.card.image, { mime: 'image/jpeg', bytes: jpeg.length });
    assert.deepEqual(msg.card.link, { label: 'Live-Bild', route: 'plg-gatecontrol-door', kind: 'live_view' }, 'set by the server for the door\'s doorbell cards');
    assert.deepEqual(msg.card.actions.map((a) => [a.plugin, a.actionId, a.label, a.canRun]), [['gatecontrol-door', 'lock1:open', 'Tür öffnen', true]]);
    const img = (await c.as(MARC)('GET', `messages/${msg.id}/card/image`)).json;
    assert.deepEqual([img.mime, img.bytes, Buffer.from(img.data, 'base64').equals(jpeg)], ['image/jpeg', jpeg.length, true]);
    assert.equal((await c.as(LENA)('GET', `messages/${msg.id}/card/image`)).status, 404, 'members only');
    const stored = await host.gc.db.get('SELECT data_enc FROM card_images WHERE msg_id = ?', [msg.id]);
    assert.ok(stored.row.data_enc.startsWith('v1.'), 'stored encrypted');
    assert.equal((await c.as(OMA)('GET', `conversations/${fam.conversationId}/messages`)).json.messages.pop().card.actions[0].canRun, false);
    const push = c.pushes().pop();
    assert.deepEqual([push.priority, push.title, push.body], ['high', 'GateControl', 'Klingel · Haustür: Eingang · 10:00']);
    // a press runs interactive as the pressing person: <caller>/<id>
    r = await c.as(MARC)('POST', `messages/${msg.id}/action/run`, { actionId: 'lock1:open' });
    assert.deepEqual([r.json.result.ok, r.json.result.message, r.json.message.card.lastRun.by], [true, 'offen', MARC.id]);
    const run = host.actionRuns.pop();
    assert.deepEqual([run.plugin, run.id, run.userId, run.viewer.interactive, run.viewer.via], ['gatecontrol-door', 'lock1:open', MARC.id, true, 'gatecontrol-messenger']);
    assert.equal((await c.as(OMA)('POST', `messages/${msg.id}/action/run`, { actionId: 'lock1:open' })).json.code, 'not_allowed');
    // a bad picture → invalid (the door sends again without one); other refusals
    const png = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.alloc(100)]);
    for (const card of [{ kind: 'x', title: 'a' }, { kind: 'notice' }, { kind: 'notice', title: 'a', actions: ['a b'] }, { kind: 'notice', title: 'a', imageBase64: 'bm9pbWFnZQ==' },
      { kind: 'doorbell', title: 'a', imageBase64: png.toString('base64') }, { kind: 'doorbell', title: 'a', imageBase64: Buffer.concat([jpeg, Buffer.alloc(60 * 1024)]).toString('base64') },
      { kind: 'notice', title: 'a', link: { label: 'x', route: 'http://x' } }]) {
      assert.deepEqual(await host.callService('send_message', { caller: 'gatecontrol-door', payload: { conversation: 'family', card } }), { ok: false, code: 'invalid' }, JSON.stringify(card).slice(0, 80));
    }
    r = await host.callService('send_message', { caller: 'gatecontrol-door', payload: { conversation: 'family', card: { kind: 'doorbell', title: 'Klingel · Haustür', text: 'Eingang · 10:01', actions: [] } } });
    assert.equal(r.ok, true, 'without a picture and without buttons');
  });
});

test('push 1.4: groupsMentionsOnly, reactions to own messages, a dnd member', async () => {
  await withHost({}, async (host, c) => {
    const g = await c.group(ANNA, [MARC, LENA]);
    await c.as(MARC)('PUT', 'prefs', { notify: { groupsMentionsOnly: true } });
    const m1 = await c.send(ANNA, g.id, { text: 'Hallo zusammen' });
    assert.deepEqual(c.pushes().pop().users, [LENA.id], 'Marc only for mentions');
    await c.send(ANNA, g.id, { text: 'Hey @Marc kommst du?' });
    assert.deepEqual(c.pushes().pop().users.sort(), [MARC.id, LENA.id]);
    const own = await c.send(MARC, g.id, { text: 'Ich' });
    await c.send(ANNA, g.id, { text: 'Antwort', replyTo: own.id });
    assert.ok(c.pushes().pop().users.includes(MARC.id), 'a reply to his message');
    // reaction push to the author
    const before = c.pushes().length;
    await c.as(LENA)('PUT', `messages/${m1.id}/reaction`, { emoji: '👍' });
    const p = c.pushes().slice(before);
    assert.deepEqual([p.length, p[0].users, p[0].body, p[0].data.kind], [1, [ANNA.id], '👍 auf: Hallo zusammen', 'reaction']);
    await c.as(ANNA)('PUT', 'prefs', { notify: { reactions: false } });
    await c.as(MARC)('PUT', `messages/${m1.id}/reaction`, { emoji: '❤️' });
    assert.equal(c.pushes().length, before + 1);
  });
});

test('home actions: run() asks for an interactive run and falls back when the core refuses the flag; reads both result shapes', async () => {
  const homeactions = require('../server/homeactions');
  const calls = [];
  const gc = {
    log: { warn() {} },
    db: { query: async () => ({ rows: [] }), get: async () => ({ row: null }) },
    actions: {
      list: async () => [],
      run: async (o) => {
        calls.push(o);
        if (o.interactive) throw Object.assign(new Error('unknown key'), { code: 'ERR_INVALID' });
        return { ok: false, code: 'ERR_ACTION_FAILED', result: { message: 'Nur persönlich', state: null } };
      },
    },
  };
  const r = await homeactions.run(gc, 7, 'gatecontrol-door', 'open:1', { interactive: true });
  assert.deepEqual(r, { ok: false, message: 'Nur persönlich', state: null, error: 'ERR_ACTION_FAILED', interactive: false });
  assert.deepEqual(calls.map((x) => [x.actionId, x.via, x.interactive === true]), [['gatecontrol-door/open:1', 'gatecontrol-messenger', true], ['gatecontrol-door/open:1', 'gatecontrol-messenger', false]]);
  assert.equal(calls[0].plugin, undefined, 'actionId only (GateControl 1.180.0 refuses both forms at once)');
});
