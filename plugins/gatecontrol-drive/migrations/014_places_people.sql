-- Drive 1.16.0: places and people in the photos (server/places.js, server/geonames.js — feature `photoPlaces`;
-- server/faces.js — feature `photoPeople`).

-- Where a picture or video was taken (uploads/commit { geo }, PUT nodes/<id>/geo): WGS84 rounded to 6 decimals, the city
-- (Stadt bzw. Gemeinde) and the district (Ortsteil) GeoNames names for it (their geonameids, geo_places); geo_none = 1:
-- looked at, there is no position (PUT nodes/<id>/geo { none: true }, DELETE photos/geo); geo_at: when it was set.
ALTER TABLE nodes ADD COLUMN geo_lat REAL;
ALTER TABLE nodes ADD COLUMN geo_lon REAL;
ALTER TABLE nodes ADD COLUMN geo_place INTEGER;
ALTER TABLE nodes ADD COLUMN geo_district INTEGER;
ALTER TABLE nodes ADD COLUMN geo_none INTEGER;
ALTER TABLE nodes ADD COLUMN geo_at INTEGER;
CREATE INDEX nodes_geo_place ON nodes (geo_place) WHERE geo_place IS NOT NULL;
CREATE INDEX nodes_geo_district ON nodes (geo_district) WHERE geo_district IS NOT NULL;
CREATE INDEX nodes_geo_lat ON nodes (geo_lat) WHERE geo_lat IS NOT NULL;
CREATE INDEX nodes_created_by ON nodes (created_by);

-- The places photos are at (a copy of what GeoNames says, made when a photo first gets one): kind 'city' or 'district'
-- (then parent: its city), the name and region as shown (German where GeoNames has it), the country (ISO-2), where it is,
-- and `search` — every name (German, English, local; region, country), folded (lower case, no accents), each word once,
-- between spaces (" hamburg deutschland germany "): q= and photos/suggest match it.
CREATE TABLE geo_places (
  id      INTEGER PRIMARY KEY,
  kind    TEXT NOT NULL CHECK (kind IN ('city', 'district')),
  parent  INTEGER,
  name    TEXT NOT NULL,
  region  TEXT,
  country TEXT NOT NULL,
  lat     REAL NOT NULL,
  lon     REAL NOT NULL,
  search  TEXT NOT NULL
);

-- A person's switches (GET|PUT photos/settings): keep_geo — the apps send where a photo was taken (0: they do not, and the
-- server drops a geo of this person's commits); people — faces are recognised (0: no face data at all); people_kids —
-- the children's folders too.
ALTER TABLE photo_settings ADD COLUMN keep_geo INTEGER NOT NULL DEFAULT 1;
ALTER TABLE photo_settings ADD COLUMN people INTEGER NOT NULL DEFAULT 0;
ALTER TABLE photo_settings ADD COLUMN people_kids INTEGER NOT NULL DEFAULT 0;

-- A person's people (only theirs): the groups the server formed of their face vectors. pending = 1: a group of fewer than
-- three faces, not yet a person (never shown); `sum`: the sum of the group's face vectors (float32 little endian) — its
-- centre is sum / |sum|; faces: how many faces it has. name / name_fold (lower case, no accents: the same name merges),
-- hidden (strangers: out of the search, the bar and the suggestions), the linked family member or contact.
CREATE TABLE persons (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL,
  model        TEXT NOT NULL,
  pending      INTEGER NOT NULL DEFAULT 1,
  name         TEXT,
  name_fold    TEXT,
  hidden       INTEGER NOT NULL DEFAULT 0,
  contact_kind TEXT,
  contact_id   TEXT,
  contact_name TEXT,
  faces        INTEGER NOT NULL DEFAULT 0,
  sum          BLOB NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX persons_user ON persons (user_id, model, pending);

-- The faces a device found on a picture for a person (PUT nodes/<id>/faces): the box (0 … 1 of the upright picture),
-- the five points (JSON), the detector's score, the feature vector (float32 little endian), the person or group it is in
-- (sure = 1: the person said so — confirm, move), and while it is unsure (between `maybe` and `same` to the nearest person)
-- that person and how near.
CREATE TABLE faces (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  node_id     INTEGER NOT NULL,
  model       TEXT NOT NULL,
  bx          REAL NOT NULL,
  by          REAL NOT NULL,
  bw          REAL NOT NULL,
  bh          REAL NOT NULL,
  landmarks   TEXT,
  score       REAL NOT NULL,
  vec         BLOB NOT NULL,
  person_id   INTEGER,
  sure        INTEGER NOT NULL DEFAULT 0,
  maybe_id    INTEGER,
  maybe_score REAL,
  at          INTEGER NOT NULL
);
CREATE INDEX faces_node ON faces (node_id);
CREATE INDEX faces_person ON faces (person_id) WHERE person_id IS NOT NULL;
CREATE INDEX faces_user ON faces (user_id, model);
CREATE INDEX faces_maybe ON faces (maybe_id) WHERE maybe_id IS NOT NULL;

-- Which pictures a person's devices looked at for faces with which model (also: none found) — GET photos?unfaced=1 and
-- the progress of GET people.
CREATE TABLE face_scans (
  user_id INTEGER NOT NULL,
  model   TEXT NOT NULL,
  node_id INTEGER NOT NULL,
  faces   INTEGER NOT NULL,
  at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, model, node_id)
);
CREATE INDEX face_scans_node ON face_scans (node_id);

-- "Nicht diese Person": a face is never suggested for that person again (confirm … yes: false, faces/<id>/move).
CREATE TABLE face_rejects (
  face_id   INTEGER NOT NULL,
  person_id INTEGER NOT NULL,
  PRIMARY KEY (face_id, person_id)
);
CREATE INDEX face_rejects_person ON face_rejects (person_id);
