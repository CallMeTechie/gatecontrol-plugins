-- gatecontrol-familie 1.13.0: an early end of a school day (the service school_day_end of the Schule
-- plugin) and what was done about it — one row when it came (action 'notified', with the pickup found
-- or none) and one per button pressed on its notification ('moved': the pickup moved to the new end,
-- 'asked': „Wer kann?“). Kept 30 days. Once per child, date and new end: table notices
-- ('school_end:<userId>:<date>:<newEnd>').
CREATE TABLE school_end_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id    INTEGER NOT NULL,
  date        TEXT NOT NULL,                  -- YYYY-MM-DD
  planned_end TEXT NOT NULL,                  -- HH:MM
  new_end     TEXT NOT NULL,                  -- HH:MM
  ride_key    TEXT,                           -- the pickup's occurrence id; NULL: none found
  action      TEXT NOT NULL,                  -- notified | moved | asked
  by_user     INTEGER,                        -- who pressed the button (NULL for notified)
  detail_json TEXT NOT NULL DEFAULT '{}',     -- moved: { from, to }; notified: { users }
  at          INTEGER NOT NULL
);
CREATE INDEX school_end_log_at ON school_end_log (at);
