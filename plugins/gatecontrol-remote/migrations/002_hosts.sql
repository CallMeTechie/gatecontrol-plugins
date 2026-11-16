-- gatecontrol-remote 1.1.0 — the Windows switch (stage 2): a PC registers itself from the GateControl app
-- ("Remote Desktop erlauben"), codes, requests that the person at the PC confirms, the firewall per session and
-- the protocol of the sharing. Codes are stored as an HMAC only, never the digits.

-- kind: target (a device of the admin page, 1.0) | host (a PC the app registered: owner, the app's device, its state)
ALTER TABLE devices ADD COLUMN kind TEXT NOT NULL DEFAULT 'target';
ALTER TABLE devices ADD COLUMN owner_user_id INTEGER;
ALTER TABLE devices ADD COLUMN token_device_id TEXT;            -- the app installation (gc.devices id = token id)
ALTER TABLE devices ADD COLUMN platform TEXT;                   -- windows
ALTER TABLE devices ADD COLUMN edition TEXT;                    -- pro | enterprise | education | home
ALTER TABLE devices ADD COLUMN rdp_available INTEGER;           -- the edition can offer Remote Desktop
ALTER TABLE devices ADD COLUMN rdp_enabled INTEGER;             -- Remote Desktop is on in Windows (fDenyTSConnections = 0)
ALTER TABLE devices ADD COLUMN share_mode TEXT NOT NULL DEFAULT 'code';  -- code | open ("Ohne Code für Berechtigte")
ALTER TABLE devices ADD COLUMN allow_open INTEGER NOT NULL DEFAULT 1;    -- the administrator allows "ohne Code" for this PC
ALTER TABLE devices ADD COLUMN registered INTEGER NOT NULL DEFAULT 0;    -- the switch in the app is on (0 = abgemeldet)
ALTER TABLE devices ADD COLUMN last_seen INTEGER;               -- the app's last heartbeat (host/state)
ALTER TABLE devices ADD COLUMN os_user TEXT;                    -- who is signed in at the PC
ALTER TABLE devices ADD COLUMN app_version TEXT;
CREATE UNIQUE INDEX idx_devices_token_device ON devices(token_device_id) WHERE token_device_id IS NOT NULL;
CREATE INDEX idx_devices_owner ON devices(owner_user_id);

-- The code a PC shows: one at a time per device, at most 10 minutes, used once
CREATE TABLE codes (
  device_id INTEGER PRIMARY KEY,
  hmac TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  failures INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_codes_hmac ON codes(hmac);

-- Every attempt to redeem a code (the limits per person and for the server)
CREATE TABLE code_attempts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  device_id INTEGER,
  ok INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX idx_code_attempts_user ON code_attempts(user_id, at);
CREATE INDEX idx_code_attempts_at ON code_attempts(at);

-- A helper's request after a code: the person at the PC allows or denies it (30 s)
CREATE TABLE requests (
  id TEXT PRIMARY KEY,                       -- rq_<random>
  device_id INTEGER NOT NULL,
  helper_user_id INTEGER NOT NULL,
  mode TEXT NOT NULL DEFAULT 'control',      -- control | view
  via TEXT NOT NULL DEFAULT 'browser',       -- browser | app
  helper_device_id TEXT,                     -- the helper's app (via app)
  state TEXT NOT NULL DEFAULT 'waiting',     -- waiting | allowed | denied | expired | ended
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  decided_at INTEGER,
  connected_at INTEGER
);
CREATE INDEX idx_requests_device ON requests(device_id, state);

-- The firewall of a PC per session: 3389 only for exactly one counterpart
CREATE TABLE firewall (
  session_key TEXT PRIMARY KEY,              -- fw_<random>, the rule "GateControl RDP <sessionKey>" on the PC
  device_id INTEGER NOT NULL,
  request_id TEXT,
  helper_user_id INTEGER,
  helper_token_id INTEGER,                   -- the helper's app (an app session)
  via TEXT NOT NULL,                         -- browser | app
  allow_ip TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 3389,
  state TEXT NOT NULL DEFAULT 'pending',     -- pending | open | failed | closing | closed
  reason TEXT,
  ref TEXT,                                  -- the ticket of GateControl's session page (browser)
  started INTEGER NOT NULL DEFAULT 0,        -- the session page opened its tunnel
  until INTEGER NOT NULL,
  opened_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  closed_at INTEGER
);
CREATE INDEX idx_firewall_device ON firewall(device_id, state);
CREATE INDEX idx_firewall_ref ON firewall(ref);

-- The protocol of the sharing (admin page Sitzungen, filter "Freigaben"; the person's own in the profile)
CREATE TABLE share_log (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  type TEXT NOT NULL,                        -- remote_code_redeemed | remote_code_failed | remote_share_changed | remote_request_allowed | …
  device_id INTEGER,
  device_name TEXT,
  owner_user_id INTEGER,
  user_id INTEGER,                           -- who did it (the helper, or the person at the PC)
  details TEXT                               -- JSON, no code, no address of a person
);
CREATE INDEX idx_share_log_at ON share_log(at);
CREATE INDEX idx_share_log_owner ON share_log(owner_user_id, at);
