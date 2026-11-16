-- gatecontrol-remote 1.3.0 — the phone shares its screen (stage 5, GateControl's relay gc-screen.v1, gc.remote version 4):
-- a request knows whether it is for Remote Desktop (a PC) or for the screen of a phone, the ticket of GateControl's
-- viewer (its ref, bound to the helper's browser or app on first use) and how it ended. No picture, no code is stored.
ALTER TABLE requests ADD COLUMN kind TEXT NOT NULL DEFAULT 'rdp';   -- rdp | screen
ALTER TABLE requests ADD COLUMN screen_ref TEXT;                    -- the viewer's ref of gc.remote.screen (screen only)
ALTER TABLE requests ADD COLUMN screen_started_at INTEGER;          -- both sides of the relay met
ALTER TABLE requests ADD COLUMN end_reason TEXT;                    -- sender | viewer | consent_denied | sender_lost | …
CREATE INDEX idx_requests_screen_ref ON requests(screen_ref);
