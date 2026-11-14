-- Notizen & Aufgaben 1.4.0 — shopping lists in the hub, a list attached to a task (server/shopping.js).
--
-- A shopping list is a list like any other (owner, members and their roles, icon, list days) of the kind 'shopping'.
-- Its items are no tasks: light rows with an id made by the device (the offline protocol Familie had: POST shopping/ops,
-- idempotent operations, tombstones kept 30 days).
--
-- lists.kind         'tasks' | 'shopping'
-- lists.uid          the id a device (or Familie) gave a shopping list — the id of the offline protocol, the same in Familie
-- lists.bound_plugin 'gatecontrol-familie': shared with the whole family; its members are kept in step with the family
--                    (service shopping_bind), Familie shows it and keeps a copy
-- lists.fam_json     what Familie knows about such a list ({ assignee, dueAt, going }) — shown, never read as anything else
-- Adding the columns writes no row.
ALTER TABLE lists ADD COLUMN kind TEXT NOT NULL DEFAULT 'tasks';
ALTER TABLE lists ADD COLUMN uid TEXT;
ALTER TABLE lists ADD COLUMN bound_plugin TEXT;
ALTER TABLE lists ADD COLUMN fam_json TEXT;
CREATE UNIQUE INDEX idx_lists_uid ON lists(uid) WHERE uid IS NOT NULL;
CREATE INDEX idx_lists_bound ON lists(bound_plugin) WHERE bound_plugin IS NOT NULL;

CREATE TABLE shop_items (
  id          TEXT PRIMARY KEY,                  -- made by the device
  list_id     INTEGER NOT NULL,
  text        TEXT NOT NULL,
  qty         TEXT,
  checked     INTEGER NOT NULL DEFAULT 0,
  checked_by  INTEGER,
  created_by  INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0         -- tombstone (kept 30 days)
) WITHOUT ROWID;
-- the items of a list as shown, and its counts (open / all)
CREATE INDEX idx_shop_items_list ON shop_items(list_id, created_at);
CREATE INDEX idx_shop_items_open ON shop_items(list_id) WHERE deleted = 0 AND checked = 0;
-- GET shopping?since=, the owner plugin's pull, the purge of tombstones
CREATE INDEX idx_shop_items_updated ON shop_items(updated_at);

-- The family as Familie told it (shopping_bind): who belongs to it, who is a parent. dirty: something of a family list
-- changed here and Familie has not been told yet (shopping_changed).
CREATE TABLE shop_family (
  plugin   TEXT PRIMARY KEY,
  members  TEXT NOT NULL DEFAULT '[]',
  parents  TEXT NOT NULL DEFAULT '[]',
  at       INTEGER NOT NULL,
  dirty    INTEGER NOT NULL DEFAULT 0
);

-- The shopping list a task carries (lists.id); „all items ticked“ completes the task.
ALTER TABLE tasks ADD COLUMN attached_list INTEGER;
CREATE INDEX idx_tasks_attached ON tasks(attached_list) WHERE attached_list IS NOT NULL AND deleted_at IS NULL;
