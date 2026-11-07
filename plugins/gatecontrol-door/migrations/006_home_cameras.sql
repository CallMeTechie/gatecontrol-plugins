-- gatecontrol-door 1.6.0 — Kameras im Heimnetz (gc.cameras, GateControl with
-- "Kameras"). The cameras, their passwords and clips belong to GateControl and
-- the gateways; here only who sees a camera (admin page "Berechtigungen",
-- column "sieht") and the push switch per camera with the time of its last
-- push (at most one every 5 minutes). camera_id is GateControl's id (c + 15 hex).
CREATE TABLE home_camera_rights (
  user_id INTEGER NOT NULL,
  camera_id TEXT NOT NULL,
  PRIMARY KEY (user_id, camera_id)
);

CREATE TABLE home_camera_prefs (
  camera_id TEXT PRIMARY KEY,
  push INTEGER NOT NULL DEFAULT 1,
  last_push_at INTEGER
);
