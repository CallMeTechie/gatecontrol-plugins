-- GateControl Mail 1.0.0 — the server's copy of the mail accounts of the people (headers, flags, bodies within the
-- quota), drafts, the outbox, AI results and what was filed in Drive. Credentials never lie here: they are secrets of
-- the plugin (gc.settings.setSecret 'acct.<id>').

-- The person's view settings (PUT settings).
CREATE TABLE prefs (
  user_id     INTEGER PRIMARY KEY,
  threads     INTEGER NOT NULL DEFAULT 1,
  swipe_left  TEXT NOT NULL DEFAULT 'archive',
  swipe_right TEXT NOT NULL DEFAULT 'read',
  updated_at  INTEGER NOT NULL
);

-- Mail accounts: provider gmx | webde | tonline | gmail | outlook | m365 | imap; state ok | syncing | auth_failed |
-- unreachable; push off | relevant | all; attachments off | suggest | auto.
CREATE TABLE accounts (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL,
  provider      TEXT NOT NULL,
  email         TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  color         TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'personal',
  username      TEXT,
  imap_host     TEXT,
  imap_port     INTEGER,
  imap_security TEXT,
  smtp_host     TEXT,
  smtp_port     INTEGER,
  smtp_security TEXT,
  ms_tenant     TEXT,
  state         TEXT NOT NULL DEFAULT 'syncing',
  error_code    TEXT,
  error_at      INTEGER,
  push          TEXT NOT NULL DEFAULT 'relevant',
  ai            INTEGER NOT NULL DEFAULT 1,
  attachments   TEXT NOT NULL DEFAULT 'suggest',
  signature     TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  synced_at     INTEGER,
  first_done    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX accounts_user ON accounts (user_id);

-- Folders of an account. role inbox | sent | drafts | archive | junk | trash | all | null; remote_id: Graph's folder id;
-- uid_validity / uid_next / modseq: IMAP; low_uid: the first sync goes on below it (newest first); delta: Graph's
-- deltaLink (or the nextLink of an unfinished round); complete: nothing older on the server.
CREATE TABLE folders (
  id           INTEGER PRIMARY KEY,
  account_id   INTEGER NOT NULL,
  path         TEXT NOT NULL,
  name         TEXT NOT NULL,
  delim        TEXT,
  parent_id    INTEGER,
  role         TEXT,
  remote_id    TEXT,
  uid_validity INTEGER,
  uid_next     INTEGER,
  modseq       TEXT,
  delta        TEXT,
  remote_total INTEGER,
  remote_unread INTEGER,
  low_uid      INTEGER,
  synced_at    INTEGER,
  complete     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (account_id, path)
);

-- Messages (headers and flags; the body in `bodies`). tab relevant | other, tab_by rule | ai | learned | user.
CREATE TABLE messages (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL,
  account_id   INTEGER NOT NULL,
  folder_id    INTEGER NOT NULL,
  uid          INTEGER,
  remote_id    TEXT,
  message_id   TEXT,
  in_reply_to  TEXT,
  refs         TEXT,
  conv         TEXT,
  thread_id    INTEGER,
  date         INTEGER NOT NULL,
  from_name    TEXT NOT NULL DEFAULT '',
  from_email   TEXT NOT NULL DEFAULT '',
  to_json      TEXT NOT NULL DEFAULT '[]',
  cc_json      TEXT NOT NULL DEFAULT '[]',
  bcc_json     TEXT NOT NULL DEFAULT '[]',
  reply_to_json TEXT NOT NULL DEFAULT '[]',
  subject      TEXT NOT NULL DEFAULT '',
  snippet      TEXT NOT NULL DEFAULT '',
  unread       INTEGER NOT NULL DEFAULT 1,
  flagged      INTEGER NOT NULL DEFAULT 0,
  answered     INTEGER NOT NULL DEFAULT 0,
  has_att      INTEGER NOT NULL DEFAULT 0,
  size         INTEGER NOT NULL DEFAULT 0,
  tab          TEXT NOT NULL DEFAULT 'relevant',
  tab_by       TEXT,
  list_id      TEXT,
  bulk         INTEGER NOT NULL DEFAULT 0,
  unsub_json   TEXT,
  body_state   TEXT NOT NULL DEFAULT 'none',
  ai_pending   INTEGER NOT NULL DEFAULT 0,
  notified     INTEGER NOT NULL DEFAULT 0,
  filed        INTEGER NOT NULL DEFAULT 0,
  seen_at      INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX messages_uid ON messages (folder_id, uid) WHERE uid IS NOT NULL;
CREATE UNIQUE INDEX messages_remote ON messages (folder_id, remote_id) WHERE remote_id IS NOT NULL;
CREATE INDEX messages_list ON messages (folder_id, date DESC, id DESC);
CREATE INDEX messages_thread ON messages (thread_id);
CREATE INDEX messages_msgid ON messages (user_id, message_id);
CREATE INDEX messages_user ON messages (user_id, date);

-- The body of a message: the sanitized HTML (external pictures as gc-img:<n>, see images), the text, its size (the quota).
CREATE TABLE bodies (
  message_id  INTEGER PRIMARY KEY,
  html        TEXT,
  text        TEXT,
  images_json TEXT NOT NULL DEFAULT '[]',
  trackers    INTEGER NOT NULL DEFAULT 0,
  bytes       INTEGER NOT NULL,
  at          INTEGER NOT NULL,
  used_at     INTEGER NOT NULL
);

-- Attachments of a message; media_id: the cached copy in the plugin's media (LRU over the quota); saved_*: where it went in
-- Drive; suggestion_json: Drive's suggest_folder; drive_media: the copy handed over to Drive for suggest/save (24 h).
CREATE TABLE attachments (
  id            INTEGER PRIMARY KEY,
  message_id    INTEGER NOT NULL,
  part_id       TEXT,
  remote_id     TEXT,
  name          TEXT NOT NULL,
  mime          TEXT NOT NULL,
  size          INTEGER NOT NULL DEFAULT 0,
  inline        INTEGER NOT NULL DEFAULT 0,
  cid           TEXT,
  checksum      TEXT,
  media_id      TEXT,
  media_bytes   INTEGER,
  used_at       INTEGER,
  saved_node    INTEGER,
  saved_where   TEXT,
  suggestion_json TEXT,
  duplicate     INTEGER NOT NULL DEFAULT 0,
  drive_media   TEXT,
  drive_media_at INTEGER
);
CREATE INDEX attachments_message ON attachments (message_id);

-- External pictures allowed per sender (POST messages/<id>/images { allow: 'sender' }) and per message (once).
CREATE TABLE image_senders (
  user_id INTEGER NOT NULL,
  sender  TEXT NOT NULL,
  at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, sender)
);
CREATE TABLE image_once (
  message_id INTEGER PRIMARY KEY,
  at         INTEGER NOT NULL
);

-- Learned per sender: the tab (POST messages/tab).
CREATE TABLE senders (
  user_id INTEGER NOT NULL,
  address TEXT NOT NULL,
  tab     TEXT NOT NULL,
  at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, address)
);

-- Addresses the person wrote to or got mail from (GET contacts; "bekannte Kontakte" of the sorting).
CREATE TABLE contacts (
  user_id  INTEGER NOT NULL,
  email    TEXT NOT NULL,
  name     TEXT NOT NULL DEFAULT '',
  sent     INTEGER NOT NULL DEFAULT 0,
  received INTEGER NOT NULL DEFAULT 0,
  last_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, email)
);

-- Drafts and their attachments. kind media (from a device, claimed) | message (forwarded) | drive (copy or link).
CREATE TABLE drafts (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  account_id  INTEGER NOT NULL,
  to_json     TEXT NOT NULL DEFAULT '[]',
  cc_json     TEXT NOT NULL DEFAULT '[]',
  bcc_json    TEXT NOT NULL DEFAULT '[]',
  subject     TEXT NOT NULL DEFAULT '',
  html        TEXT NOT NULL DEFAULT '',
  reply_msg   INTEGER,
  mode        TEXT,
  in_reply_to TEXT,
  refs        TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE TABLE draft_atts (
  id          INTEGER PRIMARY KEY,
  draft_id    INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  media_id    TEXT,
  name        TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL DEFAULT 0,
  as_link     INTEGER NOT NULL DEFAULT 0,
  url         TEXT,
  drive_node  INTEGER,
  link_days   INTEGER,
  has_password INTEGER NOT NULL DEFAULT 0,
  src_message INTEGER,
  src_att     INTEGER,
  auto_link   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX draft_atts_draft ON draft_atts (draft_id);

-- The outbox: sent 10 s after "Senden" (undo) or at send_at. state waiting | sending | failed.
CREATE TABLE outbox (
  id         INTEGER PRIMARY KEY,
  draft_id   INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  subject    TEXT NOT NULL DEFAULT '',
  send_at    INTEGER NOT NULL,
  undo_until INTEGER NOT NULL,
  state      TEXT NOT NULL DEFAULT 'waiting',
  error      TEXT,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- AI per message (GET/POST ai/<id>): summary, to-dos, replies.
CREATE TABLE ai_results (
  message_id   INTEGER PRIMARY KEY,
  summary      TEXT,
  todos_json   TEXT NOT NULL DEFAULT '[]',
  replies_json TEXT NOT NULL DEFAULT '[]',
  at           INTEGER NOT NULL
);

-- "Zum Ablegen": attachments of accounts with attachments 'auto' Drive was not sure about.
CREATE TABLE filing (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL,
  message_id    INTEGER NOT NULL,
  attachment_id INTEGER NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL
);

-- Microsoft sign-in by device code (portal): status pending | done | expired | denied.
CREATE TABLE ms_device (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  kind        TEXT,
  interval_s  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  next_at     INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  account_id  INTEGER,
  error       TEXT,
  created_at  INTEGER NOT NULL
);
