'use strict';

// TOTP of the QR login (server/totp.js): RFC 6238 test vectors (SHA1), base32 of RFC 4648,
// and the 6-digit / 30-second defaults of otplib's authenticator.

const test = require('node:test');
const assert = require('node:assert/strict');
const { base32Decode, hotp, totp } = require('../server/totp');

// RFC 6238 appendix B: the SHA1 secret is the ASCII string "12345678901234567890"
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const VECTORS = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

test('base32: RFC 4648 vectors, case, spaces and padding', () => {
  assert.equal(base32Decode(RFC_SECRET).toString('ascii'), '12345678901234567890');
  assert.equal(base32Decode('MY======').toString(), 'f');
  assert.equal(base32Decode('MZXW6===').toString(), 'foo');
  assert.equal(base32Decode('MZXW6YTBOI======').toString(), 'foobar');
  assert.equal(base32Decode('mzxw 6ytb-oi').toString(), 'foobar', 'lower case, spaces and dashes');
  for (const bad of ['', '  ', 'MZXW1', 'ÄBC', null]) assert.throws(() => base32Decode(bad), { code: 'BASE32_INVALID' });
});

test('totp: RFC 6238 SHA1 vectors (8 digits)', () => {
  for (const [s, code] of VECTORS) assert.equal(totp(RFC_SECRET, s * 1000, { digits: 8 }), code, `T = ${s}`);
});

test('totp: 6 digits by default (the last six of the RFC values), 30-second steps', () => {
  for (const [s, code] of VECTORS) assert.equal(totp(RFC_SECRET, s * 1000), code.slice(-6), `T = ${s}`);
  // same step → same code; the next step → another
  assert.equal(totp(RFC_SECRET, 1111111110 * 1000), totp(RFC_SECRET, 1111111119 * 1000));
  assert.notEqual(totp(RFC_SECRET, 1111111109 * 1000), totp(RFC_SECRET, 1111111111 * 1000));
  assert.match(totp('JBSWY3DPEHPK3PXP', Date.now()), /^\d{6}$/);
});

test('hotp: RFC 4226 appendix D', () => {
  const key = Buffer.from('12345678901234567890');
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  expected.forEach((code, i) => assert.equal(hotp(key, i), code, `counter ${i}`));
});
