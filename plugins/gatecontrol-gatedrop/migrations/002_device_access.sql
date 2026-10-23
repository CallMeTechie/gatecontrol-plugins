-- gatecontrol-gatedrop 1.2.0: who may send to an app installation (set on that device, GET/PUT device).
--   self      only its owner (the default — also without a row)
--   everyone  every account of this GateControl (not kiosk devices): the device is listed in their GET targets
--             under `peopleDevices` and takes their sends (directly in the same Wi-Fi or through the server)

CREATE TABLE device_access (
  device_id  TEXT PRIMARY KEY,           -- GateControl's device id (the app's token id)
  user_id    INTEGER NOT NULL,           -- its owner when set
  mode       TEXT NOT NULL DEFAULT 'self',
  at         INTEGER NOT NULL
);
CREATE INDEX device_access_open ON device_access (mode, user_id);
