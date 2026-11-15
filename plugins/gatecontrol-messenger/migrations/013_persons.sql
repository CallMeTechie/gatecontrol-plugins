-- Messenger 1.21.0: persons (chats v2, part B — server/persons.js). Two or more chats with ONE person — the chat with a
-- GateControl account and the WhatsApp chat with the same human, later Signal or Telegram — show as one chat with a
-- shared history. Only in the view of the person who merged them (owner_id): nobody else sees a row of this, the
-- messages stay where they are (a way is a conversation), and splitting them again loses nothing. Groups never.

CREATE TABLE persons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL,          -- whose view it is
  user_id INTEGER,                    -- the GateControl account of the person (NULL: bridged chats only)
  name_from INTEGER,                  -- NULL: the account's name; else the conversation (way) whose name is shown
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX persons_owner ON persons (owner_id);
CREATE UNIQUE INDEX persons_user ON persons (owner_id, user_id) WHERE user_id IS NOT NULL;

-- The ways of a person: one conversation each (a direct chat inside GateControl or a bridged direct chat).
CREATE TABLE person_ways (
  owner_id INTEGER NOT NULL,
  conv_id INTEGER NOT NULL,
  person_id INTEGER NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, conv_id)
);
CREATE INDEX person_ways_person ON person_ways (person_id);

-- Suggestions: "this bridged chat may be that account" (gc.bridges.matchAccounts — the server compares, the plugin only
-- learns the pairing). state: open | later (hidden until `until`) | never (not suggested again).
CREATE TABLE person_hints (
  owner_id INTEGER NOT NULL,
  conv_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  network TEXT NOT NULL,
  strength TEXT NOT NULL,             -- strong | medium
  via TEXT NOT NULL,                  -- own_whatsapp | profile_phone
  state TEXT NOT NULL DEFAULT 'open',
  until INTEGER,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, conv_id, user_id)
);

-- the shared history is ordered by time across conversations
CREATE INDEX messages_conv_time ON messages (conv_id, created_at, id);
