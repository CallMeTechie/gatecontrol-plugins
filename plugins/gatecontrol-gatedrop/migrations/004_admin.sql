-- GateDrop 1.5.0: the administrators' overview of the sends (admin/sends), the retention set by an administrator
-- (settings), real pick-up confirmations and "removed by an administrator". Additive only — older apps read every
-- status they knew before (a removed send's open deliveries become 'expired' with error 'removed').

-- Settings of the administrator: 'retention.after' (days after the pick-up: 0 = at once, 1, 3, 7) and
-- 'retention.unpicked' (days for what nobody picked up: 3, 7, 14, 30). No row: the default 7 / 7 (as before 1.5.0).
CREATE TABLE settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL,
  at     INTEGER NOT NULL
);

-- deliveries.picked_at: the recipient confirmed it has the send — the target device's POST sends/<id>/opened, the
-- receiving device's POST transfers/<id>/result { ok: true } with every byte, the person's POST sends/<id>/opened (a
-- 'family' delivery: every member at sending, see pickups), a NAS / Drive save or a Messenger message that carries
-- everything. NULL: provided, not (yet) picked up — 'delivered' alone is no pick-up any more.
ALTER TABLE deliveries ADD COLUMN picked_at INTEGER;

-- Who of a person / 'family' delivery opened it (one row per person).
CREATE TABLE pickups (
  delivery_id  INTEGER NOT NULL,
  user_id      INTEGER NOT NULL,
  at           INTEGER NOT NULL,
  PRIMARY KEY (delivery_id, user_id)
);

-- sends.picked_at: every recipient that needs the server copy has picked it up (the latest pick-up); NULL otherwise.
-- sends.removed_at: an administrator removed its files from the server (admin/cleanup, DELETE admin/sends/<id>).
ALTER TABLE sends ADD COLUMN picked_at INTEGER;
ALTER TABLE sends ADD COLUMN removed_at INTEGER;
CREATE INDEX sends_created ON sends (created_at);

-- App installations that use GateDrop (any request of the app API with that device): GET targets offers only these as
-- own devices — an app without GateDrop never fetches what is sent to it.
CREATE TABLE devices_seen (
  device_id  TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  at         INTEGER NOT NULL
);

-- What is known already: a device that reported its presence, sent, received (opened, a direct transfer it reported)
-- or set who may send to it.
INSERT OR IGNORE INTO devices_seen (device_id, user_id, at) SELECT device_id, user_id, at FROM presence;
INSERT OR IGNORE INTO devices_seen (device_id, user_id, at) SELECT device_id, user_id, at FROM device_access;
INSERT OR IGNORE INTO devices_seen (device_id, user_id, at)
  SELECT device_id, user_id, MAX(created_at) FROM sends WHERE device_id IS NOT NULL GROUP BY device_id;
INSERT OR IGNORE INTO devices_seen (device_id, user_id, at)
  SELECT target, user_id, MAX(at) FROM deliveries WHERE kind = 'device' AND status = 'opened' AND user_id IS NOT NULL GROUP BY target;
INSERT OR IGNORE INTO devices_seen (device_id, user_id, at)
  SELECT t.to_device, d.user_id, MAX(t.created_at) FROM transfers t JOIN deliveries d ON d.id = t.delivery_id
  WHERE t.receiver_result IS NOT NULL AND d.user_id IS NOT NULL GROUP BY t.to_device;

-- The pick-ups so far.
UPDATE deliveries SET picked_at = COALESCE(opened_at, at) WHERE status = 'opened' AND kind IN ('device', 'person');
INSERT OR IGNORE INTO pickups (delivery_id, user_id, at)
  SELECT id, user_id, COALESCE(opened_at, at) FROM deliveries WHERE kind = 'person' AND status = 'opened' AND user_id IS NOT NULL;
UPDATE deliveries SET picked_at = at WHERE status = 'delivered' AND kind IN ('nas', 'drive');
UPDATE deliveries SET picked_at = at WHERE status = 'delivered' AND kind = 'person' AND ref LIKE 'chat:%' AND gd_items = 0;
UPDATE deliveries SET picked_at = at WHERE status = 'delivered' AND kind = 'device' AND via = 'direct'
  AND EXISTS (SELECT 1 FROM transfers t WHERE t.delivery_id = deliveries.id AND t.receiver_result LIKE '{"ok":true%');
UPDATE sends SET picked_at = (SELECT MAX(d.picked_at) FROM deliveries d WHERE d.send_id = sends.id AND d.kind != 'link')
  WHERE purged = 0
    AND EXISTS (SELECT 1 FROM deliveries d WHERE d.send_id = sends.id AND d.kind != 'link' AND d.picked_at IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.send_id = sends.id AND d.kind != 'link' AND d.picked_at IS NULL
                    AND d.status NOT IN ('failed', 'expired'));
