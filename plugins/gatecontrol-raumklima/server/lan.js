'use strict';

// Midea LAN protocol (port of GateControl's src/services/midea/mideaLan.js):
// V2 "5a5a" packets, V3 "8370" framing with the token/key handshake, the UDP
// discovery answer and the TCP transport of one air conditioner.
//
// The plugin has no network of its own. A device in the home network is the
// home target "ac" (assignment `index`, assigned by an administrator): TCP
// goes through gc.net.tcpTarget, a probe through gc.net.udpTarget and the
// search of the local network through gc.net.discover (localDiscovery,
// allowed by an administrator per plugin).

const crypto = require('node:crypto');
const { encryptAesEcb, decryptAesEcb, signMd5, encryptAesCbc, decryptAesCbc, sha256, strxor } = require('./crypto');
const ac = require('./ac');

const TARGET = 'ac';
const DISCOVERY_PORTS = [6445, 20086];

// ---- V2 packet (_Packet, lan.py:686) ----
function buildTimestamp(now = new Date()) {
  // order: [microsecond//10000, second, minute, hour, day, month, year%100, year//100]
  const cs = Math.floor(now.getMilliseconds() * 1000 / 10000); // ms→µs→/10000 ≈ centiseconds
  return Buffer.from([
    cs & 0xff,
    now.getSeconds(), now.getMinutes(), now.getHours(),
    now.getDate(), now.getMonth() + 1,
    now.getFullYear() % 100, Math.floor(now.getFullYear() / 100),
  ]);
}

function encodePacket(deviceId, frame, now = new Date()) {
  const enc = encryptAesEcb(frame);
  const total = 40 + enc.length + 16;
  const header = Buffer.alloc(40);
  header[0] = 0x5a; header[1] = 0x5a;          // start
  header[2] = 0x01; header[3] = 0x11;          // message type
  header.writeUInt16LE(total, 4);              // total length
  header[6] = 0x20; header[7] = 0x00;          // magic
  // [8..11] message id = 0
  buildTimestamp(now).copy(header, 12);        // [12..19] timestamp
  const idBuf = Buffer.alloc(8);
  idBuf.writeBigUInt64LE(BigInt(deviceId));
  idBuf.copy(header, 20);                       // [20..27] device id (8 LE)
  // [28..39] zero padding
  const headPlusEnc = Buffer.concat([header, enc]);
  return Buffer.concat([headPlusEnc, signMd5(headPlusEnc)]);
}

function decodePacket(packet) {
  if (!(packet[0] === 0x5a && packet[1] === 0x5a)) throw new Error('not a 5a5a packet');
  const encrypted = packet.slice(40, -16);
  const expectSign = packet.slice(-16);
  if (!signMd5(packet.slice(0, -16)).equals(expectSign)) throw new Error('packet sign mismatch');
  return decryptAesEcb(encrypted);
}

// ---- V3 8370 framing (_LanProtocolV3, lan.py) ----
const V3_MAGIC = 0x20;
const TYPE_HANDSHAKE_REQ = 0x0;
const TYPE_ENCRYPTED_REQ = 0x6;

function buildV3Header(payloadLenWithSign, pad, type) {
  // 8370 | size(2 big) | 20 | (pad<<4 | type)
  const h = Buffer.alloc(6);
  h[0] = 0x83; h[1] = 0x70;
  h.writeUInt16BE(payloadLenWithSign, 2);     // = len(payload)+pad+32, packet-id NOT counted
  h[4] = V3_MAGIC;
  h[5] = ((pad & 0x0f) << 4) | (type & 0x0f);
  return h;
}

function encodeEncryptedRequest(localKey, data, packetId) {
  const remainder = (data.length + 2) % 16;
  const pad = remainder ? 16 - remainder : 0;
  const size = data.length + pad + 32;
  const header = buildV3Header(size, pad, TYPE_ENCRYPTED_REQ);
  const pidBuf = Buffer.alloc(2); pidBuf.writeUInt16BE(packetId & 0xfff);
  const payload = Buffer.concat([pidBuf, data, crypto.randomBytes(pad)]);
  const enc = encryptAesCbc(localKey, payload);
  const hash = sha256(Buffer.concat([header, payload]));
  return Buffer.concat([header, enc, hash]);
}

function decodeEncryptedResponse(localKey, packet) {
  const header = packet.slice(0, 6);
  const enc = packet.slice(6, -32);
  const rxHash = packet.slice(-32);
  const dec = decryptAesCbc(localKey, enc);
  if (!sha256(Buffer.concat([header, dec])).equals(rxHash)) throw new Error('v3 hash mismatch');
  const pad = header[5] >> 4;
  return dec.slice(2, pad ? -pad : undefined);   // strip 2-byte packet id + padding
}

function encodeHandshakeRequest(token, packetId) {
  const pidBuf = Buffer.alloc(2); pidBuf.writeUInt16BE(packetId & 0xfff);
  const payload = Buffer.concat([pidBuf, token]);
  const header = buildV3Header(payload.length, 0, TYPE_HANDSHAKE_REQ);
  return Buffer.concat([header, payload]);
}

function decodeHandshakeResponse(packet) {
  return packet.slice(8);                         // strip 6-byte header + 2-byte packet id → 64 bytes
}

function getLocalKey(key, handshakeData) {
  const payload = handshakeData.slice(0, 32);
  const rxHash = handshakeData.slice(32);
  const decrypted = decryptAesCbc(key, payload);
  if (!sha256(decrypted).equals(rxHash)) throw new Error('handshake hash mismatch');
  return strxor(decrypted, key);                  // 32-byte session key
}

// ---- Discovery (discover.py) ----

// 72-byte broadcast probe — from const.py DISCOVERY_MSG
const DISCOVERY_MSG = Buffer.from(
  '5a5a011148009200' +
  '0000000000000000000000000000000000000000000000000000000000000000' +
  '7f75bd6b3e4f8b762e849c6e578d6590036e9d4342a50f1f569eb8ec918e92e5',
  'hex',
);

function detectVersion(d) {
  if (d[0] === 0x5a && d[1] === 0x5a) return 2;
  if (d[0] === 0x83 && d[1] === 0x70) return 3;
  return 1; // V1 XML (unsupported for AC)
}

function parseDiscoveryResponse(datagram) {
  const version = detectVersion(datagram);
  let data = datagram;
  if (version === 3) data = data.slice(8, -16); // strip 8370 header + 16-byte hash → inner 5a5a
  // 6-byte LE device id (bytes 20..25):
  let devId = 0n;
  for (let i = 0; i < 6; i++) devId += BigInt(data[20 + i]) << BigInt(8 * i);
  const encrypted = data.slice(40, -16);
  const decrypted = decryptAesEcb(encrypted);
  const ip = `${decrypted[3]}.${decrypted[2]}.${decrypted[1]}.${decrypted[0]}`;
  const port = decrypted.readUInt16LE(4);
  const sn = decrypted.slice(8, 40).toString('ascii');
  const nameLen = decrypted[40];
  const name = decrypted.slice(41, 41 + nameLen).toString('ascii');
  const deviceType = parseInt(name.split('_')[1], 16);
  return { ip, port, deviceId: devId.toString(), sn, deviceType, version };
}

/** Datagrams [{ address, port, data }] → air conditioners found (one per device id). */
function parseAnswers(answers) {
  const found = new Map();
  for (const a of answers || []) {
    try {
      const msg = Buffer.isBuffer(a.data) ? a.data : Buffer.from(a.data || []);
      if (detectVersion(msg) === 1) continue;
      const info = parseDiscoveryResponse(msg);
      if (info.deviceType !== ac.DEVICE_TYPE) continue;
      // the address the answer came from is what the host saw — not what the device claims
      found.set(info.deviceId, { ...info, address: typeof a.address === 'string' ? a.address : info.ip });
    } catch { /* ignore malformed */ }
  }
  return [...found.values()];
}

/** Search the server's local networks (localDiscovery; an administrator must allow it). */
async function discover(gc, { timeoutMs = 3000 } = {}) {
  const answers = await gc.net.discover(DISCOVERY_MSG, { ports: DISCOVERY_PORTS, timeoutMs, repeat: 3 });
  return parseAnswers(answers);
}

/** Ask one assigned "ac" target who it is (unicast discovery); null when it does not answer. */
async function probe(gc, index, { timeoutMs = 2500 } = {}) {
  for (const port of DISCOVERY_PORTS) {
    let answers;
    try { answers = await gc.net.udpTarget(TARGET, DISCOVERY_MSG, { index, port, timeoutMs }); } catch (e) {
      if (e && e.code === 'ERR_NET_DENIED') throw e; // not assigned / not declared: say so
      continue;
    }
    const found = parseAnswers(answers);
    if (found.length) return found[0];
  }
  return null;
}

// ---- TCP transport of one device ----

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`midea ${label} timeout`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

class LanDevice {
  /**
   * @param {object} o
   * @param {(timeoutMs:number) => Promise<object>} o.connect  opens the socket (gc.net.tcpTarget('ac', { index }))
   */
  constructor({ connect, deviceId, protocolVersion = 3, token = null, key = null, timeoutMs = 8000 }) {
    if (typeof connect !== 'function') throw new Error('no transport');
    if (protocolVersion === 3 && (!token || !key)) {
      throw new Error('token and key are required for protocol version 3');
    }
    this.connect = connect;
    this.deviceId = deviceId;
    this.version = protocolVersion;
    this.token = token ? Buffer.from(token, 'hex') : null;
    this.key = key ? Buffer.from(key, 'hex') : null;
    this.timeoutMs = timeoutMs;
    this._packetId = 0;
  }

  _nextPid() { this._packetId = (this._packetId + 1) & 0xfff; return this._packetId; }

  // One reader per socket: buffers what arrives and hands out complete
  // 8370 / 5a5a messages (the host forwards TCP data in arbitrary chunks).
  _reader(sock) {
    let buf = Buffer.alloc(0);
    let waiter = null;
    let failed = null;
    const need = (b) => {
      if (b.length < 6) return Infinity;
      if (b[0] === 0x83 && b[1] === 0x70) return b.readUInt16BE(2) + 8;   // 8370
      if (b[0] === 0x5a && b[1] === 0x5a) return b.readUInt16LE(4);       // 5a5a
      return b.length;
    };
    const pump = () => {
      if (!waiter) return;
      if (failed) { const w = waiter; waiter = null; w.reject(failed); return; }
      const n = need(buf);
      if (buf.length >= n) {
        const msg = buf.slice(0, n);
        buf = buf.slice(n);
        const w = waiter; waiter = null; w.resolve(msg);
      }
    };
    sock.on('data', (d) => { buf = Buffer.concat([buf, d]); pump(); });
    sock.on('error', (e) => { failed = failed || e; pump(); });
    sock.on('close', () => { failed = failed || new Error('midea connection closed'); pump(); });
    return {
      next: () => withTimeout(new Promise((resolve, reject) => { waiter = { resolve, reject }; pump(); }), this.timeoutMs, 'read'),
    };
  }

  async _send(sock, reader, payload) {
    await sock.write(payload);
    return reader.next();
  }

  async _authenticate(sock, reader) {
    const req = encodeHandshakeRequest(this.token, this._nextPid());
    const resp = await this._send(sock, reader, req);
    const data = decodeHandshakeResponse(resp);
    return getLocalKey(this.key, data);          // localKey
  }

  // Sends a 0xAA frame, returns parsed AcState.
  async _command(frame) {
    const sock = await withTimeout(Promise.resolve(this.connect(this.timeoutMs)), this.timeoutMs, 'connect');
    const reader = this._reader(sock);
    try {
      let localKey = null;
      if (this.version === 3) localKey = await this._authenticate(sock, reader);
      const v2 = encodePacket(Number(this.deviceId) || 0, frame);
      let reply;
      if (this.version === 3) {
        const req = encodeEncryptedRequest(localKey, v2, this._nextPid());
        const raw = await this._send(sock, reader, req);
        const innerV2 = decodeEncryptedResponse(localKey, raw);
        reply = decodePacket(innerV2);
      } else {
        const raw = await this._send(sock, reader, v2);
        reply = decodePacket(raw);
      }
      return ac.parseState(reply);
    } finally {
      try { await sock.destroy(); } catch { /* best-effort socket cleanup; the result/error above is what matters */ }
    }
  }

  async getState() {
    return this._command(ac.buildQuery({ messageId: this._nextPid() & 0xff }));
  }

  async setState(patch) {
    const current = await this.getState();        // read
    const merged = { ...current, ...patch };       // modify
    await this._command(ac.buildSet(merged, { messageId: this._nextPid() & 0xff })); // write
    return this.getState();                        // confirm
  }
}

module.exports = {
  TARGET, DISCOVERY_PORTS, DISCOVERY_MSG,
  buildTimestamp, encodePacket, decodePacket,
  encodeEncryptedRequest, decodeEncryptedResponse, encodeHandshakeRequest, decodeHandshakeResponse, getLocalKey,
  detectVersion, parseDiscoveryResponse, parseAnswers, discover, probe,
  LanDevice,
};
