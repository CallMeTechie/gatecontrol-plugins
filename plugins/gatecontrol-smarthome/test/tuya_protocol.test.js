'use strict';

// Tuya's local protocol (edge/tuya.js, since 1.21.0) against vectors made here and a device written independently
// (test/fixtures/tuya_device.js): framing, CRC / HMAC / GCM, the 3.1 signature, the session key of 3.4 and 3.5, the
// broadcasts, datapoints ↔ channels, and the connections (status, push, commands, a key that no longer fits).
// Every key and id here is made up.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const tuya = require('../edge/tuya');
const { tuyaDevice, broadcast, parse, crc32 } = require('./fixtures/tuya_device');

const KEY = 'k3y-0f-the-test!';                 // 16 printable characters, as a local key is
const ID = 'bf00test000device01';
const kb = Buffer.from(KEY, 'latin1');
const unecb = (key, data) => { const d = crypto.createDecipheriv('aes-128-ecb', key, null); return Buffer.concat([d.update(data), d.final()]); };

test('CRC32 and the discovery key are the standard ones', () => {
  assert.equal(tuya.crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(tuya.crc32(Buffer.from('123456789')), crc32(Buffer.from('123456789')));
  assert.equal(tuya.UDP_KEY.toString('hex'), crypto.createHash('md5').update('yGAdlopoPVldABfn').digest('hex'));
});

test('3.3: version header in clear, AES-ECB with the local key, CRC32 — a query without the header', () => {
  const f = tuya.encodeCommand('3.3', kb, 7, tuya.CMD.CONTROL, { devId: ID, dps: { 1: true } });
  const [p] = parse(f, null);
  assert.deepEqual([p.seq, p.cmd, p.ok, p.suffix], [7, 7, true, 0xaa55]);
  assert.equal(p.payload.subarray(0, 15).toString('latin1'), '3.3' + '\0'.repeat(12));
  assert.deepEqual(JSON.parse(unecb(kb, p.payload.subarray(15))), { devId: ID, dps: { 1: true } });
  const q = parse(tuya.encodeCommand('3.3', kb, 8, tuya.CMD.DP_QUERY, { gwId: ID }), null)[0];
  assert.deepEqual(JSON.parse(unecb(kb, q.payload)), { gwId: ID }, 'DP_QUERY goes without the header');
  // a broken byte: the CRC no longer fits
  const bad = Buffer.from(f);
  bad[20] ^= 1;
  assert.equal(tuya.unpack(tuya.split(bad).frames[0]).ok, false);
});

test('3.1: a command is base64 with an MD5 signature, a query is clear JSON', () => {
  const f = tuya.encodeCommand('3.1', kb, 1, tuya.CMD.CONTROL, { dps: { 1: false } });
  const [p] = parse(f, null);
  const text = p.payload.toString('latin1');
  assert.equal(text.slice(0, 3), '3.1');
  const b64 = text.slice(19);
  const sig = crypto.createHash('md5').update(`data=${b64}||lpv=3.1||${KEY}`).digest('hex').slice(8, 24);
  assert.equal(text.slice(3, 19), sig);
  assert.deepEqual(JSON.parse(unecb(kb, Buffer.from(b64, 'base64'))), { dps: { 1: false } });
  const q = parse(tuya.encodeCommand('3.1', kb, 2, tuya.CMD.DP_QUERY, { gwId: ID }), null)[0];
  assert.deepEqual(JSON.parse(q.payload.toString()), { gwId: ID });
});

test('3.4: the header inside the cipher text, HMAC-SHA256 instead of the CRC', () => {
  const f = tuya.encodeCommand('3.4', kb, 3, tuya.CMD.CONTROL_NEW, { protocol: 5, data: { dps: { 20: true } } });
  const [p] = parse(f, kb);
  assert.equal(p.ok, true, 'the HMAC is right');
  assert.equal(parse(f, Buffer.from('x'.repeat(16)))[0].ok, false, 'another key: the HMAC does not fit');
  const plain = unecb(kb, p.payload);
  assert.equal(plain.subarray(0, 3).toString(), '3.4');
  assert.deepEqual(JSON.parse(plain.subarray(15)), { protocol: 5, data: { dps: { 20: true } } });
  assert.equal(tuya.unpack(tuya.split(f).frames[0], kb).ok, true);
});

test('3.5: a 6699 frame — AES-GCM, the header as additional data, a fresh nonce each time', () => {
  const a = tuya.encodeCommand('3.5', kb, 4, tuya.CMD.CONTROL_NEW, { protocol: 5, data: { dps: { 1: true } } });
  const b = tuya.encodeCommand('3.5', kb, 4, tuya.CMD.CONTROL_NEW, { protocol: 5, data: { dps: { 1: true } } });
  assert.notDeepEqual(a, b, 'another nonce');
  const [p] = parse(a, kb);
  assert.deepEqual([p.ok, p.cmd, p.seq, p.suffix], [true, 13, 4, 0x9966]);
  assert.equal(p.payload.subarray(0, 3).toString(), '3.5');
  assert.deepEqual(JSON.parse(p.payload.subarray(15)), { protocol: 5, data: { dps: { 1: true } } });
  const changed = Buffer.from(a);
  changed[11] ^= 1; // the command in the header: covered by the tag
  assert.equal(tuya.unpack(changed, kb).ok, false);
});

test('split: several frames, bytes before them, half a frame left for later', () => {
  const f1 = tuya.encodeCommand('3.3', kb, 1, tuya.CMD.HEART_BEAT, {});
  const f2 = tuya.encodeCommand('3.5', kb, 2, tuya.CMD.DP_QUERY_NEW, {});
  const all = Buffer.concat([Buffer.from('noise'), f1, f2, f1.subarray(0, 10)]);
  const { frames, rest } = tuya.split(all);
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0], f1);
  assert.deepEqual(frames[1], f2);
  assert.deepEqual(rest, f1.subarray(0, 10));
  assert.equal(tuya.split(Buffer.concat([rest, f1.subarray(10)])).frames.length, 1);
});

test('the broadcasts of 3.1, 3.3 and 3.5 devices → id, address, version', () => {
  for (const ver of ['3.1', '3.3', '3.4', '3.5']) {
    const f = tuya.decodeUdp(broadcast(ver, { id: ID, ip: '192.168.1.41' }), { address: '192.168.1.41' });
    assert.deepEqual([f.id, f.ip, f.ver], [ID, '192.168.1.41', ver], ver);
  }
  assert.equal(tuya.decodeUdp(Buffer.from('nothing to see here, really nothing')), null);
  // the request for 3.5 devices is a 6699 frame with the discovery key
  const req = parse(tuya.discoveryRequest('192.168.1.23'), tuya.UDP_KEY)[0];
  assert.deepEqual([req.ok, req.cmd], [true, 0x25]);
  assert.deepEqual(JSON.parse(req.payload), { from: 'app', ip: '192.168.1.23' });
});

const PLUG = { k: 'plug', sw: [1, 7], pw: 19, pws: 1 };
const LIGHT2 = { k: 'light', l: { v: 2, sw: 20, mode: 21, bri: 22, temp: 23, col: 24, scene: 25, bmin: 10, bmax: 1000, tmax: 1000 } };
const LIGHT1 = { k: 'light', l: { v: 1, sw: 1, mode: 2, bri: 3, temp: 4, col: 5, scene: null, bmin: 25, bmax: 255, tmax: 255 } };

test('datapoints → channels: a plug with USB and power, a v2 light in white and colour, a v1 light', () => {
  assert.deepEqual(tuya.toPatch(PLUG, { 1: true, 7: false, 19: 4123, 20: 2290 }), { ch: { 'switch:0': { on: true, power: 412.3 }, 'switch:1': { on: false } } });
  assert.deepEqual(tuya.toPatch(LIGHT2, { 20: true, 21: 'white', 22: 1000, 23: 0 }), { ch: { 'light:0': { on: true, cm: 'ct', bri: 100, ct: 370 } } });
  assert.deepEqual(tuya.toPatch(LIGHT2, { 20: true, 21: 'colour', 22: 500, 24: '0078' + '03e8' + '01f4' }), { ch: { 'light:0': { on: true, cm: 'hs', hue: Math.round((120 / 360) * 65535), sat: 254, bri: 50 } } });
  assert.deepEqual(tuya.toPatch(LIGHT2, { 20: false, 21: 'scene' }).ch['light:0'], { on: false, cm: 'scene' });
  assert.deepEqual(tuya.toPatch(LIGHT1, { 1: true, 2: 'white', 3: 255, 4: 255 }).ch['light:0'], { on: true, cm: 'ct', bri: 100, ct: 154 });
});

test('commands → datapoints: switch, brightness, colour temperature, colour (keeps the brightness), scene; refused ones', () => {
  assert.deepEqual(tuya.toDps(PLUG, { ch: 'switch:1', op: 'off' }), { 7: false });
  assert.deepEqual(tuya.toDps(LIGHT2, { ch: 'light:0', op: 'bri', value: 100 }), { 20: true, 22: 1000 });
  assert.deepEqual(tuya.toDps(LIGHT2, { ch: 'light:0', op: 'bri', value: 1 }), { 20: true, 22: 10 });
  assert.deepEqual(tuya.toDps(LIGHT2, { ch: 'light:0', op: 'ct', value: 400 }), { 20: true, 21: 'white', 23: 0 }, 'warmer than 2700 K: the warmest it has');
  assert.deepEqual(tuya.toDps(LIGHT2, { ch: 'light:0', op: 'ct', value: 153 }), { 20: true, 21: 'white', 23: 1000 });
  const now = { 20: true, 21: 'white', 22: 500 };
  assert.deepEqual(tuya.toDps(LIGHT2, { ch: 'light:0', op: 'color', value: { hue: 43690, sat: 254 } }, now), { 20: true, 21: 'colour', 24: '00f0' + '03e8' + '01f4' });
  // in colour mode the brightness is the colour's value
  assert.deepEqual(tuya.toDps(LIGHT2, { ch: 'light:0', op: 'bri', value: 20 }, { 21: 'colour', 24: '00f003e803e8' }), { 20: true, 24: '00f003e800c8' });
  assert.deepEqual(tuya.toDps(LIGHT2, { ch: 'light:0', op: 'scene', value: 'night' }), { 20: true, 21: 'scene', 25: tuya.SCENES.night });
  assert.match(tuya.toDps(LIGHT1, { ch: 'light:0', op: 'color', value: { hue: 0, sat: 254 } })[5], /^ff0000[0-9a-f]{8}$/);
  for (const [p, c] of [[PLUG, { ch: 'switch:2', op: 'on' }], [PLUG, { ch: 'light:0', op: 'on' }], [LIGHT1, { ch: 'light:0', op: 'scene', value: 'night' }], [LIGHT2, { ch: 'light:0', op: 'ct', value: 100 }]]) {
    assert.throws(() => tuya.toDps(p, c), (e) => e.code === 'bad_command', JSON.stringify(c));
  }
});

// ─── Connections against the independent device ───

/** A clock of its own: timers run when the test says so. */
function clock() {
  let t = 1_000_000;
  let list = [];
  let n = 0;
  return {
    now: () => t,
    setTimer: (fn, ms) => { const id = ++n; list.push({ id, at: t + ms, fn }); return id; },
    clearTimer: (id) => { list = list.filter((x) => x.id !== id); },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        list.sort((a, b) => a.at - b.at);
        const next = list[0];
        if (!next || next.at > end) break;
        list.shift();
        t = next.at;
        next.fn();
        await settle();
      }
      t = end;
      await settle();
    },
  };
}

async function settle() { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); }

function manager(devs, c) {
  const updates = [];
  const m = tuya.create({
    tcp: { connect: (ip) => { const d = devs.get(ip); return d ? d.connect() : Promise.reject(Object.assign(new Error('unreachable'), { code: 'net_error' })); } },
    now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, onUpdate: (id) => updates.push(id),
  });
  return { m, updates };
}

for (const ver of ['3.1', '3.3', '3.4', '3.5']) {
  test(`a ${ver} device: connect, status, a push from the device, a command, heartbeats`, async () => {
    const c = clock();
    const dev = tuyaDevice({ id: ID, key: KEY, ver, dps: { 1: false, 19: 0 } });
    const { m } = manager(new Map([['192.168.1.41', dev]]), c);
    m.set([{ id: ID, key: KEY, ip: '192.168.1.41', ver, p: PLUG }]);
    await settle();
    let v = m.view(ID);
    assert.equal(v.link, 'ok');
    assert.deepEqual(v.dps, { 1: false, 19: 0 });
    dev.push({ 1: true, 19: 1234 });
    await settle();
    assert.deepEqual(m.view(ID).dps, { 1: true, 19: 1234 });
    await m.command(ID, { 1: false });
    await settle();
    assert.equal(dev.dps['1'], false);
    v = m.view(ID);
    assert.equal(v.dps['1'], false, 'the device reported the change');
    const ctl = dev.received.find((x) => x.cmd === (Number(ver.split('.')[1]) >= 4 ? 13 : 7));
    assert.ok(ctl, 'the command arrived');
    await c.advance(25000);
    assert.ok(dev.received.filter((x) => x.cmd === 9).length >= 2, 'heartbeats every 10 s');
    assert.equal(m.view(ID).link, 'ok');
    m.stop();
  });
}

test('a 3.3 device that hangs up on our key: after three tries and while its broadcasts are heard, "key"', async () => {
  const c = clock();
  const dev = tuyaDevice({ id: ID, key: KEY, ver: '3.3', wrongKey: true });
  const { m } = manager(new Map([['192.168.1.42', dev]]), c);
  m.set([{ id: ID, key: KEY, ip: '192.168.1.42', ver: '3.3', p: PLUG }]);
  m.seen(ID, '192.168.1.42', '3.3');
  await settle();
  await c.advance(20000);
  assert.equal(m.view(ID).link, 'key');
  await assert.rejects(m.command(ID, { 1: true }), (e) => e.code === 'tuya_key');
  const n = dev.connects;
  await c.advance(5 * 60 * 1000);
  assert.equal(dev.connects, n, 'not hammered: tried again only every 10 minutes');
  m.seen(ID, '192.168.1.42', '3.3'); // its broadcasts go on
  await c.advance(6 * 60 * 1000);
  assert.equal(dev.connects, n + 1);
  assert.equal(m.view(ID).link, 'key');
  m.stop();
});

test('a 3.4 device with another key refuses the session; one that does not answer at all is "offline", not "key"', async () => {
  const c = clock();
  const dev = tuyaDevice({ id: ID, key: KEY, ver: '3.4', wrongKey: true });
  const { m } = manager(new Map([['192.168.1.43', dev]]), c);
  m.set([{ id: ID, key: KEY, ip: '192.168.1.43', ver: '3.4', p: PLUG }, { id: 'bf00test000device02', key: KEY, ip: '192.168.1.99', ver: '3.3', p: PLUG }]);
  m.seen(ID, '192.168.1.43', '3.4');
  await settle();
  await c.advance(20000);
  assert.equal(m.view(ID).link, 'key');
  assert.equal(m.view('bf00test000device02').link, 'offline');
  m.stop();
});

test('a device without an address waits for its broadcast; a new address is followed, one set by hand is kept', async () => {
  const c = clock();
  const dev = tuyaDevice({ id: ID, key: KEY, ver: '3.3', dps: { 1: true } });
  const devs = new Map([['192.168.1.50', dev]]);
  const { m } = manager(devs, c);
  m.set([{ id: ID, key: KEY, p: PLUG }, { id: 'bf00test000device03', key: KEY, ip: '192.168.1.60', p: PLUG }]);
  await settle();
  assert.equal(m.view(ID).link, 'searching');
  m.seen(ID, '192.168.1.50', '3.3');
  await settle();
  assert.deepEqual([m.view(ID).link, m.view(ID).ip], ['ok', '192.168.1.50']);
  devs.set('192.168.1.51', dev);
  m.seen(ID, '192.168.1.51', '3.3');
  await settle();
  assert.deepEqual([m.view(ID).link, m.view(ID).ip], ['ok', '192.168.1.51']);
  m.seen('bf00test000device03', '192.168.1.61', '3.3');
  assert.equal(m.view('bf00test000device03').ip, '192.168.1.60', 'set by hand');
  m.stop();
});

test('a "device22" (3.3, answers DP_QUERY with "data unvalid") is asked with CONTROL_NEW', async () => {
  const c = clock();
  const dev = tuyaDevice({ id: ID, key: KEY, ver: '3.3', dps: { 1: true } });
  const real = dev.connect;
  dev.connect = async () => {
    const s = await real();
    const w = s.write;
    s.write = (chunk) => {
      const f = parse(chunk, null)[0];
      if (f && f.cmd === 10) {
        const kbuf = Buffer.from(KEY, 'latin1');
        const ci = crypto.createCipheriv('aes-128-ecb', kbuf, null);
        const enc = Buffer.concat([ci.update('json obj data unvalid'), ci.final()]);
        setImmediate(() => s.emit('data', require('./fixtures/tuya_device').frame55(1, 10, enc)));
        return true;
      }
      return w(chunk);
    };
    return s;
  };
  const { m } = manager(new Map([['192.168.1.44', dev]]), c);
  m.set([{ id: ID, key: KEY, ip: '192.168.1.44', ver: '3.3', p: PLUG }]);
  await settle();
  const q = dev.received.find((x) => x.cmd === 13);
  assert.ok(q, 'asked with CONTROL_NEW');
  assert.deepEqual(q.json.dps, { 1: null });
  m.stop();
});
