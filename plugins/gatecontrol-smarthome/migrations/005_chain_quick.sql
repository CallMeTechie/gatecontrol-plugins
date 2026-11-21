-- gatecontrol-smarthome 1.12.0: logic chains, stage 2. A chain may run on the server (source 'server', gateway_id 0:
-- devices of several gateways or of deCONZ together with others). A chain with the trigger "Von Hand (App)" is a
-- quick action of the apps: administrators may always run it, a portal viewer only when an administrator released it
-- for that person — quick_users: JSON array of user ids (NULL / [] = administrators only).
ALTER TABLE rules ADD COLUMN quick_users TEXT;
