-- Drive 1.31.0: "Für Fotorahmen freigeben" in the apps (server/frameshare.js). Each person has at most one album of
-- their own for it — in their own files, `frame = 1`, made when they first share a photo. frame_owner: that person;
-- NULL for every other album. Adding the column writes no row; every album there is stays as it was.
ALTER TABLE albums ADD COLUMN frame_owner INTEGER;
CREATE UNIQUE INDEX albums_frame_owner ON albums (frame_owner) WHERE frame_owner IS NOT NULL;
