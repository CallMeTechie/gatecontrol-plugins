'use strict';

// Test helpers: the mock host (tools/testing/mock-host.js) with a fake Midea
// cloud (MSmartHome API behind gc.http.fetch) and fake air conditioners in
// the home network (V2 and V3 LAN protocol behind the home target "ac").

const path = require('node:path');
const crypto = require('node:crypto');
const EventEmitter = require('node:events');
const { createHost } = require('../../../tools/testing/mock-host');
const ac = require('../server/ac');
const lan = require('../server/lan');
const mcrypto = require('../server/crypto');
const { APP_VARIANTS, computeUdpid, sessionCbcEncrypt, sessionCbcDecrypt } = require('../server/cloud');
const service = require('../server/service');
const { md5 } = require('../server/dreo');

const DIR = path.join(__dirname, '..');

const ADMIN = { id: 1, name: 'admin', role: 'admin' };
const ADA = { id: 2, name: 'Ada', role: 'user' };
const BOB = { id: 3, name: 'Bob', role: 'user' };
const USERS = [ADMIN, ADA, BOB];

const MODE_NUM = { auto: 1, cool: 2, dry: 3, heat: 4, fan: 5 };

/** A 0xC0 state answer frame for `st` (the inverse of ac.parseState). */
function stateFrame(st) {
  const p = Buffer.alloc(24);
  p[0] = 0xc0;
  p[1] = (st.power ? 0x01 : 0x00) | (st.applianceError ? 0x80 : 0x00);
  const t = Number(st.targetTemp);
  p[2] = ((MODE_NUM[st.mode] || 1) << 5) | ((Math.floor(t) - 16) & 0x0f) | (t % 1 ? 0x10 : 0);
  p[3] = Number(st.fanSpeed) & 0x7f;
  p[7] = (st.swingV ? 0x0c : 0) | (st.swingH ? 0x03 : 0);
  p[8] = st.turbo ? 0x20 : 0;
  p[9] = st.eco ? 0x10 : 0;
  p[11] = st.indoorTemp == null ? 0xff : Math.round(st.indoorTemp * 2 + 50);
  p[12] = st.outdoorTemp == null ? 0xff : Math.round(st.outdoorTemp * 2 + 50);
  p[13] = st.filterAlert ? 0x20 : 0x00;
  p[16] = Number(st.errorCode) & 0xff;
  return ac.buildFrame(0x03, p, 0);
}

/** A fake air conditioner: answers query and control frames. */
function fakeAc(initial = {}) {
  const dev = {
    state: { power: false, mode: 'cool', targetTemp: 24, fanSpeed: 60, swingV: false, swingH: false, turbo: false, eco: false, indoorTemp: 23.5, outdoorTemp: 31, ...initial },
    frames: [],
    down: false,
  };
  /** frame (0xAA …) → answer frame */
  dev.handle = (frame) => {
    dev.frames.push(frame[9]);
    if (frame[9] === 0x02) {
      const p = frame.slice(10, -3);
      const modes = { 1: 'auto', 2: 'cool', 3: 'dry', 4: 'heat', 5: 'fan' };
      let target = (p[2] & 0x0f) + 16 + (p[2] & 0x10 ? 0.5 : 0);
      if (p[18]) target = (p[18] & 0x1f) + 12;
      Object.assign(dev.state, {
        power: (p[1] & 0x01) !== 0, mode: modes[(p[2] >> 5) & 0x07] || 'auto', targetTemp: target, fanSpeed: p[3],
        swingV: (p[7] & 0x0c) !== 0, swingH: (p[7] & 0x03) !== 0, turbo: (p[10] & 0x02) !== 0, eco: (p[9] & 0x80) !== 0,
      });
    }
    return stateFrame(dev.state);
  };
  return dev;
}

/**
 * A fake TCP socket to a LAN air conditioner (what gc.net.tcpTarget hands out),
 * speaking V2 or V3 (token/key handshake). Answers come back in two chunks.
 */
function fakeSocket(dev, { version = 2, deviceId = '151732605161920', token = null, key = null } = {}) {
  const sock = new EventEmitter();
  let localKey = null;
  const reply = (buf) => setImmediate(() => {
    const cut = Math.max(1, Math.floor(buf.length / 2));
    sock.emit('data', buf.slice(0, cut));
    setImmediate(() => sock.emit('data', buf.slice(cut)));
  });
  sock.write = async (buf) => {
    if (dev.down) { setImmediate(() => { sock.emit('error', new Error('connect ECONNREFUSED')); sock.emit('close'); }); return; }
    if (version === 2) {
      const frame = lan.decodePacket(buf);
      reply(lan.encodePacket(Number(deviceId), dev.handle(frame)));
      return;
    }
    if ((buf[5] & 0x0f) === 0x0) { // handshake: [pid][token]
      const rx = buf.slice(8);
      if (!rx.equals(Buffer.from(token, 'hex'))) { setImmediate(() => sock.emit('close')); return; }
      const k = Buffer.from(key, 'hex');
      const plain = crypto.randomBytes(32);
      localKey = mcrypto.strxor(plain, k);
      const payload = Buffer.concat([mcrypto.encryptAesCbc(k, plain), mcrypto.sha256(plain)]);
      const header = Buffer.from([0x83, 0x70, 0, 64, 0x20, 0x01]);
      reply(Buffer.concat([header, Buffer.from([0, 1]), payload]));
      return;
    }
    const inner = lan.decodeEncryptedResponse(localKey, buf); // same framing both ways
    const frame = lan.decodePacket(inner);
    const answer = lan.encodePacket(Number(deviceId), dev.handle(frame));
    reply(lan.encodeEncryptedRequest(localKey, answer, 2));
  };
  sock.destroy = async () => { sock.emit('close'); };
  sock.end = sock.destroy;
  sock.setTimeout = async () => {};
  return sock;
}

/** The UDP discovery answer of an air conditioner (V2 5a5a, or V3 wrapped in 8370). */
function discoveryAnswer({ ip = '192.168.1.60', port = 6444, deviceId = '151732605161920', sn = '000000P0000000Q1B88C29C963BD0000', version = 3, type = 'ac' } = {}) {
  const body = Buffer.alloc(96);
  ip.split('.').map(Number).forEach((o, i) => { body[3 - i] = o; });
  body.writeUInt16LE(port, 4);
  Buffer.from(sn.padEnd(32, '0').slice(0, 32), 'ascii').copy(body, 8);
  const name = `net_${type}_63BD`;
  body[40] = name.length;
  Buffer.from(name, 'ascii').copy(body, 41);
  const enc = mcrypto.encryptAesEcb(body);
  const head = Buffer.alloc(40);
  head[0] = 0x5a; head[1] = 0x5a;
  let id = BigInt(deviceId);
  for (let i = 0; i < 6; i++) { head[20 + i] = Number(id & 0xffn); id >>= 8n; }
  const v2 = Buffer.concat([head, enc, Buffer.alloc(16)]);
  if (version === 2) return v2;
  return Buffer.concat([Buffer.from([0x83, 0x70, 0, 0, 0x20, 0x01, 0, 0]), v2, Buffer.alloc(16)]);
}

/**
 * A fake Midea cloud (MSmartHome): login (with session key/IV), appliance
 * list, V3 tokens, transparent send to fake air conditioners by appliance id.
 */
function fakeCloud(opts = {}) {
  const cfg = APP_VARIANTS.msmarthome;
  const cloud = {
    email: opts.email || 'ac@example.com',
    password: opts.password || 'secret-pw',
    appliances: opts.appliances || [{ id: '153931628798542', sn: 'SN-CLOUD-1', name: 'Wohnzimmer', type: '0xAC', onlineStatus: '1' }],
    devices: opts.devices || {},          // appliance id → fakeAc()
    tokens: opts.tokens || {},            // device id → { token, key }
    require2fa: false,
    rateLimited: false,
    logins: 0,
    calls: [],
    aesKey: crypto.randomBytes(16),
    aesIv: crypto.randomBytes(16),
  };
  const ok = (data) => ({ status: 200, body: JSON.stringify({ code: '0', data }) });
  const err = (code, msg) => ({ status: 200, body: JSON.stringify({ code, msg }) });
  cloud.fetch = async (url, o) => {
    const u = new URL(url);
    const alias = u.searchParams.get('alias');
    cloud.calls.push(alias);
    if (cloud.rateLimited) return { status: 429, body: '' };
    const body = JSON.parse(o.body);
    if (alias === '/v1/user/login/id/get') return ok({ loginId: 'LID-1' });
    if (alias === '/mj/user/login') {
      if (cloud.require2fa) return err('1', 'need verification code');
      if (body.iotData.loginAccount !== cloud.email) return err('3101', 'account or password error');
      cloud.logins += 1;
      const tmp = mcrypto.sha256(Buffer.from(cfg.loginKey, 'ascii')).toString('hex');
      const k = Buffer.from(tmp.slice(0, 16), 'ascii');
      const iv = Buffer.from(tmp.slice(16, 32), 'ascii');
      return ok({
        mdata: { accessToken: 'BEARER-' + cloud.logins },
        accessToken: sessionCbcEncrypt(k, iv, cloud.aesKey).toString('hex'),
        randomData: sessionCbcEncrypt(k, iv, cloud.aesIv).toString('hex'),
      });
    }
    if (!String(o.headers.accessToken || '').startsWith('BEARER-')) return err('40001', 'not logged in');
    if (alias === '/v1/appliance/user/list/get') return ok({ list: cloud.appliances });
    if (alias === '/v1/iot/secure/getToken') {
      for (const [devId, tk] of Object.entries(cloud.tokens)) {
        const n = Number(BigInt(devId));
        for (const le of [true, false]) {
          const b = Buffer.alloc(6);
          if (le) b.writeUIntLE(n, 0, 6); else b.writeUIntBE(n, 0, 6);
          if (computeUdpid(b) === body.udpid) return ok({ tokenlist: [{ udpId: body.udpid, ...tk }] });
        }
      }
      return ok({ tokenlist: [] });
    }
    if (alias === '/v1/appliance/transparent/send') {
      const dev = cloud.devices[body.applianceCode];
      if (!dev || dev.down) return err('3176', 'asyn reply does not exist');
      const plain = sessionCbcDecrypt(cloud.aesKey, cloud.aesIv, Buffer.from(body.order, 'hex')).toString('ascii');
      const answer = dev.handle(Buffer.from(plain.split(',').map(Number)));
      return ok({ reply: sessionCbcEncrypt(cloud.aesKey, cloud.aesIv, Buffer.from(Array.from(answer).join(','), 'ascii')).toString('hex') });
    }
    return err('404', 'unknown');
  };
  return cloud;
}

/**
 * A fake Dreo cloud (the app's API): login (answers with the account's region
 * — a login at the wrong region is retried there), device list, device state
 * (REST, values in { state } wrappers, temperatures in °F) and the WebSocket
 * (wsb-<region>): control commands change the device and are acknowledged
 * (control-reply + control-report); `push` sends a device's own report.
 */
function fakeDreo(opts = {}) {
  const dreo = {
    email: opts.email || 'heat@example.com',
    password: opts.password || 'dreo-pw',
    region: opts.region || 'EU',
    devices: opts.devices || [
      { sn: 'HSH009S-1', deviceName: 'Bad', model: 'DR-HSH009S', productName: 'Heater' },
      { sn: 'HAC006S-1', deviceName: 'Schlafzimmer', model: 'DR-HAC006S', productName: 'Air Conditioner' },
      { sn: 'HTF001S-1', deviceName: 'Turm', model: 'DR-HTF001S', productName: 'Tower Fan' },
    ],
    states: opts.states || {
      'HSH009S-1': { poweron: true, connected: true, mode: 'hotair', htalevel: 2, ecolevel: 72, temperature: 68, oscon: true, oscangle: 60, childlockon: false, muteon: true, ptcon: true },
      'HAC006S-1': { poweron: false, connected: true, mode: 1, templevel: 76, temperature: 79, windlevel: 4, oscmode: 0, rh: 55 },
      'HTF001S-1': { poweron: false, connected: true },
    },
    logins: 0, tokens: new Set(), stateReads: 0, commands: [], sockets: [],
    silent: false, reject: null, rateLimited: false,
  };
  const ok = (data) => ({ status: 200, body: JSON.stringify({ code: 0, msg: 'OK', data }) });
  dreo.fetch = async (url, o) => {
    const u = new URL(url);
    const region = u.hostname.startsWith('app-api-eu.') ? 'EU' : 'NA';
    if (dreo.rateLimited) return { status: 429, body: '' };
    if (u.pathname === '/api/oauth/login') {
      const b = JSON.parse(o.body);
      if (b.email !== dreo.email || b.password !== md5(dreo.password) || b.grant_type !== 'email-password') return { status: 200, body: JSON.stringify({ code: 10001, msg: 'wrong account or password' }) };
      if (region !== dreo.region) return ok({ region: dreo.region, access_token: 'wrong-region' });
      dreo.logins += 1;
      const token = 'TOKEN-' + dreo.logins;
      dreo.tokens.add(token);
      return ok({ access_token: token, region: dreo.region });
    }
    const auth = String((o.headers && o.headers.authorization) || '').replace(/^Bearer /, '');
    if (region !== dreo.region || !dreo.tokens.has(auth)) return { status: 401, body: '' };
    if (u.pathname === '/api/v2/user-device/device/list') return ok({ list: dreo.devices, totalNum: dreo.devices.length });
    if (u.pathname === '/api/user-device/device/state') {
      dreo.stateReads += 1;
      const st = dreo.states[u.searchParams.get('deviceSn')];
      if (!st) return { status: 200, body: JSON.stringify({ code: 404, msg: 'no such device' }) };
      const mixed = {};
      for (const [k, v] of Object.entries(st)) mixed[k] = { state: v, timestamp: 1 };
      return ok({ deviceSn: u.searchParams.get('deviceSn'), mixed });
    }
    return { status: 404, body: '' };
  };
  dreo.websocket = async (url, o, peer) => {
    const u = new URL(url);
    if (u.hostname !== `wsb-${dreo.region === 'EU' ? 'eu' : 'us'}.dreo-tech.com` || !dreo.tokens.has(u.searchParams.get('accessToken'))) {
      throw Object.assign(new Error('unexpected response 401'), { code: 'ERR_NET' });
    }
    dreo.sockets.push(peer);
    return {
      message: (data) => {
        if (data === '2') return;
        const m = JSON.parse(String(data));
        dreo.commands.push({ sn: m.devicesn, params: m.params });
        if (dreo.silent) return;
        if (dreo.reject) { peer.send(JSON.stringify({ devicesn: m.devicesn, method: 'control-reply', reported: { error_code: dreo.reject, error_msg: 'instruction validate failed' } })); return; }
        Object.assign(dreo.states[m.devicesn] || {}, m.params);
        peer.send(JSON.stringify({ devicesn: m.devicesn, method: 'control-reply', reported: m.params }));
        peer.send(JSON.stringify({ devicesn: m.devicesn, method: 'control-report', reported: m.params }));
      },
    };
  };
  /** A report the device sends by itself (someone used the device or its remote). */
  dreo.push = (sn, reported, method = 'report') => {
    Object.assign(dreo.states[sn], reported);
    for (const p of dreo.sockets) if (!p.closed) p.send(JSON.stringify({ devicesn: sn, method, reported }));
  };
  dreo.offline = (sn) => { for (const p of dreo.sockets) if (!p.closed) p.send(JSON.stringify({ devicesn: sn, method: 'device-offline' })); };
  return dreo;
}

/**
 * Mock host with a fake cloud and LAN devices: `lan` = [{ dev, version, token, key, label, answer }]
 * become the assigned "ac" targets 0…n (TCP through the service seam, UDP probe answers `answer`).
 */
async function withHost(o, fn) {
  const cloud = o.cloud || fakeCloud();
  const dreo = o.dreo || null;
  const lanDevs = o.lan || [];
  const host = await createHost(DIR, {
    users: o.users || USERS,
    settings: o.settings,
    license: o.license,
    fetch: (url, fo) => (dreo && /\.dreo-tech\.com$/.test(new URL(url).hostname) ? dreo.fetch(url, fo) : cloud.fetch(url, fo)),
    websocket: dreo && o.websocket !== false ? dreo.websocket : undefined,
    targets: {
      ac: lanDevs.map((l, i) => ({
        label: l.label || `192.168.1.${60 + i}`,
        udp: async () => (l.answer ? [{ address: l.label || `192.168.1.${60 + i}`, port: 6445, data: l.answer }] : []),
      })),
    },
    discover: o.discover,
  });
  const seams = { connectTarget: service.connectTarget, newCloud: service.newCloud };
  service.connectTarget = async (gc, index) => {
    const l = lanDevs[index];
    if (!l) throw Object.assign(new Error('target ac is not assigned'), { code: 'ERR_NET_DENIED' });
    if (l.dev.down) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ERR_NET' });
    return fakeSocket(l.dev, l);
  };
  service.newCloud = (gc, app) => {
    const c = seams.newCloud(gc, app);
    c.sendCommandBackoffMs = 0; // no 1.5 s waits between 3176 retries in tests
    return c;
  };
  try {
    await host.start();
    await fn(host, cloud, dreo);
  } finally {
    service.connectTarget = seams.connectTarget;
    service.newCloud = seams.newCloud;
    service.reset();
    await host.stop();
    await host.close();
  }
}

/** Requests as an administrator / a portal viewer. */
const asAdmin = (host, method, p, body) => host.request({ method, path: p, body: body === undefined ? null : body, user: ADMIN });
const asPortal = (host, user, method, p, body) => host.request({ method, path: p, body: body === undefined ? null : body, user: { ...user, portal: true } });

/** The status line of one account group on the settings page. */
const lineOf = (lines, group) => lines.find((l) => l.group === group) || null;

/** Enter the fake Midea account on the settings page (saving logs in); the status lines. */
async function connectCloud(host, cloud, extra = {}) {
  const lines = await host.saveSettings({ 'cloud.email': cloud.email, 'cloud.password': cloud.password, ...extra });
  const l = lineOf(lines, 'midea');
  if (!l || l.tone !== 'ok') throw new Error('connect failed: ' + JSON.stringify(lines));
  return lines;
}

/** Enter the fake Dreo account on the settings page; the status lines. */
async function connectDreo(host, dreo, password = dreo.password) {
  return host.saveSettings({ 'dreo.email': dreo.email, 'dreo.password': password });
}

module.exports = {
  DIR, ADMIN, ADA, BOB, USERS,
  stateFrame, fakeAc, fakeSocket, discoveryAnswer, fakeCloud, fakeDreo, withHost, asAdmin, asPortal, connectCloud, connectDreo, lineOf,
};
