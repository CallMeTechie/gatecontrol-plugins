-- gatecontrol-smarthome 1.7.0: Shelly and Tasmota devices through a GateControl gateway (the plugin's edge
-- part and the gateway's MQTT broker), and an area ("Bereich") for every resource.
--
-- edge_devices: one row per device behind a gateway (gateway_id = GateControl's gateway, gc.edge). `base` is the
-- device's MQTT topic root (shellies/<prefix> | tasmota/<prefix>); its broker account is <plugin id>-<prefix>
-- (gc.mqtt.accounts — the password is never stored here). Its channels are resources like the deCONZ ones:
-- gateway_id 0, deconz_type 'edge', deconz_id '<edge device id>/<channel>' (switch:0, light:0, cover:0, sensor),
-- edge_device_id = the device.
ALTER TABLE resources ADD COLUMN area TEXT;
ALTER TABLE resources ADD COLUMN edge_device_id INTEGER;
CREATE INDEX idx_resources_edge ON resources(edge_device_id);
CREATE TABLE edge_devices (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  gateway_id   INTEGER NOT NULL,
  base         TEXT NOT NULL,
  prefix       TEXT NOT NULL,
  family       TEXT NOT NULL,
  name         TEXT NOT NULL,
  area         TEXT,
  model        TEXT,
  firmware     TEXT,
  ip           TEXT,
  mac          TEXT,
  mqtt_user    TEXT,
  config_json  TEXT,
  state_json   TEXT,
  online       INTEGER,
  configured   INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_edge_devices_base ON edge_devices(gateway_id, base);
