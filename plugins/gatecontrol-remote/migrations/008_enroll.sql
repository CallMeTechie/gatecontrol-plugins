-- gatecontrol-remote 1.8.0 — a set-up code for the Linux agent from the admin page (gc.remote version 9): the ticket of
-- GateControl's enrollment code, for whom and with which options, and — „Mit Agent verbinden“ — the device made by hand
-- that the agent takes over when it registers. The code itself is kept only while it can be redeemed (10 minutes) so
-- the page can show it again; it is cleared once redeemed, revoked or expired. No password, no key.
CREATE TABLE enrollments (
  ticket TEXT PRIMARY KEY,                   -- the ticket of gc.remote.enrollment.create
  owner_user_id INTEGER NOT NULL,            -- the person the code is for (owner of the device in Fernzugriff)
  name TEXT NOT NULL,                        -- --name of the agent
  options TEXT NOT NULL,                     -- JSON { ssh: { user, tmux, install } | null, desktop, open }
  adopt_device_id INTEGER,                   -- „Mit Agent verbinden“: the device made by hand that the agent takes over
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  code TEXT,                                 -- only while waiting
  url TEXT,                                  -- GateControl's public address for the command
  state TEXT NOT NULL DEFAULT 'waiting',     -- waiting | redeemed | registered | conflict | expired | revoked
  token_device_id TEXT,                      -- the agent's app installation once redeemed
  peer_name TEXT,
  vpn_ip TEXT,
  redeemed_at INTEGER,
  handshake_at INTEGER,
  device_id INTEGER,                         -- the device the agent registered as
  conflict TEXT,                             -- JSON { pinned, agent } — another host key than the pinned one
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_enrollments_state ON enrollments(state, created_at);
CREATE INDEX idx_enrollments_token ON enrollments(token_device_id) WHERE token_device_id IS NOT NULL;
