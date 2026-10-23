'use strict';

// Test helpers: the mock host as GateControl 1.193.0 with a household — an administrator, Anna, Marc, their child
// Lena, Oma (no Vault yet) and a wall tablet account — and a controllable clock (node:test mock timers, Date only).
//
// The server never decrypts, so the tests use random bytes of the right sizes where the apps would send ciphertext
// (fake.*): what matters here is who may store, read and change which blob, not what is inside.

const path = require('node:path');
const crypto = require('node:crypto');
const { mock } = require('node:test');
const { createHost } = require('../../../tools/testing/mock-host');

const DIR = path.join(__dirname, '..');
const ADMIN = { id: 1, name: 'admin', role: 'admin' };
const ANNA = { id: 2, name: 'Anna', role: 'user' };
const MARC = { id: 3, name: 'Marc', role: 'user' };
const LENA = { id: 4, name: 'Lena', role: 'user' };
const OMA = { id: 5, name: 'Oma', role: 'user' };
const WALL = { id: 6, name: 'Küche', role: 'user' };
const USERS = [ADMIN, ANNA, MARC, LENA, OMA, WALL];

const T0 = Date.UTC(2026, 9, 24, 9, 0, 0);
const MIN = 60000;
const HOUR = 3600000;
const DAY = 86400000;

const b64 = (n) => crypto.randomBytes(n).toString('base64url');
const fake = {
  salt: () => b64(16),
  wrapped: () => b64(73),
  publicKey: () => b64(32),
  sealed: () => b64(80),
  name: () => b64(60),
  blob: (n = 300) => b64(n),
  id: () => crypto.randomBytes(16).toString('base64url'),
};
const KDF = () => ({ alg: 'argon2id', m: 65536, t: 3, p: 1, salt: fake.salt() });

/** What an app sends to set up Vault (POST account). */
function setupBody() {
  return {
    kdf: KDF(),
    userKeyPw: fake.wrapped(),
    userKeyRk: fake.wrapped(),
    publicKey: fake.publicKey(),
    privateKeyEnc: fake.wrapped(),
    personal: { id: fake.id(), nameEnc: fake.name(), sealedKey: fake.sealed() },
  };
}

function startClock(at = T0) {
  mock.timers.enable({ apis: ['Date'], now: at });
  let now = at;
  return {
    now: () => now,
    add(ms) { now += ms; mock.timers.setTime(now); },
    stop() { mock.timers.reset(); },
  };
}

/** The viewer of an app request (GateControl ≥ 1.193.0: user.device), or of the portal. */
const app = (u) => ({ ...u, portal: true, loggedIn: true, app: true, device: { id: `${u.name.toLowerCase()}-phone`, platform: 'android' } });
const portal = (u, loggedIn = true) => ({ ...u, portal: true, loggedIn });
const kiosk = (u) => ({ ...u, portal: true, loggedIn: true, kiosk: true });

/**
 * fn(host, c): c = { clock, as(user) → (method, path, body, query), portal(user, loggedIn), setup(user) → { body, personalId },
 *   item(user, vaultId, keyRev, o) → result, pushes() }
 */
async function withHost(opts, fn) {
  const o = opts || {};
  const clock = startClock(o.at || T0);
  try {
    const host = await createHost(DIR, { users: USERS, gatecontrol: '1.193.0' });
    await host.start();
    const call = (user, method, p, body, query) => host.request({ method, path: p, body: body === undefined ? null : body, query: query || {}, user, lang: o.lang || 'de' });
    const c = {
      clock, call,
      as: (u) => (method, p, body, query) => call(app(u), method, p, body, query),
      portal: (u, loggedIn) => (method, p, body, query) => call(portal(u, loggedIn), method, p, body, query),
      async setup(u) {
        const body = setupBody();
        const r = await call(app(u), 'POST', 'account', body);
        if (r.status !== 200) throw new Error('setup: ' + JSON.stringify(r.json));
        return { body, personalId: body.personal.id };
      },
      /** Save one entry: { id?, baseRev = 0, blob? } → the result row of POST items. */
      async item(u, vaultId, keyRev, io = {}) {
        const it = { id: io.id || fake.id(), vaultId, blob: io.blob || fake.blob(), keyRev, baseRev: io.baseRev || 0 };
        const r = await call(app(u), 'POST', 'items', { items: [it] });
        if (r.status !== 200) throw new Error('item: ' + JSON.stringify(r.json));
        return { ...r.json.results[0], sent: it };
      },
      pushes: () => host.notifications.filter((n) => n.topic),
    };
    try {
      return await fn(host, c);
    } finally {
      await host.close();
    }
  } finally {
    clock.stop();
  }
}

module.exports = { withHost, app, portal, kiosk, fake, KDF, setupBody, ADMIN, ANNA, MARC, LENA, OMA, WALL, USERS, T0, MIN, HOUR, DAY };
