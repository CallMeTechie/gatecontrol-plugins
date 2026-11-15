-- Messenger 1.20.0: channels and read-only groups of a bridge (GateControl with gc.bridges version 7, server/bridgechats.js,
-- server/bridgechannels.js). A channel the person follows at the other messenger is a bridged conversation like a chat,
-- marked here: it is not listed among the chats (GET channels), takes no messages and is created muted.

ALTER TABLE conversations ADD COLUMN bridge_channel INTEGER NOT NULL DEFAULT 0;   -- 1: a channel (only the channel writes)
ALTER TABLE conversations ADD COLUMN bridge_read_only INTEGER NOT NULL DEFAULT 0; -- 1: the person may not write (channel, group of admins)

-- The picture of a link preview (meta.preview.image): 'wait' — fetched afterwards over the bridge (bridgechannels.js)
ALTER TABLE messages ADD COLUMN ext_preview TEXT;
CREATE INDEX messages_ext_preview ON messages (ext_preview) WHERE ext_preview IS NOT NULL;
