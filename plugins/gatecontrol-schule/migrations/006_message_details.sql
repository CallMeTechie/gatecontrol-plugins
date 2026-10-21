-- gatecontrol-schule 1.5.0: school messages without WebUntis — the full text and the attachments of a
-- message (WebUntis' detail call, once per message), who of GateControl has read it, and the read
-- confirmation a sender asks for (sent to the school only when a person taps the button).

-- The full text (body) and the attachments, once the detail call answered
ALTER TABLE messages ADD COLUMN full_text INTEGER NOT NULL DEFAULT 0;   -- 1: body is the whole text
ALTER TABLE messages ADD COLUMN attachments_json TEXT;                  -- [{ id, name, size, mime, mediaId? }]
ALTER TABLE messages ADD COLUMN detail_at INTEGER;                      -- ms, the detail call answered
ALTER TABLE messages ADD COLUMN detail_tries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN detail_next_at INTEGER;                 -- ms, after a failed detail call
-- The sender asks for a read confirmation (the message is in WebUntis' readConfirmationMessages)
ALTER TABLE messages ADD COLUMN confirm_required INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN confirmed_at INTEGER;                   -- ms (sent from here, or seen confirmed)
ALTER TABLE messages ADD COLUMN confirmed_by INTEGER;                   -- GateControl user id (NULL: elsewhere)

-- Who has opened a message in GateControl (the "new" mark is per person)
CREATE TABLE message_reads (
  account_id INTEGER NOT NULL,
  msg_id     TEXT NOT NULL,
  user_id    INTEGER NOT NULL,
  read_at    INTEGER NOT NULL,
  PRIMARY KEY (account_id, msg_id, user_id)
);
CREATE INDEX message_reads_user ON message_reads (user_id);
