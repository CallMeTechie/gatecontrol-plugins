-- gatecontrol-schule 1.7.0: attachments of school messages saved automatically into Drive (setting
-- drive_auto_save) — one row per attachment once it was handled, so it is never saved twice and a
-- failure is not tried again.

CREATE TABLE drive_saves (
  account_id INTEGER NOT NULL,
  msg_id     TEXT NOT NULL,
  att_id     TEXT NOT NULL,                     -- the attachment's WebUntis id
  status     TEXT NOT NULL,                     -- saved | failed
  code       TEXT,                              -- failed: why (no_parent, quota, not_fetched, …)
  user_id    INTEGER,                           -- saved: as whom (a parent with a Drive seat)
  node_id    INTEGER,                           -- saved: Drive's node id
  at         INTEGER NOT NULL,                  -- ms
  PRIMARY KEY (account_id, msg_id, att_id)
);
