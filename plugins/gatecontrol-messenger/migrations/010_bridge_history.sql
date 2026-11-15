-- Messenger 1.17.0: older messages over a bridge, a phone that was not seen, files kept on a storage target
-- (server/bridgehistory.js, server/bridges.js, server/bridgemedia.js).

-- A file of a message from the history is fetched only when the person asks for it (messages.ext_media = 'ask');
-- when they asked — the time a fetch may take counts from then, not from the old message.
ALTER TABLE messages ADD COLUMN ext_asked_at INTEGER;

-- The bridge's own warning „the phone was not seen for 12 days“ (WhatsApp ends the link after about 14): since when
-- it holds for this login (the bridge's time of that state), and when the person got the push for it — once per time.
ALTER TABLE bridge_links ADD COLUMN phone_offline_since INTEGER;
ALTER TABLE bridge_links ADD COLUMN phone_warned_at INTEGER;
