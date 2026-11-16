-- Messenger 1.25.0: the contacts' WhatsApp status updates in the status row (GateControl with gc.bridges version 12,
-- server/bridgestatus.js). The bridge's room of status updates (chat.status) is a bridged conversation like the others,
-- marked here: never listed, never searched, never counted, never pushed — its messages are status updates of their
-- senders, deleted after 24 hours (expires_at) with their files.

ALTER TABLE conversations ADD COLUMN bridge_status INTEGER NOT NULL DEFAULT 0;          -- 1: the room of the status updates
ALTER TABLE conversations ADD COLUMN bridge_status_reported INTEGER NOT NULL DEFAULT 0; -- time (ms) of the newest status
                                                                                         -- reported to WhatsApp as seen
ALTER TABLE messages ADD COLUMN ext_seen INTEGER;   -- a status update the person watched here (ms; null: not yet)
