-- Drive 1.20.0: the home cache of the gateways (server/homecache.js, GateControl ≥ 1.231.0 gc.homeCache) and
-- "offline verfügbar".

-- "Offline verfügbar": a person keeps a file or a folder (everything below it) on their devices — PUT|DELETE
-- nodes/<id>/offline, GET offline. At most 500 a person. Rows go with the node (purge).
CREATE TABLE offline_pins (
  user_id INTEGER NOT NULL,
  node_id INTEGER NOT NULL,
  at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, node_id)
);
CREATE INDEX offline_pins_node ON offline_pins (node_id);

-- Files of a vault a person fetched (GET nodes/<id>/content, not a PC's sync) — recent_opens leaves them out. At most
-- 200 a person, 30 days. Rows go with the node (purge).
CREATE TABLE cache_uses (
  user_id INTEGER NOT NULL,
  node_id INTEGER NOT NULL,
  at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, node_id)
);
CREATE INDEX cache_uses_at ON cache_uses (at);

-- What Drive offered GateControl's home cache (gc.homeCache.offer), one row per content: key = its sha256 (else
-- 'm:<media id>'), media_id the file GateControl takes it from, users the people who may see it (JSON, sorted),
-- offered 0 = GateControl has the same content from elsewhere (offer answered offered: false).
CREATE TABLE home_cache (
  key      TEXT PRIMARY KEY,
  media_id TEXT NOT NULL,
  sha256   TEXT,
  size     INTEGER NOT NULL DEFAULT 0,
  kind     TEXT NOT NULL,
  priority INTEGER NOT NULL,
  users    TEXT NOT NULL,
  offered  INTEGER NOT NULL DEFAULT 1,
  at       INTEGER NOT NULL
);
CREATE INDEX home_cache_media ON home_cache (media_id);
CREATE INDEX home_cache_sha ON home_cache (sha256);
