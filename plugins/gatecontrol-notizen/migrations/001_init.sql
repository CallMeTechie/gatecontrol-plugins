-- Notizen & Aufgaben 1.0.0 — the hub's own database (GateControl's per-plugin SQLite file).
-- Every query of the screens goes through an index below (test/speed.test.js: 50 000 tasks and notes, each statement
-- well under 200 ms). Times are ms since the epoch, dates 'YYYY-MM-DD' in the hub's time zone (setting timezone).

-- one row per person: the choices of „Quellen“, the area last open, …
CREATE TABLE prefs (
  user_id     INTEGER PRIMARY KEY,
  json        TEXT NOT NULL DEFAULT '{}',
  updated_at  INTEGER NOT NULL
);

-- ── tasks ────────────────────────────────────────────

CREATE TABLE lists (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id    INTEGER NOT NULL,
  area        TEXT NOT NULL DEFAULT 'private',   -- private | work
  name        TEXT NOT NULL,
  color       TEXT,
  icon        TEXT,
  is_default  INTEGER NOT NULL DEFAULT 0,        -- the person's „Aufgaben“ of the area (made on first use)
  ext_kind    TEXT,                              -- 'mstodo' (imported / synced)
  ext_id      TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER
);
CREATE INDEX idx_lists_owner ON lists(owner_id, area) WHERE deleted_at IS NULL;

-- who sees a list (the owner too); group and position are each member's own
CREATE TABLE list_members (
  user_id     INTEGER NOT NULL,
  list_id     INTEGER NOT NULL,
  role        TEXT NOT NULL DEFAULT 'write',     -- owner | write
  group_id    INTEGER,
  position    REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, list_id)
) WITHOUT ROWID;
CREATE INDEX idx_list_members_list ON list_members(list_id);

CREATE TABLE list_groups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  area        TEXT NOT NULL DEFAULT 'private',
  name        TEXT NOT NULL,
  position    REAL NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_list_groups_user ON list_groups(user_id, area);

CREATE TABLE tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id      INTEGER NOT NULL,
  parent_id    INTEGER,                          -- a sub task (one level)
  title        TEXT NOT NULL,
  note         TEXT NOT NULL DEFAULT '',
  important    INTEGER NOT NULL DEFAULT 0,
  due_date     TEXT,
  due_time     TEXT,                             -- 'HH:MM' or NULL (all day)
  due_at       INTEGER,                          -- ms of due_date + due_time (or 23:59) in the hub's zone
  remind_at    INTEGER,
  reminded_at  INTEGER,
  repeat_json  TEXT,                             -- ui/repeat.js rule
  assignee_id  INTEGER,
  done_at      INTEGER,
  done_by      INTEGER,
  position     REAL NOT NULL DEFAULT 0,
  src_plugin   TEXT,                             -- a source item this task carries (sub tasks, note, reminder …)
  src_id       TEXT,
  note_id      INTEGER,                          -- the note whose line it was made from
  ext_id       TEXT,                             -- Microsoft To Do task id
  ext_at       INTEGER,                          -- its lastModifiedDateTime when last in step
  ext_dirty    INTEGER NOT NULL DEFAULT 0,       -- changed here, not yet in To Do
  created_by   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER
);
CREATE INDEX idx_tasks_list ON tasks(list_id, done_at, position) WHERE deleted_at IS NULL AND parent_id IS NULL;
CREATE INDEX idx_tasks_due ON tasks(list_id, due_date) WHERE done_at IS NULL AND deleted_at IS NULL AND parent_id IS NULL AND due_date IS NOT NULL;
CREATE INDEX idx_tasks_important ON tasks(list_id, due_date) WHERE important = 1 AND done_at IS NULL AND deleted_at IS NULL AND parent_id IS NULL;
CREATE INDEX idx_tasks_assignee ON tasks(assignee_id, list_id) WHERE done_at IS NULL AND deleted_at IS NULL AND parent_id IS NULL AND assignee_id IS NOT NULL;
CREATE INDEX idx_tasks_done ON tasks(list_id, done_at) WHERE done_at IS NOT NULL AND deleted_at IS NULL AND parent_id IS NULL;
CREATE INDEX idx_tasks_parent ON tasks(parent_id, position) WHERE parent_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_tasks_remind ON tasks(remind_at) WHERE remind_at IS NOT NULL AND reminded_at IS NULL AND done_at IS NULL AND deleted_at IS NULL;
CREATE INDEX idx_tasks_src ON tasks(src_plugin, src_id) WHERE src_plugin IS NOT NULL;
CREATE INDEX idx_tasks_ext ON tasks(list_id, ext_id) WHERE ext_id IS NOT NULL;
CREATE INDEX idx_tasks_ext_dirty ON tasks(list_id) WHERE ext_dirty = 1;
CREATE INDEX idx_tasks_note ON tasks(note_id) WHERE note_id IS NOT NULL;
CREATE INDEX idx_tasks_trash ON tasks(deleted_at) WHERE deleted_at IS NOT NULL;

-- „Mein Tag“ is each person's own
CREATE TABLE my_day (
  user_id  INTEGER NOT NULL,
  day      TEXT NOT NULL,
  task_id  INTEGER NOT NULL,
  PRIMARY KEY (user_id, day, task_id)
) WITHOUT ROWID;
CREATE INDEX idx_my_day_task ON my_day(task_id);

CREATE VIRTUAL TABLE tasks_fts USING fts5(title, note, tokenize = 'unicode61 remove_diacritics 2');

-- ── notes ────────────────────────────────────────────

CREATE TABLE notebooks (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id         INTEGER,                      -- NULL: kept for a plugin (bound_plugin)
  area             TEXT NOT NULL DEFAULT 'private',
  name             TEXT NOT NULL DEFAULT '',     -- '' for a Tresor (name_cipher)
  color            TEXT,
  is_default       INTEGER NOT NULL DEFAULT 0,
  -- Tresor (end-to-end, README "Tresor-Notizbücher"): only ciphertext, public keys and wraps
  vault_id         TEXT,
  name_cipher      TEXT,
  key_version      INTEGER,
  recovery_pub     TEXT,
  recovery_auth    TEXT,                         -- SHA-256 of the recovery proof (hex)
  recovery_holder  INTEGER,
  needs_rotation   INTEGER NOT NULL DEFAULT 0,
  rotated_at       INTEGER,
  -- kept for another plugin (Familie: pinnwand, packlisten)
  bound_plugin     TEXT,
  bound_key        TEXT,
  bound_kind       TEXT,                         -- notes | checklists
  ext_kind         TEXT,                         -- 'dsnote'
  ext_id           TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  deleted_at       INTEGER
);
CREATE UNIQUE INDEX idx_notebooks_bound ON notebooks(bound_plugin, bound_key) WHERE bound_plugin IS NOT NULL;
CREATE UNIQUE INDEX idx_notebooks_vault ON notebooks(vault_id) WHERE vault_id IS NOT NULL;
CREATE INDEX idx_notebooks_owner ON notebooks(owner_id, area) WHERE deleted_at IS NULL;

CREATE TABLE notebook_members (
  user_id      INTEGER NOT NULL,
  notebook_id  INTEGER NOT NULL,
  role         TEXT NOT NULL DEFAULT 'write',    -- owner | write
  position     REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, notebook_id)
) WITHOUT ROWID;
CREATE INDEX idx_notebook_members_nb ON notebook_members(notebook_id);

CREATE TABLE notes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  notebook_id   INTEGER NOT NULL,
  title         TEXT NOT NULL DEFAULT '',
  body          TEXT NOT NULL DEFAULT '',        -- Markdown (ui/notemd.js)
  snippet       TEXT NOT NULL DEFAULT '',
  pinned        INTEGER NOT NULL DEFAULT 0,
  color         TEXT,
  due_date      TEXT,                            -- checklists: e.g. the trip date of a packing list
  expires_at    INTEGER,
  check_done    INTEGER NOT NULL DEFAULT 0,
  check_total   INTEGER NOT NULL DEFAULT 0,
  images        INTEGER NOT NULL DEFAULT 0,
  files         INTEGER NOT NULL DEFAULT 0,
  title_cipher  TEXT,                            -- Tresor: title and body only as ciphertext
  cipher        TEXT,
  key_version   INTEGER,
  rev           INTEGER NOT NULL DEFAULT 1,      -- bumped by every change (a save with an old rev → 409)
  ext_kind      TEXT,                            -- 'dsnote' | 'familie'
  ext_id        TEXT,
  created_by    INTEGER,
  updated_by    INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER
);
CREATE INDEX idx_notes_updated ON notes(updated_at) WHERE deleted_at IS NULL;
CREATE INDEX idx_notes_nb ON notes(notebook_id, updated_at) WHERE deleted_at IS NULL;
CREATE INDEX idx_notes_pinned ON notes(notebook_id, updated_at) WHERE pinned = 1 AND deleted_at IS NULL;
CREATE INDEX idx_notes_due ON notes(notebook_id, due_date) WHERE due_date IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_notes_expires ON notes(expires_at) WHERE expires_at IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_notes_ext ON notes(notebook_id, ext_kind, ext_id) WHERE ext_id IS NOT NULL;
CREATE INDEX idx_notes_trash ON notes(deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE note_tags (
  note_id  INTEGER NOT NULL,
  tag      TEXT NOT NULL,
  PRIMARY KEY (note_id, tag)
) WITHOUT ROWID;
CREATE INDEX idx_note_tags_tag ON note_tags(tag, note_id);

-- how many notes of a notebook carry a tag (the tag list of the menu without counting every note)
CREATE TABLE notebook_tags (
  notebook_id  INTEGER NOT NULL,
  tag          TEXT NOT NULL,
  n            INTEGER NOT NULL,
  PRIMARY KEY (notebook_id, tag)
) WITHOUT ROWID;

CREATE VIRTUAL TABLE notes_fts USING fts5(title, body, tags, ocr, tokenize = 'unicode61 remove_diacritics 2');

-- pictures and files of notes and tasks (the plugin's media, sealed by GateControl)
CREATE TABLE attachments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL,                    -- note | task
  ref_id       INTEGER NOT NULL,
  media_id     TEXT NOT NULL,
  name         TEXT NOT NULL,                    -- '' in a Tresor (name_cipher)
  name_cipher  TEXT,
  mime         TEXT NOT NULL,
  bytes        INTEGER NOT NULL,
  encrypted    INTEGER NOT NULL DEFAULT 0,
  ocr          TEXT,                             -- recognised text a device sent (search)
  ext_id       TEXT,
  created_by   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_attachments_ref ON attachments(kind, ref_id);
CREATE INDEX idx_attachments_media ON attachments(media_id);
CREATE INDEX idx_attachments_owner ON attachments(created_by, bytes);

-- ── items of the other plugins (docs/notes-sources-contract.md) ──

CREATE TABLE src_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin         TEXT NOT NULL,
  ext_id         TEXT NOT NULL,
  kind           TEXT NOT NULL,
  title          TEXT NOT NULL,
  subtitle       TEXT,
  due_date       TEXT,
  due_time       TEXT,
  due_at         INTEGER,
  all_day        INTEGER NOT NULL DEFAULT 1,
  lead           TEXT,
  area           TEXT NOT NULL DEFAULT 'private',
  assignee_id    INTEGER,
  assignee_name  TEXT,
  important      INTEGER NOT NULL DEFAULT 0,
  done           INTEGER NOT NULL DEFAULT 0,
  done_at        INTEGER,
  can_complete   INTEGER NOT NULL DEFAULT 1,
  prog_done      INTEGER,
  prog_total     INTEGER,
  group_id       TEXT,
  group_label    TEXT,
  meta_json      TEXT,
  open_route     TEXT,
  updated_at     INTEGER NOT NULL,
  received_at    INTEGER NOT NULL,
  UNIQUE (plugin, ext_id)
);
CREATE INDEX idx_src_items_done ON src_items(done_at) WHERE done = 1;

CREATE TABLE src_item_users (
  user_id  INTEGER NOT NULL,
  item_id  INTEGER NOT NULL,
  run      INTEGER NOT NULL DEFAULT 0,          -- the reconciliation that last saw it for this person
  PRIMARY KEY (user_id, item_id)
) WITHOUT ROWID;
CREATE INDEX idx_src_item_users_item ON src_item_users(item_id);

-- the reconciliation per source and person
CREATE TABLE src_sync (
  plugin    TEXT NOT NULL,
  user_id   INTEGER NOT NULL,
  run       INTEGER NOT NULL DEFAULT 0,
  cursor    TEXT,
  next_at   INTEGER NOT NULL DEFAULT 0,
  last_at   INTEGER,
  state     TEXT NOT NULL DEFAULT 'due',         -- due | running | done | error
  error     TEXT,
  PRIMARY KEY (plugin, user_id)
);
CREATE INDEX idx_src_sync_next ON src_sync(next_at);

CREATE TABLE src_state (
  plugin     TEXT PRIMARY KEY,
  available  INTEGER NOT NULL DEFAULT 0,
  pushes     INTEGER NOT NULL DEFAULT 0,
  last_push  INTEGER,
  last_pull  INTEGER,
  gone_at    INTEGER,
  error      TEXT
);

-- changes of notebooks kept for a plugin, told to it with <plugin>:notes_changed
CREATE TABLE bound_dirty (
  notebook_id  INTEGER NOT NULL,
  note_id      INTEGER NOT NULL,
  removed      INTEGER NOT NULL DEFAULT 0,
  at           INTEGER NOT NULL,
  PRIMARY KEY (notebook_id, note_id)
) WITHOUT ROWID;

-- ── Tresor notebooks: devices and wrapped keys ──

CREATE TABLE vault_devices (
  notebook_id  INTEGER NOT NULL,
  device_id    TEXT NOT NULL,
  user_id      INTEGER NOT NULL,
  public_key   TEXT NOT NULL,
  name         TEXT,
  platform     TEXT,
  state        TEXT NOT NULL,                    -- pending | approved | revoked
  via          TEXT,                             -- create | device | recovery
  created_at   INTEGER NOT NULL,
  approved_at  INTEGER,
  approved_by  INTEGER,
  revoked_at   INTEGER,
  PRIMARY KEY (notebook_id, device_id)
);
CREATE INDEX idx_vault_devices_user ON vault_devices(user_id);

CREATE TABLE vault_keys (
  notebook_id  INTEGER NOT NULL,
  device_id    TEXT NOT NULL,                    -- 'recovery' for the recovery key
  key_version  INTEGER NOT NULL,
  wrap         TEXT NOT NULL,
  PRIMARY KEY (notebook_id, device_id, key_version)
) WITHOUT ROWID;

-- ── moving over ──

CREATE TABLE imports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  kind          TEXT NOT NULL,                   -- mstodo | dsnote
  state         TEXT NOT NULL,                   -- running | done | failed | canceled
  options_json  TEXT NOT NULL DEFAULT '{}',
  stats_json    TEXT NOT NULL DEFAULT '{}',
  cursor_json   TEXT,
  error         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_imports_user ON imports(user_id, created_at);
CREATE INDEX idx_imports_state ON imports(state);

-- a list in step with a Microsoft To Do list (the transition period)
CREATE TABLE ext_links (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  account_id   INTEGER NOT NULL,                 -- Mail's account id
  ext_list_id  TEXT NOT NULL,
  list_id      INTEGER NOT NULL,
  two_way      INTEGER NOT NULL DEFAULT 0,
  delta        TEXT,
  next_at      INTEGER NOT NULL DEFAULT 0,
  last_at      INTEGER,
  error        TEXT,
  UNIQUE (user_id, ext_list_id)
);
CREATE INDEX idx_ext_links_next ON ext_links(next_at) WHERE two_way = 1;
CREATE INDEX idx_ext_links_list ON ext_links(list_id);
