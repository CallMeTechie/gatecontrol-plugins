-- gatecontrol-door 1.7.0 — Kameras im Heimnetz: each person may switch the push
-- "Personen an der Kamera" off for a camera they see (portal tab "Tür", apps).
-- No row = push on (the default); push 0 = this person gets no push of this
-- camera. camera_id is GateControl's id (c + 15 hex); rows go with the camera.
CREATE TABLE home_camera_user_prefs (
  user_id INTEGER NOT NULL,
  camera_id TEXT NOT NULL,
  push INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, camera_id)
);
