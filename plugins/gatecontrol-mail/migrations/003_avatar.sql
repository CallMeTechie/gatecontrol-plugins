-- GateControl Mail 1.1.2 — the account's picture at the provider (Microsoft: Graph /me/photo), as the plugin's media:
-- avatar_media / avatar_mime (NULL: none), avatar_etag (Graph's mediaEtag: unchanged → not loaded again), avatar_at (the
-- last look; at most once a day, after a failure again within the hour).
ALTER TABLE accounts ADD COLUMN avatar_media TEXT;
ALTER TABLE accounts ADD COLUMN avatar_mime TEXT;
ALTER TABLE accounts ADD COLUMN avatar_etag TEXT;
ALTER TABLE accounts ADD COLUMN avatar_at INTEGER;
