-- gatecontrol-door 1.0.0 — Tür & Kamera
-- Times are ms since the epoch (UTC). Secrets (Nuki bridge tokens, the Nuki Web
-- token, the Ring refresh token) are never stored here: gc.settings.setSecret.

-- Nuki Bridges: one per assignment of the home target "nuki-bridge" (target_index)
CREATE TABLE bridges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  target_index INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Locks and openers. source 'bridge' (bridge_id + nuki_id + device_type) or 'web' (nuki_id = smartlockId)
CREATE TABLE locks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('bridge', 'web')),
  bridge_id INTEGER REFERENCES bridges(id) ON DELETE SET NULL,
  nuki_id TEXT NOT NULL,
  device_type INTEGER NOT NULL DEFAULT 0,
  actions TEXT NOT NULL DEFAULT '["lock","unlock"]',
  door_sensor INTEGER NOT NULL DEFAULT 0,
  open_too_long_min INTEGER NOT NULL DEFAULT 5,
  night_check TEXT DEFAULT '22:00',
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Last known state per lock (polled; survives restarts so alerts are not repeated)
CREATE TABLE lock_state (
  lock_id INTEGER PRIMARY KEY REFERENCES locks(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'unknown',
  nuki_state INTEGER,
  door TEXT,
  battery_critical INTEGER,
  battery_percent INTEGER,
  battery_charging INTEGER,
  reachable INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER,
  checked_at INTEGER,
  unreachable_since INTEGER,
  door_open_since INTEGER,
  jammed_since INTEGER
);

-- Ring cameras and doorbells (from the Ring device list), each optionally linked to a lock
CREATE TABLE cameras (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ring_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT,
  doorbell INTEGER NOT NULL DEFAULT 0,
  location_id TEXT,
  lock_id INTEGER REFERENCES locks(id) ON DELETE SET NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  battery INTEGER,
  online INTEGER,
  present INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

-- Rights: per GateControl user and lock ('view' | 'lock' | 'open'; no row = none)
CREATE TABLE rights (
  user_id INTEGER NOT NULL,
  lock_id INTEGER NOT NULL REFERENCES locks(id) ON DELETE CASCADE,
  level TEXT NOT NULL CHECK (level IN ('view', 'lock', 'open')),
  PRIMARY KEY (user_id, lock_id)
);

-- Per user: automatic unlock on arrival (opt-in) and an optional weekly time window (JSON { days: [1..7], from, to })
CREATE TABLE user_prefs (
  user_id INTEGER PRIMARY KEY,
  auto_unlock INTEGER NOT NULL DEFAULT 0,
  time_window TEXT,
  updated_at INTEGER NOT NULL
);

-- Per user and camera: doorbell / motion pushes
CREATE TABLE camera_prefs (
  user_id INTEGER NOT NULL,
  camera_id INTEGER NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  ding INTEGER NOT NULL DEFAULT 1,
  motion INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, camera_id)
);

-- Pictures (Ring snapshots) — deleted after the retention (1–30 days, default 7)
CREATE TABLE media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  camera_id INTEGER REFERENCES cameras(id) ON DELETE SET NULL,
  at INTEGER NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  data BLOB NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX media_camera ON media(camera_id, at);
CREATE INDEX media_expires ON media(expires_at);

-- History: every action (also refused ones), rings and motion, notices. Kept 90 days.
-- kind: action | ding | motion | alert | nuki
-- via:  app | portal | notification | automation | system | nuki | keypad | web
-- result: ok | refused | failed
CREATE TABLE history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  lock_id INTEGER,
  camera_id INTEGER,
  user_id INTEGER,
  user_name TEXT,
  via TEXT,
  caller TEXT,
  action TEXT,
  result TEXT,
  reason TEXT,
  media_id INTEGER,
  ext_id TEXT
);
CREATE INDEX history_at ON history(at);
CREATE INDEX history_lock ON history(lock_id, at);
CREATE INDEX history_user ON history(user_id, at);
CREATE UNIQUE INDEX history_ext ON history(ext_id) WHERE ext_id IS NOT NULL;

-- Automatic unlocks waiting for the door to open (safety net: lock again after 3 min)
CREATE TABLE auto_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lock_id INTEGER NOT NULL REFERENCES locks(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  closed_at INTEGER
);
CREATE INDEX auto_runs_pending ON auto_runs(status, at);
