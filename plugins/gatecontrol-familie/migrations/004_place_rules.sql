-- gatecontrol-familie 1.5.0: places as triggers for presence rules. The
-- geofencing runs on the person's phone; the server only learns "person X
-- entered / left place Y" — never a position. Times are ms since the epoch.

-- Rule places (at most 20): a circle the phones of the people who agreed watch
-- while an active rule uses it
CREATE TABLE rule_places (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,                        -- 1–40 characters, unique (case-insensitive)
  lat         REAL NOT NULL,
  lon         REAL NOT NULL,
  radius      INTEGER NOT NULL,                     -- metres, 50–5000
  created_by  INTEGER,                              -- the parent (or administrator) who added it
  created_at  INTEGER,
  updated_at  INTEGER
);

-- Own consent for places, independent of sharing home / away
ALTER TABLE presence_consent ADD COLUMN places INTEGER NOT NULL DEFAULT 0;

-- place_enter / place_exit: the place of the rule
ALTER TABLE presence_rules ADD COLUMN place_id INTEGER;

-- A place run: the place and its name at the time
ALTER TABLE presence_log ADD COLUMN place_id INTEGER;
ALTER TABLE presence_log ADD COLUMN place_name TEXT;

-- Every reported transition (dedupe and history; kept 90 days, no coordinates)
CREATE TABLE place_rule_events (
  id           INTEGER PRIMARY KEY,
  place_id     INTEGER,
  user_id      INTEGER,
  transition   TEXT,                                -- enter | exit
  at           INTEGER,                             -- the phone's time of the transition
  received_at  INTEGER,
  fired        INTEGER,                             -- number of rules run
  late         INTEGER                              -- 1: older than 10 minutes, nothing run
);
CREATE INDEX idx_place_rule_events_dedupe ON place_rule_events(user_id, place_id, transition, at);
CREATE INDEX idx_place_rule_events_at ON place_rule_events(at);
