/* Drive (gatecontrol-drive) — the end-to-end encryption of vault folders (since 1.9.0): window.DriveVaultCrypto.
 *
 * The format every client builds (README.md "Tresor-Ordner – Kryptografie"; Android and Windows follow it bit for bit,
 * test/vault-vectors.json holds fixed vectors). WebCrypto only — nothing but crypto.subtle and crypto.getRandomValues:
 *
 *   device key     X25519, made here with a private key that cannot be exported (kept by GateControl's page: GC.keys)
 *   device id      base64url(SHA-256("gcdrive-v1:device:" ‖ public key)[0..16])
 *   safety number  SHA-256("gcdrive-v1:fingerprint:" ‖ public key) → 4 big-endian uint32, each mod 100000, 5 digits
 *   vault key TK   32 random bytes per vault and key version
 *   wrap           0x01 ‖ HPKE base mode (RFC 9180: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM) of TK to a
 *                  device's public key: enc (32) ‖ ciphertext (48); info "gcdrive-v1:tk:<vaultId>:<keyVersion>", aad empty
 *   name           0x01 ‖ keyVersion (uint32 BE) ‖ nonce (12) ‖ AES-256-GCM(nameKey, name padded, aad = the first 5 bytes)
 *                  nameKey = HKDF-SHA256(TK, salt empty, info "gcdrive-v1:name:<vaultId>"); padding: UTF-8 (NFC),
 *                  0x80, zeros to a multiple of 32
 *   content        header "GCDV" ‖ 0x01 ‖ keyVersion (uint32 BE) ‖ chunkSize (uint32 BE) ‖ salt (16) — 29 bytes, then
 *                  chunks of chunkSize plaintext bytes (the last shorter, an empty file one empty chunk), each
 *                  AES-256-GCM(fileKey, nonce 0^8 ‖ index (uint32 BE), aad = header ‖ index (uint32 BE) ‖ last (0x01|0x00));
 *                  fileKey = HKDF-SHA256(TK, salt, info "gcdrive-v1:content:<vaultId>")
 *   recovery key   32 random bytes, shown as Crockford base32 of key ‖ BLAKE2b-256(key)[0..3] — 56 characters, 14 groups of
 *                  4 (the format of the Vault plugin); its X25519 key: HKDF-SHA256(key, salt empty, info
 *                  "gcdrive-v1:recovery") as the private scalar — the vault keys are wrapped for its public key like for a device;
 *                  its proof HKDF-SHA256(key, salt empty, info "gcdrive-v1:recovery-auth") — the server keeps its SHA-256
 *
 * Errors: an Error with `code` 'decrypt' (wrong key, tampered, another vault), 'invalid', 'recovery_key', 'unsupported'
 * (the browser has no X25519).
 */
(function (root) {
  'use strict';

  var C = root.crypto;
  var S = C && C.subtle;
  var enc = new TextEncoder();
  var dec = new TextDecoder('utf-8', { fatal: true });
  var CHUNK = 1048576;
  var HEADER = 29;
  var TAG = 16;
  var MAGIC = [0x47, 0x43, 0x44, 0x56]; // "GCDV"
  var WRAP_BYTES = 81;

  function err(code, message) { var e = new Error(message || code); e.code = code; return e; }

  // ── bytes ──────────────────────────────────────────────

  function u8(v) { return v instanceof Uint8Array ? v : new Uint8Array(v); }
  function concat() {
    var n = 0, i;
    for (i = 0; i < arguments.length; i++) n += arguments[i].length;
    var out = new Uint8Array(n), o = 0;
    for (i = 0; i < arguments.length; i++) { out.set(arguments[i], o); o += arguments[i].length; }
    return out;
  }
  function u32(n) { var b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, false); return b; }
  function readU32(b, o) { return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(o, false); }
  function random(n) { var b = new Uint8Array(n); C.getRandomValues(b); return b; }
  function utf8(s) { return enc.encode(String(s)); }
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  function b64u(bytes) {
    var b = u8(bytes), s = '', i;
    for (i = 0; i + 2 < b.length; i += 3) {
      var n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
      s += B64[n >> 18 & 63] + B64[n >> 12 & 63] + B64[n >> 6 & 63] + B64[n & 63];
    }
    if (b.length - i === 1) { var x = b[i] << 16; s += B64[x >> 18 & 63] + B64[x >> 12 & 63]; }
    else if (b.length - i === 2) { var y = (b[i] << 16) | (b[i + 1] << 8); s += B64[y >> 18 & 63] + B64[y >> 12 & 63] + B64[y >> 6 & 63]; }
    return s;
  }
  function unb64u(s) {
    s = String(s);
    if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw err('invalid', 'not base64url');
    var out = new Uint8Array(Math.floor(s.length * 3 / 4)), bits = 0, val = 0, o = 0;
    for (var i = 0; i < s.length; i++) {
      val = (val << 6) | B64.indexOf(s[i]);
      bits += 6;
      if (bits >= 8) { bits -= 8; out[o++] = (val >> bits) & 255; }
    }
    return out.subarray(0, o);
  }
  function hex(b) { return Array.prototype.map.call(u8(b), function (x) { return (x < 16 ? '0' : '') + x.toString(16); }).join(''); }
  function unhex(s) { var b = new Uint8Array(s.length / 2); for (var i = 0; i < b.length; i++) b[i] = parseInt(s.substr(i * 2, 2), 16); return b; }
  function wipe(b) { if (b && b.fill) b.fill(0); }

  // ── primitives (WebCrypto) ─────────────────────────────

  function sha256(data) { return S.digest('SHA-256', data).then(u8); }
  function hmac(key, data) {
    // HKDF with an empty salt = a salt of 32 zero bytes (HMAC pads the key); WebCrypto takes no empty HMAC key
    var k = key.length ? key : new Uint8Array(32);
    return S.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']).then(function (ck) { return S.sign('HMAC', ck, data); }).then(u8);
  }
  function hkdfExtract(salt, ikm) { return hmac(salt, ikm); }
  /** HKDF-Expand for L ≤ 32 (one block is all HPKE and this format need). */
  function hkdfExpand(prk, info, L) {
    if (L > 32) throw err('invalid', 'L');
    return hmac(prk, concat(info, new Uint8Array([1]))).then(function (t) { return t.slice(0, L); });
  }
  function hkdfBytes(ikm, salt, info, L) {
    return hkdfExtract(salt, ikm).then(function (prk) { return hkdfExpand(prk, info, L); });
  }
  function aesKey(raw, usages) { return S.importKey('raw', raw, { name: 'AES-GCM' }, false, usages || ['encrypt', 'decrypt']); }
  function seal(key, nonce, aad, pt) { return S.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 }, key, pt).then(u8); }
  function open(key, nonce, aad, ct) {
    return S.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 }, key, ct).then(u8, function () { throw err('decrypt'); });
  }
  /** An AES-256-GCM key: HKDF-SHA256(TK, salt, info). */
  function derivedKey(tk, salt, info) { return hkdfBytes(u8(tk), salt, utf8(info), 32).then(function (k) { var p = aesKey(k); wipe(k); return p; }); }

  // ── X25519 ─────────────────────────────────────────────

  var X = { name: 'X25519' };
  var PKCS8_X25519 = unhex('302e020100300506032b656e04220420');
  var BASEPOINT = (function () { var b = new Uint8Array(32); b[0] = 9; return b; }());

  function supported() {
    if (!S) return Promise.resolve(false);
    return S.generateKey(X, false, ['deriveBits']).then(function () { return true; }, function () { return false; });
  }
  /** A new device key: { publicKey, privateKey } — the private one cannot be exported. */
  function generateDeviceKey() {
    return S.generateKey(X, false, ['deriveBits']).catch(function () { throw err('unsupported', 'no X25519 in this browser'); });
  }
  function exportPublic(pub) { return S.exportKey('raw', pub).then(u8); }
  function importPublic(raw) { return S.importKey('raw', u8(raw), X, true, []); }
  function dh(priv, pubRaw) {
    return importPublic(pubRaw).then(function (pub) { return S.deriveBits({ name: 'X25519', public: pub }, priv, 256); }).then(u8);
  }
  /** An X25519 private key from 32 bytes (the recovery key's) → { privateKey, publicRaw }. */
  function keyFromSeed(seed) {
    return S.importKey('pkcs8', concat(PKCS8_X25519, u8(seed)), X, false, ['deriveBits']).then(function (priv) {
      return dh(priv, BASEPOINT).then(function (pubRaw) { return { privateKey: priv, publicRaw: pubRaw }; });
    });
  }

  // ── device id, safety number ───────────────────────────

  function deviceId(pubRaw) { return sha256(concat(utf8('gcdrive-v1:device:'), u8(pubRaw))).then(function (h) { return b64u(h.subarray(0, 16)); }); }
  function safetyNumber(pubRaw) {
    return sha256(concat(utf8('gcdrive-v1:fingerprint:'), u8(pubRaw))).then(function (h) {
      var out = [];
      for (var i = 0; i < 4; i++) out.push(String(readU32(h, i * 4) % 100000).padStart(5, '0'));
      return out.join(' ');
    });
  }

  // ── HPKE (RFC 9180, mode base) ─────────────────────────

  var HPKE_V1 = utf8('HPKE-v1');
  function suites(aeadId) {
    return { kem: concat(utf8('KEM'), new Uint8Array([0, 0x20])), hpke: concat(utf8('HPKE'), new Uint8Array([0, 0x20, 0, 1, 0, aeadId])) };
  }
  function labeledExtract(suite, salt, label, ikm) { return hkdfExtract(salt, concat(HPKE_V1, suite, utf8(label), ikm)); }
  function labeledExpand(suite, prk, label, info, L) {
    return hkdfExpand(prk, concat(new Uint8Array([L >> 8, L & 255]), HPKE_V1, suite, utf8(label), info), L);
  }
  function extractAndExpand(su, dhBytes, kemContext) {
    return labeledExtract(su.kem, new Uint8Array(0), 'eae_prk', dhBytes).then(function (prk) { return labeledExpand(su.kem, prk, 'shared_secret', kemContext, 32); });
  }
  function keySchedule(su, shared, info, nk) {
    var empty = new Uint8Array(0);
    return Promise.all([labeledExtract(su.hpke, empty, 'psk_id_hash', empty), labeledExtract(su.hpke, empty, 'info_hash', info)]).then(function (h) {
      var ctx = concat(new Uint8Array([0]), h[0], h[1]);
      return labeledExtract(su.hpke, shared, 'secret', empty).then(function (secret) {
        return Promise.all([labeledExpand(su.hpke, secret, 'key', ctx, nk), labeledExpand(su.hpke, secret, 'base_nonce', ctx, 12)]);
      });
    }).then(function (kn) { return { key: kn[0], nonce: kn[1] }; });
  }
  /**
   * HPKE single-shot seal → enc ‖ ct. o.aeadId 2 (AES-256-GCM, Nk 32) by default; o.ephemeral { privateKey, publicRaw }
   * only for the RFC's test vectors.
   */
  function hpkeSeal(pkR, info, aad, pt, o) {
    var opt = o || {};
    var aeadId = opt.aeadId || 2;
    var su = suites(aeadId);
    var eph = opt.ephemeral ? Promise.resolve(opt.ephemeral) : S.generateKey(X, true, ['deriveBits']).then(function (kp) {
      return exportPublic(kp.publicKey).then(function (raw) { return { privateKey: kp.privateKey, publicRaw: raw }; });
    });
    return eph.then(function (e) {
      return dh(e.privateKey, pkR).then(function (d) {
        return extractAndExpand(su, d, concat(e.publicRaw, u8(pkR)));
      }).then(function (shared) { return keySchedule(su, shared, info, aeadId === 1 ? 16 : 32); }).then(function (ks) {
        return aesKey(ks.key, ['encrypt']).then(function (k) { return seal(k, ks.nonce, aad, pt); });
      }).then(function (ct) { return concat(e.publicRaw, ct); });
    });
  }
  /** HPKE single-shot open of enc ‖ ct with the recipient's private key (and its public key, pkR). */
  function hpkeOpen(skR, pkR, info, aad, data, o) {
    var aeadId = (o && o.aeadId) || 2;
    var su = suites(aeadId);
    var encap = data.subarray(0, 32);
    return dh(skR, encap).then(function (d) { return extractAndExpand(su, d, concat(encap, u8(pkR))); })
      .then(function (shared) { return keySchedule(su, shared, info, aeadId === 1 ? 16 : 32); })
      .then(function (ks) { return aesKey(ks.key, ['decrypt']).then(function (k) { return open(k, ks.nonce, aad, data.subarray(32)); }); });
  }

  // ── the vault key ──────────────────────────────────────

  function newVaultKey() { return random(32); }
  function newVaultId() { return b64u(random(16)); }
  function wrapInfo(vaultId, keyVersion) { return utf8('gcdrive-v1:tk:' + vaultId + ':' + keyVersion); }
  /** TK → the wrap for public key `pubRaw` (base64url, 108 characters). */
  function wrapKey(tk, pubRaw, vaultId, keyVersion, o) {
    return hpkeSeal(u8(pubRaw), wrapInfo(vaultId, keyVersion), new Uint8Array(0), u8(tk), o).then(function (sealed) { return b64u(concat(new Uint8Array([1]), sealed)); });
  }
  /** A wrap → TK, with the device's (or the recovery key's) private key and its public key. */
  function unwrapKey(wrap, privateKey, pubRaw, vaultId, keyVersion) {
    var b;
    try { b = unb64u(wrap); } catch (e) { return Promise.reject(err('invalid', 'wrap')); }
    if (b.length !== WRAP_BYTES || b[0] !== 1) return Promise.reject(err('invalid', 'wrap'));
    return hpkeOpen(privateKey, u8(pubRaw), wrapInfo(vaultId, keyVersion), new Uint8Array(0), b.subarray(1)).then(function (tk) {
      if (tk.length !== 32) throw err('decrypt');
      return tk;
    });
  }

  // ── names ──────────────────────────────────────────────

  function pad(bytes) {
    var n = Math.ceil((bytes.length + 1) / 32) * 32;
    var out = new Uint8Array(n);
    out.set(bytes);
    out[bytes.length] = 0x80;
    return out;
  }
  function unpad(b) {
    var i = b.length - 1;
    while (i >= 0 && b[i] === 0) i--;
    if (i < 0 || b[i] !== 0x80) throw err('decrypt');
    return b.subarray(0, i);
  }
  function nameKey(tk, vaultId) { return derivedKey(tk, new Uint8Array(0), 'gcdrive-v1:name:' + vaultId); }
  /** A name → nameCipher (base64url). o.nonce only for test vectors. */
  function encryptName(tk, vaultId, keyVersion, name, o) {
    var head = concat(new Uint8Array([1]), u32(keyVersion));
    var nonce = (o && o.nonce) ? u8(o.nonce) : random(12);
    return nameKey(tk, vaultId).then(function (k) { return seal(k, nonce, head, pad(utf8(String(name).normalize('NFC')))); })
      .then(function (ct) { return b64u(concat(head, nonce, ct)); });
  }
  /** The key version of a nameCipher. */
  function nameVersion(cipher) { var b = unb64u(cipher); if (b.length < 65 || b[0] !== 1) throw err('invalid', 'name'); return readU32(b, 1); }
  /** nameCipher → the name; keys: keyVersion → TK (a Map, an object or a function). */
  function decryptName(keys, vaultId, cipher) {
    var b;
    try { b = unb64u(cipher); } catch (e) { return Promise.reject(err('invalid', 'name')); }
    if (b.length < 65 || b[0] !== 1 || (b.length - 33) % 32 !== 0) return Promise.reject(err('invalid', 'name'));
    var tk = keyOf(keys, readU32(b, 1));
    if (!tk) return Promise.reject(err('decrypt', 'no key for this version'));
    return nameKey(tk, vaultId).then(function (k) { return open(k, b.subarray(5, 17), b.subarray(0, 5), b.subarray(17)); })
      .then(function (p) { return dec.decode(unpad(p)); });
  }
  function keyOf(keys, v) {
    if (!keys) return null;
    if (typeof keys === 'function') return keys(v);
    if (typeof keys.get === 'function') return keys.get(v);
    return keys[v] || null;
  }

  // ── content ────────────────────────────────────────────

  function header(keyVersion, chunkSize, salt) { return concat(new Uint8Array(MAGIC), new Uint8Array([1]), u32(keyVersion), u32(chunkSize), salt); }
  function chunkNonce(i) { return concat(new Uint8Array(8), u32(i)); }
  function chunkAad(head, i, last) { return concat(head, u32(i), new Uint8Array([last ? 1 : 0])); }
  function fileKey(tk, vaultId, salt) { return derivedKey(tk, salt, 'gcdrive-v1:content:' + vaultId); }
  /** Size of the ciphertext of `size` plaintext bytes. */
  function cipherSize(size, chunkSize) {
    var cs = chunkSize || CHUNK;
    return HEADER + size + TAG * Math.max(1, Math.ceil(size / cs));
  }

  /**
   * Encrypt a Blob / File / Uint8Array → [Uint8Array parts] (header, then each sealed chunk). o: { chunkSize, salt
   * (test vectors), onProgress(done, total) }.
   */
  function encryptContent(tk, vaultId, keyVersion, data, o) {
    var opt = o || {};
    var cs = opt.chunkSize || CHUNK;
    var size = data.size != null ? data.size : data.length;
    var salt = opt.salt ? u8(opt.salt) : random(16);
    var head = header(keyVersion, cs, salt);
    var n = Math.max(1, Math.ceil(size / cs));
    var parts = [head];
    var read = function (a, b) {
      if (data instanceof Uint8Array) return Promise.resolve(data.subarray(a, b));
      return data.slice(a, b).arrayBuffer().then(u8);
    };
    return fileKey(tk, vaultId, salt).then(function (key) {
      var i = 0;
      function next() {
        if (i >= n) return parts;
        var a = i * cs, b = Math.min(size, a + cs), idx = i;
        return read(a, b).then(function (pt) { return seal(key, chunkNonce(idx), chunkAad(head, idx, idx === n - 1), pt); }).then(function (ct) {
          parts.push(ct);
          i++;
          if (opt.onProgress) { try { opt.onProgress(Math.min(size, i * cs), size); } catch (e) { /* the caller's */ } }
          return next();
        });
      }
      return next();
    });
  }

  /** The header of a content's first bytes → { keyVersion, chunkSize, salt, head }. */
  function parseHeader(b) {
    if (b.length < HEADER || b[0] !== MAGIC[0] || b[1] !== MAGIC[1] || b[2] !== MAGIC[2] || b[3] !== MAGIC[3] || b[4] !== 1) throw err('invalid', 'not a vault file');
    var cs = readU32(b, 9);
    if (cs < 1024 || cs > 16777216) throw err('invalid', 'chunk size');
    return { keyVersion: readU32(b, 5), chunkSize: cs, salt: b.slice(13, 29), head: b.slice(0, HEADER) };
  }

  /**
   * Decrypt a content of `total` bytes, read with read(start, end) → Promise<Uint8Array> (end inclusive) in windows of
   * at most `o.window` bytes (default 8 MiB + tags) → [Uint8Array plaintext parts]. keys: keyVersion → TK.
   */
  function decryptContent(keys, vaultId, read, total, o) {
    var opt = o || {};
    if (total < HEADER + TAG) return Promise.reject(err('invalid', 'too short'));
    return Promise.resolve(read(0, HEADER - 1)).then(function (hb) {
      var h = parseHeader(u8(hb));
      var tk = keyOf(keys, h.keyVersion);
      if (!tk) throw err('decrypt', 'no key for this version');
      var step = h.chunkSize + TAG;
      var n = Math.ceil((total - HEADER) / step);
      var lastLen = total - HEADER - (n - 1) * step;
      if (n < 1 || lastLen < TAG || lastLen > step) throw err('invalid', 'size');
      var per = Math.max(1, Math.floor((opt.window || (8 * 1048576 + 8 * TAG)) / step));
      var out = [];
      return fileKey(tk, vaultId, h.salt).then(function (key) {
        var i = 0;
        function next() {
          if (i >= n) return out;
          var count = Math.min(per, n - i);
          var a = HEADER + i * step;
          var b = Math.min(total, a + count * step) - 1;
          return Promise.resolve(read(a, b)).then(function (buf) {
            buf = u8(buf);
            if (buf.length !== b - a + 1) throw err('invalid', 'short read');
            var p = Promise.resolve();
            for (var k = 0; k < count; k++) {
              (function (idx, off) {
                var len = idx === n - 1 ? lastLen : step;
                p = p.then(function () { return open(key, chunkNonce(idx), chunkAad(h.head, idx, idx === n - 1), buf.subarray(off, off + len)); })
                  .then(function (pt) { out.push(pt); });
              }(i + k, k * step));
            }
            return p.then(function () {
              i += count;
              if (opt.onProgress) { try { opt.onProgress(Math.min(total, HEADER + i * step), total); } catch (e) { /* the caller's */ } }
              return next();
            });
          });
        }
        return next();
      });
    });
  }

  // ── recovery key ───────────────────────────────────────

  // BLAKE2b-256 (RFC 7693, unkeyed, 32-byte output) — for the 3 check bytes only
  var IV = ['6a09e667f3bcc908', 'bb67ae8584caa73b', '3c6ef372fe94f82b', 'a54ff53a5f1d36f1', '510e527fade682d1', '9b05688c2b3e6c1f', '1f83d9abfb41bd6b', '5be0cd19137e2179'];
  var SIGMA = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
    [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4], [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
    [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13], [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
    [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11], [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
    [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5], [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
  ];
  function blake2b256(input) {
    var M64 = (BigInt(1) << BigInt(64)) - BigInt(1);
    var rotr = function (x, n) { return ((x >> BigInt(n)) | (x << BigInt(64 - n))) & M64; };
    var h = IV.map(function (x) { return BigInt('0x' + x); });
    h[0] ^= BigInt(0x01010000 ^ 32);
    var data = u8(input);
    var blocks = Math.max(1, Math.ceil(data.length / 128));
    for (var bi = 0; bi < blocks; bi++) {
      var block = new Uint8Array(128);
      block.set(data.subarray(bi * 128, bi * 128 + 128));
      var m = [];
      for (var w = 0; w < 16; w++) {
        var x = BigInt(0);
        for (var j = 7; j >= 0; j--) x = (x << BigInt(8)) | BigInt(block[w * 8 + j]);
        m.push(x);
      }
      var last = bi === blocks - 1;
      var t = BigInt(Math.min(data.length, (bi + 1) * 128));
      var v = h.concat(IV.map(function (y) { return BigInt('0x' + y); }));
      v[12] ^= t & M64;
      if (last) v[14] ^= M64;
      var G = function (a, b, c, d, x1, y1) {
        v[a] = (v[a] + v[b] + x1) & M64; v[d] = rotr(v[d] ^ v[a], 32);
        v[c] = (v[c] + v[d]) & M64; v[b] = rotr(v[b] ^ v[c], 24);
        v[a] = (v[a] + v[b] + y1) & M64; v[d] = rotr(v[d] ^ v[a], 16);
        v[c] = (v[c] + v[d]) & M64; v[b] = rotr(v[b] ^ v[c], 63);
      };
      for (var r = 0; r < 12; r++) {
        var s = SIGMA[r % 10];
        G(0, 4, 8, 12, m[s[0]], m[s[1]]); G(1, 5, 9, 13, m[s[2]], m[s[3]]); G(2, 6, 10, 14, m[s[4]], m[s[5]]); G(3, 7, 11, 15, m[s[6]], m[s[7]]);
        G(0, 5, 10, 15, m[s[8]], m[s[9]]); G(1, 6, 11, 12, m[s[10]], m[s[11]]); G(2, 7, 8, 13, m[s[12]], m[s[13]]); G(3, 4, 9, 14, m[s[14]], m[s[15]]);
      }
      for (var k = 0; k < 8; k++) h[k] ^= v[k] ^ v[k + 8];
    }
    var out = new Uint8Array(32);
    for (var q = 0; q < 4; q++) for (var z = 0; z < 8; z++) out[q * 8 + z] = Number((h[q] >> BigInt(8 * z)) & BigInt(255));
    return out;
  }

  var CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  function base32(b) {
    var out = '', bits = 0, val = 0;
    for (var i = 0; i < b.length; i++) {
      val = (val << 8) | b[i]; bits += 8;
      while (bits >= 5) { bits -= 5; out += CROCKFORD[(val >> bits) & 31]; }
      val &= (1 << bits) - 1;
    }
    if (bits > 0) out += CROCKFORD[(val << (5 - bits)) & 31];
    return out;
  }
  /** 32 bytes → "R30W-5GY4-…" (56 characters, 14 groups of 4). */
  function formatRecoveryKey(key) {
    var s = base32(concat(u8(key), blake2b256(key).subarray(0, 3)));
    return s.match(/.{4}/g).join('-');
  }
  /** The typed text → the 32 bytes (lower case, spaces and dashes fine; O → 0, I / L → 1); a wrong check → 'recovery_key'. */
  function parseRecoveryKey(text) {
    var s = String(text || '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
    if (s.length !== 56) throw err('recovery_key');
    var out = new Uint8Array(35), bits = 0, val = 0, o = 0;
    for (var i = 0; i < s.length; i++) {
      var c = CROCKFORD.indexOf(s[i]);
      if (c < 0) throw err('recovery_key');
      val = (val << 5) | c; bits += 5;
      if (bits >= 8) { bits -= 8; out[o++] = (val >> bits) & 255; }
      val &= (1 << bits) - 1;
    }
    var key = out.slice(0, 32);
    var check = blake2b256(key);
    if (check[0] !== out[32] || check[1] !== out[33] || check[2] !== out[34]) throw err('recovery_key');
    return key;
  }
  function newRecoveryKey() { var k = random(32); return { key: k, text: formatRecoveryKey(k) }; }
  /** The recovery key's proof (base64url): HKDF(key, salt empty, "gcdrive-v1:recovery-auth", 32) — the server keeps its SHA-256. */
  function recoveryAuth(key) { return hkdfBytes(u8(key), new Uint8Array(0), utf8('gcdrive-v1:recovery-auth'), 32).then(b64u); }
  /** The recovery key's X25519 key → { privateKey, publicRaw }. */
  function recoveryKeyPair(key) {
    return hkdfBytes(u8(key), new Uint8Array(0), utf8('gcdrive-v1:recovery'), 32).then(function (seed) {
      return keyFromSeed(seed).then(function (kp) { wipe(seed); return kp; });
    });
  }

  var api = {
    CHUNK: CHUNK, HEADER: HEADER, TAG: TAG,
    supported: supported, generateDeviceKey: generateDeviceKey, exportPublic: exportPublic, keyFromSeed: keyFromSeed,
    deviceId: deviceId, safetyNumber: safetyNumber, newVaultKey: newVaultKey, newVaultId: newVaultId,
    wrapKey: wrapKey, unwrapKey: unwrapKey, hpkeSeal: hpkeSeal, hpkeOpen: hpkeOpen,
    encryptName: encryptName, decryptName: decryptName, nameVersion: nameVersion,
    encryptContent: encryptContent, decryptContent: decryptContent, parseHeader: parseHeader, cipherSize: cipherSize,
    newRecoveryKey: newRecoveryKey, recoveryAuth: recoveryAuth, formatRecoveryKey: formatRecoveryKey, parseRecoveryKey: parseRecoveryKey, recoveryKeyPair: recoveryKeyPair,
    blake2b256: blake2b256, b64u: b64u, unb64u: unb64u, hex: hex, unhex: unhex, wipe: wipe, random: random, hkdfBytes: hkdfBytes,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DriveVaultCrypto = api;
}(typeof window !== 'undefined' ? window : globalThis));
