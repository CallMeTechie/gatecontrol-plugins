-- gatecontrol-door 1.1.0: Ring location modes (Ring app: Inaktiv / Zuhause /
-- Abwesend; API: disarmed / home / away). One row per Ring location of the
-- account (devices/v1/locations), refreshed with the device sync; the mode is
-- read every minute for the locations that can switch it (cameras there, no
-- Ring Alarm base station, modes switched on in the Ring app, not read-only).
CREATE TABLE ring_locations (
  location_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cameras INTEGER NOT NULL DEFAULT 0,   -- Ring doorbells / cameras at this location
  alarm INTEGER NOT NULL DEFAULT 0,     -- 1 = a Ring Alarm base station: the mode belongs to the alarm, never switched here
  mode TEXT,                            -- disarmed | home | away | disabled | unset | NULL (not read yet)
  read_only INTEGER NOT NULL DEFAULT 0, -- Ring says this account may not switch it
  mode_at INTEGER,                      -- Ring's lastUpdateTimeMS of the mode (ms), NULL = unknown
  checked_at INTEGER,                   -- last successful read or switch (ms)
  error TEXT,                           -- code of the last failed read, NULL after a good one
  present INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

-- Right "Ring-Modus schalten" per person and location (administrators always have it)
CREATE TABLE mode_rights (
  user_id INTEGER NOT NULL,
  location_id TEXT NOT NULL,
  PRIMARY KEY (user_id, location_id)
);

-- History rows of kind 'mode' (action = the mode) name their location
ALTER TABLE history ADD COLUMN location_id TEXT;
