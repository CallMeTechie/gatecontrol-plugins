-- gatecontrol-remote 1.0.0 — Fernzugriff
-- Times are ms since the epoch (UTC). Secrets never live here: passwords and keys are in GateControl's
-- vault (gc.remote.vault), a device only keeps the handle.

-- Devices (the targets of the former Remote Desktops). Ids of taken-over targets stay the ids of
-- GateControl's rdp_routes; devices made in the plugin start at 100000 so they never meet one of them.
CREATE TABLE devices (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL DEFAULT 'rdp',      -- rdp | vnc | ssh | telnet
  enabled INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'plugin',     -- import (from GateControl) | plugin
  config TEXT NOT NULL DEFAULT '{}',         -- every setting of the target (the fields of rdp_routes, JSON)
  credential TEXT,                           -- vault handle: username, password, domain, SSH key, passphrase
  sftp_credential TEXT,                      -- vault handle of the SFTP account (kept, not used in version 1)
  credential_unreadable INTEGER NOT NULL DEFAULT 0,
  listener TEXT,                             -- key of the gc.remote listener (access over a home gateway)
  listener_error TEXT,
  online INTEGER,                            -- last check (null = never checked)
  response_time INTEGER,
  last_check INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Who may reach a device: people, groups and (old apps only) API tokens. No row = everybody with the right.
CREATE TABLE device_access (
  device_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                        -- user | group | token
  principal_id INTEGER NOT NULL,
  PRIMARY KEY (device_id, kind, principal_id)
);
CREATE INDEX idx_access_principal ON device_access(kind, principal_id);

-- Rights per person or group; NULL = not set here (a group or the default decides)
CREATE TABLE rights (
  kind TEXT NOT NULL,                        -- user | group
  principal_id INTEGER NOT NULL,
  rdp INTEGER,                               -- Remote Desktops nutzen (RDP, VNC)
  ssh INTEGER,                               -- SSH nutzen (SSH, Telnet)
  support INTEGER,                           -- Support-Codes einlösen (later stages)
  share INTEGER,                             -- Eigene Geräte freigeben (later stages)
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (kind, principal_id)
);

-- The history: taken-over sessions keep the id of rdp_sessions, new ones start at 1000000000
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  device_id INTEGER NOT NULL,
  device_name TEXT,
  user_id INTEGER,
  token_id INTEGER,
  token_name TEXT,
  peer_id INTEGER,
  status TEXT NOT NULL,                      -- active | ended
  protocol TEXT NOT NULL DEFAULT 'rdp',
  mode TEXT,                                 -- control | view (browser sessions)
  via TEXT NOT NULL DEFAULT 'native',        -- native (an app) | browser
  started_at INTEGER NOT NULL,
  last_heartbeat INTEGER,
  ended_at INTEGER,
  duration_seconds INTEGER,
  end_reason TEXT,
  client_ip TEXT,
  host_session_id INTEGER,                   -- GateControl's remote_sessions.id of a browser session
  imported INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_sessions_started ON sessions(started_at);
CREATE INDEX idx_sessions_device ON sessions(device_id, started_at);
CREATE INDEX idx_sessions_active ON sessions(status, device_id);
CREATE UNIQUE INDEX idx_sessions_host ON sessions(host_session_id) WHERE host_session_id IS NOT NULL;
