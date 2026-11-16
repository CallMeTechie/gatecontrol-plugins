'use strict';

// 1.5 (stage 7, GateControl's relay gc-screen.v1 with a Windows PC as sender): "Bildschirm teilen" in the Windows app —
// besides "Remote Desktop erlauben" or alone (Windows Home). The helper chooses the kind; the screen of a PC is always
// asked at the PC (also "ohne Code"), control only when the person there chooses it for this very request.

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, ADMIN, MARC, SABINE, LEA } = require('./helpers');
const support = require('../server/support');

support.TIMING.waitMs = 1500;
support.TIMING.pollMs = 10;

const DEVICES = [
  { id: '901', userId: MARC.id, name: 'Marc PC', platform: 'windows', vpnIp: '10.8.0.71' },
  { id: '902', userId: SABINE.id, name: 'Sabine Laptop', platform: 'windows', vpnIp: '10.8.0.72' },
];
const PC = { id: '901', platform: 'windows', vpnIp: '10.8.0.71' };
const LAPTOP = { id: '902', platform: 'windows', vpnIp: null };
const PRO = { name: 'Büro-PC Marc', edition: 'pro', rdp: { available: true, enabled: true, port: 3389 }, osUser: 'marc', appVersion: '1.97.0', screen: { view: true, control: true } };
const HOME = { name: 'Laptop Sabine', edition: 'home', rdp: { available: false, enabled: false, port: 3389 }, osUser: 'sabine', appVersion: '1.97.0', screen: { view: true, control: true } };

async function start(o = {}) {
  const s = await setup({ gatecontrol: o.gatecontrol || '1.288.0', host: { devices: DEVICES, ...(o.host || {}) } });
  const app = async (user, dev, method, path, body) => {
    const r = await s.host.request({ method, path, body: body || null, user: { ...user, app: true, portal: true, loggedIn: true, device: dev }, lang: 'de' });
    return { status: r.status || 200, ...r.json };
  };
  return { ...s, app };
}

const signals = (host, type) => host.notifications.filter((n) => n.topic === 'remote_signal' && n.data && n.data.type === type);
const lastSignal = (host, type) => signals(host, type).slice(-1)[0];
const screenCalls = (host) => host.remote.calls.filter((c) => c.op === 'screen');

test('Windows Home with "Bildschirm teilen" is a device now (protocol screen); without it still home_edition', async () => {
  const s = await start();
  try {
    assert.equal((await s.app(SABINE, LAPTOP, 'POST', '/host/register', { ...HOME, screen: { view: false } })).code, 'home_edition');
    const r = await s.app(SABINE, LAPTOP, 'POST', '/host/register', HOME);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual([r.host.state, r.host.platform, r.host.screen, r.host.rdp], ['ready', 'windows', { view: true, control: true }, { offered: false }]);
    const admin = (await s.adminReq('GET', 'devices')).devices.find((x) => x.id === r.host.deviceId);
    assert.equal(admin.protocol, 'screen');
    assert.deepEqual([admin.host.screenView, admin.host.screenControl, admin.host.rdpOffered], [true, true, false]);
    // the portal shows it with the screen and without Remote Desktop
    const own = (await s.req(ADMIN, 'GET', '/overview')).devices.find((x) => x.id === r.host.deviceId);
    assert.deepEqual([own.protocol, own.screen, own.rdp, own.ready], ['screen', { view: true, control: true }, false, true]);
    // no VPN address needed for the screen alone
    assert.ok(!admin.config.host);
  } finally { await s.host.stop(); }
});

test('without GateControl\'s relay: Home is refused with screen_unavailable, a Pro PC keeps Remote Desktop only', async () => {
  const s = await start({ gatecontrol: '1.284.0' });
  try {
    assert.equal((await s.app(SABINE, LAPTOP, 'POST', '/host/register', HOME)).code, 'screen_unavailable');
    const r = await s.app(MARC, PC, 'POST', '/host/register', PRO);
    assert.equal(r.ok, true);
    assert.deepEqual([r.host.screen, r.host.rdp], [{ view: false, control: false }, { offered: true }]);
  } finally { await s.host.stop(); }
});

test('a Pro PC with both: the helper chooses; the screen is asked at the PC and controlled only after the choice there', async () => {
  const s = await start();
  try {
    const id = (await s.app(MARC, PC, 'POST', '/host/register', PRO)).host.deviceId;
    const view = (await s.req(ADMIN, 'GET', '/overview')).devices.find((x) => x.id === id);
    assert.deepEqual([view.protocol, view.screen, view.rdp], ['rdp', { view: true, control: true }, true]);

    // the browser without a kind: the screen (support); a request of kind screen, mode control
    let { code } = await s.app(MARC, PC, 'POST', '/host/code');
    let rq = (await s.req(ADMIN, 'POST', '/code/redeem', { code, mode: 'control', via: 'browser' })).request;
    assert.deepEqual([rq.kind, rq.mode], ['screen', 'control']);
    const sig = lastSignal(s.host, 'remote.request').data;
    assert.deepEqual([sig.kind, sig.mode, sig.from.name], ['screen', 'control', 'Admin']);
    assert.equal((await s.app(MARC, PC, 'POST', '/host/state', { rdp: { enabled: true }, online: true })).pending[0].kind, 'screen');

    // allowed without control → view; the PC gets the sending side of the relay ticket
    let ok = await s.app(MARC, PC, 'POST', '/host/requests/' + rq.id, { decision: 'allow' });
    assert.equal(ok.request.mode, 'view');
    assert.ok(ok.screen && ok.screen.ref && ok.screen.wsPath === '/api/v1/remote/screen-relay');
    const call = screenCalls(s.host).slice(-1)[0];
    assert.deepEqual([call.mode, call.sender.user, call.sender.device], ['view', MARC.id, '901']);
    const c = await s.req(ADMIN, 'POST', '/requests/' + rq.id + '/connect', {});
    assert.deepEqual([c.session.protocol, c.session.engine, c.session.mode], ['screen', 'screen', 'view']);
    // no firewall for the screen
    assert.equal(signals(s.host, 'remote.firewall.open').length, 0);

    // the person chooses "Ansehen und steuern" for this request: control
    ({ code } = await s.app(MARC, PC, 'POST', '/host/code'));
    rq = (await s.req(ADMIN, 'POST', '/code/redeem', { code, mode: 'control', via: 'browser', kind: 'screen' })).request;
    ok = await s.app(MARC, PC, 'POST', '/host/requests/' + rq.id, { decision: 'allow', mode: 'control' });
    assert.equal(ok.request.mode, 'control');
    assert.equal(screenCalls(s.host).slice(-1)[0].mode, 'control');

    // Remote Desktop asked for explicitly: the old way (a request of kind rdp, then the firewall)
    ({ code } = await s.app(MARC, PC, 'POST', '/host/code'));
    rq = (await s.req(ADMIN, 'POST', '/code/redeem', { code, mode: 'control', via: 'browser', kind: 'rdp' })).request;
    assert.equal(rq.kind, 'rdp');
    // an app without a kind (before 1.5, mstsc): Remote Desktop as before
    ({ code } = await s.app(MARC, PC, 'POST', '/host/code'));
    const appRq = await s.app(ADMIN, { id: '999', platform: 'windows', vpnIp: '10.8.0.99' }, 'POST', '/code/redeem', { code, mode: 'control', via: 'app' });
    assert.equal(appRq.request.kind, 'rdp');
    // a bad kind
    ({ code } = await s.app(MARC, PC, 'POST', '/host/code'));
    assert.equal((await s.req(ADMIN, 'POST', '/code/redeem', { code, mode: 'view', via: 'browser', kind: 'vnc' })).code, 'invalid');
  } finally { await s.host.stop(); }
});

test('"ohne Code" spares the code for the screen of a PC, never the question; an old app\'s answer is view', async () => {
  const s = await start();
  try {
    const id = (await s.app(SABINE, LAPTOP, 'POST', '/host/register', { ...HOME, shareMode: 'open' })).host.deviceId;
    await s.app(SABINE, LAPTOP, 'PUT', '/host/access', { users: [SABINE.id, LEA.id], groups: [] });
    await s.adminReq('PUT', 'rights/user/' + LEA.id, { rdp: true });
    const r = await s.req(LEA, 'POST', '/devices/' + id + '/connect', { mode: 'control' });
    assert.ok(r.request, JSON.stringify(r));
    assert.deepEqual([r.request.kind, r.request.mode, r.request.state], ['screen', 'control', 'waiting']);
    const ok = await s.app(SABINE, LAPTOP, 'POST', '/host/requests/' + r.request.id, { decision: 'allow' });
    assert.equal(ok.request.mode, 'view');
    // Remote Desktop is not offered by a Home PC
    assert.equal((await s.req(LEA, 'POST', '/devices/' + id + '/connect', { kind: 'rdp' })).code, 'rdp_off');
  } finally { await s.host.stop(); }
});

test('a PC whose app cannot control and an older GateControl: only watching, with the reason', async () => {
  const s = await start();
  try {
    const id = (await s.app(SABINE, LAPTOP, 'POST', '/host/register', { ...HOME, screen: { view: true, control: false } })).host.deviceId;
    const { code } = await s.app(SABINE, LAPTOP, 'POST', '/host/code');
    const rq = (await s.req(ADMIN, 'POST', '/code/redeem', { code, mode: 'control', via: 'browser', deviceId: id })).request;
    assert.deepEqual([rq.mode, rq.modeReason], ['view', 'pc_view_only']);
  } finally { await s.host.stop(); }
  const s4 = await start({ gatecontrol: '1.286.0' });
  try {
    await s4.app(SABINE, LAPTOP, 'POST', '/host/register', HOME);
    const { code } = await s4.app(SABINE, LAPTOP, 'POST', '/host/code');
    const rq = (await s4.req(ADMIN, 'POST', '/code/redeem', { code, mode: 'control', via: 'browser' })).request;
    assert.deepEqual([rq.mode, rq.modeReason], ['view', 'server_view_only']);
  } finally { await s4.host.stop(); }
});

test('switching "Bildschirm teilen" off ends its requests and the relay; Remote Desktop stays; a new code after the session', async () => {
  const s = await start();
  try {
    await s.app(MARC, PC, 'POST', '/host/register', PRO);
    const { code } = await s.app(MARC, PC, 'POST', '/host/code');
    const rq = (await s.req(ADMIN, 'POST', '/code/redeem', { code, mode: 'control', via: 'browser', kind: 'screen' })).request;
    const ok = await s.app(MARC, PC, 'POST', '/host/requests/' + rq.id, { decision: 'allow', mode: 'control' });
    const c = await s.req(ADMIN, 'POST', '/requests/' + rq.id + '/connect', {});
    await s.host.remoteScreenStart(c.session.ref, { via: 'browser' });
    assert.ok(ok.screen.ref);
    // the switch goes off: register again without the screen
    const r = await s.app(MARC, PC, 'POST', '/host/register', { ...PRO, screen: { view: false, control: true } });
    assert.deepEqual([r.host.screen.view, r.host.rdp.offered, r.host.state], [false, true, 'ready']);
    const after = (await s.req(ADMIN, 'GET', '/requests/' + rq.id)).request;
    assert.equal(after.state, 'ended');
    assert.ok(s.host.remote.calls.some((x) => x.op === 'end' && x.ref === c.session.ref), 'the relay ticket ended');
    // the screen is off now: a screen request is refused
    const { code: c2 } = await s.app(MARC, PC, 'POST', '/host/code');
    assert.equal((await s.req(ADMIN, 'POST', '/code/redeem', { code: c2, mode: 'view', via: 'browser', kind: 'screen' })).code, 'screen_off');
    // Remote Desktop off, the screen on: a device of protocol screen (no 3389 needed)
    const r2 = await s.app(MARC, PC, 'POST', '/host/register', { ...PRO, rdp: { ...PRO.rdp, offered: false } });
    assert.deepEqual([r2.host.rdp.offered, r2.host.screen.view], [false, true]);
    const admin = (await s.adminReq('GET', 'devices')).devices.find((x) => x.id === r2.host.deviceId);
    assert.equal(admin.protocol, 'screen');
    // both off is no registration (the app signs off with DELETE host)
    assert.equal((await s.app(MARC, PC, 'POST', '/host/register', { ...PRO, rdp: { ...PRO.rdp, offered: false }, screen: { view: false } })).code, 'invalid');
  } finally { await s.host.stop(); }
});

test('the PC ends a request before its picture runs (capture failed) and hears the end of a session', async () => {
  const s = await start();
  try {
    await s.app(SABINE, LAPTOP, 'POST', '/host/register', HOME);
    let { code } = await s.app(SABINE, LAPTOP, 'POST', '/host/code');
    let rq = (await s.req(ADMIN, 'POST', '/code/redeem', { code, mode: 'view', via: 'browser' })).request;
    await s.app(SABINE, LAPTOP, 'POST', '/host/requests/' + rq.id, { decision: 'allow' });
    assert.deepEqual(await s.app(SABINE, LAPTOP, 'POST', '/host/screen/' + rq.id + '/end', { reason: 'failed' }), { status: 200, ok: true, ended: true });
    assert.equal((await s.req(ADMIN, 'GET', '/requests/' + rq.id)).request.state, 'ended');
    ({ code } = await s.app(SABINE, LAPTOP, 'POST', '/host/code'));
    rq = (await s.req(ADMIN, 'POST', '/code/redeem', { code, mode: 'view', via: 'browser' })).request;
    await s.app(SABINE, LAPTOP, 'POST', '/host/requests/' + rq.id, { decision: 'allow' });
    const c = await s.req(ADMIN, 'POST', '/requests/' + rq.id + '/connect', {});
    await s.host.remoteScreenStart(c.session.ref, { via: 'browser' });
    await s.host.remoteScreenEnd(c.session.ref, 'viewer');
    const end = lastSignal(s.host, 'remote.screen.end');
    assert.deepEqual([end.data.requestId, end.data.reason], [rq.id, 'viewer']);
    const prof = await s.app(SABINE, LAPTOP, 'GET', '/profile');
    const types = prof.history.map((e) => e.type);
    assert.ok(types.includes('remote_screen_started') && types.includes('remote_screen_ended'), JSON.stringify(types));
    const allowed = prof.history.find((e) => e.type === 'remote_request_allowed');
    assert.equal(allowed.details.kind, 'screen');
  } finally { await s.host.stop(); }
});
