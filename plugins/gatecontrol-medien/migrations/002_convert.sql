-- gatecontrol-medien 1.5.0 — "Videos umwandeln", step 1: the list of films and episodes that do not play everywhere.
-- Only items with something to report are kept (level convert | hint | info); a file that plays everywhere has no row.
-- Filled from Jellyfin (GET /Items in pages, then only changes); nothing here is converted yet.
CREATE TABLE conv_items (
  source_id TEXT NOT NULL,                   -- the Jellyfin source (jf-<n>)
  item_id TEXT NOT NULL,                     -- Jellyfin item ID (32 hex characters)
  kind TEXT NOT NULL,                        -- Movie | Episode
  name TEXT NOT NULL,
  series TEXT,                               -- episodes: series, season, episode number
  season INTEGER,
  episode INTEGER,
  year INTEGER,
  path TEXT,
  container TEXT,
  size INTEGER,                              -- bytes
  runtime INTEGER,                           -- seconds
  fps REAL,
  level TEXT NOT NULL,                       -- convert | hint | info
  reasons TEXT NOT NULL DEFAULT '[]',        -- JSON [{ code, level, label, devices }]
  devices TEXT NOT NULL DEFAULT '{}',        -- JSON { phone, tv, windows: yes | maybe | no }
  estimate TEXT,                             -- JSON { kind: encode | remux, size, minutes } (estimated) or NULL
  video TEXT,                                -- one line about the video stream
  stalled_at INTEGER,                        -- Jellyfin converted it live slower than real time (GET /Sessions)
  stalled_reasons TEXT,                      -- JSON TranscodeReasons of that playback
  scan INTEGER NOT NULL,                     -- the scan that saw it last (a full scan drops rows it did not see)
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (source_id, item_id)
);
CREATE INDEX conv_items_item ON conv_items (item_id);
