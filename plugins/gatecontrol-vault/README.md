# gatecontrol-vault — Vault

An end-to-end encrypted password manager on one's own GateControl server: logins, 2FA codes, notes, cards and Wi-Fi
credentials — in a **personal vault** and in **shared vaults** (family, team) with roles. The apps (Android, Windows)
and the portal tab "Vault" (1.1.0) encrypt and decrypt; the server keeps only data it cannot read: encrypted entries, keys sealed to
each member, a change counter for the offline copy, a trash (30 days), the last 10 versions of an entry and
**emergency access** for trusted people. Syncing uses the server's normal public address — no VPN needed.

*Deutsch:* Passwort-Manager auf dem eigenen Server, Ende-zu-Ende verschlüsselt. Ver- und entschlüsselt wird nur in
den Apps und im Portal-Tab „Vault“ (nur in diesem Browser-Tab); ohne Hauptpasswort, Wiederherstellungsschlüssel oder freigegebenen Notfallzugriff kann niemand die Daten
lesen – auch kein Administrator. Details im CHANGELOG.

Needs GateControl ≥ 1.193.0 (`permissions.app`, `permissions.notify`, `user.device`, `user.kiosk`).

## Who may do what

* Every signed-in person (portal or app) may set up Vault — never a kiosk device (`user.kiosk`: a wall tablet is no
  person), never device trust alone (`loggedIn: false` → `403 login_required`), never the admin UI.
* Shared vaults have roles: `read` (open entries), `write` (also create, change, trash, delete) and `manage` (also
  rename, members, roles, key change, delete the vault). A vault always keeps one manager. The personal vault is
  never shared.
* Administrators see on the admin page *Übersicht* only who uses Vault and counts — never names of vaults, entries or
  key material. There is **no reset by an administrator**.

## App-API

Apps: `/api/v1/client/plugins/gatecontrol-vault/api/<path>` (device token; a body is ≤ 64 KB). Portal frame:
`GC.call(method, '<path>')` → `/api/v1/portal/plugins/gatecontrol-vault/api/<path>` (also under `portal/<path>`).
Answers: `{ ok: true, … }`; errors `{ ok: false, code, error }` (localized text, sometimes more fields) with

| code | HTTP | |
|---|---|---|
| `invalid` | 400 | bad body / query, a field of the wrong size (see Kryptoformat) |
| `login_required`, `forbidden` | 403 | see above; the role does not allow it |
| `no_account` | 404 | Vault is not set up for the caller (or for the person named) |
| `not_found` | 404 | unknown, purged, or not one of the caller's vaults |
| `exists` | 409 | the account / an id already exists, the person is already a member |
| `conflict` | 409 | changed in the meantime: `account` (PUT account) or a request that does not fit the state |
| `stale_key` | 409 | the vault's key generation changed — sync, then encrypt again |
| `rekeying` | 409 | the vault is in a key change (finish: `left` = entries not yet on the new key) |
| `last_manager` | 409 | a vault needs a manager |
| `limit` | 409 | see Limits |

Ids of vaults and entries are chosen by the app: 16–40 characters `[A-Za-z0-9_-]` (e.g. 16 random bytes in
base64url). Every encrypted field is base64url **without padding**. Times are ISO-8601 UTC strings.

### Konto (account)

`GET account` → `{ account: null | Account }`

```jsonc
Account = { "kdf": { "alg": "argon2id", "m": 65536, "t": 3, "p": 1, "salt": "…" },  // m in KiB
            "userKeyPw": "…", "userKeyRk": "…", "publicKey": "…", "privateKeyEnc": "…",
            "rev": 1, "createdAt": "…", "updatedAt": "…" }
```

`POST account` — set up (once): `{ kdf, userKeyPw, userKeyRk, publicKey, privateKeyEnc, personal: { id, nameEnc,
sealedKey } }` → `{ account }`. Creates the account and the personal vault in one step (`exists` the second time).
The app shows the recovery key before it sends this and ends the setup only once the person confirmed they kept it.

`PUT account` — `{ rev, kdf, userKeyPw, userKeyRk? }` → `{ account }`: a new master password (new salt, the user key
stays, only its wrapping changes) or, after a recovery, a new password **and** a new recovery key. Compare-and-swap on
`rev`; a stale `rev` → `conflict` with the current `account`.

`POST account/delete` — `{ confirm: "DELETE" }` → `{ account: null }`: the account, the personal vault, the person's
memberships and emergency grants (both ways). A shared vault the person was alone in goes; where they were the last
manager, the longest-standing member becomes manager. Shared vaults they were in get `needsRekey`.

`GET people` → `{ people: [{ id, name, publicKey | null }] }` — every GateControl account except the caller and kiosk
accounts, by name; `publicKey` once that person set up Vault (only those can be added to a vault or trusted).

### Tresore (vaults)

```jsonc
Vault = { "id": "…", "kind": "personal" | "shared", "ownerId": 2, "nameEnc": "…",
          "role": "read" | "write" | "manage",                         // the caller's
          "keyRev": 1, "sealedKey": "…",                               // the vault key of keyRev, sealed to the caller
          "pending": null | { "keyRev": 2, "sealedKey": "…" },         // during a key change: the new key
          "needsRekey": false,                                         // someone left: a manager's app changes the key
          "members": [{ "userId": 2, "name": "Anna", "role": "manage" }],
          "updatedAt": "…" }
```

* `POST vaults` — `{ id, nameEnc, sealedKey }` → `{ vault }`: a shared vault, the caller its manager.
* `PUT vaults/<id>` — `{ nameEnc }` (manage; also the personal vault) → `{ vault }`. Not during a key change.
* `DELETE vaults/<id>` — a shared vault with everything in it (manage) → `{ removed }`.
* `POST vaults/<id>/members` — `{ userId, role, sealedKey }` (manage) → `{ vault }`: the app seals the vault key to
  the person's `publicKey` (`GET people`). The person gets a push (topic `share`). Not during a key change.
* `PUT vaults/<id>/members/<userId>` — `{ role }` (manage) → `{ vault }`.
* `DELETE vaults/<id>/members/<userId>` — a manager removes someone, or a member leaves (own id) → `{ vault }`
  (`{ vault: null }` after leaving). The last member leaving deletes the vault. Sets `needsRekey`: what the person
  could read they know — and they knew the key. Not during a key change.

### Schlüsselwechsel (key change)

After someone left (`needsRekey`), a manager's app gives the vault a new key, in steps because a request is ≤ 64 KB:

1. `POST vaults/<id>/rekey/start` — `{ keyRev: keyRev + 1, keys: [{ userId, sealedKey }] }` for **exactly** the
   current members → `{ vault }` (with `pending`). Refused with `rekeying` while a change is pending — another
   manager's app continues with `pending` instead; only a change stuck for a day with no entry on the new key yet may
   be started again.
2. `POST items` for every entry not purged — trash included — encrypted with the new key, `keyRev` = the new one,
   `baseRev` = its rev. From step 1 on only the new `keyRev` is accepted (`stale_key` otherwise), also from the
   other members' apps: they read `pending` from the sync and use it.
3. `POST vaults/<id>/rekey/finish` — `{ nameEnc }` (the name under the new key) → `{ vault }`. Refused with
   `rekeying` and `left` while entries still use the old key. The new key becomes the current one, the members'
   `pending` becomes their `sealedKey`, old versions under the old key are deleted, `needsRekey` clears (unless an
   account was deleted during the change — then it stays set and the change runs again).

### Einträge (entries)

```jsonc
Item = { "id": "…", "vaultId": "…", "rev": 3, "keyRev": 1, "blob": "…" | null,   // null when purged
         "state": "live" | "trash" | "purged", "trashedAt": null, "updatedAt": "…", "updatedBy": 2,
         "device": "Pixel 9" | null, "seq": 1234 }
```

`POST items` — `{ items: [{ id, vaultId, blob, keyRev, baseRev }], device? }` (1–100 entries, write role) →
`{ results: [{ id, ok: true, rev, seq } | { id, ok: false, code, current? }] }`. `baseRev` 0 creates an entry, any
other value is the revision the app changed (compare-and-swap). Each entry is answered on its own: `conflict` carries
the `current` entry — the app keeps both (the other version as a copy "Konflikt …"), never silently one. A different
`vaultId` moves the entry (write role in both; re-encrypted with the target's key; the old versions go). Saving keeps
the trash state. The new revision is `baseRev + 1` (1 for a new entry) — the app encrypts with that number (AD).

* `POST items/<id>/trash` · `POST items/<id>/restore` → `{ item }` (write). The trash is emptied after 30 days.
* `DELETE items/<id>` → `{ item }` (write): purged now — the blob and its versions are gone, a tombstone
  (`state: "purged"`) stays so every app drops its copy. A purged id is never used again (`not_found`).
* `GET items/<id>/history` → `{ history: [{ rev, keyRev, blob, updatedAt, updatedBy, device }] }`, newest first, ≤ 10.

### Abgleich (sync)

`GET sync?since=<seq>&limit=<n>&vault=<id>` →

```jsonc
{ "ok": true, "seq": 1240,                 // the server's change counter now
  "account": Account | null,               // when since = 0 or it changed since `since`
  "vaults": [Vault, …],                    // every vault of the caller, always complete
  "items": [Item, …],                      // changed entries (tombstones too), by seq, ≤ limit (200, max 500)
  "more": false, "next": 1240 }            // more pages: call again with since = next
```

The app stores `next` of the last page as its new `since`. A vault in `vaults` it does not know yet (just shared with
the person): `vault=<id>&since=0` for its entries. A vault missing from `vaults` is gone for the caller — drop its
copy. An entry of a vault in a key change may still use the old `keyRev` (both keys are in the vault).

### Notfallzugriff (emergency access)

The grantor's app seals the grantor's **user key** to a trusted person's `publicKey`. The trusted person can ask for
access; the grantor gets a push and can refuse. Only when the waiting time passed (or the grantor allows it early)
does the server hand the sealed key out — read access to all of the grantor's vaults. The server cannot open it.

```jsonc
Emergency = { "id": "…", "grantor": { "id": 2, "name": "Anna" }, "grantee": { "id": 3, "name": "Marc" },
              "waitHours": 48, "status": "ready" | "requested" | "granted",
              "requestedAt": null, "releaseAt": null, "grantedAt": null }
```

* `GET emergency` → `{ granted: [Emergency] /* I gave */, received: [Emergency] /* I got */ }`.
* `POST emergency` — `{ granteeId, waitHours (1–720), sealedKey }` → `{ emergency }`: name a trusted person (≤ 10),
  or renew the key / waiting time while `ready` (`conflict` otherwise).
* `DELETE emergency/<id>` — the grantor withdraws it or the trusted person declines it → `{ removed }`.
* `POST emergency/<id>/request` (trusted person) → `requested`; the grantor gets a push with the waiting time.
* `POST emergency/<id>/deny` (grantor) → back to `ready`, also from `granted` (takes access back); push to the
  trusted person.
* `POST emergency/<id>/approve` (grantor) → `granted` before the waiting time ends.
* In the background (every 5 minutes) a request whose waiting time passed becomes `granted`; both get a push.
* While `granted`, for the trusted person only:
  `GET emergency/<id>/access` → `{ sealedKey, grantor: { id, name, publicKey, privateKeyEnc }, vaults: [Vault] }`
  (the grantor's vaults with their keys sealed to the grantor) and `GET emergency/<id>/items?since=&limit=` →
  `{ seq, items, more, next }` (live and trash, read-only).

### Mitteilungen (pushes)

Topics `share` ("Anna hat einen Tresor mit dir geteilt.") and `emergency` (requested, denied, granted, released).
`data`: `{ vault: { topic: "share" | "emergency", event: "shared" | "requested" | "denied" | "granted" | "released",
vault?: <id>, emergency?: <id> } }`. Pushes never carry names of vaults or entries, nor any key material.

### Limits

100 entries per `POST items`, 32 KiB per encrypted entry, 5000 entries and 64 MiB of encrypted text per vault,
10 versions per entry, 20 shared vaults per person, 50 members per vault, 10 trusted people per person, trash
30 days, sync pages of 200 (≤ 500). The log of actions (no content) is kept 90 days.

## Kryptoformat

libsodium semantics on every platform (Windows/Electron: libsodium-wrappers-sumo; Android: the same primitives from
Bouncy Castle, pure Java; the portal tab: the pure-JavaScript noble libraries, see "Portal-Tab" — all checked against
the same vectors). The
reference implementation and its fixed test vectors live in **gatecontrol-client-core** (`vault-crypto`); every app
checks the same vectors, so all platforms encrypt and decrypt bit for bit alike. The server checks only shapes and
sizes — it never holds a key.

| Key | Made | Stored | Opens |
|---|---|---|---|
| master key (32 B) | `crypto_pwhash` Argon2id13 (master password, `kdf.salt` 16 B), `m` KiB, `t` passes; apps 64 MiB / 3, `p` = 1 | memory only | `userKeyPw` |
| recovery key (32 B, random) | at setup, shown once (copy, print) | with the person only | `userKeyRk` |
| user key (32 B, random) | at setup | `userKeyPw`, `userKeyRk` | `privateKeyEnc` |
| key pair (X25519) | `crypto_box_keypair` at setup | `publicKey` (raw 32 B), `privateKeyEnc` | `sealedKey`s |
| vault key (32 B, random) | per vault and key generation | `sealedKey` per member | `nameEnc`, the vault's `blob`s |

Server bounds: `m` 19456–1048576 KiB, `t` 2–10, `p` 1 (libsodium has one lane).

**Wrapped** (`userKeyPw`, `userKeyRk`, `privateKeyEnc`, `nameEnc`, `blob`):
`0x01 ‖ nonce (24 B, random) ‖ crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, AD, nonce, key)` — 41 bytes
plus the plaintext. The **AD** (UTF-8) binds each ciphertext to its place, so the server cannot swap or replay them:

| Field | Key | AD | Plaintext |
|---|---|---|---|
| `userKeyPw` | master key | `gcv1:user-key:pw` | user key |
| `userKeyRk` | recovery key | `gcv1:user-key:rk` | user key |
| `privateKeyEnc` | user key | `gcv1:private-key` | X25519 secret key (32 B) |
| `nameEnc` | vault key | `gcv1:vault-name:<vaultId>` | name, UTF-8 |
| `blob` | vault key | `gcv1:item:<vaultId>:<itemId>:<rev>` | entry JSON, UTF-8, `sodium_pad` to 256-byte blocks |

**Sealed** (`sealedKey` of a member, `pending.sealedKey`, an emergency's `sealedKey`):
`crypto_box_seal(key, recipient publicKey)` — 80 bytes for a 32-byte key. A member's holds the vault key; an
emergency's holds the grantor's user key (→ `privateKeyEnc` → the grantor's `sealedKey`s).

The entry JSON (`{ "v": 1, "type": "login" | "totp" | "note" | "card" | "wifi" | "identity", "title", "fav",
"notes", "urls": [], "apps": [], "fields": {}, "custom": [{ "name", "value", "secret" }] }`) is defined in
client-core; apps keep keys they do not know. `fields` per type — login: `username`, `password`, `totp`; card:
`holder`, `number`, `expiry`, `cvc`, `pin`; wifi: `ssid`, `password`, `security`; identity: `name`, `email`,
`phone`, `address`, `birthday`. The server never sees it. `rev` in the AD is the revision the save
creates (`baseRev + 1`), so an app rejects an entry the server hands back under another revision, vault or id; it
also never accepts a lower `rev` than the one it already has.

**Recovery key** (as shown and typed): the 32 bytes plus 3 check bytes (the first 3 of BLAKE2b-256 of the key) in
Crockford base32 — 56 characters in 14 groups of 4 joined by dashes (`7KQ2-M9ZD-…`). Apps accept lower case, spaces and dashes, and read `O` as `0`,
`I` / `L` as `1`; a wrong check refuses the key before any decryption.

**Safety number** (to compare a person's key before sharing, mockups A8 / W3): `SHA-256("gcv1:fingerprint:" ‖
publicKey)`; the 32-byte hash as 8 big-endian 4-byte words, each `mod 100000`, zero-padded to 5 digits — 8 groups
like `48213 90577 …`. Both sides compute it from the `publicKey` the server hands out; if they match, the server
did not swap the key.

## Portal-Tab

`ui.portal` (1.1.0): the tab "Vault" in the portal is the whole password manager in the browser — set up (recovery key
shown, copied or saved as a text file with `GC.saveFile`, confirmed before `POST account`), unlock (master password, or
the recovery key → a new password and a new recovery key), vaults with counts, search, favourites, the detail per type
(secrets masked until shown, copy, 2FA code with countdown, Wi-Fi QR code), edit / create all six types with custom
fields and the generator, trash, history, vaults and members (the safety number before adding someone), emergency
access (trusted people, requests, a released vault opened read-only), a new master password, import (the formats of
`parseImport`) and a plaintext CSV export (after a warning, a checkbox and the master password once more).

* **Only for a signed-in person** — `render` gets the viewer; device trust only (`loggedIn: false`) or a kiosk device
  gets "Bitte melde dich an" and the page calls nothing; `portalVisible` hides the tab on a kiosk device.
* **Everything inline** (`server/ui.js`): the frame CSP allows only inline scripts — no external script and no
  WebAssembly, so no libsodium. `ui/vendor/noble.js` is one minified IIFE (`window.VaultNoble`) of
  [@noble/hashes](https://github.com/paulmillr/noble-hashes) 1.8.0 (Argon2id, BLAKE2b, SHA-1/256/512, HMAC),
  [@noble/ciphers](https://github.com/paulmillr/noble-ciphers) 1.3.0 (XChaCha20-Poly1305, XSalsa20-Poly1305, HSalsa20),
  [@noble/curves](https://github.com/paulmillr/noble-curves) 1.9.7 (X25519), [uqr](https://github.com/unjs/uqr)
  0.1.2 (making QR codes) — all MIT — and, since 1.2.0, [jsQR](https://github.com/cozmo/jsQR) 1.4.0 (reading QR
  codes, `VaultNoble.qrDecode`; Apache-2.0, the full licence in `ui/vendor/LICENSE-jsqr.txt`, packed with it); the
  notices at the top of the file. `ui/crypto.js` (`window.VaultCrypto`) is the
  client-core `vault-crypto` API on top of it: `crypto_box_seal` = X25519 with an ephemeral key, HSalsa20 →
  XSalsa20-Poly1305, nonce BLAKE2b-192(epk ‖ pk); Argon2id runs as `argon2idAsync`, which the bundle patches to yield
  to the page with a macrotask every 25 ms (noble 1.8.0 yields only a microtask: no repaint, input or timer would
  run) — with progress, ~3 s for 64 MiB / 3 passes on a desktop. The tab refuses an account whose `kdf.m` is above
  256 MiB (`kdf_too_large`, "open it in the app"): the server allows 1 GiB, which would make a tab run out of memory.
  Every path that runs Argon2id while unlocked works on a copy of the user key and sends nothing when the tab was
  locked meanwhile. `test/crypto.test.js` checks every vector of
  `test/fixtures/vault-vectors.json` (a copy of client-core's) and a box libsodium opened (`fixtures/portal-seal.json`).
* **Keys only in memory.** The frame has no storage; nothing is kept. The tab locks after 5 minutes without input,
  on "Jetzt sperren" and when it is closed: keys are zeroed, the decrypted entries, toasts and the DOM that showed them
  dropped; a sync still running for the earlier session is ignored. Not while a recovery key is on screen (setup,
  recovery): copying it down may take longer. Like the setup, a recovery sends the new password and recovery key
  (`PUT account`) only after "Ich habe ihn sicher aufbewahrt" — until then the old recovery key stays valid.
* **2FA from a QR code (1.2.0):** next to the 2FA key of a login or a "2FA-Code" entry, "QR-Code aus Bild" opens a
  panel: "Bild wählen…" (`<input type=file accept=image/*>`), a screenshot pasted with Ctrl+V (`paste`,
  `clipboardData.items`) or a picture dropped anywhere on the tab while the panel is open (dragged text still goes into
  the field it is dropped on). The picture is decoded with `createImageBitmap` (else `FileReader` → a `data:` image,
  which the frame CSP allows), drawn on a canvas, read with `getImageData` (longer side 1280 px, then 2560 px for big
  screenshots with a small code) and handed to jsQR. Nothing leaves the tab and nothing is kept: the bitmap is closed,
  the pixels are zeroed, the canvas is emptied, the file input reset; a result that arrives after a lock (`S.epoch`)
  or after the panel was closed is dropped. `VaultLogic.qrTotp` takes only `otpauth://totp` with a readable key (the
  whole link goes into the field; the title from the issuer and, for a login, the user name from the account when
  they are empty); `otpauth://hotp` → "HOTP wird nicht unterstützt"; other codes → "Kein 2FA-QR-Code im Bild
  gefunden". Google Authenticator's export (`otpauth-migration://offline?data=…`, protobuf `MigrationPayload`, up to
  100 accounts per code) lists its accounts to pick one; HOTP and MD5 accounts are shown, not selectable.
  **No camera:** GateControl's `ui.camera` (1.188.0) gives the frame `allow="camera *"`, but Chromium refuses
  `getUserMedia` to a sandboxed frame without `allow-same-origin` — its origin is opaque ("SecurityError: Invalid
  security origin"; checked with Chromium 141), so Vault does not ask for that permission. A camera would need the
  host to scan on its own page (e.g. a `GC.scanQr()` that opens the camera in GateControl's origin and hands the frame
  only the decoded text).
* **Export:** plain CSV (UTF-8 with BOM); a value a spreadsheet would run as a formula (starting with `= + - @`, tab,
  CR) gets a leading `'` — not in the password and 2FA columns, which stay exactly as they are. Vault's importer
  recognises its own export and takes the `'` off again.
* **Online only:** `GET sync` pages fill an encrypted copy in memory (smaller pages when an answer is too large for
  the host), every minute again; saves go straight to `POST items` (device `Portal`). `conflict` → the newer version is
  loaded and the person chooses "Meine Fassung speichern" (on top of it; the other stays in the history) or "Als Kopie
  speichern". `stale_key` → sync (the vault's `pending` key), encrypt again, retry once. A save during a key change uses
  `pending.keyRev`; the key change itself (`rekey/*`) is left to the apps; renaming and members wait for it (`rekeying`).
* **Clipboard and links:** copying uses a hidden text area + `execCommand('copy')` (works in the sandbox during the
  click), then `navigator.clipboard` if the host allows it; the frame cannot clear the clipboard afterwards. A sandbox
  without `allow-popups` opens no new tab, so web addresses are shown (selectable, with "Kopieren"), not linked.

### Rebuilding `ui/vendor/noble.js`

`sh plugins/gatecontrol-vault/test/vendor-build/build.sh` copies `package.json` + `package-lock.json` (pinned versions
with integrity hashes) into a temporary folder, runs `npm ci` there (never in the repository), bundles `entry.mjs`
with esbuild (`build.mjs`: the one patch above; the build fails if the patched line is not found) and writes the file
with the licence notices, plus jsQR's `LICENSE` as `ui/vendor/LICENSE-jsqr.txt`. Two builds give the same bytes. It lives under `test/`, so it is not packed into the
.gcplugin. Then run the tests — the vectors must still pass.

## Tests

`GATECONTROL_DIR=… node --test plugins/gatecontrol-vault/test/*.test.js` (or `node tools/test.js gatecontrol-vault`).

The 2FA QR code (1.2.0): `test/qr-image.js` draws QR codes with the bundled encoder (uqr) as RGBA pixels;
`logic.test.js` reads them back with the bundled decoder (jsQR) and checks `qrTotp` (TOTP, HOTP, other codes, Google
Authenticator exports built with a small protobuf writer); `portal.test.js` hands such pictures to the real page
through a fake `createImageBitmap` / canvas (chosen file, paste, drop, a lock while reading). In a real browser:
Portal › Vault › Neu › Login › „QR-Code aus Bild“ — a PNG screenshot of a 2FA QR code chosen, pasted with Ctrl+V and
dropped is read within a moment; the key, the title and the user name are filled in.
