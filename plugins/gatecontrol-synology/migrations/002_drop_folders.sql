-- gatecontrol-synology 1.2.0: folders on a NAS that GateDrop may save into (service save_file), set by an
-- administrator on the plugin page. `path` is a File Station path: /<shared folder>[/<folder>…].

CREATE TABLE drop_folders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  nas_id      INTEGER NOT NULL,
  label       TEXT NOT NULL,
  path        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX drop_folders_nas ON drop_folders (nas_id);
