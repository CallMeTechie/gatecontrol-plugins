-- Drive 1.9.0: vault folders, end-to-end encrypted (server/vault.js — the server keeps ciphertext, public keys and
-- wrapped keys only), and office in the browser (server/office.js — the WOPI host's locks).

-- A vault: id chosen by the creating device (22 characters base64url; part of every encrypted name, wrap and file
-- header), node_id its folder, key_version the current vault key (1, 2, … — a rotation adds one), recovery_pub the
-- X25519 public key of the recovery key (raw, base64url), recovery_auth the SHA-256 (hex) of the recovery key's proof
-- (HKDF of the key — a device that opens the vault with it approves itself only with this proof), recovery_by the person
-- it was shown to, needs_rotation: someone lost access since the last key.
CREATE TABLE vaults (
  id             TEXT PRIMARY KEY,
  node_id        INTEGER NOT NULL UNIQUE,
  area_id        TEXT NOT NULL,
  key_version    INTEGER NOT NULL DEFAULT 1,
  recovery_pub   TEXT NOT NULL,
  recovery_auth  TEXT NOT NULL,
  recovery_by    INTEGER,
  needs_rotation INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  created_by     INTEGER,
  rotated_at     INTEGER,
  rotated_by     INTEGER
);

-- A device of a person in a vault: device_id = base64url(SHA-256("gcdrive-v1:device:" ‖ public key)[0..16]),
-- public_key its X25519 key (raw, base64url), state pending (asked) | approved | revoked, via create | device | recovery.
CREATE TABLE vault_devices (
  vault_id    TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  user_id     INTEGER NOT NULL,
  public_key  TEXT NOT NULL,
  name        TEXT,
  platform    TEXT,
  state       TEXT NOT NULL DEFAULT 'pending',
  created_at  INTEGER NOT NULL,
  approved_at INTEGER,
  approved_by INTEGER,
  via         TEXT,
  revoked_at  INTEGER,
  seen_at     INTEGER,
  PRIMARY KEY (vault_id, device_id)
);
CREATE INDEX vault_devices_user ON vault_devices (user_id, state);

-- The vault key of each version wrapped for one device (device_id 'recovery': for the recovery key).
CREATE TABLE vault_wraps (
  vault_id    TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  wrap        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  created_by  INTEGER,
  PRIMARY KEY (vault_id, device_id, key_version)
);

-- Nodes of a vault (its folder and everything below it): the vault, the encrypted name (the plain `name` is opaque, 32
-- hex characters) and the key version of the content.
ALTER TABLE nodes ADD COLUMN vault_id TEXT;
ALTER TABLE nodes ADD COLUMN name_cipher TEXT;
ALTER TABLE nodes ADD COLUMN key_version INTEGER;
CREATE INDEX nodes_vault ON nodes (vault_id) WHERE vault_id IS NOT NULL;
-- the time travel brings an encrypted name back too
ALTER TABLE node_log ADD COLUMN name_cipher TEXT;

-- WOPI locks of an office server on a file (office.js): the lock string, until expires_at (30 minutes; RefreshLock
-- extends). Rows go with the node (purge) or when they expired.
CREATE TABLE office_locks (
  node_id    INTEGER PRIMARY KEY,
  lock       TEXT NOT NULL,
  user_id    INTEGER,
  at         INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
