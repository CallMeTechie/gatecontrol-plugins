-- Drive 1.18.0: the overview (server/overview.js, GET overview). "Zuletzt geöffnet": the files a person opened — GET
-- nodes/<id>/content (the apps, the PC, the portal) and POST nodes/<id>/office; not pictures and videos, not files of a
-- vault, not what a PC fetches for a folder it syncs. One row per person and file (the last time), at most 200 a person.
CREATE TABLE recent_opens (
  user_id INTEGER NOT NULL,
  node_id INTEGER NOT NULL,
  at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, node_id)
);
CREATE INDEX recent_opens_at ON recent_opens (user_id, at);
