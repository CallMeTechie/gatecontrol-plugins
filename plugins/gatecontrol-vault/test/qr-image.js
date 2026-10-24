'use strict';

// QR codes as pictures for the tests (1.2.0): a text → the bundled encoder uqr (VaultNoble.qrEncode) → RGBA pixels
// (dark modules on a light background with a quiet zone), as a canvas hands them to the decoder; and a Google
// Authenticator export (otpauth-migration://offline?data=…) built with a small Protocol Buffers writer.

/** text → { width, height, data: Uint8ClampedArray RGBA } */
function qrPicture(N, text, { scale = 4, border = 4, invert = false } = {}) {
  const q = N.qrEncode(text, { ecc: 'M', border: 0 });
  const w = (q.size + 2 * border) * scale;
  const light = invert ? 0 : 255;
  const dark = invert ? 255 : 0;
  const data = new Uint8ClampedArray(w * w * 4);
  for (let i = 0; i < w * w; i++) { data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = light; data[i * 4 + 3] = 255; }
  for (let y = 0; y < q.size; y++) {
    for (let x = 0; x < q.size; x++) {
      if (!q.data[y][x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const o = (((y + border) * scale + dy) * w + (x + border) * scale + dx) * 4;
          data[o] = data[o + 1] = data[o + 2] = dark;
        }
      }
    }
  }
  return { width: w, height: w, data };
}

/** A plain picture without any code. */
function blankPicture(w = 120, h = 80) {
  return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(255) };
}

// ── Protocol Buffers (only what MigrationPayload needs) ──

function varint(n) {
  const out = [];
  let v = n;
  while (v >= 0x80) { out.push((v % 0x80) | 0x80); v = Math.floor(v / 0x80); }
  out.push(v);
  return out;
}
const tag = (field, wire) => varint(field * 8 + wire);
const bytesField = (field, bytes) => [...tag(field, 2), ...varint(bytes.length), ...bytes];
const intField = (field, n) => [...tag(field, 0), ...varint(n)];

/**
 * entries [{ secret: Buffer, name, issuer, algorithm, digits, type, counter }] → the export link Google
 * Authenticator shows as a QR code (MigrationPayload { otp_parameters = 1; version = 2; batch_size = 3;
 * batch_index = 4; batch_id = 5 }).
 */
function migrationUri(entries, { batchSize = 1, batchIndex = 0, extra = [] } = {}) {
  const payload = [];
  for (const e of entries) {
    const p = [
      ...bytesField(1, [...e.secret]),
      ...(e.name != null ? bytesField(2, [...Buffer.from(e.name)]) : []),
      ...(e.issuer != null ? bytesField(3, [...Buffer.from(e.issuer)]) : []),
      ...intField(4, e.algorithm ?? 1),
      ...intField(5, e.digits ?? 1),
      ...intField(6, e.type ?? 2),
      ...(e.counter != null ? intField(7, e.counter) : []),
    ];
    payload.push(...bytesField(1, p));
  }
  payload.push(...intField(2, 1), ...intField(3, batchSize), ...intField(4, batchIndex), ...intField(5, 123456789), ...extra);
  return 'otpauth-migration://offline?data=' + encodeURIComponent(Buffer.from(payload).toString('base64'));
}

module.exports = { qrPicture, blankPicture, migrationUri, bytesField, intField };
