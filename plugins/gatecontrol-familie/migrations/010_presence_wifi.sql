-- gatecontrol-familie 1.17.0: presence over the home network as a second source next to the app (GateControl ≥ 1.230.0,
-- gc.homeNetwork.presence — server/homewifi.js). The gateway sees a person's phone in the Wi-Fi; GateControl tells only
-- „at home“ / „away“ of people who agreed themselves (never MAC or IP addresses, never which device).
--
-- presence_wifi: what GateControl last said per member (a mirror, kept by the hook and the background run).
CREATE TABLE presence_wifi (
  user_id     INTEGER PRIMARY KEY,
  consent     INTEGER NOT NULL DEFAULT 0,     -- the person's own consent „Über mein Handy im WLAN“ in GateControl
  home        INTEGER,                        -- 1 at home, 0 away, NULL not known (no counting device reported)
  since       INTEGER,                        -- ms: the change as the gateway saw it
  updated_at  INTEGER NOT NULL
);

-- presence_now: the person's state from every switched-on source — at home as soon as one says so, away once none
-- says „at home“ any more. since / source: the change and the source that made it (app | wifi).
CREATE TABLE presence_now (
  user_id     INTEGER PRIMARY KEY,
  home        INTEGER NOT NULL,
  since       INTEGER NOT NULL,
  source      TEXT NOT NULL
);

-- until now the app was the only source
INSERT INTO presence_now (user_id, home, since, source)
  SELECT s.user_id, s.home, s.since, 'app' FROM presence_state s JOIN presence_consent c ON c.user_id = s.user_id AND c.share = 1;
