'use strict';

// A Tuya device as the tests need it (protocols 3.1, 3.3, 3.4, 3.5), written from the protocol description with
// node:crypto alone — on purpose without edge/tuya.js, so the plugin's frames are checked by a second implementation.
// Keys, ids and addresses are made up here; no real device data.
//
//   const dev = tuyaDevice({ id, key, ver, dps, wrongKey? })   a device with datapoints
//   dev.connect() → a socket like gc.lan.tcp.connect gives (EventEmitter + write / destroy / end)
//   dev.dps, dev.received (the decoded commands: [{ cmd, json }]), dev.push(dps) (a change at the device itself)
//   broadcast(ver, { id, ip, version }) → the UDP datagram such a device sends (6666 / 6667 / 7000)

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const UDP_KEY = crypto.createHash('md5').update('yGAdlopoPVldABfn').digest();

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

const be = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const ecb = (key, data) => { const c = crypto.createCipheriv('aes-128-ecb', key, null); return Buffer.concat([c.update(data), c.final()]); };
const unecb = (key, data) => { const d = crypto.createDecipheriv('aes-128-ecb', key, null); return Buffer.concat([d.update(data), d.final()]); };
const mac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** A 55AA frame from the device: retcode, payload, CRC or HMAC. */
function frame55(seq, cmd, payload, hmacKey) {
  const body = Buffer.concat([be(0), payload]);
  const head = Buffer.concat([be(0x55aa), be(seq), be(cmd), be(body.length + (hmacKey ? 36 : 8))]);
  const data = Buffer.concat([head, body]);
  return Buffer.concat([data, hmacKey ? mac(hmacKey, data) : be(crc32(data)), be(0xaa55)]);
}

/** A 6699 frame from the device: GCM over retcode + payload, the header without the prefix as additional data. */
function frame66(seq, cmd, payload, key, withRetcode = true) {
  const plain = withRetcode ? Buffer.concat([be(0), payload]) : payload;
  const head = Buffer.alloc(18);
  head.writeUInt32BE(0x6699, 0);
  head.writeUInt32BE(seq, 6);
  head.writeUInt32BE(cmd, 10);
  head.writeUInt32BE(12 + plain.length + 16, 14);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-128-gcm', key, iv);
  c.setAAD(head.subarray(4));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([head, iv, ct, c.getAuthTag(), be(0x9966)]);
}

/** Frames from the plugin: { seq, cmd, payload (55AA: as sent; 6699: decrypted), ok }. */
function parse(buf, key) {
  const out = [];
  let i = 0;
  while (i + 16 <= buf.length) {
    const p = buf.readUInt32BE(i);
    if (p === 0x55aa) {
      const len = buf.readUInt32BE(i + 12);
      const f = buf.subarray(i, i + 16 + len);
      const endLen = key ? 36 : 8;
      const data = f.subarray(0, f.length - endLen);
      const check = f.subarray(f.length - endLen, f.length - 4);
      const ok = key ? mac(key, data).equals(check) : crc32(data) === check.readUInt32BE(0);
      out.push({ seq: f.readUInt32BE(4), cmd: f.readUInt32BE(8), payload: f.subarray(16, f.length - endLen), ok, suffix: f.readUInt32BE(f.length - 4) });
      i += 16 + len;
    } else if (p === 0x6699) {
      const len = buf.readUInt32BE(i + 14);
      const f = buf.subarray(i, i + 18 + len + 4);
      let payload = Buffer.alloc(0);
      let ok = false;
      try {
        const d = crypto.createDecipheriv('aes-128-gcm', key, f.subarray(18, 30));
        d.setAAD(f.subarray(4, 18));
        d.setAuthTag(f.subarray(18 + len - 16, 18 + len));
        payload = Buffer.concat([d.update(f.subarray(30, 18 + len - 16)), d.final()]);
        ok = true;
      } catch { ok = false; }
      out.push({ seq: f.readUInt32BE(6), cmd: f.readUInt32BE(10), payload, ok, suffix: f.readUInt32BE(f.length - 4) });
      i += 18 + len + 4;
    } else i++;
  }
  return out;
}

const vhead = (ver) => Buffer.concat([Buffer.from(ver), Buffer.alloc(12)]);

function tuyaDevice({ id, key, ver = '3.3', dps = {}, wrongKey = false, closeOnQuery = false }) {
  const own = Buffer.from(wrongKey ? 'zzzzzzzzzzzzzzzz' : key, 'latin1');
  const dev = { id, ver, dps: { ...dps }, received: [], sockets: [], connects: 0 };
  dev.connect = () => {
    dev.connects++;
    const s = new EventEmitter();
    const st = { session: null, local: null, remote: crypto.randomBytes(16), seq: 100, buf: Buffer.alloc(0), closed: false };
    const send = (b) => setImmediate(() => { if (!st.closed) s.emit('data', b); });
    const k = () => st.session || own;
    const status = (cmd, json) => {
      const body = Buffer.from(JSON.stringify(json));
      if (ver === '3.5') return frame66(++st.seq, cmd, cmd === 8 ? Buffer.concat([vhead(ver), body]) : body, k());
      if (ver === '3.4') return frame55(++st.seq, cmd, ecb(k(), cmd === 8 ? Buffer.concat([vhead(ver), body]) : body), k());
      if (ver === '3.1') return frame55(++st.seq, cmd, body);
      const enc = ecb(own, body);
      return frame55(++st.seq, cmd, cmd === 8 ? Buffer.concat([vhead(ver), enc]) : enc);
    };
    const statusJson = (d) => (ver === '3.4' || ver === '3.5' ? { protocol: 4, t: 1, data: { dps: d } } : { devId: id, dps: d, t: 1 });
    s.write = (chunk) => {
      st.buf = Buffer.concat([st.buf, chunk]);
      const v = Number(ver.split('.')[1]);
      const frames = parse(st.buf, v >= 4 ? k() : null);
      st.buf = Buffer.alloc(0);
      for (const f of frames) {
        if (!f.ok) { s.destroy(); return true; }
        let p = f.payload;
        if (f.cmd === 3) { // session start
          st.local = v === 5 ? p : unecb(own, p);
          const ans = Buffer.concat([st.remote, mac(own, st.local)]);
          send(v === 5 ? frame66(++st.seq, 4, ans, own) : frame55(++st.seq, 4, ecb(own, ans), own));
          continue;
        }
        if (f.cmd === 5) {
          const fin = v === 5 ? p : unecb(own, p);
          if (!fin.equals(mac(own, st.remote))) { s.destroy(); return true; }
          const x = Buffer.from(st.local.map((b, i) => b ^ st.remote[i]));
          if (v === 5) {
            const c = crypto.createCipheriv('aes-128-gcm', own, st.local.subarray(0, 12));
            st.session = Buffer.concat([c.update(x), c.final()]);
          } else {
            const c = crypto.createCipheriv('aes-128-ecb', own, null);
            c.setAutoPadding(false);
            st.session = Buffer.concat([c.update(x), c.final()]);
          }
          continue;
        }
        // the payload as JSON
        let text;
        try {
          if (v === 4) p = unecb(k(), p);
          if (v >= 2 && p.subarray(0, 3).toString() === ver) p = p.subarray(15);
          if (v === 2 || v === 3) p = unecb(own, p);
          if (v === 1 && p.subarray(0, 3).toString() === '3.1') p = unecb(own, Buffer.from(p.subarray(19).toString(), 'base64'));
          text = p.toString();
        } catch {
          // a payload this device cannot read: real devices hang up
          s.destroy();
          return true;
        }
        const json = text ? JSON.parse(text) : null;
        dev.received.push({ cmd: f.cmd, json, raw: f });
        if (f.cmd === 9) { send(status(9, {})); continue; }
        if (closeOnQuery && (f.cmd === 10 || f.cmd === 16)) { s.destroy(); return true; }
        if (f.cmd === 10 || f.cmd === 16) { send(status(f.cmd, statusJson(dev.dps))); continue; }
        if (f.cmd === 7 || f.cmd === 13) {
          const d = (json && (json.dps || (json.data && json.data.dps))) || {};
          Object.assign(dev.dps, d);
          send(status(f.cmd, {}));
          send(status(8, statusJson(d)));
        }
      }
      return true;
    };
    s.destroy = () => { if (st.closed) return; st.closed = true; setImmediate(() => s.emit('close')); };
    s.end = s.destroy;
    dev.sockets.push({ s, st, push: (d) => { Object.assign(dev.dps, d); send(status(8, statusJson(d))); } });
    return Promise.resolve(s);
  };
  dev.push = (d) => { for (const x of dev.sockets) if (!x.st.closed) x.push(d); };
  dev.close = () => { for (const x of dev.sockets) x.s.destroy(); };
  return dev;
}

/** The UDP datagram a device of `ver` sends: 3.1 clear (6666), 3.2–3.4 AES-ECB with the discovery key (6667), 3.5 GCM (7000). */
function broadcast(ver, info) {
  const body = Buffer.from(JSON.stringify({ ip: info.ip, gwId: info.id, active: 2, ability: 0, mode: 0, encrypt: true, productKey: 'keyabcdefghijklm', version: ver }));
  if (ver === '3.5') return frame66(0, 0x13, body, UDP_KEY, false);
  if (ver === '3.1') return frame55(0, 0x13, body);
  return frame55(0, 0x13, ecb(UDP_KEY, body));
}

module.exports = { tuyaDevice, broadcast, parse, crc32, UDP_KEY, frame55, frame66 };
