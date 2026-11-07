-- Drive 1.24.0: GateControl's previews in the home cache (server/homecache.js, GateControl ≥ 1.249.0
-- gc.homeCache.offer({ preview })). A row of home_cache is then the small or large preview of a content (key
-- 'ps:<key of the content>' / 'pl:…', sha256 the preview's own) — preview NULL: the file itself, as before.
ALTER TABLE home_cache ADD COLUMN preview TEXT;
