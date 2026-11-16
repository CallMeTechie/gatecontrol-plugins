-- gatecontrol-remote 1.2.0 — SSH in the terminal of GateControl with tmux, recordings (stage 3; gc.remote version 3).
-- SSH devices that exist already stay on Guacamole until an administrator switches them over (per device or all at
-- once); new SSH devices get the terminal (devices.js DEFAULTS.ssh_engine).
UPDATE devices SET config = json_set(config, '$.ssh_engine', 'guac') WHERE protocol = 'ssh' AND json_extract(config, '$.ssh_engine') IS NULL;

-- Recording per person or group: off | optional | always; NULL = not set here (a group or the device decides)
ALTER TABLE rights ADD COLUMN recording TEXT;

-- The history: which engine of GateControl ran a session (guac | term) and its recording
ALTER TABLE sessions ADD COLUMN engine TEXT;
ALTER TABLE sessions ADD COLUMN recording_id TEXT;
CREATE INDEX idx_sessions_recording ON sessions(recording_id) WHERE recording_id IS NOT NULL;
