-- Drive 1.32.0: "Nur auf diesem Gerät" (server/vaultlocal.js, feature vaultLocal). A folder of a vault whose content
-- lies on one device only. The server keeps the folder as a placeholder (its opaque name and name_cipher, the same id
-- and parent) — no files, no folders below, no size. Bound to the vault device (vault_devices.device_id: the hash of
-- the device's X25519 key in the Keystore / under DPAPI) that holds the only copy.
--   state  moving     the device fetches the content (lease_until: writes below the folder wait — 409 local_moving)
--          local      only on the device (409 local_only for uploads, folders, moves and copies into it)
--          returning  the device uploads it again (only requests of gc_device, its GateControl device, may write)
--   purge_at  until then the content of the move lies hidden on the server (rows below the folder with
--             trash_id = node_id, not in any trash) and "Rückgängig" brings it back; then it goes for good
CREATE TABLE vault_local (
  node_id     INTEGER PRIMARY KEY,
  vault_id    TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  user_id     INTEGER NOT NULL,
  state       TEXT NOT NULL,
  lease_until INTEGER,
  manifest    TEXT,
  since       INTEGER NOT NULL,
  purge_at    INTEGER,
  gc_device   TEXT,
  started_at  INTEGER NOT NULL
);
CREATE INDEX vault_local_vault ON vault_local (vault_id);
CREATE INDEX vault_local_device ON vault_local (vault_id, device_id);

-- The device's proof (POST vaults/<id>/local/challenge): a random number sealed to the device's public key (HPKE, as
-- the wraps); the server keeps only its SHA-256, for 60 seconds, once.
CREATE TABLE vault_local_proofs (
  vault_id   TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  hash       TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (vault_id, device_id)
);

-- A node that was in the trash already when its folder became "nur auf diesem Gerät": its own trash batch, kept here
-- while it lies hidden with the folder (trash_id = the folder) — "Rückgängig" puts it back into the trash.
-- Adding the column writes no row.
ALTER TABLE nodes ADD COLUMN local_trash INTEGER;
