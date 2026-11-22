-- gatecontrol-smarthome 1.14.0: Heizung — rooms, four fixed presets, weekly plans, boost, window open, holiday,
-- "Heizung abwesend". The plan runs in the server part (server/heating.js, every background run).
--
-- heat_house: one row (id 1) for the whole house. presets_json { comfort, eco, night, frost } (°C; missing → the
-- defaults 21 / 18 / 17 / 7), away 1 = "Heizung abwesend" (Komfort becomes Eco in the rooms of a plan that allows it),
-- vacation_json { from, to, preheat_h, preset, rooms { <room id>: preset } } (from / to: ISO times; to = the return,
-- the plans start again preheat_h hours before it).
CREATE TABLE heat_house (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  presets_json  TEXT,
  away          INTEGER NOT NULL DEFAULT 0,
  vacation_json TEXT,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO heat_house (id) VALUES (1);
-- heat_plans: a weekly plan. week_json: seven days (Monday first), each [[start minute, preset], …] — the first at 0,
-- ascending, on a 15-minute grid, at most 12 a day. presets_json: the plan's own temperatures (only those that differ
-- from the house). window_on / window_min: "Fenster offen" (a contact in the room open longer than 1 | 2 | 5 minutes →
-- Frostschutz), away: "Niemand zu Hause" (Heizung abwesend) applies to the plan's rooms.
CREATE TABLE heat_plans (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  week_json    TEXT NOT NULL,
  presets_json TEXT,
  window_on    INTEGER NOT NULL DEFAULT 1,
  window_min   INTEGER NOT NULL DEFAULT 2,
  away         INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
-- heat_rooms: a room = the area ("Bereich") of its thermostats (room_key 'a:<area>'), a thermostat without one is a
-- room of its own ('t:<resource id>'). A row is made when a room is seen first; its id is what the pages, the portal
-- and the apps name. plan_id: its plan (one per room) or NULL; mode plan | manual | off ("Betrieb"); presets_json the
-- room's own temperatures; max_setpoint: the highest target an assigned person may set (NULL: none); hold: the target a
-- room without a plan keeps; manual: the target of "Von Hand"; override_json { setpoint, preset?, until, at } a change
-- by hand until the next switching point; boost_json { until, minutes, at }; window_json { since, lowered };
-- applied_json { sig, done [resource ids], prev, prev_mode } what the plan last sent (only rewritten when it changes).
CREATE TABLE heat_rooms (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  room_key      TEXT NOT NULL,
  plan_id       INTEGER,
  mode          TEXT NOT NULL DEFAULT 'plan',
  presets_json  TEXT,
  max_setpoint  REAL,
  hold          REAL,
  manual        REAL,
  override_json TEXT,
  boost_json    TEXT,
  window_json   TEXT,
  applied_json  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_heat_rooms_key ON heat_rooms(room_key);
CREATE INDEX idx_heat_rooms_plan ON heat_rooms(plan_id);
