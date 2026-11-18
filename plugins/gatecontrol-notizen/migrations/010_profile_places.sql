-- Notizen & Aufgaben 1.8.0 — „Meine Orte“ live in the user profile of GateControl (gc.places, server/profileplaces.js).
--
-- places.profile_id  the place of the profile this row stands for ('profile:<id>'). Such a row is the plugin's copy of
--                    the profile's place (name, point, radius — what a task shows and a phone watches, and what stays
--                    when the place is deleted in the profile: profile_id goes back to NULL, the task keeps the copy).
--                    One row per person and profile place; the profile's place is the truth, the hook placesChanged
--                    brings the copy up to date.
-- place_moves        the move of the old „Meine Orte“ into the profile (once, at the first start of 1.8.0, idempotent
--                    over gc.places.importFor's source 'notizen' + sourceRef = the old places.id): old id → profile id,
--                    or why not — 'family' (a place of Familie: it stays a reference to Familie), 'invalid' (the
--                    profile refused it, `field` says why — tasks keep it as their place), 'limit' (100 places).
-- place_usage        what was told to the profile last („Genutzt von“: gc.places.reportUsage, kind 'task') per place and
--                    for whom (user_id: a person with a copy of it; a 0 is taken for any place, gc.places version 2).
-- Adding the column and the tables writes no row.
ALTER TABLE places ADD COLUMN profile_id INTEGER;
CREATE UNIQUE INDEX idx_places_profile ON places(user_id, profile_id) WHERE profile_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_places_pid ON places(profile_id) WHERE profile_id IS NOT NULL;

CREATE TABLE place_moves (
  old_id      INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  name        TEXT NOT NULL,
  state       TEXT NOT NULL,
  profile_id  INTEGER,
  field       TEXT,
  created     INTEGER NOT NULL DEFAULT 0,
  at          INTEGER NOT NULL
);
CREATE INDEX idx_place_moves_user ON place_moves(user_id);

CREATE TABLE place_usage (
  profile_id  INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  sent        INTEGER NOT NULL,
  at          INTEGER NOT NULL
);
