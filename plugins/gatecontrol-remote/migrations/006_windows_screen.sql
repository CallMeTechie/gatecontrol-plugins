-- gatecontrol-remote 1.5.0 — a Windows PC shares its screen (stage 7, GateControl's relay gc-screen.v1): the app of a PC has two
-- switches now, "Remote Desktop erlauben" and "Bildschirm teilen" (also on Windows Home, where only the second exists).
-- Nothing of a picture or an input is stored.
ALTER TABLE devices ADD COLUMN screen_view INTEGER;   -- 1 = "Bildschirm teilen" is on at this PC (a phone: always, NULL)
ALTER TABLE devices ADD COLUMN rdp_offered INTEGER;   -- 0 = "Remote Desktop erlauben" is off at this PC (NULL: on, apps before 1.5)
