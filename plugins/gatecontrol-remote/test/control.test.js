'use strict';

// 1.4 (stage 6, gc.remote version 5): a helper may ask a phone for "Ansehen und steuern". Only when the app of the phone
// can be controlled (screen.control — the GitHub build) and GateControl knows control; only when the person at the phone
// chose control for this very request; the phone may go down to view at any time (GateControl's event phase mode).

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, ADMIN, MARC, LEA } = require('./helpers');

const DEVICES = [
  { id: '803', userId: LEA.id, name: 'Lea Handy', platform: 'android', vpnIp: null },
  { id: '805', userId: MARC.id, name: 'Marc Handy', platform: 'android', vpnIp: '10.8.0.65' },
];
const PHONE = { id: '803', platform: 'android', vpnIp: null };
const MARC_APP = { id: '805', platform: 'android', vpnIp: '10.8.0.65' };
const REG = { platform: 'android', name: 'Leas Pixel', appVersion: '1.121.0', screen: { view: true, control: true } };
const PLAY = { ...REG, screen: { view: true, control: false } };

async function start(o = {}) {
  const s = await setup({ gatecontrol: o.gatecontrol || '1.287.0', host: { devices: DEVICES, ...(o.host || {}) } });
  const app = async (user, dev, method, path, body) => {
    const r = await s.host.request({ method, path, body: body || null, user: { ...user, app: true, portal: true, loggedIn: true, device: dev }, lang: 'de' });
    return { status: r.status || 200, ...r.json };
  };
  return { ...s, app };
}

const lastSignal = (host, type) => host.notifications.filter((n) => n.topic === 'remote_signal' && n.data && n.data.type === type).slice(-1)[0];
const screenCalls = (host) => host.remote.calls.filter((c) => c.op === 'screen');

async function ask(s, mode) {
  const { code } = await s.app(LEA, PHONE, 'POST', '/host/code');
  return (await s.req(ADMIN, 'POST', '/code/redeem', { code, mode, via: 'browser' })).request;
}

test('a phone that can be controlled: the helper asks control, the person chooses, the relay ticket follows the choice', async () => {
  const s = await start();
  try {
    const id = (await s.app(LEA, PHONE, 'POST', '/host/register', REG)).host.deviceId;
    const own = (await s.req(ADMIN, 'GET', '/overview')).devices.find((x) => x.id === id);
    assert.deepEqual(own.screen, { view: true, control: true });
    const admin = (await s.adminReq('GET', 'devices')).devices.find((x) => x.id === id);
    assert.equal(admin.host.screenControl, true);

    // asked for control → the phone hears mode control
    let rq = await ask(s, 'control');
    assert.deepEqual([rq.mode, rq.kind, rq.modeReason], ['control', 'screen', undefined]);
    assert.equal(lastSignal(s.host, 'remote.request').data.mode, 'control');
    assert.equal((await s.app(LEA, PHONE, 'POST', '/host/state', { online: true })).pending[0].mode, 'control');

    // the person allows without saying control (an old app, "Nur ansehen lassen"): view
    let ok = await s.app(LEA, PHONE, 'POST', '/host/requests/' + rq.id, { decision: 'allow' });
    assert.equal(ok.request.mode, 'view');
    assert.equal(screenCalls(s.host).slice(-1)[0].mode, 'view');
    assert.equal((await s.req(ADMIN, 'POST', '/requests/' + rq.id + '/connect', {})).session.mode, 'view');

    // the person chooses control for this request: a ticket of mode control
    rq = await ask(s, 'control');
    ok = await s.app(LEA, PHONE, 'POST', '/host/requests/' + rq.id, { decision: 'allow', mode: 'control' });
    assert.equal(ok.request.mode, 'control');
    assert.equal(screenCalls(s.host).slice(-1)[0].mode, 'control');
    const c = await s.req(ADMIN, 'POST', '/requests/' + rq.id + '/connect', {});
    assert.equal(c.session.mode, 'control');

    // a request for view can never be answered with control
    const rv = await ask(s, 'view');
    const okv = await s.app(LEA, PHONE, 'POST', '/host/requests/' + rv.id, { decision: 'allow', mode: 'control' });
    assert.equal(okv.request.mode, 'view');

    // the session runs; the phone goes down to view → request, history and protocol follow
    await s.host.remoteScreenStart(c.session.ref, { via: 'browser' });
    await s.host.remoteScreenMode(c.session.ref, 'sender');
    assert.equal((await s.req(ADMIN, 'GET', '/requests/' + rq.id)).request.mode, 'view');
    const sess = (await s.adminReq('GET', 'sessions')).sessions || [];
    assert.equal(sess.find((x) => x.protocol === 'screen' && x.status === 'active').mode, 'view');
    const prof = await s.app(LEA, PHONE, 'GET', '/profile');
    const types = prof.history.map((e) => e.type);
    assert.ok(types.includes('remote_screen_mode'), JSON.stringify(types));
    const allowed = prof.history.filter((e) => e.type === 'remote_request_allowed').map((e) => e.details && e.details.mode);
    assert.ok(allowed.includes('control') && allowed.includes('view'), JSON.stringify(allowed));
    await s.host.remoteScreenEnd(c.session.ref, 'sender');
  } finally { await s.host.stop(); }
});

test('only watching: the Play build, an older GateControl, and "ohne Code" asks the same', async () => {
  // the Play build of the app says control: false
  const s = await start();
  try {
    const id = (await s.app(LEA, PHONE, 'POST', '/host/register', PLAY)).host.deviceId;
    assert.deepEqual((await s.req(ADMIN, 'GET', '/overview')).devices.find((x) => x.id === id).screen, { view: true, control: false });
    const rq = await ask(s, 'control');
    assert.deepEqual([rq.mode, rq.modeReason], ['view', 'phone_view_only']);
    assert.equal(lastSignal(s.host, 'remote.request').data.mode, 'view');
    const ok = await s.app(LEA, PHONE, 'POST', '/host/requests/' + rq.id, { decision: 'allow', mode: 'control' });
    assert.equal(ok.request.mode, 'view');
    assert.equal(screenCalls(s.host).slice(-1)[0].mode, 'view');
    // the APK replaced the Play build: the heartbeat says so
    await s.app(LEA, PHONE, 'POST', '/host/state', { online: true, screen: { view: true, control: true } });
    assert.equal((await s.req(ADMIN, 'GET', '/overview')).devices.find((x) => x.id === id).screen.control, true);
    // "ohne Code" (Lea shares with Marc): a request of mode control, still asked at the phone
    await s.adminReq('PUT', 'rights/user/' + MARC.id, { rdp: true });
    await s.app(LEA, PHONE, 'PUT', '/host/share', { shareMode: 'open' });
    await s.app(LEA, PHONE, 'PUT', '/host/access', { users: [MARC.id], groups: [] });
    const open = await s.app(MARC, MARC_APP, 'POST', '/devices/' + id + '/connect', { mode: 'control' });
    assert.ok(open.request && !open.session);
    assert.deepEqual([open.request.mode, open.request.state], ['control', 'waiting']);
    const plain = await s.app(MARC, MARC_APP, 'POST', '/devices/' + id + '/connect', {});
    assert.equal(plain.request.mode, 'view', 'without asking: view');
  } finally { await s.host.stop(); }
  // GateControl without control (gc.remote version 4): view, the reason says why
  const old = await start({ gatecontrol: '1.286.0' });
  try {
    await old.app(LEA, PHONE, 'POST', '/host/register', REG);
    const { code } = await old.app(LEA, PHONE, 'POST', '/host/code');
    const rq = (await old.req(ADMIN, 'POST', '/code/redeem', { code, mode: 'control', via: 'browser' })).request;
    assert.deepEqual([rq.mode, rq.modeReason], ['view', 'server_view_only']);
    const ok = await old.app(LEA, PHONE, 'POST', '/host/requests/' + rq.id, { decision: 'allow', mode: 'control' });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(ok.request.mode, 'view');
  } finally { await old.host.stop(); }
});
