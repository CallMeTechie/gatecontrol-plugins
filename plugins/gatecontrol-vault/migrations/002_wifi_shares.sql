-- 1.4.0 — Wi-Fi shares: a Wi-Fi entry shown on the wall tablet (Familie plugin) or on the portal's start page for a
-- while. The one place where the server holds a secret in the clear, on purpose: the app that shares decrypts the
-- network name, the kind of security and the password and sends this copy, so the tablet and the portal can show it
-- to everyone looking at them. Only these fields, only Wi-Fi entries, only until expires_at (NULL = until ended);
-- ending, trashing, purging or moving the entry and deleting its vault delete the row (README "WLAN-Freigaben").

CREATE TABLE wifi_shares (
  id          TEXT PRIMARY KEY,      -- 24 hex characters
  item_id     TEXT NOT NULL,         -- the entry it is a copy of
  vault_id    TEXT NOT NULL,         -- its vault: who may see (members) and end (write) the share
  target      TEXT NOT NULL,         -- 'wall' | 'portal'
  ssid        TEXT NOT NULL,
  security    TEXT NOT NULL,         -- 'WPA' | 'WEP' | 'SAE' | 'nopass' (the T: of a Wi-Fi QR code)
  password    TEXT NOT NULL,         -- '' for nopass
  hidden      INTEGER NOT NULL DEFAULT 0,
  expires_at  INTEGER,               -- ms since the epoch; NULL = until someone ends it
  created_by  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_by  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (item_id, target)
);
CREATE INDEX wifi_shares_vault ON wifi_shares (vault_id);
CREATE INDEX wifi_shares_target ON wifi_shares (target, expires_at);

-- The log row of a share says for how long and where ('wall 1h', 'portal forever', 'wall ended: trash').
ALTER TABLE events ADD COLUMN detail TEXT;

-- The wall tablet's copy lives in the Familie plugin (service wall_wifi): 1 = it may be out of step (a push failed or
-- a share ended without one) — the background run sends the whole set again.
INSERT INTO meta (key, value) VALUES ('wall_dirty', 0);
INSERT INTO meta (key, value) VALUES ('wall_pushed_at', 0);
