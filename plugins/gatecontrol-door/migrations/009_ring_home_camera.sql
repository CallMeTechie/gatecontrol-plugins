-- gatecontrol-door 1.9.0 — a Ring doorbell / camera linked to a camera in the home
-- network (gc.cameras): the doorbell and motion pushes and GET /me name it, so the
-- TV and the apps show the live picture of the right camera at once. camera id is
-- GateControl's (c + 15 hex); NULL = none (every camera there is stays so).
ALTER TABLE cameras ADD COLUMN home_camera_id TEXT;
