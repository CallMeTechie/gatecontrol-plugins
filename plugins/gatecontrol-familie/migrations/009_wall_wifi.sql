-- gatecontrol-familie 1.14.0: Wi-Fi shared by the Vault plugin for the wall tablet („Freigabe auf Wandtablet“,
-- service wall_wifi — server/wifi.js). Vault sends the whole set on every change; this table holds it. The password
-- is in the clear on purpose (the wall shows it to everyone in front of it); an expired row is never shown and goes
-- with the next purge.
CREATE TABLE wall_wifi (
  id          TEXT PRIMARY KEY,               -- the share's id in Vault (24 hex characters)
  ssid        TEXT NOT NULL,
  security    TEXT NOT NULL,                  -- WPA | WEP | SAE | nopass
  password    TEXT NOT NULL,                  -- '' for nopass
  hidden      INTEGER NOT NULL DEFAULT 0,
  expires_at  INTEGER,                        -- ms; NULL = until it is ended in Vault
  shared_by   TEXT,                           -- the name of the person who shared it
  updated_at  INTEGER NOT NULL
);
