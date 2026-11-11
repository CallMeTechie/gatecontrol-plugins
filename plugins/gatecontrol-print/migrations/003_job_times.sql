-- gatecontrol-print 1.1.1 — the times of a job for the apps (GET jobs/<id>)

-- until when GateControl keeps trying (24 hours after the order) and when the job ended; null: not known
-- (a job from before 1.1.1 that was already over)
ALTER TABLE jobs ADD COLUMN expires_at INTEGER;
ALTER TABLE jobs ADD COLUMN done_at INTEGER;
