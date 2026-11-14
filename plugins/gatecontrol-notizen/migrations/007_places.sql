-- Notizen & Aufgaben 1.5.0 — a task at a place (server/places.js, server/placesearch.js).
--
-- places       a person's places: „Meine Orte“ (named = 1: the quick entry knows the name — „bei Oma“) and the places a
--              task was hung on once (named = 0: a hit of the place search, a pin on the map, a place of the family).
--              ref says where it came from ('osm:W387665337' | 'familie:home' | 'familie:place:3' | NULL) — one row per
--              person and ref. The coordinates are those of the PLACE (public map data, or what the person set) —
--              never where a person is. Deleted places keep their row while a task still hangs on them (deleted_at).
-- place_picks  what a person chose for a kind of place or a name ('kind:diy', 'name:lidl'): how often, when last,
--              and the one that is remembered („mein Baumarkt“, fav = 1 — one per person and key).
-- tasks.place_id     the place the task hangs on (places.id; NULL with „any“ — „Jeder Lidl“)
-- tasks.place_json   { key, label, any, trigger: 'enter' | 'exit', by, who, consent } — set together, NULL: no place
-- tasks.place_state  { skip: [fence ids — „Nicht hier“], later: ms, fired: { <fence id>: ms }, hint: ms } — what the
--                    hints did so far (no position: only „this fence fired at …“)
-- Adding the columns writes no row.
CREATE TABLE places (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  name        TEXT NOT NULL,
  address     TEXT NOT NULL DEFAULT '',
  lat         REAL NOT NULL,
  lon         REAL NOT NULL,
  radius      INTEGER NOT NULL DEFAULT 150,
  named       INTEGER NOT NULL DEFAULT 0,
  ref         TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER
);
CREATE INDEX idx_places_user ON places(user_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_places_ref ON places(user_id, ref) WHERE ref IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE place_picks (
  user_id   INTEGER NOT NULL,
  key       TEXT NOT NULL,
  place_id  INTEGER NOT NULL,
  uses      INTEGER NOT NULL DEFAULT 0,
  used_at   INTEGER NOT NULL DEFAULT 0,
  fav       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, key, place_id)
) WITHOUT ROWID;
CREATE INDEX idx_place_picks_place ON place_picks(place_id);

ALTER TABLE tasks ADD COLUMN place_id INTEGER;
ALTER TABLE tasks ADD COLUMN place_json TEXT;
ALTER TABLE tasks ADD COLUMN place_state TEXT;
-- the open tasks with a place of a person's lists (the list of places a phone watches), and the tasks of one place
CREATE INDEX idx_tasks_place ON tasks(list_id) WHERE place_json IS NOT NULL AND done_at IS NULL AND deleted_at IS NULL;
CREATE INDEX idx_tasks_place_id ON tasks(place_id) WHERE place_id IS NOT NULL;
