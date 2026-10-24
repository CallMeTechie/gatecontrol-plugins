// What the portal tab needs of the noble libraries and uqr, bundled by test/vendor-build/build.sh into ui/vendor/noble.js
// (one minified IIFE, window.VaultNoble). Pure JavaScript: the sandboxed frame allows no WebAssembly and no
// external scripts (frame CSP script-src 'unsafe-inline').
export { argon2id, argon2idAsync } from '@noble/hashes/argon2';
export { blake2b } from '@noble/hashes/blake2';
export { sha256, sha512 } from '@noble/hashes/sha2';
export { sha1 } from '@noble/hashes/legacy';
export { hmac } from '@noble/hashes/hmac';
export { xchacha20poly1305 } from '@noble/ciphers/chacha';
export { xsalsa20poly1305, hsalsa } from '@noble/ciphers/salsa';
export { x25519 } from '@noble/curves/ed25519';
export { encode as qrEncode } from 'uqr';
