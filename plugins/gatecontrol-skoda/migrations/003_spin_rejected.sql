-- gatecontrol-skoda 1.3.3: when Škoda refused a lock/unlock with the stored
-- S-PIN (HTTP 4xx, not 401/429), the time of that refusal. While set, no
-- S-PIN command is sent (Škoda locks the S-PIN for 24 hours after a few wrong
-- tries); saving a new S-PIN clears it. The S-PIN itself stays a secret
-- setting and is never stored here.
ALTER TABLE accounts ADD COLUMN spin_rejected_at TEXT;
