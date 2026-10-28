'use strict';

// The fixed vectors of the vault format (README.md "Tresor-Ordner – Kryptografie"): computed by compute() from the
// inputs below with ui/vaultcrypto.js; test/vault-vectors.json holds the frozen result — Android and Windows check the
// same file. Never change a vector: a new format gets a new version byte and new vectors.

const VC = require('../ui/vaultcrypto');

const seq = (from, n) => Uint8Array.from({ length: n }, (_, i) => (from + i) & 255);

const INPUT = {
  deviceSeed: VC.hex(seq(0x01, 32)),      // the device's X25519 private key (raw)
  ephemeralSeed: VC.hex(seq(0x21, 32)),   // the HPKE ephemeral key of the wraps (random in real use)
  vaultKey: VC.hex(seq(0x80, 32)),        // TK
  vaultId: 'Vt9bJm0n2QwErTyUiOpAsD',
  keyVersion: 1,
  name: 'Steuererklärung 2025 – Belege.pdf',
  nameNonce: VC.hex(seq(0x40, 12)),
  content: { length: 2500, pattern: '(i * 7 + 3) mod 256', chunkSize: 1024, salt: VC.hex(seq(0x50, 16)) },
  recoveryKey: VC.hex(seq(0xc0, 32)),
};

const contentBytes = () => Uint8Array.from({ length: INPUT.content.length }, (_, i) => (i * 7 + 3) & 255);

async function compute() {
  const dev = await VC.keyFromSeed(VC.unhex(INPUT.deviceSeed));
  const eph = await VC.keyFromSeed(VC.unhex(INPUT.ephemeralSeed));
  const tk = VC.unhex(INPUT.vaultKey);
  const rec = await VC.recoveryKeyPair(VC.unhex(INPUT.recoveryKey));
  const parts = await VC.encryptContent(tk, INPUT.vaultId, INPUT.keyVersion, contentBytes(), { chunkSize: INPUT.content.chunkSize, salt: VC.unhex(INPUT.content.salt) });
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  return {
    input: INPUT,
    device: {
      publicKey: VC.b64u(dev.publicRaw),
      deviceId: await VC.deviceId(dev.publicRaw),
      safetyNumber: await VC.safetyNumber(dev.publicRaw),
    },
    ephemeralPublicKey: VC.b64u(eph.publicRaw),
    wrap: await VC.wrapKey(tk, dev.publicRaw, INPUT.vaultId, INPUT.keyVersion, { ephemeral: eph }),
    nameCipher: await VC.encryptName(tk, INPUT.vaultId, INPUT.keyVersion, INPUT.name, { nonce: VC.unhex(INPUT.nameNonce) }),
    content: { size: all.length, sha256: require('node:crypto').createHash('sha256').update(all).digest('hex'), header: VC.hex(all.subarray(0, VC.HEADER)), base64url: VC.b64u(all) },
    recovery: {
      text: VC.formatRecoveryKey(VC.unhex(INPUT.recoveryKey)),
      publicKey: VC.b64u(rec.publicRaw),
      auth: await VC.recoveryAuth(VC.unhex(INPUT.recoveryKey)),
      wrap: await VC.wrapKey(tk, rec.publicRaw, INPUT.vaultId, INPUT.keyVersion, { ephemeral: eph }),
    },
  };
}

module.exports = { INPUT, compute, contentBytes };

if (require.main === module) compute().then((v) => process.stdout.write(JSON.stringify(v, null, 2) + '\n'));
