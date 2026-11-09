-- Mail 1.13.0: „Mehrfachauswahl + Wischaktionen“.
--
-- prefs.swipe_left / swipe_right now hold one of seven actions (archive | delete | read | flag | move | junk | none);
-- the API's old fields swipeLeft / swipeRight show only the four of before (flag, move, junk as none — api.js).
-- confirm_delete: the person wants to be asked before mail goes to the trash (else „Rückgängig“).
ALTER TABLE prefs ADD COLUMN confirm_delete INTEGER NOT NULL DEFAULT 0;

-- What an undo needs (POST messages/undo { token }): a move, copy, archive, delete or junk of a person, for two minutes.
-- data_json: per account the mails with their folder before and after, the new uid / Graph id or (IMAP without new
-- UIDs) the target's UIDNEXT before and the Message-ID. used: taken back already.
CREATE TABLE undo_log (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  data_json  TEXT NOT NULL,
  at         INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX undo_log_expires ON undo_log (expires_at);
