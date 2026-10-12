-- gatecontrol-synology: the NAS of this GateControl and their last status.
-- The DSM account (user name, password) and the DSM device token of a NAS
-- are plugin secrets (gc.settings.setSecret 'nas.<id>.user' / '.password' /
-- '.device'), never stored in this file. Notification state (what was
-- announced) lives in gc.storage ('notify.state').

CREATE TABLE nas (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  target_index    INTEGER NOT NULL,   -- index of the assigned home target "nas"
  target_label    TEXT,               -- label of that target when saved (shown when it changed)
  enabled         INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL DEFAULT 'new',   -- new | ok | error | auth | otp
  last_error      TEXT,               -- error code (never a response body)
  error_count     INTEGER NOT NULL DEFAULT 0,  -- failed polls in a row
  last_attempt_at INTEGER,            -- ms
  last_success_at INTEGER,            -- ms
  next_poll_at    INTEGER NOT NULL DEFAULT 0,
  update_checked_at INTEGER,          -- ms, last SYNO.Core.Upgrade.Server check
  power_state     TEXT,               -- null | reboot | shutdown (requested through GateControl)
  power_at        INTEGER,            -- ms of that request
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The last good status of a NAS (normalised, see server/parse.js)
CREATE TABLE snapshots (
  nas_id     INTEGER PRIMARY KEY,
  data       TEXT NOT NULL,           -- JSON
  fetched_at INTEGER NOT NULL         -- ms
);
