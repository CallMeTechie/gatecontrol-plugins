-- Drive 1.25.0: how long a video runs (ms), from the device that sent it (uploads/commit { durationMs }) — the apps show
-- it on the tiles of the photos. NULL: not known (a picture, or sent without it). A copy or move keeps it.
ALTER TABLE nodes ADD COLUMN duration_ms INTEGER;
