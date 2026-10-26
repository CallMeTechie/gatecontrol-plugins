-- gatecontrol-drive: the folders and files of the areas (my files, family, the children's folders, team folders),
-- who may use Drive (seats), versions, the trash and the change log the devices sync from.
-- The bytes are GateControl media (gc.media, one media area per Drive area); this database keeps the tree and
-- the media ids. Times are ms since the epoch.

-- People switched on for Drive by an administrator; counted against the licence (gc.license.info seats).
CREATE TABLE seats (
  user_id    INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('family', 'business')),
  enabled_at INTEGER NOT NULL,
  enabled_by INTEGER
);

-- An area: 'mine:<user>' (one person), 'family:<group>' (a GateControl family group), 'child:<user>' (a child of
-- a family), 'team:<n>' (a team folder). media_area is its media area (gc.media.areas, a–z 0–9 _ -).
CREATE TABLE areas (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('mine', 'family', 'child', 'team')),
  label       TEXT NOT NULL,
  owner_user  INTEGER,                 -- mine, child: the person
  group_id    INTEGER,                 -- family: the family group; child: the family the child belongs to
  media_area  TEXT NOT NULL UNIQUE,
  root_id     INTEGER,                 -- the area's root folder (nodes)
  quota_bytes INTEGER,                 -- null: no limit of its own
  created_at  INTEGER NOT NULL,
  archived_at INTEGER                  -- a team folder that was ended (read only for its managers)
);

-- Members of a team folder: a person 'u:<id>' or a GateControl group 'g:<id>' (its members, subgroups included).
CREATE TABLE members (
  area_id   TEXT NOT NULL,
  principal TEXT NOT NULL,
  role      TEXT NOT NULL CHECK (role IN ('read', 'write', 'manage')),
  PRIMARY KEY (area_id, principal)
);

-- The tree. The root of an area has no parent and no name. A file has media_id (its current bytes).
-- deleted_at / trash_id: in the trash (trash_id = the node that was deleted; everything below it shares it).
CREATE TABLE nodes (
  id         INTEGER PRIMARY KEY,
  area_id    TEXT NOT NULL,
  parent_id  INTEGER,
  name       TEXT NOT NULL,
  is_dir     INTEGER NOT NULL,
  media_id   TEXT,
  size       INTEGER NOT NULL DEFAULT 0,
  sha256     TEXT,
  mime       TEXT,
  mtime      INTEGER,
  rev        INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  created_by INTEGER,
  updated_at INTEGER NOT NULL,
  updated_by INTEGER,
  deleted_at INTEGER,
  deleted_by INTEGER,
  trash_id   INTEGER
);
CREATE UNIQUE INDEX nodes_name ON nodes (area_id, COALESCE(parent_id, 0), name COLLATE NOCASE) WHERE deleted_at IS NULL;
CREATE INDEX nodes_parent ON nodes (parent_id);
CREATE UNIQUE INDEX nodes_media ON nodes (media_id) WHERE media_id IS NOT NULL;
CREATE INDEX nodes_trash ON nodes (trash_id) WHERE trash_id IS NOT NULL;

-- Older versions of a file (their media are versions in GateControl: gc.media.version).
CREATE TABLE versions (
  id       INTEGER PRIMARY KEY,
  node_id  INTEGER NOT NULL,
  rev      INTEGER NOT NULL,
  media_id TEXT NOT NULL UNIQUE,
  size     INTEGER NOT NULL DEFAULT 0,
  sha256   TEXT,
  at       INTEGER NOT NULL,
  by       INTEGER
);
CREATE INDEX versions_node ON versions (node_id, at);

-- The change log: every change of a node (create, update, move, delete, restore, purge) — devices read it with
-- GET changes?since=<seq>.
CREATE TABLE changes (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  area_id TEXT NOT NULL,
  node_id INTEGER NOT NULL,
  op      TEXT NOT NULL,
  at      INTEGER NOT NULL,
  by      INTEGER,
  device  TEXT
);
CREATE INDEX changes_area ON changes (area_id, seq);

-- How far the journal of changes made on a NAS (gc.media.areas.changes) was read, per media area.
CREATE TABLE journal (
  media_area TEXT PRIMARY KEY,
  seq        INTEGER NOT NULL
);

-- "Mama hat deinen Ordner angesehen": once per day, child and viewer.
CREATE TABLE child_views (
  child_id  INTEGER NOT NULL,
  viewer_id INTEGER NOT NULL,
  day       TEXT NOT NULL,
  PRIMARY KEY (child_id, viewer_id, day)
);
