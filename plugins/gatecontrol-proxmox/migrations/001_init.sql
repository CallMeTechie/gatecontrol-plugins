-- gatecontrol-proxmox: Proxmox VE connections, watched guests, the last good
-- status of every connection and the log of control actions.
-- The API token secret of a connection is a plugin secret
-- (gc.settings.setSecret 'host.<id>.secret'), never stored in this file.
-- Notification state (what was announced) lives in gc.storage ('notify.state').

-- A Proxmox VE host or cluster, reached through an assignment of the home
-- target "pve" (target_index) with an API token (token_id = USER@REALM!TOKENID)
CREATE TABLE hosts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  target_index    INTEGER,
  token_id        TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL DEFAULT 'new',   -- new | ok | error
  last_error      TEXT,                          -- error code (never a response body)
  error_count     INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,                       -- ms
  last_success_at INTEGER,                       -- ms
  next_poll_at    INTEGER NOT NULL DEFAULT 0,    -- ms
  pve_version     TEXT,
  cluster_name    TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Guests (VMID, unique per cluster) whose unexpected stop is announced
CREATE TABLE watched_guests (
  host_id    INTEGER NOT NULL,
  vmid       INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (host_id, vmid)
);

-- The last good status of a connection (JSON, see server/snapshot.js)
CREATE TABLE snapshots (
  host_id    INTEGER PRIMARY KEY,
  fetched_at INTEGER NOT NULL,
  data       TEXT NOT NULL
);

-- Control actions (start / shutdown / stop / reboot) and their Proxmox task
CREATE TABLE actions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  host_id     INTEGER NOT NULL,
  node        TEXT NOT NULL,
  guest_type  TEXT NOT NULL,                     -- qemu | lxc
  vmid        INTEGER NOT NULL,
  guest_name  TEXT,
  action      TEXT NOT NULL,                     -- start | shutdown | stop | reboot
  upid        TEXT,
  status      TEXT NOT NULL DEFAULT 'running',   -- running | ok | error | timeout
  exitstatus  TEXT,                              -- Proxmox task exit status (short)
  user_id     INTEGER,
  user_name   TEXT,
  started_at  INTEGER NOT NULL,                  -- ms
  finished_at INTEGER                            -- ms
);
CREATE INDEX actions_host_started ON actions (host_id, started_at);
CREATE INDEX actions_status ON actions (status);
