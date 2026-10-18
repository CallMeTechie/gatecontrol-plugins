-- gatecontrol-messenger 1.4.0: status and stories, preferences (privacy, notifications, chats), blocks,
-- archive, pinned messages, chat lists, reminders, polls, events, live arrival, home actions and plugin cards.
-- Times are milliseconds since the epoch. Texts (status texts, story texts, list names, poll / event /
-- arrival / action details, positions, card pictures) are stored encrypted like the message texts (*_enc).

-- messages: the new kinds. A CHECK cannot be changed in place, so the table is rebuilt with the same
-- columns and rows; the AUTOINCREMENT counter is carried over (ids of deleted messages are never reused).
CREATE TABLE messages_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id INTEGER NOT NULL,
  sender_id INTEGER,
  client_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('text', 'image', 'voice', 'file', 'location', 'system', 'poll', 'event', 'arrival', 'action', 'card')),
  body_enc TEXT,
  reply_to INTEGER,
  media_id TEXT,
  thumb_media_id TEXT,
  meta_enc TEXT,
  via TEXT,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted_at INTEGER,
  expires_at INTEGER,
  updated_at INTEGER NOT NULL
);
INSERT INTO messages_new (id, conv_id, sender_id, client_id, kind, body_enc, reply_to, media_id, thumb_media_id, meta_enc, via, created_at, edited_at, deleted_at, expires_at, updated_at)
  SELECT id, conv_id, sender_id, client_id, kind, body_enc, reply_to, media_id, thumb_media_id, meta_enc, via, created_at, edited_at, deleted_at, expires_at, updated_at FROM messages;
INSERT INTO sqlite_sequence (name, seq)
  SELECT 'messages_new', seq FROM sqlite_sequence WHERE name = 'messages'
  AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'messages_new');
UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT s.seq FROM sqlite_sequence s WHERE s.name = 'messages'), 0)) WHERE name = 'messages_new';
DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;
CREATE UNIQUE INDEX messages_client ON messages (conv_id, sender_id, client_id);
CREATE INDEX messages_conv ON messages (conv_id, id);
CREATE INDEX messages_expires ON messages (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX messages_created ON messages (created_at);
CREATE INDEX messages_updated ON messages (conv_id, updated_at);

-- media: story files (role story / story_thumb, conv_id 0, story_id set)
CREATE TABLE media_new (
  media_id TEXT PRIMARY KEY,
  conv_id INTEGER NOT NULL DEFAULT 0,
  msg_id INTEGER,
  story_id INTEGER,
  role TEXT NOT NULL CHECK (role IN ('file', 'thumb', 'avatar', 'story', 'story_thumb')),
  kind TEXT NOT NULL,
  mime TEXT,
  bytes INTEGER NOT NULL DEFAULT 0,
  owner_id INTEGER,
  orphan INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
INSERT INTO media_new (media_id, conv_id, msg_id, role, kind, mime, bytes, owner_id, orphan, created_at)
  SELECT media_id, conv_id, msg_id, role, kind, mime, bytes, owner_id, orphan, created_at FROM media;
DROP TABLE media;
ALTER TABLE media_new RENAME TO media;
CREATE INDEX media_msg ON media (msg_id);
CREATE INDEX media_conv ON media (conv_id);
CREATE INDEX media_story ON media (story_id) WHERE story_id IS NOT NULL;

ALTER TABLE members ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN pins TEXT;          -- JSON [message id] (at most 3)
ALTER TABLE prefs ADD COLUMN ext TEXT;                   -- JSON { privacy, notify, chats } (no content)
ALTER TABLE prefs ADD COLUMN digest_at INTEGER;          -- last daily story digest

-- one status per person
CREATE TABLE statuses (
  user_id INTEGER PRIMARY KEY,
  preset TEXT NOT NULL CHECK (preset IN ('none', 'homeoffice', 'away', 'dnd', 'auto_place')),
  text_enc TEXT,
  until INTEGER,
  visibility TEXT NOT NULL CHECK (visibility IN ('all', 'family', 'custom')),
  user_ids TEXT,                          -- JSON [user id] for custom
  eta INTEGER,
  dest_enc TEXT,                          -- away: destination label
  place_enc TEXT,                         -- auto_place: the place Familie reported (set_place_status)
  updated_at INTEGER NOT NULL
);

CREATE TABLE stories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('text', 'image', 'video')),
  body_enc TEXT,                          -- JSON { text, bg, font, video, place } (encrypted)
  media_id TEXT,
  thumb_media_id TEXT,
  visibility TEXT NOT NULL CHECK (visibility IN ('all', 'family', 'custom')),
  user_ids TEXT,
  event_msg_id INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX stories_user ON stories (user_id, expires_at);
CREATE INDEX stories_expires ON stories (expires_at);

CREATE TABLE story_views (
  story_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  seen_at INTEGER NOT NULL,
  reaction TEXT,
  PRIMARY KEY (story_id, user_id)
);

CREATE TABLE blocks (
  user_id INTEGER NOT NULL,
  blocked_id INTEGER NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (user_id, blocked_id)
);
CREATE INDEX blocks_blocked ON blocks (blocked_id);

CREATE TABLE lists (
  user_id INTEGER PRIMARY KEY,
  data_enc TEXT,                          -- JSON [{ id, name, conversationIds }] (encrypted)
  updated_at INTEGER NOT NULL
);

CREATE TABLE reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  conv_id INTEGER NOT NULL,
  msg_id INTEGER NOT NULL,
  at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE INDEX reminders_due ON reminders (sent_at, at);
CREATE INDEX reminders_user ON reminders (user_id);
CREATE INDEX reminders_msg ON reminders (msg_id);

-- polls: question and options in messages.meta_enc; here what the background run and the votes need
CREATE TABLE polls (
  msg_id INTEGER PRIMARY KEY,
  conv_id INTEGER NOT NULL,
  creator_id INTEGER NOT NULL,
  multi INTEGER NOT NULL DEFAULT 0,
  anonymous INTEGER NOT NULL DEFAULT 0,
  allow_add INTEGER NOT NULL DEFAULT 0,
  closes_at INTEGER,
  closed_at INTEGER,
  nudged_at INTEGER
);
CREATE INDEX polls_closes ON polls (closed_at, closes_at);

CREATE TABLE poll_votes (
  msg_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  option_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (msg_id, user_id, option_id)
);

-- events: title, place, description and checklist texts in messages.meta_enc
CREATE TABLE events (
  msg_id INTEGER PRIMARY KEY,
  conv_id INTEGER NOT NULL,
  creator_id INTEGER NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER,
  all_day INTEGER NOT NULL DEFAULT 0,
  rsvp INTEGER NOT NULL DEFAULT 1,
  guests INTEGER NOT NULL DEFAULT 0,
  reminder_min INTEGER NOT NULL DEFAULT 0,
  family_calendar INTEGER NOT NULL DEFAULT 0,
  departure_hint INTEGER NOT NULL DEFAULT 0,
  cancelled INTEGER NOT NULL DEFAULT 0,
  reminded_at INTEGER,
  departed_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX events_conv ON events (conv_id, starts_at);
CREATE INDEX events_starts ON events (starts_at);

CREATE TABLE event_rsvps (
  msg_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  answer TEXT NOT NULL CHECK (answer IN ('yes', 'maybe', 'no')),
  guests INTEGER NOT NULL DEFAULT 0,
  at INTEGER NOT NULL,
  PRIMARY KEY (msg_id, user_id)
);

CREATE TABLE event_checks (
  msg_id INTEGER NOT NULL,
  item_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (msg_id, item_id)
);

-- live arrival: the destination in messages.meta_enc, the last position here (encrypted, only while live)
CREATE TABLE arrivals (
  msg_id INTEGER PRIMARY KEY,
  conv_id INTEGER NOT NULL,
  sender_id INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('live', 'arrived', 'stopped')),
  radius_m INTEGER NOT NULL,
  start_dist REAL,
  distance_m REAL,
  eta_at INTEGER,
  speed_mps REAL,
  progress REAL,
  pos_enc TEXT,
  last_at INTEGER,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX arrivals_state ON arrivals (state, started_at);

-- home actions (message kind action) and the buttons of plugin cards (kind card)
CREATE TABLE action_msgs (
  msg_id INTEGER PRIMARY KEY,
  conv_id INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('run', 'request', 'grant', 'card')),
  plugin TEXT,
  action_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('open', 'done', 'denied', 'expired')),
  owner_id INTEGER,                       -- sender (request: who asks; grant: who grants)
  grant_to INTEGER,
  grant_until INTEGER,
  approver_ids TEXT,                      -- JSON [user id]
  by_id INTEGER,                          -- who ran / approved / denied last
  result_enc TEXT,                        -- JSON { ok, message, state } of the last run (encrypted)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX action_msgs_state ON action_msgs (state, mode);

CREATE TABLE card_images (
  msg_id INTEGER PRIMARY KEY,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  data_enc TEXT NOT NULL                  -- base64 of the picture (encrypted)
);
