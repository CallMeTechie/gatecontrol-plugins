-- gatecontrol-gatedrop: sends (files, text, a link) of a person to people, own devices, NAS folders and public links.
-- The files themselves are GateControl media (gc.media, encrypted at rest); this database keeps their ids only.
-- Times are ms since the epoch. Media are removed 7 days after a send (background), the rows 30 days after it.

CREATE TABLE sends (
  id          TEXT PRIMARY KEY,          -- 24 hex characters
  user_id     INTEGER NOT NULL,          -- the sender
  device_id   TEXT,                      -- the sending app installation (null: the portal)
  device_name TEXT,                      -- its name when sent
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,          -- the files are removed then
  text        TEXT,                      -- ≤ 20000 characters
  link        TEXT,                      -- an http(s) URL
  note        TEXT,                      -- ≤ 500 characters
  purged      INTEGER NOT NULL DEFAULT 0 -- 1: the files are gone
);
CREATE INDEX sends_user ON sends (user_id, created_at);
CREATE INDEX sends_expiry ON sends (purged, expires_at);

CREATE TABLE items (
  send_id   TEXT NOT NULL,
  idx       INTEGER NOT NULL,            -- position in the send (0 …)
  media_id  TEXT,                        -- null while a local item (direct transfer) is not uploaded
  name      TEXT NOT NULL,
  mime      TEXT,
  bytes     INTEGER NOT NULL DEFAULT 0,
  local     INTEGER NOT NULL DEFAULT 0,  -- 1: announced for a direct transfer, not on the server (yet)
  PRIMARY KEY (send_id, idx)
);
CREATE UNIQUE INDEX items_media ON items (media_id) WHERE media_id IS NOT NULL;

CREATE TABLE deliveries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  send_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,              -- device | person | nas | link
  target     TEXT NOT NULL,              -- device id | user id | 'family' | NAS path | link token
  user_id    INTEGER,                    -- the recipient (device: its owner, person: that person)
  status     TEXT NOT NULL,              -- pending | direct | delivered | opened | failed | expired
  via        TEXT,                       -- direct | server
  at         INTEGER NOT NULL,
  error      TEXT,                       -- a code, never a text of another system
  ref        TEXT,                       -- 'chat:<conversationId>' (Messenger), the NAS file path(s)
  label      TEXT,                       -- what the sender sees: device name, person, NAS path
  members    TEXT,                       -- 'family': the recipients when it was sent, ',3,4,' (only they see it)
  gd_items   INTEGER NOT NULL DEFAULT 0, -- person: files delivered through GateDrop (too large for the Messenger)
  handed     INTEGER NOT NULL DEFAULT 0, -- files handed over to another plugin for this delivery (≤ 200 per sender and day)
  opened_at  INTEGER
);
CREATE INDEX deliveries_send ON deliveries (send_id);
CREATE INDEX deliveries_user ON deliveries (user_id, kind);

CREATE TABLE transfers (
  id               TEXT PRIMARY KEY,     -- 24 hex characters
  send_id          TEXT NOT NULL,
  delivery_id      INTEGER NOT NULL,
  from_device      TEXT,
  to_device        TEXT NOT NULL,
  mode             TEXT NOT NULL,        -- push | pull
  candidates       TEXT NOT NULL,        -- JSON ['192.168.1.20:47731']
  key              TEXT,                 -- base64, 32 bytes (AES-256-GCM); NULL once done / failed / expired
  ticket           TEXT,                 -- base64url, 32 bytes, one use; NULL once done / failed / expired
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,     -- created + 10 min
  status           TEXT NOT NULL DEFAULT 'open', -- open | done | failed | expired
  sender_result    TEXT,                 -- JSON { ok, bytes, error, at }
  receiver_result  TEXT,
  done_at          INTEGER
);
CREATE INDEX transfers_open ON transfers (status, expires_at);

CREATE TABLE presence (
  device_id  TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  lan        TEXT NOT NULL,              -- JSON [{ ip, prefix }]
  port       INTEGER,
  listening  INTEGER NOT NULL DEFAULT 0,
  at         INTEGER NOT NULL
);

CREATE TABLE links (
  token          TEXT PRIMARY KEY,
  send_id        TEXT NOT NULL,
  user_id        INTEGER NOT NULL,
  title          TEXT,
  url            TEXT,                        -- the public URL (from GateControl)
  pin            INTEGER NOT NULL DEFAULT 0,  -- 1: protected by a PIN (the PIN itself is not kept)
  max_downloads  INTEGER,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  revoked_at     INTEGER,
  downloads      INTEGER NOT NULL DEFAULT 0,
  locked         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX links_user ON links (user_id, created_at);

CREATE TABLE people (
  user_id  INTEGER PRIMARY KEY,
  lang     TEXT,
  kiosk    INTEGER NOT NULL DEFAULT 0,      -- seen as a kiosk device (wall tablet): never a recipient
  seen_at  INTEGER
);
