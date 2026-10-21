-- gatecontrol-door 1.5.0: who sees a camera that is not linked to a lock (a
-- camera at the letterbox, in the garden). A linked camera follows its lock's
-- rights as before (view or more); for an unlinked one this list decides who
-- sees it, gets its doorbell / motion pushes and finds its events in the history.
CREATE TABLE camera_rights (
  user_id INTEGER NOT NULL,
  camera_id INTEGER NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, camera_id)
);
