-- gatecontrol-skoda 1.6.0: the way of a trip on the map. Škoda reports only
-- where a vehicle parks, so the plugin asks OpenStreetMap's routing service
-- (routing.openstreetmap.de) once for the road between start and end:
-- route = JSON [[lat, lon], …] (simplified), route_kind 'road' (the computed
-- road) or 'line' (only the straight line: a detour or stops on the way, no
-- road found), route_km the length of the computed road; route_tries counts
-- failed attempts (network), route_at the last attempt.
ALTER TABLE trips ADD COLUMN route TEXT;
ALTER TABLE trips ADD COLUMN route_kind TEXT;
ALTER TABLE trips ADD COLUMN route_km REAL;
ALTER TABLE trips ADD COLUMN route_tries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trips ADD COLUMN route_at TEXT;
