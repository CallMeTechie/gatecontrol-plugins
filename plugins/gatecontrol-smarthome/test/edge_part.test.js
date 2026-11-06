'use strict';

// The edge part (edge/index.js) with a `gc` of its own, shaped like the gateway's (gatecontrol-gateway
// src/edge/child/bootstrap.js): gc.handle/emit/config/onConfig/log, gc.mqtt.subscribe/publish, gc.lan.mdns.browse,
// gc.lan.http.request. The automatic set-up runs against a small fake HTTP server playing a Shelly Gen2 (Digest
// auth), a Shelly Gen1 (Basic auth) and Tasmota devices (with and without a web password).

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');

const ENTRY = path.join(__dirname, '..', 'edge', 'index.js');

const PW = { gen2: 'Geheim-Gen2!', gen1: 'geheim:gen1', tas: 'tas&pw=1' };
const MQTT_PASS = 'mqttPass_9aZ-xYv3QwErTy12';
const LAN = {
  eth0: [{ address: '192.168.1.23', netmask: '255.255.255.0', family: 'IPv4', internal: false }, { address: 'fe80::1', family: 'IPv6', internal: false }],
  wg0: [{ address: '10.8.0.2', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
  docker0: [{ address: '172.17.0.1', netmask: '255.255.0.0', family: 'IPv4', internal: false }],
  lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true }],
};

// ─── a fake LAN: devices behind one local HTTP server, addressed by the X-Device header ───

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function fakeLan() {
  const seen = [];
  const recorded = { gen2: [], gen1: [], tas: [] };
  const nonces = new Set();
  const realm = 'shellyplus1pm-a8032ab1c2d4';
  const json = (res, status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
  const form = (s) => Object.fromEntries(new URLSearchParams(s));
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const ip = req.headers['x-device'];
      const url = new URL(req.url, 'http://x');
      if (ip === '192.168.1.51') { // Shelly Plus 1PM, Gen2, password
        if (url.pathname === '/shelly') return json(res, 200, { name: null, id: realm, mac: 'A8032AB1C2D4', slot: 0, model: 'SNSW-001P16EU', gen: 2, fw_id: '20241011-114455/1.4.4-g6d2a586', ver: '1.4.4', app: 'Plus1PM', auth_en: true, auth_domain: realm });
        if (url.pathname === '/rpc' && req.method === 'POST') {
          const a = String(req.headers.authorization || '');
          const p = {};
          for (const m of a.matchAll(/([a-z]+)=(?:"([^"]*)"|([^\s,]+))/g)) p[m[1]] = m[2] != null ? m[2] : m[3];
          const ok = /^Digest /.test(a) && nonces.has(p.nonce) && p.algorithm === 'SHA-256' && p.qop === 'auth' && p.uri === '/rpc'
            && p.response === sha256(`${sha256(`admin:${realm}:${PW.gen2}`)}:${p.nonce}:${p.nc}:${p.cnonce}:auth:${sha256('POST:/rpc')}`);
          if (!ok) {
            const nonce = crypto.randomBytes(4).toString('hex');
            nonces.add(nonce);
            return json(res, 401, { code: 401, message: 'unauthorized' }, { 'WWW-Authenticate': `Digest qop="auth", realm="${realm}", nonce="${nonce}", algorithm=SHA-256` });
          }
          const call = JSON.parse(body);
          recorded.gen2.push(call);
          return json(res, 200, { id: call.id, src: realm, result: call.method === 'MQTT.SetConfig' ? { restart_required: true } : null });
        }
      }
      if (ip === '192.168.1.40') { // Shelly 1, Gen1, password (Basic)
        if (url.pathname === '/shelly') return json(res, 200, { type: 'SHSW-1', mac: '84CCA8A1B2C3', auth: true, fw: '20230913-114008/v1.14.0-gcb84623', discoverable: true });
        const good = req.headers.authorization === 'Basic ' + Buffer.from(`admin:${PW.gen1}`).toString('base64');
        if (!good) return json(res, 401, { error: 'unauthorized' });
        if (url.pathname === '/settings' && req.method === 'POST') { recorded.gen1.push(form(body)); return json(res, 200, { device: { type: 'SHSW-1' } }); }
        if (url.pathname === '/reboot') { recorded.gen1.push('reboot'); return json(res, 200, { ok: true }); }
      }
      if (ip === '192.168.1.62') { // Tasmota with a web password
        if (url.pathname === '/shelly') return json(res, 404, {});
        if (url.pathname === '/cm') {
          const args = { ...Object.fromEntries(url.searchParams), ...(req.method === 'POST' ? form(body) : {}) };
          if (args.user !== 'admin' || args.password !== PW.tas) return json(res, 401, { WARNING: 'Need user=<username>&password=<password>' });
          recorded.tas.push(args.cmnd);
          return json(res, 200, { MqttHost: '192.168.1.23' });
        }
      }
      if (ip === '192.168.1.63') { // Tasmota without a password
        if (url.pathname === '/cm' && url.searchParams.get('cmnd') === 'Status 0') {
          return json(res, 200, { Status: { Module: 1, DeviceName: 'Sonoff Basic', FriendlyName: ['sonoff-flur'], Topic: 'tasmota_A1B2C3', Power: 0 }, StatusFWR: { Version: '14.2.0(tasmota)' }, StatusNET: { Hostname: 'tasmota-A1B2C3-0451', IPAddress: '192.168.1.63', Mac: '24:A1:60:A1:B2:C3' } });
        }
        if (url.pathname === '/cm' && req.method === 'POST') { recorded.tas.push(form(body).cmnd); return json(res, 200, {}); }
        return json(res, 404, {});
      }
      return json(res, 404, { error: 'not found' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    /** gc.lan.http.request as the gateway's edge host answers it */
    const request = async (o) => {
      const u = new URL(o.url);
      seen.push({ method: o.method, url: o.url, headers: { ...(o.headers || {}) }, body: o.body == null ? '' : String(o.body) });
      if (u.hostname === '192.168.1.99') throw Object.assign(new Error('connect EHOSTUNREACH 192.168.1.99:80'), { code: 'net_error' });
      return new Promise((resolve2, reject) => {
        const r = http.request({ host: '127.0.0.1', port, method: o.method || 'GET', path: u.pathname + u.search, headers: { ...(o.headers || {}), 'X-Device': u.hostname } }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const buf = Buffer.concat(chunks);
            resolve2({ status: res.statusCode, headers: res.headers, body: buf, text: () => buf.toString('utf8'), json: () => JSON.parse(buf.toString('utf8')) });
          });
        });
        r.on('error', reject);
        if (o.body != null) r.write(o.body);
        r.end();
      });
    };
    resolve({ request, seen, recorded, close: () => new Promise((r) => server.close(r)) });
  }));
}

// ─── the edge part with a fake gc ───

function load({ request, mqttOff = false } = {}) {
  delete require.cache[require.resolve(ENTRY)];
  const part = require(ENTRY);
  part._test.hooks.interfaces = () => LAN;
  const handlers = new Map();
  const listeners = [];
  const events = [];
  const logs = [];
  const published = [];
  const subs = [];
  const browses = [];
  const storeWrites = [];
  const state = { mqttOff, config: null };
  const gc = Object.freeze({
    id: 'gatecontrol-smarthome',
    version: '1.7.0',
    handle: (m, fn) => handlers.set(m, fn),
    emit: (name, data) => events.push({ name, data: JSON.parse(JSON.stringify(data)) }),
    config: () => state.config,
    onConfig: (fn) => listeners.push(fn),
    log: Object.freeze({ info: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) }),
    store: Object.freeze({ get: async () => null, set: async (k, v) => storeWrites.push([k, v]), delete: async (k) => storeWrites.push([k, null]) }),
    lan: Object.freeze({
      http: Object.freeze({ request: request || (async () => { throw Object.assign(new Error('x'), { code: 'net_error' }); }) }),
      mdns: Object.freeze({ browse: async (service, onFound) => { browses.push({ service, onFound }); return { stop: async () => {} }; } }),
    }),
    mqtt: Object.freeze({
      subscribe: async (topic, fn) => {
        if (state.mqttOff) throw Object.assign(new Error('MQTT is not enabled on this gateway'), { code: 'not_enabled' });
        const s = { topic, fn, on: true };
        subs.push(s);
        return { unsubscribe: async () => { s.on = false; } };
      },
      publish: async (topic, payload, o) => { published.push({ topic, payload: String(payload), o }); },
    }),
  });
  return {
    part, gc, events, logs, published, subs, browses, storeWrites, state,
    async call(method, params) {
      const fn = handlers.get(method);
      if (!fn) throw Object.assign(new Error('unknown method'), { code: 'unknown_method' });
      return JSON.parse(JSON.stringify(await fn(params === undefined ? null : JSON.parse(JSON.stringify(params)), gc)));
    },
    configure(data) { state.config = data; for (const fn of listeners) fn(data, gc); },
    deliver(topic, payload) {
      for (const s of subs) if (s.on && topic.startsWith(s.topic.replace(/#$/, ''))) s.fn(topic, Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)), { retain: false, qos: 0 });
    },
  };
}

const tick = () => new Promise((r) => setImmediate(r));

test('reports the configured devices bundled, normalised, only after the server part configured them', async () => {
  const e = load();
  e.part.start(e.gc);
  try {
    await tick();
    assert.deepEqual(e.subs.map((s) => s.topic), ['shellies/#', 'tasmota/#']);
    e.deliver('shellies/licht-flur/online', 'true');
    e.deliver('shellies/licht-flur/status/switch:0', { id: 0, output: true, apower: 12.5, aenergy: { total: 100 } });
    e.part._test.flush();
    assert.deepEqual(e.events, [], 'nothing before the configuration');
    e.configure({ devices: [{ base: 'shellies/licht-flur', family: 'shelly2' }, { base: 'tasmota/truhe', family: 'tasmota' }] });
    await tick();
    assert.deepEqual(e.published.map((m) => [m.topic, m.payload]), [
      ['shellies/licht-flur/command', 'status_update'], ['tasmota/truhe/cmnd/STATUS', '11'], ['tasmota/truhe/cmnd/STATUS', '10'],
    ], 'a new device is asked for its whole state');
    e.deliver('tasmota/truhe/tele/LWT', 'Online');
    e.deliver('tasmota/truhe/tele/STATE', { POWER: 'ON' });
    e.deliver('tasmota/truhe/tele/SENSOR', { ENERGY: { Power: 85, Today: 1.2 } });
    e.deliver('shellies/unbekannt/relay/0', 'on');
    e.deliver('shellies/licht-flur/status/switch:0', { id: 0, output: false, apower: 0 });
    e.part._test.flush();
    assert.equal(e.events.length, 1, 'one bundled event for many messages');
    const { name, data } = e.events[0];
    assert.equal(name, 'states');
    assert.deepEqual(data.devices.map((d) => d.base).sort(), ['shellies/licht-flur', 'tasmota/truhe'], 'unconfigured devices are not reported');
    const shelly = data.devices.find((d) => d.base === 'shellies/licht-flur');
    assert.deepEqual({ ...shelly, seenAt: typeof shelly.seenAt }, { base: 'shellies/licht-flur', family: 'shelly2', online: true, ch: { 'switch:0': { on: false, power: 0, energy: 100 } }, sensor: {}, info: {}, drop: [], seenAt: 'string' });
    assert.deepEqual(data.devices.find((d) => d.base === 'tasmota/truhe').ch, { 'switch:0': { on: true, power: 85, today: 1.2 } });
    e.part._test.flush();
    assert.equal(e.events.length, 1, 'nothing new, nothing sent');
  } finally { e.part.stop(e.gc); }
});

test('commands go out over MQTT; info; a broker that is off is retried, not a crash', async () => {
  const e = load({ mqttOff: true });
  e.part.start(e.gc);
  try {
    await tick();
    assert.equal((await e.call('info')).mqtt, 'off');
    assert.deepEqual((await e.call('info')).lan, ['192.168.1.23'], 'private LAN addresses only (no tunnel, docker, loopback)');
    await assert.rejects(e.call('command', { base: 'shellies/a', family: 'shelly2', ch: 'switch:0', op: 'on' }), (err) => err.code === 'mqtt_off');
    assert.equal(e.logs.filter((l) => /MQTT is not switched on for this gateway yet/.test(l)).length, 1);
    e.state.mqttOff = false;
    assert.equal((await e.call('refresh')).mqtt, 'ok');
    assert.deepEqual(await e.call('command', { base: 'shellies/a', family: 'shelly2', ch: 'switch:0', op: 'on' }), { sent: 1 });
    assert.deepEqual(JSON.parse(e.published.at(-1).payload).params, { id: 0, on: true });
    await assert.rejects(e.call('command', { base: 'shellies/a', family: 'shelly2', ch: 'switch:0', op: 'explode' }), (err) => err.code === 'bad_command');
  } finally { e.part.stop(e.gc); }
});

test('discovery: mDNS → probe → found event; other hosts and public addresses ignored', async (t) => {
  const lan = await fakeLan();
  const e = load({ request: lan.request });
  e.part.start(e.gc);
  try {
    await tick();
    assert.deepEqual(e.browses.map((b) => b.service), ['_shelly._tcp', '_http._tcp']);
    const http2 = e.browses.find((b) => b.service === '_http._tcp');
    http2.onFound({ host: 'nas.local', ip: '192.168.1.5', port: 80, service: '_http._tcp', txt: [] });
    http2.onFound({ host: 'shelly1-84cca8a1b2c3.local', ip: '8.8.8.8', port: 80, service: '_http._tcp', txt: [] });
    http2.onFound({ host: 'tasmota-a1b2c3-0451.local', ip: '192.168.1.63', port: 80, service: '_http._tcp', txt: [] });
    e.browses[0].onFound({ host: 'shellyplus1pm-a8032ab1c2d4.local', ip: '192.168.1.51', port: 80, service: '_shelly._tcp', txt: ['gen=2'] });
    for (let i = 0; i < 40 && e.events.filter((x) => x.name === 'found').length < 2; i++) await new Promise((r) => setTimeout(r, 50));
    const found = e.events.filter((x) => x.name === 'found').map((x) => x.data.devices[0]);
    assert.deepEqual(found.map((c) => [c.ip, c.family, c.model, c.name, c.auth]), [
      ['192.168.1.63', 'tasmota', 'Sonoff Basic', 'sonoff-flur', false],
      ['192.168.1.51', 'shelly2', 'Plus1PM', null, true],
    ]);
    assert.ok(!lan.seen.some((r) => /192\.168\.1\.5\/|8\.8\.8\.8/.test(r.url)), 'neither the NAS nor a public address was asked');
    assert.equal((await e.call('discover')).devices.length, 2);
  } finally { e.part.stop(e.gc); await lan.close(); }
});

test('automatic set-up: Gen2 with Digest, Gen1 with Basic, Tasmota with a web password — passwords never logged, stored or in a URL', async () => {
  const lan = await fakeLan();
  const e = load({ request: lan.request });
  e.part.start(e.gc);
  try {
    await tick();
    // probe
    assert.deepEqual(await e.call('probe', { ip: '192.168.1.51' }), {
      ip: '192.168.1.51', family: 'shelly2', gen: 2, model: 'Plus1PM', name: null, firmware: '1.4.4', id: 'shellyplus1pm-a8032ab1c2d4', mac: 'A8032AB1C2D4', auth: true, host: '192.168.1.23',
    });
    assert.equal((await e.call('probe', { ip: '192.168.1.40' })).family, 'shelly1');
    assert.deepEqual(await e.call('probe', { ip: '192.168.1.62' }), { ip: '192.168.1.62', family: 'tasmota', gen: null, model: null, name: null, firmware: null, id: null, mac: null, auth: true, host: '192.168.1.23' });
    await assert.rejects(e.call('probe', { ip: '192.168.1.99' }), (err) => err.code === 'unreachable' && !/192\.168/.test(err.message));
    await assert.rejects(e.call('probe', { ip: 'nas.local' }), (err) => err.code === 'bad_request');

    // Gen2: without a password → auth_required, a wrong one → auth_failed, the right one → MQTT.SetConfig + Reboot
    const gen2 = { ip: '192.168.1.51', family: 'shelly2', user: 'gatecontrol-smarthome-licht-flur', pass: MQTT_PASS, prefix: 'licht-flur' };
    await assert.rejects(e.call('setup', gen2), (err) => err.code === 'auth_required');
    await assert.rejects(e.call('setup', { ...gen2, password: 'falsch' }), (err) => err.code === 'auth_failed');
    assert.deepEqual(await e.call('setup', { ...gen2, password: PW.gen2 }), { ok: true, host: '192.168.1.23', port: 1883 });
    assert.deepEqual(lan.recorded.gen2.map((c) => [c.method, c.params]), [
      ['MQTT.SetConfig', { config: { enable: true, server: '192.168.1.23:1883', user: 'gatecontrol-smarthome-licht-flur', pass: MQTT_PASS, topic_prefix: 'shellies/licht-flur', rpc_ntf: true, status_ntf: true } }],
      ['Shelly.Reboot', {}],
    ]);

    // Gen1: Basic auth, /settings with the MQTT fields, then /reboot
    await assert.rejects(e.call('setup', { ip: '192.168.1.40', family: 'shelly1', user: 'u1', pass: MQTT_PASS, prefix: 'pumpe' }), (err) => err.code === 'auth_required');
    await e.call('setup', { ip: '192.168.1.40', family: 'shelly1', user: 'gatecontrol-smarthome-pumpe', pass: MQTT_PASS, prefix: 'pumpe', password: PW.gen1 });
    assert.deepEqual(lan.recorded.gen1, [{
      mqtt_enable: 'true', mqtt_server: '192.168.1.23:1883', mqtt_user: 'gatecontrol-smarthome-pumpe', mqtt_pass: MQTT_PASS, mqtt_id: 'pumpe', mqtt_clean_session: 'true', mqtt_retain: 'false',
    }, 'reboot']);

    // Tasmota: the Backlog in the form body, user/password as form fields
    await assert.rejects(e.call('setup', { ip: '192.168.1.62', family: 'tasmota', user: 'gatecontrol-smarthome-flur', pass: MQTT_PASS, prefix: 'flur', password: 'nope' }), (err) => err.code === 'auth_failed');
    await e.call('setup', { ip: '192.168.1.62', family: 'tasmota', user: 'gatecontrol-smarthome-flur', pass: MQTT_PASS, prefix: 'flur', password: PW.tas });
    assert.deepEqual(lan.recorded.tas, [`Backlog SetOption3 1; MqttHost 192.168.1.23; MqttPort 1883; MqttUser gatecontrol-smarthome-flur; MqttPassword ${MQTT_PASS}; Topic flur; FullTopic tasmota/%topic%/%prefix%/`]);
    await e.call('setup', { ip: '192.168.1.63', family: 'tasmota', user: 'gatecontrol-smarthome-sonoff', pass: MQTT_PASS, prefix: 'sonoff' });

    await assert.rejects(e.call('setup', { ...gen2, ip: '192.168.1.99', password: PW.gen2 }), (err) => err.code === 'unreachable');
    await assert.rejects(e.call('setup', { ...gen2, prefix: 'Bad Prefix' }), (err) => err.code === 'bad_request');

    // never in a URL, a log line, the store or an event
    const secrets = [PW.gen2, PW.gen1, PW.tas, 'falsch', 'nope', MQTT_PASS];
    const leak = (where, text) => { for (const s of secrets) assert.ok(!String(text).includes(s) && !String(text).includes(encodeURIComponent(s)), `${where} contains a password`); };
    for (const r of lan.seen) leak('URL ' + r.url, r.url);
    leak('log', e.logs.join('\n'));
    leak('events', JSON.stringify(e.events));
    assert.deepEqual(e.storeWrites, [], 'the edge part stores nothing');
    assert.ok(lan.seen.filter((r) => /\/rpc$/.test(r.url)).every((r) => !r.headers.Authorization || /^Digest /.test(r.headers.Authorization)));
  } finally { e.part.stop(e.gc); await lan.close(); }
});

test('the HTTP Digest helper follows RFC 7616 (SHA-256, qop=auth)', () => {
  const { parseChallenge, digestHeader } = require('../edge/devices');
  const ch = parseChallenge('Digest qop="auth", realm="shellyplus1-x", nonce="60dc59c6", algorithm=SHA-256');
  assert.deepEqual(ch, { qop: 'auth', realm: 'shellyplus1-x', nonce: '60dc59c6', algorithm: 'SHA-256' });
  const h = digestHeader(ch, { method: 'POST', uri: '/rpc', user: 'admin', password: 'pw', nc: 1 });
  const p = Object.fromEntries([...h.matchAll(/([a-z]+)=(?:"([^"]*)"|([^\s,]+))/g)].map((m) => [m[1], m[2] != null ? m[2] : m[3]]));
  assert.equal(p.response, sha256(`${sha256('admin:shellyplus1-x:pw')}:60dc59c6:00000001:${p.cnonce}:auth:${sha256('POST:/rpc')}`));
  assert.equal(parseChallenge('Basic realm="x"'), null);
});
