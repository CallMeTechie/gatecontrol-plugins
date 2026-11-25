-- gatecontrol-medien 1.0.0 — Medien
-- Times are ms since the epoch (UTC). Secrets never live here: the Jellyfin API key and the NAS passwords are
-- secrets of the plugin (gc.settings.setSecret 'jf.<id>.key' / 'share.<id>.pw', encrypted with the server key).

-- Media sources: a Jellyfin server or a NAS share (an SMB / WebDAV pair or one of them).
CREATE TABLE sources (
  id TEXT PRIMARY KEY,                       -- jf-<n> | sh-<n> (the same id on every device of every person)
  kind TEXT NOT NULL,                        -- jellyfin | share
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  config TEXT NOT NULL DEFAULT '{}',         -- addresses, targets, away, flags (JSON, no secrets)
  status TEXT NOT NULL DEFAULT '{}',         -- the last check (JSON: version, serverId, quickConnect, libraries, problem)
  secret_rev INTEGER NOT NULL DEFAULT 0,     -- shares: raised with every new password
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Who sees a source. No row for a source = everybody with the right "Medien" (children: shares only with the setting).
-- A person's own row decides, else any of their groups.
CREATE TABLE source_access (
  source_id TEXT NOT NULL,
  kind TEXT NOT NULL,                        -- user | group
  principal_id INTEGER NOT NULL,
  allow INTEGER NOT NULL,                    -- 1 | 0
  PRIMARY KEY (source_id, kind, principal_id)
);

-- The right "Medien" (the media area in the apps) for a person or a group; NULL = not set here.
CREATE TABLE rights (
  kind TEXT NOT NULL,                        -- user | group
  principal_id INTEGER NOT NULL,
  media INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (kind, principal_id)
);

-- Person ↔ Jellyfin user per Jellyfin source.
CREATE TABLE mappings (
  source_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  jf_user_id TEXT,                           -- NULL with how = 'none' (deliberately without)
  jf_user_name TEXT,
  how TEXT NOT NULL,                         -- auto | manual | created | none
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (source_id, user_id)
);

-- A device's Jellyfin sign-in (Quick Connect confirmed by the plugin). The device's Jellyfin token never comes here.
CREATE TABLE pairings (
  device_id TEXT NOT NULL,                   -- GateControl device (the app token's id)
  source_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  jf_device_id TEXT NOT NULL,                -- gc-<20>
  jf_user_id TEXT NOT NULL,
  jf_user_name TEXT,
  state TEXT NOT NULL,                       -- authorized | paired
  device_name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, source_id)
);

-- NAS passwords handed out (which device got which revision; the password itself is never stored here).
CREATE TABLE deliveries (
  device_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  secret_rev INTEGER NOT NULL,
  device_name TEXT,
  at INTEGER NOT NULL,
  smb_ok INTEGER,                            -- the device's report after its first SMB sign-in (NULL = none)
  smb_problem TEXT,
  smb_at INTEGER,
  PRIMARY KEY (device_id, source_id)
);

-- What the devices report about their way to a source (home / away), for the devices tab.
CREATE TABLE reports (
  device_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  way TEXT NOT NULL,                         -- home | away
  ok INTEGER NOT NULL,
  problem TEXT,
  at INTEGER NOT NULL,
  PRIMARY KEY (device_id, source_id, way)
);

-- The devices of the last reconcile (to notice a removed one; name and owner for the log).
CREATE TABLE known_devices (
  device_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  name TEXT,
  platform TEXT,
  client_type TEXT,
  last_seen TEXT,
  last_contact INTEGER,                      -- the device's last request to this plugin
  removed_at INTEGER
);

-- Rate limits (pairing per device and hour, cast messages per device).
CREATE TABLE hits (
  bucket TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX hits_bucket ON hits (bucket, at);

-- The plugin's log (tab "Protokoll" of the overview): never passwords, keys, codes or Jellyfin tokens.
CREATE TABLE log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  user_id INTEGER,
  device_id TEXT,
  source_id TEXT
);
CREATE INDEX log_at ON log (at);
