-- gatecontrol-vault: end-to-end encrypted vaults. Every *_enc / *_key / blob column holds data the apps encrypted
-- (base64url, see README "Kryptoformat"); the server never sees a password, a key or an entry in the clear.
-- Times are ms since the epoch. `seq` columns carry the global change counter (meta.seq) the apps sync with.

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT INTO meta (key, value) VALUES ('seq', 0);

-- One per person: how the master password becomes the master key (Argon2id), the user key wrapped by it and by the
-- recovery key, and the person's X25519 key pair (public in the clear, private wrapped by the user key).
CREATE TABLE accounts (
  user_id          INTEGER PRIMARY KEY,
  kdf_m            INTEGER NOT NULL,     -- Argon2id memory in KiB
  kdf_t            INTEGER NOT NULL,     -- iterations
  kdf_p            INTEGER NOT NULL,     -- parallelism
  kdf_salt         TEXT NOT NULL,        -- 16 bytes
  user_key_pw      TEXT NOT NULL,        -- user key, wrapped by the master key
  user_key_rk      TEXT NOT NULL,        -- user key, wrapped by the recovery key
  public_key       TEXT NOT NULL,        -- X25519, 32 bytes
  private_key_enc  TEXT NOT NULL,        -- X25519 private key, wrapped by the user key
  rev              INTEGER NOT NULL DEFAULT 1,  -- +1 on every change (password, recovery key)
  seq              INTEGER NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  seen_at          INTEGER                -- last sync
);

CREATE TABLE vaults (
  id               TEXT PRIMARY KEY,     -- chosen by the app (16–40 of [A-Za-z0-9_-])
  kind             TEXT NOT NULL,        -- 'personal' (exactly one per account, never shared) | 'shared'
  owner_id         INTEGER NOT NULL,     -- who created it
  name_enc         TEXT NOT NULL,        -- the name, encrypted with the vault key
  key_rev          INTEGER NOT NULL DEFAULT 1,   -- the vault key's generation
  pending_key_rev  INTEGER,              -- a key change in progress (rekey/start … rekey/finish)
  needs_rekey      INTEGER NOT NULL DEFAULT 0,  -- 1: someone left; a manager's app should change the key
  seq              INTEGER NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX vaults_owner ON vaults (owner_id);

-- Who may open a vault: the vault key sealed to the member's public key (crypto_box_seal).
CREATE TABLE members (
  vault_id         TEXT NOT NULL,
  user_id          INTEGER NOT NULL,
  role             TEXT NOT NULL,        -- 'read' | 'write' | 'manage'
  sealed_key       TEXT NOT NULL,        -- the key of generation vaults.key_rev
  pending_key      TEXT,                 -- the key of vaults.pending_key_rev during a key change
  added_by         INTEGER NOT NULL,
  added_at         INTEGER NOT NULL,
  seq              INTEGER NOT NULL,
  PRIMARY KEY (vault_id, user_id)
);
CREATE INDEX members_user ON members (user_id);

CREATE TABLE items (
  id               TEXT PRIMARY KEY,     -- chosen by the app; bound into the encryption (with vault and rev)
  vault_id         TEXT NOT NULL,
  rev              INTEGER NOT NULL,     -- 1, 2, … (compare-and-swap: baseRev)
  key_rev          INTEGER NOT NULL,     -- which vault key encrypted blob
  blob             TEXT,                 -- null once purged
  state            INTEGER NOT NULL DEFAULT 0,  -- 0 live, 1 in the trash, 2 purged (tombstone)
  trashed_at       INTEGER,
  seq              INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  updated_by       INTEGER NOT NULL,
  device           TEXT                  -- name of the device that saved it (shown as "geändert auf …")
);
CREATE INDEX items_vault ON items (vault_id, state);
CREATE INDEX items_seq ON items (seq);

-- Earlier versions of an entry (the last 10), encrypted like the entry.
CREATE TABLE history (
  item_id          TEXT NOT NULL,
  rev              INTEGER NOT NULL,
  key_rev          INTEGER NOT NULL,
  blob             TEXT NOT NULL,
  updated_at       INTEGER NOT NULL,
  updated_by       INTEGER NOT NULL,
  device           TEXT,
  PRIMARY KEY (item_id, rev)
);

-- Emergency access: the grantor's user key sealed to the grantee, handed out only after the waiting time
-- (or when the grantor approves early).
CREATE TABLE emergency (
  id               TEXT PRIMARY KEY,     -- 24 hex characters
  grantor_id       INTEGER NOT NULL,
  grantee_id       INTEGER NOT NULL,
  wait_hours       INTEGER NOT NULL,
  sealed_key       TEXT NOT NULL,
  status           TEXT NOT NULL,        -- 'ready' | 'requested' | 'granted'
  requested_at     INTEGER,
  granted_at       INTEGER,
  created_at       INTEGER NOT NULL,
  UNIQUE (grantor_id, grantee_id)
);
CREATE INDEX emergency_grantee ON emergency (grantee_id);

-- What happened, without content (fault finding; kept 90 days).
CREATE TABLE events (
  at               INTEGER NOT NULL,
  user_id          INTEGER NOT NULL,
  action           TEXT NOT NULL,
  vault_id         TEXT,
  item_id          TEXT
);
CREATE INDEX events_at ON events (at);

-- Language for pushes; accounts seen as a kiosk device (never a person).
CREATE TABLE people (
  user_id          INTEGER PRIMARY KEY,
  lang             TEXT,
  kiosk            INTEGER NOT NULL DEFAULT 0,
  seen_at          INTEGER
);
