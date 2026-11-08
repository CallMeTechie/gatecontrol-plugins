-- Mail 1.11.0: „Notizen & Aufgaben“ (gatecontrol-notizen) — „Zu tun“ of the AI and flagged mails as its items
-- (server/todohub.js, server/notizen.js).

-- What the hub got: one row per item id, the hash of the item as it went out and when (only real changes are pushed).
CREATE TABLE todo_sent (
  id   TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  at   INTEGER NOT NULL
);

-- Ticked off: a to-do of the AI ('todo:<messageId>:<key>' — key: a short hash of its kind and text) in Mail or the hub,
-- a flagged mail the hub ticked off ('flag:<messageId>', the flag cleared; kept a day so the hub can undo it).
CREATE TABLE todo_done (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  at         INTEGER NOT NULL
);
CREATE INDEX todo_done_message ON todo_done (message_id);

-- the items: the flagged mails of a person (newest first) and the AI's results of the last days
CREATE INDEX messages_flagged ON messages (user_id, date) WHERE flagged = 1;
CREATE INDEX ai_results_at ON ai_results (at);
