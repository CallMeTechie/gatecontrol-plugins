-- gatecontrol-smarthome 1.20.0: Heizung — a room keeps its plan when its area is renamed, "Feiertage wie Sonntag" per
-- plan, a correction (Versatz) per thermostat.
--
-- heat_rooms.members_json: the ids of the thermostats seen in the room lately (at most 16, the newest first). A room
-- whose area is gone (renamed) hands its row — plan, Betrieb, own temperatures — to the area its thermostats are in now.
-- heat_plans.holidays: 1 = statutory holidays run the plan's Sunday (the region: plugin setting heat_region).
-- heat_thermostats: per thermostat (resource id) the correction of its measured temperature, −5…+5 °C in half degrees:
-- shown and regulated with it (the thermostat gets target − offset), or set in the device where GateControl can.
ALTER TABLE heat_rooms ADD COLUMN members_json TEXT;
ALTER TABLE heat_plans ADD COLUMN holidays INTEGER NOT NULL DEFAULT 1;
CREATE TABLE heat_thermostats (
  resource_id  INTEGER PRIMARY KEY,
  temp_offset  REAL NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
