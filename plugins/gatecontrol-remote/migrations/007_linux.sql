-- gatecontrol-remote 1.6.0 — Linux devices (stage 4, the agent gatecontrol-agent): SSH in GateControl's terminal with
-- the key GateControl made for the device (vault handle in `credential`), the host key the agent reported (pinned in
-- GateControl, kept here to see a change), tmux, the desktop server it found. Nothing secret is stored here.
ALTER TABLE devices ADD COLUMN ssh_offered INTEGER;       -- 1 = SSH shared by the agent
ALTER TABLE devices ADD COLUMN ssh_user TEXT;             -- the shared account
ALTER TABLE devices ADD COLUMN tmux_version TEXT;         -- NULL: no tmux on the device
ALTER TABLE devices ADD COLUMN host_key_alg TEXT;
ALTER TABLE devices ADD COLUMN host_key_sha256 TEXT;
ALTER TABLE devices ADD COLUMN desktop_kind TEXT;         -- krdp | gnome-remote-desktop | wayvnc | xrdp | x11vnc
ALTER TABLE devices ADD COLUMN desktop_protocol TEXT;     -- rdp | vnc (NULL: no desktop shared)
ALTER TABLE devices ADD COLUMN desktop_port INTEGER;
ALTER TABLE devices ADD COLUMN desktop_ready INTEGER;     -- 1 = the desktop server listens
ALTER TABLE devices ADD COLUMN os_id TEXT;                -- debian | ubuntu | raspbian | cachyos | arch | …
