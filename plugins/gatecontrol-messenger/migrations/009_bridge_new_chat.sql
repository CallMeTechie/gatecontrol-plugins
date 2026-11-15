-- Messenger 1.16.0: a new chat by number in the apps and the portal (server/bridges.js).

-- Parents' second switch per child and network: may the child start NEW chats by phone number (default off)? Answers in
-- chats that exist stay as they are. Only with the grant itself — taking WhatsApp back deletes the row and this with it.
ALTER TABLE bridge_grants ADD COLUMN new_chat INTEGER NOT NULL DEFAULT 0;

-- A chat started by number here: a keyed hash of the number (HMAC with the plugin's key, never the number itself), so
-- that asking for the same number again says „Ihr habt schon einen Chat“ without asking the service. Cleared when the
-- person unlinks the service.
ALTER TABLE conversations ADD COLUMN bridge_num TEXT;
CREATE INDEX conversations_bridge_num ON conversations (bridge_owner, bridge_net, bridge_num) WHERE bridge_num IS NOT NULL;
