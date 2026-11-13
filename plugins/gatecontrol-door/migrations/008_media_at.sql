-- gatecontrol-door 1.7.2: the hourly clean-up of the pictures read every picture.
-- media keeps the picture itself (data, 100–300 kB on overflow pages) in the row
-- and expires_at behind it: a statement that takes expires_at from the row walks
-- through the whole picture first. "DELETE … WHERE expires_at <= ? OR at < ?" had
-- no index for at, went through the table and so read all pictures every hour.
-- With this index both halves are found in an index (expires_at: media_expires
-- of 001), and server/history.js asks for expired pictures by media_expires only.
-- at stands in front of the picture in the row: building the index reads the
-- leaves of the table, never a picture (3000 pictures, 600 MB: 8 MB read).
CREATE INDEX media_at ON media(at);
