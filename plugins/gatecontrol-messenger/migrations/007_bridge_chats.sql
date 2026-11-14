-- Messenger 1.14.0: chats over a bridge to another messenger (server/bridgechats.js). A bridged chat is a normal
-- conversation row with exactly ONE member — the person whose account is linked — plus where it comes from. The
-- people on the other side are no GateControl accounts: they are that person's contacts (bridge_contacts), known
-- by a reference GateControl makes up (never a phone number, never an address of the bridge).

ALTER TABLE conversations ADD COLUMN bridge_net TEXT;                    -- 'whatsapp' for a bridged chat, else NULL
ALTER TABLE conversations ADD COLUMN bridge_ref TEXT;                    -- GateControl's reference of the chat
ALTER TABLE conversations ADD COLUMN bridge_owner INTEGER;               -- the linked person (the only member)
ALTER TABLE conversations ADD COLUMN bridge_closed INTEGER NOT NULL DEFAULT 0; -- 1: the account left the chat at the service
CREATE UNIQUE INDEX conversations_bridge ON conversations (bridge_owner, bridge_net, bridge_ref) WHERE bridge_net IS NOT NULL;

-- A person's contacts at another messenger. The name is what the bridge calls them (encrypted like every text).
CREATE TABLE bridge_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL,
  network TEXT NOT NULL,
  ref TEXT NOT NULL,
  name_enc TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE (owner_id, network, ref)
);

ALTER TABLE messages ADD COLUMN ext_sender INTEGER;   -- bridge_contacts.id: a contact wrote it (sender_id NULL)
ALTER TABLE messages ADD COLUMN ext_event TEXT;       -- the bridge's id of the message (unique per chat: nothing twice)
ALTER TABLE messages ADD COLUMN ext_state TEXT;       -- the person's own messages: pending | sent | delivered | read | failed
ALTER TABLE messages ADD COLUMN ext_reason TEXT;      -- why it failed (a word)
CREATE UNIQUE INDEX messages_ext ON messages (conv_id, ext_event) WHERE ext_event IS NOT NULL;

-- Reactions of contacts (reactions holds those of GateControl accounts) and the bridge's id of each reaction,
-- which is what "take it back" names.
CREATE TABLE bridge_reactions (
  msg_id INTEGER NOT NULL,
  contact_id INTEGER NOT NULL,
  emoji TEXT NOT NULL,
  ext_event TEXT,
  at INTEGER NOT NULL,
  PRIMARY KEY (msg_id, contact_id)
);
CREATE INDEX bridge_reactions_ext ON bridge_reactions (ext_event);
ALTER TABLE reactions ADD COLUMN ext_event TEXT;

-- What arrived before the message it belongs to (an edit, a reaction, a deletion, the bridge's word on a sent
-- message): kept until the message is there, at most a day.
CREATE TABLE bridge_pending (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id INTEGER NOT NULL,
  target TEXT NOT NULL,
  data_enc TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX bridge_pending_target ON bridge_pending (conv_id, target);
