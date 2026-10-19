-- Raumklima: devices of more than one maker. vendor 'midea' (all devices so
-- far) or 'dreo'; kind 'ac' (air conditioner) or 'heater'. A Dreo device is a
-- cloud device (transport 'cloud', cloud_appliance_id = its serial number);
-- the Dreo account (e-mail, region; the password's MD5 and the access token
-- as secret settings) is kept like the Midea account.
ALTER TABLE devices ADD COLUMN vendor TEXT NOT NULL DEFAULT 'midea';
ALTER TABLE devices ADD COLUMN kind TEXT NOT NULL DEFAULT 'ac';
