-- gatecontrol-skoda 1.0.1: the vehicle render as a BLOB (host parameter
-- { b64 }, no 1 MB limit of a string parameter). image_b64 stays for the
-- rows written by 1.0.0 and is read as a fallback; every new write goes to
-- image and clears image_b64.
ALTER TABLE vehicles ADD COLUMN image BLOB;
