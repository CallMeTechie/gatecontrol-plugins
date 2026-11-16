'use strict';

// 1.3 (stage 5, gc.remote version 4): an Android phone shares its screen — only watching. The phone registers like a PC,
// shows a code, a helper redeems it, the phone always asks (also "ohne Code"), an allowed request gets a ticket of
// GateControl's relay (sender side for the phone, viewer side for the helper), GateControl's events end it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, ADMIN, MARC, SABINE, LEA, TIM } = require('./helpers');

// Lea's phone (token 803), Tim's phone (804), Marc's helper app (805)
const DEVICES = [
  { id: '803', userId: LEA.id, name: 'Lea Handy', platform: 'android', vpnIp: null },
  { id: '804', userId: TIM.id, name: 'Tim Handy', platform: 'android', vpnIp: null },
  { id: '805', userId: MARC.id, name: 'Marc Handy', platform: 'android', vpnIp: '10.8.0.65' },
];
const PHONE = { id: '803', platform: 'android', vpnIp: null };
const MARC_APP = { id: '805', platform: 'android', vpnIp: '10.8.0.65' };
const REG = { platform: 'android', name: 'Leas Pixel', appVersion: '1.120.0', screen: { view: true, control: false } };

async function start(o = {}) {
  const s = await setup({ gatecontrol: o.gatecontrol || '1.286.0', host: { devices: DEVICES, ...(o.host || {}) } });
  const app = async (user, dev, method, path, body) => {
    const r = await s.host.request({ method, path, body: body || null, user: { ...user, app: true, portal: true, loggedIn: true, device: dev }, lang: 'de' });
    return { status: r.status || 200, ...r.json };
  };
  return { ...s, app };
}

const signals = (host, type) => host.notifications.filter((n) => n.topic === 'remote_signal' && n.data && (!type || n.data.type === type));
const lastSignal = (host, type) => signals(host, type).slice(-1)[0];

test('register: a phone becomes a private screen device of its owner; needs the relay of GateControl', async () => {
  const s = await start();
  try {
    const r = await s.app(LEA, PHONE, 'POST', '/host/register', REG);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual([r.host.platform, r.host.state, r.host.shareMode, r.codeRequired], ['android', 'ready', 'code', true]);
    const d = (await s.adminReq('GET', 'devices')).devices.find((x) => x.id === r.host.deviceId);
    assert.deepEqual([d.kind, d.protocol, d.host.platform, d.status.online], ['host', 'screen', 'android', true]);
    assert.deepEqual(d.access.users, [LEA.id]);
    // the owner sees it in the portal with protocol screen; nobody else (Tim has no access)
    const own = (await s.req(ADMIN, 'GET', '/overview')).devices.find((x) => x.id === r.host.deviceId);
    assert.deepEqual([own.protocol, own.platform, own.screen], ['screen', 'android', { view: true, control: false }]);
    assert.equal((await s.req(TIM, 'GET', '/overview')).devices.some((x) => x.id === r.host.deviceId), false);
    // the same app as a Windows PC: refused
    assert.equal((await s.app(LEA, { ...PHONE, vpnIp: '10.8.0.63' }, 'POST', '/host/register', { name: 'x', edition: 'pro', rdp: { available: true, enabled: true } })).code, 'invalid');
    // a code like a PC
    const c = await s.app(LEA, PHONE, 'POST', '/host/code');
    assert.match(c.code, /^\d{3}-\d{3}-\d{3}$/);
    // the old apps never see a phone
    assert.ok(!JSON.stringify(await s.host.clientFacade('list', { user: { id: ADMIN.id, tokenId: 9 } })).includes('Leas Pixel'));
  } finally { await s.host.stop(); }
  // GateControl without the relay (version 3): no phone
  const old = await start({ gatecontrol: '1.285.0' });
  try {
    assert.equal((await old.app(LEA, PHONE, 'POST', '/host/register', REG)).code, 'screen_unavailable');
  } finally { await old.host.stop(); }
});

test('code → request (always view) → the phone allows → relay ticket: sender side to the phone, viewer side to the helper', async () => {
  const s = await start();
  try {
    const id = (await s.app(LEA, PHONE, 'POST', '/host/register', REG)).host.deviceId;
    const { code } = await s.app(LEA, PHONE, 'POST', '/host/code');
    // Marc has no "Support-Codes einlösen" and no access: no request
    assert.equal((await s.req(MARC, 'POST', '/code/redeem', { code, mode: 'control', via: 'browser' })).code, 'no_right');
    // the admin may (support right)
    const { code: code2 } = await s.app(LEA, PHONE, 'POST', '/host/code');
    const red = await s.req(ADMIN, 'POST', '/code/redeem', { code: code2, mode: 'control', via: 'browser' });
    assert.equal(red.ok, true, JSON.stringify(red));
    assert.deepEqual([red.request.mode, red.request.kind, red.request.state], ['view', 'screen', 'waiting']);
    const sig = lastSignal(s.host, 'remote.request');
    assert.deepEqual([sig.data.kind, sig.data.mode, sig.data.from.name], ['screen', 'view', 'Admin']);
    assert.deepEqual(sig.devices, ['803']);
    // the heartbeat hands it again
    const hb = await s.app(LEA, PHONE, 'POST', '/host/state', { online: true });
    assert.equal(hb.pending[0].kind, 'screen');
    // the phone allows → the sending side, never the viewer's ref
    const ok = await s.app(LEA, PHONE, 'POST', '/host/requests/' + red.request.id, { decision: 'allow', mode: 'control' });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(ok.request.state, 'allowed');
    assert.equal(ok.request.mode, 'view');
    assert.equal(ok.screen.wsPath, '/api/v1/remote/screen-relay');
    const call = s.host.remote.calls.find((c) => c.op === 'screen');
    assert.deepEqual(call, { op: 'screen', viewer: ADMIN.id, sender: { user: LEA.id, device: '803' }, target: 'dev-' + id });
    const t = [...s.host.remote.tickets.values()].find((x) => x.engine === 'screen');
    assert.equal(ok.screen.ref, t.senderRef);
    assert.ok(!JSON.stringify(ok).includes(t.ref), 'the phone never gets the viewer side');
    // the helper connects: the viewer's ref of GateControl's page
    const c = await s.req(ADMIN, 'POST', '/requests/' + red.request.id + '/connect', {});
    assert.equal(c.ok, true, JSON.stringify(c));
    assert.deepEqual([c.session.ref, c.session.engine, c.session.protocol, c.session.mode], [t.ref, 'screen', 'screen', 'view']);
    // both sides met: history and protocol; the phone ends it: the request is over, no signal (it knows)
    await s.host.remoteScreenStart(t.ref, { via: 'browser' });
    const n = signals(s.host).length;
    await s.host.remoteScreenEnd(t.ref, 'sender');
    const after = (await s.req(ADMIN, 'GET', '/requests/' + red.request.id)).request;
    assert.deepEqual([after.state, after.endReason], ['ended', 'sender']);
    assert.equal(signals(s.host).length, n);
    const prof = await s.app(LEA, PHONE, 'GET', '/profile');
    const types = prof.history.map((e) => e.type);
    assert.ok(types.includes('remote_screen_started'), JSON.stringify(types));
    assert.ok(types.includes('remote_screen_ended'));
    assert.equal(prof.hosts[0].platform, 'android');
    const sess = (await s.adminReq('GET', 'sessions')).sessions || [];
    assert.ok(sess.some((x) => x.protocol === 'screen' && x.status === 'ended'), JSON.stringify(sess.slice(0, 3)));
  } finally { await s.host.stop(); }
});

test('Android declined, the helper leaves, "ohne Code" still asks, switch off ends the relay', async () => {
  const s = await start();
  try {
    const id = (await s.app(LEA, PHONE, 'POST', '/host/register', REG)).host.deviceId;
    const ask = async () => {
      const { code } = await s.app(LEA, PHONE, 'POST', '/host/code');
      return (await s.req(ADMIN, 'POST', '/code/redeem', { code, via: 'browser' })).request;
    };
    // Android's question declined → the request ends, the ticket goes
    let rq = await ask();
    await s.app(LEA, PHONE, 'POST', '/host/requests/' + rq.id, { decision: 'allow' });
    const end = await s.app(LEA, PHONE, 'POST', '/host/screen/' + rq.id + '/end', { reason: 'consent_denied' });
    assert.equal(end.ended, true);
    assert.deepEqual([(await s.req(ADMIN, 'GET', '/requests/' + rq.id)).request.state, (await s.req(ADMIN, 'GET', '/requests/' + rq.id)).request.endReason], ['ended', 'consent_denied']);
    assert.equal([...s.host.remote.tickets.values()].filter((x) => x.engine === 'screen').length, 0);
    assert.equal((await s.req(ADMIN, 'POST', '/requests/' + rq.id + '/connect', {})).code, 'request_expired');
    // the helper leaves (viewer) while it runs → the phone hears remote.screen.end
    rq = await ask();
    await s.app(LEA, PHONE, 'POST', '/host/requests/' + rq.id, { decision: 'allow' });
    const c = await s.req(ADMIN, 'POST', '/requests/' + rq.id + '/connect', {});
    await s.host.remoteScreenStart(c.session.ref);
    await s.host.remoteScreenEnd(c.session.ref, 'viewer');
    const sig = lastSignal(s.host, 'remote.screen.end');
    assert.deepEqual([sig.data.requestId, sig.data.reason], [rq.id, 'viewer']);
    // "ohne Code" (Lea shares with Marc, who has the right to use remote desktops): still a request, never a session
    await s.adminReq('PUT', 'rights/user/' + MARC.id, { rdp: true });
    await s.app(LEA, PHONE, 'PUT', '/host/share', { shareMode: 'open' });
    await s.app(LEA, PHONE, 'PUT', '/host/access', { users: [MARC.id], groups: [] });
    const open = await s.app(MARC, MARC_APP, 'POST', '/devices/' + id + '/connect', {});
    assert.equal(open.ok, true, JSON.stringify(open));
    assert.ok(open.request && !open.session);
    assert.deepEqual([open.request.kind, open.request.via, open.request.mode], ['screen', 'app', 'view']);
    // Sabine has no access: no
    assert.equal((await s.req(SABINE, 'POST', '/devices/' + id + '/connect', {})).ok, false);
    // allowed, then the switch goes off: the relay ticket ends
    await s.app(LEA, PHONE, 'POST', '/host/requests/' + open.request.id, { decision: 'allow' });
    assert.equal([...s.host.remote.tickets.values()].filter((x) => x.engine === 'screen').length, 1);
    await s.app(LEA, PHONE, 'DELETE', '/host');
    assert.equal([...s.host.remote.tickets.values()].filter((x) => x.engine === 'screen').length, 0);
    assert.equal((await s.app(MARC, MARC_APP, 'GET', '/requests/' + open.request.id)).request.state, 'ended');
  } finally { await s.host.stop(); }
});

test('a request to a phone denied, and one never answered', async () => {
  const s = await start();
  try {
    await s.app(LEA, PHONE, 'POST', '/host/register', REG);
    const { code } = await s.app(LEA, PHONE, 'POST', '/host/code');
    const rq = (await s.req(ADMIN, 'POST', '/code/redeem', { code, via: 'browser' })).request;
    await s.app(LEA, PHONE, 'POST', '/host/requests/' + rq.id, { decision: 'deny' });
    assert.equal((await s.req(ADMIN, 'GET', '/requests/' + rq.id)).request.state, 'denied');
    assert.equal(s.host.remote.calls.filter((c) => c.op === 'screen').length, 0, 'no ticket without an allow');
  } finally { await s.host.stop(); }
});
