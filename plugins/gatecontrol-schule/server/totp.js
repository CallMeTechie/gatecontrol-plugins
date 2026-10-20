'use strict';

// One-time passwords for the WebUntis "QR code" login (Profil › Freigaben ›
// Datenzugriff): the QR link carries a base32 secret; WebUntis checks a TOTP
// of it (RFC 6238 with the defaults of otplib's authenticator: HMAC-SHA1,
// 6 digits, 30-second steps, counter = floor(unix seconds / 30)). Plain
// node:crypto, no dependency. The secret and the codes are never logged.

const crypto = require('node:crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 (case-insensitive; spaces, dashes and padding ignored) → Buffer; throws on other characters. */
function base32Decode(s) {
  const clean = String(s == null ? '' : s).toUpperCase().replace(/[\s=-]/g, '');
  if (!clean || !/^[A-Z2-7]+$/.test(clean)) throw Object.assign(new Error('invalid base32'), { code: 'BASE32_INVALID' });
  let bits = 0;
  let value = 0;
  const out = [];
  for (const c of clean) {
    value = (value << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 4226 HOTP of `key` (Buffer) at `counter`. */
function hotp(key, counter, { digits = 6, algorithm = 'sha1' } = {}) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac(algorithm, key).update(msg).digest();
  const o = h[h.length - 1] & 0x0f;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** RFC 6238 TOTP of a base32 secret at `timeMs` (default: 6 digits, 30 s, SHA1). */
function totp(secretBase32, timeMs, { step = 30, digits = 6, algorithm = 'sha1' } = {}) {
  const counter = Math.floor(Math.floor(Number(timeMs) / 1000) / step);
  return hotp(base32Decode(secretBase32), counter, { digits, algorithm });
}

module.exports = { base32Decode, hotp, totp };
