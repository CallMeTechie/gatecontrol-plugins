/* Vault (gatecontrol-vault) — the end-to-end encryption of the portal tab: window.VaultCrypto.
 *
 * The same format as every app, bit for bit (README "Kryptoformat"; reference: gatecontrol-client-core
 * src/utils/vault-crypto.js, which uses libsodium). The sandboxed frame allows no WebAssembly, so the primitives are
 * the pure-JavaScript noble libraries (ui/vendor/noble.js, window.VaultNoble), checked against the shared vectors
 * (test/fixtures/vault-vectors.json):
 *
 *   master key    Argon2id(master password NFC, kdf.salt; kdf.m KiB, kdf.t passes, 1 lane) → 32 B, memory only
 *                 (argon2idAsync: the page stays responsive, with progress)
 *   wrapped       0x01 ‖ nonce (24 B) ‖ XChaCha20-Poly1305-IETF(plaintext, AD)
 *   sealed        crypto_box_seal: ephemeral X25519 key ‖ XSalsa20-Poly1305 with
 *                 key = HSalsa20(X25519(esk, pk), 0^16) and nonce = BLAKE2b-192(epk ‖ pk)
 *   entries       JSON padded like sodium_pad to 256-byte blocks, ≤ 32 KiB encrypted
 *   recovery key  32 B + 3 check bytes (BLAKE2b-256) in Crockford base32, 14 groups of 4
 *   safety number SHA-256("gcv1:fingerprint:" ‖ public key) → 8 groups of 5 digits
 *
 * Everything except masterKey / createAccount / unlock / changePassword / recover is synchronous. Random bytes come
 * from crypto.getRandomValues. Keys are Uint8Arrays; wipe() zeroes them on lock.
 */
(function (root) {
  'use strict';

  var N = root.VaultNoble;
  var VERSION = 1;
  var KEY_BYTES = 32;
  var NONCE_BYTES = 24;
  var SALT_BYTES = 16;
  var PAD_BLOCK = 256;
  var MAX_BLOB = 32768;
  var DEFAULT_KDF = { m: 65536, t: 3, p: 1 };
  var KDF_BOUNDS = { m: [19456, 1048576], t: [2, 10], p: [1, 1] };
  // what the browser tab spends at most on Argon2id (KiB): the server allows 1 GiB, which a malicious or broken
  // server could use to make the tab run out of memory; the apps use 64 MiB. More → 'kdf_too_large' (open it in an app)
  var MAX_M_BROWSER = 262144;
  var ITEM_TYPES = ['login', 'totp', 'note', 'card', 'wifi', 'identity'];

  var AD = {
    userKeyPw: 'gcv1:user-key:pw',
    userKeyRk: 'gcv1:user-key:rk',
    privateKey: 'gcv1:private-key',
    vaultName: function (vaultId) { return 'gcv1:vault-name:' + vaultId; },
    item: function (vaultId, itemId, rev) { return 'gcv1:item:' + vaultId + ':' + itemId + ':' + rev; },
  };

  /** code: 'decrypt' (wrong key, tampered, not where it belongs) · 'invalid' · 'recovery_key' · 'too_large' ·
   * 'kdf_too_large' (Argon2id asks for more memory than the browser tab spends, MAX_M_BROWSER) */
  function VaultCryptoError(code, message) {
    var e = new Error(message || code);
    e.name = 'VaultCryptoError';
    e.code = code;
    Object.setPrototypeOf(e, VaultCryptoError.prototype);
    return e;
  }
  VaultCryptoError.prototype = Object.create(Error.prototype);
  VaultCryptoError.prototype.constructor = VaultCryptoError;
  var fail = function (code, message) { return new VaultCryptoError(code, message); };

  // ── bytes and encoding ──────────────────────────────────

  function isBytes(v) {
    return v instanceof Uint8Array || (ArrayBuffer.isView(v) && v.constructor && v.constructor.name === 'Uint8Array');
  }

  function randomBytes(n) {
    var out = new Uint8Array(n);
    root.crypto.getRandomValues(out);
    return out;
  }

  var enc = new TextEncoder();
  var dec = new TextDecoder('utf-8', { fatal: true });
  var utf8 = function (s) { return enc.encode(s); };
  function fromUtf8(b) {
    try { return dec.decode(b); } catch (e) { throw fail('decrypt'); }
  }

  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  var B64_INDEX = (function () { var m = {}; for (var i = 0; i < 64; i++) m[B64[i]] = i; return m; }());

  /** base64url without padding */
  function b64(bytes) {
    var out = '';
    var i = 0;
    for (; i + 2 < bytes.length; i += 3) {
      var n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
    }
    if (bytes.length - i === 1) {
      var a = bytes[i] << 16;
      out += B64[(a >> 18) & 63] + B64[(a >> 12) & 63];
    } else if (bytes.length - i === 2) {
      var b = (bytes[i] << 16) | (bytes[i + 1] << 8);
      out += B64[(b >> 18) & 63] + B64[(b >> 12) & 63] + B64[(b >> 6) & 63];
    }
    return out;
  }

  function unb64(text) {
    if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) throw fail('invalid', 'not base64url');
    var out = new Uint8Array(Math.floor(text.length * 3 / 4));
    var o = 0;
    var acc = 0;
    var bits = 0;
    for (var i = 0; i < text.length; i++) {
      acc = (acc << 6) | B64_INDEX[text[i]];
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[o++] = (acc >> bits) & 255;
      }
      acc &= (1 << bits) - 1;
    }
    if (acc !== 0) throw fail('invalid', 'not base64url');
    return out;
  }

  function bytes(v, len, what) {
    var b = typeof v === 'string' ? unb64(v) : v;
    if (!isBytes(b) || (len != null && b.length !== len)) throw fail('invalid', what + ': ' + len + ' bytes expected');
    return b;
  }

  function concat() {
    var n = 0;
    var i;
    for (i = 0; i < arguments.length; i++) n += arguments[i].length;
    var out = new Uint8Array(n);
    var o = 0;
    for (i = 0; i < arguments.length; i++) { out.set(arguments[i], o); o += arguments[i].length; }
    return out;
  }

  /** Equal bytes, without an early exit. */
  function equal(a, b) {
    if (!isBytes(a) || !isBytes(b) || a.length !== b.length) return false;
    var d = 0;
    for (var i = 0; i < a.length; i++) d |= a[i] ^ b[i];
    return d === 0;
  }

  /** A new id for a vault or an entry: 16 random bytes, base64url (22 characters). */
  var newId = function () { return b64(randomBytes(16)); };

  // ── primitives ──────────────────────────────────────────

  /** 0x01 ‖ nonce ‖ ciphertext+tag. `nonce` only for test vectors. */
  function wrap(key, plaintext, ad, nonce) {
    var n = nonce ? bytes(nonce, NONCE_BYTES, 'nonce') : randomBytes(NONCE_BYTES);
    var ct = N.xchacha20poly1305(bytes(key, KEY_BYTES, 'key'), n, utf8(ad)).encrypt(bytes(plaintext, null, 'plaintext'));
    var out = new Uint8Array(1 + NONCE_BYTES + ct.length);
    out[0] = VERSION;
    out.set(n, 1);
    out.set(ct, 1 + NONCE_BYTES);
    return out;
  }

  function unwrap(key, data, ad) {
    var d = bytes(data, null, 'wrapped');
    if (d.length < 1 + NONCE_BYTES + 16 || d[0] !== VERSION) throw fail('invalid', 'unknown format');
    var k = bytes(key, KEY_BYTES, 'key');
    try {
      return N.xchacha20poly1305(k, d.subarray(1, 1 + NONCE_BYTES), utf8(ad)).decrypt(d.subarray(1 + NONCE_BYTES));
    } catch (e) {
      throw fail('decrypt');
    }
  }

  var SIGMA = new Uint32Array([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);
  function u32le(b) {
    var out = new Uint32Array(b.length / 4);
    for (var i = 0; i < out.length; i++) out[i] = (b[4 * i] | (b[4 * i + 1] << 8) | (b[4 * i + 2] << 16) | (b[4 * i + 3] << 24)) >>> 0;
    return out;
  }
  function le32bytes(w) {
    var out = new Uint8Array(w.length * 4);
    for (var i = 0; i < w.length; i++) {
      out[4 * i] = w[i] & 255; out[4 * i + 1] = (w[i] >>> 8) & 255; out[4 * i + 2] = (w[i] >>> 16) & 255; out[4 * i + 3] = (w[i] >>> 24) & 255;
    }
    return out;
  }

  /** crypto_box_beforenm: HSalsa20(X25519(sk, pk), 0^16). */
  function boxKey(secretKey, publicKey) {
    var shared;
    try { shared = N.x25519.getSharedSecret(secretKey, publicKey); } catch (e) { throw fail('decrypt'); }
    var out = new Uint32Array(8);
    N.hsalsa(SIGMA, u32le(shared), new Uint32Array(4), out);
    wipe(shared);
    var k = le32bytes(out);
    out.fill(0);
    return k;
  }

  var sealNonce = function (epk, pk) { return N.blake2b(concat(epk, pk), { dkLen: 24 }); };

  /** An X25519 key pair like crypto_box_keypair (random) or crypto_box_seed_keypair (sk = SHA-512(seed)[0..32]). */
  function boxKeypair(seed) {
    var secretKey = seed ? N.sha512(bytes(seed, 32, 'seed')).slice(0, 32) : randomBytes(32);
    return { publicKey: N.x25519.getPublicKey(secretKey), secretKey: secretKey };
  }

  /** crypto_box_seal: only the holder of the recipient's secret key opens it. `eph` (a key pair) only for tests. */
  function seal(message, publicKey, eph) {
    var pk = bytes(publicKey, 32, 'publicKey');
    var e = eph || boxKeypair();
    var k = boxKey(e.secretKey, pk);
    try {
      var ct = N.xsalsa20poly1305(k, sealNonce(e.publicKey, pk)).encrypt(bytes(message, null, 'message'));
      return concat(e.publicKey, ct);
    } finally {
      wipe(k);
      if (!eph) wipe(e.secretKey);
    }
  }

  function openSealed(sealed, publicKey, secretKey) {
    var s = bytes(sealed, null, 'sealed');
    var pk = bytes(publicKey, 32, 'publicKey');
    var sk = bytes(secretKey, 32, 'secretKey');
    if (s.length < 48) throw fail('decrypt');
    var epk = s.subarray(0, 32);
    var k = boxKey(sk, epk);
    var out;
    try {
      out = N.xsalsa20poly1305(k, sealNonce(epk, pk)).decrypt(s.subarray(32));
    } catch (e) {
      throw fail('decrypt');
    } finally {
      wipe(k);
    }
    if (out.length !== KEY_BYTES) throw fail('decrypt');
    return out;
  }

  /** sodium_pad: 0x80, then zeros up to the next multiple of the block (always at least one byte). */
  function pad(b, block) {
    var len = b.length + block - (b.length % block);
    var out = new Uint8Array(len);
    out.set(b);
    out[b.length] = 0x80;
    return out;
  }

  /** sodium_unpad */
  function unpad(b, block) {
    if (b.length < block) throw fail('decrypt');
    for (var i = b.length - 1; i >= b.length - block; i--) {
      if (b[i] === 0) continue;
      if (b[i] === 0x80) return b.slice(0, i);
      break;
    }
    throw fail('decrypt');
  }

  // ── master key ──────────────────────────────────────────

  /** A new kdf for the account: Argon2id, 64 MiB, 3 passes, a fresh salt. */
  function newKdf(opts) {
    var o = opts || {};
    return { alg: 'argon2id', m: o.m || DEFAULT_KDF.m, t: o.t || DEFAULT_KDF.t, p: 1, salt: b64(randomBytes(SALT_BYTES)) };
  }

  function checkKdf(kdf) {
    if (!kdf || kdf.alg !== 'argon2id') throw fail('invalid', 'kdf');
    ['m', 't', 'p'].forEach(function (k) {
      var n = kdf[k];
      if (!Number.isSafeInteger(n) || n < KDF_BOUNDS[k][0] || n > KDF_BOUNDS[k][1]) throw fail('invalid', 'kdf.' + k);
    });
    return bytes(kdf.salt, SALT_BYTES, 'kdf.salt');
  }

  /**
   * Argon2id(password) → Promise of the 32-byte master key; the password as UTF-8 after NFC normalization.
   * opts.onProgress(0…1) while it runs. argon2idAsync yields to the page with a macrotask every 25 ms (the bundle's
   * patch, test/vendor-build/build.mjs), so input, timers and repaints go on meanwhile.
   */
  function masterKey(password, kdf, opts) {
    try {
      if (typeof password !== 'string' || !password.length) throw fail('invalid', 'password');
      var salt = checkKdf(kdf);
      if (kdf.m > MAX_M_BROWSER) throw fail('kdf_too_large', 'kdf.m');
      var o = opts || {};
      var pw = utf8(password.normalize('NFC'));
      return N.argon2idAsync(pw, salt, { t: kdf.t, m: kdf.m, p: 1, dkLen: KEY_BYTES, asyncTick: 25, onProgress: o.onProgress })
        .then(function (k) { wipe(pw); return k; }, function () { wipe(pw); throw fail('invalid', 'kdf'); });
    } catch (e) {
      return Promise.reject(e);
    }
  }

  // ── recovery key ────────────────────────────────────────

  var B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  var checkBytes = function (key) { return N.blake2b(key, { dkLen: 32 }).subarray(0, 3); };

  function formatRecoveryKey(key) {
    var k = bytes(key, KEY_BYTES, 'recovery key');
    var all = concat(k, checkBytes(k));
    var bits = 0;
    var acc = 0;
    var out = '';
    for (var i = 0; i < all.length; i++) {
      acc = (acc << 8) | all[i];
      bits += 8;
      while (bits >= 5) {
        bits -= 5;
        out += B32[(acc >> bits) & 31];
      }
      acc &= (1 << bits) - 1;
    }
    wipe(all);
    return out.match(/.{4}/g).join('-');
  }

  function parseRecoveryKey(text) {
    if (typeof text !== 'string') throw fail('recovery_key');
    var s = text.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
    if (s.length !== 56) throw fail('recovery_key');
    var all = new Uint8Array(35);
    var bits = 0;
    var acc = 0;
    var o = 0;
    for (var i = 0; i < s.length; i++) {
      var v = B32.indexOf(s[i]);
      if (v < 0) throw fail('recovery_key');
      acc = (acc << 5) | v;
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        all[o++] = (acc >> bits) & 255;
      }
      acc &= (1 << bits) - 1;
    }
    var key = all.slice(0, 32);
    var ok = equal(checkBytes(key), all.subarray(32));
    wipe(all);
    if (!ok) { wipe(key); throw fail('recovery_key'); }
    return key;
  }

  // ── account ─────────────────────────────────────────────

  /**
   * Everything for POST account → Promise of { body, keys: { userKey, publicKey, secretKey, personalKey },
   * recoveryKey (text, shown once) }. opts: { kdf?, m?, t?, onProgress?, rnd? (test vectors only) }.
   */
  function createAccount(password, personalName, opts) {
    var o = opts || {};
    var rnd = o.rnd || {};
    var kdf;
    try { kdf = o.kdf || newKdf(o); } catch (e) { return Promise.reject(e); }
    return masterKey(password, kdf, o).then(function (mk) {
      var userKey = rnd.userKey ? bytes(rnd.userKey, KEY_BYTES, 'userKey').slice() : randomBytes(KEY_BYTES);
      var recovery = rnd.recoveryKey ? bytes(rnd.recoveryKey, KEY_BYTES, 'recoveryKey').slice() : randomBytes(KEY_BYTES);
      var pair = boxKeypair(rnd.keySeed || null);
      var personalId = rnd.personalId || newId();
      var personalKey = rnd.personalKey ? bytes(rnd.personalKey, KEY_BYTES, 'personalKey').slice() : randomBytes(KEY_BYTES);
      var n = rnd.nonces || [];
      var body = {
        kdf: kdf,
        userKeyPw: b64(wrap(mk, userKey, AD.userKeyPw, n[0])),
        userKeyRk: b64(wrap(recovery, userKey, AD.userKeyRk, n[1])),
        publicKey: b64(pair.publicKey),
        privateKeyEnc: b64(wrap(userKey, pair.secretKey, AD.privateKey, n[2])),
        personal: {
          id: personalId,
          nameEnc: encryptName(personalKey, personalId, personalName, n[3]),
          sealedKey: b64(seal(personalKey, pair.publicKey)),
        },
      };
      wipe(mk);
      var recoveryKey = formatRecoveryKey(recovery);
      wipe(recovery);
      return { body: body, keys: { userKey: userKey, publicKey: pair.publicKey, secretKey: pair.secretKey, personalKey: personalKey }, recoveryKey: recoveryKey };
    });
  }

  /** The account's keys from the user key (after either unlock); the key pair must match the public key. */
  function keysFrom(account, userKey) {
    var publicKey = bytes(account.publicKey, 32, 'publicKey').slice();
    var secretKey = unwrap(userKey, account.privateKeyEnc, AD.privateKey);
    if (secretKey.length !== 32 || !equal(N.x25519.getPublicKey(secretKey), publicKey)) {
      wipe(secretKey);
      throw fail('decrypt');
    }
    return { userKey: userKey, publicKey: publicKey, secretKey: secretKey };
  }

  /** The account + the master password → Promise of keys; VaultCryptoError 'decrypt' for a wrong password. */
  function unlock(account, password, opts) {
    return masterKey(password, account && account.kdf, opts).then(function (mk) {
      try {
        return keysFrom(account, unwrap(mk, account.userKeyPw, AD.userKeyPw));
      } finally {
        wipe(mk);
      }
    });
  }

  /** The recovery key (text) → keys, or VaultCryptoError 'recovery_key' / 'decrypt'. */
  function unlockWithRecovery(account, recoveryText) {
    var rk = parseRecoveryKey(recoveryText);
    try {
      return keysFrom(account, unwrap(rk, account.userKeyRk, AD.userKeyRk));
    } finally {
      wipe(rk);
    }
  }

  /** PUT account body for a new master password (the user key stays; a fresh salt) → Promise. */
  function changePassword(account, keys, newPassword, opts) {
    var o = opts || {};
    var kdf;
    try { kdf = o.kdf || newKdf(o); } catch (e) { return Promise.reject(e); }
    return masterKey(newPassword, kdf, o).then(function (mk) {
      try {
        return { rev: account.rev, kdf: kdf, userKeyPw: b64(wrap(mk, keys.userKey, AD.userKeyPw, o.nonce)) };
      } finally {
        wipe(mk);
      }
    });
  }

  /** After a recovery: a new master password and a new recovery key → Promise of { body, recoveryKey }. */
  function recover(account, keys, newPassword, opts) {
    var o = opts || {};
    return changePassword(account, keys, newPassword, o).then(function (body) {
      var rk = o.recoveryKey ? bytes(o.recoveryKey, KEY_BYTES, 'recoveryKey').slice() : randomBytes(KEY_BYTES);
      body.userKeyRk = b64(wrap(rk, keys.userKey, AD.userKeyRk, o.rkNonce));
      var recoveryKey = formatRecoveryKey(rk);
      wipe(rk);
      return { body: body, recoveryKey: recoveryKey };
    });
  }

  // ── vaults ──────────────────────────────────────────────

  var newVaultKey = function () { return randomBytes(KEY_BYTES); };

  /** A vault key sealed to a public key (base64url) — for POST vaults and members. */
  var sealKey = function (vaultKey, publicKey) { return b64(seal(bytes(vaultKey, KEY_BYTES, 'key'), publicKey)); };

  /** { [keyRev]: key } of a sync Vault: the current key and, during a key change, the new one (pending). */
  function vaultKeys(vault, keys) {
    var out = {};
    out[vault.keyRev] = openSealed(vault.sealedKey, keys.publicKey, keys.secretKey);
    if (vault.pending && vault.pending.sealedKey) out[vault.pending.keyRev] = openSealed(vault.pending.sealedKey, keys.publicKey, keys.secretKey);
    return out;
  }

  function encryptName(vaultKey, vaultId, name, nonce) {
    if (typeof name !== 'string' || name.length > 200) throw fail('invalid', 'name');
    return b64(wrap(vaultKey, utf8(name), AD.vaultName(vaultId), nonce));
  }

  var decryptName = function (vaultKey, vaultId, nameEnc) { return fromUtf8(unwrap(vaultKey, nameEnc, AD.vaultName(vaultId))); };

  // ── entries ─────────────────────────────────────────────

  /** An entry → its blob; at = { vaultId, itemId, rev } with rev = the revision this save creates (baseRev + 1). */
  function encryptItem(vaultKey, at, item, nonce) {
    if (!item || typeof item !== 'object' || item.v !== 1 || ITEM_TYPES.indexOf(item.type) < 0) throw fail('invalid', 'item');
    return encryptItemBytes(vaultKey, at, utf8(JSON.stringify(item)), nonce);
  }

  function encryptItemBytes(vaultKey, at, plain, nonce) {
    if (!at || !Number.isSafeInteger(at.rev) || at.rev < 1) throw fail('invalid', 'rev');
    var padded = pad(plain, PAD_BLOCK);
    if (1 + NONCE_BYTES + padded.length + 16 > MAX_BLOB) throw fail('too_large');
    return b64(wrap(vaultKey, padded, AD.item(at.vaultId, at.itemId, at.rev), nonce));
  }

  /** A sync Item → the entry object; vault, id and rev from the Item itself, so a moved or replayed blob fails. */
  function decryptItem(vaultKey, item) {
    var padded = unwrap(vaultKey, item.blob, AD.item(item.vaultId, item.id, item.rev));
    var obj;
    try {
      obj = JSON.parse(fromUtf8(unpad(padded, PAD_BLOCK)));
    } catch (e) {
      throw fail('decrypt');
    } finally {
      wipe(padded);
    }
    if (!obj || typeof obj !== 'object' || obj.v !== 1) throw fail('decrypt');
    return obj;
  }

  // ── safety number ───────────────────────────────────────

  function safetyNumber(publicKey) {
    var h = N.sha256(concat(utf8('gcv1:fingerprint:'), bytes(publicKey, 32, 'publicKey')));
    var groups = [];
    for (var i = 0; i < 8; i++) {
      var w = ((h[4 * i] << 24) >>> 0) + (h[4 * i + 1] << 16) + (h[4 * i + 2] << 8) + h[4 * i + 3];
      groups.push(String(w % 100000).padStart(5, '0'));
    }
    return groups.join(' ');
  }

  // ── emergency access ────────────────────────────────────

  /** POST emergency's sealedKey: the grantor's user key sealed to the trusted person's public key. */
  var sealForEmergency = function (keys, granteePublicKey) { return b64(seal(keys.userKey, granteePublicKey)); };

  /** GET emergency/<id>/access + the trusted person's keys → the grantor's keys. */
  function openEmergency(access, myKeys) {
    var userKey = openSealed(access.sealedKey, myKeys.publicKey, myKeys.secretKey);
    try {
      return keysFrom({ publicKey: access.grantor.publicKey, privateKeyEnc: access.grantor.privateKeyEnc }, userKey);
    } catch (e) {
      wipe(userKey);
      throw e;
    }
  }

  /** Zeroes keys held in memory: Uint8Arrays, or objects / Maps holding them. */
  function wipe() {
    for (var i = 0; i < arguments.length; i++) {
      var k = arguments[i];
      if (isBytes(k)) k.fill(0);
      else if (k instanceof Map) k.forEach(function (v) { wipe(v); });
      else if (k && typeof k === 'object') Object.keys(k).forEach(function (x) { if (isBytes(k[x])) k[x].fill(0); });
    }
  }

  root.VaultCrypto = Object.freeze({
    VaultCryptoError: VaultCryptoError, AD: AD, ITEM_TYPES: ITEM_TYPES, DEFAULT_KDF: DEFAULT_KDF, KDF_BOUNDS: KDF_BOUNDS, MAX_M_BROWSER: MAX_M_BROWSER,
    b64: b64, unb64: unb64, utf8: utf8, fromUtf8: fromUtf8, randomBytes: randomBytes, equal: equal, newId: newId,
    wrap: wrap, unwrap: unwrap, boxKeypair: boxKeypair, seal: seal, openSealed: openSealed, pad: pad, unpad: unpad,
    newKdf: newKdf, checkKdf: checkKdf, masterKey: masterKey, formatRecoveryKey: formatRecoveryKey, parseRecoveryKey: parseRecoveryKey,
    createAccount: createAccount, keysFrom: keysFrom, unlock: unlock, unlockWithRecovery: unlockWithRecovery,
    changePassword: changePassword, recover: recover,
    newVaultKey: newVaultKey, sealKey: sealKey, vaultKeys: vaultKeys, encryptName: encryptName, decryptName: decryptName,
    encryptItem: encryptItem, encryptItemBytes: encryptItemBytes, decryptItem: decryptItem, safetyNumber: safetyNumber,
    sealForEmergency: sealForEmergency, openEmergency: openEmergency, wipe: wipe,
  });
}(typeof window !== 'undefined' ? window : globalThis));
