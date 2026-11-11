-- gatecontrol-smarthome 1.10.0: logic chains for Shelly and Tasmota devices. They do not run on a deCONZ gateway but
-- in the plugin's edge part on the GateControl gateway of the devices (edge/rules.js): `source` 'edge' with
-- gateway_id = GateControl's gateway (as edge_devices.gateway_id); the deconz_* ids stay NULL. The rules so far are
-- 'deconz' (gateway_id = gateways.id). last_fired_at: when the edge part last ran the chain.
ALTER TABLE rules ADD COLUMN source TEXT NOT NULL DEFAULT 'deconz';
ALTER TABLE rules ADD COLUMN last_fired_at TEXT;
