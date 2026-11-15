-- Messenger 1.15.0: files and pictures over a bridge (server/bridgemedia.js). A contact's file arrives as a reference of
-- GateControl first (a placeholder, never an address); it is fetched into the media of this plugin afterwards, then the
-- message becomes a normal picture / voice message / file. Pictures of chats and contacts the same way.

-- 'wait': the file of this message is still to be fetched (the reference lies in the message's sealed meta); NULL otherwise
ALTER TABLE messages ADD COLUMN ext_media TEXT;
CREATE INDEX messages_ext_media ON messages (ext_media) WHERE ext_media IS NOT NULL;

-- The picture of a bridged chat: the reference the bridge names now, and the one avatar_media_id was fetched from
ALTER TABLE conversations ADD COLUMN bridge_avatar TEXT;
ALTER TABLE conversations ADD COLUMN bridge_avatar_got TEXT;

-- A contact's picture: the same, fetched only once somebody looks at it (avatar_want)
ALTER TABLE bridge_contacts ADD COLUMN avatar_ref TEXT;
ALTER TABLE bridge_contacts ADD COLUMN avatar_got TEXT;
ALTER TABLE bridge_contacts ADD COLUMN avatar_media_id TEXT;
ALTER TABLE bridge_contacts ADD COLUMN avatar_want INTEGER NOT NULL DEFAULT 0;
