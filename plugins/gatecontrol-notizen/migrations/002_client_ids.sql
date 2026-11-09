-- 1.1.0: things made on a device while offline carry an id of the device (`clientId`, a UUID). A create sent again
-- with the same clientId by the same person gives back what the first one made instead of a second one. Per person:
-- another person's clientId never finds someone else's object.
CREATE TABLE client_ids (
  user_id     INTEGER NOT NULL,
  client_id   TEXT NOT NULL,
  kind        TEXT NOT NULL,                     -- list | group | task | notebook | note
  ref_id      INTEGER NOT NULL,                  -- the id the server gave it
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, client_id)
) WITHOUT ROWID;
-- the hourly purge (older than 180 days)
CREATE INDEX idx_client_ids_at ON client_ids(created_at);
