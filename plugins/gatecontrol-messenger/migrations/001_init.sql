-- gatecontrol-messenger 1.0.0: conversations, members, messages, reactions, hidden ("delete for me"),
-- per-person preferences, the media the messages use, settings and the admin log (errors and limits only).
-- Times are milliseconds since the epoch. Texts (message text, location, file names, group titles)
-- are stored encrypted (AES-256-GCM, key in the plugin's secret settings) — columns *_enc.

CREATE TABLE conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('direct', 'group')),
  direct_key TEXT UNIQUE,                 -- direct chats: '<min user id>:<max user id>'
  title_enc TEXT,                         -- group title (encrypted)
  avatar_media_id TEXT,                   -- group picture (gc.media id)
  managed_by TEXT,                        -- plugin id of a group kept by another plugin (services)
  managed_key TEXT,                       -- that plugin's key, e.g. 'family', 'user:12'
  readonly INTEGER NOT NULL DEFAULT 0,    -- 1: members read only (a plugin's notice channel)
  disappearing_s INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_msg_id INTEGER
);
CREATE UNIQUE INDEX conversations_managed ON conversations (managed_by, managed_key) WHERE managed_by IS NOT NULL;
CREATE INDEX conversations_updated ON conversations (updated_at);

CREATE TABLE members (
  conv_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  joined_at INTEGER NOT NULL,
  joined_msg_id INTEGER NOT NULL DEFAULT 0, -- the history a member sees starts after this message
  left_at INTEGER,                          -- not NULL: no longer a member
  muted_until INTEGER,
  notify TEXT NOT NULL DEFAULT 'all' CHECK (notify IN ('all', 'none')),
  last_read_id INTEGER NOT NULL DEFAULT 0,
  last_delivered_id INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conv_id, user_id)
);
CREATE INDEX members_user ON members (user_id, left_at);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id INTEGER NOT NULL,
  sender_id INTEGER,                      -- NULL: a system message ("GateControl")
  client_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('text', 'image', 'voice', 'file', 'location', 'system')),
  body_enc TEXT,                          -- text / caption (encrypted)
  reply_to INTEGER,
  media_id TEXT,
  thumb_media_id TEXT,
  meta_enc TEXT,                          -- JSON: durationMs, waveform, w, h, fileName, location, system event (encrypted)
  via TEXT,                               -- plugin id of a message sent through a service
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted_at INTEGER,                     -- deleted for everyone (tombstone)
  expires_at INTEGER,                     -- disappearing chats
  updated_at INTEGER NOT NULL             -- created, edited, deleted or a reaction changed
);
CREATE UNIQUE INDEX messages_client ON messages (conv_id, sender_id, client_id);
CREATE INDEX messages_conv ON messages (conv_id, id);
CREATE INDEX messages_expires ON messages (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX messages_created ON messages (created_at);
CREATE INDEX messages_updated ON messages (conv_id, updated_at);

CREATE TABLE reactions (
  msg_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  emoji TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (msg_id, user_id)
);

CREATE TABLE hidden (
  msg_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  PRIMARY KEY (msg_id, user_id)
);

CREATE TABLE prefs (
  user_id INTEGER PRIMARY KEY,
  read_receipts INTEGER NOT NULL,
  typing INTEGER NOT NULL,
  preview INTEGER NOT NULL,
  lang TEXT,                              -- language of the person's last request (push texts)
  kiosk INTEGER NOT NULL DEFAULT 0,       -- seen on a kiosk device: hidden from "people"
  last_seen INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE media (
  media_id TEXT PRIMARY KEY,
  conv_id INTEGER NOT NULL,
  msg_id INTEGER,                         -- NULL for a group picture
  role TEXT NOT NULL CHECK (role IN ('file', 'thumb', 'avatar')),
  kind TEXT NOT NULL,                     -- image | voice | file | avatar (storage per type)
  mime TEXT,
  bytes INTEGER NOT NULL DEFAULT 0,
  owner_id INTEGER,
  orphan INTEGER NOT NULL DEFAULT 0,      -- 1: its message is gone, the file is still to be deleted
  created_at INTEGER NOT NULL
);
CREATE INDEX media_msg ON media (msg_id);
CREATE INDEX media_conv ON media (conv_id);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('error', 'limit')),
  code TEXT NOT NULL,
  detail TEXT,
  count INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX log_at ON log (last_at);
