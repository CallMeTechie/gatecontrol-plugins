'use strict';

// Encryption at rest of message texts, locations, file names and group titles:
// AES-256-GCM with a random 96-bit nonce per value. The 256-bit key is created
// on the first start and kept as a secret setting of the plugin
// (gc.settings.setSecret 'enc_key' — stored encrypted with the server key by
// GateControl, never sent to a browser, re-keyed by backups like every secret).
//
// Honest limit: whoever has root on the server can read the plugin's secret
// and the database and so decrypt them. It protects against the admin UI, a
// copied database file and backups without their key — not against the server
// operator. End-to-end encryption is a later step.
//
// Format: 'v1.' + base64url(nonce 12 | tag 16 | ciphertext).

const crypto = require('node:crypto');

const SECRET_KEY = 'enc_key';
let key = null;

/** Load (or create) the key. Call in start() before anything else. */
async function init(gc) {
  let raw = null;
  try { raw = await gc.settings.get(SECRET_KEY); } catch { raw = null; }
  let buf = typeof raw === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(raw) ? Buffer.from(raw, 'base64') : null;
  if (!buf || buf.length !== 32) {
    buf = crypto.randomBytes(32);
    await gc.settings.setSecret(SECRET_KEY, buf.toString('base64'));
  }
  key = buf;
}

function ready() { return key !== null; }

/** string → sealed value (null stays null). */
function seal(s) {
  if (s == null) return null;
  if (!key) throw Object.assign(new Error('encryption key not loaded'), { code: 'internal' });
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(s), 'utf8'), c.final()]);
  return 'v1.' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}

/** sealed value → string; null stays null; a value that cannot be opened → undefined. */
function open(v) {
  if (v == null) return null;
  if (!key || typeof v !== 'string' || !v.startsWith('v1.')) return undefined;
  try {
    const b = Buffer.from(v.slice(3), 'base64url');
    if (b.length < 28) return undefined;
    const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}

/** Object → sealed JSON (null/empty stays null). */
function sealJson(o) {
  if (o == null || (typeof o === 'object' && !Object.keys(o).length)) return null;
  return seal(JSON.stringify(o));
}

/** Sealed JSON → object (null → null, unreadable → undefined). */
function openJson(v) {
  const s = open(v);
  if (s == null || s === undefined) return s;
  try { return JSON.parse(s); } catch { return undefined; }
}

function _reset() { key = null; }

module.exports = { init, ready, seal, open, sealJson, openJson, SECRET_KEY, _reset };
